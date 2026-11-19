-- A linked client requires a verified checkout subject. The browser role
-- retains its own profile edits while account linkage and email stay server-owned.
BEGIN;
SELECT plan(35);

SELECT ok(NOT has_table_privilege('authenticated', 'public.clients', 'UPDATE'),
  'authenticated has no table-wide client update');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'public.clients'::regclass AND attnum > 0 AND NOT attisdropped
    AND attname NOT IN ('first_name', 'last_name', 'phone', 'updated_at')
    AND has_column_privilege('authenticated', 'public.clients', attname, 'UPDATE')
), 'authenticated cannot update account identity or other protected columns');
SELECT ok(NOT has_any_column_privilege('anon', 'public.clients', 'UPDATE'),
  'anonymous role has no client update');
SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_configurator_persist_intent(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.commerce_configurator_persist_intent(jsonb)', 'EXECUTE'),
  'browser roles cannot call the service-owned identity RPC');

SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_configurator_read_completed_intent(text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.commerce_configurator_read_completed_intent(text,uuid)', 'EXECUTE'),
  'browser roles cannot read a service-owned checkout receipt');

SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_configurator_replay_checkout_command(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.commerce_configurator_replay_checkout_command(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.commerce_configurator_replay_checkout_command(jsonb)', 'EXECUTE'),
  'only the service can replay a completed checkout command');

INSERT INTO auth.users (id, email) VALUES
  ('c4280000-0000-4000-8000-000000000001', 'linked-checkout@example.invalid'),
  ('c4280000-0000-4000-8000-000000000002', 'other-checkout@example.invalid');
INSERT INTO public.clients (id, auth_user_id, email) VALUES
  ('c4280000-0000-4000-8000-000000000003', 'c4280000-0000-4000-8000-000000000001', 'linked-checkout@example.invalid');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c4280000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT results_eq(
  $$ UPDATE public.clients SET first_name = 'Verified', last_name = 'Buyer',
     phone = '+10000000000', updated_at = now()
     WHERE id = 'c4280000-0000-4000-8000-000000000003' RETURNING first_name $$,
  $$ VALUES ('Verified'::text) $$,
  'customer self-service can still edit the existing profile fields');
RESET ROLE;

CREATE TEMP TABLE checkout_ownership_input (intent jsonb NOT NULL);
INSERT INTO checkout_ownership_input VALUES
  ('{"version":"commerce.checkout_command.v1","idempotencyKey":"ownership-guest-normal",
     "mode":"one_time","customer":{"firstName":"Synthetic","lastName":"Guest","email":"guest-checkout@example.invalid"},
     "shippingAddress":{"street":"Example 1","postalCode":"00000","city":"Example","country":"US"}}');
GRANT SELECT ON checkout_ownership_input TO service_role;

SET LOCAL ROLE service_role;
CREATE TEMP TABLE checkout_ownership_guest AS
  SELECT public.commerce_configurator_persist_intent(intent) AS body FROM checkout_ownership_input;
SELECT ok((SELECT body->>'addressId' IS NOT NULL FROM checkout_ownership_guest),
  'a first guest checkout can persist and receive its own destination');
SELECT is(
  (SELECT public.commerce_configurator_persist_intent(intent)->>'replayed' FROM checkout_ownership_input),
  'true', 'an exact retry for an unlinked guest still replays');
SELECT is(
  (SELECT response_payload->>'replayed' FROM public.commerce_configurator_read_completed_intent('ownership-guest-normal', NULL)),
  'false', 'read-only compatibility can read the original guest receipt');
SELECT throws_ok(
  $$ SELECT public.commerce_configurator_persist_intent(intent || '{"idempotencyKey":"ownership-owner-new"}'
       || '{"customer":{"firstName":"Synthetic","lastName":"Buyer","email":"linked-checkout@example.invalid"}}')
       FROM checkout_ownership_input $$,
  '42501', 'checkout_identity_authorization_required', 'linked checkout requires an authenticated subject');
SELECT throws_ok(
  $$ SELECT public.commerce_configurator_persist_intent(intent || '{"idempotencyKey":"ownership-owner-other"}'
       || '{"customer":{"firstName":"Synthetic","lastName":"Buyer","email":"linked-checkout@example.invalid"},
            "authenticatedUserId":"c4280000-0000-4000-8000-000000000002"}')
       FROM checkout_ownership_input $$,
  '42501', 'checkout_identity_authorization_required', 'the authenticated subject must own the linked client');
RESET ROLE;

SELECT is((SELECT count(*) FROM public.addresses WHERE client_id = 'c4280000-0000-4000-8000-000000000003'),
  0::bigint, 'an ownership refusal leaves the linked client without any new address');
SELECT is((SELECT count(*) FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce_configurator_intent' AND idempotency_key IN ('ownership-owner-new', 'ownership-owner-other')),
  0::bigint, 'an ownership refusal leaves no checkout persistence receipt');

CREATE TEMP TABLE checkout_ownership_verified AS
SELECT intent || '{"idempotencyKey":"ownership-owner-verified"}'
       || '{"customer":{"firstName":"Verified","lastName":"Buyer","email":"linked-checkout@example.invalid"},
            "authenticatedUserId":"c4280000-0000-4000-8000-000000000001"}' AS intent
FROM checkout_ownership_input;
GRANT SELECT ON checkout_ownership_verified TO service_role;

SET LOCAL ROLE service_role;
SELECT is(
  (SELECT public.commerce_configurator_persist_intent(intent)->>'clientId' FROM checkout_ownership_verified),
  'c4280000-0000-4000-8000-000000000003', 'verified checkout still resolves the linked client');
SELECT is(
  (SELECT public.commerce_configurator_persist_intent(intent)->>'replayed' FROM checkout_ownership_verified),
  'true', 'the same verified subject can retry its exact request');
SELECT is(
  (SELECT public.commerce_configurator_replay_checkout_command(intent)->>'replayed' FROM checkout_ownership_verified),
  'true', 'the linked buyer can read an exact checkout command with its canonical fingerprint');
SELECT is(
  (SELECT public.commerce_configurator_replay_checkout_command(intent || '{"idempotencyKey":"ownership-missing"}')
     FROM checkout_ownership_verified),
  NULL::jsonb, 'read-only checkout replay requires a completed receipt');
SELECT ok(
  (SELECT request_fingerprint IS NOT NULL FROM public.commerce_configurator_read_completed_intent('ownership-owner-verified', 'c4280000-0000-4000-8000-000000000001')),
  'the verified owner can read a complete receipt and fingerprint');
SELECT is(
  (SELECT count(*) FROM public.commerce_configurator_read_completed_intent('ownership-owner-verified', NULL)),
  0::bigint, 'an anonymous conflict fallback cannot receive the linked receipt');
SELECT is(
  (SELECT count(*) FROM public.commerce_configurator_read_completed_intent('ownership-owner-verified', 'c4280000-0000-4000-8000-000000000002')),
  0::bigint, 'a different account cannot read a linked receipt');
RESET ROLE;

UPDATE public.clients SET auth_user_id = 'c4280000-0000-4000-8000-000000000002'
WHERE email = 'guest-checkout@example.invalid';
-- Exercise compatibility with a receipt written before the canonical checkout
-- fingerprint was introduced.
UPDATE public.commerce_idempotency_keys AS receipt
SET request_fingerprint = md5((input.intent || '{"authenticatedUserId":null}'::jsonb)::text)
FROM checkout_ownership_input AS input
WHERE receipt.scope = 'commerce_configurator_intent' AND receipt.idempotency_key = input.intent->>'idempotencyKey';
CREATE TEMP TABLE checkout_ownership_original_receipt AS
SELECT to_jsonb(receipt) AS body
FROM public.commerce_idempotency_keys AS receipt
WHERE receipt.scope = 'commerce_configurator_intent' AND receipt.idempotency_key = 'ownership-guest-normal';
CREATE TEMP TABLE checkout_ownership_linked_guest AS
SELECT intent || '{"authenticatedUserId":"c4280000-0000-4000-8000-000000000002"}' AS intent
FROM checkout_ownership_input;
GRANT SELECT ON checkout_ownership_linked_guest TO service_role;

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$ SELECT public.commerce_configurator_persist_intent(intent) FROM checkout_ownership_input $$,
  '42501', 'checkout_identity_authorization_required',
  'guest retry is refused once its receipt client is linked to an account');
