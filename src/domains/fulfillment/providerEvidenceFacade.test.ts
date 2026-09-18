import { describe, expect, it } from "vitest";
import {
  buildFulfillmentEvidenceSummary,
  customerStepFromTimedSignals,
  mapFulfillmentEvidenceTrackingReference,
} from "./types.js";

describe("fulfillment provider evidence facade", () => {
  it("keeps DHL tracking refs readable without OmniPack evidence", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [
        {
          order_id: "order-1",
          provider_kind: "dhl",
          provider_tracking_id: "JD0123456789",
          updated_at: "2026-06-18T10:00:00+00:00",
          active: true,
        },
      ],
      statusEvidenceRows: [],
      operationRows: [],
    });

    expect(summary.trackingNumber).toBe("JD0123456789");
    expect(summary.trackingNumbers).toEqual(["JD0123456789"]);
    expect(summary.trackingReferences[0]).toMatchObject({
      providerKind: "dhl",
      carrierKind: "dhl",
      service: null,
      trackingUrl: null,
    });
  });

  it("sorts active tracking refs by newest provider evidence timestamp", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [
        {
          provider_kind: "omnipack",
          provider_tracking_id: "OLD",
          updated_at: "2026-06-18T10:00:00+00:00",
          active: true,
        },
        {
          provider_kind: "omnipack",
          provider_tracking_id: "NEW",
          updated_at: "2026-06-18T12:00:00+00:00",
          active: true,
        },
        {
          provider_kind: "omnipack",
          provider_tracking_id: "INACTIVE",
          updated_at: "2026-06-18T13:00:00+00:00",
          active: false,
        },
      ],
      statusEvidenceRows: [],
      operationRows: [],
    });

    expect(summary.trackingNumbers).toEqual(["NEW", "OLD"]);
    expect(summary.trackingNumber).toBe("NEW");
  });

  it("maps OmniPack carrier metadata without making it required for DHL", () => {
    expect(mapFulfillmentEvidenceTrackingReference({
      provider_kind: "omnipack",
      provider_tracking_id: "INPOST-1",
      carrier_kind: "inpost",
      service: "parcel_locker",
      tracking_url: "https://track.example/INPOST-1",
    })).toMatchObject({
      providerKind: "omnipack",
      carrierKind: "inpost",
      service: "parcel_locker",
      trackingUrl: "https://track.example/INPOST-1",
    });
  });

  it("combines sanitized provider evidence and local fulfillment operations into a timeline", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [],
      statusEvidenceRows: [
        {
          provider_status: "provider-specific-status",
          local_status: "delivered",
          evidence_kind: "reconciliation",
          occurred_at: "2026-06-18T12:00:00+00:00",
        },
      ],
      operationRows: [
        {
          operation_type: "label_created",
          occurred_at: "2026-06-18T10:00:00+00:00",
        },
      ],
    });

    expect(summary.trackingTimeline.map((event) => event.eventType)).toEqual(["delivered", "label_created"]);
    expect(summary.trackingTimeline[0]).toMatchObject({
      label: "Dostarczono",
      source: "reconciliation",
    });
    // `label_created` is OUR internal dispatch state (provider has not started) —
    // it reads as "Przyjete do realizacji", not "Przygotowane do wysylki".
    expect(summary.trackingTimeline[1]).toMatchObject({
      label: "Przyjete do realizacji",
      source: "fulfillment",
    });
  });

  it("labels the OmniPack early local statuses (post #1599) with clear customer milestones", () => {
    const cases: Array<{ local: string; label: string }> = [
      { local: "provider_received", label: "Przyjete do realizacji" },
      { local: "picking", label: "Przygotowane do wysylki" },
      { local: "packed", label: "Przygotowane do wysylki" },
      { local: "in_transit", label: "W drodze" },
      { local: "delivered", label: "Dostarczono" },
      { local: "exception", label: "Wymaga sprawdzenia" },
      { local: "cancelled", label: "Anulowano" },
    ];
    for (const testCase of cases) {
      const summary = buildFulfillmentEvidenceSummary({
        trackingRefs: [],
        statusEvidenceRows: [
          { provider_status: "x", local_status: testCase.local, evidence_kind: "reconciliation", occurred_at: "2026-07-09T12:00:00+00:00" },
        ],
        operationRows: [],
      });
      expect(summary.trackingTimeline[0]?.label, testCase.local).toBe(testCase.label);
    }
  });

  it("never presents legacy or provider-only OmniPack CANCELLED evidence as a local cancellation", () => {
    for (const localStatus of ["cancelled", null]) {
      const summary = buildFulfillmentEvidenceSummary({
        trackingRefs: [],
        statusEvidenceRows: [{
          provider_status: "CANCELLED",
          local_status: localStatus,
          evidence_kind: "reconciliation",
          occurred_at: "2026-07-09T12:00:00+00:00",
        }],
        operationRows: [],
      });

      expect(summary.trackingTimeline[0]).toMatchObject({
        eventType: "exception",
        label: "Wymaga sprawdzenia",
      });
    }
  });

  it("collapses many same-milestone provider updates into one entry (keeps the first, no flooding)", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [],
      statusEvidenceRows: [
        // Three consecutive "preparing" provider sub-steps — the customer should
        // see a single "Przygotowane do wysylki" milestone at its first timestamp.
        { provider_status: "in_fulfillment", local_status: "picking", evidence_kind: "reconciliation", occurred_at: "2026-07-09T10:00:00+00:00" },
        { provider_status: "ready_for_packing", local_status: "packed", evidence_kind: "reconciliation", occurred_at: "2026-07-09T11:00:00+00:00" },
        { provider_status: "awaiting_courier", local_status: "packed", evidence_kind: "reconciliation", occurred_at: "2026-07-09T12:00:00+00:00" },
        { provider_status: "new", local_status: "provider_received", evidence_kind: "reconciliation", occurred_at: "2026-07-09T09:00:00+00:00" },
      ],
      operationRows: [],
    });

    // Two distinct milestones only: accepted (09:00) then preparing (first at 10:00).
    expect(summary.trackingTimeline.map((event) => event.label)).toEqual([
      "Przygotowane do wysylki",
      "Przyjete do realizacji",
    ]);
    // Preparing milestone anchored to the FIRST time it was reached (10:00), not 12:00.
    expect(summary.trackingTimeline[0]?.occurredAt).toBe("2026-07-09T10:00:00+00:00");
  });

  it("keeps the latest timed exception while retaining the first on-track milestone", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [],
      statusEvidenceRows: [
        { local_status: "picking", occurred_at: "2026-07-09T10:00:00Z" },
        { local_status: "packed", occurred_at: "2026-07-09T11:00:00Z" },
        { local_status: "exception", occurred_at: "2026-07-09T12:00:00Z" },
        { local_status: "exception", occurred_at: "2026-07-09T13:00:00Z" },
      ],
      operationRows: [],
    });

    expect(summary.trackingTimeline.find((event) => event.eventType === "picking")?.occurredAt).toBe("2026-07-09T10:00:00Z");
    expect(summary.trackingTimeline.find((event) => event.eventType === "exception")?.occurredAt).toBe("2026-07-09T13:00:00Z");
  });

  it("keeps the latest delivery so delivered-exception-delivered resolves to delivery", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [],
      statusEvidenceRows: [
        { local_status: "delivered", occurred_at: "2026-07-09T12:00:00Z" },
        { local_status: "exception", occurred_at: "2026-07-09T13:00:00Z" },
        { local_status: "delivered", occurred_at: "2026-07-09T14:00:00Z" },
      ],
      operationRows: [],
    });

    expect(summary.trackingTimeline.find((event) => event.eventType === "delivered")?.occurredAt).toBe("2026-07-09T14:00:00Z");
    expect(customerStepFromTimedSignals([], summary.trackingTimeline.map((event) => ({
      token: event.eventType,
      occurredAt: event.occurredAt,
    })))).toBe("delivered");
  });

  it("never substitutes ingestion created_at for missing provider occurred_at", () => {
    const summary = buildFulfillmentEvidenceSummary({
      trackingRefs: [],
      statusEvidenceRows: [{ local_status: "delivered", occurred_at: null, created_at: "2026-07-09T12:00:00Z" }],
      operationRows: [],
    });

    expect(summary.trackingTimeline[0]?.occurredAt).toBeNull();
  });
});
