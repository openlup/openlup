import { createLwaTokenClient, LwaTokenError, type LwaCredentials } from "./lwa.js";
import { signAwsV4Request, type AwsSigV4Credentials } from "./sigv4.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AmazonMcfRegion = "na" | "eu" | "fe";
export type AmazonMcfEnvironment = "live" | "sandbox";

export interface AmazonMcfEndpointConfig {
  readonly awsRegion: "us-east-1" | "eu-west-1" | "us-west-2";
  readonly liveOrigin: string;
  readonly sandboxOrigin: string;
}

export const AMAZON_MCF_ENDPOINTS: Readonly<Record<AmazonMcfRegion, AmazonMcfEndpointConfig>> = Object.freeze({
  na: Object.freeze({
    awsRegion: "us-east-1",
    liveOrigin: "https://sellingpartnerapi-na.amazon.com",
    sandboxOrigin: "https://sandbox.sellingpartnerapi-na.amazon.com",
  }),
  eu: Object.freeze({
    awsRegion: "eu-west-1",
    liveOrigin: "https://sellingpartnerapi-eu.amazon.com",
    sandboxOrigin: "https://sandbox.sellingpartnerapi-eu.amazon.com",
  }),
  fe: Object.freeze({
    awsRegion: "us-west-2",
    liveOrigin: "https://sellingpartnerapi-fe.amazon.com",
    sandboxOrigin: "https://sandbox.sellingpartnerapi-fe.amazon.com",
  }),
});

export interface AmazonMcfCredentials extends LwaCredentials, AwsSigV4Credentials {}

export interface AmazonMcfCreateOrderPayload {
  readonly marketplaceId: string;
  readonly sellerFulfillmentOrderId: string;
  readonly displayableOrderId: string;
  readonly displayableOrderDate: string;
  readonly displayableOrderComment: string;
  readonly shippingSpeedCategory: "Standard" | "Expedited" | "Priority";
  readonly destinationAddress: {
    readonly name: string;
    readonly addressLine1: string;
    readonly addressLine2?: string;
    readonly city: string;
    readonly stateOrRegion?: string;
    readonly postalCode: string;
    readonly countryCode: string;
    readonly phone?: string;
  };
  readonly notificationEmails?: readonly string[];
  readonly items: readonly {
    readonly sellerSku: string;
    readonly sellerFulfillmentOrderItemId: string;
    readonly quantity: number;
  }[];
}

export interface AmazonMcfOrderRecord {
  readonly sellerFulfillmentOrderId: string;
  readonly marketplaceId?: string;
  readonly displayableOrderId?: string;
  readonly fulfillmentOrderStatus: string;
  readonly statusUpdatedDate?: string;
  readonly receivedDate?: string;
  readonly fulfillmentShipments?: readonly {
    readonly amazonShipmentId?: string;
    readonly fulfillmentShipmentStatus?: string;
    readonly shippingDate?: string;
    readonly fulfillmentShipmentPackage?: readonly {
      readonly packageNumber?: number;
      readonly carrierCode?: string;
      readonly trackingNumber?: string;
      readonly trackingUrl?: string;
    }[];
  }[];
}

export interface AmazonMcfListOrdersResponse {
  readonly fulfillmentOrders: readonly AmazonMcfOrderRecord[];
  readonly nextToken: string | null;
}

export interface AmazonMcfInventorySummary {
  readonly sellerSku: string;
  readonly fnSku?: string;
  readonly asin?: string;
  readonly totalQuantity: number;
  readonly fulfillableQuantity: number;
  readonly reservedQuantity: number;
  readonly unfulfillableQuantity: number;
  readonly lastUpdatedTime?: string | null;
}

export interface AmazonMcfListInventoryResponse {
  readonly inventorySummaries: readonly AmazonMcfInventorySummary[];
  readonly nextToken: string | null;
}

export interface AmazonMcfClient {
  createFulfillmentOrder(payload: AmazonMcfCreateOrderPayload): Promise<{ readonly accepted: true }>;
  getFulfillmentOrder(sellerFulfillmentOrderId: string): Promise<AmazonMcfOrderRecord | null>;
  listAllFulfillmentOrders(input?: { readonly nextToken?: string | null }): Promise<AmazonMcfListOrdersResponse>;
  listInventorySummaries(input: {
    readonly marketplaceId: string;
    readonly nextToken?: string | null;
  }): Promise<AmazonMcfListInventoryResponse>;
}

