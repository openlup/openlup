-- pgTAP: a refusal the issuer marked `hard_do_not_retry` stops consuming the
-- retry ladder, and nothing else does.
--
-- This is the activation proof for `20260829120000`, which fills
-- `v_terminating_classes` with exactly one member. Its predecessors proved the
-- seam was inert; this file proves the one member is live and the rest of the
-- taxonomy is untouched.
--
-- It drives the REAL apply body rather than injecting a schedule. That matters:
-- `subscription_dunning_open_without_retry_test.sql` already pins what the
-- dunning boundary makes of an absent schedule at rung one, but it hands that
-- absence to the boundary directly. Nothing yet proved a classified refusal
-- PRODUCES the absence. Here the class goes in at
-- `commerce_payment_control_apply_result` and the whole chain is read back.
--
-- Four arms, and the three controls are the point as much as the first:
--
--   A  TERMINATES.   hard_do_not_retry at rung one -> next_retry_at NULL, cycle
--      payment_failed, subscription.payment_failed event; and downstream the
--      case OPEN with no expiry, subscription still ACTIVE with no pause event,
--      a 14-day repair_payment token, no resume token, and the attempt-numbered
--      failed notice queued.
--   B  DOES NOT.     soft_retryable at rung one -> the unchanged +24h rung.
--   C  DOES NOT.     no class at all at rung one -> the unchanged +24h rung.
--   D  UNCHANGED END. an unclassified refusal at rung four still exhausts:
--      case expired, subscription paused with its event, 30-day
--      resume_subscription token.
--
-- Arms B and C are the fail-open proof. If either ever goes red, the terminating
-- guard has stopped being an explicit-membership test and has started shortening
-- ladders nobody listed — the one outcome this activation may not have.
--
-- `mandate_dead` is deliberately absent from every arm. It is the class one
-- literal away from being listed and it terminates a different population; the
-- wave that lists it brings its own proof.
--
-- Fixture literals stay neutral for the reason the sibling suites' do: these
-- writes read neither provider, nor currency, nor region, so all three use the
-- user-assigned codes ('simulator', 'XTS', 'ZZ') rather than claiming a
-- dependency that is not there.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(23);

-- ---- Surface: the seal the replacement restated -----------------------------
-- `CREATE OR REPLACE` keeps an existing ACL, but on this platform a function
-- created fresh is granted EXECUTE by default to anon, authenticated and
-- service_role. The migration restates the REVOKE so a fresh reset converges on
-- the sealed shape too; asserted here so the activation cannot quietly ship an
-- open body. The identity resolves first so nothing below passes vacuously.
SELECT isnt(
  to_regprocedure(
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)'
  )::text,
  NULL::text,
  'the seven-argument apply body still resolves, so the seal assertions below are real');

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)',
    'EXECUTE'),
  'the activation keeps the body unreachable except through its wrapper');

-- ===========================================================================
-- ARM A: hard_do_not_retry at rung one
-- ===========================================================================
INSERT INTO public.clients (id, email)
VALUES ('9a000000-0000-4000-8000-00000000a001', 'terminating-class@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('9b000000-0000-4000-8000-00000000a001', '9a000000-0000-4000-8000-00000000a001', 30, 'XTS', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('9c000000-0000-4000-8000-00000000a001', '9b000000-0000-4000-8000-00000000a001', 2, '2026-06-01T00:00:00Z',
        'planned', 'terminating-class-renewal', 0);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('9d000000-0000-4000-8000-00000000a001', '9a000000-0000-4000-8000-00000000a001', 'XTS', 'ZZ',
        '{"kind":"unit_count","value":2}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        '9b000000-0000-4000-8000-00000000a001', '9c000000-0000-4000-8000-00000000a001');

CREATE TEMP TABLE _ai AS
SELECT (public.commerce_payment_control_create_intent(
  'w9-a-intent-key-01', 'subscription_cycle', '9d000000-0000-4000-8000-00000000a001',
  '9b000000-0000-4000-8000-00000000a001', '9c000000-0000-4000-8000-00000000a001', 12999, 'XTS', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'w9-a-attempt-key-01', (SELECT intent_id FROM _ai), 'simulator', 'pa_w9_a', 'ps_w9_a',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'w9-a-apply-key-01', (SELECT intent_id FROM _ai), NULL, 'failed',
  '2026-06-01T12:00:00Z'::timestamptz, 'provider_declined',
  'hard_do_not_retry', 'advice_code');

-- ---- What the ladder decided ------------------------------------------------
SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles
    WHERE id = '9c000000-0000-4000-8000-00000000a001'),
  NULL::timestamptz,
  'A: a hard_do_not_retry refusal is given no next charge at all');

