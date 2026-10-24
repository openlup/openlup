-- Frozen stock waits use native M06 availability and reservations. Resumed means
-- paid realization admitted, never parcel arrival. No background consumer,
-- payment executor, pause, replacement confirmation or automatic delivery fact.
-- Disable the wait driver before rollback and retain captured obligations.
-- Donor: supabase/migrations/20261003123000_subscription_stock_wait.sql (87-126,
-- 260-298, 628-650), 20261003142320_subscription_stock_wait_unpaid_discovery.sql
-- (20-23, 116-195). Uncaptured selection rotates on operation.updated_at.
-- Native frozen recovery is pre-cycle only: operation snapshots
-- replace the managed unpaid cycle/order/payment graph; provider-owned graphs refuse.
CREATE TABLE public.subscription_stock_wait_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
 client_id uuid NOT NULL REFERENCES public.clients(id),
 renewal_operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_renewal_operations(id),
 scheduled_at timestamptz NOT NULL,
 cycle_number integer NOT NULL CHECK (cycle_number>0),
 state text NOT NULL CHECK (state IN ('waiting','stock_secured','resumed','closed')),
 due_snapshot jsonb NOT NULL,
 cycle_snapshot jsonb NOT NULL,
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
 identity_key text NOT NULL,
 deficits jsonb NOT NULL CHECK (jsonb_typeof(deficits)='array'),
 notice_messages jsonb NOT NULL DEFAULT '{}',
 refusal_observations jsonb NOT NULL DEFAULT '[]',
 cycle_id uuid REFERENCES public.subscription_cycles(id),
 order_id uuid REFERENCES public.commerce_orders(id),
 fulfillment_id uuid REFERENCES public.fulfillment_shipments(id),
 opened_at timestamptz NOT NULL DEFAULT now(),
 last_checked_at timestamptz NOT NULL DEFAULT now(),
 last_selected_at timestamptz,
 stock_secured_at timestamptz,
 resumed_at timestamptz,
 closed_at timestamptz,
 block_reason text,
 CONSTRAINT subscription_stock_wait_schedule_key UNIQUE(subscription_id,scheduled_at)
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscription_stock_wait_candidates_idx ON public.subscription_stock_wait_cases(state,last_selected_at,id);
REVOKE ALL ON TABLE public.subscription_stock_wait_cases FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.subscription_stock_wait_projection(p_case public.subscription_stock_wait_cases)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 SELECT to_jsonb(p_case)-'due_snapshot'-'cycle_snapshot'-'notice_messages';
$$;
CREATE FUNCTION public.subscription_stock_wait_read(p_case_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT public.subscription_stock_wait_projection(c)||jsonb_build_object('waitingNoticeRelevant',s.status='active' AND s.next_cycle_at=c.scheduled_at)
 FROM public.subscription_stock_wait_cases c JOIN public.subscriptions s ON s.id=c.subscription_id WHERE c.id=p_case_id;
$$;
CREATE FUNCTION public.subscription_stock_wait_frozen(p_subscription_id uuid,p_scheduled_at timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object('caseId',c.id,'operationId',op.id,'identityKey',op.identity_key,
  'operationFingerprint',op.operation_fingerprint,'snapshot',op.cycle_snapshot,'cycleNumber',op.cycle_number,
  'binding',jsonb_build_object('caseId',c.id,'cycleId',cycle.id,'orderId',ord.id,'paymentId',intent.id,'engineIdempotencyKey',op.identity_key))
 FROM public.subscription_renewal_operations op
 LEFT JOIN public.subscription_stock_wait_cases c ON c.renewal_operation_id=op.id
 LEFT JOIN public.subscription_cycles cycle ON cycle.renewal_operation_id=op.id
 LEFT JOIN public.commerce_orders ord ON ord.renewal_operation_id=op.id
 LEFT JOIN public.commerce_settlement_intents intent ON intent.renewal_operation_id=op.id
 WHERE op.subscription_id=p_subscription_id AND op.scheduled_at=p_scheduled_at
 AND EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.id=op.subscription_id
  AND s.status='active' AND s.next_cycle_at=p_scheduled_at)
 AND op.attempt_prepared_at IS NULL AND op.external_attempt_ref IS NULL
 AND cycle.id IS NULL AND ord.id IS NULL AND intent.id IS NULL
 AND (c.id IS NULL OR c.state IN ('waiting','stock_secured'))
 AND NOT EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes outcome WHERE outcome.renewal_operation_id=op.id
  AND (outcome.outcome<>'refused' OR outcome.reason NOT IN ('inventory_unavailable','reservation_expired') OR outcome.external_ref IS NOT NULL));
