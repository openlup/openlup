import { describe, expect, it } from "vitest";
import {
  COMMERCE_CONTRACT_VERSION,
} from "./types.js";
import {
  createCartRequestSchema,
  createCartResponseSchema,
  createCheckoutResponseSchema,
  createOrderDraftRequestSchema,
  createOrderDraftResponseSchema,
  createQuoteRequestSchema,
  createQuoteResponseSchema,
  orderReadResponseSchema,
  paymentStatusReadResponseSchema,
} from "./contracts.js";

const line = {
  sku: "OPENLUP-DOG-LAMB-CAN-400G",
  quantity: 2,
};

describe("commerce contracts", () => {
  it("validates a cart creation request", () => {
    expect(
      createCartRequestSchema.parse({
        lines: [line],
        locale: "pl",
      }),
    ).toEqual({
      lines: [line],
      locale: "pl",
    });
  });

  it("treats SKU as an opaque commerce identifier", () => {
    const request = createCartRequestSchema.parse({
      lines: [{ sku: "opaque:venison_launch.v2", quantity: 1 }],
      locale: "pl",
    });

    expect(request.lines[0].sku).toBe("opaque:venison_launch.v2");
  });

  it("rejects unsupported SKU and quantity shapes", () => {
    expect(
      createCartRequestSchema.safeParse({
        lines: [{ sku: "lamb", quantity: 0 }],
      }).success,
    ).toBe(false);
  });

  it("validates VAT-inclusive quote requests and responses", () => {
    const request = createQuoteRequestSchema.parse({
      lines: [line],
      locale: "pl",
    });
    const response = quoteResponse();

    expect(request).toEqual({ mode: "one_time", lines: [line], promoCodes: [], locale: "pl" });
    expect(createQuoteResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts only UI-safe, additive promotion rejection details", () => {
    const base = quoteResponse();
    const response = { ...base, quote: { ...base.quote, codeRejectionDetails: [{
      code: "SCOPE80",
      reason: "scope_not_applicable",
      allowedScopes: ["one_time"],
    }] } };
    expect(createQuoteResponseSchema.parse(response)).toEqual(response);

    const malformed = { ...base, quote: { ...base.quote, codeRejectionDetails: [{
      code: "SCOPE80",
      reason: "scope_not_applicable",
      allowedScopes: [],
    }] } };
    expect(createQuoteResponseSchema.safeParse(malformed).success).toBe(false);
  });

  it("validates hidden quote context for subscription recommendations", () => {
    const request = createQuoteRequestSchema.parse({
      mode: "subscription",
      lines: [
        {
          sku: "opaque:lamb-launch.v1",
          quantity: 7,
          variantId: "variant-lamb-400",
          modeAtLine: "subscription",
        },
      ],
      sizeConstraint: {
        kind: "feeding_days",
        value: 21,
        petId: "pet-rex",
        dailyKcalOverride: 328,
      },
      cadenceDays: 21,
      promoCodes: ["launch"],
      petId: "pet-rex",
      petProfileContext: {
        petId: "pet-rex",
        ageBand: "adult",
        weightKg: 12,
        activityLevel: "normal",
        bcs: "ideal",
        allergenSlugs: ["chicken"],
        dailyKcalOverride: 328,
      },
      locale: "pl",
    });

    expect(request).toMatchObject({
      mode: "subscription",
      cadenceDays: 21,
      promoCodes: ["launch"],
      petId: "pet-rex",
    });
  });

  it("requires cadence and daily kcal for subscription feeding-day quotes", () => {
    expect(
      createQuoteRequestSchema.safeParse({
        mode: "subscription",
        lines: [line],
        sizeConstraint: { kind: "feeding_days", value: 21 },
      }).success,
    ).toBe(false);
  });

  it("rejects quote totals that do not match their line-level VAT math", () => {
    const response = quoteResponse();
    response.quote.totalGross.amountMinor = 1489;

    expect(createQuoteResponseSchema.safeParse(response).success).toBe(false);
  });

  it("validates draft cart responses without pricing side effects", () => {
    const response = {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      cart: {
        id: "cart_wave-9",
        status: "draft",
        lines: [line],
        currency: "PLN",
      },
    };

    expect(createCartResponseSchema.parse(response)).toEqual(response);
  });

  it("validates hidden order draft snapshots", () => {
    const request = {
      idempotencyKey: "quote-2026-06-01-lamb",
      quoteSnapshot: quoteResponse(),
    };
    const response = {
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

    expect(createOrderDraftRequestSchema.parse(request)).toEqual(request);
    expect(createOrderDraftResponseSchema.parse(response)).toEqual(response);
  });

  it("keeps public promotion acceptance tokens out of canonical order snapshots", () => {
    const publicQuote = { ...quoteResponse(), promotionAcceptanceToken: "opaque.signed-token" };
    expect(createQuoteResponseSchema.safeParse(publicQuote).success).toBe(false);
    expect(createOrderDraftRequestSchema.safeParse({
      idempotencyKey: "invalid-key",
      quoteSnapshot: publicQuote,
    }).success).toBe(false);
  });

  it("rejects order draft requests with malformed idempotency keys or quote snapshots", () => {
    expect(
      createOrderDraftRequestSchema.safeParse({
        idempotencyKey: "bad key",
        quoteSnapshot: quoteResponse(),
      }).success,
    ).toBe(false);

    expect(
      createOrderDraftRequestSchema.safeParse({
        idempotencyKey: "quote-2026-06-01-lamb",
        quoteSnapshot: { contractVersion: COMMERCE_CONTRACT_VERSION, quote: {} },
      }).success,
    ).toBe(false);
  });

  it("allows a not-configured checkout placeholder only without provider fields", () => {
    const response = {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      checkout: {
        id: "checkout_wave-9",
        cartId: "cart_wave-9",
        status: "not_configured",
        redirectUrl: null,
        paymentProviderSessionId: null,
      },
    };

    expect(createCheckoutResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects inconsistent checkout placeholders", () => {
    const response = {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      checkout: {
        id: "checkout_wave-9",
        cartId: "cart_wave-9",
        status: "not_configured",
        redirectUrl: "https://checkout.example.test/session",
        paymentProviderSessionId: null,
      },
    };

    expect(createCheckoutResponseSchema.safeParse(response).success).toBe(false);
  });

  it("validates order and payment read placeholders", () => {
    expect(
      orderReadResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        order: {
          id: "order_wave-9",
          status: "pending_payment",
          paymentStatus: "not_started",
          total: null,
          lines: [line],
        },
      }),
    ).toMatchObject({
      order: {
        id: "order_wave-9",
      },
    });

    expect(
      paymentStatusReadResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        payment: {
          id: "payment_wave-9",
          orderId: "order_wave-9",
          status: "not_started",
          amount: null,
          providerReference: null,
        },
      }),
    ).toMatchObject({
      payment: {
        id: "payment_wave-9",
      },
    });
  });
});

function quoteResponse() {
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
