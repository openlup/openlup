-- Qualified fresh actor/service role bootstrap. Host-owned LOGIN credentials
-- never enter this unit. The two supported modes produce the same protected
-- graph; operator-provisioned roles must already match it exactly.

DO $qualified_roles$
DECLARE
  v_runtime text := current_setting('openlup.qualified.runtime_login', true);
  v_mode text := current_setting('openlup.qualified.role_mode', true);
  v_group text;
  v_oid oid;
BEGIN
  IF current_user <> session_user OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolcanlogin AND rolsuper
  ) THEN
    RAISE EXCEPTION 'qualified_install_requires_superuser_login' USING ERRCODE = '42501';
  END IF;
  IF v_mode IS NULL OR v_mode NOT IN ('installer-managed', 'operator-provisioned')
    OR v_runtime IS NULL OR v_runtime !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
    OR v_runtime = current_user
    OR v_runtime IN ('anon', 'authenticated', 'service_role', 'platform_acquisition_owner', 'platform_acquisition_runtime', 'openlup_retained_import_owner')
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_runtime AND rolcanlogin
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit = -1 AND rolvaliduntil IS NULL
    ) THEN
    RAISE EXCEPTION 'qualified_runtime_login_invalid' USING ERRCODE = '42501';
  END IF;
  FOREACH v_group IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
    IF v_mode = 'installer-managed' THEN
      IF v_oid IS NOT NULL THEN
        RAISE EXCEPTION 'qualified_role_preexisting:%', v_group USING ERRCODE = '42501';
      END IF;
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', v_group);
      EXECUTE pg_catalog.format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT %s, SET TRUE', v_group, v_runtime, CASE WHEN v_group = 'service_role' THEN 'TRUE' ELSE 'FALSE' END);
      SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
    END IF;
    IF v_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_oid AND NOT rolcanlogin
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit = -1 AND rolvaliduntil IS NULL
    ) OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_oid)
      OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid = v_oid) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members AS m
        JOIN pg_catalog.pg_roles AS r ON r.oid = m.member
        WHERE m.roleid = v_oid AND r.rolname = v_runtime AND m.grantor = 10
          AND NOT m.admin_option AND m.set_option
          AND m.inherit_option = (v_group = 'service_role')
      ) THEN
      RAISE EXCEPTION 'qualified_role_graph_invalid:%', v_group USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$qualified_roles$;

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

