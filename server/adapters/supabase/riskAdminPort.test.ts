import { describe, expect, it } from "vitest";
import { createSupabaseRiskAdminPort, type RiskAdminSupabaseClient } from "./riskAdminPort.js";

function makeClient(opts: {
  range?: { data: unknown; error: unknown | null; count?: number | null };
  maybeSingle?: { data: unknown; error: unknown | null };
} = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "or", "order"]) builder[m] = () => builder;
  builder.range = () => Promise.resolve(opts.range ?? { data: [], error: null, count: 0 });
  builder.maybeSingle = () => Promise.resolve(opts.maybeSingle ?? { data: null, error: null });
  const client = {
    from: () => builder,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as RiskAdminSupabaseClient;
  return { client, rpcCalls };
}

describe("supabase risk admin port", () => {
  it("listCases maps an empty result with contract version + zero counts", async () => {
    const { client } = makeClient({ range: { data: [], error: null, count: 0 } });
    const result = await createSupabaseRiskAdminPort(client).listCases({ page: 1, pageSize: 20 } as never);
    expect(result.cases).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.contractVersion).toBeTruthy();
  });

  it("getCaseDetail returns null when the case row is missing", async () => {
    const { client } = makeClient({ maybeSingle: { data: null, error: null } });
    const result = await createSupabaseRiskAdminPort(client).getCaseDetail({ caseId: "missing" } as never);
    expect(result).toBeNull();
  });

  it("decideCase calls risk_resolve_manual_review_case with the case + decision", async () => {
    const { client, rpcCalls } = makeClient({ maybeSingle: { data: null, error: null } });
    await expect(
      createSupabaseRiskAdminPort(client).decideCase({
        idempotencyKey: "idem-1",
        caseId: "case-1",
        decision: "approve",
        actorUserId: "admin-1",
        note: null,
      } as never),
    ).rejects.toThrow();
    expect(rpcCalls[0]?.name).toBe("risk_resolve_manual_review_case");
    expect(rpcCalls[0]?.args.p_case_id).toBe("case-1");
    expect(rpcCalls[0]?.args.p_decision).toBe("approve");
  });
});
