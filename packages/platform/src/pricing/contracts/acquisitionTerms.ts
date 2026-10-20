/** Opt-in protocol identity; financial schedules belong to the injected policy. */
export const ACQUISITION_TERMS_CAPABILITY = "subscription-acquisition.v1" as const;
export type AcquisitionCapability = typeof ACQUISITION_TERMS_CAPABILITY;
export interface AcquisitionTermsMetadata {
  schemaVersion: AcquisitionCapability;
  revision: string;
  delivery2DiscountBps: number;
}
export interface AcquisitionTerms extends AcquisitionTermsMetadata {
  initialDiscountBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}
export interface ResolvedAcquisitionTerms extends AcquisitionTerms { sourcePromotionId: string }
export interface AcquisitionTermsExpectation { revision: string; delivery2DiscountBps: number }

import type { CreateQuoteRequest, CommerceQuoteContext, CommerceQuote } from "./quote.js";
/** Separate opt-in DTOs; incumbent request/response admission is unchanged. */
export interface AcquisitionQuoteRequest extends CreateQuoteRequest {
  acquisitionCapability?: AcquisitionCapability;
}
export interface AcquisitionQuoteContext extends CommerceQuoteContext {
  acquisitionCapability?: AcquisitionCapability;
  atTime?: string;
}
export interface AcquisitionQuote extends CommerceQuote { acquisitionTerms?: ResolvedAcquisitionTerms }
