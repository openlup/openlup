-- pgTAP: Model B A4 — subscription_sweep_unpaid_provisional (20260611210000).
--   * a stuck provisional (older than the window) with an unpaid order is swept:
--     subscription/order/intent cancelled, inventory released, event emitted
--   * a recent provisional (inside the window) is untouched
--   * a provisional whose order is PAID (awaiting_mandate) is never swept
--   * only no-attempt or proven pre-provider attempts are abandonment
--   * every provider-reachable status or evidence blocks destructive writes
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(33);

-- ---- Shared catalog fixture -----------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'modelb-sweep@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type) VALUES
  ('22222222-2222-2222-2222-22222222000a', '11111111-1111-1111-1111-111111111111', 'dog'),
  ('22222222-2222-2222-2222-22222222000b', '11111111-1111-1111-1111-111111111111', 'dog'),
  ('22222222-2222-2222-2222-22222222000c', '11111111-1111-1111-1111-111111111111', 'dog');
INSERT INTO public.pets (id, client_id, pet_type)
SELECT fixture.id, source.client_id, source.pet_type
FROM (VALUES
  ('22222222-2222-2222-2222-22222222000d'::uuid),
  ('22222222-2222-2222-2222-22222222000e'::uuid),
  ('22222222-2222-2222-2222-22222222000f'::uuid),
  ('22222222-2222-2222-2222-222222220005'::uuid),
  ('22222222-2222-2222-2222-222222220006'::uuid),
  ('22222222-2222-2222-2222-222222220007'::uuid),
  ('22222222-2222-2222-2222-222222220008'::uuid),
  ('22222222-2222-2222-2222-222222220009'::uuid)
) AS fixture(id)
CROSS JOIN public.pets source
WHERE source.id='22222222-2222-2222-2222-22222222000a';
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'shipping', 'Testowa 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-4444-4444-4444-444444444444', 'modelb-sweep-prod', 'Sweep Prod', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'SWP-SKU-1', 'Swp SKU 1', 'dog', 400, 350, 'active');
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('66666666-6666-6666-6666-666666666666', 'swp-loc', 'Sweep Loc', 'virtual', 'active', true);

-- helper: build a provisional + linked subscription_cycle order
-- (returns subscription_id / cycle_id via a temp table per scenario)

-- ===== Scenario A — stuck (old) provisional, unpaid order =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"SWP-SKU-1"}'::jsonb);
CREATE TEMP TABLE _a AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-22222222000a','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle',
       subscription_id=(SELECT sub_id FROM _a), subscription_cycle_id=(SELECT cyc_id FROM _a)
 WHERE id='a0000000-0000-0000-0000-00000000000a';
CREATE TEMP TABLE _ai AS
SELECT (public.commerce_payment_control_create_intent(
  'sweep-a-intent-0001','subscription_cycle','a0000000-0000-0000-0000-00000000000a',
  (SELECT sub_id FROM _a),(SELECT cyc_id FROM _a),2680,'PLN','{}'::jsonb) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-00000000000a','sweep-a-resv','a0000000-0000-0000-0000-00000000000a',
        '55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666',36,'reserved','checkout_payment_window');
UPDATE public.subscriptions SET created_at='2020-06-01T00:00:00Z' WHERE id=(SELECT sub_id FROM _a);

-- ===== Scenario B — recent provisional (inside window), unpaid =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"SWP-SKU-1"}'::jsonb);
CREATE TEMP TABLE _b AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-22222222000b','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle',
       subscription_id=(SELECT sub_id FROM _b), subscription_cycle_id=(SELECT cyc_id FROM _b)
 WHERE id='a0000000-0000-0000-0000-00000000000b';
-- created_at left at now() (2026) — outside the 2021 cutoff.

-- ===== Scenario C — old provisional but order PAID (awaiting_mandate) =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
VALUES ('a0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000c', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"SWP-SKU-1"}'::jsonb);
CREATE TEMP TABLE _c AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-22222222000c','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle', status='paid',
       subscription_id=(SELECT sub_id FROM _c), subscription_cycle_id=(SELECT cyc_id FROM _c)
 WHERE id='a0000000-0000-0000-0000-00000000000c';
