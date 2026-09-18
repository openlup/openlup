import { describe, expect, it } from "vitest";
import { buildOmsOrderDetailResponse, type OmsOrderRow } from "./omsReadModel.js";

const order: OmsOrderRow = {
  id: "42222222-2222-4222-8222-222222222221",
  order_number: "V-1001",
  client_id: "41111111-1111-4111-8111-111111111111",
  status: "paid",
  mode: "one_time",
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
  subscription_id: null,
  subscription_cycle_id: null,
  shipping_address_id: "45555555-5555-4555-8555-555555555555",
};

describe("commerce OMS fulfillment action eligibility", () => {
  it("returns flag-aware action eligibility from the read model", () => {
    const response = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("created"),
      actionFlags: {
        holdMutationsEnabled: false,
        supportMutationsEnabled: false,
        fulfillmentMutationsEnabled: false,
        refundMutationsEnabled: false,
        orderCancellationEnabled: false,
      },
    });

    expect(response.order.actionEligibility).toMatchObject({
      addNote: { allowed: false, reason: "oms_support_mutations_disabled" },
      createHold: { allowed: false, reason: "oms_hold_mutations_disabled" },
      recordLabel: { allowed: false, reason: "commerce_fulfillment_mutations_disabled" },
      cancelFulfillment: { allowed: false, reason: "commerce_fulfillment_mutations_disabled" },
      cancelOrder: { allowed: false, reason: "oms_order_cancellation_disabled" },
      markRefunded: { allowed: false, reason: "oms_refund_mutations_disabled" },
    });
  });

  it("scopes markRefunded to paid orders only", () => {
    const paid = buildOmsOrderDetailResponse(detailInputForFulfillment("created"));
    expect(paid.order.actionEligibility.markRefunded).toEqual({ allowed: true, reason: null });

    const refunded = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("created"),
      order: { ...order, status: "refunded" },
    });
    expect(refunded.order.actionEligibility.markRefunded).toEqual({ allowed: false, reason: "already_refunded" });

    const pendingPayment = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("created"),
      order: { ...order, status: "pending_payment" },
    });
    expect(pendingPayment.order.actionEligibility.markRefunded).toEqual({ allowed: false, reason: "order_not_paid" });
  });

  it("scopes order cancellation to unpaid pending-payment orders only", () => {
    const pendingPayment = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("created"),
      order: { ...order, status: "pending_payment" },
    });
    expect(pendingPayment.order.actionEligibility.cancelOrder).toEqual({ allowed: true, reason: null });

    const paid = buildOmsOrderDetailResponse(detailInputForFulfillment("created"));
    expect(paid.order.actionEligibility.cancelOrder).toEqual({ allowed: false, reason: "order_not_pending_payment" });
  });

  it("keeps fulfillment commands scoped to safe statuses", () => {
    const created = buildOmsOrderDetailResponse(detailInputForFulfillment("created"));
    expect(created.order.actionEligibility).toMatchObject({
      recordLabel: { allowed: true, reason: null },
      recordTrackingEvent: { allowed: false, reason: "tracking_not_ready" },
      cancelFulfillment: { allowed: true, reason: null },
    });

    const handedOver = buildOmsOrderDetailResponse(detailInputForFulfillment("handed_over"));
    expect(handedOver.order.actionEligibility).toMatchObject({
      recordTrackingEvent: { allowed: true, reason: null },
      cancelFulfillment: { allowed: false, reason: "fulfillment_not_cancellable" },
    });
  });

  it("enables the existing cancel action after confirmed OmniPack cancellation and hold release", () => {
    const confirmed = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("exception"),
      omnipackStatusEvidence: [{
        fulfillment_order_id: "d2222222-2222-4222-8222-222222222221",
        provider_status: "CANCELLED",
        occurred_at: "2026-06-05T11:00:00+00:00",
      }],
    });
    expect(confirmed.order.actionEligibility.cancelFulfillment).toEqual({ allowed: true, reason: null });

    const held = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("exception"),
      holds: [{
        id: "a2222222-2222-4222-8222-222222222221",
        order_id: order.id,
        status: "active",
        reason: "fulfillment_exception",
        note: null,
        created_at: "2026-06-05T11:00:00+00:00",
        released_at: null,
      }],
      omnipackStatusEvidence: [{
        fulfillment_order_id: "d2222222-2222-4222-8222-222222222221",
        provider_status: "CANCELLED",
        occurred_at: "2026-06-05T11:00:00+00:00",
      }],
    });
    expect(held.order.actionEligibility.cancelFulfillment).toEqual({ allowed: false, reason: "fulfillment_not_cancellable" });

    const superseded = buildOmsOrderDetailResponse({
      ...detailInputForFulfillment("exception"),
      omnipackStatusEvidence: [{
        fulfillment_order_id: "d2222222-2222-4222-8222-222222222221",
        provider_status: "CANCELLED",
        occurred_at: "2026-06-05T11:00:00+00:00",
      }, {
        fulfillment_order_id: "d2222222-2222-4222-8222-222222222221",
        provider_status: "SHIPPING",
        occurred_at: "2026-06-05T11:01:00+00:00",
      }],
    });
    expect(superseded.order.actionEligibility.cancelFulfillment).toEqual({ allowed: false, reason: "fulfillment_not_cancellable" });
  });
});

function detailInputForFulfillment(status: "created" | "handed_over" | "exception") {
  const orderItemId = "e2222222-2222-4222-8222-222222222221";
  return {
    order,
    paymentIntent: {
      id: "52222222-2222-4222-8222-222222222221",
      order_id: order.id,
      payment_id: "62222222-2222-4222-8222-222222222221",
      status: "succeeded" as const,
      active_attempt_id: null,
      provider_payment_id: null,
      updated_at: "2026-06-05T10:01:00+00:00",
    },
    paymentAttempts: [],
    paymentTransitions: [],
    holds: [],
    operations: [],
    orderItems: [{
      id: orderItemId,
      quantity: 1,
      unit_price_cents: 12900,
      total_cents: 12900,
      discount_allocated_cents: 0,
      effective_total_cents: 12900,
      effective_net_cents: 11944,
      vat_rate_bps: 800,
    }],
    inventoryReservations: [{
      id: "b2222222-2222-4222-8222-222222222221",
      order_id: order.id,
      order_item_id: orderItemId,
      quantity: 1,
      status: "reserved" as const,
      expires_at: "2026-06-05T10:30:00+00:00",
      location_id: "c2222222-2222-4222-8222-222222222221",
      inventory_locations: { code: "pl-main" },
    }],
    fulfillmentOrders: [{
      id: "d2222222-2222-4222-8222-222222222221",
      order_id: order.id,
      status,
    }],
    fulfillmentOperations: [],
    subscriptionCycleStatus: null,
  };
}
