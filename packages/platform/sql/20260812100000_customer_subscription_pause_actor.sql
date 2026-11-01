-- Customer subscription pause actor boundary.
--
-- This append-only platform forward turns the existing trusted lifecycle rail into one
-- authenticated customer command without exposing that rail as an actor API. The wrapper accepts
-- no client identifier, action name, JSON payload or requested timestamp: it derives the principal
-- from transaction-local auth.uid(), resolves the unique linked client, fixes the action to pause
-- and supplies database time. The existing lifecycle function remains the only implementation of
-- row locking, idempotent replay, event insertion and pause-window persistence.
--
-- The privilege delta is deliberately narrower than lifecycle-table RLS. Authenticated receives
-- EXECUTE on exactly the fixed pause wrapper and receives no table DML. PUBLIC, anon and
-- authenticated lose access to the trusted five-action rail and its lock helper. This preserves
-- the actor's existing own-profile SELECT policy while making the privileged mutation boundary
-- explicit and auditable.
--
-- openlup:allow-security-definer: the fixed-action wrapper must perform lifecycle writes without granting the actor table DML; its bounded inputs, principal lookup and fixed search path are proved by the customer-pause actor tests.
-- openlup:allow-grant: authenticated receives only wrapper EXECUTE while PUBLIC/anon and all actor access to the inner rail/helper are explicitly revoked and catalog-tested.

CREATE FUNCTION public.customer_subscription_pause_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_pause_preset text DEFAULT 'indefinite',
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
BEGIN
  IF p_idempotency_key IS NULL
    OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  IF p_pause_preset IS NULL
    OR p_pause_preset NOT IN ('2_weeks', '1_month', 'indefinite')
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
  END IF;

  IF p_reason IS NOT NULL
    AND (btrim(p_reason) = '' OR char_length(p_reason) > 500)
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
  END IF;

  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_lifecycle_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT client.id
    INTO v_client_id
    FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_lifecycle_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN public.subscription_apply_lifecycle_action(
    v_client_id,
    p_idempotency_key,
    p_subscription_id,
    'pause',
    jsonb_build_object('pausePreset', p_pause_preset, 'reason', p_reason),
    statement_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_apply_lifecycle_action(
  uuid, text, uuid, text, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_lifecycle_assert_unlocked_cycle(
  uuid, timestamptz
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.customer_subscription_pause_as_actor(
  uuid, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_subscription_pause_as_actor(
  uuid, text, text, text
) TO authenticated;
