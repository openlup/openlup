import { z } from "../../lib/validation/zod.js";

export const ADDRESS_CANON_CONTRACT_VERSION = "address.canon.v1" as const;

const datetimeSchema = z.string().datetime({ offset: true });
// Accept the bare five-digit form (`05074`) and canonicalise it to `NN-NNN`
// before validating, mirroring `formatPostalCodeForCountry` on the field layer
// so the two paths cannot drift. Kept self-contained to avoid a cross-domain
// import into this contract module.
const plPostalCodeSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const digits = value.trim().replace(/\D/g, "");
  return digits.length === 5 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : value.trim();
}, z.string().regex(/^\d{2}-\d{3}$/));

export const addressCanonSourceKindSchema = z.enum(["gus_teryt", "gugik_prg", "poczta_pna"]);
export const addressCanonSourceStatusSchema = z.enum([
  "active",
  "inactive",
  "disabled_pending_license",
]);
export const addressCanonConfidenceSchema = z.enum(["exact", "ambiguous", "partial"]);
export const addressCanonResolutionLevelSchema = z.enum([
  "postal_code",
  "locality",
  "street",
  "address_point",
]);

export const addressCanonSourceSchema = z
  .object({
    sourceKind: addressCanonSourceKindSchema,
    status: addressCanonSourceStatusSchema,
    displayName: z.string().min(1).max(120),
    officialUrl: z.string().url(),
    sourceRevision: z.string().max(120).nullable(),
    sourceUpdatedAt: datetimeSchema.nullable(),
  })
  .strict();

export const addressCanonLocalitySchema = z
  .object({
    localityId: z.guid(),
    countryCode: z.literal("PL"),
    name: z.string().min(1).max(160),
    tercCode: z.string().min(2).max(16),
    simcCode: z.string().min(2).max(16),
    municipalityName: z.string().min(1).max(160).nullable(),
    municipalityTercCode: z.string().min(2).max(16).nullable(),
    countyName: z.string().min(1).max(160).nullable(),
    voivodeshipName: z.string().min(1).max(160).nullable(),
    sources: z.array(addressCanonSourceSchema).min(1),
  })
  .strict();

export const addressCanonLocalityCandidateSchema = addressCanonLocalitySchema
  .extend({
    postalCode: plPostalCodeSchema.nullable(),
    confidence: addressCanonConfidenceSchema,
    resolutionLevel: addressCanonResolutionLevelSchema,
  })
  .strict();

export const addressCanonStreetSchema = z
  .object({
    streetId: z.guid(),
    localityId: z.guid(),
    name: z.string().min(1).max(200),
    ulicCode: z.string().min(1).max(16).nullable(),
    sources: z.array(addressCanonSourceSchema).min(1),
  })
  .strict();

export const addressCanonPostalCodeLookupRequestSchema = z
  .object({
    postalCode: plPostalCodeSchema,
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const addressCanonLocalitiesLookupRequestSchema = z
  .object({
    q: z.string().trim().min(2).max(80),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const addressCanonStreetsLookupRequestSchema = z
  .object({
    localityId: z.guid(),
    q: z.string().trim().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const addressCanonPostalCodeLookupResponseSchema = z
  .object({
    contractVersion: z.literal(ADDRESS_CANON_CONTRACT_VERSION),
    query: z.object({ postalCode: plPostalCodeSchema }).strict(),
    resolutionLevel: z.literal("postal_code"),
    candidates: z.array(addressCanonLocalityCandidateSchema),
    sources: z.array(addressCanonSourceSchema),
  })
  .strict();

export const addressCanonLocalitiesLookupResponseSchema = z
  .object({
    contractVersion: z.literal(ADDRESS_CANON_CONTRACT_VERSION),
    query: z.object({ q: z.string().min(2).max(80) }).strict(),
    resolutionLevel: z.literal("locality"),
    candidates: z.array(addressCanonLocalityCandidateSchema),
    sources: z.array(addressCanonSourceSchema),
  })
  .strict();

export const addressCanonStreetsLookupResponseSchema = z
  .object({
    contractVersion: z.literal(ADDRESS_CANON_CONTRACT_VERSION),
    query: z.object({ localityId: z.guid(), q: z.string().max(80).nullable() }).strict(),
    resolutionLevel: z.literal("street"),
    streets: z.array(addressCanonStreetSchema),
    sources: z.array(addressCanonSourceSchema),
  })
  .strict();

export type AddressCanonSource = z.infer<typeof addressCanonSourceSchema>;
export type AddressCanonLocalityCandidate = z.infer<
  typeof addressCanonLocalityCandidateSchema
>;
export type AddressCanonStreet = z.infer<typeof addressCanonStreetSchema>;
export type AddressCanonPostalCodeLookupRequest = z.infer<
  typeof addressCanonPostalCodeLookupRequestSchema
>;
export type AddressCanonLocalitiesLookupRequest = z.infer<
  typeof addressCanonLocalitiesLookupRequestSchema
>;
export type AddressCanonStreetsLookupRequest = z.infer<
  typeof addressCanonStreetsLookupRequestSchema
>;
export type AddressCanonPostalCodeLookupResponse = z.infer<
  typeof addressCanonPostalCodeLookupResponseSchema
>;
export type AddressCanonLocalitiesLookupResponse = z.infer<
  typeof addressCanonLocalitiesLookupResponseSchema
>;
export type AddressCanonStreetsLookupResponse = z.infer<
  typeof addressCanonStreetsLookupResponseSchema
>;
