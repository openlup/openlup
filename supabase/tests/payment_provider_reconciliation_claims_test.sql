-- pgTAP: payment-provider reconciliation claims stale active one-time and
-- subscription-cycle attempts and never re-claims terminally corrected work.

BEGIN;
SELECT plan(22);
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;

SELECT ok(
  (SELECT indexdef LIKE '%(payment_attempt_id, checked_at DESC)%'
     FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_commerce_payment_reconciliation_runs_payment_attempt_id'),
  'fairness lookup uses the replacement attempt plus checked-at index'
);

INSERT INTO public.clients (id, email)
VALUES ('d1100000-0000-4000-8000-000000000001', 'payment-reconcile-claim@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d1500000-0000-4000-8000-000000000001', 'payment-reconcile-claim-product', 'Reconcile Claim Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES (
  'd1600000-0000-4000-8000-000000000001',
  'd1500000-0000-4000-8000-000000000001',
  'RECONCILE-CLAIM-SKU',
  'Reconcile Claim SKU',
  'dog',
  400,
  350,
  'active'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_kind, payment_method_ref
) VALUES (
  'd1200000-0000-4000-8000-000000000001',
  'd1100000-0000-4000-8000-000000000001',
  28,
  'PLN',
  'active',
  '2026-07-01T10:00:00Z',
  'card',
  'pm_reconcile_claim'
);

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES (
  'd1200000-0000-4000-8000-000000000001',
  'd1600000-0000-4000-8000-000000000001',
  1,
  0,
  false,
  1
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, template_snapshot,
  pricing_snapshot, payment_method_ref, engine_idempotency_key
) VALUES (
  'd1300000-0000-4000-8000-000000000001',
  'd1200000-0000-4000-8000-000000000001',
  2,
  '2026-07-01T10:00:00Z',
  'payment_pending',
  public.subscription_current_template_snapshot('d1200000-0000-4000-8000-000000000001'),
  '{}'::jsonb,
  'pm_reconcile_claim',
  'payment-reconcile-claim-cycle-0001'
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents,
  mode, subscription_id, subscription_cycle_id
) VALUES (
  'd1400000-0000-4000-8000-000000000001',
  'd1100000-0000-4000-8000-000000000001',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":28}'::jsonb,
  'draft',
  1299, 1299,
  'subscription_cycle',
  'd1200000-0000-4000-8000-000000000001',
  'd1300000-0000-4000-8000-000000000001'
);

UPDATE public.subscription_cycles
   SET order_id = 'd1400000-0000-4000-8000-000000000001'
 WHERE id = 'd1300000-0000-4000-8000-000000000001';

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'payment-reconcile-claim-intent-0001',
  'subscription_cycle',
  'd1400000-0000-4000-8000-000000000001',
  'd1200000-0000-4000-8000-000000000001',
  'd1300000-0000-4000-8000-000000000001',
  1299,
  'PLN',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'payment-reconcile-claim-attempt-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  'pi_reconcile_claim',
  'pi_reconcile_claim',
  'processing',
  NULL,
  '{"providerFlow":"off_session_payment"}'::jsonb,
  '{"providerStatus":"processing"}'::jsonb
) -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id;

UPDATE public.commerce_payment_attempts
   SET updated_at = '2026-07-03T09:30:00Z'::timestamptz
 WHERE id = (SELECT attempt_id FROM _attempt);
UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T09:30:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _intent);

UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T09:55:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _intent);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_stale_attempts(
       '2026-07-03T10:00:00Z'::timestamptz,
       900,
       10,
       'payment-reconcile-claim-run-fresh-intent'::text
     )),
  0,
  'does not claim when the linked payment intent was updated inside the stale window');

UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T09:30:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _intent);

CREATE TEMP TABLE _claimed AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_stale_attempts(
    '2026-07-03T10:00:00Z'::timestamptz,
    900,
    10,
    'payment-reconcile-claim-run-0001'::text
  );

SELECT is((SELECT count(*)::int FROM _claimed), 1, 'claims one stale active subscription-cycle attempt');

SELECT is(
  (SELECT provider_payment_id FROM _claimed),
  'pi_reconcile_claim',
  'Stripe claim uses the provider attempt/payment-intent id for readback');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_runs
    WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt)
      AND provider_status = 'claiming'
      AND correction_status = 'observed'),
  1,
  'claim records reconciliation evidence for audit/freshness');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_stale_attempts(
       '2026-07-03T10:00:00Z'::timestamptz,
       900,
       10,
       'payment-reconcile-claim-run-0001'::text
     )),
  0,
  'same claim key is idempotent and does not return the attempt again');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_stale_attempts(
       '2026-07-03T10:30:00Z'::timestamptz,
       900,
       10,
       'payment-reconcile-claim-run-0002'::text
     )),
  1,
  'a still-pending attempt can be rechecked by a later reconciliation run');

