import { describe, expect, it } from "vitest";
import { groupBy, latestTimestamp, readErrorReason, secondsBetween } from "./paymentObservabilityEvidenceHelpers.js";

const now = new Date("2026-07-03T14:00:00.000Z");

describe("payment observability evidence helpers", () => {
  it("clamps secondsBetween to zero for future or invalid timestamps", () => {
    expect(secondsBetween(new Date("2026-07-03T13:59:00.000Z").getTime(), now)).toBe(60);
    expect(secondsBetween(new Date("2026-07-03T14:01:00.000Z").getTime(), now)).toBe(0);
    expect(secondsBetween(Number.NaN, now)).toBe(0);
  });

  it("picks the freshest parseable timestamp and ignores null-ish values", () => {
    expect(latestTimestamp("2026-07-03T13:00:00.000Z", null, "2026-07-03T13:50:00.000Z", undefined))
      .toBe(new Date("2026-07-03T13:50:00.000Z").getTime());
    expect(latestTimestamp(null, undefined)).toBe(0);
    expect(latestTimestamp("not-a-date")).toBe(0);
  });

  it("reads the first present error field lowercased", () => {
    expect(readErrorReason({ error: "Signature Mismatch" })).toBe("signature mismatch");
    expect(readErrorReason({ error: null, error_code: "SIG_FAIL" })).toBe("sig_fail");
    expect(readErrorReason({ rejection_reason: "Bad Payload" })).toBe("bad payload");
    expect(readErrorReason({})).toBe("");
  });

  it("groups rows by key preserving order", () => {
    const grouped = groupBy(
      [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }],
      (row) => row.k,
    );
    expect(grouped.get("a")).toEqual([{ k: "a", v: 1 }, { k: "a", v: 3 }]);
    expect(grouped.get("b")).toEqual([{ k: "b", v: 2 }]);
  });
});
