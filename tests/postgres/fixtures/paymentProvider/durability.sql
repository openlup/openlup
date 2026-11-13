-- Native preparation and inline retry; assertions retained from the managed witness.

BEGIN;
SELECT plan(46);

INSERT INTO public.clients (id, email)
VALUES ('cfa00000-0000-4000-8000-000000000001', 'provider-attempt@example.invalid');

SELECT pg_temp.provider_order('cfa10000-0000-4000-8000-000000000001','cfa00000-0000-4000-8000-000000000001',2599);

CREATE TEMP TABLE _intent AS
SELECT (pg_temp.provider_intent(
  'provider-attempt-intent-0001',
  'one_time_order',
  'cfa10000-0000-4000-8000-000000000001',
  NULL,
  NULL,
  2599,
  'XXX',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _prepared AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-prepare-0001',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'openlup:card_rail:intent:attempt:1',
  'card_rail|intent|2599|XXX|one_time|order_1',
  'off_session_payment',
  'pm_card_123',
  '{"source":"pgTAP"}'::jsonb
) AS response;

CREATE TEMP TABLE _attempt AS
SELECT (response -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id
FROM _prepared;

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'status' FROM _prepared),
  'created',
  'prepare returns a created provider attempt before PSP execution');

SELECT is(
  (SELECT active_attempt_id FROM public.payment_provider_states WHERE id = (SELECT intent_id FROM _intent)),
  (SELECT attempt_id FROM _attempt),
  'prepared attempt becomes active attempt before PSP execution');

SELECT is(
  (SELECT provider_attempt_id FROM public.payment_provider_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  NULL::text,
  'prepared attempt has no provider attempt id yet');

SELECT is(
  (SELECT request_payload ->> 'providerIdempotencyKey'
     FROM public.payment_provider_attempts
    WHERE id = (SELECT attempt_id FROM _attempt)),
  'openlup:card_rail:intent:attempt:1',
  'prepared attempt stores provider idempotency evidence');

CREATE TEMP TABLE _prepared_replay AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-prepare-0001',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'openlup:card_rail:intent:attempt:1',
  'card_rail|intent|2599|XXX|one_time|order_1',
  'off_session_payment',
  'pm_card_123',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _prepared_replay),
  true,
  'prepare is idempotent for the same provider request fingerprint');

SELECT throws_like(
  $$ SELECT public.payment_provider_attempt_prepare(
       'provider-attempt-prepare-0001',
       (SELECT intent_id FROM _intent),
       'card_rail',
       'openlup:card_rail:intent:attempt:1',
       'card_rail|intent|2599|XXX|one_time|order_1',
       'off_session_payment',
       'pm_card_changed',
       '{"source":"pgTAP"}'::jsonb
     ) $$,
  '%payment_control_provider_attempt_prepare_idempotency_conflict%',
  'prepare rejects same key with changed payment method before provider execution');

CREATE TEMP TABLE _in_flight_prepare AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-prepare-in-flight-0002',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'openlup:card_rail:intent:attempt:2',
  'card_rail|intent|2599|XXX|one_time|order_1|attempt_2',
  'off_session_payment',
  'pm_card_456',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _in_flight_prepare),
  (SELECT attempt_id::text FROM _attempt),
  'a fresh client attempt key cannot replace an active provider attempt');

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _in_flight_prepare),
  true,
  'an active provider attempt is returned as an in-flight replay');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  1,
  'in-flight rejection creates no second provider attempt');

CREATE TEMP TABLE _finalized AS
SELECT public.payment_provider_attempt_finalize(
  'provider-attempt-finalize-0001',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'openlup:card_rail:intent:attempt:1',
  'card_rail|intent|2599|XXX|one_time|order_1',
  'pi_provider_123',
  'pi_provider_123',
  'processing',
  NULL,
  '{"providerCall":true}'::jsonb,
  '{"providerCall":true,"webhookExpected":true}'::jsonb
) AS response;

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _finalized),
  (SELECT attempt_id::text FROM _attempt),
  'finalize returns the same prepared attempt id');

