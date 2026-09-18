import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDOVER_LOCAL_STATUSES,
  STOCK_CONSUMED_LOCAL_STATUSES,
  applyFulfillmentEffects,
  canonicalStatusToken,
  handsOverFor,
  localStatusFor,
  normalizeStatus,
  stockConsumedFor,
} from "./omnipackStatusVocabulary.js";
import { EVENT_TO_STATUS } from "./omnipackWebhookPayload.js";

const statusDictionary = JSON.parse(
  readFileSync(join(__dirname, "../../../config/omnipack-status-dictionary.json"), "utf8"),
) as { statuses: Array<{ status: string; localStatus: string | null; observedSubStatuses?: string[] }> };

describe("OmniPack status vocabulary (API primary-status axis)", () => {
  it("canonicalizes casing and separator drift to one token", () => {
    expect(canonicalStatusToken("IN_FULFILLMENT")).toBe("in_fulfillment");
    expect(canonicalStatusToken(" In fulfillment ")).toBe("in_fulfillment");
    expect(canonicalStatusToken("Shipping-Failed")).toBe("shipping_failed");
    expect(canonicalStatusToken("")).toBeNull();
    expect(canonicalStatusToken(null)).toBeNull();
  });

  it("maps every documented + live-observed primary status", () => {
    const expectations: Array<[string, string]> = [
      ["NEW", "provider_received"],
      ["IN_FULFILLMENT", "picking"],
      ["READY_FOR_PACKING", "packed"],
      ["AWAITING_COURIER", "packed"],
      ["SHIPPING", "in_transit"],
      ["DELIVERED", "delivered"],
      ["SHIPPING_FAILED", "exception"],
      ["RETURNED_TO_SENDER", "exception"],
      ["SUSPENDED", "exception"],
      ["CANCELLED", "exception"],
    ];
    for (const [apiStatus, expectedLocal] of expectations) {
      const normalized = normalizeStatus(apiStatus);
      expect(normalized, `${apiStatus} should normalize`).not.toBeNull();
      expect(localStatusFor(normalized!), `${apiStatus} -> local`).toBe(expectedLocal);
      // Same result in lowercase spelling (the pull must never depend on casing).
      expect(normalizeStatus(apiStatus.toLowerCase())).toBe(normalized);
    }
  });

  it("ignores subStatus for the local mapping (primary status is authoritative)", () => {
    // subStatus is recorded as evidence but must not change the local state:
    // the same primary status maps identically regardless of subStatus.
    expect(localStatusFor(normalizeStatus("NEW")!)).toBe("provider_received"); // VALIDATION_PENDING/READY_FOR_EXPORT/EXPORTED
    expect(localStatusFor(normalizeStatus("IN_FULFILLMENT")!)).toBe("picking"); // EXPORTED subStatus does NOT mean shipped
  });

  it("pins the vendor-confirmed SUSPENDED taxonomy as primary-only neutral exception evidence", () => {
    const suspended = statusDictionary.statuses.find((entry) => entry.status === "SUSPENDED");
    const vendorConfirmedSubStatuses = [
      "OUT_OF_STOCK",
      "NO_SKU",
      "ADDR_ERROR",
      "CARRIER_MAPPING_ERROR",
      "MERCH_BLOCKED",
      "NO_MATERIALS",
      "ERROR",
    ];

    expect(suspended?.observedSubStatuses).toEqual(vendorConfirmedSubStatuses);
    // The exact raw-detail taxonomy is evidence-only; lifecycle mapping stays
    // on the primary status and adds no per-sub-status core policy.
    expect(localStatusFor(normalizeStatus("SUSPENDED")!)).toBe("exception");
  });

  it("quarantines UNKNOWN and any unmapped primary status", () => {
    expect(normalizeStatus("UNKNOWN")).toBeNull();
    expect(normalizeStatus("Some brand new state")).toBeNull();
    expect(normalizeStatus(null)).toBeNull();
    // Panel display labels are NOT the API vocabulary and must not map.
    expect(normalizeStatus("Processing")).toBeNull();
    expect(normalizeStatus("In transit")).toBeNull();
  });

  it("every dictionary status matches the code mapping", () => {
    for (const entry of statusDictionary.statuses) {
      const normalized = normalizeStatus(entry.status);
      if (entry.localStatus === null) {
        expect(normalized, `${entry.status} is a quarantine status`).toBeNull();
      } else {
        expect(normalized, `${entry.status} should normalize`).not.toBeNull();
        expect(localStatusFor(normalized!), `${entry.status} dictionary vs code`).toBe(entry.localStatus);
      }
    }
  });

  // Replaces W0's descoped four-way divergence block: after the collapse there
  // is nothing to characterize, only one mapping to conform to. The push path
  // resolves through the same table as the pull path, so this asserts the route
  // table lands inside the dictionary rather than beside it.
  it("routes every webhook event through the same dictionary the poller uses", () => {
    const byStatus = new Map(statusDictionary.statuses.map((entry) => [entry.status, entry.localStatus]));
    const expectations: Array<[keyof typeof EVENT_TO_STATUS, string]> = [
      ["shipment.accepted", "NEW"],
      ["order.processing_started", "IN_FULFILLMENT"],
      ["order.picked", "READY_FOR_PACKING"],
      ["order.shipped", "SHIPPING"],
      ["order.delivered", "DELIVERED"],
    ];
    for (const [event, apiStatus] of expectations) {
      const routed = EVENT_TO_STATUS[event];
      expect(routed, `${event} routes to a normalized status`).toBe(normalizeStatus(apiStatus));
      expect(localStatusFor(routed), `${event} local status`).toBe(byStatus.get(apiStatus));
    }
  });

  // The old webhook-only mapper returned `delivered` for anything it did not
  // name. Nothing can reach a terminal state by omission any more: the route
  // table is total over a closed set, and an unrecognised PROVIDER string still
  // quarantines rather than mapping (asserted above).
  it("never resolves a webhook route to a terminal state by omission", () => {
    const routeEvents = Object.keys(EVENT_TO_STATUS);
    expect(routeEvents).toHaveLength(5);
    expect(routeEvents.filter((event) => localStatusFor(EVENT_TO_STATUS[event as keyof typeof EVENT_TO_STATUS]) === "delivered"))
      .toEqual(["order.delivered"]);
  });
});

