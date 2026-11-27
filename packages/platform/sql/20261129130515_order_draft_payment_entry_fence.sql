CREATE OR REPLACE FUNCTION public.commerce_open_settlement_intent(
  p_idempotency_key text,
  p_order_id uuid,
  p_channel_key text,
  p_amount_minor bigint,
  p_currency_code text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_order public.commerce_orders%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_transition public.commerce_settlement_transitions%ROWTYPE;
BEGIN
  -- Long enough that a caller cannot reach it by accident: an idempotency key short enough to
  -- collide is worse than no key, because it silently suppresses a real second request.
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL
    OR p_channel_key IS NULL OR btrim(p_channel_key) = '' OR char_length(p_channel_key) > 64
    OR p_amount_minor IS NULL OR p_amount_minor < 1
    OR p_currency_code IS NULL OR char_length(p_currency_code) <> 3
  THEN
    RAISE EXCEPTION 'commerce_settlement_open_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_settlement_open_order_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE order_id = p_order_id;

  IF FOUND THEN
    IF v_intent.open_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
      RAISE EXCEPTION 'commerce_settlement_open_order_already_has_intent' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_transition
      FROM public.commerce_settlement_transitions
     WHERE intent_id = v_intent.id AND idempotency_key = p_idempotency_key;
    RETURN public.commerce_settlement_response(v_intent, v_transition.id, 'opened', true);
  END IF;

  IF v_order.money_version IS NOT NULL THEN
    IF v_order.status = 'pending_payment'
      AND (v_order.total_amount_minor, v_order.currency_code) IS NOT DISTINCT FROM (p_amount_minor, p_currency_code)
      AND p_requested_at IS NOT NULL
      AND EXISTS (SELECT FROM public.commerce_settlement_intents WHERE open_idempotency_key = p_idempotency_key)
    THEN
      RAISE unique_violation USING
        MESSAGE = 'duplicate key value violates unique constraint "commerce_settlement_intents_open_idempotency_key_key"',
        DETAIL = format('Key (open_idempotency_key)=(%s) already exists.', p_idempotency_key),
        SCHEMA = 'public', TABLE = 'commerce_settlement_intents',
        CONSTRAINT = 'commerce_settlement_intents_open_idempotency_key_key';
    END IF;
    RAISE EXCEPTION 'fiscal_confirmation_unenforceable' USING ERRCODE = '22023',
      DETAIL = '/paymentLimits/channelKey',
      HINT = 'Prepare payment for this order through the versioned-money payment preparation. Legacy settlement opening and provider intent creation do not apply to orders with versioned money.';
  END IF;

  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'commerce_settlement_open_order_not_payable' USING ERRCODE = '22023';
  END IF;

  IF v_order.total_amount_minor IS DISTINCT FROM p_amount_minor
    OR v_order.currency_code IS DISTINCT FROM p_currency_code
  THEN
    RAISE EXCEPTION 'commerce_settlement_open_amount_mismatch' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.commerce_settlement_intents
    (order_id, channel_key, status, amount_minor, currency_code, open_idempotency_key,
     created_at, updated_at)
  VALUES (p_order_id, btrim(p_channel_key), 'created', p_amount_minor, p_currency_code,
          p_idempotency_key, p_requested_at, p_requested_at)
  RETURNING * INTO v_intent;

  INSERT INTO public.commerce_settlement_transitions
    (intent_id, from_status, to_status, outcome, idempotency_key, payload, occurred_at)
  VALUES (v_intent.id, 'absent', 'created', 'opened', p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_requested_at)
  RETURNING * INTO v_transition;

  RETURN public.commerce_settlement_response(v_intent, v_transition.id, 'opened', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_provider_intent_create(
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
 IF o.money_version IS NOT NULL THEN
   IF o.status = 'pending_payment' AND (o.total_amount_minor, o.currency_code) IS NOT DISTINCT FROM (p_amount_minor, p_currency)
     AND ((p_target_kind = 'one_time_order' AND o.subscription_cycle_id IS NULL)
       OR (p_target_kind = 'subscription_cycle' AND o.subscription_cycle_id = p_subscription_cycle_id
         AND linked_subscription = p_subscription_id))
     AND char_length(btrim(p_idempotency_key)) >= 8 AND char_length(p_channel_key) <= 64
     AND NOT EXISTS (SELECT FROM public.commerce_settlement_intents WHERE order_id = p_order_id)
     AND EXISTS (SELECT FROM public.commerce_settlement_intents WHERE open_idempotency_key = p_idempotency_key)
   THEN
     PERFORM public.commerce_open_settlement_intent(p_idempotency_key,p_order_id,p_channel_key,p_amount_minor,p_currency,p_metadata,p_at);
   END IF;
   RAISE EXCEPTION 'fiscal_confirmation_unenforceable' USING ERRCODE = '22023',
     DETAIL = '/paymentLimits/channelKey',
     HINT = 'Prepare payment for this order through the versioned-money payment preparation. Legacy settlement opening and provider intent creation do not apply to orders with versioned money.';
 END IF;
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
