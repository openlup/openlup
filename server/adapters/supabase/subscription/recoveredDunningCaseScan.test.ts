import { describe, expect, it } from "vitest";
import { createRecoveredDunningCaseScanPort } from "./recoveredDunningCaseScan.js";

const signal = new AbortController().signal;
const NOW = Date.parse("2026-08-08T09:00:00.000Z");
// Neutral ISO test code; see the worker test for why.
const CURRENCY = "XTS";

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
        gte(column: string, value: unknown) { call.ops.push(["gte", column, value]); return builder; },
        in(column: string, values: readonly unknown[]) { call.ops.push(["in", column, values]); return builder; },
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

describe("createRecoveredDunningCaseScanPort", () => {
  it("selects ONLY status='recovered' by equality, so expired/cancelled/open can never mail", async () => {
    const c = client({
      subscription_dunning_cases: {
        data: [{ id: "case-1", subscription_id: "sub-1", client_id: "client-1", recovered_at: "2026-08-07T09:00:00.000Z" }],
      },
      subscription_dunning_notifications: { data: [] },
    });

    await createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal);

    const ops = opsOf(c.calls, "subscription_dunning_cases");
    expect(ops).toContainEqual(["eq", "status", "recovered"]);
    // No negative filter anywhere: a future fifth status cannot start mailing by
    // simply not being on an exclusion list.
    expect(ops.filter(([op]) => op === "eq")).toHaveLength(1);
    expect(ops.some(([, column]) => column === "next_retry_at")).toBe(false);
  });

  it("bounds the window on recovered_at, so an old recovery never suddenly mails", async () => {
    const c = client({
      subscription_dunning_cases: { data: [] },
    });

    await createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal);

    const ops = opsOf(c.calls, "subscription_dunning_cases");
    expect(ops).toContainEqual(["gte", "recovered_at", "2026-08-01T09:00:00.000Z"]);
    expect(ops).toContainEqual(["limit", 50]);
    expect(ops).toContainEqual(["order", "recovered_at", { ascending: true }]);
  });

  it("joins the case's own customer notification payload for the amount", async () => {
    const c = client({
      subscription_dunning_cases: {
        data: [
          { id: "case-1", subscription_id: "sub-1", client_id: "client-1", recovered_at: "2026-08-07T09:00:00.000Z" },
          { id: "case-2", subscription_id: "sub-2", client_id: "client-2", recovered_at: "2026-08-07T10:00:00.000Z" },
        ],
      },
      subscription_dunning_notifications: {
        data: [
          { case_id: "case-1", payload: { amountMinor: 12999, currency: CURRENCY } },
          { case_id: "case-1", payload: { amountMinor: 999, currency: CURRENCY } },
        ],
      },
    });

    const rows = await createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal);

    expect(opsOf(c.calls, "subscription_dunning_notifications")).toContainEqual([
      "in", "case_id", ["case-1", "case-2"],
    ]);
    expect(opsOf(c.calls, "subscription_dunning_notifications")).toContainEqual([
      "eq", "recipient_kind", "customer",
    ]);
    // First notification wins — the amount the customer was originally told.
    expect(rows[0]).toMatchObject({ caseId: "case-1", amountMinor: 12999, currency: CURRENCY });
    // A case with no notification row still scans, just without an amount.
    expect(rows[1]).toMatchObject({ caseId: "case-2", amountMinor: null, currency: null });
  });

  it("degrades the amount to null when the amount read fails, and still returns the cases", async () => {
    const c = client({
      subscription_dunning_cases: {
        data: [{ id: "case-1", subscription_id: "sub-1", client_id: "client-1", recovered_at: "2026-08-07T09:00:00.000Z" }],
      },
      subscription_dunning_notifications: { data: null, error: { message: "permission denied" } },
    });

    const rows = await createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ caseId: "case-1", amountMinor: null, currency: null });
  });

  it("throws a named error when the case read fails, so the cron reports it", async () => {
    const c = client({
      subscription_dunning_cases: { data: null, error: { message: "relation missing" } },
    });

    await expect(
      createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal),
    ).rejects.toThrow("recovered_dunning_scan_failed: relation missing");
  });

  it("drops structurally unusable rows instead of mailing a half-read case", async () => {
    const c = client({
      subscription_dunning_cases: {
        data: [
          { id: "case-1", subscription_id: null, client_id: "client-1", recovered_at: "2026-08-07T09:00:00.000Z" },
          { id: "case-2", subscription_id: "sub-2", client_id: null, recovered_at: "2026-08-07T09:00:00.000Z" },
          { id: null, subscription_id: "sub-3", client_id: "client-3", recovered_at: "2026-08-07T09:00:00.000Z" },
          { id: "case-4", subscription_id: "sub-4", client_id: "client-4", recovered_at: null },
        ],
      },
      subscription_dunning_notifications: { data: [] },
    });

    const rows = await createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal);

    // Only the subscription-less row survives: the email needs a client and a
    // recovery instant, but never the subscription id.
    expect(rows.map((row) => row.caseId)).toEqual(["case-1"]);
    expect(rows[0].subscriptionId).toBeNull();
  });

  it("skips the amount read entirely when nothing recovered", async () => {
    const c = client({ subscription_dunning_cases: { data: [] } });

    const rows = await createRecoveredDunningCaseScanPort(c, () => NOW).scanRecovered(7, 50, signal);

    expect(rows).toEqual([]);
    expect(c.calls.map((call) => call.table)).toEqual(["subscription_dunning_cases"]);
  });
});
