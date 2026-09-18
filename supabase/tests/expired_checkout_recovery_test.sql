-- pgTAP: commerce_prepare_expired_checkout_recovery (20260721200000).
--   * system-expired one-time checkout links a fresh draft to the expired source
--     without reviving the old payment intent/reservation;
--   * exact replay is idempotent on the already-linked replacement;
--   * manual cancellations and money-moved orders are rejected;
--   * system-abandoned provisional subscriptions reuse the same subscription and
--     cycle, reopening them to pending_activation/payment_pending for the fresh
--     replacement order.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(23);

INSERT INTO public.clients (id, email, first_name)
VALUES
  ('90000000-0000-4000-8000-000000000001', 'expired-recovery@example.invalid', 'Expired'),
  ('90000000-0000-4000-8000-000000000002', 'expired-recovery-sub@example.invalid', 'Sub');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('90000000-0000-4000-8000-000000000010', 'expired-recovery-product', 'Expired Recovery Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES (
  '90000000-0000-4000-8000-000000000011',
  '90000000-0000-4000-8000-000000000010',
  'EXPIRED-RECOVERY-SKU',
  'Expired Recovery SKU',
  'dog',
  400,
  350,
  'active'
);

CREATE OR REPLACE FUNCTION pg_temp.insert_recovery_order(
  p_order_id uuid,
  p_client_id uuid,
  p_status text,
  p_mode text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_subscription_id uuid DEFAULT NULL,
  p_subscription_cycle_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.commerce_orders (
    id, client_id, currency, region_code, status, total_cents, subtotal_cents,
    mode, subscription_id, subscription_cycle_id, metadata, created_at
  ) VALUES (
    p_order_id, p_client_id, 'PLN', 'PL', p_status, 2680, 2680,
    p_mode, p_subscription_id, p_subscription_cycle_id, p_metadata,
    now() - interval '2 hours'
  );

  INSERT INTO public.commerce_order_items (
    id, order_id, sku_id, quantity, unit_price_cents, total_cents,
    discount_allocated_cents, effective_total_cents, effective_net_cents,
    vat_rate_bps, product_snapshot
  ) VALUES (
    gen_random_uuid(), p_order_id, '90000000-0000-4000-8000-000000000011',
    2, 1340, 2680, 0, 2680,
    round((2680)::numeric * 10000 / (10000 + 800))::integer,
    800,
    '{"sku":"EXPIRED-RECOVERY-SKU"}'::jsonb
  );
END;
$$;

-- ===== One-time system-expired success + lineage ==========================
SELECT pg_temp.insert_recovery_order(
  '91000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  'expired',
  'one_time',
  '{"paymentStatus":"expired","source":"commerce.reservation_sweep.v0"}'::jsonb
);
SELECT pg_temp.insert_recovery_order(
  '91000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  'draft',
  'one_time'
);

CREATE TEMP TABLE _one_time_result AS
SELECT public.commerce_prepare_expired_checkout_recovery(
  'expired-recovery-one-time-0001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002'
) AS r;

SELECT is(
  (SELECT r->>'replacementOrderId' FROM _one_time_result),
  '91000000-0000-4000-8000-000000000002',
  'one-time recovery returns the replacement order id');

SELECT is(
  (SELECT (r->>'replayed')::boolean FROM _one_time_result),
  false,
  'one-time recovery is not marked replayed on first execution');

SELECT is(
  (SELECT recovery_root_order_id::text FROM public.commerce_orders
    WHERE id = '91000000-0000-4000-8000-000000000002'),
  '91000000-0000-4000-8000-000000000001',
  'replacement lineage stores the root source order id');

SELECT is(
  (SELECT recreated_from_order_id::text FROM public.commerce_orders
    WHERE id = '91000000-0000-4000-8000-000000000002'),
  '91000000-0000-4000-8000-000000000001',
  'replacement lineage stores the immediate predecessor id');

SELECT is(
  (SELECT metadata->>'recoveryIdempotencyKey' FROM public.commerce_orders
    WHERE id = '91000000-0000-4000-8000-000000000002'),
  'expired-recovery-one-time-0001',
  'replacement metadata stores the recovery idempotency key');

-- ===== Replay ==============================================================
CREATE TEMP TABLE _one_time_replay AS
SELECT public.commerce_prepare_expired_checkout_recovery(
  'expired-recovery-one-time-0001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002'
) AS r;

SELECT is(
  (SELECT (r->>'replayed')::boolean FROM _one_time_replay),
  true,
  'exact replay returns replayed=true');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_orders
    WHERE recreated_from_order_id = '91000000-0000-4000-8000-000000000001'),
  1,
  'exact replay does not link another replacement order');

