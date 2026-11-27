import {
  mapOmnipackFulfilmentRequestsResponse,
  mapOmnipackFulfilmentsResponse,
  mapOmnipackOrderCreatedResponse,
  mapOmnipackProductCreatedResponse,
  mapOmnipackStockMovementsResponse,
  mapOmnipackStockResponse,
  sanitizeOmnipackPayload,
  type OmnipackFulfilmentEvidence,
  type OmnipackFulfilmentRequestEvidence,
  type OmnipackOrderCreatedEvidence,
  type OmnipackProductCreatedEvidence,
  type OmnipackStockEvidence,
  type OmnipackStockMovementEvidence,
} from "./mappers.js";
import {
  mapOmnipackProductPackCreatedResponse,
  mapOmnipackProductResponse,
  type OmnipackProductEvidence,
  type OmnipackProductPackCreatedEvidence,
} from "./productSyncMappers.js";
import { mayPostHaveSucceeded, OmnipackProviderError } from "./providerError.js";

export {
  OmnipackProviderError,
  sanitizeOmnipackProviderError,
  type SanitizedOmnipackProviderError,
} from "./providerError.js";

const PRODUCT_PACKS_SEGMENT = "packs";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const BASE_RETRY_BACKOFF_MS = 25;
const MAX_RETRY_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10_000;

export interface OmnipackClientConfig {
  baseUrl: string;
  credentials: () => { username: string; password: string } | Promise<{ username: string; password: string }>;
  timeoutMs: number;
  safeReadRetries: number;
  productPath: string;
}

export interface OmnipackFulfilmentsPageMetadata {
  number: number;
  size: number;
  totalPages: number;
  totalElements: number;
  hasNext: boolean;
}

export interface OmnipackClient {
  createOrder(body: string): Promise<OmnipackOrderCreatedEvidence>;
  // Product sync. createProduct/createProductPack are POST, so
  // requestJson does NOT retry them (mutations must not be silently re-sent). getProduct is a
  // GET (retried) reading the SKU's packs[] — one SKU ↔ many EANs.
  createProduct(payload: Record<string, unknown>, sku: string): Promise<OmnipackProductCreatedEvidence>;
  getProduct(sku: string): Promise<OmnipackProductEvidence>;
  createProductPack(sku: string, payload: Record<string, unknown>, ean: string): Promise<OmnipackProductPackCreatedEvidence>;
  getStock(options?: { refuseRedirectRetry: boolean }): Promise<OmnipackStockEvidence[]>;
  getStockMovements(params?: OmnipackQueryParams): Promise<OmnipackStockMovementEvidence[]>;
  getFulfilmentsPage(params?: OmnipackQueryParams): Promise<{
    rows: OmnipackFulfilmentEvidence[];
    complete: boolean;
    page: OmnipackFulfilmentsPageMetadata | null;
  }>;
  getFulfilments(params?: OmnipackQueryParams): Promise<OmnipackFulfilmentEvidence[]>;
  getFulfilmentRequests(params?: OmnipackQueryParams): Promise<OmnipackFulfilmentRequestEvidence[]>;
}

export interface OmnipackQueryParams {
  startLocalDate?: string;
  endLocalDate?: string;
  page?: number;
  size?: number;
}

