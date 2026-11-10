-- Operator-only checkout issuance records intent before separate revoke/mint writes.
-- Customer/service issuers retain their independent coexistence behavior.
CREATE TABLE public.commerce_operator_link_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL,
  request_id uuid NOT NULL,
  order_id uuid NOT NULL,
  outcome text NOT NULL,
  completed_stage text NOT NULL,
  email_requested boolean NOT NULL,
  token_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT commerce_operator_link_receipts_request_outcome_key UNIQUE (request_id,outcome),
  CONSTRAINT commerce_operator_link_receipts_outcome_check CHECK (outcome IN ('admitted','succeeded','failed')),
  CONSTRAINT commerce_operator_link_receipts_stage_check CHECK (completed_stage IN ('none','revoked','minted','email_queued'))
);
CREATE INDEX commerce_operator_link_receipts_order_time_idx ON public.commerce_operator_link_receipts (order_id,occurred_at);
ALTER TABLE public.commerce_operator_link_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_operator_link_receipts FROM PUBLIC;

CREATE FUNCTION public.commerce_operator_link_receipt(
 p_operator_id uuid,p_request_id uuid,p_order_id uuid,p_outcome text,p_stage text,p_email_requested boolean,p_token_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result uuid;
BEGIN
 PERFORM public.communications_require_active_operator(p_operator_id);
 IF EXISTS(SELECT 1 FROM public.platform_control_operators WHERE principal_id=p_operator_id) THEN
  RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR p_order_id IS NULL OR p_email_requested IS NULL
  OR p_outcome IS NULL OR p_outcome NOT IN ('admitted','succeeded','failed')
  OR p_stage IS NULL OR p_stage NOT IN ('none','revoked','minted','email_queued') THEN
  RAISE EXCEPTION 'checkout_payment_link_receipt_invalid' USING ERRCODE='22023'; END IF;
 IF p_outcome<>'admitted' AND NOT EXISTS(SELECT 1 FROM public.commerce_operator_link_receipts
  WHERE request_id=p_request_id AND outcome='admitted' AND operator_id=p_operator_id AND order_id=p_order_id) THEN
  RAISE EXCEPTION 'checkout_payment_link_admission_required' USING ERRCODE='42501'; END IF;
 IF p_outcome='admitted' AND NOT EXISTS(SELECT 1 FROM public.commerce_orders
  WHERE id=p_order_id AND subscription_cycle_id IS NULL) THEN
  RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 INSERT INTO public.commerce_operator_link_receipts(operator_id,request_id,order_id,outcome,completed_stage,email_requested,token_id)
  VALUES(p_operator_id,p_request_id,p_order_id,p_outcome,p_stage,p_email_requested,p_token_id)
  ON CONFLICT(request_id,outcome) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN SELECT id INTO result FROM public.commerce_operator_link_receipts
  WHERE request_id=p_request_id AND outcome=p_outcome AND operator_id=p_operator_id AND order_id=p_order_id;
 END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'checkout_payment_link_receipt_conflict' USING ERRCODE='23505'; END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_operator_link_receipt(uuid,uuid,uuid,text,text,boolean,uuid) FROM PUBLIC;

CREATE FUNCTION public.commerce_operator_link_revoke(p_operator_id uuid,p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_order_id uuid;
BEGIN
 PERFORM public.communications_require_active_operator(p_operator_id);
 IF EXISTS(SELECT 1 FROM public.platform_control_operators WHERE principal_id=p_operator_id) THEN
  RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE='42501'; END IF;
 SELECT order_id INTO v_order_id FROM public.commerce_operator_link_receipts
  WHERE request_id=p_request_id AND outcome='admitted' AND operator_id=p_operator_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_payment_link_admission_required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=v_order_id AND subscription_cycle_id IS NULL) THEN
  RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=clock_timestamp()
  WHERE order_id=v_order_id AND revoked_at IS NULL;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_operator_link_revoke(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.commerce_operator_link_insert(
 p_operator_id uuid,p_request_id uuid,p_client_id uuid,p_hash text,p_expires_at timestamptz,p_now timestamptz
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_order_id uuid; result uuid; issued_at timestamptz;
BEGIN
 PERFORM public.communications_require_active_operator(p_operator_id);
 IF EXISTS(SELECT 1 FROM public.platform_control_operators WHERE principal_id=p_operator_id) THEN
  RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE='42501'; END IF;
 SELECT order_id INTO v_order_id FROM public.commerce_operator_link_receipts
  WHERE request_id=p_request_id AND outcome='admitted' AND operator_id=p_operator_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_payment_link_admission_required' USING ERRCODE='42501'; END IF;
 issued_at:=GREATEST(p_now,clock_timestamp());
 IF p_now IS NULL OR NOT isfinite(p_now) OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
  OR COALESCE(p_hash,'')!~'^[0-9a-f]{64}$'
  OR NOT EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=v_order_id AND client_id=p_client_id AND subscription_cycle_id IS NULL) THEN
  RAISE EXCEPTION 'checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 IF p_expires_at<=issued_at THEN
  RAISE EXCEPTION 'checkout_payment_link_deadline_elapsed' USING ERRCODE='22023'; END IF;
 INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at,created_at)
  VALUES(v_order_id,p_client_id,p_hash,p_expires_at,issued_at) RETURNING id INTO result;
 -- INSERT can wait for relation, index or foreign-key locks. Refuse against the
 -- current clock after those waits; the exception rolls back this entire insert.
 IF p_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'checkout_payment_link_deadline_elapsed' USING ERRCODE='22023'; END IF;
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_operator_link_insert(uuid,uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.commerce_operator_link_enqueue(p_operator_id uuid,p_request_id uuid,p_token_id uuid,p_raw_token text,p_mode text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE receipt public.commerce_operator_link_receipts%ROWTYPE; token public.commerce_checkout_recovery_tokens%ROWTYPE;
BEGIN
 PERFORM public.communications_require_active_operator(p_operator_id);
 IF EXISTS(SELECT 1 FROM public.platform_control_operators WHERE principal_id=p_operator_id) THEN
  RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE='42501'; END IF;
 SELECT * INTO receipt FROM public.commerce_operator_link_receipts
  WHERE request_id=p_request_id AND outcome='admitted' AND operator_id=p_operator_id AND email_requested;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_payment_link_admission_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO token FROM public.commerce_checkout_recovery_tokens WHERE id=p_token_id AND order_id=receipt.order_id
  AND token_hash=encode(sha256(convert_to(p_raw_token,'UTF8')),'hex');
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_payment_link_token_invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',receipt.order_id,'commerce.checkout_recovery','checkout_recovery:operator:'||token.id,
  jsonb_build_object('orderId',receipt.order_id,'recoveryToken',p_raw_token,'mode',p_mode,'operatorIssued',true,'expiresAt',token.expires_at),
  jsonb_build_object('source','admin_payment_link'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING;
END; $$;
REVOKE ALL ON FUNCTION public.commerce_operator_link_enqueue(uuid,uuid,uuid,text,text) FROM PUBLIC;

CREATE FUNCTION public.commerce_operator_link_delivery_authorize(p_event_id uuid,p_claim_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE event public.outbox_events%ROWTYPE; v_order public.commerce_orders%ROWTYPE;
BEGIN
 SELECT * INTO event FROM public.outbox_events WHERE id=p_event_id AND status='processing' AND metadata->>'claimToken'=p_claim_token;
 IF NOT FOUND THEN RETURN jsonb_build_object('authorized',false,'reason','claim_not_active'); END IF;
 IF event.event_type<>'commerce.checkout_recovery' OR event.idempotency_key NOT LIKE 'checkout_recovery:operator:%'
  OR COALESCE(event.payload->>'operatorIssued','false')<>'true' THEN
  RETURN jsonb_build_object('authorized',false,'reason','event_type_not_supported'); END IF;
 SELECT * INTO v_order FROM public.commerce_orders WHERE id=event.aggregate_id;
 IF NOT FOUND OR v_order.client_id IS NULL OR v_order.subscription_cycle_id IS NOT NULL
  OR v_order.status NOT IN ('pending_payment','expired','cancelled') THEN
  RETURN jsonb_build_object('authorized',false,'reason','order_not_recoverable'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_checkout_recovery_tokens t WHERE t.order_id=v_order.id AND t.client_id=v_order.client_id
  AND event.idempotency_key='checkout_recovery:operator:'||t.id AND t.token_hash=encode(sha256(convert_to(event.payload->>'recoveryToken','UTF8')),'hex')
  AND t.revoked_at IS NULL AND t.expires_at>now()) THEN
  RETURN jsonb_build_object('authorized',false,'reason','operator_checkout_recovery_link_not_live'); END IF;
 RETURN jsonb_build_object('authorized',true,'idempotencyKey','checkout-reminder:'||event.id,
  'recipientReference',v_order.client_id,'templateReference','commerce-checkout-recovery');
END; $$;
REVOKE ALL ON FUNCTION public.commerce_operator_link_delivery_authorize(uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_operator_link_receipt(uuid,uuid,uuid,text,text,boolean,uuid), public.commerce_operator_link_revoke(uuid,uuid), public.commerce_operator_link_insert(uuid,uuid,uuid,text,timestamptz,timestamptz), public.commerce_operator_link_enqueue(uuid,uuid,uuid,text,text), public.commerce_operator_link_delivery_authorize(uuid,text) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_operator_link_receipt(uuid,uuid,uuid,text,text,boolean,uuid), public.commerce_operator_link_revoke(uuid,uuid), public.commerce_operator_link_insert(uuid,uuid,uuid,text,timestamptz,timestamptz), public.commerce_operator_link_enqueue(uuid,uuid,uuid,text,text), public.commerce_operator_link_delivery_authorize(uuid,text) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_operator_link_receipt(uuid,uuid,uuid,text,text,boolean,uuid), public.commerce_operator_link_revoke(uuid,uuid), public.commerce_operator_link_insert(uuid,uuid,uuid,text,timestamptz,timestamptz), public.commerce_operator_link_enqueue(uuid,uuid,uuid,text,text), public.commerce_operator_link_delivery_authorize(uuid,text) FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_operator_link_receipt(uuid,uuid,uuid,text,text,boolean,uuid), public.commerce_operator_link_revoke(uuid,uuid), public.commerce_operator_link_insert(uuid,uuid,uuid,text,timestamptz,timestamptz), public.commerce_operator_link_enqueue(uuid,uuid,uuid,text,text), public.commerce_operator_link_delivery_authorize(uuid,text) TO service_role'; END IF; END; $$;
