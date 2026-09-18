-- pgTAP: checkout money mutations share subscription -> order -> intent ->
-- attempt -> evidence/payment/cycle lock order and preserve winner semantics.
BEGIN;
SELECT plan(36);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'checkout_global_lock_actor',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'checkout_global_lock_peer',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

SELECT extensions.dblink_exec('checkout_global_lock_actor', $cleanup$
DO $do$
DECLARE
  v_payment_ids uuid[];
BEGIN
  DELETE FROM public.commerce_order_operations
   WHERE order_id::text LIKE 'fc200000-0000-4000-8000-%';
  DELETE FROM public.subscription_events
   WHERE subscription_id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.outbox_events
   WHERE aggregate_id::text LIKE 'fc200000-0000-4000-8000-%'
      OR aggregate_id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.commerce_checkout_recovery_tokens
   WHERE order_id::text LIKE 'fc200000-0000-4000-8000-%';
  DELETE FROM public.inbound_provider_events
   WHERE provider_event_id LIKE 'checkout-global-lock-%';
  DELETE FROM public.commerce_payment_state_transitions
   WHERE payment_intent_id::text LIKE 'fc400000-0000-4000-8000-%';
  DELETE FROM public.commerce_payment_reconciliation_runs
   WHERE idempotency_key LIKE 'checkout-global-lock-%';
  DELETE FROM public.commerce_idempotency_keys
   WHERE idempotency_key LIKE 'checkout-global-lock-%';
  UPDATE public.commerce_payment_intents
     SET active_attempt_id = NULL
   WHERE id::text LIKE 'fc400000-0000-4000-8000-%';
  DELETE FROM public.commerce_payment_attempts
   WHERE id::text LIKE 'fc500000-0000-4000-8000-%';
  DELETE FROM public.commerce_payment_intents
   WHERE id::text LIKE 'fc400000-0000-4000-8000-%';
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_payment_ids FROM public.commerce_payments
   WHERE id::text LIKE 'fc300000-0000-4000-8000-%';
  DELETE FROM public.commerce_payments WHERE id = ANY(v_payment_ids);
  DELETE FROM public.commerce_orders
   WHERE id::text LIKE 'fc200000-0000-4000-8000-%';
  DELETE FROM public.subscription_cycles
   WHERE subscription_id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.subscriptions
   WHERE id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.clients
   WHERE id = 'fc100000-0000-4000-8000-000000000001';
END
$do$;
$cleanup$);

SELECT extensions.dblink_exec('checkout_global_lock_actor', $setup$
INSERT INTO public.clients (id, email)
VALUES ('fc100000-0000-4000-8000-000000000001', 'checkout-global-lock@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) VALUES (
  'fc700000-0000-4000-8000-000000000001',
  'fc100000-0000-4000-8000-000000000001',
  28, 'XTS', 'pending_activation', now(), now() + interval '28 days'
);
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  created_at
) VALUES (
  'fc700000-0000-4000-8000-000000000002',
  'fc100000-0000-4000-8000-000000000001',
  28, 'XTS', 'pending_activation', now(), now() + interval '28 days',
  '2020-06-01T00:00:00Z'
);
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  created_at
) VALUES (
  'fc700000-0000-4000-8000-000000000003',
  'fc100000-0000-4000-8000-000000000001',
  28, 'XTS', 'pending_activation', now(), now() + interval '28 days',
  '2019-06-01T00:00:00Z'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'fc710000-0000-4000-8000-000000000001',
  'fc700000-0000-4000-8000-000000000001',
  1, now(), 'planned', 'checkout-global-lock-cycle', 0
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'fc710000-0000-4000-8000-000000000002',
  'fc700000-0000-4000-8000-000000000002',
  1, now(), 'planned', 'checkout-global-lock-sweep-cycle', 0
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'fc710000-0000-4000-8000-000000000003',
  'fc700000-0000-4000-8000-000000000003',
  1, now(), 'planned', 'checkout-global-lock-prepare-cycle', 0
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id,
  subscription_cycle_id, metadata
)
SELECT
  ('fc200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'fc100000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"unit_count","value":1}', 'pending_payment',
  100, 100, CASE WHEN n = 3 THEN 'subscription_cycle' ELSE 'one_time' END,
  CASE WHEN n = 3 THEN 'fc700000-0000-4000-8000-000000000001'::uuid END,
  CASE WHEN n = 3 THEN 'fc710000-0000-4000-8000-000000000001'::uuid END,
  jsonb_build_object('runtimeFinalize', jsonb_build_object(
    'source', 'commerce.runtime.hidden.v0',
    'checkoutKind', CASE WHEN n = 3 THEN 'subscription_initial' ELSE 'one_time' END
  ))
