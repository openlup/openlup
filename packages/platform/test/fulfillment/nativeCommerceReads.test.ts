import { expect, it, vi } from 'vitest';
import { adminCommerceFulfillmentOrderDetailResponseSchema as managedDetailSchema, adminCommerceFulfillmentOrdersListResponseSchema as managedListSchema, commerceFulfillmentOrderSchema, createCommerceFulfillmentResponseSchemas, commerceFulfillmentShippingAddressSnapshotSchema, adminCommerceFulfillmentOrdersListRequestSchema, adminCommerceFulfillmentOrderDetailRequestSchema } from '../../src/fulfillment/handlerSchemas.js';
import { createAdminCommerceFulfillmentOrdersListHandler, createAdminCommerceFulfillmentOrderDetailHandler, buildCommerceFulfillmentOrdersListResponse, buildCommerceFulfillmentOrderDetailResponse } from '../../src/fulfillment/index.js';
import { createBffResponder } from '../../src/bff/index.js';
import { responseFixture } from './lifecycleHostFixture.js';
import { createPostgresFulfillmentCommerceReadPort, nativeFulfillmentCommerceResponseSchemas } from '../../src/fulfillment/native/index.js';
import { evaluateCommerceFulfillmentEligibility } from '../../src/commerce/fulfillmentEligibility.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const { detail: adminCommerceFulfillmentOrderDetailResponseSchema, list: adminCommerceFulfillmentOrdersListResponseSchema } = nativeFulfillmentCommerceResponseSchemas;
const at = '2026-11-03T00:00:00.000Z';
export function fixture() {
  const shipment = { id: id(1), order_id: id(2), status: 'created', port_key: 'warehouse', created_at: at, updated_at: at };
  const facts = { order_context: { id: id(2), client_id: id(3), status: 'paid', subscription_cycle_id: null as string | null,
    metadata: { orderDraftSnapshot: { context: { mode: 'one_time' }, lines: [{ sku: 'UNIT', title: 'Unit', quantity: 2, opaque: 'retained' }] } } },
    payment: { id: id(4), status: 'settled', external_ref: 'payment-ref' }, cycle: null as { status: string } | null, holds: 0,
    lines: [{ id: id(5), sku_id: id(6), line_ordinal: 1, quantity: 2 }],
    operation: { id: id(7), operation_type: 'shipment_created', payload: {}, occurred_at: at },
    tracking: 'tracking-ref', provider: 'dispatch-provider',
    reservations: [{ id: id(8), status: 'held', expires_at: '2026-11-04T00:00:00.000Z', elapsed: false, lines: [{ sku: 'UNIT', quantity: 2 }] }] };
  return { shipment, facts, destination: { destinationId: id(9), clientId: id(3), address: { label: null, line1: 'Unit street', line2: null, city: 'Fixture', postalCode: '00000', country: 'ZZ' } } };
}
function harness(orderMode: Parameters<typeof createPostgresFulfillmentCommerceReadPort>[0]['orderMode'] = ({ subscriptionCycleId, capturedMode }) => capturedMode === 'subscription' || subscriptionCycleId ? 'subscription_cycle' : 'one_time') {
  const f = fixture();
  const queries: { sql: string; values?: unknown[] }[] = [];
  let missing = false, empty = false;
  const evaluate = vi.fn(evaluateCommerceFulfillmentEligibility);
  const port = createPostgresFulfillmentCommerceReadPort({
    executor: { async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith('WITH selected')) return { rows: [{ total: empty ? 0 : 3, shipments: empty ? [] : [f.shipment] }] };
      if (sql.startsWith('SELECT to_jsonb(s)')) return { rows: missing ? [] : [{ shipment: f.shipment }] };
      return { rows: [f.facts] };
    } },
    destinations: { async read(scope, value) { expect([scope, value]).toEqual(['shipment', id(1)]); return f.destination; } },
    policy: { evaluateCommerceFulfillmentEligibility: evaluate },
    orderMode,
  });
  return { f, port, queries, evaluate, empty() { empty = true; }, missing() { missing = true; } };
}
it('projects the reduced native shipment facts with explicit unavailable identities', async () => {
  const { port } = harness();
  const first = await port.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: id(1) });
  expect(first).toMatchObject({ contractVersion: 'commerce.fulfillment.v0', order: {
    id: id(1), orderId: id(2), clientId: null, status: 'created', providerKind: null, providerTrackingId: 'tracking-ref',
    lines: [{ id: null, orderItemId: id(5), skuId: id(6), quantity: 2, inventoryReservationIds: [], productSnapshot: { opaque: 'retained' } }],
    shippingAddress: { addressId: null, line1: 'Unit street' },
    payment: { paymentIntentId: id(4), paymentStatus: 'succeeded', providerPaymentId: 'payment-ref' },
    inventory: { status: 'reserved', reservationId: id(8), reservationStatus: 'reserved', locationId: null, locationCode: null },
    omsEligibility: { allowed: true, reason: null }, latestOperation: { id: id(7), type: 'created', actorUserId: null },
  } });
  expect(await port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toEqual(first);
});
it('forwards selectors, status, offset, page size and unpaged total', async () => {
  const h = harness();
  expect(await h.port.listCommerceFulfillmentOrders({ page: 2, pageSize: 1, status: 'created' })).toMatchObject({ totalCount: 3, page: 2, pageSize: 1 });
  expect(h.queries[0].values).toEqual(['created', 1, 1]);
  h.missing(); expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(20) })).toBeNull();
});
it('delegates hold, unpaid and missing inventory decisions to the existing policy', async () => {
  for (const [change, reason] of [
    [(h: ReturnType<typeof harness>) => { h.f.facts.holds = 1; }, 'active_hold'],
    [(h: ReturnType<typeof harness>) => { h.f.facts.payment.status = 'created'; }, 'payment_not_succeeded'],
    [(h: ReturnType<typeof harness>) => { h.f.facts.reservations = []; }, 'inventory_review'],
  ] as const) {
    const h = harness(); change(h);
    expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { omsEligibility: { allowed: false, reason } } });
  }
});
it('names unavailable facts and refuses an unrepresentable latest operation', async () => {
  for (const [change, name] of [
    [(h: ReturnType<typeof harness>) => { h.f.facts.lines = []; }, 'line_snapshot_unavailable'],
    [(h: ReturnType<typeof harness>) => { h.f.facts.payment.id = ''; }, 'payment_intent_unavailable'],
    [(h: ReturnType<typeof harness>) => { h.f.facts.order_context.metadata.orderDraftSnapshot.lines = []; }, 'line_snapshot_unavailable'],
    [(h: ReturnType<typeof harness>) => { h.f.facts.operation.operation_type = 'shipment_exception_raised'; }, 'operation_unrepresentable'],
    [(h: ReturnType<typeof harness>) => { h.f.facts.operation.payload = []; }, 'operation_unrepresentable'],
    [(h: ReturnType<typeof harness>) => { h.f.destination.clientId = id(99); }, 'destination_owner_mismatch'],
  ] as const) {
    const h = harness(); change(h);
    await expect(h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).rejects.toThrow(`native_fulfillment_${name}`);
  }
});
it('maps the supported native status-operation vocabulary and preserves payload', async () => {
  for (const [native, payload, expected] of [
    ['shipment_cancelled', { reason: 'operator' }, 'cancelled'],
    ['shipment_advanced', { toStatus: 'packed' }, 'packed'],
    ['shipment_advanced', { toStatus: 'handed_over' }, 'handed_over'],
    ['shipment_advanced', { toStatus: 'delivered' }, 'tracking_event_recorded'],
    ['evidence_recorded', { refRole: 'tracking' }, 'tracking_event_recorded'],
    ['evidence_recorded', { refRole: 'label' }, 'label_created'],
  ] as const) {
    const h = harness(); Object.assign(h.f.facts.operation, { operation_type: native, payload });
    expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { latestOperation: { type: expected, payload } } });
  }
});