UPDATE public.subscriptions SET created_at='2020-06-01T00:00:00Z' WHERE id=(SELECT sub_id FROM _c);

-- ===== Scenario D — old provisional, settled money, order still pending =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
SELECT 'a0000000-0000-0000-0000-00000000000d', client_id, currency, region_code,
       size_constraint, 'draft', total_cents, subtotal_cents
  FROM public.commerce_orders
 WHERE id='a0000000-0000-0000-0000-00000000000a';
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-00000000000d', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"SWP-SKU-1"}'::jsonb);
CREATE TEMP TABLE _d AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-00000000000d','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-22222222000d','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle',
       subscription_id=(SELECT sub_id FROM _d), subscription_cycle_id=(SELECT cyc_id FROM _d)
 WHERE id='a0000000-0000-0000-0000-00000000000d';
CREATE TEMP TABLE _di AS
SELECT (public.commerce_payment_control_create_intent(
  'sweep-d-intent-0001','subscription_cycle','a0000000-0000-0000-0000-00000000000d',
  (SELECT sub_id FROM _d),(SELECT cyc_id FROM _d),2680,
  (SELECT currency FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-00000000000d'),
  '{}'::jsonb) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
UPDATE public.commerce_payment_intents
   SET status='succeeded'
 WHERE id=(SELECT intent_id FROM _di);
UPDATE public.commerce_payments
   SET status='succeeded'
 WHERE id=(SELECT payment_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _di));
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-00000000000d','sweep-d-resv','a0000000-0000-0000-0000-00000000000d',
        '55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666',36,'reserved','checkout_payment_window');
UPDATE public.subscriptions SET created_at='2020-06-01T00:00:00Z' WHERE id=(SELECT sub_id FROM _d);

