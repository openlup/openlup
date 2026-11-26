CREATE TABLE public.commerce_order_draft_receipts_v2 (
  storage_key text PRIMARY KEY CHECK (
    length(storage_key) = 64 AND translate(storage_key,
      '0123456789abcdef', '') = ''
  ),
  installation_ref text NOT NULL CHECK (char_length(installation_ref) BETWEEN 1 AND 256),
  principal_kind text NOT NULL CHECK (principal_kind = 'customer'),
  principal_ref uuid,
  customer_or_session_ref uuid,
  command_digest text NOT NULL CHECK (length(command_digest) = 64 AND translate(command_digest,'0123456789abcdef','') = ''),
  order_id uuid NOT NULL UNIQUE REFERENCES public.commerce_order_tax_snapshots(order_id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((principal_ref IS NULL AND customer_or_session_ref IS NULL)
    OR (principal_ref IS NOT NULL AND customer_or_session_ref IS NOT NULL))
);
CREATE INDEX commerce_order_draft_receipts_v2_principal_idx ON public.commerce_order_draft_receipts_v2 (principal_ref) WHERE principal_ref IS NOT NULL;
CREATE INDEX commerce_order_draft_receipts_v2_customer_idx ON public.commerce_order_draft_receipts_v2 (customer_or_session_ref) WHERE customer_or_session_ref IS NOT NULL;
ALTER TABLE public.commerce_order_draft_receipts_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_order_draft_receipts_v2 FROM PUBLIC;

CREATE FUNCTION public.commerce_order_draft_storage_key_v2(p_owner jsonb, p_request_key text) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(public.catalog_publication_canonical(
    jsonb_build_array('order-draft-key.v2', 'commerce.order-draft.v2', p_owner, p_request_key), 0), 'UTF8')), 'hex');
$$;

CREATE FUNCTION public.commerce_order_draft_receipt_v2_immutable() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
    AND OLD.principal_ref IS NOT NULL AND OLD.customer_or_session_ref IS NOT NULL
    AND NEW.principal_ref IS NULL AND NEW.customer_or_session_ref IS NULL
    AND (OLD.storage_key, OLD.installation_ref, OLD.principal_kind, OLD.command_digest, OLD.order_id, OLD.created_at)
      IS NOT DISTINCT FROM (NEW.storage_key, NEW.installation_ref, NEW.principal_kind, NEW.command_digest, NEW.order_id, NEW.created_at)
    AND EXISTS (SELECT FROM pg_locks WHERE pid = pg_backend_pid() AND granted
      AND mode = 'ShareRowExclusiveLock' AND relation = 'public.identity_privacy_erasures'::regclass)
  THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'order_draft_receipt_immutable' USING ERRCODE = '55000',
    HINT = 'Read through the receipt lookup or use the authorized privacy operation to erase owner references.';
END;
$$;

CREATE FUNCTION public.commerce_read_order_draft_receipt_history_v2(p_storage_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('outcome', jsonb_build_object('orderId', r.order_id,
    'status', 'draft', 'paymentStatus', 'not_started', 'acceptedMoneyDigest', s.accepted_money_digest,
    'destinationSnapshotRef', s.destination_snapshot_ref), 'replayed', true)
  FROM public.commerce_order_draft_receipts_v2 r
  JOIN public.commerce_orders o ON o.id = r.order_id
  JOIN public.commerce_order_tax_snapshots s ON s.order_id = r.order_id
  WHERE length(p_storage_key) = 64 AND translate(p_storage_key,
    '0123456789abcdef', '') = ''
    AND r.storage_key = p_storage_key AND o.money_version IS NOT NULL AND s.accepted_quote_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.commerce_order_draft_storage_key_v2(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_draft_receipt_v2_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_read_order_draft_receipt_history_v2(text) FROM PUBLIC;

CREATE TRIGGER commerce_order_draft_receipt_v2_immutable BEFORE UPDATE OR DELETE ON public.commerce_order_draft_receipts_v2 FOR EACH ROW EXECUTE FUNCTION public.commerce_order_draft_receipt_v2_immutable();

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_draft_receipts_v2 FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_draft_receipts_v2 FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_draft_receipts_v2 FROM service_role';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_draft_storage_key_v2(jsonb,text), public.commerce_order_draft_receipt_v2_immutable(), public.commerce_read_order_draft_receipt_history_v2(text) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_draft_storage_key_v2(jsonb,text), public.commerce_order_draft_receipt_v2_immutable(), public.commerce_read_order_draft_receipt_history_v2(text) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_draft_storage_key_v2(jsonb,text), public.commerce_order_draft_receipt_v2_immutable(), public.commerce_read_order_draft_receipt_history_v2(text) FROM service_role';
END IF; END; $$;
