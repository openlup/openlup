-- pgTAP: the operator can order a replacement parcel, and only one kind of hold
-- gets out of its way.
--
-- The first assertion is the one the whole wave stands on and it is deliberately
-- first: two reservation generations on one order had never been exercised, and
-- `commerce_fulfillment_create_order`'s coverage gate filters on `status` alone,
-- not on `kind`. So the file proves the gate is unsatisfied the moment the
-- original generation is consumed, and satisfied again by a fresh `manual_ops`
-- generation with those consumed rows still sitting on the order. Everything
-- after that depends on it.
--
-- The second half is the safety property. `fulfillment_exception` is released;
-- every other reason in `commerce_order_holds_reason_check` refuses by its own
-- name -- enumerated, not sampled -- and a refusal is proved to be mutation-free:
-- no parcel, no reservation, and the exception hold that was also active is
-- still active. The last assertion pins the gate this wave must not weaken:
-- `commerce_fulfillment_create_order` still refuses an order under any active
-- hold with `commerce_fulfillment_active_hold`.
--
-- Fixtures use the neutral country `ZZ` and the ISO 4217 test currency `XTS`:
-- a fixture must not spend the country or currency neutrality ratchets.
--
-- Run via: the local pgTAP lane, with a schema reset first (stale state lies).

BEGIN;
SELECT plan(54);

INSERT INTO public.admin_users (id, email, role)
VALUES ('78000000-0000-4000-8000-0000000000e1', 'replacement-command-admin@example.invalid', 'admin');

INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES ('78000000-0000-4000-8000-0000000000a1', 'replacement-command@example.invalid', 'Repl', 'Command', '+48000000001');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('78000000-0000-4000-8000-0000000000d1', '78000000-0000-4000-8000-0000000000a1', 'shipping', 'Replacement Street 1', 'Testville', '00-001', 'ZZ');

INSERT INTO public.catalog_products (id, slug, status, name)
VALUES ('78000000-0000-4000-8000-000000000031', 'replacement-command-alpha', 'active', 'Replacement Command Alpha');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('78000000-0000-4000-8000-000000000041', '78000000-0000-4000-8000-000000000031', 'SKU-REPLACEMENT-A', 'Replacement Command Alpha 400g', 'dog', 'active', 400, 420);

-- One stocked, fulfillable location, selected by predicate rather than by name.
INSERT INTO public.inventory_balances (sku_id, location_id, lot_id, on_hand)
SELECT '78000000-0000-4000-8000-000000000041', l.id, NULL, 1000
  FROM public.inventory_locations l
 WHERE l.status = 'active'
   AND l.fulfillable = true
 LIMIT 1;

-- A: the order that gets its replacement.  B: the order that refuses.
-- D: an order with no parcel at all, which pins the gate this wave must not weaken.
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency, total_cents, subtotal_cents
)
VALUES
  ('78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-0000000000a1', '78000000-0000-4000-8000-0000000000d1', 'REPL-R2A-01', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('78000000-0000-4000-8000-0000000000b2', '78000000-0000-4000-8000-0000000000a1', '78000000-0000-4000-8000-0000000000d1', 'REPL-R2A-02', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('78000000-0000-4000-8000-0000000000b4', '78000000-0000-4000-8000-0000000000a1', '78000000-0000-4000-8000-0000000000d1', 'REPL-R2A-04', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000);

INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
)
VALUES
  ('78000000-0000-4000-8000-000000000061', '78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-000000000041', 2, 5000, 10000, 0, 10000, 9259, '{}'::jsonb),
  ('78000000-0000-4000-8000-000000000062', '78000000-0000-4000-8000-0000000000b2', '78000000-0000-4000-8000-000000000041', 2, 5000, 10000, 0, 10000, 9259, '{}'::jsonb),
  ('78000000-0000-4000-8000-000000000064', '78000000-0000-4000-8000-0000000000b4', '78000000-0000-4000-8000-000000000041', 2, 5000, 10000, 0, 10000, 9259, '{}'::jsonb);

INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES
  ('78000000-0000-4000-8000-000000000081', '78000000-0000-4000-8000-0000000000b1', 'noop_payment', 'replacement-command-payment-1', 'succeeded', 10000, 'XTS'),
  ('78000000-0000-4000-8000-000000000082', '78000000-0000-4000-8000-0000000000b2', 'noop_payment', 'replacement-command-payment-2', 'succeeded', 10000, 'XTS'),
  ('78000000-0000-4000-8000-000000000084', '78000000-0000-4000-8000-0000000000b4', 'noop_payment', 'replacement-command-payment-4', 'succeeded', 10000, 'XTS');

INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency)
VALUES
  ('78000000-0000-4000-8000-000000000071', 'one_time_order', '78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-000000000081', 'succeeded', 10000, 'XTS'),
  ('78000000-0000-4000-8000-000000000072', 'one_time_order', '78000000-0000-4000-8000-0000000000b2', '78000000-0000-4000-8000-000000000082', 'succeeded', 10000, 'XTS'),
  ('78000000-0000-4000-8000-000000000074', 'one_time_order', '78000000-0000-4000-8000-0000000000b4', '78000000-0000-4000-8000-000000000084', 'succeeded', 10000, 'XTS');

