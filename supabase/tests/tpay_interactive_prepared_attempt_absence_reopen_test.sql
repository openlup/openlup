-- pgTAP: separate interactive Tpay prepared-attempt reopen boundary.
-- It terminalizes only provably-not-dispatched local checkout attempts; the
-- renewal retry boundary remains out of scope and must not be reused here.

BEGIN;
SELECT plan(55);
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;
CREATE TEMP TABLE _money AS SELECT 'PLN'::text AS code;

INSERT INTO public.clients (id, email)
VALUES ('fa100000-0000-4000-8000-000000000001', 'interactive-prepared@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('fa110000-0000-4000-8000-000000000001', 'fa100000-0000-4000-8000-000000000001', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('fa120000-0000-4000-8000-000000000001', 'fa100000-0000-4000-8000-000000000001', 'shipping', 'Testowa 15', 'Warszawa', '00-015');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('fa130000-0000-4000-8000-000000000001', 'interactive-prepared-product', 'Interactive Prepared Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('fa140000-0000-4000-8000-000000000001', 'fa130000-0000-4000-8000-000000000001', 'INTERACTIVE-PREPARED-SKU', 'Interactive Prepared SKU', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('fa150000-0000-4000-8000-000000000001', 'interactive-prepared-loc', 'Interactive Prepared Location', 'virtual', 'active', true);

INSERT INTO public.commerce_orders (
  id, client_id, size_constraint, status, total_cents, subtotal_cents
) VALUES (
  'fa160000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001',
  '{"kind":"feeding_days","value":28}'::jsonb, 'draft', 14900, 14900
);
INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
) VALUES (
  'fa170000-0000-4000-8000-000000000001',
  'fa160000-0000-4000-8000-000000000001',
  'fa140000-0000-4000-8000-000000000001',
  1, 14900, 14900, 0, 14900, round((14900)::numeric * 10000 / 10800)::integer,
  '{"sku":"INTERACTIVE-PREPARED-SKU"}'::jsonb
);

CREATE TEMP TABLE _subscription AS
SELECT
  (result->>'subscriptionId')::uuid AS subscription_id,
  (result->>'subscriptionCycleId')::uuid AS cycle_id
FROM (
  SELECT public.subscription_create_provisional_for_checkout(
    'fa160000-0000-4000-8000-000000000001',
    'fa100000-0000-4000-8000-000000000001',
    'fa110000-0000-4000-8000-000000000001',
    'fa120000-0000-4000-8000-000000000001',
    '{"quote":{"context":{"mode":"subscription","cadenceDays":28}}}'::jsonb
  ) AS result
) AS provisional;

UPDATE public.commerce_orders
   SET mode = 'subscription_cycle',
       subscription_id = (SELECT subscription_id FROM _subscription),
       subscription_cycle_id = (SELECT cycle_id FROM _subscription),
       metadata = jsonb_build_object(
         'runtimeFinalize', jsonb_build_object(
           'checkoutKind', 'subscription_initial',
           'checkoutIntent', 'subscription_initial',
           'source', 'commerce.runtime.hidden.v0'
         )
       )
 WHERE id = 'fa160000-0000-4000-8000-000000000001';

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'interactive-prepared-intent-0001',
  'subscription_cycle',
  'fa160000-0000-4000-8000-000000000001',
  (SELECT subscription_id FROM _subscription),
  (SELECT cycle_id FROM _subscription),
  14900,
  (SELECT code FROM _money),
  '{"checkoutKind":"subscription_initial","checkoutIntent":"subscription_initial","source":"commerce.runtime.hidden.v0"}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _prepared AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'interactive-prepared-prepare-0001',
  (SELECT intent_id FROM _intent),
  'tpay',
  'openlup:tpay:interactive-prepared:attempt:0',
  format('tpay|interactive|14900|%s|subscription_initial|0', (SELECT code FROM _money)),
  'blik_recurring_activation',
  NULL,
  jsonb_build_object(
    'source', 'commerce.runtime.provider-attempt.prepare.v0',
    'amountMinor', 14900,
    'currency', (SELECT code FROM _money)
  )
) AS response;
CREATE TEMP TABLE _attempt AS
SELECT (response -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id FROM _prepared;

INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, subscription_cycle_id, sku_id, location_id, quantity, status, kind)
VALUES (
  'fa180000-0000-4000-8000-000000000001',
  'interactive-prepared-reservation-0001',
  'fa160000-0000-4000-8000-000000000001',
  (SELECT cycle_id FROM _subscription),
  'fa140000-0000-4000-8000-000000000001',
  'fa150000-0000-4000-8000-000000000001',
  1, 'reserved', 'checkout_payment_window'
);

