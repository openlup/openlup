import { describe, expect, it } from "vitest";
import {
  buildCommerceFulfillmentOrderDetailResponse,
  buildCommerceFulfillmentOrdersListResponse,
} from "./commerceFulfillmentReadModel";

describe("commerce fulfillment read model", () => {
  it("aggregates order, payment, inventory, OMS gate, and tracking refs", () => {
    const response = buildCommerceFulfillmentOrderDetailResponse(baseInput());

    expect(response.order).toMatchObject({
      orderId: "42222222-2222-4222-8222-222222222221",
      clientId: "12222222-2222-4222-8222-222222222221",
      providerTrackingId: "NOOP-TRACK-1",
      payment: { paymentStatus: "succeeded" },
      inventory: { status: "reserved" },
      omsEligibility: { allowed: true },
    });
  });

  it("lets OMS eligibility block fulfillment for active holds without inventing payment state", () => {
    const input = baseInput();
    input.activeHoldCount = 1;

    const response = buildCommerceFulfillmentOrderDetailResponse(input);

    expect(response.order.omsEligibility).toEqual({ allowed: false, reason: "active_hold" });
    expect(response.order.payment.paymentStatus).toBe("succeeded");
  });

  it("keeps fulfillment shipping snapshots on the public contract after address correction", () => {
    const input = baseInput();
    input.fulfillmentOrder.shipping_address_snapshot = {
      ...input.fulfillmentOrder.shipping_address_snapshot,
      recipientName: "Admin OMS Preview Updated",
      contactPhone: "+48123456789",
      companyName: null,
      taxId: null,
      deliveryNotes: "updated in OMS",
      courierInstructions: "preview correction",
    } as typeof input.fulfillmentOrder.shipping_address_snapshot;

    const response = buildCommerceFulfillmentOrderDetailResponse(input);

    expect(response.order.shippingAddress).toEqual({
      addressId: "32222222-2222-4222-8222-222222222221",
      clientId: "12222222-2222-4222-8222-222222222221",
      label: "Home",
      line1: "Prosta 1",
      line2: null,
      city: "Warszawa",
      postalCode: "00-001",
      country: "PL",
    });
    expect(response.order.shippingAddress).not.toHaveProperty("contactPhone");
    expect(response.order.shippingAddress).not.toHaveProperty("deliveryNotes");
  });

  it("builds paginated list responses from the same module facts", () => {
    const input = baseInput();
    const response = buildCommerceFulfillmentOrdersListResponse({
      fulfillmentOrders: [input.fulfillmentOrder],
      lines: input.lines,
      latestOperations: [input.latestOperation!],
      orderContexts: [input.orderContext],
      paymentIntents: [input.paymentIntent],
      inventoryReservations: input.inventoryReservations,
      shipmentRefs: [input.shipmentRef!],
      activeHoldCounts: {},
      subscriptionCycleStatuses: {},
      totalCount: 1,
      page: 1,
      pageSize: 25,
    });

    expect(response.orders).toHaveLength(1);
    expect(response.orders[0].latestOperation?.type).toBe("created");
  });
});

function baseInput() {
  return {
    fulfillmentOrder: {
      id: "52222222-2222-4222-8222-222222222221",
      order_id: "42222222-2222-4222-8222-222222222221",
      client_id: "12222222-2222-4222-8222-222222222221",
      status: "label_created" as const,
      provider_kind: "noop_shipping",
      shipping_address_snapshot: {
        addressId: "32222222-2222-4222-8222-222222222221",
        clientId: "12222222-2222-4222-8222-222222222221",
        label: "Home",
        line1: "Prosta 1",
        line2: null,
        city: "Warszawa",
        postalCode: "00-001",
        country: "PL",
      },
      created_at: "2026-06-05T10:00:00+00:00",
      updated_at: "2026-06-05T10:01:00+00:00",
    },
    lines: [{
      id: "62222222-2222-4222-8222-222222222221",
      fulfillment_order_id: "52222222-2222-4222-8222-222222222221",
      order_item_id: "72222222-2222-4222-8222-222222222221",
      sku_id: "82222222-2222-4222-8222-222222222221",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      title: "Lamb 400g",
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
      inventory_locations: { code: "pl-main" },
    }],
    shipmentRef: {
      order_id: "42222222-2222-4222-8222-222222222221",
      provider_tracking_id: "NOOP-TRACK-1",
      active: true,
      created_at: "2026-06-05T10:02:00+00:00",
    },
    activeHoldCount: 0,
    subscriptionCycleStatus: null,
  };
}