FROM generate_series(1, 5) n;
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id,
  subscription_cycle_id, metadata
)
SELECT
  'fc200000-0000-4000-8000-000000000006', client_id, currency,
  region_code, size_constraint, 'pending_payment', total_cents, subtotal_cents,
  'subscription_cycle', 'fc700000-0000-4000-8000-000000000002',
  'fc710000-0000-4000-8000-000000000002', metadata
  FROM public.commerce_orders
 WHERE id='fc200000-0000-4000-8000-000000000003';
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id,
  subscription_cycle_id, metadata
)
SELECT
  'fc200000-0000-4000-8000-000000000007', client_id, currency,
  region_code, size_constraint, 'pending_payment', total_cents, subtotal_cents,
  'subscription_cycle', 'fc700000-0000-4000-8000-000000000003',
  'fc710000-0000-4000-8000-000000000003', metadata
  FROM public.commerce_orders
 WHERE id='fc200000-0000-4000-8000-000000000003';
UPDATE public.subscription_cycles
   SET order_id = 'fc200000-0000-4000-8000-000000000003'
 WHERE id = 'fc710000-0000-4000-8000-000000000001';
UPDATE public.subscription_cycles
   SET order_id = 'fc200000-0000-4000-8000-000000000006'
 WHERE id = 'fc710000-0000-4000-8000-000000000002';
UPDATE public.subscription_cycles
   SET order_id = 'fc200000-0000-4000-8000-000000000007'
 WHERE id = 'fc710000-0000-4000-8000-000000000003';

