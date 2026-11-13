-- Durable provider preparation and immutable ingress; the native settlement rail owns money effects.
CREATE TABLE public.payment_provider_states (
 id uuid PRIMARY KEY REFERENCES public.commerce_settlement_intents(id),
 payment_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 target_kind text NOT NULL CHECK (target_kind IN ('one_time_order','subscription_cycle')),
 subscription_id uuid REFERENCES public.subscriptions(id),
 subscription_cycle_id uuid REFERENCES public.subscription_cycles(id),
 status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','requires_action','processing','succeeded','failed','expired','cancelled','refunded','partially_refunded','disputed')),
 payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('requires_action','pending','succeeded','failed','expired','cancelled','refunded','partially_refunded','disputed')),
 provider text,
 provider_payment_id text,
 active_attempt_id uuid,
 failure_reason text,
 provider_attempt_sequence integer NOT NULL DEFAULT 0 CHECK (provider_attempt_sequence BETWEEN 0 AND 2147483647),
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((target_kind='one_time_order' AND subscription_id IS NULL AND subscription_cycle_id IS NULL)
  OR (target_kind='subscription_cycle' AND subscription_id IS NOT NULL AND subscription_cycle_id IS NOT NULL))
);
CREATE TABLE public.payment_provider_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 settlement_intent_id uuid NOT NULL REFERENCES public.payment_provider_states(id),
 payment_id uuid NOT NULL REFERENCES public.payment_provider_states(payment_id),
 provider text NOT NULL,
 provider_attempt_id text,
 provider_session_id text,
 idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','blocked_preflight','sent_to_provider','requires_action','processing','succeeded','failed','cancelled','expired')),
 amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9223372036854775807),
 currency text NOT NULL CHECK (char_length(currency)=3),
 next_action_kind text CHECK (next_action_kind IS NULL OR next_action_kind IN ('redirect','3ds_challenge','qr_code','blik_code_prompt','sca_required')),
 failure_reason text,
 failure_class text CHECK (failure_class IN ('hard_do_not_retry','mandate_dead','sca_required','fix_and_retry_customer_action','soft_retry_delayed','soft_retryable','indeterminate')),
 request_payload jsonb NOT NULL DEFAULT '{}',
 response_payload jsonb NOT NULL DEFAULT '{}',
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (settlement_intent_id,idempotency_key)
);
CREATE UNIQUE INDEX payment_provider_attempts_provider_attempt_key ON public.payment_provider_attempts(provider,provider_attempt_id) WHERE provider_attempt_id IS NOT NULL;
CREATE INDEX payment_provider_attempts_intent_idx ON public.payment_provider_attempts(settlement_intent_id,created_at DESC,id DESC);
ALTER TABLE public.payment_provider_states ADD CONSTRAINT payment_provider_states_active_attempt_fkey FOREIGN KEY (active_attempt_id) REFERENCES public.payment_provider_attempts(id);
CREATE TABLE public.payment_provider_attempt_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL,
 provider_event_id text NOT NULL,
 event_type text NOT NULL,
 settlement_intent_id uuid REFERENCES public.commerce_settlement_intents(id),
 payment_attempt_id uuid REFERENCES public.payment_provider_attempts(id),
 provider_payment_id text,
 amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor BETWEEN 0 AND 9223372036854775807),
 currency text CHECK (currency IS NULL OR char_length(currency)=3),
 signature_verified boolean,
 received_via text,
 processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processed','ignored','failed')),
 processed_at timestamptz,
 payload jsonb NOT NULL DEFAULT '{}',
 error jsonb NOT NULL DEFAULT '{}',
 event_fingerprint text CHECK (event_fingerprint IS NULL OR (char_length(event_fingerprint) = 64 AND translate(event_fingerprint, '0123456789abcdef', '') = '')),
 source_evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (provider,provider_event_id)
);
CREATE INDEX payment_provider_attempt_evidence_intent_idx ON public.payment_provider_attempt_evidence(settlement_intent_id,payment_attempt_id);
CREATE TABLE public.payment_provider_receipts (
 scope text NOT NULL,
 idempotency_key text NOT NULL,
 request_fingerprint text NOT NULL,
 status text NOT NULL CHECK (status IN ('in_progress','completed')),
 response_payload jsonb,
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (scope,idempotency_key)
);
CREATE TABLE public.payment_provider_transitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 settlement_intent_id uuid NOT NULL REFERENCES public.commerce_settlement_intents(id),
 payment_attempt_id uuid REFERENCES public.payment_provider_attempts(id),
 provider_event_id uuid REFERENCES public.payment_provider_attempt_evidence(id),
 transition_kind text NOT NULL CHECK (transition_kind IN ('intent','attempt','business_result','timeout','refund','dispute','reconciliation')),
 from_status text,
 to_status text NOT NULL,
 reason text NOT NULL,
 idempotency_key text NOT NULL UNIQUE,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 payload jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);


CREATE FUNCTION public.payment_provider_lock_aggregate(p_intent_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hint record; locked record;
BEGIN
 SELECT i.order_id,COALESCE(c.subscription_id,a.subscription_id) AS subscription_id
 INTO hint FROM public.commerce_settlement_intents i JOIN public.commerce_orders o ON o.id=i.order_id
 LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
 LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE i.id=p_intent_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF hint.subscription_id IS NOT NULL THEN
  PERFORM 1 FROM public.subscriptions WHERE id=hint.subscription_id FOR UPDATE;
 END IF;
 PERFORM 1 FROM public.commerce_orders WHERE id=hint.order_id FOR UPDATE;
 PERFORM 1 FROM public.commerce_settlement_intents WHERE id=p_intent_id FOR UPDATE;
 SELECT i.order_id,COALESCE(c.subscription_id,a.subscription_id) AS subscription_id
 INTO locked FROM public.commerce_settlement_intents i JOIN public.commerce_orders o ON o.id=i.order_id
 LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
 LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE i.id=p_intent_id;
 IF NOT FOUND OR (locked.order_id,locked.subscription_id) IS DISTINCT FROM (hint.order_id,hint.subscription_id) THEN
  RAISE EXCEPTION 'payment_control_intent_aggregate_changed' USING ERRCODE='55000';
 END IF;
END;
$$;
CREATE FUNCTION public.payment_provider_attempt_read(p_intent_id uuid,p_attempt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('contractVersion','commerce.v0','paymentAttempt',jsonb_build_object(
  'id',a.id,'paymentIntentId',a.settlement_intent_id,'paymentId',a.payment_id,'status',a.status,
  'provider',a.provider,'providerAttemptId',a.provider_attempt_id,'providerSessionId',a.provider_session_id,
  'nextActionKind',a.next_action_kind,'idempotencyKey',a.idempotency_key,'replayed',false),
  'orderId',i.order_id,'intentStatus',s.status,'settlementStatus',i.status,
  'amountMinor',a.amount_minor,'currency',a.currency,'requestPayload',a.request_payload,'responsePayload',a.response_payload,
  'observedSuccess',EXISTS(SELECT 1 FROM public.payment_provider_attempts prior
   JOIN public.payment_provider_attempt_evidence e ON e.payment_attempt_id=prior.id AND e.settlement_intent_id=prior.settlement_intent_id
   WHERE prior.settlement_intent_id=s.id AND e.provider=prior.provider AND e.provider_payment_id=prior.provider_attempt_id
    AND e.signature_verified IS TRUE AND e.event_type='payment.succeeded'),
  'observedFailure',EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence e WHERE e.payment_attempt_id=a.id
   AND e.settlement_intent_id=s.id AND e.provider=a.provider AND e.provider_payment_id=a.provider_attempt_id
   AND e.signature_verified IS TRUE AND e.event_type='payment.failed'
   AND (e.amount_minor IS NULL OR e.amount_minor=0 OR e.amount_minor=i.amount_minor)
   AND (e.currency IS NULL OR e.currency=i.currency_code)))
 FROM public.payment_provider_attempts a JOIN public.payment_provider_states s ON s.id=a.settlement_intent_id
 JOIN public.commerce_settlement_intents i ON i.id=s.id
 WHERE s.id=p_intent_id AND a.id=COALESCE(p_attempt_id,s.active_attempt_id);
$$;


CREATE FUNCTION public.payment_provider_intent_create(
 p_idempotency_key text,p_target_kind text,p_order_id uuid,p_subscription_id uuid,p_subscription_cycle_id uuid,
 p_amount_minor bigint,p_currency text,p_metadata jsonb,p_channel_key text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE fingerprint text; receipt public.payment_provider_receipts%ROWTYPE;
 o public.commerce_orders%ROWTYPE; i public.commerce_settlement_intents%ROWTYPE;
 ps public.payment_provider_states%ROWTYPE; answer jsonb; opened jsonb; linked_subscription uuid;
BEGIN
 IF p_idempotency_key IS NULL OR length(p_idempotency_key)<8 OR btrim(p_idempotency_key)=''
  OR p_target_kind IS NULL OR p_target_kind NOT IN ('one_time_order','subscription_cycle') OR p_order_id IS NULL
  OR p_amount_minor IS NULL OR p_amount_minor<1 OR p_currency IS NULL OR char_length(p_currency)<>3
  OR p_channel_key IS NULL OR btrim(p_channel_key)='' OR p_channel_key='sandbox' OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RAISE EXCEPTION 'payment_control_intent_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_target_kind='one_time_order' AND (p_subscription_id IS NOT NULL OR p_subscription_cycle_id IS NOT NULL) THEN
  RAISE EXCEPTION 'payment_control_intent_invalid_one_time_target' USING ERRCODE='22023'; END IF;
 IF p_target_kind='subscription_cycle' AND (p_subscription_id IS NULL OR p_subscription_cycle_id IS NULL) THEN
  RAISE EXCEPTION 'payment_control_intent_invalid_subscription_target' USING ERRCODE='22023'; END IF;
 fingerprint:=md5(p_target_kind||'|'||p_order_id::text||'|'||COALESCE(p_subscription_id::text,'')||'|'||
  COALESCE(p_subscription_cycle_id::text,'')||'|'||p_amount_minor::text||'|'||p_currency||'|'||COALESCE(p_metadata,'{}'::jsonb)::text);
 SELECT c.subscription_id INTO linked_subscription FROM public.commerce_orders orders
 LEFT JOIN public.subscription_cycles c ON c.id=orders.subscription_cycle_id WHERE orders.id=p_order_id;
 IF linked_subscription IS NOT NULL THEN PERFORM 1 FROM public.subscriptions WHERE id=linked_subscription FOR UPDATE; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_intent.create' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.request_fingerprint=fingerprint AND receipt.response_payload IS NOT NULL
   AND receipt.metadata->>'channelKey'=p_channel_key THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentIntent,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_intent_idempotency_conflict' USING ERRCODE='23505'; END IF;
 IF o.id IS NULL THEN RAISE EXCEPTION 'payment_control_intent_order_not_found' USING ERRCODE='22023'; END IF;
 IF (o.total_amount_minor,o.currency_code) IS DISTINCT FROM (p_amount_minor,p_currency) THEN
  RAISE EXCEPTION 'payment_control_intent_order_amount_mismatch' USING ERRCODE='22023'; END IF;
 IF o.status<>'pending_payment' THEN RAISE EXCEPTION 'payment_control_intent_order_not_payable' USING ERRCODE='22023'; END IF;
 IF p_target_kind='subscription_cycle' AND (o.subscription_cycle_id IS DISTINCT FROM p_subscription_cycle_id OR linked_subscription IS DISTINCT FROM p_subscription_id) THEN
  RAISE EXCEPTION 'payment_control_intent_subscription_order_mismatch' USING ERRCODE='22023'; END IF;
 IF p_target_kind='one_time_order' AND o.subscription_cycle_id IS NOT NULL THEN
  RAISE EXCEPTION 'payment_control_intent_subscription_order_mismatch' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE order_id=p_order_id FOR UPDATE;
 IF FOUND THEN
  IF i.channel_key IS DISTINCT FROM p_channel_key OR i.status IN ('settled','cancelled')
   OR (i.amount_minor,i.currency_code) IS DISTINCT FROM (p_amount_minor,p_currency) THEN
   RAISE EXCEPTION 'payment_control_intent_existing_payment_mismatch' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=i.id) THEN
   RAISE EXCEPTION 'payment_control_intent_order_already_has_intent' USING ERRCODE='23505'; END IF;
 ELSE
  opened:=public.commerce_open_settlement_intent(p_idempotency_key,p_order_id,p_channel_key,p_amount_minor,p_currency,p_metadata,p_at);
  SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=(opened#>>'{settlement,id}')::uuid;
 END IF;
 INSERT INTO public.payment_provider_states(id,target_kind,subscription_id,subscription_cycle_id,metadata)
 VALUES(i.id,p_target_kind,p_subscription_id,p_subscription_cycle_id,COALESCE(p_metadata,'{}'::jsonb)||jsonb_build_object('source','payment.control.v0')) RETURNING * INTO ps;
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,transition_kind,to_status,reason,idempotency_key,payload)
 VALUES(i.id,'intent','created','payment_intent_created',p_idempotency_key||':intent_created',jsonb_build_object('targetKind',p_target_kind,'orderId',o.id,'paymentId',ps.payment_id));
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentIntent',jsonb_build_object('id',i.id,'paymentId',ps.payment_id,
  'orderId',o.id,'targetKind',p_target_kind,'status',ps.status,'amountMinor',i.amount_minor,'currency',i.currency_code,'idempotencyKey',p_idempotency_key,'replayed',false));
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_intent.create',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentId',ps.payment_id,'channelKey',p_channel_key));
 RETURN answer;
END;
$$;


