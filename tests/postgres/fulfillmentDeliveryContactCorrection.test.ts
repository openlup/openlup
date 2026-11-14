import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNativeFulfillmentBinding, createPostgresDeliveryContactReadPort } from '@openlup/platform/fulfillment/native';
import { createPostgresFulfillmentDispatchStore } from '@openlup/platform/fulfillment';
import { createPostgresCommerceOmsPort } from '@openlup/platform/commerce/server/postgres';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createFulfillmentParcelContactPrivacyContributor } from '@openlup/platform/identity';
import { lifecycleInstallation, lifecycleProfiles, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { fixture } from '../helpers/fulfillmentNative.js';
import type { FulfillmentDispatchRequest } from '@openlup/platform/fulfillment/contracts';
import { request, profile } from '../helpers/fulfillmentComposition.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

const address = { recipientName: 'Corrected recipient', contactEmail: 'corrected@example.test', contactPhone: '+0000002',
  line1: 'Corrected street 2', line2: 'Second line', city: 'Example', postalCode: '00002', country: 'zz' };
const baseline = { schemaVersion: 1, source: 'checkout', revision: 1, recipientName: 'Initial recipient', contactEmail: 'initial@example.test',
  contactPhone: '+0000001', line1: 'Initial street 1', line2: null, city: 'Example', postalCode: '00001', country: 'ZZ',
  selectedDelivery: { providerKind: 'warehouse-a', carrierKind: 'carrier-a', service: 'service-a', deliveryKind: 'courier' },
  deliveryInstructions: 'Front door', courierInstructions: null };

for (const generation of lifecycleProfiles) describe(`delivery contact correction on ${generation}`, () => {
  let h: LifecycleInstallation;
  beforeAll(async () => { h = await lifecycleInstallation(generation); }, postgresSetupTimeoutMs);
  afterAll(async () => { await h?.close(); }, postgresTeardownTimeoutMs);
  const resolve = (order: string) => createPostgresDeliveryContactReadPort(h.runtime).resolve(order);
  const raw = async (order: string) => (await h.owner.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c)) FROM public.fulfillment_parcel_contacts c JOIN public.fulfillment_shipments s ON s.id=c.shipment_id WHERE s.order_id=$1) AS parcels,
    (SELECT jsonb_agg(to_jsonb(c)) FROM public.fulfillment_order_contacts c WHERE order_id=$1) AS orders,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY idempotency_key) FROM public.fulfillment_contact_correction_receipts c WHERE order_id=$1) AS receipts,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.commerce_order_operations c WHERE order_id=$1) AS operations,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.outbox_events c WHERE aggregate_id=$1) AS outbox`, [order])).rows;
  async function subject(frozen = true, parcel = true) {
    const f = await fixture(h.owner, null), actor = randomUUID();
    await h.owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [actor, `${actor}@example.invalid`]);
    await h.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Synthetic operator')", [actor]);
    await h.owner.query("UPDATE public.clients SET phone='+0000001',first_name='Initial',last_name='recipient' WHERE id=$1", [f.client]);
    await createPostgresDestinationPort(h.runtime).registerOrder({ idempotencyKey: `destination-${randomUUID()}`, orderId: f.order,
      address: { recipientName: baseline.recipientName, contactPhone: baseline.contactPhone, line1: baseline.line1, city: baseline.city, postalCode: baseline.postalCode, country: 'ZZ' },
      now: (await h.owner.query('SELECT now() AS at')).rows[0].at.toISOString() });
    if (frozen) {
      await h.owner.query('UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1', [f.order, { runtimeFinalize: { deliveryContact: baseline } }]);
      if (parcel) await h.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [f.shipment, baseline]);
    }
    if (!parcel) await h.owner.query('DELETE FROM public.fulfillment_shipments WHERE id=$1', [f.shipment]);
    return { ...f, actor };
  }
  async function correct(f: Awaited<ReturnType<typeof subject>>, key = `correct-${randomUUID()}`, before?: Awaited<ReturnType<typeof resolve>>) {
    const read = before ?? await resolve(f.order);
    return createPostgresCommerceOmsPort(h.runtime).updateShippingAddress({ idempotencyKey: key, orderId: f.order, actorUserId: f.actor, address,
      expectedRevision: read.contact!.revision, expectedContactDigest: read.contactDigest!, metadata: { operatorNote: 'synthetic' } });
  }
  it('separates the recorded baseline, parcel provenance, exact PG digest, one increment and retained replay', async () => {
    const f = await subject(), key = `correct-${randomUUID()}`, before = await resolve(f.order), rows = await raw(f.order);
    expect(before).toMatchObject({ scope: 'parcel', baseline, contact: baseline });
    expect((await h.owner.query('SELECT md5($1::jsonb::text) AS digest', [before.contact])).rows[0].digest).toBe(before.contactDigest);
    expect(await resolve(f.order)).toEqual(before); expect(await raw(f.order)).toEqual(rows);
    const applied = await correct(f, key, before);
    expect(applied).toMatchObject({ result: 'applied', scope: 'parcel', replayed: false, deliveryContact: { source: 'oms_parcel_correction', revision: 2,
      country: 'ZZ', selectedDelivery: baseline.selectedDelivery, deliveryInstructions: 'Front door' }, operation: { type: 'shipping_address_updated', payload: { scope: 'parcel', beforeRevision: 1, afterRevision: 2, metadata: { operatorNote: 'synthetic' } } } });
    expect((await resolve(f.order)).baseline).toEqual(baseline);
    const retained = await raw(f.order);
    expect(await correct(f, key, before)).toEqual({ ...applied, replayed: true, result: 'replayed' });
    expect(await raw(f.order)).toEqual(retained);
    await expect(correct(f, `stale-${randomUUID()}`, before)).rejects.toMatchObject({ details: { code: '40001', reason: 'delivery_contact_stale_revision' } });
    expect(await raw(f.order)).toEqual(retained);
    await correct(f);
    expect(await correct(f, key, before)).toEqual({ ...applied, replayed: true, result: 'replayed' });
    expect((await resolve(f.order)).contact?.revision).toBe(3);
    expect((await h.owner.query("SELECT count(*)::int AS n FROM public.commerce_order_operations WHERE order_id=$1 AND operation_type='shipping_address_updated'", [f.order])).rows[0].n).toBe(2);
    expect((await raw(f.order))[0].outbox).toEqual(rows[0].outbox);
    expect((await h.owner.query('SELECT address FROM public.commerce_destinations WHERE purchase_order_id=$1', [f.order])).rows[0].address.line1).toBe(baseline.line1);
  });
  it('serves a pre-parcel override independently and freezes it at creation without mutating the ordinary capture', async () => {
    const f = await subject(true, false);
    expect(await resolve(f.order)).toMatchObject({ scope: 'baseline', contact: baseline });
    const applied = await correct(f); expect(applied.scope).toBe('order');
    expect(await resolve(f.order)).toMatchObject({ scope: 'order_override', baseline, contact: applied.deliveryContact });
    const opened = await h.runtime.query("SELECT public.fulfillment_create_shipment($1,$2,'fixture-port','{}',now()) AS value", [`create-${randomUUID()}`, f.order]);
    const shipment = opened.rows[0].value.shipment.id;
    expect((await resolve(f.order)).contact).toEqual(applied.deliveryContact);
    expect((await resolve(f.order)).scope).toBe('parcel');
    const captured = await h.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2) AS value', [shipment, baseline]);
    expect(captured.rows[0].value).toEqual({ replayed: true, contact: applied.deliveryContact });
  });
  it('leaves an order without canonical contact uncaptured at creation and preserves its explicit first capture', async () => {
    const f = await subject(false, false);
    const opened = await h.runtime.query("SELECT public.fulfillment_create_shipment($1,$2,'fixture-port','{}',now()) AS value", [`legacy-create-${randomUUID()}`, f.order]);
    const shipment = opened.rows[0].value.shipment.id;
    expect((await h.owner.query('SELECT contact FROM public.fulfillment_parcel_contacts WHERE shipment_id=$1', [shipment])).rows).toEqual([]);
    const before = await raw(f.order);
    expect(await resolve(f.order)).toMatchObject({ baseline: null, scope: 'legacy_inferred' });
    expect(await raw(f.order)).toEqual(before);
    expect((await h.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2) AS value', [shipment, baseline])).rows[0].value).toEqual({ replayed: false, contact: baseline });
  });
  it('keeps historical baseline null, reads legacy/channel evidence with zero writes and fences revision-1 ABA by digest', async () => {
    const f = await subject(false), before = await raw(f.order), first = await resolve(f.order);
    expect(first).toMatchObject({ baseline: null, scope: 'legacy_inferred', contact: { revision: 1, source: 'legacy_inferred' } });
    expect(await raw(f.order)).toEqual(before);
    await h.owner.query("UPDATE public.clients SET phone='+0000999' WHERE id=$1", [f.client]);
    await h.owner.query("UPDATE public.commerce_destinations SET address=address||'{\"contactPhone\":\"+0000888\"}' WHERE purchase_order_id=$1", [f.order]);
    const second = await resolve(f.order); expect(second.contact?.revision).toBe(1); expect(second.contactDigest).not.toBe(first.contactDigest);
    await expect(correct(f, `aba-${randomUUID()}`, first)).rejects.toMatchObject({ details: { code: '40001', reason: 'delivery_contact_stale_revision' } });
    expect(await raw(f.order)).toEqual(before);
    await h.owner.query('UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1', [f.order, { channelOrderSnapshot: { shipTo: { recipientName: 'Channel recipient', phone: '+00007', line1: 'Channel 7', city: 'Channel', postalCode: '00007', countryCode: 'zz' }, buyer: { email: 'CHANNEL@example.test' } }, selectedDelivery: baseline.selectedDelivery }]);
    expect(await resolve(f.order)).toMatchObject({ baseline: null, scope: 'legacy_inferred', contact: { source: 'channel_order_snapshot', contactEmail: 'channel@example.test', selectedDelivery: baseline.selectedDelivery } });
    expect((await correct(f)).deliveryContact.revision).toBe(2);
  });
  it('reads valid frozen headers with blank nullable strings unchanged and permits their explicit correction', async () => {
    const f = await subject(), contact = { ...baseline, recipientName: '  ', contactEmail: '', contactPhone: null, line1: '  Initial 1  ', line2: ' ' };
    await h.owner.query('UPDATE public.fulfillment_parcel_contacts SET contact=$2 WHERE shipment_id=$1', [f.shipment, contact]);
    const before = await raw(f.order), read = await resolve(f.order);
    expect(read.contact).toEqual(contact);
    expect(read.contactDigest).toBe((await h.owner.query('SELECT md5($1::jsonb::text) AS digest', [contact])).rows[0].digest);
    expect(await raw(f.order)).toEqual(before);
    expect(await correct(f)).toMatchObject({ deliveryContact: { recipientName: address.recipientName, revision: 2 } });
  });
  it('preserves canonical and malformed frozen fences, with zero receipts, contacts or operations', async () => {
    for (const marker of [null, {}, { schemaVersion: 1, revision: 0, source: 'bad' }]) {
      const f = await subject(false);
      await h.owner.query('UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1', [f.order, { runtimeFinalize: { deliveryContact: baseline } }]);
      if (marker !== null) await h.owner.query('INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES($1,$2,$3)', [f.shipment, f.client, marker]);
      else await h.owner.query("INSERT INTO public.fulfillment_parcel_contacts(shipment_id,client_id,contact) VALUES($1,$2,'null')", [f.shipment, f.client]);
      const rows = await raw(f.order);
      expect(await resolve(f.order)).toMatchObject({ baseline, contact: null, contactDigest: null });
      await expect(h.runtime.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [`malformed-${randomUUID()}`, f.order, address, f.actor])).rejects.toMatchObject({ code: '40001', message: 'commerce_oms_delivery_contact_stale_revision' });
      expect(await raw(f.order)).toEqual(rows);
    }
    const keyless = await subject(false);
    await h.owner.query('UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1', [keyless.order, { deliveryContactOverride: baseline }]);
    const rows = await raw(keyless.order);
    expect(await resolve(keyless.order)).toMatchObject({ scope: 'legacy_inferred', baseline: null, contact: null, contactDigest: null });
    await expect(h.runtime.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [`keyless-${randomUUID()}`, keyless.order, address, keyless.actor])).rejects.toMatchObject({ code: '40001' });
    expect(await raw(keyless.order)).toEqual(rows);
  });
  it('names missing and foreign destination/contact evidence and preserves saved null recipients', async () => {
    const f = await subject(false), rows = await raw(f.order);
    await h.owner.query("UPDATE public.commerce_destinations SET address=address-'line1' WHERE purchase_order_id=$1", [f.order]);
    await expect(resolve(f.order)).rejects.toMatchObject({ code: '22023', message: 'fulfillment_contact_not_recorded' });
    await expect(h.runtime.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [`missing-${randomUUID()}`, f.order, address, f.actor])).rejects.toMatchObject({ code: '22023', message: 'fulfillment_contact_not_recorded' });
    expect(await raw(f.order)).toEqual(rows);
    const saved = await subject(false);
    await h.owner.query("UPDATE public.commerce_destinations SET address=address||jsonb_build_object('savedAddressId',gen_random_uuid(),'recipientName',NULL) WHERE purchase_order_id=$1", [saved.order]);
    expect((await resolve(saved.order)).contact?.recipientName).toBeNull();
    expect((await correct(saved)).deliveryContact.recipientName).toBe(address.recipientName);
    const foreign = await subject(false), other = await subject(false);
    await h.owner.query('UPDATE public.commerce_destinations SET client_id=$2 WHERE purchase_order_id=$1', [foreign.order, other.client]);
    await expect(resolve(foreign.order)).rejects.toMatchObject({ message: 'commerce_destination_owner_mismatch' });
    await h.owner.query('DELETE FROM public.commerce_destination_bindings WHERE order_id=$1 OR shipment_id=$2', [foreign.order, foreign.shipment]);
    await h.owner.query('DELETE FROM public.commerce_destinations WHERE purchase_order_id=$1', [foreign.order]);
    await expect(resolve(foreign.order)).rejects.toMatchObject({ message: 'commerce_destination_unavailable' });
  });
  it('preserves invalid input and idempotency SQLSTATEs and takes explicit expectations over planted metadata', async () => {
    const f = await subject(), before = await resolve(f.order), key = `key-${randomUUID()}`;
    await expect(h.runtime.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4,$5)', [key, f.order, address, f.actor, { _deliveryContactExpectedDigest: 'not-a-digest' }])).rejects.toMatchObject({ code: '22023', message: 'commerce_oms_shipping_address_invalid_input' });
    const port = createPostgresCommerceOmsPort(h.runtime);
    const command = { idempotencyKey: key, orderId: f.order, actorUserId: f.actor, address, expectedRevision: 1, expectedContactDigest: before.contactDigest!, metadata: { _deliveryContactExpectedRevision: 77, _deliveryContactExpectedDigest: 'a'.repeat(32) } };
    expect(await port.updateShippingAddress(command)).toMatchObject({ deliveryContact: { revision: 2 } });
    await expect(port.updateShippingAddress({ ...command, address: { ...address, city: 'Changed' } })).rejects.toMatchObject({ details: { code: '23505', reason: 'idempotency_conflict' } });
  });
  async function binding(f: Awaited<ReturnType<typeof subject>>) {
    const base = request(), candidate = { ...base, fulfillmentRef: f.shipment, orderRef: f.order };
    const prepared: FulfillmentDispatchRequest[] = [];
    const native = createNativeFulfillmentBinding({ enabled: true, transactions: { async run(work) {
      const db = await h.runtime.connect(); try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
      catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }, async close() {} }, preparation: { async readAuthoritative() { return { candidate, withheld: false }; } },
    services: { selection: candidate.selection, capability: profile(false), readiness: async () => ({ ready: true }), listCandidates: async () => [candidate],
      provider: { async prepare(value) { prepared.push(value); return { kind: 'refused', refusal: { reason: 'not_dispatchable', phase: 'prepare', retryable: false } }; }, async dispatch() { throw Error('No provider call'); } },
      keys: { request: value => value.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) }, config: { mode: 'live', batchLimit: 1 } },
    version: 'fixture', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
    const store = createPostgresFulfillmentDispatchStore(h.runtime, { async prepare() { return { disposition: 'ready', contactRevision: 1 }; }, async readCandidate() { return candidate; } });
    const claim = () => store.claim({ requestKey: `claim-${f.shipment}`, fulfillmentRef: f.shipment, orderRef: f.order, parcelRef: null, mode: 'live',
      evidence: { commandFingerprint: 'a'.repeat(64), contactRevision: { schemaVersion: 1, source: 'contact', revision: 1 }, providerRef: 'warehouse-a', carrierRef: 'carrier-a', serviceRef: 'service-a' } });
    return { native, prepared, claim };
  }
  it('composes corrected payload and revision before claim/begin and refuses all effectful reference/status cutoffs', async () => {
    const f = await subject(), b = await binding(f); await b.native.prepare(f.shipment);
    await b.claim(); await correct(f);
    const ref = (await h.owner.query('SELECT id FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1', [f.shipment])).rows[0].id;
    expect((await h.runtime.query('SELECT public.fulfillment_dispatch_begin($1,$2) AS value', [ref, 'a'.repeat(64)])).rows[0].value).toMatchObject({ kind: 'refused', refusal: { reason: 'contact_stale' } });
    await b.native.prepare(f.shipment); await b.native.services.runDispatch();
    expect(b.prepared[0]).toMatchObject({ contactRevision: { revision: 2, source: 'oms_parcel_correction' }, recipient: { name: address.recipientName, line1: address.line1 } });
    for (const status of ['submitting','created','uncertain','failed','cancel_requested','cancelled']) {
      await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET status=$2 WHERE id=$1', [ref, status]);
      const rows = await raw(f.order);
      await expect(correct(f)).rejects.toMatchObject({ details: { code: '55000', reason: 'delivery_contact_submission_started' } });
      expect(await raw(f.order)).toEqual(rows);
    }
    await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET status='draft',external_ref='external-proof' WHERE id=$1", [ref]);
    await expect(correct(f)).rejects.toMatchObject({ details: { reason: 'delivery_contact_submission_started' } });
    await h.owner.query("DELETE FROM public.fulfillment_dispatch_refs WHERE id=$1", [ref]);
    for (const status of ['label_created','handed_over','in_transit','delivered','exception','cancelled']) {
      await h.owner.query('UPDATE public.fulfillment_shipments SET status=$2 WHERE id=$1', [f.shipment, status]);
      await expect(correct(f)).rejects.toMatchObject({ details: { reason: 'delivery_contact_submission_started' } });
    }
  });
  it('serializes a correction against begin and refuses after submission wins', async () => {
    const f = await subject(), b = await binding(f); await b.native.prepare(f.shipment); await b.claim();
    const ref = (await h.owner.query('SELECT id FROM public.fulfillment_dispatch_refs WHERE shipment_id=$1', [f.shipment])).rows[0].id;
    const begin = await h.runtime.connect(), correction = await h.runtime.connect();
    let correcting: Promise<unknown> | undefined;
    try {
      await begin.query('BEGIN');
      expect((await begin.query('SELECT public.fulfillment_dispatch_begin($1,$2) AS value', [ref, 'a'.repeat(64)])).rows[0].value).toMatchObject({ kind: 'begun', begun: true });
      const pid = (await correction.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      correcting = correction.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [`begin-race-${randomUUID()}`, f.order, address, f.actor]);
      const outcome = correcting.catch(error => error);
      await expect.poll(async () => (await h.owner.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n).toBeGreaterThan(0);
      await begin.query('COMMIT');
      expect(await outcome).toMatchObject({ code: '55000', message: 'commerce_oms_delivery_contact_submission_started' });
      expect((await resolve(f.order)).contact?.revision).toBe(1);
    } finally { await begin.query('ROLLBACK'); begin.release(); if (correcting) await correcting.catch(() => {}); correction.release(); }
  });
  it('exports corrected order/parcel responses and erases them without personal replay or future correction', async () => {
    for (const parcel of [true, false]) {
      const f = await subject(true, parcel), key = `privacy-${randomUUID()}`, before = await resolve(f.order);
      await correct(f, key, before);
      const contributor = createFulfillmentParcelContactPrivacyContributor(), privacySubject = { contactId: f.client, principalId: null, identity: {} };
      const exported = await contributor.export(h.runtime, privacySubject);
      expect(JSON.stringify(exported.data)).toContain(address.contactEmail);
      expect(JSON.stringify(exported.data)).toContain('correction_receipt');
      const assessment = await contributor.assessErasure(h.runtime, privacySubject);
      await contributor.eraseOrRetain(h.runtime, privacySubject, assessment, { principalId: f.actor });
      const erased = await raw(f.order), data = await contributor.export(h.runtime, privacySubject);
      expect(JSON.stringify(data.data)).not.toContain(address.contactEmail);
      await expect(correct(f, key, before)).rejects.toMatchObject({ details: { reason: 'fulfillment_contact_erased' } });
      await expect(h.runtime.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [`post-erasure-${randomUUID()}`, f.order, address, f.actor])).rejects.toMatchObject({ message: 'fulfillment_contact_erased' });
      expect(await raw(f.order)).toEqual(erased);
    }
  });
  it('bounds contention to three seconds, restores settings and leaves the key available for an identical retry', async () => {
    const f = await subject(), blocker = await h.owner.connect(), db = await h.runtime.connect(), key = `timeout-${randomUUID()}`;
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('commerce-order-delivery|'||$1::uuid::text,0))", [f.order]);
      await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='11s'"); await db.query('SAVEPOINT refusal');
      const at = performance.now();
      await expect(db.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [key, f.order, address, f.actor])).rejects.toMatchObject({ code: '55P03' });
      expect(performance.now()-at).toBeLessThan(6000);
      await db.query('ROLLBACK TO SAVEPOINT refusal');
      expect((await db.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('11s');
      await db.query('ROLLBACK'); await blocker.query('ROLLBACK');
      expect((await h.owner.query('SELECT count(*)::int AS n FROM public.fulfillment_contact_correction_receipts WHERE idempotency_key=$1', [key])).rows[0].n).toBe(0);
      expect((await h.runtime.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4) AS value', [key, f.order, address, f.actor])).rows[0].value.result).toBe('applied');
      if (generation !== 'legacy') {
        for (const table of ['fulfillment_order_contacts','fulfillment_contact_correction_receipts']) {
          await expect(h.runtime.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
          await expect(h.actor(f.actor, client => client.query(`SELECT client_id FROM public.${table}`))).rejects.toMatchObject({ code: '42501' });
        }
        await expect(h.actor(f.actor, client => client.query('SELECT public.commerce_oms_resolve_delivery_contact_v1($1)', [f.order]))).rejects.toMatchObject({ code: '42501' });
      }
    } finally { await db.query('ROLLBACK'); db.release(); await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it('refuses a creation/correction race after the locked order gains a parcel, without an advisory inversion', async () => {
    const f = await subject(true, false), blocker = await h.owner.connect(), db = await h.runtime.connect();
    let correcting: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [f.order]);
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      correcting = db.query('SELECT public.commerce_oms_update_shipping_address($1,$2,$3,$4)', [`race-${randomUUID()}`, f.order, address, f.actor]);
      const outcome = correcting.catch(error => error);
      await expect.poll(async () => (await h.owner.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n).toBeGreaterThan(0);
      await blocker.query("SELECT public.fulfillment_create_shipment($1,$2,'fixture-port','{}',now())", [`create-${randomUUID()}`, f.order]);
      await blocker.query('COMMIT');
      expect(await outcome).toMatchObject({ code: '40001', message: 'commerce_oms_delivery_contact_stale_revision' });
      expect((await h.owner.query('SELECT count(*)::int AS n FROM public.fulfillment_contact_correction_receipts WHERE order_id=$1', [f.order])).rows[0].n).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (correcting) await correcting.catch(() => {}); db.release(); }
  });
});
