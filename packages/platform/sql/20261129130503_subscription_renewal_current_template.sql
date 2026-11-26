ALTER TABLE public.subscription_renewal_operations ADD COLUMN claimed_before_rnw_1 boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.subscription_renewal_snapshot_is_billing(p_wire jsonb, p_has_build_evidence boolean)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_wire) IS DISTINCT FROM 'object'
      OR p_wire->>'contractVersion' = 'platform.subscription.renewal.v3'
      OR jsonb_typeof(p_wire->'lines') IS DISTINCT FROM 'array' THEN false
    WHEN NOT p_has_build_evidence
      AND NOT (p_wire ?| ARRAY['frozenRevision', 'templateSnapshot', 'pricingSnapshot'])
      AND p_wire->'orderSnapshot' = jsonb_build_object(
        'shippingAddressRef', p_wire#>'{orderSnapshot,shippingAddressRef}'
      ) THEN false
    WHEN pg_input_is_valid(p_wire->>'totalAmountMinor', 'bigint') THEN COALESCE(
      btrim(p_wire->>'settlementChannelKey') <> ''
      AND p_wire->>'currency' ~ '^[A-Z]{3}$'
      AND (p_wire->>'totalAmountMinor')::bigint > 0
      AND jsonb_array_length(p_wire->'lines') > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_wire->'lines') AS line(value)
        WHERE (CASE
          WHEN pg_input_is_valid(value->>'quantity', 'integer')
            AND pg_input_is_valid(value->>'unitAmountMinor', 'bigint')
          THEN btrim(value->>'sku') <> ''
            AND (value->>'quantity')::integer > 0
            AND (value->>'unitAmountMinor')::bigint >= 0
        END) IS NOT TRUE
      ), false)
    ELSE false
  END;
$$;

