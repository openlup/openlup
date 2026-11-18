-- Unbound native lifecycle and accepted identity. No capability or archive barrier is enabled.
ALTER TABLE public.subscription_lines ADD COLUMN catalog_sku_revision_id uuid;
ALTER TABLE public.subscription_lines ADD CONSTRAINT subscription_lines_catalog_sku_revision_fkey FOREIGN KEY (variant_id, catalog_sku_revision_id) REFERENCES public.catalog_sku_revisions (sku_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.subscription_lines VALIDATE CONSTRAINT subscription_lines_catalog_sku_revision_fkey;
CREATE TABLE public.catalog_lifecycle_write_capabilities (
 transaction_id xid8 NOT NULL,
 product_id uuid PRIMARY KEY REFERENCES public.catalog_products(id),
 fingerprint text NOT NULL CHECK (length(fingerprint)=64 AND translate(fingerprint,'abcdef0123456789','')='')
);
ALTER TABLE public.catalog_lifecycle_write_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_lifecycle_write_capabilities FROM PUBLIC;
CREATE FUNCTION public.catalog_lifecycle_write_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE product uuid;
BEGIN
 IF coalesce(OLD.publication_facts->>'schemaVersion','') <> '3' AND coalesce(NEW.publication_facts->>'schemaVersion','') <> '3' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='catalog_products' THEN product:=NEW.id; ELSE product:=NEW.product_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.catalog_lifecycle_write_capabilities WHERE transaction_id=pg_current_xact_id() AND product_id=product) THEN
  RAISE EXCEPTION 'catalog_lifecycle_raw_status_fenced' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_products_lifecycle_write_fence BEFORE UPDATE OF status,publication_facts ON public.catalog_products FOR EACH ROW EXECUTE FUNCTION public.catalog_lifecycle_write_fence();
CREATE TRIGGER catalog_skus_lifecycle_write_fence BEFORE UPDATE OF status,sellable_standalone,sellable_in_subscription,publication_facts ON public.catalog_skus FOR EACH ROW EXECUTE FUNCTION public.catalog_lifecycle_write_fence();
REVOKE ALL ON FUNCTION public.catalog_lifecycle_write_fence() FROM PUBLIC;

