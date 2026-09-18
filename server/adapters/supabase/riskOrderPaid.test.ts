import { describe, expect, it, vi } from "vitest";
import { ORDER_HEADER_MONEY_COLUMNS } from "../../../src/domains/commerce/types.js";
import {
  createSupabaseOrderPaidRiskAssessmentPort,
  createSupabaseRiskCheckoutBlocklistPort,
  type RiskSupabaseClient,
} from "./riskOrderPaid.js";

function makeClient(opts: {
  maybeSingle?: { data: unknown; error: unknown | null };
  rpc?: { data: unknown; error: unknown | null };
} = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) builder[m] = () => builder;
  builder.maybeSingle = () => Promise.resolve(opts.maybeSingle ?? { data: null, error: null });
  const client = {
    from: () => builder,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(opts.rpc ?? { data: { blocked: false, reasonCodes: [] }, error: null });
    },
  } as unknown as RiskSupabaseClient;
  return { client, rpcCalls };
}

function makeAssessmentClient(order: Record<string, unknown>) {
  const selects = new Map<string, string>();
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rows: Record<string, unknown> = {
    commerce_orders: order,
    commerce_payment_intents: {
      id: "intent-1",
      amount_cents: 9_000,
      currency: "PLN",
    },
  };
  const client = {
    from(table: string) {
      const builder = {
        select(columns: string) {
          selects.set(table, columns);
          return builder;
        },
        eq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: rows[table] ?? null, error: null });
        },
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "risk_check_exact_blocklist") {
        return Promise.resolve({ data: { blocked: false, reasonCodes: [] }, error: null });
      }
      if (name === "risk_assess_paid_order") {
        return Promise.resolve({
          data: {
            assessmentId: "assessment-1",
            caseId: null,
            holdId: null,
            decision: "allow",
            holdOpened: false,
            replayed: false,
          },
          error: null,
        });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  } as unknown as RiskSupabaseClient;
  return { client, rpcCalls, selects };
}

function canonicalOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    client_id: "client-1",
    mode: "one_time",
    metadata: {},
    currency: "PLN",
    subtotal_cents: 10_000,
    discount_cents: 1_000,
    shipping_cents: 1_500,
    shipping_discount_cents: 1_500,
    tax_cents: 667,
    total_cents: 9_000,
    ...overrides,
  };
}

describe("orderPaidRiskAssessmentPort", () => {
  it("returns retryable when the signal is already aborted", async () => {
    const port = createSupabaseOrderPaidRiskAssessmentPort({ client: makeClient().client, mode: "shadow" });
    const r = await port.assessPaidOrder({ orderUuid: "o1", outboxEventId: "e1", signal: AbortSignal.abort() });
    expect(r.kind).toBe("retryable");
  });

  it("returns fatal when the order is not found", async () => {
    const port = createSupabaseOrderPaidRiskAssessmentPort({
      client: makeClient({ maybeSingle: { data: null, error: null } }).client,
      mode: "shadow",
    });
    const r = await port.assessPaidOrder({
      orderUuid: "o1",
      outboxEventId: "e1",
      signal: new AbortController().signal,
    });
    expect(r.kind).toBe("fatal");
    expect("reason" in r && r.reason).toContain("risk_order_not_found");
  });

  it("reads the canonical header and assesses using its total and currency", async () => {
    const { client, rpcCalls, selects } = makeAssessmentClient(canonicalOrder());
    const port = createSupabaseOrderPaidRiskAssessmentPort({ client, mode: "shadow" });

    await expect(port.assessPaidOrder({
      orderUuid: "order-1",
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: "allow" });

    expect(selects.get("commerce_orders")).toBe(
      `id,client_id,mode,metadata,${ORDER_HEADER_MONEY_COLUMNS}`,
    );
    expect(rpcCalls.some((call) => call.name === "risk_assess_paid_order")).toBe(true);
  });

  it("fails closed instead of substituting the intent when order total is missing", async () => {
    const { client, rpcCalls } = makeAssessmentClient(canonicalOrder({ total_cents: null }));
    const port = createSupabaseOrderPaidRiskAssessmentPort({ client, mode: "shadow" });

    await expect(port.assessPaidOrder({
      orderUuid: "order-1",
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "fatal", reason: "risk_order_money_invalid_input" });
    expect(rpcCalls).toEqual([]);
  });

  it("fails closed and emits the canonical diagnostic on a header mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, rpcCalls } = makeAssessmentClient(canonicalOrder({ total_cents: 9_001 }));
    const port = createSupabaseOrderPaidRiskAssessmentPort({ client, mode: "shadow" });

    const result = await port.assessPaidOrder({
      orderUuid: "order-1",
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ kind: "fatal" });
    expect("reason" in result && result.reason).toContain("risk_order_money_invalid_input");
    expect(warn).toHaveBeenCalledWith(
      "commerce_order_money_unreconciled",
      expect.stringContaining("header_equation_mismatch"),
    );
    expect(rpcCalls).toEqual([]);
    warn.mockRestore();
  });
});

describe("supabase risk checkout blocklist port", () => {
  it("calls risk_check_exact_blocklist and surfaces blocked=true", async () => {
    const { client, rpcCalls } = makeClient({ rpc: { data: { blocked: true, reasonCodes: ["x"] }, error: null } });
    const result = await createSupabaseRiskCheckoutBlocklistPort(client).checkExactBlocklist({
      subjectRefs: [{ subjectKind: "email", subjectHash: "h1" }],
    });
    expect(result.blocked).toBe(true);
    expect(rpcCalls[0]?.name).toBe("risk_check_exact_blocklist");
  });
});