export interface AmazonMcfHttpClientOptions {
  readonly region: AmazonMcfRegion;
  readonly environment: AmazonMcfEnvironment;
  readonly fetchImpl: FetchLike;
  readonly credentials: () => Promise<AmazonMcfCredentials> | AmazonMcfCredentials;
  readonly clock: () => string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly lwaRefreshSkewMs?: number;
}

export class AmazonMcfTransportError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly submissionAttempted: boolean;
  readonly mayHaveSucceeded: boolean;
  readonly responseBodyRead: boolean;

  constructor(params: {
    readonly code: string;
    readonly status: number | null;
    readonly retryable: boolean;
    readonly submissionAttempted: boolean;
    readonly mayHaveSucceeded: boolean;
    readonly responseBodyRead: boolean;
  }) {
    super(params.code);
    this.name = "AmazonMcfTransportError";
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    this.submissionAttempted = params.submissionAttempted;
    this.mayHaveSucceeded = params.mayHaveSucceeded;
    this.responseBodyRead = params.responseBodyRead;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const SAFE_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_]{0,95}$/u;

export function sanitizeDiagnosticCode(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const normalized = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return normalized && SAFE_CODE_REGEX.test(normalized) ? normalized : fallback;
}

export function resolvePinnedAmazonMcfOrigin(
  region: AmazonMcfRegion,
  environment: AmazonMcfEnvironment,
): { readonly origin: string; readonly awsRegion: "us-east-1" | "eu-west-1" | "us-west-2" } {
  const endpoint = AMAZON_MCF_ENDPOINTS[region];
  if (!endpoint) {
    throw new AmazonMcfTransportError({
      code: "amazon_mcf_unsupported_region",
      status: null,
      retryable: false,
      submissionAttempted: false,
      mayHaveSucceeded: false,
      responseBodyRead: false,
    });
  }
  if (environment !== "live" && environment !== "sandbox") {
    throw new AmazonMcfTransportError({
      code: "amazon_mcf_unsupported_environment",
      status: null,
      retryable: false,
      submissionAttempted: false,
      mayHaveSucceeded: false,
      responseBodyRead: false,
    });
  }
  return {
    origin: environment === "live" ? endpoint.liveOrigin : endpoint.sandboxOrigin,
    awsRegion: endpoint.awsRegion,
  };
}

function assertPinnedHttpsUrl(url: URL, expectedOrigin: string): void {
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    Boolean(url.username) ||
    Boolean(url.password)
  ) {
    throw new AmazonMcfTransportError({
      code: "amazon_mcf_origin_mismatch",
      status: null,
      retryable: false,
      submissionAttempted: false,
      mayHaveSucceeded: false,
      responseBodyRead: false,
    });
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  submissionAttempted: boolean,
  mayHaveSucceeded: boolean,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancellation failures.
      }
      throw new AmazonMcfTransportError({
        code: "amazon_mcf_response_too_large",
        status: response.status,
        retryable: false,
        submissionAttempted,
        mayHaveSucceeded,
        responseBodyRead: false,
      });
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new AmazonMcfTransportError({
      code: "amazon_mcf_response_too_large",
      status: response.status,
      retryable: false,
      submissionAttempted,
      mayHaveSucceeded,
      responseBodyRead: true,
    });
  }
  return text;
}

function extractSpApiErrorCode(bodyText: string, status: number): string {
  try {
    const parsed = JSON.parse(bodyText) as { errors?: readonly { code?: unknown }[] };
    const firstCode = Array.isArray(parsed?.errors) ? parsed.errors[0]?.code : undefined;
    if (typeof firstCode === "string" && firstCode.trim()) {
      return sanitizeDiagnosticCode(`amazon_mcf_${firstCode}`, `amazon_mcf_http_${status}`);
    }
  } catch {
    // Non-JSON error body; fall back to HTTP status diagnostic code.
  }
  return `amazon_mcf_http_${status}`;
}

function isBeforeSubmissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly phase?: unknown;
    readonly name?: unknown;
    readonly submissionAttempted?: unknown;
  };
  if (candidate.submissionAttempted === false) return true;
  if (candidate.phase === "before-submission" || candidate.phase === "before_submission") return true;
  if (candidate.code === "transport-before-submission" || candidate.code === "transport_before_submission") {
    return true;
  }
  return false;
}

