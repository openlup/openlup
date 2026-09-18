-- pgTAP: legacy delivery-contact correction and pre-dispatch preparation.
--
-- This first vector is deliberately a historical parcel: no frozen
-- deliveryContact, a selection only under runtimeFinalize, and no carrier phone
-- in either the address book or client profile. Before the correction forward it
-- is incorrectly admitted to the new-dispatch candidate set.

BEGIN;
SELECT plan(43);

INSERT INTO public.admin_users (id, email, role)
VALUES (
  '71a00000-0000-4000-8000-0000000000af',
  'legacy-contact-admin@example.invalid',
  'admin'
);

INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES (
  '71a00000-0000-4000-8000-0000000000a1',
  'legacy-contact-falsifier@example.invalid', 'Legacy', 'Falsifier', NULL
);

INSERT INTO public.addresses (
  id, client_id, kind, label, line1, city, postal_code, country, contact_phone
) VALUES (
  '71a00000-0000-4000-8000-0000000000a2',
  '71a00000-0000-4000-8000-0000000000a1',
  'shipping', 'Legacy label', 'Falsifier Street 1', 'Testville', '00-001', 'ZZ', NULL
);

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES (
  '71a00000-0000-4000-8000-0000000000b1',
  '71a00000-0000-4000-8000-0000000000a1',
  '71a00000-0000-4000-8000-0000000000a2',
  'LEGACY-FALSIFIER-1', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
  jsonb_build_object('runtimeFinalize', jsonb_build_object(
    'selectedDelivery', jsonb_build_object(
      'providerKind', 'omnipack', 'serviceCode', 'TEST', 'kind', 'courier'
    )
  ))
);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  provider_kind, shipping_address_snapshot
) VALUES (
  '71a00000-0000-4000-8000-0000000000c1',
  '71a00000-0000-4000-8000-0000000000b1',
  '71a00000-0000-4000-8000-0000000000a1',
  '71a00000-0000-4000-8000-0000000000a2',
  'legacy-contact-falsifier-1', 'created', 'omnipack',
  jsonb_build_object(
    'label', 'Legacy label', 'line1', 'Falsifier Street 1',
    'city', 'Testville', 'postalCode', '00-001', 'country', 'ZZ'
  )
);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '71a00000-0000-4000-8000-0000000000d1',
  '71a00000-0000-4000-8000-0000000000b1',
  'test', 'legacy-contact-falsifier-payment', 'succeeded', 1000, 'XTS'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency
) VALUES (
  '71a00000-0000-4000-8000-0000000000e1',
  'one_time_order', '71a00000-0000-4000-8000-0000000000b1',
  '71a00000-0000-4000-8000-0000000000d1', 'succeeded', 1000, 'XTS'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c1'
  ),
  'a no-key legacy parcel without recipient phone is withheld before payload mapping'
);

SELECT is(
  public.omnipack_prepare_dispatch_contact_v1(
    '71a00000-0000-4000-8000-0000000000c1'
  )->>'disposition',
  'withheld',
  'preparation returns the agreed withheld disposition without provider work'
);

SELECT ok(
  NOT coalesce((
    SELECT shipping_address_snapshot ? 'deliveryContact'
      FROM public.commerce_fulfillment_orders
     WHERE id = '71a00000-0000-4000-8000-0000000000c1'
  ), false),
  'withheld preparation does not write an incomplete legacy contact'
);

UPDATE public.clients
   SET phone = '+48000000071'
 WHERE id = '71a00000-0000-4000-8000-0000000000a1';

SELECT is(
  public.commerce_oms_update_shipping_address(
    'legacy-contact-parcel-correction-1',
    '71a00000-0000-4000-8000-0000000000b1',
    '{"recipientName":"Corrected Legacy","contactEmail":"corrected-legacy@example.invalid","contactPhone":"+48000000071","line1":"Corrected Street 71","city":"Testville","postalCode":"00-071","country":"ZZ"}'::jsonb,
    '71a00000-0000-4000-8000-0000000000af',
    '{"_deliveryContactExpectedRevision":1}'::jsonb
  )->>'scope',
  'parcel',
  'a locked current legacy parcel without a key resolves and corrects at revision one'
);

