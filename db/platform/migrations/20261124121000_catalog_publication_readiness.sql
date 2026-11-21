-- Donor price predicate with cumulative reasons. Every check uses the caller's single instant.
-- Checkout refuses overlapping effective lists, so an ambiguous settlement list refuses the batch.
CREATE FUNCTION public.catalog_publication_price_reasons(p_skus uuid[],p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE settlement_region text; settlement_currency text; list_id uuid; lists bigint; history bigint; policies bigint;
 well_formed boolean; discount integer; quantum integer; result jsonb;
BEGIN
 -- A value-returning projection of the keys and grammar owned by the native settlement readers.
 SELECT max(value_text) FILTER (WHERE key='settlement_region'),max(value_text) FILTER (WHERE key='settlement_currency')
 INTO settlement_region,settlement_currency FROM public.commerce_settings WHERE key IN ('settlement_region','settlement_currency');
 IF p_at IS NULL OR settlement_region IS NULL OR settlement_region !~ '^[A-Z]{2}$'
  OR settlement_currency IS NULL OR settlement_currency !~ '^[A-Z]{3}$' THEN
  RETURN '{"kind":"refusal","reason":"inconsistent_evidence","detail":"catalog_price_setup_settlement_context_unverified"}';
 END IF;
 SELECT count(*),(array_agg(l.id ORDER BY l.created_at DESC,l.id DESC))[1] INTO lists,list_id FROM public.price_lists l
 WHERE l.region_code=settlement_region AND l.currency=settlement_currency AND l.status='active'
  AND l.valid_from<=p_at AND (l.valid_to IS NULL OR l.valid_to>p_at);
 IF lists>1 THEN RETURN '{"kind":"refusal","reason":"inconsistent_evidence","detail":"active_price_list_ambiguous"}'; END IF;
 -- History has no time filter. A closed open-ended revision keeps its actual end and hashes its original null end.
 SELECT count(*),count(*) FILTER (WHERE w.effective),coalesce(bool_and(p.rounding_rule='FLOOR_TO_QUANTUM'
   AND p.rounding_quantum_minor>0 AND p.discount_bps BETWEEN 0 AND 10000
   AND p.digest=public.catalog_price_setup_policy_digest(p.id,p.revision_no,p.price_list_id,p.region_code,p.currency,p.channel,
    p.effective_from,CASE WHEN p.closed_from_open THEN NULL ELSE p.effective_to END,p.discount_bps,p.rounding_quantum_minor,p.rounding_rule))
  FILTER (WHERE w.effective),false),min(p.discount_bps) FILTER (WHERE w.effective),min(p.rounding_quantum_minor) FILTER (WHERE w.effective)
 INTO history,policies,well_formed,discount,quantum
 FROM public.subscription_price_policy_revisions p
 CROSS JOIN LATERAL (SELECT p.effective_from<=p_at AND (p.effective_to IS NULL OR p.effective_to>p_at) AS effective) w
 WHERE p.price_list_id=list_id AND p.region_code=settlement_region AND p.currency=settlement_currency AND p.channel='D2C';
 -- One result per requested SKU, keyed and ordered by its ID.
 SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',s.id,'reasons',
   CASE WHEN coalesce(e.base_entries=1 AND e.base_valid=1 AND ((history=0 AND e.subscription_entries=1 AND e.subscription_valid=1)
     OR (history>0 AND policies=1 AND well_formed AND e.subscription_entries=0
      AND CASE WHEN quantum>0 THEN e.base_minor::bigint*(10000-discount)/10000/quantum*quantum END>0)),false)
    THEN '[]'::jsonb ELSE '["price_readiness_missing"]'::jsonb END
   || CASE WHEN e.shape_invalid THEN '["price_shape_invalid"]'::jsonb ELSE '[]'::jsonb END) ORDER BY s.id),'[]'::jsonb) INTO result
 FROM unnest(p_skus) AS s(id) CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE x.mode='one_time' AND x.min_qty=1) AS base_entries,
   count(*) FILTER (WHERE x.mode='one_time' AND x.min_qty=1 AND x.amount_kind='gross' AND x.unit_price_minor>0) AS base_valid,
   min(x.unit_price_minor) FILTER (WHERE x.mode='one_time' AND x.min_qty=1) AS base_minor,
   count(*) FILTER (WHERE x.mode='subscription') AS subscription_entries,
   count(*) FILTER (WHERE x.mode='subscription' AND x.min_qty=1 AND x.amount_kind='gross' AND x.unit_price_minor>0) AS subscription_valid,
   coalesce(bool_or(x.mode='any' OR x.amount_kind<>'gross' OR x.min_qty<>1),false) AS shape_invalid
  FROM public.price_entries x WHERE x.price_list_id=list_id AND x.variant_id=s.id AND x.active
   AND x.valid_from<=p_at AND (x.valid_to IS NULL OR x.valid_to>p_at) AND x.mode IN ('one_time','subscription','any')
 ) e;
 RETURN result;
