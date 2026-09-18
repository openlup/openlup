-- pgTAP: operator subscription commands and the emergency email correction.
--
-- The commands under test delegate every customer-equivalent mutation to the public
-- self-service authority, so this suite pins BOTH the operator's own answers and the
-- customer floor it deliberately does not move. The customer arm here is
-- characterization: it records the live `+3 days` floor found in
-- customer_self_service_apply_subscription_action_legacy_wave5, and this wave does not
-- change it.
--
-- The sub-three-day band writes `next_cycle_at` itself rather than delegating, so the two
-- payment fences the delegate would have applied - an open dunning case, and a NULL
-- payment_method_ref - are pinned here as the band's own. Refusals are pinned as returned
-- and audited, not raised: the receipt and audit inserts live at the end of the RPC, so a
-- raise past them would leave a refused command with no record at all.
--
-- The final section pins the fence itself rather than a command behind it.
-- `communications_operator_is_active` is the single predicate every operator RPC in this
-- suite, the communications control plane and the customer recovery console call first,
-- and `20260818110000` widened it from the operator table alone to "an active
-- administrator in admin_users, OR an explicit active operator row". Both arms and all
-- four refusals are pinned there, together with the ACL that forward deliberately does
-- not restate.

BEGIN;
SELECT plan(71);

-- Two operators: one on the durable allowlist, one deactivated.
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES
  ('05a00000-0000-4000-8000-000000000001', true),
  ('05a00000-0000-4000-8000-000000000002', false);

INSERT INTO auth.users (id)
VALUES ('05000000-0000-4000-8000-000000000001');

-- The subscriber whose subscription the operator acts on: linked, so the RPC can resolve
-- a principal to delegate as.
INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  '05100000-0000-4000-8000-000000000001',
  'operator-actions-linked@example.invalid',
  '05000000-0000-4000-8000-000000000001'
);

-- Never linked an account, so the email correction is admissible here and only here.
INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  '05100000-0000-4000-8000-000000000002',
  'operator-actions-unlinked@example.invalid',
  NULL
);

-- Occupies an address, so a correction onto it must collide readably.
INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  '05100000-0000-4000-8000-000000000003',
  'operator-actions-taken@example.invalid',
  NULL
);

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('05400000-0000-4000-8000-000000000001', 'operator-actions-product', 'Operator Actions Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('05500000-0000-4000-8000-000000000001', '05400000-0000-4000-8000-000000000001', 'OPERATOR-ACTIONS-SKU', 'Operator Actions SKU', 'dog', 'active', 400, 350);

-- The active subscription every subscription assertion below drives.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  '05200000-0000-4000-8000-000000000001',
  '05100000-0000-4000-8000-000000000001',
  30, 'PLN', 'active',
  '2026-06-01T00:00:00Z', '2026-09-15T00:00:00Z',
  'pm_operator_actions', 'card'
);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('05200000-0000-4000-8000-000000000001', '05500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- A second active subscription whose imminent cycle is already paid, for the lock guard.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  '05200000-0000-4000-8000-000000000002',
  '05100000-0000-4000-8000-000000000001',
  30, 'PLN', 'active',
  '2026-06-01T00:00:00Z', '2026-09-20T00:00:00Z',
  'pm_operator_actions', 'card'
);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('05200000-0000-4000-8000-000000000002', '05500000-0000-4000-8000-000000000001', 1, 0, false, 1);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
)
VALUES (
  '05300000-0000-4000-8000-000000000002',
  '05200000-0000-4000-8000-000000000002',
  2, '2026-09-20T00:00:00Z', 'paid', 'operator-actions-paid-cycle'
);

