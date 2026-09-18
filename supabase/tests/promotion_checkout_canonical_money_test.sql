-- pgTAP: v2 promotion claims are part of the canonical order/payment transaction.
BEGIN;
SELECT plan(54);

CREATE TEMP TABLE _promotion_checkout_bootstrap (ready boolean);

CREATE OR REPLACE FUNCTION pg_temp.promotion_quote(
  p_code text,
  p_promotion_id uuid,
  p_revision integer,
  p_amount_off integer,
  p_definition_fingerprint text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'quote', jsonb_build_object(
      'context', jsonb_build_object('mode', 'one_time'),
      'discounts', CASE WHEN p_code IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(
        jsonb_build_object(
          'promotionId', p_promotion_id,
          'code', p_code,
          'label', 'Promotion test',
          'appliesTo', 'order_total',
          'amountOffMinor', p_amount_off,
          'reasonCode', 'promotion_code_v2',
          'promotionEngineVersion', 'promotion-engine.v2',
          'promotionCodeRevision', p_revision,
          'promotionDefinitionFingerprint', coalesce(
            p_definition_fingerprint,
            private.commerce_promotion_definition_fingerprint(
              (SELECT id FROM public.promotion_codes
                WHERE code_normalized = upper(btrim(p_code))),
              p_promotion_id
            )
          ),
          'floorApplied', false
        )
      ) END
    )
  )
$$;

CREATE OR REPLACE FUNCTION pg_temp.promotion_order_snapshot(
  p_sku text,
  p_discount integer
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'source', 'commerce.order_draft.bff.v0',
    'status', 'draft',
    'paymentStatus', 'not_started',
    'currency', 'PLN',
    'taxIncluded', true,
    'lines', jsonb_build_array(jsonb_build_object(
      'sku', p_sku,
      'productSlug', 'promotion-test',
      'quantity', 1,
      'unitPriceGross', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN'),
      'lineSubtotalGross', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN'),
      'tax', jsonb_build_object(
        'vatRateBps', 800,
        'netAmount', jsonb_build_object('amountMinor', 9259, 'currency', 'PLN'),
        'vatAmount', jsonb_build_object('amountMinor', 741, 'currency', 'PLN'),
        'grossAmount', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN')
      )
    )),
    'totals', jsonb_build_object(
      'subtotalGross', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN'),
      'discountTotalGross', jsonb_build_object('amountMinor', p_discount, 'currency', 'PLN'),
      'netTotal', jsonb_build_object(
        'amountMinor', round((10000 - p_discount)::numeric * 10000 / 10800)::integer,
        'currency', 'PLN'
      ),
      'taxTotal', jsonb_build_object(
        'amountMinor', (10000 - p_discount)
          - round((10000 - p_discount)::numeric * 10000 / 10800)::integer,
        'currency', 'PLN'
      ),
      'totalGross', jsonb_build_object('amountMinor', 10000 - p_discount, 'currency', 'PLN')
    )
  )
$$;

