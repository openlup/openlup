import { describe, expect, it, vi } from "vitest";
import type { PromotionRow } from "@openlup/core/promo";
import {
  createDbBackedCommerceQuotePort,
  type CreateQuoteRequest,
  type QuoteShippingPromotionInput,
} from "@openlup/platform/pricing";
import {
  createQuoteAutomaticPromotions,
  createQuotePromoDiscounts,
  createQuotePromotionCodeAdjustments,
  createQuotePromotionV2,
  createQuoteShippingPromotions,
  type CommercePromoDataPort,
  type QuoteShippingPromotionsDeps,
} from "@openlup/platform/promotions";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  selectCheapestCarrierRate,
  type CarrierRateAddress,
  type CarrierRateQuotePort,
} from "@openlup/platform/shipping";
import {
  createEasyPostCarrierRateAdapter,
  createEasyPostHttpClient,
  EASYPOST_SHIPMENTS_URL,
} from "../server/index.js";
import {
  createHappyMultiCarrierShipmentResponse,
  EASYPOST_TEST_AT_TIME,
  EASYPOST_TEST_CANARIES,
} from "./fixtures.js";

interface MountQuoteRequest extends CreateQuoteRequest {
  destination: CarrierRateAddress;
}

const PRICING_POLICY = {
  offerPolicyVersion: "commerce.offer-policy.v2",
  promotionEngineVersion: "promotion-engine.v2",
} as const;

const ORIGIN_ADDRESS: CarrierRateAddress = {
  countryCode: "US",
  postalCode: "94107",
  stateOrProvince: "CA",
  city: "San Francisco",
};

const FREE_SHIPPING_THRESHOLD_MINOR = 5000;
const FALLBACK_DETACHED_FLAT_MINOR = 640;

function createPromoDependencies(
  rows: PromotionRow[],
  onPromoDbRead: () => void,
) {
  const promoDataPort: CommercePromoDataPort = {
    listActivePromotions: async () => {
      onPromoDbRead();
      return rows;
    },
    countPaidOrders: async () => {
      onPromoDbRead();
      return 0;
    },
    countPaidOrdersByMode: async () => {
      onPromoDbRead();
      return { oneTime: 0, subscription: 0 };
    },
    redemptionCounts: async () => {
      onPromoDbRead();
      return new Map();
    },
    deviceFirstOrderRedeemed: async () => {
      onPromoDbRead();
      return false;
    },
  };

  const promotionCustomerSemantic = () => undefined;
  const promo = createQuotePromoDiscounts({ promotionCustomerSemantic });
  const v2 = createQuotePromotionV2({
    ...promo,
    promotionCustomerSemantic,
    minimumProductPayableMinor: 100,
  });
  const automatic = createQuoteAutomaticPromotions<MountQuoteRequest>({
    ...promo,
    ...v2,
    resolveEmailEligibility: () => true,
  });
  const codes = createQuotePromotionCodeAdjustments({
    minimumProductPayableMinor: 100,
  });

  return { ...automatic, ...codes, promoDataPort };
}

function createMountedShippingResolver(
  carrierAdapter: CarrierRateQuotePort,
  deps: Omit<QuoteShippingPromotionsDeps<MountQuoteRequest>, "commerceSettingsPort">,
) {
  return {
    async resolveQuoteShippingPromotions(
      input: QuoteShippingPromotionInput<MountQuoteRequest>,
    ) {
      const rateQuote = await carrierAdapter.quoteRates({
        contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
        requestKey: `quote-${input.request.mode}-${input.request.destination.countryCode}`,
        origin: ORIGIN_ADDRESS,
        destination: input.request.destination,
        parcels: [{ weightGrams: 850, lengthMm: 254, widthMm: 203, heightMm: 102 }],
        currency: input.currency,
        atTime: input.atTime,
      });

      if (rateQuote.kind !== "quoted") {
        throw new Error(`carrier_rate_refused:${rateQuote.kind === "refused" ? rateQuote.reason : rateQuote.diagnosticCode}`);
      }

      const cheapest = selectCheapestCarrierRate(rateQuote.rates);
      if (!cheapest) {
        throw new Error("carrier_rate_missing");
      }

      return createQuoteShippingPromotions<MountQuoteRequest>({
        ...deps,
        commerceSettingsPort: {
          getShippingSettings: async () => ({
            legacyFlatMinor: 0,
            policy: {
              version: "shipping-policy.v1",
              current: {
                enabled: true,
                flatMinor: cheapest.amountMinor,
                freeThresholdMinor: FREE_SHIPPING_THRESHOLD_MINOR,
                effectiveFrom: "2000-01-01T00:00:00.000Z",
              },
            },
          }),
        },
      }).resolveQuoteShippingPromotions(input);
    },
  };
}

