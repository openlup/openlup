-- pgTAP: paid Tpay Model O activation-gap recovery.
--
-- Proves the fail-closed detector, bounded/idempotent reminder enqueue, atomic
-- card recovery without a second payment, and card precedence over a late
-- ALIAS_REGISTER delivery.

BEGIN;
SELECT plan(20);

INSERT INTO public.clients (id, email)
VALUES ('91000000-0000-4000-8000-000000000001', 'paid-gap@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000001', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000001', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('91000000-0000-4000-8000-000000000004', 'paid-gap-product', 'Paid gap product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('91000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000004', 'PAID-GAP-SKU', 'Paid gap SKU', 'dog', 400, 350, 'active');

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  subtotal_cents, total_cents
) VALUES (
  '91000000-0000-4000-8000-000000000006',
  '91000000-0000-4000-8000-000000000001',
  'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 1340, 1340
);
INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents,
  product_snapshot
) VALUES (
  '91000000-0000-4000-8000-000000000007',
  '91000000-0000-4000-8000-000000000006',
  '91000000-0000-4000-8000-000000000005',
  1, 1340, 1340, 0, 1340,
  round((1340)::numeric * 10000 / (10000 + 800))::integer,
  '{"sku":"PAID-GAP-SKU"}'::jsonb
);

CREATE TEMP TABLE _paid_gap_subscription AS
SELECT
  (result->>'subscriptionId')::uuid AS subscription_id,
  (result->>'subscriptionCycleId')::uuid AS cycle_id
FROM (
  SELECT public.subscription_create_provisional_for_checkout(
    '91000000-0000-4000-8000-000000000006',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000003',
    '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb
  ) AS result
) created;

UPDATE public.commerce_orders
SET mode = 'subscription_cycle',
    status = 'paid',
    subscription_id = (SELECT subscription_id FROM _paid_gap_subscription),
    subscription_cycle_id = (SELECT cycle_id FROM _paid_gap_subscription)
WHERE id = '91000000-0000-4000-8000-000000000006';

UPDATE public.subscription_cycles
SET status = 'paid', paid_at = now() - interval '5 hours'
WHERE id = (SELECT cycle_id FROM _paid_gap_subscription);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '91000000-0000-4000-8000-000000000008',
  '91000000-0000-4000-8000-000000000006',
  'tpay', 'tpay-paid-gap-1', 'succeeded', 1340, 'PLN'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id,
  amount_cents, currency, status
) VALUES (
  '91000000-0000-4000-8000-000000000009',
  'subscription_cycle',
  '91000000-0000-4000-8000-000000000006',
  (SELECT subscription_id FROM _paid_gap_subscription),
  (SELECT cycle_id FROM _paid_gap_subscription),
  '91000000-0000-4000-8000-000000000008',
  1340, 'PLN', 'succeeded'
);

INSERT INTO public.commerce_payment_attempts (
  id, payment_intent_id, payment_id, provider, provider_attempt_id,
  idempotency_key, status, amount_cents, currency, request_payload
) VALUES (
  '91000000-0000-4000-8000-000000000010',
  '91000000-0000-4000-8000-000000000009',
  '91000000-0000-4000-8000-000000000008',
  'tpay', 'tpay-attempt-paid-gap-1', 'paid-gap-attempt-1', 'succeeded', 1340, 'PLN',
  '{"providerFlow":"blik_recurring_activation","recurringModel":"M"}'::jsonb
);
UPDATE public.commerce_payment_intents
SET active_attempt_id = '91000000-0000-4000-8000-000000000010'
WHERE id = '91000000-0000-4000-8000-000000000009';

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_paid_activation_gaps),
  0,
  'Model M is excluded'
);

UPDATE public.commerce_payment_attempts
SET request_payload = '{"providerFlow":"blik_recurring_activation","recurringModel":"O"}'::jsonb,
    provider = 'stripe'
WHERE id = '91000000-0000-4000-8000-000000000010';
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_paid_activation_gaps),
  0,
  'a Stripe fallback attempt is excluded'
);

UPDATE public.commerce_payment_attempts
SET provider = 'tpay'
WHERE id = '91000000-0000-4000-8000-000000000010';
UPDATE public.commerce_payment_attempts
SET request_payload = '{"providerFlow":"blik_one_time"}'::jsonb
WHERE id = '91000000-0000-4000-8000-000000000010';
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_paid_activation_gaps),
  0,
  'one-time BLIK is excluded'
);

UPDATE public.commerce_payment_attempts
SET request_payload = '{"providerFlow":"blik_recurring_activation","recurringModel":"O"}'::jsonb
WHERE id = '91000000-0000-4000-8000-000000000010';
UPDATE public.subscription_cycles
SET cycle_number = 2
WHERE id = (SELECT cycle_id FROM _paid_gap_subscription);
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_paid_activation_gaps),
  0,
  'a later renewal cycle is never mistaken for the initial paid activation gap'
);
UPDATE public.subscription_cycles
SET cycle_number = 1
WHERE id = (SELECT cycle_id FROM _paid_gap_subscription);
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_paid_activation_gaps),
  1,
  'the exact paid Tpay Model O subscription without a mandate is detected'
);

