import {
  createHardenedFetch,
  HardenedFetchError,
} from "@openlup/platform/adapter-kit";

/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * ShipEngine REST API v1 Rates (recipe contract: zero vendor SDK, zero ambient
 * environment reads, zero ambient fetch, strict HTTPS origin pinning,
 * redirect: "error").
 */

export type ShipEngineFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const SHIPENGINE_API_ORIGIN = "https://api.shipengine.com";

export interface ShipEngineAddress {
  name?: string;
  address_line1: string;
  city_locality: string;
  state_province?: string;
  postal_code: string;
  country_code: string;
  address_residential_indicator?: "unknown" | "yes" | "no";
}

export interface ShipEnginePackage {
  weight: {
    value: number;
    unit: "gram";
  };
  dimensions?: {
    unit: "centimeter";
    length: number;
    width: number;
    height: number;
  };
  insured_value?: {
    currency: string;
    amount: number;
  };
}

export interface ShipEngineRatesRequest {
  rate_options: {
    carrier_ids: readonly string[];
    service_codes?: readonly string[];
  };
  shipment: {
    validate_address?: "no_validation" | "validate_only" | "validate_and_clean";
    ship_to: ShipEngineAddress;
    ship_from: ShipEngineAddress;
    packages: readonly ShipEnginePackage[];
    ship_date?: string;
  };
}

export interface ShipEngineMonetaryAmount {
  currency: string;
  amount: number | string;
}

export interface ShipEngineRateItem {
  rate_id?: string;
  rate_type?: string;
  carrier_id?: string;
  carrier_code?: string;
  carrier_friendly_name?: string;
  service_type?: string;
  service_code?: string;
  shipping_amount: ShipEngineMonetaryAmount;
  insurance_amount?: ShipEngineMonetaryAmount | null;
  confirmation_amount?: ShipEngineMonetaryAmount | null;
  other_amount?: ShipEngineMonetaryAmount | null;
  delivery_days?: number | null;
  guaranteed_service?: boolean;
  estimated_delivery_date?: string | null;
  validation_status?: "valid" | "invalid" | "has_warnings" | "unknown";
}

export interface ShipEngineRatesResponse {
  rate_response?: {
    rates?: readonly ShipEngineRateItem[];
    invalid_rates?: readonly ShipEngineRateItem[];
    rate_request_id?: string;
    shipment_id?: string;
    status?: string;
  };
}

/** Narrow structural client contract consumed by createShipEngineRateAdapter. */
export interface ShipEngineClient {
  getRates(
    request: ShipEngineRatesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ShipEngineRatesResponse>;
}

export interface ShipEngineHttpClientConfig {
  /** Static API key or per-call resolver; validated before dispatch. */
  apiKey: string | (() => string);
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  fetchImpl: ShipEngineFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  clock?: () => number;
}

const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 524_288;
const MIN_API_KEY_LENGTH = 8;

const SUPPORTED_ISO_CURRENCIES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("currency"),
);
const CURRENCY_EXPONENT_CACHE = new Map<string, number>();

function hasWhitespaceOrControlChar(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function toSafeDiagnosticCode(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return SAFE_DIAGNOSTIC_CODE.test(normalized) ? normalized : fallback;
}

export type ShipEngineTransportErrorKind =
  | "authentication_failed"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "provider_error";

/**
 * Redacted transport error carrying only allowlisted diagnostic codes.
 * Raw HTTP bodies, headers, and API keys never enter Error.message.
 */
export class ShipEngineTransportError extends Error {
  readonly kind: ShipEngineTransportErrorKind;
  readonly diagnosticCode: string;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    kind: ShipEngineTransportErrorKind;
    diagnosticCode: string;
    httpStatus: number | null;
    retryAfterSeconds?: number;
  }) {
    const safeCode = toSafeDiagnosticCode(input.diagnosticCode, "SHIPENGINE_TRANSPORT_ERROR");
    super(`ShipEngine transport error: ${safeCode}`);
    this.name = input.kind === "timeout" ? "AbortError" : "ShipEngineTransportError";
    this.kind = input.kind;
    this.diagnosticCode = safeCode;
    this.httpStatus = input.httpStatus;
    if (input.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
  }
}

export function assertValidShipEngineApiKey(apiKey: unknown): string {
  if (
    typeof apiKey !== "string"
    || apiKey.length < MIN_API_KEY_LENGTH
    || hasWhitespaceOrControlChar(apiKey)
  ) {
    throw new ShipEngineTransportError({
      kind: "authentication_failed",
      diagnosticCode: "SHIPENGINE_CREDENTIALS_MISSING",
      httpStatus: null,
    });
  }
  return apiKey;
}

/** Resolves ISO-4217 minor-unit exponent from Intl without hardcoded currency tables. */
export function resolveCurrencyExponent(currency: string): number | null {
  if (typeof currency !== "string" || !CURRENCY_CODE_PATTERN.test(currency)) {
    return null;
  }
  if (!SUPPORTED_ISO_CURRENCIES.has(currency)) {
    return null;
  }
  const cached = CURRENCY_EXPONENT_CACHE.get(currency);
  if (cached !== undefined) {
    return cached;
  }
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
}

/**
 * Converts a ShipEngine decimal number or string into exact integer minor units
 * using `BigInt` + `Intl` currency exponent (zero IEEE-754 float scaling).
 */
