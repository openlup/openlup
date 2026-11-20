-- Malformed retained bytes are evidence failures, including before deferred admission.
CREATE FUNCTION public.catalog_publication_read_json(p_text text,p_digest text,p_depth integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE body jsonb; max_nesting integer; max_depth CONSTANT integer := public.catalog_publication_max_depth();
BEGIN
 IF p_depth NOT BETWEEN 0 AND max_depth THEN RETURN NULL; END IF;
 max_nesting := coalesce(max_depth-p_depth+1,256);
 IF p_text IS NULL OR (p_digest IS NOT NULL AND p_digest<>encode(sha256(convert_to(p_text,'UTF8')),'hex'))
 THEN RETURN NULL; END IF;
 -- PostgreSQL can raise on excessive nesting before reporting invalid JSON input.
 IF length(p_text)-length(translate(p_text,'[{',''))>max_nesting AND EXISTS (
  SELECT 1 FROM (
   SELECT sum(CASE WHEN bracket[1] IN ('[','{') THEN 1 ELSE -1 END) OVER (ORDER BY position) AS nesting
   FROM regexp_matches(p_text,$tokens$"(?:[^"\\]|\\.)*"|([{}\[\]])$tokens$,'gs') WITH ORDINALITY AS token(bracket,position)
   WHERE bracket[1] IS NOT NULL
  ) depths WHERE nesting>max_nesting
 ) THEN RETURN NULL; END IF;
 IF pg_input_is_valid(p_text,'jsonb') IS DISTINCT FROM true THEN RETURN NULL; END IF;
 body := p_text::jsonb;
 IF p_depth IS NULL THEN RETURN body; END IF;
 IF EXISTS (
  WITH RECURSIVE nodes(key,value,depth) AS (
   SELECT NULL::text,body,p_depth UNION ALL
   SELECT child.key,child.value,n.depth+1 FROM nodes n CROSS JOIN LATERAL (
    SELECT * FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END)
    UNION ALL SELECT NULL,value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END)
   ) child WHERE n.depth<=max_depth
  ) SELECT 1 FROM nodes WHERE depth>max_depth OR key IN ('__proto__','constructor','prototype')
     OR (jsonb_typeof(value)='number' AND NOT pg_input_is_valid(value::text,'double precision'))
 ) THEN RETURN NULL; END IF;
 IF p_text=public.catalog_publication_canonical(body,p_depth) THEN RETURN body; END IF;
 RETURN NULL;
END;
$$;

