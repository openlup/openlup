import { vi } from "vitest";
import type { StartHiddenCheckoutRuntimeRequest } from "../../../src/domains/commerce/runtimeContracts.js";

export function makeOrderPort() {
  return {
    finalizeOrderForCheckout: vi.fn().mockResolvedValue({
      orderId: "11111111-1111-4111-8111-111111111111",
      orderRef: "order_wave-a",
      mode: "one_time" as const,
      clientId: "22222222-2222-4222-8222-222222222222",
      petId: null,
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      subscriptionId: null,
      subscriptionCycleId: null,
      total: { amountMinor: 4990, currency: "PLN" },
      items: [
        {
          orderItemId: "44444444-4444-4444-8444-444444444444",
          skuId: "66666666-6666-4666-8666-666666666666",
          sku: "CORE-SKU-A",
          quantity: 1,
        },
      ],
      replayed: false,
    }),
  };
}

export function makeInventoryPort() {
  return {
    reserveOrderItems: vi.fn().mockResolvedValue([
      {
        reservationId: "77777777-7777-4777-8777-777777777777",
        reservationIds: ["77777777-7777-4777-8777-777777777777"],
        orderItemId: "44444444-4444-4444-8444-444444444444",
        skuId: "66666666-6666-4666-8666-666666666666",
        sku: "CORE-SKU-A",
        status: "reserved" as const,
        replayed: false,
      },
    ]),
    releaseOrderReservations: vi.fn(),
  };
}

export function makePaymentPort() {
  return {
    createIntent: vi.fn().mockResolvedValue({
      paymentIntentId: "88888888-8888-4888-8888-888888888888",
      paymentId: "99999999-9999-4999-8999-999999999999",
      status: "created" as const,
      replayed: false,
    }),
    recordAttempt: vi.fn().mockResolvedValue({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "processing" as const,
      replayed: false,
    }),
    prepareProviderAttempt: vi.fn().mockResolvedValue({
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      status: "created" as const,
      replayed: false,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    }),
    finalizeProviderAttempt: vi.fn(async (input) => ({
      paymentAttemptId: input.paymentAttemptId,
      status: input.attemptStatus,
      replayed: false,
      providerAttemptId: input.providerAttemptId,
      providerSessionId: input.providerSessionId,
      nextActionKind: input.nextActionKind,
    })),
    applyResult: vi.fn(),
  };
}

export function makeReadinessPort() {
  return {
    evaluateOrderReadiness: vi.fn().mockResolvedValue({
      omsEligibility: { allowed: false as const, reason: "order_not_paid" as const },
      fulfillmentCreate: {
        allowed: false as const,
        reason: "order_not_paid",
        omsReason: "order_not_paid" as const,
      },
    }),
  };
}

export function orderDraftSummary(): StartHiddenCheckoutRuntimeRequest["orderDraft"] {
  return {
    orderId: "order_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "draft" as const,
    paymentStatus: "not_started" as const,
    idempotencyKey: "order-draft-wave1",
    replayed: false,
    quoteSnapshot: {
      contractVersion: "commerce.v0",
      quote: {
        currency: "PLN" as const,
        taxIncluded: true,
        lines: [
          {
            sku: "CORE-SKU-TEST",
            productSlug: "beef",
            quantity: 1,
            unitPriceGross: { amountMinor: 1490, currency: "PLN" as const },
            lineSubtotalGross: { amountMinor: 1490, currency: "PLN" as const },
            tax: {
              included: true,
              country: "PL" as const,
              category: "pet_food" as const,
              vatRateBps: 800,
              legalBasis: "PL VAT Annex 3 item 10c",
              netAmount: { amountMinor: 1380, currency: "PLN" as const },
              vatAmount: { amountMinor: 110, currency: "PLN" as const },
              grossAmount: { amountMinor: 1490, currency: "PLN" as const },
            },
          },
        ],
        discounts: [],
        subtotalGross: { amountMinor: 1490, currency: "PLN" as const },
        discountTotalGross: { amountMinor: 0, currency: "PLN" as const },
        totalGross: { amountMinor: 1490, currency: "PLN" as const },
        netTotal: { amountMinor: 1380, currency: "PLN" as const },
        taxTotal: { amountMinor: 110, currency: "PLN" as const },
      },
    },
  };
}
