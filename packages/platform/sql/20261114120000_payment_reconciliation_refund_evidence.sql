-- Reconciliation history, proof-backed reopen receipts and accepted refund observations.
-- Provider reads and dispatch remain outside this transaction boundary.
CREATE TABLE public.payment_provider_reconciliation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz NOT NULL DEFAULT now(),
 provider text NOT NULL,
 provider_payment_id text,
 payment_intent_id uuid REFERENCES public.commerce_settlement_intents(id),
 payment_attempt_id uuid REFERENCES public.payment_provider_attempts(id),
 local_status text NOT NULL,
 provider_status text NOT NULL,
 correction_status text NOT NULL DEFAULT 'observed' CHECK (correction_status IN ('observed','corrected','ignored','failed')),
 idempotency_key text NOT NULL UNIQUE,
 payload jsonb NOT NULL DEFAULT '{}',
 error text
);
CREATE INDEX payment_provider_reconciliation_attempt_idx ON public.payment_provider_reconciliation_runs(payment_attempt_id,checked_at DESC);
CREATE TABLE public.payment_prepared_absence_reopens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 payment_intent_id uuid NOT NULL REFERENCES public.payment_provider_states(id),
 payment_attempt_id uuid NOT NULL UNIQUE REFERENCES public.payment_provider_attempts(id),
 subscription_cycle_id uuid NOT NULL REFERENCES public.subscription_cycles(id),
 provider_attempt_sequence integer NOT NULL CHECK (provider_attempt_sequence BETWEEN 1 AND 2147483647),
 next_retry_at timestamptz NOT NULL,
 idempotency_key text NOT NULL UNIQUE,
 evidence jsonb NOT NULL,
 consumed_key text UNIQUE,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payment_dunning_case_attribution (
 case_id uuid PRIMARY KEY REFERENCES public.subscription_dunning_cases(id),
 failed_payment_attempt_id uuid NOT NULL REFERENCES public.payment_provider_attempts(id),
 failure_receipt_id uuid NOT NULL REFERENCES public.subscription_retry_receipts(id),
 failure_observation_result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payment_refund_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_id uuid REFERENCES public.payment_truth_events(id),
 source_evidence_id uuid NOT NULL UNIQUE REFERENCES public.payment_provider_attempt_evidence(id),
 payment_intent_id uuid NOT NULL REFERENCES public.payment_provider_states(id),
 payment_attempt_id uuid NOT NULL REFERENCES public.payment_provider_attempts(id),
 provider_reference text NOT NULL,
 operation_id text NOT NULL,
 observation_kind text NOT NULL CHECK (observation_kind IN ('cumulative-snapshot','event-delta')),
 amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9223372036854775807),
 currency text NOT NULL CHECK (char_length(currency)=3),
 status text NOT NULL CHECK (status IN ('accepted','ignored')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_refund_evidence_intent_idx ON public.payment_refund_evidence(payment_intent_id,payment_attempt_id,operation_id);


CREATE FUNCTION public.commerce_payment_reconciliation_claim_stale_attempts(
  p_now timestamptz DEFAULT now(),
  p_stale_after_seconds integer DEFAULT 900,
  p_limit integer DEFAULT 50,
  p_claim_key text DEFAULT NULL
)
RETURNS TABLE (
  payment_attempt_id uuid,
  payment_intent_id uuid,
  payment_id uuid,
  order_id uuid,
  subscription_id uuid,
  subscription_cycle_id uuid,
  provider text,
  provider_payment_id text,
  provider_attempt_id text,
  provider_session_id text,
  attempt_status text,
  intent_status text,
  amount_cents bigint,
  currency text,
  order_mode text,
  cycle_retry_attempt integer,
  cycle_next_retry_at timestamptz,
  local_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_claim_key text;
  v_cutoff timestamptz;
BEGIN
  IF p_now IS NULL
    OR p_stale_after_seconds IS NULL
    OR p_stale_after_seconds < 60
    OR p_stale_after_seconds > 86400
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 500
  THEN
    RAISE EXCEPTION 'payment_reconciliation_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_claim_key := COALESCE(
    NULLIF(btrim(p_claim_key), ''),
    'payment-provider-reconciliation:' || floor(extract(epoch FROM p_now) / 1800)::bigint::text
  );
  IF length(v_claim_key) < 8 THEN
    RAISE EXCEPTION 'payment_reconciliation_claim_invalid_key' USING ERRCODE = '22023';
  END IF;

  v_cutoff := p_now - make_interval(secs => p_stale_after_seconds);

  RETURN QUERY
    WITH candidates AS (
      SELECT
        a.id AS payment_attempt_id,
        i.id AS payment_intent_id,
        i.payment_id,
        i.order_id,
        i.subscription_id,
        i.subscription_cycle_id,
        a.provider,
        CASE
          WHEN a.provider = 'tpay' THEN COALESCE(a.provider_session_id, a.provider_attempt_id, i.provider_payment_id)
          ELSE COALESCE(a.provider_attempt_id, i.provider_payment_id, a.provider_session_id)
        END AS provider_payment_id,
        a.provider_attempt_id,
        a.provider_session_id,
        a.status AS attempt_status,
        i.status AS intent_status,
        a.amount_minor AS amount_cents,
        a.currency,
        CASE WHEN o.subscription_cycle_id IS NULL THEN 'one_time' ELSE 'subscription_cycle' END AS order_mode,
        COALESCE(retry.retry_attempt, 0) AS cycle_retry_attempt,
        retry.next_retry_at AS cycle_next_retry_at,
        GREATEST(a.updated_at, i.updated_at) AS local_updated_at
      FROM public.payment_provider_attempts AS a
      JOIN (SELECT state.*, intent.order_id FROM public.payment_provider_states state
        JOIN public.commerce_settlement_intents intent ON intent.id=state.id) AS i
        ON i.id = a.settlement_intent_id
       AND i.active_attempt_id = a.id
      JOIN public.commerce_orders AS o
        ON o.id = i.order_id
      LEFT JOIN public.subscription_cycles AS c
        ON c.id = i.subscription_cycle_id
       AND c.subscription_id = i.subscription_id
      LEFT JOIN public.subscription_retry_obligations retry ON retry.cycle_id=c.id
      LEFT JOIN LATERAL (
        SELECT max(r.checked_at) AS last_checked_at
          FROM public.payment_provider_reconciliation_runs AS r
         WHERE r.payment_attempt_id = a.id
      ) AS latest_run ON true
      WHERE (
          (
            i.target_kind = 'subscription_cycle'
            AND o.subscription_cycle_id IS NOT NULL
            AND i.subscription_id IS NOT NULL
            AND i.subscription_cycle_id IS NOT NULL
            AND c.subscription_id = i.subscription_id
            AND o.subscription_cycle_id = i.subscription_cycle_id
            AND c.id IS NOT NULL
          )
          OR (
            i.target_kind = 'one_time_order'
            AND o.subscription_cycle_id IS NULL
            AND i.subscription_id IS NULL
            AND i.subscription_cycle_id IS NULL
            
            AND o.subscription_cycle_id IS NULL
          )
        )
        AND i.status IN ('requires_action', 'processing')
        AND a.status IN ('sent_to_provider', 'requires_action', 'processing')
        AND a.provider IN ('stripe', 'tpay')
        AND GREATEST(a.updated_at, i.updated_at) <= v_cutoff
        AND (
          a.provider_attempt_id IS NOT NULL
          OR a.provider_session_id IS NOT NULL
          OR i.provider_payment_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.payment_provider_reconciliation_runs AS r
           WHERE r.payment_attempt_id = a.id
             AND r.correction_status = 'corrected'
             AND r.provider_status IN ('succeeded', 'failed')
        )
      ORDER BY latest_run.last_checked_at ASC NULLS FIRST,
               GREATEST(a.updated_at, i.updated_at) ASC,
               a.id ASC
      LIMIT p_limit
      FOR UPDATE OF a SKIP LOCKED
    ),
    claimed AS (
      INSERT INTO public.payment_provider_reconciliation_runs (
        provider,
        provider_payment_id,
        payment_intent_id,
        payment_attempt_id,
        local_status,
        provider_status,
        correction_status,
        idempotency_key,
        checked_at,
        payload
      )
      SELECT
        candidates.provider,
        candidates.provider_payment_id,
        candidates.payment_intent_id,
        candidates.payment_attempt_id,
        candidates.attempt_status,
        'claiming',
        'observed',
        v_claim_key || ':' || candidates.payment_attempt_id::text,
        p_now,
        jsonb_build_object(
          'source', 'payment-provider-reconciliation.claim.v0',
          'intentStatus', candidates.intent_status,
          'orderId', candidates.order_id,
          'subscriptionId', candidates.subscription_id,
          'subscriptionCycleId', candidates.subscription_cycle_id,
          'staleAfterSeconds', p_stale_after_seconds
        )
      FROM candidates
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING public.payment_provider_reconciliation_runs.payment_attempt_id
    )
    SELECT
      candidates.payment_attempt_id,
      candidates.payment_intent_id,
      candidates.payment_id,
      candidates.order_id,
      candidates.subscription_id,
      candidates.subscription_cycle_id,
      candidates.provider,
      candidates.provider_payment_id,
      candidates.provider_attempt_id,
      candidates.provider_session_id,
      candidates.attempt_status,
      candidates.intent_status,
      candidates.amount_cents,
      candidates.currency,
      candidates.order_mode,
      candidates.cycle_retry_attempt,
      candidates.cycle_next_retry_at,
      candidates.local_updated_at
    FROM candidates
    JOIN claimed
      ON claimed.payment_attempt_id = candidates.payment_attempt_id
    ORDER BY candidates.local_updated_at ASC, candidates.payment_attempt_id ASC;
END;
$$;

CREATE FUNCTION public.commerce_payment_reconciliation_claim_prepared_attempts(
  p_now timestamptz DEFAULT now(),
  p_stale_after_seconds integer DEFAULT 900,
  p_limit integer DEFAULT 50,
  p_claim_key text DEFAULT NULL
)
RETURNS TABLE (
  payment_attempt_id uuid,
  payment_intent_id uuid,
  payment_id uuid,
  order_id uuid,
  subscription_id uuid,
  subscription_cycle_id uuid,
  provider text,
  provider_payment_id text,
  provider_attempt_id text,
  provider_session_id text,
  attempt_status text,
  intent_status text,
  amount_cents bigint,
  currency text,
  order_mode text,
  cycle_retry_attempt integer,
  cycle_next_retry_at timestamptz,
  local_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_claim_key text;
  v_cutoff timestamptz;
BEGIN
  IF p_now IS NULL
    OR p_stale_after_seconds IS NULL
    OR p_stale_after_seconds < 60
    OR p_stale_after_seconds > 86400
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 500
  THEN
    RAISE EXCEPTION 'payment_reconciliation_prepared_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  v_claim_key := COALESCE(
    NULLIF(btrim(p_claim_key), ''),
    'payment-provider-reconciliation:prepared:' || floor(extract(epoch FROM p_now) / 1800)::bigint::text
  );
  IF length(v_claim_key) < 8 THEN
    RAISE EXCEPTION 'payment_reconciliation_prepared_claim_invalid_key' USING ERRCODE = '22023';
  END IF;

  v_cutoff := p_now - make_interval(secs => p_stale_after_seconds);

  RETURN QUERY
    WITH candidates AS (
      SELECT
        a.id AS payment_attempt_id,
        i.id AS payment_intent_id,
        i.payment_id,
        i.order_id,
        i.subscription_id,
        i.subscription_cycle_id,
        a.provider,
        NULL::text AS provider_payment_id,
        a.provider_attempt_id,
        a.provider_session_id,
        a.status AS attempt_status,
        i.status AS intent_status,
        a.amount_minor AS amount_cents,
        a.currency,
        CASE WHEN o.subscription_cycle_id IS NULL THEN 'one_time' ELSE 'subscription_cycle' END AS order_mode,
        COALESCE(retry.retry_attempt, 0) AS cycle_retry_attempt,
        retry.next_retry_at AS cycle_next_retry_at,
        GREATEST(a.updated_at, i.updated_at) AS local_updated_at,
        a.request_payload
      FROM public.payment_provider_attempts AS a
      JOIN (SELECT state.*, intent.order_id FROM public.payment_provider_states state
        JOIN public.commerce_settlement_intents intent ON intent.id=state.id) AS i
        ON i.id = a.settlement_intent_id
       AND i.active_attempt_id = a.id
      JOIN public.commerce_orders AS o
        ON o.id = i.order_id
      LEFT JOIN public.subscription_cycles AS c
        ON c.id = i.subscription_cycle_id
       AND c.subscription_id = i.subscription_id
      LEFT JOIN public.subscription_retry_obligations retry ON retry.cycle_id=c.id
      LEFT JOIN LATERAL (
        SELECT max(r.checked_at) AS last_checked_at
          FROM public.payment_provider_reconciliation_runs AS r
         WHERE r.payment_attempt_id = a.id
      ) AS latest_run ON true
      WHERE (
          (
            i.target_kind = 'subscription_cycle'
            AND o.subscription_cycle_id IS NOT NULL
            AND i.subscription_id IS NOT NULL
            AND i.subscription_cycle_id IS NOT NULL
            AND c.subscription_id = i.subscription_id
            AND o.subscription_cycle_id = i.subscription_cycle_id
            AND c.status = 'payment_pending'
          )
          OR (
            i.target_kind = 'one_time_order'
            AND o.subscription_cycle_id IS NULL
            AND i.subscription_id IS NULL
            AND i.subscription_cycle_id IS NULL
            
            AND o.subscription_cycle_id IS NULL
          )
        )
        AND i.status IN ('requires_action', 'processing')
        AND a.status = 'created'
        AND a.provider IN ('stripe', 'tpay')
        AND a.provider_attempt_id IS NULL
        AND a.provider_session_id IS NULL
        AND i.provider_payment_id IS NULL
        AND GREATEST(a.updated_at, i.updated_at) <= v_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM public.payment_provider_reconciliation_runs AS r
           WHERE r.payment_attempt_id = a.id
             AND r.correction_status = 'corrected'
             AND r.provider_status IN ('succeeded', 'failed')
        )
      ORDER BY latest_run.last_checked_at ASC NULLS FIRST,
               GREATEST(a.updated_at, i.updated_at) ASC,
               a.id ASC
      LIMIT p_limit
      FOR UPDATE OF a SKIP LOCKED
    ),
    claimed AS (
      INSERT INTO public.payment_provider_reconciliation_runs (
        provider,
        provider_payment_id,
        payment_intent_id,
        payment_attempt_id,
        local_status,
        provider_status,
        correction_status,
        idempotency_key,
        checked_at,
        payload
      )
      SELECT
        candidates.provider,
        NULL::text,
        candidates.payment_intent_id,
        candidates.payment_attempt_id,
        candidates.attempt_status,
        'prepared_attempt_claiming',
        'observed',
        v_claim_key || ':prepared:' || candidates.payment_attempt_id::text,
        p_now,
        jsonb_build_object(
          'source', 'payment-provider-reconciliation.prepared-claim.v0',
          'intentStatus', candidates.intent_status,
          'orderId', candidates.order_id,
          'subscriptionId', candidates.subscription_id,
          'subscriptionCycleId', candidates.subscription_cycle_id,
          'staleAfterSeconds', p_stale_after_seconds,
          'providerFlow', candidates.request_payload ->> 'providerFlow',
          'hasProviderIdempotencyKey', candidates.request_payload ? 'providerIdempotencyKey',
          'hasProviderRequestFingerprint', candidates.request_payload ? 'providerRequestFingerprint',
          'providerCallPlanned', true,
          'providerAcknowledged', false
        )
      FROM candidates
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING public.payment_provider_reconciliation_runs.payment_attempt_id
    )
    SELECT
      candidates.payment_attempt_id,
      candidates.payment_intent_id,
      candidates.payment_id,
      candidates.order_id,
      candidates.subscription_id,
      candidates.subscription_cycle_id,
      candidates.provider,
      candidates.provider_payment_id,
      candidates.provider_attempt_id,
      candidates.provider_session_id,
      candidates.attempt_status,
      candidates.intent_status,
      candidates.amount_cents,
      candidates.currency,
      candidates.order_mode,
      candidates.cycle_retry_attempt,
      candidates.cycle_next_retry_at,
      candidates.local_updated_at
    FROM candidates
    JOIN claimed
      ON claimed.payment_attempt_id = candidates.payment_attempt_id
    ORDER BY candidates.local_updated_at ASC, candidates.payment_attempt_id ASC;