INSERT INTO public.commerce_payments (
  id, order_id, provider, status, amount_cents, currency
)
SELECT
  ('fc300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('fc200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  CASE WHEN n = 2 THEN 'tpay' ELSE 'stripe' END,
  CASE WHEN n IN (4, 5) THEN 'failed' ELSE 'pending' END,
  100, 'XTS'
FROM generate_series(1, 5) n;
INSERT INTO public.commerce_payments (
  id, order_id, provider, status, amount_cents, currency
)
SELECT 'fc300000-0000-4000-8000-000000000006',
       'fc200000-0000-4000-8000-000000000006', provider, 'pending',
       amount_cents, currency
  FROM public.commerce_payments
 WHERE id='fc300000-0000-4000-8000-000000000003';
INSERT INTO public.commerce_payments (
  id, order_id, provider, status, amount_cents, currency
)
SELECT 'fc300000-0000-4000-8000-000000000007',
       'fc200000-0000-4000-8000-000000000007', provider, 'pending',
       amount_cents, currency
  FROM public.commerce_payments
 WHERE id='fc300000-0000-4000-8000-000000000003';

INSERT INTO public.commerce_payment_intents (
  id, order_id, target_kind, subscription_id, subscription_cycle_id,
  payment_id, status, amount_cents, currency, active_attempt_id, metadata
)
SELECT
  ('fc400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('fc200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  CASE WHEN n = 3 THEN 'subscription_cycle' ELSE 'one_time_order' END,
  CASE WHEN n = 3 THEN 'fc700000-0000-4000-8000-000000000001'::uuid END,
  CASE WHEN n = 3 THEN 'fc710000-0000-4000-8000-000000000001'::uuid END,
  ('fc300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  CASE WHEN n = 1 THEN 'processing' WHEN n IN (2, 3) THEN 'requires_action' ELSE 'failed' END,
  100, 'XTS', NULL,
  jsonb_build_object('checkoutKind', CASE WHEN n = 3 THEN 'subscription_initial' ELSE 'one_time' END)
FROM generate_series(1, 5) n;
INSERT INTO public.commerce_payment_intents (
  id, order_id, target_kind, subscription_id, subscription_cycle_id,
  payment_id, status, amount_cents, currency, active_attempt_id, metadata
)
SELECT 'fc400000-0000-4000-8000-000000000006',
       'fc200000-0000-4000-8000-000000000006', 'subscription_cycle',
       'fc700000-0000-4000-8000-000000000002',
       'fc710000-0000-4000-8000-000000000002',
       'fc300000-0000-4000-8000-000000000006', 'created', amount_cents,
       currency, NULL, metadata
  FROM public.commerce_payment_intents
 WHERE id='fc400000-0000-4000-8000-000000000003';
INSERT INTO public.commerce_payment_intents (
  id, order_id, target_kind, subscription_id, subscription_cycle_id,
  payment_id, status, amount_cents, currency, active_attempt_id, metadata
)
SELECT 'fc400000-0000-4000-8000-000000000007',
       'fc200000-0000-4000-8000-000000000007', 'subscription_cycle',
       'fc700000-0000-4000-8000-000000000003',
       'fc710000-0000-4000-8000-000000000003',
       'fc300000-0000-4000-8000-000000000007', 'created', amount_cents,
       currency, NULL, metadata
  FROM public.commerce_payment_intents
 WHERE id='fc400000-0000-4000-8000-000000000003';

INSERT INTO public.commerce_payment_attempts (
  id, payment_intent_id, payment_id, provider, provider_attempt_id,
  idempotency_key, status, amount_cents, currency, request_payload
)
SELECT
  ('fc500000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('fc400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('fc300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  CASE WHEN n = 2 THEN 'tpay' ELSE 'stripe' END,
  CASE WHEN n IN (2, 4) THEN NULL WHEN n = 5 THEN 'pi-checkout-global-lock-success' ELSE 'pi-checkout-global-lock-' || n END,
  'checkout-global-lock-attempt-' || n,
  CASE WHEN n = 1 THEN 'processing' WHEN n IN (2, 3) THEN 'created' ELSE 'failed' END,
  100, 'XTS',
  CASE WHEN n = 2 THEN jsonb_build_object(
    'source', 'commerce.runtime.provider-attempt.prepare.v0',
    'providerIdempotencyKey', 'checkout-global-lock-provider-2',
    'providerRequestFingerprint', 'checkout-global-lock-fingerprint-2',
    'providerFlow', 'blik_one_time'
  ) ELSE '{}'::jsonb END
FROM generate_series(1, 5) n;
UPDATE public.commerce_payment_intents payment_intent
   SET active_attempt_id = ('fc500000-0000-4000-8000-' || right(payment_intent.id::text, 12))::uuid
 WHERE EXISTS (
   SELECT 1
     FROM public.commerce_payment_attempts payment_attempt
    WHERE payment_attempt.id =
      ('fc500000-0000-4000-8000-' || right(payment_intent.id::text, 12))::uuid
 );

INSERT INTO public.inbound_provider_events (
  provider, provider_event_id, event_type, payload, payment_intent_id,
  payment_attempt_id, provider_payment_id, signature_verified
) VALUES (
  'stripe', 'checkout-global-lock-observed-success', 'payment.succeeded', '{}',
  'fc400000-0000-4000-8000-000000000005',
  'fc500000-0000-4000-8000-000000000005',
  'pi-checkout-global-lock-success', true
);

CREATE OR REPLACE FUNCTION pg_temp.try_oms_cancel(p_order_id uuid, p_key text)
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM public.commerce_oms_cancel_unpaid_order(p_key, p_order_id, 'test cancellation');
  RETURN 'cancelled';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.cancel_then_hold()
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE v_result jsonb;
BEGIN
  v_result := public.commerce_cancel_abandoned_checkout(
    'checkout-global-lock-cancel-first',
    'fc200000-0000-4000-8000-000000000004',
    'test cancellation'
  );
  PERFORM pg_sleep(0.30);
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.sweep_then_hold()
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE v_result jsonb;
BEGIN
  v_result := public.subscription_sweep_unpaid_provisional(
    'checkout-global-lock-sweep-first',
    '2021-01-01T00:00:00Z'::timestamptz,
    50
  );
  PERFORM pg_sleep(0.30);
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.prepare_then_hold()
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE v_result jsonb;
BEGIN
  v_result := public.commerce_payment_control_prepare_provider_attempt(
    'checkout-global-lock-prepare-winner',
    'fc400000-0000-4000-8000-000000000007',
    'stripe', 'checkout-global-lock-prepare-provider',
    'checkout-global-lock-prepare-fingerprint', 'one_time_payment', NULL,
    jsonb_build_object('source', 'pgTAP')
  );
  PERFORM pg_sleep(0.30);
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.try_inline_prepare_after_cancel()
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM public.commerce_payment_control_prepare_provider_attempt(
    'checkout-global-lock-post-cancel-prepare',
    'fc400000-0000-4000-8000-000000000004',
    'stripe', 'checkout-global-lock-post-cancel-provider',
    'checkout-global-lock-post-cancel-fingerprint', 'one_time_payment', NULL,
    jsonb_build_object(
      'source', 'commerce.checkout-inline-recovery.prepare.v1',
      'expectedPaymentAttemptId', 'fc500000-0000-4000-8000-000000000004',
      'retryRequestId', 'fc600000-0000-4000-8000-000000000004',
      'purchaseContext', 'one_time'
    )
  );
  RETURN 'unexpected_success';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$fn$;
$setup$);

SELECT extensions.dblink_exec('checkout_global_lock_peer', $peer_helper$
CREATE OR REPLACE FUNCTION pg_temp.try_inline_prepare_after_cancel()
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM public.commerce_payment_control_prepare_provider_attempt(
    'checkout-global-lock-post-cancel-prepare',
    'fc400000-0000-4000-8000-000000000004',
    'stripe', 'checkout-global-lock-post-cancel-provider',
    'checkout-global-lock-post-cancel-fingerprint', 'one_time_payment', NULL,
    jsonb_build_object(
      'source', 'commerce.checkout-inline-recovery.prepare.v1',
      'expectedPaymentAttemptId', 'fc500000-0000-4000-8000-000000000004',
      'retryRequestId', 'fc600000-0000-4000-8000-000000000004',
      'purchaseContext', 'one_time'
    )
  );
  RETURN 'unexpected_success';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$fn$;
$peer_helper$);

SELECT extensions.dblink_exec('checkout_global_lock_peer', $peer_sweep_helper$
CREATE OR REPLACE FUNCTION pg_temp.try_prepare_after_sweep()
RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM public.commerce_payment_control_prepare_provider_attempt(
    'checkout-global-lock-sweep-loser',
    'fc400000-0000-4000-8000-000000000006',
    'stripe', 'checkout-global-lock-sweep-provider',
    'checkout-global-lock-sweep-fingerprint', 'one_time_payment', NULL,
    jsonb_build_object('source', 'pgTAP')
  );
  RETURN 'unexpected_success';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$fn$;
$peer_sweep_helper$);

-- Result apply waits on the order and has not prelocked either payment child.
SAVEPOINT apply_order_barrier;
SELECT 1 FROM public.commerce_orders
 WHERE id = 'fc200000-0000-4000-8000-000000000001' FOR UPDATE;
SELECT extensions.dblink_send_query('checkout_global_lock_actor', $query$
  SELECT public.commerce_payment_control_apply_result(
    'checkout-global-lock-apply',
    'fc400000-0000-4000-8000-000000000001', NULL, 'failed', now(),
    'test_decline', 'hard_do_not_retry', 'checkout-global-lock-test'
  ) AS result
$query$);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('checkout_global_lock_actor'), 1,
  'apply result waits at the order before payment children');
SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    SELECT 1 FROM public.commerce_payment_intents
     WHERE id = 'fc400000-0000-4000-8000-000000000001' FOR UPDATE;
    SELECT 1 FROM public.commerce_payment_attempts
     WHERE id = 'fc500000-0000-4000-8000-000000000001' FOR UPDATE$$,
  'blocked apply result holds no intent or attempt lock');
ROLLBACK TO SAVEPOINT apply_order_barrier;
SELECT is(
  (SELECT result #>> '{paymentResult,status}'
     FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result jsonb)),
  'failed', 'apply resumes through the preserved result body');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result jsonb);

