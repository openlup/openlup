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

-- Read the accepted version under the row lock shared with template edits.
-- Capture the whole historical cohort. Chargeability is evaluated at report time.
UPDATE public.subscription_renewal_operations o
   SET claimed_before_rnw_1 = true
  FROM (
  SELECT s.id, s.template_version
    FROM public.subscriptions s
   WHERE EXISTS (
     SELECT 1 FROM public.subscription_renewal_operations o
      WHERE o.subscription_id = s.id
        AND public.subscription_renewal_snapshot_is_billing(o.cycle_snapshot, false)
   )
   ORDER BY s.id
   FOR SHARE OF s
) s
 WHERE s.id = o.subscription_id
   AND (public.subscription_renewal_snapshot_is_stale(s.template_version, o.cycle_snapshot, NULL)
     OR (NOT (o.cycle_snapshot ?| ARRAY['frozenRevision', 'templateSnapshot'])
       AND public.subscription_renewal_snapshot_is_billing(o.cycle_snapshot, false)));

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
