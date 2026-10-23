-- Independent document obligations. Capture touches only the neutral duty/receipt rail;
-- accounting locks, facts and provider work belong to the sweep/executor transaction.
-- Native execution requires the host's explicit owner/least-privilege bootstrap.
-- Capture the install boundary by source identity. These rails have no
-- insertion timestamp, and occurred_at is host evidence that can arrive late.
CREATE TABLE public.invoicing_cutover (
  source_kind text NOT NULL CHECK (source_kind IN ('paid','handoff')),
  source_id uuid NOT NULL,
  PRIMARY KEY (source_kind,source_id)
);
INSERT INTO public.invoicing_cutover(source_kind,source_id)
  SELECT 'paid',id FROM public.commerce_settlement_transitions
  UNION ALL SELECT 'handoff',id FROM public.fulfillment_shipment_operations
  ON CONFLICT DO NOTHING;
CREATE TABLE public.invoicing_duties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  parent_duty_id uuid REFERENCES public.invoicing_duties(id),
  document_id uuid UNIQUE REFERENCES public.accounting_documents(id),
  request_id uuid UNIQUE REFERENCES public.accounting_document_requests(id),
  original_key text NOT NULL,
  status text NOT NULL DEFAULT 'owed' CHECK (status IN ('owed','blocked','ready','processing','unknown','issued','voided','unsupported','faulted')),
  provider text,
  seller_policy_version text,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  claim_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  fact_attempts integer NOT NULL DEFAULT 0,
  fact_token uuid,
  fact_lease_until timestamptz,
  preflight_generation integer,
  reversal jsonb,
  last_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invoicing_duties_one_issue ON public.invoicing_duties(order_id) WHERE parent_duty_id IS NULL;
