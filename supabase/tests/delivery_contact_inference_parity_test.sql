-- pgTAP: the three legacy delivery-contact inference sites must agree, and none
-- of them may strand a parcel that has already been paid for.
--
-- THE FIXTURE SHAPE IS THE POINT OF THIS FILE. A configurator order carries its
-- delivery selection ONLY at `metadata.runtimeFinalize.selectedDelivery`, because
-- the finalize RPC nests the whole runtime metadata object under `runtimeFinalize`
-- (20260605133000:215 and its successors). It does NOT carry a top-level
-- `metadata.selectedDelivery`. Every order below that stands for a storefront
-- order therefore writes the selection under `runtimeFinalize` and nowhere else.
-- A fixture that writes it top-level -- as
-- `replacement_shipment_command_test.sql` did -- exercises a rung the production
-- shape never reaches, and is exactly why a two-rung ladder in the replacement
-- command survived review while resolving NULL for every real parcel.
--
-- The parcels here are INSERTed rather than created through
-- `commerce_fulfillment_create_order`, because the rows under test are the ones
-- written BEFORE 20260831140000: a `shipping_address_snapshot` with no
-- `deliveryContact` key at all. That is the population these inference branches
-- exist to serve and the population that was stranded.
--
-- Fixtures use the neutral country `ZZ`, the ISO 4217 test currency `XTS` and the
-- neutral catalogue kind `other`: a fixture must not spend the country or currency
-- neutrality ratchets on facts no assertion here reads. Exactly two
-- product-category terms remain and both are structural -- they are NOT NULL
-- column names on the `catalog_skus` row the tested routines reach through their
-- own JOIN, and neither carries a DEFAULT (see 20260603133359). Do not name either
-- column again in prose here: the scanner counts occurrences, so an explanatory
-- sentence costs exactly as much as the code it explains.
--
-- Run via: the local pgTAP lane, with a schema reset first (stale state lies).

BEGIN;
SELECT plan(17);

INSERT INTO public.admin_users (id, email, role)
VALUES ('7c000000-0000-4000-8000-0000000000e1', 'contact-parity-admin@example.invalid', 'admin');

-- CL1 is an ordinary customer. CL2 carries NO phone, which is the renewal that
-- could not be fulfilled. CL3 is a marketplace identity: the internal
-- `@channel-buyer.invalid` e-mail that must never reach a carrier.
INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES
  ('7c000000-0000-4000-8000-0000000000a1', 'contact-parity-1@example.invalid', 'Ala', 'Kowalska', '+48000000001'),
  ('7c000000-0000-4000-8000-0000000000a2', 'contact-parity-2@example.invalid', 'Bogdan', 'Nowak', NULL),
  ('7c000000-0000-4000-8000-0000000000a3', 'cp3@channel-buyer.invalid', NULL, NULL, NULL);

INSERT INTO public.addresses (id, client_id, kind, label, line1, city, postal_code, country, contact_phone)
VALUES
  ('7c000000-0000-4000-8000-0000000000d1', '7c000000-0000-4000-8000-0000000000a1', 'shipping', 'Dom', 'Parity Street 1', 'Testville', '00-001', 'ZZ', NULL),
  ('7c000000-0000-4000-8000-0000000000d2', '7c000000-0000-4000-8000-0000000000a2', 'shipping', 'Etykieta Domu', 'Parity Street 2', 'Testville', '00-002', 'ZZ', NULL),
  ('7c000000-0000-4000-8000-0000000000d3', '7c000000-0000-4000-8000-0000000000a2', 'shipping', 'Praca', 'Parity Street 3', 'Testville', '00-003', 'ZZ', '+48000000777'),
  ('7c000000-0000-4000-8000-0000000000d4', '7c000000-0000-4000-8000-0000000000a3', 'shipping', 'Channel', 'Parity Street 4', 'Testville', '00-004', 'ZZ', NULL);

