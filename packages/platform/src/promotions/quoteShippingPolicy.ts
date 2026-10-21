import { PROMOTION_ENGINE_V2 } from "../pricing/index.js";
import type { CreateQuoteRequest, QuoteShippingPromotionInput, QuoteShippingPromotionResult } from "../pricing/index.js";
import { resolveShippingPolicy, resolveThresholdShipping } from "../shipping/index.js";
import type { ShippingSettings } from "../shipping/index.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { PromotionCodeQuotePort } from "./promotionCodeQuotePort.js";
import type { createQuoteAutomaticPromotions } from "./quoteAutomaticPromotions.js";
import type { createQuotePromotionCodeAdjustments } from "./quotePromotionCodeAdjustments.js";
import { memoizeCommercePromoReads } from "./commerceQuoteReadPreparation.js";

export interface QuoteShippingPromotionsDeps<Request extends CreateQuoteRequest & { visitorId?: string }> {
  promoDataPort?: CommercePromoDataPort;
  promotionCodeQuotePort?: PromotionCodeQuotePort;
  commerceSettingsPort?: { getShippingSettings(): Promise<ShippingSettings> };
  resolveAutomaticQuotePromotions: ReturnType<typeof createQuoteAutomaticPromotions<Request>>["resolveAutomaticQuotePromotions"];
  applyPromotionCodesV2: ReturnType<typeof createQuotePromotionCodeAdjustments>["applyPromotionCodesV2"];
}
/** Evaluate both lanes again only when the post-product-discount threshold changes the fee. */
export function createQuoteShippingPromotions<Request extends CreateQuoteRequest & { visitorId?: string }>(deps: QuoteShippingPromotionsDeps<Request>) {
  async function resolveQuoteShippingPromotions(input: QuoteShippingPromotionInput<Request>): Promise<QuoteShippingPromotionResult> {
    const settings = deps.commerceSettingsPort
      ? await deps.commerceSettingsPort.getShippingSettings()
      : { legacyFlatMinor: 0, policy: null };
    const shipping = resolveShippingPolicy(settings, input.atTime, input.currency);
    const promoDataPort = deps.promoDataPort ? memoizeCommercePromoReads(deps.promoDataPort) : undefined;
    let candidates: ReturnType<PromotionCodeQuotePort["resolve"]> | undefined;
    const port: PromotionCodeQuotePort | undefined = deps.promotionCodeQuotePort ? {
      resolve: async (request) => structuredClone(await (candidates ??= deps.promotionCodeQuotePort!.resolve(request))),
    } : undefined;
    async function evaluate(shippingGrossMinor: number) {
      const automatic = await deps.resolveAutomaticQuotePromotions({ ...input, promoDataPort, shippingGrossMinor });
      const adjusted = await deps.applyPromotionCodesV2({
        port,
        preserveLegacyDiscountsWhenNoCandidates: input.options?.pricingPolicy?.promotionEngineVersion !== PROMOTION_ENGINE_V2,
        clientId: input.options?.clientId ?? null,
        mode: input.request.mode,
        promoCodes: input.request.promoCodes,
        referenceProductMinor: input.referenceProductMinor,
        subtotalGrossMinor: input.subtotalGrossMinor,
        shippingGrossMinor,
        discounts: automatic.discounts,
        codeRejections: automatic.codeRejections,
        atTime: input.atTime,
      });
      return { ...adjusted, acquisitionTerms: automatic.acquisitionTerms };
    }
    let shippingGrossMinor = shipping.flatMinor;
    let result = await evaluate(shippingGrossMinor);
    const productDiscount = result.discounts.filter((discount) => discount.appliesTo !== "shipping")
      .reduce((total, discount) => total + discount.amountOffMinor, 0);
    if (shipping.terms) {
      const resolved = resolveThresholdShipping(shipping.terms, input.subtotalGrossMinor - productDiscount);
      if (resolved.grossMinor !== shippingGrossMinor) {
        shippingGrossMinor = resolved.grossMinor;
        result = await evaluate(shippingGrossMinor);
      }
    }
    return { ...result, shippingGrossMinor, shippingTerms: shipping.terms, hasShipping: deps.commerceSettingsPort != null };
  }
  return { resolveQuoteShippingPromotions };
}
