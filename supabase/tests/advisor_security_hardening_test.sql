-- pgTAP: advisor security hardening (20260714140000_advisor_security_hardening).
--   Locally-verifiable slice of the migration: the mutable-search_path functions are
--   pinned to a fixed search_path after the migration applies. The internal-tool tables
--   (crm_*, interzoo_*, promo_*, share_links) and the two internal storage buckets are
--   PROD-ONLY (absent on the empty local DB), so their admin-gate/listing changes no-op
--   here and are verified instead by the post-deploy Management-API advisor re-pull.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Every function flagged function_search_path_mutable now has a pinned search_path
-- (proconfig contains a search_path entry). Guards behaviour: search_path is no longer
-- caller-mutable.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT p.proconfig IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = fn),
  'search_path pinned on public.' || fn)
FROM unnest(ARRAY[
  'get_active_tester_count',
  'accounting_normalize_pl_nip',
  'accounting_is_valid_pl_nip',
  'communication_state_rank',
  'communication_normalize_email',
  'communication_email_delivery_reason_code',
  'communication_email_delivery_purpose_for_event',
  'communication_email_delivery_template_for_event',
  'communication_email_delivery_cleanup_outbox',
  'commerce_order_number_from_id'
]) AS fn;

-- ---------------------------------------------------------------------------
-- The always-true admin-roster read policy is gone; the correct scoped policy remains.
-- (admin_users exists on every env.)
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'admin_users'
     AND policyname = 'auth_select_admin_users'),
  0,
  'always-true auth_select_admin_users policy removed from admin_users');

SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'admin_users'
     AND policyname = 'admin_select_admin_users'),
  1,
  'scoped admin_select_admin_users policy retained on admin_users');

SELECT * FROM finish();
ROLLBACK;
