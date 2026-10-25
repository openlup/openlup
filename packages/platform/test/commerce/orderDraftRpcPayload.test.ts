import { ORDER_DRAFT_RPC_NAME } from "../../src/commerce/server/index.js";
import { describe, expect, it } from "vitest";

import { frozenQuote } from "./storeTestFixtures.js";
function createStaticCommerceQuotePort() { return { async createQuote(input: { mode: string; lines: Array<{sku: string; quantity: number}>; promoCodes: string[] }) {
  const snapshot = frozenQuote(), quantity = input.lines[0].quantity;
  snapshot.quote.lines[0].quantity = quantity;
  snapshot.quote.lines[0].sku = input.lines[0].sku;
  snapshot.quote.lines[0].lineSubtotalGross.amountMinor = 1490 * quantity;
  snapshot.quote.subtotalGross.amountMinor = snapshot.quote.totalGross.amountMinor = 1490 * quantity;
  const net = Math.round(1490 * quantity * 10000 / 10800), tax = 1490 * quantity - net;
  snapshot.quote.netTotal.amountMinor = net; snapshot.quote.taxTotal.amountMinor = tax;
  snapshot.quote.lines[0].tax.netAmount.amountMinor = net; snapshot.quote.lines[0].tax.vatAmount.amountMinor = tax;
  snapshot.quote.lines[0].tax.grossAmount.amountMinor = 1490 * quantity;
  return snapshot;
} }; }
import {
  ORDER_DRAFT_SNAPSHOT_SOURCE,
  createOrderDraftRpcArgs,
  orderDraftRpcArgsSchema,
} from "./storeTestFixtures.js";

describe("order draft RPC payload mapper", () => {
  it("maps hidden order draft requests into the accepted future RPC arguments", async () => {
    const quoteSnapshot = await createStaticCommerceQuotePort().createQuote({
      mode: "one_time",
      lines: [{ sku: "ITEM-A", quantity: 2 }],
      promoCodes: [],
    });

    const args = createOrderDraftRpcArgs({
      idempotencyKey: "quote-1999-06-01-item-a",
      quoteSnapshot,
    });

    expect(ORDER_DRAFT_RPC_NAME).toBe("commerce_create_order_draft_with_outbox");
    expect(orderDraftRpcArgsSchema.parse(args)).toEqual(args);
    expect(args).toMatchObject({
      p_idempotency_key: "quote-1999-06-01-item-a",
      p_quote_snapshot: quoteSnapshot,
      p_order_draft_snapshot: {
        contractVersion: "commerce.v0",
        source: ORDER_DRAFT_SNAPSHOT_SOURCE,
        status: "draft",
        paymentStatus: "not_started",
        currency: "XTS",
        taxIncluded: true,
        totals: {
          subtotalGross: { amountMinor: 2980, currency: "XTS" },
          discountTotalGross: { amountMinor: 0, currency: "XTS" },
          totalGross: { amountMinor: 2980, currency: "XTS" },
          netTotal: { amountMinor: 2759, currency: "XTS" },
          taxTotal: { amountMinor: 221, currency: "XTS" },
        },
      },
    });
    expect(args.p_order_draft_snapshot.lines).toEqual(quoteSnapshot.quote.lines);
  });

  it("threads a provided clientId into p_client_id (checkout-saga recipient wiring)", async () => {
    const quoteSnapshot = await createStaticCommerceQuotePort().createQuote({
      mode: "one_time",
      lines: [{ sku: "ITEM-A", quantity: 1 }],
      promoCodes: [],
    });

    const clientId = "11111111-2222-4333-8444-555555555555";
    const args = createOrderDraftRpcArgs(
      { idempotencyKey: "quote-1999-06-01-item-a", quoteSnapshot },
      clientId,
    );

    expect(args.p_client_id).toBe(clientId);
    expect(orderDraftRpcArgsSchema.parse(args)).toEqual(args);
  });

  it("OMITS p_client_id for an absent/null clientId so the anonymous call stays a 3-arg RPC", async () => {
    const quoteSnapshot = await createStaticCommerceQuotePort().createQuote({
      mode: "one_time",
      lines: [{ sku: "ITEM-A", quantity: 1 }],
      promoCodes: [],
    });
    const request = { idempotencyKey: "quote-1999-06-01-item-a", quoteSnapshot };

    const absent = createOrderDraftRpcArgs(request);
    const explicitNull = createOrderDraftRpcArgs(request, null);

    // OMITTED (undefined), not null: keeps the RPC call at three arguments, which
    // resolves both before and after the client_id migration applies.
    expect(absent.p_client_id).toBeUndefined();
    expect("p_client_id" in absent).toBe(false);
    expect(explicitNull.p_client_id).toBeUndefined();
  });

  it("keeps customer, shipping, fulfillment, and provider data out of the draft snapshot", async () => {
    const quoteSnapshot = await createStaticCommerceQuotePort().createQuote({
      mode: "one_time",
      lines: [{ sku: "ITEM-B", quantity: 1 }],
      promoCodes: [],
    });

    const snapshot = createOrderDraftRpcArgs({
      idempotencyKey: "quote-1999-06-01-item-b",
      quoteSnapshot,
    }).p_order_draft_snapshot;

    expect(snapshot).not.toHaveProperty("customer");
    expect(snapshot).not.toHaveProperty("shipping");
    expect(snapshot).not.toHaveProperty("fulfillment");
    expect(snapshot).not.toHaveProperty("provider");

    const withProvider = structuredClone(
      createOrderDraftRpcArgs({
        idempotencyKey: "quote-1999-06-01-item-b",
        quoteSnapshot,
      }),
    );
    (withProvider.p_order_draft_snapshot as Record<string, unknown>).provider = {
      name: "rail-a",
    };

    expect(orderDraftRpcArgsSchema.safeParse(withProvider).success).toBe(false);
  });

  it("rejects malformed draft snapshots before a future DB adapter can use them", async () => {
    const quoteSnapshot = await createStaticCommerceQuotePort().createQuote({
      mode: "one_time",
      lines: [{ sku: "ITEM-A", quantity: 1 }],
      promoCodes: [],
    });
    const args = createOrderDraftRpcArgs({
      idempotencyKey: "quote-1999-06-01-item-a",
      quoteSnapshot,
    });
    const malformed = structuredClone(args);
    malformed.p_order_draft_snapshot.lines[0].lineSubtotalGross.amountMinor = 1;

    expect(orderDraftRpcArgsSchema.safeParse(malformed).success).toBe(false);
  });
});