SELECT is(
  (SELECT shipping_address_snapshot #>> '{deliveryContact,revision}'
     FROM public.commerce_fulfillment_orders
    WHERE id = '71a00000-0000-4000-8000-0000000000c1'),
  '2',
  'parcel correction persists the inferred revision one as corrected revision two'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c1'
  ),
  'a complete legacy parcel re-enters the candidate set after correction'
);

SELECT is(
  public.commerce_oms_update_shipping_address(
    'legacy-contact-parcel-correction-1',
    '71a00000-0000-4000-8000-0000000000b1',
    '{"recipientName":"Corrected Legacy","contactEmail":"corrected-legacy@example.invalid","contactPhone":"+48000000071","line1":"Corrected Street 71","city":"Testville","postalCode":"00-071","country":"ZZ"}'::jsonb,
    '71a00000-0000-4000-8000-0000000000af',
    '{"_deliveryContactExpectedRevision":1}'::jsonb
  )->>'replayed',
  'true',
  'the persisted legacy parcel correction replays with the same request fingerprint'
);

SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-contact-parcel-correction-stale',
      '71a00000-0000-4000-8000-0000000000b1',
      '{"recipientName":"Stale","contactEmail":"stale@example.invalid","contactPhone":"+48000000071","line1":"Stale Street","city":"Testville","postalCode":"00-071","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      '{"_deliveryContactExpectedRevision":1}'::jsonb)$$,
  '40001',
  'commerce_oms_delivery_contact_stale_revision',
  'a stale legacy parcel correction retains the named optimistic-concurrency fence'
);

-- A separate address-phone-only legacy row exercises the old worker seam: queue
-- selection itself must freeze the contact before that worker builds its payload.
INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES (
  '71a00000-0000-4000-8000-0000000000a3',
  'address-phone-only@example.invalid', 'Address', 'Phone', NULL
);
INSERT INTO public.addresses (
  id, client_id, kind, label, line1, city, postal_code, country, contact_phone
) VALUES (
  '71a00000-0000-4000-8000-0000000000a4',
  '71a00000-0000-4000-8000-0000000000a3',
  'shipping', 'Address phone label', 'Address Phone 2', 'Testville', '00-002', 'ZZ', '+48000000072'
);
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES (
  '71a00000-0000-4000-8000-0000000000b2',
  '71a00000-0000-4000-8000-0000000000a3',
  '71a00000-0000-4000-8000-0000000000a4',
  'LEGACY-ADDRESS-PHONE-2', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
  jsonb_build_object('runtimeFinalize', jsonb_build_object(
    'selectedDelivery', jsonb_build_object(
      'kind', 'courier', 'deliveryKind', 'courier', 'providerKind', 'omnipack',
      'carrierKind', 'omnipack', 'carrierCode', 'TEST', 'serviceCode', 'TEST'
    )
  ))
);
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  provider_kind, shipping_address_snapshot
) VALUES (
  '71a00000-0000-4000-8000-0000000000c2',
  '71a00000-0000-4000-8000-0000000000b2',
  '71a00000-0000-4000-8000-0000000000a3',
  '71a00000-0000-4000-8000-0000000000a4',
  'legacy-address-phone-2', 'created', 'omnipack',
  jsonb_build_object(
    'label', 'Address phone label', 'line1', 'Address Phone 2',
    'city', 'Testville', 'postalCode', '00-002', 'country', 'ZZ'
  )
);
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '71a00000-0000-4000-8000-0000000000d2',
  '71a00000-0000-4000-8000-0000000000b2',
  'test', 'legacy-address-phone-payment-2', 'succeeded', 1000, 'XTS'
);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency
) VALUES (
  '71a00000-0000-4000-8000-0000000000e2',
  'one_time_order', '71a00000-0000-4000-8000-0000000000b2',
  '71a00000-0000-4000-8000-0000000000d2', 'succeeded', 1000, 'XTS'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c2'
  ),
  'selection returns an address-phone-only legacy parcel after freezing it'
);
SELECT is(
  (SELECT shipping_address_snapshot #>> '{deliveryContact,contactPhone}'
     FROM public.commerce_fulfillment_orders
    WHERE id = '71a00000-0000-4000-8000-0000000000c2'),
  '+48000000072',
  'candidate selection freezes the address-phone rung for an old worker reread'
);
SELECT is(
  public.omnipack_prepare_dispatch_contact_v1(
    '71a00000-0000-4000-8000-0000000000c2'
  ),
  jsonb_build_object('disposition', 'ready', 'deliveryContactRevision', 1),
  'a second preparation of the candidate-frozen contact is an idempotent no-op'
);

