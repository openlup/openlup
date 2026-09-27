-- pgTAP: an order may hold a second fulfilment row, and every read that has to
-- pick one picks the same one.
--
-- Two halves. The first pins the schema transition: `UNIQUE (order_id)` is gone,
-- `UNIQUE (order_id, sequence_no)` is in its place, and the shape CHECK is what
-- replaces the guarantee the dropped constraint used to give -- an ordinal above
-- zero is legal only together with a predecessor and a reason, so a stray insert
-- that merely omits the ordinal still collides on ordinal 0 exactly as before.
--
-- The second half pins the five repaired reads. Each fixture pairs a superseded
-- parcel with the one that currently represents the order, and each assertion is
-- written so that it FAILS against the bodies these functions had before: the
-- auto-heal candidate count, the parcel whose address snapshot is rewritten, the
-- delivery a reorder reminder is counted from, and the two review windows that
-- must not open on a delivery a replacement has superseded. Every case has a
-- one-row twin, because the wave's whole safety argument is that a single
-- fulfilment row still gets the answer it got yesterday.
--
-- Run via: the local pgTAP lane, with a schema reset first (stale state lies).

BEGIN;
SELECT plan(27);

INSERT INTO public.admin_users (id, email, role)
VALUES ('77000000-0000-4000-8000-0000000000e1', 'replacement-admin@example.invalid', 'admin');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES
  ('77000000-0000-4000-8000-0000000000a1', 'replacement-1@example.invalid', 'Repl', 'One'),
  ('77000000-0000-4000-8000-0000000000a2', 'replacement-2@example.invalid', 'Repl', 'Two'),
  ('77000000-0000-4000-8000-0000000000a3', 'replacement-3@example.invalid', 'Repl', 'Three');

-- Neutral fixture country and the ISO 4217 test currency: fixtures must not
-- spend the country/currency neutrality ratchets.
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES
  ('77000000-0000-4000-8000-0000000000d1', '77000000-0000-4000-8000-0000000000a1', 'shipping', 'Sequence Street 1', 'Testville', '00-001', 'ZZ'),
  ('77000000-0000-4000-8000-0000000000d2', '77000000-0000-4000-8000-0000000000a2', 'shipping', 'Sequence Street 2', 'Testville', '00-002', 'ZZ'),
  ('77000000-0000-4000-8000-0000000000d3', '77000000-0000-4000-8000-0000000000a3', 'shipping', 'Sequence Street 3', 'Testville', '00-003', 'ZZ');

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency, total_cents, subtotal_cents
)
VALUES
  ('77000000-0000-4000-8000-0000000000b1', '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000d1', 'REPL-R1-01', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b2', '77000000-0000-4000-8000-0000000000a2', '77000000-0000-4000-8000-0000000000d2', 'REPL-R1-02', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b3', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-03', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b4', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-04', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b5', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-05', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b6', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-06', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b7', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-07', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b8', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-08', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000b9', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-09', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('77000000-0000-4000-8000-0000000000ba', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'REPL-R1-10', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000);

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  total_cents, subtotal_cents, metadata
) VALUES (
  '77000000-0000-4000-8000-0000000000bb',
  '77000000-0000-4000-8000-0000000000a3',
  '77000000-0000-4000-8000-0000000000d3',
  'REPL-R1-11', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000,
  '{"runtimeFinalize":{"deliveryContact":{"schemaVersion":1,"source":"checkout_submission","revision":1,"recipientName":"Before Parcel","contactEmail":"before@example.invalid","contactPhone":"+48000000001","line1":"Before Street 1","line2":null,"city":"Beforetown","postalCode":"00-011","country":"ZZ","selectedDelivery":null,"deliveryInstructions":null,"courierInstructions":null}}}'::jsonb
);

