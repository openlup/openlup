-- Installed renewal priority only. No seed, allocation or subscription lifecycle changes.
-- The invoker validator preserves the existing ATP SQL header and ACL unchanged.
CREATE FUNCTION public.inventory_renewal_protection_days()
RETURNS integer LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
 raw_policy text;
 policy jsonb;
 days numeric;
BEGIN
 SELECT value_text INTO raw_policy FROM public.commerce_settings WHERE key='inventory_renewal_protection';
 IF NOT FOUND THEN RETURN 14; END IF;
 BEGIN
  policy := raw_policy::jsonb;
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
  END IF;
  IF NOT (policy ?& ARRAY['revision','renewalProtectionDays'])
   OR EXISTS (SELECT 1 FROM jsonb_object_keys(policy) k WHERE k NOT IN ('revision','renewalProtectionDays'))
   OR jsonb_typeof(policy->'revision') IS DISTINCT FROM 'string'
   OR (policy->>'revision') !~ '[^[:space:]]'
   OR jsonb_typeof(policy->'renewalProtectionDays') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
  END IF;
  days := (policy->>'renewalProtectionDays')::numeric;
  IF days <> trunc(days) OR days < 1 OR days > 3660 THEN
   RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
  END IF;
 EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
 END;
 RETURN days::integer;
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_renewal_protection_days() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_days() TO service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.inventory_available_to_promise(
 p_source_key text, p_sku text, p_as_of timestamptz, p_for_subscription_renewal boolean
)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 WITH policy AS MATERIALIZED (
  SELECT public.inventory_renewal_protection_days() days
 ), live_holds AS (
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
     WHERE s.status='active' AND s.next_cycle_at<=p_as_of+make_interval(days => (SELECT days FROM policy))
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
  FROM policy
 )
 SELECT jsonb_build_object('available_quantity',GREATEST(0,for_sale-hard_holds
   -CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END-exposure),
  'for_sale_quantity',for_sale,'hard_hold_quantity',hard_holds,'safety_quantity',0,
  'soft_subscription_demand_quantity',soft_demand,'channel_exposure_quantity',exposure)
 FROM components;
$$;
