-- Verify exact quantities in the existing deferred write guard. Readers
-- compare stored projections with sealed facts using their existing privileges.
ALTER TABLE public.catalog_skus ALTER COLUMN net_weight_g DROP NOT NULL;

-- Preserve unsealed legacy zero while requiring exact evidence for publication.
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_legacy_net_grams_check CHECK (
 CASE
  WHEN net_weight_g = 0 AND publication_facts IS NULL THEN true
  WHEN net_content_dimension IS NULL THEN net_weight_g IS NOT NULL AND net_weight_g BETWEEN 0 AND 2147483647
  WHEN net_content_dimension = 'mass' AND net_content_unit = 'openlup:g' AND net_content_scale = 0
   THEN net_weight_g IS NOT NULL AND net_weight_g = net_content_unscaled
  ELSE net_weight_g IS NULL OR net_weight_g BETWEEN 1 AND 2147483647
 END
);

CREATE OR REPLACE FUNCTION public.catalog_publication_sku_projection(p_sku uuid,p_product uuid,p_code text,body jsonb,p_live boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE canonical text; installed jsonb; quantity jsonb; declared jsonb; dimension text; unit text; canonical_unit text;
 coefficient numeric; quantity_scale integer; factor numeric; factor_scale integer; exact numeric; net_amount numeric;
 grams integer; builtin_integral boolean; invalid_amount text; rejected_constraint text;
BEGIN
 IF jsonb_typeof(body) IS DISTINCT FROM 'object'
   OR NOT (body ?& ARRAY['id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription',
     'netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source'])
   OR body - ARRAY['netWeightG','id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription',
     'netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source'] <> '{}'::jsonb
   OR body->'id' IS DISTINCT FROM to_jsonb(p_sku) OR body->'productId' IS DISTINCT FROM to_jsonb(p_product)
   OR body->'code' IS DISTINCT FROM to_jsonb(p_code) OR p_code !~ '^[A-Za-z0-9._:-]{1,160}$'
   OR body->>'status' NOT IN ('draft','active','archived') OR body->>'status' IS NULL
   OR jsonb_typeof(body->'minQuantity') IS DISTINCT FROM 'number' OR body->>'minQuantity' !~ '^[1-9][0-9]{0,9}$'
   OR (body->>'minQuantity')::numeric>2147483647
   OR jsonb_typeof(body->'isAddon') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'sellableStandalone') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'sellableInSubscription') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'options') IS DISTINCT FROM 'object'
     OR jsonb_typeof(body->'identifiers') IS DISTINCT FROM 'array'
   OR jsonb_typeof(body->'assetRefs') IS DISTINCT FROM 'array'
   OR jsonb_typeof(body->'logisticsRef') NOT IN ('string','null')
   OR jsonb_typeof(body->'memberships') IS DISTINCT FROM 'array'
   OR NOT public.catalog_publication_claim_valid(body->'source') THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 IF public.catalog_publication_quantity_valid(body->'netContent') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'catalog_publication_net_content_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_net_content_invalid';
 END IF;
 IF body->'grossMass'<>'null'::jsonb AND (body #>> '{grossMass,dimension}' IS DISTINCT FROM 'mass'
   OR public.catalog_publication_quantity_valid(body->'grossMass') IS DISTINCT FROM true) THEN
  RAISE EXCEPTION 'catalog_publication_gross_mass_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_gross_mass_invalid';
 END IF;
 IF body ? 'netWeightG' AND (body #>> '{netContent,dimension}'='mass'
   AND jsonb_typeof(body->'netWeightG')='number' AND body->>'netWeightG' ~ '^[1-9][0-9]{0,9}$'
   AND pg_input_is_valid(body->>'netWeightG','integer')) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'catalog_publication_gram_bridge_mismatch' USING ERRCODE='23514', CONSTRAINT='catalog_publication_gram_bridge_mismatch';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(body->'options') AS option WHERE
     option.key !~ '^[a-z][a-z0-9_-]{0,63}$' OR option.key IN ('constructor','prototype')
     OR jsonb_typeof(option.value)<>'object' OR NOT (option.value ?& ARRAY['kind','value'])
     OR option.value - ARRAY['kind','value']<>'{}'::jsonb
     OR CASE option.value->>'kind'
       WHEN 'choice' THEN public.catalog_publication_text_valid(option.value->'value',120,false) IS DISTINCT FROM true
       WHEN 'boolean' THEN jsonb_typeof(option.value->'value')<>'boolean'
       WHEN 'quantity' THEN public.catalog_publication_quantity_valid(option.value->'value') IS DISTINCT FROM true
       ELSE true END)
  OR jsonb_array_length(body->'assetRefs')>32
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(body->'assetRefs') AS item WHERE
    public.catalog_publication_text_valid(item,240,true) IS DISTINCT FROM true)
  OR EXISTS (SELECT 1 FROM (SELECT entry,lag(entry->>'offerVersion') OVER (ORDER BY ordinality) AS previous_offer
     FROM jsonb_array_elements(body->'memberships') WITH ORDINALITY AS ref(entry,ordinality)) m
    WHERE jsonb_typeof(entry)<>'object' OR NOT (entry ?& ARRAY['offerVersion','admitted'])
     OR entry - ARRAY['offerVersion','admitted']<>'{}'::jsonb
     OR public.catalog_publication_text_valid(entry->'offerVersion',240,true) IS DISTINCT FROM true OR jsonb_typeof(entry->'admitted')<>'boolean'
     OR previous_offer COLLATE "C">=entry->>'offerVersion' COLLATE "C")
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(body->'identifiers') AS item
    WHERE jsonb_typeof(item)<>'object' OR NOT (item ?& ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef'])
     OR item - ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef']<>'{}'::jsonb
     OR public.catalog_publication_text_valid(item->'scheme',240,true) IS DISTINCT FROM true
     OR public.catalog_publication_text_valid(item->'issuer',240,true) IS DISTINCT FROM true
     OR public.catalog_publication_text_valid(item->'value',128,false) IS DISTINCT FROM true
     OR jsonb_typeof(item->'packagingLevel')<>'string' OR item->>'packagingLevel' NOT IN ('unit','case')
     OR jsonb_typeof(item->'quantity')<>'number' OR item->>'quantity' !~ '^[1-9][0-9]{0,5}$'
     OR (item->>'packagingLevel'='unit') IS DISTINCT FROM (item->>'quantity'='1')
     OR jsonb_typeof(item->'isPrimary')<>'boolean'
     OR (item->'isPrimary'='true'::jsonb AND (item->>'scheme'<>'gs1:gtin' OR item->>'packagingLevel'<>'unit'))
     OR (item->'label'<>'null'::jsonb AND public.catalog_publication_text_valid(item->'label',500,true) IS DISTINCT FROM true)
     OR (item->'sourceRef'<>'null'::jsonb AND public.catalog_publication_text_valid(item->'sourceRef',240,true) IS DISTINCT FROM true))
  OR (SELECT count(*) FROM jsonb_array_elements(body->'identifiers') AS item WHERE item->'isPrimary'='true'::jsonb)>1
  OR (body->'logisticsRef'<>'null'::jsonb AND public.catalog_publication_text_valid(body->'logisticsRef',500,true) IS DISTINCT FROM true) THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 IF jsonb_typeof(body->'facts') IS DISTINCT FROM 'object' OR NOT public.catalog_publication_carriers_valid(body) THEN
  RAISE EXCEPTION 'catalog_publication_facts_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_facts_invalid';
 END IF;
 IF public.catalog_publication_text_valid(body->'title',500,false) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'catalog_publication_sku_title_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_title_invalid';
 END IF;
 IF NOT public.catalog_publication_attributes_valid(body->'attributes') THEN
  RAISE EXCEPTION 'catalog_publication_attributes_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_attributes_invalid';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(body->'identifiers') item WHERE item->>'scheme'='gs1:gtin'
   AND CASE WHEN item->>'value' ~ '^([0-9]{8}|[0-9]{12,14})$' THEN
     (SELECT sum(substr(item->>'value',length(item->>'value')-position,1)::integer * CASE WHEN position%2=0 THEN 1 ELSE 3 END)
      FROM generate_series(0,length(item->>'value')-1) position) % 10 <> 0
    ELSE true END) THEN
  RAISE EXCEPTION 'catalog_publication_gtin_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_gtin_invalid';
 END IF;
 -- Each issued SKU carries the immutable draft claim that selects its definition.
 IF p_live THEN
  SELECT v.definition INTO installed FROM public.catalog_draft_revisions d
    JOIN public.catalog_type_versions v
      ON (v.type_key,v.version)=(d.payload #>> '{product,type,key}',(d.payload #>> '{product,type,version}')::integer)
    WHERE (d.product_id,d.draft_id,d.revision,d.command_key,d.fingerprint)=
     (p_product,(body #>> '{source,draftId}')::uuid,(body #>> '{source,revision}')::integer,
      body #>> '{source,commandKey}',body #>> '{source,fingerprint}');
  IF (installed->'netContentUnits' ? (body #>> '{netContent,unit}')) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'catalog_publication_quantity_unit_unregistered' USING ERRCODE='23514', CONSTRAINT='catalog_publication_quantity_unit_unregistered';
  END IF;
  FOREACH quantity IN ARRAY ARRAY[body->'netContent', body->'grossMass'] LOOP
   IF quantity='null'::jsonb THEN CONTINUE; END IF;
   dimension := quantity->>'dimension';
   unit := quantity->>'unit';
   SELECT entry INTO declared FROM jsonb_array_elements(installed->'units') entry WHERE entry->>'code'=unit;
   IF declared->>'dimension' IS DISTINCT FROM dimension THEN
    RAISE EXCEPTION 'catalog_publication_quantity_unit_unregistered' USING ERRCODE='23514', CONSTRAINT='catalog_publication_quantity_unit_unregistered';
   END IF;
   coefficient := (quantity->>'unscaled')::numeric;
   quantity_scale := (quantity->>'scale')::integer;
   -- Mirrored from Core's CATALOG_QUANTITY_UNITS. The parity witness checks every tuple.
   SELECT basis.target, basis.multiplier, basis.multiplier_scale, basis.integral
    INTO canonical_unit, factor, factor_scale, builtin_integral
    FROM (VALUES
     ('openlup:g', 'mass', 'openlup:g', 1, 0, false),
     ('openlup:kg', 'mass', 'openlup:g', 1000, 0, false),
     ('openlup:ml', 'volume', 'openlup:ml', 1, 0, false),
     ('openlup:l', 'volume', 'openlup:ml', 1000, 0, false),
     ('openlup:piece', 'count', 'openlup:piece', 1, 0, true)
    ) AS basis(code, quantity_dimension, target, multiplier, multiplier_scale, integral)
    WHERE (basis.code,basis.quantity_dimension)=(unit,dimension);
   IF declared->'factor' IS NULL THEN
    IF NOT FOUND THEN
     RAISE EXCEPTION 'catalog_publication_quantity_unit_unregistered' USING ERRCODE='23514', CONSTRAINT='catalog_publication_quantity_unit_unregistered';
    END IF;
   ELSE
    canonical_unit := coalesce(canonical_unit, CASE dimension WHEN 'mass' THEN 'openlup:g' WHEN 'volume' THEN 'openlup:ml' ELSE 'openlup:piece' END);
    IF (declared #>> '{factor,canonicalUnit}'=canonical_unit
      AND declared #>> '{factor,unscaled}' ~ '^[1-9][0-9]{0,39}$'
      AND declared #>> '{factor,scale}' ~ '^([0-9]|1[0-2])$') IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'catalog_publication_quantity_conversion_inexact' USING ERRCODE='23514', CONSTRAINT='catalog_publication_quantity_conversion_inexact';
    END IF;
    factor := (declared #>> '{factor,unscaled}')::numeric;
    factor_scale := (declared #>> '{factor,scale}')::integer;
   END IF;
   IF (dimension='count' OR builtin_integral OR declared->'integral'='true'::jsonb)
     AND mod(coefficient,power(10::numeric,quantity_scale))<>0 THEN
    invalid_amount := CASE WHEN net_amount IS NULL THEN 'catalog_publication_net_content_invalid' ELSE 'catalog_publication_gross_mass_invalid' END;
    RAISE EXCEPTION USING MESSAGE=invalid_amount, ERRCODE='23514', CONSTRAINT=invalid_amount;
   END IF;
   exact := trim_scale(coefficient * factor * ('1e-' || (quantity_scale + factor_scale))::numeric);
   IF (exact>0 AND exact<1e40 AND scale(exact)<=12) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'catalog_publication_quantity_conversion_inexact' USING ERRCODE='23514', CONSTRAINT='catalog_publication_quantity_conversion_inexact';
   END IF;
   IF net_amount IS NULL THEN
    net_amount := exact;
    IF dimension='mass' AND scale(exact)=0 AND exact BETWEEN 1 AND 2147483647 THEN grams := exact::integer; END IF;
   ELSIF body #>> '{netContent,dimension}'='mass' AND exact<net_amount THEN
    RAISE EXCEPTION 'catalog_publication_gross_below_net' USING ERRCODE='23514', CONSTRAINT='catalog_publication_gross_below_net';
   END IF;
  END LOOP;
  IF (grams IS NULL AND body #> '{netContent,dimension}'='"mass"'::jsonb
   AND body #> '{netContent,unit}'='"openlup:g"'::jsonb AND body #> '{netContent,scale}'='0'::jsonb)
   OR grams::text IS DISTINCT FROM (coalesce(body->>'netWeightG', CASE WHEN body #> '{netContent,dimension}'='"mass"'::jsonb
   AND body #> '{netContent,unit}'='"openlup:g"'::jsonb AND body #> '{netContent,scale}'='0'::jsonb
   AND pg_input_is_valid(body #>> '{netContent,unscaled}','integer') THEN body #>> '{netContent,unscaled}' END)) THEN
   RAISE EXCEPTION 'catalog_publication_gram_bridge_mismatch' USING ERRCODE='23514', CONSTRAINT='catalog_publication_gram_bridge_mismatch';
  END IF;
 END IF;
 -- Exact detail places each SKU at $.items[index].facts, three levels deep.
 canonical := public.catalog_publication_canonical(body,3);
 IF octet_length(canonical)>2097152 THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 RETURN canonical;
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
 IF p_live AND rejected_constraint NOT IN ('catalog_publication_net_content_invalid','catalog_publication_gross_mass_invalid',
   'catalog_publication_gross_below_net','catalog_publication_quantity_unit_unregistered',
   'catalog_publication_quantity_conversion_inexact','catalog_publication_gram_bridge_mismatch') THEN
  RAISE EXCEPTION 'catalog_publication_facts_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_facts_invalid';
 END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_assert_issued(p_product uuid, p_issue uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE issue public.catalog_publications%ROWTYPE; prior public.catalog_publications%ROWTYPE;
 receipt_result text;
 doc_reference jsonb; doc_valid boolean; authored jsonb; manifest jsonb; product jsonb;
 head jsonb; previous_head jsonb; roster jsonb; changes jsonb; issue_count integer;
 invalid_change boolean; distinct_codes integer; expected_receipt jsonb; approved_roster jsonb; oversized_page boolean;
BEGIN
 SELECT * INTO issue FROM public.catalog_publications WHERE product_id=p_product AND id=p_issue;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'catalog_publication_lineage_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_lineage_invalid';
 END IF;
 PERFORM public.catalog_publication_assert_head(p_product,false);
 SELECT * INTO prior FROM public.catalog_publications WHERE product_id=p_product AND id=issue.previous_id;
 IF (issue.revision=1 AND issue.previous_id IS NOT NULL)
   OR (issue.revision>1 AND prior.revision IS DISTINCT FROM issue.revision-1)
   OR issue.candidate_ref IS DISTINCT FROM
     'v1:' || issue.draft_id || '@' || issue.draft_revision || '/' ||
       coalesce(prior.id || '@' || prior.revision,'unpublished') THEN
  RAISE EXCEPTION 'catalog_publication_lineage_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_lineage_invalid';
 END IF;

 manifest := public.catalog_publication_manifest_text(issue.product_id,issue.canonical_state,issue.digest,false)::jsonb;
 product := manifest->'product';

 authored := public.catalog_publication_candidate_source(p_product,issue.candidate_ref,issue.candidate_digest);
 IF product->'type' IS DISTINCT FROM authored #> '{product,type}'
   OR NOT EXISTS (SELECT 1 FROM public.catalog_draft_revisions d
     WHERE d.draft_id=issue.draft_id AND d.revision=issue.draft_revision
       AND product->'source'=jsonb_build_object('draftId',d.draft_id,'revision',d.revision,'commandKey',d.command_key,'fingerprint',d.fingerprint)) THEN
  RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
 END IF;

 SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,
    'schemaId',d.schema_id,'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest),
   EXISTS (
    SELECT 1 FROM public.catalog_draft_revisions origin
    JOIN public.catalog_draft_command_receipts origin_receipt ON
     (origin_receipt.draft_id,origin_receipt.command_key,origin_receipt.revision,origin_receipt.fingerprint)=
     (origin.draft_id,origin.command_key,origin.revision,origin.fingerprint)
     WHERE origin.draft_id=(d.provenance->>'draftId')::uuid AND origin.revision=(d.provenance->>'draftRevision')::integer
     AND origin.product_id=p_product AND origin.status='open'
     AND d.provenance=jsonb_build_object('draftId',origin.draft_id,'draftRevision',origin.revision,
      'draftCommandKey',origin.command_key,'draftFingerprint',origin.fingerprint)
     AND origin.payload #> '{product,documentRevision}'=jsonb_build_object(
       'id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
       'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest)
     AND coalesce(origin.payload #> '{product,sharedContent,document}',stored.payload)=stored.payload
     AND coalesce(authored #> '{product,sharedContent,document}',stored.payload)=stored.payload
     AND (
       SELECT coalesce(bool_and(matches) FILTER (WHERE issuing),true)
         AND ((prior.document_revision_id=d.id AND count(*) FILTER (WHERE issuing)=0)
           OR (count(*) FILTER (WHERE NOT issuing)=1 AND bool_and(matches) FILTER (WHERE NOT issuing)))
       FROM (
        SELECT issuing, (operation->'productSlug'=registration.payload #> '{product,slug}'
         AND operation->'revisionId'=to_jsonb(d.id) AND operation->'revisionNo'=to_jsonb(d.revision_no)
         AND CASE WHEN operation->'provenance'='{"source":"current_draft"}'::jsonb THEN registration.claim
           WHEN operation #>> '{provenance,source}'='retained_draft' THEN (operation->'provenance') - 'source'
         END IS NOT DISTINCT FROM d.provenance
         AND operation->'documentRef'=to_jsonb(d.document_ref) AND operation->'sourceRef'=to_jsonb(d.source_ref)
         AND operation->'digest'=to_jsonb(d.digest)
         AND jsonb_typeof(operation->'canonicalText')='string'
         AND CASE WHEN pg_input_is_valid(operation->>'canonicalText','jsonb')
           THEN (operation->>'canonicalText')::jsonb=stored.payload ELSE false END
         AND encode(sha256(convert_to(operation->>'canonicalText','UTF8')),'hex')=d.digest) IS TRUE AS matches
        FROM (VALUES (false,origin.payload,d.provenance),
         (true,authored,jsonb_build_object('draftId',product #> '{source,draftId}','draftRevision',product #> '{source,revision}',
           'draftCommandKey',product #> '{source,commandKey}','draftFingerprint',product #> '{source,fingerprint}'))) registration(issuing,payload,claim)
        CROSS JOIN LATERAL jsonb_array_elements(registration.payload #> '{publication,operations}') operation
        WHERE operation->>'op'='register_document_revision' AND (operation->'revisionId'=to_jsonb(d.id)
         OR (operation->'productSlug'=registration.payload #> '{product,slug}' AND operation->'revisionNo'=to_jsonb(d.revision_no)))
       ) evidence))
 INTO doc_reference,doc_valid
 FROM public.catalog_product_document_revisions d
 CROSS JOIN LATERAL (SELECT d.document_payload AS payload) stored
 WHERE d.product_id=p_product AND d.id=issue.document_revision_id;
 IF doc_valid IS DISTINCT FROM true OR doc_reference IS DISTINCT FROM product->'document'
   OR doc_reference IS DISTINCT FROM authored #> '{product,documentRevision}' THEN
  RAISE EXCEPTION 'catalog_publication_document_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_document_invalid';
 END IF;

 head := public.catalog_publication_head_ref(p_product,p_issue);
 previous_head := public.catalog_publication_head_ref(p_product,issue.previous_id);
 -- Only the immediate predecessor is consulted. Every inherited reference
 -- already passed admission at its own issue. The two new unique keys make
 -- each ordinal and each SKU appear at most once in this issue.
 WITH previous_skus AS MATERIALIZED (
  SELECT value AS reference FROM jsonb_array_elements(coalesce(prior.canonical_state::jsonb->'skus','[]'::jsonb))
 ), issued AS MATERIALIZED (
  SELECT r.id,r.sku_id,r.sku_code,r.revision,r.digest,r.issue_ordinal,
    r.full_facts::jsonb AS facts,
    public.catalog_publication_sku_projection(r.sku_id,r.product_id,r.sku_code,r.full_facts::jsonb,true)=r.full_facts
      AND encode(sha256(convert_to(r.full_facts,'UTF8')),'hex')=r.digest AS exact_facts
  FROM public.catalog_sku_revisions r WHERE r.publication_id=p_issue AND r.product_id=p_product
 ), merged AS (
  SELECT coalesce(new.sku_id::text,old.reference->>'skuId') AS sku_id,new.id AS issued_id,
   new.revision,new.sku_code,new.facts->>'status' AS status,new.issue_ordinal,new.facts->'source' AS source,new.exact_facts,
   old.reference AS previous_reference,
   CASE WHEN new.id IS NULL THEN old.reference ELSE
    jsonb_build_object('skuId',new.sku_id,'revisionId',new.id,'revision',new.revision,'digest',new.digest) END AS reference
  FROM previous_skus old FULL JOIN issued new ON old.reference->>'skuId'=new.sku_id::text
 )
 SELECT coalesce(jsonb_agg(m.reference ORDER BY m.sku_id COLLATE "C"),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('skuId',m.sku_id,'digest',m.reference->'digest') ORDER BY m.sku_id COLLATE "C"),'[]'::jsonb),
  count(m.issued_id)::integer,
  coalesce(bool_or(m.revision::bigint<>coalesce((m.previous_reference->>'revision')::bigint,0)+1
    OR m.reference->>'digest'=m.previous_reference->>'digest' OR m.issue_ordinal>issue.issued_count
    OR m.source IS DISTINCT FROM product->'source' OR m.exact_facts IS DISTINCT FROM true)
    FILTER (WHERE m.issued_id IS NOT NULL),false),
  count(DISTINCT coalesce(m.sku_code,inherited.sku_code))::integer,
  coalesce(jsonb_agg(jsonb_build_object('productId',p_product,'variantId',m.sku_id,'sku',m.sku_code,
   'state',CASE WHEN m.status='archived' THEN 'withdrawn' ELSE m.status END,'variantRevision',m.revision,
   'publicationHead',head,'draftRef',jsonb_build_object('draftId',issue.draft_id,'revision',issue.draft_revision))
   ORDER BY m.sku_id COLLATE "C") FILTER (WHERE m.issued_id IS NOT NULL),'[]'::jsonb)
 INTO roster,approved_roster,issue_count,invalid_change,distinct_codes,changes
 FROM merged m
 LEFT JOIN public.catalog_sku_revisions inherited ON m.issued_id IS NULL
  AND inherited.id=(m.reference->>'revisionId')::uuid AND inherited.product_id=p_product
  AND inherited.sku_id=(m.reference->>'skuId')::uuid
  AND inherited.revision=(m.reference->>'revision')::integer AND inherited.digest=m.reference->>'digest';
 IF jsonb_array_length(roster)>10000 THEN
  RAISE EXCEPTION 'catalog_publication_roster_limit' USING ERRCODE='23514', CONSTRAINT='catalog_publication_roster_limit';
 END IF;
 IF issue_count<>issue.issued_count OR invalid_change OR roster IS DISTINCT FROM manifest->'skus'
   OR distinct_codes<>jsonb_array_length(roster)
   OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(roster) AS member
     WHERE member->'skuId'=product->'primarySkuId') THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;

 -- Budget a page containing only the item at each offset. The other fields
 -- are fixed, including the exact unpadded base64url continuation length.
 WITH base AS MATERIALIZED (
  SELECT octet_length(public.catalog_publication_canonical(jsonb_build_object('outcome','page','schemaVersion',2,
   'head',head,'product',product,'items','[]'::jsonb,'nextCursor',NULL),0)) AS bytes
 )
 SELECT EXISTS (
  SELECT 1 FROM jsonb_array_elements(roster) WITH ORDINALITY member(reference,position)
  JOIN public.catalog_sku_revisions r ON r.id=(member.reference->>'revisionId')::uuid
  CROSS JOIN base
  WHERE base.bytes + octet_length(r.full_facts)
    + octet_length(public.catalog_publication_canonical(member.reference,0)) + length('{"facts":,"reference":}')
    + CASE WHEN member.position=jsonb_array_length(roster) THEN 0 ELSE
      (4 * octet_length(public.catalog_publication_canonical(jsonb_build_object('schemaVersion',1,
         'kind','facts','productId',p_product,'highWater',issue.revision,'before',member.position),0)) + 2) / 3 - 2 END
    > 8388608
 ) INTO oversized_page;
 IF oversized_page THEN
  RAISE EXCEPTION 'catalog_publication_page_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_page_invalid';
 END IF;

 PERFORM public.catalog_publication_assert_candidate(NULL,issue,jsonb_build_object('schemaVersion',2,'product',product,'skus',approved_roster));
 receipt_result := public.catalog_publication_assert_receipt(p_product,issue.command_key);
 expected_receipt := jsonb_build_object('schemaVersion',2,'productId',p_product,'commandKey',issue.command_key,
   'fingerprint',issue.command_fingerprint,'actorId',issue.actor_id,'head',head,'previousHead',previous_head,
   'publicationDigest',issue.digest,'committedAt',to_char(issue.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'changes',changes);
 IF receipt_result<>public.catalog_publication_canonical(expected_receipt,0) THEN
  RAISE EXCEPTION 'catalog_publication_receipt_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_receipt_invalid';
 END IF;
 IF EXISTS (SELECT 1 FROM public.catalog_publication_heads WHERE product_id=p_product AND publication_id=p_issue) THEN
  PERFORM public.catalog_publication_assert_head(p_product,true);
  IF NOT public.catalog_publication_live_matches(p_product,product,roster) THEN
   IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(roster) member
    JOIN public.catalog_sku_revisions r ON r.id=(member->>'revisionId')::uuid AND r.product_id=p_product
    JOIN public.catalog_skus s ON (s.id,s.product_id)=(r.sku_id,r.product_id)
    CROSS JOIN LATERAL (SELECT r.full_facts::jsonb AS facts) f
    WHERE s.net_weight_g::text IS DISTINCT FROM coalesce(f.facts->>'netWeightG', CASE
     WHEN f.facts #> '{netContent,dimension}'='"mass"'::jsonb
      AND f.facts #> '{netContent,unit}'='"openlup:g"'::jsonb AND f.facts #> '{netContent,scale}'='0'::jsonb
      AND pg_input_is_valid(f.facts #>> '{netContent,unscaled}','integer') THEN f.facts #>> '{netContent,unscaled}' END)
   ) THEN
    RAISE EXCEPTION 'catalog_publication_gram_bridge_mismatch' USING ERRCODE='23514', CONSTRAINT='catalog_publication_gram_bridge_mismatch';
   END IF;
   RAISE EXCEPTION 'catalog_publication_live_drift' USING ERRCODE='23514', CONSTRAINT='catalog_publication_live_drift';
  END IF;
 END IF;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_live_matches(p_product uuid, p_state jsonb, p_roster jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.catalog_products p WHERE p.id=p_product
    AND p.publication_facts=p_state
    AND p.slug=p_state->>'slug' AND p.name=p_state->>'name' AND p.status=p_state->>'status'
    AND p.primary_sku_id=(p_state->>'primarySkuId')::uuid
    AND p.current_document_revision_id=(p_state #>> '{document,id}')::uuid
    AND p.type_key=p_state #>> '{type,key}' AND p.type_version=(p_state #>> '{type,version}')::integer
    AND to_jsonb(p.variant_axes)=p_state->'axes' AND p.attribute_values=p_state->'attributes'
    AND (SELECT count(*) FROM public.catalog_skus WHERE product_id=p.id)=jsonb_array_length(p_roster)
 ) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_roster) AS member
    JOIN public.catalog_sku_revisions r ON r.id=(member->>'revisionId')::uuid AND r.product_id=p_product
    LEFT JOIN public.catalog_skus s ON s.id=r.sku_id AND s.product_id=r.product_id
    CROSS JOIN LATERAL (SELECT r.full_facts::jsonb AS facts) f
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(entry.fact ORDER BY entry.fact),'[]'::jsonb) AS facts
      FROM (
        SELECT jsonb_build_object('issuer',i.issuer,'normalized',i.normalized_value,'kind',i.identifier_kind,
          'packagingLevel',CASE WHEN i.pack_kind='unit' THEN 'unit' ELSE 'case' END,
          'quantity',i.quantity,'isPrimary',i.is_primary) AS fact
        FROM public.catalog_sku_identifiers i WHERE i.catalog_sku_id=s.id
      ) entry
    ) recorded
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(entry.fact ORDER BY entry.fact),'[]'::jsonb) AS facts
      FROM (
        SELECT jsonb_build_object('issuer',i->'issuer','packagingLevel',i->'packagingLevel',
          'quantity',i->'quantity','isPrimary',i->'isPrimary','normalized',CASE WHEN i->>'scheme'='gs1:gtin' THEN lpad(i->>'value',14,'0') ELSE i->>'value' END,
          'kind',CASE WHEN i->>'scheme'='gs1:gtin' THEN 'gtin' ELSE 'other' END) AS fact
        FROM jsonb_array_elements(f.facts->'identifiers') i
      ) entry
    ) expected
    WHERE (s.publication_facts=f.facts AND s.sku=r.sku_code AND s.title=f.facts->>'title'
      AND s.status=f.facts->>'status' AND s.sellable_standalone=(f.facts->>'sellableStandalone')::boolean
      AND s.sellable_in_subscription=(f.facts->>'sellableInSubscription')::boolean
      AND s.min_order_qty=(f.facts->>'minQuantity')::integer AND s.is_addon=(f.facts->>'isAddon')::boolean
      AND s.attribute_values=f.facts->'attributes' AND s.option_values=f.facts->'options'
      AND (s.net_content_dimension,s.net_content_unit,s.net_content_scale::text,s.net_content_unscaled::text,
     s.gross_mass_dimension,s.gross_mass_unit,s.gross_mass_scale::text,s.gross_mass_unscaled::text,
     s.net_weight_g::text)
      IS NOT DISTINCT FROM (f.facts #>> '{netContent,dimension}',f.facts #>> '{netContent,unit}',f.facts #>> '{netContent,scale}',f.facts #>> '{netContent,unscaled}',
     f.facts #>> '{grossMass,dimension}',f.facts #>> '{grossMass,unit}',f.facts #>> '{grossMass,scale}',f.facts #>> '{grossMass,unscaled}',
     coalesce(f.facts->>'netWeightG', CASE WHEN f.facts #> '{netContent,dimension}'='"mass"'::jsonb
   AND f.facts #> '{netContent,unit}'='"openlup:g"'::jsonb AND f.facts #> '{netContent,scale}'='0'::jsonb
   AND pg_input_is_valid(f.facts #>> '{netContent,unscaled}','integer') THEN f.facts #>> '{netContent,unscaled}' END))
      AND s.asset_ref IS NOT DISTINCT FROM f.facts #>> '{assetRefs,0}'
      AND recorded.facts=expected.facts) IS DISTINCT FROM true LIMIT 1
 );
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_selected_evidence(p_product uuid,p_sku uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE issue public.catalog_publications; manifest jsonb; product jsonb; sku jsonb; reference jsonb;
 receipt jsonb; expected_changes jsonb; head jsonb; previous_head jsonb; document jsonb; document_valid boolean; live_product public.catalog_products; live_sku public.catalog_skus;
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
  OR receipt - 'changes' IS DISTINCT FROM jsonb_build_object('schemaVersion',2,'productId',p_product,'head',head,
   'previousHead',previous_head,'publicationDigest',issue.digest,'commandKey',issue.command_key,
   'fingerprint',issue.command_fingerprint,'actorId',issue.actor_id,
   'committedAt',to_char(issue.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  OR EXISTS (SELECT 1 FROM public.catalog_publication_decisions a WHERE (a.product_id,a.command_key)=(p_product,issue.command_key))
 THEN RETURN invalid; END IF;

 -- Rebuild the ordered receipt changes from the issue's authenticated SKU references.
 WITH issued AS MATERIALIZED (
  SELECT r.sku_id,r.revision,public.catalog_publication_read_sku_revision(p_product,ref) AS facts
  FROM public.catalog_sku_revisions r
  LEFT JOIN jsonb_array_elements(manifest->'skus') ref ON ref->'revisionId'=to_jsonb(r.id)
  WHERE (r.product_id,r.publication_id)=(p_product,issue.id)
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('productId',p_product,'variantId',sku_id,'sku',facts->'code',
  'state',CASE WHEN facts->>'status'='archived' THEN 'withdrawn' ELSE facts->>'status' END,
  'variantRevision',revision,'publicationHead',head,'draftRef',jsonb_build_object('draftId',issue.draft_id,'revision',issue.draft_revision))
  ORDER BY sku_id),'[]'::jsonb) INTO expected_changes
 FROM issued
 HAVING count(*)=issue.issued_count AND coalesce(bool_and((
  facts->'source'=product->'source' AND facts #> '{source,draftId}'=to_jsonb(issue.draft_id)
  AND facts #> '{source,revision}'=to_jsonb(issue.draft_revision)
 ) IS TRUE),true);
 IF expected_changes IS NULL OR receipt->'changes' IS DISTINCT FROM expected_changes THEN RETURN invalid; END IF;

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
   AND public.catalog_publication_quantity_valid(sku->'netContent')
   AND (sku->'grossMass'='null'::jsonb OR (sku #>> '{grossMass,dimension}'='mass'
     AND public.catalog_publication_quantity_valid(sku->'grossMass')))
   AND (sku->'logisticsRef'='null'::jsonb OR public.catalog_publication_text_valid(sku->'logisticsRef',500,true))
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
     live_sku.publication_facts,live_sku.sku,live_sku.status,live_sku.sellable_standalone,live_sku.sellable_in_subscription)
  IS DISTINCT FROM (product,product->>'slug',product->>'status',issue.document_revision_id,product->>'primarySkuId',
     sku,sku->>'code',sku->>'status',(sku->>'sellableStandalone')::boolean,(sku->>'sellableInSubscription')::boolean)
  OR (live_sku.net_content_dimension,live_sku.net_content_unit,live_sku.net_content_scale::text,live_sku.net_content_unscaled::text,
     live_sku.gross_mass_dimension,live_sku.gross_mass_unit,live_sku.gross_mass_scale::text,live_sku.gross_mass_unscaled::text,
     live_sku.net_weight_g::text)
  IS DISTINCT FROM (sku #>> '{netContent,dimension}',sku #>> '{netContent,unit}',sku #>> '{netContent,scale}',sku #>> '{netContent,unscaled}',
     sku #>> '{grossMass,dimension}',sku #>> '{grossMass,unit}',sku #>> '{grossMass,scale}',sku #>> '{grossMass,unscaled}',
     coalesce(sku->>'netWeightG', CASE WHEN sku #> '{netContent,dimension}'='"mass"'::jsonb
   AND sku #> '{netContent,unit}'='"openlup:g"'::jsonb AND sku #> '{netContent,scale}'='0'::jsonb
   AND pg_input_is_valid(sku #>> '{netContent,unscaled}','integer') THEN sku #>> '{netContent,unscaled}' END))
  OR (SELECT jsonb_build_array(i.issuer,i.normalized_value) FROM public.catalog_sku_identifiers i
      WHERE i.catalog_sku_id=p_sku AND i.identifier_kind='gtin' AND i.pack_kind='unit' AND i.is_primary)
    IS DISTINCT FROM (SELECT jsonb_build_array(i->>'issuer',lpad(i->>'value',14,'0'))
      FROM jsonb_array_elements(sku->'identifiers') i WHERE i->'isPrimary'='true'::jsonb)
 THEN RETURN invalid || '{"detail":"catalog_publication_live_drift"}'::jsonb; END IF;
 RETURN jsonb_build_object('kind','evidence','head',head,'document',document,'skuRevision',reference,'product',product,'sku',sku);
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_offer_memberships_page(p_offer_version text,p_cursor jsonb,p_limit integer,p_mode text)
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
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(items) item WHERE item->'netWeightG'='null'::jsonb) THEN
  RETURN '{"kind":"refusal","reason":"quantity_requires_v2"}'::jsonb;
 END IF;
 RETURN jsonb_build_object('kind','page','value',jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items,'nextCursor',
  CASE WHEN next_id IS NOT NULL THEN jsonb_build_object('skuId',next_id,'headDigest',head_digest,'offerVersion',p_offer_version,'mode',p_mode) END));
END;
$$;

CREATE FUNCTION public.catalog_offer_memberships_page_v2(p_offer_version text,p_cursor jsonb,p_limit integer,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
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
  'logisticsRef',e#>'{sku,logisticsRef}','head',e->'head','document',e->'document','skuRevision',e->'skuRevision')
  || jsonb_build_object('netContent',e#>'{sku,netContent}','grossMass',e#>'{sku,grossMass}') ORDER BY id)
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

REVOKE ALL ON FUNCTION public.catalog_offer_memberships_page_v2(text,jsonb,integer,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_offer_memberships_page_v2(text,jsonb,integer,text) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_offer_memberships_page_v2(text,jsonb,integer,text) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_offer_memberships_page_v2(text,jsonb,integer,text) FROM service_role;'; END IF; END; $$;
