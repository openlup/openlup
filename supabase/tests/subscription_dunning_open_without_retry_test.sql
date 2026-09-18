-- pgTAP: a dunning case with no next retry is EXPIRED only when the ladder was
-- exhausted. Below the ladder's last rung the same absent schedule means the
-- attempt sequence was cut short, and a case cut short stays OPEN.
--
-- Why this distinction is worth a suite of its own: `expired` is not a label. In
-- subscription_handle_payment_failure_dunning_before_cancel_fence it selects the
-- customer's email, the recovery token's purpose and lifetime, and — for an
-- `active` subscription — a write that PAUSES it. Deriving it from the absence of
-- a schedule alone meant that any future reason to stop retrying early would
-- pause a live subscription on the day of its first refusal, which this product
-- may not do. The predicate now also asks how far up the ladder the attempt got.
--
-- Both arms are proved here, in one file and against one boundary, so neither can
-- pass vacuously:
--
--   * TERMINATED EARLY (attempt 1, no schedule): case `open`, no `expired_at`,
--     subscription untouched and still active, no `subscription.paused` event, a
--     `repair_payment` token expiring 14 days after the refusal, no
--     `resume_subscription` token, and the attempt-numbered failed slug.
--   * EXHAUSTED (attempt 4, no schedule): the unchanged terminal — case
--     `expired`, subscription paused with its event, and the 30-day
--     `resume_subscription` token.
--
-- Attempt 4 is the exhaustion rung because the schedule feeding this boundary
-- (commerce_payment_control_apply_before_sub_lock) hands out +24h/+72h/+168h for
-- attempts 1..3 and NULL from 4 on. The ladder WALK itself is pinned in
-- subscription_renewal_preflight_ladder_test.sql; this suite pins what the
-- dunning boundary makes of each end of it.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(25);

-- ---- Surface ---------------------------------------------------------------
SELECT has_function(
  'public',
  'subscription_handle_payment_failure_dunning_before_cancel_fence',
  ARRAY['text', 'uuid', 'uuid', 'uuid', 'uuid', 'integer',
        'timestamp with time zone', 'text', 'timestamp with time zone'],
  'the canonical dunning body still carries its nine-parameter signature');

-- Restated here because this wave replaces that body: the pre-fence
-- implementation must remain reachable ONLY through the public wrapper, or the
-- cancelled-subscription fence can be stepped around.
SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz)',
    'EXECUTE'),
  'no role may call the pre-fence body directly');

-- ---- Shared catalog --------------------------------------------------------
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c1400000-0000-4000-8000-000000000001', 'no-retry-open-product',
        'No Retry Open Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c1500000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000001',
        'NO-RETRY-OPEN-SKU', 'No Retry Open SKU', 'dog', 'active', 400, 350);

-- ===========================================================================
-- ARM ONE: the ladder was cut short at attempt 1
-- ===========================================================================
INSERT INTO auth.users (id) VALUES ('c1000000-0000-4000-8000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c1100000-0000-4000-8000-000000000001', 'terminated-early@example.invalid',
        'c1000000-0000-4000-8000-000000000001');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'c1200000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
  30, 'XTS', 'active', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_terminated_early', 'card');

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('c1200000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- The cycle a cut-short ladder leaves behind: terminal payment_failed with no
-- schedule, but on rung ONE rather than past the ladder's end.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key,
  retry_attempt, next_retry_at, failure_reason
) VALUES (
  'c1300000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001',
  2, '2026-06-01T00:00:00Z', 'payment_failed', 'terminated-early-cycle',
  1, NULL, 'provider_declined');

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'c1700000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'c1200000-0000-4000-8000-000000000001', 'c1300000-0000-4000-8000-000000000001');

INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('c1800000-0000-4000-8000-000000000001', 'c1700000-0000-4000-8000-000000000001',
        'test', 'pending', 12999);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, status
) VALUES (
  'c1900000-0000-4000-8000-000000000001', 'subscription_cycle',
  'c1700000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001',
  'c1300000-0000-4000-8000-000000000001', 'c1800000-0000-4000-8000-000000000001',
  12999, 'created');

CREATE TEMP TABLE _early AS
SELECT public.subscription_handle_payment_failure_dunning(
  'terminated-early-dunning',
  'c1300000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-000000000001',
  'c1700000-0000-4000-8000-000000000001',
  'c1900000-0000-4000-8000-000000000001',
  1, NULL, 'provider_declined', '2026-06-01T09:00:00Z'::timestamptz
) -> 'subscriptionDunning' AS payload;

-- ---- What the case says ----------------------------------------------------
SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  'open',
  'a ladder cut short at rung one leaves the case OPEN, not expired');

SELECT is(
  (SELECT expired_at FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  NULL,
  'an open case stamps no expiry instant');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  NULL,
  'the case records the absent schedule verbatim rather than inventing one');

SELECT is(
  (SELECT payload ->> 'status' FROM _early),
  'open',
  'the boundary reports the open verdict to its caller');

SELECT is(
  (SELECT payload ->> 'recoveryTokenPurpose' FROM _early),
  'repair_payment',
  'the caller is told the token repairs payment rather than resuming');

