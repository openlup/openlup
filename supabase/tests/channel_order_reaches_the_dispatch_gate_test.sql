-- pgTAP: a marketplace order is not a second-class order.
--
-- WHAT THIS PINS, AND WHY IT IS WORTH A SUITE OF ITS OWN. On 2026-08-20 a channel order was
-- followed end to end in a rolled-back transaction. It reached `paid`, acquired a succeeded
-- payment intent, held stock, emitted `commerce.order.paid`, and had a fulfilment row written for
-- it by the same routine a storefront order uses -- and then the dispatch candidate gate returned
-- NOTHING for it. The gate resolves the shipping provider through a delivery selection, and a
-- channel order carried one nowhere. The parcel never left, and nothing in the flow said so.
--
-- The cases below walk the same ingest sequence the saga drives, in order, against a surface that
-- has declared how its parcels ship. The last one is the whole wave: the same gate, unchanged,
-- returns the order. Nothing here dispatches anything; the point is candidacy.
--
BEGIN;
SELECT plan(12);

-- The fixture's currency, country and product kind are deliberately the neutral placeholders this
-- repository reserves for tests rather than the ones this deployment actually sells in. Nothing in
-- the behaviour under test reads any of them, and pinning today's answers here would make a
-- neutrality proof out of a suite that is about parcels.
--
-- ---------------------------------------------------------------------------
-- Fixtures. The location is looked up BY the provider the surface declares rather than named a
-- second time, so this file states each provider exactly once and cannot drift from itself.
-- ---------------------------------------------------------------------------
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d0000000-0000-4000-8000-000000000001', 'channel-parity-product', 'Channel Parity Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit, metadata)
VALUES (
  'd0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
  'CHANNEL-PARITY-SKU', 'Channel Parity SKU', 'other', 'active', 400, 100,
  '{"vatRateBps":2300}'::jsonb
);

INSERT INTO public.sales_channel_connections (id, slug, connector_provider_kind, connector_shape, display_name, status, credential_ref)
VALUES ('d0000000-0000-4000-8000-000000000004', 'channel-parity-conn', 'probe_marketplace', 'direct', 'Channel Parity Conn', 'active', 'op://vault/probe');

-- Two surfaces, identical but for the one column this wave adds. Everything below is a comparison
-- between them, so no case can pass for an unrelated reason.
INSERT INTO public.sales_channels (
  id, connection_id, slug, kind, display_name, status, currency, region_code,
  default_vat_rate_bps, buyer_comms_owner, invoice_policy, settlement_provider_kind, delivery_selection
) VALUES (
  'd0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000004',
  'channel-parity-declared', 'marketplace', 'Declared', 'active', 'XTS', 'ZZ',
  2300, 'channel', 'issue', 'channel_settlement',
  -- Deliberately the MINIMUM a declaration can be. The candidate gate resolves on `providerKind`
  -- and nothing else, so a fixture carrying carrier and service codes would prove the same thing
  -- while implying this suite had checked them. It has not: what a dispatch payload does with a
  -- carrier code is the dispatch port's question and has its own suite. This one asks only whether
  -- a marketplace order is eligible to leave at all.
  '{"kind":"courier","deliveryKind":"courier","providerKind":"omnipack"}'::jsonb
), (
  'd0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000004',
  'channel-parity-silent', 'marketplace', 'Silent', 'active', 'XTS', 'ZZ',
  2300, 'channel', 'issue', 'channel_settlement', NULL
);

-- ---------------------------------------------------------------------------
-- The shape constraint. It asserts presence, never a value: which providers exist is application
-- knowledge that changes without a migration.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$UPDATE public.sales_channels SET delivery_selection = '{"carrierCode":"X"}'::jsonb
     WHERE slug = 'channel-parity-silent'$$,
  '23514',
  NULL,
  'a declared selection that names no provider is refused by the surface itself'
);

SELECT lives_ok(
  $$UPDATE public.sales_channels SET delivery_selection = NULL WHERE slug = 'channel-parity-silent'$$,
  'a surface may still be registered before it has declared how it ships'
);

-- ---------------------------------------------------------------------------
-- Ingest, both surfaces.
-- ---------------------------------------------------------------------------
-- Stock on the shelf the declared provider actually keeps, found THROUGH that declaration rather
-- than named again here, so this file states each provider exactly once and cannot drift.
INSERT INTO public.inventory_balances (sku_id, location_id, on_hand, reserved)
SELECT 'd0000000-0000-4000-8000-000000000002', location.id, 100, 0
  FROM public.inventory_locations AS location
  JOIN public.sales_channels AS channel
    ON channel.slug = 'channel-parity-declared'
   AND location.provider_kind = channel.delivery_selection->>'providerKind'
 WHERE location.fulfillable AND location.status = 'active'
 LIMIT 1;

