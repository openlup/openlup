-- pgTAP: configurator persist-intent stable-journey-key contract (20260714201100+).
--   * same key + byte-identical payload + completed -> REPLAY (replayed=true,
--     same identity) — the FE-reused-key happy path
--   * same key + a DIFFERENT payload (edited cart / pet profile) -> idempotent
--     identity UPDATE: NO 23505, SAME clientId + SAME petId, pet refreshed to the
--     new payload, and still exactly one completed key row. Previously this raised
--     configurator_intent_idempotency_conflict (23505); the stable journey key
--     turns it into an in-place update so checkout is not deadlocked.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(6);

-- First submit: provisions identity and completes the key.
CREATE TEMP TABLE _first AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-idem-conflict-0001",
  "locale": "pl",
  "mode": "one_time",
  "petProfile": { "name": "Rex", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Jan", "lastName": "Kowalski", "email": "idem-conflict@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Testowa 12", "postalCode": "00-001", "city": "Warszawa", "country": "PL" },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

-- Same key + BYTE-IDENTICAL payload -> idempotent replay.
CREATE TEMP TABLE _replay AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-idem-conflict-0001",
  "locale": "pl",
  "mode": "one_time",
  "petProfile": { "name": "Rex", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Jan", "lastName": "Kowalski", "email": "idem-conflict@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Testowa 12", "postalCode": "00-001", "city": "Warszawa", "country": "PL" },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

SELECT is(
  (SELECT resp->>'replayed' FROM _replay),
  'true',
  'same key + identical payload replays the completed response');

SELECT is(
  (SELECT resp->>'clientId' FROM _replay),
  (SELECT resp->>'clientId' FROM _first),
  'replay returns the same provisioned identity');

-- Same key + a DIFFERENT payload (pet name changed -> different md5 fingerprint).
-- Stable journey key: this must NOT raise; it is an idempotent identity UPDATE.
CREATE TEMP TABLE _edited AS
SELECT public.commerce_configurator_persist_intent('{
  "version": "commerce.configurator_intent.v1",
  "idempotencyKey": "intent-idem-conflict-0001",
  "locale": "pl",
  "mode": "one_time",
  "petProfile": { "name": "Burek", "breed": "mix", "ageBand": "adult", "activityLevel": "normal", "bcs": "ideal", "allergenSlugs": [] },
  "contact": { "firstName": "Jan", "lastName": "Kowalski", "email": "idem-conflict@example.invalid", "phone": "+48123456789" },
  "address": { "street": "Testowa 12", "postalCode": "00-001", "city": "Warszawa", "country": "PL" },
  "consents": { "gdpr": true, "marketing": false, "terms": true }
}'::jsonb) AS resp;

SELECT is(
  (SELECT resp->>'clientId' FROM _edited),
  (SELECT resp->>'clientId' FROM _first),
  'same key + edited payload keeps the SAME client (no second identity)');

SELECT is(
  (SELECT resp->>'petId' FROM _edited),
  (SELECT resp->>'petId' FROM _first),
  'same key + edited payload reuses the SAME pet (in-place update, not a new pet)');

SELECT is(
  (SELECT name FROM public.pets WHERE id = (SELECT (resp->>'petId')::uuid FROM _first)),
  'Burek',
  'the reused pet is refreshed to the edited profile');

-- And the key row is still exactly one completed row (re-opened + re-completed).
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce_configurator_intent'
      AND idempotency_key = 'intent-idem-conflict-0001'
      AND status = 'completed'),
  1,
  'the edited retry keeps exactly one completed key row (idempotent upsert)');

SELECT * FROM finish();
ROLLBACK;
