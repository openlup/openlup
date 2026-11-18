-- Experimental, unbound successor identities and explicitly accepted generations.
CREATE TABLE public.catalog_sku_successors (
 predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
 successor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
 publication_id uuid NOT NULL REFERENCES public.catalog_publications(id) ON DELETE RESTRICT,
 PRIMARY KEY (predecessor_sku_id,successor_sku_id),
 CHECK (predecessor_sku_id <> successor_sku_id)
);
ALTER TABLE public.catalog_sku_successors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_sku_successors FROM PUBLIC;

CREATE TABLE public.subscription_successor_proposals (
 id uuid PRIMARY KEY,
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
 predecessor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
 successor_sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
 publication_id uuid NOT NULL REFERENCES public.catalog_publications(id) ON DELETE RESTRICT,
 source_binding jsonb NOT NULL CHECK (jsonb_typeof(source_binding) = 'object'),
 template_version integer NOT NULL CHECK (template_version BETWEEN 1 AND 2147483647),
 lane text NOT NULL CHECK (length(btrim(lane)) BETWEEN 1 AND 80),
 action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 80),
 request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
 preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
 quote_hash text NOT NULL CHECK (length(quote_hash) = 64 AND translate(quote_hash,'abcdef0123456789','') = ''),
 expires_at timestamptz NOT NULL,
 original_case_id uuid REFERENCES public.subscription_stock_wait_cases(id) ON DELETE RESTRICT,
 original_operation_id uuid REFERENCES public.subscription_renewal_operations(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','accepted','declined','expired')),
 consent jsonb,
 accepted_receipt jsonb,
 terminal_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.subscription_successor_operations_v2 (
 id uuid PRIMARY KEY,
 root_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(id) ON DELETE RESTRICT,
 proposal_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT,
 predecessor_generation_id uuid REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
 scheduled_at timestamptz NOT NULL,
 cycle_number integer NOT NULL CHECK (cycle_number BETWEEN 1 AND 2147483647),
 identity_key text NOT NULL UNIQUE CHECK (length(identity_key) BETWEEN 48 AND 240),
 operation_fingerprint text NOT NULL CHECK (length(operation_fingerprint) = 64 AND translate(operation_fingerprint,'abcdef0123456789','') = ''),
 due_snapshot jsonb NOT NULL CHECK (jsonb_typeof(due_snapshot) = 'object'),
 cycle_snapshot jsonb NOT NULL CHECK (jsonb_typeof(cycle_snapshot) = 'object'),
 state text NOT NULL CHECK (state IN ('claimed','reserved','attempt_prepared','succeeded','refused')),
 claim_token uuid NOT NULL,
 claim_generation bigint NOT NULL DEFAULT 1 CHECK (claim_generation BETWEEN 1 AND 9223372036854775807),
 claimed_by text NOT NULL CHECK (length(btrim(claimed_by)) BETWEEN 1 AND 240),
 claimed_at timestamptz NOT NULL,
 lease_expires_at timestamptz NOT NULL,
 attempt_prepared_at timestamptz,
 external_attempt_ref text,
 external_attempt_acknowledged_at timestamptz,
 terminal_outcome text,
 terminal_reason text,
 terminal_at timestamptz,
 outcomes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(outcomes) = 'array'),
 superseded_by_proposal_id uuid REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT,
 cycle_id uuid UNIQUE REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT,
 order_id uuid UNIQUE REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
 settlement_intent_id uuid UNIQUE REFERENCES public.commerce_settlement_intents(id) ON DELETE RESTRICT,
 fulfillment_id uuid UNIQUE REFERENCES public.fulfillment_shipments(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscription_successor_operations_v2_live_root_key
 ON public.subscription_successor_operations_v2(root_operation_id) WHERE superseded_by_proposal_id IS NULL;
CREATE INDEX subscription_successor_operations_v2_due_idx
 ON public.subscription_successor_operations_v2(state,lease_expires_at,scheduled_at);
CREATE TABLE public.subscription_successor_wait_cases_v2 (
 id uuid PRIMARY KEY,
 root_case_id uuid NOT NULL REFERENCES public.subscription_stock_wait_cases(id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
 scheduled_at timestamptz NOT NULL,
 cycle_number integer NOT NULL CHECK (cycle_number BETWEEN 1 AND 2147483647),
 state text NOT NULL CHECK (state IN ('waiting','stock_secured','resumed','closed')),
 due_snapshot jsonb NOT NULL CHECK (jsonb_typeof(due_snapshot) = 'object'),
 cycle_snapshot jsonb NOT NULL CHECK (jsonb_typeof(cycle_snapshot) = 'object'),
 fingerprint text NOT NULL CHECK (length(fingerprint) = 64 AND translate(fingerprint,'abcdef0123456789','') = ''),
 identity_key text NOT NULL,
 deficits jsonb NOT NULL CHECK (jsonb_typeof(deficits) = 'array'),
 notice_messages jsonb NOT NULL DEFAULT '{}',
 refusal_observations jsonb NOT NULL DEFAULT '[]',
 cycle_id uuid REFERENCES public.subscription_cycles(id) ON DELETE RESTRICT,
 order_id uuid REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
 fulfillment_id uuid REFERENCES public.fulfillment_shipments(id) ON DELETE RESTRICT,
 opened_at timestamptz NOT NULL DEFAULT now(),
 last_checked_at timestamptz NOT NULL DEFAULT now(),
 last_selected_at timestamptz,
 stock_secured_at timestamptz,
 resumed_at timestamptz,
 closed_at timestamptz,
 block_reason text,
 superseded_by_proposal_id uuid REFERENCES public.subscription_successor_proposals(id) ON DELETE RESTRICT
);
CREATE INDEX subscription_successor_wait_cases_v2_candidates_idx
 ON public.subscription_successor_wait_cases_v2(state,last_selected_at,id);
CREATE TABLE public.subscription_successor_reservations_v2 (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_successor_operations_v2(id) ON DELETE RESTRICT,
 operation_fingerprint text NOT NULL CHECK (length(operation_fingerprint) = 64 AND translate(operation_fingerprint,'abcdef0123456789','') = ''),
 source_key text NOT NULL CHECK (length(btrim(source_key)) BETWEEN 1 AND 120),
 lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
 status text NOT NULL CHECK (status IN ('held','committed','consumed','released','expired')),
 expires_at timestamptz,
 terminal_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_successor_reservations_v2_stock_idx
 ON public.subscription_successor_reservations_v2(source_key,status,expires_at);

ALTER TABLE public.subscription_successor_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_successor_operations_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_successor_wait_cases_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_successor_reservations_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_successor_proposals FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_successor_operations_v2 FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_successor_wait_cases_v2 FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_successor_reservations_v2 FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_projection_v2(p_case public.subscription_successor_wait_cases_v2)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 SELECT CASE WHEN to_jsonb(p_case) IS NULL THEN NULL ELSE
 jsonb_build_object('schemaVersion',2,'caseKind','successor','case',
 to_jsonb(p_case)-'due_snapshot'-'cycle_snapshot'-'notice_messages') END;
$$;
CREATE FUNCTION public.subscription_successor_operation_snapshot_v2(p_op public.subscription_successor_operations_v2)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 SELECT CASE WHEN to_jsonb(p_op) IS NULL THEN NULL ELSE jsonb_build_object(
 'schemaVersion',2,'operationKind','successor','operationId',p_op.id,
 'rootOperationId',p_op.root_operation_id,'proposalId',p_op.proposal_id,
 'identityKey',p_op.identity_key,'operationFingerprint',p_op.operation_fingerprint,
 'subscriptionId',p_op.subscription_id,'scheduledAt',p_op.scheduled_at,
 'cycleNumber',p_op.cycle_number,'cycleSnapshot',p_op.cycle_snapshot) END;
$$;

CREATE OR REPLACE FUNCTION public.communication_paid_fact(p_order public.commerce_orders)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_intent_id uuid; matches integer; snapshot jsonb; kind text; lines jsonb; total numeric; op public.subscription_renewal_operations;
 gen public.subscription_successor_operations_v2; gen_proposal public.subscription_successor_proposals;
 gen_root public.subscription_renewal_operations; gen_cycle public.subscription_cycles; gen_subscription public.subscriptions;
BEGIN
 IF p_order.client_id IS NULL OR p_order.paid_at IS NULL OR p_order.source_kind IS DISTINCT FROM 'storefront'
  OR p_order.currency_code !~ '^[A-Z]{3}$' OR p_order.total_amount_minor NOT BETWEEN 0 AND 9007199254740991 THEN
  RETURN jsonb_build_object('state','incomplete','reason','order_evidence'); END IF;
 SELECT count(*),min(i.id::text)::uuid INTO matches,v_intent_id FROM public.commerce_settlement_intents i
 WHERE i.order_id=p_order.id AND i.status='settled' AND i.settled_at=p_order.paid_at
  AND i.currency_code=p_order.currency_code AND i.amount_minor=p_order.total_amount_minor;
 IF matches<>1 THEN RETURN jsonb_build_object('state','incomplete','reason','settlement_evidence'); END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_settlement_transitions WHERE commerce_settlement_transitions.intent_id=v_intent_id AND outcome='succeeded') THEN
  RETURN jsonb_build_object('state','incomplete','reason','paid_boundary_missing'); END IF;
 IF p_order.renewal_operation_id IS NOT NULL THEN
  SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_order.renewal_operation_id;
  IF NOT FOUND OR op.operation_fingerprint IS DISTINCT FROM p_order.renewal_operation_fingerprint
   OR op.cycle_snapshot->>'currency' IS DISTINCT FROM p_order.currency_code
   OR (op.cycle_snapshot->>'totalAmountMinor')::numeric IS DISTINCT FROM p_order.total_amount_minor THEN
   RETURN jsonb_build_object('state','incomplete','reason','renewal_evidence'); END IF;
  kind:='renewal'; snapshot:=op.cycle_snapshot;
 ELSIF p_order.subscription_cycle_id IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.subscription_successor_operations_v2 g WHERE g.order_id=p_order.id) THEN
  -- This relation owns only freshly inserted successor graphs; never backfill a legacy order.
  SELECT * INTO gen FROM public.subscription_successor_operations_v2 WHERE order_id=p_order.id;
  SELECT * INTO gen_proposal FROM public.subscription_successor_proposals WHERE id=gen.proposal_id;
  SELECT * INTO gen_root FROM public.subscription_renewal_operations WHERE id=gen.root_operation_id;
  SELECT * INTO gen_cycle FROM public.subscription_cycles WHERE id=gen.cycle_id;
  SELECT * INTO gen_subscription FROM public.subscriptions WHERE id=gen.subscription_id;
  IF gen.id IS NULL OR gen_proposal.id IS NULL OR gen_root.id IS NULL OR gen_cycle.id IS NULL OR gen_subscription.id IS NULL
   OR gen.superseded_by_proposal_id IS NOT NULL
   OR gen.order_id IS DISTINCT FROM p_order.id OR gen.cycle_id IS DISTINCT FROM p_order.subscription_cycle_id
   OR gen.settlement_intent_id IS DISTINCT FROM v_intent_id
   OR p_order.renewal_operation_fingerprint IS NOT NULL
   OR gen_proposal.state IS DISTINCT FROM 'accepted' OR gen_proposal.accepted_receipt IS NULL OR gen_proposal.consent IS NULL
   OR gen_proposal.original_operation_id IS DISTINCT FROM gen.root_operation_id
   OR gen_proposal.subscription_id IS DISTINCT FROM gen.subscription_id OR gen_proposal.client_id IS DISTINCT FROM p_order.client_id
   OR gen_root.subscription_id IS DISTINCT FROM gen.subscription_id OR gen_root.scheduled_at IS DISTINCT FROM gen.scheduled_at
   OR gen_root.cycle_number IS DISTINCT FROM gen.cycle_number
   OR gen_cycle.subscription_id IS DISTINCT FROM gen.subscription_id OR gen_cycle.scheduled_at IS DISTINCT FROM gen.scheduled_at
   OR gen_cycle.renewal_operation_id IS NOT NULL OR gen_cycle.renewal_operation_fingerprint IS NOT NULL
   OR gen_subscription.client_id IS DISTINCT FROM p_order.client_id
   OR NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.id=v_intent_id
     AND i.order_id=p_order.id AND i.renewal_operation_id IS NULL AND i.renewal_operation_fingerprint IS NULL)
   OR gen.cycle_snapshot->>'currency' IS DISTINCT FROM p_order.currency_code
   OR (gen.cycle_snapshot->>'totalAmountMinor')::numeric IS DISTINCT FROM p_order.total_amount_minor THEN
   RETURN jsonb_build_object('state','incomplete','reason','renewal_evidence'); END IF;
  kind:='renewal'; snapshot:=gen.cycle_snapshot;
 ELSE
  snapshot:=p_order.metadata->'orderDraftSnapshot';
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'currency' IS DISTINCT FROM p_order.currency_code
   OR (snapshot#>>'{totals,totalGross,amountMinor}')::numeric IS DISTINCT FROM p_order.total_amount_minor THEN
   RETURN jsonb_build_object('state','incomplete','reason','acquisition_evidence'); END IF;
  kind:=CASE snapshot#>>'{context,mode}' WHEN 'subscription' THEN 'subscription_initial' WHEN 'one_time' THEN 'one_time' ELSE NULL END;
  IF kind IS NULL OR (kind='subscription_initial' AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a
    WHERE a.order_id=p_order.id AND a.client_id=p_order.client_id AND a.state IN ('provisional','active')))
   OR (kind='one_time' AND EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=p_order.id))
   OR p_order.subscription_cycle_id IS NOT NULL THEN
   RETURN jsonb_build_object('state','incomplete','reason','purchase_classification'); END IF;
 END IF;
 IF jsonb_typeof(snapshot->'lines') IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('state','incomplete','reason','line_evidence'); END IF;
 SELECT jsonb_agg(jsonb_build_object('sku',snapshot#>>ARRAY['lines',(coalesce(i.source_line_ordinal,i.line_ordinal)-1)::text,'sku'],
  'quantity',i.quantity,'amountMinor',i.line_amount_minor) ORDER BY i.line_ordinal),sum(i.line_amount_minor)
 INTO lines,total FROM public.commerce_order_items i WHERE i.order_id=p_order.id;
 IF lines IS NULL OR jsonb_array_length(lines) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) line
  WHERE nullif(line->>'sku','') IS NULL OR length(line->>'sku')>180 OR (line->>'quantity')::numeric<1
   OR (line->>'amountMinor')::numeric NOT BETWEEN 0 AND 9007199254740991) THEN
  RETURN jsonb_build_object('state','incomplete','reason','line_evidence'); END IF;
 SELECT total+coalesce(sum(CASE WHEN a.kind='shipping_charge' THEN a.amount_minor
  WHEN a.kind='promotion_discount' AND a.scope='shipping' THEN -a.amount_minor ELSE 0 END),0)
 INTO total FROM public.commerce_order_adjustments a WHERE a.order_id=p_order.id;
 IF total IS DISTINCT FROM p_order.total_amount_minor THEN RETURN jsonb_build_object('state','incomplete','reason','line_total'); END IF;
 RETURN jsonb_build_object('state','complete','event',jsonb_build_object('schemaVersion',1,'sourceId','paid:'||p_order.id,
  'sourceType','order.paid','occurredAt',to_char(p_order.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'subject',jsonb_build_object('clientId',p_order.client_id),'data',jsonb_build_object('orderId',p_order.id,
   'settlementIntentId',v_intent_id,'purchaseKind',kind,'amountMinor',p_order.total_amount_minor,'currency',p_order.currency_code,'lines',lines)));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN
 RETURN jsonb_build_object('state','incomplete','reason','invalid_source_evidence');
END; $$;

CREATE FUNCTION public.subscription_stock_wait_record_opened(p_case public.subscription_stock_wait_cases)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_case.state NOT IN ('waiting','stock_secured') THEN RETURN; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('subscription_stock_wait',p_case.id,'subscription_stock_wait.opened.v1',
  'subscription_stock_wait:'||p_case.id::text||':opened:v1',
  jsonb_build_object('caseId',p_case.id,'subscriptionId',p_case.subscription_id,'clientId',p_case.client_id,
   'operationId',p_case.renewal_operation_id,'identityKey',p_case.identity_key,'frozenFingerprint',p_case.fingerprint,'scheduledAt',p_case.scheduled_at),
  jsonb_build_object('source','subscription_stock_wait','contractVersion','subscription.stock-wait-opened.v1'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_record_opened(public.subscription_stock_wait_cases) FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_record_opened_v2(p_case public.subscription_successor_wait_cases_v2) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_case.state NOT IN ('waiting','stock_secured') THEN RETURN; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('subscription_stock_wait',p_case.id,'subscription_stock_wait.opened.v2','subscription_stock_wait:'||p_case.id::text||':opened:v2',
  jsonb_build_object('schemaVersion',2,'caseKind','successor','caseId',p_case.id,'operationId',p_case.operation_id,
   'subscriptionId',p_case.subscription_id,'clientId',p_case.client_id,'identityKey',p_case.identity_key,'frozenFingerprint',p_case.fingerprint,'scheduledAt',p_case.scheduled_at),jsonb_build_object('source','subscription_stock_wait'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_record_opened_v2(public.subscription_successor_wait_cases_v2) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_admit(p_input jsonb,p_due jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE frozen jsonb; op public.subscription_renewal_operations; result jsonb; c public.subscription_stock_wait_cases;
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
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
 PERFORM public.subscription_stock_wait_record_opened(c);
 PERFORM public.subscription_stock_wait_enqueue(c,'started');
 RETURN result||jsonb_build_object('waiting',true,'caseId',c.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_recover_refusal(p_operation_id uuid,p_fingerprint text,p_worker text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE s public.subscriptions; op public.subscription_renewal_operations; c public.subscription_stock_wait_cases;
 r public.fulfillment_inventory_reservations; deficits jsonb; token uuid:=gen_random_uuid();
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
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
 PERFORM public.subscription_stock_wait_record_opened(c);
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

CREATE OR REPLACE FUNCTION public.inventory_available_to_promise(
 p_source_key text, p_sku text, p_as_of timestamptz, p_for_subscription_renewal boolean
)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 WITH live_holds AS (
  SELECT r.renewal_operation_id,NULL::uuid successor_operation_id,l.quantity
  FROM public.fulfillment_inventory_reservations r
  JOIN public.fulfillment_inventory_reservation_lines l ON l.reservation_id=r.id
  WHERE r.source_key=p_source_key AND l.sku=p_sku
   AND (r.status='committed' OR (r.status='held' AND r.expires_at>p_as_of))
  UNION ALL
  SELECT NULL::uuid,r.operation_id,(l->>'quantity')::integer FROM public.subscription_successor_reservations_v2 r
  CROSS JOIN LATERAL jsonb_array_elements(r.lines) l
  WHERE r.source_key=p_source_key AND l->>'sku'=p_sku
   AND (r.status='committed' OR (r.status='held' AND r.expires_at>p_as_of))
 ), components AS (
  SELECT COALESCE((SELECT stock.for_sale_quantity FROM public.fulfillment_stock_current stock
    WHERE stock.source_key=p_source_key AND stock.sku=p_sku
     AND stock.inventory_class='sellable' AND stock.stale_after>p_as_of),0)::bigint for_sale,
   (SELECT COALESCE(sum(quantity),0) FROM live_holds)::bigint hard_holds,
   (SELECT COALESCE(sum(GREATEST(0,due.quantity-credited.quantity)),0)::bigint
    FROM (
     SELECT s.id,s.next_cycle_at,sum(l.quantity) quantity
     FROM public.subscriptions s
     JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
     JOIN public.subscription_renewal_term_lines l ON l.subscription_id=s.id
     WHERE s.status='active' AND s.next_cycle_at<=p_as_of+interval '14 days'
      AND t.stock_source_key=p_source_key AND l.sku=p_sku
     GROUP BY s.id,s.next_cycle_at
    ) due CROSS JOIN LATERAL (
     SELECT COALESCE(sum(h.quantity),0) quantity FROM live_holds h
     LEFT JOIN public.subscription_renewal_operations op ON op.id=h.renewal_operation_id
     LEFT JOIN public.subscription_successor_operations_v2 g ON g.id=h.successor_operation_id
     WHERE coalesce(op.subscription_id,g.subscription_id)=due.id AND coalesce(op.scheduled_at,g.scheduled_at)=due.next_cycle_at
      AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles c
       WHERE (c.renewal_operation_id=op.id OR c.id=g.cycle_id) AND c.status IN ('paid','skipped','cancelled'))
    ) credited) soft_demand,
   (public.inventory_channel_exposure_quantity(p_source_key,p_sku)#>>'{}')::bigint exposure
 )
 SELECT jsonb_build_object('available_quantity',GREATEST(0,for_sale-hard_holds
   -CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END-exposure),
  'for_sale_quantity',for_sale,'hard_hold_quantity',hard_holds,'safety_quantity',0,
  'soft_subscription_demand_quantity',soft_demand,'channel_exposure_quantity',exposure)
 FROM components;
$$;

CREATE OR REPLACE FUNCTION public.catalog_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; obligations jsonb := '[]'; item record; lines jsonb; line jsonb;
 marker jsonb; basis integer; matching boolean; unknown boolean := false; source_subscription uuid;
BEGIN
 SELECT * INTO sku FROM public.catalog_skus WHERE id=p_sku_id;
 IF NOT FOUND OR sku.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR sku.publication_facts->>'code' IS DISTINCT FROM sku.sku THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 -- Filtered evidence is not proof of absence. No browser/service role is granted this routine.
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[
  'public.subscriptions'::regclass,'public.subscription_lines'::regclass,'public.subscription_renewal_term_lines'::regclass,
  'public.subscription_activations'::regclass,'public.subscription_renewal_attachments'::regclass,'public.subscription_renewal_operations'::regclass,
  'public.subscription_cycles'::regclass,'public.commerce_orders'::regclass,'public.commerce_order_items'::regclass,
  'public.fulfillment_shipments'::regclass,'public.fulfillment_parcel_lines'::regclass,'public.subscription_stock_wait_cases'::regclass,
  'public.subscription_successor_operations_v2'::regclass,'public.subscription_successor_wait_cases_v2'::regclass,
  'public.subscription_events'::regclass,'public.subscription_edit_quotes'::regclass,'public.subscription_quote_previews'::regclass]) AND (row_security_active(c.oid) OR NOT pg_has_role(current_user,c.relowner,'USAGE'))) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unavailable','reason','catalog_obligation_evidence_unavailable');
 END IF;
 FOR item IN
  SELECT DISTINCT s.id,sl.catalog_sku_revision_id AS revision FROM public.subscriptions s JOIN public.subscription_lines sl ON sl.subscription_id=s.id
   WHERE s.status IN ('active','paused') AND sl.variant_id=sku.id
  UNION
  SELECT s.id,NULL::uuid FROM public.subscriptions s JOIN public.subscription_renewal_term_lines tl ON tl.subscription_id=s.id
   WHERE s.status IN ('active','paused') AND tl.sku=sku.sku
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','template','sourceId',item.id,'subscriptionId',item.id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',item.revision));
 END LOOP;
 FOR item IN
  SELECT a.order_id AS id,a.subscription_id FROM public.subscription_activations a
   LEFT JOIN public.subscription_renewal_attachments attachment ON attachment.order_id=a.order_id
   WHERE a.state<>'compensated' AND (a.state<>'active' OR attachment.completed_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=a.order_id AND i.sku_id=sku.id)
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','pending_activation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.subscription_activations a LEFT JOIN public.subscription_renewal_attachments attachment ON attachment.order_id=a.order_id
  WHERE a.state<>'compensated' AND (a.state<>'active' OR attachment.completed_at IS NULL)
   AND (NOT EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=a.order_id) OR EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=a.order_id AND i.sku_id IS NULL))) THEN unknown:=true; END IF;
 FOR item IN
  SELECT op.id,op.subscription_id,op.cycle_snapshot FROM public.subscription_renewal_operations op
   WHERE op.state NOT IN ('succeeded','refused') OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.renewal_operation_id=op.id AND c.status IN ('planned','payment_pending'))
  UNION ALL
  SELECT g.id,g.subscription_id,g.cycle_snapshot FROM public.subscription_successor_operations_v2 g
   WHERE g.superseded_by_proposal_id IS NULL AND (g.state NOT IN ('succeeded','refused') OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.id=g.cycle_id AND c.status IN ('planned','payment_pending')))
 LOOP
  lines:=item.cycle_snapshot->'lines';
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN unknown:=true; CONTINUE; END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(coalesce(line->'sku',line->'skuCode')) IS DISTINCT FROM 'string' OR coalesce(line->>'quantity',line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF coalesce(line->>'sku',line->>'skuCode')=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array(jsonb_build_object('family','frozen_renewal','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items i JOIN public.commerce_orders o ON o.id=i.order_id WHERE o.status IN ('paid','fulfillment_pending','fulfilled') AND i.sku_id IS NULL) THEN unknown:=true; END IF;
 FOR item IN
  SELECT DISTINCT o.id,c.subscription_id FROM public.commerce_orders o
   LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   JOIN public.commerce_order_items i ON i.order_id=o.id
   WHERE o.status IN ('paid','fulfillment_pending','fulfilled') AND i.sku_id=sku.id
    AND (NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments parcel WHERE parcel.order_id=o.id)
     OR EXISTS(SELECT 1 FROM public.fulfillment_shipments parcel WHERE parcel.order_id=o.id AND parcel.delivered_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id=parcel.id)))
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','outstanding_order','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 FOR item IN
  SELECT DISTINCT parcel.id,c.subscription_id FROM public.fulfillment_shipments parcel
   JOIN public.fulfillment_parcel_lines l ON l.shipment_id=parcel.id
   JOIN public.commerce_orders o ON o.id=parcel.order_id LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   WHERE parcel.replaces_shipment_id IS NOT NULL AND parcel.delivered_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id=parcel.id)
    AND (l.sku_id=sku.id OR l.sku=sku.sku)
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','replacement','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.fulfillment_shipments p WHERE p.replaces_shipment_id IS NOT NULL AND p.delivered_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments next WHERE next.replaces_shipment_id=p.id)
  AND (NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines l WHERE l.shipment_id=p.id)
   OR EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines l WHERE l.shipment_id=p.id AND l.sku_id IS NULL AND nullif(l.sku,'') IS NULL))) THEN unknown:=true; END IF;
 FOR item IN SELECT id,subscription_id,cycle_snapshot,false AS successor FROM public.subscription_stock_wait_cases WHERE state IN ('waiting','stock_secured') OR (state='resumed' AND order_id IS NULL)
  UNION ALL SELECT id,subscription_id,cycle_snapshot,true FROM public.subscription_successor_wait_cases_v2 WHERE superseded_by_proposal_id IS NULL AND (state IN ('waiting','stock_secured') OR (state='resumed' AND order_id IS NULL))
 LOOP
  lines:=item.cycle_snapshot->'lines';
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN unknown:=true; CONTINUE; END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(coalesce(line->'sku',line->'skuCode')) IS DISTINCT FROM 'string' OR coalesce(line->>'quantity',line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF coalesce(line->>'sku',line->>'skuCode')=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array((jsonb_build_object('family','stock_wait','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)||CASE WHEN item.successor THEN jsonb_build_object('caseKind','successor') ELSE '{}'::jsonb END)); END IF;
 END LOOP;
 FOR item IN SELECT a.order_id AS id,a.subscription_id,a.purchase_facts,s.template_version FROM public.subscription_renewal_attachments a
  JOIN public.subscriptions s ON s.id=a.subscription_id WHERE s.status IN ('active','paused') AND a.purchase_facts#>'{renewalTerms,starterPack}' IS NOT NULL
 LOOP
  marker:=item.purchase_facts#>'{renewalTerms,starterPack}'; lines:=marker#>'{graduation,lines}';
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0
   OR coalesce(marker->>'basisTemplateVersion','') !~ '^[1-9][0-9]{0,8}$' THEN unknown:=true; CONTINUE; END IF;
  basis:=(marker->>'basisTemplateVersion')::integer;
  IF basis<>item.template_version THEN
   -- Only an accepted event explicitly consuming this exact retained basis proves discharge.
   IF EXISTS(SELECT 1 FROM public.subscription_events e WHERE e.subscription_id=item.subscription_id
    AND e.payload->'templateVersion'=to_jsonb(item.template_version)
    AND ((EXISTS(SELECT 1 FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=e.id AND q.subscription_id=item.subscription_id AND q.status='accepted' AND q.expected_template_version=basis))
      OR (EXISTS(SELECT 1 FROM public.subscription_quote_previews q WHERE q.accepted_event_id=e.id AND q.subscription_id=item.subscription_id AND q.status='accepted' AND q.template_version=basis)))) THEN CONTINUE; END IF;
   unknown:=true; CONTINUE;
  END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(line->'sku') IS DISTINCT FROM 'string' OR coalesce(line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF line->>'sku'=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array(jsonb_build_object('family','graduation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)); END IF;
 END LOOP;
 IF unknown THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 RETURN jsonb_build_object('schemaVersion',2,'outcome','complete','obligations',obligations);
END;
$$;

CREATE FUNCTION public.subscription_successor_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE proposal public.subscription_successor_proposals; root public.subscription_renewal_operations;
 generation public.subscription_successor_operations_v2; s public.subscriptions; before_row jsonb; after_row jsonb;
 basket jsonb; line jsonb; predecessor public.subscription_successor_operations_v2;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'successor_history_immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='catalog_sku_successors' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'successor_history_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 after_row:=to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN
  before_row:=to_jsonb(OLD);
  IF TG_TABLE_NAME='subscription_successor_proposals' THEN
   IF before_row-ARRAY['state','consent','accepted_receipt','terminal_at'] IS DISTINCT FROM after_row-ARRAY['state','consent','accepted_receipt','terminal_at']
    OR OLD.state<>'offered' AND before_row IS DISTINCT FROM after_row THEN
    RAISE EXCEPTION 'successor_proposal_immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='subscription_successor_operations_v2' THEN
   IF before_row-ARRAY['state','claim_token','claim_generation','claimed_by','claimed_at','lease_expires_at','attempt_prepared_at','external_attempt_ref','external_attempt_acknowledged_at','terminal_outcome','terminal_reason','terminal_at','outcomes','superseded_by_proposal_id','cycle_id','order_id','settlement_intent_id','fulfillment_id','updated_at']
    IS DISTINCT FROM after_row-ARRAY['state','claim_token','claim_generation','claimed_by','claimed_at','lease_expires_at','attempt_prepared_at','external_attempt_ref','external_attempt_acknowledged_at','terminal_outcome','terminal_reason','terminal_at','outcomes','superseded_by_proposal_id','cycle_id','order_id','settlement_intent_id','fulfillment_id','updated_at']
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['cycle_id','order_id','settlement_intent_id','fulfillment_id','superseded_by_proposal_id']) k WHERE before_row->k<>'null'::jsonb AND before_row->k IS DISTINCT FROM after_row->k)
    OR jsonb_array_length(NEW.outcomes)<jsonb_array_length(OLD.outcomes)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.outcomes) WITH ORDINALITY x(v,n) WHERE NEW.outcomes->(n::integer-1) IS DISTINCT FROM v) THEN
    RAISE EXCEPTION 'successor_operation_immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='subscription_successor_wait_cases_v2' THEN
   IF before_row-ARRAY['state','deficits','notice_messages','refusal_observations','cycle_id','order_id','fulfillment_id','last_checked_at','last_selected_at','stock_secured_at','resumed_at','closed_at','block_reason','superseded_by_proposal_id']
    IS DISTINCT FROM after_row-ARRAY['state','deficits','notice_messages','refusal_observations','cycle_id','order_id','fulfillment_id','last_checked_at','last_selected_at','stock_secured_at','resumed_at','closed_at','block_reason','superseded_by_proposal_id'] THEN
    RAISE EXCEPTION 'successor_wait_immutable' USING ERRCODE='23514'; END IF;
  ELSE
   IF before_row-ARRAY['status','expires_at','terminal_reason','updated_at'] IS DISTINCT FROM after_row-ARRAY['status','expires_at','terminal_reason','updated_at']
    OR OLD.status='consumed' AND before_row IS DISTINCT FROM after_row THEN
    RAISE EXCEPTION 'successor_reservation_immutable' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='subscription_successor_proposals' THEN
  SELECT * INTO s FROM public.subscriptions WHERE id=NEW.subscription_id;
  IF s.id IS NULL OR s.client_id IS DISTINCT FROM NEW.client_id OR NOT EXISTS(SELECT 1 FROM public.catalog_sku_successors
   WHERE predecessor_sku_id=NEW.predecessor_sku_id AND successor_sku_id=NEW.successor_sku_id AND publication_id=NEW.publication_id)
   OR NEW.state='offered' AND (NEW.consent IS NOT NULL OR NEW.accepted_receipt IS NOT NULL OR NEW.terminal_at IS NOT NULL)
   OR NEW.state<>'offered' AND NEW.terminal_at IS NULL
   OR NEW.state='accepted' AND (jsonb_typeof(NEW.consent) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.accepted_receipt) IS DISTINCT FROM 'object')
   OR NEW.state IN ('declined','expired') AND (NEW.consent IS NOT NULL OR NEW.accepted_receipt IS NOT NULL) THEN
   RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='23514'; END IF;
  IF NEW.original_operation_id IS NOT NULL THEN
   SELECT * INTO root FROM public.subscription_renewal_operations WHERE id=NEW.original_operation_id;
   IF root.subscription_id IS DISTINCT FROM s.id OR NEW.original_case_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases c
    WHERE c.id=NEW.original_case_id AND c.renewal_operation_id=root.id AND c.subscription_id=s.id AND c.client_id=s.client_id) THEN
    RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='subscription_successor_operations_v2' THEN
  generation:=NEW;
 ELSE SELECT * INTO generation FROM public.subscription_successor_operations_v2 WHERE id=NEW.operation_id;
 END IF;
 SELECT * INTO root FROM public.subscription_renewal_operations WHERE id=generation.root_operation_id;
 SELECT * INTO proposal FROM public.subscription_successor_proposals WHERE id=generation.proposal_id;
 SELECT * INTO s FROM public.subscriptions WHERE id=generation.subscription_id;
 IF generation.id IS NULL OR root.id IS NULL OR proposal.id IS NULL OR s.id IS NULL
  OR root.subscription_id IS DISTINCT FROM s.id OR root.scheduled_at IS DISTINCT FROM generation.scheduled_at
  OR root.cycle_number IS DISTINCT FROM generation.cycle_number OR proposal.subscription_id IS DISTINCT FROM s.id
  OR proposal.client_id IS DISTINCT FROM s.client_id OR proposal.original_operation_id IS DISTINCT FROM root.id
  OR proposal.state NOT IN ('offered','accepted')
  OR generation.identity_key IS DISTINCT FROM root.identity_key||':successor:'||proposal.id::text
  OR generation.lease_expires_at<=generation.claimed_at
  OR (generation.external_attempt_ref IS NULL) IS DISTINCT FROM (generation.external_attempt_acknowledged_at IS NULL)
  OR generation.external_attempt_ref IS NOT NULL AND length(btrim(generation.external_attempt_ref)) NOT BETWEEN 1 AND 240
  OR generation.state IN ('succeeded','refused') AND (generation.terminal_outcome IS DISTINCT FROM generation.state OR generation.terminal_at IS NULL)
  OR generation.state NOT IN ('succeeded','refused') AND (generation.terminal_outcome IS NOT NULL OR generation.terminal_reason IS NOT NULL OR generation.terminal_at IS NOT NULL) THEN
  RAISE EXCEPTION 'successor_operation_binding_changed' USING ERRCODE='23514'; END IF;
 IF generation.predecessor_generation_id IS NOT NULL THEN
  SELECT * INTO predecessor FROM public.subscription_successor_operations_v2 WHERE id=generation.predecessor_generation_id;
  IF predecessor.root_operation_id IS DISTINCT FROM root.id OR predecessor.id=generation.id OR predecessor.superseded_by_proposal_id IS DISTINCT FROM proposal.id THEN
   RAISE EXCEPTION 'successor_generation_lineage_changed' USING ERRCODE='23514'; END IF;
 END IF;
 IF generation.cycle_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.id=generation.cycle_id AND c.subscription_id=s.id
  AND c.scheduled_at=generation.scheduled_at AND c.renewal_operation_id IS NULL AND c.renewal_operation_fingerprint IS NULL)
  OR generation.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_orders o WHERE o.id=generation.order_id AND o.subscription_cycle_id=generation.cycle_id
   AND o.client_id=s.client_id AND o.renewal_operation_id IS NULL AND o.renewal_operation_fingerprint IS NULL
   AND o.currency_code=generation.cycle_snapshot->>'currency' AND o.total_amount_minor=(generation.cycle_snapshot->>'totalAmountMinor')::bigint)
  OR generation.settlement_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.id=generation.settlement_intent_id
   AND i.order_id=generation.order_id AND i.renewal_operation_id IS NULL AND i.renewal_operation_fingerprint IS NULL)
  OR generation.fulfillment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments f WHERE f.id=generation.fulfillment_id AND f.order_id=generation.order_id) THEN
  RAISE EXCEPTION 'successor_native_graph_mismatch' USING ERRCODE='23514'; END IF;
 basket:=generation.cycle_snapshot->'lines';
 IF jsonb_typeof(basket) IS DISTINCT FROM 'array' OR jsonb_array_length(basket) NOT BETWEEN 1 AND 100
  OR (SELECT count(DISTINCT l->>'sku') FROM jsonb_array_elements(basket) l)<>jsonb_array_length(basket)
  OR generation.cycle_snapshot->>'subscriptionId' IS DISTINCT FROM s.id::text
  OR (generation.cycle_snapshot->>'scheduledAt')::timestamptz IS DISTINCT FROM generation.scheduled_at
  OR (generation.cycle_snapshot->>'cycleNumber')::integer IS DISTINCT FROM generation.cycle_number THEN
  RAISE EXCEPTION 'stock_wait_invalid_basket' USING ERRCODE='23514'; END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(basket) LOOP
  IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR length(btrim(coalesce(line->>'sku',''))) NOT BETWEEN 1 AND 160
   OR coalesce(line->>'quantity','') !~ '^[1-9][0-9]*$' OR (line->>'quantity')::numeric>2147483647
   OR coalesce(line->>'unitAmountMinor','') !~ '^[0-9]+$' OR (line->>'unitAmountMinor')::numeric>9007199254740991 THEN
   RAISE EXCEPTION 'stock_wait_invalid_basket' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF TG_TABLE_NAME='subscription_successor_wait_cases_v2' THEN
 IF (
  NEW.subscription_id IS DISTINCT FROM s.id OR NEW.client_id IS DISTINCT FROM s.client_id
  OR NEW.scheduled_at IS DISTINCT FROM generation.scheduled_at OR NEW.cycle_number IS DISTINCT FROM generation.cycle_number
  OR NEW.cycle_snapshot IS DISTINCT FROM generation.cycle_snapshot OR NEW.fingerprint IS DISTINCT FROM generation.operation_fingerprint
  OR NEW.identity_key IS DISTINCT FROM generation.identity_key
  OR NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases c WHERE c.id=NEW.root_case_id AND c.renewal_operation_id=root.id)) THEN
  RAISE EXCEPTION 'successor_wait_binding_changed' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='subscription_successor_reservations_v2' THEN
 IF (
  NEW.operation_fingerprint IS DISTINCT FROM generation.operation_fingerprint OR NEW.source_key IS DISTINCT FROM generation.cycle_snapshot->>'stockSourceKey'
  OR NEW.lines IS DISTINCT FROM basket OR NEW.status='held' AND (NEW.expires_at IS NULL OR NEW.expires_at<=NEW.created_at)
  OR NEW.status='held' AND generation.order_id IS NOT NULL
  OR NEW.status IN ('committed','consumed') AND (generation.cycle_id IS NULL OR generation.order_id IS NULL OR generation.settlement_intent_id IS NULL)
  OR NEW.status IN ('released','expired') AND length(btrim(coalesce(NEW.terminal_reason,'')))=0
  OR NEW.status NOT IN ('released','expired') AND NEW.terminal_reason IS NOT NULL) THEN
  RAISE EXCEPTION 'successor_reservation_binding_changed' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.subscription_successor_guard_v2() FROM PUBLIC;
