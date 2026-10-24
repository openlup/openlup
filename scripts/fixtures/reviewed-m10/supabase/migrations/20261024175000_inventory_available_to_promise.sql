-- M06 provider-stock admission: one shared available-to-promise calculation.
-- Callers lock and validate the provider-current row before admitting a hold.
-- Only a concrete subscription_cycle order may spend the soft renewal budget.
-- Channel exposure is deferred; its single extension hook currently returns zero.

CREATE FUNCTION public.inventory_channel_exposure_quantity(p_sku_id uuid)
RETURNS bigint LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT 0::bigint;
$$;
REVOKE ALL ON FUNCTION public.inventory_channel_exposure_quantity(uuid) FROM PUBLIC, anon, authenticated, openlup_mcp_reader;
GRANT EXECUTE ON FUNCTION public.inventory_channel_exposure_quantity(uuid) TO service_role;

CREATE FUNCTION public.inventory_available_to_promise(
 p_sku_id uuid, p_as_of timestamptz, p_for_subscription_renewal boolean
)
RETURNS TABLE (
 available_quantity bigint, for_sale_quantity bigint, hard_hold_quantity bigint,
 safety_quantity bigint, soft_subscription_demand_quantity bigint, channel_exposure_quantity bigint
)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
 WITH components AS (
  SELECT stock.provider_for_sale_quantity::bigint AS for_sale,
   (SELECT COALESCE(sum(r.quantity),0) FROM public.inventory_reservations r
     WHERE r.sku_id=p_sku_id AND r.status='reserved'
      AND r.metadata->>'providerKind'='omnipack'
      AND (r.expires_at IS NULL OR r.expires_at>p_as_of)) AS hard_holds,
   (SELECT COALESCE(sum(b.safety_stock),0) FROM public.inventory_balances b
     JOIN public.inventory_locations l ON l.id=b.location_id
     WHERE b.sku_id=p_sku_id AND l.status='active' AND l.fulfillable) AS safety,
   (SELECT COALESCE(sum(greatest(0,due.line_qty-held.quantity)),0)::bigint
     FROM (
      SELECT s.id, sum(sl.qty) AS line_qty
      FROM public.subscriptions s JOIN public.subscription_lines sl ON sl.subscription_id=s.id
      WHERE sl.variant_id=p_sku_id AND s.status='active' AND NOT COALESCE(s.is_test_fixture,false)
       AND s.next_cycle_at IS NOT NULL AND s.next_cycle_at<=p_as_of+interval '14 days'
      GROUP BY s.id
     ) due
     CROSS JOIN LATERAL (
      SELECT COALESCE(sum(r.quantity),0) AS quantity
      FROM public.subscription_cycles c JOIN public.inventory_reservations r ON r.subscription_cycle_id=c.id
      WHERE c.subscription_id=due.id AND c.status NOT IN ('paid','skipped','cancelled')
       AND r.sku_id=p_sku_id AND r.status='reserved' AND r.metadata->>'providerKind'='omnipack'
       AND (r.expires_at IS NULL OR r.expires_at>p_as_of)
     ) held) AS soft_demand,
   public.inventory_channel_exposure_quantity(p_sku_id) AS exposure
  FROM public.fulfillment_provider_stock_current stock
  WHERE stock.catalog_sku_id=p_sku_id AND stock.provider_kind='omnipack'
 )
 SELECT greatest(0,for_sale-hard_holds-safety
          -CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END-exposure),
        for_sale,hard_holds,safety,soft_demand,exposure
 FROM components;
$$;
REVOKE ALL ON FUNCTION public.inventory_available_to_promise(uuid,timestamptz,boolean) FROM PUBLIC, anon, authenticated, openlup_mcp_reader;
GRANT EXECUTE ON FUNCTION public.inventory_available_to_promise(uuid,timestamptz,boolean) TO service_role;
