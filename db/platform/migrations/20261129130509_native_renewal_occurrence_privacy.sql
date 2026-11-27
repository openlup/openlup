CREATE OR REPLACE FUNCTION public.subscriptions__allocate_renewal_occurrence(
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
  previous_row_security text;
  erased boolean;
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

    -- Resolve scope before taking any subject lock or inspecting receipt evidence.
    IF NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE id = p_subscription_id AND client_id = p_client_id) THEN
      RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE = '22023', DETAIL = '/subscriptionId';
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
      OR lead < 0 OR lead <> trunc(lead)
      OR disposition NOT IN ('hold_current', 'allow_current_first_charge_if_authorized') THEN
      RAISE EXCEPTION 'renewal_deadline_rule_unsupported' USING ERRCODE = '22023', DETAIL = '/deadlineRuleRef';
    END IF;

    PERFORM 1 FROM public.clients WHERE id = p_client_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey privacy_evidence_unavailable';
    END IF;

    SELECT * INTO parent FROM public.subscriptions
      WHERE id = p_subscription_id AND client_id = p_client_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE = '22023', DETAIL = '/subscriptionId';
    END IF;
    -- A new statement after the subject fence sees the winning erasure commit.
    BEGIN
      previous_row_security := current_setting('row_security');
      PERFORM set_config('row_security', 'off', true);
      SELECT EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id = p_client_id) INTO erased;
      PERFORM set_config('row_security', previous_row_security, true);
    EXCEPTION
      WHEN lock_not_available OR query_canceled THEN RAISE;
      WHEN OTHERS THEN
        RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey privacy_evidence_unavailable';
    END;
    IF erased THEN
      RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey privacy_erased';
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

    IF lead >= cadence THEN
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

