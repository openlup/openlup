import { describe, expect, it, vi } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import {
  CONFIGURATOR_INTENT_VERSION,
  configuratorIntentSchema,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { createOrderDraftSnapshotFromQuoteSnapshot } from "../../../src/domains/commerce/orderDraftSnapshotContracts.js";
import { buildCartRecommendation, type RecommendationVariant } from "../../../src/domains/commerce/recommendationEngine.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice, ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import { createDbBackedCommerceQuotePort } from "./dbBackedCommerceQuotePort.js";
import { createCommerceRuntimeService } from "./commerceRuntimeService.js";
import { TEST_RECOMMENDATION_POLICIES } from "../../../src/lib/testSupport/recommendationPolicyTestSupport.js";
describe("hidden commerce no-op rehearsal", () => {
  it("runs intent -> recommendation -> quote -> order draft snapshot -> runtime -> payment failure release", async () => {
    const intent = configuratorIntentSchema.parse(makeIntent());
    const persisted = {
      clientId: "11111111-1111-4111-8111-111111111111",
      petId: "55555555-5555-4555-8555-555555555555",
      shippingAddressId: "22222222-2222-4222-8222-222222222222",
    };
    const recommendation = buildCartRecommendation({
      petProfile: {
        ageBand: intent.petProfile.ageBand,
        weightKg: intent.petProfile.weightKg,
        activityLevel: intent.petProfile.activityLevel,
        bcs: intent.petProfile.bcs,
        allergenSlugs: intent.petProfile.allergenSlugs,
        dailyKcalOverride: intent.petProfile.dailyKcalOverride,
      },
      variants: recommendationVariants(),
      selectedVariantIds: intent.selectedVariants.map((variant) => variant.variantId),
      desiredSizeKind: intent.sizeConstraint.kind,
      cadenceDays: intent.cadenceDays ?? 21,
    }, TEST_RECOMMENDATION_POLICIES);
    expect(recommendation.ok).toBe(true);
    if (!recommendation.ok) throw new Error("recommendation failed");

    const quotePort = createDbBackedCommerceQuotePort({
      catalogReadPort: createCatalogReadPort(),
      pricingResolverPort: createPricingResolver(),
      now: () => "2026-06-05T10:00:00.000Z",
    });
    const quote = await quotePort.createQuote({
      mode: intent.mode,
      lines: recommendation.value.lines.map((line) => ({
        sku: line.sku,
        variantId: line.variantId,
        quantity: line.qty,
        modeAtLine: intent.mode,
      })),
      sizeConstraint: {
        kind: intent.sizeConstraint.kind,
        value: intent.sizeConstraint.value,
        dailyKcalOverride: intent.sizeConstraint.dailyKcalOverride,
      },
      cadenceDays: intent.cadenceDays,
      promoCodes: [],
      petId: persisted.petId,
      petProfileContext: {
        petId: persisted.petId,
        ageBand: intent.petProfile.ageBand,
        weightKg: intent.petProfile.weightKg,
        activityLevel: intent.petProfile.activityLevel,
        bcs: intent.petProfile.bcs,
        allergenSlugs: intent.petProfile.allergenSlugs,
        dailyKcalOverride: intent.petProfile.dailyKcalOverride,
      },
    });
    const orderDraftSnapshot = createOrderDraftSnapshotFromQuoteSnapshot(quote);
    expect(orderDraftSnapshot.context).toMatchObject({ mode: "subscription", cadenceDays: 21 });

    const inventoryPort = {
      reserveOrderItems: vi.fn().mockResolvedValue([
        {
          reservationId: "66666666-6666-4666-8666-666666666666",
          reservationIds: ["66666666-6666-4666-8666-666666666666"],
          orderItemId: "77777777-7777-4777-8777-777777777777",
          skuId: "88888888-8888-4888-8888-888888888888",
          sku: "opaque:lamb-launch.v1",
          status: "reserved",
          replayed: false,
        },
      ]),
      releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }),
    };
    const paymentPort = {
      createIntent: vi.fn().mockResolvedValue({
        paymentIntentId: "99999999-9999-4999-8999-999999999999",
        paymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "created",
        replayed: false,
      }),
      recordAttempt: vi.fn().mockResolvedValue({
        paymentAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "processing",
        replayed: false,
      }),
      applyResult: vi.fn().mockResolvedValue({
        paymentIntentId: "99999999-9999-4999-8999-999999999999",
        paymentAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        paymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        orderId: "44444444-4444-4444-8444-444444444444",
        status: "failed",
        kind: "payment_failed",
        replayed: false,
      }),
    };
    const runtime = createCommerceRuntimeService({
      orderPort: {
        finalizeOrderForCheckout: vi.fn().mockResolvedValue({
          orderId: "44444444-4444-4444-8444-444444444444",
          orderRef: "order_44444444-4444-4444-8444-444444444444",
          mode: "subscription_cycle",
          clientId: persisted.clientId,
          petId: persisted.petId,
          shippingAddressId: persisted.shippingAddressId,
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          subscriptionCycleId: "33333333-3333-4333-8333-333333333334",
          total: quote.quote.totalGross,
          items: [{
            orderItemId: "77777777-7777-4777-8777-777777777777",
            skuId: "88888888-8888-4888-8888-888888888888",
            sku: "opaque:lamb-launch.v1",
            quantity: 14,
          }],
          replayed: false,
        }),
      },
      inventoryPort,
      paymentPort,
      readinessPort: {
        evaluateOrderReadiness: vi.fn().mockResolvedValue({
          omsEligibility: { allowed: false, reason: "order_not_paid" },
          fulfillmentCreate: { allowed: false, reason: "oms_blocked", omsReason: "order_not_paid" },
        }),
      },
    });

    const started = await runtime.startRuntime({
      idempotencyKey: "hidden-rehearsal-1",
      orderDraft: {
        orderId: "order_44444444-4444-4444-8444-444444444444",
        status: "draft",
        paymentStatus: "not_started",
        idempotencyKey: intent.idempotencyKey,
        quoteSnapshot: quote,
        replayed: false,
      },
      mode: "subscription_cycle",
      clientId: persisted.clientId,
      shippingAddressId: persisted.shippingAddressId,
      petId: persisted.petId,
      paymentProvider: "hidden_rehearsal",
      providerFlow: "one_time_payment",
      metadata: {},
    });
    expect(started.runtime.nextAction).toEqual({
      kind: "await_hidden_payment_result",
      provider: "hidden_rehearsal",
    });
    expect(inventoryPort.reserveOrderItems).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "hidden-rehearsal-1:inventory" }),
    );
    expect(paymentPort.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "hidden-rehearsal-1:payment-intent" }),
    );
    expect(paymentPort.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "hidden-rehearsal-1:payment-attempt",
      requestPayload: expect.objectContaining({
        providerIdempotencyKey: "openlup:hidden_rehearsal:99999999-9999-4999-8999-999999999999:hidden-rehearsal-1:payment-execution",
        providerRequestFingerprint: [
          "hidden_rehearsal",
          "99999999-9999-4999-8999-999999999999",
          quote.quote.totalGross.amountMinor.toString(),
          "PLN",
          "subscription_cycle",
          "order_44444444-4444-4444-8444-444444444444",
        ].join("|"),
      }),
    }));

    const failed = await runtime.applyPaymentResult({
      idempotencyKey: "hidden-rehearsal-payment-1",
      orderId: "44444444-4444-4444-8444-444444444444",
      paymentIntentId: "99999999-9999-4999-8999-999999999999",
      resultStatus: "failed",
      occurredAt: "2026-06-05T12:00:00.000Z",
    });
    expect(failed.reservationRelease).toEqual({ attempted: true, releasedCount: 1 });
    expect(failed.readiness).toBeNull();
  });
});