-- The first generation, and the first parcel, exactly as checkout and handover
-- produce them: reserve, create, consume.
SELECT public.inventory_reserve_order(
  'replacement-command-gen1-a', '78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-000000000061',
  NULL, '78000000-0000-4000-8000-000000000041', 2, 'checkout_payment_window', 'succeeded', NULL, '{}'::jsonb, NULL);
SELECT public.inventory_reserve_order(
  'replacement-command-gen1-b', '78000000-0000-4000-8000-0000000000b2', '78000000-0000-4000-8000-000000000062',
  NULL, '78000000-0000-4000-8000-000000000041', 2, 'checkout_payment_window', 'succeeded', NULL, '{}'::jsonb, NULL);
SELECT public.inventory_reserve_order(
  'replacement-command-gen1-d', '78000000-0000-4000-8000-0000000000b4', '78000000-0000-4000-8000-000000000064',
  NULL, '78000000-0000-4000-8000-000000000041', 2, 'checkout_payment_window', 'succeeded', NULL, '{}'::jsonb, NULL);

UPDATE public.commerce_orders
   SET metadata = '{"runtimeFinalize":{"deliveryContact":{"schemaVersion":1,"source":"checkout_submission","revision":1,"recipientName":"Repl Command","contactEmail":"order-contact@example.invalid","contactPhone":"+48000000002","line1":"Replacement Street 1","line2":null,"city":"Testville","postalCode":"00-001","country":"ZZ","selectedDelivery":null,"deliveryInstructions":null,"courierInstructions":null}}}'::jsonb
 WHERE id = '78000000-0000-4000-8000-0000000000b1';

SELECT public.commerce_fulfillment_create_order(
  'replacement-command-create-a', '78000000-0000-4000-8000-0000000000b1', NULL, '{}'::jsonb);

-- A carries no `recipient_name` on its address, which is every address the public
-- checkout creates today, so the client name is what gets frozen.
SELECT is(
  (SELECT shipping_address_snapshot->>'recipientName'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND sequence_no = 0),
  'Repl Command',
  'the fulfilment row freezes the order-owned recipient');
SELECT is(
  (SELECT shipping_address_snapshot->'deliveryContact'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND sequence_no = 0),
  (SELECT metadata #> '{runtimeFinalize,deliveryContact}' FROM public.commerce_orders
    WHERE id = '78000000-0000-4000-8000-0000000000b1'),
  'a normal first-party parcel copies the complete canonical order contact');

-- B takes the same address after an operator has named a recipient on it. The
-- address wins: naming a recipient is exactly what that column is for.
UPDATE public.addresses
   SET recipient_name = 'Marzena Podgorna'
 WHERE id = '78000000-0000-4000-8000-0000000000d1';

SELECT public.commerce_fulfillment_create_order(
  'replacement-command-create-b', '78000000-0000-4000-8000-0000000000b2', NULL, '{}'::jsonb);

