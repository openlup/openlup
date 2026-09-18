import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceQuoteCatalogReadPort } from "../../domains/commerce/commerceQuoteCatalogReadPort.js";
import type { CreateQuoteRequest, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { CommerceMoney } from "../../../src/domains/commerce/types.js";
import type {
  RecipeSetReprice,
  RepricedEditQuote,
  RepricedLine,
  SubscriptionLineRef,
  SubscriptionRepricer,
} from "../../domains/customers/subscriptionRepricePort.js";

export type {
  RecipeSetReprice,
  RepricedEditQuote,
  RepricedLine,
  SubscriptionRepricer,
} from "../../domains/customers/subscriptionRepricePort.js";

/**
 * Data-access + edit helpers backing the subscription repricer. Split out of
 * subscriptionEditReprice.ts to keep each module under the 300-LOC production cap.
 */

/**
 * A current line plus the per-cycle gross the customer is actually charged for
 * it, frozen into `line_metadata.productSnapshot.quoteLine` at activation.
 * `buildSubscriptionCycleSnapshots.ts` bills renewals from exactly this field,
 * so it stays truthful for a line whose SKU has since left the sellable catalog
 * — the one case the live catalog cannot price. Adapter-local on purpose:
 * widening `SubscriptionLineRef` would push an internal pricing detail into the
 * port every repricer consumer reads.
 */
export interface SubscriptionLineSnapshot extends SubscriptionLineRef {
  frozenLineSubtotalGross?: CommerceMoney;
}

export function applyEdit(
  action: string,
  payload: Record<string, unknown>,
  lines: SubscriptionLineRef[],
): SubscriptionLineRef[] | null {
  if (action === "swap_recipe") {
    const fromVariantId = String(payload.fromVariantId ?? "");
    const toVariantId = String(payload.toVariantId ?? "");
    if (!fromVariantId || !toVariantId) return null;
    if (!lines.some((line) => line.variantId === fromVariantId)) return null;
    // Mirror the RPC's duplicate-reject: do NOT merge qty into an existing line.
    return lines.map((line) =>
      line.variantId === fromVariantId ? { ...line, variantId: toVariantId } : line,
    );
  }
  const variantId = String(payload.variantId ?? "");
  if (!variantId) return null;
  if (action === "remove_addon") {
    if (!lines.some((line) => line.variantId === variantId && line.isAddon)) return null;
    return lines.filter((line) => !(line.variantId === variantId && line.isAddon));
  }
  if (action === "update_addon_quantity") {
    if (!lines.some((line) => line.variantId === variantId && line.isAddon)) return null;
    const qty = Math.max(1, Number(payload.qty) || 1);
    return lines.map((line) =>
      line.variantId === variantId && line.isAddon ? { ...line, quantity: qty } : line,
    );
  }
  // add_addon: append the new addon (no lineId yet — the RPC matches it via RETURNING id).
  const qty = Math.max(1, Number(payload.qty) || 1);
  const nextSort = lines.reduce((max, line) => Math.max(max, line.sortOrder), 0) + 1;
  return [...lines, { lineId: null, variantId, quantity: qty, isAddon: true, sortOrder: nextSort }];
}

export async function readSubscription(
  client: SupabaseClient,
  subscriptionId: string,
): Promise<{
  cadenceDays: number;
  sizeConstraint: CreateQuoteRequest["sizeConstraint"];
  templateVersion: number;
}> {
  const { data, error } = await client
    .from("subscriptions")
    .select("cadence_days, size_constraint, template_version")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("subscription_reprice_subscription_not_found");
  const row = data as { cadence_days: number; size_constraint: unknown; template_version: number };
  const templateVersion = Number(row.template_version);
  if (!Number.isInteger(templateVersion) || templateVersion < 1) {
    throw new Error("subscription_reprice_invalid_template_version");
  }
  return {
    cadenceDays: row.cadence_days,
    sizeConstraint: (row.size_constraint as CreateQuoteRequest["sizeConstraint"]) ?? undefined,
    templateVersion,
  };
}

export async function readLines(client: SupabaseClient, subscriptionId: string): Promise<SubscriptionLineSnapshot[]> {
  const { data, error } = await client
    .from("subscription_lines")
    .select("id, variant_id, qty, is_addon, sort_order, line_metadata")
    .eq("subscription_id", subscriptionId)
    .order("sort_order", { ascending: true })
    .order("variant_id", { ascending: true });
  if (error) throw error;
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  return rows.map((row) => ({
    lineId: String(row.id),
    variantId: String(row.variant_id),
    quantity: Number(row.qty),
    isAddon: row.is_addon === true,
    sortOrder: Number(row.sort_order ?? 0),
    ...readFrozenLineSubtotal(row.line_metadata),
  }));
}

function readFrozenLineSubtotal(lineMetadata: unknown): { frozenLineSubtotalGross?: CommerceMoney } {
  const path = ["productSnapshot", "quoteLine", "lineSubtotalGross"];
  const subtotal = path.reduce<Record<string, unknown> | undefined>(
    (node, key) => readRecord(node?.[key]),
    readRecord(lineMetadata),
  );
  const { amountMinor, currency } = subtotal ?? {};
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) return {};
  if (typeof currency !== "string" || !currency) return {};
  return { frozenLineSubtotalGross: { amountMinor, currency: currency as CommerceMoney["currency"] } };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  const isRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : undefined;
}

