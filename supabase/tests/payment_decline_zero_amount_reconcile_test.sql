-- pgTAP: a one-time card decline reconciles even when the provider event carries
-- amount_cents=0 — the amount-mismatch guard must not block a zero-amount failure.
--
-- Regression for the live preview incident (20260701120000 + stripeWebhookNormalizer):
--   * Stripe `payment_intent.payment_failed` reported `amount_received: 0`, so the
--     ingested event's amount_cents was 0. apply_result's amount-mismatch guard
--     RAISEd (0 <> order total) on every delivery, the webhook 503'd forever, the
--     intent stayed `processing`, and 24 units of stock stayed `reserved`.
--   * Fix: apply_result ignores a non-positive provider amount so the failure
--     reconciles cleanly (intent -> failed, event -> processed).
--
-- NOTE (20260709120000): a declined 'failed' one-time order is now RECOVERABLE —
-- the order stays `pending_payment` and the checkout hold is RETAINED so the buyer
-- can retry on the same order. The hold is released later by the reservation-expiry
-- sweep (or an 'expired' result), NOT inline on a decline. This test asserts that
-- recoverable shape; the inline-release-on-'expired' path is covered in
-- subscription_apply_result_guards_test.sql (A2b).
--
-- ALSO PINNED HERE (20260902144745): the guard that sits three lines above the
-- amount guard this file was written for — a result applies to the attempt the
-- provider event NAMES, never to whichever attempt happens to be active. The
-- fixture below is already the exact shape that hazard needs (an intent, an
-- attempt, and an event correlated to it by provider_attempt_id), so the
-- scenarios continue from the decline rather than rebuilding it. See the block
-- after the assertions above.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(44);

-- ---- Fixture --------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('c1000000-0000-0000-0000-000000000d01', 'decline-zero@example.invalid');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c4000000-0000-0000-0000-000000000d01', 'decline-zero-prod', 'Decline Zero Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('c5000000-0000-0000-0000-000000000d01', 'c4000000-0000-0000-0000-000000000d01', 'DZ-SKU-1', 'DZ SKU 1', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('c6000000-0000-0000-0000-000000000d01', 'dz-loc', 'DZ Loc', 'virtual', 'active', true);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES ('d0000000-0000-0000-0000-000000000d01', 'c1000000-0000-0000-0000-000000000d01', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 33972, 33972, 'one_time');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('d1000000-0000-0000-0000-000000000d01', 'd0000000-0000-0000-0000-000000000d01', 'c5000000-0000-0000-0000-000000000d01',
        24, 1416, 33972, 0, 33972, round((33972)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"DZ-SKU-1"}'::jsonb);

-- Intent + attempt. The attempt's provider_attempt_id ('pi_declined') is the
-- linkage key the ingest event correlates against.
CREATE TEMP TABLE _dz AS
SELECT (public.commerce_payment_control_create_intent(
  'dz-intent-key-0001', 'one_time_order', 'd0000000-0000-0000-0000-000000000d01',
  NULL, NULL, 33972, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.commerce_payment_control_record_attempt(
  'dz-attempt-key-0001', (SELECT intent_id FROM _dz), 'stripe', 'pi_declined', 'ps_dz',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);

-- Two open checkout holds for the order.
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES
  ('d2e10000-0000-0000-0000-000000000d01', 'dz-resv-key-1', 'd0000000-0000-0000-0000-000000000d01',
   'c5000000-0000-0000-0000-000000000d01', 'c6000000-0000-0000-0000-000000000d01', 12, 'reserved', 'checkout_payment_window'),
  ('d2e20000-0000-0000-0000-000000000d01', 'dz-resv-key-2', 'd0000000-0000-0000-0000-000000000d01',
   'c5000000-0000-0000-0000-000000000d01', 'c6000000-0000-0000-0000-000000000d01', 12, 'reserved', 'checkout_payment_window');

-- Ingest a payment.failed event with amount_cents = 0 (the declined-PI shape).
-- It must correlate to the attempt by provider_payment_id.
CREATE TEMP TABLE _dze AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  (e -> 'paymentEvent' ->> 'paymentIntentId')::uuid AS event_intent_id
FROM (
  SELECT public.commerce_payment_control_ingest_event(
    'stripe', 'evt_dz_failed_0001', 'payment.failed', 'pi_declined',
    NULL, NULL, 0, 'PLN', true,
    '{"provider":"stripe","amountMinor":0}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_intent_id FROM _dze), (SELECT intent_id FROM _dz),
  'ingest correlates the amount=0 event to the intent via provider_payment_id');

-- Apply the failure. Pre-fix this RAISEd payment_control_result_amount_mismatch.
SELECT lives_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-apply-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dze),
       'failed', '2026-06-20T09:38:07Z'::timestamptz, 'provider_webhook_failed') $$,
  'apply_result does not raise on a zero-amount failed event');

SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  'failed', 'the declined attempt marks the intent failed');
SELECT is((SELECT status FROM public.commerce_orders WHERE id='d0000000-0000-0000-0000-000000000d01'),
  'pending_payment', 'recoverable decline: one-time order stays pending_payment');
SELECT is((SELECT count(*)::int FROM public.inventory_reservations
            WHERE order_id='d0000000-0000-0000-0000-000000000d01' AND status='reserved'),
  2, 'recoverable decline: both checkout holds are RETAINED');
SELECT is((SELECT count(*)::int FROM public.inventory_reservations
            WHERE order_id='d0000000-0000-0000-0000-000000000d01' AND status='released'),
  0, 'recoverable decline: no holds released inline on a decline');
SELECT is((SELECT processing_status FROM public.inbound_provider_events WHERE id=(SELECT event_id FROM _dze)),
  'processed', 'inbound event marked processed');

SELECT lives_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-apply-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dze),
       'failed', '2026-06-20T09:38:07Z'::timestamptz, 'provider_webhook_failed') $$,
  'the exact correlated result replay remains idempotent');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_state_transitions
            WHERE provider_event_id = (SELECT event_id FROM _dze)
              AND transition_kind = 'business_result'),
  1, 'the exact replay does not duplicate its payment state transition');

