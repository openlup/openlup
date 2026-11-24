-- Private basis-aware price setup. The existing authenticated entry stays dormant
-- for v2 until both publication capabilities are effective.
CREATE FUNCTION public.catalog_price_setup_v2_command_valid(p_operation jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_operation)='object' AND jsonb_typeof(prior)='object' THEN
  (p_operation - ARRAY['schemaVersion','commandKey','variantId','priceListId','mode','minQty','amountKind',
     'unitPriceMinor','expectedListAmountBasis','expected'] = '{}'::jsonb
   AND p_operation->'schemaVersion' = '2'::jsonb AND p_operation->'mode' = '"one_time"'::jsonb
   AND p_operation->'minQty' = '1'::jsonb
   AND jsonb_typeof(p_operation->'commandKey') = 'string'
   AND char_length(key)+(SELECT count(*) FROM regexp_split_to_table(key,'') ch WHERE octet_length(ch)=4) BETWEEN 1 AND 240
   AND key = btrim(key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
   AND p_operation->>'variantId' COLLATE "C" ~ uuid_shape AND p_operation->>'priceListId' COLLATE "C" ~ uuid_shape
   AND p_operation->'amountKind' IN ('"gross"'::jsonb,'"net"'::jsonb)
   AND p_operation->'expectedListAmountBasis' IN ('"tax_inclusive"'::jsonb,'"tax_exclusive"'::jsonb)
   AND amount BETWEEN 1 AND 2147483647 AND amount=trunc(amount)
   AND prior - ARRAY['entryId','unitPriceMinor','amountKind']='{}'::jsonb
   AND ((prior->'entryId',prior->'unitPriceMinor',prior->'amountKind')=('null'::jsonb,'null'::jsonb,'null'::jsonb)
     OR (prior->>'entryId' COLLATE "C" ~ uuid_shape AND prior->'amountKind' IN ('"gross"'::jsonb,'"net"'::jsonb)
       AND previous BETWEEN 0 AND 2147483647 AND previous=trunc(previous)))) IS TRUE ELSE false END
 FROM (SELECT p_operation->'expected' AS prior, p_operation->>'commandKey' AS key,
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS uuid_shape) field
 CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(p_operation->'unitPriceMinor')='number'
   THEN (p_operation->>'unitPriceMinor')::numeric END AS amount,
   CASE WHEN jsonb_typeof(prior->'unitPriceMinor')='number' THEN (prior->>'unitPriceMinor')::numeric END AS previous) money
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_v2_command_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_price_basis_gate(p_reason text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE publication_role oid;
BEGIN
  SELECT oid INTO publication_role FROM pg_catalog.pg_roles WHERE rolname = 'openlup_catalog_publication';
  IF publication_role IS NOT NULL THEN
    IF pg_catalog.has_function_privilege(publication_role,
        pg_catalog.to_regprocedure('public.catalog_price_setup_apply_v2(text,text,uuid)')::oid, 'EXECUTE')
      AND pg_catalog.has_function_privilege(publication_role,
        pg_catalog.to_regprocedure('public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)')::oid, 'EXECUTE') THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', p_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_basis_gate(text) FROM PUBLIC;

-- All targets share settlement, list and clock. A proposed edit participates
-- in readiness without changing rows; the predecessor always comes from storage.
CREATE FUNCTION public.catalog_publication_target_price_verdict(p_targets jsonb, p_at timestamptz) RETURNS jsonb
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
  sku_id uuid;
  needs_subscription boolean;
  reason text;
  current_entry jsonb;
  current_start timestamptz;
  base_count integer;
  base_minor integer;
  subscription_count integer;
  subscription_valid boolean;
  wrong_kind boolean;
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
    needs_subscription := coalesce((target->'requiredModes') ? 'subscription', false);
    SELECT count(*) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      min(e.unit_price_minor) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      (jsonb_agg(jsonb_build_object('entryId', e.id, 'unitPriceMinor', e.unit_price_minor, 'amountKind', e.amount_kind))
        FILTER (WHERE e.mode='one_time' AND e.min_qty=1))->0,
      min(e.valid_from) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      count(*) FILTER (WHERE e.mode='subscription'),
      bool_and(e.min_qty=1 AND e.unit_price_minor>0) FILTER (WHERE e.mode='subscription'),
      bool_or(e.mode IN ('one_time','any') AND e.amount_kind<>kind),
      bool_or(e.mode='any' OR e.min_qty<>1 OR (e.mode='subscription' AND e.amount_kind<>kind))
    INTO base_count, base_minor, current_entry, current_start, subscription_count, subscription_valid, wrong_kind, wrong_shape
    FROM public.price_entries e
    WHERE e.price_list_id=list_id AND e.variant_id=sku_id AND e.active
      AND e.valid_from<=p_at AND (e.valid_to IS NULL OR e.valid_to>p_at)
      AND (e.mode IN ('one_time','any') OR (needs_subscription AND e.mode='subscription'));

    reason := CASE
      WHEN operation IS NOT NULL AND operation->>'priceListId' IS DISTINCT FROM list_id::text THEN 'price_list_not_active'
      WHEN operation IS NOT NULL AND (operation->>'expectedListAmountBasis' IS DISTINCT FROM basis
        OR operation->>'amountKind' IS DISTINCT FROM kind) THEN 'catalog_price_setup_basis_mismatch'
      WHEN wrong_kind THEN 'base_price_amount_kind_invalid'
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
    results := results || jsonb_build_array(jsonb_build_object('skuId',sku_id,'reason',reason,'previous',current_entry));
  END LOOP;
  RETURN jsonb_build_object('priceListId',list_id,'regionCode',region,'currency',settlement_currency,'amountBasis',basis,'targets',results);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_target_price_verdict(jsonb,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_price_setup_claim(p_canonical_command text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid;
  v_command jsonb;
  v_expected jsonb;
  v_key text;
  v_gate jsonb;
  v_amount_issue text;
  v_range_probe jsonb;
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
  IF v_command->'schemaVersion' = '2'::jsonb THEN
    v_gate := public.catalog_price_basis_gate('command_invalid');
    IF v_gate IS NOT NULL THEN RETURN v_gate; END IF;
    v_range_probe := v_command;
    IF jsonb_typeof(v_command->'unitPriceMinor')='number'
      AND (v_command->>'unitPriceMinor')::numeric NOT BETWEEN 1 AND 2147483647 THEN
      v_range_probe := jsonb_set(v_range_probe,'{unitPriceMinor}','1');
      v_amount_issue := 'unitPriceMinor';
    END IF;
    IF jsonb_typeof(v_command #> '{expected,unitPriceMinor}')='number'
      AND (v_command #>> '{expected,unitPriceMinor}')::numeric NOT BETWEEN 0 AND 2147483647 THEN
      v_range_probe := jsonb_set(v_range_probe,'{expected,unitPriceMinor}','0');
      v_amount_issue := coalesce(v_amount_issue,'expected.unitPriceMinor');
    END IF;
    BEGIN
      IF public.catalog_price_setup_v2_command_valid(v_range_probe)
        AND convert_to(public.catalog_publication_canonical(v_command,0),'UTF8') = convert_to(p_canonical_command,'UTF8') THEN
        IF v_amount_issue IS NOT NULL THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','money_amount_out_of_range','path',v_amount_issue);
        END IF;
      ELSE
        RETURN '{"outcome":"validation_issue","reason":"command_invalid"}'::jsonb;
      END IF;
    EXCEPTION WHEN invalid_parameter_value OR check_violation THEN
      RETURN '{"outcome":"validation_issue","reason":"command_invalid"}'::jsonb;
    END;
  ELSE
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

CREATE OR REPLACE FUNCTION public.catalog_price_setup_apply_claimed(p_claim jsonb, p_at timestamptz) RETURNS jsonb
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

  IF v_is_v2 THEN
    PERFORM public.catalog_price_setup_lock_context(v_list_id, v_variant_id);
    LOCK TABLE public.commerce_settings, public.price_lists, public.subscription_price_policy_revisions IN SHARE MODE NOWAIT;
    LOCK TABLE public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    PERFORM 1 FROM public.price_entries
      WHERE price_list_id=v_list_id AND variant_id=v_variant_id ORDER BY id FOR NO KEY UPDATE NOWAIT;
    v_now := coalesce(p_at, clock_timestamp());
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
      CASE WHEN v_sku.sellable_in_subscription THEN '["one_time","subscription"]'::jsonb ELSE '["one_time"]'::jsonb END);
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

-- The publication login can replay here. The recorder reserves and applies its
-- verified batch through the owner-only claim and apply_claimed primitives.
CREATE FUNCTION public.catalog_price_setup_apply_v2(p_canonical_command text, p_fingerprint text, p_approval_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid;
  v_command jsonb;
  v_claim jsonb;
  v_gate jsonb;
  v_saved public.catalog_price_setup_receipts%ROWTYPE;
BEGIN
  IF p_approval_id IS NULL AND session_user <> 'openlup_catalog_publication'
    AND current_setting('role') <> 'openlup_catalog_publication' THEN
    v_claim := public.catalog_price_setup_claim(p_canonical_command,p_fingerprint);
    IF v_claim->>'outcome' <> 'claimed' THEN RETURN v_claim; END IF;
    IF (p_canonical_command::jsonb)->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN
      RAISE EXCEPTION 'catalog_price_setup_claim_mismatch' USING ERRCODE='55000';
    END IF;
    RETURN public.catalog_price_setup_apply_claimed(v_claim,NULL);
  END IF;

  v_actor := public.catalog_price_setup_require_human_admin();
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 4096
    OR p_fingerprint IS NULL OR encode(sha256(convert_to(p_canonical_command,'UTF8')),'hex') <> p_fingerprint THEN
    RETURN '{"outcome":"validation_issue","reason":"command_fingerprint_invalid"}'::jsonb;
  END IF;
  v_gate := public.catalog_price_basis_gate('command_invalid');
  IF v_gate IS NOT NULL THEN RETURN v_gate; END IF;
  BEGIN
    v_command := p_canonical_command::jsonb;
  EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR numeric_value_out_of_range THEN
    RETURN '{"outcome":"validation_issue","reason":"command_invalid"}'::jsonb;
  END;
  IF NOT public.catalog_price_setup_v2_command_valid(v_command) THEN
    RETURN '{"outcome":"validation_issue","reason":"command_invalid"}'::jsonb;
  END IF;
  SELECT * INTO v_saved FROM public.catalog_price_setup_receipts
  WHERE scope='catalog.price_setup.base' AND idempotency_key=v_command->>'commandKey';
  IF NOT FOUND THEN
    RETURN '{"outcome":"validation_issue","reason":"catalog_publication_price_issue_required"}'::jsonb;
  ELSIF v_saved.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RETURN '{"outcome":"conflict","reason":"command_key_reused"}'::jsonb;
  ELSIF v_saved.status <> 'completed' THEN
    RETURN '{"outcome":"conflict","reason":"command_in_progress"}'::jsonb;
  ELSIF v_saved.metadata->>'actorId' IS DISTINCT FROM v_actor::text THEN
    RETURN '{"outcome":"unauthorized","reason":"operator_mismatch"}'::jsonb;
  END IF;
  RETURN v_saved.response_payload || '{"outcome":"replayed"}'::jsonb;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_apply_v2(text,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_price_setup_apply(p_canonical_command text, p_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_claim jsonb;
  v_is_v2 boolean;
BEGIN
  -- Identify the dispatch version only. Claim still owns the original identity,
  -- exact-byte fingerprint and validation precedence.
  IF octet_length(p_canonical_command) BETWEEN 2 AND 4096 THEN
    BEGIN
      v_is_v2 := (p_canonical_command::jsonb)->'schemaVersion' = '2'::jsonb;
    EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR numeric_value_out_of_range THEN
      v_is_v2 := false;
    END;
  END IF;
  IF v_is_v2 THEN RETURN public.catalog_price_setup_apply_v2(p_canonical_command,p_fingerprint,NULL); END IF;
  v_claim := public.catalog_price_setup_claim(p_canonical_command, p_fingerprint);
  IF v_claim->>'outcome' <> 'claimed' THEN RETURN v_claim; END IF;
  RETURN public.catalog_price_setup_apply_claimed(v_claim, v_now);
END;
$$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_price_setup_v2_command_valid(jsonb), public.catalog_price_basis_gate(text) TO service_role;';
END IF; END; $$;
