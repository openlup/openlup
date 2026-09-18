-- pgTAP: terminal provider reconciliation commits payment state, renewal
-- dunning, customer notification, and evidence as one idempotent transaction.

BEGIN;
SELECT plan(34);

INSERT INTO public.clients (id, email)
VALUES ('c1000000-0000-4000-8000-000000000001', 'payment-atomic@example.invalid');

-- Successful one-time reconciliation and exact replay.
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode
) VALUES (
  'c1100000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft',
  1299, 1299, 'one_time'
);

CREATE TEMP TABLE _success_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'atomic-success-intent-0001',
  'one_time_order',
  'c1100000-0000-4000-8000-000000000001',
  NULL, NULL, 1299, 'PLN', '{}'::jsonb
) AS response) s;

CREATE TEMP TABLE _success_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'atomic-success-attempt-0001',
  (SELECT intent_id FROM _success_intent),
  'stripe', 'pi_atomic_success', 'pi_atomic_success', 'processing', NULL,
  '{}'::jsonb, '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

CREATE TEMP TABLE _success_result AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'atomic-success-apply-0001',
  'c1100000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _success_intent),
  (SELECT attempt_id FROM _success_attempt),
  (SELECT payment_id FROM _success_intent),
  'stripe', 'pi_atomic_success', 'processing', 'succeeded', 'succeeded',
  '2026-07-16T08:00:00Z', NULL, '2026-07-16T08:01:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,correctionStatus}' FROM _success_result),
  'corrected',
  'successful reconciliation reports a corrected terminal result'
);
SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = 'c1100000-0000-4000-8000-000000000001'),
  'paid',
  'successful reconciliation pays the order'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'atomic-success-apply-0001:evidence'),
  1,
  'successful reconciliation records one evidence row'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_state_transitions
    WHERE idempotency_key = 'atomic-success-apply-0001:payment_result'),
  1,
  'successful reconciliation records one payment result transition'
);

CREATE TEMP TABLE _success_replay AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'atomic-success-apply-0001',
  'c1100000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _success_intent),
  (SELECT attempt_id FROM _success_attempt),
  (SELECT payment_id FROM _success_intent),
  'stripe', 'pi_atomic_success', 'processing', 'succeeded', 'succeeded',
  '2026-07-16T08:00:00Z', NULL, '2026-07-16T08:01:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT ok(
  (SELECT (result #>> '{paymentReconciliationApply,replayed}')::boolean FROM _success_replay),
  'an exact terminal replay is reported as fully replayed'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'atomic-success-apply-0001:evidence'),
  1,
  'exact replay does not duplicate evidence'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_state_transitions
    WHERE idempotency_key = 'atomic-success-apply-0001:payment_result'),
  1,
  'exact replay does not duplicate payment transitions'
);

SELECT throws_ok(
  $$SELECT public.commerce_payment_control_apply_reconciliation_result(
    'atomic-success-apply-0001',
    'c1100000-0000-4000-8000-000000000001',
    (SELECT intent_id FROM _success_intent),
    (SELECT attempt_id FROM _success_attempt),
    (SELECT payment_id FROM _success_intent),
    'stripe', 'pi_atomic_success', 'processing', 'succeeded', 'succeeded',
    '2026-07-16T08:00:00Z', NULL, '2026-07-16T08:01:00Z',
    '{"source":"changed"}'::jsonb
  )$$,
  '23505',
  'payment_reconciliation_apply_evidence_conflict',
  'same apply key rejects changed evidence instead of silently overwriting it'
);
SELECT is(
  (SELECT payload ->> 'source' FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'atomic-success-apply-0001:evidence'),
  'payment-provider-reconciliation.v0',
  'evidence conflict preserves the original evidence'
);
SELECT throws_ok(
  $$SELECT public.commerce_payment_control_apply_reconciliation_result(
    'atomic-success-apply-0001',
    'c1100000-0000-4000-8000-000000000001',
    (SELECT intent_id FROM _success_intent),
    (SELECT attempt_id FROM _success_attempt),
    (SELECT payment_id FROM _success_intent),
    'stripe', 'pi_atomic_success', 'processing', 'succeeded', 'succeeded',
    '2026-07-16T08:00:01Z', NULL, '2026-07-16T08:01:00Z',
    '{"source":"payment-provider-reconciliation.v0"}'::jsonb
  )$$,
  '23505',
  'payment_control_result_idempotency_conflict',
  'same apply key rejects a changed payment-result fingerprint'
);

