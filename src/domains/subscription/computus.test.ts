import { describe, expect, it } from "vitest";
import { easterRelativeDay, easterSunday } from "./computus.js";

/**
 * Hand-verified Easter Sunday dates, Gregorian calendar.
 *
 * Source: the published Easter tables (the same values printed in the Nautical
 * Almanac and reproduced in every standard reference on the computus). They were
 * additionally cross-checked against an INDEPENDENT implementation — Gauss's
 * Easter algorithm, which shares no intermediate variables with
 * Meeus/Jones/Butcher — so this table is not a transcription of the code under
 * test. A single-year disagreement is a real defect: it silently moves three
 * observances a year for every calendar derived from Easter.
 */
const EASTER_SUNDAY: ReadonlyArray<readonly [number, string]> = [
  [2024, "2024-03-31"],
  [2025, "2025-04-20"],
  [2026, "2026-04-05"],
  [2027, "2027-03-28"],
  [2028, "2028-04-16"],
  [2029, "2029-04-01"],
  [2030, "2030-04-21"],
  [2031, "2031-04-13"],
  [2032, "2032-03-28"],
  [2033, "2033-04-17"],
  [2034, "2034-04-09"],
  [2035, "2035-03-25"],
];

/** ISO weekday name of a calendar date, read in UTC. */
function weekday(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(new Date(`${iso}T00:00:00.000Z`));
}

describe("easterSunday", () => {
  it("matches the hand-verified table year by year", () => {
    expect(EASTER_SUNDAY.map(([year]) => [year, easterSunday(year)]))
      .toEqual(EASTER_SUNDAY.map(([year, date]) => [year, date]));
  });

  it("always lands on a Sunday, between 22 March and 25 April", () => {
    // Two properties the algorithm cannot violate. They hold for every year, not
    // just the tabulated ones, so they cover the range the table does not.
    for (let year = 1583; year <= 2200; year += 1) {
      const date = easterSunday(year);
      expect(weekday(date)).toBe("Sun");
      expect(date >= `${year}-03-22` && date <= `${year}-04-25`).toBe(true);
    }
  });

  it("rejects a year that is not a year rather than returning a wrong date", () => {
    for (const year of [2026.5, Number.NaN, 1582, 10_000, "2026" as unknown as number]) {
      expect(() => easterSunday(year)).toThrow(RangeError);
    }
  });
});

describe("easterRelativeDay", () => {
  it("returns Easter Sunday itself at offset 0", () => {
    for (const [year, date] of EASTER_SUNDAY) expect(easterRelativeDay(year, 0)).toBe(date);
  });

  it("keeps the offset's weekday fixed and crosses month boundaries correctly", () => {
    for (const [year] of EASTER_SUNDAY) {
      // +1 is always a Monday, +49 always a Sunday, +60 always a Thursday —
      // a structural check on the arithmetic independent of the table.
      expect(weekday(easterRelativeDay(year, 1))).toBe("Mon");
      expect(weekday(easterRelativeDay(year, 49))).toBe("Sun");
      expect(weekday(easterRelativeDay(year, 60))).toBe("Thu");
    }
    // Easter 2026-04-05: +49 crosses into May, +60 into June.
    expect(easterRelativeDay(2026, 49)).toBe("2026-05-24");
    expect(easterRelativeDay(2026, 60)).toBe("2026-06-04");
    // Easter 2035-03-25: +60 crosses two month boundaries.
    expect(easterRelativeDay(2035, 60)).toBe("2035-05-24");
  });

  it("accepts negative offsets and crosses a year boundary", () => {
    // Easter 2027-03-28 minus 90 days is in the previous December.
    expect(easterRelativeDay(2027, -90)).toBe("2026-12-28");
  });

  it("rejects a non-integer offset", () => {
    expect(() => easterRelativeDay(2026, 1.5)).toThrow(RangeError);
  });
});
