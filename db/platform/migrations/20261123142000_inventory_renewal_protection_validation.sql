-- Separate the value validator from the installed horizon reader used by native ATP.
CREATE FUNCTION public.inventory_renewal_protection_validate(p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
 days numeric;
BEGIN
 IF jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
 END IF;
 IF NOT (p_policy ?& ARRAY['revision','renewalProtectionDays'])
  OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('revision','renewalProtectionDays'))
  OR jsonb_typeof(p_policy->'revision') IS DISTINCT FROM 'string'
  OR (p_policy->>'revision') !~ '[^[:space:]]'
  OR jsonb_typeof(p_policy->'renewalProtectionDays') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
 END IF;
 days := (p_policy->>'renewalProtectionDays')::numeric;
 IF days <> trunc(days) OR days < 1 OR days > 3660 THEN
  RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('revision',p_policy->>'revision','renewalProtectionDays',days::integer);
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_renewal_protection_validate(jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_renewal_protection_validate(jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.inventory_renewal_protection_validate(jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_validate(jsonb) TO service_role;'; END IF; END; $$;

-- The existing STABLE stock read calls native ATP and this reader within its statement snapshot.
CREATE OR REPLACE FUNCTION public.inventory_renewal_protection_days()
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 raw_policy text;
BEGIN
 SELECT value_text INTO raw_policy FROM public.commerce_settings WHERE key='inventory_renewal_protection';
 IF NOT FOUND THEN RETURN 14; END IF;
 BEGIN
  RETURN (public.inventory_renewal_protection_validate(raw_policy::jsonb)->>'renewalProtectionDays')::integer;
 EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION 'inventory_renewal_protection_policy_invalid' USING ERRCODE='22023';
 END;
END;
$$;
