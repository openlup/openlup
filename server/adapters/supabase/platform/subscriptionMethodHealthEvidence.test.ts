import { describe, expect, it, vi } from "vitest";
import {
  METHOD_HEALTH_COLUMNS,
  selectMethodHealthRows,
  summarizeMethodHealth,
  type MethodHealthEvidenceRow,
} from "./subscriptionMethodHealthEvidence.js";

describe("selectMethodHealthRows", () => {
  it("reads only the two actionable states, only the columns it folds, and caps the read", async () => {
    const calls: Array<[string, unknown[]]> = [];
    await selectMethodHealthRows(fakeClient(calls, {}));
    expect(calls).toContainEqual(["from", ["subscription_method_health"]]);
    expect(calls).toContainEqual(["select", [METHOD_HEALTH_COLUMNS]]);
    expect(calls).toContainEqual(
      ["in", ["health_state", ["mandate_not_chargeable_unattended", "activation_gap"]]],
    );
    expect(calls.filter(([method]) => method === "limit")).toEqual([["limit", [2000]], ["limit", [2000]]]);
  });

  // The view has no timestamp, so the age comes from a second bounded read. It
  // must stay narrow: only `pending_activation`, only the two columns needed.
  it("reads the pending-activation ages the view cannot express", async () => {
    const calls: Array<[string, unknown[]]> = [];
    await selectMethodHealthRows(fakeClient(calls, {}));
    expect(calls).toContainEqual(["from", ["subscriptions"]]);
    expect(calls).toContainEqual(["select", ["id,created_at"]]);
    expect(calls).toContainEqual(["eq", ["status", "pending_activation"]]);
  });

  // ⛔ Without this filter the p1 would page on scaffolding. A legacy
  // offer-policy fixture parked in `pending_activation` ages past 72h forever
  // and would hold the alert open on a subscription no human is waiting for —
  // the fastest way to teach an operator to ignore it.
  it("excludes legacy test fixtures from the age clock", async () => {
    const calls: Array<[string, unknown[]]> = [];
    await selectMethodHealthRows(fakeClient(calls, {}));
    expect(calls).toContainEqual(["eq", ["is_test_fixture", false]]);
  });

  // The join is in memory, on subscription_id, and must not invent a
  // `pending_since` for a row the age read did not return.
  it("stamps pending_since only on the rows the age read covered", async () => {
    const rows = await selectMethodHealthRows(fakeClient([], {
      subscription_method_health: [
        { subscription_id: "s1", health_state: "activation_gap", narrow_activation_gap: false },
        { subscription_id: "s2", health_state: "mandate_not_chargeable_unattended" },
      ],
      subscriptions: [{ id: "s1", created_at: "2026-07-19T00:00:00.000Z" }],
    }));
    expect(rows[0].pending_since).toBe("2026-07-19T00:00:00.000Z");
    expect(rows[1].pending_since).toBeUndefined();
  });

  it("surfaces a read failure instead of reporting zero unhealthy methods", async () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      limit: () => builder,
      then: (resolve: (value: { data: null; error: { message: string } }) => void) =>
        resolve({ data: null, error: { message: "permission denied" } }),
    } as Record<string, unknown>;
    const client = { from: () => builder } as never;
    await expect(selectMethodHealthRows(client)).rejects.toThrow("permission denied");
  });
});

const NOW = new Date("2026-08-27T00:00:00.000Z");
const HOURS_AGO = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

