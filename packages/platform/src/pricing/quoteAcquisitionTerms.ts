import type { AcquisitionTermsExpectation, ResolvedAcquisitionTerms } from "./contracts/acquisitionTerms.js";
export function acquisitionExpectationChanged(
  expected: AcquisitionTermsExpectation | undefined,
  actual: ResolvedAcquisitionTerms | undefined,
): boolean {
  return expected !== undefined && (
    expected.revision !== actual?.revision ||
    expected.delivery2DiscountBps !== actual?.delivery2DiscountBps
  );
}
