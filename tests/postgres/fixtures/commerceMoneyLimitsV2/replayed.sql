SELECT plan(8);
SELECT is((SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE oid='public.commerce_money_limits_v2'::regclass),
  current_user::text, 'migration owner owns the relation');
SELECT ok((SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid='public.commerce_money_limits_v2'::regclass)
  AND NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='public.commerce_money_limits_v2'::regclass), 'private relation has non-FORCE RLS and zero policies');
SELECT ok(NOT EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') AND
  (has_table_privilege(oid,'public.commerce_money_limits_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(oid,'public.commerce_money_limits_v2','SELECT,INSERT,UPDATE,REFERENCES'))),
  'application roles have zero effective table and column access');
SELECT ok(NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid='public.commerce_money_limits_v2'::regclass AND attacl IS NOT NULL), 'there are no column grants');
SELECT ok(NOT EXISTS(
  SELECT FROM (VALUES
    ('public.commerce_money_limits_v2_validate(jsonb)', '{p_document}'::text[], 'jsonb', 'jsonb'::regtype, false, 's', false),
    ('public.commerce_money_limits_read_v2(text,text,text,text,text,text,text)',
      '{p_installation_ref,p_channel_key,p_method_key,p_provider_key,p_account_ref,p_mode,p_currency}'::text[],
      'text, text, text, text, text, text, text', 'public.commerce_money_limits_v2'::regtype, true, 's', true),
    ('public.commerce_money_limits_v2_guard()', NULL::text[], '', 'trigger'::regtype, false, 'v', false)
  ) e(signature, names, types, result, returns_set, volatility, definer)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
  WHERE (p.proargnames, oidvectortypes(p.proargtypes), p.prorettype::regtype, p.proretset, p.provolatile::text,
         p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.prolang, p.prokind::text)
    IS DISTINCT FROM (e.names,e.types,e.result,e.returns_set,e.volatility,
         e.definer,ARRAY['search_path=pg_catalog, pg_temp'],current_user::name,
         (SELECT oid FROM pg_language WHERE lanname='plpgsql'),'f')
), 'the exact three routine headers and attributes are installed');
SELECT is((SELECT count(*) FROM pg_trigger WHERE tgrelid='public.commerce_money_limits_v2'::regclass
  AND NOT tgisinternal AND tgtype=27 AND tgenabled='O' AND tgname='commerce_money_limits_v2_guard'
  AND tgfoid='public.commerce_money_limits_v2_guard()'::regprocedure), 1::bigint, 'the guard runs before row update or delete');
WITH routines AS (
  SELECT p.oid,p.proname,p.proowner,p.proacl FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('commerce_money_limits_v2_validate','commerce_money_limits_read_v2','commerce_money_limits_v2_guard')
), actual AS (
  SELECT r.oid,a.* FROM routines r CROSS JOIN LATERAL aclexplode(coalesce(r.proacl,acldefault('f',r.proowner))) a
), expected AS (
  SELECT r.oid,a.* FROM routines r CROSS JOIN pg_proc control
    CROSS JOIN LATERAL aclexplode(coalesce(control.proacl,acldefault('f',control.proowner))) a
    WHERE control.oid='public.money_limits_acl_control()'::regprocedure
  UNION ALL
  SELECT r.oid,r.proowner,service.oid,'EXECUTE',false
    FROM routines r CROSS JOIN pg_roles service
    WHERE r.proname='commerce_money_limits_read_v2' AND service.rolname='service_role'
)
SELECT ok(NOT EXISTS(
  (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected) UNION ALL
  (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
), 'routine ACLs match the administrative default and scoped reader grant');
SELECT ok(NOT EXISTS(SELECT FROM pg_roles r CROSS JOIN pg_proc p
  WHERE r.rolname IN ('anon','authenticated','service_role') AND p.pronamespace='public'::regnamespace
    AND p.proname IN ('commerce_money_limits_v2_validate','commerce_money_limits_read_v2','commerce_money_limits_v2_guard')
    AND has_function_privilege(r.oid,p.oid,'EXECUTE') IS DISTINCT FROM
      (r.rolname='service_role' AND p.proname='commerce_money_limits_read_v2')), 'only service_role can execute the reader');
SELECT * FROM finish();