SELECT is(
  (SELECT response #>> '{paymentAttempt,status}' FROM _prepared),
  'created',
  'fixture is a Tpay durable prepared attempt'
);
WITH public_source AS (
  SELECT pg_get_functiondef(
    'public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)'::regprocedure
  ) AS body
), sealed_source AS (
  SELECT pg_get_functiondef(
    'public.commerce_payment_reopen_interactive_sealed_v1(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)'::regprocedure
  ) AS body
)
SELECT ok(
  strpos(public_source.body, 'FROM public.subscriptions')
    < strpos(public_source.body, 'FROM public.commerce_orders')
  AND strpos(public_source.body, 'FROM public.commerce_orders')
    < strpos(public_source.body, 'INTO v_locked_intent')
  AND strpos(public_source.body, 'INTO v_locked_intent')
    < strpos(public_source.body, 'commerce_payment_reopen_interactive_sealed_v1')
  AND strpos(sealed_source.body, 'pg_advisory_xact_lock')
    < strpos(sealed_source.body, 'FROM public.commerce_idempotency_keys')
  AND strpos(sealed_source.body, 'FROM public.commerce_payment_intents')
    < strpos(sealed_source.body, 'FROM public.commerce_payment_attempts')
  AND strpos(sealed_source.body, 'FROM public.commerce_payment_attempts')
    < strpos(sealed_source.body, 'FROM public.subscription_cycles')
  AND strpos(sealed_source.body, 'FROM public.subscription_cycles')
    < strpos(sealed_source.body, 'FROM public.commerce_orders')
  AND strpos(sealed_source.body, 'FROM public.commerce_orders')
    < strpos(sealed_source.body, 'FROM public.commerce_payments'),
  'public root wrapper precedes the sealed duplicate-receipt and child lock order'
)
FROM public_source CROSS JOIN sealed_source;

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-manual-no-ledger', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'manual_provider_absence', 'provider_absence_confirmed', 'operator_reconciliation', 'operator_verified_absence',
      'ops-ticket-101', now(),
      '{"providerAbsenceConfirmed":true,"watchdogEvidence":true,"evidenceCode":"operator_verified_absence"}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_watchdog_evidence_missing',
  'manual true flag without durable exact-attempt watchdog ledger is refused'
);

INSERT INTO public.commerce_payment_attempts (
  id, payment_intent_id, payment_id, provider, idempotency_key, status, amount_cents, request_payload, response_payload
) VALUES (
  'fa190000-0000-4000-8000-000000000001', (SELECT intent_id FROM _intent),
  (SELECT payment_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)),
  'tpay', 'interactive-prepared-other-attempt-0001', 'failed', 14900, '{}'::jsonb, '{}'::jsonb
);
SELECT public.commerce_payment_control_record_reconciliation(
  'interactive-prepared-other-watchdog-0001', 'tpay', NULL, (SELECT intent_id FROM _intent),
  'fa190000-0000-4000-8000-000000000001', 'created', 'prepared_without_provider_ack', 'observed', now(), '{}'::jsonb
);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-manual-wrong-ledger', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'manual_provider_absence', 'provider_absence_confirmed', 'operator_reconciliation', 'operator_verified_absence',
      'ops-ticket-102', now(),
      '{"providerAbsenceConfirmed":true,"watchdogEvidence":true,"evidenceCode":"operator_verified_absence"}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_watchdog_evidence_missing',
  'watchdog ledger for a different attempt is not proof'
);

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-sensitive-evidence', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'manual_provider_absence', 'provider_absence_confirmed', 'operator_reconciliation', 'operator_verified_absence',
      'ops-ticket-103', now(),
      '{"providerAbsenceConfirmed":true,"watchdogEvidence":true,"evidenceCode":"operator_verified_absence","paymentMethodRef":"forbidden"}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_sensitive_evidence',
  'manual evidence rejects provider/customer/payment-secret material'
);

SELECT public.commerce_payment_control_record_reconciliation(
  'interactive-prepared-exact-watchdog-0001', 'tpay', NULL, (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt), 'created', 'prepared_without_provider_ack', 'observed', now(), '{}'::jsonb
);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-manual-too-fresh', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'manual_provider_absence', 'provider_absence_confirmed', 'operator_reconciliation', 'operator_verified_absence',
      'ops-ticket-104', now(),
      '{"providerAbsenceConfirmed":true,"watchdogEvidence":true,"evidenceCode":"operator_verified_absence"}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_too_fresh',
  'manual reopen enforces the 30 minute local-age floor after durable evidence'
);

UPDATE public.commerce_payment_attempts
   SET provider_attempt_id = 'tpay-ref-already-present'
 WHERE id = (SELECT attempt_id FROM _attempt);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-provider-ref', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_provider_ref_exists',
  'trusted reopen rejects a local provider reference'
);
UPDATE public.commerce_payment_attempts SET provider_attempt_id = NULL WHERE id = (SELECT attempt_id FROM _attempt);

