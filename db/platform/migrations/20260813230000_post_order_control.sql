-- Public post-order control forward.
--
-- This migration extends the existing public order/hold, settlement, shipment and outbox rails
-- with the smallest provider-neutral facts needed to assess a paid order, review that assessment,
-- accept a customer return request and decide it, and create a machine-owned fulfilment-exception
-- hold. It does not copy the managed order queue, provider attempts, payment attempts, carrier
-- evidence, private return logistics, customer PII, or any provider RPC body.
--
-- All functions are invoker-rights and parameterized by their callers. The host authenticates the
-- customer/operator; the database verifies that the supplied principal exists and owns the order
-- or operator row. There is no service role, SECURITY DEFINER, GRANT, REVOKE or RLS in this forward.
-- Idempotency is durable in the assessment/case-event/return-operation ledgers. Replays compare the
-- action identity they answer; a changed command under the same key is a 23505 conflict.

CREATE TABLE public.risk_blocklist_entries (
  subject_kind text NOT NULL,
  subject_hash text NOT NULL,
  reason_code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_blocklist_entries_subject_hash_check
    CHECK (char_length(subject_hash) BETWEEN 16 AND 128),
  CONSTRAINT risk_blocklist_entries_subject_key
    UNIQUE (subject_kind, subject_hash, reason_code)
);

CREATE TABLE public.risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  settlement_intent_id uuid REFERENCES public.commerce_settlement_intents(id) ON DELETE SET NULL,
  mode text NOT NULL,
  decision text NOT NULL,
  risk_score integer NOT NULL,
  severity text NOT NULL,
  reason_codes text[] NOT NULL DEFAULT '{}',
  subject_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_fingerprint text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_assessments_mode_check CHECK (mode IN ('shadow', 'hold')),
  CONSTRAINT risk_assessments_decision_check CHECK (decision IN ('allow', 'manual_review', 'block')),
  CONSTRAINT risk_assessments_score_check CHECK (risk_score BETWEEN 0 AND 100),
  CONSTRAINT risk_assessments_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE INDEX idx_risk_assessments_order ON public.risk_assessments (order_id, created_at DESC);

