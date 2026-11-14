
BEGIN;
SELECT plan(8);

INSERT INTO public.clients (id, email)
VALUES ('55555555-5555-4555-8555-555555555555', 'pmref-merge-o@example.invalid'),
       ('66666666-6666-4666-8666-666666666666', 'pmref-merge-m@example.invalid');

SELECT public.payment_method_ref_upsert(
  'pmref-merge-register-o',
  '55555555-5555-4555-8555-555555555555'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-unattended', NULL, 'active',
  true, NULL,
  '{"recurringModel": "O", "methodLastDigits": "1111", "source": "checkout"}'::jsonb,
  '{}'::jsonb);

SELECT public.payment_method_ref_upsert(
  'pmref-merge-register-m',
  '66666666-6666-4666-8666-666666666666'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-attended', NULL, 'active',
  true, NULL,
  '{"recurringModel": "M", "source": "checkout"}'::jsonb,
  '{}'::jsonb);

SELECT public.payment_method_ref_upsert(
  'pmref-merge-rotate-o',
  '55555555-5555-4555-8555-555555555555'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-unattended', NULL, 'active',
  true, NULL,
  '{"source": "alias.webhook", "event": "ALIAS_UPDATE"}'::jsonb,
  '{}'::jsonb);

SELECT is(
  (SELECT consent_snapshot ->> 'recurringModel' FROM public.payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'O', 'a rotation carrying no model leaves the recorded model intact');

SELECT is(
  (SELECT consent_snapshot ->> 'event' FROM public.payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'ALIAS_UPDATE', 'the rotation''s own keys are written');

SELECT is(
  (SELECT consent_snapshot ->> 'source' FROM public.payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'alias.webhook', 'a key the caller names takes the caller''s value');

SELECT public.payment_method_ref_upsert(
  'pmref-merge-rotate-m',
  '66666666-6666-4666-8666-666666666666'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-attended', NULL, 'active',
  true, NULL,
  '{"source": "alias.webhook", "event": "ALIAS_UPDATE"}'::jsonb,
  '{}'::jsonb);

SELECT is(
  (SELECT consent_snapshot ->> 'recurringModel' FROM public.payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-attended'),
  'M', 'an attended mandate is preserved as attended, never promoted');

SELECT public.payment_method_ref_upsert(
  'pmref-merge-refresh-o',
  '55555555-5555-4555-8555-555555555555'::uuid,
  NULL, 'aliasrail', 'alias', NULL, 'alias-unattended', NULL, 'active',
  true, NULL,
  '{"methodLastDigits": "8210", "methodExpiresAt": "2029-11-30T23:59:59.999Z"}'::jsonb,
  '{}'::jsonb);

SELECT is(
  (SELECT consent_snapshot ->> 'methodLastDigits' FROM public.payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  '8210', 'a refreshed fact overwrites the stale one (merge is right-biased)');

SELECT is(
  (SELECT consent_snapshot ->> 'recurringModel' FROM public.payment_method_refs
    WHERE provider_kind = 'aliasrail' AND provider_method_ref = 'alias-unattended'),
  'O', 'the refresh still carries the recorded model forward');

SELECT ok(
  NOT has_function_privilege('anon',
    'public.payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'public.payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE'),
  'no browser role and not PUBLIC holds EXECUTE on the method-ref writer');

SELECT ok(
  has_function_privilege('service_role',
    'public.payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb)', 'EXECUTE'),
  'the service role still holds EXECUTE, so the write path is not broken');

SELECT * FROM finish();
ROLLBACK;