END;
$$;

CREATE FUNCTION public.commerce_payment_control_record_reconciliation(
  p_idempotency_key text,
  p_provider text,
  p_provider_payment_id text,
  p_payment_intent_id uuid,
  p_payment_attempt_id uuid,
  p_local_status text,
  p_provider_status text,
  p_correction_status text,
  p_checked_at timestamptz,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run public.payment_provider_reconciliation_runs%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_local_status IS NULL OR btrim(p_local_status) = ''
    OR p_provider_status IS NULL OR btrim(p_provider_status) = ''
    OR p_correction_status NOT IN ('observed', 'corrected', 'ignored', 'failed')
  THEN
    RAISE EXCEPTION 'payment_control_reconciliation_invalid_input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_provider_reconciliation_runs (
    provider,
    provider_payment_id,
    payment_intent_id,
    payment_attempt_id,
    local_status,
    provider_status,
    correction_status,
    idempotency_key,
    checked_at,
    payload
  )
  VALUES (
    p_provider,
    p_provider_payment_id,
    p_payment_intent_id,
    p_payment_attempt_id,
    p_local_status,
    p_provider_status,
    p_correction_status,
    p_idempotency_key,
    COALESCE(p_checked_at, now()),
    COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET payload = public.payment_provider_reconciliation_runs.payload
  RETURNING * INTO v_run;

  IF p_payment_intent_id IS NOT NULL THEN
    INSERT INTO public.payment_provider_transitions (
      settlement_intent_id,
      payment_attempt_id,
      transition_kind,
      from_status,
      to_status,
      reason,
      idempotency_key,
      occurred_at,
      payload
    )
    VALUES (
      p_payment_intent_id,
      p_payment_attempt_id,
      'reconciliation',
      p_local_status,
      p_provider_status,
      p_correction_status,
      p_idempotency_key || ':reconciliation',
      COALESCE(p_checked_at, now()),
      COALESCE(p_payload, '{}'::jsonb)
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentReconciliation', jsonb_build_object(
      'id', v_run.id,
      'paymentIntentId', p_payment_intent_id,
      'paymentAttemptId', p_payment_attempt_id,
      'localStatus', p_local_status,
      'providerStatus', p_provider_status,
      'correctionStatus', p_correction_status,
      'idempotencyKey', p_idempotency_key
    )
  );
END;
$$;

