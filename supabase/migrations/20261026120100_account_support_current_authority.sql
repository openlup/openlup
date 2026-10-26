-- Current support email, link and recovery authority.
ALTER TABLE public.admin_audit_events DROP CONSTRAINT admin_audit_events_action_check;

ALTER TABLE public.admin_audit_events ADD CONSTRAINT admin_audit_events_action_check
  CHECK (action IN (
    'role_change', 'invite', 'remove', 'promo_update', 'promo_status_change',
    'subscription_band_update', 'catalog_draft_upsert', 'catalog_price_set',
    'catalog_sku_archive', 'catalog_activate', 'catalog_product_archive',
    'catalog_product_restore', 'catalog_deactivate', 'customer_read',
    'promotion_code_create', 'promotion_code_update', 'promotion_code_status_change',
    'bundle_draft_upsert', 'bundle_composition_set', 'bundle_target_price_set',
    'bundle_archive', 'bundle_restore', 'bundle_activate', 'bundle_deactivate',
    'revoke', 'checkout_payment_link_mint', 'operator_email_correction'
  )) NOT VALID;

ALTER TABLE public.customer_support_subscription_commands
  ADD COLUMN email_claim_token uuid,
  ADD COLUMN email_claim_until timestamptz;

CREATE SEQUENCE public.customer_support_email_correction_sequence;

