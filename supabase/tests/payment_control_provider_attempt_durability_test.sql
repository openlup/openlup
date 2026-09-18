-- pgTAP: provider attempts can be prepared before PSP execution and finalized
-- on the same local attempt row after the PSP responds; and the admission fence
-- admits a fresh provider attempt for exactly the four terminal attempt statuses
-- and refuses every other status, so one payment intent can never hold two live
-- provider objects.

BEGIN;
SELECT plan(68);

INSERT INTO public.clients (id, email)
VALUES ('cfa00000-0000-4000-8000-000000000001', 'provider-attempt@example.invalid');

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES (
  'cfa10000-0000-4000-8000-000000000001',
  'cfa00000-0000-4000-8000-000000000001',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":28}'::jsonb,
  'draft',
  2599, 2599,
  'one_time'
);

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'provider-attempt-intent-0001',
  'one_time_order',
  'cfa10000-0000-4000-8000-000000000001',
  NULL,
  NULL,
  2599,
  'PLN',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _prepared AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-prepare-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:1',
  'stripe|intent|2599|PLN|one_time|order_1',
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
  (SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)),
  (SELECT attempt_id FROM _attempt),
  'prepared attempt becomes active attempt before PSP execution');

SELECT is(
  (SELECT provider_attempt_id FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  NULL::text,
  'prepared attempt has no provider attempt id yet');

SELECT is(
  (SELECT request_payload ->> 'providerIdempotencyKey'
     FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _attempt)),
  'openlup:stripe:intent:attempt:1',
  'prepared attempt stores provider idempotency evidence');

CREATE TEMP TABLE _prepared_replay AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-prepare-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:1',
  'stripe|intent|2599|PLN|one_time|order_1',
  'off_session_payment',
  'pm_card_123',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _prepared_replay),
  true,
  'prepare is idempotent for the same provider request fingerprint');

SELECT throws_like(
  $$ SELECT public.commerce_payment_control_prepare_provider_attempt(
       'provider-attempt-prepare-0001',
       (SELECT intent_id FROM _intent),
       'stripe',
       'openlup:stripe:intent:attempt:1',
       'stripe|intent|2599|PLN|one_time|order_1',
       'off_session_payment',
       'pm_card_changed',
       '{"source":"pgTAP"}'::jsonb
     ) $$,
  '%payment_control_provider_attempt_prepare_idempotency_conflict%',
  'prepare rejects same key with changed payment method before provider execution');

CREATE TEMP TABLE _in_flight_prepare AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-prepare-in-flight-0002',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:2',
  'stripe|intent|2599|PLN|one_time|order_1|attempt_2',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  1,
  'in-flight rejection creates no second provider attempt');

CREATE TEMP TABLE _finalized AS
SELECT public.commerce_payment_control_finalize_provider_attempt(
  'provider-attempt-finalize-0001',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'openlup:stripe:intent:attempt:1',
  'stripe|intent|2599|PLN|one_time|order_1',
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
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  'processing',
  'finalize moves the prepared attempt to processing');

SELECT is(
  (SELECT provider_attempt_id FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  'pi_provider_123',
  'finalize stores provider attempt id on the same row');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  1,
  'prepare plus finalize creates exactly one local payment attempt');

CREATE TEMP TABLE _finalized_replay AS
SELECT public.commerce_payment_control_finalize_provider_attempt(
  'provider-attempt-finalize-0001',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'openlup:stripe:intent:attempt:1',
  'stripe|intent|2599|PLN|one_time|order_1',
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

SELECT public.commerce_payment_control_apply_result(
  'provider-attempt-decline-0001',
  (SELECT intent_id FROM _intent),
  NULL,
  'failed',
  '2026-07-21T10:00:00.000Z'::timestamptz,
  'provider_declined'
);

CREATE TEMP TABLE _retry_prepare AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-prepare-retry-0002',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:2',
  'stripe|intent|2599|PLN|one_time|order_1|attempt_2',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'exactly one new provider attempt is created after terminal failure');

