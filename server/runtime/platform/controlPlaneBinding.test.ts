import { describe, expect, it, vi } from "vitest";
import { resolvePlatformControlPlaneBinding, runDirectPlatformWatchdogTick } from "./controlPlaneBinding.js";

const OPERATOR = "9f576216-011a-4f67-8404-3f28f7f624d5";

describe("platform control-plane binding", () => {
  it("fails closed when the selected bundle lacks configuration", () => {
    expect(resolvePlatformControlPlaneBinding({ PLATFORM_BUNDLE: "node-postgres" }, { operatorId: OPERATOR }))
      .toEqual({ error: "database_url_required" });
    expect(resolvePlatformControlPlaneBinding({}, { operatorId: OPERATOR }))
      .toEqual({ error: "supabase_env_required" });
  });

  it("maps managed semantic routines without a generic domain gateway", async () => {
    const rpc = vi.fn(async (name: string) => name === "platform_control_set_control"
      ? { data: [{ action: "set-control", replayed: false, revision: 1, recorded_at: "2026-08-13T20:00:00.000Z" }], error: null }
      : { data: [], error: null });
    const resolved = resolvePlatformControlPlaneBinding({
      SUPABASE_URL: "https://managed.example", SUPABASE_SERVICE_ROLE_KEY: "service",
    }, { operatorId: OPERATOR, managedClientFactory: () => ({ rpc }) });
    await expect(resolved.binding?.run((port) => port.mutateControlPlane({
      action: "set-control", idempotencyKey: "control-1", controlKey: "jobs.enabled", enabled: true,
    }))).resolves.toMatchObject({ revision: 1, replayed: false });
    expect(rpc).toHaveBeenCalledWith("platform_control_set_control", {
      p_operator_id: OPERATOR, p_idempotency_key: "control-1",
      p_command_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_control_key: "jobs.enabled", p_enabled: true,
    });
  });

  it("evaluates persisted direct job failures and records one durable heartbeat", async () => {
    const mutateControlPlane = vi.fn(async () => ({
      action: "record-heartbeat" as const, replayed: false, revision: null,
      recordedAt: "2026-08-13T20:00:00.000Z",
    }));
    const resolver = vi.fn(() => ({ binding: {
      identity: "node-postgres",
      run: <T>(work: (port: never) => Promise<T>) => work({
        readControlPlane: async () => ({ controls: [], alerts: [], jobs: [{
          jobName: "order-pull", enabled: true, activeDriver: "worker",
          lastStatus: "failed", lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null,
        }] }), mutateControlPlane,
      } as never),
    } }));
    const now = new Date("2026-08-13T20:00:00.000Z");
    await expect(runDirectPlatformWatchdogTick({ PLATFORM_OPERATOR_ID: OPERATOR }, now, false, resolver as never))
      .resolves.toMatchObject({ status: 200, body: { health: "degraded", firingCount: 1 } });
    expect(mutateControlPlane).toHaveBeenCalledWith({
      action: "record-heartbeat", idempotencyKey: `platform-watchdog:${now.toISOString()}`,
      health: "degraded", firingCount: 1, maxSeverity: "p2", promotionReady: false,
    });
  });
});