SELECT is(
  (SELECT retry_attempt::text || '|' || status FROM public.subscription_cycles
    WHERE id = '9c000000-0000-4000-8000-00000000a001'),
  '1|payment_failed',
  'A: the attempt still counts, and the cycle lands payment_failed rather than retry_scheduled');

SELECT is(
  (SELECT event_type FROM public.subscription_events
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000a001'
      AND event_type IN ('subscription.payment_failed', 'subscription.retry_scheduled')),
  'subscription.payment_failed',
  'A: the emitted event says the payment failed, not that a retry was scheduled');

SELECT is(
  (SELECT (payload ->> 'nextRetryAt') IS NULL FROM public.subscription_events
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000a001'
      AND event_type = 'subscription.payment_failed'),
  true,
  'A: the event payload carries no schedule for anything downstream to promise');

-- ---- What the customer is left holding --------------------------------------
CREATE TEMP TABLE _ad AS
SELECT public.subscription_handle_payment_failure_dunning(
  'w9-a-dunning-key-01', '9c000000-0000-4000-8000-00000000a001',
  '9b000000-0000-4000-8000-00000000a001', '9d000000-0000-4000-8000-00000000a001',
  (SELECT intent_id FROM _ai), 1, NULL, 'provider_declined',
  '2026-06-01T12:00:00Z'::timestamptz, 'hard_do_not_retry'
) -> 'subscriptionDunning' AS payload;

SELECT is(
  (SELECT status || '|' || coalesce(expired_at::text, 'no-expiry')
     FROM public.subscription_dunning_cases WHERE cycle_id = '9c000000-0000-4000-8000-00000000a001'),
  'open|no-expiry',
  'A: the case stays OPEN with no expiry instant — terminating is not expiring');

-- THE PRODUCT INVARIANT. A live subscription may not be suspended by this wave.
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '9b000000-0000-4000-8000-00000000a001'),
  'active',
  'A: the subscription is STILL ACTIVE — ending the ladder never pauses it');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
    WHERE subscription_id = '9b000000-0000-4000-8000-00000000a001'
      AND event_type = 'subscription.paused'),
  0,
  'A: no pause event is emitted for a case that never expired');

SELECT is(
  (SELECT purpose || '|' || expires_at::text FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000a001'),
  'repair_payment|2026-06-15 12:00:00+00',
  'A: the customer holds a repair_payment token, its 14 days counted from the refusal itself');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000a001'
      AND purpose = 'resume_subscription'),
  0,
  'A: nothing offers to resume a subscription that was never paused');

