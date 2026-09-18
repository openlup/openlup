-- pgTAP: payment-provider reconciliation surfaces stale prepared provider
-- attempts without provider acknowledgement as operator-only evidence.

BEGIN;
SELECT plan(14);
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;

INSERT INTO public.clients (id, email)
VALUES ('d2100000-0000-4000-8000-000000000001', 'payment-prepared-watchdog@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d2500000-0000-4000-8000-000000000001', 'payment-prepared-watchdog-product', 'Prepared Watchdog Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES (
  'd2600000-0000-4000-8000-000000000001',
  'd2500000-0000-4000-8000-000000000001',
  'PREPARED-WATCHDOG-SKU',
  'Prepared Watchdog SKU',
  'dog',
  400,
  350,
  'active'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_kind, payment_method_ref
) VALUES (
  'd2200000-0000-4000-8000-000000000001',
  'd2100000-0000-4000-8000-000000000001',
  28,
  'PLN',
  'active',
  '2026-07-01T10:00:00Z',
  'card',
  'pm_prepared_watchdog'
);

INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES (
  'd2200000-0000-4000-8000-000000000001',
  'd2600000-0000-4000-8000-000000000001',
  1,
  0,
  false,
  1
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, template_snapshot,
  pricing_snapshot, payment_method_ref, engine_idempotency_key
) VALUES (
  'd2300000-0000-4000-8000-000000000001',
  'd2200000-0000-4000-8000-000000000001',
  2,
  '2026-07-01T10:00:00Z',
  'payment_pending',
  public.subscription_current_template_snapshot('d2200000-0000-4000-8000-000000000001'),
  '{}'::jsonb,
  'pm_prepared_watchdog',
  'payment-prepared-watchdog-cycle-0001'
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents,
  mode, subscription_id, subscription_cycle_id
) VALUES (
  'd2400000-0000-4000-8000-000000000001',
  'd2100000-0000-4000-8000-000000000001',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":28}'::jsonb,
  'draft',
  1299, 1299,
  'subscription_cycle',
  'd2200000-0000-4000-8000-000000000001',
  'd2300000-0000-4000-8000-000000000001'
);

UPDATE public.subscription_cycles
   SET order_id = 'd2400000-0000-4000-8000-000000000001'
 WHERE id = 'd2300000-0000-4000-8000-000000000001';

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'payment-prepared-watchdog-intent-0001',
  'subscription_cycle',
  'd2400000-0000-4000-8000-000000000001',
  'd2200000-0000-4000-8000-000000000001',
  'd2300000-0000-4000-8000-000000000001',
  1299,
  'PLN',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _prepared AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'payment-prepared-watchdog-prepare-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  'openlup:stripe:intent:attempt:prepared-watchdog',
  'stripe|intent|1299|PLN|subscription_cycle|prepared_watchdog',
  'off_session_payment',
  'pm_prepared_watchdog',
  '{"source":"pgTAP"}'::jsonb
) AS response;

CREATE TEMP TABLE _attempt AS
SELECT (response -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id
FROM _prepared;

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
     FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
       '2026-07-03T10:00:00Z'::timestamptz,
       900,
       10,
       'payment-prepared-watchdog-fresh-intent'::text
     )),
  0,
  'does not claim a prepared attempt when the linked payment intent is still fresh');

UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T09:30:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _intent);

CREATE TEMP TABLE _prepared_claimed AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
    '2026-07-03T10:00:00Z'::timestamptz,
    900,
    10,
    'payment-prepared-watchdog-run-0001'::text
  );

SELECT is((SELECT count(*)::int FROM _prepared_claimed), 1, 'claims one stale prepared subscription-cycle attempt');

SELECT is(
  (SELECT provider_payment_id FROM _prepared_claimed),
  NULL::text,
  'prepared claim deliberately has no provider payment id for readback');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_runs
    WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt)
      AND provider_status = 'prepared_attempt_claiming'
      AND correction_status = 'observed'),
  1,
  'prepared claim records reconciliation evidence for operator visibility');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_runs
    WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt)
      AND provider_status = 'prepared_attempt_claiming'
      AND payload ? 'paymentMethodRef'),
  0,
  'prepared claim evidence does not persist payment method refs in the audit payload');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
       '2026-07-03T10:00:00Z'::timestamptz,
       900,
       10,
       'payment-prepared-watchdog-run-0001'::text
     )),
  0,
  'same prepared claim key is idempotent and does not return the attempt again');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
       '2026-07-03T10:30:00Z'::timestamptz,
       900,
       10,
       'payment-prepared-watchdog-run-0002'::text
     )),
  1,
  'a still-prepared attempt can be re-observed by a later reconciliation run');

