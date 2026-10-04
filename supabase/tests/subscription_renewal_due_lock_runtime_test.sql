-- pgTAP: actual service-role renewal selection preserves concurrent row locking.
-- Owner builds committed fixtures; all renewal calls and refusals use actual service_role.
-- dblink follows the existing subscription_payment_lock_order_test.sql owned-test seam.
BEGIN;
SELECT plan(8);
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect('renewal_lock_a',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
  || ' dbname=' || current_database() || ' user=postgres password=postgres');
SELECT extensions.dblink_connect('renewal_lock_b',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
  || ' dbname=' || current_database() || ' user=postgres password=postgres');
-- Existing runner's fixed disposable password; no linked/remote database.
SELECT extensions.dblink_exec('renewal_lock_a', $cleanup$
DELETE FROM public.subscription_events WHERE subscription_id::text LIKE 'b7500000-%';
DELETE FROM public.outbox_events WHERE aggregate_id IN ('b7500000-0000-4000-8000-000000000001','b7500000-0000-4000-8000-000000000002');
DELETE FROM public.subscription_cycles WHERE id='b7600000-0000-4000-8000-000000000001';
DELETE FROM public.subscriptions WHERE id::text LIKE 'b7500000-%';
DELETE FROM public.clients WHERE id::text LIKE 'b7400000-%';
$cleanup$);
SELECT extensions.dblink_exec('renewal_lock_a', $setup$
INSERT INTO public.clients(id,email) VALUES
 ('b7400000-0000-4000-8000-000000000001','renewal-lock-normal@example.invalid'),
 ('b7400000-0000-4000-8000-000000000002','renewal-lock-retry@example.invalid');
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,next_cycle_at) VALUES
 ('b7500000-0000-4000-8000-000000000001','b7400000-0000-4000-8000-000000000001',28,'PLN','active','2000-01-01'),
 ('b7500000-0000-4000-8000-000000000002','b7400000-0000-4000-8000-000000000002',28,'PLN','active','2100-01-01');
INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key,retry_attempt,next_retry_at) VALUES
 ('b7600000-0000-4000-8000-000000000001','b7500000-0000-4000-8000-000000000002',2,'2000-01-01','retry_scheduled','renewal-lock-retry',1,'2000-01-01');
$setup$);
SELECT extensions.dblink_exec('renewal_lock_a','BEGIN; SET LOCAL lock_timeout = ''2s''; SET LOCAL statement_timeout = ''10s''; SET LOCAL ROLE service_role');
SELECT extensions.dblink_exec('renewal_lock_b','BEGIN; SET LOCAL lock_timeout = ''2s''; SET LOCAL statement_timeout = ''10s''; SET LOCAL ROLE service_role');
SELECT is((SELECT role_name FROM extensions.dblink('renewal_lock_a','SELECT current_user::text') AS r(role_name text)),
 'service_role', 'first renewal connection uses actual service_role');
SELECT is((SELECT role_name FROM extensions.dblink('renewal_lock_b','SELECT current_user::text') AS r(role_name text)),
 'service_role', 'second renewal connection uses actual service_role');
SELECT is((SELECT count(*)::integer FROM extensions.dblink('renewal_lock_a',
 $q$SELECT subscription_id FROM public.subscription_list_due_for_renewal(500,'2000-01-02') WHERE subscription_id::text LIKE 'b7500000-%'$q$) AS r(id uuid)),
 2,'first service selector locks both normal and retry rows');
SELECT is((SELECT count(*)::integer FROM extensions.dblink('renewal_lock_b',
 $q$SELECT subscription_id FROM public.subscription_list_due_for_renewal(500,'2000-01-02') WHERE subscription_id::text LIKE 'b7500000-%'$q$) AS r(id uuid)),
 0,'second service selector skips both rows while first transaction owns locks');
SELECT extensions.dblink_exec('renewal_lock_a','ROLLBACK');
SELECT is((SELECT count(*)::integer FROM extensions.dblink('renewal_lock_b',
 $q$SELECT subscription_id FROM public.subscription_list_due_for_renewal(500,'2000-01-02') WHERE subscription_id::text LIKE 'b7500000-%'$q$) AS r(id uuid)),
 2,'released normal and retry rows become eligible again');
SELECT extensions.dblink_exec('renewal_lock_b','ROLLBACK');
SAVEPOINT raw_write;
SET LOCAL ROLE service_role;
SELECT lives_ok($q$UPDATE public.subscriptions SET updated_at=updated_at WHERE id='b7500000-0000-4000-8000-000000000001'$q$,
 'column grant really permits raw updated_at mutation, not just locking');
SELECT throws_ok($q$UPDATE public.subscriptions SET status='paused' WHERE id='b7500000-0000-4000-8000-000000000001'$q$,
 '42501',NULL,'service cannot use locking admission to write status');
SELECT throws_ok($q$UPDATE public.subscriptions SET next_cycle_at='2100-01-01' WHERE id='b7500000-0000-4000-8000-000000000001'$q$,
 '42501',NULL,'service cannot use locking admission to write renewal schedule');
RESET ROLE;
-- Release the raw-write witness lock before committed remote cleanup.
ROLLBACK TO SAVEPOINT raw_write;
SELECT extensions.dblink_exec('renewal_lock_a', $cleanup$
DELETE FROM public.subscription_events WHERE subscription_id::text LIKE 'b7500000-%';
DELETE FROM public.outbox_events WHERE aggregate_id IN ('b7500000-0000-4000-8000-000000000001','b7500000-0000-4000-8000-000000000002');
DELETE FROM public.subscription_cycles WHERE id='b7600000-0000-4000-8000-000000000001';
DELETE FROM public.subscriptions WHERE id::text LIKE 'b7500000-%';
DELETE FROM public.clients WHERE id::text LIKE 'b7400000-%';
$cleanup$);
SELECT extensions.dblink_disconnect('renewal_lock_a');
SELECT extensions.dblink_disconnect('renewal_lock_b');
SELECT * FROM finish();
ROLLBACK;
