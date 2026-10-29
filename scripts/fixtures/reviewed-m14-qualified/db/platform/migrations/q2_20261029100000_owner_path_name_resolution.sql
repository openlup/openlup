CREATE OR REPLACE FUNCTION acquisition_private.keyed_digest(p_domain text, p_payload jsonb)
RETURNS bytea
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.sha256(k.key_bytes
    || pg_catalog.convert_to(p_domain || ':' || p_payload::text, 'UTF8')
    || k.key_bytes)
  FROM acquisition_private.installation_key AS k
  WHERE k.singleton
$function$;

CREATE OR REPLACE FUNCTION acquisition_private.case_projection(p_case_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'contractVersion', 'tester_application_v1',
    'caseRef', c.case_reference,
    'contactRef', contact.contact_reference,
    'sourceKind', c.source_kind,
    'consent', jsonb_build_object(
      'consentVersion', c.consent_version,
      'policyVersion', c.policy_version,
      'recordedAt', c.consent_accepted_at,
      'locale', c.locale,
      'sourcePath', c.source_path
    ),
    'addressReference', CASE WHEN address.id IS NULL THEN NULL ELSE jsonb_build_object(
      'source', address.source,
      'reference', address.reference,
      'revision', address.revision,
      'provenance', address.provenance
    ) END,
    'state', c.lifecycle,
    'version', c.state_version,
    'createdAt', c.created_at,
    'updatedAt', c.updated_at
  )
  FROM acquisition_private.cases AS c
  JOIN acquisition_private.contacts AS contact ON contact.case_id = c.id
  LEFT JOIN acquisition_private.address_references AS address ON address.id = c.address_reference_id
  WHERE c.id = p_case_id
$function$;

CREATE OR REPLACE FUNCTION acquisition_private.refuse_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'acquisition_append_only' USING ERRCODE = '42501';
END
$function$;