SELECT is(
  (SELECT notification_kind || '|' || template_slug FROM public.subscription_dunning_notifications
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000a001' AND recipient_kind = 'customer'),
  'payment_failed|subscription-payment-failed-1',
  'A: the day-zero notice is the attempt-numbered failed one, not the expiry notice');

SELECT is(
  (SELECT payload ->> 'recoveryTokenPurpose' FROM _ad),
  'repair_payment',
  'A: the boundary reports a repair verdict to its caller');

-- ===========================================================================
-- ARM B: soft_retryable at rung one — the ladder is untouched
-- ===========================================================================
INSERT INTO public.clients (id, email)
VALUES ('9a000000-0000-4000-8000-00000000b001', 'soft-class@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('9b000000-0000-4000-8000-00000000b001', '9a000000-0000-4000-8000-00000000b001', 30, 'XTS', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('9c000000-0000-4000-8000-00000000b001', '9b000000-0000-4000-8000-00000000b001', 2, '2026-06-01T00:00:00Z',
        'planned', 'soft-class-renewal', 0);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('9d000000-0000-4000-8000-00000000b001', '9a000000-0000-4000-8000-00000000b001', 'XTS', 'ZZ',
        '{"kind":"unit_count","value":2}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        '9b000000-0000-4000-8000-00000000b001', '9c000000-0000-4000-8000-00000000b001');

CREATE TEMP TABLE _bi AS
SELECT (public.commerce_payment_control_create_intent(
  'w9-b-intent-key-01', 'subscription_cycle', '9d000000-0000-4000-8000-00000000b001',
  '9b000000-0000-4000-8000-00000000b001', '9c000000-0000-4000-8000-00000000b001', 12999, 'XTS', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'w9-b-attempt-key-01', (SELECT intent_id FROM _bi), 'simulator', 'pa_w9_b', 'ps_w9_b',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'w9-b-apply-key-01', (SELECT intent_id FROM _bi), NULL, 'failed',
  '2026-06-01T12:00:00Z'::timestamptz, 'provider_declined',
  'soft_retryable', 'advice_code');

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles
    WHERE id = '9c000000-0000-4000-8000-00000000b001'),
  '2026-06-02T12:00:00Z'::timestamptz,
  'B: a soft_retryable refusal still takes rung one exactly 24h out');

SELECT is(
  (SELECT retry_attempt::text || '|' || status FROM public.subscription_cycles
    WHERE id = '9c000000-0000-4000-8000-00000000b001'),
  '1|retry_scheduled',
  'B: and the cycle is retry_scheduled, byte for byte the pre-activation verdict');

-- ===========================================================================
-- ARM C: no class at all at rung one — the ladder is untouched
-- ===========================================================================
INSERT INTO public.clients (id, email)
VALUES ('9a000000-0000-4000-8000-00000000c001', 'no-class@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('9b000000-0000-4000-8000-00000000c001', '9a000000-0000-4000-8000-00000000c001', 30, 'XTS', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('9c000000-0000-4000-8000-00000000c001', '9b000000-0000-4000-8000-00000000c001', 2, '2026-06-01T00:00:00Z',
        'planned', 'no-class-renewal', 0);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('9d000000-0000-4000-8000-00000000c001', '9a000000-0000-4000-8000-00000000c001', 'XTS', 'ZZ',
        '{"kind":"unit_count","value":2}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        '9b000000-0000-4000-8000-00000000c001', '9c000000-0000-4000-8000-00000000c001');

CREATE TEMP TABLE _ci AS
SELECT (public.commerce_payment_control_create_intent(
  'w9-c-intent-key-01', 'subscription_cycle', '9d000000-0000-4000-8000-00000000c001',
  '9b000000-0000-4000-8000-00000000c001', '9c000000-0000-4000-8000-00000000c001', 12999, 'XTS', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'w9-c-attempt-key-01', (SELECT intent_id FROM _ci), 'simulator', 'pa_w9_c', 'ps_w9_c',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

-- The pre-classification call shape, argument for argument.
SELECT public.commerce_payment_control_apply_result(
  'w9-c-apply-key-01', (SELECT intent_id FROM _ci), NULL, 'failed',
  '2026-06-01T12:00:00Z'::timestamptz, 'provider_declined');

SELECT is(
  (SELECT next_retry_at::text || '|' || retry_attempt::text || '|' || status
     FROM public.subscription_cycles WHERE id = '9c000000-0000-4000-8000-00000000c001'),
  '2026-06-02 12:00:00+00|1|retry_scheduled',
  'C: an unclassified refusal walks the full cadence, unchanged by a filled terminating set');

-- ===========================================================================
-- ARM D: rung four still exhausts — the far end of the ladder is untouched
-- ===========================================================================
INSERT INTO public.clients (id, email)
VALUES ('9a000000-0000-4000-8000-00000000d001', 'exhausted@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('9b000000-0000-4000-8000-00000000d001', '9a000000-0000-4000-8000-00000000d001', 30, 'XTS', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

-- Parked on rung three, so the refusal below is the fourth attempt.
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('9c000000-0000-4000-8000-00000000d001', '9b000000-0000-4000-8000-00000000d001', 2, '2026-06-01T00:00:00Z',
        'retry_scheduled', 'exhausted-renewal', 3);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('9d000000-0000-4000-8000-00000000d001', '9a000000-0000-4000-8000-00000000d001', 'XTS', 'ZZ',
        '{"kind":"unit_count","value":2}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        '9b000000-0000-4000-8000-00000000d001', '9c000000-0000-4000-8000-00000000d001');

CREATE TEMP TABLE _di AS
SELECT (public.commerce_payment_control_create_intent(
  'w9-d-intent-key-01', 'subscription_cycle', '9d000000-0000-4000-8000-00000000d001',
  '9b000000-0000-4000-8000-00000000d001', '9c000000-0000-4000-8000-00000000d001', 12999, 'XTS', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'w9-d-attempt-key-01', (SELECT intent_id FROM _di), 'simulator', 'pa_w9_d', 'ps_w9_d',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

SELECT public.commerce_payment_control_apply_result(
  'w9-d-apply-key-01', (SELECT intent_id FROM _di), NULL, 'failed',
  '2026-06-01T12:00:00Z'::timestamptz, 'provider_declined');

SELECT is(
  (SELECT retry_attempt::text || '|' || status || '|' || coalesce(next_retry_at::text, 'no-schedule')
     FROM public.subscription_cycles WHERE id = '9c000000-0000-4000-8000-00000000d001'),
  '4|payment_failed|no-schedule',
  'D: rung four still ends the ladder by exhaustion, exactly as it did before');

SELECT public.subscription_handle_payment_failure_dunning(
  'w9-d-dunning-key-01', '9c000000-0000-4000-8000-00000000d001',
  '9b000000-0000-4000-8000-00000000d001', '9d000000-0000-4000-8000-00000000d001',
  (SELECT intent_id FROM _di), 4, NULL, 'provider_declined',
  '2026-06-01T12:00:00Z'::timestamptz);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000d001'),
  'expired',
  'D: exhaustion still expires the case');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '9b000000-0000-4000-8000-00000000d001'),
  'paused',
  'D: exhaustion still pauses the subscription — this wave moved the cut-short case only');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
    WHERE subscription_id = '9b000000-0000-4000-8000-00000000d001'
      AND event_type = 'subscription.paused'),
  1,
  'D: and still emits exactly one pause event');

SELECT is(
  (SELECT purpose || '|' || expires_at::text FROM public.subscription_payment_recovery_tokens
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000d001'),
  'resume_subscription|2026-07-01 12:00:00+00',
  'D: and still mints the 30-day resume token');

SELECT is(
  (SELECT notification_kind || '|' || template_slug FROM public.subscription_dunning_notifications
    WHERE cycle_id = '9c000000-0000-4000-8000-00000000d001' AND recipient_kind = 'customer'),
  'payment_expired|subscription-payment-expired',
  'D: and still sends the expiry notice rather than an attempt-numbered one');

-- ---- The two arms read against each other -----------------------------------
-- The whole wave in one assertion: same taxonomy, same body, same rung-one
-- fixture, opposite verdicts, decided only by the class.
SELECT isnt(
  (SELECT status FROM public.subscription_cycles WHERE id = '9c000000-0000-4000-8000-00000000a001'),
  (SELECT status FROM public.subscription_cycles WHERE id = '9c000000-0000-4000-8000-00000000b001'),
  'the class alone separates the terminated rung-one cycle from the retried one');

SELECT * FROM finish();
ROLLBACK;
