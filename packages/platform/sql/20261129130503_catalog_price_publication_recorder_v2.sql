-- Basis-aware price effects stay private until the paired publication grants.

CREATE FUNCTION public.catalog_price_setup_mutate_claimed(p_claim jsonb, p_at timestamptz, p_publication jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := p_at;
  v_actor uuid;
  v_is_v2 boolean;
  v_basis text;
  v_kind text;
  v_verdict jsonb;
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

  IF p_publication IS NOT NULL THEN
    -- The publication decision already holds the whole-plan price fence.
    v_basis := v_command->>'expectedListAmountBasis';
    IF p_publication #>> '{previous,entryId}' IS NOT NULL THEN
      SELECT * INTO STRICT v_current FROM public.price_entries WHERE id=(p_publication #>> '{previous,entryId}')::uuid;
    END IF;
  ELSE
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
      v_verdict := public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,NULL,
        jsonb_build_object('lane','immediate','operation',v_command,'sku',to_jsonb(v_sku)),v_now);
      v_refusal := v_verdict->>'reason';
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

  END IF;

  -- 9. Close the current base and insert its replacement at the same instant.
  IF v_current.id IS NOT NULL THEN
    UPDATE public.price_entries SET active = false, valid_to = v_now, updated_at = v_now
    WHERE id = v_current.id;
  END IF;
  INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty,
    unit_price_minor, amount_kind, active, valid_from)
  VALUES (v_list_id, v_variant_id, 'one_time', 1, v_unit_price_minor, v_kind, true, v_now)
  RETURNING id INTO v_entry_id;

  IF p_publication IS NULL THEN
    IF v_is_v2 THEN
      v_verdict := public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,NULL,
        jsonb_build_object('lane','immediate','operation',v_command,'sku',to_jsonb(v_sku),'written',true),v_now);
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
  SET status = 'completed', response_payload = v_response,
      metadata = CASE WHEN p_publication IS NULL THEN metadata
        ELSE metadata || jsonb_build_object('publicationId',p_publication->'publicationId') END
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