CREATE TEMP TABLE _retry_in_flight_prepare AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-prepare-in-flight-0003',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:3',
  'stripe|intent|2599|PLN|one_time|order_1|attempt_3',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'the retry race leaves exactly two total attempts');

-- The admission fence, state by state.
--
-- `commerce_payment_control_prepare_provider_attempt` is the only thing standing
-- between one payment intent and two live provider objects: admitting past it
-- necessarily mints a second one, because every caller derives the prepare key
-- and the provider idempotency key from the same execution key, so a prepare key
-- that misses the idempotency ledger implies a provider idempotency key that has
-- also changed — and the execution adapter always creates, never retrieves.
-- Nothing downstream compensates: no provider-side cancel runs on
-- prepare/finalize, and apply_result does not reject a second `succeeded`.
--
-- The fence is therefore stated as a closed blacklist: exactly four terminal
-- statuses are retryable and EVERY other status is refused, so a status nobody
-- anticipated is refused by construction rather than by having been listed. The
-- assertions below walk the non-terminal states one at a time and prove the
-- refusal holds for each, then prove the retryable half is complete.
--
-- `sent_to_provider` is the state a fresh, unconfirmed interactive card intent
-- now occupies (see docs/BACKEND.md — it used to be recorded as `processing`,
-- claiming a charge was in flight when no issuer had been asked). Naming it
-- truthfully must NOT make it admissible, which is what this block pins.

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
      FROM public.commerce_payment_intents WHERE id = v_intent_id;

    UPDATE public.commerce_payment_attempts
       SET status = v_state.status
     WHERE id = v_active;

    v_response := public.commerce_payment_control_prepare_provider_attempt(
      v_state.prepare_key,
      v_intent_id,
      'stripe',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'four refused admissions created no provider attempt at all');

-- The retryable half. `failed` is proven above; `blocked_preflight` never reached
-- a provider by construction. These two close the list, and each admission must
-- create exactly one attempt so the fence cannot be escaped twice on one status.

UPDATE public.commerce_payment_attempts
   SET status = 'cancelled'
 WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents
              WHERE id = (SELECT intent_id FROM _intent));

CREATE TEMP TABLE _cancelled_retry AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-fence-cancelled',
  (SELECT intent_id FROM _intent),
  'stripe',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  3,
  'the admission after a cancelled attempt created exactly one attempt');

UPDATE public.commerce_payment_attempts
   SET status = 'expired'
 WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents
              WHERE id = (SELECT intent_id FROM _intent));

CREATE TEMP TABLE _expired_retry AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-fence-expired',
  (SELECT intent_id FROM _intent),
  'stripe',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  4,
  'the admission after an expired attempt created exactly one attempt');

-- Local failure can lag exact provider success. First prove that a successful
-- event with the wrong provider handle is insufficient to fence a retry.
UPDATE public.commerce_payment_attempts
   SET status = 'failed',
       provider_attempt_id = 'pi_event_exact',
       provider_session_id = 'pi_event_exact'
 WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents
              WHERE id = (SELECT intent_id FROM _intent));

DO $$
BEGIN
  PERFORM public.commerce_payment_control_ingest_event(
    'stripe',
    'evt_observed_success_wrong_handle',
    'payment.succeeded',
    'pi_event_other',
    (SELECT intent_id FROM _intent),
    (SELECT active_attempt_id FROM public.commerce_payment_intents
      WHERE id = (SELECT intent_id FROM _intent)),
    2599,
    (SELECT currency FROM public.commerce_payment_intents
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
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-event-wrong-handle',
  (SELECT intent_id FROM _intent),
  'stripe',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  5,
  'the mismatched success event leaves exactly one new retry attempt');

-- The same exact binding must now fail closed even after a newer locally failed
-- attempt became active. The caller receives the earlier successful attempt as
-- a replay and therefore never dispatches the PSP again.
UPDATE public.commerce_payment_attempts
   SET status = 'failed'
 WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents
              WHERE id = (SELECT intent_id FROM _intent));