/**
 * Starts the two independent reads together, while retaining the historic
 * subscription-read error precedence over a concurrent line-read failure.
 */
export async function readSubscriptionAndLines(
  client: SupabaseClient,
  subscriptionId: string,
): Promise<{ subscription: Awaited<ReturnType<typeof readSubscription>>; currentLines: SubscriptionLineSnapshot[] }> {
  const subscriptionPromise = readSubscription(client, subscriptionId);
  const linesPromise = readLines(client, subscriptionId);
  const [subscriptionResult, linesResult] = await Promise.allSettled([
    subscriptionPromise,
    linesPromise,
  ]);
  return {
    subscription: settledValue(subscriptionResult),
    currentLines: settledValue(linesResult),
  };
}

/**
 * Prices the CURRENT package for the account editor's before/after comparison.
 * This is a comparison baseline only: its result reaches `currentRecurringPrice`
 * and `delta` in a preview, never a persisted line.
 *
 * A line whose SKU has left the sellable catalog cannot be quoted, but the
 * customer is still being charged for it, and refusing the whole comparison
 * would weld shut the very editor that removes that line. So still-sellable
 * lines keep their live recurring-band price and retired ones contribute their
 * frozen per-cycle gross. The sum is exact, not an approximation: this
 * repricer's quote port is composed without a settings port and without a promo
 * data port and is called with no promo codes, so shipping and both discount
 * lanes are structurally zero and
 * `totalGross === subtotalGross === sum(lineSubtotalGross)`
 * (`dbBackedCommerceQuotePort.ts`).
 */
export async function readCurrentPackagePrice(
  quotePort: CommerceQuotePort,
  skuByVariant: ReadonlyMap<string, string>,
  input: {
    cadenceDays: number;
    sizeConstraint: CreateQuoteRequest["sizeConstraint"];
    currentLines: readonly SubscriptionLineSnapshot[];
  },
): Promise<CommerceMoney> {
  const sellable: CreateQuoteRequest["lines"] = [];
  const retired: SubscriptionLineSnapshot[] = [];
  for (const line of input.currentLines) {
    const sku = skuByVariant.get(line.variantId);
    if (sku === undefined) retired.push(line);
    else sellable.push({ sku, quantity: line.quantity, modeAtLine: "subscription", isAddon: line.isAddon });
  }
  const frozen = retired.length === 0 ? undefined : sumFrozenLineSubtotals(retired);
  if (sellable.length === 0) {
    if (frozen === undefined) throw new Error("subscription_reprice_current_package_unpriceable");
    return frozen;
  }
  const { quote } = await quotePort.createQuote({
    mode: "subscription",
    cadenceDays: input.cadenceDays,
    sizeConstraint: input.sizeConstraint,
    promoCodes: [],
    lines: sellable,
  });
  if (frozen === undefined) return quote.totalGross;
  const { amountMinor, currency } = quote.totalGross;
  if (frozen.currency !== currency) throw new Error("subscription_reprice_current_package_unpriceable");
  return { amountMinor: amountMinor + frozen.amountMinor, currency };
}

