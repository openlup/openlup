CREATE FUNCTION public.commerce_read_paid_order_money_v2(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  snapshot public.commerce_order_tax_snapshots%ROWTYPE;
  intent public.commerce_settlement_intents%ROWTYPE;
  transition public.commerce_settlement_transitions%ROWTYPE;
  truth public.payment_truth_events%ROWTYPE;
  captures bigint;
  successes bigint;
  source_kind text;
  binding record;
  issued_body jsonb;
  mismatch constant jsonb := '{"kind":"refused","code":"paid_order_money_capture_mismatch"}';
  capture_mismatch constant jsonb := mismatch || '{"field":"/captureEvidenceRef"}';
BEGIN
  SELECT s.* INTO snapshot FROM public.commerce_orders o
    LEFT JOIN public.commerce_order_tax_snapshots s ON s.order_id=o.id
    WHERE o.id=p_order_id AND o.money_version IS NOT NULL;
  IF snapshot.order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT i.* INTO intent FROM public.commerce_settlement_intents i WHERE i.order_id=p_order_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.count(*) INTO captures FROM public.payment_truth_events t
    WHERE t.settlement_intent_id=intent.id AND t.state='settled' AND t.outcome='captured';
  SELECT pg_catalog.count(*) INTO successes FROM public.commerce_settlement_transitions t
    WHERE t.intent_id=intent.id AND t.outcome='succeeded';
  IF captures=0 AND successes=0 AND intent.status<>'settled' THEN
    RETURN NULL;
  END IF;
  IF successes<>1 OR intent.status<>'settled' THEN
    RETURN capture_mismatch;
  END IF;

  SELECT t.* INTO transition FROM public.commerce_settlement_transitions t
    WHERE t.intent_id=intent.id AND t.outcome='succeeded';
  SELECT t.* INTO truth FROM public.payment_truth_events t
    WHERE t.settlement_intent_id=intent.id AND t.state='settled' AND t.outcome='captured'
      AND t.id::text=transition.payload->>'paymentTruthEventId' AND t.settlement_transition_id=transition.id;
  IF NOT FOUND OR transition.payload->'sourceEvidence' IS DISTINCT FROM truth.source_evidence THEN
    RETURN capture_mismatch;
  END IF;

  -- Route comes from the named truth, since sandbox can co-settle other observations.
  source_kind := truth.source_evidence->>'sourceKind';
  IF (pg_catalog.starts_with(truth.source_event_id,'provider:') AND
      source_kind IN ('accepted_event','reconciliation_read')) IS NOT TRUE THEN
    RETURN mismatch || '{"field":"/captureRoute"}';
  END IF;
  IF captures<>1 OR truth.source_event_id IS DISTINCT FROM 'provider:' || (truth.source_evidence->>'sourceReference') THEN
    RETURN capture_mismatch;
  END IF;

  SELECT e.id,e.payment_attempt_id,e.provider,e.provider_payment_id,e.event_type,e.event_fingerprint,
    e.captured_amount_basis,e.received_via,e.signature_verified,e.source_evidence,e.amount_minor,e.currency,
    a.settlement_intent_id AS attempt_intent,a.provider AS attempt_provider,a.provider_attempt_id,a.provider_session_id
    INTO binding
    FROM (VALUES (truth.source_evidence->>'sourceReference')) AS origin(ref)
    LEFT JOIN public.payment_provider_attempt_evidence e ON e.id::text=origin.ref AND e.settlement_intent_id=intent.id
    LEFT JOIN public.payment_provider_attempts a ON a.id=e.payment_attempt_id;
  IF binding.id IS NULL OR binding.payment_attempt_id IS NULL
    OR binding.payment_attempt_id::text IS DISTINCT FROM truth.source_evidence->>'attemptRef'
    OR binding.event_type IS DISTINCT FROM 'payment.succeeded'
    OR binding.captured_amount_basis IS DISTINCT FROM 'provider_capture_v1'
    OR binding.event_fingerprint IS NULL OR binding.event_fingerprint IS DISTINCT FROM truth.source_evidence->>'payloadFingerprint'
    OR binding.attempt_intent IS DISTINCT FROM intent.id OR binding.provider IS DISTINCT FROM binding.attempt_provider
    OR binding.provider_payment_id IS NULL
    OR (CASE source_kind
      WHEN 'accepted_event' THEN binding.provider_payment_id=binding.provider_attempt_id
        AND binding.signature_verified AND binding.received_via<>'reconciliation_read.v1'
      ELSE binding.provider_payment_id IN (binding.provider_attempt_id,binding.provider_session_id)
        AND binding.received_via='reconciliation_read.v1' AND binding.signature_verified IS NULL
    END) IS NOT TRUE THEN
    RETURN capture_mismatch;
  END IF;

  -- JSON observations stay text until both the zoned wire grammar and PostgreSQL input accept them.
  IF EXISTS (
    SELECT FROM (
      SELECT truth.source_evidence->>'observedAt' AS at
      UNION ALL
      SELECT binding.source_evidence->>'observedAt' WHERE source_kind='reconciliation_read'
    ) observation
    WHERE (CASE WHEN observation.at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      AND pg_catalog.pg_input_is_valid(observation.at,'timestamptz') THEN observation.at::timestamptz END)
      IS DISTINCT FROM truth.occurred_at
  ) THEN
    RETURN capture_mismatch;
  END IF;
  IF truth.amount_minor IS DISTINCT FROM snapshot.payable_minor
    OR intent.amount_minor IS DISTINCT FROM snapshot.payable_minor
    OR binding.amount_minor IS DISTINCT FROM snapshot.payable_minor THEN
    RETURN mismatch || '{"field":"/paidMinor"}';
  END IF;
  IF truth.currency_code IS DISTINCT FROM snapshot.currency
    OR intent.currency_code IS DISTINCT FROM snapshot.currency
    OR binding.currency IS DISTINCT FROM snapshot.currency THEN
    RETURN mismatch || '{"field":"/currency"}';
  END IF;

  IF NOT snapshot.destination_erased THEN
    issued_body := public.commerce_order_money_v2_live_body(p_order_id);
  ELSE
    -- Match the issued-body order and optional leaves using only the retained facts.
    WITH lines AS (
      SELECT * FROM public.commerce_order_line_sources WHERE order_id=p_order_id
    ), delivery AS (
      SELECT * FROM public.commerce_order_delivery_buckets WHERE order_id=p_order_id
    ), allocations AS (
      SELECT * FROM public.commerce_order_line_allocations WHERE order_id=p_order_id
    ), positions AS (
      SELECT * FROM public.commerce_order_tax_positions WHERE order_id=p_order_id
    ), fees AS (
      SELECT * FROM public.commerce_order_fee_lines WHERE order_id=p_order_id
    ), components AS (
      SELECT line_key AS ref, 0 AS part, source_rank AS rank, pre_discount_minor, effective_minor, net_minor, tax_minor,
        pg_catalog.jsonb_build_object('lineKey',line_key,'sourceOrdinal',source_ordinal,'sku',sku_code,'mode',mode,
          'quantity',quantity,'unitBasisMinor',unit_basis_minor,'taxClassKey',tax_class_key,'assignmentRef',assignment_ref) AS facts
      FROM lines
      UNION ALL
      SELECT p.bucket_key,p.part_no,p.part_no,p.pre_discount_minor,p.effective_minor,p.net_minor,p.tax_minor,
        pg_catalog.jsonb_build_object('sourceOrdinal',p.source_ordinal)
      FROM delivery p WHERE p.part_no>0
    ), position_sets AS (
      SELECT coalesce(line_key,bucket_key) AS ref,coalesce(part_no,0) AS part,allocation_slot AS slot,state_side AS side,
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('positionRef',position_ref,'jurisdictionRef',jurisdiction_ref,'level',level,
          'taxKind',tax_kind,'taxabilityReason',taxability_reason,'ruleRef',rule_ref,'resolutionDigest',resolution_digest,
          'providerLineRef',provider_line_ref,'rateDecimal',rate_decimal,'taxableMinor',taxable_minor,'taxMinor',tax_minor,
          'resolution',pg_catalog.jsonb_build_object('assignmentRef',assignment_ref,'policyRevision',policy_revision,
            'sourceRef',resolution_source_ref,'sourceDigest',resolution_source_digest,'effective',pg_catalog.jsonb_build_object(
              'from',CASE WHEN extract(year FROM effective_from AT TIME ZONE 'UTC')=-1 THEN '0000' ELSE
                  pg_catalog.to_char(effective_from AT TIME ZONE 'UTC','YYYY') END || pg_catalog.to_char(effective_from AT TIME ZONE 'UTC','-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'until',CASE WHEN extract(year FROM effective_until AT TIME ZONE 'UTC')=-1 THEN '0000' ELSE
                  pg_catalog.to_char(effective_until AT TIME ZONE 'UTC','YYYY') END || pg_catalog.to_char(effective_until AT TIME ZONE 'UTC','-MM-DD"T"HH24:MI:SS.MS"Z"'))))
          ORDER BY position_rank) AS body
      FROM positions GROUP BY 1,2,3,4
    ), states AS (
      SELECT ref,part,0 AS slot,'final' AS side,effective_minor AS basis,net_minor AS net,tax_minor AS tax FROM components
      UNION ALL
      SELECT coalesce(a.line_key,a.bucket_key),coalesce(a.part_no,0),a.sequence,s.side,s.basis,s.net,s.tax
      FROM allocations a CROSS JOIN LATERAL (VALUES
        ('before',a.before_basis_minor,a.before_net_minor,a.before_tax_minor),
        ('after',a.after_basis_minor,a.after_net_minor,a.after_tax_minor)) s(side,basis,net,tax)
    ), state_bodies AS (
      SELECT s.*,pg_catalog.jsonb_build_object('basisMinor',s.basis,'netMinor',s.net,'taxMinor',s.tax,
        'taxPositions',coalesce(p.body,'[]')) AS body
      FROM states s LEFT JOIN position_sets p USING (ref,part,slot,side)
    ), allocation_steps AS (
      SELECT b.ref,b.part,a.sequence,
        pg_catalog.jsonb_build_object('allocationId',a.allocation_id,'adjustmentRef',a.adjustment_ref,'sequence',a.sequence,
          'source','legacy_promotion','basisReductionMinor',a.basis_reduction_minor,'netReductionMinor',a.net_reduction_minor,
          'taxReductionMinor',a.tax_reduction_minor,'evidenceRef',a.evidence_ref,'before',b.body,'after',z.body) AS body
      FROM allocations a
      JOIN state_bodies b ON (b.ref,b.part,b.slot,b.side)=(coalesce(a.line_key,a.bucket_key),coalesce(a.part_no,0),a.sequence,'before')
      JOIN state_bodies z ON (z.ref,z.part,z.slot,z.side)=(b.ref,b.part,b.slot,'after')
    ), allocation_sets AS (
      SELECT ref,part,pg_catalog.jsonb_agg(body ORDER BY sequence) AS body FROM allocation_steps GROUP BY ref,part
    ), component_bodies AS (
      SELECT c.*,c.facts || s.body - 'basisMinor' || pg_catalog.jsonb_build_object('preDiscountMinor',c.pre_discount_minor,
        'effectiveMinor',c.effective_minor,'lineTotalMinor',c.net_minor::numeric+c.tax_minor,
        'discountAllocations',coalesce(a.body,'[]')) AS body
      FROM components c JOIN state_bodies s ON (s.ref,s.part,s.slot)=(c.ref,c.part,0)
      LEFT JOIN allocation_sets a ON (a.ref,a.part)=(c.ref,c.part)
    ), bucket_bodies AS (
      SELECT h.bucket_rank,pg_catalog.jsonb_build_object('bucketKey',h.bucket_key,'kind',h.kind,
        'taxClassKey',h.tax_class_key,'assignmentRef',h.assignment_ref,
        'separatelyStated',h.separately_stated,'cost',pg_catalog.jsonb_build_object('ref',h.cost_ref,'currency',h.cost_currency,'amountMinor',h.cost_amount_minor),
        'parts',pg_catalog.jsonb_agg(c.body ORDER BY c.part)) AS body
      FROM delivery h JOIN component_bodies c ON c.ref=h.bucket_key AND c.part>0
      WHERE h.part_no=0 GROUP BY h.order_id,h.bucket_key,h.part_no,h.bucket_rank,h.kind,
        h.tax_class_key,h.assignment_ref,h.separately_stated,h.cost_ref,h.cost_currency,h.cost_amount_minor
    ), instants AS (
      SELECT CASE WHEN extract(year FROM at AT TIME ZONE 'UTC')=-1 THEN '0000' ELSE pg_catalog.to_char(at AT TIME ZONE 'UTC','YYYY') END
        || pg_catalog.to_char(at AT TIME ZONE 'UTC','-MM-DD"T"HH24:MI:SS.MS"Z"') AS formatted,kind
      FROM (VALUES (snapshot.tax_date,'date'),(snapshot.evaluation_expires_at,'expiry')) AS t(at,kind)
    )
    SELECT pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('amountBasis',snapshot.amount_basis,'currency',snapshot.currency,'mode',snapshot.mode,
        'catalogueEvidenceRef',snapshot.catalogue_evidence_ref,'destination',pg_catalog.jsonb_build_object('snapshotRef',snapshot.destination_snapshot_ref,'schemaVersion',2,
          'erased',true),
        'coverageDigest',snapshot.coverage_digest,'cadence',CASE WHEN snapshot.cadence_days IS NOT NULL THEN
          pg_catalog.jsonb_build_object('schemaVersion',1,'kind','fixed_days','days',snapshot.cadence_days) END,
        'paymentLimits',pg_catalog.jsonb_build_object('profileRef',snapshot.limit_profile_ref,'revision',snapshot.limit_revision::text,
          'channelKey',snapshot.limit_channel_key,'currency',snapshot.currency,'minMinor',snapshot.limit_min_minor,'maxMinor',snapshot.limit_max_minor),
        'price',pg_catalog.jsonb_build_object('priceListRef',snapshot.price_list_ref,'priceContextDigest',snapshot.price_context_digest,
          'priceEvidenceRef',snapshot.price_evidence_ref,'classMapRevision',snapshot.class_map_revision),
        'promotion',pg_catalog.jsonb_build_object('engine',snapshot.promotion_engine,'rankingRuleRef',
          CASE WHEN snapshot.amount_basis='inclusive' THEN 'lowest_payable_gross' ELSE 'lowest_pre_tax.v1' END),
        'taxEvidence',pg_catalog.jsonb_build_object('calculationId',snapshot.calculation_id,'evidenceDigest',snapshot.evidence_digest,
          'taxDate',(SELECT formatted FROM instants WHERE kind='date'),'expiresAt',(SELECT formatted FROM instants WHERE kind='expiry'),
          'kind',CASE WHEN snapshot.amount_basis='inclusive' THEN 'fiscal_profile' ELSE 'tax_calculation' END),
        'lines',(SELECT pg_catalog.jsonb_agg(body ORDER BY rank) FROM component_bodies WHERE part=0),
        'deliveryBuckets',(SELECT coalesce(pg_catalog.jsonb_agg(body ORDER BY bucket_rank),'[]') FROM bucket_bodies),
        'feeLines',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('feeKey',fee_key,'jurisdictionRef',jurisdiction_ref,
          'feeKind',fee_kind,'amountMinor',amount_minor,'scope',pg_catalog.jsonb_build_object('kind',scope_kind,'bucketKey',bucket_key),
          'refundRule',pg_catalog.jsonb_build_object('ref',refund_rule_ref,'revision',refund_rule_revision),'providerPositionRef',provider_position_ref)
          ORDER BY fee_rank),'[]') FROM fees),
        'netTotal',snapshot.net_total,'taxTotal',snapshot.tax_total,'feeTotal',snapshot.fee_total,'payableMinor',snapshot.payable_minor))
    INTO issued_body;
  END IF;

  RETURN pg_catalog.jsonb_build_object('kind','paid','money',issued_body || pg_catalog.jsonb_build_object(
    'orderId',p_order_id,'moneyVersion',snapshot.money_version,'schemaVersion',2,'acceptedMoneyDigest',snapshot.accepted_money_digest,
    'acceptedQuoteRef',pg_catalog.jsonb_build_object('quoteId',snapshot.accepted_quote_id,'quoteDigest',snapshot.accepted_quote_digest,
      'acceptanceRef',snapshot.acceptance_ref,'tokenDigest',snapshot.token_digest),
    'intentId',intent.id,'captureEvidenceRef',binding.id,'paidMinor',truth.amount_minor,
    'capturedAt',CASE WHEN extract(year FROM truth.occurred_at AT TIME ZONE 'UTC')=-1 THEN '0000'
      ELSE pg_catalog.to_char(truth.occurred_at AT TIME ZONE 'UTC','YYYY') END
      || pg_catalog.to_char(truth.occurred_at AT TIME ZONE 'UTC','-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_read_paid_order_money_v2(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_read_paid_order_money_v2(uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_read_paid_order_money_v2(uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_read_paid_order_money_v2(uuid) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_read_paid_order_money_v2(uuid) TO service_role;';
END IF; END; $$;