-- A paused subscription for resume.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  '05200000-0000-4000-8000-000000000003',
  '05100000-0000-4000-8000-000000000001',
  30, 'PLN', 'paused',
  '2026-06-01T00:00:00Z', '2026-09-25T00:00:00Z',
  'pm_operator_actions', 'card'
);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('05200000-0000-4000-8000-000000000003', '05500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- ---------------------------------------------------------------------------
-- The operator allowlist answers before any subscriber state is read.
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '05a00000-0000-4000-8000-000000000002'::uuid,
      '05200000-0000-4000-8000-000000000001'::uuid,
      'pause', '{"pausePreset":"2_weeks"}'::jsonb, 1,
      'operator-inactive-key-1', '2026-08-17T12:00:00Z'::timestamptz)$$,
  '42501',
  'communications_operator_inactive',
  'a deactivated operator is refused with insufficient privilege'
);

SELECT is(
  (SELECT count(*)::integer FROM public.customer_support_subscription_audit_events),
  0,
  'the refused operator left no audit row, because nothing was read or decided'
);

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '05a00000-0000-4000-8000-000000000001'::uuid,
      '05200000-0000-4000-8000-000000000001'::uuid,
      'cancel', '{}'::jsonb, 1,
      'operator-bad-action-1', '2026-08-17T12:00:00Z'::timestamptz)$$,
  '22023',
  'customer_support_subscription_command_invalid',
  'an action outside the allowlist is a malformed command, not a refusal'
);

-- An out-of-range operator floor is malformed too: it is a programming error, not a
-- business answer the operator should see as a refusal receipt.
SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '05a00000-0000-4000-8000-000000000001'::uuid,
      '05200000-0000-4000-8000-000000000001'::uuid,
      'slide_next_cycle',
      '{"newNextCycleAt":"2026-08-25T00:00:00Z","slideMinDays":"0"}'::jsonb, 1,
      'operator-bad-floor-1', '2026-08-17T12:00:00Z'::timestamptz)$$,
  '22023',
  'customer_support_subscription_command_invalid',
  'a slide floor below one day is rejected as malformed'
);

-- ---------------------------------------------------------------------------
-- Optimistic concurrency: a stale expected version conflicts without mutating.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _stale_version AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'pause', '{"pausePreset":"2_weeks"}'::jsonb, 99,
  'operator-stale-version-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _stale_version),
  'conflict',
  'a stale expected version conflicts'
);

SELECT is(
  (SELECT response->>'refusalCode' FROM _stale_version),
  'version_conflict',
  'the conflict names the version as its cause'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000001'),
  'active',
  'the version conflict mutated nothing'
);

SELECT is(
  (SELECT outcome FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-stale-version-1'),
  'conflict',
  'the conflict is audited, so a complaint can see the attempt'
);

-- ---------------------------------------------------------------------------
-- Idempotency: same key replays, changed fingerprint conflicts.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _pause_first AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'pause', '{"pausePreset":"2_weeks"}'::jsonb, 1,
  'operator-pause-key-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _pause_first),
  'applied',
  'the operator pause is applied'
);

SELECT is(
  (SELECT response->>'appliedBy' FROM _pause_first),
  'customer_self_service_delegate',
  'pause went through the self-service authority, not a second state machine'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000001'),
  'paused',
  'the subscription really is paused'
);

CREATE TEMP TABLE _pause_replay AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'pause', '{"pausePreset":"2_weeks"}'::jsonb, 1,
  'operator-pause-key-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _pause_replay),
  'replayed',
  'replaying the same key returns the recorded receipt'
);

SELECT is(
  (SELECT count(*)::integer FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-pause-key-1'),
  1,
  'the replay wrote no second audit row'
);

SELECT is(
  (SELECT count(*)::integer FROM public.customer_support_subscription_commands
    WHERE idempotency_key = 'operator-pause-key-1'),
  1,
  'the replay wrote no second receipt'
);

-- Same key, different payload: the fingerprint is computed inside the RPC from the
-- command's own fields, so this cannot be talked past.
SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '05a00000-0000-4000-8000-000000000001'::uuid,
      '05200000-0000-4000-8000-000000000001'::uuid,
      'pause', '{"pausePreset":"1_month"}'::jsonb, 1,
      'operator-pause-key-1', '2026-08-17T12:00:00Z'::timestamptz)$$,
  '23505',
  'customer_support_idempotency_conflict',
  'the same key with a changed command conflicts'
);

