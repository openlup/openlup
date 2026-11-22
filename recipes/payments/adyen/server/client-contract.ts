/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * Adyen Checkout API v71 (ADR-001: zero vendor SDK, zero ambient environment
 * reads, zero ambient fetch, strict HTTPS origin pinning, redirect: "error").
 */

export type AdyenFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AdyenAmount {
  currency: string;
  value: number;
}

export interface AdyenCreateSessionRequest {
  merchantAccount: string;
  amount: AdyenAmount;
  reference: string;
  returnUrl: string;
  countryCode?: string;
  shopperReference?: string;
  storePaymentMethodMode?: "askForConsent" | "disabled" | "enabled";
  recurringProcessingModel?: "Subscription" | "CardOnFile" | "UnscheduledCardOnFile";
  metadata?: Readonly<Record<string, string>>;
}

export interface AdyenCreateSessionResponse {
  id: string;
  sessionData: string;
  amount: AdyenAmount;
  reference: string;
  expiresAt?: string;
}

export interface AdyenCreatePaymentRequest {
  merchantAccount: string;
  amount: AdyenAmount;
  reference: string;
  returnUrl: string;
  shopperReference?: string;
  shopperInteraction: "Ecommerce" | "ContAuth";
  recurringProcessingModel?: "Subscription" | "CardOnFile" | "UnscheduledCardOnFile";
  paymentMethod: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, string>>;
}

export interface AdyenCreatePaymentResponse {
  pspReference?: string;
  resultCode:
    | "Authorised"
    | "AuthenticationFinished"
    | "AuthenticationNotRequired"
    | "Cancelled"
    | "ChallengeShopper"
    | "Error"
    | "IdentifyShopper"
    | "PartiallyAuthorised"
    | "Pending"
    | "PresentToShopper"
    | "Received"
    | "RedirectShopper"
    | "Refused";
  refusalReason?: string;
  refusalReasonCode?: string;
  action?: {
    type?: string;
    url?: string;
    method?: string;
  };
  amount?: AdyenAmount;
}

export interface AdyenCancelPaymentRequest {
  merchantAccount: string;
  reference: string;
}

export interface AdyenCancelPaymentResponse {
  pspReference: string;
  paymentPspReference: string;
  status: "received";
  reference?: string;
}

export interface AdyenRequestOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

/** Narrow 3-method structural contract consumed by createAdyenPaymentAdapter. */
export interface AdyenCheckoutClient {
  createSession(
    request: AdyenCreateSessionRequest,
    options: AdyenRequestOptions,
  ): Promise<AdyenCreateSessionResponse>;
  createPayment(
    request: AdyenCreatePaymentRequest,
    options: AdyenRequestOptions,
  ): Promise<AdyenCreatePaymentResponse>;
  cancelPayment?(
    pspReference: string,
    request: AdyenCancelPaymentRequest,
    options: AdyenRequestOptions,
  ): Promise<AdyenCancelPaymentResponse>;
}

export interface AdyenHttpClientConfig {
  mode: "live" | "test";
  /** Required when mode === "live". Strictly validated against /^[A-Za-z0-9-]+$/u. */
  liveUrlPrefix?: string;
  /** Per-call or static API key resolver; never logged or persisted. */
  apiKey: string | (() => string);
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  fetchImpl: AdyenFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const LIVE_PREFIX_PATTERN = /^[A-Za-z0-9-]+$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export const ADYEN_TEST_CHECKOUT_ORIGIN = "https://checkout-test.adyen.com";

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
 * Raw HTTP bodies, headers, and credentials never enter Error.message.
 */
export class AdyenTransportError extends Error {
  readonly diagnosticCode: string;
  readonly httpStatus: number | null;
  readonly phase: "before-dispatch" | "unknown";