UPDATE public.commerce_payment_attempts
   SET response_payload = response_payload || '{"providerCall":true}'::jsonb
 WHERE id = (SELECT attempt_id FROM _attempt);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-provider-call', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_provider_call_recorded',
  'trusted reopen rejects a recorded provider call'
);
UPDATE public.commerce_payment_attempts
   SET response_payload = jsonb_set(response_payload, '{providerCall}', 'false'::jsonb)
 WHERE id = (SELECT attempt_id FROM _attempt);

INSERT INTO public.inbound_provider_events (
  provider, provider_event_id, event_type, processing_status, payload, error,
  payment_intent_id, payment_attempt_id, provider_payment_id, amount_cents,
  signature_verified, received_via
) VALUES (
  'tpay', 'interactive-prepared-event-block', 'payment.succeeded', 'received', '{}'::jsonb, '{}'::jsonb,
  (SELECT intent_id FROM _intent), (SELECT attempt_id FROM _attempt), NULL, 14900, true, 'pgTAP'
);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-provider-event', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_provider_event_exists',
  'any linked provider event prevents reopening'
);
DELETE FROM public.inbound_provider_events WHERE provider_event_id = 'interactive-prepared-event-block';

INSERT INTO public.commerce_payment_reconciliation_runs (
  provider, provider_payment_id, payment_intent_id, payment_attempt_id, local_status,
  provider_status, correction_status, idempotency_key, checked_at, payload
) VALUES (
  'tpay', 'terminal-ledger-only', (SELECT intent_id FROM _intent), (SELECT attempt_id FROM _attempt), 'created',
  'succeeded', 'corrected', 'interactive-prepared-terminal-reconciliation-0001', now(), '{}'::jsonb
);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-terminal-reconciliation', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_terminal_reconciliation_exists',
  'terminal reconciliation blocks even a claimed no-dispatch path'
);
DELETE FROM public.commerce_payment_reconciliation_runs
 WHERE idempotency_key = 'interactive-prepared-terminal-reconciliation-0001';

UPDATE public.commerce_payment_intents SET status = 'succeeded' WHERE id = (SELECT intent_id FROM _intent);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-intent-succeeded-race', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_intent_not_active',
  'a late succeeded intent race is never reopened'
);
UPDATE public.commerce_payment_intents SET status = 'processing' WHERE id = (SELECT intent_id FROM _intent);

UPDATE public.commerce_payments
   SET status = 'succeeded'
 WHERE id = (SELECT payment_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent));
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-payment-succeeded-race', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_payment_not_pending',
  'a paid commerce payment race is never reopened'
);
UPDATE public.commerce_payments
   SET status = 'pending'
 WHERE id = (SELECT payment_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent));

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-wrong-order', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000099', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_expected_ids_mismatch',
  'all expected aggregate ids are exact-match fences'
);

UPDATE public.commerce_orders
   SET metadata = jsonb_set(metadata, '{runtimeFinalize,checkoutKind}', '"renewal"'::jsonb)
 WHERE id = 'fa160000-0000-4000-8000-000000000001';
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-wrong-source', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_checkout_source_mismatch',
  'renewal-like or missing durable checkout metadata is not interactive'
);
UPDATE public.commerce_orders
   SET metadata = jsonb_set(metadata, '{runtimeFinalize,checkoutKind}', '"subscription_initial"'::jsonb)
 WHERE id = 'fa160000-0000-4000-8000-000000000001';

SAVEPOINT active_subscription_reopen_refusal;
UPDATE public.subscriptions
   SET status = 'active'
 WHERE id = (SELECT subscription_id FROM _subscription);
SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-prepared-active-subscription', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
      'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_failed', NULL, NULL, '{}'::jsonb
    )
  $$,
  '22023',
  'interactive_prepared_attempt_reopen_subscription_not_pending_activation',
  'an active subscription can never cross the initial-checkout reopen boundary'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt)) || ':' ||
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)),
  'created:processing',
  'active-subscription refusal mutates neither attempt nor intent'
);
ROLLBACK TO SAVEPOINT active_subscription_reopen_refusal;

CREATE TEMP TABLE _reopen AS
SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
  'interactive-prepared-trusted-reopen-0001', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
  'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
  'trusted_pre_dispatch', 'not_dispatched', 'transaction_dispatch', 'tpay_request_deadline_exhausted', NULL, NULL, '{}'::jsonb
) AS response;