-- ---------------------------------------------------------------------------
-- The operator action is tellable from a subscriber action in the event ledger.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT actor_kind FROM public.subscription_events
    WHERE idempotency_key = 'operator-pause-key-1'),
  'operator',
  'the delegated event is stamped as an operator act'
);

-- The subscriber's own path is untouched and keeps writing no actor.
SELECT lives_ok(
  $$SELECT public.customer_self_service_apply_subscription_action(
      '05000000-0000-4000-8000-000000000001'::uuid,
      'customer-resume-key-1',
      '05200000-0000-4000-8000-000000000001'::uuid,
      'resume', '{}'::jsonb, '2026-08-17T13:00:00Z'::timestamptz)$$,
  'the subscriber can still resume their own subscription'
);

SELECT is(
  (SELECT actor_kind FROM public.subscription_events
    WHERE idempotency_key = 'customer-resume-key-1'),
  NULL,
  'a subscriber act carries no operator stamp, so the two are distinguishable'
);

-- ---------------------------------------------------------------------------
-- Resume, delegated.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _resume AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000003'::uuid,
  'resume', '{}'::jsonb, 1,
  'operator-resume-key-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'appliedBy' FROM _resume),
  'customer_self_service_delegate',
  'resume is delegated, so the expired-dunning rail keeps answering'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000003'),
  'active',
  'the paused subscription is active again'
);

-- ---------------------------------------------------------------------------
-- The reschedule window. The customer floor is characterization; the operator floor
-- is this wave's only widening.
-- ---------------------------------------------------------------------------

-- CHARACTERIZATION of the live customer floor: `+3 days` is admitted, `+2 days` is not.
-- This wave does not move either boundary for the subscriber.
SELECT throws_ok(
  $$SELECT public.customer_self_service_apply_subscription_action(
      '05000000-0000-4000-8000-000000000001'::uuid,
      'customer-slide-too-soon-1',
      '05200000-0000-4000-8000-000000000001'::uuid,
      'slide_next_cycle',
      '{"newNextCycleAt":"2026-08-19T12:00:00Z"}'::jsonb,
      '2026-08-17T12:00:00Z'::timestamptz)$$,
  'customer_self_service_invalid_slide',
  'the subscriber cannot reschedule two days out'
);

SELECT lives_ok(
  $$SELECT public.customer_self_service_apply_subscription_action(
      '05000000-0000-4000-8000-000000000001'::uuid,
      'customer-slide-ok-1',
      '05200000-0000-4000-8000-000000000001'::uuid,
      'slide_next_cycle',
      '{"newNextCycleAt":"2026-08-20T12:00:00Z"}'::jsonb,
      '2026-08-17T12:00:00Z'::timestamptz)$$,
  'the subscriber can reschedule three days out, exactly as before this wave'
);

-- Without an explicit floor the operator inherits the subscriber's three days.
CREATE TEMP TABLE _operator_slide_default AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T12:00:00Z"}'::jsonb, 1,
  'operator-slide-default-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'refusalCode' FROM _operator_slide_default),
  'slide_out_of_window',
  'an operator who names no floor is held to the subscriber floor'
);

-- With the operator floor the same two-day target is admitted.
CREATE TEMP TABLE _operator_slide_widened AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T12:00:00Z","slideMinDays":"1"}'::jsonb, 1,
  'operator-slide-widened-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _operator_slide_widened),
  'applied',
  'an operator floor of one day admits a two-day reschedule'
);

SELECT is(
  (SELECT response->>'appliedBy' FROM _operator_slide_widened),
  'operator_reschedule_band',
  'the sub-three-day target is the one band the delegate cannot accept'
);

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000001'),
  '2026-08-19T12:00:00Z'::timestamptz,
  'the reschedule really moved the next cycle'
);

