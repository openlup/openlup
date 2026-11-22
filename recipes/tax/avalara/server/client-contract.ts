export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AvalaraEnvironment = "sandbox" | "production";

export const AVALARA_ORIGINS: Readonly<Record<AvalaraEnvironment, string>> = Object.freeze({
  sandbox: "https://sandbox-rest.avatax.com",
  production: "https://rest.avatax.com",
});

export interface AvalaraCredentials {
  readonly accountId: string;
  readonly licenseKey: string;
}

export interface AvalaraAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region?: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface AvalaraTransactionLineInput {
  readonly number: string;
  readonly quantity: number;
  readonly amount: number;
  readonly taxCode?: string;
  readonly itemCode?: string;
  readonly taxIncluded: false;
}

export interface AvalaraCreateTransactionPayload {
  readonly companyCode: string;
  readonly type: "SalesOrder" | "SalesInvoice" | "ReturnInvoice";
  readonly code?: string;
  readonly commit: boolean;
  readonly date: string;
  readonly customerCode: string;
  readonly currencyCode: string;
  readonly referenceCode?: string;
  readonly taxOverride?: {
    readonly type: "TaxDate" | "TaxAmount";
    readonly taxDate?: string;
    readonly taxAmount?: number;
    readonly reason: string;
  };
  readonly addresses: {
    readonly shipFrom: AvalaraAddress;
    readonly shipTo: AvalaraAddress;
  };
  readonly lines: readonly AvalaraTransactionLineInput[];
}

export interface AvalaraTaxDetail {
  readonly id?: number;
  readonly jurisType: string;
  readonly jurisCode: string;
  readonly jurisName?: string;
  readonly country: string;
  readonly region?: string;
  readonly taxType: string;
  readonly taxSubTypeId?: string;
  readonly rateType?: string;
  readonly rate: number;
  readonly taxableAmount: number;
  readonly tax: number;
  readonly exemptAmount?: number;
  readonly nonTaxableAmount?: number;
  readonly nonTaxableRuleId?: number;
  readonly sourcing?: string;
  readonly rateRuleId?: number;
}

export interface AvalaraTransactionLineResponse {
  readonly id?: number;
  readonly lineNumber: string;
  readonly lineAmount: number;
  readonly taxableAmount: number;
  readonly tax: number;
  readonly taxCode?: string;
  readonly taxIncluded?: boolean;
  readonly details: readonly AvalaraTaxDetail[];
}

export interface AvalaraTransactionResponse {
  readonly id?: number;
  readonly code: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly totalAmount: number;
  readonly totalTax: number;
  readonly totalTaxable?: number;
  readonly lines: readonly AvalaraTransactionLineResponse[];
}

export interface AvalaraVoidTransactionPayload {
  readonly code: "DocVoided";
}

export interface AvalaraClient {
  createTransaction(payload: AvalaraCreateTransactionPayload): Promise<AvalaraTransactionResponse>;
  voidTransaction(
    companyCode: string,
    transactionCode: string,
    payload: AvalaraVoidTransactionPayload,
  ): Promise<{ readonly code: string; readonly status: string }>;
}

export interface AvalaraHttpClientOptions {
  readonly environment: AvalaraEnvironment;
  readonly fetchImpl: FetchLike;
  readonly credentials: () => Promise<AvalaraCredentials> | AvalaraCredentials;
  /** Safe ASCII X-Avalara-Client identifier (e.g. "MyStore; 1.0; OpenLup; 1.3.0; prod"). */
  readonly clientHeader?: string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export class AvalaraTransportError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly effect: "none" | "unknown";

