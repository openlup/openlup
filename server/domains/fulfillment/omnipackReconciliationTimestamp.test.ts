import { describe, expect, it } from "vitest";
import { normalizeOmnipackReconciliationTimestamp } from "./omnipackReconciliationTimestamp.js";

describe("OmniPack reconciliation timestamp", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["blank", " "],
    ["malformed", "not-a-timestamp"],
    ["zoneless", "2026-06-10T09:00:00"],
    ["non-finite ISO-shaped", "2026-13-10T09:00:00+00:00"],
    ["invalid calendar date", "2026-02-30T09:00:00Z"],
  ])("normalizes a %s provider value to null", (_name, value) => {
    expect(normalizeOmnipackReconciliationTimestamp(value)).toBeNull();
  });

  it.each([
    "2026-06-10T09:00:00Z",
    "2026-06-10T09:00:00.123-05:30",
    "2026-06-10T09:00:00+0200",
  ])("preserves a finite ISO value with an explicit zone: %s", (value) => {
    expect(normalizeOmnipackReconciliationTimestamp(` ${value} `)).toBe(value);
  });
});
