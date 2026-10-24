import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PaymentExecutionInput } from '../../src/domains/payment/types.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createPostgresDeliveryAlignmentPort } from '@openlup/platform/fulfillment';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import { createPostgresAutomaticRenewalPort } from '../../server/adapters/postgres/subscription/automaticRenewal.js';
import { createPostgresRenewalSettlementPort } from '../../server/adapters/postgres/commerce/renewalSettlement.js';
import { runAutomaticSubscriptionRenewals, runOneAutomaticSubscriptionRenewal, type AutomaticRenewalRunDeps } from '../../server/domains/subscription/runAutomaticSubscriptionRenewal.js';
import type { AutomaticRenewalPreparedSettlement, AutomaticRenewalReadback } from '../../server/domains/subscription/automaticRenewalPorts.js';
import { withDeliveryAlignmentRenewalAdmission } from '../../server/runtime/subscription/deliveryAlignmentRenewalStore.js';
import { executor, fixture, nativeHarness, openCase, schedule } from '../helpers/fulfillmentNative.js';

const h = nativeHarness('g23');
const NOW = '2026-10-21T12:00:00.000Z';
const AT = '2026-08-29T12:00:00.000Z';
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);

async function seed() {
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const f = await fixture(h.pool);
  const skuId = randomUUID(), sku = `SKU-${skuId}`;
  await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Fixture')", [skuId, sku]);
  await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Fixture')", [skuId, sku]);
  await h.pool.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,stock_source_key,
    settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES($1,2,'XXX','fixture','fixture',$2,'fixture')`, [f.subscription, AT]);
  await h.pool.query('INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,$2,1,900)', [f.subscription, sku]);
  await h.pool.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,
    inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES('fixture',$1,10,10,0,'sellable',$2,'2027-01-01','fixture',$1,$3)`, [sku, NOW, 'a'.repeat(64)]);
  return f;
}
function runtime(db: PoolClient, wrapped = true) {
  const queries: string[] = [];
  const sql = { async query(text: string, values?: unknown[]) { queries.push(text); return db.query(text, values); } };
  const store = createPostgresAutomaticRenewalPort(sql);
  const claimOverride: { current?: AutomaticRenewalReadback } = {};
  const claimDue = store.claimDue;
  store.claimDue = async input => claimOverride.current ?? claimDue(input);
  const settlement = createPostgresRenewalSettlementPort(sql);
  const prepared: AutomaticRenewalPreparedSettlement[] = [];
  const execute = vi.fn(async (_input: PaymentExecutionInput) => { throw new Error('synthetic indeterminate execution'); });
  const deps: AutomaticRenewalRunDeps = {
    store: wrapped ? withDeliveryAlignmentRenewalAdmission(store, sql, () => NOW) : store,
    inventory: createPostgresRenewalReservationPort(sql),
    settlement: { ...settlement, async prepareRenewal(input) { const result = await settlement.prepareRenewal(input); prepared.push(result); return result; } },
    paymentRails: { resolve: () => ({ executionPort: { execute }, readOutcome: async () => ({ status: 'pending', occurredAt: null, reason: null, amountMinor: 900, currency: 'XXX' }) }) },
    failureHandoff: { handoffFailure: async () => { throw new Error('unexpected dunning handoff'); } },
    workerId: 'g23-fixture', now: () => NOW,
  };
  return { deps, store, queries, execute, prepared, sql, claimOverride };
}
const admissions = (queries: string[]) => queries.filter(sql => sql.includes('subscription_delivery_alignment_admit_renewal('));
async function alignmentRows(db: PoolClient) {
  const rows: Record<string, unknown>[][] = [];
  for (const table of ['subscription_delivery_alignment_cases', 'subscription_delivery_alignment_admission_receipts', 'commerce_order_holds', 'outbox_events']) {
    rows.push((await db.query(`SELECT * FROM public.${table} ORDER BY id`)).rows);
  }
  return rows;
}
type DatabaseRows = Record<string, Record<string, unknown>[]>;
async function databaseRows(db: PoolClient): Promise<DatabaseRows> {
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  const snapshot: DatabaseRows = {};
  for (const { tablename } of tables.rows) {
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    snapshot[tablename] = (await db.query(`SELECT to_jsonb(row) AS value FROM public.${quoted} row`)).rows.map(row => row.value);
  }
  return snapshot;
}
function expectBytes(actual: unknown, expected: unknown) {
  expect(Buffer.from(JSON.stringify(actual))).toEqual(Buffer.from(JSON.stringify(expected)));
}
// Inspect keys in every persisted column, including nested metadata and receipts.
// Keys are compared literally: no UUID replacement, suffix stripping or constructor oracle.
function persistedKeys(snapshot: DatabaseRows) {
  const keys: string[] = [];
  function visit(value: unknown, path: string) {
    if (!value || typeof value !== 'object') return;
    for (const [column, item] of Object.entries(value)) {
      const name = `${path}.${column}`;
      if (/identity.?key|fingerprint|idempotency|receipt.?key|event.?key/i.test(column)) {
        keys.push(`${name}=${JSON.stringify(item)}`);
      }
      visit(item, name);
    }
  }
  for (const [table, rows] of Object.entries(snapshot)) for (const row of rows) visit(row, table);
  return keys.sort();
}
function expectRenewalColumnParity(before: DatabaseRows, legacy: DatabaseRows, wrapped: DatabaseRows) {
  // Only these freshly inserted UUID primary keys may vary. Map FK values only
  // when they reference the very same paired surrogate; unrelated UUIDs stay exact.
  const surrogateTables = ['commerce_order_items', 'commerce_orders', 'commerce_settlement_transitions',
    'fulfillment_inventory_reservations', 'subscription_cycles'];
  const references: Record<string, Record<string, string>> = {
    commerce_order_items: { id: 'commerce_order_items', order_id: 'commerce_orders' },
    commerce_orders: { id: 'commerce_orders', subscription_cycle_id: 'subscription_cycles' },
    commerce_settlement_intents: { order_id: 'commerce_orders' },
    commerce_settlement_transitions: { id: 'commerce_settlement_transitions' },
    fulfillment_inventory_reservation_lines: { reservation_id: 'fulfillment_inventory_reservations' },
    fulfillment_inventory_reservations: { id: 'fulfillment_inventory_reservations' },
    subscription_cycles: { id: 'subscription_cycles' },
  };
  const pairs = new Map<string, { legacy: unknown; wrapped: unknown }>();
  for (const table of surrogateTables) {
    const oldIds = new Set(before[table].map(row => row.id));
    const left = legacy[table].filter(row => !oldIds.has(row.id));
    const right = wrapped[table].filter(row => !oldIds.has(row.id));
    expect(left, `${table} legacy new row`).toHaveLength(1);
    expect(right, `${table} wrapped new row`).toHaveLength(1);
    for (const row of [left[0], right[0]]) expect(row.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    pairs.set(table, { legacy: left[0].id, wrapped: right[0].id });
  }
  function normalize(table: string, column: string, value: unknown, side: 'legacy' | 'wrapped') {
    const target = references[table]?.[column], pair = pairs.get(target);
    return pair && value === pair[side] ? `surrogate:${target}` : value;
  }
  function sorted(table: string, rows: DatabaseRows[string], side: 'legacy' | 'wrapped') {
    const key = (row: Record<string, unknown>) => JSON.stringify(Object.entries(row)
      .filter(([column]) => column !== 'created_at' && column !== 'updated_at')
      .map(([column, value]) => [column, normalize(table, column, value, side)]));
    return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  }
  expect(Object.keys(wrapped)).toEqual(Object.keys(legacy));
  const differingColumns = new Set<string>();
  const writtenTables: string[] = [];
  for (const table of Object.keys(legacy)) {
    const left = sorted(table, legacy[table], 'legacy'), right = sorted(table, wrapped[table], 'wrapped');
    expect(right, `${table} row count`).toHaveLength(left.length);
    if (JSON.stringify(legacy[table]) !== JSON.stringify(before[table])) writtenTables.push(table);
    for (let index = 0; index < left.length; index++) {
      expect(Object.keys(right[index]), `${table} columns`).toEqual(Object.keys(left[index]));
      for (const column of Object.keys(left[index])) {
        const a = left[index][column], b = right[index][column];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        differingColumns.add(`${table}.${column}`);
        if (column === 'created_at' || column === 'updated_at') continue;
        expectBytes({ column: `${table}.${column}`, value: normalize(table, column, b, 'wrapped') },
          { column: `${table}.${column}`, value: normalize(table, column, a, 'legacy') });
      }
    }
  }
  expect(writtenTables).toEqual(['commerce_order_items', 'commerce_orders', 'commerce_settlement_intents',
    'commerce_settlement_transitions', 'fulfillment_inventory_reservation_lines',
    'fulfillment_inventory_reservations', 'subscription_cycles', 'subscription_renewal_operations']);
  console.log('G23 off/no-case column differences:', [...differingColumns].sort().join(', '));
}
async function arrival(shipment: string) {
  return createPostgresDeliveryAlignmentPort(executor(h.pool)).recordArrival({
    requestKey: `g23-arrival-${shipment}`, parcelRef: shipment, deliveredAt: '2026-09-04T12:00:00.000Z', evidenceRef: `evidence:${shipment}`,
  });
}

it.each(['off', 'protect', 'auto_align'] as const)('G23 new-cycle admission at %s preserves inert bytes or enforces before insert and consumes once', async mode => {
  const f = await seed();
  await h.pool.query('SELECT public.subscription_delivery_alignment_set_mode($1)', [mode]);
  const db = await h.pool.connect();
  try {
    await db.query('BEGIN');
    const r = runtime(db);
    const due = (await r.store.listDue(100, NOW)).find(row => row.subscriptionId === f.subscription)!;
    expect(due).toBeDefined();
    // Keep the operation identity fixed across the legacy/wrapped savepoint comparison.
    const snapshot = await r.store.buildCycleSnapshots(due);
    const claim = await r.store.claimDue({ snapshot, workerId: 'fixture', now: mode === 'off' ? NOW : AT });
    if (mode === 'off') {
      // The provider key embeds the settlement UUID. Pin this fixture default so
      // actual key bytes can be compared without normalizing any part of a key.
      await db.query("ALTER TABLE public.commerce_settlement_intents ALTER COLUMN id SET DEFAULT '00000000-0000-4000-8000-000000000023'::uuid");
      // Reuse the real, active claim in both runs; lease-token randomness is not
      // a surrogate PK and must not become an allowed column difference.
      r.claimOverride.current = claim;
    }
    if (mode !== 'off') {
      // Denial persistence and lease recovery are exercised below without savepoints.
      await createPostgresDeliveryAlignmentPort(executor(db)).recordArrival({ requestKey: `delivered-${f.shipment}`, parcelRef: f.shipment,
        deliveredAt: '2026-09-04T12:00:00Z', evidenceRef: `evidence:${f.shipment}` });
    }
    await db.query('SAVEPOINT legacy');
    const legacy = runtime(db, false);
    let baseline: Awaited<ReturnType<typeof runOneAutomaticSubscriptionRenewal>> | undefined;
    let legacyRows: DatabaseRows = {}, beforeRows: DatabaseRows = {};
    let legacyOperation: Awaited<ReturnType<typeof legacy.store.readRenewal>> = null;
    if (mode === 'off') {
      legacy.claimOverride.current = claim;
      beforeRows = await databaseRows(db);
      baseline = await runOneAutomaticSubscriptionRenewal(legacy.deps, due, NOW);
      legacyOperation = await legacy.store.readRenewal(claim.identityKey);
      legacyRows = await databaseRows(db);
      expect(await alignmentRows(db)).toEqual([[], [], [], []]);
    }
    await db.query('ROLLBACK TO SAVEPOINT legacy');
    const before = await alignmentRows(db);
    const result = await runOneAutomaticSubscriptionRenewal(r.deps, due, NOW);
    expect(result).toMatchObject({ status: 'awaiting_provider', operationId: claim.operationId, reason: 'provider_execution_indeterminate' });
    const operation = await r.store.readRenewal(claim.identityKey);
    expect(operation?.state).toBe('attempt_prepared');
    expect(r.execute).toHaveBeenCalledTimes(1);
    if (mode === 'off') {
      expect(before).toEqual([[], [], [], []]);
      expect(admissions(r.queries)).toHaveLength(0);
      expect(admissions(legacy.queries)).toHaveLength(0);
      expectBytes(result, baseline);
      expect(await alignmentRows(db)).toEqual(before);
      expectBytes(operation?.identityKey, legacyOperation?.identityKey);
      expectBytes(operation?.operationFingerprint, legacyOperation?.operationFingerprint);
      expect(legacy.execute).toHaveBeenCalledTimes(1);
      const execution = r.execute.mock.calls[0][0], baselineExecution = legacy.execute.mock.calls[0][0];
      expectBytes(execution.idempotencyKey, baselineExecution.idempotencyKey);
      expectBytes(execution.providerIdempotencyKey, baselineExecution.providerIdempotencyKey);
      expectBytes(execution.providerRequestFingerprint, baselineExecution.providerRequestFingerprint);
      const wrappedRows = await databaseRows(db);
      expectBytes(persistedKeys(wrappedRows), persistedKeys(legacyRows));
      expectRenewalColumnParity(beforeRows, legacyRows, wrappedRows);
    } else {
      expect(admissions(r.queries)).toHaveLength(1);
      const admitIndex = r.queries.findIndex(sql => sql.includes('subscription_delivery_alignment_admit_renewal('));
      expect(admitIndex).toBeLessThan(r.queries.findIndex(sql => sql.includes('commerce_prepare_subscription_renewal(')));
      const receipt = (await db.query('SELECT * FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id=$1', [f.subscription])).rows;
      expect(receipt).toHaveLength(1);
      expect(receipt[0]).toMatchObject({ scheduled_at: new Date(AT), observed_next_cycle_at: new Date(AT) });
      expect(receipt[0].consumed_at).not.toBeNull();
      await db.query('SAVEPOINT consumed');
      await expect(db.query("INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status) VALUES($1,$2,'payment_pending')", [f.subscription, AT])).rejects.toThrow('admission_required');
      // Recover from the deliberate one-use refusal before inspecting replay.
      await db.query('ROLLBACK TO SAVEPOINT consumed');
    }
    r.claimOverride.current = undefined;
    // Prepared replay and the existing-cycle/dunning hook never mint or consume another receipt.
    await db.query("UPDATE public.subscription_renewal_operations SET claimed_at=$2::timestamptz-interval '1 minute',lease_expires_at=$2 WHERE id=$1", [claim.operationId, AT]);
    const replayRows = await alignmentRows(db), count = admissions(r.queries).length;
    await runOneAutomaticSubscriptionRenewal(r.deps, due, NOW);
    await db.query('INSERT INTO public.subscription_dunning_cases(subscription_id,cycle_id,client_id,idempotency_key) SELECT $1,id,$2,$3 FROM public.subscription_cycles WHERE renewal_operation_id=$4', [f.subscription, f.client, `g23-dunning-${f.subscription}`, claim.operationId]);
    expect(await r.deps.store.admitDeliveryAlignment(due)).toEqual({ allowed: true, reason: null });
    expect(admissions(r.queries)).toHaveLength(count);
    expect(await alignmentRows(db)).toEqual(replayRows);
    await db.query('ROLLBACK');
  } finally { await db.query('ROLLBACK'); db.release(); }
});

it('G23 auto_align to off retains protection, refuses insertion, then arrival extends once and unblocks the new schedule', async () => {
  const f = await seed();
  await openCase(h.pool, f);
  await h.pool.query("SELECT public.subscription_delivery_alignment_set_mode('off')");
  const db = await h.pool.connect();
  try {
    const r = runtime(db);
    const due = (await r.store.listDue(100, NOW)).find(row => row.subscriptionId === f.subscription)!;
    expect(await runOneAutomaticSubscriptionRenewal(r.deps, due, NOW)).toMatchObject({ status: 'deferred', reason: 'delivery_alignment_protected' });
    expect(admissions(r.queries)).toHaveLength(1);
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.prepared).toHaveLength(0);
    expect((await db.query('SELECT * FROM public.subscription_cycles WHERE subscription_id=$1 AND scheduled_at=$2', [f.subscription, AT])).rows).toEqual([]);
    expect(await schedule(h.pool, f.subscription)).toMatchObject({ status: 'active', next_cycle_at: new Date(AT) });
    expect(await arrival(f.shipment)).toMatchObject({ disposition: 'aligned', nextCycleAt: '2026-10-02T12:00:00.000Z' });
    await arrival(f.shipment);
    const next = (await r.store.listDue(100, NOW)).find(row => row.subscriptionId === f.subscription)!;
    expect(next.scheduledAt).not.toBe(AT);
    expect(await runOneAutomaticSubscriptionRenewal(r.deps, next, NOW)).toMatchObject({ status: 'awaiting_provider' });
    expect(admissions(r.queries)).toHaveLength(1); // settled case + off: no further RPC
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(await schedule(h.pool, f.subscription)).toMatchObject({ next_cycle_at: new Date('2026-10-02T12:00:00Z') });
  } finally { db.release(); }
});


