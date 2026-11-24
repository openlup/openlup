CREATE OR REPLACE FUNCTION public.subscription_register_renewal_purchase(p_order_id uuid, p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_locked record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_locked FROM public.subscription_renewal_registration__lock(p_order_id);
  PERFORM public.subscription_register_renewal_purchase__validate(p_facts, v_locked.v_order, v_locked.v_activation);
  PERFORM public.subscription_renewal_registration__validate_lines(p_facts);
  v_result := public.subscription_register_renewal_purchase__store(p_order_id, p_facts, v_locked.v_activation);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_register_renewal_purchase_with_shipping(p_order_id uuid, p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_locked record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_locked FROM public.subscription_renewal_registration__lock(p_order_id);
  PERFORM public.subscription_register_renewal_purchase_with_shipping__validate(p_facts, v_locked.v_order, v_locked.v_activation);
  PERFORM public.subscription_renewal_registration__validate_lines(p_facts);
  p_facts := public.subscription_register_renewal_purchase_with_shipping__normalize(p_facts, v_locked.v_activation);
  v_result := public.subscription_register_renewal_purchase_with_shipping__store(p_order_id, p_facts, v_locked.v_activation);
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.subscription_renewal_registration__lock(p_order_id uuid)
RETURNS TABLE(v_order public.commerce_orders, v_activation public.subscription_activations)
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_renewal_purchase_order_missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_activation.state='compensated' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_not_declared' USING ERRCODE='22023'; END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.subscription_register_renewal_purchase__validate(p_facts jsonb, v_order public.commerce_orders, v_activation public.subscription_activations)
RETURNS void
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
BEGIN
  IF p_facts IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR p_facts - ARRAY['settlementChannelKey','authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef',
      'methodRef','methodEvidenceRef','stockSourceKey','templateId','cadenceDays','currency',
      'lines','shippingAmountMinor','acquisitionRef'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['settlementChannelKey','authorizationRef','methodRef','methodEvidenceRef','stockSourceKey','templateId'] LOOP
    IF jsonb_typeof(p_facts->v_key) IS DISTINCT FROM 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (p_facts->>'settlementChannelKey' IS DISTINCT FROM 'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_method_refs mr WHERE mr.client_id=v_order.client_id AND mr.provider_kind=p_facts->>'settlementChannelKey' AND mr.provider_method_ref=p_facts->>'methodRef' AND mr.id::text=p_facts->>'methodEvidenceRef' AND mr.active AND mr.status='active' AND (mr.expires_at IS NULL OR mr.expires_at>now()))) OR p_facts->>'stockSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_facts->>'currency' !~ '^[A-Z]{3}$' OR p_facts->>'currency' IS NULL
    OR NOT coalesce(p_facts->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
    OR jsonb_typeof(p_facts->'cadenceDays') IS DISTINCT FROM 'number'
    OR (p_facts->>'cadenceDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
    OR NOT coalesce(p_facts->>'shippingAmountMinor' ~ '^[0-9]+$',false)
    OR jsonb_typeof(p_facts->'shippingAmountMinor') IS DISTINCT FROM 'number'
    OR (p_facts->>'shippingAmountMinor')::numeric <> 0
    OR jsonb_typeof(p_facts->'unattendedChargeAuthorizedAt') IS DISTINCT FROM 'string'
    OR NOT isfinite((p_facts->>'unattendedChargeAuthorizedAt')::timestamptz)
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE FUNCTION public.subscription_register_renewal_purchase_with_shipping__validate(p_facts jsonb, v_order public.commerce_orders, v_activation public.subscription_activations)
RETURNS void
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
BEGIN
  IF p_facts IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR p_facts - ARRAY['settlementChannelKey','authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef',
      'methodRef','methodEvidenceRef','stockSourceKey','templateId','cadenceDays','currency',
      'lines','shippingAmountMinor','acquisitionRef','renewalTerms'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['settlementChannelKey','authorizationRef','methodRef','methodEvidenceRef','stockSourceKey','templateId'] LOOP
    IF jsonb_typeof(p_facts->v_key) IS DISTINCT FROM 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (p_facts->>'settlementChannelKey' IS DISTINCT FROM 'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_method_refs mr WHERE mr.client_id=v_order.client_id AND mr.provider_kind=p_facts->>'settlementChannelKey' AND mr.provider_method_ref=p_facts->>'methodRef' AND mr.id::text=p_facts->>'methodEvidenceRef' AND mr.active AND mr.status='active' AND (mr.expires_at IS NULL OR mr.expires_at>now()))) OR p_facts->>'stockSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_facts->>'currency' !~ '^[A-Z]{3}$' OR p_facts->>'currency' IS NULL
    OR NOT coalesce(p_facts->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
    OR jsonb_typeof(p_facts->'cadenceDays') IS DISTINCT FROM 'number'
    OR (p_facts->>'cadenceDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
    OR NOT coalesce(p_facts->>'shippingAmountMinor' ~ '^[0-9]+$',false)
    OR jsonb_typeof(p_facts->'shippingAmountMinor') IS DISTINCT FROM 'number'
    OR (p_facts->>'shippingAmountMinor')::numeric > 9007199254740991
    OR jsonb_typeof(p_facts->'unattendedChargeAuthorizedAt') IS DISTINCT FROM 'string'
    OR NOT isfinite((p_facts->>'unattendedChargeAuthorizedAt')::timestamptz)
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE FUNCTION public.subscription_renewal_registration__validate_lines(p_facts jsonb)
RETURNS void
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_line jsonb;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['payerAccountRef','acquisitionRef'] LOOP
    IF NOT (p_facts ? v_key) OR (p_facts->v_key <> 'null'::jsonb AND
      (jsonb_typeof(p_facts->v_key) <> 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180)) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(p_facts->'lines') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_facts->'lines') LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'] <> '{}'::jsonb
      OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
      OR NOT coalesce(v_line->>'lineOrdinal' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
      OR jsonb_typeof(v_line->'lineOrdinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number'
      OR (v_line->>'lineOrdinal')::numeric > 2147483647 OR (v_line->>'quantity')::numeric > 2147483647
      OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT count(DISTINCT (value->>'lineOrdinal')::integer) FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT sum((value->>'quantity')::numeric*(value->>'unitAmountMinor')::numeric) FROM jsonb_array_elements(p_facts->'lines')) NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE FUNCTION public.subscription_register_renewal_purchase_with_shipping__normalize(p_facts jsonb, v_activation public.subscription_activations)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_terms jsonb;
  v_shipping jsonb;
  v_marker jsonb;
  v_delivery jsonb;
  v_graduation jsonb;
  v_key text;
  v_line jsonb;
BEGIN
  IF p_facts ? 'renewalTerms' THEN
    v_terms:=p_facts->'renewalTerms';
    IF jsonb_typeof(v_terms) IS DISTINCT FROM 'object' OR v_terms->>'version' IS DISTINCT FROM 'native.renewal-terms.v1'
      OR v_terms - ARRAY['version','shippingTerms','starterPack','minimumPayableMinor','normalCadenceDays','linePricing'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    IF v_terms ? 'shippingTerms' THEN
      v_shipping:=v_terms->'shippingTerms';
      IF jsonb_typeof(v_shipping) IS DISTINCT FROM 'object' OR v_shipping->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
        OR v_shipping->>'currency' IS DISTINCT FROM p_facts->>'currency'
        OR v_shipping - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOREACH v_key IN ARRAY ARRAY['flatMinor','freeThresholdMinor'] LOOP
        IF jsonb_typeof(v_shipping->v_key) IS DISTINCT FROM 'number' OR NOT coalesce(v_shipping->>v_key ~ '^[0-9]+$',false)
          OR (v_shipping->>v_key)::numeric > 2147483647 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
    IF v_terms ? 'minimumPayableMinor' AND (jsonb_typeof(v_terms->'minimumPayableMinor') IS DISTINCT FROM 'number'
      OR NOT coalesce(v_terms->>'minimumPayableMinor' ~ '^[1-9][0-9]*$',false)
      OR (v_terms->>'minimumPayableMinor')::numeric > 9007199254740991) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    IF v_terms ? 'normalCadenceDays' THEN
      IF jsonb_typeof(v_terms->'normalCadenceDays') IS DISTINCT FROM 'array' OR jsonb_array_length(v_terms->'normalCadenceDays')=0 THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_terms->'normalCadenceDays') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'number' OR NOT coalesce(v_line#>>'{}' ~ '^[1-9][0-9]*$',false)
          OR (v_line#>>'{}')::numeric > 2147483647 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
    IF v_terms ? 'linePricing' THEN
      IF jsonb_typeof(v_terms->'linePricing') IS DISTINCT FROM 'array' OR jsonb_array_length(v_terms->'linePricing')>100 THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_terms->'linePricing') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['sku','quantity','unitAmountMinor','isAddon','quoteLine'] <> '{}'::jsonb
          OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
          OR jsonb_typeof(v_line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_line->'quoteLine') IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
          OR (v_line->>'quantity')::numeric > 2147483647
          OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
          OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(v_terms->'linePricing')) <> jsonb_array_length(v_terms->'linePricing') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    END IF;
    IF v_terms ? 'starterPack' THEN
      v_marker:=v_terms->'starterPack';
      IF jsonb_typeof(v_marker) IS DISTINCT FROM 'object' OR v_marker->>'schemaVersion' IS DISTINCT FROM '1'
        OR v_marker - ARRAY['schemaVersion','starterIntervalDays','basisTemplateVersion','delivery2','graduation'] <> '{}'::jsonb
        OR jsonb_typeof(v_marker->'starterIntervalDays') IS DISTINCT FROM 'number'
        OR NOT coalesce(v_marker->>'starterIntervalDays' ~ '^[1-9][0-9]*$',false)
        OR (v_marker->>'starterIntervalDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
        OR NOT (v_terms ? 'minimumPayableMinor') OR NOT (v_terms ? 'normalCadenceDays') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      v_delivery:=v_marker->'delivery2';
      IF jsonb_typeof(v_delivery) IS DISTINCT FROM 'object' OR v_delivery - ARRAY['discountBps','discountMinor','basisSubtotalMinor'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOREACH v_key IN ARRAY ARRAY['discountBps','discountMinor','basisSubtotalMinor'] LOOP
        IF jsonb_typeof(v_delivery->v_key) IS DISTINCT FROM 'number' OR NOT coalesce(v_delivery->>v_key ~ '^[0-9]+$',false)
          OR (v_delivery->>v_key)::numeric > 9007199254740991 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF (v_delivery->>'discountBps')::numeric > 10000
        OR (v_delivery->>'basisSubtotalMinor')::numeric-(v_delivery->>'discountMinor')::numeric < (v_terms->>'minimumPayableMinor')::numeric THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      v_graduation:=v_marker->'graduation';
      IF jsonb_typeof(v_graduation) IS DISTINCT FROM 'object' OR v_graduation - ARRAY['cadenceDays','lines','sizeConstraint'] <> '{}'::jsonb
        OR jsonb_typeof(v_graduation->'cadenceDays') IS DISTINCT FROM 'number'
        OR NOT coalesce(v_graduation->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
        OR NOT (v_terms->'normalCadenceDays' @> jsonb_build_array(v_graduation->'cadenceDays'))
        OR jsonb_typeof(v_graduation->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_graduation->'lines') NOT BETWEEN 1 AND 100
        OR (v_graduation ? 'sizeConstraint' AND jsonb_typeof(v_graduation->'sizeConstraint') IS DISTINCT FROM 'object') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_graduation->'lines') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['sku','qty','sortOrder','isAddon','quoteLine'] <> '{}'::jsonb
          OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
          OR jsonb_typeof(v_line->'qty') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'qty' ~ '^[1-9][0-9]*$',false)
          OR (v_line->>'qty')::numeric > 99
          OR jsonb_typeof(v_line->'sortOrder') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'sortOrder' ~ '^[0-9]+$',false)
          OR jsonb_typeof(v_line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_line->'quoteLine') IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_line#>'{quoteLine,unitPriceGross,amountMinor}') IS DISTINCT FROM 'number'
          OR NOT coalesce(v_line#>>'{quoteLine,unitPriceGross,amountMinor}' ~ '^[0-9]+$',false)
          OR (v_line#>>'{quoteLine,unitPriceGross,amountMinor}')::numeric > 9007199254740991
          OR jsonb_typeof(v_line#>'{quoteLine,lineSubtotalGross,amountMinor}') IS DISTINCT FROM 'number'
          OR (v_line#>>'{quoteLine,lineSubtotalGross,amountMinor}')::numeric IS DISTINCT FROM
             (v_line#>>'{quoteLine,unitPriceGross,amountMinor}')::numeric*(v_line->>'qty')::numeric THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      -- The activation writer always creates the acquisition template at version one.
      p_facts:=jsonb_set(p_facts,'{renewalTerms,starterPack,basisTemplateVersion}','1'::jsonb);
    END IF;
  ELSIF (p_facts->>'shippingAmountMinor')::numeric <> 0 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023';
  END IF;
  p_facts:=jsonb_set(p_facts,'{unattendedChargeAuthorizedAt}',to_jsonb(to_char(
    (p_facts->>'unattendedChargeAuthorizedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  RETURN p_facts;
END;
$$;

CREATE FUNCTION public.subscription_register_renewal_purchase__store(p_order_id uuid, p_facts jsonb, v_activation public.subscription_activations)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.subscription_renewal_attachments;
BEGIN
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND AND v_row.purchase_facts IS NOT NULL THEN
    IF v_row.purchase_facts IS DISTINCT FROM p_facts THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',p_order_id,'replayed',true);
  END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts)
    VALUES(p_order_id,v_activation.subscription_id,p_facts)
    ON CONFLICT(order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts;
  RETURN jsonb_build_object('orderId',p_order_id,'replayed',false);
END;
$$;

CREATE FUNCTION public.subscription_register_renewal_purchase_with_shipping__store(p_order_id uuid, p_facts jsonb, v_activation public.subscription_activations)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.subscription_renewal_attachments;
BEGIN
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND AND v_row.purchase_facts IS NOT NULL THEN
    IF jsonb_set(v_row.purchase_facts,'{unattendedChargeAuthorizedAt}',to_jsonb(to_char(
      (v_row.purchase_facts->>'unattendedChargeAuthorizedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) IS DISTINCT FROM p_facts THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',p_order_id,'replayed',true);
  END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts)
    VALUES(p_order_id,v_activation.subscription_id,p_facts)
    ON CONFLICT(order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts;
  RETURN jsonb_build_object('orderId',p_order_id,'replayed',false);
END;
$$;

REVOKE ALL ON FUNCTION
  public.subscription_renewal_registration__lock(uuid),
  public.subscription_register_renewal_purchase__validate(jsonb,public.commerce_orders,public.subscription_activations),
  public.subscription_register_renewal_purchase_with_shipping__validate(jsonb,public.commerce_orders,public.subscription_activations),
  public.subscription_renewal_registration__validate_lines(jsonb),
  public.subscription_register_renewal_purchase_with_shipping__normalize(jsonb,public.subscription_activations),
  public.subscription_register_renewal_purchase__store(uuid,jsonb,public.subscription_activations),
  public.subscription_register_renewal_purchase_with_shipping__store(uuid,jsonb,public.subscription_activations)
FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION
    public.subscription_renewal_registration__lock(uuid),
    public.subscription_register_renewal_purchase__validate(jsonb,public.commerce_orders,public.subscription_activations),
    public.subscription_register_renewal_purchase_with_shipping__validate(jsonb,public.commerce_orders,public.subscription_activations),
    public.subscription_renewal_registration__validate_lines(jsonb),
    public.subscription_register_renewal_purchase_with_shipping__normalize(jsonb,public.subscription_activations),
    public.subscription_register_renewal_purchase__store(uuid,jsonb,public.subscription_activations),
    public.subscription_register_renewal_purchase_with_shipping__store(uuid,jsonb,public.subscription_activations)
  FROM anon;';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION
    public.subscription_renewal_registration__lock(uuid),
    public.subscription_register_renewal_purchase__validate(jsonb,public.commerce_orders,public.subscription_activations),
    public.subscription_register_renewal_purchase_with_shipping__validate(jsonb,public.commerce_orders,public.subscription_activations),
    public.subscription_renewal_registration__validate_lines(jsonb),
    public.subscription_register_renewal_purchase_with_shipping__normalize(jsonb,public.subscription_activations),
    public.subscription_register_renewal_purchase__store(uuid,jsonb,public.subscription_activations),
    public.subscription_register_renewal_purchase_with_shipping__store(uuid,jsonb,public.subscription_activations)
  FROM authenticated;';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION
    public.subscription_renewal_registration__lock(uuid),
    public.subscription_register_renewal_purchase__validate(jsonb,public.commerce_orders,public.subscription_activations),
    public.subscription_register_renewal_purchase_with_shipping__validate(jsonb,public.commerce_orders,public.subscription_activations),
    public.subscription_renewal_registration__validate_lines(jsonb),
    public.subscription_register_renewal_purchase_with_shipping__normalize(jsonb,public.subscription_activations),
    public.subscription_register_renewal_purchase__store(uuid,jsonb,public.subscription_activations),
    public.subscription_register_renewal_purchase_with_shipping__store(uuid,jsonb,public.subscription_activations)
  FROM service_role;';
END IF; END; $$;