it('uses the newest reservation summary without quantity coverage or duplicate-item refusals', async () => {
  const h = harness();
  h.f.facts.lines.push({ id: id(20), sku_id: id(21), line_ordinal: 2, quantity: 2 });
  h.f.facts.order_context.metadata.orderDraftSnapshot.lines.push({ sku: 'UNIT', title: 'Second', quantity: 2, opaque: 'second' });
  h.f.facts.reservations[0].lines[0].quantity = 1;
  h.f.facts.reservations.unshift({ ...h.f.facts.reservations[0], id: id(22), status: 'released' });
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: {
    inventory: { status: 'released', reservationId: id(22), reservationStatus: 'released', expiresAt: '2026-11-04T00:00:00.000Z' },
    omsEligibility: { reason: 'inventory_review' },
  } });
  h.f.facts.reservations.reverse();
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: {
    inventory: { status: 'reserved', reservationId: id(8), reservationStatus: 'reserved', expiresAt: '2026-11-04T00:00:00.000Z' },
  } });
});

it('retains list and detail contracts, defaults, bounds, empty results and missing selectors', async () => {
  const h = harness();
  const request = adminCommerceFulfillmentOrdersListRequestSchema.parse({});
  expect(request).toEqual({ page: 1, pageSize: 25 });
  expect(adminCommerceFulfillmentOrdersListRequestSchema.parse({ page: '2', pageSize: '1', status: 'created' })).toEqual({ page: 2, pageSize: 1, status: 'created' });
  for (const invalid of [{ page: 0 }, { pageSize: 101 }, { page: 1.5 }, { status: 'unknown' }]) {
    expect(adminCommerceFulfillmentOrdersListRequestSchema.safeParse(invalid).success).toBe(false);
  }
  expect(adminCommerceFulfillmentOrderDetailRequestSchema.parse({ fulfillmentOrderId: id(1), orderId: id(2) })).toEqual({ fulfillmentOrderId: id(1), orderId: id(2) });
  expect(adminCommerceFulfillmentOrderDetailRequestSchema.safeParse({}).success).toBe(false);
  const detail = adminCommerceFulfillmentOrderDetailResponseSchema.parse(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) }));
  const list = adminCommerceFulfillmentOrdersListResponseSchema.parse(await h.port.listCommerceFulfillmentOrders(request));
  expect(list).toEqual({ contractVersion: 'commerce.fulfillment.v0', orders: [detail.order], totalCount: 3, page: 1, pageSize: 25 });
  h.empty();
  expect(await h.port.listCommerceFulfillmentOrders({ page: 2, pageSize: 5 })).toEqual({ contractVersion: 'commerce.fulfillment.v0', orders: [], totalCount: 0, page: 2, pageSize: 5 });
  h.missing(); expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(99) })).toBeNull();
});

