import { describe, expect, it } from "vitest";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { Subscription } from "./subscriptionEditModel";
import { customerFulfillmentStep, orderPhaseIndex, selectInFlightDelivery } from "./orderFulfillment";

type Order = CustomerAccountV2Response["recentOrders"][number];

const SUB_ID = "sub-1";

function order(overrides: Partial<Order>): Order {
  return {
    orderId: "o1",
    subscriptionId: SUB_ID,
    status: "paid",
    fulfillmentStatus: "label_created",
    createdAt: "2026-07-08T08:49:09.000Z",
    trackingTimeline: [],
    ...overrides,
  } as unknown as Order;
}

function account(orders: Order[]): CustomerAccountV2Response {
  return { recentOrders: orders } as unknown as CustomerAccountV2Response;
}

const subscription = { subscriptionId: SUB_ID } as unknown as Subscription;

describe("customerFulfillmentStep", () => {
  it("maps the real fulfilment signals to a provider-neutral customer step", () => {
    // Paid but the provider has not accepted yet (fo `created` / no fulfilment row).
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "created" }))).toBe("paid");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: null as unknown as string }))).toBe("paid");
    // Dispatched / provider acknowledged — Przyjęte, NOT packing.
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "label_created" }))).toBe("accepted");
    expect(
      customerFulfillmentStep(
        order({ fulfillmentStatus: "label_created", trackingTimeline: [{ eventType: "provider_received" }] as Order["trackingTimeline"] }),
      ),
    ).toBe("accepted");
    // Provider actually working — the real evidence wins over internal `label_created`.
    expect(
      customerFulfillmentStep(
        order({ fulfillmentStatus: "label_created", trackingTimeline: [{ eventType: "picking" }] as Order["trackingTimeline"] }),
      ),
    ).toBe("packing");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "packed" }))).toBe("packing");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "handed_over" }))).toBe("transit");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "in_transit" }))).toBe("transit");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "delivered" }))).toBe("delivered");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "exception" }))).toBe("exception");
    expect(customerFulfillmentStep(order({ fulfillmentStatus: "cancelled" }))).toBe("cancelled");
  });

  it("uses the full timed timeline for delivered-then-exception chronology", () => {
    expect(customerFulfillmentStep(order({
      fulfillmentStatus: "delivered",
      trackingTimeline: [
        { eventType: "exception", occurredAt: "2026-07-15T13:00:00Z" },
        { eventType: "delivered", occurredAt: "2026-07-15T12:00:00Z" },
      ] as Order["trackingTimeline"],
    }))).toBe("exception");
    expect(customerFulfillmentStep(order({
      fulfillmentStatus: "delivered",
      trackingTimeline: [
        { eventType: "delivered", occurredAt: "2026-07-15T13:00:00Z" },
        { eventType: "exception", occurredAt: "2026-07-15T12:00:00Z" },
      ] as Order["trackingTimeline"],
    }))).toBe("delivered");
    expect(customerFulfillmentStep(order({
      fulfillmentStatus: "delivered",
      trackingTimeline: [
        { eventType: "delivered", occurredAt: "2026-07-15T14:00:00Z" },
        { eventType: "exception", occurredAt: "2026-07-15T13:00:00Z" },
        { eventType: "delivered", occurredAt: "2026-07-15T12:00:00Z" },
      ] as Order["trackingTimeline"],
    }))).toBe("delivered");
  });

  it("never presents a cancelled or refunded order as delivered", () => {
    for (const status of ["cancelled", "refunded"]) {
      expect(customerFulfillmentStep(order({
        status,
        fulfillmentStatus: "delivered",
        trackingTimeline: [{ eventType: "delivered", occurredAt: "2026-07-17T13:00:00Z" }] as Order["trackingTimeline"],
      }))).toBe("cancelled");
    }
    // The non-terminal path is untouched: the same timeline still reads delivered.
    expect(customerFulfillmentStep(order({
      status: "paid",
      fulfillmentStatus: "delivered",
      trackingTimeline: [{ eventType: "delivered", occurredAt: "2026-07-17T13:00:00Z" }] as Order["trackingTimeline"],
    }))).toBe("delivered");
  });

  it("prefers the server-derived recovery step over the compressed historical timeline", () => {
    expect(customerFulfillmentStep(order({
      fulfillmentStatus: "exception",
      customerFulfillmentStep: "packing",
      trackingTimeline: [{ eventType: "exception", occurredAt: "2026-08-04T10:00:00Z" }] as Order["trackingTimeline"],
    }))).toBe("packing");
  });
});

