import { z } from "zod";
import type {
  CarrierRateCapabilities,
  CarrierRateOption,
  CarrierRateQuoteRequest,
  CarrierRateQuoteResult,
  CarrierRateRefusalReason,
} from "./contracts/carrierRate.js";

export const CARRIER_RATE_QUOTE_CONTRACT_VERSION = "shipping.carrier_rate.v1" as const;

export const CARRIER_RATE_REFUSAL_REASONS = [
  "unsupported_country",
  "unsupported_currency",
  "invalid_address",
  "invalid_parcel",
  "multi_parcel_unsupported",
  "service_unsupported",
  "authentication_failed",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "provider_error",
] as const satisfies readonly CarrierRateRefusalReason[];

const ISO_COUNTRY_PATTERN = /^[A-Z]{2}$/;
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/;

const countryFilterSchema = z.union([
  z.literal("any"),
  z.array(z.string().regex(ISO_COUNTRY_PATTERN)).min(1),
]);

export const carrierRateCapabilitiesSchema = z.strictObject({
  contractVersion: z.literal(CARRIER_RATE_QUOTE_CONTRACT_VERSION),
  providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
  multiParcel: z.boolean(),
  dimensionsRequired: z.boolean(),
  supportedOriginCountries: countryFilterSchema,
  supportedDestinationCountries: countryFilterSchema,
  supportedCurrencies: z.array(z.string().regex(ISO_CURRENCY_PATTERN)),
  deliveryKinds: z.array(z.enum(["courier", "parcel-locker"])).min(1),
  requiresCredentials: z.boolean(),
});

export const carrierRateOptionSchema = z.strictObject({
  carrierCode: z.string().min(1).max(64),
  serviceCode: z.string().min(1).max(128),
  serviceName: z.string().min(1).max(160),
  deliveryKind: z.enum(["courier", "parcel-locker"]),
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(ISO_CURRENCY_PATTERN),
  estimatedTransitDays: z
    .strictObject({
      min: z.number().int().min(0),
      max: z.number().int().min(0),
    })
    .refine((v) => v.max >= v.min, "estimatedTransitDays.max must be >= min")
    .nullable()
    .optional(),
  deliveryDateGuaranteed: z.boolean().optional(),
  providerRateRef: z.string().min(1).max(160).optional(),
  expiresAt: z.string().min(1).max(64).nullable().optional(),
});

export const carrierRateQuoteResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("quoted"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    currency: z.string().regex(ISO_CURRENCY_PATTERN),
    rates: z.array(carrierRateOptionSchema).min(1),
    providerShipmentRef: z.string().min(1).max(160).optional(),
  }),
  z.strictObject({
    kind: z.literal("no_rates"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
  }),
  z.strictObject({
    kind: z.literal("refused"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    reason: z.enum(CARRIER_RATE_REFUSAL_REASONS),
    retryable: z.boolean(),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }),
]);

function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function projectCarrierRateStaticCapabilities(
  capabilities: CarrierRateCapabilities,
  options?: { readonly redactSupportedCurrencies?: boolean },
): CarrierRateCapabilities {
  return {
    contractVersion: capabilities.contractVersion,
    providerKind: capabilities.providerKind,
    multiParcel: capabilities.multiParcel,
    dimensionsRequired: capabilities.dimensionsRequired,
    supportedOriginCountries:
      capabilities.supportedOriginCountries === "any"
        ? "any"
        : [...capabilities.supportedOriginCountries].sort(asciiCompare),
    supportedDestinationCountries:
      capabilities.supportedDestinationCountries === "any"
        ? "any"
        : [...capabilities.supportedDestinationCountries].sort(asciiCompare),
    supportedCurrencies: options?.redactSupportedCurrencies
      ? []
      : [...capabilities.supportedCurrencies].sort(asciiCompare),
    deliveryKinds: [...capabilities.deliveryKinds].sort(asciiCompare),
    requiresCredentials: capabilities.requiresCredentials,
  };
}

function refused(
  providerKind: string,
  reason: CarrierRateRefusalReason,
  diagnosticCode: string,
): Extract<CarrierRateQuoteResult, { kind: "refused" }> {
  return { kind: "refused", providerKind, reason, retryable: false, diagnosticCode };
}

/**
 * Pure zero-I/O request validator against declared carrier capabilities.
 * Returns a structured non-retryable refusal or null when the request may be dispatched.
 */
