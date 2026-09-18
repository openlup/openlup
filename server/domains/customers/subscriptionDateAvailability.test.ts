import { describe, expect, it, vi } from "vitest";
import { dateAvailability } from "./subscriptionDateAvailability.js";

describe("subscription date availability", () => {
  it("returns selectable dates only when the action is not blocked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    try {
      const available = dateAvailability(null);
      expect(available.earliestAllowedAt).toBe("2026-06-15T12:00:00.000Z");
      expect(available.latestAllowedAt).toBe("2026-08-11T12:00:00.000Z");
      expect(available.availableDates[0]).toBe("2026-06-15T12:00:00.000Z");

      const blocked = dateAvailability("cycle_locked");
      expect(blocked.availableDates).toEqual([]);
      expect(blocked.blockedReason).toBe("cycle_locked");
    } finally {
      vi.useRealTimers();
    }
  });
});
