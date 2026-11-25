SELECT plan(8);
SELECT has_function('public','payment_read_capture_time',ARRAY['uuid','uuid'],'exact selector signature');
SELECT is(
  pg_get_function_result('public.payment_read_capture_time(uuid,uuid)'::regprocedure),
  'TABLE(kind text, code text, order_id uuid, intent_id uuid, evidence_id uuid, truth_id uuid, settlement_transition_id uuid, provider text, payment_mode text, route text, captured_at timestamp with time zone, fallback_at timestamp with time zone, truth_occurred_at timestamp with time zone, observed_at timestamp with time zone, db_acknowledged_at timestamp with time zone, provider_occurred_at timestamp with time zone)',
  'exact result columns and types');
SELECT ok((SELECT p.provolatile='s' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
  AND pg_get_userbyid(p.proowner)=current_user
  FROM pg_proc p WHERE p.oid='public.payment_read_capture_time(uuid,uuid)'::regprocedure),
  'migration owner stable definer with pinned search path');
SELECT is_empty($q$SELECT a.grantee FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.payment_read_capture_time(uuid,uuid)'::regprocedure AND a.grantee<>p.proowner$q$,
  'reader execution is owner-only');
SELECT has_table('public','payment_capture_time_test_qualification','has the local qualification relation');
SELECT is_empty($q$SELECT a.grantee FROM pg_class c, aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='public.payment_capture_time_test_qualification'::regclass AND a.grantee<>c.relowner$q$,
  'qualification table ACL is owner-only');
SELECT is_empty($q$SELECT * FROM public.payment_capture_time_test_qualification$q$,'forward leaves qualification empty');
SELECT throws_ok($q$INSERT INTO public.payment_capture_time_test_qualification(singleton,qualified_at) VALUES(false,now())$q$,
  '23514',NULL,'qualification key is checked');
SELECT * FROM finish();
