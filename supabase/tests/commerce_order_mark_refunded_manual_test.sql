-- pgTAP: commerce_order_mark_refunded_manual (20260711170027, contract-version
-- fix in 20260711170029).
--   * a paid order can be manually marked refunded, with an audit-trail row;
--   * the RPC's jsonb response uses the app's real COMMERCE_CONTRACT_VERSION
--     literal ('commerce.v0') — regression guard for a real bug caught via a
--     live staging rehearsal deploy: the RPC previously returned
--     'commerce.oms.v0', which the BFF's Zod response schema rejected
--     (safeParse failure -> 502 INVALID_RESPONSE) even though this exact
--     status/audit-row write already succeeded and committed;
--   * the manual action does NOT emit a commerce.order.refunded outbox row
--     (proves it stays cosmetic-only: no customer email, no accounting
--     reversal — those trigger only off metadata.source='payment.control.v0');
--   * replaying the same idempotency key is a safe no-op (no duplicate audit row);
--   * reusing the idempotency key for a different order/reason is rejected;
--   * a non-'paid' order is rejected;
--   * an already-'refunded' order (e.g. via the real webhook path) is a no-op;
--   * an unknown order id is rejected.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(11);

INSERT INTO public.clients (id, email)
VALUES ('b1000000-0000-4000-8000-000000000001', 'mark-refunded-manual@example.invalid');

-- Order A: paid, the happy-path target.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
        'paid', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);

-- Order B: not paid yet — must be rejected.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001',
        'pending_payment', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);

-- Order C: already refunded via the real (webhook) path — must no-op cleanly.
INSERT INTO public.commerce_orders (id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('b2000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001',
        'refunded', 'PLN', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);

-- Happy path.
SELECT is(
  (public.commerce_order_mark_refunded_manual(
    'mark-refunded-a', 'b2000000-0000-4000-8000-000000000001', 'operator confirmed Tpay panel refund'
  )->>'contractVersion'),
  'commerce.v0',
  'RPC response contractVersion matches the app''s COMMERCE_CONTRACT_VERSION literal (regression guard)');

SELECT is((SELECT status FROM public.commerce_orders WHERE id = 'b2000000-0000-4000-8000-000000000001'),
  'refunded', 'paid order transitions to refunded');

SELECT is((SELECT count(*)::int FROM public.commerce_order_operations
            WHERE order_id = 'b2000000-0000-4000-8000-000000000001'
              AND operation_type = 'order_marked_refunded'),
  1, 'writes exactly one audit-trail operation row');

SELECT is((SELECT count(*)::int FROM public.outbox_events
            WHERE aggregate_id = 'b2000000-0000-4000-8000-000000000001'
              AND event_type = 'commerce.order.refunded'),
  0, 'does NOT emit a commerce.order.refunded outbox row (no email/accounting side effect)');

-- Idempotent replay: same key, same order/reason -> safe no-op, no duplicate row.
SELECT public.commerce_order_mark_refunded_manual(
  'mark-refunded-a', 'b2000000-0000-4000-8000-000000000001', 'operator confirmed Tpay panel refund'
);

SELECT is((SELECT count(*)::int FROM public.commerce_order_operations
            WHERE order_id = 'b2000000-0000-4000-8000-000000000001'
              AND operation_type = 'order_marked_refunded'),
  1, 'replaying the same idempotency key does not duplicate the audit row');

-- Idempotency-key reuse against a different order is rejected.
SELECT throws_ok(
  $$ SELECT public.commerce_order_mark_refunded_manual(
       'mark-refunded-a', 'b2000000-0000-4000-8000-000000000002', 'different order'
     ) $$,
  '23505', 'commerce_order_mark_refunded_idempotency_conflict',
  'reusing an idempotency key for a different order is rejected');

-- Non-'paid' order is rejected.
SELECT throws_ok(
  $$ SELECT public.commerce_order_mark_refunded_manual(
       'mark-refunded-b', 'b2000000-0000-4000-8000-000000000002', 'not actually paid'
     ) $$,
  '22023', 'commerce_order_mark_refunded_invalid_status',
  'a pending_payment order cannot be marked refunded');

-- Already-refunded order (real webhook path) is a clean no-op, not an error.
SELECT lives_ok(
  $$ SELECT public.commerce_order_mark_refunded_manual(
       'mark-refunded-c', 'b2000000-0000-4000-8000-000000000003', 'already refunded via Stripe webhook'
     ) $$,
  'marking an already-refunded order is a safe no-op');

SELECT is((SELECT count(*)::int FROM public.commerce_order_operations
            WHERE order_id = 'b2000000-0000-4000-8000-000000000003'
              AND operation_type = 'order_marked_refunded'),
  0, 'no audit row is written for an order that was already refunded');

-- Unknown order id is rejected.
SELECT throws_ok(
  $$ SELECT public.commerce_order_mark_refunded_manual(
       'mark-refunded-d', 'b2000000-0000-4000-8000-000000000099', 'no such order'
     ) $$,
  '22023', 'commerce_order_not_found',
  'an unknown order id is rejected');

SELECT is((SELECT count(*)::int FROM public.commerce_order_operations
            WHERE operation_type = 'order_marked_refunded'),
  1, 'exactly one real audit row exists across the whole run (order A only)');

SELECT * FROM finish();
ROLLBACK;
