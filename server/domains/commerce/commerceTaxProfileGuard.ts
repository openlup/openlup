import type { CommerceTaxProfile } from "../../../src/domains/commerce/types.js";
import { CommerceQuoteError } from "../../../src/domains/commerce/ports.js";

export function assertSupportedCommerceTaxProfile(
  taxProfile: CommerceTaxProfile,
  supportedTaxProfiles: readonly CommerceTaxProfile[],
): void {
  if (
    !Number.isInteger(taxProfile.vatRateBps) ||
    taxProfile.vatRateBps < 0 ||
    taxProfile.vatRateBps > 10_000
  ) {
    throw new CommerceQuoteError("UNSUPPORTED_TAX_PROFILE", "Unsupported commerce tax profile", {
      reason: "vatRateBps must be an integer between 0 and 10000",
      vatRateBps: taxProfile.vatRateBps,
    });
  }
  const supported = supportedTaxProfiles.some((candidate) =>
    candidate.included === taxProfile.included &&
    candidate.country === taxProfile.country &&
    candidate.category === taxProfile.category &&
    candidate.vatRateBps === taxProfile.vatRateBps &&
    candidate.legalBasis === taxProfile.legalBasis,
  );
  if (!supported) {
    throw new CommerceQuoteError("UNSUPPORTED_TAX_PROFILE", "Unsupported commerce tax profile", {
      country: taxProfile.country,
      category: taxProfile.category,
      vatRateBps: taxProfile.vatRateBps,
      reason: "taxProfile must be declared in supportedTaxProfiles",
    });
  }
}
