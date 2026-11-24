-- Protect the selected catalogue component on the original checkout writer.
CREATE OR REPLACE FUNCTION public.catalog_admission_runtime_checkout(
  p_operation text, p_key text, p_client uuid, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_uuid CONSTANT pg_catalog.text := '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$';
  v_keys CONSTANT pg_catalog.text[] := ARRAY['skuIds','skuRevisionId','priceListId'];
  v_key pg_catalog.int8;
  v_skus pg_catalog.uuid[];
  v_revision pg_catalog.uuid;
  v_list pg_catalog.uuid;
  v_orders pg_catalog.uuid[];
  v_count pg_catalog.int4;
BEGIN
  <<prelock>>
  BEGIN
    IF p_operation COLLATE pg_catalog."C" IS DISTINCT FROM 'prelock'
      OR p_key IS NULL OR pg_catalog.octet_length(p_key) NOT BETWEEN 8 AND 120
      OR p_key COLLATE pg_catalog."C" ~ '[^!-~]' OR p_client IS NULL
      OR pg_catalog.current_setting('transaction_isolation') <> 'repeatable read'
      OR pg_catalog.current_setting('transaction_read_only') <> 'off'
      OR pg_catalog.current_setting('lock_timeout') = '0'
      OR pg_catalog.current_setting('statement_timeout') = '0'
      OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
      OR NOT p_payload ?& v_keys OR p_payload - v_keys <> '{}'::pg_catalog.jsonb
      OR pg_catalog.jsonb_typeof(p_payload->'skuIds') IS DISTINCT FROM 'array' THEN
      EXIT prelock;
    END IF;
    IF pg_catalog.jsonb_array_length(p_payload->'skuIds') <> 2
      OR (p_payload#>>'{skuIds,0}' COLLATE pg_catalog."C" ~ v_uuid) IS DISTINCT FROM true
      OR (p_payload#>>'{skuIds,1}' COLLATE pg_catalog."C" ~ v_uuid) IS DISTINCT FROM true
      OR p_payload#>'{skuIds,0}' = p_payload#>'{skuIds,1}'
      OR (p_payload->>'skuRevisionId' COLLATE pg_catalog."C" ~ v_uuid) IS DISTINCT FROM true
      OR (p_payload->>'priceListId' COLLATE pg_catalog."C" ~ v_uuid) IS DISTINCT FROM true THEN
      EXIT prelock;
    END IF;
    v_key := pg_catalog.hashtextextended(p_key,0);
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND granted AND mode='ExclusiveLock' AND pid=pg_catalog.pg_backend_pid()
        AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
        AND classid=((v_key >> 32) & 4294967295)::pg_catalog.oid
        AND objid=(v_key & 4294967295)::pg_catalog.oid AND objsubid=1
    ) THEN
      EXIT prelock;
    END IF;

    v_skus := ARRAY[(p_payload#>>'{skuIds,0}')::pg_catalog.uuid,(p_payload#>>'{skuIds,1}')::pg_catalog.uuid];
    v_revision := (p_payload->>'skuRevisionId')::pg_catalog.uuid;
    v_list := (p_payload->>'priceListId')::pg_catalog.uuid;

    LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
    PERFORM 1 FROM public.clients WHERE id=p_client FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE='22023'; END IF;
    v_orders := ARRAY(SELECT id FROM public.commerce_orders WHERE client_id=p_client LIMIT 501);
    IF pg_catalog.cardinality(v_orders)>500 THEN EXIT prelock; END IF;
    PERFORM 1 FROM public.commerce_orders WHERE id=ANY(v_orders) ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.catalog_skus WHERE id=ANY(v_skus) ORDER BY id FOR KEY SHARE;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count<>2 THEN RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.catalog_sku_revisions WHERE id=v_revision AND sku_id=ANY(v_skus) FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE='22023'; END IF;

    PERFORM public.catalog_admission_lock_shared();
    LOCK TABLE public.catalog_skus, public.catalog_sku_identifiers, public.catalog_product_document_revisions,
      public.catalog_attribute_projection, public.catalog_publication_heads, public.catalog_publications,
      public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions,
      public.catalog_publication_pointer_capabilities, public.catalog_draft_heads, public.catalog_draft_revisions,
      public.catalog_draft_command_receipts IN SHARE MODE NOWAIT;
    PERFORM public.catalog_admission_lock_checkout_price(v_list,v_skus);
    LOCK TABLE public.subscription_price_policy_revisions IN SHARE MODE NOWAIT;

    IF EXISTS (SELECT 1 FROM public.catalog_skus WHERE id=ANY(v_skus) AND NOT sellable_in_subscription) THEN
      RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.price_lists WHERE id=v_list) THEN
      RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE='22023';
    END IF;
    RETURN '{"kind":"locked"}'::pg_catalog.jsonb;
  END;
  RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE = '55000',
    HINT = 'Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.';
END;
$$;
