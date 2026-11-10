import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNativeFulfillmentBinding } from '@openlup/platform/fulfillment/native';
import { createFulfillmentParcelContactPrivacyContributor } from '@openlup/platform/identity';
import type { FulfillmentDispatchRequest, FulfillmentCapabilityDescriptor } from '@openlup/platform/fulfillment/contracts';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createPostgresFulfillmentDispatchStore } from '@openlup/platform/fulfillment';
import { lifecycleInstallation, lifecycleProfiles, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { fixture } from '../helpers/fulfillmentNative.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
import { captureStoreJourney, storeJourneyResources, journeySelection } from '../helpers/storeJourney.js';
import { restoreConnectedNativeStore } from '../../server/adapters/postgres/connectedStoreRestore.js';

function request(): FulfillmentDispatchRequest {
  return { requestKey: 'parcel-prepare-fixture', fulfillmentRef: 'unbound', orderRef: 'unbound', orderNumber: null, parcelRef: null,
    contactRevision: { schemaVersion: 1, source: 'contact', revision: 1 },
    recipient: { name: 'Retained recipient', email: 'parcel@example.test', phone: '+000001', line1: 'Synthetic 1', line2: null,
      city: 'Example', postalCode: '00000', country: 'ZZ', deliveryInstructions: null, courierInstructions: null },
    lines: [{ skuRef: 'ITEM-A', title: null, quantity: 1, productRef: null, packRef: null }],
    selection: { providerRef: 'warehouse-a', carrierRef: 'carrier-a', serviceRef: 'service-a', deliveryKind: 'courier', pickupPoint: null } };
}
function frozen() {
  return { schemaVersion: 1, source: 'contact', revision: 1, recipientName: 'Retained recipient', contactEmail: 'parcel@example.test',
    contactPhone: '+000001', line1: 'Synthetic 1', line2: null, city: 'Example', postalCode: '00000', country: 'ZZ',
    deliveryInstructions: null, courierInstructions: null,
    selectedDelivery: { providerKind: 'warehouse-a', carrierKind: 'carrier-a', service: 'service-a', deliveryKind: 'courier' } };
}
function profile(): FulfillmentCapabilityDescriptor {
  const operations = Object.fromEntries(['dispatch','readback','exactAbsence','verifyObservation','syncStock','syncProducts','labelCreate','labelRead','labelVoid','cancel','pickupPoint','courierPickup']
    .map(key => [key, { supported: false, reason: 'not_exposed' }])) as FulfillmentCapabilityDescriptor['operations'];
  return { providerRef: 'warehouse-a', role: 'warehouse', defaultOff: true, selected: true, readiness: { ready: true }, operations: { ...operations, dispatch: { supported: true } },
    authentication: 'token', freshness: 'not_available', ownsDeliveredNotification: true,
    stockAuthority: 'external_stock_master_with_local_reservations', labelReadOwner: 'none',
    actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: false, mutationSurface: 'provider_adapter' } };
}