SELECT is(
  (SELECT status FROM public.payment_provider_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  'processing',
  'finalize moves the prepared attempt to processing');

SELECT is(
  (SELECT provider_attempt_id FROM public.payment_provider_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  'pi_provider_123',
  'finalize stores provider attempt id on the same row');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  1,
  'prepare plus finalize creates exactly one local payment attempt');

CREATE TEMP TABLE _finalized_replay AS
SELECT public.payment_provider_attempt_finalize(
  'provider-attempt-finalize-0001',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'openlup:card_rail:intent:attempt:1',
  'card_rail|intent|2599|XXX|one_time|order_1',
  'pi_provider_123',
  'pi_provider_123',
  'processing',
  NULL,
  '{"providerCall":true}'::jsonb,
  '{"providerCall":true,"webhookExpected":true}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _finalized_replay),
  true,
  'finalize is idempotent for the same provider acknowledgement');

SELECT pg_temp.provider_apply(
  'provider-attempt-decline-0001',
  (SELECT intent_id FROM _intent),
  NULL,
  'failed',
  '2026-07-21T10:00:00.000Z'::timestamptz,
  'provider_declined'
);

CREATE TEMP TABLE _retry_prepare AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-prepare-retry-0002',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'openlup:card_rail:intent:attempt:2',
  'card_rail|intent|2599|XXX|one_time|order_1|attempt_2',
  'off_session_payment',
  'pm_card_456',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT isnt(
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _retry_prepare),
  (SELECT attempt_id::text FROM _attempt),
  'a terminal failed attempt permits one fresh retry attempt');

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _retry_prepare),
  false,
  'the retry after a terminal decline is newly prepared');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'exactly one new provider attempt is created after terminal failure');

CREATE TEMP TABLE _retry_in_flight_prepare AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-prepare-in-flight-0003',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'openlup:card_rail:intent:attempt:3',
  'card_rail|intent|2599|XXX|one_time|order_1|attempt_3',
  'off_session_payment',
  'pm_card_789',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _retry_in_flight_prepare),
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _retry_prepare),
  'a second fresh retry request loses to the already-created retry attempt');

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _retry_in_flight_prepare),
  true,
  'the retry loser receives the winning retry as an in-flight replay');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'the retry race leaves exactly two total attempts');

CREATE TEMP TABLE _fenced_states (position int, status text, prepare_key text);
INSERT INTO _fenced_states (position, status, prepare_key) VALUES
  (1, 'processing',       'provider-attempt-fence-processing'),
  (2, 'sent_to_provider', 'provider-attempt-fence-sent-to-provider'),
  (3, 'requires_action',  'provider-attempt-fence-requires-action'),
  (4, 'succeeded',        'provider-attempt-fence-succeeded');

CREATE TEMP TABLE _fence_results (status text, replayed boolean, returned_attempt uuid);

DO $$
DECLARE
  v_state record;
  v_intent_id uuid := (SELECT intent_id FROM _intent);
  v_active uuid;
  v_response jsonb;
BEGIN
  FOR v_state IN SELECT * FROM _fenced_states ORDER BY position LOOP
    SELECT active_attempt_id INTO v_active
      FROM public.payment_provider_states WHERE id = v_intent_id;

    UPDATE public.payment_provider_attempts
       SET status = v_state.status
     WHERE id = v_active;

    v_response := public.payment_provider_attempt_prepare(
      v_state.prepare_key,
      v_intent_id,
      'card_rail',
      'fence-provider-key-' || v_state.position::text,
      'fence-request-fingerprint-' || v_state.position::text,
      'off_session_payment',
      'pm_card_fence',
      '{"source":"pgTAP"}'::jsonb
    );

    INSERT INTO _fence_results (status, replayed, returned_attempt)
    VALUES (
      v_state.status,
      (v_response -> 'paymentAttempt' ->> 'replayed')::boolean,
      (v_response -> 'paymentAttempt' ->> 'id')::uuid
    );
  END LOOP;
END $$;

SELECT is(
  (SELECT count(*)::int FROM _fence_results WHERE replayed IS NOT TRUE),
  0,
  'no non-terminal attempt state admits a fresh provider attempt');

SELECT is(
  (SELECT replayed FROM _fence_results WHERE status = 'processing'),
  true,
  'an attempt whose confirm is genuinely in flight is refused as a replay');

SELECT is(
  (SELECT replayed FROM _fence_results WHERE status = 'sent_to_provider'),
  true,
  'a dispatched attempt with no known outcome is refused as a replay');

