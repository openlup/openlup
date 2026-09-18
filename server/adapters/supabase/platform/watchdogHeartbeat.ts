import type { SupabaseAlertLedgerClient } from "./alertLedgerPort.js";

/**
 * Liveness proof for the platform watchdog.
 *
 * Without this, a healthy system and a dead watchdog are indistinguishable: both
 * leave zero firing alerts in the ledger. The admin health pill needs to tell
 * "nothing is wrong" apart from "nobody checked", so the watchdog stamps every
 * real tick here and the reader decides whether that stamp is recent enough.
 *
 * ⛔ Do NOT add this job_name to JOB_CATALOG. A watchdog that alerts on its own
 * staleness is false comfort — a dead watchdog cannot fire an alert about itself.
 * Staleness is detected by the reader (server/domains/platform/adminAlertsView.ts),
 * never by the watchdog. Job-freshness evaluators iterate JOB_CATALOG rather than
 * this table, so an unregistered control row stays inert.
 */
export const WATCHDOG_HEARTBEAT_JOB_NAME = "platform-watchdog";

export interface WatchdogHeartbeatSummary {
  health: string;
  firingCount: number;
  maxSeverity: string | null;
  promotionReady: boolean;
}

/**
 * Returns false instead of throwing: a failed heartbeat write must not turn an
 * otherwise-successful watchdog run red. The cost of failing quietly is bounded —
 * the pill degrades to "unknown", which is the safe direction.
 */
export async function recordWatchdogHeartbeat(
  client: SupabaseAlertLedgerClient,
  summary: WatchdogHeartbeatSummary,
  now: Date,
): Promise<boolean> {
  const stampedAt = now.toISOString();
  try {
    const { error } = await client.from("platform_job_controls").upsert(
      {
        job_name: WATCHDOG_HEARTBEAT_JOB_NAME,
        last_started_at: stampedAt,
        last_finished_at: stampedAt,
        last_success_at: stampedAt,
        last_status: "success",
        updated_at: stampedAt,
        metadata: {
          health: summary.health,
          firingCount: summary.firingCount,
          maxSeverity: summary.maxSeverity,
          promotionReady: summary.promotionReady,
        },
      },
      { onConflict: "job_name" },
    );
    return !error;
  } catch {
    return false;
  }
}
