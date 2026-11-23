CREATE TABLE public.commerce_destination_v2_order_bindings (
  order_id uuid PRIMARY KEY REFERENCES public.commerce_orders(id),
  snapshot_ref uuid NOT NULL REFERENCES public.commerce_destination_v2_documents(snapshot_ref),
  selection jsonb,
  service jsonb,
  CHECK ((selection IS NULL) = (service IS NULL))
);
CREATE INDEX commerce_destination_v2_order_bindings_snapshot_idx ON public.commerce_destination_v2_order_bindings (snapshot_ref);
ALTER TABLE public.commerce_destination_v2_order_bindings ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.commerce_destination_v2_refusal(p_case text, p_field text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('outcome', 'refused', 'code', code, 'field', p_field,
    'observed', observed, 'cause', cause, 'fix', fix, 'recheck', recheck)
  FROM (VALUES
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

CREATE FUNCTION public.commerce_destination_v2_is_uuid(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(jsonb_typeof(p_value) = 'string' AND (p_value #>> '{}') COLLATE "C" ~
    '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$', false);
$$;

CREATE FUNCTION public.commerce_destination_v2_valid_context(p_ctx jsonb, p_scope_ref uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_ctx) = 'object' AND jsonb_typeof(p_ctx->'owner') = 'object' THEN
    coalesce(p_ctx - ARRAY['clientId','scopeRef','owner'] = '{}'::jsonb AND p_ctx->'scopeRef' = to_jsonb(p_scope_ref)
    AND public.commerce_destination_v2_is_uuid(p_ctx->'clientId') AND
    (p_ctx->'owner') - ARRAY['installationRef','principalKind','principalRef','customerOrSessionRef'] = '{}'::jsonb
    AND p_ctx#>'{owner,principalKind}' = '"customer"'::jsonb
    AND public.commerce_destination_v2_is_uuid(p_ctx#>'{owner,principalRef}')
    AND p_ctx#>'{owner,customerOrSessionRef}' = p_ctx->'clientId'
    AND jsonb_typeof(p_ctx#>'{owner,installationRef}') = 'string'
    AND octet_length(p_ctx#>>'{owner,installationRef}') BETWEEN 1 AND 200, false) ELSE false END;
$$;

CREATE FUNCTION public.commerce_destination_v2_valid_binding(p_binding jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_binding) = 'object' THEN
    coalesce(p_binding - ARRAY['snapshotRef','schemaVersion','destinationDigest','policyRevision'] = '{}'::jsonb
    AND public.commerce_destination_v2_is_uuid(p_binding->'snapshotRef') AND p_binding->'schemaVersion' = '2'::jsonb
    AND jsonb_typeof(p_binding->'destinationDigest') = 'string' AND p_binding->>'destinationDigest' COLLATE "C" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(p_binding->'policyRevision') = 'string' AND btrim(p_binding->>'policyRevision') <> ''
    AND octet_length(p_binding->>'policyRevision') <= 720, false) ELSE false END;
$$;

CREATE FUNCTION public.commerce_destination_v2_valid_pins(p_selection jsonb, p_service jsonb, p_scope_ref uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_selection) = 'object' AND jsonb_typeof(p_service) = 'object' THEN
    coalesce(p_selection - ARRAY['kind','scopeRef','selectionRevision'] = '{}'::jsonb AND
    p_selection->'kind' = '"checkout"'::jsonb AND p_selection->'scopeRef' = to_jsonb(p_scope_ref) AND
    public.commerce_destination_v2_is_uuid(p_selection->'selectionRevision') AND
    p_service - keys = '{}'::jsonb AND
    (SELECT bool_and(coalesce(jsonb_typeof(p_service->key) = 'string' AND
      char_length(p_service->>key) BETWEEN 1 AND 256, false)) FROM unnest(keys) AS key), false) ELSE false END
  FROM (VALUES (ARRAY['deliverySelectionRef','providerRef','carrierRef','serviceRef','servicePolicyRevision','adapterRevision'])) AS pin(keys);
$$;

CREATE FUNCTION public.commerce_destination_v2_owned_document(p_ctx jsonb, p_ref uuid)
RETURNS public.commerce_destination_v2_documents LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.* FROM public.commerce_destination_v2_documents d JOIN public.clients c ON c.id = d.client_id
  WHERE d.snapshot_ref = p_ref AND d.client_id = (p_ctx->>'clientId')::uuid AND d.scope_ref = (p_ctx->>'scopeRef')::uuid
    AND d.owner_scope = p_ctx->'owner' AND d.evidence_disposition <> 'erased'
    AND c.principal_id = (p_ctx#>>'{owner,principalRef}')::uuid
    AND NOT EXISTS (SELECT 1 FROM public.identity_privacy_erasures e WHERE e.client_id = d.client_id);
$$;

CREATE FUNCTION public.commerce_destination_v2_check_document(p_row public.commerce_destination_v2_documents, p_field text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_verified jsonb;
BEGIN
  IF p_row.snapshot_ref IS NULL THEN RETURN public.commerce_destination_v2_refusal('unavailable', p_field); END IF;
  IF p_row.evidence_disposition = 'expired' THEN
    IF public.commerce_destination_v2_valid_binding(p_row.binding) AND p_row.binding->'snapshotRef' = to_jsonb(p_row.snapshot_ref) THEN
      RETURN '{}'::jsonb;
    END IF;
    RETURN public.commerce_destination_v2_refusal('stored_binding', 'destination');
  END IF;
  BEGIN
    v_verified := public.commerce_destination_v2_verified_document(p_row);
  EXCEPTION WHEN untranslatable_character THEN
    RETURN public.commerce_destination_v2_refusal('stored_digest', 'documentDigest');
  END;
  IF v_verified->>'verified' = 'true' THEN RETURN v_verified; END IF;
  RETURN public.commerce_destination_v2_refusal(
    CASE WHEN v_verified->>'code' = 'destination_digest_mismatch' THEN 'stored_digest' ELSE 'stored_binding' END,
    v_verified->>'field');
END;
$$;

CREATE FUNCTION public.commerce_lock_destination_v2_selection(p_ctx jsonb, p_scope_ref uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.commerce_destination_v2_checkout_selections
    WHERE scope_ref = p_scope_ref AND to_jsonb(scope_ref) = p_ctx->'scopeRef' AND owner_scope = p_ctx->'owner'
      AND owner_scope->'customerOrSessionRef' = p_ctx->'clientId' FOR SHARE NOWAIT;
END;
$$;

CREATE FUNCTION public.commerce_lock_destination_v2_document(p_ctx jsonb, p_scope_ref uuid, p_snapshot_ref uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = p_snapshot_ref
    AND scope_ref = p_scope_ref AND to_jsonb(scope_ref) = p_ctx->'scopeRef'
    AND to_jsonb(client_id) = p_ctx->'clientId' AND owner_scope = p_ctx->'owner' FOR SHARE NOWAIT;
END;
$$;

CREATE FUNCTION public.commerce_recheck_destination_v2(p_ctx jsonb, p_kind text, p_scope_ref uuid,
  p_expected_selection_revision uuid, p_expected_binding jsonb, p_expected_service jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents;
  v_current public.commerce_destination_v2_checkout_selections;
  v_result jsonb;
  v_selection jsonb := jsonb_build_object('kind', 'checkout', 'scopeRef', p_scope_ref, 'selectionRevision', p_expected_selection_revision);
BEGIN
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

CREATE FUNCTION public.commerce_destination_v2_check_retained(p_ctx jsonb, p_bound public.commerce_destination_v2_order_bindings, p_field text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents;
  v_result jsonb;
BEGIN
  IF p_bound.selection IS NULL AND p_bound.service IS NULL THEN
    RETURN public.commerce_destination_v2_refusal('unavailable', p_field);
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

CREATE FUNCTION public.commerce_register_order_destination_v2(p_ctx jsonb, p_order_id uuid, p_kind text, p_scope_ref uuid,
  p_expected_selection_revision uuid, p_expected_binding jsonb, p_expected_service jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_replay boolean := current_setting('transaction_isolation') = 'read committed';
  v_found uuid;
  v_bound public.commerce_destination_v2_order_bindings;
  v_result jsonb;
  v_selection jsonb := jsonb_build_object('kind', 'checkout', 'scopeRef', p_scope_ref, 'selectionRevision', p_expected_selection_revision);
BEGIN
  IF p_kind IS DISTINCT FROM 'checkout' THEN RETURN public.commerce_destination_v2_refusal('kind', 'version'); END IF;
  IF p_order_id IS NULL THEN RETURN public.commerce_destination_v2_refusal('input', 'orderId'); END IF;
  IF NOT public.commerce_destination_v2_valid_context(p_ctx, p_scope_ref) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  IF v_replay THEN
    LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
    PERFORM 1 FROM public.clients WHERE id = (p_ctx->>'clientId')::uuid FOR KEY SHARE;
    -- Acquire the row lock's implicit table lock outside the NOWAIT handler.
    LOCK TABLE public.commerce_orders IN ROW SHARE MODE;
  ELSIF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RETURN public.commerce_destination_v2_refusal('isolation', 'isolation');
  END IF;
  BEGIN
    SELECT id INTO v_found FROM public.commerce_orders WHERE id = p_order_id
      AND client_id = (p_ctx->>'clientId')::uuid FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN public.commerce_destination_v2_refusal('busy', 'orderId');
  END;
  IF v_found IS NULL THEN RETURN public.commerce_destination_v2_refusal('unavailable', 'orderId'); END IF;
  IF v_replay THEN
    -- A separate RC statement can see a child committed while this invocation waited.
    SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings WHERE order_id = p_order_id;
    v_result := public.commerce_destination_v2_check_retained(p_ctx, v_bound, 'orderId');
    IF v_result ? 'outcome' THEN RETURN v_result; END IF;
    IF NOT public.commerce_destination_v2_valid_binding(p_expected_binding) THEN
      RETURN public.commerce_destination_v2_refusal('binding', 'destination');
    END IF;
    IF NOT public.commerce_destination_v2_valid_pins(v_selection, p_expected_service, p_scope_ref) THEN
      RETURN public.commerce_destination_v2_refusal('binding', CASE WHEN p_expected_selection_revision IS NULL THEN 'destination' ELSE 'selectedDelivery' END);
    END IF;
    IF p_expected_binding IS DISTINCT FROM v_result->'binding' OR v_selection IS DISTINCT FROM v_bound.selection
      OR p_expected_service IS DISTINCT FROM v_bound.service THEN
      RETURN public.commerce_destination_v2_refusal('occupied', 'orderId');
    END IF;
    RETURN v_result->'binding';
  END IF;
  -- The fence already holds the guards, and the caller passes this writer's inserted order.
  v_result := public.commerce_recheck_destination_v2(p_ctx, p_kind, p_scope_ref,
    p_expected_selection_revision, p_expected_binding, p_expected_service);
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  INSERT INTO public.commerce_destination_v2_order_bindings (order_id, snapshot_ref, selection, service)
    VALUES (p_order_id, (p_expected_binding->>'snapshotRef')::uuid, v_result->'selection', v_result->'service');
  RETURN v_result->'binding';
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_read_retained(p_ctx jsonb, p_kind text, p_id uuid, p_expected_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_field text := CASE WHEN p_kind = 'shipment' THEN 'shipmentId' ELSE 'orderId' END;
  v_bound public.commerce_destination_v2_order_bindings;
  v_result jsonb;
  v_coordinate text;
BEGIN
  IF p_id IS NULL THEN RETURN public.commerce_destination_v2_refusal('input', v_field); END IF;
  IF NOT public.commerce_destination_v2_is_uuid(p_ctx->'scopeRef') THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  IF NOT public.commerce_destination_v2_valid_context(p_ctx, (p_ctx->>'scopeRef')::uuid) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  SELECT b.* INTO v_bound FROM public.commerce_destination_v2_order_bindings b
    JOIN public.commerce_orders o ON o.id = b.order_id
    WHERE o.client_id = (p_ctx->>'clientId')::uuid AND (CASE p_kind WHEN 'order' THEN o.id = p_id ELSE EXISTS (
      SELECT 1 FROM public.fulfillment_shipments s WHERE s.id = p_id AND s.order_id = o.id) END);
  v_result := public.commerce_destination_v2_check_retained(p_ctx, v_bound, v_field);
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  IF NOT public.commerce_destination_v2_valid_binding(p_expected_binding) THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination');
  END IF;
  FOREACH v_coordinate IN ARRAY ARRAY['snapshotRef','destinationDigest','policyRevision'] LOOP
    IF p_expected_binding->v_coordinate IS DISTINCT FROM v_result->'binding'->v_coordinate THEN
      RETURN public.commerce_destination_v2_refusal('retained',
        CASE WHEN v_coordinate = 'destinationDigest' THEN v_coordinate ELSE 'destination.' || v_coordinate END);
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_read_destination_v2(p_ctx jsonb, p_kind text, p_id uuid, p_expected_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents%ROWTYPE;
  v_verification jsonb;
  v_binding_fields constant text[] := ARRAY['snapshotRef','schemaVersion','destinationDigest','policyRevision'];
BEGIN
  IF p_kind IN ('order', 'shipment') THEN
    RETURN public.commerce_destination_v2_read_retained(p_ctx, p_kind, p_id, p_expected_binding);
  END IF;
  IF p_kind IS DISTINCT FROM 'snapshot' THEN
    RAISE EXCEPTION 'destination_dialect_invalid' USING ERRCODE = '22023',
      DETAIL = 'version', HINT = 'Use the supported entry.';
  END IF;
  SELECT * INTO v_row FROM public.commerce_destination_v2_documents
    WHERE snapshot_ref = p_id AND to_jsonb(client_id) = p_ctx->'clientId'
      AND to_jsonb(scope_ref) = p_ctx->'scopeRef' AND owner_scope = p_ctx->'owner'
      AND NOT EXISTS (SELECT 1 FROM public.identity_privacy_erasures e WHERE e.client_id = commerce_destination_v2_documents.client_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_evidence_unavailable' USING ERRCODE = '55000',
      DETAIL = 'destination.snapshotRef', HINT = 'Re-obtain evidence through the authenticated owner or review the privacy disposition.';
  END IF;
  IF v_row.evidence_disposition = 'available' THEN
    v_verification := public.commerce_destination_v2_verified_document(v_row);
    IF v_verification->>'code' = 'destination_digest_mismatch' THEN
      RAISE EXCEPTION 'destination_digest_mismatch' USING ERRCODE = '55000',
        DETAIL = v_verification->>'field', HINT = 'Replay the original document and its digest.';
    ELSIF NOT (v_verification->>'verified')::boolean THEN
      RAISE EXCEPTION 'destination_binding_invalid' USING ERRCODE = '22023',
        DETAIL = v_verification->>'field', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
    END IF;
  END IF;
  IF jsonb_typeof(p_expected_binding) IS DISTINCT FROM 'object'
    OR NOT p_expected_binding ?& v_binding_fields OR p_expected_binding - v_binding_fields <> '{}'::jsonb
    OR p_expected_binding->'snapshotRef' IS DISTINCT FROM to_jsonb(p_id)
    OR p_expected_binding->>'schemaVersion' IS DISTINCT FROM '2'
    OR p_expected_binding->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR NOT coalesce(p_expected_binding->>'destinationDigest' COLLATE "C" ~ '^[0-9a-f]{64}$', false)
    OR jsonb_typeof(p_expected_binding->'destinationDigest') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_expected_binding->'policyRevision') IS DISTINCT FROM 'string'
    OR btrim(p_expected_binding->>'policyRevision') = '' OR octet_length(p_expected_binding->>'policyRevision') > 720 THEN
    RAISE EXCEPTION 'destination_binding_invalid' USING ERRCODE = '22023',
      DETAIL = 'destination', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  IF p_expected_binding->'destinationDigest' IS DISTINCT FROM v_row.binding->'destinationDigest' THEN
    RAISE EXCEPTION 'destination_digest_mismatch' USING ERRCODE = '55000',
      DETAIL = 'destinationDigest', HINT = 'Replay the original document and its digest.';
  END IF;
  IF p_expected_binding->'policyRevision' IS DISTINCT FROM v_row.binding->'policyRevision' THEN
    RAISE EXCEPTION 'destination_version_changed' USING ERRCODE = '55000',
      DETAIL = 'destination.policyRevision', HINT = 'Re-obtain current evidence. Checkout requires a fresh final quote and acceptance.';
  END IF;
  IF p_expected_binding IS DISTINCT FROM v_row.binding THEN
    RAISE EXCEPTION 'destination_binding_invalid' USING ERRCODE = '22023',
      DETAIL = 'destination', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  IF v_row.evidence_disposition = 'expired' OR clock_timestamp() >= v_row.evidence_expires_at THEN
    RAISE EXCEPTION 'destination_version_changed' USING ERRCODE = '55000',
      DETAIL = 'destination.snapshotRef', HINT = 'Re-obtain current evidence. Checkout requires a fresh final quote and acceptance.';
  END IF;
  RETURN jsonb_build_object('binding', v_row.binding, 'document', v_verification->'document', 'documentDigest', v_row.document_digest,
    'evidenceExpiresAt', to_char(v_row.evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_export(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN (WITH verified AS MATERIALIZED (
    SELECT snapshot_ref, client_id, issued_at, evidence_disposition, scope_ref, document_digest, evidence_expires_at,
      CASE WHEN evidence_disposition = 'available' THEN public.commerce_destination_v2_check_document(d, 'destination.snapshotRef') END AS result
    FROM public.commerce_destination_v2_documents AS d WHERE client_id = p_client_id
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('snapshotRef', snapshot_ref, 'issuedAt',
      to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'evidenceDisposition', evidence_disposition)
    || CASE WHEN (result->>'verified')::boolean THEN
      jsonb_build_object('document', result->'document', 'scopeRef', scope_ref, 'documentDigest', document_digest,
        'evidenceExpiresAt', to_char(evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHEN result IS NOT NULL THEN
      jsonb_build_object('verification', jsonb_build_object('status', 'failed', 'code', result->'code', 'field', result->'field'))
    ELSE '{}'::jsonb END
    || CASE WHEN pins.valid IS NOT NULL THEN jsonb_build_object('orderBindings', pins.valid) ELSE '{}'::jsonb END
    || CASE WHEN pins.withheld AND (result IS NULL OR (result->>'verified')::boolean) THEN
      jsonb_build_object('verification', jsonb_build_object('status', 'failed', 'code', 'destination_binding_invalid', 'field', 'orderBindings'))
      ELSE '{}'::jsonb END ORDER BY snapshot_ref), '[]'::jsonb)
    FROM verified v CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('orderId', b.order_id, 'selection', b.selection, 'service', b.service)
        ORDER BY b.order_id) FILTER (WHERE pin.valid) AS valid, bool_or(NOT pin.valid) AS withheld
      FROM public.commerce_destination_v2_order_bindings b JOIN public.commerce_orders o ON o.id = b.order_id
      CROSS JOIN LATERAL (SELECT coalesce(o.client_id = v.client_id AND (v.result->>'verified')::boolean AND
        public.commerce_destination_v2_valid_pins(b.selection, b.service, v.scope_ref), false) AS valid) pin
      WHERE b.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND b.selection IS NULL AND b.service IS NULL)
    ) pins);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_erase(p_client_id uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE;
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
  UPDATE public.commerce_destination_v2_order_bindings b SET selection = NULL, service = NULL
    FROM public.commerce_destination_v2_documents d WHERE b.snapshot_ref = d.snapshot_ref
      AND d.client_id = p_client_id AND (b.selection IS NOT NULL OR b.service IS NOT NULL);
  DELETE FROM public.commerce_destination_v2_checkout_selections s USING public.commerce_destination_v2_documents d
    WHERE s.snapshot_ref = d.snapshot_ref AND d.client_id = p_client_id;
  UPDATE public.commerce_destination_v2_documents SET owner_scope = NULL, scope_ref = NULL, binding = NULL,
    document_text = NULL, document_digest = NULL, evidence_disposition = 'erased'
    WHERE client_id = p_client_id AND evidence_disposition <> 'erased';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_expire(p_now timestamptz, p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_candidate record;
  v_batch_time timestamptz;
  v_count integer := 0;
BEGIN
  IF NOT coalesce(isfinite(p_now), false) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = CASE WHEN NOT coalesce(isfinite(p_now), false) THEN 'now' ELSE 'limit' END,
      HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  v_batch_time := clock_timestamp();
  -- Take subject locks in a common order across batches. Issue also takes the subject before the selection.
  FOR v_candidate IN SELECT * FROM (
    SELECT snapshot_ref, client_id, owner_scope, scope_ref FROM public.commerce_destination_v2_documents
    WHERE evidence_disposition = 'available' AND evidence_expires_at <= v_batch_time
      AND NOT EXISTS (SELECT 1 FROM public.commerce_destination_v2_order_bindings b WHERE b.snapshot_ref = commerce_destination_v2_documents.snapshot_ref)
    ORDER BY evidence_expires_at, snapshot_ref LIMIT p_limit
  ) AS candidates ORDER BY client_id, snapshot_ref
  LOOP
    PERFORM 1 FROM public.clients WHERE id = v_candidate.client_id FOR UPDATE;
    PERFORM 1 FROM public.commerce_destination_v2_checkout_selections
      WHERE owner_scope = v_candidate.owner_scope AND scope_ref = v_candidate.scope_ref FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = v_candidate.snapshot_ref
      AND evidence_disposition = 'available' AND evidence_expires_at <= clock_timestamp()
      FOR UPDATE) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.commerce_destination_v2_order_bindings b
      WHERE b.snapshot_ref = v_candidate.snapshot_ref) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.commerce_destination_v2_checkout_selections
      WHERE snapshot_ref = v_candidate.snapshot_ref
        AND (owner_scope <> v_candidate.owner_scope OR scope_ref <> v_candidate.scope_ref)) THEN CONTINUE; END IF;
    DELETE FROM public.commerce_destination_v2_checkout_selections
      WHERE snapshot_ref = v_candidate.snapshot_ref AND owner_scope = v_candidate.owner_scope AND scope_ref = v_candidate.scope_ref;
    UPDATE public.commerce_destination_v2_documents SET evidence_disposition = 'expired', document_text = NULL, document_digest = NULL
      WHERE snapshot_ref = v_candidate.snapshot_ref;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- PostgreSQL also revokes the corresponding privileges on every column.
REVOKE ALL ON TABLE public.commerce_destination_v2_order_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_destination_v2_refusal(text,text),
  public.commerce_destination_v2_is_uuid(jsonb),
  public.commerce_destination_v2_valid_context(jsonb,uuid),
  public.commerce_destination_v2_valid_binding(jsonb),
  public.commerce_destination_v2_valid_pins(jsonb,jsonb,uuid),
  public.commerce_destination_v2_owned_document(jsonb,uuid),
  public.commerce_destination_v2_check_document(public.commerce_destination_v2_documents,text),
  public.commerce_destination_v2_check_retained(jsonb,public.commerce_destination_v2_order_bindings,text),
  public.commerce_destination_v2_read_retained(jsonb,text,uuid,jsonb),
  public.commerce_lock_destination_v2_selection(jsonb,uuid),
  public.commerce_lock_destination_v2_document(jsonb,uuid,uuid),
  public.commerce_recheck_destination_v2(jsonb,text,uuid,uuid,jsonb,jsonb),
  public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_order_bindings FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_refusal(text,text),
  public.commerce_destination_v2_is_uuid(jsonb),
  public.commerce_destination_v2_valid_context(jsonb,uuid),
  public.commerce_destination_v2_valid_binding(jsonb),
  public.commerce_destination_v2_valid_pins(jsonb,jsonb,uuid),
  public.commerce_destination_v2_owned_document(jsonb,uuid),
  public.commerce_destination_v2_check_document(public.commerce_destination_v2_documents,text),
  public.commerce_destination_v2_check_retained(jsonb,public.commerce_destination_v2_order_bindings,text),
  public.commerce_destination_v2_read_retained(jsonb,text,uuid,jsonb),
  public.commerce_lock_destination_v2_selection(jsonb,uuid),
  public.commerce_lock_destination_v2_document(jsonb,uuid,uuid),
  public.commerce_recheck_destination_v2(jsonb,text,uuid,uuid,jsonb,jsonb),
  public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_order_bindings FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_refusal(text,text),
  public.commerce_destination_v2_is_uuid(jsonb),
  public.commerce_destination_v2_valid_context(jsonb,uuid),
  public.commerce_destination_v2_valid_binding(jsonb),
  public.commerce_destination_v2_valid_pins(jsonb,jsonb,uuid),
  public.commerce_destination_v2_owned_document(jsonb,uuid),
  public.commerce_destination_v2_check_document(public.commerce_destination_v2_documents,text),
  public.commerce_destination_v2_check_retained(jsonb,public.commerce_destination_v2_order_bindings,text),
  public.commerce_destination_v2_read_retained(jsonb,text,uuid,jsonb),
  public.commerce_lock_destination_v2_selection(jsonb,uuid),
  public.commerce_lock_destination_v2_document(jsonb,uuid,uuid),
  public.commerce_recheck_destination_v2(jsonb,text,uuid,uuid,jsonb,jsonb),
  public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_order_bindings FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_refusal(text,text),
  public.commerce_destination_v2_is_uuid(jsonb),
  public.commerce_destination_v2_valid_context(jsonb,uuid),
  public.commerce_destination_v2_valid_binding(jsonb),
  public.commerce_destination_v2_valid_pins(jsonb,jsonb,uuid),
  public.commerce_destination_v2_owned_document(jsonb,uuid),
  public.commerce_destination_v2_check_document(public.commerce_destination_v2_documents,text),
  public.commerce_destination_v2_check_retained(jsonb,public.commerce_destination_v2_order_bindings,text),
  public.commerce_destination_v2_read_retained(jsonb,text,uuid,jsonb),
  public.commerce_lock_destination_v2_selection(jsonb,uuid),
  public.commerce_lock_destination_v2_document(jsonb,uuid,uuid),
  public.commerce_recheck_destination_v2(jsonb,text,uuid,uuid,jsonb,jsonb),
  public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_lock_destination_v2_selection(jsonb,uuid),
  public.commerce_lock_destination_v2_document(jsonb,uuid,uuid),
  public.commerce_recheck_destination_v2(jsonb,text,uuid,uuid,jsonb,jsonb),
  public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb) TO service_role;';
END IF; END; $$;
