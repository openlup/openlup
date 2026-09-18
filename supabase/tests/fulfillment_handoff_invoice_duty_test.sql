-- pgTAP: durable fulfillment handoff invoice duty producer.

BEGIN;
SELECT plan(10);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES (
  '73000000-0000-0000-0000-000000000001',
  'handoff-duty@example.invalid',
  'Handoff',
  'Duty'
);

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES (
  '73000000-0000-0000-0000-000000000002',
  '73000000-0000-0000-0000-000000000001',
  'shipping',
  'ul. Trwala 1',
  'Warszawa',
  '00-001',
  'PL'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency, subtotal_cents, total_cents
) VALUES
  (
    '73000000-0000-0000-0000-000000000011',
    '73000000-0000-0000-0000-000000000001',
    'HANDOFF-DUTY-1',
    'fulfillment_pending',
    'one_time',
    'PLN',
    1000,
    1000
  ),
  (
    '73000000-0000-0000-0000-000000000012',
    '73000000-0000-0000-0000-000000000001',
    'HANDOFF-DUTY-2',
    'fulfillment_pending',
    'one_time',
    'PLN',
    1000,
    1000
  );

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot
) VALUES (
  '73000000-0000-0000-0000-000000000021',
  '73000000-0000-0000-0000-000000000011',
  '73000000-0000-0000-0000-000000000001',
  '73000000-0000-0000-0000-000000000002',
  'handoff-duty-fulfillment-1',
  'created',
  '{}'::jsonb
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000021'),
  0,
  'a fulfillment without handed_over_at creates no duty event'
);

UPDATE public.commerce_fulfillment_orders
   SET status = 'handed_over',
       handed_over_at = '2026-07-16T10:30:00Z'::timestamptz
 WHERE id = '73000000-0000-0000-0000-000000000021';

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000021'),
  1,
  'first durable handoff atomically creates one duty event'
);

SELECT is(
  (SELECT aggregate_type FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND idempotency_key = 'fulfillment_handed_over:73000000-0000-0000-0000-000000000021'),
  'commerce_fulfillment_order',
  'duty uses an isolated fulfillment aggregate so an older runtime cannot block order events'
);

SELECT is(
  (SELECT aggregate_id FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND idempotency_key = 'fulfillment_handed_over:73000000-0000-0000-0000-000000000021'),
  '73000000-0000-0000-0000-000000000021'::uuid,
  'duty aggregate identity is the fulfillment order id'
);

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000021'),
  'fulfillment_handed_over:73000000-0000-0000-0000-000000000021',
  'duty event uses the stable fulfillment identity'
);

SELECT is(
  (SELECT payload->>'fulfillmentOrderId' FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000021'),
  '73000000-0000-0000-0000-000000000021',
  'payload carries the fulfillment order id'
);

SELECT is(
  (SELECT payload->>'occurredAt' FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000021'),
  '2026-07-16T10:30:00+00:00',
  'payload occurrence time is the durable handoff time'
);

UPDATE public.commerce_fulfillment_orders
   SET handed_over_at = '2026-07-16T10:31:00Z'::timestamptz
 WHERE id = '73000000-0000-0000-0000-000000000021';

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000021'),
  1,
  'a later non-null handoff timestamp cannot duplicate the duty event'
);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot, handed_over_at, delivered_at
) VALUES (
  '73000000-0000-0000-0000-000000000022',
  '73000000-0000-0000-0000-000000000012',
  '73000000-0000-0000-0000-000000000001',
  '73000000-0000-0000-0000-000000000002',
  'handoff-duty-fulfillment-2',
  'delivered',
  '{}'::jsonb,
  '2026-07-16T11:00:00Z'::timestamptz,
  '2026-07-16T12:00:00Z'::timestamptz
);

SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000022'),
  1,
  'a delivered-first insert with handoff evidence creates the duty event'
);

SELECT is(
  (SELECT payload->>'orderUuid' FROM public.outbox_events
    WHERE event_type = 'commerce.fulfillment.handed_over'
      AND aggregate_id = '73000000-0000-0000-0000-000000000022'),
  '73000000-0000-0000-0000-000000000012',
  'delivered-first payload preserves the commerce order aggregate'
);

SELECT * FROM finish();
ROLLBACK;
