import { describe, expect, it, vi } from "vitest";
import { createReferenceJourneyAuditClient, referenceJourneyOrderReadbackAdapter } from "./referenceJourneyOrderReadbackAdapter.js";

const CLIENT = "11111111-1111-4111-8111-111111111111", ORDER = "22222222-2222-4222-8222-222222222222";

function gateway(results: Array<{ data: Record<string, unknown> | Array<Record<string, unknown>> | null; error: unknown }>) {
  const calls: Array<{ table: string; columns?: string; filters: Array<[string, unknown]>; limit?: number }> = [];
  return {
    calls,
    client: { from: vi.fn((table: string) => {
      const call: { table: string; columns?: string; filters: Array<[string, unknown]>; limit?: number } = { table, filters: [] }; calls.push(call);
      const query = {
        select: vi.fn((columns: string) => { call.columns = columns; return query; }),
        eq: vi.fn((column: string, value: unknown) => { call.filters.push([column, value]); return query; }),
        limit: vi.fn(async (limit: number) => { call.limit = limit; return results.shift(); }),
        maybeSingle: vi.fn(async () => results.shift()),
      };
      return query;
    }) },
  };
}

describe("reference journey order readback adapter", () => {
  it("uses only the RLS-visible customer and owned-order identity queries", async () => {
    const fixture = gateway([{ data: { id: CLIENT }, error: null }, { data: [{ id: ORDER }], error: null }]);
    await expect(referenceJourneyOrderReadbackAdapter.listCustomerOrders(fixture.client, "user-1", 20)).resolves.toEqual([{ orderId: ORDER }]);
    expect(fixture.calls).toEqual([
      { table: "clients", columns: "id", filters: [["auth_user_id", "user-1"]] },
      { table: "commerce_orders", columns: "id", filters: [["client_id", CLIENT]], limit: 20 },
    ]);
  });

  it("uses only order identity plus internal client identity for the operator path", async () => {
    const fixture = gateway([{ data: { id: ORDER, client_id: CLIENT }, error: null }]);
    await expect(referenceJourneyOrderReadbackAdapter.getOperatorOrder(fixture.client, ORDER)).resolves.toEqual({ orderId: ORDER, clientId: CLIENT });
    expect(fixture.calls).toEqual([{ table: "commerce_orders", columns: "id, client_id", filters: [["id", ORDER]] }]);
  });

  it("fails closed on gateway errors and maps absent rows to an identity-only miss", async () => {
    const failed = gateway([{ data: null, error: new Error("down") }]);
    await expect(referenceJourneyOrderReadbackAdapter.getOperatorOrder(failed.client, ORDER)).rejects.toThrow("down");
    const absent = gateway([{ data: null, error: null }]);
    await expect(referenceJourneyOrderReadbackAdapter.getOperatorOrder(absent.client, ORDER)).resolves.toBeNull();
  });

  it("adapts service-only access to audit RPC lazily and fails closed when unavailable", async () => {
    const result = { data: { recorded: true }, error: null };
    const rpc = vi.fn(async () => result);
    const asService = vi.fn(async (work) => work({ rpc }));
    const resolveServicePort = vi.fn(() => ({ asService }));
    const auditClient = createReferenceJourneyAuditClient(resolveServicePort);
    expect(resolveServicePort).not.toHaveBeenCalled();
    expect(asService).not.toHaveBeenCalled();
    await expect(auditClient.rpc("record_admin_audit_event", { p_actor_id: "machine" })).resolves.toBe(result);
    expect(resolveServicePort).toHaveBeenCalledOnce();
    expect(asService).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("record_admin_audit_event", { p_actor_id: "machine" });
    await expect(createReferenceJourneyAuditClient(() => null).rpc("record", {}))
      .rejects.toThrow("Operator service data port is unavailable");
  });
});
