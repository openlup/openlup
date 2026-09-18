-- pgTAP: commerce_fulfillment_cancel_order must refuse while OmniPack still
-- holds the order (20260720140000).
--
-- WHY THIS EXISTS. Cancelling locally does not tell OmniPack — there is no
-- outbound cancel command anywhere in the system. The previous guard allowed
-- status IN ('created','packed','label_pending'), which permitted cancellation
-- both BEFORE the dispatch ack landed (the PR #1972 poison-record state) and
-- AFTER picking finished (provider stock already consumed). Either way stock
-- returned to the pool while the 3PL could still ship the parcel.
--
-- The rule under test: a non-terminal omnipack_dispatch_refs row refuses the
-- cancel. Terminal ('failed','cancelled') means the provider does not hold it.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(25);

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('c1000000-0000-4000-8000-000000000001', 'cancel-dispatch-guard@example.invalid');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('cc000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'shipping', 'ul. Testowa 1', 'Warszawa', '00-001', 'PL');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c2000000-0000-4000-8000-000000000001', 'cdg-product', 'CDG Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
        'CDG-SKU', 'CDG Sku', 'other', 'active', 1, 1);

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('c4000000-0000-4000-8000-000000000001', 'cdg-loc', 'CDG location', 'virtual', 'active', true);

INSERT INTO public.inventory_balances (id, sku_id, location_id, on_hand, reserved)
VALUES ('c5000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001',
        'c4000000-0000-4000-8000-000000000001', 100, 5);

-- Five independent orders, one per scenario.
INSERT INTO public.commerce_orders (
  id, client_id, status, currency, region_code, mode, size_constraint, total_cents, subtotal_cents
)
SELECT ('c6000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       'c1000000-0000-4000-8000-000000000001',
       'fulfillment_pending', 'PLN', 'PL', 'one_time',
       '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000
  FROM generate_series(1, 5) AS series(i);

-- Canonical money columns are NOT NULL and cross-checked (20260714170003):
--   effective_total_cents + discount_allocated_cents = total_cents
--   effective_net_cents = round(effective_total * 10000 / (10000 + vat_rate_bps))
-- vat_rate_bps is pinned explicitly rather than relying on the 800 default, so
-- the fixture stays valid if that default ever moves.
INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  vat_rate_bps, discount_allocated_cents, effective_total_cents, effective_net_cents
)
SELECT ('c7000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       ('c6000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       'c3000000-0000-4000-8000-000000000001', 1, 1000, 1000,
       800, 0, 1000,
       round(1000::numeric * 10000::numeric / (10000 + 800)::numeric)::integer
  FROM generate_series(1, 5) AS series(i);

-- Scenario statuses: 1 created, 2 packed, 3 created, 4 created, 5 created.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot
)
SELECT ('c8000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       ('c6000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       'c1000000-0000-4000-8000-000000000001',
       'cc000000-0000-4000-8000-000000000001',
       'cdg-create-' || series.i,
       CASE WHEN series.i = 2 THEN 'packed' ELSE 'created' END,
       'omnipack',
       '{"line1":"ul. Testowa 1","city":"Warszawa","postalCode":"00-001","country":"PL"}'::jsonb
  FROM generate_series(1, 5) AS series(i);

-- One reserved hold per order, pinned onto the fulfillment line, so a cancel
-- that proceeds would visibly release it.
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at
)
SELECT ('c9000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       'cdg-reservation-' || series.i,
       ('c6000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001',
       1, 'reserved', 'checkout_payment_window', NULL
  FROM generate_series(1, 5) AS series(i);

INSERT INTO public.commerce_fulfillment_order_lines (
  id, fulfillment_order_id, order_id, order_item_id, sku_id, sku, quantity, inventory_reservation_ids
)
SELECT ('ca000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       ('c8000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       ('c6000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       ('c7000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid,
       'c3000000-0000-4000-8000-000000000001', 'CDG-SKU', 1,
       ARRAY[('c9000000-0000-4000-8000-' || lpad(series.i::text, 12, '0'))::uuid]
  FROM generate_series(1, 5) AS series(i);

-- Dispatch refs. Order 5 deliberately has NONE (manual/simulator regression).
--   1 -> 'created'    + provider_order_id : OmniPack accepted, ack landed
--   2 -> 'created'    + provider_order_id : same, but fulfillment already packed
--   3 -> 'submitting' , no provider id    : in flight, outcome unknown
--   4 -> 'failed'                          : provider never took it
INSERT INTO public.omnipack_dispatch_refs (
  id, fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint
) VALUES
  ('cb000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001',
   'c6000000-0000-4000-8000-000000000001', 'cdg-provider-order-1', 'live', 'created',
   'cdg-dispatch-1', 'cdg-fingerprint-1'),
  ('cb000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000002',
   'c6000000-0000-4000-8000-000000000002', 'cdg-provider-order-2', 'live', 'created',
   'cdg-dispatch-2', 'cdg-fingerprint-2'),
  ('cb000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000003',
   'c6000000-0000-4000-8000-000000000003', NULL, 'live', 'submitting',
   'cdg-dispatch-3', 'cdg-fingerprint-3'),
  ('cb000000-0000-4000-8000-000000000004', 'c8000000-0000-4000-8000-000000000004',
   'c6000000-0000-4000-8000-000000000004', NULL, 'live', 'failed',
   'cdg-dispatch-4', 'cdg-fingerprint-4');

-- ---------------------------------------------------------------------------
-- 1. Accepted dispatch, fulfillment still 'created' — the PR #1972 state.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-1', 'c8000000-0000-4000-8000-000000000001'::uuid, 'customer_request')$$,
  '22023',
  'commerce_fulfillment_cancel_provider_dispatch_active',
  'accepted OmniPack dispatch refuses local cancellation'
);

SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders WHERE id = 'c8000000-0000-4000-8000-000000000001'),
  'created',
  'refused cancel leaves the fulfillment un-cancelled'
);

-- The money assertion: a refused cancel must not hand stock back while the
-- provider can still ship the parcel.
SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'c9000000-0000-4000-8000-000000000001'),
  'reserved',
  'refused cancel does not release the inventory reservation'
);

