-- pgTAP: the admin email console's template selector is a complete service-only
-- scalar read. PostgreSQL removes null/empty values and duplicate rows before
-- transfer, including when the distinct set is larger than a row-return cap.

BEGIN;
SELECT plan(12);

SELECT ok(
  has_function_privilege('service_role', 'public.communication_admin_email_template_slugs()', 'EXECUTE'),
  'service_role can execute the admin email template-slug read');
SELECT ok(
  NOT has_function_privilege('anon', 'public.communication_admin_email_template_slugs()', 'EXECUTE'),
  'anon cannot execute the admin email template-slug read');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.communication_admin_email_template_slugs()', 'EXECUTE'),
  'authenticated cannot execute the admin email template-slug read');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = 'public.communication_admin_email_template_slugs()'::regprocedure
      AND prosecdef = false
      AND provolatile = 's'
      AND proconfig @> ARRAY['search_path=pg_catalog, public']
  ),
  'the template-slug routine is stable, invoker-rights, and fixes its search path');

SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$SELECT public.communication_admin_email_template_slugs()$$,
  'service_role can execute the invoker-rights read against the native schema');
RESET ROLE;

INSERT INTO public.email_sends (id, resend_id, template_slug, status, sent_at)
SELECT
  ('eb000000-0000-4000-8000-' || lpad(to_hex(fixture_id), 12, '0'))::uuid,
  'ps3b-resend-' || fixture_id,
  'ps3b-slug-' || lpad((((fixture_id - 1) % 1005) + 1)::text, 4, '0'),
  'sent',
  now()
FROM generate_series(1, 2010) AS fixture(fixture_id);

INSERT INTO public.email_sends (id, resend_id, template_slug, status, sent_at)
VALUES
  ('eb000001-0000-4000-8000-000000000001', 'ps3b-null', NULL, 'sent', now()),
  ('eb000001-0000-4000-8000-000000000002', 'ps3b-empty', '', 'sent', now()),
  ('eb000001-0000-4000-8000-000000000003', 'ps3b-space', ' ', 'sent', now()),
  ('eb000001-0000-4000-8000-000000000004', 'ps3b-byte-1', 'ps3b-byte-Ż', 'sent', now()),
  ('eb000001-0000-4000-8000-000000000005', 'ps3b-byte-2', U&'ps3b-byte-Z\0307', 'sent', now());

CREATE TEMP TABLE _admin_email_template_slugs AS
SELECT public.communication_admin_email_template_slugs() AS value;

SELECT is(
  (SELECT jsonb_typeof(value) FROM _admin_email_template_slugs),
  'array',
  'the routine returns one JSON array scalar');
SELECT is(
  (SELECT count(*)::integer
     FROM _admin_email_template_slugs,
          jsonb_array_elements_text(value) AS slug(value)
    WHERE slug.value LIKE 'ps3b-slug-%'),
  1005,
  'all 1005 distinct fixture slugs survive the scalar boundary');
SELECT is(
  (SELECT count(*)::integer
     FROM _admin_email_template_slugs,
          jsonb_array_elements_text(value) AS slug(value)
    WHERE slug.value = 'ps3b-slug-0001'),
  1,
  'duplicate source rows become one transferred slug value');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM _admin_email_template_slugs,
         jsonb_array_elements_text(value) AS slug(value)
    WHERE slug.value = 'ps3b-slug-1005'
  ),
  'the value beyond a 1000-row return cap remains present');
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM _admin_email_template_slugs,
         jsonb_array_elements_text(value) AS slug(value)
    WHERE slug.value IS NULL OR slug.value = ''
  ),
  'null and empty template slugs remain absent');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM _admin_email_template_slugs,
         jsonb_array_elements_text(value) AS slug(value)
    WHERE slug.value = ' '
  ),
  'a non-empty whitespace slug remains present like the former Boolean filter');
SELECT ok(
  (SELECT value @> to_jsonb(ARRAY['ps3b-byte-Ż', U&'ps3b-byte-Z\0307'])
     FROM _admin_email_template_slugs),
  'byte-distinct Unicode slugs both remain present');

SELECT * FROM finish();
ROLLBACK;
