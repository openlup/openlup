import { describe, expect, it, vi } from "vitest";
import {
  createDbBackedCommerceQuotePort,
  type CommerceQuoteCatalogItem,
} from "@openlup/platform/pricing";
import {
  createQuotePromotionCodeAdjustments,
  createQuoteShippingPromotions,
  type PromotionCodeQuotePort,
} from "@openlup/platform/promotions";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  selectCheapestCarrierRate,
  type ShippingSettings,
} from "@openlup/platform/shipping";
import {
  createShipEngineHttpClient,
  createShipEngineRateAdapter,
  SHIPENGINE_API_ORIGIN,
} from "../server/index.js";
import { SHIPENGINE_HAPPY_PAYLOAD, SHIPENGINE_TEST_CANARIES } from "./fixtures.js";

const AT = "2030-06-15T12:00:00.000Z";

function createMountedCommerceQuotePort(options: {
  rateAdapter: ReturnType<typeof createShipEngineRateAdapter>;
  freeThresholdMinor: number;
  promoCodePort?: PromotionCodeQuotePort;
}) {
  const taxProfile = {
    included: true as const,
    country: "US",
    category: "standard",
    vatRateBps: 0,
    legalBasis: "Test",
  };
  const catalogItem: CommerceQuoteCatalogItem = {
    skuId: "sku-1",
    skuCode: "STARTER-BOX",
    variantId: "var-1",
    productSlug: "starter-box",
    netWeightG: 1200,
    isAddon: false,
    sellability: { oneTime: true, subscription: true },
    documentRevision: { id: null, digest: null },
  };
  const adjust = createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: 100 });

  const shippingPromotions = createQuoteShippingPromotions({
    promotionCodeQuotePort: options.promoCodePort,
    commerceSettingsPort: {
      async getShippingSettings(): Promise<ShippingSettings> {
        const quoted = await options.rateAdapter.quoteRates({
          contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
          requestKey: "commerce-quote-shipping-1",
          origin: { countryCode: "US", postalCode: "78756", stateOrProvince: "TX", city: "Austin" },
          destination: { countryCode: "US", postalCode: "10001", stateOrProvince: "NY", city: "New York" },
          parcels: [{ weightGrams: catalogItem.netWeightG, lengthMm: 250, widthMm: 180, heightMm: 120 }],
          currency: "USD",
        });
        if (quoted.kind !== "quoted") {
          throw new Error(`SHIPPING_QUOTE_UNAVAILABLE:${quoted.kind}:${quoted.diagnosticCode}`);
        }
        const cheapest = selectCheapestCarrierRate(quoted.rates);
        if (!cheapest) {
          throw new Error("SHIPPING_QUOTE_UNAVAILABLE:no_rates");
        }
        return {
          legacyFlatMinor: cheapest.amountMinor,
          policy: {
            version: "shipping-policy.v1",
            current: {
              enabled: true,
              flatMinor: cheapest.amountMinor,
              freeThresholdMinor: options.freeThresholdMinor,
              effectiveFrom: AT,
            },
          },
        };
      },
    },
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: adjust.applyPromotionCodesV2,
  });

  return createDbBackedCommerceQuotePort({
    taxProfile,
    supportedTaxProfiles: [taxProfile],
    regionCode: "US",
    currency: "USD",
    now: () => AT,
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [catalogItem] },
    isStrictD1Quote: false,
    pricingResolverPort: {
      resolvePrice: async (value) => ({
        variantId: value.variantId,
        mode: value.mode,
        currency: "USD",
        unitPriceMinor: 2500,
        priceEntryId: "price-1",
        priceListId: "list-us",
        amountKind: "gross",
        resolvedAt: AT,
        matchedMinQty: 1,
      }),
    },
    hasPromotionCodePort: Boolean(options.promoCodePort),
    resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
    applyPromotionCodesV2: adjust.applyPromotionCodesV2,
    resolveQuoteShippingPromotions: shippingPromotions.resolveQuoteShippingPromotions,
    lineContext: () => ({}),
    quoteContext: (req) => () => ({ mode: req.mode, promoCodes: req.promoCodes }),
  });
}

/**
 * Stage 3 Real-Flow Mount Proof (ADR-001):
 * Wires ShipEngine CarrierRateQuotePort into createDbBackedCommerceQuotePort
 * and createQuoteShippingPromotions from @openlup/platform.
 */
