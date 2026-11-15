import { expect, it } from 'vitest';
import { nativeDeliveryContactProjection, nativeDeliveryContactResolutionSchema } from '../../src/fulfillment/native/deliveryContact.js';
import { omsDeliveryContactResolutionSchema } from '../../src/commerce/oms/omsContractReadAuxSchemas.js';
import { buildOmsDeliveryContactProjection } from '../../src/commerce/model/omsReadModelRowCore.js';
import { createPostgresCommerceOmsPort } from '@openlup/platform/commerce/server/postgres';

it('keeps the isolated native representation equal to the existing contact projection for provenance, comparison and every submission state', () => {
  const contact = { schemaVersion: 1 as const, revision: 2, source: 'oms_parcel_correction', recipientName: 'Recipient', contactEmail: 'contact@example.test', contactPhone: '+00001',
    line1: 'Street 1', line2: null, city: 'Example', postalCode: '00001', country: 'ZZ', selectedDelivery: null, deliveryInstructions: null, courierInstructions: null };
  for (const scope of ['parcel','baseline','order_override','legacy_inferred','missing'] as const) for (const status of ['created','packed','label_pending','label_created','cancelled']) {
    for (const ref of [null, ...['draft','submitting','created','uncertain','failed','cancel_requested','cancelled','unknown'].map(status => ({ status, external_ref: null })), { status: 'draft', external_ref: 'proof' }]) {
      const resolution = nativeDeliveryContactResolutionSchema.parse({ resolutionVersion: 1, scope, baseline: scope === 'baseline' ? contact : null, contact: scope === 'missing' ? null : contact, contactDigest: scope === 'missing' ? null : 'a'.repeat(32) });
      expect(nativeDeliveryContactProjection(resolution, status, ref ? [ref] : [])).toEqual(buildOmsDeliveryContactProjection({ resolution,
        currentParcel: { id: 'parcel', order_id: 'order', status: status as 'created' | 'packed' | 'label_pending' | 'label_created' | 'cancelled' },
        dispatchRefs: ref ? [{ fulfillment_order_id: 'parcel', status: ref.status, provider_order_id: ref.external_ref }] : [],
      }));
    }
  }
});
it('accepts the same nullable legacy strings and normalizes only the projection, retaining the PG digest', () => {
  const contact = { schemaVersion: 1, revision: 1, source: '  checkout  ', recipientName: '  ', contactEmail: '', contactPhone: null,
    line1: '  Recorded 1  ', line2: '', city: ' Example ', postalCode: ' 00001 ', country: ' ZZ ', selectedDelivery: null,
    deliveryInstructions: ' ', courierInstructions: '' };
  const input = { resolutionVersion: 1, scope: 'parcel', baseline: contact, contact, contactDigest: 'a'.repeat(32) };
  const native = nativeDeliveryContactResolutionSchema.parse(input), managed = omsDeliveryContactResolutionSchema.parse(input);
  expect(native).toEqual(managed);
  expect(native.contact).toMatchObject({ recipientName: '  ', contactEmail: '', line1: '  Recorded 1  ' });
  expect(nativeDeliveryContactProjection(native, 'created', [])).toEqual(buildOmsDeliveryContactProjection({ resolution: managed,
    currentParcel: { id: 'parcel', order_id: 'order', status: 'created' }, dispatchRefs: [] }));
  expect(nativeDeliveryContactProjection(native, 'created', [])).toMatchObject({ effective: { recipientName: null, contactEmail: null, line1: 'Recorded 1' }, digest: 'a'.repeat(32), correctionAllowed: true });
});
it.each([
  ['55P03', 'unrelated database lock text', 'lock_timeout'],
  ['40001', 'commerce_oms_delivery_contact_stale_revision', 'delivery_contact_stale_revision'],
  ['55000', 'commerce_oms_delivery_contact_submission_started', 'delivery_contact_submission_started'],
  ['23505', 'commerce_oms_shipping_address_idempotency_conflict', 'idempotency_conflict'],
  ['55000', 'fulfillment_contact_erased', 'fulfillment_contact_erased'],
  ['22023', 'fulfillment_contact_not_recorded', 'fulfillment_contact_not_recorded'],
])('preserves correction SQLSTATE %s and the managed refusal semantics for %s', async (code, message, reason) => {
  const port = createPostgresCommerceOmsPort({ async query() { throw { code, message: 'database refusal', details: message, hint: '' }; } });
  await expect(port.updateShippingAddress({ idempotencyKey: 'synthetic-key', orderId: 'order', actorUserId: 'operator', address: { recipientName: 'Recipient', contactEmail: 'r@example.test', contactPhone: '+00001', line1: 'Street 1', city: 'Example', postalCode: '00001', country: 'ZZ' }, expectedRevision: 1, expectedContactDigest: 'a'.repeat(32) })).rejects.toMatchObject({ details: { code, reason } });
});
