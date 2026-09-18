-- pgTAP: a refusal DISCOVERED BY POLLING carries its class all the way to the
-- dunning case, and a refusal discovered without one changes nothing.
--
-- This is the end-to-end proof for wave 3i-b. The class already had a column and
-- already had a writer; what it lacked was a route from the reconciliation entry
-- point to that writer, because all three intermediate functions dropped the
-- parameter. Asserting only the top of the chain would prove the parameter is
-- ACCEPTED, not that it ARRIVES, so every assertion below reads the persisted
-- row rather than the RPC's own return value.
--
-- Both directions are pinned deliberately. The classified direction is the fix;
-- the unclassified direction is the compatibility contract that lets the OTHER
-- live caller of the dunning opener (the webhook gateway rail) keep calling the
-- widened function with no class and observe no change at all.
--
-- Vocabulary-neutral fixtures, following the resume wave: 'XTS' (ISO 4217 test
-- currency), 'ZZ' (user-assigned region), a 'unit_count' size constraint and the
-- neutral rail literal 'card_rail'. None of these is a schema price being dodged
-- — the currency CHECK constrains length only, the region CHECK constrains length
-- only, `size_constraint` is plain jsonb, and `commerce_payment_attempts.provider`
-- is `text NOT NULL` with NO CHECK restricting it to a shipped rail. Nothing this
-- file proves depends on which rail refused, so naming one would be a claim the
-- test does not make.
--
-- A THIRD direction — a class outside the taxonomy being rejected — is
-- deliberately NOT re-proved here. `subscription_apply_result_guards_test.sql`
-- W1-3 already pins that the NOT VALID CHECK raises 23514 on a new write, and
-- re-proving it on this rail would need a whole third fixture to say the same
-- thing about the same constraint.

BEGIN;
SELECT plan(10);

INSERT INTO public.clients (id, email)
VALUES ('d1000000-0000-4000-8000-000000000001', 'reconciled-class@example.invalid');

-- --------------------------------------------------------------------------
-- Direction 1: the adapter reached a verdict, and it must reach the case.
-- --------------------------------------------------------------------------

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) VALUES (
  'd1200000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  28, 'XTS', 'active', '2026-05-01T00:00:00Z', '2026-08-01T00:00:00Z'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'd1300000-0000-4000-8000-000000000001',
  'd1200000-0000-4000-8000-000000000001',
  2, '2026-08-01T00:00:00Z', 'planned',
  'class-carried-cycle-0001', 0
);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'd1400000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"unit_count","value":28}'::jsonb, 'draft',
  2499, 2499, 'subscription_cycle',
  'd1200000-0000-4000-8000-000000000001',
  'd1300000-0000-4000-8000-000000000001'
);

CREATE TEMP TABLE _classified_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'class-carried-intent-0001', 'subscription_cycle',
  'd1400000-0000-4000-8000-000000000001',
  'd1200000-0000-4000-8000-000000000001',
  'd1300000-0000-4000-8000-000000000001',
  2499, 'XTS', '{}'::jsonb
) AS response) s;
CREATE TEMP TABLE _classified_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'class-carried-attempt-0001',
  (SELECT intent_id FROM _classified_intent),
  'card_rail', 'pay_class_carried', 'pay_class_carried', 'processing', NULL,
  '{}'::jsonb, '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

CREATE TEMP TABLE _classified_result AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'class-carried-apply-0001',
  'd1400000-0000-4000-8000-000000000001',
  (SELECT intent_id FROM _classified_intent),
  (SELECT attempt_id FROM _classified_attempt),
  (SELECT payment_id FROM _classified_intent),
  'card_rail', 'pay_class_carried', 'processing', 'failed', 'failed',
  '2026-08-01T09:00:00Z', 'provider_requires_action', '2026-08-01T09:01:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb,
  'mandate_dead',
  'neutral_hint'
) AS result;

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,subscriptionWebhookDunning,opened}'
    FROM _classified_result),
  'true',
  'a classified reconciled refusal still opens the dunning case'
);