function createMountedQuotePort(
  deps: Omit<QuoteShippingPromotionsDeps<MountQuoteRequest>, "commerceSettingsPort">,
  shippingHook: Pick<
    ReturnType<typeof createQuoteShippingPromotions<MountQuoteRequest>>,
    "resolveQuoteShippingPromotions"
  >,
  unitPriceMinor: number,
) {
  const taxProfile = {
    included: true as const,
    country: "US",
    vatRateBps: 0,
    category: "standard",
    legalBasis: "Offline Stage 3 mount proof",
  };

  return createDbBackedCommerceQuotePort({
    taxProfile,
    supportedTaxProfiles: [taxProfile],
    regionCode: "US",
    currency: "USD",
    now: () => EASYPOST_TEST_AT_TIME,
    isStrictD1Quote: false,
    hasPromotionCodePort: false,
    quoteCatalogReadPort: {
      listQuoteCatalogItems: async () => [
        {
          skuId: "sku-mount-1",
          skuCode: "MOUNT-ITEM",
          variantId: "var-mount-1",
          productSlug: "mount-item",
          netWeightG: 850,
          isAddon: false,
          sellability: { oneTime: true, subscription: true },
          documentRevision: { id: null, digest: null },
        },
      ],
    },
    pricingResolverPort: {
      resolvePrice: async (input) => ({
        variantId: input.variantId,
        mode: input.mode,
        currency: "USD",
        unitPriceMinor,
        priceEntryId: "price-mount-1",
        priceListId: "list-mount-1",
        amountKind: "gross",
        resolvedAt: EASYPOST_TEST_AT_TIME,
        matchedMinQty: 1,
      }),
    },
    lineContext: () => ({}),
    quoteContext: (input: MountQuoteRequest) => () => ({
      mode: input.mode,
      cadenceDays: input.cadenceDays ?? null,
      promoCodes: input.promoCodes,
    }),
    ...deps,
    ...shippingHook,
  });
}

