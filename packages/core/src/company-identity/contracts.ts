import { z } from "zod";

/** @beta */
export const COMPANY_IDENTITY_CONTRACT_VERSION = "company_identity.lookup.v1" as const;

/** Why the lookup is being performed — lets an adapter apply purpose-specific
 * policy (e.g. stricter verification for a checkout invoice than for a saved
 * billing profile). */
/** @beta */
export const companyIdentityPurposeSchema = z.enum([
  "checkout_invoice",
  "customer_billing_profile",
]);

/**
 * How much the returned company data can be trusted:
 * - `registry_verified` — confirmed against an authoritative registry;
 * - `provider_verified` — confirmed via a commercial data provider (weaker);
 * - `manual_unverified` — supplied by the user, not checked;
 * - `invalid` — the identifier failed format/existence checks.
 */
/** @beta */
export const companyIdentityVerificationLevelSchema = z.enum([
  "registry_verified",
  "provider_verified",
  "manual_unverified",
  "invalid",
]);

/**
 * Outcome of a lookup. Distinguishes "no data" reasons so callers branch on
 * data, not exceptions:
 * - `found` — a single company resolved;
 * - `not_found` — identifier valid but no record;
 * - `partial` — some fields resolved, others missing;
 * - `invalid` — identifier failed format/checksum;
 * - `ambiguous` — more than one candidate;
 * - `unsupported_country` — no adapter for this country;
 * - `provider_unavailable` — transient upstream failure (retryable).
 */
/** @beta */
export const companyIdentityLookupStatusSchema = z.enum([
  "found",
  "not_found",
  "partial",
  "invalid",
  "ambiguous",
  "unsupported_country",
  "provider_unavailable",
]);

/** Per-source outcome inside a lookup (a lookup may consult several sources).
 * Same vocabulary as the overall status minus the request-level
 * `unsupported_country`, which is decided before any source is queried. */
/** @beta */
export const companyIdentitySourceStatusSchema = z.enum([
  "found",
  "not_found",
  "partial",
  "invalid",
  "ambiguous",
  "provider_unavailable",
]);

/** Open, format-validated identifier kind (e.g. a national tax-id scheme key).
 * Deliberately NOT a closed enum: the neutral core does not enumerate
 * country-specific schemes — the host adapter decides which kinds it accepts. */
/** @beta */
export const companyIdentityIdentifierKindSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_:-]+$/);

/** @beta */
export const companyIdentityAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(240),
    postalCode: z.string().trim().min(1).max(16),
    city: z.string().trim().min(1).max(120),
    country: z.string().trim().toUpperCase().length(2),
  })
  .strict();

/** @beta */
export const companyIdentityCompanySchema = z
  .object({
    country: z.string().trim().toUpperCase().length(2),
    identifierKind: companyIdentityIdentifierKindSchema,
    identifierValue: z.string().trim().min(1).max(80),
    legalName: z.string().trim().min(1).max(240).nullable(),
    registeredAddress: companyIdentityAddressSchema.nullable(),
    registryStatus: z.string().trim().min(1).max(80).nullable(),
  })
  .strict();

/** @beta */
export const companyIdentitySourceSchema = z
  .object({
    providerKind: z.string().trim().min(1).max(120),
    status: companyIdentitySourceStatusSchema,
    observedAt: z.string().datetime({ offset: true }),
    evidenceHash: z.string().trim().min(8).max(160).nullable(),
  })
  .strict();

/** A lookup request. `country` is an open ISO-3166 alpha-2 code (not restricted
 * to any single country); `identifierKind`/`identifierValue` name and carry the
 * tax/registry id; `manualCompany` optionally seeds user-entered data an adapter
 * may reconcile against a registry. Parsing normalizes country to upper-case and
 * identifier kind to lower-case. */
/** @beta */
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

/** A lookup result. `status` + `verificationLevel` say what happened and how
 * trustworthy it is; `company` is null unless resolved; `sources` records each
 * consulted provider's per-source outcome; `warnings` carries non-fatal notes. */
/** @beta */
export const companyIdentityLookupResponseSchema = z
  .object({
    contractVersion: z.literal(COMPANY_IDENTITY_CONTRACT_VERSION),
    status: companyIdentityLookupStatusSchema,
    verificationLevel: companyIdentityVerificationLevelSchema,
    company: companyIdentityCompanySchema.nullable(),
    sources: z.array(companyIdentitySourceSchema),
    warnings: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict();

/** @beta */
export type CompanyIdentityLookupRequest = z.infer<typeof companyIdentityLookupRequestSchema>;
/** @beta */
export type CompanyIdentityLookupResponse = z.infer<typeof companyIdentityLookupResponseSchema>;
/** @beta */
export type CompanyIdentityCompany = z.infer<typeof companyIdentityCompanySchema>;
/** @beta */
export type CompanyIdentityPurpose = z.infer<typeof companyIdentityPurposeSchema>;
/** @beta */
export type CompanyIdentitySource = z.infer<typeof companyIdentitySourceSchema>;
/** @beta */
export type CompanyIdentitySourceStatus = z.infer<typeof companyIdentitySourceStatusSchema>;
/** @beta */
export type CompanyIdentityVerificationLevel = z.infer<typeof companyIdentityVerificationLevelSchema>;

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
  const identifierValue = request.identifierValue.trim();

  const normalized = {
    country,
    identifierKind,
    identifierValue,
    purpose: request.purpose,
  };
  if (request.manualCompany) {
    return {
      ...normalized,
      manualCompany: {
        ...request.manualCompany,
        country,
        identifierKind,
        identifierValue,
        registryStatus: request.manualCompany.registryStatus ?? "manual",
      },
    };
  }
  return normalized;
}

/** True when the company has the minimum fields needed to render/persist a full
 * billing identity: legal name plus a complete registered address. Used to gate
 * whether a `partial` lookup is usable for its purpose. */
/** @beta */
export function isCompleteCompanyIdentity(company: CompanyIdentityCompany | null): boolean {
  return Boolean(
    company?.legalName &&
      company.registeredAddress?.line1 &&
      company.registeredAddress.postalCode &&
      company.registeredAddress.city &&
      company.registeredAddress.country,
  );
}
