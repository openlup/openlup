-- Paid source enrichment is part of the existing mandatory fact INSERT. Export
-- projection and provider effects never participate in the financial transaction.
CREATE TABLE public.communication_event_bindings (
 binding_key text PRIMARY KEY, binding jsonb NOT NULL, activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX communication_event_single_binding ON public.communication_event_bindings((true));
CREATE TABLE public.communication_event_receipts (
 binding_key text NOT NULL REFERENCES public.communication_event_bindings(binding_key), source_key text NOT NULL,
 client_id uuid REFERENCES public.clients(id), outbox_event_id uuid UNIQUE REFERENCES public.outbox_events(id),
 state text NOT NULL CHECK(state IN ('pending','dispatching','accepted','unknown','refused','erased')),
 reason text, request_digest text, recovery_reference text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(binding_key,source_key)
);
CREATE TABLE public.communication_event_erasures (
 client_id uuid PRIMARY KEY REFERENCES public.clients(id), erased_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.commerce_order_operations ADD COLUMN communication_subject_id uuid;
ALTER TABLE public.subscription_events ADD COLUMN communication_subject_id uuid;
CREATE FUNCTION public.communication_event_capture_subject() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE sealed_owner name;
BEGIN
 SELECT pg_get_userbyid(proowner) INTO sealed_owner FROM pg_proc WHERE oid='public.commerce_order_emit_paid_notification()'::regprocedure;
 IF current_setting('app.communication_retained_copy',true)='on' AND pg_has_role(current_user,sealed_owner,'USAGE') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='subscription_events' THEN
  SELECT client_id INTO NEW.communication_subject_id FROM public.subscriptions WHERE id=NEW.subscription_id;
 ELSE
  SELECT client_id INTO NEW.communication_subject_id FROM public.commerce_orders WHERE id=NEW.order_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER communication_subscription_subject BEFORE INSERT ON public.subscription_events
 FOR EACH ROW EXECUTE FUNCTION public.communication_event_capture_subject();
CREATE TRIGGER communication_refund_subject BEFORE INSERT ON public.commerce_order_operations
 FOR EACH ROW EXECUTE FUNCTION public.communication_event_capture_subject();
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('communication_event_receipts', 'block', 'Frozen provider identity and event deduplication stay with their subject.');
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('communication_event_erasures', 'block', 'An erased subject must not be silently absorbed into another identity.');

CREATE FUNCTION public.communication_paid_fact(p_order public.commerce_orders)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_intent_id uuid; matches integer; snapshot jsonb; kind text; lines jsonb; total numeric; op public.subscription_renewal_operations;
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
CREATE FUNCTION public.communication_event_paid_write(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders;
BEGIN
 IF pg_trigger_depth()=0 THEN RAISE EXCEPTION 'paid_source_trigger_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR purchase.status<>'paid' THEN RAISE EXCEPTION 'paid_source_order_invalid' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.outbox_events WHERE event_type='commerce.order.paid' AND idempotency_key='order_paid:'||p_order_id) THEN RETURN; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',purchase.id,'commerce.order.paid','order_paid:'||purchase.id,
  jsonb_build_object('orderUuid',purchase.id,'occurredAt',purchase.paid_at),
  jsonb_build_object('source','commerce_order_emit_paid_notification','commercePaidFactV1',public.communication_paid_fact(purchase)))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;
CREATE OR REPLACE FUNCTION public.commerce_order_emit_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE previous_timeout text:=current_setting('lock_timeout');
BEGIN
 PERFORM public.communication_event_paid_write(NEW.id);
 BEGIN
  PERFORM set_config('lock_timeout','100ms',true);
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
  VALUES('commerce_order',NEW.id,'commerce.order.paid.email','order_paid_email:'||NEW.id,
   jsonb_build_object('orderUuid',NEW.id,'orderId','order_'||NEW.id,'mode',CASE WHEN NEW.subscription_cycle_id IS NOT NULL THEN 'subscription_cycle'
    ELSE coalesce(NEW.metadata#>>'{orderDraftSnapshot,context,mode}','one_time') END,'occurredAt',NEW.paid_at),
   jsonb_build_object('source','commerce_order_emit_paid_notification')) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
  PERFORM set_config('lock_timeout',previous_timeout,true);
 EXCEPTION WHEN OTHERS OR query_canceled THEN PERFORM set_config('lock_timeout',previous_timeout,true); END;
 RETURN NULL;
END; $$;

-- Existing status source retains its timestamp even after ordinary payload compaction.
CREATE FUNCTION public.communication_event_refund_write(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE purchase public.commerce_orders;
BEGIN
 IF pg_trigger_depth()=0 THEN RAISE EXCEPTION 'refund_source_trigger_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR purchase.status<>'refunded' THEN RAISE EXCEPTION 'refund_source_order_invalid' USING ERRCODE='22023'; END IF;

 IF purchase.metadata->>'source'='admin_manual_refund' THEN RETURN; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',purchase.id,'commerce.order.refunded','order_refunded:'||purchase.id,
  jsonb_build_object('orderUuid',purchase.id,'occurredAt',purchase.refunded_at),jsonb_build_object('source','commerce_order_emit_refunded_notification',
   'refundStatusFactV1',jsonb_build_object('clientId',purchase.client_id,'occurredAt',purchase.refunded_at))) ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;
CREATE OR REPLACE FUNCTION public.commerce_order_emit_refunded_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
 PERFORM public.communication_event_refund_write(NEW.id);
 RETURN NULL;
END; $$;

CREATE FUNCTION public.communication_checkout_qualify(p_limit integer,p_policy jsonb,p_now timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy jsonb:=public.commerce_checkout_recovery_policy(p_policy); inserted integer;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'event_time_invalid' USING ERRCODE='22023'; END IF;
 WITH candidates AS MATERIALIZED (
 SELECT o.* FROM public.commerce_orders o WHERE o.status='pending_payment' AND o.client_id IS NOT NULL AND o.subscription_cycle_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional')
  AND o.created_at<p_now-make_interval(secs=>(policy->>'firstOffsetSeconds')::integer)
  AND o.created_at>p_now-make_interval(secs=>(policy->>'checkoutSeconds')::integer)
  AND NOT public.commerce_checkout_recovery_payment_blocked(o.id,(policy->>'activitySeconds')::integer,p_now)
  ORDER BY o.created_at,o.id LIMIT least(greatest(coalesce(p_limit,100),1),1000) FOR UPDATE SKIP LOCKED
 ), inserted AS (
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata,status,processed_at)
 SELECT 'commerce_order',c.id,'commerce.checkout.recovery_qualified.v1','checkout_qualified:'||c.id,'{}'::jsonb,
  jsonb_build_object('checkoutQualificationV1',jsonb_build_object('schemaVersion',1,'sourceId','checkout:'||c.id,
   'sourceType','checkout.recovery_qualified','occurredAt',to_char(p_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'subject',jsonb_build_object('clientId',c.client_id),'data',jsonb_build_object('orderId',c.id,
    'expiresAt',to_char((c.created_at+make_interval(secs=>(policy->>'checkoutSeconds')::integer)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
   'qualificationPolicy',policy),'processed',p_now FROM candidates c ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING 1)
 SELECT count(*)::integer INTO inserted FROM inserted;
 RETURN inserted;
END; $$;

CREATE VIEW public.communication_event_sources AS
 SELECT 'paid:'||e.aggregate_id AS source_key,e.aggregate_id AS aggregate_id,
  coalesce((e.metadata#>>'{commercePaidFactV1,event,subject,clientId}')::uuid,o.client_id) AS client_id,
  CASE WHEN e.metadata#>>'{commercePaidFactV1,state}'='complete' THEN e.metadata#>'{commercePaidFactV1,event}' ELSE NULL END AS event,
  CASE WHEN e.metadata#>>'{commercePaidFactV1,state}'='complete' THEN NULL ELSE coalesce(e.metadata#>>'{commercePaidFactV1,reason}','source_snapshot_missing') END AS reason
 FROM public.outbox_events e JOIN public.commerce_orders o ON o.id=e.aggregate_id WHERE e.event_type='commerce.order.paid'
 UNION ALL
 (SELECT DISTINCT ON (source.order_id) 'refund-status:'||source.order_id,source.order_id,source.client_id,
  jsonb_build_object('schemaVersion',1,'sourceId','refund-status:'||source.order_id,'sourceType','order.refund_status_changed',
   'occurredAt',to_char(source.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'subject',jsonb_build_object('clientId',source.client_id),'data',jsonb_build_object('orderId',source.order_id,'status','refunded')),NULL
 FROM (SELECT op.order_id,op.communication_subject_id AS client_id,op.occurred_at FROM public.commerce_order_operations op
  WHERE op.operation_type='order_refunded' UNION ALL
  SELECT e.aggregate_id,(e.metadata#>>'{refundStatusFactV1,clientId}')::uuid,coalesce((e.metadata#>>'{refundStatusFactV1,occurredAt}')::timestamptz,
   (e.payload->>'occurredAt')::timestamptz) FROM public.outbox_events e JOIN public.commerce_orders o ON o.id=e.aggregate_id
  WHERE e.event_type='commerce.order.refunded') source WHERE source.client_id IS NOT NULL ORDER BY source.order_id,source.occurred_at
 )
 UNION ALL
 SELECT 'checkout:'||e.aggregate_id,e.aggregate_id,(e.metadata#>>'{checkoutQualificationV1,subject,clientId}')::uuid,
  e.metadata->'checkoutQualificationV1',NULL FROM public.outbox_events e WHERE e.event_type='commerce.checkout.recovery_qualified.v1'
 UNION ALL
 SELECT 'subscription:'||e.id,e.subscription_id,e.communication_subject_id,jsonb_build_object('schemaVersion',1,'sourceId','subscription:'||e.id,
  'sourceType',CASE e.event_type WHEN 'subscription.activated' THEN 'subscription.created'
   WHEN 'subscription.customer_self_service.pause' THEN 'subscription.paused' WHEN 'subscription.customer_self_service.cancel' THEN 'subscription.cancelled'
   ELSE 'subscription.resumed' END,'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'subject',jsonb_build_object('clientId',e.communication_subject_id),'data',jsonb_build_object('subscriptionId',e.subscription_id)),
  CASE WHEN e.communication_subject_id IS NULL THEN 'source_snapshot_missing' ELSE NULL END
 FROM public.subscription_events e JOIN public.subscriptions s ON s.id=e.subscription_id WHERE e.event_type IN
 ('subscription.activated','subscription.customer_self_service.pause','subscription.customer_self_service.resume','subscription.system.auto_resume','subscription.customer_self_service.cancel');

-- Stable binding identity excludes mappingVersion: a changed mapping cannot replay sources.
CREATE FUNCTION public.communication_event_binding(p_binding jsonb,p_live_since timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE key text; existing jsonb; cutoff timestamptz;
BEGIN
 IF p_live_since IS NULL OR NOT isfinite(p_live_since) OR jsonb_typeof(p_binding)<>'object' OR EXISTS(SELECT 1 FROM unnest(ARRAY['account','environment','namespace','mappingVersion']) k
  WHERE nullif(p_binding->>k,'') IS NULL) THEN RAISE EXCEPTION 'event_binding_invalid' USING ERRCODE='22023'; END IF;
 key:=encode(sha256(convert_to(jsonb_build_array(p_binding->>'account',p_binding->>'environment',p_binding->>'namespace')::text,'UTF8')),'hex');
 INSERT INTO public.communication_event_bindings(binding_key,binding,activated_at) VALUES(key,p_binding,p_live_since) ON CONFLICT DO NOTHING;
 SELECT binding,activated_at INTO existing,cutoff FROM public.communication_event_bindings WHERE binding_key=key FOR UPDATE;
 IF existing IS DISTINCT FROM p_binding OR cutoff IS DISTINCT FROM p_live_since THEN RAISE EXCEPTION 'event_binding_changed' USING ERRCODE='22023'; END IF;
 RETURN key;
END; $$;

CREATE FUNCTION public.communication_event_handoff_missing(p_source_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.communication_event_bindings b WHERE NOT EXISTS(SELECT 1 FROM public.communication_event_receipts r
  WHERE r.binding_key=b.binding_key AND r.source_key=p_source_key
   AND (p_source_key NOT LIKE 'checkout:%' OR r.state IN ('accepted','refused','erased'))));
$$;
CREATE FUNCTION public.communication_event_payload_releasable(p_event_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.communication_event_receipts WHERE outbox_event_id=p_event_id AND state IN ('accepted','refused','erased'));
$$;
CREATE FUNCTION public.communication_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_source_key text; sealed_owner name;
BEGIN
 SELECT pg_get_userbyid(proowner) INTO sealed_owner FROM pg_proc WHERE oid='public.commerce_order_emit_paid_notification()'::regprocedure;
 IF TG_OP='INSERT' THEN
  IF (NEW.metadata ?| ARRAY['commercePaidFactV1','refundStatusFactV1','checkoutQualificationV1']) AND NOT pg_has_role(current_user,sealed_owner,'USAGE') THEN
   RAISE EXCEPTION 'paid_source_fabrication_forbidden' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.event_type='communication.ecommerce.export.v1' AND
   ((OLD.payload IS DISTINCT FROM NEW.payload) OR (OLD.metadata->'retainPayload' IS DISTINCT FROM NEW.metadata->'retainPayload'))
   AND NOT ((NEW.payload=OLD.payload OR NEW.payload='{}'::jsonb) AND public.communication_event_payload_releasable(OLD.id)) THEN
   RAISE EXCEPTION 'event_projection_immutable' USING ERRCODE='55000'; END IF;
  IF (OLD.metadata->'commercePaidFactV1' IS DISTINCT FROM NEW.metadata->'commercePaidFactV1')
   OR (OLD.metadata->'refundStatusFactV1' IS DISTINCT FROM NEW.metadata->'refundStatusFactV1')
   OR (OLD.metadata->'checkoutQualificationV1' IS DISTINCT FROM NEW.metadata->'checkoutQualificationV1')
   OR (OLD.metadata->'qualificationPolicy' IS DISTINCT FROM NEW.metadata->'qualificationPolicy')
   OR ((OLD.metadata ?| ARRAY['commercePaidFactV1','refundStatusFactV1','checkoutQualificationV1']) AND
    ROW(OLD.id,OLD.aggregate_id,OLD.aggregate_type,OLD.event_type,OLD.idempotency_key) IS DISTINCT FROM
    ROW(NEW.id,NEW.aggregate_id,NEW.aggregate_type,NEW.event_type,NEW.idempotency_key)) THEN
   RAISE EXCEPTION 'event_source_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 v_source_key:=CASE OLD.event_type WHEN 'commerce.order.paid' THEN 'paid:'||OLD.aggregate_id
  WHEN 'commerce.order.refunded' THEN 'refund-status:'||OLD.aggregate_id
  WHEN 'commerce.checkout.recovery_qualified.v1' THEN 'checkout:'||OLD.aggregate_id ELSE NULL END;
 IF v_source_key IS NOT NULL AND public.communication_event_handoff_missing(v_source_key) THEN
  RAISE EXCEPTION 'event_source_handoff_required' USING ERRCODE='55000'; END IF;
 RETURN OLD;
END; $$;
CREATE TRIGGER communication_event_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.outbox_events
 FOR EACH ROW EXECUTE FUNCTION public.communication_event_guard();

-- Source ledgers can be copied by the retained-store owner, but ordinary edits
-- cannot rewrite a recorded subject or remove a live, unprojected obligation.
CREATE FUNCTION public.communication_event_ledger_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_source_key text;
BEGIN
 IF TG_TABLE_NAME='subscription_events' THEN
  IF OLD.event_type IN ('subscription.activated','subscription.customer_self_service.pause','subscription.customer_self_service.resume','subscription.system.auto_resume','subscription.customer_self_service.cancel') THEN
   v_source_key:='subscription:'||OLD.id; END IF;
 ELSIF OLD.operation_type='order_refunded' THEN v_source_key:='refund-status:'||OLD.order_id; END IF;
 IF v_source_key IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'event_source_immutable' USING ERRCODE='55000'; END IF;
 IF public.communication_event_handoff_missing(v_source_key) THEN
  RAISE EXCEPTION 'event_source_handoff_required' USING ERRCODE='55000'; END IF;
 RETURN OLD;
END; $$;
CREATE TRIGGER communication_subscription_source_guard BEFORE UPDATE OR DELETE ON public.subscription_events
 FOR EACH ROW EXECUTE FUNCTION public.communication_event_ledger_guard();
CREATE TRIGGER communication_refund_source_guard BEFORE UPDATE OR DELETE ON public.commerce_order_operations
 FOR EACH ROW EXECUTE FUNCTION public.communication_event_ledger_guard();
REVOKE ALL ON FUNCTION public.communication_event_ledger_guard() FROM PUBLIC;

-- The same owner retention hint is honored by native and standalone compactors.
CREATE OR REPLACE FUNCTION public.commerce_outbox_compact_terminal(
  p_limit integer DEFAULT 500,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
  v_processed integer := 0;
  v_discarded integer := 0;
BEGIN
  WITH target AS (
    SELECT event.id, event.status
      FROM public.outbox_events AS event
     WHERE event.metadata->>'retentionCompactedAt' IS NULL
       AND event.metadata->>'retainPayload' IS DISTINCT FROM 'true'
       AND (
         (event.status = 'processed' AND COALESCE(event.processed_at, event.created_at) < p_now - interval '30 days')
         OR (
           event.status = 'discarded'
           AND public.commerce_checkout_recovery_try_timestamptz(
             event.metadata->>'discardedAt'
           ) < p_now - interval '90 days'
         )
       )
     ORDER BY event.created_at, event.id
     LIMIT v_limit FOR UPDATE SKIP LOCKED
  ), compacted AS (
    UPDATE public.outbox_events AS event
       SET payload = '{}'::jsonb,
           error = NULL,
           metadata = event.metadata || jsonb_build_object(
             'retentionCompactedAt', p_now,
             'retentionCompactedBy', 'commerce_outbox_compact_terminal',
             'retentionCompactedStatus', event.status
           )
      FROM target WHERE event.id = target.id
    RETURNING target.status
  )
  SELECT count(*) FILTER (WHERE status = 'processed')::integer,
         count(*) FILTER (WHERE status = 'discarded')::integer
    INTO v_processed, v_discarded FROM compacted;
  RETURN jsonb_build_object(
    'compacted', v_processed + v_discarded,
    'processed', v_processed,
    'discarded', v_discarded
  );
END;
$$;

CREATE FUNCTION public.communication_event_candidates(p_binding jsonb,p_live_since timestamptz,p_limit integer)
RETURNS TABLE(source_key text,aggregate_id uuid,client_id uuid,event jsonb,reason text,historical boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE binding_id text;
BEGIN
 binding_id:=public.communication_event_binding(p_binding,p_live_since);
 RETURN QUERY SELECT s.source_key,s.aggregate_id,s.client_id,s.event,s.reason,
  coalesce((s.event->>'occurredAt')::timestamptz,'-infinity')<p_live_since
 FROM public.communication_event_sources s WHERE NOT EXISTS(SELECT 1 FROM public.communication_event_receipts r
  WHERE r.binding_key=binding_id AND r.source_key=s.source_key)
 ORDER BY (s.event->>'occurredAt')::timestamptz,s.source_key LIMIT least(greatest(p_limit,1),1000);
END; $$;
CREATE FUNCTION public.communication_event_source_current(p_event jsonb,p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE subject uuid:=(p_event#>>'{subject,clientId}')::uuid;
BEGIN
 IF (NOT EXISTS(SELECT 1 FROM public.communication_event_sources WHERE source_key=p_event->>'sourceId' AND event=p_event)
  AND NOT EXISTS(SELECT 1 FROM public.communication_event_receipts r JOIN public.outbox_events e ON e.id=r.outbox_event_id
   WHERE r.source_key=p_event->>'sourceId' AND e.payload->'event'=p_event))
  OR (p_event->>'occurredAt')::timestamptz>p_now
  OR EXISTS(SELECT 1 FROM public.communication_event_erasures WHERE client_id=subject)
  OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=subject) THEN RETURN false; END IF;
 IF p_event->>'sourceType'='order.paid' THEN
  RETURN EXISTS(SELECT 1 FROM public.commerce_settlement_transitions WHERE intent_id=(p_event#>>'{data,settlementIntentId}')::uuid AND outcome='succeeded');
 ELSIF p_event->>'sourceType'='checkout.recovery_qualified' THEN
  RETURN EXISTS(SELECT 1 FROM public.commerce_orders o JOIN public.outbox_events e ON e.aggregate_id=o.id
   AND e.event_type='commerce.checkout.recovery_qualified.v1' WHERE o.id=(p_event#>>'{data,orderId}')::uuid AND o.status='pending_payment'
   AND o.client_id=subject AND o.subscription_cycle_id IS NULL AND p_now<(p_event#>>'{data,expiresAt}')::timestamptz
   AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional')
   AND NOT public.commerce_checkout_recovery_payment_blocked(o.id,(e.metadata#>>'{qualificationPolicy,activitySeconds}')::integer,p_now));
 END IF;
 RETURN true;
END; $$;
CREATE FUNCTION public.communication_event_enqueue(p_binding jsonb,p_live_since timestamptz,p_source_key text,p_request text,p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE binding_id text; source record; work_id uuid; request jsonb:=p_request::jsonb;
BEGIN
 binding_id:=public.communication_event_binding(p_binding,p_live_since);
 SELECT * INTO source FROM public.communication_event_sources WHERE source_key=p_source_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_source_missing' USING ERRCODE='22023'; END IF;
 LOCK TABLE public.communication_event_receipts IN ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.communication_event_receipts WHERE binding_key=binding_id AND source_key=p_source_key) THEN RETURN 'duplicate'; END IF;
 IF p_request IS NOT NULL AND (EXISTS(SELECT 1 FROM public.communication_event_erasures WHERE client_id=source.client_id)
  OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=source.client_id)) THEN
  p_request:=NULL; request:=NULL; p_reason:='subject_erased'; END IF;
 IF p_request IS NOT NULL THEN
  IF request->'event' IS DISTINCT FROM source.event OR request->'binding' IS DISTINCT FROM p_binding OR p_reason IS NOT NULL
   OR (source.event->>'occurredAt')::timestamptz<p_live_since OR source.reason IS NOT NULL THEN
   RAISE EXCEPTION 'event_projection_source_conflict' USING ERRCODE='22023'; END IF;
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
  VALUES('communication_event',source.aggregate_id,'communication.ecommerce.export.v1',binding_id||':'||p_source_key,request,'{"retainPayload":true}') RETURNING id INTO work_id;
 ELSIF nullif(p_reason,'') IS NULL THEN RAISE EXCEPTION 'event_projection_disposition_required' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.communication_event_receipts(binding_key,source_key,client_id,outbox_event_id,state,reason,request_digest)
 VALUES(binding_id,p_source_key,source.client_id,work_id,CASE WHEN p_reason='subject_erased' THEN 'erased' WHEN p_request IS NULL THEN 'refused' ELSE 'pending' END,p_reason,
  CASE WHEN p_request IS NULL THEN NULL ELSE encode(sha256(convert_to(p_request,'UTF8')),'hex') END);
 RETURN CASE WHEN p_request IS NULL THEN 'refused' ELSE 'pending' END;
END; $$;
CREATE FUNCTION public.communication_event_work(p_event_id uuid,p_claim text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb;
BEGIN
 SELECT to_jsonb(r)||jsonb_build_object('payload',e.payload,'status',e.status,'available_at',e.available_at) INTO result
 FROM public.communication_event_receipts r JOIN public.outbox_events e ON e.id=r.outbox_event_id WHERE e.id=p_event_id
 AND (p_claim IS NULL OR (e.status='processing' AND e.metadata->>'claimToken'=p_claim)) FOR UPDATE OF r,e;
 RETURN result;
END; $$;
CREATE FUNCTION public.communication_event_settle(p_event_id uuid,p_digest text,p_before text,p_after text,p_reason text,p_recovery text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE changed integer;
BEGIN
 IF NOT ((p_before='pending' AND p_after IN ('dispatching','refused')) OR
  (p_before IN ('dispatching','unknown') AND p_after IN ('pending','accepted','unknown','refused'))) OR
  (p_before='unknown' AND nullif(p_recovery,'') IS NULL) THEN RAISE EXCEPTION 'event_settlement_invalid' USING ERRCODE='22023'; END IF;
 UPDATE public.communication_event_receipts SET state=p_after,reason=p_reason,recovery_reference=coalesce(p_recovery,recovery_reference),updated_at=clock_timestamp()
 WHERE outbox_event_id=p_event_id AND request_digest=p_digest AND state=p_before;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 AND p_after IN ('accepted','refused') THEN UPDATE public.outbox_events SET metadata=metadata-'retainPayload' WHERE id=p_event_id; END IF;
 RETURN changed=1;
END; $$;
CREATE FUNCTION public.communication_event_privacy(p_client_id uuid,p_erase boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_erase THEN
  LOCK TABLE public.communication_event_receipts IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO public.communication_event_erasures(client_id) VALUES(p_client_id) ON CONFLICT DO NOTHING;
  UPDATE public.communication_event_receipts SET state='erased',reason='subject_erased',updated_at=clock_timestamp() WHERE client_id=p_client_id;
  UPDATE public.outbox_events e SET payload='{}',error=NULL,status='discarded',metadata=(e.metadata-'retainPayload')||
   jsonb_build_object('discardedAt',clock_timestamp(),'discardedReason','subject_erased') FROM public.communication_event_receipts r
   WHERE r.client_id=p_client_id AND r.outbox_event_id=e.id;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_key',r.source_key,'state',r.state,'reason',r.reason,'request_digest',r.request_digest,'projection',e.payload)
  ORDER BY r.binding_key,r.source_key),'[]') INTO result FROM public.communication_event_receipts r LEFT JOIN public.outbox_events e ON e.id=r.outbox_event_id WHERE r.client_id=p_client_id;
 RETURN result;
END; $$;

ALTER TABLE public.communication_event_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_event_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.communication_event_bindings FROM PUBLIC;
REVOKE ALL ON TABLE public.communication_event_receipts FROM PUBLIC;
REVOKE ALL ON TABLE public.communication_event_erasures FROM PUBLIC;
REVOKE ALL ON TABLE public.communication_event_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION public.communication_paid_fact(public.commerce_orders),public.communication_event_capture_subject(),public.communication_event_paid_write(uuid),public.communication_event_refund_write(uuid),public.communication_checkout_qualify(integer,jsonb,timestamptz),public.communication_event_binding(jsonb,timestamptz),public.communication_event_handoff_missing(text),public.communication_event_payload_releasable(uuid),public.communication_event_guard(),public.communication_event_candidates(jsonb,timestamptz,integer),public.communication_event_source_current(jsonb,timestamptz),public.communication_event_enqueue(jsonb,timestamptz,text,text,text),public.communication_event_work(uuid,text),public.communication_event_settle(uuid,text,text,text,text,text),public.communication_event_privacy(uuid,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.communication_event_paid_write(uuid),public.communication_event_refund_write(uuid),public.communication_checkout_qualify(integer,jsonb,timestamptz),public.communication_event_binding(jsonb,timestamptz),public.communication_event_handoff_missing(text),public.communication_event_payload_releasable(uuid),public.communication_event_candidates(jsonb,timestamptz,integer),public.communication_event_source_current(jsonb,timestamptz),public.communication_event_enqueue(jsonb,timestamptz,text,text,text),public.communication_event_work(uuid,text),public.communication_event_settle(uuid,text,text,text,text,text),public.communication_event_privacy(uuid,boolean) TO service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.communication_event_receipts TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY communication_event_receipts_absorption_census ON public.communication_event_receipts FOR SELECT TO service_role USING (true);'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.communication_event_erasures TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY communication_event_erasures_absorption_census ON public.communication_event_erasures FOR SELECT TO service_role USING (true);'; END IF; END; $$;