SELECT is(
  (SELECT shipping_address_snapshot->>'recipientName'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b2' AND sequence_no = 0),
  'Marzena Podgorna',
  'an address that names its recipient outranks the client row');

UPDATE public.addresses
   SET recipient_name = NULL
 WHERE id = '78000000-0000-4000-8000-0000000000d1';

-- The reported defect, reproduced: the customer corrects their own profile after
-- ordering. Before the snapshot carried a recipient this rewrote the label of a
-- parcel nobody re-addressed.
UPDATE public.clients
   SET first_name = 'Ela', last_name = 'Podgorny'
 WHERE id = '78000000-0000-4000-8000-0000000000a1';

SELECT is(
  (SELECT shipping_address_snapshot->>'recipientName'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND sequence_no = 0),
  'Repl Command',
  'a later profile edit does not re-address a parcel that was already created');

SELECT count(*)
  FROM (
    SELECT public.inventory_consume_reservation_for_fulfillment(
             'replacement-command-consume-' || ir.id::text, ir.id, '{}'::jsonb)
      FROM public.inventory_reservations ir
     WHERE ir.order_id IN ('78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-0000000000b2')
       AND ir.status = 'reserved'
  ) consumed;

-- A moves to `fulfilled` and B stays at `fulfillment_pending`, so the two order
-- statuses a replacement can legitimately arrive on are both exercised. The gap
-- audit reports that nothing in the tree actually sets `fulfilled`, which makes
-- B the realistic case and A the one that must not regress if that changes.
UPDATE public.commerce_orders
   SET status = 'fulfilled'
 WHERE id = '78000000-0000-4000-8000-0000000000b1';
UPDATE public.commerce_fulfillment_orders
   SET status = 'exception'
 WHERE order_id IN ('78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-0000000000b2');

INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
VALUES
  ('78000000-0000-4000-8000-0000000000c1', '78000000-0000-4000-8000-0000000000b1', 'active', 'fulfillment_exception', NULL, '{}'::jsonb),
  ('78000000-0000-4000-8000-0000000000c2', '78000000-0000-4000-8000-0000000000b2', 'active', 'fulfillment_exception', NULL, '{}'::jsonb),
  ('78000000-0000-4000-8000-0000000000c4', '78000000-0000-4000-8000-0000000000b4', 'active', 'manual_support', NULL, '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- The assumption everything else rests on: two reservation generations on one
-- order. Proved before the command is trusted with anything.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.reservation_gate_satisfied(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.commerce_order_items oi
      LEFT JOIN (
        SELECT order_item_id, sum(quantity) AS reserved_quantity
          FROM public.inventory_reservations
         WHERE order_id = p_order_id
           AND status = 'reserved'
         GROUP BY order_item_id
      ) reservations ON reservations.order_item_id = oi.id
     WHERE oi.order_id = p_order_id
       AND coalesce(reservations.reserved_quantity, 0) < oi.quantity
  );
$$;

SELECT is(
  pg_temp.reservation_gate_satisfied('78000000-0000-4000-8000-0000000000b1'),
  false,
  'the create gate is unsatisfied once the first generation is consumed');

UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = jsonb_set(
         shipping_address_snapshot, '{deliveryContact}', '"malformed"'::jsonb, true)
 WHERE order_id = '78000000-0000-4000-8000-0000000000b1'
   AND sequence_no = 0;

SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-malformed-string',
      '78000000-0000-4000-8000-0000000000b1',
      'damaged', '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_delivery_contact_invalid',
  'a present string deliveryContact refuses replacement instead of using legacy rows');

UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = jsonb_set(
         shipping_address_snapshot, '{deliveryContact}', '[]'::jsonb, true)
 WHERE order_id = '78000000-0000-4000-8000-0000000000b1'
   AND sequence_no = 0;

SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-malformed-array',
      '78000000-0000-4000-8000-0000000000b1',
      'damaged', '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_delivery_contact_invalid',
  'a present array deliveryContact refuses replacement instead of using legacy rows');

