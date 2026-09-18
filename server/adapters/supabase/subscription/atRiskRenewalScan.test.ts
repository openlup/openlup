import { describe, expect, it } from "vitest";
import { AT_RISK_HEALTH_STATES, createAtRiskRenewalScanPort } from "./atRiskRenewalScan.js";

const signal = new AbortController().signal;
const NOW = Date.parse("2026-08-08T09:00:00.000Z");

type Call = { table: string; ops: Array<[string, unknown, unknown?]> };

function client(responses: Record<string, { data: unknown; error?: { message?: string } | null }>) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder = {
        select(columns: string) { call.ops.push(["select", columns]); return builder; },
        eq(column: string, value: unknown) { call.ops.push(["eq", column, value]); return builder; },
        in(column: string, values: readonly unknown[]) { call.ops.push(["in", column, values]); return builder; },
        gte(column: string, value: unknown) { call.ops.push(["gte", column, value]); return builder; },
        lte(column: string, value: unknown) { call.ops.push(["lte", column, value]); return builder; },
        order(column: string, options: { ascending: boolean }) { call.ops.push(["order", column, options]); return builder; },
        limit(count: number) {
          call.ops.push(["limit", count]);
          const response = responses[table] ?? { data: [] };
          return Promise.resolve({ data: response.data, error: response.error ?? null });
        },
      };
      return builder;
    },
  };
}

function opsOf(calls: Call[], table: string): Array<[string, unknown, unknown?]> {
  return calls.find((call) => call.table === table)?.ops ?? [];
}

function healthRow(over: Record<string, unknown> = {}) {
  return {
    subscription_id: "sub-1",
    client_id: "client-1",
    next_cycle_at: "2026-08-12T06:00:00.000Z",
    health_state: "mandate_not_chargeable_unattended",
    narrow_activation_gap: false,
    ...over,
  };
}

describe("createAtRiskRenewalScanPort", () => {
  it("selects only the two unchargeable states, and never the expiring or healthy ones", async () => {
    const c = client({
      subscription_method_health: { data: [healthRow()] },
      subscription_dunning_cases: { data: [] },
    });

    await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    const ops = opsOf(c.calls, "subscription_method_health");
    expect(ops).toContainEqual(["in", "health_state", AT_RISK_HEALTH_STATES]);
    expect(AT_RISK_HEALTH_STATES).toEqual([
      "mandate_not_chargeable_unattended",
      "method_missing",
    ]);
    // Inclusion, not exclusion: a future health state cannot start mailing by
    // simply not being on a NOT-IN list. `method_expiring` in particular stays
    // silent until expiry capture is deterministic.
    expect(AT_RISK_HEALTH_STATES).not.toContain("method_expiring");
    expect(AT_RISK_HEALTH_STATES).not.toContain("healthy");
    expect(AT_RISK_HEALTH_STATES).not.toContain("activation_gap");
  });

  it("bounds the window on next_cycle_at, T-5 to T-2 against a fixed clock", async () => {
    const c = client({ subscription_method_health: { data: [] } });

    await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    const ops = opsOf(c.calls, "subscription_method_health");
    expect(ops).toContainEqual(["gte", "next_cycle_at", "2026-08-10T09:00:00.000Z"]);
    expect(ops).toContainEqual(["lte", "next_cycle_at", "2026-08-13T09:00:00.000Z"]);
    expect(ops).toContainEqual(["order", "next_cycle_at", { ascending: true }]);
    expect(ops).toContainEqual(["limit", 100]);
  });

  it("takes active subscriptions only, and never a row the narrow activation-gap p1 owns", async () => {
    const c = client({
      subscription_method_health: { data: [] },
    });

    await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    const ops = opsOf(c.calls, "subscription_method_health");
    expect(ops).toContainEqual(["eq", "subscription_status", "active"]);
    expect(ops).toContainEqual(["eq", "narrow_activation_gap", false]);
  });

  it("suppresses a subscription that is already in an open dunning case", async () => {
    const c = client({
      subscription_method_health: {
        data: [
          healthRow({ subscription_id: "sub-quiet" }),
          healthRow({ subscription_id: "sub-in-dunning" }),
        ],
      },
      subscription_dunning_cases: { data: [{ subscription_id: "sub-in-dunning" }] },
    });

    const rows = await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    const caseOps = opsOf(c.calls, "subscription_dunning_cases");
    expect(caseOps).toContainEqual(["eq", "status", "open"]);
    expect(caseOps).toContainEqual(["in", "subscription_id", ["sub-quiet", "sub-in-dunning"]]);
    expect(rows.map((row) => row.subscriptionId)).toEqual(["sub-quiet"]);
  });

  it("carries the health state raw, so the producer owns the cause mapping", async () => {
    const c = client({
      subscription_method_health: { data: [healthRow({ health_state: "method_missing" })] },
      subscription_dunning_cases: { data: [] },
    });

    const rows = await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    expect(rows).toEqual([{
      subscriptionId: "sub-1",
      clientId: "client-1",
      nextCycleAt: "2026-08-12T06:00:00.000Z",
      healthState: "method_missing",
    }]);
  });

  it("throws a named error when the health read fails, so the cron reports it", async () => {
    const c = client({
      subscription_method_health: { data: null, error: { message: "relation missing" } },
    });

    await expect(
      createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal),
    ).rejects.toThrow("at_risk_renewal_scan_failed: relation missing");
  });

  it("fails CLOSED when the open-case read fails, rather than mailing mid-dunning", async () => {
    const c = client({
      subscription_method_health: { data: [healthRow()] },
      subscription_dunning_cases: { data: null, error: { message: "permission denied" } },
    });

    await expect(
      createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal),
    ).rejects.toThrow("at_risk_open_case_read_failed: permission denied");
  });

  it("drops structurally unusable rows instead of mailing a half-read subscription", async () => {
    const c = client({
      subscription_method_health: {
        data: [
          healthRow({ subscription_id: null }),
          healthRow({ subscription_id: "sub-2", client_id: null }),
          healthRow({ subscription_id: "sub-3", next_cycle_at: null }),
          healthRow({ subscription_id: "sub-4", health_state: null }),
          healthRow({ subscription_id: "sub-5" }),
        ],
      },
      subscription_dunning_cases: { data: [] },
    });

    const rows = await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    expect(rows.map((row) => row.subscriptionId)).toEqual(["sub-5"]);
  });

  it("skips the open-case read entirely when nothing is at risk", async () => {
    const c = client({ subscription_method_health: { data: [] } });

    const rows = await createAtRiskRenewalScanPort(c, () => NOW).scanAtRisk(2, 5, 100, signal);

    expect(rows).toEqual([]);
    expect(c.calls.map((call) => call.table)).toEqual(["subscription_method_health"]);
  });
});
