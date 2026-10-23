-- M06 observed-stock ATP. Native stock has no separate safety balance.
-- Admission callers keep their stock-row locks; this is a read, not a hold.
-- Only actual native renewal allocation skips the fixed 14-day soft priority.
CREATE FUNCTION public.inventory_channel_exposure_quantity(p_source_key text, p_sku text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT '0'::jsonb;
$$;
REVOKE ALL ON FUNCTION public.inventory_channel_exposure_quantity(text,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.inventory_available_to_promise(
 p_source_key text, p_sku text, p_as_of timestamptz, p_for_subscription_renewal boolean
)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 WITH live_holds AS (
  SELECT r.renewal_operation_id,l.quantity
  FROM public.fulfillment_inventory_reservations r
  JOIN public.fulfillment_inventory_reservation_lines l ON l.reservation_id=r.id
  WHERE r.source_key=p_source_key AND l.sku=p_sku
   AND (r.status='committed' OR (r.status='held' AND r.expires_at>p_as_of))
 ), components AS (
  SELECT COALESCE((SELECT stock.for_sale_quantity FROM public.fulfillment_stock_current stock
    WHERE stock.source_key=p_source_key AND stock.sku=p_sku
     AND stock.inventory_class='sellable' AND stock.stale_after>p_as_of),0)::bigint for_sale,
   (SELECT COALESCE(sum(quantity),0) FROM live_holds)::bigint hard_holds,
   (SELECT COALESCE(sum(GREATEST(0,due.quantity-credited.quantity)),0)::bigint
    FROM (
     SELECT s.id,s.next_cycle_at,sum(l.quantity) quantity
     FROM public.subscriptions s
     JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
     JOIN public.subscription_renewal_term_lines l ON l.subscription_id=s.id
     WHERE s.status='active' AND s.next_cycle_at<=p_as_of+interval '14 days'
      AND t.stock_source_key=p_source_key AND l.sku=p_sku
     GROUP BY s.id,s.next_cycle_at
    ) due CROSS JOIN LATERAL (
     SELECT COALESCE(sum(h.quantity),0) quantity FROM live_holds h
     JOIN public.subscription_renewal_operations op ON op.id=h.renewal_operation_id
     WHERE op.subscription_id=due.id AND op.scheduled_at=due.next_cycle_at
      AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles c
       WHERE c.renewal_operation_id=op.id AND c.status IN ('paid','skipped','cancelled'))
    ) credited) soft_demand,
   (public.inventory_channel_exposure_quantity(p_source_key,p_sku)#>>'{}')::bigint exposure
 )
 SELECT jsonb_build_object('available_quantity',GREATEST(0,for_sale-hard_holds
   -CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END-exposure),
  'for_sale_quantity',for_sale,'hard_hold_quantity',hard_holds,'safety_quantity',0,
  'soft_subscription_demand_quantity',soft_demand,'channel_exposure_quantity',exposure)
 FROM components;
$$;
REVOKE ALL ON FUNCTION public.inventory_available_to_promise(text,text,timestamptz,boolean) FROM PUBLIC, anon, authenticated;

-- M06 parity completion. Both availability fields protect subscription demand;
-- this one-time-purchase read never accepts a caller-supplied renewal exemption.
CREATE FUNCTION public.inventory_new_purchase_stock_read(p_source_key text, p_skus jsonb, p_as_of timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
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
 CROSS JOIN LATERAL (SELECT public.inventory_available_to_promise(p_source_key,requested.sku,p_as_of,false) atp) promise;
$$;
REVOKE ALL ON FUNCTION public.inventory_new_purchase_stock_read(text,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
