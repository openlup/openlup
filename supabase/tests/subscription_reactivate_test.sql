-- pgTAP: customer-initiated reactivate of a cancelled subscription (P0 S5 "Wznów").
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44443000-0000-0000-0000-000000000001', 'react-base', 'React Base', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55553000-0000-0000-0000-000000000001', '44443000-0000-0000-0000-000000000001', 'REACT-BASE', 'Base', 'dog', 400, 492, 'active');

INSERT INTO auth.users (id) VALUES ('a3000000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c3000000-0000-0000-0000-000000000001', 'react@example.invalid', 'a3000000-0000-0000-0000-000000000001');

-- Sub R1: cancelled WITH a stored payment method -> reactivatable.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, ended_at, next_cycle_at, template_version, payment_method_ref, size_constraint)
VALUES ('5b300000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', 28, 'PLN', 'cancelled',
        '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z', 1, 'pm_react', '{"kind":"feeding_days","value":28}'::jsonb);
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51300000-0000-0000-0000-000000000001', '5b300000-0000-0000-0000-000000000001', '55553000-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb);

-- Sub R2: cancelled with NO payment method -> reactivate must be payment-blocked.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, ended_at, next_cycle_at, template_version, size_constraint)
VALUES ('5b300000-0000-0000-0000-000000000002', 'c3000000-0000-0000-0000-000000000001', 28, 'PLN', 'cancelled',
        '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z', 1, '{"kind":"feeding_days","value":28}'::jsonb);

-- Reactivate R1
SELECT public.customer_self_service_apply_subscription_action(
  'a3000000-0000-0000-0000-000000000001', 'react-idem-1', '5b300000-0000-0000-0000-000000000001', 'reactivate',
  '{"confirmedChargeTiming":true}'::jsonb, '2026-06-22T10:00:00Z'::timestamptz);

SELECT is((SELECT status FROM public.subscriptions WHERE id='5b300000-0000-0000-0000-000000000001'),
  'active', 'S5: reactivate flips a cancelled subscription back to active');
SELECT is((SELECT ended_at FROM public.subscriptions WHERE id='5b300000-0000-0000-0000-000000000001'),
  NULL::timestamptz, 'S5: reactivate clears ended_at');
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='5b300000-0000-0000-0000-000000000001'),
  '2026-06-24T10:00:00Z'::timestamptz, 'S5: reactivate sets next_cycle_at to a 2-day-lead future slot');
SELECT is((SELECT event_type FROM public.subscription_events WHERE idempotency_key='react-idem-1'),
  'subscription.customer_self_service.reactivate', 'S5: reactivate is recorded in the event log');

-- Reactivate R2 (no payment method) is rejected
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a3000000-0000-0000-0000-000000000001', 'react-idem-2', '5b300000-0000-0000-0000-000000000002', 'reactivate',
    '{"confirmedChargeTiming":true}'::jsonb, '2026-06-22T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_payment_blocked',
  'S5: reactivate without a stored payment method is payment-blocked');

SELECT * FROM finish();
ROLLBACK;
