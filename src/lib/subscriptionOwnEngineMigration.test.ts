import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges } from "../test/historicalBoundarySchema";

describe("current subscription own-engine schema", () => {
  it("retains engine snapshots, bounded retries and unique idempotency", () => {
    const cycles = currentTableStatements("subscription_cycles");
    expect(cycles).toMatch(/template_snapshot jsonb[^\n]*NOT NULL/);
    expect(cycles).toMatch(/pricing_snapshot jsonb[^\n]*NOT NULL/);
    expect(cycles).toMatch(/retry_attempt integer[^\n]*DEFAULT 0[^\n]*NOT NULL/);
    expect(cycles).toContain("engine_idempotency_key text NOT NULL");
    expect(cycles).toMatch(/CREATE UNIQUE INDEX [^;]*\(engine_idempotency_key\)/);
    expect(currentTableStatements("commerce_orders")).toContain("subscription_cycle_id uuid");
  });
  it("retains audit RLS, unique event replay identity and no anonymous audit access", () => {
    const events = currentTableStatements("subscription_events");
    expect(events).toContain("ENABLE ROW LEVEL SECURITY");
    expect(events).toContain("admin_all_subscription_events");
    expect(events).toMatch(/CREATE UNIQUE INDEX [^;]*\(idempotency_key\)[^;]*WHERE \(idempotency_key IS NOT NULL\)/);
    const acl = explicitTablePrivileges("subscription_events");
    expect(acl.get("anon")?.size ?? 0).toBe(0);
    expect(acl.get("PUBLIC")?.size ?? 0).toBe(0);
  });
});
