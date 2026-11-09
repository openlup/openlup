-- Retry recovery follows applied payment truth before changing money or stock.
-- Existing signature, invoker security, owner and ACL remain unchanged.
-- Non-paid evidence keeps the payment owner's durable receipt for review/replay.
CREATE OR REPLACE FUNCTION public.subscription_retry_record_recovery(p_operation_id uuid,p_key text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; r public.subscription_retry_receipts; prep public.subscription_retry_receipts;
 i public.commerce_settlement_intents; result jsonb; truth jsonb; at_time timestamptz:=(p_input->>'occurredAt')::timestamptz;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'recovery' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  -- Released receipts may already describe a capture retained for review.
  -- Preserve their history, but never replay that history as applied payment.
  SELECT public.payment_truth_readback(event.id,true) INTO truth
   FROM public.payment_truth_events event WHERE event.source_event_id=p_input->>'evidenceKey'
    AND event.settlement_intent_id=o.settlement_intent_id;
  IF NOT COALESCE(truth#>>'{event,applicationStatus}'='applied'
   AND truth#>>'{event,outcome}'='captured'
   AND truth#>>'{effects,paymentResultRecorded}'='true'
   AND truth#>>'{financial,settlementStatus}'='settled',false) THEN
   RETURN r.result||jsonb_build_object('disposition','payment_failed','paymentTruth',truth);
  END IF;
  RETURN r.result;
 END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=o.settlement_intent_id FOR UPDATE;
 SELECT * INTO prep FROM public.subscription_retry_receipts WHERE obligation_id=o.id AND kind='prepare' AND attempt_sequence=o.attempt_sequence;
 IF o.id IS NULL OR o.state='recovered' OR at_time IS NULL OR (p_input->>'firstRecordedAt')::timestamptz IS NULL OR
  btrim(COALESCE(p_input->>'evidenceKey',''))='' OR btrim(COALESCE(p_input->>'externalRef',''))='' OR
  (p_input->>'amountMinor')::bigint IS DISTINCT FROM i.amount_minor OR p_input->>'currency' IS DISTINCT FROM i.currency_code OR
  (o.state='prepared' AND prep.receipt_key IS DISTINCT FROM p_input->>'prepareKey') THEN
  RAISE EXCEPTION 'subscription_retry_positive_evidence_required' USING ERRCODE='22023'; END IF;
 truth:=public.payment_truth_ingest_event(p_input->>'evidenceKey',
  encode(sha256(convert_to(jsonb_build_object('operationId',p_operation_id,'input',p_input)::text,'UTF8')),'hex'),
  p_key,i.id,'captured',i.amount_minor,i.currency_code,at_time,NULL,NULL,
  p_input||jsonb_build_object('renewalOperationId',p_operation_id,'operationFingerprint',o.operation_fingerprint),
  NULL,NULL,p_input->>'template');
 -- A captured observation is not an applied payment. Preserve the owner's
 -- review/evidence receipt and return without consuming the once-per-attempt
 -- recovery receipt; later genuinely paid evidence must remain admissible.
 IF NOT COALESCE(truth#>>'{event,applicationStatus}'='applied'
  AND truth#>>'{event,outcome}'='captured'
  AND truth#>>'{effects,paymentResultRecorded}'='true'
  AND truth#>>'{financial,settlementStatus}'='settled',false) THEN
  RETURN to_jsonb(o)||jsonb_build_object('disposition','payment_failed','paymentTruth',truth);
 END IF;
 UPDATE public.subscription_renewal_terms SET next_cycle_number=GREATEST(next_cycle_number,
  (SELECT cycle_number+1 FROM public.subscription_renewal_operations WHERE id=p_operation_id)),updated_at=at_time WHERE subscription_id=o.subscription_id;
 -- A waiting-state refusal released this obligation's stock. Paid lines must
 -- re-enter the existing ATP hard holds; consumed rows are not counted there.
 -- Serialize with the native allocator using its deterministic stock-row locks.
 IF o.state='waiting' THEN
  PERFORM stock.sku FROM public.fulfillment_stock_current stock
   JOIN public.fulfillment_inventory_reservations reservation ON reservation.source_key=stock.source_key
   JOIN public.fulfillment_inventory_reservation_lines line ON line.reservation_id=reservation.id AND line.sku=stock.sku
   WHERE reservation.renewal_operation_id=p_operation_id AND reservation.status='released'
   ORDER BY stock.sku FOR UPDATE OF stock;
 END IF;
 UPDATE public.fulfillment_inventory_reservations
  SET status=CASE WHEN status='released' THEN 'committed' ELSE 'consumed' END,
   expires_at=CASE WHEN status='released' THEN NULL ELSE expires_at END,terminal_reason=NULL,updated_at=at_time
  WHERE renewal_operation_id=p_operation_id AND
   (status='committed' OR (o.state='waiting' AND status='released'));
 IF o.case_id IS NOT NULL THEN PERFORM public.dunning_lifecycle_record_recovery(o.case_id,at_time,p_input->>'template'); END IF;
 UPDATE public.subscription_retry_obligations SET state='recovered',next_retry_at=NULL,updated_at=at_time WHERE id=o.id RETURNING * INTO o;
 result:=to_jsonb(o);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'recovery',o.attempt_sequence,p_input,result);
 RETURN result;
END;
$$;
