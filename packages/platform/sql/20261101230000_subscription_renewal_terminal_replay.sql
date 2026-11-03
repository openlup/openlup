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

CREATE FUNCTION public.fulfillment_reserve_subscription_renewal_gated(p_operation_id uuid, p_claim_token uuid, p_hold_seconds integer DEFAULT 900, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.inventory_admission_try_enter();
 RETURN public.fulfillment_reserve_subscription_renewal(p_operation_id,p_claim_token,p_hold_seconds,p_now);
END; $$;

CREATE FUNCTION public.fulfillment_release_subscription_renewal_gated(p_operation_id uuid, p_claim_token uuid, p_reason text, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.inventory_admission_try_enter();
 RETURN public.fulfillment_release_subscription_renewal(p_operation_id,p_claim_token,p_reason,p_now);
END; $$;

CREATE FUNCTION public.fulfillment_expire_subscription_renewals_gated(p_now timestamptz DEFAULT now(), p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.inventory_admission_try_enter();
 RETURN public.fulfillment_expire_subscription_renewals(p_now,p_limit);
END; $$;

CREATE FUNCTION public.subscription_stock_wait_admit_gated(p_input jsonb, p_due jsonb, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.inventory_admission_try_enter();
 RETURN public.subscription_stock_wait_admit(p_input,p_due,p_now);
END; $$;

CREATE FUNCTION public.subscription_stock_wait_recover_refusal_gated(p_operation_id uuid, p_fingerprint text, p_worker text, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.inventory_admission_try_enter();
 RETURN public.subscription_stock_wait_recover_refusal(p_operation_id,p_fingerprint,p_worker,p_now);
END; $$;

CREATE FUNCTION public.subscription_stock_wait_deficits_gated(p_snapshot jsonb, p_operation_id uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.inventory_admission_try_enter();
 RETURN public.subscription_stock_wait_deficits(p_snapshot,p_operation_id,p_now);
END; $$;

REVOKE ALL ON FUNCTION public.commerce_view_shipment_destination(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_reserve_subscription_renewal_gated(uuid,uuid,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_release_subscription_renewal_gated(uuid,uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_expire_subscription_renewals_gated(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_admit_gated(jsonb,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_recover_refusal_gated(uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_stock_wait_deficits_gated(jsonb,uuid,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_view_shipment_destination(uuid), public.fulfillment_reserve_subscription_renewal_gated(uuid,uuid,integer,timestamptz), public.fulfillment_release_subscription_renewal_gated(uuid,uuid,text,timestamptz), public.fulfillment_expire_subscription_renewals_gated(timestamptz,integer), public.subscription_stock_wait_admit_gated(jsonb,jsonb,timestamptz), public.subscription_stock_wait_recover_refusal_gated(uuid,text,text,timestamptz), public.subscription_stock_wait_deficits_gated(jsonb,uuid,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_view_shipment_destination(uuid), public.fulfillment_reserve_subscription_renewal_gated(uuid,uuid,integer,timestamptz), public.fulfillment_release_subscription_renewal_gated(uuid,uuid,text,timestamptz), public.fulfillment_expire_subscription_renewals_gated(timestamptz,integer), public.subscription_stock_wait_admit_gated(jsonb,jsonb,timestamptz), public.subscription_stock_wait_recover_refusal_gated(uuid,text,text,timestamptz), public.subscription_stock_wait_deficits_gated(jsonb,uuid,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_view_shipment_destination(uuid), public.fulfillment_reserve_subscription_renewal_gated(uuid,uuid,integer,timestamptz), public.fulfillment_release_subscription_renewal_gated(uuid,uuid,text,timestamptz), public.fulfillment_expire_subscription_renewals_gated(timestamptz,integer), public.subscription_stock_wait_admit_gated(jsonb,jsonb,timestamptz), public.subscription_stock_wait_recover_refusal_gated(uuid,text,text,timestamptz), public.subscription_stock_wait_deficits_gated(jsonb,uuid,timestamptz) TO service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz), public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz), public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz) FROM service_role'; END IF; END; $$;
