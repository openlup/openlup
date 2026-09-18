import { describe, expect, it } from "vitest";
import {
  estimateDeliveryWindow,
  type DeliveryDispatchPolicy,
  type DeliveryEstimate,
} from "./deliveryEstimate.js";

/**
 * Most of the rule under test — cut-off side, working week, transit length — is
 * zone-independent, so it is exercised against a UTC policy where the ISO input
 * and the local wall clock are the same thing and the expectations read
 * directly. A real DST zone is named only in the two DST cases below, where the
 * conversion is the thing being proved.
 */
const UTC_POLICY: DeliveryDispatchPolicy = {
  timeZone: "UTC",
  cutoffHour: 16,
  businessDays: [1, 2, 3, 4, 5],
  // Every pre-existing case runs with an empty calendar, so they double as the
  // regression pin: holiday support must not move a single window when the
  // deployment lists no holidays.
  holidays: [],
  minTransitBusinessDays: 1,
  maxTransitBusinessDays: 2,
};

/**
 * Synthetic holidays. They are dates picked for their WEEKDAY, not for any
 * market's calendar — this file must stay locale-neutral, and a real national
 * calendar is pinned where it belongs, next to the market data that owns it.
 * 2026-01-01 is a Thursday, 2026-01-02 a Friday, 2026-01-03 a Saturday.
 */
const THU_HOLIDAY = "2026-01-01";
const FRI_HOLIDAY = "2026-01-02";
const SAT_HOLIDAY = "2026-01-03";

/** Same timetable, in a zone that actually shifts twice a year. */
const DST_POLICY: DeliveryDispatchPolicy = { ...UTC_POLICY, timeZone: "Europe/Warsaw" };

/** Calendar day an ISO instant falls on, read in a specific viewer timezone. */
function dayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Local calendar days of an estimate, as `dispatch|from|to`. */
function days(estimate: DeliveryEstimate | null, timeZone: string): string {
  if (!estimate) return "null";
  return [estimate.dispatchAtIso, estimate.fromIso, estimate.toIso]
    .map((iso) => dayIn(iso, timeZone))
    .join("|");
}

/** Days under the UTC policy, which is what most cases below assert against. */
const utcDays = (estimate: DeliveryEstimate | null) => days(estimate, UTC_POLICY.timeZone);