CREATE FUNCTION public.commerce_payment_control_apply_reconciliation_result(
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
  p_failure_class_decided_by text DEFAULT NULL,
  p_dunning_template_slug text DEFAULT 'payment_failed',
  p_recovery_url_path text DEFAULT '/recover',
  p_recovery_template_slug text DEFAULT 'recovered'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_apply jsonb;
  v_payment_result jsonb;
  v_evidence jsonb;
  v_dunning jsonb;
  v_dunning_refusal text;
  v_existing_evidence public.payment_provider_reconciliation_runs%ROWTYPE;
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
  v_apply := public.payment_provider_result_apply(
    p_idempotency_key => p_idempotency_key,
    p_payment_intent_id => p_expected_payment_intent_id,
    p_payment_event_id => NULL,
    p_result_status => p_result_status,
    p_occurred_at => p_occurred_at,
    p_failure_reason => p_failure_reason,
    p_failure_class => p_failure_class,
    p_failure_class_decided_by => p_failure_class_decided_by,
    p_dunning_template_slug => p_dunning_template_slug,
    p_recovery_url_path => p_recovery_url_path,
    p_recovery_template_slug => p_recovery_template_slug
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
    FROM public.payment_provider_reconciliation_runs
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
      v_dunning := public.payment_reconciliation_open_dunning_from_failed_result(
        p_idempotency_key || ':dunning',
        p_expected_payment_intent_id,
        NULL,
        p_failure_reason,
        p_occurred_at,
        p_failure_class,
        p_expected_payment_attempt_id, p_dunning_template_slug, p_recovery_url_path
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

CREATE FUNCTION public.payment_reconciliation_open_dunning_from_failed_result(
 p_idempotency_key text,p_payment_intent_id uuid,p_provider_event_id text,p_failure_reason text,
 p_occurred_at timestamptz,p_failure_class text,p_failed_payment_attempt_id uuid,
 p_template text,p_recovery_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.payment_provider_states; i public.commerce_settlement_intents;
 obligation public.subscription_retry_obligations; failure public.subscription_retry_receipts;
 existing_case public.subscription_dunning_cases; attribution public.payment_dunning_case_attribution;
 receipt public.payment_provider_receipts; result jsonb; fingerprint text;
 rung integer; rung_count integer; case_result jsonb; recovery_token text; recovery_path text; token_expiry timestamptz;
BEGIN
 IF p_idempotency_key IS NULL OR length(p_idempotency_key)<8 OR btrim(p_idempotency_key)=''
  OR p_payment_intent_id IS NULL THEN
  RAISE EXCEPTION 'subscription_webhook_dunning_invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=p_payment_intent_id FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'subscription_webhook_dunning_intent_not_found' USING ERRCODE='22023'; END IF;
 IF s.subscription_cycle_id IS NULL THEN
  RETURN jsonb_build_object('subscriptionWebhookDunning',jsonb_build_object('opened',false,'replayed',false,'reason','not_subscription_cycle')); END IF;
 SELECT * INTO obligation FROM public.subscription_retry_obligations
  WHERE settlement_intent_id=i.id AND renewal_operation_id=i.renewal_operation_id
   AND cycle_id=s.subscription_cycle_id AND subscription_id=s.subscription_id AND order_id=i.order_id FOR UPDATE;
 IF obligation.id IS NULL OR obligation.retry_attempt<1 OR obligation.state='recovered'
  OR NOT EXISTS(SELECT 1 FROM public.subscriptions sub JOIN public.subscription_cycles c ON c.subscription_id=sub.id
   WHERE sub.id=s.subscription_id AND sub.status='active' AND c.id=s.subscription_cycle_id AND c.status='payment_pending') THEN
  RETURN jsonb_build_object('subscriptionWebhookDunning',jsonb_build_object('opened',false,'replayed',false,'reason','not_dunning_eligible')); END IF;
 SELECT min((r.result->>'retry_attempt')::integer),count(DISTINCT r.result->>'retry_attempt')
 INTO rung,rung_count FROM public.subscription_retry_receipts r
 JOIN public.payment_provider_attempts a ON a.id=p_failed_payment_attempt_id AND a.settlement_intent_id=i.id
 WHERE r.obligation_id=obligation.id AND r.kind='failure'
  AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'paymentAttemptId'=a.id::text
  AND r.input->>'paymentId'=s.payment_id::text AND r.input->>'subscriptionCycleId'=s.subscription_cycle_id::text
  AND r.input->>'renewalOperationId'=i.renewal_operation_id::text
  AND r.result->>'retry_attempt' ~ '^[1-9][0-9]{0,8}$'
  AND EXISTS(SELECT 1 FROM public.payment_provider_transitions t WHERE t.settlement_intent_id=i.id
   AND t.payment_attempt_id=a.id AND t.transition_kind='business_result' AND t.to_status='failed'
   AND t.reason NOT LIKE 'ignored%' AND t.payload->>'retryFailureKey'=r.receipt_key
   AND (p_provider_event_id IS NULL OR t.provider_event_id IN
    (SELECT id FROM public.payment_provider_attempt_evidence WHERE provider_event_id=p_provider_event_id AND payment_attempt_id=a.id)));
 IF p_failed_payment_attempt_id IS NULL OR rung_count<>1 THEN
  RAISE EXCEPTION 'subscription_dunning_failed_attempt_unattributed' USING ERRCODE='55000'; END IF;
 SELECT * INTO failure FROM public.subscription_retry_receipts r WHERE r.obligation_id=obligation.id AND r.kind='failure'
  AND r.input->>'paymentAttemptId'=p_failed_payment_attempt_id::text AND (r.result->>'retry_attempt')::integer=rung ORDER BY r.id LIMIT 1;
 fingerprint:=md5(i.id::text||'|'||p_failed_payment_attempt_id::text||'|'||rung::text||'|'||
  COALESCE(p_failure_reason,'')||'|'||COALESCE(p_occurred_at::text,''));
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='subscription.dunning.failure'
  AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.request_fingerprint=fingerprint AND receipt.response_payload IS NOT NULL THEN
   RETURN jsonb_set(receipt.response_payload,'{subscriptionWebhookDunning,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'subscription_dunning_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO existing_case FROM public.subscription_dunning_cases WHERE cycle_id=s.subscription_cycle_id FOR UPDATE;
 IF FOUND THEN
  SELECT * INTO attribution FROM public.payment_dunning_case_attribution WHERE case_id=existing_case.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_dunning_case_unattributed' USING ERRCODE='55000'; END IF;
  IF attribution.failed_payment_attempt_id=p_failed_payment_attempt_id OR rung<existing_case.retry_attempt THEN
   IF attribution.failure_observation_result IS NULL THEN
    RAISE EXCEPTION 'subscription_dunning_replay_unavailable' USING ERRCODE='55000'; END IF;
   result:=jsonb_set(attribution.failure_observation_result,'{subscriptionWebhookDunning,replayed}','true'::jsonb,false);
  ELSIF rung=existing_case.retry_attempt THEN
   RAISE EXCEPTION 'subscription_dunning_failed_attempt_ambiguous' USING ERRCODE='55000'; END IF;
 END IF;
 IF result IS NULL THEN
  IF rung IS DISTINCT FROM obligation.retry_attempt THEN
   RAISE EXCEPTION 'subscription_dunning_failed_attempt_rung_mismatch' USING ERRCODE='55000'; END IF;
  IF existing_case.id IS NOT NULL AND obligation.case_id IS DISTINCT FROM existing_case.id THEN
   RAISE EXCEPTION 'subscription_dunning_case_unattributed' USING ERRCODE='55000'; END IF;
  case_result:=public.subscription_retry_open_case(i.renewal_operation_id,p_template,p_recovery_path);
  token_expiry:=now()+CASE WHEN obligation.next_retry_at IS NULL AND rung>=4
   THEN interval '30 days' ELSE interval '14 days' END;
  recovery_token:='rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  PERFORM public.dunning_lifecycle_issue_recovery_token((case_result->>'caseId')::uuid,
   encode(sha256(convert_to(recovery_token,'UTF8')),'hex'),token_expiry);
  recovery_path:=p_recovery_path||CASE WHEN position('?' IN p_recovery_path)>0 THEN '&' ELSE '?' END||'token='||recovery_token;
  UPDATE public.subscription_dunning_notifications SET recovery_url_path=recovery_path
   WHERE case_id=(case_result->>'caseId')::uuid AND recipient_kind='customer' AND retry_attempt=CASE WHEN obligation.next_retry_at IS NULL THEN 0 ELSE rung END;
  result:=jsonb_build_object('subscriptionWebhookDunning',jsonb_build_object('opened',true,'replayed',false,
   'caseId',case_result->>'caseId','subscriptionId',s.subscription_id,'cycleId',s.subscription_cycle_id,
   'orderId',i.order_id,'paymentIntentId',i.id,'retryAttempt',rung,'nextRetryAt',failure.result->'next_retry_at'));
  INSERT INTO public.payment_dunning_case_attribution(case_id,failed_payment_attempt_id,failure_receipt_id,failure_observation_result)
  VALUES((case_result->>'caseId')::uuid,p_failed_payment_attempt_id,failure.id,result)
  ON CONFLICT(case_id) DO UPDATE SET failed_payment_attempt_id=EXCLUDED.failed_payment_attempt_id,
   failure_receipt_id=EXCLUDED.failure_receipt_id,failure_observation_result=EXCLUDED.failure_observation_result,updated_at=now();
 END IF;
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('subscription.dunning.failure',p_idempotency_key,fingerprint,'completed',result,
  jsonb_build_object('failedPaymentAttemptId',p_failed_payment_attempt_id,'failureReceiptId',failure.id));
 RETURN result;
END;
$$;

CREATE FUNCTION public.payment_refund_evidence_record(p_event_id uuid,p_reference text,p_amount bigint,p_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e public.payment_provider_attempt_evidence; a public.payment_provider_attempts;
 i public.commerce_settlement_intents; prior bigint; observation text; operation text; recorded public.payment_refund_evidence;
BEGIN
 SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_event_id;
 PERFORM public.payment_provider_lock_aggregate(e.settlement_intent_id);
 SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_event_id FOR UPDATE;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=e.settlement_intent_id;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=e.payment_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF e.id IS NULL OR a.id IS NULL OR e.event_type IS DISTINCT FROM 'payment.refunded'
  OR e.signature_verified IS DISTINCT FROM true OR e.provider IS DISTINCT FROM a.provider
  OR e.provider_payment_id IS DISTINCT FROM a.provider_attempt_id
  OR p_reference IS DISTINCT FROM e.provider_payment_id OR p_currency IS DISTINCT FROM i.currency_code
  OR e.currency IS DISTINCT FROM i.currency_code OR p_amount IS NULL OR p_amount<1 THEN
  RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
 IF e.provider='stripe' THEN
  IF e.payload->>'eventType' IS DISTINCT FROM 'charge.refunded'
   OR e.payload->>'providerPaymentId' IS DISTINCT FROM e.provider_payment_id
   OR NULLIF(btrim(e.payload#>>'{stripeRefundSnapshot,chargeId}'),'') IS NULL
   OR jsonb_typeof(e.payload#>'{stripeRefundSnapshot,amountRefundedMinor}') IS DISTINCT FROM 'number'
   OR COALESCE(e.payload#>>'{stripeRefundSnapshot,amountRefundedMinor}','') !~ '^[0-9]{1,10}$'
   OR e.amount_minor IS DISTINCT FROM i.amount_minor THEN
   RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  IF p_amount IS DISTINCT FROM (e.payload#>>'{stripeRefundSnapshot,amountRefundedMinor}')::bigint OR p_amount>i.amount_minor THEN
   RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  observation:='cumulative-snapshot'; operation:=e.payload#>>'{stripeRefundSnapshot,chargeId}';
 ELSE
  IF e.payload#>>'{openlupEvidence,refund,kind}'='event-delta' THEN
   IF jsonb_typeof(e.payload#>'{openlupEvidence,refund,refundedMoney,amountMinor}') IS DISTINCT FROM 'number'
    OR COALESCE(e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}','') !~ '^[0-9]{1,10}$'
    OR p_amount IS DISTINCT FROM (e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}')::bigint
    OR e.payload#>>'{openlupEvidence,refund,refundedMoney,currency}' IS DISTINCT FROM p_currency THEN
    RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  ELSIF p_amount IS DISTINCT FROM e.amount_minor THEN
   RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
  observation:='event-delta'; operation:=e.provider_event_id;
 END IF;
 SELECT * INTO recorded FROM public.payment_refund_evidence WHERE source_evidence_id=e.id;
 IF FOUND THEN
  IF recorded.provider_reference IS DISTINCT FROM p_reference OR recorded.amount_minor IS DISTINCT FROM p_amount
   OR recorded.currency IS DISTINCT FROM p_currency THEN
   RAISE EXCEPTION 'payment_refund_evidence_conflict' USING ERRCODE='23505'; END IF;
  RETURN to_jsonb(recorded); END IF;
 SELECT max(amount_minor) INTO prior FROM public.payment_refund_evidence
  WHERE payment_intent_id=i.id AND payment_attempt_id=a.id AND operation_id=operation AND currency=p_currency AND status='accepted';
 INSERT INTO public.payment_refund_evidence(event_id,source_evidence_id,payment_intent_id,payment_attempt_id,
  provider_reference,operation_id,observation_kind,amount_minor,currency,status)
 VALUES((SELECT id FROM public.payment_truth_events WHERE settlement_intent_id=i.id AND outcome='captured' ORDER BY id LIMIT 1),
  e.id,i.id,a.id,p_reference,operation,observation,p_amount,p_currency,
  CASE WHEN observation='cumulative-snapshot' AND prior>=p_amount THEN 'ignored' ELSE 'accepted' END) RETURNING * INTO recorded;
 RETURN to_jsonb(recorded);
END;
$$;

CREATE FUNCTION public.payment_refund_readback(p_intent_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 WITH observations AS (
  SELECT r.*,e.provider_event_id,e.created_at AS received_at FROM public.payment_refund_evidence r
   JOIN public.payment_provider_attempt_evidence e ON e.id=r.source_evidence_id
   JOIN public.commerce_settlement_intents i ON i.id=r.payment_intent_id AND i.currency_code=r.currency
   WHERE r.payment_intent_id=p_intent_id AND r.status IN ('accepted','ignored')
 ), amounts AS (
  SELECT payment_attempt_id,operation_id,currency,max(amount_minor) AS amount_minor
   FROM observations GROUP BY payment_attempt_id,operation_id,currency
 ) SELECT CASE WHEN count(*)>0 AND count(DISTINCT currency)=1 THEN
  jsonb_build_object('refundCents',sum(amount_minor),'currency',min(currency),'refundEvidenceVersion','provider-refund.v2',
   'providerEventIds',(SELECT jsonb_agg(provider_event_id ORDER BY received_at,id) FROM observations),
   'amountSource','payment_refund_evidence.accepted_same_currency') ELSE NULL END FROM amounts;
$$;

CREATE FUNCTION public.commerce_order_provider_refund_evidence(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT public.payment_refund_readback(i.id) FROM public.commerce_settlement_intents i
 WHERE i.order_id=p_order_id AND EXISTS(SELECT 1 FROM public.payment_refund_evidence r
   JOIN public.payment_provider_attempt_evidence e ON e.id=r.source_evidence_id
   WHERE r.payment_intent_id=i.id AND r.status='accepted')
 AND NOT EXISTS(SELECT 1 FROM public.payment_refund_evidence r
   JOIN public.payment_provider_attempt_evidence e ON e.id=r.source_evidence_id
   WHERE r.payment_intent_id=i.id AND e.provider='stripe' AND r.status='accepted' AND r.amount_minor<i.amount_minor
   AND NOT EXISTS(SELECT 1 FROM public.payment_refund_evidence full_refund WHERE full_refund.payment_intent_id=r.payment_intent_id
    AND full_refund.payment_attempt_id=r.payment_attempt_id AND full_refund.operation_id=r.operation_id
    AND full_refund.currency=r.currency AND full_refund.status='accepted' AND full_refund.amount_minor=i.amount_minor));
$$;

CREATE FUNCTION public.payment_refund_apply_result(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents; s public.payment_provider_states; a public.payment_provider_attempts;
 e public.payment_provider_attempt_evidence; purchase public.commerce_orders; held record; accepted jsonb;
 amount bigint; fingerprint text; receipt public.payment_provider_receipts; kind text:='state_changed';
 target_status text; answer jsonb; financial jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR length(p_idempotency_key)<8 OR btrim(p_idempotency_key)=''
  OR p_payment_intent_id IS NULL OR p_result_status IS NULL OR p_result_status NOT IN ('refunded','partially_refunded','disputed')
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,'')||CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class='||p_failure_class END);
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.request_fingerprint=fingerprint AND receipt.response_payload IS NOT NULL THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentResult,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=p_payment_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF s.status NOT IN ('succeeded','partially_refunded','refunded','disputed') THEN
  RAISE EXCEPTION 'payment_control_result_refund_or_dispute_requires_success' USING ERRCODE='22023'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=i.order_id;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id FOR UPDATE;
  IF e.id IS NULL OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
   RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS NULL THEN RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF e.currency IS NOT NULL AND e.currency<>i.currency_code THEN
   RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE='22023'; END IF;
  IF p_result_status IN ('refunded','partially_refunded') THEN
   amount:=CASE WHEN e.provider='stripe' AND e.payload#>>'{stripeRefundSnapshot,amountRefundedMinor}' ~ '^[0-9]{1,10}$'
    THEN (e.payload#>>'{stripeRefundSnapshot,amountRefundedMinor}')::bigint
    WHEN e.payload#>>'{openlupEvidence,refund,kind}'='event-delta' THEN
     CASE WHEN e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}' ~ '^[0-9]{1,10}$'
      THEN (e.payload#>>'{openlupEvidence,refund,refundedMoney,amountMinor}')::bigint END
    ELSE e.amount_minor END;
   IF e.provider='stripe' AND ((p_result_status='refunded') IS DISTINCT FROM (amount=i.amount_minor)) THEN
    RAISE EXCEPTION 'payment_control_result_refund_snapshot_unproven' USING ERRCODE='22023'; END IF;
   accepted:=public.payment_refund_evidence_record(e.id,e.provider_payment_id,amount,e.currency);
   IF e.provider='stripe' AND (accepted->>'status'='ignored' OR (s.status='refunded' AND p_result_status='partially_refunded')) THEN
    kind:='ignored_stripe_refund_snapshot'; END IF;
  END IF;
 END IF;
 target_status:=CASE WHEN kind LIKE 'ignored%' THEN s.status ELSE p_result_status END;
 IF kind='state_changed' THEN
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
  IF p_result_status='refunded' THEN
   IF e.id IS NOT NULL THEN UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status='processed' WHERE id=e.id; END IF;
   UPDATE public.commerce_orders SET status='refunded',metadata=metadata||jsonb_build_object(
    'paymentStatus','refunded','source','payment.control.v0'),updated_at=now() WHERE id=purchase.id;
   IF purchase.subscription_cycle_id IS NULL OR EXISTS(SELECT 1 FROM public.subscription_activations activation
    JOIN public.subscriptions sub ON sub.id=activation.subscription_id
    WHERE activation.order_id=purchase.id AND sub.status IN ('active','pending_activation')) THEN
    FOR held IN SELECT id FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=purchase.id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation('payment-refund:'||held.id,held.id,
      CASE WHEN purchase.subscription_cycle_id IS NULL THEN 'one_time_order_refunded' ELSE 'subscription_activation_refunded' END,'{}'::jsonb,p_occurred_at);
    END LOOP;
   END IF;
   financial:=public.commerce_order_provider_refund_evidence(purchase.id);
   IF financial IS NOT NULL AND financial->>'currency'=purchase.currency_code AND purchase.metadata->>'source' IS DISTINCT FROM 'admin_manual_refund' THEN
    INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES('commerce_order',purchase.id,'commerce.order.refund_processed','order_refund_processed:'||purchase.id,
     financial||jsonb_build_object('orderId','order_'||purchase.id,'orderUuid',purchase.id,'occurredAt',p_occurred_at),
     jsonb_build_object('source','payment_refund_apply_result')) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
   END IF;
  END IF;
 END IF;
 IF e.id IS NOT NULL THEN UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),
  processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id; END IF;
 IF p_failure_class IS NOT NULL THEN UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,
  response_payload=response_payload||CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb
   ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id; END IF;
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,
  from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,e.id,CASE WHEN p_result_status='disputed' THEN 'dispute' ELSE 'refund' END,s.status,target_status,kind,
  p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',purchase.id,'resultStatus',p_result_status,'source','payment.control.v0'));
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,
  'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',purchase.id,'status',target_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id));
 RETURN answer;
END;
$$;

CREATE FUNCTION public.commerce_payment_control_reopen_prepared_attempt_after_absence(
  p_idempotency_key text,
  p_payment_attempt_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_subscription_cycle_id uuid,
  p_operator_ref text,
  p_absence_checked_at timestamptz,
  p_next_retry_at timestamptz,
  p_absence_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.prepared_absence_reopen';
  v_min_stranded_age constant interval := interval '30 minutes';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_intent record;
  v_cycle record;
  v_order public.commerce_orders%ROWTYPE;
  v_latest_local_write timestamptz;
  v_from_attempt_status text;
  v_next_sequence integer;
  v_response jsonb;
  v_evidence jsonb;
BEGIN
  v_evidence := COALESCE(p_absence_evidence, '{}'::jsonb);

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_payment_attempt_id IS NULL
    OR p_expected_payment_intent_id IS NULL
    OR p_expected_subscription_cycle_id IS NULL
    OR p_operator_ref IS NULL OR btrim(p_operator_ref) = '' OR length(btrim(p_operator_ref)) > 160
    OR p_absence_checked_at IS NULL
    OR p_next_retry_at IS NULL
    OR jsonb_typeof(v_evidence) <> 'object'
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF p_absence_checked_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_absence_checked_at_in_future' USING ERRCODE = '22023';
  END IF;

  IF NOT (v_evidence @> '{"providerAbsenceConfirmed": true}'::jsonb) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_requires_provider_absence_proof' USING ERRCODE = '22023';
  END IF;

  IF lower(v_evidence::text) ~ '(paymentmethodref|payment_method_ref|providermethodref|provider_method_ref|providercustomerref|provider_customer_ref|clientsecret|client_secret|recoverytoken|recovery_token|token_hash|blikcode|blik_code|payid|pay_id)' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_sensitive_evidence' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(
    p_payment_attempt_id::text || '|' ||
    p_expected_payment_intent_id::text || '|' ||
    p_expected_subscription_cycle_id::text || '|' ||
    btrim(p_operator_ref) || '|' ||
    p_absence_checked_at::text || '|' ||
    p_next_retry_at::text || '|' ||
    v_evidence::text
  );

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{preparedAttemptReopen,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'prepared_attempt_absence_reopen_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  PERFORM public.payment_provider_lock_aggregate(p_expected_payment_intent_id);
  SELECT *
    INTO v_attempt
    FROM public.payment_provider_attempts
   WHERE id = p_payment_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_attempt_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.settlement_intent_id IS DISTINCT FROM p_expected_payment_intent_id THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.status <> 'created' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_attempt_not_prepared' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.provider NOT IN ('stripe', 'tpay') THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_not_supported' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.provider_attempt_id IS NOT NULL OR v_attempt.provider_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_ref_exists' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.response_payload @> '{"providerCall": true}'::jsonb THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_call_recorded' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_attempt.request_payload ? 'providerIdempotencyKey')
    OR NOT (v_attempt.request_payload ? 'providerRequestFingerprint')
    OR NOT (v_attempt.request_payload ? 'providerFlow')
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_missing_provider_identity' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_intent
    FROM (SELECT state.*, intent.order_id FROM public.payment_provider_states state JOIN public.commerce_settlement_intents intent ON intent.id=state.id) state
   WHERE id = p_expected_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM v_attempt.id THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.target_kind <> 'subscription_cycle'
    OR v_intent.subscription_cycle_id IS DISTINCT FROM p_expected_subscription_cycle_id
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_cycle_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status NOT IN ('requires_action', 'processing') THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_not_active' USING ERRCODE = '22023';
  END IF;
  IF v_intent.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_intent_provider_ref_exists' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.subscription_cycles WHERE id=p_expected_subscription_cycle_id FOR UPDATE;
  SELECT *
    INTO v_cycle
    FROM (SELECT c.*,COALESCE(retry.retry_attempt,0) AS retry_attempt,state.provider_attempt_sequence FROM public.subscription_cycles c
    LEFT JOIN public.subscription_retry_obligations retry ON retry.cycle_id=c.id
    JOIN public.payment_provider_states state ON state.subscription_cycle_id=c.id AND state.id=p_expected_payment_intent_id) cycle
   WHERE id = p_expected_subscription_cycle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_cycle_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_cycle.status <> 'payment_pending' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_cycle_not_pending' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders
   WHERE id = v_intent.order_id
   FOR UPDATE;
  IF NOT FOUND
    OR v_order.subscription_cycle_id IS NULL
    OR v_order.subscription_cycle_id IS DISTINCT FROM v_cycle.id
    OR v_intent.subscription_id IS DISTINCT FROM v_cycle.subscription_id
  THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_order_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_order_not_pending_payment' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_attempt_evidence AS e
     WHERE e.payment_attempt_id = v_attempt.id
        OR e.settlement_intent_id = v_intent.id
  ) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_provider_event_exists' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_reconciliation_runs AS r
     WHERE r.payment_attempt_id = v_attempt.id
       AND r.correction_status = 'corrected'
       AND r.provider_status IN ('succeeded', 'failed')
  ) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_terminal_reconciliation_exists' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.payment_provider_reconciliation_runs AS r
     WHERE r.payment_attempt_id = v_attempt.id
       AND r.provider_status IN ('prepared_attempt_claiming', 'prepared_without_provider_ack')
       AND r.correction_status IN ('observed', 'failed')
  ) THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_watchdog_evidence_missing' USING ERRCODE = '22023';
  END IF;

  v_latest_local_write := GREATEST(
    v_attempt.created_at,
    v_attempt.updated_at,
    v_intent.created_at,
    v_intent.updated_at
  );
  IF p_absence_checked_at < v_latest_local_write + v_min_stranded_age THEN
    RAISE EXCEPTION 'prepared_attempt_absence_reopen_too_fresh' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'commerce_payment_control_reopen_prepared_attempt_after_absence')
  );

  v_from_attempt_status := v_attempt.status;
  v_next_sequence := v_cycle.provider_attempt_sequence + 1;

  UPDATE public.payment_provider_attempts
     SET status = 'cancelled',
         failure_reason = 'prepared_without_provider_ack_operator_cleared',
         response_payload = response_payload || jsonb_build_object(
           'providerCall', false,
           'providerAcknowledged', false,
           'operatorAbsenceClearedAt', p_absence_checked_at
         ),
         metadata = metadata || jsonb_build_object(
           'preparedAbsenceReopenedAt', p_absence_checked_at,
           'operatorRef', btrim(p_operator_ref),
           'providerAttemptSequence', v_next_sequence
         ),
         updated_at = now()
   WHERE id = v_attempt.id;

  UPDATE public.payment_provider_states SET provider_attempt_sequence=v_next_sequence,updated_at=now() WHERE id=v_intent.id;
  INSERT INTO public.payment_prepared_absence_reopens(payment_intent_id,payment_attempt_id,subscription_cycle_id,
   provider_attempt_sequence,next_retry_at,idempotency_key,evidence)
  VALUES(v_intent.id,v_attempt.id,v_cycle.id,v_next_sequence,p_next_retry_at,p_idempotency_key,v_evidence);

  PERFORM public.commerce_payment_control_record_reconciliation(
    p_idempotency_key || ':provider_absence',
    v_attempt.provider,
    NULL,
    v_intent.id,
    v_attempt.id,
    v_from_attempt_status,
    'prepared_attempt_provider_absent',
    'corrected',
    p_absence_checked_at,
    jsonb_build_object(
      'source', 'payment-provider-reconciliation.prepared-absence-reopen.v0',
      'subscriptionId', v_cycle.subscription_id,
      'subscriptionCycleId', v_cycle.id,
      'orderId', v_order.id,
      'providerAbsenceConfirmed', true,
      'operatorRef', btrim(p_operator_ref),
      'nextRetryAt', p_next_retry_at,
      'retryAttemptPreserved', v_cycle.retry_attempt,
      'providerAttemptSequence', v_next_sequence,
      'evidence', v_evidence
    )
  );

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    occurred_at,
    payload
  )
  VALUES (
    v_intent.id,
    v_attempt.id,
    'attempt',
    v_from_attempt_status,
    'cancelled',
    'prepared_without_provider_ack_operator_cleared',
    p_idempotency_key || ':attempt_cancelled',
    p_absence_checked_at,
    jsonb_build_object(
      'source', 'payment-provider-reconciliation.prepared-absence-reopen.v0',
      'providerAttemptSequence', v_next_sequence,
      'retryAttemptPreserved', v_cycle.retry_attempt
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.subscription_events (
    subscription_id,
    event_type,
    idempotency_key,
    payload,
    occurred_at
  )
  VALUES (
    v_cycle.subscription_id,
    'subscription.retry_scheduled',
    p_idempotency_key || ':subscription_retry_scheduled',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'paymentAttemptId', v_attempt.id,
      'orderId', v_order.id,
      'reason', 'prepared_without_provider_ack_operator_cleared',
      'nextRetryAt', p_next_retry_at,
      'retryAttemptPreserved', v_cycle.retry_attempt,
      'providerAttemptSequence', v_next_sequence,
      'source', 'payment-provider-reconciliation.prepared-absence-reopen.v0'
    ),
    p_absence_checked_at
  )
  ON CONFLICT (subscription_id,idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'preparedAttemptReopen', jsonb_build_object(
      'paymentAttemptId', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'subscriptionCycleId', v_cycle.id,
      'subscriptionId', v_cycle.subscription_id,
      'orderId', v_order.id,
      'attemptStatus', 'cancelled',
      'cycleStatus', v_cycle.status,
      'retryAttempt', v_cycle.retry_attempt,
      'providerAttemptSequence', v_next_sequence,
      'nextRetryAt', p_next_retry_at,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'subscriptionCycleId', v_cycle.id,
           'providerAttemptSequence', v_next_sequence
         )
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE FUNCTION public.commerce_payment_reopen_interactive_sealed_v1(
  p_idempotency_key text,
  p_payment_attempt_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_order_id uuid,
  p_expected_subscription_id uuid,
  p_expected_subscription_cycle_id uuid,
  p_reopen_mode text,
  p_dispatch_state text,
  p_phase text,
  p_reason_code text,
  p_operator_ref text,
  p_absence_checked_at timestamptz,
  p_absence_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.interactive_prepared_reopen';
  v_min_stranded_age constant interval := interval '30 minutes';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_intent record;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_payment record;
  v_evidence jsonb := COALESCE(p_absence_evidence, '{}'::jsonb);
  v_occurred_at timestamptz;
  v_latest_local_write timestamptz;
  v_checkout_kind text;
  v_reconciliation_status text;
  v_audit_payload jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_payment_attempt_id IS NULL
    OR p_expected_payment_intent_id IS NULL
    OR p_expected_order_id IS NULL
    OR p_reopen_mode IS NULL
    OR p_reopen_mode NOT IN ('trusted_pre_dispatch', 'trusted_provider_refusal', 'manual_provider_absence')
    OR p_dispatch_state IS NULL OR btrim(p_dispatch_state) = ''
    OR p_phase IS NULL OR btrim(p_phase) = ''
    OR p_reason_code IS NULL OR btrim(p_reason_code) = ''
    OR jsonb_typeof(v_evidence) <> 'object'
    OR (p_expected_subscription_id IS NULL) IS DISTINCT FROM (p_expected_subscription_cycle_id IS NULL)
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF lower(v_evidence::text) ~ '(paymentmethodref|payment_method_ref|providermethodref|provider_method_ref|providercustomerref|provider_customer_ref|clientsecret|client_secret|recoverytoken|recovery_token|token_hash|blikcode|blik_code|blik|payid|pay_id|providerpaymentid|provider_payment_id|providerattemptid|provider_attempt_id|providersessionid|provider_session_id)' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_sensitive_evidence' USING ERRCODE = '22023';
  END IF;

  IF p_reopen_mode = 'trusted_pre_dispatch' THEN
    IF p_dispatch_state <> 'not_dispatched'
      OR NOT (
        (
          p_phase = 'oauth'
          AND p_reason_code IN ('tpay_oauth_failed', 'tpay_oauth_timeout', 'tpay_oauth_invalid_response')
        )
        OR (
          p_phase = 'transaction_dispatch'
          AND p_reason_code IN ('tpay_request_encode_failed', 'tpay_request_deadline_exhausted')
        )
      )
      OR p_operator_ref IS NOT NULL
      OR p_absence_checked_at IS NOT NULL
      OR v_evidence <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_trusted_pre_dispatch_evidence'
        USING ERRCODE = '22023';
    END IF;
    v_occurred_at := now();
    v_reconciliation_status := 'provider_dispatch_not_started';
  ELSIF p_reopen_mode = 'trusted_provider_refusal' THEN
    IF p_dispatch_state <> 'refused'
      OR p_phase <> 'response_decode'
      OR p_reason_code <> 'tpay_request_refused'
      OR p_operator_ref IS NOT NULL
      OR p_absence_checked_at IS NOT NULL
      OR v_evidence <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_provider_refusal_evidence'
        USING ERRCODE = '22023';
    END IF;
    v_occurred_at := now();
    v_reconciliation_status := 'provider_transaction_refused';
  ELSE
    IF p_dispatch_state <> 'provider_absence_confirmed'
      OR p_phase <> 'operator_reconciliation'
      OR p_reason_code NOT IN ('operator_verified_absence', 'operator_documented_absence')
      OR p_operator_ref IS NULL
      OR btrim(p_operator_ref) !~ '^[a-z0-9][a-z0-9._:-]{2,159}$'
      OR p_absence_checked_at IS NULL
      OR p_absence_checked_at > now() + interval '5 minutes'
      OR NOT (v_evidence @> '{"providerAbsenceConfirmed": true, "watchdogEvidence": true}'::jsonb)
      OR (v_evidence->>'evidenceCode') IS DISTINCT FROM p_reason_code
      OR EXISTS (
        SELECT 1
          FROM jsonb_object_keys(v_evidence) AS evidence_key(key)
         WHERE evidence_key.key NOT IN ('providerAbsenceConfirmed', 'watchdogEvidence', 'evidenceCode')
      )
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_invalid_manual_absence_evidence'
        USING ERRCODE = '22023';
    END IF;
    v_occurred_at := p_absence_checked_at;
    v_reconciliation_status := 'prepared_attempt_provider_absent';
  END IF;

  v_request_fingerprint := md5(
    p_payment_attempt_id::text || '|' ||
    p_expected_payment_intent_id::text || '|' ||
    p_expected_order_id::text || '|' ||
    COALESCE(p_expected_subscription_id::text, '') || '|' ||
    COALESCE(p_expected_subscription_cycle_id::text, '') || '|' ||
    p_reopen_mode || '|' ||
    p_dispatch_state || '|' ||
    p_phase || '|' ||
    p_reason_code || '|' ||
    COALESCE(btrim(p_operator_ref), '') || '|' ||
    COALESCE(p_absence_checked_at::text, '') || '|' ||
    v_evidence::text
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || ':' || p_idempotency_key, 0));

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(
        v_existing.response_payload,
        '{interactivePreparedAttemptReopen,replayed}',
        'true'::jsonb,
        false
      );
    END IF;
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  IF p_expected_subscription_id IS NOT NULL THEN
    SELECT *
      INTO v_subscription
      FROM public.subscriptions
     WHERE id = p_expected_subscription_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_subscription_not_found'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_intent
    FROM (SELECT state.*, intent.order_id FROM public.payment_provider_states state JOIN public.commerce_settlement_intents intent ON intent.id=state.id) state
   WHERE id = p_expected_payment_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM p_payment_attempt_id THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.order_id IS DISTINCT FROM p_expected_order_id
    OR v_intent.subscription_id IS DISTINCT FROM p_expected_subscription_id
    OR v_intent.subscription_cycle_id IS DISTINCT FROM p_expected_subscription_cycle_id
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_expected_ids_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status NOT IN ('requires_action', 'processing') THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_not_active' USING ERRCODE = '22023';
  END IF;
  IF v_intent.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_provider_ref_exists' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.payment_provider_attempts
   WHERE id = p_payment_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_attempt_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.settlement_intent_id IS DISTINCT FROM v_intent.id THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_intent_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM v_attempt.id THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.status <> 'created' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_attempt_not_prepared' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.provider <> 'tpay' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_not_supported' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.provider_attempt_id IS NOT NULL OR v_attempt.provider_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_ref_exists' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.response_payload @> '{"providerCall": true}'::jsonb THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_call_recorded' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.request_payload->>'source' IS DISTINCT FROM 'commerce.runtime.provider-attempt.prepare.v0'
    OR NOT (v_attempt.request_payload ? 'providerIdempotencyKey')
    OR NOT (v_attempt.request_payload ? 'providerRequestFingerprint')
    OR NOT (v_attempt.request_payload ? 'providerFlow')
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_not_interactive_prepare' USING ERRCODE = '22023';
  END IF;

  IF p_expected_subscription_cycle_id IS NOT NULL THEN
    SELECT *
      INTO v_cycle
      FROM public.subscription_cycles
     WHERE id = p_expected_subscription_cycle_id
     FOR UPDATE;
    IF NOT FOUND
      OR v_cycle.subscription_id IS DISTINCT FROM p_expected_subscription_id
      OR v_cycle.status <> 'payment_pending'
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_cycle_not_payment_pending' USING ERRCODE = '22023';
    END IF;
    IF v_subscription.status <> 'pending_activation' THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_subscription_not_pending_activation'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT *
    INTO v_order
    FROM public.commerce_orders
   WHERE id = p_expected_order_id
   FOR UPDATE;
  IF NOT FOUND OR v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_order_not_pending_payment' USING ERRCODE = '22023';
  END IF;

  IF p_expected_subscription_id IS NULL THEN
    v_checkout_kind := 'one_time';
    IF v_intent.target_kind <> 'one_time_order'
      OR v_order.subscription_cycle_id IS NOT NULL
      OR v_intent.subscription_id IS NOT NULL
      OR v_order.subscription_cycle_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_one_time_context_mismatch' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_checkout_kind := 'subscription_initial';
    IF v_intent.target_kind <> 'subscription_cycle'
      OR v_order.subscription_cycle_id IS NULL
      OR v_intent.subscription_id IS DISTINCT FROM p_expected_subscription_id
      OR v_order.subscription_cycle_id IS DISTINCT FROM p_expected_subscription_cycle_id
      OR v_order.subscription_cycle_id IS DISTINCT FROM v_cycle.id
    THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_subscription_context_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_intent.metadata->>'checkoutKind' IS DISTINCT FROM v_checkout_kind
    OR v_order.metadata#>>'{runtimeFinalize,checkoutKind}' IS DISTINCT FROM v_checkout_kind
    OR v_order.metadata#>>'{runtimeFinalize,source}' IS DISTINCT FROM 'commerce.runtime.hidden.v0'
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_checkout_source_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_payment
    FROM (SELECT state.payment_id AS id,state.payment_status AS status,state.provider_payment_id,intent.order_id FROM public.payment_provider_states state JOIN public.commerce_settlement_intents intent ON intent.id=state.id) payment
   WHERE id = v_intent.payment_id
   FOR UPDATE;
  IF NOT FOUND
    OR v_payment.order_id IS DISTINCT FROM v_order.id
    OR v_payment.status <> 'pending'
    OR v_payment.provider_payment_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_payment_not_pending' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_attempt_evidence AS event
     WHERE event.payment_attempt_id = v_attempt.id
        OR event.settlement_intent_id = v_intent.id
  ) THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_provider_event_exists' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_provider_reconciliation_runs AS reconciliation
     WHERE reconciliation.payment_attempt_id = v_attempt.id
       AND reconciliation.correction_status = 'corrected'
       AND reconciliation.provider_status IN (
         'succeeded', 'failed', 'cancelled', 'canceled', 'refunded',
         'partially_refunded', 'disputed'
       )
  ) THEN
    RAISE EXCEPTION 'interactive_prepared_attempt_reopen_terminal_reconciliation_exists'
      USING ERRCODE = '22023';
  END IF;

  IF p_reopen_mode = 'manual_provider_absence' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.payment_provider_reconciliation_runs AS reconciliation
       WHERE reconciliation.payment_attempt_id = v_attempt.id
         AND reconciliation.provider_status IN ('prepared_attempt_claiming', 'prepared_without_provider_ack')
         AND reconciliation.correction_status IN ('observed', 'failed')
    ) THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_watchdog_evidence_missing'
        USING ERRCODE = '22023';
    END IF;

    v_latest_local_write := GREATEST(
      v_attempt.created_at,
      v_attempt.updated_at,
      v_intent.created_at,
      v_intent.updated_at
    );
    IF p_absence_checked_at < v_latest_local_write + v_min_stranded_age THEN
      RAISE EXCEPTION 'interactive_prepared_attempt_reopen_too_fresh' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object(
      'boundary', 'commerce_payment_control_reopen_interactive_prepared_attempt',
      'reopenMode', p_reopen_mode,
      'phase', p_phase,
      'reasonCode', p_reason_code
    )
  );

  v_audit_payload := jsonb_build_object(
    'source', 'payment-control.interactive-prepared-attempt-reopen.v1',
    'reopenMode', p_reopen_mode,
    'dispatchState', p_dispatch_state,
    'phase', p_phase,
    'reasonCode', p_reason_code,
    'operatorRef', CASE WHEN p_reopen_mode = 'manual_provider_absence' THEN btrim(p_operator_ref) ELSE NULL END,
    'providerAbsenceConfirmed', p_reopen_mode = 'manual_provider_absence',
    'watchdogEvidence', p_reopen_mode = 'manual_provider_absence'
  );

  UPDATE public.payment_provider_attempts
     SET status = 'failed',
         failure_reason = 'interactive_prepared_attempt_reopened',
         response_payload = response_payload || jsonb_build_object(
           'providerCall', p_reopen_mode = 'trusted_provider_refusal',
           'providerAcknowledged', false,
           'interactiveReopenMode', p_reopen_mode
         ),
         metadata = metadata || jsonb_build_object(
           'interactivePreparedAttemptReopened', v_audit_payload
         ),
         updated_at = now()
   WHERE id = v_attempt.id;

  UPDATE public.payment_provider_states
     SET status = 'failed',
         failure_reason = 'interactive_prepared_attempt_reopened',
         metadata = metadata || jsonb_build_object(
           'interactivePreparedAttemptReopened', v_audit_payload
         ),
         updated_at = now()
   WHERE id = v_intent.id;

  UPDATE public.payment_provider_states
     SET payment_status = 'failed',
         metadata = metadata || jsonb_build_object(
           'interactivePreparedAttemptReopened', v_audit_payload
         ),
         updated_at = now()
   WHERE payment_id = v_payment.id;

  PERFORM public.commerce_payment_control_record_reconciliation(
    p_idempotency_key || ':reconciliation',
    v_attempt.provider,
    NULL,
    v_intent.id,
    v_attempt.id,
    'created',
    v_reconciliation_status,
    'corrected',
    v_occurred_at,
    v_audit_payload
  );

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    occurred_at,
    payload
  )
  VALUES
    (
      v_intent.id,
      v_attempt.id,
      'attempt',
      'created',
      'failed',
      'interactive_prepared_attempt_reopened',
      p_idempotency_key || ':attempt_failed',
      v_occurred_at,
      v_audit_payload
    ),
    (
      v_intent.id,
      v_attempt.id,
      'intent',
      v_intent.status,
      'failed',
      'interactive_prepared_attempt_reopened',
      p_idempotency_key || ':intent_failed',
      v_occurred_at,
      v_audit_payload
    )
  ON CONFLICT (idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'interactivePreparedAttemptReopen', jsonb_build_object(
      'paymentAttemptId', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'paymentAttemptStatus', 'failed',
      'paymentIntentStatus', 'failed',
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'reopenMode', p_reopen_mode
         )
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE FUNCTION public.commerce_payment_control_reopen_interactive_prepared_attempt(
  p_idempotency_key text,
  p_payment_attempt_id uuid,
  p_expected_payment_intent_id uuid,
  p_expected_order_id uuid,
  p_expected_subscription_id uuid,
  p_expected_subscription_cycle_id uuid,
  p_reopen_mode text,
  p_dispatch_state text,
  p_phase text,
  p_reason_code text,
  p_operator_ref text,
  p_absence_checked_at timestamptz,
  p_absence_evidence jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.payment_provider_lock_aggregate(p_expected_payment_intent_id);
 RETURN public.commerce_payment_reopen_interactive_sealed_v1(p_idempotency_key,p_payment_attempt_id,p_expected_payment_intent_id,p_expected_order_id,p_expected_subscription_id,p_expected_subscription_cycle_id,p_reopen_mode,p_dispatch_state,p_phase,p_reason_code,p_operator_ref,p_absence_checked_at,p_absence_evidence);
END;
$$;

CREATE FUNCTION public.payment_prepared_absence_reopen_due(p_intent_id uuid,p_now timestamptz,p_consume_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE reopened public.payment_prepared_absence_reopens;
BEGIN
 IF p_intent_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR (p_consume_key IS NOT NULL AND (length(p_consume_key)<8 OR btrim(p_consume_key)='')) THEN
  RAISE EXCEPTION 'prepared_attempt_absence_reopen_due_invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_provider_lock_aggregate(p_intent_id);
 SELECT r.* INTO reopened FROM public.payment_prepared_absence_reopens r
 JOIN public.payment_provider_states s ON s.id=r.payment_intent_id
 WHERE r.payment_intent_id=p_intent_id AND r.provider_attempt_sequence=s.provider_attempt_sequence
  AND r.next_retry_at<=p_now AND (r.consumed_key IS NULL OR r.consumed_key=p_consume_key)
 ORDER BY r.provider_attempt_sequence DESC LIMIT 1 FOR UPDATE OF r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_consume_key IS NOT NULL AND reopened.consumed_key IS NULL THEN
  UPDATE public.payment_prepared_absence_reopens SET consumed_key = p_consume_key, consumed_at = p_now
   WHERE id=reopened.id RETURNING * INTO reopened;
 END IF;
 RETURN to_jsonb(reopened);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_provider_result_apply(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text,
 p_dunning_template_slug text,p_recovery_url_path text,p_recovery_template_slug text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE fingerprint text; legacy_fingerprint text; receipt public.payment_provider_receipts%ROWTYPE;
 i public.commerce_settlement_intents%ROWTYPE; s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE; e public.payment_provider_attempt_evidence%ROWTYPE;
 o public.commerce_orders%ROWTYPE; kind text:='state_changed'; answer jsonb; truth jsonb; evidence jsonb;
 outcome text; native_failure text; from_status text; held record; recovery_token text; recovery_expires_at timestamptz;
 renewal public.subscription_renewal_operations%ROWTYPE; retry_preparation public.subscription_retry_receipts%ROWTYPE;
 retry_sequence integer; logical_cycle integer; retry_result jsonb; expiry_escalation boolean:=false; handoff jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR length(p_idempotency_key)<8
  OR p_payment_intent_id IS NULL OR p_result_status IS NULL OR p_result_status NOT IN ('succeeded','failed','expired','refunded','partially_refunded','disputed')
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id;
  IF FOUND AND e.settlement_intent_id=p_payment_intent_id AND e.payment_attempt_id IS NULL THEN
   RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 legacy_fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,''));
 fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,'')||CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class='||p_failure_class END);
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.response_payload IS NOT NULL AND
   (receipt.request_fingerprint=fingerprint OR (p_failure_class IS NOT NULL AND receipt.request_fingerprint=legacy_fingerprint AND EXISTS(
    SELECT 1 FROM public.payment_provider_attempts WHERE id=NULLIF(receipt.metadata->>'paymentAttemptId','')::uuid AND failure_class=p_failure_class))) THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentResult,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_intent_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id FOR UPDATE;
  IF NOT FOUND OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
   RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS DISTINCT FROM a.id THEN
   RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF e.amount_minor>0 AND e.amount_minor<>i.amount_minor AND (p_result_status NOT IN ('refunded','partially_refunded') OR e.provider='stripe') THEN
   RAISE EXCEPTION 'payment_control_result_amount_mismatch' USING ERRCODE='22023'; END IF;
  IF e.currency IS NOT NULL AND e.currency<>i.currency_code THEN
   RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=i.order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_order_not_found' USING ERRCODE='22023'; END IF;
 from_status:=s.status;
 IF p_result_status='succeeded' THEN
  IF s.status IN ('cancelled','refunded','partially_refunded','disputed') OR i.status='cancelled' THEN
   RAISE EXCEPTION 'payment_control_result_terminal_intent' USING ERRCODE='22023'; END IF;
 ELSIF p_result_status IN ('failed','expired') THEN
  IF s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN kind:='ignored_failure_after_success_or_terminal';
  ELSIF s.target_kind='subscription_cycle' AND EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=s.subscription_cycle_id AND status IN ('skipped','cancelled') FOR UPDATE) THEN
   UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=COALESCE(p_failure_reason,p_result_status),updated_at=now() WHERE id=a.id;
   UPDATE public.payment_provider_states SET payment_status=p_result_status,metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
   kind:='ignored_failure_terminalized_cycle';
  ELSIF s.status=p_result_status AND a.status=p_result_status THEN kind:='ignored_duplicate_terminal_failure'; END IF;
 ELSE
  RETURN public.payment_refund_apply_result(p_idempotency_key,p_payment_intent_id,p_payment_event_id,p_result_status,
   p_occurred_at,p_failure_reason,p_failure_class,p_failure_class_decided_by);
 END IF;
 IF kind='state_changed' THEN
  outcome:=CASE WHEN p_result_status='succeeded' THEN 'captured' ELSE 'refused' END;
  native_failure:=CASE WHEN outcome='refused' THEN CASE WHEN p_failure_class IN ('authorization_refused','insufficient_funds','method_unavailable','risk_refused','unknown_refusal') THEN p_failure_class ELSE 'unknown_refusal' END END;
  evidence:=CASE WHEN p_payment_event_id IS NULL THEN
   jsonb_build_object('sourceKind','execution_response','sourceReference',a.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',encode(sha256(convert_to(a.response_payload::text,'UTF8')),'hex'))
   ELSE jsonb_build_object('sourceKind','accepted_event','sourceReference',e.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))) END;
  PERFORM public.payment_provider_assert_truth(i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,evidence);
  IF outcome='refused' AND s.target_kind='subscription_cycle' AND i.renewal_operation_id IS NOT NULL THEN
   SELECT op.* INTO renewal FROM public.subscription_renewal_operations op
    JOIN public.subscription_cycles c ON c.renewal_operation_id=op.id AND c.id=s.subscription_cycle_id
    WHERE op.id=i.renewal_operation_id AND op.subscription_id=s.subscription_id
     AND o.renewal_operation_id=op.id AND o.subscription_cycle_id=c.id
     AND i.renewal_operation_fingerprint=op.operation_fingerprint FOR UPDATE OF op;
   IF NOT FOUND OR renewal.cycle_snapshot#>>'{cycle,status}' IS DISTINCT FROM 'correlated' THEN
    RAISE EXCEPTION 'subscription_renewal_cycle_correlation_required' USING ERRCODE='22023'; END IF;
   logical_cycle:=(renewal.cycle_snapshot#>>'{cycle,logicalCycleNumber}')::integer;
   SELECT r.* INTO retry_preparation FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations obligation ON obligation.id=r.obligation_id
    WHERE obligation.renewal_operation_id=renewal.id AND r.kind='prepare'
     AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'idempotencyKey'=a.idempotency_key
     AND r.input->>'providerIdempotencyKey'=a.request_payload->>'providerIdempotencyKey'
     AND r.input->>'providerRequestFingerprint'=a.request_payload->>'providerRequestFingerprint';
   IF FOUND THEN retry_sequence:=retry_preparation.attempt_sequence;
   ELSIF renewal.external_attempt_ref IN (a.id::text,a.provider_attempt_id)
    AND renewal.cycle_snapshot->>'externalAttemptSequence'='0' THEN retry_sequence:=0;
   ELSE RAISE EXCEPTION 'subscription_retry_not_prepared' USING ERRCODE='22023'; END IF;
   -- A same-attempt expiry records a lifecycle escalation. Its decline already
   -- owns the financial failure and retry stage; neither effect runs again.
   expiry_escalation:=p_result_status='expired' AND s.status='failed' AND a.status='failed' AND EXISTS(
    SELECT 1 FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations obligation ON obligation.id=r.obligation_id
    WHERE obligation.renewal_operation_id=renewal.id AND r.kind='failure' AND r.attempt_sequence=retry_sequence
     AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'paymentAttemptId'=a.id::text);
   IF NOT expiry_escalation THEN
   -- The retry owner records the financial failure first. Truth below reuses
   -- this exact key's settlement receipt, rather than making a second transition.
   retry_result:=public.subscription_retry_apply_failure(renewal.id,p_idempotency_key||':truth',
    jsonb_build_object('attemptSequence',retry_sequence,'logicalCycleNumber',logical_cycle,
     'paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'provider',a.provider,
     'providerAttemptId',a.provider_attempt_id,'subscriptionCycleId',s.subscription_cycle_id,
     'renewalOperationId',renewal.id,'occurredAt',p_occurred_at,
     'failureClass',p_failure_class,'reason',COALESCE(p_failure_reason,p_result_status),
     'externalRef',CASE WHEN retry_sequence=0 THEN renewal.external_attempt_ref ELSE COALESCE(a.provider_attempt_id,a.id::text) END,
     'evidenceKey',COALESCE(e.id::text,a.id::text),'firstRecordedAt',COALESCE(e.created_at,a.updated_at)));
  END IF;
   END IF;
  IF NOT expiry_escalation AND NOT (p_result_status='succeeded' AND i.status='settled') THEN
   truth:=public.payment_truth_ingest_event('provider:'||COALESCE(e.id::text,p_idempotency_key),encode(sha256(convert_to(jsonb_build_object('eventId',e.id,'intentId',i.id,'attemptId',a.id,'outcome',outcome)::text,'UTF8')),'hex'),
    p_idempotency_key||':truth',i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,native_failure,p_failure_reason,evidence,p_dunning_template_slug,p_recovery_url_path,p_recovery_template_slug);
  END IF;
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   provider_payment_id=CASE WHEN p_result_status='succeeded' THEN COALESCE(e.provider_payment_id,provider_payment_id) ELSE provider_payment_id END,
   failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=s.id;
  UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=a.id;
  IF p_result_status IN ('failed','expired') AND o.subscription_cycle_id IS NULL THEN
   IF p_result_status='failed' THEN
    UPDATE public.commerce_orders SET metadata=metadata||jsonb_build_object(
     'paymentStatus','declined','failureReason',COALESCE(p_failure_reason,p_result_status),
     'lastDeclineAt',p_occurred_at,'recoverable',true,'source','payment.control.v0'),updated_at=now() WHERE id=o.id;
    -- The first recoverable-decline metadata transition owns the delayed notice
    -- and its authority in the native checkout recovery token ledger.
    IF o.client_id IS NOT NULL AND (o.metadata->>'paymentStatus' IS DISTINCT FROM 'declined'
     OR COALESCE((o.metadata->>'recoverable')::boolean,false) IS DISTINCT FROM true) THEN
     recovery_token:='rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
     recovery_expires_at:=now()+interval '24 hours';
     INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
     VALUES(o.id,o.client_id,encode(sha256(convert_to(recovery_token,'UTF8')),'hex'),recovery_expires_at)
     ON CONFLICT (token_hash) DO NOTHING;
     INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,available_at,payload,metadata)
     VALUES('commerce_order',o.id,'commerce.payment.failed','payment_failed:'||o.id,now()+interval '3 minutes',
      jsonb_build_object('orderId','order_'||o.id,'orderUuid',o.id,'totalCents',o.total_amount_minor,
       'currency',o.currency_code,'recoveryToken',recovery_token,
       'mode',CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=o.id)
        OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
        THEN 'subscription_cycle' ELSE 'one_time' END,
       'failureReason',COALESCE(p_failure_reason,p_result_status),'hasSubscriptionContext',EXISTS(
        SELECT 1 FROM public.subscription_activations WHERE order_id=o.id) OR COALESCE(
        o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')='subscription',
       'expiresAt',recovery_expires_at,'occurredAt',now()),
      jsonb_build_object('source','payment_provider_result_apply_recoverable_decline'))
     ON CONFLICT (event_type,idempotency_key) DO NOTHING;
    END IF;
    kind:='recoverable_decline';
   ELSE
    IF EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=o.id AND state='provisional') THEN
     PERFORM public.commerce_compensate_abandoned_checkout(
      'payment-expired:'||o.id,o.id,'subscription_activation_failed',p_occurred_at);
    END IF;
    UPDATE public.commerce_orders SET status='expired',metadata=metadata||jsonb_build_object(
     'paymentStatus','expired','failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),
     updated_at=now() WHERE id=o.id;
    FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
     WHERE purchase_order_id=o.id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation(
      'payment-expired:'||held.id,held.id,'payment_expired','{}'::jsonb,p_occurred_at);
    END LOOP;
   END IF;
  END IF;
 END IF;
 IF p_failure_class IS NOT NULL THEN
  UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,response_payload=response_payload||
   CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id;
 END IF;
 IF p_payment_event_id IS NOT NULL THEN
  UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id;
 END IF;
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,p_payment_event_id,'business_result',from_status,p_result_status,kind,p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',o.id,'resultStatus',p_result_status,'source','payment.control.v0')||
  CASE WHEN retry_result IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retryObligationId',retry_result->>'id',
   'retryAttempt',retry_result->'retry_attempt','nextRetryAt',retry_result->'next_retry_at','retryFailureKey',p_idempotency_key||':truth') END);
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',o.id,'status',p_result_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 IF p_result_status='failed' AND p_payment_event_id IS NOT NULL AND kind NOT LIKE 'ignored%'
  AND p_idempotency_key='provider-webhook:'||e.provider||':'||e.provider_event_id||':apply' THEN
  BEGIN
   handoff:=public.payment_reconciliation_open_dunning_from_failed_result(
    'provider-webhook:'||e.provider||':'||e.provider_event_id||':dunning',i.id,e.provider_event_id,
    p_failure_reason,p_occurred_at,p_failure_class,a.id,p_dunning_template_slug,p_recovery_url_path);
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF SQLERRM NOT IN ('subscription_dunning_failed_attempt_unattributed','subscription_dunning_case_unattributed',
    'subscription_dunning_replay_unavailable','subscription_dunning_failed_attempt_ambiguous','subscription_dunning_failed_attempt_rung_mismatch') THEN RAISE; END IF;
   handoff:=jsonb_build_object('subscriptionWebhookDunning',jsonb_build_object('opened',false,'replayed',false,
    'reason',SQLERRM,'failedPaymentAttemptId',a.id));
  END;
  answer:=answer||handoff;
 END IF;
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id));
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.communication_event_refund_write(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders;
BEGIN
 IF pg_trigger_depth()=0 THEN RAISE EXCEPTION 'refund_source_trigger_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR purchase.status<>'refunded' THEN RAISE EXCEPTION 'refund_source_order_invalid' USING ERRCODE='22023'; END IF;

 IF purchase.metadata->>'source'='admin_manual_refund' THEN RETURN; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',purchase.id,'commerce.order.refunded','order_refunded:'||purchase.id,
  jsonb_build_object('orderUuid',purchase.id,'occurredAt',purchase.refunded_at),jsonb_build_object('source','commerce_order_emit_refunded_notification',
   'refundStatusFactV1',jsonb_build_object('clientId',purchase.client_id,'occurredAt',purchase.refunded_at))) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;