SELECT is(
  (SELECT actor_kind FROM public.subscription_events
    WHERE idempotency_key = 'operator-slide-widened-1'),
  'operator',
  'the operator-band reschedule is stamped like every other operator act'
);

-- The operator keeps the subscriber's same-calendar-day no-op rather than bypassing it.
CREATE TEMP TABLE _operator_slide_noop AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T06:00:00Z","slideMinDays":"1"}'::jsonb, 1,
  'operator-slide-noop-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _operator_slide_noop),
  'noop',
  'a reschedule onto the day already scheduled is a no-op for the operator too'
);

-- The locked-cycle guard is the subscriber's, and the operator does not outrank it. It
-- refuses rather than raises, because the receipt and audit inserts live at the end of the
-- RPC and a raise would abort past them - see the fences section below.
CREATE TEMP TABLE _operator_slide_locked AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000002'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T12:00:00Z","slideMinDays":"1"}'::jsonb, 1,
  'operator-slide-locked-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'refusalCode' FROM _operator_slide_locked),
  'payment_blocked',
  'a paid cycle blocks the operator reschedule exactly as it blocks the subscriber'
);

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000002'),
  '2026-09-20T00:00:00Z'::timestamptz,
  'the locked-cycle refusal moved nothing'
);

SELECT is(
  (SELECT outcome || '/' || refusal_code FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-slide-locked-1'),
  'refused/payment_blocked',
  'the locked-cycle refusal is audited, which a raise past the ledger inserts could not be'
);

-- ---------------------------------------------------------------------------
-- The two fences the band applies itself, because below three days it writes
-- next_cycle_at instead of delegating and the delegate never sees the command.
--
-- Both carry the delegate's own name. The customer path raises
-- customer_self_service_payment_blocked for either cause and does not tell them apart.
-- ---------------------------------------------------------------------------

-- Subject of all three: an active subscription whose next cycle is far away, so the
-- locked-cycle guard is not what answers here.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
-- Currency is inherited from the subscription the suite already set up rather than
-- named again: none of these assertions depend on which currency it is.
VALUES
  ('05200000-0000-4000-8000-000000000004', '05100000-0000-4000-8000-000000000001',
   30, (SELECT currency FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000001'),
   'active', '2026-06-01T00:00:00Z', '2026-09-30T00:00:00Z',
   'pm_operator_actions', 'card'),
  -- No stored method at all: the renewal this would arm has nothing to charge.
  ('05200000-0000-4000-8000-000000000005', '05100000-0000-4000-8000-000000000001',
   30, (SELECT currency FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000001'),
   'active', '2026-06-01T00:00:00Z', '2026-09-30T00:00:00Z',
   NULL, NULL),
  ('05200000-0000-4000-8000-000000000006', '05100000-0000-4000-8000-000000000001',
   30, (SELECT currency FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000001'),
   'active', '2026-06-01T00:00:00Z', '2026-09-30T00:00:00Z',
   'pm_operator_actions', 'card');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES
  ('05200000-0000-4000-8000-000000000004', '05500000-0000-4000-8000-000000000001', 1, 0, false, 1),
  ('05200000-0000-4000-8000-000000000005', '05500000-0000-4000-8000-000000000001', 1, 0, false, 1),
  ('05200000-0000-4000-8000-000000000006', '05500000-0000-4000-8000-000000000001', 1, 0, false, 1);

-- A dunning case needs a whole failed-cycle spine. Both spines are scheduled well away
-- from their subscription's next_cycle_at, so the locked-cycle guard cannot be mistaken
-- for the fence under test.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
)
VALUES
  ('05300000-0000-4000-8000-000000000004', '05200000-0000-4000-8000-000000000004',
   2, '2026-07-15T00:00:00Z', 'retry_scheduled', 'operator-actions-open-dunning-cycle'),
  ('05300000-0000-4000-8000-000000000006', '05200000-0000-4000-8000-000000000006',
   2, '2026-07-15T00:00:00Z', 'retry_scheduled', 'operator-actions-closed-dunning-cycle');
INSERT INTO public.commerce_orders (
  id, client_id, status, subtotal_cents, total_cents, mode, subscription_id, subscription_cycle_id
)
VALUES
  ('05600000-0000-4000-8000-000000000004', '05100000-0000-4000-8000-000000000001',
   'pending_payment', 1000, 1000, 'subscription_cycle',
   '05200000-0000-4000-8000-000000000004', '05300000-0000-4000-8000-000000000004'),
  ('05600000-0000-4000-8000-000000000006', '05100000-0000-4000-8000-000000000001',
   'pending_payment', 1000, 1000, 'subscription_cycle',
   '05200000-0000-4000-8000-000000000006', '05300000-0000-4000-8000-000000000006');
INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES
  ('05700000-0000-4000-8000-000000000004', '05600000-0000-4000-8000-000000000004', 'test', 'failed', 1000),
  ('05700000-0000-4000-8000-000000000006', '05600000-0000-4000-8000-000000000006', 'test', 'failed', 1000);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, status
)
VALUES
  ('05800000-0000-4000-8000-000000000004', 'subscription_cycle',
   '05600000-0000-4000-8000-000000000004', '05200000-0000-4000-8000-000000000004',
   '05300000-0000-4000-8000-000000000004', '05700000-0000-4000-8000-000000000004', 1000, 'failed'),
  ('05800000-0000-4000-8000-000000000006', 'subscription_cycle',
   '05600000-0000-4000-8000-000000000006', '05200000-0000-4000-8000-000000000006',
   '05300000-0000-4000-8000-000000000006', '05700000-0000-4000-8000-000000000006', 1000, 'failed');
INSERT INTO public.subscription_dunning_cases (
  id, subscription_id, cycle_id, order_id, payment_intent_id, client_id, status,
  retry_attempt, recovered_at
)
VALUES
  ('05900000-0000-4000-8000-000000000004', '05200000-0000-4000-8000-000000000004',
   '05300000-0000-4000-8000-000000000004', '05600000-0000-4000-8000-000000000004',
   '05800000-0000-4000-8000-000000000004', '05100000-0000-4000-8000-000000000001',
   'open', 1, NULL),
  -- Already recovered. The fence reads `status = 'open'`, not "was ever in dunning".
  ('05900000-0000-4000-8000-000000000006', '05200000-0000-4000-8000-000000000006',
   '05300000-0000-4000-8000-000000000006', '05600000-0000-4000-8000-000000000006',
   '05800000-0000-4000-8000-000000000006', '05100000-0000-4000-8000-000000000001',
   'recovered', 1, '2026-07-20T00:00:00Z');

-- An open case means recovery retry already owns this subscription's billing. Arming the
-- ordinary renewal lane beside it is the double-charge shape the delegate refuses.
CREATE TEMP TABLE _band_open_dunning AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000004'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T12:00:00Z","slideMinDays":"1"}'::jsonb, 1,
  'operator-band-open-dunning-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _band_open_dunning),
  'refused',
  'an open dunning case refuses the sub-three-day operator reschedule'
);

SELECT is(
  (SELECT response->>'refusalCode' FROM _band_open_dunning),
  'payment_blocked',
  'the band names the refusal exactly as the delegate names it for the subscriber'
);

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000004'),
  '2026-09-30T00:00:00Z'::timestamptz,
  'the refused reschedule armed no cycle beside the recovery retry'
);

