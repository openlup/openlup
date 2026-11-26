CREATE FUNCTION public.tax_calculation_adapter_money_v1(p_money jsonb, p_pin jsonb, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  position_shape CONSTANT jsonb := '{"positionRef":"ref","jurisdictionRef":"ref","taxableMinor":"minor","taxMinor":"minor","rateDecimal?":"rate"}';
  state_shape CONSTANT jsonb := '{"amountMinor":"minor","netMinor":"minor","taxMinor":"minor","totalMinor":"minor"}'
    || jsonb_build_object('taxPositions',jsonb_build_array(32,position_shape));
  allocation_shape CONSTANT jsonb := '{"adjustmentRef":"ref","sequence":"positive","basisReductionMinor":"positive",
    "beforeMinor":"minor","afterMinor":"minor","netReductionMinor":"minor","taxReductionMinor":"minor"}'
    || jsonb_build_object('before',state_shape,'after',state_shape);
  component_shape CONSTANT jsonb := jsonb_build_object('ref','component ref','initial',state_shape,'final',state_shape,
    'allocations',jsonb_build_array(256,allocation_shape));
  money_shape CONSTANT jsonb := '{"amountBasis":"exclusive","netTotal":"minor","taxTotal":"minor","feeTotal":"minor","payableMinor":"minor",
    "fees":[256,{"feeKey":"ref","amountMinor":"minor"}]}'::jsonb || jsonb_build_object('components',jsonb_build_array(512,component_shape));
  root_fields CONSTANT text[] := ARRAY['amountBasis','netTotal','taxTotal','feeTotal','payableMinor'];
  allocation_fields CONSTANT text[] := ARRAY['adjustmentRef','sequence','basisReductionMinor','netReductionMinor','taxReductionMinor'];
  request_input jsonb := p_pin#>'{request,input}';
  plan jsonb := request_input->'money';
  quote jsonb := p_body#>'{outcome,quote}';
  evidence jsonb := p_body#>'{evidence,adapterEvidence}';
  adapter_digest text := p_body#>>'{evidence,adapterDigest}';
  outcome_kind text := p_body#>>'{outcome,kind}';
  required_cells jsonb := request_input->'required';
  valid_shape boolean;
  money_text text;
  tax_evidence jsonb;
  fee_evidence jsonb;
  matches_projection boolean;
