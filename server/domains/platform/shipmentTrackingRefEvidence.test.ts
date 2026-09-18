import { describe, expect, it } from "vitest";
import { countHandedOverWithoutTrackingRef } from "./shipmentTrackingRefEvidence.js";

const now = new Date("2026-06-10T12:00:00.000Z");
// Two hours past handoff — well outside the 60 minute grace window.
const HANDED_OVER_AT = "2026-06-10T10:00:00.000Z";

describe("shipment tracking ref evidence", () => {
  it("does not count a handed-over order that already has an active tracking ref", () => {
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [fulfillment("f-1", "o-1")],
      trackingRefs: [{ order_id: "o-1", active: true }],
      deliveredEvidence: [],
    });

    expect(count).toBe(0);
  });

  it("counts a handed-over order whose only tracking ref is inactive", () => {
    // `active = false` is exactly what the dispatched-email trigger filters
    // out, so this order will never get an outbox row, an email, or a link.
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [fulfillment("f-1", "o-1")],
      trackingRefs: [{ order_id: "o-1", active: false }],
      deliveredEvidence: [],
    });

    expect(count).toBe(1);
  });

  it("counts in_transit the same as handed_over and ignores every other status", () => {
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [
        fulfillment("f-1", "o-1", "in_transit"),
        fulfillment("f-2", "o-2", "delivered"),
        fulfillment("f-3", "o-3", "label_created"),
        fulfillment("f-4", "o-4", "cancelled"),
      ],
      trackingRefs: [],
      deliveredEvidence: [],
    });

    expect(count).toBe(1);
  });

  it("holds back inside the 60 minute grace so a late ref write is not an alert", () => {
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [{
        id: "f-1",
        order_id: "o-1",
        status: "handed_over",
        handed_over_at: "2026-06-10T11:30:00.000Z",
        updated_at: "2026-06-10T11:30:00.000Z",
      }],
      trackingRefs: [],
      deliveredEvidence: [],
    });

    expect(count).toBe(0);
  });

  it("falls back to updated_at when handed_over_at is missing and skips undated rows", () => {
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [
        { id: "f-1", order_id: "o-1", status: "handed_over", handed_over_at: null, updated_at: HANDED_OVER_AT },
        { id: "f-2", order_id: "o-2", status: "handed_over", handed_over_at: null, updated_at: null },
      ],
      trackingRefs: [],
      deliveredEvidence: [],
    });

    expect(count).toBe(1);
  });

  it("scopes active refs to the fulfillment's own order", () => {
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [fulfillment("f-1", "o-1"), fulfillment("f-2", "o-2")],
      trackingRefs: [{ order_id: "o-2", active: true }],
      deliveredEvidence: [],
    });

    expect(count).toBe(1);
  });

  it("does not count a delivered-first parcel: the customer already has it and the trigger suppresses the email", () => {
    // The provider reported DELIVERED, so markHandedOver ran with
    // suppressDispatched and the row sits at handed_over with no refs. The
    // emitter's second early return means no dispatched email was ever owed —
    // paging p1 here would be alert fatigue over a parcel already received.
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [fulfillment("f-1", "o-1")],
      trackingRefs: [],
      deliveredEvidence: [{ fulfillment_order_id: "f-1", local_status: "delivered" }],
    });

    expect(count).toBe(0);
  });

  it("still counts when the only evidence is in_transit, or delivered for another fulfillment", () => {
    const count = countHandedOverWithoutTrackingRef({
      now,
      fulfillmentOrders: [fulfillment("f-1", "o-1")],
      trackingRefs: [],
      deliveredEvidence: [
        // In-transit evidence is not a suppression: the email is still owed.
        { fulfillment_order_id: "f-1", local_status: "in_transit" },
        // Delivered, but for a different fulfillment order.
        { fulfillment_order_id: "f-9", local_status: "delivered" },
      ],
    });

    expect(count).toBe(1);
  });

  it("normalizes delivered evidence the way lower(btrim(coalesce(...))) does", () => {
    // A capitalised or padded provider value must exclude just as `delivered` does.
    for (const localStatus of ["DELIVERED", "  Delivered  ", "delivered"]) {
      const count = countHandedOverWithoutTrackingRef({
        now,
        fulfillmentOrders: [fulfillment("f-1", "o-1")],
        trackingRefs: [],
        deliveredEvidence: [{ fulfillment_order_id: "f-1", local_status: localStatus }],
      });

      expect(count).toBe(0);
    }
  });
});

function fulfillment(id: string, orderId: string, status = "handed_over") {
  return {
    id,
    order_id: orderId,
    status,
    handed_over_at: HANDED_OVER_AT,
    updated_at: HANDED_OVER_AT,
  };
}
