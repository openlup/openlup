-- The issuance owner describes only the trigger visible to each branch.
CREATE FUNCTION public.commerce_destination_v2_issuance_refusal(p_case text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('outcome', 'refused', 'code', 'destination_idempotency_conflict', 'field', 'idempotencyKey',
    'observed', observed, 'cause', 'A scoped issuance key must identify one consistent original command and receipt.',
    'fix', 'Replay the original command or begin a distinct action.', 'recheck', 'Use original inputs or a distinct action key.')
  FROM (VALUES
    ('request_digest', 'The supplied request digest disagrees with the original command.'),
    ('receipt_digest', 'The receipt records a different original command.'),
    ('existing_receipt', 'A receipt already exists for the same scoped key.'),
    ('insert_collision', 'The scoped receipt key was occupied during commit.')
  ) AS conflicts(name, observed) WHERE name = p_case
  UNION ALL SELECT jsonb_build_object('outcome', 'refused', 'code', 'destination_isolation_unsupported', 'field', 'isolation',
    'observed', 'The transaction mode is unsupported.', 'cause', 'Destination issuance requires read committed.',
    'fix', 'Roll back and restart in the required transaction mode.', 'recheck', 'Use a read committed writer.')
    WHERE p_case = 'isolation'
  UNION ALL SELECT jsonb_build_object('outcome', 'refused', 'code', 'destination_evidence_erased', 'field', 'owner',
    'observed', 'The privacy ledger records erasure.', 'cause', 'The receipt owner cannot issue evidence for an erased owner.',
    'fix', 'Review the privacy disposition.', 'recheck', 'Verify the authorized privacy receipt and begin a fresh selection where available.')
    WHERE p_case = 'erased';
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_legacy(p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_code text := p_result->>'code';
BEGIN
  IF p_result->>'outcome' IS DISTINCT FROM 'refused' THEN RETURN p_result; END IF;
  IF v_code = 'destination_isolation_unsupported' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE = '22023';
  END IF;
  RAISE EXCEPTION USING MESSAGE = v_code,
    DETAIL = CASE WHEN v_code = 'address_invalid_input' AND p_result->>'field' = 'requestKey'
      THEN 'idempotencyKey' ELSE p_result->>'field' END,
    ERRCODE = CASE v_code WHEN 'destination_idempotency_conflict' THEN '23505'
      WHEN 'destination_evidence_erased' THEN '55000' ELSE '22023' END,
    HINT = CASE WHEN v_code IN ('address_invalid_input', 'destination_binding_invalid')
      THEN 'Correct caller-authored input or re-obtain authoritative evidence as applicable.'
      WHEN v_code = 'destination_evidence_erased'
      THEN 'Re-obtain evidence through the authenticated owner or review the privacy disposition.'
      ELSE p_result->>'fix' END;
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_scoped_key_decision(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner jsonb := p_ctx->'owner';
  v_ref text;
  v_controls CONSTANT text := U&'[\0001-\001F\007F-\009F]';
  v_whitespace CONSTANT text := U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_dialect IS DISTINCT FROM 'commerce.destination.snapshot.v2' THEN
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

CREATE FUNCTION public.commerce_destination_v2_receipt_read_decision(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key jsonb := public.commerce_destination_v2_receipt_scoped_key_decision(p_ctx, p_dialect, p_request_key, p_request_digest);
  v_receipt public.commerce_destination_v2_receipts%ROWTYPE;
BEGIN
  IF v_key ? 'outcome' THEN RETURN v_key; END IF;
  SELECT * INTO v_receipt FROM public.commerce_destination_v2_receipts
    WHERE scoped_key = (v_key #>> '{}') AND client_id = (p_ctx->>'clientId')::uuid;
  IF NOT FOUND OR (v_receipt.evidence_disposition = 'available'
    AND (v_receipt.owner_scope <> p_ctx->'owner' OR v_receipt.dialect <> p_dialect
      OR v_receipt.request_key COLLATE "C" <> p_request_key)) THEN
    RETURN '{"kind":"absent"}'::jsonb;
  END IF;
  IF v_receipt.request_digest COLLATE "C" <> p_request_digest THEN
    RETURN public.commerce_destination_v2_issuance_refusal('receipt_digest');
  END IF;
  RETURN jsonb_build_object('kind', 'receipt', 'eventId', v_receipt.event_id,
    'outcome', v_receipt.outcome, 'evidenceDisposition', v_receipt.evidence_disposition);
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_lock_decision(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key jsonb;
  v_client_id uuid;
  v_metadata jsonb;
  v_receipt jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN public.commerce_destination_v2_issuance_refusal('isolation');
  END IF;
  v_key := public.commerce_destination_v2_receipt_scoped_key_decision(p_ctx, p_dialect, p_request_key, p_request_digest);
  IF v_key ? 'outcome' THEN RETURN v_key; END IF;
  v_client_id := (p_ctx->>'clientId')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce.destination.receipt.v2:' || (v_key #>> '{}'), 0));
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  -- Volatile routine: this statement sees commits that became visible while waiting.
  v_receipt := public.commerce_destination_v2_receipt_read_decision(p_ctx, p_dialect, p_request_key, p_request_digest);
  IF v_receipt->>'outcome' = 'refused' OR v_receipt->>'kind' = 'receipt' THEN RETURN v_receipt; END IF;

  SELECT metadata INTO v_metadata FROM public.clients WHERE id = v_client_id FOR UPDATE;
  IF NOT FOUND OR v_metadata ? 'absorption' THEN
    RETURN public.commerce_destination_v2_refusal('owner', 'owner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.identity_privacy_erasures WHERE client_id = v_client_id) THEN
    RETURN public.commerce_destination_v2_issuance_refusal('erased');
  END IF;
  RETURN v_receipt;
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_commit_decision(
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
    OR v_selection->'kind' IS DISTINCT FROM '"checkout"'::jsonb
    OR jsonb_typeof(v_selection->'scopeRef') IS DISTINCT FROM 'string'
    OR (v_selection->>'scopeRef') COLLATE "C" !~ v_uuid_pattern
    OR jsonb_typeof(v_selection->'selectionRevision') IS DISTINCT FROM 'string'
    OR (v_selection->>'selectionRevision') COLLATE "C" !~ v_uuid_pattern
    OR jsonb_typeof(p_outcome->'evidenceExpiresAt') IS DISTINCT FROM 'string'
    OR v_expiry COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    OR NOT pg_input_is_valid(v_expiry, 'timestamptz')
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
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_scoped_key_decision(p_ctx, p_dialect, p_request_key, p_request_digest)) #>> '{}';
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_read(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_read_decision(p_ctx, p_dialect, p_request_key, p_request_digest));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_lock(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_lock_decision(p_ctx, p_dialect, p_request_key, p_request_digest));
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_destination_v2_receipt_commit(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text, p_outcome jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN public.commerce_destination_v2_receipt_legacy(
    public.commerce_destination_v2_receipt_commit_decision(p_ctx, p_dialect, p_request_key, p_request_digest, p_outcome));
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

CREATE OR REPLACE FUNCTION public.commerce_read_destination_v2(p_ctx jsonb, p_kind text, p_id uuid, p_expected_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.commerce_destination_v2_documents%ROWTYPE;
  v_verification jsonb;
  v_binding_fields constant text[] := ARRAY['snapshotRef','schemaVersion','destinationDigest','policyRevision'];
  v_binding_cause constant jsonb := '{"cause":"A snapshot read requires the exact binding for the requested snapshot."}';
BEGIN
  IF p_kind IN ('order', 'shipment') THEN
    RETURN public.commerce_destination_v2_read_retained(p_ctx, p_kind, p_id, p_expected_binding);
  END IF;
  IF p_kind IS DISTINCT FROM 'snapshot' THEN
    RETURN public.commerce_destination_v2_refusal('kind', 'version');
  END IF;
  SELECT * INTO v_row FROM public.commerce_destination_v2_documents
    WHERE snapshot_ref = p_id AND to_jsonb(client_id) = p_ctx->'clientId'
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

REVOKE ALL ON FUNCTION public.commerce_destination_v2_issuance_refusal(text),
  public.commerce_destination_v2_receipt_legacy(jsonb),
  public.commerce_destination_v2_receipt_scoped_key_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_read_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_lock_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_commit_decision(jsonb,text,text,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_issuance_refusal(text),
  public.commerce_destination_v2_receipt_legacy(jsonb),
  public.commerce_destination_v2_receipt_scoped_key_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_read_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_lock_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_commit_decision(jsonb,text,text,text,jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_issuance_refusal(text),
  public.commerce_destination_v2_receipt_legacy(jsonb),
  public.commerce_destination_v2_receipt_scoped_key_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_read_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_lock_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_commit_decision(jsonb,text,text,text,jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_issuance_refusal(text),
  public.commerce_destination_v2_receipt_legacy(jsonb),
  public.commerce_destination_v2_receipt_scoped_key_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_read_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_lock_decision(jsonb,text,text,text),
  public.commerce_destination_v2_receipt_commit_decision(jsonb,text,text,text,jsonb) FROM service_role;';
END IF; END; $$;
