-- Only the erasure definer creates marks. The deferred trigger consumes them
-- before commit, so there is no marker history to transfer or reconcile.
CREATE TABLE public.commerce_order_draft_receipt_erasure_marks (
  transaction_id xid8 NOT NULL,
  order_id uuid NOT NULL,
  prior_erasure_id uuid,
  PRIMARY KEY (transaction_id, order_id)
);
ALTER TABLE public.commerce_order_draft_receipt_erasure_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_order_draft_receipt_erasure_marks FROM PUBLIC;

-- Validate ledger evidence and consume a private mark during deferred checking.
-- A direct call cannot attest a clear or create authority for a later trigger.
CREATE FUNCTION public.commerce_order_draft_receipt_v2_consume_erasure_mark(
  p_order_id uuid, p_contact uuid, p_principal uuid
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prior_id uuid;
BEGIN
  IF pg_trigger_depth() = 0 THEN RETURN false; END IF;
  DELETE FROM public.commerce_order_draft_receipt_erasure_marks
  WHERE transaction_id = pg_current_xact_id() AND order_id = p_order_id
  RETURNING prior_erasure_id INTO prior_id;

  RETURN FOUND AND (
    (prior_id IS NULL AND EXISTS (
      SELECT FROM public.identity_privacy_erasures e
      WHERE (e.client_id = p_contact OR e.principal_id = p_principal)
        AND (e.client_id IS NULL OR e.client_id = p_contact)
        AND (e.principal_id IS NULL OR e.principal_id = p_principal)
        AND e.contributor_versions->>'order-draft-receipts' = 'commerce.order-draft-receipts.v1'
        AND e.dispositions @> '[{"contributorId":"order-draft-receipts","version":"commerce.order-draft-receipts.v1","obligations":[
          {"owner":"order-draft-receipts","resource":"commerce.order-draft-receipt-owner-references","disposition":"erase","reasonCode":"RECEIPT_OWNER_REFERENCES_CLEARED","remote":false},
          {"owner":"order-draft-receipts","resource":"commerce.order-draft-receipt-retained-facts","disposition":"retain","reasonCode":"ORDER_REFERENCE_AND_DERIVED_REPLAY_KEY_RETAINED","remote":false}]}]'::jsonb
    )) OR (prior_id IS NOT NULL AND EXISTS (
      SELECT FROM public.identity_privacy_erasure_reconciliations
      WHERE erasure_id = prior_id AND contributor_id = 'order-draft-receipts'
    ))
  );
END;
$$;

CREATE FUNCTION public.commerce_order_draft_receipt_v2_erasure_check() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF public.commerce_order_draft_receipt_v2_consume_erasure_mark(OLD.order_id, OLD.customer_or_session_ref, OLD.principal_ref)
  THEN RETURN NULL;
  END IF;
  RAISE EXCEPTION 'order_draft_receipt_immutable' USING ERRCODE = '55000',
    HINT = 'Read through the receipt lookup or use the authorized privacy operation to erase owner references.';
END;
$$;

