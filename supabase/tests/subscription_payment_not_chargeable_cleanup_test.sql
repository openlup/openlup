-- pgTAP: if pause/cancel wins after local renewal artifacts were created but
-- before provider-attempt admission, prepare persists a typed skip and cleans the
-- unpaid intent/cycle/order instead of rolling compensation back with an error.
-- Historical failed attempts remain audit evidence but do not keep that work due.

BEGIN;
SELECT plan(13);

INSERT INTO public.clients (id, email)
VALUES ('ac100000-0000-4000-8000-000000000001', 'not-chargeable@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  'ac200000-0000-4000-8000-000000000001',
  'ac100000-0000-4000-8000-000000000001',
  30, 'PLN', 'paused', now() - interval '30 days', now(), 'pm_paused', 'card'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt, next_retry_at
)
VALUES (
  'ac300000-0000-4000-8000-000000000001',
  'ac200000-0000-4000-8000-000000000001',
  2, now(), 'retry_scheduled', 'not-chargeable-cycle', 0, now()
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
)
VALUES (
  'ac400000-0000-4000-8000-000000000001',
  'ac100000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":30}'::jsonb,
  'pending_payment', 12999, 12999, 'subscription_cycle',
  'ac200000-0000-4000-8000-000000000001',
  'ac300000-0000-4000-8000-000000000001'
);

CREATE TEMP TABLE _not_chargeable_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'not-chargeable-intent',
  'subscription_cycle',
  'ac400000-0000-4000-8000-000000000001',
  'ac200000-0000-4000-8000-000000000001',
  'ac300000-0000-4000-8000-000000000001',
  12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _not_chargeable_result AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'not-chargeable-prepare',
  (SELECT intent_id FROM _not_chargeable_intent),
  'stripe',
  'not-chargeable-provider-key',
  'not-chargeable-fingerprint',
  'off_session_payment',
  'pm_paused',
  '{}'::jsonb
) AS response;

SELECT is(
  (SELECT response #>> '{paymentAttemptAdmission,reason}' FROM _not_chargeable_result),
  'payment_control_subscription_not_chargeable',
  'prepare returns the stable not-chargeable reason after committing cleanup'
);

SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _not_chargeable_intent)),
  'cancelled',
  'pristine payment intent is terminalized'
);

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'ac300000-0000-4000-8000-000000000001'),
  'cancelled',
  'pristine renewal cycle is terminalized'
);

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'ac400000-0000-4000-8000-000000000001'),
  'cancelled',
  'pristine unpaid order is terminalized (reservation trigger owns hold release)'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _not_chargeable_intent)),
  0,
  'no provider attempt exists and therefore no PSP call is authorized'
);

-- A retry intent legitimately retains its prior terminal attempts. Those rows
-- are audit history, not evidence that a PSP call is currently in flight, and
-- therefore must not suppress the same compensation.
INSERT INTO public.clients (id, email)
VALUES ('ac100000-0000-4000-8000-000000000002', 'not-chargeable-history@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  payment_method_ref, payment_method_kind
)
VALUES (
  'ac200000-0000-4000-8000-000000000002',
  'ac100000-0000-4000-8000-000000000002',
  30, 'PLN', 'active', now() - interval '30 days', now(), 'pm_paused_history', 'card'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt, next_retry_at
)
VALUES (
  'ac300000-0000-4000-8000-000000000002',
  'ac200000-0000-4000-8000-000000000002',
  2, now(), 'retry_scheduled', 'not-chargeable-history-cycle', 1, now()
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
)
VALUES (
  'ac400000-0000-4000-8000-000000000002',
  'ac100000-0000-4000-8000-000000000002',
  'PLN', 'PL', '{"kind":"feeding_days","value":30}'::jsonb,
  'pending_payment', 12999, 12999, 'subscription_cycle',
  'ac200000-0000-4000-8000-000000000002',
  'ac300000-0000-4000-8000-000000000002'
);

CREATE TEMP TABLE _not_chargeable_history_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'not-chargeable-history-intent',
  'subscription_cycle',
  'ac400000-0000-4000-8000-000000000002',
  'ac200000-0000-4000-8000-000000000002',
  'ac300000-0000-4000-8000-000000000002',
  12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_prepare_provider_attempt(
  'not-chargeable-history-first-attempt',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  'stripe',
  'not-chargeable-history-provider-key',
  'not-chargeable-history-fingerprint',
  'off_session_payment',
  'pm_paused_history',
  '{}'::jsonb
);

