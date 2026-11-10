import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresSubscriptionAutoResume } from "@openlup/platform/subscriptions";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { createPostgresFulfillmentShipmentSpinePort } from "@openlup/platform/fulfillment";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, lifecycleDeclined, lifecycleInstallation, lifecycleProfiles, lifecycleRows, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

// Exercise the actual first-purchase activation writer and canonical timed pause.
describe.each(lifecycleProfiles)("delivered history on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (env) await env.close(); }, postgresTeardownTimeoutMs);
  beforeEach(async () => { await env.owner.query("UPDATE public.subscription_pause_windows SET resumed_at='2027-01-01T00:00:00Z' WHERE resumed_at IS NULL"); });
  async function paidOrder(client: string) {
    const order = randomUUID(), paidAt = "2026-07-04T12:00:00Z";
    const db = await env.owner.connect();
    try {
      await db.query('BEGIN');
      await db.query(`INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor,created_at)
        VALUES($1,$2,'XXX',900,$3)`, [order, client, paidAt]);
      await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
        VALUES($1,1,1,900,900)`, [order]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    expect((await env.owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [order])).rows[0].status).toBe("pending_payment");
    await call(env.runtime, "subscription_declare_provisional_activation", [`declare:${order}`, order, 28, paidAt]);
    const opened = await call(env.runtime, "commerce_open_settlement_intent", [`open:${order}`, order, "sandbox", 900, "XXX", {}, paidAt]);
    const simulator = createPostgresSandboxPaymentSimulator(env.runtime, {
      dunningTemplateSlug: "payment-failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment-recovered" });
    expect(await captureSandboxPurchase(simulator, { settlementIntentId: opened.settlement.id, key: order, at: paidAt }))
      .toMatchObject({ status: 200 });
    const captured = (await env.owner.query("SELECT status,external_ref FROM public.commerce_settlement_intents WHERE id=$1", [opened.settlement.id])).rows[0];
    expect(captured.status).toBe("settled");
    return { order, paidAt, fingerprint: createHash("sha256").update(captured.external_ref ?? opened.settlement.id).digest("hex") };
  }
  async function purchasedPause(status = "paid") {
    const client = randomUUID(), sku = randomUUID();
    await env.owner.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
    const { order, paidAt, fingerprint } = await paidOrder(client);
    const activated = await call(env.runtime, "subscription_activate_from_captured_payment", [`activate:${order}`, order, fingerprint]);
    const subscription = String(activated.subscriptionId);
    const cycle = (await env.owner.query("SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1", [order])).rows[0].subscription_cycle_id;
    await env.owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('resume-parcels','3pl',true) ON CONFLICT DO NOTHING");
    const spine = createPostgresFulfillmentShipmentSpinePort(env.runtime, { portKey: "resume-parcels" });
    const shipment = (await spine.createShipment({ idempotencyKey: `shipment:${order}`, orderId: order, requestedAt: paidAt })).shipmentId;
    // This archetype owns labels outside the local rail: packed -> handed_over is its legal path.
    await call(env.runtime, "fulfillment_advance_shipment", [`packed:${order}`, shipment, "packed", {}, "2026-07-05T12:00:00Z"]);
    await spine.handOff({ idempotencyKey: `handoff:${order}`, shipmentId: shipment, requestedAt: "2026-07-05T13:00:00Z" });
    await spine.recordTracking({ idempotencyKey: `delivered:${order}`, shipmentId: shipment, externalRef: `tracking:${order}`,
      status: "delivered", requestedAt: "2026-07-06T12:00:00Z" });
    expect((await env.owner.query("SELECT status FROM public.fulfillment_shipments WHERE id=$1", [shipment])).rows[0].status).toBe("delivered");
    expect((await env.owner.query("SELECT status FROM public.commerce_orders WHERE id=$1", [order])).rows[0].status).toBe("paid");
    const f = { client, subscription, cycle, order, shipment };
    await env.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$1::uuid::text,'Neutral item')", [sku]);
    await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$1::uuid::text,'Neutral item')", [sku]);
    await env.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES($1,$2,1,0,false,900,'XXX')`, [f.subscription, sku]);
    await env.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
    // Status variants below characterize the allowlist; delivered history always retains native paid truth.
    if (status !== "paid") await env.owner.query("UPDATE public.commerce_orders SET status=$2 WHERE id=$1", [f.order, status]);
    const before = (await env.owner.query("SELECT next_cycle_at,cadence_days FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
    await call(env.runtime, "subscription_apply_lifecycle_action", [f.client, `pause:${f.subscription}`, f.subscription, "pause", { pausePreset: "2_weeks" }, AT]);
    const window = (await env.owner.query("SELECT id,ends_at FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL", [f.subscription])).rows[0];
    return { ...f, next: before.next_cycle_at as Date, cadence: Number(before.cadence_days), window: String(window.id), end: (window.ends_at as Date).toISOString() };
  }
  async function operation(f: Awaited<ReturnType<typeof purchasedPause>>, state: string, orderId = f.order) {
    const id = randomUUID();
    await env.owner.query(`INSERT INTO public.subscription_renewal_operations(id,subscription_id,scheduled_at,cycle_number,
      identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,terminal_outcome,terminal_at)
      VALUES($1,$2,$3,2,$4,$5,'{}',$6,$7,'fixture',$8,$8::timestamptz+interval '1 hour',
        CASE WHEN $6 IN ('succeeded','refused') THEN $6 END,CASE WHEN $6 IN ('succeeded','refused') THEN $8::timestamptz END)`,
      [id, f.subscription, f.next, `subscription:${f.subscription}:cycle:${f.next.toISOString()}`, 'a'.repeat(64), state, randomUUID(), AT]);
    await env.owner.query(`UPDATE public.commerce_orders SET subscription_cycle_id=NULL,renewal_operation_id=$2,
      renewal_operation_fingerprint=$3 WHERE id=$1`, [orderId, id, 'a'.repeat(64)]);
    return id;
  }
  const run = (now: string) => createPostgresSubscriptionAutoResume(env.runtime).run(100, now);
  async function skipped(f: Awaited<ReturnType<typeof purchasedPause>>) {
    const before = await lifecycleRows(env.owner);
    expect(await run(f.end)).toEqual({ ok: true, scanned: 1, resumed: 0, skippedRows: 1, failed: 0 });
    expect(await lifecycleRows(env.owner)).toEqual(before);
    expect((await env.owner.query("SELECT resumed_at FROM public.subscription_pause_windows WHERE id=$1", [f.window])).rows[0].resumed_at).toBeNull();
  }

  it("resumes a delivered first order with its historical paid cycle at the window end", async () => {
    const f = await purchasedPause();
    expect((await env.owner.query("SELECT status,scheduled_at FROM public.subscription_cycles WHERE id=$1", [f.cycle])).rows[0])
      .toEqual({ status: "paid", scheduled_at: new Date("2026-07-04T12:00:00Z") });
    const history = (await env.owner.query("SELECT * FROM public.fulfillment_shipments WHERE order_id=$1", [f.order])).rows;
    expect(await run(f.end)).toEqual({ ok: true, scanned: 1, resumed: 1, skippedRows: 0, failed: 0 });
    const next = Math.max(f.next.getTime() + Date.parse(f.end) - Date.parse(AT), Date.parse(f.end));
    const subscription = (await env.owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
    expect(subscription).toEqual({ status: "active", next_cycle_at: new Date(next) });
    expect(next).toBeGreaterThanOrEqual(f.next.getTime());
    expect(next).toBeGreaterThanOrEqual(Date.parse(f.end));
    const events = (await env.owner.query("SELECT id,event_type,idempotency_key,payload FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.system.auto_resume'", [f.subscription])).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "subscription.system.auto_resume", idempotency_key: `subscription_auto_resume:${f.window}`,
      payload: { action: "auto_resume", pauseWindowId: f.window, policy: { requiresPaymentMethod: true, blocksOpenDunning: true, blocksLockedUpcomingCycle: true } } });
    expect(new Date(events[0].payload.nextCycleAt).getTime()).toBe(next);
    expect((await env.owner.query("SELECT resumed_at,event_id FROM public.subscription_pause_windows WHERE id=$1", [f.window])).rows[0])
      .toEqual({ resumed_at: new Date(f.end), event_id: events[0].id });
    expect((await env.owner.query("SELECT status FROM public.subscription_cycles WHERE id=$1", [f.cycle])).rows[0].status).toBe("paid");
    expect((await env.owner.query("SELECT * FROM public.fulfillment_shipments WHERE order_id=$1", [f.order])).rows).toEqual(history);
    const before = await lifecycleRows(env.owner);
    expect(await run(f.end)).toMatchObject({ scanned: 0, resumed: 0, failed: 0 });
    expect(await lifecycleRows(env.owner)).toEqual(before);
  });
  it.each(["paid", "fulfillment_pending"].flatMap(status => [false, true].map(unlinked => ({ status, unlinked }))))("blocks $status on the next date or unfinished renewal, missing cycle=$unlinked", async ({ status, unlinked }) => {
    const f = await purchasedPause(status);
    if (unlinked) await operation(f, "claimed");
    else await env.owner.query("UPDATE public.subscription_cycles SET scheduled_at=$2,status='skipped' WHERE id=$1", [f.cycle, f.next]);
    await skipped(f);
  });
  it.each(["reserved", "attempt_prepared", "succeeded", "refused"])("uses native renewal terminal state %s for an unlinked paid order", async state => {
    const f = await purchasedPause(); await operation(f, state);
    if (["reserved", "attempt_prepared"].includes(state)) await skipped(f);
    else expect(await run(f.end)).toMatchObject({ ok: true, resumed: 1, skippedRows: 0, failed: 0 });
  });
  it("does not block on an unlinked paid first order after its activation completed", async () => {
    const f = await purchasedPause();
    await env.owner.query("UPDATE public.commerce_orders SET subscription_cycle_id=NULL WHERE id=$1", [f.order]);
    expect(await run(f.end)).toMatchObject({ ok: true, resumed: 1, skippedRows: 0, failed: 0 });
  });
  it("blocks a native incomplete activation and re-evaluates after activation completes", async () => {
    const f = await purchasedPause(), pending = await paidOrder(f.client);
    // Provisional activations have no subscription ID by CHECK. The retained
    // terminal operation supplies association while isolating the activation blocker.
    await operation(f, "succeeded", pending.order);
    expect((await env.owner.query("SELECT state,subscription_id FROM public.subscription_activations WHERE order_id=$1", [pending.order])).rows)
      .toEqual([{ state: "provisional", subscription_id: null }]);
    await skipped(f);
    await call(env.runtime, "subscription_activate_from_captured_payment", [`activate:${pending.order}`, pending.order, pending.fingerprint]);
    await env.owner.query("UPDATE public.commerce_orders SET subscription_cycle_id=NULL WHERE id=$1", [pending.order]);
    expect(await run(f.end)).toMatchObject({ ok: true, resumed: 1, skippedRows: 0, failed: 0 });
  });
  it.each(["paid", "fulfillment_pending", "fulfilled"])("keeps a %s order on the next date blocked independently of the paid-cycle guard", async status => {
    const f = await purchasedPause(status);
    // A terminal cycle isolates the order clause rather than the separate paid-cycle guard.
    await env.owner.query("UPDATE public.subscription_cycles SET scheduled_at=$2,status='skipped' WHERE id=$1", [f.cycle, f.next]);
    await skipped(f);
  });
  it.each(["pending_payment", "cancelled"])("does not add a next-date blocker for a %s order", async status => {
    const f = await purchasedPause(status);
    await env.owner.query("UPDATE public.subscription_cycles SET scheduled_at=$2,status='skipped' WHERE id=$1", [f.cycle, f.next]);
    expect(await run(f.end)).toMatchObject({ ok: true, resumed: 1, skippedRows: 0, failed: 0 });
  });
  it("resumes after pause closure cancels the unpaid order on next_cycle_at", async () => {
    const f = await lifecycleDeclined(env.owner);
    await env.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      SELECT $1,s.id,2,0,false,100,'XXX' FROM public.catalog_skus s
      JOIN public.subscription_renewal_term_lines t ON t.sku=s.sku WHERE t.subscription_id=$1`, [f.subscription]);
    expect(await call(env.runtime, "subscription_command_apply", [f.actor, f.client, `pause:${f.subscription}`, f.subscription,
      "pause", { pausePreset: "2_weeks" }, AT])).toMatchObject({ status: "applied" });
    const closed = async () => (await env.owner.query(`SELECT o.status AS orders,c.status AS cycle,c.scheduled_at=s.next_cycle_at AS on_next_date,
      dc.status AS dunning FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
      JOIN public.subscriptions s ON s.id=c.subscription_id JOIN public.subscription_dunning_cases dc ON dc.cycle_id=c.id
      WHERE o.id=$1`, [f.original.orderId])).rows[0];
    expect(await closed()).toEqual({ orders: "cancelled", cycle: "skipped", on_next_date: true, dunning: "paused" });
    const window = (await env.owner.query("SELECT ends_at FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL", [f.subscription])).rows[0];
    expect(await run((window.ends_at as Date).toISOString())).toEqual({ ok: true, scanned: 1, resumed: 1, skippedRows: 0, failed: 0 });
    expect((await env.owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0])
      .toEqual({ status: "active", next_cycle_at: new Date(window.ends_at) });
    expect(await closed()).toEqual({ orders: "cancelled", cycle: "skipped", on_next_date: false, dunning: "paused" });
    expect((await env.owner.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.system.auto_resume'", [f.subscription])).rows).toHaveLength(1);
  });
  it("keeps an open dunning case blocked despite delivered purchase history", async () => {
    const f = await purchasedPause();
    await env.owner.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)", [f.subscription, f.client, `case:${f.subscription}`]);
    await skipped(f);
  });
});