INSERT INTO public.catalog_products (id, slug, status, name)
VALUES ('7c000000-0000-4000-8000-000000000031', 'contact-parity-product', 'active', 'Contact Parity Product');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('7c000000-0000-4000-8000-000000000041', '7c000000-0000-4000-8000-000000000031', 'SKU-CONTACT-PARITY', 'Contact Parity 400g', 'other', 'active', 400, 420);

INSERT INTO public.inventory_balances (sku_id, location_id, lot_id, on_hand)
SELECT '7c000000-0000-4000-8000-000000000041', l.id, NULL, 1000
  FROM public.inventory_locations l
 WHERE l.status = 'active' AND l.fulfillable = true
 LIMIT 1;

-- The external stock the reserve path demands once a provider is actually
-- resolved. This seed is REQUIRED here and is not required by
-- `replacement_shipment_command_test.sql`, and the difference is the whole point
-- of this wave: that suite sets its selection only after its replacement calls, so
-- the reserve ran with a NULL provider and took the local-stock branch. Here the
-- order carries the selection from the start, exactly as a real one does, the
-- ladder resolves it, and the external branch is reached. On the base -- where the
-- two-rung ladder resolved NULL for this shape -- this seed would be dead code.
INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('omnipack', 'fulfillment', 'OmniPack Fulfillment', 'experimental')
ON CONFLICT (kind) DO NOTHING;

SELECT public.fulfillment_provider_upsert_stock_current(
  'contact-parity-stock-current-1',
  'omnipack',
  'SKU-CONTACT-PARITY',
  1000,
  1000,
  0,
  now(),
  now() + interval '6 hours',
  'contact-parity-stock-run-1',
  '{"source":"pgtap"}'::jsonb
);

-- The canonical storefront selection, written ONLY under `runtimeFinalize`.
CREATE OR REPLACE FUNCTION pg_temp.runtime_selection(p_provider text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('runtimeFinalize', jsonb_build_object(
    'selectedDelivery', jsonb_build_object(
      'kind', 'courier', 'deliveryKind', 'courier', 'providerKind', p_provider,
      'carrierKind', p_provider, 'carrierCode', 'PARITY', 'serviceCode', 'PARITY')));
$$;

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  total_cents, subtotal_cents, metadata
)
VALUES
  -- OA: the ordinary storefront order whose replacement lost its carrier.
  ('7c000000-0000-4000-8000-0000000000b1', '7c000000-0000-4000-8000-0000000000a1', '7c000000-0000-4000-8000-0000000000d1',
   'CP-01', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000, pg_temp.runtime_selection('omnipack')),
  -- OB: rung precedence. The parcel row's own selection must outrank the order's.
  ('7c000000-0000-4000-8000-0000000000b2', '7c000000-0000-4000-8000-0000000000a1', '7c000000-0000-4000-8000-0000000000d1',
   'CP-02', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000, pg_temp.runtime_selection('simulator')),
  -- OC: the phoneless customer whose phone lives on the address book row.
  ('7c000000-0000-4000-8000-0000000000b3', '7c000000-0000-4000-8000-0000000000a2', '7c000000-0000-4000-8000-0000000000d3',
   'CP-03', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000, pg_temp.runtime_selection('omnipack')),
  -- OD: the marketplace order. Selection TOP-LEVEL, exactly as channel ingest
  -- writes it (20260820210000:341), plus the buyer's own wire document.
  ('7c000000-0000-4000-8000-0000000000b4', '7c000000-0000-4000-8000-0000000000a3', '7c000000-0000-4000-8000-0000000000d4',
   'CP-04', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000,
   jsonb_build_object(
     'selectedDelivery', jsonb_build_object('kind','courier','deliveryKind','courier','providerKind','omnipack'),
     'channelOrderSnapshot', jsonb_build_object(
       'buyer', jsonb_build_object('email', 'real-buyer@marketplace.invalid', 'phone', '+48000000888'),
       'shipTo', jsonb_build_object(
         'recipientName', 'Czeslaw Marketplace', 'phone', '+48000000999',
         'line1', 'Channel Street 4', 'city', 'Testville',
         'postalCode', '00-004', 'countryCode', 'zz')))),
  -- OE: an order carrying a NEW-format contact whose parcel carries none. This
  -- inconsistency must still refuse; only the channel marker was loosened.
  ('7c000000-0000-4000-8000-0000000000b5', '7c000000-0000-4000-8000-0000000000a1', '7c000000-0000-4000-8000-0000000000d1',
   'CP-05', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000,
   pg_temp.runtime_selection('omnipack') || jsonb_build_object('runtimeFinalize', jsonb_build_object(
     'deliveryContact', jsonb_build_object('schemaVersion',1,'source','checkout_submission','revision',1)))),
  -- OF: the renewal shape. Inherits an address and nothing else.
  ('7c000000-0000-4000-8000-0000000000b6', '7c000000-0000-4000-8000-0000000000a2', '7c000000-0000-4000-8000-0000000000d2',
   'CP-06', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000, pg_temp.runtime_selection('omnipack')),
  -- OG: the healthy control, and the revision-tolerance subject.
  ('7c000000-0000-4000-8000-0000000000b7', '7c000000-0000-4000-8000-0000000000a1', '7c000000-0000-4000-8000-0000000000d1',
   'CP-07', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000, pg_temp.runtime_selection('omnipack')),
  -- OH: the last rung. A client row with no name at all, on an address that names
  -- no recipient either, and NO channel snapshot -- so the legacy branch runs and
  -- the address label is the only thing left to address the parcel to.
  ('7c000000-0000-4000-8000-0000000000b8', '7c000000-0000-4000-8000-0000000000a3', '7c000000-0000-4000-8000-0000000000d4',
   'CP-08', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000, pg_temp.runtime_selection('omnipack'));

INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
)
SELECT ('7c000000-0000-4000-8000-00000000006' || row_number() over (order by o.id))::uuid,
       o.id, '7c000000-0000-4000-8000-000000000041', 2, 5000, 10000, 0, 10000, 9259, '{}'::jsonb
  FROM public.commerce_orders o
 WHERE o.order_number LIKE 'CP-0%';

INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
SELECT ('7c000000-0000-4000-8000-00000000008' || row_number() over (order by o.id))::uuid,
       o.id, 'noop_payment', 'contact-parity-' || o.order_number, 'succeeded', 10000, 'XTS'
  FROM public.commerce_orders o
 WHERE o.order_number LIKE 'CP-0%';

INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency)
SELECT ('7c000000-0000-4000-8000-00000000007' || row_number() over (order by o.id))::uuid,
       'one_time_order', o.id, p.id, 'succeeded', 10000, 'XTS'
  FROM public.commerce_orders o
  JOIN public.commerce_payments p ON p.order_id = o.id
 WHERE o.order_number LIKE 'CP-0%';

-- The pre-20260831140000 parcel: every key the old builder wrote, and no
-- `deliveryContact`. OB additionally carries a parcel-level selection.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  shipping_address_snapshot, metadata
)
SELECT ('7c000000-0000-4000-8000-00000000009' || row_number() over (order by o.id))::uuid,
       o.id, o.client_id, o.shipping_address_id, 'contact-parity-legacy-' || o.order_number, 'created',
       jsonb_build_object(
         'addressId', a.id, 'clientId', a.client_id, 'label', a.label,
         'line1', a.line1, 'line2', a.line2, 'city', a.city,
         'postalCode', a.postal_code, 'country', a.country),
       CASE WHEN o.order_number = 'CP-02'
         THEN jsonb_build_object('selectedDelivery', jsonb_build_object('providerKind', 'omnipack'))
         ELSE '{}'::jsonb END
  FROM public.commerce_orders o
  JOIN public.addresses a ON a.id = o.shipping_address_id
 WHERE o.order_number IN ('CP-01', 'CP-02', 'CP-03', 'CP-04', 'CP-05');

