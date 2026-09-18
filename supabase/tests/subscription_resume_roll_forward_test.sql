-- pgTAP: Self-service C2 — resume rolls a lapsed next_cycle_at forward (20260612120000).
--   * a paused sub whose next_cycle_at is in the past resumes with next_cycle_at rolled
--     forward by whole cadence periods to the next strictly-future slot (no instant charge)
--   * a paused sub whose next_cycle_at is already in the future is unchanged
--   * a replayed action does not advance again (idempotent)
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

INSERT INTO auth.users (id) VALUES ('a0000000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c0000000-0000-0000-0000-000000000001', 'resume@example.invalid', 'a0000000-0000-0000-0000-000000000001');

-- Both paused subscriptions below are resumed (paused -> active), which
-- trg_subscription_guard_active_requires_lines (20260801120100) rejects for a
-- line-less subscription. Production resume always has lines: nothing in the
-- self-service action can drain subscription_lines to zero.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c0000000-0000-0000-0000-0000000000d1', 'resume-roll-forward-product', 'Resume Roll Forward Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c0000000-0000-0000-0000-0000000000d2', 'c0000000-0000-0000-0000-0000000000d1', 'RESUME-ROLL-SKU', 'Resume Roll SKU', 'dog', 'active', 400, 350);

-- Scenario 1 — lapsed: next was 2026-04-01, resume on 2026-06-12, cadence 30d.
-- gap 72d -> floor(72/30)+1 = 3 periods -> 2026-04-01 + 90d = 2026-06-30.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, started_at)
VALUES ('51000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 30, 'PLN', 'paused',
        '2026-04-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('51000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000d2', 1, 0, false, 1);

SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-000000000001', 'resume-idem-lapsed-1',
  '51000000-0000-0000-0000-000000000001', 'resume', '{}'::jsonb, '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT status FROM public.subscriptions WHERE id='51000000-0000-0000-0000-000000000001'),
  'active', 'C2: resumed to active');
SELECT ok((SELECT next_cycle_at FROM public.subscriptions WHERE id='51000000-0000-0000-0000-000000000001')
  > '2026-06-12T00:00:00Z'::timestamptz, 'C2: lapsed next_cycle_at rolled into the future');
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='51000000-0000-0000-0000-000000000001'),
  '2026-06-30T00:00:00Z'::timestamptz, 'C2: rolled forward by whole cadence periods (3 x 30d)');

-- Replay with the SAME idempotency key must NOT advance again.
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-000000000001', 'resume-idem-lapsed-1',
  '51000000-0000-0000-0000-000000000001', 'resume', '{}'::jsonb, '2026-06-12T00:00:00Z'::timestamptz);
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='51000000-0000-0000-0000-000000000001'),
  '2026-06-30T00:00:00Z'::timestamptz, 'C2: replay does not advance again (idempotent)');

-- Scenario 2 — already future: unchanged.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('51000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 30, 'PLN', 'paused',
        '2026-07-15T00:00:00Z');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('51000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-0000000000d2', 1, 0, false, 1);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-000000000001', 'resume-idem-future-1',
  '51000000-0000-0000-0000-000000000002', 'resume', '{}'::jsonb, '2026-06-12T00:00:00Z'::timestamptz);
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='51000000-0000-0000-0000-000000000002'),
  '2026-07-15T00:00:00Z'::timestamptz, 'C2: already-future next_cycle_at is unchanged');

SELECT * FROM finish();
ROLLBACK;
