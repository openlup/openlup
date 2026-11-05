import type { ResolvedPrice } from "@openlup/core/pricing";
import type { PgQueryExecutor } from "../../../data/index.js";
import type { CommercePriceAuthorityReadPort, TimedAuthorityValue } from "../../../pricing/index.js";
import { prepareCommercePriceReads } from "./commercePriceReadPreparation.js";

type Instant = string | Date;
interface PriceRow {
  id: string; price_list_id: string; variant_id: string;
  mode: ResolvedPrice["mode"]; min_qty: number; unit_price_minor: number;
  amount_kind: ResolvedPrice["amountKind"]; valid_from: Instant; valid_to: Instant | null;
}
interface PolicyRow {
  id: string; revision_no: number; price_list_id: string; region_code: string;
  currency: string; channel: string; discount_bps: number; rounding_quantum_minor: number;
  rounding_rule: string; digest: string; effective_from: Instant; effective_to: Instant | null;
}
const LISTS_SQL = `SELECT id, valid_from, valid_to FROM public.price_lists
  WHERE region_code = $1::text AND currency = $2::text AND status = 'active' ORDER BY id`;
const ENTRIES_SQL = `SELECT id, price_list_id, variant_id, mode, min_qty, unit_price_minor,
  amount_kind, valid_from, valid_to FROM public.price_entries
  WHERE variant_id = ANY($1::uuid[]) AND price_list_id = $2::uuid AND mode = $3::text
  AND min_qty = 1 AND active = true ORDER BY id`;
const POLICIES_SQL = `SELECT id, revision_no, price_list_id, region_code, currency, channel,
  discount_bps, rounding_quantum_minor, rounding_rule, digest, effective_from, effective_to
  FROM public.subscription_price_policy_revisions
  WHERE price_list_id = $1::uuid AND region_code = $2::text AND currency = $3::text
  AND channel = $4::text ORDER BY revision_no, id`;

/** Allocate once per request: raw history is shared, effective money is always revalidated. */
export function createPostgresCommercePriceAuthorityReadPort(executor: PgQueryExecutor): CommercePriceAuthorityReadPort {
  async function entries(input: { variantIds: readonly string[]; priceListId: string }, mode: "one_time" | "subscription") {
    const ids = input.variantIds;
    const rows: PriceRow[] = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const result = await executor.query(ENTRIES_SQL, [ids.slice(offset, offset + 500), input.priceListId, mode]);
      for (const row of result.rows as unknown as PriceRow[]) rows.push(row);
    }
    return rows.map(row => timed<ResolvedPrice>({
      variantId: row.variant_id, mode: row.mode, matchedMinQty: row.min_qty,
      unitPriceMinor: row.unit_price_minor, amountKind: row.amount_kind,
      priceListId: row.price_list_id, priceEntryId: row.id, resolvedAt: iso(row.valid_from),
    }, row.valid_from, row.valid_to));
  }
  return prepareCommercePriceReads({
    async listPriceLists(context) {
      const { rows } = await executor.query(LISTS_SQL, [context.regionCode, context.currency]);
      return (rows as unknown as { id: string; valid_from: Instant; valid_to: Instant | null }[])
        .map(row => timed(row.id, row.valid_from, row.valid_to));
    },
    listExactBaseEntries: input => entries({ variantIds: [input.variantId], priceListId: input.priceListId }, "one_time"),
    listExactLegacySubscriptionEntries: input => entries({ variantIds: [input.variantId], priceListId: input.priceListId }, "subscription"),
    listExactBaseEntriesBulk: input => entries(input, "one_time"),
    listExactLegacySubscriptionEntriesBulk: input => entries(input, "subscription"),
    async listSubscriptionPolicyHistory(context) {
      const { rows } = await executor.query(POLICIES_SQL, [context.priceListId, context.regionCode, context.currency, context.channel]);
      return (rows as unknown as PolicyRow[]).map(row => timed({
        id: row.id, revisionNo: row.revision_no, priceListId: row.price_list_id,
        regionCode: row.region_code, currency: row.currency, channel: row.channel,
        discountBps: row.discount_bps, roundingQuantumMinor: row.rounding_quantum_minor,
        roundingRule: row.rounding_rule, digest: row.digest,
        effectiveFrom: iso(row.effective_from), effectiveTo: row.effective_to === null ? null : iso(row.effective_to),
      }, row.effective_from, row.effective_to));
    },
  });
}
function timed<T>(value: T, from: Instant, to: Instant | null): TimedAuthorityValue<T> {
  return { value, validFrom: iso(from), validTo: to === null ? null : iso(to) };
}
function iso(value: Instant): string { return value instanceof Date ? value.toISOString() : value; }
