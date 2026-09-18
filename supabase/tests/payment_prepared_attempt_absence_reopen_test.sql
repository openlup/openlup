-- pgTAP: operator-controlled remediation for a subscription renewal provider
-- attempt that was prepared locally but never acknowledged by Stripe/Tpay.
--
-- The remediation must prove provider absence first, must not burn the
-- customer dunning retry budget, and must only reopen the cycle through the
-- existing retry_scheduled due path.

BEGIN;
SELECT plan(25);
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;

INSERT INTO public.clients (id, email)
VALUES ('f2100000-0000-4000-8000-000000000001', 'payment-prepared-absence@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('f2500000-0000-4000-8000-000000000001', 'payment-prepared-absence-product', 'Prepared Absence Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES (
  'f2600000-0000-4000-8000-000000000001',
  'f2500000-0000-4000-8000-000000000001',
  'PREPARED-ABSENCE-SKU',
  'Prepared Absence SKU',
  'dog',
  400,
  350,
  'active'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_kind, payment_method_ref
) VALUES (
  'f2200000-0000-4000-8000-000000000001',
  'f2100000-0000-4000-8000-000000000001',
  28,
  'PLN',
  'active',
  now() - interval '2 days',
  'card',
  'pm_prepared_absence'
);

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES (
  'f2200000-0000-4000-8000-000000000001',
  'f2600000-0000-4000-8000-000000000001',
  1,
  0,
  false,
  1
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, template_snapshot,
  pricing_snapshot, payment_method_ref, engine_idempotency_key
) VALUES (
  'f2300000-0000-4000-8000-000000000001',
  'f2200000-0000-4000-8000-000000000001',
  2,
  now() - interval '2 days',
  'payment_pending',
  public.subscription_current_template_snapshot('f2200000-0000-4000-8000-000000000001'),
  '{}'::jsonb,
  'pm_prepared_absence',
  'payment-prepared-absence-cycle-0001'
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents,
  mode, subscription_id, subscription_cycle_id
) VALUES (
  'f2400000-0000-4000-8000-000000000001',
  'f2100000-0000-4000-8000-000000000001',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":28}'::jsonb,
  'draft',
  1299, 1299,
  'subscription_cycle',
  'f2200000-0000-4000-8000-000000000001',
  'f2300000-0000-4000-8000-000000000001'
);

UPDATE public.subscription_cycles
   SET order_id = 'f2400000-0000-4000-8000-000000000001'
 WHERE id = 'f2300000-0000-4000-8000-000000000001';

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'payment-prepared-absence-intent-0001',
  'subscription_cycle',
  'f2400000-0000-4000-8000-000000000001',
  'f2200000-0000-4000-8000-000000000001',
  'f2300000-0000-4000-8000-000000000001',
  1299,
  'PLN',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _prepared AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'payment-prepared-absence-prepare-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:prepared-absence',
  'stripe|intent|1299|PLN|subscription_cycle|prepared_absence',
  'off_session_payment',
  'pm_prepared_absence',
  '{"source":"pgTAP","retryAttempt":0,"providerAttemptSequence":0}'::jsonb
) AS response;

CREATE TEMP TABLE _attempt AS
SELECT (response -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id
FROM _prepared;

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-no-watchdog',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '2 minutes',
      now() - interval '1 minute',
      '{"providerAbsenceConfirmed": true}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_watchdog_evidence_missing',
  'operator reopen requires prior prepared-attempt watchdog evidence');

UPDATE public.commerce_payment_attempts
   SET created_at = now() - interval '45 minutes',
       updated_at = now() - interval '45 minutes'
 WHERE id = (SELECT attempt_id FROM _attempt);
UPDATE public.commerce_payment_intents
   SET created_at = now() - interval '45 minutes',
       updated_at = now() - interval '45 minutes'
 WHERE id = (SELECT intent_id FROM _intent);

CREATE TEMP TABLE _prepared_claimed AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
    now(),
    900,
    10,
    'payment-prepared-absence-watchdog-0001'::text
  );

