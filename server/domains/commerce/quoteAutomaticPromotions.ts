import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { PROMOTION_ENGINE_V2 } from "../../../src/domains/commerce/offerPolicyContracts.js";
import type { CreateQuoteOptions } from "../../../src/domains/commerce/ports.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import { evaluateOrderTotalDiscounts, type QuoteDiscountResult } from "./quotePromoDiscounts.js";
import { evaluateAutomaticPromotionV2, legacyPromotionDataPort } from "./quotePromotionV2.js";

export async function resolveAutomaticQuotePromotions(input: {
  promoDataPort?: CommercePromoDataPort;
  request: CreateQuoteRequest;
  options?: CreateQuoteOptions;
  regionCode: string;
  referenceProductMinor: number;
  subtotalGrossMinor: number;
  shippingGrossMinor: number;
  atTime: string;
}): Promise<QuoteDiscountResult> {
  if (!input.promoDataPort) return { discounts: [], codeRejections: [] };

  const emailEligibilityConfirmed = Boolean(
    input.request.customerEligibilityContext?.email ??
      input.request.customerEligibilityContext?.contactEmail,
  );
  if (input.options?.pricingPolicy?.promotionEngineVersion === PROMOTION_ENGINE_V2) {
    return evaluateAutomaticPromotionV2({
      promoDataPort: input.promoDataPort,
      clientId: input.options.clientId ?? null,
      visitorId: input.request.visitorId ?? null,
      mode: input.request.mode,
      promoCodes: input.request.promoCodes,
      regionCode: input.regionCode,
      referenceProductMinor: input.referenceProductMinor,
      currentProductMinor: input.subtotalGrossMinor,
      shippingMinor: input.shippingGrossMinor,
      atTime: input.atTime,
      emailEligibilityConfirmed,
    });
  }

  return evaluateOrderTotalDiscounts({
    promoDataPort: legacyPromotionDataPort(input.promoDataPort),
    clientId: input.options?.clientId ?? null,
    visitorId: input.request.visitorId ?? null,
    mode: input.request.mode,
    promoCodes: input.request.promoCodes,
    regionCode: input.regionCode,
    subtotalGrossMinor: input.subtotalGrossMinor,
    shippingGrossMinor: input.shippingGrossMinor,
    atTime: input.atTime,
    emailEligibilityConfirmed,
  });
}
