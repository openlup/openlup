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
  with_observations boolean := jsonb_typeof(p_targets)='object';
  sku_id uuid;
  explicit_subscription boolean;
  needs_subscription boolean;
  reason text;
  current_entry jsonb;
  current_start timestamptz;
  base_count integer;
  base_minor integer;
  subscription_count integer;
  subscription_valid boolean;
  subscription_ready boolean;
  wrong_kind_count integer;
  wrong_base_shape boolean;
  wrong_subscription_shape boolean;
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
  -- The owner requests a structured observation packet. Array calls keep the landed result shape.
  FOR target IN SELECT value FROM jsonb_array_elements(CASE WHEN with_observations THEN p_targets->'targets' ELSE p_targets END) LOOP
    sku_id := (target->>'skuId')::uuid;
    operation := nullif(target->'operation','null'::jsonb);
    explicit_subscription := coalesce((target->'requiredModes') ? 'subscription', false);
    needs_subscription := explicit_subscription
      OR (target #>> '{skuFacts,status}'='active' AND target #> '{skuFacts,isAddon}'='false'::jsonb
        AND (target #> '{skuFacts,sellableStandalone}'='true'::jsonb
          OR target #> '{skuFacts,sellableInSubscription}'='true'::jsonb)) IS TRUE;
    SELECT count(*) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      min(e.unit_price_minor) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      (jsonb_agg(jsonb_build_object('entryId', e.id, 'unitPriceMinor', e.unit_price_minor, 'amountKind', e.amount_kind))
        FILTER (WHERE e.mode='one_time' AND e.min_qty=1))->0,
      min(e.valid_from) FILTER (WHERE e.mode='one_time' AND e.min_qty=1),
      count(*) FILTER (WHERE e.mode='subscription'),
      bool_and(e.min_qty=1 AND e.unit_price_minor>0) FILTER (WHERE e.mode='subscription'),
      count(*) FILTER (WHERE e.mode IN ('one_time','any') AND e.amount_kind<>kind),
      bool_or(e.mode='any' OR (e.mode='one_time' AND e.min_qty<>1)),
      bool_or(e.mode='subscription' AND (e.min_qty<>1 OR e.amount_kind<>kind))
    INTO base_count, base_minor, current_entry, current_start, subscription_count, subscription_valid,
      wrong_kind_count, wrong_base_shape, wrong_subscription_shape
    FROM public.price_entries e
    WHERE e.price_list_id=list_id AND e.variant_id=sku_id AND e.active
      AND e.valid_from<=p_at AND (e.valid_to IS NULL OR e.valid_to>p_at)
      AND (e.mode IN ('one_time','any') OR (needs_subscription AND e.mode='subscription'));
    wrong_shape := wrong_base_shape OR wrong_subscription_shape;

    reason := CASE
      WHEN operation IS NOT NULL AND operation->>'priceListId' IS DISTINCT FROM list_id::text THEN 'price_list_not_active'
      WHEN operation IS NOT NULL AND (operation->>'expectedListAmountBasis' IS DISTINCT FROM basis
        OR operation->>'amountKind' IS DISTINCT FROM kind) THEN 'catalog_price_setup_basis_mismatch'
      WHEN wrong_kind_count>0 THEN 'base_price_amount_kind_invalid'
      -- Only the decision owner consumes the inferred subscription diagnosis.
      WHEN wrong_shape AND with_observations AND NOT explicit_subscription AND NOT wrong_base_shape
        THEN 'subscription_price_shape_invalid'
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
    subscription_ready := NOT needs_subscription;
    IF needs_subscription AND (reason IS NULL OR with_observations) THEN
      SELECT count(*),count(*) FILTER (WHERE w.effective),bool_and(p.rounding_rule='FLOOR_TO_QUANTUM'
        AND p.rounding_quantum_minor>0 AND p.discount_bps BETWEEN 0 AND 10000
        AND p.digest=public.catalog_price_setup_policy_digest(p.id,p.revision_no,p.price_list_id,p.region_code,p.currency,p.channel,
          p.effective_from,CASE WHEN p.closed_from_open THEN NULL ELSE p.effective_to END,p.discount_bps,p.rounding_quantum_minor,p.rounding_rule))
        FILTER (WHERE w.effective), min(p.discount_bps) FILTER (WHERE w.effective), min(p.rounding_quantum_minor) FILTER (WHERE w.effective)
      INTO history_count,policy_count,policy_valid,discount,quantum
      FROM public.subscription_price_policy_revisions p
      CROSS JOIN LATERAL (SELECT p.effective_from<=p_at AND (p.effective_to IS NULL OR p.effective_to>p_at) AS effective) w
      WHERE p.price_list_id=list_id AND p.region_code=region AND p.currency=settlement_currency AND p.channel='D2C';
      subscription_ready := coalesce((history_count=0 AND subscription_count=1 AND subscription_valid)
        OR (history_count>0 AND policy_count=1 AND policy_valid AND subscription_count=0
          AND CASE WHEN quantum>0 THEN coalesce((operation->>'unitPriceMinor')::bigint,base_minor)
            *(10000-discount)/10000/quantum*quantum END>0),false);
      IF reason IS NULL AND NOT subscription_ready THEN reason := 'catalog_publication_sku_price_not_ready'; END IF;
    END IF;
    results := results || jsonb_build_array(jsonb_build_object('skuId',sku_id,'reason',reason,'previous',current_entry)
      || CASE WHEN with_observations THEN jsonb_build_object('observations',jsonb_build_object(
        'baseCount',base_count,'wrongKindCount',wrong_kind_count,'wrongShape',wrong_shape,
        'currentStart',current_start,'subscriptionReady',subscription_ready)) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN jsonb_build_object('priceListId',list_id,'regionCode',region,'currency',settlement_currency,'amountBasis',basis,'targets',results);
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_decide_prices_v2(p_previous_facts jsonb, p_next_facts jsonb,
  p_saved_operations jsonb, p_saved_context jsonb, p_observed_evidence jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  lane text := p_observed_evidence->>'lane';
  plan jsonb := p_observed_evidence->'plan';
  actor uuid := (p_observed_evidence->>'actor')::uuid;
  issue_id uuid := (p_observed_evidence->>'issueId')::uuid;
  claims jsonb := p_observed_evidence->'claims';
  receipt_locks jsonb := p_observed_evidence->'receiptLocks';
  written boolean := coalesce((p_observed_evidence->>'written')::boolean,false);
  mutations jsonb := '[]';
  targets jsonb := '[]';
  target jsonb;
  operation jsonb;
  actual jsonb;
  observations jsonb;
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
  subscription_shape boolean;
  subscription_shape_refusal boolean;
  replay_failed boolean;
  completed boolean;
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
        THEN '["one_time","subscription"]'::jsonb ELSE '["one_time"]'::jsonb END,
      'skuFacts',jsonb_build_object('status',p_observed_evidence #> '{sku,status}',
        'isAddon',p_observed_evidence #> '{sku,is_addon}',
        'sellableStandalone',p_observed_evidence #> '{sku,sellable_standalone}',
        'sellableInSubscription',p_observed_evidence #> '{sku,sellable_in_subscription}'));
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
        WHEN lane='reader' AND (receipt_locks->(operation->>'commandKey') IS DISTINCT FROM 'true'::jsonb OR NOT FOUND)
          THEN 'catalog_publication_price_issue_required'
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

    -- Keep the released plan bytes. Resolve private verdict facts from the
    -- assessment seal, the staged/inherited revisions, or the exact issue.
    SELECT public.catalog_publication_target_price_verdict(jsonb_build_object('targets',coalesce(jsonb_agg(
      (CASE WHEN NOT written AND (lane='assessment' AND r.idempotency_key IS NULL
        OR claims #>> ARRAY[t #>> '{operation,commandKey}','outcome']='claimed') THEN t
        ELSE t-'operation' END) || CASE WHEN sku.facts IS NULL THEN '{}'::jsonb ELSE
        jsonb_build_object('skuFacts',jsonb_build_object('status',sku.facts->'status',
          'isAddon',sku.facts->'isAddon','sellableStandalone',sku.facts->'sellableStandalone',
          'sellableInSubscription',sku.facts->'sellableInSubscription')) END ORDER BY n),'[]')),p_at)
    INTO verdict
    FROM jsonb_array_elements(plan) WITH ORDINALITY AS item(t,n)
    LEFT JOIN public.catalog_price_setup_receipts r ON r.scope='catalog.price_setup.base' AND r.idempotency_key=t #>> '{operation,commandKey}'
    CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(t->>'skuId','uuid') THEN (t->>'skuId')::uuid END AS id) target_sku
    CROSS JOIN LATERAL (SELECT CASE
      WHEN jsonb_typeof(p_next_facts->'skus')='array' THEN (
        SELECT f FROM jsonb_array_elements(p_next_facts->'skus') f WHERE f->'id'=t->'skuId' LIMIT 1)
      WHEN p_next_facts IS NULL AND lane IN ('issuance','reader') AND issue_id IS NOT NULL THEN coalesce(
        (SELECT s.full_facts::jsonb FROM public.catalog_sku_revisions s
          WHERE lane='issuance' AND (s.publication_id,s.sku_id)=(issue_id,target_sku.id)),
        (SELECT public.catalog_publication_read_sku_revision(p.product_id,ref)
          FROM public.catalog_publications p
          CROSS JOIN LATERAL jsonb_array_elements(p.canonical_state::jsonb->'skus') ref
          WHERE p.id=CASE WHEN lane='reader' THEN issue_id ELSE (
            SELECT h.publication_id FROM public.catalog_skus s
            JOIN public.catalog_publication_heads h ON h.product_id=s.product_id WHERE s.id=target_sku.id) END
          AND ref->'skuId'=t->'skuId'))
      END AS facts) sku;
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
      completed := NOT fresh OR written;
      replay_failed := false;
      observations := actual->'observations';
      wrong_kind := (observations->>'wrongKindCount')::integer>0;
      IF NOT completed THEN
        IF lane='issuance' THEN
          mutations := mutations || jsonb_build_array(jsonb_build_object('claim',claims->(operation->>'commandKey'),
            'publication',jsonb_build_object('previous',actual->'previous','publicationId',issue_id)));
        END IF;
      ELSE
        observed_entry := actual->'previous';
        basis_matches := (operation->>'expectedListAmountBasis'=verdict->>'amountBasis'
          AND operation->>'amountKind'=CASE verdict->>'amountBasis' WHEN 'tax_exclusive' THEN 'net' ELSE 'gross' END) IS TRUE;
        possible_kind_drift := basis_matches AND observations->'baseCount'='1'::jsonb AND observations->'wrongKindCount'='1'::jsonb
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
      subscription_shape := actual->>'reason'='subscription_price_shape_invalid';
      IF subscription_shape THEN
        actual := jsonb_set(actual,'{reason}','"price_shape_invalid"');
      END IF;
      targets := targets || jsonb_build_array(actual-'observations');
      -- Completed receipts use row observations and receipt proof to select the refusal.
      SELECT reason,ord INTO price_reason,rank FROM unnest(ARRAY[
        'price_list_not_active','catalog_price_setup_basis_mismatch','base_price_amount_kind_invalid',
        'price_shape_invalid','base_price_ambiguous','catalog_price_setup_pending_entry',
        'catalog_publication_price_changed','catalog_publication_sku_price_not_ready']) WITH ORDINALITY AS ranked(reason,ord)
      WHERE (NOT completed AND (reason=actual->>'reason'
        OR (reason='catalog_publication_price_changed' AND actual->>'reason'='expected_state_mismatch')))
        OR (completed AND CASE reason
          WHEN 'base_price_amount_kind_invalid' THEN wrong_kind
          WHEN 'price_shape_invalid' THEN (observations->>'wrongShape')::boolean
          WHEN 'catalog_publication_price_changed' THEN replay_failed OR (observations->>'baseCount')::integer>1
          WHEN 'catalog_publication_sku_price_not_ready' THEN (observations->>'baseCount')::integer=0
            OR (actual #>> '{previous,unitPriceMinor}')::integer<=0 OR NOT (observations->>'subscriptionReady')::boolean
        END)
      ORDER BY ord LIMIT 1;
      IF rank<best_rank THEN
        best_rank := rank;
        refusal := price_reason;
        subscription_shape_refusal := subscription_shape AND price_reason='price_shape_invalid';
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
  IF subscription_shape_refusal THEN
    field := 'Effective subscription entry';
    remedy := 'Have the pricing configuration owner end the conflicting entry and configure a compatible entry for this SKU and mode, or switch the context to a separate, correctly configured list. When the effective subscription policy already derives a positive price, ending the conflicting subscription entry is sufficient.';
  END IF;
  IF lane<>'assessment' THEN
    RAISE EXCEPTION '%',refusal USING ERRCODE=state, CONSTRAINT=refusal, DETAIL=field, HINT=remedy;
  END IF;
  RETURN jsonb_build_object('outcome','blocked-input','reason',refusal,'sqlstate',state,'field',field,'remedy',remedy,
    'pair',CASE WHEN selected IS NOT NULL THEN jsonb_build_object('skuId',selected->'skuId','priceListId',selected->'priceListId') END);
END;
$$;