-- ===== Scenario E — old provisional, provider result unresolved =====
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents)
SELECT 'a0000000-0000-0000-0000-00000000000e', client_id, currency, region_code,
       size_constraint, 'draft', total_cents, subtotal_cents
  FROM public.commerce_orders
 WHERE id='a0000000-0000-0000-0000-00000000000a';
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('a1000000-0000-0000-0000-00000000000e', 'a0000000-0000-0000-0000-00000000000e', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"SWP-SKU-1"}'::jsonb);
CREATE TEMP TABLE _e AS
SELECT (r->>'subscriptionId')::uuid AS sub_id, (r->>'subscriptionCycleId')::uuid AS cyc_id
FROM (SELECT public.subscription_create_provisional_for_checkout(
  'a0000000-0000-0000-0000-00000000000e','11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-22222222000e','33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb) AS r) s;
UPDATE public.commerce_orders SET mode='subscription_cycle',
       subscription_id=(SELECT sub_id FROM _e), subscription_cycle_id=(SELECT cyc_id FROM _e)
 WHERE id='a0000000-0000-0000-0000-00000000000e';
CREATE TEMP TABLE _ei AS
SELECT (public.commerce_payment_control_create_intent(
  'sweep-e-intent-0001','subscription_cycle','a0000000-0000-0000-0000-00000000000e',
  (SELECT sub_id FROM _e),(SELECT cyc_id FROM _e),2680,
  (SELECT currency FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-00000000000e'),
  '{}'::jsonb) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
SELECT public.commerce_payment_control_record_attempt(
  'sweep-e-attempt-0001',(SELECT intent_id FROM _ei),'stripe','pa_e','ps_e','processing',NULL,'{}'::jsonb,'{}'::jsonb);
INSERT INTO public.commerce_payment_attempts (
  payment_intent_id, payment_id, provider, provider_attempt_id,
  idempotency_key, status, amount_cents, currency
)
SELECT intent.id, intent.payment_id, 'stripe', 'pa_e_created',
       'sweep-e-attempt-created', 'created', intent.amount_cents, intent.currency
  FROM public.commerce_payment_intents intent
 WHERE intent.id=(SELECT intent_id FROM _ei);
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-00000000000e','sweep-e-resv','a0000000-0000-0000-0000-00000000000e',
        '55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666',36,'reserved','checkout_payment_window');
UPDATE public.subscriptions SET created_at='2020-06-01T00:00:00Z' WHERE id=(SELECT sub_id FROM _e);

-- ===== Scenarios F/5/6/7/8/9 — exact admission boundary ====================
-- F is proven blocked before a provider call and remains sweepable. The other
-- fixtures carry missing proof or a provider-reachable status and fail closed.
CREATE TEMP TABLE _boundary_fixtures (
  suffix text PRIMARY KEY,
  attempt_status text NOT NULL,
  order_id uuid NOT NULL,
  sub_id uuid,
  cyc_id uuid,
  intent_id uuid
);
INSERT INTO _boundary_fixtures (suffix, attempt_status, order_id) VALUES
  ('f', 'blocked_preflight', 'a0000000-0000-0000-0000-00000000000f'),
  ('5', 'blocked_preflight', 'a0000000-0000-0000-0000-000000000005'),
  ('6', 'failed',            'a0000000-0000-0000-0000-000000000006'),
  ('7', 'cancelled',         'a0000000-0000-0000-0000-000000000007'),
  ('8', 'expired',           'a0000000-0000-0000-0000-000000000008'),
  ('9', 'created',           'a0000000-0000-0000-0000-000000000009');

DO $fixture$
DECLARE
  v_fixture record;
  v_created jsonb;
  v_intent_id uuid;
BEGIN
  FOR v_fixture IN SELECT * FROM _boundary_fixtures ORDER BY suffix LOOP
    INSERT INTO public.commerce_orders (
      id, client_id, currency, region_code, size_constraint, status,
      total_cents, subtotal_cents
    )
    SELECT v_fixture.order_id, client_id, currency, region_code, size_constraint,
           'draft', total_cents, subtotal_cents
      FROM public.commerce_orders
     WHERE id='a0000000-0000-0000-0000-00000000000a';

    INSERT INTO public.commerce_order_items (
      id, order_id, sku_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      product_snapshot
    )
    SELECT ('a1000000-0000-0000-0000-00000000000' || v_fixture.suffix)::uuid,
           v_fixture.order_id, sku_id, quantity, unit_price_cents, total_cents,
           discount_allocated_cents, effective_total_cents, effective_net_cents,
           product_snapshot
      FROM public.commerce_order_items
     WHERE order_id='a0000000-0000-0000-0000-00000000000a';

    v_created := public.subscription_create_provisional_for_checkout(
      v_fixture.order_id,
      '11111111-1111-1111-1111-111111111111',
      ('22222222-2222-2222-2222-22222222000' || v_fixture.suffix)::uuid,
      '33333333-3333-3333-3333-333333333333',
      '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb
    );
    UPDATE _boundary_fixtures
       SET sub_id=(v_created->>'subscriptionId')::uuid,
           cyc_id=(v_created->>'subscriptionCycleId')::uuid
     WHERE suffix=v_fixture.suffix;
    UPDATE public.commerce_orders
       SET mode='subscription_cycle',
           subscription_id=(v_created->>'subscriptionId')::uuid,
           subscription_cycle_id=(v_created->>'subscriptionCycleId')::uuid
     WHERE id=v_fixture.order_id;

    v_intent_id := (public.commerce_payment_control_create_intent(
      'sweep-boundary-intent-' || v_fixture.suffix,
      'subscription_cycle', v_fixture.order_id,
      (v_created->>'subscriptionId')::uuid,
      (v_created->>'subscriptionCycleId')::uuid,
      2680,
      (SELECT currency FROM public.commerce_orders WHERE id=v_fixture.order_id),
      '{}'::jsonb
    ) -> 'paymentIntent' ->> 'id')::uuid;
    UPDATE _boundary_fixtures SET intent_id=v_intent_id
     WHERE suffix=v_fixture.suffix;

    INSERT INTO public.commerce_payment_attempts (
      payment_intent_id, payment_id, provider, provider_attempt_id,
      idempotency_key, status, amount_cents, currency, response_payload
    )
    SELECT v_intent_id, intent.payment_id, 'stripe',
           CASE WHEN v_fixture.attempt_status='blocked_preflight'
             THEN NULL ELSE 'pa_boundary_' || v_fixture.suffix END,
           'sweep-boundary-attempt-' || v_fixture.suffix,
           v_fixture.attempt_status, intent.amount_cents, intent.currency,
           CASE WHEN v_fixture.attempt_status='blocked_preflight'
             THEN '{"providerCall":false}'::jsonb ELSE '{}'::jsonb END
      FROM public.commerce_payment_intents intent
     WHERE intent.id=v_intent_id;

    UPDATE public.subscriptions SET created_at='2020-06-01T00:00:00Z'
     WHERE id=(v_created->>'subscriptionId')::uuid;
  END LOOP;
END;
$fixture$;

-- Schema permits legacy/malformed blocked_preflight rows with no providerCall
-- key. Missing proof is not proof of no provider call and must fail closed.
UPDATE public.commerce_payment_attempts
   SET response_payload='{}'::jsonb
 WHERE payment_intent_id=(
   SELECT intent_id FROM _boundary_fixtures WHERE suffix='5'
 );

CREATE FUNCTION pg_temp.sweep_aggregate_state(p_order_id uuid, p_subscription_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'subscription', (SELECT to_jsonb(s) FROM public.subscriptions s WHERE s.id=p_subscription_id),
    'order', (SELECT to_jsonb(o) FROM public.commerce_orders o WHERE o.id=p_order_id),
    'cycles', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) FROM public.subscription_cycles c WHERE c.subscription_id=p_subscription_id),
    'intents', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb) FROM public.commerce_payment_intents i WHERE i.order_id=p_order_id),
    'attempts', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb) FROM public.commerce_payment_attempts a JOIN public.commerce_payment_intents i ON i.id=a.payment_intent_id WHERE i.order_id=p_order_id),
    'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb) FROM public.commerce_payments p WHERE p.order_id=p_order_id),
    'reservations', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM public.inventory_reservations r WHERE r.order_id=p_order_id),
    'subscriptionEvents', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb) FROM public.subscription_events e WHERE e.subscription_id=p_subscription_id),
    'outbox', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb) FROM public.outbox_events e WHERE (e.aggregate_type='commerce_order' AND e.aggregate_id=p_order_id) OR (e.aggregate_type='subscription' AND e.aggregate_id=p_subscription_id)),
    'recoveryTokens', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM public.commerce_checkout_recovery_tokens t WHERE t.order_id=p_order_id)
  );
