import { expect, it } from 'vitest';
import { readFulfillmentLabel, cleanupFulfillmentLabel, currentParcel, currentParcelFor, currentParcelFirst, currentParcelPerOrder, belongsToParcel, rowsForParcel, parcelSequenceNo, compareParcelPrecedence } from '../../src/fulfillment/index.js';
it('keeps cached signed downloads transient, cleanup uncertainty and exact current-parcel attribution', async () => {
  let reads = 0, cleanups = 0;
  const document = { objectRef: 'labels/parcel.pdf', mediaType: 'application/pdf' as const, externalRef: 'parcel' };
  const bytes = JSON.stringify(document);
  const port = { async read() { reads++; return { kind: 'available' as const, url: 'https://storage.invalid/transient', expiresAt: null }; }, async void() { cleanups++; return { providerDeletion: 'unconfirmed' as const, labelDeleted: false, canProceed: true }; } };
  expect(await readFulfillmentLabel(port, null)).toMatchObject({ kind: 'refused', refusal: { reason: 'local_missing' } }); expect(reads).toBe(0);
  expect(await readFulfillmentLabel(port, document)).toMatchObject({ kind: 'available' }); expect(reads).toBe(1); expect(JSON.stringify(document)).toBe(bytes);
  expect(await cleanupFulfillmentLabel(port, { parcelRef: 'parcel', document, actorUserId: 'operator', idempotencyKey: 'cleanup-key' })).toEqual({ providerDeletion: 'unconfirmed', labelDeleted: false, canProceed: true }); expect(cleanups).toBe(1);
  const rows = [{ id: 'a', order_id: 'order' }, { id: 'b', order_id: 'order', sequence_no: 1 }, { id: 'c', order_id: 'order', sequence_no: 1 }, { id: 'z', order_id: 'other' }];
  expect(currentParcel(rows.slice(0,3))?.id).toBe('c'); expect(currentParcel([])).toBeNull(); expect(parcelSequenceNo(rows[0])).toBe(0);
  expect(compareParcelPrecedence(rows[1],rows[2])).toBe(1); expect(currentParcelFor(rows,'order')?.id).toBe('c'); expect(currentParcelPerOrder(rows).get('other')?.id).toBe('z');
  expect(currentParcelFirst(rows).map(row=>row.id)).toEqual(['c','b','a','z']); expect(rows[0].id).toBe('a');
  expect(belongsToParcel({},'c')).toBe(true); expect(belongsToParcel({ fulfillment_order_id:'a' },'c')).toBe(false);
  expect(rowsForParcel([{ fulfillment_order_id:'a' },{}, { fulfillment_order_id:'c' }],'c')).toEqual([{}, { fulfillment_order_id:'c' }]);
});
