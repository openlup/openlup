-- Forward 3-rung retry cadence (p_cadence) through payment_provider_result_apply
-- to subscription_retry_apply_failure while preserving the 3-rung exhaustion invariant
-- (retry_attempt >= 4), default [24, 72, 168] schedule, and immutable receipt replay.
-- openlup:allow-grant: trusted service-role execution for the new cadence overload; PUBLIC/anon/authenticated remain revoked.

CREATE FUNCTION public.payment_provider_result_apply(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text,
 p_dunning_template_slug text,p_recovery_url_path text,p_recovery_template_slug text,p_cadence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE fingerprint text; legacy_fingerprint text; receipt public.payment_provider_receipts%ROWTYPE;
 i public.commerce_settlement_intents%ROWTYPE; s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE; e public.payment_provider_attempt_evidence%ROWTYPE;
 o public.commerce_orders%ROWTYPE; kind text:='state_changed'; answer jsonb; truth jsonb; evidence jsonb;
 outcome text; native_failure text; from_status text; held record; recovery_token text; recovery_expires_at timestamptz;
 renewal public.subscription_renewal_operations%ROWTYPE; retry_preparation public.subscription_retry_receipts%ROWTYPE;
 retry_obligation public.subscription_retry_obligations%ROWTYPE;
 retry_sequence integer; logical_cycle integer; retry_result jsonb; expiry_escalation boolean:=false; handoff jsonb;
 capture_requires_review boolean:=false; already_applied_expiry boolean:=false;
 cadence_item jsonb; cadence_hours numeric;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR length(p_idempotency_key)<8
  OR p_payment_intent_id IS NULL OR p_result_status IS NULL OR p_result_status NOT IN ('succeeded','failed','expired','refunded','partially_refunded','disputed')
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_cadence IS NOT NULL THEN
  IF jsonb_typeof(p_cadence) IS DISTINCT FROM 'object'
   OR (p_cadence - 'backoffHours') <> '{}'::jsonb
   OR jsonb_typeof(p_cadence->'backoffHours') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_cadence->'backoffHours') <> 3 THEN
   RAISE EXCEPTION 'subscription_retry_cadence_invalid' USING ERRCODE='22023'; END IF;
  FOR cadence_item IN SELECT value FROM jsonb_array_elements(p_cadence->'backoffHours') LOOP
   IF jsonb_typeof(cadence_item) <> 'number' THEN
    RAISE EXCEPTION 'subscription_retry_cadence_invalid' USING ERRCODE='22023'; END IF;
   cadence_hours := cadence_item::text::numeric;
   IF cadence_hours <= 0 OR cadence_hours > 2147483647 OR cadence_hours <> trunc(cadence_hours) THEN
    RAISE EXCEPTION 'subscription_retry_cadence_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
 END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id;
  IF FOUND AND e.settlement_intent_id=p_payment_intent_id AND e.payment_attempt_id IS NULL THEN
   RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 legacy_fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,''));
 fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,'')||CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class='||p_failure_class END);
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.response_payload IS NOT NULL AND
   (receipt.request_fingerprint=fingerprint OR (p_failure_class IS NOT NULL AND receipt.request_fingerprint=legacy_fingerprint AND EXISTS(
    SELECT 1 FROM public.payment_provider_attempts WHERE id=NULLIF(receipt.metadata->>'paymentAttemptId','')::uuid AND failure_class=p_failure_class))) THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentResult,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_intent_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id FOR UPDATE;
  IF NOT FOUND OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
   RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS DISTINCT FROM a.id THEN
   RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF e.amount_minor>0 AND e.amount_minor<>i.amount_minor AND (p_result_status NOT IN ('refunded','partially_refunded') OR (SELECT refund_event_money_original FROM public.payment_provider_profile(e.provider))) THEN
   RAISE EXCEPTION 'payment_control_result_amount_mismatch' USING ERRCODE='22023'; END IF;
  IF e.currency IS NOT NULL AND e.currency<>i.currency_code THEN
   RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=i.order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_order_not_found' USING ERRCODE='22023'; END IF;
 from_status:=s.status;
 IF p_result_status='succeeded' THEN
  IF p_payment_event_id IS NULL THEN
   RAISE EXCEPTION 'payment_control_result_success_evidence_required' USING ERRCODE='22023'; END IF;
 ELSIF p_result_status IN ('failed','expired') THEN
  capture_requires_review:=public.payment_provider_capture_requires_review(i.id);
  already_applied_expiry:=p_result_status='expired' AND s.status='expired' AND a.status='expired';
  IF public.payment_provider_capture_review_required(i.id,a.id)
    OR (s.target_kind='one_time_order' AND capture_requires_review AND NOT already_applied_expiry) THEN
   kind:='ignored_failure_protected_state';
  ELSIF s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN kind:='ignored_failure_after_success_or_terminal';
  ELSIF s.target_kind='subscription_cycle' AND EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=s.subscription_cycle_id AND status IN ('skipped','cancelled') FOR UPDATE) THEN
   UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=COALESCE(p_failure_reason,p_result_status),updated_at=now() WHERE id=a.id;
   UPDATE public.payment_provider_states SET payment_status=p_result_status,metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
   kind:='ignored_failure_terminalized_cycle';
  ELSIF capture_requires_review AND NOT already_applied_expiry THEN kind:='ignored_failure_protected_state';
  ELSIF s.status=p_result_status AND a.status=p_result_status THEN kind:='ignored_duplicate_terminal_failure'; END IF;
 ELSE
  RETURN public.payment_refund_apply_result(p_idempotency_key,p_payment_intent_id,p_payment_event_id,p_result_status,
   p_occurred_at,p_failure_reason,p_failure_class,p_failure_class_decided_by);
 END IF;
 IF kind='state_changed' THEN
  outcome:=CASE WHEN p_result_status='succeeded' THEN 'captured' ELSE 'refused' END;
  native_failure:=CASE WHEN outcome='refused' THEN CASE WHEN p_failure_class IN ('authorization_refused','insufficient_funds','method_unavailable','risk_refused','unknown_refusal') THEN p_failure_class ELSE 'unknown_refusal' END END;
  evidence:=CASE WHEN p_payment_event_id IS NULL THEN
   jsonb_build_object('sourceKind','execution_response','sourceReference',a.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',encode(sha256(convert_to(a.response_payload::text,'UTF8')),'hex'))
   ELSE jsonb_build_object('sourceKind',CASE WHEN e.received_via='reconciliation_read.v1' THEN 'reconciliation_read' ELSE 'accepted_event' END,
    'sourceReference',e.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))) END;
  PERFORM public.payment_provider_assert_truth(i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,evidence);
  capture_requires_review:=outcome='captured' AND public.payment_provider_capture_requires_review(i.id);
  IF outcome='captured' AND i.status='settled' AND s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN
   kind:='ignored_duplicate_success';
  ELSIF outcome='captured' AND s.status IN ('refunded','partially_refunded','disputed') THEN
   RAISE EXCEPTION 'payment_control_result_terminal_intent' USING ERRCODE='22023';
  ELSIF outcome='captured' AND public.payment_provider_capture_review_required(i.id,a.id) THEN
   kind:='ignored_success_requiring_review';
  ELSIF outcome='captured' AND NOT capture_requires_review AND i.status<>'settled' AND i.renewal_operation_id IS NOT NULL THEN
   SELECT * INTO retry_obligation FROM public.subscription_retry_obligations
    WHERE renewal_operation_id=i.renewal_operation_id FOR UPDATE;
   IF FOUND AND retry_obligation.state<>'recovered' THEN
    SELECT r.* INTO retry_preparation FROM public.subscription_retry_receipts r
     WHERE r.obligation_id=retry_obligation.id AND r.kind='prepare' AND r.attempt_sequence=retry_obligation.attempt_sequence;
    retry_result:=public.subscription_retry_record_recovery(i.renewal_operation_id,p_idempotency_key||':truth',
     evidence||jsonb_build_object('prepareKey',retry_preparation.receipt_key,'evidenceKey','provider:'||e.id::text,
      'occurredAt',p_occurred_at,'firstRecordedAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'externalRef',COALESCE(a.provider_attempt_id,e.provider_payment_id),
      'amountMinor',i.amount_minor,'currency',i.currency_code,'template',p_recovery_template_slug));
    IF retry_result->>'state' IS DISTINCT FROM 'recovered' THEN
     kind:='ignored_success_requiring_review';
    END IF;
   END IF;
  END IF;
  IF outcome='refused' AND s.target_kind='subscription_cycle' AND i.renewal_operation_id IS NOT NULL THEN
   SELECT op.* INTO renewal FROM public.subscription_renewal_operations op
    JOIN public.subscription_cycles c ON c.renewal_operation_id=op.id AND c.id=s.subscription_cycle_id
    WHERE op.id=i.renewal_operation_id AND op.subscription_id=s.subscription_id
     AND o.renewal_operation_id=op.id AND o.subscription_cycle_id=c.id
     AND i.renewal_operation_fingerprint=op.operation_fingerprint FOR UPDATE OF op;
   IF NOT FOUND OR renewal.cycle_snapshot#>>'{cycle,status}' IS DISTINCT FROM 'correlated' THEN
    RAISE EXCEPTION 'subscription_renewal_cycle_correlation_required' USING ERRCODE='22023'; END IF;
   logical_cycle:=(renewal.cycle_snapshot#>>'{cycle,logicalCycleNumber}')::integer;
   SELECT r.* INTO retry_preparation FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations obligation ON obligation.id=r.obligation_id
    WHERE obligation.renewal_operation_id=renewal.id AND r.kind='prepare'
     AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'idempotencyKey'=a.idempotency_key
     AND r.input->>'providerIdempotencyKey'=a.request_payload->>'providerIdempotencyKey'
     AND r.input->>'providerRequestFingerprint'=a.request_payload->>'providerRequestFingerprint';
   IF FOUND THEN retry_sequence:=retry_preparation.attempt_sequence;
   ELSIF renewal.external_attempt_ref IN (a.id::text,a.provider_attempt_id)
    AND renewal.cycle_snapshot->>'externalAttemptSequence'='0' THEN retry_sequence:=0;
   ELSE RAISE EXCEPTION 'subscription_retry_not_prepared' USING ERRCODE='22023'; END IF;
   -- A same-attempt expiry records a lifecycle escalation. Its decline already
   -- owns the financial failure and retry stage; neither effect runs again.
   expiry_escalation:=p_result_status='expired' AND s.status='failed' AND a.status='failed' AND EXISTS(
    SELECT 1 FROM public.subscription_retry_receipts r
    JOIN public.subscription_retry_obligations obligation ON obligation.id=r.obligation_id
    WHERE obligation.renewal_operation_id=renewal.id AND r.kind='failure' AND r.attempt_sequence=retry_sequence
     AND r.input->>'paymentIntentId'=i.id::text AND r.input->>'paymentAttemptId'=a.id::text);
   IF NOT expiry_escalation THEN
   -- The retry owner records the financial failure first. Truth below reuses
   -- this exact key's settlement receipt, rather than making a second transition.
   retry_result:=public.subscription_retry_apply_failure(renewal.id,p_idempotency_key||':truth',
    jsonb_build_object('attemptSequence',retry_sequence,'logicalCycleNumber',logical_cycle,
     'paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'provider',a.provider,
     'providerAttemptId',a.provider_attempt_id,'subscriptionCycleId',s.subscription_cycle_id,
     'renewalOperationId',renewal.id,'occurredAt',p_occurred_at,
     'failureClass',p_failure_class,'reason',COALESCE(p_failure_reason,p_result_status),
     'externalRef',CASE WHEN retry_sequence=0 THEN renewal.external_attempt_ref ELSE COALESCE(a.provider_attempt_id,a.id::text) END,
     'evidenceKey',COALESCE(e.id::text,a.id::text),'firstRecordedAt',COALESCE(e.created_at,a.updated_at)),
     COALESCE(p_cadence,'{"backoffHours":[24,72,168]}'::jsonb));
  END IF;
   END IF;
  IF kind='state_changed' AND NOT expiry_escalation AND NOT (
   outcome='captured' AND (i.status='settled' OR retry_result IS NOT NULL)
  ) THEN
   truth:=public.payment_truth_ingest_event('provider:'||COALESCE(e.id::text,p_idempotency_key),encode(sha256(convert_to(jsonb_build_object('eventId',e.id,'intentId',i.id,'attemptId',a.id,'outcome',outcome)::text,'UTF8')),'hex'),
    p_idempotency_key||':truth',i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,native_failure,p_failure_reason,evidence,p_dunning_template_slug,p_recovery_url_path,p_recovery_template_slug);
   IF outcome='captured' AND NOT COALESCE(truth#>>'{event,applicationStatus}'='applied'
    AND truth#>>'{event,outcome}'='captured'
    AND truth#>>'{effects,paymentResultRecorded}'='true'
    AND truth#>>'{financial,settlementStatus}'='settled',false) THEN
    kind:='ignored_success_requiring_review';
   END IF;
  END IF;
  IF kind='state_changed' THEN
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   provider_payment_id=CASE WHEN p_result_status='succeeded' THEN
    CASE WHEN e.received_via='reconciliation_read.v1' THEN COALESCE(a.provider_attempt_id,e.provider_payment_id)
      ELSE COALESCE(e.provider_payment_id,provider_payment_id) END
    ELSE provider_payment_id END,
   failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=s.id;
  UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=a.id;
  IF p_result_status IN ('failed','expired') AND o.subscription_cycle_id IS NULL THEN
   IF p_result_status='failed' THEN
    UPDATE public.commerce_orders SET metadata=metadata||jsonb_build_object(
     'paymentStatus','declined','failureReason',COALESCE(p_failure_reason,p_result_status),
     'lastDeclineAt',p_occurred_at,'recoverable',true,'source','payment.control.v0'),updated_at=now() WHERE id=o.id;
    -- The first recoverable-decline metadata transition owns the delayed notice
    -- and its authority in the native checkout recovery token ledger.
    IF o.client_id IS NOT NULL AND (o.metadata->>'paymentStatus' IS DISTINCT FROM 'declined'
     OR COALESCE((o.metadata->>'recoverable')::boolean,false) IS DISTINCT FROM true) THEN
     recovery_token:='rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
     recovery_expires_at:=now()+interval '24 hours';
     INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
     VALUES(o.id,o.client_id,encode(sha256(convert_to(recovery_token,'UTF8')),'hex'),recovery_expires_at)
     ON CONFLICT (token_hash) DO NOTHING;
     INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,available_at,payload,metadata)
     VALUES('commerce_order',o.id,'commerce.payment.failed','payment_failed:'||o.id,now()+interval '3 minutes',
      jsonb_build_object('orderId','order_'||o.id,'orderUuid',o.id,'totalCents',o.total_amount_minor,
       'currency',o.currency_code,'recoveryToken',recovery_token,
       'mode',CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=o.id)
        OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
        THEN 'subscription_cycle' ELSE 'one_time' END,
       'failureReason',COALESCE(p_failure_reason,p_result_status),'hasSubscriptionContext',EXISTS(
        SELECT 1 FROM public.subscription_activations WHERE order_id=o.id) OR COALESCE(
        o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')='subscription',
       'expiresAt',recovery_expires_at,'occurredAt',now()),
      jsonb_build_object('source','payment_provider_result_apply_recoverable_decline'))
     ON CONFLICT (event_type,idempotency_key) DO NOTHING;
    END IF;
    kind:='recoverable_decline';
   ELSE
    IF EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=o.id AND state='provisional') THEN
     PERFORM public.commerce_compensate_abandoned_checkout(
      'payment-expired:'||o.id,o.id,'subscription_activation_failed',p_occurred_at);
    END IF;
    UPDATE public.commerce_orders SET status='expired',metadata=metadata||jsonb_build_object(
     'paymentStatus','expired','failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),
     updated_at=now() WHERE id=o.id;
    FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
     WHERE purchase_order_id=o.id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation(
      'payment-expired:'||held.id,held.id,'payment_expired','{}'::jsonb,p_occurred_at);
    END LOOP;
   END IF;
  END IF;
  END IF;
 END IF;
 IF p_failure_class IS NOT NULL AND kind NOT IN ('ignored_success_requiring_review','ignored_failure_protected_state') THEN
  UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,response_payload=response_payload||
   CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id;
 END IF;
 IF p_payment_event_id IS NOT NULL THEN
  UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id;
 END IF;
 IF kind NOT IN ('ignored_duplicate_success','ignored_success_requiring_review','ignored_failure_protected_state') THEN
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,p_payment_event_id,'business_result',from_status,p_result_status,kind,p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',o.id,'resultStatus',p_result_status,'source','payment.control.v0')||
  CASE WHEN outcome IS DISTINCT FROM 'refused' OR retry_result IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retryObligationId',retry_result->>'id',
   'retryAttempt',retry_result->'retry_attempt','nextRetryAt',retry_result->'next_retry_at','retryFailureKey',p_idempotency_key||':truth') END);
 END IF;
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',o.id,'status',p_result_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 IF p_result_status='failed' AND kind<>'ignored_failure_protected_state' AND p_payment_event_id IS NOT NULL
  AND p_idempotency_key='provider-webhook:'||e.provider||':'||e.provider_event_id||':apply' THEN
  BEGIN
   handoff:=public.payment_reconciliation_open_dunning_from_failed_result(
    'provider-webhook:'||e.provider||':'||e.provider_event_id||':dunning',i.id,e.provider_event_id,
    p_failure_reason,p_occurred_at,p_failure_class,a.id,p_dunning_template_slug,p_recovery_url_path);
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF SQLERRM NOT IN ('subscription_dunning_failed_attempt_unattributed','subscription_dunning_case_unattributed',
    'subscription_dunning_replay_unavailable','subscription_dunning_failed_attempt_ambiguous','subscription_dunning_failed_attempt_rung_mismatch') THEN RAISE; END IF;
   handoff:=jsonb_build_object('subscriptionWebhookDunning',jsonb_build_object('opened',false,'replayed',false,
    'reason',SQLERRM,'failedPaymentAttemptId',a.id));
  END;
  answer:=answer||handoff;
 END IF;
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id)||
  CASE WHEN e.received_via='reconciliation_read.v1' THEN jsonb_build_object('paymentEventId',e.id) ELSE '{}'::jsonb END);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_provider_result_apply(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text,
 p_dunning_template_slug text,p_recovery_url_path text,p_recovery_template_slug text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RETURN public.payment_provider_result_apply(
  p_idempotency_key,p_payment_intent_id,p_payment_event_id,p_result_status,
  p_occurred_at,p_failure_reason,p_failure_class,p_failure_class_decided_by,
  p_dunning_template_slug,p_recovery_url_path,p_recovery_template_slug,NULL::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb) TO service_role'; END IF; END; $$;
