-- pgTAP: row-lock serialization makes a per-customer cap exact under race.
BEGIN;
SELECT plan(7);
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect('promo_claim_a',
  'host='||host(inet_server_addr())||' port='||inet_server_port()
  ||' dbname='||current_database()||' user=postgres password=postgres');
SELECT extensions.dblink_connect('promo_claim_b',
  'host='||host(inet_server_addr())||' port='||inet_server_port()
  ||' dbname='||current_database()||' user=postgres password=postgres');

SELECT extensions.dblink_exec('promo_claim_a',$setup$
  INSERT INTO public.promotion_codes
    (id,code,name,scopes,valid_from,valid_to,status,redemption_limit_per_customer)
  VALUES ('ac400000-0000-4000-8000-000000000001','RACE-ONE','Race one',
    ARRAY['one_time'],now()-interval '1 hour',now()+interval '1 day','active',1);
  INSERT INTO public.clients(id,email) VALUES
    ('ac410000-0000-4000-8000-000000000001','promo-race@example.invalid');
  INSERT INTO public.commerce_orders
    (id,client_id,order_number,status,currency,subtotal_cents,discount_cents,shipping_cents,
     shipping_discount_cents,tax_cents,total_cents)
  VALUES
    ('ac500000-0000-4000-8000-000000000001','ac410000-0000-4000-8000-000000000001','PROMO-RACE-1','draft','PLN',1000,0,0,0,0,1000),
    ('ac500000-0000-4000-8000-000000000002','ac410000-0000-4000-8000-000000000001','PROMO-RACE-2','draft','PLN',1000,0,0,0,0,1000);
  CREATE OR REPLACE FUNCTION public.pgtap_try_promotion_claim(p_order uuid,p_delay numeric)
  RETURNS text LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM public.commerce_promotion_code_claim(
      'ac400000-0000-4000-8000-000000000001',p_order,now()+interval '1 hour');
    PERFORM pg_sleep(p_delay); RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
  END $fn$;
$setup$);

SELECT extensions.dblink_send_query('promo_claim_a',
  $q$SELECT public.pgtap_try_promotion_claim('ac500000-0000-4000-8000-000000000001',0.30)$q$);
SELECT pg_sleep(0.03);
SELECT extensions.dblink_send_query('promo_claim_b',
  $q$SELECT public.pgtap_try_promotion_claim('ac500000-0000-4000-8000-000000000002',0)$q$);
SELECT pg_sleep(0.03);
SELECT is(extensions.dblink_is_busy('promo_claim_b'),1,
  'second claim waits on the promotion-code capacity lock');
SELECT is((SELECT outcome FROM extensions.dblink_get_result('promo_claim_a') AS r(outcome text)),
  'ok','first concurrent claimant succeeds');
SELECT count(*) FROM extensions.dblink_get_result('promo_claim_a') AS drained(outcome text);
SELECT is((SELECT outcome FROM extensions.dblink_get_result('promo_claim_b') AS r(outcome text)),
  'promotion_code_customer_limit_reached','second concurrent claimant loses deterministically');
SELECT count(*) FROM extensions.dblink_get_result('promo_claim_b') AS drained(outcome text);
SELECT is((SELECT count(*)::int FROM public.promotion_code_claims
  WHERE promotion_code_id='ac400000-0000-4000-8000-000000000001'
    AND status IN ('reserved','redeemed')),1,'cap one has exactly one capacity-consuming claim');

