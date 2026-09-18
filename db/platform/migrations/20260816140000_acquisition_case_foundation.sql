-- Portable tester-acquisition case, opaque address reference and lifecycle.
--
-- WHAT THIS FORWARD SHIPS. A private acquisition schema, distinct NOLOGIN
-- owner/runtime roles, one restart-stable installation key, an opaque (never
-- raw-address) reference registry, an inline durable signup limiter, one
-- tester_application case/contact authority, exact-key command receipts,
-- append-only audit, and four hardened SECURITY DEFINER routines. The runtime
-- role receives public-schema USAGE plus EXECUTE on exactly those four
-- acquisition_case_* signatures; unrelated public-schema function privileges
-- remain unchanged. It receives no private-schema, table, sequence, DML, DDL
-- or secret access.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP. No raw address directory or production
-- fixture, pet/profile/waitlist/newsletter schema, email/provider/Supabase
-- transport, authentication system, egress, route, workflow or dependency.
-- The mounted smoke may load one opaque registry fixture through its database
-- owner connection; adopters load their own replaceable reference registry.
--
-- OPERATIONAL CONTRACT. Role bootstrap is intentionally fail-closed and needs
-- a PostgreSQL SUPERUSER migration login; CREATEROLE alone cannot safely erase
-- the creator's automatic ADMIN memberships while preserving the exact graph.
-- The migration login must also be the application database login. Every
-- acquisition adapter transaction executes SET
-- LOCAL ROLE platform_acquisition_runtime before calling a named routine.
-- This is greenfield-only DDL: it rewrites and locks no existing business row.
-- Recovery is forward-only: disable the binding and retain the durable ledger.

DO $bootstrap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND rolsuper IS true
  ) THEN
    RAISE EXCEPTION 'acquisition_role_bootstrap_requires_superuser' USING ERRCODE = '42501';
  END IF;
END
$bootstrap$;

DO $roles$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT name FROM (VALUES
      ('platform_acquisition_owner'::text),
      ('platform_acquisition_runtime'::text)
    ) AS expected(name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role.name) THEN
      RAISE EXCEPTION 'acquisition_role_preexisting:%', v_role.name USING ERRCODE = '42501';
    END IF;
    EXECUTE pg_catalog.format(
      'CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      v_role.name
    );
  END LOOP;
END
$roles$;

GRANT platform_acquisition_runtime TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;

DO $membership$
DECLARE
  v_owner oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'platform_acquisition_owner');
  v_runtime oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'platform_acquisition_runtime');
  v_session oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = v_owner OR member = v_owner) THEN
    RAISE EXCEPTION 'acquisition_owner_membership_invalid' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_runtime) THEN
    RAISE EXCEPTION 'acquisition_runtime_parent_membership_invalid' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid = v_runtime) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid = v_runtime AND member = v_session
        AND admin_option IS false AND inherit_option IS false AND set_option IS true
    )
  THEN
    RAISE EXCEPTION 'acquisition_runtime_membership_invalid' USING ERRCODE = '42501';
  END IF;
END
$membership$;

CREATE SCHEMA acquisition_private AUTHORIZATION platform_acquisition_owner;
REVOKE ALL ON SCHEMA acquisition_private FROM PUBLIC, anon, authenticated,
  platform_acquisition_runtime;
GRANT USAGE ON SCHEMA public TO platform_acquisition_runtime;
REVOKE CREATE ON SCHEMA public FROM platform_acquisition_runtime;

