-- pgTAP: dedicated OMS cancellation for an unpaid commerce order.
-- It must stay distinct from fulfillment cancellation, accept only
-- pending_payment, write one audit operation, and be service-role-only.

BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email)
VALUES ('d1000000-0000-4000-8000-000000000001', 'oms-cancel-unpaid@example.invalid');

INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'pending_payment', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001',
   'paid', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000),
  ('d2000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001',
   'cancelled', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);

SELECT is(
  (public.commerce_oms_cancel_unpaid_order(
    'oms-cancel-unpaid-a', 'd2000000-0000-4000-8000-000000000001', 'payment abandoned'
  )->>'contractVersion'),
  'commerce.v0',
  'response uses the application commerce contract version');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'd2000000-0000-4000-8000-000000000001'),
  'cancelled', 'pending_payment order transitions to cancelled');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE order_id = 'd2000000-0000-4000-8000-000000000001'
      AND operation_type = 'order_cancelled_manual'),
  1, 'writes one dedicated manual-order-cancel audit operation');

SELECT is(
  (SELECT payload->>'reason' FROM public.commerce_order_operations
    WHERE order_id = 'd2000000-0000-4000-8000-000000000001'),
  'payment abandoned', 'audit payload preserves the operator reason');

SELECT is(
  (public.commerce_oms_cancel_unpaid_order(
    'oms-cancel-unpaid-a', 'd2000000-0000-4000-8000-000000000001', 'payment abandoned'
  )->>'replayed')::boolean,
  true, 'same idempotency key returns a replay');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE order_id = 'd2000000-0000-4000-8000-000000000001'
      AND operation_type = 'order_cancelled_manual'),
  1, 'replay does not duplicate the audit operation');

SELECT throws_ok(
  $$ SELECT public.commerce_oms_cancel_unpaid_order(
    'oms-cancel-unpaid-b', 'd2000000-0000-4000-8000-000000000002', 'attempt to cancel paid order'
  ) $$,
  '22023', 'commerce_oms_cancel_unpaid_order_invalid_status',
  'paid order is never cancellable through this OMS boundary');

SELECT lives_ok(
  $$ SELECT public.commerce_oms_cancel_unpaid_order(
    'oms-cancel-unpaid-c', 'd2000000-0000-4000-8000-000000000003', 'already cancelled elsewhere'
  ) $$,
  'already-cancelled order is an idempotent no-op');

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.commerce_oms_cancel_unpaid_order(text, uuid, text, uuid, jsonb)', 'EXECUTE'),
  'authenticated cannot execute the order-cancel mutation directly');

SELECT * FROM finish();
ROLLBACK;