DO $$
BEGIN
  PERFORM public.commerce_payment_control_ingest_event(
    'stripe',
    'evt_observed_success_exact',
    'payment.succeeded',
    'pi_event_exact',
    (SELECT intent_id FROM _intent),
    (SELECT (response -> 'paymentAttempt' ->> 'id')::uuid FROM _expired_retry),
    2599,
    (SELECT currency FROM public.commerce_payment_intents
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
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-event-exact-success',
  (SELECT intent_id FROM _intent),
  'stripe',
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
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  5,
  'event-backed success creates no second provider attempt');

-- Reconciliation owns a different TPay handle. Remove event evidence so these
-- assertions independently prove provider_session_id correlation.
DELETE FROM public.inbound_provider_events
 WHERE payment_intent_id = (SELECT intent_id FROM _intent);

UPDATE public.commerce_payment_attempts
   SET provider = 'tpay',
       status = 'failed',
       provider_attempt_id = 'TR-RECON-WRONG',
       provider_session_id = 'tx-recon-exact'
 WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents
              WHERE id = (SELECT intent_id FROM _intent));

INSERT INTO public.commerce_payment_reconciliation_runs (
  provider, provider_payment_id, payment_intent_id, payment_attempt_id,
  local_status, provider_status, correction_status, idempotency_key, payload
) VALUES (
  'tpay', 'TR-RECON-WRONG', (SELECT intent_id FROM _intent),
  (SELECT active_attempt_id FROM public.commerce_payment_intents
    WHERE id = (SELECT intent_id FROM _intent)),
  'failed', 'paid', 'observed', 'recon-observed-success-wrong-handle',
  '{"normalizedStatus":"succeeded"}'::jsonb
);

CREATE TEMP TABLE _wrong_reconciliation_handle_retry AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-recon-wrong-handle',
  (SELECT intent_id FROM _intent),
  'tpay',
  'recon-wrong-handle-provider-key',
  'recon-wrong-handle-fingerprint',
  'recurring_charge',
  'payid-recon-wrong-handle',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean
     FROM _wrong_reconciliation_handle_retry),
  false,
  'TPay reconciliation on the merchant title does not masquerade as transaction success');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  6,
  'the mismatched TPay reconciliation leaves exactly one new retry attempt');

UPDATE public.commerce_payment_attempts
   SET status = 'failed'
 WHERE id = (SELECT active_attempt_id FROM public.commerce_payment_intents
              WHERE id = (SELECT intent_id FROM _intent));

INSERT INTO public.commerce_payment_reconciliation_runs (
  provider, provider_payment_id, payment_intent_id, payment_attempt_id,
  local_status, provider_status, correction_status, idempotency_key, payload
) VALUES (
  'tpay', 'tx-recon-exact', (SELECT intent_id FROM _intent),
  (SELECT response -> 'paymentAttempt' ->> 'id'
     FROM _wrong_event_handle_retry)::uuid,
  'failed', 'paid', 'observed', 'recon-observed-success-exact-handle',
  '{"normalizedStatus":"succeeded"}'::jsonb
);

CREATE TEMP TABLE _exact_reconciliation_success_retry AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'provider-attempt-recon-exact-success',
  (SELECT intent_id FROM _intent),
  'tpay',
  'recon-exact-success-provider-key',
  'recon-exact-success-fingerprint',
  'recurring_charge',
  'payid-recon-exact-success',
  '{"source":"pgTAP"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean
     FROM _exact_reconciliation_success_retry),
  true,
  'exact TPay reconciliation success fences a locally failed attempt as a replay');

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'id'
     FROM _exact_reconciliation_success_retry),
  (SELECT response -> 'paymentAttempt' ->> 'id'
     FROM _wrong_event_handle_retry),
  'reconciliation-backed success returns the exact earlier successful attempt');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  6,
  'reconciliation-backed success creates no second provider attempt');

