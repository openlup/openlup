import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FULFILLMENT_NATIVE_UNSUPPORTED, createPostgresFulfillmentDispatchStore } from '@openlup/platform/fulfillment';
import { createM08FulfillmentReferenceBinding } from '../../server/runtime/public-reference/m08FulfillmentBinding.js';
import { createPostgresFulfillmentTransactionLane } from '../../server/adapters/postgres/dataGateway.js';
import { profile, request } from '../helpers/fulfillmentComposition.js';
import { executor, fixture, nativeHarness } from '../helpers/fulfillmentNative.js';

const h = nativeHarness('preparation');
beforeAll(() => h.start(), 120_000); afterAll(() => h.stop());
it.each(['bound', 'unbound'] as const)('G22 production preparation writer: %s', async mode => {
  const f = await fixture(h.pool), candidate = { ...request(), fulfillmentRef: f.shipment, orderRef: f.order };
  // Authoritative host facts live outside the dispatch context; no context seed is used.
  await h.pool.query('UPDATE public.fulfillment_shipments SET metadata=$2 WHERE id=$1', [f.shipment, { revision: 1, provider: 'warehouse-a', withheld: false }]);
  const lane = createPostgresFulfillmentTransactionLane({ connectionString: 'fixture-unused' }, { poolFactory: () => h.pool });
  let nativeKey: string;
  let preparationPid: number;
  let authoritativeTransaction: unknown;
  let beforeCommit: ((db: ReturnType<typeof executor>) => Promise<void>) | undefined;
  const transactions: typeof lane = { ...lane, run: work => lane.run(async db => {
    const connection = db as ReturnType<typeof executor>;
    preparationPid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const result = await work({ query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('INSERT INTO public.fulfillment_dispatch_contexts')) {
        // Reject a second transaction before its FK can wait on the locked source row.
        expect((await connection.query('SELECT txid_current()::text AS id')).rows[0].id).toBe(authoritativeTransaction);
      }
      return connection.query(sql, values);
    } });
    await beforeCommit?.(connection);
    return result;
  }) };
  const evidence = { commandFingerprint: 'a'.repeat(64), contactRevision: candidate.contactRevision, providerRef: 'warehouse-a', carrierRef: 'carrier-a', serviceRef: 'service-a' };
  const claim = { requestKey: `prepare-${f.shipment}`, fulfillmentRef: f.shipment, orderRef: f.order, parcelRef: null, mode: 'live' as const, evidence };
  const attribution = { fulfillmentRef: f.shipment, actorUserId: f.client, idempotencyKey: `edit-${f.shipment}` };
  async function assertLocked() {
    expect((await h.pool.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [nativeKey])).rows[0].acquired).toBe(false);
    await expect(h.pool.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE NOWAIT', [f.shipment])).rejects.toMatchObject({ code: '55P03' });
  }
  const readAuthoritative = vi.fn(async (db: Parameters<Parameters<typeof lane.run>[0]>[0]) => {
    await assertLocked();
    authoritativeTransaction = (await (db as ReturnType<typeof executor>).query('SELECT txid_current()::text AS id')).rows[0].id;
    const { rows } = await (db as ReturnType<typeof executor>).query('SELECT metadata FROM public.fulfillment_shipments WHERE id=$1', [f.shipment]);
    const facts = rows[0].metadata as { revision: number; provider: string; withheld: boolean };
    return { candidate: { ...candidate, contactRevision: { ...candidate.contactRevision, revision: facts.revision, privateExtra: 'must-not-persist' },
      selection: { ...candidate.selection, providerRef: facts.provider } }, withheld: facts.withheld };
  });
  const list = vi.fn(async () => []), observe = vi.fn(async () => ({ ready: true as const }));
  const binding = createM08FulfillmentReferenceBinding({ enabled: true, transactions, preparation: mode === 'bound' ? { readAuthoritative } : undefined,
    services: { selection: candidate.selection, capability: profile(), provider: { prepare: vi.fn(), dispatch: vi.fn() }, readiness: observe, listCandidates: list,
      config: { mode: 'live', batchLimit: 10 }, keys: { request: v => v.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) } },
    version: '0.21.0', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
  if (mode === 'unbound') {
    expect(await binding.services.readiness()).toEqual({ ready: false, refusal: FULFILLMENT_NATIVE_UNSUPPORTED });
    expect(await binding.services.runDispatch()).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
    expect(await binding.prepare(f.shipment)).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
    const apply = vi.fn(async (db: ReturnType<typeof executor>) => {
      await db.query("UPDATE public.fulfillment_shipments SET metadata='{}' WHERE id=$1", [f.shipment]);
    });
    expect(await binding.editAuthoritative(attribution, apply)).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
    expect(apply).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT metadata FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0].metadata).toEqual({ revision: 1, provider: 'warehouse-a', withheld: false });
    expect(readAuthoritative).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT * FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [f.shipment])).rows).toEqual([]);
    expect((await h.pool.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1', [f.shipment])).rows).toEqual([]);
    return;
  }
  const blocker = await h.pool.connect();
  let preparing: ReturnType<typeof binding.prepare> | undefined;
  try {
    await blocker.query('BEGIN');
    const nativeBlocker = createPostgresFulfillmentDispatchStore(executor(blocker), { prepare: vi.fn(), readCandidate: vi.fn() });
    await nativeBlocker.claim(claim);
    // Reuse the key actually acquired by the native claim; do not duplicate its derivation.
    nativeKey = (await blocker.query("SELECT ((classid::bigint << 32) | objid::bigint)::text AS key FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND objsubid=1")).rows[0].key;
    await blocker.query('ROLLBACK');
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [nativeKey]);
    preparing = binding.prepare(f.shipment);
    // Wait for an observed lock state, never an assumed scheduling delay.
    await expect.poll(async () => (await h.pool.query("SELECT ((classid::bigint << 32) | objid::bigint)::text AS key FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [preparationPid])).rows,
      { timeout: 5000 }).toEqual([{ key: nativeKey }]);
    expect((await h.pool.query("SELECT mode FROM pg_locks WHERE pid=$1 AND relation='public.fulfillment_shipments'::regclass AND mode='RowShareLock'", [preparationPid])).rows).toEqual([]);
    // Uncontested tuple locks need not appear in pg_locks: probe this exact row too.
    await h.pool.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE NOWAIT', [f.shipment]);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    if (preparing) expect(await preparing).toEqual({ disposition: 'ready', contactRevision: 1 });
  }
  const native = createPostgresFulfillmentDispatchStore(executor(h.pool), { prepare: async () => ({ disposition: 'ready', contactRevision: 1 }), readCandidate: async () => candidate });
  expect(await native.claim(claim)).toMatchObject({ kind: 'claimed' });
  expect(await binding.editAuthoritative(attribution, async (db, actor) => {
    expect(actor).toEqual(attribution); await assertLocked();
    await db.query('UPDATE public.fulfillment_shipments SET metadata=$2 WHERE id=$1', [actor.fulfillmentRef, { revision: 2, provider: 'warehouse-b', withheld: true }]);
  })).toEqual({ disposition: 'withheld', contactRevision: 2 });
  expect((await h.pool.query('SELECT contact_revision,provider_ref,withheld FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [f.shipment])).rows).toEqual([
    { contact_revision: { schemaVersion: 1, source: 'contact', revision: 2 }, provider_ref: 'warehouse-b', withheld: true },
  ]);
  expect(await native.claim(claim)).toMatchObject({ kind: 'refused', refusal: { reason: 'withheld' } });
  const source = 'SELECT metadata FROM public.fulfillment_shipments WHERE id=$1';
  const context = 'SELECT contact_revision,provider_ref,withheld FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1';
  const previousSource = (await h.pool.query(source, [f.shipment])).rows;
  const previousContext = (await h.pool.query(context, [f.shipment])).rows;
  beforeCommit = async db => {
    // Both new facts must be in this transaction, and neither may yet be externally visible.
    expect((await db.query(source, [f.shipment])).rows).toEqual([{ metadata: { revision: 3, provider: 'warehouse-c', withheld: false } }]);
    expect((await db.query(context, [f.shipment])).rows).toEqual([
      { contact_revision: { schemaVersion: 1, source: 'contact', revision: 3 }, provider_ref: 'warehouse-c', withheld: false },
    ]);
    expect((await h.pool.query(source, [f.shipment])).rows).toEqual(previousSource);
    expect((await h.pool.query(context, [f.shipment])).rows).toEqual(previousContext);
    throw new Error('synthetic pre-commit rollback');
  };
  try {
    await expect(binding.editAuthoritative({ ...attribution, idempotencyKey: 'rollback' }, async db => {
      await db.query('UPDATE public.fulfillment_shipments SET metadata=$2 WHERE id=$1', [f.shipment, { revision: 3, provider: 'warehouse-c', withheld: false }]);
    })).rejects.toThrow('synthetic pre-commit rollback');
  } finally { beforeCommit = undefined; }
  expect((await h.pool.query(source, [f.shipment])).rows).toEqual(previousSource);
  expect((await h.pool.query(context, [f.shipment])).rows).toEqual(previousContext);
  expect(await binding.prepare(f.shipment)).toEqual({ disposition: 'withheld', contactRevision: 2 });
  expect(readAuthoritative).toHaveBeenCalledTimes(4); expect(list).not.toHaveBeenCalled();
});
