import { z } from "../../lib/validation/zod.js";
import {
  COMPANY_IDENTITY_CONTRACT_VERSION,
  companyIdentityAddressSchema,
  companyIdentityCompanySchema as coreCompanyIdentityCompanySchema,
  companyIdentityIdentifierKindSchema,
  companyIdentityLookupResponseSchema as coreCompanyIdentityLookupResponseSchema,
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

export const companyIdentityLookupRequestSchema = z
  .object({
    country: z.string().trim().toUpperCase().length(2),
    identifierKind: companyIdentityIdentifierKindSchema,
    identifierValue: z.string().trim().min(1).max(120),
    purpose: companyIdentityPurposeSchema,
    manualCompany: companyIdentityCompanySchema.partial({
      identifierKind: true,
      identifierValue: true,
      country: true,
      registryStatus: true,
    }).optional(),
  })
  .strict()
  .transform((request) => normalizeCompanyIdentityLookupRequest(request as NormalizableCompanyIdentityLookupRequest));

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

interface NormalizableCompanyIdentityLookupRequest {
  country: string;
  identifierKind: string;
  identifierValue: string;
  purpose: CompanyIdentityPurpose;
  manualCompany?: Partial<CompanyIdentityCompany>;
}

function normalizeCompanyIdentityLookupRequest(
  request: NormalizableCompanyIdentityLookupRequest,
): NormalizableCompanyIdentityLookupRequest {
  const country = String(request.country).trim().toUpperCase();
  const identifierKind = String(request.identifierKind).trim().toLowerCase();
  const normalizedIdentifier =
    country === "PL" && identifierKind === "pl_nip"
      ? normalizePolishNip(request.identifierValue) ?? request.identifierValue.trim()
      : request.identifierValue.trim();

  const normalized = {
    country,
    identifierKind,
    identifierValue: normalizedIdentifier,
    purpose: request.purpose,
  };
  if (request.manualCompany) {
    return {
      ...normalized,
      manualCompany: {
        ...request.manualCompany,
        country,
        identifierKind,
        identifierValue: normalizedIdentifier,
        registryStatus: request.manualCompany.registryStatus ?? "manual",
      },
    };
  }
  return normalized;
}

export function isValidCompanyIdentifier(country: string, identifierKind: string, value: string): boolean {
  if (identifierKind === "custom") return value.trim().length > 0;
  if (country === "PL" && identifierKind === "pl_nip") return isValidPolishNip(value);
  return value.trim().length > 0;
}
