import { createCommercePriceAuthorityPort, type TimedAuthorityValue } from "../../../src/domains/pricing/commercePriceAuthority.js";
import { CommercePriceAuthorityError, type CommercePriceAuthorityPort, type PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import type { PricingAmountKind, PricingMode, ResolvedPrice, ResolvePriceQuery } from "../../../src/domains/pricing/types.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import {
  degradedExactOneTimeBase, type CatalogListPriceQuery, type CatalogExactOneTimeBasePriceReadPort,
} from "../../domains/catalog/catalogPricingJoin.js";

interface PriceListRow {
  id: string;
  valid_from: string | Date;
  valid_to: string | Date | null;
}

interface PriceEntryRow {
  id: string;
  price_list_id: string;
  variant_id: string;
  mode: PricingMode;
  min_qty: number;
  unit_price_minor: number;
  amount_kind: PricingAmountKind;
  valid_from: string | Date;
  valid_to: string | Date | null;
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
  effective_from: string | Date;
  effective_to: string | Date | null;
}

const PRICE_LIST_SQL = "SELECT id, valid_from, valid_to FROM public.price_lists WHERE region_code = $1 AND currency = $2 AND status = 'active' ORDER BY id";

const PRICE_ENTRY_SQL = `
  SELECT id, price_list_id, variant_id, mode, min_qty, unit_price_minor,
    amount_kind, valid_from, valid_to
  FROM public.price_entries WHERE variant_id = $1 AND mode = $2
    AND active = true AND price_list_id = ANY($3::uuid[]) AND min_qty <= $4
  ORDER BY min_qty DESC, valid_from DESC, id`;

const BATCH_EXACT_ONE_TIME_BASE_ENTRY_SQL = `
  SELECT id, price_list_id, variant_id, mode, min_qty, unit_price_minor,
    amount_kind, valid_from, valid_to
  FROM public.price_entries WHERE variant_id = ANY($1::uuid[])
    AND mode = 'one_time' AND active = true
    AND price_list_id = $2 AND min_qty = 1
  ORDER BY variant_id, id`;

const STRICT_BASE_ENTRY_SQL = `
  SELECT id, price_list_id, variant_id, mode, min_qty, unit_price_minor,
    amount_kind, valid_from, valid_to
  FROM public.price_entries WHERE variant_id = $1 AND mode = 'one_time'
    AND min_qty = 1 AND active = true AND price_list_id = ANY($2::uuid[])
  ORDER BY id`;

const STRICT_LEGACY_SUBSCRIPTION_ENTRY_SQL = `
  SELECT id, price_list_id, variant_id, mode, min_qty, unit_price_minor,
    amount_kind, valid_from, valid_to
  FROM public.price_entries WHERE variant_id = $1 AND price_list_id = $2
    AND mode = 'subscription' AND min_qty = 1 AND active = true
  ORDER BY id`;

const SUBSCRIPTION_POLICY_SQL = `
  SELECT id, revision_no, price_list_id, region_code, currency, channel,
    discount_bps, rounding_quantum_minor, rounding_rule, digest,
    effective_from, effective_to
  FROM public.subscription_price_policy_revisions WHERE price_list_id = $1
    AND region_code = $2 AND currency = $3 AND channel = $4
  ORDER BY revision_no`;

