import {
  createHardenedFetch,
  createOAuth2TokenManager,
  HardenedFetchError,
  OAuth2TokenError,
  type OAuth2TokenCache,
  type OAuth2TokenManager,
} from "@openlup/platform/adapter-kit";

export type QuickBooksOnlineEnvironment = "production" | "sandbox";

export const QBO_ORIGINS: Readonly<Record<QuickBooksOnlineEnvironment, string>> = Object.freeze({
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
});

export const QBO_OAUTH_ORIGIN = "https://oauth.platform.intuit.com" as const;
export const QBO_OAUTH_TOKEN_URL = `${QBO_OAUTH_ORIGIN}/oauth2/v1/tokens/bearer` as const;
export const QBO_MINOR_VERSION = "73" as const;

export const QBO_EGRESS_ORIGINS: readonly string[] = Object.freeze([
  QBO_ORIGINS.production,
  QBO_ORIGINS.sandbox,
  QBO_OAUTH_ORIGIN,
]);

const REALM_ID_PATTERN = /^[0-9]{1,32}$/u;
const CONTROL_CHAR_PATTERN = /[\p{Cc}\p{Cf}]/u;

export interface QuickBooksJournalEntryLine {
  readonly Description?: string;
  readonly Amount: string;
  readonly DetailType: "JournalEntryLineDetail";
  readonly JournalEntryLineDetail: {
    readonly PostingType: "Debit" | "Credit";
    readonly AccountRef: {
      readonly value: string;
    };
    readonly TaxCodeRef?: {
      readonly value: string;
    };
    readonly Entity?: {
      readonly EntityRef: {
        readonly value: string;
      };
    };
  };
}

export interface QuickBooksCreateJournalEntryPayload {
  readonly DocNumber: string;
  readonly TxnDate: string;
  readonly PrivateNote?: string;
  readonly CurrencyRef: {
    readonly value: string;
  };
  readonly Line: readonly QuickBooksJournalEntryLine[];
}

export interface QuickBooksJournalEntryRef {
  readonly id: string;
  readonly docNumber: string;
}

export interface QuickBooksOnlineClient {
  createJournalEntry(
    exportKey: string,
    payload: QuickBooksCreateJournalEntryPayload,
    signal?: AbortSignal,
  ): Promise<QuickBooksJournalEntryRef>;
  findJournalEntryByDocNumber(
    exportKey: string,
    signal?: AbortSignal,
  ): Promise<QuickBooksJournalEntryRef | null>;
}

export type QuickBooksOnlineClientErrorKind =
  | "config_error"
  | "invalid_request"
  | "auth_failed"
  | "provider_rejected"
  | "ambiguous_conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "transport_error";

