-- Native, unbound acceptance. Catalogue writers and existing pricing rules stay unchanged.
CREATE FUNCTION public.catalog_admission_assert_current(
 p_heads jsonb,p_sku_revisions jsonb,p_mode text,p_offer_evidence jsonb,p_price_context_versions jsonb,p_purpose text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selection jsonb; reference jsonb; expected jsonb; price_context jsonb;
 sku public.catalog_skus; product public.catalog_products; publication public.catalog_publications;
 subscription public.subscriptions; retained jsonb; baseline integer; fresh boolean; product_id uuid;
 sized_context jsonb; phase_config jsonb; fresh_ids uuid[] := '{}';
 moved text; missing text; refused text;
BEGIN
 IF p_purpose='order' THEN
  moved:='commerce_order_draft_catalog_head_moved'; missing:='commerce_order_draft_catalog_anchor_missing'; refused:='commerce_order_draft_offer_membership_refused';
 ELSIF p_purpose='account' THEN
  moved:='customer_self_service_stale_edit_catalog_head'; missing:='customer_self_service_invalid_catalog_anchor'; refused:='customer_self_service_invalid_offer_membership';
 ELSE RAISE EXCEPTION 'catalog_propagation_admission_boundary_invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));
 IF jsonb_typeof(p_heads) IS DISTINCT FROM 'array' OR jsonb_typeof(p_sku_revisions) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_heads) NOT BETWEEN 1 AND 100
  OR jsonb_array_length(p_sku_revisions) NOT BETWEEN 1 AND 100
  OR p_mode IS NULL OR p_mode NOT IN ('one_time','subscription')
  OR jsonb_typeof(p_offer_evidence) IS DISTINCT FROM 'object'
  OR nullif(p_offer_evidence->>'offerVersion','') IS NULL
  OR jsonb_typeof(p_price_context_versions) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_price_context_versions)>100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sku_revisions) s
   WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR s-ARRAY['reference','quantity']<>'{}'::jsonb
    OR jsonb_typeof(s->'reference') IS DISTINCT FROM 'object' OR jsonb_typeof(s->'quantity') IS DISTINCT FROM 'number'
    OR coalesce(s->>'quantity','') !~ '^[1-9][0-9]*$')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sku_revisions) s GROUP BY s#>>'{reference,skuId}' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_heads) h GROUP BY h->>'productId' HAVING count(*)>1) THEN
  RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
 IF p_purpose='account' THEN
  -- The accepting writer already holds this row; the assertion never acquires commerce locks.
  SELECT * INTO subscription FROM public.subscriptions WHERE id=(p_offer_evidence->>'subscriptionId')::uuid;
  IF subscription.id IS NULL OR p_mode<>'subscription' OR p_offer_evidence->>'lane' NOT IN ('classic','exact','sized','legacy')
   OR p_offer_evidence->>'lane' IS NULL THEN
   RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
  SELECT catalog_acceptance INTO retained FROM public.subscription_renewal_terms WHERE subscription_id=subscription.id;
  IF p_offer_evidence->>'lane'='sized' AND coalesce(p_offer_evidence->'optIn','false'::jsonb)<>'true'::jsonb THEN
   sized_context:=public.subscription_sized_edit_context(subscription.client_id,subscription.id,false);
   IF sized_context->'marker' IS NOT NULL AND sized_context->'marker'<>'null'::jsonb THEN
    SELECT value_text::jsonb INTO phase_config FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
    IF phase_config IS NULL THEN RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
   END IF;
  END IF;
 END IF;
 FOR product_id IN SELECT DISTINCT s.product_id FROM public.catalog_skus s
  JOIN jsonb_array_elements(p_sku_revisions) r ON s.id=(r#>>'{reference,skuId}')::uuid ORDER BY s.product_id LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-lineage:'||product_id::text,0));
 END LOOP;
 PERFORM h.product_id FROM public.catalog_publication_heads h
  WHERE h.product_id IN (SELECT s.product_id FROM public.catalog_skus s JOIN jsonb_array_elements(p_sku_revisions) r ON s.id=(r#>>'{reference,skuId}')::uuid)
  ORDER BY h.product_id FOR SHARE;
 PERFORM p.id FROM public.catalog_products p
  WHERE p.id IN (SELECT s.product_id FROM public.catalog_skus s JOIN jsonb_array_elements(p_sku_revisions) r ON s.id=(r#>>'{reference,skuId}')::uuid)
  ORDER BY p.id FOR SHARE;
 PERFORM s.id FROM public.catalog_skus s JOIN jsonb_array_elements(p_sku_revisions) r ON s.id=(r#>>'{reference,skuId}')::uuid
  ORDER BY s.id FOR SHARE OF s;
 FOR selection IN SELECT value FROM jsonb_array_elements(p_sku_revisions) ORDER BY value#>>'{reference,skuId}' LOOP
  reference:=selection->'reference';
  PERFORM public.catalog_accepted_reference_assert_v2(reference);
  SELECT * INTO sku FROM public.catalog_skus WHERE id=(reference->>'skuId')::uuid;
  SELECT * INTO product FROM public.catalog_products WHERE id=sku.product_id;
  IF sku.id IS NULL OR product.id IS NULL OR sku.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
   OR product.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN
   RAISE EXCEPTION 'catalog_propagation_head_unreadable' USING ERRCODE='55000'; END IF;
  SELECT h->'head' INTO expected FROM jsonb_array_elements(p_heads) h WHERE h->>'productId'=product.id::text;
  SELECT p.* INTO publication FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id
   WHERE h.product_id=product.id;
  IF publication.id IS NULL OR expected IS NULL OR expected-ARRAY['publicationId','revision','documentDigest']<>'{}'::jsonb
   OR expected->>'publicationId' IS DISTINCT FROM publication.id::text OR expected->'revision' IS DISTINCT FROM to_jsonb(publication.revision)
   OR expected->>'documentDigest' IS DISTINCT FROM (SELECT digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id)
   OR product.publication_facts IS DISTINCT FROM publication.canonical_state::jsonb->'product' THEN
   RAISE EXCEPTION '%',moved USING ERRCODE='40001'; END IF;
  fresh:=true;
  IF p_purpose='account' AND p_offer_evidence->>'lane'='sized' AND coalesce(p_offer_evidence->'optIn','false'::jsonb)<>'true'::jsonb THEN
   SELECT coalesce(sum(quantity),0)::integer INTO baseline FROM public.subscription_lines WHERE subscription_id=subscription.id AND variant_id=sku.id;
   IF sized_context->'marker' IS NOT NULL AND sized_context->'marker'<>'null'::jsonb
    AND (sized_context->>'paidCycleCount')::integer+1=(phase_config->>'graduationCycle')::integer
    AND subscription.template_version=(sized_context#>>'{marker,basisTemplateVersion}')::integer THEN
    SELECT coalesce(sum((l->>'qty')::integer),0)::integer INTO baseline
     FROM jsonb_array_elements(sized_context->'graduationLines') l WHERE l->>'variantId'=sku.id::text;
   END IF;
   fresh:=(selection->>'quantity')::integer>baseline;
  END IF;
  IF NOT fresh THEN
   IF retained IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained->'lines') l WHERE l=reference) THEN
    RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
  ELSE
   fresh_ids:=array_append(fresh_ids,sku.id);
   IF reference->'publicationHead' IS DISTINCT FROM expected
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(publication.canonical_state::jsonb->'skus') r
      WHERE r->>'skuId'=sku.id::text AND r->>'revisionId'=reference->>'skuRevisionId')
    OR sku.publication_facts->>'lifecycleState' IS DISTINCT FROM 'active' OR product.publication_facts->>'lifecycleState' IS DISTINCT FROM 'active'
    OR sku.status<>'active' OR product.status<>'active'
    OR (p_mode='one_time' AND NOT sku.sellable_standalone) OR (p_mode='subscription' AND NOT sku.sellable_in_subscription)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sku.publication_facts->'memberships') m
      WHERE m->>'offerVersion'=p_offer_evidence->>'offerVersion' AND m->'admitted'='true'::jsonb) THEN
    RAISE EXCEPTION '%',refused USING ERRCODE='55000'; END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(fresh_ids) id WHERE
   (SELECT count(*) FROM jsonb_array_elements(p_price_context_versions) p WHERE p->>'skuId'=id::text)<>1) THEN
  RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE='22023'; END IF;
 -- The price writer owns these guards. Exact row bytes bind existing provenance,
 -- including equal-money replacement and validity-window changes.
 FOR price_context IN SELECT value FROM jsonb_array_elements(p_price_context_versions)
  ORDER BY (value->>'priceListId')::uuid,(value->>'skuId')::uuid LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-price-setup:'||((price_context->>'priceListId')::uuid)::text||':'||((price_context->>'skuId')::uuid)::text,0));
 END LOOP;
 PERFORM p.id FROM public.price_lists p WHERE p.id IN
  (SELECT (v->>'priceListId')::uuid FROM jsonb_array_elements(p_price_context_versions) v) ORDER BY p.id FOR SHARE;
 PERFORM p.id FROM public.price_entries p WHERE p.id IN
  (SELECT (v->>'entryId')::uuid FROM jsonb_array_elements(p_price_context_versions) v) ORDER BY p.id FOR SHARE;
 FOR price_context IN SELECT value FROM jsonb_array_elements(p_price_context_versions)
  ORDER BY (value->>'entryId')::uuid LOOP
  IF p_purpose='account' AND price_context->>'priceListId' IS DISTINCT FROM subscription.price_list_id::text THEN
   RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.price_lists WHERE id=(price_context->>'priceListId')::uuid
   AND (p_purpose<>'account' OR currency=subscription.currency_code) AND status='active' AND valid_from<=statement_timestamp() AND (valid_to IS NULL OR valid_to>statement_timestamp());
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.price_entries p WHERE p.id=(price_context->>'entryId')::uuid
   AND p.price_list_id=(price_context->>'priceListId')::uuid AND p.variant_id=(price_context->>'skuId')::uuid
   AND p.active AND p.valid_from<=statement_timestamp() AND (p.valid_to IS NULL OR p.valid_to>statement_timestamp())
   AND to_jsonb(p)=price_context->'entry';
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
 END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) TO service_role'; END IF; END; $$;


