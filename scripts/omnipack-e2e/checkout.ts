import type { ConfiguratorIntent } from "../../src/domains/commerce/configuratorIntentContracts.ts";
import { checkoutResponseSchema } from "../../src/domains/commerce/checkoutContracts.ts";
import { bffResponseSchema } from "../../src/lib/bff/contracts.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseOfferAvailabilityPortFromClient } from "../../server/adapters/supabase/commerce/offerAvailability.ts";

// Drives the REAL checkout BFF (W4): POST /api/bff/commerce/checkout with the configurator
// intent + paymentProvider "stripe". This is the path a real customer order takes — NOT a
// metadata-seeded order — so it proves the W1 keystone (selectedDelivery persists →
// OmniPack routing) end to end.

export interface CheckoutResult {
  status: number;
  orderId: string | null;
  orderRef: string | null;
  orderStatus: string | null;
  paymentIntentId: string | null;
  providerPaymentId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  errorCode: string | null;
  errorStage: string | null;
  body: Record<string, unknown>;
}

interface CatalogVariantQuery {
  select(columns: string): CatalogVariantQuery;
  eq(column: string, value: unknown): CatalogVariantQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { code?: string } | null }>;
}

export async function readActiveCatalogVariantId(
  admin: { from(table: string): CatalogVariantQuery },
  sku: string,
): Promise<{ variantId: string | null; productSlug: string | null; readErrorCode: string | null }> {
  // The FK hint is load-bearing: since 20260827220000 added
  // catalog_products_primary_sku_same_product_fkey, this table pair has two
  // relationships and PostgREST rejects an unhinted embed with PGRST201. !inner
  // is a cardinality modifier, not a relationship hint, and does not disambiguate.
  const { data, error } = await admin.from("catalog_skus")
    .select("id,catalog_products!catalog_skus_product_id_fkey!inner(slug,status)")
    .eq("sku", sku)
    .eq("status", "active")
    .eq("catalog_products.status", "active")
    .maybeSingle();
  if (error) return { variantId: null, productSlug: null, readErrorCode: error.code ?? "unknown" };
  return { variantId: text(data?.id), productSlug: text(record(data?.catalog_products).slug), readErrorCode: null };
}

export async function checkOmnipackCheckoutStock(
  client: SupabaseClient,
  input: { sku: string; productSlug: string; variantId: string; requestedQuantity: number },
): Promise<{ ok: boolean; reasonCode: string; sellableNow: number | null }> {
  const [availability] = await createSupabaseOfferAvailabilityPortFromClient(client).getAvailability({
    items: [{ ...input, checkoutMode: "one_time" }],
  });
  const ok = availability?.source === "inventory_provider"
    && ["available", "low_stock"].includes(availability.status)
    && availability.sellableNow !== null
    && availability.sellableNow >= input.requestedQuantity;
  return { ok, reasonCode: availability?.reasonCode ?? "availability_missing", sellableNow: availability?.sellableNow ?? null };
}

export function resumedPaymentIdentity(rows: Record<string, unknown>[]): {
  paymentIntentId: string;
  providerPaymentId: string;
} | null {
  if (rows.length !== 1) return null;
  const paymentIntentId = text(rows[0]?.id);
  const providerPaymentId = text(rows[0]?.provider_payment_id);
  return paymentIntentId && providerPaymentId ? { paymentIntentId, providerPaymentId } : null;
}

export function buildCheckoutBody(intent: ConfiguratorIntent): Record<string, unknown> {
  return { intent, paymentProvider: "stripe", invoicePreference: { kind: "b2c_named" } };
}

export function parseCheckoutResponse(status: number, body: Record<string, unknown>): CheckoutResult {
  const parsed = bffResponseSchema(checkoutResponseSchema).safeParse(body);
  const envelope = parsed.success ? parsed.data : null;
  const success = status === 200 && envelope?.ok === true;
  const data = success ? record(envelope.data) : {};
  const clientAction = record(data.clientAction);
  const error = envelope?.ok === false ? record(envelope.error) : {};
  const errorDetails = record(error.details);
  return {
    status,
    orderId: text(data.orderId),
    orderRef: text(data.orderRef),
    orderStatus: text(data.status),
    paymentIntentId: text(data.paymentIntentId),
    providerPaymentId: text(data.providerPaymentId),
    clientId: text(data.clientId),
    clientSecret: text(clientAction.clientSecret),
    errorCode: text(error.code) ?? (success ? null : "INVALID_RESPONSE"),
    errorStage: text(errorDetails.stage),
    body,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function placeCheckout(args: {
  baseUrl: string;
  intent: ConfiguratorIntent;
  bypassToken?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<CheckoutResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.bypassToken) headers["x-vercel-protection-bypass"] = args.bypassToken;
  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/bff/commerce/checkout`;
  const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(buildCheckoutBody(args.intent)) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return parseCheckoutResponse(res.status, body);
}