/**
 * Refuses rather than guesses: a retired line with no frozen gross has no
 * truthful price, and a fabricated baseline would misstate the delta on a money
 * surface. The distinct code maps to a 400 with a machine-readable reason, and
 * `remove_addon` / `swap_recipe` still escape without any baseline.
 */
function sumFrozenLineSubtotals(lines: readonly SubscriptionLineSnapshot[]): CommerceMoney {
  let total = 0;
  let currency: CommerceMoney["currency"] | undefined;
  for (const { frozenLineSubtotalGross: frozen } of lines) {
    if (!frozen || (currency !== undefined && currency !== frozen.currency)) {
      throw new Error("subscription_reprice_current_package_unpriceable");
    }
    currency = frozen.currency;
    total += frozen.amountMinor;
  }
  if (currency === undefined) throw new Error("subscription_reprice_current_package_unpriceable");
  return { amountMinor: total, currency };
}

/**
 * Starts the desired recipe-set quote and optional current-package quote
 * together. The desired quote retains historic error precedence.
 */
export async function quoteRecipeSetPrices(input: {
  quotePort: CommerceQuotePort;
  desiredRequest: CreateQuoteRequest;
  skuByVariant: ReadonlyMap<string, string>;
  currentPackage?: {
    cadenceDays: number;
    sizeConstraint: CreateQuoteRequest["sizeConstraint"];
    currentLines: readonly SubscriptionLineSnapshot[];
  };
}): Promise<{ quote: CreateQuoteResponse["quote"]; currentRecurringPrice?: CommerceMoney }> {
  const desiredQuotePromise = input.quotePort.createQuote(input.desiredRequest);
  const currentPricePromise = input.currentPackage
    ? readCurrentPackagePrice(input.quotePort, input.skuByVariant, input.currentPackage)
    : Promise.resolve(undefined);
  const [desiredResult, currentPriceResult] = await Promise.allSettled([
    desiredQuotePromise,
    currentPricePromise,
  ]);
  const { quote } = settledValue(desiredResult);
  const currentRecurringPrice = settledValue(currentPriceResult);
  return currentRecurringPrice === undefined ? { quote } : { quote, currentRecurringPrice };
}

export function buildSubscriptionQuoteRequest(input: {
  skuByVariant: ReadonlyMap<string, string>;
  cadenceDays: number;
  sizeConstraint: CreateQuoteRequest["sizeConstraint"];
  lines: Array<{ variantId: string; quantity: number; isAddon: boolean }>;
}): CreateQuoteRequest {
  return {
    mode: "subscription",
    cadenceDays: input.cadenceDays,
    sizeConstraint: input.sizeConstraint,
    promoCodes: [],
    lines: input.lines.map((line) => {
      const sku = input.skuByVariant.get(line.variantId);
      if (!sku) throw new Error(`subscription_reprice_unknown_variant:${line.variantId}`);
      return { sku, quantity: line.quantity, modeAtLine: "subscription", isAddon: line.isAddon };
    }),
  };
}

/**
 * Strict subscription-sellable map: the D1 source is active-only and this drops
 * anything not sellable on subscription, so a retired SKU resolves to nothing.
 *
 * ⛔ Do NOT reintroduce a pre-edit assertion over the subscription's CURRENT
 * lines. Every line an edit actually keeps is looked up against this map right
 * before it is quoted — the post-edit map in `subscriptionEditReprice.ts`,
 * `buildSubscriptionQuoteRequest`, and `quotePackageEdit` — and each throws
 * `subscription_reprice_unknown_variant`. A guard over the pre-edit lines adds
 * no protection and only refuses the edits that would REMOVE the retired line,
 * locking the owner out of the one surface that can fix their subscription.
 */
export async function buildSkuMap(quoteCatalogReadPort: CommerceQuoteCatalogReadPort): Promise<Map<string, string>> {
  const items = await quoteCatalogReadPort.listQuoteCatalogItems();
  const map = new Map<string, string>();
  for (const item of items) {
    if (item.sellability.subscription) map.set(item.variantId, item.skuCode);
  }
  return map;
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
