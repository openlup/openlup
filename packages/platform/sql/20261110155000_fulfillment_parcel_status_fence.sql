-- Cancellation owns the two-int transactional advisory class 1179665228 (0x4650434c, FPCL).
-- Key: pg_catalog.hashtext(parcel UUID's canonical text), a signed int32. Collisions only serialize.
-- Existing bigint advisory keys occupy PostgreSQL's disjoint one-argument key space.
-- Existing two-int classes 4100 and 846832106 are distinct (repository-wide audit).
-- Where present: request-key -> native-dispatch -> parcel (where already required) -> FPCL -> command.
-- Native cancel takes parcel then FPCL; submission takes FPCL then command, never dispatch/parcel.
-- Shared initiation locks and exclusive cancellation locks last until transaction end.
-- These locks fence ledger transitions, not the subsequent provider call.
CREATE OR REPLACE FUNCTION public.commerce_fulfillment_enqueue_provider_command(
  p_shipment_id uuid, p_provider_kind text, p_command_kind text,
  p_contract_version text, p_idempotency_key text,
  p_command_key_fingerprint text, p_command_payload_fingerprint text,
  p_provider_idempotency_key_fingerprint text, p_routing_fingerprint text,
  p_config_fingerprint text, p_correlation_fingerprint text, p_retry_budget integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_order_id uuid; v_idempotency_key_fingerprint text; v_parcel_status text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF p_shipment_id IS NULL OR p_provider_kind !~ '^[a-z][a-z0-9_-]{0,63}$'
    OR p_command_kind <> 'dispatch_create' OR p_contract_version <> '1'
    OR p_idempotency_key !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR p_command_key_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_command_payload_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_routing_fingerprint !~ '^[a-f0-9]{64}$' OR p_config_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_correlation_fingerprint IS NULL OR p_correlation_fingerprint !~ '^[a-f0-9]{64}$'
    OR (p_provider_idempotency_key_fingerprint IS NOT NULL AND p_provider_idempotency_key_fingerprint !~ '^[a-f0-9]{64}$')
    OR p_retry_budget NOT BETWEEN 0 AND 20
  THEN RAISE EXCEPTION 'fulfillment_provider_command_enqueue_invalid_input' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment_id::text,0));
  PERFORM id FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(1179665228,pg_catalog.hashtext(p_shipment_id::text));
  SELECT status INTO v_parcel_status FROM public.fulfillment_shipments WHERE id = p_shipment_id;
  IF v_parcel_status = 'cancelled' THEN RAISE EXCEPTION 'fulfillment_provider_command_fence_conflict' USING ERRCODE='40001'; END IF;
  v_idempotency_key_fingerprint := encode(sha256(convert_to('provider-command-idempotency|' || p_idempotency_key, 'UTF8')), 'hex');
  SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands WHERE idempotency_key_fingerprint = v_idempotency_key_fingerprint FOR UPDATE;
  IF FOUND THEN
    IF v_command.shipment_id <> p_shipment_id OR v_command.provider_kind <> p_provider_kind
      OR v_command.command_kind <> p_command_kind OR v_command.command_key_fingerprint <> p_command_key_fingerprint
      OR v_command.command_payload_fingerprint <> p_command_payload_fingerprint OR v_command.routing_fingerprint <> p_routing_fingerprint
      OR v_command.config_fingerprint <> p_config_fingerprint OR v_command.correlation_fingerprint <> p_correlation_fingerprint
      OR v_command.provider_idempotency_key_fingerprint IS DISTINCT FROM p_provider_idempotency_key_fingerprint
    THEN RAISE EXCEPTION 'fulfillment_provider_command_enqueue_identity_conflict' USING ERRCODE = '23505'; END IF;
    RETURN public.commerce_fulfillment_provider_command_result(v_command);
  END IF;
  SELECT order_id INTO v_order_id FROM public.fulfillment_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_provider_command_fulfillment_not_found' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=p_shipment_id AND (external_ref IS NOT NULL OR status IN ('submitting','uncertain','created'))) THEN RAISE EXCEPTION 'fulfillment_command_direct_effect_exists' USING ERRCODE='22023'; END IF;
  INSERT INTO public.commerce_fulfillment_provider_commands (
    shipment_id, order_id, provider_kind, command_kind, contract_version,
    idempotency_key_fingerprint, command_key_fingerprint, command_payload_fingerprint,
    provider_idempotency_key_fingerprint, routing_fingerprint, config_fingerprint,
    correlation_fingerprint, retry_budget
  ) VALUES (p_shipment_id, v_order_id, p_provider_kind, p_command_kind, p_contract_version,
    v_idempotency_key_fingerprint, p_command_key_fingerprint, p_command_payload_fingerprint,
    p_provider_idempotency_key_fingerprint, p_routing_fingerprint, p_config_fingerprint,
    p_correlation_fingerprint, p_retry_budget) RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id, from_status, to_status, reason_code, command_version, attempt_count)
    VALUES (v_command.id, NULL, 'queued', 'command_enqueued', v_command.version, v_command.attempt_count);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_fulfillment_claim_provider_commands(
  p_provider_kind text, p_command_kind text, p_limit integer, p_claim_owner text, p_lease_seconds integer
) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_token uuid; v_now timestamptz := now(); v_from text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF p_provider_kind !~ '^[a-z][a-z0-9_-]{0,63}$' OR p_command_kind <> 'dispatch_create'
    OR p_claim_owner !~ '^[a-f0-9]{64}$' OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 10 AND 900
  THEN RAISE EXCEPTION 'fulfillment_provider_command_claim_invalid_input' USING ERRCODE = '22023'; END IF;
  FOR v_command IN SELECT * FROM public.commerce_fulfillment_provider_commands
    WHERE provider_kind = p_provider_kind AND command_kind = p_command_kind
      AND status IN ('queued', 'retry_wait') AND available_at <= v_now
      AND attempt_count < retry_budget
      AND EXISTS(SELECT 1 FROM public.fulfillment_shipments parcel WHERE parcel.id=commerce_fulfillment_provider_commands.shipment_id AND parcel.status<>'cancelled')
    ORDER BY available_at, created_at LIMIT p_limit
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('native-dispatch|' || v_command.shipment_id::text,0)) THEN CONTINUE; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(1179665228,pg_catalog.hashtext(v_command.shipment_id::text));
    PERFORM id FROM public.fulfillment_shipments WHERE id=v_command.shipment_id AND status<>'cancelled';
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands
      WHERE id=v_command.id AND status IN ('queued','retry_wait') AND available_at<=v_now AND attempt_count<retry_budget
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=v_command.shipment_id AND (external_ref IS NOT NULL OR status IN ('submitting','uncertain','created'))) THEN CONTINUE; END IF;
    v_token := gen_random_uuid();
    v_from := v_command.status;
    UPDATE public.commerce_fulfillment_provider_commands SET status='claimed',
      claim_token=v_token, claim_owner_fingerprint=p_claim_owner,
      claim_expires_at=v_now + make_interval(secs => p_lease_seconds), claim_generation=claim_generation+1,
      last_reason_code='claimed', version=version+1, updated_at=v_now WHERE id=v_command.id RETURNING * INTO v_command;
    INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id, from_status, to_status, reason_code, command_version, attempt_count, claim_token, claim_generation)
      VALUES(v_command.id, v_from, 'claimed', 'claimed', v_command.version, v_command.attempt_count, v_command.claim_token, v_command.claim_generation);
    RETURN NEXT jsonb_build_object('commandId',v_command.id,'fulfillmentRef',v_command.shipment_id,'orderRef',v_command.order_id,
      'providerRef',v_command.provider_kind,'commandKind',v_command.command_kind,'contractVersion',v_command.contract_version,'status',v_command.status,'version',v_command.version,
      'commandKeyFingerprint',v_command.command_key_fingerprint,'commandPayloadFingerprint',v_command.command_payload_fingerprint,
      'providerIdempotencyKeyFingerprint',v_command.provider_idempotency_key_fingerprint,'routingFingerprint',v_command.routing_fingerprint,
      'configurationFingerprint',v_command.config_fingerprint,'correlationKeyFingerprint',v_command.correlation_fingerprint,
      'retryBudget',v_command.retry_budget,'retryCount',v_command.attempt_count,'claimToken',v_command.claim_token,
      'claimGeneration',v_command.claim_generation,'leaseExpiresAt',v_command.claim_expires_at);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_fulfillment_mark_command_submitting(
  p_command_id uuid,p_claim_token uuid,p_claim_generation bigint,p_expected_version bigint,p_provider_attempt_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_shipment_id uuid; v_parcel_status text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  SELECT shipment_id INTO v_shipment_id FROM public.commerce_fulfillment_provider_commands WHERE id=p_command_id;
  IF FOUND THEN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(1179665228,pg_catalog.hashtext(v_shipment_id::text));
    SELECT status INTO v_parcel_status FROM public.fulfillment_shipments WHERE id=v_shipment_id;
    IF v_parcel_status = 'cancelled' THEN RAISE EXCEPTION 'fulfillment_provider_command_fence_conflict' USING ERRCODE='40001'; END IF;
  END IF;
  v_command := public.commerce_fulfillment_provider_command_fence(p_command_id,p_claim_token,p_claim_generation,p_expected_version);
  IF v_command.status <> 'claimed' THEN RAISE EXCEPTION 'fulfillment_provider_command_not_claimed' USING ERRCODE='22023'; END IF;
  IF p_provider_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fulfillment_provider_attempts a WHERE a.id=p_provider_attempt_id AND a.shipment_id=v_command.shipment_id AND a.provider_kind=v_command.provider_kind) THEN RAISE EXCEPTION 'fulfillment_provider_command_attempt_mismatch' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_fulfillment_provider_commands SET status='submitting',attempt_count=attempt_count+1,last_provider_attempt_id=p_provider_attempt_id,last_reason_code='submission_started',version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,claim_token,claim_generation,provider_attempt_id) VALUES(v_command.id,'claimed','submitting','submission_started',v_command.version,v_command.attempt_count,p_claim_token,p_claim_generation,p_provider_attempt_id);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_cancel_shipment(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_shipment_id IS NULL OR p_reason IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'shipment_cancelled'
      OR v_existing.shipment_id IS DISTINCT FROM p_shipment_id
      OR v_existing.payload->>'reason' IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'fulfillment_cancel_shipment_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'cancelled', true);
  END IF;

  SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1179665228,pg_catalog.hashtext(p_shipment_id::text));
  IF v_shipment.status = 'cancelled' THEN
    RETURN public.fulfillment_shipment_response(v_shipment, 'cancelled', true);
  END IF;
  IF v_shipment.status IN ('label_created', 'handed_over', 'in_transit', 'delivered') THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_invalid_status' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_external_refs
     WHERE shipment_id = p_shipment_id AND ref_role = 'dispatch'
  ) THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_dispatch_outstanding' USING ERRCODE = '22023';
  END IF;

  UPDATE public.fulfillment_shipments
     SET status = 'cancelled',
         cancelled_at = p_requested_at,
         updated_at = p_requested_at,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
                    || jsonb_build_object('cancellationReason', p_reason)
   WHERE id = p_shipment_id
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_shipment_id, v_shipment.order_id, 'shipment_cancelled', p_idempotency_key,
          jsonb_build_object('reason', p_reason), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, 'cancelled', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_operator_cancel_order(p_idempotency_key text,p_shipment_id uuid,p_reason text,p_actor_id uuid,p_metadata jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; purchase public.commerce_orders; prior public.fulfillment_operator_receipts;
 answer jsonb; ids uuid[]:=ARRAY[]::uuid[]; disposition text; confirmed boolean; recorded boolean; recorded_mode text; old_op public.fulfillment_shipment_operations;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('parcel-cancel-key|'||p_idempotency_key,0));
 SELECT * INTO prior FROM public.fulfillment_operator_receipts WHERE kind='cancel' AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF prior.command->>'shipmentId' IS DISTINCT FROM p_shipment_id::text OR prior.command->>'reason' IS DISTINCT FROM p_reason THEN
   RAISE EXCEPTION 'commerce_fulfillment_cancel_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 -- Serialize the cancellation check with parcel preparation and command admission.
 -- Later command admission/submission still depends on the command ledger's own fences.
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|'||p_shipment_id::text,0));
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_fulfillment_not_found' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(1179665228,pg_catalog.hashtext(p_shipment_id::text));
 recorded:=EXISTS(SELECT 1 FROM public.fulfillment_parcel_reservation_sets WHERE shipment_id=parcel.id);
 disposition:=CASE WHEN recorded THEN 'recorded' ELSE 'reservations_not_recorded' END;
 IF parcel.status='cancelled' THEN
  SELECT * INTO old_op FROM public.fulfillment_shipment_operations WHERE shipment_id=parcel.id AND operation_type='shipment_cancelled' ORDER BY occurred_at DESC,id DESC LIMIT 1;
  RETURN jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','cancelled','replayed',true,
   'releasedReservationCount',coalesce((old_op.payload->>'releasedReservationCount')::integer,0),'reservationDisposition',disposition);
 END IF;
 SELECT lower(btrim(e.provider_status))='cancelled' INTO confirmed FROM public.fulfillment_operator_status_evidence e
 WHERE e.shipment_id=parcel.id ORDER BY e.occurred_at DESC NULLS LAST,e.created_at DESC,e.id DESC LIMIT 1;
 confirmed:=coalesce(confirmed,false) AND parcel.status='exception';
 IF confirmed THEN
  SELECT * INTO purchase FROM public.commerce_orders WHERE id=parcel.order_id FOR UPDATE;
  recorded_mode:=purchase.metadata#>>'{orderDraftSnapshot,context,mode}';
  IF recorded_mode IS NULL AND purchase.status IN ('paid','fulfillment_pending') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_order_mode_unproven' USING ERRCODE='22023'; END IF;
  IF recorded_mode<>'one_time' OR purchase.status NOT IN ('paid','fulfillment_pending') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_order_ineligible' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=purchase.id AND status='settled') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_payment_not_succeeded' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=purchase.id AND status='active') THEN
   RAISE EXCEPTION 'commerce_fulfillment_provider_cancel_active_hold' USING ERRCODE='22023'; END IF;
  UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason='order_cancelled',updated_at=now()
   WHERE (purchase_order_id=purchase.id OR (renewal_operation_id=purchase.renewal_operation_id
     AND operation_fingerprint=purchase.renewal_operation_fingerprint)) AND status IN ('held','committed');
  UPDATE public.commerce_orders SET status='cancelled',cancelled_at=now(),updated_at=now(),metadata=metadata||jsonb_build_object('source','operator_provider_cancel_confirmed','suppressOrderCanceledEmail',true,
   'providerCancellation',jsonb_build_object('reason',p_reason,'actorUserId',p_actor_id,'confirmedAt',now())) WHERE id=purchase.id;
  INSERT INTO public.commerce_order_operations(order_id,actor_id,operation_type,source,idempotency_key,payload)
   VALUES(purchase.id,p_actor_id,'order_cancelled','commerce.fulfillment.provider_cancel_confirmed',p_idempotency_key||':order',jsonb_build_object('reason',p_reason,'metadata',coalesce(p_metadata,'{}'),'providerStatus','CANCELLED'));
 ELSE
  PERFORM id FROM public.commerce_fulfillment_provider_commands WHERE shipment_id=parcel.id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id AND status NOT IN ('failed','cancelled'))
   OR EXISTS(SELECT 1 FROM public.shipment_external_refs WHERE shipment_id=parcel.id AND ref_role='dispatch')
   OR EXISTS(SELECT 1 FROM public.commerce_fulfillment_provider_commands WHERE shipment_id=parcel.id AND status IN ('accepted','submitting','uncertain')) THEN
   RAISE EXCEPTION 'commerce_fulfillment_cancel_provider_dispatch_active' USING ERRCODE='22023'; END IF;
  IF parcel.status NOT IN ('created','packed','label_pending') THEN RAISE EXCEPTION 'commerce_fulfillment_cancel_after_label_forbidden' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(DISTINCT a.reservation_id ORDER BY a.reservation_id),ARRAY[]::uuid[]) INTO ids
   FROM public.fulfillment_parcel_line_reservations a JOIN public.fulfillment_parcel_lines l ON l.id=a.line_id WHERE l.shipment_id=parcel.id;
  UPDATE public.fulfillment_inventory_reservations SET status='released',terminal_reason='fulfillment_cancelled',updated_at=now()
   WHERE id=ANY(ids) AND status IN ('held','committed');
 END IF;
 UPDATE public.fulfillment_shipments SET status='cancelled',cancelled_at=now(),updated_at=now(),metadata=metadata||jsonb_build_object('releasedReservationIds',to_jsonb(ids),'providerCancellationConfirmed',confirmed) WHERE id=parcel.id;
 INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload)
 VALUES(parcel.id,parcel.order_id,'shipment_cancelled',p_idempotency_key,jsonb_build_object('reason',p_reason,'operatorUserId',p_actor_id,'metadata',coalesce(p_metadata,'{}'),
  'providerCancellationConfirmed',confirmed,'releasedReservationIds',to_jsonb(ids),'releasedReservationCount',cardinality(ids),'reservationDisposition',disposition));
 answer:=jsonb_build_object('contractVersion','commerce.fulfillment.v0','fulfillmentOrderId',parcel.id,'orderId',parcel.order_id,'status','cancelled','replayed',false,'releasedReservationCount',cardinality(ids),'reservationDisposition',disposition);
 INSERT INTO public.fulfillment_operator_receipts(kind,idempotency_key,command,result) VALUES('cancel',p_idempotency_key,jsonb_build_object('shipmentId',parcel.id,'reason',p_reason),answer);
 RETURN answer;
END;
$$;
