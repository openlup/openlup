-- Missing managed read boundaries: local FEFO/expiry/safety and adjustment authority.
BEGIN;
SELECT plan(13);
INSERT INTO public.catalog_products(id,slug,name,status) VALUES ('f6000000-0000-4000-8000-000000000001','m06-read','Fixture','active');
INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
VALUES ('f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000001','M06-READ','Fixture','other','active',1,1);
INSERT INTO public.inventory_locations(id,code,display_name,kind,status,fulfillable)
VALUES ('f6000000-0000-4000-8000-000000000003','m06-read','Fixture','internal_warehouse','active',true);
INSERT INTO public.inventory_lots(id,sku_id,lot_code,status,expires_at) VALUES
('f6000000-0000-4000-8000-000000000004','f6000000-0000-4000-8000-000000000002','M06-EARLY','available',now()+interval '1 day'),
('f6000000-0000-4000-8000-000000000005','f6000000-0000-4000-8000-000000000002','M06-LATE','available',now()+interval '2 days'),
('f6000000-0000-4000-8000-000000000006','f6000000-0000-4000-8000-000000000002','M06-EXPIRED','available',now()-interval '1 day');
INSERT INTO public.inventory_balances(sku_id,location_id,lot_id,on_hand,unavailable,safety_stock) VALUES
('f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000004',5,1,1),
('f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000005',7,0,0),
('f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000006',100,0,0);
INSERT INTO public.commerce_orders(id,status,mode,currency) VALUES ('f6000000-0000-4000-8000-000000000007','pending_payment','one_time','XTS');
SET LOCAL ROLE service_role;
SELECT is(public.inventory_available_quantity('f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000004'),3,'quantity excludes unavailable and safety stock');
SELECT is(public.inventory_reserve_order('m06-read-reserve','f6000000-0000-4000-8000-000000000007',NULL,NULL,'f6000000-0000-4000-8000-000000000002',4,'manual_ops','processing',now()+interval '1 hour','{}',NULL)->>'status','reserved','runtime reserves across eligible lots');
SELECT is((SELECT quantity FROM public.inventory_reservations WHERE order_id='f6000000-0000-4000-8000-000000000007' AND lot_id='f6000000-0000-4000-8000-000000000004'),3,'FEFO uses earliest eligible stock first');
SELECT is((SELECT quantity FROM public.inventory_reservations WHERE order_id='f6000000-0000-4000-8000-000000000007' AND lot_id='f6000000-0000-4000-8000-000000000005'),1,'remaining demand uses later lot');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations WHERE lot_id='f6000000-0000-4000-8000-000000000006'),0,'expired lot excluded despite large balance');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations WHERE order_id='f6000000-0000-4000-8000-000000000007' AND status='reserved'),2,'granted runtime lists both allocations');
SELECT is(public.inventory_adjust_stock('m06-read-adjust','f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000005',2,'fixture',NULL,'{}')->>'replayed','false','runtime adjustment succeeds');
SELECT is(public.inventory_adjust_stock('m06-read-adjust','f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000005',2,'fixture',NULL,'{}')->>'replayed','true','adjustment replay succeeds without repeating');
SELECT is((SELECT on_hand FROM public.inventory_balances WHERE lot_id='f6000000-0000-4000-8000-000000000005'),9,'adjustment changes stock once');
SELECT throws_ok($$SELECT public.inventory_adjust_stock('m06-read-break','f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003','f6000000-0000-4000-8000-000000000005',-9,'fixture',NULL,'{}')$$,'23514','inventory_adjustment_would_break_reserved_stock','adjustment cannot destroy held units');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.inventory_adjust_stock('m06-read-denied','f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003',NULL,1,'fixture',NULL,'{}')$$,'42501',NULL,'anonymous adjustment denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.inventory_adjust_stock('m06-read-denied','f6000000-0000-4000-8000-000000000002','f6000000-0000-4000-8000-000000000003',NULL,1,'fixture',NULL,'{}')$$,'42501',NULL,'signed-in adjustment denied');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE idempotency_key='m06-read-adjust'),1,'only one adjustment movement survives replays and refusals');
SELECT * FROM finish();
ROLLBACK;