CREATE OR REPLACE FUNCTION public.acquisition_case_submit_v1(
  p_idempotency_key text,
  p_requester_key text,
  p_normalized_email text,
  p_normalized_phone text,
  p_consent_accepted boolean,
  p_consent_version text,
  p_policy_version text,
  p_locale text,
  p_source_path text,
  p_address_source text,
  p_address_reference text,
  p_address_revision text,
  p_address_provenance text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_command_fingerprint bytea;
  v_dedupe_fingerprint bytea;
  v_requester_fingerprint bytea;
  v_email_fingerprint bytea;
  v_existing_command acquisition_private.commands%ROWTYPE;
  v_existing_case acquisition_private.cases%ROWTYPE;
  v_case acquisition_private.cases%ROWTYPE;
  v_contact acquisition_private.contacts%ROWTYPE;
  v_address_id uuid;
  v_requester_attempts integer;
  v_email_attempts integer;
  v_case_id uuid := gen_random_uuid();
  v_contact_id uuid := gen_random_uuid();
BEGIN
  IF p_idempotency_key IS NULL
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    OR p_requester_key IS NULL OR char_length(p_requester_key) NOT BETWEEN 1 AND 256
    OR p_normalized_email IS NULL OR p_normalized_email <> lower(btrim(p_normalized_email))
    OR char_length(p_normalized_email) > 254
    OR p_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR (p_normalized_phone IS NOT NULL AND p_normalized_phone !~ '^\+[1-9][0-9]{6,14}$')
    OR p_consent_accepted IS DISTINCT FROM true
    OR p_consent_version IS NULL OR p_consent_version <> btrim(p_consent_version)
    OR char_length(p_consent_version) NOT BETWEEN 1 AND 64
    OR p_policy_version IS NULL OR p_policy_version <> btrim(p_policy_version)
    OR char_length(p_policy_version) NOT BETWEEN 1 AND 64
    OR p_locale NOT IN ('en', 'pl')
    OR p_source_path IS DISTINCT FROM '/tester-application'
    OR p_address_source IS NULL OR p_address_source !~ '^[a-z][a-z0-9_-]{0,47}$'
    OR p_address_reference IS NULL OR p_address_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
    OR p_address_revision IS NULL OR p_address_revision !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    OR p_address_provenance IS NULL OR p_address_provenance !~ '^[a-z][a-z0-9_-]{0,63}$'
    OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'acquisition_case_invalid' USING ERRCODE = '22023';
  END IF;

  v_command_fingerprint := acquisition_private.keyed_digest('submit-command', jsonb_build_object(
    'email', p_normalized_email, 'phone', p_normalized_phone,
    'consentVersion', p_consent_version, 'policyVersion', p_policy_version,
    'locale', p_locale, 'sourcePath', p_source_path,
    'addressSource', p_address_source, 'addressReference', p_address_reference,
    'addressRevision', p_address_revision, 'addressProvenance', p_address_provenance
  ));
  v_dedupe_fingerprint := acquisition_private.keyed_digest(
    'tester-application-contact', jsonb_build_object('email', p_normalized_email));
  v_requester_fingerprint := acquisition_private.keyed_digest(
    'tester-application-requester-limit', jsonb_build_object('requester', p_requester_key));
  v_email_fingerprint := acquisition_private.keyed_digest(
    'tester-application-email-limit', jsonb_build_object('email', p_normalized_email));

  PERFORM pg_advisory_xact_lock(hashtextextended('acquisition-submit:' || p_idempotency_key, 0));
  SELECT * INTO v_existing_command
  FROM acquisition_private.commands
  WHERE scope = 'submit' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_command.command_fingerprint <> v_command_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replayed',
      'version', v_existing_command.result_version, 'updatedAt', v_existing_command.result_updated_at,
      'replayed', true, 'acquisitionCase', v_existing_command.result_projection
    );
  END IF;

  SELECT id INTO v_address_id
  FROM acquisition_private.address_references
  WHERE source = p_address_source AND reference = p_address_reference
    AND revision = p_address_revision AND provenance = p_address_provenance AND active
  LIMIT 1;
  IF v_address_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_address');
  END IF;

  INSERT INTO acquisition_private.rate_limit_windows AS limiter
    (key_kind, key_fingerprint, window_started_at, attempts, updated_at)
  VALUES ('requester', v_requester_fingerprint, p_now, 1, p_now)
  ON CONFLICT (key_kind, key_fingerprint) DO UPDATE SET
    window_started_at = CASE
      WHEN limiter.window_started_at <= p_now - interval '60 minutes' THEN p_now
      ELSE limiter.window_started_at END,
    attempts = CASE
      WHEN limiter.window_started_at <= p_now - interval '60 minutes' THEN 1
      ELSE least(limiter.attempts + 1, 1000000) END,
    updated_at = p_now
  RETURNING attempts INTO v_requester_attempts;

  INSERT INTO acquisition_private.rate_limit_windows AS limiter
    (key_kind, key_fingerprint, window_started_at, attempts, updated_at)
  VALUES ('email', v_email_fingerprint, p_now, 1, p_now)
  ON CONFLICT (key_kind, key_fingerprint) DO UPDATE SET
    window_started_at = CASE
      WHEN limiter.window_started_at <= p_now - interval '60 minutes' THEN p_now
      ELSE limiter.window_started_at END,
    attempts = CASE
      WHEN limiter.window_started_at <= p_now - interval '60 minutes' THEN 1
      ELSE least(limiter.attempts + 1, 1000000) END,
    updated_at = p_now
  RETURNING attempts INTO v_email_attempts;

  IF v_requester_attempts > 5 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'reason', 'requester_quota');
  END IF;
  IF v_email_attempts > 3 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'reason', 'email_quota');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'acquisition-dedupe:' || encode(v_dedupe_fingerprint, 'hex'), 0));
  SELECT * INTO v_existing_case
  FROM acquisition_private.cases
  WHERE source_kind = 'tester_application' AND dedupe_fingerprint = v_dedupe_fingerprint;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'contact_conflict');
  END IF;

  INSERT INTO acquisition_private.cases(
    id, case_reference, source_kind, dedupe_fingerprint, address_reference_id,
    lifecycle, state_version, consent_version, policy_version, consent_accepted_at,
    locale, source_path, created_at, updated_at
  ) VALUES (
    v_case_id, 'acquisition-case:' || v_case_id::text, 'tester_application',
    v_dedupe_fingerprint, v_address_id, 'submitted', 1, p_consent_version,
    p_policy_version, p_now, p_locale, p_source_path, p_now, p_now
  ) RETURNING * INTO v_case;

  INSERT INTO acquisition_private.contacts(
    id, case_id, contact_reference, normalized_email, normalized_phone, created_at, updated_at
  ) VALUES (
    v_contact_id, v_case.id, 'acquisition-contact:' || v_contact_id::text,
    p_normalized_email, p_normalized_phone, p_now, p_now
  ) RETURNING * INTO v_contact;

  INSERT INTO acquisition_private.audit(
    case_id, action, from_lifecycle, to_lifecycle, from_version, to_version,
    actor_id, command_fingerprint, occurred_at
  ) VALUES (
    v_case.id, 'submitted', NULL, 'submitted', NULL, 1,
    NULL, v_command_fingerprint, p_now
  );
  INSERT INTO acquisition_private.commands(
    scope, idempotency_key, command_fingerprint, case_id, result_lifecycle,
    result_version, result_updated_at, result_projection, created_at
  ) VALUES (
    'submit', p_idempotency_key, v_command_fingerprint, v_case.id,
    'submitted', 1, p_now, acquisition_private.case_projection(v_case.id), p_now
  );

  RETURN jsonb_build_object(
    'outcome', 'created', 'caseRef', v_case.case_reference,
    'contactRef', v_contact.contact_reference, 'lifecycle', v_case.lifecycle,
    'version', v_case.state_version, 'updatedAt', v_case.updated_at, 'replayed', false,
    'acquisitionCase', acquisition_private.case_projection(v_case.id)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.acquisition_case_operator_list_v1(
  p_actor_id uuid,
  p_after_created_at timestamptz,
  p_after_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_row record;
  v_items jsonb := '[]'::jsonb;
  v_seen integer := 0;
  v_has_more boolean := false;
  v_last_created_at timestamptz;
  v_last_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR ((p_after_created_at IS NULL) <> (p_after_id IS NULL))
  THEN
    RAISE EXCEPTION 'acquisition_case_list_invalid' USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT c.id, c.created_at
    FROM acquisition_private.cases AS c
    WHERE c.source_kind = 'tester_application'
      AND (p_after_created_at IS NULL OR (c.created_at, c.id) < (p_after_created_at, p_after_id))
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT p_limit + 1
  LOOP
    v_seen := v_seen + 1;
    IF v_seen > p_limit THEN
      v_has_more := true;
      CONTINUE;
    END IF;
    v_last_created_at := v_row.created_at;
    v_last_id := v_row.id;
    v_items := v_items || jsonb_build_array(acquisition_private.case_projection(v_row.id));
  END LOOP;

  RETURN jsonb_build_object(
    'contractVersion', 'tester_application_v1',
    'cases', v_items,
    'nextCursor', CASE WHEN v_has_more THEN jsonb_build_object(
      'createdAt', v_last_created_at, 'id', v_last_id
    ) ELSE NULL END
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.acquisition_case_transition_v1(
  p_actor_id uuid,
  p_case_reference text,
  p_expected_version bigint,
  p_target_lifecycle text,
  p_reason text,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_command_fingerprint bytea;
  v_existing_command acquisition_private.commands%ROWTYPE;
  v_case acquisition_private.cases%ROWTYPE;
  v_from_lifecycle text;
  v_from_version bigint;
BEGIN
  IF p_actor_id IS NULL
    OR p_case_reference IS NULL OR p_case_reference !~ '^acquisition-case:[0-9a-f-]{36}$'
    OR p_expected_version IS NULL OR p_expected_version < 1
    OR p_target_lifecycle NOT IN ('approved', 'active', 'rejected', 'withdrawn')
    OR (p_target_lifecycle = 'rejected' AND (
      p_reason IS NULL OR p_reason <> btrim(p_reason) OR char_length(p_reason) NOT BETWEEN 1 AND 240))
    OR (p_target_lifecycle <> 'rejected' AND p_reason IS NOT NULL)
    OR p_idempotency_key IS NULL
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'acquisition_case_transition_invalid' USING ERRCODE = '22023';
  END IF;

  v_command_fingerprint := acquisition_private.keyed_digest('transition-command', jsonb_build_object(
    'actorId', p_actor_id, 'caseRef', p_case_reference,
    'expectedVersion', p_expected_version, 'targetLifecycle', p_target_lifecycle,
    'reason', p_reason
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended('acquisition-transition:' || p_idempotency_key, 0));
  SELECT * INTO v_existing_command
  FROM acquisition_private.commands
  WHERE scope = 'transition' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_command.command_fingerprint <> v_command_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replayed',
      'version', v_existing_command.result_version,
      'updatedAt', v_existing_command.result_updated_at, 'replayed', true,
      'acquisitionCase', v_existing_command.result_projection
    );
  END IF;

  SELECT * INTO v_case
  FROM acquisition_private.cases
  WHERE case_reference = p_case_reference AND source_kind = 'tester_application'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_case.state_version <> p_expected_version THEN
    RETURN jsonb_build_object('outcome', 'version_conflict');
  END IF;
  IF NOT (
    (v_case.lifecycle = 'submitted' AND p_target_lifecycle IN ('approved', 'rejected', 'withdrawn'))
    OR (v_case.lifecycle = 'approved' AND p_target_lifecycle IN ('active', 'rejected', 'withdrawn'))
    OR (v_case.lifecycle IN ('active', 'rejected') AND p_target_lifecycle = 'withdrawn')
  ) THEN
    RETURN jsonb_build_object('outcome', 'transition_conflict');
  END IF;

  v_from_lifecycle := v_case.lifecycle;
  v_from_version := v_case.state_version;
  UPDATE acquisition_private.cases SET
    lifecycle = p_target_lifecycle,
    state_version = state_version + 1,
    address_reference_id = CASE WHEN p_target_lifecycle = 'withdrawn' THEN NULL ELSE address_reference_id END,
    withdrawn_at = CASE WHEN p_target_lifecycle = 'withdrawn' THEN p_now ELSE NULL END,
    updated_at = p_now
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  IF p_target_lifecycle = 'withdrawn' THEN
    UPDATE acquisition_private.contacts SET
      normalized_email = NULL,
      normalized_phone = NULL,
      redacted_at = p_now,
      updated_at = p_now
    WHERE case_id = v_case.id;
  END IF;

  INSERT INTO acquisition_private.audit(
    case_id, action, from_lifecycle, to_lifecycle, from_version, to_version,
    actor_id, command_fingerprint, occurred_at
  ) VALUES (
    v_case.id,
    CASE WHEN p_target_lifecycle = 'withdrawn' THEN 'withdrawn' ELSE 'transitioned' END,
    v_from_lifecycle, v_case.lifecycle, v_from_version, v_case.state_version,
    p_actor_id, v_command_fingerprint, p_now
  );
  INSERT INTO acquisition_private.commands(
    scope, idempotency_key, command_fingerprint, case_id, result_lifecycle,
    result_version, result_updated_at, result_projection, created_at
  ) VALUES (
    'transition', p_idempotency_key, v_command_fingerprint, v_case.id,
    v_case.lifecycle, v_case.state_version, v_case.updated_at,
    acquisition_private.case_projection(v_case.id), p_now
  );

  RETURN jsonb_build_object(
    'outcome', 'transitioned', 'caseRef', v_case.case_reference,
    'lifecycle', v_case.lifecycle, 'version', v_case.state_version,
    'updatedAt', v_case.updated_at, 'replayed', false,
    'acquisitionCase', acquisition_private.case_projection(v_case.id)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.acquisition_case_active_count_v1()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT count(*)::bigint
  FROM acquisition_private.cases AS c
  WHERE c.source_kind = 'tester_application'
    AND c.lifecycle IN ('approved', 'active')
$function$;

CREATE OR REPLACE FUNCTION public.customer_subject_capture_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND current_user = 'openlup_retained_import_owner' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.customer_subject_lifecycle_events (
      client_id, from_stage, to_stage, occurred_at
    ) VALUES (NEW.id, NULL, NEW.lifecycle_stage, COALESCE(NEW.created_at, now()));
  ELSIF NEW.lifecycle_stage IS DISTINCT FROM OLD.lifecycle_stage THEN
    INSERT INTO public.customer_subject_lifecycle_events (
      client_id, from_stage, to_stage, occurred_at
    ) VALUES (NEW.id, OLD.lifecycle_stage, NEW.lifecycle_stage, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_delivery_alignment_guard_cycle_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_mode text;
  v_receipt_id uuid;
BEGIN
  IF TG_OP = 'INSERT' AND current_user = 'openlup_retained_import_owner' THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'payment_pending' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = NEW.subscription_id
   FOR UPDATE;
  IF NOT FOUND OR v_subscription.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- Expired-dunning recovery owns its fresh cycle through a separate tokenized
  -- workflow. It retains its own authority rather than becoming alignment dunning.
  IF EXISTS (
    SELECT 1 FROM public.subscription_dunning_cases
     WHERE subscription_id = NEW.subscription_id
       AND status = 'expired'
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subscription_delivery_alignment_cases
     WHERE subscription_id = NEW.subscription_id
       AND state IN ('protected', 'manual_review')
  ) THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_protected' USING ERRCODE = 'P0001';
  END IF;

  SELECT mode INTO v_mode
    FROM public.subscription_delivery_alignment_control
   WHERE singleton = true;

  -- Only enforcing modes own the stale-schedule gate. Shadow observes without
  -- blocking, and an off rollout must be behaviorally inert for new cases.
  IF COALESCE(v_mode, 'off') IN ('off', 'shadow') THEN
    -- Consuming an aligned scheduled instant is a durable lifecycle transition,
    -- even when an operator turned new-case creation off after alignment.
    UPDATE public.subscription_delivery_alignment_cases
       SET state = 'released',
           updated_at = now()
     WHERE subscription_id = NEW.subscription_id
       AND state = 'aligned'
       AND aligned_next_cycle_at = NEW.scheduled_at;
    RETURN NEW;
  END IF;

  IF NEW.scheduled_at IS DISTINCT FROM v_subscription.next_cycle_at THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_stale_schedule' USING ERRCODE = '40001';
  END IF;

  -- Claim exactly one admission proof in the same transaction as the new
  -- cycle. A uniqueness conflict or later failure rolls this consumption back,
  -- allowing the runtime's normal idempotent retry without a second preflight.
  UPDATE public.subscription_delivery_alignment_admission_receipts
     SET consumed_at = now()
   WHERE subscription_id = NEW.subscription_id
     AND scheduled_at = NEW.scheduled_at
     AND observed_next_cycle_at = v_subscription.next_cycle_at
     AND decision = 'allowed'
     AND consumed_at IS NULL
   RETURNING id INTO v_receipt_id;
  IF v_receipt_id IS NULL THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_admission_required' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.subscription_delivery_alignment_cases
     SET state = 'released',
         updated_at = now()
   WHERE subscription_id = NEW.subscription_id
     AND state = 'aligned'
     AND aligned_next_cycle_at = NEW.scheduled_at;

  RETURN NEW;
END;
$$;