SELECT public.commerce_payment_control_record_reconciliation(
  'payment-reconcile-claim-corrected-0001',
  'stripe',
  'pi_reconcile_claim',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'processing',
  'succeeded',
  'corrected',
  '2026-07-03T10:31:00Z'::timestamptz,
  '{"source":"test"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_stale_attempts(
       '2026-07-03T11:00:00Z'::timestamptz,
       900,
       10,
       'payment-reconcile-claim-run-0003'::text
     )),
  0,
  'terminally corrected attempts are not re-claimed');

-- One-time orders use the same provider readback and atomic apply path.
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode
) VALUES (
  'd1400000-0000-4000-8000-000000000002',
  'd1100000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft',
  1399, 1399, 'one_time'
);

CREATE TEMP TABLE _one_time_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'payment-reconcile-one-time-intent-0001',
  'one_time_order',
  'd1400000-0000-4000-8000-000000000002',
  NULL, NULL, 1399, 'PLN', '{}'::jsonb
) AS response) s;

CREATE TEMP TABLE _one_time_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'payment-reconcile-one-time-attempt-0001',
  (SELECT intent_id FROM _one_time_intent),
  'stripe', 'pi_reconcile_one_time', 'pi_reconcile_one_time',
  'processing', NULL,
  '{"providerFlow":"one_time_payment"}'::jsonb,
  '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

UPDATE public.commerce_payment_attempts
   SET updated_at = '2026-07-03T11:00:00Z'::timestamptz
 WHERE id = (SELECT attempt_id FROM _one_time_attempt);
UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T11:00:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _one_time_intent);

CREATE TEMP TABLE _one_time_claimed AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_stale_attempts(
    '2026-07-03T11:30:00Z'::timestamptz,
    900,
    10,
    'payment-reconcile-one-time-claim-0001'
  );

SELECT is((SELECT count(*)::int FROM _one_time_claimed), 1, 'claims one stale active one-time attempt');

SELECT ok(
  (SELECT order_mode = 'one_time'
      AND subscription_id IS NULL
      AND subscription_cycle_id IS NULL
      AND cycle_retry_attempt = 0
     FROM _one_time_claimed),
  'one-time claims preserve the exact null subscription context'
);

SELECT is(
  (SELECT provider_payment_id FROM _one_time_claimed),
  'pi_reconcile_one_time',
  'one-time readback receives the finalized provider payment id'
);

CREATE TEMP TABLE _one_time_applied AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'payment-reconcile-one-time-apply-0001',
  'd1400000-0000-4000-8000-000000000002',
  (SELECT intent_id FROM _one_time_intent),
  (SELECT attempt_id FROM _one_time_attempt),
  (SELECT payment_id FROM _one_time_intent),
  'stripe', 'pi_reconcile_one_time', 'processing', 'succeeded', 'succeeded',
  '2026-07-03T11:31:00Z', NULL, '2026-07-03T11:31:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,correctionStatus}' FROM _one_time_applied),
  'corrected',
  'one-time terminal readback applies through the existing atomic boundary'
);

CREATE TEMP TABLE _one_time_replay AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'payment-reconcile-one-time-apply-0001',
  'd1400000-0000-4000-8000-000000000002',
  (SELECT intent_id FROM _one_time_intent),
  (SELECT attempt_id FROM _one_time_attempt),
  (SELECT payment_id FROM _one_time_intent),
  'stripe', 'pi_reconcile_one_time', 'processing', 'succeeded', 'succeeded',
  '2026-07-03T11:31:00Z', NULL, '2026-07-03T11:31:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT ok(
  (SELECT (result #>> '{paymentReconciliationApply,replayed}')::boolean FROM _one_time_replay),
  'one-time terminal apply is exactly replayable'
);

-- More finalized candidates than one batch rotate by the existing run ledger:
-- never-checked first, then least-recently checked. This prevents an old
-- nonterminal row from starving later provider readbacks forever.
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode
) VALUES
  (
    'd1400000-0000-4000-8000-000000000003',
    'd1100000-0000-4000-8000-000000000001',
    'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft',
    1499, 1499, 'one_time'
  ),
  (
    'd1400000-0000-4000-8000-000000000004',
    'd1100000-0000-4000-8000-000000000001',
    'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft',
    1599, 1599, 'one_time'
  );

CREATE TEMP TABLE _one_time_failed_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'payment-reconcile-one-time-failed-intent-0001',
  'one_time_order', 'd1400000-0000-4000-8000-000000000003',
  NULL, NULL, 1499, 'PLN', '{}'::jsonb
) AS response) s;

CREATE TEMP TABLE _one_time_failed_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'payment-reconcile-one-time-failed-attempt-0001',
  (SELECT intent_id FROM _one_time_failed_intent),
  'stripe', 'pi_reconcile_one_time_failed', 'pi_reconcile_one_time_failed',
  'processing', NULL,
  '{"providerFlow":"one_time_payment"}'::jsonb,
  '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

CREATE TEMP TABLE _one_time_tpay_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'payment-reconcile-one-time-tpay-intent-0001',
  'one_time_order', 'd1400000-0000-4000-8000-000000000004',
  NULL, NULL, 1599, 'PLN', '{}'::jsonb
) AS response) s;

