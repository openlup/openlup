import { describe, expect, it } from "vitest";
import type { PromotionRow } from "@openlup/core/promo";
import {
  ACQUISITION_TERMS_CAPABILITY,
  AcquisitionTermsError,
  createDbBackedCommerceQuotePort,
  type AcquisitionFinancialPolicy,
  type AcquisitionQuoteRequest,
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
  type CarrierRateQuotePort,
} from "@openlup/platform/shipping";
import {
  USPS_BASE_RATES_SEARCH_URLS,
  USPS_OAUTH_TOKEN_URLS,
  createUspsCarrierRateAdapter,
  createUspsHttpClient,
  createUspsOAuth2TokenManager,
  type FetchLike,
} from "../server/index.js";
import {
  FIXTURE_AT_TIME_ISO,
  FIXTURE_CANARIES,
  FIXTURE_NOW_MS,
  buildOAuthTokenPayload,
  buildUspsMultiServiceRatesResponse,
} from "./fixtures.js";

/**
 * Stage 3 Real-Flow Mount Proof (ADR-001 §5):
 * Wires `createUspsCarrierRateAdapter` + `selectCheapestCarrierRate` into
 * `createDbBackedCommerceQuotePort` + `createQuoteShippingPromotions` using ONLY
 * public `@openlup/platform/*` and `@openlup/core/*` exports.
 */

const PRICING_POLICY = {
  offerPolicyVersion: "commerce.offer-policy.v2",
  promotionEngineVersion: "promotion-engine.v2",
} as const;

const EFFECTIVE_FROM = "2030-01-01T00:00:00.000Z";
const FREE_THRESHOLD_MINOR = 5000;
const MINIMUM_PRODUCT_PAYABLE_MINOR = 100;

interface UspsCheckoutRequest extends AcquisitionQuoteRequest {
  readonly checkout: {
    readonly country: string;
    readonly postalCode: string;
  };
}

function createNeutralAcquisitionFinancialPolicy(): AcquisitionFinancialPolicy<PromotionRow> {
  type Row = PromotionRow & {
    promotion_engine_version?: unknown;
    benefit_lane?: unknown;
    benefit_kind?: unknown;
    benefit_value_bps?: unknown;
    benefit_value_minor?: unknown;
    v2_mirror_of?: unknown;
  };
  const tagged = (row: Row) => Object.hasOwn(row.applies_to_payload, "acquisitionTerms");
  const target = (row: Row) =>
    row.trigger_type === "automatic" &&
    row.code === null &&
    row.applies_to_kind === "order_total" &&
    row.stacking_rule === "exclusive" &&
    row.applies_to_payload.cart_mode === "subscription" &&
    Object.keys(row.eligibility).length === 1 &&
    row.eligibility.first_subscription_purchase === true &&
    row.promotion_engine_version === "promotion-engine.v2" &&
    row.discount_type === "percentage" &&
    row.benefit_lane === "product" &&
    row.benefit_kind === "target_percentage" &&
    typeof row.benefit_value_bps === "number" &&
    Number.isInteger(row.benefit_value_bps) &&
    row.benefit_value_bps > 0 &&
    row.benefit_value_bps < 10000 &&
    row.discount_value === row.benefit_value_bps / 100 &&
    row.benefit_value_minor == null;

  return {
    facts: (row: Row) => ({
      id: row.id,
      active: row.status === "active",
      regionCodes: row.region_availability,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      mirrorOf: row.v2_mirror_of,
      metadataPresent: tagged(row),
      metadata: row.applies_to_payload.acquisitionTerms,
    }),
    classify: (row: Row) => ({
      baselineLegacy: false,
      target: target(row),
      canonicalRow: tagged(row),
      unconfiguredLegacyEligible: false,
    }),
    validateMetadata(row: Row) {
      if (
        !target(row) ||
        Object.keys(row.applies_to_payload).length !== 2 ||
        row.redemption_limit_global != null ||
        row.redemption_limit_per_customer !== 1 ||
        row.v2_mirror_of != null
      ) {
        throw new AcquisitionTermsError("acquisition_terms_invalid");
      }
    },
    pairMatches: () => false,
    initialDiscountBps: (row: Row) => row.benefit_value_bps,
    unconfiguredTerms: () => {
      throw new AcquisitionTermsError("acquisition_terms_invalid");
    },
  };
}

