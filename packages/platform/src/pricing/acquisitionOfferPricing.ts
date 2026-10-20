import { projectCommerceOfferPricing, type CommerceOfferPricingDeps } from "./commerceOfferPricing.js";
import { COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION, COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, type AcquisitionOfferPricingResponse } from "./contracts/offer.js";
import { ACQUISITION_TERMS_CAPABILITY, type AcquisitionTerms } from "./contracts/acquisitionTerms.js";
import type { CommerceQuoteCatalogItem } from "./commerceQuoteCatalogReadPort.js";
import type { CreateQuoteRequest } from "./contracts/quote.js";
import { ACQUISITION_PROJECTION_MAX_AGE_MS, acquisitionProjectionFreshnessSchema } from "./acquisitionOfferPricingSchemas.js";

export function acquisitionProjectionFreshness(acquisitionTerms: AcquisitionTerms, observedAt: string, nextBoundaryAt?: string | null) {
  const boundary = nextBoundaryAt ?? acquisitionTerms.effectiveTo;
  const validUntil = new Date(Math.min(Date.parse(observedAt) + ACQUISITION_PROJECTION_MAX_AGE_MS,
    boundary == null ? Infinity : Date.parse(boundary))).toISOString();
  return acquisitionProjectionFreshnessSchema.parse({ acquisitionTerms, observedAt, validUntil });
}

/** Explicit opt-in projection; the incumbent projector receives no new defaults. */
export async function projectAcquisitionOfferPricing<Item extends CommerceQuoteCatalogItem, ScopeV1 extends string, ScopeV2 extends string>(
  input: Omit<CommerceOfferPricingDeps<Item, ScopeV1, ScopeV2>, "requestFor"> & {
    acquisitionTerms: AcquisitionTerms;
    observedAt: string;
    nextBoundaryAt?: string | null;
    requestFor(product: Item, mode: "one_time" | "subscription", acquisition: {
      acquisitionCapability: typeof ACQUISITION_TERMS_CAPABILITY; atTime: string;
    }): CreateQuoteRequest;
  },
): Promise<AcquisitionOfferPricingResponse<ScopeV2>> {
  const freshness = acquisitionProjectionFreshness(input.acquisitionTerms, input.observedAt, input.nextBoundaryAt);
  if (input.pricingPolicy?.offerPolicyVersion !== "commerce.offer-policy.v2" ||
    input.pricingPolicy.promotionEngineVersion !== "promotion-engine.v2") {
    throw new Error("commerce_acquisition_projection_policy_invalid");
  }
  const projection = await projectCommerceOfferPricing({ ...input,
    requestFor: (product, mode) => input.requestFor(product, mode, {
      acquisitionCapability: ACQUISITION_TERMS_CAPABILITY, atTime: input.observedAt,
    }),
  });
  if (projection.contractVersion !== COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION) throw new Error("commerce_acquisition_projection_policy_invalid");
  return { ...projection, contractVersion: COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, ...freshness };
}
