-- Managed seam/M6 owner ATP: protected future demand is not one-time supply.
BEGIN;
SELECT no_plan();
-- Read the installed, approved provider binding rather than duplicating its vendor literal.
-- The real-PG harness separately binds these units to their immutable registry digests.
CREATE TEMP TABLE managed_stock_fixture AS SELECT
 (regexp_match(pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure),
  $binding$stock.provider_kind='([^']+)'$binding$))[1] AS provider,
 (regexp_match(pg_get_functiondef('public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)'::regprocedure),
  $binding$WHERE code = '([^']+)'$binding$))[1] AS location;
INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
VALUES((SELECT provider FROM managed_stock_fixture),'fulfillment','Synthetic ATP provider','active',ARRAY['ZZ'])
ON CONFLICT(kind) DO NOTHING;
INSERT INTO public.inventory_locations(code,display_name,kind,status,region,fulfillable,provider_kind)
VALUES((SELECT location FROM managed_stock_fixture),'Synthetic provider stock','third_party_logistics','active','ZZ',true,(SELECT provider FROM managed_stock_fixture))
ON CONFLICT(code) DO NOTHING;
CREATE TEMP TABLE atp_cases(label text, qty integer, for_sale integer, days integer,
 client_id uuid DEFAULT gen_random_uuid(), subscription_id uuid DEFAULT gen_random_uuid(),
 product_id uuid DEFAULT gen_random_uuid(), sku_id uuid DEFAULT gen_random_uuid(), order_id uuid DEFAULT gen_random_uuid());
INSERT INTO atp_cases(label,qty,for_sale,days) VALUES ('inside-horizon',3,3,7),('outside-horizon',3,3,15);
INSERT INTO public.clients(id,email) SELECT client_id,label||'@example.invalid' FROM atp_cases;
INSERT INTO public.catalog_products(id,slug,name,status) SELECT product_id,label,'Synthetic ATP','active' FROM atp_cases;
INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
SELECT sku_id,product_id,'ATP-'||label,'Synthetic ATP','other','active',1,1 FROM atp_cases;
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,next_cycle_at)
SELECT subscription_id,client_id,28,'XTS','active',now()+days*interval '1 day' FROM atp_cases;
INSERT INTO public.subscription_lines(subscription_id,variant_id,qty,sort_order,is_addon,template_version)
SELECT subscription_id,sku_id,qty,0,false,1 FROM atp_cases;
SELECT public.fulfillment_provider_upsert_stock_current('atp-stock-'||label,(SELECT provider FROM managed_stock_fixture),'ATP-'||label,
 for_sale,for_sale,0,now(),now()+interval '1 hour','atp-run','{}') FROM atp_cases;
INSERT INTO public.commerce_orders(id,client_id,status,mode,currency,total_cents,subtotal_cents)
SELECT order_id,client_id,'draft','one_time','XTS',100,100 FROM atp_cases;
SELECT is((SELECT soft_subscription_demand_quantity FROM public.inventory_available_to_promise(sku_id,now(),false)),
 CASE WHEN days<=14 THEN qty::bigint ELSE 0::bigint END,label||': fixed 14-day demand') FROM atp_cases;
SELECT is((SELECT available_quantity FROM public.inventory_available_to_promise(sku_id,now(),false)),
 CASE WHEN days<=14 THEN 0::bigint ELSE for_sale::bigint END,label||': one-time ATP protects upcoming demand') FROM atp_cases;
SELECT throws_ok(format($q$SELECT public.inventory_reserve_order(%L,%L,NULL,NULL,%L,1,
 'subscription_retry_window','created',now()+interval '1 hour','{"forSubscriptionRenewal":true}',(SELECT provider FROM managed_stock_fixture))$q$,
 'atp-one-time-'||label,order_id,sku_id),'23514','inventory_external_provider_insufficient_available_stock',
 label||': forged hold kind/metadata cannot spend subscription demand') FROM atp_cases WHERE days<=14;
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations r WHERE r.order_id=f.order_id),0,
 label||': refused allocation writes no hold') FROM atp_cases f WHERE days<=14;
SELECT lives_ok(format($q$SELECT public.inventory_reserve_order(%L,%L,NULL,NULL,%L,1,'checkout_payment_window','created',
 now()+interval '1 hour','{}',(SELECT provider FROM managed_stock_fixture))$q$,'atp-one-time-'||label,order_id,sku_id),
 label||': stock outside the protected horizon remains available') FROM atp_cases WHERE days>14;
SELECT is((SELECT status FROM public.subscriptions s WHERE s.id=f.subscription_id),'active',label||': ATP never pauses service') FROM atp_cases f;
SELECT is(public.inventory_channel_exposure_quantity(sku_id),0::bigint,label||': deferred exposure hook is zero') FROM atp_cases;
SELECT * FROM finish();
ROLLBACK;