-- Each near miss gets its own intent, so no successful row from another case
-- can hide an over-broad correlation predicate. Stripe reconciliation must use
-- provider_attempt_id even when a different provider_session_id is present.
CREATE TEMP TABLE _success_near_misses (position int, case_name text, event_type text, signed boolean);
INSERT INTO _success_near_misses VALUES
  (1, 'unsigned-event',         'payment.succeeded',       false),
  (2, 'pending-event',          'payment.requires_action', true),
  (3, 'reconciliation-pending', NULL,                      NULL),
  (4, 'reconciliation-unknown', NULL,                      NULL),
  (5, 'cross-intent',           'payment.succeeded',       true),
  (6, 'cross-attempt',          'payment.succeeded',       true),
  (7, 'provider-mismatch',      'payment.succeeded',       true),
  (8, 'stripe-session',         NULL,                      NULL);

CREATE TEMP TABLE _near_miss_results
  (position int, case_name text, replayed boolean, attempt_count int, expected_count int);

DO $$
DECLARE
  c record;
  v_order uuid;
  v_intent uuid;
  v_attempt uuid;
  v_evidence_attempt uuid;
  v_provider_attempt text;
  v_provider_session text;
  v_response jsonb;
  v_expected_count int;
  v_currency text;
  v_target_kind text;
BEGIN
  SELECT currency, target_kind INTO v_currency, v_target_kind
    FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent);

  FOR c IN SELECT * FROM _success_near_misses ORDER BY position LOOP
    v_order := gen_random_uuid();
    INSERT INTO public.commerce_orders (
      id, client_id, currency, region_code, size_constraint, status,
      total_cents, subtotal_cents, mode
    ) SELECT v_order, client_id, currency, region_code, size_constraint, status,
             total_cents, subtotal_cents, mode
        FROM public.commerce_orders
       WHERE id = 'cfa10000-0000-4000-8000-000000000001';

    v_intent := (public.commerce_payment_control_create_intent(
      'near-miss-intent-' || c.position, v_target_kind, v_order,
      NULL, NULL, 2599, v_currency, '{}'::jsonb
    ) -> 'paymentIntent' ->> 'id')::uuid;
    v_response := public.commerce_payment_control_prepare_provider_attempt(
      'near-miss-first-' || c.position, v_intent, 'stripe',
      'near-miss-provider-first-' || c.position,
      'near-miss-fingerprint-first-' || c.position,
      'off_session_payment', 'pm_near_miss', '{}'::jsonb
    );
    v_attempt := (v_response -> 'paymentAttempt' ->> 'id')::uuid;
    v_provider_attempt := 'pi_near_miss_' || c.position;
    v_provider_session := 'cs_near_miss_' || c.position;
    UPDATE public.commerce_payment_attempts
       SET status = 'failed', provider_attempt_id = v_provider_attempt,
           provider_session_id = v_provider_session
     WHERE id = v_attempt;
    UPDATE public.commerce_payment_intents SET status = 'failed' WHERE id = v_intent;
    v_evidence_attempt := v_attempt;
    v_expected_count := 2;

    IF c.case_name = 'cross-attempt' THEN
      v_response := public.commerce_payment_control_prepare_provider_attempt(
        'near-miss-cross-attempt', v_intent, 'stripe',
        'near-miss-provider-cross-attempt', 'near-miss-fingerprint-cross-attempt',
        'off_session_payment', 'pm_near_miss', '{}'::jsonb
      );
      v_evidence_attempt := v_attempt;
      v_attempt := (v_response -> 'paymentAttempt' ->> 'id')::uuid;
      v_provider_attempt := 'pi_near_miss_cross_active';
      UPDATE public.commerce_payment_attempts
         SET status = 'failed', provider_attempt_id = v_provider_attempt,
             provider_session_id = 'cs_near_miss_cross_active'
       WHERE id = v_attempt;
      v_expected_count := 3;
    END IF;

    IF c.case_name IN ('reconciliation-pending', 'reconciliation-unknown', 'stripe-session') THEN
      INSERT INTO public.commerce_payment_reconciliation_runs (
        provider, provider_payment_id, payment_intent_id, payment_attempt_id,
        local_status, provider_status, correction_status, idempotency_key, payload
      ) VALUES (
        'stripe', CASE WHEN c.case_name = 'stripe-session'
          THEN v_provider_session ELSE v_provider_attempt END,
        v_intent, v_attempt, 'failed', 'paid',
        'observed', 'near-miss-reconciliation-' || c.position,
        jsonb_build_object('normalizedStatus', CASE c.case_name
          WHEN 'reconciliation-pending' THEN 'pending'
          WHEN 'reconciliation-unknown' THEN 'unknown'
          ELSE 'succeeded' END)
      );
    ELSE
      INSERT INTO public.inbound_provider_events (
        provider, provider_event_id, event_type, processing_status, payload, error,
        payment_intent_id, payment_attempt_id, provider_payment_id, amount_cents,
        currency, signature_verified, received_via
      ) VALUES (
        CASE WHEN c.case_name = 'provider-mismatch' THEN 'tpay' ELSE 'stripe' END,
        'near-miss-event-' || c.position, c.event_type, 'received', '{}'::jsonb,
        '{}'::jsonb,
        CASE WHEN c.case_name = 'cross-intent' THEN (SELECT intent_id FROM _intent) ELSE v_intent END,
        v_evidence_attempt, v_provider_attempt, 2599, v_currency, c.signed, 'pgTAP'
      );
    END IF;

    v_response := public.commerce_payment_control_prepare_provider_attempt(
      'near-miss-retry-' || c.position, v_intent, 'stripe',
      'near-miss-provider-retry-' || c.position,
      'near-miss-fingerprint-retry-' || c.position,
      'off_session_payment', 'pm_near_miss_retry', '{}'::jsonb
    );
    INSERT INTO _near_miss_results
    SELECT c.position, c.case_name,
           (v_response -> 'paymentAttempt' ->> 'replayed')::boolean,
           count(*)::int, v_expected_count
      FROM public.commerce_payment_attempts WHERE payment_intent_id = v_intent;
  END LOOP;
