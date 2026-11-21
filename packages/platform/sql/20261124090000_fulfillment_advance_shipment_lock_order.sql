-- Acquire the parent subscription lock before locking fulfillment_shipments so
-- fulfillment_advance_shipment follows the canonical delivery-alignment lock order
-- (subscriptions -> fulfillment_shipments -> subscription_delivery_alignment_cases)
-- and cannot deadlock (40P01) against concurrent renewal admission.
CREATE OR REPLACE FUNCTION public.fulfillment_advance_shipment(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_to_status text,
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
  v_archetype public.fulfillment_provider_archetypes%ROWTYPE;
  v_subscription_id uuid;
  v_legal boolean;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_shipment_id IS NULL OR p_to_status IS NULL
  THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'shipment_advanced'
      OR v_existing.shipment_id IS DISTINCT FROM p_shipment_id
      OR v_existing.payload->>'toStatus' IS DISTINCT FROM p_to_status
    THEN
      RAISE EXCEPTION 'fulfillment_advance_shipment_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'advanced', true);
  END IF;

  SELECT cycle.subscription_id
    INTO v_subscription_id
    FROM public.fulfillment_shipments s
    JOIN public.commerce_orders o ON o.id = s.order_id
    JOIN public.subscription_cycles cycle ON cycle.id = o.subscription_cycle_id
   WHERE s.id = p_shipment_id;
  IF v_subscription_id IS NOT NULL THEN
    PERFORM id FROM public.subscriptions WHERE id = v_subscription_id FOR UPDATE;
  END IF;

  SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_archetype FROM public.fulfillment_provider_archetypes
   WHERE provider_type = v_shipment.provider_type;

  v_legal := (v_shipment.status, p_to_status) IN (
    ('created', 'packed'),
    ('packed', 'label_pending'),
    ('label_pending', 'label_created'),
    ('label_created', 'handed_over'),
    ('packed', 'handed_over'),
    ('handed_over', 'in_transit'),
    ('handed_over', 'delivered'),
    ('in_transit', 'delivered'));
  IF NOT v_legal THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_invalid_transition' USING ERRCODE = '22023';
  END IF;

  -- Two refusals, not one, because they are different facts and a caller has to tell them apart: a
  -- house was asked for a label it never makes, and a carrier was asked to hand over a parcel it has
  -- not labelled yet.
  IF p_to_status IN ('label_pending', 'label_created') AND NOT v_archetype.owns_label_creation THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_archetype_forbids_label' USING ERRCODE = '22023';
  END IF;
  IF v_shipment.status = 'packed' AND p_to_status = 'handed_over'
    AND v_archetype.owns_label_creation
  THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_archetype_forbids_handover' USING ERRCODE = '22023';
  END IF;

  UPDATE public.fulfillment_shipments
     SET status = p_to_status,
         updated_at = p_requested_at,
         packed_at = CASE WHEN p_to_status = 'packed' THEN p_requested_at ELSE packed_at END,
         handed_over_at = CASE WHEN p_to_status = 'handed_over' THEN p_requested_at
                               ELSE handed_over_at END,
         delivered_at = CASE WHEN p_to_status = 'delivered' THEN p_requested_at
                             ELSE delivered_at END,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE id = p_shipment_id
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_shipment_id, v_shipment.order_id, 'shipment_advanced', p_idempotency_key,
          jsonb_build_object('toStatus', p_to_status), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, 'advanced', false);
END;
$$;
