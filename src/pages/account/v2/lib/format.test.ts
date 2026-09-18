import { describe, expect, it } from "vitest";
import { daysUntil, formatDayMonth, formatWeekdayDayMonth } from "./format";

const NOW = new Date("2026-06-23T09:00:00.000Z");

describe("daysUntil", () => {
  it("computes whole days from now and clamps past dates to 0", () => {
    expect(daysUntil("2026-06-29T10:00:00.000Z", NOW)).toBe(6);
    expect(daysUntil("2026-06-20T10:00:00.000Z", NOW)).toBe(0);
  });
  it("returns null for missing / invalid dates", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("not-a-date", NOW)).toBeNull();
  });
});

describe("formatDayMonth", () => {
  it("formats day + long month", () => {
    expect(formatDayMonth("2026-06-29T10:00:00.000Z", "pl")).toContain("29");
    expect(formatDayMonth("2026-06-29T10:00:00.000Z", "en")).toContain("29");
  });
  it("returns an en dash for null", () => {
    expect(formatDayMonth(null, "pl")).toBe("–");
    expect(formatWeekdayDayMonth(null, "pl")).toBe("–");
  });
});
