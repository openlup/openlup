import { createHash } from "node:crypto";
import {
  CHANNEL_ORDER_CONTRACT_VERSION,
  CHANNEL_ORDER_PAID_EXTERNALLY_STATE,
  normalizedChannelOrderSchema,
  type NormalizedChannelOrder,
  type NormalizedChannelOrderLine,
  type UnmappedChannelSignal,
} from "@openlup/platform/channels";
import type {
  ChannelConnectorCapabilities,
  ChannelConnectorPort,
  ChannelOrderSourcePort,
  NormalizedWebhookResult,
} from "@openlup/platform/channels/contracts";
import {
  MAX_WEBHOOK_BODY_BYTES,
  verifyHmacSha256,
} from "@openlup/platform/adapter-kit";
import {
  assertValidShopifyShopDomain,
  parseShopifyDecimalToMinor,
  type ShopifyAdminClient,
  type ShopifyOrderResource,
} from "./client-contract.js";

export interface ShopifyChannelAdapterConfig {
  /** Narrow structural Admin client (use createShopifyHttpClient for zero-SDK REST). */
  client: ShopifyAdminClient;
  /** Bare Shopify shop subdomain (e.g. "acme-store"). */
  shopDomain: string;
  /** OpenLup channel slug stamped on normalized orders (e.g. "shopify-us"). */
  channelSlug: string;
  /** One or more Shopify webhook HMAC shared secrets (supports key rotation). */
  webhookSecrets: readonly string[];
  maxWebhookBodyBytes?: number;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;

/** Static protocol capability descriptor; cross-checked against recipe.json#staticCapabilities. */
export const shopifyChannelCapabilities: Readonly<ChannelConnectorCapabilities> =
  Object.freeze<ChannelConnectorCapabilities>({
    connectorKind: "shopify",
    connectorShape: "direct",
    supportsChannelDiscovery: false,
    supportsOrderPull: true,
    supportsOrderWebhook: true,
    supportsOrderAck: false,
    supportsListingLink: false,
    supportsStockPush: false,
    supportsPricePush: false,
    supportsShipmentPush: false,
    correlation: Object.freeze({
      orderRefField: "id",
      customerRefField: "customer.id",
      customerRefNullMeans: "per_order_identity",
      emailIsAlwaysMasked: false,
    }),
  });

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function normalizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function nonEmptyOrNull(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null;
}

function parseTaxRateBps(order: ShopifyOrderResource, taxLines: ShopifyOrderResource["line_items"][number]["tax_lines"]): number | null {
  if (!order.taxes_included) return null;
  if (!Array.isArray(taxLines) || taxLines.length === 0) return null;
  let totalBps = 0;
  for (const taxLine of taxLines) {
    if (taxLine?.rate === null || taxLine?.rate === undefined) continue;
    const rateNum = typeof taxLine.rate === "number" ? taxLine.rate : Number(taxLine.rate);
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 1) return null;
    totalBps += Math.round(rateNum * 10_000);
  }
  return totalBps >= 0 && totalBps <= 10_000 ? totalBps : null;
}

function buildUnmappedSignal(input: {
  vocabulary: string;
  externalOrderRef: string | null;
  detail: string;
  payload: Record<string, unknown>;
}): UnmappedChannelSignal {
  return {
    vocabulary: input.vocabulary.slice(0, 200),
    externalOrderRef: input.externalOrderRef,
    detail: input.detail.slice(0, 500),
    payload: input.payload,
  };
}

type OrderNormalizationOutcome =
  | { kind: "ok"; order: NormalizedChannelOrder }
  | { kind: "unmapped"; signal: UnmappedChannelSignal };

