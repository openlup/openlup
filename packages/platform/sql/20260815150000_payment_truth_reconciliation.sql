-- Provider-neutral payment-event truth and reconciliation over the published
-- settlement, dunning and accounting rails.
--
-- WHAT THIS FORWARD SHIPS. One event ledger, one reconciliation-evidence
-- ledger and four entry points: ingest, reconcile, sweep-open and readback.
-- Event identity plus a canonical fingerprint is the replay boundary. A
-- captured event delegates to `commerce_record_settlement` and
-- `accounting_document_request_from_paid_order`; a refused event delegates to
-- the same settlement result and `dunning_lifecycle_open_case`. Indeterminate
-- and failed reconciliation evidence remain open. The event row records only
-- references to effects owned by those existing rails.
--
-- DELIBERATE BOUNDARIES. There is no provider enum, signature, attempt,
-- mandate, browser callback, retry cadence, payment state machine or accounting
-- document lifecycle here. Source references are opaque, external payment
-- references are never invented, currency is a required three-character datum,
-- and all amounts are minor units. Dunning notification templates and recovery
-- paths are composition inputs. A capture can close an existing case through
-- the existing recovery verb, but this forward owns neither the case nor its
-- ladder. All routines are invoker-rights with fixed search paths, matching the
-- public platform catalogue.

CREATE TABLE public.payment_truth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id text NOT NULL,
  event_fingerprint text NOT NULL,
  ingest_idempotency_key text NOT NULL,
  settlement_intent_id uuid NOT NULL REFERENCES public.commerce_settlement_intents(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'open',
  outcome text NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code text NOT NULL,
  failure_class text,
  failure_reason text,
  source_evidence jsonb NOT NULL,
  settlement_transition_id uuid REFERENCES public.commerce_settlement_transitions(id) ON DELETE RESTRICT,
  dunning_case_id uuid REFERENCES public.subscription_dunning_cases(id) ON DELETE SET NULL,
  accounting_document_id uuid REFERENCES public.accounting_documents(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  settled_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_truth_events_source_event_id_key UNIQUE (source_event_id),
  CONSTRAINT payment_truth_events_ingest_idempotency_key_key UNIQUE (ingest_idempotency_key),
  CONSTRAINT payment_truth_events_source_event_id_check CHECK (btrim(source_event_id) <> ''),
  CONSTRAINT payment_truth_events_event_fingerprint_check CHECK (event_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_truth_events_state_check CHECK (state IN ('open', 'settled')),
  CONSTRAINT payment_truth_events_outcome_check CHECK (outcome IN ('captured', 'refused', 'indeterminate')),
  CONSTRAINT payment_truth_events_amount_check CHECK (amount_minor > 0),
  CONSTRAINT payment_truth_events_currency_check CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_truth_events_evidence_check CHECK (jsonb_typeof(source_evidence) = 'object'),
  CONSTRAINT payment_truth_events_failure_class_check CHECK (
    failure_class IS NULL OR failure_class IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    )
  ),
  CONSTRAINT payment_truth_events_refusal_check CHECK (
    (outcome = 'refused' AND failure_class IS NOT NULL)
    OR (outcome <> 'refused' AND failure_class IS NULL AND failure_reason IS NULL)
  ),
  CONSTRAINT payment_truth_events_settled_at_check CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
  CONSTRAINT payment_truth_events_transition_check CHECK (
    (state = 'settled') = (settlement_transition_id IS NOT NULL)
  ),
  CONSTRAINT payment_truth_events_accounting_check CHECK (
    accounting_document_id IS NULL OR (state = 'settled' AND outcome = 'captured')
  ),
  CONSTRAINT payment_truth_events_dunning_check CHECK (
    dunning_case_id IS NULL OR (state = 'settled' AND outcome = 'refused')
  )
);

CREATE INDEX idx_payment_truth_events_open
  ON public.payment_truth_events (occurred_at, id)
  WHERE state = 'open';

CREATE TABLE public.payment_truth_reconciliation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.payment_truth_events(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  evidence_fingerprint text NOT NULL,
  evidence_status text NOT NULL,
  outcome text NOT NULL,
  failure_class text,
  failure_reason text,
  source_evidence jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_truth_reconciliation_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT payment_truth_reconciliation_fingerprint_check CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_truth_reconciliation_status_check CHECK (evidence_status IN ('observed', 'failed')),
  CONSTRAINT payment_truth_reconciliation_outcome_check CHECK (outcome IN ('captured', 'refused', 'indeterminate')),
  CONSTRAINT payment_truth_reconciliation_evidence_check CHECK (jsonb_typeof(source_evidence) = 'object'),
  CONSTRAINT payment_truth_reconciliation_failure_class_check CHECK (
    failure_class IS NULL OR failure_class IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    )
  ),
  CONSTRAINT payment_truth_reconciliation_failed_open_check CHECK (
    evidence_status <> 'failed' OR outcome = 'indeterminate'
  ),
  CONSTRAINT payment_truth_reconciliation_refusal_check CHECK (
    (outcome = 'refused' AND failure_class IS NOT NULL)
    OR (outcome <> 'refused' AND failure_class IS NULL AND failure_reason IS NULL)
  )
);

