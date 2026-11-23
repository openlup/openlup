DO $$
DECLARE
  checkout_login pg_catalog.pg_roles%ROWTYPE;
  granted_count integer;
  routine record;
  acl record;
  routine_grants integer;
  owner_grants integer;
BEGIN
  IF EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
    WHERE position OPERATOR(pg_catalog.=) 0
      AND catalog_path OPERATOR(pg_catalog.=) 'db/platform/migrations/00000000000000_platform_baseline.sql'
      AND sha256 OPERATOR(pg_catalog.=) '0cd9444498f6386bd39b214440a75fa7f272ab1b65c3b62807717ee28b4c7933') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
    WHERE position OPERATOR(pg_catalog.=) 0 AND (
      (catalog_path OPERATOR(pg_catalog.=) 'db/platform/migrations/q2_00000000000000_platform_baseline.sql' AND sha256 OPERATOR(pg_catalog.=) '679f46e8eee66b70ff7664b300174b4c105a4f43de9449c26391da01cc1f9863')
      OR (catalog_path OPERATOR(pg_catalog.=) 'db/platform/migrations/qa_00000000000000_platform_baseline.sql' AND sha256 OPERATOR(pg_catalog.=) 'a19f78b5e948f96d5bdca6cc14159230cf5197c5ff7fe94f7fc10f26e585a710'))) THEN
    RAISE EXCEPTION 'checkout_owner_rail_unverified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
    WHERE position OPERATOR(pg_catalog.>) 0
      AND catalog_path OPERATOR(pg_catalog.=) 'db/platform/migrations/20261125010000_catalog_purchase_admission.sql'
      AND sha256 OPERATOR(pg_catalog.=) '700aab2616bff9c6049eb83af4efcea8596f36862a0de4c1dde1bca6647282a4') THEN
    RAISE EXCEPTION 'checkout_owner_predecessor_unverified';
  END IF;
  SELECT * INTO checkout_login FROM pg_catalog.pg_roles
    WHERE rolname OPERATOR(pg_catalog.=) 'openlup_checkout_owner';
  granted_count := 0;
  FOR routine IN SELECT target.signature, p.* FROM pg_catalog.unnest(
    ARRAY['public.catalog_admission_lock_shared()', 'public.catalog_admission_lock_checkout_price(uuid,uuid[])', 'public.catalog_admission_create_order_draft(text,jsonb,jsonb,uuid,jsonb)']
  ) target(signature) LEFT JOIN pg_catalog.pg_proc p
    ON p.oid OPERATOR(pg_catalog.=) pg_catalog.to_regprocedure(target.signature) LOOP
    IF routine.oid IS NULL OR routine.prokind OPERATOR(pg_catalog.<>) 'f'
      OR pg_catalog.pg_get_userbyid(routine.proowner) OPERATOR(pg_catalog.<>) current_user
      OR NOT routine.prosecdef OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
      THEN RAISE EXCEPTION 'checkout_owner_predecessor_unverified';
    END IF;
    routine_grants := 0;
    owner_grants := 0;
    FOR acl IN SELECT * FROM pg_catalog.aclexplode(routine.proacl) LOOP
      IF acl.grantor OPERATOR(pg_catalog.<>) routine.proowner
        OR acl.privilege_type OPERATOR(pg_catalog.<>) 'EXECUTE' OR acl.is_grantable
        THEN RAISE EXCEPTION 'checkout_owner_acl_mismatch';
      END IF;
      IF acl.grantee OPERATOR(pg_catalog.=) routine.proowner THEN
        owner_grants := owner_grants + 1;
      ELSIF acl.grantee OPERATOR(pg_catalog.=) checkout_login.oid THEN
        routine_grants := routine_grants + 1;
      ELSE RAISE EXCEPTION 'checkout_owner_acl_mismatch';
      END IF;
    END LOOP;
    IF owner_grants OPERATOR(pg_catalog.<>) 1 OR routine_grants OPERATOR(pg_catalog.>) 1
      THEN RAISE EXCEPTION 'checkout_owner_acl_mismatch';
    END IF;
    granted_count := granted_count + routine_grants;
  END LOOP;
  IF granted_count OPERATOR(pg_catalog.<>) ALL (ARRAY[0,3]) THEN
    RAISE EXCEPTION 'checkout_owner_acl_mismatch';
  END IF;
  IF checkout_login.oid IS NULL THEN RETURN; END IF;
  IF NOT checkout_login.rolcanlogin OR checkout_login.rolinherit OR checkout_login.rolsuper
    OR checkout_login.rolcreatedb OR checkout_login.rolcreaterole OR checkout_login.rolreplication
    OR checkout_login.rolbypassrls OR checkout_login.rolconnlimit OPERATOR(pg_catalog.<>) -1
    OR checkout_login.rolvaliduntil IS NOT NULL THEN RAISE EXCEPTION 'checkout_owner_login_unready';
  END IF;
  IF granted_count OPERATOR(pg_catalog.=) 3 THEN RETURN; END IF;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_lock_shared(),
    public.catalog_admission_lock_checkout_price(uuid,uuid[]),
    public.catalog_admission_create_order_draft(text,jsonb,jsonb,uuid,jsonb) TO openlup_checkout_owner;';
END; $$;
