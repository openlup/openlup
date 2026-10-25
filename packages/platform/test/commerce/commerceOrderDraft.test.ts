import { describe, expect, it, vi } from "vitest";
import { CommerceOrderDraftConflictError, CommerceOrderDraftInvalidResponseError, CommerceOrderDraftPriceChangedError, CommerceOrderDraftPersistenceError } from "../../src/commerce/index.js";
import { ORDER_DRAFT_RPC_NAME, ORDER_DRAFT_SUPERSEDE_RPC_NAME } from "../../src/commerce/server/index.js";
import { createSupabaseCommerceOrderDraftPort, createOrderDraftRpcArgs, type CommerceOrderDraftRpcClient, type CreateOrderDraftRequest, type CreateOrderDraftResponse, type CreateQuoteResponse } from "./storeTestFixtures.js";

describe("supabase commerce order draft port", () => {
  it("calls only the atomic order draft RPC with mapped args", async () => {
    const request = orderDraftRequest();
    const response = orderDraftResponse(false);
    const client = createRpcClient({ data: response, error: null });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(request),
    ).resolves.toEqual(response);

    expect(client.rpc).toHaveBeenCalledWith(
      ORDER_DRAFT_RPC_NAME,
      createOrderDraftRpcArgs(request),
    );
  });

  it("passes through replay responses from the RPC", async () => {
    const response = orderDraftResponse(true);
    const client = createRpcClient({ data: response, error: null });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).resolves.toMatchObject({
      orderDraft: {
        orderId: "order_11111111-1111-4111-8111-111111111111",
        replayed: true,
      },
    });
  });

  it("maps idempotency conflicts to a domain conflict error", async () => {
    const client = createRpcClient({
      data: null,
      error: {
        code: "23505",
        message: "commerce_order_draft_idempotency_conflict",
      },
    });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).rejects.toBeInstanceOf(CommerceOrderDraftConflictError);
  });

  it("supersedes a stale pre-payment draft on conflict and retries create once", async () => {
    const request = orderDraftRequest();
    const response = orderDraftResponse(false);
    const createResults = [
      { data: null, error: { code: "23505", message: "commerce_order_draft_idempotency_conflict" } },
      { data: response, error: null },
    ];
    const rpc = vi.fn(
      (functionName: string) => {
        if (functionName === ORDER_DRAFT_SUPERSEDE_RPC_NAME) {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve(createResults.shift());
      },
    );
    const client = { rpc } as unknown as CommerceOrderDraftRpcClient;

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(request),
    ).resolves.toEqual(response);

    expect(rpc).toHaveBeenCalledWith(ORDER_DRAFT_SUPERSEDE_RPC_NAME, {
      p_idempotency_key: request.idempotencyKey,
    });
    // create attempted twice (initial conflict + post-supersede retry).
    const createCalls = rpc.mock.calls.filter(([fn]) => fn === ORDER_DRAFT_RPC_NAME);
    expect(createCalls).toHaveLength(2);
  });

  it("keeps the conflict when supersede reports nothing to supersede", async () => {
    const request = orderDraftRequest();
    const rpc = vi.fn((functionName: string) => {
      if (functionName === ORDER_DRAFT_SUPERSEDE_RPC_NAME) {
        return Promise.resolve({ data: false, error: null });
      }
      return Promise.resolve({
        data: null,
        error: { code: "23505", message: "commerce_order_draft_idempotency_conflict" },
      });
    });
    const client = { rpc } as unknown as CommerceOrderDraftRpcClient;

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(request),
    ).rejects.toBeInstanceOf(CommerceOrderDraftConflictError);

    // create attempted only ONCE (no retry when nothing was superseded).
    const createCalls = rpc.mock.calls.filter(([fn]) => fn === ORDER_DRAFT_RPC_NAME);
    expect(createCalls).toHaveLength(1);
  });

  it.each(["commerce_order_draft_catalog_head_moved", "commerce_order_draft_catalog_anchor_missing", "commerce_order_draft_offer_membership_refused"])(
    "maps atomic catalog refusal %s to conflict without superseding a draft", async (message) => {
      const client = createRpcClient({ data: null, error: { code: "40001", message } });
      await expect(createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()))
        .rejects.toMatchObject({ name: CommerceOrderDraftConflictError.name, details: { reason: message } });
      expect(client.rpc).toHaveBeenCalledTimes(1);
      expect(client.rpc).not.toHaveBeenCalledWith(ORDER_DRAFT_SUPERSEDE_RPC_NAME, expect.anything());
    });

  it("maps other RPC failures to persistence errors", async () => {
    const client = createRpcClient({
      data: null,
      error: {
        code: "PGRST202",
        message: "function not found",
      },
    });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).rejects.toBeInstanceOf(CommerceOrderDraftPersistenceError);
  });

  it.each([
    "promotion_code_global_limit_reached",
    "promotion_code_customer_limit_reached",
    "promotion_code_not_active",
    "promotion_code_definition_changed",
  ])("maps atomic claim failure %s to price changed", async (message) => {
    const client = createRpcClient({ data: null, error: { code: "40001", message } });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).rejects.toMatchObject({
      name: CommerceOrderDraftPriceChangedError.name,
      details: { reason: "promotion_code_unavailable" },
    });
  });

  // ⛔ These three are NOT price changes. A re-quote cannot clear the buyer's own
  // reserved claim, an unclaimable order, or a missing client, so classifying any
  // of them as `price_changed` would put checkout into a silent re-quote loop.
  it.each([
    "promotion_code_claim_owner_conflict",
    "promotion_code_order_not_claimable",
    "promotion_code_client_required",
  ])("keeps atomic claim failure %s out of the price-changed class", async (message) => {
    const client = createRpcClient({ data: null, error: { code: "40001", message } });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).rejects.toBeInstanceOf(CommerceOrderDraftPersistenceError);
  });

  // These SQLSTATE 22023 refusals compare one INSERT's snapshot against its
  // frozen columns and minimum payable amount. Re-quoting cannot repair them.
  it.each([
    "promotion_code_snapshot_money_mismatch",
    "promotion_code_product_floor_breached",
  ])("keeps invariant failure %s out of the price-changed class", async (message) => {
    const client = createRpcClient({ data: null, error: { code: "22023", message } });
    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).rejects.toBeInstanceOf(CommerceOrderDraftPersistenceError);
  });

  it("rejects malformed RPC responses before returning them to the handler", async () => {
    const client = createRpcClient({
      data: { contractVersion: "commerce.v0", orderDraft: {} },
      error: null,
    });

    await expect(
      createSupabaseCommerceOrderDraftPort(client).createOrderDraft(orderDraftRequest()),
    ).rejects.toBeInstanceOf(CommerceOrderDraftInvalidResponseError);
  });
});