BEGIN
  -- A shape array stores its maximum length and a single element shape.
  -- Ref variants resolve before walking their fields so each variant stays closed.
  WITH RECURSIVE nodes(value, shape) AS (
    SELECT p_money, money_shape
    UNION ALL
    SELECT child.value, CASE child.shape WHEN '"component ref"'::jsonb THEN
      CASE child.value->>'kind'
        WHEN 'merchandise' THEN '{"kind":"string","lineKey":"ref","sourceOrdinal":"positive"}'::jsonb
        WHEN 'delivery' THEN '{"kind":"string","bucketKey":"ref"}'::jsonb
      END ELSE child.shape END
    FROM nodes CROSS JOIN LATERAL (
      SELECT e.value, coalesce(nodes.shape->e.key,nodes.shape->(e.key || '?')) AS shape
      FROM jsonb_each(CASE WHEN jsonb_typeof(nodes.shape)='object' AND jsonb_typeof(nodes.value)='object'
        THEN nodes.value ELSE '{}'::jsonb END) e
      WHERE right(e.key,1) <> '?'
      UNION ALL
      SELECT e.value, nodes.shape->1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(nodes.shape)='array' AND jsonb_typeof(nodes.value)='array'
        THEN CASE WHEN jsonb_array_length(nodes.value) <= (nodes.shape->>0)::integer THEN nodes.value END
        END) e
    ) child
  )
  SELECT NOT EXISTS (
    SELECT FROM nodes CROSS JOIN LATERAL (SELECT value #>> '{}' AS scalar) leaf
    WHERE (CASE jsonb_typeof(shape)
      WHEN 'object' THEN jsonb_typeof(value)='object'
        AND value ?& ARRAY(SELECT key FROM jsonb_object_keys(shape) key WHERE right(key,1) <> '?')
        AND NOT EXISTS (SELECT FROM jsonb_object_keys(CASE WHEN jsonb_typeof(value)='object' THEN value END) key
          WHERE right(key,1)='?')
      WHEN 'array' THEN CASE WHEN jsonb_typeof(value)='array' THEN jsonb_array_length(value) <= (shape->>0)::integer END
      WHEN 'string' THEN CASE shape #>> '{}'
        WHEN 'exclusive' THEN value='"exclusive"'::jsonb
        WHEN 'string' THEN jsonb_typeof(value)='string'
        WHEN 'ref' THEN public.catalog_publication_text_valid(value,128,false)
        WHEN 'rate' THEN CASE WHEN jsonb_typeof(value)='string'
          AND scalar COLLATE "C" ~ '^(0|[1-9][0-9]{0,9})([.][0-9]{1,6})?$'
          THEN scalar::numeric <= 9007199254.740991 END
        ELSE CASE WHEN jsonb_typeof(value)='number' AND value <= '9007199254740991'::jsonb
          THEN scalar::numeric = trunc(scalar::numeric)
            AND scalar::numeric >= CASE WHEN shape='"positive"'::jsonb THEN 1 ELSE 0 END END
      END
    END) IS DISTINCT FROM true
  ) INTO valid_shape;
  IF NOT valid_shape THEN RETURN NULL; END IF;

  money_text := public.catalog_publication_canonical(p_money,0);
  IF octet_length(convert_to(money_text,'UTF8')) > 1048576 THEN RETURN NULL; END IF;
  IF p_pin IS NULL AND p_body IS NULL THEN
    RETURN jsonb_build_object('moneyText',money_text,'resultDigest',NULL);
  END IF;

  IF p_pin->>'kind' IS DISTINCT FROM 'tax_calculation' OR p_body->>'kind' IS DISTINCT FROM 'tax_calculation'
    OR outcome_kind IS NULL OR outcome_kind NOT IN ('final','estimate')
    OR request_input->>'purpose' IS DISTINCT FROM outcome_kind OR evidence->>'status' IS DISTINCT FROM outcome_kind
    OR quote->>'status' IS DISTINCT FROM outcome_kind OR quote->'currency' IS DISTINCT FROM request_input->'currency'
    OR plan->>'amountBasis' IS DISTINCT FROM 'exclusive'
    OR (p_money - ARRAY['components','fees']) IS DISTINCT FROM
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(quote)='object' THEN quote END)
        WHERE key=ANY(root_fields))
    OR adapter_digest IS NULL OR adapter_digest COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR EXISTS (SELECT FROM (VALUES (plan->'sources'), (plan->'delivery'), (plan->'adjustments'), (required_cells),
      (quote->'lines'), (quote->'deliveryBuckets'), (quote->'feeLines'),
      (evidence#>'{positions,tax}'), (evidence#>'{positions,fees}')) arrays(value)
      WHERE jsonb_typeof(value) IS DISTINCT FROM 'array')
  THEN RETURN NULL; END IF;

  IF EXISTS (SELECT FROM jsonb_array_elements(plan->'adjustments') adjustment
      GROUP BY GROUPING SETS ((adjustment->'adjustmentRef'),(adjustment->'sequence')) HAVING count(*) > 1)
    OR EXISTS (SELECT FROM jsonb_array_elements(plan->'adjustments') adjustment
      WHERE EXISTS (SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(adjustment#>'{target,lineKeys}')='array'
        THEN adjustment#>'{target,lineKeys}' END) target GROUP BY target.value HAVING count(*) > 1))
    OR EXISTS (SELECT FROM jsonb_array_elements(required_cells) cell
      GROUP BY cell#>'{target,kind}',cell#>'{target,key}',cell->'jurisdiction',cell->'taxKind' HAVING count(*) > 1)
  THEN RETURN NULL; END IF;

  -- Index the evidence once and reject ambiguous assessment identities.
  SELECT coalesce(jsonb_object_agg(row->>'positionRef',row),'{}'::jsonb) INTO tax_evidence
  FROM jsonb_array_elements(evidence#>'{positions,tax}') row WHERE jsonb_typeof(row->'positionRef')='string';
  SELECT coalesce(jsonb_object_agg(row->>'feeKey',row),'{}'::jsonb) INTO fee_evidence
  FROM jsonb_array_elements(evidence#>'{positions,fees}') row WHERE jsonb_typeof(row->'feeKey')='string';
  IF (SELECT count(*) FROM jsonb_object_keys(tax_evidence)) <> jsonb_array_length(evidence#>'{positions,tax}')
    OR (SELECT count(*) FROM jsonb_object_keys(fee_evidence)) <> jsonb_array_length(evidence#>'{positions,fees}')
  THEN RETURN NULL; END IF;

  WITH
  pinned AS (
    SELECT row_number() OVER (ORDER BY source->'sourceOrdinal',ordinal) AS ordinal,
      jsonb_build_object('kind','merchandise','lineKey',source->'lineKey','sourceOrdinal',source->'sourceOrdinal') AS ref
    FROM jsonb_array_elements(plan->'sources') WITH ORDINALITY AS sources(source,ordinal)
    UNION ALL
    SELECT jsonb_array_length(plan->'sources') + ordinal,
      jsonb_build_object('kind','delivery','bucketKey',bucket->'bucketKey')
    FROM jsonb_array_elements(plan->'delivery') WITH ORDINALITY AS delivery(bucket,ordinal)
  ),
  quoted AS (
    SELECT ordinal, jsonb_build_object('kind','merchandise','lineKey',line->'lineKey','sourceOrdinal',line->'sourceOrdinal') AS ref,
      line AS part, true AS valid
    FROM jsonb_array_elements(quote->'lines') WITH ORDINALITY AS lines(line,ordinal)
    UNION ALL
    SELECT jsonb_array_length(quote->'lines') + ordinal, jsonb_build_object('kind','delivery','bucketKey',bucket->'bucketKey'),
      bucket#>'{parts,0}', CASE WHEN jsonb_typeof(bucket->'parts')='array' THEN
        jsonb_array_length(bucket->'parts')=1 AND NOT (bucket#>'{parts,0}' ? 'sourceOrdinal') END
    FROM jsonb_array_elements(quote->'deliveryBuckets') WITH ORDINALITY AS delivery(bucket,ordinal)
  ),
  components AS (
    SELECT m.component, m.ordinal, q.part, m.component->'ref' AS ref,
      p.ref AS pinned_ref, q.ref AS quoted_ref, q.valid
    FROM jsonb_array_elements(p_money->'components') WITH ORDINALITY AS m(component,ordinal)
    LEFT JOIN pinned p USING (ordinal) LEFT JOIN quoted q USING (ordinal)
  ),
  allocations AS (
    SELECT c.ordinal, c.ref, step.allocation, step.position,
      lag(step.allocation->'after',1,c.component->'initial') OVER (PARTITION BY c.ordinal ORDER BY step.position) AS previous,
      lag((step.allocation->>'sequence')::numeric,1,0::numeric) OVER (PARTITION BY c.ordinal ORDER BY step.position) AS previous_sequence,
      c.part->'discountAllocations'->(step.position::integer-1) AS projected
    FROM components c CROSS JOIN LATERAL jsonb_array_elements(c.component->'allocations') WITH ORDINALITY AS step(allocation,position)
  ),
  states AS (
    SELECT ref, component->'final' AS state, jsonb_build_object('basisMinor',part->'effectiveMinor',
      'netMinor',part->'netMinor','taxMinor',part->'taxMinor','taxPositions',part->'taxPositions') AS projected
    FROM components
    UNION ALL
    SELECT ref, stage.state, stage.projected FROM allocations CROSS JOIN LATERAL
      (VALUES (allocation->'before',projected->'before'),(allocation->'after',projected->'after')) stage(state,projected)
  ),
  positions AS (
    SELECT s.ref, pos.value, s.projected->'taxPositions'->(pos.ordinal::integer-1) AS projected,
      tax_evidence->(pos.value->>'positionRef') AS assessment
    FROM states s CROSS JOIN LATERAL jsonb_array_elements(s.state->'taxPositions') WITH ORDINALITY pos(value,ordinal)
  ),
  fees AS (
    SELECT fee, quote->'feeLines'->(ordinal::integer-1) AS projected, fee_evidence->(fee->>'feeKey') AS assessment
    FROM jsonb_array_elements(p_money->'fees') WITH ORDINALITY
      AS items(fee,ordinal)
  )
  SELECT jsonb_array_length(p_money->'components') = (SELECT count(*) FROM pinned)
    AND jsonb_array_length(p_money->'components') = (SELECT count(*) FROM quoted)
    AND jsonb_array_length(p_money->'fees') = jsonb_array_length(quote->'feeLines')
    AND (SELECT count(DISTINCT value->>'positionRef') FROM positions) = jsonb_array_length(evidence#>'{positions,tax}')
    AND (SELECT count(DISTINCT fee->>'feeKey') FROM fees) = jsonb_array_length(evidence#>'{positions,fees}')
    -- The projection joins bind the same unique line, ordinal and bucket keys to both context arrays.
    AND NOT EXISTS (SELECT FROM components WHERE ref->>'kind'='merchandise'
      GROUP BY GROUPING SETS ((ref->'lineKey'),(ref->'sourceOrdinal')) HAVING count(*) > 1)
    AND NOT EXISTS (SELECT FROM components WHERE ref->>'kind'='delivery' GROUP BY ref->'bucketKey' HAVING count(*) > 1)
    AND NOT EXISTS (SELECT FROM allocations GROUP BY ordinal,allocation->'adjustmentRef' HAVING count(*) > 1)
    AND NOT EXISTS (SELECT FROM allocations GROUP BY projected->'allocationId' HAVING count(*) > 1)
    AND NOT EXISTS (SELECT FROM positions GROUP BY value->'positionRef' HAVING count(DISTINCT ref) > 1)
    AND NOT EXISTS (SELECT FROM fees GROUP BY fee->'feeKey' HAVING count(*) > 1)
    AND NOT EXISTS (SELECT FROM components WHERE valid IS DISTINCT FROM true
      OR ref IS DISTINCT FROM pinned_ref OR ref IS DISTINCT FROM quoted_ref
      OR component#>'{initial,amountMinor}' IS DISTINCT FROM part->'preDiscountMinor'
      OR component#>'{final,totalMinor}' IS DISTINCT FROM part->'lineTotalMinor'
      OR component->'final' IS DISTINCT FROM coalesce(component#>'{allocations,-1,after}',component->'initial')
      OR jsonb_array_length(component->'allocations') IS DISTINCT FROM CASE
        WHEN jsonb_typeof(part->'discountAllocations')='array' THEN jsonb_array_length(part->'discountAllocations') END)
    AND NOT EXISTS (SELECT FROM allocations
      CROSS JOIN LATERAL (SELECT allocation->'before' AS before_state, allocation->'after' AS after_state) step
      WHERE allocation->'before' IS DISTINCT FROM previous
        OR (allocation->>'sequence')::numeric <= previous_sequence
        OR allocation->'beforeMinor' IS DISTINCT FROM before_state->'amountMinor'
        OR allocation->'afterMinor' IS DISTINCT FROM after_state->'amountMinor'
        OR (allocation->>'basisReductionMinor')::numeric <> (before_state->>'amountMinor')::numeric - (after_state->>'amountMinor')::numeric
        OR (allocation->>'netReductionMinor')::numeric <> (before_state->>'netMinor')::numeric - (after_state->>'netMinor')::numeric
        OR (allocation->>'taxReductionMinor')::numeric <> (before_state->>'taxMinor')::numeric - (after_state->>'taxMinor')::numeric
        OR EXISTS (SELECT FROM unnest(allocation_fields) field WHERE allocation->field IS DISTINCT FROM projected->field)
        OR NOT EXISTS (SELECT FROM jsonb_array_elements(plan->'adjustments') adjustment
          WHERE adjustment->'sequence'=allocation->'sequence' AND adjustment->'adjustmentRef'=allocation->'adjustmentRef'
            AND CASE ref->>'kind' WHEN 'merchandise' THEN adjustment#>'{target,lineKeys}' ? (ref->>'lineKey')
                ELSE adjustment#>'{target,bucketKey}'=ref->'bucketKey' END))
    AND NOT EXISTS (SELECT FROM states WHERE state->'amountMinor' IS DISTINCT FROM projected->'basisMinor'
      OR state->'netMinor' IS DISTINCT FROM projected->'netMinor' OR state->'taxMinor' IS DISTINCT FROM projected->'taxMinor'
      OR state->'amountMinor' <> state->'netMinor'
      OR (state->>'totalMinor')::numeric <> (state->>'netMinor')::numeric + (state->>'taxMinor')::numeric
      OR (state->>'taxMinor')::numeric <> (SELECT coalesce(sum((value->>'taxMinor')::numeric),0) FROM jsonb_array_elements(state->'taxPositions'))
      OR EXISTS (SELECT FROM jsonb_array_elements(state->'taxPositions') position GROUP BY position->'positionRef' HAVING count(*) > 1)
      OR jsonb_array_length(state->'taxPositions') IS DISTINCT FROM CASE
        WHEN jsonb_typeof(projected->'taxPositions')='array' THEN jsonb_array_length(projected->'taxPositions') END)
    AND NOT EXISTS (SELECT FROM positions WHERE assessment IS NULL
      OR value->'rateDecimal' IS DISTINCT FROM assessment->'ratePercent'
      OR value->'jurisdictionRef' IS DISTINCT FROM assessment#>'{cell,jurisdiction}'
      OR projected IS DISTINCT FROM value || (assessment - ARRAY['cell','ratePercent']) || jsonb_build_object(
        'level',assessment#>'{cell,level}','taxKind',assessment#>'{cell,taxKind}')
      OR NOT EXISTS (SELECT FROM jsonb_array_elements(required_cells) cell
        WHERE cell=assessment->'cell' AND CASE ref->>'kind'
          WHEN 'merchandise' THEN cell#>>'{target,kind}'='line' AND cell#>'{target,key}'=ref->'lineKey'
          ELSE cell#>>'{target,kind}'='delivery' AND cell#>'{target,key}'=ref->'bucketKey' END))
    AND NOT EXISTS (SELECT FROM fees WHERE assessment IS NULL
      OR projected IS DISTINCT FROM fee || (assessment - ARRAY['jurisdiction','scope'])
        || jsonb_build_object('jurisdictionRef',assessment->'jurisdiction',
          'scope',CASE assessment#>>'{scope,kind}' WHEN 'order' THEN '{"kind":"order"}'::jsonb
          WHEN 'delivery' THEN jsonb_build_object('kind','delivery','bucketKey',assessment#>'{scope,key}') END)
      OR NOT EXISTS (SELECT FROM jsonb_array_elements(required_cells) cell
        WHERE cell#>>'{target,kind}'='fee' AND cell#>'{target,key}'=fee->'feeKey'
          AND cell->'jurisdiction'=assessment->'jurisdiction' AND cell->'taxKind'=assessment->'feeKind'
          AND assessment->'scope'=CASE WHEN cell#>'{target,deliveryKey}' IS NULL THEN '{"kind":"order"}'::jsonb
            ELSE jsonb_build_object('kind','delivery','key',cell#>'{target,deliveryKey}') END))
    AND (SELECT coalesce(sum((component#>>'{final,netMinor}')::numeric),0) FROM components) = (p_money->>'netTotal')::numeric
    AND (SELECT coalesce(sum((component#>>'{final,taxMinor}')::numeric),0) FROM components) = (p_money->>'taxTotal')::numeric
    AND (SELECT coalesce(sum((fee->>'amountMinor')::numeric),0) FROM fees) = (p_money->>'feeTotal')::numeric
    AND (p_money->>'payableMinor')::numeric = (p_money->>'netTotal')::numeric + (p_money->>'taxTotal')::numeric + (p_money->>'feeTotal')::numeric
  INTO matches_projection;
  IF matches_projection IS DISTINCT FROM true THEN RETURN NULL; END IF;

  BEGIN
    IF adapter_digest IS DISTINCT FROM public.tax_calculation_hash_v1('evidence',evidence) THEN RETURN NULL; END IF;
  EXCEPTION WHEN invalid_parameter_value OR check_violation THEN
    RETURN NULL;
  END;
  RETURN jsonb_build_object('moneyText',money_text,'resultDigest',public.tax_calculation_hash_v1('adapter-result-seal',
    jsonb_build_array(outcome_kind,encode(sha256(convert_to(money_text,'UTF8')),'hex'),adapter_digest)));
END;
$$;

REVOKE ALL ON FUNCTION public.tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_adapter_money_v1(jsonb,jsonb,jsonb) FROM service_role;';
END IF; END; $$;