-- ===========================================================================
-- A result applies to the attempt the provider event NAMES, not to whichever
-- attempt is currently active.
--
-- The body resolves its attempt as `WHERE id = v_intent.active_attempt_id`, but
-- the inbound event already knows better: `ingest_event` correlates it to an
-- attempt by `(provider, provider_attempt_id)` and stores the answer in
-- `inbound_provider_events.payment_attempt_id`. Until the guard below existed
-- nothing compared the two, so a webhook that was merely SLOW stamped attempt
-- one's verdict onto attempt two -- two live charges, one settled order, one
-- confirmation, and no anomaly row anywhere.
--
-- Three shapes are pinned, and the first of them is already above: the apply at
-- `dz-apply-key-0001` is an event naming the ACTIVE attempt, and it still
-- applies and still marks the event `processed`. What follows adds the other
-- two -- an event naming a NON-active attempt must refuse, and a call carrying
-- no event at all (the reconciliation rail, which passes
-- `p_payment_event_id => NULL` and therefore never loads an event row) must
-- still apply.
-- ===========================================================================

CREATE TEMP TABLE _dz_attempt_a AS
SELECT id AS attempt_id FROM public.commerce_payment_attempts WHERE provider_attempt_id = 'pi_declined';

SELECT is((SELECT payment_attempt_id FROM public.inbound_provider_events WHERE id=(SELECT event_id FROM _dze)),
  (SELECT attempt_id FROM _dz_attempt_a),
  'ingest correlated the event to the attempt it NAMES, not to a moving target');