-- The provider's own count of what it holds. A reservation against a provider-backed selection is
-- refused without one -- which is itself the parity being proved: a marketplace sale now answers to
-- the same stock oracle a storefront sale answers to, rather than to a local number nobody synced.
SELECT public.fulfillment_provider_upsert_stock_current(
  'channel-parity-stock-1',
  (SELECT delivery_selection->>'providerKind' FROM public.sales_channels WHERE slug = 'channel-parity-declared'),
  'CHANNEL-PARITY-SKU',
  10, 10, 0,
  now(), now() + interval '6 hours',
  'channel-parity-run-1',
  '{"source":"pgtap"}'::jsonb
);

CREATE TEMP TABLE parity (k text PRIMARY KEY, v text);

CREATE OR REPLACE FUNCTION pg_temp.wire(p_ref text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'channel.order.v1',
    'externalOrderRef', p_ref,
    'externalOrderRevision', NULL,
    'providerEventId', p_ref || '-event',
    'placedAt', '2026-08-20T09:00:00Z',
    'currency', 'XTS',
    'buyer', jsonb_build_object(
      'externalCustomerRef', p_ref || '-cust', 'email', p_ref || '@example.invalid',
      'emailIsMasked', false, 'firstName', 'Ann', 'lastName', 'Buyer',
      'phone', '+48111000111', 'taxId', NULL, 'companyName', NULL),
    'shipTo', jsonb_build_object(
      'recipientName', 'Ann Buyer', 'line1', '1 Parity Street', 'line2', NULL,
      'postalCode', '00-001', 'city', 'Anytown', 'countryCode', 'ZZ',
      'phone', '+48111000111', 'pickupPointRef', NULL),
    'lines', jsonb_build_array(jsonb_build_object(
      'externalLineRef', p_ref || '-line-1',
      'sellable', jsonb_build_object('kind', 'sku', 'externalOfferRef', p_ref || '-offer', 'skuCode', 'CHANNEL-PARITY-SKU'),
      'quantity', 1, 'unitGrossMinor', 1000, 'lineGrossMinor', 1000,
      'lineDiscountMinor', 0, 'vatRateBps', 2300)),
    -- The far side's own words for how the buyer chose to receive it. Deliberately NOT one of this
    -- shop's option ids, because a marketplace never speaks that vocabulary.
    'shipping', jsonb_build_object('grossMinor', 0, 'discountMinor', 0,
      'methodLabel', 'Marketplace Standard Delivery', 'carrierHint', 'courier-fast'),
    'totals', jsonb_build_object('itemsGrossMinor', 1000, 'itemsDiscountMinor', 0,
      'shippingGrossMinor', 0, 'shippingDiscountMinor', 0, 'grandTotalMinor', 1000),
    'payment', jsonb_build_object('state', 'paid_externally', 'externalPaymentRef', p_ref || '-pay',
      'paidAt', '2026-08-20T09:05:00Z', 'methodLabel', 'marketplace'),
    'payloadDigest', p_ref || '-digest'
  );
$$;

DO $ingest$
DECLARE
  v_ledger uuid;
  v_res jsonb;
BEGIN
  FOR v_res IN
    SELECT jsonb_build_object('channel', id::text, 'ref', upper(replace(slug, 'channel-parity-', '')))
      FROM public.sales_channels WHERE slug LIKE 'channel-parity-%' ORDER BY slug
  LOOP
    v_ledger := (public.channel_ingest_record_inbound_event(
      (v_res->>'channel')::uuid, v_res->>'ref', NULL, (v_res->>'ref') || '-event',
      pg_temp.wire(v_res->>'ref')
    )#>>'{ingest,id}')::uuid;
    PERFORM public.channel_ingest_upsert_buyer(
      v_ledger, pg_temp.wire(v_res->>'ref')->'buyer', pg_temp.wire(v_res->>'ref')->'shipTo');
    INSERT INTO parity VALUES ('ledger:' || (v_res->>'ref'), v_ledger::text);
  END LOOP;
END
$ingest$;

-- The refusal, and it happens BEFORE an order row exists rather than after a buyer has been left
-- with a parcel that will never move.
SELECT throws_ok(
  format(
    $$SELECT public.commerce_create_channel_order('ch:parity:silent:order', %L::uuid, NULL)$$,
    (SELECT v FROM parity WHERE k = 'ledger:SILENT')
  ),
  '22023',
  'channel_order_delivery_selection_undeclared',
  'a surface that has not said how it ships cannot create an order at all'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_orders WHERE source_order_ref = 'SILENT'),
  0,
  'and it leaves no order behind to be found later by an operator wondering why nothing shipped'
);

-- The declared surface: the same call, and it writes.
DO $declared$
DECLARE
  v_order uuid;
  v_items jsonb;
  v_intent uuid;
  v_event uuid;