-- THE POINT OF THE WAVE. Before 3i-b this column was NULL on every case the
-- reconciliation rail ever opened, on every rail, no matter what the adapter read.
SELECT is(
  (SELECT failure_class FROM public.subscription_dunning_cases
    WHERE cycle_id = 'd1300000-0000-4000-8000-000000000001'),
  'mandate_dead',
  'the dunning case carries the class the polling adapter decided'
);
SELECT is(
  (SELECT failure_class FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _classified_attempt)),
  'mandate_dead',
  'the reconciled attempt carries the same class'
);
-- The deciding rule is a diagnostic, not a dimension, so it stays in the
-- attempt's payload and never becomes a column or reaches the case.
SELECT is(
  (SELECT response_payload ->> 'failureClassDecidedBy'
    FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _classified_attempt)),
  'neutral_hint',
  'the deciding rule is recorded on the attempt payload'
);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE cycle_id = 'd1300000-0000-4000-8000-000000000001'),
  1,
  'classifying the refusal creates no second case'
);

-- --------------------------------------------------------------------------
-- Direction 2: no verdict, and therefore no observable change whatsoever.
-- --------------------------------------------------------------------------

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) VALUES (
  'd1200000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000001',
  28, 'XTS', 'active', '2026-05-01T00:00:00Z', '2026-08-01T00:00:00Z'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt
) VALUES (
  'd1300000-0000-4000-8000-000000000002',
  'd1200000-0000-4000-8000-000000000002',
  2, '2026-08-01T00:00:00Z', 'planned',
  'class-absent-cycle-0002', 0
);
INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES (
  'd1400000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000001',
  'XTS', 'ZZ', '{"kind":"unit_count","value":28}'::jsonb, 'draft',
  2499, 2499, 'subscription_cycle',
  'd1200000-0000-4000-8000-000000000002',
  'd1300000-0000-4000-8000-000000000002'
);

CREATE TEMP TABLE _unclassified_intent AS
SELECT
  (response #>> '{paymentIntent,id}')::uuid AS intent_id,
  (response #>> '{paymentIntent,paymentId}')::uuid AS payment_id
FROM (SELECT public.commerce_payment_control_create_intent(
  'class-absent-intent-0002', 'subscription_cycle',
  'd1400000-0000-4000-8000-000000000002',
  'd1200000-0000-4000-8000-000000000002',
  'd1300000-0000-4000-8000-000000000002',
  2499, 'XTS', '{}'::jsonb
) AS response) s;
CREATE TEMP TABLE _unclassified_attempt AS
SELECT (public.commerce_payment_control_record_attempt(
  'class-absent-attempt-0002',
  (SELECT intent_id FROM _unclassified_intent),
  'card_rail', 'pay_class_absent', 'pay_class_absent', 'processing', NULL,
  '{}'::jsonb, '{"providerStatus":"processing"}'::jsonb
) #>> '{paymentAttempt,id}')::uuid AS attempt_id;

-- Fourteen arguments: the exact call every caller made before this migration
-- existed, still legal because both new parameters default to NULL.
CREATE TEMP TABLE _unclassified_result AS
SELECT public.commerce_payment_control_apply_reconciliation_result(
  'class-absent-apply-0002',
  'd1400000-0000-4000-8000-000000000002',
  (SELECT intent_id FROM _unclassified_intent),
  (SELECT attempt_id FROM _unclassified_attempt),
  (SELECT payment_id FROM _unclassified_intent),
  'card_rail', 'pay_class_absent', 'processing', 'failed', 'failed',
  '2026-08-01T09:00:00Z', 'card_declined', '2026-08-01T09:01:00Z',
  '{"source":"payment-provider-reconciliation.v0"}'::jsonb
) AS result;

SELECT is(
  (SELECT result #>> '{paymentReconciliationApply,subscriptionWebhookDunning,opened}'
    FROM _unclassified_result),
  'true',
  'an unclassified reconciled refusal opens the dunning case exactly as before'
);
-- NULL, not the string 'null' and not a coerced default: the SQL stamps nothing
-- when the caller classified nothing.
SELECT ok(
  (SELECT failure_class IS NULL FROM public.subscription_dunning_cases
    WHERE cycle_id = 'd1300000-0000-4000-8000-000000000002'),
  'an unclassified refusal leaves the case class NULL'
);
SELECT ok(
  (SELECT failure_class IS NULL FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _unclassified_attempt)),
  'an unclassified refusal leaves the attempt class NULL'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _unclassified_attempt)),
  'failed',
  'an unclassified refusal still terminalizes the claimed attempt'
);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_reconciliation_runs
    WHERE idempotency_key = 'class-absent-apply-0002:evidence'),
  1,
  'an unclassified refusal still records exactly one evidence row'
);

SELECT * FROM finish();
ROLLBACK;
