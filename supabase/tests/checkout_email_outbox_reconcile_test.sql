-- pgTAP: checkout email outbox reconcile is idempotent and respects terminal
-- payment semantics.
--
-- Run via: supabase test db supabase/tests/checkout_email_outbox_reconcile_test.sql

BEGIN;
SELECT plan(16);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('4a100000-0000-4000-8000-000000000001', 'checkout-reconcile@example.invalid', 'Checkout', 'Reconcile');

-- Insert with final status first, then delete trigger-emitted rows to simulate a
-- historical missed deployment/trigger window without disabling triggers.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('4a100000-0000-4000-8000-000000000101', '4a100000-0000-4000-8000-000000000001', 'REC-PAID-1', 'paid', 'one_time', 'PLN', 4200, 4200),
  ('4a100000-0000-4000-8000-000000000201', '4a100000-0000-4000-8000-000000000001', 'REC-EXP-1', 'expired', 'one_time', 'PLN', 9900, 9900),
  ('4a100000-0000-4000-8000-000000000301', '4a100000-0000-4000-8000-000000000001', 'REC-PEND-1', 'pending_payment', 'one_time', 'PLN', 12300, 12300),
  ('4a100000-0000-4000-8000-000000000401', '4a100000-0000-4000-8000-000000000001', 'REC-EXP-2', 'expired', 'one_time', 'PLN', 7700, 7700);

DELETE FROM public.outbox_events
 WHERE aggregate_id IN (
   '4a100000-0000-4000-8000-000000000101',
   '4a100000-0000-4000-8000-000000000201',
   '4a100000-0000-4000-8000-000000000301',
   '4a100000-0000-4000-8000-000000000401'
 );

DELETE FROM public.commerce_checkout_recovery_tokens
 WHERE order_id IN (
   '4a100000-0000-4000-8000-000000000201',
   '4a100000-0000-4000-8000-000000000401'
 );

INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
VALUES (
  'commerce_order',
  '4a100000-0000-4000-8000-000000000401',
  'commerce.payment.failed',
  'payment_failed:4a100000-0000-4000-8000-000000000401',
  jsonb_build_object('orderId', 'order_4a100000-0000-4000-8000-000000000401', 'orderUuid', '4a100000-0000-4000-8000-000000000401'),
  jsonb_build_object('source', 'pgTAP-preexisting-recoverable-decline')
);

SELECT is(
  (public.commerce_reconcile_checkout_email_outbox(50) #>> '{inserted,commerceOrderPaid}')::integer,
  0,
  'email reconcile does not backfill commerce.order.paid fulfillment events'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND idempotency_key = 'order_paid_email:4a100000-0000-4000-8000-000000000101'),
  1,
  'paid order gets exactly one paid email event'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND idempotency_key = 'payment_failed:4a100000-0000-4000-8000-000000000201'),
  0,
  'expired terminal order does not get a payment failed event'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.checkout.expired'
      AND idempotency_key = 'checkout_expired:4a100000-0000-4000-8000-000000000201'),
  1,
  'expired terminal order gets exactly one checkout expired event'
);

SELECT is(
  (SELECT (payload->>'totalCents')::integer FROM public.outbox_events
    WHERE idempotency_key = 'checkout_expired:4a100000-0000-4000-8000-000000000201'),
  9900,
  'checkout expired payload mirrors order total'
);

SELECT ok(
  (SELECT payload->>'recoveryToken' FROM public.outbox_events
    WHERE idempotency_key = 'checkout_expired:4a100000-0000-4000-8000-000000000201') LIKE 'rcv_%',
  'checkout expired reconcile payload carries a checkout-recovery token'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_checkout_recovery_tokens t
    WHERE t.order_id = '4a100000-0000-4000-8000-000000000201'
      AND t.token_hash = encode(sha256(convert_to((
        SELECT payload->>'recoveryToken'
          FROM public.outbox_events
         WHERE idempotency_key = 'checkout_expired:4a100000-0000-4000-8000-000000000201'
      ), 'UTF8')), 'hex')),
  1,
  'checkout expired reconcile atomically stores the matching token hash'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_checkout_recovery_tokens t
    WHERE t.order_id = '4a100000-0000-4000-8000-000000000201'
      AND t.metadata::text LIKE '%' || (
        SELECT payload->>'recoveryToken'
          FROM public.outbox_events
         WHERE idempotency_key = 'checkout_expired:4a100000-0000-4000-8000-000000000201'
      ) || '%'),
  0,
  'checkout expired reconcile never stores the raw token outside outbox payload'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE aggregate_id = '4a100000-0000-4000-8000-000000000301'),
  0,
  'pending_payment recoverable-style order is not treated as terminal failed'
);

SELECT is(
  (public.commerce_reconcile_checkout_email_outbox(50) #>> '{inserted,commerceOrderPaidEmail}')::integer,
  0,
  'second reconcile inserts no duplicate paid email event'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '4a100000-0000-4000-8000-000000000101'),
  0,
  'paid email repair does not create fulfillment outbox rows'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.checkout.expired'
      AND aggregate_id = '4a100000-0000-4000-8000-000000000201'),
  1,
  'terminal checkout expired email event remains exactly-once after replay'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_checkout_recovery_tokens
    WHERE order_id = '4a100000-0000-4000-8000-000000000201'),
  1,
  'terminal checkout expired recovery token remains exactly-once after replay'
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.checkout.expired'
      AND aggregate_id = '4a100000-0000-4000-8000-000000000401'),
  1,
  'terminal expiry reconcile still emits checkout expired after a prior recoverable-decline email'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_checkout_recovery_tokens
    WHERE order_id = '4a100000-0000-4000-8000-000000000401'),
  1,
  'terminal expiry reconcile still mints one recovery token after a prior recoverable-decline email'
);

SELECT is(
  (SELECT metadata->>'source' FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND aggregate_id = '4a100000-0000-4000-8000-000000000101'),
  'commerce_reconcile_checkout_email_outbox',
  'repaired rows carry audit source metadata'
);

SELECT * FROM finish();
ROLLBACK;