function makeIntent() {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-hidden-rehearsal",
    locale: "pl",
    mode: "subscription",
    cadenceDays: 21,
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
    contact: { firstName: "Anna", lastName: "Kowalska", email: "anna@example.com", phone: "+48123456789" },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: { kind: "courier", providerRef: null },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [{ variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 14 }],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: true },
    consciousAllergenOverride: false,
  };
}

function recommendationVariants(): RecommendationVariant[] {
  return [{
    variantId: "variant-lamb-400",
    sku: "opaque:lamb-launch.v1",
    slug: "lamb",
    kcalPer100g: 123,
    netWeightG: 400,
    allergenSlugs: ["lamb"],
  }];
}

function createCatalogReadPort(): CatalogReadPort {
  const products = [catalogProduct()];
  return {
    async listProducts() {
      return products;
    },
    async getProductBySlug(slug) {
      return products.find((product) => product.slug === slug) ?? null;
    },
    async listAllergens() {
      return [];
    },
  };
}

function createPricingResolver(): PricingResolverPort {
  return {
    async resolvePrice(query: ResolvePriceQuery): Promise<ResolvedPrice | null> {
      if (query.variantId !== "variant-lamb-400") return null;
      return {
        variantId: query.variantId,
        mode: query.mode,
        matchedMinQty: 14,
        unitPriceMinor: query.mode === "subscription" ? 1340 : 1490,
        amountKind: "gross",
        priceListId: "list-pl",
        priceEntryId: `price-${query.mode}`,
        resolvedAt: query.atTime ?? "2026-06-05T10:00:00.000Z",
      };
    },
  };
}

function catalogProduct(): CatalogProduct {
  return {
    id: "product-lamb",
    slug: "lamb",
    displayName: "Lamb",
    lineName: "openlup",
    species: "dog",
    publicationStatus: "published",
    route: { pl: "/psy/jagniecina", en: "/dogs/lamb" },
    primarySku: catalogSku(),
    variants: [catalogSku()],
    composition: { rawIngredients: "", rawIngredientsEn: null, items: [], allergenSlugs: ["lamb"], kcalPer100g: 123 },
    metadata: { format: "can", kcalPer100g: 123, legacyStatus: null },
  };
}

function catalogSku() {
  return {
    sku: "opaque:lamb-launch.v1",
    productSlug: "lamb" as const,
    variantId: "variant-lamb-400",
    publicationStatus: "published" as const,
    unit: "can" as const,
    netWeightGrams: 400,
    pricing: {
      status: "configured" as const,
      listPrice: { amountMinor: 1490, currency: "PLN" as const },
      taxCategory: "pet_food" as const,
      externalRefs: { paymentProviderPriceId: null, inventoryProviderSku: null },
    },
  };
}