CREATE UNIQUE INDEX invoicing_duties_one_correction ON public.invoicing_duties(parent_duty_id) WHERE parent_duty_id IS NOT NULL;
CREATE TABLE public.invoicing_fact_revisions (
  duty_id uuid PRIMARY KEY REFERENCES public.invoicing_duties(id),
  revision_ref text NOT NULL CHECK (btrim(revision_ref) <> ''),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  installed_at timestamptz NOT NULL DEFAULT now()
);
-- Source identities, exact original host keys and terminal effects share this immutable
-- receipt rail; different source/key aliases point to the same physical duty.
CREATE TABLE public.invoicing_effect_receipts (
  receipt_key text PRIMARY KEY,
  duty_id uuid NOT NULL REFERENCES public.invoicing_duties(id),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
-- No order/duty FK: recording a capture fault must not reacquire money locks.
CREATE TABLE public.invoicing_capture_faults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  attempts integer NOT NULL,
  state text NOT NULL CHECK (state IN ('retryable','faulted')),
  available_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX invoicing_capture_faults_source ON public.invoicing_capture_faults(source_kind,source_id);
CREATE INDEX invoicing_capture_faults_order ON public.invoicing_capture_faults(order_id);
CREATE INDEX invoicing_duties_available ON public.invoicing_duties(status,available_at);
CREATE VIEW public.invoicing_due_sources WITH (security_invoker=true) AS
SELECT 'paid'::text AS source_kind, t.id AS source_id, i.order_id,
  t.idempotency_key AS source_key, t.occurred_at,
  jsonb_build_object('settlementIntentId',i.id,'amountMinor',i.amount_minor,'currency',i.currency_code) AS evidence
FROM public.commerce_settlement_transitions t
JOIN public.commerce_settlement_intents i ON i.id=t.intent_id
WHERE t.outcome='succeeded'
  AND NOT EXISTS (SELECT 1 FROM public.invoicing_cutover c WHERE c.source_kind='paid' AND c.source_id=t.id)
  AND NOT EXISTS (SELECT 1 FROM public.accounting_documents a WHERE a.order_id=i.order_id AND a.status<>'voided')
  AND NOT EXISTS (SELECT 1 FROM public.invoicing_capture_faults f WHERE f.source_kind='paid' AND f.source_id=t.id AND (f.state='faulted' OR f.available_at>now()))
  AND NOT EXISTS (
  SELECT 1 FROM public.invoicing_effect_receipts r WHERE r.receipt_key='source:paid:' || t.id::text)
UNION ALL
SELECT 'handoff'::text, o.id, o.order_id, o.idempotency_key, o.occurred_at,
  jsonb_build_object('shipmentId',s.id,'handedOverAt',to_char(s.handed_over_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
FROM public.fulfillment_shipment_operations o
JOIN public.fulfillment_shipments s ON s.id=o.shipment_id
WHERE o.payload->>'toStatus'='handed_over' AND s.handed_over_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoicing_cutover c WHERE c.source_kind='handoff' AND c.source_id=o.id)
  AND NOT EXISTS (SELECT 1 FROM public.accounting_documents a WHERE a.order_id=o.order_id AND a.status<>'voided')
  AND NOT EXISTS (SELECT 1 FROM public.invoicing_capture_faults f WHERE f.source_kind='handoff' AND f.source_id=o.id AND (f.state='faulted' OR f.available_at>now()))
  AND NOT EXISTS (
  SELECT 1 FROM public.invoicing_effect_receipts r WHERE r.receipt_key='source:handoff:' || o.id::text);

CREATE FUNCTION public.invoicing_capture_duty(
  p_key text, p_source_kind text, p_source_id uuid, p_order_id uuid, p_evidence jsonb, p_occurred_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_duty public.invoicing_duties%ROWTYPE;
  v_receipt public.invoicing_effect_receipts%ROWTYPE;
  v_payload jsonb;
  v_key text;
BEGIN
  IF p_key IS NULL OR btrim(p_key)='' OR p_source_kind NOT IN ('paid','handoff') OR p_source_kind IS NULL
    OR p_source_id IS NULL OR p_order_id IS NULL OR p_occurred_at IS NULL OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'invoicing_capture_invalid' USING ERRCODE='22023'; END IF;
  -- Serialize only aliases for this order, without consulting accounting objects.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('invoicing:' || p_order_id::text,0)) THEN
    RAISE EXCEPTION 'invoicing_capture_busy' USING ERRCODE='55P03';
  END IF;
  INSERT INTO public.invoicing_duties(order_id,original_key,seller_policy_version) VALUES(p_order_id,p_key,
    'invoicing.seller.v1')
    ON CONFLICT (order_id) WHERE parent_duty_id IS NULL DO NOTHING RETURNING * INTO v_duty;
  IF v_duty.id IS NULL THEN
    SELECT * INTO v_duty FROM public.invoicing_duties WHERE order_id=p_order_id AND parent_duty_id IS NULL;
  END IF;
  v_payload:=jsonb_build_object('sourceKind',p_source_kind,'sourceId',p_source_id,'orderId',p_order_id,'evidence',p_evidence,'occurredAt',to_char(p_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  FOREACH v_key IN ARRAY ARRAY['source:' || p_source_kind || ':' || p_source_id::text,'key:' || p_source_kind || ':' || coalesce(p_evidence->>'settlementIntentId',p_source_id::text) || ':' || p_key] LOOP
    INSERT INTO public.invoicing_effect_receipts(receipt_key,duty_id,payload) VALUES(v_key,v_duty.id,v_payload)
      ON CONFLICT DO NOTHING;
    SELECT * INTO v_receipt FROM public.invoicing_effect_receipts WHERE receipt_key=v_key;
    IF v_receipt.duty_id IS DISTINCT FROM v_duty.id OR v_receipt.payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'invoicing_source_or_key_conflict' USING ERRCODE='23505';
    END IF;
  END LOOP;
  RETURN jsonb_build_object('dutyId',v_duty.id,'status',v_duty.status);
END;
$$;

CREATE FUNCTION public.invoicing_install_facts(p_duty uuid,p_facts jsonb,p_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE; v_prior public.invoicing_fact_revisions%ROWTYPE;
  v_line jsonb; v_sum numeric:=0; v_net numeric:=0; v_tax numeric:=0;
BEGIN
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoicing_duty_missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_prior FROM public.invoicing_fact_revisions WHERE duty_id=p_duty;
  IF FOUND THEN
    IF v_prior.facts IS DISTINCT FROM p_facts OR v_prior.revision_ref IS DISTINCT FROM p_revision THEN
      RAISE EXCEPTION 'invoicing_facts_immutable' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('dutyId',p_duty,'status',v_duty.status,'replayed',true);
  END IF;
  IF v_duty.status NOT IN ('owed','blocked') THEN RAISE EXCEPTION 'invoicing_facts_inactive' USING ERRCODE='22023'; END IF;
  IF p_revision IS NULL OR btrim(p_revision)='' OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_facts->'buyer') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_facts->'dates') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_facts->'refs') IS DISTINCT FROM 'object'
    OR nullif(p_facts->>'policyVersion','') IS NULL OR p_facts->>'currency' IS NULL
    OR length(p_facts->>'currency')<>3 OR jsonb_array_length(p_facts->'lines')=0
  THEN
    UPDATE public.invoicing_duties SET status='blocked',last_result='{"kind":"missing_facts"}' WHERE id=p_duty;
    RETURN jsonb_build_object('dutyId',p_duty,'status','blocked');
  END IF;
  -- Minor amounts must be integer and safe before a host converts them to JS numbers.
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_facts->'lines') LOOP
    IF jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(v_line->'taxRateBps') IS DISTINCT FROM 'number'
      OR nullif(btrim(v_line->>'description'),'') IS NULL OR NOT (v_line ?& ARRAY['quantity','unitGrossMinor','totalGrossMinor','totalNetMinor','totalTaxMinor','taxRateBps','description'])
      OR (v_line->>'quantity')::numeric NOT BETWEEN 1 AND 2147483647
      OR trunc((v_line->>'quantity')::numeric)<>(v_line->>'quantity')::numeric
      OR (v_line->>'taxRateBps')::numeric NOT BETWEEN 0 AND 10000
      OR trunc((v_line->>'taxRateBps')::numeric)<>(v_line->>'taxRateBps')::numeric
      OR (v_line->>'totalNetMinor')::numeric+(v_line->>'totalTaxMinor')::numeric<>(v_line->>'totalGrossMinor')::numeric
      OR EXISTS (SELECT 1 FROM jsonb_each(v_line) a WHERE a.key IN ('unitGrossMinor','totalGrossMinor','totalNetMinor','totalTaxMinor')
        AND (jsonb_typeof(a.value)<>'number' OR abs(a.value::text::numeric)>9007199254740991 OR trunc(a.value::text::numeric)<>a.value::text::numeric))
    THEN RAISE EXCEPTION 'invoicing_facts_money_unsupported' USING ERRCODE='22023'; END IF;
    v_sum:=v_sum+(v_line->>'totalGrossMinor')::numeric;
    v_net:=v_net+(v_line->>'totalNetMinor')::numeric;
    v_tax:=v_tax+(v_line->>'totalTaxMinor')::numeric;
  END LOOP;
  IF v_sum IS DISTINCT FROM (p_facts->>'totalGrossMinor')::numeric
    OR v_net IS DISTINCT FROM (p_facts->>'totalNetMinor')::numeric OR v_tax IS DISTINCT FROM (p_facts->>'totalTaxMinor')::numeric
    OR v_sum<0 OR v_sum>9007199254740991 OR v_net<0 OR v_tax<0
  THEN RAISE EXCEPTION 'invoicing_facts_total_mismatch' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_orders WHERE id=v_duty.order_id AND currency_code=p_facts->>'currency'
      AND total_amount_minor=v_sum AND paid_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invoicing_order_money_mismatch' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.invoicing_fact_revisions(duty_id,revision_ref,facts) VALUES(p_duty,p_revision,p_facts) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('dutyId',p_duty,'status','owed');
END;
$$;

-- Outbox-style claim/token/visibility; source capture and fact preparation
-- each stop at eight attempts. Provider duty claims have no attempt ceiling.
-- Commit before invoking accounting work. Capture never installs.
CREATE FUNCTION public.invoicing_sweep_duties(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_source record; v_duty record; v_seen integer:=0; v_attempt integer; v_claims jsonb:='[]'; v_timeout text:=current_setting('lock_timeout');
BEGIN
  FOR v_source IN SELECT * FROM public.invoicing_due_sources ORDER BY occurred_at,source_id LIMIT least(greatest(coalesce(p_limit,10),1),100) LOOP
    BEGIN
      PERFORM set_config('lock_timeout','100ms',true);
      PERFORM public.invoicing_capture_duty(v_source.source_key,v_source.source_kind,v_source.source_id,v_source.order_id,v_source.evidence,v_source.occurred_at);
      PERFORM set_config('lock_timeout',v_timeout,true);
      v_seen:=v_seen+1;
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      SELECT coalesce(max(attempts),0)+1 INTO v_attempt FROM public.invoicing_capture_faults WHERE source_kind=v_source.source_kind AND source_id=v_source.source_id;
      INSERT INTO public.invoicing_capture_faults(order_id,source_kind,source_id,attempts,state,available_at)
        VALUES(v_source.order_id,v_source.source_kind,v_source.source_id,v_attempt,CASE WHEN v_attempt>=8 THEN 'faulted' ELSE 'retryable' END,
          now()+make_interval(secs=>least(3600,60*power(2,least(v_attempt-1,6)))::integer));
    END;
  END LOOP;
  FOR v_duty IN SELECT d.* FROM public.invoicing_duties d
    JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
    WHERE d.request_id IS NULL AND d.status IN ('owed','blocked') AND d.available_at<=now()
      AND d.reversal IS NULL
      AND (d.fact_token IS NULL OR d.fact_lease_until<=now())
    ORDER BY d.created_at,d.id LIMIT least(greatest(coalesce(p_limit,10),1),100) FOR UPDATE OF d SKIP LOCKED LOOP
    IF v_duty.fact_attempts>=8 THEN
      UPDATE public.invoicing_duties SET status='faulted',fact_token=NULL,fact_lease_until=NULL,last_result='{"kind":"faulted"}' WHERE id=v_duty.id;
      CONTINUE;
    END IF;
    UPDATE public.invoicing_duties SET fact_attempts=fact_attempts+1,fact_token=gen_random_uuid(),fact_lease_until=now()+interval '5 minutes'
      WHERE id=v_duty.id RETURNING * INTO v_duty;
    v_claims:=v_claims||jsonb_build_array(jsonb_build_object('dutyId',v_duty.id,'token',v_duty.fact_token));
  END LOOP;
  RETURN jsonb_build_object('collected',v_seen,'claims',v_claims);
END;
$$;

-- Accounting transaction: no order FOR UPDATE and no external I/O.
-- The final duty fence uses NOWAIT so it cannot delay order work.
-- Deterministic document_ref preserves the incumbent one-document identity.
-- Bound unavoidable FK/unique waits. Commit before the lease-guarded mark RPC.
CREATE FUNCTION public.invoicing_prepare_facts(p_duty uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE; v_document public.accounting_documents%ROWTYPE;
  v_facts jsonb; v_request uuid; v_ready uuid; v_status text; v_timeout text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('invoicing:'||(SELECT order_id::text FROM public.invoicing_duties WHERE id=p_duty),0)) THEN RETURN '{"status":"owed","kind":"retryable"}'; END IF;
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty;
  IF NOT FOUND OR p_token IS NULL OR v_duty.fact_token IS NULL OR v_duty.fact_lease_until IS NULL OR v_duty.fact_token IS DISTINCT FROM p_token OR v_duty.fact_lease_until<=now() OR v_duty.request_id IS NOT NULL OR v_duty.status NOT IN ('owed','blocked') OR v_duty.reversal IS NOT NULL THEN RETURN '{"status":"stale"}'; END IF;
  SELECT facts INTO v_facts FROM public.invoicing_fact_revisions WHERE duty_id=p_duty;
  v_timeout:=current_setting('lock_timeout');
  BEGIN
    PERFORM set_config('lock_timeout','100ms',true);
    SELECT * INTO v_document FROM public.accounting_documents WHERE order_id=v_duty.order_id AND correction_of_document_id IS NULL FOR UPDATE;
    IF FOUND AND (v_document.metadata->'neutralFacts' IS DISTINCT FROM v_facts OR v_document.total_gross_minor<>(v_facts->>'totalGrossMinor')::bigint) THEN
      PERFORM set_config('lock_timeout',v_timeout,true);
      RETURN '{"status":"unsupported","kind":"legacy_facts_unproved"}';
    END IF;
    IF v_document.id IS NULL THEN
      INSERT INTO public.accounting_documents(order_id,document_ref,status,total_gross_minor,requested_at,metadata)
        VALUES(v_duty.order_id,'order:'||v_duty.order_id::text||':base','issue_requested',(v_facts->>'totalGrossMinor')::bigint,now(),
          jsonb_build_object('neutralFacts',v_facts,'currency',v_facts->>'currency','requestIdempotencyKey',v_duty.original_key))
        ON CONFLICT ON CONSTRAINT accounting_documents_document_ref_key DO NOTHING RETURNING * INTO v_document;
      IF v_document.id IS NULL THEN
        -- A rival may have installed incompatible facts since the read. Retry
        -- through the same immutable-facts comparison, never adopt blindly.
        RAISE EXCEPTION 'invoicing_install_raced' USING ERRCODE='40001';
      END IF;
      PERFORM public.accounting_document_write_positions(v_document.id,v_facts->'lines');
      INSERT INTO public.accounting_document_requests(document_id,request_kind,available_at) VALUES(v_document.id,'issue','infinity');
      INSERT INTO public.accounting_document_operations(document_id,order_id,operation_type,idempotency_key,payload,occurred_at)
        VALUES(v_document.id,v_duty.order_id,'document_requested','invoicing:request:'||v_duty.id::text,jsonb_build_object('totalGrossMinor',(v_facts->>'totalGrossMinor')::bigint),now());
    END IF;
    SELECT id INTO v_request FROM public.accounting_document_requests WHERE document_id=v_document.id AND request_kind='issue';
    UPDATE public.accounting_document_requests SET available_at='infinity'
      WHERE id=v_request AND status='pending' AND attempts=0 AND claim_token IS NULL RETURNING id INTO v_ready;
    v_status:=CASE WHEN v_document.provider_reference IS NOT NULL THEN 'issued' WHEN v_document.status='voided' THEN 'voided'
      WHEN v_ready IS NULL THEN 'unsupported' ELSE 'ready' END;
    PERFORM 1 FROM public.invoicing_duties WHERE id=p_duty AND fact_token=p_token
      AND fact_lease_until>clock_timestamp() AND request_id IS NULL
      AND status IN ('owed','blocked') AND reversal IS NULL FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoicing_fact_lease_stale' USING ERRCODE='40001'; END IF;
    PERFORM set_config('lock_timeout',v_timeout,true);
    RETURN jsonb_build_object('status',v_status,'documentId',v_document.id,'requestId',v_request);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    RETURN '{"status":"owed","kind":"retryable"}';
  END;
END;
$$;
CREATE FUNCTION public.invoicing_finish_facts(p_duty uuid,p_token uuid,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE; v_document record;
  v_request record; v_document_id uuid; v_request_id uuid; v_status text; v_owned boolean; v_facts jsonb; v_kind text;
BEGIN
  -- Validate host identity before taking its request lock; retain request-before-duty order.
  IF p_result->>'requestId' IS NOT NULL THEN
    PERFORM 1 FROM public.accounting_document_requests r
      JOIN public.accounting_documents a ON a.id=r.document_id
      JOIN public.invoicing_duties d ON d.order_id=a.order_id
      WHERE d.id=p_duty AND r.id=(p_result->>'requestId')::uuid FOR UPDATE OF r;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invoicing_fact_result_mismatch' USING ERRCODE='22023'; END IF;
  END IF;
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR v_duty.fact_token IS NULL OR v_duty.fact_lease_until IS NULL OR v_duty.fact_token IS DISTINCT FROM p_token OR v_duty.fact_lease_until<=now() OR v_duty.request_id IS NOT NULL OR v_duty.status NOT IN ('owed','blocked') OR v_duty.reversal IS NOT NULL THEN RETURN '{"status":"stale"}'; END IF;
  SELECT facts INTO v_facts FROM public.invoicing_fact_revisions WHERE duty_id=p_duty;
  v_status:=p_result->>'status';
  v_kind:=p_result->>'kind';
  IF v_status IS NULL OR v_status NOT IN ('owed','ready','issued','voided','unsupported') THEN RAISE EXCEPTION 'invoicing_fact_result_invalid' USING ERRCODE='22023'; END IF;
  IF p_result->>'documentId' IS NOT NULL THEN
    SELECT * INTO v_document FROM public.accounting_documents WHERE id=(p_result->>'documentId')::uuid;
    SELECT * INTO v_request FROM public.accounting_document_requests WHERE id=(p_result->>'requestId')::uuid;
    IF v_document.id IS NULL OR v_document.order_id IS DISTINCT FROM v_duty.order_id OR v_document.correction_of_document_id IS NOT NULL
      OR v_request.id IS NULL OR v_request.document_id IS DISTINCT FROM v_document.id OR v_request.request_kind<>'issue'
    THEN RAISE EXCEPTION 'invoicing_fact_result_mismatch' USING ERRCODE='22023'; END IF;
    v_status:=CASE WHEN v_document.provider_reference IS NOT NULL THEN 'issued' WHEN v_document.status='voided' THEN 'voided'
      WHEN v_request.attempts>0 OR v_request.status<>'pending' OR v_request.claim_token IS NOT NULL
        OR v_request.available_at<>'infinity'::timestamptz THEN 'unsupported' ELSE 'ready' END;
    IF v_status IS DISTINCT FROM p_result->>'status' THEN RAISE EXCEPTION 'invoicing_fact_result_mismatch' USING ERRCODE='22023'; END IF;
    v_document_id:=v_document.id; v_request_id:=v_request.id;
    v_owned:=EXISTS(SELECT 1 FROM public.accounting_document_operations WHERE document_id=v_document.id AND idempotency_key='invoicing:request:'||p_duty::text);
    IF NOT v_owned AND (v_facts IS NULL OR v_document.metadata->'neutralFacts' IS DISTINCT FROM v_facts
      OR v_document.total_gross_minor IS DISTINCT FROM (v_facts->>'totalGrossMinor')::bigint) THEN
      RAISE EXCEPTION 'invoicing_fact_result_mismatch' USING ERRCODE='22023'; END IF;
    IF v_status='unsupported' THEN v_kind:='unsupported'; END IF;
  ELSIF p_result->>'requestId' IS NOT NULL OR v_status NOT IN ('owed','unsupported') THEN
    RAISE EXCEPTION 'invoicing_fact_result_mismatch' USING ERRCODE='22023';
  ELSIF v_status='unsupported' THEN
    IF v_facts IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounting_documents a
      WHERE a.order_id=v_duty.order_id AND a.correction_of_document_id IS NULL
        AND (a.metadata->'neutralFacts' IS DISTINCT FROM v_facts
          OR a.total_gross_minor IS DISTINCT FROM (v_facts->>'totalGrossMinor')::bigint)) THEN
      RAISE EXCEPTION 'invoicing_fact_result_mismatch' USING ERRCODE='22023'; END IF;
    v_kind:='legacy_facts_unproved';
  END IF;
  IF v_status='owed' AND v_duty.fact_attempts>=8 THEN v_status:='faulted'; END IF;
  UPDATE public.invoicing_duties SET status=v_status,fact_token=NULL,fact_lease_until=NULL,
    document_id=v_document_id,request_id=v_request_id,
    seller_policy_version=CASE WHEN v_document_id IS NOT NULL AND NOT v_owned THEN NULL ELSE seller_policy_version END,
    available_at=CASE WHEN v_status='owed' THEN now()+make_interval(secs=>least(3600,60*power(2,least(fact_attempts-1,6)))::integer) ELSE now() END,
    last_result=CASE WHEN v_status='faulted' THEN '{"kind":"faulted"}'::jsonb WHEN v_kind IS NOT NULL THEN jsonb_build_object('kind',v_kind) END
    WHERE id=p_duty;
  RETURN jsonb_build_object('dutyId',p_duty,'status',v_status);
END;
$$;

-- Trusted host readback is independent of payment truth and accounting tables.
-- Expose only closed neutral diagnostic codes, never raw SQLSTATE/provider evidence.
-- Ready remains owed until issue; a live processing obligation is claimed.
CREATE FUNCTION public.invoicing_duty_readback(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('orderId',p_order_id,'captureFaults',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',f.source_id,'state',CASE WHEN EXISTS(SELECT 1 FROM public.invoicing_effect_receipts r WHERE r.receipt_key='source:'||f.source_kind||':'||f.source_id::text) THEN 'resolved' ELSE f.state END,'attempts',f.attempts,'availableAt',f.available_at) ORDER BY f.recorded_at,f.id),'[]'::jsonb) FROM (SELECT DISTINCT ON (source_kind,source_id) * FROM public.invoicing_capture_faults WHERE order_id=p_order_id ORDER BY source_kind,source_id,recorded_at DESC,id DESC) f),'duties',coalesce(jsonb_agg(
    jsonb_build_object('dutyId',d.id,'parentDutyId',d.parent_duty_id,'documentId',d.document_id,
      'state',CASE d.status WHEN 'ready' THEN 'owed' WHEN 'processing' THEN 'claimed' ELSE d.status END,
      'attempts',d.generation,'factAttempts',d.fact_attempts,
      'diagnosticCode',CASE WHEN d.last_result->>'kind' IN
        ('faulted','missing_facts','legacy_facts_unproved','retryable','blocked','unsupported','unknown','absent')
        THEN d.last_result->>'kind' ELSE NULL END,
      'createdAt',d.created_at,'availableAt',d.available_at,'leaseUntil',d.lease_until)
    ORDER BY d.created_at,d.id),'[]'::jsonb))
  FROM public.invoicing_duties d WHERE d.order_id=p_order_id;
$$;

CREATE FUNCTION public.invoicing_claim_duties(p_limit integer,p_visibility integer,p_provider text,p_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_request public.accounting_document_requests%ROWTYPE;
  v_duty public.invoicing_duties%ROWTYPE;
  v_rows jsonb:='[]';
  v_facts jsonb;
BEGIN
  IF nullif(btrim(p_provider),'') IS NULL THEN RAISE EXCEPTION 'invoicing_provider_required' USING ERRCODE='22023'; END IF;
  FOR v_request IN SELECT r.* FROM public.accounting_document_requests r
    JOIN public.invoicing_duties d ON d.request_id=r.id
    WHERE (p_order_id IS NULL OR d.order_id=p_order_id)
      AND d.status IN ('ready','processing','unknown') AND d.available_at<=now()
      AND (d.status<>'processing' OR d.lease_until<=now())
      AND (d.provider IS NULL OR d.provider=p_provider)
    ORDER BY d.available_at,r.created_at,r.id LIMIT least(greatest(coalesce(p_limit,10),1),100) FOR UPDATE OF r, d SKIP LOCKED LOOP
    SELECT * INTO v_duty FROM public.invoicing_duties WHERE request_id=v_request.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_request.attempts IS DISTINCT FROM v_duty.generation OR v_request.claim_token IS DISTINCT FROM v_duty.claim_token THEN
      UPDATE public.invoicing_duties SET status='unsupported',last_result='{"kind":"unsupported"}' WHERE id=v_duty.id;
      CONTINUE;
    END IF;
    SELECT facts INTO v_facts FROM public.invoicing_fact_revisions WHERE duty_id=v_duty.id;
    IF NOT FOUND THEN CONTINUE; END IF;
    -- A crashed create may have crossed the remote boundary. Reclaims are readback only.
    v_duty.last_result:=jsonb_build_object('action',CASE WHEN v_duty.status IN ('processing','unknown') THEN 'readback' ELSE 'create' END);
    UPDATE public.invoicing_duties SET status='processing',generation=generation+1,claim_token=gen_random_uuid(),
      lease_until=now()+make_interval(secs=>least(greatest(coalesce(p_visibility,300),1),3600)),provider=coalesce(provider,p_provider),
      preflight_generation=NULL,last_result=v_duty.last_result WHERE id=v_duty.id RETURNING * INTO v_duty;
    UPDATE public.accounting_document_requests SET status='processing',attempts=v_duty.generation,claim_token=v_duty.claim_token,
      available_at='infinity',updated_at=now() WHERE id=v_request.id;
    v_rows:=v_rows || jsonb_build_array(to_jsonb(v_duty)||jsonb_build_object('facts',v_facts,'providerCreateIdentity','invoicing:'||v_duty.id::text));
  END LOOP;
  RETURN v_rows;
END;
$$;

CREATE FUNCTION public.invoicing_preflight_duty(p_duty uuid,p_token uuid,p_generation integer,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE; v_facts jsonb; v_result text;
BEGIN
  PERFORM 1 FROM public.accounting_document_requests WHERE id=(SELECT request_id FROM public.invoicing_duties WHERE id=p_duty) FOR UPDATE;
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty FOR UPDATE;
  IF NOT FOUND OR v_duty.status<>'processing' OR v_duty.claim_token IS DISTINCT FROM p_token OR v_duty.generation IS DISTINCT FROM p_generation OR v_duty.lease_until<=now()
    THEN RETURN jsonb_build_object('kind','stale'); END IF;
  SELECT facts INTO v_facts FROM public.invoicing_fact_revisions WHERE duty_id=p_duty;
  v_result:=CASE WHEN p_evidence->>'kind' IS DISTINCT FROM 'observed' THEN 'unavailable'
    WHEN p_evidence->>'currency' IS DISTINCT FROM v_facts->>'currency'
      OR (p_evidence->>'amountMinor')::numeric IS DISTINCT FROM (v_facts->>'totalGrossMinor')::numeric THEN 'mismatch'
    WHEN p_evidence->>'outcome' IS DISTINCT FROM 'captured' THEN 'blocked' ELSE 'ready' END;
  UPDATE public.invoicing_duties SET preflight_generation=CASE WHEN v_result='ready' THEN p_generation END,
    last_result=last_result || jsonb_build_object('preflight',v_result) WHERE id=p_duty;
  RETURN jsonb_build_object('kind',v_result);
END;
$$;

CREATE FUNCTION public.invoicing_finish_issue(p_duty uuid,p_token uuid,p_generation integer,p_external text,p_number text,p_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE; v_payload jsonb; v_prior jsonb;
BEGIN
  PERFORM 1 FROM public.accounting_document_requests WHERE id=(SELECT request_id FROM public.invoicing_duties WHERE id=p_duty) FOR UPDATE;
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoicing_duty_missing' USING ERRCODE='22023'; END IF;
  v_payload:=jsonb_build_object('externalId',p_external,'number',p_number,'proof',p_proof);
  SELECT payload INTO v_prior FROM public.invoicing_effect_receipts WHERE receipt_key='issue:'||p_duty::text;
  IF FOUND THEN
    IF v_prior->>'externalId' IS DISTINCT FROM p_external OR v_prior->>'number' IS DISTINCT FROM p_number THEN RAISE EXCEPTION 'invoicing_issue_identity_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('kind','issued','replayed',true);
  END IF;
  IF v_duty.parent_duty_id IS NOT NULL OR v_duty.status<>'processing' OR v_duty.claim_token IS DISTINCT FROM p_token
    OR v_duty.generation IS DISTINCT FROM p_generation OR v_duty.lease_until<=now()
  THEN RETURN jsonb_build_object('kind','stale'); END IF;
  IF nullif(btrim(p_external),'') IS NULL OR p_proof->>'kind' IS NULL OR p_proof->>'kind' NOT IN ('issued','readback_found')
    OR p_proof->>'externalId' IS DISTINCT FROM p_external
    OR p_proof->>'providerCreateIdentity' IS DISTINCT FROM 'invoicing:'||p_duty::text
    OR (p_proof->>'kind'='issued' AND (v_duty.preflight_generation IS DISTINCT FROM p_generation OR v_duty.last_result->>'action'<>'create'))
  THEN RAISE EXCEPTION 'invoicing_issue_proof_invalid' USING ERRCODE='22023'; END IF;
  PERFORM public.accounting_document_advance('invoicing:issue:'||p_duty::text,v_duty.document_id,'issued',p_external,jsonb_build_object('number',p_number));
  UPDATE public.accounting_document_requests SET status='succeeded',claim_token=NULL,error=NULL,updated_at=now() WHERE id=v_duty.request_id;
  UPDATE public.invoicing_duties SET status='issued',claim_token=NULL,lease_until=NULL,last_result=v_payload WHERE id=p_duty;
  INSERT INTO public.invoicing_effect_receipts(receipt_key,duty_id,payload) VALUES('issue:'||p_duty::text,p_duty,v_payload);
  -- Reversal requested while remote outcome was unknown: record identity FIRST,
  -- then compensate atomically. A local error rolls the entire finalization back.
  IF v_duty.reversal IS NOT NULL THEN
    PERFORM public.invoicing_request_reversal(v_duty.reversal->>'key',v_duty.order_id,v_duty.reversal->>'reason',v_duty.reversal->'evidence');
  END IF;
  RETURN jsonb_build_object('kind','issued','replayed',false);
END;
$$;

CREATE FUNCTION public.invoicing_fail_duty(p_duty uuid,p_token uuid,p_generation integer,p_kind text,p_evidence jsonb,p_delay integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_duty public.invoicing_duties%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.accounting_document_requests WHERE id=(SELECT request_id FROM public.invoicing_duties WHERE id=p_duty) FOR UPDATE;
  SELECT * INTO v_duty FROM public.invoicing_duties WHERE id=p_duty FOR UPDATE;
  IF NOT FOUND OR v_duty.status<>'processing' OR v_duty.claim_token IS DISTINCT FROM p_token OR v_duty.generation IS DISTINCT FROM p_generation OR v_duty.lease_until<=now()
    THEN RETURN jsonb_build_object('kind','stale'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('retryable','blocked','unsupported','unknown','absent') OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR (p_kind='retryable' AND p_evidence->>'phase' IS DISTINCT FROM 'before_send')
    OR (p_kind='absent' AND (p_evidence->>'kind' IS DISTINCT FROM 'authoritative_absence'
      OR p_evidence->>'providerCreateIdentity' IS DISTINCT FROM 'invoicing:'||p_duty::text))
  THEN RAISE EXCEPTION 'invoicing_failure_evidence_invalid' USING ERRCODE='22023'; END IF;
  IF v_duty.reversal IS NOT NULL AND (p_kind='absent'
    OR (p_kind='retryable' AND v_duty.last_result->>'action'='create')) THEN
    PERFORM public.accounting_document_advance('invoicing:void:'||v_duty.id::text,v_duty.document_id,'voided');
    UPDATE public.accounting_document_requests SET status='discarded',claim_token=NULL,updated_at=now(),
      available_at='infinity' WHERE id=v_duty.request_id;
    UPDATE public.invoicing_duties SET status='voided',claim_token=NULL,lease_until=NULL,
      last_result=jsonb_build_object('kind',p_kind,'evidence',p_evidence) WHERE id=p_duty;
    RETURN jsonb_build_object('kind','voided');
  END IF;
  UPDATE public.invoicing_duties SET status=CASE WHEN p_kind='retryable' AND v_duty.last_result->>'action'='readback' THEN 'unknown' WHEN p_kind IN ('retryable','absent') THEN 'ready' WHEN p_kind='unknown' THEN 'unknown' ELSE p_kind END,
    last_result=jsonb_build_object('kind',p_kind,'evidence',p_evidence),claim_token=NULL,lease_until=NULL,
    available_at=now()+make_interval(secs=>least(greatest(coalesce(p_delay,60),0),86400)) WHERE id=p_duty;
  UPDATE public.accounting_document_requests SET status='failed',claim_token=NULL,updated_at=now(),
    available_at='infinity' WHERE id=v_duty.request_id;
  RETURN jsonb_build_object('kind',p_kind);
END;
$$;

REVOKE ALL ON TABLE public.invoicing_duties FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.invoicing_fact_revisions FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.invoicing_effect_receipts FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.invoicing_due_sources FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_capture_duty(text,text,uuid,uuid,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_install_facts(uuid,jsonb,text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_sweep_duties(integer) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_claim_duties(integer,integer,text,uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_preflight_duty(uuid,uuid,integer,jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_finish_issue(uuid,uuid,integer,text,text,jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_fail_duty(uuid,uuid,integer,text,jsonb,integer) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_duty_readback(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.invoicing_cutover FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invoicing_capture_faults FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.invoicing_prepare_facts(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoicing_finish_facts(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
