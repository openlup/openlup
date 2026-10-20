import type { ResolvedAcquisitionTerms } from "./contracts/acquisitionTerms.js";
import { AcquisitionTermsError } from "./acquisitionTerms.js";
/** Server-selected terms only. Absence contributes no property or token bytes. */
export function acquisitionQuoteBinding(acquisitionTerms?: ResolvedAcquisitionTerms): { acquisitionTerms?: ResolvedAcquisitionTerms } {
  return acquisitionTerms ? { acquisitionTerms } : {};
}
export function mapAcquisitionTermsFailure(error: unknown) {
  if (!(error instanceof AcquisitionTermsError)) return null;
  const refreshRequired = error.reason === "acquisition_terms_capability_required" || error.reason === "acquisition_terms_v2_required";
  return { code: refreshRequired ? "CONFLICT" as const : "UPSTREAM_UNAVAILABLE" as const,
    details: { reason: error.reason, refreshRequired } };
}