CREATE FUNCTION public.payment_provider_attempt_prepare(
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_provider text,
  p_provider_idempotency_key text,
  p_provider_request_fingerprint text,
  p_provider_flow text,
  p_payment_method_ref text,
  p_request_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.prepare_provider';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_intent record;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_attempt_id uuid;
  v_request_payload jsonb;
  v_response jsonb;
  v_order public.commerce_orders%ROWTYPE;
  v_active_attempt public.payment_provider_attempts%ROWTYPE;
  v_observed_success_attempt public.payment_provider_attempts%ROWTYPE;
  v_subscription_status text;
  v_inline_retry boolean := COALESCE(p_request_payload->>'source','')='commerce.checkout-inline-recovery.prepare.v1';
  v_expected_attempt_id uuid;
  v_hold record;
BEGIN
  IF v_inline_retry THEN
   IF NOT COALESCE(pg_input_is_valid(p_request_payload->>'expectedPaymentAttemptId','uuid'),false)
    OR NOT COALESCE(pg_input_is_valid(p_request_payload->>'retryRequestId','uuid'),false)
    OR COALESCE(p_request_payload->>'purchaseContext','') NOT IN ('one_time','subscription_initial') THEN
    RAISE EXCEPTION 'payment_control_inline_retry_invalid_context' USING ERRCODE='22023'; END IF;
   v_expected_attempt_id:=(p_request_payload->>'expectedPaymentAttemptId')::uuid;
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_settlement_intent_id IS NULL
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_idempotency_key IS NULL OR btrim(p_provider_idempotency_key) = ''
    OR p_provider_request_fingerprint IS NULL OR btrim(p_provider_request_fingerprint) = ''
    OR p_provider_flow IS NULL OR btrim(p_provider_flow) = ''
  THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF p_provider_flow NOT IN (
    'one_time_payment',
    'setup_reusable_method',
    'off_session_payment',
    'blik_one_time',
    'blik_one_click',
    'pbl_one_time',
    'blik_recurring_activation',
    'recurring_charge'
  ) THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_invalid_flow' USING ERRCODE = '22023';
  END IF;

  v_request_payload := COALESCE(p_request_payload, '{}'::jsonb) || jsonb_build_object(
    'providerIdempotencyKey', p_provider_idempotency_key,
    'providerRequestFingerprint', p_provider_request_fingerprint,
    'providerFlow', p_provider_flow,
    'paymentMethodRef', p_payment_method_ref
  );

  v_request_fingerprint := md5(
    p_settlement_intent_id::text || '|' ||
    p_provider || '|' ||
    p_provider_idempotency_key || '|' ||
    p_provider_request_fingerprint || '|' ||
    p_provider_flow || '|' ||
    COALESCE(p_payment_method_ref, '') || '|' ||
    v_request_payload::text
  );

  PERFORM public.payment_provider_lock_aggregate(p_settlement_intent_id);

  IF v_inline_retry AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents i
    JOIN public.commerce_orders o ON o.id=i.order_id WHERE i.id=p_settlement_intent_id
     AND (o.status<>'pending_payment' OR o.metadata->>'paymentStatus'='expired')) THEN
    RAISE EXCEPTION 'payment_control_inline_retry_order_not_payable' USING ERRCODE='55000';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      v_attempt_id := (v_existing.response_payload -> 'paymentAttempt' ->> 'id')::uuid;
      SELECT *
        INTO v_attempt
        FROM public.payment_provider_attempts
       WHERE id = v_attempt_id;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'contractVersion', 'commerce.v0',
          'paymentAttempt', jsonb_build_object(
            'id', v_attempt.id,
            'paymentIntentId', v_attempt.settlement_intent_id,
            'status', v_attempt.status,
            'provider', v_attempt.provider,
            'providerAttemptId', v_attempt.provider_attempt_id,
            'providerSessionId', v_attempt.provider_session_id,
            'nextActionKind', v_attempt.next_action_kind,
            'idempotencyKey', p_idempotency_key,
            'replayed', true
          )
        );
      END IF;

      RETURN jsonb_set(v_existing.response_payload, '{paymentAttempt,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT ps.*,i.amount_minor,i.currency_code AS currency,i.order_id,i.status AS settlement_status
    INTO v_intent FROM public.payment_provider_states ps
    JOIN public.commerce_settlement_intents i ON i.id=ps.id
    WHERE ps.id=p_settlement_intent_id FOR UPDATE OF ps;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status IN ('succeeded', 'cancelled', 'refunded', 'partially_refunded', 'disputed')
    OR v_intent.settlement_status IN ('settled','cancelled') THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_prepare_intent_not_retryable' USING ERRCODE = '22023';
  END IF;

  -- Exact persisted receipts have already replayed above. A fresh browser key
  -- cannot authorize another provider call while any exact attempt is unresolved.
  SELECT a.* INTO v_observed_success_attempt FROM public.payment_provider_attempts a
  WHERE a.settlement_intent_id=v_intent.id AND a.payment_id=v_intent.payment_id AND EXISTS(
   SELECT 1 FROM public.payment_provider_attempt_evidence e WHERE e.settlement_intent_id=a.settlement_intent_id
    AND e.payment_attempt_id=a.id AND e.provider=a.provider AND e.provider_payment_id=a.provider_attempt_id
    AND e.signature_verified IS TRUE AND e.event_type='payment.succeeded')
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
   RETURN jsonb_set(public.payment_provider_attempt_read(v_intent.id,v_observed_success_attempt.id),'{paymentAttempt,replayed}','true'::jsonb,false);
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=v_intent.order_id;
  SELECT status INTO v_subscription_status FROM public.subscriptions WHERE id=v_intent.subscription_id;
  IF v_inline_retry THEN
   IF v_order.status<>'pending_payment' OR v_order.metadata->>'paymentStatus'='expired' THEN
    RAISE EXCEPTION 'payment_control_inline_retry_order_not_payable' USING ERRCODE='55000'; END IF;
   IF v_intent.status<>'failed' OR v_intent.active_attempt_id IS DISTINCT FROM v_expected_attempt_id THEN
    RAISE EXCEPTION 'payment_control_inline_retry_predecessor_mismatch' USING ERRCODE='55000'; END IF;
   SELECT * INTO v_active_attempt FROM public.payment_provider_attempts WHERE id=v_expected_attempt_id
    AND settlement_intent_id=v_intent.id AND payment_id=v_intent.payment_id FOR UPDATE;
   IF NOT FOUND OR v_active_attempt.status<>'failed' THEN
    RAISE EXCEPTION 'payment_control_inline_retry_predecessor_mismatch' USING ERRCODE='55000'; END IF;
   IF p_request_payload->>'purchaseContext'='subscription_initial' THEN
    IF NOT EXISTS(SELECT 1 FROM public.subscription_activations activation WHERE activation.order_id=v_order.id
     AND activation.client_id=v_order.client_id AND activation.state='provisional' AND activation.subscription_id IS NULL)
     OR NOT ((p_provider='stripe' AND p_provider_flow='one_time_payment') OR (p_provider='tpay' AND p_provider_flow='blik_recurring_activation')) THEN
     RAISE EXCEPTION 'payment_control_inline_retry_context_mismatch' USING ERRCODE='55000'; END IF;
   ELSIF v_intent.target_kind<>'one_time_order' OR EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=v_order.id)
    OR NOT ((p_provider='stripe' AND p_provider_flow='one_time_payment') OR (p_provider='tpay' AND p_provider_flow='blik_one_time')) THEN
    RAISE EXCEPTION 'payment_control_inline_retry_context_mismatch' USING ERRCODE='55000'; END IF;
  END IF;
  IF v_intent.target_kind='subscription_cycle' AND (v_subscription_status IS NULL OR v_subscription_status<>'active') THEN
   IF NOT EXISTS(SELECT 1 FROM public.payment_provider_attempts WHERE settlement_intent_id=v_intent.id
    AND status NOT IN ('blocked_preflight','failed','cancelled','expired')) THEN
    UPDATE public.payment_provider_states SET status='cancelled',failure_reason='subscription_not_chargeable',updated_at=now()
     WHERE id=v_intent.id AND status IN ('created','failed');
    UPDATE public.commerce_settlement_intents SET status='cancelled',failure_reason='subscription_not_chargeable',updated_at=now()
     WHERE id=v_intent.id AND status IN ('created','failed');
    UPDATE public.subscription_cycles SET status='cancelled',updated_at=now() WHERE id=v_intent.subscription_cycle_id
     AND subscription_id=v_intent.subscription_id AND status IN ('planned','payment_pending');
    UPDATE public.subscription_retry_obligations SET next_retry_at=NULL,updated_at=now() WHERE cycle_id=v_intent.subscription_cycle_id AND state='waiting';
    UPDATE public.commerce_orders SET status='cancelled',updated_at=now(),metadata=metadata||jsonb_build_object('paymentStatus','cancelled','cancelReason','subscription_not_chargeable','source','payment.control.prepare')
     WHERE id=v_intent.order_id AND status='pending_payment';
    FOR v_hold IN SELECT id FROM public.fulfillment_inventory_reservations
     WHERE purchase_order_id=v_intent.order_id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation(
      'not-chargeable:'||v_hold.id,v_hold.id,'subscription_not_chargeable','{}'::jsonb,now());
    END LOOP;
   END IF;
   RETURN jsonb_build_object('contractVersion','commerce.v0','paymentAttemptAdmission',jsonb_build_object(
    'status','skipped_not_chargeable','reason','payment_control_subscription_not_chargeable','paymentIntentId',v_intent.id));
  END IF;
  IF v_intent.active_attempt_id IS NOT NULL THEN
   SELECT * INTO v_active_attempt FROM public.payment_provider_attempts WHERE id=v_intent.active_attempt_id FOR UPDATE;
   IF FOUND AND v_active_attempt.status NOT IN ('blocked_preflight','failed','cancelled','expired') THEN
    RETURN jsonb_set(public.payment_provider_attempt_read(v_intent.id,v_active_attempt.id),'{paymentAttempt,replayed}','true'::jsonb,false);
   END IF;
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'payment_provider_attempt_prepare')
  );

  INSERT INTO public.payment_provider_attempts (
    settlement_intent_id,
    payment_id,
    provider,
    provider_attempt_id,
    provider_session_id,
    idempotency_key,
    status,
    amount_minor,
    currency,
    next_action_kind,
    request_payload,
    response_payload
  )
  VALUES (
    v_intent.id,
    v_intent.payment_id,
    p_provider,
    NULL,
    NULL,
    p_idempotency_key,
    'created',
    v_intent.amount_minor,
    v_intent.currency,
    NULL,
    v_request_payload,
    jsonb_build_object('providerCallPlanned', true, 'providerCall', false)
  )
  RETURNING * INTO v_attempt;

  UPDATE public.payment_provider_states
     SET active_attempt_id = v_attempt.id,
         status = 'processing',
         updated_at = now()
   WHERE id = v_intent.id;

  UPDATE public.payment_provider_states
     SET payment_status = 'pending',
         provider = p_provider,
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'source', 'payment.control.v0'
         ),
         updated_at = now()
   WHERE payment_id = v_intent.payment_id;

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    payload
  )
  VALUES (
    v_intent.id,
    v_attempt.id,
    'attempt',
    'created',
    'created',
    'provider_attempt_prepared',
    p_idempotency_key || ':attempt_prepared',
    jsonb_build_object(
      'provider', p_provider,
      'providerIdempotencyKey', p_provider_idempotency_key,
      'providerRequestFingerprint', p_provider_request_fingerprint,
      'providerFlow', p_provider_flow
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentAttempt', jsonb_build_object(
      'id', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'status', v_attempt.status,
      'provider', v_attempt.provider,
      'providerAttemptId', v_attempt.provider_attempt_id,
      'providerSessionId', v_attempt.provider_session_id,
      'nextActionKind', v_attempt.next_action_kind,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('paymentIntentId', v_intent.id, 'paymentAttemptId', v_attempt.id)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE FUNCTION public.payment_provider_attempt_record(
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_provider text,
  p_provider_attempt_id text,
  p_provider_session_id text,
  p_attempt_status text,
  p_next_action_kind text,
  p_request_payload jsonb,
  p_response_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.record';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_intent record;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_intent_status text;
  v_payment_status text;
  v_provider_call boolean;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_settlement_intent_id IS NULL
    OR p_provider IS NULL OR btrim(p_provider) = ''
    OR p_attempt_status NOT IN ('blocked_preflight', 'sent_to_provider', 'requires_action', 'processing')
  THEN
    RAISE EXCEPTION 'payment_control_attempt_invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_next_action_kind IS NOT NULL
    AND p_next_action_kind NOT IN ('redirect', '3ds_challenge', 'qr_code', 'blik_code_prompt', 'sca_required')
  THEN
    RAISE EXCEPTION 'payment_control_attempt_invalid_next_action' USING ERRCODE = '22023';
  END IF;
  IF p_attempt_status = 'blocked_preflight'
    AND (p_provider_attempt_id IS NOT NULL OR p_provider_session_id IS NOT NULL OR p_next_action_kind IS NOT NULL)
  THEN
    RAISE EXCEPTION 'payment_control_attempt_preflight_provider_facts' USING ERRCODE = '22023';
  END IF;

  v_provider_call := COALESCE((COALESCE(p_response_payload, '{}'::jsonb)->>'providerCall')::boolean, true);
  IF p_attempt_status = 'blocked_preflight' AND v_provider_call IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'payment_control_attempt_preflight_provider_call' USING ERRCODE = '22023';
  END IF;

  v_request_fingerprint := md5(
    p_settlement_intent_id::text || '|' ||
    p_provider || '|' ||
    COALESCE(p_provider_attempt_id, '') || '|' ||
    COALESCE(p_provider_session_id, '') || '|' ||
    p_attempt_status || '|' ||
    COALESCE(p_next_action_kind, '') || '|' ||
    COALESCE(p_request_payload, '{}'::jsonb)::text || '|' ||
    COALESCE(p_response_payload, '{}'::jsonb)::text
  );

  PERFORM public.payment_provider_lock_aggregate(p_settlement_intent_id);

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{paymentAttempt,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'payment_control_attempt_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT ps.*,i.amount_minor,i.currency_code AS currency,i.order_id
    INTO v_intent FROM public.payment_provider_states ps
    JOIN public.commerce_settlement_intents i ON i.id=ps.id
    WHERE ps.id=p_settlement_intent_id FOR UPDATE OF ps;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_attempt_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status IN ('succeeded', 'cancelled', 'refunded', 'partially_refunded', 'disputed') THEN
    RAISE EXCEPTION 'payment_control_attempt_intent_not_retryable' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'payment_provider_attempt_record')
  );

  INSERT INTO public.payment_provider_attempts (
    settlement_intent_id,
    payment_id,
    provider,
    provider_attempt_id,
    provider_session_id,
    idempotency_key,
    status,
    amount_minor,
    currency,
    next_action_kind,
    request_payload,
    response_payload
  )
  VALUES (
    v_intent.id,
    v_intent.payment_id,
    p_provider,
    p_provider_attempt_id,
    p_provider_session_id,
    p_idempotency_key,
    p_attempt_status,
    v_intent.amount_minor,
    v_intent.currency,
    p_next_action_kind,
    COALESCE(p_request_payload, '{}'::jsonb),
    COALESCE(p_response_payload, '{}'::jsonb)
  )
  RETURNING * INTO v_attempt;

  v_intent_status := CASE WHEN p_attempt_status = 'requires_action' THEN 'requires_action' ELSE 'processing' END;
  v_payment_status := CASE WHEN p_attempt_status = 'requires_action' THEN 'requires_action' ELSE 'pending' END;

  UPDATE public.payment_provider_states
     SET active_attempt_id = v_attempt.id,
         status = v_intent_status,
         updated_at = now()
   WHERE id = v_intent.id;

  UPDATE public.payment_provider_states
     SET payment_status = v_payment_status,
         provider = p_provider,
         provider_payment_id = COALESCE(p_provider_attempt_id, provider_payment_id),
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'source', 'payment.control.v0'
         ),
         updated_at = now()
   WHERE payment_id = v_intent.payment_id;

  INSERT INTO public.outbox_events (
    aggregate_type,
    aggregate_id,
    event_type,
    idempotency_key,
    payload,
    metadata
  )
  VALUES (
    'commerce_payment_intent',
    v_intent.id,
    'commerce.payment_attempt.requested',
    p_idempotency_key,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'paymentAttemptId', v_attempt.id,
      'provider', p_provider,
      'attemptStatus', p_attempt_status,
      'providerCall', v_provider_call,
      'amountCents', v_intent.amount_minor,
      'currency', v_intent.currency
    ),
    jsonb_build_object('boundary', 'payment_provider_attempt_record')
  );

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    payload
  )
  VALUES (
    v_intent.id,
    v_attempt.id,
    'attempt',
    'created',
    p_attempt_status,
    CASE WHEN p_attempt_status = 'blocked_preflight' THEN 'provider_preflight_blocked' ELSE 'provider_attempt_recorded' END,
    p_idempotency_key || ':attempt_recorded',
    jsonb_build_object('provider', p_provider, 'providerAttemptId', p_provider_attempt_id, 'providerCall', v_provider_call)
  );

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentAttempt', jsonb_build_object(
      'id', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'status', p_attempt_status,
      'provider', p_provider,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('paymentIntentId', v_intent.id, 'paymentAttemptId', v_attempt.id)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE FUNCTION public.payment_provider_attempt_finalize(
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_payment_attempt_id uuid,
  p_provider_idempotency_key text,
  p_provider_request_fingerprint text,
  p_provider_attempt_id text,
  p_provider_session_id text,
  p_attempt_status text,
  p_next_action_kind text,
  p_request_payload jsonb,
  p_response_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_scope constant text := 'commerce.payment_attempt.finalize_provider';
  v_request_fingerprint text;
  v_existing public.payment_provider_receipts%ROWTYPE;
  v_intent record;
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_from_status text;
  v_intent_status text;
  v_payment_status text;
  v_request_payload jsonb;
  v_response_payload jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) < 8
    OR p_settlement_intent_id IS NULL
    OR p_payment_attempt_id IS NULL
    OR p_provider_idempotency_key IS NULL OR btrim(p_provider_idempotency_key) = ''
    OR p_provider_request_fingerprint IS NULL OR btrim(p_provider_request_fingerprint) = ''
    OR p_attempt_status NOT IN ('sent_to_provider', 'requires_action', 'processing')
  THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_next_action_kind IS NOT NULL
    AND p_next_action_kind NOT IN ('redirect', '3ds_challenge', 'qr_code', 'blik_code_prompt', 'sca_required')
  THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_invalid_next_action' USING ERRCODE = '22023';
  END IF;

  v_request_payload := COALESCE(p_request_payload, '{}'::jsonb);
  v_response_payload := COALESCE(p_response_payload, '{}'::jsonb);
  v_request_fingerprint := md5(
    p_settlement_intent_id::text || '|' ||
    p_payment_attempt_id::text || '|' ||
    p_provider_idempotency_key || '|' ||
    p_provider_request_fingerprint || '|' ||
    COALESCE(p_provider_attempt_id, '') || '|' ||
    COALESCE(p_provider_session_id, '') || '|' ||
    p_attempt_status || '|' ||
    COALESCE(p_next_action_kind, '') || '|' ||
    v_request_payload::text || '|' ||
    v_response_payload::text
  );

  PERFORM public.payment_provider_lock_aggregate(p_settlement_intent_id);

  SELECT *
    INTO v_existing
    FROM public.payment_provider_receipts
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      SELECT *
        INTO v_attempt
        FROM public.payment_provider_attempts
       WHERE id = p_payment_attempt_id;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'contractVersion', 'commerce.v0',
          'paymentAttempt', jsonb_build_object(
            'id', v_attempt.id,
            'paymentIntentId', v_attempt.settlement_intent_id,
            'status', v_attempt.status,
            'provider', v_attempt.provider,
            'providerAttemptId', v_attempt.provider_attempt_id,
            'providerSessionId', v_attempt.provider_session_id,
            'nextActionKind', v_attempt.next_action_kind,
            'idempotencyKey', p_idempotency_key,
            'replayed', true
          )
        );
      END IF;

      RETURN jsonb_set(v_existing.response_payload, '{paymentAttempt,replayed}', 'true'::jsonb, false);
    END IF;

    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.payment_provider_attempts
   WHERE id = p_payment_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_attempt_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.settlement_intent_id IS DISTINCT FROM p_settlement_intent_id THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_intent_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.status <> 'created' THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_not_prepared' USING ERRCODE = '22023';
  END IF;
  IF v_attempt.request_payload ->> 'providerIdempotencyKey' IS DISTINCT FROM p_provider_idempotency_key
    OR v_attempt.request_payload ->> 'providerRequestFingerprint' IS DISTINCT FROM p_provider_request_fingerprint
  THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_fingerprint_mismatch' USING ERRCODE = '23505';
  END IF;

  SELECT ps.*,i.amount_minor,i.currency_code AS currency,i.order_id,i.status AS settlement_status
    INTO v_intent FROM public.payment_provider_states ps
    JOIN public.commerce_settlement_intents i ON i.id=ps.id
    WHERE ps.id=p_settlement_intent_id FOR UPDATE OF ps;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_intent_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_intent.active_attempt_id IS DISTINCT FROM v_attempt.id THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_active_attempt_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_intent.status IN ('succeeded', 'cancelled', 'refunded', 'partially_refunded', 'disputed') OR v_intent.settlement_status IN ('settled','cancelled') THEN
    RAISE EXCEPTION 'payment_control_provider_attempt_finalize_intent_terminal' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_provider_receipts (
    scope,
    idempotency_key,
    request_fingerprint,
    status,
    metadata
  )
  VALUES (
    v_scope,
    p_idempotency_key,
    v_request_fingerprint,
    'in_progress',
    jsonb_build_object('boundary', 'payment_provider_attempt_finalize')
  );

  v_from_status := v_attempt.status;
  UPDATE public.payment_provider_attempts
     SET provider_attempt_id = p_provider_attempt_id,
         provider_session_id = p_provider_session_id,
         status = p_attempt_status,
         next_action_kind = p_next_action_kind,
         request_payload = request_payload || v_request_payload,
         response_payload = response_payload || v_response_payload || jsonb_build_object('providerCall', true),
         updated_at = now()
   WHERE id = v_attempt.id
   RETURNING * INTO v_attempt;

  v_intent_status := CASE WHEN p_attempt_status = 'requires_action' THEN 'requires_action' ELSE 'processing' END;
  v_payment_status := CASE WHEN p_attempt_status = 'requires_action' THEN 'requires_action' ELSE 'pending' END;

  UPDATE public.payment_provider_states
     SET status = v_intent_status,
         updated_at = now()
   WHERE id = v_intent.id;

  UPDATE public.payment_provider_states
     SET payment_status = v_payment_status,
         provider = v_attempt.provider,
         provider_payment_id = COALESCE(p_provider_attempt_id, provider_payment_id),
         metadata = metadata || jsonb_build_object(
           'paymentIntentId', v_intent.id,
           'paymentAttemptId', v_attempt.id,
           'source', 'payment.control.v0'
         ),
         updated_at = now()
   WHERE payment_id = v_intent.payment_id;

  INSERT INTO public.outbox_events (
    aggregate_type,
    aggregate_id,
    event_type,
    idempotency_key,
    payload,
    metadata
  )
  VALUES (
    'commerce_payment_intent',
    v_intent.id,
    'commerce.payment_attempt.requested',
    p_idempotency_key,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'paymentAttemptId', v_attempt.id,
      'provider', v_attempt.provider,
      'attemptStatus', p_attempt_status,
      'providerCall', true,
      'amountCents', v_intent.amount_minor,
      'currency', v_intent.currency
    ),
    jsonb_build_object('boundary', 'payment_provider_attempt_finalize')
  )
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;

  INSERT INTO public.payment_provider_transitions (
    settlement_intent_id,
    payment_attempt_id,
    transition_kind,
    from_status,
    to_status,
    reason,
    idempotency_key,
    payload
  )
  VALUES (
    v_intent.id,
    v_attempt.id,
    'attempt',
    v_from_status,
    p_attempt_status,
    'provider_attempt_finalized',
    p_idempotency_key || ':attempt_finalized',
    jsonb_build_object(
      'provider', v_attempt.provider,
      'providerAttemptId', p_provider_attempt_id,
      'providerCall', true
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentAttempt', jsonb_build_object(
      'id', v_attempt.id,
      'paymentIntentId', v_intent.id,
      'status', v_attempt.status,
      'provider', v_attempt.provider,
      'providerAttemptId', v_attempt.provider_attempt_id,
      'providerSessionId', v_attempt.provider_session_id,
      'nextActionKind', v_attempt.next_action_kind,
      'idempotencyKey', p_idempotency_key,
      'replayed', false
    )
  );

  UPDATE public.payment_provider_receipts
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object('paymentIntentId', v_intent.id, 'paymentAttemptId', v_attempt.id)
   WHERE scope = v_scope
     AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