SELECT public.commerce_payment_control_finalize_provider_attempt(
  'payment-prepared-watchdog-finalize-0001',
  (SELECT intent_id FROM _intent),
  (SELECT attempt_id FROM _attempt),
  'openlup:stripe:intent:attempt:prepared-watchdog',
  'stripe|intent|1299|PLN|subscription_cycle|prepared_watchdog',
  'pi_prepared_watchdog_123',
  'pi_prepared_watchdog_123',
  'processing',
  NULL,
  '{"providerCall":true}'::jsonb,
  '{"providerCall":true,"webhookExpected":true}'::jsonb
);

UPDATE public.commerce_payment_attempts
   SET updated_at = '2026-07-03T10:30:00Z'::timestamptz
 WHERE id = (SELECT attempt_id FROM _attempt);
UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T10:30:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _intent);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
       '2026-07-03T11:00:00Z'::timestamptz,
       900,
       10,
       'payment-prepared-watchdog-run-0003'::text
     )),
  0,
  'finalized provider attempts leave the prepared-attempt watchdog path');

CREATE TEMP TABLE _stale_after_finalize AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_stale_attempts(
    '2026-07-03T11:00:00Z'::timestamptz,
    900,
    10,
    'payment-prepared-watchdog-stale-run-0001'::text
  );

SELECT is(
  (SELECT count(*)::int FROM _stale_after_finalize),
  1,
  'finalized stale attempts continue through the existing provider readback path');

SELECT is(
  (SELECT provider_payment_id FROM _stale_after_finalize),
  'pi_prepared_watchdog_123',
  'existing provider readback receives the finalized provider payment id');

-- A one-time prepare crash is visible but remains operator-only: it carries no
-- provider reference and must never be reopened as a subscription retry.
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode
) VALUES (
  'd2400000-0000-4000-8000-000000000002',
  'd2100000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft',
  1399, 1399, 'one_time'
);

CREATE TEMP TABLE _one_time_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'payment-prepared-one-time-intent-0001',
  'one_time_order',
  'd2400000-0000-4000-8000-000000000002',
  NULL, NULL, 1399, 'PLN', '{}'::jsonb
) #>> '{paymentIntent,id}')::uuid AS intent_id;

CREATE TEMP TABLE _one_time_prepared AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'payment-prepared-one-time-prepare-0001',
  (SELECT intent_id FROM _one_time_intent),
  'stripe',
  'openlup:stripe:intent:attempt:prepared-one-time',
  'stripe|intent|1399|PLN|one_time|prepared_watchdog',
  'one_time_payment',
  'pm_prepared_one_time',
  '{"source":"pgTAP"}'::jsonb
) AS response;

CREATE TEMP TABLE _one_time_attempt AS
SELECT (response #>> '{paymentAttempt,id}')::uuid AS attempt_id
  FROM _one_time_prepared;

UPDATE public.commerce_payment_attempts
   SET updated_at = '2026-07-03T11:00:00Z'::timestamptz
 WHERE id = (SELECT attempt_id FROM _one_time_attempt);
UPDATE public.commerce_payment_intents
   SET updated_at = '2026-07-03T11:00:00Z'::timestamptz
 WHERE id = (SELECT intent_id FROM _one_time_intent);

CREATE TEMP TABLE _one_time_prepared_claimed AS
SELECT *
  FROM public.commerce_payment_reconciliation_claim_prepared_attempts(
    '2026-07-03T11:30:00Z'::timestamptz,
    900,
    10,
    'payment-prepared-one-time-claim-0001'
  );

SELECT is(
  (SELECT count(*)::int FROM _one_time_prepared_claimed),
  1,
  'claims a stale prepared one-time attempt'
);

SELECT ok(
  (SELECT order_mode = 'one_time'
      AND subscription_id IS NULL
      AND subscription_cycle_id IS NULL
     FROM _one_time_prepared_claimed),
  'prepared one-time claims preserve the exact null subscription context'
);

SELECT ok(
  (SELECT provider_payment_id IS NULL AND cycle_retry_attempt = 0
     FROM _one_time_prepared_claimed),
  'prepared one-time claims have no provider id or subscription retry count'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_reconciliation_runs
    WHERE payment_attempt_id = (SELECT attempt_id FROM _one_time_attempt)
      AND provider_status = 'prepared_attempt_claiming'
      AND correction_status = 'observed'),
  1,
  'prepared one-time claims record the existing operator audit evidence'
);

SELECT * FROM finish();
ROLLBACK;