UPDATE public.commerce_fulfillment_orders fulfillment
   SET shipping_address_snapshot = jsonb_set(
         fulfillment.shipping_address_snapshot,
         '{deliveryContact}',
         orders.metadata #> '{runtimeFinalize,deliveryContact}',
         true)
  FROM public.commerce_orders orders
 WHERE fulfillment.order_id = orders.id
   AND fulfillment.order_id = '78000000-0000-4000-8000-0000000000b1'
   AND fulfillment.sequence_no = 0;

SELECT lives_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-a-0001',
      '78000000-0000-4000-8000-0000000000b1',
      'damaged',
      '78000000-0000-4000-8000-0000000000e1',
      '{}'::jsonb)$$,
  'the operator orders a replacement on an order held for a fulfilment exception');

-- A replacement is the same parcel again, so it inherits the recipient the
-- predecessor froze -- NOT whatever the client row says by now. Re-sending a
-- parcel may never silently re-address it.
SELECT is(
  (SELECT shipping_address_snapshot->>'recipientName'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND sequence_no = 1),
  'Repl Command',
  'the replacement parcel inherits the recipient its predecessor froze');
SELECT is(
  (SELECT replacement.shipping_address_snapshot->'deliveryContact'
     FROM public.commerce_fulfillment_orders replacement
    WHERE replacement.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND replacement.sequence_no = 1),
  (SELECT predecessor.shipping_address_snapshot->'deliveryContact'
     FROM public.commerce_fulfillment_orders predecessor
    WHERE predecessor.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND predecessor.sequence_no = 0),
  'the replacement copies the complete effective contact without rereading defaults');

UPDATE public.clients
   SET first_name = 'Repl', last_name = 'Command'
 WHERE id = '78000000-0000-4000-8000-0000000000a1';

SELECT is(
  pg_temp.reservation_gate_satisfied('78000000-0000-4000-8000-0000000000b1'),
  true,
  'a manual_ops generation satisfies the create gate with the consumed generation still present');

SELECT is(
  (SELECT count(*)::int FROM public.inventory_reservations
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND status = 'consumed'),
  1,
  'the consumed generation is still on the order, not rewritten');

SELECT is(
  (SELECT sum(quantity)::int FROM public.inventory_reservations
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1'
      AND status = 'reserved'
      AND kind = 'manual_ops'),
  2,
  'the fresh generation is manual_ops and covers the ordered quantity');

SELECT is(
  (SELECT bool_and(expires_at IS NULL) FROM public.inventory_reservations
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1'
      AND status = 'reserved'
      AND kind = 'manual_ops'),
  true,
  'the replacement generation is pinned open rather than left on a thirty-minute lease');

-- ---------------------------------------------------------------------------
-- The parcel, the hold, and the audit row.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT status FROM public.commerce_order_holds WHERE id = '78000000-0000-4000-8000-0000000000c1'),
  'released',
  'the fulfilment-exception hold is released, not bypassed');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1'),
  2,
  'the order now holds two fulfilment rows');

SELECT is(
  (SELECT sequence_no::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND sequence_no > 0),
  1,
  'the replacement takes ordinal 1');

SELECT is(
  (SELECT replacement.replaces_fulfillment_order_id
     FROM public.commerce_fulfillment_orders replacement
    WHERE replacement.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND replacement.sequence_no = 1),
  (SELECT original.id
     FROM public.commerce_fulfillment_orders original
    WHERE original.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND original.sequence_no = 0),
  'the replacement names the parcel it replaces');

