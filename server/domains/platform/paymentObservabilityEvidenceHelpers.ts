export function secondsBetween(timestamp: number, now: Date): number {
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

export function latestTimestamp(...values: Array<string | null | undefined>): number {
  const timestamps = values
    .map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

export function readErrorReason(event: {
  error?: string | null;
  error_code?: string | null;
  rejection_reason?: string | null;
}): string {
  const value = event.error ?? event.error_code ?? event.rejection_reason;
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}