function buildProduct10PctPromotion(): PromotionRow[] {
  return [
    {
      id: "usps-mount-product-10pct",
      name: "10% off order",
      status: "active",
      code: null,
      trigger_type: "automatic",
      discount_type: "percentage",
      discount_value: 10,
      applies_to_kind: "order_total",
      stacking_rule: "exclusive",
      eligibility: {},
      applies_to_payload: {},
      region_availability: ["US"],
      valid_from: EFFECTIVE_FROM,
      valid_to: null,
      redemption_limit_global: null,
      redemption_limit_per_customer: null,
      ...{
        promotion_engine_version: "promotion-engine.v2",
        benefit_lane: "product",
        benefit_kind: "target_percentage",
        benefit_value_bps: 1000,
        benefit_value_minor: null,
        v2_mirror_of: null,
      },
    },
  ];
}

function buildPromoDependencies(rows: PromotionRow[], onPromoRead: () => void) {
  const promoDataPort: CommercePromoDataPort = {
    listActivePromotions: async () => {
      onPromoRead();
      return rows;
    },
    countPaidOrders: async () => {
      onPromoRead();
      return 0;
    },
    countPaidOrdersByMode: async () => {
      onPromoRead();
      return { oneTime: 0, subscription: 0 };
    },
    redemptionCounts: async () => {
      onPromoRead();
      return new Map();
    },
    deviceFirstOrderRedeemed: async () => {
      onPromoRead();
      return false;
    },
  };
  const acquisition = {
    financialPolicy: createNeutralAcquisitionFinancialPolicy(),
    capability: (input: AcquisitionQuoteRequest) => input.acquisitionCapability,
  };
  const promotionCustomerSemantic = () => undefined;
  const promo = createQuotePromoDiscounts({ acquisition, promotionCustomerSemantic });
  const v2 = createQuotePromotionV2({
    ...promo,
    acquisition,
    promotionCustomerSemantic,
    minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
  });
  const automatic = createQuoteAutomaticPromotions<UspsCheckoutRequest>({
    ...promo,
    ...v2,
    acquisition,
    resolveEmailEligibility: () => true,
  });
  const codes = createQuotePromotionCodeAdjustments({
    minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
  });
  return { ...automatic, ...codes, promoDataPort };
}

function mountUspsQuoteShipping(
  adapter: CarrierRateQuotePort,
  deps: Omit<QuoteShippingPromotionsDeps<UspsCheckoutRequest>, "commerceSettingsPort">,
) {
  const resolveQuoteShippingPromotions = async (
    input: QuoteShippingPromotionInput<UspsCheckoutRequest>,
  ) => {
    const rateResult = await adapter.quoteRates({
      contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
      requestKey: `quote-ship-${input.request.mode}-${input.atTime}`,
      origin: {
        countryCode: "US",
        postalCode: FIXTURE_CANARIES.originPostal,
      },
      destination: {
        countryCode: input.request.checkout.country,
        postalCode: input.request.checkout.postalCode,
      },
      parcels: [
        {
          weightGrams: 907,
          lengthMm: 254,
          widthMm: 152,
          heightMm: 102,
        },
      ],
      currency: input.currency,
      atTime: input.atTime,
    });

    if (rateResult.kind !== "quoted") {
      throw new Error(
        `usps_shipping_refused:${rateResult.kind === "refused" ? rateResult.reason : rateResult.diagnosticCode}`,
      );
    }

    const cheapest = selectCheapestCarrierRate(rateResult.rates);
    if (!cheapest) {
      throw new Error("usps_shipping_no_cheapest_rate");
    }

    return createQuoteShippingPromotions({
      ...deps,
      commerceSettingsPort: {
        getShippingSettings: async () => ({
          legacyFlatMinor: 0,
          policy: {
            version: "shipping-policy.v1",
            current: {
              enabled: true,
              flatMinor: cheapest.amountMinor,
              freeThresholdMinor: FREE_THRESHOLD_MINOR,
              effectiveFrom: EFFECTIVE_FROM,
            },
          },
        }),
      },
    }).resolveQuoteShippingPromotions(input);
  };

  return { resolveQuoteShippingPromotions };
}

