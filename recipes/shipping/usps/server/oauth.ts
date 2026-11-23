export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UspsEnvironment = "production" | "tem";

export const USPS_OAUTH_ORIGINS: Readonly<Record<UspsEnvironment, string>> = Object.freeze({
  production: "https://apis.usps.com",
  tem: "https://apis-tem.usps.com",
});

export const USPS_OAUTH_TOKEN_PATH = "/oauth2/v3/token" as const;

export const USPS_OAUTH_TOKEN_URLS: Readonly<Record<UspsEnvironment, string>> = Object.freeze({
  production: `${USPS_OAUTH_ORIGINS.production}${USPS_OAUTH_TOKEN_PATH}`,
  tem: `${USPS_OAUTH_ORIGINS.tem}${USPS_OAUTH_TOKEN_PATH}`,
});

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_REFRESH_SKEW_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 86_400;

export interface UspsOAuth2TokenManagerOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: UspsEnvironment;
  readonly fetchImpl: FetchLike;
  readonly clock?: () => number;
  readonly refreshSkewSeconds?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface UspsOAuth2TokenManager {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

export class UspsOAuth2Error extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    readonly code: string;
    readonly status: number | null;
    readonly retryable: boolean;
    readonly retryAfterSeconds?: number;
  }) {
    super(params.code);
    this.name = "UspsOAuth2Error";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    if (params.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = params.retryAfterSeconds;
    }
  }
}

interface CachedUspsToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export function parseRetryAfterSeconds(headerValue: string | null, nowMs: number): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
    return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
  }
  const targetMs = Date.parse(trimmed);
  if (!Number.isFinite(targetMs)) return undefined;
  const deltaSeconds = Math.ceil((targetMs - nowMs) / 1000);
  if (!Number.isSafeInteger(deltaSeconds) || deltaSeconds <= 0) return undefined;
  return Math.min(deltaSeconds, MAX_RETRY_AFTER_SECONDS);
}

async function cancelResponseBodySafely(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cancellation failures on rejected responses.
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelResponseBodySafely(response);
      throw new UspsOAuth2Error({
        code: "usps_oauth_response_too_large",
        status: response.status,
        retryable: false,
      });
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let totalBytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new UspsOAuth2Error({
              code: "usps_oauth_response_too_large",
              status: response.status,
              retryable: false,
            });
          }
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock();
    }
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new UspsOAuth2Error({
      code: "usps_oauth_response_too_large",
      status: response.status,
      retryable: false,
    });
  }
  return text;
}

function readValidClockMs(clock: () => number): number {
  const nowMs = clock();
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new UspsOAuth2Error({
      code: "usps_oauth_invalid_clock",
      status: null,
      retryable: false,
    });
  }
  return nowMs;
}

function parseExpiresInSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+(?:\.\d+)?$/u.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3600;
}