SELECT is(
  (SELECT replacement_reason FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1' AND sequence_no = 1),
  'damaged',
  'the replacement carries the operator reason');

SELECT is(
  (SELECT array_length(lines.inventory_reservation_ids, 1)
     FROM public.commerce_fulfillment_order_lines lines
     JOIN public.commerce_fulfillment_orders parcel ON parcel.id = lines.fulfillment_order_id
    WHERE parcel.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND parcel.sequence_no = 1),
  1,
  'the replacement line points at the reservation this command minted');

SELECT is(
  (SELECT operations.actor_user_id
     FROM public.commerce_order_operations operations
    WHERE operations.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND operations.operation_type = 'replacement_shipment_requested'),
  '78000000-0000-4000-8000-0000000000e1'::uuid,
  'the request is audited against the operator who made it');

SELECT is(
  (SELECT operations.payload->>'reason'
     FROM public.commerce_order_operations operations
    WHERE operations.order_id = '78000000-0000-4000-8000-0000000000b1'
      AND operations.operation_type = 'replacement_shipment_requested'),
  'damaged',
  'the audit row carries the reason the operator gave');

SELECT is(
  (SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-a-0001',
      '78000000-0000-4000-8000-0000000000b1',
      'damaged',
      '78000000-0000-4000-8000-0000000000e1',
      '{}'::jsonb)->>'replayed'),
  'true',
  'the same idempotency key replays');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1'),
  2,
  'the replay does not create a third parcel');

-- ---------------------------------------------------------------------------
-- Every other reason in the hold CHECK refuses by its own name. The
-- fulfilment-exception hold on this order stays active throughout, so each case
-- is the realistic one: an exception the operator wants to answer, and a second
-- hold that must stop them.
-- ---------------------------------------------------------------------------

INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
VALUES ('78000000-0000-4000-8000-0000000000c5', '78000000-0000-4000-8000-0000000000b2', 'active', 'payment_not_succeeded', NULL, '{}'::jsonb);
SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0001', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_blocked_by_payment_not_succeeded_hold',
  'a payment hold refuses by its own name');
UPDATE public.commerce_order_holds SET status = 'released', released_at = now()
 WHERE id = '78000000-0000-4000-8000-0000000000c5';

INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
VALUES ('78000000-0000-4000-8000-0000000000c6', '78000000-0000-4000-8000-0000000000b2', 'active', 'inventory_review', NULL, '{}'::jsonb);
SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0002', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_blocked_by_inventory_review_hold',
  'an inventory review refuses by its own name');
UPDATE public.commerce_order_holds SET status = 'released', released_at = now()
 WHERE id = '78000000-0000-4000-8000-0000000000c6';

INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
VALUES ('78000000-0000-4000-8000-0000000000c7', '78000000-0000-4000-8000-0000000000b2', 'active', 'risk_review', NULL, '{}'::jsonb);
SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0003', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_blocked_by_risk_review_hold',
  'a risk review refuses by its own name');
UPDATE public.commerce_order_holds SET status = 'released', released_at = now()
 WHERE id = '78000000-0000-4000-8000-0000000000c7';

INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
VALUES ('78000000-0000-4000-8000-0000000000c8', '78000000-0000-4000-8000-0000000000b2', 'active', 'address_review', NULL, '{}'::jsonb);
SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0004', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_blocked_by_address_review_hold',
  'an address review refuses by its own name');
UPDATE public.commerce_order_holds SET status = 'released', released_at = now()
 WHERE id = '78000000-0000-4000-8000-0000000000c8';

INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
VALUES ('78000000-0000-4000-8000-0000000000c9', '78000000-0000-4000-8000-0000000000b2', 'active', 'manual_support', NULL, '{}'::jsonb);
SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0005', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_blocked_by_manual_support_hold',
  'a manual support hold refuses by its own name');

-- A refusal is mutation-free: nothing was created, nothing was minted, and the
-- exception hold the operator was answering is untouched.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b2'),
  1,
  'a refused request leaves the order with the one parcel it had');

SELECT is(
  (SELECT count(*)::int FROM public.inventory_reservations
    WHERE order_id = '78000000-0000-4000-8000-0000000000b2' AND kind = 'manual_ops'),
  0,
  'a refused request mints no inventory');

SELECT is(
  (SELECT status FROM public.commerce_order_holds WHERE id = '78000000-0000-4000-8000-0000000000c2'),
  'active',
  'a refused request does not release the exception hold either');

UPDATE public.commerce_order_holds SET status = 'released', released_at = now()
 WHERE id = '78000000-0000-4000-8000-0000000000c9';

SELECT lives_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0006', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  'with only the exception hold left, the same order takes its replacement');