CREATE OR REPLACE FUNCTION public.commerce_create_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb; v_catalog_price_entry uuid;
  v_existing public.commerce_order_draft_receipts%ROWTYPE;
  v_fingerprint text;
  v_order_id uuid;
  v_response jsonb;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_expected_price integer;
  v_quantity integer;
  v_unit_price integer;
  v_line_amount integer;
  v_mode text;
  v_currency text;
  v_total bigint;
BEGIN
  IF p_idempotency_key IS NULL
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_quote_snapshot IS NULL OR jsonb_typeof(p_quote_snapshot) <> 'object'
     OR p_order_draft_snapshot IS NULL OR jsonb_typeof(p_order_draft_snapshot) <> 'object'
     OR p_order_draft_snapshot->>'contractVersion' <> 'commerce.v0'
     OR p_order_draft_snapshot->>'source' <> 'commerce.order_draft.bff.v0'
     OR p_order_draft_snapshot->>'status' <> 'draft'
     OR p_order_draft_snapshot->>'paymentStatus' <> 'not_started'
     OR jsonb_typeof(p_order_draft_snapshot->'lines') <> 'array'
     OR jsonb_array_length(p_order_draft_snapshot->'lines') = 0 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_snapshot' USING ERRCODE = '22023';
  END IF;
  IF p_client_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'commerce_order_draft_unknown_client' USING ERRCODE = '22023';
  END IF;

  v_mode := COALESCE(p_order_draft_snapshot#>>'{context,mode}', 'one_time');
  IF v_mode NOT IN ('one_time', 'subscription') THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_mode' USING ERRCODE = '22023';
  END IF;
  v_currency := p_order_draft_snapshot->>'currency';
  v_total := (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint;
  v_fingerprint := md5(
    p_quote_snapshot::text || '|' || p_order_draft_snapshot::text || '|'
    || COALESCE(p_client_id::text, '')
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_existing
    FROM public.commerce_order_draft_receipts
   WHERE idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_fingerprint = v_fingerprint THEN
      RETURN jsonb_set(v_existing.response_payload, '{orderDraft,replayed}', 'true'::jsonb, false);
    END IF;
    RAISE EXCEPTION 'commerce_order_draft_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  -- Governed purchase admission is additive; ungoverned legacy inputs retain their route.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_order_draft_snapshot->'lines') l
    JOIN public.catalog_skus s ON s.sku=l->>'sku' JOIN public.catalog_products p ON p.id=s.product_id
    WHERE s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb) THEN
    v_catalog_evidence:=p_quote_snapshot->'catalogAdmission';
    IF v_catalog_evidence IS NULL THEN
      RAISE EXCEPTION 'commerce_order_draft_catalog_anchor_missing' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'sku',(l->>'quantity')::integer) FROM jsonb_array_elements(p_order_draft_snapshot->'lines') l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuCode}',(l->>'quantity')::integer)
        FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'commerce_order_draft_offer_membership_refused' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions',
      coalesce(p_order_draft_snapshot#>>'{context,mode}','one_time'),
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('offerVersion',public.catalog_price_setup_order_offer_version(p_quote_snapshot)),
      v_catalog_evidence->'priceContextVersions','order');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  FOR v_line IN
    SELECT value FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_price := (v_line#>>'{unitPriceGross,amountMinor}')::integer;
    v_line_amount := (v_line#>>'{lineSubtotalGross,amountMinor}')::integer;
    IF v_quantity <= 0 OR v_unit_price < 0 OR v_line_amount <> v_quantity * v_unit_price THEN
      RAISE EXCEPTION 'commerce_order_draft_invalid_line' USING ERRCODE = '22023';
    END IF;

    SELECT sku.id, price.unit_price_minor, price.id
      INTO v_sku_id, v_expected_price, v_catalog_price_entry
      FROM public.catalog_skus AS sku
      JOIN public.catalog_products AS product
        ON product.id = sku.product_id AND product.status = 'active'
      JOIN public.price_entries AS price
        ON price.variant_id = sku.id
       AND price.active
       AND price.amount_kind = 'gross'
       AND price.mode IN (v_mode, 'any')
       AND price.min_qty <= v_quantity
       AND price.valid_from <= now()
       AND (price.valid_to IS NULL OR price.valid_to > now())
      JOIN public.price_lists AS price_list
        ON price_list.id = price.price_list_id
       AND price_list.status = 'active'
       AND price_list.currency = v_currency
       AND price_list.valid_from <= now()
       AND (price_list.valid_to IS NULL OR price_list.valid_to > now())
     WHERE sku.sku = v_line->>'sku'
       AND sku.status = 'active'
       AND v_quantity >= sku.min_order_qty
       AND (v_mode <> 'subscription' OR sku.sellable_in_subscription)
       AND (v_mode <> 'one_time' OR sku.sellable_standalone)
     ORDER BY (price.mode = v_mode) DESC, price.min_qty DESC, price.id
     LIMIT 1;
    IF NOT FOUND OR v_expected_price <> v_unit_price THEN
      RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE = '22023';
    END IF;
    IF v_catalog_evidence IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_catalog_evidence->'priceContextVersions') c
      WHERE c->>'skuId'=v_sku_id::text AND c->>'entryId'=v_catalog_price_entry::text) THEN
      RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  END LOOP;

  INSERT INTO public.commerce_orders (
    client_id, status, currency_code, total_amount_minor, metadata, catalog_acceptance
  ) VALUES (
    p_client_id, 'pending_payment', v_currency, v_total,
    jsonb_build_object(
      'paymentStatus', 'not_started',
      'quoteSnapshot', p_quote_snapshot,
      'orderDraftSnapshot', p_order_draft_snapshot
    ), v_catalog_acceptance
  ) RETURNING id INTO v_order_id;

  v_line_ordinal := 0;
  FOR v_line IN
    SELECT value FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_price := (v_line#>>'{unitPriceGross,amountMinor}')::integer;
    v_line_amount := (v_line#>>'{lineSubtotalGross,amountMinor}')::integer;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_price, v_line_amount
    );
  END LOOP;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'orderDraft', jsonb_build_object(
      'orderId', 'order_' || v_order_id::text,
      'status', 'draft',
      'paymentStatus', 'not_started',
      'idempotencyKey', p_idempotency_key,
      'quoteSnapshot', p_quote_snapshot,
      'replayed', false
    )
  );

  INSERT INTO public.outbox_events (
    aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata
  ) VALUES (
    'commerce_order', v_order_id, 'commerce.order_draft.created', p_idempotency_key,
    jsonb_build_object(
      'orderId', 'order_' || v_order_id::text,
      'orderUuid', v_order_id,
      'quoteSnapshot', p_quote_snapshot,
      'orderDraftSnapshot', p_order_draft_snapshot
    ),
    jsonb_build_object('boundary', 'commerce_create_order_draft_with_outbox')
  );

  INSERT INTO public.commerce_order_draft_receipts (
    idempotency_key, request_fingerprint, order_id, response_payload
  ) VALUES (
    p_idempotency_key, v_fingerprint, v_order_id, v_response
  );
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_create_promoted_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
  v_receipt public.commerce_order_draft_receipts%ROWTYPE;
  v_response jsonb;
  v_order_id uuid;
  v_discount jsonb;
  v_definition public.commerce_promotion_definitions%ROWTYPE;
  v_adjustment public.commerce_order_adjustments%ROWTYPE;
  v_claim public.commerce_promotion_claims%ROWTYPE;
  v_global bigint;
  v_customer bigint;
  v_global_limit integer;
  v_customer_limit integer;
  v_lines bigint;
  v_order_discount bigint;
  v_shipping bigint;
  v_shipping_discount bigint;
  v_total bigint;
  v_shipping_terms jsonb;
  v_allocation_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_receipt FROM public.commerce_order_draft_receipts
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN
    FOR v_discount IN SELECT value FROM jsonb_array_elements(coalesce(p_order_draft_snapshot->'discounts','[]'::jsonb))
      WHERE value ? 'promotionId' AND coalesce((value->>'amountOffMinor')::bigint,0)>0 ORDER BY value->>'promotionId' LOOP
      PERFORM public.commerce_promotion_lock_definition(v_discount->>'promotionId');
    END LOOP;
  END IF;
  IF FOUND AND v_receipt.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_order_draft_expired' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(sum((line.value#>>'{lineSubtotalGross,amountMinor}')::bigint), 0)
    INTO v_lines
    FROM jsonb_array_elements(p_order_draft_snapshot->'lines') AS line(value);
  SELECT
    COALESCE(sum((discount.value->>'amountOffMinor')::bigint)
      FILTER (WHERE discount.value->>'appliesTo' <> 'shipping'), 0),
    COALESCE(sum((discount.value->>'amountOffMinor')::bigint)
      FILTER (WHERE discount.value->>'appliesTo' = 'shipping'), 0)
    INTO v_order_discount, v_shipping_discount
    FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
      AS discount(value);
  v_shipping := COALESCE((p_order_draft_snapshot#>>'{totals,shippingGross,amountMinor}')::bigint, 0);
  IF v_shipping_discount IS DISTINCT FROM
      COALESCE((p_order_draft_snapshot#>>'{totals,shippingDiscountGross,amountMinor}')::bigint, 0)
    OR v_order_discount IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,discountTotalGross,amountMinor}')::bigint
    OR v_lines IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,subtotalGross,amountMinor}')::bigint THEN
    RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
      AS discount(value)
    WHERE discount.value->>'appliesTo' = 'line'
  ) THEN
    RAISE EXCEPTION 'commerce_promotion_line_allocation_unsupported' USING ERRCODE = '22023';
  END IF;
  v_shipping_terms := p_order_draft_snapshot#>'{context,shippingTerms}';
  IF v_shipping_terms IS NOT NULL THEN
    IF jsonb_typeof(v_shipping_terms) IS DISTINCT FROM 'object'
      OR v_shipping_terms - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb
      OR v_shipping_terms->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
      OR v_shipping_terms->>'currency' IS DISTINCT FROM p_order_draft_snapshot->>'currency'
      OR COALESCE(v_shipping_terms->>'flatMinor','') !~ '^[0-9]{1,10}$'
      OR COALESCE(v_shipping_terms->>'freeThresholdMinor','') !~ '^[0-9]{1,10}$' THEN
      RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
    END IF;
    IF (v_shipping_terms->>'flatMinor')::bigint > 2147483647
      OR (v_shipping_terms->>'freeThresholdMinor')::bigint > 2147483647
      OR v_shipping IS DISTINCT FROM (CASE
        WHEN v_lines - v_order_discount >= (v_shipping_terms->>'freeThresholdMinor')::bigint THEN 0
        ELSE (v_shipping_terms->>'flatMinor')::bigint END) THEN
      RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_total := v_lines + v_shipping - v_order_discount - v_shipping_discount;
  IF v_total IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint THEN
    RAISE EXCEPTION 'commerce_order_draft_money_equation_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'commerce_zero_payable_order_unsupported' USING ERRCODE = '22023';
  END IF;

  IF v_receipt.idempotency_key IS NULL THEN
  -- Governed purchase admission is additive; ungoverned legacy inputs retain their route.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_order_draft_snapshot->'lines') l
    JOIN public.catalog_skus s ON s.sku=l->>'sku' JOIN public.catalog_products p ON p.id=s.product_id
    WHERE s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb) THEN
    v_catalog_evidence:=p_quote_snapshot->'catalogAdmission';
    IF v_catalog_evidence IS NULL THEN
      RAISE EXCEPTION 'commerce_order_draft_catalog_anchor_missing' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'sku',(l->>'quantity')::integer) FROM jsonb_array_elements(p_order_draft_snapshot->'lines') l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuCode}',(l->>'quantity')::integer)
        FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'commerce_order_draft_offer_membership_refused' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions',
      coalesce(p_order_draft_snapshot#>>'{context,mode}','one_time'),
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('offerVersion',public.catalog_price_setup_order_offer_version(p_quote_snapshot)),
      v_catalog_evidence->'priceContextVersions','order');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  END IF;
  v_response := public.commerce_create_order_draft_with_outbox(
    p_idempotency_key, p_quote_snapshot, p_order_draft_snapshot, p_client_id
  );
  IF (v_response#>>'{orderDraft,replayed}')::boolean THEN RETURN v_response; END IF;
  v_order_id := replace(v_response#>>'{orderDraft,orderId}', 'order_', '')::uuid;
  v_allocation_fingerprint := encode(sha256(convert_to(
    p_order_draft_snapshot::text || '|effective-line-allocation.v1', 'UTF8'
  )), 'hex');

  IF v_order_discount > 0 THEN
    DELETE FROM public.commerce_order_items WHERE order_id = v_order_id;
    WITH source_lines AS (
      SELECT
        line.ordinality::integer AS source_ordinal,
        line.value->>'sku' AS sku,
        (line.value->>'quantity')::integer AS quantity,
        (line.value#>>'{unitPriceGross,amountMinor}')::bigint AS catalog_unit,
        (line.value#>>'{lineSubtotalGross,amountMinor}')::bigint AS catalog_line
      FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
        WITH ORDINALITY AS line(value, ordinality)
    ), bases AS (
      SELECT source.*,
        floor((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines)::bigint AS effective_base,
        ((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines)
          - floor((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines) AS fraction
      FROM source_lines AS source
    ), remainder AS (
      SELECT v_lines - v_order_discount - sum(effective_base) AS cents FROM bases
    ), allocated_lines AS (
      SELECT base.*,
        base.effective_base + CASE WHEN row_number() OVER (
          ORDER BY base.fraction DESC, base.source_ordinal
        ) <= remainder.cents THEN 1 ELSE 0 END AS effective_line
      FROM bases AS base CROSS JOIN remainder
    ), split_lines AS (
      SELECT allocated.*,
        allocated.quantity - (allocated.effective_line % allocated.quantity)::integer AS split_quantity,
        allocated.effective_line / allocated.quantity AS effective_unit
      FROM allocated_lines AS allocated
      UNION ALL
      SELECT allocated.*,
        (allocated.effective_line % allocated.quantity)::integer,
        allocated.effective_line / allocated.quantity + 1
      FROM allocated_lines AS allocated
      WHERE allocated.effective_line % allocated.quantity > 0
    ), prepared AS (
      SELECT split.*, sku_row.id AS sku_id,
        row_number() OVER (
          ORDER BY split.source_ordinal, split.effective_unit, split.split_quantity
        )::integer AS final_ordinal
      FROM split_lines AS split
      JOIN public.catalog_skus AS sku_row ON sku_row.sku = split.sku
      WHERE split.split_quantity > 0
    )
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor,
      source_line_ordinal, catalog_unit_amount_minor, catalog_line_amount_minor,
      promotion_discount_allocated_minor, promotion_allocation_fingerprint
    )
    SELECT
      v_order_id, prepared.sku_id, prepared.final_ordinal,
      prepared.split_quantity, prepared.effective_unit,
      prepared.effective_unit * prepared.split_quantity,
      prepared.source_ordinal, prepared.catalog_unit,
      prepared.catalog_unit * prepared.split_quantity,
      (prepared.catalog_unit - prepared.effective_unit) * prepared.split_quantity,
      v_allocation_fingerprint
    FROM prepared ORDER BY prepared.final_ordinal;
  END IF;

  IF v_shipping > 0 THEN
    INSERT INTO public.commerce_order_adjustments (
      order_id, kind, scope, amount_minor
    ) VALUES (v_order_id, 'shipping_charge', 'shipping', v_shipping);
  END IF;

  FOR v_discount IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
    WHERE value ? 'promotionId' AND COALESCE((value->>'amountOffMinor')::bigint, 0) > 0
    ORDER BY value->>'promotionId'
  LOOP
    SELECT * INTO v_definition
    FROM public.commerce_promotion_lock_definition(v_discount->>'promotionId');
    IF v_definition.promotion_id IS NULL OR NOT v_definition.active OR v_definition.definition->>'status' <> 'active' THEN
      RAISE EXCEPTION 'commerce_promotion_definition_not_active' USING ERRCODE = '40001';
    END IF;
    v_global_limit := NULLIF(v_definition.definition->>'redemption_limit_global', '')::integer;
    v_customer_limit := NULLIF(v_definition.definition->>'redemption_limit_per_customer', '')::integer;
    SELECT count(*) FILTER (WHERE status IN ('reserved', 'redeemed')),
      count(*) FILTER (WHERE status IN ('reserved', 'redeemed') AND client_id = p_client_id)
    INTO v_global, v_customer FROM public.commerce_promotion_claims
    WHERE promotion_id = v_definition.promotion_id;
    IF v_global_limit IS NOT NULL AND v_global >= v_global_limit THEN
      RAISE EXCEPTION 'commerce_promotion_global_limit_reached' USING ERRCODE = '40001';
    END IF;
    IF v_customer_limit IS NOT NULL AND p_client_id IS NULL THEN
      RAISE EXCEPTION 'commerce_promotion_client_required' USING ERRCODE = '22023';
    END IF;
    IF v_customer_limit IS NOT NULL AND v_customer >= v_customer_limit THEN
      RAISE EXCEPTION 'commerce_promotion_customer_limit_reached' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.commerce_order_adjustments (
      order_id, kind, scope, amount_minor, promotion_id, definition_fingerprint
    ) VALUES (
      v_order_id, 'promotion_discount', v_discount->>'appliesTo',
      (v_discount->>'amountOffMinor')::bigint,
      v_definition.promotion_id, v_definition.definition_fingerprint
    ) RETURNING * INTO v_adjustment;
    INSERT INTO public.commerce_promotion_claims (
      promotion_id, definition_fingerprint, adjustment_id,
      order_id, client_id, amount_off_minor, expires_at
    ) VALUES (
      v_definition.promotion_id, v_definition.definition_fingerprint, v_adjustment.id,
      v_order_id, p_client_id, v_adjustment.amount_minor, now() + interval '24 hours'
    ) RETURNING * INTO v_claim;
    INSERT INTO public.commerce_promotion_claim_events (claim_id, event_key, transition)
    VALUES (v_claim.id, 'reserved:' || v_order_id::text, 'reserved');
  END LOOP;
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_subscription_apply_bundle_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_accepted_quote_hash text,
  p_core_lines jsonb,
  p_addon_lines jsonb DEFAULT '[]'::jsonb,
  p_composition_constraint jsonb DEFAULT '{}'::jsonb,
  p_cadence_days integer DEFAULT NULL,
  p_expected_template_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
  v_principal_id uuid;
  v_client_id uuid;
  v_command_key text;
  v_key_identity jsonb;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_event_id uuid;
  v_fingerprint text;
  v_line jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF starts_with(p_idempotency_key, 'command:') THEN
    RAISE EXCEPTION 'subscription_command_reserved_idempotency_key' USING ERRCODE = '22023';
  END IF;
  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT client.id INTO v_client_id FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_subscription FROM public.subscriptions
   WHERE id = p_subscription_id AND client_id = v_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_forbidden' USING ERRCODE = '22023';
  END IF;

  v_command_key := 'command:' || encode(sha256(convert_to(
    v_principal_id::text || ':' || p_idempotency_key, 'UTF8')), 'hex');
  v_key_identity := jsonb_build_object('derivation', 'principal-sha256.v1', 'actorId', v_principal_id);

  SELECT * INTO v_existing FROM public.subscription_events
   WHERE subscription_id = v_subscription.id AND idempotency_key = v_command_key;
  IF FOUND THEN
    IF COALESCE(v_existing.payload->'commandKeyIdentity', v_existing.payload#>'{payload,commandKeyIdentity}') IS DISTINCT FROM v_key_identity THEN
      RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
    END IF;
    IF v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
    THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_existing FROM public.subscription_events
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF COALESCE(v_existing.payload->'commandKeyIdentity', v_existing.payload#>'{payload,commandKeyIdentity}') IS NOT NULL THEN
        RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
      END IF;
      IF starts_with(v_existing.event_type, 'subscription.customer_self_service.') THEN
        IF v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
          OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
        THEN
          RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
        END IF;
      ELSE
        -- A system row at the raw key belongs to its producer, never this command.
        v_existing := NULL;
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_quote FROM public.subscription_edit_quotes
   WHERE subscription_id = v_subscription.id AND idempotency_key = v_command_key FOR UPDATE;
  IF FOUND THEN
    IF v_quote.command_key_identity IS DISTINCT FROM v_key_identity THEN
      RAISE EXCEPTION 'subscription_command_ambiguous_idempotency_key' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_quote FROM public.subscription_edit_quotes
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key
       AND command_key_identity IS NULL FOR UPDATE;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    v_fingerprint := public.subscription_bundle_edit_fingerprint(
      v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
      COALESCE(p_composition_constraint, '{}'::jsonb),
      COALESCE(p_cadence_days, v_subscription.cadence_days),
      COALESCE(p_expected_template_version, v_quote.expected_template_version)
    );
    IF v_quote.id IS NULL OR v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
      OR v_quote.quote_hash IS DISTINCT FROM p_accepted_quote_hash
      OR v_quote.request_fingerprint <> v_fingerprint
      OR v_quote.accepted_event_id IS DISTINCT FROM v_existing.id
    THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'customer.self_service.v1',
      'subscriptionAction', jsonb_build_object(
        'subscriptionId', v_subscription.id,
        'action', 'update_bundle',
        'status', 'replayed',
        'subscriptionStatus', v_subscription.status,
        'nextCycleAt', v_subscription.next_cycle_at,
        'templateVersion', v_subscription.template_version,
        'eventId', v_existing.id
      )
    );
  END IF;

  IF v_quote.id IS NULL OR v_quote.quote_hash IS DISTINCT FROM p_accepted_quote_hash THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public.subscription_bundle_edit_fingerprint(
    v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
    COALESCE(p_composition_constraint, '{}'::jsonb),
    COALESCE(p_cadence_days, v_subscription.cadence_days),
    COALESCE(p_expected_template_version, v_subscription.template_version)
  );
  IF v_quote.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_quote.status <> 'previewed' OR v_quote.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.status <> 'active'
    OR v_subscription.template_version <> v_quote.expected_template_version
  THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.next_cycle_at IS NOT NULL
    AND statement_timestamp() >= v_subscription.next_cycle_at
      - make_interval(hours => v_subscription.edit_window_hours)
  THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE = '22023';
  END IF;
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
    v_subscription.id, v_subscription.next_cycle_at
  );

  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=v_subscription.id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_quote.proposed_lines) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=v_subscription.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=p_composition_constraint->'catalogAdmission';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(v_quote.proposed_lines) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',v_subscription.id,'offerVersion',v_subscription.configured_offer_version,'lane','legacy','optIn',false),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id = v_subscription.id;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_quote.proposed_lines)
  LOOP
    INSERT INTO public.subscription_lines (
      subscription_id, variant_id, quantity, sort_order, is_addon,
      unit_price_minor, currency_code
    ) VALUES (
      v_subscription.id,
      (v_line->>'variantId')::uuid,
      (v_line->>'quantity')::integer,
      (v_line->>'sortOrder')::integer,
      (v_line->>'isAddon')::boolean,
      (v_line->>'unitPriceMinor')::bigint,
      v_quote.currency_code
    );
  END LOOP;
  UPDATE public.subscriptions SET
    cadence_days = v_quote.proposed_cadence_days,
    template_version = template_version + 1,
    updated_at = statement_timestamp()
  WHERE id = v_subscription.id RETURNING * INTO v_subscription;

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_subscription.id,
    'subscription.customer_self_service.update_bundle',
    v_command_key,
    jsonb_build_object(
      'action', 'update_bundle',
      'commandKeyIdentity', v_key_identity,
      'quoteHash', v_quote.quote_hash,
      'templateVersion', v_subscription.template_version,
      'newTotalMinor', v_quote.new_total_minor,
      'currency', v_quote.currency_code
    ),
    statement_timestamp()
  ) RETURNING id INTO v_event_id;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=v_subscription.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=v_event_id;
  END IF;
  UPDATE public.subscription_edit_quotes SET
    status = 'accepted', accepted_event_id = v_event_id,
    accepted_at = statement_timestamp()
  WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'contractVersion', 'customer.self_service.v1',
    'subscriptionAction', jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'action', 'update_bundle',
      'status', 'applied',
      'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at,
      'templateVersion', v_subscription.template_version,
      'eventId', v_event_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_package_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 core jsonb; addons jsonb; stored jsonb; line_pricing jsonb; constraint_value jsonb;
 plan integer; version integer; minimum_text text; minimum_units integer; line jsonb; ordinal integer:=0;
 core_matches boolean; addon_matches boolean; outcome text:='applied';
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,
  'action','update_package_template','payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 core:=p_payload->'baseLines'; addons:=COALESCE(p_payload->'addonLines','[]'::jsonb);
 IF jsonb_typeof(core) IS DISTINCT FROM 'array' OR jsonb_array_length(core)=0 OR jsonb_typeof(addons)<>'array' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT value_text INTO minimum_text FROM public.commerce_settings WHERE key='subscription_minimum_base_units';
 IF minimum_text IS NULL OR minimum_text !~ '^[1-9][0-9]*$' OR length(minimum_text)>10 THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END IF;
 BEGIN minimum_units:=minimum_text::integer;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END;
 IF (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<minimum_units THEN
  RAISE EXCEPTION 'subscription_edit_below_minimum_order_units' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 -- Bind the fingerprinted customer request to its server enrichment. Nominal
 -- cadence/version are intentionally server-resolved; price evidence is ledger-bound below.
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,base}'),
  public.subscription_quote_variant_qty_request(p_payload->'base'));
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,addons}'),
  public.subscription_quote_variant_qty_request(p_payload->'addons'));
 plan:=(p_payload->>'planDays')::integer;
 -- Set equality is order/price independent and aggregates repeated variants.
 SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
 INTO core_matches,addon_matches FROM (
  SELECT is_addon,jsonb_typeof(wanted)='array' AND
   (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
    SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$' GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id
     AND is_addon=inputs.is_addon GROUP BY variant_id) current_lines)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') AS matches
  FROM (VALUES(false,core),(true,addons)) inputs(is_addon,wanted)
 ) line_sets;
 IF plan=s.cadence_days AND core_matches AND addon_matches THEN outcome:='noop';
 ELSE
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,'update_package_template',
   p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'planDays',q#>'{request_payload,planDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'base'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,base}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'addons'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,addons}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(core),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,baseLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(addons),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,addonLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'currentRecurringPrice',q#>'{totals,currentRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'newRecurringPrice',q#>'{totals,newRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'delta',q#>'{totals,delta}');
  IF plan IS NULL OR plan<1 THEN RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023'; END IF;
  constraint_value:=q#>'{quote_snapshot,compositionConstraint}';
  IF constraint_value IS NULL THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  IF p_payload ? 'compositionConstraint' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',constraint_value);
  END IF;
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(core||addons) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=s.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=q#>'{quote_snapshot,catalogAdmission}';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(core||addons) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','classic','optIn',false),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  constraint_value:=NULLIF(constraint_value,'null'::jsonb);
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  line_pricing:='[]'::jsonb;
  FOR line IN SELECT v||jsonb_build_object('isAddon',ord>jsonb_array_length(core))
   FROM jsonb_array_elements(core||addons) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
    (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,
   template_version=template_version+1,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.update_package_template',event_key,
    jsonb_build_object('action','update_package_template','quotePreviewId',q->>'id','linePricing',line_pricing,
     'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=s.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=v_catalog_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action','update_package_template','subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_line_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 lines jsonb; line jsonb; line_pricing jsonb:='[]'::jsonb; constraint_value jsonb;
 version integer; plan integer; ordinal integer:=0; target_id uuid; new_line_id uuid;
 base_matches boolean; outcome text:='applied'; base_set boolean;
 current_total bigint; desired_total bigint;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('swap_base_line','add_addon','remove_addon','update_addon_quantity',
  'update_plan_length','update_base_mix','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,action}',to_jsonb(p_action));
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 lines:=p_payload->'lines';
 base_set:=p_action IN ('update_plan_length','update_base_mix','update_portion');
 IF base_set AND jsonb_typeof(lines)='array' THEN
  SELECT (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
   SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(lines) v
   WHERE (v->>'isAddon')::boolean=false GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon
     GROUP BY variant_id) current_lines) INTO base_matches;
 END IF;
 IF p_action='swap_base_line' THEN
  IF (p_payload#>>'{request,fromVariantId}')::uuid=(p_payload#>>'{request,toVariantId}')::uuid THEN outcome:='noop'; END IF;
 ELSIF p_action IN ('add_addon','update_addon_quantity') THEN
  IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon
   AND variant_id=(p_payload#>>'{request,variantId}')::uuid AND quantity=(p_payload#>>'{request,qty}')::integer) THEN outcome:='noop'; END IF;
 ELSIF p_action='update_base_mix' THEN
  IF base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_plan_length' THEN
  IF (p_payload#>>'{request,planDays}')::integer=s.cadence_days AND base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_portion' THEN
  IF base_matches AND COALESCE(s.composition_constraint->>'mode',p_payload#>>'{portionModes,full,mode}')=p_payload#>>'{request,portionMode}'
   AND COALESCE(s.composition_constraint->'portionFactor',p_payload#>'{portionModes,full,factor}')=p_payload#>'{compositionConstraint,portionFactor}' THEN outcome:='noop'; END IF;
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,p_action,p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal((p_payload->'request')-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',q#>'{quote_snapshot,compositionConstraint}');
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=s.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=q#>'{quote_snapshot,catalogAdmission}';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(lines) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','exact','optIn',false),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  plan:=s.cadence_days; constraint_value:=s.composition_constraint;
  IF p_action='swap_base_line' THEN
   IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,toVariantId}')::uuid) THEN
    RAISE EXCEPTION 'subscription_edit_conflict_duplicate_line' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET variant_id=(p_payload#>>'{request,toVariantId}')::uuid,
    catalog_sku_revision_id=(SELECT (ref->>'skuRevisionId')::uuid FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref
      WHERE ref->>'skuId'=p_payload#>>'{request,toVariantId}'),updated_at=p_now
    WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,fromVariantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_line' USING ERRCODE='22023'; END IF;
  ELSIF p_action='add_addon' THEN
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(p_payload#>>'{request,variantId}')::uuid,GREATEST(1,COALESCE((p_payload#>>'{request,qty}')::integer,1)),
    COALESCE((SELECT max(sort_order)+1 FROM public.subscription_lines WHERE subscription_id=s.id),1),true,0,s.currency_code)
   RETURNING id INTO new_line_id;
  ELSIF p_action='remove_addon' THEN
   DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_addon_quantity' THEN
   IF (p_payload#>>'{request,qty}')::integer IS NULL OR (p_payload#>>'{request,qty}')::integer<=0 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_addon_qty' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET quantity=(p_payload#>>'{request,qty}')::integer,updated_at=p_now
    WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_plan_length' THEN
   plan:=(p_payload#>>'{request,planDays}')::integer;
   IF plan IS NULL OR plan<=0 THEN RAISE EXCEPTION 'subscription_edit_invalid_plan_length' USING ERRCODE='22023'; END IF;
   constraint_value:=NULLIF(q#>'{quote_snapshot,compositionConstraint}','null'::jsonb);
  ELSIF p_action='update_base_mix' THEN
   SELECT COALESCE(sum(quantity),0) INTO current_total FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
   SELECT COALESCE(sum((v->>'qty')::integer),0) INTO desired_total FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
   IF desired_total<>current_total THEN RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_portion' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'portionModes',q#>'{quote_snapshot,portionModes}');
   IF p_payload#>>'{request,portionMode}' IS NULL OR
    (p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,full,mode}'
     AND p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,reduced,mode}')
    OR p_payload#>>'{compositionConstraint,mode}' IS DISTINCT FROM p_payload#>>'{request,portionMode}'
    OR jsonb_typeof(p_payload#>'{compositionConstraint,portionFactor}') IS DISTINCT FROM 'number'
    OR (p_payload#>>'{compositionConstraint,portionFactor}')::numeric<=0
    OR p_payload#>'{compositionConstraint,portionFactor}' IS DISTINCT FROM (CASE
      WHEN p_payload#>>'{request,portionMode}'=p_payload#>>'{portionModes,full,mode}' THEN p_payload#>'{portionModes,full,factor}'
      ELSE p_payload#>'{portionModes,reduced,factor}' END) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_portion_mode' USING ERRCODE='22023'; END IF;
   constraint_value:=jsonb_set(jsonb_set(COALESCE(s.composition_constraint,'{}'::jsonb),'{mode}',p_payload#>'{compositionConstraint,mode}'),
    '{portionFactor}',p_payload#>'{compositionConstraint,portionFactor}');
  END IF;
  IF base_set THEN DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon; END IF;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF base_set AND NOT (line->>'isAddon')::boolean THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
    VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,false,
     (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code) RETURNING id INTO target_id;
   ELSE
    target_id:=COALESCE((line->>'lineId')::uuid,new_line_id);
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
     currency_code=s.currency_code,updated_at=p_now WHERE id=target_id AND subscription_id=s.id
     AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer AND is_addon=(line->>'isAddon')::boolean;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=s.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=v_catalog_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_sized_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 action text; request jsonb; command jsonb; fingerprint text; answer jsonb; q jsonb; lines jsonb; line jsonb;
 event_id uuid; event_key text; line_pricing jsonb:='[]'::jsonb; version integer; plan integer; ordinal integer:=0;
 constraint_value jsonb; opt_in boolean; intro jsonb; phase_config jsonb; paid integer;
 current_core jsonb; desired_core jsonb; outcome text:='applied'; rewrites_addons boolean;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'request') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 request:=p_payload->'request'; action:=request->>'action';
 IF action IS NULL OR action NOT IN ('resize_bundle','update_bundle','update_base_mix','update_plan_length','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',action,'payload',request);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM request->>'acceptedQuoteHash' THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 opt_in:=action='resize_bundle' AND request#>>'{resizeLever,kind}'='subscription.sized.parcel'
  AND request#>'{resizeLever,value,optInToSized}'='true'::jsonb;
 IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND COALESCE(opt_in,false)) THEN
  RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 intro:=public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}';
 IF intro IS NOT NULL THEN
  SELECT value_text::jsonb INTO phase_config FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
  IF phase_config IS NULL OR COALESCE(phase_config->>'fixedThroughCycle','') !~ '^[1-9][0-9]*$'
   OR COALESCE(phase_config->>'graduationCycle','') !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO paid FROM public.subscription_cycles WHERE subscription_id=s.id AND status='paid';
  IF paid+1<=(phase_config->>'fixedThroughCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
  IF COALESCE(opt_in,false) AND s.template_version=(intro->>'basisTemplateVersion')::integer
   AND paid<(phase_config->>'graduationCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
 END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(request->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 lines:=p_payload->'lines'; constraint_value:=p_payload->'compositionConstraint'; plan:=(p_payload->>'cadenceDays')::integer;
 IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0
  OR jsonb_typeof(constraint_value) IS DISTINCT FROM 'object' OR plan IS NULL OR plan<=0 THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) INTO current_core FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
 SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb) INTO desired_core FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
 rewrites_addons:=action='update_bundle' AND request ? 'addonLines';
 IF action IN ('update_base_mix','update_bundle') AND (action='update_base_mix' OR plan=s.cadence_days)
  AND (SELECT sum((v->>'qty')::integer) FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean)
   <>(SELECT sum(quantity) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
  RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(opt_in,false) AND current_core=desired_core AND plan=s.cadence_days AND constraint_value=s.composition_constraint
  AND (NOT rewrites_addons OR (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean)=(SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb)
    FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon)) THEN outcome:='noop';
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,action,request->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(request-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(constraint_value,q#>'{quote_snapshot,compositionConstraint}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'subjectFacts',q#>'{quote_snapshot,subjectFacts}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'optInFacts',q#>'{quote_snapshot,optInFacts}');
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l
    JOIN public.catalog_skus sk ON sk.id=(l->>'variantId')::uuid JOIN public.catalog_products p ON p.id=sk.product_id
    WHERE sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
    OR EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus sk ON sk.id=sl.variant_id
      JOIN public.catalog_products p ON p.id=sk.product_id WHERE sl.subscription_id=s.id
      AND (sl.catalog_sku_revision_id IS NOT NULL OR sk.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
    v_catalog_evidence:=q#>'{quote_snapshot,catalogAdmission}';
    IF v_catalog_evidence IS NULL THEN RAISE EXCEPTION 'customer_self_service_invalid_catalog_anchor' USING ERRCODE='22023'; END IF;
    IF (SELECT jsonb_object_agg(l->>'variantId',coalesce(l->'qty',l->'quantity')) FROM jsonb_array_elements(lines) l)
      IS DISTINCT FROM (SELECT jsonb_object_agg(l#>>'{reference,skuId}',l->'quantity') FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l) THEN
      RAISE EXCEPTION 'customer_self_service_invalid_offer_membership' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','sized','optIn',coalesce(opt_in,false)),
      v_catalog_evidence->'priceContextVersions','account');
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  -- Admission is current SKU state under a row lock; no catalogue publication head exists here.
  FOR line IN SELECT v FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean LOOP
   IF COALESCE(opt_in,false) OR (line->>'qty')::integer>COALESCE((current_core->>(line->>'variantId'))::integer,0) THEN
    PERFORM 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND status='active' AND sellable_in_subscription FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_invalid_sku_admission' USING ERRCODE='22023'; END IF;
   END IF;
  END LOOP;
  IF NOT rewrites_addons AND (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean) IS DISTINCT FROM
   (SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon) THEN
   RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND (NOT is_addon OR rewrites_addons);
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF line#>>'{quoteLine,unitPriceGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>>'{quoteLine,lineSubtotalGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>'{quoteLine,quantity}' IS DISTINCT FROM line->'qty'
    OR line#>'{quoteLine,lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb((line->>'qty')::bigint*(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint)
    OR NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND sku=line#>>'{quoteLine,sku}') THEN
    RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   IF NOT (line->>'isAddon')::boolean OR rewrites_addons THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
     VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
      (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   ELSE
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,updated_at=p_now
     WHERE subscription_id=s.id AND id=(line->>'lineId')::uuid AND is_addon AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    VALUES(s.id,ordinal,line#>>'{quoteLine,sku}',(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint);
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}','quantity',(line->>'qty')::integer,
    'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  -- AFTER-row triggers run at statement end. The CTE makes native FK-bound
  -- acceptance visible before the binding trigger checks the accepted join.
  WITH inserted AS (
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||action,event_key,jsonb_build_object('action',action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',request-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],'optInFacts',p_payload->'optInFacts',
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now) RETURNING id
   ), accepted AS MATERIALIZED (
    SELECT id,public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,id,p_now) AS acceptance FROM inserted
   ) SELECT id INTO event_id FROM accepted;
 END IF;
  IF v_catalog_acceptance IS NOT NULL THEN
    UPDATE public.subscription_lines sl SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
      FROM jsonb_array_elements(v_catalog_acceptance->'lines') ref WHERE sl.subscription_id=s.id AND sl.variant_id=(ref->>'skuId')::uuid;
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=v_catalog_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=v_catalog_acceptance WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,request->>'acceptedQuoteHash',answer,outcome);
 RETURN answer;
END;
$$;
