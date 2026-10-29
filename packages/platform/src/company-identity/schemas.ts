import { z } from "zod";
import {
  COMPANY_IDENTITY_CONTRACT_VERSION,
  companyIdentityAddressSchema,
  companyIdentityCompanySchema as coreCompanyIdentityCompanySchema,
  companyIdentityIdentifierKindSchema,
  companyIdentityLookupResponseSchema as coreCompanyIdentityLookupResponseSchema,
  companyIdentityLookupRequestSchema as coreCompanyIdentityLookupRequestSchema,
  normalizeCompanyIdentityLookupRequest,
  companyIdentityLookupStatusSchema,
  companyIdentityPurposeSchema,
  companyIdentitySourceSchema,
  companyIdentitySourceStatusSchema,
  companyIdentityVerificationLevelSchema,
  isCompleteCompanyIdentity,
} from "@openlup/core/company-identity";


export const companyIdentityCompanySchema = z
  .object({
    ...coreCompanyIdentityCompanySchema.shape,
    regon: z.string().trim().min(7).max(14).nullable().optional(),
    vatStatus: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

// Extend the core input shape only for the existing registry-specific fields.
export const companyIdentityLookupRequestSchema = coreCompanyIdentityLookupRequestSchema.in
  .extend({
    manualCompany: companyIdentityCompanySchema.partial({
      identifierKind: true,
      identifierValue: true,
      country: true,
      registryStatus: true,
    }).optional(),
  })
  .transform((request) => {
    const identifierValue = request.country === "PL" && request.identifierKind === "pl_nip"
      ? normalizeCompanyTaxIdentifier(request.identifierValue) ?? request.identifierValue
      : request.identifierValue;
    const normalized = normalizeCompanyIdentityLookupRequest({ ...request, identifierValue });
    return {
      ...normalized,
      ...(normalized.manualCompany ? {
        manualCompany: { ...request.manualCompany, ...normalized.manualCompany },
      } : {}),
    };
  });

export const companyIdentityLookupResponseSchema = coreCompanyIdentityLookupResponseSchema
  .extend({
    company: companyIdentityCompanySchema.nullable(),
  })
  .strict();

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
  if (country === "PL" && identifierKind === "pl_nip") return isValidCompanyTaxIdentifier(value);
  return value.trim().length > 0;
}

function normalizeCompanyTaxIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  const withoutCountryPrefix = trimmed.replace(/^\s*PL[\s-]*/i, "");
  const digits = withoutCountryPrefix.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function isValidCompanyTaxIdentifier(value: string | null | undefined): boolean {
  const digits = normalizeCompanyTaxIdentifier(value);
  if (!digits || !/^\d{10}$/.test(digits)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11;
  return checksum !== 10 && checksum === Number(digits[9]);
}
