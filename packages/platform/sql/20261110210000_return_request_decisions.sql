-- Owned return requests, canonical replay and decision intent events.
-- Historical SKU remains unrecorded; existing line identity is retained.
ALTER TABLE public.commerce_return_lines ADD COLUMN sku text;

CREATE FUNCTION public.commerce_return_request_create_owned(p_idempotency_key text,p_order_id uuid,p_lines jsonb,p_reason_code text,p_customer_note text,p_requested_by uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.commerce_orders%ROWTYPE;
  request public.commerce_return_requests%ROWTYPE;
  receipt public.commerce_return_operations%ROWTYPE;
  client uuid; v_line jsonb; v_item public.commerce_order_items%ROWTYPE;
  qty integer; normalized jsonb; fingerprint text; constraint_name text;
  command_key text := btrim(p_idempotency_key);
BEGIN
  IF p_idempotency_key IS NULL OR char_length(command_key)<8 OR p_order_id IS NULL
    OR p_requested_by IS NULL OR p_reason_code IS NULL
    OR p_reason_code NOT IN ('damaged','wrong_item','not_as_described','pet_refused','changed_mind','other') THEN
    RAISE EXCEPTION 'commerce_return_request_create_invalid_input' USING ERRCODE='22023';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' THEN
    RAISE EXCEPTION 'commerce_return_request_create_invalid_input' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_lines)=0 THEN
    RAISE EXCEPTION 'commerce_return_request_create_invalid_input' USING ERRCODE='22023';
  END IF;
  SELECT id INTO client FROM public.clients WHERE principal_id=p_requested_by;
  SELECT * INTO target FROM public.commerce_orders WHERE id=p_order_id AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023'; END IF;

  -- New receipts have action-scoped keys; historical native receipts keep their raw keys.
  SELECT * INTO receipt FROM public.commerce_return_operations
    WHERE operation_type='requested' AND ((idempotency_key=command_key||':requested' AND command_fingerprint LIKE 'canonical-v1:%')
      OR (idempotency_key=p_idempotency_key AND command_fingerprint NOT LIKE 'canonical-v1:%'));
  IF FOUND THEN
    SELECT * INTO request FROM public.commerce_return_requests WHERE id=receipt.return_request_id;
    IF request.order_id IS DISTINCT FROM p_order_id OR request.requested_by IS DISTINCT FROM client
      OR receipt.actor_id IS DISTINCT FROM p_requested_by THEN
      RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce-return-request:'||client::text||':'||command_key,0));
  SELECT * INTO receipt FROM public.commerce_return_operations
    WHERE operation_type='requested' AND ((idempotency_key=command_key||':requested' AND command_fingerprint LIKE 'canonical-v1:%')
      OR (idempotency_key=p_idempotency_key AND command_fingerprint NOT LIKE 'canonical-v1:%'));
  IF FOUND THEN
    SELECT * INTO request FROM public.commerce_return_requests WHERE id=receipt.return_request_id;
    IF request.order_id IS DISTINCT FROM p_order_id OR request.requested_by IS DISTINCT FROM client
      OR receipt.actor_id IS DISTINCT FROM p_requested_by THEN
      RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) line WHERE line->>'orderItemId' IS NOT NULL GROUP BY (line->>'orderItemId')::uuid HAVING count(*)>1) THEN
    RAISE EXCEPTION 'commerce_return_request_create_duplicate_line' USING ERRCODE='22023';
  END IF;
  IF receipt.id IS NOT NULL THEN
    IF receipt.command_fingerprint LIKE 'canonical-v1:%' THEN
      SELECT jsonb_agg(line ORDER BY line) INTO normalized FROM (
        SELECT jsonb_build_object('orderItemId',(value->>'orderItemId')::uuid,
          'quantity',NULLIF(value->>'quantity','')::integer,
          'sku',COALESCE(NULLIF(btrim(value->>'sku'),''),CASE WHEN target.renewal_operation_id IS NOT NULL
          THEN target.metadata#>>ARRAY['cycleSnapshot','lines',(COALESCE(item.source_line_ordinal,item.line_ordinal)-1)::text,'sku']
          ELSE target.metadata#>>ARRAY['orderDraftSnapshot','lines',(COALESCE(item.source_line_ordinal,item.line_ordinal)-1)::text,'sku'] END,'unknown'),
          'restockDisposition',COALESCE(NULLIF(btrim(value->>'restockDisposition'),''),'restock')) AS line
        FROM jsonb_array_elements(p_lines) LEFT JOIN public.commerce_order_items item
          ON item.id=(value->>'orderItemId')::uuid AND item.order_id=p_order_id) lines;
      fingerprint := 'canonical-v1:'||encode(sha256(convert_to(jsonb_build_object('orderId',p_order_id,
        'requestedBy',p_requested_by,'reasonCode',p_reason_code,'customerNote',NULLIF(btrim(COALESCE(p_customer_note,'')),''),
        'lines',normalized)::text,'UTF8')),'hex');
    ELSE
      -- Old rows never recorded SKU. Compare the stored raw command fingerprint,
      -- without reconstructing information or rewriting a historical receipt.
      fingerprint := encode(sha256(convert_to(concat_ws('|',p_order_id::text,p_requested_by::text,
        p_reason_code,p_lines::text,COALESCE(p_customer_note,'')),'UTF8')),'hex');
    END IF;
    IF fingerprint IS DISTINCT FROM receipt.command_fingerprint THEN
      RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('returnRequestId',request.id,'status',request.status,'replayed',true);
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce-return-request-key:'||command_key,0)) THEN
    RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
  END IF;
  IF target.status NOT IN ('paid','fulfilled') THEN
    RAISE EXCEPTION 'commerce_return_request_create_order_not_returnable' USING ERRCODE='22023';
  END IF;
  -- Validate all lines before inserting a request or its lines.
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    qty := NULLIF(v_line->>'quantity','')::integer;
    IF qty IS NULL OR qty<=0 OR v_line->>'orderItemId' IS NULL THEN
      RAISE EXCEPTION 'commerce_return_request_create_invalid_input' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_item FROM public.commerce_order_items WHERE id=(v_line->>'orderItemId')::uuid AND order_id=p_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'commerce_return_request_create_line_not_in_order' USING ERRCODE='22023'; END IF;
    IF qty>v_item.quantity THEN RAISE EXCEPTION 'commerce_return_request_create_quantity_exceeds_ordered' USING ERRCODE='22023'; END IF;
  END LOOP;
  BEGIN
    INSERT INTO public.commerce_return_requests(order_id,requested_by,reason_code,customer_note)
      VALUES(p_order_id,client,p_reason_code,NULLIF(btrim(COALESCE(p_customer_note,'')),'')) RETURNING * INTO request;
    INSERT INTO public.commerce_return_lines(return_request_id,order_item_id,quantity,restock_disposition,sku)
      SELECT request.id,item.id,(value->>'quantity')::integer,
        COALESCE(NULLIF(btrim(value->>'restockDisposition'),''),'restock'),
        COALESCE(NULLIF(btrim(value->>'sku'),''),CASE WHEN target.renewal_operation_id IS NOT NULL
          THEN target.metadata#>>ARRAY['cycleSnapshot','lines',(COALESCE(item.source_line_ordinal,item.line_ordinal)-1)::text,'sku']
          ELSE target.metadata#>>ARRAY['orderDraftSnapshot','lines',(COALESCE(item.source_line_ordinal,item.line_ordinal)-1)::text,'sku'] END,'unknown')
      FROM jsonb_array_elements(p_lines) JOIN public.commerce_order_items item
        ON item.id=(value->>'orderItemId')::uuid AND item.order_id=p_order_id;
    SELECT jsonb_agg(line ORDER BY line) INTO normalized FROM (
      SELECT jsonb_build_object('orderItemId',order_item_id,'quantity',quantity,'sku',sku,'restockDisposition',restock_disposition) AS line
      FROM public.commerce_return_lines WHERE return_request_id=request.id) lines;
    fingerprint := 'canonical-v1:'||encode(sha256(convert_to(jsonb_build_object('orderId',p_order_id,
      'requestedBy',p_requested_by,'reasonCode',p_reason_code,'customerNote',request.customer_note,'lines',normalized)::text,'UTF8')),'hex');
    INSERT INTO public.commerce_return_operations(return_request_id,operation_type,idempotency_key,command_fingerprint,actor_id)
      VALUES(request.id,'requested',command_key||':requested',fingerprint,p_requested_by);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS constraint_name = CONSTRAINT_NAME;
    IF constraint_name='commerce_return_operations_idempotency_key_key' THEN
      RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
    END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('returnRequestId',request.id,'status',request.status,'replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_return_request_create(
  p_idempotency_key text,
  p_order_id uuid,
  p_lines jsonb,
  p_reason_code text,
  p_customer_note text,
  p_requested_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.commerce_return_request_create_owned(p_idempotency_key,p_order_id,p_lines,p_reason_code,p_customer_note,p_requested_by);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_return_approve(
  p_idempotency_key text,
  p_return_request_id uuid,
  p_approved_by uuid,
  p_refund_mode text,
  p_refund_amount_cents bigint,
  p_admin_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  request public.commerce_return_requests%ROWTYPE;
  command_key text := btrim(p_idempotency_key)||':approved';
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key))<8 OR p_return_request_id IS NULL OR p_approved_by IS NULL
    OR p_refund_mode IS NULL OR p_refund_mode NOT IN ('full','partial','none') OR (p_refund_mode='partial' AND (p_refund_amount_cents IS NULL OR p_refund_amount_cents<0)) THEN
    RAISE EXCEPTION 'commerce_return_approve_invalid_input' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_operators WHERE id=p_approved_by) THEN
    RAISE EXCEPTION 'commerce_return_approve_actor_unknown' USING ERRCODE='23503';
  END IF;
  SELECT * INTO request FROM public.commerce_return_requests WHERE id=p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_return_approve_not_found' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_return_operations WHERE idempotency_key=command_key
    OR (idempotency_key=p_idempotency_key AND operation_type='approved' AND command_fingerprint NOT LIKE 'canonical-v1:%')) THEN
    RETURN jsonb_build_object('returnRequestId',request.id,'status',request.status,'replayed',true);
  END IF;
  IF request.status<>'requested' THEN RAISE EXCEPTION 'commerce_return_approve_invalid_state' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_return_requests SET status='approved',
    refund_mode=p_refund_mode, refund_amount_minor=CASE WHEN p_refund_mode='partial' THEN p_refund_amount_cents ELSE refund_amount_minor END,
    admin_note=COALESCE(NULLIF(btrim(COALESCE(p_admin_note,'')),''),admin_note),decided_by=p_approved_by,updated_at=now()
    WHERE id=p_return_request_id;
  INSERT INTO public.commerce_return_operations(return_request_id,operation_type,idempotency_key,command_fingerprint,actor_id)
    VALUES(p_return_request_id,'approved',command_key,'canonical-v1:decision',p_approved_by);
  RETURN jsonb_build_object('returnRequestId',p_return_request_id,'status','approved','replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_return_reject(
  p_idempotency_key text,
  p_return_request_id uuid,
  p_approved_by uuid,
  p_admin_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  request public.commerce_return_requests%ROWTYPE;
  command_key text := btrim(p_idempotency_key)||':rejected';
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key))<8 OR p_return_request_id IS NULL OR p_approved_by IS NULL
     THEN
    RAISE EXCEPTION 'commerce_return_reject_invalid_input' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_operators WHERE id=p_approved_by) THEN
    RAISE EXCEPTION 'commerce_return_reject_actor_unknown' USING ERRCODE='23503';
  END IF;
  SELECT * INTO request FROM public.commerce_return_requests WHERE id=p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_return_reject_not_found' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_return_operations WHERE idempotency_key=command_key
    OR (idempotency_key=p_idempotency_key AND operation_type='rejected' AND command_fingerprint NOT LIKE 'canonical-v1:%')) THEN
    RETURN jsonb_build_object('returnRequestId',request.id,'status',request.status,'replayed',true);
  END IF;
  IF request.status<>'requested' THEN RAISE EXCEPTION 'commerce_return_reject_invalid_state' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_return_requests SET status='rejected',
    
    admin_note=COALESCE(NULLIF(btrim(COALESCE(p_admin_note,'')),''),admin_note),decided_by=p_approved_by,updated_at=now()
    WHERE id=p_return_request_id;
  INSERT INTO public.commerce_return_operations(return_request_id,operation_type,idempotency_key,command_fingerprint,actor_id)
    VALUES(p_return_request_id,'rejected',command_key,'canonical-v1:decision',p_approved_by);
  RETURN jsonb_build_object('returnRequestId',p_return_request_id,'status','rejected','replayed',false);
END;
$$;

CREATE FUNCTION public.commerce_emit_return_outbox() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.status NOT IN ('approved','rejected') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES('commerce_return',NEW.id,'commerce.return.'||NEW.status,'return_'||NEW.status||':'||NEW.id::text,
      jsonb_build_object('returnRequestId',NEW.id,'orderUuid',NEW.order_id,'orderId','order_'||NEW.order_id::text,
        'status',NEW.status,'refundMode',NEW.refund_mode,'refundAmountCents',NEW.refund_amount_minor,'occurredAt',now()),
      jsonb_build_object('source','commerce_emit_return_outbox'))
    ON CONFLICT(event_type,idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_emit_return_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid), public.commerce_emit_return_outbox() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid), public.commerce_emit_return_outbox() FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid), public.commerce_emit_return_outbox() FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid) TO service_role'; END IF; END; $$;

CREATE TRIGGER trg_commerce_return_decision_outbox AFTER INSERT OR UPDATE OF status ON public.commerce_return_requests FOR EACH ROW EXECUTE FUNCTION public.commerce_emit_return_outbox();
