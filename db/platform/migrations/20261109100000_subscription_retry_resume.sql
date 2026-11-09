-- Trusted retry timing and eligible finite-window resume.
-- Replacements preserve installed headers, invoker security and ACLs.
-- openlup:allow-grant: the new timing overload requires trusted service-role execution; browser and PUBLIC access remain revoked.

CREATE FUNCTION public.subscription_retry_apply_failure(p_operation_id uuid,p_key text,p_input jsonb,p_cadence jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE op public.subscription_renewal_operations; o public.subscription_retry_obligations;
 r public.subscription_retry_receipts; c public.subscription_cycles; i public.commerce_settlement_intents;
 at_time timestamptz := (p_input->>'occurredAt')::timestamptz; seq integer := (p_input->>'attemptSequence')::integer;
 next_time timestamptz; result jsonb; hours numeric;
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
 -- Trusted timing configuration never changes the terminating failure class.
 -- Receipt replay above retains the originally accepted schedule.
 IF jsonb_typeof(p_cadence) IS DISTINCT FROM 'object'
  OR (p_cadence - 'backoffHours') <> '{}'::jsonb
  OR jsonb_typeof(p_cadence->'backoffHours') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'subscription_retry_cadence_invalid' USING ERRCODE='22023';
 END IF;
 FOR result IN SELECT value FROM jsonb_array_elements(p_cadence->'backoffHours') LOOP
  IF jsonb_typeof(result)<>'number' THEN
   RAISE EXCEPTION 'subscription_retry_cadence_invalid' USING ERRCODE='22023';
  END IF;
  hours := result::text::numeric;
  IF hours<=0 OR hours>2147483647 THEN
   RAISE EXCEPTION 'subscription_retry_cadence_invalid' USING ERRCODE='22023';
  END IF;
 END LOOP;
 hours := (p_cadence->'backoffHours'->>o.retry_attempt)::numeric;
 next_time := CASE WHEN p_input->>'failureClass'='hard_do_not_retry' OR hours IS NULL THEN NULL
  ELSE at_time+hours*interval '1 hour' END;
 UPDATE public.subscription_retry_obligations SET retry_attempt=retry_attempt+1,state='waiting',next_retry_at=next_time,
  failure_class=p_input->>'failureClass',failure_reason=p_input->>'reason',failed_at=at_time,updated_at=at_time WHERE id=o.id RETURNING * INTO o;
 result:=to_jsonb(o);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'failure',seq,p_input,result);
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_retry_apply_failure(p_operation_id uuid,p_key text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RETURN public.subscription_retry_apply_failure(p_operation_id,p_key,p_input,'{"backoffHours":[24,72,168]}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_retry_open_case(p_operation_id uuid,p_template text,p_recovery_path text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; result jsonb; client uuid; i public.commerce_settlement_intents;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 IF o.id IS NULL OR o.retry_attempt=0 OR o.state='recovered' THEN RAISE EXCEPTION 'subscription_retry_failure_required'; END IF;
 -- Pause/cancel and late observations serialize on the subscription. Check the
 -- current cycle even after resume, before creating or propagating any case.
 IF NOT EXISTS(SELECT 1 FROM public.subscriptions s JOIN public.subscription_cycles c
  ON c.subscription_id=s.id WHERE s.id=o.subscription_id AND s.status='active'
   AND c.id=o.cycle_id AND c.status='payment_pending') THEN
  RAISE EXCEPTION 'subscription_dunning_subscription_cancelled' USING ERRCODE='55000';
 END IF;
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

CREATE OR REPLACE FUNCTION public.subscription_auto_resume_due(
  p_limit integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
 v_row record; v_subscription public.subscriptions; v_next_cycle_at timestamptz;
 v_event_id uuid; v_scanned integer:=0; v_resumed integer:=0;
 v_skipped integer:=0; v_failed integer:=0;
BEGIN
 FOR v_row IN
  SELECT w.id AS pause_window_id,w.subscription_id,w.pause_preset,w.ends_at
  FROM public.subscription_pause_windows w JOIN public.subscriptions s ON s.id=w.subscription_id
  WHERE s.status='paused' AND w.resumed_at IS NULL AND w.ends_at IS NOT NULL AND w.ends_at<=p_now
  ORDER BY w.ends_at,w.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),500)
  FOR UPDATE OF s,w SKIP LOCKED
 LOOP
  v_scanned:=v_scanned+1;
  BEGIN
   SELECT * INTO v_subscription FROM public.subscriptions WHERE id=v_row.subscription_id FOR UPDATE;
   IF NOT FOUND OR v_subscription.status<>'paused'
    OR NOT EXISTS(SELECT 1 FROM public.subscription_method_states m
      WHERE m.subscription_id=v_row.subscription_id AND m.health_state='healthy')
    OR v_subscription.next_cycle_at IS NULL OR coalesce(v_subscription.cadence_days,0)<=0
    OR NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=v_row.subscription_id)
    OR EXISTS(SELECT 1 FROM public.subscription_dunning_cases c WHERE c.subscription_id=v_row.subscription_id AND c.status='open')
    OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=v_row.subscription_id
      AND c.status='paid' AND c.scheduled_at=v_subscription.next_cycle_at)
    -- The native obligation keeps retry/failed state on a payment_pending cycle.
    OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=v_row.subscription_id AND c.status='payment_pending')
    OR EXISTS(SELECT 1 FROM public.commerce_orders o LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
      WHERE (c.subscription_id=v_row.subscription_id
       OR EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=o.renewal_operation_id AND op.subscription_id=v_row.subscription_id)
       OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.subscription_id=v_row.subscription_id))
       AND o.status IN ('paid','fulfillment_pending','fulfilled')
       AND (o.subscription_cycle_id IS NULL OR c.scheduled_at=v_subscription.next_cycle_at OR c.status IN ('payment_pending','paid')))
   THEN
    v_skipped:=v_skipped+1;
    CONTINUE;
   END IF;
   v_next_cycle_at:=v_subscription.next_cycle_at;
   IF v_next_cycle_at<=p_now THEN
    v_next_cycle_at:=v_next_cycle_at+((floor(extract(epoch FROM(p_now-v_next_cycle_at))
     /(v_subscription.cadence_days*86400.0))::bigint+1)*v_subscription.cadence_days||' days')::interval;
   END IF;
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(v_row.subscription_id,'subscription.system.auto_resume','subscription_auto_resume:'||v_row.pause_window_id::text,
    jsonb_build_object('action','auto_resume','pauseWindowId',v_row.pause_window_id,'pausePreset',v_row.pause_preset,
     'resumeAt',v_row.ends_at,'nextCycleAt',v_next_cycle_at,'policy',jsonb_build_object(
      'requiresPaymentMethod',true,'blocksOpenDunning',true,'blocksLockedUpcomingCycle',true)),p_now)
   ON CONFLICT(subscription_id,idempotency_key) DO NOTHING RETURNING id INTO v_event_id;
   UPDATE public.subscriptions SET status='active',next_cycle_at=v_next_cycle_at,updated_at=p_now WHERE id=v_row.subscription_id;
   UPDATE public.subscription_pause_windows SET resumed_at=p_now,updated_at=p_now,event_id=coalesce(v_event_id,event_id)
    WHERE id=v_row.pause_window_id AND resumed_at IS NULL;
   v_resumed:=v_resumed+1;
  EXCEPTION WHEN OTHERS THEN
   v_failed:=v_failed+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('ok',v_failed=0,'scanned',v_scanned,'resumed',v_resumed,'skippedRows',v_skipped,'failed',v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_retry_apply_failure(uuid,text,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_retry_apply_failure(uuid,text,jsonb,jsonb) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_retry_apply_failure(uuid,text,jsonb,jsonb) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_retry_apply_failure(uuid,text,jsonb,jsonb) TO service_role';
END IF; END; $$;
