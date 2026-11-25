-- The starter host evaluates the expiry sweep's abandonment predicate before a
-- buyer-requested cancellation. Its runtime login inherits service_role, so this
-- runtime entry delegates to the unchanged predicate and carries the only grant.
CREATE FUNCTION public.commerce_checkout_abandonment_safe_runtime(p_order_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.commerce_initial_checkout_abandonment_safe(p_order_id);
$$;

REVOKE ALL ON FUNCTION public.commerce_checkout_abandonment_safe_runtime(uuid) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_abandonment_safe_runtime(uuid) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_abandonment_safe_runtime(uuid) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_checkout_abandonment_safe_runtime(uuid) TO service_role';
END IF; END; $$;
