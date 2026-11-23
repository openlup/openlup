import {
  createHardenedFetch,
  createOAuth2TokenManager,
  HardenedFetchError,
  OAuth2TokenError,
  type OAuth2TokenCache,
  type OAuth2TokenManager,
} from "@openlup/platform/adapter-kit";

export const XERO_API_ORIGIN = "https://api.xero.com" as const;
export const XERO_IDENTITY_ORIGIN = "https://identity.xero.com" as const;
export const XERO_OAUTH_TOKEN_URL = `${XERO_IDENTITY_ORIGIN}/connect/token` as const;

export const XERO_EGRESS_ORIGINS: readonly string[] = Object.freeze([
  XERO_API_ORIGIN,
  XERO_IDENTITY_ORIGIN,
]);

const TENANT_ID_PATTERN = /^[0-9a-fA-F-]{36}$/u;
const CONTROL_CHAR_PATTERN = /[\p{Cc}\p{Cf}]/u;

export interface XeroManualJournalLine {
  readonly LineAmount: string;
  readonly AccountCode: string;
  readonly Description?: string;
  readonly TaxType?: string;
}

export interface XeroCreateManualJournalPayload {
  readonly Narration: string;
  readonly Date: string;
  readonly Status: "POSTED";
  readonly JournalLines: readonly XeroManualJournalLine[];
}

export interface XeroManualJournalRef {
  readonly id: string;
  readonly narration: string;
}

export interface XeroClient {
  createManualJournal(
    exportKey: string,
    payload: XeroCreateManualJournalPayload,
    signal?: AbortSignal,
  ): Promise<XeroManualJournalRef>;
  findManualJournalByKey(
    exportKey: string,
    signal?: AbortSignal,
  ): Promise<XeroManualJournalRef | null>;
}

export type XeroClientErrorKind =
  | "config_error"
  | "invalid_request"
  | "auth_failed"
  | "provider_rejected"
  | "ambiguous_conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "transport_error";

export class XeroClientError extends Error {
  readonly kind: XeroClientErrorKind;
  readonly diagnosticCode: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: XeroClientErrorKind,
    diagnosticCode: string,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`xero:${kind}:${diagnosticCode}`);
    this.name = kind === "timeout" ? "AbortError" : "XeroClientError";
    this.kind = kind;
    this.diagnosticCode = diagnosticCode;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface XeroHttpClientOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl: typeof fetch;
  readonly scope?: string;
  readonly tokenUrl?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: () => number;
  readonly tokenCache?: OAuth2TokenCache;
}

/**
 * Strictly validates Xero `tenantId` against `/^[0-9a-fA-F-]{36}$/u` at construction time.
 */
export function assertSafeXeroTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new XeroClientError("config_error", "XERO_INVALID_TENANT_ID");
  }
  return tenantId;
}

/**
 * Validates that an `exportKey` is non-blank, bounded, and free of control characters before
 * placing it in HTTP headers (`Idempotency-Key`) or Xero `where` filter clauses.
 */
export function assertSafeXeroExportKey(exportKey: string): string {
  if (
    typeof exportKey !== "string" ||
    exportKey.trim().length === 0 ||
    exportKey.length > 160 ||
    CONTROL_CHAR_PATTERN.test(exportKey)
  ) {
    throw new XeroClientError("invalid_request", "XERO_INVALID_EXPORT_KEY");
  }
  return exportKey;
}

/**
 * Escapes backslashes and double quotes for Xero Accounting API `where` string literals.
 */
