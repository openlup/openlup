import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_RECORD_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_TRANSITIONS,
} from "@openlup/core/subscription";

import { effectiveFunctionBody } from "../../test/effectiveMigration";

// Parity between the two spellings of one lifecycle: the core engine's status
// matrix and the LIVE body of the managed SQL guard
// public.subscription_guard_status_transition. The guard is read, not restated,
// so a new or dropped edge on either side fails here until the other side (and
// supabase/tests/subscription_status_transition_matrix_test.sql) moves with it.
//
// The portable PostgreSQL chain has no such guard and only three statuses; that
// gap is recorded in docs/platform/CANONICAL_CONTRACTS.md, not asserted here.

type Edge = { from: string; to: string; conditional: boolean };

const CLAUSE = /IF\s+OLD\.status\s*=\s*'(\w+)'\s+AND\s+NEW\.status\s*(?:IN\s*\(([^)]*)\)|=\s*'(\w+)')([\s\S]*?)\bTHEN\b/g;

function guardEdges(body: string): Edge[] {
  const edges: Edge[] = [];
  for (const match of body.matchAll(CLAUSE)) {
    const [, from, list, single, rest] = match;
    const targets = single ? [single] : [...(list ?? "").matchAll(/'(\w+)'/g)].map((target) => target[1]);
    for (const to of targets) edges.push({ from, to, conditional: /\bEXISTS\b/.test(rest) });
  }
  return edges;
}

const guardBody = effectiveFunctionBody("subscription_guard_status_transition");
const edges = guardEdges(guardBody);
const key = (from: string, to: string) => `${from}->${to}`;

describe("core subscription status matrix and the managed SQL guard", () => {
  it("parses every admitting branch of the guard, so no edge escapes the parser", () => {
    // Each admitted edge group returns NEW from its own IF; one more RETURN NEW
    // is the unchanged-status early exit. A branch written in a shape the
    // parser does not read would add a RETURN NEW without adding a clause.
    const clauses = [...guardBody.matchAll(CLAUSE)].length;
    expect(clauses).toBeGreaterThan(0);
    expect(guardBody.match(/RETURN\s+NEW\s*;/g)?.length).toBe(clauses + 1);
  });

  it("reads the guard's edges out of its live body", () => {
    expect(edges.map((edge) => key(edge.from, edge.to)).sort()).toEqual([
      "active->cancelled",
      "active->completed",
      "active->paused",
      "cancelled->active",
      "cancelled->pending_activation",
      "paused->active",
      "paused->cancelled",
      "pending_activation->activation_failed",
      "pending_activation->active",
      "pending_activation->cancelled",
    ]);
  });

  it("admits exactly the guard's unconditional edges between the engine's statuses", () => {
    const engine = new Set<string>(SUBSCRIPTION_STATUSES);
    const sqlEngineEdges = edges
      .filter((edge) => engine.has(edge.from) && engine.has(edge.to))
      .map((edge) => {
        expect(edge.conditional, `${key(edge.from, edge.to)} is conditional in SQL`).toBe(false);
        return key(edge.from, edge.to);
      })
      .sort();
    const coreEdges = SUBSCRIPTION_STATUSES.flatMap((from) =>
      SUBSCRIPTION_STATUS_TRANSITIONS[from].map((to) => key(from, to)),
    ).sort();

    expect(coreEdges).toEqual(sqlEngineEdges);
  });

  it("leaves only activation-flow edges outside the engine, the audited reopen among them", () => {
    const engine = new Set<string>(SUBSCRIPTION_STATUSES);
    const outside = edges.filter((edge) => !(engine.has(edge.from) && engine.has(edge.to)));
    const recordStatuses = new Set<string>(SUBSCRIPTION_RECORD_STATUSES);

    for (const edge of outside) {
      expect(recordStatuses.has(edge.from) && recordStatuses.has(edge.to)).toBe(true);
      expect([edge.from, edge.to]).toContain("pending_activation");
    }
    expect(outside.find((edge) => edge.to === "pending_activation")).toMatchObject({
      from: "cancelled",
      conditional: true,
    });
  });
});