SELECT is(
  (SELECT count(*) FROM public.commerce_configurator_read_completed_intent('ownership-guest-normal', NULL)),
  0::bigint, 'historical read-only replay also rechecks the receipt client owner');
SELECT is(
  (SELECT public.commerce_configurator_replay_checkout_command(intent) FROM checkout_ownership_input),
  NULL::jsonb, 'anonymous access cannot replay a receipt after the client is linked');
SELECT is(
  (SELECT public.commerce_configurator_replay_checkout_command(intent)->>'replayed'
     FROM checkout_ownership_linked_guest),
  'true', 'the linked buyer can read the unchanged command recorded with a guest fingerprint');
SELECT is(
  (SELECT public.commerce_configurator_replay_checkout_command(
     jsonb_set(intent, '{shippingAddress,city}', '"New City"'::jsonb)) FROM checkout_ownership_linked_guest),
  NULL::jsonb, 'read-only replay refuses a changed delivery address under the original command key');
SELECT throws_ok(
  $$ SELECT public.commerce_configurator_persist_intent(
       jsonb_set(intent, '{shippingAddress,city}', '"New City"'::jsonb)) FROM checkout_ownership_linked_guest $$,
  '23505', 'configurator_intent_idempotency_conflict',
  'the owner must use a new key for a changed checkout command');