CREATE OR REPLACE FUNCTION pg_temp.parcel_of(p_order_number text)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT f.id FROM public.commerce_fulfillment_orders f
    JOIN public.commerce_orders o ON o.id = f.order_id
   WHERE o.order_number = p_order_number
   ORDER BY f.sequence_no DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION pg_temp.contact_of(p_order_number text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT f.shipping_address_snapshot->'deliveryContact'
    FROM public.commerce_fulfillment_orders f
    JOIN public.commerce_orders o ON o.id = f.order_id
   WHERE o.order_number = p_order_number
   ORDER BY f.sequence_no DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION pg_temp.is_dispatch_candidate(p_fulfillment_order_id uuid)
RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(100) AS candidate
     WHERE candidate.fulfillment_order_id = p_fulfillment_order_id);
$$;

-- ---------------------------------------------------------------------------
-- A. The replacement command must not lose the carrier the order chose.
-- ---------------------------------------------------------------------------
SELECT public.commerce_oms_request_replacement_shipment(
  'contact-parity-replace-a', '7c000000-0000-4000-8000-0000000000b1', 'damaged',
  '7c000000-0000-4000-8000-0000000000e1', '{}'::jsonb);

SELECT is(
  (SELECT shipping_address_snapshot #>> '{deliveryContact,selectedDelivery,providerKind}'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '7c000000-0000-4000-8000-0000000000b1' AND sequence_no = 0),
  'omnipack',
  'A1: the predecessor keeps the selection the order carries under runtimeFinalize');

SELECT is(
  pg_temp.contact_of('CP-01') #>> '{selectedDelivery,providerKind}',
  'omnipack',
  'A2: the replacement parcel inherits that same carrier selection');

SELECT public.commerce_oms_request_replacement_shipment(
  'contact-parity-replace-b', '7c000000-0000-4000-8000-0000000000b2', 'lost',
  '7c000000-0000-4000-8000-0000000000e1', '{}'::jsonb);

SELECT is(
  (SELECT shipping_address_snapshot #>> '{deliveryContact,selectedDelivery,providerKind}'
     FROM public.commerce_fulfillment_orders
    WHERE order_id = '7c000000-0000-4000-8000-0000000000b2' AND sequence_no = 0),
  'omnipack',
  'A4: the parcel row selection outranks the order, so the ladder order is pinned');

-- ---------------------------------------------------------------------------
-- C. One phone ladder, walked identically at every site.
-- ---------------------------------------------------------------------------
SELECT is(
  public.omnipack_record_dispatch_ref_v2(
    'contact-parity-ref-c', pg_temp.parcel_of('CP-03'), NULL, 'shadow', 'draft',
    'fingerprint-c', jsonb_build_object('deliveryContactRevision', 1), '{}'::jsonb, '{}'::jsonb
  )->>'retryableReason',
  'omnipack_dispatch_contact_stale',
  'C1: a legacy parcel is backfilled and the caller is asked to come back');

SELECT is(
  pg_temp.contact_of('CP-03')->>'contactPhone',
  '+48000000777',
  'C2: with the address-book phone the fulfilment routine already accepts');

-- ---------------------------------------------------------------------------
-- D. A marketplace order is not a second-class order.
-- ---------------------------------------------------------------------------
SELECT is(
  public.omnipack_record_dispatch_ref_v2(
    'contact-parity-ref-d', pg_temp.parcel_of('CP-04'), NULL, 'shadow', 'draft',
    'fingerprint-d', jsonb_build_object('deliveryContactRevision', 1), '{}'::jsonb, '{}'::jsonb
  )->>'retryableReason',
  'omnipack_dispatch_contact_stale',
  'D1: a channel parcel is backfilled instead of refused');

SELECT is(
  pg_temp.contact_of('CP-04')->>'source',
  'channel_order_snapshot',
  'D2: labelled as the buyer-submitted truth it is, never as inference');

SELECT is(
  pg_temp.contact_of('CP-04')->>'recipientName',
  'Czeslaw Marketplace',
  'D3: the recipient is the marketplace shipTo, not a client-row name');

SELECT is(
  pg_temp.contact_of('CP-04')->>'contactEmail',
  'real-buyer@marketplace.invalid',
  'D4: the buyer e-mail is used and the internal channel-buyer identity never is');

SELECT throws_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'contact-parity-ref-e', pg_temp.parcel_of('CP-05'), NULL, 'shadow', 'draft',
      'fingerprint-e', jsonb_build_object('deliveryContactRevision', 1), '{}'::jsonb, '{}'::jsonb)$$,
  '22023', NULL,
  'D5: an order with a new-format contact and a parcel without one still refuses');

