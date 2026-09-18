-- pgTAP: the checkout finalize fingerprint ignores `deliveryContact`, and nothing else.
-- Verifies migration 20260902100000.
--
-- The property under test is a HEALING one, so the fixture is built the way
-- production built it: the seeded `request_fingerprint` is computed with the OLD
-- formula over a realistic pre-20260901103001 metadata blob - the bytes a live row
-- actually stores today. Each case re-presents that same key with the blob the new
-- code sends and asserts what must happen.
--
-- Case 1 is the deploy-boundary wedge; case 2 is the permanent one (a corrected
-- phone). Cases 3-4 are the negative pins that stop the exclusion from ever being
-- widened into an allowlist: every other metadata key is inside fingerprints
-- stored on production, so each must still conflict. Case 5 pins backward
-- compatibility. Case 6 pins the operand's type gate.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(6);

-- pending_payment on purpose: it is the status the terminal allowlist excludes,
-- so any conflict raised below is the GENERIC one the browser cannot rotate on.
-- That is what makes a false conflict here a dead checkout rather than a retry.
INSERT INTO public.commerce_orders (id, status)
VALUES ('70000000-0000-4000-8000-000000000001', 'pending_payment');

-- A realistic pre-20260901103001 runtime metadata blob. Every key here is already
-- inside fingerprints stored on production.
CREATE FUNCTION pg_temp.legacy_metadata()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'checkoutKind', 'subscription_initial',
    'checkoutIntent', 'subscription_initial',
    'cadenceDays', 28,
    'requiresReusablePaymentMethod', true,
    'visitorId', 'visitor-abc',
    'offerPolicyVersion', 'offer-policy-v2',
    'promotionEngineVersion', 'promo-engine-v1',
    'source', 'commerce.runtime.hidden.v0',
    'invoiceBuyerSnapshot', jsonb_build_object(
      'name', 'Test Buyer',
      'email', 'buyer@example.com',
      'taxId', NULL,
      'companyName', NULL,
      'source', 'checkout_invoice_preference',
      'address', jsonb_build_object(
        'line1', '1 Example Street', 'line2', NULL, 'city', 'Example City',
        'postalCode', '00000', 'country', 'ZZ',
        'source', 'checkout_shipping_address'
      )
    ),
    'selectedDelivery', jsonb_build_object(
      'kind', 'courier', 'deliveryKind', 'courier', 'providerKind', 'omnipack',
      'carrierKind', 'dpd', 'carrierCode', 'DPD', 'service', 'standard',
      'serviceCode', 'DPD_COURIER_STANDARD', 'pickupPoint', NULL,
      'providerRef', NULL
    )
  )
$$;

-- The order-owned delivery authority the new code appends, as
-- `buildOrderDeliveryContact` emits it.
CREATE FUNCTION pg_temp.delivery_contact(p_phone text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'source', 'checkout_submission',
    'revision', 1,
    'recipientName', 'Test Buyer',
    'contactEmail', 'buyer@example.com',
    'contactPhone', p_phone,
    'line1', '1 Example Street',
    'line2', NULL,
    'city', 'Example City',
    'postalCode', '00000',
    'country', 'ZZ',
    'selectedDelivery', (SELECT pg_temp.legacy_metadata()->'selectedDelivery'),
    'deliveryInstructions', NULL,
    'courierInstructions', NULL
  )
$$;