  constructor(params: {
    readonly code: string;
    readonly status: number | null;
    readonly retryable: boolean;
    readonly effect: "none" | "unknown";
  }) {
    super(params.code);
    this.name = "AvalaraTransportError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    this.effect = params.effect;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_CLIENT_HEADER = "OpenLupRecipe; 1.0; OpenLup; 1.3.0; runtime";
const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/u;
const SAFE_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/u;
const SAFE_HEADER_REGEX = /^[\x20-\x7E]{1,200}$/u;

export function resolvePinnedAvalaraOrigin(environment: AvalaraEnvironment): string {
  const origin = AVALARA_ORIGINS[environment];
  if (!origin) {
    throw new AvalaraTransportError({
      code: "avalara_unsupported_environment",
      status: null,
      retryable: false,
      effect: "none",
    });
  }
  return origin;
}

export function assertSafeAvalaraPathSegment(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new AvalaraTransportError({
      code: `avalara_invalid_${label}`,
      status: null,
      retryable: false,
      effect: "none",
    });
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    !SAFE_SEGMENT_REGEX.test(trimmed)
  ) {
    throw new AvalaraTransportError({
      code: `avalara_invalid_${label}`,
      status: null,
      retryable: false,
      effect: "none",
    });
  }
  return trimmed;
}

function assertPinnedHttpsUrl(url: URL, expectedOrigin: string): void {
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    Boolean(url.username) ||
    Boolean(url.password)
  ) {
    throw new AvalaraTransportError({
      code: "avalara_origin_mismatch",
      status: null,
      retryable: false,
      effect: "none",
    });
  }
}

function sanitizeErrorCode(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return cleaned && SAFE_CODE_REGEX.test(cleaned) ? cleaned : fallback;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  effectOnError: "none" | "unknown",
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancel failure.
      }
      throw new AvalaraTransportError({
        code: "avalara_response_too_large",
        status: response.status,
        retryable: false,
        effect: effectOnError,
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
            throw new AvalaraTransportError({
              code: "avalara_response_too_large",
              status: response.status,
              retryable: false,
              effect: effectOnError,
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
    throw new AvalaraTransportError({
      code: "avalara_response_too_large",
      status: response.status,
      retryable: false,
      effect: effectOnError,
    });
  }
  return text;
}

function extractAvalaraErrorCode(bodyText: string, status: number): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    if (typeof code === "string" && code.trim()) {
      return sanitizeErrorCode(`avalara_${code}`, `avalara_http_${status}`);
    }
  } catch {
    // Non-JSON error body; fall back to HTTP status code.
  }
  return `avalara_http_${status}`;
}

