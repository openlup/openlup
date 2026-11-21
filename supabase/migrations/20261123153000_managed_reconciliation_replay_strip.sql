-- Add pre-upgrade replay-compatibility strip for `amountMinor` and
-- `capturedAmountBasis` to managed `commerce_payment_control_apply_reconciliation_result`,
-- matching the native PostgreSQL apply RPC so root reconciliation workers can
-- converge onto `@openlup/platform/payments`.

CREATE OR REPLACE FUNCTION public.commerce_payment_control_apply_reconciliation_result(
  p_idempotency_key text,
  p_expected_order_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_payment_attempt_id uuid,
  p_expected_payment_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_local_status text,
  p_provider_status text,
  p_result_status text,
  p_occurred_at timestamptz,
  p_failure_reason text,
  p_checked_at timestamptz,
  p_payload jsonb,
  p_failure_class text DEFAULT NULL,
  p_failure_class_decided_by text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_apply jsonb;
  v_payment_result jsonb;
  v_evidence jsonb;
  v_dunning jsonb;
  v_dunning_refusal text;
  v_existing_evidence public.commerce_payment_reconciliation_runs%ROWTYPE;
  v_has_existing_evidence boolean := false;
  v_evidence_key text;
  v_evidence_payload jsonb;
  v_kind text;
  v_correction_status text;
  v_applied boolean;
  v_apply_replayed boolean;
  v_evidence_replayed boolean := false;
  v_dunning_replayed boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_expected_order_id IS NULL
    OR p_expected_payment_intent_id IS NULL
    OR p_expected_payment_attempt_id IS NULL
    OR p_expected_payment_id IS NULL
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_payment_id IS NULL OR btrim(p_provider_payment_id) = ''
    OR p_local_status IS NULL OR btrim(p_local_status) = ''
    OR p_provider_status IS NULL OR btrim(p_provider_status) = ''
    OR p_result_status NOT IN ('succeeded', 'failed')
    OR p_occurred_at IS NULL
    OR p_checked_at IS NULL
    OR (p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object')
  THEN
    RAISE EXCEPTION 'payment_reconciliation_apply_invalid_input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('commerce.payment.reconciliation.apply:' || p_idempotency_key, 0)
  );

  v_apply := public.commerce_payment_control_apply_result(
    p_idempotency_key => p_idempotency_key,
    p_payment_intent_id => p_expected_payment_intent_id,
    p_payment_event_id => NULL,
    p_result_status => p_result_status,
    p_occurred_at => p_occurred_at,
    p_failure_reason => p_failure_reason,
    p_failure_class => p_failure_class,
    p_failure_class_decided_by => p_failure_class_decided_by
  );
  v_payment_result := v_apply -> 'paymentResult';

  IF v_payment_result IS NULL
    OR v_payment_result ->> 'status' IS DISTINCT FROM p_result_status
    OR NULLIF(btrim(v_payment_result ->> 'kind'), '') IS NULL
    OR (v_payment_result ->> 'paymentIntentId')::uuid IS DISTINCT FROM p_expected_payment_intent_id
    OR (v_payment_result ->> 'paymentAttemptId')::uuid IS DISTINCT FROM p_expected_payment_attempt_id
    OR (v_payment_result ->> 'paymentId')::uuid IS DISTINCT FROM p_expected_payment_id
    OR (v_payment_result ->> 'orderId')::uuid IS DISTINCT FROM p_expected_order_id
  THEN
    RAISE EXCEPTION 'payment_reconciliation_apply_claim_mismatch' USING ERRCODE = '22023';
  END IF;

  v_kind := v_payment_result ->> 'kind';
  v_correction_status := CASE WHEN v_kind LIKE 'ignored%' THEN 'ignored' ELSE 'corrected' END;
  v_applied := v_correction_status = 'corrected';
  v_apply_replayed := COALESCE((v_payment_result ->> 'replayed')::boolean, false);

  v_evidence_key := p_idempotency_key || ':evidence';
  SELECT *
    INTO v_existing_evidence
    FROM public.commerce_payment_reconciliation_runs
   WHERE idempotency_key = v_evidence_key
   FOR UPDATE;
  v_has_existing_evidence := FOUND;

  IF v_has_existing_evidence AND v_existing_evidence.payload ->> 'dunningObservationRefusal' IN (
    'subscription_dunning_failed_attempt_unattributed',
    'subscription_dunning_case_unattributed',
    'subscription_dunning_replay_unavailable',
    'subscription_dunning_failed_attempt_ambiguous',
    'subscription_dunning_failed_attempt_rung_mismatch'
  ) THEN
    v_dunning_refusal := v_existing_evidence.payload ->> 'dunningObservationRefusal';
    v_dunning := jsonb_build_object('subscriptionWebhookDunning',
      jsonb_build_object('opened', false, 'replayed', true,
        'reason', v_dunning_refusal,
        'failedPaymentAttemptId', p_expected_payment_attempt_id));
    v_dunning_replayed := true;
  ELSIF p_result_status = 'failed' AND v_kind NOT LIKE 'ignored%' THEN
    BEGIN
      v_dunning := public.subscription_open_dunning_from_failed_payment_result(
        p_idempotency_key || ':dunning',
        p_expected_payment_intent_id,
        NULL,
        p_failure_reason,
        p_occurred_at,
        p_failure_class,
        p_expected_payment_attempt_id
      );
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF SQLERRM NOT IN (
        'subscription_dunning_failed_attempt_unattributed',
        'subscription_dunning_case_unattributed',
        'subscription_dunning_replay_unavailable',
        'subscription_dunning_failed_attempt_ambiguous',
        'subscription_dunning_failed_attempt_rung_mismatch'
      ) THEN
        RAISE;
      END IF;
      v_dunning_refusal := SQLERRM;
      v_dunning := jsonb_build_object('subscriptionWebhookDunning',
        jsonb_build_object('opened', false, 'replayed', false,
          'reason', v_dunning_refusal,
          'failedPaymentAttemptId', p_expected_payment_attempt_id));
    END;
    v_dunning_replayed := COALESCE(
      (v_dunning #>> '{subscriptionWebhookDunning,replayed}')::boolean,
      false
    );
  END IF;

  v_evidence_payload := (COALESCE(p_payload, '{}'::jsonb) - 'dunningObservationRefusal') || jsonb_build_object(
    'applied', v_applied,
    'resultStatus', p_result_status,
    'resultKind', v_kind
  );
  IF v_dunning_refusal IS NOT NULL THEN
    v_evidence_payload := v_evidence_payload || jsonb_build_object(
      'dunningObservationRefusal', v_dunning_refusal
    );
  END IF;

  IF v_has_existing_evidence THEN
    -- Upgraded callers add the observed amount and capture basis to an otherwise
    -- exact replay of a pre-upgrade evidence row.
    IF p_result_status = 'succeeded' AND v_apply_replayed
      AND NOT (v_existing_evidence.payload ? 'amountMinor')
      AND v_evidence_payload -> 'amountMinor' = (
        SELECT to_jsonb(amount_cents) FROM public.commerce_payment_attempts WHERE id = p_expected_payment_attempt_id
      ) THEN
      v_evidence_payload := v_evidence_payload - 'amountMinor';
    END IF;
    IF p_result_status = 'succeeded' AND v_apply_replayed
      AND NOT (v_existing_evidence.payload ? 'capturedAmountBasis')
      AND v_evidence_payload ->> 'capturedAmountBasis' = 'provider_capture_v1' THEN
      v_evidence_payload := v_evidence_payload - 'capturedAmountBasis';
    END IF;

    IF v_existing_evidence.provider IS DISTINCT FROM p_provider
      OR v_existing_evidence.provider_payment_id IS DISTINCT FROM p_provider_payment_id
      OR v_existing_evidence.payment_intent_id IS DISTINCT FROM p_expected_payment_intent_id
      OR v_existing_evidence.payment_attempt_id IS DISTINCT FROM p_expected_payment_attempt_id
      OR v_existing_evidence.local_status IS DISTINCT FROM p_local_status
      OR v_existing_evidence.provider_status IS DISTINCT FROM p_provider_status
      OR v_existing_evidence.correction_status IS DISTINCT FROM v_correction_status
      OR v_existing_evidence.checked_at IS DISTINCT FROM p_checked_at
      OR v_existing_evidence.payload IS DISTINCT FROM v_evidence_payload
    THEN
      RAISE EXCEPTION 'payment_reconciliation_apply_evidence_conflict' USING ERRCODE = '23505';
    END IF;
    v_evidence_replayed := true;
  END IF;

  v_evidence := public.commerce_payment_control_record_reconciliation(
    v_evidence_key,
    p_provider,
    p_provider_payment_id,
    p_expected_payment_intent_id,
    p_expected_payment_attempt_id,
    p_local_status,
    p_provider_status,
    v_correction_status,
    p_checked_at,
    v_evidence_payload
  );

  RETURN jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentReconciliationApply', jsonb_build_object(
      'paymentResult', v_payment_result,
      'paymentReconciliation', v_evidence -> 'paymentReconciliation',
      'subscriptionWebhookDunning', v_dunning -> 'subscriptionWebhookDunning',
      'correctionStatus', v_correction_status,
      'applied', v_applied,
      'applyReplayed', v_apply_replayed,
      'evidenceReplayed', v_evidence_replayed,
      'dunningReplayed', v_dunning_replayed,
      'replayed', v_apply_replayed AND v_evidence_replayed
        AND (v_dunning IS NULL OR v_dunning_replayed)
    )
  );
END;
$$;
