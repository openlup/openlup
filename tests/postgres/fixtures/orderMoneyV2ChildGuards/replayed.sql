SELECT plan(4);

SELECT ok((SELECT provolatile='v' AND NOT prosecdef AND prorettype='trigger'::regtype
  AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']
  FROM pg_proc WHERE oid='public.commerce_order_money_v2_child_guard()'::regprocedure),
  'guard is a volatile invoker with the exact private search path');

SELECT ok((SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND NOT EXISTS (SELECT FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) WHERE grantee<>proowner)
  AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')
    AND has_function_privilege(pg_roles.oid,pg_proc.oid,'EXECUTE'))
  FROM pg_proc WHERE oid='public.commerce_order_money_v2_child_guard()'::regprocedure),
  'guard has owner-only execute');

SELECT set_eq(
  $$SELECT c.relname::text,t.tgname::text,t.tgtype::integer,t.tgdeferrable,t.tginitdeferred,t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgfoid='public.commerce_order_money_v2_child_guard()'::regprocedure$$,
  $$VALUES
    ('commerce_order_tax_snapshots','trg_commerce_order_tax_snapshots_money_v2',29,true,true,'O'),
    ('commerce_order_line_sources','trg_commerce_order_line_sources_money_v2',29,true,true,'O'),
    ('commerce_order_delivery_buckets','trg_commerce_order_delivery_buckets_money_v2',29,true,true,'O'),
    ('commerce_order_line_allocations','trg_commerce_order_line_allocations_money_v2',29,true,true,'O'),
    ('commerce_order_tax_positions','trg_commerce_order_tax_positions_money_v2',29,true,true,'O'),
    ('commerce_order_fee_lines','trg_commerce_order_fee_lines_money_v2',29,true,true,'O'),
    ('commerce_order_adjustments','trg_commerce_order_adjustments_money_v2',5,true,true,'O')$$,
  'guard has the exact seven deferred bindings');

SELECT ok((SELECT count(*)=2 AND bool_and(tgdeferrable AND tginitdeferred AND tgenabled='O')
  FROM pg_trigger WHERE tgfoid='public.commerce_order_assert_line_sum()'::regprocedure
    AND tgname IN ('trg_commerce_orders_line_sum','trg_commerce_order_items_line_sum')),
  'the incumbent deferred line-sum triggers remain enabled');

SELECT * FROM finish();
