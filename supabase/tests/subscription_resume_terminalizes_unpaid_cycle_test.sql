-- pgTAP: a self-service resume the expired-dunning rail does not own still
-- leaves the subscription due-listable.
--
-- The behaviour pinned here is an UNREACHABILITY claim, the same one
-- subscription_resume_after_expired_dunning_test.sql makes for the expired-case
-- rail, extended to every other resume: after ANY resume from the account page,
-- a subscription must never be left `active` while still holding a cycle in
-- ('payment_pending', 'retry_scheduled', 'payment_failed'), because
-- subscription_list_due_for_renewal excludes it for as long as one exists.
--
-- The first fixture is the reachable way in that has no dunning case at all: a
-- renewal charge that is neither collected nor refused. The cycle is minted
-- `payment_pending` with its `pending_payment` order and `created` intent; no
-- failure is ever reported, so nothing opens a case. The customer pauses, which
-- the open-case guard cannot refuse because there is no open case, and later
-- resumes. Before this wave the resume flipped the row to `active` and rolled
-- `next_cycle_at` forward while the `payment_pending` cycle stayed put and kept
-- the subscription out of the renewal lane forever.
--
-- The other two fixtures pin what must NOT move: an open dunning case still
-- blocks the action outright and terminalizes nothing, and a subscription with
-- nothing uncollected resumes byte-for-byte as it did before.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(26);

-- ---- Surface -------------------------------------------------------------
SELECT has_function(
  'public',
  'customer_self_service_apply_subscription_action',
  ARRAY['uuid', 'text', 'uuid', 'text', 'jsonb', 'timestamp with time zone'],
  'the self-service entry point keeps its signature');

SELECT has_function(
  'public',
  'customer_self_service_apply_action_before_resume_terminalizes',
  ARRAY['uuid', 'text', 'uuid', 'text', 'jsonb', 'timestamp with time zone'],
  'the wrapped implementation stays reachable under its new name');

-- This repository has a live browser-role EXECUTE escalation of exactly this
-- class: a definer-rights body reachable by anon/authenticated because a rename
-- carried an ACL nobody restated. Both names are asserted, not assumed.
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.customer_self_service_apply_subscription_action(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.customer_self_service_apply_subscription_action(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.customer_self_service_apply_subscription_action(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE'),
  'the self-service entry point is service-role only');

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.customer_self_service_apply_action_before_resume_terminalizes(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'anon',
    'public.customer_self_service_apply_action_before_resume_terminalizes(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.customer_self_service_apply_action_before_resume_terminalizes(uuid,text,uuid,text,jsonb,timestamp with time zone)',
    'EXECUTE'),
  'the wrapped implementation is service-role only');

-- ---- Shared catalogue ----------------------------------------------------
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('fa400000-0000-4000-8000-000000000001', 'resume-terminalize-product',
        'Resume Terminalize Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('fa500000-0000-4000-8000-000000000001', 'fa400000-0000-4000-8000-000000000001',
        'RESUME-TERMINALIZE-SKU', 'Resume Terminalize SKU', 'dog', 'active', 400, 350);

-- ---- Fixture 1: paused, one uncollected cycle, no dunning case ------------
INSERT INTO auth.users (id) VALUES ('fa000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('fa100000-0000-4000-8000-000000000001', 'resume-terminalize@example.invalid',
        'fa000000-0000-4000-8000-000000000001');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'fa200000-0000-4000-8000-000000000001', 'fa100000-0000-4000-8000-000000000001',
  30, 'XTS', 'paused', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_resume_terminalize', 'card');

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('fa200000-0000-4000-8000-000000000001', 'fa500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- The charge was started and never resolved: no result, no failure, so nothing
-- ever called the dunning RPC and no case exists to explain the stall.
-- A `payment_pending` cycle must carry the canonical template snapshot; the
-- guard from 20260605144000 rejects any other value on insert.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key,
  retry_attempt, template_snapshot
) VALUES (
  'fa300000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001',
  2, '2026-06-01T00:00:00Z', 'payment_pending', 'resume-terminalize-cycle', 1,
  public.subscription_current_template_snapshot('fa200000-0000-4000-8000-000000000001'));

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'fa700000-0000-4000-8000-000000000001', 'fa100000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'fa200000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000001');

INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('fa800000-0000-4000-8000-000000000001', 'fa700000-0000-4000-8000-000000000001',
        'test', 'pending', 12999);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, status
) VALUES (
  'fa900000-0000-4000-8000-000000000001', 'subscription_cycle',
  'fa700000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001', 'fa800000-0000-4000-8000-000000000001',
  12999, 'created');
