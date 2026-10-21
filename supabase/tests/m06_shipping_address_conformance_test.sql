-- Missing subsets only: own address mutations/defaults, frozen destination after
-- address-book edits, and the current flat-rate table authority. No new writer.
BEGIN;
SELECT plan(12);
INSERT INTO auth.users(id) VALUES ('f7100000-0000-4000-8000-000000000001');
INSERT INTO public.clients(id,email,auth_user_id) VALUES
 ('f7200000-0000-4000-8000-000000000001','shipping-proof@example.invalid','f7100000-0000-4000-8000-000000000001');
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"sub":"f7100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($q$ INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country,is_default)
 VALUES ('f7300000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001','shipping','Original 1','Example City','10000','ZZ',true) $q$,
 'own-session address insert is allowed');
SELECT is((SELECT is_default FROM public.addresses WHERE id='f7300000-0000-4000-8000-000000000001'),true,'default flag reads back');
SELECT lives_ok($q$ UPDATE public.addresses SET line1='Edited 2' WHERE id='f7300000-0000-4000-8000-000000000001' $q$,'own-session address update is allowed');
SELECT is((SELECT line1 FROM public.addresses WHERE id='f7300000-0000-4000-8000-000000000001'),'Edited 2','own update reads back');
SELECT lives_ok($q$
 UPDATE public.addresses SET is_default=false WHERE client_id='f7200000-0000-4000-8000-000000000001' AND kind IN ('shipping','both');
 INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country,is_default)
 VALUES ('f7300000-0000-4000-8000-000000000002','f7200000-0000-4000-8000-000000000001','shipping','Default 3','Example City','10000','ZZ',true)
 $q$,'selected default can be replaced with the incumbent clear-then-insert sequence');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE client_id='f7200000-0000-4000-8000-000000000001' AND is_default),1,'one selected default remains');
SELECT lives_ok($q$ DELETE FROM public.addresses WHERE id='f7300000-0000-4000-8000-000000000002' $q$,'own-session unused address delete is allowed');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE id='f7300000-0000-4000-8000-000000000002'),0,'deleted address stays absent on readback');
RESET ROLE;
INSERT INTO public.commerce_orders(id,client_id,status,mode,shipping_address_id,currency,region_code)
 VALUES ('f7400000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001','paid','one_time','f7300000-0000-4000-8000-000000000001','XTS','ZZ');
INSERT INTO public.commerce_fulfillment_orders(id,order_id,client_id,shipping_address_id,create_idempotency_key,status,shipping_address_snapshot)
 VALUES ('f7500000-0000-4000-8000-000000000001','f7400000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001','f7300000-0000-4000-8000-000000000001','m06-frozen-destination','packed','{"line1":"Edited 2","selectedDelivery":{"pickupPoint":{"id":"POINT-1"}}}');
SET LOCAL ROLE authenticated;
UPDATE public.addresses SET line1='Later 4' WHERE id='f7300000-0000-4000-8000-000000000001';
RESET ROLE;
SELECT is((SELECT shipping_address_snapshot->>'line1' FROM public.commerce_fulfillment_orders WHERE id='f7500000-0000-4000-8000-000000000001'),'Edited 2','address-book edits preserve the frozen parcel destination');
SELECT is((SELECT shipping_address_snapshot #>> '{selectedDelivery,pickupPoint,id}' FROM public.commerce_fulfillment_orders WHERE id='f7500000-0000-4000-8000-000000000001'),'POINT-1','frozen selection evidence survives the address-book edit');
-- Honest current matrix: service-role table authority is not granted by the
-- shipped chain. This is a pending host-support gate, never a support PASS.
SET LOCAL ROLE service_role;
SELECT throws_ok($q$ SELECT value_minor FROM public.commerce_settings WHERE key='shipping_flat_minor' $q$,'42501',NULL,'current runtime flat-rate read refuses absent table authority');
SELECT throws_ok($q$ UPDATE public.commerce_settings SET value_minor=900 WHERE key='shipping_flat_minor' $q$,'42501',NULL,'current runtime flat-rate write refuses absent table authority');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
