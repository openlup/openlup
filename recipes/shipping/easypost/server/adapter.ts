import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  projectCarrierRateStaticCapabilities,
  sortCarrierRateOptions,
  validateCarrierRateRequestAgainstCapabilities,
} from "@openlup/platform/shipping";
import type {
  CarrierRateAddress,
  CarrierRateCapabilities,
  CarrierRateOption,
  CarrierRateParcel,
  CarrierRateQuotePort,
  CarrierRateQuoteResult,
  CarrierRateTransitEstimate,
} from "@openlup/platform/shipping/contracts";
import {
  EasyPostTransportError,
  type EasyPostAddressInput,
  type EasyPostCreateShipmentInput,
  type EasyPostParcelInput,
  type EasyPostRateClient,
  type EasyPostShipmentResponse,
} from "./client-contract.js";

export interface EasyPostCarrierRateAdapterConfig {
  /** Narrow structural client (use createEasyPostHttpClient for zero-SDK REST v2). */
  readonly client: EasyPostRateClient;
  /** Optional host-configured canonical 3-letter ISO-4217 uppercase currency codes. */
  readonly supportedCurrencies?: readonly string[];
  /** Optional host-configured ISO-3166-1 alpha-2 uppercase origin countries, or "any". */
  readonly supportedOriginCountries?: readonly string[] | "any";
  /** Optional host-configured ISO-3166-1 alpha-2 uppercase destination countries, or "any". */
  readonly supportedDestinationCountries?: readonly string[] | "any";
}

const PROVIDER_KIND = "easypost" as const;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
const DECIMAL_STRING_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const GRAMS_PER_AVOIRDUPOIS_OUNCE = 28.349523125;
const MM_PER_INCH = 25.4;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const CURRENCY_EXPONENT_CACHE = new Map<string, number>();

/** Static default capability descriptor for EasyPost multi-carrier rate quoting. */
export const easypostCarrierRateCapabilities: Readonly<CarrierRateCapabilities> = Object.freeze({
  contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  providerKind: PROVIDER_KIND,
  multiParcel: false,
  dimensionsRequired: false,
  supportedOriginCountries: "any",
  supportedDestinationCountries: "any",
  supportedCurrencies: Object.freeze([]),
  deliveryKinds: Object.freeze(["courier"] as const),
  requiresCredentials: true,
});

/**
 * Deterministic serializable projection of static capabilities with host-configured
 * currencies redacted, cross-checked against `recipe.json#staticCapabilities`.
 */
export function projectEasyPostStaticCapabilities(
  capabilities: CarrierRateCapabilities = easypostCarrierRateCapabilities,
): CarrierRateCapabilities {
  return projectCarrierRateStaticCapabilities(capabilities, {
    redactSupportedCurrencies: true,
  });
}

/** Resolves ISO-4217 minor-unit exponent via `Intl.NumberFormat` without hardcoded currency tables. */
export function resolveCurrencyExponent(currency: string): number | null {
  if (typeof currency !== "string" || !CURRENCY_CODE_PATTERN.test(currency)) {
    return null;
  }
  const cached = CURRENCY_EXPONENT_CACHE.get(currency);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const options = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions();
    const digits = options.maximumFractionDigits;
    if (typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > 6) {
      return null;
    }
    CURRENCY_EXPONENT_CACHE.set(currency, digits);
    return digits;
  } catch {
    return null;
  }
}

/**
 * Parses an exact decimal string (e.g. `"7.95"`, `"1000"`) into integer minor units
 * using `Intl.NumberFormat` currency exponent and `BigInt` arithmetic (zero IEEE-754 floats).
 */