-- ---- THE INVARIANT PIN -----------------------------------------------------
-- This is the assertion the wave exists for. Under the old derivation these two
-- were 'paused' and 1.
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'c1200000-0000-4000-8000-000000000001'),
  'active',
  'the subscription is STILL ACTIVE: an early-terminated retry never pauses it');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
    WHERE subscription_id = 'c1200000-0000-4000-8000-000000000001'
      AND event_type = 'subscription.paused'),
  0,
  'no pause event is emitted for a case that was never expired');

-- ---- The recovery the customer is actually offered --------------------------
SELECT is(
  (SELECT purpose FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  'repair_payment',
  'the minted token repairs the payment on a live subscription');

SELECT is(
  (SELECT expires_at FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  '2026-06-15T09:00:00Z'::timestamptz,
  'with no schedule to count from, the 14-day repair window starts at the refusal');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'
      AND purpose = 'resume_subscription'),
  0,
  'nothing offers to resume a subscription that was never paused');

-- ---- The email the customer is actually sent --------------------------------
SELECT is(
  (SELECT template_slug FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'
      AND recipient_kind = 'customer'),
  'subscription-payment-failed-1',
  'the customer gets the first failed-payment notice, not the expiry notice');

SELECT is(
  (SELECT notification_kind FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'
      AND recipient_kind = 'customer'),
  'payment_failed',
  'the notification kind matches the open verdict');

SELECT is(
  (SELECT count(DISTINCT template_slug)::integer FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'
      AND recipient_kind = 'admin'
      AND template_slug = 'subscription-payment-failed-admin'),
  1,
  'operations are told a payment failed, not that a journey expired');

-- ===========================================================================
-- ARM TWO: the ladder was exhausted at attempt 4 (the unchanged control)
-- ===========================================================================
INSERT INTO auth.users (id) VALUES ('c1000000-0000-4000-8000-000000000002');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c1100000-0000-4000-8000-000000000002', 'ladder-exhausted@example.invalid',
        'c1000000-0000-4000-8000-000000000002');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'c1200000-0000-4000-8000-000000000002', 'c1100000-0000-4000-8000-000000000002',
  30, 'XTS', 'active', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_ladder_exhausted', 'card');

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('c1200000-0000-4000-8000-000000000002', 'c1500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- The same terminal cycle shape, PAST the ladder's end: attempt 4 is the first
-- rung the schedule leaves empty on its own.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key,
  retry_attempt, next_retry_at, failure_reason
) VALUES (
  'c1300000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000002',
  2, '2026-06-01T00:00:00Z', 'payment_failed', 'ladder-exhausted-cycle',
  4, NULL, 'provider_declined');

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'c1700000-0000-4000-8000-000000000002', 'c1100000-0000-4000-8000-000000000002',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'c1200000-0000-4000-8000-000000000002', 'c1300000-0000-4000-8000-000000000002');

INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('c1800000-0000-4000-8000-000000000002', 'c1700000-0000-4000-8000-000000000002',
        'test', 'pending', 12999);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, status
) VALUES (
  'c1900000-0000-4000-8000-000000000002', 'subscription_cycle',
  'c1700000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000002',
  'c1300000-0000-4000-8000-000000000002', 'c1800000-0000-4000-8000-000000000002',
  12999, 'created');

SELECT public.subscription_handle_payment_failure_dunning(
  'ladder-exhausted-dunning',
  'c1300000-0000-4000-8000-000000000002',
  'c1200000-0000-4000-8000-000000000002',
  'c1700000-0000-4000-8000-000000000002',
  'c1900000-0000-4000-8000-000000000002',
  4, NULL, 'provider_declined', '2026-06-22T09:00:00Z'::timestamptz);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  'expired',
  'an exhausted ladder still expires the case');

SELECT is(
  (SELECT expired_at FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  '2026-06-22T09:00:00Z'::timestamptz,
  'the expired case is stamped at the refusal that exhausted the ladder');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'c1200000-0000-4000-8000-000000000002'),
  'paused',
  'an exhausted ladder still pauses the subscription');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
    WHERE subscription_id = 'c1200000-0000-4000-8000-000000000002'
      AND event_type = 'subscription.paused'),
  1,
  'the pause is still recorded exactly once');

SELECT is(
  (SELECT purpose FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  'resume_subscription',
  'the exhausted journey still mints a resume token');

SELECT is(
  (SELECT expires_at FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  '2026-07-22T09:00:00Z'::timestamptz,
  'the resume window is still 30 days');

SELECT is(
  (SELECT template_slug FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'
      AND recipient_kind = 'customer'),
  'subscription-payment-expired',
  'the exhausted journey still sends the expiry notice');

SELECT is(
  (SELECT notification_kind FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'
      AND recipient_kind = 'customer'),
  'payment_expired',
  'the exhausted notification kind is unchanged');

SELECT is(
  (SELECT count(DISTINCT template_slug)::integer FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'
      AND recipient_kind = 'admin'
      AND template_slug = 'subscription-payment-expired-admin'),
  1,
  'operations still hear that the journey expired');

-- ---- The two arms are genuinely different -----------------------------------
-- Without this the pair could both pass on one accidental verdict.
SELECT isnt(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  (SELECT status FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  'the same absent schedule produces two different verdicts, by rung alone');

SELECT * FROM finish();
ROLLBACK;