CREATE FUNCTION pg_temp.finalize(p_key text, p_metadata jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.commerce_finalize_order_for_checkout(
    p_key,
    '70000000-0000-4000-8000-000000000001',
    'one_time',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    NULL,
    '{"quote":{"context":{"mode":"one_time"},"lines":[]}}'::jsonb,
    '{"orderId":"order_x"}'::jsonb,
    p_metadata
  )
$$;

-- The fingerprint EXACTLY as the pre-fix function wrote it: whole blob, no
-- exclusion. This is the byte string live rows carry.
CREATE FUNCTION pg_temp.stored_fingerprint(p_metadata jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(
    '70000000-0000-4000-8000-000000000001|one_time|'
    || '11111111-1111-4111-8111-111111111111|'
    || '33333333-3333-4333-8333-333333333333||'
    || '{"quote":{"context":{"mode":"one_time"},"lines":[]}}'::jsonb::text
    || '|' || '{"orderId":"order_x"}'::jsonb::text
    || '|' || p_metadata::text
  )
$$;

INSERT INTO public.commerce_idempotency_keys (
  scope, idempotency_key, status, request_fingerprint, response_payload
)
SELECT
  'commerce.checkout_order_finalize',
  k,
  'completed',
  pg_temp.stored_fingerprint(pg_temp.legacy_metadata()),
  '{"finalizedOrder":{"orderId":"70000000-0000-4000-8000-000000000001","replayed":false}}'::jsonb
FROM unnest(ARRAY[
  'checkout:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  'checkout:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  'checkout:cccccccc-3333-4333-8333-cccccccccccc',
  'checkout:dddddddd-4444-4444-8444-dddddddddddd',
  'checkout:eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
]) AS k;

-- 1. THE HEALING PIN. A fingerprint stored by the pre-fix function, re-presented
-- with the blob the post-fix code sends. If this ever fails, every journey open
-- across a deploy is wedged again.
SELECT is(
  (pg_temp.finalize(
    'checkout:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    pg_temp.legacy_metadata() || jsonb_build_object('deliveryContact', pg_temp.delivery_contact('+10000000000'))
  ) #>> '{finalizedOrder,replayed}')::boolean,
  true,
  'a production-stored fingerprint still replays once deliveryContact is added'
);

-- 2. THE PERMANENT WEDGE. The buyer corrects a phone typo after a decline and pays
-- again. contactPhone was in no earlier metadata field, so before this fix the edit
-- alone killed the retry.
SELECT is(
  (pg_temp.finalize(
    'checkout:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    pg_temp.legacy_metadata() || jsonb_build_object('deliveryContact', pg_temp.delivery_contact('+10000000999'))
  ) #>> '{finalizedOrder,replayed}')::boolean,
  true,
  'a corrected contactPhone inside deliveryContact still replays'
);

-- 3. ANTI-ALLOWLIST PIN. checkoutKind is a sibling key that lives in stored
-- fingerprints, and it is the strongest available witness: it decides one_time
-- versus subscription_initial, so a rule that let it drift would let a buyer flip
-- an order's mode between submits and still replay. Widening the exclusion to
-- "strip what the order owns" would silently disable the guard; this refuses it.
SELECT throws_ok(
  $$SELECT pg_temp.finalize(
      'checkout:cccccccc-3333-4333-8333-cccccccccccc',
      (pg_temp.legacy_metadata() || jsonb_build_object('checkoutKind', 'one_time'))
        || jsonb_build_object('deliveryContact', pg_temp.delivery_contact('+10000000000'))
    )$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'a changed checkoutKind still conflicts: the exclusion is one named key, not an allowlist'
);

-- 4. ANTI-ALLOWLIST PIN, second key. selectedDelivery is derived from the same
-- intent as deliveryContact and is the most tempting one to strip alongside it.
SELECT throws_ok(
  $$SELECT pg_temp.finalize(
      'checkout:dddddddd-4444-4444-8444-dddddddddddd',
      (pg_temp.legacy_metadata() || jsonb_build_object('selectedDelivery', jsonb_build_object('kind', 'pickup')))
        || jsonb_build_object('deliveryContact', pg_temp.delivery_contact('+10000000000'))
    )$$,
  'commerce_runtime_finalize_idempotency_conflict',
  'a changed selectedDelivery still conflicts even though deliveryContact embeds it'
);

-- 5. BACKWARD COMPATIBILITY. A caller that sends no deliveryContact at all - an
-- older deployment, or the recovery path replaying a stored blob - must be
-- unaffected by the exclusion.
SELECT is(
  (pg_temp.finalize(
    'checkout:eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
    pg_temp.legacy_metadata()
  ) #>> '{finalizedOrder,replayed}')::boolean,
  true,
  'a blob with no deliveryContact key replays exactly as before'
);

-- 6. THE TYPE GATE. `jsonb - text` raises 22023 on a scalar, and the fingerprint
-- is computed on EVERY call - before the idempotency row is read - so an ungated
-- subtraction would raise ahead of the replay branch and break replays that
-- succeed today. This RPC's signature accepts any jsonb, so a scalar blob must
-- still hash by its own text and replay. Seeded with the old formula over that
-- same scalar: if the gate were dropped, this case raises instead of replaying.
INSERT INTO public.commerce_idempotency_keys (
  scope, idempotency_key, status, request_fingerprint, response_payload
)
VALUES (
  'commerce.checkout_order_finalize',
  'checkout:ffffffff-6666-4666-8666-ffffffffffff',
  'completed',
  pg_temp.stored_fingerprint('"scalar-metadata"'::jsonb),
  '{"finalizedOrder":{"orderId":"70000000-0000-4000-8000-000000000001","replayed":false}}'::jsonb
);

SELECT is(
  (pg_temp.finalize(
    'checkout:ffffffff-6666-4666-8666-ffffffffffff',
    '"scalar-metadata"'::jsonb
  ) #>> '{finalizedOrder,replayed}')::boolean,
  true,
  'a scalar p_metadata hashes by its own text and replays: the operand is type-gated'
);

SELECT * FROM finish();
ROLLBACK;
