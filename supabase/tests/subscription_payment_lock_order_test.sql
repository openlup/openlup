-- pgTAP: subscription money mutations acquire the aggregate root before payment
-- rows. Sequential tests cannot detect ABBA windows, so prepare, pause,
-- provider-finalize and failed-webhook dunning are exercised through a real
-- second session while the first session owns the subscription barrier.

BEGIN;
SELECT plan(21);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'subscription_prepare_writer',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

-- Idempotent cleanup makes the fixture recoverable after an interrupted prior run.
SELECT extensions.dblink_exec('subscription_prepare_writer', $cleanup$
DO $do$
DECLARE
  v_payment_ids uuid[];
BEGIN
  DELETE FROM public.subscription_dunning_cases
   WHERE subscription_id = 'ab200000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_events
   WHERE subscription_id = 'ab200000-0000-4000-8000-000000000001';
  DELETE FROM public.outbox_events
   WHERE aggregate_id IN (
     'ab200000-0000-4000-8000-000000000001',
     'ab400000-0000-4000-8000-000000000001'
   )
      OR idempotency_key LIKE 'lock-order-%';
  SELECT COALESCE(array_agg(payment_intent.payment_id), ARRAY[]::uuid[])
    INTO v_payment_ids
    FROM public.commerce_payment_intents payment_intent
   WHERE payment_intent.order_id = 'ab400000-0000-4000-8000-000000000001';

  UPDATE public.commerce_payment_intents
     SET active_attempt_id = NULL
   WHERE order_id = 'ab400000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_payment_attempts
   WHERE payment_intent_id IN (
     SELECT id FROM public.commerce_payment_intents
      WHERE order_id = 'ab400000-0000-4000-8000-000000000001'
   );
  DELETE FROM public.commerce_payment_intents
   WHERE order_id = 'ab400000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_idempotency_keys
   WHERE idempotency_key LIKE 'lock-order-%';
  DELETE FROM public.commerce_payments WHERE id = ANY(v_payment_ids);
  DELETE FROM public.commerce_orders WHERE id = 'ab400000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_cycles WHERE id = 'ab300000-0000-4000-8000-000000000001';
  DELETE FROM public.subscriptions WHERE id = 'ab200000-0000-4000-8000-000000000001';
  DELETE FROM public.clients WHERE id = 'ab100000-0000-4000-8000-000000000001';
  DELETE FROM auth.users WHERE id = 'ab000000-0000-4000-8000-000000000001';
END
$do$;
$cleanup$);

SELECT extensions.dblink_exec('subscription_prepare_writer', $setup$
INSERT INTO auth.users (id)
VALUES ('ab000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (id, auth_user_id, email)
VALUES (
  'ab100000-0000-4000-8000-000000000001',
  'ab000000-0000-4000-8000-000000000001',
  'lock-order@example.invalid'
);

-- Keep the fixture on the same fixed timeline as the action timestamps below;
-- a moving now()-30-days start eventually makes cancellation predate creation.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  'ab200000-0000-4000-8000-000000000001',
  'ab100000-0000-4000-8000-000000000001',
  30, 'PLN', 'active',
  '2026-07-21T10:00:00Z'::timestamptz,
  '2026-08-20T10:00:00Z'::timestamptz,
  'pm_lock_order', 'card'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt, next_retry_at
)
VALUES (
  'ab300000-0000-4000-8000-000000000001',
  'ab200000-0000-4000-8000-000000000001',
  2, '2026-08-20T10:00:00Z'::timestamptz,
  'retry_scheduled', 'lock-order-cycle', 0,
  '2026-08-20T10:00:00Z'::timestamptz
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
)
VALUES (
  'ab400000-0000-4000-8000-000000000001',
  'ab100000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":30}'::jsonb,
  'pending_payment', 12999, 12999, 'subscription_cycle',
  'ab200000-0000-4000-8000-000000000001',
  'ab300000-0000-4000-8000-000000000001'
);

DO $inner$
BEGIN
  PERFORM public.commerce_payment_control_create_intent(
    'lock-order-intent',
    'subscription_cycle',
    'ab400000-0000-4000-8000-000000000001',
    'ab200000-0000-4000-8000-000000000001',
    'ab300000-0000-4000-8000-000000000001',
    12999, 'PLN', '{}'::jsonb
  );
END
$inner$;
$setup$);

