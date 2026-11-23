import {
  createHardenedFetch,
  createRetryAfterCooldown,
  HardenedFetchError,
  type RetryAfterCooldown,
} from "@openlup/platform/adapter-kit";

/**
 * Narrow structural client contract and zero-SDK hardened HTTP client for
 * Shopify Admin REST API (2025-01) (ADR-001: zero vendor SDK, zero ambient
 * environment reads, zero ambient fetch, strict shopDomain origin pinning,
 * redirect: "error").
 */

export type ShopifyFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const SHOPIFY_API_VERSION = "2025-01";
export const SHOPIFY_SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/u;

const SAFE_CURSOR_PATTERN = /^[A-Za-z0-9_=-]{1,512}$/u;
const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MIN_ACCESS_TOKEN_LENGTH = 8;

const SUPPORTED_ISO_CURRENCIES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf("currency"),
);
const CURRENCY_EXPONENT_CACHE = new Map<string, number>();

export interface ShopifyMoneyAmount {
  amount: string;
  currency_code: string;
}

export interface ShopifyDiscountAllocation {
  amount: string;
}

export interface ShopifyTaxLine {
  rate?: number | string | null;
  price?: string | null;
}

export interface ShopifyLineItem {
  id: number | string;
  product_id?: number | string | null;
  variant_id?: number | string | null;
  sku?: string | null;
  title?: string | null;
  quantity: number;
  price: string;
  total_discount?: string | null;
  discount_allocations?: readonly ShopifyDiscountAllocation[];
  tax_lines?: readonly ShopifyTaxLine[];
}

export interface ShopifyShippingLine {
  id?: number | string;
  title?: string | null;
  code?: string | null;
  source?: string | null;
  price: string;
  discounted_price?: string | null;
  discount_allocations?: readonly ShopifyDiscountAllocation[];
}

export interface ShopifyAddress {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  country_code?: string | null;
  phone?: string | null;
}

export interface ShopifyCustomer {
  id?: number | string | null;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
}

export interface ShopifyOrderResource {
  id: number | string;
  name?: string | null;
  order_number?: number | null;
  created_at: string;
  updated_at?: string | null;
  processed_at?: string | null;
  currency: string;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  taxes_included?: boolean;
  total_price: string;
  subtotal_price?: string | null;
  total_discounts?: string | null;
  checkout_id?: number | string | null;
  payment_gateway_names?: readonly string[];
  email?: string | null;
  phone?: string | null;
  customer?: ShopifyCustomer | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items: readonly ShopifyLineItem[];
  shipping_lines?: readonly ShopifyShippingLine[];
}

export interface ShopifyListOrdersInput {
  since: string | null;
  cursor: string | null;
  limit: number;
  signal?: AbortSignal;
}

export interface ShopifyListOrdersPage {
  orders: readonly ShopifyOrderResource[];
  nextCursor: string | null;
}

/** Narrow structural client contract consumed by createShopifyChannelAdapter. */
export interface ShopifyAdminClient {
  listOrders(input: ShopifyListOrdersInput): Promise<ShopifyListOrdersPage>;
}

export interface ShopifyHttpClientConfig {
  /** Bare subdomain only (e.g. "acme-store" -> https://acme-store.myshopify.com). */
  shopDomain: string;
  /** Admin API access token or per-call resolver; validated before dispatch. */
  accessToken: string | (() => string);
  /** Explicitly injected fetch implementation (never ambient global fetch). */
  fetchImpl: ShopifyFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  clock?: () => number;
  cooldown?: RetryAfterCooldown;
}

export type ShopifyTransportErrorKind =
  | "config_error"
  | "authentication_failed"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "provider_error";

/**
 * Redacted transport error carrying only allowlisted diagnostic codes.
 * Raw HTTP bodies, headers, and Admin API tokens never enter Error.message.
 */
export class ShopifyTransportError extends Error {
  readonly kind: ShopifyTransportErrorKind;
  readonly diagnosticCode: string;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    kind: ShopifyTransportErrorKind;
    diagnosticCode: string;
    httpStatus: number | null;
    retryAfterSeconds?: number;
  }) {
    const safeCode = toSafeDiagnosticCode(input.diagnosticCode, "SHOPIFY_TRANSPORT_ERROR");
    super(`Shopify transport error: ${safeCode}`);
    this.name = input.kind === "timeout" ? "AbortError" : "ShopifyTransportError";
    this.kind = input.kind;
    this.diagnosticCode = safeCode;
    this.httpStatus = input.httpStatus;
    if (input.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
  }
}

export function toSafeDiagnosticCode(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return SAFE_DIAGNOSTIC_CODE.test(normalized) ? normalized : fallback;
}

