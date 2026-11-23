import {
  createHardenedFetch,
  createOAuth2TokenManager,
  HardenedFetchError,
  OAuth2TokenError,
  type OAuth2TokenCache,
  type OAuth2TokenManager,
} from "@openlup/platform/adapter-kit";

/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * PayPal Orders API v2 (ADR-001: zero vendor SDK, zero ambient environment
 * reads, zero ambient fetch, strict HTTPS origin pinning, redirect: "error").
 */

export type PayPalFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PayPalMode = "live" | "test";

export const PAYPAL_API_ORIGINS: Readonly<Record<PayPalMode, string>> = Object.freeze({
  live: "https://api-m.paypal.com",
  test: "https://api-m.sandbox.paypal.com",
});

export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export type PayPalOrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED";

export type PayPalCaptureStatus =
  | "COMPLETED"
  | "DECLINED"
  | "PARTIALLY_REFUNDED"
  | "PENDING"
  | "REFUNDED"
  | "FAILED";

export type PayPalRefundStatus =
  | "CANCELLED"
  | "FAILED"
  | "PENDING"
  | "COMPLETED";

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalCaptureResource {
  id: string;
  status: PayPalCaptureStatus;
  amount?: PayPalAmount;
  status_details?: { reason?: string } | null;
  create_time?: string | null;
  update_time?: string | null;
}

export interface PayPalRefundResource {
  id: string;
  status: PayPalRefundStatus;
  amount?: PayPalAmount;
  create_time?: string | null;
  update_time?: string | null;
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  description?: string;
  amount?: PayPalAmount;
  payments?: {
    captures?: readonly PayPalCaptureResource[];
    refunds?: readonly PayPalRefundResource[];
  };
}

export interface PayPalOrderResource {
  id: string;
  status: PayPalOrderStatus;
  intent?: "CAPTURE" | "AUTHORIZE";
  purchase_units?: readonly PayPalPurchaseUnit[];
  links?: readonly PayPalLink[];
  create_time?: string | null;
  update_time?: string | null;
}

export interface PayPalCreateOrderRequest {
  intent: "CAPTURE";
  purchase_units: readonly {
    reference_id?: string;
    custom_id?: string;
    description?: string;
    amount: PayPalAmount;
  }[];
  application_context?: {
    return_url: string;
    cancel_url: string;
    user_action?: "PAY_NOW" | "CONTINUE";
  };
}

export interface PayPalRequestOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

/** Narrow structural client contract consumed by createPayPalPaymentAdapter. */
export interface PayPalClient {
  createOrder(
    request: PayPalCreateOrderRequest,
    options: PayPalRequestOptions,
  ): Promise<PayPalOrderResource>;
  getOrder(
    orderId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PayPalOrderResource>;
  captureOrder?(
    orderId: string,
    options: PayPalRequestOptions,
  ): Promise<PayPalOrderResource>;
}

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
}

export interface PayPalHttpClientConfig {
  mode: PayPalMode;
  credentials: PayPalCredentials | (() => PayPalCredentials);
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  fetchImpl: PayPalFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  tokenCache?: OAuth2TokenCache;
  clock?: () => number;
}

const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_PAYPAL_ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;

function hasWhitespaceOrControlChar(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const SUPPORTED_ISO_CURRENCIES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("currency"),
);
const CURRENCY_EXPONENT_CACHE = new Map<string, number>();

export function toSafeDiagnosticCode(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return SAFE_DIAGNOSTIC_CODE.test(normalized) ? normalized : fallback;
}

/**
 * Redacted transport error carrying only allowlisted diagnostic codes.
 * Raw HTTP bodies, headers, and OAuth credentials never enter Error.message.
 */
export class PayPalTransportError extends Error {
  readonly diagnosticCode: string;
  readonly httpStatus: number | null;
  readonly phase: "before-dispatch" | "unknown";

  constructor(input: {
    diagnosticCode: string;
    httpStatus: number | null;
    phase: "before-dispatch" | "unknown";
  }) {
    const safeCode = toSafeDiagnosticCode(input.diagnosticCode, "PAYPAL_TRANSPORT_ERROR");
    super(`PayPal transport error: ${safeCode}`);
    this.name = "PayPalTransportError";
    this.diagnosticCode = safeCode;
    this.httpStatus = input.httpStatus;
    this.phase = input.phase;
  }
}