export function createOmnipackClient(
  config: OmnipackClientConfig,
  fetchImpl: typeof fetch,
): OmnipackClient {
  return {
    async createOrder(body) {
      return mapOmnipackOrderCreatedResponse(await requestJson(fetchImpl, config, "createOrder", "/orders", {
        method: "POST",
        body,
      }));
    },

    async createProduct(payload, sku) {
      const body = await requestJson(fetchImpl, config, "createProduct", config.productPath, post(payload));
      return mapOmnipackProductCreatedResponse(body, sku);
    },

    async getProduct(sku) {
      const path = productResourcePath(config.productPath, sku);
      return mapOmnipackProductResponse(await requestJson(fetchImpl, config, "getProduct", path, { method: "GET" }), sku);
    },

    async createProductPack(sku, payload, ean) {
      const path = `${productResourcePath(config.productPath, sku)}/${PRODUCT_PACKS_SEGMENT}`;
      const body = await requestJson(fetchImpl, config, "createProductPack", path, post(payload));
      return mapOmnipackProductPackCreatedResponse(body, sku, ean);
    },

    async getStock(options) {
      return mapOmnipackStockResponse(await requestJson(fetchImpl, config, "getStock", "/stock", { method: "GET" }, options?.refuseRedirectRetry));
    },

    async getStockMovements(params) {
      return mapOmnipackStockMovementsResponse(await requestJson(
        fetchImpl,
        config,
        "getStockMovements",
        withQuery("/stock-movements", params),
        { method: "GET" },
        true,
      ));
    },

    async getFulfilmentsPage(params) {
      const body = await requestJson(fetchImpl, config, "getFulfilments", withQuery("/fulfilments", params), { method: "GET" });
      const rows = mapOmnipackFulfilmentsResponse(body);
      const record = body as { page?: { number?: unknown; size?: unknown; totalPages?: unknown; totalElements?: unknown }; _links?: { next?: unknown }; incomplete?: unknown; partial?: unknown } | null;
      const rawPage = record?.page;
      const hasNext = Boolean(record?._links?.next);
      const validPage = !record?.incomplete && !record?.partial
        && typeof rawPage?.number === "number" && Number.isSafeInteger(rawPage.number) && rawPage.number >= 0
        && typeof rawPage?.size === "number" && Number.isSafeInteger(rawPage.size) && rawPage.size > 0 && rawPage.size >= rows.length
        && typeof rawPage?.totalPages === "number" && Number.isSafeInteger(rawPage.totalPages) && rawPage.totalPages >= 1 && rawPage.number < rawPage.totalPages
        && typeof rawPage?.totalElements === "number" && Number.isSafeInteger(rawPage.totalElements) && rawPage.totalElements >= rows.length;
      const page: OmnipackFulfilmentsPageMetadata | null = validPage
        ? {
          number: rawPage.number as number,
          size: rawPage.size as number,
          totalPages: rawPage.totalPages as number,
          totalElements: rawPage.totalElements as number,
          hasNext,
        }
        : null;
      const complete = page !== null && page.number === 0 && page.totalPages === 1
        && page.totalElements === rows.length && !page.hasNext;
      return { rows, complete, page };
    },

    async getFulfilments(params) {
      return mapOmnipackFulfilmentsResponse(await requestJson(
        fetchImpl,
        config,
        "getFulfilments",
        withQuery("/fulfilments", params),
        { method: "GET" },
      ));
    },

    async getFulfilmentRequests(params) {
      return mapOmnipackFulfilmentRequestsResponse(await requestJson(
        fetchImpl,
        config,
        "getFulfilmentRequests",
        withQuery("/fulfilment-requests", params),
        { method: "GET" },
      ));
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  config: OmnipackClientConfig,
  operation: string,
  path: string,
  init: RequestInit,
  refuseRedirectRetry = false,
): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  const attempts = method === "GET" ? config.safeReadRetries + 1 : 1;
  // Dispatch/readback diagnostics must not change product-sync or stock retry policy.
  const diagnoseRedirectFailure = refuseRedirectRetry || operation === "createOrder"
    || operation === "getFulfilments" || operation === "getFulfilmentRequests";
  let lastError: OmnipackProviderError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let submitted = false;
    let responseBodyRead: boolean | undefined;
    const dispatchFacts = () => operation === "createOrder" ? { submissionAttempted: submitted,
      ...(responseBodyRead !== undefined ? { responseBodyRead } : {}) } : {};
    let retryDelayMs: number | null = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const base = new URL(config.baseUrl);
      const url = new URL(path, base);
      if (url.origin !== base.origin || url.username || url.password || url.protocol !== "https:") throw new Error("Invalid fulfillment path");
      const response = await fetchWithSignal(fetchImpl, url, config, init, controller.signal, () => { submitted = true; });
      responseBodyRead = false;
      const body = await readJsonBody(response, controller.signal, MAX_RESPONSE_BYTES).then(value => { responseBodyRead = true; return value; }).catch(error => {
        if (response.ok) throw error;
        return null;
      });
      if (response.ok) return body;

      const retryable = method === "GET" && isRetryableStatus(response.status);
      // A failed body read cannot erase the rejection status already received.
      lastError = Object.assign(new OmnipackProviderError({
        operation,
        status: response.status,
        code: refuseRedirectRetry && response.status >= 300 && response.status < 400 ? "redirect_refused" : readProviderErrorCode(body) ?? `http_${response.status}`,
        retryable,
        mayHaveSucceeded: mayPostHaveSucceeded(method, response.status),
      }), dispatchFacts());
      if (!retryable || attempt === attempts) throw lastError;
      retryDelayMs = computeRetryDelayMs(response.headers?.get("retry-after") ?? null, attempt, config.timeoutMs);
    } catch (error) {
      const retryable = method === "GET" && attempt < attempts;
      lastError = submitted && error instanceof OmnipackProviderError
        ? error
        : Object.assign(new OmnipackProviderError({
          operation,
          status: null,
          code: diagnoseRedirectFailure && isRedirectRefusal(error) ? "redirect_refused" : "network_error",
          retryable,
          mayHaveSucceeded: submitted && mayPostHaveSucceeded(method, null),
        }), dispatchFacts());
      if (!retryable || (refuseRedirectRetry && lastError.code === "redirect_refused")) throw lastError;
      retryDelayMs = computeRetryDelayMs(null, attempt, config.timeoutMs);
    } finally {
      clearTimeout(timeout);
    }
    if (retryDelayMs !== null && retryDelayMs > 0) {
      await waitMs(retryDelayMs);
    }
  }

  throw lastError;
}

