-- Native amount and exact-attribution assertions retained from the managed witness.

BEGIN;
SELECT plan(44);
INSERT INTO public.clients (id, email)
VALUES ('c1000000-0000-0000-0000-000000000d01', 'decline-zero@example.invalid');
SELECT pg_temp.provider_order('d0000000-0000-0000-0000-000000000d01','c1000000-0000-0000-0000-000000000d01',33972);
CREATE TEMP TABLE _dz AS
SELECT (pg_temp.provider_intent(
  'dz-intent-key-0001', 'one_time_order', 'd0000000-0000-0000-0000-000000000d01',
  NULL, NULL, 33972, 'XXX', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.payment_provider_attempt_record(
  'dz-attempt-key-0001', (SELECT intent_id FROM _dz), 'card_rail', 'pi_declined', 'ps_dz',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
INSERT INTO public.fulfillment_inventory_reservations(purchase_order_id,operation_fingerprint,source_key,status,expires_at)
SELECT 'd0000000-0000-0000-0000-000000000d01',repeat('a',64),'fixture','held',now()+interval '1 day' FROM generate_series(1,2);
CREATE TEMP TABLE _dze AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  (e -> 'paymentEvent' ->> 'paymentIntentId')::uuid AS event_intent_id
FROM (
  SELECT public.payment_provider_event_ingest(
    'card_rail', 'evt_dz_failed_0001', 'payment.failed', 'pi_declined',
    NULL, NULL, 0, 'XXX', true,
    '{"provider":"card_rail","amountMinor":0}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_intent_id FROM _dze), (SELECT intent_id FROM _dz),
  'ingest correlates the amount=0 event to the intent via provider_payment_id');
SELECT lives_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-apply-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dze),
       'failed', '2026-06-20T09:38:07Z'::timestamptz, 'provider_webhook_failed') $$,
  'apply_result does not raise on a zero-amount failed event');

SELECT is((SELECT status FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  'failed', 'the declined attempt marks the intent failed');
SELECT is((SELECT status FROM public.commerce_orders WHERE id='d0000000-0000-0000-0000-000000000d01'),
  'pending_payment', 'recoverable decline: one-time order stays pending_payment');
SELECT is((SELECT count(*)::int FROM public.fulfillment_inventory_reservations
            WHERE purchase_order_id='d0000000-0000-0000-0000-000000000d01' AND status='held'),
  2, 'recoverable decline: both checkout holds are RETAINED');
SELECT is((SELECT count(*)::int FROM public.fulfillment_inventory_reservations
            WHERE purchase_order_id='d0000000-0000-0000-0000-000000000d01' AND status='released'),
  0, 'recoverable decline: no holds released inline on a decline');
SELECT is((SELECT processing_status FROM public.payment_provider_attempt_evidence WHERE id=(SELECT event_id FROM _dze)),
  'processed', 'inbound event marked processed');

SELECT lives_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-apply-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dze),
       'failed', '2026-06-20T09:38:07Z'::timestamptz, 'provider_webhook_failed') $$,
  'the exact correlated result replay remains idempotent');
SELECT is((SELECT count(*)::int FROM public.payment_provider_transitions
            WHERE provider_event_id = (SELECT event_id FROM _dze)
              AND transition_kind = 'business_result'),
  1, 'the exact replay does not duplicate its payment state transition');

CREATE TEMP TABLE _dz_attempt_a AS
SELECT id AS attempt_id FROM public.payment_provider_attempts WHERE provider_attempt_id = 'pi_declined';

SELECT is((SELECT payment_attempt_id FROM public.payment_provider_attempt_evidence WHERE id=(SELECT event_id FROM _dze)),
  (SELECT attempt_id FROM _dz_attempt_a),
  'ingest correlated the event to the attempt it NAMES, not to a moving target');