SELECT is(
  (SELECT outcome || '/' || refusal_code FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-band-open-dunning-1'),
  'refused/payment_blocked',
  'the dunning refusal leaves the audit row the surface promises for every refusal'
);

-- No stored method: the renewal this would arm can only fail and open a fresh case.
CREATE TEMP TABLE _band_no_method AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000005'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T12:00:00Z","slideMinDays":"1"}'::jsonb, 1,
  'operator-band-no-method-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'refusalCode' FROM _band_no_method),
  'payment_blocked',
  'a NULL payment_method_ref refuses the sub-three-day operator reschedule'
);

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000005'),
  '2026-09-30T00:00:00Z'::timestamptz,
  'the refused reschedule armed no renewal that could only have failed'
);

SELECT is(
  (SELECT outcome || '/' || refusal_code FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-band-no-method-1'),
  'refused/payment_blocked',
  'the missing-method refusal is audited too'
);

-- The fences are the two the delegate applies and nothing wider: a closed case and a
-- stored method still admit the band.
CREATE TEMP TABLE _band_admitted AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000006'::uuid,
  'slide_next_cycle',
  '{"newNextCycleAt":"2026-08-19T12:00:00Z","slideMinDays":"1"}'::jsonb, 1,
  'operator-band-admitted-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' || '/' || (response->>'appliedBy') FROM _band_admitted),
  'applied/operator_reschedule_band',
  'a recovered case and a stored method still admit the operator band'
);

SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '05200000-0000-4000-8000-000000000006'),
  '2026-08-19T12:00:00Z'::timestamptz,
  'the admitted reschedule really moved the next cycle'
);

-- ---------------------------------------------------------------------------
-- The operator stamp attributes the operator's own act and nobody else's.
--
-- `customer-resume-key-1` above is the subscriber's own resume. An operator reusing that
-- key gets the delegate's `replayed`, and the stamp must not follow: the event ledger is
-- the only record of who acted, so re-attributing a subscriber's history is not
-- correctable afterwards.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _operator_reuses_subscriber_key AS
SELECT public.customer_support_apply_subscription_action_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05200000-0000-4000-8000-000000000001'::uuid,
  'pause', '{"pausePreset":"2_weeks"}'::jsonb, 1,
  'customer-resume-key-1', '2026-08-17T14:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _operator_reuses_subscriber_key),
  'replayed',
  'reusing a key the subscriber already used replays rather than acting'
);

SELECT is(
  (SELECT actor_kind FROM public.subscription_events
    WHERE idempotency_key = 'customer-resume-key-1'),
  NULL,
  'the subscriber event keeps its own attribution, so the ledger still answers who acted'
);

-- ---------------------------------------------------------------------------
-- The emergency email correction, and the rule that makes it safe.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _email_linked AS
SELECT public.customer_support_correct_subject_email_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05100000-0000-4000-8000-000000000001'::uuid,
  'operator-actions-linked@example.invalid',
  'operator-actions-repaired@example.invalid',
  'operator-email-linked-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

-- Re-pinned by the contact-correction wave. The linked-account refusal was removed
-- deliberately: the invariant it claimed to guard spans Postgres and the auth
-- service, and this function can see only the Postgres half, so refusing every
-- linked subject protected nothing while locking the operator out of every paying
-- customer. The caller now moves the authorization copy first. The refusal arms
-- this correction still owes, and the audit of each, are pinned in
-- `operator_contact_correction_test.sql`.
SELECT is(
  (SELECT response->>'outcome' FROM _email_linked),
  'applied',
  'correcting a linked account is admitted; the caller moves the authorization copy'
);

SELECT is(
  (SELECT email FROM public.clients WHERE id = '05100000-0000-4000-8000-000000000001'),
  'operator-actions-repaired@example.invalid',
  'the linked address moves, so the corrected value is what the subscriber receives'
);

CREATE TEMP TABLE _email_unlinked AS
SELECT public.customer_support_correct_subject_email_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05100000-0000-4000-8000-000000000002'::uuid,
  'operator-actions-unlinked@example.invalid',
  'operator-actions-fixed@example.invalid',
  'operator-email-unlinked-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _email_unlinked),
  'applied',
  'an unlinked subject can have their address repaired'
);

