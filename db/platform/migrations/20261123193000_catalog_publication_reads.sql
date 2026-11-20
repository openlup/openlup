CREATE FUNCTION public.catalog_publication_read_head() RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.catalog_products p WHERE p.publication_facts IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE h.product_id=p.id))
  OR EXISTS (SELECT 1 FROM public.catalog_publications p
   WHERE NOT EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE h.product_id=p.product_id))
  OR EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE NOT EXISTS (
   SELECT 1 FROM public.catalog_publications p WHERE (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision))) THEN
  RAISE EXCEPTION 'catalog_publication_head_invalid' USING ERRCODE='23514';
 END IF;
 PERFORM public.catalog_publication_assert_head(h.product_id,true) FROM public.catalog_publication_heads h;
 RETURN (SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(h.product_id,h.publication_id,h.revision,p.digest)
   ORDER BY h.product_id)::text,'UTF8')),'hex')
  FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id));
END;
$$;

CREATE FUNCTION public.catalog_publication_selected_evidence(p_product uuid,p_sku uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE issue public.catalog_publications; manifest jsonb; product jsonb; sku jsonb; reference jsonb;
 receipt jsonb; head jsonb; document jsonb; document_valid boolean; live_product public.catalog_products; live_sku public.catalog_skus;
BEGIN
 SELECT p.* INTO STRICT issue FROM public.catalog_publication_heads h JOIN public.catalog_publications p
  ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision) WHERE h.product_id=p_product;
 manifest := public.catalog_publication_manifest_text(p_product,issue.canonical_state,issue.digest,false)::jsonb;
 product := manifest->'product';
 head := public.catalog_publication_head_ref(p_product,issue.id);
 receipt := public.catalog_publication_assert_receipt(p_product,issue.command_key)::jsonb;
 SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
  'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest), EXISTS (
   SELECT 1 FROM public.catalog_draft_revisions origin
   CROSS JOIN LATERAL jsonb_array_elements(origin.payload#>'{publication,operations}') operation
   WHERE origin.product_id=p_product AND origin.draft_id::text=d.provenance->>'draftId'
    AND origin.revision::text=d.provenance->>'draftRevision' AND origin.fingerprint=d.provenance->>'draftFingerprint'
    AND operation->>'op'='register_document_revision' AND operation->>'revisionId'=d.id::text
    AND encode(sha256(convert_to(operation->>'canonicalText','UTF8')),'hex')=d.digest
    AND (operation->>'canonicalText')::jsonb=d.document_payload
  ) INTO STRICT document,document_valid
 FROM public.catalog_product_document_revisions d WHERE (d.product_id,d.id)=(p_product,issue.document_revision_id);
 IF NOT document_valid OR document IS DISTINCT FROM product->'document' OR receipt->'head' IS DISTINCT FROM head
  OR receipt->>'productId' IS DISTINCT FROM p_product::text OR receipt->>'publicationDigest' IS DISTINCT FROM issue.digest
  OR receipt->>'commandKey' IS DISTINCT FROM issue.command_key OR receipt->>'fingerprint' IS DISTINCT FROM issue.command_fingerprint
  OR receipt->>'actorId' IS DISTINCT FROM issue.actor_id::text
  OR receipt->>'committedAt' IS DISTINCT FROM to_char(issue.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') THEN
  RAISE EXCEPTION 'catalog_publication_selected_evidence_invalid' USING ERRCODE='23514';
 END IF;
 SELECT member INTO STRICT reference FROM jsonb_array_elements(manifest->'skus') member WHERE member->>'skuId'=p_sku::text;
 SELECT public.catalog_publication_sku_facts(r) INTO STRICT sku FROM public.catalog_sku_revisions r
 WHERE (r.product_id,r.sku_id,r.id,r.revision,r.digest)=
  (p_product,p_sku,(reference->>'revisionId')::uuid,(reference->>'revision')::integer,reference->>'digest');
 SELECT * INTO STRICT live_product FROM public.catalog_products WHERE id=p_product;
 SELECT * INTO STRICT live_sku FROM public.catalog_skus WHERE (product_id,id)=(p_product,p_sku);
 IF (live_product.publication_facts,live_product.slug,live_product.status,live_product.current_document_revision_id,live_product.primary_sku_id,
     live_sku.publication_facts,live_sku.sku,live_sku.status,live_sku.sellable_standalone,live_sku.sellable_in_subscription,live_sku.net_weight_g::text,
     live_sku.gross_mass_dimension,live_sku.gross_mass_unit,live_sku.gross_mass_scale::text,live_sku.gross_mass_unscaled)
  IS DISTINCT FROM (product,product->>'slug',product->>'status',issue.document_revision_id,(product->>'primarySkuId')::uuid,
     sku,sku->>'code',sku->>'status',(sku->>'sellableStandalone')::boolean,(sku->>'sellableInSubscription')::boolean,sku#>>'{netContent,unscaled}',
     sku#>>'{grossMass,dimension}',sku#>>'{grossMass,unit}',sku#>>'{grossMass,scale}',(sku#>>'{grossMass,unscaled}')::numeric)
  OR (SELECT jsonb_build_array(i.issuer,i.normalized_value) FROM public.catalog_sku_identifiers i
      WHERE i.catalog_sku_id=p_sku AND i.identifier_kind='gtin' AND i.pack_kind='unit' AND i.is_primary)
    IS DISTINCT FROM (SELECT jsonb_build_array(i->>'issuer',lpad(i->>'value',14,'0'))
      FROM jsonb_array_elements(sku->'identifiers') i WHERE i->'isPrimary'='true'::jsonb)
  OR sku#>>'{netContent,dimension}' <> 'mass' OR sku#>>'{netContent,unit}' <> 'openlup:g' OR sku#>>'{netContent,scale}' <> '0' THEN
  RAISE EXCEPTION 'catalog_publication_live_drift' USING ERRCODE='40001';
 END IF;
 RETURN jsonb_build_object('head',head,'document',document,'skuRevision',reference,'product',product,'sku',sku);
END;
$$;

CREATE FUNCTION public.catalog_offer_memberships_page(p_offer_version text,p_cursor jsonb,p_limit integer,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE head_digest text; items jsonb; next_id uuid; membership jsonb := jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version,'admitted',true));
BEGIN
 IF public.catalog_publication_text_valid(to_jsonb(p_offer_version),240,true) IS DISTINCT FROM true
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_mode NOT IN ('one_time','subscription')
  OR (p_cursor IS NOT NULL AND (jsonb_typeof(p_cursor)<>'object' OR NOT p_cursor ?& ARRAY['skuId','headDigest','offerVersion','mode']
   OR p_cursor - ARRAY['skuId','headDigest','offerVersion','mode'] <> '{}'::jsonb
   OR (p_cursor->>'skuId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS DISTINCT FROM true
   OR (p_cursor->>'headDigest' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true OR jsonb_typeof(p_cursor->'headDigest')<>'string'
   OR p_cursor->'offerVersion' IS DISTINCT FROM to_jsonb(p_offer_version)
   OR p_cursor->'mode' IS DISTINCT FROM coalesce(to_jsonb(p_mode),'null'::jsonb))) THEN
  RAISE EXCEPTION 'catalog_offer_memberships_page_input_invalid' USING ERRCODE='22023';
 END IF;
 head_digest := public.catalog_publication_read_head();
 IF p_cursor IS NOT NULL AND head_digest IS DISTINCT FROM p_cursor->>'headDigest' THEN
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
  SELECT s.id,s.product_id,s.net_weight_g FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=p.id
  WHERE s.publication_facts->'memberships' @> membership AND s.status='active' AND p.status='active'
   AND ((p_mode IS DISTINCT FROM 'subscription' AND s.sellable_standalone) OR (p_mode IS DISTINCT FROM 'one_time' AND s.sellable_in_subscription))
   AND (p_cursor IS NULL OR s.id>(p_cursor->>'skuId')::uuid) ORDER BY s.id LIMIT p_limit+1
 ), page AS MATERIALIZED (
  SELECT * FROM eligible ORDER BY id LIMIT p_limit
 ), members AS MATERIALIZED (
  SELECT *,public.catalog_publication_selected_evidence(product_id,id) AS e FROM page
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',id,'productId',product_id,'skuCode',e#>'{sku,code}',
  'productSlug',e#>'{product,slug}','netWeightG',net_weight_g,'sellableStandalone',e#>'{sku,sellableStandalone}',
  'sellableInSubscription',e#>'{sku,sellableInSubscription}','presentation',e#>'{product,presentation}',
  'logisticsRef',e#>'{sku,logisticsRef}','head',e->'head','document',e->'document','skuRevision',e->'skuRevision') ORDER BY id),'[]'::jsonb),
  CASE WHEN (SELECT count(*) FROM eligible)>p_limit THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
 INTO items,next_id FROM members;
 -- Selected evidence checks equality to every live predicate used above.
 RETURN jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items,'nextCursor',
  CASE WHEN next_id IS NOT NULL THEN jsonb_build_object('skuId',next_id,'headDigest',head_digest,'offerVersion',p_offer_version,'mode',p_mode) END);
END;
$$;

CREATE FUNCTION public.catalog_publication_activation_readiness(p_sku_codes text[],p_expected_head_digest text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE head_digest text; items jsonb := '[]'; subject record; evidence jsonb; context jsonb;
 region text; currency text; at_time timestamptz; selected_list uuid; primary_present boolean; price_shape_invalid boolean;
BEGIN
 IF p_sku_codes IS NULL OR cardinality(p_sku_codes) NOT BETWEEN 1 AND 100 OR array_ndims(p_sku_codes)<>1
  OR EXISTS (SELECT 1 FROM unnest(p_sku_codes) AS input(code) WHERE code IS NULL OR code !~ '^[A-Za-z0-9._:-]{1,160}$')
  OR cardinality(p_sku_codes)<>(SELECT count(DISTINCT code COLLATE "C") FROM unnest(p_sku_codes) AS input(code))
  OR p_expected_head_digest IS NULL OR p_expected_head_digest !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'catalog_publication_readiness_input_invalid' USING ERRCODE='22023';
 END IF;
 -- Read committed takes its evidence snapshot after the writer fence. The
 -- native owner lane already holds this lock before its repeatable snapshot.
 LOCK TABLE public.catalog_products IN SHARE MODE;
 head_digest := public.catalog_publication_read_head();
 IF head_digest IS NULL THEN RAISE EXCEPTION 'catalog_publication_not_adopted' USING ERRCODE='55000'; END IF;
 IF head_digest<>p_expected_head_digest THEN RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001'; END IF;
 FOR subject IN
  SELECT input.code,s.id,s.product_id FROM unnest(p_sku_codes) WITH ORDINALITY input(code,position)
  LEFT JOIN (public.catalog_skus s JOIN public.catalog_publication_heads h ON h.product_id=s.product_id)
   ON s.sku COLLATE "C"=input.code COLLATE "C" ORDER BY input.position
 LOOP
  evidence := NULL; primary_present := NULL; price_shape_invalid := NULL;
  IF subject.id IS NOT NULL THEN
   evidence := public.catalog_publication_selected_evidence(subject.product_id,subject.id);
   IF context IS NULL THEN
    region := public.catalog_price_setup_region_code(); currency := public.catalog_price_setup_settlement_currency();
    at_time := date_trunc('milliseconds',clock_timestamp());
    context := jsonb_build_object('regionCode',region,'currency',currency,'atTime',at_time);
    SELECT (array_agg(id))[1] INTO selected_list FROM public.price_lists WHERE region_code=region
     AND price_lists.currency=context->>'currency' AND status='active' AND valid_from<=at_time AND (valid_to IS NULL OR valid_to>at_time) HAVING count(*)=1;
   END IF;
   SELECT EXISTS (SELECT 1 FROM public.catalog_skus s WHERE (s.product_id,s.id)=
     (subject.product_id,(evidence#>>'{product,primarySkuId}')::uuid) AND s.status<>'archived'),
    EXISTS (SELECT 1 FROM public.price_entries e WHERE e.price_list_id=selected_list AND e.variant_id=subject.id
     AND e.active AND e.valid_from<=at_time AND (e.valid_to IS NULL OR e.valid_to>at_time)
     AND (e.mode='any' OR e.amount_kind<>'gross' OR e.min_qty<>1))
   INTO primary_present,price_shape_invalid;
  END IF;
  items := items || jsonb_build_array(jsonb_build_object('skuCode',subject.code,'evidence',evidence,
   'primaryPresent',primary_present,'priceShapeInvalid',price_shape_invalid));
 END LOOP;
 RETURN jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items,'context',context);
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid),
 public.catalog_offer_memberships_page(text,jsonb,integer,text), public.catalog_publication_activation_readiness(text[],text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text), public.catalog_publication_activation_readiness(text[],text) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text), public.catalog_publication_activation_readiness(text[],text) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text), public.catalog_publication_activation_readiness(text[],text) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,jsonb,integer,text), public.catalog_publication_activation_readiness(text[],text) TO service_role;'; END IF; END; $$;
