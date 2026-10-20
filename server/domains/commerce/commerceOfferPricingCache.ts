import { createCommerceOfferPricingCache as createCache } from "@openlup/platform/pricing";
import type { CommerceOfferPricingCache as PricingCache } from "@openlup/platform/pricing";
import type { CommerceOfferPricingResponse } from "../../../src/domains/commerce/offerPricingContracts.js";
export type CommerceOfferPricingCache = PricingCache<CommerceOfferPricingResponse>;
export const createCommerceOfferPricingCache = createCache<CommerceOfferPricingResponse>;
