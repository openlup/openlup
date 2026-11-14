BEGIN;
SELECT plan(8);
SELECT ok(NOT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='public.communication_event_prepare_erasure()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'), 'PUBLIC cannot prepare event erasure');
SELECT ok(NOT has_function_privilege('anon','public.communication_event_prepare_erasure()','EXECUTE'), 'anon cannot prepare event erasure');
SELECT ok(NOT has_function_privilege('authenticated','public.communication_event_prepare_erasure()','EXECUTE'), 'authenticated cannot prepare event erasure');
SELECT ok(has_function_privilege('service_role','public.communication_event_prepare_erasure()','EXECUTE'), 'service role can prepare event erasure');
SELECT ok(prosecdef, 'preparation executes with owner authority') FROM pg_proc WHERE oid='public.communication_event_prepare_erasure()'::regprocedure;
SELECT is(proconfig,ARRAY['search_path=pg_catalog, pg_temp'], 'preparation pins its search path') FROM pg_proc WHERE oid='public.communication_event_prepare_erasure()'::regprocedure;
SELECT is(prorettype,'jsonb'::regtype::oid, 'preparation retains the existing jsonb return shape') FROM pg_proc WHERE oid='public.communication_event_prepare_erasure()'::regprocedure;
SELECT is(btrim(prosrc,E' \n\t\r'), 'BEGIN LOCK TABLE public.communication_event_receipts IN SHARE ROW EXCLUSIVE MODE; RETURN ''true''; END;', 'preparation only locks receipts and returns true') FROM pg_proc WHERE oid='public.communication_event_prepare_erasure()'::regprocedure;
SELECT * FROM finish();
ROLLBACK;
