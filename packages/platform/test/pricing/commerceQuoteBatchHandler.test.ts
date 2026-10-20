import "./neutralFixtures.js";
import { describe, expect, it, vi } from "vitest";
import type { HttpRequest as VercelRequest, HttpResponse as VercelResponse } from "../../src/http/index.js";
import { COMMERCE_CONTRACT_VERSION } from "./quoteSchemaFixtures.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "./quoteSchemaFixtures.js";
import { createCommerceQuoteBatchHandler } from "./handlerFixtures.js";
import { CommerceQuoteCatalogReadError } from "./catalogFixtures.js";
import {
  CommercePricingPolicyRequestError,
  CommercePricingPolicyUnavailableError,
} from "../../src/pricing/index.js";
import type { CreateQuoteResponse } from "./quoteSchemaFixtures.js";

const LINE = { sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 };

describe("commerce quote batch BFF handler", () => {
  it("prices every quote in one envelope, preserving request order", async () => {
    const res = createResponse();
    const port = createPort();

    await createCommerceQuoteBatchHandler({ quotePort: port })(
      request("POST", {
        quotes: [
          { lines: [LINE], cadenceDays: 14, mode: "subscription" },
          { lines: [LINE], cadenceDays: 28, mode: "subscription" },
        ],
      }),
      res,
    );

    expect(port.createQuote).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quotes: [quote(), quote()],
      },
      meta: { contractVersion: COMMERCE_CONTRACT_VERSION },
    });
  });

  it("rejects unsupported methods and invalid request bodies", async () => {
    const method = createResponse();
    await createCommerceQuoteBatchHandler({ quotePort: createPort() })(
      request("GET"),
      method,
    );

    const empty = createResponse();
    await createCommerceQuoteBatchHandler({ quotePort: createPort() })(
      request("POST", { quotes: [] }),
      empty,
    );

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(empty.status).toHaveBeenCalledWith(400);
    expect(empty.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "BAD_REQUEST" }),
      }),
    );
  });

  it("fails the whole batch when any quote errors, mapping the domain code", async () => {
    const unknown = createResponse();
    await createCommerceQuoteBatchHandler({
      quotePort: createPort(
        new CommerceQuoteError("UNKNOWN_SKU", "Unknown commerce SKU", {
          sku: "OPENLUP-DOG-DUCK-CAN-400G",
        }),
      ),
    })(request("POST", { quotes: [{ lines: [LINE] }] }), unknown);

    const invalid = createResponse();
    await createCommerceQuoteBatchHandler({
      quotePort: createPort({ contractVersion: COMMERCE_CONTRACT_VERSION, quote: {} }),
    })(request("POST", { quotes: [{ lines: [LINE] }] }), invalid);

    expect(unknown.status).toHaveBeenCalledWith(400);
    expect(unknown.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "BAD_REQUEST",
          details: { sku: "OPENLUP-DOG-DUCK-CAN-400G" },
        }),
      }),
    );
    expect(invalid.status).toHaveBeenCalledWith(502);
  });

  it("fails closed when an injected port returns private catalog facts", async () => {
    const enriched = quote() as CreateQuoteResponse["quote"];
    enriched.lines[0]!.catalogFacts = catalogFacts(enriched.currency);
    const res = createResponse();

    await createCommerceQuoteBatchHandler({ quotePort: createPort({
      contractVersion: COMMERCE_CONTRACT_VERSION, quote: enriched,
    }) })(request("POST", { quotes: [{ lines: [LINE] }] }), res);

    expect(res.status).toHaveBeenCalledWith(502);
    const payload = JSON.stringify(vi.mocked(res.json).mock.calls);
    expect(payload).not.toContain(catalogFacts(enriched.currency).skuId);
    expect(payload).not.toContain(catalogFacts(enriched.currency).documentDigest);
  });

  it("maps unexpected quote port failures to upstream unavailable", async () => {
    const res = createResponse();
    await createCommerceQuoteBatchHandler({
      quotePort: createPort(new Error("quote unavailable")),
    })(request("POST", { quotes: [{ lines: [LINE] }] }), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("fails the whole batch with the strict catalog refusal", async () => {
    const res = createResponse();
    await createCommerceQuoteBatchHandler({
      quotePort: createPort(new CommerceQuoteCatalogReadError("catalog_revision_invalid")),
    })(request("POST", { quotes: [{ lines: [LINE] }, { lines: [LINE] }] }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: { reason: "catalog_unavailable", refusalCode: "catalog_revision_invalid" },
      }),
    }));
  });

  it("publishes why a pricing policy refused instead of a bare batch failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const caller = createResponse();
    await createCommerceQuoteBatchHandler({
      quotePort: createPort(),
      resolvePricingPolicy: vi.fn().mockRejectedValue(
        new CommercePricingPolicyRequestError("v2_visitor_id_required"),
      ),
    })(pricingPolicyBatchRequest(), caller);

    expect(caller.status).toHaveBeenCalledWith(400);
    expect(caller.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        details: {
          reason: "pricing_policy_request_invalid",
          stage: "pricing_policy",
          policyReason: "v2_visitor_id_required",
        },
      }),
    }));

    const origin = createResponse();
    await createCommerceQuoteBatchHandler({
      quotePort: createPort(),
      resolvePricingPolicy: vi.fn().mockRejectedValue(
        new CommercePricingPolicyUnavailableError("v2_readiness_not_ready"),
      ),
    })(pricingPolicyBatchRequest(), origin);

    expect(origin.status).toHaveBeenCalledWith(503);
    expect(origin.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: {
          reason: "pricing_policy_unavailable",
          stage: "pricing_policy",
          policyReason: "v2_readiness_not_ready",
        },
      }),
    }));
    expect(JSON.stringify(errorSpy.mock.calls))
      .not.toContain("commerce_pricing_policy_v2_unavailable");
    errorSpy.mockRestore();
  });
});

