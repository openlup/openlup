-- Governed draft v4 can save a basis-aware operation without enabling its writer.
CREATE FUNCTION public.catalog_price_setup_v2_command_valid(p_operation jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_operation)='object' AND jsonb_typeof(prior)='object' THEN
  (p_operation - ARRAY['schemaVersion','commandKey','variantId','priceListId','mode','minQty','amountKind',
     'unitPriceMinor','expectedListAmountBasis','expected'] = '{}'::jsonb
   AND p_operation->'schemaVersion' = '2'::jsonb AND p_operation->'mode' = '"one_time"'::jsonb
   AND p_operation->'minQty' = '1'::jsonb
   AND jsonb_typeof(p_operation->'commandKey') = 'string'
   AND char_length(key)+(SELECT count(*) FROM regexp_split_to_table(key,'') ch WHERE octet_length(ch)=4) BETWEEN 1 AND 240
   AND key = btrim(key, chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
     chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
     chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
   AND p_operation->>'variantId' COLLATE "C" ~ uuid_shape AND p_operation->>'priceListId' COLLATE "C" ~ uuid_shape
   AND (p_operation->'amountKind',p_operation->'expectedListAmountBasis') IN (
     ('"gross"'::jsonb,'"tax_inclusive"'::jsonb),('"net"'::jsonb,'"tax_exclusive"'::jsonb))
   AND CASE WHEN jsonb_typeof(p_operation->'unitPriceMinor')='number'
     THEN amount BETWEEN 1 AND 2147483647 AND amount=trunc(amount) ELSE false END
   AND prior - ARRAY['entryId','unitPriceMinor','amountKind']='{}'::jsonb
   AND ((prior->'entryId',prior->'unitPriceMinor',prior->'amountKind')=('null'::jsonb,'null'::jsonb,'null'::jsonb)
     OR (prior->>'entryId' COLLATE "C" ~ uuid_shape AND prior->'amountKind' IN ('"gross"'::jsonb,'"net"'::jsonb)
      AND CASE WHEN jsonb_typeof(prior->'unitPriceMinor')='number'
        THEN previous BETWEEN 0 AND 2147483647 AND previous=trunc(previous) ELSE false END))) IS TRUE ELSE false END
 FROM (SELECT p_operation->'expected' AS prior, p_operation->>'commandKey' AS key,
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS uuid_shape) field
 CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(p_operation->'unitPriceMinor')='number'
   THEN (p_operation->>'unitPriceMinor')::numeric END AS amount,
   CASE WHEN jsonb_typeof(prior->'unitPriceMinor')='number' THEN (prior->>'unitPriceMinor')::numeric END AS previous) money
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_v2_command_valid(jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_price_setup_v2_command_valid(jsonb) TO service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; operation jsonb; expectation jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text; inputs jsonb; content jsonb; claim jsonb; allowed text[]; valid_v4 boolean; prior_version jsonb;
  price_context jsonb; tax_context jsonb; has_basis_operation boolean := false;
  price_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trim_space constant text := chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
    chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
BEGIN
  actor := p_actor_id; IF actor IS NULL OR actor <> btrim(actor) OR length(actor) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'catalog_draft_actor_required' USING ERRCODE='42501'; END IF;
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 1048576
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_fingerprint_invalid');
  END IF;
  c := p_canonical_command::jsonb;
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'schemaVersion' NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb) OR NOT (c ? 'schemaVersion')
    OR c->>'action' IS NULL OR (c->>'action' NOT IN ('create','revise','abandon') AND NOT (c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb) AND c->>'action' = 'resume'))
    OR jsonb_typeof(c->'draftId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'commandKey') IS DISTINCT FROM 'string' OR length(c->>'commandKey') NOT BETWEEN 1 AND 240
    OR btrim(c->>'commandKey') <> c->>'commandKey'
    OR jsonb_typeof(c->'expectedRevision') IS DISTINCT FROM 'number'
    OR c->>'expectedRevision' !~ '^(0|[1-9][0-9]*)$'
    OR EXISTS (SELECT FROM jsonb_object_keys(c) k WHERE k NOT IN ('schemaVersion','action','draftId','commandKey','expectedRevision','payload')) THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
  END IF;
  d := (c->>'draftId')::uuid; key := c->>'commandKey'; action := c->>'action'; expected := (c->>'expectedRevision')::integer;
  IF expected > 2147483646 THEN RETURN jsonb_build_object('outcome','validation_issue','reason','revision_limit'); END IF;
  IF d::text <> c->>'draftId' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-draft:' || d::text, 0));
  SELECT * INTO receipt FROM public.catalog_draft_command_receipts WHERE draft_id = d AND command_key = key;
  IF FOUND THEN
    IF receipt.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('outcome','conflict','reason','command_key_reused');
    END IF;
    IF public.catalog_draft_record(d,receipt.revision)->>'actorId' <> actor THEN RETURN jsonb_build_object('outcome','unauthorized','reason','operator_mismatch'); END IF;
    RETURN jsonb_build_object('outcome','replayed','record',public.catalog_draft_record(d, receipt.revision));
  END IF;
  IF c->'schemaVersion'='4'::jsonb AND (key<>btrim(key,trim_space)
   OR char_length(key)+(SELECT count(*) FROM regexp_split_to_table(key,'') ch WHERE octet_length(ch)=4)>240) THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
  END IF;
  SELECT * INTO h FROM public.catalog_draft_heads WHERE draft_id = d FOR UPDATE;
  IF (action = 'create' AND (FOUND OR expected <> 0)) OR (action <> 'create' AND (NOT FOUND OR expected <> h.revision)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','revision_conflict','currentRevision',coalesce(h.revision,0));
  END IF;
  IF h.status = 'abandoned' AND action <> 'resume' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_abandoned','currentRevision',h.revision); END IF;
  IF action = 'resume' AND h.status <> 'abandoned' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_not_abandoned','currentRevision',h.revision); END IF;
  IF action <> 'create' THEN
    SELECT payload->'schemaVersion' INTO prior_version FROM public.catalog_draft_revisions
    WHERE draft_id=d AND revision=h.revision;
    IF (prior_version='4'::jsonb AND c->'schemaVersion'<>'4'::jsonb)
      OR (c->'schemaVersion'='4'::jsonb AND action IN ('abandon','resume') AND prior_version IS DISTINCT FROM '4'::jsonb) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
    END IF;
  END IF;
  next_revision := coalesce(h.revision,0) + 1;
  state := CASE WHEN action = 'abandon' THEN 'abandoned' ELSE 'open' END;
  IF action IN ('abandon','resume') THEN
    IF c ? 'payload' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','abandon_payload_invalid'); END IF;
    SELECT payload INTO p FROM public.catalog_draft_revisions WHERE draft_id = d AND revision = h.revision;
    product := h.product_id;
  ELSE
    p := c->'payload';
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'schemaVersion' IS DISTINCT FROM c->'schemaVersion'
      OR jsonb_typeof(p->'product') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'skus') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p->'product'->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p->'product'->'type') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p->'product'->'type'->'key') IS DISTINCT FROM 'string'
      OR p->'product'->'type'->>'key' !~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
      OR jsonb_typeof(p->'product'->'type'->'version') IS DISTINCT FROM 'number'
      OR p->'product'->'type'->>'version' !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(p->'product'->'dimensions') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p->'product'->'dimensions') > 16 OR jsonb_array_length(p->'skus') > 10000 THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
    END IF;
    IF c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb) THEN
      IF EXISTS (SELECT FROM jsonb_object_keys(p) k WHERE k NOT IN ('schemaVersion','product','skus') AND NOT (c->'schemaVersion' IN ('3'::jsonb, '4'::jsonb) AND k = 'publication'))
        OR EXISTS (SELECT FROM jsonb_object_keys(p->'product') k WHERE k NOT IN ('id','type','slug','primarySkuId','dimensions','sharedContent','documentRevision','attributes'))
        OR (p->'product' ? 'attributes' AND jsonb_typeof(p->'product'->'attributes') IS DISTINCT FROM 'object') THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
      END IF;
    END IF;
    IF c->'schemaVersion' IN ('3'::jsonb, '4'::jsonb) THEN
      inputs := p->'publication'; content := p->'product'->'sharedContent';
      IF jsonb_typeof(inputs) IS DISTINCT FROM 'object' OR jsonb_typeof(content) IS DISTINCT FROM 'object' THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      IF inputs->>'kind' IS NULL OR inputs->>'kind' NOT IN ('release','compensation')
        OR jsonb_typeof(inputs->'operations') IS DISTINCT FROM 'array' OR jsonb_typeof(inputs->'evidence') IS DISTINCT FROM 'object'
        OR EXISTS (SELECT FROM jsonb_object_keys(inputs) k WHERE k NOT IN ('kind','operations','evidence'))
        OR content->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR content->>'catalogAction' IS NULL
        OR content->>'catalogAction' NOT IN ('create','revise') OR jsonb_typeof(content->'presentation') IS DISTINCT FROM 'object'
        OR jsonb_typeof(content->'offerMemberships') IS DISTINCT FROM 'array'
        OR jsonb_typeof(content->'requestedModes') IS DISTINCT FROM 'array'
        OR jsonb_typeof(content->'publicationSkus') IS DISTINCT FROM 'array'
        OR (content ? 'document' AND jsonb_typeof(content->'document') IS DISTINCT FROM 'object')
        OR EXISTS (SELECT FROM jsonb_object_keys(content) k WHERE k NOT IN ('schemaVersion','catalogAction','document','presentation','offerMemberships','requestedModes','publicationSkus')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      FOR code_value IN SELECT unnest(ARRAY['offerMemberships','requestedModes','publicationSkus']) LOOP
        IF jsonb_array_length(content->code_value) > 10000 THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        FOR claim IN SELECT value FROM jsonb_array_elements(content->code_value) LOOP
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE code_value WHEN 'offerMemberships' THEN ARRAY['skuCode','offerVersion','admitted']
            WHEN 'requestedModes' THEN ARRAY['skuCode','modes'] ELSE ARRAY['skuCode','title','minQuantity','isAddon','facts'] END;
          IF NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END LOOP;
      END LOOP;
      price_context := inputs#>'{evidence,priceContext}';
      IF EXISTS (SELECT FROM jsonb_object_keys(inputs->'evidence') k WHERE k NOT IN ('drafts','media')
        AND NOT (k='priceContext' AND c->'schemaVersion'='4'::jsonb)) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      FOR code_value IN SELECT unnest(ARRAY['drafts','media']) LOOP
        IF NOT (inputs->'evidence' ? code_value) THEN CONTINUE; END IF;
        IF jsonb_typeof(inputs->'evidence'->code_value) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        IF jsonb_array_length(inputs->'evidence'->code_value) < 1 OR (code_value = 'drafts' AND jsonb_array_length(inputs->'evidence'->code_value) > 100) THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
        FOR claim IN SELECT value FROM jsonb_array_elements(inputs->'evidence'->code_value) LOOP
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE code_value WHEN 'drafts' THEN ARRAY['draftId','revision','commandKey','fingerprint'] ELSE ARRAY['skuCode','mediaRef','assetRefs','revisionDigest'] END;
          IF NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END LOOP;
      END LOOP;
      FOR operation IN SELECT value FROM jsonb_array_elements(inputs->'operations') LOOP
        IF jsonb_typeof(operation) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        allowed := CASE operation->>'op'
          WHEN 'create_product' THEN ARRAY['op','productId','productSlug','name']
          WHEN 'register_document_revision' THEN ARRAY['op','productSlug','revisionId','revisionNo','documentRef','sourceRef','canonicalText','digest','provenance']
          WHEN 'create_sku' THEN ARRAY['op','skuId','skuCode','productSlug','documentRevisionNo','title','minQuantity','isAddon','facts']
          WHEN 'create_identifier' THEN ARRAY['op','skuCode','scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef']
          WHEN 'set_eligibility' THEN ARRAY['op','skuCode','sellableStandalone','sellableInSubscription']
          WHEN 'set_sku_status' THEN ARRAY['op','skuCode','status']
          WHEN 'move_document_pointer' THEN ARRAY['op','productSlug','documentRevisionNo']
          WHEN 'set_primary_sku' THEN ARRAY['op','productSlug','skuCode']
          WHEN 'set_product_status' THEN ARRAY['op','productSlug','status']
          WHEN 'set_offer_membership' THEN ARRAY['op','skuCode','offerVersion','admitted']
          WHEN 'set_product_presentation' THEN ARRAY['op','productSlug','presentation']
          WHEN 'set_sku_metadata' THEN ARRAY['op','skuCode','logisticsRef']
          WHEN 'set_product_lifecycle' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','productSlug','expectedState','state','children'] ELSE NULL END
          WHEN 'set_sku_lifecycle' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','skuCode','expectedState','state'] ELSE NULL END
          WHEN 'restore_product' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','productSlug','expectedState'] ELSE NULL END
          WHEN 'restore_sku' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','skuCode','expectedState'] ELSE NULL END
          WHEN 'set_derived_sku_facts' THEN ARRAY['op','skuCode','documentRevisionNo','netContent','facts'] ELSE NULL END;
        IF allowed IS NULL OR NOT (operation ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(operation) k WHERE NOT (k = ANY(allowed))) THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
        IF c->'schemaVersion'='4'::jsonb AND operation->>'op' IN ('set_product_status','set_sku_status') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','catalog_lifecycle_raw_status_fenced'); END IF;
        IF operation->>'op' = 'register_document_revision' THEN
          claim := operation->'provenance';
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE claim->>'source' WHEN 'current_draft' THEN ARRAY['source']
            WHEN 'retained_draft' THEN ARRAY['source','draftId','draftRevision','draftCommandKey','draftFingerprint'] ELSE NULL END;
          IF allowed IS NULL OR NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END IF;
      END LOOP;
      IF c->'schemaVersion'='4'::jsonb THEN
        -- Keep validation inside the existing invoker and its draft-role ACL.
        valid_v4 := false;
        <<v4_grammar>>
        DECLARE
          op jsonb; child jsonb; evidence jsonb; asset jsonb; previous text; verb text; ref_text text; logistics jsonb;
          previous_asset integer[]; asset_key integer[];
          uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
          code_shape constant text := '^[A-Za-z0-9._:-]{1,160}$';
        BEGIN
          FOR op IN SELECT value FROM jsonb_array_elements(inputs->'operations') LOOP
           verb := op->>'op';
           IF (op ? 'productSlug' AND (jsonb_typeof(op->'productSlug') IS DISTINCT FROM 'string'
             OR op->>'productSlug' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'))
            OR (op ? 'skuCode' AND (jsonb_typeof(op->'skuCode') IS DISTINCT FROM 'string' OR op->>'skuCode' !~ code_shape)) THEN EXIT v4_grammar; END IF;
           IF verb='set_eligibility' AND (jsonb_typeof(op->'sellableStandalone') IS DISTINCT FROM 'boolean'
             OR jsonb_typeof(op->'sellableInSubscription') IS DISTINCT FROM 'boolean') THEN EXIT v4_grammar; END IF;
           IF verb IN ('set_product_lifecycle','set_sku_lifecycle') AND
            (coalesce(op->>'expectedState','') NOT IN ('draft','active','withdrawn','archived')
             OR coalesce(op->>'state','') NOT IN ('active','withdrawn','archived')) THEN EXIT v4_grammar; END IF;
           IF verb IN ('restore_product','restore_sku') AND op->'expectedState' IS DISTINCT FROM '"withdrawn"'::jsonb THEN EXIT v4_grammar; END IF;
           IF verb='set_product_lifecycle' THEN
            IF jsonb_typeof(op->'children') IS DISTINCT FROM 'array' THEN EXIT v4_grammar; END IF;
            IF jsonb_array_length(op->'children')>50000 THEN EXIT v4_grammar; END IF;
            previous := NULL;
            FOR child IN SELECT value FROM jsonb_array_elements(op->'children') LOOP
             IF jsonb_typeof(child) IS DISTINCT FROM 'object' OR child - ARRAY['skuCode','expectedState'] <> '{}'::jsonb
              OR jsonb_typeof(child->'skuCode') IS DISTINCT FROM 'string' OR child->>'skuCode' !~ code_shape
              OR coalesce(child->>'expectedState','') NOT IN ('draft','active','withdrawn','archived')
              OR previous COLLATE "C">=child->>'skuCode' COLLATE "C" THEN EXIT v4_grammar; END IF;
             previous := child->>'skuCode';
            END LOOP;
           END IF;
           IF (verb='restore_sku' OR verb='set_sku_lifecycle' AND op->>'state'='active')
             AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inputs->'operations') e
               WHERE e->>'op'='set_eligibility' AND e->'skuCode'=op->'skuCode'
                AND (e->'sellableStandalone'='true'::jsonb OR e->'sellableInSubscription'='true'::jsonb)) THEN EXIT v4_grammar; END IF;
          END LOOP;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(inputs#>'{evidence,drafts}') e GROUP BY e->>'draftId' HAVING count(*)>1)
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(inputs#>'{evidence,media}') e GROUP BY e->>'skuCode' HAVING count(*)>1) THEN EXIT v4_grammar; END IF;
          FOR evidence IN SELECT value FROM jsonb_array_elements(inputs#>'{evidence,drafts}') LOOP
           IF jsonb_typeof(evidence->'draftId') IS DISTINCT FROM 'string' OR evidence->>'draftId' !~ uuid_shape
            OR jsonb_typeof(evidence->'revision') IS DISTINCT FROM 'number' OR evidence->>'revision' !~ '^[1-9][0-9]{0,9}$'
            OR jsonb_typeof(evidence->'commandKey') IS DISTINCT FROM 'string'
            OR jsonb_typeof(evidence->'fingerprint') IS DISTINCT FROM 'string' OR evidence->>'fingerprint' !~ '^[a-f0-9]{64}$' THEN EXIT v4_grammar; END IF;
           IF (evidence->>'revision')::bigint>2147483647 THEN EXIT v4_grammar; END IF;
          END LOOP;
          FOR evidence IN SELECT value FROM jsonb_array_elements(inputs#>'{evidence,media}') LOOP
           IF jsonb_typeof(evidence->'skuCode') IS DISTINCT FROM 'string' OR evidence->>'skuCode' !~ code_shape
            OR jsonb_typeof(evidence->'mediaRef') IS DISTINCT FROM 'string'
            OR jsonb_typeof(evidence->'revisionDigest') IS DISTINCT FROM 'string' OR evidence->>'revisionDigest' !~ '^[a-f0-9]{64}$'
            OR jsonb_typeof(evidence->'assetRefs') IS DISTINCT FROM 'array' THEN EXIT v4_grammar; END IF;
           IF jsonb_array_length(evidence->'assetRefs')>32 THEN EXIT v4_grammar; END IF;
           previous_asset := NULL;
           FOR asset IN SELECT value FROM jsonb_array_elements(evidence->'assetRefs') LOOP
            IF jsonb_typeof(asset) IS DISTINCT FROM 'string' THEN EXIT v4_grammar; END IF;
            -- The invoker draft path uses built-ins only, with the same UTF-16
            -- order as the catalogue's canonical and retained-fact checks.
            SELECT ARRAY(SELECT CASE WHEN scalar>65535 THEN scalar-10240 WHEN scalar>=57344 THEN scalar+1046528 ELSE scalar END
             FROM (SELECT ascii(ch) AS scalar,n FROM regexp_split_to_table(asset#>>'{}','') WITH ORDINALITY c(ch,n)) units ORDER BY n) INTO asset_key;
            IF previous_asset>=asset_key THEN EXIT v4_grammar; END IF;
            previous_asset := asset_key;
           END LOOP;
          END LOOP;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'skus') a
            WHERE a ? 'assetRefs' AND CASE WHEN jsonb_typeof(a->'assetRefs')='array'
                 THEN jsonb_array_length(a->'assetRefs')>32 OR EXISTS(
                   SELECT 1 FROM jsonb_array_elements(a->'assetRefs') r WHERE jsonb_typeof(r)<>'string')
                 ELSE true END) THEN EXIT v4_grammar; END IF;
          -- The draft wire bounds references in UTF-16 and uses JavaScript trim.
          FOR ref_text IN
            SELECT e->>'commandKey' FROM jsonb_array_elements(inputs#>'{evidence,drafts}') e
            UNION ALL SELECT e->>'mediaRef' FROM jsonb_array_elements(inputs#>'{evidence,media}') e
            UNION ALL SELECT a#>>'{}' FROM jsonb_array_elements(inputs#>'{evidence,media}') e,
              LATERAL jsonb_array_elements(e->'assetRefs') a
            UNION ALL SELECT r#>>'{}' FROM jsonb_array_elements(p->'skus') a, LATERAL jsonb_array_elements(a->'assetRefs') r
          LOOP
            IF ref_text='' OR ref_text<>btrim(ref_text,trim_space)
             OR char_length(ref_text)+(SELECT count(*) FROM regexp_split_to_table(ref_text,'') ch WHERE octet_length(ch)=4)>240
            THEN EXIT v4_grammar; END IF;
          END LOOP;
          FOR logistics IN
            SELECT a->'logisticsRef' FROM jsonb_array_elements(p->'skus') a WHERE a ? 'logisticsRef'
            UNION ALL SELECT o->'logisticsRef' FROM jsonb_array_elements(inputs->'operations') o
             WHERE o->>'op'='set_sku_metadata' AND o->'logisticsRef'<>'null'::jsonb
          LOOP
            IF jsonb_typeof(logistics) IS DISTINCT FROM 'string'
             OR logistics#>>'{}'='' OR logistics#>>'{}'<>btrim(logistics#>>'{}',trim_space)
             OR char_length(logistics#>>'{}')+(SELECT count(*) FROM regexp_split_to_table(logistics#>>'{}','') ch WHERE octet_length(ch)=4)>240 THEN EXIT v4_grammar; END IF;
          END LOOP;
          valid_v4 := true;
        END v4_grammar;
        IF NOT valid_v4 THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
      END IF;
    END IF;
    product := (p->'product'->>'id')::uuid;
    IF product::text <> p->'product'->>'id' OR (h.product_id IS NOT NULL AND h.product_id <> product)
      OR (p->'product' ? 'documentRevision' AND p->'product'->'documentRevision'->>'productId' IS DISTINCT FROM product::text)
      OR (p->'product' ? 'primarySkuId' AND NOT EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x WHERE x->>'id' = p->'product'->>'primarySkuId')) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','product_reference_invalid');
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x GROUP BY x->>'id' HAVING count(*) > 1)
      OR EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x WHERE x ? 'code' GROUP BY x->>'code' HAVING count(*) > 1) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','sku_identity_duplicate');
    END IF;
    FOR s IN SELECT value FROM jsonb_array_elements(p->'skus') LOOP
      IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'id') IS DISTINCT FROM 'string'
        OR s->>'productId' IS DISTINCT FROM product::text OR s ? 'sharedContent'
        OR jsonb_typeof(s->'options') IS DISTINCT FROM 'object'
        OR (s ? 'code' AND (jsonb_typeof(s->'code') IS DISTINCT FROM 'string' OR length(s->>'code') NOT BETWEEN 1 AND 160 OR btrim(s->>'code') <> s->>'code' OR s->>'code' !~ '^[A-Za-z0-9._:-]+$')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','sku_reference_invalid');
      END IF;
      IF c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb) THEN
        IF EXISTS (SELECT FROM jsonb_object_keys(s) k WHERE k NOT IN ('id','productId','code','options','netContent','identifiers','assetRefs','grossMass','logisticsRef','attributes','priceOperations'))
          OR (s ? 'attributes' AND jsonb_typeof(s->'attributes') IS DISTINCT FROM 'object')
          OR (s ? 'priceOperations' AND jsonb_typeof(s->'priceOperations') IS DISTINCT FROM 'array') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
        END IF;
        FOR operation IN SELECT value FROM jsonb_array_elements(coalesce(s->'priceOperations','[]'::jsonb)) LOOP
          IF c->'schemaVersion'='4'::jsonb AND operation->'schemaVersion'='2'::jsonb THEN
            IF EXISTS (SELECT FROM (VALUES (operation->'unitPriceMinor',1),(operation#>'{expected,unitPriceMinor}',0)) m(v,lo)
              WHERE CASE WHEN jsonb_typeof(v)='number' THEN (v::text)::numeric NOT BETWEEN lo AND 2147483647
                OR (v::text)::numeric <> trunc((v::text)::numeric) ELSE false END) THEN
              RETURN jsonb_build_object('outcome','validation_issue','reason','money_amount_out_of_range');
            END IF;
            IF NOT public.catalog_price_setup_v2_command_valid(operation) OR operation->>'variantId' IS DISTINCT FROM s->>'id' THEN
              RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
            END IF;
            IF (operation->'priceListId',operation->'expectedListAmountBasis') IS DISTINCT FROM
              (price_context->'priceListId',price_context->'amountBasis') THEN
              RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
            END IF;
            has_basis_operation := true; CONTINUE;
          END IF;
          IF jsonb_typeof(operation) IS DISTINCT FROM 'object' OR jsonb_typeof(operation->'expected') IS DISTINCT FROM 'object' THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
          expectation := operation->'expected';
          IF EXISTS (SELECT FROM jsonb_object_keys(operation) k WHERE k NOT IN ('schemaVersion','commandKey','variantId','priceListId','mode','minQty','amountKind','unitPriceMinor','expected'))
            OR EXISTS (SELECT FROM jsonb_object_keys(expectation) k WHERE k NOT IN ('entryId','unitPriceMinor'))
            OR operation->'schemaVersion' IS DISTINCT FROM '1'::jsonb
            OR jsonb_typeof(operation->'commandKey') IS DISTINCT FROM 'string'
            OR length(operation->>'commandKey') NOT BETWEEN 1 AND 240 OR btrim(operation->>'commandKey') <> operation->>'commandKey'
            OR operation->>'variantId' IS DISTINCT FROM s->>'id'
            OR jsonb_typeof(operation->'priceListId') IS DISTINCT FROM 'string'
            OR operation->>'priceListId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR operation->'mode' IS DISTINCT FROM '"one_time"'::jsonb OR operation->'minQty' IS DISTINCT FROM '1'::jsonb
            OR operation->'amountKind' IS DISTINCT FROM '"gross"'::jsonb
            OR jsonb_typeof(operation->'unitPriceMinor') IS DISTINCT FROM 'number'
            OR operation->>'unitPriceMinor' !~ '^[1-9][0-9]{0,9}$'
            OR NOT (expectation ? 'entryId' AND expectation ? 'unitPriceMinor')
            OR NOT ((jsonb_typeof(expectation->'entryId') = 'null' AND jsonb_typeof(expectation->'unitPriceMinor') = 'null')
              OR (jsonb_typeof(expectation->'entryId') = 'string'
                AND expectation->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND jsonb_typeof(expectation->'unitPriceMinor') = 'number' AND expectation->>'unitPriceMinor' ~ '^(0|[1-9][0-9]{0,9})$')) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
          IF (operation->>'unitPriceMinor')::bigint > 2147483647 OR (expectation->>'unitPriceMinor')::bigint > 2147483647 THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
        END LOOP;
      END IF;
      sku := (s->>'id')::uuid;
      IF sku::text <> s->>'id' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','sku_reference_invalid'); END IF;
      SELECT * INTO reserved FROM public.catalog_draft_sku_reservations WHERE sku_id = sku;
      IF FOUND AND (reserved.draft_id <> d OR reserved.product_id <> product OR (reserved.code IS NOT NULL AND reserved.code IS DISTINCT FROM s->>'code')) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','sku_identity_reserved');
      END IF;
    END LOOP;
    IF has_basis_operation OR price_context IS NOT NULL THEN
      tax_context := price_context->'tax';
      IF NOT has_basis_operation OR (CASE WHEN jsonb_typeof(price_context)='object' THEN
        price_context - ARRAY['priceListId','regionCode','currency','amountBasis','tax']='{}'::jsonb
        AND price_context->>'priceListId' COLLATE "C" ~ price_uuid
        AND price_context->>'regionCode' COLLATE "C" ~ '^[A-Z]{2}$' AND price_context->>'currency' COLLATE "C" ~ '^[A-Z]{3}$'
        AND (price_context->'amountBasis'='"tax_inclusive"'::jsonb AND tax_context='null'::jsonb
          OR price_context->'amountBasis'='"tax_exclusive"'::jsonb AND CASE WHEN jsonb_typeof(tax_context)='object' THEN
            tax_context - ARRAY['market','taxClassKey','classMapRevision','classMapDigest']='{}'::jsonb
            AND jsonb_typeof(tax_context->'classMapDigest')='string' AND tax_context->>'classMapDigest' COLLATE "C" ~ '^[a-f0-9]{64}$'
            AND NOT EXISTS (SELECT FROM unnest(ARRAY['market','taxClassKey','classMapRevision']) AS t(k)
              CROSS JOIN LATERAL (SELECT tax_context->>k AS value) ref
              WHERE jsonb_typeof(tax_context->k) IS DISTINCT FROM 'string' OR value<>btrim(value,trim_space)
                OR char_length(value)+(SELECT count(*) FROM regexp_split_to_table(value,'') ch WHERE octet_length(ch)=4) NOT BETWEEN 1 AND 240) ELSE false END) ELSE false END)
        IS DISTINCT FROM true THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
      END IF;
      IF EXISTS (SELECT FROM jsonb_path_query(p,'$.skus[*].priceOperations[*].commandKey') k GROUP BY k HAVING count(*)>1) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','catalog_publication_price_key_reused');
      END IF;
    END IF;
  END IF;
  -- The exception block rolls back every write if any cross-draft reservation loses a race.
  BEGIN
    IF action = 'create' THEN INSERT INTO public.catalog_draft_heads VALUES(d,product,next_revision,state);
    ELSE UPDATE public.catalog_draft_heads SET revision=next_revision,status=state WHERE draft_id=d; END IF;
    IF action IN ('create','revise') THEN
      FOR s IN SELECT value FROM jsonb_array_elements(p->'skus') LOOP
        INSERT INTO public.catalog_draft_sku_reservations(sku_id,draft_id,product_id,code)
          VALUES((s->>'id')::uuid,d,product,s->>'code') ON CONFLICT(sku_id) DO NOTHING;
        SELECT * INTO reserved FROM public.catalog_draft_sku_reservations WHERE sku_id=(s->>'id')::uuid FOR UPDATE;
        IF reserved.draft_id <> d OR reserved.product_id <> product OR (reserved.code IS NOT NULL AND reserved.code IS DISTINCT FROM s->>'code') THEN
          RAISE unique_violation USING MESSAGE='sku_identity_reserved';
        END IF;
        IF reserved.code IS NULL AND s ? 'code' THEN
          UPDATE public.catalog_draft_sku_reservations SET code=s->>'code' WHERE sku_id=(s->>'id')::uuid;
        END IF;
      END LOOP;
    END IF;
    INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id)
      VALUES(d,next_revision,product,state,p,key,p_fingerprint,actor);
    INSERT INTO public.catalog_draft_command_receipts VALUES(d,key,p_fingerprint,next_revision);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('outcome','conflict','reason','identity_reserved');
  END;
  RETURN jsonb_build_object('outcome','committed','record',public.catalog_draft_record(d,next_revision));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
END;
$$;
