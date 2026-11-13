CREATE FUNCTION pg_temp.reconciliation_fixture(p_provider text,p_subscription boolean DEFAULT false,p_finalize boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); sub uuid; cy uuid; i uuid; a uuid; prepared jsonb;
BEGIN
 INSERT INTO public.clients(id,email) VALUES(c,c||'@example.invalid');
 IF p_subscription THEN
  sub:=gen_random_uuid(); cy:=gen_random_uuid();
  PERFORM pg_temp.provider_subscription_order(sub,cy,o,c,'active');
 ELSE PERFORM pg_temp.provider_order(o,c,12999); END IF;
 i:=(pg_temp.provider_intent('intent:'||o,CASE WHEN p_subscription THEN 'subscription_cycle' ELSE 'one_time_order' END,
  o,sub,cy,12999,'XXX','{}')#>>'{paymentIntent,id}')::uuid;
 prepared:=public.payment_provider_attempt_prepare('prepare:'||o,i,p_provider,'provider:'||o,repeat('a',64),
  CASE WHEN p_subscription THEN 'off_session_payment' ELSE 'one_time_payment' END,NULL,'{}');
 a:=(prepared#>>'{paymentAttempt,id}')::uuid;
 IF p_finalize THEN PERFORM public.payment_provider_attempt_finalize('finalize:'||o,i,a,'provider:'||o,repeat('a',64),
  'charge_'||a,NULL,'processing',NULL,'{}','{}'); END IF;
 RETURN jsonb_build_object('client',c,'order',o,'intent',i,'attempt',a,'provider',p_provider,'subscription',sub,'cycle',cy);
END; $$;
CREATE FUNCTION pg_temp.refund_observe(f jsonb,k text,amount bigint,cur text DEFAULT 'XXX',thin boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e uuid; snapshot jsonb;
BEGIN
 snapshot:=CASE WHEN thin THEN '{}'::jsonb ELSE jsonb_build_object('eventType','charge.refunded',
  'providerPaymentId','charge_'||(f->>'attempt'),'stripeRefundSnapshot',jsonb_build_object('chargeId','operation:'||(f->>'attempt'),'amountRefundedMinor',amount)) END;
 e:=(public.payment_provider_event_ingest(f->>'provider',k,'payment.refunded','charge_'||(f->>'attempt'),
  (f->>'intent')::uuid,(f->>'attempt')::uuid,CASE WHEN f->>'provider'='stripe' THEN 12999 ELSE amount::integer END,
  cur,true,snapshot)#>>'{paymentEvent,id}')::uuid;
 RETURN pg_temp.provider_apply('apply:'||k,(f->>'intent')::uuid,e,CASE WHEN amount=12999 THEN 'refunded' ELSE 'partially_refunded' END,
  '2026-11-13T12:00:00Z',NULL);
END; $$;
CREATE TEMP TABLE proof_fixture(name text PRIMARY KEY,f jsonb);
INSERT INTO proof_fixture VALUES('capture',pg_temp.reconciliation_fixture('stripe')),
 ('delta',pg_temp.reconciliation_fixture('tpay')),('renewal',pg_temp.reconciliation_fixture('stripe',true)),
 ('prepared',pg_temp.reconciliation_fixture('stripe',true,false)),('interactive',pg_temp.reconciliation_fixture('tpay',false,false));
SELECT pg_temp.provider_apply('capture:'||(f->>'order'),(f->>'intent')::uuid,NULL,'succeeded','2026-11-13T12:00:00Z',NULL)
 FROM proof_fixture WHERE name IN ('capture','delta','renewal');

CREATE FUNCTION pg_temp.refund_input(f jsonb,k text,amount integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('provider',f->>'provider','providerEventId',k,'eventType','payment.refunded',
  'providerPaymentId','charge_'||(f->>'attempt'),'paymentIntentId',f->>'intent','paymentAttemptId',f->>'attempt',
  'amountMinor',12999,'currency','XXX','occurredAt','2026-11-13T12:00:00Z',
  'rawPayload',jsonb_build_object('eventType','charge.refunded','providerPaymentId','charge_'||(f->>'attempt'),
   'stripeRefundSnapshot',jsonb_build_object('chargeId','operation:'||(f->>'attempt'),'amountRefundedMinor',amount)));
$$;
