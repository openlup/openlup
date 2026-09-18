import { describe, expect, it, vi } from "vitest";
import { createPlatformControlPlanePort, isPlatformControlOperatorActive } from "./platformControlPlane.js";

const OPERATOR = "9f576216-011a-4f67-8404-3f28f7f624d5";
const AT = "2026-08-13T20:00:00.000Z";

describe("platform control-plane semantic adapter", () => {
  it("writes an idempotent control and maps replay/conflict", async () => {
    const query = vi.fn(async () => ({ rows: [{
      action: "set-control", replayed: false, revision: 2, recorded_at: AT,
    }] }));
    const port = createPlatformControlPlanePort({ query }, OPERATOR);
    await expect(port.mutateControlPlane({
      action: "set-control", idempotencyKey: "control-1", controlKey: "jobs.enabled", enabled: true,
    })).resolves.toEqual({ action: "set-control", replayed: false, revision: 2, recordedAt: AT });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("platform_control_set_control"), [
      OPERATOR, "control-1", expect.stringMatching(/^[a-f0-9]{64}$/), "jobs.enabled", true,
    ]);

    query.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "23505" }));
    await expect(port.mutateControlPlane({
      action: "set-control", idempotencyKey: "control-1", controlKey: "jobs.other", enabled: true,
    })).rejects.toMatchObject({ name: "PlatformControlPlaneConflictError" });
  });

  it("records heartbeat and maps neutral controls, jobs and alerts", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("record_heartbeat")) return { rows: [{ action: "record-heartbeat", replayed: true, revision: null, recorded_at: AT }] };
      if (sql.includes("list_controls")) return { rows: [{ control_key: "jobs.enabled", enabled: true, revision: 2, updated_at: AT }] };
      if (sql.includes("list_jobs")) return { rows: [{ job_name: "platform-watchdog", enabled: true, active_driver: "operator", last_status: "success", last_started_at: AT, last_finished_at: AT, last_success_at: AT }] };
      if (sql.includes("list_alerts")) return { rows: [{ dedupe_key: "job.failed", severity: "p1", status: "open", owner: "platform", title: "Job failed", first_seen_at: AT, last_seen_at: AT, resolved_at: null }] };
      return { rows: [] };
    });
    const port = createPlatformControlPlanePort({ query }, OPERATOR);
    await expect(port.mutateControlPlane({
      action: "record-heartbeat", idempotencyKey: "heartbeat-1", health: "healthy",
      firingCount: 0, maxSeverity: null, promotionReady: true,
    })).resolves.toEqual({ action: "record-heartbeat", replayed: true, revision: null, recordedAt: AT });
    await expect(port.readControlPlane({})).resolves.toMatchObject({
      controls: [{ controlKey: "jobs.enabled", revision: 2 }],
      jobs: [{ jobName: "platform-watchdog", lastStatus: "success" }],
      alerts: [{ dedupeKey: "job.failed", severity: "p1" }],
    });
  });

  it("checks the durable operator allowlist", async () => {
    const query = vi.fn(async () => ({ rows: [{ platform_control_operator_is_active: true }] }));
    await expect(isPlatformControlOperatorActive({ query }, OPERATOR)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("operator_is_active"), [OPERATOR]);
  });
});