CREATE TRIGGER subscription_successor_proposals_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_successor_proposals FOR EACH ROW EXECUTE FUNCTION public.subscription_successor_guard_v2();
CREATE TRIGGER catalog_sku_successors_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.catalog_sku_successors FOR EACH ROW EXECUTE FUNCTION public.subscription_successor_guard_v2();
CREATE TRIGGER subscription_successor_operations_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_successor_operations_v2 FOR EACH ROW EXECUTE FUNCTION public.subscription_successor_guard_v2();
CREATE TRIGGER subscription_successor_wait_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_successor_wait_cases_v2 FOR EACH ROW EXECUTE FUNCTION public.subscription_successor_guard_v2();
CREATE TRIGGER subscription_successor_reservations_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_successor_reservations_v2 FOR EACH ROW EXECUTE FUNCTION public.subscription_successor_guard_v2();

CREATE FUNCTION public.subscription_stock_wait_read_v2(p_case_id uuid,p_case_kind text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE answer jsonb;
BEGIN
 IF p_case_kind='legacy' THEN
  answer:=public.subscription_stock_wait_read(p_case_id);
  RETURN CASE WHEN answer IS NULL THEN NULL ELSE jsonb_build_object('schemaVersion',2,'caseKind','legacy','case',answer) END;
 ELSIF p_case_kind='successor' THEN
  SELECT public.subscription_stock_wait_projection_v2(c)||jsonb_build_object('waitingNoticeRelevant',s.status='active' AND s.next_cycle_at=c.scheduled_at AND c.superseded_by_proposal_id IS NULL)
   INTO answer FROM public.subscription_successor_wait_cases_v2 c JOIN public.subscriptions s ON s.id=c.subscription_id WHERE c.id=p_case_id;
  RETURN answer;
 END IF;
 RAISE EXCEPTION 'stock_wait_case_kind_invalid' USING ERRCODE='22023';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_read_v2(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.subscription_read_successor_renewal_v2(p_identity_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g public.subscription_successor_operations_v2;
BEGIN
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE identity_key=p_identity_key;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('schemaVersion',2,'operationKind','successor','operation',to_jsonb(g));
END; $$;
REVOKE ALL ON FUNCTION public.subscription_read_successor_renewal_v2(text) FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_frozen_v2(p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g public.subscription_successor_operations_v2; c public.subscription_successor_wait_cases_v2;
BEGIN
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id;
 IF NOT FOUND OR g.superseded_by_proposal_id IS NOT NULL OR g.attempt_prepared_at IS NOT NULL OR g.external_attempt_ref IS NOT NULL
  OR g.external_attempt_acknowledged_at IS NOT NULL OR g.cycle_id IS NOT NULL OR g.order_id IS NOT NULL OR g.settlement_intent_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.id=g.subscription_id AND s.status='active' AND s.next_cycle_at=g.scheduled_at)
  OR NOT EXISTS(SELECT 1 FROM public.subscription_successor_proposals p WHERE p.id=g.proposal_id AND p.state='accepted' AND p.accepted_receipt IS NOT NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(g.outcomes) o WHERE o->>'outcome'<>'refused' OR coalesce(o->>'reason','') NOT IN ('inventory_unavailable','reservation_expired') OR o->>'externalRef' IS NOT NULL) THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.subscription_successor_wait_cases_v2 WHERE operation_id=g.id;
 IF c.id IS NOT NULL AND c.state NOT IN ('waiting','stock_secured') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('schemaVersion',2,'operationKind','successor','operationId',g.id,'caseKind','successor','caseId',c.id,
  'identityKey',g.identity_key,'operationFingerprint',g.operation_fingerprint,'snapshot',g.cycle_snapshot,'cycleNumber',g.cycle_number,
  'binding',jsonb_build_object('caseKind','successor','caseId',c.id,'operationId',g.id,'rootOperationId',g.root_operation_id,'proposalId',g.proposal_id));
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_frozen_v2(uuid) FROM PUBLIC;

CREATE FUNCTION public.subscription_claim_successor_renewal_v2(p_identity_key text,p_operation_fingerprint text,p_cycle_snapshot jsonb,p_worker_id text,p_lease_seconds integer DEFAULT 300,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_operations_v2; g public.subscription_successor_operations_v2; s public.subscriptions;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR p_operation_fingerprint IS NULL OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(p_cycle_snapshot) IS DISTINCT FROM 'object' OR length(btrim(coalesce(p_worker_id,''))) NOT BETWEEN 1 AND 240
  OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
  RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE identity_key=p_identity_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'successor_generation_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
 BEGIN
  PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=hint.id FOR UPDATE NOWAIT;
 IF g.operation_fingerprint IS DISTINCT FROM p_operation_fingerprint OR g.cycle_snapshot IS DISTINCT FROM p_cycle_snapshot OR g.identity_key IS DISTINCT FROM p_identity_key THEN
  RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE='23505'; END IF;
 IF g.state IN ('succeeded','refused') THEN RETURN public.subscription_read_successor_renewal_v2(g.identity_key)||jsonb_build_object('acquired',false,'replayed',true,'reason','terminal'); END IF;
 IF g.superseded_by_proposal_id IS NOT NULL OR s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM g.scheduled_at OR g.scheduled_at>p_now
  OR NOT EXISTS(SELECT 1 FROM public.subscription_successor_proposals p WHERE p.id=g.proposal_id AND p.state='accepted' AND p.accepted_receipt IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.subscription_command_receipts r WHERE r.subscription_id=s.id AND r.client_id=s.client_id AND r.result=p.accepted_receipt AND r.status='applied')) THEN
  RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE='22023'; END IF;
 IF g.lease_expires_at>p_now THEN RETURN public.subscription_read_successor_renewal_v2(g.identity_key)||jsonb_build_object('acquired',false,'replayed',true,'reason','lease_active'); END IF;
 UPDATE public.subscription_successor_operations_v2 SET claim_token=gen_random_uuid(),claim_generation=claim_generation+1,claimed_by=p_worker_id,
  claimed_at=p_now,lease_expires_at=p_now+make_interval(secs=>p_lease_seconds),updated_at=p_now WHERE id=g.id;
 RETURN public.subscription_read_successor_renewal_v2(g.identity_key)||jsonb_build_object('acquired',true,'replayed',true,'reason','lease_taken_over');
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_claim_successor_renewal_v2(text,text,jsonb,text,integer,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.fulfillment_reserve_successor_renewal_v2(p_operation_id uuid,p_claim_token uuid,p_hold_seconds integer DEFAULT 900,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_operations_v2; g public.subscription_successor_operations_v2; s public.subscriptions;
 r public.subscription_successor_reservations_v2; stock public.fulfillment_stock_current; item jsonb; available bigint; deficits jsonb:='[]';
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR p_operation_id IS NULL OR p_claim_token IS NULL OR p_hold_seconds IS NULL OR p_hold_seconds NOT BETWEEN 60 AND 86400 THEN
  RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_input' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(846832106,1) THEN RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'successor_generation_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.clients WHERE id=s.client_id FOR KEY SHARE NOWAIT;
 BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=hint.id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_stock_wait_cases WHERE id=(SELECT original_case_id FROM public.subscription_successor_proposals WHERE id=g.proposal_id) FOR UPDATE NOWAIT;
 SELECT * INTO r FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 IF g.claim_token IS DISTINCT FROM p_claim_token OR g.lease_expires_at<=p_now THEN RAISE EXCEPTION 'fulfillment_renewal_reservation_stale_claim' USING ERRCODE='40001'; END IF;
 IF g.superseded_by_proposal_id IS NOT NULL OR s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM g.scheduled_at
  OR NOT EXISTS(SELECT 1 FROM public.subscription_successor_proposals p WHERE p.id=g.proposal_id AND p.state='accepted' AND p.accepted_receipt IS NOT NULL) THEN
  RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF r.id IS NOT NULL THEN
  IF r.operation_fingerprint IS DISTINCT FROM g.operation_fingerprint OR r.lines IS DISTINCT FROM g.cycle_snapshot->'lines' THEN RAISE EXCEPTION 'stock_wait_reservation_snapshot_mismatch' USING ERRCODE='23505'; END IF;
  IF r.status IN ('committed','consumed') OR r.status='held' AND r.expires_at>p_now THEN
   RETURN jsonb_build_object('schemaVersion',2,'operationKind','successor','operationId',g.id,'reserved',true,'replayed',true,'reservationId',r.id);
  END IF;
  RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_state' USING ERRCODE='22023';
 END IF;
 IF g.state<>'claimed' OR g.attempt_prepared_at IS NOT NULL OR g.order_id IS NOT NULL THEN RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_state' USING ERRCODE='22023'; END IF;
 PERFORM k.sku FROM public.fulfillment_stock_current k JOIN jsonb_array_elements(g.cycle_snapshot->'lines') l ON l->>'sku'=k.sku
  WHERE k.source_key=g.cycle_snapshot->>'stockSourceKey' ORDER BY k.source_key,k.sku FOR UPDATE OF k NOWAIT;
 FOR item IN SELECT value FROM jsonb_array_elements(g.cycle_snapshot->'lines') ORDER BY value->>'sku' LOOP
  SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=g.cycle_snapshot->>'stockSourceKey' AND sku=item->>'sku';
  IF stock.sku IS NULL THEN RAISE EXCEPTION 'stock_wait_stock_missing' USING ERRCODE='22023'; END IF;
  IF stock.stale_after<=p_now THEN RAISE EXCEPTION 'stock_wait_stock_stale' USING ERRCODE='22023'; END IF;
  available:=CASE WHEN stock.inventory_class='sellable' THEN (public.inventory_available_to_promise(stock.source_key,stock.sku,p_now,true)->>'available_quantity')::bigint ELSE 0 END;
  IF available<(item->>'quantity')::integer THEN
   deficits:=deficits||jsonb_build_array(jsonb_build_object('sku',stock.sku,'requiredUnits',(item->>'quantity')::integer,'reservedUnits',0,
    'availableUnits',available,'missingUnits',(item->>'quantity')::integer-available));
  END IF;
 END LOOP;
 IF jsonb_array_length(deficits)>0 THEN
  UPDATE public.subscription_successor_operations_v2 SET state='refused',terminal_outcome='refused',terminal_reason='inventory_unavailable',terminal_at=p_now,
   outcomes=outcomes||jsonb_build_array(jsonb_build_object('eventKey',identity_key||':inventory','operationFingerprint',operation_fingerprint,'outcome','refused','reason','inventory_unavailable','externalRef',NULL,'occurredAt',p_now)),updated_at=p_now WHERE id=g.id;
  RETURN jsonb_build_object('schemaVersion',2,'operationKind','successor','operationId',g.id,'reserved',false,'reason','inventory_unavailable','deficits',deficits);
 END IF;
 INSERT INTO public.subscription_successor_reservations_v2(id,operation_id,operation_fingerprint,source_key,lines,status,expires_at,created_at,updated_at)
 VALUES(gen_random_uuid(),g.id,g.operation_fingerprint,g.cycle_snapshot->>'stockSourceKey',g.cycle_snapshot->'lines','held',p_now+make_interval(secs=>p_hold_seconds),p_now,p_now) RETURNING * INTO r;
 UPDATE public.subscription_successor_operations_v2 SET state='reserved',updated_at=p_now WHERE id=g.id;
 RETURN jsonb_build_object('schemaVersion',2,'operationKind','successor','operationId',g.id,'reserved',true,'replayed',false,'reservationId',r.id);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM IN ('inventory_admission_busy','lc10_root_operation_busy') THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.fulfillment_reserve_successor_renewal_v2(uuid,uuid,integer,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.commerce_prepare_successor_renewal_v2(
  p_operation_id uuid,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_operation public.subscription_successor_operations_v2%ROWTYPE;
  v_reservation public.subscription_successor_reservations_v2%ROWTYPE;
  v_cycle_id uuid;
  v_order_id uuid;
  v_intent_id uuid;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_quantity integer;
  v_unit_amount bigint;
  v_total bigint;
  v_currency text;
  v_channel text;
BEGIN
  SELECT subscription_id INTO v_operation.subscription_id
    FROM public.subscription_successor_operations_v2 WHERE id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM id FROM public.subscriptions
   WHERE id = v_operation.subscription_id FOR UPDATE NOWAIT;

  PERFORM 1 FROM public.clients WHERE id=(SELECT client_id FROM public.subscriptions WHERE id=v_operation.subscription_id) FOR KEY SHARE NOWAIT;

  BEGIN
    PERFORM 1 FROM public.subscription_renewal_operations WHERE id=(SELECT root_operation_id FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id) FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
  SELECT * INTO v_operation FROM public.subscription_successor_operations_v2
   WHERE id = p_operation_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.superseded_by_proposal_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.subscription_successor_proposals p WHERE p.id=v_operation.proposal_id AND p.state='accepted' AND p.accepted_receipt IS NOT NULL) THEN
    RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'commerce_renewal_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT cycle.id, order_row.id, intent.id
    INTO v_cycle_id, v_order_id, v_intent_id
    FROM public.subscription_cycles cycle
    JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id
    JOIN public.commerce_settlement_intents intent ON intent.order_id = order_row.id
   WHERE cycle.id = v_operation.cycle_id;
  IF FOUND THEN
    IF v_operation.state <> 'attempt_prepared' THEN
      RAISE EXCEPTION 'commerce_renewal_artifact_state_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schemaVersion',2,'operationKind','successor','contractVersion', 'platform.subscription.renewal.v1', 'replayed', true,
      'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
      'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
      'state', v_operation.state);
  END IF;
  IF v_operation.state <> 'reserved' THEN
    RAISE EXCEPTION 'commerce_renewal_reservation_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reservation FROM public.subscription_successor_reservations_v2
   WHERE operation_id = p_operation_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR v_reservation.status <> 'held'
    OR v_reservation.expires_at <= COALESCE(p_now, now())
    OR v_reservation.operation_fingerprint <> v_operation.operation_fingerprint
  THEN
    RAISE EXCEPTION 'commerce_renewal_active_reservation_required' USING ERRCODE = '22023';
  END IF;

  v_currency := v_operation.cycle_snapshot->>'currency';
  v_channel := v_operation.cycle_snapshot->>'settlementChannelKey';
  v_total := (v_operation.cycle_snapshot->>'totalAmountMinor')::bigint;
  IF v_currency !~ '^[A-Z]{3}$' OR btrim(COALESCE(v_channel, '')) = '' OR v_total < 1 THEN
    RAISE EXCEPTION 'commerce_renewal_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_cycles (
    subscription_id, scheduled_at, status, renewal_operation_id,
    renewal_operation_fingerprint, updated_at
  ) VALUES (
    v_operation.subscription_id, v_operation.scheduled_at, 'payment_pending', NULL,
    NULL, COALESCE(p_now, now())
  ) RETURNING id INTO v_cycle_id;

  INSERT INTO public.commerce_orders (
    client_id, subscription_cycle_id, status, currency_code, total_amount_minor,
    source_kind, metadata, renewal_operation_id, renewal_operation_fingerprint, updated_at
  ) SELECT subscription.client_id, v_cycle_id, 'pending_payment', v_currency, v_total,
           'storefront', public.customer_renewal_delivery_selection(v_operation.subscription_id,jsonb_build_object(
             'source', 'subscription.renewal',
             'renewalIdentityKey', v_operation.identity_key,
             'renewalOperationFingerprint', v_operation.operation_fingerprint,
             'cycleSnapshot', v_operation.cycle_snapshot)),
           NULL, NULL, COALESCE(p_now, now())
      FROM public.subscriptions subscription WHERE subscription.id = v_operation.subscription_id
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_amount := (v_line->>'unitAmountMinor')::bigint;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    IF NOT FOUND OR v_quantity < 1 OR v_unit_amount < 0 THEN
      RAISE EXCEPTION 'commerce_renewal_invalid_line' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_amount,
      v_quantity * v_unit_amount);
  END LOOP;

  PERFORM 1 FROM public.commerce_destinations d JOIN public.subscriptions owner ON owner.client_id=d.client_id
    WHERE owner.id=v_operation.subscription_id AND d.id=(v_operation.cycle_snapshot#>>'{orderSnapshot,shippingAddressRef}')::uuid FOR KEY SHARE OF d NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO public.commerce_destination_bindings(order_id,destination_id)
   VALUES(v_order_id,(v_operation.cycle_snapshot#>>'{orderSnapshot,shippingAddressRef}')::uuid);

  PERFORM public.commerce_open_settlement_intent(
    v_operation.identity_key || ':settlement', v_order_id, v_channel, v_total, v_currency,
    jsonb_build_object(
      'successorOperationId', p_operation_id,
      'renewalOperationFingerprint', v_operation.operation_fingerprint),
    COALESCE(p_now, now()));
  SELECT id INTO v_intent_id FROM public.commerce_settlement_intents WHERE order_id = v_order_id;
  UPDATE public.commerce_settlement_intents
     SET renewal_operation_id = NULL,
         renewal_operation_fingerprint = NULL,
         updated_at = COALESCE(p_now, now())
   WHERE id = v_intent_id;
  UPDATE public.subscription_successor_operations_v2
     SET cycle_id=v_cycle_id,order_id=v_order_id,settlement_intent_id=v_intent_id,
         state = 'attempt_prepared', attempt_prepared_at = COALESCE(p_now, now()),
         updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  UPDATE public.subscription_successor_reservations_v2
     SET status = 'committed', expires_at = NULL, updated_at = COALESCE(p_now, now())
   WHERE id = v_reservation.id;

  RETURN jsonb_build_object(
    'schemaVersion',2,'operationKind','successor','contractVersion', 'platform.subscription.renewal.v1', 'replayed', false,
    'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
    'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
    'state', v_operation.state);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_prepare_successor_renewal_v2(uuid,uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.subscription_list_due_successor_renewals_v2(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY scheduled_at,subscription_id,operation_id),'[]'::jsonb) INTO result FROM (
  SELECT value,scheduled_at,subscription_id,operation_id FROM (
   SELECT jsonb_build_object('schemaVersion',2,'operationKind','legacy','due',to_jsonb(d)) value,d.scheduled_at,d.subscription_id,NULL::uuid operation_id
    FROM public.subscription_list_due_renewals(p_now,p_limit) d
    WHERE NOT EXISTS(SELECT 1 FROM public.subscription_successor_operations_v2 owned
      WHERE owned.subscription_id=d.subscription_id AND owned.scheduled_at=d.scheduled_at AND owned.superseded_by_proposal_id IS NULL)
   UNION ALL
   SELECT jsonb_build_object('schemaVersion',2,'operationKind','successor','operationId',g.id,'identityKey',g.identity_key,'operationFingerprint',g.operation_fingerprint,'snapshot',g.cycle_snapshot),g.scheduled_at,g.subscription_id,g.id
    FROM public.subscription_successor_operations_v2 g JOIN public.subscriptions s ON s.id=g.subscription_id
    JOIN public.subscription_successor_proposals p ON p.id=g.proposal_id
    WHERE g.superseded_by_proposal_id IS NULL AND g.state NOT IN ('succeeded','refused') AND g.scheduled_at<=p_now
     AND g.lease_expires_at<=p_now AND s.status='active' AND s.next_cycle_at=g.scheduled_at AND p.state='accepted'
  ) records ORDER BY scheduled_at,subscription_id,operation_id LIMIT p_limit
 ) selected;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.subscription_list_due_successor_renewals_v2(integer,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; operation jsonb; expectation jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text; inputs jsonb; content jsonb; claim jsonb; allowed text[];
BEGIN
  actor := p_actor_id; IF actor IS NULL OR actor <> btrim(actor) OR length(actor) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'catalog_draft_actor_required' USING ERRCODE='42501'; END IF;
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 1048576
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_fingerprint_invalid');
  END IF;
  c := p_canonical_command::jsonb;
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'schemaVersion' NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb) OR NOT (c ? 'schemaVersion')
    OR c->>'action' IS NULL OR (c->>'action' NOT IN ('create','revise','abandon') AND NOT (c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb) AND c->>'action' = 'resume'))
    OR jsonb_typeof(c->'draftId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'commandKey') IS DISTINCT FROM 'string' OR length(c->>'commandKey') NOT BETWEEN 1 AND 240
    OR btrim(c->>'commandKey') <> c->>'commandKey'
    OR jsonb_typeof(c->'expectedRevision') IS DISTINCT FROM 'number'
    OR c->>'expectedRevision' !~ '^(0|[1-9][0-9]*)$'
    OR EXISTS (SELECT FROM jsonb_object_keys(c) k WHERE k NOT IN ('schemaVersion','action','draftId','commandKey','expectedRevision','payload')) THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
  END IF;
  d := (c->>'draftId')::uuid; key := c->>'commandKey'; action := c->>'action'; expected := (c->>'expectedRevision')::integer;
  IF expected > 2147483646 THEN RETURN jsonb_build_object('outcome','validation_issue','reason','revision_limit'); END IF;
  IF d::text <> c->>'draftId' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-draft:' || d::text, 0));
  SELECT * INTO receipt FROM public.catalog_draft_command_receipts WHERE draft_id = d AND command_key = key;
  IF FOUND THEN
    IF receipt.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('outcome','conflict','reason','command_key_reused');
    END IF;
    IF public.catalog_draft_record(d,receipt.revision)->>'actorId' <> actor THEN RETURN jsonb_build_object('outcome','unauthorized','reason','operator_mismatch'); END IF;
    RETURN jsonb_build_object('outcome','replayed','record',public.catalog_draft_record(d, receipt.revision));
  END IF;
  SELECT * INTO h FROM public.catalog_draft_heads WHERE draft_id = d FOR UPDATE;
  IF (action = 'create' AND (FOUND OR expected <> 0)) OR (action <> 'create' AND (NOT FOUND OR expected <> h.revision)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','revision_conflict','currentRevision',coalesce(h.revision,0));
  END IF;
  IF h.status = 'abandoned' AND action <> 'resume' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_abandoned','currentRevision',h.revision); END IF;
  IF action = 'resume' AND h.status <> 'abandoned' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_not_abandoned','currentRevision',h.revision); END IF;
  next_revision := coalesce(h.revision,0) + 1;
  state := CASE WHEN action = 'abandon' THEN 'abandoned' ELSE 'open' END;
  IF action IN ('abandon','resume') THEN
    IF c ? 'payload' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','abandon_payload_invalid'); END IF;
    SELECT payload INTO p FROM public.catalog_draft_revisions WHERE draft_id = d AND revision = h.revision;
    product := h.product_id;
  ELSE
    p := c->'payload';
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'schemaVersion' IS DISTINCT FROM c->'schemaVersion'
      OR jsonb_typeof(p->'product') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'skus') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p->'product'->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p->'product'->'type') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p->'product'->'type'->'key') IS DISTINCT FROM 'string'
      OR p->'product'->'type'->>'key' !~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
      OR jsonb_typeof(p->'product'->'type'->'version') IS DISTINCT FROM 'number'
      OR p->'product'->'type'->>'version' !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(p->'product'->'dimensions') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p->'product'->'dimensions') > 16 OR jsonb_array_length(p->'skus') > 10000 THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
    END IF;
    IF c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb) THEN
      IF EXISTS (SELECT FROM jsonb_object_keys(p) k WHERE k NOT IN ('schemaVersion','product','skus') AND NOT (c->'schemaVersion' IN ('3'::jsonb, '4'::jsonb, '5'::jsonb) AND k = 'publication'))
        OR EXISTS (SELECT FROM jsonb_object_keys(p->'product') k WHERE k NOT IN ('id','type','slug','primarySkuId','dimensions','sharedContent','documentRevision','attributes'))
        OR (p->'product' ? 'attributes' AND jsonb_typeof(p->'product'->'attributes') IS DISTINCT FROM 'object') THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
      END IF;
    END IF;
    IF c->'schemaVersion' IN ('3'::jsonb, '4'::jsonb, '5'::jsonb) THEN
      inputs := p->'publication'; content := p->'product'->'sharedContent';
      IF jsonb_typeof(inputs) IS DISTINCT FROM 'object' OR jsonb_typeof(content) IS DISTINCT FROM 'object' THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      IF inputs->>'kind' IS NULL OR inputs->>'kind' NOT IN ('release','compensation')
        OR jsonb_typeof(inputs->'operations') IS DISTINCT FROM 'array' OR jsonb_typeof(inputs->'evidence') IS DISTINCT FROM 'object'
        OR EXISTS (SELECT FROM jsonb_object_keys(inputs) k WHERE k NOT IN ('kind','operations','evidence'))
        OR content->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR content->>'catalogAction' IS NULL
        OR content->>'catalogAction' NOT IN ('create','revise') OR jsonb_typeof(content->'presentation') IS DISTINCT FROM 'object'
        OR jsonb_typeof(content->'offerMemberships') IS DISTINCT FROM 'array'
        OR jsonb_typeof(content->'requestedModes') IS DISTINCT FROM 'array'
        OR jsonb_typeof(content->'publicationSkus') IS DISTINCT FROM 'array'
        OR (content ? 'document' AND jsonb_typeof(content->'document') IS DISTINCT FROM 'object')
        OR EXISTS (SELECT FROM jsonb_object_keys(content) k WHERE k NOT IN ('schemaVersion','catalogAction','document','presentation','offerMemberships','requestedModes','publicationSkus')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      FOR code_value IN SELECT unnest(ARRAY['offerMemberships','requestedModes','publicationSkus']) LOOP
        IF jsonb_array_length(content->code_value) > 10000 THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        FOR claim IN SELECT value FROM jsonb_array_elements(content->code_value) LOOP
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE code_value WHEN 'offerMemberships' THEN ARRAY['skuCode','offerVersion','admitted']
            WHEN 'requestedModes' THEN ARRAY['skuCode','modes'] ELSE ARRAY['skuCode','title','minQuantity','isAddon','facts'] END;
          IF NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END LOOP;
      END LOOP;
      IF EXISTS (SELECT FROM jsonb_object_keys(inputs->'evidence') k WHERE k NOT IN ('drafts','media')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      FOR code_value IN SELECT unnest(ARRAY['drafts','media']) LOOP
        IF NOT (inputs->'evidence' ? code_value) THEN CONTINUE; END IF;
        IF jsonb_typeof(inputs->'evidence'->code_value) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        IF jsonb_array_length(inputs->'evidence'->code_value) < 1 OR (code_value = 'drafts' AND jsonb_array_length(inputs->'evidence'->code_value) > 100) THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
        FOR claim IN SELECT value FROM jsonb_array_elements(inputs->'evidence'->code_value) LOOP
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE code_value WHEN 'drafts' THEN ARRAY['draftId','revision','commandKey','fingerprint'] ELSE ARRAY['skuCode','mediaRef','assetRefs','revisionDigest'] END;
          IF NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END LOOP;
      END LOOP;
      FOR operation IN SELECT value FROM jsonb_array_elements(inputs->'operations') LOOP
        IF jsonb_typeof(operation) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        allowed := CASE operation->>'op'
          WHEN 'create_product' THEN ARRAY['op','productId','productSlug','name']
          WHEN 'register_document_revision' THEN ARRAY['op','productSlug','revisionId','revisionNo','documentRef','sourceRef','canonicalText','digest','provenance']
          WHEN 'create_sku' THEN ARRAY['op','skuId','skuCode','productSlug','documentRevisionNo','title','minQuantity','isAddon','facts']
          WHEN 'create_identifier' THEN ARRAY['op','skuCode','scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef']
          WHEN 'set_eligibility' THEN ARRAY['op','skuCode','sellableStandalone','sellableInSubscription']
          WHEN 'set_sku_status' THEN ARRAY['op','skuCode','status']
          WHEN 'move_document_pointer' THEN ARRAY['op','productSlug','documentRevisionNo']
          WHEN 'set_primary_sku' THEN ARRAY['op','productSlug','skuCode']
          WHEN 'set_product_status' THEN ARRAY['op','productSlug','status']
          WHEN 'set_offer_membership' THEN ARRAY['op','skuCode','offerVersion','admitted']
          WHEN 'set_product_presentation' THEN ARRAY['op','productSlug','presentation']
          WHEN 'set_sku_metadata' THEN ARRAY['op','skuCode','logisticsRef']
          WHEN 'set_product_lifecycle' THEN CASE WHEN c->'schemaVersion' IN ('4'::jsonb,'5'::jsonb) THEN ARRAY['op','productSlug','expectedState','state','children'] ELSE NULL END
          WHEN 'set_sku_lifecycle' THEN CASE WHEN c->'schemaVersion' IN ('4'::jsonb,'5'::jsonb) THEN ARRAY['op','skuCode','expectedState','state'] ELSE NULL END
          WHEN 'restore_product' THEN CASE WHEN c->'schemaVersion' IN ('4'::jsonb,'5'::jsonb) THEN ARRAY['op','productSlug','expectedState'] ELSE NULL END
          WHEN 'restore_sku' THEN CASE WHEN c->'schemaVersion' IN ('4'::jsonb,'5'::jsonb) THEN ARRAY['op','skuCode','expectedState'] ELSE NULL END
          WHEN 'set_derived_sku_facts' THEN ARRAY['op','skuCode','documentRevisionNo','netContent','facts'] ELSE NULL END;
        IF c->'schemaVersion'='5'::jsonb AND operation->>'op'='create_sku' AND operation ? 'successorOf' THEN
          IF jsonb_typeof(operation->'successorOf') IS DISTINCT FROM 'string' OR operation->>'successorOf' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR operation->>'successorOf'=operation->>'skuId' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed:=allowed||ARRAY['successorOf'];
        END IF;
        IF allowed IS NULL OR NOT (operation ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(operation) k WHERE NOT (k = ANY(allowed))) THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
        IF c->'schemaVersion' IN ('4'::jsonb,'5'::jsonb) AND operation->>'op' IN ('set_product_status','set_sku_status') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','catalog_lifecycle_raw_status_fenced'); END IF;
        IF operation->>'op' = 'register_document_revision' THEN
          claim := operation->'provenance';
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE claim->>'source' WHEN 'current_draft' THEN ARRAY['source']
            WHEN 'retained_draft' THEN ARRAY['source','draftId','draftRevision','draftCommandKey','draftFingerprint'] ELSE NULL END;
          IF allowed IS NULL OR NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END IF;
      END LOOP;
    END IF;
    product := (p->'product'->>'id')::uuid;
    IF product::text <> p->'product'->>'id' OR (h.product_id IS NOT NULL AND h.product_id <> product)
      OR (p->'product' ? 'documentRevision' AND p->'product'->'documentRevision'->>'productId' IS DISTINCT FROM product::text)
      OR (p->'product' ? 'primarySkuId' AND NOT EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x WHERE x->>'id' = p->'product'->>'primarySkuId')) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','product_reference_invalid');
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x GROUP BY x->>'id' HAVING count(*) > 1)
      OR EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x WHERE x ? 'code' GROUP BY x->>'code' HAVING count(*) > 1) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','sku_identity_duplicate');
    END IF;
    FOR s IN SELECT value FROM jsonb_array_elements(p->'skus') LOOP
      IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'id') IS DISTINCT FROM 'string'
        OR s->>'productId' IS DISTINCT FROM product::text OR s ? 'sharedContent'
        OR jsonb_typeof(s->'options') IS DISTINCT FROM 'object'
        OR (s ? 'code' AND (jsonb_typeof(s->'code') IS DISTINCT FROM 'string' OR length(s->>'code') NOT BETWEEN 1 AND 160 OR btrim(s->>'code') <> s->>'code' OR s->>'code' !~ '^[A-Za-z0-9._:-]+$')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','sku_reference_invalid');
      END IF;
      IF c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb) THEN
        IF EXISTS (SELECT FROM jsonb_object_keys(s) k WHERE k NOT IN ('id','productId','code','options','netContent','identifiers','assetRefs','grossMass','logisticsRef','attributes','priceOperations'))
          OR (s ? 'attributes' AND jsonb_typeof(s->'attributes') IS DISTINCT FROM 'object')
          OR (s ? 'priceOperations' AND jsonb_typeof(s->'priceOperations') IS DISTINCT FROM 'array') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
        END IF;
        FOR operation IN SELECT value FROM jsonb_array_elements(coalesce(s->'priceOperations','[]'::jsonb)) LOOP
          IF jsonb_typeof(operation) IS DISTINCT FROM 'object' OR jsonb_typeof(operation->'expected') IS DISTINCT FROM 'object' THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
          expectation := operation->'expected';
          IF EXISTS (SELECT FROM jsonb_object_keys(operation) k WHERE k NOT IN ('schemaVersion','commandKey','variantId','priceListId','mode','minQty','amountKind','unitPriceMinor','expected'))
            OR EXISTS (SELECT FROM jsonb_object_keys(expectation) k WHERE k NOT IN ('entryId','unitPriceMinor'))
            OR operation->'schemaVersion' IS DISTINCT FROM '1'::jsonb
            OR jsonb_typeof(operation->'commandKey') IS DISTINCT FROM 'string'
            OR length(operation->>'commandKey') NOT BETWEEN 1 AND 240 OR btrim(operation->>'commandKey') <> operation->>'commandKey'
            OR operation->>'variantId' IS DISTINCT FROM s->>'id'
            OR jsonb_typeof(operation->'priceListId') IS DISTINCT FROM 'string'
            OR operation->>'priceListId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR operation->'mode' IS DISTINCT FROM '"one_time"'::jsonb OR operation->'minQty' IS DISTINCT FROM '1'::jsonb
            OR operation->'amountKind' IS DISTINCT FROM '"gross"'::jsonb
            OR jsonb_typeof(operation->'unitPriceMinor') IS DISTINCT FROM 'number'
            OR operation->>'unitPriceMinor' !~ '^[1-9][0-9]{0,9}$'
            OR NOT (expectation ? 'entryId' AND expectation ? 'unitPriceMinor')
            OR NOT ((jsonb_typeof(expectation->'entryId') = 'null' AND jsonb_typeof(expectation->'unitPriceMinor') = 'null')
              OR (jsonb_typeof(expectation->'entryId') = 'string'
                AND expectation->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND jsonb_typeof(expectation->'unitPriceMinor') = 'number' AND expectation->>'unitPriceMinor' ~ '^(0|[1-9][0-9]{0,9})$')) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
          IF (operation->>'unitPriceMinor')::bigint > 2147483647 OR (expectation->>'unitPriceMinor')::bigint > 2147483647 THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
        END LOOP;
      END IF;
      sku := (s->>'id')::uuid;
      IF sku::text <> s->>'id' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','sku_reference_invalid'); END IF;
      SELECT * INTO reserved FROM public.catalog_draft_sku_reservations WHERE sku_id = sku;
      IF FOUND AND (reserved.draft_id <> d OR reserved.product_id <> product OR (reserved.code IS NOT NULL AND reserved.code IS DISTINCT FROM s->>'code')) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','sku_identity_reserved');
      END IF;
    END LOOP;
  END IF;
  -- The exception block rolls back every write if any cross-draft reservation loses a race.
  BEGIN
    IF action = 'create' THEN INSERT INTO public.catalog_draft_heads VALUES(d,product,next_revision,state);
    ELSE UPDATE public.catalog_draft_heads SET revision=next_revision,status=state WHERE draft_id=d; END IF;
    IF action IN ('create','revise') THEN
      FOR s IN SELECT value FROM jsonb_array_elements(p->'skus') LOOP
        INSERT INTO public.catalog_draft_sku_reservations(sku_id,draft_id,product_id,code)
          VALUES((s->>'id')::uuid,d,product,s->>'code') ON CONFLICT(sku_id) DO NOTHING;
        SELECT * INTO reserved FROM public.catalog_draft_sku_reservations WHERE sku_id=(s->>'id')::uuid FOR UPDATE;
        IF reserved.draft_id <> d OR reserved.product_id <> product OR (reserved.code IS NOT NULL AND reserved.code IS DISTINCT FROM s->>'code') THEN
          RAISE unique_violation USING MESSAGE='sku_identity_reserved';
        END IF;
        IF reserved.code IS NULL AND s ? 'code' THEN
          UPDATE public.catalog_draft_sku_reservations SET code=s->>'code' WHERE sku_id=(s->>'id')::uuid;
        END IF;
      END LOOP;
    END IF;
    INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id)
      VALUES(d,next_revision,product,state,p,key,p_fingerprint,actor);
    INSERT INTO public.catalog_draft_command_receipts VALUES(d,key,p_fingerprint,next_revision);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('outcome','conflict','reason','identity_reserved');
  END;
  RETURN jsonb_build_object('outcome','committed','record',public.catalog_draft_record(d,next_revision));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_record_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE canonical text; expected text; body jsonb;
