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
  const result = await db.query(`SELECT list.id,list.currency FROM public.commerce_orders o
    JOIN public.price_lists list ON list.currency=o.currency_code AND list.status='active'
      AND list.valid_from<=now() AND (list.valid_to IS NULL OR list.valid_to>now())
    WHERE o.id=$1::uuid AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.metadata#>'{orderDraftSnapshot,lines}'))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(o.metadata#>'{orderDraftSnapshot,lines}') item(line) WHERE
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
    ORDER BY list.id`, [orderId]);
  return result.rows.length === 1
    ? { priceListId: String(result.rows[0].id), currency: String(result.rows[0].currency) }
    : { priceListId: null, currency: null, reason: result.rows.length ? "ambiguous" : "missing" };
}
