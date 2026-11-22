import { createHardenedFetch, HardenedFetchError } from "./hardenedFetch.js";

export type OAuth2GrantConfig =
  | {
      readonly type: "client_credentials";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scope?: string;
    }
  | {
      readonly type: "refresh_token";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
      readonly scope?: string;
    };

export interface OAuth2CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export interface OAuth2TokenCache {
  get(): Promise<OAuth2CachedToken | null> | OAuth2CachedToken | null;
  set(token: OAuth2CachedToken): Promise<void> | void;
  clear(): Promise<void> | void;
}

export type OAuth2TokenErrorKind =
  | "config_error"
  | "auth_failed"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "malformed_response";

export class OAuth2TokenError extends Error {
  readonly kind: OAuth2TokenErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: OAuth2TokenErrorKind,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`adapter_kit:oauth2:${kind}`);
    this.name = kind === "timeout" ? "AbortError" : "OAuth2TokenError";
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface OAuth2TokenManagerOptions {
  readonly tokenUrl: string;
  readonly grant: OAuth2GrantConfig;
  readonly fetchImpl: typeof fetch;
  readonly authMethod?: "basic" | "body";
  readonly contentType?: "form" | "json";
  readonly clock?: () => number;
  readonly refreshSkewSeconds?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly cache?: OAuth2TokenCache;
  readonly extraBodyParams?: Readonly<Record<string, string>>;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface OAuth2TokenManager {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  invalidate(): Promise<void>;
}

export function createOAuth2TokenManager(options: OAuth2TokenManagerOptions): OAuth2TokenManager {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.tokenUrl);
  } catch {
    throw new OAuth2TokenError("config_error");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new OAuth2TokenError("config_error");
  }
  if (!options.grant.clientId.trim() || !options.grant.clientSecret.trim()) {
    throw new OAuth2TokenError("config_error");
  }
  if (options.grant.type === "refresh_token" && !options.grant.refreshToken.trim()) {
    throw new OAuth2TokenError("config_error");
  }

  const authMethod = options.authMethod ?? "basic";
  const contentType = options.contentType ?? "form";
  const clock = options.clock ?? (() => Date.now());
  const refreshSkewMs = (options.refreshSkewSeconds ?? 60) * 1000;

  const client = createHardenedFetch({
    allowedOrigins: [parsedUrl.origin],
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxResponseBytes: options.maxResponseBytes ?? 65_536,
    clock,
  });

  let memoryToken: OAuth2CachedToken | null = null;
  let epoch = 0;
  let inFlight: { readonly epoch: number; readonly promise: Promise<OAuth2CachedToken> } | null = null;

  async function readValidCached(): Promise<string | null> {
    const now = clock();
    if (memoryToken && memoryToken.expiresAtMs - refreshSkewMs > now) {
      return memoryToken.accessToken;
    }
    if (options.cache) {
      const fromCache = await options.cache.get();
      if (fromCache && fromCache.expiresAtMs - refreshSkewMs > now) {
        memoryToken = fromCache;
        return fromCache.accessToken;
      }
    }
    return null;
  }

  async function requestToken(requestEpoch: number, signal?: AbortSignal): Promise<OAuth2CachedToken> {
    const params: Record<string, string> = {
      grant_type: options.grant.type,
      ...(options.grant.type === "refresh_token"
        ? { refresh_token: options.grant.refreshToken }
        : {}),
      ...(options.grant.scope ? { scope: options.grant.scope } : {}),
      ...(options.extraBodyParams ?? {}),
    };
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options.extraHeaders ?? {}),
    };

    if (authMethod === "basic") {
      const basic = Buffer.from(
        `${options.grant.clientId}:${options.grant.clientSecret}`,
        "utf8",
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    } else {
      params.client_id = options.grant.clientId;
      params.client_secret = options.grant.clientSecret;
    }

    let body: string;
    if (contentType === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(params).toString();
    }

    let data: unknown;
    try {
      const res = await client.fetchJson<unknown>(parsedUrl.toString(), {
        method: "POST",
        headers,
        body,
        ...(signal !== undefined ? { signal } : {}),
      });
      data = res.data;
    } catch (error) {
      if (error instanceof HardenedFetchError) {
        if (error.kind === "timeout") {
          throw new OAuth2TokenError("timeout");
        }
        if (error.kind === "http_error") {
          if (error.status === 400 || error.status === 401 || error.status === 403) {
            throw new OAuth2TokenError("auth_failed", { status: error.status });
          }
          if (error.status === 429) {
            throw new OAuth2TokenError("rate_limited", {
              status: 429,
              ...(error.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: error.retryAfterSeconds }
                : {}),
            });
          }
          throw new OAuth2TokenError("provider_unavailable", {
            ...(error.status !== undefined ? { status: error.status } : {}),
          });
        }
        if (error.kind === "malformed_json" || error.kind === "body_too_large") {
          throw new OAuth2TokenError("malformed_response", {
            ...(error.status !== undefined ? { status: error.status } : {}),
          });
        }
        throw new OAuth2TokenError("provider_unavailable");
      }
      throw new OAuth2TokenError("provider_unavailable");
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OAuth2TokenError("malformed_response");
    }
    const record = data as Record<string, unknown>;
    const accessToken = record.access_token;
    const rawExpires = record.expires_in;
    const expiresInSeconds =
      typeof rawExpires === "number"
        ? rawExpires
        : typeof rawExpires === "string" && /^\d+$/u.test(rawExpires.trim())
          ? Number.parseInt(rawExpires.trim(), 10)
          : NaN;

    if (
      typeof accessToken !== "string" ||
      accessToken.trim().length === 0 ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0
    ) {
      throw new OAuth2TokenError("malformed_response");
    }

    const token: OAuth2CachedToken = {
      accessToken,
      expiresAtMs: clock() + Math.floor(expiresInSeconds) * 1000,
    };

    // Only populate cache if invalidate() was not called while this request was in flight.
    if (requestEpoch === epoch) {
      memoryToken = token;
      if (options.cache) {
        await options.cache.set(token);
      }
    }
    return token;
  }

  return {
    async getAccessToken(signal?: AbortSignal): Promise<string> {
      const cached = await readValidCached();
      if (cached !== null) return cached;

      if (inFlight && inFlight.epoch === epoch) {
        const token = await inFlight.promise;
        return token.accessToken;
      }

      const currentEpoch = epoch;
      const promise = requestToken(currentEpoch, signal).finally(() => {
        if (inFlight?.promise === promise) {
          inFlight = null;
        }
      });
      inFlight = { epoch: currentEpoch, promise };
      const token = await promise;
      return token.accessToken;
    },
    async invalidate(): Promise<void> {
      epoch += 1;
      memoryToken = null;
      inFlight = null;
      if (options.cache) {
        await options.cache.clear();
      }
    },
  };
}