-- Reopen also waits at the order, before the sealed body reaches intent/attempt.
SAVEPOINT reopen_order_barrier;
SELECT 1 FROM public.commerce_orders
 WHERE id = 'fc200000-0000-4000-8000-000000000002' FOR UPDATE;
SELECT extensions.dblink_send_query('checkout_global_lock_actor', $query$
  SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
    'checkout-global-lock-reopen',
    'fc500000-0000-4000-8000-000000000002',
    'fc400000-0000-4000-8000-000000000002',
    'fc200000-0000-4000-8000-000000000002', NULL, NULL,
    'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_timeout',
    NULL, NULL, '{}'
  ) AS result
$query$);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('checkout_global_lock_actor'), 1,
  'interactive reopen waits at the order before payment children');
SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    SELECT 1 FROM public.commerce_payment_intents
     WHERE id = 'fc400000-0000-4000-8000-000000000002' FOR UPDATE;
    SELECT 1 FROM public.commerce_payment_attempts
     WHERE id = 'fc500000-0000-4000-8000-000000000002' FOR UPDATE$$,
  'blocked reopen holds no intent or attempt lock');
ROLLBACK TO SAVEPOINT reopen_order_barrier;
SELECT is(
  (SELECT result #>> '{interactivePreparedAttemptReopen,paymentAttemptStatus}'
     FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result jsonb)),
  'failed', 'reopen resumes through the preserved terminal body');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result jsonb);

