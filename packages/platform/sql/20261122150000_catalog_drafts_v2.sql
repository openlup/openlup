-- Versioned, isolated drafts: v1 replay and refusals retain their original bytes and order.
-- V2 stores complete immediate base-price commands and attribute data; it writes no live catalogue.
-- Resume appends an open revision copying the abandoned payload and retaining every reservation.
-- Existing owner/runtime invoker privileges and RLS remain unchanged. No publication authority is minted.
-- migration:allow-dml: only existing draft-owned heads, revisions, receipts and reservations are written.
CREATE OR REPLACE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; operation jsonb; expectation jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text;
BEGIN
  actor := p_actor_id; IF actor IS NULL OR actor <> btrim(actor) OR length(actor) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'catalog_draft_actor_required' USING ERRCODE='42501'; END IF;
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 1048576
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_fingerprint_invalid');
  END IF;
  c := p_canonical_command::jsonb;
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'schemaVersion' NOT IN ('1'::jsonb, '2'::jsonb) OR NOT (c ? 'schemaVersion')
    OR c->>'action' IS NULL OR (c->>'action' NOT IN ('create','revise','abandon') AND NOT (c->'schemaVersion' = '2'::jsonb AND c->>'action' = 'resume'))
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
  SELECT * INTO h FROM public.catalog_draft_heads WHERE draft_id = d FOR UPDATE;
  IF (action = 'create' AND (FOUND OR expected <> 0)) OR (action <> 'create' AND (NOT FOUND OR expected <> h.revision)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','revision_conflict','currentRevision',coalesce(h.revision,0));
  END IF;
  IF h.status = 'abandoned' AND action <> 'resume' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_abandoned','currentRevision',h.revision); END IF;
  IF action = 'resume' AND h.status <> 'abandoned' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_not_abandoned','currentRevision',h.revision); END IF;
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
    IF c->'schemaVersion' = '2'::jsonb THEN
      IF EXISTS (SELECT FROM jsonb_object_keys(p) k WHERE k NOT IN ('schemaVersion','product','skus'))
        OR EXISTS (SELECT FROM jsonb_object_keys(p->'product') k WHERE k NOT IN ('id','type','slug','primarySkuId','dimensions','sharedContent','documentRevision','attributes'))
        OR (p->'product' ? 'attributes' AND jsonb_typeof(p->'product'->'attributes') IS DISTINCT FROM 'object') THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
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
      IF c->'schemaVersion' = '2'::jsonb THEN
        IF EXISTS (SELECT FROM jsonb_object_keys(s) k WHERE k NOT IN ('id','productId','code','options','netContent','identifiers','assetRefs','grossMass','logisticsRef','attributes','priceOperations'))
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