CREATE FUNCTION public.catalog_publication_read_manifest(p_product uuid,p_text text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE body jsonb := public.catalog_publication_read_json(p_text,p_digest,0);
BEGIN
 IF p_product IS NULL OR jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF body - ARRAY['schemaVersion','product','skus']<>'{}'::jsonb OR body->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR body #> '{product,id}' IS DISTINCT FROM to_jsonb(p_product)
  OR jsonb_typeof(body->'skus') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF jsonb_array_length(body->'skus') NOT BETWEEN 1 AND 10000
  OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(body->'skus') r WHERE r->'skuId'=body #> '{product,primarySkuId}')
  OR EXISTS (SELECT 1 FROM (
   SELECT r,lag(r->>'skuId') OVER (ORDER BY position) AS previous,count(*) OVER (PARTITION BY r->'revisionId') AS copies
   FROM jsonb_array_elements(body->'skus') WITH ORDINALITY AS refs(r,position)
  ) roster WHERE (CASE WHEN jsonb_typeof(r)='object' THEN
   r - ARRAY['skuId','revisionId','revision','digest']='{}'::jsonb
   AND jsonb_typeof(r->'skuId')='string' AND r->>'skuId' COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   AND jsonb_typeof(r->'revisionId')='string' AND r->>'revisionId' COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   AND jsonb_typeof(r->'digest')='string' AND r->>'digest' COLLATE "C" ~ '^[0-9a-f]{64}$'
   AND jsonb_typeof(r->'revision')='number' AND r->>'revision' ~ '^[1-9][0-9]{0,9}$'
   AND pg_input_is_valid(r->>'revision','integer') AND copies=1 AND (previous IS NULL OR previous COLLATE "C"<r->>'skuId' COLLATE "C")
  END) IS DISTINCT FROM true) THEN RETURN NULL; END IF;
 RETURN body;
END;
$$;

-- Look up the sealed ID first, then verify the retained identity and bytes.
CREATE FUNCTION public.catalog_publication_read_sku_revision(p_product uuid,p_reference jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE retained public.catalog_sku_revisions; body jsonb;
BEGIN
 SELECT * INTO retained FROM public.catalog_sku_revisions WHERE id=CASE WHEN pg_input_is_valid(p_reference->>'revisionId','uuid') THEN (p_reference->>'revisionId')::uuid END;
 IF NOT FOUND OR retained.product_id IS DISTINCT FROM p_product
  OR p_reference->'revisionId' IS DISTINCT FROM to_jsonb(retained.id)
  OR p_reference->'skuId' IS DISTINCT FROM to_jsonb(retained.sku_id)
  OR p_reference->'revision' IS DISTINCT FROM to_jsonb(retained.revision)
  OR p_reference->'digest' IS DISTINCT FROM to_jsonb(retained.digest) THEN RETURN NULL; END IF;
 body := public.catalog_publication_read_json(retained.full_facts,retained.digest,3);
 IF body->'id' IS DISTINCT FROM to_jsonb(retained.sku_id) OR body->'productId' IS DISTINCT FROM to_jsonb(p_product)
  OR body->'code' IS DISTINCT FROM to_jsonb(retained.sku_code) OR retained.sku_code COLLATE "C" !~ '^[A-Za-z0-9._:-]{1,160}$'
  OR (body->>'status' IN ('draft','active','archived') AND jsonb_typeof(body->'sellableStandalone')='boolean'
   AND jsonb_typeof(body->'sellableInSubscription')='boolean' AND jsonb_typeof(body->'memberships')='array') IS DISTINCT FROM true
 THEN RETURN NULL; END IF;
 IF EXISTS (SELECT 1 FROM (
   SELECT m,lag(m->>'offerVersion') OVER (ORDER BY position) AS previous
   FROM jsonb_array_elements(body->'memberships') WITH ORDINALITY AS entry(m,position)
  ) memberships WHERE (CASE WHEN jsonb_typeof(m)='object' THEN m - ARRAY['offerVersion','admitted']='{}'::jsonb
   AND public.catalog_publication_text_valid(m->'offerVersion',240,true) AND jsonb_typeof(m->'admitted')='boolean'
   AND (previous IS NULL OR previous COLLATE "C"<m->>'offerVersion' COLLATE "C") END) IS DISTINCT FROM true)
 THEN RETURN NULL; END IF;
 RETURN body;
END;
$$;

CREATE FUNCTION public.catalog_publication_read_head() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE digest text;
BEGIN
 IF EXISTS (SELECT 1 FROM public.catalog_products c
  LEFT JOIN public.catalog_publication_heads h ON h.product_id=c.id
  LEFT JOIN LATERAL (SELECT * FROM public.catalog_publications p WHERE p.product_id=c.id ORDER BY p.revision DESC LIMIT 1) p ON true
  WHERE (h.publication_id,h.revision) IS DISTINCT FROM (p.id,p.revision)
   OR (h.publication_id IS NULL AND (c.publication_facts IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.catalog_skus s WHERE s.product_id=c.id AND s.publication_facts IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.catalog_publication_pointer_capabilities f WHERE f.product_id=c.id)))
   OR (h.publication_id IS NOT NULL AND (c.publication_facts IS NULL OR c.current_document_revision_id IS DISTINCT FROM p.document_revision_id)))
  OR EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE NOT EXISTS (SELECT 1 FROM public.catalog_products c WHERE c.id=h.product_id))
  OR EXISTS (SELECT 1 FROM public.catalog_publications p WHERE NOT EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE h.product_id=p.product_id))
  OR EXISTS (SELECT 1 FROM public.catalog_operator_receipts r WHERE r.kind='publish'
   AND NOT EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE h.product_id=r.scope_id))
  OR EXISTS (SELECT 1 FROM public.catalog_sku_revisions r
   WHERE NOT EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE h.product_id=r.product_id))
  -- A sealed member needs its projection marker even if another product reuses its former live code.
  OR EXISTS (
   WITH manifests AS MATERIALIZED (
    SELECT h.product_id,public.catalog_publication_read_manifest(h.product_id,p.canonical_state,p.digest) AS body
    FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
   ) SELECT 1 FROM manifests m WHERE m.body IS NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(m.body->'skus') r
    LEFT JOIN public.catalog_skus s ON (s.product_id,s.id)=(m.product_id,(r->>'skuId')::uuid)
    WHERE s.publication_facts IS NULL)
  ) THEN
  RETURN jsonb_build_object('kind','refusal','reason','inconsistent_evidence');
 END IF;
 SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(h.product_id,h.publication_id,h.revision,p.digest)
   ORDER BY h.product_id)::text,'UTF8')),'hex') INTO digest
 FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id);
 IF digest IS NULL THEN RETURN jsonb_build_object('kind','legacy'); END IF;
 RETURN jsonb_build_object('kind','governed','headDigest',digest);