export function decimalAmountToMinor(rawAmount: unknown, currency: string): number | null {
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) {
    return null;
  }

  let decimalText: string;
  if (typeof rawAmount === "number") {
    if (!Number.isFinite(rawAmount) || rawAmount < 0) return null;
    decimalText = rawAmount.toString();
  } else if (typeof rawAmount === "string") {
    decimalText = rawAmount;
  } else {
    return null;
  }

  const match = /^([0-9]+)(?:\.([0-9]+))?$/u.exec(decimalText);
  if (!match) {
    return null;
  }

  const wholePart = match[1]!;
  const fracPart = match[2] ?? "";
  if (fracPart.length > exponent) {
    const trailing = fracPart.slice(exponent);
    if (!/^0+$/u.test(trailing)) {
      return null;
    }
  }

  const paddedFrac = fracPart.slice(0, exponent).padEnd(exponent, "0");
  const minor = BigInt(`${wholePart}${paddedFrac}`);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

/** Converts integer minor units into an exact major decimal number for ShipEngine JSON. */
export function minorToMajorNumber(amountMinor: number, currency: string): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("Invalid minor unit amount");
  }
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) {
    throw new Error("Invalid ISO-4217 currency code");
  }
  if (exponent === 0) {
    return amountMinor;
  }
  const factor = 10n ** BigInt(exponent);
  const minor = BigInt(amountMinor);
  const whole = minor / factor;
  const remainder = (minor % factor).toString().padStart(exponent, "0");
  return Number(`${whole}.${remainder}`);
}

function mapHardenedFetchError(error: HardenedFetchError): ShipEngineTransportError {
  if (error.kind === "timeout") {
    return new ShipEngineTransportError({
      kind: "timeout",
      diagnosticCode: "SHIPENGINE_TIMEOUT",
      httpStatus: null,
    });
  }
  if (error.kind === "http_error") {
    const status = error.status ?? 500;
    if (status === 401 || status === 403) {
      return new ShipEngineTransportError({
        kind: "authentication_failed",
        diagnosticCode: "SHIPENGINE_AUTH_FAILED",
        httpStatus: status,
      });
    }
    if (status === 429) {
      return new ShipEngineTransportError({
        kind: "rate_limited",
        diagnosticCode: "SHIPENGINE_RATE_LIMITED",
        httpStatus: 429,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    }
    if (status >= 500) {
      return new ShipEngineTransportError({
        kind: "provider_unavailable",
        diagnosticCode: `SHIPENGINE_HTTP_${status}`,
        httpStatus: status,
      });
    }
    return new ShipEngineTransportError({
      kind: "provider_error",
      diagnosticCode: `SHIPENGINE_HTTP_${status}`,
      httpStatus: status,
    });
  }
  if (error.kind === "origin_rejected") {
    return new ShipEngineTransportError({
      kind: "provider_error",
      diagnosticCode: "SHIPENGINE_ORIGIN_REJECTED",
      httpStatus: null,
    });
  }
  if (error.kind === "malformed_json" || error.kind === "body_too_large") {
    return new ShipEngineTransportError({
      kind: "provider_unavailable",
      diagnosticCode: "SHIPENGINE_MALFORMED_RESPONSE",
      httpStatus: error.status ?? null,
    });
  }
  return new ShipEngineTransportError({
    kind: "provider_unavailable",
    diagnosticCode: "SHIPENGINE_NETWORK_ERROR",
    httpStatus: null,
  });
}

/**
 * Zero-SDK hardened HTTP client for ShipEngine REST API v1.
 * Enforces HTTPS origin pinning (`https://api.shipengine.com`), `API-Key` header,
 * `redirect: "error"`, bounded responses, and redacted diagnostics.
 */
export function createShipEngineHttpClient(config: ShipEngineHttpClientConfig): ShipEngineClient {
  if (typeof config.fetchImpl !== "function") {
    throw new Error("ShipEngine HTTP client requires an explicit fetchImpl");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid ShipEngine timeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Invalid ShipEngine maxResponseBytes");
  }
  if (typeof config.apiKey !== "function") {
    assertValidShipEngineApiKey(config.apiKey);
  }

  const readApiKey = (): string => {
    const rawKey = typeof config.apiKey === "function" ? config.apiKey() : config.apiKey;
    return assertValidShipEngineApiKey(rawKey);
  };

  const hardenedFetch = createHardenedFetch({
    allowedOrigins: [SHIPENGINE_API_ORIGIN],
    fetchImpl: config.fetchImpl as typeof fetch,
    timeoutMs,
    maxResponseBytes,
    ...(config.clock ? { clock: config.clock } : {}),
  });

  return {
    async getRates(request, options) {
      const apiKey = readApiKey();
      try {
        const res = await hardenedFetch.fetchJson<unknown>(`${SHIPENGINE_API_ORIGIN}/v1/rates`, {
          method: "POST",
          headers: {
            "api-key": apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(request),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (!res.data || typeof res.data !== "object" || Array.isArray(res.data)) {
          throw new ShipEngineTransportError({
            kind: "provider_unavailable",
            diagnosticCode: "SHIPENGINE_MALFORMED_RESPONSE",
            httpStatus: res.status,
          });
        }
        return res.data as ShipEngineRatesResponse;
      } catch (error) {
        if (error instanceof ShipEngineTransportError) throw error;
        if (error instanceof HardenedFetchError) {
          throw mapHardenedFetchError(error);
        }
        throw new ShipEngineTransportError({
          kind: "provider_unavailable",
          diagnosticCode: "SHIPENGINE_NETWORK_ERROR",
          httpStatus: null,
        });
      }
    },
  };
}
