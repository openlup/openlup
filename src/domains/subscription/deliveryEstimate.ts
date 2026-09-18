/**
 * Estimated DELIVERY window for a subscription cycle.
 *
 * Input is the **charge / paid instant** (`subscription_cycles.paid_at`, or
 * `subscriptions.next_cycle_at` when projecting the next renewal). Output is an
 * estimate of when the parcel leaves the fulfilment site and when it lands.
 *
 * ⛔ This module is presentation-only. It must never be used to compute or write
 * `subscriptions.next_cycle_at`, `subscription_cycles.*`, or any other persisted
 * schedule value — money-path dates keep their existing semantics. The function
 * is pure: no clock, no I/O, no globals, so it cannot become a writer by
 * accident.
 *
 * The dispatch rule itself is **not** a property of subscriptions — it is one
 * fulfilment operator's timetable in one market. Every part of it (zone, cut-off
 * hour, which weekdays are worked, transit length) is therefore a required
 * `policy` argument with no default: this file stays locale-neutral, and each
 * call site has to name the policy it is estimating under. The deployment's own
 * policy lives in the overlay, not here.
 *
 * Non-working public holidays are part of that timetable and arrive the same
 * way: as `policy.holidays`, a list of calendar dates in the policy's zone. This
 * file owns no calendar of its own — computing one would hard-code a market.
 */

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO weekday numbers, 1 = Monday .. 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * One fulfilment operator's dispatch timetable. Supplied by the caller; see the
 * module comment for why there is no default.
 */
export interface DeliveryDispatchPolicy {
  /** IANA zone the operator's business day is measured in. */
  timeZone: string;
  /** Local hour (0-23) from which a charge no longer makes that day's run. */
  cutoffHour: number;
  /** Weekdays the operator dispatches on. */
  businessDays: readonly IsoWeekday[];
  /**
   * Calendar dates (`YYYY-MM-DD`, read in `timeZone`) the site does not work, on
   * top of the weekly pattern. Required and without a default like every other
   * field: a deployment with no such days passes `[]` and says so.
   */
  holidays: readonly string[];
  /** Business days from dispatch to the earliest delivery day. */
  minTransitBusinessDays: number;
  /** Business days from dispatch to the latest delivery day. */
  maxTransitBusinessDays: number;
}

/**
 * Why the parcel dispatches when it does. Operator-facing surfaces render an
 * explanation line from this — "after the cut-off" versus "not a working day" —
 * so the distinction lives here rather than being re-derived by callers, which
 * would duplicate the zone conversion this module owns.
 *
 * Note `after_cutoff` covers a working Friday evening under a Mon-Fri policy:
 * Friday is a business day even though dispatch lands on Monday. Only days the
 * policy does not work are `non_business_day`, and for those the cut-off is
 * irrelevant.
 *
 * `holiday` is distinct from `non_business_day` because the operator-facing label
 * for the latter is a weekly-pattern statement ("weekend" in a Mon-Fri market),
 * which a listed holiday on a working weekday is not. A holiday landing on a day
 * the policy already does not work stays `non_business_day`: the weekly pattern
 * closed the site, the listing changed nothing.
 */
export type DeliveryDispatchReason = "same_day" | "after_cutoff" | "non_business_day" | "holiday";

export interface DeliveryEstimate {
  /** Business day the parcel leaves the fulfilment site. */
  dispatchAtIso: string;
  /** Earliest estimated delivery day. */
  fromIso: string;
  /** Latest estimated delivery day. */
  toIso: string;
  /** True when the charge landed on a business day before the cut-off. */
  sameDayDispatch: boolean;
  /** Dispatch explanation; always equivalent to `sameDayDispatch === (reason === "same_day")`. */
  reason: DeliveryDispatchReason;
  /**
   * True when a listed holiday actually moved this window — it deferred dispatch
   * or stretched the transit walk. Derived from the walk, not from "is there a
   * holiday nearby": a holiday on a day the weekly pattern already closed leaves
   * this `false`, because the window is identical without the listing. Callers
   * add a "holidays included" note only when this says something.
   */
  holidayDeferred: boolean;
}

/**
 * Maps a charge instant to the estimated delivery window under `policy`.
 * Returns `null` for missing or unparseable input, and for a policy that cannot
 * produce an answer (unknown zone, no business days, negative transit). Never
 * throws.
 */
export function estimateDeliveryWindow(
  chargeIso: string,
  policy: DeliveryDispatchPolicy,
): DeliveryEstimate | null {
  const charge = parseInstant(chargeIso);
  if (!charge) return null;
  if (!isUsablePolicy(policy)) return null;

  const zoned = zonedPartsFormatter(policy.timeZone);
  if (!zoned) return null;

  // One Set per call, built from the policy rather than cached across calls, so
  // the function stays pure and a caller may vary the calendar freely.
  const walk = createWalk(policy, new Set(policy.holidays));

  const local = zonedParts(zoned, charge);
  const chargeDay = calendarDay(local);
  const reason: DeliveryDispatchReason = !isWorkingWeekday(chargeDay, policy)
    ? "non_business_day"
    : !walk.isOpen(chargeDay)
      ? "holiday"
      : local.hour < policy.cutoffHour
        ? "same_day"
        : "after_cutoff";

  // Kept as the single derivation so the two fields cannot drift.
  const sameDayDispatch = reason === "same_day";
  const dispatchDay = sameDayDispatch ? chargeDay : walk.nextOpenDay(chargeDay);

  const fromDay = walk.addOpenDays(dispatchDay, policy.minTransitBusinessDays);
  const toDay = walk.addOpenDays(dispatchDay, policy.maxTransitBusinessDays);

  return {
    dispatchAtIso: localNoonIso(dispatchDay, zoned),
    fromIso: localNoonIso(fromDay, zoned),
    toIso: localNoonIso(toDay, zoned),
    sameDayDispatch,
    reason,
    holidayDeferred: walk.holidayDeferred(),
  };
}

