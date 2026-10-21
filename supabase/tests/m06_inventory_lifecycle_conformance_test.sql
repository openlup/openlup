-- Missing lifecycle boundary: actual consumption replay and full payment-control refund.
-- Batch rollback, paid reacquisition and cancellation reuse the existing witnesses.
BEGIN;
SELECT plan(9);
INSERT INTO public.clients(id,email) VALUES ('f7000000-0000-4000-8000-000000000001','m06-lifecycle@example.invalid');
INSERT INTO public.catalog_products(id,slug,name,status) VALUES ('f7000000-0000-4000-8000-000000000002','m06-lifecycle','Fixture','active');
INSERT INTO public.catalog_skus(id,product_id,sku,title,pet_type,status,net_weight_g,kcal_per_unit)
VALUES ('f7000000-0000-4000-8000-000000000003','f7000000-0000-4000-8000-000000000002','M06-LIFECYCLE','Fixture','other','active',1,1);
INSERT INTO public.inventory_locations(id,code,display_name,kind,status,fulfillable)
VALUES ('f7000000-0000-4000-8000-000000000004','m06-lifecycle','Fixture','internal_warehouse','active',true);
INSERT INTO public.commerce_orders(id,client_id,status,mode,currency,total_cents,subtotal_cents)
VALUES ('f7000000-0000-4000-8000-000000000005','f7000000-0000-4000-8000-000000000001','paid','one_time','XTS',100,100);
INSERT INTO public.inventory_balances(sku_id,location_id,on_hand,reserved)
VALUES ('f7000000-0000-4000-8000-000000000003','f7000000-0000-4000-8000-000000000004',10,2);
INSERT INTO public.inventory_reservations(id,idempotency_key,order_id,sku_id,location_id,quantity,status,kind,expires_at)
VALUES ('f7000000-0000-4000-8000-000000000006','m06-lifecycle-reservation','f7000000-0000-4000-8000-000000000005','f7000000-0000-4000-8000-000000000003','f7000000-0000-4000-8000-000000000004',2,'reserved','checkout_payment_window',NULL);
INSERT INTO public.commerce_payments(id,order_id,provider,status,amount_cents,currency)
VALUES ('f7000000-0000-4000-8000-000000000007','f7000000-0000-4000-8000-000000000005','synthetic_runtime','succeeded',100,'XTS');
INSERT INTO public.commerce_payment_intents(id,target_kind,order_id,payment_id,status,amount_cents,currency)
VALUES ('f7000000-0000-4000-8000-000000000008','one_time_order','f7000000-0000-4000-8000-000000000005','f7000000-0000-4000-8000-000000000007','succeeded',100,'XTS');
INSERT INTO public.commerce_payment_attempts(id,payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
VALUES ('f7000000-0000-4000-8000-000000000009','f7000000-0000-4000-8000-000000000008','f7000000-0000-4000-8000-000000000007','synthetic_runtime','m06-lifecycle-attempt','succeeded',100,'XTS');
UPDATE public.commerce_payment_intents SET active_attempt_id='f7000000-0000-4000-8000-000000000009' WHERE id='f7000000-0000-4000-8000-000000000008';
INSERT INTO public.inbound_provider_events(id,provider,provider_event_id,event_type,payment_intent_id,payment_attempt_id,amount_cents,currency,payload)
VALUES ('f7000000-0000-4000-8000-000000000010','synthetic_runtime','m06-lifecycle-refund-event','payment.refunded','f7000000-0000-4000-8000-000000000008','f7000000-0000-4000-8000-000000000009',100,'XTS','{}');
SET LOCAL ROLE service_role;
SELECT is(public.inventory_consume_reservation_for_fulfillment('m06-lifecycle-consume','f7000000-0000-4000-8000-000000000006','{}')->>'replayed','false','runtime consumes the paid hold');
SELECT is(public.inventory_consume_reservation_for_fulfillment('m06-lifecycle-consume','f7000000-0000-4000-8000-000000000006','{}')->>'replayed','true','consume replay is a no-op');
SELECT lives_ok($$SELECT public.commerce_payment_control_apply_result('m06-lifecycle-refund','f7000000-0000-4000-8000-000000000008','f7000000-0000-4000-8000-000000000010','refunded',now(),NULL)$$,'actual full-refund result applies under runtime authority');
SELECT is(public.commerce_payment_control_apply_result('m06-lifecycle-refund','f7000000-0000-4000-8000-000000000008','f7000000-0000-4000-8000-000000000010','refunded',now(),NULL)#>>'{paymentResult,replayed}','true','full-refund replay is a no-op');
RESET ROLE;
SELECT is((SELECT status FROM public.commerce_orders WHERE id='f7000000-0000-4000-8000-000000000005'),'refunded','actual one-time order is refunded');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id='f7000000-0000-4000-8000-000000000006'),'consumed','refund cannot resurrect consumed reservation');
SELECT is((SELECT on_hand::text||'/'||reserved::text FROM public.inventory_balances WHERE sku_id='f7000000-0000-4000-8000-000000000003'),'8/0','consumption and refund conserve stock without resurrection');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE reservation_id='f7000000-0000-4000-8000-000000000006'),1,'consume/refund replay adds no stock movement');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_state_transitions WHERE payment_intent_id='f7000000-0000-4000-8000-000000000008' AND transition_kind='refund'),1,'one durable refund transition');
SELECT * FROM finish();
ROLLBACK;
