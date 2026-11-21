-- Native governed catalogue draft, issuance and readback.
CREATE OR REPLACE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; operation jsonb; expectation jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text; inputs jsonb; content jsonb; claim jsonb; allowed text[]; valid_v4 boolean; prior_version jsonb;
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
      IF EXISTS (SELECT FROM jsonb_object_keys(inputs->'evidence') k WHERE k NOT IN ('drafts','media')) THEN
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
            WHERE (a ? 'demandPolicyRef' AND jsonb_typeof(a->'demandPolicyRef') IS DISTINCT FROM 'string')
               OR (a ? 'assetRefs' AND CASE WHEN jsonb_typeof(a->'assetRefs')='array'
                 THEN jsonb_array_length(a->'assetRefs')>32 OR EXISTS(
                   SELECT 1 FROM jsonb_array_elements(a->'assetRefs') r WHERE jsonb_typeof(r)<>'string')
                 ELSE true END)) THEN EXIT v4_grammar; END IF;
          -- The draft wire bounds references in UTF-16 and uses JavaScript trim.
          FOR ref_text IN
            SELECT e->>'commandKey' FROM jsonb_array_elements(inputs#>'{evidence,drafts}') e
            UNION ALL SELECT e->>'mediaRef' FROM jsonb_array_elements(inputs#>'{evidence,media}') e
            UNION ALL SELECT a#>>'{}' FROM jsonb_array_elements(inputs#>'{evidence,media}') e,
              LATERAL jsonb_array_elements(e->'assetRefs') a
            UNION ALL SELECT a->>'demandPolicyRef' FROM jsonb_array_elements(p->'skus') a WHERE a ? 'demandPolicyRef'
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
        IF EXISTS (SELECT FROM jsonb_object_keys(s) k WHERE k NOT IN ('id','productId','code','options','netContent','identifiers','assetRefs','grossMass','logisticsRef','attributes','priceOperations') AND NOT (c->'schemaVersion'='4'::jsonb AND k='demandPolicyRef'))
          OR (s ? 'attributes' AND jsonb_typeof(s->'attributes') IS DISTINCT FROM 'object')
          OR (s ? 'priceOperations' AND jsonb_typeof(s->'priceOperations') IS DISTINCT FROM 'array') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
        END IF;
        FOR operation IN SELECT value FROM jsonb_array_elements(coalesce(s->'priceOperations','[]'::jsonb)) LOOP
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

CREATE FUNCTION public.admin_archive_catalog_sku(p_actor_id uuid, p_sku text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501', HINT='Use a governed catalogue publication.';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_archive_catalog_sku(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_activate_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501', HINT='Use a governed catalogue publication.';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_activate_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_archive_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501', HINT='Use a governed catalogue publication.';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_archive_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_restore_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501', HINT='Use a governed catalogue publication.';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_restore_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_deactivate_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501', HINT='Use a governed catalogue publication.';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_deactivate_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_assert_archive(p_product uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'catalog_archive_barrier_unavailable' USING ERRCODE='23514', CONSTRAINT='catalog_archive_barrier_unavailable',
  HINT='Keep the product or SKU withdrawn until governed archive is supported.';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_assert_archive(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_publication_candidate_source(p_product uuid, p_ref text, p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parts text[]; authored jsonb; definition_digest text; expected_head jsonb;
 uuid_text CONSTANT text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
BEGIN
 parts := regexp_match(p_ref,'^v1:(' || uuid_text || ')@([1-9][0-9]{0,9})/(unpublished|(' || uuid_text || ')@([1-9][0-9]{0,9}))$');
 IF parts IS NOT NULL THEN
  IF parts[4] IS NOT NULL THEN
   expected_head := public.catalog_publication_head_ref(p_product,parts[4]::uuid);
  END IF;
  SELECT d.payload,t.definition_digest INTO authored,definition_digest
  FROM public.catalog_draft_revisions d
  JOIN public.catalog_draft_command_receipts r
   ON (r.draft_id,r.command_key,r.revision,r.fingerprint)=(d.draft_id,d.command_key,d.revision,d.fingerprint)
  JOIN public.catalog_type_versions t
   ON (t.type_key,to_jsonb(t.version))=(d.payload #>> '{product,type,key}',d.payload #> '{product,type,version}')
  WHERE d.draft_id=parts[1]::uuid AND d.revision=parts[2]::integer AND d.product_id=p_product
   AND d.status='open' AND d.payload->'schemaVersion' IN ('3'::jsonb,'4'::jsonb);
  IF authored IS NOT NULL AND (parts[4] IS NULL OR expected_head->>'revision'=parts[5])
   -- Each element starts at its own root depth, as in the released candidate reader.
   AND encode(sha256(convert_to('["catalog-candidate",1,' || public.catalog_publication_canonical(authored,0) || ','
     || public.catalog_publication_canonical(jsonb_build_array((authored #> '{product,type}') ||
       jsonb_build_object('definitionDigest',definition_digest)),0) || ','
     || public.catalog_publication_canonical(coalesce(expected_head,'null'::jsonb),0) || ']','UTF8')),'hex')=p_digest THEN
   RETURN authored;
  END IF;
 END IF;
 RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_product_facts(p_product uuid,product jsonb,p_live boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE content_problem text;
BEGIN
 IF jsonb_typeof(product) IS DISTINCT FROM 'object'
   OR NOT (product ?& ARRAY['id','slug','name','status','type','axes','attributes','primarySkuId','document','presentation','source','content'])
   OR product - ARRAY['id','slug','name','status','type','axes','attributes','primarySkuId','document','presentation','source','content'] - (CASE WHEN product->'schemaVersion'='3'::jsonb THEN ARRAY['schemaVersion', 'lifecycleState', 'definitionDigest'] ELSE ARRAY[]::text[] END) <> '{}'::jsonb
   OR (product->'schemaVersion'='3'::jsonb AND (
    jsonb_typeof(product->'lifecycleState')='string'
    AND product->>'lifecycleState' IN ('draft','active','withdrawn','archived')
    AND product->>'status'=CASE WHEN product->>'lifecycleState'='withdrawn' THEN 'active' ELSE product->>'lifecycleState' END
    AND jsonb_typeof(product->'definitionDigest')='string'
    AND product->>'definitionDigest' ~ '^[a-f0-9]{64}$'
   ) IS DISTINCT FROM true)
   OR product->'id' IS DISTINCT FROM to_jsonb(p_product)
   OR jsonb_typeof(product->'slug') IS DISTINCT FROM 'string' OR product->>'slug'=''
   OR jsonb_typeof(product->'type') IS DISTINCT FROM 'object'
   OR (product->'type') - ARRAY['key','version'] <> '{}'::jsonb
   OR (CASE WHEN jsonb_typeof(product #> '{type,version}')='number' AND product #>> '{type,version}' ~ '^[1-9][0-9]{0,9}$'
      THEN (product #>> '{type,version}')::numeric>2147483647 ELSE true END)
   OR jsonb_typeof(product #> '{type,key}') IS DISTINCT FROM 'string' OR length(product #>> '{type,key}')>120
   OR product #>> '{type,key}' !~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
   OR public.catalog_publication_text_valid(product->'name',500,false) IS DISTINCT FROM true
   OR jsonb_typeof(product->'primarySkuId') IS DISTINCT FROM 'string'
   OR product->>'primarySkuId' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   OR product->>'status' NOT IN ('draft','active','archived') OR product->>'status' IS NULL
   OR jsonb_typeof(product->'content') IS DISTINCT FROM 'object'
   OR NOT ((product->'content') ?& ARRAY['schemaVersion','catalogAction','presentation','offerMemberships','requestedModes','publicationSkus'])
   OR (product->'content') - ARRAY['schemaVersion','catalogAction','presentation','offerMemberships','requestedModes','publicationSkus'] <> '{}'::jsonb
   OR product #> '{content,schemaVersion}' IS DISTINCT FROM '1'::jsonb
   OR product #>> '{content,catalogAction}' NOT IN ('create','revise') OR product #>> '{content,catalogAction}' IS NULL
   OR jsonb_typeof(product #> '{content,presentation}') IS DISTINCT FROM 'object'
   OR jsonb_typeof(product #> '{content,offerMemberships}') IS DISTINCT FROM 'array'
   OR jsonb_typeof(product #> '{content,requestedModes}') IS DISTINCT FROM 'array'
   OR jsonb_typeof(product #> '{content,publicationSkus}') IS DISTINCT FROM 'array'
  THEN
  RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
 END IF;
 IF (CASE WHEN jsonb_typeof(product->'axes')='array' THEN jsonb_array_length(product->'axes')>16
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(product->'axes') axis GROUP BY axis HAVING count(*)>1)
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(product->'axes') axis WHERE jsonb_typeof(axis)<>'string'
      OR axis #>> '{}' !~ '^[a-z][a-z0-9_-]{0,63}$' OR axis #>> '{}' IN ('constructor','prototype'))
   ELSE true END) THEN
  RAISE EXCEPTION 'catalog_publication_axes_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_axes_invalid';
 END IF;
 IF NOT public.catalog_publication_attributes_valid(product->'attributes') THEN
  RAISE EXCEPTION 'catalog_publication_attributes_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_attributes_invalid';
 END IF;
 content_problem := public.catalog_publication_content_problem(product->'content');
 IF product->'presentation'<>'null'::jsonb AND NOT public.catalog_publication_presentation_valid(product->'presentation') THEN
  content_problem := 'presentation';
 END IF;
 IF content_problem IS NOT NULL THEN
  RAISE EXCEPTION 'catalog_publication_content_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_content_invalid', COLUMN=content_problem;
 END IF;
 IF NOT public.catalog_publication_claim_valid(product->'source') THEN
  RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
 END IF;
 IF NOT public.catalog_publication_carriers_valid(jsonb_build_object('document',product->'document'),p_product) THEN
  RAISE EXCEPTION 'catalog_publication_document_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_document_invalid';
 END IF;
 -- Content has been checked by field. The document reference contains only its exact identity.
 IF NOT public.catalog_publication_carriers_valid(product-ARRAY['document','content']) THEN
  RAISE EXCEPTION 'catalog_publication_facts_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_facts_invalid';
 END IF;
 IF p_live AND octet_length(public.catalog_publication_canonical(product,1))>16777216 THEN
  RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
 END IF;
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 IF p_live THEN
  RAISE EXCEPTION 'catalog_publication_facts_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_facts_invalid';
 END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_sku_projection(p_sku uuid,p_product uuid,p_code text,body jsonb,p_live boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE canonical text;
BEGIN
 IF jsonb_typeof(body) IS DISTINCT FROM 'object'
   OR NOT (body ?& ARRAY['id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription',
     'netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source'])
   OR body - ARRAY['id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription',
     'netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source'] - (CASE WHEN body->'schemaVersion'='3'::jsonb THEN ARRAY['schemaVersion', 'lifecycleState', 'optionDigest', 'demandPolicyRef'] ELSE ARRAY[]::text[] END) <> '{}'::jsonb
   OR (body->'schemaVersion'='3'::jsonb AND (
    jsonb_typeof(body->'lifecycleState')='string'
    AND body->>'lifecycleState' IN ('draft','active','withdrawn','archived')
    AND body->>'status'=CASE WHEN body->>'lifecycleState'='withdrawn' THEN 'active' ELSE body->>'lifecycleState' END
    AND jsonb_typeof(body->'optionDigest')='string'
    AND body->>'optionDigest' ~ '^[a-f0-9]{64}$'
    AND (NOT (body ? 'demandPolicyRef') OR public.catalog_publication_text_valid(body->'demandPolicyRef',240,true))
    AND (body->>'lifecycleState'='active' OR (body->'sellableStandalone',body->'sellableInSubscription')=('false'::jsonb,'false'::jsonb))
   ) IS DISTINCT FROM true)
   OR body->'id' IS DISTINCT FROM to_jsonb(p_sku) OR body->'productId' IS DISTINCT FROM to_jsonb(p_product)
   OR body->'code' IS DISTINCT FROM to_jsonb(p_code) OR p_code !~ '^[A-Za-z0-9._:-]{1,160}$'
   OR body->>'status' NOT IN ('draft','active','archived') OR body->>'status' IS NULL
   OR jsonb_typeof(body->'minQuantity') IS DISTINCT FROM 'number' OR body->>'minQuantity' !~ '^[1-9][0-9]{0,9}$'
   OR (body->>'minQuantity')::numeric>2147483647
   OR jsonb_typeof(body->'isAddon') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'sellableStandalone') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'sellableInSubscription') IS DISTINCT FROM 'boolean'
   OR public.catalog_publication_quantity_valid(body->'netContent') IS DISTINCT FROM true
   OR (body->'grossMass'<>'null'::jsonb AND public.catalog_publication_quantity_valid(body->'grossMass') IS DISTINCT FROM true)
   OR jsonb_typeof(body->'options') IS DISTINCT FROM 'object'
     OR jsonb_typeof(body->'identifiers') IS DISTINCT FROM 'array'
   OR jsonb_typeof(body->'assetRefs') IS DISTINCT FROM 'array'
   OR jsonb_typeof(body->'logisticsRef') NOT IN ('string','null')
   OR jsonb_typeof(body->'memberships') IS DISTINCT FROM 'array'
   OR NOT public.catalog_publication_claim_valid(body->'source') THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
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
 -- Exact detail places each SKU at $.items[index].facts, three levels deep.
 canonical := public.catalog_publication_canonical(body,3);
 IF octet_length(canonical)>2097152 THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 -- Core-S already runs this live variant at the deferred SKU event. Compare
 -- the final SKU, since a creation snapshot can precede the transaction's final facts.
 IF p_live AND body->'schemaVersion'='3'::jsonb AND NOT EXISTS (
   SELECT 1 FROM public.catalog_publication_heads h
   JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
   CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
   JOIN public.catalog_sku_revisions r ON (r.product_id,r.sku_id,r.id)=(h.product_id,p_sku,(ref->>'revisionId')::uuid)
   JOIN public.catalog_skus current_sku ON (current_sku.product_id,current_sku.id)=(r.product_id,r.sku_id)
   WHERE h.product_id=p_product AND ref->'skuId'=to_jsonb(p_sku)
     AND p.canonical_state::jsonb->'schemaVersion'='3'::jsonb
     AND r.full_facts::jsonb=current_sku.publication_facts
     AND encode(current_sku.combination_digest,'hex')=current_sku.publication_facts->>'optionDigest'
     AND current_sku.status=current_sku.publication_facts->>'status'
     AND to_jsonb(current_sku.sellable_standalone)=current_sku.publication_facts->'sellableStandalone'
     AND to_jsonb(current_sku.sellable_in_subscription)=current_sku.publication_facts->'sellableInSubscription'
 ) THEN
  RAISE EXCEPTION 'catalog_lifecycle_raw_status_fenced' USING ERRCODE='23514', CONSTRAINT='catalog_lifecycle_raw_status_fenced',
    HINT='Use a governed catalogue publication and let its recorder issue the sealed head.';
 END IF;
 RETURN canonical;
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 IF p_live AND SQLERRM<>'catalog_lifecycle_raw_status_fenced' THEN
  RAISE EXCEPTION 'catalog_publication_facts_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_facts_invalid';
 END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_sku_facts(p_sku public.catalog_sku_revisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE body jsonb;
BEGIN
 body := p_sku.full_facts::jsonb;
 IF public.catalog_publication_sku_projection(p_sku.sku_id,p_sku.product_id,p_sku.sku_code,body,false)<>p_sku.full_facts
   OR encode(sha256(convert_to(p_sku.full_facts,'UTF8')),'hex')<>p_sku.digest THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 RETURN body;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_manifest_text(p_product uuid,p_text text,p_digest text,p_approval boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE manifest jsonb; product jsonb;
BEGIN
 manifest := p_text::jsonb;
 product := manifest->'product';
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object'
   OR NOT (manifest ?& ARRAY['schemaVersion','product','skus'])
   OR manifest - ARRAY['schemaVersion','product','skus'] <> '{}'::jsonb
   OR manifest->'schemaVersion' IS DISTINCT FROM coalesce(product->'schemaVersion','2'::jsonb)
   OR jsonb_typeof(manifest->'skus') IS DISTINCT FROM 'array'
   OR p_text<>public.catalog_publication_canonical(manifest,0)
   OR p_digest<>encode(sha256(convert_to(p_text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
 END IF;

 IF p_approval AND jsonb_array_length(manifest->'skus')>10000 THEN
  RAISE EXCEPTION 'catalog_publication_roster_limit' USING ERRCODE='23514', CONSTRAINT='catalog_publication_roster_limit';
 END IF;
 IF p_approval AND (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(manifest->'skus') member
   WHERE member->'skuId'=product->'primarySkuId') OR EXISTS (
  SELECT 1 FROM (
   SELECT member, lag(member->>'skuId') OVER (ORDER BY position) AS previous_sku
   FROM jsonb_array_elements(manifest->'skus') WITH ORDINALITY AS r(member,position)
  ) AS roster
   WHERE ((previous_sku IS NULL OR previous_sku COLLATE "C"<(member->>'skuId') COLLATE "C")
    AND jsonb_typeof(member)='object' AND member ?& ARRAY['skuId','digest']
    AND member - ARRAY['skuId','digest']='{}'::jsonb
    AND jsonb_typeof(member->'skuId')='string' AND member->>'skuId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND jsonb_typeof(member->'digest')='string' AND member->>'digest' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
 )) THEN
  RAISE EXCEPTION 'catalog_publication_approval_state_valid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_approval_state_valid';
 END IF;
 PERFORM public.catalog_publication_product_facts(p_product,product,false);
 IF NOT public.catalog_publication_carriers_valid(manifest->'skus') THEN
  RAISE EXCEPTION 'catalog_publication_facts_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_facts_invalid';
 END IF;
 RETURN p_text;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
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
 IF coalesce(product->'schemaVersion','2'::jsonb) IS DISTINCT FROM (CASE WHEN authored->'schemaVersion'='4'::jsonb THEN '3'::jsonb ELSE '2'::jsonb END)
   OR (prior.id IS NOT NULL AND prior.canonical_state::jsonb->'schemaVersion' IS DISTINCT FROM coalesce(product->'schemaVersion','2'::jsonb))
   OR (product->'schemaVersion'='3'::jsonb AND NOT EXISTS (
     SELECT 1 FROM public.catalog_type_versions t
     WHERE t.type_key=product #>> '{type,key}' AND to_jsonb(t.version)=product #> '{type,version}'
       AND t.definition_digest=product->>'definitionDigest'))
   OR product->'type' IS DISTINCT FROM authored #> '{product,type}'
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
    public.catalog_publication_sku_facts(r) AS facts
  FROM public.catalog_sku_revisions r WHERE r.publication_id=p_issue AND r.product_id=p_product
 ), merged AS (
  SELECT coalesce(new.sku_id::text,old.reference->>'skuId') AS sku_id,new.id AS issued_id,
   new.revision,new.sku_code,coalesce(new.facts->>'lifecycleState',new.facts->>'status') AS status,new.issue_ordinal,new.facts->'source' AS source,
   coalesce(new.facts->'schemaVersion','2'::jsonb) AS fact_version,
   product->'schemaVersion'='3'::jsonb AND (new.facts->'sellableStandalone'='true'::jsonb
     OR new.facts->'sellableInSubscription'='true'::jsonb) AS fresh_sale,
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
    OR m.source IS DISTINCT FROM product->'source'
    OR m.fact_version IS DISTINCT FROM coalesce(product->'schemaVersion','2'::jsonb)
    OR (product->>'lifecycleState' IS DISTINCT FROM 'active' AND m.fresh_sale))
    FILTER (WHERE m.issued_id IS NOT NULL),false),
  count(DISTINCT coalesce(m.sku_code,inherited.sku_code))::integer,
  coalesce(jsonb_agg(jsonb_build_object('productId',p_product,'variantId',m.sku_id,'sku',m.sku_code,
   'state',CASE WHEN m.status='archived' AND coalesce(product->'schemaVersion','2'::jsonb)='2'::jsonb THEN 'withdrawn' ELSE m.status END,'variantRevision',m.revision,
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

 IF product->'schemaVersion'='3'::jsonb THEN
  IF product->>'lifecycleState'='archived' OR EXISTS (
    SELECT 1 FROM public.catalog_sku_revisions r WHERE r.publication_id=p_issue AND r.full_facts::jsonb->>'lifecycleState'='archived'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(authored #> '{publication,operations}') op
    WHERE op->>'op' IN ('set_product_lifecycle','set_sku_lifecycle') AND op->>'state'='archived')
  THEN PERFORM public.catalog_lifecycle_assert_archive(p_product); END IF;
  IF product->>'lifecycleState'<>'active' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(roster) ref
    JOIN public.catalog_sku_revisions r ON (r.product_id,r.id)=(p_product,(ref->>'revisionId')::uuid)
    WHERE r.full_facts::jsonb->'sellableStandalone'='true'::jsonb
       OR r.full_facts::jsonb->'sellableInSubscription'='true'::jsonb) THEN
   RAISE EXCEPTION 'catalog_lifecycle_fresh_sale_refused' USING ERRCODE='23514', CONSTRAINT='catalog_lifecycle_fresh_sale_refused';
  END IF;
 END IF;

 -- Budget a page containing only the item at each offset. The other fields
 -- are fixed, including the exact unpadded base64url continuation length.
 WITH base AS MATERIALIZED (
  SELECT octet_length(public.catalog_publication_canonical(jsonb_build_object('outcome','page','schemaVersion',coalesce(product->'schemaVersion','2'::jsonb),
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

 PERFORM public.catalog_publication_assert_candidate(NULL,issue,jsonb_build_object('schemaVersion',coalesce(product->'schemaVersion','2'::jsonb),'product',product,'skus',approved_roster));
 receipt_result := public.catalog_publication_assert_receipt(p_product,issue.command_key);
 expected_receipt := jsonb_build_object('schemaVersion',coalesce(product->'schemaVersion','2'::jsonb),'productId',p_product,'commandKey',issue.command_key,
   'fingerprint',issue.command_fingerprint,'actorId',issue.actor_id,'head',head,'previousHead',previous_head,
   'publicationDigest',issue.digest,'committedAt',to_char(issue.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'changes',changes);
 IF receipt_result<>public.catalog_publication_canonical(expected_receipt,0) THEN
  RAISE EXCEPTION 'catalog_publication_receipt_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_receipt_invalid';
 END IF;
 IF EXISTS (SELECT 1 FROM public.catalog_publication_heads WHERE product_id=p_product AND publication_id=p_issue) THEN
  PERFORM public.catalog_publication_assert_head(p_product,true);
  -- Legacy quote readers serve whole grams, as the donor's live check compares them.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(roster) AS member
    JOIN public.catalog_sku_revisions r ON r.id=(member->>'revisionId')::uuid AND r.product_id=p_product
    -- Parse only this roster member's revision; a filter on the revision scan must not read others.
    CROSS JOIN LATERAL (SELECT CASE WHEN r.id=(member->>'revisionId')::uuid THEN r.full_facts::jsonb->'netContent' END AS quantity) net
    WHERE (net.quantity->>'dimension'='mass' AND net.quantity->>'unit'='openlup:g' AND net.quantity->'scale'='0'::jsonb
      AND (net.quantity->>'unscaled')::numeric<=2147483647) IS DISTINCT FROM true) THEN
   RAISE EXCEPTION 'catalog_publication_net_weight_unsupported' USING ERRCODE='23514', CONSTRAINT='catalog_publication_net_weight_unsupported';
  END IF;
  IF NOT public.catalog_publication_live_matches(p_product,product,roster) THEN
   RAISE EXCEPTION 'catalog_publication_live_drift' USING ERRCODE='23514', CONSTRAINT='catalog_publication_live_drift';
  END IF;
 END IF;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR untranslatable_character OR statement_too_complex THEN
 RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_record_command(p_command jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_variable
DECLARE
  product_id uuid := (p_command->>'productId')::uuid;
  actor_id uuid := public.catalog_price_setup_require_human_admin();
  command_kind text := p_command->>'action';
  command_key text := p_command->>'commandKey';
  candidate_ref text := p_command->>'candidateRef';
  candidate_digest text := p_command->>'candidateDigest';
  stamp timestamptz;
  fingerprint text;
  receipt text;
  seal text := p_command->>'postStateText';
  seal_digest text := p_command->>'postStateDigest';
  body jsonb;
  latest timestamptz;
  new_id uuid := gen_random_uuid();
  previous_id uuid := (p_command #>> '{expectedHead,publicationId}')::uuid;
  next_revision integer := coalesce((p_command #>> '{expectedHead,revision}')::integer,0)+1;
  product jsonb := p_command->'product';
  roster jsonb;
  authored jsonb;
  dialect integer;
  changed jsonb;
  manifest text;
  manifest_digest text;
  head jsonb;
BEGIN
  IF command_kind IN ('approve','revoke') THEN
    SELECT max(d.decided_at) INTO latest FROM public.catalog_publication_decisions d
    WHERE (d.product_id,d.candidate_ref,d.candidate_digest)=(product_id,candidate_ref,candidate_digest);
    stamp := greatest(clock_timestamp(),latest + interval '1 microsecond');
    body := jsonb_build_object('schemaVersion',2,'action',command_kind,'productId',product_id,'commandKey',command_key,
      'candidateRef',candidate_ref,'candidateDigest',candidate_digest,'reason',p_command->'reason');
    IF command_kind='approve' THEN
      body := body || jsonb_build_object('postStateDigest',seal_digest);
    END IF;
    fingerprint := encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(body,actor_id),0),'UTF8')),'hex');
    receipt := public.catalog_publication_canonical(body || jsonb_build_object('actorId',actor_id,
      'fingerprint',fingerprint,'decidedAt',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),0);
    INSERT INTO public.catalog_publication_decisions
      (id,product_id,candidate_ref,candidate_digest,candidate_reference_digest,action,actor_id,command_key,
       fingerprint,reason,post_state_canonical_text,post_state_digest,decided_at)
    VALUES (new_id,product_id,candidate_ref,candidate_digest,
      encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(candidate_ref,candidate_digest),0),'UTF8')),'hex'),
      command_kind,actor_id,command_key,fingerprint,p_command->>'reason',seal,seal_digest,stamp);
    INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result)
    VALUES(command_kind,product_id,command_key,fingerprint,actor_id,receipt);
    RETURN receipt;
  END IF;
  IF command_kind IS DISTINCT FROM 'publish' THEN
    RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='22023';
  END IF;

  authored := public.catalog_publication_candidate_source(product_id,candidate_ref,candidate_digest);
  dialect := CASE WHEN authored->'schemaVersion'='4'::jsonb THEN 3 ELSE 2 END;
  IF (previous_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.catalog_publications p
    WHERE (p.product_id,p.id)=(product_id,previous_id) AND p.canonical_state::jsonb->'schemaVersion'=to_jsonb(dialect)
  )) THEN
    IF dialect=3 THEN
      RAISE EXCEPTION 'catalog_lifecycle_evidence_unavailable' USING ERRCODE='23514', CONSTRAINT='catalog_lifecycle_evidence_unavailable';
    END IF;
    RAISE EXCEPTION 'catalog_lifecycle_raw_status_fenced' USING ERRCODE='23514', CONSTRAINT='catalog_lifecycle_raw_status_fenced';
  END IF;
  IF dialect=3 AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(authored #> '{publication,operations}') op
    WHERE op->>'op' IN ('set_product_lifecycle','set_sku_lifecycle') AND op->>'state'='archived'
  ) THEN PERFORM public.catalog_lifecycle_assert_archive(product_id); END IF;

  -- Derive new references from accepted facts. Unchanged SKU revisions keep their original bytes.
  WITH prior AS (
    SELECT reference FROM public.catalog_publications p
    CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') AS ref(reference)
    WHERE (p.product_id,p.id)=(product_id,previous_id)
  ), evaluated AS MATERIALIZED (
    SELECT facts, facts->>'id' AS sku_id, public.catalog_publication_canonical(facts,0) AS canonical
    FROM jsonb_array_elements(p_command->'skus') AS accepted(facts)
  ), digested AS (
    SELECT evaluated.*, encode(sha256(convert_to(canonical,'UTF8')),'hex') AS digest FROM evaluated
  ), delta AS MATERIALIZED (
    SELECT sku_id, facts->>'code' AS code, canonical, digest, gen_random_uuid() AS id,
      coalesce((prior.reference->>'revision')::integer,0)+1 AS revision,
      row_number() OVER (ORDER BY sku_id COLLATE "C") AS ordinal
    FROM digested LEFT JOIN prior ON prior.reference->>'skuId'=sku_id WHERE prior.reference->>'digest' IS DISTINCT FROM digest
  )
  SELECT coalesce(jsonb_agg(coalesce(prior.reference, '{}'::jsonb) || CASE WHEN delta.id IS NULL THEN '{}'::jsonb ELSE
      jsonb_build_object('skuId',d.sku_id,'revisionId',delta.id,'revision',delta.revision,'digest',delta.digest) END
      ORDER BY d.sku_id COLLATE "C"),'[]'::jsonb),
    coalesce(jsonb_agg(to_jsonb(delta)) FILTER (WHERE delta.id IS NOT NULL),'[]'::jsonb)
  INTO roster,changed FROM digested d LEFT JOIN prior ON prior.reference->>'skuId'=d.sku_id
  LEFT JOIN delta ON delta.sku_id=d.sku_id;

  SELECT greatest(clock_timestamp(),d.decided_at) INTO STRICT stamp FROM public.catalog_publication_decisions d
    WHERE d.id=(p_command->>'approvalId')::uuid;
  fingerprint := p_command->>'fingerprint';
  manifest := public.catalog_publication_canonical(jsonb_build_object('schemaVersion',dialect,'product',product,'skus',roster),0);
  manifest_digest := encode(sha256(convert_to(manifest,'UTF8')),'hex');
  INSERT INTO public.catalog_publications
    (id,product_id,revision,issued_count,approval_id,command_fingerprint,previous_id,draft_id,draft_revision,
     command_key,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at)
  VALUES (new_id,product_id,next_revision,jsonb_array_length(changed),(p_command->>'approvalId')::uuid,fingerprint,
    previous_id,(product #>> '{source,draftId}')::uuid,(product #>> '{source,revision}')::integer,
    command_key,candidate_ref,candidate_digest,(product #>> '{document,id}')::uuid,manifest,manifest_digest,actor_id,stamp);
  INSERT INTO public.catalog_sku_revisions(id,sku_id,sku_code,product_id,revision,publication_id,issue_ordinal,full_facts,digest)
  SELECT id,sku_id,code,product_id,revision,new_id,ordinal,canonical,digest
  FROM jsonb_to_recordset(changed) AS item(id uuid,sku_id uuid,code text,revision integer,ordinal integer,canonical text,digest text);

  head := public.catalog_publication_head_ref(product_id,new_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('productId',product_id,'variantId',r.sku_id,'sku',r.sku_code,
    'state',coalesce(r.full_facts::jsonb->>'lifecycleState',CASE WHEN r.full_facts::jsonb->>'status'='archived' THEN 'withdrawn' ELSE r.full_facts::jsonb->>'status' END),
    'variantRevision',r.revision,'publicationHead',head,
    'draftRef',jsonb_build_object('draftId',product #> '{source,draftId}','revision',product #> '{source,revision}'))
    ORDER BY r.issue_ordinal),'[]'::jsonb) INTO changed
  FROM public.catalog_sku_revisions r WHERE r.publication_id=new_id;
  receipt := public.catalog_publication_canonical(jsonb_build_object('schemaVersion',dialect,'productId',product_id,
    'commandKey',command_key,'fingerprint',fingerprint,'actorId',actor_id,'head',head,'previousHead',p_command->'expectedHead',
    'publicationDigest',manifest_digest,'committedAt',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'changes',changed),0);
  INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,publication_id,result)
  VALUES(command_kind,product_id,command_key,fingerprint,actor_id,new_id,receipt);
  INSERT INTO public.catalog_publication_heads AS h(product_id,publication_id,revision)
  VALUES(product_id,new_id,next_revision) ON CONFLICT ON CONSTRAINT catalog_publication_heads_pkey
  DO UPDATE SET publication_id=EXCLUDED.publication_id,revision=EXCLUDED.revision;
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
  VALUES('catalog.publication',product_id,'catalog.publication.committed',new_id::text,
    jsonb_build_object('schemaVersion',1,'productId',product_id,'head',head,'digest',manifest_digest));
  RETURN receipt;
END;
$$;
DO $qualified_security_definer$
BEGIN
  IF EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
    WHERE catalog_path OPERATOR(pg_catalog.=) 'db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql'::pg_catalog.text
      AND sha256 OPERATOR(pg_catalog.=) 'baf0999ba0d8dce9734282c71e4c796514e974f0e42b1fb9089e5c381c742bd8'::pg_catalog.text)
  THEN
    ALTER FUNCTION public.catalog_publication_record_command(jsonb) SECURITY DEFINER;
  END IF;
END
$qualified_security_definer$;

CREATE OR REPLACE FUNCTION public.catalog_publication_read_manifest(p_product uuid,p_text text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE body jsonb := public.catalog_publication_read_json(p_text,p_digest,0);
BEGIN
 IF p_product IS NULL OR jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF body - ARRAY['schemaVersion','product','skus']<>'{}'::jsonb OR body->'schemaVersion' IS DISTINCT FROM coalesce(body #> '{product,schemaVersion}','2'::jsonb)
  OR body->'schemaVersion' NOT IN ('2'::jsonb,'3'::jsonb)
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
 IF body->'schemaVersion'='3'::jsonb THEN
  PERFORM public.catalog_publication_product_facts(p_product,body->'product',false);
 END IF;
 RETURN body;
EXCEPTION WHEN check_violation THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_read_sku_revision(p_product uuid,p_reference jsonb) RETURNS jsonb
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
 IF body->'schemaVersion'='3'::jsonb THEN
  PERFORM public.catalog_publication_sku_projection(retained.sku_id,p_product,retained.sku_code,body,false);
 END IF;
 RETURN body;
EXCEPTION WHEN check_violation THEN RETURN NULL;
END;
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
  OR receipt - 'changes' IS DISTINCT FROM jsonb_build_object('schemaVersion',manifest->'schemaVersion','productId',p_product,'head',head,
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
  'state',coalesce(facts->>'lifecycleState',CASE WHEN facts->>'status'='archived' THEN 'withdrawn' ELSE facts->>'status' END),
  'variantRevision',revision,'publicationHead',head,'draftRef',jsonb_build_object('draftId',issue.draft_id,'revision',issue.draft_revision))
  ORDER BY sku_id),'[]'::jsonb) INTO expected_changes
 FROM issued
 HAVING count(*)=issue.issued_count AND coalesce(bool_and((
  coalesce(facts->'schemaVersion','2'::jsonb)=manifest->'schemaVersion' AND facts->'source'=product->'source' AND facts #> '{source,draftId}'=to_jsonb(issue.draft_id)
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
   AND coalesce(sku->'schemaVersion','2'::jsonb)=manifest->'schemaVersion'
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
   CASE WHEN m.body->'schemaVersion'='3'::jsonb THEN m.body #> '{product,lifecycleState}' END AS product_lifecycle,
   f.memberships,f.status AS sku_status,
   CASE WHEN m.body->'schemaVersion'='3'::jsonb THEN f."lifecycleState" END AS sku_lifecycle,f."sellableStandalone" AS standalone,f."sellableInSubscription" AS subscription
  FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
  CROSS JOIN LATERAL (SELECT p.canonical_state::jsonb AS body) m
  CROSS JOIN LATERAL jsonb_array_elements(m.body->'skus') r
  LEFT JOIN LATERAL jsonb_to_record(public.catalog_publication_read_sku_revision(h.product_id,r))
   AS f(memberships jsonb,status jsonb,"lifecycleState" jsonb,"sellableStandalone" jsonb,"sellableInSubscription" jsonb) ON true
 ), live AS (
  SELECT s.product_id,s.id AS sku_id,s.publication_facts->'memberships' AS memberships,to_jsonb(p.status) AS product_status,
   CASE WHEN p.publication_facts->'schemaVersion'='3'::jsonb THEN p.publication_facts->'lifecycleState' END AS product_lifecycle,
   to_jsonb(s.status) AS sku_status,
   CASE WHEN s.publication_facts->'schemaVersion'='3'::jsonb THEN s.publication_facts->'lifecycleState' END AS sku_lifecycle,to_jsonb(s.sellable_standalone) AS standalone,to_jsonb(s.sellable_in_subscription) AS subscription
  FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
  WHERE s.publication_facts->'memberships' @> admitted OR s.publication_facts->'memberships' @> denied
 )
 SELECT bool_or(s.sku_id IS NOT NULL AND (s.memberships IS NULL OR
   (s.product_status IN ('"draft"'::jsonb,'"active"'::jsonb,'"archived"'::jsonb,'"withdrawn"'::jsonb)) IS DISTINCT FROM true)),
  bool_or(coalesce(s.memberships @> admitted OR s.memberships @> denied,false) IS DISTINCT FROM (l.sku_id IS NOT NULL)
   OR (l.sku_id IS NOT NULL AND (l.memberships,l.product_status,l.sku_status,l.product_lifecycle,l.sku_lifecycle,l.standalone,l.subscription)
    IS DISTINCT FROM (s.memberships,s.product_status,s.sku_status,s.product_lifecycle,s.sku_lifecycle,s.standalone,s.subscription))),
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
   AND (p.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR p.publication_facts->>'lifecycleState'='active')
   AND (s.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR s.publication_facts->>'lifecycleState'='active')
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

CREATE OR REPLACE FUNCTION public.catalog_publication_readiness_snapshot(p_codes text[],p_expected text,p_at timestamptz) RETURNS jsonb
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
  THEN invalid ELSE (SELECT coalesce(e,invalid)
   FROM selected WHERE sku_id IS NOT NULL AND e->>'kind' IS DISTINCT FROM 'evidence'
   ORDER BY position LIMIT 1) END,
  (SELECT jsonb_agg(jsonb_build_object('skuCode',code,'productId',product_id,'skuId',sku_id,'evidence',e-'kind') ORDER BY position) FROM selected)
 INTO failed,subjects;
 IF failed IS NOT NULL THEN RETURN failed; END IF;
 -- Use the same full product and SKU roster comparison as the current-publication reader.
 BEGIN
  IF EXISTS (
   WITH selected_manifests AS MATERIALIZED (
    SELECT h.product_id,p.canonical_state::jsonb AS body
    FROM (SELECT DISTINCT (s->>'productId')::uuid AS id FROM jsonb_array_elements(subjects) s WHERE s->>'skuId' IS NOT NULL) selected_product
    JOIN public.catalog_publication_heads h ON h.product_id=selected_product.id
    JOIN public.catalog_publications p ON (p.product_id,p.id,p.revision)=(h.product_id,h.publication_id,h.revision)
   )
   SELECT 1 FROM selected_manifests m
   WHERE public.catalog_publication_live_matches(m.product_id,m.body->'product',m.body->'skus') IS DISTINCT FROM true
  ) THEN RETURN invalid || '{"detail":"catalog_publication_live_drift"}'::jsonb; END IF;
 EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
  RETURN invalid;
 END;
 -- An all-absent batch reads no settlement or price rows.
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(subjects) s WHERE jsonb_typeof(s->'skuId')='string') THEN
  prices := public.catalog_publication_price_reasons(ARRAY(SELECT (s->>'skuId')::uuid FROM jsonb_array_elements(subjects) s
   WHERE jsonb_typeof(s->'skuId')='string'),p_at);
  IF jsonb_typeof(prices) IS DISTINCT FROM 'array' THEN RETURN prices; END IF;
 END IF;
 SELECT CASE WHEN bool_and(jsonb_typeof(s->'skuId')<>'string' OR price.copies=1) THEN jsonb_agg(jsonb_build_object(
   'skuCode',s->'skuCode','evidence',s->'evidence','priceReasons',coalesce(price.reasons,'[]'::jsonb),'primaryPresent',
   CASE WHEN jsonb_typeof(s->'skuId')='string' THEN EXISTS (SELECT 1 FROM public.catalog_skus k WHERE k.product_id=(s->>'productId')::uuid
    AND k.id::text=s #>> '{evidence,product,primarySkuId}' AND k.status<>'archived'
    AND (s #> '{evidence,product,schemaVersion}' IS DISTINCT FROM '3'::jsonb OR (
      k.publication_facts->>'lifecycleState'='active'
      AND (k.sellable_standalone OR k.sellable_in_subscription)))) END) ORDER BY x.position) END INTO items
 FROM jsonb_array_elements(subjects) WITH ORDINALITY AS x(s,position)
 LEFT JOIN LATERAL (SELECT count(*) AS copies,(array_agg(r->'reasons'))[1] AS reasons
  FROM jsonb_array_elements(prices) r WHERE r->'skuId'=s->'skuId') price ON true;
 IF items IS NULL THEN RETURN invalid; END IF;
 RETURN jsonb_build_object('kind','batch','value',jsonb_build_object('protocol','governed','headDigest',authority->'headDigest','items',items));
END;
$$;

-- A projected lifecycle change must include its exact facts and reconcile to the sealed head at commit.
CREATE FUNCTION public.catalog_lifecycle_write_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NEW.publication_facts->'schemaVersion'='3'::jsonb THEN
  IF (NEW.status,to_jsonb(NEW.sellable_standalone),to_jsonb(NEW.sellable_in_subscription))
     IS NOT DISTINCT FROM (NEW.publication_facts->>'status',NEW.publication_facts->'sellableStandalone',NEW.publication_facts->'sellableInSubscription')
  THEN RETURN NEW; END IF;
 ELSIF (TG_OP='INSERT' OR OLD.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb)
   AND NOT EXISTS (SELECT 1 FROM public.catalog_products p WHERE p.id=NEW.product_id AND p.publication_facts->'schemaVersion'='3'::jsonb)
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'catalog_lifecycle_raw_status_fenced' USING ERRCODE='23514', CONSTRAINT='catalog_lifecycle_raw_status_fenced',
  HINT='Use a governed catalogue publication.';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_write_fence() FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_projection_final() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE owner_id uuid; issue public.catalog_publications; state jsonb;
BEGIN
 IF NEW.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
   AND (TG_OP='INSERT' OR OLD.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb) THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND (OLD.status,OLD.publication_facts) IS NOT DISTINCT FROM (NEW.status,NEW.publication_facts) THEN RETURN NULL; END IF;
 owner_id := NEW.id;
 PERFORM public.catalog_publication_assert_head(owner_id,true);
 SELECT p.* INTO issue FROM public.catalog_publication_heads h
 JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
 WHERE h.product_id=owner_id;
 IF FOUND THEN
  state := public.catalog_publication_manifest_text(owner_id,issue.canonical_state,issue.digest,false)::jsonb;
 END IF;
 IF state->'schemaVersion' IS DISTINCT FROM '3'::jsonb
   OR public.catalog_publication_live_matches(owner_id,state->'product',state->'skus') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'catalog_lifecycle_raw_status_fenced' USING ERRCODE='23514', CONSTRAINT='catalog_lifecycle_raw_status_fenced',
    HINT='Use a governed catalogue publication and let its recorder issue the sealed head.';
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_projection_final() FROM PUBLIC;

CREATE TRIGGER catalog_skus_lifecycle_write_fence BEFORE INSERT OR UPDATE OF status,sellable_standalone,sellable_in_subscription,publication_facts ON public.catalog_skus FOR EACH ROW EXECUTE FUNCTION public.catalog_lifecycle_write_fence();
CREATE CONSTRAINT TRIGGER catalog_products_lifecycle_projection_final AFTER INSERT OR UPDATE ON public.catalog_products DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_lifecycle_projection_final();
