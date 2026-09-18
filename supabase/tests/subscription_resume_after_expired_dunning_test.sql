-- pgTAP: resuming a subscription whose dunning case expired is no longer a
-- silent dead end.
--
-- The behaviour this pins is an UNREACHABILITY claim, not a happy path: after
-- any self-service resume, a subscription must never be left `active` while
-- still holding the terminal `payment_failed` cycle that excludes it from
-- subscription_list_due_for_renewal. That state -- active, never charged, never
-- shipped, no email, no telemetry -- was reachable from the account page with a
-- single click and zero method checks, because the self-service payment guard
-- only fires on an OPEN case and an expired one is not open.
--
-- Covered here: the rail's refusals (charge confirmation, unchargeable stored
-- method), the terminalization of every abandoned cycle with its order and intent,
-- the case's honest terminal, the due-list re-entry, and the delegated paths that
-- must stay unchanged. The recovery-link entry to the same rail is pinned where
-- its fixture already lives, in payment_recovery_sha256_test.sql.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(34);

-- ---- Surface -------------------------------------------------------------
SELECT has_function(
  'public',
  'subscription_resume_after_expired_dunning',
  ARRAY['text', 'uuid', 'text', 'text', 'timestamp with time zone', 'text'],
  'the expired-dunning resume rail exists');

SELECT has_function(
  'public',
  'subscription_method_chargeable_unattended',
  ARRAY['uuid', 'timestamp with time zone'],
  'the unattended-charge precondition exists');

SELECT has_function(
  'public',
  'subscription_terminalize_unpaid_cycle_artifacts',
  ARRAY['uuid', 'uuid', 'timestamp with time zone', 'text'],
  'the shared terminalization helper exists');

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.subscription_resume_after_expired_dunning(text,uuid,text,text,timestamp with time zone,text)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.subscription_resume_after_expired_dunning(text,uuid,text,text,timestamp with time zone,text)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.subscription_resume_after_expired_dunning(text,uuid,text,text,timestamp with time zone,text)',
    'EXECUTE'),
  'the rail is service-role only');

-- ---- Fixture: one paused subscription with an expired dunning case --------
INSERT INTO auth.users (id) VALUES ('ed000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('ed100000-0000-4000-8000-000000000001', 'expired-resume@example.invalid',
        'ed000000-0000-4000-8000-000000000001');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'ed200000-0000-4000-8000-000000000001', 'ed100000-0000-4000-8000-000000000001',
  30, 'XTS', 'active', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_expired_resume', 'card');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('ed400000-0000-4000-8000-000000000001', 'expired-resume-product', 'Expired Resume Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('ed500000-0000-4000-8000-000000000001', 'ed400000-0000-4000-8000-000000000001',
        'EXPIRED-RESUME-SKU', 'Expired Resume SKU', 'dog', 'active', 400, 350);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('ed200000-0000-4000-8000-000000000001', 'ed500000-0000-4000-8000-000000000001', 1, 0, false, 1);

INSERT INTO public.commerce_payment_method_refs (
  id, client_id, subscription_id, provider_kind, method_kind,
  provider_customer_ref, provider_method_ref, status, active, expires_at
) VALUES (
  'ed600000-0000-4000-8000-000000000001', 'ed100000-0000-4000-8000-000000000001',
  'ed200000-0000-4000-8000-000000000001', 'card_rail', 'card',
  'cus_expired_resume', 'pm_expired_resume', 'active', true, NULL);

-- A historical failed cycle predates the latest cycle owned by the expired
-- dunning case. Both statuses exclude the subscription from the renewal due-list,
-- and both carry live unpaid artifacts that resume must close atomically.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key,
  retry_attempt, failure_reason
) VALUES
(
  'ed300000-0000-4000-8000-000000000002', 'ed200000-0000-4000-8000-000000000001',
  1, '2026-05-01T00:00:00Z', 'payment_failed', 'expired-resume-older-cycle', 2, 'card_declined'
),
(
  'ed300000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001',
  2, '2026-06-01T00:00:00Z', 'payment_failed', 'expired-resume-cycle', 4, 'payment_expired');

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES
(
  'ed700000-0000-4000-8000-000000000002', 'ed100000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'ed200000-0000-4000-8000-000000000001', 'ed300000-0000-4000-8000-000000000002'
),
(
  'ed700000-0000-4000-8000-000000000001', 'ed100000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'ed200000-0000-4000-8000-000000000001', 'ed300000-0000-4000-8000-000000000001');

CREATE TEMP TABLE _ed_older_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'expired-resume-older-intent', 'subscription_cycle', 'ed700000-0000-4000-8000-000000000002',
  'ed200000-0000-4000-8000-000000000001', 'ed300000-0000-4000-8000-000000000002',
  12999, 'XTS', '{}'::jsonb) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _ed_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'expired-resume-intent', 'subscription_cycle', 'ed700000-0000-4000-8000-000000000001',
  'ed200000-0000-4000-8000-000000000001', 'ed300000-0000-4000-8000-000000000001',
  12999, 'XTS', '{}'::jsonb) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- A NULL next_retry_at AT THE LADDER'S LAST RUNG is its exhaustion: the case