function createRpcClient(
  result: Awaited<ReturnType<CommerceOrderDraftRpcClient["rpc"]>>,
): CommerceOrderDraftRpcClient {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  };
}

function orderDraftRequest(): CreateOrderDraftRequest {
  return {
    idempotencyKey: "quote-1999-06-01-item-a",
    quoteSnapshot: quoteResponse(),
  };
}

function orderDraftResponse(replayed: boolean): CreateOrderDraftResponse {
  return {
    contractVersion: "commerce.v0",
    orderDraft: {
      orderId: "order_11111111-1111-4111-8111-111111111111",
      status: "draft",
      paymentStatus: "not_started",
      idempotencyKey: "quote-1999-06-01-item-a",
      quoteSnapshot: quoteResponse(),
      replayed,
    },
  };
}

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "XTS",
      taxIncluded: true,
      lines: [
        {
          sku: "ITEM-A",
          productSlug: "item-a",
          quantity: 1,
          unitPriceGross: { amountMinor: 1490, currency: "XTS" },
          lineSubtotalGross: { amountMinor: 1490, currency: "XTS" },
          tax: {
            included: true,
            country: "AA",
            category: "standard",
            vatRateBps: 800,
            legalBasis: "synthetic",
            netAmount: { amountMinor: 1380, currency: "XTS" },
            vatAmount: { amountMinor: 110, currency: "XTS" },
            grossAmount: { amountMinor: 1490, currency: "XTS" },
          },
        },
      ],
      discounts: [],
      subtotalGross: { amountMinor: 1490, currency: "XTS" },
      discountTotalGross: { amountMinor: 0, currency: "XTS" },
      totalGross: { amountMinor: 1490, currency: "XTS" },
      netTotal: { amountMinor: 1380, currency: "XTS" },
      taxTotal: { amountMinor: 110, currency: "XTS" },
    },
  };
}

it.each(["false", "error", "throw"])("preserves the original conflict when supersede returns %s", async outcome => {
  const rpc = vi.fn(async (name: string) => {
    if (name === ORDER_DRAFT_SUPERSEDE_RPC_NAME) {
      if (outcome === "throw") throw new Error("transport");
      return { data: false, error: outcome === "error" ? { code: "XX000" } : null };
    }
    return { data: null, error: { code: "23505", message: "commerce_order_draft_idempotency_conflict" } };
  });
  await expect(createSupabaseCommerceOrderDraftPort({ rpc }).createOrderDraft(orderDraftRequest())).rejects.toBeInstanceOf(CommerceOrderDraftConflictError);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([ORDER_DRAFT_RPC_NAME, ORDER_DRAFT_SUPERSEDE_RPC_NAME]);
});
it("does not supersede again when the single retry conflicts", async () => {
  const rpc = vi.fn(async (name: string) => name === ORDER_DRAFT_SUPERSEDE_RPC_NAME
    ? { data: true, error: null }
    : { data: null, error: { code: "23505", message: "commerce_order_draft_idempotency_conflict" } });
  await expect(createSupabaseCommerceOrderDraftPort({ rpc }).createOrderDraft(orderDraftRequest())).rejects.toBeInstanceOf(CommerceOrderDraftConflictError);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([ORDER_DRAFT_RPC_NAME, ORDER_DRAFT_SUPERSEDE_RPC_NAME, ORDER_DRAFT_RPC_NAME]);
});