function buildQuotePort(
  deps: ReturnType<typeof buildPromoDependencies>,
  unitPriceMinor: number,
  shippingHook?: {
    resolveQuoteShippingPromotions?: (
      input: QuoteShippingPromotionInput<UspsCheckoutRequest>,
    ) => ReturnType<ReturnType<typeof createQuoteShippingPromotions<UspsCheckoutRequest>>["resolveQuoteShippingPromotions"]>;
  },
) {
  const taxProfile = {
    included: true as const,
    country: "US",
    category: "standard",
    vatRateBps: 0,
    legalBasis: "us_retail_quote",
  };
  return createDbBackedCommerceQuotePort({
    taxProfile,
    supportedTaxProfiles: [taxProfile],
    regionCode: "US",
    currency: "USD",
    now: () => FIXTURE_AT_TIME_ISO,
    isStrictD1Quote: false,
    hasPromotionCodePort: false,
    quoteCatalogReadPort: {
      listQuoteCatalogItems: async () => [
        {
          skuId: "sku-usps-1",
          skuCode: "ITEM-USPS",
          variantId: "variant-usps-1",
          productSlug: "item-usps",
          netWeightG: 907,
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
        priceEntryId: "price-usps-1",
        priceListId: "list-usps-1",
        amountKind: "gross",
        resolvedAt: FIXTURE_AT_TIME_ISO,
        matchedMinQty: 1,
      }),
    },
    lineContext: () => ({}),
    quoteContext: (input: UspsCheckoutRequest) => () => ({
      mode: input.mode,
      cadenceDays: input.cadenceDays ?? null,
      promoCodes: input.promoCodes,
    }),
    ...deps,
    ...shippingHook,
  });
}

