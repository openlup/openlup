-- Terminalized business state and retained financial evidence are separate.
BEGIN;
SELECT no_plan();
CREATE FUNCTION pg_temp.finality_snapshot(s uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(
  (SELECT to_jsonb(x) FROM public.subscriptions x WHERE id=s),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.commerce_settlement_intents x
    WHERE order_id IN (SELECT id FROM public.commerce_orders WHERE subscription_cycle_id IN (SELECT id FROM public.subscription_cycles WHERE subscription_id=s))),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.subscription_cycles x WHERE subscription_id=s),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.commerce_orders x WHERE subscription_cycle_id IN (SELECT id FROM public.subscription_cycles WHERE subscription_id=s)),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.subscription_events x WHERE subscription_id=s),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.subscription_dunning_cases x WHERE subscription_id=s),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.subscription_dunning_notifications x WHERE subscription_id=s),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.subscription_retry_obligations x WHERE subscription_id=s),
  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.subscription_retry_receipts x WHERE obligation_id IN
    (SELECT id FROM public.subscription_retry_obligations WHERE subscription_id=s))
 );
$$;
CREATE FUNCTION pg_temp.check_provider_finality(terminal text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
 c uuid:=gen_random_uuid();s uuid:=gen_random_uuid();cy uuid:=gen_random_uuid();o uuid:=gen_random_uuid();
 i uuid;a uuid;e uuid;pay uuid;success uuid;k text:='finality:'||s;r jsonb;before_state jsonb;
 t timestamptz:='2026-11-13T12:00:00Z';st text;writer text;key text;label text;fingerprint text;reviewed_state jsonb;
BEGIN
 INSERT INTO public.clients(id,email) VALUES(c,c||'@example.invalid');
 PERFORM pg_temp.provider_subscription_order(s,cy,o,c,'active');
 i:=(pg_temp.provider_intent(k||':intent','subscription_cycle',o,s,cy,12999,'XXX','{}')#>>'{paymentIntent,id}')::uuid;
 a:=(public.payment_provider_attempt_record(k||':attempt',i,'card_rail','pi_'||s,NULL,'processing',NULL,'{}','{}')#>>'{paymentAttempt,id}')::uuid;
 PERFORM pg_temp.provider_apply(k||':first',i,NULL,'failed',t,'declined','hard_do_not_retry','fixture');
 SELECT payment_id INTO pay FROM public.payment_provider_states WHERE id=i;
 UPDATE public.subscription_cycles SET status=terminal WHERE id=cy;
 UPDATE public.commerce_orders SET status='cancelled' WHERE id=o;
 UPDATE public.commerce_settlement_intents SET status='cancelled' WHERE id=i;
 UPDATE public.payment_provider_states SET status='cancelled' WHERE id=i;
 before_state:=pg_temp.finality_snapshot(s);
 success:=(public.payment_provider_event_ingest('card_rail',k||':success','payment.succeeded','pi_'||s,i,a,12999,'XXX',true,
  jsonb_build_object('__paymentTruth',jsonb_build_object('fingerprint',repeat('e',64),'capturedAmountBasis','provider_capture_v1')))#>>'{paymentEvent,id}')::uuid;
 FOREACH st IN ARRAY ARRAY['failed','expired'] LOOP
  FOREACH writer IN ARRAY ARRAY['renewal','webhook'] LOOP
   key:=k||':'||st||':'||writer;label:=terminal||'/'||st||'/'||writer;e:=NULL;
   IF writer='webhook' THEN
    e:=(public.payment_provider_event_ingest('card_rail',key,'payment.failed','pi_'||s,i,a,12999,'XXX',true,'{}')#>>'{paymentEvent,id}')::uuid;
   END IF;
   r:=pg_temp.provider_apply(key,i,e,st,t,'late_decline','hard_do_not_retry','fixture');
   RETURN NEXT is(r#>>'{paymentResult,kind}','ignored_failure_terminalized_cycle',label||': ignored business outcome');
   RETURN NEXT is((SELECT status FROM public.payment_provider_states WHERE id=i),'cancelled',label||': intent cancellation fence retained');
   RETURN NEXT is((SELECT status FROM public.payment_provider_attempts WHERE id=a),st,label||': attempt evidence');
   RETURN NEXT is((SELECT payment_status FROM public.payment_provider_states WHERE payment_id=pay),st,label||': payment evidence');
   RETURN NEXT is((SELECT failure_class FROM public.payment_provider_attempts WHERE id=a),'hard_do_not_retry',label||': classification retained');
   RETURN NEXT is((SELECT count(*) FROM public.payment_provider_transitions WHERE payment_attempt_id=a AND idempotency_key=key||':payment_result'
    AND to_status=st AND reason='ignored_failure_terminalized_cycle'),1::bigint,label||': transition evidence');
   RETURN NEXT is((SELECT status FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=key),'completed',label||': completed idempotency evidence');
   RETURN NEXT is(pg_temp.finality_snapshot(s),before_state,label||': cycle/order/retries/schedule/lifecycle/events/dunning unchanged');
   IF e IS NOT NULL THEN
    RETURN NEXT is((SELECT processing_status FROM public.payment_provider_attempt_evidence WHERE id=e),'ignored',label||': inbound failure evidence acknowledged');
   END IF;
   SELECT request_fingerprint INTO fingerprint FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=key;
   r:=pg_temp.provider_apply(key,i,e,st,t,'late_decline','hard_do_not_retry','fixture');
   RETURN NEXT is(r#>>'{paymentResult,replayed}','true',label||': same key replays');
   RETURN NEXT is((SELECT request_fingerprint FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=key),fingerprint,label||': fingerprint unchanged');
  END LOOP;
 END LOOP;
 r:=pg_temp.provider_apply(k||':late-success',i,success,'succeeded',t,NULL);
 RETURN NEXT is(r#>>'{paymentResult,kind}','ignored_success_requiring_review',terminal||': capture retained for review');
 RETURN NEXT is((SELECT count(*) FROM public.payment_truth_events e WHERE e.settlement_intent_id=i
   AND e.source_evidence->>'sourceReference'=success::text AND e.state='open' AND e.outcome='captured'
   AND e.review_required_at IS NOT NULL AND e.settlement_transition_id IS NULL),1::bigint,terminal||': exact durable review without settlement');
 RETURN NEXT is(pg_temp.finality_snapshot(s),before_state,terminal||': reviewed success leaves business untouched');
 SELECT jsonb_build_array(p_attempt,p_state) INTO reviewed_state FROM public.payment_provider_attempts p_attempt
  JOIN public.payment_provider_states p_state ON p_state.id=p_attempt.settlement_intent_id WHERE p_attempt.id=a;
 FOREACH st IN ARRAY ARRAY['failed','expired'] LOOP
  key:=k||':reviewed:'||st;label:=terminal||'/reviewed/'||st;
  r:=pg_temp.provider_apply(key,i,NULL,st,t,'late_decline','authorization_refused','fixture');
  RETURN NEXT is(r#>>'{paymentResult,kind}','ignored_failure_protected_state',label||': late failure leaves review authoritative');
  RETURN NEXT is((SELECT jsonb_build_array(p_attempt,p_state) FROM public.payment_provider_attempts p_attempt
    JOIN public.payment_provider_states p_state ON p_state.id=p_attempt.settlement_intent_id WHERE p_attempt.id=a),
    reviewed_state,label||': provider state, attempt and classification unchanged');
  RETURN NEXT is(pg_temp.finality_snapshot(s),before_state,label||': no lifecycle or business changes');
  r:=pg_temp.provider_apply(key,i,NULL,st,t,'late_decline','authorization_refused','fixture');
  RETURN NEXT is(r#>>'{paymentResult,replayed}','true',label||': exact negative receipt replays');
 END LOOP;
END; $$;
SELECT * FROM pg_temp.check_provider_finality('cancelled');
SELECT * FROM pg_temp.check_provider_finality('skipped');
SELECT * FROM finish();
ROLLBACK;
