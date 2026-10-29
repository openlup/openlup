import { createCompanyIdentitySchemas } from "@openlup/platform/company-identity";
import type { CompanyIdentityRules } from "@openlup/platform/company-identity/contracts";
import { addressCanonLocalitySchema } from "../../../src/domains/address-canon/contracts.js";
import { isValidCompanyIdentifier } from "../../../src/domains/company-identity/companyIdentityContracts.js";
import { normalizePolishNip } from "../../../src/lib/schemas/fields/taxId.js";
import {
  isFullerSoleProprietorLegalName,
  isLikelyPersonalOnlyLegalName,
} from "../../domains/company-identity/companyIdentityService.js";

/** Existing reference jurisdiction, imported rather than stated as a platform fact. */
export const referenceCompanyCountry = addressCanonLocalitySchema.shape.countryCode.value;

/** Opt-in reference policy; the engine owns completeness, sequencing and cache scope. */
export const referenceCompanyIdentityRules: CompanyIdentityRules = {
  normalizeIdentifier: (country, kind, value) =>
    country === referenceCompanyCountry && kind === "pl_nip"
      ? normalizePolishNip(value) ?? value
      : value,
  isValidIdentifier: isValidCompanyIdentifier,
  // Deliberately country-independent, matching the existing replacement heuristic.
  isFullerLegalName: isFullerSoleProprietorLegalName,
  shouldSeekFullerLegalName: (request, current) =>
    request.country === referenceCompanyCountry && request.identifierKind === "pl_nip" &&
    isLikelyPersonalOnlyLegalName(current.legalName),
};

/** Same strict host extensions as the current reference, through R1's rules seam. */
export const referenceCompanyIdentitySchemas = createCompanyIdentitySchemas(referenceCompanyIdentityRules);
