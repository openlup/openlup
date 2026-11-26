-- Verify the retained projection at the existing deferred order boundary.
CREATE OR REPLACE FUNCTION public.commerce_order_money_v2_assert(p_order_id uuid, p_fresh boolean, p_owner boolean,
  p_before jsonb DEFAULT NULL, p_after jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  header public.commerce_orders;
  snapshot public.commerce_order_tax_snapshots;
  calculation public.tax_calculations;
  verified_quote jsonb;
  problem text;
  destination jsonb;
  inclusive boolean;
  restoring boolean := false;
  ledger_locked boolean;
  receipt_xid xid;
  copies text[];
  check_seal boolean;
  check_projection boolean;
  evidence_remedy constant text := 'Recover the original accepted evidence through its owner and retry with its original binding.';
  write_remedy constant text := 'Write the order money snapshot and its line sources in the same transaction as the order.';
  invoking_role name := coalesce(nullif(current_setting('role',true),'none'),session_user::text);
  v2 constant text := 'commerce.order-money.v2';
  remedy constant text := 'Replay the original accepted document and its digest.';
BEGIN
  IF pg_trigger_depth() = 0 THEN RETURN; END IF;
  SELECT * INTO header FROM public.commerce_orders WHERE id=p_order_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF invoking_role = 'authenticated' AND NOT EXISTS (
    SELECT FROM public.clients c WHERE c.id=header.client_id AND c.principal_id=auth.uid()
  ) THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/moneyVersion',
      HINT=evidence_remedy;
  END IF;

  SELECT * INTO snapshot FROM public.commerce_order_tax_snapshots WHERE order_id=p_order_id;
  IF header.money_version IS NULL THEN
    IF snapshot.order_id IS NOT NULL OR EXISTS (
      SELECT FROM public.commerce_order_items WHERE order_id=p_order_id AND line_key IS NOT NULL) THEN
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/lines', HINT=remedy;
    END IF;
    RETURN;
  END IF;
  -- Connected restore binds the migration login before taking these locks.
  IF pg_has_role(session_user,
    (SELECT relowner FROM pg_class WHERE oid='public.commerce_orders'::regclass),'USAGE') THEN
    restoring := (SELECT count(DISTINCT relation) FROM pg_locks WHERE pid=pg_backend_pid() AND granted
      AND mode='ShareRowExclusiveLock' AND relation IN (
        'public.identity_privacy_erasures'::regclass,
        'public.commerce_order_tax_snapshots'::regclass,'public.commerce_order_line_sources'::regclass,
        'public.commerce_order_delivery_buckets'::regclass,'public.commerce_order_line_allocations'::regclass,
        'public.commerce_order_tax_positions'::regclass,'public.commerce_order_fee_lines'::regclass))=7;
  END IF;

  -- Restore re-attests this session after the deferred checks. A temporary
  -- schema would change its effective search path. Reconcile every restore
  -- event, while the header INSERT still supplies the seal check.
  IF restoring THEN
    check_seal := p_fresh;
    check_projection := true;
  ELSE
    -- Compare visible tuple identities and creating transactions, with a boundary
    -- between relations. Including xmin detects a slot reused by another writer.
    -- Skip unchanged events before validating or hashing the projection. A later
    -- write changes the stamp even after a named IMMEDIATE flush.
    SELECT state.fresh,state.check_seal,state.check_projection INTO p_fresh,check_seal,check_projection
    FROM public.commerce_order_money_v2_check_state(p_order_id,p_fresh,invoking_role||':'||p_owner,
      (ARRAY[
        (SELECT ctid::text||'@'||xmin FROM public.commerce_orders WHERE id=p_order_id),
        (SELECT ctid::text||'@'||xmin FROM public.commerce_order_tax_snapshots WHERE order_id=p_order_id),
        (SELECT ctid::text||'@'||xmin FROM public.commerce_destination_v2_order_bindings WHERE order_id=p_order_id),
        (SELECT ctid::text||'@'||xmin FROM public.commerce_destination_v2_documents WHERE snapshot_ref=snapshot.destination_snapshot_ref),
        (SELECT ctid::text||'@'||xmin FROM public.tax_calculations WHERE calculation_id=snapshot.calculation_id),
        (SELECT ctid::text||'@'||xmin FROM public.identity_privacy_erasures WHERE client_id=header.client_id)]
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_items WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_line_sources WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_delivery_buckets WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_line_allocations WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_tax_positions WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_fee_lines WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT ctid::text||'@'||xmin FROM public.commerce_order_adjustments WHERE order_id=p_order_id ORDER BY ctid) || NULL::text
      || ARRAY(SELECT sku.ctid::text||'@'||sku.xmin FROM public.catalog_skus sku WHERE sku.id IN (
        SELECT sku_id FROM public.commerce_order_line_sources WHERE order_id=p_order_id) ORDER BY sku.ctid))::text) state;
    -- OLD/NEW guards still run for each event, even with an unchanged projection.
    IF NOT check_seal AND NOT check_projection AND p_before IS NULL THEN RETURN; END IF;
  END IF;

  -- A caller can flush either line-sum constraint ahead of the foreign keys.
  -- Refuse the missing snapshot now with the same named foreign-key diagnostic.
  IF snapshot.order_id IS NULL THEN
    RAISE EXCEPTION 'insert or update on table "commerce_orders" violates foreign key constraint "commerce_orders_money_snapshot_fkey"'
      USING ERRCODE='23503', SCHEMA='public', TABLE='commerce_orders', CONSTRAINT='commerce_orders_money_snapshot_fkey',
      HINT=write_remedy;
  END IF;
  IF header.money_version <> v2 OR snapshot.money_version <> v2 THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/moneyVersion', HINT=evidence_remedy;
  END IF;
  IF snapshot.cycle_binding_ref IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/cycleBindingRef', HINT=remedy;
  END IF;
  IF (header.total_amount_minor,header.currency_code) IS DISTINCT FROM (snapshot.payable_minor,snapshot.currency)
    OR snapshot.payable_minor NOT BETWEEN snapshot.limit_min_minor AND snapshot.limit_max_minor THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/payableMinor', HINT=remedy;
  END IF;
  IF snapshot.amount_basis NOT IN ('inclusive','exclusive')
    OR snapshot.mode NOT IN ('one_time','subscription')
    OR (snapshot.mode='subscription') <> (snapshot.cadence_days IS NOT NULL)
    OR snapshot.promotion_engine NOT IN ('promotion-engine.v1','promotion-engine.v2')
    OR snapshot.tax_date >= snapshot.evaluation_expires_at
    OR EXISTS (
      SELECT FROM (VALUES (snapshot.tax_date),(snapshot.evaluation_expires_at)) AS instant(at)
      WHERE NOT isfinite(at) OR extract(year FROM at AT TIME ZONE 'UTC') NOT BETWEEN -1 AND 9999
        OR at <> date_trunc('milliseconds',at)
    ) THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/taxEvidence', HINT=remedy;
  END IF;
  inclusive := snapshot.amount_basis='inclusive';
  destination := jsonb_build_object('snapshotRef',snapshot.destination_snapshot_ref,'schemaVersion',2,
    'destinationDigest',snapshot.destination_digest,'policyRevision',snapshot.destination_policy_revision);

  IF EXISTS (SELECT FROM public.commerce_order_items i WHERE i.order_id=p_order_id AND i.line_key IS NULL) THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/lines', HINT=remedy;
  END IF;
  -- A later source insert has no assertion trigger in this forward.
  PERFORM 1 FROM public.commerce_order_items i WHERE i.order_id=p_order_id AND NOT EXISTS (
    SELECT FROM public.commerce_order_line_sources s WHERE (s.order_id,s.line_key)=(i.order_id,i.line_key)
  ) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'insert or update on table "commerce_order_items" violates foreign key constraint "commerce_order_items_money_source_fkey"'
      USING ERRCODE='23503', SCHEMA='public', TABLE='commerce_order_items', CONSTRAINT='commerce_order_items_money_source_fkey',
      HINT=write_remedy;
  END IF;

  IF snapshot.destination_erased OR p_before IS NOT NULL THEN
    SELECT r.xmin INTO receipt_xid FROM public.identity_privacy_erasures r
    WHERE r.client_id=header.client_id AND r.contributor_versions->>'destination-documents'='commerce.destination-documents.v1'
      AND r.dispositions @> '[{"contributorId":"destination-documents","version":"commerce.destination-documents.v1","obligations":[
          {"owner":"destination-documents","resource":"commerce.order-money-destination-pins","disposition":"erase","remote":false},
          {"owner":"destination-documents","resource":"commerce.order-money-retained-facts","disposition":"retain","remote":false}]}]'::jsonb;
  END IF;

  -- The deferred storage guards pass queued OLD and NEW images for redaction.
  IF p_before IS NOT NULL THEN
    SELECT EXISTS (SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted
      AND mode='ShareRowExclusiveLock' AND relation='public.identity_privacy_erasures'::regclass) INTO ledger_locked;
    copies := CASE WHEN p_before ? 'part_no' THEN ARRAY['carrier_ref','service_ref']
      ELSE ARRAY['destination_digest','destination_policy_revision','delivery_selection_ref'] END;
    IF NOT snapshot.destination_erased OR NOT ledger_locked
      OR p_before->'order_id' IS DISTINCT FROM to_jsonb(p_order_id)
      OR p_before->'destination_erased' IS DISTINCT FROM 'false'::jsonb
      OR p_after->'destination_erased' IS DISTINCT FROM 'true'::jsonb
      OR (p_before - copies - 'destination_erased') IS DISTINCT FROM (p_after - copies - 'destination_erased')
      OR EXISTS (SELECT FROM unnest(copies) f WHERE p_after->f IS DISTINCT FROM 'null'::jsonb)
      OR receipt_xid IS NULL OR NOT (
        receipt_xid::text::bigint = pg_current_xact_id_if_assigned()::text::bigint % 4294967296
        OR EXISTS (SELECT FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.granted
          AND l.locktype='transactionid' AND l.mode='ExclusiveLock' AND l.transactionid=receipt_xid)
      ) THEN
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/taxEvidence',
        HINT='Keep the accepted facts and use the owning order lifecycle operation.';
    END IF;
  END IF;
  IF snapshot.destination_erased AND p_fresh AND NOT restoring THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/taxEvidence', HINT=evidence_remedy;
  END IF;
  IF snapshot.destination_erased AND (receipt_xid IS NULL OR NOT EXISTS (
    SELECT FROM public.commerce_destination_v2_order_bindings b
    JOIN public.commerce_destination_v2_documents d USING (snapshot_ref)
    JOIN public.tax_calculations t ON t.calculation_id=snapshot.calculation_id
    WHERE b.order_id=p_order_id AND d.snapshot_ref=snapshot.destination_snapshot_ref
      AND d.client_id=header.client_id AND d.evidence_disposition='erased'
      AND b.selection IS NULL AND b.service IS NULL AND t.state='erased'
  )) THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/taxEvidence', HINT=evidence_remedy;
  END IF;

  IF check_seal AND restoring AND NOT snapshot.destination_erased AND NOT EXISTS (
    SELECT FROM public.tax_calculations t WHERE t.calculation_id=snapshot.calculation_id AND t.state='terminal'
  ) THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/taxEvidence', HINT=evidence_remedy;
  END IF;
  IF check_seal AND NOT restoring THEN
    SELECT * INTO calculation FROM public.tax_calculations WHERE calculation_id=snapshot.calculation_id;
    IF calculation.state='terminal' AND calculation.pin ? 'composition'
      AND calculation.identity->'clientId'=to_jsonb(header.client_id) THEN
      verified_quote := public.tax_calculation_terminal_v1(calculation)#>'{outcome,quote}';
    END IF;
    IF verified_quote->>'status' IS DISTINCT FROM 'final'
      OR verified_quote->'quoteId' IS DISTINCT FROM to_jsonb(snapshot.accepted_quote_id)
      OR verified_quote->>'quoteDigest' IS DISTINCT FROM snapshot.accepted_quote_digest
      OR verified_quote->>'moneyDigest' IS DISTINCT FROM snapshot.accepted_money_digest
      OR NOT EXISTS (
        SELECT FROM public.commerce_destination_v2_order_bindings b
        JOIN public.commerce_destination_v2_documents d USING (snapshot_ref)
        WHERE b.order_id=p_order_id AND d.snapshot_ref=snapshot.destination_snapshot_ref
          AND d.client_id=header.client_id AND d.evidence_disposition='available'
          AND d.binding=destination AND d.scope_ref::text=calculation.identity->>'scopeRef'
          AND d.owner_scope->>'principalRef'=calculation.identity->>'principalRef'
          AND d.owner_scope->>'installationRef'=calculation.identity->>'installationRef'
          AND public.commerce_destination_v2_verified_document(d)->>'verified'='true'
          AND public.commerce_destination_v2_valid_pins(b.selection,b.service,d.scope_ref)
          AND (b.selection,b.service)=(calculation.pin#>'{composition,selection}',calculation.pin#>'{composition,service}')
          AND b.service->>'deliverySelectionRef'=snapshot.delivery_selection_ref
      ) THEN
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/taxEvidence',
        HINT=evidence_remedy;
    END IF;
    IF EXISTS (
      SELECT FROM public.commerce_order_line_sources l LEFT JOIN public.catalog_skus sku ON sku.id=l.sku_id
      WHERE l.order_id=p_order_id AND sku.sku IS DISTINCT FROM l.sku_code
    ) THEN
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/lines', HINT=remedy;
    END IF;
    IF EXISTS (
      SELECT FROM public.commerce_order_line_allocations a JOIN public.commerce_order_adjustments j ON j.id=a.adjustment_id
      WHERE a.order_id=p_order_id AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(coalesce(calculation.pin#>'{composition,planInput,selected,adjustments}','[]')) pin
        WHERE (pin->>'adjustmentRef',pin->>'evidenceRef',pin->>'appliesTo')=(a.adjustment_ref,a.evidence_ref,j.scope)
          AND CASE WHEN a.bucket_key IS NULL THEN (pin#>'{target,lineKeys}') ? a.line_key
            ELSE pin#>>'{target,bucketKey}'=a.bucket_key END
      )
    ) THEN
      RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/discountAllocations', HINT=remedy;
    END IF;
  END IF;
  IF NOT check_projection THEN RETURN; END IF;

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
  ), adjustments AS (
    SELECT * FROM public.commerce_order_adjustments WHERE order_id=p_order_id
  ), components AS (
    SELECT line_key AS ref, 0 AS part, source_rank AS rank, pre_discount_minor, effective_minor, net_minor, tax_minor,
      false AS shipping
    FROM lines
    UNION ALL
    SELECT p.bucket_key,p.part_no,p.part_no,p.pre_discount_minor,p.effective_minor,p.net_minor,p.tax_minor,
      h.kind='shipping'
    FROM delivery p JOIN delivery h ON h.part_no=0 AND h.bucket_key=p.bucket_key WHERE p.part_no>0
  ), position_sets AS (
    SELECT coalesce(line_key,bucket_key) AS ref,coalesce(part_no,0) AS part,allocation_slot AS slot,state_side AS side,
      count(*) AS size,min(position_rank)=1 AND max(position_rank)=count(*) AND count(DISTINCT position_rank)=count(*) AS ranked,
      sum(tax_minor) AS tax,min(taxable_minor) AS min_taxable,max(taxable_minor) AS max_taxable,
      jsonb_agg(to_jsonb(p)-ARRAY['order_id','line_key','bucket_key','part_no','allocation_id','allocation_slot','state_side','position_rank']
        ORDER BY position_rank) AS evidence
    FROM positions p GROUP BY 1,2,3,4
  ), states AS (
    SELECT ref,part,0 AS slot,'final' AS side,effective_minor AS basis,net_minor AS net,tax_minor AS tax FROM components
    UNION ALL
    SELECT coalesce(a.line_key,a.bucket_key),coalesce(a.part_no,0),a.sequence,s.side,s.basis,s.net,s.tax
    FROM allocations a CROSS JOIN LATERAL (VALUES
      ('before',a.before_basis_minor,a.before_net_minor,a.before_tax_minor),
      ('after',a.after_basis_minor,a.after_net_minor,a.after_tax_minor)) s(side,basis,net,tax)
  ), checked_states AS (
    SELECT s.*,p.ref IS NULL OR p.ranked AS ranked,
      (s.tax=coalesce(p.tax,0) AND s.basis=s.net::numeric+CASE WHEN inclusive THEN s.tax ELSE 0 END
        AND (NOT c.shipping OR s.basis<>0 OR p.ref IS NULL)
        AND (NOT inclusive OR (coalesce(p.size,0)=(s.basis>0)::integer AND
          (p.ref IS NULL OR (p.min_taxable,p.max_taxable)=(s.net,s.net))))) AS valid,
      jsonb_build_array(s.basis,s.net,s.tax,coalesce(p.evidence,'[]')) AS facts
    FROM states s JOIN components c USING (ref,part) LEFT JOIN position_sets p USING (ref,part,slot,side)
  ), allocation_steps AS (
    SELECT a.*,b.ref,b.part,b.facts AS before_state,z.facts AS after_state,f.facts AS final_state,
      lag(z.facts) OVER target AS previous_state,lead(a.sequence) OVER target AS next_slot
    FROM allocations a
    JOIN checked_states b ON (b.ref,b.part,b.slot,b.side)=(coalesce(a.line_key,a.bucket_key),coalesce(a.part_no,0),a.sequence,'before')
    JOIN checked_states z ON (z.ref,z.part,z.slot,z.side)=(b.ref,b.part,b.slot,'after')
    JOIN checked_states f ON (f.ref,f.part,f.slot,f.side)=(b.ref,b.part,0,'final')
    WINDOW target AS (PARTITION BY b.ref,b.part ORDER BY a.sequence)
  ), line_items AS (
    SELECT i.line_key,count(*) AS size,sum(i.quantity) AS quantity,sum(i.line_amount_minor) AS effective,
      sum(i.catalog_line_amount_minor) AS catalogue,sum(i.promotion_discount_allocated_minor) AS reduction,
      count(i.source_line_ordinal) AS promoted,count(DISTINCT i.promotion_allocation_fingerprint) AS fingerprints,
      bool_and((i.sku_id,coalesce(i.source_line_ordinal,i.line_ordinal)) IS NOT DISTINCT FROM (l.sku_id,l.source_ordinal)
        AND CASE WHEN i.source_line_ordinal IS NULL THEN
          i.catalog_unit_amount_minor IS NULL AND i.catalog_line_amount_minor IS NULL
          AND i.promotion_discount_allocated_minor IS NULL AND i.promotion_allocation_fingerprint IS NULL
        ELSE i.catalog_unit_amount_minor IS NOT NULL AND i.catalog_unit_amount_minor=l.unit_basis_minor
          AND i.catalog_line_amount_minor IS NOT NULL AND i.promotion_discount_allocated_minor IS NOT NULL
          AND i.promotion_allocation_fingerprint IS NOT NULL END) AS matched
    FROM public.commerce_order_items i JOIN lines l USING (line_key) WHERE i.order_id=p_order_id GROUP BY i.line_key
  ), adjustment_totals AS (
    SELECT adjustment_id,sum(basis_reduction_minor) AS amount FROM allocations GROUP BY adjustment_id
  )
  SELECT CASE
    WHEN (SELECT count(*)=0 OR min(source_rank)<>1 OR max(source_rank)<>count(*)
            OR count(DISTINCT source_rank)<>count(*) FROM lines)
      OR EXISTS (
        SELECT FROM lines l LEFT JOIN line_items i USING (line_key)
        WHERE l.mode<>snapshot.mode OR l.unit_basis_minor::numeric*l.quantity<>l.pre_discount_minor
          OR (i.quantity,i.effective,i.matched) IS DISTINCT FROM (l.quantity::bigint,l.effective_minor::numeric,true)
          OR CASE WHEN i.promoted=0 THEN i.size<>1 OR l.pre_discount_minor<>l.effective_minor
             ELSE i.promoted<>i.size OR i.fingerprints<>1 OR i.catalogue<>l.pre_discount_minor
               OR i.reduction<>l.pre_discount_minor-l.effective_minor END
      ) OR EXISTS (SELECT FROM lines WHERE NOT public.catalog_publication_text_valid(to_jsonb(line_key),128,false)) THEN '/lines'
    WHEN (SELECT count(*)<>count(DISTINCT bucket_rank) OR coalesce(max(bucket_rank),0)<>count(*) FROM delivery WHERE part_no=0)
      OR EXISTS (
        SELECT FROM delivery h LEFT JOIN delivery p ON (p.bucket_key=h.bucket_key AND p.part_no>0)
        WHERE h.part_no=0
        GROUP BY h.bucket_key,h.kind,h.cost_currency,h.destination_erased
        HAVING h.kind NOT IN ('shipping','handling') OR h.cost_currency<>snapshot.currency
          OR h.destination_erased<>snapshot.destination_erased OR count(p.part_no)=0 OR max(p.part_no)<>count(p.part_no)
          OR CASE WHEN inclusive AND h.kind='shipping' AND bool_or(p.pre_discount_minor>0) THEN
              count(p.part_no)<>count(DISTINCT p.source_ordinal)
              OR NOT array_agg(p.source_ordinal) <@ ARRAY(SELECT source_ordinal FROM lines)
            ELSE count(p.part_no)<>1 OR count(p.source_ordinal)<>0 END
      )
      OR EXISTS (SELECT FROM delivery WHERE part_no=0 AND NOT public.catalog_publication_text_valid(to_jsonb(bucket_key),128,false))
      OR (inclusive AND (SELECT count(*) FROM delivery WHERE part_no=0 AND kind='shipping')>1)
      OR (SELECT coalesce(sum(pre_discount_minor),0) FROM components WHERE shipping)
         <> (SELECT coalesce(sum(amount_minor),0) FROM adjustments WHERE kind='shipping_charge')
      THEN '/deliveryBuckets'
    WHEN (SELECT count(*)<>count(DISTINCT fee_rank) OR coalesce(max(fee_rank),0)<>count(*) FROM fees)
      OR EXISTS (SELECT FROM fees WHERE scope_kind NOT IN ('order','delivery')
        OR NOT public.catalog_publication_text_valid(to_jsonb(fee_key),128,false)) THEN '/feeLines'
    WHEN EXISTS (
        SELECT FROM allocation_steps a JOIN components c USING (ref,part)
        WHERE a.before_basis_minor-a.after_basis_minor<>a.basis_reduction_minor
          OR a.before_net_minor-a.after_net_minor<>a.net_reduction_minor
          OR a.before_tax_minor-a.after_tax_minor<>a.tax_reduction_minor
          OR CASE WHEN a.previous_state IS NULL THEN a.before_basis_minor<>c.pre_discount_minor
            ELSE a.before_state<>a.previous_state END
          OR (a.next_slot IS NULL AND a.after_state<>a.final_state)
      ) OR EXISTS (
        SELECT FROM components c WHERE c.effective_minor<>c.pre_discount_minor
          AND NOT EXISTS (SELECT FROM allocation_steps a WHERE (a.ref,a.part)=(c.ref,c.part))
      ) OR EXISTS (
        SELECT FROM allocations a LEFT JOIN adjustments j ON j.id=a.adjustment_id
        LEFT JOIN delivery h ON h.bucket_key=a.bucket_key AND h.part_no=0
        WHERE j.id IS NULL OR j.kind<>'promotion_discount'
          OR (j.promotion_id,j.definition_fingerprint) IS DISTINCT FROM (a.adjustment_ref,a.evidence_ref)
          OR (j.scope='shipping')<>(a.bucket_key IS NOT NULL)
          OR (j.scope='shipping' AND h.kind IS DISTINCT FROM 'shipping')
          OR NOT public.catalog_publication_text_valid(to_jsonb(a.adjustment_ref),128,false)
      ) OR EXISTS (
        SELECT FROM adjustments j LEFT JOIN adjustment_totals a ON a.adjustment_id=j.id
        WHERE j.kind='promotion_discount' AND j.amount_minor IS DISTINCT FROM a.amount
      ) OR EXISTS (
        SELECT FROM allocations GROUP BY sequence HAVING count(DISTINCT (adjustment_ref,evidence_ref))>1
      ) OR EXISTS (
        SELECT FROM allocations GROUP BY adjustment_ref HAVING count(DISTINCT sequence)>1
      ) THEN '/discountAllocations'
    WHEN EXISTS (SELECT FROM checked_states WHERE NOT valid OR NOT ranked)
      OR EXISTS (SELECT FROM positions GROUP BY position_ref HAVING count(DISTINCT (line_key,bucket_key,part_no))>1)
      OR EXISTS (
        SELECT FROM positions p CROSS JOIN LATERAL (VALUES (p.effective_from),(p.effective_until)) AS instant(at)
        WHERE p.state_side NOT IN ('final','before','after') OR p.effective_until<=p.effective_from
          OR NOT public.catalog_publication_text_valid(to_jsonb(p.position_ref),128,false)
          OR NOT isfinite(at) OR extract(year FROM at AT TIME ZONE 'UTC') NOT BETWEEN -1 AND 9999
          OR at <> date_trunc('milliseconds',at)
          OR CASE WHEN p.rate_decimal IS NULL THEN false
             WHEN p.rate_decimal COLLATE "C" !~ '\A(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?\Z' THEN true
             ELSE p.rate_decimal::numeric*1000000>9007199254740991 END
      ) THEN '/taxEvidence'
    WHEN (SELECT (coalesce(sum(net_minor),0),coalesce(sum(tax_minor),0)) FROM components)
        IS DISTINCT FROM (snapshot.net_total::numeric,snapshot.tax_total::numeric)
      OR (SELECT coalesce(sum(amount_minor),0) FROM fees)<>snapshot.fee_total
      OR snapshot.net_total::numeric+snapshot.tax_total+snapshot.fee_total<>snapshot.payable_minor
      THEN '/payableMinor'
    END INTO problem;

  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN=problem, HINT=remedy;
  END IF;
  IF NOT snapshot.destination_erased AND snapshot.accepted_money_digest IS DISTINCT FROM
    encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array('commerce.quote-money.v2',
      public.commerce_order_money_v2_live_body(p_order_id)),0),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'commerce_order_money_v2_mismatch' USING ERRCODE='23514', COLUMN='/acceptedMoneyDigest', HINT=remedy;
  END IF;
END;
$$;