SELECT is((SELECT count(*)::int FROM _prepared_claimed), 1, 'watchdog observes one prepared/no-ack attempt');

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-too-fresh',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '20 minutes',
      now() - interval '1 minute',
      '{"providerAbsenceConfirmed": true, "ticket": "OPS-1"}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_too_fresh',
  'operator reopen refuses attempts inside the local min-stranded-age window');

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-no-proof',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '2 minutes',
      now() - interval '1 minute',
      '{}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_requires_provider_absence_proof',
  'operator reopen requires explicit provider absence confirmation');

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-sensitive',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '2 minutes',
      now() - interval '1 minute',
      '{"providerAbsenceConfirmed": true, "paymentMethodRef": "pm_secret"}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_sensitive_evidence',
  'operator evidence rejects payment-method secrets');

INSERT INTO public.inbound_provider_events (
  provider, provider_event_id, event_type, processing_status, payload, error,
  payment_intent_id, payment_attempt_id, provider_payment_id, amount_cents,
  currency, signature_verified, received_via
) VALUES (
  'stripe',
  'evt_prepared_absence_block',
  'payment.succeeded',
  'received',
  '{}'::jsonb,
  '{}'::jsonb,
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  NULL,
  1299,
  'PLN',
  true,
  'pgTAP'
);

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-provider-event',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '2 minutes',
      now() - interval '1 minute',
      '{"providerAbsenceConfirmed": true, "ticket": "OPS-1"}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_provider_event_exists',
  'operator reopen blocks when any provider event is already tied to the local intent/attempt');

DELETE FROM public.inbound_provider_events
 WHERE provider_event_id = 'evt_prepared_absence_block';

UPDATE public.commerce_payment_attempts
   SET provider_attempt_id = 'pi_prepared_absence_block_ref'
 WHERE id = (SELECT attempt_id FROM _attempt);

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-provider-ref',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '2 minutes',
      now() - interval '1 minute',
      '{"providerAbsenceConfirmed": true, "ticket": "OPS-1"}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_provider_ref_exists',
  'operator reopen blocks when the local attempt already has a provider ref');

UPDATE public.commerce_payment_attempts
   SET provider_attempt_id = NULL
 WHERE id = (SELECT attempt_id FROM _attempt);

INSERT INTO public.commerce_payment_reconciliation_runs (
  provider,
  provider_payment_id,
  payment_intent_id,
  payment_attempt_id,
  local_status,
  provider_status,
  correction_status,
  idempotency_key,
  checked_at,
  payload
) VALUES (
  'stripe',
  'pi_prepared_absence_terminal',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'created',
  'succeeded',
  'corrected',
  'payment-prepared-absence-terminal-0001',
  now() - interval '2 minutes',
  '{}'::jsonb
);

SELECT throws_ok(
  $$
    SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
      'payment-prepared-absence-reopen-terminal-reconciliation',
      (SELECT attempt_id FROM _attempt),
      (SELECT intent_id FROM _intent),
      'f2300000-0000-4000-8000-000000000001',
      'payment-ops@example.test',
      now() - interval '2 minutes',
      now() - interval '1 minute',
      '{"providerAbsenceConfirmed": true, "ticket": "OPS-1"}'::jsonb
    )
  $$,
  '22023',
  'prepared_attempt_absence_reopen_terminal_reconciliation_exists',
  'operator reopen blocks when terminal provider reconciliation already exists');

DELETE FROM public.commerce_payment_reconciliation_runs
 WHERE idempotency_key = 'payment-prepared-absence-terminal-0001';

CREATE TEMP TABLE _reopen_input AS
SELECT now() - interval '2 minutes' AS absence_checked_at,
       now() - interval '1 minute' AS next_retry_at;

CREATE TEMP TABLE _reopen AS
SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
  'payment-prepared-absence-reopen-0001',
  (SELECT attempt_id FROM _attempt),
  (SELECT intent_id FROM _intent),
  'f2300000-0000-4000-8000-000000000001',
  'payment-ops@example.test',
  (SELECT absence_checked_at FROM _reopen_input),
  (SELECT next_retry_at FROM _reopen_input),
  '{"providerAbsenceConfirmed": true, "providerSearch": "stripe_dashboard_idempotency_key", "ticket": "OPS-1"}'::jsonb
) AS response;

