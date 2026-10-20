import { projectCommerceOfferPricing as projectPricing } from "@openlup/platform/pricing";
import type { CommerceOfferPricingResponse } from "../../../src/domains/commerce/offerPricingContracts.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
import { COMMERCE_MIN_AUTO_ORDER_UNITS } from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import { MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";
import type { CommerceQuoteCatalogItem, CommerceQuoteCatalogReadPort } from "./commerceQuoteCatalogReadPort.js";
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
    scopeV1: "dog_products_only_excludes_shipping",
    scopeV2: "dog_products_and_shipping",
  });
}

function isOfferProduct(product: CommerceQuoteCatalogItem): boolean {
  return (
    product.species === "dog" &&
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