-- Originals. Every one of these takes `sequence_no = 0` from the column default,
-- exactly as `commerce_fulfillment_create_order` does today.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  shipping_address_snapshot, delivered_at
)
VALUES
  ('77000000-0000-4000-8000-0000000000f1', '77000000-0000-4000-8000-0000000000b1', '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000d1', 'repl-fo-1',  'delivered', '{}'::jsonb, now() - interval '55 days'),
  ('77000000-0000-4000-8000-0000000000f3', '77000000-0000-4000-8000-0000000000b2', '77000000-0000-4000-8000-0000000000a2', '77000000-0000-4000-8000-0000000000d2', 'repl-fo-3',  'delivered', '{}'::jsonb, now() - interval '40 days'),
  ('77000000-0000-4000-8000-0000000000f4', '77000000-0000-4000-8000-0000000000b3', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-4',  'delivered', '{}'::jsonb, now() - interval '25 days'),
  ('77000000-0000-4000-8000-0000000000f6', '77000000-0000-4000-8000-0000000000b4', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-6',  'delivered', '{}'::jsonb, now() - interval '55 days'),
  ('77000000-0000-4000-8000-0000000000f8', '77000000-0000-4000-8000-0000000000b5', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-8',  'exception', '{}'::jsonb, NULL),
  ('77000000-0000-4000-8000-0000000000fa', '77000000-0000-4000-8000-0000000000b6', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-10', 'created',   '{}'::jsonb, NULL),
  ('77000000-0000-4000-8000-0000000000fc', '77000000-0000-4000-8000-0000000000b7', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-12', 'created',   '{}'::jsonb, NULL),
  ('77000000-0000-4000-8000-0000000000fd', '77000000-0000-4000-8000-0000000000b8', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-13', 'delivered', '{}'::jsonb, now() - interval '10 days'),
  ('77000000-0000-4000-8000-0000000000fe', '77000000-0000-4000-8000-0000000000b9', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-14', 'delivered', '{}'::jsonb, now() - interval '34 days'),
  ('77000000-0000-4000-8000-0000000000ff', '77000000-0000-4000-8000-0000000000ba', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-15', 'exception', '{}'::jsonb, NULL);

-- Replacements. Each one takes the next ordinal, names the row it replaces and
-- says why, which is the only shape the CHECK admits above ordinal 0.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  shipping_address_snapshot, delivered_at,
  sequence_no, replaces_fulfillment_order_id, replacement_reason
)
VALUES
  ('77000000-0000-4000-8000-0000000000f2', '77000000-0000-4000-8000-0000000000b1', '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000d1', 'repl-fo-2', 'delivered', '{}'::jsonb, now() - interval '40 days', 1, '77000000-0000-4000-8000-0000000000f1', 'damaged'),
  ('77000000-0000-4000-8000-0000000000f5', '77000000-0000-4000-8000-0000000000b3', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-5', 'delivered', '{}'::jsonb, now() - interval '2 days',  1, '77000000-0000-4000-8000-0000000000f4', 'lost'),
  ('77000000-0000-4000-8000-0000000000f7', '77000000-0000-4000-8000-0000000000b4', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-7', 'delivered', '{}'::jsonb, now() - interval '5 days',  1, '77000000-0000-4000-8000-0000000000f6', 'returned_undelivered'),
  ('77000000-0000-4000-8000-0000000000f9', '77000000-0000-4000-8000-0000000000b5', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-9', 'exception', '{}'::jsonb, NULL, 1, '77000000-0000-4000-8000-0000000000f8', 'other'),
  ('77000000-0000-4000-8000-0000000000fb', '77000000-0000-4000-8000-0000000000b6', '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3', 'repl-fo-11', 'packed',
   '{"deliveryContact":{"schemaVersion":1,"source":"legacy_inferred","revision":1,"recipientName":"Current Recipient","contactEmail":"current@example.invalid","contactPhone":"+48000000000","line1":"Old Street 1","line2":null,"city":"Oldtown","postalCode":"00-001","country":"ZZ","selectedDelivery":null,"deliveryInstructions":null,"courierInstructions":null}}'::jsonb,
   NULL, 1, '77000000-0000-4000-8000-0000000000fa', 'damaged');

-- The machine-written delivery evidence the three enqueue functions require.
INSERT INTO public.commerce_fulfillment_operations (
  fulfillment_order_id, order_id, operation_type, idempotency_key, actor_user_id, payload
)
SELECT o.fulfillment_order_id, o.order_id, 'tracking_event_recorded',
       'repl-op-' || o.fulfillment_order_id::text, NULL,
       jsonb_build_object('status', 'delivered')
  FROM (VALUES
    ('77000000-0000-4000-8000-0000000000f1'::uuid, '77000000-0000-4000-8000-0000000000b1'::uuid),
    ('77000000-0000-4000-8000-0000000000f2'::uuid, '77000000-0000-4000-8000-0000000000b1'::uuid),
    ('77000000-0000-4000-8000-0000000000f3'::uuid, '77000000-0000-4000-8000-0000000000b2'::uuid),
    ('77000000-0000-4000-8000-0000000000f4'::uuid, '77000000-0000-4000-8000-0000000000b3'::uuid),
    ('77000000-0000-4000-8000-0000000000f5'::uuid, '77000000-0000-4000-8000-0000000000b3'::uuid),
    ('77000000-0000-4000-8000-0000000000f6'::uuid, '77000000-0000-4000-8000-0000000000b4'::uuid),
    ('77000000-0000-4000-8000-0000000000f7'::uuid, '77000000-0000-4000-8000-0000000000b4'::uuid),
    ('77000000-0000-4000-8000-0000000000fd'::uuid, '77000000-0000-4000-8000-0000000000b8'::uuid),
    ('77000000-0000-4000-8000-0000000000fe'::uuid, '77000000-0000-4000-8000-0000000000b9'::uuid)
  ) AS o(fulfillment_order_id, order_id);

-- Two machine-raised exception holds: one on an order with two parcels, one on
-- an order with a single parcel. The metadata source string and the null actor
-- are what the auto-heal read keys on.
INSERT INTO public.commerce_order_holds (id, order_id, status, reason, created_by, metadata)
SELECT h.id, h.order_id, 'active', 'fulfillment_exception', NULL,
       jsonb_build_object('source', 'commerce.fulfillment.omnipack_provider_exception')
  FROM (VALUES
    ('77000000-0000-4000-8000-0000000000c1'::uuid, '77000000-0000-4000-8000-0000000000b5'::uuid),
    ('77000000-0000-4000-8000-0000000000c2'::uuid, '77000000-0000-4000-8000-0000000000ba'::uuid)
  ) AS h(id, order_id);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, provider_sub_status,
  local_status, evidence_kind, occurred_at, idempotency_key
)
VALUES
  ('77000000-0000-4000-8000-0000000000f8', '77000000-0000-4000-8000-0000000000b5', 'SUSPENDED', 'CARRIER_MAPPING_ERROR', 'exception', 'reconciliation', now() - interval '9 days',  'repl-evidence-original'),
  ('77000000-0000-4000-8000-0000000000f9', '77000000-0000-4000-8000-0000000000b5', 'SUSPENDED', 'CARRIER_MAPPING_ERROR', 'exception', 'reconciliation', now() - interval '2 days',  'repl-evidence-replacement'),
  ('77000000-0000-4000-8000-0000000000ff', '77000000-0000-4000-8000-0000000000ba', 'SUSPENDED', 'CARRIER_MAPPING_ERROR', 'exception', 'reconciliation', now() - interval '3 days',  'repl-evidence-single');

-- The review-effects fixtures need a feedback row whose effect token is unspent.
INSERT INTO public.commerce_order_feedback (order_id, token)
VALUES
  ('77000000-0000-4000-8000-0000000000b4', 'repl-feedback-token-4'),
  ('77000000-0000-4000-8000-0000000000b9', 'repl-feedback-token-9');

-- ---------------------------------------------------------------------------
-- Half one: the schema transition.
-- ---------------------------------------------------------------------------

SELECT lives_ok(
  $$INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
      shipping_address_snapshot, sequence_no, replaces_fulfillment_order_id, replacement_reason
    ) VALUES (
      '77000000-0000-4000-8000-000000000201', '77000000-0000-4000-8000-0000000000b7',
      '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3',
      'repl-shape-ok', 'created', '{}'::jsonb, 1,
      '77000000-0000-4000-8000-0000000000fc', 'lost')$$,
  'an order takes a second fulfilment row when it is shaped as a replacement');

SELECT throws_ok(
  $$INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
      shipping_address_snapshot, sequence_no, replaces_fulfillment_order_id, replacement_reason
    ) VALUES (
      '77000000-0000-4000-8000-000000000202', '77000000-0000-4000-8000-0000000000b7',
      '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3',
      'repl-shape-dup', 'created', '{}'::jsonb, 1,
      '77000000-0000-4000-8000-0000000000fc', 'lost')$$,
  '23505', NULL,
  'the same ordinal cannot be taken twice on one order');

SELECT throws_ok(
  $$INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key,
      status, shipping_address_snapshot
    ) VALUES (
      '77000000-0000-4000-8000-000000000203', '77000000-0000-4000-8000-0000000000b7',
      '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3',
      'repl-shape-stray', 'created', '{}'::jsonb)$$,
  '23505', NULL,
  'a stray insert that omits the ordinal still collides on ordinal 0, as it did before');

SELECT throws_ok(
  $$INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
      shipping_address_snapshot, sequence_no, replacement_reason
    ) VALUES (
      '77000000-0000-4000-8000-000000000204', '77000000-0000-4000-8000-0000000000b7',
      '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3',
      'repl-shape-no-predecessor', 'created', '{}'::jsonb, 2, 'lost')$$,
  '23514', NULL,
  'an ordinal above zero without a predecessor is refused');

SELECT throws_ok(
  $$INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
      shipping_address_snapshot, sequence_no, replaces_fulfillment_order_id
    ) VALUES (
      '77000000-0000-4000-8000-000000000205', '77000000-0000-4000-8000-0000000000b7',
      '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3',
      'repl-shape-no-reason', 'created', '{}'::jsonb, 2,
      '77000000-0000-4000-8000-0000000000fc')$$,
  '23514', NULL,
  'an ordinal above zero without a reason is refused');

SELECT throws_ok(
  $$INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
      shipping_address_snapshot, sequence_no, replaces_fulfillment_order_id, replacement_reason
    ) VALUES (
      '77000000-0000-4000-8000-000000000206', '77000000-0000-4000-8000-0000000000b7',
      '77000000-0000-4000-8000-0000000000a3', '77000000-0000-4000-8000-0000000000d3',
      'repl-shape-bad-reason', 'created', '{}'::jsonb, 2,
      '77000000-0000-4000-8000-0000000000fc', 'operator felt like it')$$,
  '23514', NULL,
  'a reason outside the agreed set is refused');

-- ---------------------------------------------------------------------------
-- Half two: the five repaired reads.
-- ---------------------------------------------------------------------------

-- S4. The join this replaced multiplied the hold by the number of fulfilment
-- rows on its order, so this returned 2 before the repair.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_oms_healable_provider_exception_holds(NULL) h
    WHERE h.order_id = '77000000-0000-4000-8000-0000000000b5'),
  1, 'one active hold yields one auto-heal candidate, not one per fulfilment row');

SELECT is(
  (SELECT h.fulfillment_order_id FROM public.commerce_oms_healable_provider_exception_holds(NULL) h
    WHERE h.order_id = '77000000-0000-4000-8000-0000000000b5'),
  '77000000-0000-4000-8000-0000000000f9'::uuid,
  'the candidate names the parcel that currently represents the order');

UPDATE public.commerce_order_holds
   SET metadata = metadata || jsonb_build_object('fulfillmentOrderId', '77000000-0000-4000-8000-0000000000f8')
 WHERE id = '77000000-0000-4000-8000-0000000000c1';

SELECT is(
  (SELECT h.fulfillment_order_id FROM public.commerce_oms_healable_provider_exception_holds(NULL) h
    WHERE h.order_id = '77000000-0000-4000-8000-0000000000b5'),
  '77000000-0000-4000-8000-0000000000f8'::uuid,
  'a hold pinned to a superseded parcel still answers for that parcel');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_oms_healable_provider_exception_holds(NULL) h
    WHERE h.order_id = '77000000-0000-4000-8000-0000000000ba'),
  1, 'a one-parcel order yields the one candidate it always yielded');