it.each(['created', 'packed', 'label_pending', 'label_created', 'handed_over', 'in_transit', 'delivered', 'exception', 'cancelled'])(
  'preserves the fulfillment status %s in both reads', async status => {
    const h = harness(); h.f.shipment.status = status;
    const detail = adminCommerceFulfillmentOrderDetailResponseSchema.parse(await h.port.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: id(1) }));
    const list = adminCommerceFulfillmentOrdersListResponseSchema.parse(await h.port.listCommerceFulfillmentOrders({ page: 1, pageSize: 25 }));
    expect(detail.order.status).toBe(status); expect(list.orders).toEqual([detail.order]);
  },
);

it('keeps exactly the public address fields and a null latest operation', async () => {
  const h = harness(); h.f.facts.operation.id = '';
  Object.assign(h.f.destination.address, { recipientName: 'Synthetic recipient', contactPhone: 'private', deliveryNotes: 'private', courierInstructions: 'private' });
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: {
    shippingAddress: { addressId: null, clientId: id(3), label: null, line1: 'Unit street', line2: null, city: 'Fixture', postalCode: '00000', country: 'ZZ' },
    latestOperation: null,
  } });
  const detail = adminCommerceFulfillmentOrderDetailResponseSchema.parse(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) }));
  expect(Object.keys(detail.order.shippingAddress).sort()).toEqual(['addressId', 'clientId', 'label', 'line1', 'line2', 'city', 'postalCode', 'country'].sort());
});