END $$;

SELECT is(replayed, false, case_name || ' evidence does not fence a valid retry')
  FROM _near_miss_results ORDER BY position;
SELECT is(attempt_count, expected_count, case_name || ' admits exactly one retry attempt')
  FROM _near_miss_results ORDER BY position;

-- Same-tab inline recovery is a compare-and-swap from the exact failed
-- predecessor. The stable transition key makes one browser request replayable;
-- the source marker makes a different key unable to bypass the predecessor.
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode
) SELECT
  'cfa10000-0000-4000-8000-000000000099',
  'cfa00000-0000-4000-8000-000000000001',
  source.currency, source.region_code, source.size_constraint,
  'pending_payment', 2599, 2599, 'one_time'
FROM public.commerce_orders source
WHERE source.id = 'cfa10000-0000-4000-8000-000000000001';

CREATE TEMP TABLE _inline_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'inline-cas-intent', 'one_time_order',
  'cfa10000-0000-4000-8000-000000000099', NULL, NULL,
  2599, (SELECT currency FROM public.commerce_orders
          WHERE id = 'cfa10000-0000-4000-8000-000000000099'), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _inline_old AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'inline-cas-old', (SELECT intent_id FROM _inline_intent), 'tpay',
  'inline-cas-old-provider', 'inline-cas-old-fingerprint',
  'blik_one_time', NULL, '{}'::jsonb
) AS response;

UPDATE public.commerce_payment_attempts
   SET status = 'failed'
 WHERE id = (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _inline_old);
UPDATE public.commerce_payment_intents
   SET status = 'failed'
 WHERE id = (SELECT intent_id FROM _inline_intent);

CREATE TEMP TABLE _inline_retry AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
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
SELECT is((SELECT count(*)::int FROM public.commerce_payment_attempts
  WHERE payment_intent_id = (SELECT intent_id FROM _inline_intent)), 2,
  'exact inline transition creates no order or extra payment attempt');

UPDATE public.commerce_payment_attempts SET status = 'failed'
 WHERE id = (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _inline_retry);
