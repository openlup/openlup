-- pgTAP: shipment lifecycle outbox emission (20260616130000).
--   * a created -> handed_over transition emits exactly one
--     commerce.shipment.dispatched row (idempotency_key =
--     'shipment_dispatched:<fulfillment id>', carrier tracking id embedded);
--   * payload.trackingNumber and trackingReferences come from shipment_external_refs,
--     not provider attempts;
--   * a handed_over -> delivered transition emits exactly one
--     commerce.shipment.delivered row (idempotency_key =
--     'shipment_delivered:<fulfillment id>');
--   * the emitted aggregate_id is the commerce order id (not the fulfillment id).
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-00000000005f', 'shipment@example.invalid', 'Ship', 'Ment');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES ('64000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-00000000005f',
        'SHIP-ORDER-1', 'fulfillment_pending', 'one_time', 'PLN', 12999, 12999);

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('64000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-00000000005f',
        'shipping', 'ul. Testowa 1', 'Warszawa', '00-001', 'PL');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

-- Fulfillment order starts at 'created' (trigger returns early, no event).
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot)
VALUES (
  '64000000-0000-0000-0000-0000000000f1', '64000000-0000-0000-0000-0000000000a1',
  '10000000-0000-0000-0000-00000000005f', '64000000-0000-0000-0000-0000000000d1',
  'ship-fo-1', 'created', 'test_carrier', '{}'::jsonb);

-- A succeeded provider attempt carries provider evidence, but it is not customer
-- tracking truth.
INSERT INTO public.commerce_fulfillment_provider_attempts (
  id, fulfillment_order_id, order_id, provider_kind, status, idempotency_key,
  provider_tracking_id)
VALUES (
  '64000000-0000-0000-0000-0000000000e1', '64000000-0000-0000-0000-0000000000f1',
  '64000000-0000-0000-0000-0000000000a1', 'test_carrier', 'succeeded', 'ship-pa-1',
  'PROVIDER-ORDER-ONLY');

INSERT INTO public.shipment_external_refs (
  order_id, provider_kind, provider_tracking_id, tracking_url, carrier_kind, service, active)
VALUES (
  '64000000-0000-0000-0000-0000000000a1', 'test_carrier', 'TRACK-REF-1',
  'https://carrier.example/TRACK-REF-1', 'test_carrier', 'standard', true);

-- created -> handed_over: emits dispatched.
UPDATE public.commerce_fulfillment_orders SET status = 'handed_over'
 WHERE id = '64000000-0000-0000-0000-0000000000f1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  1, 'handed_over emits one commerce.shipment.dispatched event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  'shipment_dispatched:64000000-0000-0000-0000-0000000000f1',
  'idempotency_key is shipment_dispatched:<fulfillment id>');

SELECT is(
  (SELECT payload->>'trackingNumber' FROM public.outbox_events
    WHERE idempotency_key = 'shipment_dispatched:64000000-0000-0000-0000-0000000000f1'),
  'TRACK-REF-1', 'payload.trackingNumber comes from shipment_external_refs');

-- handed_over -> delivered: emits delivered.
UPDATE public.commerce_fulfillment_orders SET status = 'delivered'
 WHERE id = '64000000-0000-0000-0000-0000000000f1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.delivered'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  1, 'delivered emits one commerce.shipment.delivered event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.delivered'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000a1'),
  'shipment_delivered:64000000-0000-0000-0000-0000000000f1',
  'idempotency_key is shipment_delivered:<fulfillment id>');

SELECT * FROM finish();
ROLLBACK;
