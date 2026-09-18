import {
  readFakturowniaActivationGate,
  readFakturowniaReadinessConfig,
} from "#accounting-provider-activation";

export interface FakturowniaClientConfig {
  baseUrl: string;
  apiToken: string;
}

export interface FakturowniaClient {
  createInvoice(payload: Record<string, unknown>): Promise<FakturowniaInvoiceResult>;
  findInvoiceByOid(oid: string): Promise<FakturowniaInvoiceResult | null>;
  createCorrection(payload: Record<string, unknown>): Promise<FakturowniaInvoiceResult>;
  sendInvoiceEmail(invoiceId: string): Promise<FakturowniaEmailResult>;
  downloadInvoicePdf(invoiceId: string): Promise<FakturowniaPdfResult>;
  downloadKsefAttachment(invoiceId: string, kind: "gov" | "gov_upo"): Promise<FakturowniaPdfResult>;
  getInvoiceKsefStatus(invoiceId: string): Promise<FakturowniaKsefStatusResult>;
}

export interface FakturowniaInvoiceResult {
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  raw: Record<string, unknown>;
}

export interface FakturowniaEmailResult {
  status: "sent";
}

export interface FakturowniaKsefStatusResult {
  ksefStatus: "pending" | "accepted" | "rejected" | "not_submitted";
  ksefNumber: string | null;
  raw: Record<string, unknown>;
}

export interface FakturowniaPdfResult {
  content: Buffer;
  contentType: string;
}

export function readFakturowniaClientConfig(env: Record<string, string | undefined>): FakturowniaClientConfig | null {
  const readiness = readFakturowniaReadinessConfig(env);
  if (!readiness.enabled) return null;
  return readFakturowniaBaseConfig(env);
}

export function readFakturowniaReadClientConfig(env: Record<string, string | undefined>): FakturowniaClientConfig | null {
  if (env.FAKTUROWNIA_PROVIDER_ENABLED !== "true") return null;
  if (!readFakturowniaActivationGate(env).allowed) return null;
  return readFakturowniaBaseConfig(env);
}

function readFakturowniaBaseConfig(env: Record<string, string | undefined>): FakturowniaClientConfig | null {
  const baseUrl = env.FAKTUROWNIA_BASE_URL?.replace(/\/+$/, "");
  const apiToken = env.FAKTUROWNIA_API_TOKEN;
  return baseUrl && apiToken ? { baseUrl, apiToken } : null;
}

export function createFakturowniaClient(
  config: FakturowniaClientConfig,
  fetchImpl: typeof fetch = fetch,
): FakturowniaClient {
  return {
    async createInvoice(payload) {
      const body = await requestJson(fetchImpl, config, "/invoices.json", {
        method: "POST",
        body: JSON.stringify(withApiToken(payload, config.apiToken)),
      });
      return mapInvoiceResult(body);
    },

    async findInvoiceByOid(oid) {
      const body = await requestJson(
        fetchImpl,
        config,
        `/invoices.json?oid=${encodeURIComponent(oid)}&period=all&per_page=2`,
        { method: "GET" },
      );
      if (!Array.isArray(body)) throw new Error("fakturownia_invoice_lookup_response_invalid");
      if (body.length === 0) return null;
      const matches = body.filter((entry) => (
        entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).oid === oid
      ));
      if (matches.length === 0) throw new Error("fakturownia_invoice_lookup_oid_mismatch");
      if (matches.length > 1) throw new Error("fakturownia_invoice_lookup_ambiguous");
      return mapInvoiceResult(matches[0]);
    },

    async createCorrection(payload) {
      const body = await requestJson(fetchImpl, config, "/invoices.json", {
        method: "POST",
        body: JSON.stringify(withApiToken(payload, config.apiToken)),
      });
      return mapInvoiceResult(body);
    },

    // Delivers to the document's own buyer_email; a 2xx does not prove the
    // provider dispatched anything (observed for kind=correction documents —
    // see server/domains/accounting/README.md). The documented `email_to`
    // parameter can override the recipient if that ever needs to change.
    async sendInvoiceEmail(invoiceId) {
      await requestJson(fetchImpl, config, `/invoices/${encodeURIComponent(invoiceId)}/send_by_email.json`, {
        method: "POST",
        body: JSON.stringify({ email_pdf: true }),
      }, { apiTokenInQuery: true });
      return { status: "sent" };
    },

    async downloadInvoicePdf(invoiceId) {
      return requestPdf(fetchImpl, config, `/invoices/${encodeURIComponent(invoiceId)}.pdf`);
    },

    async downloadKsefAttachment(invoiceId, kind) {
      return requestBinary(fetchImpl, config, `/invoices/${encodeURIComponent(invoiceId)}/attachment`, {
        accept: kind === "gov" ? "application/xml,text/xml,*/*" : "application/xml,text/xml,application/pdf,*/*",
        query: { kind },
        fallbackContentType: kind === "gov" ? "application/xml" : "application/octet-stream",
      });
    },

    async getInvoiceKsefStatus(invoiceId) {
      const body = await requestJson(fetchImpl, config, `/invoices/${encodeURIComponent(invoiceId)}.json`, {
        method: "GET",
      });
      const invoice = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return {
        ksefStatus: mapKsefStatus(invoice.gov_status),
        ksefNumber: typeof invoice.gov_id === "string" ? invoice.gov_id : null,
        raw: sanitizeProviderResponse(invoice),
      };
    },
  };
}

