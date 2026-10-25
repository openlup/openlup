import { describe, expect, it } from "vitest";
import { buildOmsFulfillmentSummary } from "../../src/commerce/model/omsFulfillmentSummary.js";
import {
  FULFILLMENT_STATUS_MAP,
  stepForToken,
} from "@openlup/core/fulfillment";

/** Every token the canon can resolve, from all four token surfaces of every stage. */
const CANON_TOKENS: string[] = [
  ...new Set(
    FULFILLMENT_STATUS_MAP.stages.flatMap((stage) => [
      ...stage.localStatus,
      ...stage.omsFulfillmentStatus,
      ...stage.orderStatus,
      ...stage.aliasTokens,
    ]),
  ),
];

/** The timeline label the OMS summary rendered for one raw token. */
function labelFor(token: string): string | undefined {
  return buildOmsFulfillmentSummary({
    fulfillmentOrders: [{ id: "fulfillment-1", order_id: "order-1", status: "created" }],
    fulfillmentOperations: [
      { fulfillment_order_id: "fulfillment-1", operation_type: token, occurred_at: "2026-07-16T12:00:00.000Z" },
    ],
    shipmentExternalRefs: [],
  }).trackingTimeline[0]?.label;
}

describe("OMS fulfillment chronology", () => {
  it("keeps provider occurrence unknown instead of substituting ingestion time", () => {
    const summary = buildOmsFulfillmentSummary({
      fulfillmentOrders: [{
        id: "fulfillment-1",
        order_id: "order-1",
        status: "delivered",
      }],
      fulfillmentOperations: [],
      shipmentExternalRefs: [],
      providerStatusEvidence: [{
        fulfillment_order_id: "fulfillment-1",
        provider_status: "RETURNED_TO_SENDER",
        local_status: "exception",
        customer_status: "exception",
        evidence_kind: "webhook",
        occurred_at: null,
        created_at: "2026-07-16T12:00:00.000Z",
      }],
    });

    expect(summary.trackingTimeline[0]?.occurredAt).toBeNull();
    expect(summary.trackingTimeline[0]).toMatchObject({
      eventType: "exception",
      label: stepForToken("exception"),
    });
    expect(summary.providerEvidence.find((item) => item.evidenceType === "status_evidence")).toMatchObject({
      occurredAt: null,
      updatedAt: "2026-07-16T12:00:00.000Z",
    });
  });
});

describe("OMS timeline labels derive from the canon, not a second dictionary", () => {
  it("covers every canon token (a stage added to the map cannot be missed here)", () => {
    expect(CANON_TOKENS.length).toBe(34);
  });

  it.each(CANON_TOKENS)("`%s` renders the neutral canonical step key", (token) => {
    const step = stepForToken(token);
    expect(step).not.toBeNull();
    expect(labelFor(token)).toBe(step);
    expect(labelFor(token)).toMatch(/^[a-z_]+$/);
  });

  it("keeps the milestone-agnostic line for a token the canon does not resolve", () => {
    // `tracking_event_recorded` is a real `commerce_fulfillment_operations` type
    // that names no milestone; an unknown future token must not guess one either.
    expect(stepForToken("tracking_event_recorded")).toBeNull();
    expect(labelFor("tracking_event_recorded")).toBe("Delivery status updated");
    expect(labelFor("provider_status")).toBe("Delivery status updated");
    expect(labelFor("wat_is_this")).toBe("Delivery status updated");
  });


  it("normalizes provider casing, so a raw provider word no longer falls through", () => {
    expect(labelFor("IN_FULFILLMENT")).toBe(stepForToken("IN_FULFILLMENT"));
    expect(labelFor("Label Created")).toBe(stepForToken("Label Created"));
  });
});

describe("an order that holds two parcels", () => {
  const original = { id: "fulfillment-1", order_id: "order-1", status: "delivered" as const };
  const replacement = { id: "fulfillment-2", order_id: "order-1", status: "handed_over" as const };
  const refs = [
    { order_id: "order-1", fulfillment_order_id: "fulfillment-1", provider_tracking_id: "T-ORIGINAL", active: true, updated_at: "2026-08-01T00:00:00.000Z" },
    { order_id: "order-1", fulfillment_order_id: "fulfillment-2", provider_tracking_id: "T-REPLACEMENT", active: true, updated_at: "2026-08-02T00:00:00.000Z" },
  ];

  // Without attribution both references answer for both parcels, and the summary sorts by
  // recency - so the ORIGINAL parcel would advertise the replacement's tracking number.
  it("shows each parcel only the tracking reference it owns", () => {
    const forReplacement = buildOmsFulfillmentSummary({
      fulfillmentOrders: [replacement, original],
      fulfillmentOperations: [],
      shipmentExternalRefs: refs,
    });
    expect(forReplacement.providerTrackingId).toBe("T-REPLACEMENT");
    expect(forReplacement.trackingReferences.map((ref) => ref.trackingNumber)).toEqual(["T-REPLACEMENT"]);

    const forOriginal = buildOmsFulfillmentSummary({
      fulfillmentOrders: [original, replacement],
      fulfillmentOperations: [],
      shipmentExternalRefs: refs,
    });
    expect(forOriginal.providerTrackingId).toBe("T-ORIGINAL");
    expect(forOriginal.trackingReferences.map((ref) => ref.trackingNumber)).toEqual(["T-ORIGINAL"]);
  });

  it("still shows an unattributed reference, which is how a one-parcel order reads", () => {
    const summary = buildOmsFulfillmentSummary({
      fulfillmentOrders: [replacement],
      fulfillmentOperations: [],
      shipmentExternalRefs: [{ order_id: "order-1", provider_tracking_id: "T-LEGACY", active: true }],
    });
    expect(summary.providerTrackingId).toBe("T-LEGACY");
  });
});

it("defaults delivery timeline presentation to the neutral canonical step key", () => {
  expect(labelFor("delivered")).toBe("delivered");
});

it("keeps host timeline presentation behind the existing projection", () => {
  const summary = buildOmsFulfillmentSummary({
    fulfillmentOrders: [{ id: "fulfillment-1", order_id: "order-1", status: "delivered" }],
    fulfillmentOperations: [{ fulfillment_order_id: "fulfillment-1", operation_type: "delivered", occurred_at: "2026-07-16T12:00:00Z" }],
    shipmentExternalRefs: [],
    projections: { timelineLabel: step => `Example label: ${step}` },
  });
  expect(summary.trackingTimeline[0]?.label).toBe("Example label: delivered");
});
