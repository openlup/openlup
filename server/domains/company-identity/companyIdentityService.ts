import { createCompanyIdentityLookupPort as createPackageLookupPort } from "@openlup/platform/company-identity/server";
import type { CompanyIdentityProvider } from "@openlup/platform/company-identity/server";
import type { CompanyIdentityRules } from "@openlup/platform/company-identity/contracts";
import { addressCanonLocalitySchema } from "../../../src/domains/address-canon/contracts.js";
import { isValidCompanyIdentifier } from "../../../src/domains/company-identity/companyIdentityContracts.js";
import { normalizePolishNip } from "../../../src/lib/schemas/fields/taxId.js";

export type { CompanyIdentityProvider, CompanyIdentityProviderResult } from "@openlup/platform/company-identity/server";

const referenceCompanyCountry = addressCanonLocalitySchema.shape.countryCode.value;
const referenceIdentifierKind = "pl_nip";

/** Existing reference rules remain in their domain owner and feed the package engine. */
export const referenceCompanyIdentityRules: CompanyIdentityRules = {
  normalizeIdentifier: (country, kind, value) =>
    country === referenceCompanyCountry && kind === referenceIdentifierKind
      ? normalizePolishNip(value) ?? value
      : value,
  isValidIdentifier: isValidCompanyIdentifier,
  isFullerLegalName: isFullerSoleProprietorLegalName,
  shouldSeekFullerLegalName: (request, current) =>
    request.country === referenceCompanyCountry && request.identifierKind === referenceIdentifierKind &&
    isLikelyPersonalOnlyLegalName(current.legalName),
};

/** The reference rules retain their original helper exports below. */
export function createCompanyIdentityLookupPort(providersByCountry: Record<string, CompanyIdentityProvider[]>) {
  return createPackageLookupPort(providersByCountry, referenceCompanyIdentityRules);
}

export function isFullerSoleProprietorLegalName(next: string | null, current: string | null): boolean {
  if (!next || !current || !isLikelyPersonalOnlyLegalName(current)) return false;
  const nextNormalized = normalizeLegalName(next);
  const currentNormalized = normalizeLegalName(current);
  if (nextNormalized.length <= currentNormalized.length || nextNormalized === currentNormalized) return false;
  return currentNormalized.split(" ").every((part) => nextNormalized.includes(part));
}

export function isLikelyPersonalOnlyLegalName(value: string | null): boolean {
  if (!value) return false;
  const normalized = normalizeLegalName(value);
  const parts = normalized.split(" ").filter(Boolean);
  return parts.length >= 2 &&
    parts.length <= 4 &&
    !/\b(SP|ZOO|AKCYJNA|SA|FUNDACJA|STOWARZYSZENIE|SPOLKA|SPÓŁKA|SC|S\.C|SKA|KOMANDYTOWA|CYWILNA)\b/.test(normalized);
}

function normalizeLegalName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/["'„”]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("pl-PL");
}
