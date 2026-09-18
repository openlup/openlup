-- pgTAP: a provider tracking identity belongs to exactly one commerce order.

BEGIN;
SELECT plan(11);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('71000000-0000-4000-8000-000000000001', 'tracking-owner@example.invalid', 'Tracking', 'Owner');

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents
) VALUES
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
   'TRACK-OWNER-A', 'fulfillment_pending', 'one_time', 'PLN', 9900, 9900),
  ('72000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001',
   'TRACK-OWNER-B', 'fulfillment_pending', 'one_time', 'PLN', 9900, 9900),
  ('72000000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000001',
   'TRACK-UNPAID', 'pending_payment', 'one_time', 'PLN', 9900, 9900);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_ref
) VALUES (
  '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
  28, 'PLN', 'active', '2026-08-01T08:00:00Z', 'pm_tracking_owner'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
) VALUES (
  '74000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001',
  1, '2026-08-01T08:00:00Z', 'planned', 'tracking-owner-cycle-1'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents,
  subscription_id, subscription_cycle_id
) VALUES (
  '72000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000001',
  'TRACK-CYCLE-UNPAID', 'paid', 'subscription_cycle', 'PLN', 9900, 9900,
  '73000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001'
);

INSERT INTO public.shipment_external_refs (
  order_id, provider_kind, provider_tracking_id, tracking_url, active
) VALUES (
  '72000000-0000-4000-8000-000000000001', 'omnipack', 'TRACK-IMMUTABLE-1',
  'https://carrier.example/initial', true
);

SELECT lives_ok(
  $$
    INSERT INTO public.shipment_external_refs (
      order_id, provider_kind, provider_tracking_id, tracking_url, carrier_kind, service, active
    ) VALUES (
      '72000000-0000-4000-8000-000000000001', 'omnipack', 'TRACK-IMMUTABLE-1',
      'https://carrier.example/refreshed', 'inpost', 'locker', true
    )
    ON CONFLICT (provider_kind, provider_tracking_id)
    DO UPDATE SET
      order_id = EXCLUDED.order_id,
      provider_kind = EXCLUDED.provider_kind,
      provider_tracking_id = EXCLUDED.provider_tracking_id,
      tracking_url = EXCLUDED.tracking_url,
      carrier_kind = EXCLUDED.carrier_kind,
      service = EXCLUDED.service,
      active = EXCLUDED.active
  $$,
  'same-owner UPSERT may refresh delivery metadata'
);

SELECT is(
  (SELECT tracking_url FROM public.shipment_external_refs
    WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'),
  'https://carrier.example/refreshed',
  'same-owner metadata refresh is persisted'
);

SELECT throws_ok(
  $$
    INSERT INTO public.shipment_external_refs (
      order_id, provider_kind, provider_tracking_id, active
    ) VALUES (
      '72000000-0000-4000-8000-000000000003', 'omnipack', 'TRACK-UNPAID-1', true
    )
  $$,
  'P0001', 'commerce_shipment_requires_paid_order',
  'one-time shipment ref still requires a paid order'
);

SELECT throws_ok(
  $$
    INSERT INTO public.shipment_external_refs (
      order_id, provider_kind, provider_tracking_id, active
    ) VALUES (
      '72000000-0000-4000-8000-000000000004', 'omnipack', 'TRACK-CYCLE-UNPAID-1', true
    )
  $$,
  'P0001', 'commerce_shipment_requires_paid_order',
  'subscription shipment ref still requires a paid cycle'
);

SELECT throws_ok(
  $$
    UPDATE public.shipment_external_refs
       SET order_id = '72000000-0000-4000-8000-000000000002'
     WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'
  $$,
  '23505', 'commerce_fulfillment_tracking_ref_conflict',
  'direct owner reassignment fails closed'
);

SELECT throws_ok(
  $$
    UPDATE public.shipment_external_refs
       SET provider_tracking_id = 'TRACK-RENAMED'
     WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'
  $$,
  '23505', 'commerce_fulfillment_tracking_ref_conflict',
  'tracking-number rename fails closed'
);

SELECT throws_ok(
  $$
    UPDATE public.shipment_external_refs
       SET provider_kind = 'other_carrier'
     WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'
  $$,
  '23505', 'commerce_fulfillment_tracking_ref_conflict',
  'provider rename fails closed'
);

SELECT throws_ok(
  $$
    INSERT INTO public.shipment_external_refs (
      order_id, provider_kind, provider_tracking_id, active
    ) VALUES (
      '72000000-0000-4000-8000-000000000002', 'omnipack', 'TRACK-IMMUTABLE-1', true
    )
    ON CONFLICT (provider_kind, provider_tracking_id)
    DO UPDATE SET order_id = EXCLUDED.order_id, active = EXCLUDED.active
  $$,
  '23505', 'commerce_fulfillment_tracking_ref_conflict',
  'cross-order UPSERT cannot transfer tracking ownership'
);

SELECT is(
  (SELECT order_id::text FROM public.shipment_external_refs
    WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'),
  '72000000-0000-4000-8000-000000000001',
  'failed reassignment leaves the original owner intact'
);

SELECT lives_ok(
  $$
    UPDATE public.shipment_external_refs
       SET active = false,
           tracking_url = 'https://carrier.example/final',
           carrier_kind = 'inpost',
           service = 'locker-final'
     WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'
  $$,
  'operational fields remain mutable'
);

SELECT is(
  (SELECT (active::text || '|' || tracking_url || '|' || service)
     FROM public.shipment_external_refs
    WHERE provider_kind = 'omnipack' AND provider_tracking_id = 'TRACK-IMMUTABLE-1'),
  'false|https://carrier.example/final|locker-final',
  'mutable delivery metadata persists without changing identity'
);

SELECT * FROM finish();
ROLLBACK;