describe("estimateDeliveryWindow", () => {
  it("dispatches same day for a business-day charge before the cut-off", () => {
    // Tue 2026-07-07, 10:00.
    const estimate = estimateDeliveryWindow("2026-07-07T10:00:00.000Z", UTC_POLICY);
    expect(estimate?.sameDayDispatch).toBe(true);
    expect(estimate?.reason).toBe("same_day");
    // Dispatch Tue, delivery Wed..Thu.
    expect(utcDays(estimate)).toBe("2026-07-07|2026-07-08|2026-07-09");
  });

  it("treats the cut-off hour as exclusive", () => {
    // Tue 2026-07-07, exactly 16:00 — misses the run.
    const atCutoff = estimateDeliveryWindow("2026-07-07T16:00:00.000Z", UTC_POLICY);
    expect(atCutoff?.sameDayDispatch).toBe(false);
    expect(atCutoff?.reason).toBe("after_cutoff");
    expect(utcDays(atCutoff)).toBe("2026-07-08|2026-07-09|2026-07-10");

    // One minute earlier still makes it.
    const beforeCutoff = estimateDeliveryWindow("2026-07-07T15:59:00.000Z", UTC_POLICY);
    expect(beforeCutoff?.sameDayDispatch).toBe(true);
    expect(beforeCutoff?.reason).toBe("same_day");
    expect(utcDays(beforeCutoff)).toBe("2026-07-07|2026-07-08|2026-07-09");
  });

  it("rolls a late weekday charge to the next business day", () => {
    // Tue 2026-07-07, 19:00 -> dispatch Wed, delivery Thu..Fri.
    const estimate = estimateDeliveryWindow("2026-07-07T19:00:00.000Z", UTC_POLICY);
    expect(estimate?.reason).toBe("after_cutoff");
    expect(utcDays(estimate)).toBe("2026-07-08|2026-07-09|2026-07-10");
  });

  it("rolls a Friday-evening charge across the weekend to Monday", () => {
    // Headline real-world case: Fri 2026-07-10, 19:00.
    const estimate = estimateDeliveryWindow("2026-07-10T19:00:00.000Z", UTC_POLICY);
    expect(estimate?.sameDayDispatch).toBe(false);
    // Friday IS a business day under this policy — the parcel misses the run, it
    // does not hit a closed site. The operator explanation line must read
    // "after cut-off", never "weekend", even though dispatch lands on Monday.
    expect(estimate?.reason).toBe("after_cutoff");
    // Dispatch Mon 13th, delivery Tue 14th..Wed 15th — four days later than the
    // charge date, which is exactly the mis-information this helper removes.
    expect(utcDays(estimate)).toBe("2026-07-13|2026-07-14|2026-07-15");
  });

  it("dispatches non-working-day charges on the next business day regardless of hour", () => {
    // Sat 2026-07-11 at 09:00 and 23:00, Sun 2026-07-12 at 07:00.
    // The cut-off is irrelevant on a closed day, so early and late agree.
    for (const iso of ["2026-07-11T09:00:00.000Z", "2026-07-11T23:00:00.000Z", "2026-07-12T07:00:00.000Z"]) {
      const estimate = estimateDeliveryWindow(iso, UTC_POLICY);
      expect(estimate?.sameDayDispatch).toBe(false);
      expect(estimate?.reason).toBe("non_business_day");
      expect(utcDays(estimate)).toBe("2026-07-13|2026-07-14|2026-07-15");
    }
  });

  it("skips non-working days inside the delivery window", () => {
    // Thu 2026-07-09, 10:00 -> dispatch Thu, delivery Fri..Mon.
    const estimate = estimateDeliveryWindow("2026-07-09T10:00:00.000Z", UTC_POLICY);
    expect(estimate?.reason).toBe("same_day");
    expect(utcDays(estimate)).toBe("2026-07-09|2026-07-10|2026-07-13");
  });

  it("keeps sameDayDispatch exactly equivalent to reason === 'same_day'", () => {
    // Every hour of a full week, so the two fields cannot drift apart for any
    // combination of weekday and cut-off side.
    const seen = new Set<string>();
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      const iso = new Date(Date.UTC(2026, 6, 6) + hour * 3_600_000).toISOString();
      const estimate = estimateDeliveryWindow(iso, UTC_POLICY);
      expect(estimate).not.toBeNull();
      expect(estimate!.sameDayDispatch).toBe(estimate!.reason === "same_day");
      seen.add(estimate!.reason);
    }
    // The sweep really did exercise all three branches.
    expect([...seen].sort()).toEqual(["after_cutoff", "non_business_day", "same_day"]);
  });

  it("takes the cut-off hour, the working week and the transit length from the policy", () => {
    // A midday cut-off moves the same Tue 13:00 charge to the far side.
    const earlyCutoff = { ...UTC_POLICY, cutoffHour: 12 };
    expect(estimateDeliveryWindow("2026-07-07T13:00:00.000Z", earlyCutoff)?.reason).toBe("after_cutoff");
    expect(estimateDeliveryWindow("2026-07-07T11:00:00.000Z", earlyCutoff)?.reason).toBe("same_day");

    // A Sun-Thu working week closes Friday and opens Sunday — the exact inverse
    // of the Mon-Fri assumption, so a hard-coded weekend would fail here.
    const sunToThu: DeliveryDispatchPolicy = { ...UTC_POLICY, businessDays: [7, 1, 2, 3, 4] };
    const friday = estimateDeliveryWindow("2026-07-10T10:00:00.000Z", sunToThu);
    expect(friday?.reason).toBe("non_business_day");
    expect(days(friday, "UTC")).toBe("2026-07-12|2026-07-13|2026-07-14");
    expect(estimateDeliveryWindow("2026-07-12T10:00:00.000Z", sunToThu)?.reason).toBe("same_day");

    // Zero transit collapses the window onto the dispatch day.
    const sameDayCourier = { ...UTC_POLICY, minTransitBusinessDays: 0, maxTransitBusinessDays: 0 };
    expect(utcDays(estimateDeliveryWindow("2026-07-07T10:00:00.000Z", sameDayCourier)))
      .toBe("2026-07-07|2026-07-07|2026-07-07");

    // A slower carrier widens it, still skipping non-working days.
    const slow = { ...UTC_POLICY, minTransitBusinessDays: 2, maxTransitBusinessDays: 4 };
    expect(utcDays(estimateDeliveryWindow("2026-07-09T10:00:00.000Z", slow)))
      .toBe("2026-07-09|2026-07-13|2026-07-15");
  });

  it("reads the cut-off in the policy zone across the March DST switch", () => {
    // Mon 2026-03-30 14:30Z. The zone is already UTC+2 (DST began 29 March), so
    // the wall clock is 16:30 — after the cut-off. A UTC reading would say 14:30
    // and wrongly promise a same-day dispatch.
    const afterCutoff = estimateDeliveryWindow("2026-03-30T14:30:00.000Z", DST_POLICY);
    expect(afterCutoff?.reason).toBe("after_cutoff");
    expect(days(afterCutoff, DST_POLICY.timeZone)).toBe("2026-03-31|2026-04-01|2026-04-02");

    // Sun 2026-03-29 22:30Z is already Mon 2026-03-30 00:30 locally, i.e. a
    // business day before the cut-off. UTC would read Sunday.
    const dayShift = estimateDeliveryWindow("2026-03-29T22:30:00.000Z", DST_POLICY);
    expect(dayShift?.reason).toBe("same_day");
    expect(days(dayShift, DST_POLICY.timeZone)).toBe("2026-03-30|2026-03-31|2026-04-01");
  });

  it("reads the cut-off in the policy zone across the October DST switch", () => {
    // Mon 2026-10-26 15:30Z. The zone is back on UTC+1 (DST ended 25 October),
    // so the wall clock is 16:30 — after the cut-off.
    const afterCutoff = estimateDeliveryWindow("2026-10-26T15:30:00.000Z", DST_POLICY);
    expect(afterCutoff?.reason).toBe("after_cutoff");
    expect(days(afterCutoff, DST_POLICY.timeZone)).toBe("2026-10-27|2026-10-28|2026-10-29");

    // Sun 2026-10-25 23:30Z is already Mon 2026-10-26 00:30 locally.
    const dayShift = estimateDeliveryWindow("2026-10-25T23:30:00.000Z", DST_POLICY);
    expect(dayShift?.reason).toBe("same_day");
    expect(days(dayShift, DST_POLICY.timeZone)).toBe("2026-10-26|2026-10-27|2026-10-28");
  });

  it("anchors returned instants at 12:00 local so viewer-timezone rendering is stable", () => {
    const estimate = estimateDeliveryWindow("2026-07-07T10:00:00.000Z", UTC_POLICY);
    expect(estimate).not.toBeNull();

    const isoValues = [estimate!.dispatchAtIso, estimate!.fromIso, estimate!.toIso];
    for (const iso of isoValues) {
      const clock = new Intl.DateTimeFormat("en-GB", {
        timeZone: UTC_POLICY.timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso));
      expect(clock).toBe("12:00");
    }

    // The formatters in the account UI render without a timeZone, so the day
    // must survive a wide spread of viewer offsets.
    for (const timeZone of ["America/Los_Angeles", "America/New_York", "UTC", "Asia/Tokyo", "Australia/Sydney"]) {
      expect(isoValues.map((iso) => dayIn(iso, timeZone)).join("|"))
        .toBe("2026-07-07|2026-07-08|2026-07-09");
    }
  });

  it("moves the noon anchor with the zone's own offset", () => {
    // Winter is UTC+1, summer UTC+2 in the DST zone — proof the anchor is solved
    // against the real offset rather than a fixed one.
    expect(estimateDeliveryWindow("2026-01-06T09:00:00.000Z", DST_POLICY)?.dispatchAtIso)
      .toBe("2026-01-06T11:00:00.000Z");
    expect(estimateDeliveryWindow("2026-07-07T08:00:00.000Z", DST_POLICY)?.dispatchAtIso)
      .toBe("2026-07-07T10:00:00.000Z");
    // The UTC policy anchors at plain noon.
    expect(estimateDeliveryWindow("2026-07-07T08:00:00.000Z", UTC_POLICY)?.dispatchAtIso)
      .toBe("2026-07-07T12:00:00.000Z");
  });

  it("returns null for missing or unparseable input instead of throwing", () => {
    expect(estimateDeliveryWindow("", UTC_POLICY)).toBeNull();
    expect(estimateDeliveryWindow("   ", UTC_POLICY)).toBeNull();
    expect(estimateDeliveryWindow("not-a-date", UTC_POLICY)).toBeNull();
    expect(estimateDeliveryWindow("2026-13-45T99:00:00.000Z", UTC_POLICY)).toBeNull();
    expect(estimateDeliveryWindow(null as unknown as string, UTC_POLICY)).toBeNull();
    expect(estimateDeliveryWindow(undefined as unknown as string, UTC_POLICY)).toBeNull();
    expect(estimateDeliveryWindow(42 as unknown as string, UTC_POLICY)).toBeNull();
  });

  it("returns null for a policy it cannot answer under, instead of throwing or hanging", () => {
    const iso = "2026-07-07T10:00:00.000Z";
    const bad = (patch: Partial<DeliveryDispatchPolicy>) =>
      estimateDeliveryWindow(iso, { ...UTC_POLICY, ...patch } as DeliveryDispatchPolicy);

    // An empty working week would otherwise spin the business-day walk forever.
    expect(bad({ businessDays: [] })).toBeNull();
    expect(bad({ businessDays: [0 as unknown as 1] })).toBeNull();
    expect(bad({ businessDays: [8 as unknown as 1] })).toBeNull();
    expect(bad({ cutoffHour: -1 })).toBeNull();
    expect(bad({ cutoffHour: 25 })).toBeNull();
    expect(bad({ cutoffHour: 9.5 })).toBeNull();
    expect(bad({ minTransitBusinessDays: -1 })).toBeNull();
    expect(bad({ minTransitBusinessDays: 3, maxTransitBusinessDays: 2 })).toBeNull();
    expect(bad({ timeZone: "" })).toBeNull();
    expect(bad({ timeZone: "Nowhere/Nothing" })).toBeNull();
    expect(estimateDeliveryWindow(iso, null as unknown as DeliveryDispatchPolicy)).toBeNull();
    expect(estimateDeliveryWindow(iso, undefined as unknown as DeliveryDispatchPolicy)).toBeNull();
  });

  it("defers a listed holiday that falls on a working weekday, and says so", () => {
    // Thu 2026-01-01 10:00, before the cut-off: without the calendar this would
    // be a same-day dispatch. Dispatch slips to Fri, delivery Mon..Tue.
    const policy = { ...UTC_POLICY, holidays: [THU_HOLIDAY] };
    const estimate = estimateDeliveryWindow(`${THU_HOLIDAY}T10:00:00.000Z`, policy);
    expect(estimate?.reason).toBe("holiday");
    expect(estimate?.sameDayDispatch).toBe(false);
    expect(estimate?.holidayDeferred).toBe(true);
    expect(utcDays(estimate)).toBe("2026-01-02|2026-01-05|2026-01-06");

    // The cut-off is irrelevant on a day the site is closed, exactly as for a
    // weekend: a late charge on the same holiday reports the same thing.
    const late = estimateDeliveryWindow(`${THU_HOLIDAY}T19:00:00.000Z`, policy);
    expect(late?.reason).toBe("holiday");
    expect(utcDays(late)).toBe(utcDays(estimate));
  });

  it("keeps a holiday that lands on a non-working day as a non-business day", () => {
    // Sat 2026-01-03 is closed by the working week alone. Calling it a "holiday"
    // would credit the calendar with a deferral it did not cause, and the
    // operator label for the weekly pattern is the honest one.
    const estimate = estimateDeliveryWindow(`${SAT_HOLIDAY}T10:00:00.000Z`, { ...UTC_POLICY, holidays: [SAT_HOLIDAY] });
    expect(estimate?.reason).toBe("non_business_day");
    expect(estimate?.holidayDeferred).toBe(false);
    // Identical to the same Saturday with no calendar at all.
    expect(utcDays(estimate)).toBe(utcDays(estimateDeliveryWindow(`${SAT_HOLIDAY}T10:00:00.000Z`, UTC_POLICY)));

    // The same rule inside the transit walk, which is where the walk really does
    // step over that Saturday: it is skipped for being a Saturday, so the
    // calendar gets no credit. Fri 2026-01-02 10:00 -> dispatch Fri, delivery
    // Mon..Tue, with or without the listing.
    const crossing = estimateDeliveryWindow(`${FRI_HOLIDAY}T10:00:00.000Z`, { ...UTC_POLICY, holidays: [SAT_HOLIDAY] });
    expect(crossing?.reason).toBe("same_day");
    expect(crossing?.holidayDeferred).toBe(false);
    expect(utcDays(crossing)).toBe("2026-01-02|2026-01-05|2026-01-06");
  });

  it("stretches the transit walk across a holiday cluster without changing the dispatch reason", () => {
    // Wed 2025-12-31 10:00, before the cut-off: dispatch is unaffected, but the
    // two working days that follow are both listed, so with the weekend behind
    // them the parcel cannot move until Monday. This is the end-of-year cluster
    // shape (two adjacent listed weekdays) that made the old estimate optimistic.
    const estimate = estimateDeliveryWindow("2025-12-31T10:00:00.000Z", {
      ...UTC_POLICY,
      holidays: [THU_HOLIDAY, FRI_HOLIDAY],
    });
    expect(estimate?.reason).toBe("same_day");
    expect(estimate?.sameDayDispatch).toBe(true);
    // The window moved even though the dispatch day did not — which is exactly
    // what `holidayDeferred` has to report.
    expect(estimate?.holidayDeferred).toBe(true);
    expect(utcDays(estimate)).toBe("2025-12-31|2026-01-05|2026-01-06");

    // Same charge, empty calendar: Thu..Fri, four days earlier at the far end.
    expect(utcDays(estimateDeliveryWindow("2025-12-31T10:00:00.000Z", UTC_POLICY)))
      .toBe("2025-12-31|2026-01-01|2026-01-02");
  });

  it("leaves the window and the flag untouched when no listed day is consulted", () => {
    // A calendar full of dates outside the estimated period must be inert. Any
    // other answer would mean the flag is guessing rather than observing.
    const far = { ...UTC_POLICY, holidays: [THU_HOLIDAY, FRI_HOLIDAY, SAT_HOLIDAY, "2030-06-11"] };
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      const iso = new Date(Date.UTC(2026, 6, 6) + hour * 3_600_000).toISOString();
      const withCalendar = estimateDeliveryWindow(iso, far);
      expect(withCalendar).toEqual(estimateDeliveryWindow(iso, UTC_POLICY));
      expect(withCalendar?.holidayDeferred).toBe(false);
    }
  });

  it("keeps sameDayDispatch equivalent to reason === 'same_day' once holidays are in play", () => {
    const policy = { ...UTC_POLICY, holidays: [THU_HOLIDAY, FRI_HOLIDAY, SAT_HOLIDAY] };
    const seen = new Set<string>();
    // The week containing all three synthetic dates, hour by hour.
    for (let hour = 0; hour < 24 * 8; hour += 1) {
      const estimate = estimateDeliveryWindow(new Date(Date.UTC(2025, 11, 30) + hour * 3_600_000).toISOString(), policy);
      expect(estimate).not.toBeNull();
      expect(estimate!.sameDayDispatch).toBe(estimate!.reason === "same_day");
      seen.add(estimate!.reason);
    }
    // The sweep really did reach the new branch alongside the three old ones.
    expect([...seen].sort()).toEqual(["after_cutoff", "holiday", "non_business_day", "same_day"]);
  });

  it("rejects a malformed holiday calendar instead of silently ignoring the bad entry", () => {
    // Fail-closed, like the empty working week: a caller that built the list
    // wrongly must not get a confident window built on the rest of it.
    const iso = "2026-07-07T10:00:00.000Z";
    const bad = (holidays: unknown) =>
      estimateDeliveryWindow(iso, { ...UTC_POLICY, holidays } as DeliveryDispatchPolicy);

    expect(bad("2026-01-01")).toBeNull();
    expect(bad(null)).toBeNull();
    expect(bad(undefined)).toBeNull();
    expect(bad(["2026-1-1"])).toBeNull();
    expect(bad(["01-01-2026"])).toBeNull();
    expect(bad(["2026-01-01T00:00:00.000Z"])).toBeNull();
    expect(bad(["not-a-date"])).toBeNull();
    expect(bad([20_260_101])).toBeNull();
    // One bad entry among good ones invalidates the whole policy.
    expect(bad([THU_HOLIDAY, "2026-1-2", SAT_HOLIDAY])).toBeNull();
    // The well-formed control still answers.
    expect(bad([THU_HOLIDAY])).not.toBeNull();
  });

  it("is pure — repeated calls with the same input are identical", () => {
    const first = estimateDeliveryWindow("2026-07-10T19:00:00.000Z", UTC_POLICY);
    const second = estimateDeliveryWindow("2026-07-10T19:00:00.000Z", UTC_POLICY);
    expect(first).toEqual(second);
  });
});