SELECT extensions.dblink_exec('subscription_prepare_writer', $pause_helper$
CREATE OR REPLACE FUNCTION pg_temp.try_pause_during_payment()
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.customer_self_service_apply_subscription_action(
    'ab000000-0000-4000-8000-000000000001',
    'lock-order-pause-action',
    'ab200000-0000-4000-8000-000000000001',
    'pause',
    '{"pausePreset":"2_weeks"}'::jsonb,
    '2026-07-21T10:00:00Z'::timestamptz
  );
  RETURN 'unexpected_success';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$function$;
$pause_helper$);

CREATE TEMP TABLE _lock_order_intent AS
SELECT id
  FROM public.commerce_payment_intents
 WHERE order_id = 'ab400000-0000-4000-8000-000000000001';

SAVEPOINT subscription_lock_barrier;
SELECT 1
  FROM public.subscriptions
 WHERE id = 'ab200000-0000-4000-8000-000000000001'
 FOR UPDATE;

SELECT extensions.dblink_send_query(
  'subscription_prepare_writer',
  format(
    'SELECT public.commerce_payment_control_prepare_provider_attempt('
      || '%L, %L::uuid, %L, %L, %L, %L, %L, %L::jsonb) AS result',
    'lock-order-prepare',
    (SELECT id::text FROM _lock_order_intent),
    'stripe',
    'lock-order-provider-key',
    'lock-order-fingerprint',
    'off_session_payment',
    'pm_lock_order',
    '{}'
  )
);
SELECT pg_sleep(0.05);

SELECT is(
  extensions.dblink_is_busy('subscription_prepare_writer'),
  1,
  'concurrent prepare waits at the subscription aggregate fence'
);

SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    SELECT 1
      FROM public.commerce_payment_intents
     WHERE id = (SELECT id FROM _lock_order_intent)
     FOR UPDATE$$,
  'blocked prepare does not hold the intent in reverse order'
);

ROLLBACK TO SAVEPOINT subscription_lock_barrier;

SELECT is(
  (SELECT result #>> '{paymentAttempt,status}'
     FROM extensions.dblink_get_result('subscription_prepare_writer') AS response(result jsonb)),
  'created',
  'prepare resumes and creates exactly one local attempt after the aggregate lock releases'
);
SELECT count(*)
  FROM extensions.dblink_get_result('subscription_prepare_writer') AS drained(result jsonb);

CREATE TEMP TABLE _lock_order_attempt AS
SELECT active_attempt_id AS id
  FROM public.commerce_payment_intents
 WHERE id = (SELECT id FROM _lock_order_intent);

-- If admission committed first, pause waits for the same root and then refuses
-- to confirm while that nonterminal attempt can still cross the PSP boundary.
SAVEPOINT pause_lock_barrier;
SELECT 1
  FROM public.subscriptions
 WHERE id = 'ab200000-0000-4000-8000-000000000001'
 FOR UPDATE;

SELECT extensions.dblink_send_query(
  'subscription_prepare_writer',
  'SELECT pg_temp.try_pause_during_payment() AS result'
);
SELECT pg_sleep(0.05);

SELECT is(
  extensions.dblink_is_busy('subscription_prepare_writer'),
  1,
  'concurrent pause waits at the subscription aggregate fence'
);

ROLLBACK TO SAVEPOINT pause_lock_barrier;

SELECT is(
  (SELECT result
     FROM extensions.dblink_get_result('subscription_prepare_writer') AS response(result text)),
  'customer_self_service_payment_blocked',
  'pause cannot confirm after a nonterminal renewal attempt was admitted'
);
SELECT count(*)
  FROM extensions.dblink_get_result('subscription_prepare_writer') AS drained(result text);

SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id = 'ab200000-0000-4000-8000-000000000001'),
  'active',
  'blocked pause leaves the subscription chargeable until PSP truth settles'
);

-- A fast webhook and the synchronous provider finalizer share the same root;
-- while that root is held, finalize must not pre-lock the attempt or intent.
SAVEPOINT finalize_lock_barrier;
SELECT 1
  FROM public.subscriptions
 WHERE id = 'ab200000-0000-4000-8000-000000000001'
 FOR UPDATE;

