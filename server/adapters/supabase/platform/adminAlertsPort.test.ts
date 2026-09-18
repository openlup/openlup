import { describe, expect, it, vi } from "vitest";
import { createGatewayAdminAlertsReadPort } from "./adminAlertsPort.js";
import { WATCHDOG_HEARTBEAT_JOB_NAME } from "./watchdogHeartbeat.js";

/** Records the chained query so we can assert the shape the ledger read relies on. */
function stubGateway(result: { data: unknown; error: { message?: string } | null }) {
  const calls: Array<[string, unknown]> = [];
  const query: Record<string, unknown> = {};
  for (const method of ["select", "in", "eq", "order", "limit"]) {
    query[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, args]);
      return query;
    });
  }
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);

  const from = vi.fn((table: string) => {
    calls.push(["from", table]);
    return query;
  });

  return {
    calls,
    gateway: {
      asService: <T>(work: (client: unknown) => Promise<T>) => work({ from }),
    },
  };
}

function argsOf(calls: Array<[string, unknown]>, method: string): unknown[][] {
  return calls.filter(([name]) => name === method).map(([, args]) => args as unknown[]);
}

describe("createGatewayAdminAlertsReadPort", () => {
  it("reads only live alerts, worst-first, with headroom over the displayed list", async () => {
    const { gateway, calls } = stubGateway({ data: [], error: null });

    await createGatewayAdminAlertsReadPort(gateway).listLiveAlerts();

    expect(calls.find(([name]) => name === "from")?.[1]).toBe("platform_alerts");
    expect(argsOf(calls, "in")[0]).toEqual(["status", ["open", "acknowledged"]]);
    // p0 < p1 < p2 < p3 sorts correctly as text, so ascending severity is worst-first.
    expect(argsOf(calls, "order")[0]).toEqual(["severity", { ascending: true }]);
    // 200 > the 50 rows we return, so summary counts stay accurate when truncated.
    expect(argsOf(calls, "limit")[0]).toEqual([200]);
  });

  it("returns an empty list rather than null when the ledger is empty", async () => {
    const { gateway } = stubGateway({ data: null, error: null });

    await expect(createGatewayAdminAlertsReadPort(gateway).listLiveAlerts()).resolves.toEqual([]);
  });

  it("surfaces a ledger read error instead of reporting an empty ledger", async () => {
    const { gateway } = stubGateway({ data: null, error: { message: "permission denied" } });

    await expect(createGatewayAdminAlertsReadPort(gateway).listLiveAlerts()).rejects.toThrow(
      "permission denied",
    );
  });

  it("reads the watchdog heartbeat row by job name", async () => {
    const { gateway, calls } = stubGateway({
      data: { last_success_at: "2026-07-19T11:55:00+00:00" },
      error: null,
    });

    const heartbeat = await createGatewayAdminAlertsReadPort(gateway).readWatchdogHeartbeat();

    expect(calls.find(([name]) => name === "from")?.[1]).toBe("platform_job_controls");
    expect(argsOf(calls, "eq")[0]).toEqual(["job_name", WATCHDOG_HEARTBEAT_JOB_NAME]);
    expect(heartbeat?.last_success_at).toBe("2026-07-19T11:55:00+00:00");
  });

  it("maps a missing control row to null so the pill reads unknown", async () => {
    const { gateway } = stubGateway({ data: null, error: null });

    await expect(
      createGatewayAdminAlertsReadPort(gateway).readWatchdogHeartbeat(),
    ).resolves.toBeNull();
  });
});
