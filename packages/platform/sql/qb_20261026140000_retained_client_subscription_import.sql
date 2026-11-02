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
  FOREACH v_group IN ARRAY ARRAY['openlup_retained_import_owner'] LOOP
    v_runtime_group := v_group IN ('');
    SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
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

-- Qualified native catalogue only. The qualified role unit precedes this unit.
-- Retain exact client/cycle rows without manufacturing customer history or
-- executing live renewal admission. All constraints and other triggers remain on.
-- Privileged installation inputs select existing logins; they confer no runtime
-- authority. The restore login reaches this owner through only the two fixed routines.

DO $preflight$
DECLARE
  v_owner pg_catalog.pg_roles%ROWTYPE;
  v_restore pg_catalog.pg_roles%ROWTYPE;
  v_restore_name text := pg_catalog.current_setting('openlup.qualified.restore_login', true);
  v_runtime_name text := pg_catalog.current_setting('openlup.qualified.runtime_login', true);
  v_mode text := pg_catalog.current_setting('openlup.qualified.role_mode', true);
BEGIN
  IF NOT COALESCE(v_restore_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$', false)
    OR NOT COALESCE(v_runtime_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$', false)
    OR NOT COALESCE(v_mode IN ('installer-managed', 'operator-provisioned'), false)
    OR v_restore_name = v_runtime_name OR v_restore_name = current_user
    OR v_runtime_name = current_user
    OR v_restore_name IN ('anon', 'authenticated', 'service_role', 'platform_acquisition_owner',
      'platform_acquisition_runtime', 'openlup_retained_import_owner')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_runtime_name)
  THEN
    RAISE EXCEPTION 'retained_import_login_binding_invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_restore FROM pg_catalog.pg_roles WHERE rolname = v_restore_name;
  IF NOT FOUND OR NOT v_restore.rolcanlogin OR v_restore.rolinherit OR v_restore.rolsuper
    OR v_restore.rolcreatedb OR v_restore.rolcreaterole OR v_restore.rolreplication OR v_restore.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid = v_restore.oid OR member = v_restore.oid)
  THEN
    RAISE EXCEPTION 'retained_import_restore_role_invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_owner FROM pg_catalog.pg_roles WHERE rolname = 'openlup_retained_import_owner';
  IF NOT FOUND OR v_owner.rolcanlogin OR v_owner.rolinherit OR v_owner.rolsuper
    OR v_owner.rolcreatedb OR v_owner.rolcreaterole OR v_owner.rolreplication OR v_owner.rolbypassrls
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_owner.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
      WHERE refclassid = 'pg_catalog.pg_authid'::regclass AND refobjid = v_owner.oid AND deptype = 'o')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclrole = v_owner.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
      WHERE a.grantee = v_owner.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      WHERE a.grantee = v_owner.oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE pg_catalog.has_schema_privilege(v_owner.oid, n.oid, 'CREATE'))
    OR pg_catalog.has_database_privilege(v_owner.oid, current_database(), 'CREATE')
  THEN
    RAISE EXCEPTION 'retained_import_owner_not_sealed' USING ERRCODE = '42501';
  END IF;
END
$preflight$;

-- Temporary execution is explicit and transactional. Inherited owner privilege
-- permits the existing post-transfer ACL statements; no function body changes.
DO $qa_import_window$
BEGIN
  EXECUTE pg_catalog.format('GRANT openlup_retained_import_owner TO %I WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY %I', current_user, current_user);
END
$qa_import_window$;
GRANT CREATE ON SCHEMA public TO openlup_retained_import_owner;

CREATE FUNCTION public.client_import_retained_row(
  p_id uuid,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_country text,
  p_lifecycle_stage text,
  p_acquisition_source text,
  p_external_ref text,
  p_metadata jsonb,
  p_principal_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'retained_import_requires_origin' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.clients (
    id, created_at, updated_at, email, first_name, last_name, phone, country,
    lifecycle_stage, acquisition_source, external_ref, metadata, principal_id
  ) VALUES (
    p_id, p_created_at, p_updated_at, p_email, p_first_name, p_last_name, p_phone, p_country,
    p_lifecycle_stage, p_acquisition_source, p_external_ref, p_metadata, p_principal_id
  ) ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clients c WHERE c.id = p_id AND
      ROW(c.id, c.created_at, c.updated_at, c.email, c.first_name, c.last_name, c.phone, c.country,
        c.lifecycle_stage, c.acquisition_source, c.external_ref, c.metadata, c.principal_id)
      IS NOT DISTINCT FROM
      ROW(p_id, p_created_at, p_updated_at, p_email, p_first_name, p_last_name, p_phone, p_country,
        p_lifecycle_stage, p_acquisition_source, p_external_ref, p_metadata, p_principal_id)
  ) THEN
    RAISE EXCEPTION 'client_retained_row_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN false;
END;
$$;

