-- Qualified runtime completion for existing fulfillment and review-media commands.
-- The existing trusted source preflight admits the complete selected role graph.
-- This local guard binds the existing runtime and requires the unswitched installer
-- to own both grant targets. It adds no SUPERUSER requirement to this shared tail.
DO $runtime_completion$
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
    RAISE EXCEPTION 'runtime_completion_login_binding_invalid' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'runtime_completion_runtime_binding_invalid' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = current_user
        AND c.relname IN ('fulfillment_dispatch_contexts', 'commerce_order_review_command_receipts')) <> 2
  THEN
    RAISE EXCEPTION 'runtime_completion_installer_must_own_targets' USING ERRCODE = '42501';
  END IF;
END
$runtime_completion$;

-- Preserve the existing locked context lane; UPDATE excludes shipment_id.
GRANT INSERT (shipment_id, contact_revision, provider_ref, withheld)
  ON TABLE public.fulfillment_dispatch_contexts TO service_role;
GRANT UPDATE (contact_revision, provider_ref, withheld)
  ON TABLE public.fulfillment_dispatch_contexts TO service_role;
GRANT DELETE ON TABLE public.fulfillment_dispatch_contexts TO service_role;

-- Replay reads and append inserts only; the existing mutation triggers remain.
GRANT SELECT, INSERT ON TABLE public.commerce_order_review_command_receipts
  TO service_role;
