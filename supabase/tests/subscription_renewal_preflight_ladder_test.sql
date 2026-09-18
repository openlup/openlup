-- pgTAP: the durable ladder a renewal preflight block walks, one rung per key.
--
-- The runtime half of this claim is pinned in
-- server/domains/subscription/renewalPreflightLadderFreeze.test.ts, against a
-- store that MODELS the idempotency these boundaries enforce. This suite proves
-- the model against the boundaries themselves, in both directions:
--
--   * four distinct execution keys drive four rungs. Each mints its own attempt
--     row, applies its own result, and moves the cycle one step further up the
--     backoff ladder -- retry_attempt 1, 2, 3, 4 with next_retry_at at +24h,
--     +72h, +168h and then NULL. A NULL next retry is the ladder's terminal
--     condition, and the dunning boundary answers it by closing the case as
--     `expired`, pausing the subscription and minting the 30-day
--     `resume_subscription` token.
--   * re-presenting a key that has already been driven changes nothing. That is
--     the property the runtime relied on for its liveness before the keys were
--     retry-scoped: with one key for every tick, rung one was the only rung this
--     subscription would ever reach, and the customer heard about it once.
--
-- The key shapes are the runtime's own: `<cycle key>:payment-execution:attempt:N`
-- with `:record-attempt`, `:apply-result` and `:dunning:<retry attempt>` suffixes,
-- so a change to either side that breaks the pairing is visible here.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(23);

-- ---- Fixture: an active subscription with one renewal cycle in flight -------
INSERT INTO auth.users (id) VALUES ('bd000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('bd100000-0000-4000-8000-000000000001', 'preflight-ladder@example.invalid',
        'bd000000-0000-4000-8000-000000000001');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'bd200000-0000-4000-8000-000000000001', 'bd100000-0000-4000-8000-000000000001',
  30, 'XTS', 'active', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'method_ref', 'card');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('bd400000-0000-4000-8000-000000000001', 'preflight-ladder-product',
        'Preflight Ladder Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('bd500000-0000-4000-8000-000000000001', 'bd400000-0000-4000-8000-000000000001',
        'PREFLIGHT-LADDER-SKU', 'Preflight Ladder SKU', 'dog', 'active', 400, 350);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('bd200000-0000-4000-8000-000000000001', 'bd500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- The renewal runtime asks the delivery-alignment boundary for admission before
-- it creates the cycle order, on the charge path and therefore on the preflight
-- path it delegates to. The receipt that boundary writes is a fixture
-- precondition here, not part of what this suite proves.
INSERT INTO public.subscription_delivery_alignment_admission_receipts (
  subscription_id, scheduled_at, observed_next_cycle_at, decision, source
) VALUES (
  'bd200000-0000-4000-8000-000000000001', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'allowed', 'renewal_admission');

-- Cycle number 2: this is a RENEWAL, not the activation cycle, which is the
-- branch that owns the retry ladder.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key,
  retry_attempt, template_snapshot
) VALUES (
  'bd300000-0000-4000-8000-000000000001', 'bd200000-0000-4000-8000-000000000001',
  2, '2026-06-01T00:00:00Z', 'payment_pending', 'preflight-ladder-cycle', 0,
  public.subscription_current_template_snapshot('bd200000-0000-4000-8000-000000000001'));

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'bd700000-0000-4000-8000-000000000001', 'bd100000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'bd200000-0000-4000-8000-000000000001', 'bd300000-0000-4000-8000-000000000001');

INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('bd800000-0000-4000-8000-000000000001', 'bd700000-0000-4000-8000-000000000001',
        'test', 'pending', 12999);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, status
) VALUES (
  'bd900000-0000-4000-8000-000000000001', 'subscription_cycle',
  'bd700000-0000-4000-8000-000000000001', 'bd200000-0000-4000-8000-000000000001',
  'bd300000-0000-4000-8000-000000000001', 'bd800000-0000-4000-8000-000000000001',
  12999, 'created');

-- The runtime's own key shape, restated once so every rung below reads as the
-- string the orchestrator actually mints.
CREATE TEMP VIEW _bd_cycle_key AS
SELECT 'subscription:bd200000-0000-4000-8000-000000000001:cycle:2026-06-01T00:00:00.000Z'::text AS value;