CREATE FUNCTION public.payment_provider_event_ingest(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_payment_id text,
  p_settlement_intent_id uuid,
  p_payment_attempt_id uuid,
  p_amount_minor integer,
  p_currency text,
  p_signature_verified boolean,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attempt public.payment_provider_attempts%ROWTYPE;
  v_settlement_intent_id uuid := p_settlement_intent_id;
  v_payment_attempt_id uuid := p_payment_attempt_id;
  v_event public.payment_provider_attempt_evidence%ROWTYPE;
  v_replayed boolean := false;
  v_truth jsonb := p_payload -> '__paymentTruth';
  v_event_fingerprint text := v_truth ->> 'fingerprint';
  v_source_evidence jsonb := COALESCE(v_truth -> 'evidence', '{}'::jsonb);
BEGIN
  IF p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_event_id IS NULL OR btrim(p_provider_event_id) = ''
    OR p_event_type NOT IN (
      'payment.requires_action',
      'payment.succeeded',
      'payment.failed',
      'payment.refunded',
      'payment.disputed',
      'setup.succeeded',
      'setup.failed',
      'setup.requires_action'
    )
    OR p_signature_verified IS DISTINCT FROM true
    OR (v_truth IS NOT NULL AND jsonb_typeof(v_truth) <> 'object')
    OR (v_event_fingerprint IS NOT NULL AND v_event_fingerprint !~ '^[0-9a-f]{64}$')
    OR (v_truth IS NOT NULL AND (
      v_event_fingerprint IS NULL
      OR jsonb_typeof(v_source_evidence) <> 'object'
    ))
  THEN
    RAISE EXCEPTION 'payment_control_event_invalid_or_unverified' USING ERRCODE = '22023';
  END IF;

  IF v_payment_attempt_id IS NULL AND p_provider_payment_id IS NOT NULL THEN
    SELECT *
      INTO v_attempt
      FROM public.payment_provider_attempts
     WHERE provider = p_provider
       AND provider_attempt_id = p_provider_payment_id
     ORDER BY created_at DESC
     LIMIT 1;

    IF FOUND THEN
      v_payment_attempt_id := v_attempt.id;
      v_settlement_intent_id := COALESCE(v_settlement_intent_id, v_attempt.settlement_intent_id);
    END IF;
  END IF;

  INSERT INTO public.payment_provider_attempt_evidence (
    provider,
    provider_event_id,
    event_type,
    processing_status,
    payload,
    error,
    settlement_intent_id,
    payment_attempt_id,
    provider_payment_id,
    amount_minor,
    currency,
    signature_verified,
    received_via,
    event_fingerprint,
    source_evidence
  )
  VALUES (
    p_provider,
    p_provider_event_id,
    p_event_type,
    'received',
    COALESCE(p_payload, '{}'::jsonb) - '__paymentTruth',
    '{}'::jsonb,
    v_settlement_intent_id,
    v_payment_attempt_id,
    p_provider_payment_id,
    p_amount_minor,
    p_currency,
    true,
    'payment.control.v0',
    v_event_fingerprint,
    v_source_evidence
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    v_replayed := true;
    SELECT *
      INTO v_event
      FROM public.payment_provider_attempt_evidence
     WHERE provider = p_provider
       AND provider_event_id = p_provider_event_id
     FOR UPDATE;

    IF v_event.event_fingerprint IS NOT NULL
      AND v_event_fingerprint IS NOT NULL
      AND v_event_fingerprint IS DISTINCT FROM v_event.event_fingerprint
    THEN
      RAISE EXCEPTION 'commerce_payment_event_idempotency_conflict'
        USING ERRCODE = '23505';
    END IF;

    IF v_event.event_fingerprint IS NULL AND v_event_fingerprint IS NOT NULL THEN
      UPDATE public.payment_provider_attempt_evidence
         SET event_fingerprint = v_event_fingerprint,
             source_evidence = v_source_evidence
       WHERE id = v_event.id
       RETURNING * INTO v_event;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'paymentEvent', jsonb_build_object(
      'id', v_event.id,
      'provider', p_provider,
      'providerEventId', p_provider_event_id,
      'eventType', p_event_type,
      'paymentIntentId', v_event.settlement_intent_id,
      'paymentAttemptId', v_event.payment_attempt_id,
      'eventFingerprint', v_event.event_fingerprint,
      'occurredAt', v_event.source_evidence->>'observedAt',
      'replayed', v_replayed
    )
  );
END;
$$;

CREATE FUNCTION public.payment_provider_assert_truth(p_intent_id uuid,p_outcome text,p_amount bigint,p_currency text,p_at timestamptz,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents%ROWTYPE; s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE; e public.payment_provider_attempt_evidence%ROWTYPE;
BEGIN
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id;
 IF i.channel_key NOT IN ('stripe','tpay') AND NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=i.id) THEN RETURN; END IF;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF p_evidence->>'sourceKind'='execution_response' THEN
  IF p_evidence->>'sourceReference' IS DISTINCT FROM a.id::text
   OR p_evidence->>'attemptRef' IS DISTINCT FROM a.id::text
   OR p_amount IS DISTINCT FROM i.amount_minor OR p_currency IS DISTINCT FROM i.currency_code
   OR p_evidence->>'payloadFingerprint' IS DISTINCT FROM encode(sha256(convert_to(a.response_payload::text,'UTF8')),'hex')
   OR p_outcome NOT IN ('captured','refused')
   OR (p_evidence->>'observedAt')::timestamptz IS DISTINCT FROM p_at THEN
   RAISE EXCEPTION 'payment_control_result_evidence_mismatch' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id::text=p_evidence->>'sourceReference';
 IF NOT FOUND OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
  RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
 IF e.payment_attempt_id IS NULL THEN RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
 IF e.payment_attempt_id IS DISTINCT FROM a.id OR p_evidence->>'attemptRef' IS DISTINCT FROM a.id::text THEN
  RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
 IF e.signature_verified IS DISTINCT FROM true OR e.provider IS DISTINCT FROM a.provider
  OR e.provider_payment_id IS DISTINCT FROM a.provider_attempt_id
  OR p_amount IS DISTINCT FROM i.amount_minor OR p_currency IS DISTINCT FROM i.currency_code
  OR (e.amount_minor>0 AND e.amount_minor<>i.amount_minor) OR (e.currency IS NOT NULL AND e.currency<>i.currency_code)
  OR p_outcome IS DISTINCT FROM (CASE e.event_type WHEN 'payment.succeeded' THEN 'captured' WHEN 'payment.failed' THEN 'refused' ELSE 'indeterminate' END)
  OR p_evidence->>'payloadFingerprint' IS DISTINCT FROM COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))
  OR p_evidence->>'sourceKind' IS DISTINCT FROM 'accepted_event'
  OR (p_evidence->>'observedAt')::timestamptz IS DISTINCT FROM p_at THEN
  RAISE EXCEPTION 'payment_control_result_evidence_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;
