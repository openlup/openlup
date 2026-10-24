-- Managed full-refund lifecycle boundary: first-cycle stock release, renewal and replay.
BEGIN;
SELECT plan(30);

CREATE TEMP TABLE refund_lifecycle_cases (
  label text PRIMARY KEY, cycle_number integer, client_id uuid DEFAULT gen_random_uuid(),
  subscription_id uuid DEFAULT gen_random_uuid(), cycle_id uuid DEFAULT gen_random_uuid(),
  order_id uuid DEFAULT gen_random_uuid(), sku_id uuid DEFAULT gen_random_uuid(),
  product_id uuid DEFAULT gen_random_uuid(), location_id uuid DEFAULT gen_random_uuid(),
  reservation_id uuid DEFAULT gen_random_uuid(), intent_id uuid, event_id uuid,
  subscription_before jsonb, cycle_before jsonb, reservation_before jsonb,
  response jsonb, replay_response jsonb, state_before_replay jsonb
);
INSERT INTO refund_lifecycle_cases(label, cycle_number) VALUES ('first', 1), ('renewal', 2);

INSERT INTO public.clients(id, email)
SELECT client_id, 'refund-lifecycle-' || label || '@example.invalid' FROM refund_lifecycle_cases;
INSERT INTO public.catalog_products(id, slug, name, status)
SELECT product_id, 'refund-lifecycle-' || label, 'Refund lifecycle fixture', 'active' FROM refund_lifecycle_cases;
INSERT INTO public.catalog_skus(id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
SELECT sku_id, product_id, 'REFUND-LIFECYCLE-' || label, 'Refund lifecycle fixture', 'dog', 'active', 400, 350
FROM refund_lifecycle_cases;
INSERT INTO public.inventory_locations(id, code, display_name, kind, status, fulfillable)
SELECT location_id, 'refund-lifecycle-' || label, 'Refund lifecycle fixture', 'virtual', 'active', true
FROM refund_lifecycle_cases;
INSERT INTO public.inventory_balances(sku_id, location_id, on_hand, reserved)
SELECT sku_id, location_id, 10, 2 FROM refund_lifecycle_cases;
INSERT INTO public.subscriptions(id, client_id, cadence_days, currency, status, started_at, next_cycle_at, payment_method_ref, payment_method_kind)
SELECT subscription_id, client_id, 28, 'XTS', 'active', '2026-01-01', '2030-01-01', 'pm_refund_lifecycle_' || label, 'card'
FROM refund_lifecycle_cases;
INSERT INTO public.subscription_lines(subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT subscription_id, sku_id, 1, 0, false, 1 FROM refund_lifecycle_cases;
INSERT INTO public.subscription_cycles(id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
SELECT cycle_id, subscription_id, cycle_number, '2026-01-01', 'planned', 'refund-lifecycle:' || label || ':cycle'
FROM refund_lifecycle_cases;
INSERT INTO public.commerce_orders(id, client_id, status, mode, currency, total_cents, subtotal_cents, subscription_id, subscription_cycle_id)
SELECT order_id, client_id, 'draft', 'subscription_cycle', 'XTS', 10000, 10000, subscription_id, cycle_id
FROM refund_lifecycle_cases;
UPDATE public.subscription_cycles c SET order_id = f.order_id FROM refund_lifecycle_cases f WHERE c.id = f.cycle_id;

-- Fixtures are owner-written; all payment operations use the shipped runtime role.
GRANT SELECT, UPDATE ON refund_lifecycle_cases TO service_role;
SET LOCAL ROLE service_role;
UPDATE refund_lifecycle_cases SET intent_id = (public.commerce_payment_control_create_intent(
  'refund-lifecycle:' || label || ':intent', 'subscription_cycle', order_id, subscription_id, cycle_id, 10000, 'XTS', '{}'
) #>> '{paymentIntent,id}')::uuid;
SELECT public.commerce_payment_control_record_attempt(
  'refund-lifecycle:' || label || ':attempt', intent_id, 'example', 'pay_refund_lifecycle_' || label,
  NULL, 'processing', NULL, '{}', '{}'
) FROM refund_lifecycle_cases;
UPDATE refund_lifecycle_cases SET event_id = (public.commerce_payment_control_ingest_event(
  'example', 'refund-lifecycle:' || label || ':paid-event', 'payment.succeeded', 'pay_refund_lifecycle_' || label,
  intent_id, NULL, 10000, 'XTS', true, '{}'
) #>> '{paymentEvent,id}')::uuid;
SELECT public.commerce_payment_control_apply_result(
  'refund-lifecycle:' || label || ':paid', intent_id, event_id, 'succeeded', '2026-01-02', NULL
) FROM refund_lifecycle_cases;
RESET ROLE;

-- Existing unshipped stock holds are independent of the settled payment.
INSERT INTO public.inventory_reservations(id, idempotency_key, order_id, subscription_cycle_id, sku_id, location_id, quantity, status, kind)
SELECT reservation_id, 'refund-lifecycle:' || label || ':hold', order_id, cycle_id, sku_id, location_id, 2, 'reserved', 'subscription_retry_window'
FROM refund_lifecycle_cases;
UPDATE public.subscriptions s SET updated_at = '2025-01-01' FROM refund_lifecycle_cases f WHERE s.id = f.subscription_id;
UPDATE public.subscription_cycles c SET updated_at = '2025-01-01' FROM refund_lifecycle_cases f WHERE c.id = f.cycle_id;
UPDATE refund_lifecycle_cases f SET subscription_before = to_jsonb(s), cycle_before = to_jsonb(c), reservation_before = to_jsonb(r)
FROM public.subscriptions s, public.subscription_cycles c, public.inventory_reservations r
WHERE s.id = f.subscription_id AND c.id = f.cycle_id AND r.id = f.reservation_id;

SELECT is((SELECT status FROM public.subscription_cycles WHERE id = f.cycle_id), 'paid', label || ': starts with a paid cycle')
FROM refund_lifecycle_cases f ORDER BY label;
SET LOCAL ROLE service_role;
UPDATE refund_lifecycle_cases SET event_id = (public.commerce_payment_control_ingest_event(
  'example', 'refund-lifecycle:' || label || ':refund-event', 'payment.refunded', 'pay_refund_lifecycle_' || label,
  intent_id, NULL, 10000, 'XTS', true, '{}'::jsonb
) #>> '{paymentEvent,id}')::uuid;
UPDATE refund_lifecycle_cases SET response = public.commerce_payment_control_apply_result(
  'refund-lifecycle:' || label || ':refund', intent_id, event_id, 'refunded', '2026-02-02', NULL
);
RESET ROLE;

SELECT is((SELECT to_jsonb(s) FROM public.subscriptions s WHERE id = f.subscription_id), subscription_before,
  label || ': full refund preserves every subscription field') FROM refund_lifecycle_cases f ORDER BY label;
SELECT is((SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE id = f.cycle_id), cycle_before,
  label || ': full refund preserves every paid-cycle field') FROM refund_lifecycle_cases f ORDER BY label;
SELECT is((SELECT status FROM public.commerce_orders WHERE id = f.order_id), 'refunded',
  label || ': order is financially refunded') FROM refund_lifecycle_cases f ORDER BY label;
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id = f.intent_id), 'refunded',
  label || ': payment intent is refunded') FROM refund_lifecycle_cases f ORDER BY label;
SELECT is((SELECT p.status FROM public.commerce_payments p JOIN public.commerce_payment_intents i ON i.payment_id = p.id WHERE i.id = f.intent_id), 'refunded',
  label || ': payment is refunded') FROM refund_lifecycle_cases f ORDER BY label;
SELECT is((SELECT count(*)::integer FROM public.subscription_events WHERE subscription_id = f.subscription_id AND event_type = 'subscription.activation_reversed'), 0,
  label || ': no activation reversal') FROM refund_lifecycle_cases f ORDER BY label;
SELECT is((SELECT status FROM public.inventory_reservations WHERE id = reservation_id), 'released',
  'first: existing stock reservation is released') FROM refund_lifecycle_cases WHERE label = 'first';
SELECT is((SELECT reason FROM public.inventory_stock_movements WHERE reservation_id = f.reservation_id AND movement_type = 'reservation_released'), 'subscription_activation_refunded',
  'first: stock release keeps the existing reason') FROM refund_lifecycle_cases f WHERE label = 'first';
SELECT is((SELECT reserved FROM public.inventory_balances WHERE sku_id = f.sku_id AND location_id = f.location_id), 0,
  'first: reserved balance is released') FROM refund_lifecycle_cases f WHERE label = 'first';
SELECT is((SELECT to_jsonb(r) FROM public.inventory_reservations r WHERE id = reservation_id), reservation_before,
  'renewal: existing stock reservation is unchanged') FROM refund_lifecycle_cases WHERE label = 'renewal';

-- Capture durable writes as owner, then replay the exact key/event as service_role.
CREATE FUNCTION pg_temp.refund_lifecycle_state(p_order uuid, p_subscription uuid, p_intent uuid) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'subscription', (SELECT to_jsonb(s) FROM public.subscriptions s WHERE id = p_subscription),
    'cycles', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.subscription_cycles c WHERE subscription_id = p_subscription),
    'order', (SELECT to_jsonb(o) FROM public.commerce_orders o WHERE id = p_order),
    'intent', (SELECT to_jsonb(i) FROM public.commerce_payment_intents i WHERE id = p_intent),
    'payment', (SELECT to_jsonb(p) FROM public.commerce_payments p JOIN public.commerce_payment_intents i ON i.payment_id = p.id WHERE i.id = p_intent),
    'attempts', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.commerce_payment_attempts a WHERE payment_intent_id = p_intent),
    'transitions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.commerce_payment_state_transitions t WHERE payment_intent_id = p_intent),
    'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.subscription_events e WHERE subscription_id = p_subscription),
    'outbox', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.outbox_events e WHERE aggregate_id IN (p_order, p_subscription)),
    'reservations', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.inventory_reservations r WHERE order_id = p_order),
    'movements', (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.inventory_stock_movements m WHERE reservation_id IN (SELECT id FROM public.inventory_reservations WHERE order_id = p_order)),
    'balances', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.inventory_balances b WHERE (sku_id, location_id) IN (SELECT sku_id, location_id FROM public.inventory_reservations WHERE order_id = p_order))
  );
