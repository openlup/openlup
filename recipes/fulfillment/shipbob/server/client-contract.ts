export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ShipBobEnvironment = "live" | "sandbox";

export type ShipBobTokenSupplier = string | (() => string | Promise<string>);

export const SHIPBOB_ORIGINS: Readonly<Record<ShipBobEnvironment, string>> = Object.freeze({
  live: "https://api.shipbob.com",
  sandbox: "https://sandbox-api.shipbob.com",
});

export interface ShipBobCreateOrderPayload {
  readonly reference_id: string;
  readonly order_number: string;
  readonly shipping_method: string;
  readonly recipient: {
    readonly name: string;
    readonly address: {
      readonly address1: string;
      readonly address2?: string;
      readonly city: string;
      readonly zip_code: string;
      readonly country: string;
    };
    readonly email?: string;
    readonly phone_number?: string;
  };
  readonly products: readonly {
    readonly reference_id: string;
    readonly quantity: number;
  }[];
}

export interface ShipBobShipmentTracking {
  readonly tracking_number?: string;
  readonly carrier?: string;
  readonly shipping_method?: string;
  readonly tracking_url?: string;
}

export interface ShipBobShipmentRecord {
  readonly id?: string;
  readonly status?: string;
  readonly last_updated_at?: string;
  readonly actual_fulfillment_date?: string;
  readonly tracking?: ShipBobShipmentTracking;
}

export interface ShipBobOrderRecord {
  readonly id: number | null;
  readonly reference_id?: string;
  readonly order_number?: string;
  readonly status: string;
  readonly created_date?: string;
  readonly last_updated_at?: string;
  readonly shipments?: readonly ShipBobShipmentRecord[];
}

export interface ShipBobInventoryItem {
  readonly id?: number;
  readonly sku: string;
  readonly total_on_hand_quantity: number;
  readonly total_fulfillable_quantity: number;
  readonly total_committed_quantity: number;
  readonly total_awaiting_quantity: number;
  readonly last_updated_date?: string | null;
}

export interface ShipBobClient {
  createOrder(payload: ShipBobCreateOrderPayload): Promise<ShipBobOrderRecord | null>;
  getOrder(orderId: string): Promise<ShipBobOrderRecord | null>;
  getOrderByReferenceId(referenceId: string): Promise<ShipBobOrderRecord | null>;
  cancelOrder(orderId: string): Promise<{ readonly cancelled: true }>;
  listOrders(input: {
    readonly page: number;
    readonly limit: number;
    readonly startDate?: string;
  }): Promise<readonly ShipBobOrderRecord[]>;
  listInventory(input: {
    readonly page: number;
    readonly limit: number;
  }): Promise<readonly ShipBobInventoryItem[]>;
}