export function createPostgresPricingResolverPort(
  executor: PgQueryExecutor,
): PricingResolverPort & CatalogExactOneTimeBasePriceReadPort {
  const priceListIdsCache = new Map<string, Promise<string[]>>();

  function cachedActivePriceListIds(
    query: ResolvePriceQuery,
    atTime: string,
  ): Promise<string[]> {
    const key = `${query.regionCode}|${query.currency}|${atTime}`;
    let pending = priceListIdsCache.get(key);
    if (!pending) {
      pending = activePriceListIds(executor, query, atTime);
      priceListIdsCache.set(key, pending);
    }
    return pending;
  }

  return {
    async resolvePrice(query: ResolvePriceQuery): Promise<ResolvedPrice | null> {
      const atTime = query.atTime ?? new Date().toISOString();
      const priceListIds = await cachedActivePriceListIds(query, atTime);
      if (priceListIds.length === 0) return null;

      const direct = await selectBestEntry(
        executor,
        query,
        query.mode,
        atTime,
        priceListIds,
      );
      if (direct) return toResolvedPrice(direct, atTime);

      if (query.mode !== "any") {
        const fallback = await selectBestEntry(
          executor,
          query,
          "any",
          atTime,
          priceListIds,
        );
        if (fallback) return toResolvedPrice(fallback, atTime);
      }
      return null;
    },

    async listExactOneTimeBasePrices(query: CatalogListPriceQuery): Promise<ReadonlyMap<string, ResolvedPrice>> {
      const variantIds = [...new Set(query.variantIds)];
      if (variantIds.length === 0) return new Map();
      const priceLists = (await readPriceLists(executor, query)).filter((row) => isValidAt(row, query.atTime));
      if (priceLists.length === 0) throw new CommercePriceAuthorityError("active_price_list_not_found");
      if (priceLists.length !== 1) throw new CommercePriceAuthorityError("active_price_list_ambiguous");
      const { rows } = await executor.query(BATCH_EXACT_ONE_TIME_BASE_ENTRY_SQL, [
        variantIds, priceLists[0]!.id,
      ]);
      const valid = (rows as unknown as PriceEntryRow[]).filter((row) => isValidAt(row, query.atTime));
      const byVariant = new Map<string, PriceEntryRow[]>();
      for (const row of valid) byVariant.set(row.variant_id, [...(byVariant.get(row.variant_id) ?? []), row]);
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

/** Strict current-money authority; the generic resolver above remains unchanged for legacy consumers. */
export function createPostgresCommercePriceAuthorityPort(
  executor: PgQueryExecutor,
): CommercePriceAuthorityPort {
  return createCommercePriceAuthorityPort({
    async listPriceLists(context) {
      return (await readPriceLists(executor, context)).map((row) => timed(row.id, iso(row.valid_from), row.valid_to === null ? null : iso(row.valid_to)));
    },
    async listExactBaseEntries({ variantId, priceListId }) {
      return (await selectStrictBaseEntries(executor, variantId, priceListId)).map((row) => timedPrice(row));
    },
    async listExactLegacySubscriptionEntries({ variantId, priceListId }) {
      return (await selectStrictLegacySubscriptionEntries(executor, variantId, priceListId)).map((row) => timedPrice(row));
    },
    async listSubscriptionPolicyHistory(context) {
      return (await selectSubscriptionPolicyHistory(executor, context)).map((row) => timed(
        toSubscriptionPolicyRevision(row), iso(row.effective_from), row.effective_to === null ? null : iso(row.effective_to),
      ));
    },
  });
}

async function activePriceListIds(
  executor: PgQueryExecutor,
  query: Pick<ResolvePriceQuery, "regionCode" | "currency">,
  atTime: string,
): Promise<string[]> {
  return (await readPriceLists(executor, query))
    .filter((row) => isValidAt(row, atTime))
    .map((row) => row.id);
}

async function readPriceLists(
  executor: PgQueryExecutor,
  query: Pick<ResolvePriceQuery, "regionCode" | "currency">,
): Promise<PriceListRow[]> {
  const result = await executor.query(PRICE_LIST_SQL, [query.regionCode, query.currency]);
  return result.rows as unknown as PriceListRow[];
}

async function selectBestEntry(
  executor: PgQueryExecutor,
  query: ResolvePriceQuery,
  mode: PricingMode,
  atTime: string,
  priceListIds: string[],
): Promise<PriceEntryRow | null> {
  const result = await executor.query(PRICE_ENTRY_SQL, [
    query.variantId,
    mode,
    priceListIds,
    query.eligibleCartQty,
  ]);
  return bestEntry((result.rows as unknown as PriceEntryRow[]).filter((row) => isValidAt(row, atTime)));
}

async function selectStrictBaseEntries(
  executor: PgQueryExecutor,
  variantId: string,
  priceListId: string,
): Promise<PriceEntryRow[]> {
  const result = await executor.query(STRICT_BASE_ENTRY_SQL, [variantId, [priceListId]]);
  return result.rows as unknown as PriceEntryRow[];
}

async function selectStrictLegacySubscriptionEntries(
  executor: PgQueryExecutor,
  variantId: string,
  priceListId: string,
): Promise<PriceEntryRow[]> {
  const result = await executor.query(STRICT_LEGACY_SUBSCRIPTION_ENTRY_SQL, [variantId, priceListId]);
  return result.rows as unknown as PriceEntryRow[];
}

async function selectSubscriptionPolicyHistory(
  executor: PgQueryExecutor,
  context: { priceListId: string; regionCode: string; currency: string; channel: string },
): Promise<SubscriptionPricePolicyRow[]> {
  const result = await executor.query(SUBSCRIPTION_POLICY_SQL, [
    context.priceListId,
    context.regionCode,
    context.currency,
    context.channel,
  ]);
  return result.rows as unknown as SubscriptionPricePolicyRow[];
}

function bestEntry(rows: readonly PriceEntryRow[]): PriceEntryRow | null {
  return [...rows].sort((left, right) => {
    if (right.min_qty !== left.min_qty) return right.min_qty - left.min_qty;
    const byDate = Date.parse(iso(right.valid_from)) - Date.parse(iso(left.valid_from));
    return byDate || left.id.localeCompare(right.id);
  })[0] ?? null;
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
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to === null ? null : iso(row.effective_to),
  };
}

// ⚠️ Two clocks: the row's bounds default to the DATABASE's `now()`, `atTime` comes from the caller's own `Date`.
function isValidAt(
  row: { valid_from: string | Date; valid_to: string | Date | null },
  atTime: string,
): boolean {
  const atMs = Date.parse(atTime);
  const fromMs = Date.parse(iso(row.valid_from));
  const toMs = row.valid_to === null ? null : Date.parse(iso(row.valid_to));
  return Number.isFinite(atMs)
    && Number.isFinite(fromMs)
    && fromMs <= atMs
    && (toMs === null || toMs > atMs);
}

function timed<T>(value: T, validFrom: string, validTo: string | null): TimedAuthorityValue<T> {
  return { value, validFrom, validTo };
}

function timedPrice(row: PriceEntryRow): TimedAuthorityValue<ResolvedPrice> {
  return timed(toResolvedPrice(row, iso(row.valid_from)), iso(row.valid_from), row.valid_to === null ? null : iso(row.valid_to));
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
