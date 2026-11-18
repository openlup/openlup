-- Freeze the host edit window only when a native subscription is created.
-- Legacy activation and repair functions are untouched.
-- Opt-in functions retain the predecessor bodies and invoker security mode.
-- NULL explicitly uses 72, matching the subscriptions column default.

CREATE FUNCTION public.subscription_activation_commit_with_edit_window(
  p_activation public.subscription_activations,
  p_idempotency_key text,
  p_payment_fingerprint text,
  p_paid_at timestamptz,
  p_repaired boolean,
  p_edit_window_hours integer DEFAULT NULL
)
RETURNS public.subscription_activations
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_cycle_id uuid;
  v_next_cycle_at timestamptz;
  v_activated public.subscription_activations%ROWTYPE;
BEGIN
  IF p_edit_window_hours IS NOT NULL AND p_edit_window_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'subscription_activation_edit_window_invalid' USING ERRCODE = '22023';
  END IF;
  v_next_cycle_at := p_paid_at + (p_activation.cadence_days * interval '1 day');

  INSERT INTO public.subscriptions
    (client_id, status, cadence_days, next_cycle_at, started_at, edit_window_hours)
  VALUES (p_activation.client_id, 'active', p_activation.cadence_days, v_next_cycle_at, p_paid_at,
    COALESCE(p_edit_window_hours, 72))
  RETURNING id INTO v_subscription_id;

  -- The cycle the captured payment paid for. It is written as paid because the
  -- money rail already said so; writing it as planned would make the first
  -- renewal ask for the same instant twice.
  INSERT INTO public.subscription_cycles (subscription_id, scheduled_at, status)
  VALUES (v_subscription_id, p_paid_at, 'paid')
  RETURNING id INTO v_cycle_id;

  UPDATE public.commerce_orders
     SET subscription_cycle_id = v_cycle_id, updated_at = p_paid_at
   WHERE id = p_activation.order_id;

  UPDATE public.subscription_activations
     SET state = 'active',
         subscription_id = v_subscription_id,
         payment_fingerprint = p_payment_fingerprint,
         activation_idempotency_key = p_idempotency_key,
         repaired = p_repaired,
         activated_at = p_paid_at
   WHERE order_id = p_activation.order_id
  RETURNING * INTO v_activated;

  INSERT INTO public.subscription_events
    (subscription_id, event_type, idempotency_key, payload, occurred_at)
  VALUES (
    v_subscription_id, 'subscription.activated', p_idempotency_key,
    jsonb_build_object(
      'orderId', p_activation.order_id,
      'cadenceDays', p_activation.cadence_days,
      'nextCycleAt', v_next_cycle_at,
      'repaired', p_repaired),
    p_paid_at)
  ON CONFLICT (subscription_id, idempotency_key) DO NOTHING;

  PERFORM public.subscription_capture_renewal_attachment(p_activation.order_id);
  RETURN v_activated;
END;
$$;

CREATE FUNCTION public.subscription_activate_from_captured_payment_with_edit_window(
  p_idempotency_key text,
  p_order_id uuid,
  p_payment_fingerprint text,
  p_edit_window_hours integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_activation public.subscription_activations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_payment_fingerprint text;
BEGIN
  IF p_edit_window_hours IS NOT NULL AND p_edit_window_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'subscription_activation_edit_window_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
     OR p_order_id IS NULL OR p_payment_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'subscription_activation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_activation_order_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_activation FROM public.subscription_activations
   WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_activation_not_declared' USING ERRCODE = '22023';
  END IF;

  IF v_activation.state = 'compensated' THEN
    RAISE EXCEPTION 'subscription_activation_order_compensated' USING ERRCODE = '22023';
  END IF;

  -- Preserve the public refusal order for a declaration that has never been
  -- paid. An already-active row continues below so its replay still compares
  -- the durable settlement identity before answering.
  IF v_activation.state <> 'active' AND v_order.status <> 'paid' THEN
    RAISE EXCEPTION 'subscription_activation_order_not_paid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_settlement_intents
   WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_intent.status <> 'settled' OR v_intent.settled_at IS NULL THEN
    RAISE EXCEPTION 'subscription_activation_payment_not_captured' USING ERRCODE = '22023';
  END IF;

  -- The caller may carry the opaque handle, but it does not get to define its
  -- identity. Compare its hash with the settlement row's own immutable handle
  -- before either the first write or a replay answer.
  v_payment_fingerprint := encode(sha256(convert_to(
    COALESCE(v_intent.external_ref, v_intent.id::text), 'UTF8')), 'hex');
  IF p_payment_fingerprint IS DISTINCT FROM v_payment_fingerprint THEN
    RAISE EXCEPTION 'subscription_activation_payment_fingerprint_conflict' USING ERRCODE = '23505';
  END IF;

  IF v_activation.state = 'active' THEN
    IF v_activation.payment_fingerprint IS DISTINCT FROM v_payment_fingerprint THEN
      RAISE EXCEPTION 'subscription_activation_payment_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.subscription_activation_answer(v_activation, true);
  END IF;

  RETURN public.subscription_activation_answer(
    public.subscription_activation_commit_with_edit_window(
      v_activation, p_idempotency_key, v_payment_fingerprint, v_intent.settled_at, false, p_edit_window_hours),
    false);
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_activation_commit_with_edit_window(public.subscription_activations,text,text,timestamptz,boolean,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_activate_from_captured_payment_with_edit_window(text,uuid,text,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_activation_commit_with_edit_window(public.subscription_activations,text,text,timestamptz,boolean,integer),public.subscription_activate_from_captured_payment_with_edit_window(text,uuid,text,integer) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_activation_commit_with_edit_window(public.subscription_activations,text,text,timestamptz,boolean,integer),public.subscription_activate_from_captured_payment_with_edit_window(text,uuid,text,integer) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_activation_commit_with_edit_window(public.subscription_activations,text,text,timestamptz,boolean,integer),public.subscription_activate_from_captured_payment_with_edit_window(text,uuid,text,integer) TO service_role'; END IF; END; $$;