function normalizeTransactionResponse(raw: unknown): AvalaraTransactionResponse {
  if (!raw || typeof raw !== "object") {
    throw new AvalaraTransportError({
      code: "avalara_invalid_response",
      status: 200,
      retryable: false,
      effect: "unknown",
    });
  }
  const root = raw as Record<string, unknown>;
  const code = typeof root["code"] === "string" ? root["code"].trim() : "";
  const status = typeof root["status"] === "string" ? root["status"].trim() : "";
  const currencyCode = typeof root["currencyCode"] === "string" ? root["currencyCode"].trim() : "";
  const totalAmount = typeof root["totalAmount"] === "number" ? root["totalAmount"] : Number.NaN;
  const totalTax = typeof root["totalTax"] === "number" ? root["totalTax"] : Number.NaN;
  if (!code || !status || !currencyCode || !Number.isFinite(totalAmount) || !Number.isFinite(totalTax)) {
    throw new AvalaraTransportError({
      code: "avalara_invalid_response",
      status: 200,
      retryable: false,
      effect: "unknown",
    });
  }

  const rawLines = Array.isArray(root["lines"]) ? root["lines"] : [];
  const lines: AvalaraTransactionLineResponse[] = rawLines
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((line) => {
      const rawDetails = Array.isArray(line["details"]) ? line["details"] : [];
      const details: AvalaraTaxDetail[] = rawDetails
        .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
        .map((d) => ({
          id: typeof d["id"] === "number" ? d["id"] : undefined,
          jurisType: typeof d["jurisType"] === "string" ? d["jurisType"] : "",
          jurisCode: typeof d["jurisCode"] === "string" ? d["jurisCode"] : "",
          jurisName: typeof d["jurisName"] === "string" ? d["jurisName"] : undefined,
          country: typeof d["country"] === "string" ? d["country"] : "",
          region: typeof d["region"] === "string" ? d["region"] : undefined,
          taxType: typeof d["taxType"] === "string" ? d["taxType"] : "",
          taxSubTypeId: typeof d["taxSubTypeId"] === "string" ? d["taxSubTypeId"] : undefined,
          rateType: typeof d["rateType"] === "string" ? d["rateType"] : undefined,
          rate: typeof d["rate"] === "number" ? d["rate"] : 0,
          taxableAmount: typeof d["taxableAmount"] === "number" ? d["taxableAmount"] : 0,
          tax: typeof d["tax"] === "number" ? d["tax"] : 0,
          exemptAmount: typeof d["exemptAmount"] === "number" ? d["exemptAmount"] : undefined,
          nonTaxableAmount: typeof d["nonTaxableAmount"] === "number" ? d["nonTaxableAmount"] : undefined,
          nonTaxableRuleId: typeof d["nonTaxableRuleId"] === "number" ? d["nonTaxableRuleId"] : undefined,
          sourcing: typeof d["sourcing"] === "string" ? d["sourcing"] : undefined,
          rateRuleId: typeof d["rateRuleId"] === "number" ? d["rateRuleId"] : undefined,
        }));
      return {
        id: typeof line["id"] === "number" ? line["id"] : undefined,
        lineNumber: typeof line["lineNumber"] === "string" ? line["lineNumber"] : "",
        lineAmount: typeof line["lineAmount"] === "number" ? line["lineAmount"] : Number.NaN,
        taxableAmount: typeof line["taxableAmount"] === "number" ? line["taxableAmount"] : Number.NaN,
        tax: typeof line["tax"] === "number" ? line["tax"] : Number.NaN,
        taxCode: typeof line["taxCode"] === "string" ? line["taxCode"] : undefined,
        taxIncluded: typeof line["taxIncluded"] === "boolean" ? line["taxIncluded"] : undefined,
        details,
      };
    });

  return {
    id: typeof root["id"] === "number" ? root["id"] : undefined,
    code,
    status,
    currencyCode,
    totalAmount,
    totalTax,
    totalTaxable: typeof root["totalTaxable"] === "number" ? root["totalTaxable"] : undefined,
    lines,
  };
}

/**
 * Zero-SDK Avalara AvaTax REST v2 HTTP client using Basic Auth over pinned HTTPS origins.
 * Enforces `redirect: "error"`, incremental streaming byte caps, active timeout through body read,
 * non-2xx body cancellation, and zero PII/credential leakage in errors.
 */
