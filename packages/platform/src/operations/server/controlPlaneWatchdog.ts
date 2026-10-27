import type { PlatformControlPlanePort } from "../contracts/index.js";

export type DirectPlatformWatchdogResult = { status: number; body: Record<string, unknown> };

/** Existing public-bundle evaluation of persisted neutral job facts. No provider calls. */
export async function runControlPlaneWatchdogTick(
  port: PlatformControlPlanePort,
  now: Date,
  checkOnly: boolean,
): Promise<DirectPlatformWatchdogResult> {
  const snapshot = await port.readControlPlane({});
  const failedJobs = snapshot.jobs.filter((job) => job.enabled && job.lastStatus === "failed");
  const health = failedJobs.length > 0 ? "degraded" as const : "healthy" as const;
  const recorded = checkOnly ? null : await port.mutateControlPlane({
    action: "record-heartbeat",
    idempotencyKey: `platform-watchdog:${now.toISOString()}`,
    health,
    firingCount: failedJobs.length,
    maxSeverity: failedJobs.length > 0 ? "p2" : null,
    promotionReady: failedJobs.length === 0,
  });
  return { status: 200, body: {
    ok: true, health, firingCount: failedJobs.length,
    failedJobs: failedJobs.map((job) => job.jobName),
    checkedAt: now.toISOString(), heartbeatRecorded: recorded != null,
    replayed: recorded?.replayed ?? false,
  } };
}
