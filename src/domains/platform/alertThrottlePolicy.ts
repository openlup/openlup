import type { AlertSeverity } from "./observabilityContracts.js";

/**
 * Per-severity re-notification cadence for platform watchdog alerts.
 *
 * A firing alert re-pages at most once per this window (keyed off
 * `last_notified_at`). Lower severities re-page less often so a persistent
 * low-severity alert cannot flood the channel, while p0 stays loud.
 */
const THROTTLE_SECONDS_BY_SEVERITY: Record<AlertSeverity, number> = {
  p0: 1 * 60 * 60, // 1h
  p1: 4 * 60 * 60, // 4h
  p2: 12 * 60 * 60, // 12h
  p3: 24 * 60 * 60, // 24h
};

/** Fallback window for an unknown/unparseable severity. */
export const DEFAULT_THROTTLE_SECONDS = 60 * 60;

export function throttleSecondsForSeverity(severity: string): number {
  return THROTTLE_SECONDS_BY_SEVERITY[severity as AlertSeverity] ?? DEFAULT_THROTTLE_SECONDS;
}