-- Active renewal failure opens dunning and its customer notification once.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) VALUES (
  'c1200000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  28, 'PLN', 'active', '2026-05-01T00:00:00Z', '2026-07-01T00:00:00Z'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'c1300000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-000000000001',
  2, '2026-07-01T00:00:00Z', 'planned',
  'atomic-failed-cycle-0001', 0
);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'c1400000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":28}'::jsonb, 'draft',
  2499, 2499, 'subscription_cycle',
  'c1200000-0000-4000-8000-000000000001',
  'c1300000-0000-4000-8000-000000000001'
);
CREATE TEMP TABLE _failed_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'atomic-failed-intent-0001', 'subscription_cycle',
  'c1400000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-000000000001',
  'c1300000-0000-4000-8000-000000000001',
  2499, 'PLN', '{}'::jsonb
) AS response) s;
CREATE TEMP TABLE _failed_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'atomic-failed-attempt-0001',
  (SELECT intent_id FROM _failed_intent),
  'stripe', 'pi_atomic_failed', 'pi_atomic_failed', 'processing', NULL,
  '{}'::jsonb, '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

CREATE TEMP TABLE _failed_result AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'atomic-failed-apply-0001',
  'c1400000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _failed_intent),
  (SELECT attempt_id FROM _failed_attempt),
  (SELECT payment_id FROM _failed_intent),
  'stripe', 'pi_atomic_failed', 'processing', 'failed', 'failed',
  '2026-07-16T09:00:00Z', 'card_declined', '2026-07-16T09:01:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,subscriptionWebhookDunning,opened}'
    FROM _failed_result),
  'true',
  'active renewal failure opens dunning inside the atomic call'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _failed_attempt)),
  'failed',
  'active renewal failure terminalizes the claimed attempt'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'atomic-failed-apply-0001:evidence'),
  1,
  'active renewal failure records one evidence row'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  1,
  'active renewal failure creates one dunning case'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'
      AND recipient_kind = 'customer'),
  1,
  'active renewal failure queues one customer notification'
);

CREATE TEMP TABLE _failed_replay AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'atomic-failed-apply-0001',
  'c1400000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _failed_intent),
  (SELECT attempt_id FROM _failed_attempt),
  (SELECT payment_id FROM _failed_intent),
  'stripe', 'pi_atomic_failed', 'processing', 'failed', 'failed',
  '2026-07-16T09:00:00Z', 'card_declined', '2026-07-16T09:01:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;
SELECT ok(
  (SELECT (result #>> '{paymentReconciliationApply,replayed}')::boolean FROM _failed_replay),
  'active renewal failure replays as one atomic result'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'),
  1,
  'failed replay does not duplicate the dunning case'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000001'
      AND recipient_kind = 'customer'),
  1,
  'failed replay does not duplicate the customer notification'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'atomic-failed-apply-0001:evidence'),
  1,
  'failed replay does not duplicate evidence'
);

-- Inject a failure at the final evidence write. Every earlier state change rolls back.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) VALUES (
  'c1200000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000001',
  28, 'PLN', 'active', '2026-05-01T00:00:00Z', '2026-07-02T00:00:00Z'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'c1300000-0000-4000-8000-000000000002',
  'c1200000-0000-4000-8000-000000000002',
  2, '2026-07-02T00:00:00Z', 'planned',
  'atomic-rollback-cycle-0001', 0
);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'c1400000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":28}'::jsonb, 'draft',
  2599, 2599, 'subscription_cycle',
  'c1200000-0000-4000-8000-000000000002',
  'c1300000-0000-4000-8000-000000000002'
);
CREATE TEMP TABLE _rollback_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'atomic-rollback-intent-0001', 'subscription_cycle',
  'c1400000-0000-4000-8000-000000000002',
  'c1200000-0000-4000-8000-000000000002',
  'c1300000-0000-4000-8000-000000000002',
  2599, 'PLN', '{}'::jsonb
) AS response) s;
CREATE TEMP TABLE _rollback_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'atomic-rollback-attempt-0001',
  (SELECT intent_id FROM _rollback_intent),
  'stripe', 'pi_atomic_rollback', 'pi_atomic_rollback', 'processing', NULL,
  '{}'::jsonb, '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

CREATE FUNCTION pg_temp.fail_atomic_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.idempotency_key = 'atomic-rollback-apply-0001:evidence' THEN
    RAISE EXCEPTION 'injected_atomic_evidence_failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_atomic_evidence_failure
BEFORE INSERT ON public.commerce_payment_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_atomic_evidence_insert();