-- S5. The `LIMIT 1` this replaced had no ORDER BY, so which parcel got the
-- corrected address depended on the executor.
SELECT lives_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'repl-address-key-0001',
      '77000000-0000-4000-8000-0000000000b6',
      jsonb_build_object(
        'recipientName', 'Corrected Recipient',
        'contactEmail', 'corrected@example.invalid',
        'contactPhone', '+48000000009',
        'line1', 'Corrected Street 9',
        'city', 'Testville',
        'postalCode', '00-009',
        'country', 'ZZ'),
      '77000000-0000-4000-8000-0000000000e1',
      '{"_deliveryContactExpectedRevision":1}'::jsonb)$$,
  'the operator address correction runs with two fulfilment rows present');

SELECT is(
  (SELECT f.shipping_address_snapshot->>'line1' FROM public.commerce_fulfillment_orders f
    WHERE f.id = '77000000-0000-4000-8000-0000000000fb'),
  'Corrected Street 9',
  'the corrected address lands on the parcel that currently represents the order');
SELECT is(
  (SELECT f.shipping_address_snapshot #>> '{deliveryContact,revision}'
     FROM public.commerce_fulfillment_orders f
    WHERE f.id = '77000000-0000-4000-8000-0000000000fb'),
  '2',
  'a packed no-effect parcel remains correctable until provider submission starts');
