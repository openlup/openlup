-- pgTAP: the v2 first-subscription twin exists in both migrated and freshly seeded DBs.
-- This test depends on the promotion v2 columns supplied by the promotion-codes wave.

BEGIN;
SELECT plan(20);

INSERT INTO public.promotions (
  id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, applies_to_payload, stacking_rule, eligibility,
  valid_from, valid_to, redemption_limit_global,
  redemption_limit_per_customer, region_availability, status,
  promotion_engine_version
) VALUES (
  'f2000000-0000-0000-0000-000000000001', NULL,
  'First Subscription 50%', 'automatic', 'percentage', 44.404,
  'order_total', '{"cart_mode":"subscription"}'::jsonb, 'exclusive',
  '{"first_subscription_purchase":true}'::jsonb,
  '2026-07-01T00:00:00Z', '2027-07-01T00:00:00Z', 2, 1,
  ARRAY['PL']::text[], 'active', 'promotion-engine.v1'
);

SELECT is(
  (SELECT count(*)::integer FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  1,
  'inserting the post-migration legacy seed creates exactly one v2 mirror'
);

SELECT is(
  (SELECT promotion_engine_version || '/' || benefit_lane || '/' ||
          benefit_kind || '/' || benefit_value_bps::text
     FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'promotion-engine.v2/product/target_percentage/5000',
  'the mirror pins the explicit target-percentage benefit'
);

SELECT is(
  (SELECT eligibility FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  '{"first_subscription_purchase":true}'::jsonb,
  'the mirror preserves the legacy eligibility gate'
);

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'paused',
  'a newly-created mirror remains database-dark until explicit post-deploy activation'
);

SELECT is(
  (SELECT count(*)::integer FROM public.promotions
    WHERE name = 'First Subscription 50%' AND status = 'active'),
  1,
  'the pre-v2 active-row evaluator can see only the legacy promotion after migration'
);

UPDATE public.promotions
   SET status = 'active'
 WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'active',
  'an explicit post-deploy operator update opens the mirror activation latch'
);

UPDATE public.promotions
   SET discount_value = 45
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'paused',
  'an unrecognized legacy representation pauses v2 instead of guessing'
);

UPDATE public.promotions
   SET discount_type = 'free_shipping',
       discount_value = 44.404
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT discount_type || '/' || status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'percentage/paused',
  'an incompatible legacy type cannot mutate or activate the explicit v2 benefit'
);

UPDATE public.promotions
   SET discount_type = 'percentage',
       discount_value = 44.404,
       applies_to_kind = 'line_with_variant',
       status = 'active'
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'paused',
  'changing the legacy adjustment lane pauses the product-only v2 mirror'
);

UPDATE public.promotions
   SET applies_to_kind = 'order_total',
       applies_to_payload = '{"cart_mode":"one_time"}'::jsonb,
       status = 'active'
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'paused',
  'changing the legacy cart scope pauses the first-subscription v2 mirror'
);

UPDATE public.promotions
   SET applies_to_payload = '{"cart_mode":"subscription"}'::jsonb,
       eligibility = '{"first_subscription_purchase":false}'::jsonb,
       status = 'active'
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'paused',
  'removing the first-subscription eligibility gate pauses the v2 mirror'
);

UPDATE public.promotions
   SET eligibility = '{"first_subscription_purchase":true}'::jsonb,
       stacking_rule = 'stackable_with_any',
       status = 'active'
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'paused',
  'changing the legacy stacking shape pauses v2 instead of assuming parity'
);

UPDATE public.promotions
   SET name = 'First Subscription 50% renamed',
       discount_type = 'percentage',
       discount_value = 44.404,
       applies_to_kind = 'order_total',
       applies_to_payload = '{"cart_mode":"subscription"}'::jsonb,
       eligibility = '{"first_subscription_purchase":true}'::jsonb,
       stacking_rule = 'exclusive',
       valid_to = '2027-08-01T00:00:00Z',
       status = 'active'
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT jsonb_build_object(
            'name', name,
            'status', status,
            'valid_to', to_char(valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          )
     FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  '{"name":"First Subscription 50% renamed","status":"paused","valid_to":"2027-08-01T00:00:00Z"}'::jsonb,
  'repairing the legacy shape does not silently reopen a closed activation latch'
);

