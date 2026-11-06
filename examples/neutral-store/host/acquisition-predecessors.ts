import type { NativeCheckoutDraftRequest, NativeCheckoutDraftResponse } from '@openlup/platform/commerce/server/native-checkout';
import * as promotions from '@openlup/platform/promotions';
import * as checkout from '@openlup/platform/commerce/server/native-checkout';
import type { Pool } from 'pg';
import type { AcquisitionFinancialPolicy, CommerceQuoteDiscount, CreateQuoteResponse } from '@openlup/platform/pricing';
import type { PromotionRow } from '@openlup/core/promo';
import { activateNativePurchaseWithRenewal, type NativeRenewalPurchaseFacts } from '@openlup/platform/subscriptions';
import type { RenewalRetainedTerms } from '@openlup/platform/subscriptions/contracts';
import { canonicalCatalogDraftJson } from '@openlup/platform/catalog';

/** Local integration seam until the installed predecessor's API is frozen. */
export interface AcquisitionPredecessors {
  eligibility(db: Pool): { resolve(email: string | null): Promise<{ clientId: string | null }> };
  checkout(db: Pool, options: { regionCode: string; financialPolicy: AcquisitionFinancialPolicy<PromotionRow>;
    isAcquisitionDiscount(discount: CommerceQuoteDiscount): boolean }): {
    createOrderDraft(request: NativeCheckoutDraftRequest, identity: { clientId: string }): Promise<NativeCheckoutDraftResponse>;
  };
}

/** No lower-level draft fallback: acquisition admission must retain its transaction. */
export function installedAcquisitionPredecessors(): AcquisitionPredecessors {
  const eligibility = (promotions as unknown as { createPostgresQuoteCustomerEligibility?: AcquisitionPredecessors['eligibility'] }).createPostgresQuoteCustomerEligibility;
  const draft = (checkout as unknown as { createPostgresAcquisitionCheckoutPersistence?: AcquisitionPredecessors['checkout'] }).createPostgresAcquisitionCheckoutPersistence;
  return {
    eligibility(db) {
      if (!eligibility) throw new Error('starter_acquisition_eligibility_binding_required');
      return eligibility(db);
    },
    checkout(db, options) {
      if (!draft) throw new Error('starter_acquisition_admission_binding_required');
      return draft(db, options);
    },
  };
}

/** Accepted quote evidence is consumed through the installed retained-terms writer. */
export interface AcquisitionRenewalBinding {
  assertAvailable(acceptedQuote?: CreateQuoteResponse): void;
  activate(input: { orderId: string; acceptedQuote: CreateQuoteResponse; capturedReference: string;
    methodFacts: Pick<import('@openlup/platform/subscriptions').NativeRenewalPurchaseFacts,
      'authorizationRef' | 'unattendedChargeAuthorizedAt' | 'payerAccountRef' | 'methodRef' | 'methodEvidenceRef'>; stockSourceKey: string; templateId: string }): Promise<string>;
}
/** No allocated paid units or current configuration enter future renewal facts. */
export function createAcquisitionRenewalBinding(db: Pool): AcquisitionRenewalBinding {
  return {
    assertAvailable: retainedQuoteTerms,
    async activate(input) {
      const renewalTerms = retainedQuoteTerms(input.acceptedQuote);
      const quote = input.acceptedQuote.quote;
      const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: 'sandbox', ...input.methodFacts,
        stockSourceKey: input.stockSourceKey, templateId: input.templateId, currency: quote.currency,
        cadenceDays: quote.context!.cadenceDays!, shippingAmountMinor: 0,
        acquisitionRef: (quote.context as NonNullable<typeof quote.context> & { acquisitionTerms: { sourcePromotionId: string } }).acquisitionTerms.sourcePromotionId,
        lines: quote.lines.map((line, index) => ({ lineOrdinal: index + 1, sku: line.sku,
          quantity: line.quantity, unitAmountMinor: line.unitPriceGross.amountMinor })), renewalTerms };
      return (await activateNativePurchaseWithRenewal(db, { orderId: input.orderId,
        idempotencyKey: `activate:${input.orderId}`, capturedReference: input.capturedReference, facts })).renewalAttachment;
    },
  };
}

export function retainedQuoteTerms(snapshot?: CreateQuoteResponse): RenewalRetainedTerms {
  const quote = snapshot?.quote;
  const context = quote?.context as { mode?: string; cadenceDays?: number;
    acquisitionTerms?: { sourcePromotionId?: unknown; delivery2DiscountBps: number }; starterRenewalTerms?: RenewalRetainedTerms } | undefined;
  const terms = context?.starterRenewalTerms, marker = terms?.starterPack;
  if (!quote || context?.mode !== 'subscription' || !context.acquisitionTerms
    || typeof context.acquisitionTerms.sourcePromotionId !== 'string' || !context.acquisitionTerms.sourcePromotionId
    || terms?.version !== 'native.renewal-terms.v1' || terms.shippingTerms !== undefined
    || !marker || marker.starterIntervalDays !== context.cadenceDays
    || !terms.minimumPayableMinor || !terms.normalCadenceDays?.includes(marker.graduation.cadenceDays)
    || marker.delivery2.discountBps !== context.acquisitionTerms.delivery2DiscountBps
    || marker.delivery2.basisSubtotalMinor !== quote.subtotalGross.amountMinor
    || !Number.isSafeInteger(marker.delivery2.discountMinor) || marker.delivery2.discountMinor < 0
    || marker.delivery2.basisSubtotalMinor - marker.delivery2.discountMinor < terms.minimumPayableMinor
    || (quote.shippingGross?.amountMinor ?? 0) !== 0 || (quote.shippingDiscountGross?.amountMinor ?? 0) !== 0
    || terms.linePricing?.length !== quote.lines.length || marker.graduation.lines.length !== quote.lines.length
    || quote.lines.some((line, index) => {
      const price = terms.linePricing![index], graduation = marker.graduation.lines[index];
      if (!price?.quoteLine || !graduation?.quoteLine) return true;
      const evidence = { ...price.quoteLine }, visible = { ...line };
      const catalog = evidence.catalogFacts as { version?: string } | undefined;
      delete evidence.catalogFacts;
      delete visible.catalogFacts;
      return price.sku !== line.sku || price.quantity !== line.quantity
        || price.unitAmountMinor !== line.unitPriceGross.amountMinor || price.isAddon !== false
        || graduation.sku !== line.sku || graduation.qty !== line.quantity || graduation.isAddon !== false
        || graduation.sortOrder !== index || catalog?.version !== 'catalog_facts_v2'
        || (line.catalogFacts !== undefined && canonicalCatalogDraftJson(price.quoteLine.catalogFacts) !== canonicalCatalogDraftJson(line.catalogFacts))
        || canonicalCatalogDraftJson(evidence) !== canonicalCatalogDraftJson(visible)
        || canonicalCatalogDraftJson(graduation.quoteLine) !== canonicalCatalogDraftJson(price.quoteLine);
    })) throw new Error('starter_quote_refresh_required');
  return terms;
}
