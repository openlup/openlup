-- Installation-local attestation. The migration owner qualifies and revokes it.
CREATE TABLE public.payment_capture_time_test_qualification (
  singleton boolean PRIMARY KEY CHECK (singleton),
  qualified_at timestamptz NOT NULL,
  provider_ref text NOT NULL CHECK (NOT (btrim(provider_ref) = '')),
  source_path text NOT NULL CHECK (NOT (btrim(source_path) = '')),
  provider_account_ref text NOT NULL CHECK (NOT (btrim(provider_account_ref) = ''))
);

CREATE FUNCTION public.payment_read_capture_time(p_order_id uuid, p_intent_id uuid)
RETURNS TABLE (
  kind text, code text, order_id uuid, intent_id uuid, evidence_id uuid, truth_id uuid,
  settlement_transition_id uuid, provider text, payment_mode text, route text,
  captured_at timestamptz, fallback_at timestamptz, truth_occurred_at timestamptz,
  observed_at timestamptz, db_acknowledged_at timestamptz, provider_occurred_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
<<capture_time>>
DECLARE
  intent public.commerce_settlement_intents%ROWTYPE;
  purchase public.commerce_orders%ROWTYPE;
  transition record;
  truth public.payment_truth_events%ROWTYPE;
  evidence public.payment_provider_attempt_evidence%ROWTYPE;
  attempt public.payment_provider_attempts%ROWTYPE;
  run public.payment_provider_reconciliation_runs%ROWTYPE;
  source jsonb;
  source_id uuid;
  attempt_id uuid;
  source_kind text;
  capture_basis jsonb;
  qualified_route boolean;
  apply_key text;
  money jsonb;
  clock_value jsonb;
  clocks timestamptz[] := ARRAY[]::timestamptz[];
  clock_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
BEGIN
  kind := 'ambiguous';
  payment_mode := 'unknown';
  <<classify>>
  BEGIN
    IF (p_order_id IS NULL) = (p_intent_id IS NULL) THEN
      kind := 'invalid';
      EXIT classify;
    END IF;
    SELECT i.* INTO intent FROM public.commerce_settlement_intents i
    WHERE i.id = p_intent_id OR i.order_id = p_order_id;
    SELECT o.* INTO purchase FROM public.commerce_orders o WHERE o.id = COALESCE(p_order_id, intent.order_id);
    SELECT x.*, count(*) OVER () AS copies INTO transition FROM public.commerce_settlement_transitions x
    WHERE x.intent_id = intent.id AND x.to_status = 'settled' AND x.outcome = 'succeeded' LIMIT 1;
    IF purchase.paid_at IS NULL AND purchase.status IS DISTINCT FROM 'paid'
      AND intent.status IS DISTINCT FROM 'settled' AND transition.id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.payment_truth_events t
        WHERE t.settlement_intent_id = intent.id AND t.state = 'settled' AND t.outcome = 'captured') THEN
      kind := 'pending';
      EXIT classify;
    END IF;
    IF purchase.id IS NULL OR intent.status IS DISTINCT FROM 'settled'
      OR transition.copies IS DISTINCT FROM 1::bigint
      OR NOT pg_input_is_valid(transition.payload->>'paymentTruthEventId', 'uuid') THEN
      EXIT classify;
    END IF;
    SELECT t.* INTO truth FROM public.payment_truth_events t WHERE t.id = (transition.payload->>'paymentTruthEventId')::uuid;
    IF NOT FOUND OR truth.settlement_transition_id IS DISTINCT FROM transition.id
      OR truth.settlement_intent_id IS DISTINCT FROM intent.id
      OR truth.state <> 'settled' OR truth.outcome <> 'captured' OR truth.review_required_at IS NOT NULL
      OR truth.amount_minor <= 0 OR truth.currency_code !~ '^[A-Z]{3}$'
      OR (truth.amount_minor, truth.currency_code) IS DISTINCT FROM (intent.amount_minor, intent.currency_code)
      OR truth.source_evidence IS DISTINCT FROM transition.payload->'sourceEvidence'
      OR NOT isfinite(truth.occurred_at)
      OR truth.occurred_at IS DISTINCT FROM truth.settled_at
      OR truth.occurred_at IS DISTINCT FROM transition.occurred_at
      OR truth.occurred_at IS DISTINCT FROM intent.settled_at THEN
      EXIT classify;
    END IF;
    source := truth.source_evidence;
    source_kind := source->>'sourceKind';
    IF NOT COALESCE(pg_input_is_valid(source->>'sourceReference', 'uuid'), false)
      OR NOT COALESCE(pg_input_is_valid(source->>'attemptRef', 'uuid'), false)
      OR NOT COALESCE(source->>'payloadFingerprint' ~ '^[0-9a-f]{64}$', false)
      OR jsonb_typeof(source->'observedAt') IS DISTINCT FROM 'string'
      OR NOT (source->>'observedAt') ~ clock_pattern
      OR NOT pg_input_is_valid(source->>'observedAt', 'timestamptz') THEN
      EXIT classify;
    END IF;
    IF (source->>'observedAt')::timestamptz IS DISTINCT FROM truth.occurred_at THEN
      EXIT classify;
    END IF;
    source_id := (source->>'sourceReference')::uuid;
    attempt_id := (source->>'attemptRef')::uuid;

    -- A sandbox primary can share its transition with earlier observations.
    IF intent.channel_key = 'sandbox' THEN
      IF source_kind IN ('accepted_event', 'reconciliation_read')
        AND truth.source_event_id = 'sandbox:' || source_id::text
        AND source->>'observedStatus' = 'captured'
        AND EXISTS (SELECT 1 FROM public.payment_simulator_attempts a
          JOIN public.payment_simulator_observations o ON o.attempt_id = a.id AND o.id = a.last_observation_id
          WHERE a.id = capture_time.attempt_id AND a.settlement_intent_id = intent.id AND a.state = 'captured'
            AND o.id = source_id AND o.outcome = 'captured' AND o.occurred_at = truth.occurred_at
            AND source->>'payloadFingerprint' = o.event_fingerprint) THEN
        kind := 'unqualified';
        provider := 'sandbox';
      END IF;
      EXIT classify;
    END IF;

    SELECT a.* INTO attempt FROM public.payment_provider_attempts a
    WHERE a.id = capture_time.attempt_id AND a.settlement_intent_id = intent.id;
    IF NOT FOUND THEN EXIT classify; END IF;
    IF source_kind = 'execution_response' THEN
      -- Applied truth retains the verified response hash and occurrence.
      IF source_id = attempt.id AND source->>'observedStatus' = 'succeeded'
        AND right(truth.ingest_idempotency_key, 6) = ':truth'
        AND truth.source_event_id = 'provider:' || left(truth.ingest_idempotency_key, -6) THEN
        kind := 'unqualified';
        provider := attempt.provider;
      END IF;
      EXIT classify;
    END IF;

    SELECT e.* INTO evidence FROM public.payment_provider_attempt_evidence e
    WHERE e.id = source_id AND e.settlement_intent_id = intent.id AND e.payment_attempt_id = attempt.id;
    IF NOT FOUND OR evidence.provider IS DISTINCT FROM attempt.provider OR evidence.provider_payment_id IS NULL
      OR evidence.event_type IS DISTINCT FROM 'payment.succeeded'
      OR truth.source_event_id IS DISTINCT FROM 'provider:' || evidence.id::text
      OR source->>'observedStatus' IS DISTINCT FROM 'succeeded'
      OR (evidence.amount_minor > 0 AND evidence.amount_minor <> intent.amount_minor)
      OR (evidence.currency IS NOT NULL AND evidence.currency <> intent.currency_code) THEN
      EXIT classify;
    END IF;
    CASE source_kind
      WHEN 'accepted_event' THEN
        IF evidence.received_via IS DISTINCT FROM 'payment.control.v0' OR evidence.signature_verified IS DISTINCT FROM true
          OR evidence.provider_payment_id IS DISTINCT FROM attempt.provider_attempt_id THEN EXIT classify; END IF;
        route := 'signed_webhook';
      WHEN 'reconciliation_read' THEN
        IF evidence.received_via IS DISTINCT FROM 'reconciliation_read.v1' OR evidence.signature_verified IS NOT NULL
          OR (evidence.provider_payment_id IS DISTINCT FROM attempt.provider_attempt_id
            AND evidence.provider_payment_id IS DISTINCT FROM attempt.provider_session_id) THEN EXIT classify; END IF;
        route := 'reconciliation_read';
      ELSE EXIT classify;
    END CASE;
    provider := evidence.provider;
    capture_basis := evidence.payload->'captureTimeBasis';
    IF route = 'signed_webhook' AND capture_basis IN ('"signed_event_v1"'::jsonb, '"invalid_event_time"'::jsonb) THEN
      payment_mode := CASE evidence.payload->'livemode' WHEN 'false'::jsonb THEN 'test' WHEN 'true'::jsonb THEN 'live' ELSE 'unknown' END;
    END IF;
    IF route = 'reconciliation_read' OR evidence.captured_amount_basis IS NOT NULL THEN
      clock_value := evidence.source_evidence->'observedAt';
      IF jsonb_typeof(clock_value) IS DISTINCT FROM 'string'
        OR NOT (clock_value #>> '{}') ~ clock_pattern
        OR NOT pg_input_is_valid(clock_value #>> '{}', 'timestamptz') THEN EXIT classify; END IF;
      IF (clock_value #>> '{}')::timestamptz IS DISTINCT FROM truth.occurred_at THEN EXIT classify; END IF;
    END IF;
    -- Retained captures bind to the applied truth. Redelivery can enrich the
    -- evidence fingerprint and receipt source without changing that truth.
    IF evidence.captured_amount_basis IS NULL THEN
      kind := 'unqualified';
      EXIT classify;
    END IF;
    IF evidence.captured_amount_basis <> 'provider_capture_v1'
      OR (evidence.amount_minor, evidence.currency) IS DISTINCT FROM (intent.amount_minor, intent.currency_code)
      OR evidence.event_fingerprint IS DISTINCT FROM source->>'payloadFingerprint' THEN
      EXIT classify;
    END IF;
    IF route = 'signed_webhook' AND capture_basis IS NULL THEN
      kind := 'unqualified';
      EXIT classify;
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.payment_capture_time_test_qualification q
      WHERE q.singleton AND q.provider_ref = evidence.provider AND q.source_path = route
        AND (route = 'reconciliation_read' OR evidence.payload->'providerAccountRef' = to_jsonb(q.provider_account_ref)))
    INTO qualified_route;
    IF route = 'reconciliation_read' AND NOT qualified_route THEN
      kind := 'unqualified';
      EXIT classify;
    END IF;

    IF NOT isfinite(evidence.created_at) OR (SELECT count(*) FROM public.payment_truth_events t
      WHERE t.settlement_intent_id = intent.id AND t.state = 'settled' AND t.outcome = 'captured') <> 1 THEN
      EXIT classify;
    END IF;
    IF route = 'signed_webhook' THEN
      IF capture_basis IS DISTINCT FROM '"signed_event_v1"'::jsonb THEN EXIT classify; END IF;
      -- These clocks arrive through the signed ingress audit projection.
      FOREACH clock_value IN ARRAY ARRAY[evidence.payload #> '{openlupReceipt,receivedAt}', evidence.payload #> '{openlupReceipt,recordedAt}',
        evidence.payload #> '{openlupEvidence,providerOccurredAt}'] LOOP
        IF jsonb_typeof(clock_value) IS DISTINCT FROM 'string'
          OR NOT (clock_value #>> '{}') ~ clock_pattern
          OR NOT pg_input_is_valid(clock_value #>> '{}', 'timestamptz') THEN EXIT classify; END IF;
        clocks := array_append(clocks, (clock_value #>> '{}')::timestamptz);
      END LOOP;
      IF clocks[2] IS DISTINCT FROM evidence.created_at OR clocks[3] IS DISTINCT FROM truth.occurred_at
        OR clocks[3] IS DISTINCT FROM date_trunc('second', clocks[3], 'UTC') THEN
        EXIT classify;
      END IF;
      IF payment_mode <> 'test' OR NOT qualified_route THEN
        kind := 'unqualified';
        EXIT classify;
      END IF;
      kind := 'authoritative';
      captured_at := clocks[3];
      provider_occurred_at := clocks[3];
      observed_at := clocks[1];
    ELSE
      IF right(truth.ingest_idempotency_key, 6) <> ':truth' THEN EXIT classify; END IF;
      apply_key := left(truth.ingest_idempotency_key, -6);
      SELECT r.* INTO run FROM public.payment_provider_reconciliation_runs r WHERE r.idempotency_key = apply_key || ':evidence';
      IF NOT FOUND OR (run.provider, run.provider_payment_id, run.payment_intent_id, run.payment_attempt_id)
          IS DISTINCT FROM (provider, evidence.provider_payment_id, intent.id, attempt.id)
        OR run.correction_status <> 'corrected' OR run.payload->'applied' IS DISTINCT FROM 'true'::jsonb
        OR run.payload->>'resultStatus' IS DISTINCT FROM 'succeeded'
        OR run.provider_status IS DISTINCT FROM evidence.source_evidence->>'providerStatus'
        OR evidence.provider_event_id IS DISTINCT FROM 'provider-readback:' || encode(sha256(convert_to(apply_key, 'UTF8')), 'hex')
        OR evidence.event_fingerprint IS DISTINCT FROM encode(sha256(convert_to(evidence.source_evidence::text, 'UTF8')), 'hex')
        OR evidence.source_evidence->'amountMinor' IS DISTINCT FROM to_jsonb(intent.amount_minor)
        OR evidence.source_evidence->>'currency' IS DISTINCT FROM intent.currency_code THEN
        EXIT classify;
      END IF;
      money := COALESCE(run.payload->'observedMoney', run.payload);
      IF money->'amountMinor' IS DISTINCT FROM to_jsonb(intent.amount_minor)
        OR upper(money->>'currency') IS DISTINCT FROM intent.currency_code
        OR (run.payload ? 'observedMoney' AND run.provider_status <> 'succeeded')
        OR (NOT run.payload ? 'observedMoney' AND run.payload->>'normalizedStatus' IS DISTINCT FROM 'succeeded') THEN
        EXIT classify;
      END IF;
      FOREACH clock_value IN ARRAY ARRAY[evidence.source_evidence->'checkedAt', run.payload->'providerOccurredAt'] LOOP
        IF (clock_value IS NULL OR clock_value = 'null'::jsonb) AND cardinality(clocks) = 1
          AND NOT run.payload ? 'observedMoney' THEN
          clocks := array_append(clocks, NULL::timestamptz);
        ELSIF jsonb_typeof(clock_value) IS DISTINCT FROM 'string'
          OR NOT (clock_value #>> '{}') ~ clock_pattern
          OR NOT pg_input_is_valid(clock_value #>> '{}', 'timestamptz') THEN
          EXIT classify;
        ELSE
          clocks := array_append(clocks, (clock_value #>> '{}')::timestamptz);
        END IF;
      END LOOP;
      IF clocks[1] IS DISTINCT FROM run.checked_at
        OR (clocks[2] IS NOT NULL AND clocks[2] IS DISTINCT FROM truth.occurred_at) THEN
        EXIT classify;
      END IF;
      kind := 'fallback';
      fallback_at := clocks[1];
      provider_occurred_at := clocks[2];
      observed_at := clocks[1];
    END IF;
    order_id := intent.order_id;
    intent_id := intent.id;
    evidence_id := evidence.id;
    truth_id := truth.id;
    settlement_transition_id := transition.id;
    truth_occurred_at := truth.occurred_at;
    db_acknowledged_at := evidence.created_at;
  END classify;

  IF kind = 'ambiguous' THEN
    provider := NULL;
    payment_mode := 'unknown';
    route := NULL;
  END IF;
  code := CASE kind
    WHEN 'invalid' THEN 'capture_time_selector_invalid'
    WHEN 'pending' THEN 'capture_time_pending_application'
    WHEN 'unqualified' THEN 'capture_time_route_unqualified'
    WHEN 'ambiguous' THEN 'capture_time_integrity'
    WHEN 'fallback' THEN 'capture_time_provider_time_unproven'
  END;
  RETURN NEXT;
END capture_time;
$$;

REVOKE ALL ON FUNCTION public.payment_read_capture_time(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_capture_time_test_qualification FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_read_capture_time(uuid,uuid) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_read_capture_time(uuid,uuid) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_read_capture_time(uuid,uuid) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.payment_capture_time_test_qualification FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.payment_capture_time_test_qualification FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.payment_capture_time_test_qualification FROM service_role;'; END IF; END; $$;
