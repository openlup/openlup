import { projectCommerceOfferPricing as projectPricing } from "../../src/pricing/index.js";
import type { PricingPolicySnapshot } from "../../src/pricing/index.js";
import type { CommerceOfferPricingResponse, CommerceQuotePort, CreateQuoteRequest } from "./quoteSchemaFixtures.js";
import type { CommerceQuoteCatalogItem, CommerceQuoteCatalogReadPort } from "./catalogFixtures.js";
export const COMMERCE_MIN_AUTO_ORDER_UNITS = 14;
const MINIMUM_PRODUCT_PAYABLE_MINOR = 100;
/** Representative first package cadence; pricing remains per-unit/product-only. */
export const OFFER_PROJECTION_CADENCE_DAYS = 14;

export interface CommerceOfferPricingDeps {
  quoteCatalogReadPort: CommerceQuoteCatalogReadPort;
  quoteWithPromotions: CommerceQuotePort;
  quoteWithoutPromotions: CommerceQuotePort;
  pricingPolicy?: PricingPolicySnapshot;
}

export function projectCommerceOfferPricing(deps: CommerceOfferPricingDeps): Promise<CommerceOfferPricingResponse> {
  return projectPricing({ ...deps, isOfferProduct, requestFor,
    unitCount: COMMERCE_MIN_AUTO_ORDER_UNITS,
    minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
    scopeV1: "example_products_only_excludes_shipping",
    scopeV2: "example_products_and_shipping",
  });
}

function isOfferProduct(product: CommerceQuoteCatalogItem): boolean {
  return (
    product.segment === "segment_a" &&
    product.isPrimarySku === true &&
    product.isAddon !== true &&
    product.sellability.oneTime &&
    product.sellability.subscription
  );
}

function requestFor(
  product: CommerceQuoteCatalogItem,
  mode: "one_time" | "subscription",
): CreateQuoteRequest {
  return {
    mode,
    lines: [
      {
        sku: product.skuCode,
        variantId: product.variantId,
        quantity: COMMERCE_MIN_AUTO_ORDER_UNITS,
        modeAtLine: mode,
      },
    ],
    ...(mode === "subscription"
      ? { cadenceDays: OFFER_PROJECTION_CADENCE_DAYS }
      : {}),
    promoCodes: [],
  };
}
