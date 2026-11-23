-- The document is immutable until expiry or erasure. A selection is a mutable pointer.
CREATE TABLE public.commerce_destination_v2_documents (
  snapshot_ref uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  owner_scope jsonb CHECK (jsonb_typeof(owner_scope) = 'object'),
  scope_ref uuid,
  purpose text NOT NULL CHECK (purpose = 'checkout'),
  issued_at timestamptz NOT NULL,
  evidence_expires_at timestamptz NOT NULL,
  binding jsonb CHECK (jsonb_typeof(binding) = 'object'),
  document_text text,
  document_digest text CHECK (length(document_digest) = 64),
  evidence_disposition text NOT NULL CHECK (
    (evidence_disposition = 'available' AND owner_scope IS NOT NULL AND scope_ref IS NOT NULL
      AND binding IS NOT NULL AND document_text IS NOT NULL AND document_digest IS NOT NULL)
    OR (evidence_disposition = 'expired' AND owner_scope IS NOT NULL AND scope_ref IS NOT NULL
      AND binding IS NOT NULL AND document_text IS NULL AND document_digest IS NULL)
    OR (evidence_disposition = 'erased' AND owner_scope IS NULL AND scope_ref IS NULL
      AND binding IS NULL AND document_text IS NULL AND document_digest IS NULL))
);
CREATE INDEX commerce_destination_v2_documents_client_idx ON public.commerce_destination_v2_documents (client_id);
CREATE INDEX commerce_destination_v2_documents_expiry_idx ON public.commerce_destination_v2_documents (evidence_disposition, evidence_expires_at, snapshot_ref);
ALTER TABLE public.commerce_destination_v2_documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.commerce_destination_v2_checkout_selections (
  owner_scope jsonb NOT NULL CHECK (jsonb_typeof(owner_scope) = 'object'),
  scope_ref uuid NOT NULL,
  selection_revision uuid NOT NULL,
  snapshot_ref uuid NOT NULL REFERENCES public.commerce_destination_v2_documents(snapshot_ref),
  PRIMARY KEY (owner_scope, scope_ref)
);
CREATE INDEX commerce_destination_v2_checkout_selection_document_idx ON public.commerce_destination_v2_checkout_selections (snapshot_ref);
ALTER TABLE public.commerce_destination_v2_checkout_selections ENABLE ROW LEVEL SECURITY;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('commerce_destination_v2_documents', 'block', 'Destination document history prevents lead absorption.');