async function requestPdf(
  fetchImpl: typeof fetch,
  config: FakturowniaClientConfig,
  path: string,
): Promise<FakturowniaPdfResult> {
  return requestBinary(fetchImpl, config, path, {
    accept: "application/pdf",
    fallbackContentType: "application/pdf",
  });
}

async function requestBinary(
  fetchImpl: typeof fetch,
  config: FakturowniaClientConfig,
  path: string,
  options: {
    accept: string;
    fallbackContentType: string;
    query?: Record<string, string>;
  },
): Promise<FakturowniaPdfResult> {
  const url = new URL(path, config.baseUrl);
  url.searchParams.set("api_token", config.apiToken);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: options.accept },
  });
  if (!response.ok) throw new Error(`fakturownia_binary_request_failed:${response.status}`);
  return {
    content: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? options.fallbackContentType,
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  config: FakturowniaClientConfig,
  path: string,
  init: RequestInit,
  options: { apiTokenInQuery?: boolean } = {},
): Promise<unknown> {
  const url = new URL(path, config.baseUrl);
  if ((init.method ?? "GET").toUpperCase() === "GET" || options.apiTokenInQuery) {
    url.searchParams.set("api_token", config.apiToken);
  }
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`fakturownia_request_failed:${response.status}:${sanitizeProviderErrorText(text)}`);
  }
  return text ? JSON.parse(text) : {};
}

function withApiToken(payload: Record<string, unknown>, apiToken: string): Record<string, unknown> {
  return { ...payload, api_token: apiToken };
}

function mapKsefStatus(value: unknown): FakturowniaKsefStatusResult["ksefStatus"] {
  const status = String(value ?? "").toLowerCase();
  if (["accepted", "accepted_by_ksef", "sent", "ok", "demo_ok"].includes(status)) return "accepted";
  if (["rejected", "error", "failed", "send_error", "server_error", "demo_send_error", "demo_server_error"].includes(status)) {
    return "rejected";
  }
  if (["pending", "processing", "sending", "demo_processing"].includes(status)) return "pending";
  return "not_submitted";
}

function mapInvoiceResult(body: unknown): FakturowniaInvoiceResult {
  const invoice = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const id = String(invoice.id ?? "");
  if (!id) throw new Error("fakturownia_invoice_response_invalid");
  return {
    providerInvoiceId: id,
    providerInvoiceNumber: typeof invoice.number === "string" ? invoice.number : null,
    raw: sanitizeProviderResponse(invoice),
  };
}

function sanitizeProviderResponse(input: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    "api_token",
    "token",
    "buyer_email",
    "buyer_name",
    "buyer_tax_no",
    "buyer_first_name",
    "buyer_last_name",
    "buyer_street",
    "buyer_post_code",
    "buyer_city",
  ]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !blocked.has(key)));
}

function sanitizeProviderErrorText(value: string): string {
  return value
    .replace(/api_token=[^"&\s]+/gi, "api_token=[redacted]")
    .replace(/"api_token"\s*:\s*"[^"]+"/gi, "\"api_token\":\"[redacted]\"")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}
