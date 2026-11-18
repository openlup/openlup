-- Native preview actor equality; the existing signature, selection and lock order are retained.
CREATE OR REPLACE FUNCTION public.subscription_quote_preview_take(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,p_key text,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180 THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('update_package_template','update_bundle','update_plan_length','add_addon','remove_addon',
  'update_addon_quantity','swap_base_line','update_base_mix','update_portion','resize_bundle') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF p_version IS NULL OR p_version<1 OR s.template_version<>p_version THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE subscription_id=s.id AND client_id=p_client_id
  AND action=p_action AND quote_hash=p_hash AND template_version=p_version ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF q.actor_id IS DISTINCT FROM p_actor_id THEN
  RAISE EXCEPTION 'subscription_edit_quote_actor_mismatch' USING ERRCODE='22023'; END IF;
 IF q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
 IF q.accepted_at IS NOT NULL AND q.accepted_idempotency_key<>p_key THEN
  RAISE EXCEPTION 'subscription_edit_quote_already_used' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(q);
END;
$$;

CREATE FUNCTION public.customer_self_service_prune_subscription_quote_previews(
 p_retention pg_catalog.interval DEFAULT interval '7 days',p_limit integer DEFAULT 1000,p_pruned_at timestamptz DEFAULT now()
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_deleted integer:=0;
BEGIN
 IF p_retention IS NULL OR p_retention<interval '0 seconds' THEN
  RAISE EXCEPTION 'customer_self_service_invalid_quote_preview_retention'; END IF;
 IF p_limit IS NULL OR p_limit<=0 OR p_limit>10000 THEN
  RAISE EXCEPTION 'customer_self_service_invalid_quote_preview_prune_limit'; END IF;
 WITH doomed AS (SELECT id FROM public.subscription_quote_previews
  WHERE status='previewed' AND expires_at<p_pruned_at-p_retention ORDER BY expires_at,id LIMIT p_limit),
 deleted AS (DELETE FROM public.subscription_quote_previews q USING doomed
  WHERE q.id=doomed.id AND q.status='previewed' AND q.expires_at<p_pruned_at-p_retention RETURNING 1)
 SELECT count(*)::integer INTO v_deleted FROM deleted;
 RETURN COALESCE(v_deleted,0);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_quote_preview_record(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,
 p_expires_at timestamptz,p_request jsonb,p_snapshot jsonb,p_totals jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
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
 PERFORM public.customer_self_service_prune_subscription_quote_previews(interval '7 days',500,p_now);
 INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,
  expires_at,request_payload,quote_snapshot,totals,created_at,updated_at)
 VALUES(s.id,p_client_id,p_actor_id,p_action,p_hash,p_version,p_expires_at,p_request,p_snapshot,p_totals,p_now,p_now)
 ON CONFLICT (subscription_id,client_id,action,quote_hash,template_version) WHERE status='previewed' DO UPDATE SET
  actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,request_payload=EXCLUDED.request_payload,
  quote_snapshot=EXCLUDED.quote_snapshot,totals=EXCLUDED.totals,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at
 RETURNING * INTO q;
 RETURN to_jsonb(q);
END;
$$;

-- Read authoritative cycle identities under the subscription lock. A linked
-- renewal contributes its recorded logical cycle. The active activation links
-- the paid checkout cycle through its order.
CREATE FUNCTION public.subscription_sized_consent_phase(p_client_id uuid,p_subscription_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; intro jsonb; phase_config jsonb;
 unreadable bigint; upcoming bigint; phase text:='none';
BEGIN
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 WITH activation AS (
  SELECT (array_agg(o.subscription_cycle_id))[1] AS cycle_id
  FROM public.subscription_activations a LEFT JOIN public.commerce_orders o ON o.id=a.order_id AND o.client_id=s.client_id
  WHERE a.subscription_id=s.id AND a.state='active'
  HAVING count(*)=1
 ), identities AS (
  SELECT c.status,CASE
   WHEN c.renewal_operation_id IS NOT NULL THEN
    CASE WHEN op.cycle_snapshot#>>'{cycle,status}'='correlated'
     AND jsonb_typeof(op.cycle_snapshot#>'{cycle,logicalCycleNumber}')='number'
     THEN op.cycle_snapshot#>>'{cycle,logicalCycleNumber}' END
   WHEN c.status='paid' AND c.id=(SELECT cycle_id FROM activation) THEN '1' END AS logical_number
  FROM public.subscription_cycles c LEFT JOIN public.subscription_renewal_operations op
   ON op.id=c.renewal_operation_id AND op.subscription_id=c.subscription_id
  WHERE c.subscription_id=s.id
 ), numbers AS (
  SELECT status,CASE WHEN logical_number ~ '^[1-9][0-9]{0,15}$'
   THEN CASE WHEN logical_number::bigint<=9007199254740991 THEN logical_number::bigint END END AS number
  FROM identities
 )
 SELECT count(*) FILTER(WHERE number IS NULL),
  coalesce(min(number) FILTER(WHERE status IN ('planned','payment_pending')),coalesce(max(number),0)+1)
 INTO unreadable,upcoming FROM numbers;
 IF unreadable<>0 OR upcoming>9007199254740991 THEN
  RAISE EXCEPTION 'subscription_edit_cycle_history_unreadable' USING ERRCODE='22023'; END IF;
 intro:=public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}';
 IF intro IS NOT NULL THEN
  SELECT value_text::jsonb INTO phase_config FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
  IF phase_config IS NULL OR COALESCE(phase_config->>'fixedThroughCycle','') !~ '^[1-9][0-9]{0,8}$'
   OR COALESCE(phase_config->>'graduationCycle','') !~ '^[1-9][0-9]{0,8}$' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
  IF upcoming<=(phase_config->>'fixedThroughCycle')::integer THEN phase:='fixed';
  ELSIF upcoming=(phase_config->>'graduationCycle')::integer AND s.template_version=(intro->>'basisTemplateVersion')::integer THEN
   phase:='graduation_pending';
  END IF;
 END IF;
 RETURN jsonb_build_object('upcomingCycle',upcoming,'phase',phase);
END;
$$;

-- The same admission fence uses the consented phase for wrapped edits and the
-- installed paid-count basis for direct callers.
CREATE FUNCTION public.catalog_edit_admission_assert_current(
 p_heads jsonb,p_sku_revisions jsonb,p_mode text,p_offer_evidence jsonb,p_price_context_versions jsonb,p_purpose text,
 p_numbered_phase text
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
   IF p_numbered_phase IS NULL AND sized_context->'marker' IS NOT NULL AND sized_context->'marker'<>'null'::jsonb THEN
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
   IF p_numbered_phase='graduation_pending' OR (p_numbered_phase IS NULL
    AND sized_context->'marker' IS NOT NULL AND sized_context->'marker'<>'null'::jsonb
    AND (sized_context->>'paidCycleCount')::integer+1=(phase_config->>'graduationCycle')::integer
    AND subscription.template_version=(sized_context#>>'{marker,basisTemplateVersion}')::integer) THEN
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

CREATE OR REPLACE FUNCTION public.catalog_admission_assert_current(
 p_heads jsonb,p_sku_revisions jsonb,p_mode text,p_offer_evidence jsonb,p_price_context_versions jsonb,p_purpose text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.catalog_edit_admission_assert_current(p_heads,p_sku_revisions,p_mode,p_offer_evidence,p_price_context_versions,p_purpose,NULL);
END;
$$;

-- Preserve the direct bundle transaction and bind consented commands to the
-- submitted request, even when the delegate action has been normalized.
CREATE FUNCTION public.subscription_bundle_edit_apply_internal(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz,
 p_binding text,p_submitted jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_catalog_evidence jsonb; v_catalog_acceptance jsonb;
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 action text; request jsonb; command jsonb; fingerprint text; answer jsonb; q jsonb; lines jsonb; line jsonb;
 event_id uuid; event_key text; line_pricing jsonb:='[]'::jsonb; version integer; plan integer; ordinal integer:=0;
 constraint_value jsonb; opt_in boolean; intro jsonb; phase_config jsonb; paid integer; numbered_phase text;
 current_core jsonb; desired_core jsonb; outcome text:='applied'; rewrites_addons boolean;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'request') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 request:=p_payload->'request'; action:=request->>'action';
 IF action IS NULL OR action NOT IN ('resize_bundle','update_bundle','update_base_mix','update_plan_length','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_submitted IS NOT NULL AND (jsonb_typeof(p_submitted) IS DISTINCT FROM 'object'
  OR p_submitted->>'acceptedQuoteHash' IS DISTINCT FROM request->>'acceptedQuoteHash'
  OR coalesce(p_submitted->>'action','') NOT IN ('resize_bundle','update_bundle','update_base_mix','update_plan_length','update_portion')) THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',COALESCE(p_submitted->>'action',action),'payload',COALESCE(p_submitted,request));
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
 IF p_binding='classic' THEN
  IF s.configured_offer_version<>'classic' OR action NOT IN ('resize_bundle','update_bundle') OR COALESCE(opt_in,false) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 ELSE
  IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND COALESCE(opt_in,false)) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
  intro:=public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}';
 END IF;
 IF p_binding='sized' AND p_submitted IS NOT NULL THEN
  numbered_phase:=public.subscription_sized_consent_phase(p_client_id,s.id)->>'phase';
  IF numbered_phase='fixed' OR (COALESCE(opt_in,false) AND numbered_phase='graduation_pending') THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
 ELSIF intro IS NOT NULL THEN
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
 IF COALESCE(CASE WHEN p_submitted IS NOT NULL THEN p_payload->>'expectedTemplateVersion' ELSE request->>'expectedTemplateVersion' END,'') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(CASE WHEN p_submitted IS NOT NULL THEN p_payload->>'expectedTemplateVersion' ELSE request->>'expectedTemplateVersion' END)::integer;
 IF p_submitted->>'expectedTemplateVersion' IS NOT NULL AND p_submitted->'expectedTemplateVersion' IS DISTINCT FROM to_jsonb(version) THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
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
 IF p_submitted IS NOT NULL THEN
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,action,request->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(p_submitted-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],q#>'{quote_snapshot,consentRequest}');
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  IF p_submitted IS NULL THEN
   q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,action,request->>'acceptedQuoteHash',version,p_key,p_now);
  END IF;
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
    PERFORM public.catalog_edit_admission_assert_current(v_catalog_evidence->'heads',v_catalog_evidence->'skuRevisions','subscription',
      (v_catalog_evidence->'offerEvidence')||jsonb_build_object('subscriptionId',s.id,'offerVersion',s.configured_offer_version,'lane',p_binding,'optIn',coalesce(opt_in,false)),
      v_catalog_evidence->'priceContextVersions','account',numbered_phase);
    SELECT jsonb_build_object('schemaVersion',2,'lines',jsonb_agg(l->'reference' ORDER BY l#>>'{reference,skuId}'))
      INTO v_catalog_acceptance FROM jsonb_array_elements(v_catalog_evidence->'skuRevisions') l;
  END IF;
  -- Preserve the existing sellability check on increases.
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

-- Keep the shipped entry point and paid-count behavior for direct callers.
CREATE OR REPLACE FUNCTION public.subscription_sized_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RETURN public.subscription_bundle_edit_apply_internal(p_actor_id,p_client_id,p_key,p_subscription_id,p_payload,p_now,'sized',NULL);
END;
$$;

CREATE FUNCTION public.subscription_consented_bundle_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz,p_binding text,p_submitted jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_binding IS NULL OR p_binding NOT IN ('classic','sized') OR p_submitted IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 RETURN public.subscription_bundle_edit_apply_internal(p_actor_id,p_client_id,p_key,p_subscription_id,p_payload,p_now,p_binding,p_submitted);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz),
 public.catalog_edit_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text,text),
 public.subscription_sized_consent_phase(uuid,uuid),
 public.subscription_bundle_edit_apply_internal(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb),
 public.subscription_consented_bundle_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz), public.subscription_bundle_edit_apply_internal(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb), public.subscription_sized_consent_phase(uuid,uuid), public.catalog_edit_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text,text), public.subscription_consented_bundle_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz), public.subscription_bundle_edit_apply_internal(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb), public.subscription_sized_consent_phase(uuid,uuid), public.catalog_edit_admission_assert_current(jsonb,jsonb,text,jsonb,jsonb,text,text), public.subscription_consented_bundle_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz), public.subscription_sized_consent_phase(uuid,uuid), public.subscription_consented_bundle_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz,text,jsonb) TO service_role'; END IF; END; $$;
