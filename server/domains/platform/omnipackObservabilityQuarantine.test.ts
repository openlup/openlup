import { describe, expect, it } from "vitest";
import { summarizeRecentOmnipackQuarantines } from "./omnipackObservabilityQuarantine.js";

describe("OmniPack quarantine observability", () => {
  it("separates state conflicts from unmatched inbound quarantine", () => {
    const cutoff = Date.parse("2026-07-14T00:00:00.000Z");
    expect(summarizeRecentOmnipackQuarantines([
      {
        provider: "omnipack",
        processing_status: "ignored",
        received_at: "2026-07-14T01:00:00.000Z",
        error: { reason: "omnipack_reconciliation_state_conflict:commerce_fulfillment_not_found" },
      },
      {
        provider: "omnipack",
        processing_status: "ignored",
        received_at: "2026-07-14T02:00:00.000Z",
        error: { reason: "unmatched_fulfilment" },
      },
      {
        provider: "omnipack",
        processing_status: "ignored",
        received_at: "2026-07-13T23:59:59.000Z",
        error: { reason: "unmatched_fulfilment" },
      },
    ], cutoff)).toEqual({ stateConflicts: 1, other: 1 });
  });
});