SELECT is((SELECT response #>> '{preparedAttemptReopen,replayed}' FROM _reopen), 'false', 'first operator reopen is not a replay');
SELECT is((SELECT (response #>> '{preparedAttemptReopen,retryAttempt}')::int FROM _reopen), 0, 'operator reopen preserves retry_attempt');
SELECT is((SELECT (response #>> '{preparedAttemptReopen,providerAttemptSequence}')::int FROM _reopen), 1, 'operator reopen advances only provider attempt sequence');

SELECT is((SELECT status FROM public.subscription_cycles WHERE id = 'f2300000-0000-4000-8000-000000000001'), 'retry_scheduled', 'cycle is reopened through retry_scheduled');
SELECT is((SELECT retry_attempt FROM public.subscription_cycles WHERE id = 'f2300000-0000-4000-8000-000000000001'), 0, 'cycle retry_attempt is not burned');
SELECT is((SELECT provider_attempt_sequence FROM public.subscription_cycles WHERE id = 'f2300000-0000-4000-8000-000000000001'), 1, 'cycle records provider_attempt_sequence');
SELECT ok((SELECT next_retry_at <= now() FROM public.subscription_cycles WHERE id = 'f2300000-0000-4000-8000-000000000001'), 'cycle next_retry_at can make the existing due-list path claim it');

SELECT is(
  (SELECT status || ':' || failure_reason FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt)),
  'cancelled:prepared_without_provider_ack_operator_cleared',
  'original prepared attempt is locally cancelled with operator-clear reason');

SELECT is(
  (SELECT count(*)::int
     FROM public.subscription_dunning_cases
    WHERE cycle_id = 'f2300000-0000-4000-8000-000000000001'),
  0,
  'operator reopen does not create a dunning case');

SELECT is(
  (SELECT count(*)::int
     FROM public.subscription_dunning_notifications n
     JOIN public.subscription_dunning_cases c ON c.id = n.case_id
    WHERE c.cycle_id = 'f2300000-0000-4000-8000-000000000001'),
  0,
  'operator reopen does not queue dunning notifications');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_runs
    WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt)
      AND provider_status = 'prepared_attempt_provider_absent'
      AND correction_status = 'corrected'),
  1,
  'operator reopen records corrected provider-absence reconciliation evidence');

SELECT is(
  (SELECT count(*)::int
     FROM public.subscription_list_due_for_renewal(10)
    WHERE subscription_id = 'f2200000-0000-4000-8000-000000000001'),
  1,
  'existing due-renewal RPC sees the reopened retry_scheduled cycle');

CREATE TEMP TABLE _second_prepare AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'payment-prepared-absence-prepare-0002',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:prepared-absence:provider-seq:1',
  'stripe|intent|1299|PLN|subscription_cycle|prepared_absence|provider_seq:1',
  'off_session_payment',
  'pm_prepared_absence',
  '{"source":"pgTAP","retryAttempt":0,"providerAttemptSequence":1}'::jsonb
) AS response;

SELECT is((SELECT response #>> '{paymentAttempt,status}' FROM _second_prepare), 'created', 'payment-control can prepare a fresh local attempt after reopen');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_attempts WHERE payment_intent_id = (SELECT intent_id FROM _intent)),
  2,
  'reopen enables exactly one additional prepared local attempt in this fixture');

SELECT is(
  (SELECT active_attempt_id::text FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)),
  (SELECT response #>> '{paymentAttempt,id}' FROM _second_prepare),
  'fresh prepared attempt becomes the active attempt for the existing intent');

CREATE TEMP TABLE _reopen_replay AS
SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence(
  'payment-prepared-absence-reopen-0001',
  (SELECT attempt_id FROM _attempt),
  (SELECT intent_id FROM _intent),
  'f2300000-0000-4000-8000-000000000001',
  'payment-ops@example.test',
  (SELECT absence_checked_at FROM _reopen_input),
  (SELECT next_retry_at FROM _reopen_input),
  '{"providerAbsenceConfirmed": true, "providerSearch": "stripe_dashboard_idempotency_key", "ticket": "OPS-1"}'::jsonb
) AS response;

SELECT is((SELECT response #>> '{preparedAttemptReopen,replayed}' FROM _reopen_replay), 'true', 'operator reopen is idempotent for the same evidence');
SELECT is((SELECT provider_attempt_sequence FROM public.subscription_cycles WHERE id = 'f2300000-0000-4000-8000-000000000001'), 1, 'idempotent replay does not advance provider_attempt_sequence again');

SELECT * FROM finish();
ROLLBACK;
