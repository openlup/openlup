-- The preparation owner shares the inventory admission fence with reservation writers.
CREATE FUNCTION public.commerce_register_renewal_order_destination_v2(
  p_ctx jsonb, p_order_id uuid, p_subscription_id uuid,
  p_expected_selection_revision uuid, p_expected_binding jsonb, p_expected_service jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_client uuid;
  v_preparation public.subscription_cycle_preparations;
  v_lease_until timestamptz;
  v_stock_until timestamptz;
  v_fiscal public.subscription_cycle_tax_bindings;
  v_now timestamptz;
  v_direct uuid;
  v_expected uuid;
  v_origins public.subscription_activations[];
  v_origin public.subscription_activations;
  v_prior public.commerce_destination_v2_order_bindings;
  v_incumbent public.commerce_destination_v2_order_bindings;
  v_result jsonb;
  v_origin_guarded boolean := false;
  v_unproved_origin boolean := false;
  v_unavailable constant jsonb := public.commerce_destination_v2_refusal('subscription_unavailable', 'subscriptionId');
  v_unproved_order constant jsonb := public.commerce_destination_v2_refusal('unavailable', 'orderId');
BEGIN
  -- Collect the winning refusal before raising the SQL diagnostic.
  <<recheck>>
  BEGIN
    IF p_subscription_id IS NULL OR p_order_id IS NULL THEN
      v_result := public.commerce_destination_v2_refusal('input', CASE
        WHEN p_subscription_id IS NULL THEN 'subscriptionId' ELSE 'orderId' END);
      EXIT recheck;
    END IF;
    IF NOT public.commerce_destination_v2_valid_context(p_ctx, p_subscription_id) THEN
      v_result := public.commerce_destination_v2_refusal('owner', 'owner');
      EXIT recheck;
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE = '22023',
        DETAIL = 'isolation', HINT = 'Roll back and restart in READ COMMITTED.';
    END IF;

    v_client := (p_ctx->>'clientId')::uuid;
    PERFORM pg_advisory_xact_lock(846832106, 1);
    LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
    PERFORM 1 FROM public.subscriptions WHERE id = p_subscription_id AND client_id = v_client FOR UPDATE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.identity_privacy_erasures WHERE client_id = v_client) THEN
      v_result := v_unavailable;
      EXIT recheck;
    END IF;

    -- The caller creates this preparation on the locked occurrence. Use its
    -- own cycle, order, fiscal revision and hold even when replacing an order.
    SELECT * INTO v_preparation FROM public.subscription_cycle_preparations WHERE order_id = p_order_id;
    PERFORM 1 FROM public.subscription_cycle_occurrences
      WHERE cycle_key = v_preparation.cycle_key AND subscription_id = p_subscription_id AND client_id = v_client
        AND rail = 'v3' AND is_current AND lifecycle = 'active'
        AND operation_id = v_preparation.operation_id AND commercial_generation_id = v_preparation.commercial_generation_id
      FOR UPDATE;
    IF NOT FOUND THEN v_result := v_unproved_order; EXIT recheck; END IF;

    PERFORM 1 FROM public.subscription_renewal_operations
      WHERE id = v_preparation.operation_id AND subscription_id = p_subscription_id FOR UPDATE;
    IF NOT FOUND THEN v_result := v_unproved_order; EXIT recheck; END IF;

    SELECT lease_expires_at INTO v_lease_until FROM public.subscription_cycle_generations
      WHERE (cycle_key, operation_id, commercial_generation_id) =
        (v_preparation.cycle_key, v_preparation.operation_id, v_preparation.commercial_generation_id)
        AND current_binding_ref = v_preparation.binding_ref FOR UPDATE;
    IF NOT FOUND THEN v_result := v_unproved_order; EXIT recheck; END IF;

    PERFORM 1 FROM public.subscription_cycles
      WHERE id = v_preparation.cycle_id AND subscription_id = p_subscription_id
        AND (renewal_operation_id IS NULL OR renewal_operation_id = v_preparation.operation_id)
      FOR UPDATE;
    IF NOT FOUND THEN v_result := v_unproved_order; EXIT recheck; END IF;

    SELECT least(h.expires_at, r.expires_at) INTO v_stock_until
      FROM public.subscription_cycle_stock_holds h
      JOIN public.fulfillment_inventory_reservations r ON r.id = h.reservation_id
      WHERE h.hold_incarnation_id = v_preparation.hold_incarnation_id
        AND (h.cycle_key, h.operation_id, h.commercial_generation_id) =
          (v_preparation.cycle_key, v_preparation.operation_id, v_preparation.commercial_generation_id)
        AND r.renewal_operation_id = v_preparation.operation_id
        AND (h.state, r.status) IN (('held', 'held'), ('committed', 'committed'))
      FOR UPDATE OF h, r;
    IF NOT FOUND THEN v_result := v_unproved_order; EXIT recheck; END IF;

    PERFORM 1 FROM public.clients
      WHERE id = v_client AND principal_id = (p_ctx#>>'{owner,principalRef}')::uuid
        AND NOT metadata ? 'absorption' FOR SHARE;
    IF NOT FOUND THEN
      v_result := public.commerce_destination_v2_refusal('owner', 'owner');
      EXIT recheck;
    END IF;

    SELECT snapshot_ref INTO v_direct FROM public.subscription_destination_v2_selections
      WHERE subscription_id = p_subscription_id FOR SHARE;
    IF public.commerce_destination_v2_valid_binding(p_expected_binding) THEN
      v_expected := (p_expected_binding->>'snapshotRef')::uuid;
    END IF;

    PERFORM 1 FROM public.commerce_orders WHERE id = p_order_id AND client_id = v_client
      AND subscription_cycle_id = v_preparation.cycle_id
      AND (renewal_operation_id IS NULL OR renewal_operation_id = v_preparation.operation_id) FOR UPDATE;
    IF NOT FOUND THEN v_result := v_unproved_order; EXIT recheck; END IF;

    -- Stage inherited lineage ahead of any document lock, including when the
    -- caller's old snapshot was inherited and the current selection is direct.
    IF v_direct IS NULL OR (v_expected <> v_direct AND NOT EXISTS (
      SELECT 1 FROM public.commerce_destination_v2_documents
      WHERE snapshot_ref = v_expected AND client_id = v_client AND owner_scope = p_ctx->'owner'
        AND scope_ref = p_subscription_id AND purpose IS NULL AND evidence_disposition = 'available'
    )) THEN
      v_origins := public.subscription_destination_v2_origins(p_subscription_id);
      <<guard_origin>>
      BEGIN
        IF cardinality(v_origins) <> 1 OR (v_origins[1]).client_id IS DISTINCT FROM v_client THEN EXIT guard_origin; END IF;
        v_origin := v_origins[1];
        PERFORM 1 FROM public.commerce_orders WHERE id = v_origin.order_id AND client_id = v_client FOR SHARE;
        IF NOT FOUND THEN EXIT guard_origin; END IF;
        PERFORM 1 FROM public.subscription_activations WHERE id = v_origin.id AND order_id = v_origin.order_id
          AND subscription_id = p_subscription_id AND client_id = v_client AND state = 'active' FOR SHARE;
        IF NOT FOUND THEN EXIT guard_origin; END IF;
        v_origins := public.subscription_destination_v2_origins(p_subscription_id);
        IF cardinality(v_origins) <> 1 OR (v_origins[1]).id IS DISTINCT FROM v_origin.id THEN EXIT guard_origin; END IF;
        SELECT * INTO v_prior FROM public.commerce_destination_v2_order_bindings
          WHERE order_id = v_origin.order_id FOR SHARE;
        v_origins := public.subscription_destination_v2_origins(p_subscription_id);
        v_origin_guarded := cardinality(v_origins) = 1 AND (v_origins[1]).id = v_origin.id;
      END;
      IF v_direct IS NULL AND (cardinality(v_origins) = 0 OR (v_origin_guarded AND v_prior.order_id IS NULL)) THEN
        v_result := public.commerce_destination_v2_refusal('subscription_selection', 'subscriptionId');
        EXIT recheck;
      END IF;
      v_unproved_origin := NOT v_origin_guarded OR v_prior.order_id IS NULL
        OR (v_direct IS NOT NULL AND v_prior.snapshot_ref IS DISTINCT FROM v_expected);
    END IF;

    SELECT * INTO v_incumbent FROM public.commerce_destination_v2_order_bindings
      WHERE order_id = p_order_id FOR SHARE;
    SELECT b.* INTO v_fiscal FROM public.subscription_cycle_tax_bindings b
      JOIN public.subscription_cycle_tax_issuances i ON i.evaluation_id = b.evaluation_id
      WHERE (b.binding_ref, b.cycle_key, b.operation_id, b.commercial_generation_id, b.binding_seq) =
        (v_preparation.binding_ref, v_preparation.cycle_key, v_preparation.operation_id,
          v_preparation.commercial_generation_id, v_preparation.binding_seq)
        AND b.accepted_money_digest = v_preparation.accepted_money_digest
        AND (i.operation_id, i.commercial_generation_id, i.binding_seq) =
          (b.operation_id, b.commercial_generation_id, b.binding_seq)
        AND i.hold_incarnation_id = v_preparation.hold_incarnation_id
        AND i.erased_at IS NULL FOR SHARE OF b, i;
    IF NOT FOUND OR v_fiscal.erased_at IS NOT NULL THEN v_result := v_unproved_order; EXIT recheck; END IF;

    IF v_unproved_origin THEN
      -- Keep an unavailable explicit document ahead of any stale-pin advice.
      IF v_direct IS NOT NULL THEN
        v_result := public.subscription_destination_v2_read(p_ctx, p_subscription_id, NULL, NULL, NULL, false);
        IF v_result ? 'outcome' THEN EXIT recheck; END IF;
      END IF;
      v_result := v_unavailable;
      EXIT recheck;
    END IF;

    v_result := public.subscription_destination_v2_read(p_ctx, p_subscription_id, p_expected_binding,
      p_expected_selection_revision, p_expected_service, true);
    -- The reader folds invalid historical pins into unavailable evidence.
    -- Give the writer's stored-pin refusal only for a verified current selection
    -- and the available checkout document of the guarded acquisition origin.
    IF v_result->>'code' = 'destination_evidence_unavailable'
      AND v_direct IS NOT NULL AND v_origin_guarded AND v_prior.snapshot_ref = v_expected
      AND v_prior.selection IS NOT NULL
      AND NOT (public.subscription_destination_v2_read(p_ctx, p_subscription_id, NULL, NULL, NULL, false) ? 'outcome') THEN
      PERFORM 1 FROM public.commerce_destination_v2_documents d
        WHERE d.snapshot_ref = v_expected AND d.client_id = v_client AND d.owner_scope = p_ctx->'owner'
          AND d.purpose = 'checkout' AND d.evidence_disposition = 'available'
          AND NOT public.commerce_destination_v2_valid_pins(v_prior.selection, v_prior.service, d.scope_ref) FOR SHARE;
      IF FOUND THEN
        v_origins := public.subscription_destination_v2_origins(p_subscription_id);
        IF cardinality(v_origins) = 1 AND (v_origins[1]).id = v_origin.id THEN
          v_result := public.commerce_destination_v2_refusal('stored_binding', 'orderBindings');
        END IF;
      END IF;
    END IF;
    IF v_result ? 'outcome' THEN EXIT recheck; END IF;

    v_now := clock_timestamp();
    IF least(v_lease_until, v_stock_until, v_fiscal.expires_at) <= v_now
      OR v_fiscal.live_evidence->'binding' IS DISTINCT FROM p_expected_binding
      OR v_fiscal.live_evidence->'selectionRevision' IS DISTINCT FROM to_jsonb(p_expected_selection_revision)
      OR v_fiscal.live_evidence->'service' IS DISTINCT FROM p_expected_service THEN
      v_result := v_unproved_order;
      EXIT recheck;
    END IF;

    IF v_incumbent.order_id IS NOT NULL THEN
      IF v_incumbent.snapshot_ref IS DISTINCT FROM v_expected OR v_incumbent.selection IS DISTINCT FROM v_result->'selection'
        OR v_incumbent.service IS DISTINCT FROM v_result->'service' THEN
        RAISE EXCEPTION 'destination_order_binding_occupied' USING ERRCODE = '23505',
          DETAIL = 'orderId', HINT = 'Resolve the existing binding without moving it.';
      END IF;
    ELSE
      INSERT INTO public.commerce_destination_v2_order_bindings (order_id, snapshot_ref, selection, service)
        VALUES (p_order_id, v_expected, v_result->'selection', v_result->'service');
    END IF;
    RETURN v_result->'binding';
  END;

  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = v_result->>'code', DETAIL = v_result->>'field',
    HINT = CASE WHEN v_result->>'code' = 'destination_version_changed' THEN
      (v_result->>'fix') || ' Rebuild the selected fiscal binding before preparing again.' ELSE v_result->>'fix' END;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_register_renewal_order_destination_v2(jsonb,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_register_renewal_order_destination_v2(jsonb,uuid,uuid,uuid,jsonb,jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_register_renewal_order_destination_v2(jsonb,uuid,uuid,uuid,jsonb,jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_register_renewal_order_destination_v2(jsonb,uuid,uuid,uuid,jsonb,jsonb) FROM service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_check_retained(p_ctx jsonb, p_bound public.commerce_destination_v2_order_bindings, p_field text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents;
  v_result jsonb;
BEGIN
  IF p_bound.selection IS NULL AND p_bound.service IS NULL THEN
    RETURN public.commerce_destination_v2_refusal('unavailable', p_field);
  END IF;
  -- The acquisition lookup accepts checkout pins only. Order and shipment
  -- reads can use the renewal preparation without reading today's selection.
  IF p_bound.selection->>'kind' = 'subscription' AND p_field IN ('orderId', 'shipmentId') THEN
    SELECT * INTO v_row FROM public.commerce_destination_v2_documents
      WHERE snapshot_ref = p_bound.snapshot_ref;
    IF p_ctx->'scopeRef' IS DISTINCT FROM to_jsonb(v_row.scope_ref)
      AND p_ctx->'scopeRef' IS DISTINCT FROM p_bound.selection->'scopeRef' THEN
      RETURN public.commerce_destination_v2_refusal('unavailable', p_field);
    END IF;
    v_row := public.commerce_destination_v2_owned_document(
      p_ctx || jsonb_build_object('scopeRef', v_row.scope_ref), p_bound.snapshot_ref);
    v_result := public.commerce_destination_v2_check_document(v_row, p_field);
    IF v_result ? 'outcome' THEN RETURN v_result; END IF;
    IF v_row.evidence_disposition <> 'available'
      OR NOT public.commerce_destination_v2_is_uuid(p_bound.selection->'selectionRevision')
      OR NOT public.subscription_destination_v2_service_valid(p_bound.service)
      OR NOT EXISTS (
        SELECT 1 FROM public.subscription_cycle_preparations p
        JOIN public.commerce_orders o ON o.id = p.order_id AND o.subscription_cycle_id = p.cycle_id
        JOIN public.subscription_cycles c ON c.id = p.cycle_id
        JOIN public.subscription_cycle_occurrences x ON x.cycle_key = p.cycle_key
          AND x.subscription_id = c.subscription_id AND x.client_id = o.client_id
        JOIN public.subscription_renewal_operations op ON op.id = p.operation_id AND op.subscription_id = x.subscription_id
        JOIN public.subscription_cycle_tax_bindings b ON (b.binding_ref, b.cycle_key, b.operation_id,
          b.commercial_generation_id, b.binding_seq) =
          (p.binding_ref, p.cycle_key, p.operation_id, p.commercial_generation_id, p.binding_seq)
        WHERE p.order_id = p_bound.order_id AND o.client_id = v_row.client_id
          AND (c.renewal_operation_id IS NULL OR c.renewal_operation_id = op.id)
          AND (o.renewal_operation_id IS NULL OR o.renewal_operation_id = op.id)
          AND (v_row.purpose = 'checkout' OR (v_row.purpose IS NULL AND v_row.scope_ref = x.subscription_id))
          AND p_bound.selection = jsonb_build_object('kind', 'subscription', 'scopeRef', x.subscription_id,
            'selectionRevision', b.live_evidence->'selectionRevision')
          AND p_bound.service = b.live_evidence->'service' AND v_row.binding = b.live_evidence->'binding'
          AND b.accepted_money_digest = p.accepted_money_digest AND b.erased_at IS NULL
      ) THEN
      RETURN public.commerce_destination_v2_refusal('stored_binding', 'orderBindings');
    END IF;
    RETURN jsonb_build_object('binding', v_row.binding, 'document', v_result->'document', 'documentDigest', v_row.document_digest,
      'evidenceExpiresAt', CASE WHEN v_row.purpose IS NOT NULL THEN
        to_char(v_row.evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
  END IF;
  v_row := public.commerce_destination_v2_owned_document(p_ctx, p_bound.snapshot_ref);
  v_result := public.commerce_destination_v2_check_document(v_row, p_field);
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  IF v_row.evidence_disposition <> 'available' OR
    NOT public.commerce_destination_v2_valid_pins(p_bound.selection, p_bound.service, v_row.scope_ref) THEN
    RETURN public.commerce_destination_v2_refusal('stored_binding', 'orderBindings');
  END IF;
  RETURN jsonb_build_object('binding', v_row.binding, 'document', v_result->'document', 'documentDigest', v_row.document_digest,
    'evidenceExpiresAt', to_char(v_row.evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_export(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN (WITH verified AS MATERIALIZED (
    SELECT snapshot_ref, client_id, issued_at, purpose, evidence_disposition, scope_ref, owner_scope, document_digest, evidence_expires_at,
      CASE WHEN evidence_disposition = 'available' THEN public.commerce_destination_v2_check_document(d, 'destination.snapshotRef') END AS result
    FROM public.commerce_destination_v2_documents AS d WHERE client_id = p_client_id
  )
  SELECT coalesce(jsonb_agg(
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
      CROSS JOIN LATERAL (SELECT coalesce(o.client_id = v.client_id AND (v.result->>'verified')::boolean AND
        CASE WHEN b.selection->>'kind' = 'subscription' THEN
          (public.commerce_destination_v2_check_retained(
            jsonb_build_object('clientId', v.client_id, 'scopeRef', v.scope_ref, 'owner', v.owner_scope), b, 'orderId'
          )) ? 'binding'
        ELSE public.commerce_destination_v2_valid_pins(b.selection, b.service, v.scope_ref) END, false) AS valid) pin
      WHERE b.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND b.selection IS NULL AND b.service IS NULL)
    ) pins CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('subscriptionId', s.subscription_id, 'selectionRevision', s.selection_revision, 'service', s.service)
        ORDER BY s.subscription_id) FILTER (WHERE pin.valid) AS valid, bool_or(NOT pin.valid) AS withheld
      FROM public.subscription_destination_v2_selections s JOIN public.subscriptions sub ON sub.id = s.subscription_id
      CROSS JOIN LATERAL (SELECT coalesce(sub.client_id = v.client_id AND s.subscription_id = v.scope_ref AND v.purpose IS NULL
        AND (v.result->>'verified')::boolean AND s.selection_revision IS NOT NULL
        AND public.subscription_destination_v2_service_valid(s.service), false) AS valid) pin
      WHERE s.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND s.selection_revision IS NULL AND s.service IS NULL)
    ) selections);
END;
$$;
