import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createPostgresPlatformControlPlanePort } from "./platformControlPlane.js";

const OPERATOR = "9f576216-011a-4f67-8404-3f28f7f624d5";
const AT = "2026-08-13T20:00:00.000Z";

function stubPool(options: { failOn?: string } = {}) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let releases = 0;
  const end = vi.fn(async () => {});
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          queries.push({ text, values });
          if (options.failOn && text.includes(options.failOn)) {
            throw new Error("private database failure");
          }
          if (text.includes("platform_control_set_control")) {
            return { rows: [{ action: "set-control", replayed: false, revision: 2, recorded_at: AT }] };
          }
          if (text.includes("platform_control_operator_is_active")) {
            return { rows: [{ platform_control_operator_is_active: true }] };
          }
          if (text.includes("platform_control_list_controls")) {
            return { rows: [{ control_key: "jobs.enabled", enabled: true, revision: 2, updated_at: AT }] };
          }
          if (text.includes("platform_control_list_jobs")) return { rows: [] };
          if (text.includes("platform_control_list_alerts")) return { rows: [] };
          return { rows: [] };
        },
        release() {
          releases += 1;
        },
      };
    },
    end,
  } as unknown as Pool;
  return { pool, queries, end, releases: () => releases };
}

describe("createPostgresPlatformControlPlanePort", () => {
  it("fails before opening a pool when direct configuration is incomplete", () => {
    const poolFactory = vi.fn();
    expect(() => createPostgresPlatformControlPlanePort(
      { connectionString: "" }, { operatorId: OPERATOR, poolFactory },
    )).toThrow("platform_control_database_url_required");
    expect(() => createPostgresPlatformControlPlanePort(
      { connectionString: "postgres://local" }, { operatorId: "  ", poolFactory },
    )).toThrow("platform_control_operator_id_required");
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("executes semantic actions through role-free transactions and closes the lazy pool", async () => {
    const stub = stubPool();
    const port = createPostgresPlatformControlPlanePort(
      { connectionString: "postgres://local" },
      { operatorId: ` ${OPERATOR} `, poolFactory: () => stub.pool },
    );

    await expect(port.mutateControlPlane({
      action: "set-control",
      idempotencyKey: "control-1",
      controlKey: "jobs.enabled",
      enabled: true,
    })).resolves.toEqual({ action: "set-control", replayed: false, revision: 2, recordedAt: AT });
    await expect(port.isOperatorActive(OPERATOR)).resolves.toBe(true);
    await expect(port.readControlPlane({})).resolves.toEqual({
      controls: [{ controlKey: "jobs.enabled", enabled: true, revision: 2, updatedAt: AT }],
      jobs: [],
      alerts: [],
    });
    await port.close();

    expect(stub.queries.filter(({ text }) => text === "BEGIN")).toHaveLength(3);
    expect(stub.queries.filter(({ text }) => text === "COMMIT")).toHaveLength(3);
    expect(stub.queries.some(({ text }) => text.includes("SET LOCAL ROLE"))).toBe(false);
    expect(stub.queries.find(({ text }) => text.includes("set_control"))?.values?.[0]).toBe(OPERATOR);
    expect(stub.releases()).toBe(3);
    expect(stub.end).toHaveBeenCalledOnce();
  });

  it("rolls back, releases and preserves the neutral unavailable error", async () => {
    const stub = stubPool({ failOn: "platform_control_list_controls" });
    const port = createPostgresPlatformControlPlanePort(
      { connectionString: "postgres://local" },
      { operatorId: OPERATOR, poolFactory: () => stub.pool },
    );

    await expect(port.readControlPlane({})).rejects.toMatchObject({
      name: "PlatformControlPlaneUnavailableError",
      message: "platform_control_plane_unavailable",
    });
    expect(stub.queries.some(({ text }) => text === "ROLLBACK")).toBe(true);
    expect(stub.queries.some(({ text }) => text === "COMMIT")).toBe(false);
    expect(stub.releases()).toBe(1);
    await port.close();
  });
});
