import { describe, expect, it, vi } from "vitest";
import {
  createSupabasePaidFulfillmentRecoveryOpsPort,
  type PaidFulfillmentRecoverySupabaseClient,
} from "./paidFulfillmentRecoveryOpsPort.js";

describe("createSupabasePaidFulfillmentRecoveryOpsPort", () => {
  it("reads only minimal non-PII recovery inputs scoped to stale paid orders", async () => {
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const client = fakeClient(calls, {
      commerce_orders: [
        {
          id: "42222222-2222-4222-8222-222222222221",
          status: "paid",
          mode: "one_time",
          created_at: "2026-07-12T10:00:00.000Z",
          updated_at: "2026-07-12T10:00:00.000Z",
        },
      ],
      commerce_fulfillment_orders: [],
      outbox_events: [],
    });

    const result = await createSupabasePaidFulfillmentRecoveryOpsPort(
      client as unknown as PaidFulfillmentRecoverySupabaseClient,
    ).readRecoveryInputs({
      minimumAgeSeconds: 1800,
      limit: 25,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });

    expect(result.orders).toHaveLength(1);
    expect(calls).toContainEqual({
      table: "commerce_orders",
      op: "select",
      args: ["id,status,mode,created_at,updated_at"],
    });
    expect(calls).toContainEqual({
      table: "outbox_events",
      op: "select",
      args: ["id,event_type,status,aggregate_id,created_at,available_at,attempts"],
    });
    expect(JSON.stringify(calls)).not.toContain("email");
    expect(JSON.stringify(calls)).not.toContain("shipping_address_snapshot");
    expect(JSON.stringify(calls)).not.toContain("updated_at,available_at");
  });

  it("reuses the existing discarded-outbox requeue RPC and scopes it to order-paid events", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "52222222-2222-4222-8222-222222222221" }],
      error: null,
    });
    const client = { ...fakeClient([], {}), rpc };

    await expect(createSupabasePaidFulfillmentRecoveryOpsPort(
      client as unknown as PaidFulfillmentRecoverySupabaseClient,
    ).requeueDiscardedOrderPaidOutboxEvents({
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      requeuedBy: "72222222-2222-4222-8222-222222222221",
      reason: "operator confirmed local discarded order-paid event",
      limit: 1,
    })).resolves.toEqual({
      requeuedCount: 1,
      eventIds: ["52222222-2222-4222-8222-222222222221"],
    });

    expect(rpc).toHaveBeenCalledWith("outbox_requeue_discarded", {
      p_event_ids: ["52222222-2222-4222-8222-222222222221"],
      p_event_type: "commerce.order.paid",
      p_limit: 1,
      p_requeued_by: "72222222-2222-4222-8222-222222222221",
      p_reason: "operator confirmed local discarded order-paid event",
    });
  });

  it("reads matching direct-dispatch proof without command-ledger or PII access", async () => {
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const client = fakeClient(calls, {
      commerce_orders: [{
        id: "42222222-2222-4222-8222-222222222221",
        status: "paid",
        updated_at: "2026-07-12T10:00:00.000Z",
      }],
      commerce_fulfillment_orders: [{
        id: "62222222-2222-4222-8222-222222222221",
        order_id: "42222222-2222-4222-8222-222222222221",
        provider_kind: "omnipack",
        status: "created",
      }],
      omnipack_dispatch_refs: [{
        id: "82222222-2222-4222-8222-222222222221",
        fulfillment_order_id: "62222222-2222-4222-8222-222222222221",
        provider_order_id: "omnipack-order-1",
        status: "created",
      }],
      outbox_events: [],
    });

    const result = await createSupabasePaidFulfillmentRecoveryOpsPort(
      client as unknown as PaidFulfillmentRecoverySupabaseClient,
    ).readRecoveryInputs({
      minimumAgeSeconds: 1800,
      limit: 25,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });

    expect(result.omnipackDispatchRefs).toEqual([expect.objectContaining({
      id: "82222222-2222-4222-8222-222222222221",
      provider_order_id: "omnipack-order-1",
      status: "created",
    })]);
    expect(calls).toContainEqual({
      table: "omnipack_dispatch_refs",
      op: "select",
      args: ["id,fulfillment_order_id,provider_order_id,status,created_at,updated_at"],
    });
    expect(calls.some((call) => call.table === "commerce_fulfillment_provider_commands")).toBe(false);
  });

  it("can scope preview reads to a concrete OMS order ID", async () => {
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const client = fakeClient(calls, {
      commerce_orders: [{
        id: "42222222-2222-4222-8222-222222222221",
        status: "paid",
        mode: "one_time",
        updated_at: "2026-07-12T10:00:00.000Z",
      }],
      commerce_fulfillment_orders: [],
      outbox_events: [],
    });

    await createSupabasePaidFulfillmentRecoveryOpsPort(
      client as unknown as PaidFulfillmentRecoverySupabaseClient,
    ).readRecoveryInputs({
      minimumAgeSeconds: 1800,
      limit: 25,
      now: new Date("2026-07-12T12:00:00.000Z"),
      orderIds: ["42222222-2222-4222-8222-222222222221"],
    });

    expect(calls).toContainEqual({
      table: "commerce_orders",
      op: "in",
      args: ["id", ["42222222-2222-4222-8222-222222222221"]],
    });
  });
});

function fakeClient(
  calls: Array<{ table: string; op: string; args: unknown[] }>,
  rowsByTable: Record<string, unknown[]>,
) {
  return {
    rpc: vi.fn(),
    from(table: string) {
      return {
        select(columns: string) {
          calls.push({ table, op: "select", args: [columns] });
          return builder(table, rowsByTable[table] ?? [], calls);
        },
      };
    },
  };
}

function builder(
  table: string,
  rows: unknown[],
  calls: Array<{ table: string; op: string; args: unknown[] }>,
) {
  const api = {
    in(column: string, values: string[]) {
      calls.push({ table, op: "in", args: [column, values] });
      return api;
    },
    lte(column: string, value: string) {
      calls.push({ table, op: "lte", args: [column, value] });
      return api;
    },
    eq(column: string, value: string) {
      calls.push({ table, op: "eq", args: [column, value] });
      return api;
    },
    order(column: string, options?: { ascending?: boolean }) {
      calls.push({ table, op: "order", args: [column, options] });
      return api;
    },
    limit(count: number) {
      calls.push({ table, op: "limit", args: [count] });
      return api;
    },
    then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve(resolve({ data: rows, error: null }));
    },
  };
  return api;
}