-- The OMS detail endpoint must receive the SQL answer, including the channel
-- arm and the nested runtimeFinalize selection that the former TS ladder lacked.
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES (
  '71a00000-0000-4000-8000-0000000000b9',
  '71a00000-0000-4000-8000-0000000000a3',
  '71a00000-0000-4000-8000-0000000000a4',
  'LEGACY-CHANNEL-READ-9', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
  jsonb_build_object(
    'runtimeFinalize', jsonb_build_object(
      'selectedDelivery', jsonb_build_object(
        'deliveryKind', 'courier', 'providerKind', 'omnipack', 'serviceCode', 'NESTED'
      )
    ),
    'channelOrderSnapshot', jsonb_build_object(
      'buyer', jsonb_build_object('email', 'channel-buyer@example.invalid', 'phone', '+48000000079'),
      'shipTo', jsonb_build_object(
        'recipientName', 'Channel Recipient 9', 'phone', '+48000000079',
        'line1', 'Channel Street 9', 'city', 'Channel City',
        'postalCode', '00-009', 'countryCode', 'zz'
      )
    )
  )
);

SELECT is(
  public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b9'
  ) #>> '{contact,source}',
  'channel_order_snapshot',
  'the service read RPC exposes the shared resolver channel arm'
);
SELECT is(
  public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b9'
  ) #>> '{contact,selectedDelivery,serviceCode}',
  'NESTED',
  'the service read RPC preserves runtimeFinalize selected delivery precedence'
);
SELECT is(
  public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b9'
  )->>'contactDigest',
  md5((public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b9'
  )->'contact')::text),
  'the read envelope digest identifies the exact resolved contact'
);
SELECT is(
  public.commerce_oms_update_shipping_address(
    'legacy-channel-digest-correction-9',
    '71a00000-0000-4000-8000-0000000000b9',
    '{"recipientName":"Channel Corrected","contactEmail":"channel-corrected@example.invalid","contactPhone":"+48000000079","line1":"Channel Corrected 9","city":"Channel City","postalCode":"00-009","country":"ZZ"}'::jsonb,
    '71a00000-0000-4000-8000-0000000000af',
    jsonb_build_object(
      '_deliveryContactExpectedRevision', 1,
      '_deliveryContactExpectedDigest', public.commerce_oms_resolve_delivery_contact_v1(
        '71a00000-0000-4000-8000-0000000000b9'
      )->>'contactDigest'
    )
  )->>'scope',
  'order',
  'a correction based on the server-resolved contact passes both fences'
);

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES (
  '71a00000-0000-4000-8000-0000000000ba',
  '71a00000-0000-4000-8000-0000000000a3',
  '71a00000-0000-4000-8000-0000000000a4',
  'LEGACY-DIGEST-ABA-10', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
  jsonb_build_object('runtimeFinalize', jsonb_build_object(
    'selectedDelivery', jsonb_build_object('providerKind', 'omnipack', 'serviceCode', 'TEST')
  ))
);
CREATE TEMP TABLE legacy_contact_expected_digest AS
SELECT public.commerce_oms_resolve_delivery_contact_v1(
  '71a00000-0000-4000-8000-0000000000ba'
)->>'contactDigest' AS value;
UPDATE public.addresses SET line1 = 'Changed after OMS read'
 WHERE id = '71a00000-0000-4000-8000-0000000000a4';

SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-contact-digest-stale-10',
      '71a00000-0000-4000-8000-0000000000ba',
      '{"recipientName":"Digest Stale","contactEmail":"digest-stale@example.invalid","contactPhone":"+48000000072","line1":"Digest Stale 10","city":"Testville","postalCode":"00-010","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      (SELECT jsonb_build_object(
        '_deliveryContactExpectedRevision', 1,
        '_deliveryContactExpectedDigest', value
      ) FROM pg_temp.legacy_contact_expected_digest))$$,
  '40001',
  'commerce_oms_delivery_contact_stale_revision',
  'a changed legacy input with the same revision is rejected by contact digest'
);
SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-contact-digest-invalid-10',
      '71a00000-0000-4000-8000-0000000000ba',
      '{"recipientName":"Digest Invalid","contactEmail":"digest-invalid@example.invalid","contactPhone":"+48000000072","line1":"Digest Invalid 10","city":"Testville","postalCode":"00-010","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      '{"_deliveryContactExpectedRevision":1,"_deliveryContactExpectedDigest":"not-a-digest"}'::jsonb)$$,
  '22023',
  'commerce_oms_shipping_address_invalid_input',
  'a supplied contact digest must be a canonical lowercase md5 value'
);
UPDATE public.addresses SET line1 = 'Address Phone 2'
 WHERE id = '71a00000-0000-4000-8000-0000000000a4';

-- No parcel exists for this order.  Its only delivery metadata is the production
-- runtimeFinalize selectedDelivery shape; the correction must write rev 2 override.
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES (
  '71a00000-0000-4000-8000-0000000000b3',
  '71a00000-0000-4000-8000-0000000000a3',
  '71a00000-0000-4000-8000-0000000000a4',
  'LEGACY-PRE-PARCEL-3', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
  jsonb_build_object('runtimeFinalize', jsonb_build_object(
    'selectedDelivery', jsonb_build_object(
      'kind', 'courier', 'deliveryKind', 'courier', 'providerKind', 'omnipack',
      'carrierKind', 'omnipack', 'carrierCode', 'TEST', 'serviceCode', 'TEST'
    )
  ))
);
SELECT is(
  public.commerce_oms_update_shipping_address(
    'legacy-contact-preparcel-correction-3',
    '71a00000-0000-4000-8000-0000000000b3',
    '{"recipientName":"Pre Parcel Corrected","contactEmail":"preparcel@example.invalid","contactPhone":"+48000000073","line1":"Pre Parcel 3","city":"Testville","postalCode":"00-003","country":"ZZ"}'::jsonb,
    '71a00000-0000-4000-8000-0000000000af',
    '{"_deliveryContactExpectedRevision":1}'::jsonb
  )->>'scope',
  'order',
  'a pre-parcel legacy order resolves revision one before writing its override'
);
SELECT is(
  (SELECT metadata #>> '{deliveryContactOverride,revision}'
     FROM public.commerce_orders
    WHERE id = '71a00000-0000-4000-8000-0000000000b3'),
  '2',
  'pre-parcel legacy correction persists revision two without a parcel'
);

INSERT INTO public.omnipack_dispatch_refs (
  fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint, sanitized_request
) VALUES (
  '71a00000-0000-4000-8000-0000000000c1',
  '71a00000-0000-4000-8000-0000000000b1',
  'effectful-legacy-proof', 'live', 'created',
  'legacy-contact-effectful-ref', 'legacy-contact-effectful-fingerprint',
  '{"deliveryContactRevision":2}'::jsonb
);
SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-contact-effectful-correction', '71a00000-0000-4000-8000-0000000000b1',
      '{"recipientName":"Too Late","contactEmail":"late@example.invalid","contactPhone":"+48000000071","line1":"Too Late 1","city":"Testville","postalCode":"00-001","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      '{"_deliveryContactExpectedRevision":2}'::jsonb)$$,
  '55000', 'commerce_oms_delivery_contact_submission_started',
  'an effectful provider ref still fences parcel correction'
);
DELETE FROM public.omnipack_dispatch_refs
 WHERE fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c1';
UPDATE public.commerce_fulfillment_orders SET status = 'label_created'
 WHERE id = '71a00000-0000-4000-8000-0000000000c1';
SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-contact-status-correction', '71a00000-0000-4000-8000-0000000000b1',
      '{"recipientName":"Too Late","contactEmail":"late@example.invalid","contactPhone":"+48000000071","line1":"Too Late 1","city":"Testville","postalCode":"00-001","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      '{"_deliveryContactExpectedRevision":2}'::jsonb)$$,
  '55000', 'commerce_oms_delivery_contact_submission_started',
  'a label-created parcel remains fenced even with no effectful ref'
);

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES
  (
    '71a00000-0000-4000-8000-0000000000b4',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'LEGACY-MALFORMED-4', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
    jsonb_build_object('runtimeFinalize', jsonb_build_object(
      'selectedDelivery', jsonb_build_object('providerKind', 'omnipack', 'serviceCode', 'TEST')
    ))
  ),
  (
    '71a00000-0000-4000-8000-0000000000b5',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'LEGACY-CANONICAL-FENCE-5', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
    jsonb_build_object('runtimeFinalize', jsonb_build_object(
      'selectedDelivery', jsonb_build_object('providerKind', 'omnipack', 'serviceCode', 'TEST'),
      'deliveryContact', jsonb_build_object('schemaVersion', 1, 'source', 'checkout_submission', 'revision', 1)
    ))
  ),
  (
    '71a00000-0000-4000-8000-0000000000b6',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'LEGACY-PROOF-BYPASS-6', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
    jsonb_build_object('runtimeFinalize', jsonb_build_object(
      'selectedDelivery', jsonb_build_object('providerKind', 'omnipack', 'serviceCode', 'TEST'),
      'deliveryContact', jsonb_build_object('schemaVersion', 1, 'source', 'checkout_submission', 'revision', 1)
    ))
  );
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  provider_kind, shipping_address_snapshot
) VALUES
  (
    '71a00000-0000-4000-8000-0000000000c4',
    '71a00000-0000-4000-8000-0000000000b4',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'legacy-malformed-4', 'created', 'omnipack',
    jsonb_build_object('line1', 'Malformed 4', 'city', 'Testville', 'postalCode', '00-004', 'country', 'ZZ',
      'deliveryContact', 'malformed')
  ),
  (
    '71a00000-0000-4000-8000-0000000000c5',
    '71a00000-0000-4000-8000-0000000000b5',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'legacy-canonical-fence-5', 'created', 'omnipack',
    jsonb_build_object('line1', 'Canonical Fence 5', 'city', 'Testville', 'postalCode', '00-005', 'country', 'ZZ')
  ),
  (
    '71a00000-0000-4000-8000-0000000000c6',
    '71a00000-0000-4000-8000-0000000000b6',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'legacy-proof-bypass-6', 'created', 'omnipack',
    jsonb_build_object('line1', 'Proof Bypass 6', 'city', 'Testville', 'postalCode', '00-006', 'country', 'ZZ')
  );

SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-contact-malformed-correction', '71a00000-0000-4000-8000-0000000000b4',
      '{"recipientName":"Fallback","contactEmail":"fallback@example.invalid","contactPhone":"+48000000074","line1":"Fallback 4","city":"Testville","postalCode":"00-004","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      '{"_deliveryContactExpectedRevision":1}'::jsonb)$$,
  '40001', 'commerce_oms_delivery_contact_stale_revision',
  'a present malformed parcel key is a named fence and never falls back'
);
SELECT is(
  public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b4'
  )->'contact',
  'null'::jsonb,
  'the service read fails closed without exposing a malformed canonical contact'
);
SELECT throws_ok(
  $$SELECT public.omnipack_prepare_dispatch_contact_v1(
      '71a00000-0000-4000-8000-0000000000c5')$$,
  '22023', 'omnipack_dispatch_delivery_contact_missing',
  'an order canonical marker without a frozen parcel contact remains a named fence'
);
SELECT is(
  public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b5'
  )->'contact',
  'null'::jsonb,
  'the OMS read exposes no editable contact for a keyless parcel on a canonical order'
);
SELECT is(
  public.commerce_oms_resolve_delivery_contact_v1(
    '71a00000-0000-4000-8000-0000000000b5'
  )->>'contactDigest',
  NULL,
  'the OMS read exposes no digest for a keyless parcel on a canonical order'
);
SELECT throws_ok(
  $$SELECT public.commerce_oms_update_shipping_address(
      'legacy-canonical-fence-correction-5', '71a00000-0000-4000-8000-0000000000b5',
      '{"recipientName":"Must Refuse","contactEmail":"refuse@example.invalid","contactPhone":"+48000000075","line1":"Must Refuse 5","city":"Testville","postalCode":"00-005","country":"ZZ"}'::jsonb,
      '71a00000-0000-4000-8000-0000000000af',
      '{"_deliveryContactExpectedRevision":1,"_deliveryContactExpectedDigest":"0123456789abcdef0123456789abcdef"}'::jsonb)$$,
  '40001', 'commerce_oms_delivery_contact_stale_revision',
  'a keyless parcel on a canonical order refuses correction before mutation'
);
SELECT ok(
  NOT (SELECT shipping_address_snapshot ? 'deliveryContact'
         FROM public.commerce_fulfillment_orders
        WHERE id = '71a00000-0000-4000-8000-0000000000c5')
  AND NOT EXISTS (
    SELECT 1 FROM public.commerce_idempotency_keys
     WHERE scope = 'commerce.oms.shipping_address.update'
       AND idempotency_key = 'legacy-canonical-fence-correction-5'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.commerce_order_operations
     WHERE order_id = '71a00000-0000-4000-8000-0000000000b5'
       AND operation_type = 'shipping_address_updated'
  ),
  'the canonical/keyless refusal leaves contact, idempotency, and operation rows untouched'
);

