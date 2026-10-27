import { expect, it, vi } from "vitest";
import { runControlPlaneWatchdogTick } from "../../src/operations/server/controlPlaneWatchdog.js";
import type { PlatformControlPlanePort } from "../../src/operations/contracts/index.js";

it("evaluates persisted jobs, honors checkOnly and records the existing replay key", async () => {
  const mutateControlPlane = vi.fn<PlatformControlPlanePort["mutateControlPlane"]>().mockResolvedValue({ action: "record-heartbeat", replayed: true, revision: null, recordedAt: "2026-10-26T12:00:00Z" });
  const port: PlatformControlPlanePort = {
    readControlPlane: async () => ({ controls: [], alerts: [], jobs: [
      { jobName: "example-refresh", enabled: true, activeDriver: "worker", lastStatus: "failed", lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null },
      { jobName: "disabled-refresh", enabled: false, activeDriver: "worker", lastStatus: "failed", lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null },
    ] }), mutateControlPlane,
  };
  const now = new Date("2026-10-26T12:00:00Z");
  expect((await runControlPlaneWatchdogTick(port, now, true)).body).toMatchObject({ health: "degraded", firingCount: 1, heartbeatRecorded: false, failedJobs: ["example-refresh"] });
  expect(mutateControlPlane).not.toHaveBeenCalled();
  expect((await runControlPlaneWatchdogTick(port, now, false)).body).toMatchObject({ heartbeatRecorded: true, replayed: true });
  expect(mutateControlPlane).toHaveBeenCalledWith({ action: "record-heartbeat", idempotencyKey: "platform-watchdog:2026-10-26T12:00:00.000Z", health: "degraded", firingCount: 1, maxSeverity: "p2", promotionReady: false });
});
