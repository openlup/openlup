-- Callers verify the owned document at its issued scope before classifying.
CREATE OR REPLACE FUNCTION public.classify_order_destination(
  p_order_id uuid, p_document public.commerce_destination_v2_documents, p_use text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_order public.commerce_orders;
  v_bound public.commerce_destination_v2_order_bindings;
  v_issuer text := CASE WHEN p_document.purpose = 'checkout' THEN 'checkout' ELSE 'subscription' END;
  v_unavailable constant jsonb := public.commerce_destination_v2_refusal('subscription_unavailable', 'subscriptionId');
  v_invalid constant jsonb := public.commerce_destination_v2_refusal('stored_binding', 'orderBindings');
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id AND client_id = p_document.client_id;
  IF NOT FOUND OR p_document.evidence_disposition IS DISTINCT FROM 'available'
    OR p_use IS NULL OR p_use NOT IN ('prepare', 'retained', 'acquisition') THEN RETURN v_invalid; END IF;
  SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings WHERE order_id = p_order_id;
  IF p_use <> 'prepare' AND v_order.renewal_operation_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id AND renewal_operation_id IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM public.subscription_cycle_preparations WHERE order_id = p_order_id OR cycle_id = v_order.subscription_cycle_id
  ) THEN
    -- A historical cycle can lack an activation, but live lineage must agree with the order and cycle.
    IF EXISTS (
      SELECT 1 FROM public.subscription_cycles c JOIN public.subscriptions s ON s.id = c.subscription_id
      JOIN public.subscription_activations a ON (a.order_id = v_order.id OR a.subscription_id = s.id) AND a.state = 'active'
      WHERE c.id = v_order.subscription_cycle_id
        AND (a.order_id, a.subscription_id, a.client_id, s.client_id) IS DISTINCT FROM
          (v_order.id, s.id, v_order.client_id, v_order.client_id)
    ) THEN RETURN CASE WHEN p_use = 'acquisition' THEN v_unavailable ELSE v_invalid END; END IF;
    IF p_use = 'acquisition' AND (v_issuer <> 'checkout' OR (v_order.subscription_cycle_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.subscription_cycles c JOIN public.subscription_activations a ON a.subscription_id = c.subscription_id
      WHERE c.id = v_order.subscription_cycle_id AND a.order_id = v_order.id AND a.client_id = v_order.client_id AND a.state = 'active'
    ))) THEN RETURN v_unavailable; END IF;
    IF v_issuer <> 'checkout' OR v_bound.snapshot_ref IS DISTINCT FROM p_document.snapshot_ref OR
      NOT public.commerce_destination_v2_valid_pins(v_bound.selection, v_bound.service, p_document.scope_ref) THEN RETURN v_invalid; END IF;
    RETURN jsonb_build_object('document_issuer', v_issuer, 'binding_origin', 'checkout');
  END IF;
  IF p_use = 'acquisition' THEN RETURN v_unavailable; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.subscription_cycle_preparations p
    JOIN public.subscription_cycles c ON c.id = p.cycle_id
    JOIN public.subscription_cycle_occurrences x ON x.cycle_key = p.cycle_key
      AND x.subscription_id = c.subscription_id AND x.client_id = v_order.client_id AND x.rail = 'v3'
    JOIN public.subscriptions s ON s.id = x.subscription_id AND s.client_id = x.client_id
    JOIN public.subscription_renewal_operations op ON op.id = p.operation_id AND op.subscription_id = x.subscription_id
    JOIN public.subscription_cycle_tax_bindings b ON (b.binding_ref, b.cycle_key, b.operation_id, b.commercial_generation_id, b.binding_seq) =
      (p.binding_ref, p.cycle_key, p.operation_id, p.commercial_generation_id, p.binding_seq)
    WHERE p.order_id = p_order_id AND c.id = v_order.subscription_cycle_id
      AND (c.renewal_operation_id IS NULL OR c.renewal_operation_id = op.id)
      AND (v_order.renewal_operation_id IS NULL OR v_order.renewal_operation_id = op.id)
      AND (v_issuer = 'checkout' OR p_document.scope_ref = x.subscription_id)
      AND b.accepted_money_digest = p.accepted_money_digest AND b.erased_at IS NULL
      AND p_document.binding = b.live_evidence->'binding'
      AND public.commerce_destination_v2_is_uuid(b.live_evidence->'selectionRevision')
      AND public.subscription_destination_v2_service_valid(b.live_evidence->'service')
      AND (p_use = 'prepare' OR (v_bound.snapshot_ref = p_document.snapshot_ref AND v_bound.selection =
        jsonb_build_object('kind', 'subscription', 'scopeRef', x.subscription_id, 'selectionRevision', b.live_evidence->'selectionRevision')
        AND v_bound.service = b.live_evidence->'service'))
  ) THEN RETURN v_invalid; END IF;
  RETURN jsonb_build_object('document_issuer', v_issuer, 'binding_origin', 'renewal');
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_check_retained(p_ctx jsonb, p_bound public.commerce_destination_v2_order_bindings, p_field text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents;
  v_result jsonb;
  v_classification jsonb;
BEGIN
  IF p_bound.selection IS NULL AND p_bound.service IS NULL THEN
    RETURN public.commerce_destination_v2_refusal('unavailable', p_field);
  END IF;
  SELECT scope_ref INTO v_row.scope_ref FROM public.commerce_destination_v2_documents WHERE snapshot_ref = p_bound.snapshot_ref;
  IF p_ctx->'scopeRef' IS DISTINCT FROM to_jsonb(v_row.scope_ref) AND NOT EXISTS (
    SELECT 1 FROM public.subscription_cycle_preparations p
    JOIN public.commerce_orders o ON o.id = p.order_id AND o.subscription_cycle_id = p.cycle_id
    JOIN public.subscription_cycles c ON c.id = p.cycle_id
    JOIN public.subscription_cycle_occurrences x ON x.cycle_key = p.cycle_key
      AND x.subscription_id = c.subscription_id AND x.client_id = o.client_id AND x.rail = 'v3'
    JOIN public.subscriptions s ON s.id = x.subscription_id AND s.client_id = x.client_id
    WHERE p.order_id = p_bound.order_id AND to_jsonb(x.subscription_id) = p_ctx->'scopeRef'
      AND to_jsonb(o.client_id) = p_ctx->'clientId'
  ) THEN RETURN public.commerce_destination_v2_refusal('unavailable', p_field); END IF;
  v_row := public.commerce_destination_v2_owned_document(
    p_ctx || jsonb_build_object('scopeRef', v_row.scope_ref), p_bound.snapshot_ref);
  v_result := public.commerce_destination_v2_check_document(v_row, p_field);
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  IF v_result->>'verified' IS DISTINCT FROM 'true' THEN
    RETURN public.commerce_destination_v2_refusal('stored_binding', 'orderBindings');
  END IF;
  v_classification := public.classify_order_destination(p_bound.order_id, v_row, 'retained');
  IF v_classification ? 'outcome' THEN RETURN v_classification; END IF;
  RETURN jsonb_build_object('binding', v_row.binding, 'document', v_result->'document', 'documentDigest', v_row.document_digest,
    'evidenceExpiresAt', CASE WHEN v_classification->>'document_issuer' = 'checkout' THEN
      to_char(v_row.evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_destination_v2_current(p_ctx jsonb, p_id uuid, p_origins public.subscription_activations[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_client uuid := (p_ctx->>'clientId')::uuid;
  v_side public.subscription_destination_v2_selections;
  v_doc public.commerce_destination_v2_documents;
  v_bound public.commerce_destination_v2_order_bindings;
  v_result jsonb;
  v_unavailable constant jsonb := public.commerce_destination_v2_refusal('subscription_unavailable', 'subscriptionId');
BEGIN
  SELECT * INTO v_side FROM public.subscription_destination_v2_selections WHERE subscription_id = p_id;
  IF FOUND THEN
    IF v_side.selection_revision IS NULL THEN
      RETURN public.commerce_destination_v2_refusal('unavailable', 'subscriptionId');
    END IF;
    v_doc := public.commerce_destination_v2_owned_document(p_ctx, v_side.snapshot_ref);
    v_result := public.commerce_destination_v2_check_document(v_doc, 'subscriptionId');
    IF v_result ? 'outcome' THEN RETURN v_result; END IF;
    IF v_doc.purpose IS NOT NULL OR v_doc.evidence_disposition <> 'available'
      OR NOT public.subscription_destination_v2_service_valid(v_side.service) THEN
      RETURN public.commerce_destination_v2_refusal('stored_binding', 'destination');
    END IF;
    RETURN jsonb_build_object('binding', v_doc.binding, 'selectionRevision', v_side.selection_revision, 'service', v_side.service);
  END IF;
  IF cardinality(p_origins) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(p_origins) <> 1 THEN
    RETURN v_unavailable;
  END IF;
  IF (p_origins[1]).client_id IS DISTINCT FROM v_client OR NOT EXISTS (
    SELECT 1 FROM public.commerce_orders WHERE id = (p_origins[1]).order_id AND client_id = v_client
  ) THEN
    RETURN v_unavailable;
  END IF;
  SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings WHERE order_id = (p_origins[1]).order_id;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  SELECT d.scope_ref INTO v_doc.scope_ref FROM public.commerce_destination_v2_documents d WHERE d.snapshot_ref = v_bound.snapshot_ref;
  v_doc := public.commerce_destination_v2_owned_document(p_ctx || jsonb_build_object('scopeRef', v_doc.scope_ref), v_bound.snapshot_ref);
  v_result := public.commerce_destination_v2_check_document(v_doc, 'subscriptionId');
  IF v_result->>'verified' IS DISTINCT FROM 'true' OR v_doc.purpose IS DISTINCT FROM 'checkout' THEN RETURN v_unavailable; END IF;
  IF public.classify_order_destination(v_bound.order_id, v_doc, 'acquisition')->>'binding_origin' IS DISTINCT FROM 'checkout'
    THEN RETURN v_unavailable; END IF;
  RETURN jsonb_build_object('binding', v_doc.binding, 'selectionRevision', v_bound.selection->'selectionRevision', 'service', v_bound.service);
EXCEPTION WHEN numeric_value_out_of_range THEN
  IF v_side.subscription_id IS NULL THEN RETURN v_unavailable; END IF;
  RETURN public.commerce_destination_v2_refusal('stored_binding', 'destination');
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_destination_v2_current(p_ctx jsonb, p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  -- This stable lookup uses one snapshot. Mutable callers guard and recensus the origin first.
  SELECT public.subscription_destination_v2_current(p_ctx, p_id, public.subscription_destination_v2_origins(p_id));
$$;

CREATE OR REPLACE FUNCTION public.subscription_destination_v2_read(p_ctx jsonb, p_id uuid, p_binding jsonb,
  p_revision uuid, p_service jsonb, p_recheck boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_client uuid;
  v_origins public.subscription_activations[] := ARRAY[]::public.subscription_activations[];
  v_origin public.subscription_activations;
  v_bound public.commerce_destination_v2_order_bindings;
  v_snapshot uuid;
  v_inherited boolean;
  v_prior_acquisition boolean := false;
  v_doc public.commerce_destination_v2_documents;
  v_current jsonb;
  v_document jsonb;
  v_checked jsonb;
  v_address jsonb;
  v_expected uuid;
  v_selection jsonb;
  v_field text;
  v_unavailable constant jsonb := public.commerce_destination_v2_refusal('subscription_unavailable', 'subscriptionId');
  v_absent constant jsonb := public.commerce_destination_v2_refusal('subscription_selection', 'subscriptionId');
BEGIN
  IF p_id IS NULL THEN RETURN public.commerce_destination_v2_refusal('input', 'subscriptionId'); END IF;
  IF NOT public.commerce_destination_v2_valid_context(p_ctx, p_id) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN public.commerce_destination_v2_issuance_refusal('isolation');
  END IF;

  v_client := (p_ctx->>'clientId')::uuid;
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  PERFORM 1 FROM public.subscriptions WHERE id = p_id AND client_id = v_client FOR SHARE;
  IF NOT FOUND THEN RETURN v_unavailable; END IF;
  IF EXISTS (SELECT 1 FROM public.identity_privacy_erasures WHERE client_id = v_client) THEN RETURN v_unavailable; END IF;
  PERFORM 1 FROM public.clients WHERE id = v_client AND principal_id = (p_ctx#>>'{owner,principalRef}')::uuid
    AND NOT metadata ? 'absorption' FOR SHARE;
  IF NOT FOUND THEN RETURN public.commerce_destination_v2_refusal('owner', 'owner'); END IF;

  SELECT snapshot_ref INTO v_snapshot FROM public.subscription_destination_v2_selections
    WHERE subscription_id = p_id FOR SHARE;
  v_inherited := NOT FOUND;
  IF v_inherited THEN
    v_origins := public.subscription_destination_v2_origins(p_id);
    IF cardinality(v_origins) = 0 THEN RETURN v_absent; END IF;
    IF cardinality(v_origins) <> 1 OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN RETURN v_unavailable; END IF;
    v_origin := v_origins[1];
    -- Renewal registration also guards the order before the activation.
    PERFORM 1 FROM public.commerce_orders WHERE id = v_origin.order_id AND client_id = v_client FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    PERFORM 1 FROM public.subscription_activations WHERE id = v_origin.id AND order_id = v_origin.order_id
      AND subscription_id = p_id AND client_id = v_client AND state = 'active' FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    v_origins := public.subscription_destination_v2_origins(p_id);
    IF cardinality(v_origins) <> 1 OR (v_origins[1]).id <> v_origin.id THEN RETURN v_unavailable; END IF;
    SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings
      WHERE order_id = v_origin.order_id FOR SHARE;
    IF NOT FOUND THEN
      v_origins := public.subscription_destination_v2_origins(p_id);
      IF cardinality(v_origins) <> 1 OR (v_origins[1]).id IS DISTINCT FROM v_origin.id
        OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN RETURN v_unavailable; END IF;
      RETURN v_absent;
    END IF;
    IF v_bound.selection IS NULL AND v_bound.service IS NULL THEN RETURN v_unavailable; END IF;
    v_snapshot := v_bound.snapshot_ref;
  END IF;

  -- The retained verifier compares binding pins with the document's issued scope.
  SELECT * INTO v_doc FROM public.commerce_destination_v2_documents
    WHERE snapshot_ref = v_snapshot AND client_id = v_client AND owner_scope = p_ctx->'owner'
      AND evidence_disposition = 'available'
      AND CASE WHEN v_inherited THEN purpose = 'checkout' ELSE scope_ref = p_id AND purpose IS NULL END FOR SHARE;
  IF NOT FOUND THEN RETURN v_unavailable; END IF;
  IF v_inherited THEN
    -- A new activation can commit while the reader waits without changing the locked origin.
    v_origins := public.subscription_destination_v2_origins(p_id);
    IF cardinality(v_origins) <> 1 OR (v_origins[1]).id IS DISTINCT FROM v_origin.id
      OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN RETURN v_unavailable; END IF;
  END IF;
  v_current := public.subscription_destination_v2_current(p_ctx, p_id, v_origins);
  IF v_current ? 'outcome' OR v_current = '{}'::jsonb THEN RETURN v_unavailable; END IF;

  IF NOT p_recheck AND p_binding IS NULL THEN
    v_expected := v_snapshot;
  ELSE
    IF NOT public.commerce_destination_v2_valid_binding(p_binding) THEN
      RETURN public.commerce_destination_v2_refusal('binding', 'destination');
    END IF;
    v_expected := (p_binding->>'snapshotRef')::uuid;
  END IF;
  LOOP
    BEGIN
      v_checked := public.commerce_destination_v2_check_document(v_doc, 'subscriptionId');
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RETURN v_unavailable;
    END;
    IF v_checked->>'verified' IS DISTINCT FROM 'true' THEN RETURN v_unavailable; END IF;
    IF v_prior_acquisition AND public.classify_order_destination(v_bound.order_id, v_doc, 'acquisition')->>'binding_origin'
      IS DISTINCT FROM 'checkout' THEN RETURN v_unavailable; END IF;
    v_document := v_checked->'document';
    v_address := v_document->'address';
    -- Verify the stored projection as well as its two digests before disclosing coordinates.
    IF jsonb_typeof(v_address) IS DISTINCT FROM 'object' THEN RETURN v_unavailable; END IF;
    IF v_address - ARRAY['line1','line2','city','subdivision','postalCode','country'] <> '{}'::jsonb
      OR public.commerce_destination_v2_validate_projection(jsonb_build_object(
        'policyRef', v_document->'policyRef', 'policyRevision', v_document->'policyRevision',
        'classificationKeys', v_document->'classificationKeys', 'contact', v_document->'contact',
        'address', (v_address - ARRAY['country','subdivision']) || jsonb_build_object('countryCode', v_address->'country')
          || CASE WHEN v_address ? 'subdivision' THEN jsonb_build_object('subdivisionCode', v_address->'subdivision') ELSE '{}'::jsonb END
      )) IS NOT NULL THEN RETURN v_unavailable; END IF;
    EXIT WHEN v_doc.snapshot_ref = v_expected;

    -- A superseded direct document must still belong to this subscription.
    SELECT * INTO v_doc FROM public.commerce_destination_v2_documents
      WHERE snapshot_ref = v_expected AND client_id = v_client AND owner_scope = p_ctx->'owner'
        AND scope_ref = p_id AND purpose IS NULL AND evidence_disposition = 'available' FOR SHARE;
    IF FOUND THEN
      IF v_inherited THEN
        v_origins := public.subscription_destination_v2_origins(p_id);
        IF cardinality(v_origins) <> 1 OR (v_origins[1]).id IS DISTINCT FROM v_origin.id
          OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN RETURN v_unavailable; END IF;
      END IF;
      CONTINUE;
    END IF;
    IF v_inherited THEN RETURN v_unavailable; END IF;

    -- A direct pointer can supersede inherited evidence. Guard the prior order lineage before its document.
    v_origins := public.subscription_destination_v2_origins(p_id);
    IF cardinality(v_origins) <> 1 OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN RETURN v_unavailable; END IF;
    v_origin := v_origins[1];
    PERFORM 1 FROM public.commerce_orders WHERE id = v_origin.order_id AND client_id = v_client FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    PERFORM 1 FROM public.subscription_activations WHERE id = v_origin.id AND order_id = v_origin.order_id
      AND subscription_id = p_id AND client_id = v_client AND state = 'active' FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings
      WHERE order_id = v_origin.order_id AND snapshot_ref = v_expected FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    SELECT * INTO v_doc FROM public.commerce_destination_v2_documents
      WHERE snapshot_ref = v_expected AND client_id = v_client AND owner_scope = p_ctx->'owner'
        AND purpose = 'checkout' AND evidence_disposition = 'available' FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    v_origins := public.subscription_destination_v2_origins(p_id);
    IF cardinality(v_origins) <> 1 OR (v_origins[1]).id IS DISTINCT FROM v_origin.id
      OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN
      RETURN v_unavailable;
    END IF;
    v_prior_acquisition := true;
  END LOOP;

  IF NOT p_recheck AND p_binding IS NULL THEN RETURN v_current; END IF;
  IF p_binding->'destinationDigest' IS DISTINCT FROM v_doc.binding->'destinationDigest' THEN
    RETURN public.commerce_destination_v2_refusal('digest', 'destinationDigest');
  END IF;
  IF p_recheck AND (p_revision IS NULL OR NOT public.subscription_destination_v2_service_valid(p_service)) THEN
    RETURN public.commerce_destination_v2_refusal('binding', CASE WHEN p_revision IS NULL THEN 'destination' ELSE 'selectedDelivery' END);
  END IF;
  v_field := CASE
    WHEN v_expected <> v_snapshot THEN 'destination.snapshotRef'
    WHEN p_binding->'policyRevision' IS DISTINCT FROM v_doc.binding->'policyRevision' THEN 'destination.policyRevision'
    WHEN p_recheck AND to_jsonb(p_revision) IS DISTINCT FROM v_current->'selectionRevision' THEN 'selectionRevision'
    WHEN p_recheck AND p_service IS DISTINCT FROM v_current->'service' THEN 'selectedDelivery'
  END;
  IF v_field IS NOT NULL THEN RETURN public.commerce_destination_v2_refusal('subscription_stale', v_field); END IF;
  v_selection := jsonb_build_object('kind', 'subscription', 'scopeRef', p_id, 'selectionRevision', v_current->'selectionRevision');
  v_current := (v_current - 'selectionRevision') || jsonb_build_object('selection', v_selection);
  IF p_recheck THEN RETURN v_current; END IF;
  RETURN v_current || jsonb_build_object('document', v_document, 'documentDigest', v_doc.document_digest, 'evidenceExpiresAt', NULL);
END;
$$;

-- The edit owns the subscription, client and selection guards before taking evidence locks.
CREATE FUNCTION public.subscription_destination_v2_current_for_edit(p_ctx jsonb, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_client uuid := (p_ctx->>'clientId')::uuid;
  v_origins public.subscription_activations[];
  v_origin public.subscription_activations;
  v_snapshot uuid;
  v_bound boolean;
  v_unavailable constant jsonb := public.commerce_destination_v2_refusal('subscription_unavailable', 'subscriptionId');
BEGIN
  SELECT snapshot_ref INTO v_snapshot FROM public.subscription_destination_v2_selections WHERE subscription_id = p_id;
  IF FOUND THEN
    PERFORM 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = v_snapshot FOR SHARE;
    RETURN public.subscription_destination_v2_current(p_ctx, p_id, ARRAY[]::public.subscription_activations[]);
  END IF;
  v_origins := public.subscription_destination_v2_origins(p_id);
  IF cardinality(v_origins) = 0 THEN RETURN '{}'::jsonb; END IF;
  IF cardinality(v_origins) <> 1 OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN RETURN v_unavailable; END IF;
  v_origin := v_origins[1];
  -- Order-first operations can already own the origin while waiting on the edit's parent guards.
  BEGIN
    PERFORM 1 FROM public.commerce_orders WHERE id = v_origin.order_id AND client_id = v_client FOR SHARE NOWAIT;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    PERFORM 1 FROM public.subscription_activations WHERE id = v_origin.id AND order_id = v_origin.order_id
      AND subscription_id = p_id AND client_id = v_client AND state = 'active' FOR SHARE NOWAIT;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
    SELECT snapshot_ref INTO v_snapshot FROM public.commerce_destination_v2_order_bindings
      WHERE order_id = v_origin.order_id FOR SHARE NOWAIT;
    v_bound := FOUND;
    IF v_bound THEN
      PERFORM 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = v_snapshot
        AND client_id = v_client AND owner_scope = p_ctx->'owner' FOR SHARE NOWAIT;
      IF NOT FOUND THEN RETURN v_unavailable; END IF;
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RETURN public.commerce_destination_v2_refusal('busy', 'subscriptionId') ||
      '{"observed":"The acquisition evidence is locked.","cause":"Editing requires immediate shared locks on acquisition evidence."}'::jsonb;
  END;
  -- Recensus once all available guards are held, including when the binding was absent.
  v_origins := public.subscription_destination_v2_origins(p_id);
  IF cardinality(v_origins) <> 1 OR (v_origins[1]).id IS DISTINCT FROM v_origin.id THEN RETURN v_unavailable; END IF;
  IF NOT v_bound THEN RETURN '{}'::jsonb; END IF;
  RETURN public.subscription_destination_v2_current(p_ctx, p_id, v_origins);
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_destination_v2_current_for_edit(jsonb,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_destination_v2_current_for_edit(jsonb,uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_destination_v2_current_for_edit(jsonb,uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_destination_v2_current_for_edit(jsonb,uuid) FROM service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.subscription_change_shipping_destination_v2(p_ctx jsonb, p_command jsonb, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_dialect constant text := 'subscription.destination.change.v2';
  v_original jsonb := p_command->'original';
  v_validated jsonb := p_command->'validated';
  v_service jsonb := p_command->'service';
  v_owner jsonb := p_ctx->'owner';
  v_address jsonb;
  v_snapshot uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_issued timestamptz;
  v_binding jsonb;
  v_document text;
  v_digest text;
  v_key text := p_command->>'requestKey';
  v_scoped_key jsonb;
  v_client uuid;
  v_id uuid;
  v_subscription public.subscriptions;
  v_subject public.clients;
  v_result jsonb;
  v_field text;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR
    p_command - ARRAY['dialect','subscriptionId','expectedTemplateVersion','expectedSelectionRevision',
      'requestKey','requestDigest','original','validated','service'] <> '{}'::jsonb THEN
    RETURN public.commerce_destination_v2_refusal('input', 'command');
  END IF;
  IF p_command->'dialect' IS DISTINCT FROM to_jsonb(v_dialect) THEN
    RETURN public.commerce_destination_v2_refusal('kind', 'version');
  END IF;
  v_field := CASE
    WHEN NOT coalesce(isfinite(p_now), false) THEN 'now'
    WHEN NOT public.commerce_destination_v2_is_uuid(p_command->'subscriptionId') THEN 'subscriptionId'
    WHEN jsonb_typeof(p_command->'expectedTemplateVersion') IS DISTINCT FROM 'number'
      OR NOT pg_input_is_valid(p_command->>'expectedTemplateVersion', 'integer') OR
      p_command->>'expectedTemplateVersion' COLLATE "C" !~ '^[1-9][0-9]*$' THEN 'expectedTemplateVersion'
    WHEN NOT p_command ? 'expectedSelectionRevision' THEN 'expectedSelectionRevision'
    WHEN NOT public.commerce_destination_v2_is_uuid(p_command->'requestKey') THEN 'requestKey'
    WHEN jsonb_typeof(p_command->'requestDigest') IS DISTINCT FROM 'string' THEN 'requestDigest'
    WHEN jsonb_typeof(v_original) IS DISTINCT FROM 'object' OR octet_length(v_original::text) > 16384
      OR v_original - ARRAY['address','contact'] <> '{}'::jsonb THEN 'original'
    WHEN jsonb_typeof(v_original->'address') IS DISTINCT FROM 'object' THEN 'original.address'
    WHEN jsonb_typeof(v_original->'contact') IS DISTINCT FROM 'object' THEN 'original.contact'
  END;
  IF v_field IS NOT NULL THEN RETURN public.commerce_destination_v2_refusal('input', v_field); END IF;
  SELECT 'original.' || part || coalesce('.' || bad, '') INTO v_field
  FROM (VALUES ('address', v_original->'address', ARRAY['line1','line2','city','postalCode','countryCode','subdivisionCode'],
    ARRAY['line1','city','postalCode','countryCode']), ('contact', v_original->'contact',
    ARRAY['recipientName','contactEmail','contactPhone','companyName','label','taxId','deliveryNotes','courierInstructions'], ARRAY[]::text[]))
    AS sections(part, body, allowed, required)
  CROSS JOIN LATERAL (
    SELECT NULL AS bad WHERE body - allowed <> '{}'::jsonb
    UNION ALL SELECT key FROM unnest(required) AS key WHERE NOT body ? key
    UNION ALL SELECT key FROM jsonb_each(body) WHERE key = ANY(allowed) AND
      (jsonb_typeof(value) <> 'string' OR (value #>> '{}') COLLATE "C" ~ U&'[\0001-\001F\007F-\009F]')
  ) AS invalid
  ORDER BY part COLLATE "C", bad COLLATE "C" NULLS FIRST LIMIT 1;
  IF v_field IS NOT NULL THEN RETURN public.commerce_destination_v2_refusal('input', v_field); END IF;
  v_id := (p_command->>'subscriptionId')::uuid;
  IF NOT public.commerce_destination_v2_valid_context(p_ctx, v_id) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  v_client := (p_ctx->>'clientId')::uuid;
  v_scoped_key := public.commerce_destination_v2_receipt_scoped_key_decision(p_ctx - 'scopeRef', v_dialect, v_key, p_command->>'requestDigest');
  IF v_scoped_key ? 'outcome' THEN RETURN v_scoped_key; END IF;
  v_digest := encode(sha256(convert_to(public.commerce_destination_v2_canonical(jsonb_build_array(
    'commerce.destination.request.v2', p_command - ARRAY['validated','service','requestDigest'] || jsonb_build_object('owner', v_owner)
  )), 'UTF8')), 'hex');
  IF p_command->>'requestDigest' COLLATE "C" IS DISTINCT FROM v_digest THEN
    RETURN public.commerce_destination_v2_issuance_refusal('request_digest');
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN public.commerce_destination_v2_issuance_refusal('isolation');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce.destination.receipt.v2:' || (v_scoped_key #>> '{}'), 0));
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  v_receipt := public.commerce_destination_v2_receipt_read_decision(p_ctx - 'scopeRef', v_dialect, v_key, v_digest);
  IF v_receipt->>'outcome' = 'refused' THEN RETURN v_receipt; END IF;
  IF v_receipt->>'kind' = 'receipt' AND v_receipt->>'evidenceDisposition' = 'erased' THEN
    RETURN '{"evidenceDisposition":"erased"}'::jsonb;
  END IF;
  IF v_receipt->>'kind' = 'absent' THEN
    SELECT * INTO v_subscription FROM public.subscriptions WHERE id = v_id AND client_id = v_client FOR UPDATE;
    IF NOT FOUND THEN RETURN public.commerce_destination_v2_refusal('owner', 'owner'); END IF;
    BEGIN
      SELECT * INTO v_subject FROM public.clients WHERE id = v_client FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RETURN public.commerce_destination_v2_refusal('busy', 'owner') ||
        '{"observed":"The client lock is held.","cause":"Editing requires an immediate exclusive subject lock."}'::jsonb;
    END;
    IF v_subject.principal_id IS DISTINCT FROM (v_owner->>'principalRef')::uuid OR v_subject.metadata ? 'absorption' THEN
      RETURN public.commerce_destination_v2_refusal('owner', 'owner');
    END IF;
    IF EXISTS (SELECT 1 FROM public.identity_privacy_erasures WHERE client_id = v_client) THEN
      RETURN public.commerce_destination_v2_issuance_refusal('erased');
    END IF;
    PERFORM 1 FROM public.subscription_destination_v2_selections WHERE subscription_id = v_id FOR UPDATE;
    v_result := public.subscription_destination_v2_current_for_edit(p_ctx, v_id);
    IF v_result ? 'outcome' THEN RETURN v_result; END IF;
    IF p_command->'expectedSelectionRevision' IS DISTINCT FROM 'null'::jsonb AND
      NOT public.commerce_destination_v2_is_uuid(p_command->'expectedSelectionRevision') THEN
      RETURN public.commerce_destination_v2_refusal('input', 'expectedSelectionRevision');
    END IF;
    v_field := CASE WHEN v_subscription.template_version <> (p_command->>'expectedTemplateVersion')::integer THEN 'expectedTemplateVersion'
      WHEN coalesce(v_result->'selectionRevision', 'null'::jsonb) IS DISTINCT FROM p_command->'expectedSelectionRevision' THEN 'expectedSelectionRevision' END;
    IF v_field IS NOT NULL THEN RETURN public.commerce_destination_v2_refusal('stale', v_field); END IF;
    IF v_subscription.status NOT IN ('active','paused') THEN
      RETURN public.subscription_destination_v2_refusal('ineligible', 'subscriptionId');
    END IF;
    BEGIN
      IF EXISTS (SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id = v_id
        AND scheduled_at = v_subscription.next_cycle_at AND state IN ('claimed','reserved','attempt_prepared')) THEN
        RETURN public.subscription_destination_v2_refusal('payment', 'subscriptionId');
      END IF;
      PERFORM public.subscription_lifecycle_assert_unlocked_cycle(v_id, v_subscription.next_cycle_at);
    EXCEPTION WHEN invalid_parameter_value THEN
      IF SQLERRM <> 'subscription_lifecycle_payment_blocked' THEN RAISE; END IF;
      RETURN public.subscription_destination_v2_refusal('payment', 'subscriptionId');
    END;
    v_result := public.commerce_destination_v2_validate_projection(v_validated);
    IF v_result IS NOT NULL THEN RETURN v_result; END IF;
    IF NOT v_validated->'contact' ? 'recipientName' THEN RETURN public.commerce_destination_v2_refusal('input', 'recipientName'); END IF;
    IF NOT v_validated->'contact' ? 'contactPhone' THEN RETURN public.commerce_destination_v2_refusal('input', 'contactPhone'); END IF;
    IF NOT public.subscription_destination_v2_service_valid(v_service) THEN RETURN public.commerce_destination_v2_refusal('input', 'service'); END IF;

    v_address := ((v_validated->'address') - ARRAY['countryCode','subdivisionCode']) ||
      jsonb_strip_nulls(jsonb_build_object('country', v_validated#>'{address,countryCode}', 'subdivision', v_validated#>'{address,subdivisionCode}'));
    v_binding := jsonb_build_object('snapshotRef', v_snapshot, 'schemaVersion', 2, 'policyRevision', v_validated->'policyRevision',
      'destinationDigest', encode(sha256(convert_to(public.commerce_destination_v2_canonical(
        jsonb_build_array('commerce.destination.v2', v_address)), 'UTF8')), 'hex'));
    v_document := public.commerce_destination_v2_canonical(jsonb_build_array('commerce.destination.document.v2',
      v_binding || jsonb_build_object('revision', 1, 'owner', v_owner, 'clientId', v_client, 'policyRef', v_validated->'policyRef',
        'classificationKeys', v_validated->'classificationKeys', 'address', v_address, 'contact', v_validated->'contact')));
    v_issued := date_trunc('milliseconds', clock_timestamp());
    BEGIN
      INSERT INTO public.commerce_destination_v2_documents
        (snapshot_ref,client_id,owner_scope,scope_ref,purpose,issued_at,evidence_expires_at,binding,document_text,document_digest,evidence_disposition)
      VALUES (v_snapshot,v_client,v_owner,v_id,NULL,v_issued,v_issued,v_binding,v_document,encode(sha256(convert_to(v_document,'UTF8')),'hex'),'available');
      INSERT INTO public.subscription_destination_v2_selections (subscription_id,snapshot_ref,selection_revision,service)
      VALUES (v_id,v_snapshot,v_revision,v_service) ON CONFLICT (subscription_id) DO UPDATE SET
        snapshot_ref = excluded.snapshot_ref, selection_revision = excluded.selection_revision, service = excluded.service;
      v_receipt := public.commerce_destination_v2_receipt_commit_decision(p_ctx - 'scopeRef', v_dialect, v_key, v_digest,
        jsonb_build_object('binding', v_binding, 'selection', jsonb_build_object('kind','subscription','scopeRef',v_id,'selectionRevision',v_revision),
          'evidenceExpiresAt', NULL));
      IF v_receipt->>'outcome' = 'refused' THEN RAISE SQLSTATE 'PZ001' USING MESSAGE = 'Roll back refused destination issuance'; END IF;
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN
      IF v_receipt->>'outcome' IS DISTINCT FROM 'refused' THEN RAISE; END IF;
      RETURN v_receipt;
    END;
    RETURN jsonb_build_object('outcome','applied_from_next_parcel','subscriptionId',v_id,'binding',v_binding,
      'selectionRevision',v_revision,'eventId',v_receipt->'eventId','replayed',false);
  END IF;
  RETURN jsonb_build_object('outcome','applied_from_next_parcel','subscriptionId',v_id,'binding',v_receipt#>'{outcome,binding}',
    'selectionRevision',v_receipt#>'{outcome,selection,selectionRevision}','eventId',v_receipt->'eventId','replayed',true);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_export(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN (WITH verified AS MATERIALIZED (
    SELECT d AS issued, snapshot_ref, client_id, issued_at, purpose, evidence_disposition, scope_ref, document_digest, evidence_expires_at,
      CASE WHEN evidence_disposition = 'available' THEN public.commerce_destination_v2_check_document(d, 'destination.snapshotRef') END AS result
    FROM public.commerce_destination_v2_documents AS d WHERE client_id = p_client_id
  )
  SELECT (SELECT coalesce(jsonb_agg(
    jsonb_build_object('snapshotRef', snapshot_ref, 'issuedAt',
      to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'evidenceDisposition', evidence_disposition)
    || CASE WHEN (result->>'verified')::boolean THEN
      jsonb_build_object('document', result->'document', 'scopeRef', scope_ref, 'documentDigest', document_digest,
        'evidenceExpiresAt', CASE WHEN purpose IS NOT NULL THEN
          to_char(evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
    WHEN result IS NOT NULL THEN
      jsonb_build_object('verification', jsonb_build_object('status', 'failed', 'code', result->'code', 'field', result->'field'))
    ELSE '{}'::jsonb END
    || CASE WHEN pins.valid IS NOT NULL THEN jsonb_build_object('orderBindings', pins.valid) ELSE '{}'::jsonb END
    || CASE WHEN selections.valid IS NOT NULL THEN jsonb_build_object('subscriptionSelections', selections.valid) ELSE '{}'::jsonb END
    || CASE WHEN selections.withheld AND (result IS NULL OR (result->>'verified')::boolean) THEN
      jsonb_build_object('verification', jsonb_build_object('status','failed','code','destination_binding_invalid','field','subscriptionSelections'))
      ELSE '{}'::jsonb END
    || CASE WHEN pins.withheld AND (result IS NULL OR (result->>'verified')::boolean) THEN
      jsonb_build_object('verification', jsonb_build_object('status', 'failed', 'code', 'destination_binding_invalid', 'field', 'orderBindings'))
      ELSE '{}'::jsonb END ORDER BY snapshot_ref), '[]'::jsonb)
    FROM verified v CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('orderId', b.order_id, 'selection', b.selection, 'service', b.service)
        ORDER BY b.order_id) FILTER (WHERE pin.valid) AS valid, bool_or(NOT pin.valid) AS withheld
      FROM public.commerce_destination_v2_order_bindings b JOIN public.commerce_orders o ON o.id = b.order_id
      CROSS JOIN LATERAL (SELECT CASE WHEN o.client_id = v.client_id AND v.result->>'verified' = 'true' THEN
        public.classify_order_destination(b.order_id, v.issued, 'retained') ? 'binding_origin' ELSE false END AS valid) pin
      WHERE b.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND b.selection IS NULL AND b.service IS NULL)
    ) pins CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('subscriptionId', s.subscription_id, 'selectionRevision', s.selection_revision, 'service', s.service)
        ORDER BY s.subscription_id) FILTER (WHERE pin.valid) AS valid, bool_or(NOT pin.valid) AS withheld
      FROM public.subscription_destination_v2_selections s JOIN public.subscriptions sub ON sub.id = s.subscription_id
      CROSS JOIN LATERAL (SELECT coalesce(sub.client_id = v.client_id AND s.subscription_id = v.scope_ref AND v.purpose IS NULL
        AND (v.result->>'verified')::boolean AND s.selection_revision IS NOT NULL
        AND public.subscription_destination_v2_service_valid(s.service), false) AS valid) pin
      WHERE s.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND s.selection_revision IS NULL AND s.service IS NULL)
    ) selections)
    || CASE WHEN EXISTS (
      SELECT 1 FROM public.commerce_orders o
      JOIN public.commerce_destination_v2_order_bindings b ON b.order_id = o.id
      JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref = b.snapshot_ref
      WHERE o.client_id = p_client_id AND d.client_id <> p_client_id
    ) THEN '[{"verification":{"status":"failed","code":"destination_binding_invalid","field":"orderBindings"}}]'::jsonb
    ELSE '[]'::jsonb END
    || CASE WHEN EXISTS (
      SELECT 1 FROM public.subscriptions sub
      JOIN public.subscription_destination_v2_selections s ON s.subscription_id = sub.id
      JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref = s.snapshot_ref
      WHERE sub.client_id = p_client_id AND d.client_id <> p_client_id
    ) THEN '[{"verification":{"status":"failed","code":"destination_binding_invalid","field":"subscriptionSelections"}}]'::jsonb
    ELSE '[]'::jsonb END);
END;
$$;
