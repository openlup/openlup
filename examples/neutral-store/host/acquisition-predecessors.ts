import type { NativeCheckoutDraftRequest, NativeCheckoutDraftResponse } from '@openlup/platform/commerce/server/native-checkout';
import * as promotions from '@openlup/platform/promotions';
import * as checkout from '@openlup/platform/commerce/server/native-checkout';
import type { Pool } from 'pg';
import type { AcquisitionFinancialPolicy, CommerceQuoteDiscount, CreateQuoteResponse } from '@openlup/platform/pricing';
import type { PromotionRow } from '@openlup/core/promo';

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

/** The retained-terms owner supplies the final typed adapter; no private JSON surrogate. */
export interface AcquisitionRenewalBinding {
  assertAvailable(): void;
  activate(input: { orderId: string; acceptedQuote: CreateQuoteResponse; capturedReference: string;
    methodFacts: Pick<import('@openlup/platform/subscriptions').NativeRenewalPurchaseFacts,
      'authorizationRef' | 'unattendedChargeAuthorizedAt' | 'payerAccountRef' | 'methodRef' | 'methodEvidenceRef'>; stockSourceKey: string; templateId: string }): Promise<string>;
}
export const pendingAcquisitionRenewal: AcquisitionRenewalBinding = {
  assertAvailable() { throw new Error('starter_acquisition_renewal_binding_required'); },
  async activate() { throw new Error('starter_acquisition_renewal_binding_required'); },
};
