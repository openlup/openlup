-- pgTAP: checkout destinations preserve saved guest defaults; a server-proved
-- matching account may promote its selected shipping address.
--
-- Also covers the neutral-seam country contract (20260729040000): the neutral
-- command must carry its own ISO country; legacy omitted-country input uses
-- the configured platform region.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(10);

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
  NOT (SELECT is_default FROM public.addresses WHERE id = (SELECT (resp->>'addressId')::uuid FROM _second)),
  'guest destination does not replace the saved default');
SELECT ok(
  (SELECT is_default FROM public.addresses WHERE id = (SELECT (resp->>'addressId')::uuid FROM _first)),
  'guest destination preserves the first default address');

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

-- Only the server-proved matching account can promote a subsequent destination.
INSERT INTO auth.users(id) VALUES ('f1000000-0000-4000-8000-000000000001');
UPDATE public.clients SET auth_user_id='f1000000-0000-4000-8000-000000000001'
WHERE id=(SELECT (resp->>'clientId')::uuid FROM _first);
CREATE TEMP TABLE _matched AS SELECT public.commerce_configurator_persist_intent(
 jsonb_build_object('version','commerce.configurator_intent.v1','idempotencyKey','matched-default-address-case-a',
 'authenticatedUserId','f1000000-0000-4000-8000-000000000001','mode','one_time',
 'contact',jsonb_build_object('firstName','Synthetic','lastName','Person','email','default-address@example.invalid','phone','+10000000000'),
 'address',jsonb_build_object('street','Synthetic 3','postalCode','00000','city','Synthetic','country','ZZ'),
 'consents',jsonb_build_object('gdpr',true,'marketing',false,'terms',true))) resp;
SELECT ok((SELECT is_default FROM public.addresses WHERE id=(SELECT (resp->>'addressId')::uuid FROM _matched)),
 'matching account promotes its destination to default');
SELECT ok(NOT (SELECT is_default FROM public.addresses WHERE id=(SELECT (resp->>'addressId')::uuid FROM _first)),
 'matching account replaces its previous default');

-- Legacy fallback refuses absent installation policy and reads its configured value.
DELETE FROM public.commerce_settings WHERE key='settlement_region';
SELECT throws_ok($q$SELECT public.platform_region_code()$q$, '55000',
 'settlement region is not configured in commerce_settings', 'missing settlement region refuses fallback');
INSERT INTO public.commerce_settings(key,value_text) VALUES ('settlement_region','ZZ');
CREATE TEMP TABLE _legacy_no_country AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-legacy-no-country-0001",
  "mode": "one_time",
  "petProfile": { "name": "Synthetic", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Synthetic", "lastName": "Person", "email": "legacy-no-country@example.invalid", "phone": "+10000000000" },
  "address": { "street": "Synthetic 3", "postalCode": "00000", "city": "Synthetic" },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

SELECT is(
  (SELECT country FROM public.addresses
    WHERE id = (SELECT (resp->>'addressId')::uuid FROM _legacy_no_country)),
  'ZZ',
  'legacy intent without a country uses the configured platform region');

SELECT * FROM finish();
ROLLBACK;