export interface ShipBobHttpClientOptions {
  readonly environment: ShipBobEnvironment;
  readonly token: ShipBobTokenSupplier;
  readonly channelId?: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export class ShipBobTransportError extends Error {
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
    this.name = "ShipBobTransportError";
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
const SAFE_ORDER_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CHANNEL_ID_REGEX = /^[0-9]{1,20}$/u;
const ORDERS_PATH_PREFIX = "/1.0/order/";

export function sanitizeDiagnosticCode(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const normalized = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return normalized && SAFE_CODE_REGEX.test(normalized) ? normalized : fallback;
}

export function resolvePinnedShipBobOrigin(environment: ShipBobEnvironment): string {
  if (!Object.hasOwn(SHIPBOB_ORIGINS, environment)) {
    throw new ShipBobTransportError({
      code: "shipbob_unsupported_environment",
      status: null,
      retryable: false,
      submissionAttempted: false,
      mayHaveSucceeded: false,
      responseBodyRead: false,
    });
  }
  return SHIPBOB_ORIGINS[environment];
}

export function assertSafeShipBobOrderId(orderId: string): string {
  if (
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    orderId.length > 128 ||
    /[\s\p{Cc}\p{Cf}]/u.test(orderId) ||
    orderId === "." ||
    orderId === ".." ||
    orderId.includes("/") ||
    orderId.includes("\\") ||
    orderId.includes("..") ||
    !SAFE_ORDER_ID_REGEX.test(orderId)
  ) {
    throw new ShipBobTransportError({
      code: "shipbob_invalid_order_id",
      status: null,
      retryable: false,
      submissionAttempted: false,
      mayHaveSucceeded: false,
      responseBodyRead: false,
    });
  }
  return orderId;
}

function assertPinnedHttpsUrl(url: URL, expectedOrigin: string): void {
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    Boolean(url.username) ||
    Boolean(url.password)
  ) {
    throw new ShipBobTransportError({
      code: "shipbob_origin_mismatch",
      status: null,
      retryable: false,
      submissionAttempted: false,
      mayHaveSucceeded: false,
      responseBodyRead: false,
    });
  }
}

function isBeforeSubmissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly phase?: unknown;
    readonly submissionAttempted?: unknown;
  };
  if (candidate.submissionAttempted === false) return true;
  if (candidate.phase === "before-submission" || candidate.phase === "before_submission") return true;
  if (candidate.code === "transport-before-submission" || candidate.code === "transport_before_submission") {
    return true;
  }
  return false;
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort?.();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", handleAbort);
        reject(err);
      },
    );
  });
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
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
      throw new ShipBobTransportError({
        code: "shipbob_response_too_large",
        status: response.status,
        retryable: false,
        submissionAttempted,
        mayHaveSucceeded,
        responseBodyRead: false,
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
        const { done, value } = await withAbortSignal(reader.read(), signal, () => {
          void reader.cancel().catch(() => undefined);
        });
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new ShipBobTransportError({
              code: "shipbob_response_too_large",
              status: response.status,
              retryable: false,
              submissionAttempted,
              mayHaveSucceeded,
              responseBodyRead: false,
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

  const text = await withAbortSignal(response.text(), signal);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ShipBobTransportError({
      code: "shipbob_response_too_large",
      status: response.status,
      retryable: false,
      submissionAttempted,
      mayHaveSucceeded,
      responseBodyRead: true,
    });
  }
  return text;
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeShipmentRecord(raw: unknown): ShipBobShipmentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const rawTracking =
    s["tracking"] && typeof s["tracking"] === "object"
      ? (s["tracking"] as Record<string, unknown>)
      : s;
  const trackingNumber =
    typeof rawTracking["tracking_number"] === "string" ? rawTracking["tracking_number"] : undefined;
  const carrier = typeof rawTracking["carrier"] === "string" ? rawTracking["carrier"] : undefined;
  const shippingMethod =
    typeof rawTracking["shipping_method"] === "string" ? rawTracking["shipping_method"] : undefined;
  const trackingUrl =
    typeof rawTracking["tracking_url"] === "string" ? rawTracking["tracking_url"] : undefined;

  const hasTracking = trackingNumber !== undefined || carrier !== undefined || trackingUrl !== undefined;
  const idValue =
    typeof s["id"] === "number" && Number.isSafeInteger(s["id"])
      ? String(s["id"])
      : typeof s["id"] === "string"
        ? s["id"]
        : undefined;

  return {
    id: idValue,
    status: typeof s["status"] === "string" ? s["status"] : undefined,
    last_updated_at: typeof s["last_updated_at"] === "string" ? s["last_updated_at"] : undefined,
    actual_fulfillment_date:
      typeof s["actual_fulfillment_date"] === "string" ? s["actual_fulfillment_date"] : undefined,
    ...(hasTracking
      ? {
          tracking: {
            tracking_number: trackingNumber,
            carrier,
            shipping_method: shippingMethod,
            tracking_url: trackingUrl,
          },
        }
      : {}),
  };
}

function normalizeOrderRecord(raw: unknown): ShipBobOrderRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const parsedStringId =
    typeof obj["id"] === "string" && /^[0-9]{1,20}$/u.test(obj["id"].trim())
      ? Number(obj["id"].trim())
      : null;
  const id =
    typeof obj["id"] === "number" && Number.isSafeInteger(obj["id"]) && obj["id"] >= 0
      ? obj["id"]
      : parsedStringId !== null && Number.isSafeInteger(parsedStringId) && parsedStringId >= 0
        ? parsedStringId
        : null;
  const referenceId = typeof obj["reference_id"] === "string" ? obj["reference_id"].trim() : undefined;
  const status = typeof obj["status"] === "string" ? obj["status"].trim() : "";

  if (id === null && !referenceId) return null;
  if (!status) return null;

  const rawShipments = Array.isArray(obj["shipments"]) ? obj["shipments"] : [];
  const shipments = rawShipments
    .map((entry) => normalizeShipmentRecord(entry))
    .filter((entry): entry is ShipBobShipmentRecord => entry !== null);

  return {
    id,
    reference_id: referenceId || undefined,
    order_number: typeof obj["order_number"] === "string" ? obj["order_number"] : undefined,
    status,
    created_date: typeof obj["created_date"] === "string" ? obj["created_date"] : undefined,
    last_updated_at:
      typeof obj["last_updated_at"] === "string"
        ? obj["last_updated_at"]
        : typeof obj["updated_date"] === "string"
          ? obj["updated_date"]
          : undefined,
    shipments,
  };
}

function extractArrayItems(payload: unknown): readonly unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj["items"])) return obj["items"];
    if (Array.isArray(obj["data"])) return obj["data"];
  }
  return null;
}

