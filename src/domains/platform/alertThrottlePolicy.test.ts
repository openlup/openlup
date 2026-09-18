import { describe, expect, it } from "vitest";
import { DEFAULT_THROTTLE_SECONDS, throttleSecondsForSeverity } from "./alertThrottlePolicy";

describe("alert throttle policy", () => {
  it("scales re-notification cadence by severity", () => {
    expect(throttleSecondsForSeverity("p0")).toBe(60 * 60);
    expect(throttleSecondsForSeverity("p1")).toBe(4 * 60 * 60);
    expect(throttleSecondsForSeverity("p2")).toBe(12 * 60 * 60);
    expect(throttleSecondsForSeverity("p3")).toBe(24 * 60 * 60);
  });

  it("is monotonic: higher severity never waits longer", () => {
    const order = ["p0", "p1", "p2", "p3"].map(throttleSecondsForSeverity);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    }
  });

  it("falls back for unknown severity", () => {
    expect(throttleSecondsForSeverity("weird")).toBe(DEFAULT_THROTTLE_SECONDS);
    expect(throttleSecondsForSeverity("")).toBe(DEFAULT_THROTTLE_SECONDS);
  });
});