for (const generation of lifecycleProfiles) describe(`private parcel contact on ${generation}`, () => {
  let h: LifecycleInstallation;
  beforeAll(async () => { h = await lifecycleInstallation(generation); }, postgresSetupTimeoutMs);
  afterAll(async () => { await h?.close(); }, postgresTeardownTimeoutMs);
  async function subject() {
    const f = await fixture(h.owner, null);
    const candidate = { ...request(), fulfillmentRef: f.shipment, orderRef: f.order };
    candidate.recipient = { ...candidate.recipient, name: 'Retained recipient', email: 'parcel@example.test', phone: '+000001' };
    await createPostgresDestinationPort(h.runtime).registerOrder({ idempotencyKey: `destination-${randomUUID()}`,
      orderId: f.order, address: { recipientName: candidate.recipient.name!, line1: candidate.recipient.line1,
        city: candidate.recipient.city, postalCode: candidate.recipient.postalCode, country: 'ZZ', contactPhone: candidate.recipient.phone! }, now: '2026-11-01T00:00:00Z' });
    const binding = createNativeFulfillmentBinding({ enabled: true,
      transactions: { async run(work) { const db = await h.runtime.connect();
        try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
        catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); } }, async close() {} },
      preparation: { async readAuthoritative() { return { candidate, withheld: false }; } },
      services: { selection: candidate.selection, capability: profile(), readiness: async () => ({ ready: true }), listCandidates: async () => [],
        provider: { async prepare() { throw new Error('No dispatch selected'); }, async dispatch() { throw new Error('No dispatch selected'); } },
        keys: { request: value => value.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) },
        config: { mode: 'live', batchLimit: 1 } }, version: 'fixture', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
    const rows = async () => (await h.owner.query('SELECT contact,captured_at,erased_at FROM public.fulfillment_parcel_contacts WHERE shipment_id=$1', [f.shipment])).rows;
    const resolve = async () => (await h.migration.query('SELECT public.fulfillment_resolve_parcel_contact($1) AS value', [f.shipment])).rows[0].value;
    return { ...f, candidate, binding, rows, resolve };
  }
  it('captures during real preparation, replays concurrently and keeps private payload out of public results and dispatch evidence', async () => {
    const f = await subject();
    expect(await f.rows()).toEqual([]);
    const results = await Promise.all([f.binding.prepare(f.shipment), f.binding.prepare(f.shipment)]);
    for (const result of results) expect(result).toEqual({ disposition: 'ready', contactRevision: 1 });
    const before = await f.rows(); expect(before).toHaveLength(1);
    expect(before[0].contact).toEqual(frozen());
    await f.binding.prepare(f.shipment); expect(await f.rows()).toEqual(before);
    const context = (await h.owner.query('SELECT to_jsonb(c) AS value FROM public.fulfillment_dispatch_contexts c WHERE shipment_id=$1', [f.shipment])).rows[0].value;
    const publicParcel = (await h.owner.query('SELECT public.fulfillment_shipment_response(s,\'read\',false) AS value FROM public.fulfillment_shipments s WHERE id=$1', [f.shipment])).rows[0].value;
    const store = createPostgresFulfillmentDispatchStore(h.runtime, { async prepare() { return { disposition: 'ready', contactRevision: 1 }; }, async readCandidate() { return null; } });
    expect(await store.read(`absent-${f.shipment}`)).toBeNull();
    const visible = JSON.stringify({ results, context, publicParcel });
    for (const secret of ['parcel@example.test', '+000001', 'Retained recipient', 'contactEmail', 'selectedDelivery']) expect(visible).not.toContain(secret);
    if (generation !== 'legacy') {
      await expect(h.runtime.query('SELECT contact FROM public.fulfillment_parcel_contacts')).rejects.toMatchObject({ code: '42501' });
      await expect(h.runtime.query('SELECT public.fulfillment_resolve_parcel_contact($1)', [f.shipment])).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('minimizes host input, preserves frozen values after defaults change and permits pre-submission correction', async () => {
    const f = await subject();
    const input = { ...frozen(), credentials: 'never-store', selectedDelivery: {
      providerKind: 'warehouse-a', pickupPoint: { id: 'POINT', name: 'Point', token: 'never-store', address: { line1: 'Point street', city: 'Point city', postalCode: '00000', country: 'ZZ', password: 'never-store' } } } };
    await h.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [f.shipment, input]);
    expect(JSON.stringify(await f.rows())).not.toContain('never-store');
    const retained = await f.resolve();
    await h.owner.query("UPDATE public.clients SET email='changed@example.test',phone='+99999',first_name='Changed' WHERE id=$1", [f.client]);
    expect(await f.resolve()).toEqual(retained);
    f.candidate.recipient.name = 'Corrected before submission'; f.candidate.contactRevision.revision = 2;
    await f.binding.prepare(f.shipment);
    expect((await f.rows())[0].contact).toMatchObject({ recipientName: 'Corrected before submission', revision: 2 });
  });
  it('exports through the privacy contributor and erases without resurrecting through preparation or legacy inference', async () => {
    const f = await subject(); await f.binding.prepare(f.shipment);
    const contributor = createFulfillmentParcelContactPrivacyContributor();
    const privacySubject = { contactId: f.client, principalId: null, identity: {} };
    const before = await contributor.export(h.runtime, privacySubject);
    expect(JSON.stringify(before.data)).toContain('parcel@example.test');
    const assessment = await contributor.assessErasure(h.runtime, privacySubject);
    await contributor.eraseOrRetain(h.runtime, privacySubject, assessment, { principalId: randomUUID() });
    const erased = await f.rows(); expect(erased[0].contact).toEqual({}); expect(erased[0].erased_at).not.toBeNull();
    const exported = await contributor.export(h.runtime, privacySubject);
    expect(exported.data).toMatchObject([{ shipmentId: f.shipment, contact: {} }]);
    expect(JSON.stringify(exported.data)).not.toContain('parcel@example.test');
    expect(exported.obligations).toContainEqual({ owner: 'fulfillment-parcel-contacts', resource: 'fulfillment.parcel-contact-erasure-markers',
      disposition: 'retain', reasonCode: 'PSEUDONYMOUS_ERASURE_FENCE', remote: false });
    await f.binding.prepare(f.shipment); expect(await f.rows()).toEqual(erased);
    await expect(f.resolve()).rejects.toMatchObject({ code: '22023', message: 'commerce_oms_replacement_delivery_contact_invalid' });
    await contributor.eraseOrRetain(h.runtime, privacySubject, assessment, { principalId: randomUUID() }); expect(await f.rows()).toEqual(erased);
  });
  it('uses the bounded legacy inference once, rejects canonical override markers and atomically freezes only a complete destination', async () => {
    const f = await subject();
    await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('runtimeFinalize',jsonb_build_object('selectedDelivery',jsonb_build_object('providerKind','warehouse-a'))) WHERE id=$1", [f.order]);
    const result = await f.resolve(); expect(result).toMatchObject({ source: 'legacy_inferred', recipientName: 'Retained recipient', selectedDelivery: { providerKind: 'warehouse-a' } });
    await h.owner.query("UPDATE public.clients SET phone='+changed' WHERE id=$1", [f.client]); expect(await f.resolve()).toEqual(result);
    for (const metadata of [{ deliveryContactOverride: {} }, { runtimeFinalize: { deliveryContact: null } }]) {
      const refused = await subject(); await h.owner.query('UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1', [refused.order, metadata]);
      await expect(refused.resolve()).rejects.toMatchObject({ code: '22023', message: 'commerce_oms_replacement_delivery_contact_invalid' }); expect(await refused.rows()).toEqual([]);
    }
    const incomplete = await subject();
    await h.owner.query("UPDATE public.commerce_destinations SET address=address-'line1' WHERE purchase_order_id=$1", [incomplete.order]);
    await expect(incomplete.resolve()).rejects.toMatchObject({ code: '22023', message: 'commerce_oms_replacement_delivery_contact_invalid' });
    expect(await incomplete.rows()).toEqual([]);
  });
});

it('carries live private contacts and payload-free erasure markers through finite native-store restore and replay', async () => {
  const resources = storeJourneyResources();
  try {
    const source = await resources.installation('parcel-contact-source'), target = await resources.installation('parcel-contact-target');
    const live = await fixture(source.owner, null), erased = await fixture(source.owner, null);
    for (const f of [live, erased]) await source.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [f.shipment, { ...frozen(), contactEmail: 'retained-parcel@example.test' }]);
    await source.runtime.query('SELECT public.fulfillment_erase_parcel_contacts($1)', [erased.client]);
    const packet = await captureStoreJourney(source.owner, 'parcel-contact-source'), freshTarget = await captureStoreJourney(target.owner, 'parcel-contact-target');
    const contacts = packet.owned.find(table => table.table === 'fulfillment_parcel_contacts');
    expect(contacts?.rows).toHaveLength(2); expect(JSON.stringify(contacts)).toContain('retained-parcel@example.test');
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: false });
    const read = async (db: typeof source.owner) => (await db.query('SELECT shipment_id,client_id,contact,captured_at,erased_at FROM public.fulfillment_parcel_contacts ORDER BY shipment_id')).rows;
    expect(await read(target.owner)).toEqual(await read(source.owner));
    expect((await read(target.owner)).find(row => row.shipment_id === erased.shipment)).toMatchObject({ contact: {} });
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: true });
  } finally { await resources.close(); }
}, 30_000);