CREATE TABLE public.risk_manual_review_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL UNIQUE REFERENCES public.risk_assessments(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open',
  severity text NOT NULL,
  decision text NOT NULL,
  risk_score integer NOT NULL,
  reason_codes text[] NOT NULL DEFAULT '{}',
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  payment_intent_id uuid REFERENCES public.commerce_settlement_intents(id) ON DELETE SET NULL,
  hold_id uuid REFERENCES public.commerce_order_holds(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT risk_manual_review_cases_status_check
    CHECK (status IN ('open', 'in_review', 'approved', 'blocked', 'escalated', 'closed')),
  CONSTRAINT risk_manual_review_cases_decision_check
    CHECK (decision IN ('allow', 'manual_review', 'block')),
  CONSTRAINT risk_manual_review_cases_severity_check
    CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE INDEX idx_risk_manual_review_cases_updated
  ON public.risk_manual_review_cases (updated_at DESC);

CREATE TABLE public.risk_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.risk_manual_review_cases(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES public.commerce_operators(id) ON DELETE SET NULL,
  note text,
  idempotency_key text NOT NULL UNIQUE,
  command_fingerprint text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_case_events_event_type_check
    CHECK (event_type IN ('opened', 'approve', 'block', 'escalate', 'note')),
  CONSTRAINT risk_case_events_note_check CHECK (note IS NULL OR char_length(note) <= 2000)
);

CREATE INDEX idx_risk_case_events_case ON public.risk_case_events (case_id, occurred_at DESC);

CREATE TABLE public.commerce_return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  requested_by uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  reason_code text NOT NULL,
  customer_note text,
  status text NOT NULL DEFAULT 'requested',
  refund_mode text,
  refund_amount_minor bigint,
  admin_note text,
  decided_by uuid REFERENCES public.commerce_operators(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_return_requests_reason_check
    CHECK (reason_code IN ('damaged', 'wrong_item', 'not_as_described', 'pet_refused', 'changed_mind', 'other')),
  CONSTRAINT commerce_return_requests_status_check CHECK (status IN ('requested', 'approved', 'rejected')),
  CONSTRAINT commerce_return_requests_refund_mode_check CHECK (refund_mode IS NULL OR refund_mode IN ('full', 'partial', 'none')),
  CONSTRAINT commerce_return_requests_refund_amount_check CHECK (refund_amount_minor IS NULL OR refund_amount_minor >= 0),
  CONSTRAINT commerce_return_requests_notes_check CHECK (
    (customer_note IS NULL OR char_length(customer_note) <= 2000)
    AND (admin_note IS NULL OR char_length(admin_note) <= 2000)
  )
);

CREATE INDEX idx_commerce_return_requests_order
  ON public.commerce_return_requests (order_id, requested_at DESC);

CREATE TABLE public.commerce_return_lines (
  return_request_id uuid NOT NULL REFERENCES public.commerce_return_requests(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.commerce_order_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  restock_disposition text NOT NULL,
  PRIMARY KEY (return_request_id, order_item_id),
  CONSTRAINT commerce_return_lines_quantity_check CHECK (quantity > 0),
  CONSTRAINT commerce_return_lines_disposition_check
    CHECK (restock_disposition IN ('restock', 'quarantine', 'scrap'))
);

CREATE TABLE public.commerce_return_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id uuid NOT NULL REFERENCES public.commerce_return_requests(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  command_fingerprint text NOT NULL,
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_return_operations_type_check
    CHECK (operation_type IN ('requested', 'approved', 'rejected'))
);

CREATE INDEX idx_commerce_return_operations_request
  ON public.commerce_return_operations (return_request_id, occurred_at DESC);

CREATE FUNCTION public.risk_check_exact_blocklist(p_subject_refs jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  WITH requested AS (
    SELECT value->>'subjectKind' AS subject_kind, value->>'subjectHash' AS subject_hash
      FROM jsonb_array_elements(COALESCE(p_subject_refs, '[]'::jsonb))
  ), matches AS (
    SELECT DISTINCT entry.reason_code
      FROM requested
      JOIN public.risk_blocklist_entries entry USING (subject_kind, subject_hash)
     WHERE entry.active
  )
  SELECT jsonb_build_object(
    'blocked', EXISTS (SELECT 1 FROM matches),
    'reasonCodes', COALESCE((SELECT jsonb_agg(reason_code ORDER BY reason_code) FROM matches), '[]'::jsonb)
  );
$$;

CREATE FUNCTION public.risk_assess_paid_order(
  p_idempotency_key text,
  p_order_id uuid,
  p_payment_intent_id uuid,
  p_payment_event_id uuid,
  p_mode text,
  p_evaluation jsonb,
  p_subject_refs jsonb,
  p_evidence jsonb,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.risk_assessments%ROWTYPE;
  v_assessment public.risk_assessments%ROWTYPE;
  v_case public.risk_manual_review_cases%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_hold public.commerce_order_holds%ROWTYPE;
  v_fingerprint text;
  v_decision text := p_evaluation->>'decision';
  v_score integer := (p_evaluation->>'score')::integer;
  v_severity text := p_evaluation->>'severity';
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL OR p_mode NOT IN ('shadow', 'hold')
    OR v_decision NOT IN ('allow', 'manual_review', 'block')
    OR v_score IS NULL OR v_score < 0 OR v_score > 100
    OR v_severity NOT IN ('low', 'medium', 'high', 'critical')
  THEN RAISE EXCEPTION 'risk_assess_paid_order_invalid_input' USING ERRCODE = '22023'; END IF;

  v_fingerprint := encode(sha256(convert_to(concat_ws('|', p_order_id::text,
    COALESCE(p_payment_intent_id::text, ''), p_mode, p_evaluation::text,
    COALESCE(p_subject_refs, '[]'::jsonb)::text), 'UTF8')), 'hex');
  SELECT * INTO v_existing FROM public.risk_assessments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'risk_assess_paid_order_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_case FROM public.risk_manual_review_cases WHERE assessment_id = v_existing.id;
    RETURN jsonb_build_object('assessmentId', v_existing.id, 'caseId', v_case.id,
      'holdId', v_case.hold_id, 'decision', v_existing.decision,
      'holdOpened', v_case.hold_id IS NOT NULL, 'replayed', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status NOT IN ('paid', 'fulfillment_pending', 'fulfilled') THEN
    RAISE EXCEPTION 'risk_assess_paid_order_not_paid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.risk_assessments
    (idempotency_key, order_id, settlement_intent_id, mode, decision, risk_score, severity,
     reason_codes, subject_refs, evidence, matched_rules, request_fingerprint, occurred_at)
  VALUES (p_idempotency_key, p_order_id, p_payment_intent_id, p_mode, v_decision, v_score, v_severity,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_evaluation->'reasonCodes', '[]'::jsonb))),
    COALESCE(p_subject_refs, '[]'::jsonb), COALESCE(p_evidence, '{}'::jsonb),
    COALESCE(p_evaluation->'matchedRules', '[]'::jsonb), v_fingerprint, p_occurred_at)
  RETURNING * INTO v_assessment;

  IF v_decision <> 'allow' THEN
    IF p_mode = 'hold' THEN
      INSERT INTO public.commerce_order_holds
        (order_id, reason, created_by, idempotency_key, metadata, created_at, updated_at)
      VALUES (p_order_id, 'risk_review', NULL, p_idempotency_key || ':hold',
        jsonb_build_object('assessmentId', v_assessment.id), p_occurred_at, p_occurred_at)
      RETURNING * INTO v_hold;
    END IF;
    INSERT INTO public.risk_manual_review_cases
      (assessment_id, status, severity, decision, risk_score, reason_codes, order_id, client_id,
       payment_intent_id, hold_id, opened_at, updated_at)
    VALUES (v_assessment.id, 'open', v_severity, v_decision, v_score, v_assessment.reason_codes,
      p_order_id, v_order.client_id, p_payment_intent_id, v_hold.id, p_occurred_at, p_occurred_at)
    RETURNING * INTO v_case;
    INSERT INTO public.risk_case_events
      (case_id, event_type, idempotency_key, command_fingerprint, occurred_at)
    VALUES (v_case.id, 'opened', p_idempotency_key || ':opened', v_fingerprint, p_occurred_at);
  END IF;

  RETURN jsonb_build_object('assessmentId', v_assessment.id, 'caseId', v_case.id,
    'holdId', v_case.hold_id, 'decision', v_assessment.decision,
    'holdOpened', v_case.hold_id IS NOT NULL, 'replayed', false);
END;
$$;

CREATE FUNCTION public.risk_resolve_manual_review_case(
  p_idempotency_key text,
  p_case_id uuid,
  p_decision text,
  p_actor_user_id uuid,
  p_note text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.risk_manual_review_cases%ROWTYPE;
  v_event public.risk_case_events%ROWTYPE;
  v_fingerprint text;
  v_status text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_case_id IS NULL OR p_actor_user_id IS NULL
    OR p_decision NOT IN ('approve', 'block', 'escalate', 'note')
    OR (p_note IS NOT NULL AND char_length(p_note) > 2000)
  THEN RAISE EXCEPTION 'risk_resolve_manual_review_case_invalid_input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_operators WHERE id = p_actor_user_id) THEN
    RAISE EXCEPTION 'risk_resolve_manual_review_case_actor_unknown' USING ERRCODE = '23503';
  END IF;
  v_fingerprint := encode(sha256(convert_to(concat_ws('|', p_case_id::text, p_decision,
    COALESCE(p_note, '')), 'UTF8')), 'hex');
  SELECT * INTO v_event FROM public.risk_case_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_event.command_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'risk_resolve_manual_review_case_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('caseId', p_case_id, 'replayed', true);
  END IF;
  SELECT * INTO v_case FROM public.risk_manual_review_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'risk_case_not_found' USING ERRCODE = '22023'; END IF;
  IF v_case.status NOT IN ('open', 'in_review', 'escalated') AND p_decision <> 'note' THEN
    RAISE EXCEPTION 'risk_case_already_closed' USING ERRCODE = '23505';
  END IF;
  v_status := CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'block' THEN 'blocked'
    WHEN 'escalate' THEN 'escalated' ELSE v_case.status END;
  IF p_decision = 'approve' AND v_case.hold_id IS NOT NULL THEN
    PERFORM public.oms_release_hold(p_idempotency_key || ':hold', v_case.hold_id, p_note,
      p_actor_user_id, NULL, COALESCE(p_metadata, '{}'::jsonb), now());
  END IF;
  UPDATE public.risk_manual_review_cases SET status = v_status, updated_at = now()
   WHERE id = p_case_id RETURNING * INTO v_case;
  INSERT INTO public.risk_case_events
    (case_id, event_type, actor_user_id, note, idempotency_key, command_fingerprint)
  VALUES (p_case_id, p_decision, p_actor_user_id, p_note, p_idempotency_key, v_fingerprint);
  RETURN jsonb_build_object('caseId', p_case_id, 'status', v_case.status, 'replayed', false);
END;
$$;

CREATE FUNCTION public.commerce_return_request_create(
  p_idempotency_key text,
  p_order_id uuid,
  p_lines jsonb,
  p_reason_code text,
  p_customer_note text,
  p_requested_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_return_operations%ROWTYPE;
  v_request public.commerce_return_requests%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_client_id uuid;
  v_line jsonb;
  v_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL OR p_requested_by IS NULL
    OR p_reason_code NOT IN ('damaged', 'wrong_item', 'not_as_described', 'pet_refused', 'changed_mind', 'other')
    OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0
  THEN RAISE EXCEPTION 'commerce_return_request_create_invalid_input' USING ERRCODE = '22023'; END IF;
  v_fingerprint := encode(sha256(convert_to(concat_ws('|', p_order_id::text,
    p_requested_by::text, p_reason_code, p_lines::text, COALESCE(p_customer_note, '')), 'UTF8')), 'hex');
  SELECT * INTO v_existing FROM public.commerce_return_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'requested' OR v_existing.command_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'commerce_return_request_create_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_request FROM public.commerce_return_requests WHERE id = v_existing.return_request_id;
    RETURN jsonb_build_object('returnRequestId', v_request.id, 'status', v_request.status, 'replayed', true);
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  SELECT id INTO v_client_id FROM public.clients WHERE principal_id = p_requested_by;
  IF v_client_id IS NULL OR NOT FOUND OR v_order.client_id IS DISTINCT FROM v_client_id
    OR v_order.status NOT IN ('paid', 'fulfillment_pending', 'fulfilled') THEN
    RAISE EXCEPTION 'commerce_return_request_create_not_returnable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.commerce_return_requests (order_id, requested_by, reason_code, customer_note)
  VALUES (p_order_id, v_client_id, p_reason_code, p_customer_note) RETURNING * INTO v_request;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO public.commerce_return_lines
      (return_request_id, order_item_id, quantity, restock_disposition)
    SELECT v_request.id, item.id, (v_line->>'quantity')::integer,
      COALESCE(v_line->>'restockDisposition', 'restock')
      FROM public.commerce_order_items item
     WHERE item.id = (v_line->>'orderItemId')::uuid AND item.order_id = p_order_id
       AND (v_line->>'quantity')::integer > 0
       AND (v_line->>'quantity')::integer <= item.quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'commerce_return_request_create_line_not_in_order' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  INSERT INTO public.commerce_return_operations
    (return_request_id, operation_type, idempotency_key, command_fingerprint, actor_id)
  VALUES (v_request.id, 'requested', p_idempotency_key, v_fingerprint, p_requested_by);
  RETURN jsonb_build_object('returnRequestId', v_request.id, 'status', v_request.status, 'replayed', false);
END;
$$;

CREATE FUNCTION public.commerce_return_approve(
  p_idempotency_key text,
  p_return_request_id uuid,
  p_approved_by uuid,
  p_refund_mode text,
  p_refund_amount_cents bigint,
  p_admin_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_return_operations%ROWTYPE;
  v_request public.commerce_return_requests%ROWTYPE;
  v_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_return_request_id IS NULL OR p_approved_by IS NULL
    OR p_refund_mode NOT IN ('full', 'partial', 'none')
    OR (p_refund_amount_cents IS NOT NULL AND p_refund_amount_cents < 0)
  THEN RAISE EXCEPTION 'commerce_return_approve_invalid_input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_operators WHERE id = p_approved_by) THEN
    RAISE EXCEPTION 'commerce_return_approve_actor_unknown' USING ERRCODE = '23503'; END IF;
  v_fingerprint := encode(sha256(convert_to(concat_ws('|', p_return_request_id::text,
    p_refund_mode, COALESCE(p_refund_amount_cents::text, ''), COALESCE(p_admin_note, '')), 'UTF8')), 'hex');
  SELECT * INTO v_existing FROM public.commerce_return_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'approved' OR v_existing.command_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'commerce_return_approve_idempotency_conflict' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('returnRequestId', p_return_request_id, 'status', 'approved', 'replayed', true);
  END IF;
  SELECT * INTO v_request FROM public.commerce_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'commerce_return_approve_invalid_state' USING ERRCODE = '22023'; END IF;
  UPDATE public.commerce_return_requests SET status = 'approved', refund_mode = p_refund_mode,
    refund_amount_minor = p_refund_amount_cents, admin_note = p_admin_note,
    decided_by = p_approved_by, updated_at = now() WHERE id = p_return_request_id;
  INSERT INTO public.commerce_return_operations
    (return_request_id, operation_type, idempotency_key, command_fingerprint, actor_id)
  VALUES (p_return_request_id, 'approved', p_idempotency_key, v_fingerprint, p_approved_by);
  RETURN jsonb_build_object('returnRequestId', p_return_request_id, 'status', 'approved', 'replayed', false);
END;
$$;

CREATE FUNCTION public.commerce_return_reject(
  p_idempotency_key text,
  p_return_request_id uuid,
  p_approved_by uuid,
  p_admin_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_return_operations%ROWTYPE;
  v_request public.commerce_return_requests%ROWTYPE;
  v_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_return_request_id IS NULL OR p_approved_by IS NULL
  THEN RAISE EXCEPTION 'commerce_return_reject_invalid_input' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_operators WHERE id = p_approved_by) THEN
    RAISE EXCEPTION 'commerce_return_reject_actor_unknown' USING ERRCODE = '23503'; END IF;
  v_fingerprint := encode(sha256(convert_to(concat_ws('|', p_return_request_id::text,
    COALESCE(p_admin_note, '')), 'UTF8')), 'hex');
  SELECT * INTO v_existing FROM public.commerce_return_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'rejected' OR v_existing.command_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'commerce_return_reject_idempotency_conflict' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('returnRequestId', p_return_request_id, 'status', 'rejected', 'replayed', true);
  END IF;
  SELECT * INTO v_request FROM public.commerce_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'commerce_return_reject_invalid_state' USING ERRCODE = '22023'; END IF;
  UPDATE public.commerce_return_requests SET status = 'rejected', admin_note = p_admin_note,
    decided_by = p_approved_by, updated_at = now() WHERE id = p_return_request_id;
  INSERT INTO public.commerce_return_operations
    (return_request_id, operation_type, idempotency_key, command_fingerprint, actor_id)
  VALUES (p_return_request_id, 'rejected', p_idempotency_key, v_fingerprint, p_approved_by);
  RETURN jsonb_build_object('returnRequestId', p_return_request_id, 'status', 'rejected', 'replayed', false);
END;
$$;

CREATE FUNCTION public.oms_create_system_hold(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_note text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_operations%ROWTYPE;
  v_hold public.commerce_order_holds%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL OR p_reason <> 'fulfillment_exception'
  THEN RAISE EXCEPTION 'oms_create_system_hold_invalid_input' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_existing FROM public.commerce_order_operations
   WHERE idempotency_key = p_idempotency_key || ':operation';
  IF FOUND THEN
    IF v_existing.operation_type <> 'hold_created' OR v_existing.order_id IS DISTINCT FROM p_order_id THEN
      RAISE EXCEPTION 'oms_create_system_hold_idempotency_conflict' USING ERRCODE = '23505'; END IF;
    SELECT * INTO v_hold FROM public.commerce_order_holds WHERE id = v_existing.hold_id;
    RETURN public.oms_hold_response(v_hold, v_existing.id, true);
  END IF;
  PERFORM 1 FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'oms_create_system_hold_order_not_found' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.commerce_order_holds
    (order_id, reason, note, created_by, idempotency_key, metadata, created_at, updated_at)
  VALUES (p_order_id, p_reason, p_note, NULL, p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb), p_requested_at, p_requested_at) RETURNING * INTO v_hold;
  INSERT INTO public.commerce_order_operations
    (order_id, hold_id, actor_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_order_id, v_hold.id, NULL, 'hold_created', p_idempotency_key || ':operation',
    jsonb_build_object('reason', p_reason, 'note', p_note), p_requested_at) RETURNING * INTO v_existing;
  RETURN public.oms_hold_response(v_hold, v_existing.id, false);
END;
$$;

CREATE FUNCTION public.outbox_requeue_discarded(
  p_event_ids uuid[],
  p_event_type text,
  p_limit integer,
  p_requeued_by text,
  p_reason text
)
RETURNS SETOF public.outbox_events
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF p_event_ids IS NULL OR cardinality(p_event_ids) = 0
    OR p_event_type <> 'commerce.order.paid'
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
    OR p_requeued_by IS NULL OR btrim(p_requeued_by) = ''
    OR p_reason IS NULL OR btrim(p_reason) = ''
  THEN RAISE EXCEPTION 'outbox_requeue_discarded_invalid_input' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH selected AS (
    SELECT id FROM public.outbox_events
     WHERE id = ANY(p_event_ids) AND event_type = p_event_type AND status = 'discarded'
     ORDER BY created_at, id LIMIT p_limit FOR UPDATE
  )
  UPDATE public.outbox_events event
     SET status = 'pending', attempts = 0, available_at = now(), processed_at = NULL,
         error = NULL, metadata = event.metadata || jsonb_build_object(
           'requeuedBy', p_requeued_by, 'requeueReason', p_reason, 'requeuedAt', now())
    FROM selected WHERE event.id = selected.id RETURNING event.*;
END;
$$;