END;
$$;

-- Runs in one statement snapshot taken after the reader fence.
CREATE FUNCTION public.catalog_publication_readiness_snapshot(p_codes text[],p_expected text,p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE authority jsonb := public.catalog_publication_read_head(); failed jsonb; subjects jsonb; prices jsonb := '[]'; items jsonb;
 invalid CONSTANT jsonb := '{"kind":"refusal","reason":"inconsistent_evidence"}';
BEGIN
 IF authority->>'kind'='refusal' THEN RETURN authority; END IF;
 IF authority->>'kind'='legacy' THEN RETURN '{"kind":"refusal","reason":"legacy"}'; END IF;
 IF authority->>'headDigest' IS DISTINCT FROM p_expected THEN RETURN '{"kind":"refusal","reason":"head_moved"}'; END IF;
 -- The head reader authenticated every current manifest in this snapshot. A code is absent only when every
 -- sealed revision is certified and neither a sealed claim nor a governed live SKU has that exact code.
 WITH requested AS MATERIALIZED (
  SELECT code,position FROM unnest(p_codes) WITH ORDINALITY AS input(code,position)
 ), roster AS MATERIALIZED (
  SELECT h.product_id,(r->>'skuId')::uuid AS sku_id,public.catalog_publication_read_sku_revision(h.product_id,r)->>'code' AS code
  FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
  CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') r
 ), claims AS MATERIALIZED (
  SELECT q.position,q.code,ro.product_id,ro.sku_id,count(ro.sku_id) OVER (PARTITION BY q.position) AS copies
  FROM requested q LEFT JOIN roster ro ON ro.code COLLATE "C"=q.code COLLATE "C"
 ), selected AS MATERIALIZED (
  SELECT c.*,CASE WHEN c.sku_id IS NOT NULL THEN public.catalog_publication_selected_evidence(c.product_id,c.sku_id) END AS e FROM claims c
 )
 SELECT CASE WHEN EXISTS (SELECT 1 FROM roster WHERE code IS NULL) OR EXISTS (SELECT 1 FROM claims WHERE copies>1)
   OR EXISTS (SELECT 1 FROM requested q JOIN public.catalog_skus s ON s.sku COLLATE "C"=q.code COLLATE "C"
    JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
    WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE (c.position,c.product_id,c.sku_id)=(q.position,s.product_id,s.id)))
  THEN invalid ELSE (SELECT coalesce(e,invalid) FROM selected WHERE sku_id IS NOT NULL AND e->>'kind' IS DISTINCT FROM 'evidence'
   ORDER BY position LIMIT 1) END,
  (SELECT jsonb_agg(jsonb_build_object('skuCode',code,'productId',product_id,'skuId',sku_id,'evidence',e-'kind') ORDER BY position) FROM selected)
 INTO failed,subjects;
 IF failed IS NOT NULL THEN RETURN failed; END IF;
 -- An all-absent batch reads no settlement or price rows.
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(subjects) s WHERE jsonb_typeof(s->'skuId')='string') THEN
  prices := public.catalog_publication_price_reasons(ARRAY(SELECT (s->>'skuId')::uuid FROM jsonb_array_elements(subjects) s
   WHERE jsonb_typeof(s->'skuId')='string'),p_at);
  IF jsonb_typeof(prices) IS DISTINCT FROM 'array' THEN RETURN prices; END IF;
 END IF;
 SELECT CASE WHEN bool_and(jsonb_typeof(s->'skuId')<>'string' OR price.copies=1) THEN jsonb_agg(jsonb_build_object(
   'skuCode',s->'skuCode','evidence',s->'evidence','priceReasons',coalesce(price.reasons,'[]'::jsonb),'primaryPresent',
   CASE WHEN jsonb_typeof(s->'skuId')='string' THEN EXISTS (SELECT 1 FROM public.catalog_skus k WHERE k.product_id=(s->>'productId')::uuid
    AND k.id::text=s #>> '{evidence,product,primarySkuId}' AND k.status<>'archived') END) ORDER BY x.position) END INTO items
 FROM jsonb_array_elements(subjects) WITH ORDINALITY AS x(s,position)
 LEFT JOIN LATERAL (SELECT count(*) AS copies,(array_agg(r->'reasons'))[1] AS reasons
  FROM jsonb_array_elements(prices) r WHERE r->'skuId'=s->'skuId') price ON true;
 IF items IS NULL THEN RETURN invalid; END IF;
 RETURN jsonb_build_object('kind','batch','value',jsonb_build_object('protocol','governed','headDigest',authority->'headDigest','items',items));
END;
$$;

CREATE FUNCTION public.catalog_publication_activation_readiness(p_sku_codes text[],p_expected_head_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_expected_head_digest IS NULL OR p_expected_head_digest COLLATE "C" !~ '^[0-9a-f]{64}$'
  OR coalesce(array_ndims(p_sku_codes),0)<>1 OR cardinality(p_sku_codes) NOT BETWEEN 1 AND 100
  OR EXISTS (SELECT 1 FROM unnest(p_sku_codes) AS input(code) WHERE (code COLLATE "C" ~ '^[A-Za-z0-9._:-]{1,160}$') IS DISTINCT FROM true)
  OR cardinality(p_sku_codes)<>(SELECT count(DISTINCT code COLLATE "C") FROM unnest(p_sku_codes) AS input(code)) THEN
  RETURN '{"kind":"refusal","reason":"invalid_request"}';
 END IF;
 -- An older snapshot or a read-only transaction cannot use the fence; refuse before locking.
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
  RETURN '{"kind":"refusal","reason":"invalid_transaction_mode"}';
 END IF;
 -- The publication writer first takes SHARE ROW EXCLUSIVE NOWAIT on catalog_products (publicationRelationFence).
 -- SHARE conflicts with it, so this waits for an in-flight publication and makes a later one refuse as busy.
 -- A direct caller holds the fence until its transaction ends.
 LOCK TABLE public.catalog_products IN SHARE MODE;
 -- A separate statement takes its snapshot after the fence and passes one unrounded instant to every price check.
 RETURN public.catalog_publication_readiness_snapshot(p_sku_codes,p_expected_head_digest,clock_timestamp());
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_price_reasons(uuid[],timestamptz),
 public.catalog_publication_readiness_snapshot(text[],text,timestamptz), public.catalog_publication_activation_readiness(text[],text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_price_reasons(uuid[],timestamptz), public.catalog_publication_readiness_snapshot(text[],text,timestamptz), public.catalog_publication_activation_readiness(text[],text) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_price_reasons(uuid[],timestamptz), public.catalog_publication_readiness_snapshot(text[],text,timestamptz), public.catalog_publication_activation_readiness(text[],text) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_price_reasons(uuid[],timestamptz), public.catalog_publication_readiness_snapshot(text[],text,timestamptz), public.catalog_publication_activation_readiness(text[],text) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_publication_activation_readiness(text[],text) TO service_role;'; END IF; END; $$;
