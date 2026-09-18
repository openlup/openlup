import { describe, expect, it } from "vitest";
import { buildOmsFulfillmentSummary } from "./omsFulfillmentSummary.js";
import {
  FULFILLMENT_STATUS_MAP,
  stepForToken,
  timelineLabelForStep,
} from "../../lib/customerFulfillmentCanon.js";

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
      omnipackStatusEvidence: [{
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
      label: "Wymaga sprawdzenia",
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

  it.each(CANON_TOKENS)("`%s` renders the canon timeline label for its step", (token) => {
    const step = stepForToken(token);
    expect(step).not.toBeNull();
    expect(labelFor(token)).toBe(timelineLabelForStep(step!));
  });

  it("keeps the milestone-agnostic line for a token the canon does not resolve", () => {
    // `tracking_event_recorded` is a real `commerce_fulfillment_operations` type
    // that names no milestone; an unknown future token must not guess one either.
    expect(stepForToken("tracking_event_recorded")).toBeNull();
    expect(labelFor("tracking_event_recorded")).toBe("Status dostawy zaktualizowany");
    expect(labelFor("provider_status")).toBe("Status dostawy zaktualizowany");
    expect(labelFor("wat_is_this")).toBe("Status dostawy zaktualizowany");
  });

  // BEFORE -> AFTER for every token whose rendered label this change moves.
  // Rows 1-2 corrected a CONTRADICTION of the canon; rows 3-21 replaced the
  // generic fallback with the milestone the canon already assigns the token.
  it.each([
    // token, label before this change, label after
    ["label_created", "Przygotowane do wysylki", "Przyjete do realizacji"],
    ["created", "Przyjete do realizacji", "Oplacone"],
    ["paid", "Status dostawy zaktualizowany", "Oplacone"],
    ["fulfillment_pending", "Status dostawy zaktualizowany", "Oplacone"],
    ["provider_received", "Status dostawy zaktualizowany", "Przyjete do realizacji"],
    ["label_pending", "Status dostawy zaktualizowany", "Przyjete do realizacji"],
    ["new", "Status dostawy zaktualizowany", "Przyjete do realizacji"],
    ["picking", "Status dostawy zaktualizowany", "Przygotowane do wysylki"],
    ["in_fulfillment", "Status dostawy zaktualizowany", "Przygotowane do wysylki"],
    ["ready_for_packing", "Status dostawy zaktualizowany", "Przygotowane do wysylki"],
    ["awaiting_courier", "Status dostawy zaktualizowany", "Przygotowane do wysylki"],
    ["ready_for_pickup", "Status dostawy zaktualizowany", "Przygotowane do wysylki"],
    ["shipping", "Status dostawy zaktualizowany", "W drodze"],
    ["out_for_delivery", "Status dostawy zaktualizowany", "W drodze"],
    ["dispatched", "Status dostawy zaktualizowany", "W drodze"],
    ["fulfilled", "Status dostawy zaktualizowany", "Dostarczono"],
    ["suspended", "Status dostawy zaktualizowany", "Wymaga sprawdzenia"],
    ["returned_to_sender", "Status dostawy zaktualizowany", "Wymaga sprawdzenia"],
    ["cancelled", "Status dostawy zaktualizowany", "Anulowano"],
    ["refunded", "Status dostawy zaktualizowany", "Anulowano"],
    ["canceled", "Status dostawy zaktualizowany", "Anulowano"],
  ])("`%s`: was %s, is now %s", (token, before, after) => {
    expect(before).not.toBe(after);
    expect(labelFor(token)).toBe(after);
  });

  it("leaves every other canon token on the label it already had", () => {
    const unchanged: Array<[string, string]> = [
      ["accepted", "Przyjete do realizacji"],
      ["processing", "Przyjete do realizacji"],
      ["provider_attempt_recorded", "Przyjete do realizacji"],
      ["packed", "Przygotowane do wysylki"],
      ["picked", "Przygotowane do wysylki"],
      ["in_transit", "W drodze"],
      ["handed_over", "W drodze"],
      ["shipped", "W drodze"],
      ["delivered", "Dostarczono"],
      ["delivery_delivered", "Dostarczono"],
      ["exception", "Wymaga sprawdzenia"],
      ["shipping_failed", "Wymaga sprawdzenia"],
      ["failed", "Wymaga sprawdzenia"],
    ];
    for (const [token, label] of unchanged) expect(labelFor(token)).toBe(label);
    // 21 changed + 13 unchanged account for the whole canon vocabulary: no token
    // moved without a row in the before/after table above.
    expect(unchanged.length + 21).toBe(CANON_TOKENS.length);
  });

  it("normalizes provider casing, so a raw provider word no longer falls through", () => {
    expect(labelFor("IN_FULFILLMENT")).toBe("Przygotowane do wysylki");
    expect(labelFor("Label Created")).toBe("Przyjete do realizacji");
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
