/** P1 invariant proof against the complete current native manifest, without M10 forwards. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresDeliveryAlignmentPort } from '@openlup/platform/fulfillment';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import { createPostgresAutomaticRenewalPort } from '../../server/adapters/postgres/subscription/automaticRenewal.js';
import { createPostgresRenewalSettlementPort } from '../../server/adapters/postgres/commerce/renewalSettlement.js';
import { runOneAutomaticSubscriptionRenewal, type AutomaticRenewalRunDeps } from '../../server/domains/subscription/runAutomaticSubscriptionRenewal.js';
import { withDeliveryAlignmentRenewalAdmission } from '../../server/runtime/subscription/deliveryAlignmentRenewalStore.js';
import { executor, fixture, nativeHarness, openCase, replacement, schedule } from '../helpers/fulfillmentNative.js';

const h = nativeHarness('m10-p1-baseline');
const now = '2026-10-22T12:00:00.000Z';
beforeAll(() => h.start(), 120_000);
afterAll(() => h.stop());

it('late auto_align arrival uses the maximum, never earlier or stacked, and waits for replacement arrival', async () => {
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const f = await fixture(h.pool);
  const first = await replacement(h.pool, f);
  const second = await replacement(h.pool, f, f.shipment, 2);
  await openCase(h.pool, f);
  const alignment = createPostgresDeliveryAlignmentPort(executor(h.pool));
  const arrival = (id: string, at: string) => alignment.recordArrival({ requestKey: `arrival-${id}`, parcelRef: id, deliveredAt: at, evidenceRef: `evidence:${id}` });
  expect(await arrival(first, '2026-09-08T12:00:00Z')).toMatchObject({ disposition: 'outstanding' });
  expect((await schedule(h.pool, f.subscription)).next_cycle_at.toISOString()).toBe('2026-08-29T12:00:00.000Z');
  expect(await arrival(second, '2026-09-01T12:00:00Z')).toMatchObject({ disposition: 'aligned', nextCycleAt: '2026-10-06T12:00:00.000Z' });
  const before = await schedule(h.pool, f.subscription);
  expect(await arrival(second, '2026-09-01T12:00:00Z')).toMatchObject({ replayed: true });
  expect(await schedule(h.pool, f.subscription)).toEqual(before);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM public.subscription_cycles WHERE subscription_id=$1', [f.subscription])).rows).toEqual([{ n: 1 }]);
  // An already later schedule is the outer maximum, not another cadence increment.
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const later = await fixture(h.pool);
  await openCase(h.pool, later);
  await h.pool.query("UPDATE public.subscriptions SET next_cycle_at='2026-11-10T12:00:00Z' WHERE id=$1", [later.subscription]);
  expect(await arrival(later.shipment, '2026-09-08T12:00:00Z')).toMatchObject({ nextCycleAt: '2026-11-10T12:00:00.000Z' });
});

it('native dunning exhaustion keeps the subscription active with one cycle and no pause window, including replay', async () => {
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const f = await fixture(h.pool);
  const caseId = randomUUID();
  await h.pool.query(`INSERT INTO public.subscription_dunning_cases(id,subscription_id,cycle_id,client_id,retry_attempt,next_retry_at,idempotency_key)
    VALUES($1,$2,$3,$4,4,$5,$6)`, [caseId, f.subscription, f.cycle, f.client, now, `dunning-${caseId}`]);
  const before = await schedule(h.pool, f.subscription);
  const fail = () => h.pool.query('SELECT public.dunning_lifecycle_handle_failure($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [caseId, now, 'temporary', 'synthetic decline', 4, null, 'synthetic-notice', '/recovery']);
  const first = (await fail()).rows[0].result;
  expect(first).toMatchObject({ caseStatus: 'open', paused: false, pauseWindowId: null, terminal: true });
  expect((await fail()).rows[0].result).toEqual(first);
  expect(await schedule(h.pool, f.subscription)).toEqual(before);
  expect(before.status).toBe('active');
  expect((await h.pool.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1', [f.subscription])).rows).toEqual([]);
  expect((await h.pool.query('SELECT status,next_retry_at FROM public.subscription_dunning_cases WHERE id=$1', [caseId])).rows).toEqual([{ status: 'open', next_retry_at: null }]);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM public.subscription_cycles WHERE subscription_id=$1', [f.subscription])).rows).toEqual([{ n: 1 }]);
});

async function renewalFixture() {
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const f = await fixture(h.pool), skuId = randomUUID(), sku = `SKU-${skuId}`;
  await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')", [skuId, sku]);
  await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Fixture')", [skuId, sku]);
  await h.pool.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,stock_source_key,
    settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,2,'XXX','fixture','fixture',$2,'fixture')`, [f.subscription, '2026-08-01T12:00:00Z']);
  await h.pool.query('INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,900)', [f.subscription, sku]);
  await h.pool.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
    inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES('fixture',$1,10,10,0,'sellable',$2,'2027-01-01','fixture',$1,$3)`, [sku, now, 'a'.repeat(64)]);
  return f;
}
function runtime() {
  const queries: string[] = [];
  const sql = { async query(text: string, values?: unknown[]) { queries.push(text); return h.pool.query(text, values); } };
  const raw = createPostgresAutomaticRenewalPort(sql);
  const store = withDeliveryAlignmentRenewalAdmission(raw, sql, () => now);
  let executions = 0;
  const deps: AutomaticRenewalRunDeps = { store, inventory: createPostgresRenewalReservationPort(sql), settlement: createPostgresRenewalSettlementPort(sql),
    paymentRails: { resolve: () => ({ executionPort: { validateInput: () => {}, execute: async () => { executions++; throw new Error('synthetic indeterminate execution'); } },
      readOutcome: async () => ({ status: 'pending', occurredAt: null, reason: null, amountMinor: null, currency: null }) }) },
    failureHandoff: { handoffFailure: async () => { throw new Error('unexpected dunning'); } }, workerId: 'm10-p1-baseline', now: () => now };
  return { store, deps, executions: () => executions, admissions: () => queries.filter(sql => sql.includes('subscription_delivery_alignment_admit_renewal(')).length };
}

it('off with no captured case admits immediately without a delivery admission call or receipt', async () => {
  const f = await renewalFixture(), r = runtime();
  const due = (await r.store.listDue(1000, now)).find(row => row.subscriptionId === f.subscription)!;
  expect(due).toBeDefined();
  expect(await runOneAutomaticSubscriptionRenewal(r.deps, due, now)).toMatchObject({ status: 'awaiting_provider' });
  expect(r.executions()).toBe(1); expect(r.admissions()).toBe(0);
  for (const table of ['subscription_delivery_alignment_cases', 'subscription_delivery_alignment_admission_receipts']) {
    expect((await h.pool.query(`SELECT * FROM public.${table} WHERE subscription_id=$1`, [f.subscription])).rows).toEqual([]);
  }
});

it('captured auto_align protection survives off, preserves the obligation, then actual arrival admits the next due run on the later date', async () => {
  const f = await renewalFixture();
  await openCase(h.pool, f);
  const r = runtime();
  const due = (await r.store.listDue(1000, now)).find(row => row.subscriptionId === f.subscription)!;
  expect(due).toBeDefined();
  const deferred = await runOneAutomaticSubscriptionRenewal(r.deps, due, now);
  expect(deferred).toMatchObject({ status: 'deferred', reason: 'delivery_alignment_protected' });
  const before = await r.store.readRenewal(deferred.identityKey);
  expect(before).toMatchObject({ state: 'claimed', terminalOutcome: null, cycleId: null, orderId: null, settlementIntentId: null });
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const resumeAt = '2026-10-22T13:00:00.000Z';
  const offered = (await r.store.listDue(1000, resumeAt)).find(row => row.subscriptionId === f.subscription)!;
  expect(offered).toEqual(due);
  expect(await runOneAutomaticSubscriptionRenewal(r.deps, offered, resumeAt))
    .toMatchObject({ status: 'deferred', reason: 'delivery_alignment_protected', operationId: deferred.operationId, identityKey: deferred.identityKey });
  const protectedOperation = await r.store.readRenewal(deferred.identityKey);
  expect(protectedOperation).toMatchObject({ state: 'claimed', terminalOutcome: null, terminalAt: null, cycleId: null,
    operationFingerprint: before!.operationFingerprint, cycleSnapshot: before!.cycleSnapshot });
  expect(r.executions()).toBe(0); expect(r.admissions()).toBe(2);
  expect(await schedule(h.pool, f.subscription)).toEqual({ status: 'active', next_cycle_at: new Date('2026-08-29T12:00:00Z') });
  expect((await h.pool.query('SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1', [f.subscription])).rows).toEqual([{ state: 'protected' }]);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM public.subscription_cycles WHERE subscription_id=$1', [f.subscription])).rows).toEqual([{ n: 1 }]);

  const alignment = createPostgresDeliveryAlignmentPort(executor(h.pool));
  const arrival = { requestKey: `rollback-arrival-${f.shipment}`, parcelRef: f.shipment,
    deliveredAt: '2026-09-04T12:00:00Z', evidenceRef: `evidence:${f.shipment}` };
  expect(await alignment.recordArrival(arrival)).toMatchObject({ disposition: 'aligned', nextCycleAt: '2026-10-02T12:00:00.000Z' });
  const aligned = await schedule(h.pool, f.subscription);
  expect(aligned.next_cycle_at.getTime()).toBeGreaterThan(Date.parse(due.scheduledAt));
  expect(await alignment.recordArrival(arrival)).toMatchObject({ replayed: true });
  expect(await schedule(h.pool, f.subscription)).toEqual(aligned);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM public.subscription_cycles WHERE subscription_id=$1', [f.subscription])).rows).toEqual([{ n: 1 }]);
  const nextAt = '2026-10-22T14:00:00.000Z';
  const next = (await r.store.listDue(1000, nextAt)).find(row => row.subscriptionId === f.subscription)!;
  expect(new Date(next.scheduledAt).toISOString()).toBe('2026-10-02T12:00:00.000Z');
  expect(await runOneAutomaticSubscriptionRenewal(r.deps, next, nextAt)).toMatchObject({ status: 'awaiting_provider' });
  expect(r.executions()).toBe(1); expect(r.admissions()).toBe(2);
  expect(await schedule(h.pool, f.subscription)).toEqual(aligned);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM public.subscription_cycles WHERE subscription_id=$1', [f.subscription])).rows).toEqual([{ n: 2 }]);
  expect((await h.pool.query("SELECT * FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1 AND state IN ('protected','manual_review')", [f.subscription])).rows).toEqual([]);
});
