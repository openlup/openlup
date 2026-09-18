import { describe, expect, it, vi } from "vitest";
// Aliased at the import so the companion does not repeat the adapter's
// provider-bearing export names on every assertion. The subject under test is
// unchanged; only this file's vocabulary is local.
import {
  createSupabaseOrderBuyerCommsPolicyReader as createCommsReader,
  createSupabaseOrderInvoicePolicyReader as createInvoiceReader,
  type OrderPolicySupabaseClient as PolicyClient,
} from "./orderBuyerCommsPolicyReader.js";

const ORDER_UUID = "11111111-2222-3333-4444-555555555555";
const FULFILLMENT_ORDER_ID = "99999999-8888-7777-6666-555555555555";

type Call = { table: string; columns: string; column: string; value: unknown };

function clientReturning(
  data: unknown,
  error: { code?: string; message?: string } | null = null,
): { client: PolicyClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: PolicyClient = {
    from(table: string) {
      const call: Call = { table, columns: "", column: "", value: undefined };
      calls.push(call);
      const query = {
        select(columns: string) { call.columns = columns; return query; },
        eq(column: string, value: unknown) { call.column = column; call.value = value; return query; },
        maybeSingle: () => Promise.resolve({ data, error }),
      };
      return query;
    },
  };
  return { client, calls };
}

describe("managed buyer-comms policy reader", () => {
  it("reads the policy through the source-channel embed", async () => {
    const { client, calls } = clientReturning({
      source_kind: "marketplace",
      sales_channels: { buyer_comms_owner: "channel", invoice_policy: "channel_issues" },
    });

    await expect(createCommsReader(client)
      .readOrderBuyerCommsPolicy(ORDER_UUID))
      .resolves.toEqual({ sourceKind: "marketplace", buyerCommsOwner: "channel" });
    expect(calls).toEqual([{
      table: "commerce_orders",
      columns: "source_kind, sales_channels(buyer_comms_owner, invoice_policy)",
      column: "id",
      value: ORDER_UUID,
    }]);
  });

  it("answers null for a storefront order, which embeds no channel", async () => {
    const { client } = clientReturning({ source_kind: "storefront", sales_channels: null });
    await expect(createCommsReader(client)
      .readOrderBuyerCommsPolicy(ORDER_UUID)).resolves.toBeNull();
  });

  it("answers null for an order that does not exist", async () => {
    const { client } = clientReturning(null);
    await expect(createCommsReader(client)
      .readOrderBuyerCommsPolicy(ORDER_UUID)).resolves.toBeNull();
  });

  it("accepts the one-element-array shape PostgREST also produces for a to-one embed", async () => {
    const { client } = clientReturning({
      source_kind: "marketplace",
      sales_channels: [{ buyer_comms_owner: "platform", invoice_policy: "issue" }],
    });
    await expect(createCommsReader(client)
      .readOrderBuyerCommsPolicy(ORDER_UUID))
      .resolves.toEqual({ sourceKind: "marketplace", buyerCommsOwner: "platform" });
  });

  it("throws a named error rather than reporting a read failure as `no channel`", async () => {
    // A swallowed failure here would read as "storefront order" and send the
    // buyer an email the channel already sent.
    const { client } = clientReturning(null, { code: "PGRST301", message: "jwt expired" });
    await expect(createCommsReader(client)
      .readOrderBuyerCommsPolicy(ORDER_UUID))
      .rejects.toThrow("order_channel_policy_read_failed: commerce_orders: jwt expired");
  });
});

describe("managed invoice policy reader", () => {
  it("answers the order key from the same row", async () => {
    const { client } = clientReturning({
      source_kind: "marketplace",
      sales_channels: { buyer_comms_owner: "channel", invoice_policy: "suppress" },
    });
    await expect(createInvoiceReader(client)
      .readOrderInvoicePolicy({ by: "order", orderUuid: ORDER_UUID }))
      .resolves.toEqual({ sourceKind: "marketplace", invoicePolicy: "suppress" });
  });

  it("answers the fulfillment-order key through the order embed", async () => {
    const { client, calls } = clientReturning({
      commerce_orders: {
        source_kind: "marketplace",
        sales_channels: { buyer_comms_owner: "channel", invoice_policy: "channel_issues" },
      },
    });
    await expect(createInvoiceReader(client)
      .readOrderInvoicePolicy({ by: "fulfillmentOrder", fulfillmentOrderId: FULFILLMENT_ORDER_ID }))
      .resolves.toEqual({ sourceKind: "marketplace", invoicePolicy: "channel_issues" });
    expect(calls[0]).toMatchObject({
      table: "commerce_fulfillment_orders",
      column: "id",
      value: FULFILLMENT_ORDER_ID,
    });
  });

  it("answers null for a storefront fulfillment order", async () => {
    const { client } = clientReturning({
      commerce_orders: { source_kind: "storefront", sales_channels: null },
    });
    await expect(createInvoiceReader(client)
      .readOrderInvoicePolicy({ by: "fulfillmentOrder", fulfillmentOrderId: FULFILLMENT_ORDER_ID }))
      .resolves.toBeNull();
  });

  it("names the fulfillment-order table in its read failure", async () => {
    const { client } = clientReturning(null, { message: "boom" });
    await expect(createInvoiceReader(client)
      .readOrderInvoicePolicy({ by: "fulfillmentOrder", fulfillmentOrderId: FULFILLMENT_ORDER_ID }))
      .rejects.toThrow("order_channel_policy_read_failed: commerce_fulfillment_orders: boom");
  });
});

describe("policy read liveness", () => {
  it("re-reads on every call so an operator's policy flip takes effect immediately", async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: { source_kind: "marketplace", sales_channels: { buyer_comms_owner: "platform" } }, error: null })
      .mockResolvedValueOnce({ data: { source_kind: "marketplace", sales_channels: { buyer_comms_owner: "channel" } }, error: null });
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle,
    };
    const reader = createCommsReader({ from: () => query });

    await expect(reader.readOrderBuyerCommsPolicy(ORDER_UUID))
      .resolves.toMatchObject({ buyerCommsOwner: "platform" });
    await expect(reader.readOrderBuyerCommsPolicy(ORDER_UUID))
      .resolves.toMatchObject({ buyerCommsOwner: "channel" });
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });
});