-- ---- Rung 1: the first preflight block -------------------------------------
-- A `blocked_preflight` attempt carries no provider attempt id, session or next
-- action, and its response must declare `providerCall: false`. The boundary
-- refuses anything else, and the payloads below are the ones the runtime adapter
-- actually sends, so a drift on either side shows up here.
SELECT public.commerce_payment_control_record_attempt(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:0:record-attempt',
  'bd900000-0000-4000-8000-000000000001', 'test', NULL, NULL,
  'blocked_preflight', NULL,
  '{"providerFlow":"renewal_preflight","source":"subscription.renewal.cron.v0"}'::jsonb,
  '{"providerCall":false,"reason":"payment_method_revoked"}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:0:apply-result',
  'bd900000-0000-4000-8000-000000000001', NULL, 'failed',
  '2026-06-01T09:00:00Z'::timestamptz, 'payment_method_revoked');

SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  1, 'rung one: the first applied result puts the cycle on retry attempt 1');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  '2026-06-02T09:00:00Z'::timestamptz, 'rung one schedules the next charge 24 hours out');

SELECT public.subscription_handle_payment_failure_dunning(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:0:dunning:1',
  'bd300000-0000-4000-8000-000000000001', 'bd200000-0000-4000-8000-000000000001',
  'bd700000-0000-4000-8000-000000000001', 'bd900000-0000-4000-8000-000000000001',
  1, '2026-06-02T09:00:00Z'::timestamptz, 'payment_method_revoked',
  '2026-06-01T09:00:00Z'::timestamptz);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE subscription_id = 'bd200000-0000-4000-8000-000000000001'),
  'open', 'rung one opens the case');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'bd200000-0000-4000-8000-000000000001'),
  'active', 'rung one leaves the subscription active: the journey has not ended');

-- ---- A repeated key is inert, which is why one key froze the ladder ---------
-- This is the mechanism the runtime fix removes, asserted rather than argued: a
-- second presentation of rung one's keys moves nothing at all.
SELECT public.commerce_payment_control_record_attempt(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:0:record-attempt',
  'bd900000-0000-4000-8000-000000000001', 'test', NULL, NULL,
  'blocked_preflight', NULL,
  '{"providerFlow":"renewal_preflight","source":"subscription.renewal.cron.v0"}'::jsonb,
  '{"providerCall":false,"reason":"payment_method_revoked"}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:0:apply-result',
  'bd900000-0000-4000-8000-000000000001', NULL, 'failed',
  '2026-06-01T09:00:00Z'::timestamptz, 'payment_method_revoked');

SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  1, 'a re-presented key leaves the cycle on the rung it already reached');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  '2026-06-02T09:00:00Z'::timestamptz,
  'a re-presented key leaves the schedule where it already was');

SELECT is(
  (SELECT count(*)::integer FROM public.commerce_payment_attempts
    WHERE payment_intent_id = 'bd900000-0000-4000-8000-000000000001'),
  1, 'a re-presented key creates no second attempt row');

-- ---- Rung 2 ----------------------------------------------------------------
SELECT public.commerce_payment_control_record_attempt(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:1:record-attempt',
  'bd900000-0000-4000-8000-000000000001', 'test', NULL, NULL,
  'blocked_preflight', NULL,
  '{"providerFlow":"renewal_preflight","source":"subscription.renewal.cron.v0"}'::jsonb,
  '{"providerCall":false,"reason":"payment_method_revoked"}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:1:apply-result',
  'bd900000-0000-4000-8000-000000000001', NULL, 'failed',
  '2026-06-02T09:00:00Z'::timestamptz, 'payment_method_revoked');

SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  2, 'rung two: a new key advances the cycle to retry attempt 2');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  '2026-06-05T09:00:00Z'::timestamptz, 'rung two schedules the next charge 72 hours out');

SELECT public.subscription_handle_payment_failure_dunning(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:1:dunning:2',
  'bd300000-0000-4000-8000-000000000001', 'bd200000-0000-4000-8000-000000000001',
  'bd700000-0000-4000-8000-000000000001', 'bd900000-0000-4000-8000-000000000001',
  2, '2026-06-05T09:00:00Z'::timestamptz, 'payment_method_revoked',
  '2026-06-02T09:00:00Z'::timestamptz);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE subscription_id = 'bd200000-0000-4000-8000-000000000001'),
  'open', 'rung two keeps one case open rather than opening a second');