  constructor(input: {
    diagnosticCode: string;
    httpStatus: number | null;
    phase: "before-dispatch" | "unknown";
  }) {
    const safeCode = toSafeDiagnosticCode(input.diagnosticCode, "ADYEN_TRANSPORT_ERROR");
    super(`Adyen transport error: ${safeCode}`);
    this.name = "AdyenTransportError";
    this.diagnosticCode = safeCode;
    this.httpStatus = input.httpStatus;
    this.phase = input.phase;
  }
}

export function resolveAdyenCheckoutBaseUrl(config: {
  mode: "live" | "test";
  liveUrlPrefix?: string;
}): string {
  if (config.mode === "test") {
    return `${ADYEN_TEST_CHECKOUT_ORIGIN}/v71`;
  }
  if (config.mode !== "live") {
    throw new Error("Invalid Adyen mode");
  }
  const prefix = config.liveUrlPrefix?.trim();
  if (!prefix || !LIVE_PREFIX_PATTERN.test(prefix)) {
    throw new Error("Adyen live mode requires a valid alphanumeric liveUrlPrefix");
  }
  return `https://${prefix}-checkout-live.adyenpayments.com/v71`;
}

export function assertSafeAdyenPathSegment(value: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid Adyen ${label}`);
  }
  return value;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new AdyenTransportError({
        diagnosticCode: "ADYEN_RESPONSE_TOO_LARGE",
        httpStatus: response.status,
        phase: "unknown",
      });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AdyenTransportError({
          diagnosticCode: "ADYEN_RESPONSE_TOO_LARGE",
          httpStatus: response.status,
          phase: "unknown",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

/**
 * Zero-SDK hardened HTTP client for Adyen Checkout API v71.
 * Enforces HTTPS origin pinning, redirect: "error", composed timeouts,
 * bounded body reads, and allowlisted diagnostic codes.
 */
export function createAdyenHttpClient(config: AdyenHttpClientConfig): Required<AdyenCheckoutClient> {
  if (typeof config.fetchImpl !== "function") {
    throw new Error("Adyen HTTP client requires an explicit fetchImpl");
  }
  const baseUrl = resolveAdyenCheckoutBaseUrl(config);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid Adyen timeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Invalid Adyen maxResponseBytes");
  }

  const readApiKey = (): string => {
    const key = typeof config.apiKey === "function" ? config.apiKey() : config.apiKey;
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new AdyenTransportError({
        diagnosticCode: "ADYEN_CREDENTIALS_MISSING",
        httpStatus: null,
        phase: "before-dispatch",
      });
    }
    return key;
  };

  async function postJson<TResponse>(
    path: string,
    body: unknown,
    options: AdyenRequestOptions,
  ): Promise<TResponse> {
    const apiKey = readApiKey();
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await config.fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "idempotency-key": options.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof AdyenTransportError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new AdyenTransportError({
        diagnosticCode: aborted ? "ADYEN_REQUEST_TIMEOUT" : "ADYEN_NETWORK_ERROR",
        httpStatus: null,
        phase: "unknown",
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Never propagate raw provider body text into Error.message.
      const phase: "before-dispatch" | "unknown" =
        response.status === 401 || response.status === 403 || response.status === 422
          ? "before-dispatch"
          : "unknown";
      throw new AdyenTransportError({
        diagnosticCode: `ADYEN_HTTP_${response.status}`,
        httpStatus: response.status,
        phase,
      });
    }

    let rawText: string;
    try {
      rawText = await readBoundedText(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof AdyenTransportError) throw error;
      throw new AdyenTransportError({
        diagnosticCode: "ADYEN_INVALID_UTF8_RESPONSE",
        httpStatus: response.status,
        phase: "unknown",
      });
    }

    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new AdyenTransportError({
          diagnosticCode: "ADYEN_MALFORMED_RESPONSE",
          httpStatus: response.status,
          phase: "unknown",
        });
      }
      return parsed as TResponse;
    } catch (error) {
      if (error instanceof AdyenTransportError) throw error;
      throw new AdyenTransportError({
        diagnosticCode: "ADYEN_MALFORMED_RESPONSE",
        httpStatus: response.status,
        phase: "unknown",
      });
    }
  }

  return {
    createSession(request, options) {
      return postJson<AdyenCreateSessionResponse>("/sessions", request, options);
    },
    createPayment(request, options) {
      return postJson<AdyenCreatePaymentResponse>("/payments", request, options);
    },
    async cancelPayment(pspReference, request, options) {
      const safeRef = assertSafeAdyenPathSegment(pspReference, "pspReference");
      return postJson<AdyenCancelPaymentResponse>(
        `/payments/${encodeURIComponent(safeRef)}/cancels`,
        request,
        options,
      );
    },
  };
}