SELECT pg_temp.insert_recovery_order(
  '91000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000001',
  'draft',
  'one_time'
);

SELECT throws_ok(
  $$SELECT public.commerce_prepare_expired_checkout_recovery(
    'expired-recovery-one-time-0002',
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000003'
  )$$,
  '23505',
  'commerce_expired_recovery_source_already_recreated',
  'a source cannot be linked to a second replacement order');

SELECT is(
  (SELECT recreated_from_order_id FROM public.commerce_orders
    WHERE id = '91000000-0000-4000-8000-000000000003'),
  NULL,
  'duplicate replacement rejection leaves the second draft unlinked');

-- ===== Manual-cancelled source rejects ====================================
SELECT pg_temp.insert_recovery_order(
  '92000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  'expired',
  'one_time',
  '{"paymentStatus":"expired","source":"commerce.reservation_sweep.v0","manualOrderCancellation":true}'::jsonb
);
SELECT pg_temp.insert_recovery_order(
  '92000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  'draft',
  'one_time'
);

SELECT throws_ok(
  $$SELECT public.commerce_prepare_expired_checkout_recovery(
    'expired-recovery-manual-0001',
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000002'
  )$$,
  '22023',
  'commerce_expired_recovery_manually_cancelled',
  'manual-cancelled expired source is not recoverable');

SELECT is(
  (SELECT recreated_from_order_id FROM public.commerce_orders
    WHERE id = '92000000-0000-4000-8000-000000000002'),
  NULL,
  'manual-cancelled reject leaves the replacement unlinked');

-- ===== Money-moved source rejects =========================================
SELECT pg_temp.insert_recovery_order(
  '93000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  'expired',
  'one_time',
  '{"paymentStatus":"expired","source":"commerce.reservation_sweep.v0"}'::jsonb
);
SELECT pg_temp.insert_recovery_order(
  '93000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  'draft',
  'one_time'
);
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '93000000-0000-4000-8000-000000000010',
  '93000000-0000-4000-8000-000000000001',
  'stripe',
  'pi_expired_recovery_money_moved',
  'succeeded',
  2680,
  'PLN'
);

SELECT throws_ok(
  $$SELECT public.commerce_prepare_expired_checkout_recovery(
    'expired-recovery-money-0001',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002'
  )$$,
  '23505',
  'commerce_expired_recovery_money_moved',
  'source with succeeded payment is rejected as money moved');

SELECT is(
  (SELECT recreated_from_order_id FROM public.commerce_orders
    WHERE id = '93000000-0000-4000-8000-000000000002'),
  NULL,
  'money-moved reject leaves the replacement unlinked');

-- ===== Subscription system-abandoned recovery =============================
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, started_at, ended_at,
  cancellation_reason, cancellation_source, size_constraint
) VALUES (
  '94000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000002',
  21,
  'PLN',
  'PL',
  'cancelled',
  now() - interval '2 days',
  now() - interval '1 hour',
  'subscription_activation_abandoned',
  'system_provisional_activation_timeout',
  '{"kind":"feeding_days","value":21}'::jsonb
);

INSERT INTO public.subscription_lines (
  id, subscription_id, variant_id, qty, sort_order, is_addon
) VALUES (
  '94000000-0000-4000-8000-000000000011',
  '94000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000011',
  2,
  0,
  false
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, order_id,
  retry_attempt, next_retry_at, failure_reason, payment_method_ref, template_snapshot,
  engine_idempotency_key
) VALUES (
  '94000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000001',
  1,
  now() - interval '2 hours',
  'cancelled',
  NULL,
  2,
  NULL,
  'subscription_activation_abandoned',
  'pm_old_ref',
  public.subscription_current_template_snapshot('94000000-0000-4000-8000-000000000001'),
  'expired-recovery-sub-cycle-0001'
);

SELECT pg_temp.insert_recovery_order(
  '94000000-0000-4000-8000-000000000003',
  '90000000-0000-4000-8000-000000000002',
  'cancelled',
  'one_time',
  '{"source":"subscription.sweep.v0"}'::jsonb
);