export function assertSafePayPalOrderId(orderId: string): string {
  if (typeof orderId !== "string" || !SAFE_PAYPAL_ORDER_ID.test(orderId)) {
    throw new PayPalTransportError({
      diagnosticCode: "PAYPAL_INVALID_ORDER_ID",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  return orderId;
}

export function assertPayPalCredentials(credentials: unknown): PayPalCredentials {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new PayPalTransportError({
      diagnosticCode: "PAYPAL_CREDENTIALS_MISSING",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  const record = credentials as Record<string, unknown>;
  if (
    typeof record.clientId !== "string"
    || record.clientId.length === 0
    || hasWhitespaceOrControlChar(record.clientId)
    || typeof record.clientSecret !== "string"
    || record.clientSecret.length === 0
    || hasWhitespaceOrControlChar(record.clientSecret)
  ) {
    throw new PayPalTransportError({
      diagnosticCode: "PAYPAL_CREDENTIALS_MISSING",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  return { clientId: record.clientId, clientSecret: record.clientSecret };
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

/** Converts integer minor units into an exact PayPal decimal string (zero float math). */
export function minorToMajorString(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("Invalid minor unit amount");
  }
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) {
    throw new Error("Invalid ISO-4217 currency code");
  }
  if (exponent === 0) {
    return String(amountMinor);
  }
  const factor = 10n ** BigInt(exponent);
  const minor = BigInt(amountMinor);
  const whole = minor / factor;
  const remainder = (minor % factor).toString().padStart(exponent, "0");
  return `${whole}.${remainder}`;
}

/** Parses a strict PayPal decimal string into safe integer minor units (zero float math). */
export function majorStringToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) {
    return null;
  }
  const pattern =
    exponent === 0
      ? /^(?:0|[1-9][0-9]*)$/u
      : new RegExp(`^(?:0|[1-9][0-9]*)\\.[0-9]{${exponent}}$`, "u");
  if (!pattern.test(value)) {
    return null;
  }
  const digits = exponent === 0 ? value : value.replace(".", "");
  const minor = BigInt(digits);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

function mapOAuthError(error: OAuth2TokenError): PayPalTransportError {
  if (error.kind === "config_error") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_CREDENTIALS_MISSING",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  if (error.kind === "auth_failed") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_OAUTH_AUTH_FAILED",
      httpStatus: error.status ?? 401,
      phase: "before-dispatch",
    });
  }
  if (error.kind === "timeout") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_REQUEST_TIMEOUT",
      httpStatus: null,
      phase: "unknown",
    });
  }
  if (error.kind === "rate_limited") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_OAUTH_RATE_LIMITED",
      httpStatus: 429,
      phase: "unknown",
    });
  }
  if (error.kind === "malformed_response") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_OAUTH_MALFORMED",
      httpStatus: error.status ?? null,
      phase: "unknown",
    });
  }
  return new PayPalTransportError({
    diagnosticCode: "PAYPAL_OAUTH_UNAVAILABLE",
    httpStatus: error.status ?? null,
    phase: "unknown",
  });
}