$$;

-- Credit the operation's live commitment exactly once, subtract every other
-- commitment, and preserve the complete frozen basket in the wait ledger.
CREATE FUNCTION public.subscription_stock_wait_deficits(p_snapshot jsonb,p_operation_id uuid,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE line record; stock public.fulfillment_stock_current; required bigint; own_qty bigint;
 available bigint; promise jsonb; result jsonb:='[]'; source text:=p_snapshot->>'stockSourceKey';
BEGIN
 IF jsonb_typeof(p_snapshot->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'lines')=0 OR source IS NULL THEN
  RAISE EXCEPTION 'stock_wait_invalid_basket' USING ERRCODE='22023'; END IF;
 PERFORM s.sku FROM public.fulfillment_stock_current s JOIN jsonb_array_elements(p_snapshot->'lines') l ON l->>'sku'=s.sku
  WHERE s.source_key=source ORDER BY s.sku FOR UPDATE OF s;
 FOR line IN SELECT l->>'sku' sku,sum((l->>'quantity')::integer) quantity FROM jsonb_array_elements(p_snapshot->'lines') l GROUP BY l->>'sku' ORDER BY l->>'sku' LOOP
  required:=line.quantity;
  IF required IS NULL OR required<1 OR btrim(COALESCE(line.sku,''))='' THEN RAISE EXCEPTION 'stock_wait_invalid_quantity'; END IF;
  SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=source AND sku=line.sku;
  IF stock.sku IS NULL THEN RAISE EXCEPTION 'stock_wait_stock_missing'; END IF;
  IF stock.stale_after<=p_now THEN RAISE EXCEPTION 'stock_wait_stock_stale'; END IF;
  SELECT COALESCE(sum(l.quantity),0) INTO own_qty
   FROM public.fulfillment_inventory_reservations r JOIN public.fulfillment_inventory_reservation_lines l ON l.reservation_id=r.id
   WHERE r.source_key=source AND l.sku=line.sku AND r.renewal_operation_id=p_operation_id
    AND (r.status='committed' OR (r.status='held' AND r.expires_at>p_now));
  promise:=public.inventory_available_to_promise(source,line.sku,p_now,true);
  available:=CASE WHEN stock.inventory_class='sellable' THEN (promise->>'available_quantity')::bigint ELSE 0 END;
  IF own_qty+available<required THEN
   result:=result||jsonb_build_array(jsonb_build_object('sku',line.sku,'requiredUnits',required,'reservedUnits',own_qty,
    'availableUnits',available,'missingUnits',required-own_qty-available));
  END IF;
 END LOOP;
 RETURN result;
END;
$$;
CREATE FUNCTION public.subscription_stock_wait_enqueue(p_case public.subscription_stock_wait_cases,p_kind text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF p_kind NOT IN ('started','resumed') THEN RAISE EXCEPTION 'stock_wait_event_invalid'; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('subscription_stock_wait',p_case.id,'subscription_stock_wait.'||p_kind,'subscription_stock_wait:'||p_case.id::text||':'||p_kind,
  jsonb_build_object('caseId',p_case.id,'clientId',p_case.client_id,'subscriptionId',p_case.subscription_id,
   'scheduledAt',p_case.scheduled_at,'deficits',p_case.deficits,'orderId',p_case.order_id),jsonb_build_object('source','subscription_stock_wait'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END;
$$;

-- This is a bounded stock-only reset. Stock-refusal observations are not payment
-- outcomes; any other outcome or business artifact refuses before mutation.
CREATE FUNCTION public.subscription_stock_wait_recover_refusal(p_operation_id uuid,p_fingerprint text,p_worker text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE s public.subscriptions; op public.subscription_renewal_operations; c public.subscription_stock_wait_cases;
 r public.fulfillment_inventory_reservations; deficits jsonb; token uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO s FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO c FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO r FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 IF op.id IS NULL OR s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM op.scheduled_at OR
  op.operation_fingerprint IS DISTINCT FROM p_fingerprint OR btrim(COALESCE(p_worker,''))='' OR
  (c.id IS NOT NULL AND (c.fingerprint<>op.operation_fingerprint OR c.cycle_snapshot<>op.cycle_snapshot OR c.identity_key<>op.identity_key OR c.state='closed')) THEN
  RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF c.state='stock_secured' AND op.state='reserved' AND r.status='held' AND r.expires_at>p_now AND op.lease_expires_at>p_now THEN
  RETURN public.subscription_renewal_operation_response(op,false,true,'stock_secured'); END IF;
 IF NOT COALESCE(((op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired')) OR
  (op.state='reserved' AND c.state='stock_secured' AND r.status='held')),false) OR op.lease_expires_at>p_now OR
  op.attempt_prepared_at IS NOT NULL OR op.external_attempt_ref IS NOT NULL OR op.external_attempt_acknowledged_at IS NOT NULL OR
  EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.commerce_orders WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id AND
   (outcome<>'refused' OR reason IS NULL OR reason NOT IN ('inventory_unavailable','reservation_expired') OR external_ref IS NOT NULL
    OR operation_fingerprint<>op.operation_fingerprint OR event_key NOT IN (op.identity_key||':inventory',op.identity_key||':reservation-expired'))) OR
  (r.id IS NOT NULL AND (r.operation_fingerprint<>p_fingerprint OR r.source_key IS DISTINCT FROM op.cycle_snapshot->>'stockSourceKey' OR (r.status NOT IN ('expired','released') AND NOT (r.status='held' AND c.state='stock_secured')))) THEN
  RAISE EXCEPTION 'stock_wait_recovery_provider_owned_or_not_eligible' USING ERRCODE='22023'; END IF;
 deficits:=public.subscription_stock_wait_deficits(op.cycle_snapshot,op.id,p_now);
 INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 VALUES(s.id,s.client_id,op.id,op.scheduled_at,op.cycle_number,'waiting',to_jsonb(op),op.cycle_snapshot,op.operation_fingerprint,op.identity_key,deficits,p_now,p_now)
 ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET deficits=EXCLUDED.deficits,last_checked_at=p_now RETURNING * INTO c;
 IF jsonb_array_length(deficits)>0 THEN
  UPDATE public.subscription_stock_wait_cases SET state='waiting',block_reason='inventory_unavailable' WHERE id=c.id RETURNING * INTO c;
  PERFORM public.subscription_stock_wait_enqueue(c,'started');
  RETURN jsonb_build_object('waiting',true,'caseId',c.id,'deficits',deficits);
 END IF;
 -- All effects inside this block roll back on a stock shortage. The wait row
 -- remains outside it; prior commitments are never released to try another SKU.
 BEGIN
  -- The base stock rail uses one local refusal key per schedule/reason. Archive
  -- those exact non-payment receipts before clearing them for this bounded
  -- reset, so a later expiry can reuse the original key without a unique-key
  -- failure. Provider/money outcomes are rejected above and never removed.
  UPDATE public.subscription_stock_wait_cases SET refusal_observations=refusal_observations||
   COALESCE((SELECT jsonb_agg(to_jsonb(observation) ORDER BY occurred_at,id) FROM public.subscription_renewal_outcomes observation WHERE renewal_operation_id=op.id),'[]'::jsonb)
   WHERE id=c.id;
  DELETE FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id;
  UPDATE public.subscription_renewal_operations SET state='claimed',terminal_outcome=NULL,terminal_reason=NULL,terminal_at=NULL,
   claim_token=token,claim_generation=claim_generation+1,claimed_by=p_worker,claimed_at=p_now,lease_expires_at=p_now+interval '5 minutes',updated_at=p_now WHERE id=op.id;
  IF r.id IS NULL THEN
   IF NOT (public.fulfillment_reserve_subscription_renewal(op.id,token,900,p_now)->>'reserved')::boolean THEN
    RAISE EXCEPTION 'stock_wait_atomic_shortage' USING ERRCODE='23514'; END IF;
  ELSE
   -- Restore exactly the expired reservation's original frozen lines.
   IF (SELECT jsonb_agg(jsonb_build_object('sku',sku,'quantity',quantity) ORDER BY sku) FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=r.id)
    IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('sku',l->>'sku','quantity',(l->>'quantity')::integer) ORDER BY l->>'sku') FROM jsonb_array_elements(op.cycle_snapshot->'lines') l) THEN
    RAISE EXCEPTION 'stock_wait_reservation_snapshot_mismatch'; END IF;
   UPDATE public.fulfillment_inventory_reservations SET status='held',expires_at=p_now+interval '15 minutes',terminal_reason=NULL,updated_at=p_now WHERE id=r.id;
   UPDATE public.subscription_renewal_operations SET state='reserved' WHERE id=op.id;
  END IF;
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'stock_wait_atomic_shortage' THEN RAISE; END IF;
  UPDATE public.subscription_stock_wait_cases SET block_reason='inventory_unavailable',state='waiting' WHERE id=c.id;
  RETURN jsonb_build_object('waiting',true,'caseId',c.id);
 END;
 UPDATE public.subscription_stock_wait_cases SET state='stock_secured',deficits='[]',block_reason=NULL,
  stock_secured_at=COALESCE(stock_secured_at,p_now),last_checked_at=p_now WHERE id=c.id;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=op.id;
 RETURN public.subscription_renewal_operation_response(op,true,false,'stock_secured')||jsonb_build_object('waiting',false,'caseId',c.id);
END;
$$;
CREATE FUNCTION public.subscription_stock_wait_admit(p_input jsonb,p_due jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE frozen jsonb; op public.subscription_renewal_operations; result jsonb; c public.subscription_stock_wait_cases;
BEGIN
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=(p_input->>'operationId')::uuid;
 frozen:=public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at);
 IF frozen IS NULL OR frozen->'snapshot' IS DISTINCT FROM p_input->'snapshot' OR
  frozen->>'operationFingerprint' IS DISTINCT FROM p_input->>'operationFingerprint' OR
  frozen->>'identityKey' IS DISTINCT FROM p_input->>'identityKey' OR
  (p_due ? 'stockWaitRecovery' AND frozen->'binding' IS DISTINCT FROM p_due->'stockWaitRecovery') THEN
  RAISE EXCEPTION 'stock_wait_frozen_binding_changed' USING ERRCODE='23505'; END IF;
 IF op.state='refused' OR (op.state='reserved' AND op.lease_expires_at<=p_now) THEN
  RETURN public.subscription_stock_wait_recover_refusal(op.id,op.operation_fingerprint,p_input->>'worker',p_now);
 END IF;
 IF op.state='reserved' THEN RETURN public.subscription_renewal_operation_response(op,false,true,'stock_secured'); END IF;
 result:=public.fulfillment_reserve_subscription_renewal(op.id,(p_input->>'claimToken')::uuid,900,p_now);
 IF (result->>'reserved')::boolean THEN RETURN result||jsonb_build_object('waiting',false); END IF;
 -- Record the wait immediately; lease expiry is still required before reset.
 INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 SELECT op.subscription_id,s.client_id,op.id,op.scheduled_at,op.cycle_number,'waiting',p_due,op.cycle_snapshot,
  op.operation_fingerprint,op.identity_key,public.subscription_stock_wait_deficits(op.cycle_snapshot,op.id,p_now),p_now,p_now
 FROM public.subscriptions s WHERE s.id=op.subscription_id
 ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET last_checked_at=p_now RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_enqueue(c,'started');
 RETURN result||jsonb_build_object('waiting',true,'caseId',c.id);
END;
$$;
-- Discover refused schedules even without a prior wait row. Oldest selected
-- waits rotate independently of the normal due cohort, preserving fairness.
CREATE FUNCTION public.subscription_stock_wait_candidates(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE result jsonb; row record;
BEGIN
 result:='[]';
 FOR row IN SELECT op.id,op.subscription_id,op.scheduled_at,c.id case_id FROM public.subscription_renewal_operations op
  JOIN public.subscriptions s ON s.id=op.subscription_id LEFT JOIN public.subscription_stock_wait_cases c ON c.renewal_operation_id=op.id
  WHERE s.status='active' AND s.next_cycle_at=op.scheduled_at AND op.lease_expires_at<=p_now
   AND ((op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired')) OR (op.state='reserved' AND c.state='stock_secured'))
   AND (c.id IS NULL OR c.state IN ('waiting','stock_secured'))
   AND public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at) IS NOT NULL
  ORDER BY CASE WHEN c.id IS NULL THEN op.updated_at ELSE c.last_selected_at END NULLS FIRST,op.scheduled_at,op.id LIMIT LEAST(GREATEST(p_limit,1),500)
 LOOP
  IF public.subscription_stock_wait_frozen(row.subscription_id,row.scheduled_at) IS NOT NULL THEN
   IF row.case_id IS NOT NULL THEN
    UPDATE public.subscription_stock_wait_cases SET last_selected_at=p_now WHERE id=row.case_id;
   ELSE
    PERFORM 1 FROM public.subscription_renewal_operations WHERE id=row.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.subscription_renewal_operations SET updated_at=p_now WHERE id=row.id;
   END IF;
   result:=result||jsonb_build_array(public.subscription_stock_wait_frozen(row.subscription_id,row.scheduled_at));
  END IF;
 END LOOP;
 -- Superseded/cancelled unpaid waits close; provider-owned/paid cases never do.
 UPDATE public.subscription_stock_wait_cases c SET state='closed',closed_at=p_now,block_reason='schedule_superseded'
 FROM public.subscriptions s,public.subscription_renewal_operations op WHERE s.id=c.subscription_id AND op.id=c.renewal_operation_id
  AND c.state IN ('waiting','stock_secured') AND (s.status='cancelled' OR s.next_cycle_at IS DISTINCT FROM c.scheduled_at)
  AND op.attempt_prepared_at IS NULL AND op.external_attempt_ref IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=op.id);
 RETURN result;
END;
$$;
CREATE FUNCTION public.subscription_stock_wait_normal_due(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.scheduled_at,d.subscription_id),'[]'::jsonb) FROM (
  SELECT subscription.id AS subscription_id, subscription.client_id, subscription.next_cycle_at AS scheduled_at,
         subscription.cadence_days, terms.next_cycle_number AS cycle_number, terms.currency_code,
         terms.stock_source_key, terms.settlement_channel_key, terms.authorization_ref,
         terms.payer_account_ref, terms.unattended_charge_authorized_at, terms.delivery_admission,
         terms.delivery_block_reason
    FROM public.subscriptions subscription
    JOIN public.subscription_renewal_terms terms ON terms.subscription_id=subscription.id
   WHERE subscription.status='active' AND subscription.next_cycle_at IS NOT NULL
     AND subscription.next_cycle_at<=COALESCE(p_now,now())
     AND NOT EXISTS(SELECT 1 FROM public.subscription_renewal_operations operation
      WHERE operation.subscription_id=subscription.id AND operation.scheduled_at=subscription.next_cycle_at
       AND (operation.state IN ('succeeded','refused') OR operation.lease_expires_at>COALESCE(p_now,now())))
     AND NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases c
      WHERE c.subscription_id=subscription.id AND c.scheduled_at=subscription.next_cycle_at AND c.state IN ('waiting','stock_secured'))
   ORDER BY subscription.next_cycle_at,subscription.id LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),500)
 ) d;
