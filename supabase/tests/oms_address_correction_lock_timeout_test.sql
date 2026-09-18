-- pgTAP: the operator address correction gives up waiting, and says so.
--
-- Every lock `commerce_oms_update_shipping_address` took was unbounded, so a
-- contended correction produced no answer at all - two staging batches ended with
-- the caller abandoning the request after twenty seconds and no status code ever
-- being returned. The routine now sets a transaction-scoped `lock_timeout`, and
-- what this suite proves is that the bound is real, that it belongs to the
-- routine rather than to the caller, and that it names itself.
--
-- Two sessions are required and pgTAP has one, so the second is a `dblink`
-- connection - the same fixture `subscription_delivery_alignment_test.sql` uses,
-- and the only concurrency mechanism this rig has.
--
-- ⛔ No order fixture, deliberately. The delivery advisory key is taken at the
-- head of the routine, before the order is ever read, so contention on it is
-- reachable without one. That is also why this suite cannot pass vacuously: if
-- the routine ever stopped blocking there, the call would reach the order read
-- and raise `commerce_oms_shipping_address_order_not_found` instead, and the
-- first assertion would fail rather than quietly succeed. The last assertion
-- pins that alternative directly, so the refusal in the first is attributable to
-- the held lock and to nothing else.

BEGIN;
SELECT plan(7);

-- Read from the live catalog, not from a migration file: a later full-body
-- replace that forgets the bound would leave every hardcoded-path assertion
-- passing while the database ran a body without it.
SELECT ok(
  pg_get_functiondef(
    'public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)'::regprocedure
  ) LIKE '%SET LOCAL lock_timeout%',
  'the effective routine sets its own lock timeout'
);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'oms_address_lock_holder',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

-- The holder takes the delivery key for one order and keeps it, uncommitted.
SELECT extensions.dblink_exec('oms_address_lock_holder', 'BEGIN');
SELECT extensions.dblink_exec('oms_address_lock_holder', $hold$
DO $do$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'commerce-order-delivery|7c000000-0000-4000-8000-00000000c101',
    0
  ));
END
$do$;
$hold$);

CREATE FUNCTION pg_temp.correct_address_under_contention()
RETURNS TABLE (outcome text, sqlstate_returned text, elapsed_ms numeric)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
BEGIN
  PERFORM public.commerce_oms_update_shipping_address(
    'oms-address-lock-timeout-probe',
    '7c000000-0000-4000-8000-00000000c101'::uuid,
    jsonb_build_object(
      'recipientName', 'Lock Probe',
      'contactEmail', 'lock-probe@example.invalid',
      'contactPhone', '+00000000000',
      'line1', 'Probe Street 1',
      'city', 'Testville',
      'postalCode', '00-001',
      'country', 'ZZ'
    ),
    '7c000000-0000-4000-8000-00000000c1a1'::uuid
  );
  RETURN QUERY SELECT 'applied'::text, '00000'::text,
    EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT
    CASE SQLSTATE WHEN '55P03' THEN 'lock_not_available' ELSE SQLERRM END,
    SQLSTATE::text,
    EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000;
END
$function$;

-- Both settings are top-level statements on purpose. `statement_timeout` is armed
-- when a statement begins and is never re-armed from inside it, so setting it
-- within the probe would bound nothing; here it is the suite's own dead-man
-- switch, so a routine that lost its bound fails this suite in fifteen seconds
-- with SQLSTATE 57014 instead of hanging the DB lane forever.
SET LOCAL statement_timeout = '15s';
-- And the caller waits without limit, so the bound the probe observes can only be
-- the routine's own.
SET LOCAL lock_timeout = 0;

CREATE TEMP TABLE contended_probe AS
SELECT * FROM pg_temp.correct_address_under_contention();

SELECT is(
  (SELECT outcome FROM contended_probe),
  'lock_not_available',
  'a correction blocked on the delivery key refuses instead of waiting'
);

SELECT is(
  (SELECT sqlstate_returned FROM contended_probe),
  '55P03',
  'the refusal carries lock_not_available, the SQLSTATE the admin adapter classifies'
);

SELECT ok(
  (SELECT elapsed_ms FROM contended_probe) BETWEEN 2000 AND 9000,
  'the wait is bounded near the routine''s three seconds, not by the caller and not by the lane'
);

SELECT is(
  current_setting('lock_timeout'),
  '0',
  'the routine''s bound is unwound on return and binds no later statement in this transaction'
);

SELECT is(
  (SELECT count(*)::integer FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.oms.shipping_address.update'
      AND idempotency_key = 'oms-address-lock-timeout-probe'),
  0,
  'a refused correction claims no idempotency key, so the same request may be sent again'
);

-- Release the key and repeat the identical call. It must now travel past the
-- advisory lock and refuse on the missing order, which is what makes the refusal
-- above attributable to contention rather than to the input.
SELECT extensions.dblink_exec('oms_address_lock_holder', 'ROLLBACK');
SELECT extensions.dblink_disconnect('oms_address_lock_holder');

SELECT is(
  (SELECT outcome FROM pg_temp.correct_address_under_contention()),
  'commerce_oms_shipping_address_order_not_found',
  'the same call without contention reaches the order read, so the bound refuses only a real wait'
);

SELECT * FROM finish();
ROLLBACK;
