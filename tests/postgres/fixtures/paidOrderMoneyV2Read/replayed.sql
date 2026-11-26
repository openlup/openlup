SELECT plan(5);
SELECT ok((SELECT p.prosecdef AND p.provolatile='s' AND p.prorettype='jsonb'::regtype
    AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND l.lanname='plpgsql'
  FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure('public.commerce_read_paid_order_money_v2(uuid)')),
  'the reader is a stable JSONB definer with a closed search path');
SELECT is((SELECT p.proowner FROM pg_proc p
  WHERE p.oid=to_regprocedure('public.commerce_read_paid_order_money_v2(uuid)')),
  (SELECT oid FROM pg_roles WHERE rolname=current_user), 'the migration owner owns the reader');
SELECT results_eq($$
  SELECT p.oid,p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)),p.proowner,p.proacl::text
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.oid IS DISTINCT FROM to_regprocedure('public.commerce_read_paid_order_money_v2(uuid)')
  ORDER BY 1
$$, 'SELECT * FROM reader_predecessor_functions ORDER BY 1',
  'the sole new function leaves predecessor definitions and ACLs intact');
SELECT results_eq($$
  SELECT a.grantee,a.privilege_type,a.grantor,a.is_grantable
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
  WHERE p.oid=to_regprocedure('public.commerce_read_paid_order_money_v2(uuid)')
  ORDER BY 1
$$, $$
  SELECT oid,'EXECUTE'::text,(SELECT oid FROM pg_roles WHERE rolname=current_user),false
  FROM pg_roles WHERE rolname IN (current_user,'service_role') ORDER BY 1
$$, 'only the owner and a present service role receive EXECUTE');
SELECT lives_ok($$SELECT public.commerce_read_paid_order_money_v2(gen_random_uuid())$$,
  'the migration owner can execute the reader');
SELECT * FROM finish();
