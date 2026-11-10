import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresLifecycleMessages, createPostgresRetryLifecycleBinding, createPostgresRetryStore, createPostgresSubscriptionAutoResume } from "@openlup/platform/subscriptions";
import { createPostgresRenewalSettlementPort } from "../../server/adapters/postgres/commerce/renewalSettlement.js";
import type { RenewalSettlementPort } from "@openlup/platform/subscriptions/contracts";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, failure, later, prepareOriginal, renewal, request } from "./subscriptionNativeFixture.js";
import { lifecycleInstallation, lifecycleProfiles, lifecycleRows, lifecycleSubject, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

const NOW = later(24 * 60);
describe.each(lifecycleProfiles)("retry and timed resume on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (env) await env.close(); }, postgresTeardownTimeoutMs);
  beforeEach(async () => { await env.owner.query("UPDATE public.subscription_pause_windows SET resumed_at=$1 WHERE resumed_at IS NULL", [NOW]); });
  async function paused(next: string | null = AT, preset = "2_weeks") {
    const f = await lifecycleSubject(env.owner), window = randomUUID();
    await env.owner.query("UPDATE public.subscriptions SET status='paused',next_cycle_at=$2 WHERE id=$1", [f.subscription, next]);
    await env.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      SELECT $1,s.id,2,0,false,100,'XXX' FROM public.catalog_skus s JOIN public.subscription_renewal_term_lines t ON t.sku=s.sku WHERE t.subscription_id=$1`, [f.subscription]);
    await env.owner.query(`INSERT INTO public.subscription_pause_windows(id,subscription_id,pause_preset,starts_at,ends_at,idempotency_key)
      VALUES($1::uuid,$2,$3,$4,$5,$1::uuid::text)`, [window, f.subscription, preset, AT, preset === "indefinite" ? null : later(336)]);
    return { ...f, window };
  }
  const run = () => createPostgresSubscriptionAutoResume(env.runtime).run(100, NOW);
  const state = async (id: string) => (await env.owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [id])).rows[0];
  const cycle = async (id: string, status: string, date = AT) => (await env.owner.query(
    "INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,$3) RETURNING id", [id, date, status])).rows[0].id;

  it("resumes at the clamped shifted date once, closes its window and retains the exact system event policy", async () => {
    const f = await paused();
    expect(await run()).toEqual({ ok: true, scanned: 1, resumed: 1, skippedRows: 0, failed: 0 });
    expect(await state(f.subscription)).toEqual({ status: "active", next_cycle_at: new Date(NOW) });
    const event = (await env.owner.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1", [f.subscription])).rows;
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({ event_type: "subscription.system.auto_resume", idempotency_key: `subscription_auto_resume:${f.window}`,
      payload: { action: "auto_resume", pauseWindowId: f.window, pausePreset: "2_weeks", policy: {
        requiresPaymentMethod: true, blocksOpenDunning: true, blocksLockedUpcomingCycle: true } } });
    expect(new Date(event[0].payload.nextCycleAt).toISOString()).toBe(NOW);
    expect((await env.owner.query("SELECT resumed_at,event_id FROM public.subscription_pause_windows WHERE id=$1", [f.window])).rows[0])
      .toEqual({ resumed_at: new Date(NOW), event_id: event[0].id });
    const before = await lifecycleRows(env.owner);
    expect(await run()).toEqual({ ok: true, scanned: 0, resumed: 0, skippedRows: 0, failed: 0 });
    expect(await lifecycleRows(env.owner)).toEqual(before);
  });
  it.each(["method", "date", "lines", "case", "paid_next", "unpaid", "stale_unpaid"])("gracefully skips %s without writes and re-evaluates its open window", async reason => {
    const f = await paused(reason === "date" ? null : AT);
    let blocked: string | undefined;
    if (reason === "method") await env.owner.query("UPDATE public.subscription_method_states SET health_state='method_missing' WHERE subscription_id=$1", [f.subscription]);
    if (reason === "lines") await env.owner.query("DELETE FROM public.subscription_lines WHERE subscription_id=$1", [f.subscription]);
    if (reason === "case") await env.owner.query(`INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)`, [f.subscription, f.client, randomUUID()]);
    if (["paid_next", "unpaid", "stale_unpaid"].includes(reason)) blocked = await cycle(f.subscription, reason === "paid_next" ? "paid" : "payment_pending", reason === "stale_unpaid" ? later(-24) : AT);
    const before = await lifecycleRows(env.owner);
    expect(await run()).toEqual({ ok: true, scanned: 1, resumed: 0, skippedRows: 1, failed: 0 });
    expect(await lifecycleRows(env.owner)).toEqual(before);
    if (reason === "method") {
      await env.owner.query("UPDATE public.subscription_method_states SET health_state='healthy' WHERE subscription_id=$1", [f.subscription]);
      expect(await run()).toMatchObject({ resumed: 1, failed: 0 });
    }
    if (blocked) {
      await env.owner.query("UPDATE public.subscription_cycles SET status='skipped' WHERE id=$1", [blocked]);
      expect(await run()).toMatchObject({ resumed: 1, failed: 0 });
    }
  });
  it.each(["paid", "fulfillment_pending", "fulfilled"])("skips a %s order on the next date, preserving its parcel", async status => {
    const f = await paused(), c = await cycle(f.subscription, "skipped");
    const order = randomUUID(), activation = randomUUID();
    await env.owner.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor) VALUES($1,$2,NULL,$3,'XXX',0)", [order, f.client, status]);
    await env.owner.query(`INSERT INTO public.subscription_activations(id,order_id,client_id,subscription_id,state,cadence_days,declare_idempotency_key,activated_at,payment_fingerprint,activation_idempotency_key)
      VALUES($1::uuid,$2,$3,$4,'active',28,$1::uuid::text,$5,repeat('a',64),$1::uuid::text)`, [activation, order, f.client, f.subscription, AT]);
    // Each status is an explicit next-cycle allowlist probe, not a delivered-history simulation.
    await env.owner.query("UPDATE public.subscription_cycles SET scheduled_at=(SELECT next_cycle_at FROM public.subscriptions WHERE id=$2) WHERE id=$1", [c, f.subscription]);
    await env.owner.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [order, c]);
    await env.owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('resume-parcels','3pl',true) ON CONFLICT DO NOTHING");
    await env.owner.query("INSERT INTO public.fulfillment_shipments(order_id,port_key,provider_type,create_idempotency_key) VALUES($1,'resume-parcels','3pl',$2)", [order, `parcel:${order}`]);
    const parcels = (await env.owner.query("SELECT * FROM public.fulfillment_shipments WHERE order_id=$1", [order])).rows;
    const before = await lifecycleRows(env.owner);
    expect(await run()).toMatchObject({ ok: true, resumed: 0, skippedRows: 1, failed: 0 });
    expect((await env.owner.query("SELECT * FROM public.fulfillment_shipments WHERE order_id=$1", [order])).rows).toEqual(parcels);
    expect(await lifecycleRows(env.owner)).toEqual(before);
    expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [c])).rows[0].status).toBe("skipped");
  });
  it("admits terminal and collected historical cycles, shifts a future date, excludes indefinite and future windows", async () => {
    const f = await paused(later(24 * 90));
    for (const [n, status] of ["paid", "cancelled", "skipped"].entries()) await cycle(f.subscription, status, later(-24 * (n + 1)));
    const indefinite = await paused(AT, "indefinite"), future = await paused();
    await env.owner.query("UPDATE public.subscription_pause_windows SET ends_at=$2 WHERE id=$1", [future.window, later(24 * 70)]);
    expect(await run()).toMatchObject({ scanned: 1, resumed: 1, skippedRows: 0, failed: 0 });
    expect(await state(f.subscription)).toEqual({ status: "active", next_cycle_at: new Date(later(24 * 104)) });
    expect((await state(indefinite.subscription)).status).toBe("paused");
    expect((await state(future.subscription)).status).toBe("paused");
  });
  it("skips locked subscriptions and windows and admits the next tick", async () => {
    const f = await paused(), db = await env.owner.connect();
    try {
      await db.query("BEGIN"); await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
      expect(await run()).toMatchObject({ scanned: 0, failed: 0 });
      await db.query("ROLLBACK"); await db.query("BEGIN");
      await db.query("SELECT id FROM public.subscription_pause_windows WHERE id=$1 FOR UPDATE", [f.window]);
      expect(await run()).toMatchObject({ scanned: 0, failed: 0 });
      await db.query("ROLLBACK"); expect(await run()).toMatchObject({ resumed: 1 });
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each(["pause", "cancel"].flatMap(action => [false, true].map(hasCase => ({ action, hasCase }))))("fences delayed observations after $action, existing case=$hasCase and later resume/reactivation", async ({ action, hasCase }) => {
    const f = await renewal(env.owner), original = await prepareOriginal(env.owner, f), input = failure();
    await call(env.runtime, "subscription_retry_apply_failure", [f.operation, `failure:${f.operation}`, input]);
    await env.owner.query("UPDATE public.subscriptions SET started_at='2026-01-01T00:00:00Z' WHERE id=$1", [f.subscription]);
    await env.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
    const actor = randomUUID();
    if (hasCase) await call(env.runtime, "subscription_retry_open_case", [f.operation, "failed", "/recover"]);
    expect(await call(env.runtime, "subscription_command_apply", [actor, f.client, `close:${f.subscription}`, f.subscription, action,
      action === "pause" ? { pausePreset: "2_weeks" } : {}, AT])).toMatchObject({ status: "applied" });
    for (const resumed of [false, true]) {
      if (resumed) expect(await call(env.runtime, "subscription_command_apply", [actor, f.client, `resume:${f.subscription}`, f.subscription,
        action === "pause" ? "resume" : "reactivate", { confirmedChargeTiming: true }, later(1)])).toMatchObject({ status: "applied" });
      const before = await lifecycleRows(env.owner);
      await expect(call(env.runtime, "subscription_retry_open_case", [f.operation, "failed", "/recover"])).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("subscription_dunning_subscription_cancelled") });
      await expect(call(env.runtime, "subscription_retry_apply_failure", [f.operation, `late:${f.operation}`, { ...input, evidenceKey: "late" }])).rejects.toThrow("not_unpaid");
      expect(await lifecycleRows(env.owner)).toEqual(before);
      expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [original.cycleId])).rows[0].status).toBe(action === "pause" ? "skipped" : "cancelled");
    }
  });
  it("serializes a late missing-case observation behind the pause transaction", async () => {
    const f = await renewal(env.owner); await prepareOriginal(env.owner, f);
    await call(env.runtime, "subscription_retry_apply_failure", [f.operation, `failure:${f.operation}`, failure()]);
    const db = await env.owner.connect();
    try {
      await db.query("BEGIN"); await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscription]);
      const late = expect(call(env.runtime, "subscription_retry_open_case", [f.operation, "failed", "/recover"])).rejects.toThrow("subscription_cancelled");
      expect(await call(db, "subscription_command_apply", [randomUUID(), f.client, `pause:${f.subscription}`, f.subscription, "pause", { pausePreset: "2_weeks" }, AT])).toMatchObject({ status: "applied" });
      await db.query("COMMIT"); await late;
      expect((await env.owner.query("SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscription])).rows).toEqual([]);
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it("dispatches the auto-resume event as the same resumed confirmation and replays its receipt", async () => {
    await env.owner.query(`INSERT INTO public.subscription_notice_refusals(source,source_id,reason)
      SELECT 'event',id,'notice_policy_refused' FROM public.subscription_events ON CONFLICT DO NOTHING`);
    const f = await paused(); await run();
    const sent: string[] = [], receipts = new Map<string, { state: "accepted"; deliveryReference: string }>();
    const notices = createPostgresLifecycleMessages({
      async withSession(work) { const db = await env.runtime.connect(); try { return await work(db); } finally { db.release(); } },
      async bind(notice) {
        expect(notice.kind).toBe("subscription.resumed");
        expect(notice.templateSlug).toBe("subscription-resumed");
        expect(notice.subscriptionId).toBe(f.subscription);
        return { recipientReference: f.client, templateReference: notice.templateSlug };
      },
      delivery: {
        readReceipt: async key => receipts.get(key) ?? null,
        async send(command) {
          sent.push(command.idempotencyKey);
          const receipt = { state: "accepted" as const, deliveryReference: `captured:${command.idempotencyKey}` };
          receipts.set(command.idempotencyKey, receipt); return receipt;
        },
      },
    });
    expect(await notices.run(100)).toMatchObject({ sent: 1, failed: 0 });
    expect(await notices.run(100)).toMatchObject({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });
  it("uses the trusted cadence in initial handoff and terminal bookkeeping without rewriting replay", async () => {
    const f = await renewal(env.owner), original = await prepareOriginal(env.owner, f);
    function binding(backoffHours: number[]) {
      return createPostgresRetryLifecycleBinding({ executor: env.runtime, retryCadence: { backoffHours },
        async withTransaction(work) {
          const db = await env.runtime.connect();
          try { await db.query("BEGIN"); const result = await work(db); await db.query("COMMIT"); return result; }
          catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
        },
        settlement: db => createPostgresRenewalSettlementPort(db) as unknown as RenewalSettlementPort,
        correlate: () => ({ status: "correlated", logicalCycleNumber: 3, nativeRenewalCounter: 2, activationCycleId: null, evidenceRef: "fixture" }),
        failureTemplate: "failed", recoveryPath: "/recover",
      });
    }
    const host = binding([2, 5]);
    const handoff = { idempotencyKey: `${f.identity}:failure-handoff`, subscriptionId: f.subscription, clientId: f.client,
      cycleId: original.cycleId, orderId: original.orderId, paymentIntentId: original.settlementIntentId,
      retryAttempt: 1, nextRetryAt: later(24), failureClass: "temporary", failureReason: "declined", occurredAt: AT,
      amountMinor: f.snapshot.totalAmountMinor, currency: "XXX" };
    await host.failureHandoff.handoffFailure(handoff);
    const terminal = { operationId: f.operation, eventKey: `terminal:${f.operation}`, operationFingerprint: f.fingerprint,
      outcome: "refused" as const, externalRef: "original-ack", reason: "declined", occurredAt: AT };
    await host.settlement.recordTerminalOutcome(terminal);
    const before = await lifecycleRows(env.owner);
    await binding([9]).failureHandoff.handoffFailure(handoff);
    await binding([9]).settlement.recordTerminalOutcome(terminal);
    expect(await lifecycleRows(env.owner)).toEqual(before);
    expect(new Date((await createPostgresRetryStore(env.runtime).read(f.operation))!.nextRetryAt!).toISOString()).toBe(later(2));
  });
  it("rejects invalid SQL timing atomically and permits a zero-slot retry budget", async () => {
    const f = await renewal(env.owner); await prepareOriginal(env.owner, f);
    for (const policy of [null, {}, { backoffHours: [0] }, { backoffHours: ["2"] }, { backoffHours: [2], terminatingFailureClasses: [] }]) {
      const before = await lifecycleRows(env.owner);
      await expect(call(env.runtime, "subscription_retry_apply_failure", [f.operation, `invalid:${f.operation}`, failure(), policy])).rejects.toThrow("cadence_invalid");
      expect(await lifecycleRows(env.owner)).toEqual(before);
    }
    expect(await createPostgresRetryStore(env.runtime, { backoffHours: [] }).applyFailure(f.operation, `empty:${f.operation}`, failure()))
      .toMatchObject({ nextRetryAt: null, retryAttempt: 1 });
  });
  it("uses a different ladder length from each failure, preserves receipt replay and fixed class termination", async () => {
    const f = await renewal(env.owner), original = await prepareOriginal(env.owner, f);
    const store = createPostgresRetryStore(env.runtime, { backoffHours: [2, 5] });
    let row = await store.applyFailure(f.operation, `failure:${f.operation}`, failure());
    expect(new Date(row.nextRetryAt!).toISOString()).toBe(later(2));
    expect(await createPostgresRetryStore(env.runtime, { backoffHours: [9] }).applyFailure(f.operation, `failure:${f.operation}`, failure())).toEqual(row);
    let at = 2;
    for (let seq = 1; seq <= 2; seq++) {
      await store.prepare(f.operation, `prepare:${f.operation}:${seq}`, request({ ...f, original }, seq), later(at));
      at++;
      row = await store.applyFailure(f.operation, `failure:${f.operation}:${seq}`, failure(seq, later(at)));
      expect(row.retryAttempt).toBe(seq + 1);
      expect(row.nextRetryAt === null ? null : new Date(row.nextRetryAt).toISOString()).toBe(seq === 1 ? later(at + 5) : null);
      at += 5;
    }
    expect((await state(f.subscription)).status).toBe("active");
    const stopped = await renewal(env.owner); await prepareOriginal(env.owner, stopped);
    expect(await store.applyFailure(stopped.operation, `failure:${stopped.operation}`, failure(0, AT, "hard_do_not_retry"))).toMatchObject({ nextRetryAt: null });
  });
});