function normalizeShopifyOrder(input: {
  rawOrder: Record<string, unknown>;
  channelSlug: string;
  providerEventId: string;
  payloadDigest: string;
}): OrderNormalizationOutcome {
  const raw = input.rawOrder as unknown as ShopifyOrderResource;
  const externalOrderRef =
    raw.id !== undefined && raw.id !== null && String(raw.id).trim().length > 0
      ? String(raw.id).trim().slice(0, 128)
      : null;

  if (!externalOrderRef) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "missing_order_id",
        externalOrderRef: null,
        detail: "Shopify order payload missing id",
        payload: { keys: Object.keys(input.rawOrder) },
      }),
    };
  }

  const financialStatus =
    typeof raw.financial_status === "string" ? raw.financial_status.trim() : "missing_financial_status";
  if (financialStatus !== "paid") {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: financialStatus || "missing_financial_status",
        externalOrderRef,
        detail: "Shopify financial_status is not paid",
        payload: { financial_status: raw.financial_status ?? null },
      }),
    };
  }

  const currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  if (!CURRENCY_PATTERN.test(currency)) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: currency || "invalid_currency",
        externalOrderRef,
        detail: "Invalid or unsupported currency on Shopify order",
        payload: { currency: raw.currency ?? null },
      }),
    };
  }

  const placedAt = normalizeIsoTimestamp(raw.created_at);
  const paidAt = normalizeIsoTimestamp(raw.processed_at ?? raw.created_at);
  if (!placedAt || !paidAt) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "invalid_timestamp",
        externalOrderRef,
        detail: "Invalid Shopify order timestamp",
        payload: { created_at: raw.created_at ?? null },
      }),
    };
  }

  const addr = raw.shipping_address ?? raw.billing_address;
  const countryCode = typeof addr?.country_code === "string" ? addr.country_code.trim().toUpperCase() : "";
  const line1 = nonEmptyOrNull(addr?.address1, 200);
  const postalCode = nonEmptyOrNull(addr?.zip, 20);
  const city = nonEmptyOrNull(addr?.city, 120);
  const recipientName =
    nonEmptyOrNull(addr?.name, 200)
    ?? nonEmptyOrNull([addr?.first_name, addr?.last_name].filter(Boolean).join(" "), 200);

  if (!recipientName || !line1 || !postalCode || !city || !COUNTRY_PATTERN.test(countryCode)) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "incomplete_shipping_address",
        externalOrderRef,
        detail: "Shopify order missing required shipping address fields",
        payload: { country_code: addr?.country_code ?? null },
      }),
    };
  }

  if (!Array.isArray(raw.line_items) || raw.line_items.length === 0) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "empty_line_items",
        externalOrderRef,
        detail: "Shopify order has no line_items",
        payload: {},
      }),
    };
  }

  const normalizedLines: NormalizedChannelOrderLine[] = [];
  let itemsGrossBig = 0n;
  let itemsDiscountBig = 0n;

  for (const item of raw.line_items) {
    if (!item || typeof item !== "object") {
      return {
        kind: "unmapped",
        signal: buildUnmappedSignal({
          vocabulary: "malformed_line_item",
          externalOrderRef,
          detail: "Malformed line item",
          payload: {},
        }),
      };
    }
    const lineRef =
      item.id !== undefined && item.id !== null && String(item.id).trim().length > 0
        ? String(item.id).trim().slice(0, 128)
        : null;
    if (!lineRef || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      return {
        kind: "unmapped",
        signal: buildUnmappedSignal({
          vocabulary: "invalid_line_quantity",
          externalOrderRef,
          detail: "Invalid line item id or quantity",
          payload: { lineId: item.id ?? null, quantity: item.quantity ?? null },
        }),
      };
    }

    const unitGrossMinor = parseShopifyDecimalToMinor(item.price, currency);
    if (unitGrossMinor === null) {
      return {
        kind: "unmapped",
        signal: buildUnmappedSignal({
          vocabulary: "invalid_line_price",
          externalOrderRef,
          detail: "Invalid line item price decimal",
          payload: { lineId: lineRef },
        }),
      };
    }

    const lineGrossBig = BigInt(unitGrossMinor) * BigInt(item.quantity);
    let lineDiscountBig = 0n;
    if (typeof item.total_discount === "string" && item.total_discount.trim().length > 0) {
      const parsedDisc = parseShopifyDecimalToMinor(item.total_discount, currency);
      if (parsedDisc === null) {
        return {
          kind: "unmapped",
          signal: buildUnmappedSignal({
            vocabulary: "invalid_line_discount",
            externalOrderRef,
            detail: "Invalid line item total_discount",
            payload: { lineId: lineRef },
          }),
        };
      }
      lineDiscountBig = BigInt(parsedDisc);
    } else if (Array.isArray(item.discount_allocations)) {
      for (const alloc of item.discount_allocations) {
        const parsedAlloc = parseShopifyDecimalToMinor(alloc?.amount, currency);
        if (parsedAlloc === null) {
          return {
            kind: "unmapped",
            signal: buildUnmappedSignal({
              vocabulary: "invalid_discount_allocation",
              externalOrderRef,
              detail: "Invalid discount allocation amount",
              payload: { lineId: lineRef },
            }),
          };
        }
        lineDiscountBig += BigInt(parsedAlloc);
      }
    }

    if (
      lineGrossBig > BigInt(Number.MAX_SAFE_INTEGER)
      || lineDiscountBig > lineGrossBig
    ) {
      return {
        kind: "unmapped",
        signal: buildUnmappedSignal({
          vocabulary: "line_money_overflow",
          externalOrderRef,
          detail: "Line discount exceeds gross or overflows safe integer",
          payload: { lineId: lineRef },
        }),
      };
    }

    itemsGrossBig += lineGrossBig;
    itemsDiscountBig += lineDiscountBig;

    const externalOfferRef =
      item.variant_id !== null && item.variant_id !== undefined
        ? String(item.variant_id).trim().slice(0, 128)
        : item.product_id !== null && item.product_id !== undefined
          ? String(item.product_id).trim().slice(0, 128)
          : null;

    normalizedLines.push({
      externalLineRef: lineRef,
      sellable: {
        kind: "sku",
        externalOfferRef: externalOfferRef && externalOfferRef.length > 0 ? externalOfferRef : null,
        skuCode: nonEmptyOrNull(item.sku, 64),
      },
      quantity: item.quantity,
      unitGrossMinor,
      lineGrossMinor: Number(lineGrossBig),
      lineDiscountMinor: Number(lineDiscountBig),
      vatRateBps: parseTaxRateBps(raw, item.tax_lines),
    });
  }

  let shippingGrossBig = 0n;
  let shippingDiscountBig = 0n;
  const shippingLines = Array.isArray(raw.shipping_lines) ? raw.shipping_lines : [];
  for (const sLine of shippingLines) {
    const gross = parseShopifyDecimalToMinor(sLine?.price, currency);
    if (gross === null) {
      return {
        kind: "unmapped",
        signal: buildUnmappedSignal({
          vocabulary: "invalid_shipping_price",
          externalOrderRef,
          detail: "Invalid shipping line price",
          payload: {},
        }),
      };
    }
    shippingGrossBig += BigInt(gross);

    if (Array.isArray(sLine.discount_allocations) && sLine.discount_allocations.length > 0) {
      for (const alloc of sLine.discount_allocations) {
        const d = parseShopifyDecimalToMinor(alloc?.amount, currency);
        if (d === null) {
          return {
            kind: "unmapped",
            signal: buildUnmappedSignal({
              vocabulary: "invalid_shipping_discount",
              externalOrderRef,
              detail: "Invalid shipping discount allocation",
              payload: {},
            }),
          };
        }
        shippingDiscountBig += BigInt(d);
      }
    } else if (typeof sLine.discounted_price === "string") {
      const discounted = parseShopifyDecimalToMinor(sLine.discounted_price, currency);
      if (discounted === null || discounted > gross) {
        return {
          kind: "unmapped",
          signal: buildUnmappedSignal({
            vocabulary: "invalid_shipping_discounted_price",
            externalOrderRef,
            detail: "Invalid shipping discounted_price",
            payload: {},
          }),
        };
      }
      shippingDiscountBig += BigInt(gross - discounted);
    }
  }

  const grandTotalBig = itemsGrossBig - itemsDiscountBig + shippingGrossBig - shippingDiscountBig;
  if (
    itemsGrossBig > BigInt(Number.MAX_SAFE_INTEGER)
    || itemsDiscountBig > BigInt(Number.MAX_SAFE_INTEGER)
    || shippingGrossBig > BigInt(Number.MAX_SAFE_INTEGER)
    || shippingDiscountBig > BigInt(Number.MAX_SAFE_INTEGER)
    || grandTotalBig <= 0n
    || grandTotalBig > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "order_total_invalid",
        externalOrderRef,
        detail: "Computed order grand total is non-positive or overflows safe integer",
        payload: {},
      }),
    };
  }

  const wireTotalMinor = parseShopifyDecimalToMinor(raw.total_price, currency);
  if (wireTotalMinor === null || BigInt(wireTotalMinor) !== grandTotalBig) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "money_mismatch",
        externalOrderRef,
        detail: "Shopify total_price does not match tax-inclusive normalized order sum",
        payload: { total_price: raw.total_price ?? null },
      }),
    };
  }

  const firstShipping = shippingLines[0];
  const externalCustomerRef =
    raw.customer?.id !== null && raw.customer?.id !== undefined
      ? nonEmptyOrNull(String(raw.customer.id), 128)
      : null;

  const candidate: NormalizedChannelOrder = {
    contractVersion: CHANNEL_ORDER_CONTRACT_VERSION,
    channelSlug: input.channelSlug,
    externalOrderRef,
    externalOrderRevision: normalizeIsoTimestamp(raw.updated_at) ?? placedAt,
    providerEventId: input.providerEventId,
    placedAt,
    currency,
    buyer: {
      externalCustomerRef,
      email: nonEmptyOrNull(raw.customer?.email ?? raw.email, 320),
      emailIsMasked: false,
      firstName: nonEmptyOrNull(raw.customer?.first_name ?? addr?.first_name, 120),
      lastName: nonEmptyOrNull(raw.customer?.last_name ?? addr?.last_name, 120),
      phone: nonEmptyOrNull(raw.customer?.phone ?? raw.phone ?? addr?.phone, 40),
      taxId: null,
      companyName: nonEmptyOrNull(addr?.company, 200),
    },
    shipTo: {
      recipientName,
      line1,
      line2: nonEmptyOrNull(addr?.address2, 200),
      postalCode,
      city,
      countryCode,
      phone: nonEmptyOrNull(addr?.phone, 40),
      pickupPointRef: null,
    },
    lines: normalizedLines,
    shipping: {
      grossMinor: Number(shippingGrossBig),
      discountMinor: Number(shippingDiscountBig),
      methodLabel: nonEmptyOrNull(firstShipping?.title, 120),
      carrierHint: nonEmptyOrNull(firstShipping?.code ?? firstShipping?.source, 64),
    },
    totals: {
      itemsGrossMinor: Number(itemsGrossBig),
      itemsDiscountMinor: Number(itemsDiscountBig),
      shippingGrossMinor: Number(shippingGrossBig),
      shippingDiscountMinor: Number(shippingDiscountBig),
      grandTotalMinor: Number(grandTotalBig),
    },
    payment: {
      state: CHANNEL_ORDER_PAID_EXTERNALLY_STATE,
      externalPaymentRef:
        raw.checkout_id !== null && raw.checkout_id !== undefined
          ? `shopify:checkout:${String(raw.checkout_id).trim()}`
          : `shopify:order:${externalOrderRef}`,
      paidAt,
      methodLabel: nonEmptyOrNull(raw.payment_gateway_names?.[0], 64),
    },
    payloadDigest: input.payloadDigest,
  };

  const validated = normalizedChannelOrderSchema.safeParse(candidate);
  if (!validated.success) {
    return {
      kind: "unmapped",
      signal: buildUnmappedSignal({
        vocabulary: "schema_validation_failed",
        externalOrderRef,
        detail: validated.error.issues[0]?.message ?? "Normalized order failed schema check",
        payload: {},
      }),
    };
  }

  return { kind: "ok", order: validated.data };
}