it('passes hold and cycle facts to the existing policy and preserves succeeded payment', async () => {
  const h = harness(); h.f.facts.payment.status = 'succeeded';
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { omsEligibility: { allowed: true, reason: null } } });
  expect(h.evaluate).toHaveBeenLastCalledWith({ orderMode: 'one_time', orderStatus: 'paid', paymentStatus: 'succeeded', subscriptionCycleStatus: null, activeHoldCount: 0, hasShippingAddress: true, inventoryStatus: 'reserved' });
  h.f.facts.order_context.subscription_cycle_id = id(30); h.f.facts.cycle = { status: 'retry_scheduled' }; h.f.facts.holds = 1;
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { payment: { paymentStatus: 'succeeded' }, omsEligibility: { allowed: false, reason: 'active_hold' } } });
  expect(h.evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ activeHoldCount: 1, subscriptionCycleStatus: 'retry_scheduled' }));
  h.f.facts.holds = 0;
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { omsEligibility: { allowed: false, reason: 'subscription_cycle_not_paid' } } });
  h.f.facts.cycle.status = 'paid';
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { omsEligibility: { allowed: true, reason: null } } });
  h.f.facts.reservations = [];
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: {
    inventory: { status: 'missing', reservationId: null, reservationStatus: null, expiresAt: null, locationId: null, locationCode: null },
    omsEligibility: { allowed: false, reason: 'inventory_review' },
  } });
});

it.each(['not_started', 'created', 'requires_action', 'processing', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded', 'disputed'])(
  'keeps the existing payment eligibility refusal for %s', async status => {
    const h = harness(); h.f.facts.payment.status = status;
    expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { payment: { paymentStatus: status }, omsEligibility: { allowed: false, reason: 'payment_not_succeeded' } } });
  },
);

it('keeps the existing GET, authorization, success envelope and missing-id response', async () => {
  const h = harness(), res = responseFixture();
  const authorizeAdmin = vi.fn(async () => ({ ok: true as const, userId: 'operator' }));
  const deps = { respond: createBffResponder(), authorizeAdmin, fulfillmentPort: h.port, responseSchemas: nativeFulfillmentCommerceResponseSchemas };
  const list = createAdminCommerceFulfillmentOrdersListHandler(deps);
  await list({ method: 'POST', query: {} }, res.response);
  expect(authorizeAdmin).not.toHaveBeenCalled(); expect(h.queries).toHaveLength(0);
  const refused = createAdminCommerceFulfillmentOrdersListHandler({ ...deps, authorizeAdmin: async () => ({ ok: false as const, code: 'UNAUTHORIZED' as const, message: 'Authorization required' }) });
  await refused({ method: 'GET', query: {} }, res.response);
  expect(res.output()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } }); expect(h.queries).toHaveLength(0);
  await list({ method: 'GET', query: {} }, res.response);
  expect(res.output()).toMatchObject({ ok: true, data: { contractVersion: 'commerce.fulfillment.v0', page: 1, pageSize: 25, totalCount: 3 } });
  expect(h.queries[0].values).toEqual([null, 25, 0]);
  const detail = createAdminCommerceFulfillmentOrderDetailHandler(deps);
  await detail({ method: 'GET', query: { fulfillmentOrderId: id(1), orderId: id(99) } }, res.response);
  expect(res.output()).toMatchObject({ ok: true, data: { order: { id: id(1) } } });
  expect(h.queries.at(-2)?.values).toEqual([id(1), null]);
  h.missing(); await detail({ method: 'GET', query: { orderId: id(99) } }, res.response);
  expect(res.output()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

it('forwards stored expiry and string timestamps without interpreting the clock', async () => {
  const h = harness();
  h.f.shipment.created_at = '2026-06-05T10:00:00.123456+00:00';
  h.f.shipment.updated_at = '2026-06-05T10:01:00.654321+00:00';
  h.f.facts.reservations[0].expires_at = '2020-01-01T00:00:00+00:00';
  h.f.facts.reservations[0].elapsed = true;
  const detail = adminCommerceFulfillmentOrderDetailResponseSchema.parse(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) }));
  const list = adminCommerceFulfillmentOrdersListResponseSchema.parse(await h.port.listCommerceFulfillmentOrders({ page: 1, pageSize: 25 }));
  expect(list.orders).toEqual([detail.order]);
  expect(detail.order).toMatchObject({ clientId: null, providerKind: null,
    createdAt: '2026-06-05T10:00:00.123456+00:00', updatedAt: '2026-06-05T10:01:00.654321+00:00',
    inventory: { status: 'reserved', expiresAt: '2020-01-01T00:00:00+00:00' },
  });
  expect(h.queries.map(q => q.sql).join(' ')).not.toMatch(/UNION ALL|CURRENT_TIMESTAMP|s\.created_at DESC|op\.id DESC|r\.id DESC|recorded_at DESC,id DESC/);
});

