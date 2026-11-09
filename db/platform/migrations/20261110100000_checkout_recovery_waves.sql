-- Checkout reminder waves and reservation-backed expiry capture.
-- Existing entry points retain headers/owners; new service-only functions use
-- fixed definer search paths. No table privileges are added.
-- An event's unique identity arbitrates token insertion in the same transaction.
ALTER TABLE public.commerce_orders DROP CONSTRAINT commerce_orders_status_check;
ALTER TABLE public.commerce_orders ADD CONSTRAINT commerce_orders_status_check
 CHECK (status IN ('pending_payment','paid','fulfillment_pending','fulfilled','cancelled','refunded','expired')) NOT VALID;

CREATE FUNCTION public.commerce_checkout_recovery_policy(p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb; key text;
BEGIN
 IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' OR EXISTS (
  SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN
  ('firstOffsetSeconds','finalOffsetSeconds','checkoutSeconds','recoverySeconds','activitySeconds','profile')) THEN
  RAISE EXCEPTION 'checkout_recovery_policy_invalid' USING ERRCODE='22023'; END IF;
 result:=jsonb_build_object('firstOffsetSeconds',3600,'finalOffsetSeconds',72000,
  'checkoutSeconds',86400,'recoverySeconds',2592000,'activitySeconds',900,'profile','capture')||p_policy;
 FOREACH key IN ARRAY ARRAY['firstOffsetSeconds','finalOffsetSeconds','checkoutSeconds','recoverySeconds','activitySeconds'] LOOP
  IF jsonb_typeof(result->key)<>'number' OR (result->>key)!~'^[0-9]+$'
   OR (result->>key)::numeric NOT BETWEEN 1 AND 2147483647 THEN
   RAISE EXCEPTION 'checkout_recovery_policy_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (result->>'firstOffsetSeconds')::integer >= (result->>'finalOffsetSeconds')::integer
  OR (result->>'finalOffsetSeconds')::integer >= (result->>'checkoutSeconds')::integer
  OR jsonb_typeof(result->'profile')<>'string' OR result->>'profile' IS NULL
  OR (result->>'profile')!~'^[a-z][a-z0-9_-]{0,47}$' THEN
  RAISE EXCEPTION 'checkout_recovery_policy_invalid' USING ERRCODE='22023'; END IF;
 RETURN result;
END; $$;

CREATE FUNCTION public.commerce_checkout_recovery_payment_blocked(p_order_id uuid,p_activity_seconds integer,p_now timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=p_order_id AND
  (i.status='settled' OR (i.status='created' AND i.updated_at>p_now-make_interval(secs=>p_activity_seconds))
   OR EXISTS (SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=i.id AND
    (a.state='captured' OR (a.state IN ('dispatched','indeterminate') AND a.updated_at>p_now-make_interval(secs=>p_activity_seconds))))
   OR EXISTS (SELECT 1 FROM public.payment_truth_events e WHERE e.settlement_intent_id=i.id AND
    (e.outcome='captured' OR (e.outcome='indeterminate' AND e.updated_at>p_now-make_interval(secs=>p_activity_seconds))))));
$$;

CREATE FUNCTION public.commerce_checkout_recovery_receipt_fingerprint(p_event_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('eventId',e.id,'clientId',o.client_id,
  'template','commerce-checkout-recovery','profile',e.metadata->>'deliveryProfile')::text,'UTF8')),'hex')
 FROM public.outbox_events e JOIN public.commerce_orders o ON o.id=e.aggregate_id
 WHERE e.id=p_event_id AND e.event_type='commerce.checkout_recovery';
$$;

