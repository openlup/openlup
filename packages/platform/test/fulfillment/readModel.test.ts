import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { PAYMENT_INTENT_STATUSES } from '@openlup/core/payment';
import { buildCommerceFulfillmentOrdersListResponse, buildCommerceFulfillmentOrderDetailResponse, createFulfillmentShipmentsOverviewHandler, createNativeUnsupportedFulfillmentPorts, FULFILLMENT_NATIVE_UNSUPPORTED, createAdminCommerceFulfillmentOrdersListHandler, createAdminCommerceFulfillmentOrderDetailHandler } from '../../src/fulfillment/index.js';
import { createBffResponder } from '../../src/bff/index.js';
import { responseFixture } from './lifecycleHostFixture.js';
import type { FulfillmentCommerceReadPolicy, FulfillmentCommerceReadPort } from '../../src/fulfillment/contracts/index.js';

// The host validates its actual row DTOs; private fields never enter package declarations.
const hostRow = z.object({ id: z.string().min(1) }).passthrough();
const responseSchema = z.object({ approved: z.array(hostRow), packing: z.array(hostRow), shipped: z.array(hostRow), shippedToday: z.number().int().nonnegative() });

it.each(['not_started', ...PAYMENT_INTENT_STATUSES] as const)('projects host read facts with payment %s unchanged', async (status) => {
  const input = baseInput(); input.paymentIntent.status = status;
  const policy: FulfillmentCommerceReadPolicy = { evaluateCommerceFulfillmentEligibility: vi.fn(() => ({ allowed: false, reason: 'active_hold' })) };
  input.activeHoldCount = 2;
  input.fulfillmentOrder.shipping_address_snapshot = { ...input.fulfillmentOrder.shipping_address_snapshot, contactPhone: 'private' } as typeof input.fulfillmentOrder.shipping_address_snapshot;
  const detail = buildCommerceFulfillmentOrderDetailResponse(input, policy);
  const list = buildCommerceFulfillmentOrdersListResponse({ fulfillmentOrders: [input.fulfillmentOrder], lines: input.lines,
    latestOperations: [input.latestOperation!], orderContexts: [input.orderContext], paymentIntents: [input.paymentIntent],
    inventoryReservations: input.inventoryReservations, shipmentRefs: [{ ...input.shipmentRef!, active: false, provider_tracking_id: 'inactive' }, input.shipmentRef!],
    activeHoldCounts: { [input.orderContext.id]: 2 }, subscriptionCycleStatuses: {}, totalCount: 23, page: 2, pageSize: 5 }, policy);
  expect(list.orders).toEqual([detail.order]); expect(list).toMatchObject({ totalCount: 23, page: 2, pageSize: 5 });
  expect(detail.order.payment.paymentStatus).toBe(status);
  expect(detail.order).toMatchObject({ providerTrackingId: 'TRACK-1', inventory: { status: 'reserved', locationCode: 'main' }, omsEligibility: { allowed: false, reason: 'active_hold' }, latestOperation: { type: 'created' } });
  expect(detail.order.shippingAddress).not.toHaveProperty('contactPhone');
  expect(policy.evaluateCommerceFulfillmentEligibility).toHaveBeenCalledWith(expect.objectContaining({ paymentStatus: status, activeHoldCount: 2, inventoryStatus: 'reserved' }));
  const host: FulfillmentCommerceReadPort = { listCommerceFulfillmentOrders: vi.fn(async () => list), getCommerceFulfillmentOrderDetail: vi.fn(async () => detail) };
  const deps = { respond: createBffResponder(), authorizeAdmin: async () => ({ ok: true as const, userId: 'operator' }), fulfillmentPort: host };
  const res = responseFixture();
  await createAdminCommerceFulfillmentOrdersListHandler(deps)({ method: 'GET', query: { page: '2', pageSize: '5' } }, res.response);
  expect(res.output()).toMatchObject({ ok: true, data: list });
  expect(host.listCommerceFulfillmentOrders).toHaveBeenCalledExactlyOnceWith({ page: 2, pageSize: 5 });
  await createAdminCommerceFulfillmentOrderDetailHandler(deps)({ method: 'GET', query: { orderId: input.orderContext.id } }, res.response);
  expect(res.output()).toMatchObject({ ok: true, data: detail });
  expect(host.getCommerceFulfillmentOrderDetail).toHaveBeenCalledExactlyOnceWith({ orderId: input.orderContext.id });
  expect(() => buildCommerceFulfillmentOrdersListResponse({ fulfillmentOrders: [input.fulfillmentOrder], lines: input.lines, latestOperations: [], orderContexts: [], paymentIntents: [], inventoryReservations: [], shipmentRefs: [], activeHoldCounts: {}, subscriptionCycleStatuses: {}, totalCount: 1, page: 1, pageSize: 25 }, policy)).toThrow('Missing commerce fulfillment order context');
});

