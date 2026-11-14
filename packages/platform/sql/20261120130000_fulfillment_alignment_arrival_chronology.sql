-- Arrival chronology and replacement preparation on the native parcel rail.
CREATE OR REPLACE FUNCTION public.subscription_delivery_alignment_on_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
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
  IF v_case.id IS NULL THEN
    RETURN NEW;
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
  SELECT max(delivered_at) INTO v_latest_delivered_at
    FROM public.fulfillment_shipments
   WHERE order_id = v_case.predecessor_order_id;
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

CREATE OR REPLACE FUNCTION public.fulfillment_read_replacement_preparation(p_shipment_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE id=p_shipment_id AND replaces_shipment_id IS NOT NULL) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('sequenceNo',(SELECT sequence_no FROM public.fulfillment_shipments WHERE id=p_shipment_id),'contact',public.fulfillment_resolve_parcel_contact(p_shipment_id),'lines',
  (SELECT jsonb_agg(jsonb_build_object('sku',sku,'title',title,'quantity',quantity,'lotRef',coalesce(nullif(product_snapshot->'lotRef','null'::jsonb),nullif(product_snapshot->'lotNumber','null'::jsonb),nullif(product_snapshot->'lotCode','null'::jsonb)),'expirationDate',coalesce(nullif(product_snapshot->'expirationDate','null'::jsonb),nullif(product_snapshot->'expiresAt','null'::jsonb))) ORDER BY id) FROM public.fulfillment_parcel_lines WHERE shipment_id=p_shipment_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_native_dispatch_refusal(p_shipment_id uuid,p_provider_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE parcel public.fulfillment_shipments; purchase public.commerce_orders; contact jsonb; resolution jsonb;
BEGIN
 SELECT * INTO parcel FROM public.fulfillment_shipments WHERE id=p_shipment_id;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=parcel.order_id;
 IF EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id AND external_ref IS NOT NULL) THEN
  RETURN 'provider_proof_requires_acknowledgement'; END IF;
 IF EXISTS(SELECT 1 FROM public.fulfillment_operator_attempts WHERE shipment_id=parcel.id AND provider_key=p_provider_key AND status='succeeded') THEN
  RETURN 'succeeded_provider_attempt_exists'; END IF;
 IF NOT public.fulfillment_parcel_reservations_covered(parcel.id) THEN RETURN 'dispatch_reservations_not_recorded'; END IF;
 IF NOT public.fulfillment_order_mode_proven(purchase.metadata#>>'{orderDraftSnapshot,context,mode}') THEN RETURN 'order_mode_unproven'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_contacts c WHERE c.shipment_id=parcel.id AND c.erased_at IS NULL AND jsonb_typeof(c.contact)='object')
  OR EXISTS(SELECT 1 FROM public.identity_privacy_erasures WHERE client_id=purchase.client_id) THEN RETURN 'not_dispatchable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=purchase.id AND status='settled') THEN RETURN 'payment_not_succeeded'; END IF;
 IF purchase.metadata#>>'{orderDraftSnapshot,context,mode}'='subscription_cycle'
  AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=purchase.subscription_cycle_id AND status='paid') THEN RETURN 'subscription_cycle_not_paid'; END IF;
 IF purchase.status NOT IN ('paid','fulfillment_pending') OR parcel.status NOT IN ('created','label_pending')
  OR NOT EXISTS(SELECT 1 FROM public.fulfillment_ports WHERE port_key=parcel.port_key AND routable)
  OR EXISTS(SELECT 1 FROM public.commerce_order_holds WHERE order_id=purchase.id AND status='active')
  OR EXISTS(SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=parcel.id AND status<>'draft') THEN RETURN 'not_dispatchable'; END IF;
 contact:=public.fulfillment_resolve_parcel_contact(parcel.id);
 resolution:=public.fulfillment_delivery_contact_resolve(jsonb_build_object('frozenContactPresent',true,'frozenContact',contact));
 IF NOT coalesce((resolution->>'carrierComplete')::boolean,false) OR
  coalesce(contact#>>'{selectedDelivery,providerKind}',contact#>>'{selectedDelivery,providerRef}') IS DISTINCT FROM p_provider_key THEN RETURN 'not_dispatchable'; END IF;
 RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_intake_find_dispatch(p_provider text,p_correlation jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ref public.fulfillment_dispatch_refs; matches integer; selected_id uuid; match_kind text;
BEGIN
 -- Provider identity has precedence. Merchant lookup uses recorded order/dispatch foreign keys only.
 SELECT count(*),(array_agg(d.id))[1] INTO matches,selected_id FROM public.fulfillment_dispatch_refs d
 WHERE d.evidence->>'providerRef'=p_provider AND d.mode<>'shadow' AND (
  (d.external_ref IS NOT NULL AND d.external_ref=p_correlation->>'externalRef') OR
  (d.parcel_ref IS NOT NULL AND d.parcel_ref=p_correlation->>'providerFulfillmentRef'));
 IF matches>1 THEN RAISE EXCEPTION 'fulfillment_observation_correlation_conflict' USING ERRCODE='23505'; END IF;
 IF matches=1 THEN
  SELECT * INTO ref FROM public.fulfillment_dispatch_refs WHERE id=selected_id;
  match_kind:='provider';
 ELSE
  -- Count every recorded association before choosing a parcel within the single admitted order.
  -- Keep numbered orders without a dispatch in the ambiguity check, as in order lookup.
  WITH candidates AS (
   SELECT o.id AS order_id,d.id,d.shipment_id,shipment.created_at
   FROM public.commerce_orders o LEFT JOIN public.fulfillment_dispatch_refs d
    ON d.order_id=o.id AND d.evidence->>'providerRef'=p_provider AND d.mode<>'shadow'
   LEFT JOIN public.fulfillment_shipments shipment ON shipment.id=d.shipment_id
   WHERE o.metadata->>'orderNumber'=p_correlation->>'orderNumber'
    OR o.id::text=p_correlation->>'merchantOrderRef'
    OR d.shipment_id::text=p_correlation->>'fulfillmentRef'
  )
  SELECT count(DISTINCT c.order_id),
   (array_agg(c.id ORDER BY (c.shipment_id::text=p_correlation->>'fulfillmentRef') DESC NULLS LAST,
    c.created_at DESC NULLS LAST,c.id DESC NULLS LAST))[1]
   INTO matches,selected_id FROM candidates c;
  IF matches>1 THEN RAISE EXCEPTION 'fulfillment_observation_correlation_conflict' USING ERRCODE='23505'; END IF;
  IF selected_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO ref FROM public.fulfillment_dispatch_refs WHERE id=selected_id;
  SELECT CASE WHEN ref.shipment_id::text=p_correlation->>'fulfillmentRef' THEN 'native'
   WHEN o.metadata->>'orderNumber'=p_correlation->>'orderNumber' THEN 'merchant' ELSE 'native' END
   INTO match_kind FROM public.commerce_orders o WHERE o.id=ref.order_id;
 END IF;
 IF (p_correlation->>'fulfillmentRef' IS NOT NULL AND p_correlation->>'fulfillmentRef' IS DISTINCT FROM ref.shipment_id::text)
  OR (p_correlation->>'orderRef' IS NOT NULL AND p_correlation->>'orderRef' IS DISTINCT FROM ref.order_id::text)
  OR (p_correlation->>'parcelRef' IS NOT NULL AND p_correlation->>'parcelRef' IS DISTINCT FROM ref.parcel_ref)
  OR (p_correlation->>'externalRef' IS NOT NULL AND ref.external_ref IS NOT NULL AND p_correlation->>'externalRef' IS DISTINCT FROM ref.external_ref)
  OR (p_correlation->>'providerFulfillmentRef' IS NOT NULL AND ref.parcel_ref IS NOT NULL AND p_correlation->>'providerFulfillmentRef' IS DISTINCT FROM ref.parcel_ref) THEN
  RAISE EXCEPTION 'fulfillment_observation_correlation_conflict' USING ERRCODE='23505'; END IF;
 RETURN public.fulfillment_dispatch_read(ref)||jsonb_build_object('acceptance',ref.acceptance,'matchedBy',match_kind,
  'parcelSequenceNo',(SELECT sequence_no FROM public.fulfillment_shipments WHERE id=ref.shipment_id),'orderNumber',(SELECT o.metadata->>'orderNumber' FROM public.commerce_orders o WHERE o.id=ref.order_id));
END;
$$;
