// Internal: no public declaration imports this module, so it stays out of the API report.

/** The last millisecond of the year 9999, the end of the four-digit-year instant a verdict carries. */
export const UTC_INSTANT_MAX_MS = 253_402_300_799_999;

const DAY_MS = 86_400_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Formats integer milliseconds since the Unix epoch as `YYYY-MM-DDTHH:mm:ss.sssZ`
 * without reading a clock or `Date`, which the storefront source refuses. The
 * domain is 0 to the end of the year 9999; any other value, a fraction or a
 * non-number throws `storefront_run_input_invalid`.
 */
export function utcInstant(ms: number): string {
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0 || ms > UTC_INSTANT_MAX_MS) {
    throw new TypeError(`storefront_run_input_invalid: clock.now() returned ${typeof ms === "number" ? String(ms) : typeof ms}. `
      + `Cause: a verdict's completedAt needs integer milliseconds from 0 to ${UTC_INSTANT_MAX_MS}. `
      + "Fix: pass a clock whose now() returns integer epoch milliseconds, for example { now: () => Date.now() } in the harness. "
      + "Recheck: run the scenario again.");
  }
  const days = Math.floor(ms / DAY_MS);
  let rest = ms - days * DAY_MS;
  // Civil date from days since 1970-01-01 (proleptic Gregorian), counted in 400-year eras that start on 1 March.
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  const seconds = Math.floor(rest / 1_000);
  const millis = rest - seconds * 1_000;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}Z`;
}
