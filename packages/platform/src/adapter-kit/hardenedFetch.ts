export type HardenedFetchErrorKind =
  | "origin_rejected"
  | "timeout"
  | "body_too_large"
  | "http_error"
  | "network_error"
  | "malformed_json";

const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function sanitizeDiagnosticCode(code: string, fallback = "ADAPTER_HTTP_ERROR"): string {
  return DIAGNOSTIC_CODE_PATTERN.test(code) ? code : fallback;
}

export class HardenedFetchError extends Error {
  readonly kind: HardenedFetchErrorKind;
  readonly diagnosticCode: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: HardenedFetchErrorKind,
    diagnosticCode: string,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    const safeCode = sanitizeDiagnosticCode(diagnosticCode);
    super(`adapter_kit:${kind}:${safeCode}`);
    this.name = kind === "timeout" ? "AbortError" : "HardenedFetchError";
    this.kind = kind;
    this.diagnosticCode = safeCode;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function parseRetryAfter(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
  maxSeconds = 86_400,
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
    return Math.min(parsed, maxSeconds);
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) return undefined;
  const deltaSeconds = Math.ceil((parsedDate - nowMs) / 1000);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return undefined;
  return Math.min(deltaSeconds, maxSeconds);
}

export interface RetryAfterCooldown {
  isCoolingDown(): boolean;
  remainingSeconds(): number;
  recordRetryAfter(secondsOrHeader: number | string | null | undefined): number | undefined;
  reset(): void;
}

export function createRetryAfterCooldown(options?: {
  readonly clock?: () => number;
  readonly maxCooldownSeconds?: number;
}): RetryAfterCooldown {
  const clock = options?.clock ?? (() => Date.now());
  const maxSeconds = options?.maxCooldownSeconds ?? 3_600;
  let cooldownUntilMs = 0;

  return {
    isCoolingDown(): boolean {
      return clock() < cooldownUntilMs;
    },
    remainingSeconds(): number {
      const remaining = Math.ceil((cooldownUntilMs - clock()) / 1000);
      return remaining > 0 ? remaining : 0;
    },
    recordRetryAfter(secondsOrHeader: number | string | null | undefined): number | undefined {
      const now = clock();
      let seconds: number | undefined;
      if (typeof secondsOrHeader === "number") {
        if (Number.isFinite(secondsOrHeader) && secondsOrHeader > 0) {
          seconds = Math.min(Math.ceil(secondsOrHeader), maxSeconds);
        }
      } else {
        seconds = parseRetryAfter(secondsOrHeader, now, maxSeconds);
      }
      if (seconds === undefined) return undefined;
      const target = now + seconds * 1000;
      if (target > cooldownUntilMs) cooldownUntilMs = target;
      return seconds;
    },
    reset(): void {
      cooldownUntilMs = 0;
    },
  };
}

function parsePinnedHttpsOrigin(rawOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new HardenedFetchError("origin_rejected", "INVALID_ALLOWED_ORIGIN");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new HardenedFetchError("origin_rejected", "INVALID_ALLOWED_ORIGIN");
  }
  return parsed.origin;
}

function composeSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  return false;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength.trim())) {
    const declared = Number.parseInt(contentLength.trim(), 10);
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new HardenedFetchError("body_too_large", "RESPONSE_BODY_TOO_LARGE", {
        status: response.status,
      });
    }
  }

  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HardenedFetchError("body_too_large", "RESPONSE_BODY_TOO_LARGE", {
          status: response.status,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface HardenedFetchOptions {
  readonly allowedOrigins: readonly string[];
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly clock?: () => number;
}

export interface HardenedFetchRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface HardenedFetchBytesResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface HardenedFetchJsonResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: T;
}

export interface HardenedFetchClient {
  fetchBytes(url: string, init?: HardenedFetchRequestInit): Promise<HardenedFetchBytesResponse>;
  fetchJson<T = unknown>(url: string, init?: HardenedFetchRequestInit): Promise<HardenedFetchJsonResponse<T>>;
}

export function createHardenedFetch(options: HardenedFetchOptions): HardenedFetchClient {
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) {
    throw new HardenedFetchError("origin_rejected", "EMPTY_ALLOWED_ORIGINS");
  }
  const allowedOriginSet = new Set(options.allowedOrigins.map(parsePinnedHttpsOrigin));
  const defaultTimeoutMs = options.timeoutMs ?? 10_000;
  const defaultMaxBytes = options.maxResponseBytes ?? 524_288;
  const clock = options.clock ?? (() => Date.now());
  if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new HardenedFetchError("origin_rejected", "INVALID_TIMEOUT_MS");
  }
  if (!Number.isSafeInteger(defaultMaxBytes) || defaultMaxBytes <= 0) {
    throw new HardenedFetchError("origin_rejected", "INVALID_MAX_RESPONSE_BYTES");
  }

  async function fetchBytes(
    rawUrl: string,
    init?: HardenedFetchRequestInit,
  ): Promise<HardenedFetchBytesResponse> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new HardenedFetchError("origin_rejected", "INVALID_REQUEST_URL");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !allowedOriginSet.has(parsed.origin)
    ) {
      throw new HardenedFetchError("origin_rejected", "ORIGIN_NOT_ALLOWED");
    }

    const timeoutMs = init?.timeoutMs ?? defaultTimeoutMs;
    const maxBytes = init?.maxResponseBytes ?? defaultMaxBytes;
    const signal = composeSignal(timeoutMs, init?.signal);
    const mergedHeaders: Record<string, string> = {
      ...(options.defaultHeaders ?? {}),
      ...(init?.headers ?? {}),
    };

    let response: Response;
    try {
      response = await options.fetchImpl(parsed.toString(), {
        method: init?.method ?? "GET",
        headers: mergedHeaders,
        ...(init?.body !== undefined ? { body: init.body as BodyInit } : {}),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new HardenedFetchError("timeout", "UPSTREAM_TIMEOUT");
      }
      throw new HardenedFetchError("network_error", "UPSTREAM_NETWORK_ERROR");
    }

    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), clock());
      await response.body?.cancel().catch(() => {});
      const code =
        response.status === 401 || response.status === 403
          ? "UPSTREAM_AUTH_FAILED"
          : response.status === 429
            ? "UPSTREAM_RATE_LIMITED"
            : response.status >= 500
              ? "UPSTREAM_SERVER_ERROR"
              : "UPSTREAM_CLIENT_ERROR";
      throw new HardenedFetchError("http_error", code, {
        status: response.status,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    }

    try {
      const body = await readBoundedBytes(response, maxBytes);
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (error instanceof HardenedFetchError) throw error;
      if (isAbortError(error, signal)) {
        throw new HardenedFetchError("timeout", "UPSTREAM_TIMEOUT");
      }
      throw new HardenedFetchError("network_error", "UPSTREAM_STREAM_ERROR");
    }
  }

  async function fetchJson<T = unknown>(
    rawUrl: string,
    init?: HardenedFetchRequestInit,
  ): Promise<HardenedFetchJsonResponse<T>> {
    const res = await fetchBytes(rawUrl, init);
    const text = new TextDecoder().decode(res.body);
    try {
      const data = JSON.parse(text) as T;
      return { status: res.status, headers: res.headers, data };
    } catch {
      throw new HardenedFetchError("malformed_json", "UPSTREAM_MALFORMED_JSON", {
        status: res.status,
      });
    }
  }

  return Object.freeze({ fetchBytes, fetchJson });
}