-- Subscription-linked cancellation waits at the aggregate root first.
SAVEPOINT abandoned_subscription_barrier;
SELECT 1 FROM public.subscriptions
 WHERE id = 'fc700000-0000-4000-8000-000000000001' FOR UPDATE;
SELECT extensions.dblink_send_query('checkout_global_lock_actor', $query$
  SELECT public.commerce_cancel_abandoned_checkout(
    'checkout-global-lock-abandoned-live',
    'fc200000-0000-4000-8000-000000000003', 'test cancellation'
  ) AS result
$query$);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('checkout_global_lock_actor'), 1,
  'abandoned checkout cancellation waits at the subscription root');
SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    SELECT 1 FROM public.commerce_orders
     WHERE id = 'fc200000-0000-4000-8000-000000000003' FOR UPDATE;
    SELECT 1 FROM public.commerce_payment_intents
     WHERE id = 'fc400000-0000-4000-8000-000000000003' FOR UPDATE;
    SELECT 1 FROM public.commerce_payment_attempts
     WHERE id = 'fc500000-0000-4000-8000-000000000003' FOR UPDATE$$,
  'root-blocked abandoned cancellation holds no order or payment child lock');
ROLLBACK TO SAVEPOINT abandoned_subscription_barrier;
SELECT is(
  (SELECT result->>'reason'
     FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result jsonb)),
  'provider_attempt_in_flight', 'prepare-first abandoned cancellation returns typed in-flight');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result jsonb);