it('takes the order mode from host configuration rather than inferring it from a cycle id', async () => {
  const orderMode = vi.fn(() => 'subscription_cycle' as const);
  const h = harness(orderMode);
  expect(await h.port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).toMatchObject({ order: { omsEligibility: { allowed: false, reason: 'subscription_cycle_not_paid' } } });
  expect(orderMode).toHaveBeenCalledExactlyOnceWith({ orderId: id(2), subscriptionCycleId: null, capturedMode: 'one_time' });
});

it('executes the compiled public factory from local tarballs offline with an empty cache and normally', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const scratch = mkdtempSync(join(tmpdir(), 'native-fulfillment-consumer-'));
  const root = resolve(import.meta.dirname, '../../../..');
  const npm = (args: string[], cwd: string) => execFileSync('npm', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  try {
    const tarballs = ['packages/core', 'packages/platform', 'node_modules/zod'].map(dir => {
      const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], join(root, dir)));
      return join(scratch, packed[0].filename);
    });
    for (const mode of ['offline', 'normal']) {
      const consumer = join(scratch, mode), cache = join(scratch, `${mode}-cache`);
      mkdirSync(consumer); mkdirSync(cache);
      writeFileSync(join(consumer, 'package.json'), '{"type":"module","private":true}');
      npm(['install', ...(mode === 'offline' ? ['--offline'] : []), '--cache', cache, '--ignore-scripts', '--legacy-peer-deps', '--omit=optional', '--no-audit', '--no-fund', ...tarballs], consumer);
      writeFileSync(join(consumer, 'proof.mjs'), `
        import assert from 'node:assert/strict';
        import {createPostgresFulfillmentCommerceReadPort} from '@openlup/platform/fulfillment/native';
        import {evaluateCommerceFulfillmentEligibility} from '@openlup/platform/commerce';
        const f=${JSON.stringify(fixture())};
        assert(import.meta.resolve('@openlup/platform/fulfillment/native').startsWith(new URL('./node_modules/',import.meta.url).href));
        const port=createPostgresFulfillmentCommerceReadPort({executor:{async query(sql){return {rows:sql.startsWith('SELECT to_jsonb(s)')?[{shipment:f.shipment}]:sql.startsWith('SELECT public.commerce_view_shipment_destination')?[{value:{...f.destination,revision:1,pinned:false}}]:[f.facts]}}},policy:{evaluateCommerceFulfillmentEligibility},orderMode:()=> 'one_time'});
        const result=await port.getCommerceFulfillmentOrderDetail({orderId:f.shipment.order_id});
        assert.equal(result.order.id,f.shipment.id);
        assert.equal(result.order.shippingAddress.addressId,null);
        assert.equal(result.order.payment.paymentStatus,'succeeded');
        assert.equal(result.order.omsEligibility.allowed,true);
        assert.equal(result.order.lines[0].productSnapshot.opaque,'retained');
      `);
      execFileSync('node', ['proof.mjs'], { cwd: consumer, encoding: 'utf8', timeout: 30_000 });
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);