-- expires and the cycle is left terminal. Rung 4 is that rung -- attempts 1..3
-- are always handed a schedule -- so the fixture states attempt 4 here and on the
-- cycle above. Below rung 4 the same NULL means the sequence was cut short, which
-- is an OPEN case and a different fixture (subscription_dunning_open_without_retry_test.sql).
CREATE TEMP TABLE _ed_case AS
SELECT (public.subscription_handle_payment_failure_dunning(
  'expired-resume-dunning', 'ed300000-0000-4000-8000-000000000001',
  'ed200000-0000-4000-8000-000000000001', 'ed700000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _ed_intent),
  4, NULL, 'payment_expired', '2026-06-12T12:00:00Z'::timestamptz
) -> 'subscriptionDunning' ->> 'caseId')::uuid AS case_id;

UPDATE public.subscriptions
   SET status = 'paused'
 WHERE id = 'ed200000-0000-4000-8000-000000000001';

-- ---- The trap, restated as its preconditions -----------------------------
SELECT is(
  (SELECT status FROM public.subscription_dunning_cases WHERE id = (SELECT case_id FROM _ed_case)),
  'expired', 'the ladder left a terminal expired case');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'ed300000-0000-4000-8000-000000000001'),
  'payment_failed', 'the failed cycle is terminal payment_failed');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_dunning_cases
    WHERE subscription_id = 'ed200000-0000-4000-8000-000000000001' AND status = 'open'),
  0, 'no OPEN case exists, so the self-service payment guard cannot fire');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_cycles
    WHERE subscription_id = 'ed200000-0000-4000-8000-000000000001'
      AND status IN ('payment_pending', 'retry_scheduled', 'payment_failed')),
  2, 'two stale unpaid cycles reproduce the historical multi-cycle trap');

-- ---- Refusals ------------------------------------------------------------
SELECT throws_like(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'ed000000-0000-4000-8000-000000000001', 'expired-resume-unconfirmed',
       'ed200000-0000-4000-8000-000000000001', 'resume', '{}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  '%customer_self_service_charge_timing_not_confirmed%',
  'resume after an expired case requires the charge-timing confirmation');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'ed200000-0000-4000-8000-000000000001'),
  'paused', 'the refused resume left the subscription paused');

-- An unchargeable stored method must not buy a promise the renewal lane cannot
-- keep. The method is revoked, exactly as an ALIAS_UNREGISTER webhook leaves it.
UPDATE public.commerce_payment_method_refs
   SET status = 'revoked', active = false
 WHERE id = 'ed600000-0000-4000-8000-000000000001';

SELECT ok(
  NOT public.subscription_method_chargeable_unattended(
    'ed200000-0000-4000-8000-000000000001', '2026-07-01T10:00:00Z'::timestamptz),
  'a revoked method is not chargeable unattended');

SELECT throws_like(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'ed000000-0000-4000-8000-000000000001', 'expired-resume-nomethod',
       'ed200000-0000-4000-8000-000000000001', 'resume',
       '{"confirmedChargeTiming":true}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  '%customer_self_service_payment_method_not_chargeable%',
  'resume refuses a stored method the renewal lane cannot charge');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'ed200000-0000-4000-8000-000000000001'),
  'paused', 'the method refusal left the subscription paused');

-- A mandate that requires the customer at every charge is the same refusal, and
-- it is asked of the consent snapshot rather than of any provider name.
UPDATE public.commerce_payment_method_refs
   SET status = 'active', active = true,
       consent_snapshot = '{"recurringModel":"M"}'::jsonb
 WHERE id = 'ed600000-0000-4000-8000-000000000001';

SELECT ok(
  NOT public.subscription_method_chargeable_unattended(
    'ed200000-0000-4000-8000-000000000001', '2026-07-01T10:00:00Z'::timestamptz),
  'a per-charge-approval mandate is not chargeable unattended');

UPDATE public.commerce_payment_method_refs
   SET consent_snapshot = '{"recurringModel":"O"}'::jsonb,
       expires_at = '2026-06-30T00:00:00Z'
 WHERE id = 'ed600000-0000-4000-8000-000000000001';