-- ---------------------------------------------------------------------------
-- R6: the fence a second browser tab actually needs.
--
-- The idempotency key is minted by the caller, so it fences a repeat of ONE
-- decision and nothing else. Two tabs, two operators, or a retry after a dropped
-- response mint two DIFFERENT keys for the same decision; both would pass the key
-- fence and both would create a parcel in `created`, which is a status
-- `omnipack_dispatch_candidate_ids` admits -- two real boxes, and no surface that
-- can recall either. The three assertions below are deliberately written with a
-- key that has never been seen, because that is the shape the browser produces.
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0007-second-tab', '78000000-0000-4000-8000-0000000000b2',
      'damaged', '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_undispatched_replacement_exists',
  'a second, unseen idempotency key cannot mint a second undispatched replacement');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b2'),
  2,
  'the refused second tab left no third parcel on the order');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.oms.replacement_shipment.request'
      AND idempotency_key = 'replacement-command-key-b-0007-second-tab'),
  0,
  'the new refusal is mutation-free: not even its idempotency key row survives');

-- The fence sits AFTER the key fence, so the ordinary double-click -- same key,
-- same request -- still replays the first answer instead of reading as a rival.
SELECT is(
  (SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-b-0006', '78000000-0000-4000-8000-0000000000b2', 'lost',
      '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb) ->> 'replayed'),
  'true',
  'the same key still replays the recorded answer rather than tripping the fence');

-- The fence is a queue depth of one, not a lifetime limit. Order A's replacement
-- is handed over -- outside the `created`/`label_pending` window the guard counts
-- -- and the next replacement is admitted. Deliberately here rather than at the
-- end of the file: the delivery-selection metadata set further down routes the
-- reservation through the external stock authority, which this fixture holds no
-- readings for, so a command call after that point would refuse for an unrelated
-- reason. (That refusal is itself a real production shape, and R6 maps it.)
UPDATE public.commerce_fulfillment_orders
   SET status = 'handed_over', handed_over_at = now()
 WHERE order_id = '78000000-0000-4000-8000-0000000000b1'
   AND sequence_no = 1;

SELECT lives_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-a-0010', '78000000-0000-4000-8000-0000000000b1',
      'returned_undelivered', '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  'once the first replacement has left, the order can take the next one');

SELECT is(
  (SELECT max(sequence_no)::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '78000000-0000-4000-8000-0000000000b1'),
  2,
  'the second replacement is the third parcel on the order, ordinal and all');

-- ---------------------------------------------------------------------------
-- The gate this wave must not weaken, and the input it must not accept.
-- ---------------------------------------------------------------------------

UPDATE public.commerce_orders
   SET metadata = '{"runtimeFinalize":{"deliveryContact":"malformed"}}'::jsonb
 WHERE id = '78000000-0000-4000-8000-0000000000b4';

SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_create_order(
      'replacement-create-runtime-string',
      '78000000-0000-4000-8000-0000000000b4', NULL, '{}'::jsonb)$$,
  '22023', 'commerce_fulfillment_delivery_contact_invalid',
  'a present string runtime contact refuses parcel creation instead of falling back');

UPDATE public.commerce_orders
   SET metadata = '{"channelOrderSnapshot":[]}'::jsonb
 WHERE id = '78000000-0000-4000-8000-0000000000b4';

SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_create_order(
      'replacement-create-channel-array',
      '78000000-0000-4000-8000-0000000000b4', NULL, '{}'::jsonb)$$,
  '22023', 'commerce_fulfillment_delivery_contact_invalid',
  'a present array channel snapshot refuses parcel creation instead of falling back');

UPDATE public.commerce_orders
   SET metadata = '{"deliveryContactOverride":"malformed"}'::jsonb
 WHERE id = '78000000-0000-4000-8000-0000000000b4';

SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_create_order(
      'replacement-create-override-string',
      '78000000-0000-4000-8000-0000000000b4', NULL, '{}'::jsonb)$$,
  '22023', 'commerce_fulfillment_delivery_contact_invalid',
  'a present string override refuses parcel creation instead of falling back');

