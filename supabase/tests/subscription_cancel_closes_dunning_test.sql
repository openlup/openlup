-- pgTAP: customer cancellation atomically terminates an open dunning journey.

BEGIN;
SELECT plan(24);

INSERT INTO auth.users (id)
VALUES ('ca000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  'ca100000-0000-4000-8000-000000000001',
  'cancel-dunning@example.invalid',
  'ca000000-0000-4000-8000-000000000001'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  'ca200000-0000-4000-8000-000000000001',
  'ca100000-0000-4000-8000-000000000001',
  30, 'PLN', 'active',
  '2026-06-01T00:00:00Z', '2026-08-01T00:00:00Z',
  'pm_cancel_dunning', 'card'
);

-- This subscription is cancelled and then reactivated (cancelled -> active),
-- which trg_subscription_guard_active_requires_lines (20260801120100) rejects for
-- a line-less subscription. Cancellation never deletes subscription_lines in
-- production, so a real reactivation always has its template.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('ca400000-0000-4000-8000-000000000001', 'cancel-dunning-product', 'Cancel Dunning Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('ca500000-0000-4000-8000-000000000001', 'ca400000-0000-4000-8000-000000000001', 'CANCEL-DUNNING-SKU', 'Cancel Dunning SKU', 'dog', 'active', 400, 350);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('ca200000-0000-4000-8000-000000000001', 'ca500000-0000-4000-8000-000000000001', 1, 0, false, 1);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt, next_retry_at
)
VALUES (
  'ca300000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  2, '2026-07-20T00:00:00Z', 'retry_scheduled',
  'cancel-dunning-cycle', 1, '2026-08-01T00:00:00Z'
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
)
VALUES (
  'ca400000-0000-4000-8000-000000000001',
  'ca100000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":30}'::jsonb,
  'pending_payment', 12999, 12999, 'subscription_cycle',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001'
);

CREATE TEMP TABLE _cancel_dunning_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'cancel-dunning-intent',
  'subscription_cycle',
  'ca400000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  12999,
  'PLN',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.subscription_handle_payment_failure_dunning(
  'cancel-dunning-open',
  'ca300000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca400000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _cancel_dunning_intent),
  1,
  '2026-08-01T00:00:00Z'::timestamptz,
  'card_declined',
  '2026-07-20T12:00:00Z'::timestamptz
);

CREATE TEMP TABLE _cancel_dunning_case AS
SELECT id
  FROM public.subscription_dunning_cases
 WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001'
   AND status = 'open';

UPDATE public.subscription_payment_recovery_tokens
   SET token_hash = encode(sha256(convert_to('cancel-dunning-raw-token', 'UTF8')), 'hex')
 WHERE case_id = (SELECT id FROM _cancel_dunning_case)
   AND used_at IS NULL;

SELECT public.commerce_payment_control_prepare_provider_attempt(
  'cancel-dunning-active-attempt',
  (SELECT intent_id FROM _cancel_dunning_intent),
  'stripe',
  'cancel-dunning-provider-key',
  'cancel-dunning-request-fingerprint',
  'off_session_payment',
  'pm_cancel_dunning',
  '{}'::jsonb
);

CREATE TEMP TABLE _cancel_dunning_attempt AS
SELECT active_attempt_id AS attempt_id
  FROM public.commerce_payment_intents
 WHERE id = (SELECT intent_id FROM _cancel_dunning_intent);

-- The aggregate fence must inspect every nonterminal attempt, not trust a
-- potentially stale denormalized active pointer.
UPDATE public.commerce_payment_intents
   SET active_attempt_id = NULL
 WHERE id = (SELECT intent_id FROM _cancel_dunning_intent);

SELECT throws_ok(
  $q$
    SELECT public.customer_self_service_apply_subscription_action(
      'ca000000-0000-4000-8000-000000000001',
      'cancel-dunning-blocked-action',
      'ca200000-0000-4000-8000-000000000001',
      'cancel',
      '{"reason":"customer_cancelled"}'::jsonb,
      '2026-07-21T08:59:00Z'::timestamptz
    )
  $q$,
  'customer_self_service_payment_blocked',
  'cancel is blocked while any renewal provider attempt is nonterminal'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'ca200000-0000-4000-8000-000000000001'),
  'active',
  'blocked cancellation leaves the subscription active'
);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases WHERE id = (SELECT id FROM _cancel_dunning_case)),
  'open',
  'blocked cancellation does not partially close dunning'
);

UPDATE public.commerce_payment_intents
   SET active_attempt_id = (SELECT attempt_id FROM _cancel_dunning_attempt)
 WHERE id = (SELECT intent_id FROM _cancel_dunning_intent);

UPDATE public.commerce_payment_attempts payment_attempt
   SET status = 'failed',
       failure_reason = 'test_terminalized_before_cancel',
       updated_at = '2026-07-21T08:59:30Z'::timestamptz
  FROM public.commerce_payment_intents payment_intent
 WHERE payment_intent.id = (SELECT intent_id FROM _cancel_dunning_intent)
   AND payment_attempt.id = payment_intent.active_attempt_id;

SELECT lives_ok(
  $q$
    SELECT public.customer_self_service_apply_subscription_action(
      'ca000000-0000-4000-8000-000000000001',
      'cancel-dunning-customer-action',
      'ca200000-0000-4000-8000-000000000001',
      'cancel',
      '{"reason":"customer_cancelled"}'::jsonb,
      '2026-07-21T09:00:00Z'::timestamptz
    )
  $q$,
  'customer can cancel while dunning is open'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = 'ca200000-0000-4000-8000-000000000001'),
  'cancelled',
  'canonical self-service mutation cancels the subscription'
);