export function parseExactDecimalToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) {
    return null;
  }
  const match = DECIMAL_STRING_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const wholePart = match[1]!;
  const fracPart = match[2] ?? "";
  if (fracPart.length > exponent) {
    const excessDigits = fracPart.slice(exponent);
    if (!/^0+$/u.test(excessDigits)) {
      return null;
    }
  }

  const scaledFrac = fracPart.slice(0, exponent).padEnd(exponent, "0");
  const factor = 10n ** BigInt(exponent);
  const minorBigInt =
    BigInt(wholePart) * factor + (scaledFrac.length > 0 ? BigInt(scaledFrac) : 0n);

  if (minorBigInt < 0n || minorBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minorBigInt);
}

/** Converts integer grams into avoirdupois ounces rounded to 2 decimal places (minimum 0.01 oz). */
export function gramsToOunces(weightGrams: number): number {
  const raw = weightGrams / GRAMS_PER_AVOIRDUPOIS_OUNCE;
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(0.01, rounded);
}

/** Converts integer millimeters into inches rounded to 2 decimal places (minimum 0.01 in). */
export function mmToInches(mm: number): number {
  const raw = mm / MM_PER_INCH;
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(0.01, rounded);
}

function normalizeCountryFilter(
  input: readonly string[] | "any" | undefined,
  label: string,
): readonly string[] | "any" {
  if (input === undefined || input === "any") {
    return "any";
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`EasyPost adapter ${label} must be "any" or a non-empty array of ISO-3166-1 alpha-2 codes`);
  }
  const normalized: string[] = [];
  for (const code of input) {
    if (typeof code !== "string" || !COUNTRY_CODE_PATTERN.test(code)) {
      throw new Error(`EasyPost adapter ${label} entries must be 2-letter uppercase ISO country codes`);
    }
    if (!normalized.includes(code)) {
      normalized.push(code);
    }
  }
  return Object.freeze(normalized);
}

function normalizeSupportedCurrencies(input: readonly string[] | undefined): readonly string[] {
  if (input === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(input)) {
    throw new Error("EasyPost adapter supportedCurrencies must be an array");
  }
  const normalized: string[] = [];
  for (const code of input) {
    if (typeof code !== "string" || resolveCurrencyExponent(code) === null) {
      throw new Error("EasyPost adapter supportedCurrencies entries must be 3-letter uppercase ISO-4217 codes");
    }
    if (!normalized.includes(code)) {
      normalized.push(code);
    }
  }
  return Object.freeze(normalized);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEasyPostAddress(address: CarrierRateAddress): EasyPostAddressInput {
  return {
    country: address.countryCode,
    zip: address.postalCode.trim(),
    ...(address.stateOrProvince?.trim() ? { state: address.stateOrProvince.trim() } : {}),
    ...(address.city?.trim() ? { city: address.city.trim() } : {}),
    ...(address.residential !== undefined ? { residential: address.residential } : {}),
  };
}

function toEasyPostParcel(parcel: CarrierRateParcel): EasyPostParcelInput {
  const hasDimensions =
    parcel.lengthMm !== undefined &&
    parcel.widthMm !== undefined &&
    parcel.heightMm !== undefined;
  return {
    weight: gramsToOunces(parcel.weightGrams),
    ...(hasDimensions
      ? {
          length: mmToInches(parcel.lengthMm!),
          width: mmToInches(parcel.widthMm!),
          height: mmToInches(parcel.heightMm!),
        }
      : {}),
  };
}

function parseTransitEstimate(
  deliveryDays: unknown,
  estDeliveryDays: unknown,
): CarrierRateTransitEstimate | undefined {
  const candidate =
    typeof deliveryDays === "number"
      ? deliveryDays
      : typeof estDeliveryDays === "number"
        ? estDeliveryDays
        : undefined;
  if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate < 0) {
    return undefined;
  }
  return { min: candidate, max: candidate };
}

function refused(
  reason: Extract<CarrierRateQuoteResult, { kind: "refused" }>["reason"],
  retryable: boolean,
  diagnosticCode: string,
  retryAfterSeconds?: number,
): Extract<CarrierRateQuoteResult, { kind: "refused" }> {
  return {
    kind: "refused",
    providerKind: PROVIDER_KIND,
    reason,
    retryable,
    diagnosticCode,
    ...(retryable &&
    typeof retryAfterSeconds === "number" &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0 &&
    retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
      ? { retryAfterSeconds }
      : {}),
  };
}