SELECT is(
  (SELECT count(*) FROM public.commerce_fulfillment_operations WHERE idempotency_key = 'cdg-cancel-1'),
  0::bigint,
  'refused cancel writes no cancellation operation'
);

-- ---------------------------------------------------------------------------
-- 2. THE INVERTED-GUARD HOLE: 'packed' used to be cancellable even though
--    provider stock is already consumed at READY_FOR_PACKING.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-2', 'c8000000-0000-4000-8000-000000000002'::uuid, 'customer_request')$$,
  '22023',
  'commerce_fulfillment_cancel_provider_dispatch_active',
  'packed fulfillment with a live dispatch refuses local cancellation'
);

SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders WHERE id = 'c8000000-0000-4000-8000-000000000002'),
  'packed',
  'refused packed cancel leaves the fulfillment packed'
);

SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'c9000000-0000-4000-8000-000000000002'),
  'reserved',
  'refused packed cancel does not release the reservation'
);

-- ---------------------------------------------------------------------------
-- 3. In-flight submission: we do NOT know whether OmniPack received it, so the
--    conservative answer is to refuse.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-3', 'c8000000-0000-4000-8000-000000000003'::uuid, 'customer_request')$$,
  '22023',
  'commerce_fulfillment_cancel_provider_dispatch_active',
  'in-flight submitting dispatch refuses local cancellation'
);

-- ---------------------------------------------------------------------------
-- 4. Terminal ref ('failed') — the provider never took it, so cancel proceeds.
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-4', 'c8000000-0000-4000-8000-000000000004'::uuid, 'customer_request')$$,
  'failed dispatch still allows local cancellation'
);

SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders WHERE id = 'c8000000-0000-4000-8000-000000000004'),
  'cancelled',
  'cancel over a failed dispatch cancels the fulfillment'
);

SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'c9000000-0000-4000-8000-000000000004'),
  'released',
  'cancel over a failed dispatch releases the reservation'
);

-- ---------------------------------------------------------------------------
-- 5. No dispatch ref at all — manual/simulator providers must be unaffected.
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-5', 'c8000000-0000-4000-8000-000000000005'::uuid, 'customer_request')$$,
  'fulfillment with no dispatch ref still cancels'
);

SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders WHERE id = 'c8000000-0000-4000-8000-000000000005'),
  'cancelled',
  'undispatched fulfillment reaches cancelled'
);

