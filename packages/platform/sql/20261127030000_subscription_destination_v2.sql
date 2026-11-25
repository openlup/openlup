ALTER TABLE public.commerce_destination_v2_documents ALTER COLUMN purpose DROP NOT NULL;

CREATE TABLE public.subscription_destination_v2_selections (
  subscription_id uuid PRIMARY KEY REFERENCES public.subscriptions(id),
  snapshot_ref uuid NOT NULL REFERENCES public.commerce_destination_v2_documents(snapshot_ref),
  selection_revision uuid,
  service jsonb CHECK (jsonb_typeof(service) = 'object'),
  CHECK ((selection_revision IS NULL) = (service IS NULL))
);
REVOKE ALL ON TABLE public.subscription_destination_v2_selections FROM PUBLIC;
CREATE INDEX subscription_destination_v2_selections_snapshot_idx ON public.subscription_destination_v2_selections (snapshot_ref);
ALTER TABLE public.subscription_destination_v2_selections ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_scoped_key_decision(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner jsonb := p_ctx->'owner';
  v_ref text;
  v_controls CONSTANT text := U&'[\0001-\001F\007F-\009F]';
  v_whitespace CONSTANT text := U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_dialect IS NULL OR p_dialect NOT IN ('commerce.destination.snapshot.v2', 'subscription.destination.change.v2') THEN
    RETURN public.commerce_destination_v2_refusal('kind', 'version');
  END IF;

  IF jsonb_typeof(p_ctx) IS DISTINCT FROM 'object'
    OR p_ctx - ARRAY['owner', 'clientId'] <> '{}'::jsonb
    OR jsonb_typeof(p_ctx->'clientId') IS DISTINCT FROM 'string'
    OR NOT pg_input_is_valid(p_ctx->>'clientId', 'uuid')
    OR jsonb_typeof(v_owner) IS DISTINCT FROM 'object'
    OR v_owner - ARRAY['installationRef', 'principalKind', 'principalRef', 'customerOrSessionRef'] <> '{}'::jsonb
    OR jsonb_typeof(v_owner->'principalKind') IS DISTINCT FROM 'string'
    OR v_owner->>'principalKind' NOT IN ('customer', 'checkout_session') THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  FOREACH v_ref IN ARRAY ARRAY['installationRef', 'principalRef', 'customerOrSessionRef'] LOOP
    IF jsonb_typeof(v_owner->v_ref) IS DISTINCT FROM 'string'
      OR octet_length(convert_to(v_owner->>v_ref, 'UTF8')) NOT BETWEEN 1 AND 200
      OR btrim(v_owner->>v_ref, v_whitespace) = ''
      OR (v_owner->>v_ref) COLLATE "C" ~ v_controls THEN
      RETURN public.commerce_destination_v2_refusal('owner', 'owner');
    END IF;
  END LOOP;

  IF p_request_key IS NULL OR octet_length(convert_to(p_request_key, 'UTF8')) NOT BETWEEN 8 AND 180
    OR p_request_key COLLATE "C" ~ v_controls OR btrim(p_request_key, v_whitespace) <> p_request_key THEN
    RETURN public.commerce_destination_v2_refusal('input', 'requestKey');
  END IF;
  IF p_request_digest IS NULL OR p_request_digest COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RETURN public.commerce_destination_v2_refusal('input', 'requestDigest');
  END IF;

  RETURN to_jsonb(encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(
    'commerce.destination.key.v2', jsonb_build_object('dialect', p_dialect, 'owner', v_owner, 'requestKey', p_request_key)
  ), 0), 'UTF8')), 'hex'));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_commit_decision(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text, p_outcome jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_slot jsonb := public.commerce_destination_v2_receipt_lock_decision(p_ctx, p_dialect, p_request_key, p_request_digest);
  v_binding jsonb := p_outcome->'binding';
  v_selection jsonb := p_outcome->'selection';
  v_expiry text := p_outcome->>'evidenceExpiresAt';
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_event_id uuid;
  v_created_at timestamptz := clock_timestamp();
BEGIN
  IF v_slot->>'outcome' = 'refused' THEN RETURN v_slot; END IF;
  IF v_slot->>'kind' <> 'absent' THEN
    RETURN public.commerce_destination_v2_issuance_refusal('existing_receipt');
  END IF;

  -- The effect owner supplies only its closed success projection.
  IF jsonb_typeof(p_outcome) IS DISTINCT FROM 'object'
    OR p_outcome - ARRAY['binding', 'selection', 'evidenceExpiresAt'] <> '{}'::jsonb
    OR jsonb_typeof(v_binding) IS DISTINCT FROM 'object'
    OR v_binding - ARRAY['snapshotRef', 'schemaVersion', 'destinationDigest', 'policyRevision'] <> '{}'::jsonb
    OR jsonb_typeof(v_binding->'schemaVersion') IS DISTINCT FROM 'number'
    OR (v_binding->>'schemaVersion') IS DISTINCT FROM '2'
    OR jsonb_typeof(v_binding->'snapshotRef') IS DISTINCT FROM 'string'
    OR (v_binding->>'snapshotRef') COLLATE "C" !~ v_uuid_pattern
    OR jsonb_typeof(v_binding->'destinationDigest') IS DISTINCT FROM 'string'
    OR (v_binding->>'destinationDigest') COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(v_binding->'policyRevision') IS DISTINCT FROM 'string'
    OR (v_binding->>'policyRevision') COLLATE "C" ~ U&'[\0001-\001F\007F-\009F]'
    OR (v_binding->>'policyRevision') !~ '[^[:space:]]'
    OR jsonb_typeof(v_selection) IS DISTINCT FROM 'object'
    OR v_selection - ARRAY['kind', 'scopeRef', 'selectionRevision'] <> '{}'::jsonb
    OR v_selection->>'kind' IS DISTINCT FROM
      (CASE WHEN p_dialect = 'subscription.destination.change.v2' THEN 'subscription' ELSE 'checkout' END)
    OR jsonb_typeof(v_selection->'scopeRef') IS DISTINCT FROM 'string'
    OR (v_selection->>'scopeRef') COLLATE "C" !~ v_uuid_pattern
    OR jsonb_typeof(v_selection->'selectionRevision') IS DISTINCT FROM 'string'
    OR (v_selection->>'selectionRevision') COLLATE "C" !~ v_uuid_pattern
    OR (CASE WHEN p_dialect = 'subscription.destination.change.v2' THEN
      p_outcome->'evidenceExpiresAt' IS DISTINCT FROM 'null'::jsonb
    ELSE jsonb_typeof(p_outcome->'evidenceExpiresAt') IS DISTINCT FROM 'string'
      OR v_expiry COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
      OR NOT pg_input_is_valid(v_expiry, 'timestamptz') END)
    OR NOT isfinite(v_created_at) THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination');
  END IF;
  IF octet_length(convert_to(public.catalog_publication_canonical(p_outcome, 0), 'UTF8')) > 4096 THEN
    RETURN public.commerce_destination_v2_refusal('binding', 'destination');
  END IF;

  INSERT INTO public.commerce_destination_v2_receipts
    (scoped_key, client_id, dialect, owner_scope, request_key, request_digest, outcome, evidence_disposition, created_at)
  VALUES ((public.commerce_destination_v2_receipt_scoped_key_decision(p_ctx, p_dialect, p_request_key, p_request_digest) #>> '{}'),
    (p_ctx->>'clientId')::uuid, p_dialect, p_ctx->'owner', p_request_key, p_request_digest, p_outcome, 'available', v_created_at)
  ON CONFLICT (scoped_key) DO NOTHING
  RETURNING event_id INTO v_event_id;
  IF NOT FOUND THEN
    RETURN public.commerce_destination_v2_issuance_refusal('insert_collision');
  END IF;
  RETURN jsonb_build_object('kind', 'receipt', 'eventId', v_event_id,
    'outcome', p_outcome, 'evidenceDisposition', 'available');
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_scoped_key(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_dialect = 'subscription.destination.change.v2' THEN
    RETURN public.commerce_destination_v2_receipt_legacy(public.commerce_destination_v2_refusal('kind', 'version')) #>> '{}'; END IF;
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_scoped_key_decision(p_ctx, p_dialect, p_request_key, p_request_digest)) #>> '{}';
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_read(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_dialect = 'subscription.destination.change.v2' THEN
    RETURN public.commerce_destination_v2_receipt_legacy(public.commerce_destination_v2_refusal('kind', 'version')); END IF;
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_read_decision(p_ctx, p_dialect, p_request_key, p_request_digest));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_lock(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_dialect = 'subscription.destination.change.v2' AND current_setting('transaction_isolation') = 'read committed' THEN
    RETURN public.commerce_destination_v2_receipt_legacy(public.commerce_destination_v2_refusal('kind', 'version')); END IF;
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_lock_decision(p_ctx, p_dialect, p_request_key, p_request_digest));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_commit(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text, p_outcome jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_dialect = 'subscription.destination.change.v2' AND current_setting('transaction_isolation') = 'read committed' THEN
    RETURN public.commerce_destination_v2_receipt_legacy(public.commerce_destination_v2_refusal('kind', 'version')); END IF;
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_commit_decision(p_ctx, p_dialect, p_request_key, p_request_digest, p_outcome));
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_validate_projection(v_validated jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_address jsonb;
  v_contact jsonb;
  v_address_fields constant text[] := ARRAY['line1','line2','city','subdivisionCode','postalCode','countryCode'];
  v_contact_fields constant text[] := ARRAY['recipientName','contactEmail','contactPhone','companyName','label','taxId','deliveryNotes','courierInstructions'];
  v_controls constant text := U&'[\0001-\001F\007F-\009F]';
  v_field text;
  v_value text;
  v_item jsonb;
  v_limit integer;
  v_previous text;
BEGIN
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
      SELECT 'validated' AS name WHERE v_validated - ARRAY['policyRef','policyRevision','address','contact','classificationKeys'] <> '{}'::jsonb
      UNION ALL SELECT 'validated.address' WHERE v_address - v_address_fields <> '{}'::jsonb
      UNION ALL SELECT 'validated.contact' WHERE v_contact - v_contact_fields <> '{}'::jsonb
      UNION ALL SELECT key FROM unnest(ARRAY['line1','city','postalCode']) AS keys(key) WHERE NOT v_address ? key
    ) AS invalid ORDER BY name COLLATE "C" LIMIT 1;
  END IF;
  IF v_field IS NOT NULL THEN
    RETURN public.commerce_destination_v2_refusal('input', v_field);
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
      RETURN public.commerce_destination_v2_refusal('input', v_field);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_validated->'classificationKeys') > 32 THEN
    RETURN public.commerce_destination_v2_refusal('input', 'classificationKeys');
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_validated->'classificationKeys')
  LOOP
    v_value := v_item #>> '{}';
    IF jsonb_typeof(v_item) <> 'string' OR length(v_value) > 64 OR v_value COLLATE "C" !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
      OR v_previous COLLATE "C" >= v_value THEN
      RETURN public.commerce_destination_v2_refusal('input', 'classificationKeys');
    END IF;
    v_previous := v_value;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_snapshot_destination_v2(p_ctx jsonb, p_command jsonb, p_now timestamptz)
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
    RETURN public.commerce_destination_v2_refusal('input', 'command');
  END IF;
  IF v_dialect IS DISTINCT FROM 'commerce.destination.snapshot.v2' THEN
    RETURN public.commerce_destination_v2_refusal('kind', 'version');
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
      SELECT 'command' AS name WHERE p_command - ARRAY['dialect','requestKey','requestDigest','purpose','scopeRef','original','validated'] <> '{}'::jsonb
      UNION ALL SELECT 'original' WHERE v_original - ARRAY['address','contact'] <> '{}'::jsonb
      UNION ALL SELECT 'original.address' WHERE (v_original->'address') - v_address_fields <> '{}'::jsonb
      UNION ALL SELECT 'original.contact' WHERE (v_original->'contact') - v_contact_fields <> '{}'::jsonb
      UNION ALL SELECT 'original.address.' || key FROM unnest(ARRAY['line1','city','postalCode','countryCode']) AS keys(key)
        WHERE NOT (v_original->'address') ? key
      UNION ALL SELECT 'original.' || part || '.' || field.key
        FROM (VALUES ('address', v_original->'address'), ('contact', v_original->'contact')) AS section(part, body)
        CROSS JOIN LATERAL jsonb_each(body) AS field
        WHERE field.key = ANY(CASE part WHEN 'address' THEN v_address_fields ELSE v_contact_fields END)
          AND (jsonb_typeof(field.value) <> 'string' OR (field.value #>> '{}') COLLATE "C" ~ v_controls)
    ) AS invalid ORDER BY name COLLATE "C" LIMIT 1;
  END IF;
  IF v_field IS NOT NULL THEN
    RETURN public.commerce_destination_v2_refusal('input', v_field);
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
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  v_client := (p_ctx->>'clientId')::uuid;
  v_scope := (p_ctx->>'scopeRef')::uuid;

  v_request_digest := encode(sha256(convert_to(public.commerce_destination_v2_canonical(jsonb_build_array(
    'commerce.destination.request.v2', jsonb_build_object('dialect', v_dialect, 'owner', v_owner,
      'requestKey', v_key, 'purpose', 'checkout', 'scopeRef', v_scope, 'original', v_original)
  )), 'UTF8')), 'hex');
  IF p_command->>'requestDigest' COLLATE "C" IS DISTINCT FROM v_request_digest THEN
    RETURN public.commerce_destination_v2_issuance_refusal('request_digest');
  END IF;

  -- The receipt owner re-reads after taking the key and shared erasure fence.
  p_ctx := p_ctx - 'scopeRef';
  v_receipt := public.commerce_destination_v2_receipt_lock_decision(p_ctx, v_dialect, v_key, v_request_digest);
  IF v_receipt->>'outcome' = 'refused' THEN RETURN v_receipt; END IF;
  IF v_receipt->>'kind' = 'receipt' THEN
    IF v_receipt->>'evidenceDisposition' = 'erased' THEN
      RETURN jsonb_build_object('evidenceDisposition', 'erased');
    END IF;
    RETURN (v_receipt->'outcome') || jsonb_build_object('eventId', v_receipt->'eventId', 'replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = v_client AND principal_id = (v_owner->>'principalRef')::uuid) THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;

  v_receipt := public.commerce_destination_v2_validate_projection(v_validated);
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;
  v_address := v_validated->'address';
  v_contact := v_validated->'contact';

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

  -- A returned refusal must not commit any of the three issuance effects.
  BEGIN
    INSERT INTO public.commerce_destination_v2_documents
      (snapshot_ref, client_id, owner_scope, scope_ref, purpose, issued_at, evidence_expires_at,
        binding, document_text, document_digest, evidence_disposition)
    VALUES (v_snapshot, v_client, v_owner, v_scope, 'checkout', v_issued, v_cutoff,
      v_binding, v_document, encode(sha256(convert_to(v_document, 'UTF8')), 'hex'), 'available');
    INSERT INTO public.commerce_destination_v2_checkout_selections (owner_scope, scope_ref, selection_revision, snapshot_ref)
    VALUES (v_owner, v_scope, (v_selection->>'selectionRevision')::uuid, v_snapshot)
    ON CONFLICT (owner_scope, scope_ref) DO UPDATE SET
      selection_revision = excluded.selection_revision, snapshot_ref = excluded.snapshot_ref;
    v_receipt := public.commerce_destination_v2_receipt_commit_decision(p_ctx, v_dialect, v_key, v_request_digest,
      jsonb_build_object('binding', v_binding, 'selection', v_selection,
        'evidenceExpiresAt', to_char(v_cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    IF v_receipt->>'outcome' = 'refused' THEN
      RAISE SQLSTATE 'PZ001' USING MESSAGE = 'Roll back refused destination issuance';
    END IF;
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN
    IF v_receipt->>'outcome' IS DISTINCT FROM 'refused' THEN RAISE; END IF;
    RETURN v_receipt;
  END;
  RETURN (v_receipt->'outcome') || jsonb_build_object('eventId', v_receipt->'eventId', 'replayed', false);
END;
$$;

CREATE FUNCTION public.subscription_destination_v2_origins(p_id uuid)
RETURNS public.subscription_activations[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY(SELECT a FROM public.subscription_activations a WHERE a.subscription_id = p_id AND a.state = 'active' LIMIT 2);
$$;

CREATE FUNCTION public.subscription_destination_v2_service_valid(p_service jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_service) = 'object' THEN p_service - keys = '{}'::jsonb AND
    (SELECT bool_and(coalesce(jsonb_typeof(p_service->key) = 'string' AND
      char_length(p_service->>key) BETWEEN 1 AND 256, false)) FROM unnest(keys) AS key) ELSE false END
  FROM (VALUES (ARRAY['deliverySelectionRef','providerRef','carrierRef','serviceRef','servicePolicyRevision','adapterRevision'])) AS pin(keys);
$$;

CREATE FUNCTION public.subscription_destination_v2_current(p_ctx jsonb, p_id uuid, p_origins public.subscription_activations[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_client uuid := (p_ctx->>'clientId')::uuid;
  v_side public.subscription_destination_v2_selections;
  v_doc public.commerce_destination_v2_documents;
  v_bound public.commerce_destination_v2_order_bindings;
  v_result jsonb;
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
    RETURN public.commerce_destination_v2_refusal('stored_binding', 'destination');
  END IF;
  IF (p_origins[1]).client_id IS DISTINCT FROM v_client OR NOT EXISTS (
    SELECT 1 FROM public.commerce_orders WHERE id = (p_origins[1]).order_id AND client_id = v_client
  ) THEN
    RETURN public.commerce_destination_v2_refusal('unavailable', 'subscriptionId');
  END IF;
  SELECT * INTO v_bound FROM public.commerce_destination_v2_order_bindings WHERE order_id = (p_origins[1]).order_id;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  SELECT d.scope_ref INTO v_doc.scope_ref FROM public.commerce_destination_v2_documents d WHERE d.snapshot_ref = v_bound.snapshot_ref;
  IF v_doc.scope_ref IS NULL THEN RETURN public.commerce_destination_v2_refusal('unavailable', 'subscriptionId'); END IF;
  v_result := public.commerce_destination_v2_check_retained(
    p_ctx || jsonb_build_object('scopeRef', v_doc.scope_ref), v_bound, 'subscriptionId');
  IF v_result ? 'outcome' THEN RETURN v_result; END IF;
  RETURN jsonb_build_object('binding', v_result->'binding', 'selectionRevision', v_bound.selection->'selectionRevision', 'service', v_bound.service);
EXCEPTION WHEN numeric_value_out_of_range THEN
  RETURN public.commerce_destination_v2_refusal('stored_binding', 'destination');
END;
$$;

CREATE FUNCTION public.subscription_destination_v2_current(p_ctx jsonb, p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.subscription_destination_v2_current(p_ctx, p_id, public.subscription_destination_v2_origins(p_id));
$$;

CREATE FUNCTION public.subscription_destination_v2_refusal(p_case text, p_field text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('outcome','refused','code',code,'field',p_field,'observed',observed,'cause',cause,'fix',fix,'recheck',recheck)
  FROM (VALUES
    ('ineligible','destination_subscription_ineligible','The subscription is outside active or paused status.',
      'A future destination requires an eligible subscription.','Resolve subscription eligibility with the subscription owner.','Recheck status before editing.'),
    ('payment','payment_blocked','The next cycle is locked.','Payment or renewal owns the next cycle.',
      'Wait for the locked cycle to resolve.','Reread eligibility and retry the edit.')
  ) AS refusals(name,code,observed,cause,fix,recheck) WHERE name = p_case;
$$;

CREATE FUNCTION public.subscription_change_shipping_destination_v2(p_ctx jsonb, p_command jsonb, p_now timestamptz)
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
  v_origins public.subscription_activations[];
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
    WHEN p_command->'expectedSelectionRevision' IS DISTINCT FROM 'null'::jsonb AND
      NOT public.commerce_destination_v2_is_uuid(p_command->'expectedSelectionRevision') THEN 'expectedSelectionRevision'
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
    v_origins := public.subscription_destination_v2_origins(v_id);
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
    v_result := public.subscription_destination_v2_current(p_ctx, v_id, v_origins);
    IF v_result ? 'outcome' THEN RETURN v_result; END IF;
    PERFORM 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = (v_result#>>'{binding,snapshotRef}')::uuid FOR SHARE;
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
    SELECT snapshot_ref, client_id, issued_at, purpose, evidence_disposition, scope_ref, document_digest, evidence_expires_at,
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
        public.commerce_destination_v2_valid_pins(b.selection, b.service, v.scope_ref), false) AS valid) pin
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

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_erase(p_client_id uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE = '22023',
      DETAIL = 'isolation', HINT = 'Roll back and restart in READ COMMITTED.';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE;
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
  UPDATE public.commerce_destination_v2_order_bindings b SET selection = NULL, service = NULL
    WHERE b.selection IS NOT NULL AND (
      b.snapshot_ref IN (SELECT snapshot_ref FROM public.commerce_destination_v2_documents WHERE client_id = p_client_id)
      OR b.order_id IN (SELECT id FROM public.commerce_orders WHERE client_id = p_client_id));
  UPDATE public.subscription_destination_v2_selections s SET selection_revision = NULL, service = NULL
    WHERE s.selection_revision IS NOT NULL AND (
      s.snapshot_ref IN (SELECT snapshot_ref FROM public.commerce_destination_v2_documents WHERE client_id = p_client_id)
      OR s.subscription_id IN (SELECT id FROM public.subscriptions WHERE client_id = p_client_id));
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
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE = '22023',
      DETAIL = 'isolation', HINT = 'Roll back and restart in READ COMMITTED.';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  v_batch_time := clock_timestamp();
  -- Take subject locks in a common order across batches. Issue also takes the subject before the selection.
  FOR v_candidate IN SELECT * FROM (
    SELECT snapshot_ref, client_id, owner_scope, scope_ref FROM public.commerce_destination_v2_documents
    WHERE evidence_disposition = 'available' AND evidence_expires_at <= v_batch_time
      AND NOT EXISTS (SELECT 1 FROM public.commerce_destination_v2_order_bindings b WHERE b.snapshot_ref = commerce_destination_v2_documents.snapshot_ref)
      AND NOT EXISTS (SELECT 1 FROM public.subscription_destination_v2_selections s WHERE s.snapshot_ref = commerce_destination_v2_documents.snapshot_ref)
    ORDER BY evidence_expires_at, snapshot_ref LIMIT p_limit
  ) AS candidates ORDER BY client_id, snapshot_ref
  LOOP
    PERFORM 1 FROM public.clients WHERE id = v_candidate.client_id FOR UPDATE;
    PERFORM 1 FROM public.commerce_destination_v2_checkout_selections
      WHERE owner_scope = v_candidate.owner_scope AND scope_ref = v_candidate.scope_ref FOR UPDATE;
    PERFORM 1 FROM public.subscription_destination_v2_selections WHERE snapshot_ref = v_candidate.snapshot_ref FOR UPDATE;
    PERFORM 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = v_candidate.snapshot_ref FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.commerce_destination_v2_documents WHERE snapshot_ref = v_candidate.snapshot_ref
      AND evidence_disposition = 'available' AND evidence_expires_at <= clock_timestamp()) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.commerce_destination_v2_order_bindings b
      WHERE b.snapshot_ref = v_candidate.snapshot_ref) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.subscription_destination_v2_selections s
      WHERE s.snapshot_ref = v_candidate.snapshot_ref) THEN CONTINUE; END IF;
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

REVOKE ALL ON FUNCTION public.commerce_destination_v2_validate_projection(jsonb), public.subscription_destination_v2_origins(uuid), public.subscription_destination_v2_service_valid(jsonb),
  public.subscription_destination_v2_current(jsonb,uuid,public.subscription_activations[]), public.subscription_destination_v2_current(jsonb,uuid),
  public.subscription_destination_v2_refusal(text,text), public.subscription_change_shipping_destination_v2(jsonb,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_destination_v2_selections FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_validate_projection(jsonb), public.subscription_destination_v2_origins(uuid), public.subscription_destination_v2_service_valid(jsonb),
  public.subscription_destination_v2_current(jsonb,uuid,public.subscription_activations[]), public.subscription_destination_v2_current(jsonb,uuid),
  public.subscription_destination_v2_refusal(text,text), public.subscription_change_shipping_destination_v2(jsonb,jsonb,timestamptz) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_destination_v2_selections FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_validate_projection(jsonb), public.subscription_destination_v2_origins(uuid), public.subscription_destination_v2_service_valid(jsonb),
  public.subscription_destination_v2_current(jsonb,uuid,public.subscription_activations[]), public.subscription_destination_v2_current(jsonb,uuid),
  public.subscription_destination_v2_refusal(text,text), public.subscription_change_shipping_destination_v2(jsonb,jsonb,timestamptz) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_destination_v2_selections FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_validate_projection(jsonb), public.subscription_destination_v2_origins(uuid), public.subscription_destination_v2_service_valid(jsonb),
  public.subscription_destination_v2_current(jsonb,uuid,public.subscription_activations[]), public.subscription_destination_v2_current(jsonb,uuid),
  public.subscription_destination_v2_refusal(text,text), public.subscription_change_shipping_destination_v2(jsonb,jsonb,timestamptz) FROM service_role;';
END IF; END; $$;
