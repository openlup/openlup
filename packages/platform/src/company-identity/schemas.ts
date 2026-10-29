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
import type { CompanyIdentityRules } from "./contracts/index.js";
import { defaultCompanyIdentityRules } from "./rules.js";

export const companyIdentityCompanySchema = z
  .object({
    ...coreCompanyIdentityCompanySchema.shape,
    regon: z.string().trim().min(7).max(14).nullable().optional(),
    vatStatus: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

/** Build strict host-extension validators with explicit identifier normalization. */
export function createCompanyIdentitySchemas(rules: CompanyIdentityRules = defaultCompanyIdentityRules) {
  // Extend the core input shape only for the existing registry-specific fields.
  const companyIdentityLookupRequestSchema = coreCompanyIdentityLookupRequestSchema.in
    .extend({
      manualCompany: companyIdentityCompanySchema.partial({
        identifierKind: true,
        identifierValue: true,
        country: true,
        registryStatus: true,
      }).optional(),
    })
    .transform((request) => {
      const identifierValue = rules.normalizeIdentifier(request.country, request.identifierKind, request.identifierValue);
      const normalized = normalizeCompanyIdentityLookupRequest({ ...request, identifierValue });
      return {
        ...normalized,
        ...(normalized.manualCompany ? {
          manualCompany: { ...request.manualCompany, ...normalized.manualCompany },
        } : {}),
      };
    });

  return { companyIdentityCompanySchema, companyIdentityLookupRequestSchema, companyIdentityLookupResponseSchema };
}

export const companyIdentityLookupResponseSchema = coreCompanyIdentityLookupResponseSchema
  .extend({
    company: companyIdentityCompanySchema.nullable(),
  })
  .strict();

export const { companyIdentityLookupRequestSchema } = createCompanyIdentitySchemas();

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

export function isValidCompanyIdentifier(
  country: string, identifierKind: string, value: string,
  rules: CompanyIdentityRules = defaultCompanyIdentityRules,
): boolean {
  if (identifierKind === "custom") return value.trim().length > 0;
  return rules.isValidIdentifier(country, identifierKind, value);
}
