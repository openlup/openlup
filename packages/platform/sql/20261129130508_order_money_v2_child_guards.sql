-- Only the destination eraser writes these marks. Each queued child update
-- consumes one, including when the eraser ran in a released savepoint.
CREATE TABLE public.commerce_order_money_v2_redaction_marks (
  transaction_id xid8 NOT NULL,
  order_id uuid NOT NULL,
  delivery_bucket boolean NOT NULL,
  PRIMARY KEY (transaction_id, order_id, delivery_bucket)
);
ALTER TABLE public.commerce_order_money_v2_redaction_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_order_money_v2_redaction_marks FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_money_v2_redaction_marks FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_money_v2_redaction_marks FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_money_v2_redaction_marks FROM service_role';
END IF; END; $$;

-- Only consume a private mark for a deferred trigger in the current transaction.
CREATE FUNCTION public.commerce_order_money_v2_consume_redaction_mark(p_order_id uuid, p_delivery_bucket boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN RETURN false; END IF;
  DELETE FROM public.commerce_order_money_v2_redaction_marks
    WHERE transaction_id = pg_current_xact_id() AND order_id = p_order_id AND delivery_bucket = p_delivery_bucket;
  RETURN FOUND AND EXISTS (
    SELECT FROM public.commerce_orders o
    JOIN public.commerce_order_tax_snapshots s ON s.order_id = o.id
    JOIN public.identity_privacy_erasures e ON e.client_id = o.client_id
    WHERE o.id = p_order_id AND s.destination_erased
      AND e.contributor_versions->>'destination-documents' = 'commerce.destination-documents.v1'
      AND e.dispositions @> '[{"contributorId":"destination-documents","version":"commerce.destination-documents.v1","obligations":[
        {"owner":"destination-documents","resource":"commerce.order-money-destination-pins","disposition":"erase","remote":false},
        {"owner":"destination-documents","resource":"commerce.order-money-retained-facts","disposition":"retain","remote":false}]}]'::jsonb
  );
END;
$$;

CREATE FUNCTION public.commerce_order_money_v2_child_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  field text := CASE TG_TABLE_NAME
    WHEN 'commerce_order_tax_snapshots' THEN '/taxEvidence'
    WHEN 'commerce_order_line_sources' THEN '/lines'
    WHEN 'commerce_order_delivery_buckets' THEN '/deliveryBuckets'
    WHEN 'commerce_order_line_allocations' THEN '/discountAllocations'
    WHEN 'commerce_order_tax_positions' THEN '/taxEvidence'
    WHEN 'commerce_order_fee_lines' THEN '/feeLines'
  END;
  owner_path boolean := pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE');
  is_delivery_bucket boolean := TG_TABLE_NAME = 'commerce_order_delivery_buckets';
  before_row jsonb;
  after_row jsonb;
  copies text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE = '23514', COLUMN = field,
      HINT = 'Keep the accepted facts and use the owning order lifecycle operation.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.order_id <> NEW.order_id THEN
    PERFORM public.commerce_order_money_v2_assert(OLD.order_id, false, owner_path);
    PERFORM public.commerce_order_money_v2_assert(NEW.order_id, false, owner_path);
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE = '23514', COLUMN = field,
      HINT = 'Keep the accepted facts and use the owning order lifecycle operation.';
  END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    IF TG_TABLE_NAME = 'commerce_order_tax_snapshots' OR
      (is_delivery_bucket AND to_jsonb(OLD)->'part_no' = '0'::jsonb) THEN
      before_row := to_jsonb(OLD);
      after_row := to_jsonb(NEW);
      copies := CASE WHEN is_delivery_bucket THEN ARRAY['carrier_ref','service_ref']
        ELSE ARRAY['destination_digest','destination_policy_revision','delivery_selection_ref'] END;
      IF before_row->'destination_erased' IS DISTINCT FROM 'false'::jsonb
        OR after_row->'destination_erased' IS DISTINCT FROM 'true'::jsonb
        OR (before_row - copies - 'destination_erased') IS DISTINCT FROM (after_row - copies - 'destination_erased')
        OR EXISTS (SELECT FROM unnest(copies) f WHERE after_row->f IS DISTINCT FROM 'null'::jsonb)
        OR NOT public.commerce_order_money_v2_consume_redaction_mark(NEW.order_id, is_delivery_bucket)
      THEN
        RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE = '23514', COLUMN = '/taxEvidence',
          HINT = 'Keep the accepted facts and use the owning order lifecycle operation.';
      END IF;
    ELSE
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE = '23514', COLUMN = field,
        HINT = 'Keep the accepted facts and use the owning order lifecycle operation.';
    END IF;
  END IF;
  PERFORM public.commerce_order_money_v2_assert(NEW.order_id, false, owner_path);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_order_money_v2_consume_redaction_mark(uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_money_v2_child_guard() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_money_v2_consume_redaction_mark(uuid,boolean) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_money_v2_consume_redaction_mark(uuid,boolean) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_order_money_v2_consume_redaction_mark(uuid,boolean) FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_order_money_v2_consume_redaction_mark(uuid,boolean) TO service_role';
END IF; END; $$;

CREATE CONSTRAINT TRIGGER trg_commerce_order_tax_snapshots_money_v2 AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_tax_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();
CREATE CONSTRAINT TRIGGER trg_commerce_order_line_sources_money_v2 AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_line_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();
CREATE CONSTRAINT TRIGGER trg_commerce_order_delivery_buckets_money_v2 AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_delivery_buckets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();
CREATE CONSTRAINT TRIGGER trg_commerce_order_line_allocations_money_v2 AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_line_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();
CREATE CONSTRAINT TRIGGER trg_commerce_order_tax_positions_money_v2 AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_tax_positions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();
CREATE CONSTRAINT TRIGGER trg_commerce_order_fee_lines_money_v2 AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_fee_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();
CREATE CONSTRAINT TRIGGER trg_commerce_order_adjustments_money_v2 AFTER INSERT ON public.commerce_order_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commerce_order_money_v2_child_guard();

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
  -- The ledger lock remains held through deferred validation. A matching
  -- receipt absent here and visible to the guard was written in this transaction.
  DECLARE
    ledger_was_empty boolean := NOT EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id = p_client_id);
  BEGIN
    WITH redacted AS (
      UPDATE public.commerce_order_tax_snapshots s
      SET destination_erased = true, destination_digest = NULL,
        destination_policy_revision = NULL, delivery_selection_ref = NULL
      FROM public.commerce_orders o
      WHERE o.id = s.order_id AND o.client_id = p_client_id AND NOT s.destination_erased
      RETURNING s.order_id
    )
    INSERT INTO public.commerce_order_money_v2_redaction_marks(transaction_id, order_id, delivery_bucket)
      SELECT pg_current_xact_id(), order_id, false FROM redacted WHERE ledger_was_empty;
    WITH redacted AS (
      UPDATE public.commerce_order_delivery_buckets b
      SET destination_erased = true, carrier_ref = NULL, service_ref = NULL
      FROM public.commerce_orders o
      WHERE o.id = b.order_id AND o.client_id = p_client_id AND b.part_no = 0 AND NOT b.destination_erased
      RETURNING b.order_id
    )
    INSERT INTO public.commerce_order_money_v2_redaction_marks(transaction_id, order_id, delivery_bucket)
      SELECT pg_current_xact_id(), order_id, true FROM redacted WHERE ledger_was_empty;
  END;
  RETURN v_count;
END;
$$;