function mapHardenedFetchError(error: HardenedFetchError): PayPalTransportError {
  if (error.kind === "timeout") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_REQUEST_TIMEOUT",
      httpStatus: null,
      phase: "unknown",
    });
  }
  if (error.kind === "body_too_large") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_RESPONSE_TOO_LARGE",
      httpStatus: error.status ?? null,
      phase: "unknown",
    });
  }
  if (error.kind === "malformed_json") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_MALFORMED_RESPONSE",
      httpStatus: error.status ?? null,
      phase: "unknown",
    });
  }
  if (error.kind === "origin_rejected") {
    return new PayPalTransportError({
      diagnosticCode: "PAYPAL_ORIGIN_REJECTED",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  if (error.kind === "http_error") {
    const status = error.status ?? 500;
    const phase: "before-dispatch" | "unknown" =
      status === 401 || status === 403 || status === 422 ? "before-dispatch" : "unknown";
    return new PayPalTransportError({
      diagnosticCode: `PAYPAL_HTTP_${status}`,
      httpStatus: status,
      phase,
    });
  }
  return new PayPalTransportError({
    diagnosticCode: "PAYPAL_NETWORK_ERROR",
    httpStatus: null,
    phase: "unknown",
  });
}

/**
 * Zero-SDK hardened HTTP client for PayPal Orders API v2.
 * Uses `@openlup/platform/adapter-kit`'s `createOAuth2TokenManager` and
 * `createHardenedFetch` pinned to the mode-selected PayPal origin with
 * `redirect: "error"`, bounded responses, and redacted diagnostics.
 */
export function createPayPalHttpClient(config: PayPalHttpClientConfig): Required<PayPalClient> {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid PayPal mode");
  }
  if (typeof config.fetchImpl !== "function") {
    throw new Error("PayPal HTTP client requires an explicit fetchImpl");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid PayPal timeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Invalid PayPal maxResponseBytes");
  }

  const origin = PAYPAL_API_ORIGINS[config.mode];
  const tokenUrl = `${origin}/v1/oauth2/token`;
  const hardenedFetch = createHardenedFetch({
    allowedOrigins: [origin],
    fetchImpl: config.fetchImpl as typeof fetch,
    timeoutMs,
    maxResponseBytes,
    ...(config.clock ? { clock: config.clock } : {}),
  });

  let staticManager: OAuth2TokenManager | null = null;
  let lastCredKey = "";
  let dynamicManager: OAuth2TokenManager | null = null;

  if (typeof config.credentials !== "function") {
    const validated = assertPayPalCredentials(config.credentials);
    staticManager = createOAuth2TokenManager({
      tokenUrl,
      grant: {
        type: "client_credentials",
        clientId: validated.clientId,
        clientSecret: validated.clientSecret,
      },
      authMethod: "basic",
      contentType: "form",
      fetchImpl: config.fetchImpl as typeof fetch,
      timeoutMs,
      maxResponseBytes,
      ...(config.tokenCache ? { cache: config.tokenCache } : {}),
      ...(config.clock ? { clock: config.clock } : {}),
    });
  }

  const resolveTokenManager = (): OAuth2TokenManager => {
    if (staticManager) return staticManager;
    const resolved = assertPayPalCredentials((config.credentials as () => PayPalCredentials)());
    const key = `${resolved.clientId}\0${resolved.clientSecret}`;
    if (!dynamicManager || key !== lastCredKey) {
      lastCredKey = key;
      dynamicManager = createOAuth2TokenManager({
        tokenUrl,
        grant: {
          type: "client_credentials",
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret,
        },
        authMethod: "basic",
        contentType: "form",
        fetchImpl: config.fetchImpl as typeof fetch,
        timeoutMs,
        maxResponseBytes,
        ...(config.tokenCache ? { cache: config.tokenCache } : {}),
        ...(config.clock ? { clock: config.clock } : {}),
      });
    }
    return dynamicManager;
  };

  async function requestJson<TResponse>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<TResponse> {
    const tokenManager = resolveTokenManager();
    let accessToken: string;
    try {
      accessToken = await tokenManager.getAccessToken(input.signal);
    } catch (error) {
      if (error instanceof PayPalTransportError) throw error;
      if (error instanceof OAuth2TokenError) throw mapOAuthError(error);
      throw new PayPalTransportError({
        diagnosticCode: "PAYPAL_OAUTH_UNAVAILABLE",
        httpStatus: null,
        phase: "unknown",
      });
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (input.idempotencyKey) {
      headers["paypal-request-id"] = input.idempotencyKey;
    }

    try {
      const response = await hardenedFetch.fetchJson<unknown>(`${origin}${input.path}`, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
        throw new PayPalTransportError({
          diagnosticCode: "PAYPAL_MALFORMED_RESPONSE",
          httpStatus: response.status,
          phase: "unknown",
        });
      }
      return response.data as TResponse;
    } catch (error) {
      if (error instanceof PayPalTransportError) throw error;
      if (error instanceof HardenedFetchError) {
        if (error.kind === "http_error" && error.status === 401) {
          await tokenManager.invalidate().catch(() => undefined);
        }
        throw mapHardenedFetchError(error);
      }
      throw new PayPalTransportError({
        diagnosticCode: "PAYPAL_NETWORK_ERROR",
        httpStatus: null,
        phase: "unknown",
      });
    }
  }

  return {
    async createOrder(request, options) {
      return requestJson<PayPalOrderResource>({
        method: "POST",
        path: "/v2/checkout/orders",
        body: request,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      });
    },
    async getOrder(orderId, options) {
      const safeId = assertSafePayPalOrderId(orderId);
      return requestJson<PayPalOrderResource>({
        method: "GET",
        path: `/v2/checkout/orders/${encodeURIComponent(safeId)}`,
        signal: options?.signal,
      });
    },
    async captureOrder(orderId, options) {
      const safeId = assertSafePayPalOrderId(orderId);
      return requestJson<PayPalOrderResource>({
        method: "POST",
        path: `/v2/checkout/orders/${encodeURIComponent(safeId)}/capture`,
        body: {},
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      });
    },
  };
}