export function validateCarrierRateRequestAgainstCapabilities(
  request: CarrierRateQuoteRequest,
  capabilities: CarrierRateCapabilities,
): Extract<CarrierRateQuoteResult, { kind: "refused" }> | null {
  const { providerKind } = capabilities;
  if (request.contractVersion !== CARRIER_RATE_QUOTE_CONTRACT_VERSION) {
    return refused(providerKind, "provider_error", "UNSUPPORTED_CONTRACT_VERSION");
  }
  if (!request.requestKey || request.requestKey.trim().length === 0) {
    return refused(providerKind, "invalid_address", "MISSING_REQUEST_KEY");
  }
  if (!ISO_COUNTRY_PATTERN.test(request.origin.countryCode) || !request.origin.postalCode.trim()) {
    return refused(providerKind, "invalid_address", "INVALID_ORIGIN_ADDRESS");
  }
  if (
    !ISO_COUNTRY_PATTERN.test(request.destination.countryCode) ||
    !request.destination.postalCode.trim()
  ) {
    return refused(providerKind, "invalid_address", "INVALID_DESTINATION_ADDRESS");
  }
  if (
    capabilities.supportedOriginCountries !== "any" &&
    !capabilities.supportedOriginCountries.includes(request.origin.countryCode)
  ) {
    return refused(providerKind, "unsupported_country", "UNSUPPORTED_ORIGIN_COUNTRY");
  }
  if (
    capabilities.supportedDestinationCountries !== "any" &&
    !capabilities.supportedDestinationCountries.includes(request.destination.countryCode)
  ) {
    return refused(providerKind, "unsupported_country", "UNSUPPORTED_DESTINATION_COUNTRY");
  }
  if (!ISO_CURRENCY_PATTERN.test(request.currency)) {
    return refused(providerKind, "unsupported_currency", "INVALID_CURRENCY");
  }
  if (
    capabilities.supportedCurrencies.length > 0 &&
    !capabilities.supportedCurrencies.includes(request.currency)
  ) {
    return refused(providerKind, "unsupported_currency", "UNSUPPORTED_CURRENCY");
  }
  if (!Array.isArray(request.parcels) || request.parcels.length === 0) {
    return refused(providerKind, "invalid_parcel", "EMPTY_PARCELS");
  }
  if (!capabilities.multiParcel && request.parcels.length > 1) {
    return refused(providerKind, "multi_parcel_unsupported", "MULTI_PARCEL_UNSUPPORTED");
  }
  for (const parcel of request.parcels) {
    if (!Number.isSafeInteger(parcel.weightGrams) || parcel.weightGrams <= 0) {
      return refused(providerKind, "invalid_parcel", "INVALID_PARCEL_WEIGHT");
    }
    const dims = [parcel.lengthMm, parcel.widthMm, parcel.heightMm];
    const hasAnyDim = dims.some((d) => d !== undefined);
    const hasAllValidDims = dims.every((d) => typeof d === "number" && Number.isSafeInteger(d) && d > 0);
    if (capabilities.dimensionsRequired && !hasAllValidDims) {
      return refused(providerKind, "invalid_parcel", "PARCEL_DIMENSIONS_REQUIRED");
    }
    if (hasAnyDim && !hasAllValidDims) {
      return refused(providerKind, "invalid_parcel", "INVALID_PARCEL_DIMENSIONS");
    }
    if (
      parcel.declaredValueMinor !== undefined &&
      (!Number.isSafeInteger(parcel.declaredValueMinor) || parcel.declaredValueMinor < 0)
    ) {
      return refused(providerKind, "invalid_parcel", "INVALID_DECLARED_VALUE");
    }
  }
  return null;
}

/** Deterministic comparator: lowest integer minor-unit price, then carrierCode, then serviceCode. */
export function sortCarrierRateOptions(rates: readonly CarrierRateOption[]): CarrierRateOption[] {
  return [...rates].sort((a, b) => {
    if (a.amountMinor !== b.amountMinor) return a.amountMinor - b.amountMinor;
    const carrierCmp = asciiCompare(a.carrierCode, b.carrierCode);
    if (carrierCmp !== 0) return carrierCmp;
    return asciiCompare(a.serviceCode, b.serviceCode);
  });
}

export function selectCheapestCarrierRate(
  rates: readonly CarrierRateOption[],
): CarrierRateOption | null {
  if (rates.length === 0) return null;
  return sortCarrierRateOptions(rates)[0] ?? null;
}
