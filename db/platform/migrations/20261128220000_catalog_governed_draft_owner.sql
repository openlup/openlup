-- Derive the same companion coordinates for creation and retained-store finality.
CREATE FUNCTION public.catalog_admission_governed_companions(p_draft jsonb,p_bindings jsonb)
RETURNS TABLE(line_ordinal integer,sku_id uuid,quantity integer,unit_amount_minor bigint,line_amount_minor bigint,
 source_line_ordinal integer,catalog_unit_amount_minor bigint,catalog_line_amount_minor bigint,
 promotion_discount_allocated_minor bigint,promotion_allocation_fingerprint text,
 kind text,scope text,amount_minor bigint,promotion_id text)
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 WITH discounts AS (
  SELECT d->>'appliesTo' scope,(d->>'amountOffMinor')::bigint amount,d->>'promotionId' promotion
  FROM jsonb_array_elements(p_draft->'discounts') d
 ), sources AS (
  SELECT pos::integer source,(p_bindings->(pos::integer-1)->>'skuId')::uuid sku,
   (l->>'quantity')::integer qty,(l#>>'{unitPriceGross,amountMinor}')::bigint unit,
   (l#>>'{lineSubtotalGross,amountMinor}')::bigint subtotal
  FROM jsonb_array_elements(p_draft->'lines') WITH ORDINALITY AS x(l,pos)
 ), priced AS (
  SELECT *,sum(subtotal) OVER () total,coalesce((SELECT sum(amount) FROM discounts WHERE scope='order_total'),0) discount
  FROM sources
 ), shares AS (
  SELECT *,CASE WHEN discount=0 THEN subtotal ELSE div(subtotal*(total-discount),total) END whole,
   CASE WHEN discount=0 THEN 0 ELSE mod(subtotal*(total-discount),total) END remainder
  FROM priced
 ), apportioned AS (
  SELECT *, (whole + (row_number() OVER (ORDER BY remainder DESC,source) <= total-discount-sum(whole) OVER ())::integer)::bigint payable
  FROM shares
 ), splits AS (
  SELECT source,sku,unit,discount,payable/apportioned.qty+split.delta effective,split.qty
  FROM apportioned CROSS JOIN LATERAL (VALUES (0,qty-(payable%qty)::integer),(1,(payable%qty)::integer)) split(delta,qty)
  WHERE split.qty>0
 )
 SELECT row_number() OVER (ORDER BY source,effective,qty)::integer,sku,qty,effective,effective*qty,
  CASE WHEN discount>0 THEN source END,CASE WHEN discount>0 THEN unit END,
  CASE WHEN discount>0 THEN unit*qty END,CASE WHEN discount>0 THEN (unit-effective)*qty END,
  CASE WHEN discount>0 THEN encode(sha256(convert_to(p_draft::text||'|effective-line-allocation.v1','UTF8')),'hex') END,
  NULL::text,NULL::text,NULL::bigint,NULL::text FROM splits
 UNION ALL
 SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'promotion_discount',scope,amount,promotion FROM discounts
 UNION ALL
 SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'shipping_charge','shipping',shipping,NULL
 FROM (SELECT (p_draft#>>'{totals,shippingGross,amountMinor}')::bigint shipping) charge WHERE shipping>0
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_governed_companions(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_owner_origin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE owned boolean; previous uuid; upcoming uuid;
BEGIN
 owned:=pg_catalog.pg_has_role(current_user,(SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID),'USAGE');
 IF TG_TABLE_NAME='commerce_orders' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.metadata->'catalogAdmissionOwnerOrigin' IS NULL OR
    (owned AND jsonb_typeof(NEW.catalog_acceptance)='object' AND jsonb_typeof(NEW.metadata->'catalogAdmissionSubmit')='object') THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' THEN
   IF OLD.metadata->'catalogAdmissionOwnerOrigin' IS NULL AND NEW.metadata->'catalogAdmissionOwnerOrigin' IS NULL THEN RETURN NEW; END IF;
   IF (OLD.id,OLD.client_id,OLD.currency_code,OLD.total_amount_minor,OLD.created_at,OLD.catalog_acceptance,
       OLD.catalog_receipt_key,OLD.catalog_basket,OLD.renewal_operation_id,OLD.renewal_operation_fingerprint,OLD.subscription_cycle_id,
       OLD.metadata->'catalogAdmissionOwnerOrigin',OLD.metadata->'catalogAdmissionSubmit',OLD.metadata->'quoteSnapshot',OLD.metadata->'orderDraftSnapshot')
      IS NOT DISTINCT FROM
      (NEW.id,NEW.client_id,NEW.currency_code,NEW.total_amount_minor,NEW.created_at,NEW.catalog_acceptance,
       NEW.catalog_receipt_key,NEW.catalog_basket,NEW.renewal_operation_id,NEW.renewal_operation_fingerprint,NEW.subscription_cycle_id,
       NEW.metadata->'catalogAdmissionOwnerOrigin',NEW.metadata->'catalogAdmissionSubmit',NEW.metadata->'quoteSnapshot',NEW.metadata->'orderDraftSnapshot') THEN RETURN NEW; END IF;
  ELSIF OLD.metadata->'catalogAdmissionOwnerOrigin' IS NULL THEN RETURN OLD; END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN previous:=OLD.order_id; END IF;
  IF TG_OP<>'DELETE' THEN upcoming:=NEW.order_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_orders WHERE id IN (previous,upcoming)
   AND metadata->'catalogAdmissionOwnerOrigin' IS NOT NULL) OR (TG_OP='INSERT' AND owned) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='commerce_order_draft_receipts' AND TG_OP='UPDATE' THEN
   IF OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL AND
      (OLD.idempotency_key,OLD.order_id,OLD.request_fingerprint,OLD.response_payload,OLD.created_at)
      IS NOT DISTINCT FROM (NEW.idempotency_key,NEW.order_id,NEW.request_fingerprint,NEW.response_payload,NEW.created_at)
   THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE='55000', CONSTRAINT='catalog_owner_origin',
  HINT='Replay the owner command with its original acceptance and evidence.';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_owner_origin_guard() FROM PUBLIC;

CREATE TRIGGER commerce_orders_catalog_owner_origin_guard BEFORE INSERT OR UPDATE OR DELETE ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.catalog_admission_owner_origin_guard();
CREATE TRIGGER commerce_order_items_catalog_owner_origin_guard BEFORE INSERT OR UPDATE OR DELETE ON public.commerce_order_items FOR EACH ROW EXECUTE FUNCTION public.catalog_admission_owner_origin_guard();
CREATE TRIGGER commerce_order_draft_receipts_catalog_owner_origin_guard BEFORE INSERT OR UPDATE OR DELETE ON public.commerce_order_draft_receipts FOR EACH ROW EXECUTE FUNCTION public.catalog_admission_owner_origin_guard();
CREATE CONSTRAINT TRIGGER commerce_order_adjustments_catalog_final AFTER INSERT ON public.commerce_order_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_order_receipt_acceptance_trigger();
CREATE CONSTRAINT TRIGGER commerce_promotion_claims_catalog_final AFTER INSERT OR UPDATE OR DELETE ON public.commerce_promotion_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_order_receipt_acceptance_trigger();

CREATE OR REPLACE FUNCTION public.catalog_order_acceptance_final(p_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target public.commerce_orders; basket jsonb; submit jsonb; origin jsonb; snapshot jsonb; draft jsonb; fingerprint text;
BEGIN
 SELECT * INTO target FROM public.commerce_orders WHERE id=p_order_id;
 submit := target.metadata->'catalogAdmissionSubmit';
 origin := target.metadata->'catalogAdmissionOwnerOrigin';
 IF origin IS NOT NULL THEN
  snapshot:=target.metadata->'quoteSnapshot'; draft:=target.metadata->'orderDraftSnapshot';
  fingerprint:=md5(snapshot::text||'|'||draft::text||'|'||target.client_id::text);
  IF target.catalog_receipt_key IS NULL OR target.client_id IS NULL OR target.renewal_operation_id IS NOT NULL
   OR target.subscription_cycle_id IS NOT NULL OR target.catalog_acceptance#>>'{admission,quoteDigest}' IS NULL
   OR NOT public.catalog_admission_submit_valid(submit,target.client_id,target.catalog_receipt_key)
   OR origin IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'orderId',p_order_id,
     'receiptKey',target.catalog_receipt_key,'nativeFingerprint',fingerprint,
     'ownerQuoteDigest',target.catalog_acceptance#>'{admission,quoteDigest}')
   OR snapshot#>'{quote,totalGross}' IS DISTINCT FROM jsonb_build_object('currency',target.currency_code,'amountMinor',target.total_amount_minor)
   OR draft#>'{totals,totalGross}' IS DISTINCT FROM snapshot#>'{quote,totalGross}'
   OR (draft->'context',draft->'lines',draft->'discounts') IS DISTINCT FROM
      (snapshot#>'{quote,context}',snapshot#>'{quote,lines}',snapshot#>'{quote,discounts}')
  THEN RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023', CONSTRAINT='catalog_owner_origin',
    HINT='Use the original acceptance and its frozen snapshot.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order_id
   AND r.idempotency_key=target.catalog_receipt_key AND r.request_fingerprint=fingerprint
   AND r.response_payload=jsonb_build_object('contractVersion','commerce.v0','orderDraft',
     jsonb_build_object('orderId','order_'||p_order_id::text,'status','draft','paymentStatus','not_started',
       'idempotencyKey',target.catalog_receipt_key,'quoteSnapshot',snapshot,'replayed',false)))
  THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023', CONSTRAINT='catalog_owner_origin',
    HINT='Supply the persisted draft receipt for this order and retry with its original key.'; END IF;
  IF EXISTS (
   WITH expected AS MATERIALIZED (
    SELECT * FROM public.catalog_admission_governed_companions(draft,target.catalog_acceptance#>'{admission,lineBindings}')
   ), actual_items AS (SELECT * FROM public.commerce_order_items WHERE order_id=p_order_id),
   actual_adjustments AS (SELECT * FROM public.commerce_order_adjustments WHERE order_id=p_order_id),
   claims AS (SELECT * FROM public.commerce_promotion_claims WHERE order_id=p_order_id)
   SELECT 1 FROM (SELECT * FROM expected WHERE line_ordinal IS NOT NULL) e FULL JOIN actual_items i USING(line_ordinal)
   WHERE (e.sku_id,e.quantity,e.unit_amount_minor,e.line_amount_minor,e.source_line_ordinal,e.catalog_unit_amount_minor,
     e.catalog_line_amount_minor,e.promotion_discount_allocated_minor,e.promotion_allocation_fingerprint)
    IS DISTINCT FROM (i.sku_id,i.quantity,i.unit_amount_minor,i.line_amount_minor,i.source_line_ordinal,i.catalog_unit_amount_minor,
     i.catalog_line_amount_minor,i.promotion_discount_allocated_minor,i.promotion_allocation_fingerprint)
   UNION ALL
   SELECT 1 FROM (SELECT * FROM expected WHERE kind IS NOT NULL) e FULL JOIN actual_adjustments a
     ON e.kind=a.kind AND e.scope=a.scope AND coalesce(e.promotion_id,'')=coalesce(a.promotion_id,'')
   WHERE e.amount_minor IS DISTINCT FROM a.amount_minor
      OR (a.promotion_id IS NULL AND a.definition_fingerprint IS NOT NULL)
   UNION ALL
   SELECT 1 FROM (SELECT * FROM actual_adjustments WHERE promotion_id IS NOT NULL) a FULL JOIN claims c ON a.id=c.adjustment_id
   WHERE (a.promotion_id,a.definition_fingerprint,a.amount_minor,target.client_id)
     IS DISTINCT FROM (c.promotion_id,c.definition_fingerprint,c.amount_off_minor,c.client_id)
  ) THEN RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023', CONSTRAINT='catalog_owner_origin',
   HINT='Reconcile the accepted SKU revisions and quantities with the authoritative basket before retrying.'; END IF;
 ELSIF submit IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order_id
   AND public.catalog_admission_submit_valid(submit,target.client_id,r.idempotency_key)
   AND r.response_payload#>>'{orderDraft,idempotencyKey}'=r.idempotency_key
   AND r.response_payload#>>'{orderDraft,orderId}'='order_'||p_order_id::text
   AND (r.response_payload#>'{orderDraft,quoteSnapshot}'=target.metadata->'quoteSnapshot'
     OR pg_has_role(COALESCE(NULLIF(current_setting('role'),'none'),session_user::text)::name,current_user,'USAGE'))
   AND r.request_fingerprint=md5((r.response_payload#>'{orderDraft,quoteSnapshot}')::text || '|'
    || (target.metadata->'orderDraftSnapshot')::text || '|' || coalesce(target.client_id::text,''))
 ) THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023'; END IF;
 IF target.catalog_acceptance IS NULL THEN RETURN; END IF;
 IF target.renewal_operation_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=target.renewal_operation_id
   AND op.catalog_acceptance=target.catalog_acceptance AND op.catalog_acceptance_fingerprint=target.renewal_operation_fingerprint)
   THEN RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023',
   HINT='Use the stored renewal operation, its original acceptance and its frozen snapshot.'; END IF;
 ELSIF target.catalog_receipt_key IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order_id AND r.idempotency_key=target.catalog_receipt_key
  ) THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023',
   HINT='Supply the persisted draft receipt for this order and retry with its original key.';
 END IF;
 basket:=public.catalog_order_evidence_v2(p_order_id,target.metadata,target.catalog_acceptance,target.renewal_operation_id IS NULL);
 IF basket IS NULL OR (target.catalog_basket IS NOT NULL AND target.catalog_basket IS DISTINCT FROM basket)
  OR (target.catalog_basket IS NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=p_order_id)) THEN
  RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023',
   HINT='Reconcile the accepted SKU revisions and quantities with the authoritative basket before retrying.'; END IF;
 IF target.catalog_acceptance ? 'admission' AND (
  EXISTS (
   WITH expected AS (
    SELECT (line->>'sourceOrdinal')::integer coordinate,(line->>'skuId')::uuid sku_id,(line->>'quantity')::integer quantity
    FROM jsonb_array_elements(target.catalog_acceptance#>'{admission,lineBindings}') line
   ), actual AS (
    SELECT coalesce(source_line_ordinal,line_ordinal) coordinate,sku_id,sum(quantity) quantity
    FROM public.commerce_order_items WHERE order_id=p_order_id GROUP BY 1,2
   )
   SELECT 1 FROM expected FULL JOIN actual USING (coordinate,sku_id) WHERE expected.quantity IS DISTINCT FROM actual.quantity
  )
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(target.metadata#>'{orderDraftSnapshot,lines}') WITH ORDINALITY AS draft(line,coordinate)
   LEFT JOIN LATERAL (SELECT target.catalog_acceptance#>ARRAY['admission','lineBindings',(draft.coordinate-1)::text] AS binding) bound ON true
   WHERE (draft.line->'sku',draft.line->'quantity') IS DISTINCT FROM (bound.binding->'skuCode',bound.binding->'quantity'))
 ) THEN RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;

CREATE FUNCTION public.catalog_admission_write_governed_draft(p_key text,p_client uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 original jsonb:=p_payload->'original'; snapshot jsonb:=p_payload->'quoteSnapshot'; quote jsonb:=snapshot->'quote';
 draft jsonb:=p_payload->'draft'; evidence jsonb:=p_payload->'evidence'; bindings jsonb:=evidence->'lineBindings';
 phase jsonb:=p_payload->'phase'; submit jsonb:=p_payload->'submit'; context jsonb:=quote->'context'; totals jsonb:=draft->'totals';
 acquisition jsonb:=context->'acquisitionTerms'; payable jsonb:=submit->'reviewedPayable'; v_currency text:=quote->>'currency';
 at_text text:=context->>'atTime'; at_time timestamptz; key_lock bigint:=hashtextextended(p_key,0);
 list_id uuid; facts jsonb; line jsonb; binding jsonb; selected jsonb; money jsonb; field text;
 base public.price_entries; actual public.price_entries; expected_prices integer[]; position integer;
 page jsonb; cursor_value jsonb; heads jsonb:='{}'; declaring jsonb; selected_ref jsonb; acceptance jsonb; basket jsonb;
 definition public.commerce_promotion_definitions; discount jsonb; fingerprints jsonb:='{}';
 subtotal bigint:=0; product_discount bigint; shipping bigint; shipping_discount bigint; total bigint;
 order_id uuid; fingerprint text; response jsonb;
BEGIN
 <<validate>>
 BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR NOT p_payload ?& ARRAY['original','quoteSnapshot','draft','evidence','renewalTerms','phase','submit']
   OR p_payload - ARRAY['original','quoteSnapshot','draft','evidence','renewalTerms','phase','submit'] <> '{}'::jsonb
   OR octet_length(p_payload::text)>1048576 OR p_client IS NULL OR p_key IS NULL OR octet_length(p_key) NOT BETWEEN 8 AND 120
   OR p_key COLLATE "C" ~ '[^!-~]' OR (v_currency COLLATE "C" ~ '^[A-Z]{3}$') IS DISTINCT FROM true
   OR (original->'key',original->'clientId',original#>'{contact,purchaser}',original->'purpose',original->'lane',original#>'{consent,accepted}')
      IS DISTINCT FROM (to_jsonb(p_key),to_jsonb(p_client),to_jsonb(p_client),'"offer-review"'::jsonb,'"starter-checkout"'::jsonb,'true'::jsonb)
   OR (original->'actorRef',original->'ownerNamespace',original->'lane',original->'offer') IS DISTINCT FROM
      (submit->'actorRef',submit->'ownerNamespace',submit->'lane',evidence->'offer')
   OR (original#>'{selection,mode}',original#>'{selection,cadenceDays}',original#>'{selection,acquisitionCapability}',original#>'{selection,promoCodes}')
      IS DISTINCT FROM ('"subscription"'::jsonb,context->'cadenceDays','"subscription-acquisition.v1"'::jsonb,'[]'::jsonb)
   OR (context->'mode',context->'promoCodes',context->'acquisitionCapability')
      IS DISTINCT FROM ('"subscription"'::jsonb,'[]'::jsonb,'"subscription-acquisition.v1"'::jsonb)
   OR (context->>'cadenceDays' ~ '^[1-9][0-9]{0,3}$') IS DISTINCT FROM true
   OR NOT public.catalog_admission_evidence_valid(evidence)
   OR evidence->'offer' IS NULL OR evidence ?| ARRAY['quoteRef','acceptanceTokenDigest','legacyReviewEvidence']
   OR evidence->'quoteDigest' IS DISTINCT FROM submit->'ownerQuoteDigest'
   OR jsonb_typeof(submit) IS DISTINCT FROM 'object' OR
      NOT submit ?& ARRAY['schemaVersion','ownerNamespace','actorRef','clientId','lane','requestKey','acceptanceTokenDigest','submitDigest','ownerQuoteDigest','reviewedPayable']
   OR (submit->'requestKey',submit->'clientId') IS DISTINCT FROM (to_jsonb(p_key),to_jsonb(p_client))
   OR jsonb_typeof(submit->'submitDigest') IS DISTINCT FROM 'string' OR jsonb_typeof(submit->'acceptanceTokenDigest') IS DISTINCT FROM 'string'
   OR jsonb_typeof(submit->'ownerQuoteDigest') IS DISTINCT FROM 'string'
   OR submit ? 'legacyReviewEvidence' OR (submit->>'acceptanceTokenDigest' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
   OR NOT public.catalog_admission_submit_valid(submit-ARRAY['ownerQuoteDigest','reviewedPayable'],p_client,p_key)
   OR (jsonb_typeof(context->'atTime')='string' AND at_text COLLATE "C" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       AND pg_input_is_valid(at_text,'timestamptz')) IS DISTINCT FROM true
  THEN EXIT validate; END IF;
  at_time:=at_text::timestamptz;
  IF to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>at_text
   OR at_time<date_trunc('milliseconds',transaction_timestamp()) OR at_time>clock_timestamp()
   OR (snapshot->'contractVersion',draft->'contractVersion',draft->'source',draft->'status',draft->'paymentStatus',quote->'taxIncluded')
     IS DISTINCT FROM ('"commerce.v0"'::jsonb,'"commerce.v0"'::jsonb,'"commerce.order_draft.bff.v0"'::jsonb,'"draft"'::jsonb,'"not_started"'::jsonb,'true'::jsonb)
   OR (draft->'context',draft->'currency',draft->'taxIncluded',draft->'lines',draft->'discounts',payable) IS DISTINCT FROM
     (context,quote->'currency',quote->'taxIncluded',quote->'lines',quote->'discounts',quote->'totalGross')
   OR phase IS DISTINCT FROM p_payload#>'{renewalTerms,phase}'
   OR (CASE WHEN phase='{"applicability":"absent"}' THEN NOT evidence ? 'graduation'
     WHEN phase->>'applicability'='certified' THEN evidence->'graduation'=
      jsonb_build_object('lineBindings',phase->'lineBindings','phaseDigest',phase->'phaseDigest')
       AND jsonb_typeof(phase->'basis')='object' ELSE false END) IS DISTINCT FROM true
   OR jsonb_typeof(draft->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(draft->'discounts') IS DISTINCT FROM 'array'
   OR jsonb_typeof(original#>'{selection,lines}') IS DISTINCT FROM 'array'
   OR NOT (pg_input_is_valid(acquisition->>'effectiveFrom','timestamptz')
      AND (acquisition->'effectiveTo'='null' OR pg_input_is_valid(acquisition->>'effectiveTo','timestamptz'))) IS TRUE
  THEN EXIT validate; END IF;
  IF (acquisition->>'effectiveFrom')::timestamptz>at_time OR NOT isfinite((acquisition->>'effectiveFrom')::timestamptz)
   OR (acquisition->>'effectiveTo')::timestamptz<=at_time OR NOT coalesce(isfinite((acquisition->>'effectiveTo')::timestamptz),true)
   OR jsonb_typeof(context->'cadenceDays') IS DISTINCT FROM 'number' OR (context->>'cadenceDays')::integer>3660
   OR jsonb_array_length(bindings)<>2 OR jsonb_array_length(draft->'lines')<>2
   OR jsonb_array_length(original#>'{selection,lines}')<>2 OR jsonb_array_length(draft->'discounts')>20
   OR bindings#>'{0,skuId}'=bindings#>'{1,skuId}'
   OR NOT ((bindings#>>'{0,source}',bindings#>>'{1,source}') IN (('fresh','legacy'),('legacy','fresh')))
  THEN EXIT validate; END IF;

  FOREACH field IN ARRAY ARRAY['subtotalGross','discountTotalGross','totalGross','netTotal','taxTotal','shippingGross','shippingDiscountGross'] LOOP
   money:=quote->field;
   IF money IS DISTINCT FROM totals->field THEN EXIT validate; END IF;
   IF money IS NULL AND field IN ('shippingGross','shippingDiscountGross') THEN CONTINUE; END IF;
   IF (jsonb_typeof(money)='object' AND money - ARRAY['currency','amountMinor']='{}'
    AND money->'currency'=to_jsonb(v_currency) AND jsonb_typeof(money->'amountMinor')='number'
    AND money->>'amountMinor' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true THEN EXIT validate; END IF;
   IF (money->>'amountMinor')::bigint>9007199254740991 THEN EXIT validate; END IF;
  END LOOP;
  total:=(payable->>'amountMinor')::bigint;
  shipping:=coalesce((totals#>>'{shippingGross,amountMinor}')::bigint,0);
  IF total<1 OR shipping>2147483647 THEN EXIT validate; END IF;

  IF current_setting('transaction_isolation')<>'repeatable read' OR current_setting('transaction_read_only')<>'off'
   OR NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND mode='ExclusiveLock' AND pid=pg_backend_pid()
      AND classid=((key_lock>>32)&4294967295)::oid AND objid=(key_lock&4294967295)::oid AND objsubid=1)
   OR (SELECT count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND mode='ShareLock' AND granted
       AND relation IN ('public.identity_privacy_erasures'::regclass,'public.catalog_products'::regclass,
        'public.catalog_skus'::regclass,'public.catalog_publication_heads'::regclass,'public.price_lists'::regclass,
        'public.price_entries'::regclass,'public.subscription_price_policy_revisions'::regclass))<>7
  THEN RAISE EXCEPTION 'catalog_admission_fence_unavailable' USING ERRCODE='55000',
    HINT='Check the native binding, connection/TLS, privileges and migrations.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id=p_client AND to_jsonb(principal_id)=original->'actorRef')
    OR EXISTS (SELECT 1 FROM public.commerce_order_draft_receipts WHERE idempotency_key=p_key)
  THEN EXIT validate; END IF;

  FOR position IN 0..1 LOOP
   line:=draft->'lines'->position; binding:=bindings->position; facts:=line->'catalogFacts';
   IF (binding->'skuCode',binding->'quantity',binding->'mode',binding->'skuId',to_jsonb(at_text),to_jsonb(v_currency))
     IS DISTINCT FROM (line->'sku',line->'quantity',facts->'mode',facts->'skuId',facts->'atTime',facts->'currency')
    OR binding->>'mode'<>'subscription' OR (binding->>'skuCode' ~ '^[A-Za-z0-9._:-]{1,128}$') IS DISTINCT FROM true
    OR (binding->>'quantity')::integer NOT BETWEEN 1 AND 99
    OR NOT pg_input_is_valid(line->>'quantity','integer') IS TRUE
    OR (original#>'{selection,lines}')->position IS DISTINCT FROM jsonb_build_object('sku',line->'sku','quantity',line->'quantity')
    OR (facts->>'version' IN ('catalog_facts_v1','catalog_facts_v2')) IS DISTINCT FROM true
    OR NOT pg_input_is_valid(facts->>'basePriceEntryId','uuid') IS TRUE
    OR EXISTS (SELECT 1 FROM (VALUES (line->'unitPriceGross',facts->'resolvedUnitAmountMinor'),
       (line->'lineSubtotalGross',facts->'resolvedLineAmountMinor')) m(value,observed)
      WHERE (jsonb_typeof(value)='object' AND value-ARRAY['amountMinor','currency']='{}'
       AND value->'currency'=to_jsonb(v_currency) AND jsonb_typeof(value->'amountMinor')='number'
       AND pg_input_is_valid(value->>'amountMinor','integer') AND value->'amountMinor'=observed) IS DISTINCT FROM true)
   THEN EXIT validate; END IF;
   IF (line#>>'{unitPriceGross,amountMinor}')::integer<0 OR (line#>>'{lineSubtotalGross,amountMinor}')::bigint
     <> (line->>'quantity')::bigint*(line#>>'{unitPriceGross,amountMinor}')::integer THEN EXIT validate; END IF;
   subtotal:=subtotal+(line#>>'{lineSubtotalGross,amountMinor}')::integer;
   IF NOT EXISTS (SELECT 1 FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
     WHERE s.id=(binding->>'skuId')::uuid AND s.sku=binding->>'skuCode' AND s.status='active' AND p.status='active'
      AND s.sellable_in_subscription AND (line->>'quantity')::integer>=s.min_order_qty AND s.is_addon=(binding->>'role'='addon'))
   THEN RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE='22023',HINT='Use a selection supported on this installation.'; END IF;
   SELECT b.* INTO base FROM public.price_entries b JOIN public.price_lists l ON l.id=b.price_list_id
    WHERE b.id=(facts->>'basePriceEntryId')::uuid AND to_jsonb(b.id)=facts->'basePriceEntryId'
    AND b.variant_id=(binding->>'skuId')::uuid AND b.active
    AND b.mode='one_time' AND b.min_qty=1 AND b.amount_kind='gross' AND to_jsonb(b.unit_price_minor)=facts->'baseUnitAmountMinor'
    AND b.valid_from<=at_time AND (b.valid_to IS NULL OR b.valid_to>at_time) AND l.status='active' AND l.currency=v_currency
    AND l.region_code=original#>>'{contact,country}' AND l.valid_from<=at_time AND (l.valid_to IS NULL OR l.valid_to>at_time);
   IF NOT FOUND OR (list_id IS NOT NULL AND list_id<>base.price_list_id) THEN
    RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE='22023'; END IF;
   list_id:=base.price_list_id;
   IF facts->>'version'='catalog_facts_v2' THEN
    expected_prices:=coalesce(expected_prices,public.catalog_admission_derived_subscription_prices(v_currency,snapshot,draft,at_time));
    IF expected_prices[position+1] IS DISTINCT FROM (line#>>'{unitPriceGross,amountMinor}')::integer THEN
     RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE='22023'; END IF;
   ELSE
    SELECT p.* INTO actual FROM public.price_entries p JOIN public.price_lists l ON l.id=p.price_list_id
     WHERE p.variant_id=base.variant_id AND p.active AND p.amount_kind='gross' AND p.mode IN ('subscription','any')
      AND p.min_qty<=(line->>'quantity')::integer AND p.valid_from<=at_time AND (p.valid_to IS NULL OR p.valid_to>at_time)
      AND l.status='active' AND l.currency=v_currency AND l.valid_from<=at_time AND (l.valid_to IS NULL OR l.valid_to>at_time)
     ORDER BY (p.mode='subscription') DESC,p.min_qty DESC,p.id LIMIT 1;
    IF actual.price_list_id IS DISTINCT FROM list_id OR to_jsonb(actual.id) IS DISTINCT FROM facts->'resolvedPriceEntryId'
     OR to_jsonb(actual.unit_price_minor) IS DISTINCT FROM facts->'resolvedUnitAmountMinor'
     OR EXISTS (SELECT 1 FROM public.subscription_price_policy_revisions r WHERE r.price_list_id=list_id
      AND r.channel='D2C' AND r.effective_from<=at_time AND (r.effective_to IS NULL OR r.effective_to>at_time))
    THEN RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE='22023'; END IF;
   END IF;
   IF binding->>'source'='fresh' THEN selected:=binding;
   ELSIF public.catalog_admission_requires_quote_authority(ARRAY[binding->>'skuCode'],evidence#>>'{offer,version}') THEN
    RAISE EXCEPTION 'catalog_admission_line_ineligible' USING ERRCODE='22023',HINT='Use a selection supported on this installation.';
   END IF;
  END LOOP;

  FOR position IN 1..20 LOOP
   page:=public.catalog_offer_memberships_page(evidence#>>'{offer,version}',
    jsonb_strip_nulls(jsonb_build_object('selectedSkuId',selected->'skuId','continuation',cursor_value)),100,'admission_issue');
   IF page->>'kind' IS DISTINCT FROM 'page' THEN
    RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='22023',
     HINT='Use a selection supported on this installation.'; END IF;
   heads:=heads||coalesce((SELECT jsonb_object_agg(h->>'productId',h) FROM jsonb_array_elements(page#>'{value,consultedHeads}') h),'{}');
   declaring:=coalesce(declaring,(SELECT row FROM jsonb_array_elements(page#>'{value,issues}') row WHERE row->>'kind'='declaring'));
   cursor_value:=page#>'{value,nextCursor}';
   EXIT WHEN cursor_value='null';
  END LOOP;
  IF cursor_value IS DISTINCT FROM 'null'::jsonb OR declaring->'skuRevisionId' IS DISTINCT FROM selected->'skuRevisionId'
   OR (SELECT jsonb_agg(value ORDER BY key COLLATE "C") FROM jsonb_each(heads)) IS DISTINCT FROM evidence->'consultedHeads'
  THEN RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='22023',
    HINT='Use a selection supported on this installation.'; END IF;
  SELECT jsonb_build_object('schemaVersion',2,'skuId',r.sku_id,'skuCode',r.sku_code,'skuRevisionId',r.id,
    'publicationHead',declaring-ARRAY['kind','productId','skuRevisionId'],'typeRef',p.canonical_state::jsonb#>'{product,type}',
    'definitionDigest',p.canonical_state::jsonb#>'{product,definitionDigest}','optionDigest',r.full_facts::jsonb->'optionDigest',
    'netContent',r.full_facts::jsonb->'netContent') || CASE WHEN r.full_facts::jsonb ? 'demandPolicyRef'
     THEN jsonb_build_object('demandPolicyRef',r.full_facts::jsonb->'demandPolicyRef') ELSE '{}'::jsonb END
  INTO selected_ref FROM public.catalog_sku_revisions r JOIN public.catalog_publications p ON p.id=r.publication_id
   WHERE r.id=(selected->>'skuRevisionId')::uuid;
  acceptance:=jsonb_build_object('schemaVersion',2,'lines',jsonb_build_array(selected_ref),'admission',evidence);
  PERFORM public.catalog_acceptance_assert_v2(acceptance);
  basket:=public.catalog_retained_basket_v2(draft->'lines',true);

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(draft->'discounts') d WHERE (CASE WHEN jsonb_typeof(d)='object' THEN
    d-ARRAY['promotionId','appliesTo','amountOffMinor','reasonCode','code','label','customerSemantic']='{}'
    AND jsonb_typeof(d->'promotionId')='string' AND d->>'promotionId' COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    AND d->>'appliesTo' IN ('order_total','shipping') AND jsonb_typeof(d->'amountOffMinor')='number'
    AND d->>'amountOffMinor' ~ '^[1-9][0-9]{0,9}$' AND pg_input_is_valid(d->>'amountOffMinor','integer')
    AND public.catalog_publication_text_valid(d->'reasonCode',120,true) AND (NOT d ? 'code' OR d->'code'='null')
    END) IS DISTINCT FROM true)
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(draft->'discounts') d GROUP BY d->>'promotionId' HAVING count(*)>1)
  THEN EXIT validate; END IF;
  SELECT coalesce(sum(amount_minor) FILTER (WHERE scope='order_total'),0),coalesce(sum(amount_minor) FILTER (WHERE scope='shipping'),0)
   INTO product_discount,shipping_discount FROM (
    SELECT d->>'appliesTo' scope,(d->>'amountOffMinor')::bigint amount_minor FROM jsonb_array_elements(draft->'discounts') d
   ) amounts;
  IF subtotal IS DISTINCT FROM (totals#>>'{subtotalGross,amountMinor}')::bigint
   OR product_discount IS DISTINCT FROM (totals#>>'{discountTotalGross,amountMinor}')::bigint
   OR shipping_discount IS DISTINCT FROM coalesce((totals#>>'{shippingDiscountGross,amountMinor}')::bigint,0)
   OR product_discount>subtotal OR shipping_discount>shipping OR total<>subtotal-product_discount+shipping-shipping_discount
   OR total<>(totals#>>'{netTotal,amountMinor}')::bigint+(totals#>>'{taxTotal,amountMinor}')::bigint
  THEN EXIT validate; END IF;
  FOR discount IN SELECT value FROM jsonb_array_elements(draft->'discounts') ORDER BY value->>'promotionId' COLLATE "C" LOOP
   SELECT * INTO definition FROM public.commerce_promotion_lock_definition(discount->>'promotionId');
   IF definition.promotion_id IS NULL OR NOT definition.active OR definition.definition->>'status' IS DISTINCT FROM 'active'
    OR definition.definition->>'trigger_type' IS DISTINCT FROM 'automatic' OR definition.definition->'eligibility' IS DISTINCT FROM '{}'
    OR definition.definition->>'applies_to_kind' IS DISTINCT FROM 'order_total'
    OR NOT coalesce(definition.definition->'applies_to_payload' IN ('{}','{"cart_mode":"subscription"}'),false)
    OR NOT coalesce(definition.definition->'region_availability' @> jsonb_build_array(original#>'{contact,country}'),false)
    OR definition.definition_fingerprint IS DISTINCT FROM encode(sha256(convert_to(definition.definition::text,'UTF8')),'hex')
    OR definition.definition->>'redemption_limit_global' IS NOT NULL OR definition.definition->>'redemption_limit_per_customer' IS NOT NULL
    OR (definition.definition->>'discount_type'='free_shipping') IS DISTINCT FROM (discount->>'appliesTo'='shipping')
    OR NOT pg_input_is_valid(definition.definition->>'valid_from','timestamptz') IS TRUE
    OR (definition.definition->>'valid_to' IS NOT NULL AND NOT pg_input_is_valid(definition.definition->>'valid_to','timestamptz'))
   THEN RAISE EXCEPTION 'commerce_promotion_definition_not_active' USING ERRCODE='40001'; END IF;
   IF (definition.definition->>'valid_from')::timestamptz>at_time OR NOT isfinite((definition.definition->>'valid_from')::timestamptz)
     OR (definition.definition->>'valid_to')::timestamptz<=at_time OR NOT coalesce(isfinite((definition.definition->>'valid_to')::timestamptz),true)
   THEN RAISE EXCEPTION 'commerce_promotion_definition_not_active' USING ERRCODE='40001'; END IF;
   fingerprints:=fingerprints||jsonb_build_object(definition.promotion_id,definition.definition_fingerprint);
  END LOOP;

  fingerprint:=md5(snapshot::text||'|'||draft::text||'|'||p_client::text);
  order_id:=gen_random_uuid();
  response:=jsonb_build_object('contractVersion','commerce.v0','orderDraft',jsonb_build_object(
   'orderId','order_'||order_id::text,'status','draft','paymentStatus','not_started','idempotencyKey',p_key,'quoteSnapshot',snapshot,'replayed',false));
  INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,created_at,updated_at,
   catalog_acceptance,catalog_basket,catalog_receipt_key,metadata)
  VALUES(order_id,p_client,'pending_payment',v_currency,total,at_time,at_time,acceptance,basket,p_key,jsonb_build_object(
   'paymentStatus','not_started','quoteSnapshot',snapshot,'orderDraftSnapshot',draft,
   'catalogAdmissionSubmit',submit-ARRAY['reviewedPayable','ownerQuoteDigest'],
   'catalogAdmissionOwnerOrigin',jsonb_build_object('schemaVersion',1,'orderId',order_id,'receiptKey',p_key,
    'nativeFingerprint',fingerprint,'ownerQuoteDigest',evidence->'quoteDigest')));
  INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor,created_at,
   source_line_ordinal,catalog_unit_amount_minor,catalog_line_amount_minor,promotion_discount_allocated_minor,promotion_allocation_fingerprint)
  SELECT order_id,c.sku_id,c.line_ordinal,c.quantity,c.unit_amount_minor,c.line_amount_minor,at_time,
   c.source_line_ordinal,c.catalog_unit_amount_minor,c.catalog_line_amount_minor,c.promotion_discount_allocated_minor,c.promotion_allocation_fingerprint
  FROM public.catalog_admission_governed_companions(draft,bindings) c WHERE c.line_ordinal IS NOT NULL ORDER BY c.line_ordinal;
  WITH adjustments AS (
   INSERT INTO public.commerce_order_adjustments(order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint,created_at)
   SELECT order_id,c.kind,c.scope,c.amount_minor,c.promotion_id,fingerprints->>c.promotion_id,at_time
   FROM public.catalog_admission_governed_companions(draft,bindings) c WHERE c.kind IS NOT NULL RETURNING *
  ), claims AS (
   INSERT INTO public.commerce_promotion_claims(promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,amount_off_minor,
    reserved_at,expires_at,updated_at)
   SELECT a.promotion_id,a.definition_fingerprint,a.id,a.order_id,p_client,a.amount_minor,at_time,
    at_time+make_interval(hours=>public.promotion_claim_hold_hours_read()),at_time FROM adjustments a WHERE a.promotion_id IS NOT NULL
   RETURNING id
  )
  INSERT INTO public.commerce_promotion_claim_events(claim_id,event_key,transition,occurred_at)
   SELECT id,'reserved:'||order_id::text,'reserved',at_time FROM claims;
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata,created_at,available_at)
  VALUES('commerce_order',order_id,'commerce.order_draft.created',p_key,jsonb_build_object(
   'orderId','order_'||order_id::text,'orderUuid',order_id,'quoteSnapshot',snapshot,'orderDraftSnapshot',draft),
   jsonb_build_object('boundary','catalog_admission_write_governed_draft'),at_time,at_time);
  INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload,created_at)
  VALUES(p_key,fingerprint,order_id,response,at_time);
  PERFORM public.catalog_order_acceptance_final(order_id);
  RETURN response;
 END validate;
 RAISE EXCEPTION 'catalog_admission_evidence_binding_mismatch' USING ERRCODE='22023',
  HINT='Recover the original purchase evidence with its owner and replay the original request.';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_write_governed_draft(text,uuid,jsonb) FROM PUBLIC;
