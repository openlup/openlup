const ISO_TIMESTAMP_WITH_EXPLICIT_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))$/;

export function normalizeOmnipackReconciliationTimestamp(
  value: string | null | undefined,
): string | null {
  const occurredAt = value?.trim();
  if (!occurredAt) return null;

  const match = ISO_TIMESTAMP_WITH_EXPLICIT_ZONE.exec(occurredAt);
  if (!match || !Number.isFinite(Date.parse(occurredAt))) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2
    ? leapYear ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;

  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return null;

  return occurredAt;
}