SELECT ok(
  (SELECT status = 'pending_payment' FROM public.commerce_orders
    WHERE id = 'fc200000-0000-4000-8000-000000000003')
  AND (SELECT status = 'created' FROM public.commerce_payment_attempts
    WHERE id = 'fc500000-0000-4000-8000-000000000003'),
  'typed in-flight refusal leaves order and attempt unchanged');

-- OMS cancellation takes the order before the same payment children.
SAVEPOINT oms_order_barrier;
SELECT 1 FROM public.commerce_orders
 WHERE id = 'fc200000-0000-4000-8000-000000000003' FOR UPDATE;
SELECT extensions.dblink_send_query(
  'checkout_global_lock_actor',
  $$SELECT pg_temp.try_oms_cancel(
    'fc200000-0000-4000-8000-000000000003', 'checkout-global-lock-oms-live'
  ) AS result$$
);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('checkout_global_lock_actor'), 1,
  'OMS cancellation waits at the order before payment children');
SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    SELECT 1 FROM public.commerce_payment_intents
     WHERE id = 'fc400000-0000-4000-8000-000000000003' FOR UPDATE;
    SELECT 1 FROM public.commerce_payment_attempts
     WHERE id = 'fc500000-0000-4000-8000-000000000003' FOR UPDATE$$,
  'order-blocked OMS cancellation holds no payment child lock');
ROLLBACK TO SAVEPOINT oms_order_barrier;
SELECT is(
  (SELECT result FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result text)),
  'commerce_oms_cancel_unpaid_order_payment_in_flight',
  'prepare-first OMS cancellation refuses the live attempt');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result text);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts
    WHERE id = 'fc500000-0000-4000-8000-000000000003'),
  'created', 'OMS in-flight refusal leaves the attempt unchanged');

-- If cancellation commits first, inline retry waits at the order and then
-- returns the stable not-payable error without creating a second attempt.
SELECT extensions.dblink_send_query(
  'checkout_global_lock_actor', 'SELECT pg_temp.cancel_then_hold() AS result'
);
SELECT pg_sleep(0.05);
SELECT extensions.dblink_send_query(
  'checkout_global_lock_peer', 'SELECT pg_temp.try_inline_prepare_after_cancel() AS result'
);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('checkout_global_lock_peer'), 1,
  'cancel-first inline prepare waits at the order root');
SELECT is(
  (SELECT (result->>'cancelled')::boolean
     FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result jsonb)),
  true, 'terminal-unpaid cancellation commits as the winner');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result jsonb);
SELECT is(
  (SELECT result FROM extensions.dblink_get_result('checkout_global_lock_peer') response(result text)),
  'payment_control_inline_retry_order_not_payable',
  'waiting inline prepare observes cancellation and refuses the retry');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_peer') drained(result text);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_payment_attempts
    WHERE payment_intent_id = 'fc400000-0000-4000-8000-000000000004'),
  1, 'cancel-first loser creates zero additional attempts');

-- Provider preparation can win first. While it holds the subscription root,
-- SKIP LOCKED omits the aggregate; after commit, the durable created attempt
-- makes every later sweep skip it as provider-reachable.
SELECT extensions.dblink_send_query(
  'checkout_global_lock_actor', 'SELECT pg_temp.prepare_then_hold() AS result'
);
SELECT pg_sleep(0.05);
SELECT is(
  (SELECT (result #>> '{sweep,count}')::integer FROM extensions.dblink(
    'checkout_global_lock_peer',
    $$SELECT public.subscription_sweep_unpaid_provisional(
      'checkout-global-lock-prepare-first',
      '2020-01-01T00:00:00Z'::timestamptz,
      50
    )$$
  ) AS response(result jsonb)),
  0, 'prepare-first sweep skips the locked subscription root');