INSERT INTO public.commerce_payment_attempts (
  id, payment_intent_id, payment_id, provider, idempotency_key, status, amount_cents
) VALUES (
  'faa00000-0000-4000-8000-000000000001', 'fa900000-0000-4000-8000-000000000001',
  'fa800000-0000-4000-8000-000000000001', 'test', 'resume-terminalize-attempt',
  'sent_to_provider', 12999);

-- ---- The trap, restated as its preconditions -----------------------------
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_dunning_cases
    WHERE subscription_id = 'fa200000-0000-4000-8000-000000000001'),
  0, 'no dunning case exists at all, so no dunning rail can own this resume');

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal(50, '2026-07-01T00:00:00Z'::timestamptz)
    WHERE subscription_id = 'fa200000-0000-4000-8000-000000000001'),
  0, 'the uncollected cycle already hides the subscription from the renewal lane');

-- ---- A charge that may still land refuses, and writes nothing -------------
SELECT throws_ok(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'fa000000-0000-4000-8000-000000000001', 'resume-terminalize-inflight',
       'fa200000-0000-4000-8000-000000000001', 'resume', '{}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  'P0001',
  'customer_self_service_payment_blocked_attempt_in_flight',
  'resume refuses while a provider attempt for this subscription is in flight');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'fa200000-0000-4000-8000-000000000001'),
  'paused', 'the in-flight refusal left the subscription paused');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'fa300000-0000-4000-8000-000000000001'),
  'payment_pending', 'the in-flight refusal cancelled nothing under the payer');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'fa700000-0000-4000-8000-000000000001'),
  'pending_payment', 'the in-flight refusal left the unpaid order alone');

-- The provider call ended without a collection: the attempt is terminal, so
-- nothing is in flight any more and the artifacts are genuinely abandoned.
UPDATE public.commerce_payment_attempts
   SET status = 'failed'
 WHERE id = 'faa00000-0000-4000-8000-000000000001';

-- ---- The resume -----------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'fa000000-0000-4000-8000-000000000001', 'resume-terminalize-applied',
       'fa200000-0000-4000-8000-000000000001', 'resume', '{}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  'a resume with no dunning case still needs no charge confirmation');

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'fa200000-0000-4000-8000-000000000001'),
  'active', 'the subscription is active again');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'fa300000-0000-4000-8000-000000000001'),
  'skipped', 'the uncollected cycle is terminalized as skipped, never charged later');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'fa700000-0000-4000-8000-000000000001'),
  'cancelled', 'the unpaid renewal order is cancelled with the cycle');

SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = 'fa900000-0000-4000-8000-000000000001'),
  'cancelled', 'the non-terminal intent is cancelled with the cycle');

SELECT is(
  (SELECT failure_reason FROM public.subscription_cycles WHERE id = 'fa300000-0000-4000-8000-000000000001'),
  'subscription_resumed_with_unpaid_cycle',
  'the skipped cycle records why it was closed');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'fa200000-0000-4000-8000-000000000001'),
  '2026-07-31T00:00:00Z'::timestamptz,
  'the delegated cadence roll-forward is unchanged: the missed date is skipped, not billed');

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
    WHERE subscription_id = 'fa200000-0000-4000-8000-000000000001'
      AND event_type = 'subscription.customer_self_service.resume'),
  1, 'the ordinary self-service resume event is emitted exactly once');

-- ---- THE UNREACHABILITY PIN ----------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_cycles
    WHERE subscription_id = 'fa200000-0000-4000-8000-000000000001'
      AND status IN ('payment_pending', 'retry_scheduled', 'payment_failed')),
  0, 'no cycle status is left that would exclude the row from the renewal lane');

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal(50, '2026-08-01T00:00:00Z'::timestamptz)
    WHERE subscription_id = 'fa200000-0000-4000-8000-000000000001'),
  1, 'the resumed subscription is due-listable again: the dead end is unreachable');