/**
 * Zero-SDK ShipBob 3PL REST API (v1.0 / v2025) HTTP client.
 * Pins origin, validates order IDs and optional `shipbob_channel_id`,
 * enforces streaming body caps, cancels non-2xx error bodies, and never retries mutating POST calls.
 */
export function createShipBobHttpClient(options: ShipBobHttpClientOptions): ShipBobClient {
  const origin = resolvePinnedShipBobOrigin(options.environment);
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxBodyBytes =
    options.maxBodyBytes !== undefined &&
    Number.isFinite(options.maxBodyBytes) &&
    options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;

  let validatedChannelId: string | undefined;
  if (options.channelId !== undefined) {
    if (typeof options.channelId !== "string" || !CHANNEL_ID_REGEX.test(options.channelId)) {
      throw new ShipBobTransportError({
        code: "shipbob_invalid_channel_id",
        status: null,
        retryable: false,
        submissionAttempted: false,
        mayHaveSucceeded: false,
        responseBodyRead: false,
      });
    }
    validatedChannelId = options.channelId;
  }

  async function resolveToken(): Promise<string> {
    let rawToken: unknown;
    try {
      rawToken = typeof options.token === "function" ? await options.token() : options.token;
    } catch (error) {
      if (error instanceof ShipBobTransportError) throw error;
      const before = isBeforeSubmissionError(error);
      throw new ShipBobTransportError({
        code: before ? "shipbob_transport_before_submission" : "shipbob_credentials_unavailable",
        status: null,
        retryable: true,
        submissionAttempted: false,
        mayHaveSucceeded: false,
        responseBodyRead: false,
      });
    }
    if (
      typeof rawToken !== "string" ||
      !rawToken.trim() ||
      /[\r\n\p{Cc}\p{Cf}]/u.test(rawToken)
    ) {
      throw new ShipBobTransportError({
        code: "shipbob_token_invalid",
        status: null,
        retryable: false,
        submissionAttempted: false,
        mayHaveSucceeded: false,
        responseBodyRead: false,
      });
    }
    return rawToken.trim();
  }

  async function requestJson(params: {
    readonly method: "GET" | "POST";
    readonly pathAndQuery: string;
    readonly body?: unknown;
    readonly allowNotFound?: boolean;
  }): Promise<{ readonly status: number; readonly payload: unknown }> {
    const isMutating = params.method === "POST";
    const bearerToken = await resolveToken();

    const url = new URL(params.pathAndQuery, origin);
    assertPinnedHttpsUrl(url, origin);

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
    };
    if (validatedChannelId !== undefined) {
      headers["shipbob_channel_id"] = validatedChannelId;
    }
    let bodyText: string | undefined;
    if (isMutating && params.body !== undefined) {
      headers["content-type"] = "application/json";
      bodyText = JSON.stringify(params.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(url.href, {
        method: params.method,
        headers,
        body: bodyText,
        redirect: "error",
        signal: controller.signal,
      });

      if (params.allowNotFound && response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { status: 404, payload: null };
      }

      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        const uncertainStatus = status === 408 || status === 409 || status === 429 || status >= 500;
        throw new ShipBobTransportError({
          code: `shipbob_http_${status}`,
          status,
          retryable: uncertainStatus,
          submissionAttempted: true,
          mayHaveSucceeded: isMutating && uncertainStatus,
          responseBodyRead: false,
        });
      }

      const rawText = await readBoundedText(
        response,
        maxBodyBytes,
        controller.signal,
        true,
        isMutating,
      );
      if (!rawText.trim()) {
        return { status: response.status, payload: {} };
      }
      try {
        return { status: response.status, payload: JSON.parse(rawText) };
      } catch {
        throw new ShipBobTransportError({
          code: "shipbob_invalid_json",
          status: response.status,
          retryable: isMutating,
          submissionAttempted: true,
          mayHaveSucceeded: isMutating,
          responseBodyRead: true,
        });
      }
    } catch (error) {
      if (error instanceof ShipBobTransportError) {
        throw error;
      }
      if (isBeforeSubmissionError(error)) {
        throw new ShipBobTransportError({
          code: "shipbob_transport_before_submission",
          status: null,
          retryable: true,
          submissionAttempted: false,
          mayHaveSucceeded: false,
          responseBodyRead: false,
        });
      }
      throw new ShipBobTransportError({
        code: controller.signal.aborted ? "shipbob_timeout" : "shipbob_transport_error",
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

  function buildSafeOrderPath(orderId: string, suffix = ""): string {
    const safeId = assertSafeShipBobOrderId(orderId);
    const encodedId = encodeURIComponent(safeId);
    const path = `${ORDERS_PATH_PREFIX}${encodedId}${suffix}`;
    const verified = new URL(path, origin);
    const remainder = verified.pathname.slice(ORDERS_PATH_PREFIX.length);
    const expectedTail = `${encodedId}${suffix}`;
    if (!verified.pathname.startsWith(ORDERS_PATH_PREFIX) || remainder !== expectedTail) {
      throw new ShipBobTransportError({
        code: "shipbob_invalid_order_id",
        status: null,
        retryable: false,
        submissionAttempted: false,
        mayHaveSucceeded: false,
        responseBodyRead: false,
      });
    }
    return path;
  }

  return {
    async createOrder(payload: ShipBobCreateOrderPayload): Promise<ShipBobOrderRecord | null> {
      const result = await requestJson({
        method: "POST",
        pathAndQuery: "/1.0/order",
        body: payload,
      });
      const normalized = normalizeOrderRecord(result.payload);
      if (!normalized) {
        throw new ShipBobTransportError({
          code: "shipbob_malformed_response",
          status: result.status,
          retryable: true,
          submissionAttempted: true,
          mayHaveSucceeded: true,
          responseBodyRead: true,
        });
      }
      return normalized;
    },

    async getOrder(orderId: string): Promise<ShipBobOrderRecord | null> {
      const path = buildSafeOrderPath(orderId);
      const result = await requestJson({
        method: "GET",
        pathAndQuery: path,
        allowNotFound: true,
      });
      if (result.status === 404 || result.payload === null) {
        return null;
      }
      return normalizeOrderRecord(result.payload);
    },

    async getOrderByReferenceId(referenceId: string): Promise<ShipBobOrderRecord | null> {
      const safeRefId = assertSafeShipBobOrderId(referenceId);
      const result = await requestJson({
        method: "GET",
        pathAndQuery: `/1.0/order?ReferenceIds=${encodeURIComponent(safeRefId)}`,
        allowNotFound: true,
      });
      if (result.status === 404 || result.payload === null) {
        return null;
      }
      const items = extractArrayItems(result.payload);
      if (items === null) {
        return normalizeOrderRecord(result.payload);
      }
      let firstValid: ShipBobOrderRecord | null = null;
      for (const item of items) {
        const normalized = normalizeOrderRecord(item);
        if (!normalized) continue;
        if (normalized.reference_id === safeRefId) return normalized;
        if (firstValid === null) firstValid = normalized;
      }
      return firstValid;
    },

    async cancelOrder(orderId: string): Promise<{ readonly cancelled: true }> {
      const path = buildSafeOrderPath(orderId, "/cancel");
      await requestJson({
        method: "POST",
        pathAndQuery: path,
        body: {},
      });
      return { cancelled: true };
    },

    async listOrders(input: {
      readonly page: number;
      readonly limit: number;
      readonly startDate?: string;
    }): Promise<readonly ShipBobOrderRecord[]> {
      if (
        !Number.isSafeInteger(input.page) ||
        input.page < 1 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1
      ) {
        throw new ShipBobTransportError({
          code: "shipbob_invalid_pagination",
          status: null,
          retryable: false,
          submissionAttempted: false,
          mayHaveSucceeded: false,
          responseBodyRead: false,
        });
      }
      const query = new URLSearchParams({
        Page: String(input.page),
        Limit: String(input.limit),
      });
      if (input.startDate) {
        query.set("StartDate", input.startDate);
      }
      const result = await requestJson({
        method: "GET",
        pathAndQuery: `/1.0/order?${query.toString()}`,
      });
      const rawOrders = extractArrayItems(result.payload);
      if (rawOrders === null) {
        throw new ShipBobTransportError({
          code: "shipbob_malformed_response",
          status: result.status,
          retryable: true,
          submissionAttempted: true,
          mayHaveSucceeded: false,
          responseBodyRead: true,
        });
      }
      return rawOrders
        .map((entry) => normalizeOrderRecord(entry))
        .filter((entry): entry is ShipBobOrderRecord => entry !== null);
    },

    async listInventory(input: {
      readonly page: number;
      readonly limit: number;
    }): Promise<readonly ShipBobInventoryItem[]> {
      if (
        !Number.isSafeInteger(input.page) ||
        input.page < 1 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1
      ) {
        throw new ShipBobTransportError({
          code: "shipbob_invalid_pagination",
          status: null,
          retryable: false,
          submissionAttempted: false,
          mayHaveSucceeded: false,
          responseBodyRead: false,
        });
      }
      const query = new URLSearchParams({
        Page: String(input.page),
        Limit: String(input.limit),
      });
      const result = await requestJson({
        method: "GET",
        pathAndQuery: `/1.0/inventory?${query.toString()}`,
      });
      const rawItems = extractArrayItems(result.payload);
      if (rawItems === null) {
        throw new ShipBobTransportError({
          code: "shipbob_malformed_response",
          status: result.status,
          retryable: true,
          submissionAttempted: true,
          mayHaveSucceeded: false,
          responseBodyRead: true,
        });
      }
      const items: ShipBobInventoryItem[] = [];
      for (const entry of rawItems) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const sku = typeof row["sku"] === "string" ? row["sku"] : "";
        const totalOnHand = toNonNegativeInt(row["total_on_hand_quantity"]);
        const totalFulfillable = toNonNegativeInt(row["total_fulfillable_quantity"]);
        items.push({
          id:
            typeof row["id"] === "number" && Number.isSafeInteger(row["id"])
              ? row["id"]
              : undefined,
          sku,
          total_on_hand_quantity: totalOnHand,
          total_fulfillable_quantity: totalFulfillable,
          total_committed_quantity: toNonNegativeInt(row["total_committed_quantity"]),
          total_awaiting_quantity: toNonNegativeInt(row["total_awaiting_quantity"]),
          last_updated_date:
            typeof row["last_updated_date"] === "string" ? row["last_updated_date"] : null,
        });
      }
      return items;
    },
  };
}
