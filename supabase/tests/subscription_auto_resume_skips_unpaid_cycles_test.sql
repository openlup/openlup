-- pgTAP: the auto-resume cron never promotes a subscription the renewal lane
-- cannot list.
--
-- `subscription_list_due_for_renewal` (20260805090000, line 1027) hides a
-- subscription for as long as ANY of its cycles sits in
-- ('payment_pending', 'retry_scheduled', 'payment_failed'). Before
-- 20260826153000 the cron's skip chain looked for ('payment_pending', 'paid')
-- and only at `scheduled_at = next_cycle_at`, so it could flip a row to `active`
-- that no lane would ever charge or ship.
--
-- All five subscriptions below are due, paused, line-bearing, payment-method
-- bearing and free of any open dunning case, so the ONLY thing that separates
-- them is cycle state. Three arms prove the skip, two prove it does not
-- over-match — a predicate that matched any historical cycle would freeze a
-- healthy subscription forever, which is the failure mode that matters more than
-- the one being fixed.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(15);

SELECT has_function(
  'public', 'subscription_auto_resume_due',
  ARRAY['integer', 'timestamp with time zone'],
  'auto-resume: the RPC keeps its signature, so CREATE OR REPLACE kept its ACL');

-- This repository has a live browser-role EXECUTE escalation of the definer-
-- rights class, so the boundary is asserted rather than assumed on every
-- migration that restates this body.
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.subscription_auto_resume_due(integer,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.subscription_auto_resume_due(integer,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.subscription_auto_resume_due(integer,timestamp with time zone)',
    'EXECUTE'),
  'auto-resume: the cron RPC is service-role only');

-- ---- Shared catalogue ------------------------------------------------------
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d5300000-0000-4000-8000-000000000001', 'auto-resume-skip-product', 'Auto Resume Skip Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('d5400000-0000-4000-8000-000000000001', 'd5300000-0000-4000-8000-000000000001',
        'AUTO-RESUME-SKIP-SKU', 'Auto Resume Skip SKU', 'dog', 'active', 400, 350);

INSERT INTO public.clients (id, email) VALUES
  ('d5000000-0000-4000-8000-000000000001', 'auto-resume-clean@example.invalid'),
  ('d5000000-0000-4000-8000-000000000002', 'auto-resume-failed@example.invalid'),
  ('d5000000-0000-4000-8000-000000000003', 'auto-resume-retry@example.invalid'),
  ('d5000000-0000-4000-8000-000000000004', 'auto-resume-stale@example.invalid'),
  ('d5000000-0000-4000-8000-000000000005', 'auto-resume-terminal@example.invalid');

-- Row 4 is the breadth arm: its `next_cycle_at` has already been moved forward
-- (the delivery-alignment rail and `slide_next_cycle` both do this without
-- reading cycle status), so its uncollected cycle sits at an OLDER
-- `scheduled_at` where the pre-20260826153000 branch could not see it.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version,
  payment_method_kind, payment_method_ref
) VALUES
  ('d5100000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 28, 'XTS', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_auto_resume_clean'),
  ('d5100000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000002', 28, 'XTS', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_auto_resume_failed'),
  ('d5100000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000003', 28, 'XTS', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_auto_resume_retry'),
  ('d5100000-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000004', 28, 'XTS', 'paused', '2026-07-29T00:00:00Z', 1, 'card', 'pm_auto_resume_stale'),
  ('d5100000-0000-4000-8000-000000000005', 'd5000000-0000-4000-8000-000000000005', 28, 'XTS', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_auto_resume_terminal');

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT s.id, 'd5400000-0000-4000-8000-000000000001', 1, 0, false, 1
  FROM public.subscriptions s
 WHERE s.id IN (
   'd5100000-0000-4000-8000-000000000001',
   'd5100000-0000-4000-8000-000000000002',
   'd5100000-0000-4000-8000-000000000003',
   'd5100000-0000-4000-8000-000000000004',
   'd5100000-0000-4000-8000-000000000005'
 );

-- Identical timed pause windows: every row is due at the same instant, so the
-- batch below separates them on cycle state alone.
INSERT INTO public.subscription_pause_windows (
  id, subscription_id, pause_preset, starts_at, ends_at, reason, idempotency_key
) VALUES
  ('d5200000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'auto-resume-clean', 'auto-resume-clean-pause'),
  ('d5200000-0000-4000-8000-000000000002', 'd5100000-0000-4000-8000-000000000002', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'auto-resume-failed', 'auto-resume-failed-pause'),
  ('d5200000-0000-4000-8000-000000000003', 'd5100000-0000-4000-8000-000000000003', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'auto-resume-retry', 'auto-resume-retry-pause'),
  ('d5200000-0000-4000-8000-000000000004', 'd5100000-0000-4000-8000-000000000004', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'auto-resume-stale', 'auto-resume-stale-pause'),
  ('d5200000-0000-4000-8000-000000000005', 'd5100000-0000-4000-8000-000000000005', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'auto-resume-terminal', 'auto-resume-terminal-pause');

-- Row 1 (control): a collected history and nothing outstanding. The paid cycle
-- is at an OLDER scheduled_at than next_cycle_at, which is the normal shape
-- after a successful renewal.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key, retry_attempt
) VALUES
  ('d5500000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001', 1, '2026-05-04T00:00:00Z', 'paid', '2026-05-04T01:00:00Z', 'auto-resume-clean-cycle-1', 0);

-- Row 2: the retry ladder exhausted. `next_retry_at` is NULL, so no lane wants
-- this cycle — the normal lane excludes `payment_failed` and the retry lane only
-- lists `retry_scheduled`. Its dunning case is `expired`, not `open`, which is
-- exactly why `pause` was permitted and why the open-case branch does not fire.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt, next_retry_at, failure_reason
) VALUES
  ('d5500000-0000-4000-8000-000000000002', 'd5100000-0000-4000-8000-000000000002', 2, '2026-06-01T00:00:00Z', 'payment_failed', 'auto-resume-failed-cycle-2', 4, NULL, 'card_declined');

-- Row 3: a scheduled retry.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt, next_retry_at, failure_reason
) VALUES
  ('d5500000-0000-4000-8000-000000000003', 'd5100000-0000-4000-8000-000000000003', 2, '2026-06-01T00:00:00Z', 'retry_scheduled', 'auto-resume-retry-cycle-2', 1, '2026-06-02T00:00:00Z', 'insufficient_funds');

-- Row 4: an uncollected charge left behind at an older date. A
-- `payment_pending` cycle must carry the current template snapshot
-- (trg_subscription_guard_payment_pending_cycle_template, 20260605144000), so it
-- is built from the subscription's own rows rather than hand-written.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt, template_snapshot
) VALUES
  ('d5500000-0000-4000-8000-000000000004', 'd5100000-0000-4000-8000-000000000004', 2, '2026-06-01T00:00:00Z', 'payment_pending', 'auto-resume-stale-cycle-2', 0,
   public.subscription_current_template_snapshot('d5100000-0000-4000-8000-000000000004'));