function isUsablePolicy(policy: DeliveryDispatchPolicy): boolean {
  if (!policy || typeof policy !== "object") return false;
  // An empty or malformed business-day set would spin `nextBusinessDay` forever,
  // so it is rejected up front rather than bounded inside the loop.
  if (!Array.isArray(policy.businessDays) || policy.businessDays.length === 0) return false;
  if (!policy.businessDays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) return false;
  // Fail closed on the calendar too. A single unparseable entry means the caller
  // built the list wrongly, and silently ignoring it would quietly promise
  // dispatch on a closed day — the exact failure this field exists to prevent.
  if (!Array.isArray(policy.holidays)) return false;
  if (!policy.holidays.every((date) => typeof date === "string" && CALENDAR_DATE.test(date))) return false;
  if (!Number.isInteger(policy.cutoffHour) || policy.cutoffHour < 0 || policy.cutoffHour > 24) return false;
  const { minTransitBusinessDays: min, maxTransitBusinessDays: max } = policy;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) return false;
  return typeof policy.timeZone === "string" && policy.timeZone.length > 0;
}

function parseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads Y/M/D/H in the policy's zone. `en-CA` yields ISO-ish `YYYY-MM-DD` parts,
 * and `hour12: false` gives a 0-23 hour (some engines emit "24" for midnight,
 * normalised below). Using Intl rather than a hand-rolled offset keeps this
 * DST-correct by construction for any zone. Returns `null` for a zone the
 * runtime does not know, which is the only way this constructor fails.
 */
function zonedPartsFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(formatter: Intl.DateTimeFormat, instant: Date): ZonedParts {
  const parts = new Map<string, string>();
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    // Some engines render midnight as hour "24" under hour12:false.
    hour: Number(parts.get("hour")) % 24,
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  };
}

/**
 * A calendar day is carried as a UTC-midnight timestamp. This is a *civil* day
 * token used only for weekday arithmetic — it is never rendered directly, and
 * never treated as an instant.
 */
type CalendarDay = number;

function calendarDay(local: ZonedParts): CalendarDay {
  return Date.UTC(local.year, local.month - 1, local.day);
}

function isWorkingWeekday(day: CalendarDay, policy: DeliveryDispatchPolicy): boolean {
  const weekday = new Date(day).getUTCDay();
  // getUTCDay is 0-6 with 0 = Sunday; the policy speaks ISO 1-7 with 7 = Sunday.
  return policy.businessDays.includes((weekday === 0 ? 7 : weekday) as IsoWeekday);
}

function calendarDateOf(day: CalendarDay): string {
  // The day token is UTC midnight by construction, so this is its civil date.
  return new Date(day).toISOString().slice(0, 10);
}

/**
 * The business-day walk for one call, plus the record of whether a listed
 * holiday ever changed its answer. That record is observed, not predicted: the
 * flag is raised only where the walk actually rejected a day it would otherwise
 * have worked, which is why the weekday check runs first — a Saturday that is
 * also listed never reaches the calendar lookup, so the weekend keeps the credit.
 */
function createWalk(policy: DeliveryDispatchPolicy, holidays: ReadonlySet<string>) {
  let deferred = false;
  const isOpen = (day: CalendarDay): boolean => {
    if (!isWorkingWeekday(day, policy)) return false;
    if (holidays.has(calendarDateOf(day))) {
      deferred = true;
      return false;
    }
    return true;
  };
  const nextOpenDay = (day: CalendarDay): CalendarDay => {
    let next = day + DAY_MS;
    while (!isOpen(next)) next += DAY_MS;
    return next;
  };
  return {
    isOpen,
    nextOpenDay,
    addOpenDays: (day: CalendarDay, count: number): CalendarDay => {
      let result = day;
      for (let step = 0; step < count; step += 1) result = nextOpenDay(result);
      return result;
    },
    holidayDeferred: () => deferred,
  };
}

/**
 * Anchors a calendar day at 12:00 in the policy's zone.
 *
 * ⚠️ Do not "simplify" this to midnight or to a bare `toISOString()` of the day
 * token. The account formatters (`src/pages/account/v2/lib/format.ts`) call
 * `Intl.DateTimeFormat` **without** a `timeZone`, so they render in the viewer's
 * browser timezone. A midnight-anchored instant renders as the previous or next
 * calendar day for viewers a few hours either side of the fulfilment zone; local
 * noon keeps day-level rendering stable across every realistic viewer offset.
 */
function localNoonIso(day: CalendarDay, formatter: Intl.DateTimeFormat): string {
  const parts = new Date(day);
  const wantUtc = Date.UTC(parts.getUTCFullYear(), parts.getUTCMonth(), parts.getUTCDate(), 12);
  // Solve for the instant whose local wall clock reads 12:00. Noon is far from
  // the usual DST transition hours, so one refinement pass converges.
  const firstGuess = wantUtc - zoneOffsetMs(formatter, new Date(wantUtc));
  const refined = wantUtc - zoneOffsetMs(formatter, new Date(firstGuess));
  return new Date(refined).toISOString();
}

/** Zone offset from UTC, in ms, at the given instant (positive east of UTC). */
function zoneOffsetMs(formatter: Intl.DateTimeFormat, instant: Date): number {
  const local = zonedParts(formatter, instant);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - instant.getTime();
}
