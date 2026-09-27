import { z } from "../../lib/validation/zod.js";
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
import { isValidPolishNip, normalizePolishNip } from "../../lib/schemas/fields/taxId.js";

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
      ? normalizePolishNip(request.identifierValue) ?? request.identifierValue
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
  if (country === "PL" && identifierKind === "pl_nip") return isValidPolishNip(value);
  return value.trim().length > 0;
}
