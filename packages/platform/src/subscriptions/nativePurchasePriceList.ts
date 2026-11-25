import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** Only the optional template/context work may be discarded; completion is outside this unit. */
export async function bestEffortNativePurchaseTemplate(db: SubscriptionQueryExecutor, work: () => Promise<void>): Promise<void> {
  let transactional = true;
  try { await db.query("SAVEPOINT native_purchase_template"); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "25P01") throw error;
    transactional = false;
  }
  try { await work(); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !/^(42|22|23)[0-9A-Z]{3}$/.test(code)) throw error;
    if (transactional) {
      await db.query("ROLLBACK TO SAVEPOINT native_purchase_template");
      await db.query("RELEASE SAVEPOINT native_purchase_template");
    }
    console.warn("subscription_template_unavailable", code);
    return;
  }
  if (transactional) await db.query("RELEASE SAVEPOINT native_purchase_template");
}

/** Evaluate admission's price predicate per original logical draft line. */
export async function resolveNativePurchasePriceList(db: SubscriptionQueryExecutor, orderId: string): Promise<{
  priceListId: string | null; currency: string | null; reason?: "missing" | "ambiguous";
}> {
  const { rows: [purchase] } = await db.query(`SELECT currency_code,created_at::text AS created_at,
    metadata->'quoteSnapshot' AS quote,metadata->'orderDraftSnapshot' AS draft,
    jsonb_array_length(metadata#>'{orderDraftSnapshot,lines}') AS line_count FROM public.commerce_orders
    WHERE id=$1::uuid AND metadata#>>'{orderDraftSnapshot,context,mode}'='subscription'
      AND metadata#>'{orderDraftSnapshot,lines}' @> '[{"catalogFacts":{"version":"catalog_facts_v2"}}]'::jsonb`, [orderId]);
  let derivedList: string | undefined;
  if (purchase) {
    // The draft verifier validates both stored snapshots, the policy revision and the derived unit by line ordinal.
    const { rows } = await db.query(`WITH verified AS MATERIALIZED (
        SELECT public.catalog_admission_derived_subscription_prices($1,$2,$3,$4) AS units
      )
      SELECT list.id FROM verified
      CROSS JOIN jsonb_array_elements($3::jsonb->'lines') WITH ORDINALITY item(line,position)
      LEFT JOIN public.price_entries base ON base.id=CASE WHEN verified.units[item.position::int] IS NOT NULL
        THEN (item.line#>>'{catalogFacts,basePriceEntryId}')::uuid END
      LEFT JOIN public.price_lists list ON list.id=base.price_list_id
        AND list.status='active' AND list.valid_from<=now() AND (list.valid_to IS NULL OR list.valid_to>now())
      WHERE item.line#>>'{catalogFacts,version}'='catalog_facts_v2'`,
    [purchase.currency_code, purchase.quote, purchase.draft, purchase.created_at]);
    const id = rows[0]?.id;
    if (typeof id !== "string" || rows.some(row => row.id !== id)) {
      return { priceListId: null, currency: null, reason: "missing" };
    }
    if (rows.length === purchase.line_count) return { priceListId: id, currency: String(purchase.currency_code) };
    derivedList = id;
  }
  const result = await db.query(`SELECT list.id,list.currency FROM public.commerce_orders o
    JOIN public.price_lists list ON list.currency=o.currency_code AND list.status='active'
      AND list.valid_from<=now() AND (list.valid_to IS NULL OR list.valid_to>now())
    WHERE o.id=$1::uuid${derivedList ? " AND list.id=$2::uuid" : ""} AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.metadata#>'{orderDraftSnapshot,lines}'))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(o.metadata#>'{orderDraftSnapshot,lines}') item(line) WHERE${derivedList ? "\n          item.line#>>'{catalogFacts,version}' IS DISTINCT FROM 'catalog_facts_v2' AND" : ""}
          (SELECT price.unit_price_minor FROM public.catalog_skus sku
            JOIN public.catalog_products product ON product.id=sku.product_id AND product.status='active'
            JOIN public.price_entries price ON price.variant_id=sku.id AND price.price_list_id=list.id
              AND price.active AND price.amount_kind='gross'
              AND price.mode IN (COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time'),'any')
              AND price.min_qty<=(item.line->>'quantity')::integer AND price.valid_from<=now()
              AND (price.valid_to IS NULL OR price.valid_to>now())
            WHERE sku.sku=item.line->>'sku' AND sku.status='active' AND (item.line->>'quantity')::integer>=sku.min_order_qty
              AND (COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time')<>'subscription' OR sku.sellable_in_subscription)
              AND (COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time')<>'one_time' OR sku.sellable_standalone)
            ORDER BY (price.mode=COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time')) DESC,
              price.min_qty DESC,price.id LIMIT 1) IS DISTINCT FROM (item.line#>>'{unitPriceGross,amountMinor}')::bigint)
    ORDER BY list.id`, derivedList ? [orderId, derivedList] : [orderId]);
  return result.rows.length === 1
    ? { priceListId: String(result.rows[0].id), currency: String(result.rows[0].currency) }
    : { priceListId: null, currency: null, reason: result.rows.length ? "ambiguous" : "missing" };
}