it.each([
  { name: 'protect', mode: 'protect', manual: false, deliveredAt: '2026-09-04T12:00:00Z', state: 'released' },
  { name: 'manual_review-resolution', mode: 'protect', manual: true, deliveredAt: '2026-09-04T12:00:00Z', state: 'released' },
  { name: 'auto_align-no-extension', mode: 'auto_align', manual: false, deliveredAt: '2026-08-01T12:00:00Z', state: 'aligned' },
])('G23 $name persists denial and retries the SAME schedule only after lease expiry', async row => {
  const f = await seed();
  const captured = await openCase(h.pool, f, row.mode);
  if (row.manual) {
    // Seed an operator-review case; resolution still uses the real outstanding-parcel guard.
    await h.pool.query("UPDATE public.subscription_delivery_alignment_cases SET state='manual_review',manual_review_reason='fixture_operator_review' WHERE id=$1", [captured.id]);
  }
  const db = await h.pool.connect();
  try {
    const r = runtime(db);
    const query = vi.spyOn(r.sql, 'query');
    const occurredAt = '2026-10-21T11:59:00.000Z'; // Deliberately differs from the decorator's fallback clock.
    const due = (await r.store.listDue(100, occurredAt)).find(item => item.subscriptionId === f.subscription)!;
    expect(due).toBeDefined();
    // Keep the batch on this fixture while retaining the real due-list query.
    vi.spyOn(r.deps.store, 'listDue').mockImplementation(async (limit, asOf) =>
      (await r.store.listDue(limit, asOf)).filter(item => item.subscriptionId === f.subscription));
    // Autocommit throughout: neither the denial nor its operation/case is rolled back.
    const result = (await runAutomaticSubscriptionRenewals({ ...r.deps, now: () => occurredAt }))
      .find(item => item.subscriptionId === f.subscription)!;
    expect.soft(result).toMatchObject({ status: 'deferred', reason: row.manual ? 'delivery_alignment_manual_review' : 'delivery_alignment_protected' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('subscription_delivery_alignment_admit_renewal('),
      [f.subscription, due.scheduledAt, occurredAt]);
    const operation = await r.store.readRenewal(result.identityKey);
    expect.soft(operation).toMatchObject({ state: 'claimed', terminalOutcome: null, terminalAt: null,
      reservationId: null, cycleId: null, orderId: null, settlementIntentId: null });
    expect.soft(r.queries.some(sql => sql.includes('subscription_refuse_renewal_preflight('))).toBe(false);
    expect((await db.query('SELECT * FROM public.subscription_cycles WHERE renewal_operation_id=$1', [result.operationId])).rows).toEqual([]);
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.prepared).toHaveLength(0);
    const alignment = createPostgresDeliveryAlignmentPort(executor(db));
    await alignment.recordArrival({ requestKey: `same-schedule-${f.shipment}`, parcelRef: f.shipment,
      deliveredAt: row.deliveredAt, evidenceRef: `evidence:${f.shipment}` });
    if (row.manual) {
      expect((await db.query('SELECT state FROM public.subscription_delivery_alignment_cases WHERE id=$1', [captured.id])).rows).toEqual([{ state: 'manual_review' }]);
      await db.query("SELECT public.subscription_delivery_alignment_resolve_case($1,'operator_confirmed','Arrival verified')", [captured.id]);
    }
    expect((await db.query('SELECT state FROM public.subscription_delivery_alignment_cases WHERE id=$1', [captured.id])).rows).toEqual([{ state: row.state }]);
    expect(await schedule(h.pool, f.subscription)).toMatchObject({ next_cycle_at: new Date(AT) });
    const expiresAt = operation!.leaseExpiresAt;
    const beforeExpiry = new Date(new Date(expiresAt).getTime() - 1).toISOString();
    const afterExpiry = new Date(new Date(expiresAt).getTime() + 1).toISOString();
    expect((await r.store.listDue(100, beforeExpiry)).some(item => item.subscriptionId === f.subscription)).toBe(false);
    const offered = (await r.store.listDue(100, afterExpiry)).find(item => item.subscriptionId === f.subscription);
    expect(offered, 'same schedule must be re-offered after lease expiry').toBeDefined();
    expect(new Date(offered!.scheduledAt).toISOString()).toBe(AT);
    expect(await runOneAutomaticSubscriptionRenewal(r.deps, offered!, afterExpiry))
      .toMatchObject({ status: 'awaiting_provider', operationId: result.operationId });
    expect(await r.store.readRenewal(result.identityKey)).toMatchObject({ state: 'attempt_prepared',
      claimGeneration: operation!.claimGeneration + 1, terminalOutcome: null });
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(r.prepared).toHaveLength(1);
  } finally { db.release(); }
});