UPDATE public.commerce_orders SET metadata = '{}'::jsonb
 WHERE id = '78000000-0000-4000-8000-0000000000b4';

SELECT throws_ok(
  $$SELECT public.commerce_fulfillment_create_order(
      'replacement-command-create-d', '78000000-0000-4000-8000-0000000000b4', NULL, '{}'::jsonb)$$,
  '22023', 'commerce_fulfillment_active_hold',
  'the original create gate still refuses an order under an active hold');

SELECT throws_ok(
  $$SELECT public.commerce_oms_request_replacement_shipment(
      'replacement-command-key-a-0009', '78000000-0000-4000-8000-0000000000b1',
      'operator felt like it', '78000000-0000-4000-8000-0000000000e1', '{}'::jsonb)$$,
  '22023', 'commerce_oms_replacement_invalid_input',
  'a reason outside the agreed set is refused before anything is written');

SELECT ok(
  strpos(pg_get_functiondef(
    'public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)'::regprocedure),
    'commerce-order-delivery|')
  < strpos(pg_get_functiondef(
    'public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)'::regprocedure),
    'omnipack-dispatch|'),
  'address correction takes the order-delivery mutex before the parcel dispatch mutex');

SELECT ok(
  strpos(pg_get_functiondef(
    'public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)'::regprocedure),
    'commerce-order-delivery|')
  < strpos(pg_get_functiondef(
    'public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)'::regprocedure),
    'omnipack-dispatch|'),
  'replacement takes the same order-delivery mutex before the parcel dispatch mutex');

SELECT ok(
  strpos(pg_get_functiondef(
    'public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)'::regprocedure),
    'commerce_oms_replacement_stale_parcel') > 0,
  'replacement names the retryable conflict when the latest parcel changes under its locks');

-- ---------------------------------------------------------------------------
-- R2b: the gate that was going to be widened, and did not have to be.
--
-- The master plan's R2 row called for widening the dispatch candidate gate "to
-- admit a replacement on a fulfilled order". This proves the first half wrong
-- and the second half unreachable, with the gate byte-for-byte as it shipped:
-- a fresh replacement on the realistic order status IS already a candidate,
-- because it is `created`, holds no dispatch ref of its own, inherits the
-- order's delivery selection through the gate's own fallback chain, and the
-- command RELEASED the hold rather than bypassing the `NOT EXISTS (active hold)`
-- clause D-R6 requires stay unchanged.
--
-- The delivery selection is set here rather than in the fixture above so every
-- assertion before this point ran against exactly the metadata it was written
-- for. The gate is STABLE and reads the order at call time, so setting it now is
-- the same fact arriving later.
-- ---------------------------------------------------------------------------

-- UNDER `runtimeFinalize`, WHICH IS THE ONLY PLACE A CONFIGURATOR ORDER PUTS
-- IT. The finalize RPC nests the whole runtime metadata object there, so a
-- top-level `metadata.selectedDelivery` -- which this fixture used to write --
-- exercises a rung the production shape never reaches. That is how a two-rung
-- ladder in `commerce_oms_request_replacement_shipment` passed this suite while
-- resolving NULL for every real parcel. The expectation below is unchanged.
UPDATE public.commerce_orders
   SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'runtimeFinalize',
         coalesce(metadata->'runtimeFinalize', '{}'::jsonb)
           || jsonb_build_object('selectedDelivery', jsonb_build_object('providerKind', 'omnipack')))
 WHERE id IN ('78000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-0000000000b2');

CREATE OR REPLACE FUNCTION pg_temp.is_dispatch_candidate(p_fulfillment_order_id uuid)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.omnipack_dispatch_candidate_ids(100) AS candidate
     WHERE candidate.fulfillment_order_id = p_fulfillment_order_id
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.parcel(p_order_id uuid, p_sequence_no smallint)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM public.commerce_fulfillment_orders
   WHERE order_id = p_order_id AND sequence_no = p_sequence_no;
$$;

SELECT is(
  pg_temp.is_dispatch_candidate(
    pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 1::smallint)),
  true,
  'the replacement parcel is a dispatch candidate with no gate change at all');