-- ---------------------------------------------------------------------------
-- 6. Idempotent replay is preserved — replaying a completed cancel must still
--    short-circuit BEFORE the new guard, or a retry would start failing.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-5', 'c8000000-0000-4000-8000-000000000005'::uuid, 'customer_request') ->> 'replayed'),
  'true',
  'replaying a completed cancel still returns replayed=true'
);

-- ---------------------------------------------------------------------------
-- 7. A provider-confirmed cancellation stays on hold until an operator makes
-- the existing cancel action explicit. Once the hold is released, that one
-- action closes both the fulfillment and the paid one-time order.
-- ---------------------------------------------------------------------------
UPDATE public.commerce_fulfillment_orders
   SET status = 'exception'
 WHERE id = 'c8000000-0000-4000-8000-000000000001';

INSERT INTO public.omnipack_status_evidence (
  dispatch_ref_id, fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
) VALUES (
  'cb000000-0000-4000-8000-000000000001',
  'c8000000-0000-4000-8000-000000000001',
  'c6000000-0000-4000-8000-000000000001', 'CANCELLED', 'exception',
  'reconciliation', '2026-07-21T18:40:50Z', 'cdg-provider-cancelled-1'
);

INSERT INTO public.commerce_order_holds (
  id, order_id, status, reason, idempotency_key, metadata
) VALUES (
  'cd000000-0000-4000-8000-000000000001',
  'c6000000-0000-4000-8000-000000000001', 'active', 'fulfillment_exception',
  'cdg-provider-cancelled-hold-1', '{"source":"commerce.fulfillment.omnipack_provider_exception"}'::jsonb
);

SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-provider-1', 'c8000000-0000-4000-8000-000000000001'::uuid, 'provider_cancelled')$$,
  '22023',
  'commerce_fulfillment_provider_cancel_payment_not_succeeded',
  'claimed paid status without a succeeded payment intent refuses cancellation'
);

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'c6000000-0000-4000-8000-000000000001'),
  'fulfillment_pending',
  'missing payment proof leaves the order unchanged'
);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  'ce000000-0000-4000-8000-000000000001',
  'c6000000-0000-4000-8000-000000000001', 'tpay', 'cdg-paid-provider-1',
  'succeeded', 1000, 'PLN'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency, provider_payment_id
) VALUES (
  'cf000000-0000-4000-8000-000000000001', 'one_time_order',
  'c6000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
  'succeeded', 1000, 'PLN', 'cdg-paid-provider-1'
);

SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-provider-1', 'c8000000-0000-4000-8000-000000000001'::uuid, 'provider_cancelled')$$,
  '22023',
  'commerce_fulfillment_provider_cancel_active_hold',
  'confirmed provider cancellation still requires an operator to release the hold'
);

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'c6000000-0000-4000-8000-000000000001'),
  'fulfillment_pending',
  'active hold leaves the paid order unchanged'
);

UPDATE public.commerce_order_holds
   SET status = 'released', released_at = now(), updated_at = now()
 WHERE id = 'cd000000-0000-4000-8000-000000000001';

SELECT lives_ok(
  $$SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-provider-1', 'c8000000-0000-4000-8000-000000000001'::uuid, 'provider_cancelled')$$,
  'the existing cancel command closes the order after provider confirmation and hold release'
);

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'c6000000-0000-4000-8000-000000000001'),
  'cancelled',
  'provider-confirmed cancellation closes the one-time order'
);

SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders WHERE id = 'c8000000-0000-4000-8000-000000000001'),
  'cancelled',
  'provider-confirmed cancellation closes the fulfillment'
);

SELECT is(
  (SELECT status FROM public.inventory_reservations WHERE id = 'c9000000-0000-4000-8000-000000000001'),
  'released',
  'the parent-order cancellation trigger releases the reserved inventory'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE order_id = 'c6000000-0000-4000-8000-000000000001'
      AND idempotency_key = 'cdg-cancel-provider-1:order'),
  1,
  'the order-level confirmation is audited exactly once'
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = 'c6000000-0000-4000-8000-000000000001'
      AND event_type = 'commerce.order.canceled'),
  0,
  'provider-confirmed no-refund cancellation does not emit a customer cancellation email event'
);

SELECT is(
  (SELECT public.commerce_fulfillment_cancel_order('cdg-cancel-provider-1', 'c8000000-0000-4000-8000-000000000001'::uuid, 'provider_cancelled') ->> 'replayed'),
  'true',
  'replaying the operator confirmation is safe'
);

SELECT * FROM finish();
ROLLBACK;