function mapEasyPostError(error: unknown): Extract<CarrierRateQuoteResult, { kind: "refused" }> {
  if (error instanceof EasyPostTransportError) {
    switch (error.kind) {
      case "auth":
        return refused("authentication_failed", false, error.diagnosticCode);
      case "rate_limited":
        return refused("rate_limited", true, error.diagnosticCode, error.retryAfterSeconds);
      case "timeout":
        return refused("timeout", true, error.diagnosticCode);
      case "http_5xx":
      case "network":
        return refused("provider_unavailable", true, error.diagnosticCode);
      case "http_4xx":
      case "malformed_response":
      case "response_too_large":
      case "invalid_config":
        return refused("provider_error", false, error.diagnosticCode);
    }
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      readonly name?: unknown;
      readonly kind?: unknown;
      readonly status?: unknown;
      readonly retryAfterSeconds?: unknown;
    };

    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
      return refused("timeout", true, "EASYPOST_TIMEOUT");
    }

    if (candidate.status === 401 || candidate.status === 403) {
      return refused("authentication_failed", false, "EASYPOST_AUTH_FAILED");
    }

    if (candidate.status === 429 || candidate.kind === "rate-limited-429") {
      const retryAfter =
        typeof candidate.retryAfterSeconds === "number" ? candidate.retryAfterSeconds : undefined;
      return refused("rate_limited", true, "EASYPOST_RATE_LIMITED", retryAfter);
    }

    if (
      (typeof candidate.status === "number" && candidate.status >= 500 && candidate.status <= 599) ||
      candidate.kind === "transport-error"
    ) {
      return refused("provider_unavailable", true, "EASYPOST_UNAVAILABLE");
    }

    if (typeof candidate.status === "number" && candidate.status >= 400 && candidate.status <= 499) {
      return refused("provider_error", false, "EASYPOST_HTTP_4XX");
    }
  }

  return refused("provider_error", false, "EASYPOST_PROVIDER_ERROR");
}

function mapShipmentResponseToResult(
  response: EasyPostShipmentResponse,
  requestCurrency: string,
  serviceFilter: readonly string[] | undefined,
): CarrierRateQuoteResult {
  if (!isPlainRecord(response) || !Array.isArray(response.rates)) {
    return refused("provider_error", false, "EASYPOST_MALFORMED_RESPONSE");
  }

  const filterSet = serviceFilter
    ? new Set(serviceFilter.map((entry) => entry.trim()))
    : null;

  const options: CarrierRateOption[] = [];
  for (const rawRate of response.rates) {
    if (!isPlainRecord(rawRate)) {
      return refused("provider_error", false, "EASYPOST_MALFORMED_RESPONSE");
    }

    const carrierRaw = rawRate.carrier;
    const serviceRaw = rawRate.service;
    const currencyRaw = rawRate.currency;
    const rateRaw = rawRate.rate;

    if (
      typeof carrierRaw !== "string" ||
      carrierRaw.trim().length === 0 ||
      typeof serviceRaw !== "string" ||
      serviceRaw.trim().length === 0 ||
      typeof currencyRaw !== "string" ||
      typeof rateRaw !== "string"
    ) {
      return refused("provider_error", false, "EASYPOST_MALFORMED_RESPONSE");
    }

    const rateCurrency = currencyRaw.trim().toUpperCase();
    if (!CURRENCY_CODE_PATTERN.test(rateCurrency)) {
      return refused("provider_error", false, "EASYPOST_MALFORMED_RESPONSE");
    }

    if (rateCurrency !== requestCurrency) {
      continue;
    }

    const amountMinor = parseExactDecimalToMinor(rateRaw.trim(), requestCurrency);
    if (amountMinor === null) {
      return refused("provider_error", false, "EASYPOST_MALFORMED_RESPONSE");
    }

    const carrierCode = carrierRaw.trim().slice(0, 64);
    const serviceCode = serviceRaw.trim().slice(0, 128);
    const serviceName = `${carrierCode} ${serviceCode}`.slice(0, 160);

    if (
      filterSet &&
      !filterSet.has(serviceCode) &&
      !filterSet.has(`${carrierCode}:${serviceCode}`)
    ) {
      continue;
    }

    const transit = parseTransitEstimate(rawRate.delivery_days, rawRate.est_delivery_days);
    const providerRateRef =
      typeof rawRate.id === "string" && rawRate.id.trim().length > 0
        ? rawRate.id.trim().slice(0, 160)
        : undefined;

    options.push({
      carrierCode,
      serviceCode,
      serviceName,
      deliveryKind: "courier",
      amountMinor,
      currency: requestCurrency,
      ...(transit !== undefined ? { estimatedTransitDays: transit } : {}),
      ...(typeof rawRate.delivery_date_guaranteed === "boolean"
        ? { deliveryDateGuaranteed: rawRate.delivery_date_guaranteed }
        : {}),
      ...(providerRateRef !== undefined ? { providerRateRef } : {}),
    });
  }

  const sorted = sortCarrierRateOptions(options);
  if (sorted.length === 0) {
    return {
      kind: "no_rates",
      providerKind: PROVIDER_KIND,
      diagnosticCode: "NO_ELIGIBLE_RATES",
    };
  }

  const providerShipmentRef =
    typeof response.id === "string" && response.id.trim().length > 0
      ? response.id.trim().slice(0, 160)
      : undefined;

  return {
    kind: "quoted",
    providerKind: PROVIDER_KIND,
    currency: requestCurrency,
    rates: sorted,
    ...(providerShipmentRef !== undefined ? { providerShipmentRef } : {}),
  };
}

