-- pgTAP: terminal order status='failed' is not a customer payment-failed email.
-- Recoverable declines are represented by pending_payment metadata and covered
-- in payment_failed_recoverable_decline_scope_test.sql.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(3);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000ac', 'payment-failed@example.invalid', 'Pay', 'Failed');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('62000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000ac',
        'PF-ORDER-1', 'pending_payment', 'one_time', 'PLN', 12999, 12999);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = '62000000-0000-0000-0000-0000000000a1'),
  0, 'no event while pending_payment');

UPDATE public.commerce_orders SET status = 'failed'
 WHERE id = '62000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = '62000000-0000-0000-0000-0000000000a1'),
  0, 'terminal failed transition does not emit commerce.payment.failed');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.checkout.expired'
      AND aggregate_id = '62000000-0000-0000-0000-0000000000a1'),
  0, 'terminal failed transition does not emit checkout-expired copy either');

SELECT * FROM finish();
ROLLBACK;