SELECT is(
  (SELECT email FROM public.clients WHERE id = '05100000-0000-4000-8000-000000000002'),
  'operator-actions-fixed@example.invalid',
  'the repaired address is stored'
);

SELECT is(
  (SELECT value_before || ' -> ' || value_after
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-email-unlinked-1'),
  'operator-actions-unlinked@example.invalid -> operator-actions-fixed@example.invalid',
  'the audit row carries the address before and after the repair'
);

CREATE TEMP TABLE _email_taken AS
SELECT public.customer_support_correct_subject_email_v1(
  '05a00000-0000-4000-8000-000000000001'::uuid,
  '05100000-0000-4000-8000-000000000002'::uuid,
  'operator-actions-fixed@example.invalid',
  'operator-actions-taken@example.invalid',
  'operator-email-taken-1', '2026-08-17T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'refusalCode' FROM _email_taken),
  'email_already_in_use',
  'a collision with an address already in use is a named conflict, not a raised violation'
);

-- ---------------------------------------------------------------------------
-- The ledgers are append-only for every principal a credential can reach.
--
-- This platform's default privileges grant `service_role` the whole `arwdDxtm` set on each
-- new public table, so the narrow GRANT in the forward restricts nothing and the explicit
-- REVOKE is the entire control. Prove it twice: once on the catalogue, and once by actually
-- being `service_role` and having the statement refused.
-- ---------------------------------------------------------------------------

SELECT ok(
  has_table_privilege('service_role', 'public.customer_support_subscription_audit_events', 'INSERT'),
  'service_role can still append audit rows'
);

SELECT is(
  (SELECT string_agg(privilege, ',' ORDER BY privilege)
     FROM (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('service_role', 'public.customer_support_subscription_audit_events', candidate.privilege)),
  NULL,
  'service_role holds no UPDATE, DELETE or TRUNCATE on the audit ledger'
);

SELECT is(
  (SELECT string_agg(privilege, ',' ORDER BY privilege)
     FROM (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS candidate(privilege)
    WHERE has_table_privilege('service_role', 'public.customer_support_subscription_commands', candidate.privilege)),
  NULL,
  'service_role holds no UPDATE, DELETE or TRUNCATE on the receipt ledger'
);

-- The catalogue assertions above would still pass if PostgREST reached these tables as some
-- other principal, so take the role the runtime actually uses and let the server refuse.
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$UPDATE public.customer_support_subscription_audit_events
       SET outcome = 'applied'
     WHERE idempotency_key = 'operator-stale-version-1'$$,
  '42501',
  NULL,
  'as service_role, rewriting an audit row is refused, so a conflict cannot be reinterpreted later'
);

SELECT throws_ok(
  $$DELETE FROM public.customer_support_subscription_commands
     WHERE idempotency_key = 'operator-pause-key-1'$$,
  '42501',
  NULL,
  'as service_role, deleting a command receipt is refused, so a replay cannot become a fresh command'
);

SELECT throws_ok(
  $$TRUNCATE public.customer_support_subscription_audit_events$$,
  '42501',
  NULL,
  'as service_role, truncating the audit ledger is refused - the vector a row trigger never covered'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- The operator gate itself: `communications_operator_is_active` decides every
-- assertion above, and until `20260818110000` it answered from
-- `platform_communication_operators` alone -- a table no human administrator was ever
-- written into, so the whole operator surface refused the people it was built for. The
-- arms below pin BOTH halves of the union, because dropping either one breaks a real
-- caller: without the administrator arm the admin panel is locked out again, and
-- without the table arm the second runtime (which has no `admin_users` at all) and
-- every proof fixture in `scripts/` -- each of which authorizes with a synthetic uuid --
-- lose their operator.
INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('05b00000-0000-4000-8000-000000000001', 'operator-axis-admin@example.invalid', 'admin', false),
  -- `role` is nullable with a default, so rows predating 20260329300000 can still read
  -- NULL. `is_admin_user()` coalesces them to 'admin' and so must this gate, or the
  -- oldest administrators stay locked out by exactly the bug being fixed.
  ('05b00000-0000-4000-8000-000000000002', 'operator-axis-null-role@example.invalid', NULL, false),
  ('05b00000-0000-4000-8000-000000000003', 'operator-axis-distributor@example.invalid', 'distributor', false),
  -- Actor kind is governed above this gate (flag, PII masking, audit) and deliberately
  -- carries no weight inside it; this row is what would fail if that decision were
  -- quietly reversed into a second axis.
  ('05b00000-0000-4000-8000-000000000004', 'operator-axis-machine@example.invalid', 'admin', true);

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000001'),
  true,
  'an administrator is an operator without any row in the operator table'
);

SELECT lives_ok(
  $$SELECT public.communications_require_active_operator('05b00000-0000-4000-8000-000000000001')$$,
  'the administrator passes the fence every operator RPC calls first'
);

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000002'),
  true,
  'an administrator row with a NULL role is coalesced to admin, as is_admin_user() does'
);

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000003'),
  false,
  'a distributor is not an operator - the shipping role is not the support role'
);

