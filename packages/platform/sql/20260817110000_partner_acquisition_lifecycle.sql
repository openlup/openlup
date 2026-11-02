-- Portable partner-acquisition lifecycle over the existing acquisition authority.
--
-- WHAT THIS FORWARD SHIPS. It adds `partner_inquiry` as a distinct acquisition
-- case kind, a bounded organization/contact projection, exact-key submit and
-- transition receipts, append-only audit, and three hardened partner routines.
-- The existing platform acquisition runtime role receives EXECUTE only on the
-- named routines and still receives no private table, sequence, DML or DDL
-- privilege. Existing tester-application routines and projections are not
-- replaced.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP. No provider email, CRM identifier,
-- newsletter consent, customer identity, raw provider payload, public table
-- grant, authentication system, route, workflow, secret or dependency.
--
-- OPERATIONAL CONTRACT. This migration depends on the C-D23A acquisition role
-- graph. Recovery is forward-only: disable the partner binding while retaining
-- its case/command/audit ledger. Constraint changes validate only the small
-- greenfield acquisition tables and do not rewrite unrelated business data.

ALTER TABLE acquisition_private.cases
  DROP CONSTRAINT acquisition_case_source_check,
  DROP CONSTRAINT acquisition_case_lifecycle_check,
  DROP CONSTRAINT acquisition_case_source_path_check;

ALTER TABLE acquisition_private.cases
  ADD CONSTRAINT acquisition_case_source_check
    CHECK (source_kind IN ('tester_application', 'partner_inquiry')) NOT VALID,
  ADD CONSTRAINT acquisition_case_lifecycle_check CHECK (
    (source_kind = 'tester_application'
      AND lifecycle IN ('submitted', 'approved', 'active', 'rejected', 'withdrawn'))
    OR
    (source_kind = 'partner_inquiry'
      AND lifecycle IN ('new', 'contacted', 'qualified', 'disqualified', 'closed_won', 'closed_lost'))
  ) NOT VALID,
  ADD CONSTRAINT acquisition_case_source_path_check CHECK (
    (source_kind = 'tester_application' AND source_path = '/tester-application')
    OR (source_kind = 'partner_inquiry' AND source_path = '/partners/b2b-inquiries')
  ) NOT VALID,
  ADD CONSTRAINT acquisition_case_address_shape_check CHECK (
    (source_kind = 'tester_application' AND (lifecycle = 'withdrawn' OR address_reference_id IS NOT NULL))
    OR (source_kind = 'partner_inquiry' AND address_reference_id IS NULL)
  ) NOT VALID;

ALTER TABLE acquisition_private.commands
  DROP CONSTRAINT commands_scope_check,
  DROP CONSTRAINT acquisition_command_result_check;

ALTER TABLE acquisition_private.commands
  ADD CONSTRAINT acquisition_commands_scope_check
    CHECK (scope IN ('submit', 'transition', 'partner_submit', 'partner_transition')) NOT VALID,
  ADD CONSTRAINT acquisition_command_result_check CHECK (
    result_lifecycle IN (
      'submitted', 'approved', 'active', 'rejected', 'withdrawn',
      'new', 'contacted', 'qualified', 'disqualified', 'closed_won', 'closed_lost'
    )
  ) NOT VALID;

ALTER TABLE acquisition_private.audit
  DROP CONSTRAINT acquisition_audit_from_lifecycle_check,
  DROP CONSTRAINT acquisition_audit_to_lifecycle_check;

ALTER TABLE acquisition_private.audit
  ADD CONSTRAINT acquisition_audit_from_lifecycle_check CHECK (
    from_lifecycle IS NULL OR from_lifecycle IN (
      'submitted', 'approved', 'active', 'rejected', 'withdrawn',
      'new', 'contacted', 'qualified', 'disqualified', 'closed_won', 'closed_lost'
    )
  ) NOT VALID,
  ADD CONSTRAINT acquisition_audit_to_lifecycle_check CHECK (
    to_lifecycle IN (
      'submitted', 'approved', 'active', 'rejected', 'withdrawn',
      'new', 'contacted', 'qualified', 'disqualified', 'closed_won', 'closed_lost'
    )
  ) NOT VALID;

