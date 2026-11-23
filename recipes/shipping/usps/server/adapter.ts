import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  projectCarrierRateStaticCapabilities,
  sortCarrierRateOptions,
  validateCarrierRateRequestAgainstCapabilities,
} from "@openlup/platform/shipping";
import type {
  CarrierRateCapabilities,
  CarrierRateOption,
  CarrierRateQuotePort,
  CarrierRateQuoteRequest,
  CarrierRateQuoteResult,
  CarrierRateTransitEstimate,
} from "@openlup/platform/shipping/contracts";
import type {
  UspsBaseRatesSearchRequest,
  UspsDestinationEntryFacilityType,
  UspsPriceType,
  UspsProcessingCategory,
  UspsRateClient,
  UspsRateDetail,
  UspsRateOption,
} from "./client-contract.js";
import { UspsTransportError } from "./client-contract.js";
import { UspsOAuth2Error } from "./oauth.js";

export const USPS_PROVIDER_KIND = "usps" as const;
export const USPS_CARRIER_CODE = "usps" as const;

const GRAMS_PER_POUND = 453.59237;
const MM_PER_INCH = 25.4;
const US_ZIP_REGEX = /^(\d{5})(?:-\d{4})?$/u;
const DECIMAL_STRING_REGEX = /^\d+(?:\.\d+)?$/u;

export const uspsCarrierRateCapabilities: CarrierRateCapabilities = Object.freeze({
  contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  providerKind: USPS_PROVIDER_KIND,
  multiParcel: false,
  dimensionsRequired: true,
  supportedOriginCountries: Object.freeze(["US"]),
  supportedDestinationCountries: Object.freeze(["US"]),
  supportedCurrencies: Object.freeze(["USD"]),
  deliveryKinds: Object.freeze(["courier"] as const),
  requiresCredentials: true,
});

export function projectUspsStaticCapabilities(): CarrierRateCapabilities {
  return projectCarrierRateStaticCapabilities(uspsCarrierRateCapabilities);
}

export interface UspsCarrierRateAdapterOptions {
  readonly client: UspsRateClient;
  readonly priceType?: UspsPriceType;
  readonly mailClasses?: readonly string[];
  readonly processingCategory?: UspsProcessingCategory;
  readonly destinationEntryFacilityType?: UspsDestinationEntryFacilityType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts a 5-digit US ZIP code from `12345` or `12345-6789` strings.
 * Returns `null` for non-matching postal codes so invalid addresses refuse at 0 I/O.
 */
export function parseUspsZipCode(postalCode: string): string | null {
  if (typeof postalCode !== "string") return null;
  const match = US_ZIP_REGEX.exec(postalCode.trim());
  return match?.[1] ?? null;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function resolveCurrencyExponent(currency: string): number | null {
  try {
    const digits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" && Number.isSafeInteger(digits) && digits >= 0 && digits <= 4
      ? digits
      : null;
  } catch {
    return null;
  }
}

function expandFiniteNumberToDecimalParts(major: number): {
  readonly intDigits: string;
  readonly fracDigits: string;
} {
  const raw = major.toString().toLowerCase();
  const [mantissa, expPart] = raw.split("e");
  const shift = expPart ? Number.parseInt(expPart, 10) : 0;
  const [wholeRaw = "0", fracRaw = ""] = (mantissa ?? "0").split(".");
  const digits = `${wholeRaw}${fracRaw}`;
  const decimalPos = wholeRaw.length + shift;

  if (decimalPos <= 0) {
    return {
      intDigits: "0",
      fracDigits: `${"0".repeat(-decimalPos)}${digits}`,
    };
  }
  if (decimalPos >= digits.length) {
    return {
      intDigits: `${digits}${"0".repeat(decimalPos - digits.length)}`,
      fracDigits: "",
    };
  }
  return {
    intDigits: digits.slice(0, decimalPos),
    fracDigits: digits.slice(decimalPos),
  };
}

/**
 * Parses a USPS major-unit price (decimal string or finite non-negative number)
 * into integer minor units using `Intl.NumberFormat` currency exponent metadata
 * and `BigInt` digit scaling with half-away-from-zero rounding (zero float drift).
 */
export function parseUspsMajorAmountToMinor(value: unknown, currency: string): number | null {
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) return null;

  let intDigits: string;
  let fracDigits: string;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    if (value === 0) return 0;
    const parts = expandFiniteNumberToDecimalParts(value);
    intDigits = parts.intDigits;
    fracDigits = parts.fracDigits;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_STRING_REGEX.test(trimmed)) return null;
    const [whole = "0", frac = ""] = trimmed.split(".");
    intDigits = whole;
    fracDigits = frac;
  } else {
    return null;
  }

  const paddedFrac = fracDigits.padEnd(exponent + 1, "0");
  const baseDigits = `${intDigits}${paddedFrac.slice(0, exponent)}`;
  const roundDigit = paddedFrac.charCodeAt(exponent) - 48;

  let minor = BigInt(baseDigits);
  if (roundDigit >= 5) {
    minor += 1n;
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

function formatUspsServiceName(serviceCode: string): string {
  return serviceCode
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => (part === "USPS" ? "USPS" : `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`))
    .join(" ");
}

