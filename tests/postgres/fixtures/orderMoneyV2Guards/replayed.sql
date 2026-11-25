SELECT plan(9);
SELECT ok((SELECT prosecdef AND provolatile='s' AND prorettype='void'::regtype
  AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc
  WHERE oid='public.commerce_order_money_v2_assert(uuid,boolean,boolean,jsonb,jsonb)'::regprocedure),
  'the assertion is a stable definer with a closed search path');
SELECT ok(NOT EXISTS (SELECT FROM pg_proc p, LATERAL aclexplode(p.proacl) a
  WHERE p.oid='public.commerce_order_money_v2_assert(uuid,boolean,boolean,jsonb,jsonb)'::regprocedure
    AND (a.grantee=0 OR a.grantee<>p.proowner AND
      (a.is_grantable OR pg_get_userbyid(a.grantee) NOT IN ('authenticated','service_role')))),
  'the assertion has only its approved grantees');
SELECT ok(NOT EXISTS (
  SELECT FROM pg_roles r WHERE r.rolname IN ('authenticated','service_role')
    AND NOT has_function_privilege(r.oid,'public.commerce_order_money_v2_assert(uuid,boolean,boolean,jsonb,jsonb)','EXECUTE')),
  'existing optional writers can reach the assertion through the trigger');
SELECT ok((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=public, pg_catalog, pg_temp'] FROM pg_proc
  WHERE oid='public.commerce_order_assert_line_sum()'::regprocedure),
  'the dispatcher remains an invoker with its installed path');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgfoid='public.commerce_order_assert_line_sum()'::regprocedure
  AND tginitdeferred AND tgdeferrable AND tgenabled='O'),2,
  'the incumbent deferred header and item triggers bind the dispatcher');
SELECT lives_ok($$SELECT public.commerce_order_money_v2_assert(gen_random_uuid(),true,true)$$,
  'a direct call cannot invoke the definer assertion');
SELECT ok((SELECT NOT prosecdef AND provolatile='s' AND prorettype='jsonb'::regtype
  AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc
  WHERE oid='public.commerce_order_money_v2_live_body(uuid)'::regprocedure),
  'the live body reader is a stable invoker with a closed search path');
SELECT ok(NOT EXISTS (SELECT FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.commerce_order_money_v2_live_body(uuid)'::regprocedure AND a.grantee<>p.proowner)
  AND NOT EXISTS (SELECT FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
    AND has_function_privilege(r.oid,'public.commerce_order_money_v2_live_body(uuid)','EXECUTE')),
  'the live body reader is owner only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_%_money_v2'),
  0,'the assertion forward leaves storage trigger installation to its owner');
SELECT * FROM finish();