CREATE FUNCTION public.catalog_publication_price_operations_v2(p_authored jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',s->'id','productId',s->'productId','operation',op)),'[]')
  FROM jsonb_array_elements(p_authored->'skus') s CROSS JOIN LATERAL jsonb_array_elements(s->'priceOperations') op
$$;

CREATE FUNCTION public.catalog_publication_price_revision_facts_v2(p_product uuid,p_manifest jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE skus jsonb; missing boolean;
BEGIN
  SELECT coalesce(jsonb_agg(facts ORDER BY n),'[]'), coalesce(bool_or(facts IS NULL),false) INTO skus,missing
  FROM jsonb_array_elements(p_manifest->'skus') WITH ORDINALITY AS roster(ref,n)
  CROSS JOIN LATERAL (SELECT public.catalog_publication_read_sku_revision(p_product,ref) AS facts OFFSET 0) resolved;
  IF missing THEN
    RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
  END IF;
  RETURN jsonb_build_object('product',p_manifest->'product','skus',skus);
END;
$$;

CREATE FUNCTION public.catalog_publication_price_tax_class_v2(p_product jsonb,p_context jsonb,p_lock boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE class_key text; class_status text;
BEGIN
  IF p_context->>'amountBasis'='tax_exclusive' THEN
    SELECT t.definition->>'taxClass' INTO class_key FROM public.catalog_type_versions t
      WHERE t.type_key=p_product #>> '{type,key}' AND to_jsonb(t.version)=p_product #> '{type,version}';
    IF p_lock THEN
      -- The relation acquisition may wait. Start the row-lock statement after that wait.
      LOCK TABLE public.catalog_tax_classes IN ROW SHARE MODE;
      SELECT c.status INTO class_status FROM public.catalog_tax_classes c WHERE c.key=class_key FOR SHARE NOWAIT;
    ELSE
      SELECT c.status INTO class_status FROM public.catalog_tax_classes c WHERE c.key=class_key;
    END IF;
    IF class_status='active' THEN RETURN class_key; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.catalog_publication_lock_price_plan_v2(p_plan jsonb,p_product jsonb,p_context jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target jsonb;
BEGIN
  FOR target IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
    PERFORM public.catalog_price_setup_lock_context((target->>'priceListId')::uuid,(target->>'skuId')::uuid);
  END LOOP;
  LOCK TABLE public.commerce_settings, public.price_lists, public.subscription_price_policy_revisions IN SHARE MODE NOWAIT;
  LOCK TABLE public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  PERFORM 1 FROM public.price_entries e JOIN jsonb_array_elements(p_plan) t
    ON (e.price_list_id,e.variant_id)=((t->>'priceListId')::uuid,(t->>'skuId')::uuid)
    ORDER BY e.id FOR NO KEY UPDATE OF e NOWAIT;
  RETURN public.catalog_publication_price_tax_class_v2(p_product,p_context,true);
END;
$$;

CREATE FUNCTION public.catalog_publication_price_receipt_facts_v2(saved public.catalog_price_setup_receipts,
  operation jsonb, p_actual jsonb, p_actor uuid, p_written_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  receipt jsonb := saved.response_payload->'receipt';
  prior_entry public.price_entries%ROWTYPE;
  current_entry public.price_entries%ROWTYPE;
  proof jsonb;
  expected_start timestamptz;
  timestamp_shape CONSTANT text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2}(:[0-9]{2})?)$';
BEGIN
  IF (CASE WHEN jsonb_typeof(saved.response_payload)='object' THEN saved.response_payload - 'receipt' END) IS DISTINCT FROM '{"outcome":"committed"}'::jsonb
    OR saved.metadata-'publicationId' IS DISTINCT FROM jsonb_build_object('actorId',p_actor,'variantId',operation->'variantId','priceListId',operation->'priceListId')
    OR (CASE WHEN jsonb_typeof(receipt)='object' THEN receipt - ARRAY['previous','current'] END) IS DISTINCT FROM jsonb_build_object(
      'actorId',p_actor,'commandKey',operation->'commandKey','variantId',operation->'variantId',
      'priceListId',operation->'priceListId','amountBasis',operation->'expectedListAmountBasis')
    OR receipt->'previous' IS NULL OR jsonb_typeof(receipt->'current') IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO current_entry FROM public.price_entries e WHERE e.id=(p_actual->>'entryId')::uuid
    AND (e.variant_id,e.price_list_id)=((operation->>'variantId')::uuid,(operation->>'priceListId')::uuid);
  IF NOT FOUND OR (p_written_at IS NOT NULL AND current_entry.valid_from IS DISTINCT FROM p_written_at)
    OR (receipt->'current')-'validFrom' IS DISTINCT FROM p_actual
    OR receipt #> '{current,unitPriceMinor}' IS DISTINCT FROM operation->'unitPriceMinor'
    OR receipt #> '{current,amountKind}' IS DISTINCT FROM operation->'amountKind' THEN RETURN NULL; END IF;
  SELECT * INTO prior_entry FROM public.price_entries e WHERE e.id=(operation #>> '{expected,entryId}')::uuid
    AND (e.variant_id,e.price_list_id,e.mode,e.min_qty)=(current_entry.variant_id,current_entry.price_list_id,'one_time',1);
  IF operation #>> '{expected,entryId}' IS NULL THEN
    IF receipt->'previous' IS DISTINCT FROM 'null'::jsonb THEN RETURN NULL; END IF;
  ELSIF NOT FOUND OR prior_entry.active OR prior_entry.valid_to IS DISTINCT FROM current_entry.valid_from
    OR (CASE WHEN jsonb_typeof(receipt->'previous')='object' THEN (receipt->'previous')-'validFrom' END) IS DISTINCT FROM operation->'expected'
    OR operation->'expected' IS DISTINCT FROM jsonb_build_object(
      'entryId',prior_entry.id,'unitPriceMinor',prior_entry.unit_price_minor,'amountKind',prior_entry.amount_kind) THEN RETURN NULL;
  END IF;
  FOR proof, expected_start IN SELECT receipt->'current',current_entry.valid_from
    UNION ALL SELECT receipt->'previous',prior_entry.valid_from WHERE prior_entry.id IS NOT NULL LOOP
    IF jsonb_typeof(proof->'validFrom') IS DISTINCT FROM 'string'
      OR (proof->>'validFrom' NOT IN ('-infinity','infinity') AND proof->>'validFrom' !~ timestamp_shape)
      OR (proof->>'validFrom')::timestamptz IS DISTINCT FROM expected_start THEN RETURN NULL; END IF;
  END LOOP;
  RETURN receipt;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_target_price_verdict(p_targets jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  region text := public.catalog_price_setup_region_code();
  settlement_currency text := public.catalog_price_setup_settlement_currency();
  list_id uuid;
  basis text;
  kind text;
  list_count integer;
  target jsonb;
  operation jsonb;
  observe_replay boolean;
  sku_id uuid;
  needs_subscription boolean;
  reason text;
  current_entry jsonb;
  current_start timestamptz;
  base_count integer;
  base_minor integer;
  subscription_count integer;
  subscription_valid boolean;
  wrong_kind_count integer;
  wrong_shape boolean;
  history_count integer;
  policy_count integer;
  policy_valid boolean;
  discount integer;
  quantum integer;
  results jsonb := '[]';
BEGIN
  SELECT count(*), (array_agg(l.id))[1], (array_agg(coalesce(l.amount_basis, 'tax_inclusive')))[1]
  INTO list_count, list_id, basis
  FROM public.price_lists l
  WHERE l.region_code=region AND l.currency=settlement_currency AND l.status='active'
    AND l.valid_from<=p_at AND (l.valid_to IS NULL OR l.valid_to>p_at);
  IF list_count <> 1 THEN
    RETURN jsonb_build_object('reason', CASE WHEN list_count=0 THEN 'active_price_list_not_found'
      ELSE 'active_price_list_ambiguous' END);
  END IF;
  kind := CASE basis WHEN 'tax_exclusive' THEN 'net' ELSE 'gross' END;
  FOR target IN SELECT value FROM jsonb_array_elements(p_targets) LOOP
    sku_id := (target->>'skuId')::uuid;
    operation := nullif(target->'operation','null'::jsonb);
    observe_replay := coalesce((target->>'observeReplay')::boolean,false);
    needs_subscription := coalesce((target->'requiredModes') ? 'subscription', false);
    SELECT count(*) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      min(e.unit_price_minor) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      (jsonb_agg(jsonb_build_object('entryId', e.id, 'unitPriceMinor', e.unit_price_minor, 'amountKind', e.amount_kind))
        FILTER (WHERE e.mode='one_time' AND e.min_qty=1))->0,
      min(e.valid_from) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      count(*) FILTER (WHERE e.mode='subscription'),
      bool_and(e.min_qty=1 AND e.unit_price_minor>0) FILTER (WHERE e.mode='subscription'),
      count(*) FILTER (WHERE e.mode IN ('one_time','any') AND e.amount_kind<>kind),
      bool_or(e.mode='any' OR e.min_qty<>1 OR (e.mode='subscription' AND e.amount_kind<>kind))
    INTO base_count, base_minor, current_entry, current_start, subscription_count, subscription_valid, wrong_kind_count, wrong_shape
    FROM public.price_entries e
    WHERE e.price_list_id=list_id AND e.variant_id=sku_id AND e.active
      AND e.valid_from<=p_at AND (e.valid_to IS NULL OR e.valid_to>p_at)
      AND (e.mode IN ('one_time','any') OR (needs_subscription AND e.mode='subscription'));

    reason := CASE
      WHEN operation IS NOT NULL AND operation->>'priceListId' IS DISTINCT FROM list_id::text THEN 'price_list_not_active'
      WHEN operation IS NOT NULL AND (operation->>'expectedListAmountBasis' IS DISTINCT FROM basis
        OR operation->>'amountKind' IS DISTINCT FROM kind) THEN 'catalog_price_setup_basis_mismatch'
      WHEN wrong_kind_count>0 AND NOT observe_replay THEN 'base_price_amount_kind_invalid'
      WHEN wrong_shape THEN 'price_shape_invalid'
      WHEN base_count>1 THEN 'base_price_ambiguous'
      WHEN operation IS NOT NULL AND (current_start=p_at OR EXISTS (
        SELECT 1 FROM public.price_entries e WHERE e.price_list_id=list_id AND e.variant_id=sku_id
          AND e.active AND e.mode IN ('one_time','any') AND e.valid_from>p_at))
        THEN 'catalog_price_setup_pending_entry'
      WHEN operation IS NOT NULL AND operation->'expected' IS DISTINCT FROM
        coalesce(current_entry, '{"entryId":null,"unitPriceMinor":null,"amountKind":null}'::jsonb)
        THEN 'expected_state_mismatch'
      WHEN operation IS NULL AND (base_count=0 OR base_minor<=0) THEN 'catalog_publication_sku_price_not_ready'
    END;
    IF reason IS NULL AND needs_subscription THEN
      SELECT count(*),count(*) FILTER (WHERE w.effective),bool_and(p.rounding_rule='FLOOR_TO_QUANTUM'
        AND p.rounding_quantum_minor>0 AND p.discount_bps BETWEEN 0 AND 10000
        AND p.digest=public.catalog_price_setup_policy_digest(p.id,p.revision_no,p.price_list_id,p.region_code,p.currency,p.channel,
          p.effective_from,CASE WHEN p.closed_from_open THEN NULL ELSE p.effective_to END,p.discount_bps,p.rounding_quantum_minor,p.rounding_rule))
        FILTER (WHERE w.effective), min(p.discount_bps) FILTER (WHERE w.effective), min(p.rounding_quantum_minor) FILTER (WHERE w.effective)
      INTO history_count,policy_count,policy_valid,discount,quantum
      FROM public.subscription_price_policy_revisions p
      CROSS JOIN LATERAL (SELECT p.effective_from<=p_at AND (p.effective_to IS NULL OR p.effective_to>p_at) AS effective) w
      WHERE p.price_list_id=list_id AND p.region_code=region AND p.currency=settlement_currency AND p.channel='D2C';
      IF NOT coalesce((history_count=0 AND subscription_count=1 AND subscription_valid)
        OR (history_count>0 AND policy_count=1 AND policy_valid AND subscription_count=0
          AND CASE WHEN quantum>0 THEN coalesce((operation->>'unitPriceMinor')::bigint,base_minor)
            *(10000-discount)/10000/quantum*quantum END>0),false) THEN
        reason := 'catalog_publication_sku_price_not_ready';
      END IF;
    END IF;
    results := results || jsonb_build_array(jsonb_build_object('skuId',sku_id,'reason',reason,'previous',current_entry)
      || CASE WHEN observe_replay THEN jsonb_build_object('baseRows',jsonb_build_object('count',base_count,'wrongKind',wrong_kind_count))
        ELSE '{}'::jsonb END);
  END LOOP;
  RETURN jsonb_build_object('priceListId',list_id,'regionCode',region,'currency',settlement_currency,'amountBasis',basis,'targets',results);
END;
$$;

-- A validated plan is carried across receipt reservation, the price fence and proof.
-- Observations describe the adapter phase. Only this routine interprets them.
CREATE FUNCTION public.catalog_publication_decide_prices_v2(p_previous_facts jsonb, p_next_facts jsonb,
  p_saved_operations jsonb, p_saved_context jsonb, p_observed_evidence jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  lane text := p_observed_evidence->>'lane';
  plan jsonb := p_observed_evidence->'plan';
  actor uuid := (p_observed_evidence->>'actor')::uuid;
  issue_id uuid := (p_observed_evidence->>'issueId')::uuid;
  claims jsonb := p_observed_evidence->'claims';
  written boolean := coalesce((p_observed_evidence->>'written')::boolean,false);
  mutations jsonb := '[]';
  targets jsonb := '[]';
  target jsonb;
  operation jsonb;
  actual jsonb;
  verdict jsonb;
  saved public.catalog_price_setup_receipts%ROWTYPE;
  replay jsonb;
  observed_entry jsonb;
  basis_matches boolean;
  wrong_kind boolean;
  possible_kind_drift boolean;
  fresh boolean;
  first_replayed jsonb;
  refusal text;
  price_reason text;
  replay_failed boolean;
  rank integer;
  best_rank integer := 100;
  tax jsonb := p_saved_context->'tax';
  tax_class text := p_observed_evidence->>'taxClass';
  selected jsonb;
  selected_price jsonb;
  state text;
  field text := 'skus[].priceOperations';
  remedy text := 'Correct the indicated field, save a new revision, and run Prepare.';
BEGIN
  IF lane='immediate' THEN
    operation := p_observed_evidence->'operation';
    target := jsonb_build_object('skuId',operation->'variantId','requiredModes',
      CASE WHEN (p_observed_evidence #>> '{sku,sellable_in_subscription}')::boolean
        THEN '["one_time","subscription"]'::jsonb ELSE '["one_time"]'::jsonb END);
    IF NOT written THEN target := target || jsonb_build_object('operation',operation); END IF;
    verdict := public.catalog_publication_target_price_verdict(jsonb_build_array(target),p_at);
    RETURN verdict || jsonb_build_object('reason',coalesce(verdict->>'reason',verdict #>> '{targets,0,reason}'));
  END IF;

  <<decision>>
  BEGIN
    IF lane='reader' AND issue_id IS NULL THEN
      refusal := 'catalog_publication_price_issue_required';
      selected := p_observed_evidence;
      EXIT decision;
    END IF;
    IF plan IS NULL THEN
      IF p_next_facts #> '{product,schemaVersion}' IS DISTINCT FROM '3'::jsonb OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_saved_operations) item
        WHERE item->'productId' IS DISTINCT FROM p_next_facts #> '{product,id}'
          OR item->'skuId' IS DISTINCT FROM item #> '{operation,variantId}'
          OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_next_facts->'skus') sku WHERE sku->'id'=item->'skuId')
          OR (item #> '{operation,schemaVersion}' IS DISTINCT FROM '1'::jsonb
            AND public.catalog_price_setup_v2_command_valid(item->'operation') IS DISTINCT FROM true)
      ) THEN
        refusal := 'price_operation_invalid';
        EXIT decision;
      END IF;

      WITH next_skus AS (
        SELECT sku AS facts, (sku->>'id')::uuid AS id,
          (p_next_facts #>> '{product,lifecycleState}'='active' AND sku->>'lifecycleState'='active') IS TRUE AS active
        FROM jsonb_array_elements(p_next_facts->'skus') sku
      ), prior_skus AS (
        SELECT sku AS facts, (sku->>'id')::uuid AS id,
          (p_previous_facts #>> '{product,lifecycleState}'='active' AND sku->>'lifecycleState'='active') IS TRUE AS active
        FROM jsonb_array_elements(p_previous_facts->'skus') sku
      ), transitions AS (
        SELECT n.id,
          n.active AND (n.facts->>'sellableInSubscription')::boolean AS subscription,
          (n.active AND ((n.facts->>'sellableStandalone')::boolean
            AND NOT coalesce(p.active AND (p.facts->>'sellableStandalone')::boolean,false)
            OR (n.facts->>'sellableInSubscription')::boolean
            AND NOT coalesce(p.active AND (p.facts->>'sellableInSubscription')::boolean,false)))
            OR (n.facts->'memberships' @> '[{"admitted":true}]'
              AND NOT coalesce(p.facts->'memberships' @> '[{"admitted":true}]',false)) AS needs_fresh
        FROM next_skus n LEFT JOIN prior_skus p USING (id)
      ), pairs AS (
        SELECT t.id, item #> '{operation,priceListId}' AS list_id, item->'operation' AS edit,
          t.needs_fresh AND item #> '{operation,priceListId}'=p_saved_context->'priceListId' AS needs_fresh, t.subscription
        FROM transitions t JOIN jsonb_array_elements(p_saved_operations) item ON item->'skuId'=to_jsonb(t.id)
        UNION ALL
        SELECT t.id,p_saved_context->'priceListId',NULL,true,t.subscription FROM transitions t
        WHERE t.needs_fresh AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_saved_operations) item
          WHERE item->'skuId'=to_jsonb(t.id) AND item #> '{operation,priceListId}'=p_saved_context->'priceListId')
      )
      SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',id,'priceListId',list_id,'operation',edit,
        'needsFresh',needs_fresh,'requiredModes',CASE WHEN subscription THEN '["one_time","subscription"]'::jsonb
          ELSE '["one_time"]'::jsonb END) ORDER BY (list_id #>> '{}')::uuid, id),'[]') INTO plan FROM pairs;

      SELECT t || jsonb_build_object('priceListId',p_saved_context->'priceListId') INTO selected
      FROM jsonb_array_elements(plan) t WHERE (t->>'needsFresh')::boolean
        AND t #> '{operation,schemaVersion}' IS DISTINCT FROM '2'::jsonb LIMIT 1;
      IF FOUND THEN refusal := 'catalog_publication_price_edit_required'; EXIT decision; END IF;
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(plan) t GROUP BY t->'skuId',t->'priceListId' HAVING count(*)>1)
          THEN 'catalog_publication_price_target_duplicate'
        WHEN (SELECT count(DISTINCT jsonb_build_array(t->'priceListId',t #> '{operation,expectedListAmountBasis}'))
          FROM jsonb_array_elements(plan) t)>1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(plan) t
          WHERE t #> '{operation,schemaVersion}'='1') THEN 'catalog_publication_mixed_price_lock_unsupported'
        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(plan) t
          GROUP BY convert_to(t #>> '{operation,commandKey}','UTF8') HAVING count(*)>1)
          THEN 'catalog_publication_price_key_reused'
      END INTO refusal;
      IF refusal IS NOT NULL THEN EXIT decision; END IF;
      IF lane='reader' THEN
        SELECT t INTO selected FROM jsonb_array_elements(plan) t
        WHERE t->'skuId'=p_observed_evidence->'skuId' AND t->'priceListId'=p_observed_evidence->'priceListId';
        IF selected IS NULL THEN
          refusal := 'catalog_publication_price_issue_required';
          selected := p_observed_evidence;
          EXIT decision;
        END IF;
      END IF;
      IF p_at IS NULL THEN EXIT decision; END IF;
    END IF;

    -- The adapters transport locked/claimed rows. Assessment observes the same
    -- ledger without reserving keys or waiting for another transaction.
    FOR target IN SELECT t FROM jsonb_array_elements(plan) t
      ORDER BY convert_to(t #>> '{operation,commandKey}','UTF8') LOOP
      operation := target->'operation';
      fresh := coalesce(claims #>> ARRAY[operation->>'commandKey','outcome']='claimed',false);
      SELECT * INTO saved FROM public.catalog_price_setup_receipts r
      WHERE r.scope='catalog.price_setup.base' AND r.idempotency_key=operation->>'commandKey';
      refusal := CASE
        WHEN NOT FOUND AND lane='reader' THEN 'catalog_publication_price_issue_required'
        WHEN NOT FOUND AND written THEN 'catalog_publication_price_changed'
        WHEN NOT FOUND AND lane='issuance' THEN 'price_operation_invalid'
        WHEN NOT FOUND THEN NULL
        WHEN saved.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
          public.catalog_publication_canonical(operation,0),'UTF8')),'hex') THEN 'command_key_reused'
        WHEN fresh AND NOT written AND (saved.status<>'in_progress' OR saved.response_payload IS NOT NULL)
          THEN 'price_operation_invalid'
        WHEN (NOT fresh OR written) AND (saved.status<>'completed' OR saved.response_payload IS NULL)
          THEN 'command_in_progress'
        WHEN saved.metadata->>'actorId' IS DISTINCT FROM actor::text THEN 'operator_mismatch'
      END;
      IF refusal IS NOT NULL THEN selected := target; EXIT decision; END IF;
    END LOOP;
    IF p_at IS NULL THEN EXIT decision; END IF;

    SELECT public.catalog_publication_target_price_verdict(coalesce(jsonb_agg(CASE
      WHEN NOT written AND (lane='assessment' AND r.idempotency_key IS NULL
        OR claims #>> ARRAY[t #>> '{operation,commandKey}','outcome']='claimed') THEN t
      ELSE (t-'operation') || '{"observeReplay":true}'::jsonb END ORDER BY n),'[]'),p_at)
    INTO verdict
    FROM jsonb_array_elements(plan) WITH ORDINALITY AS item(t,n)
    LEFT JOIN public.catalog_price_setup_receipts r ON r.scope='catalog.price_setup.base' AND r.idempotency_key=t #>> '{operation,commandKey}';
    refusal := verdict->>'reason';
    IF refusal IS NULL THEN
      refusal := CASE
        WHEN (CASE WHEN jsonb_typeof(p_saved_context)='object' THEN p_saved_context-'tax' END) IS DISTINCT FROM verdict-'targets'
          OR (p_saved_context->>'amountBasis'='tax_inclusive' AND tax IS DISTINCT FROM 'null'::jsonb)
          THEN 'catalog_publication_price_context_mismatch'
        WHEN p_saved_context->>'amountBasis'='tax_exclusive' AND tax_class IS NULL THEN 'catalog_publication_tax_class_unavailable'
        WHEN p_saved_context->>'amountBasis'='tax_exclusive' AND (
          (CASE WHEN jsonb_typeof(tax)='object' THEN tax - ARRAY['market','taxClassKey','classMapRevision','classMapDigest'] END) IS DISTINCT FROM '{}'::jsonb
          OR tax->'taxClassKey' IS DISTINCT FROM to_jsonb(tax_class)
          OR jsonb_typeof(tax->'market') IS DISTINCT FROM 'string' OR tax->>'market'=''
          OR jsonb_typeof(tax->'classMapRevision') IS DISTINCT FROM 'string' OR tax->>'classMapRevision'=''
          OR jsonb_typeof(tax->'classMapDigest') IS DISTINCT FROM 'string'
          OR coalesce(tax->>'classMapDigest','') !~ '^[0-9a-f]{64}$') THEN 'catalog_publication_price_class_map_mismatch'
      END;
    END IF;
    IF refusal IS NOT NULL THEN EXIT decision; END IF;

    IF jsonb_array_length(verdict->'targets') IS DISTINCT FROM jsonb_array_length(plan) THEN
      RAISE EXCEPTION 'catalog_publication_price_plan_invalid' USING ERRCODE='55000';
    END IF;
    FOR target, actual IN SELECT t.value,v.value FROM jsonb_array_elements(plan) WITH ORDINALITY t(value,n)
      JOIN jsonb_array_elements(verdict->'targets') WITH ORDINALITY v(value,n) USING (n) ORDER BY n LOOP
      IF actual->'skuId' IS DISTINCT FROM target->'skuId' THEN
        RAISE EXCEPTION 'catalog_publication_price_plan_invalid' USING ERRCODE='55000';
      END IF;
      operation := target->'operation';
      SELECT * INTO saved FROM public.catalog_price_setup_receipts r
        WHERE r.scope='catalog.price_setup.base' AND r.idempotency_key=operation->>'commandKey';
      fresh := coalesce(lane='assessment' AND NOT FOUND OR claims #>> ARRAY[operation->>'commandKey','outcome']='claimed',false);
      replay_failed := false;
      wrong_kind := coalesce((actual #>> '{baseRows,wrongKind}')::integer,0)>0;
      IF fresh AND NOT written THEN
        IF lane='issuance' THEN
          mutations := mutations || jsonb_build_array(jsonb_build_object('claim',claims->(operation->>'commandKey'),
            'publication',jsonb_build_object('previous',actual->'previous','publicationId',issue_id)));
        END IF;
      ELSE
        observed_entry := actual->'previous';
        basis_matches := (operation->>'expectedListAmountBasis'=verdict->>'amountBasis'
          AND operation->>'amountKind'=CASE verdict->>'amountBasis' WHEN 'tax_exclusive' THEN 'net' ELSE 'gross' END) IS TRUE;
        possible_kind_drift := basis_matches AND coalesce(actual->'baseRows'='{"count":1,"wrongKind":1}'::jsonb,false)
          AND observed_entry->'amountKind' IS DISTINCT FROM operation->'amountKind';
        -- Prove the sole row's receipt identity with only its observed kind normalized.
        -- A verified difference still fails replay, while another base or other bad evidence leaves the kind conflict ranked.
        IF possible_kind_drift THEN
          observed_entry := jsonb_set(observed_entry,'{amountKind}',operation->'amountKind');
        END IF;
        replay := public.catalog_publication_price_receipt_facts_v2(saved,operation,observed_entry,actor,
          CASE WHEN fresh THEN p_at END);
        replay_failed := replay IS NULL OR NOT basis_matches
          OR (fresh AND saved.metadata->'publicationId' IS DISTINCT FROM to_jsonb(issue_id));
        wrong_kind := wrong_kind AND NOT (possible_kind_drift AND NOT replay_failed);
        replay_failed := replay_failed OR possible_kind_drift;
        IF NOT replay_failed AND (target->>'needsFresh')::boolean
          AND (issue_id IS NULL OR saved.metadata->'publicationId' IS DISTINCT FROM to_jsonb(issue_id)) THEN
          first_replayed := coalesce(first_replayed,target);
        END IF;
      END IF;
      targets := targets || jsonb_build_array(actual-'baseRows');
      -- Rank the landed defect and failed receipt proof independently.
      SELECT reason,ord INTO price_reason,rank FROM unnest(ARRAY[
        'price_list_not_active','catalog_price_setup_basis_mismatch','base_price_amount_kind_invalid',
        'price_shape_invalid','base_price_ambiguous','catalog_price_setup_pending_entry',
        'catalog_publication_price_changed','catalog_publication_sku_price_not_ready']) WITH ORDINALITY AS ranked(reason,ord)
      WHERE (reason=actual->>'reason' AND (reason<>'base_price_ambiguous' OR fresh AND NOT written))
        OR (reason='base_price_amount_kind_invalid' AND wrong_kind)
        OR (reason='catalog_publication_price_changed' AND (replay_failed OR actual->>'reason'='expected_state_mismatch'
          OR (actual->>'reason'='base_price_ambiguous' AND (NOT fresh OR written))))
      ORDER BY ord LIMIT 1;
      IF rank<best_rank THEN
        best_rank := rank;
        refusal := price_reason;
        selected := target;
      END IF;
      IF target->'skuId'=p_observed_evidence->'skuId' AND target->'priceListId'=p_observed_evidence->'priceListId' THEN
        selected_price := actual->'previous';
      END IF;
    END LOOP;
    IF refusal IS NULL AND first_replayed IS NOT NULL THEN
      refusal := 'catalog_publication_price_edit_required';
      selected := first_replayed;
    END IF;
  END decision;

  IF refusal IS NULL THEN
    RETURN jsonb_build_object('outcome','pass','plan',plan,'targets',CASE WHEN verdict IS NOT NULL THEN targets END,
      'price',selected_price,'mutations',mutations);
  END IF;
  state := CASE WHEN refusal IN ('command_key_reused','command_in_progress','catalog_publication_price_changed') THEN '40001'
    WHEN refusal='operator_mismatch' THEN '42501' ELSE '23514' END;
  SELECT coalesce(f,field), coalesce(r,remedy) INTO field,remedy FROM (VALUES (refusal)) code(value)
  LEFT JOIN (VALUES
    ('catalog_publication_price_edit_required',NULL,'Add a fresh price edit for every SKU being activated, save a new revision, and approve its Prepare result.'),
    ('catalog_publication_price_target_duplicate',NULL,'Split or consolidate the edits.'),
    ('catalog_publication_mixed_price_lock_unsupported',NULL,'Split the edits into publications with one list, currency and basis each, then prepare and approve them separately.'),
    ('catalog_publication_price_key_reused','commandKey','Give the changed operation an unused key, save a new revision, and run Prepare.'),
    ('catalog_publication_price_issue_required','approvalId, commandKey','Publish the saved draft through Publish with its active approval.'),
    ('command_key_reused','commandKey','Give the changed operation an unused key, save a new revision, and run Prepare.'),
    ('command_in_progress','commandKey','Wait for the original request to finish and retry it with the same key.'),
    ('operator_mismatch','Operator','Sign in as the administrator who sent the original request and retry with the same key.'),
    ('active_price_list_not_found','Settlement region and currency','Configure exactly one effective list for the settlement region and currency.'),
    ('active_price_list_ambiguous','Settlement region and currency','Configure exactly one effective list for the settlement region and currency.'),
    ('catalog_publication_price_context_mismatch','publication.evidence.priceContext','Select the sole effective list for the correct region, currency and basis, save a new revision, and approve its Prepare result.'),
    ('catalog_publication_tax_class_unavailable','priceContext.tax.taxClassKey','Select an installed definition version with an active tax class, save a new revision, and run Prepare.'),
    ('catalog_publication_price_class_map_mismatch','priceContext.tax','Configure a new version of the class map used by checkout with an entry for the required class, save a new revision, and approve its Prepare result.'),
    ('price_list_not_active','priceListId','Select the effective settlement list and use its basis and matching amount kind.'),
    ('catalog_price_setup_basis_mismatch','expectedListAmountBasis','Select the effective settlement list and use its basis and matching amount kind.'),
    ('base_price_amount_kind_invalid','Effective base entry','End the conflicting entries through the price configuration owner and read the sole compatible base again.'),
    ('price_shape_invalid','Effective base entry','End the conflicting entries through the price configuration owner and read the sole compatible base again.'),
    ('base_price_ambiguous','Effective base entry','End the conflicting entries through the price configuration owner and read the sole compatible base again.'),
    ('catalog_price_setup_pending_entry','Base price window','Resolve the scheduled change or wait for it to take effect, then read the predecessor again.'),
    ('catalog_publication_price_changed','expected, receipt entries','Read the current predecessor ID, amount and kind and use them in a fresh edit.'),
    ('catalog_publication_sku_price_not_ready','SKU and required mode','Configure a compatible price or effective subscription policy for the required mode.')
  ) AS remedies(reason,f,r) ON reason=code.value;
  IF lane<>'assessment' THEN
    RAISE EXCEPTION '%',refusal USING ERRCODE=state, CONSTRAINT=refusal, DETAIL=field, HINT=remedy;
  END IF;
  RETURN jsonb_build_object('outcome','blocked-input','reason',refusal,'sqlstate',state,'field',field,'remedy',remedy,
    'pair',CASE WHEN selected IS NOT NULL THEN jsonb_build_object('skuId',selected->'skuId','priceListId',selected->'priceListId') END);
END;
$$;

-- Owner lane for the private compiler packet. Approval still stores only its seal.
CREATE FUNCTION public.catalog_publication_assess_prices_v2(p_packet jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := public.catalog_price_setup_require_human_admin();
  target_product uuid := (p_packet->>'productId')::uuid;
  candidate_ref text := p_packet->>'candidateRef';
  post_state jsonb := p_packet->'postState';
  seal jsonb;
  roster jsonb;
  authored jsonb;
  context jsonb;
  previous public.catalog_publications%ROWTYPE;
  draft public.catalog_draft_revisions%ROWTYPE;
  verdict jsonb;
BEGIN
  IF jsonb_typeof(p_packet) IS DISTINCT FROM 'object' OR p_packet->>'action' IS DISTINCT FROM 'assess_price_v2'
    OR p_packet - ARRAY['action','productId','candidateRef','candidateDigest','postState'] <> '{}'::jsonb
    OR jsonb_typeof(post_state) IS DISTINCT FROM 'object' OR post_state - ARRAY['canonicalText','digest','skus'] <> '{}'::jsonb
    OR jsonb_typeof(post_state->'skus') IS DISTINCT FROM 'array' OR jsonb_typeof(post_state->'canonicalText') IS DISTINCT FROM 'string'
    OR jsonb_typeof(post_state->'digest') IS DISTINCT FROM 'string' OR post_state->>'digest' !~ '^[0-9a-f]{64}$'
    OR octet_length(post_state->>'canonicalText') NOT BETWEEN 2 AND 16777216 THEN
    RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='22023';
  END IF;
  authored := public.catalog_publication_candidate_source(target_product,candidate_ref,p_packet->>'candidateDigest');
  context := authored #> '{publication,evidence,priceContext}';
  PERFORM public.catalog_publication_assert_head(target_product,false);
  SELECT p.* INTO previous FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id
    WHERE h.product_id=target_product;
  SELECT d.* INTO draft FROM public.catalog_draft_heads h JOIN public.catalog_draft_revisions d USING (draft_id,revision)
    WHERE d.product_id=target_product AND d.draft_id=split_part(substr(candidate_ref,4),'@',1)::uuid AND h.status='open';
  seal := public.catalog_publication_manifest_text(target_product,post_state->>'canonicalText',post_state->>'digest',true)::jsonb;
  IF NOT FOUND OR candidate_ref IS DISTINCT FROM 'v1:' || draft.draft_id || '@' || draft.revision || '/' ||
      coalesce(previous.id || '@' || previous.revision,'unpublished')
    OR authored->'schemaVersion' IS DISTINCT FROM '4'::jsonb OR seal->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR seal #> '{product,type}' IS DISTINCT FROM authored #> '{product,type}'
    OR seal #> '{product,document}' IS DISTINCT FROM authored #> '{product,documentRevision}'
    OR NOT EXISTS (SELECT 1 FROM public.catalog_type_versions t
      WHERE (t.type_key,to_jsonb(t.version),t.definition_digest)=(seal #>> '{product,type,key}',
        seal #> '{product,type,version}',seal #>> '{product,definitionDigest}'))
    OR seal #> '{product,source}' IS DISTINCT FROM jsonb_build_object('draftId',draft.draft_id,'revision',draft.revision,
      'commandKey',draft.command_key,'fingerprint',draft.fingerprint)
    OR jsonb_array_length(post_state->'skus') IS DISTINCT FROM jsonb_array_length(seal->'skus') THEN
    RAISE EXCEPTION 'catalog_publication_post_state_changed' USING ERRCODE='23514', CONSTRAINT='catalog_publication_post_state_changed';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',sku->'id','digest',CASE WHEN sku->'schemaVersion'='3'::jsonb THEN
    encode(sha256(convert_to(public.catalog_publication_sku_projection((sku->>'id')::uuid,target_product,sku->>'code',sku,false),'UTF8')),'hex')
    END) ORDER BY n),'[]') INTO roster FROM jsonb_array_elements(post_state->'skus') WITH ORDINALITY AS item(sku,n);
  IF roster IS DISTINCT FROM seal->'skus' THEN
    RAISE EXCEPTION 'catalog_publication_post_state_changed' USING ERRCODE='23514', CONSTRAINT='catalog_publication_post_state_changed';
  END IF;
  verdict := public.catalog_publication_decide_prices_v2(
    public.catalog_publication_price_revision_facts_v2(target_product,CASE WHEN previous.id IS NOT NULL THEN
      public.catalog_publication_manifest_text(target_product,previous.canonical_state,previous.digest,false)::jsonb END),
    jsonb_build_object('product',seal->'product','skus',post_state->'skus'),
    public.catalog_publication_price_operations_v2(authored),context,
    jsonb_build_object('lane','assessment','actor',actor,'taxClass',public.catalog_publication_price_tax_class_v2(seal->'product',context,false)),clock_timestamp());
  IF verdict->>'outcome'='pass' THEN
    verdict := (verdict - ARRAY['plan','price','mutations']) || jsonb_build_object('postStateDigest',post_state->'digest');
  END IF;
  RETURN public.catalog_publication_canonical(verdict,0);
END;
$$;

-- Dormant and owner-only. The paired runtime grant is supplied by a later forward.
CREATE FUNCTION public.catalog_publication_lock_effective_base_price_v2(p_sku uuid, p_list uuid, p_approval uuid)
RETURNS TABLE(id uuid, unit_price_minor integer, amount_kind text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := public.catalog_price_setup_require_human_admin();
  approval public.catalog_publication_decisions%ROWTYPE;
  issue public.catalog_publications%ROWTYPE;
  fenced_candidate text;
  next_manifest jsonb;
  previous_manifest jsonb;
  authored jsonb;
  context jsonb;
  evidence jsonb;
  plan jsonb;
  target jsonb;
  price jsonb;
  tax_class text;
  at_price timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'catalog_publication_isolation_unsupported' USING ERRCODE='22023',
      DETAIL='isolation', HINT='Restart Prepare in REPEATABLE READ READ ONLY or the locked operation in READ COMMITTED READ WRITE.';
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
  SELECT p.* INTO issue FROM public.catalog_publications p WHERE (p.product_id,p.approval_id)=(approval.product_id,approval.id);
  IF FOUND THEN
    PERFORM public.catalog_publication_assert_issued(issue.product_id,issue.id);
    next_manifest := issue.canonical_state::jsonb;
    SELECT public.catalog_publication_manifest_text(p.product_id,p.canonical_state,p.digest,false)::jsonb
      INTO previous_manifest FROM public.catalog_publications p WHERE (p.product_id,p.id)=(issue.product_id,issue.previous_id);
  END IF;
  authored := public.catalog_publication_candidate_source(approval.product_id,approval.candidate_ref,approval.candidate_digest);
  context := authored #> '{publication,evidence,priceContext}';
  evidence := jsonb_build_object('lane','reader','issueId',issue.id,'actor',actor,'skuId',p_sku,'priceListId',p_list);
  plan := public.catalog_publication_decide_prices_v2(
    public.catalog_publication_price_revision_facts_v2(approval.product_id,previous_manifest),
    public.catalog_publication_price_revision_facts_v2(approval.product_id,next_manifest),
    public.catalog_publication_price_operations_v2(authored),context,evidence,NULL)->'plan';
  FOR target IN SELECT t FROM jsonb_array_elements(plan) t ORDER BY convert_to(t #>> '{operation,commandKey}','UTF8') LOOP
    PERFORM 1 FROM public.catalog_price_setup_receipts r
      WHERE r.scope='catalog.price_setup.base' AND r.idempotency_key=target #>> '{operation,commandKey}' FOR NO KEY UPDATE NOWAIT;
  END LOOP;
  evidence := evidence || jsonb_build_object('plan',plan);
  PERFORM public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,context,evidence,NULL);
  tax_class := public.catalog_publication_lock_price_plan_v2(plan,next_manifest->'product',context);
  at_price := clock_timestamp();
  price := public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,context,evidence || jsonb_build_object('taxClass',tax_class),at_price)->'price';
  RETURN QUERY SELECT (price->>'entryId')::uuid,(price->>'unitPriceMinor')::integer,price->>'amountKind';
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_price_operations_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_price_revision_facts_v2(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_price_tax_class_v2(jsonb,jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_lock_price_plan_v2(jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_assess_prices_v2(jsonb) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb), public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid), public.catalog_publication_price_operations_v2(jsonb), public.catalog_publication_price_revision_facts_v2(uuid,jsonb), public.catalog_publication_price_tax_class_v2(jsonb,jsonb,boolean), public.catalog_publication_lock_price_plan_v2(jsonb,jsonb,jsonb), public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid,timestamptz), public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz), public.catalog_publication_assess_prices_v2(jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb), public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid), public.catalog_publication_price_operations_v2(jsonb), public.catalog_publication_price_revision_facts_v2(uuid,jsonb), public.catalog_publication_price_tax_class_v2(jsonb,jsonb,boolean), public.catalog_publication_lock_price_plan_v2(jsonb,jsonb,jsonb), public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid,timestamptz), public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz), public.catalog_publication_assess_prices_v2(jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_price_setup_mutate_claimed(jsonb,timestamptz,jsonb), public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid), public.catalog_publication_price_operations_v2(jsonb), public.catalog_publication_price_revision_facts_v2(uuid,jsonb), public.catalog_publication_price_tax_class_v2(jsonb,jsonb,boolean), public.catalog_publication_lock_price_plan_v2(jsonb,jsonb,jsonb), public.catalog_publication_price_receipt_facts_v2(public.catalog_price_setup_receipts,jsonb,jsonb,uuid,timestamptz), public.catalog_publication_decide_prices_v2(jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz), public.catalog_publication_assess_prices_v2(jsonb) FROM service_role;';
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
  mutation jsonb;
  plan jsonb;
  previous_manifest jsonb;
  evidence jsonb;
  verdict jsonb;
  operation jsonb;
  child_results jsonb := '{}';
  command_text text;
  at_price timestamptz;
  tax_class text;
  readiness_before jsonb;
  added jsonb;
  saved public.catalog_operator_receipts%ROWTYPE;
  draft public.catalog_draft_heads%ROWTYPE;
  prospective public.catalog_publications%ROWTYPE;
  approval public.catalog_publication_decisions%ROWTYPE;
  approved_state text;
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
  -- Direct issuance takes the same fences as the publication host.
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-publication-candidate:' ||
    public.catalog_publication_canonical(to_jsonb(candidate_ref),0),0));
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-publication-command:' ||
    public.catalog_publication_canonical(jsonb_build_array(product_id,command_key),0),0));
  SELECT r.* INTO saved FROM public.catalog_operator_receipts r
    WHERE (r.scope_id,r.command_key)=(product_id,command_key);
  IF FOUND THEN
    IF saved.actor_id IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'operator_mismatch' USING ERRCODE='42501', CONSTRAINT='operator_mismatch';
    END IF;
    IF saved.kind<>command_kind OR saved.fingerprint IS DISTINCT FROM p_command->>'fingerprint'
      OR saved.fingerprint IS DISTINCT FROM encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(
        jsonb_build_object('schemaVersion',2,'action',command_kind,'productId',product_id,'commandKey',command_key,
          'candidateRef',candidate_ref,'candidateDigest',candidate_digest,'expectedHead',p_command->'expectedHead','changes',p_command->'changes'),actor_id),0),'UTF8')),'hex') THEN
      RAISE EXCEPTION 'catalog_publication_command_key_reused' USING ERRCODE='23514', CONSTRAINT='catalog_publication_command_key_reused';
    END IF;
    RETURN public.catalog_publication_assert_receipt(product_id,command_key);
  END IF;

  authored := public.catalog_publication_candidate_source(product_id,candidate_ref,candidate_digest);
  price_context := authored #> '{publication,evidence,priceContext}';
  operations := public.catalog_publication_price_operations_v2(authored);
  price_v2 := price_context IS NOT NULL OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(operations) item WHERE item #> '{operation,schemaVersion}'='2');
  IF price_v2 THEN
    IF current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off' THEN
      RAISE EXCEPTION 'catalog_publication_isolation_unsupported' USING ERRCODE='22023',
        DETAIL='isolation', HINT='Restart Prepare in REPEATABLE READ READ ONLY or the locked operation in READ COMMITTED READ WRITE.';
    END IF;
    IF public.catalog_price_basis_gate('command_invalid') IS NOT NULL THEN
      RAISE EXCEPTION 'command_invalid' USING ERRCODE='23514', CONSTRAINT='command_invalid';
    END IF;
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

    SELECT public.catalog_publication_manifest_text(p.product_id,p.canonical_state,p.digest,false)::jsonb
      INTO previous_manifest FROM public.catalog_publications p WHERE (p.product_id,p.id)=(product_id,previous_id);
  END IF;
  INSERT INTO public.catalog_sku_revisions(id,sku_id,sku_code,product_id,revision,publication_id,issue_ordinal,full_facts,digest)
  SELECT id,sku_id,code,product_id,revision,new_id,ordinal,canonical,digest
  FROM jsonb_to_recordset(changed) AS item(id uuid,sku_id uuid,code text,revision integer,ordinal integer,canonical text,digest text);

  IF price_v2 THEN
    evidence := jsonb_build_object('lane','issuance','actor',actor_id,'issueId',new_id);
    plan := public.catalog_publication_decide_prices_v2(
      public.catalog_publication_price_revision_facts_v2(product_id,previous_manifest),
      public.catalog_publication_price_revision_facts_v2(product_id,jsonb_build_object('product',product,'skus',roster)),
      operations,price_context,evidence,NULL)->'plan';
    -- Reserve the validated receipt set before entering the price fence.
    FOR operation IN SELECT t->'operation' FROM jsonb_array_elements(plan) t
      ORDER BY convert_to(t #>> '{operation,commandKey}','UTF8') LOOP
      command_text := public.catalog_publication_canonical(operation,0);
      child_results := child_results || jsonb_build_object(operation->>'commandKey',
        public.catalog_price_setup_claim(command_text,encode(sha256(convert_to(command_text,'UTF8')),'hex')));
    END LOOP;
    evidence := evidence || jsonb_build_object('plan',plan);
    PERFORM public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,price_context,
      evidence || jsonb_build_object('claims',child_results),NULL);
    tax_class := public.catalog_publication_lock_price_plan_v2(plan,product,price_context);
    at_price := clock_timestamp();
    evidence := evidence || jsonb_build_object('taxClass',tax_class);
    evidence := evidence || jsonb_build_object('claims',child_results);
    verdict := public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,price_context,evidence,at_price);

    readiness_before := public.commerce_offer_policy_v2_readiness();
    FOR mutation IN SELECT value FROM jsonb_array_elements(verdict->'mutations') LOOP
      PERFORM public.catalog_price_setup_mutate_claimed(mutation->'claim',at_price,mutation->'publication');
    END LOOP;
    PERFORM public.catalog_publication_decide_prices_v2(NULL,NULL,NULL,price_context,evidence || jsonb_build_object('written',true),at_price);
    SELECT coalesce(jsonb_agg(code ORDER BY n),'[]') INTO added
    FROM jsonb_array_elements_text(public.commerce_offer_policy_v2_readiness()->'reasons') WITH ORDINALITY r(code,n)
    WHERE NOT (readiness_before->'reasons' ? code) AND code<>'catalog_1490_legacy_1340_invalid';
    IF jsonb_array_length(added)>0 THEN
      RAISE EXCEPTION 'catalog_price_setup_readiness_would_fail' USING ERRCODE='55000', DETAIL=added::text;
    END IF;
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
