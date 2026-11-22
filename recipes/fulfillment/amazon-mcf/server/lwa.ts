import type { FetchLike } from "./client-contract.js";

export const AMAZON_LWA_TOKEN_ORIGIN = "https://api.amazon.com" as const;
export const AMAZON_LWA_TOKEN_URL = `${AMAZON_LWA_TOKEN_ORIGIN}/auth/o2/token` as const;

const DEFAULT_LWA_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface LwaCredentials {
  readonly lwaClientId: string;
  readonly lwaClientSecret: string;
  readonly lwaRefreshToken: string;
}

export interface LwaTokenClientOptions {
  readonly fetchImpl: FetchLike;
  readonly clock: () => string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly refreshSkewMs?: number;
}

export class LwaTokenError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly responseBodyRead: boolean;

  constructor(params: {
    readonly code: string;
    readonly status: number | null;
    readonly retryable: boolean;
    readonly responseBodyRead: boolean;
  }) {
    super(params.code);
    this.name = "LwaTokenError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    this.responseBodyRead = params.responseBodyRead;
  }
}

interface CachedAccessToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export interface LwaTokenClient {
  getAccessToken(credentials: LwaCredentials): Promise<string>;
  invalidate(): void;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancellation errors on oversized responses.
      }
      throw new LwaTokenError({
        code: "amazon_lwa_response_too_large",
        status: response.status,
        retryable: false,
        responseBodyRead: false,
      });
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new LwaTokenError({
      code: "amazon_lwa_response_too_large",
      status: response.status,
      retryable: false,
      responseBodyRead: true,
    });
  }
  return text;
}

function nowMsFromClock(clock: () => string): number {
  const parsed = Date.parse(clock());
  if (!Number.isFinite(parsed)) {
    throw new LwaTokenError({
      code: "amazon_lwa_invalid_clock",
      status: null,
      retryable: false,
      responseBodyRead: false,
    });
  }
  return parsed;
}

/**
 * Single-flight, instance-scoped Login with Amazon (LWA) OAuth2 token exchanger.
 * Pinned strictly to `https://api.amazon.com/auth/o2/token` with `redirect: "error"`.
 * Never logs or throws client secrets, refresh tokens, or access tokens.
 */
export function createLwaTokenClient(options: LwaTokenClientOptions): LwaTokenClient {
  const timeoutMs =
    options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_LWA_TIMEOUT_MS;
  const maxBodyBytes =
    options.maxBodyBytes && Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;
  const refreshSkewMs =
    options.refreshSkewMs !== undefined && Number.isFinite(options.refreshSkewMs) && options.refreshSkewMs >= 0
      ? options.refreshSkewMs
      : DEFAULT_REFRESH_SKEW_MS;

  const pinnedUrl = new URL(AMAZON_LWA_TOKEN_URL);
  let cached: CachedAccessToken | null = null;
  let inFlight: Promise<CachedAccessToken> | null = null;

  const fetchFreshToken = async (credentials: LwaCredentials): Promise<CachedAccessToken> => {
    const clientId = credentials.lwaClientId.trim();
    const clientSecret = credentials.lwaClientSecret.trim();
    const refreshToken = credentials.lwaRefreshToken.trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new LwaTokenError({
        code: "amazon_lwa_credentials_missing",
        status: null,
        retryable: false,
        responseBodyRead: false,
      });
    }

    if (
      pinnedUrl.protocol !== "https:" ||
      pinnedUrl.origin !== AMAZON_LWA_TOKEN_ORIGIN ||
      pinnedUrl.username ||
      pinnedUrl.password
    ) {
      throw new LwaTokenError({
        code: "amazon_lwa_origin_mismatch",
        status: null,
        retryable: false,
        responseBodyRead: false,
      });
    }

    const formBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await options.fetchImpl(pinnedUrl.href, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: formBody,
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // Ignore body cancel failure.
        }
        const retryable = response.status === 429 || response.status >= 500;
        throw new LwaTokenError({
          code: `amazon_lwa_http_${response.status}`,
          status: response.status,
          retryable,
          responseBodyRead: false,
        });
      }

      const rawText = await readBoundedResponseText(response, maxBodyBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new LwaTokenError({
          code: "amazon_lwa_invalid_json",
          status: response.status,
          retryable: false,
          responseBodyRead: true,
        });
      }

      if (!parsed || typeof parsed !== "object") {
        throw new LwaTokenError({
          code: "amazon_lwa_invalid_response",
          status: response.status,
          retryable: false,
          responseBodyRead: true,
        });
      }

      const record = parsed as Record<string, unknown>;
      const accessToken = typeof record["access_token"] === "string" ? record["access_token"].trim() : "";
      const expiresInSec =
        typeof record["expires_in"] === "number" && Number.isFinite(record["expires_in"]) && record["expires_in"] > 0
          ? record["expires_in"]
          : 3600;
      if (!accessToken) {
        throw new LwaTokenError({
          code: "amazon_lwa_missing_access_token",
          status: response.status,
          retryable: false,
          responseBodyRead: true,
        });
      }

      const nowMs = nowMsFromClock(options.clock);
      return {
        accessToken,
        expiresAtMs: nowMs + Math.floor(expiresInSec * 1000),
      };
    } catch (error) {
      if (error instanceof LwaTokenError) {
        throw error;
      }
      const aborted = controller.signal.aborted;
      throw new LwaTokenError({
        code: aborted ? "amazon_lwa_timeout" : "amazon_lwa_transport_error",
        status: null,
        retryable: true,
        responseBodyRead: false,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async getAccessToken(credentials: LwaCredentials): Promise<string> {
      const nowMs = nowMsFromClock(options.clock);
      if (cached && cached.expiresAtMs - refreshSkewMs > nowMs) {
        return cached.accessToken;
      }
      if (!inFlight) {
        inFlight = fetchFreshToken(credentials)
          .then((fresh) => {
            cached = fresh;
            return fresh;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      const token = await inFlight;
      return token.accessToken;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