$$;

-- A refused oldest page must not hide later safe candidates on every run.
-- Savepoint keeps the original admission and recovery assertions below intact.
SAVEPOINT candidate_progress;
UPDATE public.subscriptions SET created_at='1990-01-01T00:00:00Z'
 WHERE client_id='11111111-1111-1111-1111-111111111111'
   AND id NOT IN (
     (SELECT sub_id FROM _a), (SELECT sub_id FROM _b),
     (SELECT sub_id FROM _boundary_fixtures WHERE suffix='f')
   );
UPDATE public.subscriptions SET created_at='2000-01-01T00:00:00Z'
 WHERE id=(SELECT sub_id FROM _a);
UPDATE public.subscriptions SET created_at='2001-01-01T00:00:00Z'
 WHERE id=(SELECT sub_id FROM _boundary_fixtures WHERE suffix='f');
CREATE TEMP TABLE _progress_refused_before AS
SELECT checkout_order.id AS order_id, subscription.id AS subscription_id,
       pg_temp.sweep_aggregate_state(checkout_order.id, subscription.id) AS state
  FROM public.subscriptions subscription
  JOIN public.commerce_orders checkout_order ON checkout_order.subscription_id=subscription.id
 WHERE subscription.client_id='11111111-1111-1111-1111-111111111111'
   AND subscription.created_at='1990-01-01T00:00:00Z';