UPDATE public.commerce_payment_intents SET status = 'failed'
 WHERE id = (SELECT intent_id FROM _inline_intent);

SELECT is((public.commerce_payment_control_prepare_provider_attempt(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000002', 'purchaseContext', 'one_time')
) #>> '{paymentAttempt,id}'), (SELECT response #>> '{paymentAttempt,id}' FROM _inline_retry),
  'identical response-loss retry reads the durable attempt without redispatch');
SELECT is((public.commerce_payment_control_prepare_provider_attempt(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000002', 'purchaseContext', 'one_time')
) #>> '{paymentAttempt,replayed}'), 'true',
  'identical response-loss retry is marked replayed');

SELECT throws_like($$SELECT public.commerce_payment_control_prepare_provider_attempt(
  'checkout-inline-recovery:cfa90000-0000-4000-8000-000000000001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-new-provider', 'inline-cas-new-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000003', 'purchaseContext', 'one_time')
)$$, '%payment_control_provider_attempt_prepare_idempotency_conflict%',
  'same transition key with a competing tab nonce conflicts before provider dispatch');

SELECT throws_like($$SELECT public.commerce_payment_control_prepare_provider_attempt(
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
SELECT throws_like($$SELECT public.commerce_payment_control_prepare_provider_attempt(
  'inline-cas-expired-key', (SELECT intent_id FROM _inline_intent), 'stripe',
  'inline-cas-expired-provider', 'inline-cas-expired-fingerprint', 'one_time_payment', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_retry),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000004', 'purchaseContext', 'one_time')
)$$, '%payment_control_inline_retry_order_not_payable%',
  'technical expiry wins under lock before another provider attempt');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) SELECT
  'cfa20000-0000-4000-8000-000000000099',
  'cfa00000-0000-4000-8000-000000000001',
  28, source.currency, 'pending_activation', now(), now() + interval '28 days'
FROM public.commerce_orders source
WHERE source.id = 'cfa10000-0000-4000-8000-000000000001';
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt
) VALUES (
  'cfa30000-0000-4000-8000-000000000099',
  'cfa20000-0000-4000-8000-000000000099',
  1, now(), 'planned', 'inline-cas-sub-cycle', 0
);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) SELECT
  'cfa40000-0000-4000-8000-000000000099',
  'cfa00000-0000-4000-8000-000000000001',
  source.currency, source.region_code, source.size_constraint,
  'pending_payment', 2599, 2599, 'subscription_cycle',
  'cfa20000-0000-4000-8000-000000000099',
  'cfa30000-0000-4000-8000-000000000099'
FROM public.commerce_orders source
WHERE source.id = 'cfa10000-0000-4000-8000-000000000001';
UPDATE public.subscription_cycles
   SET order_id = 'cfa40000-0000-4000-8000-000000000099'
 WHERE id = 'cfa30000-0000-4000-8000-000000000099';
CREATE TEMP TABLE _inline_sub_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'inline-cas-sub-intent', 'subscription_cycle',
  'cfa40000-0000-4000-8000-000000000099',
  'cfa20000-0000-4000-8000-000000000099',
  'cfa30000-0000-4000-8000-000000000099',
  2599, (SELECT currency FROM public.commerce_orders
          WHERE id = 'cfa40000-0000-4000-8000-000000000099'), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
CREATE TEMP TABLE _inline_sub_old AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'inline-cas-sub-old', (SELECT intent_id FROM _inline_sub_intent), 'tpay',
  'inline-cas-sub-old-provider', 'inline-cas-sub-old-fingerprint',
  'blik_recurring_activation', NULL, '{}'::jsonb
) AS response;
UPDATE public.commerce_payment_attempts SET status = 'failed'
 WHERE id = (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _inline_sub_old);
UPDATE public.commerce_payment_intents SET status = 'failed'
 WHERE id = (SELECT intent_id FROM _inline_sub_intent);

