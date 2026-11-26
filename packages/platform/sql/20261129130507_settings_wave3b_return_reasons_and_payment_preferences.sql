-- Stage 5 Wave 3B-1: validate and read installed policies for commerce return
-- reasons (E2) and shipping payment method preferences (E3), replacing closed
-- table CHECK enums with anchored format CHECKs guarded by write functions.

ALTER TABLE public.commerce_return_requests DROP CONSTRAINT commerce_return_requests_reason_check;
ALTER TABLE public.commerce_return_requests ADD CONSTRAINT commerce_return_requests_reason_check CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,63}$');

ALTER TABLE public.customer_payment_preferences DROP CONSTRAINT customer_payment_preferences_method_kind_check;
ALTER TABLE public.customer_payment_preferences ADD CONSTRAINT customer_payment_preferences_method_kind_check CHECK (method_kind ~ '^[a-z][a-z0-9_]{1,63}$');

CREATE FUNCTION public.commerce_return_reasons_validate(p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_len integer;
  v_valid_count integer;
  v_distinct_count integer;
  v_reasons text[];
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'commerce_return_reasons_policy_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_policy ?& ARRAY['revision', 'reasons'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('revision', 'reasons'))
    OR jsonb_typeof(p_policy->'revision') IS DISTINCT FROM 'string'
    OR btrim(p_policy->>'revision', E' \t\n\r\f\u000b\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') = ''
    OR jsonb_typeof(p_policy->'reasons') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'commerce_return_reasons_policy_invalid' USING ERRCODE = '22023';
  END IF;
  v_len := jsonb_array_length(p_policy->'reasons');
  IF v_len < 1 OR v_len > 64 THEN
    RAISE EXCEPTION 'commerce_return_reasons_policy_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT
    count(*) FILTER (WHERE jsonb_typeof(elem) = 'string' AND (elem #>> '{}') ~ '^[a-z][a-z0-9_]{1,63}$'),
    count(DISTINCT (elem #>> '{}')) FILTER (WHERE jsonb_typeof(elem) = 'string'),
    array_agg(elem #>> '{}' ORDER BY ord)
  INTO v_valid_count, v_distinct_count, v_reasons
  FROM jsonb_array_elements(p_policy->'reasons') WITH ORDINALITY AS t(elem, ord);
  IF v_valid_count <> v_len OR v_distinct_count <> v_len THEN
    RAISE EXCEPTION 'commerce_return_reasons_policy_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('revision', p_policy->>'revision', 'reasons', to_jsonb(v_reasons));
END;
$$;

CREATE FUNCTION public.commerce_return_reasons_read()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw_policy text;
  v_validated jsonb;
BEGIN
  SELECT value_text INTO v_raw_policy
  FROM public.commerce_settings
  WHERE key = 'commerce_return_reasons';
  IF NOT FOUND THEN
    RETURN ARRAY['damaged', 'wrong_item', 'not_as_described', 'pet_refused', 'changed_mind', 'other'];
  END IF;
  BEGIN
    v_validated := public.commerce_return_reasons_validate(v_raw_policy::jsonb);
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'commerce_return_reasons_policy_invalid' USING ERRCODE = '22023';
  END;
  RETURN ARRAY(SELECT jsonb_array_elements_text(v_validated->'reasons'));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_return_request_create_owned(p_idempotency_key text,p_order_id uuid,p_lines jsonb,p_reason_code text,p_customer_note text,p_requested_by uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.commerce_orders%ROWTYPE;
  request public.commerce_return_requests%ROWTYPE;
  receipt public.commerce_return_operations%ROWTYPE;
  client uuid; v_line jsonb; v_item public.commerce_order_items%ROWTYPE;
  qty integer; normalized jsonb; fingerprint text; legacy_fingerprint text; constraint_name text;
  candidate_count integer := 0; match_count integer := 0; matched_request_id uuid;
  command_key text := btrim(p_idempotency_key);
  v_allowed_reasons text[];
BEGIN
  IF p_idempotency_key IS NULL OR char_length(command_key)<8 OR p_order_id IS NULL
    OR p_requested_by IS NULL OR p_reason_code IS NULL
    OR p_reason_code !~ '^[a-z][a-z0-9_]{1,63}$' THEN
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

  -- Resolve every known-version alias; never select an arbitrary receipt.
  IF EXISTS(SELECT 1 FROM public.commerce_return_operations op
    JOIN public.commerce_return_requests r ON r.id=op.return_request_id WHERE op.operation_type='requested' AND (
        (op.idempotency_key=command_key||':requested' AND op.command_fingerprint ~ '^canonical-v1:[0-9a-f]{64}$')
        OR (btrim(op.idempotency_key)=command_key AND op.command_fingerprint ~ '^[0-9a-f]{64}$'))
      AND (r.order_id IS DISTINCT FROM p_order_id OR r.requested_by IS DISTINCT FROM client
        OR op.actor_id IS DISTINCT FROM p_requested_by)) THEN
    RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce-return-request:'||client::text||':'||command_key,0));
  IF EXISTS(SELECT 1 FROM public.commerce_return_operations op
    JOIN public.commerce_return_requests r ON r.id=op.return_request_id WHERE op.operation_type='requested' AND (
        (op.idempotency_key=command_key||':requested' AND op.command_fingerprint ~ '^canonical-v1:[0-9a-f]{64}$')
        OR (btrim(op.idempotency_key)=command_key AND op.command_fingerprint ~ '^[0-9a-f]{64}$'))
      AND (r.order_id IS DISTINCT FROM p_order_id OR r.requested_by IS DISTINCT FROM client
        OR op.actor_id IS DISTINCT FROM p_requested_by)) THEN
    RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) line WHERE line->>'orderItemId' IS NOT NULL GROUP BY (line->>'orderItemId')::uuid HAVING count(*)>1) THEN
    RAISE EXCEPTION 'commerce_return_request_create_duplicate_line' USING ERRCODE='22023';
  END IF;
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
  legacy_fingerprint := encode(sha256(convert_to(concat_ws('|',p_order_id::text,p_requested_by::text,
        p_reason_code,p_lines::text,COALESCE(p_customer_note,'')),'UTF8')),'hex');
  FOR receipt IN SELECT op.* FROM public.commerce_return_operations op WHERE op.operation_type='requested' AND (
        (op.idempotency_key=command_key||':requested' AND op.command_fingerprint ~ '^canonical-v1:[0-9a-f]{64}$')
        OR (btrim(op.idempotency_key)=command_key AND op.command_fingerprint ~ '^[0-9a-f]{64}$')) LOOP
    candidate_count := candidate_count+1;
    IF receipt.command_fingerprint=(CASE WHEN receipt.command_fingerprint ~ '^canonical-v1:[0-9a-f]{64}$'
      THEN fingerprint ELSE legacy_fingerprint END) THEN
      match_count := match_count+1;
      matched_request_id := receipt.return_request_id;
    END IF;
  END LOOP;
  IF candidate_count>0 THEN
    IF match_count<>1 THEN
      RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
    END IF;
    SELECT * INTO request FROM public.commerce_return_requests WHERE id=matched_request_id;
    RETURN jsonb_build_object('returnRequestId',request.id,'status',request.status,'replayed',true);
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('commerce-return-request-key:'||command_key,0)) THEN
    RAISE EXCEPTION 'commerce_return_request_create_order_not_found' USING ERRCODE='22023';
  END IF;
  v_allowed_reasons := public.commerce_return_reasons_read();
  IF NOT (p_reason_code = ANY(v_allowed_reasons)) THEN
    RAISE EXCEPTION 'commerce_return_request_create_invalid_input' USING ERRCODE='22023';
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

CREATE FUNCTION public.shipping_payment_method_preferences_validate(p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_len integer;
  v_valid_count integer;
  v_distinct_count integer;
  v_methods text[];
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'shipping_payment_method_preferences_policy_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_policy ?& ARRAY['revision', 'methodKinds'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('revision', 'methodKinds'))
    OR jsonb_typeof(p_policy->'revision') IS DISTINCT FROM 'string'
    OR btrim(p_policy->>'revision', E' \t\n\r\f\u000b\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') = ''
    OR jsonb_typeof(p_policy->'methodKinds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'shipping_payment_method_preferences_policy_invalid' USING ERRCODE = '22023';
  END IF;
  v_len := jsonb_array_length(p_policy->'methodKinds');
  IF v_len < 1 OR v_len > 32 THEN
    RAISE EXCEPTION 'shipping_payment_method_preferences_policy_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT
    count(*) FILTER (WHERE jsonb_typeof(elem) = 'string' AND (elem #>> '{}') ~ '^[a-z][a-z0-9_]{1,63}$'),
    count(DISTINCT (elem #>> '{}')) FILTER (WHERE jsonb_typeof(elem) = 'string'),
    array_agg(elem #>> '{}' ORDER BY ord)
  INTO v_valid_count, v_distinct_count, v_methods
  FROM jsonb_array_elements(p_policy->'methodKinds') WITH ORDINALITY AS t(elem, ord);
  IF v_valid_count <> v_len OR v_distinct_count <> v_len THEN
    RAISE EXCEPTION 'shipping_payment_method_preferences_policy_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('revision', p_policy->>'revision', 'methodKinds', to_jsonb(v_methods));
END;
$$;

CREATE FUNCTION public.shipping_payment_method_preferences_read()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw_policy text;
  v_validated jsonb;
BEGIN
  SELECT value_text INTO v_raw_policy
  FROM public.commerce_settings
  WHERE key = 'shipping_payment_method_preferences';
  IF NOT FOUND THEN
    RETURN ARRAY['instant', 'card', 'transfer'];
  END IF;
  BEGIN
    v_validated := public.shipping_payment_method_preferences_validate(v_raw_policy::jsonb);
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'shipping_payment_method_preferences_policy_invalid' USING ERRCODE = '22023';
  END;
  RETURN ARRAY(SELECT jsonb_array_elements_text(v_validated->'methodKinds'));
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_preference_save(p_actor uuid,p_client uuid,p_kind text,p_data jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  answer jsonb;
  v_method_kind text;
  v_allowed_methods text[];
BEGIN
  IF p_kind='payment' THEN LOCK TABLE public.customer_payment_preferences IN ROW EXCLUSIVE MODE;
  ELSIF p_kind='delivery' THEN LOCK TABLE public.customer_delivery_preferences IN ROW EXCLUSIVE MODE;
  ELSE RAISE EXCEPTION 'customer_preference_invalid_kind' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
  IF p_kind='payment' THEN
    v_method_kind := p_data->>'methodKind';
    v_allowed_methods := public.shipping_payment_method_preferences_read();
    IF v_method_kind IS NULL OR NOT (v_method_kind = ANY(v_allowed_methods)) THEN
      RAISE EXCEPTION 'customer_preference_invalid_payment_method' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.customer_payment_preferences(client_id,scope,method_kind,last_selected_at,updated_at)
    VALUES(p_client,p_data->>'scope',v_method_kind,p_now,p_now)
    ON CONFLICT(client_id,scope) DO UPDATE SET method_kind=EXCLUDED.method_kind,last_selected_at=p_now,updated_at=p_now
    RETURNING to_jsonb(customer_payment_preferences.*) INTO answer;
  ELSE
    INSERT INTO public.customer_delivery_preferences(client_id,scope,delivery_kind,provider_kind,provider_ref,carrier_kind,carrier_code,service_code,pickup_point_id,pickup_point_name,pickup_point_address,last_selected_at,updated_at)
    VALUES(p_client,p_data->>'scope',p_data->>'deliveryKind',p_data->>'providerFamily',p_data->>'providerKind',p_data->>'carrierKind',p_data->>'carrierCode',p_data->>'serviceCode',p_data#>>'{pickupPoint,id}',p_data#>>'{pickupPoint,name}',nullif(p_data#>'{pickupPoint,address}','null'::jsonb),p_now,p_now)
    ON CONFLICT(client_id,scope) DO UPDATE SET delivery_kind=EXCLUDED.delivery_kind,provider_kind=EXCLUDED.provider_kind,provider_ref=EXCLUDED.provider_ref,
      carrier_kind=EXCLUDED.carrier_kind,carrier_code=EXCLUDED.carrier_code,service_code=EXCLUDED.service_code,pickup_point_id=EXCLUDED.pickup_point_id,
      pickup_point_name=EXCLUDED.pickup_point_name,pickup_point_address=EXCLUDED.pickup_point_address,last_selected_at=p_now,updated_at=p_now
    RETURNING to_jsonb(customer_delivery_preferences.*) INTO answer;
  END IF;
  RETURN answer;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_return_reasons_validate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_return_reasons_read() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shipping_payment_method_preferences_validate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shipping_payment_method_preferences_read() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_return_reasons_validate(jsonb), public.commerce_return_reasons_read(), public.shipping_payment_method_preferences_validate(jsonb), public.shipping_payment_method_preferences_read() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_return_reasons_validate(jsonb), public.commerce_return_reasons_read(), public.shipping_payment_method_preferences_validate(jsonb), public.shipping_payment_method_preferences_read() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_return_reasons_validate(jsonb), public.commerce_return_reasons_read(), public.shipping_payment_method_preferences_validate(jsonb), public.shipping_payment_method_preferences_read() TO service_role;'; END IF; END; $$;
