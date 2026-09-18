import type { SupabaseClient } from "@supabase/supabase-js";
import { createCommercePriceAuthorityPort, type TimedAuthorityValue } from "../../../src/domains/pricing/commercePriceAuthority.js";
import { CommercePriceAuthorityError, type CommercePriceAuthorityPort, type PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { PricingAmountKind, PricingMode, ResolvedPrice, ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import {
  degradedExactOneTimeBase, type CatalogListPriceQuery, type CatalogExactOneTimeBasePriceReadPort,
} from "../../domains/catalog/catalogPricingJoin.js";

/** Managed generic resolver; strict current-money authority is exported separately below. */
export interface SupabasePricingResolverPortDeps {
  client: SupabaseClient;
}

interface PriceEntryRow {
  id: string;
  price_list_id: string;
  variant_id: string;
  mode: PricingMode;
  min_qty: number;
  unit_price_minor: number;
  amount_kind: PricingAmountKind;
  valid_from: string;
  valid_to: string | null;
}

interface PriceListRow {
  id: string;
  valid_from: string;
  valid_to: string | null;
}

interface SubscriptionPricePolicyRow {
  id: string;
  revision_no: number;
  price_list_id: string;
  region_code: string;
  currency: string;
  channel: string;
  discount_bps: number;
  rounding_quantum_minor: number;
  rounding_rule: string;
  digest: string;
  effective_from: string;
  effective_to: string | null;
}

const CATALOG_LIST_PRICE_BATCH_SIZE = 500;

export function createSupabasePricingResolverPort({
  client,
}: SupabasePricingResolverPortDeps): PricingResolverPort & CatalogExactOneTimeBasePriceReadPort {
  // Request-scoped promise memo preserves generic resolver semantics while deduplicating quote reads.
  const priceListIdsCache = new Map<string, Promise<string[]>>();
  function cachedActivePriceListIds(query: ResolvePriceQuery, atTime: string): Promise<string[]> {
    const key = `${query.regionCode}|${query.currency}|${atTime}`;
    let pending = priceListIdsCache.get(key);
    if (!pending) {
      pending = activePriceListIds(client, query, atTime);
      priceListIdsCache.set(key, pending);
    }
    return pending;
  }

  return {
    async resolvePrice(query: ResolvePriceQuery): Promise<ResolvedPrice | null> {
      const atTime = query.atTime ?? new Date().toISOString();
      const priceListIds = await cachedActivePriceListIds(query, atTime);
      if (priceListIds.length === 0) return null;

      const direct = await selectBestEntry(client, query, query.mode, atTime, priceListIds);
      if (direct) return toResolvedPrice(direct, atTime);

      if (query.mode !== "any") {
        const fallback = await selectBestEntry(client, query, "any", atTime, priceListIds);
        if (fallback) return toResolvedPrice(fallback, atTime);
      }

      return null;
    },

    async listExactOneTimeBasePrices(query: CatalogListPriceQuery): Promise<ReadonlyMap<string, ResolvedPrice>> {
      const variantIds = [...new Set(query.variantIds)];
      if (variantIds.length === 0) return new Map();
      const priceLists = (await readPriceLists(client, query)).filter((row) => isValidAt(row, query.atTime));
      if (priceLists.length === 0) throw new CommercePriceAuthorityError("active_price_list_not_found");
      if (priceLists.length !== 1) throw new CommercePriceAuthorityError("active_price_list_ambiguous");
      const priceListId = priceLists[0]!.id;
      const byVariant = new Map<string, PriceEntryRow[]>();
      for (const variantBatch of batches(variantIds, CATALOG_LIST_PRICE_BATCH_SIZE)) {
        const { data, error } = await client
          .from("price_entries")
          .select("id, price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, valid_from, valid_to")
          .in("variant_id", variantBatch)
          .eq("mode", "one_time")
          .eq("active", true)
          .eq("price_list_id", priceListId)
          .eq("min_qty", 1)
          .order("variant_id", { ascending: true })
          .order("id", { ascending: true });
        if (error) throw new Error(`price_entries read failed: ${error.message}`);
        for (const row of (data ?? []) as unknown as PriceEntryRow[]) {
          if (!isValidAt(row, query.atTime)) continue;
          byVariant.set(row.variant_id, [...(byVariant.get(row.variant_id) ?? []), row]);
        }
      }
      const resolved = new Map<string, ResolvedPrice>();
      for (const variantId of variantIds) {
        const candidates = byVariant.get(variantId) ?? [];
        if (degradedExactOneTimeBase(variantId, candidates.length, candidates[0]?.amount_kind)) continue;
        resolved.set(variantId, toResolvedPrice(candidates[0]!, query.atTime));
      }
      return resolved;
    },
  };
}

/** Strict current-money authority; generic tier and `any` behavior remains separate. */
export function createSupabaseCommercePriceAuthorityPort({
  client,
}: SupabasePricingResolverPortDeps): CommercePriceAuthorityPort {
  return createCommercePriceAuthorityPort({
    async listPriceLists(context) {
      return (await readPriceLists(client, context)).map((row) => timed(row.id, row.valid_from, row.valid_to));
    },
    async listExactBaseEntries({ variantId, priceListId }) {
      return (await selectStrictBaseEntries(client, variantId, priceListId)).map((row) => timedPrice(row));
    },
    async listExactLegacySubscriptionEntries({ variantId, priceListId }) {
      return (await selectStrictLegacySubscriptionEntries(client, variantId, priceListId)).map((row) => timedPrice(row));
    },
    async listSubscriptionPolicyHistory(context) {
      return (await selectSubscriptionPolicyHistory(client, context)).map((row) => timed(
        toSubscriptionPolicyRevision(row), row.effective_from, row.effective_to,
      ));
    },
  });
}

async function selectBestEntry(
  client: SupabaseClient,
  query: ResolvePriceQuery,
  mode: PricingMode,
  atTime: string,
  priceListIds: string[],
): Promise<PriceEntryRow | null> {
  if (priceListIds.length === 0) return null;

  const { data, error } = await client
    .from("price_entries")
    .select("id, price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, valid_from, valid_to")
    .eq("variant_id", query.variantId)
    .eq("mode", mode)
    .eq("active", true)
    .in("price_list_id", priceListIds)
    .lte("min_qty", query.eligibleCartQty)
    .order("min_qty", { ascending: false });

  if (error) {
    throw new Error(`price_entries read failed: ${error.message}`);
  }

  return bestEntry(((data ?? []) as unknown as PriceEntryRow[]).filter((row) => isValidAt(row, atTime)));
}

async function selectStrictBaseEntries(
  client: SupabaseClient,
  variantId: string,
  priceListId: string,
): Promise<PriceEntryRow[]> {
  const { data, error } = await client
    .from("price_entries")
    .select("id, price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, valid_from, valid_to")
    .eq("variant_id", variantId)
    .eq("mode", "one_time")
    .eq("min_qty", 1)
    .eq("active", true)
    .eq("price_list_id", priceListId);
  if (error) throw new Error(`price_entries read failed: ${error.message}`);
  return (data ?? []) as unknown as PriceEntryRow[];
}

async function selectStrictLegacySubscriptionEntries(
  client: SupabaseClient,
  variantId: string,
  priceListId: string,
): Promise<PriceEntryRow[]> {
  const { data, error } = await client
    .from("price_entries")
    .select("id, price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, valid_from, valid_to")
    .eq("variant_id", variantId)
    .eq("price_list_id", priceListId)
    .eq("mode", "subscription")
    .eq("min_qty", 1)
    .eq("active", true);
  if (error) throw new Error(`price_entries read failed: ${error.message}`);
  return (data ?? []) as unknown as PriceEntryRow[];
}

async function selectSubscriptionPolicyHistory(
  client: SupabaseClient,
  context: { priceListId: string; regionCode: string; currency: string; channel: string },
): Promise<SubscriptionPricePolicyRow[]> {
  const { data, error } = await client
    .from("subscription_price_policy_revisions")
    .select("id, revision_no, price_list_id, region_code, currency, channel, discount_bps, rounding_quantum_minor, rounding_rule, digest, effective_from, effective_to")
    .eq("price_list_id", context.priceListId)
    .eq("region_code", context.regionCode)
    .eq("currency", context.currency)
    .eq("channel", context.channel);
  if (error) throw new Error(`subscription_price_policy_revisions read failed: ${error.message}`);
  return (data ?? []) as unknown as SubscriptionPricePolicyRow[];
}

function bestEntry(rows: readonly PriceEntryRow[]): PriceEntryRow | null {
  return [...rows].sort((left, right) => {
    if (right.min_qty !== left.min_qty) return right.min_qty - left.min_qty;
    const byDate = Date.parse(right.valid_from) - Date.parse(left.valid_from);
    return byDate || left.id.localeCompare(right.id);
  })[0] ?? null;
}

async function activePriceListIds(
  client: SupabaseClient,
  query: Pick<ResolvePriceQuery, "regionCode" | "currency">,
  atTime: string,
): Promise<string[]> {
  return (await readPriceLists(client, query))
    .filter((row) => isValidAt(row, atTime))
    .map((row) => row.id);
}

async function readPriceLists(
  client: SupabaseClient,
  query: Pick<ResolvePriceQuery, "regionCode" | "currency">,
): Promise<PriceListRow[]> {
  const { data, error } = await client
    .from("price_lists")
    .select("id, valid_from, valid_to")
    .eq("region_code", query.regionCode)
    .eq("currency", query.currency)
    .eq("status", "active");

  if (error) {
    throw new Error(`price_lists read failed: ${error.message}`);
  }

  return (data ?? []) as unknown as PriceListRow[];
}

function toResolvedPrice(row: PriceEntryRow, atTime: string): ResolvedPrice {
  return {
    variantId: row.variant_id,
    mode: row.mode,
    matchedMinQty: row.min_qty,
    unitPriceMinor: row.unit_price_minor,
    amountKind: row.amount_kind,
    priceListId: row.price_list_id,
    priceEntryId: row.id,
    resolvedAt: atTime,
  };
}

function toSubscriptionPolicyRevision(row: SubscriptionPricePolicyRow) {
  return {
    id: row.id,
    revisionNo: row.revision_no,
    priceListId: row.price_list_id,
    regionCode: row.region_code,
    currency: row.currency,
    channel: row.channel,
    discountBps: row.discount_bps,
    roundingQuantumMinor: row.rounding_quantum_minor,
    roundingRule: row.rounding_rule,
    digest: row.digest,
    // PostgREST spells timestamptz with an offset; the digest was computed over the
    // writer's `.mmmZ`. Re-render it - NOT via `iso()`, which is identity on a string.
    effectiveFrom: new Date(row.effective_from).toISOString(),
    effectiveTo: row.effective_to === null ? null : new Date(row.effective_to).toISOString(),
  };
}

function isValidAt(row: { valid_from: string; valid_to: string | null }, atTime: string): boolean {
  const atMs = Date.parse(atTime);
  const fromMs = Date.parse(row.valid_from);
  const toMs = row.valid_to === null ? null : Date.parse(row.valid_to);

  return Number.isFinite(atMs) && Number.isFinite(fromMs) && fromMs <= atMs && (toMs === null || toMs > atMs);
}

function timed<T>(value: T, validFrom: string, validTo: string | null): TimedAuthorityValue<T> {
  return { value, validFrom, validTo };
}

function timedPrice(row: PriceEntryRow): TimedAuthorityValue<ResolvedPrice> {
  return timed(toResolvedPrice(row, row.valid_from), row.valid_from, row.valid_to);
}

function* batches<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let offset = 0; offset < items.length; offset += size) yield items.slice(offset, offset + size);
}