$$;
CREATE FUNCTION public.subscription_stock_wait_mark_resumed(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE c public.subscription_stock_wait_cases; shipment public.fulfillment_shipments;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=(SELECT renewal_operation_id FROM public.commerce_orders WHERE id=p_order_id)) FOR UPDATE;
 SELECT * INTO c FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=(SELECT renewal_operation_id FROM public.commerce_orders WHERE id=p_order_id) FOR UPDATE;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO shipment FROM public.fulfillment_shipments WHERE order_id=p_order_id AND replaces_shipment_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE;
 IF c.state='closed' OR EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=p_order_id AND status='pending_payment') THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=p_order_id AND status IN ('paid','fulfillment_pending','fulfilled')) OR
  NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=p_order_id AND status='settled') OR
  NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=c.renewal_operation_id AND status='paid') OR
  NOT EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=c.renewal_operation_id AND status='consumed') OR
  shipment.id IS NULL OR shipment.status IN ('cancelled','exception') OR
  EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=p_order_id AND status='active') THEN
  RAISE EXCEPTION 'stock_wait_realization_admission_missing' USING ERRCODE='22023'; END IF;
 IF c.state='resumed' THEN
  IF c.fulfillment_id IS DISTINCT FROM shipment.id THEN RAISE EXCEPTION 'stock_wait_fulfillment_replay_mismatch'; END IF;
  RETURN public.subscription_stock_wait_projection(c);
 END IF;
 IF c.state<>'stock_secured' THEN RAISE EXCEPTION 'stock_wait_stock_not_secured'; END IF;
 UPDATE public.subscription_stock_wait_cases SET state='resumed',resumed_at=now(),cycle_id=(SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=p_order_id),
  order_id=p_order_id,fulfillment_id=shipment.id WHERE id=c.id RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_enqueue(c,'resumed');
 RETURN public.subscription_stock_wait_projection(c);