INSERT INTO public.omnipack_dispatch_refs (
  fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint, sanitized_request
) VALUES (
  '71a00000-0000-4000-8000-0000000000c6',
  '71a00000-0000-4000-8000-0000000000b6',
  'provider-proof-bypass-6', 'live', 'created',
  'legacy-proof-bypass-ref-6', 'legacy-proof-bypass-fingerprint-6', '{}'::jsonb
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c6'
  )
  AND NOT (SELECT shipping_address_snapshot ? 'deliveryContact'
             FROM public.commerce_fulfillment_orders
            WHERE id = '71a00000-0000-4000-8000-0000000000c6'),
  'provider-proof recovery is returned without preparation or a new contact write'
);

SELECT is(
  private.commerce_delivery_contact_resolve_v1(jsonb_build_object(
    'channelOrderSnapshot', NULL,
    'selectedDeliveryCandidates', jsonb_build_array(jsonb_build_object('providerKind', 'omnipack')),
    'recipientCandidates', jsonb_build_array('Old snapshot label'),
    'phoneCandidates', jsonb_build_array('+48000000072'),
    'legacyClientEmail', 'old-generation@example.invalid',
    'line1', 'Old Snapshot 2', 'city', 'Oldtown', 'postalCode', '00-072', 'country', 'ZZ'
  ))->>'disposition',
  'inferred_complete',
  'the pre-recipient legacy snapshot generation resolves through the envelope'
);

-- The paid malformed row is deliberately older than the persisted current-shape
-- row. Candidate selection must skip it quietly, continue, and freeze the good
-- legacy contact before an old worker re-reads its payload inputs.
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata
) VALUES
  (
    '71a00000-0000-4000-8000-0000000000b7',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'LEGACY-PAID-MALFORMED-7', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
    jsonb_build_object('runtimeFinalize', jsonb_build_object(
      'selectedDelivery', jsonb_build_object(
        'kind', 'courier', 'deliveryKind', 'courier', 'providerKind', 'omnipack',
        'carrierKind', 'omnipack', 'carrierCode', 'TEST', 'serviceCode', 'TEST'
      )
    ))
  ),
  (
    '71a00000-0000-4000-8000-0000000000b8',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'LEGACY-PERSISTED-RECIPIENT-8', 'fulfillment_pending', 'one_time', 'XTS', 1000, 1000,
    jsonb_build_object('runtimeFinalize', jsonb_build_object(
      'selectedDelivery', jsonb_build_object(
        'kind', 'courier', 'deliveryKind', 'courier', 'providerKind', 'omnipack',
        'carrierKind', 'omnipack', 'carrierCode', 'TEST', 'serviceCode', 'TEST'
      )
    ))
  );

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status,
  provider_kind, shipping_address_snapshot, created_at
) VALUES
  (
    '71a00000-0000-4000-8000-0000000000c7',
    '71a00000-0000-4000-8000-0000000000b7',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'legacy-paid-malformed-7', 'created', 'omnipack',
    jsonb_build_object(
      'recipientName', 'Malformed Candidate 7', 'line1', 'Malformed 7',
      'city', 'Testville', 'postalCode', '00-007', 'country', 'ZZ',
      'deliveryContact', 'malformed'
    ),
    now() - interval '1 day'
  ),
  (
    '71a00000-0000-4000-8000-0000000000c8',
    '71a00000-0000-4000-8000-0000000000b8',
    '71a00000-0000-4000-8000-0000000000a3',
    '71a00000-0000-4000-8000-0000000000a4',
    'legacy-persisted-recipient-8', 'created', 'omnipack',
    jsonb_build_object(
      'recipientName', 'Persisted Recipient 8', 'line1', 'Persisted 8', 'line2', 'Suite 8',
      'city', 'Testville', 'postalCode', '00-008', 'country', 'ZZ',
      'deliveryInstructions', 'leave at reception', 'courierInstructions', 'call first'
    ),
    now()
  );

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES
  ('71a00000-0000-4000-8000-0000000000d7', '71a00000-0000-4000-8000-0000000000b7',
   'test', 'legacy-paid-malformed-payment-7', 'succeeded', 1000, 'XTS'),
  ('71a00000-0000-4000-8000-0000000000d8', '71a00000-0000-4000-8000-0000000000b8',
   'test', 'legacy-persisted-recipient-payment-8', 'succeeded', 1000, 'XTS');

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency
) VALUES
  ('71a00000-0000-4000-8000-0000000000e7', 'one_time_order',
   '71a00000-0000-4000-8000-0000000000b7', '71a00000-0000-4000-8000-0000000000d7',
   'succeeded', 1000, 'XTS'),
  ('71a00000-0000-4000-8000-0000000000e8', 'one_time_order',
   '71a00000-0000-4000-8000-0000000000b8', '71a00000-0000-4000-8000-0000000000d8',
   'succeeded', 1000, 'XTS');