-- ---------------------------------------------------------------------------
-- B. A paid order always becomes a parcel; the carrier refusal moved, not away.
-- ---------------------------------------------------------------------------
SELECT public.inventory_reserve_order(
  'contact-parity-reserve-h', '7c000000-0000-4000-8000-0000000000b8',
  (SELECT id FROM public.commerce_order_items WHERE order_id = '7c000000-0000-4000-8000-0000000000b8'),
  NULL, '7c000000-0000-4000-8000-000000000041', 2, 'checkout_payment_window', 'succeeded', NULL, '{}'::jsonb, NULL);

SELECT public.inventory_reserve_order(
  'contact-parity-reserve-f', '7c000000-0000-4000-8000-0000000000b6',
  (SELECT id FROM public.commerce_order_items WHERE order_id = '7c000000-0000-4000-8000-0000000000b6'),
  NULL, '7c000000-0000-4000-8000-000000000041', 2, 'checkout_payment_window', 'succeeded', NULL, '{}'::jsonb, NULL);

SELECT lives_ok(
  $$SELECT public.commerce_fulfillment_create_order(
      'contact-parity-create-f', '7c000000-0000-4000-8000-0000000000b6', NULL, '{}'::jsonb)$$,
  'B1: a renewal for a customer with no phone anywhere still gets its parcel');

SELECT is(
  pg_temp.contact_of('CP-06')->>'recipientName',
  'Bogdan Nowak',
  'B2: with the recipient the ladder can still resolve');

SELECT ok(
  NOT pg_temp.is_dispatch_candidate(pg_temp.parcel_of('CP-06')),
  'B3: and it is withheld from dispatch rather than raising at it every run');

-- B4 guards the LAST rung of the recipient ladder. It is deliberately not a pin on
-- this wave's own change: it passes against this tree by construction, because the
-- third rung is already here. Its baseline is 20260901103001, where that site had
-- only two rungs and this case fails. It exists so the rung is not tidied away
-- later, and it matters because a contact this branch cannot address at all still
-- reaches the order-paid path, where SQLSTATE 22023 is classified fatal and a fatal
-- outcome is DISCARDED rather than retried.
SELECT public.commerce_fulfillment_create_order(
  'contact-parity-create-h', '7c000000-0000-4000-8000-0000000000b8', NULL, '{}'::jsonb);

SELECT is(
  pg_temp.contact_of('CP-08')->>'recipientName',
  'Channel',
  'B4: with no client name and no named recipient, the address label addresses the parcel');

-- ---------------------------------------------------------------------------
-- Revision tolerance: the apply-before-deploy window has no outage.
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'contact-parity-ref-g', pg_temp.parcel_of('CP-04'), NULL, 'shadow', 'draft',
      'fingerprint-g', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)$$,
  'T1: a caller that states no contact revision is accepted, not refused');

SELECT throws_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'contact-parity-ref-h', pg_temp.parcel_of('CP-04'), NULL, 'shadow', 'draft',
      'fingerprint-h', jsonb_build_object('deliveryContactRevision', 'nope'), '{}'::jsonb, '{}'::jsonb)$$,
  '22023', NULL,
  'T2: but a revision that IS stated must still be well formed');

-- Candidate enumeration is now the migration-first preparation boundary and
-- prepares every ordinary row in its returned batch. Keep this assertion after
-- the direct-recorder vectors above so it proves candidate eligibility without
-- pre-freezing the contacts whose first-call stale behavior those vectors pin.
SELECT ok(
  pg_temp.is_dispatch_candidate(pg_temp.parcel_of('CP-01')),
  'A3: and the replacement is therefore an actual dispatch candidate');

ROLLBACK;
