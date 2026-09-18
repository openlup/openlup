-- pgTAP: checkout finalize names only terminal consumed-journey conflicts.
-- Verifies migrations 20260724031500 + 20260724043000:
--   * same-fingerprint completed rows still replay exactly;
--   * completed rows pointing at resumable, draft, missing or malformed orders
--     remain generic idempotency conflicts and cannot trigger client rotation;
--   * every current terminal order status names journey_consumed.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(13);

INSERT INTO public.commerce_orders (id, status)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'draft'),
  ('10000000-0000-4000-8000-000000000002', 'pending_payment'),
  ('10000000-0000-4000-8000-000000000003', 'paid'),
  ('10000000-0000-4000-8000-000000000004', 'failed'),
  ('10000000-0000-4000-8000-000000000005', 'expired'),
  ('10000000-0000-4000-8000-000000000006', 'fulfillment_pending'),
  ('10000000-0000-4000-8000-000000000007', 'fulfilled'),
  ('10000000-0000-4000-8000-000000000008', 'cancelled'),
  ('10000000-0000-4000-8000-000000000009', 'refunded');

CREATE FUNCTION pg_temp.finalize_for_journey_consumed_test(p_key text)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.commerce_finalize_order_for_checkout(
    p_key,
    '70000000-0000-4000-8000-000000000001',
    'one_time',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    NULL,
    '{"quote":{"context":{"mode":"one_time"},"lines":[]}}'::jsonb,
    '{"orderId":"order_x"}'::jsonb
  )
$$;

INSERT INTO public.commerce_idempotency_keys (
  scope, idempotency_key, status, request_fingerprint, response_payload
)
VALUES
  (
    'commerce.checkout_order_finalize',
    'checkout:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    'completed',
    md5(
      '70000000-0000-4000-8000-000000000001|one_time|'
      || '11111111-1111-4111-8111-111111111111|'
      || '33333333-3333-4333-8333-333333333333||'
      || '{"quote":{"context":{"mode":"one_time"},"lines":[]}}'::jsonb::text
      || '|' || '{"orderId":"order_x"}'::jsonb::text
      || '|' || '{}'::jsonb::text
    ),
    '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000003","replayed":false}}'::jsonb
  ),
  ('commerce.checkout_order_finalize', 'checkout:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'completed',
   'different-draft-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000001","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:cccccccc-3333-4333-8333-cccccccccccc', 'completed',
   'different-pending-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000002","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:dddddddd-4444-4444-8444-dddddddddddd', 'completed',
   'different-missing-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000010","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'completed',
   'different-malformed-fingerprint',
   '{"finalizedOrder":{"orderId":"not-a-uuid","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:ffffffff-6666-4666-8666-ffffffffffff', 'completed',
   'different-paid-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000003","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:11111111-7777-4777-8777-111111111111', 'completed',
   'different-failed-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000004","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:22222222-8888-4888-8888-222222222222', 'completed',
   'different-expired-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000005","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:33333333-9999-4999-8999-333333333333', 'completed',
   'different-fulfillment-pending-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000006","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:44444444-aaaa-4aaa-8aaa-444444444444', 'completed',
   'different-fulfilled-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000007","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:55555555-bbbb-4bbb-8bbb-555555555555', 'completed',
   'different-cancelled-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000008","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:66666666-cccc-4ccc-8ccc-666666666666', 'completed',
   'different-refunded-fingerprint',
   '{"finalizedOrder":{"orderId":"10000000-0000-4000-8000-000000000009","replayed":false}}'::jsonb),
  ('commerce.checkout_order_finalize', 'checkout:77777777-dddd-4ddd-8ddd-777777777777', 'in_progress',
   'in-flight-fingerprint', NULL);

SELECT is(
  (pg_temp.finalize_for_journey_consumed_test('checkout:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
    #>> '{finalizedOrder,replayed}')::boolean,
  true,
  'same-fingerprint completed row replays instead of classifying a journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'completed draft order stays non-rotatable'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:cccccccc-3333-4333-8333-cccccccccccc')$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'completed pending_payment order stays resumable and non-rotatable'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:dddddddd-4444-4444-8444-dddddddddddd')$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'missing original order fails closed as generic conflict'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:eeeeeeee-5555-4555-8555-eeeeeeeeeeee')$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'malformed original order reference fails closed as generic conflict'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:ffffffff-6666-4666-8666-ffffffffffff')$$,
  'commerce_runtime_finalize_journey_consumed',
  'paid order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:11111111-7777-4777-8777-111111111111')$$,
  'commerce_runtime_finalize_journey_consumed',
  'failed order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:22222222-8888-4888-8888-222222222222')$$,
  'commerce_runtime_finalize_journey_consumed',
  'expired order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:33333333-9999-4999-8999-333333333333')$$,
  'commerce_runtime_finalize_journey_consumed',
  'fulfillment_pending order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:44444444-aaaa-4aaa-8aaa-444444444444')$$,
  'commerce_runtime_finalize_journey_consumed',
  'fulfilled order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:55555555-bbbb-4bbb-8bbb-555555555555')$$,
  'commerce_runtime_finalize_journey_consumed',
  'cancelled order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:66666666-cccc-4ccc-8ccc-666666666666')$$,
  'commerce_runtime_finalize_journey_consumed',
  'refunded order names the consumed journey'
);

SELECT throws_ok(
  $$SELECT pg_temp.finalize_for_journey_consumed_test('checkout:77777777-dddd-4ddd-8ddd-777777777777')$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'in-progress row keeps the generic idempotency conflict'
);

SELECT * FROM finish();
ROLLBACK;