-- Restricted reconciliation and reversal store access.
ALTER TABLE public.payment_provider_reconciliation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_provider_reconciliation_runs FROM PUBLIC;
ALTER TABLE public.payment_prepared_absence_reopens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_prepared_absence_reopens FROM PUBLIC;
ALTER TABLE public.payment_dunning_case_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_dunning_case_attribution FROM PUBLIC;
ALTER TABLE public.payment_refund_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_refund_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_reconciliation_claim_stale_attempts(timestamptz,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_reconciliation_claim_prepared_attempts(timestamptz,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_control_record_reconciliation(text,text,text,uuid,uuid,text,text,text,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_refund_evidence_record(uuid,text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_refund_readback(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_provider_refund_evidence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_refund_apply_result(text,uuid,uuid,text,timestamptz,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_control_reopen_prepared_attempt_after_absence(text,uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_reopen_interactive_sealed_v1(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_prepared_absence_reopen_due(uuid,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.communication_event_refund_write(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.payment_provider_reconciliation_runs,public.payment_prepared_absence_reopens,public.payment_dunning_case_attribution,public.payment_refund_evidence FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_payment_reconciliation_claim_stale_attempts(timestamptz,integer,integer,text),public.commerce_payment_reconciliation_claim_prepared_attempts(timestamptz,integer,integer,text),public.commerce_payment_control_record_reconciliation(text,text,text,uuid,uuid,text,text,text,timestamptz,jsonb),public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text,text,text,text),public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text),public.payment_refund_evidence_record(uuid,text,bigint,text),public.payment_refund_readback(uuid),public.commerce_order_provider_refund_evidence(uuid),public.payment_refund_apply_result(text,uuid,uuid,text,timestamptz,text,text,text),public.commerce_payment_control_reopen_prepared_attempt_after_absence(text,uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb),public.commerce_payment_reopen_interactive_sealed_v1(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb),public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb),public.payment_prepared_absence_reopen_due(uuid,timestamptz,text),public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.payment_provider_reconciliation_runs,public.payment_prepared_absence_reopens,public.payment_dunning_case_attribution,public.payment_refund_evidence FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_payment_reconciliation_claim_stale_attempts(timestamptz,integer,integer,text),public.commerce_payment_reconciliation_claim_prepared_attempts(timestamptz,integer,integer,text),public.commerce_payment_control_record_reconciliation(text,text,text,uuid,uuid,text,text,text,timestamptz,jsonb),public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text,text,text,text),public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text),public.payment_refund_evidence_record(uuid,text,bigint,text),public.payment_refund_readback(uuid),public.commerce_order_provider_refund_evidence(uuid),public.payment_refund_apply_result(text,uuid,uuid,text,timestamptz,text,text,text),public.commerce_payment_control_reopen_prepared_attempt_after_absence(text,uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb),public.commerce_payment_reopen_interactive_sealed_v1(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb),public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb),public.payment_prepared_absence_reopen_due(uuid,timestamptz,text),public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.payment_provider_reconciliation_runs,public.payment_prepared_absence_reopens,public.payment_dunning_case_attribution,public.payment_refund_evidence FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_payment_reopen_interactive_sealed_v1(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb) FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_payment_reconciliation_claim_stale_attempts(timestamptz,integer,integer,text),public.commerce_payment_reconciliation_claim_prepared_attempts(timestamptz,integer,integer,text),public.commerce_payment_control_record_reconciliation(text,text,text,uuid,uuid,text,text,text,timestamptz,jsonb),public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text,text,text,text),public.payment_reconciliation_open_dunning_from_failed_result(text,uuid,text,text,timestamptz,text,uuid,text,text),public.payment_refund_evidence_record(uuid,text,bigint,text),public.payment_refund_readback(uuid),public.commerce_order_provider_refund_evidence(uuid),public.payment_refund_apply_result(text,uuid,uuid,text,timestamptz,text,text,text),public.commerce_payment_control_reopen_prepared_attempt_after_absence(text,uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb),public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb),public.payment_prepared_absence_reopen_due(uuid,timestamptz,text),public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) TO service_role';
END IF; END; $$;