SELECT extensions.dblink_send_query(
  'subscription_prepare_writer',
  format(
    'SELECT public.commerce_payment_control_finalize_provider_attempt('
      || '%L, %L::uuid, %L::uuid, %L, %L, %L, %L, %L, NULL, %L::jsonb, %L::jsonb) AS result',
    'lock-order-finalize',
    (SELECT id::text FROM _lock_order_intent),
    (SELECT id::text FROM _lock_order_attempt),
    'lock-order-provider-key',
    'lock-order-fingerprint',
    'pi_lock_order',
    'pi_lock_order',
    'processing',
    '{}',
    '{}'
  )
);
SELECT pg_sleep(0.05);

SELECT is(
  extensions.dblink_is_busy('subscription_prepare_writer'),
  1,
  'provider finalization waits at the subscription aggregate fence'
);

SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    SELECT 1 FROM public.commerce_payment_intents
     WHERE id = (SELECT id FROM _lock_order_intent) FOR UPDATE;
    SELECT 1 FROM public.commerce_payment_attempts
     WHERE id = (SELECT id FROM _lock_order_attempt) FOR UPDATE$$,
  'blocked provider finalization holds no child payment lock'
);

ROLLBACK TO SAVEPOINT finalize_lock_barrier;

SELECT is(
  (SELECT result #>> '{paymentAttempt,status}'
     FROM extensions.dblink_get_result('subscription_prepare_writer') AS response(result jsonb)),
  'processing',
  'provider finalization resumes after the aggregate lock releases'
);
SELECT count(*)
  FROM extensions.dblink_get_result('subscription_prepare_writer') AS drained(result jsonb);

-- Materialize a canonical failed result so the webhook dunning follow-up is
-- eligible. It is a separate RPC in production.
SELECT extensions.dblink_exec('subscription_prepare_writer', format($apply$
DO $do$
BEGIN
  PERFORM public.commerce_payment_control_apply_result(
    'lock-order-apply-failed', %L::uuid, NULL, 'failed',
    '2026-07-21T10:01:00Z'::timestamptz, 'lock_order_failure'
  );
END
$do$;
$apply$, (SELECT id::text FROM _lock_order_intent)));

-- Cancellation owns the root. The dunning follow-up must wait before taking
-- intent/order/cycle locks, allowing cancellation to complete without ABBA.
SAVEPOINT dunning_lock_barrier;
SELECT 1
  FROM public.subscriptions
 WHERE id = 'ab200000-0000-4000-8000-000000000001'
 FOR UPDATE;

SELECT extensions.dblink_send_query(
  'subscription_prepare_writer',
  format(
    'SELECT public.subscription_open_dunning_from_failed_payment_result('
      || '%L, %L::uuid, NULL, %L, %L::timestamptz) AS result',
    'lock-order-webhook-dunning',
    (SELECT id::text FROM _lock_order_intent),
    'lock_order_failure',
    '2026-07-21T10:01:01Z'
  )
);
SELECT pg_sleep(0.05);

SELECT is(
  extensions.dblink_is_busy('subscription_prepare_writer'),
  1,
  'failed-webhook dunning waits at the subscription aggregate fence'
);

SELECT lives_ok(
  $$SELECT public.customer_self_service_apply_subscription_action(
      'ab000000-0000-4000-8000-000000000001',
      'lock-order-cancel-action',
      'ab200000-0000-4000-8000-000000000001',
      'cancel',
      '{"reason":"customer_cancelled"}'::jsonb,
      '2026-07-21T10:01:02Z'::timestamptz
    )$$,
  'cancellation can lock and clean payment children while dunning waits at the root'
);

ROLLBACK TO SAVEPOINT dunning_lock_barrier;

SELECT is(
  (SELECT result #>> '{subscriptionWebhookDunning,opened}'
     FROM extensions.dblink_get_result('subscription_prepare_writer') AS response(result jsonb)),
  'true',
  'failed-webhook dunning resumes after the cancellation barrier is released'
);
SELECT count(*)
  FROM extensions.dblink_get_result('subscription_prepare_writer') AS drained(result jsonb);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.commerce_payment_control_prepare_before_sub_lock(text,uuid,text,text,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'service role cannot bypass the subscription-first prepare wrapper'
);

