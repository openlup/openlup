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

export interface OmnipackClientConfig {
  baseUrl: string;
  credentials: () => { username: string; password: string } | Promise<{ username: string; password: string }>;
  timeoutMs: number;
  safeReadRetries: number;
  productPath: string;
}

export interface OmnipackClient {
  createOrder(body: string): Promise<OmnipackOrderCreatedEvidence>;
  // Product sync. createProduct/createProductPack are POST, so
  // requestJson does NOT retry them (mutations must not be silently re-sent). getProduct is a
  // GET (retried) reading the SKU's packs[] — one SKU ↔ many EANs.
  createProduct(payload: Record<string, unknown>, sku: string): Promise<OmnipackProductCreatedEvidence>;
  getProduct(sku: string): Promise<OmnipackProductEvidence>;
  createProductPack(sku: string, payload: Record<string, unknown>, ean: string): Promise<OmnipackProductPackCreatedEvidence>;
  getStock(): Promise<OmnipackStockEvidence[]>;
  getStockMovements(params?: OmnipackQueryParams): Promise<OmnipackStockMovementEvidence[]>;
  getFulfilmentsPage(params?: OmnipackQueryParams): Promise<{ rows: OmnipackFulfilmentEvidence[]; complete: boolean }>;
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

    async getStock() {
      return mapOmnipackStockResponse(await requestJson(fetchImpl, config, "getStock", "/stock", { method: "GET" }));
    },

    async getStockMovements(params) {
      return mapOmnipackStockMovementsResponse(await requestJson(
        fetchImpl,
        config,
        "getStockMovements",
        withQuery("/stock-movements", params),
        { method: "GET" },
      ));
    },

    async getFulfilmentsPage(params) {
      const body = await requestJson(fetchImpl, config, "getFulfilments", withQuery("/fulfilments", params), { method: "GET" });
      const rows = mapOmnipackFulfilmentsResponse(body);
      // Only explicit single-page totals establish whole-collection uniqueness.
      const record = body as { page?: { number?: unknown; size?: unknown; totalPages?: unknown; totalElements?: unknown }; _links?: { next?: unknown }; incomplete?: unknown; partial?: unknown } | null;
      const page = record?.page;
      const complete = page?.number === 0 && page.totalPages === 1 && page.totalElements === rows.length
        && typeof page.size === "number" && Number.isSafeInteger(page.size) && page.size >= rows.length && page.size > 0
        && !record?._links?.next && !record?.incomplete && !record?.partial;
      return { rows, complete };
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
): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  const attempts = method === "GET" ? config.safeReadRetries + 1 : 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let submitted = false;
    try {
      const base = new URL(config.baseUrl);
      const url = new URL(path, base);
      if (url.origin !== base.origin || url.username || url.password || url.protocol !== "https:") throw new Error("Invalid fulfillment path");
      const response = await fetchWithTimeout(fetchImpl, url, config, init, () => { submitted = true; });
      if (response.ok) return await readJsonBody(response);

      const retryable = method === "GET" && isRetryableStatus(response.status);
      // A failed body read cannot erase the rejection status already received.
      const body = await readJsonBody(response).catch(() => null);
      lastError = new OmnipackProviderError({
        operation,
        status: response.status,
        code: readProviderErrorCode(body) ?? `http_${response.status}`,
        retryable,
        mayHaveSucceeded: mayPostHaveSucceeded(method, response.status),
      });
      if (!retryable || attempt === attempts) throw lastError;
    } catch (error) {
      const retryable = method === "GET" && attempt < attempts;
      lastError = submitted && error instanceof OmnipackProviderError
        ? error
        : new OmnipackProviderError({
          operation,
          status: null,
          code: "network_error",
          retryable,
          mayHaveSucceeded: submitted && mayPostHaveSucceeded(method, null),
        });
      if (!retryable) throw lastError;
    }
  }

  throw lastError;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  config: OmnipackClientConfig,
  init: RequestInit,
  onSubmit: () => void,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const credentials = await config.credentials();
    const requestInit: RequestInit = {
      ...init,
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        ...(init.headers ?? {}),
      },
    };
    new Request(url, requestInit); // Validate construction before crossing the submission boundary.
    controller.signal.throwIfAborted();
    onSubmit();
    return await fetchImpl(url, requestInit);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return sanitizeOmnipackPayload(JSON.parse(text) as Record<string, unknown>);
  } catch {
    return {};
  }
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
