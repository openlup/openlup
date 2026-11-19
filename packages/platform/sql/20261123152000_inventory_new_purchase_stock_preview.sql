-- Mirrors installed new-purchase ATP and stock projection for estimates; inventoryRenewalProtectionPolicy.test.ts binds parity.
CREATE FUNCTION public.inventory_new_purchase_stock_preview(p_source_key text, p_skus jsonb, p_as_of timestamptz, p_horizon_days jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
 v_horizon_days integer;
BEGIN
 v_horizon_days := (public.inventory_renewal_protection_validate(jsonb_build_object(
  'revision','preview','renewalProtectionDays',p_horizon_days))->>'renewalProtectionDays')::integer;
 RETURN (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('sku',requested.sku,'catalogSkuId',sku.id,
   'source',CASE WHEN stock.sku IS NULL THEN 'missing' ELSE 'provider' END,
   'providerForSale',stock.for_sale_quantity,'activeHolds',atp->'hard_hold_quantity',
   'safetyStock',atp->'safety_quantity','available',atp->'available_quantity',
   'stale',stock.sku IS NOT NULL AND stock.stale_after<=p_as_of,
   'renewalDemand',atp->'soft_subscription_demand_quantity',
   'availableForNewPurchases',atp->'available_quantity','excludedOrderHolds',0,
   'channelExposure',atp->'channel_exposure_quantity') ORDER BY requested.sku),'[]'::jsonb)
  FROM (SELECT DISTINCT value sku FROM jsonb_array_elements_text(p_skus)) requested
  LEFT JOIN public.catalog_skus sku ON sku.sku=requested.sku
  LEFT JOIN public.fulfillment_stock_current stock ON stock.source_key=p_source_key AND stock.sku=requested.sku
  CROSS JOIN LATERAL (
   SELECT (
     WITH policy AS MATERIALIZED (
      SELECT v_horizon_days days
     ), live_holds AS (
      SELECT r.renewal_operation_id,l.quantity
      FROM public.fulfillment_inventory_reservations r
      JOIN public.fulfillment_inventory_reservation_lines l ON l.reservation_id=r.id
      WHERE r.source_key=p_source_key AND l.sku=requested.sku
       AND (r.status='committed' OR (r.status='held' AND r.expires_at>p_as_of))
     ), credited AS (
      SELECT op.subscription_id,op.scheduled_at,sum(h.quantity) quantity
      FROM live_holds h
      JOIN public.subscription_renewal_operations op ON op.id=h.renewal_operation_id
      WHERE NOT EXISTS(SELECT 1 FROM public.subscription_cycles c
       WHERE c.renewal_operation_id=op.id AND c.status IN ('paid','skipped','cancelled'))
      GROUP BY op.subscription_id,op.scheduled_at
     ), components AS (
      SELECT COALESCE((SELECT stock.for_sale_quantity FROM public.fulfillment_stock_current stock
        WHERE stock.source_key=p_source_key AND stock.sku=requested.sku
         AND stock.inventory_class='sellable' AND stock.stale_after>p_as_of),0)::bigint for_sale,
       (SELECT COALESCE(sum(quantity),0) FROM live_holds)::bigint hard_holds,
       (SELECT COALESCE(sum(GREATEST(0,due.quantity-COALESCE(credited.quantity,0))),0)::bigint
        FROM (
         SELECT s.id,s.next_cycle_at,sum(l.quantity) quantity
         FROM public.subscriptions s
         JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
         JOIN public.subscription_renewal_term_lines l ON l.subscription_id=s.id
         WHERE s.status='active' AND s.next_cycle_at<=p_as_of+make_interval(days => (SELECT days FROM policy))
          AND t.stock_source_key=p_source_key AND l.sku=requested.sku
         GROUP BY s.id,s.next_cycle_at
        ) due LEFT JOIN credited
         ON credited.subscription_id=due.id AND credited.scheduled_at=due.next_cycle_at
        ) soft_demand,
       (public.inventory_channel_exposure_quantity(p_source_key,requested.sku)#>>'{}')::bigint exposure
      FROM policy
     )
     SELECT jsonb_build_object('available_quantity',GREATEST(0,for_sale-hard_holds-soft_demand-exposure),
      'for_sale_quantity',for_sale,'hard_hold_quantity',hard_holds,'safety_quantity',0,
      'soft_subscription_demand_quantity',soft_demand,'channel_exposure_quantity',exposure)
     FROM components
   ) atp
  ) promise
 );
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb) TO service_role;'; END IF; END; $$;
