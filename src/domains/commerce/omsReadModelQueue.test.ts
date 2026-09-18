import { describe, expect, it } from "vitest";
import {
  buildOmsOrderDetailResponse,
  buildOmsOrderListResponse,
  type OmsOrderRow,
} from "./omsReadModel.js";

const order: OmsOrderRow = {
  id: "42222222-2222-4222-8222-222222222221",
  order_number: "V-1001",
  client_id: "41111111-1111-4111-8111-111111111111",
  status: "paid",
  mode: "subscription_cycle",
  currency: "PLN",
  subtotal_cents: 12900,
  discount_cents: 0,
  shipping_cents: 0,
  shipping_discount_cents: 0,
  tax_cents: 956,
  total_cents: 12900,
  metadata: null,
  created_at: "2026-06-05T10:00:00+00:00",
  updated_at: "2026-06-05T10:01:00+00:00",
  subscription_id: "43333333-3333-4333-8333-333333333333",
  subscription_cycle_id: "44444444-4444-4444-8444-444444444444",
  shipping_address_id: "45555555-5555-4555-8555-555555555555",
};

describe("commerce OMS queue read model", () => {
  it("emits fulfillment_blocked when eligibility is blocked after payment, address, and inventory pass", () => {
    const orderItemId = "e2222222-2222-4222-8222-222222222221";
    const response = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      orderItems: [orderItem(orderItemId)],
      inventoryReservations: [reservation(orderItemId, "reserved", "2026-06-05T10:30:00+00:00")],
      subscriptionCycleStatuses: { [order.subscription_cycle_id ?? ""]: "payment_pending" },
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      attentionReason: "fulfillment_blocked",
      nextAction: "review_fulfillment",
    });
    expect(response.summaryCounts.fulfillmentBlocked).toBe(1);
  });

  it("attaches backend search match evidence to list orders", () => {
    const response = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      searchMatches: {
        [order.id]: { field: "email", label: "Email", valuePreview: "ja***@example.com" },
      },
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0].match).toEqual({
      field: "email",
      label: "Email",
      valuePreview: "ja***@example.com",
    });
  });

  it("treats consumed reservations as inventory coverage for completed fulfillment state", () => {
    const orderItemId = "e2222222-2222-4222-8222-222222222221";
    const response = buildOmsOrderDetailResponse({
      order: { ...order, mode: "one_time", subscription_id: null, subscription_cycle_id: null },
      paymentIntent: paymentIntent(),
      paymentAttempts: [],
      paymentTransitions: [],
      holds: [],
      operations: [],
      orderItems: [orderItem(orderItemId)],
      inventoryReservations: [reservation(orderItemId, "consumed", null)],
      subscriptionCycleStatus: null,
    });

    expect(response.order.inventory.status).toBe("consumed");
    expect(response.order.fulfillmentEligibility).toMatchObject({ allowed: true });
  });

  it("hydrates OmniPack provider ops status and SLA on list rows", () => {
    const response = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      fulfillmentOrders: [{
        id: "f2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "label_created",
        provider_kind: "omnipack",
      }],
      omnipackDispatchRefs: [{
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        provider_order_id: "OP-1001",
        dispatch_mode: "stage",
        status: "created",
        error: null,
        created_at: "2026-07-05T09:00:00.000Z",
        updated_at: "2026-07-05T09:00:00.000Z",
      }],
      omnipackStatusEvidence: [],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      providerOpsStatus: "omnipack_dispatched_not_picked",
      providerOrderId: "OP-1001",
      providerOpsSla: {
        dispatchedAt: "2026-07-05T09:00:00.000Z",
      },
    });
    expect(response.summaryCounts.omnipackDispatchedNotPicked).toBe(1);
  });

  it("carries per-order hold reasons and health digests onto list rows, and stays quiet without them", () => {
    // Both diagnostics arrive as per-order maps from the read that owns their
    // source rows, the way `activeHoldCounts` already does. A row the maps do not
    // mention must render exactly as it did before this wave rather than
    // borrowing another order's diagnosis.
    const sibling = { ...order, id: "42222222-2222-4222-8222-222222222299", order_number: "V-1002" };
    const response = buildOmsOrderListResponse({
      orders: [order, sibling],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: { [order.id]: 2 },
      activeHoldReasons: { [order.id]: ["fulfillment_exception", "manual_support"] },
      fulfillmentHealthDigests: {
        [order.id]: { healthStatus: "needs_attention", attentionReasons: ["provider_exception_after_delivery"] },
      },
      totalCount: 2,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      attentionReason: "active_hold",
      activeHoldCount: 2,
      activeHoldReasons: ["fulfillment_exception", "manual_support"],
      fulfillmentHealthDigest: { healthStatus: "needs_attention", attentionReasons: ["provider_exception_after_delivery"] },
    });
    expect(response.orders[1]).toMatchObject({
      activeHoldCount: 0,
      activeHoldReasons: [],
      fulfillmentHealthDigest: { healthStatus: "ok", attentionReasons: [] },
    });
  });

  it("projects canonical provider chronology without changing the durable fulfillment FSM", () => {
    const acceptedDispatchOnly = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      fulfillmentOrders: [{
        id: "f2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "created",
        provider_kind: "omnipack",
      }],
      omnipackDispatchRefs: [{
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        provider_order_id: "OP-ACCEPTED",
        status: "created",
        created_at: "2026-06-05T10:05:00.000Z",
        updated_at: "2026-06-05T10:05:00.000Z",
      }],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });
    const providerAhead = buildOmsOrderListResponse({
      orders: [order],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      fulfillmentOrders: [{
        id: "f2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "created",
        provider_kind: "omnipack",
      }],
      omnipackStatusEvidence: [{
        fulfillment_order_id: "f2222222-2222-4222-8222-222222222221",
        provider_status: "NEW",
        local_status: "provider_received",
        evidence_kind: "webhook",
        occurred_at: "2026-06-05T10:10:00.000Z",
      }],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });
    const delivered = {
      id: "f2222222-2222-4222-8222-222222222221",
      order_id: order.id,
      status: "delivered" as const,
      provider_kind: "omnipack",
      delivered_at: "2026-06-05T10:30:00.000Z",
    };
    const afterDelivery = buildOmsOrderListResponse({
      orders: [{ ...order, status: "fulfilled" }],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      fulfillmentOrders: [delivered],
      omnipackStatusEvidence: [{
        fulfillment_order_id: delivered.id,
        provider_status: "RETURNED_TO_SENDER",
        local_status: "exception",
        evidence_kind: "webhook",
        occurred_at: "2026-06-05T10:31:00.000Z",
      }],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });
    const staleException = buildOmsOrderListResponse({
      orders: [{ ...order, status: "fulfilled" }],
      paymentIntents: [paymentIntent()],
      activeHoldCounts: {},
      fulfillmentOrders: [delivered],
      omnipackStatusEvidence: [{
        fulfillment_order_id: delivered.id,
        provider_status: "RETURNED_TO_SENDER",
        local_status: "exception",
        evidence_kind: "webhook",
        occurred_at: "2026-06-05T10:29:00.000Z",
      }],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(acceptedDispatchOnly.orders[0]).toMatchObject({
      fulfillmentStatus: "created",
      customerFulfillmentStep: "paid",
    });
    expect(acceptedDispatchOnly.orders[0]?.customerFulfillmentStep).not.toBe("transit");
    expect(providerAhead.orders[0]).toMatchObject({
      fulfillmentStatus: "created",
      customerFulfillmentStep: "accepted",
    });
    expect(afterDelivery.orders[0]).toMatchObject({
      fulfillmentStatus: "delivered",
      customerFulfillmentStep: "exception",
    });
    expect(staleException.orders[0]).toMatchObject({
      fulfillmentStatus: "delivered",
      customerFulfillmentStep: "delivered",
    });
  });

  it("reflects reservation sweep expiry from canonical order, payment, and inventory rows", () => {
    const orderItemId = "e2222222-2222-4222-8222-222222222221";
    const response = buildOmsOrderListResponse({
      orders: [{
        ...order,
        status: "expired",
        mode: "one_time",
        subscription_id: null,
        subscription_cycle_id: null,
        updated_at: "2026-06-05T12:01:00+00:00",
      }],
      paymentIntents: [{
        ...paymentIntent(),
        status: "cancelled",
        updated_at: "2026-06-05T12:01:00+00:00",
      }],
      activeHoldCounts: {},
      orderItems: [orderItem(orderItemId)],
      inventoryReservations: [reservation(orderItemId, "released", "2026-06-05T12:00:00+00:00")],
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders[0]).toMatchObject({
      status: "expired",
      paymentStatus: "cancelled",
      inventoryStatus: "released",
      attentionReason: "payment_required",
      nextAction: "review_payment",
    });
    expect(response.summaryCounts.paymentIssues).toBe(1);
  });
});

function paymentIntent() {
  return {
    id: "52222222-2222-4222-8222-222222222221",
    order_id: order.id,
    payment_id: "62222222-2222-4222-8222-222222222221",
    status: "succeeded" as const,
    active_attempt_id: null,
    provider_payment_id: null,
    updated_at: "2026-06-05T10:01:00+00:00",
  };
}

function orderItem(id: string) {
  return {
    id,
    order_id: order.id,
    quantity: 1,
    unit_price_cents: 12900,
    total_cents: 12900,
    discount_allocated_cents: 0,
    effective_total_cents: 12900,
    effective_net_cents: 11944,
    vat_rate_bps: 800,
  };
}

function reservation(orderItemId: string, status: "reserved" | "consumed" | "released", expiresAt: string | null) {
  return {
    id: "b2222222-2222-4222-8222-222222222221",
    order_id: order.id,
    order_item_id: orderItemId,
    quantity: 1,
    status,
    expires_at: expiresAt,
    location_id: "c2222222-2222-4222-8222-222222222221",
    inventory_locations: { code: "pl-main" },
  };
}