describe("recipes/shipping/shipengine — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("wires ShipEngine carrier rates into createDbBackedCommerceQuotePort + createQuoteShippingPromotions", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(`${SHIPENGINE_API_ORIGIN}/v1/rates`);
      return new Response(JSON.stringify(SHIPENGINE_HAPPY_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const rateAdapter = createShipEngineRateAdapter({
      client: createShipEngineHttpClient({
        apiKey: SHIPENGINE_TEST_CANARIES.apiKey,
        fetchImpl: fetchSpy,
      }),
      carrierIds: ["se-123456"],
      supportedCurrencies: ["USD"],
    });

    // 1. Below free-shipping threshold ($25.00 < $50.00): cheapest ShipEngine rate (1095 minor) applies.
    const belowThresholdPort = createMountedCommerceQuotePort({
      rateAdapter,
      freeThresholdMinor: 5000,
    });
    const quoteBelow = await belowThresholdPort.createServerAuthoritativeQuote({
      mode: "one_time",
      lines: [{ sku: "STARTER-BOX", quantity: 1 }],
      promoCodes: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(quoteBelow.quote.subtotalGross.amountMinor).toBe(2500);
    expect(quoteBelow.quote.shippingGross?.amountMinor).toBe(1095);
    expect(quoteBelow.quote.totalGross.amountMinor).toBe(3595);

    // 2. With free_shipping promo code: shippingDiscountGross zeroes the ShipEngine rate.
    const freeShippingCodePort: PromotionCodeQuotePort = {
      resolve: async () => ({
        candidates: [
          {
            promotionId: "promo-free-ship",
            name: "Free Shipping",
            source: "code",
            code: "FREESHIP",
            codeId: "code-fs-1",
            scopes: ["one_time"],
            codeRevision: 1,
            definitionFingerprint: "a".repeat(64),
            minimumReferenceMinor: 0,
            validTo: null,
            lane: "shipping",
            kind: "free_shipping",
          },
        ],
        codeRejections: [],
        codeRejectionDetails: [],
      }),
    };
    const promoPort = createMountedCommerceQuotePort({
      rateAdapter,
      freeThresholdMinor: 5000,
      promoCodePort: freeShippingCodePort,
    });
    const quoteFreeShip = await promoPort.createServerAuthoritativeQuote({
      mode: "one_time",
      lines: [{ sku: "STARTER-BOX", quantity: 1 }],
      promoCodes: ["FREESHIP"],
    });
    expect(quoteFreeShip.quote.shippingGross?.amountMinor).toBe(1095);
    expect(quoteFreeShip.quote.shippingDiscountGross?.amountMinor).toBe(1095);
    expect(quoteFreeShip.quote.totalGross.amountMinor).toBe(2500);

    const serialized = JSON.stringify({ quoteBelow, quoteFreeShip });
    expect(serialized).not.toContain(SHIPENGINE_TEST_CANARIES.apiKey);
    expect(serialized).not.toContain(SHIPENGINE_TEST_CANARIES.marker);
  });

  it("fails closed on ShipEngine refusal and refuses unsupported currency at zero I/O (negative controls)", async () => {
    // Negative control #1: Carrier 401 refusal prevents quote completion instead of silently defaulting to 0 shipping.
    const failingAdapter = createShipEngineRateAdapter({
      client: createShipEngineHttpClient({
        apiKey: SHIPENGINE_TEST_CANARIES.apiKey,
        fetchImpl: async () => new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
      }),
      carrierIds: ["se-123456"],
      supportedCurrencies: ["USD"],
    });
    const failingPort = createMountedCommerceQuotePort({
      rateAdapter: failingAdapter,
      freeThresholdMinor: 5000,
    });
    await expect(
      failingPort.createServerAuthoritativeQuote({
        mode: "one_time",
        lines: [{ sku: "STARTER-BOX", quantity: 1 }],
        promoCodes: [],
      }),
    ).rejects.toThrow("SHIPPING_QUOTE_UNAVAILABLE:refused:SHIPENGINE_AUTH_FAILED");

    // Negative control #2: Unsupported currency refuses at zero HTTP I/O.
    const spyFetch = vi.fn(async () => {
      throw new Error("must not dispatch");
    });
    const usdOnlyAdapter = createShipEngineRateAdapter({
      client: createShipEngineHttpClient({
        apiKey: SHIPENGINE_TEST_CANARIES.apiKey,
        fetchImpl: spyFetch,
      }),
      carrierIds: ["se-123456"],
      supportedCurrencies: ["USD"],
    });
    const res = await usdOnlyAdapter.quoteRates({
      contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
      requestKey: "quote-jpy-1",
      origin: { countryCode: "US", postalCode: "78756" },
      destination: { countryCode: "US", postalCode: "10001" },
      parcels: [{ weightGrams: 500 }],
      currency: "JPY",
    });
    expect(res).toMatchObject({
      kind: "refused",
      reason: "unsupported_currency",
      retryable: false,
      diagnosticCode: "UNSUPPORTED_CURRENCY",
    });
    expect(spyFetch).not.toHaveBeenCalled();
  });
});
