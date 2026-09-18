-- pgTAP: subscription_list_due_for_winback RPC (S5b win-back cron source).
--
-- Run via: supabase test db
--
-- Eligibility is the positive fail-closed marker
-- subscriptions.cancellation_source = 'customer_self_service', written only by
-- the self-service cancel trigger. Seeds, all relative to now() so the test
-- never goes stale:
--   A — customer-cancelled 30 days ago, no prior nudge     → ELIGIBLE
--   B — customer-cancelled 200 days ago (outside 120d)     → excluded (window)
--   C — customer-cancelled 20 days ago, current nudge sent → excluded (dedupe)
--   D — active subscription                                → excluded (status)
--   E — system_refund_reversal source                      → excluded (marker)
--   F — customer re-cancel after an old winback event      → ELIGIBLE
--   G — ghost: cancelled, ended_at set, no reason, no marker → excluded
--   H — system_provisional_activation_timeout source       → excluded (marker)
--   I — customer-cancelled just under 14 days ago          → excluded (floor)
--   J — customer-cancelled exactly 14 days ago             → ELIGIBLE
-- Every marker case sits well inside the window on purpose: with the 14-day
-- floor in place, a 3-day-old seed would be excluded by the window and the
-- marker assertion would pass for the wrong reason.
-- G is the shape the previous negative predicate could only exclude via a
-- sweep-order metadata fingerprint; the marker excludes it directly.
-- Respects subscriptions_check (ended_at >= started_at): started_at is set
-- explicitly to a point before each ended_at.

BEGIN;
SELECT plan(10);

SELECT has_function(
  'public', 'subscription_list_due_for_winback', ARRAY['integer'],
  'S5b: win-back list RPC exists with the integer limit signature');

INSERT INTO public.clients (id, email)
VALUES ('b6000000-0000-0000-0000-000000000001', 'winback-rpc@example.invalid');

WITH fixture_settings(value) AS (VALUES ('PLN'))
INSERT INTO public.subscriptions
  (id, client_id, cadence_days, currency, status, started_at, ended_at,
   cancellation_reason, cancellation_source)
VALUES
  -- A: eligible
  ('b6100000-0000-0000-0000-00000000000a', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '30 days',
   'customer_cancelled', 'customer_self_service'),
  -- B: cancelled too long ago (outside the 120-day window)
  ('b6100000-0000-0000-0000-00000000000b', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '400 days', now() - interval '200 days',
   'customer_cancelled', 'customer_self_service'),
  -- C: cancelled in-window but already nudged
  ('b6100000-0000-0000-0000-00000000000c', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '20 days',
   'customer_cancelled', 'customer_self_service'),
  -- D: active (never a win-back candidate)
  ('b6100000-0000-0000-0000-00000000000d', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'active',
   now() - interval '30 days', NULL,
   NULL, NULL),
  -- E: cancelled by system refund reversal
  ('b6100000-0000-0000-0000-00000000000e', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '20 days',
   'refund_reversed_activation', 'system_refund_reversal'),
  -- F: re-cancelled after a previous winback event
  ('b6100000-0000-0000-0000-00000000000f', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '20 days',
   'customer_cancelled', 'customer_self_service'),
  -- G: ghost — ended_at set by an unmarked path, no cancellation reason
  ('b6100000-0000-0000-0000-000000000010', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '20 days',
   NULL, NULL),
  -- H: cancelled by the provisional activation timeout sweep
  ('b6100000-0000-0000-0000-000000000011', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '20 days',
   'provisional_payment_window_elapsed', 'system_provisional_activation_timeout'),
  -- I: customer-cancelled, but still inside the 14-day floor
  ('b6100000-0000-0000-0000-000000000012', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '13 days 23 hours',
   'customer_cancelled', 'customer_self_service'),
  -- J: customer-cancelled at the inclusive 14-day boundary
  ('b6100000-0000-0000-0000-000000000013', 'b6000000-0000-0000-0000-000000000001',
   28, (SELECT value FROM fixture_settings), 'cancelled',
   now() - interval '200 days', now() - interval '14 days',
   'customer_cancelled', 'customer_self_service');

-- C already received a win-back nudge.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key)
VALUES (
  'b6100000-0000-0000-0000-00000000000c',
  'subscription.winback.email_sent',
  'winback:b6100000-0000-0000-0000-00000000000c');

-- F received an old winback for a previous cancellation, before this ended_at.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, created_at)
VALUES (
  'b6100000-0000-0000-0000-00000000000f',
  'subscription.winback.email_sent',
  'winback:b6100000-0000-0000-0000-00000000000f:previous',
  now() - interval '40 days');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)),
  3,
  'S5b: only customer-marked, not-yet-nudged current cancellation episodes are returned');

SELECT is(
  (SELECT string_agg(subscription_id::text, ',' ORDER BY ended_at ASC)
     FROM public.subscription_list_due_for_winback(50)),
  'b6100000-0000-0000-0000-00000000000a,b6100000-0000-0000-0000-00000000000f,b6100000-0000-0000-0000-000000000013',
  'S5b: eligible subscriptions are A, repeat-cancelled F, and boundary J');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)
    WHERE subscription_id = 'b6100000-0000-0000-0000-00000000000e'),
  0,
  'S5b: system refund-reversal cancellations are excluded by the source marker');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)
    WHERE subscription_id = 'b6100000-0000-0000-0000-000000000011'),
  0,
  'S5b: system provisional-timeout cancellations are excluded by the source marker');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)
    WHERE subscription_id = 'b6100000-0000-0000-0000-000000000010'),
  0,
  'S5b: a cancelled row with no positive customer marker is never a win-back candidate');

-- The floor exists so the win-back nudge does not land on the same day as the
-- cancellation confirmation. I is a textbook candidate in every other respect.
SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)
    WHERE subscription_id = 'b6100000-0000-0000-0000-000000000012'),
  0,
  'S5b: a cancellation younger than the 14-day floor is not yet a win-back candidate');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)
    WHERE subscription_id = 'b6100000-0000-0000-0000-000000000013'),
  1,
  'S5b: a cancellation exactly 14 days old is a win-back candidate');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_list_due_for_winback(50)
    WHERE subscription_id = 'b6100000-0000-0000-0000-00000000000f'),
  1,
  'S5b: stale winback events from an older cancellation do not block a new cancellation episode');

SELECT throws_ok(
  $$ SELECT public.subscription_list_due_for_winback(0) $$,
  '22023',
  NULL,
  'S5b: p_limit must be within 1..500');

SELECT * FROM finish();
ROLLBACK;