CREATE INDEX idx_payment_truth_reconciliation_event
  ON public.payment_truth_reconciliation_evidence (event_id, occurred_at DESC);

CREATE FUNCTION public.payment_truth_readback(
  p_event_id uuid,
  p_replayed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'event', jsonb_build_object(
      'id', event.id,
      'sourceEventId', event.source_event_id,
      'fingerprint', event.event_fingerprint,
      'state', event.state,
      'outcome', event.outcome,
      'replayed', p_replayed
    ),
    'effects', jsonb_build_object(
      'paymentResultRecorded', event.settlement_transition_id IS NOT NULL,
      'dunningOpened', event.dunning_case_id IS NOT NULL,
      'accountingRequested', event.accounting_document_id IS NOT NULL
    ),
    'financial', jsonb_build_object(
      'settlementStatus', settlement.status,
      'orderStatus', order_row.status,
      'subscriptionStatus', subscription.status,
      'accountingStatus', document.status,
      'amountMinor', event.amount_minor,
      'currency', event.currency_code
    )
  )
  FROM public.payment_truth_events event
  JOIN public.commerce_settlement_intents settlement ON settlement.id = event.settlement_intent_id
  JOIN public.commerce_orders order_row ON order_row.id = settlement.order_id
  LEFT JOIN public.subscription_cycles cycle ON cycle.id = order_row.subscription_cycle_id
  LEFT JOIN public.subscriptions subscription ON subscription.id = cycle.subscription_id
  LEFT JOIN public.accounting_documents document ON document.id = event.accounting_document_id
  WHERE event.id = p_event_id;
$$;

CREATE FUNCTION public.payment_truth_apply_terminal(
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
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description', 'order position ' || item.line_ordinal::text,
      'quantity', item.quantity,
      'unitGrossMinor', item.unit_amount_minor,
      'totalGrossMinor', item.line_amount_minor,
      'taxRateBps', 0
    ) ORDER BY item.line_ordinal), '[]'::jsonb)
    INTO v_positions
    FROM public.commerce_order_items item
    WHERE item.order_id = v_order.id;

    v_accounting := public.accounting_document_request_from_paid_order(
      p_idempotency_key || ':accounting',
      v_order.id,
      v_positions,
      v_event.amount_minor,
      jsonb_build_object(
        'paymentTruthEventId', v_event.id,
        'currency', v_event.currency_code,
        'sourceEvidence', COALESCE(p_source_evidence, '{}'::jsonb)
      ),
      p_occurred_at
    );
    v_accounting_document_id := (v_accounting->'document'->>'id')::uuid;

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

CREATE FUNCTION public.payment_truth_ingest_event(
  p_source_event_id text,
  p_event_fingerprint text,
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_outcome text,
  p_amount_minor bigint,
  p_currency_code text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
BEGIN
  IF p_source_event_id IS NULL OR btrim(p_source_event_id) = ''
    OR p_event_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_outcome NOT IN ('captured', 'refused', 'indeterminate')
    OR p_amount_minor IS NULL OR p_amount_minor < 1
    OR p_currency_code !~ '^[A-Z]{3}$'
    OR p_source_evidence IS NULL OR jsonb_typeof(p_source_evidence) <> 'object'
    OR (p_outcome = 'refused') IS DISTINCT FROM (p_failure_class IS NOT NULL)
    OR (p_failure_class IS NOT NULL AND p_failure_class NOT IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    ))
  THEN
    RAISE EXCEPTION 'payment_truth_event_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_truth_events (
    source_event_id, event_fingerprint, ingest_idempotency_key,
    settlement_intent_id, state, outcome, amount_minor, currency_code,
    failure_class, failure_reason, source_evidence, occurred_at, updated_at
  ) VALUES (
    p_source_event_id, p_event_fingerprint, p_idempotency_key,
    p_settlement_intent_id, 'open', p_outcome, p_amount_minor, p_currency_code,
    p_failure_class, p_failure_reason, p_source_evidence, p_occurred_at, p_occurred_at
  )
  ON CONFLICT ON CONSTRAINT payment_truth_events_source_event_id_key DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    SELECT * INTO v_event
    FROM public.payment_truth_events
    WHERE source_event_id = p_source_event_id
    FOR UPDATE;
    IF v_event.event_fingerprint IS DISTINCT FROM p_event_fingerprint THEN
      RAISE EXCEPTION 'payment_truth_event_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.payment_truth_readback(v_event.id, true);
  END IF;

  IF p_outcome IN ('captured', 'refused') THEN
    PERFORM public.payment_truth_apply_terminal(
      v_event.id, p_idempotency_key, p_outcome, p_occurred_at,
      p_failure_class, p_failure_reason, p_source_evidence,
      p_dunning_template_slug, p_recovery_url_path, p_recovery_template_slug
    );
  END IF;
  RETURN public.payment_truth_readback(v_event.id, false);