CREATE TEMP TABLE _one_time_tpay_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'payment-reconcile-one-time-tpay-attempt-0001',
  (SELECT intent_id FROM _one_time_tpay_intent),
  'tpay', 'tpay_attempt_fallback', 'tpay_session_primary',
  'processing', NULL,
  '{"providerFlow":"one_time_payment"}'::jsonb,
  '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

UPDATE public.commerce_payment_attempts
   SET updated_at = CASE
     WHEN id = (SELECT attempt_id FROM _one_time_failed_attempt)
       THEN '2026-07-03T12:00:00Z'::timestamptz
     ELSE '2026-07-03T12:05:00Z'::timestamptz
   END
 WHERE id IN (
   (SELECT attempt_id FROM _one_time_failed_attempt),
   (SELECT attempt_id FROM _one_time_tpay_attempt)
 );
UPDATE public.commerce_payment_intents
   SET updated_at = CASE
     WHEN id = (SELECT intent_id FROM _one_time_failed_intent)
       THEN '2026-07-03T12:00:00Z'::timestamptz
     ELSE '2026-07-03T12:05:00Z'::timestamptz
   END
 WHERE id IN (
   (SELECT intent_id FROM _one_time_failed_intent),
   (SELECT intent_id FROM _one_time_tpay_intent)
 );

CREATE TEMP TABLE _fairness_first AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_stale_attempts(
    '2026-07-03T12:30:00Z', 900, 1, 'payment-reconcile-fairness-0001'
  );

SELECT is(
  (SELECT payment_attempt_id FROM _fairness_first),
  (SELECT attempt_id FROM _one_time_failed_attempt),
  'first bounded claim visits the oldest never-checked finalized attempt'
);

CREATE TEMP TABLE _fairness_second AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_stale_attempts(
    '2026-07-03T12:31:00Z', 900, 1, 'payment-reconcile-fairness-0002'
  );

SELECT is(
  (SELECT payment_attempt_id FROM _fairness_second),
  (SELECT attempt_id FROM _one_time_tpay_attempt),
  'a second bounded claim visits the never-checked finalized attempt beyond the first batch'
);

SELECT is(
  (SELECT provider_payment_id FROM _fairness_second),
  'tpay_session_primary',
  'Tpay one-time readback prefers provider_session_id over fallback references'
);

CREATE TEMP TABLE _one_time_failed_applied AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'payment-reconcile-one-time-failed-apply-0001',
  'd1400000-0000-4000-8000-000000000003',
  (SELECT intent_id FROM _one_time_failed_intent),
  (SELECT attempt_id FROM _one_time_failed_attempt),
  (SELECT payment_id FROM _one_time_failed_intent),
  'stripe', 'pi_reconcile_one_time_failed', 'processing', 'failed', 'failed',
  '2026-07-03T12:32:00Z', 'card_declined', '2026-07-03T12:32:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,correctionStatus}' FROM _one_time_failed_applied),
  'corrected',
  'one-time terminal failure applies through the existing atomic boundary'
);

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,subscriptionWebhookDunning,reason}'
     FROM _one_time_failed_applied),
  'not_subscription_cycle',
  'one-time terminal failure is an explicit subscription-dunning no-op'
);

CREATE TEMP TABLE _one_time_failed_replay AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'payment-reconcile-one-time-failed-apply-0001',
  'd1400000-0000-4000-8000-000000000003',
  (SELECT intent_id FROM _one_time_failed_intent),
  (SELECT attempt_id FROM _one_time_failed_attempt),
  (SELECT payment_id FROM _one_time_failed_intent),
  'stripe', 'pi_reconcile_one_time_failed', 'processing', 'failed', 'failed',
  '2026-07-03T12:32:00Z', 'card_declined', '2026-07-03T12:32:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT ok(
  (SELECT (result #>> '{paymentReconciliationApply,applyReplayed}')::boolean
      AND (result #>> '{paymentReconciliationApply,evidenceReplayed}')::boolean
     FROM _one_time_failed_replay),
  'one-time terminal failure replays payment state and evidence exactly'
);

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases),
  0,
  'one-time failure and replay create no subscription dunning case'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.outbox_events
    WHERE event_type = 'commerce.payment.failed'
      AND aggregate_id = 'd1400000-0000-4000-8000-000000000003'),
  1,
  'one-time failure replay does not duplicate customer communication'
);

-- Terminalize the Tpay fixture so the final no-reclaim assertion remains exact.
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'payment-reconcile-one-time-tpay-apply-0001',
  'd1400000-0000-4000-8000-000000000004',
  (SELECT intent_id FROM _one_time_tpay_intent),
  (SELECT attempt_id FROM _one_time_tpay_attempt),
  (SELECT payment_id FROM _one_time_tpay_intent),
  'tpay', 'tpay_session_primary', 'processing', 'succeeded', 'succeeded',
  '2026-07-03T12:33:00Z', NULL, '2026-07-03T12:33:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_stale_attempts(
       '2026-07-03T13:00:00Z'::timestamptz,
       900,
       10,
       'payment-reconcile-one-time-claim-0002'
     )),
  0,
  'corrected one-time attempts are not claimed again'
);

SELECT * FROM finish();
ROLLBACK;