SELECT throws_ok(
  $$SELECT public.commerce_payment_control_apply_reconciliation_result(
    'atomic-rollback-apply-0001',
    'c1400000-0000-4000-8000-000000000002',
    (SELECT intent_id FROM _rollback_intent),
    (SELECT attempt_id FROM _rollback_attempt),
    (SELECT payment_id FROM _rollback_intent),
    'stripe', 'pi_atomic_rollback', 'processing', 'failed', 'failed',
    '2026-07-16T10:00:00Z', 'card_declined', '2026-07-16T10:01:00Z',
    '{"source":"payment-provider-reconciliation.v0"}'::jsonb
  )$$,
  'P0001',
  'injected_atomic_evidence_failure',
  'failure at the final evidence insert aborts the atomic result'
);
DROP TRIGGER payment_atomic_evidence_failure ON public.commerce_payment_reconciliation_runs;

SELECT is(
  (SELECT status FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _rollback_attempt)),
  'processing',
  'evidence failure rolls back the payment-attempt terminalization'
);
SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = 'c1400000-0000-4000-8000-000000000002'),
  'pending_payment',
  'evidence failure rolls back the order result'
);
SELECT is(
  (SELECT status FROM public.subscription_cycles
    WHERE id = 'c1300000-0000-4000-8000-000000000002'),
  'planned',
  'evidence failure rolls back the renewal retry state'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  0,
  'evidence failure rolls back the dunning case'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_notifications
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  0,
  'evidence failure rolls back the customer-notification outbox'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'atomic-rollback-apply-0001:evidence'),
  0,
  'evidence failure leaves no evidence row'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE cycle_id = 'c1300000-0000-4000-8000-000000000002'),
  0,
  'evidence failure rolls back the renewal event'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.payment_result.apply'
      AND idempotency_key = 'atomic-rollback-apply-0001'),
  0,
  'evidence failure rolls back the apply key so a safe retry is not blocked'
);

-- A stale claim must not be allowed to commit payment state.
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode
) VALUES (
  'c1100000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft',
  1399, 1399, 'one_time'
);
CREATE TEMP TABLE _stale_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'atomic-stale-intent-0001', 'one_time_order',
  'c1100000-0000-4000-8000-000000000002',
  NULL, NULL, 1399, 'PLN', '{}'::jsonb
) AS response) s;
CREATE TEMP TABLE _stale_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'atomic-stale-attempt-0001',
  (SELECT intent_id FROM _stale_intent),
  'stripe', 'pi_atomic_stale', 'pi_atomic_stale', 'processing', NULL,
  '{}'::jsonb, '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

SELECT throws_ok(
  $$SELECT public.commerce_payment_control_apply_reconciliation_result(
    'atomic-stale-apply-0001',
    'c1100000-0000-4000-8000-000000000002',
    (SELECT intent_id FROM _stale_intent),
    'c1ff0000-0000-4000-8000-000000000001',
    (SELECT payment_id FROM _stale_intent),
    'stripe', 'pi_atomic_stale', 'processing', 'succeeded', 'succeeded',
    '2026-07-16T11:00:00Z', NULL, '2026-07-16T11:01:00Z', '{}'::jsonb
  )$$,
  '22023',
  'payment_reconciliation_apply_claim_mismatch',
  'a stale expected attempt aborts the payment result'
);
SELECT throws_ok(
  $$SELECT public.commerce_payment_control_apply_reconciliation_result(
    'atomic-stale-apply-0001',
    'c1ff0000-0000-4000-8000-000000000002',
    (SELECT intent_id FROM _stale_intent),
    (SELECT attempt_id FROM _stale_attempt),
    (SELECT payment_id FROM _stale_intent),
    'stripe', 'pi_atomic_stale', 'processing', 'succeeded', 'succeeded',
    '2026-07-16T11:00:00Z', NULL, '2026-07-16T11:01:00Z', '{}'::jsonb
  )$$,
  '22023',
  'payment_reconciliation_apply_claim_mismatch',
  'a stale expected order aborts the payment result'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _stale_attempt)),
  'processing',
  'stale-claim failures leave the claimed attempt unchanged'
);
SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = 'c1100000-0000-4000-8000-000000000002'),
  'pending_payment',
  'stale-claim failures leave the order unpaid'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text)',
    'EXECUTE'
  ),
  'service_role can execute the atomic reconciliation RPC'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.commerce_payment_control_apply_reconciliation_result(text,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,text,timestamptz,jsonb,text,text)',
    'EXECUTE'
  ),
  'anon and authenticated cannot execute the atomic reconciliation RPC'
);

SELECT * FROM finish();
ROLLBACK;
