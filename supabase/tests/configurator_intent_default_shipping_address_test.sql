-- pgTAP: checkout intent persistence promotes the last checkout shipping address
-- to the customer's default shipping address. This keeps later account checkout
-- and subscription flows aligned with the last selected delivery address.
--
-- Also covers the neutral-seam country contract (20260729040000): the neutral
-- command must carry its own ISO country, while the legacy path keeps the
-- hardcoded fallback it has always had.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(6);

CREATE TEMP TABLE _first AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-default-address-0001",
  "locale": "pl",
  "mode": "one_time",
  "petProfile": { "name": "Asti", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Ela", "lastName": "Testowa", "email": "default-address@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Pierwsza 1", "postalCode": "00-001", "city": "Warszawa", "country": "PL" },
  "selectedDelivery": { "kind": "courier", "deliveryKind": "courier", "providerKind": "omnipack", "carrierKind": "dpd", "carrierCode": "DPD", "serviceCode": "DPD_COURIER_STANDARD", "pickupPoint": null },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

SELECT ok(
  (SELECT is_default FROM public.addresses WHERE id = (SELECT (resp->>'addressId')::uuid FROM _first)),
  'first checkout shipping address is marked default');

CREATE TEMP TABLE _second AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-default-address-0002",
  "locale": "pl",
  "mode": "one_time",
  "petProfile": { "name": "Asti", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Ela", "lastName": "Testowa", "email": "default-address@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Druga 2", "postalCode": "00-002", "city": "Warszawa", "country": "PL" },
  "selectedDelivery": { "kind": "courier", "deliveryKind": "courier", "providerKind": "omnipack", "carrierKind": "inpost", "carrierCode": "INPOST", "serviceCode": "INPOST_COURIER_STANDARD", "pickupPoint": null },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

SELECT isnt(
  (SELECT resp->>'addressId' FROM _second),
  (SELECT resp->>'addressId' FROM _first),
  'second checkout with a different address creates/uses a different shipping address');

SELECT ok(
  (SELECT is_default FROM public.addresses WHERE id = (SELECT (resp->>'addressId')::uuid FROM _second)),
  'second checkout shipping address becomes default');

SELECT is(
  (SELECT count(*)::int FROM public.addresses
    WHERE client_id = (SELECT (resp->>'clientId')::uuid FROM _first)
      AND kind IN ('shipping', 'both')
      AND is_default = true),
  1,
  'only one shipping-capable address remains default for the client');

-- 20260729040000: a neutral checkout command with no country must NOT inherit
-- the legacy default. Guarded before the idempotency-key check, so the minimal
-- payload below is enough to reach it.
SELECT throws_ok(
  $neutral_country$ SELECT public.commerce_configurator_persist_intent(
    '{"version":"commerce.checkout_command.v1","idempotencyKey":"intent-neutral-country-0001","mode":"one_time",
      "customer":{"firstName":"Ela","lastName":"Testowa","email":"neutral-country@example.invalid","phone":"+48123456789"},
      "shippingAddress":{"street":"Testowa 12","postalCode":"00-001","city":"Warszawa"},
      "consents":{"gdpr":true,"marketing":false,"terms":true}}'::jsonb) $neutral_country$,
  '22023', 'configurator_intent_neutral_country_required',
  'neutral checkout command without a country is refused, not defaulted');

-- Characterization, NOT a new rule: the legacy configurator intent still gets
-- the hardcoded fallback for a missing country. This is the behavior the
-- neutral guard is scoped away from; it must stay byte-identical.
CREATE TEMP TABLE _legacy_no_country AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-legacy-no-country-0001",
  "mode": "one_time",
  "petProfile": { "name": "Asti", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Ela", "lastName": "Testowa", "email": "legacy-no-country@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Bez Kraju 3", "postalCode": "00-003", "city": "Warszawa" },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

SELECT is(
  (SELECT country FROM public.addresses
    WHERE id = (SELECT (resp->>'addressId')::uuid FROM _legacy_no_country)),
  'PL',
  'legacy intent without a country still receives the existing hardcoded fallback');

SELECT * FROM finish();
ROLLBACK;