CREATE FUNCTION public.payment_provider_result_apply(
 p_idempotency_key text,p_payment_intent_id uuid,p_payment_event_id uuid,p_result_status text,
 p_occurred_at timestamptz,p_failure_reason text,p_failure_class text,p_failure_class_decided_by text,
 p_dunning_template_slug text,p_recovery_url_path text,p_recovery_template_slug text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE fingerprint text; legacy_fingerprint text; receipt public.payment_provider_receipts%ROWTYPE;
 i public.commerce_settlement_intents%ROWTYPE; s public.payment_provider_states%ROWTYPE;
 a public.payment_provider_attempts%ROWTYPE; e public.payment_provider_attempt_evidence%ROWTYPE;
 o public.commerce_orders%ROWTYPE; kind text:='state_changed'; answer jsonb; truth jsonb; evidence jsonb;
 outcome text; native_failure text; from_status text; held record;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR length(p_idempotency_key)<8
  OR p_payment_intent_id IS NULL OR p_result_status IS NULL OR p_result_status NOT IN ('succeeded','failed','expired','refunded','partially_refunded','disputed')
  OR p_occurred_at IS NULL THEN RAISE EXCEPTION 'payment_control_result_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id;
  IF FOUND AND e.settlement_intent_id=p_payment_intent_id AND e.payment_attempt_id IS NULL THEN
   RAISE EXCEPTION 'payment_control_result_attempt_unresolved' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM public.payment_provider_lock_aggregate(p_payment_intent_id);
 legacy_fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,''));
 fingerprint:=md5(p_payment_intent_id::text||'|'||COALESCE(p_payment_event_id::text,'')||'|'||p_result_status||'|'||p_occurred_at::text||'|'||COALESCE(p_failure_reason,'')||CASE WHEN p_failure_class IS NULL THEN '' ELSE '|failure_class='||p_failure_class END);
 SELECT * INTO receipt FROM public.payment_provider_receipts WHERE scope='commerce.payment_result.apply' AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.status='completed' AND receipt.response_payload IS NOT NULL AND
   (receipt.request_fingerprint=fingerprint OR (p_failure_class IS NOT NULL AND receipt.request_fingerprint=legacy_fingerprint AND EXISTS(
    SELECT 1 FROM public.payment_provider_attempts WHERE id=NULLIF(receipt.metadata->>'paymentAttemptId','')::uuid AND failure_class=p_failure_class))) THEN
   RETURN jsonb_set(receipt.response_payload,'{paymentResult,replayed}','true'::jsonb,false); END IF;
  RAISE EXCEPTION 'payment_control_result_idempotency_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_payment_intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_intent_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.payment_provider_states WHERE id=i.id FOR UPDATE;
 SELECT * INTO a FROM public.payment_provider_attempts WHERE id=s.active_attempt_id AND settlement_intent_id=i.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_active_attempt_not_found' USING ERRCODE='22023'; END IF;
 IF p_payment_event_id IS NOT NULL THEN
  SELECT * INTO e FROM public.payment_provider_attempt_evidence WHERE id=p_payment_event_id FOR UPDATE;
  IF NOT FOUND OR e.settlement_intent_id IS DISTINCT FROM i.id THEN
   RAISE EXCEPTION 'payment_control_result_event_mismatch' USING ERRCODE='22023'; END IF;
  IF e.payment_attempt_id IS DISTINCT FROM a.id THEN
   RAISE EXCEPTION 'payment_control_result_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF e.amount_minor>0 AND e.amount_minor<>i.amount_minor AND (p_result_status NOT IN ('refunded','partially_refunded') OR e.provider='stripe') THEN
   RAISE EXCEPTION 'payment_control_result_amount_mismatch' USING ERRCODE='22023'; END IF;
  IF e.currency IS NOT NULL AND e.currency<>i.currency_code THEN
   RAISE EXCEPTION 'payment_control_result_currency_mismatch' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=i.order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_control_result_order_not_found' USING ERRCODE='22023'; END IF;
 from_status:=s.status;
 IF p_result_status='succeeded' THEN
  IF s.status IN ('cancelled','refunded','partially_refunded','disputed') OR i.status='cancelled' THEN
   RAISE EXCEPTION 'payment_control_result_terminal_intent' USING ERRCODE='22023'; END IF;
 ELSIF p_result_status IN ('failed','expired') THEN
  IF s.status IN ('succeeded','refunded','partially_refunded','disputed') THEN kind:='ignored_failure_after_success_or_terminal';
  ELSIF s.target_kind='subscription_cycle' AND EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=s.subscription_cycle_id AND status IN ('skipped','cancelled') FOR UPDATE) THEN
   UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=COALESCE(p_failure_reason,p_result_status),updated_at=now() WHERE id=a.id;
   UPDATE public.payment_provider_states SET payment_status=p_result_status,metadata=metadata||jsonb_build_object('paymentStatus',p_result_status,'failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),updated_at=now() WHERE id=s.id;
   kind:='ignored_failure_terminalized_cycle';
  ELSIF s.status=p_result_status AND a.status=p_result_status THEN kind:='ignored_duplicate_terminal_failure'; END IF;
 ELSE
  -- Reversal evidence is retained by ingress. Its financial interpretation is a
  -- separate installed capability; no service lifecycle action is implied.
  RAISE EXCEPTION 'native_cumulative_refund_unsupported' USING ERRCODE='22023';
 END IF;
 IF kind='state_changed' THEN
  outcome:=CASE WHEN p_result_status='succeeded' THEN 'captured' ELSE 'refused' END;
  native_failure:=CASE WHEN outcome='refused' THEN CASE WHEN p_failure_class IN ('authorization_refused','insufficient_funds','method_unavailable','risk_refused','unknown_refusal') THEN p_failure_class ELSE 'unknown_refusal' END END;
  evidence:=CASE WHEN p_payment_event_id IS NULL THEN
   jsonb_build_object('sourceKind','execution_response','sourceReference',a.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',encode(sha256(convert_to(a.response_payload::text,'UTF8')),'hex'))
   ELSE jsonb_build_object('sourceKind','accepted_event','sourceReference',e.id,'attemptRef',a.id,
    'observedStatus',p_result_status,'observedAt',p_occurred_at,'payloadFingerprint',COALESCE(e.event_fingerprint,encode(sha256(convert_to(e.payload::text,'UTF8')),'hex'))) END;
  PERFORM public.payment_provider_assert_truth(i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,evidence);
  IF NOT (p_result_status='succeeded' AND i.status='settled') THEN
   truth:=public.payment_truth_ingest_event('provider:'||COALESCE(e.id::text,p_idempotency_key),encode(sha256(convert_to(jsonb_build_object('eventId',e.id,'intentId',i.id,'attemptId',a.id,'outcome',outcome)::text,'UTF8')),'hex'),
    p_idempotency_key||':truth',i.id,outcome,i.amount_minor,i.currency_code,p_occurred_at,native_failure,p_failure_reason,evidence,p_dunning_template_slug,p_recovery_url_path,p_recovery_template_slug);
  END IF;
  UPDATE public.payment_provider_states SET status=p_result_status,payment_status=p_result_status,
   provider_payment_id=CASE WHEN p_result_status='succeeded' THEN COALESCE(e.provider_payment_id,provider_payment_id) ELSE provider_payment_id END,
   failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=s.id;
  UPDATE public.payment_provider_attempts SET status=p_result_status,failure_reason=CASE WHEN p_result_status='succeeded' THEN NULL ELSE COALESCE(p_failure_reason,p_result_status) END,updated_at=now() WHERE id=a.id;
  IF p_result_status IN ('failed','expired') AND o.subscription_cycle_id IS NULL THEN
   IF p_result_status='failed' THEN
    UPDATE public.commerce_orders SET metadata=metadata||jsonb_build_object(
     'paymentStatus','declined','failureReason',COALESCE(p_failure_reason,p_result_status),
     'lastDeclineAt',p_occurred_at,'recoverable',true,'source','payment.control.v0'),updated_at=now() WHERE id=o.id;
    INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES('commerce_order',o.id,'commerce.payment.failed','payment_failed:'||o.id,
     jsonb_build_object('orderId','order_'||o.id,'orderUuid',o.id,'totalCents',o.total_amount_minor,
      'currency',o.currency_code,'occurredAt',p_occurred_at),
     jsonb_build_object('source','payment_provider_result_apply_recoverable_decline'))
    ON CONFLICT (event_type,idempotency_key) DO NOTHING;
    kind:='recoverable_decline';
   ELSE
    UPDATE public.commerce_orders SET status='expired',metadata=metadata||jsonb_build_object(
     'paymentStatus','expired','failureReason',COALESCE(p_failure_reason,p_result_status),'source','payment.control.v0'),
     updated_at=now() WHERE id=o.id;
    FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
     WHERE purchase_order_id=o.id AND status='held' ORDER BY id FOR UPDATE LOOP
     PERFORM public.fulfillment_release_purchase_reservation(
      'payment-expired:'||held.id,held.id,'payment_expired','{}'::jsonb,p_occurred_at);
    END LOOP;
   END IF;
  END IF;
 END IF;
 IF p_failure_class IS NOT NULL THEN
  UPDATE public.payment_provider_attempts SET failure_class=p_failure_class,response_payload=response_payload||
   CASE WHEN p_failure_class_decided_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('failureClassDecidedBy',p_failure_class_decided_by) END WHERE id=a.id;
 END IF;
 IF p_payment_event_id IS NOT NULL THEN
  UPDATE public.payment_provider_attempt_evidence SET processed_at=now(),processing_status=CASE WHEN kind LIKE 'ignored%' THEN 'ignored' ELSE 'processed' END WHERE id=e.id;
 END IF;
 INSERT INTO public.payment_provider_transitions(settlement_intent_id,payment_attempt_id,provider_event_id,transition_kind,from_status,to_status,reason,idempotency_key,occurred_at,payload)
 VALUES(i.id,a.id,p_payment_event_id,'business_result',from_status,p_result_status,kind,p_idempotency_key||':payment_result',p_occurred_at,jsonb_build_object('orderId',o.id,'resultStatus',p_result_status,'source','payment.control.v0'));
 answer:=jsonb_build_object('contractVersion','commerce.v0','paymentResult',jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id,'paymentId',s.payment_id,'orderId',o.id,'status',p_result_status,'kind',kind,'idempotencyKey',p_idempotency_key,'replayed',false));
 INSERT INTO public.payment_provider_receipts(scope,idempotency_key,request_fingerprint,status,response_payload,metadata)
 VALUES('commerce.payment_result.apply',p_idempotency_key,fingerprint,'completed',answer,jsonb_build_object('paymentIntentId',i.id,'paymentAttemptId',a.id));
 RETURN answer;
END;
$$;


CREATE OR REPLACE FUNCTION public.payment_simulator_begin_attempt(p_request_key text,p_intent_id uuid,p_fingerprint text,p_method_facts jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i public.commerce_settlement_intents%ROWTYPE; o public.commerce_orders%ROWTYPE;
 a public.payment_simulator_attempts%ROWTYPE; facts jsonb;
BEGIN
 IF p_request_key IS NULL OR char_length(btrim(p_request_key))<8 OR p_fingerprint IS NULL
  OR p_fingerprint !~ '^[0-9a-f]{64}$' OR p_at IS NULL OR NOT isfinite(p_at)
  OR p_method_facts IS NULL OR jsonb_typeof(p_method_facts)<>'object' THEN
  RAISE EXCEPTION 'payment_simulator_input_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_simulator_intent_not_found' USING ERRCODE='22023'; END IF;
 IF i.channel_key<>'sandbox' THEN RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_provider_lock_aggregate(p_intent_id);
 SELECT * INTO o FROM public.commerce_orders WHERE id=i.order_id FOR UPDATE;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE request_key=p_request_key;
 IF FOUND THEN
  IF a.settlement_intent_id IS DISTINCT FROM p_intent_id OR a.request_fingerprint IS DISTINCT FROM p_fingerprint
    OR (p_method_facts<>'{}'::jsonb AND p_method_facts IS DISTINCT FROM
      (public.payment_simulator_read_attempt(p_intent_id,a.id)->'methodFacts')) THEN
    RAISE EXCEPTION 'payment_simulator_request_conflict' USING ERRCODE='23505'; END IF;
  RETURN public.payment_simulator_read_attempt(p_intent_id,a.id)||jsonb_build_object('replayed',true);
 END IF;
 IF o.status<>'pending_payment' OR i.status='settled' THEN
  RAISE EXCEPTION 'payment_simulator_order_not_payable' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE settlement_intent_id=p_intent_id AND is_active FOR UPDATE;
 IF FOUND AND a.state NOT IN ('refused','expired') THEN
  RAISE EXCEPTION 'payment_simulator_attempt_unresolved' USING ERRCODE='22023'; END IF;
 IF a.id IS NOT NULL AND EXISTS(SELECT 1 FROM public.payment_truth_events e
   WHERE e.settlement_intent_id=p_intent_id AND e.state='open' AND e.review_required_at IS NULL
     AND e.outcome='indeterminate' AND e.source_evidence->>'attemptRef'=a.id::text) THEN
  RAISE EXCEPTION 'payment_simulator_truth_unresolved' USING ERRCODE='22023'; END IF;
 facts:=CASE WHEN p_method_facts='{}'::jsonb THEN jsonb_build_object(
  'authorizationRef','sandbox:authorization:'||p_intent_id,
  'unattendedChargeAuthorizedAt',p_at,'payerAccountRef','sandbox:payer:'||o.client_id,
  'methodRef','sandbox:method:'||o.client_id,'methodEvidenceRef','sandbox:method-evidence:'||p_intent_id)
 ELSE p_method_facts END;
 IF (SELECT count(*) FROM jsonb_object_keys(facts))<>5
  OR NOT (facts ?& ARRAY['authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef','methodRef','methodEvidenceRef'])
  OR COALESCE(facts->>'authorizationRef','') NOT LIKE 'sandbox:%'
  OR COALESCE(facts->>'methodRef','') NOT LIKE 'sandbox:%'
  OR COALESCE(facts->>'methodEvidenceRef','') NOT LIKE 'sandbox:%'
  OR (facts->>'payerAccountRef' IS NOT NULL AND facts->>'payerAccountRef' NOT LIKE 'sandbox:%')
  OR (facts->>'unattendedChargeAuthorizedAt') IS NULL
  OR NOT isfinite((facts->>'unattendedChargeAuthorizedAt')::timestamptz) THEN
  RAISE EXCEPTION 'payment_simulator_method_facts_invalid' USING ERRCODE='22023'; END IF;
 UPDATE public.payment_simulator_attempts SET is_active=false,updated_at=p_at WHERE id=a.id;
 INSERT INTO public.payment_simulator_attempts(settlement_intent_id,request_key,request_fingerprint,dispatched_at,updated_at,
  authorization_ref,unattended_charge_authorized_at,payer_account_ref,method_ref,method_evidence_ref)
 VALUES(p_intent_id,p_request_key,p_fingerprint,p_at,p_at,facts->>'authorizationRef',
  (facts->>'unattendedChargeAuthorizedAt')::timestamptz,facts->>'payerAccountRef',facts->>'methodRef',facts->>'methodEvidenceRef') RETURNING * INTO a;
 RETURN public.payment_simulator_read_attempt(p_intent_id,a.id)||jsonb_build_object('replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_simulator_record_observation(p_attempt_id uuid,p_event_key text,p_fingerprint text,p_outcome text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public.payment_simulator_attempts%ROWTYPE; e public.payment_simulator_observations%ROWTYPE; order_id uuid;
BEGIN
 IF p_event_key IS NULL OR char_length(btrim(p_event_key))<8 OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('captured','refused','expired','indeterminate') OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RAISE EXCEPTION 'payment_simulator_observation_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE id=p_attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'wrong_attempt' USING ERRCODE='22023'; END IF;
 SELECT i.order_id INTO order_id FROM public.commerce_settlement_intents i WHERE i.id=a.settlement_intent_id AND i.channel_key='sandbox';
 IF NOT FOUND THEN RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 PERFORM public.payment_provider_lock_aggregate(a.settlement_intent_id);
 PERFORM 1 FROM public.commerce_orders WHERE id=order_id FOR UPDATE;
 PERFORM 1 FROM public.commerce_settlement_intents WHERE id=a.settlement_intent_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE id=p_attempt_id FOR UPDATE;
 SELECT * INTO e FROM public.payment_simulator_observations WHERE event_key=p_event_key;
 IF FOUND THEN
  IF e.attempt_id IS DISTINCT FROM a.id OR e.event_fingerprint IS DISTINCT FROM p_fingerprint
   OR e.outcome IS DISTINCT FROM p_outcome OR e.occurred_at IS DISTINCT FROM p_at THEN
   RAISE EXCEPTION 'payment_simulator_observation_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('id',e.id,'replayed',true);
 END IF;
 IF NOT a.is_active THEN RAISE EXCEPTION 'wrong_attempt' USING ERRCODE='22023'; END IF;
 IF a.state='captured' OR (a.state IN ('refused','expired') AND p_outcome<>'captured') THEN
  RAISE EXCEPTION 'payment_simulator_terminal_observation' USING ERRCODE='22023'; END IF;
 INSERT INTO public.payment_simulator_observations(attempt_id,event_key,event_fingerprint,outcome,occurred_at)
 VALUES(a.id,p_event_key,p_fingerprint,p_outcome,p_at) RETURNING * INTO e;
 UPDATE public.payment_simulator_attempts SET state=p_outcome,last_observation_id=e.id,updated_at=p_at WHERE id=a.id;
 RETURN jsonb_build_object('id',e.id,'replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_ingest_event(
  p_source_event_id text,
  p_event_fingerprint text,
  p_idempotency_key text,
  p_settlement_intent_id uuid,
  p_outcome text,
  p_amount_minor bigint,
  p_currency_code text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
BEGIN
  IF p_source_event_id IS NULL OR btrim(p_source_event_id) = ''
    OR p_event_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_outcome NOT IN ('captured', 'refused', 'indeterminate')
    OR p_amount_minor IS NULL OR p_amount_minor < 1
    OR p_currency_code !~ '^[A-Z]{3}$'
    OR p_source_evidence IS NULL OR jsonb_typeof(p_source_evidence) <> 'object'
    OR (p_outcome = 'refused') IS DISTINCT FROM (p_failure_class IS NOT NULL)
    OR (p_failure_class IS NOT NULL AND p_failure_class NOT IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    ))
  THEN
    RAISE EXCEPTION 'payment_truth_event_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM public.payment_provider_lock_aggregate(p_settlement_intent_id);
  PERFORM 1 FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id) FOR UPDATE;
  PERFORM 1 FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id FOR UPDATE;
  SELECT * INTO v_event FROM public.payment_truth_events WHERE source_event_id=p_source_event_id FOR UPDATE;
  IF FOUND THEN
    IF v_event.event_fingerprint IS DISTINCT FROM p_event_fingerprint THEN
      RAISE EXCEPTION 'payment_truth_event_fingerprint_conflict' USING ERRCODE='23505'; END IF;
    RETURN public.payment_truth_readback(v_event.id,true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id AND channel_key='sandbox') THEN
    PERFORM public.payment_simulator_assert_truth(p_settlement_intent_id,p_outcome,p_amount_minor,p_currency_code,p_occurred_at,p_source_evidence);
  END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=p_settlement_intent_id AND channel_key='sandbox')
    AND p_source_event_id IS DISTINCT FROM 'sandbox:'||(p_source_evidence->>'sourceReference') THEN
    RAISE EXCEPTION 'payment_simulator_event_identity_mismatch' USING ERRCODE='22023'; END IF;

  PERFORM public.payment_provider_assert_truth(p_settlement_intent_id,p_outcome,p_amount_minor,p_currency_code,p_occurred_at,p_source_evidence);

  INSERT INTO public.payment_truth_events (
    source_event_id, event_fingerprint, ingest_idempotency_key,
    settlement_intent_id, state, outcome, amount_minor, currency_code,
    failure_class, failure_reason, source_evidence, occurred_at, updated_at
  ) VALUES (
    p_source_event_id, p_event_fingerprint, p_idempotency_key,
    p_settlement_intent_id, 'open', p_outcome, p_amount_minor, p_currency_code,
    p_failure_class, p_failure_reason, p_source_evidence, p_occurred_at, p_occurred_at
  )
  ON CONFLICT ON CONSTRAINT payment_truth_events_source_event_id_key DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    SELECT * INTO v_event
    FROM public.payment_truth_events
    WHERE source_event_id = p_source_event_id
    FOR UPDATE;
    IF v_event.event_fingerprint IS DISTINCT FROM p_event_fingerprint THEN
      RAISE EXCEPTION 'payment_truth_event_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.payment_truth_readback(v_event.id, true);
  END IF;

  IF p_outcome IN ('captured', 'refused') THEN
    PERFORM public.payment_truth_apply_terminal(
      v_event.id, p_idempotency_key, p_outcome, p_occurred_at,
      p_failure_class, p_failure_reason, p_source_evidence,
      p_dunning_template_slug, p_recovery_url_path, p_recovery_template_slug
    );
  END IF;
  RETURN public.payment_truth_readback(v_event.id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_apply_terminal(
  p_event_id uuid,
  p_idempotency_key text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_settlement jsonb;
  v_dunning jsonb;
  v_accounting jsonb;
  v_positions jsonb;
  v_open_case_id uuid;
  v_transition_id uuid;
  v_dunning_case_id uuid;
  v_accounting_document_id uuid;
BEGIN
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id;
  PERFORM public.payment_provider_lock_aggregate(v_event.settlement_intent_id);
  PERFORM 1 FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id) FOR UPDATE;
  PERFORM 1 FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id FOR UPDATE;
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_truth_event_not_found' USING ERRCODE = '22023'; END IF;
  IF v_event.state = 'settled' OR v_event.review_required_at IS NOT NULL THEN RETURN; END IF;
  IF p_outcome NOT IN ('captured', 'refused') THEN
    RAISE EXCEPTION 'payment_truth_terminal_outcome_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'refused' AND p_failure_class IS NULL THEN
    RAISE EXCEPTION 'payment_truth_refusal_classification_required' USING ERRCODE = '22023';
  END IF;
  IF p_failure_class IS NOT NULL AND p_failure_class NOT IN (
    'authorization_refused', 'insufficient_funds', 'method_unavailable',
    'risk_refused', 'unknown_refusal'
  ) THEN
    RAISE EXCEPTION 'payment_truth_failure_class_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = v_event.settlement_intent_id;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_intent.order_id;
  IF v_intent.amount_minor IS DISTINCT FROM v_event.amount_minor
    OR v_intent.currency_code IS DISTINCT FROM v_event.currency_code
  THEN
    RAISE EXCEPTION 'payment_truth_settlement_money_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_intent.channel_key='sandbox' THEN
    PERFORM public.payment_simulator_assert_truth(v_intent.id,p_outcome,v_event.amount_minor,v_event.currency_code,p_occurred_at,p_source_evidence);
  END IF;
  PERFORM public.payment_provider_assert_truth(v_intent.id,p_outcome,v_event.amount_minor,v_event.currency_code,p_occurred_at,p_source_evidence);
  IF p_outcome='captured' AND v_order.status='cancelled' THEN
    UPDATE public.payment_truth_events SET outcome='captured',failure_class=NULL,failure_reason=NULL,
      review_required_at=now(),updated_at=now()
    WHERE id=v_event.id OR (v_intent.channel_key='sandbox' AND settlement_intent_id=v_intent.id
      AND state='open' AND review_required_at IS NULL AND outcome='indeterminate'
      AND source_evidence->>'attemptRef'=p_source_evidence->>'attemptRef');
    RETURN;
  END IF;

  v_settlement := public.commerce_record_settlement(
    p_idempotency_key || ':settlement',
    v_event.settlement_intent_id,
    CASE WHEN p_outcome = 'captured' THEN 'succeeded' ELSE 'failed' END,
    NULL,
    jsonb_build_object(
      'paymentTruthEventId', v_event.id,
      'sourceEvidence', COALESCE(p_source_evidence, '{}'::jsonb),
      'reason', p_failure_reason,
      'failureClass', p_failure_class
    ),
    p_occurred_at
  );
  v_transition_id := (v_settlement->>'transitionId')::uuid;

  IF p_outcome = 'captured' THEN
    -- Capture owed work only; no document construction or accounting call here.
    DECLARE v_capture_timeout text := current_setting('lock_timeout');
    BEGIN
      PERFORM set_config('lock_timeout', '100ms', true);
      PERFORM public.invoicing_capture_duty(
        p_idempotency_key || ':accounting', 'paid', v_transition_id, v_order.id,
        jsonb_build_object('settlementIntentId', v_intent.id, 'amountMinor', v_intent.amount_minor, 'currency', v_intent.currency_code),
        p_occurred_at
      );
      PERFORM set_config('lock_timeout', v_capture_timeout, true);
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      -- query_canceled during capture is absorbed so settlement/recovery commit.
      -- Append-only, no FK locks or conflicting unique key. The retained paid
      -- transition is also durable retry evidence if host ACLs deny this marker.
      BEGIN
        PERFORM set_config('lock_timeout','100ms',true);
        INSERT INTO public.invoicing_capture_faults(order_id,source_kind,source_id,attempts,state,available_at)
          VALUES(v_order.id,'paid',v_transition_id,1,'retryable',now());
        PERFORM set_config('lock_timeout',v_capture_timeout,true);
      EXCEPTION WHEN OTHERS OR query_canceled THEN NULL;
      END;
    END;

    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT id INTO v_open_case_id
      FROM public.subscription_dunning_cases
      WHERE cycle_id = v_order.subscription_cycle_id AND status = 'open'
      FOR UPDATE;
      IF v_open_case_id IS NOT NULL THEN
        PERFORM public.dunning_lifecycle_record_recovery(
          v_open_case_id, p_occurred_at, p_recovery_template_slug
        );
      END IF;
      -- Recovery also withdraws a decline notice already claimed by dispatch.
      UPDATE public.subscription_dunning_notifications
      SET status='skipped',error=COALESCE(error,'cycle_recovered'),settled_at=p_occurred_at,
        claim_token=NULL,lease_expires_at=NULL,updated_at=p_occurred_at
      WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=v_order.subscription_cycle_id)
        AND notification_kind='payment_failed'
        AND status IN ('queued','sending');
    END IF;
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT * INTO v_cycle
        FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id;
      SELECT * INTO v_subscription
        FROM public.subscriptions WHERE id = v_cycle.subscription_id;
      v_dunning := public.dunning_lifecycle_open_case(
        'payment-truth:dunning:' || v_cycle.id::text,
        v_subscription.id,
        v_cycle.id,
        v_subscription.client_id,
        1,
        NULL,
        p_failure_class,
        p_failure_reason,
        p_occurred_at,
        v_event.amount_minor,
        v_event.currency_code,
        p_dunning_template_slug,
        p_recovery_url_path
      );
      v_dunning_case_id := (v_dunning->>'caseId')::uuid;
    END IF;
  END IF;

  UPDATE public.payment_truth_events
  SET state = 'settled',
      outcome = p_outcome,
      failure_class = CASE WHEN p_outcome = 'refused' THEN p_failure_class ELSE NULL END,
      failure_reason = CASE WHEN p_outcome = 'refused' THEN p_failure_reason ELSE NULL END,
      settlement_transition_id = v_transition_id,
      dunning_case_id = v_dunning_case_id,
      accounting_document_id = v_accounting_document_id,
      settled_at = p_occurred_at,
      updated_at = p_occurred_at
  WHERE id = v_event.id;

  -- One verified terminal fact resolves older unknown facts for this same attempt.
  -- Share the transition; do not settle, notify or invoice a second time.
  IF v_intent.channel_key='sandbox' THEN
    UPDATE public.payment_truth_events
    SET state='settled',outcome=p_outcome,
      failure_class=CASE WHEN p_outcome='refused' THEN p_failure_class ELSE NULL END,
      failure_reason=CASE WHEN p_outcome='refused' THEN p_failure_reason ELSE NULL END,
      settlement_transition_id=v_transition_id,dunning_case_id=v_dunning_case_id,
      accounting_document_id=v_accounting_document_id,settled_at=p_occurred_at,updated_at=p_occurred_at
    WHERE id<>v_event.id AND settlement_intent_id=v_intent.id AND state='open'
      AND review_required_at IS NULL AND outcome='indeterminate'
      AND source_evidence->>'attemptRef'=p_source_evidence->>'attemptRef';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_truth_record_reconciliation(
  p_event_id uuid,
  p_idempotency_key text,
  p_evidence_fingerprint text,
  p_evidence_status text,
  p_outcome text,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_source_evidence jsonb,
  p_dunning_template_slug text,
  p_recovery_url_path text,
  p_recovery_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event public.payment_truth_events%ROWTYPE;
  v_evidence public.payment_truth_reconciliation_evidence%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_evidence_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_evidence_status NOT IN ('observed', 'failed')
    OR p_outcome NOT IN ('captured', 'refused', 'indeterminate')
    OR (p_evidence_status = 'failed' AND p_outcome <> 'indeterminate')
    OR (p_outcome = 'refused') IS DISTINCT FROM (p_failure_class IS NOT NULL)
    OR (p_failure_class IS NOT NULL AND p_failure_class NOT IN (
      'authorization_refused', 'insufficient_funds', 'method_unavailable',
      'risk_refused', 'unknown_refusal'
    ))
    OR p_source_evidence IS NULL OR jsonb_typeof(p_source_evidence) <> 'object'
  THEN
    RAISE EXCEPTION 'payment_truth_reconciliation_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id;
  PERFORM public.payment_provider_lock_aggregate(v_event.settlement_intent_id);
  PERFORM 1 FROM public.commerce_orders WHERE id=(SELECT order_id FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id) FOR UPDATE;
  PERFORM 1 FROM public.commerce_settlement_intents WHERE id=v_event.settlement_intent_id FOR UPDATE;
  SELECT * INTO v_event FROM public.payment_truth_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_truth_event_not_found' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.payment_truth_reconciliation_evidence (
    event_id, idempotency_key, evidence_fingerprint, evidence_status,
    outcome, failure_class, failure_reason, source_evidence, occurred_at
  ) VALUES (
    p_event_id, p_idempotency_key, p_evidence_fingerprint, p_evidence_status,
    p_outcome, p_failure_class, p_failure_reason, p_source_evidence, p_occurred_at
  )
  ON CONFLICT ON CONSTRAINT payment_truth_reconciliation_idempotency_key_key DO NOTHING
  RETURNING * INTO v_evidence;

  IF NOT FOUND THEN
    SELECT * INTO v_evidence
    FROM public.payment_truth_reconciliation_evidence
    WHERE idempotency_key = p_idempotency_key;
    IF v_evidence.event_id IS DISTINCT FROM p_event_id
      OR v_evidence.evidence_fingerprint IS DISTINCT FROM p_evidence_fingerprint
    THEN
      RAISE EXCEPTION 'payment_truth_reconciliation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.payment_truth_readback(v_event.id, true);
  END IF;

  UPDATE public.payment_truth_events
  SET last_reconciled_at = p_occurred_at, updated_at = p_occurred_at
  WHERE id = v_event.id;

  IF v_event.state = 'open' AND v_event.review_required_at IS NULL
    AND p_evidence_status = 'observed'
    AND p_outcome IN ('captured', 'refused')
  THEN
    PERFORM public.payment_truth_apply_terminal(
      v_event.id, p_idempotency_key, p_outcome, p_occurred_at,
      p_failure_class, p_failure_reason, p_source_evidence,
      p_dunning_template_slug, p_recovery_url_path, p_recovery_template_slug
    );
    UPDATE public.payment_truth_reconciliation_evidence
    SET applied_at = p_occurred_at WHERE id = v_evidence.id;
  END IF;

  RETURN public.payment_truth_readback(v_event.id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_record_settlement(
  p_idempotency_key text,
  p_intent_id uuid,
  p_outcome text,
  p_external_ref text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_from text;
  v_transition public.commerce_settlement_transitions%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_intent_id IS NULL
    OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed')
  THEN
    RAISE EXCEPTION 'commerce_settlement_record_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_settlement_record_intent_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_outcome='succeeded' THEN
    PERFORM public.payment_provider_lock_aggregate(p_intent_id);
  END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders WHERE id = v_intent.order_id FOR UPDATE;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = p_intent_id FOR UPDATE;

  SELECT * INTO v_transition
    FROM public.commerce_settlement_transitions
   WHERE intent_id = p_intent_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN public.commerce_settlement_response(v_intent, v_transition.id, v_transition.outcome, true);
  END IF;

  IF v_intent.status = 'settled' THEN
    RAISE EXCEPTION 'commerce_settlement_record_intent_already_settled' USING ERRCODE = '22023';
  END IF;

  -- Write-once, and compared rather than overwritten: a channel that hands back a different handle
  -- for the same intent is describing a different payment.
  IF v_intent.external_ref IS NOT NULL AND p_external_ref IS NOT NULL
    AND v_intent.external_ref IS DISTINCT FROM p_external_ref
  THEN
    RAISE EXCEPTION 'commerce_settlement_record_external_reference_immutable' USING ERRCODE = '22023';
  END IF;

  v_from := v_intent.status;

  IF p_outcome = 'succeeded' THEN
    -- An order somebody took off the table between the ask and the answer is not paid into. The
    -- money question then belongs to whoever cancelled it, and this kernel has no refund verb.
    IF v_order.status <> 'pending_payment' THEN
      RAISE EXCEPTION 'commerce_settlement_record_order_not_payable' USING ERRCODE = '22023';
    END IF;

    UPDATE public.commerce_settlement_intents
       SET status = 'settled',
           settled_at = p_occurred_at,
           external_ref = COALESCE(external_ref, p_external_ref),
           failure_reason = NULL,
           updated_at = p_occurred_at
     WHERE id = p_intent_id
     RETURNING * INTO v_intent;

    -- The order transition is the delegation onto the order rail: that rail owns `paid`, owns the
    -- notification it produces, and its emitter fires from this statement without this forward
    -- restating a single line of it.
    UPDATE public.commerce_orders
       SET status = 'paid', paid_at = p_occurred_at, updated_at = p_occurred_at
     WHERE id = v_intent.order_id
     RETURNING * INTO v_order;

    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT * INTO v_cycle
        FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'commerce_settlement_record_cycle_not_found' USING ERRCODE = '22023';
      END IF;
      IF v_cycle.status NOT IN ('planned', 'payment_pending') THEN
        RAISE EXCEPTION 'commerce_settlement_record_cycle_not_payable' USING ERRCODE = '22023';
      END IF;

      SELECT * INTO v_subscription
        FROM public.subscriptions WHERE id = v_cycle.subscription_id FOR UPDATE;

      UPDATE public.subscription_cycles
         SET status = 'paid', updated_at = p_occurred_at
       WHERE id = v_cycle.id;

      -- Departure 8, revised: one cadence past the cycle that was just paid for PLUS the whole
      -- days the payment itself was late -- so a recovery that took eleven days moves the next
      -- delivery out by eleven days instead of stacking it on top of the parcel just shipped.
      -- Whole days only, so an on-time settlement still lands on the original grid, to the
      -- second. The inner GREATEST refuses a negative shift for an early payment; LEAST bounds a
      -- channel that reports a future instant; the outer GREATEST is the invariant itself -- this
      -- date may extend and may never move earlier, whoever set the value it is replacing. A
      -- subscription nobody is running any more is not slid: settlement truth still applies to a
      -- cancelled subscription, but its schedule is not this function's to revive.
      UPDATE public.subscriptions
         SET next_cycle_at = GREATEST(
               next_cycle_at,
               v_cycle.scheduled_at + make_interval(days =>
                 GREATEST(0, floor(extract(epoch FROM
                   (LEAST(p_occurred_at, now()) - v_cycle.scheduled_at)) / 86400.0)::int)
                 + cadence_days)),
             updated_at = p_occurred_at
       WHERE id = v_subscription.id
         AND status = 'active';

      INSERT INTO public.subscription_events
        (subscription_id, event_type, idempotency_key, payload, occurred_at)
      VALUES (v_subscription.id, 'subscription.cycle_settled',
              p_idempotency_key || ':subscription',
              jsonb_build_object('cycleId', v_cycle.id, 'orderId', v_order.id,
                                 'settlementId', v_intent.id),
              p_occurred_at)
      ON CONFLICT (subscription_id, idempotency_key) DO NOTHING;
    END IF;
  ELSE
    -- Departure 4: the order is untouched, so it stays `pending_payment` and can be settled again.
    UPDATE public.commerce_settlement_intents
       SET status = 'failed',
           external_ref = COALESCE(external_ref, p_external_ref),
           failure_reason = COALESCE(NULLIF(btrim(COALESCE(p_metadata, '{}'::jsonb)->>'reason'), ''),
                                     'declined'),
           updated_at = p_occurred_at
     WHERE id = p_intent_id
     RETURNING * INTO v_intent;
  END IF;

  INSERT INTO public.commerce_settlement_transitions
    (intent_id, from_status, to_status, outcome, idempotency_key, payload, occurred_at)
  VALUES (p_intent_id, v_from, v_intent.status, p_outcome, p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_occurred_at)
  RETURNING * INTO v_transition;

  RETURN public.commerce_settlement_response(v_intent, v_transition.id, p_outcome, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_cancel_abandoned_purchase_checkout(
  p_idempotency_key text,p_order_id uuid,p_reason text,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  receipt public.fulfillment_purchase_reservation_receipts%ROWTYPE;
  target public.commerce_orders%ROWTYPE;
  command jsonb; answer jsonb; held record; released integer:=0; donor_key text;
  subscription_hint uuid; locked_subscription uuid; hint_found boolean;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
    OR length(btrim(p_idempotency_key))<8 OR p_order_id IS NULL
    OR p_reason IS NULL OR btrim(p_reason)='' OR length(p_reason)>180
    OR p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'commerce_checkout_compensation_invalid_input' USING ERRCODE='22023';
  END IF;
  command:=jsonb_build_object('action','cancel','orderId',p_order_id,'reason',p_reason);
  donor_key:='purchase-cancel:'||encode(sha256(convert_to(p_idempotency_key,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase-reservation:'||donor_key,0));
  SELECT * INTO receipt FROM public.fulfillment_purchase_reservation_receipts WHERE idempotency_key=donor_key;
  IF FOUND THEN
    IF receipt.command<>command THEN
      RAISE EXCEPTION 'fulfillment_purchase_reservation_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN receipt.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT COALESCE(c.subscription_id,a.subscription_id) INTO subscription_hint
    FROM public.commerce_orders o
    LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order_id;
  hint_found:=FOUND;
  IF subscription_hint IS NOT NULL THEN
    PERFORM 1 FROM public.subscriptions WHERE id=subscription_hint FOR UPDATE;
  END IF;
  SELECT * INTO target FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    answer:=jsonb_build_object('cancelled',false,'reason','order_not_found','orderStatus',NULL);
  ELSIF target.renewal_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_checkout_compensation_renewal_order_unsupported' USING ERRCODE='22023';
  ELSE
    SELECT COALESCE(c.subscription_id,a.subscription_id) INTO locked_subscription
      FROM public.commerce_orders o
      LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
      LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order_id;
    IF NOT hint_found OR locked_subscription IS DISTINCT FROM subscription_hint THEN
      RAISE EXCEPTION 'commerce_checkout_compensation_aggregate_changed' USING ERRCODE='55000';
    END IF;
    -- Root first, then every intent and attempt before their evidence.
    PERFORM id FROM public.commerce_settlement_intents WHERE order_id=p_order_id ORDER BY id FOR UPDATE;
    PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
      ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id ORDER BY a.id FOR UPDATE OF a;
    PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a
      ON a.id=e.attempt_id JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
      WHERE i.order_id=p_order_id ORDER BY e.id FOR UPDATE OF e;
    PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
      ON i.id=e.settlement_intent_id WHERE i.order_id=p_order_id ORDER BY e.id FOR UPDATE OF e;
  PERFORM a.id FROM public.payment_provider_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_provider_attempt_evidence e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=p_order_id ORDER BY e.id FOR UPDATE OF e;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order_id AND (pa.status='succeeded'
 OR EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence pe WHERE pe.settlement_intent_id=pa.settlement_intent_id
 AND pe.payment_attempt_id=pa.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
 AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded'))) THEN
      RETURN jsonb_build_object('cancelled',false,'reason','payment_already_moved','orderStatus',target.status);
  END IF;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order_id AND pa.status IN ('created','sent_to_provider','requires_action','processing')) THEN
      RETURN jsonb_build_object('cancelled',false,'reason','provider_attempt_in_flight');
  END IF;
    IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
      ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id AND a.state='dispatched') THEN
      RETURN jsonb_build_object('cancelled',false,'reason','provider_attempt_in_flight');
    END IF;
    IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
      ON i.id=a.settlement_intent_id WHERE i.order_id=p_order_id AND a.state IN ('captured','indeterminate')) THEN
      RETURN jsonb_build_object('cancelled',false,'reason','money_recorded','orderStatus',target.status);
    END IF;
    IF EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=p_order_id AND status='settled')
      OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
        ON i.id=e.settlement_intent_id WHERE i.order_id=p_order_id AND e.outcome IN ('captured','indeterminate')) THEN
      answer:=jsonb_build_object('cancelled',false,'reason','money_recorded','orderStatus',target.status);
    ELSE
      answer:=public.commerce_compensate_abandoned_checkout(donor_key,p_order_id,p_reason,p_now);
      IF answer->>'cancelled'='true' THEN
        FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
          WHERE purchase_order_id=p_order_id AND status='held' ORDER BY id FOR UPDATE LOOP
          PERFORM public.fulfillment_release_purchase_reservation(
            'cancel-release:'||encode(sha256(convert_to(p_idempotency_key||':'||held.id::text,'UTF8')),'hex'),
            held.id,p_reason,jsonb_build_object('compensationKey',p_idempotency_key),p_now);
          released:=released+1;
        END LOOP;
      END IF;
    END IF;
  END IF;
  answer:=answer||jsonb_build_object('releasedCount',released,'replayed',false);
  INSERT INTO public.fulfillment_purchase_reservation_receipts(idempotency_key,command,result,created_at)
    VALUES(donor_key,command,answer,p_now);
  RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.oms_cancel_unpaid_order_owned(p_key text,p_order uuid,p_reason text,p_actor uuid,p_metadata jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.commerce_orders%ROWTYPE;
  receipt public.commerce_order_operations%ROWTYPE;
  subscription_hint uuid; locked_subscription uuid; hint_found boolean;
  held record;
BEGIN
  IF p_key IS NULL OR char_length(btrim(p_key)) < 8 OR p_order IS NULL
    OR p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_input' USING ERRCODE='22023';
  END IF;
  -- Serialize the command key, including concurrent reuse across different orders.
  PERFORM pg_advisory_xact_lock(hashtextextended('oms-unpaid-cancel:'||p_key,0));
  -- The order is the common payment/checkout mutex. Settlement can lock a
  -- subscription after the order; checkout compensation can already hold its
  -- parent before requesting the order.
  -- This command never writes or locks that parent. Recheck its hinted binding
  -- after the order lock, then lock intents, attempts, observations and truth.
  SELECT COALESCE(c.subscription_id,a.subscription_id) INTO subscription_hint
    FROM public.commerce_orders o
    LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order;
  hint_found:=FOUND;
  SELECT * INTO target FROM public.commerce_orders WHERE id=p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'oms_cancel_unpaid_order_not_found' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(c.subscription_id,a.subscription_id) INTO locked_subscription
    FROM public.commerce_orders o
    LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
    LEFT JOIN public.subscription_activations a ON a.order_id=o.id WHERE o.id=p_order;
  IF NOT hint_found OR locked_subscription IS DISTINCT FROM subscription_hint THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_aggregate_changed' USING ERRCODE='55000';
  END IF;
  PERFORM id FROM public.commerce_settlement_intents WHERE order_id=p_order ORDER BY id FOR UPDATE;
  PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a
    ON a.id=e.attempt_id JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
    WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
    ON i.id=e.settlement_intent_id WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  PERFORM a.id FROM public.payment_provider_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=p_order ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_provider_attempt_evidence e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=p_order ORDER BY e.id FOR UPDATE OF e;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order AND (pa.status='succeeded'
 OR EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence pe WHERE pe.settlement_intent_id=pa.settlement_intent_id
 AND pe.payment_attempt_id=pa.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
 AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded'))) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_already_moved' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order AND pa.status IN ('created','sent_to_provider','requires_action','processing')) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_in_flight' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order AND a.state='dispatched') THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_in_flight' USING ERRCODE='23505';
  END IF;
  IF EXISTS(SELECT 1 FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i
    ON i.id=a.settlement_intent_id WHERE i.order_id=p_order AND a.state IN ('captured','indeterminate'))
    OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=p_order AND status='settled')
    OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
      ON i.id=e.settlement_intent_id WHERE i.order_id=p_order AND e.outcome IN ('captured','indeterminate')) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_payment_already_moved' USING ERRCODE='23505';
  END IF;
  SELECT * INTO receipt FROM public.commerce_order_operations WHERE idempotency_key=p_key;
  IF FOUND THEN
    IF receipt.operation_type <> 'order_cancelled' OR receipt.order_id IS DISTINCT FROM p_order
      OR receipt.payload->>'reason' IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'oms_cancel_unpaid_order_idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status',target.status,'replayed',true);
  END IF;
  IF target.status='cancelled' THEN
    RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status','cancelled','replayed',true);
  END IF;
  IF target.status<>'pending_payment' THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_status' USING ERRCODE='22023';
  END IF;
  IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_operators WHERE id=p_actor) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_actor_unknown' USING ERRCODE='23503';
  END IF;
  -- Native settlement intents represent cancelled unpaid work as failed. The
  -- cancelled order fences future attempts; late captures keep their review path.
  UPDATE public.commerce_settlement_intents SET status='failed',failure_reason='admin_oms_cancelled_unpaid_order',updated_at=p_at
    WHERE order_id=p_order AND status<>'settled';
  UPDATE public.commerce_orders SET status='cancelled',cancelled_at=p_at,updated_at=p_at,
    metadata=metadata||jsonb_build_object('cancellation',jsonb_build_object(
      'reason',p_reason,'actorId',p_actor,'request',COALESCE(p_metadata,'{}'::jsonb))) WHERE id=p_order;
  INSERT INTO public.commerce_order_operations(order_id,actor_id,operation_type,idempotency_key,payload,occurred_at)
    VALUES(p_order,p_actor,'order_cancelled',p_key,jsonb_build_object('reason',p_reason),p_at);
  -- The release primitive owns its key and row lock. Do not lock a reservation
  -- before that key, and do not release another order's or a renewal's stock.
  FOR held IN SELECT id FROM public.fulfillment_inventory_reservations
    WHERE purchase_order_id=p_order AND status='held' ORDER BY id LOOP
    PERFORM public.fulfillment_release_purchase_reservation(
      'oms-cancel-release:'||encode(sha256(convert_to(p_key||':'||held.id::text,'UTF8')),'hex'),
      held.id,p_reason,jsonb_build_object('operatorCancellationKey',p_key),p_at);
  END LOOP;
  RETURN jsonb_build_object('contractVersion','platform.oms.order.v1','orderId',p_order,'status','cancelled','replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_sweep_expired_checkouts(p_limit integer,p_policy jsonb,p_now timestamptz)
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
  PERFORM a.id FROM public.payment_provider_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=v_order.id ORDER BY a.id FOR UPDATE OF a;
  PERFORM e.id FROM public.payment_provider_attempt_evidence e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id WHERE i.order_id=v_order.id ORDER BY e.id FOR UPDATE OF e;
  IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=v_order.id AND (pa.status IN ('created','sent_to_provider','requires_action','processing','succeeded')
 OR EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence pe WHERE pe.settlement_intent_id=pa.settlement_intent_id
 AND pe.payment_attempt_id=pa.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
 AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded'))) THEN
   CONTINUE;
  END IF;
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

CREATE OR REPLACE FUNCTION public.commerce_checkout_recovery_payment_blocked(p_order_id uuid,p_activity_seconds integer,p_now timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id
 WHERE pi.order_id=p_order_id AND (pa.status IN ('created','sent_to_provider','requires_action','processing','succeeded')
 OR EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence pe WHERE pe.settlement_intent_id=pa.settlement_intent_id
 AND pe.payment_attempt_id=pa.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
 AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded'))) OR EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=p_order_id AND
  (i.status='settled' OR (i.status='created' AND i.updated_at>p_now-make_interval(secs=>p_activity_seconds))
   OR EXISTS (SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=i.id AND
    (a.state='captured' OR (a.state IN ('dispatched','indeterminate') AND a.updated_at>p_now-make_interval(secs=>p_activity_seconds))))
   OR EXISTS (SELECT 1 FROM public.payment_truth_events e WHERE e.settlement_intent_id=i.id AND
    (e.outcome='captured' OR (e.outcome='indeterminate' AND e.updated_at>p_now-make_interval(secs=>p_activity_seconds))))));
$$;

CREATE OR REPLACE FUNCTION public.commerce_initial_checkout_abandonment_safe(p_order_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.commerce_settlement_intents pi ON pi.id=pa.settlement_intent_id WHERE pi.order_id=p_order_id) AND NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=p_order_id AND
  (i.status='settled' OR i.external_ref IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=i.id)
   OR EXISTS(SELECT 1 FROM public.payment_truth_events e WHERE e.settlement_intent_id=i.id)));
$$;

CREATE OR REPLACE FUNCTION public.commerce_checkout_recovery_attempt_begin(p_request_key text,p_order_id uuid,p_client_id uuid,p_intent_id uuid,p_fingerprint text,p_method_facts jsonb,p_at timestamptz)
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
 IF i.channel_key<>'sandbox' THEN
  IF NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=i.id) THEN
   RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
  RETURN public.payment_provider_attempt_prepare(p_request_key,p_intent_id,p_method_facts->>'provider',
   p_method_facts->>'providerIdempotencyKey',p_fingerprint,p_method_facts->>'providerFlow',p_method_facts->>'paymentMethodRef',p_method_facts->'requestPayload');
 END IF;
 RETURN public.payment_simulator_begin_attempt(p_request_key,p_intent_id,p_fingerprint,p_method_facts->'methodFacts',p_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_checkout_inline_retry_begin(p_request_key text,p_order_id uuid,p_client_id uuid,p_intent_id uuid,p_expected_attempt_id uuid,p_fingerprint text,p_context jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.commerce_orders%ROWTYPE; i public.commerce_settlement_intents%ROWTYPE;
 a public.payment_simulator_attempts%ROWTYPE; result jsonb; initial_purchase boolean;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_expected_attempt_id IS NULL
  OR p_request_key IS DISTINCT FROM 'checkout-inline-recovery:'||p_expected_attempt_id::text||':payment-execution:prepare-attempt'
  OR p_context IS NULL OR jsonb_typeof(p_context)<>'object'
  OR NOT COALESCE(pg_input_is_valid(p_context->>'retryRequestId','uuid'),false) THEN
  RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.client_id IS DISTINCT FROM p_client_id OR o.subscription_cycle_id IS NOT NULL THEN
  RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.commerce_settlement_intents WHERE id=p_intent_id AND order_id=o.id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
 IF i.channel_key<>'sandbox' THEN
  IF NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=i.id) THEN
   RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
  IF p_context->>'executionRail' IS DISTINCT FROM i.channel_key OR o.status<>'pending_payment'
   OR o.metadata->>'paymentStatus'='expired' OR i.status='settled' THEN
   RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
  RETURN public.payment_provider_attempt_prepare(p_request_key,i.id,p_context->>'provider',p_context->>'providerIdempotencyKey',
   p_fingerprint,p_context->>'providerFlow',p_context->>'paymentMethodRef',COALESCE(p_context->'requestPayload','{}'::jsonb)||jsonb_build_object(
   'source','commerce.checkout-inline-recovery.prepare.v1','expectedPaymentAttemptId',p_expected_attempt_id,'retryRequestId',p_context->>'retryRequestId','purchaseContext',p_context->>'purchaseContext'));
 END IF;
 IF i.channel_key<>'sandbox' OR p_context->>'executionRail' IS DISTINCT FROM 'sandbox' THEN
  RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.payment_simulator_attempts WHERE settlement_intent_id=i.id AND is_active FOR UPDATE;
 IF NOT FOUND OR o.status<>'pending_payment' OR o.metadata->>'paymentStatus'='expired'
  OR o.metadata->>'source'='checkout_reservation_expiry' OR i.status='settled'
  OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts attempt
   JOIN public.payment_simulator_observations e ON e.attempt_id=attempt.id
   WHERE attempt.settlement_intent_id=i.id AND e.outcome='captured') THEN
  RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
 initial_purchase:=EXISTS(SELECT 1 FROM public.subscription_activations activation WHERE activation.order_id=o.id
  AND activation.client_id=o.client_id AND activation.state='provisional' AND activation.subscription_id IS NULL
  AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='subscription');
 IF i.amount_minor IS DISTINCT FROM o.total_amount_minor OR i.currency_code IS DISTINCT FROM o.currency_code
  OR NOT EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id)
  OR jsonb_typeof(o.metadata->'quoteSnapshot') IS DISTINCT FROM 'object'
  OR jsonb_typeof(o.metadata->'orderDraftSnapshot') IS DISTINCT FROM 'object'
  OR NOT (initial_purchase OR (NOT EXISTS(SELECT 1 FROM public.subscription_activations activation WHERE activation.order_id=o.id)
   AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='one_time')) THEN
  RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
 IF a.request_key=p_request_key THEN
  IF a.request_fingerprint IS DISTINCT FROM p_fingerprint OR a.id=p_expected_attempt_id
   OR a.state NOT IN ('dispatched','indeterminate','refused')
   OR (a.state='refused' AND i.status<>'failed') THEN
   RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
  -- Replay compares transition identity, retry nonce and rail only. Method input is transient.
  result:=public.payment_simulator_begin_attempt(p_request_key,i.id,p_fingerprint,'{}'::jsonb,p_at);
 ELSE
  IF p_context->>'replayOnly'='true' OR a.id IS DISTINCT FROM p_expected_attempt_id
   OR i.status<>'failed' OR a.state<>'refused'
   OR NOT EXISTS(SELECT 1 FROM public.payment_simulator_observations e WHERE e.id=a.last_observation_id AND e.attempt_id=a.id AND e.outcome='refused')
   OR p_context->>'purchaseContext' IS DISTINCT FROM (CASE WHEN initial_purchase THEN 'subscription_initial' ELSE 'one_time' END)
   OR COALESCE(btrim(p_context->>'previousMethodKey'),'')=''
   OR COALESCE(btrim(p_context->>'requestedMethodKey'),'')=''
   OR p_context->>'resolvedMethodKey' IS DISTINCT FROM p_context->>'requestedMethodKey'
   OR jsonb_typeof(p_context->'actions') IS DISTINCT FROM 'array'
   OR NOT (CASE WHEN p_context->>'previousMethodKey'=p_context->>'requestedMethodKey'
     THEN p_context->>'restriction' IS DISTINCT FROM 'method' AND (p_context->'actions' ? 'change_instrument' OR p_context->'actions' ? 'correct_data')
     ELSE p_context->'actions' ? 'change_method' END) THEN
   RAISE EXCEPTION 'checkout_inline_retry_refused' USING ERRCODE='22023'; END IF;
  result:=public.payment_simulator_begin_attempt(p_request_key,i.id,p_fingerprint,p_context->'methodFacts',p_at);
 END IF;
 RETURN result||jsonb_build_object('failureReason',CASE WHEN result->>'state'='refused' THEN i.failure_reason ELSE NULL END);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_expired_checkout_recovery(
  p_idempotency_key text,p_source_order_id uuid,p_replacement_order_id uuid,p_recovery_window_ms bigint,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE source public.commerce_orders%ROWTYPE; replacement public.commerce_orders%ROWTYPE;
 activation public.subscription_activations%ROWTYPE; intent public.commerce_settlement_intents%ROWTYPE;
 attempt public.payment_simulator_attempts%ROWTYPE; root_id uuid; q jsonb; fingerprint jsonb; first_fingerprint jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key))<8 OR p_source_order_id IS NULL
  OR p_replacement_order_id IS NULL OR p_source_order_id=p_replacement_order_id
  OR p_recovery_window_ms IS NULL OR p_recovery_window_ms<=0 OR p_now IS NULL OR NOT isfinite(p_now) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO source FROM public.commerce_orders WHERE id=p_source_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_expired_recovery_source_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO replacement FROM public.commerce_orders WHERE id=p_replacement_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_expired_recovery_replacement_not_found' USING ERRCODE='22023'; END IF;
 -- Linked replay precedes fresh admission, even after compensation or payment.
 IF replacement.recreated_from_order_id=source.id THEN
  RETURN jsonb_build_object('contractVersion','commerce.v0','replacementOrderId',replacement.id,'replayed',true); END IF;
 -- A linked replacement is permanent, even while its draft remains unstarted.
 IF replacement.recovery_root_order_id IS NOT NULL OR replacement.recreated_from_order_id IS NOT NULL THEN
  RAISE EXCEPTION 'commerce_expired_recovery_replacement_invalid' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_orders WHERE recreated_from_order_id=source.id AND id<>replacement.id) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_source_already_recreated' USING ERRCODE='23505'; END IF;
 IF source.subscription_cycle_id IS NOT NULL OR replacement.subscription_cycle_id IS NOT NULL THEN
  RAISE EXCEPTION 'commerce_expired_recovery_renewal_unsupported' USING ERRCODE='22023'; END IF;
 IF replacement.status<>'pending_payment' OR replacement.client_id IS DISTINCT FROM source.client_id
  OR source.client_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r
    WHERE r.order_id=replacement.id AND r.idempotency_key=p_idempotency_key AND r.invalidated_at IS NULL)
  OR jsonb_typeof(replacement.metadata->'quoteSnapshot') IS DISTINCT FROM 'object'
  OR jsonb_typeof(replacement.metadata->'orderDraftSnapshot') IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=replacement.id)
  OR EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=replacement.id)
  OR EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=replacement.id) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_replacement_invalid' USING ERRCODE='22023'; END IF;
 -- Take blocking aggregate locks before deciding the current recovery deadline.
 SELECT * INTO activation FROM public.subscription_activations WHERE order_id=source.id FOR UPDATE;
 PERFORM id FROM public.commerce_settlement_intents WHERE order_id=source.id ORDER BY id FOR UPDATE;
 PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
  WHERE i.order_id=source.id ORDER BY a.id FOR UPDATE OF a;
 PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a ON a.id=e.attempt_id
  JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=source.id ORDER BY e.id FOR UPDATE OF e;
 PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id
  WHERE i.order_id=source.id ORDER BY e.id FOR UPDATE OF e;
 IF source.created_at+make_interval(secs=>p_recovery_window_ms::double precision/1000)<GREATEST(p_now,clock_timestamp()) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_window_elapsed' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(((source.status='expired' AND source.metadata->>'paymentStatus'='expired'
    AND source.metadata->>'source'='checkout_reservation_expiry' AND activation.id IS NULL
    AND COALESCE(source.metadata#>>'{orderDraftSnapshot,context,mode}',source.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')<>'subscription')
  OR (source.status='cancelled' AND source.metadata->>'subscriptionActivation'='abandoned'
    AND source.metadata->>'source'='initial_checkout_sweep' AND source.metadata->>'paymentStatus'='cancelled'
    AND activation.state='compensated' AND activation.client_id=source.client_id)),false)
  OR source.metadata ? 'manualOrderCancellation' THEN
  RAISE EXCEPTION 'commerce_expired_recovery_source_not_eligible' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(source.metadata->'quoteSnapshot') IS DISTINCT FROM 'object'
  OR NOT EXISTS(SELECT 1 FROM public.commerce_destination_bindings b JOIN public.commerce_destinations d ON d.id=b.destination_id
   WHERE b.order_id=source.id AND d.client_id=source.client_id)
  OR EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=source.id AND status IN ('held','committed')) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_source_not_eligible' USING ERRCODE='22023'; END IF;
 SELECT * INTO intent FROM public.commerce_settlement_intents WHERE order_id=source.id;
 IF intent.id IS NOT NULL AND intent.channel_key<>'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=intent.id) THEN
  RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 IF intent.id IS NOT NULL AND intent.channel_key<>'sandbox' AND NOT EXISTS(
  SELECT 1 FROM public.payment_provider_states s JOIN public.payment_provider_attempts a ON a.id=s.active_attempt_id
  JOIN public.payment_provider_attempt_evidence e ON e.payment_attempt_id=a.id AND e.settlement_intent_id=s.id
  WHERE s.id=intent.id AND a.settlement_intent_id=s.id AND a.status IN ('failed','expired') AND e.signature_verified IS TRUE
   AND e.provider=a.provider AND e.provider_payment_id=a.provider_attempt_id AND e.event_type='payment.failed'
   AND (e.amount_minor IS NULL OR e.amount_minor=0 OR e.amount_minor=intent.amount_minor)
   AND (e.currency IS NULL OR e.currency=intent.currency_code)) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_payment_unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.payment_provider_attempt_evidence pe
   ON pe.payment_attempt_id=pa.id AND pe.settlement_intent_id=pa.settlement_intent_id
   WHERE pa.settlement_intent_id=intent.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
    AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded')
  OR intent.status='settled' OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
   ON i.id=e.settlement_intent_id WHERE i.order_id=source.id AND e.outcome='captured')
  OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=intent.id AND a.state='captured') THEN
  RAISE EXCEPTION 'commerce_expired_recovery_money_moved' USING ERRCODE='23505'; END IF;
 SELECT * INTO attempt FROM public.payment_simulator_attempts WHERE settlement_intent_id=intent.id AND is_active;
 IF intent.id IS NULL OR (intent.channel_key='sandbox' AND (attempt.id IS NULL OR attempt.state NOT IN ('refused','expired')
  OR attempt.last_observation_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.payment_simulator_observations e
    WHERE e.id=attempt.last_observation_id AND e.attempt_id=attempt.id AND e.outcome=attempt.state)))
  OR intent.amount_minor IS DISTINCT FROM source.total_amount_minor OR intent.currency_code IS DISTINCT FROM source.currency_code
  OR EXISTS(SELECT 1 FROM public.payment_truth_events WHERE settlement_intent_id=intent.id AND outcome='indeterminate' AND state='open' AND review_required_at IS NULL) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_payment_unavailable' USING ERRCODE='22023'; END IF;
 IF (source.currency_code,source.total_amount_minor) IS DISTINCT FROM (replacement.currency_code,replacement.total_amount_minor)
  OR EXISTS((SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=source.id
      EXCEPT SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=replacement.id)
    UNION ALL (SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=replacement.id
      EXCEPT SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=source.id)) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_order_changed' USING ERRCODE='23505'; END IF;
 -- Compare the existing commercial fields, excluding transient quote identity.
 FOR q IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
   source.metadata#>'{quoteSnapshot,quote}',replacement.metadata#>'{quoteSnapshot,quote}')) LOOP
  IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR jsonb_typeof(q->'lines') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'commerce_expired_recovery_order_changed' USING ERRCODE='23505'; END IF;
  fingerprint:=jsonb_build_object('currency',q->'currency','lines',(
    SELECT jsonb_agg(jsonb_build_object('sku',line->'sku','productSlug',line->'productSlug','quantity',line->'quantity',
     'unitPriceGross',line->'unitPriceGross','lineSubtotalGross',line->'lineSubtotalGross','tax',line->'tax') ORDER BY ordinal)
     FROM jsonb_array_elements(q->'lines') WITH ORDINALITY AS l(line,ordinal)),
   'discounts',q->'discounts','subtotalGross',q->'subtotalGross','discountTotalGross',q->'discountTotalGross',
   'shippingGross',q->'shippingGross','shippingDiscountGross',q->'shippingDiscountGross',
   'shippingTerms',CASE WHEN q#>'{context,shippingTerms}' IS NULL THEN NULL ELSE jsonb_build_object(
     'version',q#>'{context,shippingTerms,version}','currency',q#>'{context,shippingTerms,currency}',
     'flatMinor',q#>'{context,shippingTerms,flatMinor}','freeThresholdMinor',q#>'{context,shippingTerms,freeThresholdMinor}') END,
   'totalGross',q->'totalGross','netTotal',q->'netTotal','taxTotal',q->'taxTotal',
   'mode',q#>'{context,mode}','cadenceDays',q#>'{context,cadenceDays}','sizeConstraint',q#>'{context,sizeConstraint}');
  IF first_fingerprint IS NULL THEN first_fingerprint:=fingerprint;
  ELSIF first_fingerprint IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'commerce_expired_recovery_order_changed' USING ERRCODE='23505'; END IF;
 END LOOP;
 -- The native initial declaration belongs to the replacement; the compensated
 -- predecessor, all live subscriptions and every existing cycle are untouched.
 IF activation.id IS NOT NULL THEN
  PERFORM public.subscription_declare_provisional_activation(p_idempotency_key||':declare',replacement.id,activation.cadence_days,p_now);
 END IF;
 root_id:=COALESCE(source.recovery_root_order_id,source.id);
 UPDATE public.commerce_orders SET recovery_root_order_id=root_id,recreated_from_order_id=source.id,
  metadata=metadata||jsonb_build_object('recreatedFromOrderId',source.id,'recoveryRootOrderId',root_id,
   'recoveryReason','expired_checkout_recreate','recoveryIdempotencyKey',p_idempotency_key,
   'runtimeFinalize',COALESCE(source.metadata->'runtimeFinalize','{}'::jsonb))||
   CASE WHEN jsonb_typeof(source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')='object'
    AND source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}'<>'{}'::jsonb
    THEN jsonb_build_object('invoiceBuyerSnapshot',source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')
    WHEN source.metadata ? 'invoiceBuyerSnapshot'
    THEN jsonb_build_object('invoiceBuyerSnapshot',source.metadata->'invoiceBuyerSnapshot')
    WHEN jsonb_typeof(source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')='object'
    THEN jsonb_build_object('invoiceBuyerSnapshot',source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')
    ELSE '{}'::jsonb END,
  updated_at=p_now WHERE id=replacement.id;
 RETURN jsonb_build_object('contractVersion','commerce.v0','replacementOrderId',replacement.id,'replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_checkout_payment_guidance_snapshot(
 p_order_id uuid,p_payment_intent_id uuid,p_recovery_token_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
WITH current_state AS MATERIALIZED (
 SELECT o.id AS order_id,o.client_id,o.status AS order_status,i.id AS intent_id,i.status AS intent_status,
  i.channel_key,i.updated_at,i.failure_reason,i.amount_minor,i.currency_code,
  a.id AS attempt_id,a.state AS attempt_state,activation.state AS activation_state,
  s.id AS subscription_id,s.status AS subscription_status,gap.paid_at,gap.order_id IS NOT NULL AS has_exact_gap,
  CASE WHEN activation.id IS NOT NULL OR o.subscription_cycle_id IS NOT NULL THEN 'subscription_cycle' ELSE 'one_time' END AS order_mode,
  COALESCE(o.client_id IS NOT NULL AND o.subscription_cycle_id IS NULL
   AND EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id)
   AND jsonb_typeof(o.metadata->'quoteSnapshot')='object'
   AND jsonb_typeof(o.metadata->'orderDraftSnapshot')='object'
   AND i.amount_minor=o.total_amount_minor AND i.currency_code=o.currency_code
   AND (a.id IS NULL OR (a.state='dispatched' AND a.last_observation_id IS NULL) OR current_observation.id IS NOT NULL)
   AND ((activation.id IS NULL AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='one_time')
     OR (activation.id IS NOT NULL AND activation.client_id=o.client_id
       AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='subscription')),false) AS eligible,
  COALESCE(t.id IS NOT NULL AND t.revoked_at IS NULL AND t.expires_at>statement_timestamp()
   AND o.status='pending_payment' AND o.subscription_cycle_id IS NULL,false) AS token_authorized
 FROM public.commerce_orders o JOIN public.commerce_settlement_intents i ON i.order_id=o.id
 LEFT JOIN public.payment_simulator_attempts a ON a.settlement_intent_id=i.id AND a.is_active
 LEFT JOIN public.payment_simulator_observations current_observation ON current_observation.id=a.last_observation_id
  AND current_observation.attempt_id=a.id AND current_observation.outcome=a.state
 LEFT JOIN public.subscription_activations activation ON activation.order_id=o.id
 LEFT JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id
 LEFT JOIN public.subscriptions s ON s.id=COALESCE(activation.subscription_id,cycle.subscription_id) AND s.client_id=o.client_id
 LEFT JOIN public.subscription_paid_activation_gaps gap ON gap.order_id=o.id AND gap.settlement_intent_id=i.id AND gap.client_id=o.client_id
 LEFT JOIN public.commerce_checkout_recovery_tokens t ON t.id=p_recovery_token_id AND t.order_id=o.id AND t.client_id=o.client_id
 WHERE o.id=p_order_id AND i.id=p_payment_intent_id
), observed_success AS MATERIALIZED (
 -- Captured observation is a durable success fact, not a settlement assertion.
 SELECT EXISTS(SELECT 1 FROM public.payment_simulator_attempts a
  JOIN current_state cs ON cs.intent_id=a.settlement_intent_id
  JOIN public.payment_simulator_observations e ON e.attempt_id=a.id WHERE e.outcome='captured') AS present
), bounded_history AS MATERIALIZED (
 SELECT a.id,a.state,a.dispatched_at,a.last_observation_id,a.settlement_intent_id,cs.amount_minor,cs.currency_code
 FROM public.payment_simulator_attempts a JOIN current_state cs ON cs.intent_id=a.settlement_intent_id
 ORDER BY a.dispatched_at DESC,a.id DESC LIMIT 101
), history AS MATERIALIZED (
 SELECT * FROM bounded_history ORDER BY dispatched_at DESC,id DESC LIMIT 100
), projected_history AS (
 SELECT a.id,a.state,a.dispatched_at,evidence.complete,
  CASE WHEN evidence.complete AND NOT success.present THEN evidence.items ELSE '[]'::jsonb END AS evidence
 FROM history a CROSS JOIN observed_success success CROSS JOIN LATERAL (
  SELECT count(*)<=32 AND COALESCE(bool_and(b.valid IS TRUE),true)
   AND ((a.state='dispatched' AND a.last_observation_id IS NULL) OR EXISTS(SELECT 1 FROM public.payment_simulator_observations last
    WHERE last.id=a.last_observation_id AND last.attempt_id=a.id AND last.outcome=a.state)) AS complete,
   COALESCE(jsonb_agg(jsonb_build_object('version',1,'source',b.source,'sourceId',b.id,
    'paymentAttemptId',a.id,'paymentIntentId',a.settlement_intent_id,'observationId',b.observation_id,
    'outcome',b.outcome,'refusalVerified',b.outcome='refused') ORDER BY b.at DESC,b.source,b.id)
    FILTER(WHERE b.valid),'[]'::jsonb) AS items
  FROM (
   SELECT e.* FROM (
    SELECT o.id,o.id AS observation_id,'observation'::text AS source,o.occurred_at AS at,o.outcome,
     octet_length(to_jsonb(o)::text)<=8192 AS valid
    FROM public.payment_simulator_observations o WHERE o.attempt_id=a.id
    UNION ALL
    SELECT t.id,o.id,'event',t.occurred_at,t.outcome,
     octet_length(t.source_evidence::text)<=8192 AND t.amount_minor=a.amount_minor AND t.currency_code=a.currency_code
      AND t.source_evidence->>'payloadFingerprint'=o.event_fingerprint
      AND t.source_evidence->>'observedStatus'=o.outcome
      AND CASE WHEN pg_input_is_valid(t.source_evidence->>'observedAt','timestamptz')
        THEN (t.source_evidence->>'observedAt')::timestamptz=o.occurred_at ELSE false END
      AND t.occurred_at=o.occurred_at AND t.outcome=CASE WHEN o.outcome='expired' THEN 'refused' ELSE o.outcome END
    FROM public.payment_truth_events t JOIN public.payment_simulator_observations o
     ON t.source_evidence->>'sourceReference'=o.id::text AND o.attempt_id=a.id
    WHERE t.settlement_intent_id=a.settlement_intent_id AND t.source_evidence->>'attemptRef'=a.id::text
     AND t.source_evidence->>'sourceKind' IN ('accepted_event','reconciliation_read')
    UNION ALL
    SELECT r.id,o.id,'reconciliation',r.occurred_at,r.outcome,
     octet_length(r.source_evidence::text)<=8192 AND r.evidence_status='observed'
      AND t.amount_minor=a.amount_minor AND t.currency_code=a.currency_code
      AND r.source_evidence->>'payloadFingerprint'=o.event_fingerprint
      AND r.source_evidence->>'observedStatus'=o.outcome
      AND CASE WHEN pg_input_is_valid(r.source_evidence->>'observedAt','timestamptz')
        THEN (r.source_evidence->>'observedAt')::timestamptz=o.occurred_at ELSE false END
      AND r.occurred_at=o.occurred_at AND r.outcome=CASE WHEN o.outcome='expired' THEN 'refused' ELSE o.outcome END
    FROM public.payment_truth_reconciliation_evidence r JOIN public.payment_truth_events t ON t.id=r.event_id
    JOIN public.payment_simulator_observations o ON r.source_evidence->>'sourceReference'=o.id::text AND o.attempt_id=a.id
    WHERE t.settlement_intent_id=a.settlement_intent_id AND r.source_evidence->>'attemptRef'=a.id::text
     AND r.source_evidence->>'sourceKind'='reconciliation_read'
   ) e ORDER BY e.at DESC,e.source,e.id LIMIT 33
  ) b
 ) evidence
)
SELECT CASE WHEN cs.channel_key<>'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=cs.intent_id)
 THEN jsonb_build_object('refusal','native_prepared_attempt_store_unsupported')
 WHEN cs.channel_key<>'sandbox' THEN (SELECT jsonb_build_object('snapshot',jsonb_build_object(
  'orderId',cs.order_id,'clientId',cs.client_id,'orderStatus',cs.order_status,'paymentIntentId',cs.intent_id,
  'intentStatus',ps.status,'paymentAttemptId',pa.id,'attemptStatus',pa.status,'provider',pa.provider,
  'providerPaymentId',pa.provider_attempt_id,'updatedAt',ps.updated_at,'failureReason',ps.failure_reason,
  'orderMode',cs.order_mode,'activationState',cs.activation_state,'subscriptionId',cs.subscription_id,
  'subscriptionStatus',cs.subscription_status,'paidAt',cs.paid_at,'hasExactGap',cs.has_exact_gap),
  'eligible',cs.eligible,'tokenAuthorized',cs.token_authorized,
  'observedSuccess',EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence pe JOIN public.payment_provider_attempts a ON a.id=pe.payment_attempt_id
   WHERE a.settlement_intent_id=ps.id AND pe.settlement_intent_id=ps.id AND pe.provider=a.provider
    AND pe.provider_payment_id=a.provider_attempt_id AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded'),
  'historyComplete',(SELECT count(*)<=100 FROM public.payment_provider_attempts WHERE settlement_intent_id=ps.id)
   AND NOT EXISTS(SELECT 1 FROM public.payment_provider_attempts a WHERE a.settlement_intent_id=ps.id AND
    ((SELECT count(*) FROM public.payment_provider_attempt_evidence e WHERE e.payment_attempt_id=a.id)>32
     OR EXISTS(SELECT 1 FROM public.payment_provider_attempt_evidence e WHERE e.payment_attempt_id=a.id AND octet_length(e.payload::text)>8192))),
  'attempts',COALESCE((SELECT jsonb_agg(h.value ORDER BY h.created_at DESC,h.id DESC) FROM (
   SELECT a.id,a.created_at,jsonb_build_object('id',a.id,'status',a.status,'provider',a.provider,
    'providerPaymentId',a.provider_attempt_id,'providerFlow',a.request_payload->>'providerFlow','createdAt',a.created_at,
    'evidence',COALESCE((SELECT jsonb_agg(e.payload ORDER BY e.created_at DESC,e.id DESC) FROM (
     SELECT pe.* FROM public.payment_provider_attempt_evidence pe WHERE pe.settlement_intent_id=ps.id AND pe.payment_attempt_id=a.id
      AND pe.provider=a.provider AND pe.provider_payment_id=a.provider_attempt_id AND pe.signature_verified IS TRUE
     ORDER BY pe.created_at DESC,pe.id DESC LIMIT 33) e),'[]'::jsonb)) AS value
   FROM public.payment_provider_attempts a WHERE a.settlement_intent_id=ps.id ORDER BY a.created_at DESC,a.id DESC LIMIT 100) h),'[]'::jsonb))
 FROM public.payment_provider_states ps LEFT JOIN public.payment_provider_attempts pa ON pa.id=ps.active_attempt_id AND pa.settlement_intent_id=ps.id WHERE ps.id=cs.intent_id)
 ELSE jsonb_build_object('snapshot',jsonb_build_object(
  'orderId',cs.order_id,'clientId',cs.client_id,'orderStatus',cs.order_status,
  'paymentIntentId',cs.intent_id,'intentStatus',cs.intent_status,'paymentAttemptId',cs.attempt_id,'attemptStatus',cs.attempt_state,
  'provider',cs.channel_key,'providerPaymentId',NULL,'updatedAt',cs.updated_at,'failureReason',cs.failure_reason,
  'orderMode',cs.order_mode,'activationState',cs.activation_state,'subscriptionId',cs.subscription_id,
  'subscriptionStatus',cs.subscription_status,'paidAt',cs.paid_at,'hasExactGap',cs.has_exact_gap),
  'eligible',cs.eligible,'tokenAuthorized',cs.token_authorized,'observedSuccess',success.present,
  'historyComplete',(SELECT count(*)<=100 FROM bounded_history) AND COALESCE((SELECT bool_and(complete) FROM projected_history),true),
  'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'status',h.state,'provider',cs.channel_key,
    'providerPaymentId',NULL,'providerFlow',NULL,'createdAt',h.dispatched_at,'evidence',h.evidence)
    ORDER BY h.dispatched_at DESC,h.id DESC) FROM projected_history h),'[]'::jsonb)) END