CREATE TABLE acquisition_private.installation_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key_bytes bytea NOT NULL CHECK (octet_length(key_bytes) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO acquisition_private.installation_key(singleton, key_bytes)
VALUES (
  true,
  decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex')
);

CREATE TABLE acquisition_private.address_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  reference text NOT NULL,
  revision text NOT NULL,
  provenance text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT acquisition_address_reference_key UNIQUE(source, reference, revision),
  CONSTRAINT acquisition_address_source_check
    CHECK (source ~ '^[a-z][a-z0-9_-]{0,47}$'),
  CONSTRAINT acquisition_address_reference_check
    CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'),
  CONSTRAINT acquisition_address_revision_check
    CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CONSTRAINT acquisition_address_provenance_check
    CHECK (provenance ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT acquisition_address_time_check CHECK (updated_at >= created_at)
);

CREATE TABLE acquisition_private.rate_limit_windows (
  key_kind text NOT NULL CHECK (key_kind IN ('requester', 'email')),
  key_fingerprint bytea NOT NULL CHECK (octet_length(key_fingerprint) = 32),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(key_kind, key_fingerprint),
  CONSTRAINT acquisition_rate_limit_time_check CHECK (updated_at >= window_started_at)
);

CREATE TABLE acquisition_private.cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_reference text NOT NULL UNIQUE,
  source_kind text NOT NULL DEFAULT 'tester_application',
  dedupe_fingerprint bytea NOT NULL CHECK (octet_length(dedupe_fingerprint) = 32),
  address_reference_id uuid REFERENCES acquisition_private.address_references(id) ON DELETE RESTRICT,
  lifecycle text NOT NULL DEFAULT 'submitted',
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  consent_version text NOT NULL,
  policy_version text NOT NULL,
  consent_accepted_at timestamptz NOT NULL,
  locale text NOT NULL,
  source_path text NOT NULL,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT acquisition_case_source_check CHECK (source_kind = 'tester_application'),
  CONSTRAINT acquisition_case_reference_check
    CHECK (case_reference ~ '^acquisition-case:[0-9a-f-]{36}$'),
  CONSTRAINT acquisition_case_dedupe_key UNIQUE(source_kind, dedupe_fingerprint),
  CONSTRAINT acquisition_case_lifecycle_check
    CHECK (lifecycle IN ('submitted', 'approved', 'active', 'rejected', 'withdrawn')),
  CONSTRAINT acquisition_case_consent_version_check
    CHECK (consent_version = btrim(consent_version) AND char_length(consent_version) BETWEEN 1 AND 64),
  CONSTRAINT acquisition_case_policy_version_check
    CHECK (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 64),
  CONSTRAINT acquisition_case_locale_check CHECK (locale IN ('en', 'pl')),
  CONSTRAINT acquisition_case_source_path_check
    CHECK (source_path = '/tester-application'),
  CONSTRAINT acquisition_case_withdrawn_check CHECK (
    (lifecycle = 'withdrawn') = (withdrawn_at IS NOT NULL)
    AND (withdrawn_at IS NULL OR address_reference_id IS NULL)
  ),
  CONSTRAINT acquisition_case_time_check CHECK (
    updated_at >= created_at AND consent_accepted_at <= created_at
    AND (withdrawn_at IS NULL OR withdrawn_at >= created_at)
  )
);

CREATE TABLE acquisition_private.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES acquisition_private.cases(id) ON DELETE RESTRICT,
  contact_reference text NOT NULL UNIQUE,
  normalized_email text,
  normalized_phone text,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT acquisition_contact_reference_check
    CHECK (contact_reference ~ '^acquisition-contact:[0-9a-f-]{36}$'),
  CONSTRAINT acquisition_contact_email_check CHECK (
    normalized_email IS NULL OR (
      normalized_email = lower(btrim(normalized_email))
      AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      AND char_length(normalized_email) <= 254
    )
  ),
  CONSTRAINT acquisition_contact_phone_check CHECK (
    normalized_phone IS NULL OR normalized_phone ~ '^\+[1-9][0-9]{6,14}$'
  ),
  CONSTRAINT acquisition_contact_redaction_check CHECK (
    (redacted_at IS NULL AND normalized_email IS NOT NULL)
    OR (redacted_at IS NOT NULL AND normalized_email IS NULL AND normalized_phone IS NULL)
  ),
  CONSTRAINT acquisition_contact_time_check CHECK (
    updated_at >= created_at AND (redacted_at IS NULL OR redacted_at >= created_at)
  )
);

CREATE TABLE acquisition_private.commands (
  scope text NOT NULL CHECK (scope IN ('submit', 'transition')),
  idempotency_key text NOT NULL,
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) = 32),
  case_id uuid NOT NULL REFERENCES acquisition_private.cases(id) ON DELETE RESTRICT,
  result_lifecycle text NOT NULL,
  result_version bigint NOT NULL CHECK (result_version > 0),
  result_updated_at timestamptz NOT NULL,
  result_projection jsonb NOT NULL CHECK (jsonb_typeof(result_projection) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(scope, idempotency_key),
  CONSTRAINT acquisition_command_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  CONSTRAINT acquisition_command_result_check
    CHECK (result_lifecycle IN ('submitted', 'approved', 'active', 'rejected', 'withdrawn'))
);

CREATE TABLE acquisition_private.audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES acquisition_private.cases(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('submitted', 'transitioned', 'withdrawn')),
  from_lifecycle text,
  to_lifecycle text NOT NULL,
  from_version bigint,
  to_version bigint NOT NULL CHECK (to_version > 0),
  actor_id uuid,
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) = 32),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT acquisition_audit_from_lifecycle_check CHECK (
    from_lifecycle IS NULL OR from_lifecycle IN ('submitted', 'approved', 'active', 'rejected', 'withdrawn')
  ),
  CONSTRAINT acquisition_audit_to_lifecycle_check
    CHECK (to_lifecycle IN ('submitted', 'approved', 'active', 'rejected', 'withdrawn')),
  CONSTRAINT acquisition_audit_version_shape_check CHECK (
    (action = 'submitted' AND from_lifecycle IS NULL AND from_version IS NULL AND actor_id IS NULL AND to_version = 1)
    OR (action <> 'submitted' AND from_lifecycle IS NOT NULL AND from_version IS NOT NULL
      AND actor_id IS NOT NULL AND to_version = from_version + 1)
  )
);