SELECT is(
  (SELECT jsonb_build_object(
            'applies_to_kind', applies_to_kind,
            'applies_to_payload', applies_to_payload,
            'stacking_rule', stacking_rule,
            'eligibility', eligibility
          )
     FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  '{"applies_to_kind":"order_total","applies_to_payload":{"cart_mode":"subscription"},"stacking_rule":"exclusive","eligibility":{"first_subscription_purchase":true}}'::jsonb,
  'a repaired mirror retains exact first-subscription shape parity while paused'
);

UPDATE public.promotions
   SET status = 'active'
 WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'active',
  'the repaired mirror still requires an explicit operator reactivation'
);

UPDATE public.promotions
   SET valid_to = '2027-09-01T00:00:00Z'
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT status || '/' || to_char(valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD')
     FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  'active/2027-09-01',
  'safe legacy edits preserve and synchronize an already-open activation latch'
);

INSERT INTO public.promotions (
  id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, status, promotion_engine_version
) VALUES (
  'f2000000-0000-0000-0000-000000000002', NULL,
  'Unrelated automatic benefit', 'automatic', 'percentage', 5,
  'order_total', 'active', 'promotion-engine.v1'
);

SELECT is(
  (SELECT count(*)::integer FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000002'),
  0,
  'an unrelated v1 promotion does not acquire a v2 mirror'
);

INSERT INTO public.clients (id, email) VALUES
  ('f2100000-0000-0000-0000-000000000001', 'offer-policy-family-a@example.invalid'),
  ('f2100000-0000-0000-0000-000000000002', 'offer-policy-family-b@example.invalid');

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint,
  status, total_cents, subtotal_cents, metadata
) VALUES
  (
    'f2200000-0000-0000-0000-000000000001',
    'f2100000-0000-0000-0000-000000000001',
    'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb,
    'draft', 1000, 1000, '{}'::jsonb
  ),
  (
    'f2200000-0000-0000-0000-000000000002',
    'f2100000-0000-0000-0000-000000000002',
    'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb,
    'draft', 1000, 1000, '{}'::jsonb
  );

-- Model one redemption written before v2 cutover and one written by the mirror.
-- The count RPC must expose one stable legacy-family key to both evaluators.
INSERT INTO public.promotion_redemptions (
  promotion_id, client_id, order_id, amount_off_minor
) VALUES (
  'f2000000-0000-0000-0000-000000000001',
  'f2100000-0000-0000-0000-000000000001',
  'f2200000-0000-0000-0000-000000000001',
  500
);

INSERT INTO public.promotion_redemptions (
  promotion_id, client_id, order_id, amount_off_minor
)
SELECT
  mirror.id,
  'f2100000-0000-0000-0000-000000000002',
  'f2200000-0000-0000-0000-000000000002',
  500
FROM public.promotions mirror
WHERE mirror.v2_mirror_of = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT global_count::text || '/' || per_customer_count::text
     FROM public.commerce_promotion_redemption_counts(
       'f2100000-0000-0000-0000-000000000001'
     )
    WHERE promotion_id = 'f2000000-0000-0000-0000-000000000001'),
  '2/1',
  'legacy and mirror redemptions exhaust one shared global/per-customer family cap'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_promotion_redemption_counts(
       'f2100000-0000-0000-0000-000000000001'
     ) counts
     JOIN public.promotions mirror ON mirror.id = counts.promotion_id
    WHERE mirror.v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  0,
  'the counts RPC never exposes a second mirror key that could reset caps on cutover'
);

DELETE FROM public.commerce_orders
 WHERE id IN (
   'f2200000-0000-0000-0000-000000000001',
   'f2200000-0000-0000-0000-000000000002'
 );

DELETE FROM public.promotions
 WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::integer FROM public.promotions
    WHERE v2_mirror_of = 'f2000000-0000-0000-0000-000000000001'),
  0,
  'deleting the legacy owner cascades to its v2 mirror'
);

SELECT * FROM finish();
ROLLBACK;