REVOKE ALL ON SEQUENCE public.customer_support_email_correction_sequence FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.customer_support_admit_subject_email_v1(
  p_operator_id uuid, p_subject_id uuid, p_expected_email text, p_new_email text,
  p_idempotency_key text, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_new_email text := lower(btrim(COALESCE(p_new_email, '')));
  v_fingerprint text;
  v_refusal text;
  v_response jsonb;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF NOT EXISTS (SELECT 1 FROM public.admin_users WHERE id = p_operator_id AND is_machine_actor = false) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;
  IF p_subject_id IS NULL
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR char_length(v_new_email) NOT BETWEEN 3 AND 320
     OR v_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'customer_support_email_correction_invalid' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := encode(pg_catalog.sha256(pg_catalog.convert_to(
    'email_correction|' || p_subject_id::text || '|' || lower(btrim(COALESCE(p_expected_email, '')))
    || '|' || v_new_email, 'utf8')), 'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customer-support-subscription:' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM public.customer_support_subscription_commands WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint OR (v_existing.operator_id <> p_operator_id AND v_existing.response->>'outcome' <> 'pending')
       OR v_existing.target_id <> p_subject_id OR v_existing.command_kind <> 'email_correction' THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('applied', 'noop', 'replayed') THEN
      RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"');
    END IF;
    RETURN v_existing.response;
  END IF;

  -- Reserve the destination across subjects, then serialize admission on the subject.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customer-support-email:' || v_new_email, 0));
  SELECT * INTO v_subject FROM public.clients WHERE id = p_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal := 'subject_not_found';
  ELSIF lower(btrim(COALESCE(v_subject.email, ''))) IS DISTINCT FROM lower(btrim(COALESCE(p_expected_email, ''))) THEN
    v_refusal := 'email_expectation_conflict';
  ELSIF EXISTS (SELECT 1 FROM public.customer_support_subscription_commands
    WHERE command_kind = 'email_correction' AND response->>'outcome' = 'pending'
      AND (target_id = p_subject_id OR response->>'newEmail' = v_new_email)) THEN
    v_refusal := 'email_expectation_conflict';
  ELSIF EXISTS (SELECT 1 FROM public.clients WHERE lower(btrim(email)) = v_new_email AND id <> p_subject_id)
    OR EXISTS (SELECT 1 FROM auth.users WHERE lower(btrim(email)) = v_new_email AND id IS DISTINCT FROM v_subject.auth_user_id)
    OR EXISTS (SELECT 1 FROM auth.identities WHERE lower(btrim(identity_data->>'email')) = v_new_email
      AND user_id IS DISTINCT FROM v_subject.auth_user_id) THEN
    v_refusal := 'email_already_in_use';
  END IF;

  IF v_refusal IS NOT NULL THEN
    v_response := jsonb_build_object('outcome', CASE WHEN v_refusal = 'subject_not_found' THEN 'refused' ELSE 'conflict' END,
      'action', 'correct_email', 'subjectId', p_subject_id, 'refusalCode', v_refusal);
  ELSE
    v_response := jsonb_build_object('outcome', 'pending', 'action', 'correct_email', 'subjectId', p_subject_id,
      'sequence', nextval('public.customer_support_email_correction_sequence')::text,
      'authUserId', v_subject.auth_user_id, 'originalEmail', COALESCE(v_subject.email, ''), 'newEmail', v_new_email);
  END IF;
  INSERT INTO public.customer_support_subscription_commands
    (idempotency_key, payload_fingerprint, operator_id, subject_id, target_id, command_kind, response, created_at)
  VALUES (p_idempotency_key, v_fingerprint, p_operator_id, v_subject.id, p_subject_id, 'email_correction', v_response, v_now);
  PERFORM public.record_admin_audit_event(p_operator_id, 'operator_email_correction', 'admin_ui',
    'operator_email_correction', p_subject_id::text, jsonb_build_object('email', v_subject.email),
    v_response, p_idempotency_key || ':admit');
  IF v_refusal IS NOT NULL THEN
    INSERT INTO public.customer_support_subscription_audit_events
      (operator_id, subject_id, target_id, command_kind, requested_action, idempotency_key, outcome, refusal_code, value_before, occurred_at)
    VALUES (p_operator_id, v_subject.id, p_subject_id, 'email_correction', 'correct_email', p_idempotency_key,
      v_response->>'outcome', v_refusal, v_subject.email, v_now);
    RETURN v_response;
  END IF;
  -- An authorized human may resume the exact pending command; its original
  -- operator remains immutable. Terminal receipts keep their original key ownership.
  RETURN jsonb_set(v_response, '{outcome}', '"admitted"');
END;
$$;

CREATE FUNCTION public.customer_support_claim_subject_email_v1(p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_command public.customer_support_subscription_commands%ROWTYPE;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_command FROM public.customer_support_subscription_commands
    WHERE idempotency_key = p_idempotency_key AND command_kind = 'email_correction' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer_support_email_correction_invalid' USING ERRCODE = '22023'; END IF;
  IF v_command.response->>'outcome' <> 'pending' THEN RETURN v_command.response; END IF;
  IF v_command.email_claim_until > clock_timestamp() THEN RETURN jsonb_build_object('outcome', 'pending'); END IF;
  UPDATE public.customer_support_subscription_commands
    SET email_claim_token = v_token, email_claim_until = clock_timestamp() + interval '60 seconds'
    WHERE idempotency_key = p_idempotency_key;
  RETURN v_command.response || jsonb_build_object('outcome', 'claimed',
    'idempotencyKey', p_idempotency_key, 'claimToken', v_token);
END;
$$;

CREATE FUNCTION public.customer_support_guard_identity_email_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_claim jsonb;
  v_command public.customer_support_subscription_commands%ROWTYPE;
  v_email text;
BEGIN
  -- Ignore pre-email Confirm/token updates using their captured row image. Auth
  -- writes several rows before its final metadata update; only the email event
  -- (or the metadata event for an unchanged email) consumes the final claim.
  IF OLD.email IS NOT DISTINCT FROM NEW.email
    AND NEW.raw_app_meta_data->'operator_email_correction' IS NULL THEN RETURN NEW; END IF;
  SELECT raw_app_meta_data->'operator_email_correction', email INTO v_claim, v_email
    FROM auth.users WHERE id = NEW.id FOR UPDATE;
  -- Ordinary Auth transactions never participate in correction ownership checks.
  -- Pending corrections reconcile unclaimed email changes only at settlement.
  IF v_claim IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_command FROM public.customer_support_subscription_commands
    WHERE idempotency_key = v_claim->>'idempotencyKey' FOR UPDATE;
  IF NOT FOUND OR v_command.command_kind <> 'email_correction'
    OR v_command.response->>'outcome' <> 'pending'
    OR v_command.email_claim_token::text IS DISTINCT FROM v_claim->>'claimToken'
    OR v_command.email_claim_until IS NULL OR v_command.email_claim_until <= clock_timestamp()
    OR v_command.response->>'sequence' IS DISTINCT FROM v_claim->>'sequence'
    OR v_command.response->>'authUserId' IS DISTINCT FROM NEW.id::text
    OR lower(btrim(COALESCE(OLD.email, ''))) NOT IN
      (lower(btrim(v_command.response->>'originalEmail')), v_command.response->>'newEmail')
    OR lower(btrim(COALESCE(v_email, ''))) IS DISTINCT FROM v_command.response->>'newEmail'
    OR EXISTS (SELECT 1 FROM public.customer_support_subscription_commands newer
      WHERE newer.command_kind = 'email_correction' AND newer.target_id = v_command.target_id
        AND (newer.response->>'sequence')::bigint > (v_command.response->>'sequence')::bigint) THEN
    RAISE EXCEPTION 'customer_support_email_correction_claim_stale' USING ERRCODE = '55000';
  END IF;
  -- Do not retain execution capabilities in the identity's app metadata/JWT.
  UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data - 'operator_email_correction' WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_support_identity_email_ownership
AFTER UPDATE ON auth.users DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.customer_support_guard_identity_email_v1();

CREATE FUNCTION public.customer_support_settle_subject_email_v1(
  p_idempotency_key text, p_claim_token uuid, p_phase text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_command public.customer_support_subscription_commands%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_before jsonb;
  v_response jsonb;
  v_auth_id uuid;
  v_auth_email text;
  v_refusal text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('complete', 'release', 'fail') THEN
    RAISE EXCEPTION 'customer_support_email_correction_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT (response->>'authUserId')::uuid INTO v_auth_id FROM public.customer_support_subscription_commands
    WHERE idempotency_key = p_idempotency_key AND command_kind = 'email_correction';
  IF v_auth_id IS NOT NULL THEN
    SELECT lower(btrim(email)) INTO v_auth_email FROM auth.users WHERE id = v_auth_id FOR UPDATE;
  END IF;
  SELECT * INTO v_command FROM public.customer_support_subscription_commands
    WHERE idempotency_key = p_idempotency_key AND command_kind = 'email_correction' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer_support_email_correction_invalid' USING ERRCODE = '22023'; END IF;
  v_before := v_command.response;
  -- A stale claimant may observe a recorded result, but never executes another effect.
  IF v_before->>'outcome' <> 'pending' THEN RETURN v_before; END IF;
  IF p_claim_token IS NULL OR v_command.email_claim_token IS DISTINCT FROM p_claim_token
    OR v_command.email_claim_until IS NULL OR v_command.email_claim_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'customer_support_email_correction_claim_stale' USING ERRCODE = '55000';
  END IF;
  IF v_auth_id IS NOT NULL AND v_auth_email IS NOT NULL
    AND v_auth_email NOT IN (v_before->>'newEmail', lower(btrim(v_before->>'originalEmail'))) THEN
    v_refusal := 'identity_changed_independently';
  END IF;
  IF p_phase = 'release' AND v_refusal IS NULL THEN
    UPDATE public.customer_support_subscription_commands SET email_claim_token = NULL, email_claim_until = NULL
      WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'pending');
  END IF;
  SELECT * INTO v_subject FROM public.clients WHERE id = v_command.target_id FOR UPDATE;
  IF v_refusal IS NULL AND (NOT FOUND OR COALESCE(v_subject.email, '') IS DISTINCT FROM v_before->>'originalEmail'
    OR v_subject.auth_user_id IS DISTINCT FROM v_auth_id) THEN
    RAISE EXCEPTION 'customer_support_email_correction_state_changed' USING ERRCODE = '55000';
  END IF;
  IF p_phase = 'complete' AND v_refusal IS NULL AND (
    EXISTS (SELECT 1 FROM public.clients WHERE lower(btrim(email)) = v_before->>'newEmail' AND id <> v_command.target_id)
    OR EXISTS (SELECT 1 FROM auth.users WHERE lower(btrim(email)) = v_before->>'newEmail' AND id IS DISTINCT FROM v_auth_id)
    OR EXISTS (SELECT 1 FROM auth.identities WHERE lower(btrim(identity_data->>'email')) = v_before->>'newEmail'
      AND user_id IS DISTINCT FROM v_auth_id)
  ) THEN v_refusal := 'email_already_in_use'; END IF;
  IF v_auth_id IS NOT NULL AND v_refusal IS DISTINCT FROM 'identity_changed_independently' AND (
    (v_refusal IS NULL AND v_auth_email IS DISTINCT FROM
      CASE WHEN p_phase = 'complete' THEN v_before->>'newEmail' ELSE lower(btrim(v_before->>'originalEmail')) END)
    OR (v_refusal IS NOT NULL AND (v_auth_email IS NULL OR v_auth_email NOT IN (v_before->>'newEmail', lower(btrim(v_before->>'originalEmail')))))
  ) THEN
    RAISE EXCEPTION 'customer_support_email_correction_identity_unconfirmed' USING ERRCODE = '55000';
  END IF;
  IF p_phase = 'complete' AND v_refusal IS NULL THEN
    BEGIN
      IF lower(btrim(COALESCE(v_subject.email, ''))) IS DISTINCT FROM v_before->>'newEmail' THEN
        UPDATE public.clients SET email = v_before->>'newEmail', updated_at = v_now WHERE id = v_command.target_id;
      END IF;
    EXCEPTION WHEN unique_violation THEN
      -- Classify only a confirmed destination collision from this client write.
      IF NOT EXISTS (SELECT 1 FROM public.clients WHERE lower(btrim(email)) = v_before->>'newEmail' AND id <> v_command.target_id) THEN RAISE; END IF;
      v_refusal := 'email_already_in_use';
    END;
  END IF;
  IF v_refusal IS NOT NULL THEN
    IF v_refusal = 'email_already_in_use' AND v_auth_id IS NOT NULL
      AND v_auth_email IS DISTINCT FROM lower(btrim(v_before->>'originalEmail')) THEN
      -- Auth -> receipt -> client are already locked. Both provider email copies
      -- and failure commit atomically;
      -- the deferred fence sees the terminal receipt, rejecting late claim PUTs.
      SET CONSTRAINTS auth.customer_support_identity_email_ownership DEFERRED;
      UPDATE auth.users SET email = lower(btrim(v_before->>'originalEmail')),
        raw_app_meta_data = raw_app_meta_data - 'operator_email_correction' WHERE id = v_auth_id;
      UPDATE auth.identities SET identity_data = jsonb_set(identity_data, '{email}', to_jsonb(lower(btrim(v_before->>'originalEmail')))),
        updated_at = v_now WHERE user_id = v_auth_id AND provider = 'email';
    END IF;
    p_phase := 'fail';
  END IF;
  IF p_phase = 'complete' THEN
    -- Keep admission metadata/sequence for ordered replay and durable attribution.
    v_response := v_before || jsonb_build_object('outcome', CASE WHEN lower(btrim(v_before->>'originalEmail')) = v_before->>'newEmail' THEN 'noop' ELSE 'applied' END,
      'authUserLinked', v_auth_id IS NOT NULL);
  ELSE
    v_response := v_before || jsonb_build_object('outcome', 'failed', 'refusalCode', COALESCE(v_refusal, 'identity_change_failed'));
  END IF;
  UPDATE public.customer_support_subscription_commands SET response = v_response,
    email_claim_token = NULL, email_claim_until = NULL WHERE idempotency_key = p_idempotency_key;
  PERFORM public.record_admin_audit_event(v_command.operator_id, 'operator_email_correction', 'admin_ui',
    'operator_email_correction', v_command.target_id::text, v_before, v_response, p_idempotency_key || ':' || p_phase);
  INSERT INTO public.customer_support_subscription_audit_events
    (operator_id, subject_id, target_id, command_kind, requested_action, idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at)
  VALUES (v_command.operator_id, v_command.subject_id, v_command.target_id, 'email_correction', 'correct_email', p_idempotency_key,
    CASE WHEN p_phase = 'fail' THEN 'refused' ELSE v_response->>'outcome' END,
    CASE WHEN p_phase = 'fail' THEN COALESCE(v_refusal, 'identity_change_failed') END,
    v_before->>'originalEmail', CASE WHEN p_phase = 'complete' THEN v_before->>'newEmail' END, v_now);
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_support_correct_subject_email_v1(
  p_operator_id uuid, p_subject_id uuid, p_expected_email text, p_new_email text,
  p_idempotency_key text, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF COALESCE((SELECT is_machine_actor FROM public.admin_users WHERE id = p_operator_id), false) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'customer_support_email_correction_requires_admission' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_correct_subject_email_v1(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_support_correct_subject_email_v1(uuid, uuid, text, text, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.customer_support_settle_subject_email_v1(text, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_support_settle_subject_email_v1(text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.customer_support_correct_subject_email_v1(uuid, uuid, text, text, text, timestamptz) IS
  'Retired combined correction entry point. Use customer_support_admit_subject_email_v1 before auth and customer_support_settle_subject_email_v1 afterward.';

REVOKE ALL ON FUNCTION public.customer_support_admit_subject_email_v1(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_support_admit_subject_email_v1(uuid, uuid, text, text, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.customer_support_claim_subject_email_v1(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_support_claim_subject_email_v1(text) TO service_role;

REVOKE ALL ON FUNCTION public.customer_support_guard_identity_email_v1() FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.customer_support_subscription_commands
  DROP CONSTRAINT customer_support_subscription_commands_kind_check;

ALTER TABLE public.customer_support_subscription_commands
  ADD CONSTRAINT customer_support_subscription_commands_kind_check
  CHECK (command_kind IN ('subscription_action', 'email_correction', 'phone_correction', 'lead_absorption', 'account_link'))
  NOT VALID;

ALTER TABLE public.customer_support_subscription_audit_events
  DROP CONSTRAINT customer_support_subscription_audit_events_kind_check;

ALTER TABLE public.customer_support_subscription_audit_events
  ADD CONSTRAINT customer_support_subscription_audit_events_kind_check
  CHECK (command_kind IN ('subscription_action', 'email_correction', 'phone_correction', 'lead_absorption', 'account_link'))
  NOT VALID;

CREATE FUNCTION public.customer_support_link_subject_account_v1(
  p_operator_id uuid,
  p_subject_id uuid,
  p_expected_email text,
  p_auth_user_id uuid,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_expected text := lower(btrim(COALESCE(p_expected_email, '')));
  v_fingerprint text;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_before uuid;
  v_audit_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);

  IF COALESCE((
    SELECT admin_row.is_machine_actor
      FROM public.admin_users AS admin_row
     WHERE admin_row.id = p_operator_id
  ), false) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR char_length(v_expected) NOT BETWEEN 3 AND 320
     OR v_expected !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  THEN
    RAISE EXCEPTION 'customer_support_account_link_invalid' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'account_link|' || p_subject_id::text || '|' || v_expected, 'utf8')),
    'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subscription:' || p_idempotency_key, 0)
  );

  SELECT * INTO v_existing
    FROM public.customer_support_subscription_commands AS command_row
   WHERE command_row.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_subject_id
       OR v_existing.command_kind <> 'account_link'
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT * INTO v_subject
    FROM public.clients AS subject_row
   WHERE subject_row.id = p_subject_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'subject_not_found';
  ELSIF v_subject.identity_kind <> 'customer' THEN
    v_refusal_code := 'subject_not_customer';
  ELSIF btrim(COALESCE(v_subject.email, '')) = '' THEN
    v_refusal_code := 'subject_email_missing';
  ELSIF lower(btrim(v_subject.email)) <> v_expected THEN
    -- The identity the route resolved was resolved for the address the operator saw.
    -- A subject that no longer carries it must be re-read, never linked blind.
    v_refusal_code := 'email_expectation_conflict';
  ELSIF v_subject.auth_user_id IS NOT NULL THEN
    IF p_auth_user_id IS NULL OR p_auth_user_id = v_subject.auth_user_id THEN
      v_outcome := 'noop';
    ELSE
      v_refusal_code := 'subject_account_linked';
    END IF;
  ELSIF p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'customer_support_account_link_invalid' USING ERRCODE = '22023';
  ELSIF COALESCE((
    SELECT admin_row.is_machine_actor IS DISTINCT FROM false
      FROM public.admin_users AS admin_row
     WHERE admin_row.id = p_auth_user_id
  ), false) THEN
    v_refusal_code := 'identity_not_linkable';
  END IF;

  v_before := v_subject.auth_user_id;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    BEGIN
      UPDATE public.clients AS subject_row
         SET auth_user_id = p_auth_user_id,
             updated_at = v_now
       WHERE subject_row.id = p_subject_id;
    EXCEPTION WHEN unique_violation THEN
      v_refusal_code := 'identity_linked_elsewhere';
    END;
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE
      WHEN v_refusal_code IN ('email_expectation_conflict', 'subject_account_linked', 'identity_linked_elsewhere')
        THEN 'conflict'
      ELSE 'refused' END;
    v_response := jsonb_build_object(
      'outcome', v_outcome,
      'action', 'link_account',
      'subjectId', p_subject_id,
      'refusalCode', v_refusal_code
    );
  ELSE
    v_response := jsonb_build_object(
      'outcome', COALESCE(v_outcome, 'applied'),
      'action', 'link_account',
      'subjectId', p_subject_id
    );
  END IF;

  INSERT INTO public.customer_support_subscription_commands (
    idempotency_key, payload_fingerprint, operator_id, subject_id, target_id,
    command_kind, response, created_at
  ) VALUES (
    p_idempotency_key, v_fingerprint, p_operator_id, v_subject.id, p_subject_id,
    'account_link', v_response, v_now
  );

  -- The identity id is recorded, never the address: the audit answers "who linked
  -- which sign-in to this customer, and when", and the address is already the
  -- subject's own.
  INSERT INTO public.customer_support_subscription_audit_events (
    id, operator_id, subject_id, target_id, command_kind, requested_action,
    idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
  ) VALUES (
    v_audit_id, p_operator_id, v_subject.id, p_subject_id,
    'account_link', 'link_account', p_idempotency_key,
    v_response->>'outcome', v_refusal_code,
    v_before::text,
    CASE WHEN v_refusal_code IS NULL THEN COALESCE(p_auth_user_id, v_before)::text ELSE NULL END,
    v_now
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_link_subject_account_v1(
  uuid, uuid, text, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_support_link_subject_account_v1(
  uuid, uuid, text, uuid, text, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.customer_support_link_subject_account_v1(
  uuid, uuid, text, uuid, text, timestamptz
) IS
  'Operator link of a sign-in identity to an unlinked customer, so the subscription commands that delegate to the self-service chain can act for her. The caller resolves the identity for the subject''s own address; this routine refuses a marketing-lead shell, a stale expectation, a missing address, an overwrite of an existing link, a machine administrator identity and an identity bound elsewhere, and audits every outcome, refusals included.';

CREATE OR REPLACE FUNCTION public.customer_support_issue_recovery(
  p_operator_id uuid,
  p_subject_id uuid,
  p_case_id uuid,
  p_idempotency_key text,
  p_payload_fingerprint text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_recovery_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.customer_support_recovery_commands%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_case public.subscription_dunning_cases%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_source_notice public.subscription_dunning_notifications%ROWTYPE;
  v_audit_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := clock_timestamp();
  v_refusal_code text;
  v_response jsonb;
  v_notice_attempt integer;
BEGIN
  -- Unknown/inactive operators fail before any customer or recovery state is read.
  PERFORM public.communications_require_active_operator(p_operator_id);

  -- The operator is a person: re-derived from the administrator roster for the principal
  -- this call was handed, never from a claim the caller supplied.
  IF COALESCE((
    SELECT admin_row.is_machine_actor
      FROM public.admin_users AS admin_row
     WHERE admin_row.id = p_operator_id
  ), false) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;

  IF p_subject_id IS NULL OR p_case_id IS NULL
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR COALESCE(p_payload_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_token_hash, '') !~ '^[0-9a-f]{64}$'
     OR p_expires_at IS NULL OR p_expires_at <= now()
     OR p_recovery_path IS NULL OR char_length(p_recovery_path) > 1000
     OR p_recovery_path !~ '^/[^[:cntrl:]]+$'
  THEN
    RAISE EXCEPTION 'customer_support_recovery_command_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('managed-customer-recovery:' || p_idempotency_key, 0)
  );

  SELECT * INTO v_existing
    FROM public.customer_support_recovery_commands AS command_row
   WHERE command_row.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.payload_fingerprint <> p_payload_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.subject_id <> p_subject_id
       OR v_existing.case_id <> p_case_id
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;

    IF v_existing.response->>'outcome' = 'refused' THEN
      RETURN v_existing.response;
    END IF;

    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT * INTO v_subject
    FROM public.clients AS subject_row
   WHERE subject_row.id = p_subject_id;
  IF NOT FOUND THEN
    v_refusal_code := 'subject_not_found';
  ELSIF v_subject.lifecycle_stage <> 'customer' THEN
    v_refusal_code := 'lifecycle_not_eligible';
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_case
      FROM public.subscription_dunning_cases AS case_row
     WHERE case_row.id = p_case_id
     FOR UPDATE;
    IF NOT FOUND OR v_case.client_id <> p_subject_id THEN
      v_refusal_code := 'case_not_found';
    ELSIF v_case.status <> 'open' THEN
      v_refusal_code := 'case_not_open';
    END IF;
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_order
      FROM public.commerce_orders AS order_row
     WHERE order_row.id = v_case.order_id
       AND order_row.client_id = p_subject_id
       AND order_row.status = 'pending_payment'
     FOR UPDATE;
    IF NOT FOUND THEN
      v_refusal_code := 'recoverable_order_unavailable';
    END IF;
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_source_notice
      FROM public.subscription_dunning_notifications AS notice_row
     WHERE notice_row.case_id = p_case_id
       AND notice_row.recipient_kind = 'customer'
       AND notice_row.notification_kind = 'payment_failed'
     ORDER BY notice_row.created_at DESC, notice_row.id DESC
     LIMIT 1;
    IF NOT FOUND THEN
      v_refusal_code := 'dunning_authority_unavailable';
    END IF;
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    v_response := jsonb_build_object(
      'outcome', 'refused',
      'refusal_code', v_refusal_code
    );
    INSERT INTO public.customer_support_recovery_commands (
      idempotency_key, payload_fingerprint, operator_id, subject_id, case_id,
      response, created_at
    ) VALUES (
      p_idempotency_key, p_payload_fingerprint, p_operator_id, p_subject_id, p_case_id,
      v_response, v_recorded_at
    );
    INSERT INTO public.customer_support_recovery_audit_events (
      id, operator_id, subject_id, case_id, idempotency_key, outcome,
      refusal_code, occurred_at
    ) VALUES (
      v_audit_id, p_operator_id, p_subject_id, p_case_id, p_idempotency_key,
      'refused', v_refusal_code, v_recorded_at
    );
    RETURN v_response;
  END IF;

  PERFORM public.subscription_rotate_payment_recovery_token(
    p_case_id, p_token_hash, p_expires_at, 'customer_support_recovery'
  );

  SELECT COALESCE(max(notice_row.retry_attempt), 0) + 1 INTO v_notice_attempt
    FROM public.subscription_dunning_notifications AS notice_row
   WHERE notice_row.case_id = p_case_id
     AND notice_row.recipient_kind = 'customer';

  INSERT INTO public.subscription_dunning_notifications (
    case_id, subscription_id, cycle_id, order_id, payment_intent_id,
    recipient_kind, recipient_ref, notification_kind, template_slug,
    retry_attempt, idempotency_key, status, scheduled_at, recovery_url_path,
    payload, created_at, updated_at
  ) VALUES (
    v_case.id, v_case.subscription_id, v_case.cycle_id, v_case.order_id,
    v_case.payment_intent_id, 'customer', v_case.client_id, 'payment_recovery',
    v_source_notice.template_slug, v_notice_attempt,
    'customer-support-recovery:' || p_idempotency_key, 'queued', v_recorded_at,
    p_recovery_path,
    v_source_notice.payload || jsonb_build_object('source', 'customer_support_recovery'),
    v_recorded_at, v_recorded_at
  );

  INSERT INTO public.customer_support_recovery_audit_events (
    id, operator_id, subject_id, case_id, idempotency_key, outcome, occurred_at
  ) VALUES (
    v_audit_id, p_operator_id, p_subject_id, p_case_id, p_idempotency_key,
    'issued', v_recorded_at
  );

  v_response := jsonb_build_object(
    'outcome', 'issued',
    'delivery_status', 'queued',
    'audit_event_id', v_audit_id
  );
  INSERT INTO public.customer_support_recovery_commands (
    idempotency_key, payload_fingerprint, operator_id, subject_id, case_id,
    response, created_at
  ) VALUES (
    p_idempotency_key, p_payload_fingerprint, p_operator_id, p_subject_id, p_case_id,
    v_response, v_recorded_at
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_support_issue_recovery(
  uuid, uuid, uuid, text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_support_issue_recovery(
  uuid, uuid, uuid, text, text, text, timestamptz, text
) TO service_role;