describe("orderPhaseIndex", () => {
  it("maps to a 5-phase bar: paid0 accepted1 packing2 transit3 delivered4", () => {
    expect(orderPhaseIndex(order({ fulfillmentStatus: "created" }))).toBe(0);
    expect(orderPhaseIndex(order({ fulfillmentStatus: "label_created" }))).toBe(1);
    expect(orderPhaseIndex(order({ fulfillmentStatus: "packed" }))).toBe(2);
    expect(orderPhaseIndex(order({ fulfillmentStatus: "in_transit" }))).toBe(3);
    expect(orderPhaseIndex(order({ fulfillmentStatus: "delivered" }))).toBe(4);
  });

  it("lets the real provider status pull the phase away from the internal `label_created`", () => {
    // Same internal FSM state, different real provider evidence.
    expect(
      orderPhaseIndex(order({ fulfillmentStatus: "label_created", trackingTimeline: [{ eventType: "provider_received" }] as Order["trackingTimeline"] })),
    ).toBe(1);
    expect(
      orderPhaseIndex(order({ fulfillmentStatus: "label_created", trackingTimeline: [{ eventType: "picking" }] as Order["trackingTimeline"] })),
    ).toBe(2);
  });

  it("pins off-track states (exception→1, cancelled→0)", () => {
    expect(orderPhaseIndex(order({ fulfillmentStatus: "exception" }))).toBe(1);
    expect(orderPhaseIndex(order({ fulfillmentStatus: "cancelled" }))).toBe(0);
  });
});

describe("selectInFlightDelivery", () => {
  it("returns the paid, not-yet-shipped subscription order with its resolved step", () => {
    const result = selectInFlightDelivery(account([order({ fulfillmentStatus: "label_created" })]), subscription);
    expect(result).toEqual({ orderId: "o1", phaseIndex: 1, step: "accepted" });
  });

  it("treats a paid order with no fulfilment row yet as in-flight at 'paid'", () => {
    const result = selectInFlightDelivery(account([order({ fulfillmentStatus: null as unknown as string })]), subscription);
    expect(result).toEqual({ orderId: "o1", phaseIndex: 0, step: "paid" });
  });

  it("keeps a handed-over or in-transit paid parcel as the primary delivery", () => {
    for (const fulfillmentStatus of ["handed_over", "in_transit"]) {
      expect(
        selectInFlightDelivery(account([order({ fulfillmentStatus })]), subscription),
      ).toEqual({ orderId: "o1", phaseIndex: 3, step: "transit" });
    }
  });

  it("returns null once the parcel is delivered or cancelled", () => {
    expect(
      selectInFlightDelivery(account([order({ fulfillmentStatus: "delivered" })]), subscription),
    ).toBeNull();
    for (const fulfillmentStatus of ["cancelled"]) {
      expect(selectInFlightDelivery(account([order({ fulfillmentStatus })]), subscription)).toBeNull();
    }
  });

  it("keeps durable delivery terminal when a later provider event needs attention", () => {
    expect(
      selectInFlightDelivery(account([order({
        fulfillmentStatus: "delivered",
        trackingTimeline: [{ eventType: "exception", occurredAt: "2026-07-15T13:00:00Z" }] as Order["trackingTimeline"],
      })]), subscription),
    ).toBeNull();
  });

  it("ignores unpaid (pending_payment), cancelled and refunded orders", () => {
    for (const status of ["pending_payment", "cancelled", "refunded"]) {
      expect(
        selectInFlightDelivery(account([order({ status, fulfillmentStatus: "label_created" })]), subscription),
      ).toBeNull();
    }
  });

  it("ignores orders belonging to another subscription", () => {
    expect(
      selectInFlightDelivery(account([order({ subscriptionId: "other" })]), subscription),
    ).toBeNull();
  });

  it("picks the most recent in-flight order when several exist", () => {
    const result = selectInFlightDelivery(
      account([
        order({ orderId: "old", createdAt: "2026-07-01T00:00:00.000Z" }),
        order({ orderId: "new", createdAt: "2026-07-08T00:00:00.000Z" }),
      ]),
      subscription,
    );
    expect(result?.orderId).toBe("new");
  });
});
