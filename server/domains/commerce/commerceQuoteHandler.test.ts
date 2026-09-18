import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import {
  CommercePricingPolicyRequestError,
  CommercePricingPolicyUnavailableError,
} from "./commercePricingPolicy.js";
import { CommerceQuoteCatalogReadError } from "./commerceQuoteCatalogReadPort.js";
import { createCommerceQuoteHandler } from "./commerceQuoteHandler.js";

describe("commerce quote BFF handler", () => {
  it("returns hidden VAT-inclusive quotes through the shared envelope", async () => {
    const res = createResponse();
    const port = createPort();

    await createCommerceQuoteHandler({ quotePort: port })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      res,
    );

    expect(port.createQuote).toHaveBeenCalledWith(
      {
        mode: "one_time",
        lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }],
        promoCodes: [],
      },
      { clientId: null },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quote: quote(),
      },
      meta: { contractVersion: COMMERCE_CONTRACT_VERSION },
    });
  });

  it("rejects unsupported methods and invalid request bodies", async () => {
    const method = createResponse();
    await createCommerceQuoteHandler({ quotePort: createPort() })(
      request("GET"),
      method,
    );

    const invalid = createResponse();
    await createCommerceQuoteHandler({ quotePort: createPort() })(
      request("POST", { lines: [{ sku: "lamb", quantity: 0 }] }),
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

  it("maps unknown SKU and invalid port responses", async () => {
    const unknown = createResponse();
    await createCommerceQuoteHandler({
      quotePort: createPort(
        new CommerceQuoteError("UNKNOWN_SKU", "Unknown commerce SKU", {
          sku: "OPENLUP-DOG-DUCK-CAN-400G",
        }),
      ),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-DUCK-CAN-400G", quantity: 1 }] }),
      unknown,
    );

    const invalid = createResponse();
    await createCommerceQuoteHandler({
      quotePort: createPort({ contractVersion: COMMERCE_CONTRACT_VERSION, quote: {} }),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      invalid,
    );

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

  it("fails closed when a faulty quote port returns server-only catalog facts", async () => {
    const res = createResponse();
    const base = quote();
    const enriched = {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      quote: {
        ...base,
        lines: [{ ...base.lines[0]!, catalogFacts: catalogFacts(base.currency) }],
      },
    };

    await createCommerceQuoteHandler({ quotePort: createPort(enriched) })(
      request("POST", { lines: [{ sku: base.lines[0]!.sku, quantity: 1 }] }),
      res,
    );

    const payload = vi.mocked(res.json).mock.calls[0]?.[0];
    expect(res.status).toHaveBeenCalledWith(502);
    expect(payload).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: "INVALID_RESPONSE" }),
    }));
    expect(JSON.stringify(payload)).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(payload)).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(payload)).not.toContain("a".repeat(64));
  });

  it("maps unexpected quote port failures to upstream unavailable", async () => {
    const res = createResponse();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const providerError = Object.assign(new Error("database rejected service-role-token"), {
      code: "42501",
      token: "service-role-token",
    });

    await createCommerceQuoteHandler({
      quotePort: createPort(providerError),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: { reason: "quote_dependency_failed", stage: "quote_evaluation" },
      }),
    }));
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("quote_evaluation");
    expect(logged).not.toContain("service-role-token");
    errorSpy.mockRestore();
  });

  it("maps strict catalog failures to a bounded named refusal", async () => {
    const res = createResponse();
    await createCommerceQuoteHandler({
      quotePort: createPort(new CommerceQuoteCatalogReadError("catalog_document_digest_mismatch")),
    })(
      request("POST", { lines: [{ sku: quote().lines[0].sku, quantity: 1 }] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: {
          reason: "catalog_unavailable",
          refusalCode: "catalog_document_digest_mismatch",
        },
      }),
    }));
  });

  it("reports a closed-set pricing-policy diagnostic without the underlying error", async () => {
    const res = createResponse();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createCommerceQuoteHandler({
      quotePort: createPort(),
      resolvePricingPolicy: vi.fn().mockRejectedValue(
        new CommercePricingPolicyUnavailableError("v2_readiness_not_ready"),
      ),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: {
          reason: "pricing_policy_unavailable",
          stage: "pricing_policy",
          policyReason: "v2_readiness_not_ready",
        },
      }),
    }));
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("commerce_pricing_policy_v2_unavailable");
    errorSpy.mockRestore();
  });

  it("answers a caller-side offer-policy gap with 400, never a 503 outage signal", async () => {
    const res = createResponse();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createCommerceQuoteHandler({
      quotePort: createPort(),
      resolvePricingPolicy: vi.fn().mockRejectedValue(
        new CommercePricingPolicyRequestError("v2_visitor_id_required"),
      ),
    })(
      request("POST", { lines: [{ sku: "sku-under-test", quantity: 1 }] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        details: {
          reason: "pricing_policy_request_invalid",
          stage: "pricing_policy",
          policyReason: "v2_visitor_id_required",
        },
      }),
    }));
    expect(JSON.stringify(errorSpy.mock.calls))
      .not.toContain("commerce_pricing_policy_v2_request_invalid");
    errorSpy.mockRestore();
  });

  it("reports a missing pricing-policy signing secret without exposing its value", async () => {
    const res = createResponse();

    await createCommerceQuoteHandler({
      quotePort: createPort(),
      resolvePricingPolicy: vi.fn().mockRejectedValue(
        new CommercePricingPolicyUnavailableError("signing_secret_unavailable"),
      ),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        details: {
          reason: "pricing_policy_unavailable",
          stage: "pricing_policy",
          policyReason: "signing_secret_unavailable",
        },
      }),
    }));
  });

  it("does not expose an unrecognised pricing-policy reason", async () => {
    const res = createResponse();

    await createCommerceQuoteHandler({
      quotePort: createPort(),
      resolvePricingPolicy: vi.fn().mockRejectedValue(
        new CommercePricingPolicyUnavailableError("secret-policy-reason"),
      ),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      res,
    );

    const payload = vi.mocked(res.json).mock.calls[0]?.[0] as { error?: { details?: unknown } };
    expect(payload.error?.details).toEqual({
      reason: "pricing_policy_unavailable",
      stage: "pricing_policy",
      policyReason: "other",
    });
    expect(JSON.stringify(payload)).not.toContain("secret-policy-reason");
  });

  it("keeps non-SKU CommerceQuoteError failures as conflicts", async () => {
    const res = createResponse();

    await createCommerceQuoteHandler({
      quotePort: createPort(new CommerceQuoteError("PRICE_NOT_CONFIGURED", "Commerce price is not configured", {
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
      })),
    })(
      request("POST", { lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "CONFLICT",
        details: { sku: "OPENLUP-DOG-LAMB-CAN-400G" },
      }),
    }));
  });

  it("echoes an honored token without extending it", async () => {
    const res = createResponse();
    const honored = vi.fn().mockReturnValue(true);
    await createCommerceQuoteHandler({
      quotePort: createPort(v2Quote()),
      honorPromotionAcceptance: honored,
    })(request("POST", {
      lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }],
      promoCodes: ["SAVE80"],
      promotionAcceptanceToken: "opaque.signed-token",
    }), res);

    expect(honored).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ promotionAcceptanceToken: "opaque.signed-token" }),
    }));
  });

  it("preserves the assigned v2 policy when removing an unverifiable code quote", async () => {
    const res = createResponse();
    const fallbackQuotePort = createPort();
    const pricingPolicy = {
      offerPolicyVersion: "commerce.offer-policy.v2" as const,
      promotionEngineVersion: "promotion-engine.v2" as const,
      pricingPolicyToken: "pp1.this-is-a-long-enough-placeholder-token-for-contracts.signature",
    };
    await createCommerceQuoteHandler({
      quotePort: createPort(v2Quote()),
      fallbackQuotePort,
      honorPromotionAcceptance: vi.fn().mockReturnValue(false),
      resolvePricingPolicy: vi.fn().mockResolvedValue(pricingPolicy),
    })(request("POST", {
      lines: [{ sku: "OPENLUP-DOG-LAMB-CAN-400G", quantity: 1 }],
      promoCodes: ["SAVE80"],
      promotionAcceptanceToken: "opaque.signed-token",
    }), res);

    expect(fallbackQuotePort.createQuote).toHaveBeenCalledTimes(1);
    expect(fallbackQuotePort.createQuote).toHaveBeenCalledWith(
      expect.any(Object),
      { clientId: null, pricingPolicy },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = vi.mocked(res.json).mock.calls[0]?.[0] as {
      data?: { quote?: { discounts?: unknown[] }; promotionAcceptanceToken?: string };
    };
    expect(payload.data?.quote?.discounts).toEqual([]);
    expect(payload.data).not.toHaveProperty("promotionAcceptanceToken");
  });
});

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createPort(result?: unknown): CommerceQuotePort {
  return {
    createQuote: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      if (result) return result;
      return {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quote: quote(),
      };
    }),
  };
}

function quote() {
  return {
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
  };
}

function v2Quote() {
  const base = quote();
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      ...base,
      discounts: [{
        promotionId: "33333333-3333-4333-8333-333333333333",
        code: "SAVE80",
        appliesTo: "order_total" as const,
        amountOffMinor: 100,
        reasonCode: "promotion_code_v2",
        promotionEngineVersion: "promotion-engine.v2" as const,
        promotionCodeId: "44444444-4444-4444-8444-444444444444",
        promotionCodeRevision: 1,
        promotionDefinitionFingerprint: "a".repeat(64),
        promotionCodeScopes: ["one_time" as const],
        promotionMinimumReferenceMinor: 0,
        promotionCodeValidTo: "2026-07-20T00:00:00.000Z",
        promotionBenefitKind: "target_percentage" as const,
        promotionBenefitValueBps: 8000,
        floorApplied: false,
      }],
      discountTotalGross: { amountMinor: 100, currency: "PLN" },
      totalGross: { amountMinor: 1390, currency: "PLN" },
      netTotal: { amountMinor: 1287, currency: "PLN" },
      taxTotal: { amountMinor: 103, currency: "PLN" },
    },
  };
}

function catalogFacts(currency: string) {
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