CREATE FUNCTION public.commerce_checkout_recovery_record_sent(p_event_id uuid,p_profile text,p_delivery_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e public.outbox_events%ROWTYPE; receipt public.transactional_delivery_receipts%ROWTYPE;
BEGIN
 SELECT * INTO e FROM public.outbox_events WHERE id=p_event_id;
 IF NOT FOUND OR e.event_type<>'commerce.checkout_recovery' OR p_profile IS NULL
  OR e.metadata->>'deliveryProfile' IS DISTINCT FROM p_profile THEN
  RAISE EXCEPTION 'checkout_recovery_delivery_identity_invalid' USING ERRCODE='22023'; END IF;
 receipt:=public.transactional_delivery_record_accepted('checkout-reminder:'||e.id,
  public.commerce_checkout_recovery_receipt_fingerprint(e.id),p_delivery_reference);
 RETURN jsonb_build_object('state',receipt.state);
END; $$;

CREATE FUNCTION public.commerce_enqueue_checkout_recovery_reminders(p_limit integer,p_policy jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE policy jsonb:=public.commerce_checkout_recovery_policy(p_policy);
 wave integer; offset_seconds integer; inserted integer; first_count integer:=0; final_count integer:=0;
BEGIN
 IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'checkout_recovery_time_invalid' USING ERRCODE='22023'; END IF;
 FOREACH wave IN ARRAY ARRAY[1,20] LOOP
  offset_seconds:=(policy->>CASE WHEN wave=1 THEN 'firstOffsetSeconds' ELSE 'finalOffsetSeconds' END)::integer;
  WITH candidates AS MATERIALIZED (
   SELECT o.id,o.client_id,o.created_at,
    CASE WHEN EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id)
     OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
     THEN 'subscription_cycle' ELSE 'one_time' END AS mode,
    'rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','') AS raw_token
   FROM public.commerce_orders o WHERE o.status='pending_payment' AND o.client_id IS NOT NULL
    AND o.subscription_cycle_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.state<>'provisional')
    AND o.created_at<p_now-make_interval(secs=>offset_seconds)
    AND o.created_at>p_now-make_interval(secs=>(policy->>'checkoutSeconds')::integer)
    AND NOT public.commerce_checkout_recovery_payment_blocked(o.id,(policy->>'activitySeconds')::integer,p_now)
    AND (wave=1 OR EXISTS(SELECT 1 FROM public.outbox_events prior JOIN public.transactional_delivery_receipts r
     ON r.idempotency_key='checkout-reminder:'||prior.id
     AND r.state='accepted' AND r.command_fingerprint=public.commerce_checkout_recovery_receipt_fingerprint(prior.id)
     WHERE prior.aggregate_id=o.id AND prior.event_type='commerce.checkout_recovery'
      AND prior.idempotency_key='checkout_recovery:1h:'||o.id
      AND prior.metadata->>'deliveryProfile'=policy->>'profile'))
   ORDER BY o.created_at,o.id LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)
  ), events AS (
   INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
   SELECT 'commerce_order',c.id,'commerce.checkout_recovery','checkout_recovery:'||wave||'h:'||c.id,
    jsonb_build_object('orderId',c.id,'mode',c.mode,'reminderHours',wave,'recoveryToken',c.raw_token,
     'expiresAt',c.created_at+make_interval(secs=>(policy->>'checkoutSeconds')::integer)),
    jsonb_build_object('source','checkout_recovery_waves','deliveryProfile',policy->>'profile','activitySeconds',(policy->>'activitySeconds')::integer)
   FROM candidates c ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING aggregate_id,payload
  ), tokens AS (
   INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at)
   SELECT e.aggregate_id,o.client_id,encode(sha256(convert_to(e.payload->>'recoveryToken','UTF8')),'hex'),
    (e.payload->>'expiresAt')::timestamptz FROM events e JOIN public.commerce_orders o ON o.id=e.aggregate_id RETURNING 1
  ) SELECT count(*)::integer INTO inserted FROM tokens;
  IF wave=1 THEN first_count:=inserted; ELSE final_count:=inserted; END IF;
 END LOOP;
 RETURN jsonb_build_object('enqueued_1h',first_count,'enqueued_20h',final_count);
END; $$;