SELECT is(
  (SELECT line1 FROM public.addresses
    WHERE id = '77000000-0000-4000-8000-0000000000d3'),
  'Sequence Street 3',
  'parcel correction never mutates the shared address row');
SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'repl-address-key-stale',
      '77000000-0000-4000-8000-0000000000b6',
      '{"recipientName":"Stale","contactEmail":"stale@example.invalid","contactPhone":"+48000000008","line1":"Stale 8","city":"Testville","postalCode":"00-008","country":"ZZ"}'::jsonb,
      '77000000-0000-4000-8000-0000000000e1',
      '{"_deliveryContactExpectedRevision":1}'::jsonb)$$,
  '40001',
  'commerce_oms_delivery_contact_stale_revision',
  'a second operator on the old parcel revision receives a named conflict');

INSERT INTO public.omnipack_dispatch_refs (
  fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint, sanitized_request
) VALUES (
  '77000000-0000-4000-8000-0000000000fb',
  '77000000-0000-4000-8000-0000000000b6',
  'provider-proof-packed', 'live', 'created',
  'repl-address-provider-proof', 'repl-address-provider-fingerprint',
  '{"deliveryContactRevision":2}'::jsonb
);
SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'repl-address-key-effectful',
      '77000000-0000-4000-8000-0000000000b6',
      '{"recipientName":"Too Late","contactEmail":"late@example.invalid","contactPhone":"+48000000007","line1":"Late 7","city":"Testville","postalCode":"00-007","country":"ZZ"}'::jsonb,
      '77000000-0000-4000-8000-0000000000e1',
      '{"_deliveryContactExpectedRevision":2}'::jsonb)$$,
  '55000',
  'commerce_oms_delivery_contact_submission_started',
  'any effectful ref freezes ordinary parcel correction even when another ref could be draft');

