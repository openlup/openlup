import { describe, expect, it } from "vitest";

import { CHECKOUT_CONTRACT_VERSION } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { CLIENT_ID, ORDER_ID, PAYMENT_INTENT_ID, intent } from "./commerceCheckoutHandler.testFixtures.js";
import { buildCheckoutSuccessResponse, subscriptionResponse } from "./commerceCheckoutHandlerHelpers.js";

describe("commerce checkout handler helpers", () => {
  it("builds one-time and subscription response metadata from checkout kind", () => {
    expect(subscriptionResponse(intent("one_time"), "one_time")).toEqual({
      requested: false,
      cadenceDays: null,
      activationStatus: "not_applicable",
    });
    expect(subscriptionResponse(intent("subscription"), "subscription_initial")).toEqual({
      requested: true,
      cadenceDays: 21,
      activationStatus: "pending_payment_success",
    });
  });

  it("adds status polling details only for async processing checkouts", () => {
    const response = buildCheckoutSuccessResponse({
      orchestrated: {
        orderId: ORDER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId: "33333333-3333-4333-8333-333333333333",
        executionRail: "stripe",
        continuationActionOrigin: "fresh_execution",
        providerClientSecret: null,
        providerPaymentId: null,
        providerRedirectUrl: null,
        providerNextActionKind: null,
        status: "processing",
        quoteSnapshot: quoteResponse(),
      },
      paymentProvider: "hidden_rehearsal",
      checkoutKind: "one_time",
      intent: intent("one_time"),
      clientId: CLIENT_ID,
    });

    expect(response).toEqual(
      expect.objectContaining({
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        orderId: ORDER_ID,
        status: "processing",
        clientId: CLIENT_ID,
        statusUrl:
          `/api/bff/commerce/payment-status?orderId=${ORDER_ID}&paymentIntentId=${PAYMENT_INTENT_ID}&clientId=${CLIENT_ID}`,
      }),
    );
  });

  it("keeps clientId on paid responses so the thank-you page can fetch the recap", () => {
    const response = buildCheckoutSuccessResponse({
      orchestrated: {
        orderId: ORDER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId: "33333333-3333-4333-8333-333333333333",
        executionRail: "hidden_rehearsal",
        continuationActionOrigin: null,
        providerClientSecret: null,
        providerPaymentId: null,
        providerRedirectUrl: null,
        providerNextActionKind: null,
        status: "paid",
        quoteSnapshot: quoteResponse(),
      },
      paymentProvider: "hidden_rehearsal",
      checkoutKind: "one_time",
      intent: intent("one_time"),
      clientId: CLIENT_ID,
    });

    expect(response).toEqual(
      expect.objectContaining({
        orderId: ORDER_ID,
        status: "paid",
        clientId: CLIENT_ID,
      }),
    );
    expect(response).not.toHaveProperty("statusUrl");
  });

  it("strips server catalog provenance from the successful checkout response", () => {
    const enriched = quoteResponse();
    enriched.quote.lines[0]!.catalogFacts = catalogFacts(enriched.quote.currency);
    const response = buildCheckoutSuccessResponse({
      orchestrated: {
        orderId: ORDER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        paymentAttemptId: "33333333-3333-4333-8333-333333333333",
        executionRail: "hidden_rehearsal",
        continuationActionOrigin: null,
        providerClientSecret: null,
        providerPaymentId: null,
        providerRedirectUrl: null,
        providerNextActionKind: null,
        status: "paid",
        quoteSnapshot: enriched,
      },
      paymentProvider: "hidden_rehearsal",
      checkoutKind: "one_time",
      intent: intent("one_time"),
      clientId: CLIENT_ID,
    });

    const authoritativeQuote = response.authoritativeQuote;
    expect(authoritativeQuote).toBeDefined();
    expect(authoritativeQuote!.quote.lines[0]).not.toHaveProperty("catalogFacts");
    expect(authoritativeQuote!.quote).toEqual({
      ...enriched.quote,
      lines: [{ ...enriched.quote.lines[0]!, catalogFacts: undefined }],
    });
  });
});

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "opaque:lamb-launch.v1",
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
