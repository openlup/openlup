-- pgTAP: Promo B3 — promotion redemptions written on the order's paid transition (20260612150000).
--   * a paid order with applied discounts writes one promotion_redemptions row per promotion
--   * the row carries client_id + amount_off_minor; the write is idempotent
--   * an order with no discounts writes nothing; a discount naming a removed promotion is skipped
--   * commerce_promotion_redemption_counts reports global + per-customer counts for the cap filter
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(7);

INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'redeem@example.invalid');
INSERT INTO public.promotions (id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, applies_to_payload, stacking_rule, eligibility, status, region_availability)
VALUES ('99999999-9999-9999-9999-999999999999', 'B3CODE', 'B3 Promo', 'coupon_code', 'percentage', 25,
  'order_total', '{}'::jsonb, 'exclusive', '{}'::jsonb, 'active', ARRAY['PL']);

-- ---- O1: one_time order with an applied discount ----
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, metadata)
VALUES ('a0000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL',
  '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2010, 2010,
  jsonb_build_object('quoteSnapshot', jsonb_build_object('quote', jsonb_build_object('discounts',
    jsonb_build_array(jsonb_build_object('promotionId', '99999999-9999-9999-9999-999999999999',
      'amountOffMinor', 670, 'appliesTo', 'order_total', 'reasonCode', 'promo:B3CODE'))))));
UPDATE public.commerce_orders SET status='paid' WHERE id='a0000000-0000-0000-0000-0000000000a1';

SELECT is((SELECT count(*)::int FROM public.promotion_redemptions
            WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  1, 'B3: paid order with a discount writes one redemption');
SELECT is((SELECT amount_off_minor FROM public.promotion_redemptions WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  670, 'B3: redemption records the discount amount');
SELECT is((SELECT client_id::text FROM public.promotion_redemptions WHERE order_id='a0000000-0000-0000-0000-0000000000a1'),
  '11111111-1111-1111-1111-111111111111', 'B3: redemption records the client');

-- idempotent: re-invoking the helper does not duplicate.
SELECT is((SELECT public.commerce_write_order_promotion_redemptions('a0000000-0000-0000-0000-0000000000a1', now())),
  0, 'B3: re-running the helper writes nothing (UNIQUE(promotion_id,order_id))');

-- ---- O2: no discounts ----
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, metadata)
VALUES ('a0000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL',
  '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680,
  jsonb_build_object('quoteSnapshot', jsonb_build_object('quote', jsonb_build_object('discounts', '[]'::jsonb))));
UPDATE public.commerce_orders SET status='paid' WHERE id='a0000000-0000-0000-0000-0000000000a2';
SELECT is((SELECT count(*)::int FROM public.promotion_redemptions WHERE order_id='a0000000-0000-0000-0000-0000000000a2'),
  0, 'B3: paid order with no discounts writes no redemption');

-- ---- O3: discount names a non-existent promotion (skipped, no FK error) ----
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, metadata)
VALUES ('a0000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL',
  '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680,
  jsonb_build_object('quoteSnapshot', jsonb_build_object('quote', jsonb_build_object('discounts',
    jsonb_build_array(jsonb_build_object('promotionId', '00000000-0000-0000-0000-00000000dead',
      'amountOffMinor', 500, 'appliesTo', 'order_total', 'reasonCode', 'promo:gone'))))));
UPDATE public.commerce_orders SET status='paid' WHERE id='a0000000-0000-0000-0000-0000000000a3';
SELECT is((SELECT count(*)::int FROM public.promotion_redemptions WHERE order_id='a0000000-0000-0000-0000-0000000000a3'),
  0, 'B3: a discount naming a removed promotion is skipped (no FK error)');

-- ---- counts RPC ----
SELECT is(
  (SELECT global_count::int || '/' || per_customer_count::int
     FROM public.commerce_promotion_redemption_counts('11111111-1111-1111-1111-111111111111')
    WHERE promotion_id='99999999-9999-9999-9999-999999999999'),
  '1/1', 'B3: redemption counts report global + per-customer for the cap filter');

SELECT * FROM finish();
ROLLBACK;
