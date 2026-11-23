-- Private success and audit evidence. Erasure preserves the replay identity.
CREATE TABLE public.commerce_destination_v2_receipts (
  scoped_key text PRIMARY KEY CHECK (
    length(scoped_key) = 64 AND translate(scoped_key,
      '0123456789abcdef', '') = ''),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  dialect text,
  owner_scope jsonb CHECK (jsonb_typeof(owner_scope) = 'object'),
  request_key text CHECK (octet_length(request_key) BETWEEN 8 AND 180),
  request_digest text NOT NULL CHECK (length(request_digest) = 64 AND translate(request_digest, '0123456789abcdef', '') = ''),
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_schema_version smallint NOT NULL DEFAULT 1 CHECK (event_schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome jsonb CHECK (jsonb_typeof(outcome) = 'object'),
  evidence_disposition text NOT NULL CHECK (
    (evidence_disposition = 'available' AND dialect IS NOT NULL AND owner_scope IS NOT NULL
      AND request_key IS NOT NULL AND outcome IS NOT NULL)
    OR (evidence_disposition = 'erased' AND dialect IS NULL AND owner_scope IS NULL
      AND request_key IS NULL AND outcome IS NULL))
);
CREATE INDEX commerce_destination_v2_receipts_client_id_idx ON public.commerce_destination_v2_receipts (client_id);
ALTER TABLE public.commerce_destination_v2_receipts ENABLE ROW LEVEL SECURITY;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('commerce_destination_v2_receipts', 'block', 'Destination receipt history prevents lead absorption.');

CREATE FUNCTION public.commerce_destination_v2_receipt_scoped_key(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner jsonb := p_ctx->'owner';
  v_ref text;
  v_controls CONSTANT text := U&'[\0001-\001F\007F-\009F]';
  v_whitespace CONSTANT text := U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_dialect IS DISTINCT FROM 'commerce.destination.snapshot.v2' THEN
    RAISE EXCEPTION 'destination_dialect_invalid' USING ERRCODE = '22023',
      DETAIL = 'version', HINT = 'Use the supported entry.';
  END IF;

  IF jsonb_typeof(p_ctx) IS DISTINCT FROM 'object'
    OR p_ctx - ARRAY['owner', 'clientId'] <> '{}'::jsonb
    OR jsonb_typeof(p_ctx->'clientId') IS DISTINCT FROM 'string'
    OR NOT pg_input_is_valid(p_ctx->>'clientId', 'uuid')
    OR jsonb_typeof(v_owner) IS DISTINCT FROM 'object'
    OR v_owner - ARRAY['installationRef', 'principalKind', 'principalRef', 'customerOrSessionRef'] <> '{}'::jsonb
    OR jsonb_typeof(v_owner->'principalKind') IS DISTINCT FROM 'string'
    OR v_owner->>'principalKind' NOT IN ('customer', 'checkout_session') THEN
    RAISE EXCEPTION 'destination_owner_unlinked' USING ERRCODE = '22023',
      DETAIL = 'owner', HINT = 'Establish authorized linkage or use authorized support.';
  END IF;
  FOREACH v_ref IN ARRAY ARRAY['installationRef', 'principalRef', 'customerOrSessionRef'] LOOP
    IF jsonb_typeof(v_owner->v_ref) IS DISTINCT FROM 'string'
      OR octet_length(convert_to(v_owner->>v_ref, 'UTF8')) NOT BETWEEN 1 AND 200
      OR btrim(v_owner->>v_ref, v_whitespace) = ''
      OR (v_owner->>v_ref) COLLATE "C" ~ v_controls THEN
      RAISE EXCEPTION 'destination_owner_unlinked' USING ERRCODE = '22023',
        DETAIL = 'owner', HINT = 'Establish authorized linkage or use authorized support.';
    END IF;
  END LOOP;

  IF p_request_key IS NULL OR octet_length(convert_to(p_request_key, 'UTF8')) NOT BETWEEN 8 AND 180
    OR p_request_key COLLATE "C" ~ v_controls OR btrim(p_request_key, v_whitespace) <> p_request_key THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = 'idempotencyKey', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  IF p_request_digest IS NULL OR p_request_digest COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'address_invalid_input' USING ERRCODE = '22023',
      DETAIL = 'requestDigest', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;

  RETURN encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(
    'commerce.destination.key.v2', jsonb_build_object('dialect', p_dialect, 'owner', v_owner, 'requestKey', p_request_key)
  ), 0), 'UTF8')), 'hex');
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_read(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text := public.commerce_destination_v2_receipt_scoped_key(p_ctx, p_dialect, p_request_key, p_request_digest);
  v_receipt public.commerce_destination_v2_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt FROM public.commerce_destination_v2_receipts
    WHERE scoped_key = v_key AND client_id = (p_ctx->>'clientId')::uuid;
  IF NOT FOUND OR (v_receipt.evidence_disposition = 'available'
    AND (v_receipt.owner_scope <> p_ctx->'owner' OR v_receipt.dialect <> p_dialect
      OR v_receipt.request_key COLLATE "C" <> p_request_key)) THEN
    RETURN '{"kind":"absent"}'::jsonb;
  END IF;
  IF v_receipt.request_digest COLLATE "C" <> p_request_digest THEN
    RAISE EXCEPTION 'destination_idempotency_conflict' USING ERRCODE = '23505',
      DETAIL = 'idempotencyKey', HINT = 'Replay the original command or begin a distinct action.';
  END IF;
  RETURN jsonb_build_object('kind', 'receipt', 'eventId', v_receipt.event_id,
    'outcome', v_receipt.outcome, 'evidenceDisposition', v_receipt.evidence_disposition);
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_lock(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_client_id uuid;
  v_metadata jsonb;
  v_receipt jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_busy' USING ERRCODE = '22023',
      DETAIL = 'idempotencyKey', HINT = 'Wait for cycle eligibility, reread and retry the scoped action, or resolve the existing binding without moving it.';
  END IF;
  v_key := public.commerce_destination_v2_receipt_scoped_key(p_ctx, p_dialect, p_request_key, p_request_digest);
  v_client_id := (p_ctx->>'clientId')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce.destination.receipt.v2:' || v_key, 0));
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  -- Volatile routine: this statement sees commits that became visible while waiting.
  v_receipt := public.commerce_destination_v2_receipt_read(p_ctx, p_dialect, p_request_key, p_request_digest);
  IF v_receipt->>'kind' = 'receipt' THEN RETURN v_receipt; END IF;

  SELECT metadata INTO v_metadata FROM public.clients WHERE id = v_client_id FOR UPDATE;
  IF NOT FOUND OR v_metadata ? 'absorption' THEN
    RAISE EXCEPTION 'destination_owner_unlinked' USING ERRCODE = '22023',
      DETAIL = 'owner', HINT = 'Establish authorized linkage or use authorized support.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.identity_privacy_erasures WHERE client_id = v_client_id) THEN
    RAISE EXCEPTION 'destination_evidence_erased' USING ERRCODE = '55000',
      DETAIL = 'owner', HINT = 'Re-obtain evidence through the authenticated owner or review the privacy disposition.';
  END IF;
  RETURN v_receipt;
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipt_commit(
  p_ctx jsonb, p_dialect text, p_request_key text, p_request_digest text, p_outcome jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_slot jsonb := public.commerce_destination_v2_receipt_lock(p_ctx, p_dialect, p_request_key, p_request_digest);
  v_binding jsonb := p_outcome->'binding';
  v_selection jsonb := p_outcome->'selection';
  v_expiry text := p_outcome->>'evidenceExpiresAt';
  v_event_id uuid;
  v_created_at timestamptz := clock_timestamp();
BEGIN
  IF v_slot->>'kind' <> 'absent' THEN
    RAISE EXCEPTION 'destination_idempotency_conflict' USING ERRCODE = '23505',
      DETAIL = 'idempotencyKey', HINT = 'Replay the original command or begin a distinct action.';
  END IF;

  -- The effect owner supplies only its closed success projection.
  IF jsonb_typeof(p_outcome) IS DISTINCT FROM 'object'
    OR p_outcome - ARRAY['binding', 'selection', 'evidenceExpiresAt'] <> '{}'::jsonb
    OR jsonb_typeof(v_binding) IS DISTINCT FROM 'object'
    OR v_binding - ARRAY['snapshotRef', 'schemaVersion', 'destinationDigest', 'policyRevision'] <> '{}'::jsonb
    OR v_binding->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(v_binding->'snapshotRef') IS DISTINCT FROM 'string'
    OR NOT pg_input_is_valid(v_binding->>'snapshotRef', 'uuid')
    OR jsonb_typeof(v_binding->'destinationDigest') IS DISTINCT FROM 'string'
    OR (v_binding->>'destinationDigest') COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(v_binding->'policyRevision') IS DISTINCT FROM 'string'
    OR (v_binding->>'policyRevision') COLLATE "C" ~ U&'[\0001-\001F\007F-\009F]'
    OR (v_binding->>'policyRevision') !~ '[^[:space:]]'
    OR jsonb_typeof(v_selection) IS DISTINCT FROM 'object'
    OR v_selection - ARRAY['kind', 'scopeRef', 'selectionRevision'] <> '{}'::jsonb
    OR v_selection->'kind' IS DISTINCT FROM '"checkout"'::jsonb
    OR jsonb_typeof(v_selection->'scopeRef') IS DISTINCT FROM 'string'
    OR NOT pg_input_is_valid(v_selection->>'scopeRef', 'uuid')
    OR jsonb_typeof(v_selection->'selectionRevision') IS DISTINCT FROM 'string'
    OR NOT pg_input_is_valid(v_selection->>'selectionRevision', 'uuid')
    OR jsonb_typeof(p_outcome->'evidenceExpiresAt') IS DISTINCT FROM 'string'
    OR v_expiry COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$'
    OR NOT pg_input_is_valid(v_expiry, 'timestamptz')
    OR NOT isfinite(v_created_at) THEN
    RAISE EXCEPTION 'destination_binding_invalid' USING ERRCODE = '22023',
      DETAIL = 'destination', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;
  IF octet_length(convert_to(public.catalog_publication_canonical(p_outcome, 0), 'UTF8')) > 4096 THEN
    RAISE EXCEPTION 'destination_binding_invalid' USING ERRCODE = '22023',
      DETAIL = 'destination', HINT = 'Correct caller-authored input or re-obtain authoritative evidence as applicable.';
  END IF;

  INSERT INTO public.commerce_destination_v2_receipts
    (scoped_key, client_id, dialect, owner_scope, request_key, request_digest, outcome, evidence_disposition, created_at)
  VALUES (public.commerce_destination_v2_receipt_scoped_key(p_ctx, p_dialect, p_request_key, p_request_digest),
    (p_ctx->>'clientId')::uuid, p_dialect, p_ctx->'owner', p_request_key, p_request_digest, p_outcome, 'available', v_created_at)
  ON CONFLICT (scoped_key) DO NOTHING
  RETURNING event_id INTO v_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_idempotency_conflict' USING ERRCODE = '23505',
      DETAIL = 'idempotencyKey', HINT = 'Replay the original command or begin a distinct action.';
  END IF;
  RETURN jsonb_build_object('kind', 'receipt', 'eventId', v_event_id,
    'outcome', p_outcome, 'evidenceDisposition', 'available');
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipts_erase(p_client_id uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  -- The privacy transaction already holds the erasure-ledger fence.
  PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
  UPDATE public.commerce_destination_v2_receipts SET
    dialect = NULL, owner_scope = NULL, request_key = NULL, outcome = NULL, evidence_disposition = 'erased'
  WHERE client_id = p_client_id AND evidence_disposition = 'available';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.commerce_destination_v2_receipts_export(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN (
    SELECT coalesce(jsonb_agg(
      jsonb_build_object('eventId', event_id, 'eventSchemaVersion', event_schema_version,
        'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'evidenceDisposition', evidence_disposition)
      || CASE WHEN evidence_disposition = 'available' THEN
        jsonb_build_object('owner', owner_scope, 'dialect', dialect, 'requestKey', request_key,
          'requestDigest', request_digest, 'outcome', outcome)
      ELSE '{}'::jsonb END ORDER BY event_id), '[]'::jsonb)
    FROM public.commerce_destination_v2_receipts WHERE client_id = p_client_id);
END;
$$;

REVOKE ALL ON TABLE public.commerce_destination_v2_receipts FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_receipts FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_receipts FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_destination_v2_receipts FROM service_role;'; END IF; END; $$;

REVOKE ALL ON FUNCTION public.commerce_destination_v2_receipt_scoped_key(jsonb,text,text,text), public.commerce_destination_v2_receipt_read(jsonb,text,text,text), public.commerce_destination_v2_receipt_lock(jsonb,text,text,text), public.commerce_destination_v2_receipt_commit(jsonb,text,text,text,jsonb), public.commerce_destination_v2_receipts_erase(uuid), public.commerce_destination_v2_receipts_export(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_receipt_scoped_key(jsonb,text,text,text), public.commerce_destination_v2_receipt_read(jsonb,text,text,text), public.commerce_destination_v2_receipt_lock(jsonb,text,text,text), public.commerce_destination_v2_receipt_commit(jsonb,text,text,text,jsonb), public.commerce_destination_v2_receipts_erase(uuid), public.commerce_destination_v2_receipts_export(uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_receipt_scoped_key(jsonb,text,text,text), public.commerce_destination_v2_receipt_read(jsonb,text,text,text), public.commerce_destination_v2_receipt_lock(jsonb,text,text,text), public.commerce_destination_v2_receipt_commit(jsonb,text,text,text,jsonb), public.commerce_destination_v2_receipts_erase(uuid), public.commerce_destination_v2_receipts_export(uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_destination_v2_receipt_scoped_key(jsonb,text,text,text), public.commerce_destination_v2_receipt_read(jsonb,text,text,text), public.commerce_destination_v2_receipt_lock(jsonb,text,text,text), public.commerce_destination_v2_receipt_commit(jsonb,text,text,text,jsonb), public.commerce_destination_v2_receipts_erase(uuid), public.commerce_destination_v2_receipts_export(uuid) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_destination_v2_receipt_read(jsonb,text,text,text), public.commerce_destination_v2_receipts_erase(uuid), public.commerce_destination_v2_receipts_export(uuid) TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT SELECT (client_id) ON TABLE public.commerce_destination_v2_receipts TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'CREATE POLICY commerce_destination_v2_receipts_absorption_census ON public.commerce_destination_v2_receipts FOR SELECT TO service_role USING (true);';
END IF; END; $$;
