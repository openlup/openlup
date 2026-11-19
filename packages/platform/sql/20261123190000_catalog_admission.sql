-- Native, unbound acceptance. Catalogue writers and existing pricing rules stay unchanged.
-- The native delivery schedule exposes renewal ordinals from its owner.
CREATE FUNCTION public.catalog_admission_logical_cycle(p_subscription_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT coalesce(min(cycle_number+1) FILTER (WHERE status IN ('planned','payment_pending','payment_failed','retry_scheduled')),
  max(cycle_number)+2,(SELECT count(*)::integer+1 FROM public.subscription_cycles
   WHERE subscription_id=p_subscription_id AND status='paid'))
 FROM public.subscription_delivery_alignment_cycles WHERE subscription_id=p_subscription_id
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_logical_cycle(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.subscription_sized_edit_context(p_client_id uuid,p_subscription_id uuid,p_opt_in boolean)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; terms jsonb; prices jsonb; initial_quote jsonb; marker jsonb;
 lines jsonb:='[]'::jsonb; graduation jsonb:='[]'::jsonb; row_line record; price jsonb; quoted jsonb; entry jsonb;
 count_matches integer; paid integer;
BEGIN
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND p_opt_in IS TRUE) THEN
  RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 terms:=public.subscription_renewal_purchase_terms(s.id)->'renewalTerms';
 SELECT e.payload->'linePricing' INTO prices FROM public.subscription_events e WHERE e.subscription_id=s.id
  AND e.event_type IN ('subscription.starter_graduated','subscription.customer_self_service.update_package_template',
   'subscription.customer_self_service.swap_base_line','subscription.customer_self_service.add_addon',
   'subscription.customer_self_service.remove_addon','subscription.customer_self_service.update_addon_quantity',
   'subscription.customer_self_service.update_plan_length','subscription.customer_self_service.update_base_mix',
   'subscription.customer_self_service.update_portion','subscription.customer_self_service.resize_bundle',
   'subscription.customer_self_service.update_bundle') ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1;
 prices:=COALESCE(prices,terms->'linePricing');
 IF prices IS NULL THEN
  SELECT o.metadata#>'{quoteSnapshot,quote,lines}' INTO initial_quote FROM public.subscription_activations a
   JOIN public.commerce_orders o ON o.id=a.order_id WHERE a.subscription_id=s.id;
  IF jsonb_typeof(initial_quote) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(jsonb_build_object('sku',v->>'sku','quantity',v->'quantity',
   'unitAmountMinor',v#>'{unitPriceGross,amountMinor}','quoteLine',v)) INTO prices FROM jsonb_array_elements(initial_quote) v;
 END IF;
 IF jsonb_typeof(prices) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
 FOR row_line IN SELECT l.*,sku.sku,sku.product_id FROM public.subscription_lines l
  JOIN public.catalog_skus sku ON sku.id=l.variant_id WHERE l.subscription_id=s.id ORDER BY l.sort_order,l.variant_id LOOP
  SELECT count(*) INTO count_matches FROM jsonb_array_elements(prices) v WHERE v->>'sku'=row_line.sku;
  IF count_matches<>1 THEN RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  SELECT v INTO price FROM jsonb_array_elements(prices) v WHERE v->>'sku'=row_line.sku;
  quoted:=price->'quoteLine';
  IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines t WHERE t.subscription_id=s.id AND t.sku=row_line.sku
   AND t.quantity=row_line.quantity AND t.unit_amount_minor=row_line.unit_price_minor) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  IF price->'quantity' IS DISTINCT FROM to_jsonb(row_line.quantity) OR price->'unitAmountMinor' IS DISTINCT FROM to_jsonb(row_line.unit_price_minor)
   OR quoted->>'sku' IS DISTINCT FROM row_line.sku OR quoted->'quantity' IS DISTINCT FROM to_jsonb(row_line.quantity)
   OR quoted#>'{unitPriceGross,amountMinor}' IS DISTINCT FROM to_jsonb(row_line.unit_price_minor)
   OR quoted#>>'{unitPriceGross,currency}' IS DISTINCT FROM row_line.currency_code
   OR quoted#>>'{lineSubtotalGross,currency}' IS DISTINCT FROM row_line.currency_code
   OR quoted#>'{lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb(row_line.quantity*row_line.unit_price_minor)
   OR (price ? 'isAddon' AND price->'isAddon' IS DISTINCT FROM to_jsonb(row_line.is_addon)) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  lines:=lines||jsonb_build_array(jsonb_build_object('lineId',row_line.id,'variantId',row_line.variant_id,
   'sku',row_line.sku,'groupId',row_line.product_id,'qty',row_line.quantity,'isAddon',row_line.is_addon,'quoteLine',quoted));
 END LOOP;
 IF jsonb_array_length(lines)=0 THEN RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
 marker:=terms->'starterPack';
 IF marker IS NOT NULL THEN
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR jsonb_typeof(marker#>'{graduation,lines}') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_marker' USING ERRCODE='22023'; END IF;
  FOR entry IN SELECT v FROM jsonb_array_elements(marker#>'{graduation,lines}') v LOOP
   SELECT id,product_id INTO row_line FROM public.catalog_skus WHERE sku=entry->>'sku';
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
   graduation:=graduation||jsonb_build_array(jsonb_build_object('lineId',NULL,'variantId',row_line.id,
    'sku',entry->>'sku','groupId',row_line.product_id,'qty',entry->'qty','isAddon',entry->'isAddon','quoteLine',entry->'quoteLine'));
  END LOOP;
 END IF;
 SELECT count(*)::integer INTO paid FROM public.subscription_cycles WHERE subscription_id=s.id AND status='paid';
 RETURN jsonb_build_object('subscriptionId',s.id,'clientId',s.client_id,'binding',s.configured_offer_version,
  'templateVersion',s.template_version,'cadenceDays',s.cadence_days,'compositionConstraint',s.composition_constraint,
  'nextCycleAt',s.next_cycle_at,'paidCycleCount',paid,'logicalUpcomingCycle',public.catalog_admission_logical_cycle(s.id),
  'marker',marker,'lines',lines,'graduationLines',graduation);
END;
$$;

CREATE FUNCTION public.catalog_admission_sized_baseline(p_subscription_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions; context jsonb; phase jsonb; upcoming integer; phase_proof jsonb;
BEGIN
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id;
 context:=public.subscription_sized_edit_context(s.client_id,s.id,false);
 IF context->'marker' IS NOT NULL AND context->'marker'<>'null'::jsonb THEN
  SELECT value_text::jsonb INTO phase FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
  IF phase IS NULL THEN RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
  upcoming:=(context->>'logicalUpcomingCycle')::integer;
  IF upcoming=(phase->>'graduationCycle')::integer
   AND s.template_version=(context#>>'{marker,basisTemplateVersion}')::integer THEN
   phase_proof:=public.catalog_admission_graduation_proof(s.id);
   RETURN (SELECT coalesce(jsonb_agg(CASE WHEN r.ref IS NULL THEN l ELSE l||jsonb_build_object('catalogReference',r.ref) END),'[]')
       FROM jsonb_array_elements(context->'graduationLines') l LEFT JOIN LATERAL (
        SELECT ref FROM jsonb_array_elements(phase_proof->'lines') ref WHERE ref->>'skuId'=l->>'variantId') r ON true
       WHERE l->'isAddon'='false'::jsonb)
      || (SELECT coalesce(jsonb_agg(l),'[]') FROM jsonb_array_elements(context->'lines') l WHERE l->'isAddon'='true'::jsonb);
  END IF;
 END IF;
 RETURN context->'lines';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_sized_baseline(uuid) FROM PUBLIC;

-- Preserve the legacy bundle quote owner's row selection and whole amount.
CREATE FUNCTION public.catalog_admission_legacy_price(p_list_id uuid,p_sku_id uuid,p_quantity integer,p_at timestamptz)
RETURNS public.price_entries LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p.* FROM public.price_entries p
 WHERE p.variant_id=p_sku_id AND p.price_list_id=p_list_id
  AND p.mode IN ('subscription','any') AND p.active AND p.min_qty<=p_quantity
  AND p.valid_from<=p_at AND (p.valid_to IS NULL OR p.valid_to>p_at)
 ORDER BY CASE p.mode WHEN 'subscription' THEN 0 ELSE 1 END,p.min_qty DESC,p.valid_from DESC,p.id
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_legacy_price(uuid,uuid,integer,timestamptz) FROM PUBLIC;

-- The sized quote owner keeps an exact agreement on explicit opt-in. Fresh
-- eligibility still uses the target offer and the current publication head.
CREATE FUNCTION public.catalog_admission_keeps_price(p_subscription_id uuid,p_sku_id uuid,p_quantity integer,p_addon boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=p_subscription_id
  AND l.variant_id=p_sku_id AND l.quantity=p_quantity AND l.is_addon=p_addon)
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_keeps_price(uuid,uuid,integer,boolean) FROM PUBLIC;

-- Use one canonical live-state check for acceptance and governed readers.
-- The caller owns publication ordering and snapshot selection.
CREATE FUNCTION public.catalog_admission_verified_heads(p_products uuid[],p_sized_command boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE product_id uuid; product public.catalog_products; publication public.catalog_publications;
 manifest jsonb; document_digest text; actual_heads jsonb:='{}';
BEGIN
 FOREACH product_id IN ARRAY p_products LOOP
  SELECT * INTO product FROM public.catalog_products WHERE id=product_id;
  SELECT p.* INTO publication FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON p.id=h.publication_id
   WHERE h.product_id=product.id;
  IF publication.id IS NULL AND p_sized_command THEN
   RAISE EXCEPTION 'customer_self_service_invalid_catalog_head' USING ERRCODE='55000'; END IF;
  SELECT digest INTO document_digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id;
  manifest:=publication.canonical_state::jsonb;
  IF publication.id IS NULL OR document_digest IS NULL OR manifest->'schemaVersion' IS DISTINCT FROM '3'::jsonb
   OR encode(sha256(convert_to(publication.canonical_state,'UTF8')),'hex') IS DISTINCT FROM publication.digest
   OR product.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
   OR product.publication_facts IS DISTINCT FROM manifest->'product'
   OR product.slug IS DISTINCT FROM manifest#>>'{product,slug}'
   OR product.name IS DISTINCT FROM manifest#>>'{product,name}'
   OR product.status IS DISTINCT FROM manifest#>>'{product,status}'
   OR product.primary_sku_id::text IS DISTINCT FROM manifest#>>'{product,primarySkuId}'
   OR product.current_document_revision_id IS DISTINCT FROM publication.document_revision_id
   OR publication.document_revision_id::text IS DISTINCT FROM manifest#>>'{product,document,id}'
   OR document_digest IS DISTINCT FROM manifest#>>'{product,document,digest}'
   OR jsonb_typeof(manifest->'skus') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_propagation_head_unreadable' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM public.catalog_skus sk WHERE sk.product_id=product.id)<>jsonb_array_length(manifest->'skus')
   OR (SELECT count(DISTINCT member->>'skuId') FROM jsonb_array_elements(manifest->'skus') member)<>jsonb_array_length(manifest->'skus')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'skus') member
    LEFT JOIN public.catalog_sku_revisions r ON r.product_id=product.id AND r.id::text=member->>'revisionId'
      AND to_jsonb(r.revision)=member->'revision' AND r.digest=member->>'digest'
    LEFT JOIN public.catalog_skus sk ON sk.product_id=product.id AND sk.id=r.sku_id AND sk.id::text=member->>'skuId'
    LEFT JOIN public.catalog_type_versions def ON (def.type_key,def.version)=(product.type_key,product.type_version)
    WHERE r.id IS NULL OR sk.id IS NULL OR sk.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
      OR encode(sha256(convert_to(r.full_facts,'UTF8')),'hex') IS DISTINCT FROM r.digest
      OR sk.publication_facts IS DISTINCT FROM r.full_facts::jsonb
      OR sk.sku IS DISTINCT FROM sk.publication_facts->>'code'
      OR sk.title IS DISTINCT FROM sk.publication_facts->>'title'
      OR sk.status IS DISTINCT FROM sk.publication_facts->>'status'
      OR to_jsonb(sk.min_order_qty) IS DISTINCT FROM sk.publication_facts->'minQuantity'
      OR to_jsonb(sk.is_addon) IS DISTINCT FROM sk.publication_facts->'isAddon'
      OR to_jsonb(sk.sellable_standalone) IS DISTINCT FROM sk.publication_facts->'sellableStandalone'
      OR to_jsonb(sk.sellable_in_subscription) IS DISTINCT FROM sk.publication_facts->'sellableInSubscription'
      OR jsonb_build_object('dimension',sk.net_content_dimension,'unscaled',sk.net_content_unscaled::text,
        'scale',sk.net_content_scale,'unit',sk.net_content_unit) IS DISTINCT FROM sk.publication_facts->'netContent'
      OR sk.net_weight_g::numeric IS DISTINCT FROM sk.net_content_unscaled/power(10::numeric,sk.net_content_scale)
        * CASE sk.net_content_unit WHEN 'openlup:g' THEN 1 WHEN 'openlup:kg' THEN 1000 ELSE (
         SELECT (u#>>'{factor,unscaled}')::numeric/power(10::numeric,(u#>>'{factor,scale}')::integer)
         FROM jsonb_array_elements(def.definition->'units') u
         WHERE u->>'code'=sk.net_content_unit AND u#>>'{factor,canonicalUnit}'='openlup:g'
        ) END) THEN
   RAISE EXCEPTION 'catalog_propagation_head_unreadable' USING ERRCODE='55000'; END IF;
  actual_heads:=actual_heads||jsonb_build_object(product.id::text,jsonb_build_object('publicationId',publication.id,
   'revision',publication.revision,'documentDigest',document_digest));
 END LOOP;
 RETURN actual_heads;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_verified_heads(uuid[],boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_assert_current(
 p_heads jsonb,p_sku_revisions jsonb,p_mode text,p_offer_evidence jsonb,p_price_context_versions jsonb,p_purpose text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selection jsonb; reference jsonb; expected jsonb; price_context jsonb;
 sku public.catalog_skus; product public.catalog_products; publication public.catalog_publications;
 subscription public.subscriptions; retained jsonb; baseline jsonb; scope_demand jsonb; demand jsonb; phase_reference jsonb;
 fresh boolean; product_id uuid; fresh_ids uuid[] := '{}'; retained_ids uuid[] := '{}'; agreed_price_ids uuid[] := '{}';
 retained_prices jsonb; prices jsonb; scoped_skus uuid[]; price_key record;
 consulted uuid[]; actual_heads jsonb;
 moved text; missing text; refused text;
BEGIN
 IF p_purpose='order' THEN
  moved:='commerce_order_draft_catalog_head_moved'; missing:='commerce_order_draft_catalog_anchor_missing'; refused:='commerce_order_draft_offer_membership_refused';
 ELSIF p_purpose='account' THEN
  moved:='customer_self_service_stale_edit_catalog_head'; missing:='customer_self_service_invalid_catalog_anchor'; refused:='customer_self_service_invalid_offer_membership';
 ELSE RAISE EXCEPTION 'catalog_propagation_admission_boundary_invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));
 -- Accepting writers supply the scope resolved from their owned lines. A direct
 -- assertion checks its named heads before a selection can widen their scope.
 consulted:='{}';
 IF p_offer_evidence->'scopeSkuIds' IS NULL AND jsonb_typeof(p_heads)='array' THEN
  SELECT coalesce(array_agg(DISTINCT p.id ORDER BY p.id),'{}') INTO consulted
   FROM public.catalog_products p JOIN jsonb_array_elements(p_heads) h
    ON p.id=CASE WHEN pg_input_is_valid(h->>'productId','uuid') THEN (h->>'productId')::uuid END
   WHERE p.publication_facts->'schemaVersion'='3'::jsonb;
 END IF;
 IF cardinality(consulted)=0 THEN
  SELECT coalesce(array_agg(DISTINCT s.product_id ORDER BY s.product_id),'{}') INTO consulted
  FROM public.catalog_skus s JOIN jsonb_array_elements(CASE
     WHEN jsonb_typeof(p_offer_evidence->'scopeSkuIds')='array' THEN p_offer_evidence->'scopeSkuIds'
     WHEN jsonb_typeof(p_sku_revisions)='array' THEN
       (SELECT jsonb_agg(v#>'{reference,skuId}') FROM jsonb_array_elements(p_sku_revisions) v)
     ELSE '[]'::jsonb END) v
    ON s.id=CASE WHEN pg_input_is_valid(v#>>'{}','uuid') THEN (v#>>'{}')::uuid END;
 END IF;
 FOREACH product_id IN ARRAY consulted LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-lineage:'||product_id::text,0));
 END LOOP;
 PERFORM h.product_id FROM public.catalog_publication_heads h WHERE h.product_id=ANY(consulted)
  ORDER BY h.product_id FOR SHARE;
 PERFORM p.id FROM public.catalog_products p WHERE p.id=ANY(consulted) ORDER BY p.id FOR SHARE;
 -- Mixed sized edits retain the existing sellability read for legacy lines.
 -- Acquire those SKU rows in the same order, before any price guard.
 PERFORM s.id FROM public.catalog_skus s WHERE s.product_id=ANY(consulted) OR
  (p_offer_evidence->>'lane'='sized' AND (p_offer_evidence->'legacySkuIds') ? s.id::text)
  ORDER BY s.id FOR SHARE;
 actual_heads:=public.catalog_admission_verified_heads(consulted,p_purpose='account' AND p_offer_evidence->'sizedCommand'='true'::jsonb);
 IF p_purpose='account' AND pg_input_is_valid(p_offer_evidence->>'subscriptionId','uuid') THEN
  SELECT * INTO subscription FROM public.subscriptions WHERE id=(p_offer_evidence->>'subscriptionId')::uuid;
  IF subscription.id IS NOT NULL AND p_offer_evidence->>'lane'='sized' AND p_offer_evidence->'optIn' IS DISTINCT FROM 'true'::jsonb THEN
   baseline:=public.catalog_admission_sized_baseline(subscription.id);
  END IF;
 END IF;
 IF baseline IS NOT NULL THEN
  scope_demand:=p_offer_evidence->'scopeDemand';
  IF scope_demand IS NULL AND jsonb_typeof(p_sku_revisions)='array' THEN
   SELECT jsonb_agg(jsonb_build_object('skuId',l#>'{reference,skuId}','quantity',l->'quantity','isAddon',false))
    INTO scope_demand FROM jsonb_array_elements(p_sku_revisions) l;
  END IF;
  SELECT coalesce(array_agg(DISTINCT (d->>'skuId')::uuid),'{}') INTO retained_ids
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(scope_demand)='array' THEN scope_demand ELSE '[]'::jsonb END) d
  WHERE pg_input_is_valid(d->>'skuId','uuid') AND pg_input_is_valid(d->>'quantity','integer')
   AND (d->>'quantity')::integer<=(SELECT coalesce(sum((b->>'qty')::integer),0)
    FROM jsonb_array_elements(baseline) b WHERE b->>'variantId'=d->>'skuId' AND b->'isAddon'=d->'isAddon');
 END IF;
 -- The authority read precedes agreement classification. A retained SKU
 -- still keeps its immutable reference and carries no current admission head.
 IF cardinality(retained_ids)>0 THEN
  SELECT coalesce(array_agg(DISTINCT s.product_id ORDER BY s.product_id),'{}') INTO consulted
  FROM public.catalog_skus s
  JOIN jsonb_array_elements(scope_demand) d
   ON s.id=CASE WHEN pg_input_is_valid(d->>'skuId','uuid') THEN (d->>'skuId')::uuid END
  WHERE s.product_id=ANY(consulted) AND s.id<>ALL(retained_ids);
  SELECT coalesce(jsonb_object_agg(k,v),'{}') INTO actual_heads FROM jsonb_each(actual_heads) h(k,v) WHERE k::uuid=ANY(consulted);
 END IF;
 IF p_purpose='account' AND p_offer_evidence->'clearSelection'='true'::jsonb AND cardinality(consulted)=0
  AND p_heads='[]'::jsonb AND p_sku_revisions='[]'::jsonb AND p_price_context_versions='[]'::jsonb THEN RETURN; END IF;
 IF jsonb_typeof(p_heads) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_heads)>100
  OR (cardinality(consulted)=0 AND cardinality(retained_ids)=0)
  OR jsonb_array_length(p_heads)<>cardinality(consulted)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_heads) h
   WHERE jsonb_typeof(h) IS DISTINCT FROM 'object' OR h-ARRAY['productId','head']<>'{}'::jsonb
    OR NOT coalesce(actual_heads ? (h->>'productId'),false)
    OR jsonb_typeof(h->'head') IS DISTINCT FROM 'object' OR (h->'head')-ARRAY['publicationId','revision','documentDigest']<>'{}'::jsonb
    OR jsonb_typeof(h#>'{head,publicationId}') IS DISTINCT FROM 'string'
    OR NOT coalesce(pg_input_is_valid(h#>>'{head,publicationId}','uuid'),false)
    OR jsonb_typeof(h#>'{head,revision}') IS DISTINCT FROM 'number'
    OR NOT coalesce(h#>>'{head,revision}' ~ '^[1-9][0-9]*$' AND pg_input_is_valid(h#>>'{head,revision}','integer'),false)
    OR jsonb_typeof(h#>'{head,documentDigest}') IS DISTINCT FROM 'string'
    OR NOT coalesce(h#>>'{head,documentDigest}' ~ '^[0-9a-f]{64}$',false))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_heads) h GROUP BY h->>'productId' HAVING count(*)>1) THEN
  RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_heads) h WHERE h->'head' IS DISTINCT FROM actual_heads->(h->>'productId')) THEN
  RAISE EXCEPTION '%',moved USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_sku_revisions) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION '%',refused USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_sku_revisions) NOT BETWEEN 1 AND 100
  OR p_mode IS NULL OR p_mode NOT IN ('one_time','subscription')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sku_revisions) s
   WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR s-ARRAY['reference','quantity']<>'{}'::jsonb
    OR jsonb_typeof(s->'reference') IS DISTINCT FROM 'object'
    OR NOT coalesce(pg_input_is_valid(s#>>'{reference,skuId}','uuid'),false)
    OR jsonb_typeof(s->'quantity') IS DISTINCT FROM 'number'
    OR NOT coalesce(s->>'quantity' ~ '^[1-9][0-9]*$' AND pg_input_is_valid(s->>'quantity','integer'),false))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sku_revisions) s GROUP BY (s#>>'{reference,skuId}')::uuid HAVING count(*)>1) THEN
  RAISE EXCEPTION '%',refused USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_offer_evidence->'scopeSkuIds')='array' AND
  (SELECT array_agg((requested_line#>>'{reference,skuId}')::uuid ORDER BY (requested_line#>>'{reference,skuId}')::uuid)
   FROM jsonb_array_elements(p_sku_revisions) requested_line) IS DISTINCT FROM
  (SELECT array_agg(id::uuid ORDER BY id::uuid) FROM jsonb_array_elements_text(p_offer_evidence->'scopeSkuIds') id) THEN
  RAISE EXCEPTION '%',refused USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_offer_evidence) IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_offer_evidence->'offerVersion') IS DISTINCT FROM 'string' OR nullif(p_offer_evidence->>'offerVersion','') IS NULL
  OR jsonb_typeof(p_price_context_versions) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_price_context_versions)>100 THEN RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
 IF p_purpose='account' THEN
  -- The accepting writer already holds this row; the assertion never acquires commerce locks.
  IF subscription.id IS NULL OR p_mode<>'subscription' OR p_offer_evidence->>'lane' NOT IN ('classic','exact','sized','legacy')
   OR p_offer_evidence->>'lane' IS NULL THEN
   RAISE EXCEPTION '%',missing USING ERRCODE='22023'; END IF;
  SELECT catalog_acceptance INTO retained FROM public.subscription_renewal_terms WHERE subscription_id=subscription.id;
 END IF;
 FOR selection IN SELECT value FROM jsonb_array_elements(p_sku_revisions) ORDER BY value#>>'{reference,skuId}' LOOP
  reference:=selection->'reference';
  SELECT * INTO sku FROM public.catalog_skus WHERE id=(reference->>'skuId')::uuid;
  SELECT * INTO product FROM public.catalog_products WHERE id=sku.product_id;
  IF sku.id IS NULL OR product.id IS NULL THEN RAISE EXCEPTION '%',refused USING ERRCODE='55000'; END IF;
  PERFORM public.catalog_accepted_reference_assert_v2(reference);
  expected:=actual_heads->(product.id::text);
  SELECT p.* INTO publication FROM public.catalog_publications p WHERE p.id=(expected->>'publicationId')::uuid;
  fresh:=sku.id<>ALL(retained_ids);
  IF NOT fresh THEN
   SELECT b->'catalogReference' INTO phase_reference FROM jsonb_array_elements(baseline) b
    WHERE b->>'variantId'=sku.id::text AND b ? 'catalogReference';
   IF (phase_reference IS NOT NULL AND reference IS DISTINCT FROM phase_reference)
    OR (phase_reference IS NULL AND (retained IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained->'lines') l WHERE l=reference))) THEN
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
      WHERE m->>'offerVersion'=p_offer_evidence->>'offerVersion'
      HAVING count(*)=1 AND bool_or(m->'admitted'='true'::jsonb)) THEN
    RAISE EXCEPTION '%',refused USING ERRCODE='55000'; END IF;
  END IF;
 END LOOP;
 IF p_purpose='account' AND p_offer_evidence->>'lane'='sized' AND p_offer_evidence->'optIn'='true'::jsonb THEN
  SELECT coalesce(array_agg((l#>>'{reference,skuId}')::uuid),'{}') INTO agreed_price_ids
  FROM jsonb_array_elements(p_sku_revisions) l
  WHERE public.catalog_admission_keeps_price(subscription.id,(l#>>'{reference,skuId}')::uuid,(l->>'quantity')::integer,
   EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_offer_evidence->'scopeDemand')='array'
    THEN p_offer_evidence->'scopeDemand' ELSE '[]'::jsonb END) d
    WHERE d->>'skuId'=l#>>'{reference,skuId}' AND d->'isAddon'='true'::jsonb));
 END IF;
 retained_prices:=coalesce(p_offer_evidence->'retainedPriceContextVersions','[]'::jsonb);
 IF jsonb_typeof(retained_prices) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE='22023'; END IF;
 prices:=p_price_context_versions||retained_prices;
 IF jsonb_array_length(prices)>100
  OR EXISTS(SELECT 1 FROM unnest(fresh_ids) id WHERE id<>ALL(agreed_price_ids)
   AND (SELECT count(*) FROM jsonb_array_elements(p_price_context_versions) p WHERE p->>'skuId'=id::text)<>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_price_context_versions) p
   WHERE NOT coalesce((CASE WHEN pg_input_is_valid(p->>'skuId','uuid') THEN (p->>'skuId')::uuid END)=ANY(fresh_ids),false))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(retained_prices) p
   WHERE NOT coalesce((CASE WHEN pg_input_is_valid(p->>'skuId','uuid') THEN (p->>'skuId')::uuid END)=ANY(retained_ids),false))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(prices) p
   WHERE NOT coalesce(pg_input_is_valid(p->>'priceListId','uuid'),false)
      OR NOT coalesce(pg_input_is_valid(p->>'entryId','uuid'),false) OR jsonb_typeof(p->'entry') IS DISTINCT FROM 'object'
      OR (p ? 'policy' AND (p_purpose<>'account' OR p_mode<>'subscription' OR p_offer_evidence->>'lane'='legacy'
       OR jsonb_typeof(p->'policy') IS DISTINCT FROM 'object' OR (p->'policy')-ARRAY['revisionId','digest']<>'{}'::jsonb
       OR NOT coalesce(pg_input_is_valid(p#>>'{policy,revisionId}','uuid'),false)
       OR NOT coalesce(p#>>'{policy,digest}' ~ '^[0-9a-f]{64}$',false))))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(prices) p GROUP BY (p->>'skuId')::uuid HAVING count(*)>1) THEN
  RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE='22023'; END IF;
 -- The price writer owns these guards. Exact row bytes bind existing provenance,
 -- including equal-money replacement and validity-window changes.
 SELECT coalesce(array_agg(id),'{}') INTO scoped_skus FROM unnest(fresh_ids) id;
 FOR price_key IN
  SELECT DISTINCT keys.list_id,keys.sku_id FROM (
   SELECT (v->>'priceListId')::uuid AS list_id,(v->>'skuId')::uuid AS sku_id FROM jsonb_array_elements(prices) v
   UNION ALL
   SELECT l.id,scope.sku_id FROM public.price_lists l CROSS JOIN unnest(scoped_skus) scope(sku_id)
    WHERE p_purpose='order' AND l.currency=p_offer_evidence->>'currency'
  ) keys ORDER BY keys.list_id,keys.sku_id
 LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-price-setup:'||price_key.list_id::text||':'||price_key.sku_id::text,0));
 END LOOP;
 PERFORM p.id FROM public.price_lists p WHERE p.id IN
  (SELECT (v->>'priceListId')::uuid FROM jsonb_array_elements(prices) v) ORDER BY p.id FOR SHARE;
 PERFORM p.id FROM public.price_entries p WHERE p.id IN
  (SELECT (v->>'entryId')::uuid FROM jsonb_array_elements(prices) v) ORDER BY p.id FOR SHARE;
 -- The policy writer serializes its effective windows with this context
 -- guard. Read its MVCC row while holding the guard and no policy row lock.
 FOR price_key IN
  SELECT DISTINCT p.id,p.region_code,p.currency FROM public.price_lists p
  JOIN jsonb_array_elements(prices) v ON p.id=(v->>'priceListId')::uuid AND v ? 'policy'
  ORDER BY p.id,p.region_code,p.currency
 LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|',price_key.id::text,price_key.region_code,price_key.currency,'D2C'),0));
 END LOOP;
 FOR price_context IN SELECT value FROM jsonb_array_elements(prices) ORDER BY (value->>'entryId')::uuid LOOP
  SELECT l INTO demand FROM jsonb_array_elements(p_sku_revisions) l WHERE l#>>'{reference,skuId}'=price_context->>'skuId';
  IF p_purpose='account' AND price_context->>'priceListId' IS DISTINCT FROM subscription.price_list_id::text THEN
   RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.price_lists WHERE id=(price_context->>'priceListId')::uuid
   AND (p_purpose<>'account' OR currency=subscription.currency_code) AND status='active' AND valid_from<=statement_timestamp() AND (valid_to IS NULL OR valid_to>statement_timestamp());
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.price_entries p WHERE p.id=(price_context->>'entryId')::uuid
   AND p.price_list_id=(price_context->>'priceListId')::uuid AND p.variant_id=(price_context->>'skuId')::uuid
   AND ((NOT (price_context ? 'policy') AND p.mode IN (p_mode,'any')) OR
    (price_context ? 'policy' AND p.mode='one_time' AND p.min_qty=1))
   AND p.min_qty<=(demand->>'quantity')::integer
   AND (p_purpose<>'order' OR p.amount_kind='gross')
   AND p.active AND p.valid_from<=statement_timestamp() AND (p.valid_to IS NULL OR p.valid_to>statement_timestamp())
   AND to_jsonb(p)=price_context->'entry';
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  IF price_context ? 'policy' AND NOT EXISTS(
   SELECT 1 FROM public.subscription_price_policy_revisions r
   JOIN public.price_lists p ON (r.price_list_id,r.region_code,r.currency)=(p.id,p.region_code,p.currency)
   WHERE r.id=(price_context#>>'{policy,revisionId}')::uuid AND r.price_list_id=(price_context->>'priceListId')::uuid
    AND r.channel='D2C' AND r.digest=price_context#>>'{policy,digest}'
    AND r.effective_from<=statement_timestamp() AND (r.effective_to IS NULL OR r.effective_to>statement_timestamp())
    AND r.digest=public.catalog_price_setup_policy_digest(r.id,r.revision_no,r.price_list_id,r.region_code,r.currency,r.channel,
      r.effective_from,CASE WHEN r.closed_from_open THEN NULL ELSE r.effective_to END,r.discount_bps,r.rounding_quantum_minor,r.rounding_rule)
  ) THEN RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
  IF p_offer_evidence->>'lane'='legacy' AND (public.catalog_admission_legacy_price(subscription.price_list_id,
    (price_context->>'skuId')::uuid,(demand->>'quantity')::integer,statement_timestamp())).id IS DISTINCT FROM (price_context->>'entryId')::uuid THEN
   RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
 END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM PUBLIC;


-- Walk the predecessor's membership page once for all native producers.
CREATE FUNCTION public.catalog_admission_members(offer_version text,p_mode text,scope uuid[],p_require_all boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE page jsonb; item jsonb; sku_id uuid; cursor_id uuid; head_digest text; page_limit constant integer:=100;
 maximum_members integer:=CASE WHEN offer_version='sized.v1' THEN 1000 ELSE 500 END;
 seen_ids uuid[]:='{}'; seen_codes text[]:='{}'; members jsonb:='{}'; projected jsonb; heads jsonb;
BEGIN
 IF cardinality(scope)=0 THEN RETURN members; END IF;
 IF to_regprocedure('public.catalog_offer_memberships_page(text,uuid,integer,text,text)') IS NULL THEN
  RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
 LOOP
  page:=public.catalog_offer_memberships_page(offer_version,cursor_id,page_limit,p_mode,head_digest);
  IF page->>'protocol' IS DISTINCT FROM 'governed' OR NOT coalesce(page->>'headDigest' ~ '^[0-9a-f]{64}$',false)
   OR (head_digest IS NOT NULL AND page->>'headDigest' IS DISTINCT FROM head_digest)
   OR jsonb_typeof(page->'items') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(page->'items')>page_limit
   OR cardinality(seen_ids)+jsonb_array_length(page->'items')>maximum_members THEN
   RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
  head_digest:=page->>'headDigest';
  FOR item IN SELECT value FROM jsonb_array_elements(page->'items') LOOP
   sku_id:=CASE WHEN pg_input_is_valid(item->>'skuId','uuid') THEN (item->>'skuId')::uuid END;
   IF sku_id IS NULL OR nullif(item->>'skuCode','') IS NULL OR sku_id=ANY(seen_ids) OR item->>'skuCode'=ANY(seen_codes)
    OR (p_mode='one_time' AND item->'sellableStandalone' IS DISTINCT FROM 'true'::jsonb)
    OR (p_mode='subscription' AND item->'sellableInSubscription' IS DISTINCT FROM 'true'::jsonb)
    OR (cardinality(seen_ids)>0 AND sku_id<=seen_ids[cardinality(seen_ids)]) THEN
    RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
   seen_ids:=array_append(seen_ids,sku_id); seen_codes:=array_append(seen_codes,item->>'skuCode');
   IF scope IS NULL OR sku_id=ANY(scope) THEN members:=members||jsonb_build_object(sku_id::text,item); END IF;
  END LOOP;
  IF page->>'nextCursor' IS NOT NULL AND (
    jsonb_array_length(page->'items')<>page_limit
    OR NOT coalesce(pg_input_is_valid(page->>'nextCursor','uuid'),false)
    OR page->>'nextCursor' IS DISTINCT FROM seen_ids[cardinality(seen_ids)]::text) THEN
   RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
  EXIT WHEN scope IS NOT NULL AND scope <@ seen_ids;
  IF page->>'nextCursor' IS NULL THEN
   IF p_require_all THEN RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
   EXIT;
  END IF;
  cursor_id:=(page->>'nextCursor')::uuid;
 END LOOP;
 SELECT coalesce(jsonb_object_agg(k,m||jsonb_build_object('isAddon',r.full_facts::jsonb->'isAddon',
   'primarySkuId',p.canonical_state::jsonb#>'{product,primarySkuId}')),'{}') INTO projected
 FROM jsonb_each(members) AS member(k,m)
 JOIN public.catalog_sku_revisions r ON r.id::text=m->>'skuRevisionId' AND r.sku_id::text=k AND r.product_id::text=m->>'productId'
 JOIN public.catalog_publications p ON p.id::text=m#>>'{head,publicationId}' AND p.product_id=r.product_id;
 IF (SELECT count(*) FROM jsonb_object_keys(projected))<>(SELECT count(*) FROM jsonb_object_keys(members)) THEN
  RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
 heads:=public.catalog_admission_verified_heads(ARRAY(
  SELECT DISTINCT (m->>'productId')::uuid FROM jsonb_each(projected) member(k,m) ORDER BY 1),false);
 IF EXISTS(SELECT 1 FROM jsonb_each(projected) member(k,m) WHERE m->'head' IS DISTINCT FROM heads->(m->>'productId')) THEN
  RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001'; END IF;
 RETURN projected;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_members(text,text,uuid[],boolean) FROM PUBLIC;

-- The phase quote must already carry the exact publication stamp. Membership
-- validation observes the stamp under the same shared publication guard.
CREATE FUNCTION public.catalog_admission_capture_graduation(p_quote jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE marker jsonb; phase_lines jsonb; scope uuid[]; members jsonb; entry record; member jsonb;
 sku_facts jsonb; product_facts jsonb; reference jsonb; refs jsonb:='[]';
BEGIN
 marker:=p_quote#>'{quote,context,starterRenewalTerms,starterPack}';
 phase_lines:=marker#>'{graduation,lines}';
 IF p_quote#>>'{quote,context,mode}' IS DISTINCT FROM 'subscription' OR jsonb_typeof(phase_lines) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO scope
 FROM jsonb_array_elements(phase_lines) l JOIN public.catalog_skus s ON s.sku=l->>'sku'
 JOIN public.catalog_products p ON p.id=s.product_id
 WHERE (s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)
 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_quote#>'{quote,lines}') purchase WHERE purchase->>'sku'=s.sku);
 IF cardinality(scope)=0 THEN RETURN NULL; END IF;
 IF jsonb_array_length(phase_lines)>100 OR cardinality(scope)<>(SELECT count(DISTINCT id) FROM unnest(scope) id)
 OR jsonb_typeof(marker->'basisTemplateVersion') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'catalog_graduation_reference_invalid' USING ERRCODE='22023'; END IF;
 members:=public.catalog_admission_members(public.catalog_price_setup_order_offer_version(p_quote),'subscription',scope,true);
 FOR entry IN SELECT s.id,s.product_id,l FROM jsonb_array_elements(phase_lines) l
  JOIN public.catalog_skus s ON s.sku=l->>'sku' AND s.id=ANY(scope) ORDER BY s.id LOOP
  member:=members->entry.id::text;
  IF entry.l#>'{quoteLine,catalogFacts,publication}' IS DISTINCT FROM
     jsonb_build_object('productId',entry.product_id,'skuRevisionId',member->'skuRevisionId','head',member->'head')
   OR entry.l#>>'{quoteLine,catalogFacts,skuId}' IS DISTINCT FROM entry.id::text
   OR entry.l#>'{quoteLine,catalogFacts,documentRevisionId}' IS DISTINCT FROM member#>'{document,id}'
   OR entry.l#>'{quoteLine,catalogFacts,documentDigest}' IS DISTINCT FROM member#>'{head,documentDigest}' THEN
   RAISE EXCEPTION 'catalog_graduation_publication_head_moved' USING ERRCODE='40001'; END IF;
  SELECT r.full_facts::jsonb,p.canonical_state::jsonb->'product' INTO STRICT sku_facts,product_facts
  FROM public.catalog_sku_revisions r JOIN public.catalog_publications p ON p.product_id=r.product_id
  WHERE r.id=(member->>'skuRevisionId')::uuid AND p.id=(member#>>'{head,publicationId}')::uuid;
  reference:=jsonb_build_object('schemaVersion',2,'skuId',entry.id,'skuCode',member->'skuCode',
   'skuRevisionId',member->'skuRevisionId','publicationHead',member->'head','typeRef',product_facts->'type',
   'definitionDigest',product_facts->'definitionDigest','optionDigest',sku_facts->'optionDigest','netContent',sku_facts->'netContent');
  IF sku_facts->'demandPolicyRef' IS NOT NULL AND sku_facts->'demandPolicyRef'<>'null'::jsonb THEN
   reference:=reference||jsonb_build_object('demandPolicyRef',sku_facts->'demandPolicyRef'); END IF;
  PERFORM public.catalog_accepted_reference_assert_v2(reference);
  refs:=refs||jsonb_build_array(reference);
 END LOOP;
 RETURN jsonb_build_object('schemaVersion',1,'phase','graduation','markerDigest',encode(sha256(convert_to(marker::text,'UTF8')),'hex'),
  'proof',jsonb_build_object('schemaVersion',2,'lines',refs));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_capture_graduation(jsonb) FROM PUBLIC;

-- Only the governed portion of a host discovery roster is publication scoped.
-- Legacy facts and their interpretation remain with the host.
CREATE FUNCTION public.catalog_admission_candidate_members(p_sku_ids uuid[],p_offer_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE governed uuid[]; members jsonb;
BEGIN
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO governed FROM public.catalog_skus s
 JOIN public.catalog_products p ON p.id=s.product_id WHERE s.id=ANY(p_sku_ids)
 AND (s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb);
 IF cardinality(governed)=0 THEN RETURN jsonb_build_object('governed',to_jsonb(governed),'members','{}'::jsonb); END IF;
 IF cardinality(governed)>1000 OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
  RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
 members:=public.catalog_admission_members(p_offer_version,'subscription',governed,false);
 RETURN jsonb_build_object('governed',to_jsonb(governed),'members',members);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_candidate_members(uuid[],text) FROM PUBLIC;

-- One evidence builder for native quote and preview producers. The membership
-- page is provided by the governed publication reads forward. An installation
-- without that forward cannot produce governed evidence.
CREATE FUNCTION public.catalog_admission_build_evidence(p_lines jsonb,p_mode text,p_binding jsonb,p_purpose text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE desired jsonb; baseline jsonb; retained_prices jsonb:='[]'; scope uuid[]; requested jsonb; line jsonb;
 member jsonb; offer_version text; quoted_heads jsonb; members jsonb:='{}';
 heads jsonb:='{}'; selections jsonb:='[]'; prices jsonb:='[]'; price public.price_entries;
 retained jsonb; reference jsonb; sku_facts jsonb; product_facts jsonb; sku_id uuid; price_id text; keep_price boolean; price_context jsonb; phase_reference jsonb;
BEGIN
 IF p_purpose NOT IN ('order','account') OR p_purpose IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'catalog_propagation_admission_boundary_invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));
 SELECT coalesce(jsonb_agg(l||jsonb_build_object('skuId',s.id,'productId',p.id) ORDER BY s.id),'[]'),
  coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO desired,scope
 FROM jsonb_array_elements(p_lines) l JOIN public.catalog_skus s
  ON CASE WHEN p_purpose='order' THEN s.sku=l->>'sku' ELSE s.id=CASE WHEN pg_input_is_valid(l->>'variantId','uuid') THEN (l->>'variantId')::uuid END END
 JOIN public.catalog_products p ON p.id=s.product_id
 WHERE s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb;
 IF cardinality(scope)=0 THEN
  IF p_purpose='account' AND EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus s ON s.id=sl.variant_id
   JOIN public.catalog_products p ON p.id=s.product_id WHERE sl.subscription_id::text=p_binding->>'subscriptionId'
    AND (sl.catalog_sku_revision_id IS NOT NULL OR s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb)) THEN
   RETURN jsonb_build_object('heads','[]'::jsonb,'skuRevisions','[]'::jsonb,'priceContextVersions','[]'::jsonb,'offerEvidence',p_binding,'mode',p_mode,'purpose',p_purpose);
  END IF;
  RETURN NULL;
 END IF;
 IF cardinality(scope)>100 OR cardinality(scope)<>(SELECT count(DISTINCT id) FROM unnest(scope) id) THEN
  RAISE EXCEPTION 'catalog_admission_evidence_selection_invalid' USING ERRCODE='22023'; END IF;
 IF p_purpose='account' AND p_binding->>'lane'='sized' AND p_binding->'optIn' IS DISTINCT FROM 'true'::jsonb THEN
  baseline:=public.catalog_admission_sized_baseline((p_binding->>'subscriptionId')::uuid);
  SELECT catalog_acceptance INTO retained FROM public.subscription_renewal_terms WHERE subscription_id=(p_binding->>'subscriptionId')::uuid;
  SELECT coalesce(array_agg((l->>'skuId')::uuid),'{}') INTO scope FROM jsonb_array_elements(desired) l
   WHERE (coalesce(l->>'qty',l->>'quantity'))::integer>(SELECT coalesce(sum((a->>'qty')::integer),0)
    FROM jsonb_array_elements(baseline) a WHERE a->>'variantId'=l->>'skuId' AND a->'isAddon'=coalesce(l->'isAddon','false'::jsonb));
 END IF;
 offer_version:=CASE WHEN p_purpose='order' THEN public.catalog_price_setup_order_offer_version(p_binding->'quoteSnapshot') ELSE p_binding->>'offerVersion' END;
 IF cardinality(scope)>0 THEN
  members:=public.catalog_admission_members(offer_version,p_mode,scope,true);
 END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(desired) LOOP
  requested:=coalesce(line#>'{quoteLine,catalogFacts}',line->'catalogFacts');
  sku_id:=(line->>'skuId')::uuid;
  keep_price:=p_purpose='account' AND p_binding->>'lane'='sized' AND p_binding->'optIn'='true'::jsonb
   AND public.catalog_admission_keeps_price((p_binding->>'subscriptionId')::uuid,sku_id,
    coalesce(line->>'qty',line->>'quantity')::integer,coalesce((line->>'isAddon')::boolean,false));
  IF sku_id=ANY(scope) THEN
  member:=members->(line->>'skuId');
  SELECT r.full_facts::jsonb,b.canonical_state::jsonb->'product' INTO sku_facts,product_facts
  FROM public.catalog_sku_revisions r JOIN public.catalog_publications b ON b.product_id=r.product_id
  WHERE r.id=(member->>'skuRevisionId')::uuid AND r.sku_id=(line->>'skuId')::uuid
   AND b.id=(member#>>'{head,publicationId}')::uuid AND b.product_id=(line->>'productId')::uuid;
  IF NOT FOUND OR member->>'productId' IS DISTINCT FROM line->>'productId'
   OR member->>'skuCode' IS DISTINCT FROM sku_facts->>'code'
   OR member->'document' IS DISTINCT FROM product_facts->'document'
   OR member#>>'{head,documentDigest}' IS DISTINCT FROM product_facts#>>'{document,digest}' THEN
   RAISE EXCEPTION 'catalog_admission_membership_authority_unavailable' USING ERRCODE='55000'; END IF;
  IF requested IS NOT NULL AND keep_price IS NOT TRUE AND (requested->>'skuId' IS DISTINCT FROM line->>'skuId'
    OR requested->>'documentRevisionId' IS DISTINCT FROM member#>>'{document,id}'
   OR requested->>'documentDigest' IS DISTINCT FROM member#>>'{head,documentDigest}') THEN
   RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001'; END IF;
  IF requested->'publication' IS NOT NULL AND NOT keep_price AND requested->'publication' IS DISTINCT FROM
   jsonb_build_object('productId',member->'productId','skuRevisionId',member->'skuRevisionId','head',member->'head') THEN
   RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001'; END IF;
  IF requested->'publication' IS NULL AND NOT keep_price AND (
   (p_purpose='order' AND p_binding->'quoteTimeHeads' IS NULL) OR
   (p_purpose='account' AND p_binding->>'lane'<>'legacy')
  ) THEN RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE='22023'; END IF;
  reference:=jsonb_build_object('schemaVersion',2,'skuId',line->'skuId','skuCode',member->'skuCode',
   'skuRevisionId',member->'skuRevisionId','publicationHead',member->'head','typeRef',product_facts->'type',
   'definitionDigest',product_facts->'definitionDigest','optionDigest',sku_facts->'optionDigest','netContent',sku_facts->'netContent');
  IF sku_facts->'demandPolicyRef' IS NOT NULL AND sku_facts->'demandPolicyRef'<>'null'::jsonb THEN
   reference:=reference||jsonb_build_object('demandPolicyRef',sku_facts->'demandPolicyRef'); END IF;
  heads:=heads||jsonb_build_object(line->>'productId',member->'head');
  ELSE
   SELECT b->'catalogReference' INTO reference FROM jsonb_array_elements(baseline) b
    WHERE b->>'variantId'=line->>'skuId' AND b ? 'catalogReference';
   IF reference IS NULL THEN SELECT a INTO reference FROM jsonb_array_elements(retained->'lines') a WHERE a->>'skuId'=line->>'skuId'; END IF;
   IF reference IS NULL THEN RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
  END IF;
  PERFORM public.catalog_accepted_reference_assert_v2(reference);
  selections:=selections||jsonb_build_array(jsonb_build_object('reference',reference,'quantity',coalesce(line->'qty',line->'quantity')));
  IF keep_price THEN CONTINUE; END IF;
  price_id:=coalesce(requested->>'resolvedPriceEntryId',requested->>'basePriceEntryId',line->>'priceEntryId');
  IF NOT (sku_id=ANY(scope)) AND EXISTS(SELECT 1 FROM jsonb_array_elements(baseline) a
    WHERE a->>'variantId'=line->>'skuId' AND a->'isAddon'=coalesce(line->'isAddon','false'::jsonb)
     AND a->>'qty'=coalesce(line->>'qty',line->>'quantity')) THEN CONTINUE; END IF;
  SELECT * INTO price FROM public.price_entries WHERE id=CASE WHEN pg_input_is_valid(price_id,'uuid') THEN price_id::uuid END AND variant_id=sku_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog_admission_price_context_required' USING ERRCODE='22023'; END IF;
  price_context:=jsonb_build_object('skuId',price.variant_id,'priceListId',price.price_list_id,'entryId',price.id,'entry',to_jsonb(price));
  IF requested->>'version'='catalog_facts_v2' AND p_purpose='account' THEN
   price_context:=price_context||jsonb_build_object('policy',jsonb_build_object(
    'revisionId',requested->'policyRevisionId','digest',requested->'policyDigest'));
  END IF;
  IF sku_id=ANY(scope) THEN prices:=prices||jsonb_build_array(price_context);
  ELSE retained_prices:=retained_prices||jsonb_build_array(price_context); END IF;
 END LOOP;
 IF p_purpose='order' AND p_binding->'quoteTimeHeads' IS NOT NULL THEN
  IF jsonb_typeof(p_binding->'quoteTimeHeads') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_binding->'quoteTimeHeads') NOT BETWEEN 1 AND 100
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_binding->'quoteTimeHeads') h
    WHERE jsonb_typeof(h) IS DISTINCT FROM 'object' OR h-ARRAY['productId','head']<>'{}'::jsonb
     OR NOT coalesce(pg_input_is_valid(h->>'productId','uuid'),false) OR jsonb_typeof(h->'head') IS DISTINCT FROM 'object')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_binding->'quoteTimeHeads') h GROUP BY h->>'productId' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE='22023'; END IF;
  SELECT jsonb_object_agg(h->>'productId',h->'head') INTO quoted_heads FROM jsonb_array_elements(p_binding->'quoteTimeHeads') h;
  IF quoted_heads IS DISTINCT FROM heads THEN RAISE EXCEPTION 'catalog_publication_head_moved' USING ERRCODE='40001'; END IF;
 END IF;
 IF p_purpose='order' THEN phase_reference:=public.catalog_admission_capture_graduation(p_binding->'quoteSnapshot'); END IF;
 RETURN jsonb_build_object('heads',(SELECT coalesce(jsonb_agg(jsonb_build_object('productId',key,'head',value) ORDER BY key),'[]') FROM jsonb_each(heads)),
   'skuRevisions',selections,'priceContextVersions',prices,'retainedPriceContextVersions',retained_prices,'offerEvidence',p_binding-ARRAY['quoteSnapshot','quoteTimeHeads']||jsonb_build_object('offerVersion',offer_version),'mode',p_mode,'purpose',p_purpose)
   ||CASE WHEN phase_reference IS NOT NULL THEN jsonb_build_object('phaseReference',phase_reference) ELSE '{}'::jsonb END;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_build_evidence(jsonb,text,jsonb,text) FROM PUBLIC;

-- Resolve exact source occurrences under the shared fence. Every accepting
-- writer calls this only after replay and its own commerce prelocks.
CREATE FUNCTION public.catalog_admission_accept(
 p_lines jsonb,p_evidence jsonb,p_mode text,p_binding jsonb,p_purpose text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE governed jsonb; selected jsonb; scope jsonb; legacy_skus jsonb; offer jsonb; source_rows integer; resolved_rows integer;
 distinct_rows integer; previously_governed boolean; binding_refusal text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog-publication-global',0));
 SELECT count(*),count(s.id),count(DISTINCT s.id),
  coalesce(jsonb_agg(jsonb_build_object('skuId',s.id,'quantity',coalesce(l->'qty',l->'quantity'),'isAddon',coalesce(l->'isAddon','false'::jsonb)) ORDER BY s.id)
    FILTER(WHERE s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb),'[]'),
  coalesce(jsonb_agg(s.id ORDER BY s.id) FILTER(WHERE s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb),'[]'),
  coalesce(jsonb_agg(s.id ORDER BY s.id) FILTER(WHERE s.id IS NOT NULL
    AND s.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    AND p.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb),'[]')
 INTO source_rows,resolved_rows,distinct_rows,governed,scope,legacy_skus
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines)='array' THEN p_lines ELSE '[]'::jsonb END) l
 LEFT JOIN public.catalog_skus s ON CASE WHEN p_purpose='order' THEN s.sku=l->>'sku'
  ELSE s.id=CASE WHEN pg_input_is_valid(l->>'variantId','uuid') THEN (l->>'variantId')::uuid END END
 LEFT JOIN public.catalog_products p ON p.id=s.product_id;
 SELECT EXISTS(SELECT 1 FROM public.subscription_lines sl JOIN public.catalog_skus s ON s.id=sl.variant_id
   JOIN public.catalog_products p ON p.id=s.product_id WHERE sl.subscription_id::text=p_binding->>'subscriptionId'
    AND (sl.catalog_sku_revision_id IS NOT NULL OR s.publication_facts->'schemaVersion'='3'::jsonb OR p.publication_facts->'schemaVersion'='3'::jsonb))
  INTO previously_governed;
 IF scope='[]'::jsonb AND NOT previously_governed THEN RETURN NULL; END IF;
 offer:=p_binding-'quoteSnapshot'||jsonb_build_object('scopeSkuIds',scope,'scopeDemand',governed,'legacySkuIds',legacy_skus,'retainedPriceContextVersions',coalesce(p_evidence->'retainedPriceContextVersions','[]'::jsonb));
 IF p_purpose='order' THEN
  offer:=offer||jsonb_build_object('offerVersion',public.catalog_price_setup_order_offer_version(p_binding->'quoteSnapshot'));
 END IF;
 PERFORM public.catalog_admission_assert_current(p_evidence->'heads',p_evidence->'skuRevisions',p_mode,
  offer||jsonb_build_object('clearSelection',scope='[]'::jsonb),p_evidence->'priceContextVersions',p_purpose);
 IF p_purpose='order' AND p_evidence ? 'phaseReference' AND (
   jsonb_typeof(p_evidence->'phaseReference') IS DISTINCT FROM 'object'
   OR p_evidence->'phaseReference' IS DISTINCT FROM public.catalog_admission_capture_graduation(p_binding->'quoteSnapshot')
 ) THEN RAISE EXCEPTION 'catalog_graduation_reference_invalid' USING ERRCODE='22023'; END IF;
 binding_refusal:=CASE WHEN p_purpose='order' THEN 'commerce_order_draft_offer_membership_refused' ELSE 'customer_self_service_invalid_offer_membership' END;
 SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',(l#>>'{reference,skuId}')::uuid,'quantity',l->'quantity') ORDER BY (l#>>'{reference,skuId}')::uuid),'[]')
  INTO selected FROM jsonb_array_elements(p_evidence->'skuRevisions') l;
 IF source_rows<>resolved_rows OR source_rows<>distinct_rows OR selected IS DISTINCT FROM (SELECT coalesce(jsonb_agg(l-'isAddon' ORDER BY ord),'[]')
   FROM jsonb_array_elements(governed) WITH ORDINALITY x(l,ord)) THEN
  RAISE EXCEPTION '%',binding_refusal USING ERRCODE='22023'; END IF;
 IF p_purpose='order' THEN
  IF jsonb_typeof(p_binding#>'{quoteSnapshot,quote,lines}') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION '%',binding_refusal USING ERRCODE='22023'; END IF;
  IF p_binding#>'{quoteSnapshot,quote,context,mode}' IS DISTINCT FROM to_jsonb(p_mode)
   OR (SELECT jsonb_agg(jsonb_build_array(l->'sku',l->'quantity') ORDER BY ord)
       FROM jsonb_array_elements(p_lines) WITH ORDINALITY x(l,ord))
      IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(l->'sku',l->'quantity') ORDER BY ord)
       FROM jsonb_array_elements(p_binding#>'{quoteSnapshot,quote,lines}') WITH ORDINALITY x(l,ord)) THEN
   RAISE EXCEPTION '%',binding_refusal USING ERRCODE='22023'; END IF;
 END IF;
 IF EXISTS(
  SELECT 1 FROM jsonb_array_elements(CASE WHEN p_purpose='order' THEN p_binding#>'{quoteSnapshot,quote,lines}' ELSE p_lines END) l
  JOIN public.catalog_skus sku ON CASE WHEN p_purpose='order' THEN sku.sku=l->>'sku' ELSE sku.id=(l->>'variantId')::uuid END
  CROSS JOIN LATERAL (SELECT coalesce(l#>'{quoteLine,catalogFacts,publication}',l#>'{catalogFacts,publication}') AS stamp) quoted
  JOIN jsonb_array_elements(p_evidence->'priceContextVersions') c ON c->>'skuId'=sku.id::text
  JOIN jsonb_array_elements(p_evidence->'skuRevisions') choice ON choice#>>'{reference,skuId}'=sku.id::text
  WHERE quoted.stamp IS NOT NULL AND quoted.stamp IS DISTINCT FROM
   jsonb_build_object('productId',sku.product_id,'skuRevisionId',choice#>'{reference,skuRevisionId}','head',choice#>'{reference,publicationHead}')
 ) THEN RAISE EXCEPTION '%',CASE WHEN p_purpose='order' THEN 'commerce_order_draft_catalog_head_moved'
    ELSE 'customer_self_service_stale_edit_catalog_head' END USING ERRCODE='40001'; END IF;
 IF EXISTS(
  SELECT 1 FROM jsonb_array_elements(CASE WHEN p_purpose='order' THEN p_binding#>'{quoteSnapshot,quote,lines}' ELSE p_lines END) l
  JOIN public.catalog_skus sku ON CASE WHEN p_purpose='order' THEN sku.sku=l->>'sku' ELSE sku.id=(l->>'variantId')::uuid END
  CROSS JOIN LATERAL (SELECT coalesce(l#>'{quoteLine,catalogFacts}',l->'catalogFacts') AS facts) observed
  CROSS JOIN LATERAL (SELECT coalesce(observed.facts->>'resolvedPriceEntryId',observed.facts->>'basePriceEntryId',l->>'priceEntryId') AS entry_id) consulted
  JOIN jsonb_array_elements(p_evidence->'priceContextVersions'||coalesce(p_evidence->'retainedPriceContextVersions','[]'::jsonb)) c
    ON c->>'skuId'=sku.id::text
  WHERE consulted.entry_id IS NOT NULL AND (c->>'entryId' IS DISTINCT FROM consulted.entry_id
    OR (observed.facts IS NOT NULL AND observed.facts->>'skuId' IS DISTINCT FROM sku.id::text)
    OR (observed.facts->>'version'='catalog_facts_v2' AND c->'policy' IS DISTINCT FROM
      jsonb_build_object('revisionId',observed.facts->'policyRevisionId','digest',observed.facts->'policyDigest')))) THEN
  RAISE EXCEPTION 'catalog_admission_price_context_moved' USING ERRCODE='40001'; END IF;
 IF scope='[]'::jsonb THEN RETURN 'null'::jsonb; END IF;
 RETURN (SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
  FROM jsonb_array_elements(p_evidence->'skuRevisions') l);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_accept(jsonb,jsonb,text,jsonb,text) FROM PUBLIC;

-- Purchase acceptance is frozen on the draft. Activation and attachment use
-- only those bytes, so a subsequent publication cannot rebind a paid purchase.
CREATE FUNCTION public.catalog_admission_frozen_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.commerce_orders; frozen jsonb; quote jsonb; evidence jsonb; draft jsonb; order_lines jsonb;
BEGIN
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id;
 frozen:=o.metadata->'catalogAcquisition';
 quote:=o.metadata->'quoteSnapshot';
 draft:=o.metadata->'orderDraftSnapshot';
 evidence:=quote->'catalogAdmission';
 IF o.catalog_acceptance IS NULL AND frozen IS NULL THEN RETURN NULL; END IF;
 IF o.catalog_acceptance IS NULL OR jsonb_typeof(frozen) IS DISTINCT FROM 'object'
  OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR quote#>>'{quote,context,mode}' IS DISTINCT FROM 'subscription'
 OR frozen IS DISTINCT FROM (jsonb_build_object('offerVersion',public.catalog_price_setup_order_offer_version(quote),
   'sizeConstraint',quote#>'{quote,context,sizeConstraint}','heads',evidence->'heads','selections',evidence->'skuRevisions','proof',o.catalog_acceptance)
   || CASE WHEN evidence ? 'phaseReference' THEN jsonb_build_object('phaseReference',evidence->'phaseReference') ELSE '{}'::jsonb END)
  OR jsonb_typeof(evidence->'skuRevisions') IS DISTINCT FROM 'array'
  OR jsonb_typeof(draft->'lines') IS DISTINCT FROM 'array'
  OR NOT EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id
   AND r.request_fingerprint=md5(quote::text||'|'||draft::text||'|'||coalesce(o.client_id::text,''))) THEN
  RAISE EXCEPTION 'subscription_activation_catalog_acceptance_mismatch' USING ERRCODE='22023'; END IF;
 IF o.catalog_acceptance->'lines' IS DISTINCT FROM (SELECT jsonb_agg(item->'reference' ORDER BY item#>>'{reference,skuId}')
   FROM jsonb_array_elements(evidence->'skuRevisions') item) THEN
  RAISE EXCEPTION 'subscription_activation_catalog_acceptance_mismatch' USING ERRCODE='22023'; END IF;
 PERFORM public.catalog_acceptance_assert_v2(o.catalog_acceptance);
 SELECT jsonb_agg(jsonb_build_object('lineOrdinal',ord,'sku',l->'sku','quantity',l->'quantity',
  'unitAmountMinor',l#>'{unitPriceGross,amountMinor}') ORDER BY ord) INTO order_lines
  FROM jsonb_array_elements(draft->'lines') WITH ORDINALITY x(l,ord);
 RETURN frozen||jsonb_build_object('orderLines',order_lines,'currency',o.currency_code);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_frozen_order(uuid) FROM PUBLIC;

-- Reads the authenticated acquisition tuple after attachment. The recorded
-- contract carries the phase proof through publishing and catalogue transfer.
CREATE FUNCTION public.catalog_admission_graduation_proof(p_subscription_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected_order uuid; marker jsonb; phase_reference jsonb;
BEGIN
 SELECT o.id,r.purchase_facts#>'{renewalTerms,starterPack}' INTO selected_order,marker
 FROM public.subscription_activations a JOIN public.commerce_orders o ON o.id=a.order_id
 JOIN public.subscription_renewal_attachments r ON r.order_id=a.order_id AND r.subscription_id=a.subscription_id
 WHERE a.subscription_id=p_subscription_id AND a.state='active' AND r.completed_at IS NOT NULL
  AND o.metadata#>'{catalogAcquisition,phaseReference}' IS NOT NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 phase_reference:=public.catalog_admission_frozen_order(selected_order)->'phaseReference';
 IF phase_reference->>'markerDigest' IS DISTINCT FROM encode(sha256(convert_to(marker::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'catalog_graduation_reference_invalid' USING ERRCODE='22023'; END IF;
 PERFORM public.catalog_accepted_reference_assert_v2(ref) FROM jsonb_array_elements(phase_reference#>'{proof,lines}') ref;
 RETURN phase_reference->'proof';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_graduation_proof(uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_admission_bind_purchase(p_subscription_id uuid,p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE frozen jsonb;
BEGIN
 frozen:=public.catalog_admission_frozen_order(p_order_id);
 IF frozen IS NULL THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscription_activations a
   JOIN public.commerce_orders o ON o.id=a.order_id AND o.client_id=a.client_id AND o.status='paid'
   JOIN public.commerce_settlement_intents i ON i.order_id=o.id AND i.status='settled' AND i.settled_at IS NOT NULL
   JOIN public.subscriptions s ON s.id=a.subscription_id AND s.client_id=a.client_id AND s.started_at=a.activated_at
   JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id AND c.subscription_id=s.id AND c.status='paid'
   WHERE a.order_id=p_order_id AND a.subscription_id=p_subscription_id AND a.state='active'
    AND a.payment_fingerprint=encode(sha256(convert_to(coalesce(i.external_ref,i.id::text),'UTF8')),'hex')
    AND s.status='active' AND s.template_version=1) THEN
  RAISE EXCEPTION 'subscription_activation_catalog_acceptance_mismatch' USING ERRCODE='22023'; END IF;
 IF frozen->>'offerVersion'='sized.v1' THEN
  UPDATE public.subscriptions SET configured_offer_version='sized.v1',
   composition_constraint=coalesce(NULLIF(frozen->'sizeConstraint','null'::jsonb),composition_constraint)
   WHERE id=p_subscription_id AND configured_offer_version='classic';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_bind_purchase(uuid,uuid) FROM PUBLIC;

-- Invoker order writes keep their existing rights. This narrow bridge lets the
-- retained-reference trigger verify immutable proof without reading owner tables.
CREATE FUNCTION public.catalog_admission_validate_proof(p_proof jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.catalog_acceptance_assert_v2(p_proof);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_validate_proof(jsonb) FROM PUBLIC;

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
  v_catalog_evidence jsonb; v_catalog_acceptance jsonb; v_catalog_price_entry uuid; v_public_quote jsonb;
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

  v_mode := p_order_draft_snapshot#>>'{context,mode}';
  v_currency := p_order_draft_snapshot->>'currency';
  -- Legacy invalid mode preceded the raw total conversion. A governed
  -- request with an invalid mode still reaches the guarded head check.
  IF v_mode IS NULL OR v_mode IN ('one_time','subscription') THEN
    v_total := (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint;
  END IF;
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
    IF v_mode IS NULL OR v_mode IN ('one_time','subscription') THEN
      RAISE EXCEPTION 'commerce_order_draft_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  END IF;

  v_catalog_evidence:=p_quote_snapshot->'catalogAdmission';
  v_catalog_acceptance:=public.catalog_admission_accept(p_order_draft_snapshot->'lines',v_catalog_evidence,
    v_mode,jsonb_build_object('quoteSnapshot',p_quote_snapshot,'currency',p_order_draft_snapshot->>'currency'),'order');
  v_mode := COALESCE(v_mode, 'one_time');
  IF v_mode NOT IN ('one_time', 'subscription') THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_mode' USING ERRCODE = '22023';
  END IF;
  v_public_quote:=p_quote_snapshot;
  IF v_catalog_acceptance IS NULL THEN
   v_catalog_evidence:=NULL;
  ELSE
   v_public_quote:=jsonb_set(p_quote_snapshot-'catalogAdmission','{quote,lines}',
     (SELECT jsonb_agg(l-'catalogFacts' ORDER BY ord)
      FROM jsonb_array_elements(p_quote_snapshot#>'{quote,lines}') WITH ORDINALITY x(l,ord)));
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
    IF v_catalog_evidence IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') c
      WHERE c#>>'{reference,skuId}'=v_sku_id::text)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_catalog_evidence->'priceContextVersions') c
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
    ) || CASE WHEN v_catalog_acceptance IS NOT NULL AND v_mode='subscription' THEN
      jsonb_build_object('catalogAcquisition',jsonb_build_object(
        'offerVersion',coalesce(p_quote_snapshot#>>'{quote,context,offerVersion}','classic'),
        'sizeConstraint',p_quote_snapshot#>'{quote,context,sizeConstraint}',
        'heads',v_catalog_evidence->'heads','selections',v_catalog_evidence->'skuRevisions','proof',v_catalog_acceptance)
        || CASE WHEN v_catalog_evidence ? 'phaseReference' THEN jsonb_build_object('phaseReference',v_catalog_evidence->'phaseReference') ELSE '{}'::jsonb END)
      ELSE '{}'::jsonb END, v_catalog_acceptance
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
      'quoteSnapshot', v_public_quote,
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
      'quoteSnapshot', v_public_quote,
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
    PERFORM public.catalog_admission_accept(p_order_draft_snapshot->'lines',p_quote_snapshot->'catalogAdmission',
      p_order_draft_snapshot#>>'{context,mode}',jsonb_build_object('quoteSnapshot',p_quote_snapshot,'currency',p_order_draft_snapshot->>'currency'),'order');
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

-- Preview and apply derive the same admission lane from the owned offer.
CREATE FUNCTION public.catalog_admission_edit_lane(p_action text,p_binding text,p_opt_in boolean)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN p_action='update_package_template' THEN 'classic'
  WHEN p_binding='sized.v1' OR p_opt_in IS TRUE THEN 'sized' ELSE 'exact' END
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_edit_lane(text,text,boolean) FROM PUBLIC;

-- Only runtime callers can check a token against its owned preview. The check
-- takes no preview row lock; the writer still owns lock order and acceptance.
-- Keep the predecessor's normalization for its existing price provenance.
-- The optional publication stamp is compared separately from observation time.
CREATE FUNCTION public.catalog_admission_quote_line_projection(p_line jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_line#>'{catalogFacts,publication}')='object'
     AND observed#>'{catalogFacts,validObservationTime}'='true'::jsonb THEN
   jsonb_set(observed,'{catalogFacts,value,publication}',p_line#>'{catalogFacts,publication}')
  ELSE public.subscription_quote_line_projection(p_line) END
 FROM (SELECT public.subscription_quote_line_projection(p_line#-'{catalogFacts,publication}') AS observed) value
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_quote_line_projection(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.subscription_quote_variant_qty_lines(p_lines jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_lines)='array' THEN COALESCE((SELECT jsonb_agg(
  jsonb_build_object('variantId',v->>'variantId','qty',CASE WHEN COALESCE(v->>'qty','') ~ '^-?[0-9]+$'
   THEN (v->>'qty')::integer ELSE NULL END,'quoteLine',public.catalog_admission_quote_line_projection(COALESCE(v->'quoteLine','{}'::jsonb))) ORDER BY ord)
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY x(v,ord)),'[]'::jsonb) ELSE NULL END;
$$;

CREATE FUNCTION public.catalog_admission_preview_bound(p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,
 p_action text,p_hash text,p_version integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.subscription_quote_previews q WHERE q.actor_id=p_actor_id AND q.client_id=p_client_id
  AND q.subscription_id=p_subscription_id AND q.action=p_action AND q.quote_hash=p_hash AND q.template_version=p_version
  AND q.quote_snapshot->'catalogQuoteBound'='true'::jsonb)
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_preview_bound(uuid,uuid,uuid,text,text,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.subscription_quote_preview_record(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,
 p_expires_at timestamptz,p_request jsonb,p_snapshot jsonb,p_totals jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE; evidence jsonb; lines jsonb; lane text; opt_in boolean;
 accepted_hash text; fresh_hash text;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('update_package_template','update_bundle','update_plan_length','add_addon','remove_addon',
  'update_addon_quantity','swap_base_line','update_base_mix','update_portion','resize_bundle') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 IF p_expires_at IS NULL OR NOT isfinite(p_expires_at) OR p_expires_at<=p_now THEN
  RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.template_version<>p_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 DELETE FROM public.subscription_quote_previews WHERE id IN (SELECT id FROM public.subscription_quote_previews
  WHERE status='previewed' AND expires_at<p_now-interval '7 days' ORDER BY expires_at,id LIMIT 500);
 -- A governed preview gets a fresh token for its exact captured evidence.
 -- Reserve both possible upsert keys before entering the catalogue fence.
 accepted_hash:=p_hash;
 fresh_hash:=encode(sha256(convert_to(p_hash||':'||gen_random_uuid()::text,'UTF8')),'hex');
 PERFORM 1 FROM public.subscription_quote_previews WHERE subscription_id=s.id AND client_id=p_client_id
  AND action=p_action AND quote_hash IN (p_hash,fresh_hash) AND template_version=p_version AND status='previewed'
  ORDER BY quote_hash,id FOR UPDATE;
 IF NOT p_snapshot ? 'catalogAdmission' THEN
  opt_in:=p_action='resize_bundle' AND p_request#>>'{resizeLever,kind}'='subscription.sized.parcel'
   AND p_request#>'{resizeLever,value,optInToSized}'='true'::jsonb;
  lane:=public.catalog_admission_edit_lane(p_action,s.configured_offer_version,opt_in);
  lines:=CASE WHEN lane='classic' THEN coalesce(p_snapshot->'baseLines','[]')||coalesce(p_snapshot->'addonLines','[]') ELSE p_snapshot->'lines' END;
  IF jsonb_typeof(lines)='array' THEN
   evidence:=public.catalog_admission_build_evidence(lines,'subscription',
    jsonb_build_object('subscriptionId',s.id,'offerVersion',CASE WHEN opt_in THEN 'sized.v1' ELSE s.configured_offer_version END,
    'lane',lane,'optIn',coalesce(opt_in,false)),'account');
   IF evidence IS NOT NULL THEN
    accepted_hash:=fresh_hash;
    p_snapshot:=p_snapshot||jsonb_build_object('catalogAdmission',evidence,'catalogQuoteBound',true);
   END IF;
  END IF;
 END IF;
 INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,
  expires_at,request_payload,quote_snapshot,totals,created_at,updated_at)
 VALUES(s.id,p_client_id,p_actor_id,p_action,accepted_hash,p_version,p_expires_at,p_request,p_snapshot,p_totals,p_now,p_now)
 ON CONFLICT (subscription_id,client_id,action,quote_hash,template_version) WHERE status='previewed' DO UPDATE SET
  actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,request_payload=EXCLUDED.request_payload,
  quote_snapshot=EXCLUDED.quote_snapshot,totals=EXCLUDED.totals,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at
 RETURNING * INTO q;
 RETURN to_jsonb(q);
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_subscription_preview_bundle_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
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
  v_principal_id uuid;
  v_client_id uuid;
  v_command_key text;
  v_key_identity jsonb;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_lines jsonb;
  v_evidence jsonb;
  v_fingerprint text;
  v_quote_hash text;
  v_current_total bigint;
  v_new_total bigint;
  v_cadence_days integer;
  v_expected_version integer;
  v_expires_at timestamptz;
  v_blocked_reason text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF starts_with(p_idempotency_key, 'command:') THEN
    RAISE EXCEPTION 'subscription_command_reserved_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_core_lines) <> 'array'
    OR jsonb_array_length(p_core_lines) NOT BETWEEN 1 AND 6
    OR jsonb_typeof(COALESCE(p_addon_lines, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_addon_lines, '[]'::jsonb)) > 12
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE = '22023';
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

  v_cadence_days := COALESCE(p_cadence_days, v_subscription.cadence_days);
  v_expected_version := COALESCE(p_expected_template_version, v_subscription.template_version);
  IF v_cadence_days NOT BETWEEN 1 AND 90 OR v_expected_version < 1 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.status <> 'active' THEN
    v_blocked_reason := 'not_active';
  ELSIF v_subscription.next_cycle_at IS NOT NULL
    AND statement_timestamp() >= v_subscription.next_cycle_at
      - make_interval(hours => v_subscription.edit_window_hours)
  THEN
    v_blocked_reason := 'edit_window_closed';
  ELSIF EXISTS (
    SELECT 1 FROM public.subscription_cycles AS cycle
    LEFT JOIN public.commerce_orders AS order_row ON order_row.subscription_cycle_id = cycle.id
    WHERE cycle.subscription_id = v_subscription.id
      AND cycle.scheduled_at = v_subscription.next_cycle_at
      AND (cycle.status IN ('payment_pending', 'paid')
        OR order_row.status IN ('paid', 'fulfillment_pending', 'fulfilled'))
  ) THEN
    v_blocked_reason := 'cycle_locked';
  END IF;
  IF v_blocked_reason IS NOT NULL THEN
    RETURN jsonb_build_object('preview', jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'action', 'update_bundle',
      'canApply', false,
      'blockedReason', v_blocked_reason,
      'nextCycleAt', v_subscription.next_cycle_at,
      'editCutoffAt', CASE WHEN v_subscription.next_cycle_at IS NULL THEN NULL ELSE
        v_subscription.next_cycle_at - make_interval(hours => v_subscription.edit_window_hours) END,
      'templateVersion', v_subscription.template_version
    ));
  END IF;
  IF v_subscription.price_list_id IS NULL OR v_subscription.currency_code IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_price_context_missing' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT value FROM jsonb_array_elements(p_core_lines)
      UNION ALL
      SELECT value FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb))
    ) AS requested
    WHERE jsonb_typeof(requested.value) <> 'object'
      OR COALESCE(requested.value->>'variantId', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(requested.value->>'qty', '') !~ '^[0-9]+$'
      OR (requested.value->>'qty')::integer NOT BETWEEN 1 AND 99
  ) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT value->>'variantId' AS variant_id FROM jsonb_array_elements(p_core_lines)
      UNION ALL
      SELECT value->>'variantId' FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb))
    ) AS requested GROUP BY variant_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'subscription_edit_duplicate_variant' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
      'variantId', requested.variant_id,
      'quantity', requested.quantity,
      'isAddon', requested.is_addon,
      'sortOrder', requested.sort_order,
      'unitPriceMinor', requested.unit_price_minor,
      'currency', v_subscription.currency_code,
      'priceEntryId', requested.price_entry_id
    ) ORDER BY requested.sort_order),
    sum(requested.unit_price_minor * requested.quantity)
  INTO v_lines, v_new_total
  FROM (
    SELECT parsed.variant_id, parsed.quantity, parsed.is_addon, parsed.sort_order,
      price.unit_price_minor, price.id AS price_entry_id
    FROM (
      SELECT (value->>'variantId')::uuid AS variant_id,
        (value->>'qty')::integer AS quantity, false AS is_addon,
        (ordinality - 1)::integer AS sort_order
      FROM jsonb_array_elements(p_core_lines) WITH ORDINALITY
      UNION ALL
      SELECT (value->>'variantId')::uuid, (value->>'qty')::integer, true,
        (jsonb_array_length(p_core_lines) + ordinality - 1)::integer
      FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb)) WITH ORDINALITY
    ) AS parsed
    JOIN public.catalog_skus AS sku ON sku.id = parsed.variant_id
      AND sku.status = 'active' AND sku.sellable_in_subscription = true
    LEFT JOIN LATERAL public.catalog_admission_legacy_price(
      v_subscription.price_list_id,parsed.variant_id,parsed.quantity,statement_timestamp()) price ON true
  ) AS requested;

  IF v_lines IS NULL OR jsonb_array_length(v_lines)
      <> jsonb_array_length(p_core_lines) + jsonb_array_length(COALESCE(p_addon_lines, '[]'::jsonb))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) AS line
      WHERE line->'unitPriceMinor' = 'null'::jsonb)
  THEN
    RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(sum(line.unit_price_minor * line.quantity), 0)
    INTO v_current_total FROM public.subscription_lines AS line
   WHERE line.subscription_id = v_subscription.id;
  v_fingerprint := public.subscription_bundle_edit_fingerprint(
    v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
    COALESCE(p_composition_constraint, '{}'::jsonb), v_cadence_days, v_expected_version
  );

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
  IF v_quote.id IS NOT NULL THEN
    IF v_quote.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    v_expires_at := statement_timestamp() + interval '15 minutes';
    v_quote_hash := encode(sha256(convert_to(
      v_subscription.id::text || ':' || v_fingerprint || ':' || v_expected_version::text
      || ':' || v_new_total::text || ':' || v_expires_at::text, 'UTF8')), 'hex');
    v_evidence:=public.catalog_admission_build_evidence(v_lines,'subscription',
      jsonb_build_object('subscriptionId',v_subscription.id,'offerVersion',v_subscription.configured_offer_version,
        'lane','legacy','optIn',false),'account');
    SELECT jsonb_agg(CASE WHEN v_evidence IS NOT NULL AND ord=1 THEN l||jsonb_build_object('catalogAdmission',v_evidence)
      ELSE l-'priceEntryId' END ORDER BY ord) INTO v_lines
      FROM jsonb_array_elements(v_lines) WITH ORDINALITY x(l,ord);
    INSERT INTO public.subscription_edit_quotes (
      subscription_id, idempotency_key, request_fingerprint, quote_hash, command_key_identity,
      expected_template_version, proposed_lines, proposed_cadence_days,
      current_total_minor, new_total_minor, currency_code, expires_at
    ) VALUES (
      v_subscription.id, v_command_key, v_fingerprint, v_quote_hash, v_key_identity,
      v_expected_version, v_lines, v_cadence_days, v_current_total, v_new_total,
      v_subscription.currency_code, v_expires_at
    ) RETURNING * INTO v_quote;
  END IF;

  RETURN jsonb_build_object('preview', jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'action', 'update_bundle',
    'canApply', true,
    'blockedReason', NULL,
    'nextCycleAt', v_subscription.next_cycle_at,
    'editCutoffAt', CASE WHEN v_subscription.next_cycle_at IS NULL THEN NULL ELSE
      v_subscription.next_cycle_at - make_interval(hours => v_subscription.edit_window_hours) END,
    'templateVersion', v_subscription.template_version,
    'quoteHash', v_quote.quote_hash,
    'quoteExpiresAt', v_quote.expires_at,
    'currentTotal', jsonb_build_object('amountMinor', v_quote.current_total_minor, 'currency', v_quote.currency_code),
    'newTotal', jsonb_build_object('amountMinor', v_quote.new_total_minor, 'currency', v_quote.currency_code),
    'delta', jsonb_build_object('amountMinor', v_quote.new_total_minor - v_quote.current_total_minor, 'currency', v_quote.currency_code),
    'catalogAvailability', jsonb_build_object('status', 'available', 'blockedReason', NULL)
  ));
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
  v_catalog_acceptance jsonb;
  v_terms_present boolean;
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
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=v_subscription.id FOR UPDATE;
  v_terms_present:=FOUND;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=v_subscription.id ORDER BY line_ordinal FOR UPDATE;
  v_catalog_acceptance:=public.catalog_admission_accept(v_quote.proposed_lines,v_quote.proposed_lines#>'{0,catalogAdmission}','subscription',
    jsonb_build_object('subscriptionId',v_subscription.id,'offerVersion',v_subscription.configured_offer_version,'lane','legacy','optIn',false),'account');
  IF NOT v_terms_present AND NULLIF(v_catalog_acceptance,'null'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023';
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
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb)
      WHERE subscription_id=v_subscription.id;
    IF FOUND THEN
      DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=v_subscription.id;
      INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
       SELECT v_subscription.id,ord,s.sku,(l->>'quantity')::integer,(l->>'unitPriceMinor')::bigint
       FROM jsonb_array_elements(v_quote.proposed_lines) WITH ORDINALITY x(l,ord)
       JOIN public.catalog_skus s ON s.id=(l->>'variantId')::uuid ORDER BY ord;
    END IF;
    UPDATE public.subscription_events SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE id=v_event_id;
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
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  v_catalog_acceptance:=public.catalog_admission_accept((q#>'{quote_snapshot,baseLines}')||(q#>'{quote_snapshot,addonLines}'),q#>'{quote_snapshot,catalogAdmission}','subscription',
    jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane','classic','optIn',false),'account');
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
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE id=event_id;
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
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  v_catalog_acceptance:=public.catalog_admission_accept(q#>'{quote_snapshot,lines}',q#>'{quote_snapshot,catalogAdmission}','subscription',
    jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,
     'lane',public.catalog_admission_edit_lane(p_action,s.configured_offer_version,false),'optIn',false),'account');
  PERFORM public.subscription_quote_assert_jsonb_equal((p_payload->'request')-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.catalog_admission_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.catalog_admission_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',q#>'{quote_snapshot,compositionConstraint}');
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
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE id=event_id;
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
DECLARE v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 action text; request jsonb; command jsonb; fingerprint text; answer jsonb; q jsonb; lines jsonb; line jsonb;
 event_id uuid; event_key text; line_pricing jsonb:='[]'::jsonb; version integer; plan integer; ordinal integer:=0;
 constraint_value jsonb; opt_in boolean; intro jsonb; phase_config jsonb; upcoming integer;
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
  upcoming:=public.catalog_admission_logical_cycle(s.id);
  IF upcoming<=(phase_config->>'fixedThroughCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
  IF COALESCE(opt_in,false) AND s.template_version=(intro->>'basisTemplateVersion')::integer
   AND upcoming<=(phase_config->>'graduationCycle')::integer THEN
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
  -- LC6: all existing rows this edit can mutate precede its first catalogue guard.
  PERFORM 1 FROM public.subscription_lines WHERE subscription_id=s.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  v_catalog_acceptance:=public.catalog_admission_accept(q#>'{quote_snapshot,lines}',q#>'{quote_snapshot,catalogAdmission}','subscription',
    jsonb_build_object('subscriptionId',s.id,'offerVersion',CASE WHEN coalesce(opt_in,false) THEN 'sized.v1' ELSE s.configured_offer_version END,'lane','sized','sizedCommand',true,'optIn',coalesce(opt_in,false)),'account');
  PERFORM public.subscription_quote_assert_jsonb_equal(request-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.catalog_admission_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.catalog_admission_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(constraint_value,q#>'{quote_snapshot,compositionConstraint}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'subjectFacts',q#>'{quote_snapshot,subjectFacts}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'optInFacts',q#>'{quote_snapshot,optInFacts}');
  -- Governed lines already passed the common current or retained rule.
  FOR line IN SELECT v FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_catalog_acceptance->'lines') accepted_ref
    WHERE accepted_ref->>'skuId'=(v->>'variantId')::uuid::text) LOOP
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
    UPDATE public.subscription_renewal_terms SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE subscription_id=s.id;
    UPDATE public.subscription_events SET catalog_acceptance=NULLIF(v_catalog_acceptance,'null'::jsonb) WHERE id=event_id;
  END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,request->>'acceptedQuoteHash',answer,outcome);
 RETURN answer;
END;
$$;


CREATE OR REPLACE FUNCTION public.catalog_acceptance_record_admit_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE retained jsonb; retained_lines jsonb; legacy_lines jsonb;
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('commerce_orders','subscription_events','subscription_renewal_operations') THEN
  IF OLD.catalog_acceptance IS NOT NULL AND NEW.catalog_acceptance IS DISTINCT FROM OLD.catalog_acceptance THEN
   RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_TABLE_NAME='subscription_renewal_operations' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.cycle_snapshot->>'frozenRevision' IN ('native.purchase-renewal.v3','native.purchase-renewal.v4')
    AND NEW.cycle_snapshot IS DISTINCT FROM OLD.cycle_snapshot THEN
    RAISE EXCEPTION 'catalog_acceptance_snapshot_immutable' USING ERRCODE='55000'; END IF;
  END IF;
 IF NEW.cycle_snapshot->>'frozenRevision' IN ('native.purchase-renewal.v3','native.purchase-renewal.v4') THEN
  IF NEW.catalog_acceptance IS NOT NULL AND NEW.catalog_acceptance IS DISTINCT FROM NEW.cycle_snapshot->'catalogAcceptance' THEN
   RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023'; END IF;
  NEW.catalog_acceptance:=NEW.cycle_snapshot->'catalogAcceptance';
  IF NEW.catalog_acceptance IS NULL THEN RAISE EXCEPTION 'catalog_acceptance_required' USING ERRCODE='22023'; END IF;
  IF NEW.cycle_snapshot->>'frozenRevision'='native.purchase-renewal.v4' THEN
   IF TG_OP='UPDATE' AND OLD.cycle_snapshot->>'frozenRevision' IS DISTINCT FROM 'native.purchase-renewal.v4' THEN
    RAISE EXCEPTION 'catalog_acceptance_snapshot_immutable' USING ERRCODE='55000'; END IF;
   IF TG_OP='INSERT' THEN
    SELECT t.catalog_acceptance INTO retained FROM public.subscription_renewal_terms t WHERE t.subscription_id=NEW.subscription_id;
    IF retained IS DISTINCT FROM NEW.catalog_acceptance THEN
     RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023'; END IF;
    SELECT jsonb_agg(line ORDER BY l.line_ordinal),jsonb_agg(line ORDER BY l.line_ordinal) FILTER (WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(retained->'lines') r WHERE r->>'skuCode'=l.sku)) INTO retained_lines,legacy_lines
    FROM public.subscription_renewal_term_lines l
    CROSS JOIN LATERAL (SELECT jsonb_build_object('lineOrdinal',l.line_ordinal,'sku',l.sku,
     'quantity',l.quantity,'unitAmountMinor',l.unit_amount_minor) AS line) tuple
    WHERE l.subscription_id=NEW.subscription_id;
    IF legacy_lines IS NULL OR legacy_lines IS DISTINCT FROM NEW.cycle_snapshot->'legacyLines'
     OR retained_lines IS DISTINCT FROM NEW.cycle_snapshot->'lines'
     OR retained_lines IS DISTINCT FROM NEW.cycle_snapshot#>'{templateSnapshot,lines}'
     OR retained_lines IS DISTINCT FROM NEW.cycle_snapshot#>'{orderSnapshot,lines}'
     OR jsonb_array_length(retained_lines)-jsonb_array_length(legacy_lines)<>jsonb_array_length(retained->'lines')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(retained->'lines') r WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(retained_lines) l WHERE l->>'sku'=r->>'skuCode')) THEN
     RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023'; END IF;
   END IF;
  END IF;
 END IF;
 END IF;
 IF NEW.catalog_acceptance IS NOT NULL THEN PERFORM public.catalog_admission_validate_proof(NEW.catalog_acceptance); END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscriptions_configured_offer_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.configured_offer_version IS DISTINCT FROM 'classic' THEN
   RAISE EXCEPTION 'subscription_configured_offer_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.configured_offer_version IS NOT DISTINCT FROM OLD.configured_offer_version THEN RETURN NEW; END IF;
 IF current_user=(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.catalog_admission_bind_purchase(uuid,uuid)'::regprocedure)
  AND OLD.status='active' AND NEW.status=OLD.status AND OLD.template_version=1 AND NEW.template_version=1
  AND OLD.next_cycle_at IS NOT DISTINCT FROM NEW.next_cycle_at
  AND OLD.configured_offer_version='classic' AND NEW.configured_offer_version='sized.v1'
  AND EXISTS(SELECT 1 FROM public.subscription_activations a JOIN public.commerce_orders o ON o.id=a.order_id
    JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id AND c.subscription_id=OLD.id AND c.status='paid'
    WHERE a.subscription_id=OLD.id AND a.client_id=OLD.client_id AND a.state='active' AND a.activated_at=OLD.started_at
     AND o.status='paid' AND o.catalog_acceptance IS NOT NULL AND o.metadata#>>'{catalogAcquisition,offerVersion}'='sized.v1'
     AND NEW.composition_constraint IS NOT DISTINCT FROM coalesce(NULLIF(o.metadata#>'{catalogAcquisition,sizeConstraint}','null'::jsonb),OLD.composition_constraint)) THEN
  RETURN NEW;
 END IF;
 IF pg_trigger_depth()>1 AND OLD.status='active' AND NEW.status=OLD.status
  AND OLD.configured_offer_version='classic' AND NEW.configured_offer_version='sized.v1'
  AND OLD.next_cycle_at IS NOT DISTINCT FROM NEW.next_cycle_at THEN
  IF EXISTS (
   SELECT 1 FROM public.subscription_events e JOIN public.subscription_quote_previews q
    ON q.id=(e.payload->>'quotePreviewId')::uuid
   WHERE e.subscription_id=NEW.id AND e.event_type='subscription.customer_self_service.resize_bundle'
    AND e.payload#>'{payload,resizeLever,value,optInToSized}'='true'::jsonb
    AND q.request_payload->'resizeLever'=e.payload#>'{payload,resizeLever}'
    AND q.subscription_id=NEW.id AND q.client_id=NEW.client_id AND q.action='resize_bundle'
    AND q.status='accepted' AND q.accepted_event_id=e.id
    AND e.idempotency_key='command:'||encode(sha256(convert_to(q.actor_id::text||':'||q.accepted_idempotency_key,'UTF8')),'hex')
    AND q.template_version+1=NEW.template_version
    AND q.quote_snapshot->'compositionConstraint'=NEW.composition_constraint
  ) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'subscription_configured_offer_immutable' USING ERRCODE='23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_activation_commit(
  p_activation public.subscription_activations,
  p_idempotency_key text,
  p_payment_fingerprint text,
  p_paid_at timestamptz,
  p_repaired boolean
)
RETURNS public.subscription_activations
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_cycle_id uuid;
  v_next_cycle_at timestamptz;
  v_activated public.subscription_activations%ROWTYPE;
BEGIN
  v_next_cycle_at := p_paid_at + (p_activation.cadence_days * interval '1 day');

  INSERT INTO public.subscriptions
    (client_id, status, cadence_days, next_cycle_at, started_at)
  VALUES (p_activation.client_id, 'active', p_activation.cadence_days, v_next_cycle_at, p_paid_at)
  RETURNING id INTO v_subscription_id;

  -- The cycle the captured payment paid for. It is written as paid because the
  -- money rail already said so; writing it as planned would make the first
  -- renewal ask for the same instant twice.
  INSERT INTO public.subscription_cycles (subscription_id, scheduled_at, status)
  VALUES (v_subscription_id, p_paid_at, 'paid')
  RETURNING id INTO v_cycle_id;

  UPDATE public.commerce_orders
     SET subscription_cycle_id = v_cycle_id, updated_at = p_paid_at
   WHERE id = p_activation.order_id;

  UPDATE public.subscription_activations
     SET state = 'active',
         subscription_id = v_subscription_id,
         payment_fingerprint = p_payment_fingerprint,
         activation_idempotency_key = p_idempotency_key,
         repaired = p_repaired,
         activated_at = p_paid_at
   WHERE order_id = p_activation.order_id
  RETURNING * INTO v_activated;

  INSERT INTO public.subscription_events
    (subscription_id, event_type, idempotency_key, payload, occurred_at)
  VALUES (
    v_subscription_id, 'subscription.activated', p_idempotency_key,
    jsonb_build_object(
      'orderId', p_activation.order_id,
      'cadenceDays', p_activation.cadence_days,
      'nextCycleAt', v_next_cycle_at,
      'repaired', p_repaired),
    p_paid_at)
  ON CONFLICT (subscription_id, idempotency_key) DO NOTHING;

  PERFORM public.catalog_admission_bind_purchase(v_subscription_id,p_activation.order_id);
  PERFORM public.subscription_capture_renewal_attachment(p_activation.order_id);
  RETURN v_activated;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_complete_renewal_attachment(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_activation public.subscription_activations; v_facts jsonb; frozen jsonb;
BEGIN
  PERFORM 1 FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_row.subscription_id IS NULL OR v_activation.state IS DISTINCT FROM 'active' OR v_row.purchase_facts IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_attachment_not_ready' USING ERRCODE='22023'; END IF;
  IF v_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',true); END IF;
  v_facts:=v_row.purchase_facts;
  frozen:=public.catalog_admission_frozen_order(p_order_id);
  IF frozen IS NOT NULL AND (
   frozen->'orderLines' IS DISTINCT FROM (SELECT jsonb_agg(l ORDER BY (l->>'lineOrdinal')::integer) FROM jsonb_array_elements(v_facts->'lines') l)
   OR frozen->>'currency' IS DISTINCT FROM v_facts->>'currency'
   OR (frozen ? 'phaseReference' AND frozen#>>'{phaseReference,markerDigest}' IS DISTINCT FROM
     encode(sha256(convert_to((v_facts#>'{renewalTerms,starterPack}')::text,'UTF8')),'hex'))
   OR NOT EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.id=v_row.subscription_id AND s.id=v_activation.subscription_id
     AND s.configured_offer_version=frozen->>'offerVersion'
     AND (s.configured_offer_version<>'sized.v1' OR s.composition_constraint IS NOT DISTINCT FROM NULLIF(frozen->'sizeConstraint','null'::jsonb)))
  ) THEN RAISE EXCEPTION 'subscription_activation_catalog_acceptance_mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,
    unattended_charge_authorized_at,authorization_ref,payer_account_ref,catalog_acceptance)
    VALUES(v_row.subscription_id,v_facts->>'currency',v_facts->>'stockSourceKey',v_facts->>'settlementChannelKey',
      (v_facts->>'unattendedChargeAuthorizedAt')::timestamptz,v_facts->>'authorizationRef',v_facts->>'payerAccountRef',frozen->'proof');
  INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    SELECT v_row.subscription_id,(value->>'lineOrdinal')::integer,value->>'sku',(value->>'quantity')::integer,
      (value->>'unitAmountMinor')::bigint FROM jsonb_array_elements(v_facts->'lines');
  INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,evidence_ref)
    VALUES(v_row.subscription_id,'healthy',v_facts->>'methodRef',v_facts->>'methodEvidenceRef');
  IF v_facts->>'settlementChannelKey'<>'sandbox' THEN
    PERFORM public.payment_method_ref_switch_active('purchase:'||p_order_id::text,(v_facts->>'methodEvidenceRef')::uuid,v_row.subscription_id);
    PERFORM public.payment_method_ref_link_subscription_mirror('purchase:'||p_order_id::text,v_row.subscription_id,(v_facts->>'methodEvidenceRef')::uuid);
  END IF;
  INSERT INTO public.subscription_method_state_events(event_key,subscription_id,input)
    VALUES('purchase:'||p_order_id::text,v_row.subscription_id,jsonb_build_object('methodRef',v_facts->>'methodRef',
      'healthState','healthy','evidenceRef',v_facts->>'methodEvidenceRef'));
  UPDATE public.subscription_renewal_attachments SET completed_at=now() WHERE order_id=p_order_id;
  RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',false);
END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM anon'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text) FROM authenticated'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_members(text,text,uuid[],boolean), public.catalog_admission_candidate_members(uuid[],text), public.catalog_admission_preview_bound(uuid,uuid,uuid,text,text,integer), public.catalog_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text), public.catalog_admission_build_evidence(jsonb,text,jsonb,text), public.catalog_admission_accept(jsonb,jsonb,text,jsonb,text), public.catalog_admission_bind_purchase(uuid,uuid), public.catalog_admission_validate_proof(jsonb) TO service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_graduation_proof(uuid) TO service_role'; END IF; END; $$;