SELECT is((SELECT response #>> '{interactivePreparedAttemptReopen,replayed}' FROM _reopen), 'false', 'trusted pre-dispatch reopen succeeds without watchdog or age');
SELECT is((SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt)), 'failed', 'trusted reopen terminalizes only the old attempt');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)), 'failed', 'trusted reopen terminalizes the intent');
SELECT is((SELECT status FROM public.commerce_payments WHERE id = (SELECT payment_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent))), 'failed', 'trusted reopen terminalizes the commerce payment');
SELECT is((SELECT status FROM public.commerce_orders WHERE id = 'fa160000-0000-4000-8000-000000000001'), 'pending_payment', 'order remains payable');
SELECT is((SELECT status FROM public.subscription_cycles WHERE id = (SELECT cycle_id FROM _subscription)), 'payment_pending', 'initial cycle remains payment_pending');
SELECT is((SELECT status FROM public.subscriptions WHERE id = (SELECT subscription_id FROM _subscription)), 'pending_activation', 'provisional subscription remains pending_activation');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id = 'fa180000-0000-4000-8000-000000000001'), 'reserved', 'reopen never releases the checkout reservation');
SELECT is((SELECT retry_attempt FROM public.subscription_cycles WHERE id = (SELECT cycle_id FROM _subscription))::text, '0', 'reopen never burns customer retry_attempt');
SELECT is((SELECT count(*)::int FROM public.subscription_dunning_cases WHERE subscription_id = (SELECT subscription_id FROM _subscription)), 0, 'reopen opens no dunning case');
SELECT is((SELECT count(*)::int FROM public.subscription_events WHERE subscription_id = (SELECT subscription_id FROM _subscription)), 0, 'reopen emits no subscription retry or cancellation event');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt) AND provider_status = 'provider_dispatch_not_started' AND correction_status = 'corrected'), 1, 'trusted path records bounded reconciliation evidence');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_state_transitions WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt) AND (reason = 'interactive_prepared_attempt_reopened' OR (transition_kind = 'reconciliation' AND reason = 'corrected'))), 3, 'attempt, intent, and reconciliation state transitions are recorded');

SELECT is(
  public.commerce_payment_control_reopen_interactive_prepared_attempt(
    'interactive-prepared-trusted-reopen-0001', (SELECT attempt_id FROM _attempt), (SELECT intent_id FROM _intent),
    'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
    'trusted_pre_dispatch', 'not_dispatched', 'transaction_dispatch', 'tpay_request_deadline_exhausted', NULL, NULL, '{}'::jsonb
  ) #>> '{interactivePreparedAttemptReopen,replayed}',
  'true',
  'exact idempotency replay is a no-op receipt'
);

