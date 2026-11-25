-- The starter host evaluates the expiry sweep's abandonment predicate before a
-- buyer-requested cancellation. Its runtime login inherits service_role.
CREATE OR REPLACE FUNCTION public.commerce_initial_checkout_abandonment_safe(p_order_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id WHERE pi.order_id=p_order_id) AND NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=p_order_id AND
  (i.status='settled' OR i.external_ref IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=i.id)
   OR EXISTS(SELECT 1 FROM public.payment_truth_events e WHERE e.settlement_intent_id=i.id)));
$$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_initial_checkout_abandonment_safe(uuid) TO service_role;'; END IF; END; $$;
