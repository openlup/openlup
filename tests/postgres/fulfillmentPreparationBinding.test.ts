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
  async function assertLocked() {
    expect((await h.pool.query("SELECT pg_try_advisory_xact_lock(hashtextextended('native-dispatch|' || $1::uuid::text,0)) AS acquired", [f.shipment])).rows[0].acquired).toBe(false);
    await expect(h.pool.query('SELECT id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE NOWAIT', [f.shipment])).rejects.toMatchObject({ code: '55P03' });
  }
  const readAuthoritative = vi.fn(async (db: Parameters<Parameters<typeof lane.run>[0]>[0]) => {
    await assertLocked();
    const { rows } = await (db as ReturnType<typeof executor>).query('SELECT metadata FROM public.fulfillment_shipments WHERE id=$1', [f.shipment]);
    const facts = rows[0].metadata as { revision: number; provider: string; withheld: boolean };
    return { candidate: { ...candidate, contactRevision: { ...candidate.contactRevision, revision: facts.revision, privateExtra: 'must-not-persist' },
      selection: { ...candidate.selection, providerRef: facts.provider } }, withheld: facts.withheld };
  });
  const list = vi.fn(async () => []), observe = vi.fn(async () => ({ ready: true as const }));
  const binding = createM08FulfillmentReferenceBinding({ enabled: true, transactions: lane, preparation: mode === 'bound' ? { readAuthoritative } : undefined,
    services: { selection: candidate.selection, capability: profile(), provider: { prepare: vi.fn(), dispatch: vi.fn() }, readiness: observe, listCandidates: list,
      config: { mode: 'live', batchLimit: 10 }, keys: { request: v => v.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) } },
    version: '0.21.0', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
  if (mode === 'unbound') {
    expect(await binding.services.readiness()).toEqual({ ready: false, refusal: FULFILLMENT_NATIVE_UNSUPPORTED });
    expect(await binding.services.runDispatch()).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
    expect(await binding.prepare(f.shipment)).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
    expect(readAuthoritative).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect((await h.pool.query('SELECT * FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [f.shipment])).rows).toEqual([]);
    expect((await h.pool.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1', [f.shipment])).rows).toEqual([]);
    return;
  }
  expect(await binding.prepare(f.shipment)).toEqual({ disposition: 'ready', contactRevision: 1 });
  const native = createPostgresFulfillmentDispatchStore(executor(h.pool), { prepare: async () => ({ disposition: 'ready', contactRevision: 1 }), readCandidate: async () => candidate });
  const evidence = { commandFingerprint: 'a'.repeat(64), contactRevision: candidate.contactRevision, providerRef: 'warehouse-a', carrierRef: 'carrier-a', serviceRef: 'service-a' };
  const claim = { requestKey: `prepare-${f.shipment}`, fulfillmentRef: f.shipment, orderRef: f.order, parcelRef: null, mode: 'live' as const, evidence };
  expect(await native.claim(claim)).toMatchObject({ kind: 'claimed' });
  const attribution = { fulfillmentRef: f.shipment, actorUserId: f.client, idempotencyKey: `edit-${f.shipment}` };
  expect(await binding.editAuthoritative(attribution, async (db, actor) => {
    expect(actor).toEqual(attribution); await assertLocked();
    await db.query('UPDATE public.fulfillment_shipments SET metadata=$2 WHERE id=$1', [actor.fulfillmentRef, { revision: 2, provider: 'warehouse-b', withheld: true }]);
  })).toEqual({ disposition: 'withheld', contactRevision: 2 });
  expect((await h.pool.query('SELECT contact_revision,provider_ref,withheld FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [f.shipment])).rows).toEqual([
    { contact_revision: { schemaVersion: 1, source: 'contact', revision: 2 }, provider_ref: 'warehouse-b', withheld: true },
  ]);
  expect(await native.claim(claim)).toMatchObject({ kind: 'refused', refusal: { reason: 'withheld' } });
  await expect(binding.editAuthoritative({ ...attribution, idempotencyKey: 'rollback' }, async db => {
    await db.query("UPDATE public.fulfillment_shipments SET metadata='{}' WHERE id=$1", [f.shipment]);
    throw new Error('synthetic edit rollback');
  })).rejects.toThrow('synthetic edit rollback');
  expect(await binding.prepare(f.shipment)).toEqual({ disposition: 'withheld', contactRevision: 2 });
  expect(readAuthoritative).toHaveBeenCalledTimes(3); expect(list).not.toHaveBeenCalled();
});
