import { describe, expect, it } from "vitest";
import {
  buildCustomerFulfillmentSummary,
  buildCustomerTrackingSummary,
  customerStepFromCustomerOrder,
} from "./customerOrderTrackingModels.js";

const orderId = "88888888-8888-8888-8888-888888888888";
const fulfillmentId = "77777777-7777-7777-7777-777777777777";

describe("customer order tracking models", () => {
  it("maps multiple active tracking refs and sorts customer-safe timeline events", () => {
    const summary = buildCustomerTrackingSummary(orderId, {
      tracking: new Map([
        [orderId, [
          ref("omnipack", "TRACK-2", "2026-06-10T12:00:00+00:00"),
          ref("inpost", "TRACK-1", "2026-06-10T11:00:00+00:00"),
        ]],
      ]),
      evidence: new Map([
        [orderId, [
          {
            provider_status: "delivered",
            local_status: "delivered",
            evidence_kind: "reconciliation",
            occurred_at: "2026-06-10T13:00:00+00:00",
          },
        ]],
      ]),
      operations: new Map([[orderId, [{ operation_type: "label_created", occurred_at: "2026-06-10T10:00:00+00:00" }]]]),
    });

    expect(summary.trackingNumbers).toEqual(["TRACK-2", "TRACK-1"]);
    expect(summary.trackingUrl).toBeNull();
    expect(summary.trackingTimeline.map((event) => event.eventType)).toEqual(["delivered", "label_created"]);
    expect(summary.trackingTimeline[0]?.source).toBe("reconciliation");
  });

  it("builds fulfillment summaries without exposing raw provider payloads", () => {
    const trackingSummary = buildCustomerTrackingSummary(orderId, {
      tracking: new Map([[orderId, [ref("omnipack", "TRACK-1", "2026-06-10T12:00:00+00:00")]]]),
      evidence: new Map(),
      operations: new Map(),
    });

    const fulfillment = buildCustomerFulfillmentSummary(
      {
        id: fulfillmentId,
        order_id: orderId,
        status: "shipped",
        provider_kind: "omnipack",
        updated_at: "2026-06-10T12:05:00+00:00",
      },
      trackingSummary,
      null,
    );

    expect(fulfillment.trackingNumbers).toEqual(["TRACK-1"]);
    expect(JSON.stringify(fulfillment)).not.toContain("sanitized_payload");
  });
});

function ref(provider_kind: string, provider_tracking_id: string, updated_at: string) {
  return { order_id: orderId, provider_kind, provider_tracking_id, updated_at };
}

describe("customer step on a terminal order", () => {
  const deliveredEvidence = [{
    id: "delivered-evidence",
    local_status: "delivered",
    evidence_kind: "reconciliation",
    occurred_at: "2026-07-17T13:00:00+00:00",
  }];

  it("never presents a cancelled or refunded order as delivered", () => {
    for (const orderStatus of ["cancelled", "refunded"]) {
      expect(customerStepFromCustomerOrder(orderStatus, "cancelled", deliveredEvidence, undefined, false))
        .toBe("cancelled");
      // Even when the durable fulfillment row itself still reads delivered.
      expect(customerStepFromCustomerOrder(orderStatus, "delivered", deliveredEvidence, undefined, false))
        .toBe("cancelled");
    }
  });

  it("leaves a non-terminal order's provider evidence fully ranked", () => {
    expect(customerStepFromCustomerOrder("paid", "handed_over", deliveredEvidence, undefined, false))
      .toBe("delivered");
    expect(customerStepFromCustomerOrder("fulfilled", "delivered", deliveredEvidence, undefined, false))
      .toBe("delivered");
    expect(customerStepFromCustomerOrder("paid", "label_created", [], undefined, false))
      .toBe("accepted");
    expect(customerStepFromCustomerOrder("paid", null, [], undefined, false))
      .toBe("paid");
  });

  it("keeps the active-hold short-circuit ahead of the terminal cap", () => {
    expect(customerStepFromCustomerOrder("cancelled", "cancelled", deliveredEvidence, undefined, true))
      .toBe("exception");
  });

  it("keeps the carrier's delivered row in the sanitized customer timeline", () => {
    const summary = buildCustomerTrackingSummary(orderId, {
      tracking: new Map(),
      evidence: new Map([[orderId, deliveredEvidence]]),
      operations: new Map(),
    });

    expect(summary.trackingTimeline.map((event) => event.eventType)).toEqual(["delivered"]);
    expect(summary.trackingTimeline[0]?.label).toBe("Dostarczono");
  });
});
