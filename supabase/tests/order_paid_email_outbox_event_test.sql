-- pgTAP: commerce.order.paid.email outbox emission (20260614120000).
--   * the same paid transition that emits commerce.order.paid ALSO emits exactly
--     one commerce.order.paid.email row with idempotency_key
--     = 'order_paid_email:<id>' and the same orderId/orderUuid/mode/occurredAt
--     payload shape;
--   * a re-transition to paid does NOT duplicate (UNIQUE + ON CONFLICT);
--   * a non-paid transition emits no email event.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(7);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000ab', 'order-paid-email@example.invalid', 'Paid', 'Email');

-- pending_payment -> paid emits one email event alongside the fulfillment event.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency)
VALUES ('61000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000ab',
        'OPE-ORDER-1', 'pending_payment', 'one_time', 'PLN');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND aggregate_id = '61000000-0000-0000-0000-0000000000a1'),
  0, 'no email event while pending_payment');

UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '61000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND aggregate_id = '61000000-0000-0000-0000-0000000000a1'),
  1, 'paid transition emits exactly one commerce.order.paid.email event');

-- both the fulfillment and the email event coexist for the same order.
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type IN ('commerce.order.paid', 'commerce.order.paid.email')
      AND aggregate_id = '61000000-0000-0000-0000-0000000000a1'),
  2, 'fulfillment + email events both emitted for the paid order');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND aggregate_id = '61000000-0000-0000-0000-0000000000a1'),
  'order_paid_email:61000000-0000-0000-0000-0000000000a1',
  'idempotency_key is order_paid_email:<order id>');

SELECT is(
  (SELECT payload->>'orderId' FROM public.outbox_events
    WHERE idempotency_key = 'order_paid_email:61000000-0000-0000-0000-0000000000a1'),
  'order_61000000-0000-0000-0000-0000000000a1', 'payload.orderId is order_<uuid>');

-- re-transition to paid does not duplicate the email event.
UPDATE public.commerce_orders SET status = 'fulfillment_pending'
 WHERE id = '61000000-0000-0000-0000-0000000000a1';
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '61000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND aggregate_id = '61000000-0000-0000-0000-0000000000a1'),
  1, 'a second paid transition does not duplicate the email event');

-- a non-paid order emits no email event.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency)
VALUES ('61000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000ab',
        'OPE-ORDER-3', 'pending_payment', 'one_time', 'PLN');
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '61000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid.email'
      AND aggregate_id = '61000000-0000-0000-0000-0000000000c1'),
  0, 'an order that never reaches paid emits no email event');

SELECT * FROM finish();
ROLLBACK;