SELECT throws_ok(
  $$SELECT public.communications_require_active_operator('05b00000-0000-4000-8000-000000000003')$$,
  '42501',
  NULL,
  'the distributor is refused by the fence, not merely absent from the predicate'
);

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000009'),
  false,
  'a principal in neither admin_users nor the operator table is still refused - this is not a pass'
);

SELECT throws_ok(
  $$SELECT public.communications_require_active_operator('05b00000-0000-4000-8000-000000000009')$$,
  '42501',
  NULL,
  'an unknown principal keeps raising 42501, the code the routes map to FORBIDDEN'
);

SELECT is(
  public.communications_operator_is_active(NULL),
  false,
  'a NULL principal answers false rather than NULL, so no caller can read it as a pass'
);

SELECT throws_ok(
  $$SELECT public.communications_require_active_operator(NULL)$$,
  '42501',
  NULL,
  'a NULL principal is refused by the fence'
);

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000004'),
  true,
  'a machine administrator passes here; actor-kind governance lives above this gate, not in it'
);

SELECT is(
  public.communications_operator_is_active('05a00000-0000-4000-8000-000000000001'),
  true,
  'an explicit active operator row still passes although it is no administrator - the fixture and second-runtime arm'
);

SELECT is(
  public.communications_operator_is_active('05a00000-0000-4000-8000-000000000002'),
  false,
  'deactivating an explicit operator row still withdraws it, so the table arm keeps its kill-switch'
);

-- The privilege shape is asserted rather than restated: `CREATE OR REPLACE FUNCTION`
-- preserves the existing ACL, so the forward that changed this body ships no GRANT and
-- no REVOKE. These three assertions are the only thing standing between that silence
-- and an unnoticed regression.
SELECT is(
  has_function_privilege('service_role', 'public.communications_operator_is_active(uuid)', 'execute'),
  true,
  'service_role keeps EXECUTE - the only role that actually calls the gate'
);

SELECT is(
  has_function_privilege('anon', 'public.communications_operator_is_active(uuid)', 'execute'),
  false,
  'anon still holds no EXECUTE on the gate'
);

SELECT is(
  has_function_privilege('authenticated', 'public.communications_operator_is_active(uuid)', 'execute'),
  false,
  'authenticated still holds no EXECUTE on the gate'
);

-- Everything above ran as the superuser owner, which reads `admin_users` regardless of
-- row-level security. The gate is invoker-rights, so the assertion that matters is
-- whether the role the runtime actually connects as can read the roster through it.
SET LOCAL ROLE service_role;

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000001'),
  true,
  'as service_role, the invoker-rights gate reads the admin roster - no definer rights needed'
);

SELECT is(
  public.communications_operator_is_active('05b00000-0000-4000-8000-000000000009'),
  false,
  'as service_role, an unknown principal is still refused - the pass is not a privilege artefact'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