BEGIN
  v_order := (public.commerce_create_channel_order(
    'ch:parity:declared:order', (SELECT v FROM parity WHERE k = 'ledger:DECLARED')::uuid, NULL
  )#>>'{channelOrder,orderId}')::uuid;
  INSERT INTO parity VALUES ('order', v_order::text);

  SELECT jsonb_agg(jsonb_build_object('orderItemId', id, 'skuId', sku_id, 'quantity', quantity))
    INTO v_items FROM public.commerce_order_items WHERE order_id = v_order;

  -- The provider the SURFACE declared, read the way the saga reads it. This is the argument that
  -- decides whose stock the hold is against.
  PERFORM public.inventory_reserve_order_items(
    'ch:parity:declared:inventory', v_order, NULL, v_items, 'channel_order_window', 'succeeded',
    NULL, '{"source":"channels.ingest.v0"}'::jsonb,
    (SELECT delivery_selection->>'providerKind' FROM public.sales_channels WHERE slug = 'channel-parity-declared')
  );

  v_intent := (public.commerce_payment_control_create_intent(
    'ch:parity:declared:payment-intent', 'one_time_order', v_order, NULL, NULL, 1000, 'XTS',
    '{"source":"channels.ingest.v0"}'::jsonb)#>>'{paymentIntent,id}')::uuid;
  PERFORM public.commerce_payment_control_record_attempt(
    'ch:parity:declared:payment-attempt', v_intent, 'channel_settlement', 'DECLARED-pay', NULL,
    'processing', NULL, '{}'::jsonb, '{}'::jsonb);
  v_event := (public.commerce_payment_control_ingest_event(
    'channel_settlement', 'DECLARED-pay:settlement', 'payment.succeeded', 'DECLARED-pay',
    v_intent, NULL, 1000, 'XTS', true, '{}'::jsonb)#>>'{paymentEvent,id}')::uuid;
  PERFORM public.commerce_payment_control_apply_result(
    'ch:parity:declared:payment-result', v_intent, v_event, 'succeeded',
    '2026-08-20T09:05:00Z'::timestamptz, NULL, NULL, NULL);

  -- The routine the order-paid handler calls. Not a channel-specific one: this is the same entry
  -- point a storefront order goes through, and that it accepts a channel order unchanged is half
  -- of what makes the last case below meaningful.
  PERFORM public.commerce_fulfillment_create_order(
    'ch:parity:declared:fulfillment', v_order, NULL, '{"source":"channel-parity-test"}'::jsonb);
END
$declared$;

SELECT is(
  (SELECT metadata->'selectedDelivery' FROM public.commerce_orders WHERE id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  (SELECT delivery_selection FROM public.sales_channels WHERE slug = 'channel-parity-declared'),
  'the order carries the surface declaration verbatim, in the key a storefront order uses'
);

SELECT is(
  (SELECT metadata#>>'{channelShippingRequest,methodLabel}' FROM public.commerce_orders WHERE id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  'Marketplace Standard Delivery',
  'what the far side asked for is kept next to what was chosen, so the two can be compared'
);

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  'paid',
  'the order settles from the reference the marketplace collected against'
);
SELECT is(
  (SELECT fulfillment.shipping_address_snapshot #>> '{deliveryContact,source}'
     FROM public.commerce_fulfillment_orders fulfillment
    WHERE fulfillment.order_id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  'channel_order_snapshot',
  'the marketplace parcel labels its per-order contact provenance'
);
SELECT is(
  (SELECT fulfillment.shipping_address_snapshot #>> '{deliveryContact,contactEmail}'
     FROM public.commerce_fulfillment_orders fulfillment
    WHERE fulfillment.order_id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  (SELECT lower(orders.metadata #>> '{channelOrderSnapshot,buyer,email}')
     FROM public.commerce_orders orders
    WHERE orders.id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  'the carrier contact comes from the channel order snapshot'
);
SELECT isnt(
  (SELECT fulfillment.shipping_address_snapshot #>> '{deliveryContact,contactEmail}'
     FROM public.commerce_fulfillment_orders fulfillment
    WHERE fulfillment.order_id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  (SELECT clients.email
     FROM public.clients clients
     JOIN public.commerce_orders orders ON orders.client_id = clients.id
    WHERE orders.id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  'the internal channel identity email is never chosen as carrier contact'
);

-- The second stock authority, closed. A reservation without this drew on local balances while the
-- identical storefront sale drew on the provider's oracle.
SELECT is(
  (SELECT metadata->>'stockAuthority' FROM public.inventory_reservations
    WHERE order_id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  'external_stock_master_with_local_reservations',
  'the hold is against the declared provider stock, not a second local authority'
);

-- THE WAVE. Same gate, unchanged, no channel-specific branch anywhere in it.
SELECT is(
  (SELECT count(*)::int
     FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     JOIN public.commerce_fulfillment_orders AS fulfillment ON fulfillment.id = candidate.fulfillment_order_id
    WHERE fulfillment.order_id = (SELECT v FROM parity WHERE k = 'order')::uuid),
  1,
  'a marketplace order reaches the one dispatch gate every order reaches'
);

SELECT * FROM finish();
ROLLBACK;
