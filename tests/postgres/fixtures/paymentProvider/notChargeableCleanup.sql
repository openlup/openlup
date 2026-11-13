-- Native cleanup and observed-success assertions retained from the managed witness.

BEGIN;
SELECT plan(13);

INSERT INTO public.clients (id, email)
VALUES ('ac100000-0000-4000-8000-000000000001', 'not-chargeable@example.invalid');

SELECT pg_temp.provider_subscription_order('ac200000-0000-4000-8000-000000000001','ac300000-0000-4000-8000-000000000001','ac400000-0000-4000-8000-000000000001','ac100000-0000-4000-8000-000000000001','paused');

CREATE TEMP TABLE _not_chargeable_intent AS
SELECT (pg_temp.provider_intent(
  'not-chargeable-intent',
  'subscription_cycle',
  'ac400000-0000-4000-8000-000000000001',
  'ac200000-0000-4000-8000-000000000001',
  'ac300000-0000-4000-8000-000000000001',
  12999, 'XXX', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _not_chargeable_result AS
SELECT public.payment_provider_attempt_prepare(
  'not-chargeable-prepare',
  (SELECT intent_id FROM _not_chargeable_intent),
  'card_rail',
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
  (SELECT status FROM public.payment_provider_states WHERE id = (SELECT intent_id FROM _not_chargeable_intent)),
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
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _not_chargeable_intent)),
  0,
  'no provider attempt exists and therefore no PSP call is authorized'
);
INSERT INTO public.clients (id, email)
VALUES ('ac100000-0000-4000-8000-000000000002', 'not-chargeable-history@example.invalid');

SELECT pg_temp.provider_subscription_order('ac200000-0000-4000-8000-000000000002','ac300000-0000-4000-8000-000000000002','ac400000-0000-4000-8000-000000000002','ac100000-0000-4000-8000-000000000002','active');

CREATE TEMP TABLE _not_chargeable_history_intent AS
SELECT (pg_temp.provider_intent(
  'not-chargeable-history-intent',
  'subscription_cycle',
  'ac400000-0000-4000-8000-000000000002',
  'ac200000-0000-4000-8000-000000000002',
  'ac300000-0000-4000-8000-000000000002',
  12999, 'XXX', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.payment_provider_attempt_prepare(
  'not-chargeable-history-first-attempt',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  'card_rail',
  'not-chargeable-history-provider-key',
  'not-chargeable-history-fingerprint',
  'off_session_payment',
  'pm_paused_history',
  '{}'::jsonb
);

UPDATE public.payment_provider_attempts
   SET status = 'failed',
       failure_reason = 'historical_decline',
       provider_attempt_id = 'pi_not_chargeable_observed_success',
       provider_session_id = 'pi_not_chargeable_observed_success',
       updated_at = now()
 WHERE settlement_intent_id = (SELECT intent_id FROM _not_chargeable_history_intent);

UPDATE public.payment_provider_states
   SET status = 'failed',
       failure_reason = 'historical_decline',
       updated_at = now()
 WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent);

UPDATE public.subscriptions
   SET status = 'paused', updated_at = now()
 WHERE id = 'ac200000-0000-4000-8000-000000000002';
SELECT public.payment_provider_event_ingest(
  'card_rail',
  'evt_not_chargeable_observed_success',
  'payment.succeeded',
  'pi_not_chargeable_observed_success',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  (SELECT active_attempt_id FROM public.payment_provider_states
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  12999,
  (SELECT currency_code FROM public.commerce_settlement_intents
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
SELECT public.payment_provider_attempt_prepare(
  'not-chargeable-observed-success-next-attempt',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  'card_rail',
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
  (SELECT active_attempt_id::text FROM public.payment_provider_states
    WHERE id = (SELECT intent_id FROM _not_chargeable_history_intent)),
  'not-chargeable replay returns the exact successful attempt'
);

SELECT is(
  (SELECT status FROM public.payment_provider_states
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
DELETE FROM public.payment_provider_attempt_evidence
 WHERE provider_event_id = 'evt_not_chargeable_observed_success';

CREATE TEMP TABLE _not_chargeable_history_result AS
SELECT public.payment_provider_attempt_prepare(
  'not-chargeable-history-next-attempt',
  (SELECT intent_id FROM _not_chargeable_history_intent),
  'card_rail',
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
  (SELECT status FROM public.payment_provider_states
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