SELECT is(
  (SELECT result #>> '{paymentAttempt,status}'
     FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result jsonb)),
  'created', 'provider preparation commits its durable attempt as winner');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result jsonb);
SELECT is(
  (SELECT (result #>> '{sweep,count}')::integer FROM extensions.dblink(
    'checkout_global_lock_peer',
    $$SELECT public.subscription_sweep_unpaid_provisional(
      'checkout-global-lock-prepare-first-recheck',
      '2020-01-01T00:00:00Z'::timestamptz,
      50
    )$$
  ) AS response(result jsonb)),
  0, 'prepare-first durable attempt blocks the later sweep');
SELECT ok(
  (SELECT status='pending_activation' FROM public.subscriptions
    WHERE id='fc700000-0000-4000-8000-000000000003')
  AND (SELECT status='pending_payment' FROM public.commerce_orders
    WHERE id='fc200000-0000-4000-8000-000000000007'),
  'prepare-first winner leaves subscription and order intact');

-- If the automatic sweep commits first, provider preparation waits at the
-- subscription root and then refuses the terminal intent before an adapter can
-- execute. This is the complementary winner to the prepare-first case above.
SELECT extensions.dblink_send_query(
  'checkout_global_lock_actor', 'SELECT pg_temp.sweep_then_hold() AS result'
);
SELECT pg_sleep(0.05);
SELECT extensions.dblink_send_query(
  'checkout_global_lock_peer', 'SELECT pg_temp.try_prepare_after_sweep() AS result'
);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('checkout_global_lock_peer'), 1,
  'sweep-first provider prepare waits at the subscription root');
SELECT is(
  (SELECT (result #>> '{sweep,count}')::integer
     FROM extensions.dblink_get_result('checkout_global_lock_actor') response(result jsonb)),
  1, 'sweep-first cancellation commits as the winner');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_actor') drained(result jsonb);
SELECT is(
  (SELECT result FROM extensions.dblink_get_result('checkout_global_lock_peer') response(result text)),
  'payment_control_provider_attempt_prepare_intent_not_retryable',
  'waiting provider prepare refuses the swept terminal intent');
SELECT count(*) FROM extensions.dblink_get_result('checkout_global_lock_peer') drained(result text);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_payment_attempts
    WHERE payment_intent_id = 'fc400000-0000-4000-8000-000000000006'),
  0, 'sweep-first loser creates no provider attempt');
SELECT ok(
  (SELECT status='cancelled' FROM public.subscriptions
    WHERE id='fc700000-0000-4000-8000-000000000002')
  AND (SELECT status='cancelled' FROM public.commerce_orders
    WHERE id='fc200000-0000-4000-8000-000000000006'),
  'sweep-first winner leaves the aggregate consistently cancelled');

-- A verified exact success wins even while local intent/order status is failed.
SELECT is(
  (SELECT result->>'reason' FROM extensions.dblink(
    'checkout_global_lock_actor',
    $$SELECT public.commerce_cancel_abandoned_checkout(
      'checkout-global-lock-abandoned-success',
      'fc200000-0000-4000-8000-000000000005', 'test cancellation'
    )$$
  ) AS response(result jsonb)),
  'payment_already_moved', 'abandoned cancellation refuses exact observed success');
SELECT is(
  (SELECT result FROM extensions.dblink(
    'checkout_global_lock_actor',
    $$SELECT pg_temp.try_oms_cancel(
      'fc200000-0000-4000-8000-000000000005', 'checkout-global-lock-oms-success'
    )$$
  ) AS response(result text)),
  'commerce_oms_cancel_unpaid_order_payment_already_moved',
  'OMS cancellation refuses exact observed success');
SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = 'fc200000-0000-4000-8000-000000000005'),
  'pending_payment', 'observed-success refusals leave the order unchanged');

