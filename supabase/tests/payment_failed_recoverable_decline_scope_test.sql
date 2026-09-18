-- pgTAP: commerce.payment.failed is scoped to recoverable card declines, while
-- terminal checkout expiry emits commerce.checkout.expired.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(13);

INSERT INTO public.clients (id, email)
VALUES ('9f100000-0000-4000-8000-000000000001', 'payment-failed-scope@example.invalid');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('9f200000-0000-4000-8000-000000000001', 'payment-failed-scope-prod', 'Payment Failed Scope Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 'PF-SCOPE-SKU', 'PF Scope SKU', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('9f400000-0000-4000-8000-000000000001', 'pf-scope-loc', 'Payment Failed Scope Loc', 'virtual', 'active', true);
INSERT INTO public.inventory_balances (id, sku_id, location_id, on_hand, reserved)
VALUES ('9f500000-0000-4000-8000-000000000001', '9f300000-0000-4000-8000-000000000001', '9f400000-0000-4000-8000-000000000001', 10, 2);

-- Recoverable one-time decline: stays pending_payment and emits a customer
-- payment-failed outbox event with a tokenized checkout-recovery path.
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES ('9f600000-0000-4000-8000-000000000001', '9f100000-0000-4000-8000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 12999, 12999, 'one_time');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('9f700000-0000-4000-8000-000000000001', '9f600000-0000-4000-8000-000000000001', '9f300000-0000-4000-8000-000000000001',
        1, 12999, 12999, 0, 12999, round((12999)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"PF-SCOPE-SKU"}'::jsonb);
CREATE TEMP TABLE _recoverable AS
SELECT (public.commerce_payment_control_create_intent(
  'pf-scope-recoverable-intent', 'one_time_order', '9f600000-0000-4000-8000-000000000001',
  NULL, NULL, 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
SELECT public.commerce_payment_control_record_attempt(
  'pf-scope-recoverable-attempt', (SELECT intent_id FROM _recoverable),
  'stripe', 'pi_pf_scope_recoverable', 'ps_pf_scope_recoverable',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  '9f800000-0000-4000-8000-000000000001', 'pf-scope-recoverable-reservation',
  '9f600000-0000-4000-8000-000000000001', '9f700000-0000-4000-8000-000000000001',
  '9f300000-0000-4000-8000-000000000001', '9f400000-0000-4000-8000-000000000001',
  1, 'reserved', 'checkout_payment_window', '2026-07-03T12:00:00Z'
);

SELECT public.commerce_payment_control_apply_result(
  'pf-scope-recoverable-apply',
  (SELECT intent_id FROM _recoverable),
  NULL,
  'failed',
  '2026-07-03T12:05:00Z'::timestamptz,
  'card_declined'
);

SELECT is((SELECT status FROM public.commerce_orders WHERE id='9f600000-0000-4000-8000-000000000001'),
  'pending_payment', 'recoverable failed decline leaves order pending_payment');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='9f800000-0000-4000-8000-000000000001'),
  'reserved', 'recoverable failed decline retains the checkout reservation');
SELECT is((SELECT count(*)::int FROM public.outbox_events
            WHERE event_type='commerce.payment.failed'
              AND aggregate_id='9f600000-0000-4000-8000-000000000001'),
  1, 'recoverable failed decline emits one commerce.payment.failed event');
SELECT ok((SELECT payload->>'recoveryToken' FROM public.outbox_events
            WHERE event_type='commerce.payment.failed'
              AND aggregate_id='9f600000-0000-4000-8000-000000000001') LIKE 'rcv_%',
  'recoverable failed decline payload carries a QP-safe recovery token');
SELECT is((SELECT payload->>'mode' FROM public.outbox_events
            WHERE event_type='commerce.payment.failed'
              AND aggregate_id='9f600000-0000-4000-8000-000000000001'),
  'one_time', 'recoverable failed decline payload carries order mode');
SELECT is((SELECT count(*)::int
            FROM public.commerce_checkout_recovery_tokens t
           WHERE t.order_id = '9f600000-0000-4000-8000-000000000001'),
  1, 'recoverable failed decline stores one checkout recovery token hash');

-- Terminal expiry: the reserved order is no longer recoverable, releases stock,
-- and emits the customer-facing outbox event this template actually renders.
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES ('9f600000-0000-4000-8000-000000000002', '9f100000-0000-4000-8000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 12999, 12999, 'one_time');
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('9f700000-0000-4000-8000-000000000002', '9f600000-0000-4000-8000-000000000002', '9f300000-0000-4000-8000-000000000001',
        1, 12999, 12999, 0, 12999, round((12999)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"PF-SCOPE-SKU"}'::jsonb);
CREATE TEMP TABLE _expired AS
SELECT (public.commerce_payment_control_create_intent(
  'pf-scope-expired-intent', 'one_time_order', '9f600000-0000-4000-8000-000000000002',
  NULL, NULL, 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
SELECT public.commerce_payment_control_record_attempt(
  'pf-scope-expired-attempt', (SELECT intent_id FROM _expired),
  'stripe', 'pi_pf_scope_expired', 'ps_pf_scope_expired',
  'processing', NULL, '{}'::jsonb, '{}'::jsonb);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind, expires_at
) VALUES (
  '9f800000-0000-4000-8000-000000000002', 'pf-scope-expired-reservation',
  '9f600000-0000-4000-8000-000000000002', '9f700000-0000-4000-8000-000000000002',
  '9f300000-0000-4000-8000-000000000001', '9f400000-0000-4000-8000-000000000001',
  1, 'reserved', 'checkout_payment_window', '2026-07-03T12:00:00Z'
);

SELECT public.commerce_payment_control_apply_result(
  'pf-scope-expired-apply',
  (SELECT intent_id FROM _expired),
  NULL,
  'expired',
  '2026-07-03T12:30:00Z'::timestamptz,
  'reservation_window_elapsed'
);

SELECT is((SELECT status FROM public.commerce_orders WHERE id='9f600000-0000-4000-8000-000000000002'),
  'expired', 'terminal expired result marks order expired');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='9f800000-0000-4000-8000-000000000002'),
  'released', 'terminal expired result releases the checkout reservation');
SELECT is((SELECT count(*)::int FROM public.outbox_events
            WHERE event_type='commerce.payment.failed'
              AND aggregate_id='9f600000-0000-4000-8000-000000000002'),
  0, 'terminal expired result does not emit commerce.payment.failed event');
SELECT is((SELECT idempotency_key FROM public.outbox_events
            WHERE event_type='commerce.checkout.expired'
              AND aggregate_id='9f600000-0000-4000-8000-000000000002'),
  'checkout_expired:9f600000-0000-4000-8000-000000000002',
  'terminal expired event uses checkout_expired:<order id> idempotency');
SELECT ok((SELECT payload->>'recoveryToken' FROM public.outbox_events
            WHERE event_type='commerce.checkout.expired'
              AND aggregate_id='9f600000-0000-4000-8000-000000000002') LIKE 'rcv_%',
  'terminal expired payload carries a checkout-recovery token');
SELECT is((SELECT count(*)::int
            FROM public.commerce_checkout_recovery_tokens t
           WHERE t.order_id = '9f600000-0000-4000-8000-000000000002'
             AND t.token_hash = encode(sha256(convert_to((
               SELECT payload->>'recoveryToken'
                 FROM public.outbox_events
                WHERE event_type='commerce.checkout.expired'
                  AND aggregate_id='9f600000-0000-4000-8000-000000000002'
             ), 'UTF8')), 'hex')),
  1, 'terminal expired stores exactly the hash matching the raw outbox token');
SELECT is((SELECT count(*)::int
            FROM public.commerce_checkout_recovery_tokens t
           WHERE t.order_id = '9f600000-0000-4000-8000-000000000002'
             AND t.metadata::text LIKE '%' || (
               SELECT payload->>'recoveryToken'
                 FROM public.outbox_events
                WHERE event_type='commerce.checkout.expired'
                  AND aggregate_id='9f600000-0000-4000-8000-000000000002'
             ) || '%'),
  0, 'terminal expired does not store the raw token in token metadata');

SELECT * FROM finish();
ROLLBACK;
