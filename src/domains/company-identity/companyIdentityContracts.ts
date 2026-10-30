import { z } from "../../lib/validation/zod.js";
import {
  createCompanyIdentitySchemas,
  companyIdentityCompanySchema,
  companyIdentityLookupResponseSchema,
  COMPANY_IDENTITY_CONTRACT_VERSION,
  companyIdentityAddressSchema,
  companyIdentityIdentifierKindSchema,
  companyIdentityLookupStatusSchema,
  companyIdentityPurposeSchema,
  companyIdentitySourceSchema,
  companyIdentitySourceStatusSchema,
  companyIdentityVerificationLevelSchema,
  isCompleteCompanyIdentity,
} from "@openlup/platform/company-identity";
import { isValidPolishNip, normalizePolishNip } from "../../lib/schemas/fields/taxId.js";

// The host owns its identifier normalization; strict package schemas retain host extensions.
export const { companyIdentityLookupRequestSchema } = createCompanyIdentitySchemas({
  normalizeIdentifier: (country, kind, value) => country === "PL" && kind === "pl_nip"
    ? normalizePolishNip(value) ?? value : value,
  isValidIdentifier: isValidCompanyIdentifier,
  isFullerLegalName: () => false,
  shouldSeekFullerLegalName: () => false,
});

export type CompanyIdentityLookupRequest = z.infer<typeof companyIdentityLookupRequestSchema>;
export type CompanyIdentityLookupResponse = z.infer<typeof companyIdentityLookupResponseSchema>;
export type CompanyIdentityCompany = z.infer<typeof companyIdentityCompanySchema>;
export type CompanyIdentityPurpose = z.infer<typeof companyIdentityPurposeSchema>;
export type CompanyIdentitySource = z.infer<typeof companyIdentitySourceSchema>;
export type CompanyIdentitySourceStatus = z.infer<typeof companyIdentitySourceStatusSchema>;
export type CompanyIdentityVerificationLevel = z.infer<typeof companyIdentityVerificationLevelSchema>;

export {
  COMPANY_IDENTITY_CONTRACT_VERSION,
  companyIdentityAddressSchema,
  companyIdentityCompanySchema,
  companyIdentityLookupResponseSchema,
  companyIdentityIdentifierKindSchema,
  companyIdentityLookupStatusSchema,
  companyIdentityPurposeSchema,
  companyIdentitySourceSchema,
  companyIdentitySourceStatusSchema,
  companyIdentityVerificationLevelSchema,
  isCompleteCompanyIdentity,
};

export function isValidCompanyIdentifier(country: string, identifierKind: string, value: string): boolean {
  if (identifierKind === "custom") return value.trim().length > 0;
  if (country === "PL" && identifierKind === "pl_nip") return isValidPolishNip(value);
  return value.trim().length > 0;
}
