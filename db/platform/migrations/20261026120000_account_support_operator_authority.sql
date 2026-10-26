-- Support authority delegates lifecycle effects to the existing native owner.
CREATE FUNCTION public.customer_support_apply_subscription_action_v1(
  p_operator_id uuid,
  p_subscription_id uuid,
  p_action text,
  p_payload jsonb,
  p_expected_version integer,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_owner public.subscription_command_receipts%ROWTYPE;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_now timestamptz := COALESCE(p_now, now());
  v_fingerprint text;
  v_owner_key text;
  v_slide_min_days integer := 3;
  v_slide_target timestamptz;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_delegate jsonb;
  v_reason text;
  v_pause_enabled boolean := true;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF EXISTS (SELECT 1 FROM public.platform_control_operators WHERE principal_id = p_operator_id)
     OR NOT public.platform_human_membership_is_administrator(p_operator_id) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;
  IF p_subscription_id IS NULL
     OR COALESCE(p_action, '') NOT IN ('pause', 'resume', 'slide_next_cycle', 'change_shipping_address')
     OR jsonb_typeof(v_payload) <> 'object'
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR NOT isfinite(v_now) THEN
    RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_payload ? 'slideMinDays' THEN
    IF COALESCE(v_payload->>'slideMinDays', '') !~ '^[0-9]{1,2}$' THEN
      RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
    END IF;
    v_slide_min_days := (v_payload->>'slideMinDays')::integer;
    IF v_slide_min_days < 1 OR v_slide_min_days > 60 THEN
      RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_fingerprint := encode(sha256(convert_to(
    'subscription_action|' || p_action || '|' || p_subscription_id::text || '|'
    || p_expected_version::text || '|' || v_payload::text, 'utf8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-support-subscription:' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM public.customer_support_subscription_commands
    WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_subscription_id
       OR v_existing.command_kind <> 'subscription_action' THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;
  -- A namespaced digest maps the entire support key, including spaces, without
  -- truncating its 200-character domain into the owner's 180-character domain.
  v_owner_key := 'm12-support:' || encode(sha256(convert_to(p_idempotency_key, 'utf8')), 'hex');
  -- Match the owner's actor/key-before-subscription lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operator_id::text || ':' || v_owner_key, 0));
  SELECT * INTO v_subscription FROM public.subscriptions
    WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'subscription_not_found';
  ELSE
    SELECT * INTO v_subject FROM public.clients
      WHERE id = v_subscription.client_id FOR SHARE;
    IF NOT FOUND THEN
      v_refusal_code := 'subject_not_found';
    ELSIF v_subject.principal_id IS NULL THEN
      v_refusal_code := 'subject_account_unlinked';
    END IF;
  END IF;
  IF v_refusal_code IS NULL AND v_subscription.template_version <> p_expected_version THEN
    v_refusal_code := 'version_conflict';
  END IF;
  -- No address engine is installed here; the typed native port normally refuses
  -- before SQL. Direct trusted SQL callers receive the same capability refusal.
  IF v_refusal_code IS NULL AND p_action = 'change_shipping_address' THEN
    v_refusal_code := 'operator_subscription_authority_unavailable';
  END IF;
  IF v_refusal_code IS NULL AND p_action = 'slide_next_cycle' THEN
    BEGIN
      v_slide_target := NULLIF(v_payload->>'newNextCycleAt', '')::timestamptz;
    EXCEPTION WHEN others THEN
      v_slide_target := NULL;
    END;
    IF v_slide_target IS NULL THEN
      v_refusal_code := 'slide_target_invalid';
    ELSIF v_subscription.status <> 'active' OR v_subscription.next_cycle_at IS NULL THEN
      v_refusal_code := 'slide_not_available';
    ELSIF v_slide_target < v_now + (v_slide_min_days || ' days')::interval
       OR v_slide_target > v_now + interval '60 days' THEN
      v_refusal_code := 'slide_out_of_window';
    ELSIF (v_slide_target AT TIME ZONE 'UTC')::date = (v_subscription.next_cycle_at AT TIME ZONE 'UTC')::date THEN
      v_outcome := 'noop';
    ELSIF v_slide_target < v_now + interval '3 days' THEN
      v_refusal_code := 'operator_subscription_authority_unavailable';
    END IF;
  END IF;
  -- Admission to an existing owner capability, never terminalization in M12.
  -- Open dunning is delegated so its existing payment_blocked refusal survives.
  IF v_refusal_code IS NULL AND p_action = 'resume' AND v_subscription.status = 'paused'
     AND NOT EXISTS (SELECT 1 FROM public.subscription_dunning_cases
       WHERE subscription_id = p_subscription_id AND status = 'open')
     AND ((SELECT status FROM public.subscription_dunning_cases
       WHERE subscription_id = p_subscription_id ORDER BY opened_at DESC, id DESC LIMIT 1) = 'expired'
       OR EXISTS (SELECT 1 FROM public.subscription_cycles WHERE subscription_id = p_subscription_id
         AND status = 'payment_pending')) THEN
    v_refusal_code := 'operator_subscription_authority_unavailable';
  END IF;
  IF v_refusal_code IS NULL AND p_action = 'pause' THEN
    IF NOT v_pause_enabled THEN
      v_refusal_code := 'operator_subscription_authority_unavailable';
    ELSIF EXISTS (SELECT 1 FROM public.subscription_renewal_operations
      WHERE subscription_id = p_subscription_id AND state = 'attempt_prepared') THEN
      -- The existing owner pause dispatch does not supply the donor attempt fence.
      v_refusal_code := 'operator_subscription_authority_unavailable';
    END IF;
  END IF;
  IF v_refusal_code IS NULL AND v_outcome IS DISTINCT FROM 'noop' THEN
    v_delegate := public.subscription_command_apply(
      p_operator_id, v_subject.id, v_owner_key, p_subscription_id, p_action,
      (v_payload - 'slideMinDays') || jsonb_build_object('actorKind', 'operator', 'operatorId', p_operator_id), v_now);
    SELECT * INTO v_owner FROM public.subscription_command_receipts
      WHERE actor_id = p_operator_id AND idempotency_key = v_owner_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_support_owner_receipt_invalid' USING ERRCODE = '55000';
    END IF;
    IF v_delegate->>'status' = 'refused' THEN
      v_reason := v_delegate->>'reason';
      v_refusal_code := CASE v_reason
        WHEN 'subscription_command_payment_blocked' THEN 'payment_blocked'
        WHEN 'subscription_command_operation_busy' THEN 'payment_blocked'
        WHEN 'subscription_lifecycle_payment_blocked' THEN 'payment_blocked'
        WHEN 'subscription_lifecycle_invalid_transition' THEN 'invalid_transition'
        WHEN 'subscription_lifecycle_invalid_slide' THEN 'slide_out_of_window'
        WHEN 'subscription_command_idempotency_conflict' THEN 'idempotency_conflict'
        ELSE NULL END;
      IF v_refusal_code = 'idempotency_conflict' THEN
        RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
      END IF;
      IF v_refusal_code IS NULL THEN
        RAISE EXCEPTION 'customer_support_owner_receipt_invalid' USING ERRCODE = '55000';
      END IF;
    ELSIF v_delegate->>'status' IS NULL OR v_delegate->>'status' NOT IN ('applied', 'noop', 'replayed') THEN
      RAISE EXCEPTION 'customer_support_owner_receipt_invalid' USING ERRCODE = '55000';
    ELSE
      v_outcome := v_delegate->>'status';
      v_response := jsonb_build_object('outcome', v_outcome, 'action', p_action,
        'subscriptionId', p_subscription_id, 'subscriptionStatus', v_delegate->'subscriptionStatus',
        'nextCycleAt', v_delegate->'nextCycleAt', 'templateVersion', v_delegate->'templateVersion',
        'eventId', v_delegate->'eventId', 'appliedBy', NULL);
    END IF;
  END IF;
  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE WHEN v_refusal_code = 'version_conflict' THEN 'conflict' ELSE 'refused' END;
    v_response := jsonb_build_object('outcome', v_outcome, 'action', p_action,
      'subscriptionId', p_subscription_id, 'refusalCode', v_refusal_code);
  ELSIF v_outcome = 'noop' AND v_response IS NULL THEN
    v_response := jsonb_build_object('outcome', 'noop', 'action', p_action,
      'subscriptionId', p_subscription_id, 'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at, 'templateVersion', v_subscription.template_version);
  END IF;
  IF v_owner.id IS NOT NULL THEN
    v_response := v_response || jsonb_build_object('ownerReceipt', jsonb_build_object(
      'id', v_owner.id, 'actorId', v_owner.actor_id, 'idempotencyKey', v_owner.idempotency_key,
      'commandFingerprint', v_owner.command_fingerprint, 'result', v_owner.result));
  END IF;
  INSERT INTO public.customer_support_subscription_commands
    (idempotency_key, payload_fingerprint, operator_id, subject_id, target_id, command_kind, response, created_at)
  VALUES (p_idempotency_key, v_fingerprint, p_operator_id, COALESCE(v_subject.id, v_subscription.client_id),
    p_subscription_id, 'subscription_action', v_response, v_now);
  INSERT INTO public.customer_support_subscription_audit_events
    (operator_id, subject_id, target_id, command_kind, requested_action, idempotency_key,
     outcome, refusal_code, value_before, value_after, occurred_at)
  VALUES (p_operator_id, COALESCE(v_subject.id, v_subscription.client_id), p_subscription_id,
    'subscription_action', p_action, p_idempotency_key, v_outcome, v_refusal_code,
    v_payload->>'newNextCycleAt', v_response->>'nextCycleAt', v_now);
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.customer_support_issue_recovery(
  p_operator_id uuid,
  p_client_id uuid,
  p_case_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.customer_recovery_commands%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_case public.subscription_dunning_cases%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_issue_result jsonb;
  v_notice_attempt integer;
  v_notice_id uuid;
  v_audit_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := clock_timestamp();
  v_response jsonb;
  v_refusal_code text;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF EXISTS (SELECT 1 FROM public.platform_control_operators WHERE principal_id = p_operator_id) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR p_case_id IS NULL
    OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
    OR COALESCE(p_command_fingerprint, '') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    OR p_expires_at IS NULL OR p_expires_at <= now()
    OR p_recovery_url_path IS NULL OR p_recovery_url_path !~ '^/[^[:cntrl:]]+$'
  THEN
    RAISE EXCEPTION 'customer_support_recovery_command_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-recovery:' || p_idempotency_key, 0)
  );
  SELECT * INTO v_existing
  FROM public.customer_recovery_commands AS command_row
  WHERE command_row.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.command_fingerprint <> p_command_fingerprint
      OR v_existing.operator_id <> p_operator_id
      OR v_existing.client_id <> p_client_id
      OR v_existing.case_id <> p_case_id
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' = 'refused' THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT * INTO v_client FROM public.clients AS client_row
  WHERE client_row.id = p_client_id;
  IF NOT FOUND THEN
    v_refusal_code := 'subject_not_found';
  ELSIF v_client.lifecycle_stage <> 'customer' THEN
    v_refusal_code := 'lifecycle_not_eligible';
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_case FROM public.subscription_dunning_cases AS case_row
    WHERE case_row.id = p_case_id
    FOR UPDATE;
    IF NOT FOUND OR v_case.client_id <> p_client_id THEN
      v_refusal_code := 'case_not_found';
    ELSIF v_case.status <> 'open' THEN
      v_refusal_code := 'case_not_open';
    END IF;
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_order FROM public.commerce_orders AS order_row
    WHERE order_row.subscription_cycle_id = v_case.cycle_id
      AND order_row.client_id = p_client_id
      AND order_row.status = 'pending_payment'
    ORDER BY order_row.created_at DESC, order_row.id DESC
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
      v_refusal_code := 'recoverable_order_unavailable';
    END IF;
  END IF;

  IF v_refusal_code IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscription_dunning_notifications AS notice_row
    WHERE notice_row.case_id = p_case_id
      AND notice_row.recipient_kind = 'customer'
      AND notice_row.notification_kind = 'payment_failed'
  ) THEN
    v_refusal_code := 'dunning_authority_unavailable';
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    INSERT INTO public.customer_support_audit_events (
      id, operator_id, client_id, case_id, event_type, outcome, command_key, occurred_at
    ) VALUES (
      v_audit_id, p_operator_id, p_client_id, p_case_id,
      'issue_recovery', 'refused', p_idempotency_key, v_recorded_at
    );
    v_response := jsonb_build_object(
      'outcome', 'refused', 'refusalCode', v_refusal_code, 'auditEventId', v_audit_id
    );
    INSERT INTO public.customer_recovery_commands (
      idempotency_key, command_fingerprint, operator_id, client_id, case_id,
      response, created_at
    ) VALUES (
      p_idempotency_key, p_command_fingerprint, p_operator_id, p_client_id, p_case_id,
      v_response, v_recorded_at
    );
    RETURN v_response;
  END IF;

  v_issue_result := public.dunning_lifecycle_issue_recovery_token(
    p_case_id, p_token_hash, p_expires_at
  );
  IF COALESCE((v_issue_result->>'issued')::boolean, false) IS NOT TRUE THEN
    INSERT INTO public.customer_support_audit_events (
      id, operator_id, client_id, case_id, event_type, outcome, command_key, occurred_at
    ) VALUES (
      v_audit_id, p_operator_id, p_client_id, p_case_id,
      'issue_recovery', 'refused', p_idempotency_key, v_recorded_at
    );
    v_response := jsonb_build_object(
      'outcome', 'refused', 'refusalCode', 'recoverable_order_unavailable',
      'auditEventId', v_audit_id
    );
    INSERT INTO public.customer_recovery_commands (
      idempotency_key, command_fingerprint, operator_id, client_id, case_id,
      response, created_at
    ) VALUES (
      p_idempotency_key, p_command_fingerprint, p_operator_id, p_client_id, p_case_id,
      v_response, v_recorded_at
    );
    RETURN v_response;
  END IF;

  -- D15 predates this command fence and reports issued even when its token-hash
  -- conflict branch inserts nothing. Verify the same active capability exists
  -- for the locked order; failure aborts the transaction and restores any token
  -- D15 revoked, so no notice can carry an unusable link.
  IF NOT EXISTS (
    SELECT 1 FROM public.commerce_checkout_recovery_tokens AS recovery_token
    WHERE recovery_token.order_id = v_order.id
      AND recovery_token.client_id = p_client_id
      AND recovery_token.token_hash = p_token_hash
      AND recovery_token.revoked_at IS NULL
      AND recovery_token.expires_at = p_expires_at
  ) THEN
    RAISE EXCEPTION 'customer_support_recovery_token_not_persisted' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(max(notice_row.retry_attempt), 0) + 1 INTO v_notice_attempt
  FROM public.subscription_dunning_notifications AS notice_row
  WHERE notice_row.case_id = p_case_id
    AND notice_row.notification_kind = 'payment_recovery';
  v_notice_id := public.dunning_lifecycle_queue_notice(
    p_case_id, 'payment_recovery', 'payment_recovery', v_notice_attempt,
    p_recovery_url_path
  );

  INSERT INTO public.customer_support_audit_events (
    id, operator_id, client_id, case_id, event_type, outcome, command_key, occurred_at
  ) VALUES (
    v_audit_id, p_operator_id, p_client_id, p_case_id,
    'issue_recovery', 'issued', p_idempotency_key, v_recorded_at
  );

  v_response := jsonb_build_object(
    'outcome', 'issued',
    'deliveryStatus', 'queued',
    'auditEventId', v_audit_id
  );
  INSERT INTO public.customer_recovery_commands (
    idempotency_key, command_fingerprint, operator_id, client_id, case_id,
    response, created_at
  ) VALUES (
    p_idempotency_key, p_command_fingerprint, p_operator_id, p_client_id, p_case_id,
    v_response, v_recorded_at
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_issue_recovery(uuid,uuid,uuid,text,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.customer_support_absorb_lead_v1(
  p_operator_id uuid,
  p_customer_id uuid,
  p_lead_id uuid,
  p_expected_lead_email text,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_lead public.clients%ROWTYPE;
  v_customer public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_expected text := lower(btrim(COALESCE(p_expected_lead_email, '')));
  v_fingerprint text;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_referencing record;
  v_blocking text[] := ARRAY[]::text[];
  v_unclassified text[] := ARRAY[]::text[];
  v_named text[] := ARRAY[]::text[];
  v_present bigint;
  v_moved bigint;
  v_carried jsonb := jsonb_build_object(
    'personalization', 0, 'consents', 0, 'sourceLinks', 0, 'deliveries', 0);
  v_carried_by_table jsonb := '{}'::jsonb;
  v_lead_email text;
  v_tombstone text;
  v_subject_id uuid;
BEGIN
  -- The gate answers first, before a single row of customer state is read.
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF EXISTS (SELECT 1 FROM public.platform_control_operators WHERE principal_id = p_operator_id) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL
     OR p_lead_id IS NULL
     OR p_customer_id = p_lead_id
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR char_length(v_expected) NOT BETWEEN 3 AND 320
  THEN
    RAISE EXCEPTION 'customer_support_absorb_lead_invalid' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'lead_absorption|' || p_customer_id::text || '|' || p_lead_id::text || '|' || v_expected, 'utf8')),
    'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subscription:' || p_idempotency_key, 0)
  );
  -- Both subjects, in a fixed id order, so two absorptions naming the same pair
  -- from opposite directions serialize instead of deadlocking. Proving the lead
  -- is empty and then emptying it has to be one indivisible act: a concurrent
  -- insert between the two is the only way this routine could destroy data.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subject:'
      || LEAST(p_customer_id, p_lead_id)::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subject:'
      || GREATEST(p_customer_id, p_lead_id)::text, 0));

  SELECT * INTO v_existing
    FROM public.customer_support_subscription_commands AS command_row
   WHERE command_row.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_lead_id
       OR v_existing.command_kind <> 'lead_absorption'
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT * INTO v_lead
    FROM public.clients AS lead_row
   WHERE lead_row.id = p_lead_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'lead_not_found';
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_customer
      FROM public.clients AS customer_row
     WHERE customer_row.id = p_customer_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_refusal_code := 'customer_not_found';
    ELSE
      v_subject_id := p_customer_id;
    END IF;
  END IF;

  v_lead_email := v_lead.email;

  -- An already-absorbed pair is a settled fact, not a stale expectation: the
  -- address it is asked about is precisely the one this routine moved away.
  IF v_refusal_code IS NULL
     AND v_lead.metadata #>> '{absorption,absorbedIntoClientId}' = p_customer_id::text
  THEN
    v_outcome := 'noop';
  ELSIF v_refusal_code IS NULL
        AND lower(btrim(COALESCE(v_lead.email, ''))) IS DISTINCT FROM v_expected
  THEN
    v_refusal_code := 'lead_email_expectation_conflict';
  END IF;

  -- This lane names the authorization link `principal_id`; the rule it enforces
  -- is the managed lane's rule exactly.
  IF v_refusal_code IS NULL AND v_outcome IS NULL AND v_lead.principal_id IS NOT NULL THEN
    v_refusal_code := 'lead_has_identity';
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    FOR v_referencing IN
      SELECT referencing.relname::text AS table_name,
             local_column.attname::text AS column_name,
             policy_row.disposition AS disposition
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS referencing_schema
          ON referencing_schema.oid = referencing.relnamespace
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS key_pair(local_attnum, remote_attnum)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = fk.conrelid AND local_column.attnum = key_pair.local_attnum
        JOIN pg_catalog.pg_attribute AS remote_column
          ON remote_column.attrelid = fk.confrelid AND remote_column.attnum = key_pair.remote_attnum
        LEFT JOIN public.client_absorption_policy AS policy_row
          ON policy_row.table_name = referencing.relname
       WHERE fk.contype = 'f'
         AND fk.confrelid = 'public.clients'::regclass
         AND referencing_schema.nspname = 'public'
         AND remote_column.attname = 'id'
       ORDER BY 1, 2
    LOOP
      IF v_referencing.disposition IS NULL THEN
        IF NOT (v_referencing.table_name = ANY (v_unclassified)) THEN
          v_unclassified := v_unclassified || v_referencing.table_name;
        END IF;
      ELSIF v_referencing.disposition = 'block' THEN
        EXECUTE format(
          'SELECT count(*) FROM public.%I AS blocking_row WHERE blocking_row.%I = $1',
          v_referencing.table_name, v_referencing.column_name)
          INTO v_present USING p_lead_id;
        IF v_present > 0 AND NOT (v_referencing.table_name = ANY (v_blocking)) THEN
          v_blocking := v_blocking || v_referencing.table_name;
        END IF;
      END IF;
    END LOOP;

    IF array_length(v_unclassified, 1) IS NOT NULL THEN
      v_refusal_code := 'unclassified_referencing_table';
      v_named := v_unclassified;
    ELSIF array_length(v_blocking, 1) IS NOT NULL THEN
      v_refusal_code := 'lead_has_commercial_footprint';
      v_named := v_blocking;
    END IF;
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    FOR v_referencing IN
      SELECT referencing.relname::text AS table_name,
             local_column.attname::text AS column_name
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS referencing_schema
          ON referencing_schema.oid = referencing.relnamespace
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS key_pair(local_attnum, remote_attnum)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = fk.conrelid AND local_column.attnum = key_pair.local_attnum
        JOIN pg_catalog.pg_attribute AS remote_column
          ON remote_column.attrelid = fk.confrelid AND remote_column.attnum = key_pair.remote_attnum
        JOIN public.client_absorption_policy AS policy_row
          ON policy_row.table_name = referencing.relname
       WHERE fk.contype = 'f'
         AND fk.confrelid = 'public.clients'::regclass
         AND referencing_schema.nspname = 'public'
         AND remote_column.attname = 'id'
         AND policy_row.disposition = 'carry'
       ORDER BY 1, 2
    LOOP
      BEGIN
        EXECUTE format(
          'UPDATE public.%I AS carried_row SET %I = $1 WHERE carried_row.%I = $2',
          v_referencing.table_name, v_referencing.column_name, v_referencing.column_name)
          USING p_customer_id, p_lead_id;
        GET DIAGNOSTICS v_moved = ROW_COUNT;
      EXCEPTION WHEN unique_violation THEN
        -- The customer already occupies this table's own key. Theirs is kept
        -- untouched and the lead's stays on the archived record; overwriting
        -- would be the one destructive act this routine must never perform.
        v_moved := 0;
        INSERT INTO public.customer_support_subscription_audit_events (
          operator_id, subject_id, target_id, command_kind, requested_action,
          idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
        ) VALUES (
          p_operator_id, v_subject_id, p_lead_id, 'lead_absorption',
          'absorb_lead_carry_conflict', p_idempotency_key, 'noop', NULL,
          v_referencing.table_name, 'retained_by_customer', v_now
        );
      END;
      v_carried_by_table := v_carried_by_table
        || jsonb_build_object(v_referencing.table_name, v_moved);
    END LOOP;

    -- The four named counters are the contract the callers read. This lane does
    -- not carry those four tables yet, so they answer zero honestly rather than
    -- reporting whatever else moved; `absorption.carried` on the archived row
    -- below is the complete per-table record.
    v_carried := jsonb_build_object(
      'personalization', COALESCE((v_carried_by_table->>'customer_personalization')::int, 0),
      'consents', COALESCE((v_carried_by_table->>'client_consents')::int, 0),
      'sourceLinks', COALESCE((v_carried_by_table->>'client_source_links')::int, 0),
      'deliveries', COALESCE((v_carried_by_table->>'communication_email_deliveries')::int, 0));

    -- The reserved .invalid namespace can never resolve, so the archived row
    -- can hold an address forever without anyone ever mailing it -- and the
    -- real one is now free for the correction that was refused.
    v_tombstone := 'absorbed+' || replace(p_lead_id::text, '-', '') || '@absorbed.invalid';
    UPDATE public.clients AS lead_row
       SET email = v_tombstone,
           metadata = lead_row.metadata || jsonb_build_object(
             'absorption', jsonb_build_object(
               'absorbedIntoClientId', p_customer_id,
               'absorbedAt', v_now,
               'originalEmail', v_lead_email,
               'idempotencyKey', p_idempotency_key,
               'carried', v_carried_by_table)),
           updated_at = v_now
     WHERE lead_row.id = p_lead_id;
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE
      WHEN v_refusal_code = 'lead_email_expectation_conflict' THEN 'conflict'
      ELSE 'refused' END;
    v_response := jsonb_build_object(
      'outcome', v_outcome,
      'action', 'absorb_lead',
      'leadId', p_lead_id,
      'refusalCode', v_refusal_code
    );
    IF v_refusal_code IN ('lead_has_commercial_footprint', 'unclassified_referencing_table') THEN
      v_response := v_response || jsonb_build_object('blockingTables', to_jsonb(v_named));
    END IF;
  ELSE
    v_response := jsonb_build_object(
      'outcome', COALESCE(v_outcome, 'applied'),
      'action', 'absorb_lead',
      'leadId', p_lead_id,
      'customerId', p_customer_id,
      'carried', v_carried
    );
  END IF;

  INSERT INTO public.customer_support_subscription_commands (
    idempotency_key, payload_fingerprint, operator_id, subject_id, target_id,
    command_kind, response, created_at
  ) VALUES (
    p_idempotency_key, v_fingerprint, p_operator_id, v_subject_id, p_lead_id,
    'lead_absorption', v_response, v_now
  );

  INSERT INTO public.customer_support_subscription_audit_events (
    operator_id, subject_id, target_id, command_kind, requested_action,
    idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
  ) VALUES (
    p_operator_id, v_subject_id, p_lead_id, 'lead_absorption', 'absorb_lead',
    p_idempotency_key, v_response->>'outcome', v_refusal_code,
    v_lead_email,
    CASE WHEN v_refusal_code IS NULL AND v_outcome IS NULL THEN v_tombstone ELSE NULL END,
    v_now
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
