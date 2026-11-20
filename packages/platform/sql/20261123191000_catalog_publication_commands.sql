-- Operational publication history and transactional base-price application.
CREATE FUNCTION public.catalog_publication_record_command(p_command jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
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
  manifest := public.catalog_publication_canonical(jsonb_build_object('schemaVersion',2,'product',product,'skus',roster),0);
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
    'state',CASE WHEN r.full_facts::jsonb->>'status'='archived' THEN 'withdrawn' ELSE r.full_facts::jsonb->>'status' END,
    'variantRevision',r.revision,'publicationHead',head,
    'draftRef',jsonb_build_object('draftId',product #> '{source,draftId}','revision',product #> '{source,revision}'))
    ORDER BY r.issue_ordinal),'[]'::jsonb) INTO changed
  FROM public.catalog_sku_revisions r WHERE r.publication_id=new_id;
  receipt := public.catalog_publication_canonical(jsonb_build_object('schemaVersion',2,'productId',product_id,
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
REVOKE ALL ON FUNCTION public.catalog_publication_record_command(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_price_setup_claim(p_canonical_command text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid;
  v_command jsonb;
  v_expected jsonb;
  v_key text;
  v_variant_id uuid;
  v_list_id uuid;
  v_inserted integer;
  v_existing public.catalog_price_setup_receipts%ROWTYPE;
BEGIN
  -- 1. The actor: an active human administrator's session.
  v_actor := public.catalog_price_setup_require_human_admin();

  -- 2. The fingerprint binds the exact command bytes.
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 4096
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_fingerprint_invalid');
  END IF;

  -- 3. The strict command: exactly these keys, one-time gross at minimum quantity
  -- one, a positive integer amount, and an expected state that is either wholly
  -- null (no base yet) or wholly set.
  BEGIN
    v_command := p_canonical_command::jsonb;
  EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END;
  IF jsonb_typeof(v_command) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_command->'expected') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  v_expected := v_command->'expected';
  IF EXISTS (SELECT FROM jsonb_object_keys(v_command) command_key WHERE command_key NOT IN (
      'schemaVersion', 'commandKey', 'variantId', 'priceListId', 'mode', 'minQty',
      'amountKind', 'unitPriceMinor', 'expected'))
    OR EXISTS (SELECT FROM jsonb_object_keys(v_expected) expected_key
      WHERE expected_key NOT IN ('entryId', 'unitPriceMinor'))
    OR v_command->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(v_command->'commandKey') IS DISTINCT FROM 'string'
    OR length(v_command->>'commandKey') NOT BETWEEN 1 AND 240
    OR btrim(v_command->>'commandKey') <> v_command->>'commandKey'
    OR jsonb_typeof(v_command->'variantId') IS DISTINCT FROM 'string'
    OR v_command->>'variantId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(v_command->'priceListId') IS DISTINCT FROM 'string'
    OR v_command->>'priceListId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_command->'mode' IS DISTINCT FROM '"one_time"'::jsonb
    OR v_command->'minQty' IS DISTINCT FROM '1'::jsonb
    OR v_command->'amountKind' IS DISTINCT FROM '"gross"'::jsonb
    OR jsonb_typeof(v_command->'unitPriceMinor') IS DISTINCT FROM 'number'
    OR v_command->>'unitPriceMinor' !~ '^[1-9][0-9]{0,9}$'
    OR NOT (v_expected ? 'entryId' AND v_expected ? 'unitPriceMinor')
    OR NOT (
      (jsonb_typeof(v_expected->'entryId') = 'null'
        AND jsonb_typeof(v_expected->'unitPriceMinor') = 'null')
      OR (jsonb_typeof(v_expected->'entryId') = 'string'
        AND v_expected->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(v_expected->'unitPriceMinor') = 'number'
        AND v_expected->>'unitPriceMinor' ~ '^(0|[1-9][0-9]{0,9})$')) THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  -- Both amounts matched a digit pattern above, so these casts cannot fail.
  IF (v_command->>'unitPriceMinor')::bigint > 2147483647
    OR (v_expected->>'unitPriceMinor')::bigint > 2147483647 THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  v_key := v_command->>'commandKey';
  v_variant_id := (v_command->>'variantId')::uuid;
  v_list_id := (v_command->>'priceListId')::uuid;

  -- 4. The receipt, before the target is read, so that a completed command replays
  -- whatever has changed since. A refusal returned below removes this call's
  -- in-progress receipt; an exception rolls it back.
  INSERT INTO public.catalog_price_setup_receipts
    (scope, idempotency_key, request_fingerprint, status, metadata)
  VALUES ('catalog.price_setup.base', v_key, p_fingerprint, 'in_progress',
    jsonb_build_object('actorId', v_actor, 'variantId', v_variant_id, 'priceListId', v_list_id))
  ON CONFLICT (scope, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT * INTO v_existing FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key FOR UPDATE;
    IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'command_key_reused');
    ELSIF v_existing.status = 'completed' AND v_existing.response_payload IS NOT NULL THEN
      IF v_existing.metadata->>'actorId' IS DISTINCT FROM v_actor::text THEN
        RETURN jsonb_build_object('outcome', 'unauthorized', 'reason', 'operator_mismatch');
      END IF;
      RETURN v_existing.response_payload || jsonb_build_object('outcome', 'replayed');
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'command_in_progress');
  END IF;

  RETURN jsonb_build_object('outcome', 'claimed', 'canonicalCommand', p_canonical_command, 'fingerprint', p_fingerprint);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_claim(text,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_price_setup_lock_context(p_list uuid, p_sku uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-price-setup:' || p_list::text || ':' || p_sku::text, 0));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_lock_context(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_price_setup_apply_claimed(p_claim jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := p_at;
  v_actor uuid;
  v_command jsonb;
  v_saved public.catalog_price_setup_receipts%ROWTYPE;
  v_key text;
  v_variant_id uuid;
  v_list_id uuid;
  v_unit_price_minor integer;
  v_expected_entry_id uuid;
  v_expected_unit_price_minor integer;
  v_sku public.catalog_skus%ROWTYPE;
  v_list public.price_lists%ROWTYPE;
  v_refusal text;
  v_current public.price_entries%ROWTYPE;
  v_current_count integer;
  v_pending_count integer;
  v_entry_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_added jsonb;
  v_response jsonb;
BEGIN
  v_actor := auth.uid();
  v_command := (p_claim->>'canonicalCommand')::jsonb;
  v_key := v_command->>'commandKey';
  v_variant_id := (v_command->>'variantId')::uuid;
  v_list_id := (v_command->>'priceListId')::uuid;
  v_unit_price_minor := (v_command->>'unitPriceMinor')::integer;
  v_expected_entry_id := (v_command #>> '{expected,entryId}')::uuid;
  v_expected_unit_price_minor := (v_command #>> '{expected,unitPriceMinor}')::integer;
  SELECT * INTO v_saved FROM public.catalog_price_setup_receipts
  WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
  IF NOT FOUND OR v_actor IS NULL OR v_saved.status <> 'in_progress'
    OR v_saved.metadata IS DISTINCT FROM jsonb_build_object('actorId', v_actor, 'variantId', v_variant_id, 'priceListId', v_list_id)
    OR v_saved.request_fingerprint IS DISTINCT FROM p_claim->>'fingerprint'
    OR v_saved.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(p_claim->>'canonicalCommand', 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'catalog_price_setup_claim_mismatch' USING ERRCODE = '55000';
  END IF;

  -- 5. The target: a SKU that is not archived, and the active list of the
  -- settlement region and currency.
  SELECT * INTO v_sku FROM public.catalog_skus WHERE id = v_variant_id;
  SELECT * INTO v_list FROM public.price_lists WHERE id = v_list_id;
  v_refusal := CASE
    WHEN v_sku.id IS NULL THEN 'sku_not_found'
    WHEN v_sku.status = 'archived' THEN 'sku_archived'
    WHEN v_list.id IS NULL THEN 'price_list_not_found'
    WHEN v_list.status <> 'active' OR v_list.region_code <> public.catalog_price_setup_region_code()
      OR v_list.currency <> public.catalog_price_setup_settlement_currency()
      OR v_list.valid_from > v_now OR (v_list.valid_to IS NOT NULL AND v_list.valid_to <= v_now)
      THEN 'price_list_not_active'
  END;

  IF v_refusal IS NULL THEN
    -- 6. One command at a time for this list and SKU, and a row lock against
    -- other writers of its open base rows.
    PERFORM public.catalog_price_setup_lock_context(v_list_id, v_variant_id);
    PERFORM 1 FROM public.price_entries entry
    WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
      AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
      AND (entry.valid_to IS NULL OR entry.valid_to > v_now)
    FOR NO KEY UPDATE;

    -- 7. The state: at most one effective base, and none starting now or later.
    SELECT count(*) FILTER (WHERE entry.valid_from <= v_now),
      count(*) FILTER (WHERE entry.valid_from >= v_now)
    INTO v_current_count, v_pending_count
    FROM public.price_entries entry
    WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
      AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
      AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
    IF v_current_count > 1 THEN
      v_refusal := 'base_price_ambiguous';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    DELETE FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', v_refusal);
  END IF;

  SELECT * INTO v_current FROM public.price_entries entry
  WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
    AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
    AND entry.valid_from <= v_now AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
  IF v_pending_count > 0
    OR v_current.id IS DISTINCT FROM v_expected_entry_id
    OR v_current.unit_price_minor IS DISTINCT FROM v_expected_unit_price_minor THEN
    RAISE EXCEPTION 'catalog_price_setup_expected_state_mismatch' USING ERRCODE = '40001';
  END IF;

  -- 8. The readiness verdict before the write.
  v_before := public.commerce_offer_policy_v2_readiness();

  -- 9. Close the current base and insert its replacement at the same instant.
  IF v_current.id IS NOT NULL THEN
    UPDATE public.price_entries SET active = false, valid_to = v_now, updated_at = v_now
    WHERE id = v_current.id;
  END IF;
  INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty,
    unit_price_minor, amount_kind, active, valid_from)
  VALUES (v_list_id, v_variant_id, 'one_time', 1, v_unit_price_minor, 'gross', true, v_now)
  RETURNING id INTO v_entry_id;

  -- 10. Refuse a change after which the gate reports a reason it did not report
  -- before. An unrelated reason that was already there neither blocks the change
  -- nor hides one the change adds.
  v_after := public.commerce_offer_policy_v2_readiness();
  SELECT COALESCE(jsonb_agg(reason.code ORDER BY reason.n), '[]'::jsonb) INTO v_added
  FROM jsonb_array_elements_text(v_after->'reasons') WITH ORDINALITY AS reason(code, n)
  WHERE NOT ((v_before->'reasons') ? reason.code);
  IF jsonb_array_length(v_added) > 0 THEN
    RAISE EXCEPTION 'catalog_price_setup_readiness_would_fail'
      USING ERRCODE = '55000', DETAIL = v_added::text;
  END IF;

  -- 11. Complete the receipt with the response a replay returns.
  v_response := jsonb_build_object('outcome', 'committed', 'receipt', jsonb_build_object(
    'commandKey', v_key, 'variantId', v_variant_id, 'priceListId', v_list_id,
    'actorId', v_actor,
    'previous', CASE WHEN v_current.id IS NULL THEN NULL ELSE jsonb_build_object(
      'entryId', v_current.id, 'unitPriceMinor', v_current.unit_price_minor,
      'validFrom', v_current.valid_from) END,
    'current', jsonb_build_object('entryId', v_entry_id,
      'unitPriceMinor', v_unit_price_minor, 'validFrom', v_now)));
  UPDATE public.catalog_price_setup_receipts
  SET status = 'completed', response_payload = v_response
  WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_apply_claimed(jsonb,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_price_setup_apply(p_canonical_command text, p_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_claim jsonb;
BEGIN
  v_claim := public.catalog_price_setup_claim(p_canonical_command, p_fingerprint);
  IF v_claim->>'outcome' <> 'claimed' THEN RETURN v_claim; END IF;
  RETURN public.catalog_price_setup_apply_claimed(v_claim, v_now);
END;
$$;

-- Existing issuers keep their scoped key. Operational publication also reserves
-- the canonical GTIN across all issuers and a combination across all statuses.
ALTER TABLE public.catalog_sku_identifiers ADD COLUMN scheme text;
CREATE UNIQUE INDEX catalog_publication_gtin_key ON public.catalog_sku_identifiers(normalized_value)
  WHERE identifier_kind = 'gtin' AND scheme = 'gs1:gtin';
CREATE UNIQUE INDEX catalog_publication_sku_combination_key ON public.catalog_skus(product_id,combination_digest)
  WHERE publication_facts IS NOT NULL AND combination_digest IS NOT NULL;