SELECT is((SELECT active_attempt_id FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  (SELECT attempt_id FROM _dz_attempt_a),
  'the apply above was an event naming the ACTIVE attempt, and it applied');
CREATE TEMP TABLE _dz_attempt_b AS
SELECT (public.payment_provider_attempt_record(
  'dz-attempt-key-0002', (SELECT intent_id FROM _dz), 'card_rail', 'pi_attempt_b', 'ps_dz_b',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb) -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id;

SELECT isnt((SELECT attempt_id FROM _dz_attempt_b), (SELECT attempt_id FROM _dz_attempt_a),
  'the retry is a second, distinct payment attempt');
SELECT is((SELECT active_attempt_id FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  (SELECT attempt_id FROM _dz_attempt_b),
  'the retry is now the intent active attempt');
CREATE TEMP TABLE _dz_unresolved_failed AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  (e -> 'paymentEvent' ->> 'paymentIntentId')::uuid AS event_intent_id,
  NULLIF(e -> 'paymentEvent' ->> 'paymentAttemptId', '')::uuid AS event_attempt_id
FROM (
  SELECT public.payment_provider_event_ingest(
    'transfer_rail', 'evt_dz_unresolved_failed', 'payment.failed', 'unmatched_failed_tx',
    (SELECT intent_id FROM _dz), NULL, 0, NULL, true,
    '{"provider":"transfer_rail","eventKind":"transaction"}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_intent_id FROM _dz_unresolved_failed), (SELECT intent_id FROM _dz),
  'the failed event retains its supplied local intent identity');
SELECT is((SELECT event_attempt_id FROM _dz_unresolved_failed), NULL::uuid,
  'the failed event honestly retains unresolved attempt attribution');
SELECT throws_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-unresolved-failed-key', (SELECT intent_id FROM _dz),
       (SELECT event_id FROM _dz_unresolved_failed), 'failed',
       '2026-06-20T09:43:00Z'::timestamptz, 'provider_webhook_failed') $$,
  '22023', 'payment_control_result_attempt_unresolved',
  'an event-present failed result cannot borrow the active attempt');
SELECT is((SELECT processing_status FROM public.payment_provider_attempt_evidence
            WHERE id = (SELECT event_id FROM _dz_unresolved_failed)),
  'received', 'the unresolved failed event remains durable for recovery');
SELECT is((SELECT status FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  'processing', 'the unresolved failed result does not mutate the intent');
SELECT is((SELECT status FROM public.payment_provider_attempts WHERE id=(SELECT attempt_id FROM _dz_attempt_b)),
  'processing', 'the unresolved failed result does not mutate the active attempt');
SELECT is((SELECT count(*)::int FROM public.payment_provider_receipts
            WHERE idempotency_key = 'dz-unresolved-failed-key'),
  0, 'the unresolved failed result leaves no idempotency write');
SELECT is((SELECT count(*)::int FROM public.payment_provider_transitions
            WHERE provider_event_id = (SELECT event_id FROM _dz_unresolved_failed)),
  0, 'the unresolved failed result leaves no business transition');

CREATE TEMP TABLE _dz_unresolved_succeeded AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  (e -> 'paymentEvent' ->> 'paymentIntentId')::uuid AS event_intent_id,
  NULLIF(e -> 'paymentEvent' ->> 'paymentAttemptId', '')::uuid AS event_attempt_id
FROM (
  SELECT public.payment_provider_event_ingest(
    'transfer_rail', 'evt_dz_unresolved_succeeded', 'payment.succeeded', 'unmatched_success_tx',
    (SELECT intent_id FROM _dz), NULL, 33972, NULL, true,
    '{"provider":"transfer_rail","eventKind":"transaction"}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_intent_id FROM _dz_unresolved_succeeded), (SELECT intent_id FROM _dz),
  'the succeeded event retains its supplied local intent identity');
SELECT is((SELECT event_attempt_id FROM _dz_unresolved_succeeded), NULL::uuid,
  'the succeeded event honestly retains unresolved attempt attribution');
SELECT throws_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-unresolved-succeeded-key', (SELECT intent_id FROM _dz),
       (SELECT event_id FROM _dz_unresolved_succeeded), 'succeeded',
       '2026-06-20T09:44:00Z'::timestamptz, NULL) $$,
  '22023', 'payment_control_result_attempt_unresolved',
  'an event-present succeeded result cannot borrow the active attempt');
SELECT is((SELECT processing_status FROM public.payment_provider_attempt_evidence
            WHERE id = (SELECT event_id FROM _dz_unresolved_succeeded)),
  'received', 'the unresolved succeeded event remains durable for recovery');
SELECT is((SELECT status FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  'processing', 'the unresolved succeeded result does not mutate the intent');
SELECT is((SELECT status FROM public.payment_provider_attempts WHERE id=(SELECT attempt_id FROM _dz_attempt_b)),
  'processing', 'the unresolved succeeded result does not mutate the active attempt');
SELECT is((SELECT count(*)::int FROM public.payment_provider_receipts
            WHERE idempotency_key = 'dz-unresolved-succeeded-key'),
  0, 'the unresolved succeeded result leaves no idempotency write');
SELECT is((SELECT count(*)::int FROM public.payment_provider_transitions
            WHERE provider_event_id = (SELECT event_id FROM _dz_unresolved_succeeded)),
  0, 'the unresolved succeeded result leaves no business transition');
SELECT throws_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-mismatch-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dze),
       'succeeded', '2026-06-20T09:45:00Z'::timestamptz, NULL) $$,
  '22023', 'payment_control_result_attempt_mismatch',
  'a result naming a non-active attempt raises the named attempt mismatch');