SELECT is(
  pg_temp.is_dispatch_candidate(
    pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 0::smallint)),
  false,
  'the parcel it replaces is not re-dispatched alongside it');

-- The gate refuses a replacement on an order whose status is `fulfilled`, which
-- is the case the master plan wanted the gate widened for. It stays refused: no
-- writer in the tree sets that status, so widening the gate would buy nothing
-- and would cost the one clause that keeps an unfulfillable order from shipping.
-- Ordinal 2 rather than 1: ordinal 1 was handed over above, so it would be refused
-- by its own status and the assertion would stop testing the order status it names.
SELECT is(
  pg_temp.is_dispatch_candidate(
    pg_temp.parcel('78000000-0000-4000-8000-0000000000b1', 2::smallint)),
  false,
  'an order status outside paid/fulfillment_pending still refuses, gate untouched');

-- D-R6, restated as an executable fact rather than a promise: the parcel became
-- a candidate because the hold was RELEASED, not because the clause moved.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '78000000-0000-4000-8000-0000000000b2' AND status = 'active'),
  0,
  'the replacement dispatches through a released hold, never past an active one');

-- ---------------------------------------------------------------------------
-- R2b: a tracking reference names its parcel, and the customer's dispatched
-- event quotes that parcel's number rather than the oldest one on the order.
--
-- This is the customer-visible half of the wave. `commerce_emit_shipment_
-- dispatched_outbox` keys its event per parcel but read references per ORDER
-- and took the OLDEST, so the mail announcing the replacement quoted the
-- tracking number of the parcel that was lost -- a number that will never move
-- again. The references below are inserted through the table's own ownership
-- guard, and the event is produced by the live status trigger, not called by
-- hand.
-- ---------------------------------------------------------------------------

INSERT INTO public.shipment_external_refs (
  order_id, fulfillment_order_id, provider_kind, provider_tracking_id, active
)
VALUES
  ('78000000-0000-4000-8000-0000000000b2',
   pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 0::smallint),
   'test_carrier', 'REPL-TRACK-LOST', true),
  ('78000000-0000-4000-8000-0000000000b2',
   pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 1::smallint),
   'test_carrier', 'REPL-TRACK-CURRENT', true);

UPDATE public.commerce_fulfillment_orders
   SET status = 'handed_over', handed_over_at = now()
 WHERE id = pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 1::smallint);

SELECT is(
  (SELECT payload->>'trackingNumber'
     FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND idempotency_key = 'shipment_dispatched:'
        || pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 1::smallint)::text),
  'REPL-TRACK-CURRENT',
  'the replacement parcel announces its own tracking number, not the lost one');

SELECT is(
  (SELECT jsonb_array_length(payload->'trackingReferences')
     FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.dispatched'
      AND idempotency_key = 'shipment_dispatched:'
        || pg_temp.parcel('78000000-0000-4000-8000-0000000000b2', 1::smallint)::text),
  1,
  'the sibling parcel reference is absent from the event entirely, not merely second');

-- The fact the backfill's paid-ownership predicate exists for: this table's
-- BEFORE-UPDATE guard re-asserts shippable ownership on every update, including
-- one that changes nothing it protects. A blanket attribution backfill would
-- therefore abort on the first reference belonging to a terminal order.
INSERT INTO public.shipment_external_refs (order_id, provider_kind, provider_tracking_id, active)
VALUES ('78000000-0000-4000-8000-0000000000b4', 'test_carrier', 'REPL-TRACK-TERMINAL', true);
UPDATE public.commerce_orders
   SET status = 'cancelled'
 WHERE id = '78000000-0000-4000-8000-0000000000b4';
SELECT throws_ok(
  $$UPDATE public.shipment_external_refs
       SET fulfillment_order_id = NULL
     WHERE provider_tracking_id = 'REPL-TRACK-TERMINAL'$$,
  'P0001', 'commerce_shipment_requires_paid_order',
  'a bare update of a terminal order''s reference is refused, so the backfill must skip it');

SELECT * FROM finish();
ROLLBACK;