describe("fulfillment effect boundary", () => {
  it("derives the handover set from the status canon", () => {
    expect([...HANDOVER_LOCAL_STATUSES].sort()).toEqual(["delivered", "in_transit"]);
    expect(handsOverFor("in_transit")).toBe(true);
    expect(handsOverFor("delivered")).toBe(true);
    expect(handsOverFor("packed")).toBe(false);
    expect(handsOverFor("picking")).toBe(false);
    expect(handsOverFor("exception")).toBe(false);
  });

  it("consumes provider stock from finished picking onward, and never at `picking`", () => {
    expect([...STOCK_CONSUMED_LOCAL_STATUSES].sort()).toEqual(["delivered", "in_transit", "packed"]);
    expect(stockConsumedFor("picking")).toBe(false);
    expect(stockConsumedFor("packed")).toBe(true);
    expect(stockConsumedFor("exception")).toBe(false);
  });

  it("writes stock, handover, tracking and the invoice in that order, once", async () => {
    const calls: string[] = [];
    const port = {
      markProviderStockConsumed: async () => { calls.push("stock"); return { replayed: false }; },
      markHandedOver: async (input: { suppressDispatched: boolean }) => {
        calls.push(`handover:${input.suppressDispatched}`);
        return { replayed: false };
      },
      recordTrackingReference: async (input: { trackingNumber: string }) => {
        calls.push(`tracking:${input.trackingNumber}`);
        return { replayed: false, readBack: true };
      },
    };
    const recorded: Array<{ replayed: boolean; readBack: boolean }> = [];

    await applyFulfillmentEffects({
      port,
      localStatus: "delivered",
      ids: { orderId: "order-1", fulfillmentOrderId: "ful-1" },
      payload: {},
      trackingRefs: [{ trackingNumber: "TRK-1" }, { trackingNumber: "TRK-2" }],
      stockIdempotencyKey: "stock-key",
      handoffIdempotencyKey: "handoff-key",
      trackingIdempotencyKey: (trackingNumber) => `tracking-key:${trackingNumber}`,
      issueAccountingInvoice: async () => { calls.push("invoice"); },
      onTrackingRecorded: (result) => recorded.push(result),
    });

    // `suppressDispatched` is derived from the local status, not passed in: a
    // delivered-first signal must not fire the late dispatch notification.
    expect(calls).toEqual(["stock", "handover:true", "tracking:TRK-1", "tracking:TRK-2", "invoice"]);
    expect(recorded).toHaveLength(2);
  });

  it("stops before handover for a status that only consumes stock", async () => {
    const calls: string[] = [];
    await applyFulfillmentEffects({
      port: {
        markProviderStockConsumed: async () => { calls.push("stock"); return { replayed: true }; },
        markHandedOver: async () => { calls.push("handover"); return { replayed: false }; },
        recordTrackingReference: async () => { calls.push("tracking"); return { replayed: false, readBack: false }; },
      },
      localStatus: "packed",
      ids: { orderId: "order-1", fulfillmentOrderId: "ful-1" },
      payload: {},
      trackingRefs: [{ trackingNumber: "TRK-1" }],
      stockIdempotencyKey: "stock-key",
      handoffIdempotencyKey: "handoff-key",
      trackingIdempotencyKey: () => "tracking-key",
      issueAccountingInvoice: async () => { calls.push("invoice"); },
    });

    expect(calls).toEqual(["stock"]);
  });

  it("writes nothing for a status outside the effect boundary", async () => {
    const calls: string[] = [];
    await applyFulfillmentEffects({
      port: {
        markProviderStockConsumed: async () => { calls.push("stock"); return { replayed: false }; },
        markHandedOver: async () => { calls.push("handover"); return { replayed: false }; },
        recordTrackingReference: async () => { calls.push("tracking"); return { replayed: false, readBack: false }; },
      },
      localStatus: "exception",
      ids: { orderId: "order-1", fulfillmentOrderId: "ful-1" },
      payload: {},
      trackingRefs: [],
      stockIdempotencyKey: "stock-key",
      handoffIdempotencyKey: "handoff-key",
      trackingIdempotencyKey: () => "tracking-key",
      issueAccountingInvoice: async () => { calls.push("invoice"); },
    });

    expect(calls).toEqual([]);
  });
});
