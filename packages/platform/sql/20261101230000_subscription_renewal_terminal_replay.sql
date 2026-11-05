-- Retain subscription -> operation lock order and exact frozen replay comparison.
CREATE OR REPLACE FUNCTION public.subscription_claim_due_renewal(
  p_identity_key text,
  p_operation_fingerprint text,
  p_cycle_snapshot jsonb,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_scheduled_at timestamptz;
  v_cycle_number integer;
  v_subscription public.subscriptions%ROWTYPE;
  v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_identity_key IS NULL OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_cycle_snapshot IS NULL OR jsonb_typeof(p_cycle_snapshot) <> 'object'
    OR p_cycle_snapshot->>'contractVersion' <> 'platform.subscription.renewal.v1'
    OR btrim(COALESCE(p_worker_id, '')) = ''
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_subscription_id := (p_cycle_snapshot->>'subscriptionId')::uuid;
    v_scheduled_at := (p_cycle_snapshot->>'scheduledAt')::timestamptz;
    v_cycle_number := (p_cycle_snapshot->>'cycleNumber')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END;

  IF v_cycle_number < 1
    OR p_identity_key <> public.subscription_renewal_identity(v_subscription_id, v_scheduled_at)
    OR jsonb_typeof(p_cycle_snapshot->'lines') <> 'array'
    OR jsonb_array_length(p_cycle_snapshot->'lines') = 0
    OR p_cycle_snapshot->>'currency' !~ '^[A-Z]{3}$'
    OR (p_cycle_snapshot->>'totalAmountMinor')::bigint < 1
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation
    FROM public.subscription_renewal_operations
   WHERE subscription_id = v_subscription_id AND scheduled_at = v_scheduled_at
   FOR UPDATE;

  IF FOUND THEN
    IF v_operation.identity_key <> p_identity_key
      OR v_operation.operation_fingerprint <> p_operation_fingerprint
      OR v_operation.cycle_snapshot <> p_cycle_snapshot
    THEN
      RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_operation.state IN ('succeeded', 'refused') THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal');
    END IF;
  END IF;

  -- Historical terminal truth survives schedule advancement and cancellation.
  -- Nonterminal/new work still needs the original eligibility under both locks.
  IF v_subscription.status <> 'active'
    OR v_subscription.next_cycle_at IS DISTINCT FROM v_scheduled_at
    OR v_subscription.next_cycle_at > COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  IF v_operation.id IS NOT NULL THEN
    IF v_operation.lease_expires_at > COALESCE(p_now, now()) THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'lease_active');
    END IF;
    UPDATE public.subscription_renewal_operations
       SET claim_token = gen_random_uuid(),
           claim_generation = claim_generation + 1,
           claimed_by = p_worker_id,
           claimed_at = COALESCE(p_now, now()),
           lease_expires_at = COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_operation.id
     RETURNING * INTO v_operation;
    RETURN public.subscription_renewal_operation_response(v_operation, true, true, 'lease_taken_over');
  END IF;

  INSERT INTO public.subscription_renewal_operations (
    subscription_id, scheduled_at, cycle_number, identity_key, operation_fingerprint,
    cycle_snapshot, claim_token, claimed_by, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_subscription_id, v_scheduled_at, v_cycle_number, p_identity_key,
    p_operation_fingerprint, p_cycle_snapshot, gen_random_uuid(), p_worker_id,
    COALESCE(p_now, now()), COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
    COALESCE(p_now, now())
  ) RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(v_operation, true, false, 'claimed');
END;
$$;