describe("summarizeMethodHealth", () => {
  it("counts unchargeable mandates and reports zero for a healthy fleet", () => {
    expect(summarizeMethodHealth([], NOW)).toEqual(counts({ unchargeable: 0, gap: 0 }));
    expect(summarizeMethodHealth([
      row("s1", "mandate_not_chargeable_unattended"),
      row("s2", "mandate_not_chargeable_unattended"),
    ], NOW)).toEqual(counts({ unchargeable: 2, gap: 0 }));
  });

  it("subtracts the activation gaps the narrow detector already pages on", () => {
    // The whole point of the complement: s3 is already owned by the p1 that
    // reads subscription_paid_activation_gaps, so counting it here would raise a
    // second pager for one root cause.
    expect(summarizeMethodHealth([
      row("s3", "activation_gap", true),
      row("s4", "activation_gap", false),
    ], NOW)).toEqual(counts({ unchargeable: 0, gap: 1 }));
  });

  it("treats a missing or null narrow flag as outside the narrow detector", () => {
    // Failing the other way would let an unreadable flag silence the signal.
    expect(summarizeMethodHealth([
      row("s5", "activation_gap", null),
      { subscription_id: "s6", health_state: "activation_gap" },
    ], NOW)).toEqual(counts({ unchargeable: 0, gap: 2 }));
  });

  it("ignores a state it does not own even if the view widens", () => {
    expect(summarizeMethodHealth([
      row("s7", "method_missing"),
      row("s8", "method_expiring"),
      row("s9", "healthy"),
      row("s10", "mandate_not_chargeable_unattended"),
    ], NOW)).toEqual(counts({ unchargeable: 1, gap: 0 }));
  });

  // The age clock, and the escalation shape it has to keep: the overdue count is
  // a SUBSET of the presence count, never a partition of it. If the two ever
  // stopped overlapping, the live p2 would silently narrow.
  it("escalates a gap older than 72 hours without removing it from the presence count", () => {
    expect(summarizeMethodHealth([
      { ...row("s11", "activation_gap", false), pending_since: HOURS_AGO(80) },
      { ...row("s12", "activation_gap", false), pending_since: HOURS_AGO(2) },
    ], NOW)).toEqual(counts({ unchargeable: 0, gap: 2, overdue: 1 }));
  });

  it("does not escalate a gap that is exactly inside the window", () => {
    expect(summarizeMethodHealth([
      { ...row("s13", "activation_gap", false), pending_since: HOURS_AGO(71) },
    ], NOW)).toEqual(counts({ unchargeable: 0, gap: 1, overdue: 0 }));
  });

  // ⛔ The p1 must never be inventable by a failed or truncated age read. The p2
  // already covers the row, so silence on the escalation is the safe direction.
  it("never escalates on an absent or unparseable age", () => {
    expect(summarizeMethodHealth([
      row("s14", "activation_gap", false),
      { ...row("s15", "activation_gap", false), pending_since: null },
      { ...row("s16", "activation_gap", false), pending_since: "not-a-date" },
    ], NOW)).toEqual(counts({ unchargeable: 0, gap: 3, overdue: 0 }));
  });

  // The narrow detector owns this row entirely; ageing it must not resurrect it.
  it("does not escalate a gap the narrow detector already owns", () => {
    expect(summarizeMethodHealth([
      { ...row("s17", "activation_gap", true), pending_since: HOURS_AGO(900) },
    ], NOW)).toEqual(counts({ unchargeable: 0, gap: 0, overdue: 0 }));
  });
});

function counts({ unchargeable, gap, overdue = 0 }: { unchargeable: number; gap: number; overdue?: number }) {
  return {
    methodHealthUnchargeableCount: unchargeable,
    methodHealthActivationGapCount: gap,
    methodHealthActivationGapOverdueCount: overdue,
  };
}

function row(
  subscriptionId: string,
  healthState: string,
  narrow: boolean | null = null,
): MethodHealthEvidenceRow {
  return { subscription_id: subscriptionId, health_state: healthState, narrow_activation_gap: narrow };
}

function fakeClient(
  calls: Array<[string, unknown[]]>,
  rowsByTable: Record<string, unknown[]>,
) {
  const builderFor = (table: string) => {
    const builder: Record<string, unknown> = {
      then(resolve: (value: { data: unknown[]; error: null }) => void) {
        resolve({ data: rowsByTable[table] ?? [], error: null });
      },
    };
    for (const method of ["select", "eq", "gte", "in", "limit", "lte", "not", "order", "range"]) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      });
    }
    return builder;
  };
  return {
    from: (table: string) => {
      calls.push(["from", [table]]);
      return builderFor(table);
    },
  } as never;
}