SELECT is(
  (SELECT status FROM public.subscription_dunning_cases WHERE id = (SELECT id FROM _cancel_dunning_case)),
  'cancelled',
  'open dunning case is terminalized as cancelled, not falsely recovered'
);

SELECT throws_ok(
  $q$
    SELECT public.commerce_payment_control_prepare_provider_attempt(
      'cancel-dunning-attempt-after-cancel',
      (SELECT intent_id FROM _cancel_dunning_intent),
      'stripe',
      'cancel-dunning-provider-after-cancel',
      'cancel-dunning-fingerprint-after-cancel',
      'off_session_payment',
      'pm_after_cancel',
      '{}'::jsonb
    )
  $q$,
  'payment_control_provider_attempt_prepare_intent_not_retryable',
  'a confirmed cancellation leaves no retryable payment intent'
);

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'ca300000-0000-4000-8000-000000000001'),
  'cancelled',
  'the failed renewal cycle is terminalized with the subscription'
);

SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles WHERE id = 'ca300000-0000-4000-8000-000000000001'),
  NULL,
  'the cancelled cycle cannot become due after reactivation'
);

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'ca400000-0000-4000-8000-000000000001'),
  'cancelled',
  'the unpaid renewal order is terminalized'
);

SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _cancel_dunning_intent)),
  'cancelled',
  'the unpaid renewal intent is terminalized'
);

SELECT ok(
  (SELECT revoked_at IS NOT NULL
     FROM public.subscription_payment_recovery_tokens
    WHERE case_id = (SELECT id FROM _cancel_dunning_case)
      AND token_hash = encode(sha256(convert_to('cancel-dunning-raw-token', 'UTF8')), 'hex')),
  'unused recovery token is revoked'
);

SELECT is(
  (SELECT status
     FROM public.subscription_dunning_notifications
    WHERE case_id = (SELECT id FROM _cancel_dunning_case)
      AND recipient_kind = 'customer'
    ORDER BY created_at
    LIMIT 1),
  'skipped',
  'queued customer dunning notification is suppressed'
);

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0,
  'cancelled dunning notifications cannot be claimed'
);

SELECT throws_ok(
  $q$
    SELECT public.subscription_record_payment_recovery_request(
      'cancel-dunning-redeem',
      'cancel-dunning-raw-token',
      'pm_after_cancel',
      'stripe_payment_method',
      '2026-07-21T09:01:00Z'::timestamptz
    )
  $q$,
  'subscription_payment_recovery_token_invalid',
  'cancelled dunning recovery token cannot be redeemed'
);

CREATE TEMP TABLE _cancel_dunning_counts AS
SELECT
  (SELECT count(*) FROM public.subscription_payment_recovery_tokens
    WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001') AS token_count,
  (SELECT count(*) FROM public.subscription_dunning_notifications
    WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001') AS notification_count;

SELECT throws_ok(
  $q$
    SELECT public.subscription_handle_payment_failure_dunning(
      'cancel-dunning-late-decline',
      'ca300000-0000-4000-8000-000000000001',
      'ca200000-0000-4000-8000-000000000001',
      'ca400000-0000-4000-8000-000000000001',
      (SELECT intent_id FROM _cancel_dunning_intent),
      2,
      '2026-08-04T00:00:00Z'::timestamptz,
      'late_provider_decline',
      '2026-07-21T09:02:00Z'::timestamptz
    )
  $q$,
  'subscription_dunning_subscription_cancelled',
  'late decline cannot reopen dunning after cancellation wins the lock'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_dunning_cases
    WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001'
      AND status = 'open'),
  0,
  'late decline leaves no open dunning case'
);

SELECT is(
  (SELECT count(*) FROM public.subscription_payment_recovery_tokens
    WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001'),
  (SELECT token_count FROM _cancel_dunning_counts),
  'late decline creates no new recovery token'
);

SELECT is(
  (SELECT count(*) FROM public.subscription_dunning_notifications
    WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001'),
  (SELECT notification_count FROM _cancel_dunning_counts),
  'late decline creates no new dunning notification'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_events
    WHERE subscription_id = 'ca200000-0000-4000-8000-000000000001'
      AND event_type = 'subscription.customer_self_service.cancel'
      AND idempotency_key = 'cancel-dunning-customer-action'),
  1,
  'canonical cancellation event remains the source of truth'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.subscription_handle_payment_failure_dunning_before_cancel_fence(text,uuid,uuid,uuid,uuid,integer,timestamptz,text,timestamptz)',
    'EXECUTE'
  ),
  'service role cannot bypass the cancelled-subscription dunning fence'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.customer_self_service_apply_action_before_dunning_cancel(uuid,text,uuid,text,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'service role cannot bypass cancel/dunning atomicity'
);

SELECT lives_ok(
  $q$
    SELECT public.customer_self_service_apply_subscription_action(
      'ca000000-0000-4000-8000-000000000001',
      'cancel-dunning-reactivate',
      'ca200000-0000-4000-8000-000000000001',
      'reactivate',
      '{"confirmedChargeTiming":true}'::jsonb,
      '2026-07-22T09:00:00Z'::timestamptz
    )
  $q$,
  'customer can reactivate without resurrecting the cancelled retry cycle'
);

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'ca300000-0000-4000-8000-000000000001'),
  'cancelled',
  'reactivation keeps the old failed cycle terminal'
);

SELECT * FROM finish();
ROLLBACK;
