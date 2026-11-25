CREATE FUNCTION public.catalog_publication_read_head_manifests()
RETURNS TABLE (product_id uuid, canonical_state text, digest text,
               publication_id uuid, publication_revision integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
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
  LEFT JOIN public.catalog_publications p ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision)
  ORDER BY h.product_id;
END;
$$;

CREATE FUNCTION public.catalog_publication_tax_assignments(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 invalid CONSTANT jsonb := jsonb_build_object('kind','refused','code','tax_invalid_input','field','/plan/skus',
  'remedy','Supply the documented published SKU selection and its catalogue head digest, then repeat the read.');
 inconsistent CONSTANT jsonb := jsonb_build_object('kind','refused','code','catalog_tax_assignment_evidence_invalid','field','/plan/skus',
  'remedy','Have the catalogue owner reconcile the original selection and publication evidence, then repeat the read.');
 unpublished CONSTANT jsonb := jsonb_build_object('kind','refused','code','catalog_tax_assignment_unpublished','field','/plan/skus',
  'remedy','Choose published merchandise or have the catalogue owner publish the intended SKU, then request a fresh quote.');
 uuid_pattern CONSTANT text := '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
 expected jsonb;
 pairs jsonb;
 authority jsonb;
 head_digest text;
 invalid_manifest boolean;
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
 IF p_request - ARRAY['expectedHeadDigest','skus'] <> '{}' THEN RETURN invalid; END IF;

 expected := p_request->'expectedHeadDigest';
 IF (expected='null' OR (jsonb_typeof(expected)='string' AND (expected #>> '{}') COLLATE "C" ~ '^[0-9a-f]{64}$')) IS DISTINCT FROM true THEN
  RETURN invalid || '{"field":"/plan/expectedHeadDigest"}';
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

 authority := public.catalog_publication_read_head();
 IF authority->>'kind'='legacy' THEN RETURN unpublished; END IF;
 IF authority->>'kind' IS DISTINCT FROM 'governed' THEN RETURN inconsistent; END IF;
 head_digest := authority->>'headDigest';
 IF expected<>'null' AND expected IS DISTINCT FROM authority->'headDigest' THEN
  RETURN jsonb_build_object('kind','refused','code','catalog_tax_assignment_head_changed','field','/plan/expectedHeadDigest',
   'remedy','Read the published selection again and request a fresh quote.');
 END IF;

 BEGIN
  WITH manifests AS MATERIALIZED (
   SELECT h.product_id,h.publication_id,h.publication_revision,
    public.catalog_publication_read_manifest(h.product_id,h.canonical_state,h.digest) AS body
   FROM public.catalog_publication_read_head_manifests() h
  )
  SELECT EXISTS (SELECT 1 FROM manifests WHERE body IS NULL), coalesce(jsonb_agg(jsonb_build_object(
    'product_id',m.product_id,'publication_id',m.publication_id,'publication_revision',m.publication_revision,
    'reference',r.reference,'requested_code',s.pair->>'sku','product_type',m.body #> '{product,type}',
    'definition_digest',m.body #>> '{product,definitionDigest}','verify_digest',m.body->'schemaVersion'='3'
   ) ORDER BY r.reference->>'skuId' COLLATE "C"),'[]')
  INTO invalid_manifest,selected
  FROM manifests m CROSS JOIN LATERAL jsonb_array_elements(m.body->'skus') AS r(reference)
  JOIN jsonb_array_elements(pairs) AS s(pair) ON s.pair->'skuId'=r.reference->'skuId';
 EXCEPTION WHEN SQLSTATE 'PCA01' THEN
  IF SQLERRM='catalog_publication_head_manifest_missing' THEN RETURN inconsistent; END IF;
  RAISE;
 END;
 IF invalid_manifest THEN RETURN inconsistent; END IF;

 FOR item IN SELECT * FROM jsonb_to_recordset(selected) AS rows(
  product_id uuid, publication_id uuid, publication_revision integer, reference jsonb, requested_code text,
  product_type jsonb, definition_digest text, verify_digest boolean
 ) ORDER BY (reference->>'skuId') COLLATE "C" LOOP
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
    head_digest,item.publication_id,item.publication_revision,item.reference->>'revisionId');
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
 RETURN jsonb_build_object('kind','published','revision',head_digest,'assignments',assignments);
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(), public.catalog_publication_tax_assignments(jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(), public.catalog_publication_tax_assignments(jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(), public.catalog_publication_tax_assignments(jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_publication_read_head_manifests(), public.catalog_publication_tax_assignments(jsonb) FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_publication_tax_assignments(jsonb) TO service_role;'; END IF; END; $$;
