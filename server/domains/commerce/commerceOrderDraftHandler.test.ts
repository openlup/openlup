import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  CommerceNotEnabledError,
  CommerceOrderDraftConflictError,
  CommerceOrderDraftInvalidResponseError,
  CommerceOrderDraftPriceChangedError,
  CommerceQuoteSnapshotError,
  type CommerceOrderDraftWritePort,
  type CommerceQuoteSnapshotVerifierPort,
} from "../../../src/domains/commerce/ports.js";
import { createCommerceOrderDraftHandler } from "./commerceOrderDraftHandler.js";

describe("commerce order draft BFF handler", () => {
  it("returns hidden order draft responses through the shared envelope", async () => {
    const res = createResponse();
    const port = createPort();
    const verifier = createVerifier();
    const body = orderDraftRequest();

    await createCommerceOrderDraftHandler({
      orderDraftPort: port,
      quoteSnapshotVerifier: verifier,
    })(
      request("POST", body),
      res,
    );

    expect(verifier.verifyQuoteSnapshot).toHaveBeenCalledWith(body.quoteSnapshot);
    expect(port.createOrderDraft).toHaveBeenCalledWith(body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: orderDraftResponse(),
      meta: { contractVersion: COMMERCE_CONTRACT_VERSION },
    });
  });

  it("does not let a request-body clientId reach the order draft (anonymous route stays NULL)", async () => {
    const res = createResponse();
    const port = createPort();
    const verifier = createVerifier();
    // An unauthenticated caller tries to attribute the order to someone else.
    const body = { ...orderDraftRequest(), clientId: "11111111-2222-4333-8444-555555555555" };

    await createCommerceOrderDraftHandler({
      orderDraftPort: port,
      quoteSnapshotVerifier: verifier,
    })(request("POST", body), res);

    expect(res.status).toHaveBeenCalledWith(200);
    // clientId is stripped by the request schema; the port is called with NO
    // options arg, so the producer RPC defaults client_id to NULL.
    const call = vi.mocked(port.createOrderDraft).mock.calls[0];
    expect(call[0]).not.toHaveProperty("clientId");
    expect(call[1]).toBeUndefined();
  });

  it("persists the server-authoritative enriched snapshot and returns only its public projection", async () => {
    const res = createResponse();
    const body = orderDraftRequest();
    const enriched = quoteResponse();
    enriched.quote.lines[0]!.catalogFacts = catalogFacts(enriched.quote.currency);
    const draft = orderDraftResponse();
    draft.orderDraft.quoteSnapshot = enriched;
    const port = createPort(draft);
    const verifier: CommerceQuoteSnapshotVerifierPort = {
      verifyQuoteSnapshot: vi.fn().mockResolvedValue(enriched),
    };

    await createCommerceOrderDraftHandler({ orderDraftPort: port, quoteSnapshotVerifier: verifier })(
      request("POST", body), res,
    );

    expect(port.createOrderDraft).toHaveBeenCalledWith({ ...body, quoteSnapshot: enriched });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        orderDraft: expect.objectContaining({
          quoteSnapshot: expect.objectContaining({
            quote: expect.objectContaining({
              lines: [expect.not.objectContaining({ catalogFacts: expect.anything() })],
            }),
          }),
        }),
      }),
    }));
  });

  it("rejects unsupported methods and invalid order draft requests", async () => {
    const method = createResponse();
    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(),
      quoteSnapshotVerifier: createVerifier(),
    })(
      request("GET"),
      method,
    );

    const invalid = createResponse();
    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(),
      quoteSnapshotVerifier: createVerifier(),
    })(
      request("POST", { idempotencyKey: "bad key", quoteSnapshot: {} }),
      invalid,
    );

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(invalid.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "BAD_REQUEST" }),
      }),
    );
  });

  it("maps the default disabled persistence port to a clear BFF error", async () => {
    const res = createResponse();

    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(new CommerceNotEnabledError("order draft")),
      quoteSnapshotVerifier: createVerifier(),
    })(request("POST", orderDraftRequest()), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          message: "Commerce order draft persistence is not configured",
          details: {
            feature: "order_draft",
            requiredBoundary: "commerce_create_order_draft_with_outbox",
          },
        }),
      }),
    );
  });

  it("rejects stale or tampered quote snapshots before the write port", async () => {
    const res = createResponse();
    const port = createPort();

    await createCommerceOrderDraftHandler({
      orderDraftPort: port,
      quoteSnapshotVerifier: createVerifier(
        new CommerceQuoteSnapshotError(
          "QUOTE_SNAPSHOT_MISMATCH",
          "Commerce quote snapshot does not match current catalog pricing",
          { reason: "snapshot_does_not_match_static_quote" },
        ),
      ),
    })(request("POST", orderDraftRequest()), res);

    expect(port.createOrderDraft).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "BAD_REQUEST",
          details: {
            code: "QUOTE_SNAPSHOT_MISMATCH",
            reason: "snapshot_does_not_match_static_quote",
          },
        }),
      }),
    );
  });

  it("maps order draft idempotency conflicts to the shared conflict envelope", async () => {
    const res = createResponse();

    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(
        new CommerceOrderDraftConflictError("Commerce order draft idempotency conflict", {
          boundary: "commerce_create_order_draft_with_outbox",
        }),
      ),
      quoteSnapshotVerifier: createVerifier(),
    })(request("POST", orderDraftRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          message: "Commerce order draft idempotency conflict",
          details: {
            boundary: "commerce_create_order_draft_with_outbox",
          },
        }),
      }),
    );
  });

  it("maps an atomic promotion-capacity loss to a retryable conflict", async () => {
    const res = createResponse();

    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(new CommerceOrderDraftPriceChangedError(
        "Commerce order draft promotion changed",
        { reason: "promotion_code_unavailable" },
      )),
      quoteSnapshotVerifier: createVerifier(),
    })(request("POST", orderDraftRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "CONFLICT",
        details: { reason: "promotion_code_unavailable" },
      }),
    }));
  });

  it("maps invalid port responses and unexpected failures safely", async () => {
    const invalid = createResponse();
    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort({ contractVersion: COMMERCE_CONTRACT_VERSION }),
      quoteSnapshotVerifier: createVerifier(),
    })(request("POST", orderDraftRequest()), invalid);

    const invalidRpc = createResponse();
    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(new CommerceOrderDraftInvalidResponseError()),
      quoteSnapshotVerifier: createVerifier(),
    })(request("POST", orderDraftRequest()), invalidRpc);

    const failed = createResponse();
    await createCommerceOrderDraftHandler({
      orderDraftPort: createPort(new Error("order draft unavailable")),
      quoteSnapshotVerifier: createVerifier(),
    })(request("POST", orderDraftRequest()), failed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(invalidRpc.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createPort(result?: unknown): CommerceOrderDraftWritePort {
  return {
    createOrderDraft: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      if (result) return result;
      return orderDraftResponse();
    }),
  };
}

function createVerifier(result?: unknown): CommerceQuoteSnapshotVerifierPort {
  return {
    verifyQuoteSnapshot: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
    }),
  };
}

function orderDraftRequest() {
  return {
    idempotencyKey: "quote-2026-06-01-lamb",
    quoteSnapshot: quoteResponse(),
  };
}

function orderDraftResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    orderDraft: {
      orderId: "order_wave-3",
      status: "draft",
      paymentStatus: "not_started",
      idempotencyKey: "quote-2026-06-01-lamb",
      quoteSnapshot: quoteResponse(),
      replayed: false,
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

function catalogFacts(currency: CreateQuoteResponse["quote"]["currency"]) {
  return {
    version: "catalog_facts_v1" as const,
    skuId: "11111111-1111-4111-8111-111111111111",
    documentRevisionId: "22222222-2222-4222-8222-222222222222",
    documentDigest: "a".repeat(64),
    resolvedPriceEntryId: "resolved-entry",
    basePriceEntryId: "base-entry",
    mode: "one_time" as const,
    atTime: "2026-06-05T10:00:00.000Z",
    currency,
    resolvedUnitAmountMinor: 1490,
    resolvedLineAmountMinor: 1490,
    baseUnitAmountMinor: 1490,
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