CREATE FUNCTION public.subscription_renewal_snapshot_is_stale(
  p_template_version integer, p_wire jsonb, p_build_template_version integer
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(CASE
    WHEN NOT public.subscription_renewal_snapshot_is_billing(p_wire, COALESCE(p_build_template_version > 0, false)) THEN false
    WHEN p_wire ?| ARRAY['frozenRevision', 'templateSnapshot'] THEN
      jsonb_path_exists(p_wire, 'strict $.templateSnapshot.version ? (
        @.type() == "number" && @ > 0 && @ <= 2147483647 && @.floor() == @
      )', '{}'::jsonb, true)
      AND p_wire#>'{templateSnapshot,version}' <> to_jsonb(p_template_version)
    ELSE p_build_template_version > 0 AND p_template_version > p_build_template_version
  END, false);
$$;

REVOKE ALL ON FUNCTION public.subscription_renewal_snapshot_is_billing(jsonb,boolean), public.subscription_renewal_snapshot_is_stale(integer,jsonb,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_renewal_snapshot_is_billing(jsonb,boolean), public.subscription_renewal_snapshot_is_stale(integer,jsonb,integer) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_renewal_snapshot_is_billing(jsonb,boolean), public.subscription_renewal_snapshot_is_stale(integer,jsonb,integer) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_renewal_snapshot_is_billing(jsonb,boolean), public.subscription_renewal_snapshot_is_stale(integer,jsonb,integer) TO service_role;';
END IF; END; $$;

UPDATE public.subscription_renewal_operations o
   SET claimed_before_rnw_1 = true
  FROM public.subscriptions s
 WHERE s.id = o.subscription_id
   AND (o.state IN ('claimed', 'reserved', 'attempt_prepared')
     OR (o.state = 'refused' AND (
       EXISTS (
         SELECT 1 FROM public.subscription_retry_obligations r
         JOIN public.subscription_cycles c ON c.id = r.cycle_id AND c.status = 'payment_pending'
         JOIN public.commerce_settlement_intents i ON i.id = r.settlement_intent_id AND i.status IN ('created', 'failed')
         WHERE r.renewal_operation_id = o.id AND r.state IN ('waiting', 'prepared')
       )
       OR (o.terminal_reason IN ('inventory_unavailable', 'reservation_expired') AND (
         EXISTS (
           SELECT 1 FROM public.subscription_stock_wait_cases w
           WHERE w.renewal_operation_id = o.id AND w.state IN ('waiting', 'stock_secured')
         )
         OR (NOT EXISTS (SELECT 1 FROM public.subscription_stock_wait_cases w WHERE w.renewal_operation_id = o.id)
           AND public.subscription_stock_wait_frozen(o.subscription_id, o.scheduled_at) IS NOT NULL)
       ))
     )))
   AND public.subscription_renewal_snapshot_is_stale(s.template_version, o.cycle_snapshot, NULL::integer);

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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_subscription_id uuid;
  v_scheduled_at timestamptz;
  v_cycle_number integer;
  v_acceptance jsonb;
  v_build_template_version integer;
  v_has_build_envelope boolean := false;
  v_subscription public.subscriptions%ROWTYPE;
  v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_cycle_snapshot->>'contractVersion' = 'platform.subscription.renewal.claim-build.v1' THEN
    v_has_build_envelope := true;
    IF jsonb_typeof(p_cycle_snapshot->'buildTemplateVersion') = 'number'
      AND pg_input_is_valid(p_cycle_snapshot->>'buildTemplateVersion', 'integer')
    THEN
      v_build_template_version := (p_cycle_snapshot->>'buildTemplateVersion')::integer;
    END IF;
    p_cycle_snapshot := p_cycle_snapshot->'cycleSnapshot';
  END IF;

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

  IF p_cycle_snapshot ?| ARRAY['frozenRevision', 'templateSnapshot']
    AND public.subscription_renewal_snapshot_is_billing(p_cycle_snapshot, v_has_build_envelope)
    AND jsonb_path_exists(p_cycle_snapshot, 'strict $.templateSnapshot.version ? (
      @.type() == "number" && @ > 0 && @ <= 2147483647 && @.floor() == @
    )', '{}'::jsonb, true) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END IF;
  IF public.subscription_renewal_snapshot_is_stale(
    v_subscription.template_version, p_cycle_snapshot, v_build_template_version
  ) THEN
    RAISE EXCEPTION 'subscription_renewal_snapshot_stale' USING ERRCODE = '22023',
      DETAIL = '/cycleSnapshot',
      HINT = 'Re-read the due subscription and rebuild its cycle snapshot before claiming again.';
  END IF;

  SELECT catalog_acceptance INTO v_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=v_subscription_id;
  IF v_acceptance IS NOT NULL AND (
     p_cycle_snapshot#>'{templateSnapshot,version}' IS DISTINCT FROM to_jsonb(v_subscription.template_version)
     OR public.catalog_retained_basket_v2(p_cycle_snapshot->'lines',true) IS DISTINCT FROM (
       SELECT jsonb_object_agg(sku,quantity) FROM (
        SELECT sku,sum(quantity) AS quantity FROM public.subscription_renewal_term_lines
        WHERE subscription_id=v_subscription_id GROUP BY sku) lines)
     OR EXISTS(SELECT 1 FROM public.subscription_lines l
      WHERE l.subscription_id=v_subscription_id AND l.catalog_sku_revision_id IS DISTINCT FROM (
       SELECT (ref->>'skuRevisionId')::uuid FROM jsonb_array_elements(v_acceptance->'lines') ref WHERE ref->'skuId'=to_jsonb(l.variant_id)))
   ) THEN RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023',
   HINT='Rebuild the cycle snapshot from the current due subscription before retrying.'; END IF;

  INSERT INTO public.subscription_renewal_operations (
    subscription_id, scheduled_at, cycle_number, identity_key, operation_fingerprint,
    catalog_acceptance, catalog_acceptance_fingerprint, cycle_snapshot, claim_token, claimed_by, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_subscription_id, v_scheduled_at, v_cycle_number, p_identity_key,
    p_operation_fingerprint, v_acceptance,
    CASE WHEN v_acceptance IS NOT NULL THEN p_operation_fingerprint END,
    p_cycle_snapshot, gen_random_uuid(), p_worker_id,
    COALESCE(p_now, now()), COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
    COALESCE(p_now, now())
  ) RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(v_operation, true, false, 'claimed');
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
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
  PERFORM 1 FROM public.subscriptions
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

  IF v_operation.claimed_before_rnw_1 THEN
    RAISE EXCEPTION 'subscription_renewal_snapshot_stale' USING ERRCODE = '22023',
      DETAIL = '/cycleSnapshot',
      HINT = 'Reconcile the stored renewal operation before resuming it. See the renewal upgrade report.';
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
    source_kind, metadata, renewal_operation_id, renewal_operation_fingerprint, catalog_acceptance, updated_at
  ) SELECT subscription.client_id, v_cycle_id, 'pending_payment', v_currency, v_total,
           'storefront', public.customer_renewal_delivery_selection(v_operation.subscription_id,jsonb_build_object(
             'source', 'subscription.renewal',
             'renewalIdentityKey', v_operation.identity_key,
             'renewalOperationFingerprint', v_operation.operation_fingerprint,
             'cycleSnapshot', v_operation.cycle_snapshot)),
           p_operation_id, v_operation.operation_fingerprint, v_operation.catalog_acceptance, COALESCE(p_now, now())
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

CREATE OR REPLACE FUNCTION public.subscription_retry_prepare(p_operation_id uuid,p_key text,p_input jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.subscription_retry_obligations; op public.subscription_renewal_operations; r public.subscription_retry_receipts;
 a public.subscription_retry_recovery_authorizations; real_authority public.payment_method_recovery_authorities; real_method boolean; reservation public.fulfillment_inventory_reservations;
 line record; available bigint; committed bigint; result jsonb; method public.payment_method_refs; recovery_token public.commerce_checkout_recovery_tokens;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=op.id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'prepare' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result||jsonb_build_object('execute',false,'replayed',true);
 END IF;
 IF op.claimed_before_rnw_1 AND o.state='waiting' THEN
  RAISE EXCEPTION 'subscription_renewal_snapshot_stale' USING ERRCODE = '22023',
    DETAIL = '/cycleSnapshot',
    HINT = 'Reconcile the stored renewal operation before resuming it. See the renewal upgrade report.';
 END IF;
 IF o.id IS NULL OR o.state<>'waiting' OR o.next_retry_at IS NULL OR o.next_retry_at>p_now OR o.renewal_quarantined_until>p_now OR
  NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=o.subscription_id AND status='active') OR
  NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=o.cycle_id AND status='payment_pending') OR
  NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=o.settlement_intent_id AND status='failed') OR
  btrim(COALESCE(p_input->>'idempotencyKey',''))='' OR btrim(COALESCE(p_input->>'providerIdempotencyKey',''))='' OR
  COALESCE(p_input->>'providerRequestFingerprint','') !~ '^[0-9a-f]{64}$' OR
  p_input->>'paymentIntentId' IS DISTINCT FROM o.settlement_intent_id::text OR
  p_input->>'orderRef' IS DISTINCT FROM o.order_id::text OR
  (p_input->>'amountMinor')::bigint IS DISTINCT FROM (o.cycle_snapshot->>'totalAmountMinor')::bigint OR
  p_input->>'currency' IS DISTINCT FROM o.cycle_snapshot->>'currency' OR
  EXISTS(SELECT 1 FROM public.subscription_retry_receipts WHERE kind='prepare' AND (input->>'idempotencyKey'=p_input->>'idempotencyKey' OR input->>'providerIdempotencyKey'=p_input->>'providerIdempotencyKey')) OR btrim(COALESCE(p_input->>'paymentMethodRef',''))='' THEN
  RAISE EXCEPTION 'subscription_retry_not_due_or_ambiguous' USING ERRCODE='22023'; END IF;
 real_method:=public.subscription_method_uses_recorded_refs(o.subscription_id);
 IF real_method THEN
  SELECT recorded.* INTO real_authority FROM jsonb_populate_record(NULL::public.payment_method_recovery_authorities,public.payment_method_recovery_authority_read(o.method_recovery_authority_id)) recorded
   WHERE recorded.retry_attempt=o.retry_attempt;
  IF (o.retry_attempt>=4 OR o.failure_class='hard_do_not_retry') AND (real_authority.id IS NULL OR real_authority.retry_attempt<>o.retry_attempt OR real_authority.dispatch_key IS NOT NULL) THEN
   RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
  SELECT * INTO recovery_token FROM public.commerce_checkout_recovery_tokens WHERE id=real_authority.token_id FOR UPDATE;
  SELECT * INTO method FROM jsonb_populate_record(NULL::public.payment_method_refs,
   public.payment_method_ref_for_subscription_read(o.subscription_id,p_input->>'paymentMethodRef',p_now));
  IF method.id IS NULL THEN
   RAISE EXCEPTION 'subscription_missing_payment_method_ref' USING ERRCODE='22023'; END IF;
  IF NOT public.subscription_method_chargeable_unattended(o.subscription_id,p_now) OR
   (real_authority.id IS NOT NULL AND (real_authority.retry_attempt<>o.retry_attempt OR real_authority.dispatch_key IS NOT NULL OR real_authority.method_ref IS DISTINCT FROM p_input->>'paymentMethodRef' OR real_authority.method_id IS DISTINCT FROM method.id OR recovery_token.id IS NULL OR recovery_token.revoked_at IS NOT NULL OR recovery_token.expires_at<=p_now OR real_authority.revoked_at IS NOT NULL)) THEN
   RAISE EXCEPTION 'subscription_retry_method_mismatch'; END IF;
 ELSE
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=o.id AND retry_attempt=o.retry_attempt FOR UPDATE;
 IF (o.retry_attempt>=4 OR o.failure_class='hard_do_not_retry') AND (a.id IS NULL OR a.consumed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 IF a.id IS NOT NULL AND (a.method_ref IS DISTINCT FROM p_input->>'paymentMethodRef' OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy')) THEN RAISE EXCEPTION 'subscription_retry_method_mismatch'; END IF;
 END IF;
 SELECT * INTO reservation FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=op.id FOR UPDATE;
 IF reservation.id IS NULL OR reservation.operation_fingerprint<>o.operation_fingerprint THEN RAISE EXCEPTION 'subscription_retry_stock_binding_missing'; END IF;
 PERFORM stock.sku FROM public.fulfillment_stock_current stock JOIN public.fulfillment_inventory_reservation_lines l ON l.sku=stock.sku
  WHERE l.reservation_id=reservation.id AND stock.source_key=reservation.source_key ORDER BY stock.sku FOR UPDATE OF stock;
 FOR line IN SELECT * FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=reservation.id ORDER BY sku LOOP
  SELECT for_sale_quantity INTO available FROM public.fulfillment_stock_current WHERE source_key=reservation.source_key AND sku=line.sku
   AND inventory_class='sellable' AND stale_after>p_now;
  SELECT COALESCE(sum(l.quantity),0) INTO committed FROM public.fulfillment_inventory_reservation_lines l
   JOIN public.fulfillment_inventory_reservations rr ON rr.id=l.reservation_id WHERE rr.source_key=reservation.source_key AND l.sku=line.sku
   AND rr.id<>reservation.id AND (rr.status='committed' OR (rr.status='held' AND rr.expires_at>p_now));
  IF available IS NULL OR available-committed<line.quantity THEN RAISE EXCEPTION 'subscription_retry_inventory_unavailable' USING ERRCODE='23514'; END IF;
 END LOOP;
 UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL,terminal_reason=NULL,updated_at=p_now WHERE id=reservation.id;
 UPDATE public.subscription_retry_obligations SET state='prepared',attempt_sequence=attempt_sequence+1,next_retry_at=NULL,updated_at=p_now WHERE id=o.id RETURNING * INTO o;
 UPDATE public.subscription_retry_recovery_authorizations SET consumed_at=p_now WHERE id=a.id;
 IF real_authority.id IS NOT NULL THEN PERFORM public.payment_method_recovery_authority_freeze(real_authority.id,p_operation_id,p_key,p_input->>'paymentMethodRef',p_now); END IF;
 result:=jsonb_build_object('execute',true,'replayed',false,'obligationId',o.id,'attemptSequence',o.attempt_sequence,
  'cycleId',o.cycle_id,'orderId',o.order_id,'settlementIntentId',o.settlement_intent_id,'identityKey',o.identity_key,
  'operationFingerprint',o.operation_fingerprint,'snapshot',o.cycle_snapshot,'request',p_input);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'prepare',o.attempt_sequence,p_input,result);
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_delivery_alignment_on_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case public.subscription_delivery_alignment_cases%ROWTYPE;
  v_inherited_case_id uuid;
  v_order public.commerce_orders%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_open_dunning boolean;
  v_artifact_reason text;
  v_latest_delivered_at timestamptz;
  v_target timestamptz;
  v_predecessor_number integer;
  v_qualified_arrival boolean := false;
BEGIN
  IF NEW.delivered_at IS NULL
     OR (TG_OP = 'UPDATE' AND OLD.delivered_at IS NOT DISTINCT FROM NEW.delivered_at)
  THEN
    RETURN NEW;
  END IF;

  -- Derive the aggregate from the fulfillment's order, then lock it before
  -- examining its ledger. This fence is required even when there is no case
  -- yet: otherwise delivery could return on an empty lookup while concurrent
  -- admission creates protection from the not-yet-committed delivery.
  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE id = NEW.order_id
     AND subscription_cycle_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = (SELECT subscription_id FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Admission or exception evidence may have changed the case while this
  -- transaction waited for the aggregate, so take the case lock only now.
  SELECT * INTO v_case
    FROM public.subscription_delivery_alignment_cases
   WHERE shipment_id = NEW.id
   FOR UPDATE;

  -- A replacement parcel is created after the case was already open, so it never
  -- carries a case of its own. It is the arrival the customer is actually
  -- waiting for, so it settles the case its predecessor opened on the same
  -- order. An open case is preferred because that is the one holding the
  -- renewal. Ordinary parcels never enter this branch: they replace nothing.
  IF NOT FOUND AND NEW.replaces_shipment_id IS NOT NULL THEN
    SELECT id INTO v_inherited_case_id
      FROM public.subscription_delivery_alignment_cases
     WHERE predecessor_order_id = NEW.order_id
     ORDER BY (state IN ('protected', 'manual_review')) DESC, created_at ASC, id ASC
     LIMIT 1;
    IF v_inherited_case_id IS NOT NULL THEN
      SELECT * INTO v_case
        FROM public.subscription_delivery_alignment_cases
       WHERE id = v_inherited_case_id
       FOR UPDATE;
    END IF;
  END IF;
  IF v_case.id IS NULL OR v_case.state = 'shadow' THEN
    -- A refused claim may have left admission with no case or only shadow cases.
    <<qualify_arrival>>
    BEGIN
      IF (TG_OP = 'UPDATE' AND OLD.delivered_at IS NOT NULL)
        OR v_subscription.status <> 'active'
        OR EXISTS (SELECT 1 FROM public.fulfillment_shipments WHERE replaces_shipment_id = NEW.id)
        OR v_subscription.next_cycle_at IS NULL
        OR public.subscription_delivery_alignment_get_mode() IS DISTINCT FROM 'auto_align'
        OR NOT EXISTS (SELECT 1 FROM public.subscription_renewal_terms
                       WHERE subscription_id = v_subscription.id AND delivery_admission = 'allowed')
        OR EXISTS (SELECT 1 FROM public.subscription_renewal_operations
                   WHERE subscription_id = v_subscription.id AND scheduled_at = v_subscription.next_cycle_at)
        OR EXISTS (SELECT 1 FROM public.subscription_delivery_alignment_cases
                   WHERE predecessor_order_id = v_order.id AND state <> 'shadow')
        OR EXISTS (SELECT 1 FROM public.subscription_dunning_cases
                   WHERE subscription_id = v_subscription.id AND status IN ('open', 'expired'))
      THEN
        EXIT qualify_arrival;
      END IF;

      SELECT cycle_number INTO v_predecessor_number
        FROM public.subscription_delivery_alignment_cycles
       WHERE id = v_order.subscription_cycle_id AND order_id = v_order.id AND status = 'paid';
      IF v_predecessor_number IS NULL OR EXISTS (
        SELECT 1 FROM public.subscription_delivery_alignment_cycles c
         WHERE c.subscription_id = v_subscription.id
           AND (c.cycle_number > v_predecessor_number
             OR (c.cycle_number IS NULL AND c.id <> v_order.subscription_cycle_id)
             OR (c.status = 'paid' AND c.cycle_number = v_predecessor_number AND c.order_id IS DISTINCT FROM v_order.id))
      ) OR EXISTS (
        SELECT 1 FROM public.subscription_delivery_alignment_cases c
         WHERE c.subscription_id = v_subscription.id AND c.state IN ('protected', 'manual_review')
           AND (c.predecessor_cycle_number IS NULL OR c.predecessor_cycle_number >= v_predecessor_number)
      ) THEN
        EXIT qualify_arrival;
      END IF;

      SELECT max(parcel.delivered_at) INTO v_latest_delivered_at
        FROM public.fulfillment_shipments parcel
       WHERE parcel.order_id = v_order.id
         AND NOT EXISTS (SELECT 1 FROM public.fulfillment_shipments successor
                          WHERE successor.replaces_shipment_id = parcel.id)
      HAVING count(*) = count(parcel.delivered_at);
      IF v_latest_delivered_at IS NULL OR v_latest_delivered_at <= v_subscription.next_cycle_at THEN
        EXIT qualify_arrival;
      END IF;

      PERFORM public.subscription_delivery_alignment_upsert_case(
        COALESCE(v_case.shipment_id, NEW.id), v_order.id, v_subscription.id, v_order.subscription_cycle_id,
        v_predecessor_number, 'auto_align', 'overdue_renewal', v_subscription.next_cycle_at);
      SELECT * INTO v_case FROM public.subscription_delivery_alignment_cases
       WHERE shipment_id = COALESCE(v_case.shipment_id, NEW.id);
      v_qualified_arrival := true;
    END qualify_arrival;
    IF v_case.id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  UPDATE public.subscription_delivery_alignment_cases
     SET delivered_at = LEAST(COALESCE(delivered_at, NEW.delivered_at), NEW.delivered_at),
         updated_at = now()
   WHERE id = v_case.id
   RETURNING * INTO v_case;

  -- Outstanding means the customer is still waiting for it. A parcel that
  -- another row supersedes through replaces_shipment_id has been
  -- answered by that replacement, and when it was lost its delivered_at stays
  -- null for ever - counting it would hold this case open for ever with it.
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shipments outstanding
     WHERE outstanding.order_id = v_case.predecessor_order_id
       AND outstanding.delivered_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.fulfillment_shipments successor
          WHERE successor.replaces_shipment_id = outstanding.id
       )
  ) THEN
    RETURN NEW;
  END IF;

  IF v_subscription.status <> 'active' THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'released' ELSE state END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.subscription_dunning_cases
     WHERE subscription_id = v_subscription.id
       AND status IN ('open', 'expired')
  ) INTO v_open_dunning;
  IF v_open_dunning THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'manual_review' ELSE state END,
           manual_review_reason = CASE WHEN state = 'protected' THEN 'open_dunning' ELSE manual_review_reason END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.subscription_delivery_alignment_cycles successor
      JOIN public.subscription_renewal_operations operation ON operation.id = successor.renewal_operation_id
      WHERE successor.subscription_id = v_subscription.id
        AND (successor.cycle_number > v_case.predecessor_cycle_number OR (successor.cycle_number IS NULL AND successor.id <> v_case.predecessor_cycle_id))
        AND operation.attempt_prepared_at IS NOT NULL
    ) THEN 'existing_provider_attempt'
    WHEN EXISTS (
      SELECT 1 FROM public.subscription_delivery_alignment_cycles successor
      WHERE successor.subscription_id = v_subscription.id
        AND (successor.cycle_number > v_case.predecessor_cycle_number
             OR (successor.cycle_number IS NULL AND successor.id <> v_case.predecessor_cycle_id))
    ) THEN 'renewal_cycle_already_created'
    ELSE NULL
  END INTO v_artifact_reason;

  IF v_artifact_reason IS NOT NULL THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'manual_review' ELSE state END,
           manual_review_reason = CASE WHEN state = 'protected' THEN v_artifact_reason ELSE manual_review_reason END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;

  IF v_case.state <> 'protected' THEN
    RETURN NEW;
  END IF;
  IF v_case.captured_mode = 'protect' THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'released' ELSE state END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;
  IF v_case.captured_mode <> 'auto_align' THEN
    RETURN NEW;
  END IF;

  -- With a split shipment, delivery events can arrive in either chronology.
  -- Preserve the interval from the last parcel delivered, not necessarily from
  -- the final webhook processed by this transaction.
  IF NOT v_qualified_arrival THEN
    SELECT max(delivered_at) INTO v_latest_delivered_at
      FROM public.fulfillment_shipments
     WHERE order_id = v_case.predecessor_order_id;
  END IF;
  v_target := v_latest_delivered_at + make_interval(days => v_subscription.cadence_days);
  UPDATE public.subscriptions
     SET next_cycle_at = CASE
           WHEN next_cycle_at IS NULL THEN v_target
           ELSE GREATEST(next_cycle_at, v_target)
         END,
         updated_at = now()
   WHERE id = v_subscription.id
   RETURNING next_cycle_at INTO v_target;

  UPDATE public.subscription_delivery_alignment_cases
     SET state = CASE WHEN state = 'protected' THEN 'aligned' ELSE state END,
         aligned_next_cycle_at = CASE WHEN state = 'protected' THEN v_target ELSE aligned_next_cycle_at END,
         aligned_at = CASE WHEN state = 'protected' THEN now() ELSE aligned_at END,
         updated_at = now()
   WHERE predecessor_order_id = v_case.predecessor_order_id;
  RETURN NEW;
END;
$$;