describe("recipes/shipping/easypost — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("propagates cheapest EasyPost rate into quote shippingGross, totalGross, and shippingTerms across one_time and subscription", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(EASYPOST_SHIPMENTS_URL);
      return new Response(JSON.stringify(createHappyMultiCarrierShipmentResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const adapter = createEasyPostCarrierRateAdapter({
      client: createEasyPostHttpClient({
        apiKey: EASYPOST_TEST_CANARIES.apiKey,
        fetchImpl: fetchSpy,
      }),
      supportedCurrencies: ["USD"],
      supportedOriginCountries: ["US"],
      supportedDestinationCountries: ["US", "CA"],
    });

    for (const mode of ["one_time", "subscription"] as const) {
      let promoReads = 0;
      const deps = createPromoDependencies([], () => {
        promoReads += 1;
      });
      const hook = createMountedShippingResolver(adapter, deps);
      const port = createMountedQuotePort(deps, hook, 2500);

      const snapshot = await port.createServerAuthoritativeQuote(
        {
          mode,
          cadenceDays: mode === "subscription" ? 28 : null,
          lines: [{ sku: "MOUNT-ITEM", quantity: 1 }],
          promoCodes: [],
          destination: { countryCode: "US", postalCode: "10001", stateOrProvince: "NY", city: "New York" },
        },
        { pricingPolicy: PRICING_POLICY },
      );

      // Cheapest rate in fixture is USPS Priority "7.95" USD -> 795 minor.
      expect(snapshot.quote.shippingGross?.amountMinor).toBe(795);
      expect(snapshot.quote.totalGross.amountMinor).toBe(2500 + 795);
      expect(snapshot.quote.context.shippingTerms).toEqual({
        version: "shipping-threshold.v1",
        currency: "USD",
        flatMinor: 795,
        freeThresholdMinor: FREE_SHIPPING_THRESHOLD_MINOR,
      });
      expect(promoReads).toBeGreaterThan(0);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses unsupported destination country at zero carrier I/O and zero promo DB reads", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("carrier HTTP must not be called for unsupported country");
    });

    const adapter = createEasyPostCarrierRateAdapter({
      client: createEasyPostHttpClient({
        apiKey: EASYPOST_TEST_CANARIES.apiKey,
        fetchImpl: fetchSpy,
      }),
      supportedCurrencies: ["USD"],
      supportedOriginCountries: ["US"],
      supportedDestinationCountries: ["US", "CA"],
    });

    let promoReads = 0;
    const deps = createPromoDependencies([], () => {
      promoReads += 1;
    });
    const hook = createMountedShippingResolver(adapter, deps);
    const port = createMountedQuotePort(deps, hook, 2500);

    for (const mode of ["one_time", "subscription"] as const) {
      await expect(
        port.createServerAuthoritativeQuote(
          {
            mode,
            cadenceDays: mode === "subscription" ? 28 : null,
            lines: [{ sku: "MOUNT-ITEM", quantity: 1 }],
            promoCodes: [],
            destination: { countryCode: "AU", postalCode: "2000" },
          },
          { pricingPolicy: PRICING_POLICY },
        ),
      ).rejects.toThrow(/carrier_rate_refused:unsupported_country/);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(promoReads).toBe(0);
  });

  it("negative control: detaching the EasyPost carrier resolver fails the rate-propagation assertion", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(createHappyMultiCarrierShipmentResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // Adapter is constructed, but intentionally NOT mounted into quote port.
    createEasyPostCarrierRateAdapter({
      client: createEasyPostHttpClient({
        apiKey: EASYPOST_TEST_CANARIES.apiKey,
        fetchImpl: fetchSpy,
      }),
      supportedCurrencies: ["USD"],
      supportedOriginCountries: ["US"],
      supportedDestinationCountries: ["US", "CA"],
    });

    const deps = createPromoDependencies([], () => undefined);
    const detachedHook = createQuoteShippingPromotions<MountQuoteRequest>({
      ...deps,
      commerceSettingsPort: {
        getShippingSettings: async () => ({
          legacyFlatMinor: 0,
          policy: {
            version: "shipping-policy.v1",
            current: {
              enabled: true,
              flatMinor: FALLBACK_DETACHED_FLAT_MINOR,
              freeThresholdMinor: FREE_SHIPPING_THRESHOLD_MINOR,
              effectiveFrom: "2000-01-01T00:00:00.000Z",
            },
          },
        }),
      },
    });
    const port = createMountedQuotePort(deps, detachedHook, 2500);

    const snapshot = await port.createServerAuthoritativeQuote(
      {
        mode: "one_time",
        cadenceDays: null,
        lines: [{ sku: "MOUNT-ITEM", quantity: 1 }],
        promoCodes: [],
        destination: { countryCode: "US", postalCode: "10001" },
      },
      { pricingPolicy: PRICING_POLICY },
    );

    // Rate-propagation assertions MUST fail when EasyPost resolver is detached.
    expect(() => expect(snapshot.quote.shippingGross?.amountMinor).toBe(795)).toThrow();
    expect(() => expect(snapshot.quote.totalGross.amountMinor).toBe(2500 + 795)).toThrow();
    expect(() => expect(snapshot.quote.context.shippingTerms?.flatMinor).toBe(795)).toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