END;
$$;
CREATE FUNCTION public.subscription_stock_wait_summary(p_state text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
 IF p_state NOT IN ('all','waiting','stock_secured','resumed','closed') THEN RAISE EXCEPTION 'stock_wait_summary_state_invalid'; END IF;
 RETURN jsonb_build_object('totalCount',(SELECT count(*) FROM public.subscription_stock_wait_cases WHERE p_state='all' OR state=p_state),
 'productTotals',COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT l->>'sku' sku,sum((l->>'missingUnits')::bigint) missing_units,
 count(DISTINCT c.id) affected_cases FROM public.subscription_stock_wait_cases c CROSS JOIN LATERAL jsonb_array_elements(c.deficits) l
 WHERE p_state='all' OR c.state=p_state GROUP BY l->>'sku') t),'[]'::jsonb));
END;
$$;
CREATE FUNCTION public.subscription_stock_wait_bind_notice(p_case_id uuid,p_event_id uuid,p_message jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE c public.subscription_stock_wait_cases; existing jsonb;
BEGIN
 SELECT * INTO c FROM public.subscription_stock_wait_cases WHERE id=p_case_id FOR UPDATE;
 IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE id=p_event_id AND aggregate_id=c.id
  AND aggregate_type='subscription_stock_wait' AND event_type IN ('subscription_stock_wait.started','subscription_stock_wait.resumed')) THEN
  RAISE EXCEPTION 'stock_wait_notice_binding_invalid'; END IF;
 existing:=c.notice_messages->p_event_id::text;
 IF existing IS NOT NULL THEN RETURN existing; END IF;
 IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['from','to','subject','html']) k WHERE btrim(COALESCE(p_message->>k,''))='') THEN
  RAISE EXCEPTION 'stock_wait_notice_message_invalid'; END IF;
 UPDATE public.subscription_stock_wait_cases SET notice_messages=jsonb_set(notice_messages,ARRAY[p_event_id::text],p_message) WHERE id=c.id;
 RETURN p_message;
END;
$$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_projection(public.subscription_stock_wait_cases) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_read(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_frozen(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_enqueue(public.subscription_stock_wait_cases,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_candidates(integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_normal_due(integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_mark_resumed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_summary(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_bind_notice(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
