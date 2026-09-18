-- pgTAP: enqueue_checkout_recovery_reminders (20260708090001).
--   * a subscription first-cycle order (pending_payment, sub pending_activation)
--     older than 1h enqueues a `commerce.checkout_recovery` outbox event AND mints
--     exactly one recovery token (hash stored), with TTL = order.created_at + 24h
--   * a one-time order (pending_payment) older than 1h also enqueues
--   * a too-recent order (< 1h old) is NOT enqueued
--   * a paid/stale-success or fresh active payment session is NOT enqueued
--   * re-running is idempotent (no duplicate token / outbox row per order+wave)
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(11);

-- ---- catalog fixture ------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-0000-0000-0000-0000000000c1', 'recovery-enqueue@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('22222222-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000c1', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-0000000000c1', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-0000-0000-0000-0000000000d1', 'recovery-enqueue-prod', 'Recovery Enqueue Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('55555555-0000-0000-0000-0000000000f1', '44444444-0000-0000-0000-0000000000d1', 'REC-SKU-1', 'Rec SKU 1', 'dog', 400, 350, 'active');

-- ===== Scenario A — subscription first cycle, eligible (2h old) =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-0000000000c1', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-0000000000f1', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"REC-SKU-1"}'::jsonb);
CREATE TEMP TABLE _a AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-0000000000c1',
  '22222222-0000-0000-0000-0000000000e1','33333333-0000-0000-0000-0000000000a1',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders
   SET mode='subscription_cycle', subscription_id=(SELECT sub_id FROM _a),
       subscription_cycle_id=(SELECT cyc_id FROM _a),
       status='pending_payment', created_at = now() - interval '2 hours'
 WHERE id='a0000000-0000-0000-0000-0000000000a1';

-- ===== Scenario B — one-time order, eligible (2h old) =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, status, total_cents, subtotal_cents, mode, created_at)
VALUES ('b0000000-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-0000000000c1', 'PLN', 'PL', 'pending_payment', 1340, 1340, 'one_time', now() - interval '2 hours');

-- ===== Scenario C — too recent (30 min old) =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, status, total_cents, subtotal_cents, mode, created_at)
VALUES ('c0000000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-0000000000c1', 'PLN', 'PL', 'pending_payment', 1340, 1340, 'one_time', now() - interval '30 minutes');

-- ===== Scenario D — pending order but payment already succeeded =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, status, total_cents, subtotal_cents, mode, created_at)
VALUES ('d0000000-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-0000000000c1', 'PLN', 'PL', 'pending_payment', 1340, 1340, 'one_time', now() - interval '2 hours');
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency, updated_at)
VALUES ('d2000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000000d1',
        'tpay', 'checkout-recovery-paid', 'succeeded', 1340, 'PLN', now() - interval '10 minutes');

-- ===== Scenario E — fresh active payment session =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, status, total_cents, subtotal_cents, mode, created_at)
VALUES ('e0000000-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000c1', 'PLN', 'PL', 'pending_payment', 1340, 1340, 'one_time', now() - interval '2 hours');
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency, updated_at)
VALUES ('e2000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-0000000000e1',
        'tpay', 'checkout-recovery-active', 'pending', 1340, 'PLN', now() - interval '5 minutes');

-- ===== Scenario F — stale pending payment activity, still recoverable =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, status, total_cents, subtotal_cents, mode, created_at)
VALUES ('f0000000-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-0000000000c1', 'PLN', 'PL', 'pending_payment', 1340, 1340, 'one_time', now() - interval '2 hours');
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency, updated_at)
VALUES ('f2000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000f1',
        'tpay', 'checkout-recovery-stale', 'pending', 1340, 'PLN', now() - interval '30 minutes');

-- ---- run the enqueue ------------------------------------------------------
SELECT public.enqueue_checkout_recovery_reminders(200);

-- 1) sub order: 1h outbox event enqueued
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:a0000000-0000-0000-0000-0000000000a1'),
  1, 'subscription order enqueues a 1h checkout_recovery outbox event');

-- 2) sub order: exactly one token minted
SELECT is(
  (SELECT count(*)::int FROM public.commerce_checkout_recovery_tokens
    WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  1, 'subscription order mints exactly one recovery token');

-- 3) token TTL = created_at + 24h
SELECT is(
  (SELECT expires_at FROM public.commerce_checkout_recovery_tokens
    WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  (SELECT created_at + interval '24 hours' FROM public.commerce_orders
    WHERE id='a0000000-0000-0000-0000-0000000000a1'),
  'recovery token TTL is order.created_at + 24h');

-- 4) one-time order also enqueued
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:b0000000-0000-0000-0000-0000000000b1'),
  1, 'one-time order enqueues a 1h checkout_recovery outbox event');

-- 5) too-recent order NOT enqueued
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:c0000000-0000-0000-0000-0000000000c1'),
  0, 'order younger than 1h is not enqueued');

-- 6) token hash is stored, never a raw/empty value
SELECT ok(
  (SELECT length(token_hash)=64 FROM public.commerce_checkout_recovery_tokens
    WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  'token stored as a 64-char sha256 hex hash');

-- 7) minted recoveryToken is quoted-printable-safe: a NON-hex leading char keeps
--    the `?token=` email link from being eaten as a QP escape (20260709110000).
SELECT ok(
  (SELECT (payload->>'recoveryToken') ~ '^rcv_[A-Za-z0-9]+$' FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:a0000000-0000-0000-0000-0000000000a1'),
  'recovery token is rcv_-prefixed (non-hex leading) so the ?token= link survives quoted-printable');

-- 8) pending order with a succeeded payment is NOT enqueued
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:d0000000-0000-0000-0000-0000000000d1'),
  0, 'pending order with a succeeded payment is not recovered');

-- 9) fresh active session is NOT enqueued
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:e0000000-0000-0000-0000-0000000000e1'),
  0, 'fresh active payment session is not recovered');

-- 10) stale pending payment activity remains recoverable
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type='commerce.checkout_recovery'
      AND idempotency_key='checkout_recovery:1h:f0000000-0000-0000-0000-0000000000f1'),
  1, 'stale pending payment activity still enqueues recovery');

-- 11) idempotent: a second run mints no extra token for the same order+wave
SELECT public.enqueue_checkout_recovery_reminders(200);
SELECT is(
  (SELECT count(*)::int FROM public.commerce_checkout_recovery_tokens
    WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  1, 're-running enqueue does not duplicate the token (ON CONFLICT outbox dedupe)');

SELECT * FROM finish();
ROLLBACK;
