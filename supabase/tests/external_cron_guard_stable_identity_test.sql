-- pgTAP: physical database lineage is not authorization. Legacy database cron
-- remains closed; the versioned Vercel RPC needs the deployment's actual
-- Supabase URL, which a copied database cannot supply from its clone runtime.

BEGIN;
SELECT plan(18);

UPDATE private.platform_cron_environment
   SET external_cron_enabled = true,
       expected_abandoned_cart_runtime_url = 'https://production.example.supabase.co'
 WHERE id = true;

SELECT is(
  private.external_cron_is_enabled(),
  false,
  'a copied legacy control row cannot authorize database-originated external cron'
);
SELECT ok(
  (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema = 'private'
       AND table_name = 'platform_cron_environment'
       AND column_name = ANY(ARRAY['expected_system_identifier', 'expected_server_addr', 'expected_server_port'])
  ) = 3,
  'legacy database-identity columns remain stored but no longer authorize cron'
);
SELECT is(
  public.platform_external_cron_guard_readback() ->> 'configured',
  'true',
  'guard readback reports configured environment'
);
SELECT is(
  public.platform_external_cron_guard_readback() ->> 'legacyExternalCronConfigured',
  'true',
  'readback reports copied legacy configuration without treating it as authorization'
);
SELECT is(
  public.platform_external_cron_guard_readback() ->> 'abandonedCartRuntimeIdentityConfigured',
  'true',
  'readback confirms a runtime identity is configured without exposing it'
);
SELECT is(
  public.platform_external_cron_guard_readback() ->> 'guardEnabled',
  'false',
  'readback never claims legacy database cron is enabled'
);
SELECT is(
  ARRAY(
    SELECT key
      FROM jsonb_object_keys(public.platform_external_cron_guard_readback()) AS key
     ORDER BY key
  ),
  ARRAY[
    'abandonedCartRuntimeIdentityConfigured',
    'configured',
    'guardEnabled',
    'legacyExternalCronConfigured'
  ]::text[],
  'readback exposes no copied database fingerprint or runtime URL'
);

SELECT is(
  public.enqueue_abandoned_cart_reminders(1) ->> 'skipped',
  'clone_guard',
  'old one-argument runtime entrypoint fails closed after the migration'
);
SELECT is(
  public.enqueue_abandoned_cart_reminders_from_vercel(1, 'https://clone.example.supabase.co') ->> 'skipped',
  'clone_guard',
  'a physical clone runtime URL cannot satisfy the copied production identity'
);
SELECT is(
  public.enqueue_abandoned_cart_reminders_from_vercel(1, 'https://production.example.supabase.co/') ->> 'skipped',
  NULL::text,
  'the deployed production runtime identity can use the versioned Vercel entrypoint'
);
SELECT is(
  (SELECT enabled FROM public.platform_job_controls WHERE job_name = 'abandoned-cart-reminder'),
  false,
  'release migration leaves the abandoned-cart producer job disabled'
);
SELECT is(
  (SELECT metadata ->> 'requiresFlag' FROM public.platform_job_controls WHERE job_name = 'abandoned-cart-reminder'),
  'COMMERCE_ABANDONED_CART_ENABLED',
  'producer control declares the same explicit runtime activation flag'
);

UPDATE private.platform_cron_environment
   SET external_cron_enabled = false
 WHERE id = true;

SELECT is(
  private.external_cron_is_enabled(),
  true,
  'the active versioned call retains its transaction-local production identity only for this transaction'
);
SELECT is(
  public.enqueue_abandoned_cart_reminders_from_vercel(1, 'https://clone.example.supabase.co') ->> 'skipped',
  'clone_guard',
  'a later clone invocation resets the transaction-local identity and still fails closed'
);

DELETE FROM private.platform_cron_environment WHERE id = true;

SELECT is(
  private.external_cron_is_enabled(),
  false,
  'missing runtime configuration fails closed'
);
SELECT is(
  public.platform_external_cron_guard_readback() ->> 'configured',
  'false',
  'missing guard configuration remains a sanitized readback state'
);
SELECT ok(
  has_function_privilege('service_role', 'public.platform_external_cron_guard_readback()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.platform_external_cron_guard_readback()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.platform_external_cron_guard_readback()', 'EXECUTE'),
  'only service_role can execute the sanitized guard readback'
);
SELECT ok(
  has_function_privilege('service_role', 'public.enqueue_abandoned_cart_reminders_from_vercel(integer, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.enqueue_abandoned_cart_reminders_from_vercel(integer, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.enqueue_abandoned_cart_reminders_from_vercel(integer, text)', 'EXECUTE'),
  'only service_role can invoke the versioned Vercel enqueue entrypoint'
);

SELECT * FROM finish();
ROLLBACK;
