/**
 * Computus — the date of Easter Sunday in the Gregorian calendar, and the days
 * derived from it by a fixed offset.
 *
 * This is pure calendar arithmetic with no market, operator or locale in it: the
 * same numbers serve every calendar that anchors movable observances on Easter.
 * Which of those days a given deployment treats as non-working is emphatically
 * NOT decided here — that list is data supplied by the deployment (see the
 * `holidays` field of `DeliveryDispatchPolicy`).
 *
 * Algorithm: Meeus/Jones/Butcher, the standard Gregorian computus. It is exact
 * for the whole Gregorian range; the implementation below is the algorithm
 * transcribed literally, so it is checked against a hand-verified table of
 * Easter dates rather than by reasoning about the intermediate variables.
 */

/** Calendar date as `YYYY-MM-DD`; a civil day, never an instant. */
export type CalendarDateIso = string;

/**
 * Easter Sunday of `year`, as a calendar date.
 *
 * Throws `RangeError` for a non-integer or out-of-range year: unlike the
 * delivery estimator, this is a total mathematical function whose only failure
 * mode is a caller passing something that is not a year, and a silent `null`
 * there would be baked into a holiday list at module load.
 */
export function easterSunday(year: number): CalendarDateIso {
  if (!Number.isInteger(year) || year < 1583 || year > 9999) {
    throw new RangeError(`easterSunday: year must be an integer in 1583..9999, received ${String(year)}`);
  }
  // Meeus/Jones/Butcher. Variable names are the algorithm's own, deliberately:
  // renaming them to something "meaningful" only makes the transcription
  // impossible to check against the published statement of the algorithm.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(Date.UTC(year, month - 1, day));
}

/**
 * The day `offsetDays` after Easter Sunday of `year` — how every Easter-relative
 * movable observance is defined. The offset may cross a month or year boundary;
 * the arithmetic is done on a UTC day token so it cannot be bent by a local zone.
 */
export function easterRelativeDay(year: number, offsetDays: number): CalendarDateIso {
  if (!Number.isInteger(offsetDays)) {
    throw new RangeError(`easterRelativeDay: offsetDays must be an integer, received ${String(offsetDays)}`);
  }
  const easter = easterSunday(year);
  return isoDate(Date.parse(`${easter}T00:00:00.000Z`) + offsetDays * 86_400_000);
}

function isoDate(utcMs: number): CalendarDateIso {
  return new Date(utcMs).toISOString().slice(0, 10);
}