CREATE FUNCTION public.commerce_view_shipment_destination(p_shipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d public.commerce_destinations; o public.commerce_orders; op public.subscription_renewal_operations;
 v_order uuid; v_id uuid; v_pinned boolean;
BEGIN
 IF p_shipment_id IS NULL THEN RAISE EXCEPTION 'commerce_destination_invalid_scope' USING ERRCODE='22023'; END IF;
 SELECT order_id INTO v_order FROM public.fulfillment_shipments WHERE id=p_shipment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_parent_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM public.commerce_orders WHERE id=v_order;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_destination_parent_missing' USING ERRCODE='22023'; END IF;
 SELECT destination_id INTO v_id FROM public.commerce_destination_bindings WHERE shipment_id=p_shipment_id;
 v_pinned:=v_id IS NOT NULL;
 IF NOT v_pinned THEN
  SELECT destination_id INTO v_id FROM public.commerce_destination_bindings WHERE order_id=v_order;
  IF v_id IS NULL AND o.renewal_operation_id IS NOT NULL THEN
   SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=o.renewal_operation_id;
   IF NOT FOUND OR op.operation_fingerprint IS DISTINCT FROM o.renewal_operation_fingerprint
    OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=op.subscription_id AND client_id=o.client_id)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=o.subscription_cycle_id
      AND subscription_id=op.subscription_id AND renewal_operation_id=op.id
      AND renewal_operation_fingerprint=op.operation_fingerprint) THEN
    RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
   BEGIN v_id:=(op.cycle_snapshot#>>'{orderSnapshot,shippingAddressRef}')::uuid;
   EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'commerce_destination_frozen_ref_invalid' USING ERRCODE='22023'; END;
  ELSIF v_id IS NULL THEN
   SELECT id INTO v_id FROM public.commerce_destinations WHERE purchase_order_id=v_order;
  END IF;
 END IF;
 IF v_id IS NULL THEN RAISE EXCEPTION 'commerce_destination_unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO d FROM public.commerce_destinations WHERE id=v_id;
 IF NOT FOUND OR d.client_id IS DISTINCT FROM o.client_id THEN
  RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='22023'; END IF;
 RETURN pg_catalog.jsonb_build_object('destinationId',d.id,'revision',d.revision,'clientId',d.client_id,'address',d.address,'pinned',v_pinned);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_reserve_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_hold_seconds integer DEFAULT 900,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_line jsonb;
  v_source text;
  v_sku text;
  v_quantity integer;
  v_available integer;
BEGIN
  IF p_operation_id IS NULL OR p_claim_token IS NULL
    OR p_hold_seconds IS NULL OR p_hold_seconds NOT BETWEEN 60 AND 86400
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_input' USING ERRCODE = '22023';
  END IF;

DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.operation_fingerprint <> v_operation.operation_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_reservation.status = 'held'
      AND v_reservation.expires_at <= COALESCE(p_now, now())
      AND v_operation.state = 'reserved'
    THEN
      UPDATE public.fulfillment_inventory_reservations
         SET status = 'expired', expires_at = NULL,
             terminal_reason = 'reservation_expired', updated_at = COALESCE(p_now, now())
       WHERE id = v_reservation.id
       RETURNING * INTO v_reservation;
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':reservation-expired', 'refused',
        'reservation_expired', COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', true, 'reservationId', v_reservation.id,
        'status', 'expired', 'reason', 'reservation_expired');
    END IF;
    RETURN jsonb_build_object(
      'reserved', v_reservation.status IN ('held', 'committed', 'consumed'),
      'replayed', true, 'reservationId', v_reservation.id,
      'status', v_reservation.status, 'reason', v_reservation.terminal_reason);
  END IF;

  IF v_operation.state <> 'claimed' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_state' USING ERRCODE = '22023';
  END IF;
  v_source := v_operation.cycle_snapshot->>'stockSourceKey';
  IF v_source IS NULL OR v_source !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  -- Lock all stock rows in a deterministic order before computing ATP, so two different
  -- operations containing the same SKUs cannot both spend the same observed availability.
  PERFORM stock.sku
    FROM public.fulfillment_stock_current stock
    JOIN jsonb_array_elements(v_operation.cycle_snapshot->'lines') line
      ON stock.source_key = v_source AND stock.sku = line->>'sku'
   ORDER BY stock.sku
   FOR UPDATE OF stock;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_sku := v_line->>'sku';
    BEGIN v_quantity := (v_line->>'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END;
    IF btrim(COALESCE(v_sku, '')) = '' OR v_quantity < 1 THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END IF;

    SELECT (public.inventory_available_to_promise(v_source,v_sku,COALESCE(p_now,now()),true)
      ->>'available_quantity')::integer INTO v_available;
    IF v_available < v_quantity THEN
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'inventory_unavailable', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':inventory', 'refused', 'inventory_unavailable',
        COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', false, 'reservationId', NULL,
        'status', 'refused', 'reason', 'inventory_unavailable');
    END IF;
  END LOOP;

  INSERT INTO public.fulfillment_inventory_reservations (
    renewal_operation_id, operation_fingerprint, source_key, expires_at, created_at, updated_at
  ) VALUES (
    p_operation_id, v_operation.operation_fingerprint, v_source,
    COALESCE(p_now, now()) + make_interval(secs => p_hold_seconds),
    COALESCE(p_now, now()), COALESCE(p_now, now())
  ) RETURNING * INTO v_reservation;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    INSERT INTO public.fulfillment_inventory_reservation_lines (
      reservation_id, operation_fingerprint, sku, quantity
    ) VALUES (
      v_reservation.id, v_operation.operation_fingerprint,
      v_line->>'sku', (v_line->>'quantity')::integer);
  END LOOP;

  UPDATE public.subscription_renewal_operations
     SET state = 'reserved', updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id;
  RETURN jsonb_build_object(
    'reserved', true, 'replayed', false, 'reservationId', v_reservation.id,
    'status', 'held', 'reason', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_release_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_reason text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
BEGIN
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'fulfillment_renewal_release_reason_required' USING ERRCODE = '22023';
  END IF;
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_release_stale_claim' USING ERRCODE = '40001';
  END IF;
  IF v_operation.state = 'attempt_prepared' THEN
    RAISE EXCEPTION 'fulfillment_renewal_release_attempt_indeterminate' USING ERRCODE = '22023';
  END IF;
  IF v_operation.state IN ('succeeded', 'refused') THEN
    RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal');
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF FOUND AND v_reservation.status = 'held' THEN
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'released', expires_at = NULL, terminal_reason = p_reason,
           updated_at = COALESCE(p_now, now())
     WHERE id = v_reservation.id;
  END IF;
  UPDATE public.subscription_renewal_operations
     SET state = 'refused', terminal_outcome = 'refused', terminal_reason = p_reason,
         terminal_at = COALESCE(p_now, now()), updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  INSERT INTO public.subscription_renewal_outcomes (
    renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
  ) VALUES (
    p_operation_id, v_operation.operation_fingerprint,
    v_operation.identity_key || ':release', 'refused', p_reason, COALESCE(p_now, now()));
  RETURN public.subscription_renewal_operation_response(v_operation, false, false, 'released');
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_expire_subscription_renewals(
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE v_row record; v_count integer := 0;
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
  FOR v_row IN
    SELECT reservation.id, reservation.renewal_operation_id
      FROM public.fulfillment_inventory_reservations reservation
      JOIN public.subscription_renewal_operations operation
        ON operation.id = reservation.renewal_operation_id
     WHERE reservation.status = 'held'
       AND reservation.expires_at <= COALESCE(p_now, now())
       AND operation.state = 'reserved'
     ORDER BY reservation.expires_at, reservation.id
     FOR UPDATE OF reservation, operation SKIP LOCKED
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
  LOOP
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'expired', expires_at = NULL, terminal_reason = 'reservation_expired',
           updated_at = COALESCE(p_now, now())
     WHERE id = v_row.id;
    UPDATE public.subscription_renewal_operations
       SET state = 'refused', terminal_outcome = 'refused',
           terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_row.renewal_operation_id;
    INSERT INTO public.subscription_renewal_outcomes (
      renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
    ) SELECT operation.id, operation.operation_fingerprint,
             operation.identity_key || ':reservation-expired', 'refused',
             'reservation_expired', COALESCE(p_now, now())
        FROM public.subscription_renewal_operations operation
       WHERE operation.id = v_row.renewal_operation_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_admit(p_input jsonb,p_due jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE frozen jsonb; op public.subscription_renewal_operations; result jsonb; c public.subscription_stock_wait_cases;
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=(p_input->>'operationId')::uuid;
 frozen:=public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at);
 IF frozen IS NULL OR frozen->'snapshot' IS DISTINCT FROM p_input->'snapshot' OR
  frozen->>'operationFingerprint' IS DISTINCT FROM p_input->>'operationFingerprint' OR
  frozen->>'identityKey' IS DISTINCT FROM p_input->>'identityKey' OR
  (p_due ? 'stockWaitRecovery' AND frozen->'binding' IS DISTINCT FROM p_due->'stockWaitRecovery') THEN
  RAISE EXCEPTION 'stock_wait_frozen_binding_changed' USING ERRCODE='23505'; END IF;
 IF op.state='refused' OR (op.state='reserved' AND op.lease_expires_at<=p_now) THEN
  RETURN public.subscription_stock_wait_recover_refusal(op.id,op.operation_fingerprint,p_input->>'worker',p_now);
 END IF;
 IF op.state='reserved' THEN RETURN public.subscription_renewal_operation_response(op,false,true,'stock_secured'); END IF;
 result:=public.fulfillment_reserve_subscription_renewal(op.id,(p_input->>'claimToken')::uuid,900,p_now);
 IF (result->>'reserved')::boolean THEN RETURN result||jsonb_build_object('waiting',false); END IF;
 -- Record the wait immediately; lease expiry is still required before reset.
 INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 SELECT op.subscription_id,s.client_id,op.id,op.scheduled_at,op.cycle_number,'waiting',p_due,op.cycle_snapshot,
  op.operation_fingerprint,op.identity_key,public.subscription_stock_wait_deficits(op.cycle_snapshot,op.id,p_now),p_now,p_now
 FROM public.subscriptions s WHERE s.id=op.subscription_id
 ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET last_checked_at=p_now RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_enqueue(c,'started');
 RETURN result||jsonb_build_object('waiting',true,'caseId',c.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_recover_refusal(p_operation_id uuid,p_fingerprint text,p_worker text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE s public.subscriptions; op public.subscription_renewal_operations; c public.subscription_stock_wait_cases;
 r public.fulfillment_inventory_reservations; deficits jsonb; token uuid:=gen_random_uuid();
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
 SELECT * INTO s FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO c FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO r FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 IF op.id IS NULL OR s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM op.scheduled_at OR
  op.operation_fingerprint IS DISTINCT FROM p_fingerprint OR btrim(COALESCE(p_worker,''))='' OR
  (c.id IS NOT NULL AND (c.fingerprint<>op.operation_fingerprint OR c.cycle_snapshot<>op.cycle_snapshot OR c.identity_key<>op.identity_key OR c.state='closed')) THEN
  RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF c.state='stock_secured' AND op.state='reserved' AND r.status='held' AND r.expires_at>p_now AND op.lease_expires_at>p_now THEN
  RETURN public.subscription_renewal_operation_response(op,false,true,'stock_secured'); END IF;
 IF NOT COALESCE(((op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired')) OR
  (op.state='reserved' AND c.state='stock_secured' AND r.status='held')),false) OR op.lease_expires_at>p_now OR
  op.attempt_prepared_at IS NOT NULL OR op.external_attempt_ref IS NOT NULL OR op.external_attempt_acknowledged_at IS NOT NULL OR
  EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.commerce_orders WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id AND
   (outcome<>'refused' OR reason IS NULL OR reason NOT IN ('inventory_unavailable','reservation_expired') OR external_ref IS NOT NULL
    OR operation_fingerprint<>op.operation_fingerprint OR event_key NOT IN (op.identity_key||':inventory',op.identity_key||':reservation-expired'))) OR
  (r.id IS NOT NULL AND (r.operation_fingerprint<>p_fingerprint OR r.source_key IS DISTINCT FROM op.cycle_snapshot->>'stockSourceKey' OR (r.status NOT IN ('expired','released') AND NOT (r.status='held' AND c.state='stock_secured')))) THEN
  RAISE EXCEPTION 'stock_wait_recovery_provider_owned_or_not_eligible' USING ERRCODE='22023'; END IF;
 deficits:=public.subscription_stock_wait_deficits(op.cycle_snapshot,op.id,p_now);
 INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 VALUES(s.id,s.client_id,op.id,op.scheduled_at,op.cycle_number,'waiting',to_jsonb(op),op.cycle_snapshot,op.operation_fingerprint,op.identity_key,deficits,p_now,p_now)
 ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET deficits=EXCLUDED.deficits,last_checked_at=p_now RETURNING * INTO c;
 IF jsonb_array_length(deficits)>0 THEN
  UPDATE public.subscription_stock_wait_cases SET state='waiting',block_reason='inventory_unavailable' WHERE id=c.id RETURNING * INTO c;
  PERFORM public.subscription_stock_wait_enqueue(c,'started');
  RETURN jsonb_build_object('waiting',true,'caseId',c.id,'deficits',deficits);
 END IF;
 -- All effects inside this block roll back on a stock shortage. The wait row
 -- remains outside it; prior commitments are never released to try another SKU.
 BEGIN
  -- The base stock rail uses one local refusal key per schedule/reason. Archive
  -- those exact non-payment receipts before clearing them for this bounded
  -- reset, so a later expiry can reuse the original key without a unique-key
  -- failure. Provider/money outcomes are rejected above and never removed.
  UPDATE public.subscription_stock_wait_cases SET refusal_observations=refusal_observations||
   COALESCE((SELECT jsonb_agg(to_jsonb(observation) ORDER BY occurred_at,id) FROM public.subscription_renewal_outcomes observation WHERE renewal_operation_id=op.id),'[]'::jsonb)
   WHERE id=c.id;
  DELETE FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id;
  UPDATE public.subscription_renewal_operations SET state='claimed',terminal_outcome=NULL,terminal_reason=NULL,terminal_at=NULL,
   claim_token=token,claim_generation=claim_generation+1,claimed_by=p_worker,claimed_at=p_now,lease_expires_at=p_now+interval '5 minutes',updated_at=p_now WHERE id=op.id;
  IF r.id IS NULL THEN
   IF NOT (public.fulfillment_reserve_subscription_renewal(op.id,token,900,p_now)->>'reserved')::boolean THEN
    RAISE EXCEPTION 'stock_wait_atomic_shortage' USING ERRCODE='23514'; END IF;
  ELSE
   -- Restore exactly the expired reservation's original frozen lines.
   IF (SELECT jsonb_agg(jsonb_build_object('sku',sku,'quantity',quantity) ORDER BY sku) FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=r.id)
    IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('sku',l->>'sku','quantity',(l->>'quantity')::integer) ORDER BY l->>'sku') FROM jsonb_array_elements(op.cycle_snapshot->'lines') l) THEN
    RAISE EXCEPTION 'stock_wait_reservation_snapshot_mismatch'; END IF;
   UPDATE public.fulfillment_inventory_reservations SET status='held',expires_at=p_now+interval '15 minutes',terminal_reason=NULL,updated_at=p_now WHERE id=r.id;
   UPDATE public.subscription_renewal_operations SET state='reserved' WHERE id=op.id;
  END IF;
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'stock_wait_atomic_shortage' THEN RAISE; END IF;
  UPDATE public.subscription_stock_wait_cases SET block_reason='inventory_unavailable',state='waiting' WHERE id=c.id;
  RETURN jsonb_build_object('waiting',true,'caseId',c.id);
 END;
 UPDATE public.subscription_stock_wait_cases SET state='stock_secured',deficits='[]',block_reason=NULL,
  stock_secured_at=COALESCE(stock_secured_at,p_now),last_checked_at=p_now WHERE id=c.id;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=op.id;
 RETURN public.subscription_renewal_operation_response(op,true,false,'stock_secured')||jsonb_build_object('waiting',false,'caseId',c.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_deficits(p_snapshot jsonb,p_operation_id uuid,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE line record; stock public.fulfillment_stock_current; required bigint; own_qty bigint;
 available bigint; promise jsonb; result jsonb:='[]'; source text:=p_snapshot->>'stockSourceKey';
BEGIN
 IF jsonb_typeof(p_snapshot->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'lines')=0 OR source IS NULL THEN
  RAISE EXCEPTION 'stock_wait_invalid_basket' USING ERRCODE='22023'; END IF;
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
 PERFORM s.sku FROM public.fulfillment_stock_current s JOIN jsonb_array_elements(p_snapshot->'lines') l ON l->>'sku'=s.sku
  WHERE s.source_key=source ORDER BY s.sku FOR UPDATE OF s;
 FOR line IN SELECT l->>'sku' sku,sum((l->>'quantity')::integer) quantity FROM jsonb_array_elements(p_snapshot->'lines') l GROUP BY l->>'sku' ORDER BY l->>'sku' LOOP
  required:=line.quantity;
  IF required IS NULL OR required<1 OR btrim(COALESCE(line.sku,''))='' THEN RAISE EXCEPTION 'stock_wait_invalid_quantity'; END IF;
  SELECT * INTO stock FROM public.fulfillment_stock_current WHERE source_key=source AND sku=line.sku;
  IF stock.sku IS NULL THEN RAISE EXCEPTION 'stock_wait_stock_missing'; END IF;
  IF stock.stale_after<=p_now THEN RAISE EXCEPTION 'stock_wait_stock_stale'; END IF;
  SELECT COALESCE(sum(l.quantity),0) INTO own_qty
   FROM public.fulfillment_inventory_reservations r JOIN public.fulfillment_inventory_reservation_lines l ON l.reservation_id=r.id
   WHERE r.source_key=source AND l.sku=line.sku AND r.renewal_operation_id=p_operation_id
    AND (r.status='committed' OR (r.status='held' AND r.expires_at>p_now));
  promise:=public.inventory_available_to_promise(source,line.sku,p_now,true);
  available:=CASE WHEN stock.inventory_class='sellable' THEN (promise->>'available_quantity')::bigint ELSE 0 END;
  IF own_qty+available<required THEN
   result:=result||jsonb_build_array(jsonb_build_object('sku',line.sku,'requiredUnits',required,'reservedUnits',own_qty,
    'availableUnits',available,'missingUnits',required-own_qty-available));
  END IF;
 END LOOP;
 RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_view_shipment_destination(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_view_shipment_destination(uuid) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_view_shipment_destination(uuid) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_view_shipment_destination(uuid) TO service_role'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_cycle_id uuid;
  v_order_id uuid;
  v_intent_id uuid;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_quantity integer;
  v_unit_amount bigint;
  v_total bigint;
  v_currency text;
  v_channel text;
BEGIN
  SELECT subscription_id INTO v_operation.subscription_id
    FROM public.subscription_renewal_operations WHERE id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM id FROM public.subscriptions
   WHERE id = v_operation.subscription_id FOR UPDATE;

  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'commerce_renewal_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT cycle.id, order_row.id, intent.id
    INTO v_cycle_id, v_order_id, v_intent_id
    FROM public.subscription_cycles cycle
    JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id
    JOIN public.commerce_settlement_intents intent ON intent.order_id = order_row.id
   WHERE cycle.renewal_operation_id = p_operation_id;
  IF FOUND THEN
    IF v_operation.state <> 'attempt_prepared' THEN
      RAISE EXCEPTION 'commerce_renewal_artifact_state_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'platform.subscription.renewal.v1', 'replayed', true,
      'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
      'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
      'state', v_operation.state);
  END IF;
  IF v_operation.state <> 'reserved' THEN
    RAISE EXCEPTION 'commerce_renewal_reservation_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_reservation.status <> 'held'
    OR v_reservation.expires_at <= COALESCE(p_now, now())
    OR v_reservation.operation_fingerprint <> v_operation.operation_fingerprint
  THEN
    RAISE EXCEPTION 'commerce_renewal_active_reservation_required' USING ERRCODE = '22023';
  END IF;

  v_currency := v_operation.cycle_snapshot->>'currency';
  v_channel := v_operation.cycle_snapshot->>'settlementChannelKey';
  v_total := (v_operation.cycle_snapshot->>'totalAmountMinor')::bigint;
  IF v_currency !~ '^[A-Z]{3}$' OR btrim(COALESCE(v_channel, '')) = '' OR v_total < 1 THEN
    RAISE EXCEPTION 'commerce_renewal_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_cycles (
    subscription_id, scheduled_at, status, renewal_operation_id,
    renewal_operation_fingerprint, updated_at
  ) VALUES (
    v_operation.subscription_id, v_operation.scheduled_at, 'payment_pending', p_operation_id,
    v_operation.operation_fingerprint, COALESCE(p_now, now())
  ) RETURNING id INTO v_cycle_id;

  INSERT INTO public.commerce_orders (
    client_id, subscription_cycle_id, status, currency_code, total_amount_minor,
    source_kind, metadata, renewal_operation_id, renewal_operation_fingerprint, updated_at
  ) SELECT subscription.client_id, v_cycle_id, 'pending_payment', v_currency, v_total,
           'storefront', jsonb_build_object(
             'source', 'subscription.renewal',
             'renewalIdentityKey', v_operation.identity_key,
             'renewalOperationFingerprint', v_operation.operation_fingerprint,
             'cycleSnapshot', v_operation.cycle_snapshot),
           p_operation_id, v_operation.operation_fingerprint, COALESCE(p_now, now())
      FROM public.subscriptions subscription WHERE subscription.id = v_operation.subscription_id
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_amount := (v_line->>'unitAmountMinor')::bigint;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    IF NOT FOUND OR v_quantity < 1 OR v_unit_amount < 0 THEN
      RAISE EXCEPTION 'commerce_renewal_invalid_line' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_amount,
      v_quantity * v_unit_amount);
  END LOOP;

  PERFORM public.commerce_open_settlement_intent(
    v_operation.identity_key || ':settlement', v_order_id, v_channel, v_total, v_currency,
    jsonb_build_object(
      'renewalOperationId', p_operation_id,
      'renewalOperationFingerprint', v_operation.operation_fingerprint),
    COALESCE(p_now, now()));
  SELECT id INTO v_intent_id FROM public.commerce_settlement_intents WHERE order_id = v_order_id;
  UPDATE public.commerce_settlement_intents
     SET renewal_operation_id = p_operation_id,
         renewal_operation_fingerprint = v_operation.operation_fingerprint,
         updated_at = COALESCE(p_now, now())
   WHERE id = v_intent_id;
  UPDATE public.fulfillment_inventory_reservations
     SET status = 'committed', expires_at = NULL, updated_at = COALESCE(p_now, now())
   WHERE id = v_reservation.id;
  UPDATE public.subscription_renewal_operations
     SET state = 'attempt_prepared', attempt_prepared_at = COALESCE(p_now, now()),
         updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'contractVersion', 'platform.subscription.renewal.v1', 'replayed', false,
    'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
    'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
    'state', v_operation.state);
END;
$$;
