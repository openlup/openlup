-- pgTAP: enqueue_abandoned_cart_reminders tiers are disjoint by age, so a single
-- run can never fire 24h + 72h together, and a cold-backlog draft is not blasted
-- (20260704110000).
--   * X (draft 36h old)                       -> 24h tier only;
--   * Y (draft 5d old, NO prior 24h event)    -> NEITHER 24h nor 72h (the old bug
--                                                 fired both in one run);
--   * Z (draft 5d old, WITH a prior 24h event)-> 72h tier (normal progression).
--
-- The production-fingerprint clone guard is stubbed to TRUE inside the test txn so
-- the tier logic runs locally; ROLLBACK restores the real guard.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

-- Stub the unspoofable clone guard for the duration of the test transaction.
CREATE OR REPLACE FUNCTION private.external_cron_is_enabled()
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('22000000-0000-0000-0000-0000000000a0', 'abandoned-tier@example.invalid', 'Aba', 'Tier');

-- X: 36h old draft -> 24h tier ([24h,72h)).
-- Y: 5d old draft, no prior event -> excluded from both tiers.
-- Z: 5d old draft, prior abandoned_24h event present -> 72h tier.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents, created_at)
VALUES
  ('22000000-0000-0000-0000-0000000000c1', '22000000-0000-0000-0000-0000000000a0', 'ABANDON-X', 'draft', 'one_time', 'PLN', 9900, 9900, now() - interval '36 hours'),
  ('22000000-0000-0000-0000-0000000000c2', '22000000-0000-0000-0000-0000000000a0', 'ABANDON-Y', 'draft', 'one_time', 'PLN', 9900, 9900, now() - interval '5 days'),
  ('22000000-0000-0000-0000-0000000000c3', '22000000-0000-0000-0000-0000000000a0', 'ABANDON-Z', 'draft', 'one_time', 'PLN', 9900, 9900, now() - interval '5 days');

-- Z already has its 24h reminder from a prior run.
INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
VALUES (
  'commerce_order', '22000000-0000-0000-0000-0000000000c3',
  'commerce.order_draft.abandoned.24h', 'abandoned_24h:22000000-0000-0000-0000-0000000000c3',
  '{}'::jsonb, jsonb_build_object('source', 'prior_run'));

SELECT is(
  (public.enqueue_abandoned_cart_reminders(200) ->> 'enqueued_24h')::int,
  1, 'exactly one 24h reminder (X); the 5d-old drafts are outside the [24h,72h) tier');

-- The same returned object from the single call above is re-read from the ledger.
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order_draft.abandoned.24h'
      AND aggregate_id = '22000000-0000-0000-0000-0000000000c1'),
  1, 'draft X (36h) got its 24h reminder');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = '22000000-0000-0000-0000-0000000000c2'
      AND event_type IN ('commerce.order_draft.abandoned.24h','commerce.order_draft.abandoned.72h')),
  0, 'cold-backlog draft Y (5d, no prior 24h) gets NEITHER nudge — no same-run double, no blast');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order_draft.abandoned.72h'
      AND aggregate_id = '22000000-0000-0000-0000-0000000000c3'),
  1, 'draft Z (5d, prior 24h event) advances to the 72h reminder');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order_draft.abandoned.24h'
      AND aggregate_id = '22000000-0000-0000-0000-0000000000c3'),
  1, 'draft Z keeps exactly its prior 24h event (the 24h tier did not re-fire for it)');

SELECT * FROM finish();
ROLLBACK;