CREATE TEMP TABLE _inline_sub_retry AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'inline-cas-sub-valid', (SELECT intent_id FROM _inline_sub_intent), 'tpay',
  'inline-cas-sub-valid-provider', 'inline-cas-sub-valid-fingerprint',
  'blik_recurring_activation', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_sub_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000006',
    'purchaseContext', 'subscription_initial')
) AS response;
SELECT ok((SELECT response #>> '{paymentAttempt,id}' FROM _inline_sub_retry) IS NOT NULL,
  'pending_activation Model O flow admits the exact initial retry');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_attempts
  WHERE payment_intent_id = (SELECT intent_id FROM _inline_sub_intent)), 2,
  'valid subscription inline retry creates exactly one new attempt');

-- A separate coherent aggregate starts active. The active-lines guard is
-- UPDATE-only by contract; direct insertion isolates the inline admission
-- predicate without disabling a trigger or weakening lifecycle enforcement.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) SELECT
  'cfa20000-0000-4000-8000-000000000098',
  'cfa00000-0000-4000-8000-000000000001',
  28, source.currency, 'active', now(), now() + interval '28 days'
FROM public.commerce_orders source
WHERE source.id = 'cfa10000-0000-4000-8000-000000000001';
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt
) VALUES (
  'cfa30000-0000-4000-8000-000000000098',
  'cfa20000-0000-4000-8000-000000000098',
  1, now(), 'planned', 'inline-cas-active-cycle', 0
);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) SELECT
  'cfa40000-0000-4000-8000-000000000098',
  'cfa00000-0000-4000-8000-000000000001',
  source.currency, source.region_code, source.size_constraint,
  'pending_payment', 2599, 2599, 'subscription_cycle',
  'cfa20000-0000-4000-8000-000000000098',
  'cfa30000-0000-4000-8000-000000000098'
FROM public.commerce_orders source
WHERE source.id = 'cfa10000-0000-4000-8000-000000000001';
UPDATE public.subscription_cycles
   SET order_id = 'cfa40000-0000-4000-8000-000000000098'
 WHERE id = 'cfa30000-0000-4000-8000-000000000098';
CREATE TEMP TABLE _inline_active_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'inline-cas-active-intent', 'subscription_cycle',
  'cfa40000-0000-4000-8000-000000000098',
  'cfa20000-0000-4000-8000-000000000098',
  'cfa30000-0000-4000-8000-000000000098',
  2599, (SELECT currency FROM public.commerce_orders
          WHERE id = 'cfa40000-0000-4000-8000-000000000098'), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
CREATE TEMP TABLE _inline_active_old AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'inline-cas-active-old', (SELECT intent_id FROM _inline_active_intent), 'tpay',
  'inline-cas-active-old-provider', 'inline-cas-active-old-fingerprint',
  'blik_recurring_activation', NULL, '{}'::jsonb
) AS response;
UPDATE public.commerce_payment_attempts SET status = 'failed'
 WHERE id = (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _inline_active_old);
UPDATE public.commerce_payment_intents SET status = 'failed'
 WHERE id = (SELECT intent_id FROM _inline_active_intent);
SELECT throws_like($$SELECT public.commerce_payment_control_prepare_provider_attempt(
  'inline-cas-active-retry', (SELECT intent_id FROM _inline_active_intent), 'tpay',
  'inline-cas-active-provider', 'inline-cas-active-fingerprint',
  'blik_recurring_activation', NULL,
  jsonb_build_object('source', 'commerce.checkout-inline-recovery.prepare.v1',
    'expectedPaymentAttemptId', (SELECT response #>> '{paymentAttempt,id}' FROM _inline_active_old),
    'retryRequestId', 'cfa90000-0000-4000-8000-000000000005',
    'purchaseContext', 'subscription_initial')
)$$, '%payment_control_inline_retry_context_mismatch%',
  'inline first-cycle retry rejects an already-active subscription');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_attempts
  WHERE payment_intent_id = (SELECT intent_id FROM _inline_active_intent)), 1,
  'active subscription rejection creates no payment attempt');

SELECT * FROM finish();
ROLLBACK;