CREATE OR REPLACE FUNCTION public.commerce_enqueue_checkout_recovery_reminders(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RETURN public.commerce_enqueue_checkout_recovery_reminders(p_limit,'{}'::jsonb,now());
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_checkout_reminder_delivery_authorize(
  p_event_id uuid,
  p_claim_token text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_event public.outbox_events%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_reason text;
  v_template text;
  v_operator boolean;
BEGIN
  SELECT * INTO v_event FROM public.outbox_events
   WHERE id = p_event_id AND status = 'processing'
     AND metadata->>'claimToken' = p_claim_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'claim_not_active');
  END IF;
  IF v_event.event_type NOT IN (
    'commerce.order_draft.abandoned.1h',
    'commerce.order_draft.abandoned.24h',
    'commerce.order_draft.abandoned.72h',
    'commerce.checkout_recovery'
  ) THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'event_type_not_supported');
  END IF;
  v_operator := v_event.event_type = 'commerce.checkout_recovery'
    AND v_event.idempotency_key LIKE 'checkout_recovery:operator:%';
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_event.aggregate_id;
  IF NOT FOUND OR v_order.client_id IS NULL
     OR (NOT v_operator AND v_order.status <> 'pending_payment') THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'order_not_recoverable');
  END IF;

  IF v_event.event_type LIKE 'commerce.order_draft.abandoned.%' THEN
    IF EXISTS (SELECT 1 FROM public.commerce_settlement_intents WHERE order_id = v_order.id)
       OR NOT EXISTS (
         SELECT 1 FROM public.commerce_order_draft_receipts AS receipt
          WHERE receipt.order_id = v_order.id AND receipt.invalidated_at IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.clients AS client
         JOIN public.customer_communication_preferences AS preference
           ON preference.principal_id = client.principal_id
          AND preference.marketing_newsletter_consent
         WHERE client.id = v_order.client_id
       ) THEN
      v_reason := 'abandoned_reminder_no_longer_allowed';
    END IF;
    v_template := replace(v_event.event_type, '.', '-');
  ELSIF v_operator THEN
    IF v_order.status <> 'pending_payment' AND NOT EXISTS (
      SELECT 1 FROM public.commerce_checkout_recovery_tokens AS token
       WHERE token.order_id = v_order.id
         AND token.revoked_at IS NULL
         AND token.expires_at > now()
    ) THEN
      v_reason := 'operator_checkout_recovery_link_not_live';
    END IF;
    v_template := 'commerce-checkout-recovery';
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL
      OR public.commerce_checkout_recovery_payment_blocked(v_order.id, COALESCE((v_event.metadata->>'activitySeconds')::integer, 900), now()) THEN
      v_reason := 'checkout_recovery_no_longer_allowed';
    END IF;
    v_template := 'commerce-checkout-recovery';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', v_reason);
  END IF;
  RETURN jsonb_build_object(
    'authorized', true,
    'idempotencyKey', 'checkout-reminder:' || v_event.id,
    'recipientReference', v_order.client_id,
    'templateReference', v_template
  );
END;
$$;