CREATE FUNCTION public.commerce_order_draft_receipt_privacy_matches_v2(p_contact uuid, p_principal uuid, p_erasure_id uuid)
RETURNS TABLE(order_id uuid, installation_ref text, principal_kind text, created_at timestamptz,
  principal_ref uuid, customer_ref uuid, exportable boolean, principal_unavailable boolean, erasable boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.order_id, r.installation_ref, r.principal_kind, r.created_at,
    CASE WHEN p_principal IS NOT NULL AND v.paired THEN r.principal_ref END,
    CASE WHEN p_contact IS NOT NULL THEN r.customer_or_session_ref END,
    v.agrees AND (p_contact IS NOT NULL OR v.paired),
    v.agrees AND p_contact IS NOT NULL AND NOT v.paired,
    v.agrees AND CASE WHEN p_erasure_id IS NULL THEN v.paired AND ce.erasure_id IS NULL AND pe.erasure_id IS NULL
      ELSE (ce.erasure_id = p_erasure_id OR pe.erasure_id = p_erasure_id)
        AND (ce.erasure_id IS NULL OR ce.erasure_id = p_erasure_id)
        AND (pe.erasure_id IS NULL OR pe.erasure_id = p_erasure_id) END
  FROM public.commerce_order_draft_receipts_v2 r
  LEFT JOIN public.commerce_orders o ON o.id = r.order_id
  LEFT JOIN public.clients c ON c.id = r.customer_or_session_ref
  LEFT JOIN public.clients p ON p.principal_id = r.principal_ref
  LEFT JOIN public.identity_privacy_erasures ce ON ce.client_id = r.customer_or_session_ref
  LEFT JOIN public.identity_privacy_erasures pe ON pe.principal_id = r.principal_ref
  CROSS JOIN LATERAL (SELECT
    coalesce(o.client_id = c.id, false) AND (p_contact IS NULL OR r.customer_or_session_ref = p_contact)
      AND (p_principal IS NULL OR r.principal_ref = p_principal)
      AND (c.principal_id IS NULL OR c.principal_id = r.principal_ref)
      AND (p.id IS NULL OR p.id = r.customer_or_session_ref)
      AND (ce.principal_id IS NULL OR ce.principal_id = r.principal_ref)
      AND (pe.client_id IS NULL OR pe.client_id = r.customer_or_session_ref) AS agrees,
    coalesce(c.principal_id = r.principal_ref, false) AS paired) v
  WHERE (p_contact IS NOT NULL AND r.customer_or_session_ref = p_contact)
    OR (p_principal IS NOT NULL AND r.principal_ref = p_principal);
$$;

CREATE FUNCTION public.commerce_export_order_draft_receipts_v2(p_contact uuid, p_principal uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH matches AS MATERIALIZED (
    SELECT order_id, installation_ref, principal_kind, created_at, principal_ref, customer_ref, exportable, principal_unavailable
    FROM public.commerce_order_draft_receipt_privacy_matches_v2(p_contact, p_principal, NULL)
    UNION ALL
    SELECT r.order_id, r.installation_ref, r.principal_kind, r.created_at, NULL, NULL,
      p_principal IS NULL OR (
        coalesce(c.principal_id = p_principal OR e.principal_id = p_principal, false)
        AND (c.principal_id IS NULL OR c.principal_id = p_principal)
        AND (e.principal_id IS NULL OR e.principal_id = p_principal)
        AND (p.id IS NULL OR p.id = c.id)
      ), false
    FROM public.commerce_order_draft_receipts_v2 r
    JOIN public.commerce_orders o ON o.id = r.order_id
    JOIN public.clients c ON c.id = o.client_id
    LEFT JOIN public.clients p ON p.principal_id = p_principal
    LEFT JOIN public.identity_privacy_erasures e ON e.client_id = c.id
    WHERE r.customer_or_session_ref IS NULL
      AND (c.id = p_contact OR (p_contact IS NULL AND (c.principal_id = p_principal OR e.principal_id = p_principal)))
  ), numbered AS (
    SELECT *, (row_number() OVER (ORDER BY order_id) - 1) / 10000 AS chunk FROM matches WHERE exportable
  ), chunks AS (
    SELECT chunk, jsonb_agg(jsonb_strip_nulls(jsonb_build_object('orderId', order_id,
      'installationRef', installation_ref, 'principalKind', principal_kind, 'createdAt', created_at,
      'principalRef', principal_ref, 'customerOrSessionRef', customer_ref)) ORDER BY order_id) AS records
    FROM numbered GROUP BY chunk
  ), unavailable AS (
    SELECT coalesce(bool_or(NOT exportable), false) AS unverified,
      coalesce(bool_or(principal_unavailable), false) AS missing_principal,
      p_contact IS NULL AND EXISTS (SELECT FROM public.identity_privacy_erasures
        WHERE principal_id = p_principal AND client_id IS NULL) AS missing_contact
    FROM matches
  )
  SELECT CASE WHEN count(*) > 10000 THEN NULL ELSE jsonb_build_object(
    'contributorId', 'order-draft-receipts', 'version', 'commerce.order-draft-receipts.v1',
    'data', jsonb_build_object('receiptChunks', coalesce(jsonb_agg(records ORDER BY chunk), '[]'::jsonb)),
    'coverage', (SELECT jsonb_build_object('complete', NOT (unverified OR missing_principal OR missing_contact),
      'included', jsonb_build_array('Verified receipt coordinates and order facts',
        'Retained order reference remains linked through the order owner'),
      'unavailable', jsonb_build_array('Derived replay key and command digest withheld. The key can link to a known original owner scope and request key.')
        || CASE WHEN unverified THEN '["Receipt ownership unverified"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN missing_principal THEN '["Receipt principal reference unavailable"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN missing_contact THEN '["Retained receipt order references unavailable without a verified contact"]'::jsonb ELSE '[]'::jsonb END
    ) FROM unavailable),
    'obligations', '[{"owner":"order-draft-receipts","resource":"commerce.order-draft-receipt-owner-references","disposition":"erase","reasonCode":"RECEIPT_OWNER_REFERENCES_CLEARED","remote":false},
      {"owner":"order-draft-receipts","resource":"commerce.order-draft-receipt-retained-facts","disposition":"retain","reasonCode":"ORDER_REFERENCE_AND_DERIVED_REPLAY_KEY_RETAINED","remote":false}]'::jsonb
  ) END FROM chunks;
$$;

CREATE FUNCTION public.commerce_erase_order_draft_receipts_v2(p_contact uuid, p_principal uuid, p_erasure_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  changed integer;
BEGIN
  IF p_erasure_id IS NOT NULL THEN
    IF NOT pg_has_role(session_user,
      (SELECT relowner FROM pg_class WHERE oid = 'public.identity_privacy_erasure_reconciliations'::regclass), 'USAGE')
    THEN
      RAISE EXCEPTION 'privacy_reconciliation_owner_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT FROM public.identity_privacy_erasures
      WHERE erasure_id = p_erasure_id AND client_id IS NOT DISTINCT FROM p_contact AND principal_id IS NOT DISTINCT FROM p_principal)
      OR EXISTS (SELECT FROM public.identity_privacy_erasure_reconciliations
        WHERE erasure_id = p_erasure_id AND contributor_id = 'order-draft-receipts')
    THEN RETURN -1;
    END IF;
  END IF;

  -- The immediate guard requires the ledger writer lock. With that lock held,
  -- evidence absent here and present at the deferred check was written in this transaction.
  WITH matches AS MATERIALIZED (
    SELECT order_id, erasable FROM public.commerce_order_draft_receipt_privacy_matches_v2(p_contact, p_principal, p_erasure_id)
  ), marked AS (
    INSERT INTO public.commerce_order_draft_receipt_erasure_marks(transaction_id, order_id, prior_erasure_id)
    SELECT pg_current_xact_id(), order_id, p_erasure_id FROM matches
    WHERE NOT EXISTS (SELECT FROM matches WHERE erasable IS NOT TRUE)
    RETURNING order_id
  ), cleared AS (
    UPDATE public.commerce_order_draft_receipts_v2 r SET principal_ref = NULL, customer_or_session_ref = NULL
    FROM marked m WHERE r.order_id = m.order_id
    RETURNING 1
  )
  SELECT CASE WHEN EXISTS (SELECT FROM matches WHERE erasable IS NOT TRUE) THEN -1 ELSE count(*)::integer END
  INTO changed FROM cleared;
  RETURN changed;
END;
$$;

CREATE FUNCTION public.commerce_read_order_draft_receipt_v2(p_lookup jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  scope jsonb := p_lookup->'owner';
  installation text := scope->>'installationRef';
  principal text := scope->>'principalRef';
  customer text := scope->>'customerOrSessionRef';
  request_key text := p_lookup->>'requestKey';
  digest text := p_lookup->>'commandDigest';
  uuid_pattern CONSTANT text := '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
  field text;
  receipt public.commerce_order_draft_receipts_v2%ROWTYPE;
  result jsonb;
BEGIN
  IF jsonb_typeof(p_lookup) IS DISTINCT FROM 'object' THEN field := '/';
  ELSIF p_lookup - ARRAY['dialect','owner','requestKey','commandDigest'] <> '{}'::jsonb THEN field := '/';
  ELSIF p_lookup->'dialect' IS DISTINCT FROM '"commerce.order-draft.v2"'::jsonb THEN field := '/dialect';
  ELSIF jsonb_typeof(scope) IS DISTINCT FROM 'object' THEN field := '/owner';
  ELSIF scope - ARRAY['installationRef','principalKind','principalRef','customerOrSessionRef'] <> '{}'::jsonb THEN field := '/owner';
  ELSIF jsonb_typeof(scope->'installationRef') IS DISTINCT FROM 'string'
    OR char_length(installation) + char_length(regexp_replace(installation, U&'[^\+010000-\+10FFFF]', '', 'g')) NOT BETWEEN 1 AND 256
    THEN field := '/owner/installationRef';
  ELSIF scope->'principalKind' IS DISTINCT FROM '"customer"'::jsonb THEN field := '/owner/principalKind';
  ELSIF jsonb_typeof(scope->'principalRef') IS DISTINCT FROM 'string'
    OR length(principal) <> 36 OR principal COLLATE "C" !~ uuid_pattern THEN field := '/owner/principalRef';
  ELSIF jsonb_typeof(scope->'customerOrSessionRef') IS DISTINCT FROM 'string'
    OR length(customer) <> 36 OR customer COLLATE "C" !~ uuid_pattern THEN field := '/owner/customerOrSessionRef';
  ELSIF jsonb_typeof(p_lookup->'requestKey') IS DISTINCT FROM 'string'
    OR char_length(btrim(request_key, ' ')) NOT BETWEEN 8 AND 120 THEN field := '/requestKey';
  ELSIF jsonb_typeof(p_lookup->'commandDigest') IS DISTINCT FROM 'string'
    OR length(digest) <> 64 OR translate(digest,'0123456789abcdef','') <> '' THEN field := '/commandDigest';
  ELSIF octet_length(convert_to(public.catalog_publication_canonical(p_lookup, 0), 'UTF8')) > 8192 THEN field := '/';
  END IF;

  IF field IS NOT NULL THEN
    RAISE EXCEPTION 'order_draft_receipt_invalid_input' USING ERRCODE = '22023', DETAIL = field,
      HINT = 'Supply the documented receipt lookup with an authenticated owner, request key and lowercase SHA-256 command digest.';
  END IF;

  SELECT * INTO receipt FROM public.commerce_order_draft_receipts_v2
  WHERE storage_key = public.commerce_order_draft_storage_key_v2(scope, request_key);
  IF NOT FOUND OR receipt.principal_ref IS NULL THEN RETURN NULL; END IF;

  IF (receipt.installation_ref, receipt.principal_kind, receipt.principal_ref, receipt.customer_or_session_ref, receipt.command_digest)
    IS NOT DISTINCT FROM (installation, scope->>'principalKind', principal::uuid, customer::uuid, digest)
    AND EXISTS (SELECT FROM public.commerce_orders WHERE id = receipt.order_id AND client_id = receipt.customer_or_session_ref)
  THEN result := public.commerce_read_order_draft_receipt_history_v2(receipt.storage_key);
  END IF;
  IF result IS NULL THEN
    RAISE EXCEPTION 'order_draft_idempotency_conflict' USING ERRCODE = '23505', DETAIL = '/requestKey',
      HINT = 'Replay the original command, or use a new request key for newly accepted work. If the original command still conflicts, recover the receipt through its owner.';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_v2_consume_erasure_mark(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_v2_erasure_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_privacy_matches_v2(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_export_order_draft_receipts_v2(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_erase_order_draft_receipts_v2(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_read_order_draft_receipt_v2(jsonb) FROM PUBLIC;

CREATE CONSTRAINT TRIGGER commerce_order_draft_receipt_v2_erasure_check AFTER UPDATE ON public.commerce_order_draft_receipts_v2 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_draft_receipt_v2_erasure_check();

INSERT INTO public.identity_privacy_required_contributors (contributor_id)
VALUES ('order-draft-receipts') ON CONFLICT (contributor_id) DO NOTHING;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_draft_receipt_erasure_marks FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_privacy_matches_v2(uuid,uuid,uuid), public.commerce_export_order_draft_receipts_v2(uuid,uuid), public.commerce_erase_order_draft_receipts_v2(uuid,uuid,uuid), public.commerce_read_order_draft_receipt_v2(jsonb), public.commerce_order_draft_receipt_v2_consume_erasure_mark(uuid,uuid,uuid) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_draft_receipt_erasure_marks FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_privacy_matches_v2(uuid,uuid,uuid), public.commerce_export_order_draft_receipts_v2(uuid,uuid), public.commerce_erase_order_draft_receipts_v2(uuid,uuid,uuid), public.commerce_read_order_draft_receipt_v2(jsonb), public.commerce_order_draft_receipt_v2_consume_erasure_mark(uuid,uuid,uuid) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_draft_receipt_erasure_marks FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_privacy_matches_v2(uuid,uuid,uuid), public.commerce_export_order_draft_receipts_v2(uuid,uuid), public.commerce_erase_order_draft_receipts_v2(uuid,uuid,uuid), public.commerce_read_order_draft_receipt_v2(jsonb), public.commerce_order_draft_receipt_v2_consume_erasure_mark(uuid,uuid,uuid) FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_export_order_draft_receipts_v2(uuid,uuid), public.commerce_erase_order_draft_receipts_v2(uuid,uuid,uuid), public.commerce_read_order_draft_receipt_v2(jsonb), public.commerce_order_draft_receipt_v2_consume_erasure_mark(uuid,uuid,uuid) TO service_role';
END IF; END; $$;