-- ---- Fixture 2: an open case still owns its cycle ------------------------
INSERT INTO auth.users (id) VALUES ('fa000000-0000-4000-8000-000000000002');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('fa100000-0000-4000-8000-000000000002', 'resume-open-case@example.invalid',
        'fa000000-0000-4000-8000-000000000002');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'fa200000-0000-4000-8000-000000000002', 'fa100000-0000-4000-8000-000000000002',
  30, 'XTS', 'paused', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_resume_open_case', 'card');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('fa200000-0000-4000-8000-000000000002', 'fa500000-0000-4000-8000-000000000001', 1, 0, false, 1);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt
) VALUES (
  'fa300000-0000-4000-8000-000000000002', 'fa200000-0000-4000-8000-000000000002',
  2, '2026-06-01T00:00:00Z', 'retry_scheduled', 'resume-open-case-cycle', 1);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'fa700000-0000-4000-8000-000000000002', 'fa100000-0000-4000-8000-000000000002',
  'XTS', 'ZZ', '{"kind":"units","value":30}'::jsonb, 'pending_payment',
  12999, 12999, 'subscription_cycle',
  'fa200000-0000-4000-8000-000000000002', 'fa300000-0000-4000-8000-000000000002');
INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('fa800000-0000-4000-8000-000000000002', 'fa700000-0000-4000-8000-000000000002',
        'test', 'pending', 12999);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, status
) VALUES (
  'fa900000-0000-4000-8000-000000000002', 'subscription_cycle',
  'fa700000-0000-4000-8000-000000000002', 'fa200000-0000-4000-8000-000000000002',
  'fa300000-0000-4000-8000-000000000002', 'fa800000-0000-4000-8000-000000000002',
  12999, 'failed');
INSERT INTO public.commerce_payment_attempts (
  id, payment_intent_id, payment_id, provider, idempotency_key, status, amount_cents
) VALUES (
  'faa00000-0000-4000-8000-000000000002', 'fa900000-0000-4000-8000-000000000002',
  'fa800000-0000-4000-8000-000000000002', 'test', 'resume-open-case-attempt',
  'failed', 12999);

CREATE TEMP TABLE _fa_open_case AS
SELECT (public.subscription_handle_payment_failure_dunning(
  'resume-open-case-dunning', 'fa300000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000002', 'fa700000-0000-4000-8000-000000000002',
  'fa900000-0000-4000-8000-000000000002',
  1, '2026-06-02T00:00:00Z'::timestamptz, 'renewal_declined', '2026-06-01T12:00:00Z'::timestamptz
) -> 'subscriptionDunning' ->> 'caseId')::uuid AS case_id;

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases WHERE id = (SELECT case_id FROM _fa_open_case)),
  'open', 'the retry ladder left an open case');

SELECT throws_ok(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'fa000000-0000-4000-8000-000000000002', 'resume-open-case-blocked',
       'fa200000-0000-4000-8000-000000000002', 'resume', '{}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  'P0001',
  'customer_self_service_payment_blocked',
  'an open dunning case still blocks the resume with its own long-standing code');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'fa300000-0000-4000-8000-000000000002'),
  'retry_scheduled',
  'the blocked resume terminalized nothing: the ladder still owns that cycle');

-- ---- Fixture 3: nothing uncollected, nothing moves ------------------------
INSERT INTO auth.users (id) VALUES ('fa000000-0000-4000-8000-000000000003');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('fa100000-0000-4000-8000-000000000003', 'resume-clean@example.invalid',
        'fa000000-0000-4000-8000-000000000003');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
) VALUES (
  'fa200000-0000-4000-8000-000000000003', 'fa100000-0000-4000-8000-000000000003',
  30, 'XTS', 'paused', '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z',
  'pm_resume_clean', 'card');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('fa200000-0000-4000-8000-000000000003', 'fa500000-0000-4000-8000-000000000001', 1, 0, false, 1);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt
) VALUES (
  'fa300000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000003',
  1, '2026-05-01T00:00:00Z', 'paid', 'resume-clean-cycle', 0);

SELECT lives_ok(
  $$ SELECT public.customer_self_service_apply_subscription_action(
       'fa000000-0000-4000-8000-000000000003', 'resume-clean-applied',
       'fa200000-0000-4000-8000-000000000003', 'resume', '{}'::jsonb,
       '2026-07-01T10:00:00Z'::timestamptz) $$,
  'a resume with nothing uncollected still succeeds');

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'fa200000-0000-4000-8000-000000000003'),
  '2026-07-31T00:00:00Z'::timestamptz,
  'the untouched resume keeps its cadence roll-forward exactly');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'fa300000-0000-4000-8000-000000000003'),
  'paid', 'a collected cycle is never touched by the terminalization');

SELECT * FROM finish();
ROLLBACK;
