import { describe, expect, it } from "vitest";
import { parseInstant, wallClockToUtc } from "./wallClockTime.js";

describe("wallClockToUtc", () => {
  it("reads the same label as a different instant in each zone", () => {
    // The whole point of the zone parameter: this module holds no default and
    // no home zone, so the same wall clock is three different instants.
    expect(wallClockToUtc("2026-08-12T12:00:00", "Europe/Berlin")).toBe("2026-08-12T10:00:00.000Z");
    expect(wallClockToUtc("2026-08-12T12:00:00", "UTC")).toBe("2026-08-12T12:00:00.000Z");
    expect(wallClockToUtc("2026-08-12T12:00:00", "America/New_York")).toBe("2026-08-12T16:00:00.000Z");
  });

  it("follows a zone across its own DST transition", () => {
    // Berlin is +01:00 in January and +02:00 in August, so a fixed offset
    // would get one of these two wrong whichever it picked.
    expect(wallClockToUtc("2026-01-12T12:00:00", "Europe/Berlin")).toBe("2026-01-12T11:00:00.000Z");
    expect(wallClockToUtc("2026-08-12T12:00:00", "Europe/Berlin")).toBe("2026-08-12T10:00:00.000Z");
  });

  it("resolves the hour before a spring-forward through the offset then in force", () => {
    // Berlin jumps 02:00 -> 03:00 on 2026-03-29, i.e. at 01:00Z. Local 01:00 is
    // still on the pre-transition offset; pricing the offset at the naive
    // reading alone sees the post-transition one and lands an hour early on
    // 2026-03-28T23:00Z. This is what the second pass is for.
    expect(wallClockToUtc("2026-03-29T01:00:00", "Europe/Berlin")).toBe("2026-03-29T00:00:00.000Z");
    expect(wallClockToUtc("2026-03-29T03:00:00", "Europe/Berlin")).toBe("2026-03-29T01:00:00.000Z");
    // Southern-hemisphere direction, to show nothing here assumes northern DST.
    expect(wallClockToUtc("2026-10-04T03:00:00", "Australia/Sydney")).toBe("2026-10-03T16:00:00.000Z");
  });

  it("yields no instant for an unparseable wall clock", () => {
    expect(wallClockToUtc("not a date", "UTC")).toBeNull();
  });
});

describe("parseInstant", () => {
  it("reads a zone-less value as a wall clock in the given zone", () => {
    expect(parseInstant("2026-08-12 12:00:02", "Europe/Berlin")).toBe("2026-08-12T10:00:02.000Z");
    expect(parseInstant("2026-08-12T12:00", "Europe/Berlin")).toBe("2026-08-12T10:00:00.000Z");
  });

  it("keeps an offset the value states rather than shifting it again", () => {
    // The over-application guard: a qualified value is already an instant, so
    // the zone argument must not touch it.
    expect(parseInstant("2026-08-12T12:00:02Z", "Europe/Berlin")).toBe("2026-08-12T12:00:02.000Z");
    expect(parseInstant("2026-08-12T12:00:02.500Z", "Europe/Berlin")).toBe("2026-08-12T12:00:02.500Z");
    expect(parseInstant("2026-08-12T12:00:02+02:00", "America/New_York")).toBe("2026-08-12T10:00:02.000Z");
  });

  it("returns null rather than inventing an instant", () => {
    // Absence has to stay distinguishable from a timestamp: callers fall back to
    // their own clock on null, and a fabricated instant would date money wrongly.
    for (const value of ["", "   ", "not a date", null, undefined, 12, {}]) {
      expect(parseInstant(value, "Europe/Berlin"), String(value)).toBeNull();
    }
  });
});
