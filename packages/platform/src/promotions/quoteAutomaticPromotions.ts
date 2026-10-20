import type { CreateQuoteRequest } from "../pricing/index.js";
import { PROMOTION_ENGINE_V2 } from "../pricing/index.js";
import type { CreateQuoteOptions } from "../pricing/index.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { createQuotePromoDiscounts, QuoteDiscountResult } from "./quotePromoDiscounts.js";
import type { createQuotePromotionV2 } from "./quotePromotionV2.js";

export function createQuoteAutomaticPromotions<Request extends CreateQuoteRequest & { visitorId?: string }>({ resolveEmailEligibility, evaluateOrderTotalDiscounts, evaluateAutomaticPromotionV2, legacyPromotionDataPort }: {
  resolveEmailEligibility(request: Request): boolean;
  evaluateOrderTotalDiscounts: ReturnType<typeof createQuotePromoDiscounts>["evaluateOrderTotalDiscounts"];
  evaluateAutomaticPromotionV2: ReturnType<typeof createQuotePromotionV2>["evaluateAutomaticPromotionV2"];
  legacyPromotionDataPort: ReturnType<typeof createQuotePromotionV2>["legacyPromotionDataPort"];
}) {
  async function resolveAutomaticQuotePromotions(input: {
    promoDataPort?: CommercePromoDataPort;
    request: Request;
    options?: CreateQuoteOptions;
    regionCode: string;
    referenceProductMinor: number;
    subtotalGrossMinor: number;
    shippingGrossMinor: number;
    atTime: string;
  }): Promise<QuoteDiscountResult> {
    if (!input.promoDataPort) return { discounts: [], codeRejections: [] };

    const emailEligibilityConfirmed = resolveEmailEligibility(input.request);
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

  return { resolveAutomaticQuotePromotions };
}