CREATE OR REPLACE FUNCTION public.subscriptions__create_renewal_v3_root(
  p_client_id uuid, p_subscription_id uuid, p_cycle_key uuid, p_operation_id uuid,
  p_cycle_number integer, p_agreement_canonical text, p_agreement_fingerprint text,
  p_worker_id text, p_lease_seconds integer
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parent public.subscriptions;
  cycle_view jsonb;
  occurrence public.subscription_cycle_occurrences;
  root public.subscription_renewal_operations;
  generation public.subscription_cycle_generations;
  terms_counter integer;
  input_field text;
  identity text;
  coordinates jsonb;
  cadence jsonb;
  agreement jsonb;
  agreement_fits boolean;
  digest text;
  sampled_at timestamptz;
  lease_end timestamptz;
  token uuid;
  collision text;
  previous_row_security text;
  erased boolean;
BEGIN
  input_field:=CASE
    WHEN p_operation_id IS NULL THEN '/operationId'
    WHEN p_cycle_number IS NULL OR p_cycle_number<1 THEN '/cycleNumber'
    WHEN p_worker_id IS NULL OR p_worker_id COLLATE "C" SIMILAR TO '[[:space:]                 　﻿]*' THEN '/workerId'
    WHEN p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN '/leaseSeconds'
  END;
  IF input_field IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE='22023', DETAIL=input_field;
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;

  -- Resolve scope before taking any subject lock or inspecting receipt evidence.
  IF NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE id = p_subscription_id AND client_id = p_client_id) THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE = '22023', DETAIL = '/subscriptionId';
  END IF;
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey privacy_evidence_unavailable';
  END IF;

  SELECT * INTO parent FROM public.subscriptions
   WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023', DETAIL='/subscriptionId';
  END IF;
  -- A new statement after the subject fence sees the winning erasure commit.
  BEGIN
    previous_row_security := current_setting('row_security');
    PERFORM set_config('row_security', 'off', true);
    SELECT EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id = p_client_id) INTO erased;
    PERFORM set_config('row_security', previous_row_security, true);
  EXCEPTION
    WHEN lock_not_available OR query_canceled THEN RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey privacy_evidence_unavailable';
  END;
  IF erased THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE = '22023', DETAIL = '/cycleKey privacy_erased';
  END IF;

  SELECT next_cycle_number INTO terms_counter FROM public.subscription_renewal_terms
   WHERE subscription_id=p_subscription_id FOR SHARE;
  cycle_view:=public.subscriptions__lock_renewal_occurrence(p_client_id,p_subscription_id,p_cycle_key);
  IF cycle_view->>'rail'<>'v3' THEN
    RAISE EXCEPTION 'renewal_v3_unavailable' USING ERRCODE='22023', DETAIL='/rail';
  END IF;
  SELECT * INTO STRICT occurrence FROM public.subscription_cycle_occurrences
   WHERE cycle_key=p_cycle_key AND subscription_id=p_subscription_id AND client_id=p_client_id;

  identity:='subscription:'||p_subscription_id::text||':renewal-v3:'||p_cycle_key::text;
  cadence:=jsonb_build_object('schemaVersion',1,'kind','fixed_days','days',occurrence.cadence_seconds/86400);
  coordinates:=jsonb_build_object(
    'frozenRevision','native.purchase-renewal.v3','contractVersion','platform.subscription.renewal.v3',
    'clientId',p_client_id,'subscriptionId',p_subscription_id,'cycleKey',p_cycle_key,
    'originalAnchorAt',cycle_view->>'originalAnchorAt','operationId',p_operation_id,
    'commercialGenerationId',p_operation_id,'cadence',cadence,'cycleNumber',p_cycle_number);

  IF occurrence.operation_id IS NOT NULL THEN
    IF occurrence.operation_id<>p_operation_id OR occurrence.commercial_generation_id<>p_operation_id THEN
      RAISE EXCEPTION 'renewal_claim_stale' USING ERRCODE='40001', DETAIL='/commercialGenerationId';
    END IF;
    SELECT * INTO root FROM public.subscription_renewal_operations
     WHERE id=p_operation_id AND subscription_id=p_subscription_id FOR KEY SHARE;
    SELECT * INTO generation FROM public.subscription_cycle_generations
     WHERE cycle_key=p_cycle_key AND operation_id=p_operation_id AND commercial_generation_id=p_operation_id FOR KEY SHARE;
  ELSE
    sampled_at:=pg_catalog.clock_timestamp();
    IF parent.status<>'active' OR occurrence.cancellation_receipt_id IS NOT NULL
        OR occurrence.cancellation_effective_at IS NOT NULL OR occurrence.effective_due_at>sampled_at THEN
      RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
    END IF;
    IF terms_counter IS DISTINCT FROM p_cycle_number THEN
      RAISE EXCEPTION 'renewal_agreement_unavailable' USING ERRCODE='22023', DETAIL='/agreement';
    END IF;
  END IF;

  BEGIN
    agreement:=p_agreement_canonical::jsonb;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN
    agreement:=NULL;
  END;
  digest:=encode(sha256(convert_to(p_agreement_canonical,'UTF8')),'hex');
  agreement_fits:=(agreement @> coordinates) IS TRUE AND NOT (agreement ?| ARRAY['frozenFingerprint','cadenceSeconds'])
    AND occurrence.cadence_seconds/86400 BETWEEN 1 AND 3660
    AND agreement->'cadence' = cadence AND agreement#>'{templateSnapshot,cadenceDays}' IS NOT DISTINCT FROM cadence->'days';

  IF occurrence.operation_id IS NOT NULL THEN
    IF root.scheduled_at IS DISTINCT FROM occurrence.original_anchor_at OR root.cycle_number IS DISTINCT FROM p_cycle_number
        OR root.identity_key IS DISTINCT FROM identity OR root.operation_fingerprint IS DISTINCT FROM generation.agreement_fingerprint
        OR root.cycle_snapshot IS DISTINCT FROM generation.agreement||jsonb_build_object('frozenFingerprint',generation.agreement_fingerprint)
        OR NOT agreement_fits OR generation.agreement IS DISTINCT FROM agreement
        OR p_agreement_fingerprint IS DISTINCT FROM generation.agreement_fingerprint OR digest IS DISTINCT FROM generation.agreement_fingerprint THEN
      RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE='23505', DETAIL='/agreementFingerprint';
    END IF;
  ELSE
    IF NOT agreement_fits OR jsonb_typeof(agreement->'catalogAcceptance') IS DISTINCT FROM 'object'
        OR agreement#>'{templateSnapshot,version}' IS DISTINCT FROM to_jsonb(parent.template_version)
        OR digest IS DISTINCT FROM p_agreement_fingerprint THEN
      RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023', DETAIL='/agreementFingerprint';
    END IF;
    -- The caller proves wider lineage. An incumbent root still occupies its native key.
    IF EXISTS (SELECT 1 FROM public.subscription_renewal_operations o WHERE o.subscription_id=p_subscription_id
               AND (o.scheduled_at=occurrence.original_anchor_at OR o.identity_key=identity)) THEN
      RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
    END IF;
    -- Scope is already established. Check the global key without returning any row data.
    IF EXISTS (SELECT 1 FROM public.subscription_renewal_operations WHERE id=p_operation_id) THEN
      RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/operationId';
    END IF;

    token:=gen_random_uuid();
    lease_end:=sampled_at+make_interval(secs=>p_lease_seconds);
    UPDATE public.subscription_cycle_occurrences
       SET operation_id=p_operation_id,commercial_generation_id=p_operation_id
     WHERE cycle_key=p_cycle_key AND subscription_id=p_subscription_id AND client_id=p_client_id
       AND is_current AND rail='v3' AND operation_id IS NULL AND commercial_generation_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'renewal_claim_stale' USING ERRCODE='40001', DETAIL='/commercialGenerationId';
    END IF;

    BEGIN
      INSERT INTO public.subscription_renewal_operations
        (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,
         state,claim_generation,claim_token,claimed_by,claimed_at,lease_expires_at,created_at,updated_at)
      VALUES (p_operation_id,p_subscription_id,occurrence.original_anchor_at,p_cycle_number,identity,digest,
        agreement||jsonb_build_object('frozenFingerprint',digest),'claimed',1,token,p_worker_id,sampled_at,lease_end,sampled_at,sampled_at);
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS collision=CONSTRAINT_NAME;
      IF collision='subscription_renewal_operations_pkey' THEN
        RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/operationId';
      ELSIF collision IN ('subscription_renewal_operations_cycle_key','subscription_renewal_operations_identity_key_key') THEN
        RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
      END IF;
      RAISE;
    END;

    INSERT INTO public.subscription_cycle_generations
      (operation_id,commercial_generation_id,cycle_key,agreement,agreement_fingerprint,claim_token,lease_expires_at,lease_generation,last_binding_seq)
    VALUES (p_operation_id,p_operation_id,p_cycle_key,agreement,digest,token,lease_end,1,0);
  END IF;

  RETURN jsonb_build_object(
    'outcome',CASE WHEN token IS NULL THEN 'existing' ELSE 'created' END,
    'clientId',p_client_id,'subscriptionId',p_subscription_id,'cycleKey',p_cycle_key,
    'originalAnchorAt',cycle_view->>'originalAnchorAt','operationId',p_operation_id,'commercialGenerationId',p_operation_id,
    'agreementFingerprint',digest,'agreement',agreement,'claimToken',token,
    'leaseExpiresAt',to_char(lease_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END;
$$;


-- The caller verifies its own visibility against this authoritative subject read.
CREATE FUNCTION public.subscriptions__read_renewal_occurrences_for_privacy(p_client uuid, p_principal uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  occurrences jsonb;
  invalid_scope boolean;
  receipt_count bigint;
  parent_count bigint;
  previous_row_security text;
  helper constant regprocedure := 'public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid)'::regprocedure;
BEGIN
  -- Refuse unexpected inherited default privileges before any subject read.
  IF EXISTS (
    SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE p.oid = helper
      AND a.grantee <> p.proowner AND (r.rolname IS DISTINCT FROM 'service_role' OR a.is_grantable)
  ) OR EXISTS (
    SELECT FROM pg_roles WHERE rolname IN ('anon', 'authenticated') AND has_function_privilege(oid, helper, 'EXECUTE')
  ) THEN
    RAISE insufficient_privilege;
  END IF;
  IF p_client IS NULL AND p_principal IS NULL THEN
    RAISE EXCEPTION 'occurrence_privacy_scope_unavailable';
  END IF;

  -- Refuse filtered evidence and restore the caller's setting before returning.
  previous_row_security := current_setting('row_security');
  PERFORM set_config('row_security', 'off', true);
  WITH aliases AS (
    SELECT id AS client_id, principal_id FROM public.clients WHERE id = p_client OR principal_id = p_principal
    UNION
    SELECT client_id, principal_id FROM public.identity_privacy_erasures WHERE client_id = p_client OR principal_id = p_principal
  )
  SELECT EXISTS (SELECT FROM aliases
      WHERE (client_id IS NOT NULL AND client_id IS DISTINCT FROM p_client)
         OR (principal_id IS NOT NULL AND principal_id IS DISTINCT FROM p_principal))
    OR (p_client IS NOT NULL AND p_principal IS NOT NULL AND NOT EXISTS (
        SELECT FROM aliases WHERE client_id = p_client AND principal_id = p_principal))
  INTO invalid_scope;
  IF invalid_scope THEN RAISE EXCEPTION 'occurrence_privacy_scope_unavailable'; END IF;
  SELECT count(*) INTO receipt_count
  FROM public.identity_privacy_erasures WHERE client_id = p_client OR principal_id = p_principal;
  IF receipt_count > 1 THEN RAISE EXCEPTION 'occurrence_privacy_scope_unavailable'; END IF;
  IF receipt_count = 0
    AND NOT EXISTS (SELECT FROM public.clients WHERE id = p_client)
    AND NOT EXISTS (SELECT FROM public.platform_human_principals WHERE principal_id = p_principal) THEN
    PERFORM set_config('row_security', previous_row_security, true);
    RETURN '{"missing":true}'::jsonb;
  END IF;
  SELECT count(*) INTO parent_count FROM public.subscriptions WHERE client_id = p_client;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'subscriptionId', o.subscription_id, 'cycleKey', o.cycle_key, 'rail', o.rail, 'lifecycle', o.lifecycle,
      'originalAnchorAt', to_char(o.original_anchor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'effectiveDueAt', to_char(o.effective_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'cancellationEffectiveAt', to_char(o.cancellation_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) ORDER BY o.subscription_id, o.cycle_key), '[]'::jsonb),
    coalesce(bool_or(o.client_id IS DISTINCT FROM p_client OR s.client_id IS DISTINCT FROM p_client
      OR t.minimum < '0001-01-01 00:00:00+00' OR t.maximum >= '10000-01-01 00:00:00+00'), false)
    INTO occurrences, invalid_scope
    FROM public.subscription_cycle_occurrences o LEFT JOIN public.subscriptions s ON s.id = o.subscription_id
    CROSS JOIN LATERAL (
      SELECT least(o.original_anchor_at, o.effective_due_at, o.cancellation_effective_at) AS minimum,
             greatest(o.original_anchor_at, o.effective_due_at, o.cancellation_effective_at) AS maximum
    ) t
    WHERE o.client_id = p_client OR s.client_id = p_client;
  PERFORM set_config('row_security', previous_row_security, true);
  IF invalid_scope THEN RAISE EXCEPTION 'occurrence_privacy_scope_unavailable'; END IF;
  RETURN jsonb_build_object('occurrences', occurrences, 'hasReceipt', receipt_count = 1, 'parentCount', parent_count::text);
END;
$$;

REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid) TO service_role;'; END IF; END; $$;
