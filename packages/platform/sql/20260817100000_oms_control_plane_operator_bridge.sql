-- Portable OMS control-plane operator bridge.
--
-- WHAT THIS FORWARD SHIPS. One additive, invoker-rights resolver that accepts
-- the principal already verified by the host admin-auth boundary and returns a
-- Commerce operator only when the same opaque UUID is both an active Platform
-- control operator and an existing Commerce operator. The mounted OMS reads
-- and mutations use that resolved actor; they never auto-provision authority.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP. No login or token verifier, role mapping,
-- service-role assumption, operator seed, browser grant, customer/address
-- projection, provider evidence, payment attempt, private OMS table, mutable
-- authorization routine or security-definer function.

CREATE FUNCTION public.oms_control_resolve_operator(p_principal_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT commerce_operator.id
  FROM public.platform_control_operators AS platform_operator
  JOIN public.commerce_operators AS commerce_operator
    ON commerce_operator.id = platform_operator.principal_id
  WHERE platform_operator.principal_id = p_principal_id
    AND platform_operator.active IS TRUE
$$;

REVOKE ALL ON FUNCTION public.oms_control_resolve_operator(uuid)
FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.oms_control_resolve_operator(uuid) IS
  'Resolves an already host-authenticated principal to the same active Platform-control and Commerce operator identity; returns NULL rather than provisioning authority.';
