/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * Mollie Payments API v2 (recipe contract: zero vendor SDK, zero ambient environment
 * reads, zero ambient fetch, strict HTTPS origin pinning, redirect: "error").
 */

export type MollieFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MollieAmount {
  currency: string;
  value: string;
}

export type MollieSequenceType = "oneoff" | "first" | "recurring";

export type MolliePaymentStatus =
  | "open"
  | "canceled"
  | "pending"
  | "authorized"
  | "expired"
  | "failed"
  | "paid";

export interface MollieCreatePaymentRequest {
  amount: MollieAmount;
  description: string;
  redirectUrl?: string;
  webhookUrl?: string;
  method?: string | readonly string[];
  sequenceType?: MollieSequenceType;
  customerId?: string;
  mandateId?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface MolliePaymentLinks {
  checkout?: {
    href: string;
    type?: string;
  };
  [key: string]: unknown;
}

export interface MolliePaymentResource {
  resource?: string;
  id: string;
  mode: "live" | "test";
  status: MolliePaymentStatus;
  amount: MollieAmount;
  amountRemaining?: MollieAmount | null;
  amountRefunded?: MollieAmount | null;
  amountChargedBack?: MollieAmount | null;
  sequenceType?: MollieSequenceType;
  method?: string | null;
  customerId?: string | null;
  mandateId?: string | null;
  subscriptionId?: string | null;
  createdAt?: string | null;
  paidAt?: string | null;
  canceledAt?: string | null;
  expiredAt?: string | null;
  failedAt?: string | null;
  expiresAt?: string | null;
  metadata?: Readonly<Record<string, string>> | null;
  details?: Readonly<Record<string, unknown>> | null;
  _links?: MolliePaymentLinks;
}

export interface MollieCreateRefundRequest {
  amount: MollieAmount;
  description?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface MollieRefundResource {
  resource?: string;
  id: string;
  amount: MollieAmount;
  status: "queued" | "pending" | "processing" | "refunded" | "failed" | "canceled";
  createdAt?: string | null;
  paymentId?: string;
}

export interface MollieRequestOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

/** Narrow structural client contract consumed by createMolliePaymentAdapter. */
export interface MollieClient {
  createPayment(
    request: MollieCreatePaymentRequest,
    options: MollieRequestOptions,
  ): Promise<MolliePaymentResource>;
  getPayment(
    paymentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<MolliePaymentResource>;
  cancelPayment(
    paymentId: string,
    options?: MollieRequestOptions,
  ): Promise<MolliePaymentResource>;
  createRefund?(
    paymentId: string,
    request: MollieCreateRefundRequest,
    options: MollieRequestOptions,
  ): Promise<MollieRefundResource>;
}

export interface MollieHttpClientConfig {
  mode: "live" | "test";
  /** Static key or per-call resolver; validated against mode before dispatch. */
  apiKey: string | (() => string);
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  fetchImpl: MollieFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const MOLLIE_API_ORIGIN = "https://api.mollie.com";
const MOLLIE_API_BASE_URL = `${MOLLIE_API_ORIGIN}/v2`;

const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_MOLLIE_PAYMENT_ID = /^tr_[A-Za-z0-9]{1,64}$/u;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
const MIN_API_KEY_LENGTH = 10;

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
 * Raw HTTP bodies, headers, and credentials never enter Error.message.
 */
export class MollieTransportError extends Error {
  readonly diagnosticCode: string;
  readonly httpStatus: number | null;
  readonly phase: "before-dispatch" | "unknown";

