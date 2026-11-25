CREATE OR REPLACE FUNCTION public.commerce_destination_v2_refusal(p_case text, p_field text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('outcome', 'refused', 'code', code, 'field', p_field,
    'observed', observed, 'cause', cause, 'fix', fix, 'recheck', recheck)
  FROM (VALUES
    ('subscription_stale', 'destination_version_changed', 'The current subscription destination coordinates differ.',
      'The operation requires the current subscription destination coordinates.',
      'Read the current subscription destination with commerce_read_destination_v2 and a null expected binding.',
      'Repeat the operation with the verified current binding and pins.'),
    ('subscription_unavailable', 'destination_evidence_unavailable', 'Owned evidence could not be established.',
      'The operation requires evidence in the authenticated owner scope.',
      'Re-obtain evidence through the authenticated owner.', 'Repeat the authorized subscription lookup.'),
    ('subscription_selection', 'destination_v2_selection_required', 'There is no current authorized selection.',
      'A retained subscription read requires an issued selection.',
      'Recover through direct address selection on a qualified edit rail.',
      'Verify the successful selection with the authorized read.'),
    ('kind', 'destination_dialect_invalid', 'The entry kind is unsupported.', 'This operation requires a supported destination kind.',
      'Use the supported entry.', 'Invoke the supported checkout or retained-read entry.'),
    ('input', 'address_invalid_input', 'A required input is missing or malformed.', 'The destination operation requires valid authored input.',
      'Correct the indicated input.', 'Resubmit valid authored input.'),
    ('owner', 'destination_owner_unlinked', 'Authorized linkage or scope is missing.', 'The operation requires a linked customer and authorized scope.',
      'Establish authorized linkage or use authorized support.', 'Sign in to the linked account and restart selection.'),
    ('unavailable', 'destination_evidence_unavailable', 'Owned evidence could not be established.', 'The operation requires evidence in the authenticated owner scope.',
      'Re-obtain evidence through the authenticated owner.', 'Use the authorized checkout or order workflow to obtain evidence.'),
    ('binding', 'destination_binding_invalid', 'The supplied tuple is malformed.', 'The operation requires an authoritative binding and sealed pins.',
      'Re-obtain authoritative evidence.', 'Obtain the original owned tuple.'),
    ('stored_binding', 'destination_binding_invalid', 'Stored evidence failed verification.', 'The stored binding and pins must match the issued evidence and scope.',
      'Send the retained evidence to the destination owner for review.', 'After authorized resolution recheck retained evidence, or start a fresh selection where available.'),
    ('digest', 'destination_digest_mismatch', 'The supplied digest differs from the verified digest.', 'The supplied digest must identify the original document.',
      'Replay the original document and its digest.', 'Replay the authentic pair.'),
    ('stored_digest', 'destination_digest_mismatch', 'A stored document or address digest failed verification.', 'Retained digests must match the original stored evidence.',
      'Replay the original document and its digest.', 'Use authorized review to recover the pair, or start a fresh selection where issuance is available.'),
    ('stale', 'destination_version_changed', 'The sealed checkout evidence changed or reached cutoff.', 'Fresh checkout requires current selected evidence before its cutoff.',
      'Re-obtain current evidence. Checkout requires a fresh final quote and acceptance.', 'Reselect, re-quote and reaccept before submitting.'),
    ('retained', 'destination_version_changed', 'The supplied binding differs from the recorded binding.', 'A retained read requires the original order binding.',
      'Use the binding recorded for the original order.', 'Take the order''s binding from its sealed checkout evidence through the authorized order workflow, then repeat the read; never reselect for a placed order.'),
    ('selection', 'destination_v2_selection_required', 'There is no current authorized selection.', 'Fresh checkout requires an authorized selection.',
      'Validate and select a full address.', 'Save a full selection and obtain a new quote.'),
    ('occupied', 'destination_order_binding_occupied', 'The order already has different verified evidence.', 'An existing order binding is immutable.',
      'Resolve the existing binding without moving it.', 'Replay with the original authenticated evidence or resolve through the order owner.'),
    ('busy', 'destination_busy', 'The target order lock is held.', 'Binding requires an immediate exclusive order lock.',
      'Retry the same scoped operation.', 'Roll back and retry with the same authenticated evidence.'),
    ('isolation', 'destination_isolation_unsupported', 'The transaction mode is unsupported.', 'Checkout binding and existing-order replay require their respective transaction lanes.',
      'Roll back and restart in the required transaction mode.', 'Use repeatable read for a fresh bind and read committed for existing-order replay.')
  ) AS cases(name, code, observed, cause, fix, recheck) WHERE name = p_case;
$$;

CREATE FUNCTION public.subscription_destination_v2_read(p_ctx jsonb, p_id uuid, p_binding jsonb,
  p_revision uuid, p_service jsonb, p_recheck boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_client uuid;
  v_origins public.subscription_activations[] := ARRAY[]::public.subscription_activations[];
  v_origin public.subscription_activations;
  v_bound public.commerce_destination_v2_order_bindings;
  v_snapshot uuid;
  v_scope jsonb;
  v_inherited boolean;
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
  PERFORM 1 FROM public.clients WHERE id = v_client AND principal_id = (p_ctx#>>'{owner,principalRef}')::uuid
    AND NOT metadata ? 'absorption' FOR SHARE;
  IF NOT FOUND THEN RETURN public.commerce_destination_v2_refusal('owner', 'owner'); END IF;
  IF EXISTS (SELECT 1 FROM public.identity_privacy_erasures WHERE client_id = v_client) THEN RETURN v_unavailable; END IF;

  SELECT snapshot_ref INTO v_snapshot FROM public.subscription_destination_v2_selections
    WHERE subscription_id = p_id FOR SHARE;
  v_inherited := NOT FOUND;
  v_scope := to_jsonb(p_id);
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
    IF NOT FOUND THEN RETURN v_absent; END IF;
    IF v_bound.selection IS NULL AND v_bound.service IS NULL THEN RETURN v_unavailable; END IF;
    v_scope := v_bound.selection->'scopeRef';
    IF NOT public.commerce_destination_v2_is_uuid(v_scope) THEN RETURN v_unavailable; END IF;
    v_snapshot := v_bound.snapshot_ref;
  END IF;

  SELECT * INTO v_doc FROM public.commerce_destination_v2_documents
    WHERE snapshot_ref = v_snapshot AND client_id = v_client AND owner_scope = p_ctx->'owner'
      AND scope_ref = (v_scope #>> '{}')::uuid AND evidence_disposition = 'available'
      AND CASE WHEN v_inherited THEN purpose = 'checkout' ELSE purpose IS NULL END FOR SHARE;
  IF NOT FOUND THEN RETURN v_unavailable; END IF;
  v_current := public.subscription_destination_v2_current(p_ctx, p_id, v_origins);
  IF v_current->>'field' = 'orderBindings' THEN RETURN v_current; END IF;
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
    IF v_checked ? 'outcome' THEN RETURN v_unavailable; END IF;
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

    -- A superseded document can yield stale advice only within this subscription's lineage.
    -- The prior inherited order is only evidence of lineage once a direct pointer exists.
    SELECT d.* INTO v_doc FROM public.commerce_destination_v2_documents d
      WHERE d.snapshot_ref = v_expected AND d.client_id = v_client AND d.owner_scope = p_ctx->'owner'
        AND d.evidence_disposition = 'available' AND (
          (d.scope_ref = p_id AND d.purpose IS NULL) OR (d.purpose = 'checkout' AND EXISTS (
            SELECT 1 FROM (SELECT public.subscription_destination_v2_origins(p_id) AS origins) probe
            CROSS JOIN LATERAL unnest(probe.origins) a
            JOIN public.commerce_orders o ON o.id = a.order_id AND o.client_id = v_client
            JOIN public.commerce_destination_v2_order_bindings b ON b.order_id = o.id AND b.snapshot_ref = d.snapshot_ref
            WHERE a.client_id = v_client AND public.commerce_destination_v2_valid_pins(b.selection, b.service, d.scope_ref)
              AND cardinality(probe.origins) = 1
          ))) FOR SHARE;
    IF NOT FOUND THEN RETURN v_unavailable; END IF;
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

REVOKE ALL ON FUNCTION public.subscription_destination_v2_read(jsonb,uuid,jsonb,uuid,jsonb,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_destination_v2_read(jsonb,uuid,jsonb,uuid,jsonb,boolean) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_destination_v2_read(jsonb,uuid,jsonb,uuid,jsonb,boolean) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_destination_v2_read(jsonb,uuid,jsonb,uuid,jsonb,boolean) FROM service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_read_destination_v2(p_ctx jsonb, p_kind text, p_id uuid, p_expected_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents%ROWTYPE;
  v_verification jsonb;
  v_binding_fields constant text[] := ARRAY['snapshotRef','schemaVersion','destinationDigest','policyRevision'];
  v_binding_cause constant jsonb := '{"cause":"A snapshot read requires the exact binding for the requested snapshot."}';
BEGIN
  IF p_kind = 'subscription' THEN
    RETURN public.subscription_destination_v2_read(p_ctx, p_id, p_expected_binding, NULL, NULL, false);
  END IF;
  IF p_kind IN ('order', 'shipment') THEN
    RETURN public.commerce_destination_v2_read_retained(p_ctx, p_kind, p_id, p_expected_binding);
  END IF;
  IF p_kind IS DISTINCT FROM 'snapshot' THEN
    RETURN public.commerce_destination_v2_refusal('kind', 'version');
  END IF;
  SELECT * INTO v_row FROM public.commerce_destination_v2_documents
    WHERE purpose = 'checkout' AND snapshot_ref = p_id AND to_jsonb(client_id) = p_ctx->'clientId'
      AND to_jsonb(scope_ref) = p_ctx->'scopeRef' AND owner_scope = p_ctx->'owner' AND evidence_disposition <> 'erased'
      AND NOT EXISTS (SELECT 1 FROM public.identity_privacy_erasures e WHERE e.client_id = commerce_destination_v2_documents.client_id);
  BEGIN
    v_verification := public.commerce_destination_v2_check_document(v_row, 'destination.snapshotRef');
  EXCEPTION WHEN numeric_value_out_of_range THEN
    -- Stored JSON can exceed PostgreSQL's numeric range before address canonicalization.
    v_verification := public.commerce_destination_v2_refusal('stored_binding', 'destination');
  END;
  IF v_verification->>'code' = 'destination_binding_invalid' THEN
    RETURN v_verification || '{"cause":"The stored snapshot document and binding must match the issued evidence and scope."}'::jsonb;
  END IF;
  IF v_verification->>'outcome' = 'refused' THEN RETURN v_verification; END IF;
  IF jsonb_typeof(p_expected_binding) IS DISTINCT FROM 'object'
    OR NOT p_expected_binding ?& v_binding_fields OR p_expected_binding - v_binding_fields <> '{}'::jsonb
    OR p_expected_binding->'snapshotRef' IS DISTINCT FROM to_jsonb(p_id)
    OR p_expected_binding->>'schemaVersion' IS DISTINCT FROM '2'
    OR p_expected_binding->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR NOT coalesce(p_expected_binding->>'destinationDigest' COLLATE "C" ~ '^[0-9a-f]{64}$', false)
    OR jsonb_typeof(p_expected_binding->'destinationDigest') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_expected_binding->'policyRevision') IS DISTINCT FROM 'string'
    OR btrim(p_expected_binding->>'policyRevision') = '' OR octet_length(p_expected_binding->>'policyRevision') > 720 THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination') || v_binding_cause;
  END IF;
  IF p_expected_binding->'destinationDigest' IS DISTINCT FROM v_row.binding->'destinationDigest' THEN
    RETURN public.commerce_destination_v2_refusal('digest', 'destinationDigest');
  END IF;
  IF p_expected_binding->'policyRevision' IS DISTINCT FROM v_row.binding->'policyRevision' THEN
    RETURN public.commerce_destination_v2_refusal('stale', 'destination.policyRevision');
  END IF;
  IF p_expected_binding IS DISTINCT FROM v_row.binding THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination') || v_binding_cause;
  END IF;
  IF v_row.evidence_disposition = 'expired' OR clock_timestamp() >= v_row.evidence_expires_at THEN
    RETURN public.commerce_destination_v2_refusal('stale', 'destination.snapshotRef');
  END IF;
  RETURN jsonb_build_object('binding', v_row.binding, 'document', v_verification->'document', 'documentDigest', v_row.document_digest,
    'evidenceExpiresAt', to_char(v_row.evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_recheck_destination_v2(p_ctx jsonb, p_kind text, p_scope_ref uuid,
  p_expected_selection_revision uuid, p_expected_binding jsonb, p_expected_service jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents;
  v_current public.commerce_destination_v2_checkout_selections;
  v_result jsonb;
  v_selection jsonb := jsonb_build_object('kind', 'checkout', 'scopeRef', p_scope_ref, 'selectionRevision', p_expected_selection_revision);
BEGIN
  IF p_kind = 'subscription' THEN
    RETURN public.subscription_destination_v2_read(p_ctx, p_scope_ref, p_expected_binding,
      p_expected_selection_revision, p_expected_service, true);
  END IF;
  IF p_kind IS DISTINCT FROM 'checkout' THEN RETURN public.commerce_destination_v2_refusal('kind', 'version'); END IF;
  IF NOT public.commerce_destination_v2_valid_context(p_ctx, p_scope_ref) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  IF NOT public.commerce_destination_v2_is_uuid(p_expected_binding->'snapshotRef') THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination');
  END IF;
  v_row := public.commerce_destination_v2_owned_document(p_ctx, (p_expected_binding->>'snapshotRef')::uuid);
  v_result := public.commerce_destination_v2_check_document(v_row, 'destination.snapshotRef');
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  IF NOT public.commerce_destination_v2_valid_binding(p_expected_binding) THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination');
  END IF;
  IF p_expected_binding->'destinationDigest' IS DISTINCT FROM v_row.binding->'destinationDigest' THEN
    RETURN public.commerce_destination_v2_refusal('digest', 'destinationDigest');
  END IF;
  IF NOT public.commerce_destination_v2_valid_pins(v_selection, p_expected_service, p_scope_ref) THEN
    RETURN public.commerce_destination_v2_refusal('binding', CASE WHEN p_expected_selection_revision IS NULL THEN 'destination' ELSE 'selectedDelivery' END);
  END IF;
  IF p_expected_binding->'policyRevision' IS DISTINCT FROM v_row.binding->'policyRevision' THEN
    RETURN public.commerce_destination_v2_refusal('stale', 'destination.policyRevision');
  END IF;
  IF v_row.evidence_disposition = 'expired' OR clock_timestamp() >= v_row.evidence_expires_at THEN
    RETURN public.commerce_destination_v2_refusal('stale', 'destination.snapshotRef');
  END IF;
  SELECT * INTO v_current FROM public.commerce_destination_v2_checkout_selections
    WHERE owner_scope = p_ctx->'owner' AND scope_ref = p_scope_ref;
  IF NOT FOUND THEN RETURN public.commerce_destination_v2_refusal('selection', 'destination.snapshotRef'); END IF;
  IF v_current.selection_revision <> p_expected_selection_revision THEN
    RETURN public.commerce_destination_v2_refusal('stale', 'selectionRevision');
  END IF;
  IF v_current.snapshot_ref <> v_row.snapshot_ref THEN RETURN public.commerce_destination_v2_refusal('stale', 'destination.snapshotRef'); END IF;
  RETURN jsonb_build_object('binding', v_row.binding, 'selection', v_selection, 'service', p_expected_service);
END;
$$;
