CREATE FUNCTION public.commerce_checkout_recovery_attempt_begin(p_request_key text,p_order_id uuid,p_client_id uuid,p_intent_id uuid,p_fingerprint text,p_method_facts jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.commerce_orders%ROWTYPE; i public.commerce_settlement_intents%ROWTYPE;
 t public.commerce_checkout_recovery_tokens%ROWTYPE;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_method_facts IS NULL
  OR jsonb_typeof(p_method_facts)<>'object' THEN
  RAISE EXCEPTION 'checkout_recovery_input_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.client_id IS DISTINCT FROM p_client_id OR o.subscription_cycle_id IS NOT NULL THEN
  RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id AND order_id=o.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 IF i.channel_key<>'sandbox' THEN
  RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 SELECT * INTO t FROM public.commerce_checkout_recovery_tokens token
  WHERE token.id=(p_method_facts->>'recoveryTokenId')::uuid AND token.client_id=p_client_id
   AND (token.order_id=o.id OR EXISTS(SELECT 1 FROM public.commerce_orders original
    WHERE original.id=token.order_id AND original.client_id=p_client_id
     AND original.subscription_cycle_id IS NULL
     AND COALESCE(o.recovery_root_order_id,o.id)=COALESCE(original.recovery_root_order_id,original.id))) FOR UPDATE;
 IF NOT FOUND OR t.revoked_at IS NOT NULL OR t.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'checkout_recovery_authority_invalid' USING ERRCODE='22023'; END IF;
 IF o.status<>'pending_payment' OR o.metadata->>'paymentStatus'='expired'
  OR o.metadata->>'source'='checkout_reservation_expiry'
  OR i.status='settled' THEN
  RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a
   JOIN public.payment_simulator_observations e ON e.attempt_id=a.id
   WHERE a.settlement_intent_id=i.id AND e.outcome='captured') THEN
  RAISE EXCEPTION 'checkout_recovery_attempt_in_flight' USING ERRCODE='22023'; END IF;
 IF i.amount_minor IS DISTINCT FROM o.total_amount_minor OR i.currency_code IS DISTINCT FROM o.currency_code
  OR NOT EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id)
  OR jsonb_typeof(o.metadata->'quoteSnapshot') IS DISTINCT FROM 'object'
  OR jsonb_typeof(o.metadata->'orderDraftSnapshot') IS DISTINCT FROM 'object'
  OR NOT (EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id
    AND a.client_id=o.client_id AND a.state='provisional' AND a.subscription_id IS NULL
    AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='subscription')
    OR (NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id)
     AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='one_time')) THEN
  RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 RETURN public.payment_simulator_begin_attempt(p_request_key,p_intent_id,p_fingerprint,p_method_facts->'methodFacts',p_at);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz) FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz) TO service_role'; END IF; END; $$;