function hasWhitespaceOrControlChar(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Validates a bare Shopify shop subdomain and returns the pinned HTTPS origin. */
export function assertValidShopifyShopDomain(shopDomain: unknown): {
  shopDomain: string;
  origin: string;
} {
  if (typeof shopDomain !== "string" || !SHOPIFY_SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    throw new ShopifyTransportError({
      kind: "config_error",
      diagnosticCode: "SHOPIFY_INVALID_SHOP_DOMAIN",
      httpStatus: null,
    });
  }
  return {
    shopDomain,
    origin: `https://${shopDomain}.myshopify.com`,
  };
}

export function assertValidShopifyAccessToken(token: unknown): string {
  if (
    typeof token !== "string"
    || token.length < MIN_ACCESS_TOKEN_LENGTH
    || hasWhitespaceOrControlChar(token)
  ) {
    throw new ShopifyTransportError({
      kind: "authentication_failed",
      diagnosticCode: "SHOPIFY_CREDENTIALS_MISSING",
      httpStatus: null,
    });
  }
  return token;
}

/** Resolves ISO-4217 minor-unit exponent from Intl without hardcoded currency tables. */
export function resolveCurrencyExponent(currency: string): number | null {
  if (typeof currency !== "string" || !CURRENCY_CODE_PATTERN.test(currency)) {
    return null;
  }
  if (!SUPPORTED_ISO_CURRENCIES.has(currency)) {
    return null;
  }
  const cached = CURRENCY_EXPONENT_CACHE.get(currency);
  if (cached !== undefined) {
    return cached;
  }
  const options = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).resolvedOptions();
  const digits = options.maximumFractionDigits;
  if (typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > 6) {
    return null;
  }
  CURRENCY_EXPONENT_CACHE.set(currency, digits);
  return digits;
}

/**
 * Parses a strict non-negative Shopify decimal string into integer minor units
 * using `BigInt` + `Intl` exponent (zero IEEE-754 float math).
 */
export function parseShopifyDecimalToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const exponent = resolveCurrencyExponent(currency);
  if (exponent === null) {
    return null;
  }
  const match = /^([0-9]+)(?:\.([0-9]+))?$/u.exec(trimmed);
  if (!match) {
    return null;
  }
  const wholePart = match[1]!;
  const fracPart = match[2] ?? "";
  if (fracPart.length > exponent) {
    const trailing = fracPart.slice(exponent);
    if (!/^0+$/u.test(trailing)) {
      return null;
    }
  }
  const paddedFrac = fracPart.slice(0, exponent).padEnd(exponent, "0");
  const minor = BigInt(`${wholePart}${paddedFrac}`);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