SELECT ok(
  NOT public.subscription_method_chargeable_unattended(
    'ed200000-0000-4000-8000-000000000001', '2026-07-01T10:00:00Z'::timestamptz),
  'a method whose expiry has passed is not chargeable unattended');

-- Expiring soon is still usable, matching canUsePaymentMethodForRenewal.
UPDATE public.commerce_payment_method_refs
   SET expires_at = '2026-07-15T00:00:00Z'
 WHERE id = 'ed600000-0000-4000-8000-000000000001';

SELECT ok(
  public.subscription_method_chargeable_unattended(
    'ed200000-0000-4000-8000-000000000001', '2026-07-01T10:00:00Z'::timestamptz),
  'a method expiring soon is still chargeable unattended');

-- ---- The rail --------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'ed000000-0000-4000-8000-000000000001', 'expired-resume-applied',
       'ed200000-0000-4000-8000-000000000001', 'resume',
       '{"confirmedChargeTiming":true}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  'resume after an expired case succeeds once its preconditions hold');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'ed200000-0000-4000-8000-000000000001'),
  'active', 'the subscription is active again');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'ed200000-0000-4000-8000-000000000001'),
  '2026-07-03T10:00:00Z'::timestamptz,
  'the new cycle starts from the resume date, so missed cycles are skipped');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'ed300000-0000-4000-8000-000000000001'),
  'skipped', 'the uncollected cycle is terminalized as skipped');

SELECT is(
  (SELECT failure_reason FROM public.subscription_cycles WHERE id = 'ed300000-0000-4000-8000-000000000001'),
  'payment_expired', 'terminalization preserves why the cycle failed');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'ed700000-0000-4000-8000-000000000001'),
  'cancelled', 'the unpaid renewal order is cancelled with the cycle');

SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _ed_intent)),
  'cancelled', 'the failed intent is cancelled with the cycle');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'ed300000-0000-4000-8000-000000000002'),
  'skipped', 'the older failed cycle is also terminalized');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'ed700000-0000-4000-8000-000000000002'),
  'cancelled', 'the older unpaid order is also cancelled');

SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _ed_older_intent)),
  'cancelled', 'the older unpaid intent is also cancelled');

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases WHERE id = (SELECT case_id FROM _ed_case)),
  'resumed_unpaid',
  'the case closes as resumed_unpaid, not recovered: nothing was collected');

SELECT is(
  (SELECT recovered_at FROM public.subscription_dunning_cases WHERE id = (SELECT case_id FROM _ed_case)),
  NULL, 'a resumed-unpaid case records no recovery timestamp');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
    WHERE subscription_id = 'ed200000-0000-4000-8000-000000000001'
      AND event_type = 'subscription.customer_self_service.resume'),
  1, 'the ordinary self-service resume event is emitted exactly once');

-- ---- THE UNREACHABILITY PIN ----------------------------------------------
-- This is the assertion the wave exists for. Before the fix the subscription
-- was active and permanently absent from this list.
SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal(50, '2026-07-04T00:00:00Z'::timestamptz)
    WHERE subscription_id = 'ed200000-0000-4000-8000-000000000001'),
  1, 'the resumed subscription is due-listable again: the dead end is unreachable');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_cycles
    WHERE subscription_id = 'ed200000-0000-4000-8000-000000000001'
      AND status IN ('payment_pending', 'retry_scheduled', 'payment_failed')),
  0, 'no cycle status is left that would exclude the row from the renewal lane');

-- ---- Delegated paths stay unchanged --------------------------------------
INSERT INTO auth.users (id) VALUES ('ed000000-0000-4000-8000-000000000002');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('ed100000-0000-4000-8000-000000000002', 'plain-resume@example.invalid',
        'ed000000-0000-4000-8000-000000000002');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'ed200000-0000-4000-8000-000000000002', 'ed100000-0000-4000-8000-000000000002',
  30, 'XTS', 'paused', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_plain_resume', 'card');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('ed200000-0000-4000-8000-000000000002', 'ed500000-0000-4000-8000-000000000001', 1, 0, false, 1);

SELECT lives_ok(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'ed000000-0000-4000-8000-000000000002', 'plain-resume-applied',
       'ed200000-0000-4000-8000-000000000002', 'resume', '{}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  'a resume with no dunning case still needs no charge confirmation');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'ed200000-0000-4000-8000-000000000002'),
  'active', 'the delegated resume still activates the subscription');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'ed200000-0000-4000-8000-000000000002'),
  '2026-07-31T00:00:00Z'::timestamptz,
  'the delegated resume keeps its cadence roll-forward, not the two-day re-arm');

SELECT * FROM finish();
ROLLBACK;
