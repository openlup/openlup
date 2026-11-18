-- Internal evidence reads. The existing publisher holds the exclusive guard.
CREATE FUNCTION public.catalog_publication_read_head() RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE head_digest text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));
 SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(h.product_id,h.publication_id,h.revision,p.digest)
  ORDER BY h.product_id)::text,'UTF8')),'hex') INTO head_digest
 FROM public.catalog_publication_heads h
 JOIN public.catalog_publications p ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision);
 RETURN head_digest;
END;
$$;

-- Resolve only selected members. Omitted SKUs can point to an earlier SKU
-- revision, while the product document must belong to the selected current head.
CREATE FUNCTION public.catalog_publication_read_member(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE evidence record;
BEGIN
 SELECT s.sku,s.status AS sku_status,s.sellable_standalone,s.sellable_in_subscription,s.net_weight_g,
  s.publication_facts AS live_sku,p.slug,p.status AS product_status,p.current_document_revision_id,
  p.publication_facts AS live_product,b.id AS publication_id,b.revision AS publication_revision,
  b.canonical_state,b.digest AS publication_digest,b.canonical_state::jsonb->'product' AS product,
  r.full_facts,r.digest AS sku_digest,r.id AS sku_revision_id,r.full_facts::jsonb AS sku_facts,
  d.canonical_text AS document_text,jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,
   'schemaId',d.schema_id,'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest) AS document
 INTO STRICT evidence
 FROM public.catalog_skus s
 JOIN public.catalog_products p ON p.id=s.product_id
 JOIN public.catalog_publication_heads h ON h.product_id=p.id
 JOIN public.catalog_publications b ON (b.product_id,b.id,b.revision)=(h.product_id,h.publication_id,h.revision)
 CROSS JOIN LATERAL jsonb_array_elements(b.canonical_state::jsonb->'skus') AS member(ref)
 JOIN public.catalog_sku_revisions r ON (r.product_id,r.sku_id)=(p.id,s.id)
  AND r.id::text=member.ref->>'revisionId' AND r.revision::text=member.ref->>'revision' AND r.digest=member.ref->>'digest'
 JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(p.id,b.document_revision_id)
 WHERE s.id=p_sku_id AND member.ref->>'skuId'=s.id::text;

 IF evidence.publication_digest IS DISTINCT FROM encode(sha256(convert_to(evidence.canonical_state,'UTF8')),'hex')
  OR evidence.sku_digest IS DISTINCT FROM encode(sha256(convert_to(evidence.full_facts,'UTF8')),'hex')
  OR evidence.document->>'digest' IS DISTINCT FROM encode(sha256(convert_to(evidence.document_text,'UTF8')),'hex')
  OR evidence.product->'document' IS DISTINCT FROM evidence.document
  OR evidence.current_document_revision_id::text IS DISTINCT FROM evidence.document->>'id'
  OR evidence.live_product IS DISTINCT FROM evidence.product
  OR evidence.live_sku IS DISTINCT FROM evidence.sku_facts
  OR evidence.slug IS DISTINCT FROM evidence.product->>'slug'
  OR evidence.product_status IS DISTINCT FROM evidence.product->>'status'
  OR evidence.sku IS DISTINCT FROM evidence.sku_facts->>'code'
  OR evidence.sku_status IS DISTINCT FROM evidence.sku_facts->>'status'
  OR to_jsonb(evidence.sellable_standalone) IS DISTINCT FROM evidence.sku_facts->'sellableStandalone'
  OR to_jsonb(evidence.sellable_in_subscription) IS DISTINCT FROM evidence.sku_facts->'sellableInSubscription' THEN
  RAISE EXCEPTION 'catalog_publication_live_drift' USING ERRCODE='40001';
 END IF;

 RETURN jsonb_build_object('product',evidence.product,'sku',evidence.sku_facts,'document',evidence.document,
  'netWeightG',evidence.net_weight_g,'skuRevisionId',evidence.sku_revision_id,
  'head',jsonb_build_object('publicationId',evidence.publication_id,'revision',evidence.publication_revision,
   'documentDigest',evidence.document->>'digest'));
EXCEPTION WHEN no_data_found OR too_many_rows THEN
 RAISE EXCEPTION 'catalog_publication_live_drift' USING ERRCODE='40001';
END;
$$;

CREATE FUNCTION public.catalog_offer_memberships_page(p_offer_version text,p_cursor uuid,p_limit integer,p_mode text,p_expected_head_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE head_digest text; items jsonb; next_cursor uuid;
BEGIN
 IF p_offer_version IS NULL OR char_length(p_offer_version) NOT BETWEEN 1 AND 80
  OR p_offer_version<>btrim(p_offer_version) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  OR (p_mode IS NOT NULL AND p_mode NOT IN ('one_time','subscription'))
  OR (p_cursor IS NOT NULL AND p_expected_head_digest IS NULL)
  OR (p_expected_head_digest IS NOT NULL AND p_expected_head_digest !~ '^[0-9a-f]{64}$') THEN
  RAISE EXCEPTION 'catalog_offer_memberships_page_input_invalid' USING ERRCODE='22023';
 END IF;

 head_digest := public.catalog_publication_read_head();
 IF p_expected_head_digest IS NOT NULL AND head_digest IS DISTINCT FROM p_expected_head_digest THEN
  RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001';
 END IF;
 IF head_digest IS NULL THEN
  RETURN jsonb_build_object('protocol','legacy','headDigest',NULL,'items','[]'::jsonb,'nextCursor',NULL);
 END IF;

 IF NOT EXISTS (SELECT 1 FROM public.catalog_skus s JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
  WHERE s.publication_facts->'memberships' @> jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version))) THEN
  RAISE EXCEPTION 'catalog_offer_memberships_page_input_invalid' USING ERRCODE='22023';
 END IF;
 WITH eligible AS MATERIALIZED (
  SELECT s.id FROM public.catalog_skus s
  JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=p.id
  WHERE s.publication_facts->'memberships' @> jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version,'admitted',true))
   AND s.status='active' AND p.status='active'
   AND ((p_mode IS NULL AND (s.sellable_standalone OR s.sellable_in_subscription))
    OR (p_mode='one_time' AND s.sellable_standalone) OR (p_mode='subscription' AND s.sellable_in_subscription))
   AND (p_cursor IS NULL OR s.id>p_cursor)
  ORDER BY s.id LIMIT p_limit+1
 ), page AS MATERIALIZED (
  SELECT id FROM eligible ORDER BY id LIMIT p_limit
 ), members AS MATERIALIZED (
  SELECT id,public.catalog_publication_read_member(id) AS evidence FROM page
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',id,'skuCode',evidence#>>'{sku,code}',
  'productId',evidence#>>'{product,id}','productSlug',evidence#>>'{product,slug}',
  'productType',evidence#>'{product,type}','netContent',evidence#>'{sku,netContent}','netWeightG',evidence->'netWeightG',
  'sellableStandalone',evidence#>'{sku,sellableStandalone}','sellableInSubscription',evidence#>'{sku,sellableInSubscription}',
  'presentation',evidence#>'{product,presentation}','logisticsRef',evidence#>'{sku,logisticsRef}',
  'head',evidence->'head','skuRevisionId',evidence->'skuRevisionId','document',evidence->'document') ORDER BY id),'[]'::jsonb),
  CASE WHEN (SELECT count(*) FROM eligible)>p_limit THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
 INTO items,next_cursor FROM members;
 RETURN jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items,'nextCursor',next_cursor);
