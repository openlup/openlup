-- Aggregate eligible managed renewal holds once before matching due subscriptions,
-- eliminating the correlated lateral cycle lookup per due subscription in ATP.
-- Reads the installed provider binding from the existing ATP function so no vendor
-- literal is duplicated in this forward migration.

DO $$
DECLARE
 v_provider text;
BEGIN
 v_provider := (regexp_match(
  pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure),
  $binding$stock\.provider_kind='([^']+)'$binding$
 ))[1];
 IF v_provider IS NULL OR btrim(v_provider) = '' THEN
  RAISE EXCEPTION 'managed_atp_provider_binding_missing';
 END IF;

 EXECUTE format($idx$
  CREATE INDEX IF NOT EXISTS idx_inventory_reservations_managed_active_sku_cycle
   ON public.inventory_reservations (sku_id, subscription_cycle_id)
   WHERE status = 'reserved' AND (metadata->>'providerKind') = %L
 $idx$, v_provider);

 EXECUTE format($fn$
  CREATE OR REPLACE FUNCTION public.inventory_available_to_promise(
   p_sku_id uuid, p_as_of timestamptz, p_for_subscription_renewal boolean
  )
  RETURNS TABLE (
   available_quantity bigint, for_sale_quantity bigint, hard_hold_quantity bigint,
   safety_quantity bigint, soft_subscription_demand_quantity bigint, channel_exposure_quantity bigint
  )
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $body$
   WITH live_holds AS (
    SELECT r.subscription_cycle_id, r.quantity
    FROM public.inventory_reservations r
    WHERE r.sku_id=p_sku_id AND r.status='reserved'
     AND r.metadata->>'providerKind'=%L
     AND (r.expires_at IS NULL OR r.expires_at>p_as_of)
   ), credited AS (
    SELECT c.subscription_id, COALESCE(sum(h.quantity),0) AS quantity
    FROM live_holds h
    JOIN public.subscription_cycles c ON c.id=h.subscription_cycle_id
    WHERE h.subscription_cycle_id IS NOT NULL
     AND c.status NOT IN ('paid','skipped','cancelled')
    GROUP BY c.subscription_id
   ), components AS (
    SELECT stock.provider_for_sale_quantity::bigint AS for_sale,
     (SELECT COALESCE(sum(h.quantity),0) FROM live_holds h) AS hard_holds,
     (SELECT COALESCE(sum(b.safety_stock),0) FROM public.inventory_balances b
       JOIN public.inventory_locations l ON l.id=b.location_id
       WHERE b.sku_id=p_sku_id AND l.status='active' AND l.fulfillable) AS safety,
     (SELECT COALESCE(sum(greatest(0,due.line_qty-COALESCE(credited.quantity,0))),0)::bigint
       FROM (
        SELECT s.id, sum(sl.qty) AS line_qty
        FROM public.subscriptions s JOIN public.subscription_lines sl ON sl.subscription_id=s.id
        WHERE sl.variant_id=p_sku_id AND s.status='active' AND NOT COALESCE(s.is_test_fixture,false)
         AND s.next_cycle_at IS NOT NULL AND s.next_cycle_at<=p_as_of+interval '14 days'
        GROUP BY s.id
       ) due
       LEFT JOIN credited ON credited.subscription_id=due.id) AS soft_demand,
     public.inventory_channel_exposure_quantity(p_sku_id) AS exposure
    FROM public.fulfillment_provider_stock_current stock
    WHERE stock.catalog_sku_id=p_sku_id AND stock.provider_kind=%L
   )
   SELECT greatest(0,for_sale-hard_holds-safety
            -CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END-exposure),
          for_sale,hard_holds,safety,soft_demand,exposure
   FROM components;
  $body$;
 $fn$, v_provider, v_provider);
END;
$$;
