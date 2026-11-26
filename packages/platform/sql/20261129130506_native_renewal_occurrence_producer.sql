-- Dormant Subscriptions owner boundary for the first native renewal occurrence.
CREATE FUNCTION public.subscriptions__allocate_renewal_occurrence(
  p_client_id uuid, p_subscription_id uuid, p_requested_rail text, p_accepted_cancellation_rule jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parent public.subscriptions%ROWTYPE;
  retained public.subscription_cycle_occurrences%ROWTYPE;
  activation_order uuid;
  activation_cycle uuid;
  activation_days integer;
  event_cadence jsonb;
  cadence bigint;
  rule jsonb := p_accepted_cancellation_rule;
  rule_ref text;
  revision numeric;
  lead numeric;
  disposition text;
  cause text;
  outcome text := 'existing';
  blank_ref constant text := '[[:space:]                 　﻿]*';
  first_utc constant timestamptz := '0001-01-01 00:00:00+00';
  end_utc constant timestamptz := '10000-01-01 00:00:00+00';
BEGIN
  <<validate>>
  BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      cause := 'isolation_required'; EXIT validate;
    END IF;
    IF p_requested_rail IS NULL OR p_requested_rail NOT IN ('legacy', 'v3') THEN
      RAISE EXCEPTION 'renewal_v3_unavailable' USING ERRCODE = '22023', DETAIL = '/rail';
    END IF;

    SELECT * INTO parent FROM public.subscriptions
      WHERE id = p_subscription_id AND client_id = p_client_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE = '22023', DETAIL = '/subscriptionId';
    END IF;
    IF EXISTS (SELECT FROM public.subscription_cycle_occurrences WHERE subscription_id = parent.id AND NOT is_current) THEN
      cause := 'noncurrent_occurrence'; EXIT validate;
    END IF;
    SELECT * INTO retained FROM public.subscription_cycle_occurrences WHERE subscription_id = parent.id AND is_current;
    IF FOUND AND retained.client_id IS DISTINCT FROM parent.client_id THEN
      cause := 'current_conflict'; EXIT validate;
    END IF;
    IF parent.status NOT IN ('active', 'paused') THEN
      RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE = '22023', DETAIL = '/cycleKey';
    END IF;

    SELECT o.id, c.id, a.cadence_days, e.payload->'cadenceDays'
      INTO activation_order, activation_cycle, activation_days, event_cadence
    FROM public.subscription_activations a
    JOIN public.commerce_orders o ON o.id = a.order_id AND o.client_id = parent.client_id
    JOIN public.commerce_settlement_intents i ON i.order_id = o.id AND i.status = 'settled' AND i.settled_at = a.activated_at
    JOIN public.subscription_cycles c ON c.id = o.subscription_cycle_id AND c.subscription_id = parent.id
      AND c.status = 'paid' AND c.scheduled_at = a.activated_at
    JOIN public.subscription_events e ON e.subscription_id = parent.id AND e.event_type = 'subscription.activated'
      AND e.idempotency_key = a.activation_idempotency_key AND e.occurred_at = a.activated_at AND e.payload->'orderId' = to_jsonb(o.id)
    WHERE a.subscription_id = parent.id AND a.client_id = parent.client_id AND a.state = 'active'
      AND isfinite(a.activated_at) AND o.renewal_operation_id IS NULL AND c.renewal_operation_id IS NULL
      AND a.payment_fingerprint = encode(sha256(convert_to(COALESCE(i.external_ref, i.id::text), 'UTF8')), 'hex')
      AND (SELECT count(*) FROM public.subscription_activations WHERE subscription_id = parent.id) = 1
      AND (SELECT count(*) FROM public.subscription_events WHERE subscription_id = parent.id AND event_type = 'subscription.activated') = 1;
    IF NOT FOUND THEN
      cause := 'unsupported_activation'; EXIT validate;
    END IF;
    IF activation_days NOT BETWEEN 1 AND 3660 OR parent.cadence_days IS DISTINCT FROM activation_days
      OR event_cadence IS DISTINCT FROM to_jsonb(activation_days) THEN
      cause := 'invalid_activation_cadence'; EXIT validate;
    END IF;
    cadence := activation_days * 86400::bigint;

    -- Follow direct links and inbound links before classifying even an exempt settlement.
    WITH roots AS (
      SELECT id, scheduled_at, state FROM public.subscription_renewal_operations WHERE subscription_id = parent.id
    ), cycles AS (
      SELECT id, subscription_id, renewal_operation_id FROM public.subscription_cycles
      WHERE subscription_id = parent.id OR renewal_operation_id IN (SELECT id FROM roots)
    ), orders AS (
      SELECT id, client_id, subscription_cycle_id, renewal_operation_id FROM public.commerce_orders
      WHERE subscription_cycle_id IN (SELECT id FROM cycles) OR renewal_operation_id IN (SELECT id FROM roots)
    ), intents AS (
      SELECT id, order_id, renewal_operation_id FROM public.commerce_settlement_intents
      WHERE order_id IN (SELECT id FROM orders) OR renewal_operation_id IN (SELECT id FROM roots)
    ), edges AS (
      SELECT 'stock_wait' AS kind, w.subscription_id, w.client_id, w.renewal_operation_id, w.cycle_id, w.order_id,
        NULL::uuid AS settlement_intent_id
      FROM public.subscription_stock_wait_cases w
      WHERE w.subscription_id = parent.id OR w.renewal_operation_id IN (SELECT id FROM roots)
        OR w.cycle_id IN (SELECT id FROM cycles) OR w.order_id IN (SELECT id FROM orders)
      UNION ALL
      SELECT 'retry_obligation', r.subscription_id, parent.client_id, r.renewal_operation_id, r.cycle_id, r.order_id, r.settlement_intent_id
      FROM public.subscription_retry_obligations r
      WHERE r.subscription_id = parent.id OR r.renewal_operation_id IN (SELECT id FROM roots)
        OR r.cycle_id IN (SELECT id FROM cycles) OR r.order_id IN (SELECT id FROM orders)
        OR r.settlement_intent_id IN (SELECT id FROM intents)
    )
    SELECT CASE
      WHEN EXISTS (SELECT FROM cycles WHERE subscription_id <> parent.id
        OR (renewal_operation_id IS NOT NULL AND renewal_operation_id NOT IN (SELECT id FROM roots)))
      OR EXISTS (SELECT FROM orders WHERE client_id IS DISTINCT FROM parent.client_id
        OR (subscription_cycle_id IS NOT NULL AND subscription_cycle_id NOT IN (SELECT id FROM cycles)) OR (renewal_operation_id IS NOT NULL AND renewal_operation_id NOT IN (SELECT id FROM roots)))
      OR EXISTS (SELECT FROM intents WHERE order_id NOT IN (SELECT id FROM orders)
        OR (renewal_operation_id IS NOT NULL AND renewal_operation_id NOT IN (SELECT id FROM roots)))
      OR EXISTS (SELECT FROM edges WHERE subscription_id <> parent.id OR client_id <> parent.client_id
        OR (renewal_operation_id IS NOT NULL AND renewal_operation_id NOT IN (SELECT id FROM roots)) OR (cycle_id IS NOT NULL AND cycle_id NOT IN (SELECT id FROM cycles))
        OR (order_id IS NOT NULL AND order_id NOT IN (SELECT id FROM orders)) OR (settlement_intent_id IS NOT NULL AND settlement_intent_id NOT IN (SELECT id FROM intents)))
        THEN 'unsupported_lineage'
      WHEN EXISTS (SELECT FROM roots WHERE scheduled_at = parent.next_cycle_at AND state IN ('succeeded', 'refused')) THEN 'closed_root'
      WHEN EXISTS (SELECT FROM edges WHERE kind = 'retry_obligation') THEN 'retry_obligation'
      WHEN EXISTS (SELECT FROM intents WHERE order_id <> activation_order OR renewal_operation_id IS NOT NULL) THEN 'renewal_settlement'
      WHEN EXISTS (SELECT FROM edges WHERE kind = 'stock_wait') THEN 'stock_wait'
      WHEN EXISTS (SELECT FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id IN (SELECT id FROM roots)) THEN 'stock_reservation'
      WHEN EXISTS (SELECT FROM roots) THEN 'renewal_operation'
      WHEN EXISTS (SELECT FROM cycles WHERE id <> activation_cycle)
      OR EXISTS (SELECT FROM public.subscription_events WHERE subscription_id = parent.id AND event_type IN (
        'subscription.customer_self_service.skip_next_cycle', 'subscription.customer_self_service.resume',
        'subscription.customer_self_service.order_now', 'subscription.customer_self_service.cancel',
        'subscription.customer_self_service.reactivate', 'subscription.system.auto_resume'))
      OR EXISTS (SELECT FROM public.subscription_command_receipts WHERE subscription_id = parent.id AND status = 'applied'
        AND command->>'action' IN ('skip_next_cycle', 'resume', 'order_now', 'cancel', 'reactivate'))
        THEN 'unsupported_lineage'
      END INTO cause;
    IF cause IS NOT NULL THEN EXIT validate; END IF;

    IF parent.next_cycle_at IS NULL OR parent.next_cycle_at < first_utc OR parent.next_cycle_at >= end_utc THEN
      cause := 'invalid_parent_schedule'; EXIT validate;
    END IF;
    IF retained.cycle_key IS NOT NULL THEN
      IF retained.original_anchor_at < first_utc OR retained.effective_due_at >= end_utc
        OR retained.effective_due_at < retained.original_anchor_at
        OR retained.cadence_seconds NOT BETWEEN 86400 AND 3660 * 86400 OR retained.cadence_seconds % 86400 <> 0 THEN
        cause := 'invalid_retained_schedule'; EXIT validate;
      END IF;
      IF retained.deadline_rule_ref IS NULL OR retained.deadline_rule_revision IS NULL
        OR retained.lead_seconds IS NULL OR retained.late_cancel_disposition IS NULL
        OR octet_length(convert_to(retained.deadline_rule_ref, 'UTF8')) NOT BETWEEN 1 AND 200
        OR retained.deadline_rule_ref COLLATE "C" SIMILAR TO blank_ref
        OR retained.deadline_rule_revision NOT BETWEEN 1 AND 9007199254740991
        OR retained.lead_seconds NOT BETWEEN 0 AND retained.cadence_seconds - 1
        OR retained.late_cancel_disposition NOT IN ('hold_current', 'allow_current_first_charge_if_authorized') THEN
        RAISE EXCEPTION 'renewal_deadline_rule_unsupported' USING ERRCODE = '22023', DETAIL = '/deadlineRuleRef';
      END IF;
      IF retained.effective_due_at - retained.lead_seconds * interval '1 second' < first_utc THEN
        RAISE EXCEPTION 'renewal_deadline_rule_unsupported' USING ERRCODE = '22023', DETAIL = '/deadlineRuleRef';
      END IF;
      IF retained.rail <> p_requested_rail THEN
        RAISE EXCEPTION 'renewal_v3_unavailable' USING ERRCODE = '22023', DETAIL = '/rail';
      END IF;
    END IF;

    IF jsonb_typeof(rule) = 'object'
      AND rule - ARRAY['schemaVersion','deadlineRuleRef','deadlineRuleRevision','leadSeconds','lateCancelDisposition'] = '{}'::jsonb
      AND rule->'schemaVersion' = '1'::jsonb
      AND jsonb_typeof(rule->'deadlineRuleRef') = 'string' AND jsonb_typeof(rule->'lateCancelDisposition') = 'string'
      AND jsonb_typeof(rule->'deadlineRuleRevision') = 'number' AND jsonb_typeof(rule->'leadSeconds') = 'number' THEN
      rule_ref := rule->>'deadlineRuleRef';
      disposition := rule->>'lateCancelDisposition';
      revision := (rule->'deadlineRuleRevision')::numeric;
      lead := (rule->'leadSeconds')::numeric;
    END IF;
    IF rule_ref IS NULL OR octet_length(convert_to(rule_ref, 'UTF8')) NOT BETWEEN 1 AND 200
      OR rule_ref COLLATE "C" SIMILAR TO blank_ref
      OR revision NOT BETWEEN 1 AND 9007199254740991 OR revision <> trunc(revision)
      OR lead < 0 OR lead >= cadence OR lead <> trunc(lead)
      OR disposition NOT IN ('hold_current', 'allow_current_first_charge_if_authorized') THEN
      RAISE EXCEPTION 'renewal_deadline_rule_unsupported' USING ERRCODE = '22023', DETAIL = '/deadlineRuleRef';
    END IF;
    IF parent.next_cycle_at - lead::bigint * interval '1 second' < first_utc THEN
      RAISE EXCEPTION 'renewal_deadline_rule_unsupported' USING ERRCODE = '22023', DETAIL = '/deadlineRuleRef';
    END IF;
    IF retained.cycle_key IS NOT NULL AND (
      retained.original_anchor_at <> parent.next_cycle_at OR retained.effective_due_at <> parent.next_cycle_at
      OR retained.cadence_seconds <> cadence OR retained.lifecycle <> parent.status
      OR retained.deadline_rule_ref <> rule_ref OR retained.deadline_rule_revision <> revision
      OR retained.lead_seconds <> lead OR retained.late_cancel_disposition <> disposition
      OR retained.cancellation_receipt_id IS NOT NULL OR retained.cancellation_effective_at IS NOT NULL
      OR retained.operation_id IS NOT NULL OR retained.commercial_generation_id IS NOT NULL) THEN
      cause := 'current_conflict';
    END IF;
  END validate;
  IF cause IS NOT NULL THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey ' || cause;
  END IF;

  IF retained.cycle_key IS NULL THEN
    INSERT INTO public.subscription_cycle_occurrences
      (cycle_key, subscription_id, client_id, original_anchor_at, effective_due_at, cadence_seconds, rail, lifecycle, is_current,
       deadline_rule_ref, deadline_rule_revision, lead_seconds, late_cancel_disposition)
    VALUES (gen_random_uuid(), parent.id, parent.client_id, parent.next_cycle_at, parent.next_cycle_at, cadence, p_requested_rail,
      parent.status, true, rule_ref, revision::bigint, lead::bigint, disposition)
    RETURNING * INTO retained;
    outcome := 'created';
  END IF;
  RETURN jsonb_build_object('outcome', outcome, 'clientId', retained.client_id, 'subscriptionId', retained.subscription_id,
    'cycleKey', retained.cycle_key, 'originalAnchorAt', to_char(retained.original_anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effectiveDueAt', to_char(retained.effective_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cadenceSeconds', retained.cadence_seconds, 'rail', retained.rail, 'lifecycle', retained.lifecycle);
END;
$$;
REVOKE ALL ON FUNCTION public.subscriptions__allocate_renewal_occurrence(uuid,uuid,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__allocate_renewal_occurrence(uuid,uuid,text,jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__allocate_renewal_occurrence(uuid,uuid,text,jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__allocate_renewal_occurrence(uuid,uuid,text,jsonb) FROM service_role;'; END IF; END; $$;