-- Legacy lifecycle entrypoints remain unconditional refusals before state access.
CREATE FUNCTION public.admin_archive_catalog_sku(p_actor_id uuid, p_sku text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_archive_catalog_sku(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_activate_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_activate_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_archive_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_archive_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_restore_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_restore_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION public.admin_deactivate_catalog_product(p_actor_id uuid, p_slug text, p_mode text DEFAULT 'commit', p_idempotency_key text DEFAULT NULL, p_request_id text DEFAULT NULL, p_source text DEFAULT 'agent_catalog') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 RAISE EXCEPTION 'legacy_catalog_mutation_fenced' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_deactivate_catalog_product(uuid,text,text,text,text,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_quantity_valid_v3(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT coalesce(jsonb_typeof(p_value)='object'
  AND p_value - ARRAY['dimension','unit','unscaled','scale']='{}'::jsonb
  AND p_value->>'dimension' IN ('mass','volume','count')
  AND jsonb_typeof(p_value->'unit')='string' AND length(p_value->>'unit')<=120
  AND p_value->>'unit' ~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
  AND jsonb_typeof(p_value->'unscaled')='string' AND p_value->>'unscaled' ~ '^[1-9][0-9]{0,39}$'
  AND jsonb_typeof(p_value->'scale')='number' AND p_value->>'scale' ~ '^([0-9]|1[0-2])$',false);
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_quantity_valid_v3(jsonb) FROM PUBLIC;

-- Standalone stored-fact checks are shared by admission and retained readers.
CREATE FUNCTION public.catalog_lifecycle_facts_valid_v3(p_facts jsonb, p_kind text, p_id uuid, p_product_id uuid) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE state text; membership jsonb; previous text; source jsonb; entry jsonb;
 uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 IF jsonb_typeof(p_facts) IS DISTINCT FROM 'object' OR p_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR p_facts->'id' IS DISTINCT FROM to_jsonb(p_id) THEN RETURN false; END IF;
 state := p_facts->>'lifecycleState';
 IF state IS NULL OR state NOT IN ('active','draft','withdrawn','archived')
  OR p_facts->>'status' IS DISTINCT FROM (CASE WHEN state='withdrawn' THEN 'active' ELSE state END)
  OR jsonb_typeof(p_facts->'attributes') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_facts->'source') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 source := p_facts->'source';
 IF source - ARRAY['draftId','revision','commandKey','fingerprint'] <> '{}'::jsonb
  OR jsonb_typeof(source->'draftId') IS DISTINCT FROM 'string' OR source->>'draftId' !~ uuid_shape
  OR jsonb_typeof(source->'revision') IS DISTINCT FROM 'number' OR source->>'revision' !~ '^[1-9][0-9]{0,9}$'
  OR jsonb_typeof(source->'commandKey') IS DISTINCT FROM 'string' OR length(source->>'commandKey') NOT BETWEEN 1 AND 240
  OR source->>'commandKey'<>btrim(source->>'commandKey')
  OR jsonb_typeof(source->'fingerprint') IS DISTINCT FROM 'string' OR source->>'fingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 IF (source->>'revision')::bigint>2147483647 THEN RETURN false; END IF;
 IF p_kind='product' THEN
  IF jsonb_typeof(p_facts->'axes') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_facts->'axes')>16 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_facts->'axes') a
   WHERE jsonb_typeof(a)<>'string' OR a#>>'{}' !~ '^[a-z][a-z0-9_-]{0,63}$')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_facts->'axes') a GROUP BY a HAVING count(*)>1) THEN RETURN false; END IF;
  RETURN coalesce(p_facts ?& ARRAY['slug','name','type','axes','primarySkuId','document','presentation','content','definitionDigest']
   AND p_facts - ARRAY['schemaVersion','lifecycleState','id','slug','name','status','type','axes','attributes','primarySkuId','document','presentation','source','content','definitionDigest']='{}'::jsonb
   AND jsonb_typeof(p_facts->'slug')='string' AND p_facts->>'slug' ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
   AND jsonb_typeof(p_facts->'name')='string' AND length(p_facts->>'name') BETWEEN 1 AND 500
   AND jsonb_typeof(p_facts->'type')='object' AND (p_facts->'type') - ARRAY['key','version']='{}'::jsonb
   AND jsonb_typeof(p_facts#>'{type,key}')='string' AND length(p_facts#>>'{type,key}')<=120
   AND p_facts#>>'{type,key}' ~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
   AND jsonb_typeof(p_facts#>'{type,version}')='number' AND p_facts#>>'{type,version}' ~ '^[1-9][0-9]{0,9}$'
   AND jsonb_typeof(p_facts->'primarySkuId')='string' AND p_facts->>'primarySkuId' ~ uuid_shape
   AND jsonb_typeof(p_facts->'document')='object' AND p_facts#>'{document,productId}'=to_jsonb(p_id)
   AND jsonb_typeof(p_facts->'content')='object'
   AND jsonb_typeof(p_facts->'presentation') IN ('null','object')
   AND jsonb_typeof(p_facts->'definitionDigest')='string' AND p_facts->>'definitionDigest' ~ '^[a-f0-9]{64}$', false);
 END IF;
 IF p_facts->'productId' IS DISTINCT FROM to_jsonb(p_product_id)
  OR NOT (p_facts ?& ARRAY['code','title','minQuantity','isAddon','sellableStandalone','sellableInSubscription','netContent','grossMass','options','facts','identifiers','assetRefs','logisticsRef','memberships','optionDigest'])
  OR p_facts - ARRAY['schemaVersion','lifecycleState','id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription','netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source','optionDigest','demandPolicyRef'] <> '{}'::jsonb
  OR jsonb_typeof(p_facts->'code') IS DISTINCT FROM 'string' OR p_facts->>'code' !~ '^[A-Za-z0-9._:-]{1,160}$'
  OR jsonb_typeof(p_facts->'title') IS DISTINCT FROM 'string' OR length(p_facts->>'title') NOT BETWEEN 1 AND 500
  OR jsonb_typeof(p_facts->'minQuantity') IS DISTINCT FROM 'number' OR p_facts->>'minQuantity' !~ '^[1-9][0-9]{0,9}$'
  OR jsonb_typeof(p_facts->'isAddon') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_facts->'sellableStandalone') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_facts->'sellableInSubscription') IS DISTINCT FROM 'boolean'
  OR (state<>'active' AND (p_facts->'sellableStandalone'='true'::jsonb OR p_facts->'sellableInSubscription'='true'::jsonb))
  OR jsonb_typeof(p_facts->'optionDigest') IS DISTINCT FROM 'string' OR p_facts->>'optionDigest' !~ '^[a-f0-9]{64}$'
  OR NOT public.catalog_lifecycle_quantity_valid_v3(p_facts->'netContent')
  OR (p_facts->'grossMass'<>'null'::jsonb AND NOT public.catalog_lifecycle_quantity_valid_v3(p_facts->'grossMass'))
  OR jsonb_typeof(p_facts->'options') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_facts->'facts') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_facts->'identifiers') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p_facts->'assetRefs') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p_facts->'logisticsRef') NOT IN ('null','string')
  OR jsonb_typeof(p_facts->'memberships') IS DISTINCT FROM 'array'
  OR (p_facts ? 'demandPolicyRef' AND (jsonb_typeof(p_facts->'demandPolicyRef') IS DISTINCT FROM 'string'
   OR length(p_facts->>'demandPolicyRef') NOT BETWEEN 1 AND 240 OR p_facts->>'demandPolicyRef'<>btrim(p_facts->>'demandPolicyRef'))) THEN RETURN false; END IF;
 IF (p_facts->>'minQuantity')::bigint>2147483647 OR jsonb_array_length(p_facts->'assetRefs')>32 THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_facts->'assetRefs') LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'string' OR length(entry#>>'{}') NOT BETWEEN 1 AND 240
   OR entry#>>'{}'<>btrim(entry#>>'{}') THEN RETURN false; END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_facts->'identifiers') LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
   OR NOT (entry ?& ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef'])
   OR entry - ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef'] <> '{}'::jsonb
   OR jsonb_typeof(entry->'scheme') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'issuer') IS DISTINCT FROM 'string'
   OR jsonb_typeof(entry->'value') IS DISTINCT FROM 'string' OR length(entry->>'value') NOT BETWEEN 1 AND 128
   OR coalesce(entry->>'packagingLevel','') NOT IN ('unit','case')
   OR jsonb_typeof(entry->'quantity') IS DISTINCT FROM 'number' OR entry->>'quantity' !~ '^[1-9][0-9]{0,5}$'
   OR jsonb_typeof(entry->'isPrimary') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(entry->'label') NOT IN ('null','string') OR jsonb_typeof(entry->'sourceRef') NOT IN ('null','string') THEN RETURN false; END IF;
  IF ((entry->>'packagingLevel'='unit') IS DISTINCT FROM (entry->'quantity'='1'::jsonb))
   OR (entry->'isPrimary'='true'::jsonb AND (entry->>'scheme'<>'gs1:gtin' OR entry->>'packagingLevel'<>'unit')) THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(p_facts->'identifiers') identifier WHERE identifier->'isPrimary'='true'::jsonb)>1 THEN RETURN false; END IF;
 FOR membership IN SELECT value FROM jsonb_array_elements(p_facts->'memberships') LOOP
  IF jsonb_typeof(membership) IS DISTINCT FROM 'object' OR membership - ARRAY['offerVersion','admitted'] <> '{}'::jsonb
   OR jsonb_typeof(membership->'offerVersion') IS DISTINCT FROM 'string' OR length(membership->>'offerVersion') NOT BETWEEN 1 AND 240
   OR membership->>'offerVersion'<>btrim(membership->>'offerVersion')
   OR jsonb_typeof(membership->'admitted') IS DISTINCT FROM 'boolean' OR previous COLLATE "C">=membership->>'offerVersion' COLLATE "C" THEN RETURN false; END IF;
  previous := membership->>'offerVersion';
 END LOOP;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_facts_valid_v3(jsonb,text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_roster_valid_v3(p_product_id uuid,p_manifest jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE entries jsonb; entry jsonb; prev text; primary_seen boolean := false;
BEGIN
 IF p_manifest->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR p_manifest - ARRAY['schemaVersion','product','skus'] <> '{}'::jsonb
  OR NOT public.catalog_lifecycle_facts_valid_v3(p_manifest->'product','product',p_product_id,p_product_id)
  OR jsonb_typeof(p_manifest->'skus') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 entries := p_manifest->'skus';
 FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR entry - ARRAY['skuId','revisionId','revision','digest'] <> '{}'::jsonb
   OR jsonb_typeof(entry->'skuId') IS DISTINCT FROM 'string' OR entry->>'skuId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(entry->'revisionId') IS DISTINCT FROM 'string' OR entry->>'revisionId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(entry->'revision') IS DISTINCT FROM 'number' OR entry->>'revision' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(entry->'digest') IS DISTINCT FROM 'string' OR entry->>'digest' !~ '^[a-f0-9]{64}$'
   OR prev COLLATE "C">=entry->>'skuId' COLLATE "C" THEN RETURN false; END IF;
  IF (entry->>'revision')::bigint>2147483647 THEN RETURN false; END IF;
  primary_seen := primary_seen OR coalesce(p_manifest#>'{product,primarySkuId}'=entry->'skuId',false);
  prev := entry->>'skuId';
 END LOOP;
 RETURN primary_seen;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_roster_valid_v3(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_roster_resolved_v3(p_product_id uuid,p_manifest jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT count(*)=jsonb_array_length(p_manifest->'skus')
  AND count(DISTINCT r.full_facts::jsonb->>'code')=count(*)
  AND coalesce(bool_and(public.catalog_lifecycle_facts_valid_v3(r.full_facts::jsonb,'sku',r.sku_id,r.product_id)
   AND encode(sha256(convert_to(r.full_facts,'UTF8')),'hex')=r.digest),false)
 FROM jsonb_array_elements(p_manifest->'skus') entry
 JOIN public.catalog_sku_revisions r ON r.id=(entry->>'revisionId')::uuid AND r.sku_id::text=entry->>'skuId'
  AND to_jsonb(r.revision)=entry->'revision' AND r.digest=entry->>'digest' AND r.product_id=p_product_id;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_roster_resolved_v3(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_head_admit_v3() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE manifest jsonb;
BEGIN
 SELECT canonical_state::jsonb INTO manifest FROM public.catalog_publications WHERE id=NEW.publication_id AND product_id=NEW.product_id AND revision=NEW.revision;
 IF manifest->'schemaVersion'='3'::jsonb AND NOT public.catalog_lifecycle_roster_resolved_v3(NEW.product_id,manifest) THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_head_admit_v3() FROM PUBLIC;
CREATE TRIGGER catalog_publication_heads_lifecycle_admit BEFORE INSERT OR UPDATE ON public.catalog_publication_heads
 FOR EACH ROW EXECUTE FUNCTION public.catalog_lifecycle_head_admit_v3();

-- Resolve retained lines once. Supported historic flat baskets remain readable;
-- a native versioned carrier must also agree with its nested line copies.
CREATE FUNCTION public.catalog_retained_basket_codes_v2(p_basket jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE item jsonb; code text; qty jsonb; codes text[] := ARRAY[]::text[];
BEGIN
 IF jsonb_typeof(p_basket) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF jsonb_array_length(p_basket) NOT BETWEEN 1 AND 100 THEN RETURN NULL; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_basket) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object'
   OR (item ? 'sku' AND item ? 'skuCode' AND item->'sku' IS DISTINCT FROM item->'skuCode')
   OR (item ? 'quantity' AND item ? 'qty' AND item->'quantity' IS DISTINCT FROM item->'qty')
   OR jsonb_typeof(coalesce(item->'sku',item->'skuCode')) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  code:=coalesce(item->>'sku',item->>'skuCode'); qty:=coalesce(item->'quantity',item->'qty');
  IF code !~ '^[A-Za-z0-9._:-]{1,160}$' OR code=ANY(codes) OR jsonb_typeof(qty) IS DISTINCT FROM 'number' OR qty::text !~ '^[1-9][0-9]{0,9}$' THEN RETURN NULL; END IF;
  IF qty::text::bigint>2147483647 THEN RETURN NULL; END IF;
  codes := array_append(codes,code);
 END LOOP;
 RETURN codes;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_retained_basket_codes_v2(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_frozen_basket_codes_v2(p_snapshot jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE codes text[]; item jsonb;
BEGIN
 IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF p_snapshot ? 'frozenRevision' AND (
  p_snapshot->>'frozenRevision' IS NULL OR p_snapshot->>'frozenRevision' NOT IN ('native.purchase-renewal.v1','native.purchase-renewal.v2','native.purchase-renewal.v3')
  OR p_snapshot#>'{orderSnapshot,lines}' IS DISTINCT FROM p_snapshot->'lines'
  OR p_snapshot#>'{templateSnapshot,lines}' IS DISTINCT FROM p_snapshot->'lines') THEN RETURN NULL; END IF;
 codes:=public.catalog_retained_basket_codes_v2(p_snapshot->'lines');
 IF codes IS NULL THEN RETURN NULL; END IF;
 IF p_snapshot->>'frozenRevision'='native.purchase-renewal.v3' THEN
  FOR item IN SELECT value FROM jsonb_array_elements(p_snapshot->'lines') LOOP
   IF item - ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'] <> '{}'::jsonb
    OR jsonb_typeof(item->'sku') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number'
    OR jsonb_typeof(item->'lineOrdinal') IS DISTINCT FROM 'number' OR item->>'lineOrdinal' !~ '^[1-9][0-9]*$'
    OR jsonb_typeof(item->'unitAmountMinor') IS DISTINCT FROM 'number' OR item->>'unitAmountMinor' !~ '^(0|[1-9][0-9]*)$' THEN RETURN NULL; END IF;
  END LOOP;
 END IF;
 RETURN codes;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_frozen_basket_codes_v2(jsonb) FROM PUBLIC;

-- A nullable legacy revision never erases a known identity. This is one unpaginated
-- query for archive and impact. It takes no commerce row or advisory locks.
CREATE FUNCTION public.catalog_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; obligations jsonb := '[]'; item record;
 marker jsonb; basis integer; codes text[]; manifest jsonb; unknown boolean := false;
BEGIN
 -- A filtered or non-owner read cannot prove absence.
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[
  'public.catalog_skus'::regclass,'public.catalog_publications'::regclass,'public.catalog_publication_heads'::regclass,'public.catalog_sku_revisions'::regclass,
  'public.subscriptions'::regclass,'public.subscription_lines'::regclass,'public.subscription_renewal_terms'::regclass,'public.subscription_renewal_term_lines'::regclass,
  'public.subscription_activations'::regclass,'public.subscription_renewal_attachments'::regclass,'public.subscription_renewal_operations'::regclass,
  'public.subscription_renewal_outcomes'::regclass,'public.subscription_cycles'::regclass,'public.commerce_orders'::regclass,'public.commerce_order_items'::regclass,
  'public.commerce_settlement_intents'::regclass,'public.commerce_order_holds'::regclass,'public.fulfillment_inventory_reservations'::regclass,
  'public.fulfillment_shipments'::regclass,'public.fulfillment_parcel_reservation_sets'::regclass,'public.fulfillment_parcel_lines'::regclass,
  'public.subscription_stock_wait_cases'::regclass,'public.subscription_events'::regclass,'public.subscription_edit_quotes'::regclass,
  'public.subscription_quote_previews'::regclass]) AND (row_security_active(c.oid) OR NOT pg_has_role(current_user,c.relowner,'USAGE'))) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unavailable','reason','catalog_obligation_evidence_unavailable');
 END IF;
 SELECT * INTO sku FROM public.catalog_skus WHERE id=p_sku_id;
 IF NOT FOUND OR NOT public.catalog_lifecycle_facts_valid_v3(sku.publication_facts,'sku',sku.id,sku.product_id)
  OR sku.publication_facts->>'code' IS DISTINCT FROM sku.sku OR sku.publication_facts->>'status' IS DISTINCT FROM sku.status
  OR sku.publication_facts->'sellableStandalone' IS DISTINCT FROM to_jsonb(sku.sellable_standalone)
  OR sku.publication_facts->'sellableInSubscription' IS DISTINCT FROM to_jsonb(sku.sellable_in_subscription) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
 END IF;
 SELECT p.canonical_state::jsonb INTO manifest FROM public.catalog_publications p
  JOIN public.catalog_publication_heads h ON h.publication_id=p.id AND h.product_id=p.product_id AND h.revision=p.revision
  WHERE p.product_id=sku.product_id AND encode(sha256(convert_to(p.canonical_state,'UTF8')),'hex')=p.digest;
 IF NOT public.catalog_lifecycle_roster_valid_v3(sku.product_id,manifest)
  OR NOT public.catalog_lifecycle_roster_resolved_v3(sku.product_id,manifest)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'skus') e JOIN public.catalog_sku_revisions r
    ON r.id=(e->>'revisionId')::uuid WHERE r.sku_id=sku.id AND r.full_facts::jsonb=sku.publication_facts) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
 END IF;
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
 FOR item IN SELECT o.id,a.subscription_id FROM public.commerce_orders o
  LEFT JOIN public.subscription_activations a ON a.order_id=o.id
  LEFT JOIN public.subscription_renewal_attachments t ON t.order_id=o.id
  WHERE (a.state<>'compensated' AND (a.state<>'active' OR t.completed_at IS NULL
    OR t.subscription_id IS DISTINCT FROM a.subscription_id
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms r WHERE r.subscription_id=a.subscription_id)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=a.subscription_id)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=a.subscription_id)))
   OR (a.order_id IS NULL AND o.renewal_operation_id IS NULL AND o.status='pending_payment'
    AND (o.catalog_acceptance IS NOT NULL OR o.metadata#>'{quoteSnapshot,quote,lines}' IS NOT NULL))
 LOOP
  IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=item.id)
   OR EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=item.id AND i.sku_id IS NULL) THEN unknown:=true; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=item.id AND i.sku_id=sku.id) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','pending_activation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 FOR item IN SELECT op.id,op.subscription_id,op.cycle_snapshot FROM public.subscription_renewal_operations op
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
  AND (NOT EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=o.id)
   OR EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=o.id AND i.sku_id IS NULL))) THEN unknown:=true; END IF;
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
   WHERE l.shipment_id=p.id) AS attributed,
  EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines l WHERE l.shipment_id=p.id AND l.sku_id=sku.id) AS matches
  FROM public.fulfillment_shipments p JOIN public.fulfillment_shipments predecessor ON predecessor.id=p.replaces_shipment_id
  JOIN public.commerce_orders o ON o.id=p.order_id LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
  WHERE p.delivered_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments next WHERE next.replaces_shipment_id=p.id)
 LOOP
  IF item.attributed IS DISTINCT FROM true THEN unknown:=true;
  ELSIF item.matches THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','replacement','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 FOR item IN SELECT w.id,w.subscription_id,w.cycle_snapshot,
  op.subscription_id=w.subscription_id AND op.scheduled_at=w.scheduled_at AND op.cycle_number=w.cycle_number
    AND op.cycle_snapshot=w.cycle_snapshot AND op.operation_fingerprint=w.fingerprint AND op.identity_key=w.identity_key AS bound
  FROM public.subscription_stock_wait_cases w LEFT JOIN public.subscription_renewal_operations op ON op.id=w.renewal_operation_id
  WHERE w.state IN ('waiting','stock_secured') OR (w.state='resumed' AND NOT EXISTS(
   SELECT 1 FROM public.commerce_orders o JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   JOIN public.fulfillment_shipments p ON p.id=w.fulfillment_id AND p.order_id=o.id AND p.replaces_shipment_id IS NULL
   WHERE o.id=w.order_id AND c.id=w.cycle_id AND c.subscription_id=w.subscription_id AND c.renewal_operation_id=w.renewal_operation_id
    AND o.renewal_operation_id=w.renewal_operation_id AND o.status IN ('paid','fulfillment_pending','fulfilled') AND c.status='paid'
    AND p.status NOT IN ('cancelled','exception')
    AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id AND i.status='settled')
    AND EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations r WHERE r.renewal_operation_id=w.renewal_operation_id AND r.status='consumed')
    AND NOT EXISTS(SELECT 1 FROM public.commerce_order_holds h WHERE h.order_id=o.id AND h.status='active')))
 LOOP
  codes:=public.catalog_frozen_basket_codes_v2(item.cycle_snapshot);
  IF item.bound IS DISTINCT FROM true OR codes IS NULL THEN unknown:=true;
  ELSIF sku.sku=ANY(codes) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','stock_wait','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 FOR item IN SELECT a.order_id AS id,a.subscription_id,a.purchase_facts,s.template_version FROM public.subscription_renewal_attachments a
  JOIN public.subscriptions s ON s.id=a.subscription_id WHERE s.status IN ('active','paused') AND a.purchase_facts#>'{renewalTerms,starterPack}' IS NOT NULL
 LOOP
  marker:=item.purchase_facts#>'{renewalTerms,starterPack}';
  codes:=public.catalog_retained_basket_codes_v2(marker#>'{graduation,lines}');
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR marker->'schemaVersion' IS DISTINCT FROM '"1"'::jsonb
   OR jsonb_typeof(marker->'basisTemplateVersion') IS DISTINCT FROM 'number' OR marker->>'basisTemplateVersion' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(marker->'starterIntervalDays') IS DISTINCT FROM 'number'
   OR jsonb_typeof(marker->'delivery2') IS DISTINCT FROM 'object' OR jsonb_typeof(marker#>'{graduation,cadenceDays}') IS DISTINCT FROM 'number'
   OR codes IS NULL OR EXISTS(SELECT FROM unnest(codes) code WHERE NOT EXISTS(SELECT FROM public.catalog_skus k WHERE k.sku=code)) THEN unknown:=true; CONTINUE; END IF;
  IF (marker->>'basisTemplateVersion')::bigint>2147483647 THEN unknown:=true; CONTINUE; END IF;
  basis:=(marker->>'basisTemplateVersion')::integer;
  IF basis<>item.template_version THEN
   IF basis<item.template_version AND EXISTS(SELECT 1 FROM public.subscription_events e
    WHERE e.subscription_id=item.subscription_id AND e.payload->'templateVersion'=to_jsonb(basis::bigint+1)
    AND ((e.event_type='subscription.starter_graduated' AND e.payload->'mode'='"full"'::jsonb
     AND e.payload->'basisTemplateVersion'=to_jsonb(basis) AND e.payload->'cadenceDays'=marker#>'{graduation,cadenceDays}'
     AND right(e.idempotency_key,length('starter-graduation:'||item.subscription_id::text||':'||basis::text))=
       'starter-graduation:'||item.subscription_id::text||':'||basis::text
     AND public.catalog_retained_basket_codes_v2(e.payload->'lines') @> codes)
    OR (e.event_type='subscription.customer_self_service.update_bundle' AND EXISTS(
     SELECT 1 FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=e.id AND q.subscription_id=item.subscription_id
      AND q.status='accepted' AND q.expected_template_version=basis AND q.accepted_at=e.occurred_at
      AND e.payload->>'quoteHash'=q.quote_hash AND e.payload->>'action'='update_bundle'))
    OR (e.event_type IN ('subscription.customer_self_service.resize_bundle','subscription.customer_self_service.update_bundle',
      'subscription.customer_self_service.update_package_template','subscription.customer_self_service.update_base_mix',
      'subscription.customer_self_service.update_plan_length','subscription.customer_self_service.update_portion',
      'subscription.customer_self_service.swap_base_line','subscription.customer_self_service.add_addon',
      'subscription.customer_self_service.remove_addon','subscription.customer_self_service.update_addon_quantity')
     AND EXISTS(SELECT 1 FROM public.subscription_quote_previews q WHERE q.accepted_event_id=e.id AND q.subscription_id=item.subscription_id
      AND q.status='accepted' AND q.template_version=basis AND e.payload->>'quotePreviewId'=q.id::text
      AND e.idempotency_key='command:'||encode(sha256(convert_to(q.actor_id::text||':'||q.accepted_idempotency_key,'UTF8')),'hex'))))) THEN CONTINUE; END IF;
   unknown:=true; CONTINUE;
  END IF;
  IF sku.sku=ANY(codes) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','graduation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 IF unknown THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 RETURN jsonb_build_object('schemaVersion',2,'outcome','complete','obligations',obligations);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_bound_obligations_v2(uuid) FROM PUBLIC;

-- The persisted v4 dialect checks its new operation leaves and evidence before
-- recording a revision. Exact old receipts replay before this boundary.
CREATE FUNCTION public.catalog_lifecycle_draft_valid_v4(p_inputs jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE op jsonb; child jsonb; evidence jsonb; asset jsonb; previous text; verb text;
 uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 code_shape constant text := '^[A-Za-z0-9._:-]{1,160}$';
BEGIN
 FOR op IN SELECT value FROM jsonb_array_elements(p_inputs->'operations') LOOP
  verb := op->>'op';
  IF (op ? 'productSlug' AND (jsonb_typeof(op->'productSlug') IS DISTINCT FROM 'string'
    OR op->>'productSlug' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'))
   OR (op ? 'skuCode' AND (jsonb_typeof(op->'skuCode') IS DISTINCT FROM 'string' OR op->>'skuCode' !~ code_shape)) THEN RETURN false; END IF;
  IF verb='set_eligibility' AND (jsonb_typeof(op->'sellableStandalone') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(op->'sellableInSubscription') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;
  IF verb IN ('set_product_lifecycle','set_sku_lifecycle') AND
   (coalesce(op->>'expectedState','') NOT IN ('draft','active','withdrawn','archived')
    OR coalesce(op->>'state','') NOT IN ('active','withdrawn','archived')) THEN RETURN false; END IF;
  IF verb IN ('restore_product','restore_sku') AND op->'expectedState' IS DISTINCT FROM '"withdrawn"'::jsonb THEN RETURN false; END IF;
  IF verb='set_product_lifecycle' THEN
   IF jsonb_typeof(op->'children') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
   IF jsonb_array_length(op->'children')>50000 THEN RETURN false; END IF;
   previous := NULL;
   FOR child IN SELECT value FROM jsonb_array_elements(op->'children') LOOP
    IF jsonb_typeof(child) IS DISTINCT FROM 'object' OR child - ARRAY['skuCode','expectedState'] <> '{}'::jsonb
     OR jsonb_typeof(child->'skuCode') IS DISTINCT FROM 'string' OR child->>'skuCode' !~ code_shape
     OR coalesce(child->>'expectedState','') NOT IN ('draft','active','withdrawn','archived')
     OR previous COLLATE "C">=child->>'skuCode' COLLATE "C" THEN RETURN false; END IF;
    previous := child->>'skuCode';
   END LOOP;
  END IF;
  IF (verb='restore_sku' OR verb='set_sku_lifecycle' AND op->>'state'='active')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_inputs->'operations') e
      WHERE e->>'op'='set_eligibility' AND e->'skuCode'=op->'skuCode'
       AND (e->'sellableStandalone'='true'::jsonb OR e->'sellableInSubscription'='true'::jsonb)) THEN RETURN false; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_inputs#>'{evidence,drafts}') e GROUP BY e->>'draftId' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_inputs#>'{evidence,media}') e GROUP BY e->>'skuCode' HAVING count(*)>1) THEN RETURN false; END IF;
 FOR evidence IN SELECT value FROM jsonb_array_elements(p_inputs#>'{evidence,drafts}') LOOP
  IF jsonb_typeof(evidence->'draftId') IS DISTINCT FROM 'string' OR evidence->>'draftId' !~ uuid_shape
   OR jsonb_typeof(evidence->'revision') IS DISTINCT FROM 'number' OR evidence->>'revision' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(evidence->'commandKey') IS DISTINCT FROM 'string' OR length(evidence->>'commandKey') NOT BETWEEN 1 AND 240
   OR evidence->>'commandKey' <> btrim(evidence->>'commandKey')
   OR jsonb_typeof(evidence->'fingerprint') IS DISTINCT FROM 'string' OR evidence->>'fingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  IF (evidence->>'revision')::bigint>2147483647 THEN RETURN false; END IF;
 END LOOP;
 FOR evidence IN SELECT value FROM jsonb_array_elements(p_inputs#>'{evidence,media}') LOOP
  IF jsonb_typeof(evidence->'skuCode') IS DISTINCT FROM 'string' OR evidence->>'skuCode' !~ code_shape
   OR jsonb_typeof(evidence->'mediaRef') IS DISTINCT FROM 'string' OR length(evidence->>'mediaRef') NOT BETWEEN 1 AND 240
   OR evidence->>'mediaRef'<>btrim(evidence->>'mediaRef')
   OR jsonb_typeof(evidence->'revisionDigest') IS DISTINCT FROM 'string' OR evidence->>'revisionDigest' !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(evidence->'assetRefs') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(evidence->'assetRefs')>32 THEN RETURN false; END IF;
  previous := NULL;
  FOR asset IN SELECT value FROM jsonb_array_elements(evidence->'assetRefs') LOOP
   IF jsonb_typeof(asset) IS DISTINCT FROM 'string' OR length(asset#>>'{}') NOT BETWEEN 1 AND 240
    OR asset#>>'{}'<>btrim(asset#>>'{}') OR previous COLLATE "C">=asset#>>'{}' COLLATE "C" THEN RETURN false; END IF;
   previous := asset#>>'{}';
  END LOOP;
 END LOOP;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_draft_valid_v4(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; operation jsonb; expectation jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text; inputs jsonb; content jsonb; claim jsonb; allowed text[];
BEGIN
  actor := p_actor_id; IF actor IS NULL OR actor <> btrim(actor) OR length(actor) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'catalog_draft_actor_required' USING ERRCODE='42501'; END IF;
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 1048576
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_fingerprint_invalid');
  END IF;
  c := p_canonical_command::jsonb;
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'schemaVersion' NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb) OR NOT (c ? 'schemaVersion')
    OR c->>'action' IS NULL OR (c->>'action' NOT IN ('create','revise','abandon') AND NOT (c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb) AND c->>'action' = 'resume'))
    OR jsonb_typeof(c->'draftId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'commandKey') IS DISTINCT FROM 'string' OR length(c->>'commandKey') NOT BETWEEN 1 AND 240
    OR btrim(c->>'commandKey') <> c->>'commandKey'
    OR jsonb_typeof(c->'expectedRevision') IS DISTINCT FROM 'number'
    OR c->>'expectedRevision' !~ '^(0|[1-9][0-9]*)$'
    OR EXISTS (SELECT FROM jsonb_object_keys(c) k WHERE k NOT IN ('schemaVersion','action','draftId','commandKey','expectedRevision','payload')) THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
  END IF;
  d := (c->>'draftId')::uuid; key := c->>'commandKey'; action := c->>'action'; expected := (c->>'expectedRevision')::integer;
  IF expected > 2147483646 THEN RETURN jsonb_build_object('outcome','validation_issue','reason','revision_limit'); END IF;
  IF d::text <> c->>'draftId' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-draft:' || d::text, 0));
  SELECT * INTO receipt FROM public.catalog_draft_command_receipts WHERE draft_id = d AND command_key = key;
  IF FOUND THEN
    IF receipt.fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('outcome','conflict','reason','command_key_reused');
    END IF;
    IF public.catalog_draft_record(d,receipt.revision)->>'actorId' <> actor THEN RETURN jsonb_build_object('outcome','unauthorized','reason','operator_mismatch'); END IF;
    RETURN jsonb_build_object('outcome','replayed','record',public.catalog_draft_record(d, receipt.revision));
  END IF;
  SELECT * INTO h FROM public.catalog_draft_heads WHERE draft_id = d FOR UPDATE;
  IF (action = 'create' AND (FOUND OR expected <> 0)) OR (action <> 'create' AND (NOT FOUND OR expected <> h.revision)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','revision_conflict','currentRevision',coalesce(h.revision,0));
  END IF;
  IF h.status = 'abandoned' AND action <> 'resume' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_abandoned','currentRevision',h.revision); END IF;
  IF action = 'resume' AND h.status <> 'abandoned' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_not_abandoned','currentRevision',h.revision); END IF;
  next_revision := coalesce(h.revision,0) + 1;
  state := CASE WHEN action = 'abandon' THEN 'abandoned' ELSE 'open' END;
  IF action IN ('abandon','resume') THEN
    IF c ? 'payload' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','abandon_payload_invalid'); END IF;
    SELECT payload INTO p FROM public.catalog_draft_revisions WHERE draft_id = d AND revision = h.revision;
    product := h.product_id;
  ELSE
    p := c->'payload';
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'schemaVersion' IS DISTINCT FROM c->'schemaVersion'
      OR jsonb_typeof(p->'product') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'skus') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p->'product'->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p->'product'->'type') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p->'product'->'type'->'key') IS DISTINCT FROM 'string'
      OR p->'product'->'type'->>'key' !~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
      OR jsonb_typeof(p->'product'->'type'->'version') IS DISTINCT FROM 'number'
      OR p->'product'->'type'->>'version' !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(p->'product'->'dimensions') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p->'product'->'dimensions') > 16 OR jsonb_array_length(p->'skus') > 10000 THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
    END IF;
    IF c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb) THEN
      IF EXISTS (SELECT FROM jsonb_object_keys(p) k WHERE k NOT IN ('schemaVersion','product','skus') AND NOT (c->'schemaVersion' IN ('3'::jsonb, '4'::jsonb) AND k = 'publication'))
        OR EXISTS (SELECT FROM jsonb_object_keys(p->'product') k WHERE k NOT IN ('id','type','slug','primarySkuId','dimensions','sharedContent','documentRevision','attributes'))
        OR (p->'product' ? 'attributes' AND jsonb_typeof(p->'product'->'attributes') IS DISTINCT FROM 'object') THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
      END IF;
    END IF;
    IF c->'schemaVersion' IN ('3'::jsonb, '4'::jsonb) THEN
      inputs := p->'publication'; content := p->'product'->'sharedContent';
      IF jsonb_typeof(inputs) IS DISTINCT FROM 'object' OR jsonb_typeof(content) IS DISTINCT FROM 'object' THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      IF inputs->>'kind' IS NULL OR inputs->>'kind' NOT IN ('release','compensation')
        OR jsonb_typeof(inputs->'operations') IS DISTINCT FROM 'array' OR jsonb_typeof(inputs->'evidence') IS DISTINCT FROM 'object'
        OR EXISTS (SELECT FROM jsonb_object_keys(inputs) k WHERE k NOT IN ('kind','operations','evidence'))
        OR content->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR content->>'catalogAction' IS NULL
        OR content->>'catalogAction' NOT IN ('create','revise') OR jsonb_typeof(content->'presentation') IS DISTINCT FROM 'object'
        OR jsonb_typeof(content->'offerMemberships') IS DISTINCT FROM 'array'
        OR jsonb_typeof(content->'requestedModes') IS DISTINCT FROM 'array'
        OR jsonb_typeof(content->'publicationSkus') IS DISTINCT FROM 'array'
        OR (content ? 'document' AND jsonb_typeof(content->'document') IS DISTINCT FROM 'object')
        OR EXISTS (SELECT FROM jsonb_object_keys(content) k WHERE k NOT IN ('schemaVersion','catalogAction','document','presentation','offerMemberships','requestedModes','publicationSkus')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      FOR code_value IN SELECT unnest(ARRAY['offerMemberships','requestedModes','publicationSkus']) LOOP
        IF jsonb_array_length(content->code_value) > 10000 THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        FOR claim IN SELECT value FROM jsonb_array_elements(content->code_value) LOOP
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE code_value WHEN 'offerMemberships' THEN ARRAY['skuCode','offerVersion','admitted']
            WHEN 'requestedModes' THEN ARRAY['skuCode','modes'] ELSE ARRAY['skuCode','title','minQuantity','isAddon','facts'] END;
          IF NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END LOOP;
      END LOOP;
      IF EXISTS (SELECT FROM jsonb_object_keys(inputs->'evidence') k WHERE k NOT IN ('drafts','media')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
      FOR code_value IN SELECT unnest(ARRAY['drafts','media']) LOOP
        IF NOT (inputs->'evidence' ? code_value) THEN CONTINUE; END IF;
        IF jsonb_typeof(inputs->'evidence'->code_value) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        IF jsonb_array_length(inputs->'evidence'->code_value) < 1 OR (code_value = 'drafts' AND jsonb_array_length(inputs->'evidence'->code_value) > 100) THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
        FOR claim IN SELECT value FROM jsonb_array_elements(inputs->'evidence'->code_value) LOOP
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE code_value WHEN 'drafts' THEN ARRAY['draftId','revision','commandKey','fingerprint'] ELSE ARRAY['skuCode','mediaRef','assetRefs','revisionDigest'] END;
          IF NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END LOOP;
      END LOOP;
      FOR operation IN SELECT value FROM jsonb_array_elements(inputs->'operations') LOOP
        IF jsonb_typeof(operation) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
        allowed := CASE operation->>'op'
          WHEN 'create_product' THEN ARRAY['op','productId','productSlug','name']
          WHEN 'register_document_revision' THEN ARRAY['op','productSlug','revisionId','revisionNo','documentRef','sourceRef','canonicalText','digest','provenance']
          WHEN 'create_sku' THEN ARRAY['op','skuId','skuCode','productSlug','documentRevisionNo','title','minQuantity','isAddon','facts']
          WHEN 'create_identifier' THEN ARRAY['op','skuCode','scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef']
          WHEN 'set_eligibility' THEN ARRAY['op','skuCode','sellableStandalone','sellableInSubscription']
          WHEN 'set_sku_status' THEN ARRAY['op','skuCode','status']
          WHEN 'move_document_pointer' THEN ARRAY['op','productSlug','documentRevisionNo']
          WHEN 'set_primary_sku' THEN ARRAY['op','productSlug','skuCode']
          WHEN 'set_product_status' THEN ARRAY['op','productSlug','status']
          WHEN 'set_offer_membership' THEN ARRAY['op','skuCode','offerVersion','admitted']
          WHEN 'set_product_presentation' THEN ARRAY['op','productSlug','presentation']
          WHEN 'set_sku_metadata' THEN ARRAY['op','skuCode','logisticsRef']
          WHEN 'set_product_lifecycle' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','productSlug','expectedState','state','children'] ELSE NULL END
          WHEN 'set_sku_lifecycle' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','skuCode','expectedState','state'] ELSE NULL END
          WHEN 'restore_product' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','productSlug','expectedState'] ELSE NULL END
          WHEN 'restore_sku' THEN CASE WHEN c->'schemaVersion'='4'::jsonb THEN ARRAY['op','skuCode','expectedState'] ELSE NULL END
          WHEN 'set_derived_sku_facts' THEN ARRAY['op','skuCode','documentRevisionNo','netContent','facts'] ELSE NULL END;
        IF allowed IS NULL OR NOT (operation ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(operation) k WHERE NOT (k = ANY(allowed))) THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
        IF c->'schemaVersion'='4'::jsonb AND operation->>'op' IN ('set_product_status','set_sku_status') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','catalog_lifecycle_raw_status_fenced'); END IF;
        IF operation->>'op' = 'register_document_revision' THEN
          claim := operation->'provenance';
          IF jsonb_typeof(claim) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid'); END IF;
          allowed := CASE claim->>'source' WHEN 'current_draft' THEN ARRAY['source']
            WHEN 'retained_draft' THEN ARRAY['source','draftId','draftRevision','draftCommandKey','draftFingerprint'] ELSE NULL END;
          IF allowed IS NULL OR NOT (claim ?& allowed) OR EXISTS (SELECT FROM jsonb_object_keys(claim) k WHERE NOT (k = ANY(allowed))) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
          END IF;
        END IF;
      END LOOP;
      IF c->'schemaVersion'='4'::jsonb AND NOT public.catalog_lifecycle_draft_valid_v4(inputs) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
      END IF;
    END IF;
    product := (p->'product'->>'id')::uuid;
    IF product::text <> p->'product'->>'id' OR (h.product_id IS NOT NULL AND h.product_id <> product)
      OR (p->'product' ? 'documentRevision' AND p->'product'->'documentRevision'->>'productId' IS DISTINCT FROM product::text)
      OR (p->'product' ? 'primarySkuId' AND NOT EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x WHERE x->>'id' = p->'product'->>'primarySkuId')) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','product_reference_invalid');
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x GROUP BY x->>'id' HAVING count(*) > 1)
      OR EXISTS (SELECT FROM jsonb_array_elements(p->'skus') x WHERE x ? 'code' GROUP BY x->>'code' HAVING count(*) > 1) THEN
      RETURN jsonb_build_object('outcome','validation_issue','reason','sku_identity_duplicate');
    END IF;
    FOR s IN SELECT value FROM jsonb_array_elements(p->'skus') LOOP
      IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'id') IS DISTINCT FROM 'string'
        OR s->>'productId' IS DISTINCT FROM product::text OR s ? 'sharedContent'
        OR jsonb_typeof(s->'options') IS DISTINCT FROM 'object'
        OR (s ? 'code' AND (jsonb_typeof(s->'code') IS DISTINCT FROM 'string' OR length(s->>'code') NOT BETWEEN 1 AND 160 OR btrim(s->>'code') <> s->>'code' OR s->>'code' !~ '^[A-Za-z0-9._:-]+$')) THEN
        RETURN jsonb_build_object('outcome','validation_issue','reason','sku_reference_invalid');
      END IF;
      IF c->'schemaVersion' IN ('2'::jsonb, '3'::jsonb, '4'::jsonb) THEN
        IF EXISTS (SELECT FROM jsonb_object_keys(s) k WHERE k NOT IN ('id','productId','code','options','netContent','identifiers','assetRefs','grossMass','logisticsRef','attributes','priceOperations') AND NOT (c->'schemaVersion'='4'::jsonb AND k='demandPolicyRef'))
          OR (s ? 'demandPolicyRef' AND (jsonb_typeof(s->'demandPolicyRef') IS DISTINCT FROM 'string'
            OR length(s->>'demandPolicyRef') NOT BETWEEN 1 AND 240 OR s->>'demandPolicyRef' <> btrim(s->>'demandPolicyRef')))
          OR (s ? 'attributes' AND jsonb_typeof(s->'attributes') IS DISTINCT FROM 'object')
          OR (s ? 'priceOperations' AND jsonb_typeof(s->'priceOperations') IS DISTINCT FROM 'array') THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','payload_invalid');
        END IF;
        FOR operation IN SELECT value FROM jsonb_array_elements(coalesce(s->'priceOperations','[]'::jsonb)) LOOP
          IF jsonb_typeof(operation) IS DISTINCT FROM 'object' OR jsonb_typeof(operation->'expected') IS DISTINCT FROM 'object' THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
          expectation := operation->'expected';
          IF EXISTS (SELECT FROM jsonb_object_keys(operation) k WHERE k NOT IN ('schemaVersion','commandKey','variantId','priceListId','mode','minQty','amountKind','unitPriceMinor','expected'))
            OR EXISTS (SELECT FROM jsonb_object_keys(expectation) k WHERE k NOT IN ('entryId','unitPriceMinor'))
            OR operation->'schemaVersion' IS DISTINCT FROM '1'::jsonb
            OR jsonb_typeof(operation->'commandKey') IS DISTINCT FROM 'string'
            OR length(operation->>'commandKey') NOT BETWEEN 1 AND 240 OR btrim(operation->>'commandKey') <> operation->>'commandKey'
            OR operation->>'variantId' IS DISTINCT FROM s->>'id'
            OR jsonb_typeof(operation->'priceListId') IS DISTINCT FROM 'string'
            OR operation->>'priceListId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR operation->'mode' IS DISTINCT FROM '"one_time"'::jsonb OR operation->'minQty' IS DISTINCT FROM '1'::jsonb
            OR operation->'amountKind' IS DISTINCT FROM '"gross"'::jsonb
            OR jsonb_typeof(operation->'unitPriceMinor') IS DISTINCT FROM 'number'
            OR operation->>'unitPriceMinor' !~ '^[1-9][0-9]{0,9}$'
            OR NOT (expectation ? 'entryId' AND expectation ? 'unitPriceMinor')
            OR NOT ((jsonb_typeof(expectation->'entryId') = 'null' AND jsonb_typeof(expectation->'unitPriceMinor') = 'null')
              OR (jsonb_typeof(expectation->'entryId') = 'string'
                AND expectation->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND jsonb_typeof(expectation->'unitPriceMinor') = 'number' AND expectation->>'unitPriceMinor' ~ '^(0|[1-9][0-9]{0,9})$')) THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
          IF (operation->>'unitPriceMinor')::bigint > 2147483647 OR (expectation->>'unitPriceMinor')::bigint > 2147483647 THEN
            RETURN jsonb_build_object('outcome','validation_issue','reason','price_operation_invalid');
          END IF;
        END LOOP;
      END IF;
      sku := (s->>'id')::uuid;
      IF sku::text <> s->>'id' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','sku_reference_invalid'); END IF;
      SELECT * INTO reserved FROM public.catalog_draft_sku_reservations WHERE sku_id = sku;
      IF FOUND AND (reserved.draft_id <> d OR reserved.product_id <> product OR (reserved.code IS NOT NULL AND reserved.code IS DISTINCT FROM s->>'code')) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','sku_identity_reserved');
      END IF;
    END LOOP;
  END IF;
  -- The exception block rolls back every write if any cross-draft reservation loses a race.
  BEGIN
    IF action = 'create' THEN INSERT INTO public.catalog_draft_heads VALUES(d,product,next_revision,state);
    ELSE UPDATE public.catalog_draft_heads SET revision=next_revision,status=state WHERE draft_id=d; END IF;
    IF action IN ('create','revise') THEN
      FOR s IN SELECT value FROM jsonb_array_elements(p->'skus') LOOP
        INSERT INTO public.catalog_draft_sku_reservations(sku_id,draft_id,product_id,code)
          VALUES((s->>'id')::uuid,d,product,s->>'code') ON CONFLICT(sku_id) DO NOTHING;
        SELECT * INTO reserved FROM public.catalog_draft_sku_reservations WHERE sku_id=(s->>'id')::uuid FOR UPDATE;
        IF reserved.draft_id <> d OR reserved.product_id <> product OR (reserved.code IS NOT NULL AND reserved.code IS DISTINCT FROM s->>'code') THEN
          RAISE unique_violation USING MESSAGE='sku_identity_reserved';
        END IF;
        IF reserved.code IS NULL AND s ? 'code' THEN
          UPDATE public.catalog_draft_sku_reservations SET code=s->>'code' WHERE sku_id=(s->>'id')::uuid;
        END IF;
      END LOOP;
    END IF;
    INSERT INTO public.catalog_draft_revisions(draft_id,revision,product_id,status,payload,command_key,fingerprint,actor_id)
      VALUES(d,next_revision,product,state,p,key,p_fingerprint,actor);
    INSERT INTO public.catalog_draft_command_receipts VALUES(d,key,p_fingerprint,next_revision);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('outcome','conflict','reason','identity_reserved');
  END;
  RETURN jsonb_build_object('outcome','committed','record',public.catalog_draft_record(d,next_revision));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_record_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE canonical text; expected text; body jsonb;
BEGIN
 IF TG_TABLE_NAME = 'catalog_publications' THEN
  canonical := NEW.canonical_state; expected := NEW.digest;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  canonical := NEW.full_facts; expected := NEW.digest;
 ELSE
  canonical := NEW.canonical_text; expected := NEW.digest;
  IF canonical IS NULL THEN RETURN NEW; END IF;
 END IF;
 IF encode(sha256(convert_to(canonical,'UTF8')),'hex') <> expected THEN
  RAISE EXCEPTION 'catalog_publication_digest_mismatch' USING ERRCODE='23514';
 END IF;
 body := canonical::jsonb;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'catalog_publications' THEN
  IF (body->'schemaVersion' IS NULL OR body->'schemaVersion' NOT IN ('2'::jsonb,'3'::jsonb)) OR body->'product'->>'id' IS DISTINCT FROM NEW.product_id::text
   OR jsonb_typeof(body->'skus') IS DISTINCT FROM 'array'
   OR (body->'schemaVersion'='3'::jsonb AND (NOT public.catalog_lifecycle_roster_valid_v3(NEW.product_id,body)
    OR body#>'{product,document}' IS DISTINCT FROM (
     SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
       'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest)
     FROM public.catalog_product_document_revisions d WHERE d.id=NEW.document_revision_id AND d.product_id=NEW.product_id))) THEN
   RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  IF body->>'id' IS DISTINCT FROM NEW.sku_id::text OR body->>'productId' IS DISTINCT FROM NEW.product_id::text
   OR (body ? 'schemaVersion' AND NOT public.catalog_lifecycle_facts_valid_v3(body,'sku',NEW.sku_id,NEW.product_id))
   OR EXISTS(SELECT 1 FROM public.catalog_publications p WHERE p.id=NEW.publication_id
    AND (p.canonical_state::jsonb->'schemaVersion'='3'::jsonb) IS DISTINCT FROM (body ? 'schemaVersion')) THEN
   RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_record_admit() FROM PUBLIC;

ALTER TABLE public.commerce_orders ADD COLUMN catalog_acceptance jsonb;
ALTER TABLE public.subscription_events ADD COLUMN catalog_acceptance jsonb;
ALTER TABLE public.subscription_renewal_terms ADD COLUMN catalog_acceptance jsonb;
ALTER TABLE public.subscription_renewal_operations ADD COLUMN catalog_acceptance jsonb;
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
  OR NOT public.catalog_lifecycle_quantity_valid_v3(p_reference->'netContent')
  OR (p_reference ? 'demandPolicyRef' AND (jsonb_typeof(p_reference->'demandPolicyRef') IS DISTINCT FROM 'string'
   OR length(p_reference->>'demandPolicyRef') NOT BETWEEN 1 AND 240 OR p_reference->>'demandPolicyRef'<>btrim(p_reference->>'demandPolicyRef'))) THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 IF (p_reference#>>'{publicationHead,revision}')::bigint>2147483647 OR (p_reference#>>'{typeRef,version}')::bigint>2147483647 THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO publication FROM public.catalog_publications WHERE id=(p_reference#>>'{publicationHead,publicationId}')::uuid;
 SELECT * INTO revision FROM public.catalog_sku_revisions WHERE id=(p_reference->>'skuRevisionId')::uuid AND sku_id=(p_reference->>'skuId')::uuid;
 IF publication.id IS NULL OR revision.id IS NULL OR publication.product_id<>revision.product_id THEN
  RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
 manifest:=publication.canonical_state::jsonb; facts:=revision.full_facts::jsonb;
 SELECT digest INTO document_digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id AND product_id=publication.product_id;
 IF encode(sha256(convert_to(publication.canonical_state,'UTF8')),'hex')<>publication.digest
  OR encode(sha256(convert_to(revision.full_facts,'UTF8')),'hex')<>revision.digest
  OR NOT public.catalog_lifecycle_roster_valid_v3(publication.product_id,manifest)
  OR NOT public.catalog_lifecycle_facts_valid_v3(facts,'sku',revision.sku_id,revision.product_id)
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
CREATE FUNCTION public.catalog_acceptance_record_admit_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE codes text[]; accepted_codes text[];
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('commerce_orders','subscription_events','subscription_renewal_operations') THEN
  IF OLD.catalog_acceptance IS NOT NULL AND NEW.catalog_acceptance IS DISTINCT FROM OLD.catalog_acceptance THEN
   RAISE EXCEPTION 'catalog_acceptance_immutable' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_TABLE_NAME='subscription_renewal_operations' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.cycle_snapshot->>'frozenRevision'='native.purchase-renewal.v3' AND NEW.cycle_snapshot IS DISTINCT FROM OLD.cycle_snapshot THEN
    RAISE EXCEPTION 'catalog_acceptance_snapshot_immutable' USING ERRCODE='55000'; END IF;
  END IF;
 IF NEW.cycle_snapshot->>'frozenRevision'='native.purchase-renewal.v3' THEN
  IF NEW.catalog_acceptance IS NOT NULL AND NEW.catalog_acceptance IS DISTINCT FROM NEW.cycle_snapshot->'catalogAcceptance' THEN
   RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023'; END IF;
  NEW.catalog_acceptance:=NEW.cycle_snapshot->'catalogAcceptance';
  IF NEW.catalog_acceptance IS NULL THEN RAISE EXCEPTION 'catalog_acceptance_required' USING ERRCODE='22023'; END IF;
 END IF;
 END IF;
 IF NEW.catalog_acceptance IS NOT NULL THEN
  PERFORM public.catalog_acceptance_assert_v2(NEW.catalog_acceptance);
  IF TG_TABLE_NAME='subscription_renewal_operations' THEN
   IF NEW.cycle_snapshot->>'frozenRevision'='native.purchase-renewal.v3' THEN
    codes:=public.catalog_frozen_basket_codes_v2(NEW.cycle_snapshot);
    SELECT array_agg(l->>'skuCode') INTO accepted_codes FROM jsonb_array_elements(NEW.catalog_acceptance->'lines') l;
    IF codes IS NULL OR cardinality(codes)<>cardinality(accepted_codes) OR NOT codes @> accepted_codes THEN
     RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023'; END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_acceptance_record_admit_v2() FROM PUBLIC;
CREATE TRIGGER commerce_orders_catalog_acceptance_admit BEFORE INSERT OR UPDATE OF catalog_acceptance ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.catalog_acceptance_record_admit_v2();
CREATE TRIGGER subscription_events_catalog_acceptance_admit BEFORE INSERT OR UPDATE OF catalog_acceptance ON public.subscription_events FOR EACH ROW EXECUTE FUNCTION public.catalog_acceptance_record_admit_v2();
CREATE TRIGGER subscription_renewal_terms_catalog_acceptance_admit BEFORE INSERT OR UPDATE OF catalog_acceptance ON public.subscription_renewal_terms FOR EACH ROW EXECUTE FUNCTION public.catalog_acceptance_record_admit_v2();
CREATE TRIGGER subscription_renewal_operations_catalog_acceptance_admit BEFORE INSERT OR UPDATE OF catalog_acceptance,cycle_snapshot ON public.subscription_renewal_operations FOR EACH ROW EXECUTE FUNCTION public.catalog_acceptance_record_admit_v2();
CREATE FUNCTION public.subscription_renewal_purchase_terms_v2(p_subscription_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE old_terms jsonb; acceptance jsonb;
BEGIN
 SELECT catalog_acceptance INTO acceptance FROM public.subscription_renewal_terms WHERE subscription_id=p_subscription_id;
 IF acceptance IS NULL THEN RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
 PERFORM public.catalog_acceptance_assert_v2(acceptance);
 old_terms:=public.subscription_renewal_purchase_terms(p_subscription_id);
 IF old_terms->'renewalTerms'->>'version' IS DISTINCT FROM 'native.renewal-terms.v1' THEN
  RAISE EXCEPTION 'catalog_retained_terms_unavailable' USING ERRCODE='22023'; END IF;
 RETURN jsonb_set(old_terms,'{renewalTerms}',(old_terms->'renewalTerms')||jsonb_build_object('version','native.renewal-terms.v2','catalogAcceptance',acceptance));
END;
$$;
REVOKE ALL ON FUNCTION public.subscription_renewal_purchase_terms_v2(uuid) FROM PUBLIC;