CREATE INDEX acquisition_cases_admin_cursor_idx
  ON acquisition_private.cases(created_at DESC, id DESC);
CREATE INDEX acquisition_cases_active_count_idx
  ON acquisition_private.cases(source_kind, lifecycle);
CREATE INDEX acquisition_audit_case_time_idx
  ON acquisition_private.audit(case_id, occurred_at, id);

ALTER TABLE acquisition_private.installation_key OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.address_references OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.rate_limit_windows OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.cases OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.contacts OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.commands OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.audit OWNER TO platform_acquisition_owner;

REVOKE ALL ON ALL TABLES IN SCHEMA acquisition_private
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA acquisition_private
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

CREATE FUNCTION acquisition_private.keyed_digest(p_domain text, p_payload jsonb)
RETURNS bytea
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.sha256(k.key_bytes
    || pg_catalog.convert_to(p_domain || ':' || p_payload::text, 'UTF8')
    || k.key_bytes)
  FROM acquisition_private.installation_key AS k
  WHERE k.singleton
$function$;

CREATE FUNCTION acquisition_private.case_projection(p_case_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
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

CREATE FUNCTION acquisition_private.refuse_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'acquisition_append_only' USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER acquisition_commands_append_only
BEFORE UPDATE OR DELETE ON acquisition_private.commands
FOR EACH ROW EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();
CREATE TRIGGER acquisition_commands_no_truncate
BEFORE TRUNCATE ON acquisition_private.commands
FOR EACH STATEMENT EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();
CREATE TRIGGER acquisition_audit_append_only
BEFORE UPDATE OR DELETE ON acquisition_private.audit
FOR EACH ROW EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();
CREATE TRIGGER acquisition_audit_no_truncate
BEFORE TRUNCATE ON acquisition_private.audit
FOR EACH STATEMENT EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();

ALTER FUNCTION acquisition_private.keyed_digest(text, jsonb) OWNER TO platform_acquisition_owner;
ALTER FUNCTION acquisition_private.case_projection(uuid) OWNER TO platform_acquisition_owner;
ALTER FUNCTION acquisition_private.refuse_append_only_mutation() OWNER TO platform_acquisition_owner;
REVOKE ALL ON FUNCTION acquisition_private.keyed_digest(text, jsonb)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION acquisition_private.case_projection(uuid)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION acquisition_private.refuse_append_only_mutation()
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

CREATE FUNCTION public.acquisition_case_submit_v1(
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

CREATE FUNCTION public.acquisition_case_operator_list_v1(
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

CREATE FUNCTION public.acquisition_case_transition_v1(
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
SET search_path = pg_catalog
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

CREATE FUNCTION public.acquisition_case_active_count_v1()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT count(*)::bigint
  FROM acquisition_private.cases AS c
  WHERE c.source_kind = 'tester_application'
    AND c.lifecycle IN ('approved', 'active')
$function$;

ALTER FUNCTION public.acquisition_case_submit_v1(
  text, text, text, text, boolean, text, text, text, text,
  text, text, text, text, timestamptz
) OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.acquisition_case_operator_list_v1(uuid, timestamptz, uuid, integer)
  OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.acquisition_case_transition_v1(uuid, text, bigint, text, text, text, timestamptz)
  OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.acquisition_case_active_count_v1()
  OWNER TO platform_acquisition_owner;

REVOKE ALL ON FUNCTION public.acquisition_case_submit_v1(
  text, text, text, text, boolean, text, text, text, text,
  text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION public.acquisition_case_operator_list_v1(uuid, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION public.acquisition_case_transition_v1(uuid, text, bigint, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;
REVOKE ALL ON FUNCTION public.acquisition_case_active_count_v1()
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

GRANT EXECUTE ON FUNCTION public.acquisition_case_submit_v1(
  text, text, text, text, boolean, text, text, text, text,
  text, text, text, text, timestamptz
) TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.acquisition_case_operator_list_v1(uuid, timestamptz, uuid, integer)
  TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.acquisition_case_transition_v1(uuid, text, bigint, text, text, text, timestamptz)
  TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.acquisition_case_active_count_v1()
  TO platform_acquisition_runtime;