function normalizeFulfillmentOrder(raw: unknown): AmazonMcfOrderRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const order = (root["fulfillmentOrder"] && typeof root["fulfillmentOrder"] === "object"
    ? root["fulfillmentOrder"]
    : root) as Record<string, unknown>;

  const sellerFulfillmentOrderId =
    typeof order["sellerFulfillmentOrderId"] === "string" ? order["sellerFulfillmentOrderId"].trim() : "";
  const fulfillmentOrderStatus =
    typeof order["fulfillmentOrderStatus"] === "string" ? order["fulfillmentOrderStatus"].trim() : "";
  if (!sellerFulfillmentOrderId || !fulfillmentOrderStatus) {
    return null;
  }

  const rawShipments = Array.isArray(root["fulfillmentShipments"])
    ? root["fulfillmentShipments"]
    : Array.isArray(order["fulfillmentShipments"])
      ? order["fulfillmentShipments"]
      : [];

  const fulfillmentShipments = rawShipments
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((shipment) => {
      const rawPackages = Array.isArray(shipment["fulfillmentShipmentPackage"])
        ? shipment["fulfillmentShipmentPackage"]
        : [];
      return {
        amazonShipmentId:
          typeof shipment["amazonShipmentId"] === "string" ? shipment["amazonShipmentId"] : undefined,
        fulfillmentShipmentStatus:
          typeof shipment["fulfillmentShipmentStatus"] === "string"
            ? shipment["fulfillmentShipmentStatus"]
            : undefined,
        shippingDate: typeof shipment["shippingDate"] === "string" ? shipment["shippingDate"] : undefined,
        fulfillmentShipmentPackage: rawPackages
          .filter((pkg): pkg is Record<string, unknown> => Boolean(pkg && typeof pkg === "object"))
          .map((pkg) => ({
            packageNumber: typeof pkg["packageNumber"] === "number" ? pkg["packageNumber"] : undefined,
            carrierCode: typeof pkg["carrierCode"] === "string" ? pkg["carrierCode"] : undefined,
            trackingNumber: typeof pkg["trackingNumber"] === "string" ? pkg["trackingNumber"] : undefined,
            trackingUrl: typeof pkg["trackingUrl"] === "string" ? pkg["trackingUrl"] : undefined,
          })),
      };
    });

  return {
    sellerFulfillmentOrderId,
    marketplaceId: typeof order["marketplaceId"] === "string" ? order["marketplaceId"] : undefined,
    displayableOrderId: typeof order["displayableOrderId"] === "string" ? order["displayableOrderId"] : undefined,
    fulfillmentOrderStatus,
    statusUpdatedDate: typeof order["statusUpdatedDate"] === "string" ? order["statusUpdatedDate"] : undefined,
    receivedDate: typeof order["receivedDate"] === "string" ? order["receivedDate"] : undefined,
    fulfillmentShipments,
  };
}

/**
 * Zero-SDK Amazon SP-API Fulfillment Outbound (v2020-07-01) & FBA Inventory (v1) HTTP client.
 * Combines instance-scoped single-flight LWA token exchange + pure `node:crypto` AWS SigV4 signing.
 * Never retries mutating POST requests automatically.
 */
