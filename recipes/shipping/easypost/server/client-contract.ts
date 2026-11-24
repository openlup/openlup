/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * EasyPost REST v2 Shipment Rates (recipe contract: zero vendor SDK, zero ambient
 * environment reads, zero ambient fetch, strict HTTPS origin pinning,
 * redirect: "error").
 */

export type EasyPostFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface EasyPostAddressInput {
  readonly country: string;
  readonly zip: string;
  readonly state?: string;
  readonly city?: string;
  readonly residential?: boolean;
}

export interface EasyPostParcelInput {
  readonly weight: number;
  readonly length?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface EasyPostCreateShipmentInput {
  readonly shipment: {
    readonly from_address: EasyPostAddressInput;
    readonly to_address: EasyPostAddressInput;
    readonly parcel: EasyPostParcelInput;
    readonly reference?: string;
  };
}

export interface EasyPostRateRecord {
  readonly id?: string;
  readonly carrier?: string;
  readonly service?: string;
  readonly rate?: string;
  readonly currency?: string;
  readonly delivery_days?: number | null;
  readonly est_delivery_days?: number | null;
  readonly delivery_date_guaranteed?: boolean;
}

export interface EasyPostShipmentResponse {
  readonly id?: string;
  readonly rates?: readonly EasyPostRateRecord[];
}

export interface EasyPostRequestOptions {
  readonly signal?: AbortSignal;
}

/** Narrow structural client contract consumed by createEasyPostCarrierRateAdapter. */
export interface EasyPostRateClient {
  createShipmentRates(
    input: EasyPostCreateShipmentInput,
    options?: EasyPostRequestOptions,
  ): Promise<EasyPostShipmentResponse>;
}

export interface EasyPostHttpClientConfig {
  readonly apiKey: string;
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  readonly fetchImpl: EasyPostFetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Optional clock supplier used when parsing HTTP-date Retry-After headers. */
  readonly now?: () => number;
}

export const EASYPOST_API_ORIGIN = "https://api.easypost.com";
export const EASYPOST_SHIPMENTS_URL = `${EASYPOST_API_ORIGIN}/v2/shipments`;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export type EasyPostTransportErrorKind =
  | "invalid_config"
  | "auth"
  | "rate_limited"
  | "http_5xx"
  | "http_4xx"
  | "timeout"
  | "network"
  | "response_too_large"
  | "malformed_response";

function toSafeDiagnosticCode(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return SAFE_DIAGNOSTIC_CODE.test(normalized) ? normalized : fallback;
}

function hasWhitespaceOrControlChar(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Redacted transport error carrying only allowlisted diagnostic codes.
 * Credentials, raw HTTP response bodies, and upstream error messages are never included.
 */
export class EasyPostTransportError extends Error {
  readonly kind: EasyPostTransportErrorKind;
  readonly httpStatus: number | null;
  readonly diagnosticCode: string;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    readonly kind: EasyPostTransportErrorKind;
    readonly httpStatus: number | null;
    readonly diagnosticCode: string;
    readonly retryAfterSeconds?: number;
  }) {
    const safeCode = toSafeDiagnosticCode(input.diagnosticCode, "EASYPOST_TRANSPORT_ERROR");
    super(`EasyPost transport error: ${safeCode}`);
    this.name = input.kind === "timeout" ? "AbortError" : "EasyPostTransportError";
    this.kind = input.kind;
    this.httpStatus = input.httpStatus;
    this.diagnosticCode = safeCode;
    if (input.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
  }
}

/** Parses an HTTP `Retry-After` header (integer seconds or HTTP-date) into clamped positive seconds. */
export function parseRetryAfterHeader(
  rawHeader: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof rawHeader !== "string") return undefined;
  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) return undefined;

  if (/^[0-9]+$/u.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
    return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
  }

  const targetMs = Date.parse(trimmed);
  if (!Number.isFinite(targetMs)) return undefined;
  const deltaSeconds = Math.ceil((targetMs - nowMs) / 1000);
  if (deltaSeconds <= 0) return undefined;
  return Math.min(deltaSeconds, MAX_RETRY_AFTER_SECONDS);
}

function validateApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || apiKey.length === 0 || hasWhitespaceOrControlChar(apiKey)) {
    throw new EasyPostTransportError({
      kind: "invalid_config",
      httpStatus: null,
      diagnosticCode: "EASYPOST_INVALID_API_KEY",
    });
  }
  return apiKey;
}

function isAbortOrTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = (error as { readonly name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(
      new EasyPostTransportError({
        kind: "timeout",
        httpStatus: null,
        diagnosticCode: "EASYPOST_TIMEOUT",
      }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort();
      reject(
        new EasyPostTransportError({
          kind: "timeout",
          httpStatus: null,
          diagnosticCode: "EASYPOST_TIMEOUT",
        }),
      );
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new EasyPostTransportError({
        kind: "response_too_large",
        httpStatus: response.status,
        diagnosticCode: "EASYPOST_RESPONSE_TOO_LARGE",
      });
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await withAbortSignal(reader.read(), signal, () => {
          void reader.cancel().catch(() => undefined);
        });
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new EasyPostTransportError({
            kind: "response_too_large",
            httpStatus: response.status,
            diagnosticCode: "EASYPOST_RESPONSE_TOO_LARGE",
          });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(merged);
    } catch {
      throw new EasyPostTransportError({
        kind: "malformed_response",
        httpStatus: response.status,
        diagnosticCode: "EASYPOST_INVALID_UTF8_RESPONSE",
      });
    }
  }

  const text = await withAbortSignal(response.text(), signal, () => undefined);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new EasyPostTransportError({
      kind: "response_too_large",
      httpStatus: response.status,
      diagnosticCode: "EASYPOST_RESPONSE_TOO_LARGE",
    });
  }
  return text;
}

/**
 * Zero-SDK hardened HTTP client for EasyPost REST v2 `/v2/shipments`.
 * Enforces pinned HTTPS origin, HTTP Basic Auth, `redirect: "error"`,
 * composed `AbortSignal.timeout` + caller `signal`, streaming response byte cap,
 * `Retry-After` parsing on HTTP 429, and redacted error mapping.
 */
export function createEasyPostHttpClient(
  config: EasyPostHttpClientConfig,
): EasyPostRateClient {
  const apiKey = validateApiKey(config.apiKey);
  if (typeof config.fetchImpl !== "function") {
    throw new EasyPostTransportError({
      kind: "invalid_config",
      httpStatus: null,
      diagnosticCode: "EASYPOST_FETCH_REQUIRED",
    });
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EasyPostTransportError({
      kind: "invalid_config",
      httpStatus: null,
      diagnosticCode: "EASYPOST_INVALID_TIMEOUT",
    });
  }

  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new EasyPostTransportError({
      kind: "invalid_config",
      httpStatus: null,
      diagnosticCode: "EASYPOST_INVALID_MAX_BYTES",
    });
  }

  const now = config.now ?? (() => Date.now());
  const basicAuthHeader = `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;

  return {
    async createShipmentRates(input, options) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      if (signal.aborted) {
        throw new EasyPostTransportError({
          kind: "timeout",
          httpStatus: null,
          diagnosticCode: "EASYPOST_TIMEOUT",
        });
      }

      let response: Response;
      try {
        response = await config.fetchImpl(EASYPOST_SHIPMENTS_URL, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: basicAuthHeader,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        });
      } catch (error) {
        if (error instanceof EasyPostTransportError) throw error;
        if (isAbortOrTimeoutError(error, signal)) {
          throw new EasyPostTransportError({
            kind: "timeout",
            httpStatus: null,
            diagnosticCode: "EASYPOST_TIMEOUT",
          });
        }
        throw new EasyPostTransportError({
          kind: "network",
          httpStatus: null,
          diagnosticCode: "EASYPOST_NETWORK_ERROR",
        });
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);

        if (response.status === 401 || response.status === 403) {
          throw new EasyPostTransportError({
            kind: "auth",
            httpStatus: response.status,
            diagnosticCode: `EASYPOST_HTTP_${response.status}`,
          });
        }

        if (response.status === 429) {
          const retryAfterSeconds = parseRetryAfterHeader(
            response.headers.get("retry-after"),
            now(),
          );
          throw new EasyPostTransportError({
            kind: "rate_limited",
            httpStatus: 429,
            diagnosticCode: "EASYPOST_HTTP_429",
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          });
        }

        if (response.status >= 500 && response.status <= 599) {
          throw new EasyPostTransportError({
            kind: "http_5xx",
            httpStatus: response.status,
            diagnosticCode: `EASYPOST_HTTP_${response.status}`,
          });
        }

        throw new EasyPostTransportError({
          kind: "http_4xx",
          httpStatus: response.status,
          diagnosticCode: `EASYPOST_HTTP_${response.status}`,
        });
      }

      let rawText: string;
      try {
        rawText = await readBoundedText(response, maxResponseBytes, signal);
      } catch (error) {
        if (error instanceof EasyPostTransportError) throw error;
        if (isAbortOrTimeoutError(error, signal)) {
          throw new EasyPostTransportError({
            kind: "timeout",
            httpStatus: response.status,
            diagnosticCode: "EASYPOST_TIMEOUT",
          });
        }
        throw new EasyPostTransportError({
          kind: "network",
          httpStatus: response.status,
          diagnosticCode: "EASYPOST_STREAM_ERROR",
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new EasyPostTransportError({
          kind: "malformed_response",
          httpStatus: response.status,
          diagnosticCode: "EASYPOST_MALFORMED_RESPONSE",
        });
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new EasyPostTransportError({
          kind: "malformed_response",
          httpStatus: response.status,
          diagnosticCode: "EASYPOST_MALFORMED_RESPONSE",
        });
      }

      return parsed as EasyPostShipmentResponse;
    },
  };
}
