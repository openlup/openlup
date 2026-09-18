/**
 * Date / cadence formatting for the account UI. Thin wrappers over Intl so PL
 * and EN render natively. Countdown is computed from real "now" — these are
 * real schedule facts (`nextCycleAt`, `cadenceDays`), never fabricated.
 */

import type { DeliveryEstimate } from "@/domains/subscription/deliveryEstimate";

export type AccountLang = "pl" | "en";

/**
 * The day-level part of a `DeliveryEstimate`. Both ISO instants are anchored at
 * 12:00 in the dispatch policy's own zone by `estimateDeliveryWindow`, which is
 * what keeps the timezone-less `Intl.DateTimeFormat` calls below rendering the
 * intended calendar day for every realistic viewer offset. Do not re-anchor
 * them.
 */
export type DeliveryWindow = Pick<DeliveryEstimate, "fromIso" | "toIso">;

/**
 * The part of a `DeliveryEstimate` the conditional holiday note reads. Separate
 * from `DeliveryWindow` so the formatters below stay purely about dates.
 */
export type DeliveryNoteSource = Pick<DeliveryEstimate, "holidayDeferred">;

/**
 * i18n key for the holiday caveat. Kept next to the predicate so the copy and
 * the condition that reveals it cannot drift apart across the four surfaces.
 */
const HOLIDAY_NOTE_KEY = "account:dashboard.subscriptionV2.holidayNote";

/**
 * The short note appended after a rendered delivery window — **only** when a
 * public holiday (not a plain weekend) actually moved that window. Returns null
 * otherwise, which is the normal case: a permanent "we account for holidays"
 * line next to every date is noise, not information.
 *
 * `translate` is the caller's own `t` from `useTranslation("account")`. The
 * lookup is not done here because this module is imported by SSR renders that
 * each own a per-request i18n instance; resolving against a module-level
 * singleton would render one request's language into another's HTML.
 */
export function deliveryWindowNote(
  estimate: DeliveryNoteSource | null | undefined,
  translate: (key: string) => string,
): string | null {
  return estimate?.holidayDeferred ? translate(HOLIDAY_NOTE_KEY) : null;
}

/** "29 czerwca" / "29 June" — day + long month, no year. */
export function formatDayMonth(value: string | null, lang: AccountLang): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(date);
}

/** "poniedziałek, 29 czerwca" / "Monday, 29 June". */
export function formatWeekdayDayMonth(value: string | null, lang: AccountLang): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/**
 * Whole calendar-ish days from now until `value` (>= 0); null when no date.
 * Rounds to the nearest day so a delivery ~6 days + a few hours away reads as
 * "6 days", matching the countdown copy.
 */
export function daysUntil(value: string | null, now: Date = new Date()): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const ms = date.getTime() - now.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/* -------------------------------------------------------------------------- */
/* Delivery-window formatting                                                  */
/*                                                                            */
/* `next_cycle_at` is the CHARGE instant, not a delivery date. Surfaces that    */
/* talk about delivery render an estimated *window* instead, so they need a     */
/* compact form for tiles/chips and a long form for prose.                     */
/* -------------------------------------------------------------------------- */

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface NumericDayMonth {
  /** Unpadded day, e.g. "7". */
  day: string;
  /** Zero-padded month, e.g. "04". */
  month: string;
  year: string;
}

function numericDayMonth(date: Date, lang: AccountLang): NumericDayMonth {
  const parts = new Intl.DateTimeFormat(lang, {
    day: "numeric",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: read("day"), month: read("month"), year: read("year") };
}

function sameMonth(a: NumericDayMonth, b: NumericDayMonth): boolean {
  return a.month === b.month && a.year === b.year;
}

/**
 * True when the locale writes the month before the day ("April 8"), which is
 * what decides whether the compact long form ("wt 7 – śr 8 kwietnia") stays
 * unambiguous. In a month-first locale the month must be repeated on both
 * sides, otherwise "Tue 7 – Wed April 8" reads as a broken sentence.
 */
function monthPrecedesDay(lang: AccountLang): boolean {
  const parts = new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).formatToParts(
    new Date(Date.UTC(2026, 3, 8, 12)),
  );
  return parts.findIndex((p) => p.type === "month") < parts.findIndex((p) => p.type === "day");
}

/** "wt" / "Tue" — short weekday without the locale's trailing abbreviation dot. */
function shortWeekday(date: Date, lang: AccountLang): string {
  return new Intl.DateTimeFormat(lang, { weekday: "short" }).format(date).replace(/\.+$/, "");
}

/** "3.04" — unpadded day + zero-padded month, no year. */
export function formatDayMonthShort(value: string | null, lang: AccountLang): string {
  const date = toDate(value);
  if (!date) return "–";
  const parts = numericDayMonth(date, lang);
  return `${parts.day}.${parts.month}`;
}

/** "wt 31 marca" / "Tue March 31" — short weekday + the locale's day/month order. */
export function formatShortWeekdayDayMonth(value: string | null, lang: AccountLang): string {
  const date = toDate(value);
  if (!date) return "–";
  return `${shortWeekday(date, lang)} ${formatDayMonth(value, lang)}`;
}

/** "7–8.04", widening to "30.06–1.07" when the window straddles two months. */
export function formatDeliveryWindowShort(
  window: DeliveryWindow | null | undefined,
  lang: AccountLang,
): string {
  const from = toDate(window?.fromIso ?? null);
  const to = toDate(window?.toIso ?? null);
  if (!from || !to) return "–";
  const a = numericDayMonth(from, lang);
  const b = numericDayMonth(to, lang);
  if (sameMonth(a, b)) return `${a.day}–${b.day}.${b.month}`;
  return `${a.day}.${a.month}–${b.day}.${b.month}`;
}

/** "wt 7 – śr 8 kwietnia" / "Tue April 7 – Wed April 8". */
export function formatDeliveryWindowLong(
  window: DeliveryWindow | null | undefined,
  lang: AccountLang,
): string {
  const from = toDate(window?.fromIso ?? null);
  const to = toDate(window?.toIso ?? null);
  if (!from || !to) return "–";
  const compact =
    sameMonth(numericDayMonth(from, lang), numericDayMonth(to, lang)) && !monthPrecedesDay(lang);
  const head = compact
    ? `${shortWeekday(from, lang)} ${numericDayMonth(from, lang).day}`
    : formatShortWeekdayDayMonth(window?.fromIso ?? null, lang);
  return `${head} – ${formatShortWeekdayDayMonth(window?.toIso ?? null, lang)}`;
}