CREATE TEMP TABLE _fresh AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'interactive-prepared-prepare-0002', (SELECT intent_id FROM _intent), 'tpay',
  'openlup:tpay:interactive-prepared:attempt:1',
  format('tpay|interactive|14900|%s|subscription_initial|1', (SELECT code FROM _money)),
  'blik_recurring_activation', NULL,
  jsonb_build_object(
    'source', 'commerce.runtime.provider-attempt.prepare.v0',
    'amountMinor', 14900,
    'currency', (SELECT code FROM _money)
  )
) AS response;
CREATE TEMP TABLE _fresh_attempt AS
SELECT (response -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id FROM _fresh;
SELECT is((SELECT response #>> '{paymentAttempt,paymentIntentId}' FROM _fresh), (SELECT intent_id::text FROM _intent), 'failed intent admits a fresh prepare on the same order');
SELECT isnt((SELECT attempt_id FROM _fresh_attempt), (SELECT attempt_id FROM _attempt), 'fresh prepare mints a new durable attempt only after terminal reopen');

UPDATE public.commerce_payment_attempts
   SET created_at = now() - interval '45 minutes', updated_at = now() - interval '45 minutes'
 WHERE id = (SELECT attempt_id FROM _fresh_attempt);
UPDATE public.commerce_payment_intents
   SET created_at = now() - interval '45 minutes', updated_at = now() - interval '45 minutes'
 WHERE id = (SELECT intent_id FROM _intent);
SELECT public.commerce_payment_control_record_reconciliation(
  'interactive-prepared-fresh-watchdog-0001', 'tpay', NULL, (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _fresh_attempt), 'created', 'prepared_without_provider_ack', 'observed', now(), '{}'::jsonb
);
CREATE TEMP TABLE _manual AS
SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
  'interactive-prepared-manual-reopen-0001', (SELECT attempt_id FROM _fresh_attempt), (SELECT intent_id FROM _intent),
  'fa160000-0000-4000-8000-000000000001', (SELECT subscription_id FROM _subscription), (SELECT cycle_id FROM _subscription),
  'manual_provider_absence', 'provider_absence_confirmed', 'operator_reconciliation', 'operator_verified_absence',
  'ops-ticket-105', now(),
  '{"providerAbsenceConfirmed":true,"watchdogEvidence":true,"evidenceCode":"operator_verified_absence"}'::jsonb
) AS response;
SELECT is((SELECT response #>> '{interactivePreparedAttemptReopen,replayed}' FROM _manual), 'false', 'manual absence with exact watchdog ledger and age succeeds');
SELECT is((SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _fresh_attempt)), 'failed', 'manual absence terminalizes its exact prepared attempt');
SELECT is(
  (SELECT (SELECT status FROM public.commerce_orders WHERE id = 'fa160000-0000-4000-8000-000000000001') || ':' ||
          (SELECT status FROM public.subscription_cycles WHERE id = (SELECT cycle_id FROM _subscription)) || ':' ||
          (SELECT status FROM public.subscriptions WHERE id = (SELECT subscription_id FROM _subscription)) || ':' ||
          (SELECT status FROM public.inventory_reservations WHERE id = 'fa180000-0000-4000-8000-000000000001')),
  'pending_payment:payment_pending:pending_activation:reserved',
  'manual path leaves order/cycle/subscription/reservation untouched and opens no retry path'
);

-- One-time checkout exercises the nullable subscription branch and proves the
-- failed intent admits a fresh attempt on the same payable order.
INSERT INTO public.commerce_orders (
  id, client_id, size_constraint, status,
  total_cents, subtotal_cents, mode, metadata
) VALUES (
  'fa160000-0000-4000-8000-000000000002',
  'fa100000-0000-4000-8000-000000000001',
  '{"kind":"feeding_days","value":28}'::jsonb, 'draft',
  15900, 15900, 'one_time',
  '{"runtimeFinalize":{"checkoutKind":"one_time","checkoutIntent":"one_time","source":"commerce.runtime.hidden.v0"}}'::jsonb
);
CREATE TEMP TABLE _one_time_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'interactive-one-time-intent-0001', 'one_time_order',
  'fa160000-0000-4000-8000-000000000002', NULL, NULL, 15900,
  (SELECT code FROM _money),
  '{"checkoutKind":"one_time","checkoutIntent":"one_time","source":"commerce.runtime.hidden.v0"}'::jsonb
) #>> '{paymentIntent,id}')::uuid AS intent_id;
UPDATE public.commerce_orders
   SET status = 'pending_payment'
 WHERE id = 'fa160000-0000-4000-8000-000000000002';
CREATE TEMP TABLE _one_time_prepared AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'interactive-one-time-prepare-0001', (SELECT intent_id FROM _one_time_intent),
  'tpay', 'openlup:tpay:interactive-one-time:0',
  format('tpay|interactive|15900|%s|one_time|0', (SELECT code FROM _money)),
  'blik_one_time', NULL,
  jsonb_build_object(
    'source', 'commerce.runtime.provider-attempt.prepare.v0',
    'amountMinor', 15900,
    'currency', (SELECT code FROM _money)
  )
) AS response;
CREATE TEMP TABLE _one_time_attempt AS
SELECT (response #>> '{paymentAttempt,id}')::uuid AS attempt_id FROM _one_time_prepared;
CREATE TEMP TABLE _one_time_reopen AS
SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
  'interactive-one-time-reopen-0001', (SELECT attempt_id FROM _one_time_attempt),
  (SELECT intent_id FROM _one_time_intent), 'fa160000-0000-4000-8000-000000000002',
  NULL, NULL, 'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_timeout',
  NULL, NULL, '{}'::jsonb
) AS response;
SELECT is(
  (SELECT response #>> '{interactivePreparedAttemptReopen,replayed}' FROM _one_time_reopen),
  'false',
  'trusted one-time reopen reaches the nullable subscription branch'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _one_time_attempt)) || ':' ||
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _one_time_intent)) || ':' ||
  (SELECT status FROM public.commerce_payments WHERE order_id = 'fa160000-0000-4000-8000-000000000002') || ':' ||
  (SELECT status FROM public.commerce_orders WHERE id = 'fa160000-0000-4000-8000-000000000002'),
  'failed:failed:failed:pending_payment',
  'one-time reopen fails only payment state and leaves its order payable'
);
CREATE TEMP TABLE _one_time_fresh AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'interactive-one-time-prepare-0002', (SELECT intent_id FROM _one_time_intent),
  'tpay', 'openlup:tpay:interactive-one-time:1',
  format('tpay|interactive|15900|%s|one_time|1', (SELECT code FROM _money)),
  'blik_one_time', NULL,
  jsonb_build_object(
    'source', 'commerce.runtime.provider-attempt.prepare.v0',
    'amountMinor', 15900,
    'currency', (SELECT code FROM _money)
  )
) AS response;
SELECT is(
  (SELECT response #>> '{paymentAttempt,paymentIntentId}' FROM _one_time_fresh),
  (SELECT intent_id::text FROM _one_time_intent),
  'one-time retry prepares on the same payment intent'
);
SELECT isnt(
  (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _one_time_fresh),
  (SELECT attempt_id FROM _one_time_attempt),
  'one-time retry mints a fresh durable attempt only after reopen'
);

-- The provider-refusal mode. Measured in production 2026-09-02: Tpay ANSWERED
-- the create-transaction with HTTP 400 and a request-validation code, so the
-- call happened and the answer itself proves nothing was created. That is a
-- different fact from never having dispatched, and it gets its own mode so
-- neither vocabulary can be widened by a caller holding only the other proof.
CREATE TEMP TABLE _one_time_fresh_attempt AS
SELECT (response #>> '{paymentAttempt,id}')::uuid AS attempt_id FROM _one_time_fresh;

-- Disjoint vocabularies, asserted in both directions.
SELECT throws_ok(
  format(
    $$SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-refusal-wrong-mode', %L, %L, 'fa160000-0000-4000-8000-000000000002',
      NULL, NULL, 'trusted_pre_dispatch', 'refused', 'response_decode', 'tpay_request_refused',
      NULL, NULL, '{}'::jsonb)$$,
    (SELECT attempt_id FROM _one_time_fresh_attempt), (SELECT intent_id FROM _one_time_intent)
  ),
  '22023',
  'interactive_prepared_attempt_reopen_invalid_trusted_pre_dispatch_evidence',
  'the no-dispatch mode refuses refusal evidence'
);
SELECT throws_ok(
  format(
    $$SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-refusal-wrong-reason', %L, %L, 'fa160000-0000-4000-8000-000000000002',
      NULL, NULL, 'trusted_provider_refusal', 'not_dispatched', 'oauth', 'tpay_oauth_timeout',
      NULL, NULL, '{}'::jsonb)$$,
    (SELECT attempt_id FROM _one_time_fresh_attempt), (SELECT intent_id FROM _one_time_intent)
  ),
  '22023',
  'interactive_prepared_attempt_reopen_invalid_provider_refusal_evidence',
  'the refusal mode refuses no-dispatch evidence'
);
SELECT throws_ok(
  format(
    $$SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-refusal-operator', %L, %L, 'fa160000-0000-4000-8000-000000000002',
      NULL, NULL, 'trusted_provider_refusal', 'refused', 'response_decode', 'tpay_request_refused',
      'operator:pgtap', NULL, '{}'::jsonb)$$,
    (SELECT attempt_id FROM _one_time_fresh_attempt), (SELECT intent_id FROM _one_time_intent)
  ),
  '22023',
  'interactive_prepared_attempt_reopen_invalid_provider_refusal_evidence',
  'the refusal mode carries no operator reference'
);

