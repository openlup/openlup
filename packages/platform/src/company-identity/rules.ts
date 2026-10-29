import type { CompanyIdentityRules } from "./contracts/index.js";

/** Country-neutral behaviour. Hosts supply identifier and legal-name policy. */
export const defaultCompanyIdentityRules: CompanyIdentityRules = {
  normalizeIdentifier: (_country, _kind, value) => value,
  isValidIdentifier: (_country, _kind, value) => value.trim().length > 0,
  isFullerLegalName: () => false,
  shouldSeekFullerLegalName: () => false,
};
