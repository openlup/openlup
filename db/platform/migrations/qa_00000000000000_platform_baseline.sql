-- Restricted-admin fresh installation: M is trusted, NOSUPERUSER and database owner.
-- Retained ADMIN-only membership permits M to reacquire owner execution explicitly.
-- Runtime/restore authority is separately bounded; this does not isolate the DBA.
DO $qa_session$
DECLARE
  v_mode text := pg_catalog.current_setting('openlup.qualified.role_mode', true);
  v_runtime text := pg_catalog.current_setting('openlup.qualified.runtime_login', true);
  v_restore text := pg_catalog.current_setting('openlup.qualified.restore_login', true);
  v_operator text := COALESCE(pg_catalog.current_setting('openlup.qualified.operator_login', true), '');
  v_m pg_catalog.pg_roles%ROWTYPE;
  v_role pg_catalog.pg_roles%ROWTYPE;
  v_name text;
BEGIN
  SELECT * INTO v_m FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF current_user <> session_user OR NOT FOUND OR NOT v_m.rolcanlogin
    OR v_m.rolsuper OR v_m.rolinherit OR v_m.rolcreatedb OR v_m.rolreplication OR v_m.rolbypassrls
    OR v_m.rolconnlimit <> -1 OR v_m.rolvaliduntil IS NOT NULL
    OR v_mode IS NULL OR v_mode NOT IN ('installer-managed', 'operator-provisioned')
    OR v_m.rolcreaterole IS DISTINCT FROM (v_mode = 'installer-managed')
    OR (SELECT datdba FROM pg_catalog.pg_database WHERE datname = current_database()) <> v_m.oid
    OR pg_catalog.current_setting('server_version_num')::integer / 10000 <> 16
    OR pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR pg_catalog.current_schemas(true) IS DISTINCT FROM ARRAY['pg_catalog', 'public']::name[]
    OR pg_catalog.pg_has_role(v_m.oid, 10::oid, 'MEMBER')
  THEN
    RAISE EXCEPTION 'qualified_admin_session_invalid' USING ERRCODE = '42501';
  END IF;
  IF v_runtime IS NULL OR v_restore IS NULL OR v_runtime = v_restore
    OR v_runtime = current_user OR v_restore = current_user
    OR (v_mode = 'installer-managed' AND v_operator <> '')
    OR (v_mode = 'operator-provisioned' AND (v_operator = '' OR v_operator IN (v_runtime, v_restore, current_user)))
  THEN
    RAISE EXCEPTION 'qualified_admin_principal_binding_invalid' USING ERRCODE = '42501';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[v_runtime, v_restore] || CASE WHEN v_operator = '' THEN ARRAY[]::text[] ELSE ARRAY[v_operator] END LOOP
    IF v_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
      OR v_name IN ('PUBLIC', 'anon', 'authenticated', 'service_role', 'platform_acquisition_owner', 'platform_acquisition_runtime', 'openlup_retained_import_owner')
      OR left(v_name, 3) = 'pg_'
    THEN RAISE EXCEPTION 'qualified_admin_principal_binding_invalid' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_role FROM pg_catalog.pg_roles WHERE rolname = v_name;
    IF NOT FOUND OR NOT v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolinherit
      OR v_role.rolcreatedb OR v_role.rolreplication OR v_role.rolbypassrls
      OR v_role.rolconnlimit <> -1 OR v_role.rolvaliduntil IS NOT NULL
      OR v_role.rolcreaterole IS DISTINCT FROM (v_name = v_operator)
      OR pg_catalog.pg_has_role(v_role.oid, 10::oid, 'MEMBER')
    THEN RAISE EXCEPTION 'qualified_admin_principal_flags_invalid' USING ERRCODE = '42501'; END IF;
  END LOOP;
END
$qa_session$;

-- Qualified fresh PostgreSQL kernel. This is a new installation identity.
-- It never records the legacy baseline as applied and cannot upgrade a legacy
-- ledger. The runner commits this unit and its position-zero row together.
-- Role provisioning and runtime grants belong to the following qualified units.

DO $qualified_fresh$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname <> 'public' AND nspname <> 'information_schema'
      AND left(nspname, 3) <> 'pg_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'qualified_install_requires_empty_database' USING ERRCODE = '42501';
  END IF;
END
$qualified_fresh$;

CREATE TABLE public.platform_schema_migrations (
  catalog_path text PRIMARY KEY,
  sha256 text NOT NULL,
  position integer NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT platform_schema_migrations_catalog_path_check
    CHECK (catalog_path ~ '^db/platform/migrations/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$'),
  CONSTRAINT platform_schema_migrations_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_schema_migrations_position_check
    CHECK (position >= 0),
  CONSTRAINT platform_schema_migrations_position_key UNIQUE (position)
);

CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  email text NOT NULL,
  first_name text,
  last_name text,
  phone text,
  country text,
  lifecycle_stage text NOT NULL DEFAULT 'lead',
  acquisition_source text,
  external_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT clients_email_nonempty_check CHECK (btrim(email) <> ''),
  CONSTRAINT clients_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('lead', 'customer', 'inactive'))
);

CREATE UNIQUE INDEX idx_clients_email_lower
  ON public.clients (lower(email));
