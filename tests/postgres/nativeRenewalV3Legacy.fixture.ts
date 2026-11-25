import { expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import { fixture, openCase, schedule } from "../helpers/fulfillmentNative.js";
import type { AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { bindSubscriptionJob } from "./subscriptionJob.fixture.js";
import { AT, call, later, recordRenewalMethod, renewal, seedRenewal, type RenewalSeed } from "./subscriptionNativeFixture.js";

export async function observeRenewalWrites({ owner, runtime }: AccountMutationsStore, relations: string[]) {
  const writes: string[] = [], seen = new WeakSet<PoolClient>();
  const listen = (client: PoolClient) => {
    if (seen.has(client)) return;
    seen.add(client);
    client.on("notice", notice => {
      if (notice.message?.startsWith("RN1 write: ")) writes.push(notice.message);
    });
  };
  owner.on("acquire", listen);
  runtime.on("acquire", listen);
  await owner.query(`CREATE FUNCTION public.fixture_rn1_write_probe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE WARNING 'RN1 write: % %', TG_TABLE_NAME, TG_OP; RETURN NULL; END $$`);
  for (const relation of relations) {
    await owner.query(`CREATE TRIGGER fixture_rn1_write_probe BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public.${relation} FOR EACH STATEMENT EXECUTE FUNCTION public.fixture_rn1_write_probe()`);
  }
  // A zero-row DELETE proves the probe sees even a write that leaves the table empty.
  for (const relation of relations) await owner.query(`DELETE FROM public.${relation} WHERE false`);
  expect(writes.splice(0)).toEqual(relations.map(relation => `RN1 write: ${relation} DELETE`));
  return writes;
}

async function renewalEffects(db: Pool, f: RenewalSeed) {
  const { rows } = await db.query(`SELECT o.state, o.claim_generation, o.terminal_outcome, o.terminal_reason,
    o.operation_fingerprint=$2 AND o.cycle_snapshot=$4::jsonb AS frozen,
    c.status AS cycle, ord.status AS order, ord.total_amount_minor, ord.money_version,
    i.status AS settlement, r.status AS reservation, r.terminal_reason AS reservation_reason,
    w.state AS stock_wait, w.last_selected_at, w.stock_secured_at, retry.state AS retry, retry.retry_attempt,
    (SELECT array_agg(kind ORDER BY kind) FROM public.subscription_retry_receipts WHERE obligation_id=retry.id) AS retry_receipts,
    (SELECT array_agg(outcome ORDER BY outcome) FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=o.id) AS outcomes
    FROM public.subscription_renewal_operations o
    LEFT JOIN public.subscription_cycles c ON c.renewal_operation_id=o.id
    LEFT JOIN public.commerce_orders ord ON ord.renewal_operation_id=o.id
    LEFT JOIN public.commerce_settlement_intents i ON i.renewal_operation_id=o.id
    LEFT JOIN public.fulfillment_inventory_reservations r ON r.renewal_operation_id=o.id
    LEFT JOIN public.subscription_stock_wait_cases w ON w.renewal_operation_id=o.id
    LEFT JOIN public.subscription_retry_obligations retry ON retry.renewal_operation_id=o.id
    WHERE o.subscription_id=$1 AND o.scheduled_at=$3`, [f.subscription, f.fingerprint, AT, f.snapshot]);
  expect(rows).toHaveLength(1);
  return { ...rows[0], schedule: await schedule(db, f.subscription) };
}

export async function exerciseLegacyRenewals({ owner, runtime }: AccountMutationsStore) {
  const expiring = await renewal(owner);
  expect(await call(owner, "fulfillment_reserve_subscription_renewal", [expiring.operation, expiring.token, 900, AT]))
    .toMatchObject({ reserved: true, replayed: false });
  await owner.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [expiring.subscription, later(48)]);

  const due = await seedRenewal(owner);
  await recordRenewalMethod(owner, due, "frozen-method");
  expect(await call(runtime, "subscription_read_renewal", [due.identity])).toBeNull();
  const dueJob = bindSubscriptionJob(runtime, due);
  const mounted = async ({ binding }: typeof dueJob) => {
    const [job] = binding.contributions[0]!.schedules;
    expect(job?.id).toBe("subscriptions-renewal");
    const result = await job!.run() as Awaited<ReturnType<typeof binding.services.run>>;
    if (!result || !("retries" in result)) throw new Error("Mounted renewal job did not run");
    return { retries: result.retries.map(({ status }) => ({ status })),
      renewals: result.renewals.map(({ status, reason, replayed }) => ({ status, reason, replayed })) };
  };
  dueJob.decline();
  const dueRun = await mounted(dueJob);
  expect(dueRun).toMatchObject({ retries: [], renewals: [{ status: "refused", reason: "declined" }] });
  const declined = await renewalEffects(owner, due);
  expect(declined).toMatchObject({ frozen: true, retry: "waiting", retry_attempt: 1 });
  const expired = await renewalEffects(owner, expiring);
  expect(expired).toMatchObject({ reservation: "expired", reservation_reason: "reservation_expired" });
  dueJob.succeed();
  dueJob.time(later(26));
  const retryRun = await mounted(dueJob);
  expect(retryRun).toMatchObject({ retries: [{ status: "succeeded" }], renewals: [] });
  const recovered = await renewalEffects(owner, due);
  expect(recovered).toMatchObject({ frozen: true, retry: "recovered", cycle: "paid", settlement: "settled" });
  expect(dueJob.execute).toHaveBeenCalledTimes(2);

  const stock = await seedRenewal(owner, 0);
  await recordRenewalMethod(owner, stock, "frozen-method");
  const stockJob = bindSubscriptionJob(runtime, stock);
  const stockRun = await mounted(stockJob);
  expect(stockRun).toMatchObject({ retries: [], renewals: [{ status: "refused", reason: "inventory_unavailable" }] });
  const waiting = await renewalEffects(owner, stock);
  expect(waiting).toMatchObject({ frozen: true, stock_wait: "waiting", order: null, settlement: null });
  expect(stockJob.execute).not.toHaveBeenCalled();
  await owner.query("UPDATE public.fulfillment_stock_current SET total_quantity=10,for_sale_quantity=10 WHERE source_key=$1", [stock.source]);
  stockJob.time(later(2));
  const resumedRun = await mounted(stockJob);
  expect(resumedRun).toMatchObject({ retries: [], renewals: [{ status: "succeeded" }] });
  const secured = await renewalEffects(owner, stock);
  expect(secured).toMatchObject({ frozen: true, stock_wait: "stock_secured", cycle: "paid", reservation: "consumed" });
  expect(stockJob.execute).toHaveBeenCalledTimes(1);

  const direct = await seedRenewal(owner, 10, 1, undefined, false, "sandbox");
  const claimArgs = [direct.identity, direct.fingerprint, direct.snapshot, "fixture", 300, AT];
  const claim = await call(runtime, "subscription_claim_due_renewal", claimArgs);
  expect(claim).toMatchObject({ acquired: true, replayed: false, state: "claimed", operationFingerprint: direct.fingerprint });
  expect(await call(runtime, "subscription_claim_due_renewal", claimArgs)).toEqual({ ...claim, acquired: false, replayed: true, reason: "lease_active" });
  await call(runtime, "fulfillment_reserve_subscription_renewal", [claim.operationId, claim.claimToken, 900, AT]);
  const prepare = () => call(runtime, "commerce_prepare_subscription_renewal", [claim.operationId, claim.claimToken, AT]);
  const prepared = await prepare();
  expect(prepared).toMatchObject({ replayed: false, state: "attempt_prepared" });
  expect(await prepare()).toEqual({ ...prepared, replayed: true });
  const readback = await call(runtime, "subscription_read_renewal", [direct.identity]);
  expect(readback).toMatchObject({ state: prepared.state, orderId: prepared.orderId, settlementIntentId: prepared.settlementIntentId, cycleId: prepared.cycleId });
  const directEffects = await renewalEffects(owner, direct);

  const delivery = await fixture(owner);
  // Align the seeded subscription's start with its historical paid cycle.
  await owner.query(`UPDATE public.subscriptions SET started_at=(SELECT scheduled_at FROM public.subscription_cycles WHERE id=$2)
    WHERE id=$1`, [delivery.subscription, delivery.cycle]);
  await openCase(owner, delivery);
  const arrival = () => call(runtime, "fulfillment_record_alignment_arrival", [`arrival:${delivery.shipment}`, delivery.shipment, later(24 * 7), "evidence:fixture-arrival"]);
  expect(await arrival()).toEqual({ replayed: false });
  const aligned = await schedule(owner, delivery.subscription);
  expect(aligned).toMatchObject({ status: "active", next_cycle_at: new Date(later(24 * 35)) });
  expect(await arrival()).toEqual({ replayed: true });
  expect(await schedule(owner, delivery.subscription)).toEqual(aligned);
  const cancel = () => call(runtime, "subscription_apply_lifecycle_action", [delivery.client, "legacy-cancel", delivery.subscription, "cancel", {}, later(24 * 8)]);
  const cancelled = await cancel();
  expect(cancelled.subscriptionAction).toMatchObject({ status: "applied", subscriptionStatus: "cancelled" });
  expect((await cancel()).subscriptionAction).toMatchObject({ status: "replayed", subscriptionStatus: "cancelled" });
  const cancelledSchedule = await schedule(owner, delivery.subscription);
  expect(cancelledSchedule.status).toBe("cancelled");
  const deliveryEffects = (await owner.query("SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1", [delivery.subscription])).rows;
  const commands = (await owner.query("SELECT event_type FROM public.subscription_events WHERE subscription_id=$1 ORDER BY event_type", [delivery.subscription])).rows;

  // Compare stable effects, with each store's generated identities verified above.
  const dispatch = [dueJob, stockJob].map(job => job.execute.mock.calls.length);
  return { dueRun, retryRun, stockRun, resumedRun, declined, expired, recovered, waiting, secured, directEffects, aligned, deliveryEffects, commands, dispatch,
    cancelled: cancelledSchedule };
}
