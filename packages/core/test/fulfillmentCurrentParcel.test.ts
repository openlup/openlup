import { expect, it } from 'vitest';
import { currentParcel, currentParcelFor, currentParcelFirst, currentParcelPerOrder, belongsToParcel, rowsForParcel, parcelSequenceNo, compareParcelPrecedence } from '../src/fulfillment/index.js';
it('keeps exact current-parcel attribution', () => {
  const rows = [{ id: 'a', order_id: 'order' }, { id: 'b', order_id: 'order', sequence_no: 1 }, { id: 'c', order_id: 'order', sequence_no: 1 }, { id: 'z', order_id: 'other' }];
  expect(currentParcel(rows.slice(0,3))?.id).toBe('c'); expect(currentParcel([])).toBeNull(); expect(parcelSequenceNo(rows[0])).toBe(0);
  expect(compareParcelPrecedence(rows[1],rows[2])).toBe(1); expect(currentParcelFor(rows,'order')?.id).toBe('c'); expect(currentParcelPerOrder(rows).get('other')?.id).toBe('z');
  expect(currentParcelFirst(rows).map(row=>row.id)).toEqual(['c','b','a','z']); expect(rows[0].id).toBe('a');
  expect(belongsToParcel({},'c')).toBe(true); expect(belongsToParcel({ fulfillment_order_id:'a' },'c')).toBe(false);
  expect(rowsForParcel([{ fulfillment_order_id:'a' },{}, { fulfillment_order_id:'c' }],'c')).toEqual([{}, { fulfillment_order_id:'c' }]);
});
