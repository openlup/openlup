-- Qualified runtime completion for existing native row locks and a conflict read.
-- Four existing invoker writers fail on the restricted runtime. Three lock a row
-- FOR UPDATE: the subscription command apply (renewal term lines), operator
-- recovery issue (recovery commands) and platform control (control operations).
-- PostgreSQL requires UPDATE on at least one column for that row lock. Without
-- row security that grant would also admit an actual update, so this unit enables
-- row security on those three tables: policies preserve the existing runtime
-- access and admit locking, while every actual update fails its check. The order
-- promotion-claim transition appends claim events with a conflict target, which
-- requires SELECT on the arbiter columns; row security would add nothing there.
-- Runtime ownership and BYPASSRLS are forbidden by qualified session admission.
-- The local guard binds the existing runtime and requires the unswitched
-- installer to own every target before any change.
DO $runtime_lock_completion$
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
    RAISE EXCEPTION 'runtime_lock_completion_login_binding_invalid' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'runtime_lock_completion_runtime_binding_invalid' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = current_user
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)
        AND c.relname IN ('subscription_renewal_term_lines', 'customer_recovery_commands',
          'platform_control_operations', 'commerce_promotion_claim_events')) <> 4
  THEN
    RAISE EXCEPTION 'runtime_lock_completion_installer_must_own_targets' USING ERRCODE = '42501';
  END IF;
END
$runtime_lock_completion$;

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

-- Existing recovery issue and platform control lock their idempotency receipt
-- FOR UPDATE before replay, then append. Receipt reads and appends keep their
-- access; every actual update fails its check.
ALTER TABLE public.customer_recovery_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY qualified_rt_recovery_commands_select
  ON public.customer_recovery_commands
  FOR SELECT TO service_role USING (true);
CREATE POLICY qualified_rt_recovery_commands_insert
  ON public.customer_recovery_commands
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY qualified_rt_recovery_commands_update_lock_only
  ON public.customer_recovery_commands
  FOR UPDATE TO service_role USING (true) WITH CHECK (false);
GRANT UPDATE (created_at) ON TABLE public.customer_recovery_commands
  TO service_role;

ALTER TABLE public.platform_control_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY qualified_rt_control_operations_select
  ON public.platform_control_operations
  FOR SELECT TO service_role USING (true);
CREATE POLICY qualified_rt_control_operations_insert
  ON public.platform_control_operations
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY qualified_rt_control_operations_update_lock_only
  ON public.platform_control_operations
  FOR UPDATE TO service_role USING (true) WITH CHECK (false);
GRANT UPDATE (created_at) ON TABLE public.platform_control_operations
  TO service_role;

-- Existing promotion-claim transitions append one event per claim and key with
-- ON CONFLICT (claim_id, event_key) DO NOTHING. The conflict target requires
-- SELECT on both arbiter columns; the runtime already reads the claims those
-- keys derive from. Other event columns stay unreadable.
GRANT SELECT (claim_id, event_key) ON TABLE public.commerce_promotion_claim_events
  TO service_role;