CREATE TEMP TABLE _progress_first AS
SELECT public.subscription_sweep_unpaid_provisional(
  'sweep-progress-first', '2002-01-01T00:00:00Z', 1) AS result;
SELECT is((SELECT result #>> '{sweep,count}' FROM _progress_first), '1',
  'limited first run passes older refused rows and sweeps one safe provisional');
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT sub_id FROM _a)),
  'cancelled', 'limited first run reaches the younger zero-attempt provisional');
SELECT is((SELECT status FROM public.subscriptions
  WHERE id=(SELECT sub_id FROM _boundary_fixtures WHERE suffix='f')),
  'pending_activation', 'limit one leaves the second safe candidate for the next run');
CREATE TEMP TABLE _progress_second AS
SELECT public.subscription_sweep_unpaid_provisional(
  'sweep-progress-second', '2002-01-01T00:00:00Z', 1) AS result;
SELECT is((SELECT result #>> '{sweep,count}' FROM _progress_second), '1',
  'limited second run progresses despite the same older refused rows');
SELECT is((SELECT status FROM public.subscriptions
  WHERE id=(SELECT sub_id FROM _boundary_fixtures WHERE suffix='f')),
  'cancelled', 'limited second run reaches proven pre-provider abandonment');
SELECT is(public.subscription_sweep_unpaid_provisional(
  'sweep-progress-empty', '2002-01-01T00:00:00Z', 1) #>> '{sweep,count}', '0',
  'repeated run has no safe candidate left');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM _progress_refused_before before_state
   WHERE pg_temp.sweep_aggregate_state(before_state.order_id, before_state.subscription_id)
     IS DISTINCT FROM before_state.state
), 'all older refused aggregates remain byte-for-byte unchanged across limited runs');
SELECT is((SELECT count(*)::int FROM public.outbox_events
  WHERE event_type='commerce.checkout.expired'
    AND aggregate_id IN ('a0000000-0000-0000-0000-00000000000a',
                         'a0000000-0000-0000-0000-00000000000f')), 2,
  'limited repeated runs emit exactly one recovery event per swept order');
SELECT is((SELECT count(*)::int FROM public.commerce_checkout_recovery_tokens
  WHERE order_id IN ('a0000000-0000-0000-0000-00000000000a',
                    'a0000000-0000-0000-0000-00000000000f')), 2,
  'limited repeated runs mint exactly one recovery token per swept order');
ROLLBACK TO SAVEPOINT candidate_progress;

CREATE TEMP TABLE _d_before AS
SELECT pg_temp.sweep_aggregate_state('a0000000-0000-0000-0000-00000000000d', (SELECT sub_id FROM _d)) AS state;
CREATE TEMP TABLE _e_before AS
SELECT pg_temp.sweep_aggregate_state('a0000000-0000-0000-0000-00000000000e', (SELECT sub_id FROM _e)) AS state;
CREATE TEMP TABLE _provider_reachable_before AS
SELECT fixture.suffix,
       pg_temp.sweep_aggregate_state(fixture.order_id, fixture.sub_id) AS state
  FROM _boundary_fixtures fixture
 WHERE fixture.suffix <> 'f';

-- ---- Run: A/F are abandoned; every provider-reachable shape is skipped -----
CREATE TEMP TABLE _res AS
SELECT (public.subscription_sweep_unpaid_provisional(
  'subscription-sweep-test', '2021-01-01T00:00:00Z'::timestamptz, 50) #>> '{sweep,count}') AS swept_count;

-- ---- Assertions -----------------------------------------------------------
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT sub_id FROM _a)),
  'cancelled', 'A: stuck provisional swept to cancelled');
SELECT is((SELECT status FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-00000000000a'),
  'cancelled', 'A: abandoned order cancelled');
SELECT is((SELECT status FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _ai)),
  'cancelled', 'A: intent terminalized (closes late-success race)');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='a2e50000-0000-0000-0000-00000000000a'),
  'released', 'A: checkout inventory hold released');
