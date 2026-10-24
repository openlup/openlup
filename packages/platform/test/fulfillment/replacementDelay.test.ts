import { expect, it } from 'vitest';
import { createAdminCommerceOrderRequestReplacementShipmentHandler, createAdminCommerceFulfillmentTrackingEventHandler, FULFILLMENT_REPLACEMENT_REFUSALS, readFulfillmentDelay, createNativeUnsupportedFulfillmentPorts, FULFILLMENT_NATIVE_UNSUPPORTED, currentParcel } from '../../src/fulfillment/index.js';
import { createBffResponder } from '../../src/bff/index.js';
import { responseFixture } from './lifecycleHostFixture.js';
import { lifecycleHost, orderId, actorUserId, parcelId } from './lifecycleHostFixture.js';
it('requests replacement through the host transaction, replays actor receipts, passes every refusal and never confirms or dispatches', async () => {
  const host = lifecycleHost(); const res = responseFixture();
  const deps = { respond: createBffResponder(), authorizeAdmin: async () => ({ ok: true as const, userId: actorUserId }) };
  const handler = createAdminCommerceOrderRequestReplacementShipmentHandler({ ...deps, omsPort: host.replacement });
  const request = { method: 'POST', query: {}, body: { orderId, reason: 'lost', idempotencyKey: 'replacement-key' } };
  await handler({ ...request, method: 'GET' }, res.response); expect(host.receipts.size).toBe(0);
  await handler({ ...request, body: {} }, res.response); expect(res.output()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  for (const reason of FULFILLMENT_REPLACEMENT_REFUSALS) {
    host.refuse(reason); await handler(request,res.response);
    expect(res.output()).toMatchObject({ error: { code: 'CONFLICT', details: { reason } } });
    expect(host.receipts.size).toBe(0); expect(host.parcels).toHaveLength(1); expect(host.reservations).toEqual([]); expect(host.holds.has('fulfillment_exception')).toBe(true);
  }
  host.refuse(null); host.setPaid(false); await handler(request,res.response); expect(res.output()).toMatchObject({ error: { details: { reason: 'payment_not_succeeded' } } });
  host.setPaid(true); host.holds.add('manual_support'); await handler(request,res.response); expect(res.output()).toMatchObject({ error: { details: { reason: 'blocked_by_manual_support_hold' } } }); host.holds.delete('manual_support');
  await handler(request,res.response); expect(res.output()).toMatchObject({ ok: true, data: { replayed: false, replacement: { sequenceNo: 1, replacesFulfillmentOrderId: parcelId, status: 'created' } } });
  const successor = currentParcel(host.parcels)!;
  expect(host.operations[0]).toMatchObject({ type: 'replacement_shipment_requested', actorUserId }); expect(host.holds.size).toBe(0); expect(host.reservations).toHaveLength(1);
  await handler(request,res.response); expect(res.output()).toMatchObject({ ok: true, data: { replayed: true } }); expect(host.parcels).toHaveLength(2); expect(host.reservations).toHaveLength(1);
  await handler({ ...request, body: { ...request.body, idempotencyKey: 'second-replacement' } },res.response); expect(res.output()).toMatchObject({ error: { details: { reason: 'undispatched_replacement_exists' } } });
  const otherActor = createAdminCommerceOrderRequestReplacementShipmentHandler({ ...deps, authorizeAdmin: async () => ({ ok: true as const, userId: parcelId }), omsPort: host.replacement });
  await otherActor(request,res.response); expect(res.output()).toMatchObject({ error: { details: { reason: 'idempotency_conflict' } } });
  expect(successor.status).toBe('created'); // Neither requesting nor replaying asserts arrival or dispatch.
  const tracking = createAdminCommerceFulfillmentTrackingEventHandler({ ...deps, fulfillmentPort: host.mutations });
  await tracking({ method:'POST',query:{},body:{ idempotencyKey:'successor-arrival',fulfillmentOrderId:successor.id,status:'delivered' } },res.response); expect(successor.status).toBe('delivered');
  expect(host.operations.map(row=>row.type)).toEqual(['replacement_shipment_requested','tracking_event_recorded']);
});
it('keeps no current case distinct, hides advanced aligned history and manual review, and passes native unsupported', async () => {
  let reads = 0;
  const schedule = new Map<string,string|null>([['none','2026-11-01T00:00:00Z'],['protected','2026-11-01T00:00:00Z'],['aligned','2026-11-01T00:00:00Z'],['advanced','2026-12-01T00:00:00Z'],['review',null]]);
  const result = await readFulfillmentDelay(async ids => { reads++; expect(ids).toEqual([...schedule.keys()]); return [ { subscription_id:'protected',state:'protected',private_note:'hidden' }, { subscription_id:'aligned',state:'aligned',aligned_next_cycle_at:'2026-11-01T01:00:00+01:00' }, { subscription_id:'advanced',state:'aligned',aligned_next_cycle_at:'2026-11-01T00:00:00Z' }, { subscription_id:'review',state:'manual_review' } ]; },schedule);
  if (!(result instanceof Map)) throw new Error('unexpected unsupported');
  expect(result.get('none')).toBeUndefined(); expect(result.get('protected')).toEqual({ state:'protected' }); expect(result.get('aligned')).toEqual({ state:'aligned' }); expect(result.has('advanced')).toBe(false); expect(result.has('review')).toBe(false); expect(JSON.stringify([...result])).not.toContain('private_note');
  schedule.set('aligned','2026-12-01T00:00:00Z');
  const advanced = await readFulfillmentDelay(async()=>[{ subscription_id:'aligned',state:'aligned',aligned_next_cycle_at:'2026-11-01T00:00:00Z' }],schedule);
  expect(advanced).toEqual(new Map());
  expect(await readFulfillmentDelay(undefined,schedule)).toEqual(new Map()); expect(await readFulfillmentDelay(async()=>{reads++;return [];},new Map())).toEqual(new Map()); expect(reads).toBe(1);
  expect(await readFulfillmentDelay(createNativeUnsupportedFulfillmentPorts().readCustomerAlignmentRows,schedule)).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
});
