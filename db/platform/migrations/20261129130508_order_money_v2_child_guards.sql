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
  before_row jsonb;
  after_row jsonb;
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
      (TG_TABLE_NAME = 'commerce_order_delivery_buckets' AND to_jsonb(OLD)->'part_no' = '0'::jsonb) THEN
      before_row := to_jsonb(OLD);
      after_row := to_jsonb(NEW);
    ELSE
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE = '23514', COLUMN = field,
        HINT = 'Keep the accepted facts and use the owning order lifecycle operation.';
    END IF;
  END IF;
  PERFORM public.commerce_order_money_v2_assert(NEW.order_id, false, owner_path, before_row, after_row);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_order_money_v2_child_guard() FROM PUBLIC;

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
  UPDATE public.commerce_order_tax_snapshots s
    SET destination_erased = true, destination_digest = NULL,
      destination_policy_revision = NULL, delivery_selection_ref = NULL
    FROM public.commerce_orders o
    WHERE o.id = s.order_id AND o.client_id = p_client_id AND NOT s.destination_erased;
  UPDATE public.commerce_order_delivery_buckets b
    SET destination_erased = true, carrier_ref = NULL, service_ref = NULL
    FROM public.commerce_orders o
    WHERE o.id = b.order_id AND o.client_id = p_client_id AND b.part_no = 0 AND NOT b.destination_erased;
  RETURN v_count;
END;
$$;
