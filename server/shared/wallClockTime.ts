/**
 * Reading a timestamp from a rail that does not say what clock it is on.
 *
 * A value carrying `Z` or `±HH:mm` is already an instant and is honoured as
 * written. A value without one is a WALL CLOCK — a label on someone's local
 * time — and turning it into an instant needs the zone that clock runs on.
 * `Date.parse` resolves such a value against the HOST zone, which is a silent
 * trap: it reads correct on a laptop set to the rail's own zone and skews by
 * the offset on the UTC runtime that serves production. Callers therefore pass
 * the zone explicitly; there is no default, because a wrong default is exactly
 * the bug this module exists to remove.
 */

/** A date-time with no `Z` and no `±HH:mm`, i.e. a bare wall-clock label. */
const ZONELESS_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** Milliseconds `timeZone` is ahead of UTC at `at` (negative when west of it). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const zone = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{1,2}):(\d{2})$/.exec(zone ?? "");
  if (!match) return 0;
  const [, sign, hours, minutes] = match;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}

/**
 * The UTC instant of a zone-less `YYYY-MM-DDTHH:mm[:ss]` read in `timeZone`.
 *
 * Two passes, because the offset is a function of the answer being computed:
 * the first prices the naive reading, the second re-prices it at the instant
 * that produced. That is what makes the conversion hold on both sides of a DST
 * transition rather than only in the half-year it was written in — a single
 * pass reads the hour after a spring-forward an hour early. A local time the
 * transition skips or repeats resolves through the offset in force at the first
 * pass; no wall clock can separate those two readings.
 */
export function wallClockToUtc(wallClock: string, timeZone: string): string | null {
  const asIfUtc = Date.parse(`${wallClock}Z`);
  if (!Number.isFinite(asIfUtc)) return null;
  const firstPass = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - zoneOffsetMs(new Date(firstPass), timeZone)).toISOString();
}

/**
 * An ISO UTC instant for `value`, or `null` when it does not carry one. A
 * zone-less value is read as a wall clock in `timeZone`; a value stating its
 * own offset keeps it. Never invents an instant — the absence of a readable
 * timestamp must stay distinguishable from a timestamp.
 */
export function parseInstant(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const zoneless = ZONELESS_DATE_TIME.exec(trimmed);
  if (zoneless) return wallClockToUtc(`${zoneless[1]}T${zoneless[2]}`, timeZone);
  return Number.isFinite(Date.parse(trimmed)) ? new Date(trimmed).toISOString() : null;
}