SELECT is((SELECT status FROM public.subscription_cycles WHERE id=(SELECT cyc_id FROM _a)),
  'cancelled', 'A: provisional cycle cancelled');
SELECT is((SELECT count(*)::int FROM public.subscription_events
            WHERE subscription_id=(SELECT sub_id FROM _a) AND event_type='subscription.activation_abandoned'),
  1, 'A: activation_abandoned event emitted');

SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT sub_id FROM _b)),
  'pending_activation', 'B: recent provisional untouched (inside window)');
SELECT is((SELECT status FROM public.subscriptions WHERE id=(SELECT sub_id FROM _c)),
  'pending_activation', 'C: paid provisional never swept (money taken)');
SELECT is((SELECT swept_count FROM _res), '2',
  'sweep count = 2 (zero-attempt plus proven blocked_preflight)');
SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id=(SELECT sub_id FROM _boundary_fixtures WHERE suffix='f')),
  'cancelled', 'F: proven pre-provider blocked attempt is swept');
SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id=(SELECT order_id FROM _boundary_fixtures WHERE suffix='f')),
  'cancelled', 'F: proven pre-provider order is cancelled');

SELECT is(
  pg_temp.sweep_aggregate_state('a0000000-0000-0000-0000-00000000000d', (SELECT sub_id FROM _d)),
  (SELECT state FROM _d_before),
  'D: settled money leaves the complete aggregate byte-for-byte unchanged');
SELECT is(
  pg_temp.sweep_aggregate_state('a0000000-0000-0000-0000-00000000000e', (SELECT sub_id FROM _e)),
  (SELECT state FROM _e_before),
  'E: processing/created provider work leaves the complete aggregate byte-for-byte unchanged');
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM _boundary_fixtures fixture
      JOIN _provider_reachable_before before_state USING (suffix)
     WHERE fixture.suffix <> 'f'
       AND pg_temp.sweep_aggregate_state(fixture.order_id, fixture.sub_id)
           IS DISTINCT FROM before_state.state
  ),
  'missing preflight proof and failed/cancelled/expired/created attempts leave every aggregate unchanged');
SELECT ok(
  (SELECT response_payload->>'providerCall' IS NULL
     FROM public.commerce_payment_attempts
    WHERE payment_intent_id=(
      SELECT intent_id FROM _boundary_fixtures WHERE suffix='5'
    )),
  'malformed blocked_preflight fixture really lacks providerCall proof');

-- ---- 20260903090000: the buyer is told, and the telling is provable ---------
-- The sweep gained three writes and none had a database-level proof: the
-- cancellation is now attributed, one honest `commerce.checkout.expired` message
-- is emitted, and it carries a 30-day recovery token. The negative case matters
-- most: a PAID provisional must receive NO such message, because the email says
-- outright that nothing was charged.
SELECT is((SELECT cancellation_source FROM public.subscriptions WHERE id=(SELECT sub_id FROM _a)),
  'system_provisional_activation_timeout',
  'A: the cancellation is attributed to the sweep, not left NULL');

SELECT is((SELECT count(*)::int FROM public.outbox_events
            WHERE event_type='commerce.checkout.expired'
              AND idempotency_key='checkout_expired:a0000000-0000-0000-0000-00000000000a'
              AND metadata->>'source'='subscription_sweep_unpaid_provisional'),
  1, 'A: exactly one checkout.expired message is emitted for the abandoned order');

SELECT is((SELECT count(*)::int FROM public.commerce_checkout_recovery_tokens
            WHERE order_id='a0000000-0000-0000-0000-00000000000a'),
  1, 'A: the message carries exactly one recovery token');

-- ⛔ The negative half. The paid provisional (C) is never swept, so it must not
-- receive a message asserting that no money was taken.
SELECT is((SELECT count(*)::int FROM public.outbox_events
            WHERE event_type='commerce.checkout.expired'
              AND idempotency_key='checkout_expired:a0000000-0000-0000-0000-00000000000c'),
  0, 'C: a paid provisional is never told that nothing was charged');

