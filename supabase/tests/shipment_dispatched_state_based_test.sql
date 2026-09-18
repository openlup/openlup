-- pgTAP: shipment dispatched requires active tracking refs and does not fire
-- from an already-delivered state.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(10);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000a7', 'ship-state@example.invalid', 'Ship', 'State');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('64000000-0000-0000-0000-0000000000c7', '10000000-0000-0000-0000-0000000000a7',
        'shipping', 'ul. Testowa 7', 'Warszawa', '00-007', 'PL');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('test_carrier', 'fulfillment', 'Test Carrier', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('64000000-0000-0000-0000-0000000000b7', '10000000-0000-0000-0000-0000000000a7', 'SHIP-STATE-1', 'fulfillment_pending', 'one_time', 'PLN', 9900, 9900),
  ('64000000-0000-0000-0000-0000000000b8', '10000000-0000-0000-0000-0000000000a7', 'SHIP-STATE-2', 'fulfillment_pending', 'one_time', 'PLN', 9900, 9900),
  ('64000000-0000-0000-0000-0000000000b9', '10000000-0000-0000-0000-0000000000a7', 'SHIP-STATE-3', 'fulfillment_pending', 'one_time', 'PLN', 9900, 9900),
  ('64000000-0000-0000-0000-0000000000ba', '10000000-0000-0000-0000-0000000000a7', 'SHIP-STATE-4', 'fulfillment_pending', 'one_time', 'PLN', 9900, 9900);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot)
VALUES
  ('64000000-0000-0000-0000-0000000000f7', '64000000-0000-0000-0000-0000000000b7', '10000000-0000-0000-0000-0000000000a7', '64000000-0000-0000-0000-0000000000c7', 'ship-fo-7', 'created', 'test_carrier', '{}'::jsonb),
  ('64000000-0000-0000-0000-0000000000f8', '64000000-0000-0000-0000-0000000000b8', '10000000-0000-0000-0000-0000000000a7', '64000000-0000-0000-0000-0000000000c7', 'ship-fo-8', 'created', 'test_carrier', '{}'::jsonb),
  ('64000000-0000-0000-0000-0000000000f9', '64000000-0000-0000-0000-0000000000b9', '10000000-0000-0000-0000-0000000000a7', '64000000-0000-0000-0000-0000000000c7', 'ship-fo-9', 'created', 'test_carrier', '{}'::jsonb),
  ('64000000-0000-0000-0000-0000000000fa', '64000000-0000-0000-0000-0000000000ba', '10000000-0000-0000-0000-0000000000a7', '64000000-0000-0000-0000-0000000000c7', 'ship-fo-a', 'created', 'test_carrier', '{}'::jsonb);

INSERT INTO public.shipment_external_refs (order_id, provider_kind, provider_tracking_id, active)
VALUES
  ('64000000-0000-0000-0000-0000000000b7', 'test_carrier', 'JD0000000007', true),
  ('64000000-0000-0000-0000-0000000000b9', 'test_carrier', 'JD0000000009', true);

-- A: active tracking ref + handoff/in-transit status keeps the true-positive.
UPDATE public.commerce_fulfillment_orders SET status = 'handed_over'
 WHERE id = '64000000-0000-0000-0000-0000000000f7';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b7'),
  1, 'handoff with an active tracking ref emits one commerce.shipment.dispatched');

SELECT is(
  (SELECT payload->>'trackingNumber' FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b7'),
  'JD0000000007', 'dispatched payload uses shipment_external_refs tracking');

-- B: no tracking ref -> no future-tense dispatched email.
UPDATE public.commerce_fulfillment_orders SET status = 'handed_over'
 WHERE id = '64000000-0000-0000-0000-0000000000f8';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b8'),
  0, 'handoff without an active tracking ref does not emit dispatched');

INSERT INTO public.shipment_external_refs (order_id, provider_kind, provider_tracking_id, active)
VALUES ('64000000-0000-0000-0000-0000000000b8', 'test_carrier', 'JD0000000008', true);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b8'),
  1, 'tracking ref arriving after handoff emits dispatched via the ref trigger');

SELECT is(
  (SELECT payload->>'trackingNumber' FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b8'),
  'JD0000000008', 'ref-trigger dispatched payload uses the late shipment_external_refs tracking');

UPDATE public.shipment_external_refs
   SET tracking_url = 'https://tracking.example/JD0000000007'
 WHERE order_id = '64000000-0000-0000-0000-0000000000b7';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b7'),
  1, 'status-trigger plus ref-trigger on the same fulfillment keeps one dispatched email');

-- A later delivery should not duplicate dispatched, but still emits delivered.
UPDATE public.commerce_fulfillment_orders SET status = 'delivered'
 WHERE id = '64000000-0000-0000-0000-0000000000f7';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b7'),
  1, 'delivered transition does not duplicate dispatched');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.delivered'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b7'),
  1, 'delivered transition still emits commerce.shipment.delivered');

-- C: delivered-first with tracking gets delivered, not a future-tense dispatched.
UPDATE public.commerce_fulfillment_orders SET status = 'delivered'
 WHERE id = '64000000-0000-0000-0000-0000000000f9';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000b9'),
  0, 'direct delivered state does not emit dispatched even when tracking exists');

UPDATE public.commerce_fulfillment_orders SET status = 'delivered'
 WHERE id = '64000000-0000-0000-0000-0000000000fa';

INSERT INTO public.shipment_external_refs (order_id, provider_kind, provider_tracking_id, active)
VALUES ('64000000-0000-0000-0000-0000000000ba', 'test_carrier', 'JD0000000010', true);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND aggregate_id = '64000000-0000-0000-0000-0000000000ba'),
  0, 'tracking ref arriving after delivered still does not emit dispatched');

SELECT * FROM finish();
ROLLBACK;
