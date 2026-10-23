-- Native same-obligation retry bookkeeping. The original renewal remains terminal;
-- payment_pending, order, settlement, snapshot and identity never get recreated.
-- A prepared receipt is an irreversible dispatch fence: loss of ACK requires
-- readback, never another prepare. Hosts supply verified payment observations;
-- these invoker functions perform no payment I/O and grant no runtime authority.
-- Failure and case propagation retain their separate donor transaction units.
-- Disable the retry driver before rollback; retain these ledgers for reconciliation.
CREATE TABLE public.subscription_retry_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  renewal_operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_renewal_operations(id),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
  cycle_id uuid NOT NULL UNIQUE REFERENCES public.subscription_cycles(id),
  order_id uuid NOT NULL UNIQUE REFERENCES public.commerce_orders(id),
  settlement_intent_id uuid NOT NULL UNIQUE REFERENCES public.commerce_settlement_intents(id),
  logical_cycle_number integer NOT NULL CHECK (logical_cycle_number > 0),
  identity_key text NOT NULL UNIQUE,
  operation_fingerprint text NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  scheduled_at timestamptz NOT NULL,
  cycle_snapshot jsonb NOT NULL,
  retry_attempt integer NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),
  attempt_sequence integer NOT NULL DEFAULT 0 CHECK (attempt_sequence >= 0),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','prepared','recovered')),
  next_retry_at timestamptz,
  failure_class text,
  failure_reason text,
  failed_at timestamptz,
  case_id uuid REFERENCES public.subscription_dunning_cases(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, scheduled_at)
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscription_retry_due_idx ON public.subscription_retry_obligations(state,next_retry_at,id);
CREATE TABLE public.subscription_retry_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL REFERENCES public.subscription_retry_obligations(id),
  receipt_key text NOT NULL UNIQUE CHECK (btrim(receipt_key) <> ''),
  kind text NOT NULL CHECK (kind IN ('failure','prepare','recovery','schedule')),
  attempt_sequence integer NOT NULL CHECK (attempt_sequence >= 0),
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, kind, attempt_sequence)
);
CREATE TABLE public.subscription_retry_recovery_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL REFERENCES public.subscription_retry_obligations(id),
  token_id uuid NOT NULL REFERENCES public.commerce_checkout_recovery_tokens(id),
  retry_attempt integer NOT NULL CHECK (retry_attempt > 0),
  method_ref text NOT NULL CHECK (btrim(method_ref) <> ''),
  method_evidence_ref text NOT NULL CHECK (btrim(method_evidence_ref) <> ''),
  authorized_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (token_id, retry_attempt),
  UNIQUE (obligation_id, retry_attempt)
);
REVOKE ALL ON TABLE public.subscription_retry_obligations, public.subscription_retry_receipts, public.subscription_retry_recovery_authorizations FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.subscription_retry_read(p_operation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT to_jsonb(o) FROM public.subscription_retry_obligations o WHERE renewal_operation_id=p_operation_id;
$$;
CREATE FUNCTION public.subscription_retry_candidates(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM (
  SELECT o.* FROM public.subscription_retry_obligations o JOIN public.subscriptions s ON s.id=o.subscription_id
  WHERE s.status='active' AND o.state='waiting' AND o.next_retry_at<=p_now
  ORDER BY o.next_retry_at,o.id LIMIT LEAST(GREATEST(p_limit,1),500)
 ) c;
$$;

-- input binds the original logical cycle explicitly; the native renewal counter
-- is not evidence of activation-cycle numbering. Retry zero is the original.
CREATE FUNCTION public.subscription_retry_apply_failure(p_operation_id uuid,p_key text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE op public.subscription_renewal_operations; o public.subscription_retry_obligations;
 r public.subscription_retry_receipts; c public.subscription_cycles; i public.commerce_settlement_intents;
 at_time timestamptz := (p_input->>'occurredAt')::timestamptz; seq integer := (p_input->>'attemptSequence')::integer;
 next_time timestamptz; result jsonb;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 IF op.id IS NULL OR at_time IS NULL OR seq IS NULL OR btrim(COALESCE(p_key,''))='' OR
  btrim(COALESCE(p_input->>'evidenceKey',''))='' OR (p_input->>'firstRecordedAt')::timestamptz IS NULL OR
  (p_input->>'logicalCycleNumber')::integer IS NULL OR (p_input->>'logicalCycleNumber')::integer<1 THEN
  RAISE EXCEPTION 'subscription_retry_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=op.id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id IS DISTINCT FROM o.id OR r.kind<>'failure' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 SELECT * INTO c FROM public.subscription_cycles WHERE renewal_operation_id=op.id FOR UPDATE;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE renewal_operation_id=op.id FOR UPDATE;
 IF c.id IS NULL OR i.id IS NULL OR c.status<>'payment_pending' OR i.status='settled' THEN
  RAISE EXCEPTION 'subscription_retry_not_unpaid' USING ERRCODE='22023'; END IF;
 INSERT INTO public.subscription_retry_obligations(renewal_operation_id,subscription_id,cycle_id,order_id,settlement_intent_id,
  logical_cycle_number,identity_key,operation_fingerprint,scheduled_at,cycle_snapshot)
 VALUES(op.id,op.subscription_id,c.id,i.order_id,i.id,(p_input->>'logicalCycleNumber')::integer,
  op.identity_key,op.operation_fingerprint,op.scheduled_at,op.cycle_snapshot)
 ON CONFLICT (renewal_operation_id) DO NOTHING;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=op.id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'failure' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 IF o.attempt_sequence<>seq OR o.logical_cycle_number<>(p_input->>'logicalCycleNumber')::integer OR o.state='recovered' OR
  EXISTS(SELECT 1 FROM public.subscription_retry_receipts WHERE obligation_id=o.id AND kind='failure' AND
   (attempt_sequence=seq OR input->>'evidenceKey'=p_input->>'evidenceKey')) THEN
  RAISE EXCEPTION 'subscription_retry_attempt_conflict' USING ERRCODE='23505'; END IF;
 IF seq=0 THEN
  IF op.state='attempt_prepared' THEN
   PERFORM public.commerce_record_subscription_renewal_outcome(op.id,p_key,op.operation_fingerprint,'refused',
    op.external_attempt_ref,p_input->>'reason',at_time);
  ELSIF op.state<>'refused' OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes
   WHERE renewal_operation_id=op.id AND outcome='refused') OR op.attempt_prepared_at IS NULL THEN
   RAISE EXCEPTION 'subscription_retry_definite_decline_required' USING ERRCODE='22023';
  ELSE
   at_time:=op.terminal_at;
  END IF;
 ELSE
  IF o.state<>'prepared' OR btrim(COALESCE(p_input->>'externalRef',''))='' OR
   btrim(COALESCE(p_input->>'evidenceKey',''))='' OR (p_input->>'firstRecordedAt')::timestamptz IS NULL THEN RAISE EXCEPTION 'subscription_retry_not_prepared' USING ERRCODE='22023'; END IF;
  -- As on the M07 truth rail, attempt evidence does not replace the
  -- aggregate's write-once external handle.
  PERFORM public.commerce_record_settlement(p_key||':settlement',i.id,'failed',NULL,p_input,at_time);
  UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason='settlement_refused',updated_at=at_time
   WHERE renewal_operation_id=op.id AND status='committed';
 END IF;
 next_time := CASE WHEN p_input->>'failureClass'='hard_do_not_retry' THEN NULL
  WHEN o.retry_attempt=0 THEN at_time+interval '24 hours'
  WHEN o.retry_attempt=1 THEN at_time+interval '72 hours'
  WHEN o.retry_attempt=2 THEN at_time+interval '168 hours' ELSE NULL END;
 UPDATE public.subscription_retry_obligations SET retry_attempt=retry_attempt+1,state='waiting',next_retry_at=next_time,
  failure_class=p_input->>'failureClass',failure_reason=p_input->>'reason',failed_at=at_time,updated_at=at_time WHERE id=o.id RETURNING * INTO o;
 result:=to_jsonb(o);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'failure',seq,p_input,result);
 RETURN result;
END;
$$;

CREATE FUNCTION public.subscription_retry_open_case(p_operation_id uuid,p_template text,p_recovery_path text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; result jsonb; client uuid; i public.commerce_settlement_intents;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 IF o.id IS NULL OR o.retry_attempt=0 OR o.state='recovered' THEN RAISE EXCEPTION 'subscription_retry_failure_required'; END IF;
 SELECT client_id INTO client FROM public.subscriptions WHERE id=o.subscription_id;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=o.settlement_intent_id;
 IF o.case_id IS NULL THEN
  result:=public.dunning_lifecycle_open_case(o.identity_key||':retry-case',o.subscription_id,o.cycle_id,client,
   o.retry_attempt,o.next_retry_at,o.failure_class,o.failure_reason,o.failed_at,i.amount_minor,i.currency_code,p_template,p_recovery_path);
  UPDATE public.subscription_retry_obligations SET case_id=(result->>'caseId')::uuid WHERE id=o.id RETURNING * INTO o;
 END IF;
 RETURN public.dunning_lifecycle_handle_failure(o.case_id,o.failed_at,o.failure_class,o.failure_reason,
  o.retry_attempt,o.next_retry_at,p_template,p_recovery_path);
END;
$$;

-- Token consumption and durable usable-method evidence precede scheduling. A
-- method webhook alone cannot reopen a class stop or an exhausted ladder.
CREATE FUNCTION public.subscription_retry_authorize_recovery(p_operation_id uuid,p_token_id uuid,p_method text,p_evidence text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; t public.commerce_checkout_recovery_tokens;
 a public.subscription_retry_recovery_authorizations;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=o.id AND retry_attempt=o.retry_attempt;
 IF a.id IS NOT NULL THEN
  IF a.token_id<>p_token_id OR a.method_ref IS DISTINCT FROM p_method OR a.method_evidence_ref IS DISTINCT FROM p_evidence THEN
   RAISE EXCEPTION 'subscription_retry_authorization_conflict' USING ERRCODE='23505'; END IF;
  RETURN to_jsonb(a);
 END IF;
 SELECT * INTO t FROM public.commerce_checkout_recovery_tokens WHERE id=p_token_id FOR UPDATE;
 IF o.id IS NULL OR o.case_id IS NULL OR o.state<>'waiting' OR t.id IS NULL OR t.order_id<>o.order_id OR
  t.client_id IS DISTINCT FROM (SELECT client_id FROM public.subscriptions WHERE id=o.subscription_id) OR
  t.revoked_at IS NOT NULL OR t.expires_at<=p_now OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy') OR btrim(COALESCE(p_method,''))='' OR btrim(COALESCE(p_evidence,''))='' OR
  NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE id=o.case_id AND status='open') THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 INSERT INTO public.subscription_retry_recovery_authorizations(obligation_id,token_id,retry_attempt,method_ref,method_evidence_ref,authorized_at)
 VALUES(o.id,t.id,o.retry_attempt,p_method,p_evidence,p_now) RETURNING * INTO a;
 UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=p_now WHERE id=t.id;
 RETURN to_jsonb(a);
END;
$$;
CREATE FUNCTION public.subscription_retry_schedule_recovery(p_operation_id uuid,p_key text,p_authorization_id uuid,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; a public.subscription_retry_recovery_authorizations; r public.subscription_retry_receipts; input jsonb;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 input:=jsonb_build_object('authorizationId',p_authorization_id,'now',p_now);
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'schedule' OR r.input<>input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE id=p_authorization_id FOR UPDATE;
 IF o.id IS NULL OR o.state<>'waiting' OR a.obligation_id IS DISTINCT FROM o.id OR a.retry_attempt<>o.retry_attempt OR a.consumed_at IS NOT NULL OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy') THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 -- Receipt first: a failed schedule write rolls the receipt back too.
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'schedule',o.attempt_sequence,input,jsonb_build_object('scheduled',true,'obligationId',o.id));
 UPDATE public.subscription_retry_obligations SET next_retry_at=p_now,updated_at=p_now WHERE id=o.id;
 UPDATE public.subscription_dunning_cases SET next_retry_at=p_now,updated_at=p_now WHERE id=o.case_id AND status='open';
 RETURN jsonb_build_object('scheduled',true,'obligationId',o.id);
END;
$$;

-- Native M06 stock is locked in SKU order; all lines are checked before any
-- released reservation is recommitted. Existing unrelated commitments survive.
CREATE FUNCTION public.subscription_retry_prepare(p_operation_id uuid,p_key text,p_input jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; op public.subscription_renewal_operations; r public.subscription_retry_receipts;
 a public.subscription_retry_recovery_authorizations; reservation public.fulfillment_inventory_reservations;
 line record; available bigint; committed bigint; result jsonb;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=op.id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'prepare' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result||jsonb_build_object('execute',false,'replayed',true);
 END IF;
 IF o.id IS NULL OR o.state<>'waiting' OR o.next_retry_at IS NULL OR o.next_retry_at>p_now OR
  NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=o.subscription_id AND status='active') OR
  NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=o.cycle_id AND status='payment_pending') OR
  NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=o.settlement_intent_id AND status='failed') OR
  btrim(COALESCE(p_input->>'idempotencyKey',''))='' OR btrim(COALESCE(p_input->>'providerIdempotencyKey',''))='' OR
  COALESCE(p_input->>'providerRequestFingerprint','') !~ '^[0-9a-f]{64}$' OR
  p_input->>'paymentIntentId' IS DISTINCT FROM o.settlement_intent_id::text OR
  p_input->>'orderRef' IS DISTINCT FROM o.order_id::text OR
  (p_input->>'amountMinor')::bigint IS DISTINCT FROM (o.cycle_snapshot->>'totalAmountMinor')::bigint OR
  p_input->>'currency' IS DISTINCT FROM o.cycle_snapshot->>'currency' OR
  EXISTS(SELECT 1 FROM public.subscription_retry_receipts WHERE kind='prepare' AND (input->>'idempotencyKey'=p_input->>'idempotencyKey' OR input->>'providerIdempotencyKey'=p_input->>'providerIdempotencyKey')) OR btrim(COALESCE(p_input->>'paymentMethodRef',''))='' THEN
  RAISE EXCEPTION 'subscription_retry_not_due_or_ambiguous' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=o.id AND retry_attempt=o.retry_attempt FOR UPDATE;
 IF (o.retry_attempt>=4 OR o.failure_class='hard_do_not_retry') AND (a.id IS NULL OR a.consumed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 IF a.id IS NOT NULL AND (a.method_ref IS DISTINCT FROM p_input->>'paymentMethodRef' OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy')) THEN RAISE EXCEPTION 'subscription_retry_method_mismatch'; END IF;
 SELECT * INTO reservation FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=op.id FOR UPDATE;
 IF reservation.id IS NULL OR reservation.operation_fingerprint<>o.operation_fingerprint THEN RAISE EXCEPTION 'subscription_retry_stock_binding_missing'; END IF;
 PERFORM stock.sku FROM public.fulfillment_stock_current stock JOIN public.fulfillment_inventory_reservation_lines l ON l.sku=stock.sku
  WHERE l.reservation_id=reservation.id AND stock.source_key=reservation.source_key ORDER BY stock.sku FOR UPDATE OF stock;
 FOR line IN SELECT * FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=reservation.id ORDER BY sku LOOP
  SELECT for_sale_quantity INTO available FROM public.fulfillment_stock_current WHERE source_key=reservation.source_key AND sku=line.sku
   AND inventory_class='sellable' AND stale_after>p_now;
  SELECT COALESCE(sum(l.quantity),0) INTO committed FROM public.fulfillment_inventory_reservation_lines l
   JOIN public.fulfillment_inventory_reservations rr ON rr.id=l.reservation_id WHERE rr.source_key=reservation.source_key AND l.sku=line.sku
   AND rr.id<>reservation.id AND (rr.status='committed' OR (rr.status='held' AND rr.expires_at>p_now));
  IF available IS NULL OR available-committed<line.quantity THEN RAISE EXCEPTION 'subscription_retry_inventory_unavailable' USING ERRCODE='23514'; END IF;
 END LOOP;
 UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL,terminal_reason=NULL,updated_at=p_now WHERE id=reservation.id;
 UPDATE public.subscription_retry_obligations SET state='prepared',attempt_sequence=attempt_sequence+1,next_retry_at=NULL,updated_at=p_now WHERE id=o.id RETURNING * INTO o;
 UPDATE public.subscription_retry_recovery_authorizations SET consumed_at=p_now WHERE id=a.id;
 result:=jsonb_build_object('execute',true,'replayed',false,'obligationId',o.id,'attemptSequence',o.attempt_sequence,
  'cycleId',o.cycle_id,'orderId',o.order_id,'settlementIntentId',o.settlement_intent_id,'identityKey',o.identity_key,
  'operationFingerprint',o.operation_fingerprint,'snapshot',o.cycle_snapshot,'request',p_input);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'prepare',o.attempt_sequence,p_input,result);
 RETURN result;
END;
$$;

-- The M07 external settlement reference remains write-once across attempts.
-- M07 truth ingestion retains that aggregate handle while recording distinct
-- attempt evidence. Never clear or substitute the settlement reference.
-- Verified positive evidence can settle an original decline without resetting its
-- operation. An outstanding retry must be reconciled under its own prepare key.
CREATE FUNCTION public.subscription_retry_record_recovery(p_operation_id uuid,p_key text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; r public.subscription_retry_receipts; prep public.subscription_retry_receipts;
 i public.commerce_settlement_intents; result jsonb; at_time timestamptz:=(p_input->>'occurredAt')::timestamptz;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'recovery' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=o.settlement_intent_id FOR UPDATE;
 SELECT * INTO prep FROM public.subscription_retry_receipts WHERE obligation_id=o.id AND kind='prepare' AND attempt_sequence=o.attempt_sequence;
 IF o.id IS NULL OR o.state='recovered' OR at_time IS NULL OR (p_input->>'firstRecordedAt')::timestamptz IS NULL OR
  btrim(COALESCE(p_input->>'evidenceKey',''))='' OR btrim(COALESCE(p_input->>'externalRef',''))='' OR
  (p_input->>'amountMinor')::bigint IS DISTINCT FROM i.amount_minor OR p_input->>'currency' IS DISTINCT FROM i.currency_code OR
  (o.state='prepared' AND prep.receipt_key IS DISTINCT FROM p_input->>'prepareKey') THEN
  RAISE EXCEPTION 'subscription_retry_positive_evidence_required' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_truth_ingest_event(p_input->>'evidenceKey',
  encode(sha256(convert_to(jsonb_build_object('operationId',p_operation_id,'input',p_input)::text,'UTF8')),'hex'),
  p_key,i.id,'captured',i.amount_minor,i.currency_code,at_time,NULL,NULL,
  p_input||jsonb_build_object('renewalOperationId',p_operation_id,'operationFingerprint',o.operation_fingerprint),
  NULL,NULL,p_input->>'template');
 UPDATE public.subscription_renewal_terms SET next_cycle_number=GREATEST(next_cycle_number,
  (SELECT cycle_number+1 FROM public.subscription_renewal_operations WHERE id=p_operation_id)),updated_at=at_time WHERE subscription_id=o.subscription_id;
 UPDATE public.fulfillment_inventory_reservations SET status='consumed',terminal_reason=NULL,updated_at=at_time
  WHERE renewal_operation_id=p_operation_id AND status='committed';
 IF o.case_id IS NOT NULL THEN PERFORM public.dunning_lifecycle_record_recovery(o.case_id,at_time,p_input->>'template'); END IF;
 UPDATE public.subscription_retry_obligations SET state='recovered',next_retry_at=NULL,updated_at=at_time WHERE id=o.id RETURNING * INTO o;
 result:=to_jsonb(o);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'recovery',o.attempt_sequence,p_input,result);
 RETURN result;
END;
$$;
CREATE FUNCTION public.subscription_retry_note_row_outcome(p_operation_id uuid,p_key text,p_input jsonb)
RETURNS jsonb LANGUAGE sql SET search_path = pg_catalog AS $$
 SELECT CASE WHEN p_input->>'outcome'='succeeded' THEN public.subscription_retry_record_recovery(p_operation_id,p_key,p_input)
  WHEN p_input->>'outcome'='refused' THEN public.subscription_retry_apply_failure(p_operation_id,p_key,p_input)
  ELSE jsonb_build_object('awaitingProvider',true,'execute',false) END;
$$;
REVOKE ALL ON FUNCTION public.subscription_retry_read(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_candidates(integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_apply_failure(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_open_case(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_authorize_recovery(uuid,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_schedule_recovery(uuid,text,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_prepare(uuid,text,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_record_recovery(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_retry_note_row_outcome(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
