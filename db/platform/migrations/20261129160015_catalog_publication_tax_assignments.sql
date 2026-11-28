CREATE FUNCTION public.catalog_publication_read_head_manifests(p_product_ids uuid[] DEFAULT NULL)
RETURNS TABLE (product_id uuid, canonical_state text, digest text,
               publication_id uuid, publication_revision integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 product_key uuid;
 marked boolean;
 document_id uuid;
 head public.catalog_publication_heads;
 issue public.catalog_publications;
 latest record;
BEGIN
 IF p_product_ids IS NULL THEN
  IF EXISTS (
   SELECT 1 FROM public.catalog_publication_heads h
   LEFT JOIN public.catalog_publications p ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision)
   WHERE p.canonical_state IS NULL OR p.canonical_state='' OR p.digest IS NULL OR p.digest=''
  ) THEN
   RAISE EXCEPTION USING ERRCODE='PCA01', MESSAGE='catalog_publication_head_manifest_missing';
  END IF;
  RETURN QUERY
   SELECT h.product_id,p.canonical_state,p.digest,h.publication_id,h.revision
   FROM public.catalog_publication_heads h
   JOIN public.catalog_publications p ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision)
   ORDER BY h.product_id;
  RETURN;
 END IF;

 FOR product_key IN SELECT DISTINCT id FROM unnest(p_product_ids) AS keys(id) WHERE id IS NOT NULL ORDER BY id LOOP
  SELECT c.publication_facts IS NOT NULL,c.current_document_revision_id INTO marked,document_id
   FROM public.catalog_products c WHERE c.id=product_key;
  SELECT h.* INTO head FROM public.catalog_publication_heads h WHERE h.product_id=product_key;
  IF head.product_id IS NOT NULL THEN
   SELECT p.* INTO issue FROM public.catalog_publications p
    WHERE (p.product_id,p.id,p.revision)=(product_key,head.publication_id,head.revision);
   IF issue.canonical_state IS NULL OR issue.canonical_state='' OR issue.digest IS NULL OR issue.digest='' THEN
    RAISE EXCEPTION USING ERRCODE='PCA01', MESSAGE='catalog_publication_head_manifest_missing';
   END IF;
  END IF;
  SELECT p.id,p.revision INTO latest FROM public.catalog_publications p
   WHERE p.product_id=product_key ORDER BY p.revision DESC LIMIT 1;
  IF (head.publication_id,head.revision) IS DISTINCT FROM (latest.id,latest.revision)
   OR (head.product_id IS NULL AND marked IS TRUE)
   OR (head.product_id IS NOT NULL AND (marked IS DISTINCT FROM true OR document_id IS DISTINCT FROM issue.document_revision_id)) THEN
   RAISE EXCEPTION USING ERRCODE='PCA03', MESSAGE='catalog_publication_selected_evidence_invalid';
  END IF;
  IF head.product_id IS NOT NULL THEN
   product_id := product_key;
   canonical_state := issue.canonical_state;
   digest := issue.digest;
   publication_id := head.publication_id;
   publication_revision := head.revision;
   RETURN NEXT;
  END IF;
 END LOOP;
END;
$$;