function managedInput(): Parameters<typeof buildCommerceFulfillmentOrderDetailResponse>[0] {
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

const managedExpected = {
  "contractVersion": "commerce.fulfillment.v0",
  "order": {
    "id": "52222222-2222-4222-8222-222222222221",
    "orderId": "42222222-2222-4222-8222-222222222221",
    "clientId": "12222222-2222-4222-8222-222222222221",
    "status": "label_created",
    "providerKind": "warehouse",
    "providerTrackingId": "TRACK-1",
    "shippingAddress": {
      "addressId": "32222222-2222-4222-8222-222222222221",
      "clientId": "12222222-2222-4222-8222-222222222221",
      "label": "Home",
      "line1": "Example Street 1",
      "line2": null,
      "city": "Example City",
      "postalCode": "00-001",
      "country": "XX"
    },
    "lines": [
      {
        "id": "62222222-2222-4222-8222-222222222221",
        "orderItemId": "72222222-2222-4222-8222-222222222221",
        "skuId": "82222222-2222-4222-8222-222222222221",
        "sku": "ITEM-1",
        "title": "Item",
        "quantity": 2,
        "inventoryReservationIds": [
          "92222222-2222-4222-8222-222222222221"
        ],
        "productSnapshot": {}
      }
    ],
    "payment": {
      "paymentIntentId": "a2222222-2222-4222-8222-222222222221",
      "paymentStatus": "succeeded",
      "providerPaymentId": "pay_1"
    },
    "inventory": {
      "status": "reserved",
      "reservationId": "92222222-2222-4222-8222-222222222221",
      "reservationStatus": "reserved",
      "expiresAt": "2026-06-05T10:30:00+00:00",
      "locationId": "b2222222-2222-4222-8222-222222222221",
      "locationCode": "main"
    },
    "omsEligibility": {
      "allowed": true,
      "reason": null
    },
    "latestOperation": {
      "id": "c2222222-2222-4222-8222-222222222221",
      "type": "created",
      "occurredAt": "2026-06-05T10:00:00+00:00",
      "actorUserId": null,
      "payload": {}
    },
    "createdAt": "2026-06-05T10:00:00+00:00",
    "updatedAt": "2026-06-05T10:01:00+00:00"
  }
};
function managedListInput(input = managedInput()) {
  return { fulfillmentOrders: [input.fulfillmentOrder], lines: input.lines, latestOperations: [input.latestOperation!],
    orderContexts: [input.orderContext], paymentIntents: [input.paymentIntent], inventoryReservations: input.inventoryReservations,
    shipmentRefs: [input.shipmentRef!], activeHoldCounts: {}, subscriptionCycleStatuses: {}, totalCount: 1, page: 1, pageSize: 25 };
}
function schemaCases() {
  const order = managedExpected.order;
  return [
    ['valid', {}, true],
    ['null-address', { shippingAddress: { ...order.shippingAddress, addressId: null } }, false],
    ['missing-address', { shippingAddress: Object.fromEntries(Object.entries(order.shippingAddress).filter(([k]) => k !== 'addressId')) }, false],
    ['invalid-address', { shippingAddress: { ...order.shippingAddress, addressId: 'invalid' } }, false],
    ['invalid-client', { clientId: 'invalid' }, false],
    ['invalid-status', { status: 'unknown' }, false],
    ['empty-lines', { lines: [] }, false],
    ['invalid-payment', { payment: { ...order.payment, paymentStatus: 'unknown' } }, false],
    ['invalid-inventory', { inventory: { ...order.inventory, status: 'unknown' } }, false],
    ['invalid-operation', { latestOperation: { ...order.latestOperation, type: 'unknown' } }, false],
    ['invalid-time', { createdAt: 'invalid' }, false],
    ['extra-field', { extra: true }, false],
    ['invalid-city', { shippingAddress: { ...order.shippingAddress, city: '' } }, false],
    ['missing-country', { shippingAddress: Object.fromEntries(Object.entries(order.shippingAddress).filter(([k]) => k !== 'country')) }, false],
  ] as const;
}
it.each(schemaCases())('preserves managed row, list, detail and default handler validation for %s', async (name, patch, expected) => {
  const order = { ...managedExpected.order, ...patch };
  const detail = { ...managedExpected, order }, list = { contractVersion: 'commerce.fulfillment.v0', orders: [order], totalCount: 1, page: 1, pageSize: 25 };
  expect(commerceFulfillmentOrderSchema.safeParse(order).success).toBe(expected);
  expect(managedDetailSchema.safeParse(detail).success).toBe(expected);
  expect(managedListSchema.safeParse(list).success).toBe(expected);
  const nativeExpected = name === 'null-address' || expected;
  expect(nativeFulfillmentCommerceResponseSchemas.order.safeParse(order).success).toBe(nativeExpected);
  expect(nativeFulfillmentCommerceResponseSchemas.detail.safeParse(detail).success).toBe(nativeExpected);
  expect(nativeFulfillmentCommerceResponseSchemas.list.safeParse(list).success).toBe(nativeExpected);
  const factory = createCommerceFulfillmentResponseSchemas(commerceFulfillmentShippingAddressSnapshotSchema);
  expect(factory.list.safeParse(list).success).toBe(expected);
  expect(factory.detail.safeParse(detail).success).toBe(expected);
  const fulfillmentPort = { listCommerceFulfillmentOrders: vi.fn().mockResolvedValue(list), getCommerceFulfillmentOrderDetail: vi.fn().mockResolvedValue(detail) };
  for (const kind of ['list', 'detail'] as const) {
    const res = responseFixture();
    const deps = { authorizeAdmin: async () => ({ ok: true as const, userId: 'operator' }), respond: createBffResponder(), fulfillmentPort };
    const handler = kind === 'list' ? createAdminCommerceFulfillmentOrdersListHandler(deps) : createAdminCommerceFulfillmentOrderDetailHandler(deps);
    await handler({ method: 'GET', query: kind === 'list' ? {} : { orderId: managedExpected.order.orderId } }, res.response);
    expect(res.output()).toEqual(expected ? { ok: true, data: kind === 'list' ? list : detail } : expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'INVALID_RESPONSE' }) }));
  }
});
it.each([['bad-version', { contractVersion: 'invalid' }, false], ['extra-envelope', { extra: true }, false], ['valid-envelope', {}, true]] as const)(
  'preserves list and detail envelope validation for %s', (_name, patch, expected) => {
    const detail = { ...managedExpected, ...patch };
    const list = { contractVersion: 'commerce.fulfillment.v0', orders: [managedExpected.order], totalCount: 1, page: 1, pageSize: 25, ...patch };
    for (const schemas of [{ list: managedListSchema, detail: managedDetailSchema }, nativeFulfillmentCommerceResponseSchemas]) {
      expect(schemas.list.safeParse(list).success).toBe(expected);
      expect(schemas.detail.safeParse(detail).success).toBe(expected);
    }
  },
);
it('preserves default builder outputs and distinguishes saved-address gates from explicit destination facts', () => {
  const policy = { evaluateCommerceFulfillmentEligibility };
  const input = managedInput();
  expect(buildCommerceFulfillmentOrderDetailResponse(input, policy)).toEqual(managedExpected);
  expect(buildCommerceFulfillmentOrdersListResponse(managedListInput(input), policy)).toEqual({ contractVersion: 'commerce.fulfillment.v0', orders: [managedExpected.order], totalCount: 1, page: 1, pageSize: 25 });
  const absent = { ...input, orderContext: { ...input.orderContext, shipping_address_id: null } };
  const missing = { allowed: false, reason: 'missing_shipping_address' };
  const absentExpected = { ...managedExpected, order: { ...managedExpected.order, omsEligibility: missing } };
  expect(buildCommerceFulfillmentOrderDetailResponse(absent, policy)).toEqual(absentExpected);
  expect(buildCommerceFulfillmentOrdersListResponse(managedListInput(absent), policy)).toEqual({ contractVersion: 'commerce.fulfillment.v0', orders: [absentExpected.order], totalCount: 1, page: 1, pageSize: 25 });
  expect(buildCommerceFulfillmentOrderDetailResponse({ ...input, hasShippingAddress: false }, policy).order.omsEligibility).toEqual(missing);
  expect(buildCommerceFulfillmentOrdersListResponse({ ...managedListInput(input), hasShippingAddress: { [input.orderContext.id]: false } }, policy).orders[0].omsEligibility).toEqual(missing);
  const native = { ...absent, fulfillmentOrder: { ...absent.fulfillmentOrder, shipping_address_snapshot: { ...absent.fulfillmentOrder.shipping_address_snapshot, addressId: null } } };
  const detail = buildCommerceFulfillmentOrderDetailResponse({ ...native, hasShippingAddress: true, responseSchemas: nativeFulfillmentCommerceResponseSchemas }, policy);
  const list = buildCommerceFulfillmentOrdersListResponse({ ...managedListInput(absent), fulfillmentOrders: [native.fulfillmentOrder], hasShippingAddress: { [input.orderContext.id]: true }, responseSchemas: nativeFulfillmentCommerceResponseSchemas }, policy);
  expect(detail.order.shippingAddress.addressId).toBeNull();
  expect(detail.order.omsEligibility).toEqual({ allowed: true, reason: null });
  expect(list.orders).toEqual([detail.order]);
});
it('refuses a destination that cannot be resolved without manufacturing an address identity', async () => {
  const port = createPostgresFulfillmentCommerceReadPort({ executor: { async query(sql) { const f = fixture(); return { rows: sql.startsWith('SELECT to_jsonb(s)') ? [{ shipment: f.shipment }] : [f.facts] }; } },
    destinations: { async read() { throw new Error('commerce_destination_unavailable'); } }, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
  await expect(port.getCommerceFulfillmentOrderDetail({ orderId: id(2) })).rejects.toThrow('native_fulfillment_destination_unavailable');
});

it('uses the default shipment view and keeps routine-only fields out of the response', async () => {
  const f = fixture(), query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('SELECT public.commerce_view_shipment_destination')) {
      expect(sql).toBe('SELECT public.commerce_view_shipment_destination($1::uuid) AS value');
      expect(values).toEqual([f.shipment.id]);
      return { rows: [{ value: { ...f.destination, revision: 1, pinned: false } }] };
    }
    return { rows: sql.startsWith('SELECT to_jsonb(s)') ? [{ shipment: f.shipment }] : [f.facts] };
  });
  const port = createPostgresFulfillmentCommerceReadPort({ executor: { query }, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
  const detail = nativeFulfillmentCommerceResponseSchemas.detail.parse(await port.getCommerceFulfillmentOrderDetail({ orderId: id(2) }));
  expect(detail.order.shippingAddress).toEqual({ addressId: null, clientId: f.destination.clientId, ...f.destination.address });
});
it.each([
  ['commerce_destination_unavailable', 'native_fulfillment_destination_unavailable'],
  ['commerce_destination_owner_mismatch', 'native_fulfillment_destination_owner_mismatch'],
  ['commerce_destination_frozen_ref_invalid', null],
] as const)('handles the default view refusal %s', async (message, mapped) => {
  const failure = new Error(message), f = fixture();
  const port = createPostgresFulfillmentCommerceReadPort({ executor: { async query(sql) {
    if (sql.startsWith('SELECT public.commerce_view_shipment_destination')) throw failure;
    return { rows: sql.startsWith('SELECT to_jsonb(s)') ? [{ shipment: f.shipment }] : [f.facts] };
  } }, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
  const result = port.getCommerceFulfillmentOrderDetail({ orderId: id(2) });
  if (mapped) await expect(result).rejects.toThrow(mapped);
  else await expect(result).rejects.toBe(failure);
});
