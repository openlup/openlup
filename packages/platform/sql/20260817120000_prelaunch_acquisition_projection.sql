-- Portable prelaunch operator detail over the existing acquisition authority.
--
-- WHAT THIS FORWARD SHIPS. One hardened, stable operator-detail routine for a
-- canonical tester-application acquisition case. It returns the same strict
-- allowlisted projection as the existing acquisition list and gives the
-- existing NOLOGIN acquisition runtime role EXECUTE on exactly that routine.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP. No tester/waitlist/feedback/client join,
-- raw contact or address value, provider payload, table, role, auth system,
-- route, workflow, secret, dependency or new lifecycle.
--
-- OPERATIONAL CONTRACT. This migration depends on the C-D23A acquisition role
-- graph and private schema. Authorization is completed by the host's verified
-- operator binding before the runtime role invokes this function. Recovery is
-- forward-only: disable the V1 route while retaining the durable case ledger.

CREATE FUNCTION public.acquisition_case_operator_get_v1(
  p_actor_id uuid,
  p_case_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_case_id uuid;
BEGIN
  IF p_actor_id IS NULL
    OR p_case_reference IS NULL
    OR p_case_reference !~ '^acquisition-case:[0-9a-f-]{36}$'
  THEN
    RAISE EXCEPTION 'acquisition_case_get_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT c.id INTO v_case_id
  FROM acquisition_private.cases AS c
  WHERE c.case_reference = p_case_reference
    AND c.source_kind = 'tester_application';

  IF v_case_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'found',
    'acquisitionCase', acquisition_private.case_projection(v_case_id)
  );
END
$function$;

ALTER FUNCTION public.acquisition_case_operator_get_v1(uuid, text)
  OWNER TO platform_acquisition_owner;
REVOKE ALL ON FUNCTION public.acquisition_case_operator_get_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquisition_case_operator_get_v1(uuid, text)
  TO platform_acquisition_runtime;