CREATE FUNCTION public.subscription_cycle_import_retained_row(
  p_id uuid,
  p_subscription_id uuid,
  p_scheduled_at timestamptz,
  p_status text,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_renewal_operation_id uuid,
  p_renewal_operation_fingerprint text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'retained_import_requires_origin' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.subscription_cycles (
    id, subscription_id, scheduled_at, status, created_at, updated_at,
    renewal_operation_id, renewal_operation_fingerprint
  ) VALUES (
    p_id, p_subscription_id, p_scheduled_at, p_status, p_created_at, p_updated_at,
    p_renewal_operation_id, p_renewal_operation_fingerprint
  ) ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN
    RETURN true;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.subscription_cycles c WHERE c.id = p_id AND
      ROW(c.id, c.subscription_id, c.scheduled_at, c.status, c.created_at, c.updated_at,
        c.renewal_operation_id, c.renewal_operation_fingerprint)
      IS NOT DISTINCT FROM
      ROW(p_id, p_subscription_id, p_scheduled_at, p_status, p_created_at, p_updated_at,
        p_renewal_operation_id, p_renewal_operation_fingerprint)
  ) THEN
    RAISE EXCEPTION 'subscription_cycle_retained_row_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.client_import_retained_row(
  uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, jsonb, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.subscription_cycle_import_retained_row(
  uuid, uuid, timestamptz, text, timestamptz, timestamptz, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.client_import_retained_row(
  uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, jsonb, uuid
) OWNER TO openlup_retained_import_owner;
ALTER FUNCTION public.subscription_cycle_import_retained_row(
  uuid, uuid, timestamptz, text, timestamptz, timestamptz, uuid, text
) OWNER TO openlup_retained_import_owner;

GRANT USAGE ON SCHEMA public TO openlup_retained_import_owner;
GRANT SELECT, INSERT ON TABLE public.clients, public.subscription_cycles TO openlup_retained_import_owner;
CREATE POLICY clients_retained_import_select ON public.clients
  FOR SELECT TO openlup_retained_import_owner USING (true);
CREATE POLICY clients_retained_import_insert ON public.clients
  FOR INSERT TO openlup_retained_import_owner WITH CHECK (true);

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

DO $seal$
DECLARE
  v_owner oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'openlup_retained_import_owner');
  v_restore_name text := pg_catalog.current_setting('openlup.qualified.restore_login');
  v_runtime_name text := pg_catalog.current_setting('openlup.qualified.runtime_login');
  v_restore oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = v_restore_name);
  v_functions oid[] := ARRAY[
    'public.client_import_retained_row(uuid,timestamptz,timestamptz,text,text,text,text,text,text,text,text,jsonb,uuid)'::regprocedure::oid,
    'public.subscription_cycle_import_retained_row(uuid,uuid,timestamptz,text,timestamptz,timestamptz,uuid,text)'::regprocedure::oid
  ];
BEGIN
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.client_import_retained_row(uuid,timestamptz,timestamptz,text,text,text,text,text,text,text,text,jsonb,uuid) FROM %I', v_runtime_name);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.subscription_cycle_import_retained_row(uuid,uuid,timestamptz,text,timestamptz,timestamptz,uuid,text) FROM %I', v_runtime_name);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.client_import_retained_row(uuid,timestamptz,timestamptz,text,text,text,text,text,text,text,text,jsonb,uuid) TO %I', v_restore_name);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.subscription_cycle_import_retained_row(uuid,uuid,timestamptz,text,timestamptz,timestamptz,uuid,text) TO %I', v_restore_name);

  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM openlup_retained_import_owner';
  EXECUTE pg_catalog.format('REVOKE openlup_retained_import_owner FROM %I GRANTED BY %I', current_user, current_user);

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid = v_restore OR member IN (v_owner, v_restore))
    OR (SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner = v_owner AND oid = ANY(v_functions)) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
      WHERE refclassid = 'pg_catalog.pg_authid'::regclass AND refobjid = v_owner AND deptype = 'o'
        AND (classid <> 'pg_catalog.pg_proc'::regclass OR NOT objid = ANY(v_functions)
          OR dbid <> (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclrole = v_owner)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
      WHERE a.grantee = v_owner)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE pg_catalog.has_schema_privilege(v_owner, n.oid, 'CREATE')
        OR pg_catalog.has_schema_privilege(v_restore, n.oid, 'CREATE'))
    OR pg_catalog.has_database_privilege(v_owner, current_database(), 'CREATE')
    OR pg_catalog.has_database_privilege(v_restore, current_database(), 'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      WHERE a.grantee = v_owner AND (c.oid NOT IN ('public.clients'::regclass, 'public.subscription_cycles'::regclass)
        OR a.privilege_type NOT IN ('SELECT', 'INSERT') OR a.is_grantable))
    OR (SELECT count(*) FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      WHERE a.grantee = v_owner AND c.oid IN ('public.clients'::regclass, 'public.subscription_cycles'::regclass)
        AND a.privilege_type IN ('SELECT', 'INSERT')) <> 4
    OR pg_catalog.has_table_privilege(v_owner, 'public.clients', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_table_privilege(v_owner, 'public.subscription_cycles', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_table_privilege(v_restore, 'public.clients', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_table_privilege(v_restore, 'public.subscription_cycles', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid = ANY(v_functions) AND (a.grantee NOT IN (v_owner, v_restore) OR a.privilege_type <> 'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
      WHERE a.grantee = v_restore AND NOT p.oid = ANY(v_functions))
  THEN
    RAISE EXCEPTION 'retained_import_owner_closure_invalid' USING ERRCODE = '42501';
  END IF;
END
$seal$;

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
  FOREACH v_group IN ARRAY ARRAY['openlup_retained_import_owner'] LOOP
    v_runtime_group := v_group IN ('');
    SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
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