SELECT is(
  (SELECT replayed FROM _fence_results WHERE status = 'requires_action'),
  true,
  'an attempt awaiting a payer action is refused as a replay');

SELECT is(
  (SELECT replayed FROM _fence_results WHERE status = 'succeeded'),
  true,
  'a status outside the four retryable ones is refused without being listed');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'four refused admissions created no provider attempt at all');

UPDATE public.payment_provider_attempts
   SET status = 'cancelled'
 WHERE id = (SELECT active_attempt_id FROM public.payment_provider_states
              WHERE id = (SELECT intent_id FROM _intent));

CREATE TEMP TABLE _cancelled_retry AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-fence-cancelled',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'fence-provider-key-cancelled',
  'fence-request-fingerprint-cancelled',
  'off_session_payment',
  'pm_card_fence',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _cancelled_retry),
  false,
  'a cancelled attempt admits one fresh provider attempt');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  3,
  'the admission after a cancelled attempt created exactly one attempt');

UPDATE public.payment_provider_attempts
   SET status = 'expired'
 WHERE id = (SELECT active_attempt_id FROM public.payment_provider_states
              WHERE id = (SELECT intent_id FROM _intent));

CREATE TEMP TABLE _expired_retry AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-fence-expired',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'fence-provider-key-expired',
  'fence-request-fingerprint-expired',
  'off_session_payment',
  'pm_card_fence',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _expired_retry),
  false,
  'an expired attempt admits one fresh provider attempt');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  4,
  'the admission after an expired attempt created exactly one attempt');
UPDATE public.payment_provider_attempts
   SET status = 'failed',
       provider_attempt_id = 'pi_event_exact',
       provider_session_id = 'pi_event_exact'
 WHERE id = (SELECT active_attempt_id FROM public.payment_provider_states
              WHERE id = (SELECT intent_id FROM _intent));

DO $$
BEGIN
  PERFORM public.payment_provider_event_ingest(
    'card_rail',
    'evt_observed_success_wrong_handle',
    'payment.succeeded',
    'pi_event_other',
    (SELECT intent_id FROM _intent),
    (SELECT active_attempt_id FROM public.payment_provider_states
      WHERE id = (SELECT intent_id FROM _intent)),
    2599,
    (SELECT currency_code FROM public.commerce_settlement_intents
      WHERE id = (SELECT intent_id FROM _intent)),
    true,
    jsonb_build_object(
      '__paymentTruth', jsonb_build_object(
        'fingerprint', repeat('a', 64),
        'evidence', jsonb_build_object('source', 'pgTAP')
      )
    )
  );
END $$;

CREATE TEMP TABLE _wrong_event_handle_retry AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-event-wrong-handle',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'event-wrong-handle-provider-key',
  'event-wrong-handle-fingerprint',
  'off_session_payment',
  'pm_card_event_wrong_handle',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean
     FROM _wrong_event_handle_retry),
  false,
  'a success event with a mismatched provider handle does not block a valid retry');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  5,
  'the mismatched success event leaves exactly one new retry attempt');
UPDATE public.payment_provider_attempts
   SET status = 'failed'
 WHERE id = (SELECT active_attempt_id FROM public.payment_provider_states
              WHERE id = (SELECT intent_id FROM _intent));

DO $$
BEGIN
  PERFORM public.payment_provider_event_ingest(
    'card_rail',
    'evt_observed_success_exact',
    'payment.succeeded',
    'pi_event_exact',
    (SELECT intent_id FROM _intent),
    (SELECT (response -> 'paymentAttempt' ->> 'id')::uuid FROM _expired_retry),
    2599,
    (SELECT currency_code FROM public.commerce_settlement_intents
      WHERE id = (SELECT intent_id FROM _intent)),
    true,
    jsonb_build_object(
      '__paymentTruth', jsonb_build_object(
        'fingerprint', repeat('b', 64),
        'evidence', jsonb_build_object('source', 'pgTAP')
      )
    )
  );
END $$;

CREATE TEMP TABLE _exact_event_success_retry AS
SELECT public.payment_provider_attempt_prepare(
  'provider-attempt-event-exact-success',
  (SELECT intent_id FROM _intent),
  'card_rail',
  'event-exact-success-provider-key',
  'event-exact-success-fingerprint',
  'off_session_payment',
  'pm_card_event_exact_success',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean
     FROM _exact_event_success_retry),
  true,
  'an exact signed success event fences a locally failed attempt as a replay');

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _exact_event_success_retry),
  (SELECT response -> 'paymentAttempt' ->> 'id' FROM _expired_retry),
  'event-backed success returns the exact earlier successful attempt');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_attempts
    WHERE settlement_intent_id = (SELECT intent_id FROM _intent)),
  5,
  'event-backed success creates no second provider attempt');
