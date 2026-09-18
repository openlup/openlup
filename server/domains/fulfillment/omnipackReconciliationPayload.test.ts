import { describe, expect, it } from "vitest";
import {
  fulfilmentId,
  nonBlank,
  providerOccurrenceKey,
  safeReason,
  sanitizedFulfilment,
  uniqueTrackingReferences,
} from "./omnipackReconciliationPayload.js";
import type { OmnipackReconciliationFulfilment } from "./omnipackReconciliationContracts.js";

// These helpers were extracted verbatim from omnipackReconciliationWorker.ts
// (which was at the 300-LOC guard cap). They derive idempotency keys and the
// sanitized provider proof, so drift here silently changes replay behaviour.

describe("OmniPack reconciliation payload helpers", () => {
  describe("fulfilmentId", () => {
    it("joins the fulfilment number with the merchant order number", () => {
      expect(fulfilmentId(fulfilment())).toBe("FUL-1001:order-1001");
    });

    it("falls back to the external number, then to stable placeholders", () => {
      expect(fulfilmentId(fulfilment({ orderNumber: null }))).toBe("FUL-1001:EXT-9");
      expect(fulfilmentId(fulfilment({ fulfilmentNumber: "", orderNumber: null, externalNumber: null })))
        .toBe("unknown-fulfilment:unknown-order");
    });
  });

  describe("providerOccurrenceKey", () => {
    it("pins the key to fulfillment, status, and occurrence time", () => {
      expect(providerOccurrenceKey("ful-1", "shipping", "2026-06-10T09:00:00.000Z"))
        .toBe("ful-1:shipping:2026-06-10T09:00:00.000Z");
    });

    // A missing timestamp must stay deterministic, or every run would mint a
    // fresh idempotency key and re-record the same evidence.
    it("uses a stable placeholder when the occurrence time is unknown", () => {
      expect(providerOccurrenceKey("ful-1", "shipping", null)).toBe("ful-1:shipping:unknown-time");
    });
  });

  describe("nonBlank", () => {
    it.each([
      ["  trimmed  ", "trimmed"],
      ["", null],
      ["   ", null],
      [null, null],
      [undefined, null],
    ])("normalizes %o to %o", (input, expected) => {
      expect(nonBlank(input)).toBe(expected);
    });
  });

  describe("uniqueTrackingReferences", () => {
    it("merges structured refs with bare tracking numbers and de-duplicates", () => {
      const refs = uniqueTrackingReferences(fulfilment({
        trackingReferences: [{ trackingNumber: "TRK-1", carrierKind: "inpost", service: "locker" }],
        trackingNumbers: ["TRK-1", "TRK-2", "  ", "TRK-2"],
      }));

      expect(refs.map((ref) => ref.trackingNumber)).toEqual(["TRK-1", "TRK-2"]);
      // The structured ref wins — the bare duplicate must not blank its carrier.
      expect(refs[0]).toMatchObject({ carrierKind: "inpost", service: "locker" });
      expect(refs[1]).toMatchObject({ carrierKind: null, service: null });
    });

    it("trims tracking numbers and drops blank ones", () => {
      expect(uniqueTrackingReferences(fulfilment({ trackingNumbers: ["  TRK-3  ", ""] })))
        .toEqual([expect.objectContaining({ trackingNumber: "TRK-3" })]);
    });
  });

  describe("sanitizedFulfilment", () => {
    it("carries provider identifiers and passes a valid occurrence time through verbatim", () => {
      expect(sanitizedFulfilment(fulfilment())).toMatchObject({
        provider: "omnipack",
        occurredAt: "2026-06-10T09:00:00+00:00",
        fulfilmentNumber: "FUL-1001",
        orderNumber: "order-1001",
        status: "SHIPPING",
        trackingNumbers: ["TRK-1"],
      });
    });

    // The timestamp helper is a validator, not a reformatter: anything without
    // an explicit zone is untrustworthy evidence and becomes null rather than
    // being guessed into UTC.
    it("drops an occurrence time that carries no explicit timezone", () => {
      expect(sanitizedFulfilment(fulfilment({ updatedAt: "2026-06-10 09:00:00" })))
        .toMatchObject({ occurredAt: null });
    });

    // The proof is persisted as evidence — it must record only whether a
    // tracking URL existed, never the URL itself.
    it("reduces tracking urls to a boolean rather than echoing them", () => {
      const payload = sanitizedFulfilment(fulfilment({
        trackingReferences: [{ trackingNumber: "TRK-1", trackingUrl: "https://example.test/t/TRK-1" }],
        trackingNumbers: [],
      }));

      expect(payload.trackingReferences).toEqual([
        { trackingNumber: "TRK-1", carrierKind: null, service: null, hasTrackingUrl: true },
      ]);
      expect(JSON.stringify(payload)).not.toContain("example.test");
    });
  });

  describe("safeReason", () => {
    it("reads the message off an Error and stringifies anything else", () => {
      expect(safeReason(new Error("boom"))).toBe("boom");
      expect(safeReason("plain string")).toBe("plain string");
    });

    // Job-failure reasons land in platform_job_runs; an unbounded provider blob
    // must not ride along.
    it("caps the reason at 180 characters", () => {
      expect(safeReason(new Error("x".repeat(500)))).toHaveLength(180);
    });
  });
});

function fulfilment(
  overrides: Partial<OmnipackReconciliationFulfilment> = {},
): OmnipackReconciliationFulfilment {
  return {
    provider: "omnipack",
    providerOrderId: "provider-order-1",
    fulfilmentNumber: "FUL-1001",
    externalNumber: "EXT-9",
    orderNumber: "order-1001",
    createdAt: "2026-06-10T08:00:00+00:00",
    updatedAt: "2026-06-10T09:00:00+00:00",
    status: "SHIPPING",
    subStatus: null,
    trackingNumbers: ["TRK-1"],
    ...overrides,
  };
}
