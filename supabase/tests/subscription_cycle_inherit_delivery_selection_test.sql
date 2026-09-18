-- pgTAP: subscription_cycle orders inherit selectedDelivery from the subscription's
-- anchor order (20260704200000), so renewals route to the chosen provider instead of
-- the simulator.
--   * a cycle order with no selection inherits the anchor order's
--     runtimeFinalize.selectedDelivery (providerKind=omnipack)
--   * an explicit selection on the cycle order is NOT overwritten
--   * a one_time order is never touched by the trigger
--   * a cycle order whose subscription has no selection anywhere stays without one
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('d5000000-0000-0000-0000-0000000000aa', 'cycle-delivery@example.invalid', 'Cyc', 'Del');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('d5100000-0000-0000-0000-0000000000a1', 'd5000000-0000-0000-0000-0000000000aa', 30, 'PLN',
        'active', '2026-07-20T08:00:00Z');

-- Anchor order (the subscription_initial checkout): carries the omnipack selection in
-- runtimeFinalize, exactly where W1 persists it. Older created_at so it wins the ORDER BY.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, subscription_id, metadata, created_at)
VALUES ('d5200000-0000-0000-0000-0000000000a1', 'd5000000-0000-0000-0000-0000000000aa',
        'SCD-ANCHOR-1', 'pending_payment', 'one_time', 'PLN', 'd5100000-0000-0000-0000-0000000000a1',
        jsonb_build_object('runtimeFinalize', jsonb_build_object('selectedDelivery', jsonb_build_object(
          'kind', 'parcel-locker', 'deliveryKind', 'parcel-locker', 'providerKind', 'omnipack',
          'carrierKind', 'inpost', 'carrierCode', 'INPOST', 'serviceCode', 'INPOST_LOCKER_STANDARD',
          'pickupPoint', jsonb_build_object(
            'id', 'WAW01A',
            'provider', 'inpost',
            'name', 'Paczkomat WAW01A',
            'address', jsonb_build_object('line1', 'Prosta 20', 'postalCode', '00-850', 'city', 'Warszawa', 'country', 'PL')
          )
        ))),
        '2026-01-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('d5300000-0000-0000-0000-0000000000a1', 'd5100000-0000-0000-0000-0000000000a1', 1,
        '2026-07-20T08:00:00Z', 'planned', 'scd-cycle-1');

-- The renewal cycle order, created WITHOUT a selection (as the cycle-order RPC does today).
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, subscription_id, subscription_cycle_id, metadata)
VALUES ('d5200000-0000-0000-0000-0000000000a2', 'd5000000-0000-0000-0000-0000000000aa',
        'SCD-CYCLE-1', 'pending_payment', 'subscription_cycle', 'PLN',
        'd5100000-0000-0000-0000-0000000000a1', 'd5300000-0000-0000-0000-0000000000a1',
        jsonb_build_object('paymentStatus', 'pending', 'source', 'subscription.own_engine.v0'));