async function fetchWithSignal(
  fetchImpl: typeof fetch,
  url: URL,
  config: OmnipackClientConfig,
  init: RequestInit,
  signal: AbortSignal,
  onSubmit: () => void,
): Promise<Response> {
  const credentials = await config.credentials();
  const requestInit: RequestInit = {
    ...init,
    signal,
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
      ...(init.headers ?? {}),
    },
  };
  new Request(url, requestInit); // Validate construction before crossing the submission boundary.
  signal.throwIfAborted();
  onSubmit();
  return await fetchImpl(url, requestInit);
}

async function readJsonBody(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  signal.throwIfAborted();
  const contentLength = response.headers?.get("content-length") ?? null;
  if (contentLength !== null && /^\d+$/u.test(contentLength.trim()) && Number(contentLength.trim()) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Response body exceeded byte limit");
  }
  const body = response.body;
  if (body == null) {
    if (typeof response.text !== "function") return {};
    const text = await raceAbort(response.text(), signal);
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Response body exceeded byte limit");
    return parseJsonText(text);
  }
  const reader = body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => {
      reject(signal.reason ?? new Error("Response body aborted"));
      void reader.cancel().catch(() => {});
    };
    if (signal.aborted) {
      fail();
      return;
    }
    onAbort = fail;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Response body exceeded byte limit");
      }
      chunks.push(chunk.value);
    }
    return parseJsonText(Buffer.concat(chunks, totalBytes).toString("utf8"));
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* stream already cancelled or locked */ }
  }
}

function parseJsonText(text: string): unknown {
  if (!text) return {};
  try {
    return sanitizeOmnipackPayload(JSON.parse(text) as Record<string, unknown>);
  } catch {
    return {};
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Response body aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    const value = await Promise.race([promise, aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  }
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function computeRetryDelayMs(retryAfterHeader: string | null, attempt: number, timeoutMs: number): number {
  const cap = Math.min(MAX_RETRY_AFTER_MS, timeoutMs);
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) return Math.min(cap, retryAfterMs);
  const backoff = BASE_RETRY_BACKOFF_MS * (2 ** Math.min(attempt - 1, 10));
  return Math.min(MAX_RETRY_BACKOFF_MS, cap, backoff);
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// A non-retried JSON POST init (mutations must not be silently re-sent — requestJson keys retry
// off the GET method).
function post(payload: Record<string, unknown>): RequestInit {
  return { method: "POST", body: JSON.stringify(payload) };
}

// Per-product resource path (GET /products/{sku}, base for /packs). sku is percent-encoded; the
// product path is right-trimmed so a trailing-slash path override does not double the slash.
function productResourcePath(productPath: string, sku: string): string {
  return `${productPath.replace(/\/+$/, "")}/${encodeURIComponent(sku)}`;
}

function withQuery(path: string, params: OmnipackQueryParams | undefined): string {
  const url = new URL(path, "https://example.test");
  if (params?.startLocalDate) url.searchParams.set("startLocalDate", params.startLocalDate);
  if (params?.endLocalDate) url.searchParams.set("endLocalDate", params.endLocalDate);
  if (typeof params?.page === "number") url.searchParams.set("page", String(params.page));
  if (typeof params?.size === "number") url.searchParams.set("size", String(params.size));
  return `${url.pathname}${url.search}`;
}

function readProviderErrorCode(body: unknown): string | null {
  return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
    ? body.code
    : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// Fetch implementations expose redirect refusal as an exception, sometimes through cause.
// Inspect it only to select a closed diagnostic; no exception text leaves this adapter.
function isRedirectRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /redirect/i.test(error.message) || (error.cause instanceof Error && /redirect/i.test(error.cause.message));
}
