-- Admit an existing human administrator without provisioning Commerce authority.
-- Preserve the active control-operator route and every installed function attribute.
CREATE OR REPLACE FUNCTION public.oms_control_resolve_operator(p_principal_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT commerce_operator.id
  FROM public.commerce_operators AS commerce_operator
  WHERE commerce_operator.id = p_principal_id
    AND (
      EXISTS (SELECT 1 FROM public.platform_control_operators AS platform_operator
              WHERE platform_operator.principal_id = p_principal_id
                AND platform_operator.active IS TRUE)
      OR (NOT EXISTS (SELECT 1 FROM public.platform_control_operators AS platform_operator
                      WHERE platform_operator.principal_id = p_principal_id)
          AND EXISTS (SELECT 1 FROM public.platform_human_memberships AS membership
                      WHERE membership.principal_id = p_principal_id
                        AND membership.membership_state = 'active'
                        AND membership.role = 'admin'))
    )
$$;
