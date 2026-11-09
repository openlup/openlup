import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresSubscriptionAutoResume } from "@openlup/platform/subscriptions";
import { fixture as paidPurchase } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, lifecycleDeclined, lifecycleInstallation, lifecycleProfiles, lifecycleRows, type LifecycleInstallation } from "./subscriptionLifecycleClosureFixture.js";

// Exercise the actual first-purchase activation writer and canonical timed pause.
describe.each(lifecycleProfiles)("delivered history on %s", profile => {
  let env: LifecycleInstallation;
  beforeAll(async () => { env = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { if (env) await env.close(); }, postgresTeardownTimeoutMs);
  beforeEach(async () => { await env.owner.query("UPDATE public.subscription_pause_windows SET resumed_at='2027-01-01T00:00:00Z' WHERE resumed_at IS NULL"); });
  async function purchasedPause(status = "fulfilled") {
    const f = await paidPurchase(env.owner, 1, true, true), sku = randomUUID();
    await env.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$1::uuid::text,'Neutral item')", [sku]);
    await env.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$1::uuid::text,'Neutral item')", [sku]);
    await env.owner.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES($1,$2,1,0,false,900,'XXX')`, [f.subscription, sku]);
    await env.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state) VALUES($1,'healthy')", [f.subscription]);
    await env.owner.query("UPDATE public.commerce_orders SET status=$2 WHERE id=$1", [f.order, status]);
    const before = (await env.owner.query("SELECT next_cycle_at,cadence_days FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
    await call(env.runtime, "subscription_apply_lifecycle_action", [f.client, `pause:${f.subscription}`, f.subscription, "pause", { pausePreset: "2_weeks" }, AT]);
    const window = (await env.owner.query("SELECT id,ends_at FROM public.subscription_pause_windows WHERE subscription_id=$1 AND resumed_at IS NULL", [f.subscription])).rows[0];
    return { ...f, next: before.next_cycle_at as Date, cadence: Number(before.cadence_days), window: String(window.id), end: (window.ends_at as Date).toISOString() };
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
    const next = f.next.getTime() + (Math.floor((Date.parse(f.end) - f.next.getTime()) / (f.cadence * 86400000)) + 1) * f.cadence * 86400000;
    const subscription = (await env.owner.query("SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
    expect(subscription).toEqual({ status: "active", next_cycle_at: new Date(next) });
    expect(next).toBeGreaterThanOrEqual(f.next.getTime());
    expect(next).toBeGreaterThan(Date.parse(f.end));
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
  it.each(["paid", "fulfillment_pending"].flatMap(status => [false, true].map(unlinked => ({ status, unlinked }))))("keeps $status in flight blocked, missing cycle=$unlinked", async ({ status, unlinked }) => {
    const f = await purchasedPause(status);
    if (unlinked) await env.owner.query("UPDATE public.commerce_orders SET subscription_cycle_id=NULL WHERE id=$1", [f.order]);
    await skipped(f);
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
      .toEqual({ status: "active", next_cycle_at: new Date("2026-09-29T12:00:00Z") });
    expect(await closed()).toEqual({ orders: "cancelled", cycle: "skipped", on_next_date: false, dunning: "paused" });
    expect((await env.owner.query("SELECT id FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.system.auto_resume'", [f.subscription])).rows).toHaveLength(1);
  });
  it("keeps an open dunning case blocked despite delivered purchase history", async () => {
    const f = await purchasedPause();
    await env.owner.query("INSERT INTO public.subscription_dunning_cases(subscription_id,client_id,idempotency_key) VALUES($1,$2,$3)", [f.subscription, f.client, `case:${f.subscription}`]);
    await skipped(f);
  });
});
