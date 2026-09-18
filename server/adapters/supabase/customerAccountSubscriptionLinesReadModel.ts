import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerAccountV2Response } from "../../../src/domains/customers/accountV2Contracts.js";
import {
  customerLineDisplayFields,
  resolveSubscriptionLineProductSlug,
} from "../../domains/customers/customerLineDisplayFields.js";

type Row = Record<string, unknown>;
type SubscriptionLines = CustomerAccountV2Response["subscriptions"][number]["lines"];

export async function readSubscriptionLines(serviceClient: SupabaseClient, subscriptionIds: string[]) {
  const map = new Map<string, SubscriptionLines>();
  if (subscriptionIds.length === 0) return map;
  const { data, error } = await serviceClient
    .from("subscription_lines")
    .select("id, subscription_id, variant_id, qty, sort_order, is_addon, line_metadata")
    .in("subscription_id", subscriptionIds)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as Row[];
  const skuMap = await readSkuMap(serviceClient, rows.map((row) => text(row.variant_id)));
  for (const row of rows) {
    const subscriptionId = text(row.subscription_id);
    const sku = skuMap.get(text(row.variant_id));
    const metadata = isRecord(row.line_metadata) ? row.line_metadata : {};
    const title = sku?.title ?? nullableText(metadata.title);
    const recipeName = nullableText(metadata.recipeName) ?? nullableText(metadata.recipe_name);
    const productSlug = resolveSubscriptionLineProductSlug({
      skuProductSlug: sku?.productSlug ?? null,
      metadata,
      title,
      recipeName,
    });
    const lines = map.get(subscriptionId) ?? [];
    lines.push({
      lineId: text(row.id),
      variantId: text(row.variant_id),
      qty: Number(row.qty),
      sortOrder: Number(row.sort_order),
      isAddon: Boolean(row.is_addon),
      title,
      sku: sku?.sku ?? null,
      recipeName,
      // The paths stop one segment SHORT of `amountMinor` on purpose: the frozen
      // quote line stores each price as a `commerceMoneySchema` object, so the
      // currency is a sibling key of the amount. Walking past it to the number and
      // then re-asserting a currency was throwing away the line's own answer.
      unitPrice: moneyFromPath(metadata, ["productSnapshot", "quoteLine", "unitPriceGross"]),
      lineSubtotal: moneyFromPath(metadata, ["productSnapshot", "quoteLine", "lineSubtotalGross"]),
      ...customerLineDisplayFields(productSlug),
    });
    map.set(subscriptionId, lines);
  }
  return map;
}

async function readSkuMap(serviceClient: SupabaseClient, skuIds: string[]) {
  const ids = Array.from(new Set(skuIds.filter(Boolean)));
  const map = new Map<string, { sku: string; title: string; productSlug: string | null }>();
  if (ids.length === 0) return map;
  // The FK hint is load-bearing: since 20260827220000 added
  // catalog_products_primary_sku_same_product_fkey, this table pair has two
  // relationships and PostgREST rejects an unhinted embed with PGRST201.
  const { data, error } = await serviceClient
    .from("catalog_skus")
    .select("id, sku, title, catalog_products!catalog_skus_product_id_fkey(slug)")
    .in("id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    const product = isRecord(row.catalog_products) ? row.catalog_products : {};
    map.set(text(row.id), { sku: text(row.sku), title: text(row.title), productSlug: nullableText(product.slug) });
  }
  return map;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Reads a frozen money object out of the line's stored snapshot - **amount and
 * currency together**, because that is how the snapshot wrote them.
 *
 * These are the prices the renewal engine will actually charge, frozen at the moment
 * the customer agreed to them. Their currency is a property of that agreement and not
 * of the deployment reading it back, so it comes off the stored object rather than
 * from a settlement profile.
 *
 * Fails closed to `null` on anything it cannot read whole: a missing object, a
 * non-integral or negative amount, **or an absent/malformed currency**. That is
 * deliberately the same answer the function already gave for a missing amount, and
 * `recurringPrice` already treats a null line as "unpriced" and shows no price at all.
 * A price with an unknown denomination is exactly as unusable as no price, and showing
 * it under a guessed currency is the one outcome worse than showing nothing.
 */
function moneyFromPath(value: Row, path: string[]) {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  if (!isRecord(current)) return null;
  const amountMinor = current.amountMinor;
  const currency = current.currency;
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor) || amountMinor < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amountMinor: Math.trunc(amountMinor), currency };
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