  constructor(input: {
    diagnosticCode: string;
    httpStatus: number | null;
    phase: "before-dispatch" | "unknown";
  }) {
    const safeCode = toSafeDiagnosticCode(input.diagnosticCode, "MOLLIE_TRANSPORT_ERROR");
    super(`Mollie transport error: ${safeCode}`);
    this.name = "MollieTransportError";
    this.diagnosticCode = safeCode;
    this.httpStatus = input.httpStatus;
    this.phase = input.phase;
  }
}

export function assertSafeMolliePaymentId(paymentId: string): string {
  if (typeof paymentId !== "string" || !SAFE_MOLLIE_PAYMENT_ID.test(paymentId)) {
    throw new MollieTransportError({
      diagnosticCode: "MOLLIE_INVALID_PAYMENT_ID",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  return paymentId;
}

export function assertMollieKeyMatchesMode(
  apiKey: unknown,
  mode: "live" | "test",
): string {
  if (
    typeof apiKey !== "string"
    || apiKey.length === 0
    || hasWhitespaceOrControlChar(apiKey)
  ) {
    throw new MollieTransportError({
      diagnosticCode: "MOLLIE_CREDENTIALS_MISSING",
      httpStatus: null,
      phase: "before-dispatch",
    });
  }
  const expectedPrefix = mode === "live" ? "live_" : "test_";
  if (!apiKey.startsWith(expectedPrefix) || apiKey.length < MIN_API_KEY_LENGTH) {
    throw new MollieTransportError({
      diagnosticCode: "MOLLIE_KEY_MODE_MISMATCH",
      httpStatus: null,
      phase: "before-dispatch",
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

/** Converts integer minor units into an exact Mollie decimal string (zero float math). */
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

/** Parses a strict Mollie decimal string into safe integer minor units (zero float math). */
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

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new MollieTransportError({
        diagnosticCode: "MOLLIE_RESPONSE_TOO_LARGE",
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
        throw new MollieTransportError({
          diagnosticCode: "MOLLIE_RESPONSE_TOO_LARGE",
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
 * Zero-SDK hardened HTTP client for Mollie Payments API v2.
 * Enforces HTTPS origin pinning, mode-key prefix parity, redirect: "error",
 * composed timeouts, bounded streaming reads, and allowlisted diagnostics.
 */
export function createMollieHttpClient(config: MollieHttpClientConfig): Required<MollieClient> {
  if (config.mode !== "live" && config.mode !== "test") {
    throw new Error("Invalid Mollie mode");
  }
  if (typeof config.fetchImpl !== "function") {
    throw new Error("Mollie HTTP client requires an explicit fetchImpl");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid Mollie timeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Invalid Mollie maxResponseBytes");
  }

  if (typeof config.apiKey !== "function") {
    assertMollieKeyMatchesMode(config.apiKey, config.mode);
  }

  const readApiKey = (): string => {
    const rawKey = typeof config.apiKey === "function" ? config.apiKey() : config.apiKey;
    return assertMollieKeyMatchesMode(rawKey, config.mode);
  };

  async function requestJson<TResponse>(input: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<TResponse> {
    const apiKey = readApiKey();
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutController.signal])
      : timeoutController.signal;

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (input.idempotencyKey) {
      headers["idempotency-key"] = input.idempotencyKey;
    }

    let response: Response;
    let rawText: string;
    try {
      try {
        response = await config.fetchImpl(`${MOLLIE_API_BASE_URL}${input.path}`, {
          method: input.method,
          redirect: "error",
          signal,
          headers,
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
      } catch (error) {
        if (error instanceof MollieTransportError) throw error;
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new MollieTransportError({
          diagnosticCode: aborted ? "MOLLIE_REQUEST_TIMEOUT" : "MOLLIE_NETWORK_ERROR",
          httpStatus: null,
          phase: "unknown",
        });
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Never propagate raw provider error bodies into Error.message.
        const phase: "before-dispatch" | "unknown" =
          response.status === 401 || response.status === 403 || response.status === 422
            ? "before-dispatch"
            : "unknown";
        throw new MollieTransportError({
          diagnosticCode: `MOLLIE_HTTP_${response.status}`,
          httpStatus: response.status,
          phase,
        });
      }

      try {
        rawText = await readBoundedText(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof MollieTransportError) throw error;
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new MollieTransportError({
          diagnosticCode: aborted ? "MOLLIE_REQUEST_TIMEOUT" : "MOLLIE_INVALID_UTF8_RESPONSE",
          httpStatus: response.status,
          phase: "unknown",
        });
      }
    } finally {
      clearTimeout(timer);
    }

    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new MollieTransportError({
          diagnosticCode: "MOLLIE_MALFORMED_RESPONSE",
          httpStatus: response.status,
          phase: "unknown",
        });
      }
      return parsed as TResponse;
    } catch (error) {
      if (error instanceof MollieTransportError) throw error;
      throw new MollieTransportError({
        diagnosticCode: "MOLLIE_MALFORMED_RESPONSE",
        httpStatus: response.status,
        phase: "unknown",
      });
    }
  }

  return {
    async createPayment(request, options) {
      return requestJson<MolliePaymentResource>({
        method: "POST",
        path: "/payments",
        body: request,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      });
    },
    async getPayment(paymentId, options) {
      const safeId = assertSafeMolliePaymentId(paymentId);
      return requestJson<MolliePaymentResource>({
        method: "GET",
        path: `/payments/${encodeURIComponent(safeId)}`,
        signal: options?.signal,
      });
    },
    async cancelPayment(paymentId, options) {
      const safeId = assertSafeMolliePaymentId(paymentId);
      return requestJson<MolliePaymentResource>({
        method: "DELETE",
        path: `/payments/${encodeURIComponent(safeId)}`,
        idempotencyKey: options?.idempotencyKey,
        signal: options?.signal,
      });
    },
    async createRefund(paymentId, request, options) {
      const safeId = assertSafeMolliePaymentId(paymentId);
      return requestJson<MollieRefundResource>({
        method: "POST",
        path: `/payments/${encodeURIComponent(safeId)}/refunds`,
        body: request,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      });
    },
  };
}