CREATE FUNCTION public.catalog_publication_locate_sku_products(p_sku_ids uuid[])
RETURNS TABLE (sku_id uuid, product_id uuid, publication_marked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE retained_product uuid;
BEGIN
 FOR sku_id IN SELECT DISTINCT id FROM unnest(p_sku_ids) AS keys(id) WHERE id IS NOT NULL ORDER BY id LOOP
  SELECT s.product_id,s.publication_facts IS NOT NULL INTO product_id,publication_marked
   FROM public.catalog_skus s WHERE s.id=sku_id;
  SELECT r.product_id INTO retained_product FROM public.catalog_sku_revisions r
   WHERE r.sku_id=catalog_publication_locate_sku_products.sku_id ORDER BY r.revision DESC LIMIT 1;
  publication_marked := coalesce(publication_marked,false);
  IF publication_marked IS DISTINCT FROM (retained_product IS NOT NULL)
   OR (retained_product IS NOT NULL AND retained_product IS DISTINCT FROM product_id) THEN
   RAISE EXCEPTION USING ERRCODE='PCA03', MESSAGE='catalog_publication_selected_evidence_invalid';
  END IF;
  RETURN NEXT;
 END LOOP;
END;
$$;

CREATE FUNCTION public.catalog_publication_tax_assignments(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 invalid CONSTANT jsonb := jsonb_build_object('kind','refused','code','tax_invalid_input','field','/plan/skus',
  'remedy','Supply the documented published SKU selection and its selection digest, then repeat the read.');
 inconsistent CONSTANT jsonb := jsonb_build_object('kind','refused','code','catalog_tax_assignment_evidence_invalid','field','/plan/skus',
  'remedy','Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read.');
 unpublished CONSTANT jsonb := jsonb_build_object('kind','refused','code','catalog_tax_assignment_unpublished','field','/plan/skus',
  'remedy','Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote.');
 uuid_pattern CONSTANT text := '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
 expected jsonb;
 pairs jsonb;
 requested_ids uuid[];
 product_heads jsonb;
 selection_digest text;
 invalid_evidence boolean;
 selected jsonb;
 item record;
 retained jsonb;
 installed public.catalog_type_versions;
 class_key text;
 class_status text;
 assignment_ref text;
 assignments jsonb := '[]';
 mismatched_code boolean := false;
 retired_class boolean := false;
BEGIN
 IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN RETURN invalid; END IF;
 IF p_request - ARRAY['expectedSelectionDigest','skus'] <> '{}' THEN RETURN invalid; END IF;

 expected := p_request->'expectedSelectionDigest';
 IF (expected='null' OR (jsonb_typeof(expected)='string' AND (expected #>> '{}') COLLATE "C" ~ '^[0-9a-f]{64}$')) IS DISTINCT FROM true THEN
  RETURN invalid || '{"field":"/plan/expectedSelectionDigest"}';
 END IF;

 pairs := p_request->'skus';
 IF jsonb_typeof(pairs) IS DISTINCT FROM 'array' THEN RETURN invalid; END IF;
 IF jsonb_array_length(pairs) NOT BETWEEN 1 AND 50 OR EXISTS (
  SELECT 1 FROM (
   SELECT pair, count(*) OVER (PARTITION BY pair->'skuId') AS ids, count(*) OVER (PARTITION BY pair->'sku') AS codes
   FROM jsonb_array_elements(pairs) AS rows(pair)
  ) checked WHERE (CASE WHEN jsonb_typeof(pair)='object' THEN
   pair - ARRAY['skuId','sku']='{}' AND jsonb_typeof(pair->'skuId')='string' AND pair->>'skuId' COLLATE "C" ~ uuid_pattern
   AND jsonb_typeof(pair->'sku')='string' AND pair->>'sku' COLLATE "C" ~ '^[A-Za-z0-9._:-]{1,160}$'
   AND ids=1 AND codes=1 END) IS DISTINCT FROM true
 ) THEN RETURN invalid; END IF;

 SELECT array_agg((pair->>'skuId')::uuid ORDER BY (pair->>'skuId')::uuid) INTO requested_ids
 FROM jsonb_array_elements(pairs) AS rows(pair);
 BEGIN
  WITH located AS MATERIALIZED (
   SELECT * FROM public.catalog_publication_locate_sku_products(requested_ids)
  ), manifests AS MATERIALIZED (
   SELECT h.*,public.catalog_publication_read_manifest(h.product_id,h.canonical_state,h.digest) AS body
   FROM public.catalog_publication_read_head_manifests(ARRAY(SELECT DISTINCT l.product_id FROM located l WHERE l.product_id IS NOT NULL)) h
  ), matches AS MATERIALIZED (
   SELECT l.sku_id,m.product_id,m.publication_id,m.publication_revision,r.reference,
    m.body #> '{product,type}' AS product_type,m.body #>> '{product,definitionDigest}' AS definition_digest,
    m.body->'schemaVersion'='3' AS verify_digest,s.pair->>'sku' AS requested_code
   FROM manifests m CROSS JOIN LATERAL jsonb_array_elements(m.body->'skus') AS r(reference)
   JOIN located l ON l.sku_id=(r.reference->>'skuId')::uuid
   JOIN jsonb_array_elements(pairs) AS s(pair) ON (s.pair->>'skuId')::uuid=l.sku_id
  )
  SELECT EXISTS (SELECT 1 FROM manifests WHERE body IS NULL) OR EXISTS (
    SELECT 1 FROM located l LEFT JOIN matches m USING (sku_id)
    GROUP BY l.sku_id,l.product_id,l.publication_marked
    HAVING count(m.product_id)<>CASE WHEN l.publication_marked THEN 1 ELSE 0 END
      OR bool_or(m.product_id IS DISTINCT FROM l.product_id) FILTER (WHERE m.product_id IS NOT NULL)
   ),
   (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.sku_id),'[]') FROM matches m),
   (SELECT jsonb_agg(jsonb_build_array(m.product_id,m.publication_id,m.publication_revision,m.digest) ORDER BY m.product_id)
    FROM manifests m)
  INTO invalid_evidence,selected,product_heads;
 EXCEPTION WHEN SQLSTATE 'PCA01' OR SQLSTATE 'PCA03' THEN
  IF (SQLSTATE,SQLERRM) IN (('PCA01','catalog_publication_head_manifest_missing'),
   ('PCA03','catalog_publication_selected_evidence_invalid')) THEN RETURN inconsistent; END IF;
  RAISE;
 END;
 IF invalid_evidence THEN RETURN inconsistent; END IF;
 IF selected='[]' THEN RETURN unpublished; END IF;
 selection_digest := encode(sha256(convert_to(
  jsonb_build_array('catalog-tax-assignment-selection',1,requested_ids,product_heads)::text,'UTF8')),'hex');
 IF expected<>'null' AND expected IS DISTINCT FROM to_jsonb(selection_digest) THEN
  RETURN jsonb_build_object('kind','refused','code','catalog_tax_assignment_head_changed','field','/plan/expectedSelectionDigest',
   'remedy','Read the published selection again and request a fresh quote.');
 END IF;

 FOR item IN SELECT * FROM jsonb_to_recordset(selected) AS rows(
  sku_id uuid, product_id uuid, publication_id uuid, publication_revision integer, reference jsonb, requested_code text,
  product_type jsonb, definition_digest text, verify_digest boolean
 ) ORDER BY sku_id LOOP
  retained := public.catalog_publication_read_sku_revision(item.product_id,item.reference);
  IF retained IS NULL OR jsonb_typeof(item.product_type) IS DISTINCT FROM 'object' THEN RETURN inconsistent; END IF;
  IF (item.product_type - ARRAY['key','version']='{}'
   AND jsonb_typeof(item.product_type->'key')='string' AND length(item.product_type->>'key')<=120
   AND item.product_type->>'key' COLLATE "C" ~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
   AND jsonb_typeof(item.product_type->'version')='number'
   AND item.product_type->>'version' COLLATE "C" ~ '^[1-9][0-9]{0,9}$'
   AND pg_input_is_valid(item.product_type->>'version','integer')) IS DISTINCT FROM true THEN RETURN inconsistent; END IF;

  SELECT * INTO installed FROM public.catalog_type_versions t
   WHERE t.type_key=item.product_type->>'key' AND t.version=(item.product_type->>'version')::integer;
  IF NOT FOUND OR (item.verify_digest AND item.definition_digest IS DISTINCT FROM installed.definition_digest) THEN
   RETURN inconsistent;
  END IF;

  class_key := NULL;
  assignment_ref := NULL;
  IF installed.definition ? 'taxClass' THEN
   IF public.catalog_publication_text_valid(installed.definition->'taxClass',120,false) IS DISTINCT FROM true THEN
    RETURN inconsistent;
   END IF;
   class_key := installed.definition->>'taxClass';
   SELECT status INTO class_status FROM public.catalog_tax_classes c WHERE c.key=class_key;
   IF NOT FOUND THEN RETURN inconsistent; END IF;
   retired_class := retired_class OR class_status='retired';
   assignment_ref := format('catalog-assignment:%s:%s:%s:%s',
    selection_digest,item.publication_id,item.publication_revision,item.reference->>'revisionId');
  END IF;

  mismatched_code := mismatched_code OR item.requested_code IS DISTINCT FROM retained->>'code';
  assignments := assignments || jsonb_build_object('skuId',item.reference->'skuId','sku',retained->'code',
   'classState',CASE WHEN class_key IS NULL THEN 'none' ELSE 'assigned' END,'taxClassKey',class_key,'assignmentRef',assignment_ref);
 END LOOP;

 IF mismatched_code THEN RETURN invalid; END IF;
 IF jsonb_array_length(assignments)<jsonb_array_length(pairs) THEN RETURN unpublished; END IF;
 IF retired_class THEN
  RETURN jsonb_build_object('kind','refused','code','tax_class_missing','field','/plan/skus',
   'remedy','Choose published merchandise whose product type declares an active tax class, or have the catalogue owner publish replacement merchandise with such a type, then request a fresh quote.');
 END IF;
 RETURN jsonb_build_object('kind','published','revision',selection_digest,'assignments',assignments);
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(uuid[]), public.catalog_publication_locate_sku_products(uuid[]), public.catalog_publication_tax_assignments(jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(uuid[]), public.catalog_publication_locate_sku_products(uuid[]), public.catalog_publication_tax_assignments(jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(uuid[]), public.catalog_publication_locate_sku_products(uuid[]), public.catalog_publication_tax_assignments(jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(uuid[]), public.catalog_publication_locate_sku_products(uuid[]), public.catalog_publication_tax_assignments(jsonb) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_publication_tax_assignments(jsonb) TO service_role;'; END IF; END; $$;
