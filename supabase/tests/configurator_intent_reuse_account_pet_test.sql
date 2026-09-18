-- pgTAP: configurator persist-intent reuses the referenced account pet
-- (20260710111000). A returning customer placing another order with
-- petProfile.petId set must reuse that pet (no duplicate "Asti" profile), and the
-- reuse is owner-scoped — a petId pointing at another client's pet is ignored.
--
-- Also covers the neutral-seam counterpart (20260728120000): the pet-less
-- commerce.checkout_command.v1 must REFUSE a petProfile rather than silently
-- discard it.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(6);

-- Seed: first order for client A (no petId) provisions the client + pet P1.
CREATE TEMP TABLE _seed AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-reuse-pet-seed-0001",
  "locale": "pl",
  "mode": "one_time",
  "petProfile": { "name": "Asti", "breed": "mix", "ageBand": "young", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Ela", "lastName": "Testowa", "email": "reuse-pet@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Słoneczna 15", "postalCode": "00-001", "city": "Warszawa", "country": "PL" },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

-- Second order for the SAME customer, a fresh key, carrying petProfile.petId = P1.
CREATE TEMP TABLE _reuse AS
SELECT public.commerce_configurator_persist_intent(
  jsonb_build_object(
    'version', 'commerce.configurator_intent.v1',
    'idempotencyKey', 'intent-reuse-pet-second-0002',
    'locale', 'pl',
    'mode', 'one_time',
    'petProfile', jsonb_build_object(
      'petId', (SELECT resp->>'petId' FROM _seed),
      'name', 'Asti', 'breed', 'mix', 'ageBand', 'young',
      'activityLevel', 'normal', 'bcs', 'ideal', 'allergenSlugs', '[]'::jsonb
    ),
    'contact', jsonb_build_object('firstName', 'Ela', 'lastName', 'Testowa', 'email', 'reuse-pet@example.invalid', 'phone', '+48123456789'),
    'address', jsonb_build_object('street', 'Słoneczna 15', 'postalCode', '00-001', 'city', 'Warszawa', 'country', 'PL'),
    'consents', jsonb_build_object('gdpr', true, 'marketing', false, 'terms', true)
  )
) AS resp;

SELECT is(
  (SELECT resp->>'petId' FROM _reuse),
  (SELECT resp->>'petId' FROM _seed),
  'second order with petProfile.petId reuses the existing pet');

SELECT is(
  (SELECT count(*)::int FROM public.pets WHERE client_id = (SELECT (resp->>'clientId')::uuid FROM _seed)),
  1,
  'reuse does not insert a duplicate pet for the client');

-- Owner scoping: a DIFFERENT customer passing client A's petId must NOT reuse it.
CREATE TEMP TABLE _other AS
SELECT public.commerce_configurator_persist_intent(
  jsonb_build_object(
    'version', 'commerce.configurator_intent.v1',
    'idempotencyKey', 'intent-reuse-pet-other-0003',
    'locale', 'pl',
    'mode', 'one_time',
    'petProfile', jsonb_build_object(
      'petId', (SELECT resp->>'petId' FROM _seed),
      'name', 'Rex', 'breed', 'mix', 'ageBand', 'adult',
      'activityLevel', 'normal', 'bcs', 'ideal', 'allergenSlugs', '[]'::jsonb
    ),
    'contact', jsonb_build_object('firstName', 'Inny', 'lastName', 'Klient', 'email', 'reuse-pet-other@example.invalid', 'phone', '+48987654321'),
    'address', jsonb_build_object('street', 'Inna 1', 'postalCode', '00-002', 'city', 'Kraków', 'country', 'PL'),
    'consents', jsonb_build_object('gdpr', true, 'marketing', false, 'terms', true)
  )
) AS resp;

SELECT isnt(
  (SELECT resp->>'petId' FROM _other),
  (SELECT resp->>'petId' FROM _seed),
  'another client cannot reuse a pet they do not own (owner-scoped lookup)');

SELECT isnt(
  (SELECT resp->>'clientId' FROM _other),
  (SELECT resp->>'clientId' FROM _seed),
  'the other order is provisioned under its own client');

-- Neutral seam (20260728120000): commerce.checkout_command.v1 skips every pet
-- write above. A petProfile on that version is therefore not "extra data" — it
-- is a subject the RPC would silently discard, so it fails closed instead. This
-- is the guard PR 2284 shipped with no negative test; PR 2297 restored the
-- sibling finalize guard after the same class of silent deletion.
SELECT throws_ok(
  $neutral_pet$ SELECT public.commerce_configurator_persist_intent(
    '{"version":"commerce.checkout_command.v1","idempotencyKey":"intent-neutral-petprofile-0001","mode":"one_time",
      "petProfile":{"name":"Asti","breed":"mix","ageBand":"adult","activityLevel":"normal","bcs":"ideal","allergenSlugs":[]},
      "customer":{"firstName":"Ela","lastName":"Testowa","email":"neutral-petprofile@example.invalid","phone":"+48123456789"},
      "shippingAddress":{"street":"Testowa 12","postalCode":"00-001","city":"Warszawa","country":"DE"},
      "consents":{"gdpr":true,"marketing":false,"terms":true}}'::jsonb) $neutral_pet$,
  '22023', 'configurator_intent_neutral_pet_profile_forbidden',
  'neutral checkout command with a pet profile is refused, not silently stripped');

-- The same petProfile on the legacy version is still the normal path.
SELECT ok(
  (SELECT public.commerce_configurator_persist_intent(
    '{"version":"commerce.configurator_intent.v1","idempotencyKey":"intent-neutral-petprofile-0002","mode":"one_time",
      "petProfile":{"name":"Asti","breed":"mix","ageBand":"adult","activityLevel":"normal","bcs":"ideal","allergenSlugs":[]},
      "contact":{"firstName":"Ela","lastName":"Testowa","email":"neutral-petprofile-legacy@example.invalid","phone":"+48123456789"},
      "address":{"street":"Testowa 12","postalCode":"00-001","city":"Warszawa","country":"PL"},
      "consents":{"gdpr":true,"marketing":false,"terms":true}}'::jsonb)->>'petId') IS NOT NULL,
  'the legacy version still provisions a pet from the same petProfile');

SELECT * FROM finish();
ROLLBACK;