export function createAvalaraHttpClient(options: AvalaraHttpClientOptions): AvalaraClient {
  const origin = resolvePinnedAvalaraOrigin(options.environment);
  const timeoutMs =
    options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxBodyBytes =
    options.maxBodyBytes && Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;
  const clientHeader = (options.clientHeader ?? DEFAULT_CLIENT_HEADER).trim();
  if (!SAFE_HEADER_REGEX.test(clientHeader)) {
    throw new AvalaraTransportError({
      code: "avalara_invalid_client_header",
      status: null,
      retryable: false,
      effect: "none",
    });
  }

  async function postJson(params: {
    readonly path: string;
    readonly body: unknown;
    readonly mutating: boolean;
  }): Promise<unknown> {
    let creds: AvalaraCredentials;
    try {
      creds = await options.credentials();
    } catch {
      throw new AvalaraTransportError({
        code: "avalara_credentials_unavailable",
        status: null,
        retryable: true,
        effect: "none",
      });
    }

    const accountId = creds.accountId.trim();
    const licenseKey = creds.licenseKey.trim();
    if (!accountId || !licenseKey) {
      throw new AvalaraTransportError({
        code: "avalara_credentials_missing",
        status: null,
        retryable: false,
        effect: "none",
      });
    }

    const url = new URL(params.path, origin);
    assertPinnedHttpsUrl(url, origin);

    const authToken = Buffer.from(`${accountId}:${licenseKey}`, "utf8").toString("base64");
    const bodyText = JSON.stringify(params.body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(url.href, {
        method: "POST",
        headers: {
          authorization: `Basic ${authToken}`,
          "x-avalara-client": clientHeader,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: bodyText,
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          await response.body?.cancel().catch(() => undefined);
          throw new AvalaraTransportError({
            code: `avalara_http_${status}`,
            status,
            retryable: false,
            effect: "none",
          });
        }
        if (status === 429 || status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          throw new AvalaraTransportError({
            code: `avalara_http_${status}`,
            status,
            retryable: true,
            effect: params.mutating ? "unknown" : "none",
          });
        }
        // Bounded 32 KiB read on 4xx strictly for machine error.code (discard PII-bearing message/details).
        let errBody = "";
        try {
          errBody = await readBoundedText(response, 32 * 1024, "none");
        } catch {
          await response.body?.cancel().catch(() => undefined);
        }
        throw new AvalaraTransportError({
          code: extractAvalaraErrorCode(errBody, status),
          status,
          retryable: false,
          effect: "none",
        });
      }

      const rawText = await readBoundedText(response, maxBodyBytes, params.mutating ? "unknown" : "none");
      try {
        return JSON.parse(rawText);
      } catch {
        throw new AvalaraTransportError({
          code: "avalara_invalid_json",
          status: response.status,
          retryable: params.mutating,
          effect: params.mutating ? "unknown" : "none",
        });
      }
    } catch (error) {
      if (error instanceof AvalaraTransportError) {
        throw error;
      }
      const aborted = controller.signal.aborted;
      throw new AvalaraTransportError({
        code: aborted ? "avalara_timeout" : "avalara_transport_error",
        status: null,
        retryable: true,
        effect: params.mutating ? "unknown" : "none",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createTransaction(payload: AvalaraCreateTransactionPayload): Promise<AvalaraTransactionResponse> {
      assertSafeAvalaraPathSegment(payload.companyCode, "company_code");
      const raw = await postJson({
        path: "/api/v2/transactions/create",
        body: payload,
        mutating: payload.commit === true || payload.type !== "SalesOrder",
      });
      return normalizeTransactionResponse(raw);
    },

    async voidTransaction(
      companyCode: string,
      transactionCode: string,
      payload: AvalaraVoidTransactionPayload,
    ): Promise<{ readonly code: string; readonly status: string }> {
      const safeCompany = assertSafeAvalaraPathSegment(companyCode, "company_code");
      const safeCode = assertSafeAvalaraPathSegment(transactionCode, "transaction_code");
      const path = `/api/v2/transactions/${encodeURIComponent(safeCompany)}/${encodeURIComponent(safeCode)}/void`;
      const verified = new URL(path, origin);
      const expectedPath = `/api/v2/transactions/${safeCompany}/${safeCode}/void`;
      if (verified.pathname !== expectedPath) {
        throw new AvalaraTransportError({
          code: "avalara_invalid_transaction_path",
          status: null,
          retryable: false,
          effect: "none",
        });
      }
      const raw = await postJson({
        path,
        body: payload,
        mutating: true,
      });
      if (!raw || typeof raw !== "object") {
        throw new AvalaraTransportError({
          code: "avalara_invalid_void_response",
          status: 200,
          retryable: false,
          effect: "unknown",
        });
      }
      const record = raw as Record<string, unknown>;
      const code = typeof record["code"] === "string" ? record["code"].trim() : "";
      const status = typeof record["status"] === "string" ? record["status"].trim() : "";
      if (!code || !status) {
        throw new AvalaraTransportError({
          code: "avalara_invalid_void_response",
          status: 200,
          retryable: false,
          effect: "unknown",
        });
      }
      return { code, status };
    },
  };
}
