import { describe, expect, it, vi } from "vitest";
import { createPostgresRiskControlPorts } from "./riskControl.js";

describe("createPostgresRiskControlPorts", () => {
  it("reuses one parameter for exact id/order search and returns neutral cases", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const ports = createPostgresRiskControlPorts({ query }, { mode: "shadow" });
    await ports.adminPort.listCases({ page: 1, pageSize: 25, search: "00000000-0000-4000-8000-000000000001" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("id::text = $1 OR order_id::text = $1"),
      ["00000000-0000-4000-8000-000000000001", 25, 0],
    );
  });

  it("reads paid-order evidence and invokes the public assessment function", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM commerce_orders")) return { rows: [{ id: "o1", client_id: null, total_amount_minor: 1000, currency_code: "XTS", metadata: {} }] };
      if (sql.includes("FROM commerce_settlement_intents")) return { rows: [{ id: "s1", amount_minor: 1000, currency_code: "XTS" }] };
      if (sql.includes("risk_check_exact_blocklist")) return { rows: [{ value: { blocked: false, reasonCodes: [] } }] };
      return { rows: [{ value: { assessmentId: "a1", caseId: null, holdId: null, decision: "allow", holdOpened: false, replayed: false } }] };
    });
    const ports = createPostgresRiskControlPorts({ query }, { mode: "shadow" });
    await expect(ports.assessmentPort.assessPaidOrder({ orderUuid: "o1", outboxEventId: "e1", signal: new AbortController().signal }))
      .resolves.toMatchObject({ kind: "allow", detail: { assessmentId: "a1" } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("risk_assess_paid_order"))).toBe(true);
  });
});