CREATE TABLE acquisition_private.partner_details (
  case_id uuid PRIMARY KEY REFERENCES acquisition_private.cases(id) ON DELETE RESTRICT,
  organization_name text NOT NULL,
  country_code text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL,
  CONSTRAINT partner_details_organization_check
    CHECK (organization_name = btrim(organization_name) AND char_length(organization_name) BETWEEN 2 AND 100),
  CONSTRAINT partner_details_country_check CHECK (country_code ~ '^[A-Z]{2,3}$'),
  CONSTRAINT partner_details_first_name_check
    CHECK (first_name = btrim(first_name) AND char_length(first_name) BETWEEN 2 AND 50),
  CONSTRAINT partner_details_last_name_check
    CHECK (last_name = btrim(last_name) AND char_length(last_name) BETWEEN 2 AND 50),
  CONSTRAINT partner_details_notes_check
    CHECK (notes IS NULL OR (notes = btrim(notes) AND char_length(notes) BETWEEN 1 AND 1000))
);

ALTER TABLE acquisition_private.partner_details OWNER TO platform_acquisition_owner;
REVOKE ALL ON acquisition_private.partner_details
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

CREATE FUNCTION acquisition_private.partner_case_projection(p_case_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'contractVersion', 'partner_acquisition_v1',
    'caseRef', c.case_reference,
    'contactRef', contact.contact_reference,
    'organization', jsonb_build_object(
      'name', details.organization_name,
      'country', details.country_code
    ),
    'contact', jsonb_build_object(
      'firstName', details.first_name,
      'lastName', details.last_name,
      'email', contact.normalized_email,
      'phone', contact.normalized_phone
    ),
    'notes', details.notes,
    'status', c.lifecycle,
    'version', c.state_version,
    'createdAt', c.created_at,
    'updatedAt', c.updated_at
  )
  FROM acquisition_private.cases AS c
  JOIN acquisition_private.contacts AS contact ON contact.case_id = c.id
  JOIN acquisition_private.partner_details AS details ON details.case_id = c.id
  WHERE c.id = p_case_id AND c.source_kind = 'partner_inquiry'
$function$;

ALTER FUNCTION acquisition_private.partner_case_projection(uuid)
  OWNER TO platform_acquisition_owner;
REVOKE ALL ON FUNCTION acquisition_private.partner_case_projection(uuid)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

