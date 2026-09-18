import { vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { CONFIGURATOR_INTENT_VERSION } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceCheckoutHandlerDeps } from "./commerceCheckoutHandler.js";

export const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
export const PET_ID = "22222222-2222-4222-8222-222222222222";
export const ADDRESS_ID = "33333333-3333-4333-8333-333333333333";
export const ORDER_ID = "44444444-4444-4444-8444-444444444444";
export const PAYMENT_INTENT_ID = "55555555-5555-4555-8555-555555555555";

export function createPorts(): CommerceCheckoutHandlerDeps {
  return {
    persistencePort: {
      persistIntent: vi.fn().mockResolvedValue({
        contractVersion: "commerce.configurator_intent_persistence.v1",
        intentVersion: CONFIGURATOR_INTENT_VERSION,
        idempotencyKey: "intent-2026-06-05-rex",
        clientId: CLIENT_ID,
        petId: PET_ID,
        addressId: ADDRESS_ID,
        replayed: false,
      }),
    },
    quotePort: {
      createQuote: vi.fn().mockResolvedValue(quoteSnapshot()),
    },
    orderDraftPort: {
      createOrderDraft: vi.fn().mockResolvedValue({
        contractVersion: "commerce.v1",
        orderDraft: {
          orderId: `order_${ORDER_ID}`,
          status: "draft",
          paymentStatus: "not_started",
          idempotencyKey: "intent-2026-06-05-rex",
          quoteSnapshot: quoteSnapshot(),
          replayed: false,
        },
      }),
    },
    runtimePort: {
      startRuntime: vi.fn().mockResolvedValue({
        contractVersion: "commerce.v1",
        runtime: {
          orderId: ORDER_ID,
          orderRef: `order_${ORDER_ID}`,
          payment: { paymentIntentId: PAYMENT_INTENT_ID },
        },
      }),
      applyPaymentResult: vi.fn().mockResolvedValue({ contractVersion: "commerce.v1" }),
    },
    compensationPort: {
      releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }),
      cancelUnstartedPromotionOrder: vi.fn().mockResolvedValue({ cancelled: false }),
      cancelAbandonedOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    },
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    rateLimitMessage: vi.fn().mockReturnValue("rate limited"),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  } as unknown as CommerceCheckoutHandlerDeps;
}

export function quoteSnapshot(
  totalGross: CreateQuoteResponse["quote"]["totalGross"] = { amountMinor: 1490, currency: "PLN" },
): CreateQuoteResponse {
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
          unitPriceGross: totalGross,
          lineSubtotalGross: totalGross,
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: Math.round((totalGross.amountMinor * 100) / 108), currency: "PLN" },
            vatAmount: {
              amountMinor:
                totalGross.amountMinor - Math.round((totalGross.amountMinor * 100) / 108),
              currency: "PLN",
            },
            grossAmount: totalGross,
          },
        },
      ],
      discounts: [],
      subtotalGross: totalGross,
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross,
      netTotal: { amountMinor: Math.round((totalGross.amountMinor * 100) / 108), currency: "PLN" },
      taxTotal: {
        amountMinor: totalGross.amountMinor - Math.round((totalGross.amountMinor * 100) / 108),
        currency: "PLN",
      },
    },
  };
}

export function intent(mode: "one_time" | "subscription" = "one_time"): ConfiguratorIntent {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    locale: "pl",
    mode,
    cadenceDays: mode === "subscription" ? 21 : null,
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 },
    petProfile: {
      name: "Rex",
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: ["chicken"],
      dailyKcalOverride: 328,
    },
    contact: {
      firstName: "Anna",
      lastName: "Kowalska",
      email: "anna@example.com",
      phone: "+48123456789",
    },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: {
      kind: "courier",
      deliveryKind: "courier",
      providerKind: "dhl",
      providerRef: null,
      carrierKind: "dhl",
      carrierCode: "DHL",
      service: "dhl_courier_standard",
      serviceCode: "dhl_courier_standard",
      pickupPoint: null,
    },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [
      { variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 14 },
    ],
    promoCodes: [],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: mode === "subscription" },
    consciousAllergenOverride: false,
  };
}

export function request(method: string, body?: unknown, headers: Record<string, string> = {}): VercelRequest {
  return { method, body, query: {}, headers } as unknown as VercelRequest;
}

export function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