SELECT is((SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  (SELECT attempt_id FROM _dz_attempt_a),
  'the apply above was an event naming the ACTIVE attempt, and it applied');

-- The decline left the intent `failed`, which is retryable: a second provider
-- attempt is recorded and takes over as the intent's active attempt. The
-- already-processed event now names the PREVIOUS one.
CREATE TEMP TABLE _dz_attempt_b AS
SELECT (public.commerce_payment_control_record_attempt(
  'dz-attempt-key-0002', (SELECT intent_id FROM _dz), 'stripe', 'pi_attempt_b', 'ps_dz_b',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb) -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id;

SELECT isnt((SELECT attempt_id FROM _dz_attempt_b), (SELECT attempt_id FROM _dz_attempt_a),
  'the retry is a second, distinct payment attempt');
SELECT is((SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  (SELECT attempt_id FROM _dz_attempt_b),
  'the retry is now the intent active attempt');

-- Tpay can supply a known intent in tr_crc while its provider transaction id
-- matches no local attempt. The evidence row is valid and durable, but neither
-- a success nor a non-money-moved failure may borrow the moving active attempt.
CREATE TEMP TABLE _dz_unresolved_failed AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  (e -> 'paymentEvent' ->> 'paymentIntentId')::uuid AS event_intent_id,
  NULLIF(e -> 'paymentEvent' ->> 'paymentAttemptId', '')::uuid AS event_attempt_id
FROM (
  SELECT public.commerce_payment_control_ingest_event(
    'tpay', 'evt_dz_unresolved_failed', 'payment.failed', 'unmatched_failed_tx',
    (SELECT intent_id FROM _dz), NULL, 0, NULL, true,
    '{"provider":"tpay","eventKind":"transaction"}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_intent_id FROM _dz_unresolved_failed), (SELECT intent_id FROM _dz),
  'the failed event retains its supplied local intent identity');
SELECT is((SELECT event_attempt_id FROM _dz_unresolved_failed), NULL::uuid,
  'the failed event honestly retains unresolved attempt attribution');
SELECT throws_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-unresolved-failed-key', (SELECT intent_id FROM _dz),
       (SELECT event_id FROM _dz_unresolved_failed), 'failed',
       '2026-06-20T09:43:00Z'::timestamptz, 'provider_webhook_failed') $$,
  '22023', 'payment_control_result_attempt_unresolved',
  'an event-present failed result cannot borrow the active attempt');
SELECT is((SELECT processing_status FROM public.inbound_provider_events
            WHERE id = (SELECT event_id FROM _dz_unresolved_failed)),
  'received', 'the unresolved failed event remains durable for recovery');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  'processing', 'the unresolved failed result does not mutate the intent');
SELECT is((SELECT status FROM public.commerce_payment_attempts WHERE id=(SELECT attempt_id FROM _dz_attempt_b)),
  'processing', 'the unresolved failed result does not mutate the active attempt');
SELECT is((SELECT count(*)::int FROM public.commerce_idempotency_keys
            WHERE idempotency_key = 'dz-unresolved-failed-key'),
  0, 'the unresolved failed result leaves no idempotency write');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_state_transitions
            WHERE provider_event_id = (SELECT event_id FROM _dz_unresolved_failed)),
  0, 'the unresolved failed result leaves no business transition');

CREATE TEMP TABLE _dz_unresolved_succeeded AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  (e -> 'paymentEvent' ->> 'paymentIntentId')::uuid AS event_intent_id,
  NULLIF(e -> 'paymentEvent' ->> 'paymentAttemptId', '')::uuid AS event_attempt_id
FROM (
  SELECT public.commerce_payment_control_ingest_event(
    'tpay', 'evt_dz_unresolved_succeeded', 'payment.succeeded', 'unmatched_success_tx',
    (SELECT intent_id FROM _dz), NULL, 33972, NULL, true,
    '{"provider":"tpay","eventKind":"transaction"}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_intent_id FROM _dz_unresolved_succeeded), (SELECT intent_id FROM _dz),
  'the succeeded event retains its supplied local intent identity');
SELECT is((SELECT event_attempt_id FROM _dz_unresolved_succeeded), NULL::uuid,
  'the succeeded event honestly retains unresolved attempt attribution');
SELECT throws_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-unresolved-succeeded-key', (SELECT intent_id FROM _dz),
       (SELECT event_id FROM _dz_unresolved_succeeded), 'succeeded',
       '2026-06-20T09:44:00Z'::timestamptz, NULL) $$,
  '22023', 'payment_control_result_attempt_unresolved',
  'an event-present succeeded result cannot borrow the active attempt');
SELECT is((SELECT processing_status FROM public.inbound_provider_events
            WHERE id = (SELECT event_id FROM _dz_unresolved_succeeded)),
  'received', 'the unresolved succeeded event remains durable for recovery');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  'processing', 'the unresolved succeeded result does not mutate the intent');
SELECT is((SELECT status FROM public.commerce_payment_attempts WHERE id=(SELECT attempt_id FROM _dz_attempt_b)),
  'processing', 'the unresolved succeeded result does not mutate the active attempt');
SELECT is((SELECT count(*)::int FROM public.commerce_idempotency_keys
            WHERE idempotency_key = 'dz-unresolved-succeeded-key'),
  0, 'the unresolved succeeded result leaves no idempotency write');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_state_transitions
            WHERE provider_event_id = (SELECT event_id FROM _dz_unresolved_succeeded)),
  0, 'the unresolved succeeded result leaves no business transition');