SELECT extensions.dblink_exec('promo_claim_a',$setup$
  INSERT INTO public.admin_users (id,email,role,is_machine_actor) VALUES
    ('ac420000-0000-4000-8000-000000000001','promo-lock-admin@example.invalid','admin',false);
  INSERT INTO public.promotions (
    id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status
  ) VALUES (
    'ac430000-0000-4000-8000-000000000001','LOCK-ORDER','Lock order',
    'coupon_code','percentage',10,'order_total','active'
  );
  CREATE OR REPLACE FUNCTION public.pgtap_update_legacy_promotion(p_delay numeric)
  RETURNS text LANGUAGE plpgsql AS $fn$
  BEGIN
    UPDATE public.promotions SET status='paused'
    WHERE id='ac430000-0000-4000-8000-000000000001';
    PERFORM pg_sleep(p_delay);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
  END $fn$;
  CREATE OR REPLACE FUNCTION public.pgtap_update_admin_promotion()
  RETURNS text LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM public.admin_promotion_code_update(
      'ac420000-0000-4000-8000-000000000001',
      (SELECT pc.id FROM public.promotion_codes pc WHERE pc.code_normalized='LOCK-ORDER'),
      1,'{"status":"archived"}'::jsonb,
      'ac420000-0000-4000-8000-000000000010','lock-order-fingerprint','pgtap');
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
  END $fn$;
$setup$);

SELECT extensions.dblink_send_query('promo_claim_a',
  $q$SELECT public.pgtap_update_legacy_promotion(0.30)$q$);
SELECT pg_sleep(0.03);
SELECT extensions.dblink_send_query('promo_claim_b',
  $q$SELECT public.pgtap_update_admin_promotion()$q$);
SELECT pg_sleep(0.03);
SELECT is(extensions.dblink_is_busy('promo_claim_b'),1,
  'admin update waits behind the legacy promotion lock in canonical order');
SELECT is((SELECT outcome FROM extensions.dblink_get_result('promo_claim_a') AS r(outcome text)),
  'ok','legacy update completes without a promotion/code deadlock');
SELECT count(*) FROM extensions.dblink_get_result('promo_claim_a') AS drained(outcome text);
SELECT is((SELECT outcome FROM extensions.dblink_get_result('promo_claim_b') AS r(outcome text)),
  'promotion_code_revision_conflict',
  'waiting admin update exits as an optimistic conflict rather than a deadlock');
SELECT count(*) FROM extensions.dblink_get_result('promo_claim_b') AS drained(outcome text);

SELECT extensions.dblink_exec('promo_claim_a',$cleanup$
  DROP FUNCTION public.pgtap_try_promotion_claim(uuid,numeric);
  DROP FUNCTION public.pgtap_update_legacy_promotion(numeric);
  DROP FUNCTION public.pgtap_update_admin_promotion();
  DELETE FROM public.promotion_code_bindings
    WHERE promotion_id='ac430000-0000-4000-8000-000000000001';
  DELETE FROM public.promotion_codes WHERE code_normalized='LOCK-ORDER';
  DELETE FROM public.promotions WHERE id='ac430000-0000-4000-8000-000000000001';
  DELETE FROM public.admin_audit_events
    WHERE actor_admin_id='ac420000-0000-4000-8000-000000000001'
       OR target_admin_id='ac420000-0000-4000-8000-000000000001';
  -- dblink commits outside this file's wrapping transaction. Remove the
  -- technical actor explicitly so repeated pgTAP runs remain isolated.
  ALTER TABLE public.admin_users
    DISABLE TRIGGER trg_admin_users_prevent_last_admin_lockout;
  DELETE FROM public.admin_users
    WHERE id='ac420000-0000-4000-8000-000000000001';
  ALTER TABLE public.admin_users
    ENABLE TRIGGER trg_admin_users_prevent_last_admin_lockout;
  DELETE FROM public.promotion_code_claims
    WHERE promotion_code_id='ac400000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_orders
    WHERE id IN ('ac500000-0000-4000-8000-000000000001','ac500000-0000-4000-8000-000000000002');
  DELETE FROM public.promotion_codes WHERE id='ac400000-0000-4000-8000-000000000001';
  DELETE FROM public.clients WHERE id='ac410000-0000-4000-8000-000000000001';
$cleanup$);
SELECT extensions.dblink_disconnect('promo_claim_a');
SELECT extensions.dblink_disconnect('promo_claim_b');
SELECT * FROM finish();
ROLLBACK;