const IGNORED_TOPICS = new Set([
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
  "inventory_items/update",
  "shop/update",
  "app/uninstalled",
  "collections/update",
]);

/**
 * Explicit factory for the Shopify ChannelConnectorPort (and ChannelOrderSourcePort).
 * Importing this module performs zero I/O, reads zero environment variables,
 * and registers no routes, schedules, or global state.
 */
export function createShopifyChannelAdapter(
  config: ShopifyChannelAdapterConfig,
): ChannelConnectorPort {
  const { shopDomain } = assertValidShopifyShopDomain(config.shopDomain);
  if (!SLUG_PATTERN.test(config.channelSlug)) {
    throw new Error("Invalid Shopify channelSlug");
  }
  if (
    !Array.isArray(config.webhookSecrets)
    || config.webhookSecrets.length === 0
    || !config.webhookSecrets.every((s) => typeof s === "string" && s.length > 0)
  ) {
    throw new Error("Shopify adapter requires at least one non-empty webhookSecret");
  }
  const maxWebhookBodyBytes = config.maxWebhookBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;
  if (!Number.isSafeInteger(maxWebhookBodyBytes) || maxWebhookBodyBytes <= 0) {
    throw new Error("Invalid Shopify maxWebhookBodyBytes");
  }
  const secrets = Object.freeze([...config.webhookSecrets]);
  const expectedShopHeader = `${shopDomain}.myshopify.com`;

  const orders: ChannelOrderSourcePort = {
    async listChannelBindings() {
      return [];
    },

    async pullOrders(input) {
      const page = await config.client.listOrders({
        since: input.since,
        cursor: input.cursor,
        limit: input.limit,
        signal: input.signal,
      });

      const normalizedOrders: NormalizedChannelOrder[] = [];
      const unmapped: UnmappedChannelSignal[] = [];
      let latestWatermark: string | null = null;

      for (const rawOrder of page.orders) {
        if (!rawOrder || typeof rawOrder !== "object" || Array.isArray(rawOrder)) {
          unmapped.push(
            buildUnmappedSignal({
              vocabulary: "malformed_order_record",
              externalOrderRef: null,
              detail: "Non-object entry in Shopify orders list",
              payload: {},
            }),
          );
          continue;
        }
        const canonical = JSON.stringify(rawOrder);
        const digest = sha256Hex(canonical);
        const orderId = rawOrder.id !== undefined ? String(rawOrder.id) : digest.slice(0, 16);
        const revision = normalizeIsoTimestamp(rawOrder.updated_at) ?? normalizeIsoTimestamp(rawOrder.created_at);
        const providerEventId = `shopify:pull:${orderId}:${revision ?? digest.slice(0, 16)}`;

        const mapped = normalizeShopifyOrder({
          rawOrder: rawOrder as unknown as Record<string, unknown>,
          channelSlug: config.channelSlug,
          providerEventId,
          payloadDigest: digest,
        });
        if (mapped.kind === "ok") {
          normalizedOrders.push(mapped.order);
          const candidateWatermark = mapped.order.externalOrderRevision ?? mapped.order.placedAt;
          if (!latestWatermark || candidateWatermark > latestWatermark) {
            latestWatermark = candidateWatermark;
          }
        } else {
          unmapped.push(mapped.signal);
        }
      }

      return {
        orders: normalizedOrders,
        unmapped,
        nextCursor: page.nextCursor,
        watermarkAt: latestWatermark,
      };
    },

    async normalizeWebhook(input): Promise<NormalizedWebhookResult> {
      const headers = normalizeHeaders(input.headers);
      if (Buffer.byteLength(input.rawBody, "utf8") > maxWebhookBodyBytes) {
        return { kind: "rejected", reason: "malformed" };
      }

      // Auth-before-parse: verify X-Shopify-Hmac-Sha256 over untouched rawBody BEFORE JSON.parse.
      const signature = headers["x-shopify-hmac-sha256"];
      if (
        !signature
        || !verifyHmacSha256({
          payload: input.rawBody,
          signature,
          secrets,
          encoding: "base64",
        })
      ) {
        return { kind: "rejected", reason: "signature" };
      }

      const shopHeader = headers["x-shopify-shop-domain"];
      if (shopHeader && shopHeader.trim().toLowerCase() !== expectedShopHeader) {
        return { kind: "rejected", reason: "signature" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(input.rawBody);
      } catch {
        return { kind: "rejected", reason: "malformed" };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { kind: "rejected", reason: "malformed" };
      }

      const record = parsed as Record<string, unknown>;
      const topic = headers["x-shopify-topic"]?.trim();
      if (!topic) {
        return { kind: "rejected", reason: "malformed" };
      }

      const payloadDigest = sha256Hex(input.rawBody);
      const externalOrderRef =
        record.id !== undefined && record.id !== null && String(record.id).trim().length > 0
          ? String(record.id).trim().slice(0, 128)
          : null;
      const providerEventId =
        headers["x-shopify-webhook-id"]?.trim()
        || `shopify:${topic}:${externalOrderRef ?? "unknown"}:${payloadDigest.slice(0, 16)}`;

      if (IGNORED_TOPICS.has(topic)) {
        return {
          kind: "ignored",
          providerEventId,
          reason: `ignored_topic:${topic}`,
        };
      }

      if (topic !== "orders/paid") {
        return {
          kind: "unmapped",
          providerEventId,
          signal: buildUnmappedSignal({
            vocabulary: topic,
            externalOrderRef,
            detail: "Unmapped Shopify webhook topic",
            payload: { topic, id: record.id ?? null },
          }),
        };
      }

      const mapped = normalizeShopifyOrder({
        rawOrder: record,
        channelSlug: config.channelSlug,
        providerEventId,
        payloadDigest,
      });

      if (mapped.kind === "unmapped") {
        return {
          kind: "unmapped",
          providerEventId,
          signal: mapped.signal,
        };
      }

      return {
        kind: "order",
        providerEventId,
        order: mapped.order,
      };
    },

    async acknowledgeOrder() {
      return { acknowledged: false };
    },
  };

  return {
    capabilities: shopifyChannelCapabilities,
    orders,
  };
}
