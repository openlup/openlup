-- pgTAP: customer-visible shipment exception outbox emission.
--   * internal/manual-review fulfillment_exception holds do not send customer
--     shipment-exception emails;
--   * the verified live Omnipack provider exception RPC is replay-safe and
--     still emits before delivery;
--   * a provider exception first observed after durable handoff keeps the OMS
--     hold/audit trail without emitting a contradictory customer email;
--   * dead generic/carrier/operator allowlist paths do not pretend to exist.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(39);

INSERT INTO public.admin_users (id, email, role)
VALUES ('65000000-0000-0000-0000-0000000000c1', 'shipment-exception-admin@example.invalid', 'admin');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000e1', 'shipment-exception@example.invalid', 'Ship', 'Exception');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('65000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-1', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-2', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-3', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-4', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a5', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-5', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a6', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-6', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a7', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-7', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999),
  ('65000000-0000-0000-0000-0000000000a8', '10000000-0000-0000-0000-0000000000e1', 'SHIP-EXC-8', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999);

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('65000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000e1',
        'shipping', 'ul. Dostarczona 1', 'Warszawa', '00-001', 'PL');

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot
)
VALUES
  ('65000000-0000-0000-0000-0000000000f2', '65000000-0000-0000-0000-0000000000a2',
   '10000000-0000-0000-0000-0000000000e1', '65000000-0000-0000-0000-0000000000d1',
   'ship-exc-fulfillment-before-delivery', 'created', '{}'::jsonb),
  ('65000000-0000-0000-0000-0000000000f7', '65000000-0000-0000-0000-0000000000a7',
   '10000000-0000-0000-0000-0000000000e1', '65000000-0000-0000-0000-0000000000d1',
   'ship-exc-fulfillment-handed-over', 'handed_over', '{}'::jsonb),
  ('65000000-0000-0000-0000-0000000000f8', '65000000-0000-0000-0000-0000000000a8',
   '10000000-0000-0000-0000-0000000000e1', '65000000-0000-0000-0000-0000000000d1',
   'ship-exc-fulfillment-delivered-legacy', 'delivered', '{}'::jsonb);

UPDATE public.commerce_fulfillment_orders
   SET handed_over_at = '2026-07-16T08:00:00Z'
 WHERE id = '65000000-0000-0000-0000-0000000000f7';

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000b1',
  '65000000-0000-0000-0000-0000000000a1',
  'active',
  'fulfillment_exception',
  'ship-exc-internal',
  '{"source":"commerce.fulfillment.split_shipment_preflight"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a1'),
  0, 'internal split-shipment/manual-review hold does not emit a customer shipment exception');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider',
    '65000000-0000-0000-0000-0000000000a2',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f2"}'::jsonb
  ) $$,
  'live Omnipack provider exception RPC creates the hold before delivery'
);

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider',
    '65000000-0000-0000-0000-0000000000a2',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f2"}'::jsonb
  ) $$,
  'replaying the same provider exception RPC is safe'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a2'
      AND reason = 'fulfillment_exception'
      AND status = 'active'),
  1, 'provider exception replay keeps exactly one active OMS hold');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a2'),
  1, 'live Omnipack provider fulfillment exception emits a customer shipment exception');

SELECT is(
  (SELECT payload->>'customerNotification' FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a2'),
  'shipment_exception', 'customer-visible shipment event carries the explicit notification marker');

SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = '65000000-0000-0000-0000-0000000000a2'),
  'fulfillment_pending', 'provider CANCELLED evidence does not cancel or refund the commerce order');

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider',
    '65000000-0000-0000-0000-0000000000a3',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED"}'::jsonb
  ) $$,
  '22023', 'commerce_fulfillment_idempotency_order_mismatch',
  'a provider occurrence key cannot replay against a different commerce order'
);

INSERT INTO public.commerce_order_operations (
  order_id, operation_type, source, idempotency_key, payload
)
VALUES (
  '65000000-0000-0000-0000-0000000000a3',
  'support_note',
  'commerce.oms.v0',
  'ship-exc-foreign-operation:operation',
  '{}'::jsonb
);

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-foreign-operation',
    '65000000-0000-0000-0000-0000000000a3',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED"}'::jsonb
  ) $$,
  '22023', 'commerce_fulfillment_idempotency_operation_mismatch',
  'a foreign operation cannot impersonate provider-exception replay evidence'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a3'),
  0, 'a foreign operation collision creates no fulfillment hold');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a3'),
  0, 'a foreign operation collision creates no customer reassurance event');

INSERT INTO public.commerce_order_holds (
  order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000a4',
  'active',
  'manual_support',
  'ship-exc-foreign-hold',
  '{"source":"shipment_exception_outbox_event_test"}'::jsonb
);

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-foreign-hold',
    '65000000-0000-0000-0000-0000000000a4',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED"}'::jsonb
  ) $$,
  '22023', 'commerce_fulfillment_idempotency_hold_mismatch',
  'a foreign hold cannot impersonate a fulfillment-exception occurrence'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE idempotency_key = 'ship-exc-foreign-hold:operation'),
  0, 'a foreign hold collision rolls back the reserved provider operation');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a4'),
  0, 'a foreign hold collision creates no customer reassurance event');