UPDATE public.commerce_payment_attempts
   SET status = 'failed',
       failure_reason = 'historical_decline',
       provider_attempt_id = 'pi_not_chargeable_observed_success',
       provider_session_id = 'pi_not_chargeable_observed_success',
       updated_at = now()
 WHERE payment_intent_id = (SELECT intent_id FROM _not_chargeable_history_intent);

UPDATE public.commerce_payment_intents
   SET status = 'failed',
       failure_reason = 'historical_decline',
       updated_at = now()
 WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent);

UPDATE public.subscriptions
   SET status = 'paused', updated_at = now()
 WHERE id = 'ac200000-0000-4000-8000-000000000002';

-- Local failed state is not enough to prove that an order was never paid. If
-- exact verified provider success is already durable, admission must return the
-- successful attempt before not-chargeable cleanup can cancel the order.
SELECT public.commerce_payment_control_ingest_event(
  'stripe',
  'evt_not_chargeable_observed_success',
  'payment.succeeded',
  'pi_not_chargeable_observed_success',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  (SELECT active_attempt_id FROM public.commerce_payment_intents
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  12999,
  (SELECT currency FROM public.commerce_payment_intents
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  true,
  jsonb_build_object(
    '__paymentTruth', jsonb_build_object(
      'fingerprint', repeat('c', 64),
      'evidence', jsonb_build_object('source', 'pgTAP')
    )
  )
);

CREATE TEMP TABLE _not_chargeable_observed_success_result AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'not-chargeable-observed-success-next-attempt',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  'stripe',
  'not-chargeable-observed-success-provider-key-next',
  'not-chargeable-observed-success-fingerprint-next',
  'off_session_payment',
  'pm_paused_history',
  '{}'::jsonb
) AS response;

SELECT is(
  (SELECT (response #>> '{paymentAttempt,replayed}')::boolean
     FROM _not_chargeable_observed_success_result),
  true,
  'durable provider success wins before not-chargeable cleanup'
);

SELECT is(
  (SELECT response #>> '{paymentAttempt,id}'
     FROM _not_chargeable_observed_success_result),
  (SELECT active_attempt_id::text FROM public.commerce_payment_intents
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  'not-chargeable replay returns the exact successful attempt'
);

SELECT is(
  (SELECT status FROM public.commerce_payment_intents
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  'failed',
  'durable success evidence leaves the stale intent for result convergence'
);

SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = 'ac400000-0000-4000-8000-000000000002'),
  'pending_payment',
  'durable success evidence prevents cancellation of the potentially paid order'
);

-- Removing the event isolates the original terminal-history compensation case
-- below: without provider success evidence, the paused subscription is cleaned.
DELETE FROM public.inbound_provider_events
 WHERE provider_event_id = 'evt_not_chargeable_observed_success';

CREATE TEMP TABLE _not_chargeable_history_result AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'not-chargeable-history-next-attempt',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  'stripe',
  'not-chargeable-history-provider-key-next',
  'not-chargeable-history-fingerprint-next',
  'off_session_payment',
  'pm_paused_history',
  '{}'::jsonb
) AS response;

SELECT is(
  (SELECT response #>> '{paymentAttemptAdmission,reason}' FROM _not_chargeable_history_result),
  'payment_control_subscription_not_chargeable',
  'terminal attempt history still returns the stable not-chargeable admission result'
);

SELECT is(
  (SELECT status FROM public.commerce_payment_intents
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  'cancelled',
  'terminal attempt history does not keep the unpaid intent retryable'
);

SELECT is(
  (SELECT status FROM public.subscription_cycles
    WHERE id = 'ac300000-0000-4000-8000-000000000002'),
  'cancelled',
  'terminal attempt history does not keep the retry cycle due'
);

SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = 'ac400000-0000-4000-8000-000000000002'),
  'cancelled',
  'terminal attempt history does not keep the unpaid order or reservation alive'
);

SELECT * FROM finish();
ROLLBACK;