CREATE FUNCTION public.commerce_checkout_expired_event_enqueue(p_order_id uuid,p_policy jsonb,p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_order public.commerce_orders%ROWTYPE; policy jsonb:=public.commerce_checkout_recovery_policy(p_policy);
 raw_token text; event_id uuid; minted_at timestamptz;
BEGIN
 SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR v_order.subscription_cycle_id IS NOT NULL OR NOT (
  (v_order.status='expired' AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=v_order.id)
   AND COALESCE(v_order.metadata#>>'{orderDraftSnapshot,context,mode}',v_order.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')<>'subscription')
  OR (v_order.status='cancelled' AND v_order.metadata->>'subscriptionActivation'='abandoned'
   AND EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=v_order.id AND a.state='compensated'))
 ) THEN RETURN false; END IF;
 IF v_order.status='cancelled' AND v_order.client_id IS NULL THEN RETURN false; END IF;
 -- A notice must not contain a link already dead at minting time. Retain the
 -- token-less notice path and the original order-based deadline.
 minted_at:=GREATEST(p_now,clock_timestamp());
 IF v_order.client_id IS NOT NULL
  AND v_order.created_at+make_interval(secs=>(policy->>'recoverySeconds')::integer)>minted_at
 THEN raw_token:='rcv_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''); END IF;
 INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
 VALUES('commerce_order',v_order.id,'commerce.checkout.expired','checkout_expired:'||v_order.id,
  jsonb_build_object('orderId','order_'||v_order.id,'orderUuid',v_order.id,'totalCents',v_order.total_amount_minor,
   'currency',v_order.currency_code,'occurredAt',p_now)||CASE WHEN raw_token IS NULL THEN '{}'::jsonb ELSE
   jsonb_build_object('recoveryToken',raw_token,'mode',CASE WHEN v_order.status='cancelled' THEN 'subscription_cycle' ELSE 'one_time' END,
    'expiresAt',v_order.created_at+make_interval(secs=>(policy->>'recoverySeconds')::integer)) END,
  jsonb_build_object('source','checkout_expiry','deliveryProfile',policy->>'profile'))
 ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING id INTO event_id;
 IF event_id IS NULL THEN RETURN false; END IF;
 IF raw_token IS NOT NULL THEN
  INSERT INTO public.commerce_checkout_recovery_tokens(order_id,client_id,token_hash,expires_at,created_at)
  VALUES(v_order.id,v_order.client_id,encode(sha256(convert_to(raw_token,'UTF8')),'hex'),
   v_order.created_at+make_interval(secs=>(policy->>'recoverySeconds')::integer),minted_at);
 END IF;
 RETURN true;
END; $$;

CREATE FUNCTION public.commerce_reconcile_checkout_expired_events(p_limit integer,p_policy jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_order record; inserted integer:=0; checked integer:=0;
BEGIN
 PERFORM public.commerce_checkout_recovery_policy(p_policy);
 IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'checkout_recovery_time_invalid' USING ERRCODE='22023'; END IF;
 FOR v_order IN SELECT id FROM public.commerce_orders o WHERE o.subscription_cycle_id IS NULL
  AND (o.status='expired' OR (o.status='cancelled' AND o.metadata->>'subscriptionActivation'='abandoned'))
  AND NOT EXISTS(SELECT 1 FROM public.outbox_events e WHERE e.event_type='commerce.checkout.expired' AND e.idempotency_key='checkout_expired:'||o.id)
  ORDER BY o.updated_at,o.created_at,o.id LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)
 LOOP
  checked:=checked+1;
  IF public.commerce_checkout_expired_event_enqueue(v_order.id,p_policy,p_now) THEN inserted:=inserted+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('checked',checked,'inserted',inserted);
END; $$;

CREATE FUNCTION public.commerce_sweep_expired_checkouts(p_limit integer,p_policy jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_order public.commerce_orders%ROWTYPE; v_hold record; checked integer:=0; expired integer:=0; released integer:=0;
BEGIN
 PERFORM public.commerce_checkout_recovery_policy(p_policy);
 IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'checkout_recovery_time_invalid' USING ERRCODE='22023'; END IF;
 PERFORM public.inventory_admission_try_enter();
 FOR v_order IN SELECT o.* FROM public.commerce_orders o
  WHERE o.status='pending_payment' AND o.subscription_cycle_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id)
   AND COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')<>'subscription'
   AND EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations r WHERE r.purchase_order_id=o.id
    AND r.expires_at<=p_now AND (r.status='held' OR (r.status='expired' AND r.terminal_reason='reservation_expired')))
  ORDER BY (SELECT min(r.expires_at) FROM public.fulfillment_inventory_reservations r WHERE r.purchase_order_id=o.id),o.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),1000) FOR UPDATE OF o SKIP LOCKED
 LOOP
  checked:=checked+1;
  PERFORM i.id FROM public.commerce_settlement_intents i WHERE i.order_id=v_order.id ORDER BY i.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=v_order.id AND i.status='settled')
   OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id
    WHERE i.order_id=v_order.id AND e.outcome='captured')
   OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
    WHERE i.order_id=v_order.id AND a.state='captured') THEN CONTINUE; END IF;
  UPDATE public.commerce_settlement_intents SET status='failed',failure_reason='reservation_window_elapsed',updated_at=p_now
   WHERE order_id=v_order.id AND status='created';
  UPDATE public.commerce_orders SET status='expired',updated_at=p_now,
   metadata=metadata||jsonb_build_object('paymentStatus','expired','abandonmentReason','reservation_window_elapsed','source','checkout_reservation_expiry') WHERE id=v_order.id;
  FOR v_hold IN SELECT id FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=v_order.id AND status='held' ORDER BY id FOR UPDATE LOOP
   PERFORM public.fulfillment_release_purchase_reservation('checkout-expire:'||v_hold.id,v_hold.id,'reservation_window_elapsed','{}'::jsonb,p_now);
   released:=released+1;
  END LOOP;
  PERFORM public.commerce_checkout_expired_event_enqueue(v_order.id,p_policy,p_now);
  expired:=expired+1;
 END LOOP;
 RETURN jsonb_build_object('checked',checked,'expired',expired,'released',released);