INSERT INTO public.commerce_order_operations (
  order_id, hold_id, operation_type, source, idempotency_key, payload
)
VALUES (
  '65000000-0000-0000-0000-0000000000a5',
  NULL,
  'hold_created',
  'commerce.fulfillment.omnipack_provider_exception',
  'ship-exc-null-hold-operation:operation',
  '{}'::jsonb
);

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-null-hold-operation',
    '65000000-0000-0000-0000-0000000000a5',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED"}'::jsonb
  ) $$,
  '22023', 'commerce_fulfillment_idempotency_operation_mismatch',
  'provider-shaped replay evidence without its fulfillment hold fails closed'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a5'),
  0, 'invalid replay evidence creates no fulfillment hold');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a5'),
  0, 'invalid replay evidence creates no customer reassurance event');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider-active-repeat',
    '65000000-0000-0000-0000-0000000000a2',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f2"}'::jsonb
  ) $$,
  'a new provider occurrence does not duplicate an active exception hold'
);

SELECT lives_ok(
  $$ SELECT public.commerce_oms_release_hold(
    'ship-exc-release-first-occurrence',
    (SELECT id FROM public.commerce_order_holds
      WHERE order_id = '65000000-0000-0000-0000-0000000000a2'
        AND reason = 'fulfillment_exception'
        AND status = 'active'),
    'provider exception reviewed',
    '65000000-0000-0000-0000-0000000000c1',
    '{"source":"shipment_exception_outbox_event_test"}'::jsonb
  ) $$,
  'support can release the first provider exception hold through the audited OMS RPC'
);

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider-active-repeat',
    '65000000-0000-0000-0000-0000000000a2',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f2"}'::jsonb
  ) $$,
  'replaying the active-period occurrence after release reuses its durable operation'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a2'
      AND reason = 'fulfillment_exception'),
  1, 'the released occurrence replay creates no new hold');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a2'),
  1, 'the released occurrence replay creates no new reassurance event');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider-new-occurrence',
    '65000000-0000-0000-0000-0000000000a2',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f2"}'::jsonb
  ) $$,
  'a later provider exception occurrence reopens manual review'
);

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-omnipack-provider-new-occurrence',
    '65000000-0000-0000-0000-0000000000a2',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f2"}'::jsonb
  ) $$,
  'an exact replay of the later occurrence is safe'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a2'
      AND reason = 'fulfillment_exception'),
  2, 'two provider exception occurrences leave two historical holds');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a2'
      AND reason = 'fulfillment_exception'
      AND status = 'active'),
  1, 'only the later provider exception hold remains active');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a2'
      AND reason = 'fulfillment_exception'
      AND status = 'released'),
  1, 'the first provider exception hold remains in the audited released history');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a2'),
  2, 'two provider exception occurrences emit two reassurance events without replay duplicates');

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000b3',
  '65000000-0000-0000-0000-0000000000a3',
  'active',
  'fulfillment_exception',
  'ship-exc-generic-provider',
  '{"source":"commerce.fulfillment.provider_exception"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a3'),
  0, 'dead generic provider source no longer emits a customer shipment exception');

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000b4',
  '65000000-0000-0000-0000-0000000000a4',
  'active',
  'fulfillment_exception',
  'ship-exc-operator',
  '{"customerNotification":"shipment_exception"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a4'),
  0, 'dead operator customerNotification marker no longer emits a customer shipment exception');

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000b5',
  '65000000-0000-0000-0000-0000000000a5',
  'active',
  'fulfillment_exception',
  'ship-exc-carrier',
  '{"source":"carrier.webhook.shipment_exception"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a5'),
  0, 'dead carrier webhook source no longer emits a customer shipment exception');

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000b6',
  '65000000-0000-0000-0000-0000000000a6',
  'active',
  'manual_support',
  'ship-exc-manual-support',
  '{"customerNotification":"shipment_exception"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a6'),
  0, 'non-fulfillment holds do not emit shipment exception even with a notification marker');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'ship-exc-delivered-provider',
    '65000000-0000-0000-0000-0000000000a7',
    'provider_cancelled',
    '{"providerStatus":"CANCELLED","fulfillmentOrderId":"65000000-0000-0000-0000-0000000000f7"}'::jsonb
  ) $$,
  'provider exception after durable handoff remains actionable'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '65000000-0000-0000-0000-0000000000a7'
      AND reason = 'fulfillment_exception'
      AND status = 'active'),
  1, 'post-handoff provider exception keeps one active OMS hold');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE order_id = '65000000-0000-0000-0000-0000000000a7'
      AND operation_type = 'hold_created'
      AND source = 'commerce.fulfillment.omnipack_provider_exception'),
  1, 'post-handoff provider exception keeps the OMS audit operation');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a7'),
  0, 'post-handoff provider exception suppresses the contradictory customer event');

SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = '65000000-0000-0000-0000-0000000000a7'),
  'fulfillment_pending', 'post-handoff provider exception does not cancel or refund the commerce order');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type IN ('commerce.order.canceled', 'commerce.order.refunded')
      AND aggregate_id IN (
        '65000000-0000-0000-0000-0000000000a2',
        '65000000-0000-0000-0000-0000000000a7'
      )),
  0, 'provider CANCELLED evidence emits neither cancellation nor refund events');

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
)
VALUES (
  '65000000-0000-0000-0000-0000000000b8',
  '65000000-0000-0000-0000-0000000000a8',
  'active',
  'fulfillment_exception',
  'ship-exc-delivered-legacy-provider',
  '{"source":"commerce.fulfillment.omnipack_provider_exception","fulfillmentOrderId":"stale-wrong-id"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '65000000-0000-0000-0000-0000000000a8'),
  0, 'legacy delivered truth cannot be bypassed by stale fulfillment metadata');

SELECT * FROM finish();
ROLLBACK;