function pricingPolicyBatchRequest() {
  return request("POST", { quotes: [{ lines: [LINE] }] });
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createPort(result?: unknown): CommerceQuotePort {
  return {
    createQuote: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      if (result) return result;
      return { contractVersion: COMMERCE_CONTRACT_VERSION, quote: quote() };
    }),
  };
}

function quote() {
  return {
    currency: "XXX",
    taxIncluded: true,
    lines: [
      {
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        productSlug: "lamb",
        quantity: 1,
        unitPriceGross: { amountMinor: 1490, currency: "XXX" },
        lineSubtotalGross: { amountMinor: 1490, currency: "XXX" },
        tax: {
          included: true,
          country: "ZZ",
          category: "pet_food",
          vatRateBps: 800,
          legalBasis: "Example VAT rule",
          netAmount: { amountMinor: 1380, currency: "XXX" },
          vatAmount: { amountMinor: 110, currency: "XXX" },
          grossAmount: { amountMinor: 1490, currency: "XXX" },
        },
      },
    ],
    discounts: [],
    subtotalGross: { amountMinor: 1490, currency: "XXX" },
    discountTotalGross: { amountMinor: 0, currency: "XXX" },
    totalGross: { amountMinor: 1490, currency: "XXX" },
    netTotal: { amountMinor: 1380, currency: "XXX" },
    taxTotal: { amountMinor: 110, currency: "XXX" },
  };
}

function catalogFacts(currency: CreateQuoteResponse["quote"]["currency"]) {
  return {
    version: "catalog_facts_v1" as const,
    skuId: "11111111-1111-4111-8111-111111111111",
    documentRevisionId: "22222222-2222-4222-8222-222222222222",
    documentDigest: "a".repeat(64), resolvedPriceEntryId: "resolved-entry",
    basePriceEntryId: "base-entry", mode: "one_time" as const,
    atTime: "2026-06-05T10:00:00.000Z", currency,
    resolvedUnitAmountMinor: 1490, resolvedLineAmountMinor: 1490,
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
