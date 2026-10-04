-- Installed lot safety: runtime consumption refuses stale lots before any movement.
BEGIN;
SELECT plan(12);
SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['anon','authenticated']) role,
    unnest(ARRAY['public.inventory_invalidate_lot(text,uuid,text,text,jsonb)',
      'public.inventory_guard_consumable_lot()']) fn
  WHERE has_function_privilege(role,fn,'EXECUTE')
), 'browser roles cannot invoke the lot invalidator or trigger guard');
SELECT ok(has_function_privilege('service_role',
 'public.inventory_consume_reservation_for_fulfillment(text,uuid,jsonb)','EXECUTE'),
 'the fulfillment runtime can invoke its reservation consumer');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.inventory_invalidate_lot('lot-browser-denied','fa000000-0000-4000-8000-000000000004','expired','test','{}')$$,
 '42501',NULL,'anonymous invalidation is refused before any fixture exists');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.inventory_invalidate_lot('lot-browser-denied','fa000000-0000-4000-8000-000000000004','expired','test','{}')$$,
 '42501',NULL,'signed-in invalidation is refused before any fixture exists');
RESET ROLE;
INSERT INTO public.catalog_products (id,slug,name,status) VALUES
 ('fa000000-0000-4000-8000-000000000001','lot-runtime-boundary','Synthetic lot product','active');
INSERT INTO public.catalog_skus (id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit) VALUES
 ('fa000000-0000-4000-8000-000000000002','fa000000-0000-4000-8000-000000000001','LOT-RUNTIME','Synthetic lot SKU','other','active',1,1);
INSERT INTO public.inventory_locations (id,code,display_name,kind,status,region,fulfillable) VALUES
 ('fa000000-0000-4000-8000-000000000003','pgtap-lot-runtime','Synthetic lot location','internal_warehouse','active','ZZ',true);
INSERT INTO public.inventory_lots (id,sku_id,lot_code,status,expires_at) VALUES
 ('fa000000-0000-4000-8000-000000000004','fa000000-0000-4000-8000-000000000002','LOT-RUNTIME-OLD','available',now()-interval '1 minute');
INSERT INTO public.commerce_orders (id,status,mode,currency) VALUES
 ('fa000000-0000-4000-8000-000000000005','pending_payment','one_time','XTS');
INSERT INTO public.inventory_balances (sku_id,location_id,lot_id,on_hand,reserved) VALUES
 ('fa000000-0000-4000-8000-000000000002','fa000000-0000-4000-8000-000000000003','fa000000-0000-4000-8000-000000000004',2,1);
INSERT INTO public.inventory_reservations (id,idempotency_key,order_id,sku_id,location_id,lot_id,quantity,status,kind) VALUES
 ('fa000000-0000-4000-8000-000000000006','lot-runtime-reservation','fa000000-0000-4000-8000-000000000005',
 'fa000000-0000-4000-8000-000000000002','fa000000-0000-4000-8000-000000000003','fa000000-0000-4000-8000-000000000004',1,'reserved','manual_ops');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.inventory_consume_reservation_for_fulfillment('lot-runtime-consume','fa000000-0000-4000-8000-000000000006','{}')$$,
 '22023','inventory_lot_not_consumable','runtime consumption refuses an expired available lot');
RESET ROLE;
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='fa000000-0000-4000-8000-000000000006'),
 'reserved','refused consumption leaves the reservation reserved');
SELECT is((SELECT on_hand::text||'/'||reserved::text FROM public.inventory_balances WHERE lot_id='fa000000-0000-4000-8000-000000000004'),
 '2/1','refused consumption leaves stock and reserved balances unchanged');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE lot_id='fa000000-0000-4000-8000-000000000004'),
 0,'refused consumption records no movement');
SET LOCAL ROLE service_role;
SELECT is(public.inventory_invalidate_lot('lot-runtime-invalidate','fa000000-0000-4000-8000-000000000004','expired','synthetic stale lot','{}')->>'releasedReservationCount',
 '1','runtime invalidation releases the stale lot reservation');
SELECT is(public.inventory_invalidate_lot('lot-runtime-invalidate','fa000000-0000-4000-8000-000000000004','expired','synthetic stale lot','{}')->>'releasedReservationCount',
 '0','replayed invalidation releases no reservation twice');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE lot_id='fa000000-0000-4000-8000-000000000004'),
 1,'replayed invalidation emits exactly one release movement');
SELECT is((SELECT on_hand::text||'/'||reserved::text FROM public.inventory_balances WHERE lot_id='fa000000-0000-4000-8000-000000000004'),
 '2/0','invalidation conserves on-hand stock and clears only the reservation');
SELECT * FROM finish();
ROLLBACK;