function createOfflineUspsStack(ioCounters: { oauth: number; rateSearch: number }) {
  const fetchImpl: FetchLike = async (url, init) => {
    expect(init?.redirect).toBe("error");
    if (url === USPS_OAUTH_TOKEN_URLS.tem) {
      ioCounters.oauth += 1;
      return new Response(JSON.stringify(buildOAuthTokenPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    expect(url).toBe(USPS_BASE_RATES_SEARCH_URLS.tem);
    ioCounters.rateSearch += 1;
    return new Response(JSON.stringify(buildUspsMultiServiceRatesResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const tokenManager = createUspsOAuth2TokenManager({
    clientId: FIXTURE_CANARIES.clientId,
    clientSecret: FIXTURE_CANARIES.clientSecret,
    environment: "tem",
    fetchImpl,
    clock: () => FIXTURE_NOW_MS,
  });

  const client = createUspsHttpClient({
    tokenManager,
    environment: "tem",
    fetchImpl,
  });

  return createUspsCarrierRateAdapter({
    client,
    priceType: "RETAIL",
    processingCategory: "MACHINABLE",
    destinationEntryFacilityType: "NONE",
  });
}

describe("recipes/shipping/usps — Stage 3 Real-Flow Mount Proof", () => {
  it("flows cheapest USPS rate (895 minor) into shippingGross, totalGross, and shippingTerms.flatMinor across one-time & subscription quotes", async () => {
    for (const mode of ["one_time", "subscription"] as const) {
      let promoReads = 0;
      const io = { oauth: 0, rateSearch: 0 };
      const adapter = createOfflineUspsStack(io);
      const deps = buildPromoDependencies(buildProduct10PctPromotion(), () => {
        promoReads += 1;
      });
      const hook = mountUspsQuoteShipping(adapter, deps);
      const port = buildQuotePort(deps, 2500, hook);

      const snapshot = await port.createServerAuthoritativeQuote(
        {
          mode,
          cadenceDays: mode === "subscription" ? 28 : null,
          lines: [{ sku: "ITEM-USPS", quantity: 1 }],
          promoCodes: [],
          acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
          checkout: {
            country: "US",
            postalCode: FIXTURE_CANARIES.destinationPostal,
          },
        },
        { pricingPolicy: PRICING_POLICY },
      );

      // Cheapest USPS rate from buildUspsMultiServiceRatesResponse() is Ground Advantage = $8.95 = 895 minor
      expect(snapshot.quote.shippingGross?.amountMinor).toBe(895);
      expect(snapshot.quote.discountTotalGross.amountMinor).toBe(250);
      expect(snapshot.quote.totalGross.amountMinor).toBe(2500 - 250 + 895);
      expect(snapshot.quote.context.shippingTerms).toEqual({
        version: "shipping-threshold.v1",
        currency: "USD",
        flatMinor: 895,
        freeThresholdMinor: FREE_THRESHOLD_MINOR,
      });
      expect(io.oauth).toBe(1);
      expect(io.rateSearch).toBe(1);
      expect(promoReads).toBeGreaterThan(0);

      // Also verify threshold crossing clears shippingGross while retaining shippingTerms.flatMinor = 895
      const freeSnapshot = await port.createServerAuthoritativeQuote(
        {
          mode,
          cadenceDays: mode === "subscription" ? 28 : null,
          lines: [{ sku: "ITEM-USPS", quantity: 3 }],
          promoCodes: [],
          acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
          checkout: {
            country: "US",
            postalCode: "10001",
          },
        },
        { pricingPolicy: PRICING_POLICY },
      );
      expect(freeSnapshot.quote.shippingGross?.amountMinor).toBe(0);
      expect(freeSnapshot.quote.totalGross.amountMinor).toBe(7500 - 750);
      expect(freeSnapshot.quote.context.shippingTerms?.flatMinor).toBe(895);
      expect(io.oauth).toBe(1); // OAuth token cached across quotes
      expect(io.rateSearch).toBe(2);
    }
  });

  it("refuses non-US destination and invalid US postal code at 0 carrier I/O and 0 promo DB reads", async () => {
    let promoReads = 0;
    const io = { oauth: 0, rateSearch: 0 };
    const adapter = createOfflineUspsStack(io);
    const deps = buildPromoDependencies(buildProduct10PctPromotion(), () => {
      promoReads += 1;
    });
    const hook = mountUspsQuoteShipping(adapter, deps);
    const port = buildQuotePort(deps, 2500, hook);

    await expect(
      port.createServerAuthoritativeQuote(
        {
          mode: "one_time",
          cadenceDays: null,
          lines: [{ sku: "ITEM-USPS", quantity: 1 }],
          promoCodes: [],
          acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
          checkout: { country: "CA", postalCode: "K1A 0B1" },
        },
        { pricingPolicy: PRICING_POLICY },
      ),
    ).rejects.toThrow(/usps_shipping_refused:unsupported_country/);

    await expect(
      port.createServerAuthoritativeQuote(
        {
          mode: "one_time",
          cadenceDays: null,
          lines: [{ sku: "ITEM-USPS", quantity: 1 }],
          promoCodes: [],
          acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
          checkout: { country: "US", postalCode: "INVALID" },
        },
        { pricingPolicy: PRICING_POLICY },
      ),
    ).rejects.toThrow(/usps_shipping_refused:invalid_address/);

    expect(io.oauth).toBe(0);
    expect(io.rateSearch).toBe(0);
    expect(promoReads).toBe(0);
  });

  it("negative control: detaching the USPS shipping resolver fails to populate USPS shippingGross, totalGross, or shippingTerms", async () => {
    let promoReads = 0;
    const deps = buildPromoDependencies(buildProduct10PctPromotion(), () => {
      promoReads += 1;
    });

    // Control A: resolver completely detached from quote port
    const detachedPort = buildQuotePort(deps, 2500, undefined);
    const detachedSnapshot = await detachedPort.createServerAuthoritativeQuote(
      {
        mode: "one_time",
        cadenceDays: null,
        lines: [{ sku: "ITEM-USPS", quantity: 1 }],
        promoCodes: [],
        acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
        checkout: {
          country: "US",
          postalCode: FIXTURE_CANARIES.destinationPostal,
        },
      },
      { pricingPolicy: PRICING_POLICY },
    );
    expect(detachedSnapshot.quote.shippingGross?.amountMinor ?? 0).toBe(0);
    expect(detachedSnapshot.quote.context.shippingTerms).toBeUndefined();
    expect(detachedSnapshot.quote.totalGross.amountMinor).toBe(2500);
    expect(detachedSnapshot.quote.totalGross.amountMinor).not.toBe(2500 - 250 + 895);

    // Control B: default createQuoteShippingPromotions without USPS adapter mounted
    const unmountedPort = buildQuotePort(deps, 2500, createQuoteShippingPromotions(deps));
    const unmountedSnapshot = await unmountedPort.createServerAuthoritativeQuote(
      {
        mode: "one_time",
        cadenceDays: null,
        lines: [{ sku: "ITEM-USPS", quantity: 1 }],
        promoCodes: [],
        acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
        checkout: {
          country: "US",
          postalCode: FIXTURE_CANARIES.destinationPostal,
        },
      },
      { pricingPolicy: PRICING_POLICY },
    );
    expect(unmountedSnapshot.quote.shippingGross?.amountMinor ?? 0).toBe(0);
    expect(unmountedSnapshot.quote.context.shippingTerms).toBeUndefined();
    expect(unmountedSnapshot.quote.totalGross.amountMinor).toBe(2500 - 250);
    expect(unmountedSnapshot.quote.totalGross.amountMinor).not.toBe(2500 - 250 + 895);
    expect(promoReads).toBeGreaterThan(0);
  });
});