-- ---- Direct signed evidence can precede attempt linkage/result application --
-- Reuse recent scenario B after proving the age cutoff. This is the exact
-- event shape that only references the intent while its attempt id is absent.
CREATE TEMP TABLE _bi AS
SELECT (public.commerce_payment_control_create_intent(
  'sweep-b-intent-0001','subscription_cycle','a0000000-0000-0000-0000-00000000000b',
  (SELECT sub_id FROM _b),(SELECT cyc_id FROM _b),2680,
  (SELECT currency FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-00000000000b'),
  '{}'::jsonb) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;
SELECT public.commerce_payment_control_ingest_event(
  'stripe','evt_sweep_b_success','payment.succeeded','pa_b',
  (SELECT intent_id FROM _bi),
  NULL,
  2680,(SELECT currency FROM public.commerce_orders WHERE id='a0000000-0000-0000-0000-00000000000b'),
  true,'{}'::jsonb);
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind)
VALUES ('a2e50000-0000-0000-0000-00000000000b','sweep-b-resv','a0000000-0000-0000-0000-00000000000b',
        '55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666',36,'reserved','checkout_payment_window');
UPDATE public.subscriptions SET created_at='2020-06-01T00:00:00Z' WHERE id=(SELECT sub_id FROM _b);
CREATE TEMP TABLE _b_observed_before AS
SELECT pg_temp.sweep_aggregate_state('a0000000-0000-0000-0000-00000000000b', (SELECT sub_id FROM _b)) AS state;
CREATE TEMP TABLE _observed_res AS
SELECT (public.subscription_sweep_unpaid_provisional(
  'subscription-sweep-observed-success', '2021-01-01T00:00:00Z'::timestamptz, 50) #>> '{sweep,count}') AS swept_count;

SELECT is((SELECT swept_count FROM _observed_res), '0',
  'B2: intent-linked signed success without an attempt is not abandonment');
SELECT is(
  pg_temp.sweep_aggregate_state('a0000000-0000-0000-0000-00000000000b', (SELECT sub_id FROM _b)),
  (SELECT state FROM _b_observed_before),
  'B2: null-attempt observed success leaves the aggregate byte-for-byte unchanged');

-- A candidate without an order still follows the existing abandonment path;
-- an older active subscription must never enter that path.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code,
  status, started_at, next_cycle_at, created_at
)
SELECT fixture.id, source.client_id, source.cadence_days, source.currency,
       source.region_code, fixture.status, source.started_at,
       source.next_cycle_at, '1990-01-01T00:00:00Z'::timestamptz
  FROM public.subscriptions source
 CROSS JOIN (VALUES
   ('a7000000-0000-4000-8000-000000000001'::uuid, 'pending_activation'),
   ('a7000000-0000-4000-8000-000000000002'::uuid, 'active')
 ) fixture(id, status)
 WHERE source.id=(SELECT sub_id FROM _a);
CREATE TEMP TABLE _active_before AS
SELECT to_jsonb(subscription) AS state FROM public.subscriptions subscription
 WHERE id='a7000000-0000-4000-8000-000000000002';
SELECT is(public.subscription_sweep_unpaid_provisional(
  'sweep-without-order', '2021-01-01T00:00:00Z', 1) #>> '{sweep,count}', '1',
  'a no-order provisional remains eligible for one limited sweep');
SELECT is((SELECT status FROM public.subscriptions
  WHERE id='a7000000-0000-4000-8000-000000000001'), 'cancelled',
  'the no-order provisional completes the unchanged cancellation path');
SELECT is((SELECT to_jsonb(subscription) FROM public.subscriptions subscription
  WHERE id='a7000000-0000-4000-8000-000000000002'),
  (SELECT state FROM _active_before),
  'an active subscription remains byte-for-byte unchanged');

SELECT * FROM finish();
ROLLBACK;
