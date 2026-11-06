import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** Resolve admission prices and the exact statement privileges without reading protected rows. */
export async function resolveNativePurchasePriceList(db: SubscriptionQueryExecutor, orderId: string, forTemplate = false, subscriptionId?: string): Promise<{
  priceListId: string | null; currency: string | null; orderReadable: boolean; templateAllowed: boolean; contextWritable: boolean; contextReadable: boolean;
}> {
  const access = (await db.query(`WITH requirements(lane,relation_name,permission,column_names) AS (VALUES
    ('resolver','public.commerce_orders','SELECT',ARRAY['id','currency_code','metadata']),
    ('resolver','public.commerce_order_items','SELECT',ARRAY['order_id','sku_id','quantity','unit_amount_minor']),
    ('resolver','public.price_lists','SELECT',ARRAY['id','currency','status','valid_from','valid_to']),
    ('resolver','public.price_entries','SELECT',ARRAY['id','variant_id','price_list_id','active','amount_kind','mode','min_qty','valid_from','valid_to','unit_price_minor']),
    ('resolver','public.catalog_skus','SELECT',ARRAY['id','product_id','status','min_order_qty','sellable_in_subscription']),
    ('resolver','public.catalog_products','SELECT',ARRAY['id','status']),
    ('template','public.subscription_activations','SELECT',ARRAY['subscription_id','order_id','state']),
    ('template','public.subscriptions','SELECT',ARRAY['id','template_version']),
    ('template','public.subscription_lines','SELECT',ARRAY['id','subscription_id','variant_id']),
    ('template','public.subscription_lines','INSERT',ARRAY['subscription_id','variant_id','quantity','sort_order','is_addon','unit_price_minor','currency_code']),
    ('items','public.commerce_orders','SELECT',ARRAY['id','currency_code']),
    ('items','public.commerce_order_items','SELECT',ARRAY['order_id','sku_id','quantity','line_ordinal','unit_amount_minor']),
    ('draft','public.commerce_orders','SELECT',ARRAY['id','metadata','currency_code']),
    ('draft','public.catalog_skus','SELECT',ARRAY['id','sku']),
    ('context_read','public.subscriptions','SELECT',ARRAY['id','price_list_id','currency_code']),
    ('context_write','public.subscriptions','UPDATE',ARRAY['price_list_id','currency_code'])
  ), access AS (
    SELECT lane,bool_and(COALESCE((SELECT has_column_privilege(current_user,to_regclass(r.relation_name),a.attnum,r.permission)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass(r.relation_name)
        AND a.attname=c.column_name AND a.attnum>0 AND NOT a.attisdropped),false)) AS allowed
    FROM requirements r CROSS JOIN LATERAL unnest(r.column_names) c(column_name) GROUP BY lane
  ) SELECT bool_and(allowed) FILTER(WHERE lane='resolver') AS resolver_allowed,
    bool_and(allowed) FILTER(WHERE lane='template') AS template_allowed,
    bool_and(allowed) FILTER(WHERE lane='items') AS order_readable,
    bool_and(allowed) FILTER(WHERE lane='draft') AS draft_readable,
    bool_and(allowed) FILTER(WHERE lane='context_read') AS context_readable,
    bool_and(allowed) FILTER(WHERE lane='context_write') AS context_writable,
    has_any_column_privilege(current_user,to_regclass('public.subscriptions'),'UPDATE') AS can_lock
    FROM access`)).rows[0] ?? {};
  const capabilities = { orderReadable: access.order_readable === true, contextWritable: access.context_readable === true && access.context_writable === true,
    contextReadable: access.context_readable === true,
    templateAllowed: access.template_allowed === true && access.can_lock === true
      && (access.order_readable === true || access.draft_readable === true) };
  const unresolved = { priceListId: null, currency: null, ...capabilities };
  if (forTemplate && !capabilities.templateAllowed) {
    console.warn("subscription_template_unavailable", "privileges_unavailable");
    return unresolved;
  }
  if (subscriptionId) {
    if (!capabilities.contextReadable) {
      console.warn("subscription_price_list_unresolved", "read_unavailable");
      return unresolved;
    }
    const current = (await db.query("SELECT price_list_id,currency_code FROM public.subscriptions WHERE id=$1::uuid", [subscriptionId])).rows[0];
    if (!current || current.price_list_id != null || current.currency_code != null) return unresolved;
  }
  if (access.resolver_allowed !== true) {
    console.warn("subscription_price_list_unresolved", "read_unavailable");
    return unresolved;
  }
  const result = await db.query(`SELECT list.id,list.currency FROM public.commerce_orders o
    JOIN public.price_lists list ON list.currency=o.currency_code AND list.status='active'
      AND list.valid_from<=now() AND (list.valid_to IS NULL OR list.valid_to>now())
    WHERE o.id=$1::uuid AND EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=o.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.commerce_order_items item WHERE item.order_id=o.id AND
          (SELECT price.unit_price_minor FROM public.catalog_skus sku
            JOIN public.catalog_products product ON product.id=sku.product_id AND product.status='active'
            JOIN public.price_entries price ON price.variant_id=sku.id AND price.price_list_id=list.id
              AND price.active AND price.amount_kind='gross'
              AND price.mode IN (COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time'),'any')
              AND price.min_qty<=item.quantity AND price.valid_from<=now()
              AND (price.valid_to IS NULL OR price.valid_to>now())
            WHERE sku.id=item.sku_id AND sku.status='active' AND item.quantity>=sku.min_order_qty
              AND sku.sellable_in_subscription
            ORDER BY (price.mode=COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}','one_time')) DESC,
              price.min_qty DESC,price.id LIMIT 1) IS DISTINCT FROM item.unit_amount_minor)
    ORDER BY list.id`, [orderId]);
  if (result.rows.length === 1) {
    if (forTemplate && !capabilities.contextWritable) {
      console.warn("subscription_template_unavailable", "privileges_unavailable");
      return { ...unresolved, templateAllowed: false };
    }
    if (!forTemplate && !capabilities.contextWritable) console.warn("subscription_price_list_unresolved", "write_unavailable");
    return { priceListId: String(result.rows[0].id), currency: String(result.rows[0].currency), ...capabilities };
  }
  console.warn("subscription_price_list_unresolved", result.rows.length ? "ambiguous" : "missing");
  return unresolved;
}
