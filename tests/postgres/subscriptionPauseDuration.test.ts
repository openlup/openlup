import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activateNativePurchaseWithRenewal, createNativeRenewalCodec, createPostgresRenewalSettlementPort, createPostgresRenewalStore, createPostgresRetryLifecycleBinding,
  createPostgresSandboxRenewalRail, createPostgresSubscriptionAutoResume, createSandboxRenewalPolicy, runOneAutomaticSubscriptionRenewal,
  type SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createPostgresDestinationPort } from "@openlup/platform/commerce/server/destinations";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { createPostgresFulfillmentShipmentSpinePort } from "@openlup/platform/fulfillment";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, lifecycleInstallation, lifecycleProfiles, lifecycleSubject, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

const days = (stamp: string, count: number) => new Date(Date.parse(stamp) + count * 86400000).toISOString();
describe.each(lifecycleProfiles)("pause duration on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (env) await env.close(); }, postgresTeardownTimeoutMs);
  beforeEach(async () => { await env.owner.query("UPDATE public.subscription_pause_windows SET resumed_at='2099-01-01T00:00:00Z' WHERE resumed_at IS NULL"); });
  async function paused(start = AT, next = days(start, 14)) {
    const f = await lifecycleSubject(env.owner), window = randomUUID(), end = days(start, 7);
    await env.owner.query("UPDATE public.subscriptions SET status='paused',cadence_days=14,next_cycle_at=$2 WHERE id=$1", [f.subscription, next]);
    await env.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      SELECT $1,s.id,2,0,false,100,'XXX' FROM public.catalog_skus s JOIN public.subscription_renewal_term_lines t ON t.sku=s.sku WHERE t.subscription_id=$1`, [f.subscription]);
    // The stored window duration is authoritative, independently of the preset label.
    await env.owner.query(`INSERT INTO public.subscription_pause_windows(id,subscription_id,pause_preset,starts_at,ends_at,idempotency_key)
      VALUES($1::uuid,$2,'2_weeks',$3,$4,$1::uuid::text)`, [window, f.subscription, start, end]);
    return { ...f, window, start, end, next };
  }
  const run = (now: string) => createPostgresSubscriptionAutoResume(env.runtime).run(100, now);
  async function resumed(f: { subscription: string; next: string }, now: string, expected: string) {
    expect(await run(now)).toMatchObject({ ok: true, resumed: 1, skippedRows: 0, failed: 0 });
    expect((await env.owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows)
      .toEqual([{ status: "active", next_cycle_at: new Date(expected) }]);
    const events = (await env.owner.query("SELECT payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.system.auto_resume'", [f.subscription])).rows;
    expect(events).toHaveLength(1);
    expect(new Date(events[0].payload.nextCycleAt).toISOString()).toBe(expected);
    expect(Date.parse(expected)).toBeGreaterThanOrEqual(Date.parse(f.next));
    expect(await run(now)).toMatchObject({ resumed: 0, failed: 0 });
  }
  it("adds seven days to a fourteen-day cycle and promises that same date in the reminder", async () => {
    // The producer owns a wall clock: capture it once, then bind explicit UTC instants.
    const clock = (await env.owner.query("SELECT now() AS instant")).rows[0].instant.toISOString() as string;
    const start = days(clock, -4), f = await paused(start), expected = days(start, 21);
    await call(env.runtime, "dunning_lifecycle_pause_reminder_dispatch", [100, 4 * 86400]);
    const payloads = (await env.owner.query("SELECT payload FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.pause_reminder_due'", [f.subscription])).rows;
    expect(payloads).toHaveLength(1);
    expect(new Date(payloads[0].payload.nextDeliveryAt).toISOString()).toBe(expected);
    expect(new Date(payloads[0].payload.resumeAt).toISOString()).toBe(expected);
    await call(env.runtime, "dunning_lifecycle_pause_reminder_dispatch", [100, 4 * 86400]);
    expect((await env.owner.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.pause_reminder_due'", [f.subscription])).rows).toHaveLength(1);
    await resumed(f, f.end, expected);
  });
  it("resumes a pause starting on the renewal date with the cycle at the pause end", async () => {
    const f = await paused(AT, AT);
    await resumed(f, f.end, f.end);
  });
  it("clamps a stranded shifted date to execution time without a cadence jump", async () => {
    const f = await paused(AT, days(AT, -30)), now = days(AT, 60);
    await resumed(f, now, now);
  });
  it("keeps a paid cycle on the stored date paused before applying the shift", async () => {
    const f = await paused();
    await env.owner.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'paid')", [f.subscription, f.next]);
    expect(await run(f.end)).toMatchObject({ ok: true, resumed: 0, skippedRows: 1, failed: 0 });
    expect((await env.owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows)
      .toEqual([{ status: "paused", next_cycle_at: new Date(f.next) }]);
  });
  it("follows the shifted date with one ordinary charge, cycle and delivered shipment under replay", async () => {
    const seed = await lifecycleSubject(env.owner), order = randomUUID(), method = `sandbox:${order}`;
    await env.owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [seed.subscription]);
    const db = await env.owner.connect();
    try {
      await db.query("BEGIN");
      await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,created_at) VALUES($1,$2,'XXX',200,$3)", [order, seed.client, AT]);
      await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,2,100,200)", [order]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    await call(env.runtime, "subscription_declare_provisional_activation", [`declare:${order}`, order, 14, AT]);
    const opened = await call(env.runtime, "commerce_open_settlement_intent", [`open:${order}`, order, "sandbox", 200, "XXX", {}, AT]);
    expect(await captureSandboxPurchase(createPostgresSandboxPaymentSimulator(env.runtime, {
      dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: opened.settlement.id, key: order, at: AT })).toMatchObject({ status: 200 });
    await createPostgresDestinationPort(env.runtime).registerOrder({ idempotencyKey: `destination:${order}`, orderId: order,
      address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: AT });
    const payment = (await env.owner.query("SELECT external_ref FROM public.commerce_settlement_intents WHERE id=$1", [opened.settlement.id])).rows[0];
    const activated = await activateNativePurchaseWithRenewal(env.runtime, { orderId: order, idempotencyKey: `activate:${order}`,
      capturedReference: payment.external_ref ?? opened.settlement.id, facts: { settlementChannelKey: "sandbox", authorizationRef: "sandbox:authorization",
        unattendedChargeAuthorizedAt: AT, payerAccountRef: "sandbox:payer", methodRef: method, methodEvidenceRef: "sandbox:evidence",
        stockSourceKey: seed.source, templateId: "neutral-refill", cadenceDays: 14, currency: "XXX", lines: seed.snapshot.lines,
        shippingAmountMinor: 0, acquisitionRef: null } });
    expect(activated.renewalAttachment).toBe("complete");
    const subscription = String(activated.activation.subscriptionId);
    await env.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      SELECT $1,s.id,2,0,false,100,'XXX' FROM public.catalog_skus s JOIN public.subscription_renewal_term_lines t ON t.sku=s.sku
      WHERE t.subscription_id=$1 AND NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=$1)`, [subscription]);
    expect((await env.owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [subscription])).rows)
      .toEqual([{ next_cycle_at: new Date(days(AT, 14)) }]);
    await env.owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('pause-parcels','3pl',true) ON CONFLICT DO NOTHING");
    const spine = createPostgresFulfillmentShipmentSpinePort(env.runtime, { portKey: "pause-parcels" });
    async function deliver(orderId: string, at: string) {
      const request = { idempotencyKey: `parcel:${orderId}`, orderId, requestedAt: at }, created = await spine.createShipment(request);
      await call(env.runtime, "fulfillment_advance_shipment", [`pack:${orderId}`, created.shipmentId, "packed", {}, at]);
      await spine.handOff({ idempotencyKey: `handoff:${orderId}`, shipmentId: created.shipmentId, requestedAt: at });
      await spine.recordTracking({ idempotencyKey: `arrival:${orderId}`, shipmentId: created.shipmentId, externalRef: `tracking:${orderId}`, status: "delivered", requestedAt: at });
      return { request, created };
    }
    await deliver(order, AT);
    await call(env.runtime, "subscription_apply_lifecycle_action", [seed.client, `pause:${subscription}`, subscription, "pause", { pausePreset: "2_weeks" }, AT]);
    const window = (await env.owner.query("SELECT id FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL", [subscription])).rows[0].id;
    await env.owner.query("UPDATE public.subscription_pause_windows SET ends_at=$2 WHERE id=$1", [window, days(AT, 7)]);
    const f = { ...seed, subscription, window, start: AT, end: days(AT, 7), next: days(AT, 14) }, shifted = days(AT, 21);
    await resumed(f, f.end, shifted);
    async function transaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T> {
      const db = await env.runtime.connect();
      try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    }
    const codec = createNativeRenewalCodec(), store = createPostgresRenewalStore(env.runtime, codec, transaction);
    const rail = createPostgresSandboxRenewalRail(env.runtime, { scenario: "succeeded", now: () => shifted }), execute = vi.spyOn(rail, "execute");
    const lifecycle = createPostgresRetryLifecycleBinding({ executor: env.runtime, withTransaction: transaction,
      settlement: db => createPostgresRenewalSettlementPort(db, codec), correlate: wire => codec.decode(wire).cycle, failureTemplate: "failed", recoveryPath: "/recover" });
    const input = { store, settlement: lifecycle.settlement, failureHandoff: lifecycle.failureHandoff,
      inventory: createPostgresRenewalReservationPort(env.runtime), paymentRails: { resolve: (channel: string) => channel === "sandbox" ? rail : null },
      workerId: "pause-duration", policy: createSandboxRenewalPolicy(method) };
    expect((await store.listDue(500, f.end)).find(row => row.subscriptionId === f.subscription)).toBeUndefined();
    const due = (await store.listDue(500, shifted)).find(row => row.subscriptionId === f.subscription)!;
    expect(due.scheduledAt).toBe(shifted);
    expect(await runOneAutomaticSubscriptionRenewal(input, due, shifted)).toMatchObject({ status: "succeeded" });
    const operation = (await store.readRenewal(input.policy.identityKey(due)))!;
    expect(await runOneAutomaticSubscriptionRenewal(input, due, shifted)).toMatchObject({ status: "terminal_replay" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await env.owner.query("SELECT status FROM public.commerce_settlement_intents WHERE renewal_operation_id=$1", [operation.operationId])).rows)
      .toEqual([{ status: "settled" }]);
    expect((await env.owner.query("SELECT status,scheduled_at FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2", [f.subscription, shifted])).rows)
      .toEqual([{ status: "paid", scheduled_at: new Date(shifted) }]);
    expect((await env.owner.query("SELECT outcome FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1 AND event_key=$2", [operation.operationId, `sandbox-observation:${operation.operationId}`])).rows)
      .toEqual([{ outcome: "succeeded" }]);
    const { request, created } = await deliver(operation.orderId!, shifted);
    expect((await spine.createShipment(request)).shipmentId).toBe(created.shipmentId);
    expect((await env.owner.query("SELECT status FROM public.fulfillment_shipments WHERE order_id=$1", [operation.orderId])).rows).toEqual([{ status: "delivered" }]);
    expect((await env.owner.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows)
      .toEqual([{ next_cycle_at: new Date(days(shifted, 14)) }]);
    expect(await run(days(shifted, 1))).toMatchObject({ resumed: 0, failed: 0 });
  });
});
