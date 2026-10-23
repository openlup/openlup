CREATE OR REPLACE FUNCTION public.payment_truth_apply_terminal(
  p_event_id uuid,
  p_idempotency_key text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_settlement jsonb;
  v_dunning jsonb;
  v_accounting jsonb;
  v_positions jsonb;
  v_open_case_id uuid;
  v_transition_id uuid;
  v_dunning_case_id uuid;
  v_accounting_document_id uuid;
BEGIN
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_truth_event_not_found' USING ERRCODE = '22023'; END IF;
  IF v_event.state = 'settled' THEN RETURN; END IF;
  IF p_outcome NOT IN ('captured', 'refused') THEN
    RAISE EXCEPTION 'payment_truth_terminal_outcome_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'refused' AND p_failure_class IS NULL THEN
    RAISE EXCEPTION 'payment_truth_refusal_classification_required' USING ERRCODE = '22023';
  END IF;
  IF p_failure_class IS NOT NULL AND p_failure_class NOT IN (
    'authorization_refused', 'insufficient_funds', 'method_unavailable',
    'risk_refused', 'unknown_refusal'
  ) THEN
    RAISE EXCEPTION 'payment_truth_failure_class_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = v_event.settlement_intent_id;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_intent.order_id;
  IF v_intent.amount_minor IS DISTINCT FROM v_event.amount_minor
    OR v_intent.currency_code IS DISTINCT FROM v_event.currency_code
  THEN
    RAISE EXCEPTION 'payment_truth_settlement_money_mismatch' USING ERRCODE = '22023';
  END IF;

  v_settlement := public.commerce_record_settlement(
    p_idempotency_key || ':settlement',
    v_event.settlement_intent_id,
    CASE WHEN p_outcome = 'captured' THEN 'succeeded' ELSE 'failed' END,
    NULL,
    jsonb_build_object(
      'paymentTruthEventId', v_event.id,
      'sourceEvidence', COALESCE(p_source_evidence, '{}'::jsonb),
      'reason', p_failure_reason,
      'failureClass', p_failure_class
    ),
    p_occurred_at
  );
  v_transition_id := (v_settlement->>'transitionId')::uuid;

  IF p_outcome = 'captured' THEN
    -- Capture owed work only; no document construction or accounting call here.
    DECLARE v_capture_timeout text := current_setting('lock_timeout');
    BEGIN
      PERFORM set_config('lock_timeout', '100ms', true);
      PERFORM public.invoicing_capture_duty(
        p_idempotency_key || ':accounting', 'paid', v_transition_id, v_order.id,
        jsonb_build_object('settlementIntentId', v_intent.id, 'amountMinor', v_intent.amount_minor, 'currency', v_intent.currency_code),
        p_occurred_at
      );
      PERFORM set_config('lock_timeout', v_capture_timeout, true);
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      -- query_canceled during capture is absorbed so settlement/recovery commit.
      -- Append-only, no FK locks or conflicting unique key. The retained paid
      -- transition is also durable retry evidence if host ACLs deny this marker.
      BEGIN
        PERFORM set_config('lock_timeout','100ms',true);
        INSERT INTO public.invoicing_capture_faults(order_id,source_kind,source_id,attempts,state,available_at)
          VALUES(v_order.id,'paid',v_transition_id,1,'retryable',now());
        PERFORM set_config('lock_timeout',v_capture_timeout,true);
      EXCEPTION WHEN OTHERS OR query_canceled THEN NULL;
      END;
    END;

    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT id INTO v_open_case_id
      FROM public.subscription_dunning_cases
      WHERE cycle_id = v_order.subscription_cycle_id AND status = 'open'
      FOR UPDATE;
      IF v_open_case_id IS NOT NULL THEN
        PERFORM public.dunning_lifecycle_record_recovery(
          v_open_case_id, p_occurred_at, p_recovery_template_slug
        );
      END IF;
    END IF;
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT * INTO v_cycle
        FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id;
      SELECT * INTO v_subscription
        FROM public.subscriptions WHERE id = v_cycle.subscription_id;
      v_dunning := public.dunning_lifecycle_open_case(
        'payment-truth:dunning:' || v_cycle.id::text,
        v_subscription.id,
        v_cycle.id,
        v_subscription.client_id,
        1,
        NULL,
        p_failure_class,
        p_failure_reason,
        p_occurred_at,
        v_event.amount_minor,
        v_event.currency_code,
        p_dunning_template_slug,
        p_recovery_url_path
      );
      v_dunning_case_id := (v_dunning->>'caseId')::uuid;
    END IF;
  END IF;

  UPDATE public.payment_truth_events
  SET state = 'settled',
      outcome = p_outcome,
      failure_class = CASE WHEN p_outcome = 'refused' THEN p_failure_class ELSE NULL END,
      failure_reason = CASE WHEN p_outcome = 'refused' THEN p_failure_reason ELSE NULL END,
      settlement_transition_id = v_transition_id,
      dunning_case_id = v_dunning_case_id,
      accounting_document_id = v_accounting_document_id,
      settled_at = p_occurred_at,
      updated_at = p_occurred_at
  WHERE id = v_event.id;
END;
$$;
