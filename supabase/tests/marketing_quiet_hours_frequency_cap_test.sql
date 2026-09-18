-- pgTAP: marketing email quiet-hours deferral + global frequency cap.
--
-- Run via: supabase test db
--
-- Covers 20260701140000_marketing_quiet_hours_frequency_cap.sql:
--   * communication_marketing_available_at() window math
--   * the BEFORE INSERT trigger deferring marketing outbox events (and leaving
--     transactional events untouched)
--   * communication_evaluate_email_policy() marketing frequency cap

BEGIN;
SELECT plan(13);

-- ---------------------------------------------------------------------------
-- Helper window math (Warsaw = +02:00 in July).
-- ---------------------------------------------------------------------------
SELECT is(
  public.communication_marketing_available_at(TIMESTAMPTZ '2026-07-01 01:00:00+02'),
  TIMESTAMPTZ '2026-07-01 09:00:00+02',
  'before window -> opens at 09:00 same day'
);

SELECT is(
  public.communication_marketing_available_at(TIMESTAMPTZ '2026-07-01 22:00:00+02'),
  TIMESTAMPTZ '2026-07-02 09:00:00+02',
  'after window -> opens at 09:00 next day'
);

SELECT is(
  public.communication_marketing_available_at(TIMESTAMPTZ '2026-07-01 12:00:00+02'),
  TIMESTAMPTZ '2026-07-01 12:00:00+02',
  'inside window -> unchanged'
);

-- ---------------------------------------------------------------------------
-- BEFORE INSERT trigger on outbox_events.
-- ---------------------------------------------------------------------------
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, available_at)
VALUES (
  '33333333-3333-4333-8333-333333333301',
  'commerce_order', '33333333-3333-4333-8333-3333333330aa',
  'commerce.order.review_request', 'qh-review:1', '{}'::jsonb,
  TIMESTAMPTZ '2026-07-01 03:00:00+02'
);
SELECT is(
  (SELECT available_at FROM public.outbox_events WHERE id = '33333333-3333-4333-8333-333333333301'),
  TIMESTAMPTZ '2026-07-01 09:00:00+02',
  'marketing event before window is deferred to 09:00'
);

INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, available_at)
VALUES (
  '33333333-3333-4333-8333-333333333302',
  'commerce_order', '33333333-3333-4333-8333-3333333330bb',
  'commerce.order_draft.abandoned.24h', 'qh-cart:1', '{}'::jsonb,
  TIMESTAMPTZ '2026-07-01 23:30:00+02'
);
SELECT is(
  (SELECT available_at FROM public.outbox_events WHERE id = '33333333-3333-4333-8333-333333333302'),
  TIMESTAMPTZ '2026-07-02 09:00:00+02',
  'marketing event after window is deferred to next-day 09:00'
);

INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, available_at)
VALUES (
  '33333333-3333-4333-8333-333333333303',
  'commerce_order', '33333333-3333-4333-8333-3333333330cc',
  'commerce.order.reorder_reminder', 'qh-reorder:1', '{}'::jsonb,
  TIMESTAMPTZ '2026-07-01 14:00:00+02'
);
SELECT is(
  (SELECT available_at FROM public.outbox_events WHERE id = '33333333-3333-4333-8333-333333333303'),
  TIMESTAMPTZ '2026-07-01 14:00:00+02',
  'marketing event already inside window is left untouched'
);

INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, available_at)
VALUES (
  '33333333-3333-4333-8333-333333333304',
  'commerce_order', '33333333-3333-4333-8333-3333333330dd',
  'commerce.order.paid', 'qh-paid:1', '{}'::jsonb,
  TIMESTAMPTZ '2026-07-01 03:00:00+02'
);
SELECT is(
  (SELECT available_at FROM public.outbox_events WHERE id = '33333333-3333-4333-8333-333333333304'),
  TIMESTAMPTZ '2026-07-01 03:00:00+02',
  'transactional event is NEVER deferred (quiet hours do not apply)'
);