-- The late redelivery of the first attempt's event, with the second one active.
-- Pre-fix this applied cleanly and settled the SECOND attempt as `succeeded`.
SELECT throws_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-mismatch-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dze),
       'succeeded', '2026-06-20T09:45:00Z'::timestamptz, NULL) $$,
  '22023', 'payment_control_result_attempt_mismatch',
  'a result naming a non-active attempt raises the named attempt mismatch');

SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  'processing', 'the refused redelivery does not settle the intent onto the active attempt');
SELECT is((SELECT count(*)::int FROM public.commerce_idempotency_keys
            WHERE idempotency_key = 'dz-mismatch-key-0001'),
  0, 'the refused redelivery leaves no half-applied idempotency row');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_state_transitions
            WHERE payment_attempt_id = (SELECT attempt_id FROM _dz_attempt_b)
              AND transition_kind = 'business_result'),
  0, 'the refused redelivery writes no business result onto the active attempt');

-- The reconciliation shape: no provider event at all, so the guard reads a row
-- that is never loaded. This rail must be untouched by the refusal above.
SELECT lives_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-reconcile-key-0001', (SELECT intent_id FROM _dz), NULL,
       'failed', '2026-06-20T09:50:00Z'::timestamptz, 'provider_reconciliation_failed') $$,
  'a result carrying no provider event still applies (the reconciliation rail)');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  'failed', 'the event-less reconciliation result settles the active attempt');

-- A fresh event naming the current attempt still applies a successful money
-- result once, and an identical delivery replays that exact committed result.
CREATE TEMP TABLE _dz_attempt_c AS
SELECT (public.commerce_payment_control_record_attempt(
  'dz-attempt-key-0003', (SELECT intent_id FROM _dz), 'stripe', 'pi_attempt_c', 'ps_dz_c',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb) -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id;

SELECT is((SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  (SELECT attempt_id FROM _dz_attempt_c),
  'the final retry is the active attempt for the correlated success');

CREATE TEMP TABLE _dz_success AS
SELECT
  (e -> 'paymentEvent' ->> 'id')::uuid AS event_id,
  NULLIF(e -> 'paymentEvent' ->> 'paymentAttemptId', '')::uuid AS event_attempt_id
FROM (
  SELECT public.commerce_payment_control_ingest_event(
    'stripe', 'evt_dz_succeeded_0001', 'payment.succeeded', 'pi_attempt_c',
    NULL, NULL, 33972,
    (SELECT currency FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _dz)),
    true,
    '{"provider":"stripe","amountMinor":33972}'::jsonb
  ) AS e
) s;

SELECT is((SELECT event_attempt_id FROM _dz_success), (SELECT attempt_id FROM _dz_attempt_c),
  'the successful event resolves to its exact active attempt');
SELECT lives_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-success-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dz_success),
       'succeeded', '2026-06-20T09:55:00Z'::timestamptz, NULL) $$,
  'an event naming the exact active attempt applies successfully');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _dz)),
  'succeeded', 'the correlated success settles the intended intent');
SELECT is((SELECT status FROM public.commerce_orders
            WHERE id='d0000000-0000-0000-0000-000000000d01'),
  'paid', 'the correlated success performs the intended order transition');
SELECT is((SELECT processing_status FROM public.inbound_provider_events
            WHERE id=(SELECT event_id FROM _dz_success)),
  'processed', 'the correlated successful event is marked processed');
SELECT lives_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'dz-success-key-0001', (SELECT intent_id FROM _dz), (SELECT event_id FROM _dz_success),
       'succeeded', '2026-06-20T09:55:00Z'::timestamptz, NULL) $$,
  'the identical correlated success replays without a second mutation');
SELECT is((SELECT status FROM public.commerce_idempotency_keys
            WHERE scope='commerce.payment_result.apply'
              AND idempotency_key='dz-success-key-0001'),
  'completed', 'the successful result retains one completed idempotency decision');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_state_transitions
            WHERE provider_event_id=(SELECT event_id FROM _dz_success)
              AND transition_kind='business_result'),
  1, 'the successful replay does not duplicate its business transition');

SELECT * FROM finish();
ROLLBACK;