CREATE FUNCTION public.partner_acquisition_submit_v1(
  p_idempotency_key text,
  p_requester_key text,
  p_organization_name text,
  p_country_code text,
  p_first_name text,
  p_last_name text,
  p_normalized_email text,
  p_normalized_phone text,
  p_notes text,
  p_policy_version text,
  p_source_path text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_command_fingerprint bytea;
  v_dedupe_fingerprint bytea;
  v_requester_fingerprint bytea;
  v_email_fingerprint bytea;
  v_existing_command acquisition_private.commands%ROWTYPE;
  v_existing_case acquisition_private.cases%ROWTYPE;
  v_case acquisition_private.cases%ROWTYPE;
  v_case_id uuid := gen_random_uuid();
  v_contact_id uuid := gen_random_uuid();
  v_requester_attempts integer;
  v_email_attempts integer;
BEGIN
  IF p_idempotency_key IS NULL
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    OR p_requester_key IS NULL OR char_length(p_requester_key) NOT BETWEEN 1 AND 256
    OR p_organization_name IS NULL OR p_organization_name <> btrim(p_organization_name)
    OR char_length(p_organization_name) NOT BETWEEN 2 AND 100
    OR p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2,3}$'
    OR p_first_name IS NULL OR p_first_name <> btrim(p_first_name)
    OR char_length(p_first_name) NOT BETWEEN 2 AND 50
    OR p_last_name IS NULL OR p_last_name <> btrim(p_last_name)
    OR char_length(p_last_name) NOT BETWEEN 2 AND 50
    OR p_normalized_email IS NULL OR p_normalized_email <> lower(btrim(p_normalized_email))
    OR char_length(p_normalized_email) > 254
    OR p_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR (p_normalized_phone IS NOT NULL AND p_normalized_phone !~ '^\+[1-9][0-9]{6,14}$')
    OR (p_notes IS NOT NULL AND (p_notes <> btrim(p_notes) OR char_length(p_notes) NOT BETWEEN 1 AND 1000))
    OR p_policy_version IS NULL OR p_policy_version <> btrim(p_policy_version)
    OR char_length(p_policy_version) NOT BETWEEN 1 AND 64
    OR p_source_path IS DISTINCT FROM '/partners/b2b-inquiries'
    OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'partner_acquisition_invalid' USING ERRCODE = '22023';
  END IF;

  v_command_fingerprint := acquisition_private.keyed_digest('partner-submit-command', jsonb_build_object(
    'organization', p_organization_name, 'country', p_country_code,
    'firstName', p_first_name, 'lastName', p_last_name,
    'email', p_normalized_email, 'phone', p_normalized_phone,
    'notes', p_notes, 'policyVersion', p_policy_version, 'sourcePath', p_source_path
  ));
  v_dedupe_fingerprint := acquisition_private.keyed_digest(
    'partner-inquiry-contact', jsonb_build_object('email', p_normalized_email));
  v_requester_fingerprint := acquisition_private.keyed_digest(
    'partner-inquiry-requester-limit', jsonb_build_object('requester', p_requester_key));
  v_email_fingerprint := acquisition_private.keyed_digest(
    'partner-inquiry-email-limit', jsonb_build_object('email', p_normalized_email));

  PERFORM pg_advisory_xact_lock(hashtextextended('partner-submit:' || p_idempotency_key, 0));
  SELECT * INTO v_existing_command
  FROM acquisition_private.commands
  WHERE scope = 'partner_submit' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_command.command_fingerprint <> v_command_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replayed', 'replayed', true,
      'acquisitionCase', v_existing_command.result_projection
    );
  END IF;

  INSERT INTO acquisition_private.rate_limit_windows AS limiter
    (key_kind, key_fingerprint, window_started_at, attempts, updated_at)
  VALUES ('requester', v_requester_fingerprint, p_now, 1, p_now)
  ON CONFLICT (key_kind, key_fingerprint) DO UPDATE SET
    window_started_at = CASE WHEN limiter.window_started_at <= p_now - interval '60 minutes'
      THEN p_now ELSE limiter.window_started_at END,
    attempts = CASE WHEN limiter.window_started_at <= p_now - interval '60 minutes'
      THEN 1 ELSE least(limiter.attempts + 1, 1000000) END,
    updated_at = p_now
  RETURNING attempts INTO v_requester_attempts;

  INSERT INTO acquisition_private.rate_limit_windows AS limiter
    (key_kind, key_fingerprint, window_started_at, attempts, updated_at)
  VALUES ('email', v_email_fingerprint, p_now, 1, p_now)
  ON CONFLICT (key_kind, key_fingerprint) DO UPDATE SET
    window_started_at = CASE WHEN limiter.window_started_at <= p_now - interval '60 minutes'
      THEN p_now ELSE limiter.window_started_at END,
    attempts = CASE WHEN limiter.window_started_at <= p_now - interval '60 minutes'
      THEN 1 ELSE least(limiter.attempts + 1, 1000000) END,
    updated_at = p_now
  RETURNING attempts INTO v_email_attempts;

  IF v_requester_attempts > 5 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'reason', 'requester_quota');
  END IF;
  IF v_email_attempts > 3 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'reason', 'email_quota');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'partner-dedupe:' || encode(v_dedupe_fingerprint, 'hex'), 0));
  SELECT * INTO v_existing_case
  FROM acquisition_private.cases
  WHERE source_kind = 'partner_inquiry' AND dedupe_fingerprint = v_dedupe_fingerprint;
  IF FOUND THEN RETURN jsonb_build_object('outcome', 'contact_conflict'); END IF;

  INSERT INTO acquisition_private.cases(
    id, case_reference, source_kind, dedupe_fingerprint, address_reference_id,
    lifecycle, state_version, consent_version, policy_version, consent_accepted_at,
    locale, source_path, created_at, updated_at
  ) VALUES (
    v_case_id, 'acquisition-case:' || v_case_id::text, 'partner_inquiry',
    v_dedupe_fingerprint, NULL, 'new', 1, 'not-applicable', p_policy_version,
    p_now, 'und', p_source_path, p_now, p_now
  ) RETURNING * INTO v_case;

  INSERT INTO acquisition_private.contacts(
    id, case_id, contact_reference, normalized_email, normalized_phone, created_at, updated_at
  ) VALUES (
    v_contact_id, v_case.id, 'acquisition-contact:' || v_contact_id::text,
    p_normalized_email, p_normalized_phone, p_now, p_now
  );
  INSERT INTO acquisition_private.partner_details(
    case_id, organization_name, country_code, first_name, last_name, notes, created_at
  ) VALUES (
    v_case.id, p_organization_name, p_country_code, p_first_name, p_last_name, p_notes, p_now
  );
  INSERT INTO acquisition_private.audit(
    case_id, action, from_lifecycle, to_lifecycle, from_version, to_version,
    actor_id, command_fingerprint, occurred_at
  ) VALUES (v_case.id, 'submitted', NULL, 'new', NULL, 1, NULL, v_command_fingerprint, p_now);
  INSERT INTO acquisition_private.commands(
    scope, idempotency_key, command_fingerprint, case_id, result_lifecycle,
    result_version, result_updated_at, result_projection, created_at
  ) VALUES (
    'partner_submit', p_idempotency_key, v_command_fingerprint, v_case.id,
    'new', 1, p_now, acquisition_private.partner_case_projection(v_case.id), p_now
  );

  RETURN jsonb_build_object(
    'outcome', 'created', 'replayed', false,
    'acquisitionCase', acquisition_private.partner_case_projection(v_case.id)
  );
