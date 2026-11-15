BEGIN;
SELECT plan(15);
INSERT INTO public.commerce_operators(id,label) VALUES('ec000000-0000-4000-8000-000000000001','Synthetic operator');
INSERT INTO public.platform_human_principals(principal_id,email) VALUES('ec000000-0000-4000-8000-000000000001','operator@example.invalid');
INSERT INTO public.clients(id,email) VALUES('ec000000-0000-4000-8000-000000000002','customer@example.invalid');
INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata)
VALUES('ec000000-0000-4000-8000-000000000003','ec000000-0000-4000-8000-000000000002','paid','XXX',100,
'{"runtimeFinalize":{"deliveryContact":{"schemaVersion":1,"source":"checkout","revision":1,"recipientName":"Initial","contactEmail":"initial@example.test","contactPhone":"+00001","line1":"Initial 1","line2":null,"city":"Example","postalCode":"00001","country":"ZZ","selectedDelivery":null,"deliveryInstructions":null,"courierInstructions":null}}}');
INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES('ec000000-0000-4000-8000-000000000003',1,1,100,100);
SELECT is(public.commerce_oms_resolve_delivery_contact_v1('ec000000-0000-4000-8000-000000000003')->>'scope','baseline','pre-parcel baseline scope');
SELECT is((SELECT count(*)::integer FROM public.fulfillment_order_contacts),0,'read writes no override');
CREATE TEMP TABLE correction_result AS SELECT public.commerce_oms_update_shipping_address('tap-correction-key','ec000000-0000-4000-8000-000000000003',
'{"recipientName":"Corrected","contactEmail":"corrected@example.test","contactPhone":"+00002","line1":"Corrected 2","city":"Example","postalCode":"00002","country":"zz"}',
'ec000000-0000-4000-8000-000000000001') AS value;
SELECT is((SELECT value#>>'{deliveryContact,revision}' FROM correction_result),'2','one increment');
SELECT is((SELECT value->>'scope' FROM correction_result),'order','order target');
SELECT is((SELECT value#>>'{operation,type}' FROM correction_result),'shipping_address_updated','only correction audit');
SELECT is(public.commerce_oms_resolve_delivery_contact_v1('ec000000-0000-4000-8000-000000000003')->>'scope','order_override','recorded override provenance');
SELECT is(public.commerce_oms_resolve_delivery_contact_v1('ec000000-0000-4000-8000-000000000003')->>'contactDigest',
(SELECT md5(contact::text) FROM public.fulfillment_order_contacts WHERE order_id='ec000000-0000-4000-8000-000000000003'),'exact JSONB digest');
SELECT is(public.commerce_oms_update_shipping_address('tap-correction-key','ec000000-0000-4000-8000-000000000003',
'{"recipientName":"Corrected","contactEmail":"corrected@example.test","contactPhone":"+00002","line1":"Corrected 2","city":"Example","postalCode":"00002","country":"zz"}',
'ec000000-0000-4000-8000-000000000001')->>'result','replayed','retained replay');
SELECT is((SELECT count(*)::integer FROM public.commerce_order_operations WHERE order_id='ec000000-0000-4000-8000-000000000003'),1,'replay writes no operation');
SELECT ok(NOT has_table_privilege('service_role','public.fulfillment_order_contacts','SELECT'),'runtime has no raw order-contact select');
SELECT ok(NOT has_table_privilege('service_role','public.fulfillment_contact_correction_receipts','SELECT'),'runtime has no raw response select');
SELECT ok(has_column_privilege('service_role','public.fulfillment_order_contacts','client_id','SELECT'),'census column only');
SELECT public.fulfillment_erase_parcel_contacts('ec000000-0000-4000-8000-000000000002');
SELECT is((SELECT contact FROM public.fulfillment_order_contacts WHERE order_id='ec000000-0000-4000-8000-000000000003'),NULL::jsonb,'erased order payload');
SELECT is((SELECT response_payload FROM public.fulfillment_contact_correction_receipts WHERE idempotency_key='tap-correction-key'),NULL::jsonb,'erased retained response');
SELECT throws_ok($q$SELECT public.commerce_oms_update_shipping_address('tap-correction-key','ec000000-0000-4000-8000-000000000003',
'{"recipientName":"Corrected","contactEmail":"corrected@example.test","contactPhone":"+00002","line1":"Corrected 2","city":"Example","postalCode":"00002","country":"zz"}',
'ec000000-0000-4000-8000-000000000001')$q$,'55000','fulfillment_contact_erased','erasure prevents personal replay');
SELECT * FROM finish();
ROLLBACK;
