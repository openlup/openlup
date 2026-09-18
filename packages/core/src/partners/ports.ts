import type {
  PartnersB2BInquiryStatusUpdateRequest,
  PartnersB2BInquiryStatusUpdateResponse,
} from "./status.js";

/**
 * Persistence seam for advancing a B2B inquiry's pipeline status. The host
 * application supplies the adapter (e.g. a DB-backed store, a CRM bridge); the
 * core only owns this contract, not where inquiries are stored. Implementations
 * should reject (throw) when the inquiry does not exist or the transition is
 * not allowed, rather than resolving with a non-updated result.
 */
/** @beta */
export interface PartnersB2BInquiryStatusUpdatePort {
  updateB2BInquiryStatus(
    request: PartnersB2BInquiryStatusUpdateRequest,
  ): Promise<PartnersB2BInquiryStatusUpdateResponse>;
}
