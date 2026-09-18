-- pgTAP: device first-order guard (20260620100000).
--   * the paid-transition redemption trigger captures metadata.runtimeFinalize.visitorId
--     onto promotion_redemptions.visitor_id
--   * commerce_device_first_order_redeemed(vid) is TRUE for a device that paid a first-order
--     promo, FALSE for an unseen device, and FALSE for null/empty
--   * only a PAID order trips it (a pending order leaves no redemption → still FALSE)
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(5);

INSERT INTO public.clients (id, email)
VALUES ('20000000-0000-0000-0000-0000000000aa', 'device-guard@example.invalid');

INSERT INTO public.promotions (
  id, code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, applies_to_payload, stacking_rule, eligibility, status, region_availability
)
VALUES (
  '20000000-0000-0000-0000-0000000000f1', NULL, 'First Purchase 10% (test)', 'automatic',
  'percentage', 10, 'order_total', jsonb_build_object('cart_mode', 'one_time'),
  'exclusive', jsonb_build_object('first_onetime_purchase', true), 'active', ARRAY['PL']
);

-- Order with the vid in runtimeFinalize + a first-order discount in the quote snapshot.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, metadata)
VALUES (
  '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000aa',
  'DEV-GUARD-1', 'pending_payment', 'one_time', 'PLN',
  jsonb_build_object(
    'runtimeFinalize', jsonb_build_object('visitorId', 'vid-A'),
    'quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
      'discounts', jsonb_build_array(
        jsonb_build_object('promotionId', '20000000-0000-0000-0000-0000000000f1', 'amountOffMinor', 1000)
      )
    ))
  )
);

-- Before payment: no redemption, device not flagged.
SELECT is(
  public.commerce_device_first_order_redeemed('vid-A'), false,
  'a pending (unpaid) order does NOT flag the device');

-- Pay it → trigger writes the redemption with the captured visitor_id.
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '20000000-0000-0000-0000-0000000000d1';

SELECT is(
  (SELECT visitor_id FROM public.promotion_redemptions
    WHERE order_id = '20000000-0000-0000-0000-0000000000d1'),
  'vid-A',
  'paid-transition trigger captures metadata.runtimeFinalize.visitorId');

SELECT is(
  public.commerce_device_first_order_redeemed('vid-A'), true,
  'device with a paid first-order redemption is flagged');

SELECT is(
  public.commerce_device_first_order_redeemed('vid-OTHER'), false,
  'an unseen device is not flagged');

SELECT is(
  public.commerce_device_first_order_redeemed(NULL), false,
  'null visitor id is never flagged');

SELECT * FROM finish();
ROLLBACK;
