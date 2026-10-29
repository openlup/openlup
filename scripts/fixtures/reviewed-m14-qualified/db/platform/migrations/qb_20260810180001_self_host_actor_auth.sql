-- Qualified-admin fresh actor/service bootstrap. Credentials remain host-owned.
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

DO $qa_roles$
DECLARE
  v_mode text := pg_catalog.current_setting('openlup.qualified.role_mode');
  v_runtime text := pg_catalog.current_setting('openlup.qualified.runtime_login');
  v_operator text := COALESCE(pg_catalog.current_setting('openlup.qualified.operator_login', true), '');
  v_m oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  v_r oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = v_runtime);
  v_o oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = v_operator);
  v_grantor oid;
  v_group text;
  v_oid oid;
  v_runtime_group boolean;
BEGIN
  v_grantor := CASE WHEN v_mode = 'installer-managed' THEN v_m ELSE v_o END;
  FOREACH v_group IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    v_runtime_group := v_group IN ('anon', 'authenticated', 'service_role');
    SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
    IF v_mode = 'installer-managed' THEN
      IF v_oid IS NOT NULL THEN RAISE EXCEPTION 'qualified_admin_role_preexisting:%', v_group USING ERRCODE = '42501'; END IF;
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', v_group);
      IF v_runtime_group THEN
        EXECUTE pg_catalog.format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT %s, SET TRUE GRANTED BY %I', v_group, v_runtime, CASE WHEN v_group = 'service_role' THEN 'TRUE' ELSE 'FALSE' END, current_user);
      END IF;
      SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
    END IF;
    IF v_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_oid AND NOT rolcanlogin AND NOT rolinherit
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
        AND NOT rolbypassrls AND rolconnlimit = -1 AND rolvaliduntil IS NULL
    ) OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_oid)
      OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid = v_oid)
        <> (CASE WHEN v_mode = 'installer-managed' THEN 1 ELSE 2 END) + (CASE WHEN v_runtime_group THEN 1 ELSE 0 END)
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members a WHERE a.roleid = v_oid AND NOT (
          (a.member = v_m AND a.grantor = CASE WHEN v_mode = 'installer-managed' THEN 10::oid ELSE v_o END
            AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)
          OR (v_mode = 'operator-provisioned' AND a.member = v_o AND a.grantor = 10
            AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)
          OR (v_runtime_group AND a.member = v_r AND a.grantor = v_grantor AND NOT a.admin_option
            AND a.inherit_option = (v_group = 'service_role') AND a.set_option)
        )
      )
    THEN RAISE EXCEPTION 'qualified_admin_role_graph_invalid:%', v_group USING ERRCODE = '42501'; END IF;
  END LOOP;
END
$qa_roles$;

CREATE SCHEMA auth;

CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN current_setting('request.jwt.claims', true) IS NULL THEN NULL
    WHEN current_setting('request.jwt.claims', true) = '' THEN NULL
    WHEN jsonb_typeof(current_setting('request.jwt.claims', true)::jsonb -> 'sub') <> 'string' THEN NULL
    WHEN current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL
    ELSE (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
  END
$$;

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
