-- pgTAP: terminal expiry is separated from recoverable payment failure.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(3);

INSERT INTO public.clients (id, email, first_name)
VALUES ('30000000-0000-0000-0000-0000000000a0', 'payfail@example.invalid', 'Pay');

-- Expired one-time order emits checkout-expired, not payment-failed.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('30000000-0000-0000-0000-0000000000e1', '30000000-0000-0000-0000-0000000000a0',
        'PAYFAIL-EXPIRED', 'expired', 'one_time', 'PLN', 12999, 12999);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND idempotency_key = 'payment_failed:30000000-0000-0000-0000-0000000000e1'),
  0, 'an expired order does not emit commerce.payment.failed');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.checkout.expired'
      AND idempotency_key = 'checkout_expired:30000000-0000-0000-0000-0000000000e1'),
  1, 'an expired order emits one commerce.checkout.expired event');

-- Terminal failed is not a recoverable decline email.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('30000000-0000-0000-0000-0000000000f1', '30000000-0000-0000-0000-0000000000a0',
        'PAYFAIL-FAILED', 'failed', 'one_time', 'PLN', 12999, 12999);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND idempotency_key = 'payment_failed:30000000-0000-0000-0000-0000000000f1'),
  0, 'a terminal failed order does not emit commerce.payment.failed');

SELECT * FROM finish();
ROLLBACK;