export class QuickBooksOnlineClientError extends Error {
  readonly kind: QuickBooksOnlineClientErrorKind;
  readonly diagnosticCode: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: QuickBooksOnlineClientErrorKind,
    diagnosticCode: string,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`quickbooks_online:${kind}:${diagnosticCode}`);
    this.name = kind === "timeout" ? "AbortError" : "QuickBooksOnlineClientError";
    this.kind = kind;
    this.diagnosticCode = diagnosticCode;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface QuickBooksOnlineHttpClientOptions {
  readonly environment: QuickBooksOnlineEnvironment;
  readonly realmId: string;
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
 * Strictly validates QuickBooks Online `realmId` as 1-32 ASCII digits to prevent path traversal.
 */
export function assertSafeQuickBooksRealmId(realmId: string): string {
  if (typeof realmId !== "string" || !REALM_ID_PATTERN.test(realmId)) {
    throw new QuickBooksOnlineClientError("config_error", "QBO_INVALID_REALM_ID");
  }
  return realmId;
}

/**
 * Validates that an `exportKey` is non-blank, bounded, and free of control characters before
 * placing it in HTTP headers or QBO query literals.
 */
export function assertSafeQuickBooksExportKey(exportKey: string): string {
  if (
    typeof exportKey !== "string" ||
    exportKey.trim().length === 0 ||
    exportKey.length > 160 ||
    CONTROL_CHAR_PATTERN.test(exportKey)
  ) {
    throw new QuickBooksOnlineClientError("invalid_request", "QBO_INVALID_EXPORT_KEY");
  }
  return exportKey;
}

/**
 * Escapes backslashes and single quotes for Intuit Query Language string literals.
 */
export function escapeQuickBooksQueryLiteral(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

export function resolvePinnedQuickBooksOrigin(environment: QuickBooksOnlineEnvironment): string {
  if (!Object.hasOwn(QBO_ORIGINS, environment)) {
    throw new QuickBooksOnlineClientError("config_error", "QBO_UNSUPPORTED_ENVIRONMENT");
  }
  return QBO_ORIGINS[environment];
}

function assertPinnedTokenUrl(rawUrl: string | undefined): string {
  const candidate = rawUrl ?? QBO_OAUTH_TOKEN_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new QuickBooksOnlineClientError("config_error", "QBO_INVALID_TOKEN_URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== QBO_OAUTH_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new QuickBooksOnlineClientError("config_error", "QBO_INVALID_TOKEN_URL");
  }
  return parsed.toString();
}

function mapOAuth2Error(error: OAuth2TokenError): QuickBooksOnlineClientError {
  switch (error.kind) {
    case "config_error":
    case "auth_failed":
      return new QuickBooksOnlineClientError("auth_failed", "QBO_OAUTH_AUTH_FAILED", {
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
    case "rate_limited":
      return new QuickBooksOnlineClientError("rate_limited", "QBO_OAUTH_RATE_LIMITED", {
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    case "timeout":
      return new QuickBooksOnlineClientError("timeout", "QBO_OAUTH_TIMEOUT");
    case "provider_unavailable":
    case "malformed_response":
      return new QuickBooksOnlineClientError("provider_unavailable", "QBO_OAUTH_UNAVAILABLE", {
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
  }
}

function mapHardenedFetchError(error: HardenedFetchError): QuickBooksOnlineClientError {
  if (error.kind === "timeout") {
    return new QuickBooksOnlineClientError("timeout", "QBO_TIMEOUT");
  }
  if (error.kind === "network_error") {
    return new QuickBooksOnlineClientError("transport_error", "QBO_TRANSPORT_ERROR");
  }
  if (error.kind === "origin_rejected") {
    return new QuickBooksOnlineClientError("config_error", "QBO_ORIGIN_REJECTED");
  }
  if (error.kind === "malformed_json" || error.kind === "body_too_large") {
    return new QuickBooksOnlineClientError("provider_unavailable", "QBO_MALFORMED_RESPONSE", {
      ...(error.status !== undefined ? { status: error.status } : {}),
    });
  }
  const status = error.status;
  if (status === 401 || status === 403) {
    return new QuickBooksOnlineClientError("auth_failed", "QBO_AUTH_FAILED", { status });
  }
  if (status === 408 || status === 409) {
    return new QuickBooksOnlineClientError("ambiguous_conflict", "QBO_AMBIGUOUS_CONFLICT", { status });
  }
  if (status === 429) {
    return new QuickBooksOnlineClientError("rate_limited", "QBO_RATE_LIMITED", {
      status,
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    });
  }
  if (status !== undefined && status >= 500) {
    return new QuickBooksOnlineClientError("provider_unavailable", "QBO_PROVIDER_UNAVAILABLE", {
      status,
    });
  }
  return new QuickBooksOnlineClientError("provider_rejected", "QBO_PROVIDER_REJECTED", {
    ...(status !== undefined ? { status } : {}),
  });
}

function extractEntryId(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  return null;
}

function parseJournalEntryObject(
  raw: unknown,
  fallbackDocNumber: string,
): QuickBooksJournalEntryRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = extractEntryId(obj.Id);
  if (!id) return null;
  const docNumber =
    typeof obj.DocNumber === "string" && obj.DocNumber.trim().length > 0
      ? obj.DocNumber
      : fallbackDocNumber;
  return { id, docNumber };
}

function parseFaultIfPresent(data: unknown): QuickBooksOnlineClientError | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const root = data as Record<string, unknown>;
  const fault = root.Fault;
  if (!fault || typeof fault !== "object" || Array.isArray(fault)) return null;
  const faultObj = fault as Record<string, unknown>;
  const faultType = typeof faultObj.type === "string" ? faultObj.type : "";
  if (faultType === "AuthenticationFault") {
    return new QuickBooksOnlineClientError("auth_failed", "QBO_FAULT_AUTH_FAILED");
  }
  return new QuickBooksOnlineClientError("provider_rejected", "QBO_PROVIDER_FAULT");
}

/**
 * Zero-SDK QuickBooks Online Accounting v3 HTTP client built on `createHardenedFetch`
 * and `createOAuth2TokenManager` (`refresh_token` + Basic auth), pinning HTTPS origins,
 * validating `realmId` at construction time, and invalidating cached tokens on HTTP 401.
 */
export function createQuickBooksOnlineHttpClient(
  options: QuickBooksOnlineHttpClientOptions,
): QuickBooksOnlineClient {
  const origin = resolvePinnedQuickBooksOrigin(options.environment);
  const realmId = assertSafeQuickBooksRealmId(options.realmId);
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
      throw new QuickBooksOnlineClientError("config_error", "QBO_INVALID_OAUTH_CONFIG");
    }
    throw error;
  }

  const apiFetch = createHardenedFetch({
    allowedOrigins: [origin],
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
      throw new QuickBooksOnlineClientError("provider_unavailable", "QBO_OAUTH_UNAVAILABLE");
    }
  }

  async function requestApiJson(
    url: string,
    init: {
      readonly method: "GET" | "POST";
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
      throw new QuickBooksOnlineClientError("transport_error", "QBO_TRANSPORT_ERROR");
    }
  }

  return Object.freeze({
    async createJournalEntry(
      exportKey: string,
      payload: QuickBooksCreateJournalEntryPayload,
      signal?: AbortSignal,
    ): Promise<QuickBooksJournalEntryRef> {
      const safeKey = assertSafeQuickBooksExportKey(exportKey);
      const url = `${origin}/v3/company/${realmId}/journalentry?minorversion=${QBO_MINOR_VERSION}`;
      const data = await requestApiJson(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Request-Id": safeKey,
        },
        body: JSON.stringify(payload),
        ...(signal !== undefined ? { signal } : {}),
      });
      const faultErr = parseFaultIfPresent(data);
      if (faultErr) throw faultErr;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new QuickBooksOnlineClientError("provider_unavailable", "QBO_MALFORMED_RESPONSE");
      }
      const root = data as Record<string, unknown>;
      const entry = parseJournalEntryObject(root.JournalEntry, safeKey);
      if (!entry) {
        throw new QuickBooksOnlineClientError("provider_unavailable", "QBO_MALFORMED_RESPONSE");
      }
      return entry;
    },

    async findJournalEntryByDocNumber(
      exportKey: string,
      signal?: AbortSignal,
    ): Promise<QuickBooksJournalEntryRef | null> {
      const safeKey = assertSafeQuickBooksExportKey(exportKey);
      const escapedKey = escapeQuickBooksQueryLiteral(safeKey);
      const query = `SELECT Id, DocNumber FROM JournalEntry WHERE DocNumber = '${escapedKey}'`;
      const params = new URLSearchParams({
        query,
        minorversion: QBO_MINOR_VERSION,
      });
      const url = `${origin}/v3/company/${realmId}/query?${params.toString()}`;
      const data = await requestApiJson(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        ...(signal !== undefined ? { signal } : {}),
      });
      const faultErr = parseFaultIfPresent(data);
      if (faultErr) throw faultErr;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new QuickBooksOnlineClientError("provider_unavailable", "QBO_MALFORMED_RESPONSE");
      }
      const root = data as Record<string, unknown>;
      const qr = root.QueryResponse;
      if (!qr || typeof qr !== "object" || Array.isArray(qr)) {
        throw new QuickBooksOnlineClientError("provider_unavailable", "QBO_MALFORMED_RESPONSE");
      }
      const qrObj = qr as Record<string, unknown>;
      const entries = qrObj.JournalEntry;
      if (entries === undefined || entries === null) {
        return null;
      }
      if (!Array.isArray(entries)) {
        throw new QuickBooksOnlineClientError("provider_unavailable", "QBO_MALFORMED_RESPONSE");
      }
      for (const candidate of entries) {
        const parsed = parseJournalEntryObject(candidate, safeKey);
        if (parsed && parsed.docNumber === safeKey) {
          return parsed;
        }
      }
      return null;
    },
  });
}
