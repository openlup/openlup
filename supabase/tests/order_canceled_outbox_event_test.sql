-- pgTAP: commerce.order.canceled outbox emission (20260615120000).
--   * a paid -> cancelled transition emits exactly one commerce.order.canceled
--     row (idempotency_key = 'order_canceled:<id>', total embedded);
--   * a fulfillment_pending -> cancelled transition also emits;
--   * a pending_payment -> cancelled transition emits NOTHING (anti-spam gate);
--   * admin fulfillment cancellation does not mutate commerce_orders.status and
--     therefore emits no customer order-canceled email.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(8);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000ad', 'order-canceled@example.invalid', 'Cancel', 'Order');

-- paid -> cancelled: emits.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('63000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000ad',
        'OC-ORDER-1', 'paid', 'one_time', 'PLN', 12999, 12999);
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '63000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.canceled'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000a1'),
  1, 'paid -> cancelled emits one commerce.order.canceled event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.order.canceled'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000a1'),
  'order_canceled:63000000-0000-0000-0000-0000000000a1',
  'idempotency_key is order_canceled:<order id>');

SELECT is(
  (SELECT (payload->>'totalCents')::int FROM public.outbox_events
    WHERE idempotency_key = 'order_canceled:63000000-0000-0000-0000-0000000000a1'),
  12999, 'payload.totalCents mirrors the order total');

-- fulfillment_pending -> cancelled: also emits.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('63000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000ad',
        'OC-ORDER-2', 'fulfillment_pending', 'one_time', 'PLN', 5000, 5000);
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '63000000-0000-0000-0000-0000000000b1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.canceled'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000b1'),
  1, 'fulfillment_pending -> cancelled also emits');

-- pending_payment -> cancelled (abandoned): emits NOTHING (anti-spam gate).
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('63000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000ad',
        'OC-ORDER-3', 'pending_payment', 'one_time', 'PLN', 5000, 5000);
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '63000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.canceled'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000c1'),
  0, 'pending_payment -> cancelled emits nothing (anti-spam gate)');

-- Real admin/operator cancel path: cancels fulfillment only, not the commerce order.
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('63000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000ad',
        'shipping', 'ul. Cancel 1', 'Warszawa', '00-001', 'PL');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('63000000-0000-0000-0000-0000000000d2', '10000000-0000-0000-0000-0000000000ad',
        'OC-ADMIN-1', 'paid', 'one_time', 'PLN', 9900, 9900);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot)
VALUES (
  '63000000-0000-0000-0000-0000000000f1', '63000000-0000-0000-0000-0000000000d2',
  '10000000-0000-0000-0000-0000000000ad', '63000000-0000-0000-0000-0000000000d1',
  'order-cancel-fulfillment-1', 'created', '{}'::jsonb);

SELECT is(
  (public.commerce_fulfillment_cancel_order(
    'order-cancel-fulfillment-op-1',
    '63000000-0000-0000-0000-0000000000f1',
    'operator_requested'
  )->>'status'),
  'cancelled', 'admin cancel RPC cancels the fulfillment order');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = '63000000-0000-0000-0000-0000000000d2'),
  'paid', 'admin cancel RPC leaves commerce_orders.status paid');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.canceled'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000d2'),
  0, 'admin cancel RPC emits no commerce.order.canceled event');

SELECT * FROM finish();
ROLLBACK;