SELECT is((SELECT status FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  'processing', 'the refused redelivery does not settle the intent onto the active attempt');
SELECT is((SELECT count(*)::int FROM public.payment_provider_receipts
            WHERE idempotency_key = 'dz-mismatch-key-0001'),
  0, 'the refused redelivery leaves no half-applied idempotency row');
SELECT is((SELECT count(*)::int FROM public.payment_provider_transitions
            WHERE payment_attempt_id = (SELECT attempt_id FROM _dz_attempt_b)
              AND transition_kind = 'business_result'),
  0, 'the refused redelivery writes no business result onto the active attempt');
SELECT lives_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-reconcile-key-0001', (SELECT intent_id FROM _dz), NULL,
       'failed', '2026-06-20T09:50:00Z'::timestamptz, 'provider_reconciliation_failed') $$,
  'a result carrying no provider event still applies (the reconciliation rail)');
SELECT is((SELECT status FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  'failed', 'the event-less reconciliation result settles the active attempt');
CREATE TEMP TABLE _dz_attempt_c AS
SELECT (public.payment_provider_attempt_record(
  'dz-attempt-key-0003', (SELECT intent_id FROM _dz), 'card_rail', 'pi_attempt_c', 'ps_dz_c',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb) -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id;

SELECT is((SELECT active_attempt_id FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  (SELECT attempt_id FROM _dz_attempt_c),
  'the final retry is the active attempt for the correlated success');

CREATE TEMP TABLE _dz_success AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  NULLIF(e -> 'paymentEvent' ->> 'paymentAttemptId', '')::uuid AS event_attempt_id
FROM (
  SELECT public.payment_provider_event_ingest(
    'card_rail', 'evt_dz_succeeded_0001', 'payment.succeeded', 'pi_attempt_c',
    NULL, NULL, 33972,
    (SELECT currency_code FROM public.commerce_settlement_intents WHERE id = (SELECT intent_id FROM _dz)),
    true,
    '{"provider":"card_rail","amountMinor":33972}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_attempt_id FROM _dz_success), (SELECT attempt_id FROM _dz_attempt_c),
  'the successful event resolves to its exact active attempt');
SELECT lives_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-success-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dz_success),
       'succeeded', '2026-06-20T09:55:00Z'::timestamptz, NULL) $$,
  'an event naming the exact active attempt applies successfully');
SELECT is((SELECT status FROM public.payment_provider_states WHERE id=(SELECT intent_id FROM _dz)),
  'succeeded', 'the correlated success settles the intended intent');
SELECT is((SELECT status FROM public.commerce_orders
            WHERE id='d0000000-0000-0000-0000-000000000d01'),
  'paid', 'the correlated success performs the intended order transition');
SELECT is((SELECT processing_status FROM public.payment_provider_attempt_evidence
            WHERE id=(SELECT event_id FROM _dz_success)),
  'processed', 'the correlated successful event is marked processed');
SELECT lives_ok(
  $$ SELECT pg_temp.provider_apply(
       'dz-success-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dz_success),
       'succeeded', '2026-06-20T09:55:00Z'::timestamptz, NULL) $$,
  'the identical correlated success replays without a second mutation');
SELECT is((SELECT status FROM public.payment_provider_receipts
            WHERE scope='commerce.payment_result.apply'
              AND idempotency_key='dz-success-key-0001'),
  'completed', 'the successful result retains one completed idempotency decision');
SELECT is((SELECT count(*)::int FROM public.payment_provider_transitions
            WHERE provider_event_id=(SELECT event_id FROM _dz_success)
              AND transition_kind='business_result'),
  1, 'the successful replay does not duplicate its business transition');

SELECT * FROM finish();
ROLLBACK;
