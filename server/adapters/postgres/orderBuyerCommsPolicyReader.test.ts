import { describe, expect, it, vi } from "vitest";
import {
  OrderInvoicePolicyLookupUnavailableError,
  createPostgresOrderBuyerCommsPolicyReader,
  createPostgresOrderInvoicePolicyReader,
} from "./orderBuyerCommsPolicyReader.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const ORDER_UUID = "11111111-2222-3333-4444-555555555555";

function executorReturning(rows: unknown[]): PgQueryExecutor & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rows })) } as unknown as PgQueryExecutor & {
    query: ReturnType<typeof vi.fn>;
  };
}

describe("createPostgresOrderBuyerCommsPolicyReader", () => {
  it("reads the policy through one LEFT JOIN keyed on the order id", async () => {
    const executor = executorReturning([
      { source_kind: "marketplace", buyer_comms_owner: "channel", invoice_policy: "suppress" },
    ]);

    await expect(createPostgresOrderBuyerCommsPolicyReader(executor)
      .readOrderBuyerCommsPolicy(ORDER_UUID))
      .resolves.toEqual({ sourceKind: "marketplace", buyerCommsOwner: "channel" });
    const [sql, params] = executor.query.mock.calls[0];
    expect(sql).toContain("LEFT JOIN public.sales_channels");
    expect(params).toEqual([ORDER_UUID]);
  });

  it("answers null for a storefront order, where the join produces no channel", async () => {
    const executor = executorReturning([
      { source_kind: "storefront", buyer_comms_owner: null, invoice_policy: null },
    ]);
    await expect(createPostgresOrderBuyerCommsPolicyReader(executor)
      .readOrderBuyerCommsPolicy(ORDER_UUID)).resolves.toBeNull();
  });

  it("answers null for an order that does not exist", async () => {
    const executor = executorReturning([]);
    await expect(createPostgresOrderBuyerCommsPolicyReader(executor)
      .readOrderBuyerCommsPolicy(ORDER_UUID)).resolves.toBeNull();
  });

  it("lets a query failure propagate rather than reporting it as `no channel`", async () => {
    const executor = {
      query: async () => { throw new Error("connection terminated"); },
    } as unknown as PgQueryExecutor;
    await expect(createPostgresOrderBuyerCommsPolicyReader(executor)
      .readOrderBuyerCommsPolicy(ORDER_UUID)).rejects.toThrow("connection terminated");
  });
});

describe("createPostgresOrderInvoicePolicyReader", () => {
  it("answers the order key", async () => {
    const executor = executorReturning([
      { source_kind: "marketplace", buyer_comms_owner: "channel", invoice_policy: "channel_issues" },
    ]);
    await expect(createPostgresOrderInvoicePolicyReader(executor)
      .readOrderInvoicePolicy({ by: "order", orderUuid: ORDER_UUID }))
      .resolves.toEqual({ sourceKind: "marketplace", invoicePolicy: "channel_issues" });
  });

  it("refuses the fulfillment-order key BY NAME on a chain that has no such relation", async () => {
    // Returning null here would read as "storefront order, issue the document"
    // and quietly mint a duplicate for a marketplace that issues its own.
    const executor = executorReturning([]);
    await expect(createPostgresOrderInvoicePolicyReader(executor)
      .readOrderInvoicePolicy({ by: "fulfillmentOrder", fulfillmentOrderId: "fo-1" }))
      .rejects.toBeInstanceOf(OrderInvoicePolicyLookupUnavailableError);
    await expect(createPostgresOrderInvoicePolicyReader(executor)
      .readOrderInvoicePolicy({ by: "fulfillmentOrder", fulfillmentOrderId: "fo-1" }))
      .rejects.toThrow("commerce_fulfillment_orders");
  });

  it("answers null for a storefront order", async () => {
    const executor = executorReturning([
      { source_kind: "storefront", buyer_comms_owner: null, invoice_policy: null },
    ]);
    await expect(createPostgresOrderInvoicePolicyReader(executor)
      .readOrderInvoicePolicy({ by: "order", orderUuid: ORDER_UUID })).resolves.toBeNull();
  });
});