/**
 * Explicit factory for the EasyPost REST v2 `CarrierRateQuotePort`.
 * Importing this module performs zero I/O, reads zero environment variables,
 * and registers no routes, schedules, or global state.
 */
export function createEasyPostCarrierRateAdapter(
  config: EasyPostCarrierRateAdapterConfig,
): CarrierRateQuotePort {
  if (!config || typeof config.client?.createShipmentRates !== "function") {
    throw new Error("EasyPost adapter requires a client implementing createShipmentRates");
  }

  const supportedOriginCountries = normalizeCountryFilter(
    config.supportedOriginCountries,
    "supportedOriginCountries",
  );
  const supportedDestinationCountries = normalizeCountryFilter(
    config.supportedDestinationCountries,
    "supportedDestinationCountries",
  );
  const supportedCurrencies = normalizeSupportedCurrencies(config.supportedCurrencies);

  const capabilities: CarrierRateCapabilities = Object.freeze({
    ...easypostCarrierRateCapabilities,
    supportedOriginCountries,
    supportedDestinationCountries,
    supportedCurrencies,
  });

  return {
    capabilities,
    async quoteRates(request): Promise<CarrierRateQuoteResult> {
      const preflightRefusal = validateCarrierRateRequestAgainstCapabilities(request, capabilities);
      if (preflightRefusal) {
        return preflightRefusal;
      }

      if (resolveCurrencyExponent(request.currency) === null) {
        return refused("unsupported_currency", false, "UNSUPPORTED_CURRENCY");
      }

      const parcel = request.parcels[0]!;
      const payload: EasyPostCreateShipmentInput = {
        shipment: {
          from_address: toEasyPostAddress(request.origin),
          to_address: toEasyPostAddress(request.destination),
          parcel: toEasyPostParcel(parcel),
          reference: request.requestKey.trim(),
        },
      };

      try {
        const response = await config.client.createShipmentRates(
          payload,
          request.signal ? { signal: request.signal } : undefined,
        );
        return mapShipmentResponseToResult(response, request.currency, request.serviceFilter);
      } catch (error) {
        return mapEasyPostError(error);
      }
    },
  };
}