/** Extracts the `page_info` cursor for `rel="next"` from a Shopify `Link` header. */
export function parseShopifyNextPageCursor(
  linkHeader: string | null | undefined,
  expectedOrigin: string,
): string | null {
  if (!linkHeader || typeof linkHeader !== "string") {
    return null;
  }
  const segments = linkHeader.split(",");
  for (const segment of segments) {
    const match = /<([^>]+)>\s*;\s*rel=["']?next["']?/iu.exec(segment.trim());
    if (!match) continue;
    let parsed: URL;
    try {
      parsed = new URL(match[1]!);
    } catch {
      return null;
    }
    if (parsed.origin !== expectedOrigin) {
      return null;
    }
    const pageInfo = parsed.searchParams.get("page_info");
    if (pageInfo && SAFE_CURSOR_PATTERN.test(pageInfo)) {
      return pageInfo;
    }
    return null;
  }
  return null;
}

function mapHardenedFetchError(
  error: HardenedFetchError,
  cooldown: RetryAfterCooldown,
): ShopifyTransportError {
  if (error.kind === "timeout") {
    return new ShopifyTransportError({
      kind: "timeout",
      diagnosticCode: "SHOPIFY_TIMEOUT",
      httpStatus: null,
    });
  }
  if (error.kind === "http_error") {
    const status = error.status ?? 500;
    if (status === 401 || status === 403) {
      return new ShopifyTransportError({
        kind: "authentication_failed",
        diagnosticCode: "SHOPIFY_AUTH_FAILED",
        httpStatus: status,
      });
    }
    if (status === 429) {
      const retryAfterSeconds = cooldown.recordRetryAfter(error.retryAfterSeconds ?? 1) ?? 1;
      return new ShopifyTransportError({
        kind: "rate_limited",
        diagnosticCode: "SHOPIFY_RATE_LIMITED",
        httpStatus: 429,
        retryAfterSeconds,
      });
    }
    if (status >= 500) {
      return new ShopifyTransportError({
        kind: "provider_unavailable",
        diagnosticCode: `SHOPIFY_HTTP_${status}`,
        httpStatus: status,
      });
    }
    return new ShopifyTransportError({
      kind: "provider_error",
      diagnosticCode: `SHOPIFY_HTTP_${status}`,
      httpStatus: status,
    });
  }
  if (error.kind === "origin_rejected") {
    return new ShopifyTransportError({
      kind: "config_error",
      diagnosticCode: "SHOPIFY_ORIGIN_REJECTED",
      httpStatus: null,
    });
  }
  if (error.kind === "malformed_json" || error.kind === "body_too_large") {
    return new ShopifyTransportError({
      kind: "provider_unavailable",
      diagnosticCode: "SHOPIFY_MALFORMED_RESPONSE",
      httpStatus: error.status ?? null,
    });
  }
  return new ShopifyTransportError({
    kind: "provider_unavailable",
    diagnosticCode: "SHOPIFY_NETWORK_ERROR",
    httpStatus: null,
  });
}

/**
 * Zero-SDK hardened HTTP client for Shopify Admin REST API.
 * Enforces strict `shopDomain` validation, HTTPS origin pinning,
 * `Retry-After` cooldowns, `redirect: "error"`, bounded reads, and redacted diagnostics.
 */
export function createShopifyHttpClient(config: ShopifyHttpClientConfig): ShopifyAdminClient {
  const { origin } = assertValidShopifyShopDomain(config.shopDomain);
  if (typeof config.fetchImpl !== "function") {
    throw new Error("Shopify HTTP client requires an explicit fetchImpl");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid Shopify timeoutMs");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Invalid Shopify maxResponseBytes");
  }
  if (typeof config.accessToken !== "function") {
    assertValidShopifyAccessToken(config.accessToken);
  }

  const readToken = (): string => {
    const raw = typeof config.accessToken === "function" ? config.accessToken() : config.accessToken;
    return assertValidShopifyAccessToken(raw);
  };

  const cooldown =
    config.cooldown ?? createRetryAfterCooldown(config.clock ? { clock: config.clock } : undefined);

  const hardenedFetch = createHardenedFetch({
    allowedOrigins: [origin],
    fetchImpl: config.fetchImpl as typeof fetch,
    timeoutMs,
    maxResponseBytes,
    ...(config.clock ? { clock: config.clock } : {}),
  });

  return {
    async listOrders(input: ShopifyListOrdersInput): Promise<ShopifyListOrdersPage> {
      if (cooldown.isCoolingDown()) {
        throw new ShopifyTransportError({
          kind: "rate_limited",
          diagnosticCode: "SHOPIFY_COOLDOWN_ACTIVE",
          httpStatus: 429,
          retryAfterSeconds: Math.max(1, cooldown.remainingSeconds()),
        });
      }

      const token = readToken();
      const clampedLimit = Math.min(Math.max(1, Math.trunc(input.limit || 50)), 250);
      const url = new URL(`${origin}/admin/api/${SHOPIFY_API_VERSION}/orders.json`);
      url.searchParams.set("limit", String(clampedLimit));

      if (input.cursor) {
        if (!SAFE_CURSOR_PATTERN.test(input.cursor)) {
          throw new ShopifyTransportError({
            kind: "provider_error",
            diagnosticCode: "SHOPIFY_INVALID_CURSOR",
            httpStatus: null,
          });
        }
        url.searchParams.set("page_info", input.cursor);
      } else {
        url.searchParams.set("status", "any");
        url.searchParams.set("financial_status", "paid");
        if (input.since) {
          url.searchParams.set("created_at_min", input.since);
        }
      }

      try {
        const res = await hardenedFetch.fetchJson<unknown>(url.toString(), {
          method: "GET",
          headers: {
            "x-shopify-access-token": token,
            accept: "application/json",
          },
          ...(input.signal ? { signal: input.signal } : {}),
        });

        const data = res.data;
        if (
          !data
          || typeof data !== "object"
          || Array.isArray(data)
          || !Array.isArray((data as Record<string, unknown>).orders)
        ) {
          throw new ShopifyTransportError({
            kind: "provider_unavailable",
            diagnosticCode: "SHOPIFY_MALFORMED_RESPONSE",
            httpStatus: res.status,
          });
        }

        const nextCursor = parseShopifyNextPageCursor(res.headers.get("link"), origin);
        return {
          orders: (data as { orders: readonly ShopifyOrderResource[] }).orders,
          nextCursor,
        };
      } catch (error) {
        if (error instanceof ShopifyTransportError) throw error;
        if (error instanceof HardenedFetchError) {
          throw mapHardenedFetchError(error, cooldown);
        }
        throw new ShopifyTransportError({
          kind: "provider_unavailable",
          diagnosticCode: "SHOPIFY_NETWORK_ERROR",
          httpStatus: null,
        });
      }
    },
  };
}
