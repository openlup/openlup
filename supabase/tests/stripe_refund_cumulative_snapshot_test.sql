-- pgTAP: real payment-control writer accepts cumulative cumulative provider snapshots once.
-- Refused evidence is retained without changing canonical state or projections.
BEGIN;
SELECT plan(23);
-- Bind the cumulative provider branch of the exact F17 applicator installed by this test profile.
CREATE TEMP TABLE refund_settings AS SELECT
 (regexp_match(pg_get_functiondef('public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)'::regprocedure),
  $binding$IF v_event.provider = '([^']+)' AND p_result_status IN$binding$))[1] AS provider;
CREATE TEMP TABLE refund_fixtures(label text PRIMARY KEY, order_id uuid, intent_id uuid, payment_id uuid);
INSERT INTO public.clients(id,email) VALUES('9f110000-0000-4000-8000-000000000001','refund-snapshot@example.invalid');
INSERT INTO public.communication_contacts(id,normalized_email,display_email)
VALUES('9f110000-0000-4000-8000-000000000002','refund-snapshot@example.invalid','refund-snapshot@example.invalid');
INSERT INTO public.communication_contact_links(contact_id,source_table,source_id)
VALUES('9f110000-0000-4000-8000-000000000002','clients','9f110000-0000-4000-8000-000000000001');
CREATE FUNCTION pg_temp.seed_refund(p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o uuid:=gen_random_uuid(); i jsonb;
BEGIN
 INSERT INTO public.commerce_orders(id,client_id,status,mode,currency,total_cents,subtotal_cents)
 VALUES(o,'9f110000-0000-4000-8000-000000000001','draft','one_time','XTS',10000,10000);
 INSERT INTO public.commerce_order_items(order_id,quantity,unit_price_cents,total_cents,discount_allocated_cents,effective_total_cents,effective_net_cents,vat_rate_bps,product_snapshot)
 VALUES(o,1,10000,10000,0,10000,round(10000::numeric*10000/(10000+800))::integer,800,'{"title":"Refund proof","vatRate":"8"}');
 i:=public.commerce_payment_control_create_intent('refund-snapshot:'||p_label||':intent','one_time_order',o,NULL,NULL,10000,'XTS','{}');
 INSERT INTO refund_fixtures VALUES(p_label,o,(i#>>'{paymentIntent,id}')::uuid,(i#>>'{paymentIntent,paymentId}')::uuid);
 PERFORM public.commerce_payment_control_record_attempt('refund-snapshot:'||p_label||':attempt',(i#>>'{paymentIntent,id}')::uuid,
 (SELECT provider FROM refund_settings),'pi_snapshot_'||p_label,NULL,'processing',NULL,'{}','{}');
 PERFORM public.commerce_payment_control_apply_result('refund-snapshot:'||p_label||':paid',(i#>>'{paymentIntent,id}')::uuid,NULL,'succeeded',now(),NULL);
END $$;
CREATE FUNCTION pg_temp.refund_event(p_label text,p_identity text,p_snapshot jsonb,p_currency text DEFAULT 'XTS',p_amount integer DEFAULT 10000,p_payment text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f refund_fixtures%ROWTYPE; r jsonb; payment text;
BEGIN
 SELECT * INTO f FROM refund_fixtures WHERE label=p_label;
 payment:=COALESCE(p_payment,'pi_snapshot_'||p_label);
 r:=public.commerce_payment_control_ingest_event((SELECT provider FROM refund_settings),p_identity,'payment.refunded',payment,f.intent_id,NULL,p_amount,p_currency,true,
 jsonb_build_object('eventType','charge.refunded','providerPaymentId',payment,
 'stripeRefundSnapshot',jsonb_build_object('chargeId','ch_snapshot_'||p_label,'amountRefundedMinor',p_snapshot)));
 RETURN (r#>>'{paymentEvent,id}')::uuid;
END $$;
CREATE FUNCTION pg_temp.apply_refund(p_label text,p_event text,p_status text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.commerce_payment_control_apply_result('refund-snapshot:apply:'||p_event,f.intent_id,e.id,p_status,'2026-10-09T10:00:00Z',NULL)
 FROM refund_fixtures f JOIN public.inbound_provider_events e ON e.provider_event_id=p_event AND e.provider=(SELECT provider FROM refund_settings) WHERE f.label=p_label;
$$;
CREATE FUNCTION pg_temp.refund_truth(p_label text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('order',o.status,'intent',i.status,'payment',p.status,
 'notices',(SELECT count(*) FROM public.outbox_events WHERE aggregate_id=o.id AND event_type='commerce.order.refunded'),
 'amount',(SELECT payload->'refundCents' FROM public.outbox_events WHERE aggregate_id=o.id AND event_type='commerce.order.refunded'))
 FROM refund_fixtures f JOIN public.commerce_orders o ON o.id=f.order_id JOIN public.commerce_payment_intents i ON i.id=f.intent_id
 JOIN public.commerce_payments p ON p.id=i.payment_id WHERE f.label=p_label;
$$;
SELECT pg_temp.seed_refund('partial_first');
SELECT pg_temp.seed_refund('full_first');
SELECT pg_temp.refund_event('partial_first','snapshot-partial','3000');
SELECT pg_temp.apply_refund('partial_first','snapshot-partial','partially_refunded');
SELECT is(pg_temp.refund_truth('partial_first'),'{"order":"paid","intent":"partially_refunded","payment":"partially_refunded","notices":0,"amount":null}'::jsonb,'partial does not claim a full refund or refund notice');
SELECT pg_temp.refund_event('partial_first','snapshot-partial-equal-new-id','3000');
SELECT is(pg_temp.apply_refund('partial_first','snapshot-partial-equal-new-id','partially_refunded')#>>'{paymentResult,kind}','ignored_stripe_refund_snapshot','equal partial under a new event identity is ignored');
SELECT is((SELECT processing_status FROM public.inbound_provider_events WHERE provider_event_id='snapshot-partial-equal-new-id'),'ignored','equal fact is retained as ignored');
SELECT pg_temp.refund_event('partial_first','snapshot-full','10000');
SELECT pg_temp.apply_refund('partial_first','snapshot-full','refunded');
SELECT is(pg_temp.refund_truth('partial_first'),'{"order":"refunded","intent":"refunded","payment":"refunded","notices":1,"amount":10000}'::jsonb,'partial3000 then full10000 projects exactly10000 to the refund notice');
SELECT is((SELECT e.payload->>'refundEvidenceVersion' FROM public.outbox_events e JOIN refund_fixtures f ON f.order_id=e.aggregate_id WHERE f.label='partial_first' AND e.event_type='commerce.order.refunded'),'provider-refund.v2','actual cumulative provider producer marks the amount as validated provider evidence');
SELECT is((SELECT amount_cents FROM public.inbound_provider_events WHERE provider_event_id='snapshot-partial'),10000,'original Charge amount stays stored for validation');
SELECT is((SELECT (payload#>>'{stripeRefundSnapshot,amountRefundedMinor}')::int FROM public.inbound_provider_events WHERE provider_event_id='snapshot-partial'),3000,'cumulative refund amount remains separate');
SELECT pg_temp.refund_event('partial_first','snapshot-full-equal-new-id','10000');
SELECT is(pg_temp.apply_refund('partial_first','snapshot-full-equal-new-id','refunded')#>>'{paymentResult,kind}','ignored_stripe_refund_snapshot','equal full under another identity has no new effect');
SELECT is(pg_temp.apply_refund('partial_first','snapshot-full-equal-new-id','refunded')#>>'{paymentResult,replayed}','true','ignored snapshot has ordinary durable key replay');
SELECT pg_temp.refund_event('full_first','snapshot-new-full','10000');
SELECT pg_temp.apply_refund('full_first','snapshot-new-full','refunded');
SELECT pg_temp.refund_event('full_first','snapshot-unseen-old-partial','3000');
SELECT is(pg_temp.apply_refund('full_first','snapshot-unseen-old-partial','partially_refunded')#>>'{paymentResult,status}','refunded','unseen older partial returns the actual canonical full status');
SELECT is(pg_temp.refund_truth('full_first'),'{"order":"refunded","intent":"refunded","payment":"refunded","notices":1,"amount":10000}'::jsonb,'unseen older partial leaves full money and effects intact');
SELECT is((SELECT t.to_status FROM public.commerce_payment_state_transitions t JOIN public.inbound_provider_events e ON e.id=t.provider_event_id WHERE e.provider_event_id='snapshot-unseen-old-partial'),'refunded','ignored transition records the actual canonical destination');
SELECT pg_temp.refund_event('full_first','snapshot-wrong-currency','3000','EUR');
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-wrong-currency','partially_refunded')$$,'22023','payment_control_result_currency_mismatch','wrong refund currency is refused');
SELECT pg_temp.refund_event('full_first','snapshot-wrong-original','10000','XTS',9999);
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-wrong-original','refunded')$$,'22023','payment_control_result_amount_mismatch','cumulative provider original amount parity remains enforced');
SELECT pg_temp.refund_event('full_first','snapshot-missing',NULL);
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-missing','refunded')$$,'22023','payment_control_result_refund_snapshot_unproven','missing snapshot cannot prove a full refund');
SELECT pg_temp.refund_event('full_first','snapshot-string','"10000"');
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-string','refunded')$$,'22023','payment_control_result_refund_snapshot_unproven','string snapshot is refused');
SELECT pg_temp.refund_event('full_first','snapshot-excess','10001');
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-excess','refunded')$$,'22023','payment_control_result_refund_snapshot_unproven','snapshot greater than original charge is refused');
SELECT pg_temp.refund_event('full_first','snapshot-not-full','3000');
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-not-full','refunded')$$,'22023','payment_control_result_refund_snapshot_unproven','partial financial evidence cannot request a full result');
SELECT pg_temp.refund_event('full_first','snapshot-unlinked','10000','XTS',10000,'pi_unknown_snapshot');
SELECT throws_ok($$SELECT pg_temp.apply_refund('full_first','snapshot-unlinked','refunded')$$,'22023','payment_control_result_attempt_unresolved','provider identity must resolve to the exact attempt');
SELECT is((SELECT count(*)::int FROM public.inbound_provider_events WHERE provider_event_id IN ('snapshot-wrong-currency','snapshot-wrong-original','snapshot-missing','snapshot-string','snapshot-excess','snapshot-not-full','snapshot-unlinked') AND processing_status='received'),7,'all refused source rows remain inspectable and unapplied');
SELECT is(pg_temp.refund_truth('full_first'),'{"order":"refunded","intent":"refunded","payment":"refunded","notices":1,"amount":10000}'::jsonb,'all refusals preserve canonical states and exact money/effect readback');
SELECT ok(NOT has_function_privilege('anon','public.commerce_order_provider_refund_evidence(uuid)','EXECUTE'),'anonymous callers cannot read financial evidence');
SELECT ok(NOT has_function_privilege('authenticated','public.commerce_order_provider_refund_evidence(uuid)','EXECUTE'),'browser callers cannot read financial evidence');
SELECT * FROM finish();
ROLLBACK;