END;
$$;

CREATE FUNCTION public.catalog_publication_selected_evidence(p_product uuid,p_sku uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE issue public.catalog_publications; manifest jsonb; product jsonb; sku jsonb; reference jsonb;
 receipt jsonb; head jsonb; previous_head jsonb; document jsonb; document_valid boolean; live_product public.catalog_products; live_sku public.catalog_skus;
 invalid CONSTANT jsonb := '{"kind":"refusal","reason":"inconsistent_evidence"}';
BEGIN
 SELECT p.* INTO issue FROM public.catalog_publication_heads h JOIN public.catalog_publications p
  ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision) WHERE h.product_id=p_product;
 IF NOT FOUND THEN RETURN invalid; END IF;
 manifest := public.catalog_publication_read_manifest(p_product,issue.canonical_state,issue.digest);
 IF manifest IS NULL THEN RETURN invalid; END IF;
 product := manifest->'product';
 head := public.catalog_publication_head_ref(p_product,issue.id);
 previous_head := public.catalog_publication_head_ref(p_product,issue.previous_id);
 IF (issue.revision=1 AND issue.previous_id IS NOT NULL)
  OR (issue.revision>1 AND previous_head->'revision' IS DISTINCT FROM to_jsonb(issue.revision-1))
 THEN RETURN invalid; END IF;
 SELECT public.catalog_publication_read_json(r.result,NULL,0) INTO receipt FROM public.catalog_operator_receipts r
 WHERE (r.scope_id,r.command_key,r.kind,r.publication_id,r.actor_id,r.fingerprint)=
  (p_product,issue.command_key,'publish',issue.id,issue.actor_id,issue.command_fingerprint);
 IF head IS NULL OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN invalid; END IF;
 IF receipt - ARRAY['schemaVersion','productId','commandKey','fingerprint','actorId','head','previousHead','publicationDigest','committedAt','changes']
   IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(receipt->'changes') IS DISTINCT FROM 'array'
  OR jsonb_array_length(CASE WHEN jsonb_typeof(receipt->'changes')='array' THEN receipt->'changes' END)<>issue.issued_count
  OR receipt - 'changes' IS DISTINCT FROM jsonb_build_object('schemaVersion',2,'productId',p_product,'head',head,
   'previousHead',previous_head,'publicationDigest',issue.digest,'commandKey',issue.command_key,
   'fingerprint',issue.command_fingerprint,'actorId',issue.actor_id,
   'committedAt',to_char(issue.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  OR EXISTS (SELECT 1 FROM public.catalog_publication_decisions a WHERE (a.product_id,a.command_key)=(p_product,issue.command_key))
 THEN RETURN invalid; END IF;

 SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
  'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest), (
  SELECT count(*)=1 AND bool_and((
   origin.payload #> '{product,documentRevision}'=product->'document'
   AND coalesce(origin.payload #> '{product,sharedContent,document}',d.document_payload)=d.document_payload
   AND operation->'productSlug'=origin.payload #> '{product,slug}'
   AND operation->'revisionId'=to_jsonb(d.id) AND operation->'revisionNo'=to_jsonb(d.revision_no)
   AND CASE WHEN operation->'provenance'='{"source":"current_draft"}'::jsonb THEN true
     WHEN operation #> '{provenance,source}'='"retained_draft"'::jsonb THEN (operation->'provenance') - 'source'=d.provenance END
   AND operation->'documentRef'=to_jsonb(d.document_ref) AND operation->'sourceRef'=to_jsonb(d.source_ref)
   AND operation->'digest'=to_jsonb(d.digest)
   AND CASE WHEN jsonb_typeof(operation->'canonicalText')='string'
    THEN public.catalog_publication_read_json(operation->>'canonicalText',d.digest,NULL)=d.document_payload END
  ) IS TRUE)
  FROM public.catalog_draft_revisions origin
  JOIN public.catalog_draft_command_receipts r ON (r.draft_id,r.command_key,r.revision,r.fingerprint)=
   (origin.draft_id,origin.command_key,origin.revision,origin.fingerprint)
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(origin.payload #> '{publication,operations}')='array'
   THEN origin.payload #> '{publication,operations}' END) operation
  WHERE origin.product_id=p_product AND origin.status='open' AND d.provenance=jsonb_build_object(
    'draftId',origin.draft_id,'draftRevision',origin.revision,'draftCommandKey',origin.command_key,'draftFingerprint',origin.fingerprint)
   AND operation->>'op'='register_document_revision' AND (operation->'revisionId'=to_jsonb(d.id)
    OR (operation->'productSlug'=origin.payload #> '{product,slug}' AND operation->'revisionNo'=to_jsonb(d.revision_no)))
 ) INTO document,document_valid
 FROM public.catalog_product_document_revisions d WHERE (d.product_id,d.id)=(p_product,issue.document_revision_id);
 IF document_valid IS DISTINCT FROM true OR document IS DISTINCT FROM product->'document'
  OR public.catalog_publication_carriers_valid(jsonb_build_object('document',document),p_product) IS DISTINCT FROM true THEN RETURN invalid; END IF;

 SELECT r INTO reference FROM jsonb_array_elements(manifest->'skus') r WHERE r->'skuId'=to_jsonb(p_sku);
 sku := public.catalog_publication_read_sku_revision(p_product,reference);
 IF (jsonb_typeof(product->'slug')='string' AND product->>'slug'<>''
   AND product->>'status' IN ('draft','active','archived') AND jsonb_typeof(product->'primarySkuId')='string'
   AND (product->'presentation'='null'::jsonb OR public.catalog_publication_presentation_valid(product->'presentation'))
   AND jsonb_typeof(sku->'identifiers')='array'
   AND (sku->'logisticsRef'='null'::jsonb OR public.catalog_publication_text_valid(sku->'logisticsRef',500,true))
   AND CASE WHEN jsonb_typeof(sku->'netContent')='object' THEN public.catalog_publication_quantity_valid(sku->'netContent')
    AND sku #> '{netContent,dimension}'='"mass"'::jsonb AND sku #> '{netContent,unit}'='"openlup:g"'::jsonb
    AND sku #> '{netContent,scale}'='0'::jsonb AND pg_input_is_valid(sku #>> '{netContent,unscaled}','integer') END
   AND (sku->'grossMass'='null'::jsonb OR CASE WHEN jsonb_typeof(sku->'grossMass')='object'
    THEN public.catalog_publication_quantity_valid(sku->'grossMass') END)
 ) IS DISTINCT FROM true THEN RETURN invalid; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(sku->'identifiers') i WHERE jsonb_typeof(i->'isPrimary') IS DISTINCT FROM 'boolean')
  OR (SELECT count(*) FROM jsonb_array_elements(sku->'identifiers') i WHERE i->'isPrimary'='true'::jsonb)>1
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(sku->'identifiers') i WHERE i->'isPrimary'='true'::jsonb
   AND (i->'scheme'='"gs1:gtin"'::jsonb AND i->'packagingLevel'='"unit"'::jsonb AND i->'quantity'='1'::jsonb
    AND public.catalog_publication_text_valid(i->'issuer',240,true) AND jsonb_typeof(i->'value')='string'
    AND CASE WHEN i->>'value' ~ '^([0-9]{8}|[0-9]{12,14})$' THEN (
     SELECT sum(substr(i->>'value',length(i->>'value')-position,1)::integer * CASE WHEN position%2=0 THEN 1 ELSE 3 END)
     FROM generate_series(0,length(i->>'value')-1) position
    ) % 10=0 END) IS DISTINCT FROM true) THEN RETURN invalid; END IF;
 SELECT * INTO live_product FROM public.catalog_products WHERE id=p_product;
 SELECT * INTO live_sku FROM public.catalog_skus WHERE (product_id,id)=(p_product,p_sku);
 IF (live_product.publication_facts,live_product.slug,live_product.status,live_product.current_document_revision_id,live_product.primary_sku_id::text,
     live_sku.publication_facts,live_sku.sku,live_sku.status,live_sku.sellable_standalone,live_sku.sellable_in_subscription,live_sku.net_weight_g::text,
     live_sku.gross_mass_dimension,live_sku.gross_mass_unit,live_sku.gross_mass_scale::text,live_sku.gross_mass_unscaled)
  IS DISTINCT FROM (product,product->>'slug',product->>'status',issue.document_revision_id,product->>'primarySkuId',
     sku,sku->>'code',sku->>'status',(sku->>'sellableStandalone')::boolean,(sku->>'sellableInSubscription')::boolean,sku #>> '{netContent,unscaled}',
     sku #>> '{grossMass,dimension}',sku #>> '{grossMass,unit}',sku #>> '{grossMass,scale}',(sku #>> '{grossMass,unscaled}')::numeric)
  OR (SELECT jsonb_build_array(i.issuer,i.normalized_value) FROM public.catalog_sku_identifiers i
      WHERE i.catalog_sku_id=p_sku AND i.identifier_kind='gtin' AND i.pack_kind='unit' AND i.is_primary)
    IS DISTINCT FROM (SELECT jsonb_build_array(i->>'issuer',lpad(i->>'value',14,'0'))
      FROM jsonb_array_elements(sku->'identifiers') i WHERE i->'isPrimary'='true'::jsonb)
 THEN RETURN invalid || '{"detail":"catalog_publication_live_drift"}'::jsonb; END IF;
 RETURN jsonb_build_object('kind','evidence','head',head,'document',document,'skuRevision',reference,'product',product,'sku',sku);
END;
$$;

CREATE FUNCTION public.catalog_offer_memberships_page(p_offer_version text,p_cursor jsonb,p_limit integer,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE authority jsonb; head_digest text; items jsonb; failed jsonb; next_id uuid; after_id uuid;
 invalid_projection boolean; live_drift boolean; offer_known boolean;
 admitted jsonb := jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version,'admitted',true));
 denied jsonb := jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version,'admitted',false));
 invalid CONSTANT jsonb := '{"kind":"refusal","reason":"invalid_request"}';
BEGIN
 IF public.catalog_publication_text_valid(to_jsonb(p_offer_version),240,true) IS DISTINCT FROM true
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_mode NOT IN ('one_time','subscription') THEN RETURN invalid; END IF;
 IF p_cursor IS NOT NULL THEN
  IF jsonb_typeof(p_cursor) IS DISTINCT FROM 'object' THEN RETURN invalid; END IF;
  IF p_cursor - ARRAY['skuId','headDigest','offerVersion','mode'] <> '{}'::jsonb
   OR (jsonb_typeof(p_cursor->'skuId')='string' AND p_cursor->>'skuId' COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS DISTINCT FROM true
   OR (jsonb_typeof(p_cursor->'headDigest')='string' AND p_cursor->>'headDigest' COLLATE "C" ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
   OR p_cursor->'offerVersion' IS DISTINCT FROM to_jsonb(p_offer_version)
   OR p_cursor->'mode' IS DISTINCT FROM coalesce(to_jsonb(p_mode),'null'::jsonb) THEN RETURN invalid; END IF;
  after_id := (p_cursor->>'skuId')::uuid;
 END IF;
 authority := public.catalog_publication_read_head();
 IF authority->>'kind'='refusal' THEN RETURN authority; END IF;
 head_digest := authority->>'headDigest';
 IF p_cursor IS NOT NULL AND head_digest IS DISTINCT FROM p_cursor->>'headDigest' THEN
  RETURN '{"kind":"refusal","reason":"head_moved"}'::jsonb;
 END IF;
 IF authority->>'kind'='legacy' THEN
  RETURN '{"kind":"page","value":{"protocol":"legacy","headDigest":null,"items":[],"nextCursor":null}}'::jsonb;
 END IF;
 -- The head reader authenticated these manifests in the same statement snapshot.
 -- Check both directions before trusting live offer existence or page filters.
 WITH sealed AS MATERIALIZED (
  SELECT h.product_id,(r->>'skuId')::uuid AS sku_id,m.body #> '{product,status}' AS product_status,
   f.memberships,f.status AS sku_status,f."sellableStandalone" AS standalone,f."sellableInSubscription" AS subscription
  FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
  CROSS JOIN LATERAL (SELECT p.canonical_state::jsonb AS body) m
  CROSS JOIN LATERAL jsonb_array_elements(m.body->'skus') r
  LEFT JOIN LATERAL jsonb_to_record(public.catalog_publication_read_sku_revision(h.product_id,r))
   AS f(memberships jsonb,status jsonb,"sellableStandalone" jsonb,"sellableInSubscription" jsonb) ON true
 ), live AS (
  SELECT s.product_id,s.id AS sku_id,s.publication_facts->'memberships' AS memberships,to_jsonb(p.status) AS product_status,
   to_jsonb(s.status) AS sku_status,to_jsonb(s.sellable_standalone) AS standalone,to_jsonb(s.sellable_in_subscription) AS subscription
  FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
  WHERE s.publication_facts->'memberships' @> admitted OR s.publication_facts->'memberships' @> denied
 )
 SELECT bool_or(s.sku_id IS NOT NULL AND (s.memberships IS NULL OR
   (s.product_status IN ('"draft"'::jsonb,'"active"'::jsonb,'"archived"'::jsonb)) IS DISTINCT FROM true)),
  bool_or(coalesce(s.memberships @> admitted OR s.memberships @> denied,false) IS DISTINCT FROM (l.sku_id IS NOT NULL)
   OR (l.sku_id IS NOT NULL AND (l.memberships,l.product_status,l.sku_status,l.standalone,l.subscription)
    IS DISTINCT FROM (s.memberships,s.product_status,s.sku_status,s.standalone,s.subscription))),
  count(l.sku_id)>0
 INTO invalid_projection,live_drift,offer_known FROM sealed s FULL JOIN live l USING (product_id,sku_id);
 IF invalid_projection THEN RETURN '{"kind":"refusal","reason":"inconsistent_evidence"}'::jsonb; END IF;
 IF live_drift THEN RETURN '{"kind":"refusal","reason":"inconsistent_evidence","detail":"catalog_publication_live_drift"}'::jsonb; END IF;
 IF NOT offer_known THEN
  RETURN '{"kind":"refusal","reason":"unknown_offer"}'::jsonb;
 END IF;
 WITH eligible AS MATERIALIZED (
  SELECT s.id,s.product_id,s.net_weight_g FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=p.id
  WHERE s.publication_facts->'memberships' @> admitted AND s.status='active' AND p.status='active'
   AND ((p_mode IS DISTINCT FROM 'subscription' AND s.sellable_standalone) OR (p_mode IS DISTINCT FROM 'one_time' AND s.sellable_in_subscription))
   AND (after_id IS NULL OR s.id>after_id) ORDER BY s.id LIMIT p_limit+1
 ), page AS MATERIALIZED (
  SELECT * FROM eligible ORDER BY id LIMIT p_limit
 ), members AS MATERIALIZED (
  SELECT *,public.catalog_publication_selected_evidence(product_id,id) AS e FROM page
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',id,'productId',product_id,'skuCode',e#>'{sku,code}',
  'productSlug',e#>'{product,slug}','netWeightG',net_weight_g,'sellableStandalone',e#>'{sku,sellableStandalone}',
  'sellableInSubscription',e#>'{sku,sellableInSubscription}','presentation',e#>'{product,presentation}',
  'logisticsRef',e#>'{sku,logisticsRef}','head',e->'head','document',e->'document','skuRevision',e->'skuRevision') ORDER BY id)
  FILTER (WHERE e->>'kind'='evidence'),'[]'::jsonb),
  (array_agg(coalesce(e,'{"kind":"refusal","reason":"inconsistent_evidence"}'::jsonb) ORDER BY id)
   FILTER (WHERE e->>'kind' IS DISTINCT FROM 'evidence'))[1],
  CASE WHEN (SELECT count(*) FROM eligible)>p_limit THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
 INTO items,failed,next_id FROM members;
 IF failed IS NOT NULL THEN RETURN failed; END IF;
 RETURN jsonb_build_object('kind','page','value',jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items,'nextCursor',
  CASE WHEN next_id IS NOT NULL THEN jsonb_build_object('skuId',next_id,'headDigest',head_digest,'offerVersion',p_offer_version,'mode',p_mode) END));
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_read_json(text,text,integer), public.catalog_publication_read_manifest(uuid,text,text),
 public.catalog_publication_read_sku_revision(uuid,jsonb), public.catalog_publication_read_head(),
 public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_json(text,text,integer), public.catalog_publication_read_manifest(uuid,text,text), public.catalog_publication_read_sku_revision(uuid,jsonb), public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_json(text,text,integer), public.catalog_publication_read_manifest(uuid,text,text), public.catalog_publication_read_sku_revision(uuid,jsonb), public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_json(text,text,integer), public.catalog_publication_read_manifest(uuid,text,text), public.catalog_publication_read_sku_revision(uuid,jsonb), public.catalog_publication_read_head(), public.catalog_publication_selected_evidence(uuid,uuid), public.catalog_offer_memberships_page(text,jsonb,integer,text) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,jsonb,integer,text) TO service_role;'; END IF; END; $$;