it.each(['protect', 'auto_align'] as const)('G23 static block wins over a captured case in %s without native admission', async mode => {
  const f = await seed();
  await openCase(h.pool, f, mode);
  // Use the dynamic denial's own reason to prove discrimination is not string matching.
  await h.pool.query("UPDATE public.subscription_renewal_terms SET delivery_admission='blocked',delivery_block_reason='delivery_alignment_protected' WHERE subscription_id=$1", [f.subscription]);
  const db = await h.pool.connect();
  try {
    const r = runtime(db);
    const before = await alignmentRows(db);
    const due = (await r.store.listDue(100, NOW)).find(item => item.subscriptionId === f.subscription)!;
    const result = await runOneAutomaticSubscriptionRenewal(r.deps, due, NOW);
    expect(result).toMatchObject({ status: 'refused', reason: 'delivery_alignment_protected' });
    expect(await r.store.readRenewal(result.identityKey)).toMatchObject({ state: 'refused', terminalOutcome: 'refused',
      terminalReason: 'delivery_alignment_protected', terminalAt: NOW });
    expect(admissions(r.queries)).toHaveLength(0);
    expect(await alignmentRows(db)).toEqual(before);
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.prepared).toHaveLength(0);
    const afterExpiry = new Date(new Date(NOW).getTime() + 3600_000).toISOString();
    expect((await r.store.listDue(100, afterExpiry)).some(item => item.subscriptionId === f.subscription)).toBe(false);
    expect(await runOneAutomaticSubscriptionRenewal(r.deps, due, afterExpiry)).toMatchObject({ status: 'terminal_replay' });
  } finally { db.release(); }
});
