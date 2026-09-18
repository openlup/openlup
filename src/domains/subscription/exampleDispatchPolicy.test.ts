import { describe, expect, it } from "vitest";

import { DELIVERY_DISPATCH_POLICY } from "./exampleDispatchPolicy.js";
import { estimateDeliveryWindow } from "./deliveryEstimate.js";

// The platform half of `#delivery-dispatch-policy`, imported by RELATIVE PATH on purpose.
// Every non-hosted command in this repository resolves the seam to this deployment's own
// overlay, so the neutral owner has no other way of being exercised - and an owner nobody
// runs is an owner that rots. This is the same shape as the media seam's own owner tests.
describe("platform dispatch policy owner", () => {
  it("is a usable timetable, not a placeholder", () => {
    // Canon section 1.1: a published module must WORK completely. A fresh installation that
    // never edits this file still has to get a real delivery window out of it.
    const estimate = estimateDeliveryWindow("2026-08-17T09:00:00.000Z", DELIVERY_DISPATCH_POLICY);
    expect(estimate, "the neutral policy must produce an estimate, not null").not.toBeNull();
    expect(estimate?.fromIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(estimate?.toIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(estimate!.fromIso <= estimate!.toIso).toBe(true);
    // With no calendar to defer it, the neutral default can never report a holiday move.
    expect(estimate!.holidayDeferred ?? false).toBe(false);
  });

  it("exercises the min/max transit branch instead of collapsing it", () => {
    // A single-day window would let the estimator's two-sided arithmetic go untested by the
    // default anyone actually runs.
    expect(DELIVERY_DISPATCH_POLICY.minTransitBusinessDays)
      .toBeLessThan(DELIVERY_DISPATCH_POLICY.maxTransitBusinessDays);
  });

  it("names no jurisdiction, which is the whole point of the default", () => {
    expect(DELIVERY_DISPATCH_POLICY.timeZone).toBe("UTC");
    // Required and empty is a STATEMENT: the platform ships no country's calendar, and an
    // adopter adds its own beside this file. A non-empty list here would mean the published
    // default had quietly adopted somebody's public holidays.
    expect(DELIVERY_DISPATCH_POLICY.holidays).toEqual([]);
    expect(DELIVERY_DISPATCH_POLICY.businessDays).toEqual([1, 2, 3, 4, 5]);
  });
});