END; $$;

CREATE FUNCTION public.commerce_initial_checkout_abandonment_safe(p_order_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=p_order_id AND
  (i.status='settled' OR i.external_ref IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=i.id)
   OR EXISTS(SELECT 1 FROM public.payment_truth_events e WHERE e.settlement_intent_id=i.id)));
$$;

CREATE FUNCTION public.commerce_sweep_initial_checkouts(p_limit integer,p_older_than timestamptz,p_policy jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE candidate record; v_order public.commerce_orders%ROWTYPE; answer jsonb; count integer:=0; key text; compensation_key text;
BEGIN
 PERFORM public.commerce_checkout_recovery_policy(p_policy);
 IF p_now IS NULL OR NOT isfinite(p_now) OR p_older_than IS NULL OR NOT isfinite(p_older_than) THEN
  RAISE EXCEPTION 'checkout_recovery_time_invalid' USING ERRCODE='22023'; END IF;
 PERFORM public.inventory_admission_try_enter();
 FOR candidate IN SELECT o.id FROM public.commerce_orders o JOIN public.subscription_activations a ON a.order_id=o.id
  WHERE a.state='provisional' AND a.declared_at<p_older_than AND o.status='pending_payment' AND o.subscription_cycle_id IS NULL
   AND public.commerce_initial_checkout_abandonment_safe(o.id)
  ORDER BY a.declared_at,o.id LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),1000)
 LOOP
  key:='initial-abandon:'||candidate.id;
  compensation_key:='purchase-cancel:'||encode(sha256(convert_to(key,'UTF8')),'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended('purchase-reservation:'||compensation_key,0)) THEN CONTINUE; END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR v_order.status<>'pending_payment' OR v_order.subscription_cycle_id IS NOT NULL THEN CONTINUE; END IF;
  PERFORM 1 FROM public.subscription_activations WHERE order_id=v_order.id AND state='provisional' AND declared_at<p_older_than FOR UPDATE;
  IF NOT FOUND THEN CONTINUE; END IF;
  PERFORM i.id FROM public.commerce_settlement_intents i WHERE i.order_id=v_order.id ORDER BY i.id FOR UPDATE;
  IF NOT public.commerce_initial_checkout_abandonment_safe(v_order.id) THEN CONTINUE; END IF;
  answer:=public.commerce_cancel_abandoned_purchase_checkout(key,v_order.id,'provisional_payment_window_elapsed',p_now);
  IF answer->>'cancelled'<>'true' THEN CONTINUE; END IF;
  UPDATE public.commerce_orders SET metadata=metadata||jsonb_build_object('subscriptionActivation','abandoned',
   'source','initial_checkout_sweep','paymentStatus','cancelled') WHERE id=v_order.id;
  PERFORM public.commerce_checkout_expired_event_enqueue(v_order.id,p_policy,p_now);
  count:=count+1;
 END LOOP;
 RETURN jsonb_build_object('swept',count);
END; $$;


CREATE FUNCTION public.commerce_checkout_recovery_wave_delivery_authorize(p_event_id uuid,p_claim_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE id=p_event_id AND event_type='commerce.checkout_recovery'
  AND idempotency_key NOT LIKE 'checkout_recovery:operator:%' AND COALESCE(payload->>'buyerRequested','false')<>'true') THEN
  RETURN jsonb_build_object('authorized',false,'reason','event_type_not_supported'); END IF;
 RETURN public.commerce_checkout_reminder_delivery_authorize(p_event_id,p_claim_token);
END; $$;

-- Closed service capabilities. Existing replacement ACLs are retained.
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_policy(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_payment_blocked(uuid,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_receipt_fingerprint(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_record_sent(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_expired_event_enqueue(uuid,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_reconcile_checkout_expired_events(integer,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_sweep_expired_checkouts(integer,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_initial_checkout_abandonment_safe(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_sweep_initial_checkouts(integer,timestamptz,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_wave_delivery_authorize(uuid,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_policy(jsonb), public.commerce_checkout_recovery_payment_blocked(uuid,integer,timestamptz), public.commerce_checkout_recovery_receipt_fingerprint(uuid), public.commerce_checkout_recovery_record_sent(uuid,text,text), public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz), public.commerce_checkout_expired_event_enqueue(uuid,jsonb,timestamptz), public.commerce_reconcile_checkout_expired_events(integer,jsonb,timestamptz), public.commerce_sweep_expired_checkouts(integer,jsonb,timestamptz), public.commerce_initial_checkout_abandonment_safe(uuid), public.commerce_sweep_initial_checkouts(integer,timestamptz,jsonb,timestamptz), public.commerce_checkout_recovery_wave_delivery_authorize(uuid,text) FROM anon';
 END IF;
END; $$;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_policy(jsonb), public.commerce_checkout_recovery_payment_blocked(uuid,integer,timestamptz), public.commerce_checkout_recovery_receipt_fingerprint(uuid), public.commerce_checkout_recovery_record_sent(uuid,text,text), public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz), public.commerce_checkout_expired_event_enqueue(uuid,jsonb,timestamptz), public.commerce_reconcile_checkout_expired_events(integer,jsonb,timestamptz), public.commerce_sweep_expired_checkouts(integer,jsonb,timestamptz), public.commerce_initial_checkout_abandonment_safe(uuid), public.commerce_sweep_initial_checkouts(integer,timestamptz,jsonb,timestamptz), public.commerce_checkout_recovery_wave_delivery_authorize(uuid,text) FROM authenticated';
 END IF;
END; $$;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_policy(jsonb), public.commerce_checkout_recovery_payment_blocked(uuid,integer,timestamptz), public.commerce_checkout_recovery_receipt_fingerprint(uuid), public.commerce_checkout_recovery_record_sent(uuid,text,text), public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz), public.commerce_checkout_expired_event_enqueue(uuid,jsonb,timestamptz), public.commerce_reconcile_checkout_expired_events(integer,jsonb,timestamptz), public.commerce_sweep_expired_checkouts(integer,jsonb,timestamptz), public.commerce_initial_checkout_abandonment_safe(uuid), public.commerce_sweep_initial_checkouts(integer,timestamptz,jsonb,timestamptz), public.commerce_checkout_recovery_wave_delivery_authorize(uuid,text) FROM service_role';
 END IF;
END; $$;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_record_sent(uuid,text,text), public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz), public.commerce_reconcile_checkout_expired_events(integer,jsonb,timestamptz), public.commerce_sweep_expired_checkouts(integer,jsonb,timestamptz), public.commerce_sweep_initial_checkouts(integer,timestamptz,jsonb,timestamptz), public.commerce_checkout_recovery_wave_delivery_authorize(uuid,text) TO service_role';
 END IF;
END; $$;
