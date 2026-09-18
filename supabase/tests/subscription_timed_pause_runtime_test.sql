-- pgTAP: Subscription Self-Service 2.x timed pause runtime.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(15);

SELECT has_function('public', 'subscription_dispatch_pause_reminders', ARRAY['integer', 'timestamp with time zone', 'interval'], 'Wave3: pause reminder RPC exists');
SELECT has_function('public', 'subscription_auto_resume_due', ARRAY['integer', 'timestamp with time zone'], 'Wave3: auto-resume RPC exists');

INSERT INTO public.clients (id, email) VALUES
  ('a3000000-0000-0000-0000-000000000001', 'wave3-good@example.invalid'),
  ('a3000000-0000-0000-0000-000000000002', 'wave3-reminder@example.invalid'),
  ('a3000000-0000-0000-0000-000000000003', 'wave3-indefinite@example.invalid'),
  ('a3000000-0000-0000-0000-000000000004', 'wave3-missing-payment@example.invalid'),
  ('a3000000-0000-0000-0000-000000000005', 'wave3-locked@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version,
  payment_method_kind, payment_method_ref
) VALUES
  ('a3100000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 28, 'PLN', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_wave3_good'),
  ('a3100000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000002', 28, 'PLN', 'paused', '2026-07-15T00:00:00Z', 1, 'card', 'pm_wave3_reminder'),
  ('a3100000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000003', 28, 'PLN', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_wave3_indefinite'),
  ('a3100000-0000-0000-0000-000000000004', 'a3000000-0000-0000-0000-000000000004', 28, 'PLN', 'paused', '2026-06-01T00:00:00Z', 1, NULL, NULL),
  ('a3100000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-000000000005', 28, 'PLN', 'paused', '2026-06-01T00:00:00Z', 1, 'card', 'pm_wave3_locked');

-- Every subscription here carries a template line. Auto-resume additionally skips
-- zero-line subscriptions since 20260801120000, so without lines the four
-- deliberately-ineligible rows below would be skipped for the wrong reason and the
-- eligible one would not resume at all — the skip conditions under test would stop
-- being the ones being proven.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('a3400000-0000-0000-0000-000000000001', 'wave3-pause-product', 'Wave3 Pause Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('a3500000-0000-0000-0000-000000000001', 'a3400000-0000-0000-0000-000000000001', 'WAVE3-PAUSE-SKU', 'Wave3 Pause SKU', 'dog', 'active', 400, 350);

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT s.id, 'a3500000-0000-0000-0000-000000000001', 1, 0, false, 1
  FROM public.subscriptions s
 WHERE s.id IN (
   'a3100000-0000-0000-0000-000000000001',
   'a3100000-0000-0000-0000-000000000002',
   'a3100000-0000-0000-0000-000000000003',
   'a3100000-0000-0000-0000-000000000004',
   'a3100000-0000-0000-0000-000000000005'
 );

INSERT INTO public.subscription_pause_windows (
  id, subscription_id, pause_preset, starts_at, ends_at, reason, idempotency_key
) VALUES
  ('a3200000-0000-0000-0000-000000000001', 'a3100000-0000-0000-0000-000000000001', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'runtime-good', 'wave3-good-pause'),
  ('a3200000-0000-0000-0000-000000000002', 'a3100000-0000-0000-0000-000000000002', '1_month', '2026-05-19T10:00:00Z', '2026-06-18T10:00:00Z', 'runtime-reminder', 'wave3-reminder-pause'),
  ('a3200000-0000-0000-0000-000000000003', 'a3100000-0000-0000-0000-000000000003', 'indefinite', '2026-06-01T10:00:00Z', NULL, 'runtime-indefinite', 'wave3-indefinite-pause'),
  ('a3200000-0000-0000-0000-000000000004', 'a3100000-0000-0000-0000-000000000004', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'runtime-missing-payment', 'wave3-missing-payment-pause'),
  ('a3200000-0000-0000-0000-000000000005', 'a3100000-0000-0000-0000-000000000005', '2_weeks', '2026-06-01T10:00:00Z', '2026-06-16T10:00:00Z', 'runtime-locked', 'wave3-locked-pause');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key, retry_attempt)
VALUES ('a3300000-0000-0000-0000-000000000005', 'a3100000-0000-0000-0000-000000000005', 2, '2026-06-01T00:00:00Z', 'paid', '2026-06-01T01:00:00Z', 'wave3-locked-cycle', 1);

SELECT is(
  public.subscription_dispatch_pause_reminders(100, '2026-06-16T10:00:00Z'::timestamptz, interval '3 days') ->> 'queued',
  '1',
  'Wave3: reminder queues one upcoming timed pause');

SELECT is(
  public.subscription_dispatch_pause_reminders(100, '2026-06-16T10:00:00Z'::timestamptz, interval '3 days') ->> 'skipped',
  '1',
  'Wave3: reminder replay is deduped');

SELECT is(
  (SELECT event_type FROM public.outbox_events WHERE idempotency_key = 'subscription_pause_reminder:a3200000-0000-0000-0000-000000000002'),
  'subscription.pause_reminder_due',
  'Wave3: reminder uses the shared communications outbox');

SELECT is(
  (SELECT payload #>> '{pausePreset}' FROM public.outbox_events WHERE idempotency_key = 'subscription_pause_reminder:a3200000-0000-0000-0000-000000000002'),
  '1_month',
  'Wave3: reminder payload keeps the timed pause preset');

SELECT is(
  (SELECT payload #>> '{pauseEndsAt}' FROM public.outbox_events WHERE idempotency_key = 'subscription_pause_reminder:a3200000-0000-0000-0000-000000000002'),
  '2026-06-18T10:00:00+00:00',
  'Wave5: reminder payload preserves the pause end timestamp');

SELECT is(
  (SELECT payload #>> '{nextDeliveryAt}' FROM public.outbox_events WHERE idempotency_key = 'subscription_pause_reminder:a3200000-0000-0000-0000-000000000002'),
  '2026-07-15T00:00:00+00:00',
  'Wave5: reminder payload shows the first delivery date after auto-resume, not ends_at');

SELECT is(
  public.subscription_auto_resume_due(100, '2026-06-16T10:00:00Z'::timestamptz) ->> 'resumed',
  '1',
  'Wave3: auto-resume resumes only the eligible due timed pause');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'a3100000-0000-0000-0000-000000000001'),
  'active',
  'Wave3: eligible pause updates subscription status');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'a3100000-0000-0000-0000-000000000001'),
  '2026-06-29T00:00:00Z'::timestamptz,
  'Wave3: auto-resume rolls lapsed next_cycle_at forward');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_pause_windows WHERE pause_preset = 'indefinite' AND resumed_at IS NULL),
  1,
  'Wave3: indefinite pause never auto-resumes');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'a3100000-0000-0000-0000-000000000004'),
  'paused',
  'Wave3: missing payment method blocks auto-resume');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'a3100000-0000-0000-0000-000000000005'),
  'paused',
  'Wave3: locked upcoming cycle blocks auto-resume');

SELECT is(
  (SELECT event_type FROM public.subscription_events WHERE idempotency_key = 'subscription_auto_resume:a3200000-0000-0000-0000-000000000001'),
  'subscription.system.auto_resume',
  'Wave3: auto-resume writes an audit event');

SELECT * FROM finish();
ROLLBACK;
