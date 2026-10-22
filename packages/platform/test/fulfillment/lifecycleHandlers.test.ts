import { expect, expectTypeOf, it } from 'vitest';
import type { FulfillmentOperatorMutationPort, FulfillmentReplacementRequest } from '../../src/fulfillment/contracts/index.js';
import * as fulfillment from '../../src/fulfillment/index.js';
import { createBffResponder } from '../../src/bff/index.js';
import { responseFixture } from './lifecycleHostFixture.js';
import { lifecycleHost, actorUserId, orderId, parcelId } from './lifecycleHostFixture.js';

it('runs operator host writes with actor-bound receipts and preserves method/auth/validation/conflict/read boundaries', async () => {
  type OperatorInput = Parameters<FulfillmentOperatorMutationPort[keyof FulfillmentOperatorMutationPort]>[0];
  expectTypeOf<OperatorInput>().toExtend<{ actorUserId: string; idempotencyKey: string }>();
  expectTypeOf<FulfillmentReplacementRequest>().toExtend<{ actorUserId: string; idempotencyKey: string }>();
  const host = lifecycleHost(); const res = responseFixture(); let auth = true, authFailure = false;
  const deps = { respond: createBffResponder(), authorizeAdmin: async () => { if (authFailure) throw new Error('private'); return auth ? { ok: true as const, userId: actorUserId } : { ok: false as const, code: 'FORBIDDEN' as const, message: 'Forbidden' }; }, fulfillmentPort: () => host.mutations };
  const cases = [
    [fulfillment.createAdminCommerceFulfillmentCreateOrderHandler(deps), { orderId }],
    [fulfillment.createAdminCommerceFulfillmentRecordProviderAttemptHandler(deps), { fulfillmentOrderId: parcelId, providerKind: 'warehouse', status: 'recorded' }],
    [fulfillment.createAdminCommerceFulfillmentRecordLabelHandler(deps), { fulfillmentOrderId: parcelId, providerKind: 'warehouse', providerTrackingId: 'tracking' }],
    [fulfillment.createAdminCommerceFulfillmentHandOffHandler(deps), { fulfillmentOrderId: parcelId }],
    [fulfillment.createAdminCommerceFulfillmentTrackingEventHandler(deps), { fulfillmentOrderId: parcelId, status: 'delivered' }],
    [fulfillment.createAdminCommerceFulfillmentCancelOrderHandler(deps), { fulfillmentOrderId: parcelId, reason: 'operator' }],
  ] as const;
  for (const [i, [handler, body]] of cases.entries()) {
    const request = { method: 'POST', query: {}, body: { ...body, idempotencyKey: `operator-${i}` } };
    await handler({ ...request, method: 'GET' }, res.response); expect(res.output()).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
    auth = false; await handler(request, res.response); expect(res.output()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    auth = true; authFailure = true; await handler(request, res.response); expect(res.output()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } }); authFailure = false;
    await handler({ ...request, body: { ...request.body, actorUserId: 'spoof' } }, res.response); expect(res.output()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(host.operations).toHaveLength(i);
    await handler(request, res.response); expect(res.output()).toMatchObject({ ok: true, data: { replayed: false } });
    await handler(request, res.response); expect(res.output()).toMatchObject({ ok: true, data: { replayed: true } });
    expect(host.operations).toHaveLength(i+1); expect(host.operations[i].actorUserId).toBe(actorUserId);
  }
  host.setPaid(false);
  await cases[0][0]({ method: 'POST', query: {}, body: { orderId, idempotencyKey: 'unpaid-key' } }, res.response);
  expect(res.output()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'order_not_paid' } } });
  const native = fulfillment.createAdminCommerceFulfillmentCreateOrderHandler({ ...deps, fulfillmentPort: fulfillment.createNativeUnsupportedFulfillmentPorts() });
  await native({ method: 'POST', query: {}, body: { orderId, idempotencyKey: 'native-key' } }, res.response);
  expect(res.output()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE', details: fulfillment.FULFILLMENT_NATIVE_UNSUPPORTED } });
  for (const detail of [false, true]) {
    let reads = 0;
    const readDeps = { ...deps, fulfillmentPort: { async listCommerceFulfillmentOrders() { reads++; return { contractVersion: 'commerce.fulfillment.v0' as const, orders: [], totalCount: 0, page: 1, pageSize: 25 }; }, async getCommerceFulfillmentOrderDetail() { reads++; return null; } } };
    const handler = detail ? fulfillment.createAdminCommerceFulfillmentOrderDetailHandler(readDeps) : fulfillment.createAdminCommerceFulfillmentOrdersListHandler(readDeps);
    await handler({ method: 'POST', query: {} }, res.response); expect(reads).toBe(0);
    await handler({ method: 'GET', query: detail ? { orderId } : {} }, res.response);
    expect(reads).toBe(1); expect(res.output()).toMatchObject(detail ? { error: { code: 'NOT_FOUND' } } : { ok: true, data: { orders: [] } });
  }
});
