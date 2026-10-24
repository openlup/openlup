-- M10 consumes existing managed alignment: max arrival plus cadence, never stacked.
BEGIN;
SELECT plan(10);
SET LOCAL ROLE service_role;
SELECT public.subscription_delivery_alignment_set_mode('auto_align');
RESET ROLE;
INSERT INTO public.clients(id,email) VALUES('e3100000-0000-4000-8000-000000000001','managed-arrival@example.invalid');
INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code,country)
VALUES('e3200000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000001','shipping','Example 1','Example City','00-001','ZZ');
INSERT INTO public.subscriptions(id,client_id,shipping_address_id,cadence_days,currency,status,next_cycle_at)
VALUES('e3300000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000001','e3200000-0000-4000-8000-000000000001',28,'XTS','active','2030-01-29Z');
INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,paid_at,engine_idempotency_key)
VALUES('e3400000-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000001',1,'2030-01-01Z','paid','2030-01-01Z','managed-arrival-cycle');
INSERT INTO public.commerce_orders(id,client_id,shipping_address_id,status,currency,total_cents,subtotal_cents,mode,subscription_id,subscription_cycle_id)
VALUES('e3500000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000001','e3200000-0000-4000-8000-000000000001','paid','XTS',1000,1000,'subscription_cycle','e3300000-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000001');
UPDATE public.subscription_cycles SET order_id='e3500000-0000-4000-8000-000000000001' WHERE id='e3400000-0000-4000-8000-000000000001';
INSERT INTO public.commerce_fulfillment_orders(id,order_id,client_id,shipping_address_id,create_idempotency_key,status,shipping_address_snapshot)
VALUES('e3600000-0000-4000-8000-000000000001','e3500000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000001','e3200000-0000-4000-8000-000000000001','managed-arrival-first','in_transit','{}');
INSERT INTO public.commerce_fulfillment_orders(id,order_id,client_id,shipping_address_id,create_idempotency_key,status,shipping_address_snapshot,sequence_no,replaces_fulfillment_order_id,replacement_reason)
VALUES('e3600000-0000-4000-8000-000000000002','e3500000-0000-4000-8000-000000000001','e3100000-0000-4000-8000-000000000001','e3200000-0000-4000-8000-000000000001','managed-arrival-second','in_transit','{}',1,'e3600000-0000-4000-8000-000000000001','other');
SET LOCAL ROLE service_role;
SELECT is(public.subscription_delivery_alignment_admit_renewal('e3300000-0000-4000-8000-000000000001','2030-01-29Z','2030-01-30Z')->>'allowed','false','outstanding predecessor blocks successor');
-- Roll the global mode back after capture; the original obligation retains authority.
SELECT public.subscription_delivery_alignment_set_mode('off');
SELECT is(public.subscription_delivery_alignment_admit_renewal('e3300000-0000-4000-8000-000000000001','2030-01-29Z','2030-01-30Z')->>'allowed','false',
 'captured protection survives rollback to off');
RESET ROLE;
SELECT is((SELECT status FROM public.subscriptions WHERE id='e3300000-0000-4000-8000-000000000001'),'active','rollback never pauses active service');
UPDATE public.commerce_fulfillment_orders SET delivered_at='2030-02-01Z' WHERE id='e3600000-0000-4000-8000-000000000001';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='e3300000-0000-4000-8000-000000000001'),'2030-01-29Z'::timestamptz,'predecessor arrival cannot settle the outstanding replacement');
UPDATE public.commerce_fulfillment_orders SET delivered_at='2030-02-03Z' WHERE id='e3600000-0000-4000-8000-000000000002';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='e3300000-0000-4000-8000-000000000001'),'2030-03-03Z'::timestamptz,'latest actual arrival extends by one cadence');
SELECT is((SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id='e3300000-0000-4000-8000-000000000001'),1,'alignment never stacks a new cycle');
UPDATE public.commerce_fulfillment_orders SET delivered_at='2030-02-03Z' WHERE id='e3600000-0000-4000-8000-000000000002';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='e3300000-0000-4000-8000-000000000001'),'2030-03-03Z'::timestamptz,'arrival replay never adds another cadence');
UPDATE public.subscriptions SET next_cycle_at='2030-04-01Z' WHERE id='e3300000-0000-4000-8000-000000000001';
UPDATE public.commerce_fulfillment_orders SET delivered_at='2030-02-04Z' WHERE id='e3600000-0000-4000-8000-000000000002';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='e3300000-0000-4000-8000-000000000001'),'2030-04-01Z'::timestamptz,'later schedule remains monotonic after corrected arrival');
SELECT is((SELECT status FROM public.subscriptions WHERE id='e3300000-0000-4000-8000-000000000001'),'active','arrival never pauses the subscription');
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id='e3300000-0000-4000-8000-000000000001'),1,'alignment creates no extra order');
SELECT * FROM finish();
ROLLBACK;
