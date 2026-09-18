import { describe, expect, it, vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type {
  CreateOrderDraftRequest,
  CreateOrderDraftResponse,
  CreateQuoteResponse,
} from "../../../src/domains/commerce/contracts.js";
import {
  CommerceOrderDraftConflictError,
  CommerceOrderDraftInvalidResponseError,
  CommerceOrderDraftPriceChangedError,
  CommerceOrderDraftPersistenceError,
} from "../../../src/domains/commerce/ports.js";
import {
  createOrderDraftRpcArgs,
  ORDER_DRAFT_RPC_NAME,
} from "../../domains/commerce/orderDraftRpcPayload.js";
import {
  createSupabaseCommerceOrderDraftPort,
  ORDER_DRAFT_SUPERSEDE_RPC_NAME,
  type CommerceOrderDraftRpcClient,
} from "./commerceOrderDraft.js";

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
      data: { contractVersion: COMMERCE_CONTRACT_VERSION, orderDraft: {} },
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
    idempotencyKey: "quote-2026-06-01-lamb",
    quoteSnapshot: quoteResponse(),
  };
}

function orderDraftResponse(replayed: boolean): CreateOrderDraftResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orderDraft: {
      orderId: "order_11111111-1111-4111-8111-111111111111",
      status: "draft",
      paymentStatus: "not_started",
      idempotencyKey: "quote-2026-06-01-lamb",
      quoteSnapshot: quoteResponse(),
      replayed,
    },
  };
}

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          productSlug: "lamb",
          quantity: 1,
          unitPriceGross: { amountMinor: 1490, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 1490, currency: "PLN" },
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: 1380, currency: "PLN" },
            vatAmount: { amountMinor: 110, currency: "PLN" },
            grossAmount: { amountMinor: 1490, currency: "PLN" },
          },
        },
      ],
      discounts: [],
      subtotalGross: { amountMinor: 1490, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: 1490, currency: "PLN" },
      netTotal: { amountMinor: 1380, currency: "PLN" },
      taxTotal: { amountMinor: 110, currency: "PLN" },
    },
  };
}
