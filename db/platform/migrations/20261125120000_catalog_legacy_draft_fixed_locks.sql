-- Every fresh legacy draft takes the same catalogue locks. The lock argument is
-- kept for the installed invokers and no longer selects the lock policy.
CREATE OR REPLACE FUNCTION public.catalog_admission_check_legacy_draft(
  p_key text, p_draft jsonb, p_client uuid, p_lock boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_skus text[] := ARRAY(SELECT line->>'sku' FROM pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(p_draft->'lines')='array' THEN p_draft->'lines' ELSE '[]'::pg_catalog.jsonb END) AS line);
BEGIN
  PERFORM 1 FROM public.clients WHERE id=p_client FOR KEY SHARE;
  PERFORM 1 FROM public.catalog_skus WHERE sku=ANY(v_skus) ORDER BY id FOR KEY SHARE;
  PERFORM public.catalog_admission_lock_shared();
  -- A caller's older transaction snapshot must not hide a concurrent issue.
  IF current_setting('transaction_isolation') IN ('repeatable read','serializable') THEN
    PERFORM 1 FROM public.catalog_products p WHERE id IN (
      SELECT product_id FROM public.catalog_skus WHERE sku=ANY(v_skus)
    ) ORDER BY p.id FOR NO KEY UPDATE;
  END IF;
  IF public.catalog_admission_requires_quote_authority(v_skus,
      coalesce(p_draft#>>'{context,offerVersion,version}',p_draft#>>'{context,offerVersion}'))
    OR EXISTS (
      SELECT 1 FROM public.commerce_orders source_order
      WHERE source_order.id = CASE WHEN p_key ~ '^checkout-recovery-recreate:[a-f0-9-]{36}$'
        AND pg_catalog.pg_input_is_valid(pg_catalog.split_part(p_key,':',2),'pg_catalog.uuid')
        THEN pg_catalog.split_part(p_key,':',2)::pg_catalog.uuid END
        AND source_order.client_id OPERATOR(pg_catalog.=) p_client
        AND source_order.catalog_acceptance IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE = '55000',
      HINT = 'Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.';
  END IF;
END;
$$;