CREATE TEMP TABLE _one_time_refusal AS
SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt(
  'interactive-one-time-refusal-0001', (SELECT attempt_id FROM _one_time_fresh_attempt),
  (SELECT intent_id FROM _one_time_intent), 'fa160000-0000-4000-8000-000000000002',
  NULL, NULL, 'trusted_provider_refusal', 'refused', 'response_decode', 'tpay_request_refused',
  NULL, NULL, '{}'::jsonb
) AS response;
SELECT is(
  (SELECT response #>> '{interactivePreparedAttemptReopen,replayed}' FROM _one_time_refusal),
  'false',
  'provider-refusal reopen succeeds without watchdog, operator or age'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _one_time_fresh_attempt)) || ':' ||
  (SELECT status FROM public.commerce_orders WHERE id = 'fa160000-0000-4000-8000-000000000002'),
  'failed:pending_payment',
  'provider-refusal reopen terminalizes the attempt and leaves the order payable'
);
-- The attempt is released into a status the anti-double-charge gate admits.
-- `failed` is on that gate's retryable list; `created` - where the incident left
-- these rows - is not.
SELECT ok(
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _one_time_fresh_attempt))
    IN ('blocked_preflight', 'failed', 'cancelled', 'expired'),
  'the released attempt sits in the admission gate retryable set'
);
-- Audit truth: this mode DID call the provider, unlike the other two.
SELECT is(
  (SELECT response_payload #>> '{providerCall}' FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _one_time_fresh_attempt)) || ':' ||
  (SELECT response_payload #>> '{providerAcknowledged}' FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _one_time_fresh_attempt)) || ':' ||
  (SELECT response_payload #>> '{interactiveReopenMode}' FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _one_time_fresh_attempt)),
  'true:false:trusted_provider_refusal',
  'the refusal audit records a provider call that was never acknowledged'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE payment_attempt_id = (SELECT attempt_id FROM _one_time_fresh_attempt)
      AND provider_status = 'provider_transaction_refused'
      AND correction_status = 'corrected'),
  1,
  'the refusal path records its own bounded reconciliation evidence'
);
-- The buyer's next submit. This is the whole point of the wave: it is admitted
-- on the SAME intent and the same payable order, so no second order,
-- subscription or profile is minted.
CREATE TEMP TABLE _one_time_after_refusal AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'interactive-one-time-prepare-0003', (SELECT intent_id FROM _one_time_intent),
  'tpay', 'openlup:tpay:interactive-one-time:2',
  format('tpay|interactive|15900|%s|one_time|2', (SELECT code FROM _money)),
  'blik_one_time', NULL,
  jsonb_build_object(
    'source', 'commerce.runtime.provider-attempt.prepare.v0',
    'amountMinor', 15900,
    'currency', (SELECT code FROM _money)
  )
) AS response;
SELECT is(
  (SELECT response #>> '{paymentAttempt,paymentIntentId}' FROM _one_time_after_refusal),
  (SELECT intent_id::text FROM _one_time_intent),
  'the submit after a refusal is admitted on the same payment intent'
);
SELECT isnt(
  (SELECT (response #>> '{paymentAttempt,id}')::uuid FROM _one_time_after_refusal),
  (SELECT attempt_id FROM _one_time_fresh_attempt),
  'the submit after a refusal mints its own durable attempt'
);
SELECT is(
  (SELECT response #>> '{paymentAttempt,replayed}' FROM _one_time_after_refusal),
  'false',
  'the submit after a refusal is never answered as a replayed in-flight attempt'
);

-- Real two-session finalizer-vs-reopen interleave. A savepoint-held attempt row
-- makes the public finalizer acquire and retain the intent lock before waiting
-- for its attempt; reopen must queue behind that same intent instead of forming
-- the historical attempt/intent ABBA.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'interactive_reopen_finalize_race',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'interactive_reopen_absence_race',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_exec('interactive_reopen_finalize_race', $setup$
  CREATE TEMP TABLE pgtap_race_money AS SELECT 'PLN'::text AS code;
  INSERT INTO public.clients (id, email)
  VALUES ('fb100000-0000-4000-8000-000000000001', 'interactive-race@example.invalid');
  INSERT INTO public.commerce_orders (
    id, client_id, size_constraint, status,
    total_cents, subtotal_cents, mode, metadata
  ) VALUES (
    'fb160000-0000-4000-8000-000000000001',
    'fb100000-0000-4000-8000-000000000001',
    '{"kind":"feeding_days","value":28}'::jsonb, 'draft',
    16900, 16900, 'one_time',
    '{"runtimeFinalize":{"checkoutKind":"one_time","checkoutIntent":"one_time","source":"commerce.runtime.hidden.v0"}}'::jsonb
  );
  SELECT public.commerce_payment_control_create_intent(
    'interactive-one-time-race-intent', 'one_time_order',
    'fb160000-0000-4000-8000-000000000001', NULL, NULL, 16900,
    (SELECT code FROM pgtap_race_money),
    '{"checkoutKind":"one_time","checkoutIntent":"one_time","source":"commerce.runtime.hidden.v0"}'::jsonb
  );
  UPDATE public.commerce_orders SET status = 'pending_payment'
   WHERE id = 'fb160000-0000-4000-8000-000000000001';
  SELECT public.commerce_payment_control_prepare_provider_attempt(
    'interactive-one-time-race-prepare',
    (SELECT id FROM public.commerce_payment_intents
      WHERE order_id = 'fb160000-0000-4000-8000-000000000001'),
    'tpay', 'openlup:tpay:interactive-one-time-race',
    format('tpay|interactive|16900|%s|one_time|race', (SELECT code FROM pgtap_race_money)),
    'blik_one_time', NULL,
    jsonb_build_object(
      'source', 'commerce.runtime.provider-attempt.prepare.v0',
      'amountMinor', 16900,
      'currency', (SELECT code FROM pgtap_race_money)
    )
  );
  CREATE OR REPLACE FUNCTION public.pgtap_finalize_interactive_one_time_race()
  RETURNS text LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM public.commerce_payment_control_finalize_provider_attempt(
      'interactive-one-time-race-finalize',
      (SELECT id FROM public.commerce_payment_intents
        WHERE order_id = 'fb160000-0000-4000-8000-000000000001'),
      (SELECT id FROM public.commerce_payment_attempts
        WHERE idempotency_key = 'interactive-one-time-race-prepare'),
      'openlup:tpay:interactive-one-time-race',
      format('tpay|interactive|16900|%s|one_time|race', (SELECT code FROM pgtap_race_money)),
      'tpay-provider-race-1', NULL, 'processing', NULL,
      '{"providerCall":true}'::jsonb, '{"providerCall":true}'::jsonb
    );
    RETURN 'finalized';
  EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
  END $fn$;
  CREATE OR REPLACE FUNCTION public.pgtap_reopen_interactive_one_time_race()
  RETURNS text LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM public.commerce_payment_control_reopen_interactive_prepared_attempt(
      'interactive-one-time-race-reopen',
      (SELECT id FROM public.commerce_payment_attempts
        WHERE idempotency_key = 'interactive-one-time-race-prepare'),
      (SELECT id FROM public.commerce_payment_intents
        WHERE order_id = 'fb160000-0000-4000-8000-000000000001'),
      'fb160000-0000-4000-8000-000000000001', NULL, NULL,
      'trusted_pre_dispatch', 'not_dispatched', 'oauth', 'tpay_oauth_timeout',
      NULL, NULL, '{}'::jsonb
    );
    RETURN 'reopened';
  EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
  END $fn$;
$setup$);
SAVEPOINT interactive_one_time_race_gate;
SELECT 1 FROM public.commerce_payment_attempts
 WHERE idempotency_key = 'interactive-one-time-race-prepare'
 FOR UPDATE;
SELECT extensions.dblink_send_query(
  'interactive_reopen_finalize_race',
  'SELECT public.pgtap_finalize_interactive_one_time_race()'
);
SELECT pg_sleep(0.05);
SELECT extensions.dblink_send_query(
  'interactive_reopen_absence_race',
  'SELECT public.pgtap_reopen_interactive_one_time_race()'
);
SELECT pg_sleep(0.05);
SELECT ok(
  extensions.dblink_is_busy('interactive_reopen_finalize_race') = 1
  AND extensions.dblink_is_busy('interactive_reopen_absence_race') = 1,
  'one-time finalizer and reopen serialize without opposite aggregate locks'
);
ROLLBACK TO SAVEPOINT interactive_one_time_race_gate;
CREATE TEMP TABLE _interactive_one_time_race_results (
  actor text,
  outcome text
) ON COMMIT DROP;
INSERT INTO _interactive_one_time_race_results
SELECT 'finalizer', outcome FROM extensions.dblink_get_result('interactive_reopen_finalize_race') AS result(outcome text);
INSERT INTO _interactive_one_time_race_results
SELECT 'reopen', outcome FROM extensions.dblink_get_result('interactive_reopen_absence_race') AS result(outcome text);
SELECT * FROM extensions.dblink_get_result('interactive_reopen_finalize_race') AS drained(outcome text);
SELECT * FROM extensions.dblink_get_result('interactive_reopen_absence_race') AS drained(outcome text);
SELECT is(
  (SELECT outcome FROM _interactive_one_time_race_results WHERE actor = 'finalizer'),
  'finalized',
  'late one-time provider finalization completes without deadlock'
);
SELECT is(
  (SELECT outcome FROM _interactive_one_time_race_results WHERE actor = 'reopen'),
  'interactive_prepared_attempt_reopen_attempt_not_prepared',
  'waiting reopen observes finalized state and refuses to hide the provider acknowledgement'
);
SELECT is(
  (SELECT status || ':' || provider_attempt_id
     FROM public.commerce_payment_attempts
    WHERE idempotency_key = 'interactive-one-time-race-prepare'),
  'processing:tpay-provider-race-1',
  'the durable attempt retains the winning provider acknowledgement'
);
SELECT extensions.dblink_exec('interactive_reopen_finalize_race', $cleanup$
  DROP FUNCTION public.pgtap_finalize_interactive_one_time_race();
  DROP FUNCTION public.pgtap_reopen_interactive_one_time_race();
  DELETE FROM public.commerce_payment_state_transitions
   WHERE payment_intent_id IN (
     SELECT id FROM public.commerce_payment_intents
      WHERE order_id = 'fb160000-0000-4000-8000-000000000001'
   );
  DELETE FROM public.commerce_payment_reconciliation_runs
   WHERE payment_attempt_id IN (
     SELECT id FROM public.commerce_payment_attempts
      WHERE idempotency_key = 'interactive-one-time-race-prepare'
   );
  DELETE FROM public.commerce_idempotency_keys
   WHERE idempotency_key LIKE 'interactive-one-time-race-%';
  UPDATE public.commerce_payment_intents
     SET active_attempt_id = NULL
   WHERE order_id = 'fb160000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_payment_attempts
   WHERE idempotency_key = 'interactive-one-time-race-prepare';
  DELETE FROM public.commerce_payment_intents
   WHERE order_id = 'fb160000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_payments
   WHERE order_id = 'fb160000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_orders
   WHERE id = 'fb160000-0000-4000-8000-000000000001';
  DELETE FROM public.clients
   WHERE id = 'fb100000-0000-4000-8000-000000000001';
$cleanup$);
SELECT extensions.dblink_disconnect('interactive_reopen_finalize_race');
SELECT extensions.dblink_disconnect('interactive_reopen_absence_race');
SELECT ok(
  NOT has_function_privilege('anon', 'public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.commerce_payment_control_reopen_interactive_prepared_attempt(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)', 'EXECUTE'),
  'only service_role may execute the interactive reopen RPC'
);

SELECT * FROM finish();
ROLLBACK;