export function createAmazonMcfHttpClient(options: AmazonMcfHttpClientOptions): AmazonMcfClient {
  const { origin, awsRegion } = resolvePinnedAmazonMcfOrigin(options.region, options.environment);
  const timeoutMs =
    options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxBodyBytes =
    options.maxBodyBytes && Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;

  const lwaClient = createLwaTokenClient({
    fetchImpl: options.fetchImpl,
    clock: options.clock,
    timeoutMs,
    refreshSkewMs: options.lwaRefreshSkewMs,
  });

  async function requestJson(params: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query?: Readonly<Record<string, string | undefined>>;
    readonly body?: unknown;
    readonly allowNotFound?: boolean;
  }): Promise<{ readonly status: number; readonly payload: unknown }> {
    const isMutating = params.method === "POST";

    let creds: AmazonMcfCredentials;
    try {
      creds = await options.credentials();
    } catch (error) {
      if (error instanceof AmazonMcfTransportError) throw error;
      const before = isBeforeSubmissionError(error);
      throw new AmazonMcfTransportError({
        code: before ? "amazon_mcf_transport_before_submission" : "amazon_mcf_credentials_unavailable",
        status: null,
        retryable: true,
        submissionAttempted: false,
        mayHaveSucceeded: false,
        responseBodyRead: false,
      });
    }

    let accessToken: string;
    try {
      accessToken = await lwaClient.getAccessToken(creds);
    } catch (error) {
      if (error instanceof LwaTokenError) {
        throw new AmazonMcfTransportError({
          code: sanitizeDiagnosticCode(error.code, "amazon_lwa_token_failed"),
          status: error.status,
          retryable: error.retryable,
          submissionAttempted: false,
          mayHaveSucceeded: false,
          responseBodyRead: error.responseBodyRead,
        });
      }
      throw new AmazonMcfTransportError({
        code: "amazon_lwa_token_failed",
        status: null,
        retryable: true,
        submissionAttempted: false,
        mayHaveSucceeded: false,
        responseBodyRead: false,
      });
    }

    const url = new URL(params.path, origin);
    if (params.query) {
      for (const [key, value] of Object.entries(params.query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    assertPinnedHttpsUrl(url, origin);

    const bodyText = params.body !== undefined ? JSON.stringify(params.body) : "";
    const bodyBytes = new TextEncoder().encode(bodyText);

    const baseHeaders: Record<string, string> = {
      accept: "application/json",
      "x-amz-access-token": accessToken,
    };
    if (isMutating) {
      baseHeaders["content-type"] = "application/json";
    }

    const signed = signAwsV4Request({
      method: params.method,
      url,
      region: awsRegion,
      service: "execute-api",
      headers: baseHeaders,
      body: bodyBytes,
      credentials: creds,
      timestampIso: options.clock(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await options.fetchImpl(url.href, {
        method: params.method,
        headers: signed.headers,
        body: isMutating ? bodyText : undefined,
        redirect: "error",
        signal: controller.signal,
      });

      if (params.allowNotFound && response.status === 404) {
        try {
          await response.body?.cancel();
        } catch {
          // Ignore body cancel errors on expected 404.
        }
        return { status: 404, payload: null };
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          lwaClient.invalidate();
        }
        if (status >= 400 && status < 500 && status !== 429) {
          // Read small error body for SP-API machine error code (e.g., InvalidInput), bounded strictly.
          let errBody = "";
          let bodyRead = false;
          try {
            errBody = await readBoundedText(response, 32 * 1024, true, false);
            bodyRead = true;
          } catch {
            try {
              await response.body?.cancel();
            } catch {
              // Ignore body cancel failure.
            }
          }
          throw new AmazonMcfTransportError({
            code: extractSpApiErrorCode(errBody, status),
            status,
            retryable: false,
            submissionAttempted: true,
            mayHaveSucceeded: false,
            responseBodyRead: bodyRead,
          });
        }
        try {
          await response.body?.cancel();
        } catch {
          // Ignore cancel errors on 429/5xx.
        }
        throw new AmazonMcfTransportError({
          code: `amazon_mcf_http_${status}`,
          status,
          retryable: true,
          submissionAttempted: true,
          mayHaveSucceeded: isMutating,
          responseBodyRead: false,
        });
      }

      const rawText = await readBoundedText(response, maxBodyBytes, true, isMutating);
      if (!rawText.trim()) {
        return { status: response.status, payload: {} };
      }
      try {
        return { status: response.status, payload: JSON.parse(rawText) };
      } catch {
        throw new AmazonMcfTransportError({
          code: "amazon_mcf_invalid_json",
          status: response.status,
          retryable: isMutating,
          submissionAttempted: true,
          mayHaveSucceeded: isMutating,
          responseBodyRead: true,
        });
      }
    } catch (error) {
      if (error instanceof AmazonMcfTransportError) {
        throw error;
      }
      if (isBeforeSubmissionError(error)) {
        throw new AmazonMcfTransportError({
          code: "amazon_mcf_transport_before_submission",
          status: null,
          retryable: true,
          submissionAttempted: false,
          mayHaveSucceeded: false,
          responseBodyRead: false,
        });
      }
      const aborted = controller.signal.aborted;
      throw new AmazonMcfTransportError({
        code: aborted ? "amazon_mcf_timeout" : "amazon_mcf_transport_error",
        status: null,
        retryable: true,
        submissionAttempted: true,
        mayHaveSucceeded: isMutating,
        responseBodyRead: false,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createFulfillmentOrder(payload: AmazonMcfCreateOrderPayload): Promise<{ readonly accepted: true }> {
      await requestJson({
        method: "POST",
        path: "/fba/outbound/2020-07-01/fulfillmentOrders",
        body: payload,
      });
      return { accepted: true };
    },

    async getFulfillmentOrder(sellerFulfillmentOrderId: string): Promise<AmazonMcfOrderRecord | null> {
      const encodedId = encodeURIComponent(sellerFulfillmentOrderId);
      const result = await requestJson({
        method: "GET",
        path: `/fba/outbound/2020-07-01/fulfillmentOrders/${encodedId}`,
        allowNotFound: true,
      });
      if (result.status === 404 || !result.payload || typeof result.payload !== "object") {
        return null;
      }
      const root = result.payload as Record<string, unknown>;
      const inner = root["payload"] && typeof root["payload"] === "object" ? root["payload"] : root;
      return normalizeFulfillmentOrder(inner);
    },

    async listAllFulfillmentOrders(input?: {
      readonly nextToken?: string | null;
    }): Promise<AmazonMcfListOrdersResponse> {
      const result = await requestJson({
        method: "GET",
        path: "/fba/outbound/2020-07-01/fulfillmentOrders",
        query: input?.nextToken ? { nextToken: input.nextToken } : undefined,
      });
      const root = (result.payload ?? {}) as Record<string, unknown>;
      const inner = (root["payload"] && typeof root["payload"] === "object"
        ? root["payload"]
        : root) as Record<string, unknown>;
      const rawOrders = Array.isArray(inner["fulfillmentOrders"]) ? inner["fulfillmentOrders"] : [];
      const fulfillmentOrders = rawOrders
        .map((entry) => normalizeFulfillmentOrder(entry))
        .filter((entry): entry is AmazonMcfOrderRecord => entry !== null);
      const nextToken =
        typeof inner["nextToken"] === "string" && inner["nextToken"].trim()
          ? inner["nextToken"].trim()
          : null;
      return { fulfillmentOrders, nextToken };
    },

    async listInventorySummaries(input: {
      readonly marketplaceId: string;
      readonly nextToken?: string | null;
    }): Promise<AmazonMcfListInventoryResponse> {
      const result = await requestJson({
        method: "GET",
        path: "/fba/inventory/v1/summaries",
        query: {
          details: "true",
          granularityType: "Marketplace",
          granularityId: input.marketplaceId,
          marketplaceIds: input.marketplaceId,
          ...(input.nextToken ? { nextToken: input.nextToken } : {}),
        },
      });
      const root = (result.payload ?? {}) as Record<string, unknown>;
      const inner = (root["payload"] && typeof root["payload"] === "object"
        ? root["payload"]
        : root) as Record<string, unknown>;
      const pagination = (root["pagination"] && typeof root["pagination"] === "object"
        ? root["pagination"]
        : inner["pagination"] && typeof inner["pagination"] === "object"
          ? inner["pagination"]
          : {}) as Record<string, unknown>;
      const rawSummaries = Array.isArray(inner["inventorySummaries"]) ? inner["inventorySummaries"] : [];
      const inventorySummaries: AmazonMcfInventorySummary[] = [];
      for (const entry of rawSummaries) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const sellerSku = typeof row["sellerSku"] === "string" ? row["sellerSku"] : "";
        const details = (row["inventoryDetails"] && typeof row["inventoryDetails"] === "object"
          ? row["inventoryDetails"]
          : {}) as Record<string, unknown>;
        const fulfillableQuantity = toNonNegativeInt(details["fulfillableQuantity"]);
        const reservedObj = (details["reservedQuantity"] && typeof details["reservedQuantity"] === "object"
          ? details["reservedQuantity"]
          : {}) as Record<string, unknown>;
        const reservedQuantity = toNonNegativeInt(reservedObj["totalReservedQuantity"]);
        const unfulfillableObj = (details["unfulfillableQuantity"] &&
        typeof details["unfulfillableQuantity"] === "object"
          ? details["unfulfillableQuantity"]
          : {}) as Record<string, unknown>;
        const unfulfillableQuantity = toNonNegativeInt(unfulfillableObj["totalUnfulfillableQuantity"]);
        const declaredTotal = toNonNegativeInt(row["totalQuantity"]);
        const totalQuantity =
          declaredTotal > 0 ? declaredTotal : fulfillableQuantity + reservedQuantity + unfulfillableQuantity;
        inventorySummaries.push({
          sellerSku,
          fnSku: typeof row["fnSku"] === "string" ? row["fnSku"] : undefined,
          asin: typeof row["asin"] === "string" ? row["asin"] : undefined,
          totalQuantity,
          fulfillableQuantity,
          reservedQuantity,
          unfulfillableQuantity,
          lastUpdatedTime: typeof row["lastUpdatedTime"] === "string" ? row["lastUpdatedTime"] : null,
        });
      }
      const nextToken =
        typeof pagination["nextToken"] === "string" && pagination["nextToken"].trim()
          ? pagination["nextToken"].trim()
          : typeof inner["nextToken"] === "string" && inner["nextToken"].trim()
            ? inner["nextToken"].trim()
            : null;
      return { inventorySummaries, nextToken };
    },
  };
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
