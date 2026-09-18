-- pgTAP: `commerce_payment_method_ref_upsert` MERGES consent_snapshot on conflict
-- instead of replacing it wholesale (20260825120000).
--
-- The column carries the recorded autopayment model under `recurringModel`, and
-- since 20260814140000 the ABSENCE of that key means "cannot be charged
-- unattended". A rotation delivery on the reusable-alias rail re-asserts an
-- existing stored method while carrying only the origin and the event name, so
-- under the previous `consent_snapshot = EXCLUDED.consent_snapshot` the model was
-- erased from a healthy mandate and the subscription died at its next renewal.
--
-- The fixtures are deliberately rail-neutral: the behaviour under test belongs to
-- the storage routine, not to any one integration, and every assertion below holds
-- for any caller that re-asserts a stored method with a partial snapshot.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(8);

-- ---- Fixture --------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('55555555-5555-4555-8555-555555555555', 'pmref-merge-o@example.invalid'),
       ('66666666-6666-4666-8666-666666666666', 'pmref-merge-m@example.invalid');

-- Registration of an unattended-capable mandate: the snapshot records the model
-- the payer actually agreed to, which is the evidence the renewal path reads.
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-merge-register-o',
  '55555555-5555-4555-8555-555555555555'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-unattended', NULL, 'active',
  true, NULL,
  '{"recurringModel": "O", "methodLastDigits": "1111", "source": "checkout"}'::jsonb,
  '{}'::jsonb);

-- Registration of a mandate that is NOT unattended-capable. The merge must never
-- invent capability the payer did not grant.
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-merge-register-m',
  '66666666-6666-4666-8666-666666666666'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-attended', NULL, 'active',
  true, NULL,
  '{"recurringModel": "M", "source": "checkout"}'::jsonb,
  '{}'::jsonb);

-- ---- Act 1: a rotation carrying ONLY origin + event name -------------------
-- This is the exact shape the alias rail mints for a rotation. Before the fix it
-- replaced the whole column and took `recurringModel` with it.
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-merge-rotate-o',
  '55555555-5555-4555-8555-555555555555'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-unattended', NULL, 'active',
  true, NULL,
  '{"source": "alias.webhook", "event": "ALIAS_UPDATE"}'::jsonb,
  '{}'::jsonb);

SELECT is(
  (SELECT consent_snapshot ->> 'recurringModel' FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'O', 'a rotation carrying no model leaves the recorded model intact');

-- The incoming keys must still land: a merge that silently dropped EXCLUDED would
-- also satisfy the assertion above, so pin the other direction too.
SELECT is(
  (SELECT consent_snapshot ->> 'event' FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'ALIAS_UPDATE', 'the rotation''s own keys are written');

-- A key the rotation DOES name overwrites the stored value: `||` is right-biased.
SELECT is(
  (SELECT consent_snapshot ->> 'source' FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'alias.webhook', 'a key the caller names takes the caller''s value');

-- ---- Act 2: the merge must not PROMOTE an attended mandate -----------------
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-merge-rotate-m',
  '66666666-6666-4666-8666-666666666666'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-attended', NULL, 'active',
  true, NULL,
  '{"source": "alias.webhook", "event": "ALIAS_UPDATE"}'::jsonb,
  '{}'::jsonb);

SELECT is(
  (SELECT consent_snapshot ->> 'recurringModel' FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-attended'),
  'M', 'an attended mandate is preserved as attended, never promoted');

-- ---- Act 3: published facts must still WIN on key collision ----------------
-- The lifecycle refresh re-asserts the stored row and publishes fresh facts. If
-- the merge operands were reversed the stored value would win and a refreshed
-- fact could never be recorded again - an immortal-stale-value bug that is
-- strictly worse than the erasure this migration fixes, because it is silent.
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-merge-refresh-o',
  '55555555-5555-4555-8555-555555555555'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-unattended', NULL, 'active',
  true, NULL,
  '{"methodLastDigits": "8210", "methodExpiresAt": "2029-11-30T23:59:59.999Z"}'::jsonb,
  '{}'::jsonb);

SELECT is(
  (SELECT consent_snapshot ->> 'methodLastDigits' FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  '8210', 'a refreshed fact overwrites the stale one (merge is right-biased)');

SELECT is(
  (SELECT consent_snapshot ->> 'recurringModel' FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'O', 'the refresh still carries the recorded model forward');

-- ---- Privilege posture -----------------------------------------------------
-- Defence in depth, asserted rather than assumed: this repository has already had
-- a live escalation where a definer routine that derives its acting identity from
-- a caller-supplied parameter was reachable by a browser role. CREATE OR REPLACE
-- preserves privileges, so this pins the state the replace inherited. Each
-- principal is named separately because a REVOKE FROM PUBLIC does not withdraw a
-- grant held directly by anon or authenticated.
SELECT ok(
  NOT has_function_privilege('anon',
    'public.commerce_payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.commerce_payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'public.commerce_payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE'),
  'no browser role and not PUBLIC holds EXECUTE on the method-ref writer');

SELECT ok(
  has_function_privilege('service_role',
    'public.commerce_payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE'),
  'the service role still holds EXECUTE, so the write path is not broken');

SELECT * FROM finish();
ROLLBACK;