CREATE TEMP TABLE _first_scan AS
SELECT public.subscription_reconcile_paid_activation_gaps(200) AS result;
SELECT is(
  (SELECT result #>> '{paidActivationGapReconciliation,enqueued}' FROM _first_scan),
  '1',
  'the 30-minute reminder is enqueued once'
);
SELECT is(
  (SELECT result #>> '{paidActivationGapReconciliation,overdue}' FROM _first_scan),
  '1',
  'the 4-hour overdue count is exact'
);
SELECT is(
  (SELECT public.subscription_reconcile_paid_activation_gaps(200)
    #>> '{paidActivationGapReconciliation,enqueued}'),
  '0',
  'a repeated scan does not enqueue a duplicate email'
);
SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE event_type = 'subscription.activation_action_required'
      AND aggregate_id = (SELECT subscription_id FROM _paid_gap_subscription)),
  1,
  'the existing outbox contains exactly one exact-subscription reminder'
);

SELECT public.commerce_payment_method_ref_upsert(
  'paid-gap-card-method-1',
  '91000000-0000-4000-8000-000000000001'::uuid,
  (SELECT subscription_id FROM _paid_gap_subscription),
  'stripe', 'card', 'cus_paid_gap', 'pm_paid_gap', NULL, 'active',
  true, NULL, '{"source":"stripe.setup_intent.succeeded"}'::jsonb, '{}'::jsonb
);

-- Simulate the dangerous interleaving: Stripe persisted the new card, then an
-- ALIAS_REGISTER transaction won just before card recovery acquired the shared
-- subscription lock. The card row remains verified but is temporarily inactive.
SELECT public.commerce_tpay_alias_method_ref_upsert_guarded(
  'paid-gap-racing-tpay-alias-1',
  '91000000-0000-4000-8000-000000000001'::uuid,
  (SELECT subscription_id FROM _paid_gap_subscription),
  'tpay', 'blik_payid', NULL, 'PAYID-racing', 'ALIAS-racing', 'active',
  true, NULL, '{"source":"ALIAS_REGISTER"}'::jsonb, '{}'::jsonb
);
SELECT is(
  (SELECT active FROM public.commerce_payment_method_refs
   WHERE provider_kind = 'stripe' AND provider_method_ref = 'pm_paid_gap'),
  false,
  'the fixture reproduces the alias-winning race before card recovery'
);

CREATE TEMP TABLE _card_recovery AS
SELECT public.subscription_recover_paid_activation_with_card(
  'paid-gap-card-recovery-1',
  (SELECT subscription_id FROM _paid_gap_subscription),
  'pm_paid_gap',
  now()
) AS result;

SELECT is(
  (SELECT result #>> '{paidActivationCardRecovery,recovered}' FROM _card_recovery),
  'true',
  'the exact paid subscription is recovered with the verified card'
);
SELECT is(
  (SELECT status || ':' || payment_method_kind
   FROM public.subscriptions
   WHERE id = (SELECT subscription_id FROM _paid_gap_subscription)),
  'active:card',
  'card recovery atomically activates the subscription and makes card authoritative'
);
SELECT is(
  (SELECT provider_kind || ':' || provider_method_ref
   FROM public.commerce_payment_method_refs
   WHERE subscription_id = (SELECT subscription_id FROM _paid_gap_subscription)
     AND active = true),
  'stripe:pm_paid_gap',
  'card recovery reactivates the verified card even when the alias won immediately before the lock'
);

CREATE TEMP TABLE _racing_alias_replay AS
SELECT public.commerce_tpay_alias_method_ref_upsert_guarded(
  'paid-gap-racing-tpay-alias-1',
  '91000000-0000-4000-8000-000000000001'::uuid,
  (SELECT subscription_id FROM _paid_gap_subscription),
  'tpay', 'blik_payid', NULL, 'PAYID-racing', 'ALIAS-racing', 'active',
  true, NULL, '{"source":"ALIAS_REGISTER"}'::jsonb, '{}'::jsonb
) AS result;
SELECT is(
  (SELECT result #>> '{paymentMethodRef,subscriptionBindingSkipped}' FROM _racing_alias_replay),
  'true',
  'the same alias event can replay after card selection without an idempotency conflict'
);
SELECT is(
  (SELECT status FROM public.commerce_payments
   WHERE id = '91000000-0000-4000-8000-000000000008'),
  'succeeded',
  'card recovery does not create or mutate the already-settled first payment'
);
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_paid_activation_gaps),
  0,
  'the repaired subscription immediately leaves the gap view'
);
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_events
   WHERE subscription_id = (SELECT subscription_id FROM _paid_gap_subscription)
     AND event_type = 'subscription.activation_recovered_with_card'),
  1,
  'card recovery writes one auditable subscription event'
);

CREATE TEMP TABLE _late_alias AS
SELECT public.commerce_tpay_alias_method_ref_upsert_guarded(
  'paid-gap-late-tpay-alias-1',
  '91000000-0000-4000-8000-000000000001'::uuid,
  (SELECT subscription_id FROM _paid_gap_subscription),
  'tpay', 'blik_payid', NULL, 'PAYID-late', 'ALIAS-late', 'active',
  true, NULL, '{"source":"ALIAS_REGISTER"}'::jsonb, '{}'::jsonb
) AS result;
SELECT is(
  (SELECT result #>> '{paymentMethodRef,subscriptionBindingSkipped}' FROM _late_alias),
  'true',
  'a late Tpay alias cannot bind over the explicitly selected card'
);
SELECT is(
  (SELECT subscription_id FROM public.commerce_payment_method_refs
   WHERE provider_kind = 'tpay' AND provider_method_ref = 'PAYID-late'),
  NULL::uuid,
  'the late alias is retained only as a client-scoped provider reference'
);
SELECT is(
  (SELECT provider_kind || ':' || provider_method_ref
   FROM public.commerce_payment_method_refs
   WHERE subscription_id = (SELECT subscription_id FROM _paid_gap_subscription)
     AND active = true),
  'stripe:pm_paid_gap',
  'the next renewal still resolves to the selected Stripe card'
);

SELECT * FROM finish();
ROLLBACK;