SELECT is(
  (SELECT metadata #>> '{selectedDelivery,providerKind}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a2'),
  'omnipack', 'cycle order inherited the anchor selectedDelivery.providerKind');

SELECT is(
  (SELECT metadata #>> '{selectedDelivery,serviceCode}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a2'),
  'INPOST_LOCKER_STANDARD', 'inherited the full canonical selection (serviceCode)');

SELECT is(
  (SELECT metadata #>> '{selectedDelivery,pickupPoint,id}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a2'),
  'WAW01A', 'inherited InPost pickup point evidence for subscription renewal');

-- A later saved subscription delivery preference overrides the anchor order for
-- future renewal orders, so customer-account delivery edits affect the next box.
INSERT INTO public.customer_delivery_preferences (
  client_id, scope, delivery_kind, provider_kind, carrier_kind, carrier_code, service_code,
  pickup_point_id, pickup_point_name, pickup_point_address, last_selected_at, source
)
VALUES (
  'd5000000-0000-0000-0000-0000000000aa', 'subscription', 'courier', 'omnipack',
  'dpd', 'DPD', 'DPD_COURIER_STANDARD', NULL, NULL, NULL,
  '2026-07-01T10:00:00Z', 'customer_account'
);

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('d5300000-0000-0000-0000-0000000000a4', 'd5100000-0000-0000-0000-0000000000a1', 4,
        '2026-10-20T08:00:00Z', 'planned', 'scd-cycle-4');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, subscription_id, subscription_cycle_id, metadata)
VALUES ('d5200000-0000-0000-0000-0000000000a6', 'd5000000-0000-0000-0000-0000000000aa',
        'SCD-CYCLE-4', 'pending_payment', 'subscription_cycle', 'PLN',
        'd5100000-0000-0000-0000-0000000000a1', 'd5300000-0000-0000-0000-0000000000a4',
        jsonb_build_object('paymentStatus', 'pending', 'source', 'subscription.own_engine.v0'));

SELECT is(
  (SELECT metadata #>> '{selectedDelivery,serviceCode}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a6'),
  'DPD_COURIER_STANDARD', 'cycle order prefers the saved subscription delivery service over the anchor');

SELECT is(
  (SELECT metadata #>> '{selectedDelivery,carrierKind}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a6'),
  'dpd', 'saved delivery preference carries the selected carrier kind into renewal metadata');

SELECT ok(
  (SELECT metadata #>> '{selectedDelivery,pickupPoint,id}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a6') IS NULL,
  'courier delivery preference does not carry the old locker pickup point');

-- Explicit selection on the cycle order is preserved (not overwritten by the anchor).
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('d5300000-0000-0000-0000-0000000000a2', 'd5100000-0000-0000-0000-0000000000a1', 2,
        '2026-08-20T08:00:00Z', 'planned', 'scd-cycle-2');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, subscription_id, subscription_cycle_id, metadata)
VALUES ('d5200000-0000-0000-0000-0000000000a3', 'd5000000-0000-0000-0000-0000000000aa',
        'SCD-CYCLE-2', 'pending_payment', 'subscription_cycle', 'PLN',
        'd5100000-0000-0000-0000-0000000000a1', 'd5300000-0000-0000-0000-0000000000a2',
        jsonb_build_object('selectedDelivery', jsonb_build_object('providerKind', 'simulator')));

SELECT is(
  (SELECT metadata #>> '{selectedDelivery,providerKind}' FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a3'),
  'simulator', 'explicit cycle-order selection is not overwritten');

-- A one_time order is never touched by the trigger.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, subscription_id, metadata)
VALUES ('d5200000-0000-0000-0000-0000000000a4', 'd5000000-0000-0000-0000-0000000000aa',
        'SCD-ONETIME-1', 'pending_payment', 'one_time', 'PLN', 'd5100000-0000-0000-0000-0000000000a1',
        jsonb_build_object('paymentStatus', 'pending'));

SELECT ok(
  (SELECT NOT (metadata ? 'selectedDelivery') FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a4'),
  'one_time order is left untouched by the cycle-inherit trigger');

-- A cycle order whose subscription has no selection anywhere stays without one.
DELETE FROM public.customer_delivery_preferences
 WHERE client_id = 'd5000000-0000-0000-0000-0000000000aa';

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('d5100000-0000-0000-0000-0000000000a2', 'd5000000-0000-0000-0000-0000000000aa', 30, 'PLN',
        'active', '2026-07-20T08:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('d5300000-0000-0000-0000-0000000000a3', 'd5100000-0000-0000-0000-0000000000a2', 1,
        '2026-07-20T08:00:00Z', 'planned', 'scd-cycle-3');
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, subscription_id, subscription_cycle_id, metadata)
VALUES ('d5200000-0000-0000-0000-0000000000a5', 'd5000000-0000-0000-0000-0000000000aa',
        'SCD-CYCLE-3', 'pending_payment', 'subscription_cycle', 'PLN',
        'd5100000-0000-0000-0000-0000000000a2', 'd5300000-0000-0000-0000-0000000000a3',
        jsonb_build_object('paymentStatus', 'pending'));

SELECT ok(
  (SELECT NOT (metadata ? 'selectedDelivery') FROM public.commerce_orders
    WHERE id = 'd5200000-0000-0000-0000-0000000000a5'),
  'cycle order with no anchor selection stays without selectedDelivery');

SELECT * FROM finish();
ROLLBACK;