UPDATE public.commerce_orders
   SET mode = 'subscription_cycle',
       subscription_id = '94000000-0000-4000-8000-000000000001',
       subscription_cycle_id = '94000000-0000-4000-8000-000000000002'
 WHERE id = '94000000-0000-4000-8000-000000000003';

UPDATE public.subscription_cycles
   SET order_id = '94000000-0000-4000-8000-000000000003'
 WHERE id = '94000000-0000-4000-8000-000000000002';

INSERT INTO public.subscription_events (
  subscription_id, cycle_id, event_type, idempotency_key, payload, occurred_at
) VALUES (
  '94000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000002',
  'subscription.activation_abandoned',
  'expired-recovery-sub-abandoned-0001',
  '{"orderId":"94000000-0000-4000-8000-000000000003"}'::jsonb,
  now() - interval '1 hour'
);

SELECT pg_temp.insert_recovery_order(
  '94000000-0000-4000-8000-000000000004',
  '90000000-0000-4000-8000-000000000002',
  'draft',
  'one_time'
);

CREATE TEMP TABLE _subscription_result AS
SELECT public.commerce_prepare_expired_checkout_recovery(
  'expired-recovery-sub-0001',
  '94000000-0000-4000-8000-000000000003',
  '94000000-0000-4000-8000-000000000004'
) AS r;

SELECT is(
  (SELECT r->>'replacementOrderId' FROM _subscription_result),
  '94000000-0000-4000-8000-000000000004',
  'subscription recovery returns the replacement order id');

SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id = '94000000-0000-4000-8000-000000000001'),
  'pending_activation',
  'system-abandoned subscription is reopened to pending_activation');

SELECT is(
  (SELECT status || '|' || order_id::text || '|' || retry_attempt::text || '|' ||
          COALESCE(next_retry_at::text, 'NULL') || '|' || COALESCE(payment_method_ref, 'NULL')
     FROM public.subscription_cycles
    WHERE id = '94000000-0000-4000-8000-000000000002'),
  'payment_pending|94000000-0000-4000-8000-000000000004|0|NULL|NULL',
  'same subscription cycle is reused for the replacement and reset for payment');

SELECT is(
  (SELECT mode || '|' || subscription_id::text || '|' || subscription_cycle_id::text
     FROM public.commerce_orders
    WHERE id = '94000000-0000-4000-8000-000000000004'),
  'subscription_cycle|94000000-0000-4000-8000-000000000001|94000000-0000-4000-8000-000000000002',
  'replacement order reuses the same subscription and cycle identifiers');

SELECT is(
  (SELECT mode || '|' || COALESCE(subscription_id::text, 'NULL') || '|' ||
          COALESCE(subscription_cycle_id::text, 'NULL') || '|' ||
          (metadata->>'recoveredByOrderId')
     FROM public.commerce_orders
    WHERE id = '94000000-0000-4000-8000-000000000003'),
  'one_time|NULL|NULL|94000000-0000-4000-8000-000000000004',
  'expired source order releases the unique subscription-cycle ownership to the replacement');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE idempotency_key = 'subscription-checkout-recovery:94000000-0000-4000-8000-000000000003'),
  1,
  'subscription recovery records one reopened audit event');

SELECT is(
  (SELECT recovery_root_order_id::text || '|' || recreated_from_order_id::text
     FROM public.commerce_orders
    WHERE id = '94000000-0000-4000-8000-000000000004'),
  '94000000-0000-4000-8000-000000000003|94000000-0000-4000-8000-000000000003',
  'subscription replacement stores root and predecessor lineage');

SELECT public.commerce_cancel_abandoned_checkout(
  'expired-recovery-compensation',
  '94000000-0000-4000-8000-000000000004',
  'expired_checkout_recovery_failed'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '94000000-0000-4000-8000-000000000001'),
  'cancelled',
  'downstream recovery failure compensates the reopened provisional subscription');

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = '94000000-0000-4000-8000-000000000002'),
  'cancelled',
  'downstream recovery failure compensates the rebound first cycle');

SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = '94000000-0000-4000-8000-000000000004'),
  'cancelled',
  'downstream recovery failure cancels the replacement order');

SELECT * FROM finish();
ROLLBACK;