-- ---- Rung 3 ----------------------------------------------------------------
SELECT public.commerce_payment_control_record_attempt(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:2:record-attempt',
  'bd900000-0000-4000-8000-000000000001', 'test', NULL, NULL,
  'blocked_preflight', NULL,
  '{"providerFlow":"renewal_preflight","source":"subscription.renewal.cron.v0"}'::jsonb,
  '{"providerCall":false,"reason":"payment_method_revoked"}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:2:apply-result',
  'bd900000-0000-4000-8000-000000000001', NULL, 'failed',
  '2026-06-05T09:00:00Z'::timestamptz, 'payment_method_revoked');

SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  3, 'rung three: retry attempt 3');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  '2026-06-12T09:00:00Z'::timestamptz, 'rung three schedules the last charge 168 hours out');

SELECT public.subscription_handle_payment_failure_dunning(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:2:dunning:3',
  'bd300000-0000-4000-8000-000000000001', 'bd200000-0000-4000-8000-000000000001',
  'bd700000-0000-4000-8000-000000000001', 'bd900000-0000-4000-8000-000000000001',
  3, '2026-06-12T09:00:00Z'::timestamptz, 'payment_method_revoked',
  '2026-06-05T09:00:00Z'::timestamptz);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE subscription_id = 'bd200000-0000-4000-8000-000000000001'),
  'open', 'rung three still has a journey to finish');

-- ---- Rung 4: the end of the ladder -----------------------------------------
SELECT public.commerce_payment_control_record_attempt(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:3:record-attempt',
  'bd900000-0000-4000-8000-000000000001', 'test', NULL, NULL,
  'blocked_preflight', NULL,
  '{"providerFlow":"renewal_preflight","source":"subscription.renewal.cron.v0"}'::jsonb,
  '{"providerCall":false,"reason":"payment_method_revoked"}'::jsonb);
SELECT public.commerce_payment_control_apply_result(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:3:apply-result',
  'bd900000-0000-4000-8000-000000000001', NULL, 'failed',
  '2026-06-12T09:00:00Z'::timestamptz, 'payment_method_revoked');

SELECT is(
  (SELECT retry_attempt FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  4, 'rung four: retry attempt 4');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  NULL, 'rung four schedules nothing: the ladder has no fifth slot');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'bd300000-0000-4000-8000-000000000001'),
  'payment_failed', 'the exhausted cycle is terminal, not retry_scheduled');

SELECT public.subscription_handle_payment_failure_dunning(
  (SELECT value FROM _bd_cycle_key) || ':payment-execution:attempt:3:dunning:4',
  'bd300000-0000-4000-8000-000000000001', 'bd200000-0000-4000-8000-000000000001',
  'bd700000-0000-4000-8000-000000000001', 'bd900000-0000-4000-8000-000000000001',
  4, NULL, 'payment_method_revoked', '2026-06-12T09:00:00Z'::timestamptz);

-- ---- What the customer ends up with ----------------------------------------
SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE subscription_id = 'bd200000-0000-4000-8000-000000000001'),
  'expired', 'the null next retry closes the journey as expired');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'bd200000-0000-4000-8000-000000000001'),
  'paused', 'the expired journey pauses the subscription');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_payment_recovery_tokens token
     JOIN public.subscription_dunning_cases dunning_case ON dunning_case.id = token.case_id
    WHERE dunning_case.subscription_id = 'bd200000-0000-4000-8000-000000000001'
      AND token.purpose = 'resume_subscription'),
  1, 'exactly one resume link is minted, and only at the end');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_dunning_notifications notification
     JOIN public.subscription_dunning_cases dunning_case ON dunning_case.id = notification.case_id
    WHERE dunning_case.subscription_id = 'bd200000-0000-4000-8000-000000000001'
      AND notification.notification_kind = 'payment_expired'
      AND notification.recipient_kind = 'customer'),
  1, 'the customer is told once that the journey ended');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_dunning_notifications notification
     JOIN public.subscription_dunning_cases dunning_case ON dunning_case.id = notification.case_id
    WHERE dunning_case.subscription_id = 'bd200000-0000-4000-8000-000000000001'
      AND notification.notification_kind = 'payment_failed'
      AND notification.recipient_kind = 'customer'),
  3, 'and once per earlier rung, which is three notices, not one');

SELECT is(
  (SELECT count(*)::integer FROM public.commerce_payment_attempts
    WHERE payment_intent_id = 'bd900000-0000-4000-8000-000000000001'),
  4, 'four rungs, four durable attempt rows');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_dunning_cases
    WHERE subscription_id = 'bd200000-0000-4000-8000-000000000001'),
  1, 'one journey, not four: the rungs share a case');

SELECT * FROM finish();
ROLLBACK;