it.each(['today', '7d', '30d', 'all'] as const)('delegates overview %s buckets intact after method/auth/validation', async shippedFilter => {
  const buckets = { approved: [{ id: 'approved', privateField: { kept: true } }], packing: [{ id: 'packing' }], shipped: [{ id: 'shipped' }], shippedToday: 17 };
  const getShipmentsOverview = vi.fn(async () => buckets);
  const authorizeAdmin = vi.fn(async () => true);
  const res = responseFixture();
  const handler = createFulfillmentShipmentsOverviewHandler({ responseSchema, respond: createBffResponder(), authorizeAdmin, overviewPort: { getShipmentsOverview } });
  await handler({ method: 'POST', query: {} }, res.response);
  expect(authorizeAdmin).not.toHaveBeenCalled(); expect(getShipmentsOverview).not.toHaveBeenCalled();
  authorizeAdmin.mockResolvedValueOnce(false);
  await handler({ method: 'GET', query: {} }, res.response); expect(res.output()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  authorizeAdmin.mockRejectedValueOnce(new Error('private'));
  await handler({ method: 'GET', query: {} }, res.response); expect(res.output()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
  await handler({ method: 'GET', query: { shippedFilter: 'invalid' } }, res.response); expect(res.output()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  expect(getShipmentsOverview).not.toHaveBeenCalled();
  await handler({ method: 'GET', query: { shippedFilter: [shippedFilter, 'invalid'] } }, res.response);
  expect(getShipmentsOverview).toHaveBeenCalledExactlyOnceWith({ shippedFilter });
  expect(res.output()).toEqual({ ok: true, data: buckets });
  getShipmentsOverview.mockResolvedValueOnce({ ...buckets, shippedToday: -1 });
  await handler({ method: 'GET', query: {} }, res.response); expect(res.output()).toMatchObject({ error: { code: 'INVALID_RESPONSE' } });
  getShipmentsOverview.mockResolvedValueOnce({ ...buckets, approved: [{ id: '', privateField: { kept: true } }] });
  await handler({ method: 'GET', query: {} }, res.response); expect(res.output()).toMatchObject({ error: { code: 'INVALID_RESPONSE' } });
  getShipmentsOverview.mockRejectedValueOnce(new Error('private'));
  await handler({ method: 'GET', query: {} }, res.response); expect(res.output()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } });
});

it.each(['list', 'detail', 'overview'] as const)('propagates the shared native unsupported refusal for %s without a substitute', async kind => {
  const ports = createNativeUnsupportedFulfillmentPorts(), res = responseFixture();
  const direct = kind === 'list' ? await ports.listCommerceFulfillmentOrders({ page: 1, pageSize: 25 }) : kind === 'detail' ? await ports.getCommerceFulfillmentOrderDetail({ orderId: baseInput().orderContext.id }) : await ports.getShipmentsOverview({ shippedFilter: 'all' });
  expect(direct).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
  const deps = { respond: createBffResponder(), authorizeAdmin: async () => ({ ok: true as const, userId: 'operator' }), fulfillmentPort: ports };
  const handler = kind === 'list' ? createAdminCommerceFulfillmentOrdersListHandler(deps) : kind === 'detail' ? createAdminCommerceFulfillmentOrderDetailHandler(deps) : createFulfillmentShipmentsOverviewHandler({ responseSchema, respond: deps.respond, authorizeAdmin: async () => true, overviewPort: ports });
  await handler({ method: 'GET', query: kind === 'detail' ? { orderId: baseInput().orderContext.id } : {} }, res.response);
  expect(res.output()).toMatchObject({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', details: FULFILLMENT_NATIVE_UNSUPPORTED } });
});

function baseInput(): Parameters<typeof buildCommerceFulfillmentOrderDetailResponse>[0] {
  return {
    fulfillmentOrder: {
      id: "52222222-2222-4222-8222-222222222221",
      order_id: "42222222-2222-4222-8222-222222222221",
      client_id: "12222222-2222-4222-8222-222222222221",
      status: "label_created" as const,
      provider_kind: "warehouse",
      shipping_address_snapshot: {
        addressId: "32222222-2222-4222-8222-222222222221",
        clientId: "12222222-2222-4222-8222-222222222221",
        label: "Home",
        line1: "Example Street 1",
        line2: null,
        city: "Example City",
        postalCode: "00-001",
        country: "XX",
      },
      created_at: "2026-06-05T10:00:00+00:00",
      updated_at: "2026-06-05T10:01:00+00:00",
    },
    lines: [{
      id: "62222222-2222-4222-8222-222222222221",
      fulfillment_order_id: "52222222-2222-4222-8222-222222222221",
      order_item_id: "72222222-2222-4222-8222-222222222221",
      sku_id: "82222222-2222-4222-8222-222222222221",
      sku: "ITEM-1",
      title: "Item",
      quantity: 2,
      inventory_reservation_ids: ["92222222-2222-4222-8222-222222222221"],
      product_snapshot: {},
    }],
    latestOperation: {
      id: "c2222222-2222-4222-8222-222222222221",
      fulfillment_order_id: "52222222-2222-4222-8222-222222222221",
      operation_type: "created" as const,
      actor_user_id: null,
      occurred_at: "2026-06-05T10:00:00+00:00",
      payload: {},
    },
    orderContext: {
      id: "42222222-2222-4222-8222-222222222221",
      status: "paid" as const,
      mode: "one_time" as const,
      shipping_address_id: "32222222-2222-4222-8222-222222222221",
      subscription_cycle_id: null,
    },
    paymentIntent: {
      id: "a2222222-2222-4222-8222-222222222221",
      order_id: "42222222-2222-4222-8222-222222222221",
      status: "succeeded",
      provider_payment_id: "pay_1",
    },
    inventoryReservations: [{
      id: "92222222-2222-4222-8222-222222222221",
      order_id: "42222222-2222-4222-8222-222222222221",
      status: "reserved" as const,
      expires_at: "2026-06-05T10:30:00+00:00",
      location_id: "b2222222-2222-4222-8222-222222222221",
      inventory_locations: { code: "main" },
    }],
    shipmentRef: {
      order_id: "42222222-2222-4222-8222-222222222221",
      provider_tracking_id: "TRACK-1",
      active: true,
      created_at: "2026-06-05T10:02:00+00:00",
    },
    activeHoldCount: 0,
    subscriptionCycleStatus: null,
  };
}
