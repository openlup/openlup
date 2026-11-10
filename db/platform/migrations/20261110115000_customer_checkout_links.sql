-- Customer recovery start and buyer-requested checkout mail.
-- Replacement headers and actor ACLs are retained; new readers/writers have closed EXECUTE grants.
CREATE FUNCTION public.customer_checkout_recovery_context_as_actor(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('orderId',o.id,'mode',CASE WHEN o.id IS NULL THEN NULL
   WHEN o.subscription_cycle_id IS NOT NULL OR a.id IS NOT NULL
    OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
   THEN 'subscription_cycle' ELSE 'one_time_order' END,
  'subscriptionId',COALESCE(cy.subscription_id,a.subscription_id,a.id),
  'clientHasLiveOrPendingSubscription',EXISTS(SELECT 1 FROM public.clients c WHERE c.principal_id=auth.uid() AND
   (EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.client_id=c.id AND s.status IN ('active','paused'))
    OR EXISTS(SELECT 1 FROM public.subscription_activations p WHERE p.client_id=c.id AND p.state='provisional'))))
 FROM (SELECT 1) seed LEFT JOIN
  (public.commerce_orders o JOIN public.clients c ON c.id=o.client_id AND c.principal_id=auth.uid()) ON o.id=p_order_id
 LEFT JOIN public.subscription_cycles cy ON cy.id=o.subscription_cycle_id
 LEFT JOIN public.subscription_activations a ON a.order_id=o.id;