END;
$$;

CREATE FUNCTION public.payment_truth_record_reconciliation(
  p_event_id uuid,
  p_idempotency_key text,
  p_evidence_fingerprint text,
  p_evidence_status text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
  v_evidence public.payment_truth_reconciliation_evidence%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_evidence_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_evidence_status NOT IN ('observed', 'failed')
    OR p_outcome NOT IN ('captured', 'refused', 'indeterminate')
    OR (p_evidence_status = 'failed' AND p_outcome <> 'indeterminate')
    OR (p_outcome = 'refused') IS DISTINCT FROM (p_failure_class IS NOT NULL)
    OR (p_failure_class IS NOT NULL AND p_failure_class NOT IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    ))
    OR p_source_evidence IS NULL OR jsonb_typeof(p_source_evidence) <> 'object'
  THEN
    RAISE EXCEPTION 'payment_truth_reconciliation_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_truth_event_not_found' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.payment_truth_reconciliation_evidence (
    event_id, idempotency_key, evidence_fingerprint, evidence_status,
    outcome, failure_class, failure_reason, source_evidence, occurred_at
  ) VALUES (
    p_event_id, p_idempotency_key, p_evidence_fingerprint, p_evidence_status,
    p_outcome, p_failure_class, p_failure_reason, p_source_evidence, p_occurred_at
  )
  ON CONFLICT ON CONSTRAINT payment_truth_reconciliation_idempotency_key_key DO NOTHING
  RETURNING * INTO v_evidence;

  IF NOT FOUND THEN
    SELECT * INTO v_evidence
    FROM public.payment_truth_reconciliation_evidence
    WHERE idempotency_key = p_idempotency_key;
    IF v_evidence.event_id IS DISTINCT FROM p_event_id
      OR v_evidence.evidence_fingerprint IS DISTINCT FROM p_evidence_fingerprint
    THEN
      RAISE EXCEPTION 'payment_truth_reconciliation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.payment_truth_readback(v_event.id, true);
  END IF;

  UPDATE public.payment_truth_events
  SET last_reconciled_at = p_occurred_at, updated_at = p_occurred_at
  WHERE id = v_event.id;

  IF v_event.state = 'open'
    AND p_evidence_status = 'observed'
    AND p_outcome IN ('captured', 'refused')
  THEN
    PERFORM public.payment_truth_apply_terminal(
      v_event.id, p_idempotency_key, p_outcome, p_occurred_at,
      p_failure_class, p_failure_reason, p_source_evidence,
      p_dunning_template_slug, p_recovery_url_path, p_recovery_template_slug
    );
    UPDATE public.payment_truth_reconciliation_evidence
    SET applied_at = p_occurred_at WHERE id = v_evidence.id;
  END IF;

  RETURN public.payment_truth_readback(v_event.id, false);
END;
$$;

CREATE FUNCTION public.payment_truth_sweep_open_events(
  p_now timestamptz,
  p_limit integer
)
RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  WITH open_events AS (
    SELECT id FROM public.payment_truth_events
    WHERE state = 'open' AND occurred_at <= p_now
    ORDER BY occurred_at, id
    LIMIT GREATEST(COALESCE(p_limit, 1), 1)
    FOR UPDATE SKIP LOCKED
  )
  SELECT jsonb_build_object(
    'claimed', count(*)::integer,
    'settledIgnored', (SELECT count(*)::integer FROM public.payment_truth_events WHERE state = 'settled'),
    'eventIds', COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)
  ) FROM open_events;
$$;