SELECT lives_ok(
  $$SELECT count(*) FROM public.omnipack_dispatch_candidate_ids(25)$$,
  'a paid malformed ordinary candidate cannot abort queue selection for later rows'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c7'
  )
  AND EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71a00000-0000-4000-8000-0000000000c8'
  ),
  'candidate selection excludes the older malformed row and returns the valid persisted recipient row'
);

SELECT is(
  (SELECT shipping_address_snapshot #>> '{deliveryContact,recipientName}'
     FROM public.commerce_fulfillment_orders
    WHERE id = '71a00000-0000-4000-8000-0000000000c8'),
  'Persisted Recipient 8',
  'candidate preparation freezes the persisted recipient-bearing legacy snapshot before dispatch'
);

SELECT is(
  public.omnipack_prepare_dispatch_contact_v1(
    '71a00000-0000-4000-8000-0000000000c1'
  ),
  jsonb_build_object('disposition', 'ready', 'deliveryContactRevision', 2),
  'preparation exposes only the agreed ready envelope after the contact is frozen'
);

SELECT ok(
  NOT has_function_privilege(
    'anon', 'private.commerce_delivery_contact_resolve_v1(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated', 'private.commerce_delivery_contact_resolve_v1(jsonb)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role', 'private.commerce_delivery_contact_resolve_v1(jsonb)', 'EXECUTE'
  ),
  'the pure private resolver has explicit negative API-role execute ACLs'
);

SELECT ok(
  has_function_privilege(
    'service_role', 'public.omnipack_prepare_dispatch_contact_v1(uuid)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon', 'public.omnipack_prepare_dispatch_contact_v1(uuid)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated', 'public.omnipack_prepare_dispatch_contact_v1(uuid)', 'EXECUTE'
  ),
  'preparation is callable only by the backend service role'
);

SELECT ok(
  has_function_privilege(
    'service_role', 'public.commerce_oms_resolve_delivery_contact_v1(uuid)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon', 'public.commerce_oms_resolve_delivery_contact_v1(uuid)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated', 'public.commerce_oms_resolve_delivery_contact_v1(uuid)', 'EXECUTE'
  ),
  'delivery contact resolution is callable only by the backend service role'
);

