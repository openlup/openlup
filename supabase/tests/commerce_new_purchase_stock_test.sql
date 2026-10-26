-- New-purchase reads share ATP, including hard holds and protected renewal demand.
BEGIN;
SELECT no_plan();
CREATE TEMP TABLE stock_probe AS SELECT gen_random_uuid() client,gen_random_uuid() sku,
  gen_random_uuid() location,gen_random_uuid() order_id,gen_random_uuid() subscription,
  '2030-01-01T00:00:00Z'::timestamptz as_of,
  (regexp_match(pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure),
    $binding$stock.provider_kind='([^']+)'$binding$))[1] provider;
INSERT INTO public.clients(id,email) SELECT client,'stock-probe@example.invalid' FROM stock_probe;
INSERT INTO public.catalog_products(id,slug,name) SELECT sku,'stock-probe','Synthetic stock' FROM stock_probe;
INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,net_weight_g,kcal_per_unit)
SELECT sku,sku,'SYNTHETIC-STOCK','Synthetic stock','other',1,1 FROM stock_probe;
INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
SELECT provider,'fulfillment','Synthetic stock','active',ARRAY['ZZ'] FROM stock_probe ON CONFLICT(kind) DO NOTHING;
INSERT INTO public.inventory_locations(id,code,display_name,kind,status,region,fulfillable)
SELECT location,'stock-probe','Synthetic stock','internal_warehouse','active','ZZ',true FROM stock_probe;
INSERT INTO public.inventory_balances(sku_id,location_id,on_hand,safety_stock)
SELECT sku,location,100,2 FROM stock_probe;
INSERT INTO public.commerce_orders(id,client_id,currency,region_code,status)
SELECT order_id,client,'XXX','ZZ','draft' FROM stock_probe;
INSERT INTO public.inventory_reservations(idempotency_key,order_id,sku_id,location_id,quantity,status,kind,metadata,expires_at)
SELECT 'stock-active',order_id,sku,location,3,'reserved','manual_ops',jsonb_build_object('providerKind',provider),as_of+interval '1 hour' FROM stock_probe;
INSERT INTO public.inventory_reservations(idempotency_key,order_id,sku_id,location_id,quantity,status,kind,metadata,expires_at)
SELECT 'stock-expired',order_id,sku,location,11,'reserved','manual_ops',jsonb_build_object('providerKind',provider),as_of FROM stock_probe;
INSERT INTO public.inventory_reservations(idempotency_key,order_id,sku_id,location_id,quantity,status,kind,metadata)
SELECT 'stock-released',order_id,sku,location,13,'released','manual_ops',jsonb_build_object('providerKind',provider) FROM stock_probe;
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,region_code,status,next_cycle_at)
SELECT subscription,client,21,'XXX','ZZ','active',as_of+interval '7 days' FROM stock_probe;
INSERT INTO public.subscription_lines(subscription_id,variant_id,qty,sort_order,is_addon,template_version)
SELECT subscription,sku,4,0,false,1 FROM stock_probe;
INSERT INTO public.fulfillment_provider_stock_current(provider_kind,sku,catalog_sku_id,provider_total_quantity,
 provider_for_sale_quantity,provider_reserved_unavailable_quantity,last_synced_at,stale_after,sync_run_id)
SELECT provider,'SYNTHETIC-STOCK',sku,20,20,0,as_of,as_of+interval '1 hour','synthetic-stock' FROM stock_probe;
GRANT SELECT ON stock_probe TO service_role;
SET LOCAL ROLE service_role;
SELECT lives_ok($q$SELECT public.inventory_new_purchase_stock_read('["SYNTHETIC-STOCK"]','2030-01-01T00:00:00Z')$q$,
 'service role executes the owner-privilege stock seam');
-- Arithmetic assertions use the same granted caller.
SELECT is(public.inventory_new_purchase_stock_read('["SYNTHETIC-STOCK","SYNTHETIC-MISSING","SYNTHETIC-STOCK"]',as_of),
 jsonb_build_array(jsonb_build_object('sku','SYNTHETIC-MISSING','catalogSkuId',NULL,'source','missing',
 'providerForSale',NULL,'activeHolds',0,'safetyStock',0,'available',0,'stale',false,'renewalDemand',0,
 'availableForNewPurchases',0,'excludedOrderHolds',0,'channelExposure',0),
 jsonb_build_object('sku','SYNTHETIC-STOCK','catalogSkuId',sku,'source','provider','providerForSale',20,
 'activeHolds',3,'safetyStock',2,'available',11,'stale',false,'renewalDemand',4,
 'availableForNewPurchases',11,'excludedOrderHolds',0,'channelExposure',0)),
 'stock seam subtracts holds, safety and renewal demand exactly once; sorts and deduplicates') FROM stock_probe;
SET LOCAL ROLE service_role;
SELECT is(public.inventory_new_purchase_stock_read('[]',as_of),'[]'::jsonb,'empty stock input returns an empty array') FROM stock_probe;
SELECT throws_ok($q$SELECT public.inventory_new_purchase_stock_read('{}','2030-01-01')$q$,'22023','inventory_stock_skus_invalid','object input refuses');
SELECT throws_ok($q$SELECT public.inventory_new_purchase_stock_read(NULL,'2030-01-01')$q$,'22023','inventory_stock_skus_invalid','NULL input refuses');
SELECT throws_ok($q$SELECT public.inventory_new_purchase_stock_read('[]',NULL)$q$,'22023','inventory_stock_as_of_invalid','NULL as-of refuses');
SELECT throws_ok($q$SELECT public.inventory_new_purchase_stock_read((SELECT jsonb_agg('SYNTHETIC-STOCK'::text) FROM generate_series(1,201)),'2030-01-01')$q$,
 '22023','inventory_stock_skus_limit_exceeded','array limit applies before deduplication');
RESET ROLE;
SET LOCAL ROLE postgres;
INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
VALUES('synthetic-stock-secondary','fulfillment','Synthetic secondary','active',ARRAY['ZZ']);
INSERT INTO public.fulfillment_provider_stock_current(provider_kind,sku,catalog_sku_id,provider_total_quantity,
 provider_for_sale_quantity,provider_reserved_unavailable_quantity,last_synced_at,stale_after,sync_run_id)
SELECT 'synthetic-stock-secondary','SYNTHETIC-STOCK',sku,20,20,0,as_of,as_of,'synthetic-secondary' FROM stock_probe;
SET LOCAL ROLE service_role;
SELECT is(public.inventory_new_purchase_stock_read('["SYNTHETIC-STOCK"]',as_of)->0->>'stale','true','any provider stale boundary is inclusive') FROM stock_probe;
RESET ROLE;
SET LOCAL ROLE postgres;
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=1 WHERE sku='SYNTHETIC-STOCK';
SET LOCAL ROLE service_role;
SELECT is(public.inventory_new_purchase_stock_read('["SYNTHETIC-STOCK"]',as_of)->0->>'available','0','deficit clamps availability to zero') FROM stock_probe;
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT * FROM finish();
ROLLBACK;
