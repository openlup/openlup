import { readOmnipackCredentialGate } from "./outboundOrderMapper.js";
import {
  buildOmnipackCancelOrderRequest,
  mapOmnipackFulfilmentRequestsResponse,
  mapOmnipackFulfilmentsResponse,
  mapOmnipackInboundCreatedResponse,
  mapOmnipackOrderCreatedResponse,
  mapOmnipackProductCreatedResponse,
  mapOmnipackStockMovementsResponse,
  mapOmnipackStockResponse,
  sanitizeOmnipackPayload,
  type OmnipackFulfilmentEvidence,
  type OmnipackFulfilmentRequestEvidence,
  type OmnipackInboundCreatedEvidence,
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

// Default OmniPack write paths (catalog load + product sync). Overridable via env
// (OMNIPACK_PRODUCT_PATH / OMNIPACK_INBOUND_PATH) so the exact endpoints can be corrected
// without a code deploy. Per-product sub-resources hang off the product path: GET
// /products/{sku} and POST /products/{sku}/{PRODUCT_PACKS_SEGMENT}.
const DEFAULT_PRODUCT_PATH = "/products";
const DEFAULT_INBOUND_PATH = "/shipments";
const PRODUCT_PACKS_SEGMENT = "packs";

export interface OmnipackClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  safeReadRetries: number;
  productPath: string;
  inboundPath: string;
}

export interface OmnipackClient {
  createOrder(payload: Record<string, unknown>): Promise<OmnipackOrderCreatedEvidence>;
  cancelOrder(providerOrderId: string): Promise<{ provider: "omnipack"; providerOrderId: string; status: "cancelled_requested" }>;
  // Catalog load + product sync. createProduct/createInbound/createProductPack are POST, so
  // requestJson does NOT retry them (mutations must not be silently re-sent). getProduct is a
  // GET (retried) reading the SKU's packs[] — one SKU ↔ many EANs.
  createProduct(payload: Record<string, unknown>, sku: string): Promise<OmnipackProductCreatedEvidence>;
  createInbound(payload: Record<string, unknown>, reference: string): Promise<OmnipackInboundCreatedEvidence>;
  getProduct(sku: string): Promise<OmnipackProductEvidence>;
  createProductPack(sku: string, payload: Record<string, unknown>, ean: string): Promise<OmnipackProductPackCreatedEvidence>;
  getStock(): Promise<OmnipackStockEvidence[]>;
  getStockMovements(params?: OmnipackQueryParams): Promise<OmnipackStockMovementEvidence[]>;
  getFulfilments(params?: OmnipackQueryParams): Promise<OmnipackFulfilmentEvidence[]>;
  getFulfilmentRequests(params?: OmnipackQueryParams): Promise<OmnipackFulfilmentRequestEvidence[]>;
}

export interface OmnipackQueryParams {
  startLocalDate?: string;
  endLocalDate?: string;
  page?: number;
  size?: number;
}

export function readOmnipackClientConfig(env: Record<string, string | undefined>): OmnipackClientConfig | null {
  const gate = readOmnipackCredentialGate(env);
  if (!gate.readiness.enabled || gate.readiness.requiredEnv.some((key) => !gate.readiness.presentEnv[key])) {
    return null;
  }
  if (!gate.baseUrl || !env.OMNIPACK_USERNAME || !env.OMNIPACK_PASSWORD) return null;
  return {
    baseUrl: gate.baseUrl.replace(/\/+$/, ""),
    username: env.OMNIPACK_USERNAME,
    password: env.OMNIPACK_PASSWORD,
    timeoutMs: readPositiveInteger(env.OMNIPACK_HTTP_TIMEOUT_MS, 10_000),
    safeReadRetries: readPositiveInteger(env.OMNIPACK_SAFE_READ_RETRIES, 1),
    productPath: env.OMNIPACK_PRODUCT_PATH?.trim() || DEFAULT_PRODUCT_PATH,
    inboundPath: env.OMNIPACK_INBOUND_PATH?.trim() || DEFAULT_INBOUND_PATH,
  };
}

export function createOmnipackClient(
  config: OmnipackClientConfig,
  fetchImpl: typeof fetch = fetch,
): OmnipackClient {
  return {
    async createOrder(payload) {
      return mapOmnipackOrderCreatedResponse(await requestJson(fetchImpl, config, "createOrder", "/orders", {
        method: "POST",
        body: JSON.stringify(payload),
      }));
    },

    async cancelOrder(providerOrderId) {
      const request = buildOmnipackCancelOrderRequest(providerOrderId);
      await requestJson(fetchImpl, config, "cancelOrder", request.path, { method: request.method });
      return { provider: "omnipack", providerOrderId, status: "cancelled_requested" };
    },

    async createProduct(payload, sku) {
      const body = await requestJson(fetchImpl, config, "createProduct", config.productPath, post(payload));
      return mapOmnipackProductCreatedResponse(body, sku);
    },

    async createInbound(payload, reference) {
      const body = await requestJson(fetchImpl, config, "createInbound", config.inboundPath, post(payload));
      return mapOmnipackInboundCreatedResponse(body, reference);
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
    try {
      const response = await fetchWithTimeout(fetchImpl, new URL(path, config.baseUrl), config, init);
      const body = await readJsonBody(response);
      if (response.ok) return body;

      const retryable = method === "GET" && isRetryableStatus(response.status);
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
      lastError = error instanceof OmnipackProviderError
        ? error
        : new OmnipackProviderError({
          operation,
          status: null,
          code: "network_error",
          retryable,
          mayHaveSucceeded: mayPostHaveSucceeded(method, null),
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
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
        ...(init.headers ?? {}),
      },
    });
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
// product path is right-trimmed so a trailing-slash env override does not double the slash.
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
    ? body.code
    : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