BEGIN
 IF TG_TABLE_NAME = 'catalog_publications' THEN
  canonical := NEW.canonical_state; expected := NEW.digest;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  canonical := NEW.full_facts; expected := NEW.digest;
 ELSE
  canonical := NEW.canonical_text; expected := NEW.digest;
  IF canonical IS NULL THEN RETURN NEW; END IF;
 END IF;
 IF encode(sha256(convert_to(canonical,'UTF8')),'hex') <> expected THEN
  RAISE EXCEPTION 'catalog_publication_digest_mismatch' USING ERRCODE='23514';
 END IF;
 body := canonical::jsonb;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'catalog_publications' THEN
  IF (body->'schemaVersion' IS NULL OR body->'schemaVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb)) OR body->'product'->>'id' IS DISTINCT FROM NEW.product_id::text
   OR jsonb_typeof(body->'skus') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  IF body->>'id' IS DISTINCT FROM NEW.sku_id::text OR body->>'productId' IS DISTINCT FROM NEW.product_id::text THEN
   RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_accepted_reference_assert_v2(p_reference jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE publication public.catalog_publications%ROWTYPE; revision public.catalog_sku_revisions%ROWTYPE;
 manifest jsonb; facts jsonb; reference jsonb; document_digest text;
BEGIN
 IF jsonb_typeof(p_reference) IS DISTINCT FROM 'object' OR p_reference->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR NOT (p_reference ?& ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent'])
  OR p_reference - ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent','demandPolicyRef'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO publication FROM public.catalog_publications WHERE id=(p_reference#>>'{publicationHead,publicationId}')::uuid;
 SELECT * INTO revision FROM public.catalog_sku_revisions WHERE id=(p_reference->>'skuRevisionId')::uuid AND sku_id=(p_reference->>'skuId')::uuid;
 IF publication.id IS NULL OR revision.id IS NULL OR publication.product_id<>revision.product_id THEN
  RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
 manifest:=publication.canonical_state::jsonb; facts:=revision.full_facts::jsonb;
 SELECT digest INTO document_digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id AND product_id=publication.product_id;
 IF encode(sha256(convert_to(publication.canonical_state,'UTF8')),'hex')<>publication.digest
  OR encode(sha256(convert_to(revision.full_facts,'UTF8')),'hex')<>revision.digest
  OR (manifest->'schemaVersion' IS NULL OR manifest->'schemaVersion' NOT IN ('3'::jsonb,'4'::jsonb)) OR facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR p_reference->'publicationHead' IS DISTINCT FROM jsonb_build_object('publicationId',publication.id,'revision',publication.revision,'documentDigest',document_digest)
  OR facts->>'id' IS DISTINCT FROM p_reference->>'skuId' OR facts->>'code' IS DISTINCT FROM p_reference->>'skuCode'
  OR manifest->'product'->'type' IS DISTINCT FROM p_reference->'typeRef'
  OR manifest->'product'->'definitionDigest' IS DISTINCT FROM p_reference->'definitionDigest'
  OR facts->'optionDigest' IS DISTINCT FROM p_reference->'optionDigest' OR facts->'netContent' IS DISTINCT FROM p_reference->'netContent'
  OR (p_reference ? 'demandPolicyRef' AND facts->'demandPolicyRef' IS DISTINCT FROM p_reference->'demandPolicyRef')
  OR NOT EXISTS(SELECT 1 FROM public.catalog_type_versions t WHERE t.type_key=p_reference#>>'{typeRef,key}'
    AND t.version=(p_reference#>>'{typeRef,version}')::integer AND t.definition_digest=p_reference->>'definitionDigest')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'skus') entry WHERE entry=jsonb_build_object('skuId',revision.sku_id,'revisionId',revision.id,'revision',revision.revision,'digest',revision.digest)) THEN
  RAISE EXCEPTION 'catalog_accepted_reference_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE FUNCTION public.subscription_successor_proposal_offer_v2(p_subscription_id uuid,p_client_id uuid,p_request jsonb,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions; q public.subscription_quote_previews; p public.subscription_successor_proposals;
 source jsonb; hash text; proposal_id uuid; predecessor uuid; successor uuid; publication uuid; root uuid; original_case uuid;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 proposal_id:=(p_request->>'proposalId')::uuid; predecessor:=(p_request->>'predecessorSkuId')::uuid; successor:=(p_request->>'successorSkuId')::uuid; publication:=(p_request->>'publicationId')::uuid;
 IF proposal_id IS NULL OR predecessor IS NULL OR successor IS NULL OR publication IS NULL OR predecessor=successor
  OR p_request->>'lane' NOT IN ('classic','exact','sized','legacy') OR p_request->>'lane' IS NULL
  OR jsonb_typeof(p_request->'sourceBinding') IS DISTINCT FROM 'object' OR jsonb_typeof(p_request->'applyPayload') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.clients WHERE id=s.client_id FOR KEY SHARE NOWAIT;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE id=(p_request->>'previewId')::uuid FOR UPDATE NOWAIT;
 IF NOT FOUND OR q.subscription_id IS DISTINCT FROM s.id OR q.client_id IS DISTINCT FROM s.client_id OR q.template_version IS DISTINCT FROM s.template_version
  OR q.status<>'previewed' OR q.expires_at<=p_now OR q.action IS DISTINCT FROM p_request->>'action'
  OR jsonb_typeof(q.quote_snapshot->'editConsent') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 source:=p_request->'sourceBinding';
 IF source->>'kind'='stock_wait' THEN
  IF source->>'caseKind' NOT IN ('legacy','successor') OR source->>'caseKind' IS NULL THEN RAISE EXCEPTION 'stock_wait_case_kind_invalid' USING ERRCODE='22023'; END IF;
  IF source->>'caseKind'='legacy' THEN
   SELECT c.id,c.renewal_operation_id INTO original_case,root FROM public.subscription_stock_wait_cases c WHERE c.id=(source->>'caseId')::uuid AND c.subscription_id=s.id AND c.client_id=s.client_id;
  ELSE
   SELECT c.root_case_id,g.root_operation_id INTO original_case,root FROM public.subscription_successor_wait_cases_v2 c JOIN public.subscription_successor_operations_v2 g ON g.id=c.operation_id
    WHERE c.id=(source->>'caseId')::uuid AND c.subscription_id=s.id AND c.client_id=s.client_id;
  END IF;
  IF original_case IS NULL OR root IS NULL THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 ELSIF source->>'kind' IS DISTINCT FROM 'ordinary_edit' THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 IF root IS NOT NULL THEN
  BEGIN
   PERFORM 1 FROM public.subscription_renewal_operations WHERE id=root AND subscription_id=s.id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.subscription_stock_wait_cases WHERE id=original_case FOR UPDATE NOWAIT;
 END IF;
 -- The new hash binds the complete retained native preview and explicit source; its inner hash stays unchanged.
 hash:=encode(sha256(convert_to(jsonb_build_array('subscription.successor',2,proposal_id,p_subscription_id,p_client_id,predecessor,successor,publication,source,p_request->>'lane',p_request->>'action',q.quote_hash,q.request_payload,q.quote_snapshot,q.totals,p_request)::text,'UTF8')),'hex');
 SELECT * INTO p FROM public.subscription_successor_proposals WHERE id=proposal_id FOR UPDATE NOWAIT;
 IF FOUND THEN
  IF p.subscription_id IS DISTINCT FROM s.id OR p.client_id IS DISTINCT FROM s.client_id OR p.quote_hash IS DISTINCT FROM hash OR p.request IS DISTINCT FROM p_request THEN
   RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN to_jsonb(p);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.catalog_sku_successors WHERE predecessor_sku_id=predecessor AND successor_sku_id=successor AND publication_id=publication) THEN
  RAISE EXCEPTION 'successor_pair_not_declared' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=predecessor)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.quote_snapshot#>'{editConsent,lines}') l WHERE l->>'variantId'=successor::text AND l->>'kind'='added') THEN
  RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 INSERT INTO public.subscription_successor_proposals(id,subscription_id,client_id,predecessor_sku_id,successor_sku_id,publication_id,
  source_binding,template_version,lane,action,request,preview,quote_hash,expires_at,original_case_id,original_operation_id,created_at)
 VALUES(proposal_id,s.id,s.client_id,predecessor,successor,publication,source,s.template_version,p_request->>'lane',p_request->>'action',p_request,to_jsonb(q),hash,q.expires_at,original_case,root,p_now) RETURNING * INTO p;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
 VALUES('subscription',s.id,'subscription.successor.offered.v2','subscription-successor:'||p.id::text||':offered:v2',
  jsonb_build_object('schemaVersion',2,'proposalId',p.id,'subscriptionId',s.id,'clientId',s.client_id,'predecessorSkuId',predecessor,'successorSkuId',successor,'quoteHash',hash,'expiresAt',q.expires_at));
 RETURN to_jsonb(p);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_successor_proposal_offer_v2(uuid,uuid,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.resolve_stock_wait_with_successor(p_case_id uuid,p_proposal_id uuid,p_accepted_quote_hash text,p_command_key text,p_client_id uuid,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_proposals; proposal public.subscription_successor_proposals; s public.subscriptions;
 root public.subscription_renewal_operations; prior_generation public.subscription_successor_operations_v2; prior_case public.subscription_stock_wait_cases;
 prior_case_v2 public.subscription_successor_wait_cases_v2; q public.subscription_quote_previews; receipt public.subscription_command_receipts;
 p_actor_id uuid; p_subscription_id uuid; p_key text; p_action text; p_payload jsonb;
 command jsonb; command_fingerprint text; lane_result jsonb; answer jsonb; generation uuid:=gen_random_uuid(); wait_id uuid:=gen_random_uuid();
 snapshot jsonb; basket jsonb; new_fingerprint text; source text; deficits jsonb:='[]'; item jsonb; product uuid; price_context jsonb;
 stock public.fulfillment_stock_current; available bigint; g public.subscription_successor_operations_v2; c public.subscription_successor_wait_cases_v2;
 admission jsonb; source_case_kind text; prior_operation uuid; prior_fingerprint text; prior_snapshot jsonb; prior_identity text;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR p_case_id IS NULL OR p_proposal_id IS NULL OR p_client_id IS NULL
  OR p_command_key IS NULL OR p_command_key<>btrim(p_command_key) OR length(p_command_key) NOT BETWEEN 8 AND 180
  OR p_accepted_quote_hash IS NULL OR p_accepted_quote_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO hint FROM public.subscription_successor_proposals WHERE id=p_proposal_id AND client_id=p_client_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 p_actor_id:=(hint.preview->>'actor_id')::uuid; p_subscription_id:=hint.subscription_id;
 IF p_actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action','resolve_stock_wait_with_successor',
  'payload',jsonb_build_object('caseId',p_case_id,'proposalId',p_proposal_id,'acceptedQuoteHash',p_accepted_quote_hash));
 command_fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 IF NOT pg_try_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_command_key,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO receipt FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_command_key;
 IF FOUND THEN
  IF receipt.command IS DISTINCT FROM command OR receipt.command_fingerprint IS DISTINCT FROM command_fingerprint OR receipt.quote_hash IS DISTINCT FROM p_accepted_quote_hash OR receipt.status<>'applied' THEN
   RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN receipt.result;
 END IF;
 p_key:='successor-edit:'||encode(sha256(convert_to(p_actor_id::text||':'||p_command_key,'UTF8')),'hex');
 IF NOT pg_try_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(846832106,1) THEN RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.clients WHERE id=s.client_id FOR KEY SHARE NOWAIT;
 SELECT * INTO proposal FROM public.subscription_successor_proposals WHERE id=p_proposal_id FOR UPDATE NOWAIT;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE id=(proposal.preview->>'id')::uuid FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_edit_quotes WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
 BEGIN
  SELECT * INTO root FROM public.subscription_renewal_operations WHERE id=proposal.original_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO prior_generation FROM public.subscription_successor_operations_v2 WHERE root_operation_id=root.id AND superseded_by_proposal_id IS NULL FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_stock_wait_cases WHERE id=proposal.original_case_id FOR UPDATE NOWAIT;
 source_case_kind:=proposal.source_binding->>'caseKind';
 IF proposal.source_binding->>'kind' IS DISTINCT FROM 'stock_wait' OR source_case_kind NOT IN ('legacy','successor') OR source_case_kind IS NULL
  OR proposal.source_binding->>'caseId' IS DISTINCT FROM p_case_id::text THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF source_case_kind='legacy' THEN
  SELECT * INTO prior_case FROM public.subscription_stock_wait_cases WHERE id=p_case_id FOR UPDATE NOWAIT;
  IF prior_case.renewal_operation_id IS DISTINCT FROM root.id OR prior_generation.id IS NOT NULL OR prior_case.id IS DISTINCT FROM proposal.original_case_id THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
  prior_operation:=root.id; prior_fingerprint:=root.operation_fingerprint; prior_snapshot:=root.cycle_snapshot; prior_identity:=root.identity_key;
 ELSE
  SELECT * INTO prior_case_v2 FROM public.subscription_successor_wait_cases_v2 WHERE id=p_case_id FOR UPDATE NOWAIT;
  IF prior_case_v2.operation_id IS DISTINCT FROM prior_generation.id OR prior_case_v2.root_case_id IS DISTINCT FROM proposal.original_case_id OR prior_generation.id IS NULL THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
  prior_operation:=prior_generation.id; prior_fingerprint:=prior_generation.operation_fingerprint; prior_snapshot:=prior_generation.cycle_snapshot; prior_identity:=prior_generation.identity_key;
 END IF;
 IF root.id IS NULL OR proposal.subscription_id IS DISTINCT FROM s.id OR proposal.client_id IS DISTINCT FROM p_client_id
  OR proposal.state<>'offered' OR proposal.quote_hash IS DISTINCT FROM p_accepted_quote_hash OR proposal.expires_at<=p_now OR proposal.template_version<>s.template_version
  OR q.id IS NULL OR q.status<>'previewed' OR to_jsonb(q) IS DISTINCT FROM proposal.preview THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 IF (source_case_kind='legacy' AND (prior_case.state NOT IN ('waiting','stock_secured') OR prior_case.fingerprint IS DISTINCT FROM prior_fingerprint OR prior_case.cycle_snapshot IS DISTINCT FROM prior_snapshot OR prior_case.identity_key IS DISTINCT FROM prior_identity))
  OR (source_case_kind='successor' AND (prior_case_v2.state NOT IN ('waiting','stock_secured') OR prior_case_v2.fingerprint IS DISTINCT FROM prior_fingerprint OR prior_case_v2.cycle_snapshot IS DISTINCT FROM prior_snapshot OR prior_case_v2.identity_key IS DISTINCT FROM prior_identity)) THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF root.attempt_prepared_at IS NOT NULL OR root.external_attempt_ref IS NOT NULL OR root.external_attempt_acknowledged_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=root.id OR subscription_id=s.id AND scheduled_at=root.scheduled_at)
  OR EXISTS(SELECT 1 FROM public.commerce_orders WHERE renewal_operation_id=root.id)
  OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE renewal_operation_id=root.id)
  OR EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=root.id AND
   (outcome<>'refused' OR coalesce(reason,'') NOT IN ('inventory_unavailable','reservation_expired') OR external_ref IS NOT NULL
    OR operation_fingerprint IS DISTINCT FROM root.operation_fingerprint OR event_key NOT IN (root.identity_key||':inventory',root.identity_key||':reservation-expired')))
  OR EXISTS(SELECT 1 FROM public.subscription_successor_operations_v2 WHERE root_operation_id=root.id AND
   (cycle_id IS NOT NULL OR order_id IS NOT NULL OR settlement_intent_id IS NOT NULL OR fulfillment_id IS NOT NULL OR attempt_prepared_at IS NOT NULL OR external_attempt_ref IS NOT NULL OR external_attempt_acknowledged_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(outcomes) o WHERE o->>'outcome'<>'refused' OR coalesce(o->>'reason','') NOT IN ('inventory_unavailable','reservation_expired') OR o->>'externalRef' IS NOT NULL))) THEN
  RAISE EXCEPTION 'stock_wait_successor_provider_owned' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM root.scheduled_at THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 IF source_case_kind='legacy' AND root.lease_expires_at>p_now OR source_case_kind='successor' AND prior_generation.lease_expires_at>p_now THEN RAISE EXCEPTION 'stock_wait_successor_lease_active' USING ERRCODE='22023'; END IF;
 IF source_case_kind='legacy' AND NOT (root.state='refused' AND root.terminal_reason IN ('inventory_unavailable','reservation_expired') OR root.state='reserved' AND prior_case.state='stock_secured')
  OR source_case_kind='successor' AND NOT (prior_generation.state='refused' AND prior_generation.terminal_reason IN ('inventory_unavailable','reservation_expired') OR prior_generation.state='reserved' AND prior_case_v2.state='stock_secured') THEN RAISE EXCEPTION 'stock_wait_successor_not_stock_only' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=root.id ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id IN (SELECT id FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=root.id) ORDER BY reservation_id,sku FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_successor_reservations_v2 WHERE operation_id=prior_generation.id ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations r WHERE r.renewal_operation_id=root.id AND
  (r.operation_fingerprint IS DISTINCT FROM root.operation_fingerprint OR r.source_key IS DISTINCT FROM root.cycle_snapshot->>'stockSourceKey'
   OR r.status IN ('committed','consumed') OR (r.status='held' AND source_case_kind='legacy' AND prior_case.state<>'stock_secured')
   OR (SELECT jsonb_agg(jsonb_build_object('sku',l.sku,'quantity',l.quantity) ORDER BY l.sku) FROM public.fulfillment_inventory_reservation_lines l WHERE l.reservation_id=r.id)
    IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('sku',l->>'sku','quantity',(l->>'quantity')::integer) ORDER BY l->>'sku') FROM jsonb_array_elements(root.cycle_snapshot->'lines') l)))
  OR EXISTS(SELECT 1 FROM public.subscription_successor_reservations_v2 r WHERE r.operation_id=prior_generation.id AND r.status IN ('committed','consumed')) THEN
  RAISE EXCEPTION 'stock_wait_successor_provider_owned' USING ERRCODE='22023'; END IF;
 p_action:=proposal.action; p_payload:=proposal.request->'applyPayload';
 -- The selected native lane still consumes its original ledger/hash and complete request.
 p_payload:=jsonb_set(jsonb_set(p_payload,'{acceptedQuoteHash}',to_jsonb(q.quote_hash)),'{request,acceptedQuoteHash}',to_jsonb(q.quote_hash));
 admission:=p_payload->'catalogAdmission';
 IF admission IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
 source:=prior_snapshot->>'stockSourceKey';
 PERFORM k.sku FROM public.fulfillment_stock_current k WHERE k.source_key=source AND (
  k.sku IN (SELECT value->>'sku' FROM jsonb_array_elements(prior_snapshot->'lines')) OR k.sku IN (
   SELECT sku.sku FROM public.catalog_skus sku JOIN jsonb_array_elements(admission->'skuRevisions') l ON sku.id=(l#>>'{reference,skuId}')::uuid))
  ORDER BY k.source_key,k.sku FOR UPDATE NOWAIT;
 -- Every catalogue prelock is shared, nonblocking and last. Native lane reacquisitions are exact preheld targets.
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 FOR product IN SELECT DISTINCT sku.product_id FROM public.catalog_skus sku WHERE sku.id=proposal.predecessor_sku_id OR sku.id IN (SELECT (r#>>'{reference,skuId}')::uuid FROM jsonb_array_elements(admission->'skuRevisions') r) ORDER BY sku.product_id LOOP
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-lineage:'||product::text,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 END LOOP;
 PERFORM h.product_id FROM public.catalog_publication_heads h WHERE h.product_id IN (SELECT sku.product_id FROM public.catalog_skus sku WHERE sku.id=proposal.predecessor_sku_id OR sku.id IN (SELECT (r#>>'{reference,skuId}')::uuid FROM jsonb_array_elements(admission->'skuRevisions') r)) ORDER BY h.product_id FOR SHARE NOWAIT;
 PERFORM k.id FROM public.catalog_products k WHERE k.id IN (SELECT sku.product_id FROM public.catalog_skus sku WHERE sku.id=proposal.predecessor_sku_id OR sku.id IN (SELECT (r#>>'{reference,skuId}')::uuid FROM jsonb_array_elements(admission->'skuRevisions') r)) ORDER BY k.id FOR SHARE NOWAIT;
 PERFORM sku.id FROM public.catalog_skus sku WHERE sku.id=proposal.predecessor_sku_id OR sku.id IN (SELECT (r#>>'{reference,skuId}')::uuid FROM jsonb_array_elements(admission->'skuRevisions') r) ORDER BY sku.id FOR SHARE NOWAIT;
 FOR price_context IN SELECT value FROM jsonb_array_elements(admission->'priceContextVersions') ORDER BY (value->>'priceListId')::uuid,(value->>'skuId')::uuid LOOP
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-price-setup:'||((price_context->>'priceListId')::uuid)::text||':'||((price_context->>'skuId')::uuid)::text,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 END LOOP;
 PERFORM k.id FROM public.price_lists k WHERE k.id IN (SELECT (value->>'priceListId')::uuid FROM jsonb_array_elements(admission->'priceContextVersions')) ORDER BY k.id FOR SHARE NOWAIT;
 PERFORM k.id FROM public.price_entries k WHERE k.id IN (SELECT (value->>'entryId')::uuid FROM jsonb_array_elements(admission->'priceContextVersions')) ORDER BY k.id FOR SHARE NOWAIT;
 PERFORM public.catalog_admission_assert_current(admission->'heads',admission->'skuRevisions','subscription',(admission->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane',proposal.lane,'optIn',coalesce((p_payload#>>'{request,resizeLever,value,optInToSized}')::boolean,false)),admission->'priceContextVersions','account');
 IF NOT EXISTS(SELECT 1 FROM public.catalog_skus predecessor JOIN public.catalog_products product ON product.id=predecessor.product_id
  JOIN public.catalog_publication_heads head ON head.product_id=product.id JOIN public.catalog_publications publication ON publication.id=head.publication_id
  WHERE predecessor.id=proposal.predecessor_sku_id AND predecessor.publication_facts->'schemaVersion'='3'::jsonb AND product.publication_facts->'schemaVersion'='3'::jsonb
   AND product.publication_facts=publication.canonical_state::jsonb->'product'
   AND (predecessor.publication_facts->>'lifecycleState'='withdrawn' OR product.publication_facts->>'lifecycleState'='withdrawn')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(prior_snapshot->'lines') l WHERE l->>'sku'=predecessor.sku)) THEN
  RAISE EXCEPTION 'stock_wait_successor_predecessor_not_withdrawn' USING ERRCODE='22023'; END IF;
 -- Effects start only after ownership, frozen identity, quote and current admission.
 IF source_case_kind='legacy' THEN
  UPDATE public.subscription_stock_wait_cases SET state='closed',closed_at=p_now,block_reason='superseded_by_successor' WHERE id=p_case_id;
  IF root.state NOT IN ('succeeded','refused') THEN UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',terminal_reason='superseded_by_successor',terminal_at=p_now,updated_at=p_now WHERE id=root.id; END IF;
 ELSE
  UPDATE public.subscription_successor_wait_cases_v2 SET state='closed',closed_at=p_now,block_reason='superseded_by_successor',superseded_by_proposal_id=proposal.id WHERE id=p_case_id;
  UPDATE public.subscription_successor_operations_v2 SET superseded_by_proposal_id=proposal.id,updated_at=p_now WHERE id=prior_generation.id;
 END IF;
 UPDATE public.fulfillment_inventory_reservations SET status='released',expires_at=NULL,terminal_reason='superseded_by_successor',updated_at=p_now
  WHERE renewal_operation_id=root.id AND status IN ('held','expired');
 UPDATE public.subscription_successor_reservations_v2 SET status='released',expires_at=NULL,terminal_reason='superseded_by_successor',updated_at=p_now
  WHERE operation_id=prior_generation.id AND status IN ('held','expired');
 IF proposal.lane='classic' THEN
<<accepted_lane>>
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 core jsonb; addons jsonb; stored jsonb; line_pricing jsonb; constraint_value jsonb;
 plan integer; version integer; minimum_text text; minimum_units integer; line jsonb; ordinal integer:=0;
 core_matches boolean; addon_matches boolean; outcome text:='applied';
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,
  'action','update_package_template','payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   lane_result:=jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); EXIT accepted_lane; END IF;
  IF r.status IN ('applied','noop') THEN lane_result:=r.result||jsonb_build_object('status','replayed','originalStatus',r.status); EXIT accepted_lane; END IF;
  IF r.status='refused' THEN lane_result:=r.result; EXIT accepted_lane; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 core:=p_payload->'baseLines'; addons:=COALESCE(p_payload->'addonLines','[]'::jsonb);
 IF jsonb_typeof(core) IS DISTINCT FROM 'array' OR jsonb_array_length(core)=0 OR jsonb_typeof(addons)<>'array' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT value_text INTO minimum_text FROM public.commerce_settings WHERE key='subscription_minimum_base_units';
 IF minimum_text IS NULL OR minimum_text !~ '^[1-9][0-9]*$' OR length(minimum_text)>10 THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END IF;
 BEGIN minimum_units:=minimum_text::integer;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END;
 IF (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<minimum_units THEN
  RAISE EXCEPTION 'subscription_edit_below_minimum_order_units' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 -- Bind the fingerprinted customer request to its server enrichment. Nominal
 -- cadence/version are intentionally server-resolved; price evidence is ledger-bound below.
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,base}'),
  public.subscription_quote_variant_qty_request(p_payload->'base'));
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,addons}'),
  public.subscription_quote_variant_qty_request(p_payload->'addons'));
 plan:=(p_payload->>'planDays')::integer;
 -- Set equality is order/price independent and aggregates repeated variants.
 SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
 INTO core_matches,addon_matches FROM (
  SELECT is_addon,jsonb_typeof(wanted)='array' AND
   (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
    SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$' GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id
     AND is_addon=inputs.is_addon GROUP BY variant_id) current_lines)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') AS matches
  FROM (VALUES(false,core),(true,addons)) inputs(is_addon,wanted)
 ) line_sets;
 IF plan=s.cadence_days AND core_matches AND addon_matches THEN outcome:='noop';
 ELSE
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,'update_package_template',
   p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'planDays',q#>'{request_payload,planDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'base'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,base}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'addons'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,addons}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(core),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,baseLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(addons),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,addonLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'currentRecurringPrice',q#>'{totals,currentRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'newRecurringPrice',q#>'{totals,newRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'delta',q#>'{totals,delta}');
  IF plan IS NULL OR plan<1 THEN RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023'; END IF;
  constraint_value:=q#>'{quote_snapshot,compositionConstraint}';
  IF constraint_value IS NULL THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  IF p_payload ? 'compositionConstraint' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',constraint_value);
  END IF;
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(core||addons) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=s.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=q#>'{quote_snapshot,catalogAdmission}';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(core||addons) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','classic','optIn',false),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  constraint_value:=NULLIF(constraint_value,'null'::jsonb);
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  line_pricing:='[]'::jsonb;
  FOR line IN SELECT v||jsonb_build_object('isAddon',ord>jsonb_array_length(core))
   FROM jsonb_array_elements(core||addons) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
    (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,
   template_version=template_version+1,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.update_package_template',event_key,
    jsonb_build_object('action','update_package_template','quotePreviewId',q->>'id','linePricing',line_pricing,
     'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=s.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=v_catalog_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action','update_package_template','subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 lane_result:=answer; EXIT accepted_lane;
END accepted_lane;
ELSIF proposal.lane='exact' THEN
<<accepted_lane>>
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 lines jsonb; line jsonb; line_pricing jsonb:='[]'::jsonb; constraint_value jsonb;
 version integer; plan integer; ordinal integer:=0; target_id uuid; new_line_id uuid;
 base_matches boolean; outcome text:='applied'; base_set boolean;
 current_total bigint; desired_total bigint;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('swap_base_line','add_addon','remove_addon','update_addon_quantity',
  'update_plan_length','update_base_mix','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   lane_result:=jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); EXIT accepted_lane; END IF;
  IF r.status IN ('applied','noop') THEN lane_result:=r.result||jsonb_build_object('status','replayed','originalStatus',r.status); EXIT accepted_lane; END IF;
  IF r.status='refused' THEN lane_result:=r.result; EXIT accepted_lane; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,action}',to_jsonb(p_action));
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 lines:=p_payload->'lines';
 base_set:=p_action IN ('update_plan_length','update_base_mix','update_portion');
 IF base_set AND jsonb_typeof(lines)='array' THEN
  SELECT (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
   SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(lines) v
   WHERE (v->>'isAddon')::boolean=false GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon
     GROUP BY variant_id) current_lines) INTO base_matches;
 END IF;
 IF p_action='swap_base_line' THEN
  IF (p_payload#>>'{request,fromVariantId}')::uuid=(p_payload#>>'{request,toVariantId}')::uuid THEN outcome:='noop'; END IF;
 ELSIF p_action IN ('add_addon','update_addon_quantity') THEN
  IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon
   AND variant_id=(p_payload#>>'{request,variantId}')::uuid AND quantity=(p_payload#>>'{request,qty}')::integer) THEN outcome:='noop'; END IF;
 ELSIF p_action='update_base_mix' THEN
  IF base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_plan_length' THEN
  IF (p_payload#>>'{request,planDays}')::integer=s.cadence_days AND base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_portion' THEN
  IF base_matches AND COALESCE(s.composition_constraint->>'mode',p_payload#>>'{portionModes,full,mode}')=p_payload#>>'{request,portionMode}'
   AND COALESCE(s.composition_constraint->'portionFactor',p_payload#>'{portionModes,full,factor}')=p_payload#>'{compositionConstraint,portionFactor}' THEN outcome:='noop'; END IF;
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,p_action,p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal((p_payload->'request')-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',q#>'{quote_snapshot,compositionConstraint}');
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=s.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=q#>'{quote_snapshot,catalogAdmission}';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(lines) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','exact','optIn',false),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  plan:=s.cadence_days; constraint_value:=s.composition_constraint;
  IF p_action='swap_base_line' THEN
   IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,toVariantId}')::uuid) THEN
    RAISE EXCEPTION 'subscription_edit_conflict_duplicate_line' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET variant_id=(p_payload#>>'{request,toVariantId}')::uuid,
    catalog_sku_revision_id=(SELECT (ref->>'skuRevisionId')::uuid FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref
      WHERE ref->>'skuId'=p_payload#>>'{request,toVariantId}'),updated_at=p_now
    WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,fromVariantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_line' USING ERRCODE='22023'; END IF;
  ELSIF p_action='add_addon' THEN
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(p_payload#>>'{request,variantId}')::uuid,GREATEST(1,COALESCE((p_payload#>>'{request,qty}')::integer,1)),
    COALESCE((SELECT max(sort_order)+1 FROM public.subscription_lines WHERE subscription_id=s.id),1),true,0,s.currency_code)
   RETURNING id INTO new_line_id;
  ELSIF p_action='remove_addon' THEN
   DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_addon_quantity' THEN
   IF (p_payload#>>'{request,qty}')::integer IS NULL OR (p_payload#>>'{request,qty}')::integer<=0 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_addon_qty' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET quantity=(p_payload#>>'{request,qty}')::integer,updated_at=p_now
    WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_plan_length' THEN
   plan:=(p_payload#>>'{request,planDays}')::integer;
   IF plan IS NULL OR plan<=0 THEN RAISE EXCEPTION 'subscription_edit_invalid_plan_length' USING ERRCODE='22023'; END IF;
   constraint_value:=NULLIF(q#>'{quote_snapshot,compositionConstraint}','null'::jsonb);
  ELSIF p_action='update_base_mix' THEN
   SELECT COALESCE(sum(quantity),0) INTO current_total FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
   SELECT COALESCE(sum((v->>'qty')::integer),0) INTO desired_total FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
   IF desired_total<>current_total THEN RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_portion' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'portionModes',q#>'{quote_snapshot,portionModes}');
   IF p_payload#>>'{request,portionMode}' IS NULL OR
    (p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,full,mode}'
     AND p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,reduced,mode}')
    OR p_payload#>>'{compositionConstraint,mode}' IS DISTINCT FROM p_payload#>>'{request,portionMode}'
    OR jsonb_typeof(p_payload#>'{compositionConstraint,portionFactor}') IS DISTINCT FROM 'number'
    OR (p_payload#>>'{compositionConstraint,portionFactor}')::numeric<=0
    OR p_payload#>'{compositionConstraint,portionFactor}' IS DISTINCT FROM (CASE
      WHEN p_payload#>>'{request,portionMode}'=p_payload#>>'{portionModes,full,mode}' THEN p_payload#>'{portionModes,full,factor}'
      ELSE p_payload#>'{portionModes,reduced,factor}' END) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_portion_mode' USING ERRCODE='22023'; END IF;
   constraint_value:=jsonb_set(jsonb_set(COALESCE(s.composition_constraint,'{}'::jsonb),'{mode}',p_payload#>'{compositionConstraint,mode}'),
    '{portionFactor}',p_payload#>'{compositionConstraint,portionFactor}');
  END IF;
  IF base_set THEN DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon; END IF;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF base_set AND NOT (line->>'isAddon')::boolean THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
    VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,false,
     (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code) RETURNING id INTO target_id;
   ELSE
    target_id:=COALESCE((line->>'lineId')::uuid,new_line_id);
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
     currency_code=s.currency_code,updated_at=p_now WHERE id=target_id AND subscription_id=s.id
     AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer AND is_addon=(line->>'isAddon')::boolean;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=s.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=v_catalog_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 lane_result:=answer; EXIT accepted_lane;
END accepted_lane;
ELSIF proposal.lane='sized' THEN
<<accepted_lane>>
DECLARE v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 action text; request jsonb; command jsonb; fingerprint text; answer jsonb; q jsonb; lines jsonb; line jsonb;
 event_id uuid; event_key text; line_pricing jsonb:='[]'::jsonb; version integer; plan integer; ordinal integer:=0;
 constraint_value jsonb; opt_in boolean; intro jsonb; phase_config jsonb; paid integer;
 current_core jsonb; desired_core jsonb; outcome text:='applied'; rewrites_addons boolean;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'request') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 request:=p_payload->'request'; action:=request->>'action';
 IF action IS NULL OR action NOT IN ('resize_bundle','update_bundle','update_base_mix','update_plan_length','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',action,'payload',request);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM request->>'acceptedQuoteHash' THEN
   lane_result:=jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); EXIT accepted_lane; END IF;
  IF r.status IN ('applied','noop') THEN lane_result:=r.result||jsonb_build_object('status','replayed','originalStatus',r.status); EXIT accepted_lane; END IF;
  IF r.status='refused' THEN lane_result:=r.result; EXIT accepted_lane; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 opt_in:=action='resize_bundle' AND request#>>'{resizeLever,kind}'='subscription.sized.parcel'
  AND request#>'{resizeLever,value,optInToSized}'='true'::jsonb;
 IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND COALESCE(opt_in,false)) THEN
  RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 intro:=public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}';
 IF intro IS NOT NULL THEN
  SELECT value_text::jsonb INTO phase_config FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
  IF phase_config IS NULL OR COALESCE(phase_config->>'fixedThroughCycle','') !~ '^[1-9][0-9]*$'
   OR COALESCE(phase_config->>'graduationCycle','') !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO paid FROM public.subscription_cycles WHERE subscription_id=s.id AND status='paid';
  IF paid+1<=(phase_config->>'fixedThroughCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
  IF COALESCE(opt_in,false) AND s.template_version=(intro->>'basisTemplateVersion')::integer
   AND paid<(phase_config->>'graduationCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
 END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(request->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 lines:=p_payload->'lines'; constraint_value:=p_payload->'compositionConstraint'; plan:=(p_payload->>'cadenceDays')::integer;
 IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0
  OR jsonb_typeof(constraint_value) IS DISTINCT FROM 'object' OR plan IS NULL OR plan<=0 THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) INTO current_core FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
 SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb) INTO desired_core FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
 rewrites_addons:=action='update_bundle' AND request ? 'addonLines';
 IF action IN ('update_base_mix','update_bundle') AND (action='update_base_mix' OR plan=s.cadence_days)
  AND (SELECT sum((v->>'qty')::integer) FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean)
   <>(SELECT sum(quantity) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
  RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(opt_in,false) AND current_core=desired_core AND plan=s.cadence_days AND constraint_value=s.composition_constraint
  AND (NOT rewrites_addons OR (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean)=(SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb)
    FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon)) THEN outcome:='noop';
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,action,request->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(request-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(constraint_value,q#>'{quote_snapshot,compositionConstraint}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'subjectFacts',q#>'{quote_snapshot,subjectFacts}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'optInFacts',q#>'{quote_snapshot,optInFacts}');
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=s.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=q#>'{quote_snapshot,catalogAdmission}';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(lines) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','sized','optIn',coalesce(opt_in,false)),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  -- Admission is current SKU state under a row lock; no catalogue publication head exists here.
  FOR line IN SELECT v FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean LOOP
   IF COALESCE(opt_in,false) OR (line->>'qty')::integer>COALESCE((current_core->>(line->>'variantId'))::integer,0) THEN
    PERFORM 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND status='active' AND sellable_in_subscription FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_invalid_sku_admission' USING ERRCODE='22023'; END IF;
   END IF;
  END LOOP;
  IF NOT rewrites_addons AND (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean) IS DISTINCT FROM
   (SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon) THEN
   RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND (NOT is_addon OR rewrites_addons);
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF line#>>'{quoteLine,unitPriceGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>>'{quoteLine,lineSubtotalGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>'{quoteLine,quantity}' IS DISTINCT FROM line->'qty'
    OR line#>'{quoteLine,lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb((line->>'qty')::bigint*(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint)
    OR NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND sku=line#>>'{quoteLine,sku}') THEN
    RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   IF NOT (line->>'isAddon')::boolean OR rewrites_addons THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
     VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
      (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   ELSE
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,updated_at=p_now
     WHERE subscription_id=s.id AND id=(line->>'lineId')::uuid AND is_addon AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    VALUES(s.id,ordinal,line#>>'{quoteLine,sku}',(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint);
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}','quantity',(line->>'qty')::integer,
    'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  -- AFTER-row triggers run at statement end. The CTE makes native FK-bound
  -- acceptance visible before the binding trigger checks the accepted join.
  WITH inserted AS (
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||action,event_key,jsonb_build_object('action',action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',request-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],'optInFacts',p_payload->'optInFacts',
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now) RETURNING id
   ), accepted AS MATERIALIZED (
    SELECT id,public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,id,p_now) AS acceptance FROM inserted
   ) SELECT id INTO event_id FROM accepted;
 END IF;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=s.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=v_catalog_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,request->>'acceptedQuoteHash',answer,outcome);
 lane_result:=answer; EXIT accepted_lane;
END accepted_lane;
ELSE RAISE EXCEPTION 'successor_lane_unavailable' USING ERRCODE='55000'; END IF;
 IF lane_result->>'status' NOT IN ('applied','noop','replayed') OR lane_result->>'status' IS NULL THEN RAISE EXCEPTION 'successor_lane_refused' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('lineOrdinal',l.line_ordinal,'sku',l.sku,'quantity',l.quantity,'unitAmountMinor',l.unit_amount_minor) ORDER BY l.line_ordinal),'[]'::jsonb) INTO basket
  FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=s.id;
 IF NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=s.id AND l.variant_id=proposal.successor_sku_id)
  OR EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=s.id AND l.variant_id=proposal.predecessor_sku_id) THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 snapshot:=proposal.request->'cycleSnapshot';
 IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->'lines' IS DISTINCT FROM basket
  OR snapshot->>'contractVersion' IS DISTINCT FROM prior_snapshot->>'contractVersion'
  OR snapshot->>'subscriptionId' IS DISTINCT FROM s.id::text OR (snapshot->>'scheduledAt')::timestamptz IS DISTINCT FROM root.scheduled_at
  OR snapshot->'cycleNumber' IS DISTINCT FROM to_jsonb(root.cycle_number) OR snapshot->>'currency' IS DISTINCT FROM prior_snapshot->>'currency'
  OR snapshot->>'stockSourceKey' IS DISTINCT FROM prior_snapshot->>'stockSourceKey' OR snapshot->>'settlementChannelKey' IS DISTINCT FROM prior_snapshot->>'settlementChannelKey'
  OR snapshot->>'authorizationRef' IS DISTINCT FROM prior_snapshot->>'authorizationRef' OR snapshot->'payerAccountRef' IS DISTINCT FROM prior_snapshot->'payerAccountRef'
  OR snapshot->'unattendedChargeAuthorizedAt' IS DISTINCT FROM prior_snapshot->'unattendedChargeAuthorizedAt'
  OR snapshot->'cycle' IS DISTINCT FROM prior_snapshot->'cycle'
  OR snapshot#>'{orderSnapshot,shippingAddressRef}' IS DISTINCT FROM prior_snapshot#>'{orderSnapshot,shippingAddressRef}'
  OR snapshot->>'currency' IS DISTINCT FROM q.quote_snapshot#>>'{editConsent,currency}'
  OR snapshot#>'{templateSnapshot,lines}' IS DISTINCT FROM basket OR snapshot#>'{orderSnapshot,lines}' IS DISTINCT FROM basket
  OR snapshot#>'{pricingSnapshot,totalAmountMinor}' IS DISTINCT FROM snapshot->'totalAmountMinor'
  OR coalesce(snapshot->>'frozenFingerprint','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'subscription_renewal_snapshot_inconsistent' USING ERRCODE='22023'; END IF;
 new_fingerprint:=snapshot->>'frozenFingerprint';
 INSERT INTO public.subscription_successor_operations_v2(id,root_operation_id,proposal_id,predecessor_generation_id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,due_snapshot,cycle_snapshot,state,claim_token,claimed_by,claimed_at,lease_expires_at,created_at,updated_at)
 VALUES(generation,root.id,proposal.id,prior_generation.id,s.id,root.scheduled_at,root.cycle_number,root.identity_key||':successor:'||proposal.id::text,new_fingerprint,
  jsonb_build_object('schemaVersion',2,'sourceCaseId',p_case_id,'sourceOperationId',prior_operation),snapshot,'claimed',gen_random_uuid(),'successor_resolution',p_now,p_now+interval '5 minutes',p_now,p_now) RETURNING * INTO g;
 FOR item IN SELECT value FROM jsonb_array_elements(basket) ORDER BY value->>'sku' LOOP
  SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=source AND sku=item->>'sku';
  IF stock.sku IS NULL THEN RAISE EXCEPTION 'stock_wait_stock_missing' USING ERRCODE='22023'; END IF;
  IF stock.stale_after<=p_now THEN RAISE EXCEPTION 'stock_wait_stock_stale' USING ERRCODE='22023'; END IF;
  available:=CASE WHEN stock.inventory_class='sellable' THEN (public.inventory_available_to_promise(source,stock.sku,p_now,true)->>'available_quantity')::bigint ELSE 0 END;
  IF available<(item->>'quantity')::integer THEN deficits:=deficits||jsonb_build_array(jsonb_build_object('sku',stock.sku,'requiredUnits',(item->>'quantity')::integer,'reservedUnits',0,'availableUnits',available,'missingUnits',(item->>'quantity')::integer-available)); END IF;
 END LOOP;
 IF jsonb_array_length(deficits)=0 THEN
  INSERT INTO public.subscription_successor_reservations_v2(id,operation_id,operation_fingerprint,source_key,lines,status,expires_at,created_at,updated_at)
   VALUES(gen_random_uuid(),g.id,new_fingerprint,source,basket,'held',p_now+interval '15 minutes',p_now,p_now);
  UPDATE public.subscription_successor_operations_v2 SET state='reserved' WHERE id=g.id RETURNING * INTO g;
 ELSE
  UPDATE public.subscription_successor_operations_v2 SET state='refused',terminal_outcome='refused',terminal_reason='inventory_unavailable',terminal_at=p_now,
   outcomes=jsonb_build_array(jsonb_build_object('eventKey',identity_key||':inventory','operationFingerprint',operation_fingerprint,'outcome','refused','reason','inventory_unavailable','externalRef',NULL,'occurredAt',p_now)) WHERE id=g.id RETURNING * INTO g;
 END IF;
 INSERT INTO public.subscription_successor_wait_cases_v2(id,root_case_id,operation_id,subscription_id,client_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at,stock_secured_at,block_reason)
 VALUES(wait_id,proposal.original_case_id,g.id,s.id,s.client_id,g.scheduled_at,g.cycle_number,CASE WHEN g.state='reserved' THEN 'stock_secured' ELSE 'waiting' END,
  public.subscription_successor_operation_snapshot_v2(g),snapshot,new_fingerprint,g.identity_key,deficits,p_now,p_now,CASE WHEN g.state='reserved' THEN p_now END,CASE WHEN g.state='refused' THEN 'inventory_unavailable' END) RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_record_opened_v2(c);
 answer:=jsonb_build_object('schemaVersion',2,'status','applied','proposalId',proposal.id,'operationId',g.id,'rootOperationId',root.id,'caseId',c.id,'caseKind','successor','quoteHash',p_accepted_quote_hash,'scheduledAt',g.scheduled_at,'cycleNumber',g.cycle_number,'laneReceipt',lane_result);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_command_key,s.id,s.client_id,command_fingerprint,command,p_accepted_quote_hash,answer,'applied');
 UPDATE public.subscription_successor_proposals SET state='accepted',consent=q.quote_snapshot->'editConsent',accepted_receipt=answer,terminal_at=p_now WHERE id=proposal.id;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
 VALUES('subscription',s.id,'subscription.successor.accepted.v2','subscription-successor:'||proposal.id::text||':accepted:v2',answer);
 RETURN answer;
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM IN ('inventory_admission_busy','lc10_root_operation_busy') THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.resolve_stock_wait_with_successor(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.fulfillment_release_successor_renewal_v2(p_operation_id uuid,p_claim_token uuid,p_reason text,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_operations_v2; g public.subscription_successor_operations_v2; r public.subscription_successor_reservations_v2;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'fulfillment_renewal_release_reason_required' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(846832106,1) THEN RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id;
 PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
 BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 IF g.id IS NULL OR g.claim_token IS DISTINCT FROM p_claim_token THEN RAISE EXCEPTION 'fulfillment_renewal_release_stale_claim' USING ERRCODE='40001'; END IF;
 IF g.attempt_prepared_at IS NOT NULL OR g.external_attempt_ref IS NOT NULL OR g.order_id IS NOT NULL OR r.status IN ('committed','consumed') THEN RAISE EXCEPTION 'fulfillment_renewal_release_attempt_indeterminate' USING ERRCODE='22023'; END IF;
 IF r.status='held' THEN UPDATE public.subscription_successor_reservations_v2 SET status='released',expires_at=NULL,terminal_reason=p_reason,updated_at=p_now WHERE id=r.id; END IF;
 RETURN jsonb_build_object('schemaVersion',2,'operationKind','successor','operationId',g.id,'released',r.status IN ('held','released','expired'),'reservationId',r.id);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM IN ('inventory_admission_busy','lc10_root_operation_busy') THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.fulfillment_release_successor_renewal_v2(uuid,uuid,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.fulfillment_expire_successor_renewals_v2(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint record; g public.subscription_successor_operations_v2; r public.subscription_successor_reservations_v2; affected integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_input' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(846832106,1) THEN RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03'; END IF;
 FOR hint IN SELECT op.id,op.subscription_id,op.root_operation_id FROM public.subscription_successor_reservations_v2 hold JOIN public.subscription_successor_operations_v2 op ON op.id=hold.operation_id
  WHERE hold.status='held' AND hold.expires_at<=p_now AND op.state='reserved' AND op.superseded_by_proposal_id IS NULL ORDER BY hold.expires_at,hold.id LIMIT p_limit LOOP
  PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
  BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
  SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=hint.id FOR UPDATE NOWAIT;
  SELECT * INTO r FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
  IF r.status<>'held' OR r.expires_at>p_now OR g.state<>'reserved' OR g.attempt_prepared_at IS NOT NULL OR g.superseded_by_proposal_id IS NOT NULL THEN CONTINUE; END IF;
  UPDATE public.subscription_successor_reservations_v2 SET status='expired',expires_at=NULL,terminal_reason='reservation_expired',updated_at=p_now WHERE id=r.id;
  UPDATE public.subscription_successor_operations_v2 SET state='refused',terminal_outcome='refused',terminal_reason='reservation_expired',terminal_at=p_now,
   outcomes=outcomes||jsonb_build_array(jsonb_build_object('eventKey',identity_key||':reservation-expired','operationFingerprint',operation_fingerprint,'outcome','refused','reason','reservation_expired','externalRef',NULL,'occurredAt',p_now)),updated_at=p_now WHERE id=g.id;
  affected:=affected+1;
 END LOOP;
 RETURN jsonb_build_object('schemaVersion',2,'expired',affected);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM IN ('inventory_admission_busy','lc10_root_operation_busy') THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.fulfillment_expire_successor_renewals_v2(integer,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_admit_v2(p_input jsonb,p_due jsonb,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g public.subscription_successor_operations_v2; p public.subscription_successor_proposals; c public.subscription_successor_wait_cases_v2; frozen jsonb; result jsonb;
BEGIN
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=(p_input->>'operationId')::uuid;
 frozen:=public.subscription_stock_wait_frozen_v2(g.id);
 IF frozen IS NULL OR frozen->'snapshot' IS DISTINCT FROM p_input->'snapshot' OR frozen->>'operationFingerprint' IS DISTINCT FROM p_input->>'operationFingerprint'
  OR frozen->>'identityKey' IS DISTINCT FROM p_input->>'identityKey' OR (p_due ? 'stockWaitRecovery' AND frozen->'binding' IS DISTINCT FROM p_due->'stockWaitRecovery') THEN
  RAISE EXCEPTION 'stock_wait_frozen_binding_changed' USING ERRCODE='23505'; END IF;
 IF g.state='refused' OR g.state='reserved' AND g.lease_expires_at<=p_now THEN RETURN public.subscription_stock_wait_recover_refusal_v2(g.id,g.operation_fingerprint,p_input->>'worker',p_now); END IF;
 result:=public.fulfillment_reserve_successor_renewal_v2(g.id,(p_input->>'claimToken')::uuid,900,p_now);
 IF (result->>'reserved')::boolean THEN RETURN result||jsonb_build_object('waiting',false); END IF;
 SELECT * INTO p FROM public.subscription_successor_proposals WHERE id=g.proposal_id;
 INSERT INTO public.subscription_successor_wait_cases_v2(id,root_case_id,operation_id,subscription_id,client_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 VALUES(gen_random_uuid(),p.original_case_id,g.id,g.subscription_id,p.client_id,g.scheduled_at,g.cycle_number,'waiting',p_due,g.cycle_snapshot,g.operation_fingerprint,g.identity_key,result->'deficits',p_now,p_now)
 ON CONFLICT(operation_id) DO UPDATE SET last_checked_at=p_now RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_record_opened_v2(c);
 RETURN result||jsonb_build_object('waiting',true,'caseId',c.id,'caseKind','successor');
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_admit_v2(jsonb,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_recover_refusal_v2(p_operation_id uuid,p_fingerprint text,p_worker text,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_operations_v2; g public.subscription_successor_operations_v2; s public.subscriptions;
 c public.subscription_successor_wait_cases_v2; r public.subscription_successor_reservations_v2; result jsonb;
 token uuid:=gen_random_uuid(); item jsonb; stock public.fulfillment_stock_current; available bigint; own_quantity bigint; v_deficits jsonb:='[]';
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR length(btrim(coalesce(p_worker,''))) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(846832106,1) THEN RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id;
 SELECT * INTO s FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.clients WHERE id=s.client_id FOR KEY SHARE NOWAIT;
 BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_stock_wait_cases WHERE id=(SELECT original_case_id FROM public.subscription_successor_proposals WHERE id=g.proposal_id) FOR UPDATE NOWAIT;
 SELECT * INTO c FROM public.subscription_successor_wait_cases_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 IF g.id IS NULL OR g.operation_fingerprint IS DISTINCT FROM p_fingerprint OR g.superseded_by_proposal_id IS NOT NULL OR s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM g.scheduled_at
  OR c.id IS NULL OR c.state NOT IN ('waiting','stock_secured') OR c.cycle_snapshot IS DISTINCT FROM g.cycle_snapshot OR c.fingerprint IS DISTINCT FROM g.operation_fingerprint
  OR c.identity_key IS DISTINCT FROM g.identity_key OR c.superseded_by_proposal_id IS NOT NULL THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF c.state='stock_secured' AND g.state='reserved' AND r.status='held' AND r.expires_at>p_now AND g.lease_expires_at>p_now THEN RETURN public.subscription_read_successor_renewal_v2(g.identity_key)||jsonb_build_object('waiting',false,'replayed',true,'caseId',c.id); END IF;
 IF public.subscription_stock_wait_frozen_v2(g.id) IS NULL OR g.lease_expires_at>p_now OR NOT coalesce(g.state='refused' AND g.terminal_reason IN ('inventory_unavailable','reservation_expired') OR g.state='reserved' AND c.state='stock_secured',false)
  OR r.id IS NOT NULL AND (r.operation_fingerprint IS DISTINCT FROM g.operation_fingerprint OR r.lines IS DISTINCT FROM g.cycle_snapshot->'lines' OR r.source_key IS DISTINCT FROM g.cycle_snapshot->>'stockSourceKey'
   OR r.status NOT IN ('released','expired') AND NOT (r.status='held' AND c.state='stock_secured')) THEN RAISE EXCEPTION 'stock_wait_recovery_provider_owned_or_not_eligible' USING ERRCODE='22023'; END IF;
 PERFORM k.sku FROM public.fulfillment_stock_current k JOIN jsonb_array_elements(g.cycle_snapshot->'lines') l ON l->>'sku'=k.sku
  WHERE k.source_key=g.cycle_snapshot->>'stockSourceKey' ORDER BY k.source_key,k.sku FOR UPDATE OF k NOWAIT;
 FOR item IN SELECT value FROM jsonb_array_elements(g.cycle_snapshot->'lines') ORDER BY value->>'sku' LOOP
  SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=g.cycle_snapshot->>'stockSourceKey' AND sku=item->>'sku';
  IF stock.sku IS NULL THEN RAISE EXCEPTION 'stock_wait_stock_missing' USING ERRCODE='22023'; END IF;
  IF stock.stale_after<=p_now THEN RAISE EXCEPTION 'stock_wait_stock_stale' USING ERRCODE='22023'; END IF;
  own_quantity:=CASE WHEN r.status='committed' OR r.status='held' AND r.expires_at>p_now THEN (item->>'quantity')::bigint ELSE 0 END;
  available:=CASE WHEN stock.inventory_class='sellable' THEN (public.inventory_available_to_promise(stock.source_key,stock.sku,p_now,true)->>'available_quantity')::bigint ELSE 0 END;
  IF own_quantity+available<(item->>'quantity')::bigint THEN v_deficits:=v_deficits||jsonb_build_array(jsonb_build_object('sku',stock.sku,'requiredUnits',(item->>'quantity')::integer,'reservedUnits',own_quantity,'availableUnits',available,'missingUnits',(item->>'quantity')::bigint-own_quantity-available)); END IF;
 END LOOP;
 UPDATE public.subscription_successor_wait_cases_v2 SET deficits=v_deficits,last_checked_at=p_now WHERE id=c.id RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_record_opened_v2(c);
 IF jsonb_array_length(v_deficits)>0 THEN RETURN jsonb_build_object('schemaVersion',2,'caseKind','successor','caseId',c.id,'waiting',true,'deficits',v_deficits); END IF;
 UPDATE public.subscription_successor_operations_v2 SET state='claimed',terminal_outcome=NULL,terminal_reason=NULL,terminal_at=NULL,
  claim_token=token,claim_generation=claim_generation+1,claimed_by=p_worker,claimed_at=p_now,lease_expires_at=p_now+interval '5 minutes',updated_at=p_now WHERE id=g.id;
 IF r.id IS NULL THEN
  result:=public.fulfillment_reserve_successor_renewal_v2(g.id,token,900,p_now);
  IF NOT (result->>'reserved')::boolean THEN RAISE EXCEPTION 'stock_wait_atomic_shortage' USING ERRCODE='23514'; END IF;
 ELSE
  UPDATE public.subscription_successor_reservations_v2 SET status='held',expires_at=p_now+interval '15 minutes',terminal_reason=NULL,updated_at=p_now WHERE id=r.id;
  UPDATE public.subscription_successor_operations_v2 SET state='reserved' WHERE id=g.id;
 END IF;
 UPDATE public.subscription_successor_wait_cases_v2 SET state='stock_secured',deficits='[]',block_reason=NULL,stock_secured_at=coalesce(stock_secured_at,p_now),last_checked_at=p_now WHERE id=c.id;
 RETURN public.subscription_read_successor_renewal_v2(g.identity_key)||jsonb_build_object('waiting',false,'caseId',c.id,'replayed',false);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM IN ('inventory_admission_busy','lc10_root_operation_busy') THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_recover_refusal_v2(uuid,text,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.subscription_successor_notice_v2(p_case_id uuid,p_case_kind text,p_withdrawal_publication_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions; root public.subscription_renewal_operations; g public.subscription_successor_operations_v2;
 c public.subscription_stock_wait_cases; c2 public.subscription_successor_wait_cases_v2; sub uuid; root_id uuid; snapshot jsonb; operation uuid;
 case_state text; anchor timestamptz; fingerprint text; sku public.catalog_skus; line jsonb; episode uuid; previous_revision integer;
 key text; notice_id uuid; payload jsonb; stored jsonb; notices jsonb:='[]'; product uuid; position integer; notice jsonb; handed_off jsonb:='[]';
BEGIN
 IF p_case_kind='legacy' THEN SELECT subscription_id,renewal_operation_id INTO sub,root_id FROM public.subscription_stock_wait_cases WHERE id=p_case_id;
 ELSIF p_case_kind='successor' THEN SELECT w.subscription_id,op.root_operation_id INTO sub,root_id FROM public.subscription_successor_wait_cases_v2 w JOIN public.subscription_successor_operations_v2 op ON op.id=w.operation_id WHERE w.id=p_case_id;
 ELSE RAISE EXCEPTION 'stock_wait_case_kind_invalid' USING ERRCODE='22023'; END IF;
 IF sub IS NULL OR root_id IS NULL THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=sub FOR UPDATE NOWAIT;
 BEGIN SELECT * INTO root FROM public.subscription_renewal_operations WHERE id=root_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 IF p_case_kind='legacy' THEN
  SELECT * INTO c FROM public.subscription_stock_wait_cases WHERE id=p_case_id FOR UPDATE NOWAIT;
  IF c.subscription_id IS DISTINCT FROM s.id OR c.client_id IS DISTINCT FROM s.client_id OR c.renewal_operation_id IS DISTINCT FROM root.id
   OR c.fingerprint IS DISTINCT FROM root.operation_fingerprint OR c.cycle_snapshot IS DISTINCT FROM root.cycle_snapshot OR c.identity_key IS DISTINCT FROM root.identity_key THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
  snapshot:=c.cycle_snapshot; operation:=root.id; case_state:=c.state; anchor:=c.scheduled_at; fingerprint:=c.fingerprint;
 ELSE
  SELECT op.* INTO g FROM public.subscription_successor_operations_v2 op JOIN public.subscription_successor_wait_cases_v2 w ON w.operation_id=op.id WHERE w.id=p_case_id FOR UPDATE OF op NOWAIT;
  SELECT * INTO c2 FROM public.subscription_successor_wait_cases_v2 WHERE id=p_case_id FOR UPDATE NOWAIT;
  IF c2.subscription_id IS DISTINCT FROM s.id OR c2.client_id IS DISTINCT FROM s.client_id OR g.root_operation_id IS DISTINCT FROM root.id
   OR c2.fingerprint IS DISTINCT FROM g.operation_fingerprint OR c2.cycle_snapshot IS DISTINCT FROM g.cycle_snapshot OR c2.identity_key IS DISTINCT FROM g.identity_key THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
  IF g.superseded_by_proposal_id IS NOT NULL OR c2.superseded_by_proposal_id IS NOT NULL THEN RETURN jsonb_build_object('outcome','obsolete','reason','superseded'); END IF;
  snapshot:=c2.cycle_snapshot; operation:=g.id; case_state:=c2.state; anchor:=c2.scheduled_at; fingerprint:=c2.fingerprint;
 END IF;
 IF s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM anchor OR case_state NOT IN ('waiting','stock_secured') THEN RETURN jsonb_build_object('outcome','obsolete','reason','wait_not_current'); END IF;
 IF jsonb_typeof(snapshot->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(snapshot->'lines')=0 THEN RAISE EXCEPTION 'catalog_obligation_evidence_unknown' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 FOR product IN SELECT DISTINCT k.product_id FROM public.catalog_skus k JOIN jsonb_array_elements(snapshot->'lines') l ON k.sku=l->>'sku' ORDER BY k.product_id LOOP
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-lineage:'||product::text,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 END LOOP;
 PERFORM h.product_id FROM public.catalog_publication_heads h WHERE h.product_id IN (SELECT k.product_id FROM public.catalog_skus k JOIN jsonb_array_elements(snapshot->'lines') l ON k.sku=l->>'sku') ORDER BY h.product_id FOR SHARE NOWAIT;
 FOR line IN SELECT value FROM jsonb_array_elements(snapshot->'lines') ORDER BY value->>'sku' LOOP
  SELECT k.* INTO sku FROM public.catalog_skus k WHERE k.sku=line->>'sku';
  IF sku.id IS NULL OR sku.publication_facts->>'code' IS DISTINCT FROM sku.sku OR sku.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN RAISE EXCEPTION 'catalog_obligation_evidence_unknown' USING ERRCODE='55000'; END IF;
  IF sku.publication_facts->>'lifecycleState'<>'withdrawn' THEN CONTINUE; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.catalog_publication_heads WHERE product_id=sku.product_id) OR EXISTS(
   SELECT 1 FROM public.catalog_publications p CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
   LEFT JOIN public.catalog_sku_revisions r ON r.id=(ref->>'revisionId')::uuid AND r.sku_id=sku.id
   WHERE p.product_id=sku.product_id AND ref->>'skuId'=sku.id::text AND r.id IS NULL) THEN RAISE EXCEPTION 'catalog_obligation_evidence_unknown' USING ERRCODE='55000'; END IF;
  SELECT max(p.revision) INTO previous_revision FROM public.catalog_publications p CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
   JOIN public.catalog_sku_revisions r ON r.id=(ref->>'revisionId')::uuid AND r.sku_id=sku.id
   WHERE p.product_id=sku.product_id AND ref->>'skuId'=sku.id::text AND r.full_facts::jsonb->>'lifecycleState'<>'withdrawn';
  SELECT p.id INTO episode FROM public.catalog_publications p CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
   JOIN public.catalog_sku_revisions r ON r.id=(ref->>'revisionId')::uuid AND r.sku_id=sku.id
   WHERE p.product_id=sku.product_id AND ref->>'skuId'=sku.id::text AND p.revision>coalesce(previous_revision,0) AND r.full_facts::jsonb->>'lifecycleState'='withdrawn' ORDER BY p.revision LIMIT 1;
  IF episode IS NULL THEN RAISE EXCEPTION 'catalog_obligation_evidence_unknown' USING ERRCODE='55000'; END IF;
  IF p_withdrawal_publication_id IS NOT NULL AND p_withdrawal_publication_id<>episode THEN CONTINUE; END IF;
  key:='subscription-predecessor-withdrawn:'||episode::text||':'||p_case_id::text;
  SELECT n::integer-1 INTO position FROM jsonb_array_elements(notices) WITH ORDINALITY x(v,n) WHERE v->>'messageKey'=key;
  IF FOUND THEN
   notices:=jsonb_set(notices,ARRAY[position::text,'payload','predecessors'],(notices#>ARRAY[position::text,'payload','predecessors'])||jsonb_build_array(jsonb_build_object('skuId',sku.id,'skuCode',sku.sku)));
  ELSE
   payload:=jsonb_build_object('schemaVersion',2,'reason','predecessor_withdrawn','caseKind',p_case_kind,'caseId',p_case_id,'operationId',operation,
    'subscriptionId',s.id,'clientId',s.client_id,'withdrawalPublicationId',episode,'frozenFingerprint',fingerprint,'scheduledAt',anchor,'messageKey',key,
    'predecessors',jsonb_build_array(jsonb_build_object('skuId',sku.id,'skuCode',sku.sku)));
   notices:=notices||jsonb_build_array(jsonb_build_object('messageKey',key,'payload',payload));
  END IF;
 END LOOP;
 IF jsonb_array_length(notices)=0 THEN RETURN jsonb_build_object('outcome','obsolete','reason','no_current_withdrawal'); END IF;
 FOR notice IN SELECT value FROM jsonb_array_elements(notices) ORDER BY value->>'messageKey' LOOP
  key:=notice->>'messageKey'; payload:=notice->'payload';
  PERFORM 1 FROM public.outbox_events WHERE event_type='subscription.predecessor_withdrawn.v2' AND idempotency_key=key FOR UPDATE NOWAIT;
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
   VALUES('subscription',s.id,'subscription.predecessor_withdrawn.v2',key,payload,jsonb_build_object('source','subscription_successor'))
   ON CONFLICT(event_type,idempotency_key) DO NOTHING;
  SELECT id,outbox_events.payload INTO notice_id,stored FROM public.outbox_events WHERE event_type='subscription.predecessor_withdrawn.v2' AND idempotency_key=key;
  IF notice_id IS NULL OR stored IS DISTINCT FROM payload THEN RAISE EXCEPTION 'subscription_lifecycle_message_identity_mismatch' USING ERRCODE='23505'; END IF;
  handed_off:=handed_off||jsonb_build_array(jsonb_build_object('noticeId',notice_id,'messageKey',key,'payload',payload));
 END LOOP;
 RETURN jsonb_build_object('outcome','handed_off','notices',handed_off);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_successor_notice_v2(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION public.commerce_settle_successor_renewal_v2(p_operation_id uuid,p_event_key text,p_payment_evidence jsonb,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_operations_v2; g public.subscription_successor_operations_v2; event jsonb; answer jsonb;
 outcome text; external_ref text; reason text; settled jsonb;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR length(btrim(coalesce(p_event_key,'')))<8 OR jsonb_typeof(p_payment_evidence) IS DISTINCT FROM 'object'
  OR p_payment_evidence->>'outcome' NOT IN ('succeeded','refused') OR p_payment_evidence->>'outcome' IS NULL THEN
  RAISE EXCEPTION 'commerce_renewal_outcome_invalid_input' USING ERRCODE='22023'; END IF;
 outcome:=p_payment_evidence->>'outcome'; external_ref:=p_payment_evidence->>'externalRef'; reason:=p_payment_evidence->>'reason';
 SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
 BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=p_operation_id FOR UPDATE NOWAIT;
 IF p_payment_evidence->>'operationFingerprint' IS DISTINCT FROM g.operation_fingerprint THEN RAISE EXCEPTION 'commerce_renewal_outcome_fingerprint_conflict' USING ERRCODE='23505'; END IF;
 SELECT value INTO event FROM jsonb_array_elements(g.outcomes) WHERE value->>'eventKey'=p_event_key;
 IF FOUND THEN
  IF event->>'outcome' IS DISTINCT FROM outcome OR event->>'externalRef' IS DISTINCT FROM external_ref OR event->>'reason' IS DISTINCT FROM reason
   OR event->>'operationFingerprint' IS DISTINCT FROM g.operation_fingerprint THEN RAISE EXCEPTION 'commerce_renewal_outcome_idempotency_conflict' USING ERRCODE='23505'; END IF;
  IF jsonb_typeof(event->'result') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'commerce_renewal_outcome_attempt_not_prepared' USING ERRCODE='22023'; END IF;
  RETURN event->'result';
 END IF;
 IF g.state<>'attempt_prepared' OR g.superseded_by_proposal_id IS NOT NULL OR g.cycle_id IS NULL OR g.order_id IS NULL OR g.settlement_intent_id IS NULL THEN RAISE EXCEPTION 'commerce_renewal_outcome_attempt_not_prepared' USING ERRCODE='22023'; END IF;
 IF length(btrim(coalesce(external_ref,''))) NOT BETWEEN 1 AND 240 OR g.external_attempt_ref IS NOT NULL AND g.external_attempt_ref IS DISTINCT FROM external_ref THEN
  RAISE EXCEPTION 'commerce_renewal_external_attempt_ref_immutable' USING ERRCODE='22023'; END IF;
 -- These are the actual native aggregate targets. Every callee acquisition below is preheld.
 PERFORM 1 FROM public.subscription_cycles WHERE id=g.cycle_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=g.subscription_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.commerce_orders WHERE id=g.order_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.commerce_settlement_intents WHERE id=g.settlement_intent_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_successor_wait_cases_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM public.subscription_successor_proposals p WHERE p.id=g.proposal_id AND p.state='accepted' AND p.consent IS NOT NULL AND p.accepted_receipt IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   JOIN public.commerce_settlement_intents i ON i.order_id=o.id WHERE o.id=g.order_id AND c.id=g.cycle_id AND c.subscription_id=g.subscription_id AND c.scheduled_at=g.scheduled_at
    AND i.id=g.settlement_intent_id AND o.renewal_operation_id IS NULL AND c.renewal_operation_id IS NULL AND i.renewal_operation_id IS NULL)
  OR NOT EXISTS(SELECT 1 FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id AND status='committed') THEN RAISE EXCEPTION 'successor_native_graph_mismatch' USING ERRCODE='23514'; END IF;
 UPDATE public.subscription_successor_operations_v2 SET external_attempt_ref=external_ref,external_attempt_acknowledged_at=coalesce(external_attempt_acknowledged_at,p_now),updated_at=p_now WHERE id=g.id;
 settled:=public.commerce_record_settlement(p_event_key||':settlement',g.settlement_intent_id,CASE outcome WHEN 'succeeded' THEN 'succeeded' ELSE 'failed' END,
  external_ref,jsonb_build_object('reason',coalesce(nullif(btrim(coalesce(reason,'')),''),CASE WHEN outcome='refused' THEN 'declined' END),'successorOperationId',g.id,'renewalOperationFingerprint',g.operation_fingerprint),p_now);
 IF outcome='succeeded' THEN
  UPDATE public.subscription_successor_reservations_v2 SET status='consumed',updated_at=p_now WHERE operation_id=g.id AND status='committed';
  UPDATE public.subscription_renewal_terms SET next_cycle_number=greatest(next_cycle_number,g.cycle_number+1),updated_at=p_now WHERE subscription_id=g.subscription_id;
 ELSE UPDATE public.subscription_successor_reservations_v2 SET status='released',terminal_reason=coalesce(nullif(btrim(coalesce(reason,'')),''),'settlement_refused'),updated_at=p_now WHERE operation_id=g.id AND status='committed'; END IF;
 UPDATE public.subscription_successor_operations_v2 SET state=outcome,terminal_outcome=outcome,terminal_reason=CASE WHEN outcome='refused' THEN coalesce(nullif(btrim(coalesce(reason,'')),''),'settlement_refused') END,terminal_at=p_now,updated_at=p_now WHERE id=g.id;
 answer:=public.subscription_read_successor_renewal_v2(g.identity_key)||jsonb_build_object('settlement',settled);
 UPDATE public.subscription_successor_operations_v2 SET outcomes=outcomes||jsonb_build_array(jsonb_build_object('eventKey',p_event_key,'operationFingerprint',g.operation_fingerprint,'outcome',outcome,'reason',reason,'externalRef',external_ref,'occurredAt',p_now,'result',answer)) WHERE id=g.id;
 RETURN answer;
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.commerce_settle_successor_renewal_v2(uuid,text,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_mark_resumed_v2(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_operations_v2; g public.subscription_successor_operations_v2;
 c public.subscription_successor_wait_cases_v2; shipment public.fulfillment_shipments;
BEGIN
 SELECT * INTO hint FROM public.subscription_successor_operations_v2 WHERE order_id=p_order_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE NOWAIT;
 BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=hint.root_operation_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
 SELECT * INTO g FROM public.subscription_successor_operations_v2 WHERE id=hint.id FOR UPDATE NOWAIT;
 SELECT * INTO c FROM public.subscription_successor_wait_cases_v2 WHERE operation_id=g.id FOR UPDATE NOWAIT;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.subscription_cycles WHERE id=g.cycle_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE NOWAIT;
 SELECT * INTO shipment FROM public.fulfillment_shipments WHERE order_id=p_order_id AND replaces_shipment_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE NOWAIT;
 IF c.state='closed' OR g.superseded_by_proposal_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=p_order_id AND status='pending_payment') THEN RETURN NULL; END IF;
 IF g.state<>'succeeded' OR NOT EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=p_order_id AND status IN ('paid','fulfillment_pending','fulfilled'))
  OR NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=g.settlement_intent_id AND order_id=p_order_id AND status='settled')
  OR NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=g.cycle_id AND status='paid')
  OR NOT EXISTS(SELECT 1 FROM public.subscription_successor_reservations_v2 WHERE operation_id=g.id AND status='consumed')
  OR shipment.id IS NULL OR shipment.status IN ('cancelled','exception') OR EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=p_order_id AND status='active') THEN
  RAISE EXCEPTION 'stock_wait_realization_admission_missing' USING ERRCODE='22023'; END IF;
 IF c.state='resumed' THEN
  IF c.fulfillment_id IS DISTINCT FROM shipment.id OR g.fulfillment_id IS DISTINCT FROM shipment.id THEN RAISE EXCEPTION 'stock_wait_fulfillment_replay_mismatch'; END IF;
  RETURN public.subscription_stock_wait_projection_v2(c);
 END IF;
 IF c.state<>'stock_secured' THEN RAISE EXCEPTION 'stock_wait_stock_not_secured'; END IF;
 UPDATE public.subscription_successor_operations_v2 SET fulfillment_id=shipment.id WHERE id=g.id;
 UPDATE public.subscription_successor_wait_cases_v2 SET state='resumed',resumed_at=now(),cycle_id=g.cycle_id,order_id=p_order_id,fulfillment_id=shipment.id WHERE id=c.id RETURNING * INTO c;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('subscription_stock_wait',c.id,'subscription_stock_wait.resumed.v2','subscription_stock_wait:'||c.id::text||':resumed:v2',
  jsonb_build_object('schemaVersion',2,'caseKind','successor','caseId',c.id,'operationId',g.id,'clientId',c.client_id,'subscriptionId',c.subscription_id,'scheduledAt',c.scheduled_at,'deficits',c.deficits,'orderId',p_order_id),jsonb_build_object('source','subscription_stock_wait'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
 RETURN public.subscription_stock_wait_projection_v2(c);
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_mark_resumed_v2(uuid) FROM PUBLIC;

CREATE FUNCTION public.subscription_stock_wait_candidates_v2(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected record; answer jsonb:='[]'; frozen jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 FOR selected IN SELECT * FROM (
  SELECT 'legacy'::text kind,op.id,op.subscription_id,op.id root_id,op.scheduled_at,c.id case_id,
   CASE WHEN c.id IS NULL THEN op.updated_at ELSE c.last_selected_at END last_selected
  FROM public.subscription_renewal_operations op JOIN public.subscriptions s ON s.id=op.subscription_id
  LEFT JOIN public.subscription_stock_wait_cases c ON c.renewal_operation_id=op.id
  WHERE s.status='active' AND s.next_cycle_at=op.scheduled_at AND op.lease_expires_at<=p_now
   AND (op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired') OR op.state='reserved' AND c.state='stock_secured')
   AND (c.id IS NULL OR c.state IN ('waiting','stock_secured')) AND public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at) IS NOT NULL
  UNION ALL
  SELECT 'successor',g.id,g.subscription_id,g.root_operation_id,g.scheduled_at,c.id,c.last_selected_at
  FROM public.subscription_successor_operations_v2 g JOIN public.subscriptions s ON s.id=g.subscription_id
  JOIN public.subscription_successor_wait_cases_v2 c ON c.operation_id=g.id
  WHERE s.status='active' AND s.next_cycle_at=g.scheduled_at AND g.lease_expires_at<=p_now AND g.superseded_by_proposal_id IS NULL
   AND (g.state='refused' AND g.terminal_reason IN ('inventory_unavailable','reservation_expired') OR g.state='reserved' AND c.state='stock_secured')
   AND c.state IN ('waiting','stock_secured') AND public.subscription_stock_wait_frozen_v2(g.id) IS NOT NULL
 ) candidates ORDER BY last_selected NULLS FIRST,scheduled_at,id LIMIT p_limit LOOP
  IF selected.kind='legacy' THEN
   IF selected.case_id IS NOT NULL THEN
    PERFORM 1 FROM public.subscription_stock_wait_cases WHERE id=selected.case_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
   END IF;
   PERFORM 1 FROM public.subscription_renewal_operations WHERE id=selected.id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   frozen:=public.subscription_stock_wait_frozen(selected.subscription_id,selected.scheduled_at);
   IF frozen IS NULL THEN CONTINUE; END IF;
   IF selected.case_id IS NOT NULL THEN UPDATE public.subscription_stock_wait_cases SET last_selected_at=p_now WHERE id=selected.case_id;
   ELSE UPDATE public.subscription_renewal_operations SET updated_at=p_now WHERE id=selected.id; END IF;
   answer:=answer||jsonb_build_array(jsonb_build_object('schemaVersion',2,'caseKind','legacy','operationKind','legacy','frozen',frozen));
  ELSE
   PERFORM 1 FROM public.subscriptions WHERE id=selected.subscription_id FOR UPDATE NOWAIT;
   BEGIN PERFORM 1 FROM public.subscription_renewal_operations WHERE id=selected.root_id FOR UPDATE NOWAIT;
   EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_root_operation_busy' USING ERRCODE='55P03'; END;
   PERFORM 1 FROM public.subscription_successor_operations_v2 WHERE id=selected.id FOR UPDATE NOWAIT;
   PERFORM 1 FROM public.subscription_successor_wait_cases_v2 WHERE id=selected.case_id FOR UPDATE NOWAIT;
   frozen:=public.subscription_stock_wait_frozen_v2(selected.id);
   IF frozen IS NULL THEN CONTINUE; END IF;
   UPDATE public.subscription_successor_wait_cases_v2 SET last_selected_at=p_now WHERE id=selected.case_id;
   answer:=answer||jsonb_build_array(frozen);
  END IF;
 END LOOP;
 RETURN answer;
EXCEPTION WHEN lock_not_available THEN
 IF SQLERRM='lc10_root_operation_busy' THEN RAISE; END IF;
 RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_candidates_v2(integer,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.subscription_successor_proposal_decide_v2(p_proposal_id uuid,p_client_id uuid,p_decision text,p_command_key text,p_quote_hash text,p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint public.subscription_successor_proposals; proposal public.subscription_successor_proposals; s public.subscriptions;
 q public.subscription_quote_previews; r public.subscription_command_receipts; actor uuid; key text; command jsonb; fingerprint text;
 answer jsonb; result jsonb; payload jsonb; admission jsonb; product uuid; price_context jsonb;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) OR p_decision IS NULL OR p_decision NOT IN ('accepted','declined','expired') OR p_command_key IS NULL OR p_command_key<>btrim(p_command_key) OR length(p_command_key) NOT BETWEEN 8 AND 180 THEN RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO hint FROM public.subscription_successor_proposals WHERE id=p_proposal_id AND client_id=p_client_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF p_decision='accepted' AND hint.source_binding->>'kind'='stock_wait' THEN RETURN public.resolve_stock_wait_with_successor((hint.source_binding->>'caseId')::uuid,p_proposal_id,p_quote_hash,p_command_key,p_client_id,p_now); END IF;
 actor:=(hint.preview->>'actor_id')::uuid;
 IF actor IS NULL THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',hint.subscription_id,'action','successor_proposal_decide','payload',jsonb_build_object('proposalId',p_proposal_id,'decision',p_decision,'quoteHash',p_quote_hash));
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text||':'||p_command_key,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=actor AND idempotency_key=p_command_key;
 IF FOUND THEN
  IF r.command IS DISTINCT FROM command OR r.command_fingerprint IS DISTINCT FROM fingerprint OR r.quote_hash IS DISTINCT FROM p_quote_hash OR r.status<>'applied' THEN RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 key:='successor-edit:'||encode(sha256(convert_to(actor::text||':'||p_command_key,'UTF8')),'hex');
 IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text||':'||key,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=hint.subscription_id AND client_id=p_client_id FOR UPDATE NOWAIT;
 SELECT * INTO proposal FROM public.subscription_successor_proposals WHERE id=hint.id FOR UPDATE NOWAIT;
 IF s.id IS NULL OR proposal.state<>'offered' THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 IF p_decision='expired' AND proposal.expires_at>p_now THEN RAISE EXCEPTION 'successor_proposal_not_expired' USING ERRCODE='22023'; END IF;
 IF p_decision='accepted' THEN
  IF proposal.quote_hash IS DISTINCT FROM p_quote_hash OR proposal.expires_at<=p_now OR proposal.template_version<>s.template_version THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
  SELECT * INTO q FROM public.subscription_quote_previews WHERE id=(proposal.preview->>'id')::uuid FOR UPDATE NOWAIT;
  IF q.actor_id IS DISTINCT FROM actor OR q.client_id IS DISTINCT FROM p_client_id OR q.status<>'previewed' OR to_jsonb(q) IS DISTINCT FROM proposal.preview THEN RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.subscription_command_receipts WHERE actor_id=actor AND idempotency_key=key FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id AND scheduled_at=s.next_cycle_at ORDER BY id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.subscription_cycles WHERE subscription_id=s.id AND scheduled_at=s.next_cycle_at ORDER BY id FOR UPDATE NOWAIT;
  PERFORM o.id FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id WHERE c.subscription_id=s.id AND c.scheduled_at=s.next_cycle_at ORDER BY o.id FOR UPDATE OF o NOWAIT;
  PERFORM i.id FROM public.commerce_settlement_intents i JOIN public.commerce_orders o ON o.id=i.order_id JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id WHERE c.subscription_id=s.id AND c.scheduled_at=s.next_cycle_at ORDER BY i.id FOR UPDATE OF i NOWAIT;
  payload:=jsonb_set(jsonb_set(proposal.request->'applyPayload','{acceptedQuoteHash}',to_jsonb(q.quote_hash)),'{request,acceptedQuoteHash}',to_jsonb(q.quote_hash));
  admission:=payload->'catalogAdmission';
  IF admission IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
  FOR product IN SELECT DISTINCT k.product_id FROM public.catalog_skus k JOIN jsonb_array_elements(admission->'skuRevisions') l ON k.id=(l#>>'{reference,skuId}')::uuid ORDER BY k.product_id LOOP
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-lineage:'||product::text,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
  END LOOP;
  PERFORM h.product_id FROM public.catalog_publication_heads h WHERE h.product_id IN (SELECT k.product_id FROM public.catalog_skus k JOIN jsonb_array_elements(admission->'skuRevisions') l ON k.id=(l#>>'{reference,skuId}')::uuid) ORDER BY h.product_id FOR SHARE NOWAIT;
  PERFORM k.id FROM public.catalog_products k WHERE k.id IN (SELECT v.product_id FROM public.catalog_skus v JOIN jsonb_array_elements(admission->'skuRevisions') l ON v.id=(l#>>'{reference,skuId}')::uuid) ORDER BY k.id FOR SHARE NOWAIT;
  PERFORM k.id FROM public.catalog_skus k JOIN jsonb_array_elements(admission->'skuRevisions') l ON k.id=(l#>>'{reference,skuId}')::uuid ORDER BY k.id FOR SHARE OF k NOWAIT;
  FOR price_context IN SELECT value FROM jsonb_array_elements(admission->'priceContextVersions') ORDER BY (value->>'priceListId')::uuid,(value->>'skuId')::uuid LOOP
   IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('catalog-price-setup:'||((price_context->>'priceListId')::uuid)::text||':'||((price_context->>'skuId')::uuid)::text,0)) THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03'; END IF;
  END LOOP;
  PERFORM k.id FROM public.price_lists k WHERE k.id IN (SELECT (value->>'priceListId')::uuid FROM jsonb_array_elements(admission->'priceContextVersions')) ORDER BY k.id FOR SHARE NOWAIT;
  PERFORM k.id FROM public.price_entries k WHERE k.id IN (SELECT (value->>'entryId')::uuid FROM jsonb_array_elements(admission->'priceContextVersions')) ORDER BY k.id FOR SHARE NOWAIT;
  IF proposal.lane='classic' THEN result:=public.subscription_package_edit_apply(actor,p_client_id,key,s.id,payload,p_now);
  ELSIF proposal.lane='exact' THEN result:=public.subscription_line_edit_apply(actor,p_client_id,key,s.id,proposal.action,payload,p_now);
  ELSIF proposal.lane='sized' THEN result:=public.subscription_sized_edit_apply(actor,p_client_id,key,s.id,payload,p_now);
  ELSE RAISE EXCEPTION 'successor_lane_unavailable' USING ERRCODE='55000'; END IF;
  IF result->>'status' NOT IN ('applied','noop','replayed') OR result->>'status' IS NULL THEN RAISE EXCEPTION 'successor_lane_refused' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=proposal.successor_sku_id)
   OR EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=proposal.predecessor_sku_id) THEN RAISE EXCEPTION 'successor_proposal_binding_changed' USING ERRCODE='22023'; END IF;
 END IF;
 answer:=jsonb_build_object('schemaVersion',2,'status','applied','proposalId',proposal.id,'decision',p_decision,'quoteHash',p_quote_hash,'laneReceipt',result);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(actor,p_command_key,s.id,p_client_id,fingerprint,command,p_quote_hash,answer,'applied');
 UPDATE public.subscription_successor_proposals SET state=p_decision,terminal_at=p_now,consent=CASE WHEN p_decision='accepted' THEN q.quote_snapshot->'editConsent' END,accepted_receipt=CASE WHEN p_decision='accepted' THEN answer END WHERE id=proposal.id;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES('subscription',s.id,'subscription.successor.'||p_decision||'.v2','subscription-successor:'||proposal.id::text||':'||p_decision||':v2',answer);
 RETURN answer;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'lc10_commerce_busy' USING ERRCODE='55P03';
END; $$;
REVOKE ALL ON FUNCTION public.subscription_successor_proposal_decide_v2(uuid,uuid,text,text,text,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.subscription_stock_wait_projection_v2(public.subscription_successor_wait_cases_v2) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_successor_operation_snapshot_v2(public.subscription_successor_operations_v2) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_sku_successors, public.subscription_successor_proposals, public.subscription_successor_operations_v2, public.subscription_successor_wait_cases_v2, public.subscription_successor_reservations_v2 FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_sku_successors, public.subscription_successor_proposals, public.subscription_successor_operations_v2, public.subscription_successor_wait_cases_v2, public.subscription_successor_reservations_v2 FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_sku_successors, public.subscription_successor_proposals, public.subscription_successor_operations_v2, public.subscription_successor_wait_cases_v2, public.subscription_successor_reservations_v2 FROM service_role;'; END IF; END; $$;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_successor_proposals', 'block', 'Retained explicit successor consent belongs to its original subscription client.');
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_successor_wait_cases_v2', 'block', 'A successor stock wait is a retained subscription obligation.');
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'GRANT SELECT (client_id) ON TABLE public.subscription_successor_proposals TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'GRANT SELECT (client_id) ON TABLE public.subscription_successor_wait_cases_v2 TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'CREATE POLICY subscription_successor_proposals_absorption_census ON public.subscription_successor_proposals FOR SELECT TO service_role USING (true);';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'CREATE POLICY subscription_successor_wait_cases_v2_absorption_census ON public.subscription_successor_wait_cases_v2 FOR SELECT TO service_role USING (true);';
END IF; END; $$;
