import { selectAcquisitionTerms, assertAcquisitionTermsCapability, ACQUISITION_TERMS_CAPABILITY } from "../pricing/index.js";
import type { QuoteAcquisitionBinding } from "./quoteAcquisitionBinding.js";
import type { CreateQuoteRequest } from "../pricing/index.js";
import { PROMOTION_ENGINE_V2 } from "../pricing/index.js";
import type { CreateQuoteOptions } from "../pricing/index.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { createQuotePromoDiscounts, QuoteDiscountResult } from "./quotePromoDiscounts.js";
import type { createQuotePromotionV2 } from "./quotePromotionV2.js";

export function createQuoteAutomaticPromotions<Request extends CreateQuoteRequest & { visitorId?: string }>({ resolveEmailEligibility, evaluateOrderTotalDiscounts, evaluateAutomaticPromotionV2, legacyPromotionDataPort, acquisition }: {
  acquisition?: QuoteAcquisitionBinding<Request>;
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

    let promoDataPort = input.promoDataPort;
    let selection = null;
    let acquisitionCapability: unknown;
    if (acquisition) {
      const clientId = input.options?.clientId ?? null;
      const [paid, allRows] = await Promise.all([
        clientId ? promoDataPort.countPaidOrdersByMode(clientId) : Promise.resolve({ oneTime: 0, subscription: 0 }),
        promoDataPort.listActivePromotions(),
      ]);
      const existingSubscriber = input.request.mode === "subscription" && paid.subscription > 0;
      const rows = existingSubscriber ? allRows.filter((row) =>
        !acquisition.financialPolicy.facts(row).metadataPresent && row.eligibility.first_subscription_purchase !== true) : allRows;
      promoDataPort = { ...promoDataPort, listActivePromotions: async () => rows, countPaidOrdersByMode: async () => paid };
      selection = input.request.mode === "subscription" && !existingSubscriber
        ? selectAcquisitionTerms(rows, input.atTime, input.regionCode, acquisition.financialPolicy) : null;
      acquisitionCapability = acquisition.capability(input.request);
      assertAcquisitionTermsCapability(selection, acquisitionCapability, input.options?.pricingPolicy?.promotionEngineVersion);
    }
    const emailEligibilityConfirmed = resolveEmailEligibility(input.request);
    if (input.options?.pricingPolicy?.promotionEngineVersion === PROMOTION_ENGINE_V2) {
      return evaluateAutomaticPromotionV2({
        promoDataPort,
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
        ...(acquisition ? { acquisitionCapability } : {}),
      });
    }

    const pending = evaluateOrderTotalDiscounts({
      promoDataPort: legacyPromotionDataPort(promoDataPort),
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
    if (!acquisition) return pending;
    const result = await pending;
    return selection && acquisitionCapability === ACQUISITION_TERMS_CAPABILITY
      ? { ...result, acquisitionTerms: selection.terms } : result;
  }

  return { resolveAutomaticQuotePromotions };
}
