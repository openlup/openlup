import { describe, expect, it } from "vitest";
import {
  createSupabaseChannelOpsReadPort,
  type ChannelOpsQueryClient,
} from "./channelOpsReadPort.js";

type Call = { table: string; columns: string; options?: unknown; filters: Array<[string, unknown]> };

function client(
  answers: Record<string, { data?: unknown; count?: number; error?: { message?: string } }>,
  calls: Call[] = [],
): ChannelOpsQueryClient {
  return {
    from(table) {
      const call: Call = { table, columns: "", filters: [] };
      calls.push(call);
      const answer = answers[table] ?? { data: null };
      const builder = {
        select(columns: string, options?: unknown) {
          call.columns = columns;
          call.options = options;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }),
        then: (onfulfilled: (value: unknown) => unknown) =>
          Promise.resolve(
            onfulfilled({
              data: answer.data ?? null,
              error: answer.error ?? null,
              count: answer.count ?? null,
            }),
          ),
      };
      return builder as unknown as ReturnType<ChannelOpsQueryClient["from"]>;
    },
  };
}

describe("channel operations read port", () => {
  it("reads the order's channel through the embed", async () => {
    const calls: Call[] = [];
    const port = createSupabaseChannelOpsReadPort(
      client(
        {
          commerce_orders: {
            data: {
              source_channel_id: "channel-1",
              sales_channels: { slug: "sim-market", display_name: "Simulator market", status: "active" },
            },
          },
        },
        calls,
      ),
    );

    await expect(port.readOrderChannel("order-1")).resolves.toEqual({
      channelId: "channel-1",
      slug: "sim-market",
      displayName: "Simulator market",
      status: "active",
    });
    expect(calls[0].filters).toEqual([["id", "order-1"]]);
  });

  it("reports a storefront order as no channel", async () => {
    const port = createSupabaseChannelOpsReadPort(
      client({ commerce_orders: { data: { source_channel_id: null } } }),
    );
    await expect(port.readOrderChannel("order-1")).resolves.toBeNull();
  });

  // An id with no embed is a channel row that is gone. Reported as absent, never as half a record.
  it("reports a channel id whose row is missing as no channel", async () => {
    const port = createSupabaseChannelOpsReadPort(
      client({ commerce_orders: { data: { source_channel_id: "channel-1", sales_channels: null } } }),
    );
    await expect(port.readOrderChannel("order-1")).resolves.toBeNull();
  });

  it("reads the ledger row for the order", async () => {
    const calls: Call[] = [];
    const port = createSupabaseChannelOpsReadPort(
      client(
        {
          channel_order_ingests: {
            data: {
              id: "ledger-1",
              status: "blocked_stock",
              external_order_ref: "SIM-1002",
              external_order_revision: null,
              last_error: "insufficient",
              updated_at: "2026-08-14T09:00:00.000Z",
            },
          },
        },
        calls,
      ),
    );

    await expect(port.readOrderIngest("order-1")).resolves.toEqual({
      ledgerId: "ledger-1",
      status: "blocked_stock",
      externalOrderRef: "SIM-1002",
      externalOrderRevision: null,
      lastError: "insufficient",
      updatedAt: "2026-08-14T09:00:00.000Z",
    });
    expect(calls[0].filters).toEqual([["order_id", "order-1"]]);
  });

  it("reports no ledger row as null", async () => {
    const port = createSupabaseChannelOpsReadPort(client({ channel_order_ingests: { data: null } }));
    await expect(port.readOrderIngest("order-1")).resolves.toBeNull();
  });

  it("counts open drawer rows as a count, never as rows fetched and discarded", async () => {
    const calls: Call[] = [];
    const port = createSupabaseChannelOpsReadPort(
      client({ sales_channel_quarantine: { count: 7 } }, calls),
    );

    await expect(port.countOpenQuarantine("channel-1")).resolves.toBe(7);
    expect(calls[0].options).toEqual({ count: "exact", head: true });
    expect(calls[0].filters).toEqual([
      ["channel_id", "channel-1"],
      ["status", "open"],
    ]);
  });

  it("reads an empty drawer as zero rather than as unknown", async () => {
    const port = createSupabaseChannelOpsReadPort(client({ sales_channel_quarantine: {} }));
    await expect(port.countOpenQuarantine("channel-1")).resolves.toBe(0);
  });

  it("surfaces a read failure by name instead of answering with an empty panel", async () => {
    const port = createSupabaseChannelOpsReadPort(
      client({ commerce_orders: { error: { message: "connection reset" } } }),
    );
    await expect(port.readOrderChannel("order-1")).rejects.toThrow(/channel_ops_order_channel_failed/);
  });
});