SELECT is(
  (
    SELECT count(*)::integer
      FROM pg_proc AS proc
     WHERE proc.oid = ANY (ARRAY[
       'public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)'::regprocedure,
       'public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)'::regprocedure,
       'public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure,
       'public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)'::regprocedure,
       'public.omnipack_dispatch_candidate_ids(integer)'::regprocedure,
       'public.omnipack_prepare_dispatch_contact_v1(uuid)'::regprocedure,
       'public.commerce_oms_resolve_delivery_contact_v1(uuid)'::regprocedure,
       'private.commerce_delivery_contact_resolve_v1(jsonb)'::regprocedure
     ]::oid[])
       AND proc.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
  ),
  8,
  'all full-body replacements and the three new functions retain the postgres owner'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc AS proc
     WHERE proc.oid = ANY (ARRAY[
       'public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)'::regprocedure,
       'public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)'::regprocedure,
       'public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure,
       'public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)'::regprocedure,
       'public.omnipack_dispatch_candidate_ids(integer)'::regprocedure,
       'public.commerce_oms_resolve_delivery_contact_v1(uuid)'::regprocedure,
       'public.omnipack_prepare_dispatch_contact_v1(uuid)'::regprocedure
     ]::oid[])
       AND (NOT proc.prosecdef OR proc.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'])
  ),
  'public full-body replacements retain definer ownership and the pinned search path'
);

SELECT ok(
  (SELECT proc.provolatile = 'v' AND proc.prosecdef
     AND proc.proconfig = ARRAY['search_path=public, pg_catalog']
     FROM pg_proc AS proc
    WHERE proc.oid = 'public.omnipack_dispatch_candidate_ids(integer)'::regprocedure)
  AND (SELECT proc.provolatile = 's' AND proc.proparallel = 's' AND NOT proc.prosecdef
     AND proc.proconfig = ARRAY['search_path=pg_catalog']
     FROM pg_proc AS proc
    WHERE proc.oid = 'private.commerce_delivery_contact_resolve_v1(jsonb)'::regprocedure)
  AND (SELECT proc.provolatile = 's' AND proc.prosecdef
     AND proc.proconfig = ARRAY['search_path=public, pg_catalog']
     FROM pg_proc AS proc
    WHERE proc.oid = 'public.commerce_oms_resolve_delivery_contact_v1(uuid)'::regprocedure),
  'candidate prepares, the resolver stays pure, and the service read remains stable'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)'::regprocedure,
        'public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)'::regprocedure,
        'public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure,
        'public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)'::regprocedure,
        'public.omnipack_dispatch_candidate_ids(integer)'::regprocedure,
        'public.commerce_oms_resolve_delivery_contact_v1(uuid)'::regprocedure,
        'public.omnipack_prepare_dispatch_contact_v1(uuid)'::regprocedure
      ]::regprocedure[]) AS signature
     WHERE NOT has_function_privilege('service_role', signature, 'EXECUTE')
        OR has_function_privilege('anon', signature, 'EXECUTE')
        OR has_function_privilege('authenticated', signature, 'EXECUTE')
  ),
  'all public replacement signatures retain service-only execute ACLs'
);

SELECT ok(
  to_regprocedure('public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)') IS NOT NULL
  AND to_regprocedure('public.commerce_oms_update_shipping_address(text,uuid,jsonb,uuid,jsonb)') IS NOT NULL
  AND to_regprocedure('public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)') IS NOT NULL
  AND to_regprocedure('public.commerce_oms_request_replacement_shipment(text,uuid,text,uuid,jsonb)') IS NOT NULL
  AND to_regprocedure('public.omnipack_dispatch_candidate_ids(integer)') IS NOT NULL
  AND to_regprocedure('public.commerce_oms_resolve_delivery_contact_v1(uuid)') IS NOT NULL
  AND to_regprocedure('public.omnipack_prepare_dispatch_contact_v1(uuid)') IS NOT NULL
  AND to_regprocedure('private.commerce_delivery_contact_resolve_v1(jsonb)') IS NOT NULL,
  'the full-body cutover preserves every public signature and declares all new signatures'
);

-- Selection must not die on one unpreparable row. The state that triggers this
-- only arises when a commit lands between the enumeration cursor and
-- preparation's FOR UPDATE re-read, which a single-transaction pgTAP case
-- cannot stage; this pins the handler's presence and, just as importantly, its
-- narrowness -- a lock timeout or cancellation must still propagate.
SELECT ok(
  pg_get_functiondef('public.omnipack_dispatch_candidate_ids(integer)'::regprocedure)
    LIKE '%WHEN invalid_parameter_value THEN%'
  AND pg_get_functiondef('public.omnipack_dispatch_candidate_ids(integer)'::regprocedure)
    NOT LIKE '%WHEN OTHERS THEN%',
  'queue selection withholds a row whose preparation refuses, and still propagates non-structural errors'
);

ROLLBACK;