CREATE FUNCTION public.commerce_destination_v2_canonical(p_value jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN public.catalog_publication_canonical(p_value, 0);
END;
$$;

CREATE FUNCTION public.commerce_snapshot_destination_v2(p_ctx jsonb, p_command jsonb, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner jsonb := p_ctx->'owner';
  v_dialect text := p_command->>'dialect';
  v_key text := p_command->>'requestKey';
  v_original jsonb := p_command->'original';
  v_validated jsonb := p_command->'validated';
  v_address_fields constant text[] := ARRAY['line1','line2','city','subdivisionCode','postalCode','countryCode'];
  v_contact_fields constant text[] := ARRAY['recipientName','contactEmail','contactPhone','companyName','label','taxId','deliveryNotes','courierInstructions'];
  v_controls constant text := U&'[\0001-\001F\007F-\009F]';
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_field text;
  v_value text;
  v_item jsonb;
  v_limit integer;
  v_previous text;
  v_client uuid;
  v_scope uuid;
  v_request_digest text;
  v_address jsonb;
  v_contact jsonb;
  v_binding jsonb;
  v_selection jsonb;
  v_document text;
  v_snapshot uuid := gen_random_uuid();
  v_issued timestamptz;
  v_cutoff timestamptz;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = 'command', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  IF v_dialect IS DISTINCT FROM 'commerce.destination.snapshot.v2' THEN
    RAISE EXCEPTION 'destination_dialect_invalid' USING ERRCODE = '22023',
      DETAIL = 'version', HINT = 'Use the supported entry.';
  END IF;
  v_field := CASE
    WHEN NOT coalesce(isfinite(p_now), false) THEN 'now'
    WHEN jsonb_typeof(p_command->'requestKey') IS DISTINCT FROM 'string' THEN 'requestKey'
    WHEN p_command->'purpose' IS DISTINCT FROM '"checkout"'::jsonb THEN 'purpose'
    WHEN NOT coalesce(p_command->>'scopeRef' COLLATE "C" ~ v_uuid, false) THEN 'scopeRef'
    WHEN jsonb_typeof(p_command->'requestDigest') IS DISTINCT FROM 'string' OR NOT coalesce(p_command->>'requestDigest' COLLATE "C" ~ '^[0-9a-f]{64}$', false) THEN 'requestDigest'
    WHEN jsonb_typeof(v_original) IS DISTINCT FROM 'object' OR octet_length(v_original::text) > 16384 THEN 'original'
    WHEN jsonb_typeof(v_original->'address') IS DISTINCT FROM 'object' THEN 'original.address'
    WHEN jsonb_typeof(v_original->'contact') IS DISTINCT FROM 'object' THEN 'original.contact'
  END;
  IF v_field IS NULL THEN
    SELECT name INTO v_field FROM (
      SELECT key AS name FROM jsonb_object_keys(p_command - ARRAY['dialect','requestKey','requestDigest','purpose','scopeRef','original','validated']) AS keys(key)
      UNION ALL SELECT 'original.' || key FROM jsonb_object_keys(v_original - ARRAY['address','contact']) AS keys(key)
      UNION ALL SELECT 'original.address.' || key FROM jsonb_object_keys((v_original->'address') - v_address_fields) AS keys(key)
      UNION ALL SELECT 'original.contact.' || key FROM jsonb_object_keys((v_original->'contact') - v_contact_fields) AS keys(key)
      UNION ALL SELECT 'original.address.' || key FROM unnest(ARRAY['line1','city','postalCode','countryCode']) AS keys(key)
        WHERE NOT (v_original->'address') ? key
      UNION ALL SELECT 'original.' || part || '.' || field.key
        FROM (VALUES ('address', v_original->'address'), ('contact', v_original->'contact')) AS section(part, body)
        CROSS JOIN LATERAL jsonb_each(body) AS field
        WHERE jsonb_typeof(field.value) <> 'string' OR (field.value #>> '{}') COLLATE "C" ~ v_controls
    ) AS invalid ORDER BY name COLLATE "C" LIMIT 1;
  END IF;
  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = v_field, HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;

  -- The native host supplies these coordinates after authorizing the checkout scope.
  IF jsonb_typeof(p_ctx) IS DISTINCT FROM 'object'
    OR p_ctx - ARRAY['owner','clientId','scopeRef'] <> '{}'::jsonb
    OR jsonb_typeof(v_owner) IS DISTINCT FROM 'object'
    OR v_owner - ARRAY['installationRef','principalKind','principalRef','customerOrSessionRef'] <> '{}'::jsonb
    OR jsonb_typeof(v_owner->'installationRef') IS DISTINCT FROM 'string'
    OR octet_length(v_owner->>'installationRef') NOT BETWEEN 1 AND 200
    OR v_owner->>'principalKind' IS DISTINCT FROM 'customer'
    OR NOT coalesce(p_ctx->>'clientId' COLLATE "C" ~ v_uuid, false)
    OR NOT coalesce(v_owner->>'principalRef' COLLATE "C" ~ v_uuid, false)
    OR v_owner->'customerOrSessionRef' IS DISTINCT FROM p_ctx->'clientId'
    OR NOT coalesce(p_ctx->>'scopeRef' COLLATE "C" ~ v_uuid, false)
    OR p_command->'scopeRef' IS DISTINCT FROM p_ctx->'scopeRef' THEN
    RAISE EXCEPTION 'destination_owner_unlinked' USING ERRCODE = '22023',
      DETAIL = 'owner', HINT = 'Establish authorized linkage or use authorized support.';
  END IF;
  v_client := (p_ctx->>'clientId')::uuid;
  v_scope := (p_ctx->>'scopeRef')::uuid;

  v_request_digest := encode(sha256(convert_to(public.commerce_destination_v2_canonical(jsonb_build_array(
    'commerce.destination.request.v2', jsonb_build_object('dialect', v_dialect, 'owner', v_owner,
      'requestKey', v_key, 'purpose', 'checkout', 'scopeRef', v_scope, 'original', v_original)
  )), 'UTF8')), 'hex');
  IF p_command->>'requestDigest' COLLATE "C" IS DISTINCT FROM v_request_digest THEN
    RAISE EXCEPTION 'destination_idempotency_conflict' USING ERRCODE = '23505',
      DETAIL = 'idempotencyKey', HINT = 'Replay the original command or begin a distinct action.';
  END IF;

  -- The receipt owner re-reads after taking the key and shared erasure fence.
  p_ctx := p_ctx - 'scopeRef';
  v_receipt := public.commerce_destination_v2_receipt_lock(p_ctx, v_dialect, v_key, v_request_digest);
  IF v_receipt->>'kind' = 'receipt' THEN
    IF v_receipt->>'evidenceDisposition' = 'erased' THEN
      RETURN jsonb_build_object('evidenceDisposition', 'erased');
    END IF;
    RETURN (v_receipt->'outcome') || jsonb_build_object('eventId', v_receipt->'eventId', 'replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = v_client AND principal_id = (v_owner->>'principalRef')::uuid) THEN
    RAISE EXCEPTION 'destination_owner_unlinked' USING ERRCODE = '22023',
      DETAIL = 'owner', HINT = 'Establish authorized linkage or use authorized support.';
  END IF;

  v_address := v_validated->'address';
  v_contact := v_validated->'contact';
  v_field := CASE
    WHEN jsonb_typeof(v_validated) IS DISTINCT FROM 'object' THEN 'validated'
    WHEN jsonb_typeof(v_address) IS DISTINCT FROM 'object' THEN 'validated.address'
    WHEN jsonb_typeof(v_contact) IS DISTINCT FROM 'object' THEN 'validated.contact'
    WHEN NOT coalesce(v_address->>'countryCode' COLLATE "C" ~ '^[A-Z]{2}$', false) THEN 'countryCode'
    WHEN v_address ? 'subdivisionCode' AND NOT coalesce(v_address->>'subdivisionCode' COLLATE "C" ~ '^[A-Z0-9-]{1,16}$', false) THEN 'subdivisionCode'
    WHEN jsonb_typeof(v_validated->'classificationKeys') IS DISTINCT FROM 'array' THEN 'classificationKeys'
  END;
  IF v_field IS NULL THEN
    SELECT name INTO v_field FROM (
      SELECT 'validated.' || key AS name FROM jsonb_object_keys(v_validated - ARRAY['policyRef','policyRevision','address','contact','classificationKeys']) AS keys(key)
      UNION ALL SELECT 'validated.address.' || key FROM jsonb_object_keys(v_address - v_address_fields) AS keys(key)
      UNION ALL SELECT 'validated.contact.' || key FROM jsonb_object_keys(v_contact - v_contact_fields) AS keys(key)
      UNION ALL SELECT key FROM unnest(ARRAY['line1','city','postalCode']) AS keys(key) WHERE NOT v_address ? key
    ) AS invalid ORDER BY name COLLATE "C" LIMIT 1;
  END IF;
  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = v_field, HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  -- Validate the projection's wire shape. Postal and classification decisions belong to the host policy.
  FOR v_field, v_limit IN SELECT * FROM (VALUES
    ('line1',200),('line2',200),('city',120),('postalCode',32),('countryCode',2),('subdivisionCode',16),
    ('recipientName',200),('contactEmail',254),('contactPhone',64),('companyName',200),('label',200),
    ('taxId',64),('deliveryNotes',500),('courierInstructions',500),('policyRef',720),('policyRevision',720)
  ) AS fields(name, byte_limit)
  LOOP
    IF NOT (v_address ? v_field OR v_contact ? v_field OR v_field IN ('policyRef','policyRevision')) THEN CONTINUE; END IF;
    v_value := coalesce(v_address->>v_field, v_contact->>v_field, v_validated->>v_field);
    IF jsonb_typeof(coalesce(v_address->v_field, v_contact->v_field, v_validated->v_field)) IS DISTINCT FROM 'string'
      OR v_value COLLATE "C" ~ v_controls OR octet_length(v_value) > v_limit
      OR btrim(v_value) = '' OR (v_address ? v_field AND (v_value <> btrim(v_value) OR NOT (v_value IS NFC NORMALIZED))) THEN
      RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
        DETAIL = v_field, HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
    END IF;
  END LOOP;
  IF jsonb_array_length(v_validated->'classificationKeys') > 32 THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = 'classificationKeys', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_validated->'classificationKeys')
  LOOP
    v_value := v_item #>> '{}';
    IF jsonb_typeof(v_item) <> 'string' OR length(v_value) > 64 OR v_value COLLATE "C" !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
      OR v_previous COLLATE "C" >= v_value THEN
      RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
        DETAIL = 'classificationKeys', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
    END IF;
    v_previous := v_value;
  END LOOP;

  v_address := (v_address - ARRAY['countryCode','subdivisionCode']) || jsonb_build_object('country', v_address->'countryCode');
  IF (v_validated->'address') ? 'subdivisionCode' THEN
    v_address := v_address || jsonb_build_object('subdivision', v_validated->'address'->'subdivisionCode');
  END IF;
  v_binding := jsonb_build_object('snapshotRef', v_snapshot, 'schemaVersion', 2, 'policyRevision', v_validated->'policyRevision',
    'destinationDigest', encode(sha256(convert_to(public.commerce_destination_v2_canonical(
      jsonb_build_array('commerce.destination.v2', v_address)), 'UTF8')), 'hex'));
  v_document := public.commerce_destination_v2_canonical(jsonb_build_array('commerce.destination.document.v2',
    v_binding || jsonb_build_object('revision', 1, 'owner', v_owner, 'clientId', v_client, 'policyRef', v_validated->'policyRef',
      'classificationKeys', v_validated->'classificationKeys', 'address', v_address, 'contact', v_contact)));
  v_selection := jsonb_build_object('kind', 'checkout', 'scopeRef', v_scope, 'selectionRevision', gen_random_uuid());
  v_issued := date_trunc('milliseconds', clock_timestamp());
  v_cutoff := v_issued + interval '24 hours';

  INSERT INTO public.commerce_destination_v2_documents
    (snapshot_ref, client_id, owner_scope, scope_ref, purpose, issued_at, evidence_expires_at,
      binding, document_text, document_digest, evidence_disposition)
  VALUES (v_snapshot, v_client, v_owner, v_scope, 'checkout', v_issued, v_cutoff,
    v_binding, v_document, encode(sha256(convert_to(v_document, 'UTF8')), 'hex'), 'available');
  INSERT INTO public.commerce_destination_v2_checkout_selections (owner_scope, scope_ref, selection_revision, snapshot_ref)
  VALUES (v_owner, v_scope, (v_selection->>'selectionRevision')::uuid, v_snapshot)
  ON CONFLICT (owner_scope, scope_ref) DO UPDATE SET
    selection_revision = excluded.selection_revision, snapshot_ref = excluded.snapshot_ref;
  v_receipt := public.commerce_destination_v2_receipt_commit(p_ctx, v_dialect, v_key, v_request_digest,
    jsonb_build_object('binding', v_binding, 'selection', v_selection,
      'evidenceExpiresAt', to_char(v_cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN (v_receipt->'outcome') || jsonb_build_object('eventId', v_receipt->'eventId', 'replayed', false);
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_verified_document(v_row public.commerce_destination_v2_documents)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_preimage jsonb;
  v_document jsonb;
  v_digest text;
BEGIN
  IF encode(sha256(convert_to(v_row.document_text, 'UTF8')), 'hex') IS DISTINCT FROM v_row.document_digest THEN
    RAISE EXCEPTION 'destination_digest_mismatch' USING ERRCODE = '55000',
      DETAIL = 'documentDigest', HINT = 'Replay the original document and its digest.';
  END IF;
  BEGIN
    v_preimage := v_row.document_text::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'destination_digest_mismatch' USING ERRCODE = '55000',
      DETAIL = 'documentDigest', HINT = 'Replay the original document and its digest.';
  END;
  v_document := v_preimage->1;
  IF v_preimage->>0 IS DISTINCT FROM 'commerce.destination.document.v2'
    OR v_preimage IS DISTINCT FROM jsonb_build_array('commerce.destination.document.v2', v_document)
    OR jsonb_typeof(v_document) IS DISTINCT FROM 'object'
    OR v_document->'owner' IS DISTINCT FROM v_row.owner_scope
    OR v_document->'clientId' IS DISTINCT FROM to_jsonb(v_row.client_id)
    OR v_row.owner_scope->'customerOrSessionRef' IS DISTINCT FROM to_jsonb(v_row.client_id)
    OR v_document->'snapshotRef' IS DISTINCT FROM to_jsonb(v_row.snapshot_ref)
    OR v_document->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR v_document->'revision' IS DISTINCT FROM '1'::jsonb
    OR v_document - ARRAY['revision','owner','clientId','policyRef','classificationKeys','address','contact'] IS DISTINCT FROM v_row.binding THEN
    RAISE EXCEPTION 'destination_binding_invalid' USING ERRCODE = '22023',
      DETAIL = 'destination', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  v_digest := encode(sha256(convert_to(public.commerce_destination_v2_canonical(
    jsonb_build_array('commerce.destination.v2', v_document->'address')), 'UTF8')), 'hex');
  IF v_digest IS DISTINCT FROM v_row.binding->>'destinationDigest' THEN
    RAISE EXCEPTION 'destination_digest_mismatch' USING ERRCODE = '55000',
      DETAIL = 'destinationDigest', HINT = 'Replay the original document and its digest.';
  END IF;
  RETURN v_document;
END;
$$;

CREATE FUNCTION public.commerce_read_destination_v2(p_ctx jsonb, p_kind text, p_id uuid, p_expected_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents%ROWTYPE;
  v_document jsonb;
  v_binding_fields constant text[] := ARRAY['snapshotRef','schemaVersion','destinationDigest','policyRevision'];
BEGIN
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
    v_document := public.commerce_destination_v2_verified_document(v_row);
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
  RETURN jsonb_build_object('binding', v_row.binding, 'document', v_document, 'documentDigest', v_row.document_digest,
    'evidenceExpiresAt', to_char(v_row.evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_export(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN (SELECT coalesce(jsonb_agg(
    jsonb_build_object('snapshotRef', snapshot_ref, 'issuedAt',
      to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'evidenceDisposition', evidence_disposition)
    || CASE WHEN evidence_disposition = 'available' THEN
      jsonb_build_object('document', public.commerce_destination_v2_verified_document(d), 'scopeRef', scope_ref, 'documentDigest', document_digest,
        'evidenceExpiresAt', to_char(evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ELSE '{}'::jsonb END ORDER BY snapshot_ref), '[]'::jsonb)
    FROM public.commerce_destination_v2_documents AS d WHERE client_id = p_client_id);
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_erase(p_client_id uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  -- The privacy unit of work already holds the exclusive erasure-ledger lane.
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
  DELETE FROM public.commerce_destination_v2_checkout_selections s USING public.commerce_destination_v2_documents d
    WHERE s.snapshot_ref = d.snapshot_ref AND d.client_id = p_client_id;
  UPDATE public.commerce_destination_v2_documents SET owner_scope = NULL, scope_ref = NULL, binding = NULL,
    document_text = NULL, document_digest = NULL, evidence_disposition = 'erased'
    WHERE client_id = p_client_id AND evidence_disposition <> 'erased';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_expire(p_now timestamptz, p_limit integer)
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
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  v_batch_time := clock_timestamp();
  -- Take subject locks in a common order across batches. Issue also takes the subject before the selection.
  FOR v_candidate IN SELECT * FROM (
    SELECT snapshot_ref, client_id, owner_scope, scope_ref FROM public.commerce_destination_v2_documents
    WHERE evidence_disposition = 'available' AND evidence_expires_at <= v_batch_time
    ORDER BY evidence_expires_at, snapshot_ref LIMIT p_limit
  ) AS candidates ORDER BY client_id, snapshot_ref
  LOOP
    PERFORM 1 FROM public.clients WHERE id = v_candidate.client_id FOR UPDATE;
    PERFORM 1 FROM public.commerce_destination_v2_checkout_selections
      WHERE owner_scope = v_candidate.owner_scope AND scope_ref = v_candidate.scope_ref FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = v_candidate.snapshot_ref
      AND evidence_disposition = 'available' AND evidence_expires_at <= clock_timestamp()
      FOR UPDATE) THEN CONTINUE; END IF;
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

REVOKE ALL ON TABLE public.commerce_destination_v2_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_destination_v2_checkout_selections FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_documents, public.commerce_destination_v2_checkout_selections FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_documents, public.commerce_destination_v2_checkout_selections FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_documents, public.commerce_destination_v2_checkout_selections FROM service_role;';
END IF; END; $$;

REVOKE ALL ON FUNCTION public.commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz), public.commerce_read_destination_v2(jsonb,text,uuid,jsonb), public.commerce_destination_v2_export(uuid), public.commerce_destination_v2_erase(uuid), public.commerce_destination_v2_canonical(jsonb), public.commerce_destination_v2_verified_document(public.commerce_destination_v2_documents), public.commerce_destination_v2_expire(timestamptz,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz), public.commerce_read_destination_v2(jsonb,text,uuid,jsonb), public.commerce_destination_v2_export(uuid), public.commerce_destination_v2_erase(uuid), public.commerce_destination_v2_canonical(jsonb), public.commerce_destination_v2_verified_document(public.commerce_destination_v2_documents), public.commerce_destination_v2_expire(timestamptz,integer) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz), public.commerce_read_destination_v2(jsonb,text,uuid,jsonb), public.commerce_destination_v2_export(uuid), public.commerce_destination_v2_erase(uuid), public.commerce_destination_v2_canonical(jsonb), public.commerce_destination_v2_verified_document(public.commerce_destination_v2_documents), public.commerce_destination_v2_expire(timestamptz,integer) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz), public.commerce_read_destination_v2(jsonb,text,uuid,jsonb), public.commerce_destination_v2_export(uuid), public.commerce_destination_v2_erase(uuid), public.commerce_destination_v2_canonical(jsonb), public.commerce_destination_v2_verified_document(public.commerce_destination_v2_documents), public.commerce_destination_v2_expire(timestamptz,integer) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz), public.commerce_read_destination_v2(jsonb,text,uuid,jsonb), public.commerce_destination_v2_export(uuid), public.commerce_destination_v2_erase(uuid) TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT SELECT (client_id) ON TABLE public.commerce_destination_v2_documents TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'CREATE POLICY commerce_destination_v2_documents_absorption_census ON public.commerce_destination_v2_documents FOR SELECT TO service_role USING (true);';
END IF; END; $$;