function parseTransitDays(raw: unknown): CarrierRateTransitEstimate | undefined {
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw >= 0) {
      return { min: raw, max: raw };
    }
    return undefined;
  }
  if (isRecord(raw)) {
    const min = raw["min"];
    const max = raw["max"];
    if (
      typeof min === "number" &&
      typeof max === "number" &&
      Number.isSafeInteger(min) &&
      Number.isSafeInteger(max) &&
      min >= 0 &&
      max >= min
    ) {
      return { min, max };
    }
  }
  return undefined;
}

function readNonBlankString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function buildRateOptionFromDetail(
  detail: UspsRateDetail,
  overridePrice: unknown,
  currency: string,
  fallbackMeta?: UspsRateOption,
): CarrierRateOption | null {
  const serviceCode =
    readNonBlankString(detail.mailClass, 128) ??
    readNonBlankString(fallbackMeta?.mailClass, 128) ??
    readNonBlankString(detail.SKU, 128) ??
    readNonBlankString(fallbackMeta?.SKU, 128);
  if (!serviceCode) return null;

  const rawPrice = overridePrice !== undefined ? overridePrice : (detail.totalBasePrice ?? detail.price);
  const amountMinor = parseUspsMajorAmountToMinor(rawPrice, currency);
  if (amountMinor === null) return null;

  const serviceName =
    readNonBlankString(detail.description, 160) ??
    readNonBlankString(detail.productName, 160) ??
    readNonBlankString(fallbackMeta?.description, 160) ??
    readNonBlankString(fallbackMeta?.productName, 160) ??
    formatUspsServiceName(serviceCode);

  const estimatedTransitDays =
    parseTransitDays(detail.estimatedDeliveryDays) ??
    parseTransitDays(fallbackMeta?.estimatedDeliveryDays);

  const deliveryDateGuaranteed =
    typeof detail.deliveryDateGuaranteed === "boolean"
      ? detail.deliveryDateGuaranteed
      : typeof fallbackMeta?.deliveryDateGuaranteed === "boolean"
        ? fallbackMeta.deliveryDateGuaranteed
        : undefined;

  const providerRateRef =
    readNonBlankString(detail.SKU, 160) ?? readNonBlankString(fallbackMeta?.SKU, 160);

  const expiresAt =
    readNonBlankString(detail.endDate, 64) ?? readNonBlankString(fallbackMeta?.endDate, 64);

  return {
    carrierCode: USPS_CARRIER_CODE,
    serviceCode,
    serviceName,
    deliveryKind: "courier",
    amountMinor,
    currency,
    ...(estimatedTransitDays !== undefined ? { estimatedTransitDays } : {}),
    ...(deliveryDateGuaranteed !== undefined ? { deliveryDateGuaranteed } : {}),
    ...(providerRateRef !== undefined ? { providerRateRef } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function refused(
  reason: Extract<CarrierRateQuoteResult, { kind: "refused" }>["reason"],
  retryable: boolean,
  diagnosticCode: string,
  retryAfterSeconds?: number,
): Extract<CarrierRateQuoteResult, { kind: "refused" }> {
  return {
    kind: "refused",
    providerKind: USPS_PROVIDER_KIND,
    reason,
    retryable,
    diagnosticCode,
    ...(retryable && retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function mapUspsResponseToResult(
  rawResponse: unknown,
  currency: string,
  serviceFilter?: readonly string[],
): CarrierRateQuoteResult {
  if (!isRecord(rawResponse)) {
    return refused("provider_error", false, "USPS_MALFORMED_RESPONSE");
  }

  const hasRateOptions = "rateOptions" in rawResponse && rawResponse["rateOptions"] !== undefined;
  const hasTopRates = "rates" in rawResponse && rawResponse["rates"] !== undefined;
  if (!hasRateOptions && !hasTopRates) {
    return refused("provider_error", false, "USPS_MALFORMED_RESPONSE");
  }

  const collected: CarrierRateOption[] = [];

  if (hasRateOptions) {
    const rateOptions = rawResponse["rateOptions"];
    if (!Array.isArray(rateOptions)) {
      return refused("provider_error", false, "USPS_MALFORMED_RESPONSE");
    }
    for (const option of rateOptions) {
      if (!isRecord(option)) {
        return refused("provider_error", false, "USPS_MALFORMED_RATE");
      }
      const typedOption = option as UspsRateOption;
      if (typedOption.rates !== undefined && !Array.isArray(typedOption.rates)) {
        return refused("provider_error", false, "USPS_MALFORMED_RATE");
      }
      const nestedRates = typedOption.rates ?? [];
      if (typedOption.totalBasePrice !== undefined) {
        const primaryDetail: UspsRateDetail =
          nestedRates.length > 0 && isRecord(nestedRates[0])
            ? (nestedRates[0] as UspsRateDetail)
            : (typedOption as UspsRateDetail);
        const mapped = buildRateOptionFromDetail(
          primaryDetail,
          typedOption.totalBasePrice,
          currency,
          typedOption,
        );
        if (!mapped) {
          return refused("provider_error", false, "USPS_MALFORMED_RATE");
        }
        collected.push(mapped);
      } else if (nestedRates.length > 0) {
        for (const item of nestedRates) {
          if (!isRecord(item)) {
            return refused("provider_error", false, "USPS_MALFORMED_RATE");
          }
          const mapped = buildRateOptionFromDetail(
            item as UspsRateDetail,
            undefined,
            currency,
            typedOption,
          );
          if (!mapped) {
            return refused("provider_error", false, "USPS_MALFORMED_RATE");
          }
          collected.push(mapped);
        }
      } else {
        return refused("provider_error", false, "USPS_MALFORMED_RATE");
      }
    }
  } else if (hasTopRates) {
    const topRates = rawResponse["rates"];
    if (!Array.isArray(topRates)) {
      return refused("provider_error", false, "USPS_MALFORMED_RESPONSE");
    }
    for (const item of topRates) {
      if (!isRecord(item)) {
        return refused("provider_error", false, "USPS_MALFORMED_RATE");
      }
      const mapped = buildRateOptionFromDetail(item as UspsRateDetail, undefined, currency);
      if (!mapped) {
        return refused("provider_error", false, "USPS_MALFORMED_RATE");
      }
      collected.push(mapped);
    }
  }

  const allowedServices = serviceFilter
    ? new Set(serviceFilter.map((entry) => entry.trim()).filter((entry) => entry.length > 0))
    : null;
  const filtered = allowedServices
    ? collected.filter((option) => allowedServices.has(option.serviceCode))
    : collected;

  if (filtered.length === 0) {
    return {
      kind: "no_rates",
      providerKind: USPS_PROVIDER_KIND,
      diagnosticCode: allowedServices ? "USPS_NO_MATCHING_RATES" : "USPS_NO_RATES",
    };
  }

  return {
    kind: "quoted",
    providerKind: USPS_PROVIDER_KIND,
    currency,
    rates: sortCarrierRateOptions(filtered),
  };
}

function normalizeRetryAfterSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    return undefined;
  }
  return Math.min(raw, 86_400);
}

function mapClientErrorToRefusal(error: unknown): Extract<CarrierRateQuoteResult, { kind: "refused" }> {
  if (error instanceof UspsOAuth2Error) {
    if (error.status === 401 || error.status === 403 || error.code === "usps_oauth_credentials_missing") {
      return refused("authentication_failed", false, "USPS_OAUTH_AUTH_FAILED");
    }
    if (error.status === 429 || error.code === "usps_oauth_rate_limited") {
      return refused("rate_limited", true, "USPS_OAUTH_RATE_LIMITED", error.retryAfterSeconds);
    }
    if (error.code === "usps_oauth_timeout" || error.code === "usps_oauth_aborted") {
      return refused("timeout", true, "USPS_OAUTH_TIMEOUT");
    }
    if (error.retryable) {
      return refused("provider_unavailable", true, "USPS_OAUTH_UNAVAILABLE");
    }
    return refused("provider_error", false, "USPS_OAUTH_ERROR");
  }

  if (error instanceof UspsTransportError) {
    if (error.status === 401 || error.status === 403) {
      return refused("authentication_failed", false, "USPS_AUTH_FAILED");
    }
    if (error.status === 429 || error.code === "usps_rate_limited") {
      return refused("rate_limited", true, "USPS_RATE_LIMITED", error.retryAfterSeconds);
    }
    if (error.code === "usps_timeout") {
      return refused("timeout", true, "USPS_TIMEOUT");
    }
    if (
      error.code === "usps_transport_error" ||
      (error.status !== null && error.status >= 500 && error.status <= 599)
    ) {
      return refused(
        "provider_unavailable",
        true,
        error.status !== null ? `USPS_HTTP_${error.status}` : "USPS_TRANSPORT_UNAVAILABLE",
      );
    }
    return refused(
      "provider_error",
      false,
      error.code === "usps_malformed_response" ? "USPS_MALFORMED_RESPONSE" : "USPS_PROVIDER_ERROR",
    );
  }

  if (isRecord(error) || error instanceof Error) {
    const record = error as {
      readonly name?: unknown;
      readonly kind?: unknown;
      readonly status?: unknown;
      readonly retryAfterSeconds?: unknown;
    };
    const status = typeof record.status === "number" ? record.status : null;
    const retryAfterSeconds = normalizeRetryAfterSeconds(record.retryAfterSeconds);
    if (record.kind === "timeout" || record.name === "AbortError") {
      return refused("timeout", true, "USPS_TIMEOUT");
    }
    if (record.kind === "rate-limited-429" || status === 429) {
      return refused("rate_limited", true, "USPS_RATE_LIMITED", retryAfterSeconds);
    }
    if (status === 401 || status === 403) {
      return refused("authentication_failed", false, "USPS_AUTH_FAILED");
    }
    if (status !== null && status >= 500 && status <= 599) {
      return refused("provider_unavailable", true, `USPS_HTTP_${status}`);
    }
    if (record.kind === "transport-error") {
      return refused("provider_unavailable", true, "USPS_TRANSPORT_UNAVAILABLE");
    }
  }

  return refused("provider_error", false, "USPS_PROVIDER_ERROR");
}

/**
 * Creates a USPS Domestic Prices v3 `CarrierRateQuotePort` adapter.
 * Performs zero-I/O capability and US 5-digit ZIP validation before dispatching any HTTP call,
 * converts metric parcel units to US pounds/inches, converts `totalBasePrice` via exact
 * `Intl.NumberFormat` + `BigInt` decimal parsing, and returns structured refusals on all faults.
 */
export function createUspsCarrierRateAdapter(
  options: UspsCarrierRateAdapterOptions,
): CarrierRateQuotePort {
  const configuredMailClasses = options.mailClasses
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    capabilities: uspsCarrierRateCapabilities,
    async quoteRates(request: CarrierRateQuoteRequest): Promise<CarrierRateQuoteResult> {
      const capabilityRefusal = validateCarrierRateRequestAgainstCapabilities(
        request,
        uspsCarrierRateCapabilities,
      );
      if (capabilityRefusal !== null) {
        return capabilityRefusal;
      }

      const originZIPCode = parseUspsZipCode(request.origin.postalCode);
      if (!originZIPCode) {
        return refused("invalid_address", false, "USPS_INVALID_ORIGIN_POSTAL_CODE");
      }

      const destinationZIPCode = parseUspsZipCode(request.destination.postalCode);
      if (!destinationZIPCode) {
        return refused("invalid_address", false, "USPS_INVALID_DESTINATION_POSTAL_CODE");
      }

      if (request.signal?.aborted) {
        return refused("timeout", true, "USPS_REQUEST_ABORTED");
      }

      const parcel = request.parcels[0]!;
      const weight = Math.max(0.0001, roundToDecimals(parcel.weightGrams / GRAMS_PER_POUND, 4));
      const length = Math.max(0.01, roundToDecimals(parcel.lengthMm! / MM_PER_INCH, 2));
      const width = Math.max(0.01, roundToDecimals(parcel.widthMm! / MM_PER_INCH, 2));
      const height = Math.max(0.01, roundToDecimals(parcel.heightMm! / MM_PER_INCH, 2));

      const searchInput: UspsBaseRatesSearchRequest = {
        originZIPCode,
        destinationZIPCode,
        weight,
        length,
        width,
        height,
        ...(options.priceType !== undefined ? { priceType: options.priceType } : {}),
        ...(configuredMailClasses && configuredMailClasses.length > 0
          ? { mailClasses: configuredMailClasses }
          : {}),
        ...(options.processingCategory !== undefined
          ? { processingCategory: options.processingCategory }
          : {}),
        ...(options.destinationEntryFacilityType !== undefined
          ? { destinationEntryFacilityType: options.destinationEntryFacilityType }
          : {}),
        ...(request.atTime !== undefined ? { mailingDate: request.atTime.slice(0, 10) } : {}),
      };

      try {
        const response = await options.client.searchBaseRates(
          searchInput,
          request.signal ? { signal: request.signal } : undefined,
        );
        return mapUspsResponseToResult(response, request.currency, request.serviceFilter);
      } catch (error) {
        return mapClientErrorToRefusal(error);
      }
    },
  };
}