$$;
REVOKE ALL ON FUNCTION public.customer_checkout_recovery_context_as_actor(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.customer_checkout_recovery_token_issue_as_actor(
  p_order_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
DECLARE
  v_client_id uuid;
  v_token_id uuid;
  issued_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_now IS NULL OR p_expires_at IS NULL OR NOT isfinite(p_now) OR NOT isfinite(p_expires_at) OR p_expires_at > p_now + interval '24 hours' THEN
    RAISE EXCEPTION 'customer_checkout_recovery_invalid_input' USING ERRCODE = '22023';
  END IF;
  SELECT o.client_id INTO v_client_id FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
   WHERE o.id=p_order_id AND o.status='pending_payment' AND o.subscription_cycle_id IS NULL AND c.principal_id=auth.uid()
    AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional')
   FOR UPDATE OF o,c;
  IF NOT FOUND OR v_client_id IS NULL THEN
    RAISE EXCEPTION 'customer_checkout_recovery_order_not_recoverable' USING ERRCODE = '22023';
  END IF;
  issued_at := clock_timestamp();
  IF p_expires_at<=issued_at THEN
    RAISE EXCEPTION 'customer_checkout_recovery_order_not_recoverable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at,created_at)
   VALUES(p_order_id,v_client_id,p_token_hash,p_expires_at,issued_at) RETURNING id INTO v_token_id;
  -- INSERT can wait on relation, foreign-key or unique locks after the row locks above.
  IF p_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'customer_checkout_recovery_order_not_recoverable' USING ERRCODE = '22023';
  END IF;
  RETURN v_token_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_checkout_recovery_find_as_actor(
  p_order_id uuid DEFAULT NULL,
  p_subscription_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
 SELECT public.customer_checkout_recovery_context_as_actor(o.id)||jsonb_build_object('createdAt',o.created_at)
 FROM public.commerce_orders o JOIN public.clients c ON c.id=o.client_id
 LEFT JOIN public.subscription_activations a ON a.order_id=o.id
 WHERE c.principal_id=auth.uid() AND o.status='pending_payment' AND o.subscription_cycle_id IS NULL
  AND (a.id IS NULL OR a.state='provisional')
  AND ((p_order_id IS NOT NULL AND o.id=p_order_id) OR
   (p_order_id IS NULL AND p_subscription_id IS NOT NULL AND (a.id=p_subscription_id OR a.subscription_id=p_subscription_id)))
 ORDER BY o.created_at DESC,o.id DESC LIMIT 1;
$$;

CREATE FUNCTION public.commerce_buyer_checkout_link_issue(p_order_id uuid,p_client_id uuid,p_raw_token text,p_lifetime_ms bigint,p_bucket_ms bigint,p_requested_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.commerce_orders%ROWTYPE; event_id uuid; deadline timestamptz; issued_at timestamptz; mode text;
BEGIN
 IF p_raw_token IS NULL OR length(p_raw_token) NOT BETWEEN 1 AND 512 OR p_lifetime_ms IS NULL OR p_lifetime_ms NOT BETWEEN 1 AND 86400000
  OR p_bucket_ms IS NULL OR p_bucket_ms<1 OR p_requested_at IS NULL OR NOT isfinite(p_requested_at) THEN
  RAISE EXCEPTION 'buyer_checkout_recovery_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.client_id IS DISTINCT FROM p_client_id OR o.client_id IS NULL OR o.status<>'pending_payment' OR o.subscription_cycle_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional') THEN
  RAISE EXCEPTION 'buyer_checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 deadline:=o.created_at+p_lifetime_ms*interval '1 millisecond';
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'buyer_checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 mode:=CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id)
  OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
  THEN 'subscription_cycle' ELSE 'one_time' END;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',o.id,'commerce.checkout_recovery',
  'checkout_recovery:buyer:'||o.id||':'||floor(extract(epoch FROM p_requested_at)*1000/p_bucket_ms)::bigint,
  jsonb_build_object('orderId',o.id,'recoveryToken',p_raw_token,'mode',mode,'buyerRequested',true),jsonb_build_object('source','buyer_payment_link'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING id INTO event_id;
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'buyer_checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 IF event_id IS NULL THEN RETURN jsonb_build_object('sent',true,'queued',false); END IF;
 issued_at:=clock_timestamp();
 INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at,created_at)
 VALUES(o.id,o.client_id,encode(sha256(convert_to(p_raw_token,'UTF8')),'hex'),deadline,issued_at);
 IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'buyer_checkout_recovery_order_not_recoverable' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('sent',true,'queued',true);
END; $$;
REVOKE ALL ON FUNCTION public.commerce_buyer_checkout_link_issue(uuid,uuid,text,bigint,bigint,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.commerce_buyer_checkout_link_delivery_authorize(p_event_id uuid,p_claim_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE event public.outbox_events%ROWTYPE; o public.commerce_orders%ROWTYPE;
BEGIN
 SELECT * INTO event FROM public.outbox_events WHERE id=p_event_id AND status='processing' AND metadata->>'claimToken'=p_claim_token;
 IF NOT FOUND THEN RETURN jsonb_build_object('authorized',false,'reason','claim_not_active'); END IF;
 IF event.event_type<>'commerce.checkout_recovery' OR event.aggregate_type<>'commerce_order'
  OR event.idempotency_key NOT LIKE 'checkout_recovery:buyer:'||event.aggregate_id||':%'
  OR event.payload->>'orderId' IS DISTINCT FROM event.aggregate_id::text OR event.payload->>'buyerRequested' IS DISTINCT FROM 'true'
  OR event.metadata->>'source' IS DISTINCT FROM 'buyer_payment_link' THEN
  RETURN jsonb_build_object('authorized',false,'reason','event_type_not_supported'); END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=event.aggregate_id;
 IF NOT FOUND OR o.client_id IS NULL OR o.subscription_cycle_id IS NOT NULL OR o.status<>'pending_payment' THEN
  RETURN jsonb_build_object('authorized',false,'reason','order_not_recoverable'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_checkout_recovery_tokens t WHERE t.order_id=o.id AND t.client_id=o.client_id
  AND t.token_hash=encode(sha256(convert_to(event.payload->>'recoveryToken','UTF8')),'hex') AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()) THEN
  RETURN jsonb_build_object('authorized',false,'reason','buyer_checkout_recovery_link_not_live'); END IF;
 RETURN jsonb_build_object('authorized',true,'idempotencyKey','checkout-reminder:'||event.id,
  'recipientReference',o.client_id,'templateReference','commerce-checkout-recovery');
END; $$;
REVOKE ALL ON FUNCTION public.commerce_buyer_checkout_link_delivery_authorize(uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_checkout_recovery_context_as_actor(uuid) TO authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_buyer_checkout_link_issue(uuid,uuid,text,bigint,bigint,timestamptz), public.commerce_buyer_checkout_link_delivery_authorize(uuid,text) TO service_role'; END IF; END; $$;