export function escapeXeroWhereLiteral(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function assertPinnedTokenUrl(rawUrl: string | undefined): string {
  const candidate = rawUrl ?? XERO_OAUTH_TOKEN_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new XeroClientError("config_error", "XERO_INVALID_TOKEN_URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== XERO_IDENTITY_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new XeroClientError("config_error", "XERO_INVALID_TOKEN_URL");
  }
  return parsed.toString();
}

function mapOAuth2Error(error: OAuth2TokenError): XeroClientError {
  switch (error.kind) {
    case "config_error":
    case "auth_failed":
      return new XeroClientError("auth_failed", "XERO_OAUTH_AUTH_FAILED", {
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
    case "rate_limited":
      return new XeroClientError("rate_limited", "XERO_OAUTH_RATE_LIMITED", {
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    case "timeout":
      return new XeroClientError("timeout", "XERO_OAUTH_TIMEOUT");
    case "provider_unavailable":
    case "malformed_response":
      return new XeroClientError("provider_unavailable", "XERO_OAUTH_UNAVAILABLE", {
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
  }
}

function mapHardenedFetchError(error: HardenedFetchError): XeroClientError {
  if (error.kind === "timeout") {
    return new XeroClientError("timeout", "XERO_TIMEOUT");
  }
  if (error.kind === "network_error") {
    return new XeroClientError("transport_error", "XERO_TRANSPORT_ERROR");
  }
  if (error.kind === "origin_rejected") {
    return new XeroClientError("config_error", "XERO_ORIGIN_REJECTED");
  }
  if (error.kind === "malformed_json" || error.kind === "body_too_large") {
    return new XeroClientError("provider_unavailable", "XERO_MALFORMED_RESPONSE", {
      ...(error.status !== undefined ? { status: error.status } : {}),
    });
  }
  const status = error.status;
  if (status === 401 || status === 403) {
    return new XeroClientError("auth_failed", "XERO_AUTH_FAILED", { status });
  }
  if (status === 408 || status === 409) {
    return new XeroClientError("ambiguous_conflict", "XERO_AMBIGUOUS_CONFLICT", { status });
  }
  if (status === 429) {
    return new XeroClientError("rate_limited", "XERO_RATE_LIMITED", {
      status,
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    });
  }
  if (status !== undefined && status >= 500) {
    return new XeroClientError("provider_unavailable", "XERO_PROVIDER_UNAVAILABLE", { status });
  }
  return new XeroClientError("provider_rejected", "XERO_PROVIDER_REJECTED", {
    ...(status !== undefined ? { status } : {}),
  });
}

function parseManualJournalItem(
  raw: unknown,
  fallbackNarration: string,
): (XeroManualJournalRef & { readonly reference?: string }) | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.ManualJournalID === "string" ? obj.ManualJournalID.trim() : "";
  if (!id) return null;
  const narration =
    typeof obj.Narration === "string" && obj.Narration.trim().length > 0
      ? obj.Narration
      : fallbackNarration;
  const reference =
    typeof obj.Reference === "string" && obj.Reference.trim().length > 0
      ? obj.Reference
      : undefined;
  return { id, narration, ...(reference ? { reference } : {}) };
}

/**
 * Zero-SDK Xero Accounting API 2.0 HTTP client built on `createHardenedFetch` and
 * `createOAuth2TokenManager` (`refresh_token` + Basic auth), validating `tenantId`
 * strictly at construction time and invalidating cached tokens on HTTP 401.
 */
export function createXeroHttpClient(options: XeroHttpClientOptions): XeroClient {
  const tenantId = assertSafeXeroTenantId(options.tenantId);
  const tokenUrl = assertPinnedTokenUrl(options.tokenUrl);

  let tokenManager: OAuth2TokenManager;
  try {
    tokenManager = createOAuth2TokenManager({
      tokenUrl,
      grant: {
        type: "refresh_token",
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        refreshToken: options.refreshToken,
        ...(options.scope ? { scope: options.scope } : {}),
      },
      fetchImpl: options.fetchImpl,
      authMethod: "basic",
      contentType: "form",
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxResponseBytes !== undefined
        ? { maxResponseBytes: options.maxResponseBytes }
        : {}),
      ...(options.tokenCache ? { cache: options.tokenCache } : {}),
    });
  } catch (error) {
    if (error instanceof OAuth2TokenError) {
      throw new XeroClientError("config_error", "XERO_INVALID_OAUTH_CONFIG");
    }
    throw error;
  }

  const apiFetch = createHardenedFetch({
    allowedOrigins: [XERO_API_ORIGIN],
    fetchImpl: options.fetchImpl,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined
      ? { maxResponseBytes: options.maxResponseBytes }
      : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });

  async function acquireAccessToken(signal?: AbortSignal): Promise<string> {
    try {
      return await tokenManager.getAccessToken(signal);
    } catch (error) {
      if (error instanceof OAuth2TokenError) {
        throw mapOAuth2Error(error);
      }
      throw new XeroClientError("provider_unavailable", "XERO_OAUTH_UNAVAILABLE");
    }
  }

  async function requestApiJson(
    url: string,
    init: {
      readonly method: "GET" | "PUT";
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const accessToken = await acquireAccessToken(init.signal);
    try {
      const response = await apiFetch.fetchJson<unknown>(url, {
        method: init.method,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": tenantId,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
      });
      return response.data;
    } catch (error) {
      if (error instanceof HardenedFetchError) {
        if (error.kind === "http_error" && error.status === 401) {
          await tokenManager.invalidate().catch(() => {});
        }
        throw mapHardenedFetchError(error);
      }
      throw new XeroClientError("transport_error", "XERO_TRANSPORT_ERROR");
    }
  }

  return Object.freeze({
    async createManualJournal(
      exportKey: string,
      payload: XeroCreateManualJournalPayload,
      signal?: AbortSignal,
    ): Promise<XeroManualJournalRef> {
      const safeKey = assertSafeXeroExportKey(exportKey);
      const url = `${XERO_API_ORIGIN}/api.xro/2.0/ManualJournals`;
      const data = await requestApiJson(url, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": safeKey,
        },
        body: JSON.stringify(payload),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new XeroClientError("provider_unavailable", "XERO_MALFORMED_RESPONSE");
      }
      const root = data as Record<string, unknown>;
      const list = root.ManualJournals;
      if (!Array.isArray(list) || list.length === 0) {
        throw new XeroClientError("provider_unavailable", "XERO_MALFORMED_RESPONSE");
      }
      const created = parseManualJournalItem(list[0], payload.Narration);
      if (!created) {
        throw new XeroClientError("provider_unavailable", "XERO_MALFORMED_RESPONSE");
      }
      return { id: created.id, narration: created.narration };
    },

    async findManualJournalByKey(
      exportKey: string,
      signal?: AbortSignal,
    ): Promise<XeroManualJournalRef | null> {
      const safeKey = assertSafeXeroExportKey(exportKey);
      const escaped = escapeXeroWhereLiteral(safeKey);
      const params = new URLSearchParams({
        where: `Narration=="${escaped}"`,
      });
      const url = `${XERO_API_ORIGIN}/api.xro/2.0/ManualJournals?${params.toString()}`;
      const data = await requestApiJson(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new XeroClientError("provider_unavailable", "XERO_MALFORMED_RESPONSE");
      }
      const root = data as Record<string, unknown>;
      const list = root.ManualJournals;
      if (list === undefined || list === null) {
        return null;
      }
      if (!Array.isArray(list)) {
        throw new XeroClientError("provider_unavailable", "XERO_MALFORMED_RESPONSE");
      }
      for (const item of list) {
        const parsed = parseManualJournalItem(item, safeKey);
        if (parsed && (parsed.narration === safeKey || parsed.reference === safeKey)) {
          return { id: parsed.id, narration: parsed.narration };
        }
      }
      return null;
    },
  });
}