-- Row 5 (control): terminal cycles only. `skipped` and `cancelled` are not
-- excluding statuses, so this subscription must still be promoted; a branch that
-- matched any historical cycle would hold it paused forever.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt
) VALUES
  ('d5500000-0000-4000-8000-000000000005', 'd5100000-0000-4000-8000-000000000005', 1, '2026-05-04T00:00:00Z', 'cancelled', 'auto-resume-terminal-cycle-1', 0),
  ('d5500000-0000-4000-8000-000000000006', 'd5100000-0000-4000-8000-000000000005', 2, '2026-06-01T00:00:00Z', 'skipped', 'auto-resume-terminal-cycle-2', 0);

CREATE TEMP TABLE _auto_resume AS
SELECT public.subscription_auto_resume_due(100, '2026-06-16T10:00:00Z'::timestamptz) AS r;

SELECT is((SELECT r ->> 'resumed' FROM _auto_resume), '2',
  'auto-resume: only the two subscriptions with no outstanding cycle are promoted');
SELECT is((SELECT r ->> 'skipped' FROM _auto_resume), '3',
  'auto-resume: the three excluding statuses are graceful skips');
SELECT is((SELECT r ->> 'failed' FROM _auto_resume), '0',
  'auto-resume: a skip is never counted as a failure');
SELECT is((SELECT r ->> 'ok' FROM _auto_resume), 'true',
  'auto-resume: an ineligible row does not turn the batch red');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'd5100000-0000-4000-8000-000000000001'),
  'active',
  'auto-resume: a due pause with a collected history still resumes');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'd5100000-0000-4000-8000-000000000005'),
  'active',
  'auto-resume: skipped and cancelled cycles are not excluding, so the row still resumes');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'd5100000-0000-4000-8000-000000000002'),
  'paused',
  'auto-resume: a payment_failed cycle keeps the subscription paused');

SELECT is(
  (SELECT resumed_at FROM public.subscription_pause_windows WHERE id = 'd5200000-0000-4000-8000-000000000002'),
  NULL,
  'auto-resume: the skipped pause window stays open, so the next tick re-evaluates it');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'd5100000-0000-4000-8000-000000000003'),
  'paused',
  'auto-resume: a retry_scheduled cycle keeps the subscription paused');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'd5100000-0000-4000-8000-000000000004'),
  'paused',
  'auto-resume: an uncollected cycle at an older scheduled_at keeps the subscription paused');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'd5100000-0000-4000-8000-000000000004'),
  '2026-07-29T00:00:00Z'::timestamptz,
  'auto-resume: a skip writes nothing — the moved next_cycle_at is untouched');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE event_type = 'subscription.system.auto_resume'
      AND subscription_id IN (
        'd5100000-0000-4000-8000-000000000002',
        'd5100000-0000-4000-8000-000000000003',
        'd5100000-0000-4000-8000-000000000004')),
  0,
  'auto-resume: no audit event claims a resume that did not happen');

SELECT is(
  (SELECT event_type FROM public.subscription_events
    WHERE idempotency_key = 'subscription_auto_resume:d5200000-0000-4000-8000-000000000001'),
  'subscription.system.auto_resume',
  'auto-resume: the promoted row still writes its audit event');

SELECT * FROM finish();
ROLLBACK;