END
$function$;

CREATE FUNCTION public.partner_acquisition_operator_list_v1(
  p_actor_id uuid,
  p_after_created_at timestamptz,
  p_after_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
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
    RAISE EXCEPTION 'partner_acquisition_list_invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN
    SELECT c.id, c.created_at
    FROM acquisition_private.cases AS c
    WHERE c.source_kind = 'partner_inquiry'
      AND (p_after_created_at IS NULL OR (c.created_at, c.id) < (p_after_created_at, p_after_id))
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT p_limit + 1
  LOOP
    v_seen := v_seen + 1;
    IF v_seen > p_limit THEN v_has_more := true; CONTINUE; END IF;
    v_last_created_at := v_row.created_at;
    v_last_id := v_row.id;
    v_items := v_items || jsonb_build_array(acquisition_private.partner_case_projection(v_row.id));
  END LOOP;
  RETURN jsonb_build_object(
    'contractVersion', 'partner_acquisition_v1',
    'cases', v_items,
    'nextCursor', CASE WHEN v_has_more THEN jsonb_build_object(
      'createdAt', v_last_created_at, 'id', v_last_id
    ) ELSE NULL END
  );
END
$function$;

CREATE FUNCTION public.partner_acquisition_transition_v1(
  p_actor_id uuid,
  p_case_reference text,
  p_expected_version bigint,
  p_target_status text,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_command_fingerprint bytea;
  v_existing_command acquisition_private.commands%ROWTYPE;
  v_case acquisition_private.cases%ROWTYPE;
  v_from_status text;
  v_from_version bigint;
BEGIN
  IF p_actor_id IS NULL
    OR p_case_reference IS NULL OR p_case_reference !~ '^acquisition-case:[0-9a-f-]{36}$'
    OR p_expected_version IS NULL OR p_expected_version < 1
    OR p_target_status NOT IN ('contacted', 'qualified', 'disqualified', 'closed_won', 'closed_lost')
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    OR p_now IS NULL
  THEN
    RAISE EXCEPTION 'partner_acquisition_transition_invalid' USING ERRCODE = '22023';
  END IF;
  v_command_fingerprint := acquisition_private.keyed_digest('partner-transition-command', jsonb_build_object(
    'actorId', p_actor_id, 'caseRef', p_case_reference,
    'expectedVersion', p_expected_version, 'targetStatus', p_target_status
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-transition:' || p_idempotency_key, 0));
  SELECT * INTO v_existing_command FROM acquisition_private.commands
  WHERE scope = 'partner_transition' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_command.command_fingerprint <> v_command_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replayed', 'replayed', true,
      'acquisitionCase', v_existing_command.result_projection
    );
  END IF;

  SELECT * INTO v_case FROM acquisition_private.cases
  WHERE case_reference = p_case_reference AND source_kind = 'partner_inquiry'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_case.state_version <> p_expected_version THEN
    RETURN jsonb_build_object('outcome', 'version_conflict');
  END IF;
  IF NOT (
    (v_case.lifecycle = 'new' AND p_target_status IN ('contacted', 'disqualified'))
    OR (v_case.lifecycle = 'contacted' AND p_target_status IN ('qualified', 'disqualified', 'closed_lost'))
    OR (v_case.lifecycle = 'qualified' AND p_target_status IN ('closed_won', 'closed_lost', 'disqualified'))
  ) THEN
    RETURN jsonb_build_object('outcome', 'transition_conflict');
  END IF;

  v_from_status := v_case.lifecycle;
  v_from_version := v_case.state_version;
  UPDATE acquisition_private.cases SET
    lifecycle = p_target_status,
    state_version = state_version + 1,
    updated_at = p_now
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  INSERT INTO acquisition_private.audit(
    case_id, action, from_lifecycle, to_lifecycle, from_version, to_version,
    actor_id, command_fingerprint, occurred_at
  ) VALUES (
    v_case.id, 'transitioned', v_from_status, v_case.lifecycle,
    v_from_version, v_case.state_version, p_actor_id, v_command_fingerprint, p_now
  );
  INSERT INTO acquisition_private.commands(
    scope, idempotency_key, command_fingerprint, case_id, result_lifecycle,
    result_version, result_updated_at, result_projection, created_at
  ) VALUES (
    'partner_transition', p_idempotency_key, v_command_fingerprint, v_case.id,
    v_case.lifecycle, v_case.state_version, p_now,
    acquisition_private.partner_case_projection(v_case.id), p_now
  );
  RETURN jsonb_build_object(
    'outcome', 'transitioned', 'replayed', false,
    'acquisitionCase', acquisition_private.partner_case_projection(v_case.id)
  );
END
$function$;

ALTER FUNCTION public.partner_acquisition_submit_v1(
  text, text, text, text, text, text, text, text, text, text, text, timestamptz
) OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.partner_acquisition_operator_list_v1(uuid, timestamptz, uuid, integer)
  OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.partner_acquisition_transition_v1(uuid, text, bigint, text, text, timestamptz)
  OWNER TO platform_acquisition_owner;

REVOKE ALL ON FUNCTION public.partner_acquisition_submit_v1(
  text, text, text, text, text, text, text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION public.partner_acquisition_operator_list_v1(uuid, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION public.partner_acquisition_transition_v1(uuid, text, bigint, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

GRANT EXECUTE ON FUNCTION public.partner_acquisition_submit_v1(
  text, text, text, text, text, text, text, text, text, text, text, timestamptz
) TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.partner_acquisition_operator_list_v1(uuid, timestamptz, uuid, integer)
  TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.partner_acquisition_transition_v1(uuid, text, bigint, text, text, timestamptz)
  TO platform_acquisition_runtime;
