-- Qualified runtime completion for the existing native subscription command lock.
-- The existing command apply locks every renewal term line FOR UPDATE before its
-- replace-in-transaction rewrite. PostgreSQL requires UPDATE on at least one
-- column for that row lock. Without row security that grant would also admit
-- an actual update, so this unit enables row security: policies preserve the
-- existing SELECT/INSERT/DELETE access and admit locking, while every actual
-- update fails its check. Runtime ownership and BYPASSRLS are forbidden by
-- qualified session admission. The local guard binds the existing runtime and
-- requires the unswitched installer to own the target before any change.
DO $term_line_lock$
DECLARE
  v_runtime text := pg_catalog.current_setting('openlup.qualified.runtime_login', true);
  v_mode text := pg_catalog.current_setting('openlup.qualified.role_mode', true);
  v_runtime_oid oid;
  v_service_oid oid;
BEGIN
  IF current_user <> session_user
    OR NOT COALESCE(v_runtime ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$', false)
    OR NOT COALESCE(v_mode IN ('installer-managed', 'operator-provisioned'), false)
    OR v_runtime = current_user
  THEN
    RAISE EXCEPTION 'term_line_lock_login_binding_invalid' USING ERRCODE = '42501';
  END IF;
  SELECT oid INTO v_runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = v_runtime AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;
  SELECT oid INTO v_service_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'service_role' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;
  IF v_runtime_oid IS NULL OR v_service_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_service_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid = v_service_oid AND member = v_runtime_oid
        AND NOT admin_option AND set_option AND inherit_option)
  THEN
    RAISE EXCEPTION 'term_line_lock_runtime_binding_invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = current_user
        AND c.relname = 'subscription_renewal_term_lines'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'subscription_renewal_term_lines')
  THEN
    RAISE EXCEPTION 'term_line_lock_installer_must_own_target' USING ERRCODE = '42501';
  END IF;
END
$term_line_lock$;

-- Existing access: replay reads, line inserts and replace-in-transaction deletes.
ALTER TABLE public.subscription_renewal_term_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY qualified_rt_term_lines_select
  ON public.subscription_renewal_term_lines
  FOR SELECT TO service_role USING (true);
CREATE POLICY qualified_rt_term_lines_insert
  ON public.subscription_renewal_term_lines
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY qualified_rt_term_lines_delete
  ON public.subscription_renewal_term_lines
  FOR DELETE TO service_role USING (true);

-- Existing command apply locks the lines FOR UPDATE. The policy admits row
-- visibility for locking while rejecting every actual update. The grant names
-- the timestamp column only; key, price and quantity columns stay ungranted.
CREATE POLICY qualified_rt_term_lines_update_lock_only
  ON public.subscription_renewal_term_lines
  FOR UPDATE TO service_role USING (true) WITH CHECK (false);
GRANT UPDATE (updated_at) ON TABLE public.subscription_renewal_term_lines
  TO service_role;