CREATE OR REPLACE FUNCTION pg_temp.create_promotion_order(
  p_idempotency_key text,
  p_client_id uuid,
  p_code text,
  p_promotion_id uuid,
  p_revision integer,
  p_discount integer,
  p_definition_fingerprint text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.commerce_create_order_draft_with_outbox(
    p_idempotency_key,
    pg_temp.promotion_quote(
      p_code, p_promotion_id, p_revision, p_discount, p_definition_fingerprint
    ),
    pg_temp.promotion_order_snapshot(p_idempotency_key, p_discount),
    p_client_id
  )
$$;

INSERT INTO public.clients (id, email) VALUES
  ('a1410000-0000-4000-8000-000000000001', 'promotion-checkout-a@example.invalid'),
  ('a1410000-0000-4000-8000-000000000002', 'promotion-checkout-b@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type) VALUES
  ('a1440000-0000-4000-8000-000000000001', 'a1410000-0000-4000-8000-000000000002', 'dog');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code) VALUES
  ('a1450000-0000-4000-8000-000000000001', 'a1410000-0000-4000-8000-000000000002',
   'shipping', 'Promotion 1', 'Warszawa', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('a1460000-0000-4000-8000-000000000001', 'promotion-compensation',
   'Promotion compensation', 'active');
INSERT INTO public.catalog_skus (
  id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status
) VALUES (
  'a1470000-0000-4000-8000-000000000001', 'a1460000-0000-4000-8000-000000000001',
  'PROMO-COMP-1', 'Promotion compensation', 'dog', 400, 350, 'active'
);
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable) VALUES
  ('a1480000-0000-4000-8000-000000000001', 'promotion-compensation',
   'Promotion compensation', 'virtual', 'active', true);

INSERT INTO public.promotions (
  id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, stacking_rule, status, promotion_engine_version,
  benefit_lane, benefit_kind, benefit_value_bps
) VALUES
  ('a1420000-0000-4000-8000-000000000001', 'V2:A142:LIFECYCLE', 'Lifecycle 80',
   'coupon_code', 'percentage', 80, 'order_total', 'exclusive', 'draft',
   'promotion-engine.v2', 'product', 'target_percentage', 8000),
  ('a1420000-0000-4000-8000-000000000002', 'V2:A142:CAP', 'Cap 80',
   'coupon_code', 'percentage', 80, 'order_total', 'exclusive', 'draft',
   'promotion-engine.v2', 'product', 'target_percentage', 8000);

INSERT INTO public.promotions (
  id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, stacking_rule, status, promotion_engine_version,
  benefit_lane, benefit_kind, benefit_value_bps
) VALUES
  ('a1420000-0000-4000-8000-000000000003', 'V2:A142:DETAILS', 'Details 80',
   'coupon_code', 'percentage', 80, 'order_total', 'exclusive', 'draft',
   'promotion-engine.v2', 'product', 'target_percentage', 8000);

-- The legacy insert trigger projects this identity to promotion_codes. Its
-- cart-mode applicability is therefore the source of truth for v2's detail-only read;
-- v2 must never manufacture a candidate or alter the v1 money path.
INSERT INTO public.promotions (
  id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, applies_to_payload, stacking_rule, eligibility, status, promotion_engine_version,
  benefit_lane, benefit_kind, benefit_value_bps
) VALUES
  ('a1420000-0000-4000-8000-000000000004', '60VIP', 'Legacy 60 VIP',
   'coupon_code', 'percentage', 60, 'order_total', '{"cart_mode":"one_time"}'::jsonb, 'exclusive',
   '{}'::jsonb, 'active', 'promotion-engine.v1',
   'product', 'percentage', 6000);

INSERT INTO public.promotion_codes (
  id, code, name, scopes, valid_from, valid_to, status, revision,
  redemption_limit_global, redemption_limit_per_customer
) VALUES
  ('a1430000-0000-4000-8000-000000000001', 'LIFECYCLE80', 'Lifecycle 80',
   ARRAY['one_time','subscription_initial'], now() - interval '1 hour',
   now() + interval '1 day', 'active', 3, 20, 20),
  ('a1430000-0000-4000-8000-000000000002', 'CAPACITY80', 'Capacity 80',
   ARRAY['one_time','subscription_initial'], now() - interval '1 hour',
   now() + interval '1 day', 'active', 1, 1, 1);

INSERT INTO public.promotion_codes (
  id, code, name, scopes, valid_from, valid_to, status, revision,
  minimum_reference_minor, redemption_limit_global
) VALUES
  ('a1430000-0000-4000-8000-000000000003', 'SCOPEONLY80', 'Scope only 80',
   ARRAY['one_time'], now() - interval '1 hour', now() + interval '1 day', 'active', 1, 0, NULL),
  ('a1430000-0000-4000-8000-000000000004', 'MINIMUM80', 'Minimum 80',
   ARRAY['one_time','subscription_initial'], now() - interval '1 hour', now() + interval '1 day', 'active', 1, 12000, NULL),
  ('a1430000-0000-4000-8000-000000000005', 'FUTURE80', 'Future 80',
   ARRAY['one_time','subscription_initial'], now() + interval '1 day', now() + interval '2 days', 'active', 1, 0, NULL);

INSERT INTO public.promotion_code_bindings (promotion_code_id, promotion_id, lane) VALUES
  ('a1430000-0000-4000-8000-000000000001', 'a1420000-0000-4000-8000-000000000001', 'product'),
  ('a1430000-0000-4000-8000-000000000002', 'a1420000-0000-4000-8000-000000000002', 'product'),
  ('a1430000-0000-4000-8000-000000000003', 'a1420000-0000-4000-8000-000000000003', 'product'),
  ('a1430000-0000-4000-8000-000000000004', 'a1420000-0000-4000-8000-000000000003', 'product'),
  ('a1430000-0000-4000-8000-000000000005', 'a1420000-0000-4000-8000-000000000003', 'product');

SELECT is(
  public.commerce_promotion_codes_quote_candidates(
    ARRAY['lifecycle80'], 'a1410000-0000-4000-8000-000000000001',
    'one_time', 10000, now()
  )#>>'{candidates,0,code}',
  'LIFECYCLE80',
  'advisory resolution is case-insensitive and returns canonical code identity');
SELECT is(
  public.commerce_promotion_codes_quote_candidates(
    ARRAY['LIFECYCLE80'], 'a1410000-0000-4000-8000-000000000001',
    'subscription_initial', 10000, now()
  )#>>'{candidates,0,codeRevision}',
  '3',
  'advisory resolution carries the definition revision claimed by checkout');
SELECT is(
  public.commerce_promotion_codes_quote_candidates(
    ARRAY['LIFECYCLE80'], NULL, 'one_time', 10000, now()
  )#>>'{candidates,0,code}',
  'LIFECYCLE80',
  'an anonymous new-customer quote treats per-customer usage as zero');
SELECT is(
  length(public.commerce_promotion_codes_quote_candidates(
    ARRAY['LIFECYCLE80'], NULL, 'one_time', 10000, now()
  )#>>'{candidates,0,definitionFingerprint}'),
  64,
  'advisory resolution binds the exact promotion definition fingerprint');

CREATE TEMP TABLE _lifecycle AS
SELECT pg_temp.create_promotion_order(
  'promo-lifecycle-order-a', 'a1410000-0000-4000-8000-000000000001',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _lifecycle_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id
  FROM _lifecycle;

SELECT is(
  (SELECT status FROM public.promotion_code_claims
    WHERE order_id = (SELECT order_id FROM _lifecycle_id)),
  'reserved',
  'canonical order creation reserves the code in the same transaction');
SELECT is(
  (SELECT ARRAY[subtotal_cents, discount_cents, total_cents]
     FROM public.commerce_orders WHERE id = (SELECT order_id FROM _lifecycle_id)),
  ARRAY[10000,8000,2000],
  'Canonical Order Money remains the only persisted product-money allocation');
SELECT is(
  (SELECT jsonb_build_object(
    'engine', metadata->>'promotionEngineVersion',
    'product', (metadata->>'promotionProductDiscountMinor')::integer,
    'shipping', (metadata->>'promotionShippingDiscountMinor')::integer
  ) FROM public.commerce_orders WHERE id = (SELECT order_id FROM _lifecycle_id)),
  '{"engine":"promotion-engine.v2","product":8000,"shipping":0}'::jsonb,
  'order metadata records engine and lane totals without recalculating money');
SELECT is(
  pg_temp.create_promotion_order(
    'promo-lifecycle-order-a', 'a1410000-0000-4000-8000-000000000001',
    'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
  )#>>'{orderDraft,replayed}',
  'true',
  'same-key callback retry replays the existing complete order');
SELECT is(
  (SELECT count(*)::integer FROM public.promotion_code_claims
    WHERE order_id = (SELECT order_id FROM _lifecycle_id)),
  1,
  'order retry cannot duplicate its promotion claim');

UPDATE public.promotion_code_claims
   SET reserved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
 WHERE order_id = (SELECT order_id FROM _lifecycle_id);
SELECT is(
  (SELECT status FROM public.promotion_code_claims
    WHERE order_id = (SELECT order_id FROM _lifecycle_id)),
  'reserved',
  'elapsed reservation time alone does not release capacity');

UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = (SELECT order_id FROM _lifecycle_id);
SELECT is(
  (SELECT status || ':' || release_reason FROM public.promotion_code_claims
    WHERE order_id = (SELECT order_id FROM _lifecycle_id)),
  'released:order_cancelled',
  'canonical cancellation releases the reservation');

UPDATE public.commerce_orders
   SET status = 'paid', metadata = metadata || '{"paidAt":"2026-07-14T12:34:56Z"}'::jsonb
 WHERE id = (SELECT order_id FROM _lifecycle_id);
SELECT is(
  (SELECT status || ':' || to_char(redeemed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
     FROM public.promotion_code_claims
    WHERE order_id = (SELECT order_id FROM _lifecycle_id)),
  'redeemed:2026-07-14T12:34:56Z',
  'late paid callback wins after a prior terminal release');
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = (SELECT order_id FROM _lifecycle_id);
SELECT is(
  (SELECT count(*)::integer FROM public.promotion_code_claims
    WHERE order_id = (SELECT order_id FROM _lifecycle_id)),
  1,
  'repeated paid callback is idempotent');
UPDATE public.commerce_orders SET status = 'refunded'
 WHERE id = (SELECT order_id FROM _lifecycle_id);
SELECT is(
  (SELECT jsonb_build_object(
    'claim', (SELECT status FROM public.promotion_code_claims WHERE order_id = o.id),
    'redemptions', (SELECT count(*) FROM public.promotion_redemptions WHERE order_id = o.id)
  ) FROM public.commerce_orders o WHERE id = (SELECT order_id FROM _lifecycle_id)),
  '{"claim":"redeemed","redemptions":1}'::jsonb,
  'refund does not restore the code or duplicate redemption history');

CREATE TEMP TABLE _failed AS
SELECT pg_temp.create_promotion_order(
  'promo-terminal-failed', 'a1410000-0000-4000-8000-000000000001',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
UPDATE public.commerce_orders SET status = 'failed'
 WHERE id = replace((SELECT result#>>'{orderDraft,orderId}' FROM _failed), 'order_', '')::uuid;
SELECT is(
  (SELECT status || ':' || release_reason FROM public.promotion_code_claims
    WHERE order_id = replace((SELECT result#>>'{orderDraft,orderId}' FROM _failed), 'order_', '')::uuid),
  'released:order_failed',
  'canonical definitive payment failure releases the code');
SELECT throws_ok(
  format(
    'SELECT public.commerce_promotion_code_claim(%L::uuid, %L::uuid, now() + interval ''1 hour'')',
    'a1430000-0000-4000-8000-000000000001',
    replace((SELECT result#>>'{orderDraft,orderId}' FROM _failed), 'order_', '')
  ),
  '40001', 'promotion_code_order_not_claimable',
  'a released claim cannot be re-reserved for a terminal order');

CREATE TEMP TABLE _expired AS
SELECT pg_temp.create_promotion_order(
  'promo-terminal-expired', 'a1410000-0000-4000-8000-000000000001',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
UPDATE public.commerce_orders SET status = 'expired'
 WHERE id = replace((SELECT result#>>'{orderDraft,orderId}' FROM _expired), 'order_', '')::uuid;
SELECT is(
  (SELECT status || ':' || release_reason FROM public.promotion_code_claims
    WHERE order_id = replace((SELECT result#>>'{orderDraft,orderId}' FROM _expired), 'order_', '')::uuid),
  'released:order_expired',
  'canonical order expiry releases the code');

SELECT throws_ok(
  $$SELECT pg_temp.create_promotion_order(
    'promo-stale-revision', 'a1410000-0000-4000-8000-000000000001',
    'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 2, 8000
  )$$,
  '40001', 'promotion_code_definition_changed',
  'a stale quote revision fails the atomic order write');
SELECT is(
  jsonb_build_object(
    'orders', (SELECT count(DISTINCT o.id)
      FROM public.commerce_orders o
      JOIN public.commerce_order_items i ON i.order_id = o.id
      WHERE i.product_snapshot->>'sku' = 'promo-stale-revision'),
    'items', (SELECT count(*) FROM public.commerce_order_items i
      WHERE i.product_snapshot->>'sku' = 'promo-stale-revision'),
    'outbox', (SELECT count(*) FROM public.outbox_events e
      WHERE e.aggregate_id IN (
        SELECT i.order_id FROM public.commerce_order_items i
        WHERE i.product_snapshot->>'sku' = 'promo-stale-revision'
      )),
    'idempotency', (SELECT count(*) FROM public.commerce_idempotency_keys k
      WHERE k.scope = 'commerce.order_draft.create'
        AND k.idempotency_key = 'promo-stale-revision')
  ),
  '{"orders":0,"items":0,"outbox":0,"idempotency":0}'::jsonb,
  'revision failure rolls back the complete canonical order graph');

CREATE TEMP TABLE _stale_definition AS
SELECT private.commerce_promotion_definition_fingerprint(
  'a1430000-0000-4000-8000-000000000001',
  'a1420000-0000-4000-8000-000000000001'
) AS fingerprint;
UPDATE public.promotions SET benefit_value_bps = 7500
 WHERE id = 'a1420000-0000-4000-8000-000000000001';
SELECT throws_ok(
  format(
    'SELECT pg_temp.create_promotion_order(%L, %L::uuid, %L, %L::uuid, %s, %s, %L)',
    'promo-stale-definition', 'a1410000-0000-4000-8000-000000000001',
    'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000,
    (SELECT fingerprint FROM _stale_definition)
  ),
  '40001', 'promotion_code_definition_changed',
  'a stale quote fingerprint fails even when the code revision was not bumped');
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key = 'promo-stale-definition'),
  0,
  'definition-fingerprint failure rolls back the canonical order graph');
UPDATE public.promotions SET benefit_value_bps = 8000
 WHERE id = 'a1420000-0000-4000-8000-000000000001';
UPDATE public.promotion_codes SET minimum_reference_minor = 11000
 WHERE id = 'a1430000-0000-4000-8000-000000000001';
SELECT throws_ok(
  format(
    'SELECT pg_temp.create_promotion_order(%L, %L::uuid, %L, %L::uuid, %s, %s, %L)',
    'promo-stale-code-semantics', 'a1410000-0000-4000-8000-000000000001',
    'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000,
    (SELECT fingerprint FROM _stale_definition)
  ),
  '40001', 'promotion_code_definition_changed',
  'direct code-semantics drift invalidates the fingerprint without a revision bump');
UPDATE public.promotion_codes SET minimum_reference_minor = 0
 WHERE id = 'a1430000-0000-4000-8000-000000000001';

CREATE TEMP TABLE _capacity_winner AS
SELECT pg_temp.create_promotion_order(
  'promo-capacity-winner', 'a1410000-0000-4000-8000-000000000001',
  'CAPACITY80', 'a1420000-0000-4000-8000-000000000002', 1, 8000
) AS result;
SELECT is(
  (SELECT count(*)::integer FROM public.promotion_code_claims
   WHERE promotion_code_id = 'a1430000-0000-4000-8000-000000000002'
     AND status IN ('reserved','redeemed')),
  1,
  'the final available use consumes exactly one capacity slot');
SELECT throws_ok(
  $$SELECT pg_temp.create_promotion_order(
    'promo-capacity-loser', 'a1410000-0000-4000-8000-000000000002',
    'CAPACITY80', 'a1420000-0000-4000-8000-000000000002', 1, 8000
  )$$,
  '40001', 'promotion_code_global_limit_reached',
  'capacity loss fails the atomic order write');
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key = 'promo-capacity-loser'),
  0,
  'capacity failure leaves no partial canonical idempotency graph');

SELECT throws_ok(
  $$SELECT pg_temp.create_promotion_order(
    'promo-code-missing', 'a1410000-0000-4000-8000-000000000002',
    'MISSING80', 'a1420000-0000-4000-8000-000000000001', 3, 8000,
    repeat('a', 64)
  )$$,
  '40001', 'promotion_code_definition_changed',
  'unresolvable explicit v2 discount fails closed');
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key = 'promo-code-missing'),
  0,
  'unknown-code failure leaves no partial canonical idempotency graph');

SELECT throws_ok(
  $$SELECT pg_temp.create_promotion_order(
    'promo-floor-breached', 'a1410000-0000-4000-8000-000000000002',
    'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 9950
  )$$,
  '22023', 'promotion_code_product_floor_breached',
  'explicit v2 evidence cannot persist a product payable below PLN 1');
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key = 'promo-floor-breached'),
  0,
  'product-floor failure rolls back the canonical order graph');

CREATE TEMP TABLE _unstarted AS
SELECT pg_temp.create_promotion_order(
  'promo-unstarted', 'a1410000-0000-4000-8000-000000000002',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _unstarted_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id
  FROM _unstarted;
UPDATE public.commerce_order_items
   SET sku_id = 'a1470000-0000-4000-8000-000000000001',
       product_snapshot = product_snapshot || '{"sku":"PROMO-COMP-1"}'::jsonb
 WHERE order_id = (SELECT order_id FROM _unstarted_id);
CREATE TEMP TABLE _unstarted_subscription AS
SELECT (result->>'subscriptionId')::uuid AS subscription_id,
       (result->>'subscriptionCycleId')::uuid AS cycle_id
  FROM (SELECT public.subscription_create_provisional_for_checkout(
    (SELECT order_id FROM _unstarted_id),
    'a1410000-0000-4000-8000-000000000002',
    'a1440000-0000-4000-8000-000000000001',
    'a1450000-0000-4000-8000-000000000001',
    '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb
  ) AS result) created;
UPDATE public.commerce_orders
   SET mode = 'subscription_cycle',
       subscription_id = (SELECT subscription_id FROM _unstarted_subscription),
       subscription_cycle_id = (SELECT cycle_id FROM _unstarted_subscription)
 WHERE id = (SELECT order_id FROM _unstarted_id);
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, released_at
) VALUES (
  'a1490000-0000-4000-8000-000000000001', 'promotion-released-history',
  (SELECT order_id FROM _unstarted_id), 'a1470000-0000-4000-8000-000000000001',
  'a1480000-0000-4000-8000-000000000001', 1, 'released',
  'checkout_payment_window', now()
);
INSERT INTO public.commerce_idempotency_keys (scope, idempotency_key, status)
VALUES ('commerce.configurator_intent.persist', 'promo-unstarted', 'completed');
SELECT ok(
  public.commerce_cancel_unstarted_promotion_order(
    'promo-unstarted',
    (SELECT order_id FROM _unstarted_id), 'checkout_orchestration_failed_before_runtime'
  ),
  'guarded compensation cancels an unstarted promotion order');
SELECT is(
  jsonb_build_object(
    'order', (SELECT status FROM public.commerce_orders WHERE id = (SELECT order_id FROM _unstarted_id)),
    'claim', (SELECT status FROM public.promotion_code_claims WHERE order_id = (SELECT order_id FROM _unstarted_id)),
    'subscription', (SELECT status FROM public.subscriptions WHERE id = (SELECT subscription_id FROM _unstarted_subscription)),
    'cycle', (SELECT status FROM public.subscription_cycles WHERE id = (SELECT cycle_id FROM _unstarted_subscription)),
    'releasedInventory', (SELECT status FROM public.inventory_reservations WHERE id = 'a1490000-0000-4000-8000-000000000001')
  ),
  '{"order":"cancelled","claim":"released","subscription":"cancelled","cycle":"cancelled","releasedInventory":"released"}'::jsonb,
  'compensation releases the claim, cleans provisional subscription state and accepts released inventory history');
SELECT is((SELECT count(*)::integer FROM public.commerce_idempotency_keys
  WHERE scope = 'commerce.order_draft.create' AND idempotency_key = 'promo-unstarted'), 0,
  'compensation deletes only the provisional order-draft idempotency key');
SELECT is((SELECT count(*)::integer FROM public.outbox_events
  WHERE aggregate_id = (SELECT order_id FROM _unstarted_id)
    AND event_type = 'commerce.order_draft.created'), 0,
  'compensation deletes only the provisional order-draft event');
SELECT is((SELECT count(*)::integer FROM public.commerce_idempotency_keys
  WHERE scope = 'commerce.configurator_intent.persist' AND idempotency_key = 'promo-unstarted'), 1,
  'compensation preserves configurator identity and journey reuse');

CREATE TEMP TABLE _payment_guard AS
SELECT pg_temp.create_promotion_order(
  'promo-payment-guard', 'a1410000-0000-4000-8000-000000000002',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _payment_guard_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id FROM _payment_guard;
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  'a1500000-0000-4000-8000-000000000001', (SELECT order_id FROM _payment_guard_id),
  'stripe', 'promotion-payment-guard', 'pending', 2000, 'PLN'
);
SELECT is(
  public.commerce_cancel_unstarted_promotion_order(
    'promo-payment-guard',
    (SELECT order_id FROM _payment_guard_id), 'must-not-cancel-payment'
  ), false,
  'payment truth blocks unstarted-order compensation');

CREATE TEMP TABLE _intent_guard AS
SELECT pg_temp.create_promotion_order(
  'promo-intent-guard', 'a1410000-0000-4000-8000-000000000002',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _intent_guard_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id FROM _intent_guard;
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  'a1500000-0000-4000-8000-000000000002', (SELECT order_id FROM _intent_guard_id),
  'stripe', 'promotion-intent-guard', 'pending', 2000, 'PLN'
);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency
) VALUES (
  'a1510000-0000-4000-8000-000000000001', 'one_time_order',
  (SELECT order_id FROM _intent_guard_id), 'a1500000-0000-4000-8000-000000000002',
  'created', 2000, 'PLN'
);
SELECT is(
  public.commerce_cancel_unstarted_promotion_order(
    'promo-intent-guard',
    (SELECT order_id FROM _intent_guard_id), 'must-not-cancel-intent'
  ), false,
  'a created payment intent blocks unstarted-order compensation');

CREATE TEMP TABLE _inventory_guard AS
SELECT pg_temp.create_promotion_order(
  'promo-inventory-guard', 'a1410000-0000-4000-8000-000000000002',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _inventory_guard_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id FROM _inventory_guard;
INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind
) VALUES (
  'a1490000-0000-4000-8000-000000000002', 'promotion-active-inventory',
  (SELECT order_id FROM _inventory_guard_id), 'a1470000-0000-4000-8000-000000000001',
  'a1480000-0000-4000-8000-000000000001', 1, 'reserved', 'checkout_payment_window'
);
SELECT is(
  public.commerce_cancel_unstarted_promotion_order(
    'promo-inventory-guard',
    (SELECT order_id FROM _inventory_guard_id), 'must-not-cancel-active-inventory'
  ), false,
  'an active inventory reservation blocks unstarted-order compensation');

UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = (SELECT order_id FROM _inventory_guard_id);
SELECT throws_ok(
  format(
    'INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind) VALUES (%L::uuid, %L, %L::uuid, %L::uuid, %L::uuid, 1, %L, %L)',
    'a1490000-0000-4000-8000-000000000003',
    'promotion-terminal-inventory',
    (SELECT order_id FROM _inventory_guard_id),
    'a1470000-0000-4000-8000-000000000001',
    'a1480000-0000-4000-8000-000000000001',
    'reserved',
    'checkout_payment_window'
  ),
  '40001', 'promotion_inventory_order_not_reservable',
  'a reservation cannot appear after a promotion order becomes terminal');

CREATE TEMP TABLE _sweep_stale AS
SELECT pg_temp.create_promotion_order(
  'promo-sweep-stale', 'a1410000-0000-4000-8000-000000000002',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _sweep_stale_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id
  FROM _sweep_stale;
UPDATE public.promotion_code_claims
   SET reserved_at = now() - interval '30 minutes',
       expires_at = now() - interval '10 minutes'
 WHERE order_id = (SELECT order_id FROM _sweep_stale_id);
SELECT is(
  public.commerce_sweep_stale_promotion_claims(now(), 50, 15, 5),
  '{"checked":1,"cancelled":1,"skipped":0}'::jsonb,
  'the bounded sweep cancels exactly one safely stale promotion order');
SELECT is(
  (SELECT jsonb_build_object(
    'order', o.status,
    'claim', (SELECT status FROM public.promotion_code_claims c WHERE c.order_id = o.id),
    'key', (SELECT count(*) FROM public.commerce_idempotency_keys k
      WHERE k.scope = 'commerce.order_draft.create' AND k.idempotency_key = 'promo-sweep-stale'),
    'draftEvent', (SELECT count(*) FROM public.outbox_events e
      WHERE e.aggregate_id = o.id AND e.event_type = 'commerce.order_draft.created')
  ) FROM public.commerce_orders o WHERE o.id = (SELECT order_id FROM _sweep_stale_id)),
  '{"order":"cancelled","claim":"released","key":0,"draftEvent":0}'::jsonb,
  'sweep cleanup releases capacity and only removes the provisional replay graph');

CREATE TEMP TABLE _sweep_grace AS
SELECT pg_temp.create_promotion_order(
  'promo-sweep-grace', 'a1410000-0000-4000-8000-000000000002',
  'LIFECYCLE80', 'a1420000-0000-4000-8000-000000000001', 3, 8000
) AS result;
CREATE TEMP TABLE _sweep_grace_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id
  FROM _sweep_grace;
UPDATE public.promotion_code_claims
   SET reserved_at = now() - interval '30 minutes',
       expires_at = now() - interval '2 minutes'
 WHERE order_id = (SELECT order_id FROM _sweep_grace_id);
SELECT is(
  public.commerce_sweep_stale_promotion_claims(now(), 50, 15, 5),
  '{"checked":0,"cancelled":0,"skipped":0}'::jsonb,
  'the grace window protects a recently expired claim from cleanup');

UPDATE public.promotion_code_claims
   SET reserved_at = now() - interval '30 minutes',
       expires_at = now() - interval '10 minutes'
 WHERE order_id = (SELECT order_id FROM _payment_guard_id);
SELECT is(
  public.commerce_sweep_stale_promotion_claims(now(), 50, 15, 5),
  '{"checked":1,"cancelled":0,"skipped":1}'::jsonb,
  'the sweep reports but never cancels stale capacity with payment truth');
SELECT is(
  (SELECT status || ':' || (
    SELECT status FROM public.promotion_code_claims c WHERE c.order_id = o.id
  ) FROM public.commerce_orders o WHERE o.id = (SELECT order_id FROM _payment_guard_id)),
  'draft:reserved',
  'a sweep skip preserves both the payable order and its capacity claim');

SELECT is(
  (SELECT enabled::text || ':' || active_driver
     FROM public.platform_job_controls
    WHERE job_name = 'promotion-claim-sweep'),
  'true:vercel_cron',
  'the sweep has an explicit scheduler control row independent from its default-off flag');

CREATE TEMP TABLE _legacy_unchanged AS
SELECT pg_temp.create_promotion_order(
  'promo-legacy-unchanged', 'a1410000-0000-4000-8000-000000000001',
  NULL, NULL, 1, 5000
) AS result;
SELECT is(
  (SELECT jsonb_build_object(
    'money', ARRAY[o.subtotal_cents, o.discount_cents, o.total_cents],
    'claims', (SELECT count(*) FROM public.promotion_code_claims c WHERE c.order_id = o.id)
  ) FROM public.commerce_orders o
   WHERE o.id = replace((SELECT result#>>'{orderDraft,orderId}' FROM _legacy_unchanged), 'order_', '')::uuid),
  '{"money":[10000,5000,5000],"claims":0}'::jsonb,
  'legacy/no-code canonical order money and checkout path remain unchanged');

SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['SCOPEONLY80', 'MINIMUM80', 'FUTURE80', 'CAPACITY80'], NULL,
    'subscription_initial', 10000, now()
  )->'codeRejections',
  '[{"code":"SCOPEONLY80","reason":"not_eligible"},{"code":"MINIMUM80","reason":"not_eligible"},{"code":"FUTURE80","reason":"not_eligible"},{"code":"CAPACITY80","reason":"not_eligible"}]'::jsonb,
  'v2 preserves the frozen legacy rejection reason for detailed rejections');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['SCOPEONLY80', 'MINIMUM80', 'FUTURE80', 'CAPACITY80'], NULL,
    'subscription_initial', 10000, now()
  )#>>'{codeRejectionDetails,0,reason}',
  'scope_not_applicable',
  'v2 exposes the safe scope detail separately from legacy rejections');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['SCOPEONLY80', 'MINIMUM80', 'FUTURE80', 'CAPACITY80'], NULL,
    'subscription_initial', 10000, now()
  )#>>'{codeRejectionDetails,1,minimumReferenceMinor}',
  '12000',
  'v2 exposes the safe minimum threshold detail');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['SCOPEONLY80', 'MINIMUM80', 'FUTURE80', 'CAPACITY80'], NULL,
    'subscription_initial', 10000, now()
  )#>>'{codeRejectionDetails,2,reason}',
  'not_yet_active',
  'v2 exposes the future-start detail without changing quote money');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['SCOPEONLY80', 'MINIMUM80', 'FUTURE80', 'CAPACITY80'], NULL,
    'subscription_initial', 10000, now()
  )#>>'{codeRejectionDetails,3,reason}',
  'global_limit_reached',
  'v2 exposes the exhausted global-pool detail without exposing remaining capacity');
SELECT is(
  public.commerce_promotion_codes_quote_candidates(
    ARRAY['SCOPEONLY80', 'MINIMUM80', 'FUTURE80', 'CAPACITY80'], NULL,
    'subscription_initial', 10000, now()
  ) ? 'codeRejectionDetails',
  false,
  'v1 RPC wire shape remains unchanged after the v2 addition');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['60vip'], NULL, 'one_time', 10000, now()
  )->'codeRejections',
  '[]'::jsonb,
  'legacy 60VIP remains eligible for the v1 one-time money path');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['60VIP'], NULL, 'subscription_initial', 10000, now()
  )->'codeRejections',
  '[{"code":"60VIP","reason":"not_eligible"}]'::jsonb,
  'legacy 60VIP keeps the frozen rejection item shape when subscription scope fails');
SELECT is(
  public.commerce_promotion_codes_quote_candidates_v2(
    ARRAY['60VIP'], NULL, 'subscription_initial', 10000, now()
  )#>'{codeRejectionDetails,0}',
  '{"code":"60VIP","reason":"scope_not_applicable","allowedScopes":["one_time"]}'::jsonb,
  'legacy 60VIP exposes its projected one-time scope through v2 details only');

SELECT * FROM finish();
ROLLBACK;
