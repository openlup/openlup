-- Accepted catalogue identity belongs to the existing commerce owner transactions.

ALTER TABLE public.subscription_lines ADD COLUMN catalog_sku_revision_id uuid;
ALTER TABLE public.subscription_lines ADD CONSTRAINT subscription_lines_catalog_sku_revision_fkey FOREIGN KEY (variant_id, catalog_sku_revision_id) REFERENCES public.catalog_sku_revisions (sku_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.subscription_lines VALIDATE CONSTRAINT subscription_lines_catalog_sku_revision_fkey;

ALTER TABLE public.commerce_orders ADD COLUMN catalog_acceptance jsonb, ADD COLUMN catalog_basket jsonb;
ALTER TABLE public.subscription_events ADD COLUMN catalog_acceptance jsonb, ADD COLUMN catalog_basket jsonb;
ALTER TABLE public.subscription_renewal_terms ADD COLUMN catalog_acceptance jsonb;
ALTER TABLE public.subscription_renewal_operations ADD COLUMN catalog_acceptance jsonb;


ALTER TABLE public.commerce_orders ADD COLUMN catalog_receipt_key text;
ALTER TABLE public.subscription_edit_quotes ADD COLUMN catalog_acceptance jsonb;
ALTER TABLE public.subscription_renewal_operations ADD COLUMN catalog_acceptance_fingerprint text;


CREATE FUNCTION public.catalog_accepted_reference_assert_v2(p_reference jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE publication public.catalog_publications%ROWTYPE; revision public.catalog_sku_revisions%ROWTYPE;
 manifest jsonb; facts jsonb; document_digest text;
 uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 digest_shape constant text := '^[a-f0-9]{64}$';
 key_shape constant text := '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$';
BEGIN
 IF jsonb_typeof(p_reference) IS DISTINCT FROM 'object' OR p_reference->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR NOT (p_reference ?& ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent'])
  OR p_reference - ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent','demandPolicyRef'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_reference->'skuId') IS DISTINCT FROM 'string' OR p_reference->>'skuId' !~ uuid_shape
  OR jsonb_typeof(p_reference->'skuRevisionId') IS DISTINCT FROM 'string' OR p_reference->>'skuRevisionId' !~ uuid_shape
  OR jsonb_typeof(p_reference->'skuCode') IS DISTINCT FROM 'string' OR p_reference->>'skuCode' !~ '^[A-Za-z0-9._:-]{1,160}$'
  OR jsonb_typeof(p_reference->'definitionDigest') IS DISTINCT FROM 'string' OR p_reference->>'definitionDigest' !~ digest_shape
  OR jsonb_typeof(p_reference->'optionDigest') IS DISTINCT FROM 'string' OR p_reference->>'optionDigest' !~ digest_shape
  OR jsonb_typeof(p_reference->'publicationHead') IS DISTINCT FROM 'object'
  OR (p_reference->'publicationHead') - ARRAY['publicationId','revision','documentDigest'] <> '{}'::jsonb
  OR jsonb_typeof(p_reference#>'{publicationHead,publicationId}') IS DISTINCT FROM 'string' OR p_reference#>>'{publicationHead,publicationId}' !~ uuid_shape
  OR jsonb_typeof(p_reference#>'{publicationHead,revision}') IS DISTINCT FROM 'number' OR p_reference#>>'{publicationHead,revision}' !~ '^[1-9][0-9]{0,9}$'
  OR jsonb_typeof(p_reference#>'{publicationHead,documentDigest}') IS DISTINCT FROM 'string' OR p_reference#>>'{publicationHead,documentDigest}' !~ digest_shape
  OR jsonb_typeof(p_reference->'typeRef') IS DISTINCT FROM 'object' OR (p_reference->'typeRef') - ARRAY['key','version'] <> '{}'::jsonb
  OR jsonb_typeof(p_reference#>'{typeRef,key}') IS DISTINCT FROM 'string' OR p_reference#>>'{typeRef,key}' !~ key_shape
  OR length(p_reference#>>'{typeRef,key}')>120
  OR jsonb_typeof(p_reference#>'{typeRef,version}') IS DISTINCT FROM 'number' OR p_reference#>>'{typeRef,version}' !~ '^[1-9][0-9]{0,9}$'
  OR public.catalog_publication_quantity_valid(p_reference->'netContent') IS DISTINCT FROM true
  OR (p_reference ? 'demandPolicyRef' AND (jsonb_typeof(p_reference->'demandPolicyRef') IS DISTINCT FROM 'string'
   OR length(p_reference->>'demandPolicyRef') NOT BETWEEN 1 AND 240 OR p_reference->>'demandPolicyRef'<>btrim(p_reference->>'demandPolicyRef'))) THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 IF (p_reference#>>'{publicationHead,revision}')::bigint>2147483647 OR (p_reference#>>'{typeRef,version}')::bigint>2147483647 THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO publication FROM public.catalog_publications WHERE id=(p_reference#>>'{publicationHead,publicationId}')::uuid;
 SELECT * INTO revision FROM public.catalog_sku_revisions WHERE id=(p_reference->>'skuRevisionId')::uuid AND sku_id=(p_reference->>'skuId')::uuid;
 IF publication.id IS NULL OR revision.id IS NULL OR publication.product_id<>revision.product_id THEN
  RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
 manifest:=public.catalog_publication_read_manifest(publication.product_id,publication.canonical_state,publication.digest);
 facts:=public.catalog_publication_read_sku_revision(revision.product_id,jsonb_build_object(
  'skuId',revision.sku_id,'revisionId',revision.id,'revision',revision.revision,'digest',revision.digest));
 SELECT digest INTO document_digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id AND product_id=publication.product_id;
 IF manifest->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR revision.publication_id IS DISTINCT FROM publication.id
  OR document_digest IS NULL
  OR manifest#>'{product,document,id}' IS DISTINCT FROM to_jsonb(publication.document_revision_id)
  OR manifest#>>'{product,document,digest}' IS DISTINCT FROM document_digest
  OR p_reference->'publicationHead' IS DISTINCT FROM jsonb_build_object('publicationId',publication.id,'revision',publication.revision,'documentDigest',document_digest)
  OR facts->>'id' IS DISTINCT FROM p_reference->>'skuId' OR facts->>'code' IS DISTINCT FROM p_reference->>'skuCode'
  OR manifest->'product'->'type' IS DISTINCT FROM p_reference->'typeRef'
  OR manifest->'product'->'definitionDigest' IS DISTINCT FROM p_reference->'definitionDigest'
  OR facts->'optionDigest' IS DISTINCT FROM p_reference->'optionDigest' OR facts->'netContent' IS DISTINCT FROM p_reference->'netContent'
  OR facts->'demandPolicyRef' IS DISTINCT FROM p_reference->'demandPolicyRef'
  OR NOT EXISTS(SELECT 1 FROM public.catalog_type_versions t WHERE t.type_key=p_reference#>>'{typeRef,key}'
    AND t.version=(p_reference#>>'{typeRef,version}')::integer AND t.definition_digest=p_reference->>'definitionDigest')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'skus') entry WHERE entry=jsonb_build_object('skuId',revision.sku_id,'revisionId',revision.id,'revision',revision.revision,'digest',revision.digest)) THEN
  RAISE EXCEPTION 'catalog_accepted_reference_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_accepted_reference_assert_v2(jsonb) FROM PUBLIC;
CREATE FUNCTION public.catalog_acceptance_assert_v2(p_acceptance jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE reference jsonb;
BEGIN
 IF jsonb_typeof(p_acceptance) IS DISTINCT FROM 'object' OR p_acceptance->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR p_acceptance - ARRAY['schemaVersion','lines'] <> '{}'::jsonb OR jsonb_typeof(p_acceptance->'lines') IS DISTINCT FROM 'array'
  OR octet_length(CAST(p_acceptance AS text))>1048576 THEN
  RAISE EXCEPTION 'catalog_acceptance_invalid' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_acceptance->'lines') NOT BETWEEN 1 AND 100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') l GROUP BY l->>'skuId' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') l GROUP BY l->>'skuCode' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'catalog_acceptance_invalid' USING ERRCODE='22023'; END IF;
 FOR reference IN SELECT value FROM jsonb_array_elements(p_acceptance->'lines') LOOP PERFORM public.catalog_accepted_reference_assert_v2(reference); END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_acceptance_assert_v2(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_retained_basket_v2(p_basket jsonb,p_order_ordinals boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE item jsonb; code text; qty jsonb; identity jsonb; basket jsonb:='{}';
BEGIN
 IF jsonb_typeof(p_basket) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF jsonb_array_length(p_basket) NOT BETWEEN 1 AND 100 THEN RETURN NULL; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_basket) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object'
   OR (item ? 'sku' AND item ? 'skuCode' AND item->'sku' IS DISTINCT FROM item->'skuCode')
   OR (item ? 'quantity' AND item ? 'qty' AND item->'quantity' IS DISTINCT FROM item->'qty')
   OR jsonb_typeof(coalesce(item->'sku',item->'skuCode')) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  code:=coalesce(item->>'sku',item->>'skuCode'); qty:=coalesce(item->'quantity',item->'qty');
  IF code IS NULL OR code !~ '^[A-Za-z0-9._:-]{1,160}$' OR (NOT p_order_ordinals AND basket ? code)
   OR jsonb_typeof(qty) IS DISTINCT FROM 'number' OR qty::text !~ '^[1-9][0-9]{0,9}$' THEN RETURN NULL; END IF;
  IF qty::text::bigint>2147483647 THEN RETURN NULL; END IF;
  SELECT to_jsonb(k.id) INTO identity FROM public.catalog_skus k WHERE k.sku=code;
  IF identity IS NULL THEN RETURN NULL; END IF;
  IF item ?| ARRAY['variantId','skuId'] THEN
   IF (item ? 'variantId' AND item->'variantId' IS DISTINCT FROM identity)
    OR (item ? 'skuId' AND item->'skuId' IS DISTINCT FROM identity) THEN RETURN NULL; END IF;
  END IF;
  basket:=basket||jsonb_build_object(code,coalesce((basket->>code)::bigint,0)+qty::text::bigint);
 END LOOP;
 RETURN basket;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_retained_basket_v2(jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_retained_basket_codes_v2(p_basket jsonb) RETURNS text[]
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT array_agg(code) FROM jsonb_object_keys(public.catalog_retained_basket_v2(p_basket)) code;
$$;
REVOKE ALL ON FUNCTION public.catalog_retained_basket_codes_v2(jsonb) FROM PUBLIC;


CREATE FUNCTION public.catalog_frozen_basket_codes_v2(p_snapshot jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE basket jsonb;
BEGIN
 IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF p_snapshot ? 'frozenRevision' AND (
  p_snapshot->>'frozenRevision' IS NULL OR p_snapshot->>'frozenRevision' NOT IN ('native.purchase-renewal.v1','native.purchase-renewal.v2')
  OR p_snapshot#>'{orderSnapshot,lines}' IS DISTINCT FROM p_snapshot->'lines'
  OR p_snapshot#>'{templateSnapshot,lines}' IS DISTINCT FROM p_snapshot->'lines') THEN RETURN NULL; END IF;
 basket:=public.catalog_retained_basket_v2(p_snapshot->'lines',true);
 IF basket IS NULL THEN RETURN NULL; END IF;
 RETURN ARRAY(SELECT jsonb_object_keys(basket));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_frozen_basket_codes_v2(jsonb) FROM PUBLIC;


CREATE FUNCTION public.catalog_order_basket_v2(p_order uuid,p_metadata jsonb,p_initial boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE basket jsonb; snapshot jsonb; candidate jsonb; receipt jsonb; has_items boolean;
BEGIN
 SELECT count(*)>0,CASE WHEN bool_and(sku IS NOT NULL) THEN jsonb_object_agg(sku,quantity) FILTER (WHERE sku IS NOT NULL) END
 INTO has_items,basket FROM (
  SELECT k.sku,sum(i.quantity) AS quantity FROM public.commerce_order_items i
  LEFT JOIN public.catalog_skus k ON k.id=i.sku_id WHERE i.order_id=p_order GROUP BY k.sku) items;
 IF basket IS NULL AND (has_items OR NOT p_initial) THEN RETURN NULL; END IF;
 SELECT r.response_payload INTO receipt FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order;
 IF FOUND AND (receipt#>>'{orderDraft,orderId}' IS DISTINCT FROM 'order_'||p_order::text
  OR receipt#>'{orderDraft,quoteSnapshot,quote,lines}' IS NULL) THEN RETURN NULL; END IF;
 FOREACH snapshot IN ARRAY ARRAY[p_metadata#>'{orderDraftSnapshot,lines}',p_metadata#>'{quoteSnapshot,quote,lines}',
  p_metadata#>'{orderSnapshot,lines}',p_metadata#>'{cycleSnapshot,lines}',receipt#>'{orderDraft,quoteSnapshot,quote,lines}'] LOOP
  IF snapshot IS NULL THEN CONTINUE; END IF;
  candidate:=public.catalog_retained_basket_v2(snapshot,true);
  IF candidate IS NULL OR (basket IS NOT NULL AND candidate IS DISTINCT FROM basket) THEN RETURN NULL; END IF;
  basket:=candidate;
 END LOOP;
 RETURN basket;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_order_basket_v2(uuid,jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_acceptance_roster_valid_v2(p_acceptance jsonb,p_basket jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF jsonb_typeof(p_basket) IS DISTINCT FROM 'object' OR p_acceptance->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR jsonb_typeof(p_acceptance->'lines') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 RETURN (SELECT count(*)=count(DISTINCT l->>'skuCode') AND count(*)>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_basket) AS codes(code)
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') ref WHERE ref->>'skuCode'=codes.code)
    AND NOT EXISTS(SELECT 1 FROM public.catalog_skus k WHERE k.sku=codes.code
      AND k.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb))
  AND bool_and(coalesce(p_basket ? (l->>'skuCode') AND EXISTS(
   SELECT 1 FROM public.catalog_skus k WHERE k.sku=l->>'skuCode' AND to_jsonb(k.id)=l->'skuId'),false))
  FROM jsonb_array_elements(p_acceptance->'lines') l);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_acceptance_roster_valid_v2(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_order_evidence_v2(p_order uuid,p_metadata jsonb,p_acceptance jsonb,p_header_only boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE basket jsonb:=public.catalog_order_basket_v2(p_order,p_metadata,p_header_only);
BEGIN
 IF p_acceptance IS NOT NULL AND NOT public.catalog_acceptance_roster_valid_v2(p_acceptance,basket) THEN RETURN NULL; END IF;
 RETURN basket;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_order_evidence_v2(uuid,jsonb,jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_quoted_edit_evidence_v2(p_lines jsonb,p_sized boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE lines jsonb; basket jsonb;
BEGIN
 IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 SELECT jsonb_agg(jsonb_build_object('variantId',l->'variantId',
  'sku',CASE WHEN p_sized THEN l#>'{quoteLine,sku}' ELSE to_jsonb(k.sku) END,
  'quantity',CASE WHEN p_sized THEN l->'qty' ELSE l->'quantity' END,
  'isAddon',l->'isAddon'))
 INTO lines FROM jsonb_array_elements(p_lines) l
 LEFT JOIN public.catalog_skus k ON k.id=CASE WHEN NOT p_sized AND l->>'variantId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  THEN (l->>'variantId')::uuid END;
 basket:=public.catalog_retained_basket_v2(lines);
 IF basket IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) l
    WHERE jsonb_typeof(l->'isAddon') IS DISTINCT FROM 'boolean') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('basket',basket,'roles',(SELECT jsonb_object_agg(l->>'sku',l-ARRAY['sku','variantId'])
    FROM jsonb_array_elements(lines) l));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_quoted_edit_evidence_v2(jsonb,boolean) FROM PUBLIC;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscription_edit_quotes_accepted_event_idx ON public.subscription_edit_quotes (accepted_event_id);

CREATE FUNCTION public.catalog_edit_evidence_v2(p_event public.subscription_events) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE payload jsonb:=p_event.payload; edit_action text:=payload->>'action'; preview public.subscription_quote_previews;
 old_quote public.subscription_edit_quotes; edited jsonb; quoted jsonb; proposed jsonb; hash text; basis integer;
 edited_roles jsonb;
BEGIN
 IF edit_action IS NULL OR p_event.event_type<>'subscription.customer_self_service.'||edit_action THEN RETURN NULL; END IF;
 IF payload ? 'linePricing' THEN
  edited:=public.catalog_retained_basket_v2(payload->'linePricing');
  IF edited IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_object_agg(coalesce(l->>'sku',l->>'skuCode'),jsonb_build_object(
    'quantity',coalesce(l->'quantity',l->'qty'),'isAddon',l->'isAddon'))
  INTO edited_roles FROM jsonb_array_elements(payload->'linePricing') l;
 END IF;
 IF payload ? 'quotePreviewId' THEN
  IF coalesce(payload->>'quotePreviewId','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  SELECT * INTO preview FROM public.subscription_quote_previews q
   WHERE q.id=(payload->>'quotePreviewId')::uuid AND q.subscription_id=p_event.subscription_id AND q.action=edit_action
    AND EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.id=q.subscription_id AND s.client_id=q.client_id)
    AND q.status='accepted' AND q.accepted_event_id=p_event.id AND q.accepted_at=p_event.occurred_at;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF edit_action='update_package_template' THEN
   IF jsonb_typeof(preview.quote_snapshot->'baseLines') IS DISTINCT FROM 'array'
    OR jsonb_typeof(preview.quote_snapshot->'addonLines') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
   SELECT jsonb_agg(l||jsonb_build_object('isAddon',i>jsonb_array_length(preview.quote_snapshot->'baseLines')) ORDER BY i)
   INTO proposed FROM jsonb_array_elements((preview.quote_snapshot->'baseLines')||(preview.quote_snapshot->'addonLines')) WITH ORDINALITY x(l,i);
  ELSE proposed:=preview.quote_snapshot->'lines'; END IF;
  quoted:=public.catalog_quoted_edit_evidence_v2(proposed,true);
  IF quoted IS NULL OR (edited IS NOT NULL AND (quoted->'basket' IS DISTINCT FROM edited
    OR quoted->'roles' IS DISTINCT FROM edited_roles)) THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM public.subscription_quote_previews q WHERE q.accepted_event_id=p_event.id)<>1
   OR EXISTS(SELECT 1 FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=p_event.id) THEN RETURN NULL; END IF;
  hash:=preview.quote_hash; basis:=preview.template_version;
 ELSE
  IF EXISTS(SELECT 1 FROM public.subscription_quote_previews q WHERE q.accepted_event_id=p_event.id) THEN RETURN NULL; END IF;
  SELECT * INTO old_quote FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=p_event.id
   AND q.subscription_id=p_event.subscription_id AND q.status='accepted' AND q.accepted_at=p_event.occurred_at;
  IF FOUND THEN
   hash:=coalesce(payload#>>'{payload,acceptedQuoteHash}',payload->>'quoteHash');
   basis:=old_quote.expected_template_version;
   -- The classic command owner uses the bundle quote row for its entire action
   -- family. Its event binds the actual action and basis through its request.
   IF payload#>'{payload,acceptedQuoteHash}' IS NOT NULL THEN
    IF old_quote.idempotency_key IS DISTINCT FROM p_event.idempotency_key
     OR payload#>'{payload,expectedTemplateVersion}' IS DISTINCT FROM to_jsonb(basis)
     OR edit_action NOT IN ('update_bundle','resize_bundle','update_package_template','update_plan_length',
       'add_addon','remove_addon','update_addon_quantity') THEN RETURN NULL; END IF;
   ELSIF old_quote.action IS DISTINCT FROM edit_action THEN RETURN NULL; END IF;
   IF hash IS DISTINCT FROM old_quote.quote_hash OR (payload ? 'quoteHash' AND payload->>'quoteHash' IS DISTINCT FROM hash)
    OR (SELECT count(*) FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=p_event.id)<>1 THEN RETURN NULL; END IF;
   quoted:=public.catalog_quoted_edit_evidence_v2(old_quote.proposed_lines,false);
   IF quoted IS NULL OR (edited IS NOT NULL AND (quoted->'basket' IS DISTINCT FROM edited
      OR quoted->'roles' IS DISTINCT FROM edited_roles)) THEN RETURN NULL; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=p_event.id)
   OR payload ? 'quoteHash' OR payload#>'{payload,acceptedQuoteHash}' IS NOT NULL THEN RETURN NULL;
  ELSIF edited IS NOT NULL THEN quoted:=jsonb_build_object('basket',edited); END IF;
 END IF;
 IF quoted IS NULL THEN RETURN NULL; END IF;
 RETURN quoted||jsonb_build_object('basis',basis,'quoteHash',hash,'commandKey',preview.accepted_idempotency_key);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_edit_evidence_v2(public.subscription_events) FROM PUBLIC;

CREATE FUNCTION public.catalog_full_graduation_lines_v2(p_payload jsonb,p_graduation jsonb,p_subscription uuid,p_latest boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE before_lines jsonb:=p_payload->'before'; final_lines jsonb:=p_payload->'lines';
 pricing jsonb:=p_payload->'linePricing'; marker jsonb:=p_graduation->'lines'; carried jsonb:=p_payload->'carriedAddonSkus';
 line jsonb; sku_code text; role jsonb; roles jsonb; prior_version integer:=(p_payload->>'basisTemplateVersion')::integer;
 actual_carried jsonb:='[]';
BEGIN
 IF jsonb_typeof(marker) IS DISTINCT FROM 'array' OR public.catalog_retained_basket_v2(before_lines) IS NULL
  OR public.catalog_retained_basket_v2(final_lines) IS NULL OR jsonb_typeof(pricing) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(marker))
  OR public.catalog_retained_basket_v2(marker) IS NULL
  OR (jsonb_array_length(pricing)>0 AND public.catalog_retained_basket_v2(pricing) IS NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(pricing) p WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(final_lines) l WHERE p->'sku'=l->'sku' AND p->'quantity'=l->'quantity'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(marker) m WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(final_lines) l JOIN jsonb_array_elements(pricing) p ON p->'sku'=l->'sku'
    WHERE l->'sku'=m->'sku' AND l->'quantity'=m->'qty'
     AND p->'quoteLine'=m->'quoteLine'
     AND p->'isAddon'=m->'isAddon')) THEN RETURN false; END IF;

 IF prior_version>1 THEN roles:=public.subscription_catalog_basis_transition(p_subscription,prior_version-1)->'roles'; END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(final_lines) l
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(marker) m WHERE m->'sku'=l.value->'sku')
 LOOP
  sku_code:=line->>'sku';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before_lines) b WHERE (b->'sku',b->'quantity')=(line->'sku',line->'quantity')) THEN RETURN false; END IF;
  actual_carried:=actual_carried||jsonb_build_array(sku_code);
  role:=NULL;
  IF jsonb_typeof(roles)='object' THEN
   IF roles->sku_code->'quantity' IS DISTINCT FROM line->'quantity' THEN RETURN false; END IF;
   role:=roles->sku_code->'isAddon';
  END IF;
  -- Before a further edit, a matching template row was preserved by graduation.
  IF p_latest AND role IS NULL THEN
   SELECT to_jsonb(l.is_addon) INTO role FROM public.subscription_lines l JOIN public.catalog_skus k ON k.id=l.variant_id
   WHERE l.subscription_id=p_subscription AND k.sku=sku_code AND to_jsonb(l.quantity)=line->'quantity';
  END IF;
  IF role='false'::jsonb OR (carried IS NULL AND role IS DISTINCT FROM 'true'::jsonb) THEN RETURN false; END IF;
 END LOOP;
 IF carried IS NOT NULL AND (jsonb_typeof(carried) IS DISTINCT FROM 'array'
  OR jsonb_array_length(carried)<>jsonb_array_length(actual_carried) OR NOT carried @> actual_carried) THEN RETURN false; END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_full_graduation_lines_v2(jsonb,jsonb,uuid,boolean) FROM PUBLIC;

-- The subscription owner's accepted command is the transition evidence. The
-- actor who saved a preview may differ from the actor whose command applied it.
CREATE FUNCTION public.subscription_catalog_basis_transition(p_subscription uuid,p_basis integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE event public.subscription_events; evidence jsonb; result jsonb; candidate jsonb; marker jsonb;
 current_version integer; latest_only boolean; before_basket jsonb; basket jsonb; kind text;
BEGIN
 SELECT template_version INTO current_version FROM public.subscriptions WHERE id=p_subscription;
 IF NOT FOUND OR p_basis<1 OR p_basis>=current_version THEN RETURN '{"outcome":"missing"}'::jsonb; END IF;
 latest_only:=current_version::bigint=p_basis::bigint+1;

 FOR event IN SELECT e.* FROM public.subscription_events e WHERE e.subscription_id=p_subscription AND (
  (e.event_type IN ('subscription.starter_graduated','subscription.starter_cadence_normalized')
    AND e.payload->'templateVersion'=to_jsonb(p_basis::bigint+1))
  OR e.event_type LIKE 'subscription.customer_self_service.%')
 LOOP
  before_basket:=NULL;
  IF event.event_type LIKE 'subscription.customer_self_service.%' THEN
   evidence:=public.catalog_edit_evidence_v2(event);
   IF evidence->'basis' IS DISTINCT FROM to_jsonb(p_basis) THEN CONTINUE; END IF;
   IF NOT (event.payload->>'quoteHash'=evidence->>'quoteHash' AND NOT (event.payload ? 'quotePreviewId')
    AND event.payload#>'{payload,acceptedQuoteHash}' IS NULL
    AND event.payload->'templateVersion'=to_jsonb(p_basis::bigint+1)) IS TRUE
    AND NOT EXISTS(SELECT 1 FROM public.subscription_command_receipts r
     JOIN public.subscriptions s ON s.id=r.subscription_id AND s.client_id=r.client_id
     WHERE r.subscription_id=p_subscription AND r.quote_hash=evidence->>'quoteHash'
      AND (evidence->>'commandKey' IS NULL OR r.idempotency_key=evidence->>'commandKey')
      AND event.idempotency_key='command:'||encode(sha256(convert_to(r.actor_id::text||':'||r.idempotency_key,'UTF8')),'hex')
      AND r.status='applied' AND r.result->>'status'='applied'
      AND r.command->'clientId'=to_jsonb(r.client_id) AND r.command->'subscriptionId'=to_jsonb(r.subscription_id)
      AND r.command->>'action'=event.payload->>'action' AND r.result->>'action'=event.payload->>'action'
      AND r.result->'subscriptionId'=to_jsonb(r.subscription_id) AND r.result->'eventId'=to_jsonb(event.id)
      AND r.result->'templateVersion'=to_jsonb(p_basis::bigint+1)) THEN CONTINUE; END IF;
   basket:=evidence->'basket';
   kind:='edit';
  ELSE
   -- Starter terms belong to the purchase attachment, including its saved basis.
   SELECT a.purchase_facts#>'{renewalTerms,starterPack}' INTO marker
   FROM public.subscription_renewal_attachments a WHERE a.subscription_id=p_subscription AND a.completed_at IS NOT NULL;
   IF marker->'schemaVersion' IS DISTINCT FROM '"1"'::jsonb
    OR (jsonb_typeof(marker->'basisTemplateVersion')='number' AND pg_input_is_valid(marker->>'basisTemplateVersion','integer') AND (marker->>'basisTemplateVersion')::numeric BETWEEN 1 AND p_basis) IS DISTINCT FROM true
    OR (jsonb_typeof(marker#>'{graduation,cadenceDays}')='number' AND pg_input_is_valid(marker#>>'{graduation,cadenceDays}','integer') AND (marker#>>'{graduation,cadenceDays}')::numeric>0) IS DISTINCT FROM true
    OR event.payload->'basisTemplateVersion' IS DISTINCT FROM marker->'basisTemplateVersion'
    OR event.payload->'cadenceDays' IS DISTINCT FROM marker#>'{graduation,cadenceDays}' THEN CONTINUE; END IF;
   IF event.event_type='subscription.starter_graduated' THEN
    IF marker->'basisTemplateVersion' IS DISTINCT FROM to_jsonb(p_basis)
     OR event.payload->>'mode' IS DISTINCT FROM 'full'
     OR event.idempotency_key !~ ('^(system:)*starter-graduation:'||p_subscription::text||':'||p_basis::text||'$')
     OR NOT public.catalog_full_graduation_lines_v2(event.payload,marker->'graduation',p_subscription,latest_only)
    THEN CONTINUE; END IF;
    kind:='graduation';
   ELSE
    IF event.payload->>'mode' IS DISTINCT FROM 'cadence_only'
     OR event.idempotency_key !~ ('^(system:)*starter-cadence-normalize:'||p_subscription::text||':'||(marker->>'basisTemplateVersion')||'$')
         OR event.payload->'before' IS DISTINCT FROM event.payload->'lines' THEN CONTINUE; END IF;
    kind:='cadence';
   END IF;
   before_basket:=public.catalog_retained_basket_v2(event.payload->'before');
   basket:=public.catalog_retained_basket_v2(event.payload->'lines');
  END IF;
  IF basket IS NULL THEN CONTINUE; END IF;
  IF result IS NOT NULL THEN RETURN '{"outcome":"ambiguous"}'::jsonb; END IF;
  candidate:=jsonb_build_object('outcome','proved','eventId',event.id,'kind',kind,'from',p_basis,
    'to',p_basis::bigint+1,'basket',basket);
  IF kind='edit' THEN candidate:=candidate||jsonb_build_object('roles',evidence->'roles'); END IF;
  result:=CASE WHEN before_basket IS NULL THEN candidate ELSE candidate||jsonb_build_object('before',before_basket) END;
 END LOOP;
 RETURN coalesce(result,'{"outcome":"missing"}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.subscription_catalog_basis_transition(uuid,integer) FROM PUBLIC;

CREATE FUNCTION public.subscription_catalog_purchase_handoff(p_subscription uuid,p_version integer,p_purchase jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE transition jsonb; expected jsonb:=p_purchase;
BEGIN
 IF p_version IS NULL OR p_version<1 OR expected IS NULL THEN RETURN false; END IF;
 FOR basis IN 1..p_version-1 LOOP
  transition:=public.subscription_catalog_basis_transition(p_subscription,basis);
  IF transition->>'outcome'<>'proved' OR (transition ? 'before' AND transition->'before' IS DISTINCT FROM expected)
  THEN RETURN false; END IF;
  expected:=transition->'basket';
 END LOOP;
 RETURN expected IS NOT DISTINCT FROM (SELECT jsonb_object_agg(l.sku,l.quantity) FROM public.subscription_renewal_term_lines l
                  WHERE l.subscription_id=p_subscription)
  AND expected IS NOT DISTINCT FROM (SELECT jsonb_object_agg(k.sku,l.quantity) FROM public.subscription_lines l
                JOIN public.catalog_skus k ON k.id=l.variant_id WHERE l.subscription_id=p_subscription);
END;
$$;
REVOKE ALL ON FUNCTION public.subscription_catalog_purchase_handoff(uuid,integer,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; obligations jsonb := '[]'; item record;
 marker jsonb; graduation jsonb; line jsonb; basis integer; codes text[]; manifest jsonb;
 basket jsonb; purchase_basket jsonb; unknown boolean := false;
BEGIN
 -- A filtered or non-owner read cannot prove absence.
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[
  'public.catalog_products'::regclass,'public.catalog_skus'::regclass,'public.catalog_publications'::regclass,'public.catalog_publication_heads'::regclass,'public.catalog_sku_revisions'::regclass,
  'public.subscriptions'::regclass,'public.subscription_lines'::regclass,'public.subscription_renewal_terms'::regclass,'public.subscription_renewal_term_lines'::regclass,
  'public.subscription_activations'::regclass,'public.subscription_renewal_attachments'::regclass,'public.subscription_renewal_operations'::regclass,
  'public.subscription_renewal_outcomes'::regclass,'public.subscription_cycles'::regclass,'public.commerce_orders'::regclass,'public.commerce_order_items'::regclass,
  'public.commerce_order_draft_receipts'::regclass,
  'public.commerce_settlement_intents'::regclass,'public.commerce_order_holds'::regclass,'public.fulfillment_inventory_reservations'::regclass,
  'public.fulfillment_shipments'::regclass,'public.fulfillment_parcel_reservation_sets'::regclass,'public.fulfillment_parcel_lines'::regclass,
  'public.subscription_stock_wait_cases'::regclass,'public.subscription_events'::regclass,'public.subscription_edit_quotes'::regclass,
  'public.subscription_quote_previews'::regclass,'public.subscription_command_receipts'::regclass])
  AND (row_security_active(c.oid) OR NOT pg_has_role(current_user,c.relowner,'USAGE'))) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unavailable','reason','catalog_obligation_evidence_unavailable');
 END IF;
 SELECT * INTO sku FROM public.catalog_skus WHERE id=p_sku_id;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
 END IF;
 SELECT public.catalog_publication_read_manifest(p.product_id,p.canonical_state,p.digest) INTO manifest
 FROM public.catalog_publications p JOIN public.catalog_publication_heads h
  ON (h.product_id,h.publication_id,h.revision)=(p.product_id,p.id,p.revision)
 WHERE p.product_id=sku.product_id;
 IF manifest->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'skus') e WHERE e->'skuId'=to_jsonb(sku.id)
   AND public.catalog_publication_read_sku_revision(sku.product_id,e)->>'code'=sku.sku)
 THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
 END IF;
 IF EXISTS(SELECT 1 FROM public.subscriptions s
  LEFT JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
  WHERE s.status IN ('active','paused') AND (
   (t.subscription_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=s.id))
   OR (t.subscription_id IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=s.id)
      OR EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=s.id
       AND NOT EXISTS(SELECT 1 FROM public.catalog_skus k WHERE k.sku=l.sku)))))) THEN unknown:=true; END IF;
 FOR item IN
  SELECT s.id,sl.catalog_sku_revision_id AS revision FROM public.subscriptions s JOIN public.subscription_lines sl ON sl.subscription_id=s.id
   WHERE s.status IN ('active','paused') AND sl.variant_id=sku.id
  UNION
  SELECT s.id,NULL::uuid FROM public.subscriptions s JOIN public.subscription_renewal_term_lines tl ON tl.subscription_id=s.id
   WHERE s.status IN ('active','paused') AND tl.sku=sku.sku
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','template','sourceId',item.id,'subscriptionId',item.id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',item.revision));
 END LOOP;
 -- The pending order and its activation/attachment are alternative entry points
 -- to the same handoff. An attachment marker alone is insufficient.
 FOR item IN SELECT o.id,o.metadata,o.catalog_acceptance,a.subscription_id,s.template_version,t.purchase_facts,
  a.state='active' AND t.completed_at IS NOT NULL AND t.subscription_id=a.subscription_id
   AND EXISTS(SELECT 1 FROM public.subscription_renewal_terms r WHERE r.subscription_id=a.subscription_id)
   AS handed_off
  FROM public.commerce_orders o
  LEFT JOIN public.subscription_activations a ON a.order_id=o.id
  LEFT JOIN public.subscription_renewal_attachments t ON t.order_id=o.id
  LEFT JOIN public.subscriptions s ON s.id=a.subscription_id
  WHERE (t.order_id IS NOT NULL AND t.completed_at IS NULL) OR a.state<>'compensated'
   OR (a.order_id IS NULL AND o.renewal_operation_id IS NULL AND o.status='pending_payment')
 LOOP
  basket:=public.catalog_order_evidence_v2(item.id,item.metadata,item.catalog_acceptance,true);
  IF basket IS NULL THEN unknown:=true; CONTINUE; END IF;
  IF item.handed_off THEN
   purchase_basket:=public.catalog_retained_basket_v2(item.purchase_facts->'lines',true);
   IF purchase_basket IS DISTINCT FROM basket THEN unknown:=true;
   ELSIF NOT public.subscription_catalog_purchase_handoff(item.subscription_id,item.template_version,purchase_basket) THEN unknown:=true;
   END IF;
   CONTINUE;
  END IF;
  IF basket ? sku.sku THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','pending_activation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.renewal_operation_id IS NULL
  AND c.status IN ('planned','payment_pending','retry_scheduled')
  AND NOT EXISTS(SELECT 1 FROM public.commerce_orders o WHERE o.subscription_cycle_id=c.id AND o.status<>'cancelled'
   AND (o.status<>'pending_payment' OR o.catalog_acceptance IS NOT NULL OR o.metadata#>'{quoteSnapshot,quote,lines}' IS NOT NULL
    OR o.metadata#>'{orderDraftSnapshot,lines}' IS NOT NULL OR o.metadata#>'{orderSnapshot,lines}' IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id)))) THEN unknown:=true; END IF;
 FOR item IN SELECT op.id,op.subscription_id,op.cycle_snapshot,op.operation_fingerprint FROM public.subscription_renewal_operations op
  JOIN public.subscriptions s ON s.id=op.subscription_id
  WHERE op.state NOT IN ('succeeded','refused')
   OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.renewal_operation_id=op.id AND c.status IN ('planned','payment_pending','retry_scheduled'))
   OR (op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired')
    AND s.status='active' AND s.next_cycle_at=op.scheduled_at AND op.attempt_prepared_at IS NULL
    AND op.external_attempt_ref IS NULL AND op.external_attempt_acknowledged_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.renewal_operation_id=op.id)
    AND NOT EXISTS(SELECT 1 FROM public.commerce_orders o WHERE o.renewal_operation_id=op.id)
    AND NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.renewal_operation_id=op.id)
    AND NOT EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes r WHERE r.renewal_operation_id=op.id
      AND (r.outcome<>'refused' OR r.reason IS NULL OR r.reason NOT IN ('inventory_unavailable','reservation_expired') OR r.external_ref IS NOT NULL
       OR r.operation_fingerprint<>op.operation_fingerprint OR r.event_key NOT IN (op.identity_key||':inventory',op.identity_key||':reservation-expired'))))
 LOOP
  codes:=public.catalog_frozen_basket_codes_v2(item.cycle_snapshot);
 IF codes IS NULL THEN unknown:=true;
  ELSIF sku.sku=ANY(codes) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','frozen_renewal','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.commerce_orders o WHERE o.status IN ('paid','fulfillment_pending','fulfilled')
  AND public.catalog_order_evidence_v2(o.id,o.metadata,o.catalog_acceptance,false) IS NULL) THEN unknown:=true; END IF;
 -- The order item (never order status) owns the unit of discharge.
 FOR item IN SELECT DISTINCT o.id,c.subscription_id FROM public.commerce_orders o
  LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
  JOIN public.commerce_order_items i ON i.order_id=o.id
  WHERE o.status IN ('paid','fulfillment_pending','fulfilled') AND i.sku_id=sku.id
   AND i.quantity IS DISTINCT FROM (SELECT sum(l.quantity) FROM public.fulfillment_parcel_lines l
     JOIN public.fulfillment_parcel_reservation_sets b ON b.shipment_id=l.shipment_id AND b.order_id=o.id
     JOIN public.fulfillment_shipments p ON p.id=l.shipment_id AND p.order_id=o.id
     WHERE l.order_item_id=i.id AND l.sku_id=sku.id AND l.sku=sku.sku AND p.delivered_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id=p.id))
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','outstanding_order','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 FOR item IN SELECT p.id,c.subscription_id,
  (SELECT bool_and(coalesce(b.order_id=p.order_id AND i.order_id=p.order_id AND predecessor.order_id=p.order_id AND k.id=i.sku_id AND l.sku_id=k.id
    AND l.sku=k.sku AND l.quantity<=i.quantity,false))
   FROM public.fulfillment_parcel_lines l JOIN public.fulfillment_parcel_reservation_sets b ON b.shipment_id=l.shipment_id
   JOIN public.commerce_order_items i ON i.id=l.order_item_id LEFT JOIN public.catalog_skus k ON k.id=i.sku_id
   WHERE l.shipment_id=p.id) AND NOT EXISTS(
    SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=p.order_id AND i.sku_id IS NOT NULL
     AND i.quantity IS DISTINCT FROM (SELECT sum(l.quantity) FROM public.fulfillment_parcel_lines l
      WHERE l.shipment_id=p.id AND l.order_item_id=i.id)) AS attributed,
  EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines l WHERE l.shipment_id=p.id AND l.sku_id=sku.id) AS matches
  FROM public.fulfillment_shipments p JOIN public.fulfillment_shipments predecessor ON predecessor.id=p.replaces_shipment_id
  JOIN public.commerce_orders o ON o.id=p.order_id LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
  WHERE p.delivered_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments next WHERE next.replaces_shipment_id=p.id)
 LOOP
  IF item.attributed IS DISTINCT FROM true OR NOT EXISTS(
   SELECT 1 FROM public.fulfillment_shipments p JOIN public.commerce_orders o ON o.id=p.order_id
    WHERE p.id=item.id AND public.catalog_order_evidence_v2(o.id,o.metadata,o.catalog_acceptance,false) IS NOT NULL
  ) THEN unknown:=true;
  ELSIF item.matches THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','replacement','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 FOR item IN SELECT w.id,w.subscription_id,w.cycle_snapshot,w.fingerprint,
  op.subscription_id=w.subscription_id AND op.scheduled_at=w.scheduled_at AND op.cycle_number=w.cycle_number
    AND op.cycle_snapshot=w.cycle_snapshot AND op.operation_fingerprint=w.fingerprint AND op.identity_key=w.identity_key AS bound,
  w.state='resumed' AND EXISTS(
   SELECT 1 FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   JOIN public.fulfillment_shipments p ON p.id=w.fulfillment_id AND p.order_id=o.id AND p.replaces_shipment_id IS NULL
   WHERE o.id=w.order_id AND c.id=w.cycle_id AND c.subscription_id=w.subscription_id AND c.renewal_operation_id=w.renewal_operation_id
    AND o.renewal_operation_id=w.renewal_operation_id AND o.status IN ('paid','fulfillment_pending','fulfilled') AND c.status='paid'
    AND p.status NOT IN ('cancelled','exception')
    AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id AND i.status='settled')
    AND EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations r WHERE r.renewal_operation_id=w.renewal_operation_id AND r.status='consumed')
    AND NOT EXISTS(SELECT 1 FROM public.commerce_order_holds h WHERE h.order_id=o.id AND h.status='active')
    AND public.catalog_order_evidence_v2(o.id,o.metadata,o.catalog_acceptance,false)=public.catalog_retained_basket_v2(w.cycle_snapshot->'lines')) AS handed_off
  FROM public.subscription_stock_wait_cases w LEFT JOIN public.subscription_renewal_operations op ON op.id=w.renewal_operation_id
  WHERE w.state IN ('waiting','stock_secured','resumed')
 LOOP
  codes:=public.catalog_frozen_basket_codes_v2(item.cycle_snapshot);
  IF item.bound IS DISTINCT FROM true OR codes IS NULL THEN unknown:=true;
  ELSIF item.handed_off IS DISTINCT FROM true AND sku.sku=ANY(codes) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','stock_wait','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 FOR item IN SELECT a.order_id AS id,a.subscription_id,a.purchase_facts,s.template_version FROM public.subscription_renewal_attachments a
  JOIN public.subscriptions s ON s.id=a.subscription_id WHERE s.status IN ('active','paused') AND a.purchase_facts#>'{renewalTerms,starterPack}' IS NOT NULL
 LOOP
  marker:=item.purchase_facts#>'{renewalTerms,starterPack}';
  graduation:=marker->'graduation';
  codes:=public.catalog_retained_basket_codes_v2(graduation->'lines');
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR marker->'schemaVersion' IS DISTINCT FROM '"1"'::jsonb
   OR marker - ARRAY['schemaVersion','basisTemplateVersion','starterIntervalDays','delivery2','graduation'] <> '{}'::jsonb
   OR jsonb_typeof(marker->'basisTemplateVersion') IS DISTINCT FROM 'number' OR marker->>'basisTemplateVersion' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(marker->'starterIntervalDays') IS DISTINCT FROM 'number' OR marker->>'starterIntervalDays' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(graduation) IS DISTINCT FROM 'object' OR graduation - ARRAY['cadenceDays','sizeConstraint','lines'] <> '{}'::jsonb
   OR jsonb_typeof(graduation->'cadenceDays') IS DISTINCT FROM 'number' OR graduation->>'cadenceDays' !~ '^[1-9][0-9]{0,9}$'
   OR (graduation ? 'sizeConstraint' AND jsonb_typeof(graduation->'sizeConstraint') IS DISTINCT FROM 'object')
   OR codes IS NULL OR EXISTS(SELECT FROM unnest(codes) code WHERE NOT EXISTS(SELECT FROM public.catalog_skus k WHERE k.sku=code)) THEN unknown:=true; CONTINUE; END IF;
  IF (marker->>'basisTemplateVersion')::bigint>2147483647 OR (marker->>'starterIntervalDays')::bigint>2147483647
   OR (graduation->>'cadenceDays')::bigint>2147483647 THEN unknown:=true; CONTINUE; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(graduation->'lines') LOOP
   IF line - ARRAY['sku','qty','sortOrder','isAddon','quoteLine'] <> '{}'::jsonb
    OR jsonb_typeof(line->'sku') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'qty') IS DISTINCT FROM 'number'
    OR line->>'qty' !~ '^[1-9][0-9]?$'
    OR jsonb_typeof(line->'sortOrder') IS DISTINCT FROM 'number' OR line->>'sortOrder' !~ '^(0|[1-9][0-9]{0,15})$'
    OR jsonb_typeof(line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(line->'quoteLine') IS DISTINCT FROM 'object'
    OR ((line->'quoteLine') ? 'sku' AND line#>'{quoteLine,sku}' IS DISTINCT FROM line->'sku')
    OR ((line->'quoteLine') ? 'quantity' AND line#>'{quoteLine,quantity}' IS DISTINCT FROM line->'qty') THEN unknown:=true; EXIT; END IF;
  END LOOP;
  IF unknown THEN CONTINUE; END IF;
  basis:=(marker->>'basisTemplateVersion')::integer;
  IF basis<>item.template_version THEN
   IF basis<item.template_version AND public.subscription_catalog_basis_transition(item.subscription_id,basis)->>'kind' IN ('edit','graduation') THEN CONTINUE; END IF;
   unknown:=true; CONTINUE;
  END IF;
  IF sku.sku=ANY(codes) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','graduation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 IF unknown THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 RETURN jsonb_build_object('schemaVersion',2,'outcome','complete','obligations',
  (SELECT coalesce(jsonb_agg(value ORDER BY value->>'family',value->>'sourceId',value->>'skuRevisionId'),'[]'::jsonb)
   FROM jsonb_array_elements(obligations)));
EXCEPTION WHEN insufficient_privilege THEN
 RETURN jsonb_build_object('schemaVersion',2,'outcome','unavailable','reason','catalog_obligation_evidence_unavailable');
WHEN data_exception OR check_violation THEN
 RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_bound_obligations_v2(uuid) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.catalog_lifecycle_assert_archive(p_product uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE sku uuid; manifest jsonb; census jsonb; blocked boolean:=false;
BEGIN
 SELECT public.catalog_publication_read_manifest(p_product,p.canonical_state,p.digest) INTO manifest
 FROM public.catalog_publication_heads h JOIN public.catalog_publications p
  ON (h.product_id,h.publication_id,h.revision)=(p.product_id,p.id,p.revision)
 WHERE h.product_id=p_product;
 IF manifest->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN
  RAISE EXCEPTION 'catalog_obligation_evidence_unknown' USING ERRCODE='23514', CONSTRAINT='catalog_obligation_evidence_unknown'; END IF;
 FOR sku IN SELECT (value->>'skuId')::uuid FROM jsonb_array_elements(manifest->'skus') LOOP
  census:=public.catalog_bound_obligations_v2(sku);
  IF census->>'outcome'='unavailable' THEN
   RAISE EXCEPTION 'catalog_obligation_evidence_unavailable' USING ERRCODE='23514', CONSTRAINT='catalog_obligation_evidence_unavailable'; END IF;
  IF census->>'outcome' IS DISTINCT FROM 'complete' THEN
   RAISE EXCEPTION 'catalog_obligation_evidence_unknown' USING ERRCODE='23514', CONSTRAINT='catalog_obligation_evidence_unknown'; END IF;
  blocked:=blocked OR jsonb_array_length(census->'obligations')>0;
 END LOOP;
 IF blocked THEN RAISE EXCEPTION 'catalog_bound_obligations' USING ERRCODE='23514', CONSTRAINT='catalog_bound_obligations'; END IF;
 RAISE EXCEPTION 'catalog_archive_barrier_unavailable' USING ERRCODE='23514', CONSTRAINT='catalog_archive_barrier_unavailable',
  HINT='Keep the product or SKU withdrawn until governed archive is supported.';
END;
$$;

CREATE FUNCTION public.catalog_order_acceptance_final(p_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE target public.commerce_orders; basket jsonb;
BEGIN
 SELECT * INTO target FROM public.commerce_orders WHERE id=p_order_id;
 IF target.catalog_acceptance IS NULL THEN RETURN; END IF;
 IF target.renewal_operation_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=target.renewal_operation_id
   AND op.catalog_acceptance=target.catalog_acceptance AND op.catalog_acceptance_fingerprint=target.renewal_operation_fingerprint)
   THEN RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023'; END IF;
 ELSIF target.catalog_receipt_key IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=p_order_id AND r.idempotency_key=target.catalog_receipt_key
  ) THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023';
 END IF;
 basket:=public.catalog_order_evidence_v2(p_order_id,target.metadata,target.catalog_acceptance,target.renewal_operation_id IS NULL);
 IF basket IS NULL OR (target.catalog_basket IS NOT NULL AND target.catalog_basket IS DISTINCT FROM basket)
  OR (target.catalog_basket IS NULL AND NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=p_order_id)) THEN
  RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_order_acceptance_final(uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_attach_order_acceptance(p_order_id uuid,p_acceptance jsonb,p_receipt_key text,p_basket jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF p_acceptance IS NULL THEN RETURN; END IF;
 PERFORM public.catalog_acceptance_assert_v2(p_acceptance);
 IF p_receipt_key IS NULL THEN RAISE EXCEPTION 'catalog_acceptance_receipt_mismatch' USING ERRCODE='22023'; END IF;
 UPDATE public.commerce_orders SET catalog_acceptance=p_acceptance,catalog_receipt_key=p_receipt_key,catalog_basket=p_basket
 WHERE id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_acceptance_order_missing' USING ERRCODE='22023'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_attach_order_acceptance(uuid,jsonb,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_edit_acceptance_final(p_event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE event public.subscription_events; basket jsonb;
BEGIN
 SELECT * INTO event FROM public.subscription_events WHERE id=p_event_id;
 IF event.catalog_acceptance IS NULL THEN RETURN; END IF;
 basket:=public.catalog_edit_evidence_v2(event)->'basket';
 IF NOT public.catalog_acceptance_roster_valid_v2(event.catalog_acceptance,basket)
  OR (event.catalog_basket IS NULL AND NOT (event.payload ? 'linePricing'))
  OR (event.catalog_basket IS NOT NULL AND event.catalog_basket IS DISTINCT FROM basket) THEN
  RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_edit_acceptance_final(uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_bind_template_v2(p_subscription uuid,p_acceptance jsonb,p_basket jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE template_basket jsonb;
BEGIN
 IF p_acceptance IS NULL THEN RETURN; END IF;
 PERFORM public.catalog_acceptance_assert_v2(p_acceptance);
 SELECT jsonb_object_agg(sku,quantity) INTO template_basket FROM (
  SELECT k.sku,sum(l.quantity) AS quantity FROM public.subscription_lines l
  JOIN public.catalog_skus k ON k.id=l.variant_id WHERE l.subscription_id=p_subscription GROUP BY k.sku) lines;
 IF template_basket IS DISTINCT FROM p_basket OR NOT public.catalog_acceptance_roster_valid_v2(p_acceptance,p_basket) THEN
  RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023';
 END IF;
 UPDATE public.subscription_lines l SET catalog_sku_revision_id=(ref->>'skuRevisionId')::uuid
 FROM jsonb_array_elements(p_acceptance->'lines') ref
 WHERE l.subscription_id=p_subscription AND l.variant_id=(ref->>'skuId')::uuid;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_bind_template_v2(uuid,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_attach_edit_acceptance(p_event_id uuid,p_acceptance jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE event public.subscription_events; basket jsonb;
BEGIN
 IF p_acceptance IS NULL THEN RETURN; END IF;
 SELECT * INTO STRICT event FROM public.subscription_events WHERE id=p_event_id;
 basket:=public.catalog_edit_evidence_v2(event)->'basket';
 PERFORM public.catalog_bind_template_v2(event.subscription_id,p_acceptance,basket);
 UPDATE public.subscription_events SET catalog_acceptance=p_acceptance,catalog_basket=basket WHERE id=p_event_id;
 -- Only the edit paths that rewrote retained lines may replace their evidence.
 UPDATE public.subscription_renewal_terms SET catalog_acceptance=p_acceptance WHERE subscription_id=event.subscription_id
  AND basket=(SELECT jsonb_object_agg(sku,quantity) FROM (
   SELECT sku,sum(quantity) AS quantity FROM public.subscription_renewal_term_lines
   WHERE subscription_id=event.subscription_id GROUP BY sku) lines);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_attach_edit_acceptance(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_customer_edit_acceptance_assert(p_event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.subscription_events e
   JOIN public.subscriptions s ON s.id=e.subscription_id JOIN public.clients c ON c.id=s.client_id
   WHERE e.id=p_event_id AND c.principal_id=auth.uid()) THEN
  PERFORM public.catalog_edit_acceptance_final(p_event_id);
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_customer_edit_acceptance_assert(uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_edit_acceptance_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE previous uuid; current_event uuid; target uuid; supplied jsonb;
BEGIN
 IF TG_TABLE_NAME='subscription_events' THEN
  IF TG_OP='UPDATE' AND OLD.catalog_acceptance IS NOT NULL
   AND (NEW.catalog_acceptance,NEW.catalog_basket,NEW.subscription_id,NEW.event_type,NEW.id)
    IS DISTINCT FROM (OLD.catalog_acceptance,OLD.catalog_basket,OLD.subscription_id,OLD.event_type,OLD.id) THEN
   RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.catalog_acceptance IS NULL THEN RETURN NULL; END IF;
  -- The authenticated login can only write through an owner that checks the
  -- supplied tuple before staging. It has no catalogue evidence grants.
  IF current_user='service_role' THEN
   supplied:=NEW.catalog_acceptance;
  ELSIF current_user<>'authenticated' THEN
   PERFORM public.catalog_acceptance_assert_v2(NEW.catalog_acceptance);
  END IF;
  current_event:=NEW.id;
 ELSE
  IF TG_OP<>'INSERT' THEN previous:=OLD.accepted_event_id; END IF;
  IF TG_OP<>'DELETE' THEN current_event:=NEW.accepted_event_id; END IF;
 END IF;
 FOREACH target IN ARRAY ARRAY[previous,CASE WHEN current_event IS DISTINCT FROM previous THEN current_event END] LOOP
  IF target IS NULL THEN CONTINUE; END IF;
  IF current_user='authenticated' THEN
   PERFORM public.customer_subscription_apply_bundle_as_actor(target,NULL,NULL,NULL);
  ELSIF current_user='service_role' THEN
   PERFORM public.subscription_package_edit_apply(NULL,NULL,NULL,target,supplied,NULL);
  ELSIF EXISTS(SELECT 1 FROM public.subscription_events WHERE id=target AND catalog_acceptance IS NOT NULL) THEN
   PERFORM public.catalog_edit_acceptance_final(target);
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_edit_acceptance_trigger() FROM PUBLIC;

CREATE FUNCTION public.catalog_acceptance_record_admit_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE basket jsonb;
BEGIN
 IF TG_TABLE_NAME='subscription_renewal_operations' THEN
  IF TG_OP='UPDATE' THEN
   IF (OLD.catalog_acceptance IS NOT NULL OR NEW.catalog_acceptance IS NOT NULL) AND
    (OLD.catalog_acceptance,OLD.catalog_acceptance_fingerprint,OLD.operation_fingerprint,OLD.cycle_snapshot,OLD.subscription_id)
     IS DISTINCT FROM (NEW.catalog_acceptance,NEW.catalog_acceptance_fingerprint,NEW.operation_fingerprint,NEW.cycle_snapshot,NEW.subscription_id)
   THEN RAISE EXCEPTION 'catalog_acceptance_snapshot_immutable' USING ERRCODE='55000'; END IF;
   IF (OLD.catalog_acceptance,OLD.catalog_acceptance_fingerprint) IS NOT DISTINCT FROM
    (NEW.catalog_acceptance,NEW.catalog_acceptance_fingerprint) THEN RETURN NEW; END IF;
  END IF;
  IF NEW.catalog_acceptance IS NOT NULL THEN
   IF NEW.catalog_acceptance_fingerprint IS DISTINCT FROM NEW.operation_fingerprint
    OR NEW.cycle_snapshot->>'frozenFingerprint' IS DISTINCT FROM NEW.operation_fingerprint
    OR (NEW.cycle_snapshot->>'frozenRevision' IN ('native.purchase-renewal.v1','native.purchase-renewal.v2')) IS DISTINCT FROM true
    OR NEW.cycle_snapshot->'subscriptionId' IS DISTINCT FROM to_jsonb(NEW.subscription_id)
    OR public.catalog_frozen_basket_codes_v2(NEW.cycle_snapshot) IS NULL THEN
    RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023'; END IF;
   basket:=public.catalog_retained_basket_v2(NEW.cycle_snapshot->'lines',true);
   IF NOT public.catalog_acceptance_roster_valid_v2(NEW.catalog_acceptance,basket) THEN
    RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
  ELSIF NEW.catalog_acceptance_fingerprint IS NOT NULL THEN
   RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023';
  END IF;
 END IF;
 IF NEW.catalog_acceptance IS NOT NULL THEN PERFORM public.catalog_acceptance_assert_v2(NEW.catalog_acceptance); END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_acceptance_record_admit_v2() FROM PUBLIC;

CREATE TRIGGER subscription_renewal_terms_catalog_acceptance_admit BEFORE INSERT OR UPDATE OF catalog_acceptance ON public.subscription_renewal_terms FOR EACH ROW EXECUTE FUNCTION public.catalog_acceptance_record_admit_v2();
CREATE TRIGGER subscription_renewal_operations_catalog_acceptance_admit BEFORE INSERT OR UPDATE OF catalog_acceptance,catalog_acceptance_fingerprint,operation_fingerprint,cycle_snapshot,subscription_id ON public.subscription_renewal_operations FOR EACH ROW EXECUTE FUNCTION public.catalog_acceptance_record_admit_v2();
CREATE FUNCTION public.catalog_order_receipt_acceptance_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE previous uuid; current_order uuid; target uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN previous:=OLD.order_id; END IF;
 IF TG_OP<>'DELETE' THEN current_order:=NEW.order_id; END IF;
 FOREACH target IN ARRAY ARRAY[previous,CASE WHEN current_order IS DISTINCT FROM previous THEN current_order END] LOOP
  IF target IS NULL THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=target AND catalog_acceptance IS NOT NULL) THEN
   PERFORM public.catalog_order_acceptance_final(target);
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_order_receipt_acceptance_trigger() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER commerce_order_draft_receipts_catalog_final AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_draft_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_order_receipt_acceptance_trigger();
CREATE CONSTRAINT TRIGGER subscription_events_catalog_final AFTER INSERT OR UPDATE ON public.subscription_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_edit_acceptance_trigger();
CREATE CONSTRAINT TRIGGER subscription_quote_previews_catalog_final AFTER INSERT OR UPDATE OR DELETE ON public.subscription_quote_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_edit_acceptance_trigger();
CREATE CONSTRAINT TRIGGER subscription_edit_quotes_catalog_final AFTER INSERT OR UPDATE OR DELETE ON public.subscription_edit_quotes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_edit_acceptance_trigger();

CREATE FUNCTION public.catalog_order_line_sum_acceptance(
  p_order_id uuid,
  p_old_order_id uuid DEFAULT NULL,
  p_old_header public.commerce_orders DEFAULT NULL,
  p_new_header public.commerce_orders DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acceptance jsonb;
BEGIN
  IF p_new_header IS DISTINCT FROM NULL THEN
    IF p_old_header.catalog_acceptance IS NOT NULL AND
      (p_old_header.catalog_acceptance, p_old_header.catalog_basket, p_old_header.catalog_receipt_key, p_old_header.renewal_operation_id, p_old_header.renewal_operation_fingerprint)
      IS DISTINCT FROM (p_new_header.catalog_acceptance, p_new_header.catalog_basket, p_new_header.catalog_receipt_key, p_new_header.renewal_operation_id, p_new_header.renewal_operation_fingerprint)
    THEN
      RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE = '55000';
    END IF;
    IF p_new_header.catalog_acceptance IS NOT NULL THEN
      PERFORM public.catalog_acceptance_assert_v2(p_new_header.catalog_acceptance);
    END IF;
    RETURN;
  END IF;

  IF p_old_order_id IS NOT NULL THEN
    IF p_old_order_id = p_order_id THEN RETURN; END IF;
    p_order_id := p_old_order_id;
  END IF;

  SELECT catalog_acceptance INTO v_acceptance
    FROM public.commerce_orders
   WHERE id = p_order_id;
  IF v_acceptance IS NOT NULL THEN
    PERFORM public.catalog_order_acceptance_final(p_order_id);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders) FROM PUBLIC;
-- Deferred invoker triggers need EXECUTE under the caller's role.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders) TO authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_order_line_sum_acceptance(uuid,uuid,public.commerce_orders,public.commerce_orders) TO service_role;'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.commerce_order_assert_line_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order_id uuid;
  v_declared bigint;
  v_sum bigint;
BEGIN
  -- Branching statements rather than one CASE expression on purpose: the procedural language
  -- compiles an expression into a single query, so every record field named in any arm must exist
  -- on every row type the trigger can see, and the two row types here differ.
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    v_order_id := NEW.id;
    PERFORM public.catalog_order_line_sum_acceptance(v_order_id, p_old_header => OLD, p_new_header => NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
    IF TG_OP = 'UPDATE' THEN
      PERFORM public.catalog_order_line_sum_acceptance(v_order_id, OLD.order_id);
    END IF;
  END IF;

  SELECT total_amount_minor INTO v_declared
    FROM public.commerce_orders
   WHERE id = v_order_id;
  -- The order is gone: a cascade took it, and there is nothing left to be consistent with.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(line_amount_minor), 0) INTO v_sum
    FROM public.commerce_order_items
   WHERE order_id = v_order_id;

  SELECT v_sum + COALESCE(sum(CASE
    WHEN kind = 'shipping_charge' THEN amount_minor
    WHEN kind = 'promotion_discount' AND scope = 'shipping' THEN -amount_minor
    ELSE 0 END), 0) INTO v_sum
    FROM public.commerce_order_adjustments
   WHERE order_id = v_order_id;

  IF v_sum IS DISTINCT FROM COALESCE(v_declared, 0) THEN
    RAISE EXCEPTION 'commerce_order_line_sum_mismatch' USING ERRCODE = '23514',
      DETAIL = format('order %s declares %s and its lines sum to %s',
                      v_order_id, COALESCE(v_declared::text, 'nothing'), v_sum);
  END IF;

  PERFORM public.catalog_order_line_sum_acceptance(v_order_id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_complete_renewal_attachment(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_activation public.subscription_activations; v_facts jsonb; v_acceptance jsonb; v_metadata jsonb; v_basket jsonb;
BEGIN
  SELECT catalog_acceptance,metadata INTO v_acceptance,v_metadata FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_row.subscription_id IS NULL OR v_activation.state IS DISTINCT FROM 'active' OR v_row.purchase_facts IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_attachment_not_ready' USING ERRCODE='22023'; END IF;
  IF v_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',true); END IF;
  v_facts:=v_row.purchase_facts;
  IF v_acceptance IS NOT NULL THEN
    IF v_activation.subscription_id IS DISTINCT FROM v_row.subscription_id THEN
      RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_order_acceptance_final(p_order_id);
    v_basket:=public.catalog_order_basket_v2(p_order_id,v_metadata,false);
    IF v_basket IS NULL OR v_basket IS DISTINCT FROM public.catalog_retained_basket_v2(v_facts->'lines',true) THEN
      RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
    PERFORM public.catalog_bind_template_v2(v_row.subscription_id,v_acceptance,v_basket);
  END IF;
  INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,
    unattended_charge_authorized_at,authorization_ref,payer_account_ref,catalog_acceptance)
    VALUES(v_row.subscription_id,v_facts->>'currency',v_facts->>'stockSourceKey',v_facts->>'settlementChannelKey',
      (v_facts->>'unattendedChargeAuthorizedAt')::timestamptz,v_facts->>'authorizationRef',v_facts->>'payerAccountRef',v_acceptance);
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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
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
  v_acceptance jsonb;
BEGIN
  -- A deferred trigger re-enters the existing customer authority by event ID.
  -- This tuple of NULL arguments was never a valid commerce command.
  IF pg_trigger_depth()>0 AND p_idempotency_key IS NULL AND p_accepted_quote_hash IS NULL AND p_core_lines IS NULL THEN
    PERFORM public.catalog_customer_edit_acceptance_assert(p_subscription_id);
    RETURN NULL;
  END IF;
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

  v_acceptance:=v_quote.catalog_acceptance;
  IF v_acceptance IS NOT NULL THEN PERFORM public.catalog_acceptance_assert_v2(v_acceptance); END IF;
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
  UPDATE public.subscription_edit_quotes SET
    status = 'accepted', accepted_event_id = v_event_id,
    accepted_at = statement_timestamp()
  WHERE id = v_quote.id;
  PERFORM public.catalog_attach_edit_acceptance(v_event_id,v_acceptance);

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

CREATE OR REPLACE FUNCTION public.subscription_command_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz,p_terms jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
<<apply_command>>
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text; quote_fingerprint text; answer jsonb;
 reason text; event_id uuid; event_key text; line jsonb; target timestamptz; outcome text:='applied'; term_key text;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 quote_fingerprint:=encode(sha256(convert_to(jsonb_set(command,'{payload}',p_payload-'acceptedQuoteHash')::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.command_fingerprint<>(CASE WHEN r.status='previewed' THEN quote_fingerprint ELSE fingerprint END)
   OR r.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  IF r.status<>'previewed' THEN
   IF r.status='refused' THEN RETURN r.result; END IF;
   RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status);
  END IF;
 END IF;
 event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
 BEGIN
  IF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel','order_now','reactivate') THEN
  IF p_terms IS NULL OR jsonb_typeof(p_terms) IS DISTINCT FROM 'object'
    OR p_terms - ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays'] <> '{}'::jsonb
    OR NOT (p_terms ?& ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays']) THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR term_key IN SELECT jsonb_object_keys(p_terms) LOOP
    IF jsonb_typeof(p_terms->term_key) IS DISTINCT FROM 'number'
      OR NOT coalesce(p_terms->>term_key ~ '^[1-9][0-9]*$',false)
      OR (p_terms->>term_key)::numeric > 2147483647 THEN
      RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_terms->>'slideMinDays')::integer > (p_terms->>'slideMaxDays')::integer THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  END IF;
  IF p_action='pause' THEN
   PERFORM public.subscription_pause_close_recovery(p_client_id,event_key,s.id,p_now);
  END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  -- Take the same subscription lock as claim first, then the future
  -- terms and every line. A previously deferred operation keeps its snapshot.
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  -- Existing preparation owns the operation before it inserts a cycle. Do
  -- not wait in the reverse lock order: refuse a busy operation, or a live
  -- pre-payment lease whose worker could still prepare after this command.
  IF p_action IN ('cancel','resume','skip_next_cycle','slide_next_cycle','order_now','reactivate')
   AND NOT (p_action='slide_next_cycle' AND floor(extract(epoch FROM (p_payload->>'newNextCycleAt')::timestamptz)/86400)
     =floor(extract(epoch FROM s.next_cycle_at)/86400)) THEN
   BEGIN
    PERFORM 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
   EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'subscription_command_operation_busy' USING ERRCODE='22023';
   END;
   IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
     AND (state='attempt_prepared' OR (state IN ('claimed','reserved') AND lease_expires_at>p_now))) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length','add_addon','remove_addon','update_addon_quantity') THEN
   IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   SELECT * INTO q FROM public.subscription_edit_quotes WHERE subscription_id=s.id AND idempotency_key=event_key FOR UPDATE;
   IF NOT FOUND OR q.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023';
   END IF;
   IF q.request_fingerprint<>quote_fingerprint OR s.template_version<>q.expected_template_version THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
   END IF;
   IF q.status<>'previewed' OR q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
   IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=q.currency_code) THEN
    RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023';
   END IF;
   IF (SELECT jsonb_agg(jsonb_build_object('lineOrdinal',(v->>'sortOrder')::integer+1,'sku',sku.sku,
      'quantity',(v->>'quantity')::integer,'unitAmountMinor',(v->>'unitPriceMinor')::bigint) ORDER BY (v->>'sortOrder')::integer)
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid)
     =(SELECT jsonb_agg(jsonb_build_object('lineOrdinal',line_ordinal,'sku',sku,'quantity',quantity,'unitAmountMinor',unit_amount_minor)
       ORDER BY line_ordinal) FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id)
    AND s.cadence_days=q.proposed_cadence_days AND q.proposed_lines=(SELECT COALESCE(jsonb_agg(jsonb_build_object(
     'variantId',variant_id,'quantity',quantity,'isAddon',is_addon,'sortOrder',sort_order,'unitPriceMinor',unit_price_minor,'currency',currency_code)
     ORDER BY sort_order,id),'[]') FROM public.subscription_lines WHERE subscription_id=s.id) THEN
    outcome:='noop';
   ELSE
    DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
    FOR line IN SELECT value FROM jsonb_array_elements(q.proposed_lines) LOOP
     INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES(s.id,(line->>'variantId')::uuid,(line->>'quantity')::integer,(line->>'sortOrder')::integer,
       (line->>'isAddon')::boolean,(line->>'unitPriceMinor')::bigint,q.currency_code);
    END LOOP;
    DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
    INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
     SELECT s.id,(v->>'sortOrder')::integer+1,sku.sku,(v->>'quantity')::integer,(v->>'unitPriceMinor')::bigint
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid;
    UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
    UPDATE public.subscriptions SET cadence_days=q.proposed_cadence_days,template_version=template_version+1,updated_at=p_now
     WHERE id=s.id RETURNING * INTO s;
   END IF;
  ELSIF p_action IN ('order_now','reactivate') THEN
   IF p_payload->'confirmedChargeTiming' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'subscription_command_charge_timing_not_confirmed' USING ERRCODE='22023';
   END IF;
   IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   IF (p_action='order_now' AND (s.status<>'active' OR s.next_cycle_at IS NULL))
    OR (p_action='reactivate' AND s.status<>'cancelled') THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF p_action='order_now' AND p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   target:=p_now+CASE p_action WHEN 'order_now' THEN make_interval(mins=>(p_terms->>'orderNowDelayMinutes')::integer)
    ELSE make_interval(days=>(p_terms->>'reactivateDelayDays')::integer) END;
   UPDATE public.subscriptions SET status='active',next_cycle_at=target,ended_at=NULL,cancellation_reason=NULL,
    template_version=template_version+CASE WHEN p_action='reactivate' THEN 1 ELSE 0 END,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  ELSIF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel') THEN
   IF p_action='cancel' THEN
    IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
      AND attempt_prepared_at IS NOT NULL AND state NOT IN ('succeeded','refused'))
     OR EXISTS(SELECT 1 FROM public.subscription_retry_obligations WHERE subscription_id=s.id AND state='prepared') THEN
     RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
    END IF;
    UPDATE public.subscription_dunning_notifications SET status='skipped',recovery_url_path=NULL,
     error='subscription_cancelled',updated_at=p_now WHERE status='queued' AND case_id IN
      (SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open');
    UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=p_now WHERE revoked_at IS NULL AND order_id IN
      (SELECT orders.id FROM public.commerce_orders orders JOIN public.subscription_dunning_cases cases
        ON cases.cycle_id=orders.subscription_cycle_id WHERE cases.subscription_id=s.id AND cases.status='open');
    UPDATE public.subscription_dunning_cases SET status='cancelled',next_retry_at=NULL,updated_at=p_now
     WHERE subscription_id=s.id AND status='open';
   END IF;
   IF p_action IN ('skip_next_cycle','slide_next_cycle') AND NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id)
    THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(
     SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') END) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   -- Do not move away from a current payment obligation on resume.
   IF p_action='resume' AND s.status='paused' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_resumed','skipped');
   END IF;
   IF p_action='resume' THEN PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at); END IF;
   IF p_action='cancel' THEN
    -- Operation locks above fence every worker; only elapsed, never-prepared
    -- obligations may be cancelled here. Paid/ambiguous commitments stay owned.
    UPDATE public.fulfillment_inventory_reservations stock_hold SET status='released',expires_at=NULL,
     terminal_reason='subscription_cancelled',updated_at=p_now
     FROM public.subscription_renewal_operations op WHERE op.subscription_id=s.id
      AND stock_hold.renewal_operation_id=op.id AND stock_hold.status='held'
      AND op.state IN ('claimed','reserved') AND op.attempt_prepared_at IS NULL
      AND op.external_attempt_ref IS NULL;
    UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',
     terminal_reason='subscription_cancelled',terminal_at=p_now,updated_at=p_now
     WHERE subscription_id=s.id AND state IN ('claimed','reserved') AND attempt_prepared_at IS NULL
      AND external_attempt_ref IS NULL;
   END IF;
   answer:=public.subscription_apply_lifecycle_action(p_client_id,event_key,s.id,p_action,p_payload,p_now,p_terms);
   IF p_action='cancel' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_cancelled','cancelled');
   END IF;
   outcome:=answer#>>'{subscriptionAction,status}';
   event_id:=(answer#>>'{subscriptionAction,eventId}')::uuid;
   SELECT * INTO s FROM public.subscriptions WHERE id=s.id;
  ELSE
   RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023';
  END IF;
  IF answer IS NULL AND outcome='applied' THEN
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
    VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'payload',p_payload,
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
    RETURNING id INTO event_id;
  END IF;
  IF q.id IS NOT NULL AND outcome='applied' THEN
   UPDATE public.subscription_edit_quotes SET status='accepted',accepted_event_id=event_id,accepted_at=p_now WHERE id=q.id;
   IF p_payload->'catalogAcceptance' IS NOT NULL THEN
    PERFORM public.catalog_attach_edit_acceptance(event_id,p_payload->'catalogAcceptance');
   END IF;
  END IF;
  answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
   'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  answer:=jsonb_build_object('status','refused','reason',reason);
 END;
 IF r.id IS NULL THEN
  INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
   VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload->>'acceptedQuoteHash',answer,answer->>'status');
 ELSE
  UPDATE public.subscription_command_receipts SET command_fingerprint=fingerprint,command=apply_command.command,result=answer,status=answer->>'status'
   WHERE id=r.id;
 END IF;
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_package_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 core jsonb; addons jsonb; stored jsonb; line_pricing jsonb; constraint_value jsonb;
 plan integer; version integer; minimum_text text; minimum_units integer; line jsonb; ordinal integer:=0;
 core_matches boolean; addon_matches boolean; outcome text:='applied';
BEGIN
 -- Deferred checks run after the owner returns to the restricted service login.
 -- This trigger-only invocation retains the existing edit authority and ACL.
 IF pg_trigger_depth()>0 AND p_actor_id IS NULL AND p_client_id IS NULL AND p_key IS NULL AND p_now IS NULL THEN
  IF p_payload IS NOT NULL THEN PERFORM public.catalog_acceptance_assert_v2(p_payload); END IF;
  PERFORM public.catalog_edit_acceptance_final(p_subscription_id);
  RETURN NULL;
 END IF;
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
  PERFORM public.catalog_attach_edit_acceptance(event_id,p_payload->'catalogAcceptance');
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
  plan:=s.cadence_days; constraint_value:=s.composition_constraint;
  IF p_action='swap_base_line' THEN
   IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,toVariantId}')::uuid) THEN
    RAISE EXCEPTION 'subscription_edit_conflict_duplicate_line' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET variant_id=(p_payload#>>'{request,toVariantId}')::uuid,updated_at=p_now
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
  PERFORM public.catalog_attach_edit_acceptance(event_id,p_payload->'catalogAcceptance');
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
DECLARE s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
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
  PERFORM public.catalog_attach_edit_acceptance(event_id,p_payload->'catalogAcceptance');
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,request->>'acceptedQuoteHash',answer,outcome);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_claim_due_renewal(
  p_identity_key text,
  p_operation_fingerprint text,
  p_cycle_snapshot jsonb,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_scheduled_at timestamptz;
  v_cycle_number integer;
  v_acceptance jsonb;
  v_subscription public.subscriptions%ROWTYPE;
  v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_identity_key IS NULL OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_cycle_snapshot IS NULL OR jsonb_typeof(p_cycle_snapshot) <> 'object'
    OR p_cycle_snapshot->>'contractVersion' <> 'platform.subscription.renewal.v1'
    OR btrim(COALESCE(p_worker_id, '')) = ''
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_subscription_id := (p_cycle_snapshot->>'subscriptionId')::uuid;
    v_scheduled_at := (p_cycle_snapshot->>'scheduledAt')::timestamptz;
    v_cycle_number := (p_cycle_snapshot->>'cycleNumber')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END;

  IF v_cycle_number < 1
    OR p_identity_key <> public.subscription_renewal_identity(v_subscription_id, v_scheduled_at)
    OR jsonb_typeof(p_cycle_snapshot->'lines') <> 'array'
    OR jsonb_array_length(p_cycle_snapshot->'lines') = 0
    OR p_cycle_snapshot->>'currency' !~ '^[A-Z]{3}$'
    OR (p_cycle_snapshot->>'totalAmountMinor')::bigint < 1
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation
    FROM public.subscription_renewal_operations
   WHERE subscription_id = v_subscription_id AND scheduled_at = v_scheduled_at
   FOR UPDATE;

  IF FOUND THEN
    IF v_operation.identity_key <> p_identity_key
      OR v_operation.operation_fingerprint <> p_operation_fingerprint
      OR v_operation.cycle_snapshot <> p_cycle_snapshot
    THEN
      RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_operation.state IN ('succeeded', 'refused') THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal');
    END IF;
  END IF;

  -- Historical terminal truth survives schedule advancement and cancellation.
  -- Nonterminal/new work still needs the original eligibility under both locks.
  IF v_subscription.status <> 'active'
    OR v_subscription.next_cycle_at IS DISTINCT FROM v_scheduled_at
    OR v_subscription.next_cycle_at > COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  IF v_operation.id IS NOT NULL THEN
    IF v_operation.lease_expires_at > COALESCE(p_now, now()) THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'lease_active');
    END IF;
    UPDATE public.subscription_renewal_operations
       SET claim_token = gen_random_uuid(),
           claim_generation = claim_generation + 1,
           claimed_by = p_worker_id,
           claimed_at = COALESCE(p_now, now()),
           lease_expires_at = COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_operation.id
     RETURNING * INTO v_operation;
    RETURN public.subscription_renewal_operation_response(v_operation, true, true, 'lease_taken_over');
  END IF;

  SELECT catalog_acceptance INTO v_acceptance FROM public.subscription_renewal_terms WHERE subscription_id=v_subscription_id;
  IF v_acceptance IS NOT NULL AND (
     p_cycle_snapshot#>'{templateSnapshot,version}' IS DISTINCT FROM to_jsonb(v_subscription.template_version)
     OR public.catalog_retained_basket_v2(p_cycle_snapshot->'lines',true) IS DISTINCT FROM (
       SELECT jsonb_object_agg(sku,quantity) FROM (
        SELECT sku,sum(quantity) AS quantity FROM public.subscription_renewal_term_lines
        WHERE subscription_id=v_subscription_id GROUP BY sku) lines)
     OR EXISTS(SELECT 1 FROM public.subscription_lines l
      WHERE l.subscription_id=v_subscription_id AND l.catalog_sku_revision_id IS DISTINCT FROM (
       SELECT (ref->>'skuRevisionId')::uuid FROM jsonb_array_elements(v_acceptance->'lines') ref WHERE ref->'skuId'=to_jsonb(l.variant_id)))
   ) THEN RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;

  INSERT INTO public.subscription_renewal_operations (
    subscription_id, scheduled_at, cycle_number, identity_key, operation_fingerprint,
    catalog_acceptance, catalog_acceptance_fingerprint, cycle_snapshot, claim_token, claimed_by, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_subscription_id, v_scheduled_at, v_cycle_number, p_identity_key,
    p_operation_fingerprint, v_acceptance,
    CASE WHEN v_acceptance IS NOT NULL THEN p_operation_fingerprint END,
    p_cycle_snapshot, gen_random_uuid(), p_worker_id,
    COALESCE(p_now, now()), COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
    COALESCE(p_now, now())
  ) RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(v_operation, true, false, 'claimed');
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_cycle_id uuid;
  v_order_id uuid;
  v_intent_id uuid;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_quantity integer;
  v_unit_amount bigint;
  v_total bigint;
  v_currency text;
  v_channel text;
BEGIN
  SELECT subscription_id INTO v_operation.subscription_id
    FROM public.subscription_renewal_operations WHERE id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM id FROM public.subscriptions
   WHERE id = v_operation.subscription_id FOR UPDATE;

  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'commerce_renewal_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT cycle.id, order_row.id, intent.id
    INTO v_cycle_id, v_order_id, v_intent_id
    FROM public.subscription_cycles cycle
    JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id
    JOIN public.commerce_settlement_intents intent ON intent.order_id = order_row.id
   WHERE cycle.renewal_operation_id = p_operation_id;
  IF FOUND THEN
    IF v_operation.state <> 'attempt_prepared' THEN
      RAISE EXCEPTION 'commerce_renewal_artifact_state_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'platform.subscription.renewal.v1', 'replayed', true,
      'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
      'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
      'state', v_operation.state);
  END IF;
  IF v_operation.state <> 'reserved' THEN
    RAISE EXCEPTION 'commerce_renewal_reservation_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_reservation.status <> 'held'
    OR v_reservation.expires_at <= COALESCE(p_now, now())
    OR v_reservation.operation_fingerprint <> v_operation.operation_fingerprint
  THEN
    RAISE EXCEPTION 'commerce_renewal_active_reservation_required' USING ERRCODE = '22023';
  END IF;

  v_currency := v_operation.cycle_snapshot->>'currency';
  v_channel := v_operation.cycle_snapshot->>'settlementChannelKey';
  v_total := (v_operation.cycle_snapshot->>'totalAmountMinor')::bigint;
  IF v_currency !~ '^[A-Z]{3}$' OR btrim(COALESCE(v_channel, '')) = '' OR v_total < 1 THEN
    RAISE EXCEPTION 'commerce_renewal_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_cycles (
    subscription_id, scheduled_at, status, renewal_operation_id,
    renewal_operation_fingerprint, updated_at
  ) VALUES (
    v_operation.subscription_id, v_operation.scheduled_at, 'payment_pending', p_operation_id,
    v_operation.operation_fingerprint, COALESCE(p_now, now())
  ) RETURNING id INTO v_cycle_id;

  INSERT INTO public.commerce_orders (
    client_id, subscription_cycle_id, status, currency_code, total_amount_minor,
    source_kind, metadata, renewal_operation_id, renewal_operation_fingerprint, catalog_acceptance, updated_at
  ) SELECT subscription.client_id, v_cycle_id, 'pending_payment', v_currency, v_total,
           'storefront', public.customer_renewal_delivery_selection(v_operation.subscription_id,jsonb_build_object(
             'source', 'subscription.renewal',
             'renewalIdentityKey', v_operation.identity_key,
             'renewalOperationFingerprint', v_operation.operation_fingerprint,
             'cycleSnapshot', v_operation.cycle_snapshot)),
           p_operation_id, v_operation.operation_fingerprint, v_operation.catalog_acceptance, COALESCE(p_now, now())
      FROM public.subscriptions subscription WHERE subscription.id = v_operation.subscription_id
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_amount := (v_line->>'unitAmountMinor')::bigint;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    IF NOT FOUND OR v_quantity < 1 OR v_unit_amount < 0 THEN
      RAISE EXCEPTION 'commerce_renewal_invalid_line' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_amount,
      v_quantity * v_unit_amount);
  END LOOP;

  PERFORM public.commerce_open_settlement_intent(
    v_operation.identity_key || ':settlement', v_order_id, v_channel, v_total, v_currency,
    jsonb_build_object(
      'renewalOperationId', p_operation_id,
      'renewalOperationFingerprint', v_operation.operation_fingerprint),
    COALESCE(p_now, now()));
  SELECT id INTO v_intent_id FROM public.commerce_settlement_intents WHERE order_id = v_order_id;
  UPDATE public.commerce_settlement_intents
     SET renewal_operation_id = p_operation_id,
         renewal_operation_fingerprint = v_operation.operation_fingerprint,
         updated_at = COALESCE(p_now, now())
   WHERE id = v_intent_id;
  UPDATE public.fulfillment_inventory_reservations
     SET status = 'committed', expires_at = NULL, updated_at = COALESCE(p_now, now())
   WHERE id = v_reservation.id;
  UPDATE public.subscription_renewal_operations
     SET state = 'attempt_prepared', attempt_prepared_at = COALESCE(p_now, now()),
         updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'contractVersion', 'platform.subscription.renewal.v1', 'replayed', false,
    'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
    'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
    'state', v_operation.state);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_renewal_operation_response(
  p_operation public.subscription_renewal_operations,
  p_acquired boolean,
  p_replayed boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'platform.subscription.renewal.v1',
    'acquired', p_acquired,
    'replayed', p_replayed,
    'reason', p_reason,
    'operationId', p_operation.id,
    'identityKey', p_operation.identity_key,
    'operationFingerprint', p_operation.operation_fingerprint,
    'subscriptionId', p_operation.subscription_id,
    'scheduledAt', p_operation.scheduled_at,
    'cycleNumber', p_operation.cycle_number,
    'state', p_operation.state,
    'claimToken', p_operation.claim_token,
    'claimGeneration', p_operation.claim_generation,
    'leaseExpiresAt', p_operation.lease_expires_at,
    'cycleSnapshot', p_operation.cycle_snapshot,
    'externalAttemptRef', p_operation.external_attempt_ref,
    'externalAttemptAcknowledgedAt', p_operation.external_attempt_acknowledged_at,
    'terminalOutcome', p_operation.terminal_outcome,
    'terminalReason', p_operation.terminal_reason,
    'terminalAt', p_operation.terminal_at,
    'reservationId', (
      SELECT reservation.id FROM public.fulfillment_inventory_reservations reservation
       WHERE reservation.renewal_operation_id = p_operation.id),
    'cycleId', (
      SELECT cycle.id FROM public.subscription_cycles cycle
       WHERE cycle.renewal_operation_id = p_operation.id),
    'orderId', (
      SELECT order_row.id FROM public.commerce_orders order_row
       WHERE order_row.renewal_operation_id = p_operation.id),
    'settlementIntentId', (
      SELECT intent.id FROM public.commerce_settlement_intents intent
       WHERE intent.renewal_operation_id = p_operation.id))
  || CASE WHEN p_operation.catalog_acceptance IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('catalogAcceptance',p_operation.catalog_acceptance) END;
$$;