$$;
UPDATE refund_lifecycle_cases SET state_before_replay = pg_temp.refund_lifecycle_state(order_id, subscription_id, intent_id);
SET LOCAL ROLE service_role;
UPDATE refund_lifecycle_cases SET replay_response = public.commerce_payment_control_apply_result(
  'refund-lifecycle:' || label || ':refund', intent_id, event_id, 'refunded', '2026-02-02', NULL
);
RESET ROLE;
SELECT is((replay_response #>> '{paymentResult,replayed}')::boolean, true, label || ': replay is identified')
FROM refund_lifecycle_cases ORDER BY label;
SELECT is(replay_response #- '{paymentResult,replayed}', response #- '{paymentResult,replayed}',
  label || ': replay returns the original result') FROM refund_lifecycle_cases ORDER BY label;
SELECT is(pg_temp.refund_lifecycle_state(order_id, subscription_id, intent_id), state_before_replay,
  label || ': replay changes no durable lifecycle, payment, event or stock row') FROM refund_lifecycle_cases ORDER BY label;
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_state_transitions WHERE payment_intent_id = intent_id AND transition_kind = 'refund'), 1,
  label || ': exactly one refund transition') FROM refund_lifecycle_cases ORDER BY label;
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE aggregate_id = order_id AND event_type = 'commerce.order.refunded'), 1,
  label || ': exactly one refund outbox event') FROM refund_lifecycle_cases ORDER BY label;
SELECT is((SELECT count(*)::integer FROM public.subscription_events WHERE subscription_id = f.subscription_id AND event_type = 'subscription.activation_reversed'), 0,
  label || ': replay writes no activation reversal') FROM refund_lifecycle_cases f ORDER BY label;
SELECT * FROM finish();
ROLLBACK;