END;
$$;

CREATE FUNCTION public.catalog_publication_activation_readiness(p_sku_codes text[],p_expected_head_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE head_digest text; code text; sku_id uuid; evidence jsonb; reasons jsonb; items jsonb := '[]';
BEGIN
 IF p_sku_codes IS NULL OR cardinality(p_sku_codes) NOT BETWEEN 1 AND 100 OR array_ndims(p_sku_codes)<>1
  OR EXISTS (SELECT 1 FROM unnest(p_sku_codes) AS input(code) WHERE input.code IS NULL)
  OR EXISTS (SELECT 1 FROM unnest(p_sku_codes) AS input(code) WHERE input.code IS NOT NULL GROUP BY input.code HAVING count(*)>1)
  OR EXISTS (SELECT 1 FROM unnest(p_sku_codes) AS input(code) WHERE input.code !~ '^[A-Z0-9][A-Z0-9-]{2,79}$')
  OR p_expected_head_digest IS NULL OR p_expected_head_digest !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'catalog_publication_readiness_input_invalid' USING ERRCODE='22023';
 END IF;

 head_digest := public.catalog_publication_read_head();
 IF head_digest IS NULL THEN
  RAISE EXCEPTION 'catalog_publication_not_adopted' USING ERRCODE='55000';
 END IF;
 IF head_digest<>p_expected_head_digest THEN
  RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001';
 END IF;

 FOREACH code IN ARRAY p_sku_codes LOOP
  SELECT s.id INTO sku_id FROM public.catalog_skus s
  JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
  WHERE s.sku=code;
  IF NOT FOUND THEN
   evidence := NULL;
   reasons := '["sku_not_materialized"]';
  ELSE
   evidence := public.catalog_publication_read_member(sku_id);
   reasons := public.catalog_publication_sku_reasons(sku_id,true);
  END IF;
  items := items || jsonb_build_array(jsonb_build_object('skuCode',code,'skuId',sku_id,
   'ready',jsonb_array_length(reasons)=0,'reasons',reasons,'logisticsRef',evidence#>'{sku,logisticsRef}',
   'evidence',CASE WHEN evidence IS NOT NULL THEN jsonb_build_object('product',evidence->'product','sku',evidence->'sku') END));
 END LOOP;
 RETURN jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items);
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_read_head(), public.catalog_publication_read_member(uuid),
 public.catalog_offer_memberships_page(text,uuid,integer,text,text),
 public.catalog_publication_activation_readiness(text[],text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_offer_memberships_page(text,uuid,integer,text,text), public.catalog_publication_activation_readiness(text[],text), public.catalog_publication_read_head(), public.catalog_publication_read_member(uuid) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_offer_memberships_page(text,uuid,integer,text,text), public.catalog_publication_activation_readiness(text[],text), public.catalog_publication_read_head(), public.catalog_publication_read_member(uuid) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head(), public.catalog_publication_read_member(uuid) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,uuid,integer,text,text), public.catalog_publication_activation_readiness(text[],text) TO service_role;'; END IF; END; $$;