SELECT throws_ok(
  $$ SELECT public.commerce_configurator_persist_intent(jsonb_build_object(
       'version', 'commerce.configurator_intent.v1',
       'idempotencyKey', intent->>'idempotencyKey',
       'authenticatedUserId', intent->>'authenticatedUserId',
       'locale', 'en',
       'mode', intent->>'mode',
       'contact', intent->'customer',
       'address', intent->'shippingAddress',
       'petProfile', '{"name":"Sample","breed":"mix","ageBand":"adult","activityLevel":"normal","bcs":"ideal","allergenSlugs":[]}'::jsonb,
       'consents', '{"gdpr":true,"terms":true,"marketing":false}'::jsonb
     )) FROM checkout_ownership_linked_guest $$,
  '23505', 'configurator_intent_idempotency_conflict',
  'an authorized legacy request needs a new key when the original receipt is for a checkout command');
SELECT is(
  (SELECT public.commerce_configurator_persist_intent(intent)->>'replayed' FROM checkout_ownership_linked_guest),
  'true', 'the unchanged command still replays through persistence after the conflict');
SELECT is(
  (SELECT public.commerce_configurator_replay_checkout_command(intent || '{"authenticatedUserId":"invalid"}')
     FROM checkout_ownership_linked_guest),
  NULL::jsonb, 'read-only replay refuses a malformed asserted owner');
SELECT throws_ok(
  $$ SELECT public.commerce_configurator_persist_intent(
       jsonb_set(intent, '{shippingAddress,city}', '"New City"'::jsonb)) FROM checkout_ownership_input $$,
  '42501', 'checkout_identity_authorization_required',
  'reopening a completed receipt requires the current client owner');
RESET ROLE;

SELECT results_eq(
  $$ SELECT to_jsonb(receipt) FROM public.commerce_idempotency_keys AS receipt
     WHERE receipt.scope = 'commerce_configurator_intent' AND receipt.idempotency_key = 'ownership-guest-normal' $$,
  $$ SELECT body FROM checkout_ownership_original_receipt $$,
  'successful read and refusals leave the original receipt and fingerprint intact');
SELECT is((SELECT count(*) FROM public.addresses WHERE client_id = 'c4280000-0000-4000-8000-000000000003'),
  1::bigint, 'verified checkout and its exact retry persist one linked destination');
SELECT is(
  (SELECT count(*) FROM public.addresses AS address
    JOIN public.clients AS client ON client.id = address.client_id
    WHERE client.email = 'guest-checkout@example.invalid'),
  1::bigint, 'read-only replay and refusals do not add a destination');
SELECT is(
  (SELECT count(*) FROM public.pets AS pet
    JOIN public.clients AS client ON client.id = pet.client_id
    WHERE client.email = 'guest-checkout@example.invalid'),
  0::bigint, 'the legacy refusal leaves the checkout client without a new profile');

SELECT * FROM finish();
ROLLBACK;
