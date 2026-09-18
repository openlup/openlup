-- pgTAP: commerce.order.refunded outbox emission.
--   * a provider-confirmed refund transition emits exactly one row with the
--     same-currency refund amount sum from inbound_provider_events, not
--     commerce_orders.total_cents;
--   * a manual status flip emits nothing;
--   * mixed-currency refund evidence fails closed;
--   * a re-transition does NOT duplicate.
-- Run via: supabase db reset && supabase test db
BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000ae', 'order-refunded@example.invalid', 'Refund', 'Order');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('64000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000ae',
        'OR-ORDER-1', 'paid', 'one_time', 'PLN', 12999, 12999);
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('64000000-0000-0000-0000-0000000000b1', '64000000-0000-0000-0000-0000000000a1',
        'stripe', 'pi_refunded_a1', 'succeeded', 12999, 'PLN');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency, provider_payment_id)
VALUES ('64000000-0000-0000-0000-0000000000c1', 'one_time_order', '64000000-0000-0000-0000-0000000000a1',
        '64000000-0000-0000-0000-0000000000b1', 'succeeded', 12999, 'PLN', 'pi_refunded_a1');
INSERT INTO public.inbound_provider_events (
  id, provider, provider_event_id, event_type, provider_payment_id, payment_intent_id, amount_cents, currency, payload
)
VALUES (
  '64000000-0000-0000-0000-0000000000d1', 'stripe', 'evt_refund_a1', 'payment.refunded',
  'pi_refunded_a1', '64000000-0000-0000-0000-0000000000c1', 7000, 'PLN', '{"refund":"provider"}'::jsonb
), (
  '64000000-0000-0000-0000-0000000000d2', 'stripe', 'evt_refund_a1b', 'payment.refunded',
  'pi_refunded_a1', '64000000-0000-0000-0000-0000000000c1', 777, 'PLN', '{"refund":"provider"}'::jsonb
);

UPDATE public.commerce_orders
   SET status = 'refunded',
       metadata = metadata || '{"source":"payment.control.v0"}'::jsonb
 WHERE id = '64000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.refunded'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  1, 'refunded transition emits exactly one commerce.order.refunded event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.order.refunded'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  'order_refunded:64000000-0000-0000-0000-0000000000a1', 'idempotency_key is order_refunded:<id>');

SELECT is(
  (SELECT (payload->>'refundCents')::int FROM public.outbox_events
    WHERE idempotency_key = 'order_refunded:64000000-0000-0000-0000-0000000000a1'),
  7777, 'payload.refundCents is the same-currency provider refund sum');

SELECT is(
  (SELECT payload->>'currency' FROM public.outbox_events
    WHERE idempotency_key = 'order_refunded:64000000-0000-0000-0000-0000000000a1'),
  'PLN', 'payload.currency comes from the single provider refund currency');

SELECT is(
  (SELECT payload->>'amountSource' FROM public.outbox_events
    WHERE idempotency_key = 'order_refunded:64000000-0000-0000-0000-0000000000a1'),
  'inbound_provider_events.amount_cents_sum_same_currency',
  'payload records the provider refund sum source');

SELECT is(
  (SELECT jsonb_array_length(payload->'providerEventIds') FROM public.outbox_events
    WHERE idempotency_key = 'order_refunded:64000000-0000-0000-0000-0000000000a1'),
  2, 'payload lists every provider refund event included in the sum');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('64000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000ae',
        'OR-ORDER-2', 'paid', 'one_time', 'PLN', 12999, 12999);

UPDATE public.commerce_orders SET status = 'refunded'
 WHERE id = '64000000-0000-0000-0000-0000000000a2';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.refunded'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a2'),
  0, 'manual refunded status flip without provider event emits no customer email');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('64000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-0000000000ae',
        'OR-ORDER-3', 'paid', 'one_time', 'PLN', 12999, 12999);
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('64000000-0000-0000-0000-0000000000b3', '64000000-0000-0000-0000-0000000000a3',
        'stripe', 'pi_refunded_a3', 'succeeded', 12999, 'PLN');
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency, provider_payment_id)
VALUES ('64000000-0000-0000-0000-0000000000c3', 'one_time_order', '64000000-0000-0000-0000-0000000000a3',
        '64000000-0000-0000-0000-0000000000b3', 'succeeded', 12999, 'PLN', 'pi_refunded_a3');
INSERT INTO public.inbound_provider_events (
  id, provider, provider_event_id, event_type, provider_payment_id, payment_intent_id, amount_cents, currency, payload
)
VALUES (
  '64000000-0000-0000-0000-0000000000d3', 'stripe', 'evt_refund_a3', 'payment.refunded',
  'pi_refunded_a3', '64000000-0000-0000-0000-0000000000c3', 7000, 'PLN', '{"refund":"provider"}'::jsonb
), (
  '64000000-0000-0000-0000-0000000000d4', 'stripe', 'evt_refund_a3b', 'payment.refunded',
  'pi_refunded_a3', '64000000-0000-0000-0000-0000000000c3', 777, 'EUR', '{"refund":"provider"}'::jsonb
);

UPDATE public.commerce_orders
   SET status = 'refunded',
       metadata = metadata || '{"source":"payment.control.v0"}'::jsonb
 WHERE id = '64000000-0000-0000-0000-0000000000a3';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.refunded'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a3'),
  0, 'mixed-currency refund evidence fails closed');

UPDATE public.commerce_orders SET status = 'paid' WHERE id = '64000000-0000-0000-0000-0000000000a1';
UPDATE public.commerce_orders
   SET status = 'refunded',
       metadata = metadata || '{"source":"payment.control.v0"}'::jsonb
 WHERE id = '64000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.refunded'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  1, 'a second refunded transition does not duplicate');

SELECT * FROM finish();
ROLLBACK;