SELECT ok(
  NOT has_function_privilege('service_role',
    'public.commerce_payment_apply_result_sealed_v1(text,uuid,uuid,text,timestamp with time zone,text,text,text)', 'EXECUTE'),
  'service role cannot bypass the root-first apply wrapper');
SELECT ok(
  NOT has_function_privilege('service_role',
    'public.commerce_payment_reopen_interactive_sealed_v1(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)', 'EXECUTE'),
  'service role cannot bypass the root-first reopen wrapper');
SELECT ok(
  NOT has_function_privilege('service_role',
    'public.commerce_checkout_cancel_lock_guard(uuid)', 'EXECUTE'),
  'service role cannot execute the private cancellation guard');
SELECT ok(
  NOT has_function_privilege('service_role',
    'public.commerce_cancel_abandoned_checkout_sealed_v1(text,uuid,text)', 'EXECUTE'),
  'service role cannot bypass abandoned-cancel admission');
SELECT ok(
  NOT has_function_privilege('service_role',
    'public.commerce_oms_cancel_unpaid_order_sealed_v1(text,uuid,text,uuid,jsonb)', 'EXECUTE'),
  'service role cannot bypass OMS-cancel admission');
SELECT ok(
  NOT has_function_privilege('anon',
    'public.commerce_payment_control_apply_result(text,uuid,uuid,text,timestamp with time zone,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role',
    'public.commerce_oms_cancel_unpaid_order(text,uuid,text,uuid,jsonb)', 'EXECUTE'),
  'public wrappers preserve their service-role-only ACLs');

SELECT extensions.dblink_exec('checkout_global_lock_actor', $cleanup$
DO $do$
DECLARE
  v_payment_ids uuid[];
BEGIN
  DELETE FROM public.commerce_order_operations
   WHERE order_id::text LIKE 'fc200000-0000-4000-8000-%';
  DELETE FROM public.subscription_events
   WHERE subscription_id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.outbox_events
   WHERE aggregate_id::text LIKE 'fc200000-0000-4000-8000-%'
      OR aggregate_id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.commerce_checkout_recovery_tokens
   WHERE order_id::text LIKE 'fc200000-0000-4000-8000-%';
  DELETE FROM public.inbound_provider_events
   WHERE provider_event_id LIKE 'checkout-global-lock-%';
  DELETE FROM public.commerce_payment_state_transitions
   WHERE payment_intent_id::text LIKE 'fc400000-0000-4000-8000-%';
  DELETE FROM public.commerce_payment_reconciliation_runs
   WHERE idempotency_key LIKE 'checkout-global-lock-%';
  DELETE FROM public.commerce_idempotency_keys
   WHERE idempotency_key LIKE 'checkout-global-lock-%';
  UPDATE public.commerce_payment_intents SET active_attempt_id = NULL
   WHERE id::text LIKE 'fc400000-0000-4000-8000-%';
  DELETE FROM public.commerce_payment_attempts
   WHERE id::text LIKE 'fc500000-0000-4000-8000-%';
  DELETE FROM public.commerce_payment_intents
   WHERE id::text LIKE 'fc400000-0000-4000-8000-%';
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_payment_ids
   FROM public.commerce_payments WHERE id::text LIKE 'fc300000-0000-4000-8000-%';
  DELETE FROM public.commerce_payments WHERE id = ANY(v_payment_ids);
  DELETE FROM public.commerce_orders
   WHERE id::text LIKE 'fc200000-0000-4000-8000-%';
  DELETE FROM public.subscription_cycles
   WHERE subscription_id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.subscriptions
   WHERE id::text LIKE 'fc700000-0000-4000-8000-%';
  DELETE FROM public.clients
   WHERE id = 'fc100000-0000-4000-8000-000000000001';
END
$do$;
$cleanup$);

SELECT extensions.dblink_disconnect('checkout_global_lock_actor');
SELECT extensions.dblink_disconnect('checkout_global_lock_peer');
SELECT * FROM finish();
ROLLBACK;