-- The apply body's identity was RECREATED, not replaced: 20260826180000 widened
-- its parameter list to carry the refusal's class, and a parameter count can only
-- be widened by DROP + CREATE. The DROP discarded this function's entire ACL, and
-- on this platform a recreated `public` function is granted EXECUTE by DEFAULT
-- PRIVILEGE to anon, authenticated and service_role. So the seal below is not a
-- restatement of something that survived — it is the only thing standing between
-- a browser session and the canonical payment-apply body. It is asserted for all
-- four grantees, and the identity is resolved first so none of them can pass
-- vacuously against a signature that no longer exists.
SELECT isnt(
  to_regprocedure(
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)'
  )::text,
  NULL::text,
  'the widened result wrapper body resolves, so the seals below are not vacuous'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'service role cannot bypass the subscription-first result wrapper'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'anon holds no execute on the recreated result-wrapper body'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'authenticated holds no execute on the recreated result-wrapper body'
);

-- has_function_privilege cannot see a grant held by PUBLIC, so the ACL is read
-- directly. This is the check that would have caught the historical class of
-- regression where a REVOKE named PUBLIC and nothing else.
SELECT is(
  (SELECT coalesce(string_agg(DISTINCT acl.privilege_type, ', '), '')
     FROM pg_proc AS proc
     CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS acl
    WHERE proc.oid = to_regprocedure(
            'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)'
          )::oid
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'),
  '',
  'PUBLIC holds no execute grant on the recreated result-wrapper body'
);

-- The old six-argument identity is GONE, not merely shadowed. Two arities of the
-- same name would make every existing six-argument call ambiguous, which is a
-- total outage of the terminal payment write rather than a cosmetic leftover.
SELECT is(
  to_regprocedure(
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text)'
  )::text,
  NULL::text,
  'the superseded six-argument body no longer exists to be called ambiguously'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.commerce_payment_control_finalize_before_sub_lock(text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'service role cannot bypass the subscription-first provider-finalize wrapper'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.subscription_open_dunning_before_sub_lock(text,uuid,text,text,timestamptz,text)',
    'EXECUTE'
  ),
  'service role cannot bypass the subscription-first webhook-dunning wrapper'
);

SELECT extensions.dblink_exec('subscription_prepare_writer', $cleanup$
DO $do$
DECLARE
  v_payment_ids uuid[];
BEGIN
  DELETE FROM public.subscription_dunning_cases
   WHERE subscription_id = 'ab200000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_events
   WHERE subscription_id = 'ab200000-0000-4000-8000-000000000001';
  DELETE FROM public.outbox_events
   WHERE aggregate_id IN (
     'ab200000-0000-4000-8000-000000000001',
     'ab400000-0000-4000-8000-000000000001'
   )
      OR idempotency_key LIKE 'lock-order-%';
  SELECT COALESCE(array_agg(payment_intent.payment_id), ARRAY[]::uuid[])
    INTO v_payment_ids
    FROM public.commerce_payment_intents payment_intent
   WHERE payment_intent.order_id = 'ab400000-0000-4000-8000-000000000001';

  UPDATE public.commerce_payment_intents
     SET active_attempt_id = NULL
   WHERE order_id = 'ab400000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_payment_attempts
   WHERE payment_intent_id IN (
     SELECT id FROM public.commerce_payment_intents
      WHERE order_id = 'ab400000-0000-4000-8000-000000000001'
   );
  DELETE FROM public.commerce_payment_intents
   WHERE order_id = 'ab400000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_idempotency_keys
   WHERE idempotency_key LIKE 'lock-order-%';
  DELETE FROM public.commerce_payments WHERE id = ANY(v_payment_ids);
  DELETE FROM public.commerce_orders WHERE id = 'ab400000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_cycles WHERE id = 'ab300000-0000-4000-8000-000000000001';
  DELETE FROM public.subscriptions WHERE id = 'ab200000-0000-4000-8000-000000000001';
  DELETE FROM public.clients WHERE id = 'ab100000-0000-4000-8000-000000000001';
  DELETE FROM auth.users WHERE id = 'ab000000-0000-4000-8000-000000000001';
END
$do$;
$cleanup$);

SELECT extensions.dblink_disconnect('subscription_prepare_writer');
SELECT * FROM finish();
ROLLBACK;