SELECT lives_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'repl-address-key-preparcel',
      '77000000-0000-4000-8000-0000000000bb',
      '{"recipientName":"Before Parcel Corrected","contactEmail":"corrected-before@example.invalid","contactPhone":"+48000000011","line1":"Corrected Before 11","city":"Beforetown","postalCode":"00-111","country":"ZZ"}'::jsonb,
      '77000000-0000-4000-8000-0000000000e1',
      '{"_deliveryContactExpectedRevision":1}'::jsonb)$$,
  'pre-parcel correction writes only the order-scoped override');
SELECT is(
  (SELECT metadata #>> '{deliveryContactOverride,revision}' FROM public.commerce_orders
    WHERE id = '77000000-0000-4000-8000-0000000000bb'),
  '2',
  'the pre-parcel override advances the order contact revision');
SELECT is(
  (SELECT line1 FROM public.addresses
    WHERE id = '77000000-0000-4000-8000-0000000000d3'),
  'Sequence Street 3',
  'pre-parcel correction also leaves the shared address unchanged');

SELECT is(
  (SELECT f.shipping_address_snapshot FROM public.commerce_fulfillment_orders f
    WHERE f.id = '77000000-0000-4000-8000-0000000000fa'),
  '{}'::jsonb,
  'the superseded parcel keeps the snapshot it shipped with');

-- S6. Both parcels of this order fall inside the reminder window, so before the
-- repair the reminder was counted from the delivery the replacement superseded.
SELECT public.enqueue_reorder_reminders(1000);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.reorder_reminder'
      AND aggregate_id = '77000000-0000-4000-8000-0000000000b1'),
  1, 'two delivered parcels enqueue one reorder reminder');

SELECT is(
  (SELECT e.payload->>'deliveredAt' FROM public.outbox_events e
    WHERE e.event_type = 'commerce.order.reorder_reminder'
      AND e.aggregate_id = '77000000-0000-4000-8000-0000000000b1'),
  (SELECT to_char(f.delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
     FROM public.commerce_fulfillment_orders f
    WHERE f.id = '77000000-0000-4000-8000-0000000000f2'),
  'the reminder is counted from the later delivery, not the superseded one');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.reorder_reminder'
      AND aggregate_id = '77000000-0000-4000-8000-0000000000b2'),
  1, 'a one-parcel order is reminded exactly as it was before');

-- S8. The superseded parcel is inside the review-request window and the current
-- one is not, so the repair is the difference between asking for a review and
-- staying quiet until the replacement has had its three days.
SELECT public.enqueue_review_requests(500);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_request'
      AND aggregate_id = '77000000-0000-4000-8000-0000000000b3'),
  0, 'no review request while only the superseded delivery is old enough');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_request'
      AND aggregate_id = '77000000-0000-4000-8000-0000000000b8'),
  1, 'a one-parcel order is asked exactly as it was before');

-- S7. Same shape on the effects window.
SELECT public.enqueue_review_effects(500);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '77000000-0000-4000-8000-0000000000b4'),
  0, 'no effects follow-up while only the superseded delivery is old enough');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.review_effects'
      AND aggregate_id = '77000000-0000-4000-8000-0000000000b9'),
  1, 'a one-parcel order gets its effects follow-up exactly as before');

SELECT * FROM finish();
ROLLBACK;