FROM current_state cs CROSS JOIN observed_success success;
$$;

ALTER TABLE public.payment_provider_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_provider_states FROM PUBLIC;

ALTER TABLE public.payment_provider_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_provider_attempts FROM PUBLIC;

ALTER TABLE public.payment_provider_attempt_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_provider_attempt_evidence FROM PUBLIC;

ALTER TABLE public.payment_provider_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_provider_receipts FROM PUBLIC;

ALTER TABLE public.payment_provider_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_provider_transitions FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_lock_aggregate(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_attempt_read(uuid,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_intent_create(text,text,uuid,uuid,uuid,bigint,text,jsonb,text,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_attempt_prepare(text,uuid,text,text,text,text,text,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_attempt_record(text,uuid,text,text,text,text,text,jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_attempt_finalize(text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_event_ingest(text,text,text,text,uuid,uuid,integer,text,boolean,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_assert_truth(uuid,text,bigint,text,timestamptz,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.payment_provider_states,public.payment_provider_attempts,public.payment_provider_attempt_evidence,public.payment_provider_receipts,public.payment_provider_transitions FROM anon';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.payment_provider_states,public.payment_provider_attempts,public.payment_provider_attempt_evidence,public.payment_provider_receipts,public.payment_provider_transitions FROM authenticated';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.payment_provider_states,public.payment_provider_attempts,public.payment_provider_attempt_evidence,public.payment_provider_receipts,public.payment_provider_transitions FROM service_role';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_lock_aggregate(uuid),public.payment_provider_attempt_read(uuid,uuid),public.payment_provider_intent_create(text,text,uuid,uuid,uuid,bigint,text,jsonb,text,timestamptz),public.payment_provider_attempt_prepare(text,uuid,text,text,text,text,text,jsonb),public.payment_provider_attempt_record(text,uuid,text,text,text,text,text,jsonb,jsonb),public.payment_provider_attempt_finalize(text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb),public.payment_provider_event_ingest(text,text,text,text,uuid,uuid,integer,text,boolean,jsonb),public.payment_provider_assert_truth(uuid,text,bigint,text,timestamptz,jsonb),public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) FROM anon';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.payment_provider_lock_aggregate(uuid),public.payment_provider_attempt_read(uuid,uuid),public.payment_provider_intent_create(text,text,uuid,uuid,uuid,bigint,text,jsonb,text,timestamptz),public.payment_provider_attempt_prepare(text,uuid,text,text,text,text,text,jsonb),public.payment_provider_attempt_record(text,uuid,text,text,text,text,text,jsonb,jsonb),public.payment_provider_attempt_finalize(text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb),public.payment_provider_event_ingest(text,text,text,text,uuid,uuid,integer,text,boolean,jsonb),public.payment_provider_assert_truth(uuid,text,bigint,text,timestamptz,jsonb),public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) FROM authenticated';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.payment_provider_lock_aggregate(uuid),public.payment_provider_attempt_read(uuid,uuid),public.payment_provider_intent_create(text,text,uuid,uuid,uuid,bigint,text,jsonb,text,timestamptz),public.payment_provider_attempt_prepare(text,uuid,text,text,text,text,text,jsonb),public.payment_provider_attempt_record(text,uuid,text,text,text,text,text,jsonb,jsonb),public.payment_provider_attempt_finalize(text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb),public.payment_provider_event_ingest(text,text,text,text,uuid,uuid,integer,text,boolean,jsonb),public.payment_provider_assert_truth(uuid,text,bigint,text,timestamptz,jsonb),public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text) TO service_role';
END IF; END; $$;
