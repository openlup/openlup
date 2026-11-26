-- Basis-aware price effects stay private until the paired publication grants.

CREATE FUNCTION public.catalog_price_setup_mutate_claimed(p_claim jsonb, p_at timestamptz, p_required_modes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := p_at;
  v_actor uuid;
  v_is_v2 boolean;
  v_basis text;
  v_kind text;
  v_verdict jsonb;
  v_target jsonb;
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
  v_is_v2 := v_command->'schemaVersion' = '2'::jsonb;
  v_kind := v_command->>'amountKind';
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

  IF v_is_v2 AND p_at IS NULL THEN
    PERFORM public.catalog_price_setup_lock_context(v_list_id, v_variant_id);
    LOCK TABLE public.commerce_settings, public.price_lists, public.subscription_price_policy_revisions IN SHARE MODE NOWAIT;
    LOCK TABLE public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    PERFORM 1 FROM public.price_entries
      WHERE price_list_id=v_list_id AND variant_id=v_variant_id ORDER BY id FOR NO KEY UPDATE NOWAIT;
    v_now := clock_timestamp();
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

  IF v_refusal IS NULL AND v_is_v2 THEN
    v_target := jsonb_build_object('skuId',v_variant_id,'requiredModes',
      coalesce(p_required_modes, CASE WHEN v_sku.sellable_in_subscription
        THEN '["one_time","subscription"]'::jsonb ELSE '["one_time"]'::jsonb END));
    v_verdict := public.catalog_publication_target_price_verdict(
      jsonb_build_array(v_target || jsonb_build_object('operation',v_command)), v_now);
    v_refusal := coalesce(v_verdict->>'reason', v_verdict #>> '{targets,0,reason}');
    v_basis := v_verdict->>'amountBasis';
  ELSIF v_refusal IS NULL THEN
    -- 6. One command at a time for this list and SKU, and a row lock against
    -- other writers of its open base rows.
    PERFORM public.catalog_price_setup_lock_context(v_list_id, v_variant_id);
    SELECT amount_basis INTO v_basis FROM public.price_lists WHERE id=v_list_id FOR SHARE;
    IF v_basis = 'tax_exclusive' THEN
      v_refusal := 'catalog_price_setup_basis_mismatch';
    ELSE
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
  END IF;

  IF v_refusal IS NOT NULL THEN
    DELETE FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
    RETURN jsonb_build_object('outcome', CASE WHEN v_refusal='expected_state_mismatch' THEN 'conflict'
      ELSE 'validation_issue' END, 'reason', v_refusal);
  END IF;

  SELECT * INTO v_current FROM public.price_entries entry
  WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
    AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
    AND entry.valid_from <= v_now AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
  IF NOT v_is_v2 AND (v_pending_count > 0
    OR v_current.id IS DISTINCT FROM v_expected_entry_id
    OR v_current.unit_price_minor IS DISTINCT FROM v_expected_unit_price_minor) THEN
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
  VALUES (v_list_id, v_variant_id, 'one_time', 1, v_unit_price_minor, v_kind, true, v_now)
  RETURNING id INTO v_entry_id;

  IF v_is_v2 THEN
    v_verdict := public.catalog_publication_target_price_verdict(jsonb_build_array(v_target),v_now);
    v_refusal := coalesce(v_verdict->>'reason',v_verdict #>> '{targets,0,reason}');
    IF v_refusal IS NOT NULL OR v_verdict #> '{targets,0,previous}' IS DISTINCT FROM
      jsonb_build_object('entryId',v_entry_id,'unitPriceMinor',v_unit_price_minor,'amountKind',v_kind) THEN
      RAISE EXCEPTION 'catalog_price_setup_readiness_would_fail' USING ERRCODE='55000',
        DETAIL=jsonb_build_array(coalesce(v_refusal,'catalog_publication_sku_price_not_ready'))::text;
    END IF;
  END IF;

  -- 10. Refuse a change after which the gate reports a reason it did not report
  -- before. An unrelated reason that was already there neither blocks the change
  -- nor hides one the change adds.
  v_after := public.commerce_offer_policy_v2_readiness();
  SELECT COALESCE(jsonb_agg(reason.code ORDER BY reason.n), '[]'::jsonb) INTO v_added
  FROM jsonb_array_elements_text(v_after->'reasons') WITH ORDINALITY AS reason(code, n)
  WHERE NOT ((v_before->'reasons') ? reason.code)
    -- The per-target verdict owns the edited base. The historical aggregate
    -- sees the closed row as inactive before the replacement's start.
    AND NOT (v_is_v2 AND reason.code='catalog_1490_legacy_1340_invalid');
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
      'validFrom', v_current.valid_from) || CASE WHEN v_is_v2 THEN jsonb_build_object('amountKind',v_current.amount_kind)
        ELSE '{}'::jsonb END END,
    'current', jsonb_build_object('entryId', v_entry_id,
      'unitPriceMinor', v_unit_price_minor, 'validFrom', v_now)
      || CASE WHEN v_is_v2 THEN jsonb_build_object('amountKind',v_kind) ELSE '{}'::jsonb END)
    || CASE WHEN v_is_v2 THEN jsonb_build_object('amountBasis',v_basis) ELSE '{}'::jsonb END);
  UPDATE public.catalog_price_setup_receipts
  SET status = 'completed', response_payload = v_response
  WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_price_setup_apply_claimed(p_claim jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The immediate v2 path must sample its clock after its own locks.
  RETURN public.catalog_price_setup_mutate_claimed(p_claim,
    CASE WHEN (p_claim->>'canonicalCommand')::jsonb->'schemaVersion' = '2'::jsonb THEN NULL ELSE p_at END, NULL);
END;
$$;

CREATE FUNCTION public.catalog_publication_price_operations_v2(p_authored jsonb, p_product uuid, p_assess boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE operations jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',s->'id','productId',s->'productId','operation',op)), '[]')
  INTO operations FROM jsonb_array_elements(p_authored->'skus') s
  CROSS JOIN LATERAL jsonb_array_elements(s->'priceOperations') op;
  IF NOT p_assess AND p_authored #> '{publication,evidence,priceContext}' IS NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(operations) item WHERE item #> '{operation,schemaVersion}'='2'::jsonb) THEN
    RETURN operations;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'catalog_publication_isolation_unsupported' USING ERRCODE='22023',
      DETAIL='isolation', HINT='Roll back and restart in READ COMMITTED.';
  END IF;
  IF p_authored->'schemaVersion' IS DISTINCT FROM '4'::jsonb THEN
    RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(operations) item
    WHERE item->'productId' IS DISTINCT FROM to_jsonb(p_product)
      OR item->'skuId' IS DISTINCT FROM item #> '{operation,variantId}'
      OR (item #> '{operation,schemaVersion}' IS DISTINCT FROM '1'::jsonb
        AND public.catalog_price_setup_v2_command_valid(item->'operation') IS DISTINCT FROM true)) THEN
    RAISE EXCEPTION 'price_operation_invalid' USING ERRCODE='23514', CONSTRAINT='price_operation_invalid';
  END IF;
  IF p_assess THEN RETURN operations; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(operations) item
    GROUP BY item->'skuId',item #> '{operation,priceListId}' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'catalog_publication_price_target_duplicate' USING ERRCODE='23514',
      CONSTRAINT='catalog_publication_price_target_duplicate', HINT='Split or consolidate the edits.';
  END IF;
  IF (SELECT count(DISTINCT jsonb_build_array(item #> '{operation,priceListId}',item #> '{operation,expectedListAmountBasis}'))
    FROM jsonb_array_elements(operations) item)>1
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(operations) item WHERE item #> '{operation,schemaVersion}'='1'::jsonb) THEN
    RAISE EXCEPTION 'catalog_publication_mixed_price_lock_unsupported'
      USING ERRCODE='23514', CONSTRAINT='catalog_publication_mixed_price_lock_unsupported';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(operations) item
    GROUP BY convert_to(item #>> '{operation,commandKey}','UTF8') HAVING count(*)>1) THEN
    RAISE EXCEPTION 'catalog_publication_price_key_reused' USING ERRCODE='23514', CONSTRAINT='catalog_publication_price_key_reused';
  END IF;
  RETURN operations;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_price_operations_v2(jsonb,uuid,boolean) FROM PUBLIC;

-- Keep the changed SKU facts available for verification before issuance creates their revisions.
ALTER TABLE public.catalog_publication_decisions ADD COLUMN post_state_sku_facts jsonb;

CREATE FUNCTION public.catalog_publication_first_offer_input_v2(p_product uuid, p_previous uuid,
  p_approval public.catalog_publication_decisions, p_skus jsonb, p_sku uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  approved jsonb;
  previous jsonb;
  issued jsonb;
  first_offers jsonb;
  valid boolean;
BEGIN
  IF p_approval.action IS DISTINCT FROM 'approve' THEN RETURN '[]'::jsonb; END IF;
  approved := public.catalog_publication_manifest_text(p_product,
    p_approval.post_state_canonical_text,p_approval.post_state_digest,true)::jsonb;
  SELECT public.catalog_publication_read_manifest(p_product,p.canonical_state,p.digest) INTO previous
  FROM public.catalog_publications p WHERE (p.product_id,p.id)=(p_product,p_previous);
  SELECT public.catalog_publication_read_manifest(p_product,p.canonical_state,p.digest) INTO issued
  FROM public.catalog_publications p WHERE p.product_id=p_product AND p.approval_id=p_approval.id;

  WITH supplied AS (
    SELECT facts->'id' AS id,facts
    FROM jsonb_array_elements(coalesce(p_skus,
      CASE WHEN issued IS NULL THEN p_approval.post_state_sku_facts END,'[]'::jsonb)) facts
  ), prior AS (
    SELECT ref->'skuId' AS id,ref,public.catalog_publication_read_sku_revision(p_product,ref) AS facts
    FROM jsonb_array_elements(previous->'skus') ref
    WHERE p_sku IS NULL OR ref->'skuId'=to_jsonb(p_sku)
  ), sealed AS (
    SELECT approved_ref.ref,prior.ref AS prior_ref,prior.facts AS prior_facts,
      coalesce(supplied.facts,public.catalog_publication_read_sku_revision(p_product,retained.ref),
        CASE WHEN prior.ref->'digest'=approved_ref.ref->'digest' THEN prior.facts END) AS facts
    FROM jsonb_array_elements(approved->'skus') approved_ref(ref)
    LEFT JOIN supplied ON supplied.id=approved_ref.ref->'skuId'
    LEFT JOIN prior ON prior.id=approved_ref.ref->'skuId'
    LEFT JOIN jsonb_array_elements(issued->'skus') retained(ref) ON retained.ref->'skuId'=approved_ref.ref->'skuId'
    WHERE p_sku IS NULL OR approved_ref.ref->'skuId'=to_jsonb(p_sku)
  ), verified AS (
    SELECT ref->'skuId' AS id,prior_facts,facts,
      (prior_ref IS NULL OR prior_facts IS NOT NULL)
        AND facts->'productId'=to_jsonb(p_product)
        AND facts->>'id'=ref->>'skuId'
        AND jsonb_typeof(facts->'memberships')='array'
        AND encode(sha256(convert_to(public.catalog_publication_canonical(facts,0),'UTF8')),'hex')=ref->>'digest' AS matches
    FROM sealed
  )
  SELECT coalesce(jsonb_agg(id) FILTER (
      WHERE NOT coalesce(prior_facts->'memberships' @> '[{"admitted":true}]',false)
        AND facts->'memberships' @> '[{"admitted":true}]'), '[]'::jsonb),
    count(*)>0 AND bool_and(matches IS TRUE)
  INTO first_offers,valid FROM verified;
  IF (p_previous IS NOT NULL AND previous IS NULL) OR valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'catalog_publication_post_state_changed' USING ERRCODE='23514', CONSTRAINT='catalog_publication_post_state_changed';
  END IF;
  RETURN first_offers;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_first_offer_input_v2(uuid,uuid,public.catalog_publication_decisions,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_price_modes_v2(p_authored jsonb, p_previous uuid, p_skus jsonb,
  p_first_offers jsonb) RETURNS TABLE(sku jsonb, modes jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  WITH prior AS (
    SELECT ref->'skuId' AS id, r.full_facts::jsonb AS facts,
      p.canonical_state::jsonb #>> '{product,lifecycleState}'='active'
        AND r.full_facts::jsonb->>'lifecycleState'='active' AS active
    FROM public.catalog_publications p
    CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
    JOIN public.catalog_sku_revisions r ON (r.id,r.product_id,r.digest) =
      ((ref->>'revisionId')::uuid, p.product_id, ref->>'digest')
    WHERE p.id=p_previous
  ), operations AS (
    SELECT op,n FROM jsonb_array_elements(p_authored #> '{publication,operations}') WITH ORDINALITY AS item(op,n)
  ), product_withdrawal AS (
    SELECT max(n) AS n FROM operations WHERE op->>'op'='set_product_lifecycle' AND op->>'state'='withdrawn'
  ), eligibility AS (
    -- Withdrawal clears even deferred eligibility. Restore alone never enables it.
    SELECT DISTINCT ON (op->'skuCode') op->'skuCode' AS code,n,
      op->>'op'='set_eligibility' AND op->'sellableStandalone'='true'::jsonb AS standalone,
      op->>'op'='set_eligibility' AND op->'sellableInSubscription'='true'::jsonb AS subscription
    FROM operations WHERE op->>'op'='set_eligibility' OR (op->>'op'='set_sku_lifecycle' AND op->>'state'='withdrawn')
    ORDER BY op->'skuCode',n DESC
  )
  SELECT s,jsonb_build_object(
    'requiredModes',CASE WHEN effective.subscription THEN '["one_time","subscription"]'::jsonb ELSE '["one_time"]'::jsonb END,
    'sellableStandalone',effective.standalone,
    'firstAdmission',admission.first_offer,
    'needsFresh', (effective.standalone AND NOT coalesce(prior.active AND prior.facts->'sellableStandalone'='true'::jsonb,false))
      OR (effective.subscription AND NOT coalesce(prior.active AND prior.facts->'sellableInSubscription'='true'::jsonb,false))
      OR admission.first_offer)
  FROM jsonb_array_elements(p_skus) s LEFT JOIN prior ON prior.id=s->'id'
  LEFT JOIN eligibility ON eligibility.code=s->'code'
  CROSS JOIN product_withdrawal
  CROSS JOIN LATERAL (SELECT p_first_offers @> jsonb_build_array(s->'id') AS first_offer) admission
  CROSS JOIN LATERAL (SELECT
    CASE WHEN product_withdrawal.n>coalesce(eligibility.n,0) THEN false
      ELSE coalesce(eligibility.standalone,prior.facts->'sellableStandalone'='true'::jsonb,false) END AS standalone,
    CASE WHEN product_withdrawal.n>coalesce(eligibility.n,0) THEN false
      ELSE coalesce(eligibility.subscription,prior.facts->'sellableInSubscription'='true'::jsonb,false) END AS subscription) effective
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_price_modes_v2(jsonb,uuid,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_completed_price_receipt_v2(p_operation jsonb, p_actor uuid)
RETURNS public.catalog_price_setup_receipts
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE saved public.catalog_price_setup_receipts%ROWTYPE;
BEGIN
  SELECT * INTO saved FROM public.catalog_price_setup_receipts r
    WHERE r.scope='catalog.price_setup.base' AND r.idempotency_key=p_operation->>'commandKey' FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog_publication_price_issue_required' USING ERRCODE='23514', CONSTRAINT='catalog_publication_price_issue_required';
  ELSIF saved.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(public.catalog_publication_canonical(p_operation,0),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'command_key_reused' USING ERRCODE='40001', CONSTRAINT='command_key_reused';
  ELSIF saved.status<>'completed' OR saved.response_payload IS NULL THEN
    RAISE EXCEPTION 'command_in_progress' USING ERRCODE='40001', CONSTRAINT='command_in_progress';
  ELSIF saved.metadata->>'actorId' IS DISTINCT FROM p_actor::text THEN
    RAISE EXCEPTION 'operator_mismatch' USING ERRCODE='42501', CONSTRAINT='operator_mismatch';
  END IF;
  RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_completed_price_receipt_v2(jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_lock_tax_class_v2(p_authored jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE class_key text; class_status text;
BEGIN
  IF p_authored #>> '{publication,evidence,priceContext,amountBasis}'='tax_exclusive' THEN
    SELECT t.definition->>'taxClass' INTO class_key FROM public.catalog_type_versions t
      WHERE t.type_key=p_authored #>> '{product,type,key}' AND to_jsonb(t.version)=p_authored #> '{product,type,version}';
    SELECT c.status INTO class_status FROM public.catalog_tax_classes c WHERE c.key=class_key FOR SHARE NOWAIT;
    IF class_status='active' THEN RETURN class_key; END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_lock_tax_class_v2(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_assert_price_receipt_v2(p_authored jsonb, p_targets jsonb, p_verdict jsonb,
  p_actor uuid, p_fresh_keys text[], p_tax_class text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  context jsonb := p_authored #> '{publication,evidence,priceContext}';
  target jsonb;
  actual jsonb;
  operation jsonb;
  saved public.catalog_price_setup_receipts%ROWTYPE;
  receipt jsonb;
  prior_entry public.price_entries%ROWTYPE;
  current_entry public.price_entries%ROWTYPE;
  proof jsonb;
  expected_start timestamptz;
  key text;
  reason text := p_verdict->>'reason';
  timestamp_shape CONSTANT text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2}(:[0-9]{2})?)$';
BEGIN
  IF reason IS NULL AND ((CASE WHEN jsonb_typeof(context)='object' THEN context-'tax' END) IS DISTINCT FROM p_verdict-'targets'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_targets) t
      WHERE t #> '{operation,priceListId}' IS DISTINCT FROM context->'priceListId'
        OR t #> '{operation,expectedListAmountBasis}' IS DISTINCT FROM context->'amountBasis')) THEN
    reason := 'catalog_publication_price_context_mismatch';
  END IF;
  IF reason IS NULL AND context->>'amountBasis'='tax_exclusive' THEN
    reason := CASE WHEN p_tax_class IS NULL THEN 'catalog_publication_tax_class_unavailable'
      WHEN jsonb_typeof(context->'tax') IS DISTINCT FROM 'object'
        OR (CASE WHEN jsonb_typeof(context->'tax')='object' THEN (context->'tax') - ARRAY['market','taxClassKey','classMapRevision','classMapDigest'] END) IS DISTINCT FROM '{}'::jsonb
        OR context #> '{tax,taxClassKey}' IS DISTINCT FROM to_jsonb(p_tax_class)
        OR jsonb_typeof(context #> '{tax,market}') IS DISTINCT FROM 'string'
        OR jsonb_typeof(context #> '{tax,classMapRevision}') IS DISTINCT FROM 'string'
        OR jsonb_typeof(context #> '{tax,classMapDigest}') IS DISTINCT FROM 'string'
        OR coalesce(context #>> '{tax,market}','')=''
        OR coalesce(context #>> '{tax,classMapRevision}','')=''
        OR coalesce(context #>> '{tax,classMapDigest}','') !~ '^[0-9a-f]{64}$'
        THEN 'catalog_publication_price_class_map_mismatch' END;
  ELSIF reason IS NULL AND context->'tax' IS DISTINCT FROM 'null'::jsonb THEN
    reason := 'catalog_publication_price_context_mismatch';
  END IF;
  IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason USING ERRCODE='23514', CONSTRAINT=reason; END IF;
  IF jsonb_array_length(p_verdict->'targets') IS DISTINCT FROM jsonb_array_length(p_targets) THEN
    RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
  END IF;

  FOR target, actual IN SELECT t.value,v.value FROM jsonb_array_elements(p_targets) WITH ORDINALITY t(value,n)
    JOIN jsonb_array_elements(p_verdict->'targets') WITH ORDINALITY v(value,n) USING (n) LOOP
    operation := target->'operation';
    key := operation->>'commandKey';
    reason := actual->>'reason';
    IF actual->'skuId' IS DISTINCT FROM target->'skuId' THEN
      RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
    END IF;
    IF NOT (key=ANY(p_fresh_keys)) THEN
      saved := public.catalog_publication_completed_price_receipt_v2(operation,p_actor);
      receipt := saved.response_payload->'receipt';
      IF (CASE WHEN jsonb_typeof(saved.response_payload)='object' THEN saved.response_payload - 'receipt' END) IS DISTINCT FROM '{"outcome":"committed"}'::jsonb
        OR saved.metadata IS DISTINCT FROM jsonb_build_object('actorId',p_actor,'variantId',target->'skuId','priceListId',context->'priceListId')
        OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
        OR (CASE WHEN jsonb_typeof(receipt)='object' THEN receipt - ARRAY['previous','current'] END) IS DISTINCT FROM jsonb_build_object(
          'actorId',p_actor,'commandKey',operation->'commandKey','variantId',target->'skuId',
          'priceListId',context->'priceListId','amountBasis',context->'amountBasis')
        OR receipt->'previous' IS NULL OR jsonb_typeof(receipt->'current') IS DISTINCT FROM 'object'
        OR reason='base_price_ambiguous' THEN
        RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
      END IF;

      SELECT * INTO current_entry FROM public.price_entries e WHERE e.id=(actual #>> '{previous,entryId}')::uuid
        AND e.variant_id=(target->>'skuId')::uuid AND e.price_list_id=(context->>'priceListId')::uuid;
      IF NOT FOUND OR (receipt->'current')-'validFrom' IS DISTINCT FROM actual->'previous'
        OR receipt #> '{current,unitPriceMinor}' IS DISTINCT FROM operation->'unitPriceMinor'
        OR receipt #> '{current,amountKind}' IS DISTINCT FROM operation->'amountKind' THEN
        RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
      END IF;
      SELECT * INTO prior_entry FROM public.price_entries e WHERE e.id=(operation #>> '{expected,entryId}')::uuid
        AND (e.variant_id,e.price_list_id,e.mode,e.min_qty)=(current_entry.variant_id,current_entry.price_list_id,'one_time',1);
      IF operation #>> '{expected,entryId}' IS NULL THEN
        IF receipt->'previous' IS DISTINCT FROM 'null'::jsonb THEN
          RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
        END IF;
      ELSIF NOT FOUND OR prior_entry.active OR prior_entry.valid_to IS DISTINCT FROM current_entry.valid_from
        OR (CASE WHEN jsonb_typeof(receipt->'previous')='object' THEN (receipt->'previous')-'validFrom' END) IS DISTINCT FROM operation->'expected'
        OR operation->'expected' IS DISTINCT FROM jsonb_build_object(
          'entryId',prior_entry.id,'unitPriceMinor',prior_entry.unit_price_minor,'amountKind',prior_entry.amount_kind) THEN
        RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
      END IF;

      -- Compare instants at PostgreSQL precision, including a predecessor's start.
      FOR proof, expected_start IN SELECT receipt->'current',current_entry.valid_from
        UNION ALL SELECT receipt->'previous',prior_entry.valid_from WHERE prior_entry.id IS NOT NULL LOOP
        IF jsonb_typeof(proof->'validFrom') IS DISTINCT FROM 'string' OR (proof->>'validFrom' NOT IN ('-infinity','infinity') AND proof->>'validFrom' !~ timestamp_shape)
          OR (proof->>'validFrom')::timestamptz IS DISTINCT FROM expected_start THEN
          RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
        END IF;
      END LOOP;
    END IF;
    IF reason='expected_state_mismatch' THEN
      RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
    ELSIF reason IS NOT NULL THEN
      RAISE EXCEPTION '%',reason USING ERRCODE='23514', CONSTRAINT=reason;
    END IF;
  END LOOP;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
  RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_assert_price_receipt_v2(jsonb,jsonb,jsonb,uuid,text[],text) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_lock_effective_base_price_v2(p_sku uuid, p_list uuid, p_approval uuid)
RETURNS TABLE(id uuid, unit_price_minor integer, amount_kind text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := public.catalog_price_setup_require_human_admin();
  approval public.catalog_publication_decisions%ROWTYPE;
  previous_id uuid;
  fenced_candidate text;
  authored jsonb;
  operations jsonb;
  operation jsonb;
  target jsonb;
  verdict jsonb;
  observed jsonb;
  tax_class text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'catalog_publication_isolation_unsupported' USING ERRCODE='22023',
      DETAIL='isolation', HINT='Roll back and restart in READ COMMITTED.';
  END IF;
  SELECT d.candidate_ref INTO fenced_candidate FROM public.catalog_publication_decisions d WHERE d.id=p_approval;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-publication-candidate:' ||
      public.catalog_publication_canonical(to_jsonb(fenced_candidate),0),0));
    SELECT d.* INTO approval FROM public.catalog_publication_decisions d
      WHERE d.id=p_approval AND d.action='approve' AND d.candidate_ref=fenced_candidate;
  END IF;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.catalog_publication_decisions d
    WHERE (d.product_id,d.candidate_ref,d.candidate_digest)=(approval.product_id,approval.candidate_ref,approval.candidate_digest)
      AND (d.decided_at,d.id)>(approval.decided_at,approval.id)) THEN
    RAISE EXCEPTION 'catalog_publication_approval_wrong' USING ERRCODE='23514', CONSTRAINT='catalog_publication_approval_wrong';
  END IF;
  PERFORM public.catalog_publication_assert_receipt(approval.product_id,approval.command_key);
  authored := public.catalog_publication_candidate_source(approval.product_id,approval.candidate_ref,approval.candidate_digest);
  operations := public.catalog_publication_price_operations_v2(authored,approval.product_id,false);
  previous_id := nullif(split_part(split_part(approval.candidate_ref,'/',2),'@',1),'unpublished')::uuid;
  SELECT item->'operation', modes INTO operation,target
  FROM jsonb_array_elements(operations) item
  JOIN jsonb_array_elements(authored->'skus') s ON s->'id'=item->'skuId'
  CROSS JOIN LATERAL public.catalog_publication_price_modes_v2(authored,previous_id,jsonb_build_array(s),
    public.catalog_publication_first_offer_input_v2(approval.product_id,previous_id,approval,NULL,p_sku))
  WHERE item->'skuId'=to_jsonb(p_sku) AND item #> '{operation,priceListId}'=to_jsonb(p_list)
    AND item #> '{operation,schemaVersion}'='2'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog_publication_price_issue_required' USING ERRCODE='23514', CONSTRAINT='catalog_publication_price_issue_required';
  END IF;
  target := target || jsonb_build_object('skuId',p_sku,'operation',operation);
  -- Validate receipt identity before entering the price fence, as the recorder does.
  PERFORM public.catalog_publication_completed_price_receipt_v2(operation,actor);
  PERFORM public.catalog_price_setup_lock_context(p_list,p_sku);
  LOCK TABLE public.commerce_settings, public.price_lists, public.subscription_price_policy_revisions IN SHARE MODE NOWAIT;
  LOCK TABLE public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  PERFORM 1 FROM public.price_entries e WHERE (e.price_list_id,e.variant_id)=(p_list,p_sku)
    ORDER BY e.id FOR NO KEY UPDATE NOWAIT;
  tax_class := public.catalog_publication_lock_tax_class_v2(authored);
  verdict := public.catalog_publication_target_price_verdict(jsonb_build_array(target-'operation'),clock_timestamp());
  PERFORM public.catalog_publication_assert_price_receipt_v2(authored,jsonb_build_array(target),verdict,actor,ARRAY[]::text[],tax_class);
  IF target->'needsFresh'='true'::jsonb AND NOT EXISTS (
    SELECT 1 FROM public.catalog_publications p WHERE p.approval_id=approval.id) THEN
    RAISE EXCEPTION 'catalog_publication_price_edit_required' USING ERRCODE='23514', CONSTRAINT='catalog_publication_price_edit_required';
  END IF;
  observed := verdict #> '{targets,0,previous}';
  RETURN QUERY SELECT (observed->>'entryId')::uuid,(observed->>'unitPriceMinor')::integer,observed->>'amountKind';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb), public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid), public.catalog_publication_price_operations_v2(jsonb,uuid,boolean), public.catalog_publication_price_modes_v2(jsonb,uuid,jsonb,jsonb), public.catalog_publication_assert_price_receipt_v2(jsonb,jsonb,jsonb,uuid,text[],text), public.catalog_publication_completed_price_receipt_v2(jsonb,uuid), public.catalog_publication_lock_tax_class_v2(jsonb), public.catalog_publication_first_offer_input_v2(uuid,uuid,public.catalog_publication_decisions,jsonb,uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb), public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid), public.catalog_publication_price_operations_v2(jsonb,uuid,boolean), public.catalog_publication_price_modes_v2(jsonb,uuid,jsonb,jsonb), public.catalog_publication_assert_price_receipt_v2(jsonb,jsonb,jsonb,uuid,text[],text), public.catalog_publication_completed_price_receipt_v2(jsonb,uuid), public.catalog_publication_lock_tax_class_v2(jsonb), public.catalog_publication_first_offer_input_v2(uuid,uuid,public.catalog_publication_decisions,jsonb,uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb), public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid), public.catalog_publication_price_operations_v2(jsonb,uuid,boolean), public.catalog_publication_price_modes_v2(jsonb,uuid,jsonb,jsonb), public.catalog_publication_assert_price_receipt_v2(jsonb,jsonb,jsonb,uuid,text[],text), public.catalog_publication_completed_price_receipt_v2(jsonb,uuid), public.catalog_publication_lock_tax_class_v2(jsonb), public.catalog_publication_first_offer_input_v2(uuid,uuid,public.catalog_publication_decisions,jsonb,uuid) FROM service_role;';
END IF; END; $$;

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
  price_context jsonb;
  price_v2 boolean;
  operations jsonb;
  target jsonb;
  targets jsonb;
  actual_targets jsonb;
  verdict jsonb;
  operation jsonb;
  fresh_keys text[] := ARRAY[]::text[];
  child_results jsonb := '{}';
  child jsonb;
  key text;
  command_text text;
  reason text;
  at_price timestamptz;
  tax_class text;
  assessment_skus jsonb;
  draft public.catalog_draft_heads%ROWTYPE;
  prospective public.catalog_publications%ROWTYPE;
  approval public.catalog_publication_decisions%ROWTYPE;
  approved_state text;
  price_list uuid;
  price_sku uuid;
BEGIN
  IF command_kind IN ('approve','revoke') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-publication-candidate:' ||
      public.catalog_publication_canonical(to_jsonb(candidate_ref),0),0));
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
       fingerprint,reason,post_state_canonical_text,post_state_digest,decided_at,post_state_sku_facts)
    VALUES (new_id,product_id,candidate_ref,candidate_digest,
      encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(candidate_ref,candidate_digest),0),'UTF8')),'hex'),
      command_kind,actor_id,command_key,fingerprint,p_command->>'reason',seal,seal_digest,stamp,
      CASE WHEN command_kind='approve' THEN nullif(p_command->'postStateSkus','null'::jsonb) END);
    INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,result)
    VALUES(command_kind,product_id,command_key,fingerprint,actor_id,receipt);
    RETURN receipt;
  END IF;
  IF command_kind IS NULL OR command_kind NOT IN ('publish','assess_price_v2') THEN
    RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='22023';
  END IF;

  authored := public.catalog_publication_candidate_source(product_id,candidate_ref,candidate_digest);
  price_context := authored #> '{publication,evidence,priceContext}';
  operations := public.catalog_publication_price_operations_v2(authored,product_id,command_kind='assess_price_v2');
  price_v2 := price_context IS NOT NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(operations) item WHERE item #> '{operation,schemaVersion}' = '2'::jsonb);

  IF command_kind='assess_price_v2' THEN
    IF p_command - ARRAY['action','productId','candidateRef','candidateDigest'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='22023';
    END IF;
    SELECT d.* INTO approval FROM public.catalog_publication_decisions d
      WHERE (d.product_id,d.candidate_ref,d.candidate_digest)=(product_id,candidate_ref,candidate_digest)
      ORDER BY d.decided_at DESC,d.id DESC LIMIT 1;
    previous_id := nullif(split_part(split_part(candidate_ref,'/',2),'@',1),'unpublished')::uuid;
    IF approval.action='approve' THEN
      PERFORM public.catalog_publication_assert_receipt(product_id,approval.command_key);
      SELECT jsonb_agg(public.catalog_publication_read_sku_revision(p.product_id,ref))
        INTO assessment_skus FROM public.catalog_publications p
        CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
        WHERE p.approval_id=approval.id;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',s->'id','operation',item->'operation') || modes
      ORDER BY s->>'id' COLLATE "C", item #>> '{operation,commandKey}' COLLATE "C"),'[]')
    INTO targets FROM public.catalog_publication_price_modes_v2(authored,previous_id,coalesce(assessment_skus,authored->'skus'),
      public.catalog_publication_first_offer_input_v2(product_id,previous_id,approval,NULL,NULL)) AS priced(s,modes)
    LEFT JOIN jsonb_array_elements(operations) item ON item->'skuId'=s->'id' AND item #> '{operation,schemaVersion}'='2'::jsonb
    WHERE item IS NOT NULL OR modes->'firstAdmission'='true'::jsonb OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(authored #> '{product,sharedContent,requestedModes}') r
      WHERE r->'skuCode'=s->'code' AND jsonb_array_length(r->'modes')>0);
    verdict := public.catalog_publication_target_price_verdict(targets,clock_timestamp());
    IF verdict ? 'targets' THEN
      SELECT coalesce(jsonb_agg(CASE WHEN t->'firstAdmission'='true'::jsonb AND t->'operation'='null'::jsonb
        THEN v || '{"reason":"catalog_publication_price_edit_required"}'::jsonb ELSE v END ORDER BY n),'[]')
        INTO actual_targets FROM jsonb_array_elements(targets) WITH ORDINALITY target(t,n)
        JOIN jsonb_array_elements(verdict->'targets') WITH ORDINALITY result(v,n) USING (n);
      verdict := jsonb_set(verdict,'{targets}',actual_targets);
    END IF;
    RETURN public.catalog_publication_canonical(verdict,0);
  END IF;

  IF price_v2 THEN
    IF public.catalog_price_basis_gate('command_invalid') IS NOT NULL THEN
      RAISE EXCEPTION 'command_invalid' USING ERRCODE='23514', CONSTRAINT='command_invalid';
    END IF;
    -- Direct issuance takes the same fences as the publication host.
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-publication-candidate:' ||
      public.catalog_publication_canonical(to_jsonb(candidate_ref),0),0));
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-publication-command:' ||
      public.catalog_publication_canonical(jsonb_build_array(product_id,command_key),0),0));
    SELECT d.* INTO draft FROM public.catalog_draft_heads d
      WHERE d.draft_id=split_part(substr(candidate_ref,4),'@',1)::uuid FOR NO KEY UPDATE;
    IF NOT FOUND OR draft.product_id<>product_id OR draft.status<>'open'
      OR draft.revision::text<>split_part(split_part(candidate_ref,'/',1),'@',2) THEN
      RAISE EXCEPTION 'catalog_publication_draft_advanced' USING ERRCODE='23514', CONSTRAINT='catalog_publication_draft_advanced';
    END IF;
    PERFORM public.catalog_publication_lock_projection();
    PERFORM 1 FROM public.catalog_products p WHERE p.id=product_id FOR NO KEY UPDATE NOWAIT;
    SELECT h.publication_id INTO prospective.previous_id FROM public.catalog_publication_heads h
      WHERE h.product_id=product_id FOR NO KEY UPDATE NOWAIT;
    PERFORM 1 FROM public.catalog_skus s WHERE s.product_id=product_id ORDER BY s.id FOR NO KEY UPDATE NOWAIT;
    PERFORM public.catalog_publication_assert_head(product_id,false);
    IF nullif(p_command->'expectedHead','null'::jsonb) IS DISTINCT FROM
       public.catalog_publication_head_ref(product_id,prospective.previous_id)
      OR candidate_ref IS DISTINCT FROM 'v1:' || draft.draft_id || '@' || draft.revision || '/' ||
        coalesce(prospective.previous_id || '@' || (p_command #>> '{expectedHead,revision}'),'unpublished')
      OR product->'id' IS DISTINCT FROM to_jsonb(product_id)
      OR product->'type' IS DISTINCT FROM authored #> '{product,type}'
      OR product->'source' IS DISTINCT FROM (SELECT jsonb_build_object(
        'draftId',d.draft_id,'revision',d.revision,'commandKey',d.command_key,'fingerprint',d.fingerprint)
        FROM public.catalog_draft_revisions d WHERE (d.draft_id,d.revision)=(draft.draft_id,draft.revision)) THEN
      RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM public.catalog_publications p
      WHERE (p.product_id,p.candidate_ref,p.candidate_digest)=(product_id,candidate_ref,candidate_digest)) THEN
      RAISE EXCEPTION 'catalog_publication_candidate_already_issued'
        USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_already_issued';
    END IF;
  END IF;

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

  IF price_v2 THEN
    prospective.id := new_id;
    prospective.product_id := product_id;
    prospective.candidate_ref := candidate_ref;
    prospective.candidate_digest := candidate_digest;
    prospective.approval_id := (p_command->>'approvalId')::uuid;
    SELECT d.* INTO approval FROM public.catalog_publication_decisions d WHERE d.id=prospective.approval_id;
    prospective.committed_at := greatest(clock_timestamp(),approval.decided_at);
    body := jsonb_build_object('schemaVersion',dialect,'product',product,'skus',(
      SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',r->'skuId','digest',r->'digest') ORDER BY r->>'skuId' COLLATE "C"),'[]')
      FROM jsonb_array_elements(roster) r));
    PERFORM public.catalog_publication_assert_candidate(NULL,prospective,body);
    IF approval.id IS NULL THEN
      RAISE EXCEPTION 'catalog_publication_approval_wrong' USING ERRCODE='23514', CONSTRAINT='catalog_publication_approval_wrong';
    END IF;
    PERFORM public.catalog_publication_assert_receipt(product_id,approval.command_key);
    approved_state := public.catalog_publication_canonical(body,0);
    IF approval.post_state_digest IS DISTINCT FROM encode(sha256(convert_to(approved_state,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'catalog_publication_post_state_changed' USING ERRCODE='23514', CONSTRAINT='catalog_publication_post_state_changed';
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',s->'id','operation',item->'operation') || modes
      ORDER BY s->>'id' COLLATE "C"),'[]')
    INTO targets FROM public.catalog_publication_price_modes_v2(authored,previous_id,p_command->'skus',
      public.catalog_publication_first_offer_input_v2(product_id,previous_id,approval,p_command->'skus',NULL)) AS priced(s,modes)
    LEFT JOIN jsonb_array_elements(operations) item ON item->'skuId'=s->'id';
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(targets) t
      JOIN jsonb_array_elements(p_command->'skus') s ON s->'id'=t->'skuId'
      WHERE ((t->'requiredModes') ? 'subscription') IS DISTINCT FROM (s->'sellableInSubscription'='true'::jsonb)
        OR t->'sellableStandalone' IS DISTINCT FROM s->'sellableStandalone') THEN
      RAISE EXCEPTION 'catalog_publication_post_state_changed' USING ERRCODE='23514', CONSTRAINT='catalog_publication_post_state_changed';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(targets) t WHERE t->'needsFresh'='true'::jsonb
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(operations) item
        WHERE item->'skuId'=t->'skuId' AND item #> '{operation,schemaVersion}'='2'::jsonb)) THEN
      RAISE EXCEPTION 'catalog_publication_price_edit_required' USING ERRCODE='23514', CONSTRAINT='catalog_publication_price_edit_required';
    END IF;
    SELECT coalesce(jsonb_agg(t ORDER BY t->>'skuId' COLLATE "C", t #>> '{operation,commandKey}' COLLATE "C"),'[]') INTO targets FROM jsonb_array_elements(targets) t WHERE t->'operation'<>'null'::jsonb;
    IF jsonb_array_length(targets)<>jsonb_array_length(operations) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(targets) t WHERE NOT EXISTS (
        SELECT 1 FROM public.catalog_skus s WHERE s.product_id=product_id AND to_jsonb(s.id)=t->'skuId')) THEN
      RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
    END IF;
    -- Reserve the entire receipt set before entering the price fence.
    FOR operation IN SELECT item->'operation' FROM jsonb_array_elements(operations) item
      ORDER BY convert_to(item #>> '{operation,commandKey}','UTF8') LOOP
      key := operation->>'commandKey';
      command_text := public.catalog_publication_canonical(operation,0);
      child := public.catalog_price_setup_claim(command_text,encode(sha256(convert_to(command_text,'UTF8')),'hex'));
      IF child->>'outcome' NOT IN ('claimed','replayed') THEN
        reason := child->>'reason';
        RAISE EXCEPTION '%', reason USING ERRCODE=CASE child->>'outcome' WHEN 'conflict' THEN '40001'
          WHEN 'unauthorized' THEN '42501' ELSE '23514' END, CONSTRAINT=reason;
      END IF;
      IF child->>'outcome'='claimed' THEN
        child_results := child_results || jsonb_build_object(key,child);
        fresh_keys := array_append(fresh_keys,key);
      END IF;
    END LOOP;

    FOR price_list, price_sku IN SELECT DISTINCT (t #>> '{operation,priceListId}')::uuid AS list_id,(t->>'skuId')::uuid AS sku_id
      FROM jsonb_array_elements(targets) t ORDER BY list_id,sku_id LOOP
      PERFORM public.catalog_price_setup_lock_context(price_list,price_sku);
    END LOOP;
    LOCK TABLE public.commerce_settings, public.price_lists, public.subscription_price_policy_revisions IN SHARE MODE NOWAIT;
    LOCK TABLE public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    price_list := (operations #>> '{0,operation,priceListId}')::uuid;
    PERFORM 1 FROM public.price_entries e WHERE e.price_list_id=price_list
      AND e.variant_id IN (SELECT (t->>'skuId')::uuid FROM jsonb_array_elements(targets) t)
      ORDER BY e.id FOR NO KEY UPDATE NOWAIT;
    tax_class := public.catalog_publication_lock_tax_class_v2(authored);
    at_price := clock_timestamp();

    -- Evaluate proposals only for fresh claims. A replay proves its current row below.
    SELECT coalesce(jsonb_agg(CASE WHEN (t #>> '{operation,commandKey}')=ANY(fresh_keys)
      THEN t ELSE t-'operation' END ORDER BY t->>'skuId' COLLATE "C"),'[]')
      INTO actual_targets FROM jsonb_array_elements(targets) t;
    verdict := public.catalog_publication_target_price_verdict(actual_targets,at_price);
    PERFORM public.catalog_publication_assert_price_receipt_v2(authored,targets,verdict,actor_id,fresh_keys,tax_class);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(targets) t
      WHERE t->'needsFresh'='true'::jsonb AND NOT ((t #>> '{operation,commandKey}')=ANY(fresh_keys))) THEN
      RAISE EXCEPTION 'catalog_publication_price_edit_required' USING ERRCODE='23514', CONSTRAINT='catalog_publication_price_edit_required';
    END IF;

    FOR target IN SELECT value FROM jsonb_array_elements(targets) LOOP
      key := target #>> '{operation,commandKey}';
      child := child_results->key;
      IF child->>'outcome'='claimed' THEN
        child := public.catalog_price_setup_mutate_claimed(child,at_price,target->'requiredModes');
        IF child->>'outcome' IS DISTINCT FROM 'committed' THEN
          reason := child->>'reason';
          IF reason='expected_state_mismatch' THEN
            RAISE EXCEPTION 'catalog_publication_price_changed' USING ERRCODE='40001';
          END IF;
          RAISE EXCEPTION '%', reason USING ERRCODE='23514', CONSTRAINT=reason;
        END IF;
      END IF;
    END LOOP;

    SELECT coalesce(jsonb_agg(t-'operation' ORDER BY t->>'skuId' COLLATE "C", t #>> '{operation,commandKey}' COLLATE "C"),'[]')
      INTO actual_targets FROM jsonb_array_elements(targets) t;
    verdict := public.catalog_publication_target_price_verdict(actual_targets,at_price);
    PERFORM public.catalog_publication_assert_price_receipt_v2(authored,targets,verdict,actor_id,ARRAY[]::text[],tax_class);
  END IF;

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
