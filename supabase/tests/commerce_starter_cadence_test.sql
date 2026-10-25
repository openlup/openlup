-- Provisional checkout and graduation preserve the retained starter terms.
BEGIN;
SELECT no_plan();
ALTER TABLE public.subscriptions ALTER COLUMN timezone SET DEFAULT 'UTC';
CREATE TEMP TABLE starter_probe AS SELECT gen_random_uuid() client,gen_random_uuid() sku,gen_random_uuid() order_id;
INSERT INTO public.clients(id,email) SELECT client,'starter-probe@example.invalid' FROM starter_probe;
INSERT INTO public.catalog_products(id,slug,name) SELECT sku,'starter-probe','Synthetic starter' FROM starter_probe;
INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
SELECT sku,sku,'SYNTHETIC-STARTER','Synthetic starter','other','active',1,1 FROM starter_probe;
INSERT INTO public.commerce_orders(id,client_id,currency,region_code,status)
SELECT order_id,client,'XXX','ZZ','draft' FROM starter_probe;
INSERT INTO public.commerce_order_items(order_id,sku_id,quantity,unit_price_cents,total_cents,
 discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,allocation_ordinal,product_snapshot)
SELECT order_id,sku,1,500,500,0,500,500,0,1,'{"sku":"SYNTHETIC-STARTER"}' FROM starter_probe;
ALTER TABLE starter_probe ADD COLUMN quote jsonb;
UPDATE starter_probe SET quote=jsonb_build_object('quote',jsonb_build_object('context',jsonb_build_object(
 'cadenceDays',28,'starterPack',jsonb_build_object('schemaVersion','1','starterIntervalDays',21,'basisTemplateVersion',1,
 'delivery2',jsonb_build_object('discountBps',1000,'discountMinor',100,'basisSubtotalMinor',1000),
 'graduation',jsonb_build_object('cadenceDays',21,'sizeConstraint',jsonb_build_object('kind','unit_count','value',2),
 'lines',jsonb_build_array(jsonb_build_object('sku','SYNTHETIC-STARTER','qty',2,'sortOrder',0,'isAddon',false,
 'quoteLine',jsonb_build_object('sku','SYNTHETIC-STARTER','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',500,'currency','XXX'),'lineSubtotalGross',jsonb_build_object('amountMinor',1000,'currency','XXX')))))))));
GRANT SELECT ON starter_probe TO service_role;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE starter_created AS SELECT public.subscription_create_provisional_for_checkout(order_id,client,NULL,NULL,quote) result FROM starter_probe;
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM starter_created)),21,
 'starter provisional creation uses its 21-day interval');
SELECT is((SELECT template_snapshot->>'cadence_days' FROM public.subscription_cycles WHERE id=(SELECT (result->>'subscriptionCycleId')::uuid FROM starter_created)),'21',
 'initial cycle retains the starter cadence');
SELECT is((SELECT timezone FROM public.subscriptions WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM starter_created)),
 'UTC', 'provisional creation uses the subscription timezone default');
-- An open payment cycle prevents graduation; settling it enables the same retained terms.
GRANT SELECT ON starter_created TO service_role;
SET LOCAL ROLE service_role;
SELECT throws_ok($q$SELECT public.subscription_apply_starter_graduation((SELECT (result->>'subscriptionId')::uuid FROM starter_created),'starter-graduate','full')$q$,
 '22023','subscription_starter_graduation_open_cycle','open cycle refuses graduation');
RESET ROLE;
SET LOCAL ROLE postgres;
UPDATE public.subscription_cycles SET status='paid' WHERE id=(SELECT (result->>'subscriptionCycleId')::uuid FROM starter_created);
SET LOCAL ROLE service_role;
SELECT is(public.subscription_apply_starter_graduation((result->>'subscriptionId')::uuid,'starter-graduate','full')#>>'{starterGraduation,reason}',
 'graduated','full graduation accepts retained 21-day terms') FROM starter_created;
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM starter_created)),21,'graduation preserves the selected cadence');
SELECT is((SELECT qty FROM public.subscription_lines WHERE subscription_id=(SELECT (result->>'subscriptionId')::uuid FROM starter_created)),2,'graduation replaces standing lines');
CREATE TEMP TABLE starter_after AS SELECT to_jsonb(s) row FROM public.subscriptions s WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM starter_created);
SET LOCAL ROLE service_role;
SELECT is(public.subscription_apply_starter_graduation((result->>'subscriptionId')::uuid,'starter-graduate','full')#>>'{starterGraduation,applied}',
 'false','graduation replay has no second effect') FROM starter_created;
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT is((SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM starter_created)),
 (SELECT row FROM starter_after),'replay preserves the complete subscription');
-- Ordinary creation has no starter marker and retains the quote cadence.
UPDATE starter_probe SET order_id=gen_random_uuid();
INSERT INTO public.commerce_orders(id,client_id,currency,region_code,status) SELECT order_id,client,'XXX','ZZ','draft' FROM starter_probe;
INSERT INTO public.commerce_order_items(order_id,sku_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,product_snapshot)
SELECT order_id,sku,1,500,500,0,500,500,0,'{"sku":"SYNTHETIC-STARTER"}' FROM starter_probe;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE ordinary_created AS SELECT public.subscription_create_provisional_for_checkout(order_id,client,NULL,NULL,'{"quote":{"context":{"cadenceDays":28}}}') result FROM starter_probe;
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM ordinary_created)),28,'ordinary acquisition retains quote cadence');
SELECT is((SELECT starter_pack FROM public.subscriptions WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM ordinary_created)),NULL::jsonb,'ordinary acquisition has no starter marker');
CREATE TEMP TABLE ordinary_before AS SELECT to_jsonb(s) row FROM public.subscriptions s
WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM ordinary_created);
GRANT SELECT ON ordinary_created TO service_role;
SET LOCAL ROLE service_role;
SELECT is(public.subscription_apply_starter_graduation((result->>'subscriptionId')::uuid,'ordinary-graduate','full')#>>'{starterGraduation,reason}',
 'not_a_starter_subscription','ordinary subscription does not graduate') FROM ordinary_created;
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT is((SELECT to_jsonb(s) FROM public.subscriptions s WHERE id=(SELECT (result->>'subscriptionId')::uuid FROM ordinary_created)),
 (SELECT row FROM ordinary_before),'ordinary graduation preserves the complete subscription');
SELECT * FROM finish();
ROLLBACK;