function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      new UspsOAuth2Error({
        code: "usps_oauth_aborted",
        status: null,
        retryable: true,
      }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        new UspsOAuth2Error({
          code: "usps_oauth_aborted",
          status: null,
          retryable: true,
        }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Zero-dependency, single-flight USPS OAuth2 `client_credentials` token manager.
 * Pinned strictly to `https://apis.usps.com/oauth2/v3/token` or `https://apis-tem.usps.com/oauth2/v3/token`
 * with `redirect: "error"`, streaming byte caps, and zero credential/token leakage in errors.
 */
export function createUspsOAuth2TokenManager(
  options: UspsOAuth2TokenManagerOptions,
): UspsOAuth2TokenManager {
  if (!Object.hasOwn(USPS_OAUTH_ORIGINS, options.environment)) {
    throw new UspsOAuth2Error({
      code: "usps_oauth_unsupported_environment",
      status: null,
      retryable: false,
    });
  }

  const expectedOrigin = USPS_OAUTH_ORIGINS[options.environment];
  const pinnedUrl = new URL(USPS_OAUTH_TOKEN_URLS[options.environment]);
  if (
    pinnedUrl.protocol !== "https:" ||
    pinnedUrl.origin !== expectedOrigin ||
    pinnedUrl.pathname !== USPS_OAUTH_TOKEN_PATH ||
    pinnedUrl.username ||
    pinnedUrl.password
  ) {
    throw new UspsOAuth2Error({
      code: "usps_oauth_origin_mismatch",
      status: null,
      retryable: false,
    });
  }

  const clock = options.clock ?? (() => Date.now());
  const refreshSkewMs =
    options.refreshSkewSeconds !== undefined &&
    Number.isFinite(options.refreshSkewSeconds) &&
    options.refreshSkewSeconds >= 0
      ? Math.floor(options.refreshSkewSeconds * 1000)
      : DEFAULT_REFRESH_SKEW_SECONDS * 1000;
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes !== undefined &&
    Number.isFinite(options.maxResponseBytes) &&
    options.maxResponseBytes > 0
      ? Math.floor(options.maxResponseBytes)
      : DEFAULT_MAX_RESPONSE_BYTES;

  let cached: CachedUspsToken | null = null;
  let inFlight: { readonly epoch: number; readonly promise: Promise<CachedUspsToken> } | null = null;
  let cacheEpoch = 0;

  const fetchFreshToken = async (): Promise<CachedUspsToken> => {
    const clientId = typeof options.clientId === "string" ? options.clientId.trim() : "";
    const clientSecret = typeof options.clientSecret === "string" ? options.clientSecret.trim() : "";
    if (!clientId || !clientSecret) {
      throw new UspsOAuth2Error({
        code: "usps_oauth_credentials_missing",
        status: null,
        retryable: false,
      });
    }

    const body = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(pinnedUrl.href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        const nowMs = readValidClockMs(clock);
        const retryAfterSeconds =
          response.status === 429
            ? parseRetryAfterSeconds(response.headers.get("retry-after"), nowMs)
            : undefined;
        await cancelResponseBodySafely(response);
        if (response.status === 429) {
          throw new UspsOAuth2Error({
            code: "usps_oauth_rate_limited",
            status: 429,
            retryable: true,
            retryAfterSeconds,
          });
        }
        throw new UspsOAuth2Error({
          code: `usps_oauth_http_${response.status}`,
          status: response.status,
          retryable: response.status >= 500 && response.status <= 599,
        });
      }

      const rawText = await readBoundedResponseText(response, maxResponseBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new UspsOAuth2Error({
          code: "usps_oauth_invalid_json",
          status: response.status,
          retryable: false,
        });
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new UspsOAuth2Error({
          code: "usps_oauth_invalid_response",
          status: response.status,
          retryable: false,
        });
      }

      const record = parsed as Record<string, unknown>;
      const accessToken =
        typeof record["access_token"] === "string" ? record["access_token"].trim() : "";
      if (!accessToken) {
        throw new UspsOAuth2Error({
          code: "usps_oauth_missing_access_token",
          status: response.status,
          retryable: false,
        });
      }

      const expiresInSec = parseExpiresInSeconds(record["expires_in"]);
      const nowMs = readValidClockMs(clock);
      return {
        accessToken,
        expiresAtMs: nowMs + Math.floor(expiresInSec * 1000),
      };
    } catch (error) {
      if (error instanceof UspsOAuth2Error) {
        throw error;
      }
      const isTimeout =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      throw new UspsOAuth2Error({
        code: isTimeout ? "usps_oauth_timeout" : "usps_oauth_transport_error",
        status: null,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async getAccessToken(signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) {
        throw new UspsOAuth2Error({
          code: "usps_oauth_aborted",
          status: null,
          retryable: true,
        });
      }
      const nowMs = readValidClockMs(clock);
      if (cached && cached.expiresAtMs - refreshSkewMs > nowMs) {
        return cached.accessToken;
      }
      if (inFlight && inFlight.epoch === cacheEpoch) {
        const token = await raceWithAbortSignal(inFlight.promise, signal);
        return token.accessToken;
      }
      const requestEpoch = cacheEpoch;
      const promise = fetchFreshToken()
        .then((fresh) => {
          if (cacheEpoch === requestEpoch) {
            cached = fresh;
          }
          return fresh;
        })
        .finally(() => {
          if (inFlight?.promise === promise) {
            inFlight = null;
          }
        });
      inFlight = { epoch: requestEpoch, promise };
      const token = await raceWithAbortSignal(promise, signal);
      return token.accessToken;
    },
    invalidate(): void {
      cacheEpoch += 1;
      cached = null;
      inFlight = null;
    },
  };
}