SELECT pg_temp.provider_order('cfa10000-0000-4000-8000-000000000099','cfa00000-0000-4000-8000-000000000001',2599);

CREATE TEMP TABLE _inline_intent AS
SELECT (pg_temp.provider_intent(
  'inline-cas-intent', 'one_time_order',
  'cfa10000-0000-4000-8000-000000000099', NULL, NULL,
  2599, (SELECT currency_code FROM public.commerce_orders
          WHERE id = 'cfa10000-0000-4000-8000-000000000099'), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _inline_old AS
SELECT public.payment_provider_attempt_prepare(
  'inline-cas-old', (SELECT intent_id FROM _inline_intent), 'tpay',
  'inline-cas-old-provider', 'inline-cas-old-fingerprint',
  'blik_one_time', NULL, '{}'::jsonb
) AS response;

UPDATE public.payment_provider_attempts
   SET status = 'failed'
 WHERE id = (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _inline_old);
UPDATE public.payment_provider_states
   SET status = 'failed'
 WHERE id = (SELECT intent_id FROM _inline_intent);

CREATE TEMP TABLE _inline_retry AS
SELECT public.payment_provider_attempt_prepare(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint',
  'one_time_payment', NULL,
  jsonb_build_object(
    'source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000002',
    'purchaseContext', 'one_time'
  )
) AS response;

SELECT is((SELECT (response #>> '{paymentAttempt,replayed}')::boolean FROM _inline_retry), false,
  'exact failed predecessor admits one inline provider attempt');
SELECT isnt((SELECT response #>> '{paymentAttempt,id}' FROM _inline_retry),
  (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
  'inline retry creates a new attempt on the same intent');
SELECT is((SELECT count(*)::int FROM public.payment_provider_attempts
  WHERE settlement_intent_id = (SELECT intent_id FROM _inline_intent)), 2,
  'exact inline transition creates no order or extra payment attempt');

UPDATE public.payment_provider_attempts SET status = 'failed'
 WHERE id = (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _inline_retry);
UPDATE public.payment_provider_states SET status = 'failed'
 WHERE id = (SELECT intent_id FROM _inline_intent);

SELECT is((public.payment_provider_attempt_prepare(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000002', 'purchaseContext', 'one_time')
) #>> '{paymentAttempt,id}'), (SELECT response #>> '{paymentAttempt,id}' FROM _inline_retry),
  'identical response-loss retry reads the durable attempt without redispatch');
SELECT is((public.payment_provider_attempt_prepare(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000002', 'purchaseContext', 'one_time')
) #>> '{paymentAttempt,replayed}'), 'true',
  'identical response-loss retry is marked replayed');

SELECT throws_like($$SELECT public.payment_provider_attempt_prepare(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000003', 'purchaseContext', 'one_time')
)$$, '%payment_control_provider_attempt_prepare_idempotency_conflict%',
  'same transition key with a competing tab nonce conflicts before provider dispatch');

SELECT throws_like($$SELECT public.payment_provider_attempt_prepare(
  'inline-cas-stale-key', (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-stale-provider', 'inline-cas-stale-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000003', 'purchaseContext', 'one_time')
)$$, '%payment_control_inline_retry_predecessor_mismatch%',
  'a stale predecessor cannot create another attempt after a terminal winner');

UPDATE public.commerce_orders
   SET metadata = metadata || '{"paymentStatus":"expired"}'::jsonb
 WHERE id = 'cfa10000-0000-4000-8000-000000000099';
SELECT throws_like($$SELECT public.payment_provider_attempt_prepare(
  'inline-cas-expired-key', (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-expired-provider', 'inline-cas-expired-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_retry),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000004', 'purchaseContext', 'one_time')
)$$, '%payment_control_inline_retry_order_not_payable%',
  'technical expiry wins under lock before another provider attempt');



SELECT pg_temp.provider_order('cfa40000-0000-4000-8000-000000000099','cfa00000-0000-4000-8000-000000000001',2599);
SELECT public.subscription_declare_provisional_activation('inline-cas-sub-declare','cfa40000-0000-4000-8000-000000000099',28,'2026-11-13T12:00:00Z');
CREATE TEMP TABLE _inline_sub_intent AS SELECT (pg_temp.provider_intent('inline-cas-sub-intent','one_time_order',
 'cfa40000-0000-4000-8000-000000000099',NULL,NULL,2599,'XXX','{}')#>>'{paymentIntent,id}')::uuid AS intent_id;
CREATE TEMP TABLE _inline_sub_old AS SELECT public.payment_provider_attempt_prepare('inline-cas-sub-old',
 (SELECT intent_id FROM _inline_sub_intent),'tpay','inline-cas-sub-old-provider','inline-cas-sub-old-fingerprint','blik_recurring_activation',NULL,'{}') AS response;
UPDATE public.payment_provider_attempts SET status='failed' WHERE id=(SELECT (response#>>'{paymentAttempt,id}')::uuid FROM _inline_sub_old);
UPDATE public.payment_provider_states SET status='failed' WHERE id=(SELECT intent_id FROM _inline_sub_intent);
CREATE TEMP TABLE _inline_sub_retry AS SELECT public.payment_provider_attempt_prepare('inline-cas-sub-valid',
 (SELECT intent_id FROM _inline_sub_intent),'tpay','inline-cas-sub-valid-provider','inline-cas-sub-valid-fingerprint','blik_recurring_activation',NULL,
 jsonb_build_object('source','commerce.checkout-inline-recovery.prepare.v1','expectedPaymentAttemptId',
 (SELECT response#>>'{paymentAttempt,id}' FROM _inline_sub_old),'retryRequestId','cfa90000-0000-4000-8000-000000000006','purchaseContext','subscription_initial')) AS response;
SELECT ok((SELECT response#>>'{paymentAttempt,id}' FROM _inline_sub_retry) IS NOT NULL,
 'provisional activation flow admits the exact initial retry');
SELECT is((SELECT count(*)::int FROM public.payment_provider_attempts WHERE settlement_intent_id=(SELECT intent_id FROM _inline_sub_intent)),2,
 'valid subscription inline retry creates exactly one new attempt');
SELECT pg_temp.provider_subscription_order('cfa20000-0000-4000-8000-000000000098','cfa30000-0000-4000-8000-000000000098',
 'cfa40000-0000-4000-8000-000000000098','cfa00000-0000-4000-8000-000000000001','active');
CREATE TEMP TABLE _inline_active_intent AS SELECT (pg_temp.provider_intent('inline-cas-active-intent','subscription_cycle',
 'cfa40000-0000-4000-8000-000000000098','cfa20000-0000-4000-8000-000000000098','cfa30000-0000-4000-8000-000000000098',12999,'XXX','{}')#>>'{paymentIntent,id}')::uuid AS intent_id;
CREATE TEMP TABLE _inline_active_old AS SELECT public.payment_provider_attempt_prepare('inline-cas-active-old',
 (SELECT intent_id FROM _inline_active_intent),'tpay','inline-cas-active-old-provider','inline-cas-active-old-fingerprint','blik_recurring_activation',NULL,'{}') AS response;
UPDATE public.payment_provider_attempts SET status='failed' WHERE id=(SELECT (response#>>'{paymentAttempt,id}')::uuid FROM _inline_active_old);
UPDATE public.payment_provider_states SET status='failed' WHERE id=(SELECT intent_id FROM _inline_active_intent);
SELECT throws_like($$SELECT public.payment_provider_attempt_prepare('inline-cas-active-retry',
 (SELECT intent_id FROM _inline_active_intent),'tpay','inline-cas-active-provider','inline-cas-active-fingerprint','blik_recurring_activation',NULL,
 jsonb_build_object('source','commerce.checkout-inline-recovery.prepare.v1','expectedPaymentAttemptId',
 (SELECT response#>>'{paymentAttempt,id}' FROM _inline_active_old),'retryRequestId','cfa90000-0000-4000-8000-000000000007','purchaseContext','subscription_initial'))$$,
 '%payment_control_inline_retry_context_mismatch%','active subscription refuses an initial-subscription inline retry');

SELECT * FROM finish();
ROLLBACK;
