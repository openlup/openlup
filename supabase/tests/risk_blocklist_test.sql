-- pgTAP: Risk Layer exact blocklist RPC.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

INSERT INTO public.risk_blocklist_entries (
  subject_kind,
  subject_hash,
  status,
  reason_code,
  starts_at,
  expires_at
)
VALUES
  ('email', 'hash_active_email_1234567890', 'active', 'manual_block', now() - interval '1 minute', NULL),
  ('ip', 'hash_expired_ip_1234567890', 'active', 'expired_block', now() - interval '2 days', now() - interval '1 day'),
  ('device', 'hash_inactive_device_123456', 'inactive', 'inactive_block', now() - interval '1 day', NULL);

SELECT is(
  (public.risk_check_exact_blocklist('[{"subjectKind":"email","subjectHash":"hash_active_email_1234567890"}]'::jsonb)->>'blocked')::boolean,
  true,
  'active exact match blocks'
);

SELECT is(
  (public.risk_check_exact_blocklist('[{"subjectKind":"ip","subjectHash":"hash_expired_ip_1234567890"}]'::jsonb)->>'blocked')::boolean,
  false,
  'expired match does not block'
);

SELECT is(
  (public.risk_check_exact_blocklist('[{"subjectKind":"device","subjectHash":"hash_inactive_device_123456"}]'::jsonb)->>'blocked')::boolean,
  false,
  'inactive match does not block'
);

SELECT has_function(
  'public', 'risk_check_exact_blocklist', ARRAY['jsonb'],
  'risk_check_exact_blocklist exists'
);

SELECT is(
  (SELECT count(*)::int
     FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'risk_check_exact_blocklist'
      AND grantee IN ('anon', 'authenticated')),
  0,
  'blocklist RPC is not granted to anon/authenticated'
);

SELECT * FROM finish();
ROLLBACK;
