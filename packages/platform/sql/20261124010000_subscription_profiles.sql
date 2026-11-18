-- Keep unqualified profile writes closed under the existing commerce-first fence.
-- The catalogue type and publication identify profile enrolment without trusting order or edit input.
CREATE OR REPLACE FUNCTION public.catalog_admission_assert_current(
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
 -- A selected profile requires transactionally verified policy evidence.
 -- The retained roster also matters when an edit removes its last profiled line.
 IF p_mode='subscription' AND EXISTS (
   SELECT 1 FROM (
     SELECT l->'reference' AS ref FROM jsonb_array_elements(p_sku_revisions) l
     UNION ALL
     SELECT l AS ref FROM jsonb_array_elements(coalesce(retained->'lines','[]'::jsonb)) l
   ) binding
   JOIN public.catalog_publications p ON p.id=(binding.ref#>>'{publicationHead,publicationId}')::uuid
   JOIN public.catalog_type_versions t ON t.type_key=binding.ref#>>'{typeRef,key}'
     AND t.version=(binding.ref#>>'{typeRef,version}')::integer
   WHERE p.canonical_state::jsonb->'product' ? 'subscriptionProfileRef'
     OR t.definition ? 'subscriptionProfileRef'
 ) THEN
  RAISE EXCEPTION 'policy_binding_missing' USING ERRCODE='22023';
 END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_definition_install(p_pack_id text, p_pack_version integer, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_manifest jsonb := (p_manifest->>'manifest')::jsonb;
  v_digest text := encode(sha256(convert_to(p_manifest->>'manifest', 'UTF8')), 'hex');
  v_install public.catalog_definition_installs%ROWTYPE;
  v_type jsonb;
  v_definition jsonb;
  v_definition_digest text;
  v_existing public.catalog_type_versions%ROWTYPE;
  v_receipt jsonb;
  v_profiles jsonb := v_manifest->'subscriptionProfileDefinitions';
BEGIN
  IF v_manifest->>'id' IS DISTINCT FROM p_pack_id
    OR (v_manifest->>'version')::integer IS DISTINCT FROM p_pack_version
    OR jsonb_typeof(p_manifest->'types') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'taxClasses') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_manifest->'types') IS DISTINCT FROM jsonb_array_length(p_manifest->'types') THEN
    RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
  END IF;
  -- One catalogue-domain guard, acquired before definition, tax-key or install-ledger rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('openlup:catalog-definitions', 0));
  SELECT * INTO v_install FROM public.catalog_definition_installs
    WHERE pack_id = p_pack_id AND pack_version = p_pack_version;
  IF FOUND THEN
    IF v_install.manifest_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'catalog_definition_install_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_install.receipt;
  END IF;
  FOR v_type IN SELECT value FROM jsonb_array_elements(p_manifest->'types')
    ORDER BY (value->>'canonicalDefinition')::jsonb->>'key', ((value->>'canonicalDefinition')::jsonb->>'version')::integer
  LOOP
    v_definition := (v_type->>'canonicalDefinition')::jsonb;
    v_definition_digest := encode(sha256(convert_to(v_type->>'canonicalDefinition', 'UTF8')), 'hex');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest->'types') t
      WHERE t->>'key' = v_definition->>'key' AND (t->>'version')::integer = (v_definition->>'version')::integer
        AND t->>'definitionDigest' = v_definition_digest) THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.catalog_type_versions(type_key, version, definition, definition_digest, validator_ref)
      VALUES (v_definition->>'key', (v_definition->>'version')::integer, v_definition,
        v_definition_digest, v_definition->>'validatorRef') ON CONFLICT (type_key, version) DO NOTHING;
    SELECT * INTO STRICT v_existing FROM public.catalog_type_versions
      WHERE type_key = v_definition->>'key' AND version = (v_definition->>'version')::integer;
    IF v_existing.definition IS DISTINCT FROM v_definition OR v_existing.definition_digest IS DISTINCT FROM v_definition_digest
      OR v_existing.validator_ref IS DISTINCT FROM v_definition->>'validatorRef' THEN
      RAISE EXCEPTION 'catalog_type_install_refuses_redefinition' USING ERRCODE = '23505';
    END IF;
  END LOOP;
  IF v_profiles IS NOT NULL THEN
    IF jsonb_typeof(v_profiles) IS DISTINCT FROM 'array' OR jsonb_array_length(v_profiles)>100 THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p
      WHERE jsonb_typeof(p) IS DISTINCT FROM 'object'
        OR coalesce(p->>'key','') !~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
        OR char_length(p->>'key')>120
        OR jsonb_typeof(p->'version') IS DISTINCT FROM 'number'
        OR coalesce(p->>'version','') !~ '^[1-9][0-9]*$')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p GROUP BY p->'key',p->'version' HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest->'subscriptionProfiles') r
          WHERE r=jsonb_build_object('key',p->'key','version',p->'version'))) THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.catalog_definition_installs i
      CROSS JOIN LATERAL jsonb_array_elements(i.receipt->'subscriptionProfileDefinitions') prior
      JOIN jsonb_array_elements(v_profiles) p ON prior->'key'=p->'key' AND prior->'version'=p->'version'
      WHERE prior IS DISTINCT FROM p) THEN
      RAISE EXCEPTION 'catalog_profile_install_refuses_redefinition' USING ERRCODE='23505';
    END IF;
  END IF;
  IF (SELECT COALESCE(jsonb_agg(value->>'key' ORDER BY value->>'key'), '[]'::jsonb)
      FROM jsonb_array_elements(p_manifest->'taxClasses')) IS DISTINCT FROM
    (SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) FROM jsonb_array_elements(v_manifest->'taxClasses')) THEN
    RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.catalog_tax_classes(key, label, status)
    SELECT value->>'key', value->>'label', 'active' FROM jsonb_array_elements(p_manifest->'taxClasses')
    ORDER BY value->>'key' ON CONFLICT (key) DO NOTHING;
  v_receipt := jsonb_build_object('packId', p_pack_id, 'packVersion', p_pack_version,
    'manifestDigest', v_digest, 'installedAt', clock_timestamp(), 'types', v_manifest->'types');
  IF v_profiles IS NOT NULL THEN
    v_receipt := v_receipt || jsonb_build_object('subscriptionProfileDefinitions',v_profiles);
  END IF;
  INSERT INTO public.catalog_definition_installs(pack_id, pack_version, manifest_digest, receipt)
    VALUES (p_pack_id, p_pack_version, v_digest, v_receipt);
  RETURN v_receipt;
END;
$$;