-- ---------------------------------------------------------------------------
-- Frequency cap in communication_evaluate_email_policy.
-- ---------------------------------------------------------------------------
-- Grant marketing consent so the cap (not the consent gate) is what we test.
SELECT public.communication_record_permission_event(
  public.communication_touch_contact('capuser@example.invalid', NULL, NULL, 'active', '{}'::jsonb),
  'marketing_newsletter', 'granted', 'test_setup', '{}'::jsonb, NULL, '{}'::jsonb, now(), false
);

SELECT is(
  (public.communication_evaluate_email_policy('capuser@example.invalid', 'marketing_newsletter', 'test') ->> 'allowed'),
  'true',
  'first marketing send to a consented contact is allowed'
);

-- Record a real marketing delivery (status sent, sent_at now) for this contact.
SELECT public.communication_record_email_delivery(
  'order-review/capuser-1', 'commerce-order-review-request', 'marketing_newsletter',
  'marketing-dispatch', 'marketing_dispatch_send', 'sent', 'capuser@example.invalid'
);

SELECT is(
  (public.communication_evaluate_email_policy('capuser@example.invalid', 'marketing_newsletter', 'test') ->> 'allowed'),
  'false',
  'second marketing send within the min-gap is capped (blocked)'
);

SELECT is(
  (public.communication_evaluate_email_policy('capuser@example.invalid', 'marketing_newsletter', 'test') ->> 'reason'),
  'frequency_cap_min_gap',
  'cap reason is frequency_cap_min_gap'
);

-- Control: a transactional send to the same contact is NEVER capped.
SELECT is(
  (public.communication_evaluate_email_policy('capuser@example.invalid', 'transactional', 'test') ->> 'allowed'),
  'true',
  'transactional send is never capped even after a recent marketing send'
);

-- Per-day backstop (cap=2): one prior send >16h ago is still allowed (preserves
-- a legitimate two-touch flow like abandoned-cart 1h then 24h).
SELECT public.communication_record_permission_event(
  public.communication_touch_contact('capuser3@example.invalid', NULL, NULL, 'active', '{}'::jsonb),
  'marketing_newsletter', 'granted', 'test_setup', '{}'::jsonb, NULL, '{}'::jsonb, now(), false
);
INSERT INTO public.communication_email_deliveries
  (contact_id, purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, sent_at)
VALUES (
  public.communication_touch_contact('capuser3@example.invalid', NULL, NULL, 'active', '{}'::jsonb),
  'marketing_newsletter', 'commerce-abandoned-cart-1h', 'marketing-dispatch', 'send', 'cap3:a', 'sent', now() - interval '20 hours'
);
SELECT is(
  (public.communication_evaluate_email_policy('capuser3@example.invalid', 'marketing_newsletter', 'test') ->> 'allowed'),
  'true',
  'a single prior marketing send >16h ago is allowed (day cap is 2)'
);

-- Two prior sends within 24h (both >16h ago) hit the per-day backstop.
SELECT public.communication_record_permission_event(
  public.communication_touch_contact('capuser2@example.invalid', NULL, NULL, 'active', '{}'::jsonb),
  'marketing_newsletter', 'granted', 'test_setup', '{}'::jsonb, NULL, '{}'::jsonb, now(), false
);
INSERT INTO public.communication_email_deliveries
  (contact_id, purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, sent_at)
VALUES
  (public.communication_touch_contact('capuser2@example.invalid', NULL, NULL, 'active', '{}'::jsonb),
   'marketing_newsletter', 'commerce-abandoned-cart-1h', 'marketing-dispatch', 'send', 'cap2:a', 'sent', now() - interval '20 hours'),
  (public.communication_touch_contact('capuser2@example.invalid', NULL, NULL, 'active', '{}'::jsonb),
   'marketing_newsletter', 'commerce-order-review-request', 'marketing-dispatch', 'send', 'cap2:b', 'sent', now() - interval '18 hours');
SELECT is(
  (public.communication_evaluate_email_policy('capuser2@example.invalid', 'marketing_newsletter', 'test') ->> 'reason'),
  'frequency_cap_day',
  'two prior sends within 24h hit the per-day cap'
);

SELECT * FROM finish();
ROLLBACK;
