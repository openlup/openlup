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

-- Governed publication and frozen renewal retain different object-key ordering.
-- Their digests are over the canonical UTF-8 wire, never jsonb's display form.
CREATE FUNCTION public.catalog_lifecycle_canonical_v3(p_value jsonb,p_renewal boolean,p_depth integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE kind text:=jsonb_typeof(p_value); result text; exponent integer; float_digits text;
BEGIN
 IF p_depth>48 THEN RETURN NULL; END IF;
 IF kind='array' THEN
  SELECT CASE WHEN count(*)=count(wire) THEN '['||coalesce(string_agg(wire,',' ORDER BY n),'')||']' END INTO result
   FROM (SELECT n,public.catalog_lifecycle_canonical_v3(value,p_renewal,p_depth+1) AS wire
    FROM jsonb_array_elements(p_value) WITH ORDINALITY a(value,n)) children;
 ELSIF kind='object' THEN
  IF (NOT p_renewal AND p_value ?| ARRAY['__proto__','constructor','prototype'])
   OR (p_renewal AND EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE left(k,5)='_host')) THEN RETURN NULL; END IF;
  SELECT CASE WHEN count(*)=count(wire) THEN '{'||coalesce(string_agg(to_jsonb(key)::text||':'||wire,',' ORDER BY array_index,utf16),'')||'}' END INTO result
   FROM (SELECT key,public.catalog_lifecycle_canonical_v3(value,p_renewal,p_depth+1) AS wire,
    CASE WHEN NOT p_renewal AND key ~ '^(0|[1-9][0-9]{0,9})$' THEN
     CASE WHEN key::bigint<4294967295 THEN key::bigint END END AS array_index,
    public.catalog_lifecycle_utf16_v3(key) AS utf16
    FROM jsonb_each(p_value)) fields;
 ELSIF kind='number' THEN
  IF p_renewal THEN
   IF p_value::numeric<>trunc(p_value::numeric) OR abs(p_value::numeric)>9007199254740991 THEN RETURN NULL; END IF;
   RETURN trunc(p_value::numeric)::text;
  END IF;
  -- PostgreSQL uses its shortest float representation when this setting is
  -- positive. Preserve the caller's format, including on exception rollback.
  float_digits:=current_setting('extra_float_digits');
  IF float_digits::integer<=0 THEN PERFORM set_config('extra_float_digits','1',true); END IF;
  result:=(p_value::text::double precision)::text;
  IF float_digits::integer<=0 THEN PERFORM set_config('extra_float_digits',float_digits,true); END IF;
  IF strpos(result,'e')>0 THEN
   exponent:=split_part(result,'e',2)::integer;
   IF exponent BETWEEN -6 AND 20 THEN RETURN trim_scale(result::numeric)::text; END IF;
   RETURN split_part(result,'e',1)||'e'||CASE WHEN exponent>=0 THEN '+' ELSE '' END||exponent::text;
  END IF;
 ELSE
  RETURN p_value::text;
 END IF;
 RETURN result;
EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_canonical_v3(jsonb,boolean,integer) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_wire_valid_v3(p_bytes text,p_digest text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT public.catalog_lifecycle_canonical_v3(p_bytes::jsonb,false,0) IS NOT DISTINCT FROM p_bytes
  AND encode(sha256(convert_to(p_bytes,'UTF8')),'hex')=p_digest;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_wire_valid_v3(text,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_reference_valid_v3(p_value text,p_limit integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT p_value IS NOT NULL AND p_value<>'' AND p_value=btrim(p_value,
  chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||
  chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||
  chr(8239)||chr(8287)||chr(12288)||chr(65279))
  AND char_length(p_value)+(SELECT count(*) FROM regexp_split_to_table(p_value,'') ch WHERE octet_length(ch)=4)<=p_limit
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_reference_valid_v3(text,integer) FROM PUBLIC;

-- Native text ordering uses the same UTF-16 code units as the catalogue codecs.
CREATE FUNCTION public.catalog_lifecycle_utf16_v3(p_value text) RETURNS integer[]
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT ARRAY(SELECT CASE WHEN scalar>65535 THEN scalar-10240 WHEN scalar>=57344 THEN scalar+1046528 ELSE scalar END
  FROM (SELECT ascii(ch) AS scalar,n FROM regexp_split_to_table(p_value,'') WITH ORDINALITY c(ch,n)) characters ORDER BY n)
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_utf16_v3(text) FROM PUBLIC;

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
DECLARE state text; membership jsonb; previous integer[]; sort_key integer[]; source jsonb; entry jsonb; gtin text;
 uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 IF jsonb_typeof(p_facts) IS DISTINCT FROM 'object' OR p_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR p_facts->'id' IS DISTINCT FROM to_jsonb(p_id) THEN RETURN false; END IF;
 state := p_facts->>'lifecycleState';
 IF state IS NULL OR state NOT IN ('active','draft','withdrawn','archived')
  OR p_facts->>'status' IS DISTINCT FROM (CASE WHEN state='withdrawn' THEN 'active' ELSE state END)
  OR (p_facts ? 'attributes' AND jsonb_typeof(p_facts->'attributes') IS DISTINCT FROM 'object')
  OR jsonb_typeof(p_facts->'source') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 source := p_facts->'source';
 IF source - ARRAY['draftId','revision','commandKey','fingerprint'] <> '{}'::jsonb
  OR jsonb_typeof(source->'draftId') IS DISTINCT FROM 'string' OR source->>'draftId' !~ uuid_shape
  OR jsonb_typeof(source->'revision') IS DISTINCT FROM 'number' OR source->>'revision' !~ '^[1-9][0-9]{0,9}$'
  OR jsonb_typeof(source->'commandKey') IS DISTINCT FROM 'string' OR NOT public.catalog_lifecycle_reference_valid_v3(source->>'commandKey',240)
  OR jsonb_typeof(source->'fingerprint') IS DISTINCT FROM 'string' OR source->>'fingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 IF (source->>'revision')::bigint>2147483647 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_facts->'attributes') a
  CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(a.value) WHEN 'array' THEN a.value ELSE jsonb_build_array(a.value) END) scalar(value)
  WHERE CASE jsonb_typeof(scalar.value)
   WHEN 'string' THEN false WHEN 'boolean' THEN false
   WHEN 'object' THEN NOT public.catalog_lifecycle_quantity_valid_v3(scalar.value)
    AND EXISTS(SELECT 1 FROM jsonb_each(scalar.value) field WHERE jsonb_typeof(field.value)<>'string')
   ELSE true END) THEN RETURN false; END IF;
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
  OR jsonb_typeof(p_facts->'title') IS DISTINCT FROM 'string' OR p_facts->>'title'=''
  OR char_length(p_facts->>'title')+(SELECT count(*) FROM regexp_split_to_table(p_facts->>'title','') ch WHERE octet_length(ch)=4)>500
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
  OR (p_facts->'logisticsRef'<>'null'::jsonb AND (jsonb_typeof(p_facts->'logisticsRef')<>'string'
   OR NOT public.catalog_lifecycle_reference_valid_v3(p_facts->>'logisticsRef',240)))
  OR jsonb_typeof(p_facts->'memberships') IS DISTINCT FROM 'array'
  OR (p_facts ? 'demandPolicyRef' AND (jsonb_typeof(p_facts->'demandPolicyRef') IS DISTINCT FROM 'string'
   OR NOT public.catalog_lifecycle_reference_valid_v3(p_facts->>'demandPolicyRef',240))) THEN RETURN false; END IF;
 IF (p_facts->>'minQuantity')::bigint>2147483647 OR jsonb_array_length(p_facts->'assetRefs')>32 THEN RETURN false; END IF;
 IF EXISTS(SELECT FROM jsonb_each(p_facts->'options') o
  WHERE o.key !~ '^[a-z][a-z0-9_-]{0,63}$' OR o.key IN ('constructor','prototype')
   OR NOT coalesce(jsonb_typeof(o.value)='object' AND o.value - ARRAY['kind','value']='{}'::jsonb
    AND CASE o.value->>'kind'
     WHEN 'choice' THEN jsonb_typeof(o.value->'value')='string' AND octet_length(o.value->>'value')>0
      AND char_length(o.value->>'value')+(SELECT count(*) FROM regexp_split_to_table(o.value->>'value','') ch WHERE octet_length(ch)=4)<=120
     WHEN 'quantity' THEN public.catalog_lifecycle_quantity_valid_v3(o.value->'value')
     WHEN 'boolean' THEN jsonb_typeof(o.value->'value')='boolean'
     ELSE false END,false)) THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_facts->'assetRefs') LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'string' OR NOT public.catalog_lifecycle_reference_valid_v3(entry#>>'{}',240) THEN RETURN false; END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_facts->'identifiers') LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
   OR NOT (entry ?& ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef'])
   OR entry - ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef'] <> '{}'::jsonb
   OR jsonb_typeof(entry->'scheme') IS DISTINCT FROM 'string' OR NOT public.catalog_lifecycle_reference_valid_v3(entry->>'scheme',240)
   OR jsonb_typeof(entry->'issuer') IS DISTINCT FROM 'string' OR NOT public.catalog_lifecycle_reference_valid_v3(entry->>'issuer',240)
   OR jsonb_typeof(entry->'value') IS DISTINCT FROM 'string' OR entry->>'value'=''
   OR char_length(entry->>'value')+(SELECT count(*) FROM regexp_split_to_table(entry->>'value','') ch WHERE octet_length(ch)=4)>128
   OR coalesce(entry->>'packagingLevel','') NOT IN ('unit','case')
   OR jsonb_typeof(entry->'quantity') IS DISTINCT FROM 'number' OR entry->>'quantity' !~ '^[1-9][0-9]{0,5}$'
   OR jsonb_typeof(entry->'isPrimary') IS DISTINCT FROM 'boolean'
   OR (entry->'label'<>'null'::jsonb AND (jsonb_typeof(entry->'label')<>'string' OR NOT public.catalog_lifecycle_reference_valid_v3(entry->>'label',500)))
   OR (entry->'sourceRef'<>'null'::jsonb AND (jsonb_typeof(entry->'sourceRef')<>'string' OR NOT public.catalog_lifecycle_reference_valid_v3(entry->>'sourceRef',240))) THEN RETURN false; END IF;
  IF ((entry->>'packagingLevel'='unit') IS DISTINCT FROM (entry->'quantity'='1'::jsonb))
   OR (entry->'isPrimary'='true'::jsonb AND (entry->>'scheme'<>'gs1:gtin' OR entry->>'packagingLevel'<>'unit')) THEN RETURN false; END IF;
  IF entry->>'scheme'='gs1:gtin' THEN
   gtin:=entry->>'value';
   IF gtin !~ '^([0-9]{8}|[0-9]{12,14})$' THEN RETURN false; END IF;
   IF (SELECT sum(substring(gtin,i,1)::integer*(1+2*((length(gtin)-i)%2)))
     FROM generate_series(1,length(gtin)) i) % 10 <> 0 THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(p_facts->'identifiers') identifier WHERE identifier->'isPrimary'='true'::jsonb)>1 THEN RETURN false; END IF;
 FOR membership IN SELECT value FROM jsonb_array_elements(p_facts->'memberships') LOOP
  IF jsonb_typeof(membership) IS DISTINCT FROM 'object' OR membership - ARRAY['offerVersion','admitted'] <> '{}'::jsonb
   OR jsonb_typeof(membership->'offerVersion') IS DISTINCT FROM 'string'
   OR NOT public.catalog_lifecycle_reference_valid_v3(membership->>'offerVersion',240)
   OR jsonb_typeof(membership->'admitted') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  sort_key:=public.catalog_lifecycle_utf16_v3(membership->>'offerVersion');
  IF previous>=sort_key THEN RETURN false; END IF;
  previous:=sort_key;
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
   AND public.catalog_lifecycle_wire_valid_v3(r.full_facts,r.digest)),false)
 FROM jsonb_array_elements(p_manifest->'skus') entry
 JOIN public.catalog_sku_revisions r ON r.id=(entry->>'revisionId')::uuid AND r.sku_id::text=entry->>'skuId'
  AND to_jsonb(r.revision)=entry->'revision' AND r.digest=entry->>'digest' AND r.product_id=p_product_id;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_roster_resolved_v3(uuid,jsonb) FROM PUBLIC;

-- A predecessor manifest may be inserted before its own revisions exist, but
-- every revision already present must use the same stored dialect.
CREATE FUNCTION public.catalog_lifecycle_roster_version_v3(p_product_id uuid,p_manifest jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_manifest->'skus') entry
  JOIN public.catalog_sku_revisions r ON r.id=CASE WHEN entry->>'revisionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   THEN (entry->>'revisionId')::uuid END AND r.product_id=p_product_id
  WHERE (r.full_facts::jsonb ? 'schemaVersion') IS DISTINCT FROM (p_manifest->'schemaVersion'='3'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_roster_version_v3(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_lifecycle_head_admit_v3() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE manifest jsonb; source public.catalog_publications%ROWTYPE;
BEGIN
 SELECT * INTO source FROM public.catalog_publications WHERE id=NEW.publication_id AND product_id=NEW.product_id AND revision=NEW.revision;
 manifest:=source.canonical_state::jsonb;
 IF manifest->'schemaVersion'='3'::jsonb THEN
  IF NOT public.catalog_lifecycle_wire_valid_v3(source.canonical_state,source.digest)
   OR NOT public.catalog_lifecycle_roster_valid_v3(NEW.product_id,manifest)
   OR NOT public.catalog_lifecycle_roster_resolved_v3(NEW.product_id,manifest) THEN
   RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
  END IF;
 ELSIF manifest->'product' ? 'schemaVersion' OR NOT public.catalog_lifecycle_roster_version_v3(NEW.product_id,manifest) THEN
  RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_lifecycle_head_admit_v3() FROM PUBLIC;
CREATE TRIGGER catalog_publication_heads_lifecycle_admit BEFORE INSERT OR UPDATE ON public.catalog_publication_heads
 FOR EACH ROW EXECUTE FUNCTION public.catalog_lifecycle_head_admit_v3();

-- Resolve retained lines once. Supported historic flat baskets remain readable;
-- a native versioned carrier must also agree with its nested line copies.
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
  IF item ?| ARRAY['variantId','skuId'] THEN
   SELECT to_jsonb(k.id) INTO identity FROM public.catalog_skus k WHERE k.sku=code;
   IF identity IS NULL OR (item ? 'variantId' AND item->'variantId' IS DISTINCT FROM identity)
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

CREATE FUNCTION public.catalog_frozen_basket_codes_v2(p_snapshot jsonb,p_fingerprint text DEFAULT NULL) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE codes text[];
BEGIN
 IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF p_snapshot ? 'frozenRevision' AND (
  p_snapshot->>'frozenRevision' IS NULL OR p_snapshot->>'frozenRevision' NOT IN ('native.purchase-renewal.v1','native.purchase-renewal.v2','native.purchase-renewal.v3')
  OR p_snapshot#>'{orderSnapshot,lines}' IS DISTINCT FROM p_snapshot->'lines'
  OR p_snapshot#>'{templateSnapshot,lines}' IS DISTINCT FROM p_snapshot->'lines') THEN RETURN NULL; END IF;
 codes:=public.catalog_retained_basket_codes_v2(p_snapshot->'lines');
 IF codes IS NULL THEN RETURN NULL; END IF;
 IF p_snapshot->>'frozenRevision'='native.purchase-renewal.v3' THEN
  IF NOT public.catalog_renewal_lines_v3(p_snapshot->'lines')
   OR (p_fingerprint IS NOT NULL AND (NOT public.catalog_frozen_wire_valid_v3(p_snapshot,p_fingerprint)
    OR NOT public.catalog_acceptance_roster_valid_v2(p_snapshot->'catalogAcceptance',public.catalog_retained_basket_v2(p_snapshot->'lines'))))
  THEN RETURN NULL; END IF;
 END IF;
 RETURN codes;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_frozen_basket_codes_v2(jsonb,text) FROM PUBLIC;

-- Reconcile every stored line copy with the owner item ledger when it exists.
-- An initial order insert can carry a complete authored snapshot before items.
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

CREATE FUNCTION public.catalog_quoted_edit_basket_v2(p_lines jsonb,p_sized boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 RETURN public.catalog_retained_basket_v2((SELECT jsonb_agg(jsonb_build_object('variantId',l->'variantId',
  'sku',CASE WHEN p_sized THEN l#>'{quoteLine,sku}' ELSE to_jsonb(k.sku) END,
  'quantity',CASE WHEN p_sized THEN l->'qty' ELSE l->'quantity' END))
  FROM jsonb_array_elements(p_lines) l LEFT JOIN public.catalog_skus k ON to_jsonb(k.id)=l->'variantId'));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_quoted_edit_basket_v2(jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_acceptance_roster_valid_v2(p_acceptance jsonb,p_basket jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF p_basket IS NULL OR p_acceptance->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR jsonb_typeof(p_acceptance->'lines') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 RETURN (SELECT count(*)=count(DISTINCT l->>'skuCode') AND count(*)>0
  AND count(*)=(SELECT count(*) FROM jsonb_object_keys(p_basket))
  AND bool_and(coalesce(p_basket ? (l->>'skuCode') AND EXISTS(
   SELECT 1 FROM public.catalog_skus k WHERE to_jsonb(k.id)=l->'skuId' AND k.sku=l->>'skuCode'),false))
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

-- Read the same accepted edit owners for carrier admission and handoff proof.
CREATE FUNCTION public.catalog_edit_evidence_v2(p_event public.subscription_events,p_inserting boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE payload jsonb:=p_event.payload; edit_action text:=payload->>'action'; preview public.subscription_quote_previews;
 old_quote public.subscription_edit_quotes; edited jsonb; quoted jsonb; proposed jsonb; hash text; basis integer;
BEGIN
 IF edit_action IS NULL OR p_event.event_type<>'subscription.customer_self_service.'||edit_action THEN RETURN NULL; END IF;
 IF payload ? 'linePricing' THEN
  edited:=public.catalog_retained_basket_v2(payload->'linePricing');
  IF edited IS NULL THEN RETURN NULL; END IF;
 END IF;
 IF payload ? 'quotePreviewId' THEN
  SELECT * INTO preview FROM public.subscription_quote_previews q
   WHERE q.id::text=payload->>'quotePreviewId' AND q.subscription_id=p_event.subscription_id AND q.action=edit_action
    AND EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.id=q.subscription_id AND s.client_id=q.client_id)
    AND ((q.status='accepted' AND q.accepted_event_id=p_event.id AND q.accepted_at=p_event.occurred_at)
     OR (p_inserting AND q.status='previewed'));
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF edit_action='update_package_template' THEN
   IF jsonb_typeof(preview.quote_snapshot->'baseLines') IS DISTINCT FROM 'array'
    OR jsonb_typeof(preview.quote_snapshot->'addonLines') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
   proposed:=(preview.quote_snapshot->'baseLines')||(preview.quote_snapshot->'addonLines');
  ELSE proposed:=preview.quote_snapshot->'lines'; END IF;
  quoted:=public.catalog_quoted_edit_basket_v2(proposed,true);
  IF quoted IS NULL OR quoted IS DISTINCT FROM edited THEN RETURN NULL; END IF;
  hash:=preview.quote_hash; basis:=preview.template_version;
 ELSE
  SELECT * INTO old_quote FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=p_event.id
   AND q.subscription_id=p_event.subscription_id AND q.status='accepted' AND q.action=edit_action AND q.accepted_at=p_event.occurred_at;
  IF FOUND THEN
   hash:=coalesce(payload#>>'{payload,acceptedQuoteHash}',payload->>'quoteHash');
   basis:=old_quote.expected_template_version;
   IF hash IS DISTINCT FROM old_quote.quote_hash OR (payload ? 'quoteHash' AND payload->>'quoteHash' IS DISTINCT FROM hash)
    OR (SELECT count(*) FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=p_event.id)<>1 THEN RETURN NULL; END IF;
   quoted:=public.catalog_quoted_edit_basket_v2(old_quote.proposed_lines,false);
   IF quoted IS NULL OR (edited IS NOT NULL AND quoted IS DISTINCT FROM edited) THEN RETURN NULL; END IF;
  ELSIF payload ? 'quoteHash' OR payload#>'{payload,acceptedQuoteHash}' IS NOT NULL THEN RETURN NULL;
  ELSE quoted:=edited; END IF;
 END IF;
 IF quoted IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('basket',quoted,'basis',basis,'quoteHash',hash,'actorId',preview.actor_id,
  'commandKey',preview.accepted_idempotency_key);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_edit_evidence_v2(public.subscription_events,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_edit_consumed_basis_v2(p_event public.subscription_events,p_basis integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE evidence jsonb:=public.catalog_edit_evidence_v2(p_event,false);
BEGIN
 IF evidence->'basis' IS DISTINCT FROM to_jsonb(p_basis) THEN RETURN false; END IF;
 IF p_event.payload->>'quoteHash'=evidence->>'quoteHash' AND NOT (p_event.payload ? 'quotePreviewId')
  AND p_event.payload#>'{payload,acceptedQuoteHash}' IS NULL
  AND p_event.payload->'templateVersion'=to_jsonb(p_basis::bigint+1) THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM public.subscription_command_receipts r
  JOIN public.subscriptions s ON s.id=r.subscription_id AND s.client_id=r.client_id
  WHERE r.subscription_id=p_event.subscription_id AND r.quote_hash=evidence->>'quoteHash'
   AND (evidence->>'actorId' IS NULL OR r.actor_id::text=evidence->>'actorId')
   AND (evidence->>'commandKey' IS NULL OR r.idempotency_key=evidence->>'commandKey')
   AND p_event.idempotency_key='command:'||encode(sha256(convert_to(r.actor_id::text||':'||r.idempotency_key,'UTF8')),'hex')
   AND r.status='applied' AND r.command->>'action'=p_event.payload->>'action' AND r.result->>'action'=p_event.payload->>'action'
   AND r.result->'subscriptionId'=to_jsonb(r.subscription_id) AND r.result->'eventId'=to_jsonb(p_event.id)
   AND r.result->'templateVersion'=to_jsonb(p_basis::bigint+1));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_edit_consumed_basis_v2(public.subscription_events,integer) FROM PUBLIC;

CREATE FUNCTION public.catalog_renewal_integer_v3(p_value jsonb,p_min bigint,p_max bigint DEFAULT 9007199254740991) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT CASE WHEN jsonb_typeof(p_value)='number' THEN p_value::numeric BETWEEN p_min AND p_max
  AND trunc(p_value::numeric)=p_value::numeric ELSE false END
$$;
REVOKE ALL ON FUNCTION public.catalog_renewal_integer_v3(jsonb,bigint,bigint) FROM PUBLIC;

CREATE FUNCTION public.catalog_renewal_keys_v3(p_value jsonb,p_required text[],p_optional text[] DEFAULT ARRAY[]::text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT coalesce(jsonb_typeof(p_value)='object' AND p_value ?& p_required AND p_value-(p_required||p_optional)='{}'::jsonb,false)
$$;
REVOKE ALL ON FUNCTION public.catalog_renewal_keys_v3(jsonb,text[],text[]) FROM PUBLIC;

CREATE FUNCTION public.catalog_renewal_lines_v3(p_lines jsonb,p_sequential boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 RETURN jsonb_array_length(p_lines) BETWEEN 1 AND 100 AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_lines) WITH ORDINALITY l(body,ordinal)
  WHERE NOT public.catalog_renewal_keys_v3(l.body,ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'])
   OR NOT public.catalog_renewal_integer_v3(l.body->'lineOrdinal',1)
   OR NOT public.catalog_renewal_integer_v3(l.body->'quantity',1)
   OR NOT public.catalog_renewal_integer_v3(l.body->'unitAmountMinor',0)
   OR jsonb_typeof(l.body->'sku') IS DISTINCT FROM 'string' OR l.body->>'sku'=''
   OR (p_sequential AND l.body->'lineOrdinal' IS DISTINCT FROM to_jsonb(l.ordinal)));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_renewal_lines_v3(jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_full_graduation_lines_v2(p_payload jsonb,p_graduation jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE before_lines jsonb:=p_payload->'before'; final_lines jsonb:=p_payload->'lines';
 pricing jsonb:=p_payload->'linePricing'; marker jsonb:=p_graduation->'lines'; roster jsonb;
BEGIN
 IF jsonb_typeof(marker) IS DISTINCT FROM 'array' OR NOT public.catalog_renewal_lines_v3(before_lines)
  OR NOT public.catalog_renewal_lines_v3(final_lines,true) THEN RETURN false; END IF;
 roster:=public.catalog_retained_basket_v2(final_lines);
 IF roster IS NULL OR roster IS DISTINCT FROM public.catalog_retained_basket_v2(pricing)
  OR public.catalog_retained_basket_v2(before_lines) IS NULL THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(marker) m WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(final_lines) l JOIN jsonb_array_elements(pricing) p ON p->'sku'=l->'sku'
  WHERE l->'sku'=m->'sku' AND l->'quantity'=m->'qty'
   AND l->'unitAmountMinor'=m#>'{quoteLine,unitPriceGross,amountMinor}'
   AND p->'isAddon'=m->'isAddon' AND p->'unitAmountMinor'=l->'unitAmountMinor'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(final_lines) l WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(marker) m WHERE m->'sku'=l->'sku')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before_lines) b JOIN jsonb_array_elements(pricing) p ON p->'sku'=b->'sku'
   WHERE b->'sku'=l->'sku' AND b->'quantity'=l->'quantity' AND b->'unitAmountMinor'=l->'unitAmountMinor'
    AND p->'isAddon'='true'::jsonb AND p->'unitAmountMinor'=l->'unitAmountMinor'));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_full_graduation_lines_v2(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_graduation_consumed_v2(p_subscription uuid,p_basis integer,p_graduation jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT count(*)=1 FROM public.subscription_events e
 WHERE e.subscription_id=p_subscription AND (
  (e.event_type='subscription.starter_graduated' AND e.payload->'templateVersion'=to_jsonb(p_basis::bigint+1)
   AND e.payload->'mode'='"full"'::jsonb AND e.payload->'basisTemplateVersion'=to_jsonb(p_basis)
   AND e.payload->'cadenceDays'=p_graduation->'cadenceDays'
   AND e.idempotency_key ~ ('^(system:)*starter-graduation:'||p_subscription::text||':'||p_basis::text||'$')
   AND public.catalog_full_graduation_lines_v2(e.payload,p_graduation))
  OR (e.event_type LIKE 'subscription.customer_self_service.%' AND public.catalog_edit_consumed_basis_v2(e,p_basis)));
$$;
REVOKE ALL ON FUNCTION public.catalog_graduation_consumed_v2(uuid,integer,jsonb) FROM PUBLIC;

-- A nullable legacy revision never erases a known identity. This is one unpaginated
-- query for archive and impact. It takes no commerce row or advisory locks.
CREATE FUNCTION public.catalog_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; obligations jsonb := '[]'; item record;
 marker jsonb; delivery jsonb; graduation jsonb; line jsonb; basis integer; codes text[]; manifest jsonb;
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
 IF NOT FOUND OR NOT public.catalog_lifecycle_facts_valid_v3(sku.publication_facts,'sku',sku.id,sku.product_id)
  OR sku.publication_facts->>'code' IS DISTINCT FROM sku.sku OR sku.publication_facts->>'status' IS DISTINCT FROM sku.status
  OR sku.publication_facts->'sellableStandalone' IS DISTINCT FROM to_jsonb(sku.sellable_standalone)
  OR sku.publication_facts->'sellableInSubscription' IS DISTINCT FROM to_jsonb(sku.sellable_in_subscription) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
 END IF;
 SELECT p.canonical_state::jsonb INTO manifest FROM public.catalog_publications p
  JOIN public.catalog_publication_heads h ON h.publication_id=p.id AND h.product_id=p.product_id AND h.revision=p.revision
  WHERE p.product_id=sku.product_id AND public.catalog_lifecycle_wire_valid_v3(p.canonical_state,p.digest);
 IF NOT public.catalog_lifecycle_roster_valid_v3(sku.product_id,manifest)
  OR NOT public.catalog_lifecycle_roster_resolved_v3(sku.product_id,manifest)
  OR NOT EXISTS(SELECT 1 FROM public.catalog_products p WHERE p.id=sku.product_id
    AND p.publication_facts=manifest->'product' AND p.status=manifest#>>'{product,status}'
    AND p.slug=manifest#>>'{product,slug}' AND p.name=manifest#>>'{product,name}'
    AND to_jsonb(p.primary_sku_id)=manifest#>'{product,primarySkuId}'
    AND to_jsonb(p.current_document_revision_id)=manifest#>'{product,document,id}')
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
 FOR item IN SELECT o.id,o.metadata,o.catalog_acceptance,o.total_amount_minor,a.subscription_id,s.template_version,t.purchase_facts,
  a.state='active' AND t.completed_at IS NOT NULL AND t.subscription_id=a.subscription_id
   AND EXISTS(SELECT 1 FROM public.subscription_renewal_terms r WHERE r.subscription_id=a.subscription_id)
   AND EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=a.subscription_id)
   AND EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=a.subscription_id) AS handed_off
  FROM public.commerce_orders o
  LEFT JOIN public.subscription_activations a ON a.order_id=o.id
  LEFT JOIN public.subscription_renewal_attachments t ON t.order_id=o.id
  LEFT JOIN public.subscriptions s ON s.id=a.subscription_id
  WHERE a.state<>'compensated'
   OR (a.order_id IS NULL AND o.renewal_operation_id IS NULL AND o.status='pending_payment'
    AND (o.catalog_acceptance IS NOT NULL OR o.metadata#>'{quoteSnapshot,quote,lines}' IS NOT NULL
      OR o.metadata#>'{orderDraftSnapshot,lines}' IS NOT NULL OR o.metadata#>'{orderSnapshot,lines}' IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id)))
 LOOP
  basket:=public.catalog_order_evidence_v2(item.id,item.metadata,item.catalog_acceptance,item.total_amount_minor=0);
  IF basket IS NULL THEN unknown:=true; CONTINUE; END IF;
  IF item.handed_off THEN
   purchase_basket:=public.catalog_retained_basket_v2(item.purchase_facts->'lines',true);
   IF purchase_basket IS DISTINCT FROM basket THEN unknown:=true;
   ELSIF (purchase_basket IS DISTINCT FROM (
      SELECT jsonb_object_agg(l.sku,l.quantity) FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=item.subscription_id)
     OR purchase_basket IS DISTINCT FROM (
      SELECT jsonb_object_agg(k.sku,l.quantity) FROM public.subscription_lines l JOIN public.catalog_skus k ON k.id=l.variant_id
      WHERE l.subscription_id=item.subscription_id))
    AND (item.template_version<=1 OR NOT public.catalog_graduation_consumed_v2(
     item.subscription_id,1,item.purchase_facts#>'{renewalTerms,starterPack,graduation}')) THEN unknown:=true;
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
  codes:=public.catalog_frozen_basket_codes_v2(item.cycle_snapshot,item.operation_fingerprint);
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
  codes:=public.catalog_frozen_basket_codes_v2(item.cycle_snapshot,item.fingerprint);
  IF item.bound IS DISTINCT FROM true OR codes IS NULL THEN unknown:=true;
  ELSIF NOT item.handed_off AND sku.sku=ANY(codes) THEN
   obligations:=obligations||jsonb_build_array(jsonb_build_object('family','stock_wait','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
  END IF;
 END LOOP;
 FOR item IN SELECT a.order_id AS id,a.subscription_id,a.purchase_facts,s.template_version FROM public.subscription_renewal_attachments a
  JOIN public.subscriptions s ON s.id=a.subscription_id WHERE s.status IN ('active','paused') AND a.purchase_facts#>'{renewalTerms,starterPack}' IS NOT NULL
 LOOP
  marker:=item.purchase_facts#>'{renewalTerms,starterPack}';
  delivery:=marker->'delivery2'; graduation:=marker->'graduation';
  codes:=public.catalog_retained_basket_codes_v2(graduation->'lines');
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR marker->'schemaVersion' IS DISTINCT FROM '"1"'::jsonb
   OR marker - ARRAY['schemaVersion','basisTemplateVersion','starterIntervalDays','delivery2','graduation'] <> '{}'::jsonb
   OR jsonb_typeof(marker->'basisTemplateVersion') IS DISTINCT FROM 'number' OR marker->>'basisTemplateVersion' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(marker->'starterIntervalDays') IS DISTINCT FROM 'number' OR marker->>'starterIntervalDays' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(delivery) IS DISTINCT FROM 'object' OR delivery - ARRAY['discountBps','discountMinor','basisSubtotalMinor'] <> '{}'::jsonb
   OR jsonb_typeof(delivery->'discountBps') IS DISTINCT FROM 'number' OR delivery->>'discountBps' !~ '^(0|[1-9][0-9]{0,4})$'
   OR jsonb_typeof(delivery->'discountMinor') IS DISTINCT FROM 'number' OR delivery->>'discountMinor' !~ '^(0|[1-9][0-9]{0,15})$'
   OR jsonb_typeof(delivery->'basisSubtotalMinor') IS DISTINCT FROM 'number' OR delivery->>'basisSubtotalMinor' !~ '^(0|[1-9][0-9]{0,15})$'
   OR jsonb_typeof(graduation) IS DISTINCT FROM 'object' OR graduation - ARRAY['cadenceDays','sizeConstraint','lines'] <> '{}'::jsonb
   OR jsonb_typeof(graduation->'cadenceDays') IS DISTINCT FROM 'number' OR graduation->>'cadenceDays' !~ '^[1-9][0-9]{0,9}$'
   OR (graduation ? 'sizeConstraint' AND jsonb_typeof(graduation->'sizeConstraint') IS DISTINCT FROM 'object')
   OR jsonb_typeof(item.purchase_facts#>'{renewalTerms,minimumPayableMinor}') IS DISTINCT FROM 'number'
   OR item.purchase_facts#>>'{renewalTerms,minimumPayableMinor}' !~ '^[1-9][0-9]{0,15}$'
   OR jsonb_typeof(item.purchase_facts#>'{renewalTerms,normalCadenceDays}') IS DISTINCT FROM 'array'
   OR codes IS NULL OR EXISTS(SELECT FROM unnest(codes) code WHERE NOT EXISTS(SELECT FROM public.catalog_skus k WHERE k.sku=code)) THEN unknown:=true; CONTINUE; END IF;
  IF (marker->>'basisTemplateVersion')::bigint>2147483647 OR (marker->>'starterIntervalDays')::bigint>2147483647
   OR (graduation->>'cadenceDays')::bigint>2147483647 OR (delivery->>'discountBps')::integer>10000
   OR (delivery->>'basisSubtotalMinor')::bigint>9007199254740991 OR (delivery->>'discountMinor')::bigint>9007199254740991
   OR (delivery->>'basisSubtotalMinor')::bigint-(delivery->>'discountMinor')::bigint<(item.purchase_facts#>>'{renewalTerms,minimumPayableMinor}')::bigint
   OR NOT (item.purchase_facts#>'{renewalTerms,normalCadenceDays}' @> jsonb_build_array(graduation->'cadenceDays')) THEN unknown:=true; CONTINUE; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(graduation->'lines') LOOP
   IF line - ARRAY['sku','qty','sortOrder','isAddon','quoteLine'] <> '{}'::jsonb
    OR jsonb_typeof(line->'sku') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'qty') IS DISTINCT FROM 'number'
    OR line->>'qty' !~ '^[1-9][0-9]?$'
    OR jsonb_typeof(line->'sortOrder') IS DISTINCT FROM 'number' OR line->>'sortOrder' !~ '^(0|[1-9][0-9]{0,15})$'
    OR jsonb_typeof(line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(line->'quoteLine') IS DISTINCT FROM 'object'
    OR jsonb_typeof(line#>'{quoteLine,unitPriceGross,amountMinor}') IS DISTINCT FROM 'number'
    OR line#>>'{quoteLine,unitPriceGross,amountMinor}' !~ '^(0|[1-9][0-9]{0,15})$'
    OR jsonb_typeof(line#>'{quoteLine,lineSubtotalGross,amountMinor}') IS DISTINCT FROM 'number'
    OR line#>>'{quoteLine,lineSubtotalGross,amountMinor}' !~ '^(0|[1-9][0-9]{0,15})$' THEN unknown:=true; EXIT; END IF;
   IF (line->>'sortOrder')::bigint>9007199254740991 OR (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint>9007199254740991
    OR (line#>>'{quoteLine,lineSubtotalGross,amountMinor}')::bigint>9007199254740991
    OR (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint*(line->>'qty')::integer
        <>(line#>>'{quoteLine,lineSubtotalGross,amountMinor}')::bigint
    OR ((line->'quoteLine') ? 'sku' AND line#>'{quoteLine,sku}' IS DISTINCT FROM line->'sku')
    OR ((line->'quoteLine') ? 'quantity' AND line#>'{quoteLine,quantity}' IS DISTINCT FROM line->'qty') THEN unknown:=true; EXIT; END IF;
  END LOOP;
  IF unknown THEN CONTINUE; END IF;
  basis:=(marker->>'basisTemplateVersion')::integer;
  IF basis<>item.template_version THEN
   IF basis<item.template_version AND public.catalog_graduation_consumed_v2(item.subscription_id,basis,graduation) THEN CONTINUE; END IF;
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

CREATE OR REPLACE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; operation jsonb; expectation jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text; inputs jsonb; content jsonb; claim jsonb; allowed text[]; valid_v4 boolean;
  trim_space constant text := chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
    chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
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
  IF c->'schemaVersion'='4'::jsonb AND (key<>btrim(key,trim_space)
   OR char_length(key)+(SELECT count(*) FROM regexp_split_to_table(key,'') ch WHERE octet_length(ch)=4)>240) THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_invalid');
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
      IF c->'schemaVersion'='4'::jsonb THEN
        -- Keep validation inside the existing invoker and its draft-role ACL.
        valid_v4 := false;
        <<v4_grammar>>
        DECLARE
          op jsonb; child jsonb; evidence jsonb; asset jsonb; previous text; verb text; ref_text text;
          previous_asset integer[]; asset_key integer[];
          uuid_shape constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
          code_shape constant text := '^[A-Za-z0-9._:-]{1,160}$';
        BEGIN
          FOR op IN SELECT value FROM jsonb_array_elements(inputs->'operations') LOOP
           verb := op->>'op';
           IF (op ? 'productSlug' AND (jsonb_typeof(op->'productSlug') IS DISTINCT FROM 'string'
             OR op->>'productSlug' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'))
            OR (op ? 'skuCode' AND (jsonb_typeof(op->'skuCode') IS DISTINCT FROM 'string' OR op->>'skuCode' !~ code_shape)) THEN EXIT v4_grammar; END IF;
           IF verb='set_eligibility' AND (jsonb_typeof(op->'sellableStandalone') IS DISTINCT FROM 'boolean'
             OR jsonb_typeof(op->'sellableInSubscription') IS DISTINCT FROM 'boolean') THEN EXIT v4_grammar; END IF;
           IF verb IN ('set_product_lifecycle','set_sku_lifecycle') AND
            (coalesce(op->>'expectedState','') NOT IN ('draft','active','withdrawn','archived')
             OR coalesce(op->>'state','') NOT IN ('active','withdrawn','archived')) THEN EXIT v4_grammar; END IF;
           IF verb IN ('restore_product','restore_sku') AND op->'expectedState' IS DISTINCT FROM '"withdrawn"'::jsonb THEN EXIT v4_grammar; END IF;
           IF verb='set_product_lifecycle' THEN
            IF jsonb_typeof(op->'children') IS DISTINCT FROM 'array' THEN EXIT v4_grammar; END IF;
            IF jsonb_array_length(op->'children')>50000 THEN EXIT v4_grammar; END IF;
            previous := NULL;
            FOR child IN SELECT value FROM jsonb_array_elements(op->'children') LOOP
             IF jsonb_typeof(child) IS DISTINCT FROM 'object' OR child - ARRAY['skuCode','expectedState'] <> '{}'::jsonb
              OR jsonb_typeof(child->'skuCode') IS DISTINCT FROM 'string' OR child->>'skuCode' !~ code_shape
              OR coalesce(child->>'expectedState','') NOT IN ('draft','active','withdrawn','archived')
              OR previous COLLATE "C">=child->>'skuCode' COLLATE "C" THEN EXIT v4_grammar; END IF;
             previous := child->>'skuCode';
            END LOOP;
           END IF;
           IF (verb='restore_sku' OR verb='set_sku_lifecycle' AND op->>'state'='active')
             AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inputs->'operations') e
               WHERE e->>'op'='set_eligibility' AND e->'skuCode'=op->'skuCode'
                AND (e->'sellableStandalone'='true'::jsonb OR e->'sellableInSubscription'='true'::jsonb)) THEN EXIT v4_grammar; END IF;
          END LOOP;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(inputs#>'{evidence,drafts}') e GROUP BY e->>'draftId' HAVING count(*)>1)
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(inputs#>'{evidence,media}') e GROUP BY e->>'skuCode' HAVING count(*)>1) THEN EXIT v4_grammar; END IF;
          FOR evidence IN SELECT value FROM jsonb_array_elements(inputs#>'{evidence,drafts}') LOOP
           IF jsonb_typeof(evidence->'draftId') IS DISTINCT FROM 'string' OR evidence->>'draftId' !~ uuid_shape
            OR jsonb_typeof(evidence->'revision') IS DISTINCT FROM 'number' OR evidence->>'revision' !~ '^[1-9][0-9]{0,9}$'
            OR jsonb_typeof(evidence->'commandKey') IS DISTINCT FROM 'string'
            OR jsonb_typeof(evidence->'fingerprint') IS DISTINCT FROM 'string' OR evidence->>'fingerprint' !~ '^[a-f0-9]{64}$' THEN EXIT v4_grammar; END IF;
           IF (evidence->>'revision')::bigint>2147483647 THEN EXIT v4_grammar; END IF;
          END LOOP;
          FOR evidence IN SELECT value FROM jsonb_array_elements(inputs#>'{evidence,media}') LOOP
           IF jsonb_typeof(evidence->'skuCode') IS DISTINCT FROM 'string' OR evidence->>'skuCode' !~ code_shape
            OR jsonb_typeof(evidence->'mediaRef') IS DISTINCT FROM 'string'
            OR jsonb_typeof(evidence->'revisionDigest') IS DISTINCT FROM 'string' OR evidence->>'revisionDigest' !~ '^[a-f0-9]{64}$'
            OR jsonb_typeof(evidence->'assetRefs') IS DISTINCT FROM 'array' THEN EXIT v4_grammar; END IF;
           IF jsonb_array_length(evidence->'assetRefs')>32 THEN EXIT v4_grammar; END IF;
           previous_asset := NULL;
           FOR asset IN SELECT value FROM jsonb_array_elements(evidence->'assetRefs') LOOP
            IF jsonb_typeof(asset) IS DISTINCT FROM 'string' THEN EXIT v4_grammar; END IF;
            -- The invoker draft path uses built-ins only, with the same UTF-16
            -- order as the catalogue's canonical and retained-fact checks.
            SELECT ARRAY(SELECT CASE WHEN scalar>65535 THEN scalar-10240 WHEN scalar>=57344 THEN scalar+1046528 ELSE scalar END
             FROM (SELECT ascii(ch) AS scalar,n FROM regexp_split_to_table(asset#>>'{}','') WITH ORDINALITY c(ch,n)) units ORDER BY n) INTO asset_key;
            IF previous_asset>=asset_key THEN EXIT v4_grammar; END IF;
            previous_asset := asset_key;
           END LOOP;
          END LOOP;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'skus') a
            WHERE (a ? 'demandPolicyRef' AND jsonb_typeof(a->'demandPolicyRef') IS DISTINCT FROM 'string')
               OR (a ? 'logisticsRef' AND jsonb_typeof(a->'logisticsRef') IS DISTINCT FROM 'string')
               OR (a ? 'assetRefs' AND CASE WHEN jsonb_typeof(a->'assetRefs')='array'
                 THEN jsonb_array_length(a->'assetRefs')>32 OR EXISTS(
                   SELECT 1 FROM jsonb_array_elements(a->'assetRefs') r WHERE jsonb_typeof(r)<>'string')
                 ELSE true END)) THEN EXIT v4_grammar; END IF;
          -- The draft wire bounds references in UTF-16 and uses JavaScript trim.
          FOR ref_text IN
            SELECT e->>'commandKey' FROM jsonb_array_elements(inputs#>'{evidence,drafts}') e
            UNION ALL SELECT e->>'mediaRef' FROM jsonb_array_elements(inputs#>'{evidence,media}') e
            UNION ALL SELECT a#>>'{}' FROM jsonb_array_elements(inputs#>'{evidence,media}') e,
              LATERAL jsonb_array_elements(e->'assetRefs') a
            UNION ALL SELECT a->>'demandPolicyRef' FROM jsonb_array_elements(p->'skus') a WHERE a ? 'demandPolicyRef'
            UNION ALL SELECT a->>'logisticsRef' FROM jsonb_array_elements(p->'skus') a WHERE a ? 'logisticsRef'
            UNION ALL SELECT r#>>'{}' FROM jsonb_array_elements(p->'skus') a, LATERAL jsonb_array_elements(a->'assetRefs') r
          LOOP
            IF ref_text='' OR ref_text<>btrim(ref_text,trim_space)
             OR char_length(ref_text)+(SELECT count(*) FROM regexp_split_to_table(ref_text,'') ch WHERE octet_length(ch)=4)>240
            THEN EXIT v4_grammar; END IF;
          END LOOP;
          valid_v4 := true;
        END v4_grammar;
        IF NOT valid_v4 THEN
          RETURN jsonb_build_object('outcome','validation_issue','reason','publication_inputs_invalid');
        END IF;
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
   OR (body->'product' ? 'schemaVersion') IS DISTINCT FROM (body->'schemaVersion'='3'::jsonb) THEN
   RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
  END IF;
  IF body->'schemaVersion'='2'::jsonb AND NOT public.catalog_lifecycle_roster_version_v3(NEW.product_id,body) THEN
   RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
  END IF;
  IF body->'schemaVersion'='3'::jsonb THEN
   IF NOT public.catalog_lifecycle_wire_valid_v3(canonical,expected)
    OR NOT public.catalog_lifecycle_roster_valid_v3(NEW.product_id,body)
    OR body#>'{product,document}' IS DISTINCT FROM (
     SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
       'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest)
     FROM public.catalog_product_document_revisions d WHERE d.id=NEW.document_revision_id AND d.product_id=NEW.product_id) THEN
    RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  IF body->>'id' IS DISTINCT FROM NEW.sku_id::text OR body->>'productId' IS DISTINCT FROM NEW.product_id::text
   OR EXISTS(SELECT 1 FROM public.catalog_publications p WHERE p.id=NEW.publication_id
    AND (p.canonical_state::jsonb->'schemaVersion'='3'::jsonb) IS DISTINCT FROM (body ? 'schemaVersion')) THEN
   RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
  END IF;
  IF body ? 'schemaVersion' THEN
   IF NOT public.catalog_lifecycle_wire_valid_v3(canonical,expected)
    OR NOT public.catalog_lifecycle_facts_valid_v3(body,'sku',NEW.sku_id,NEW.product_id) THEN
    RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
   END IF;
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
 IF NOT public.catalog_lifecycle_wire_valid_v3(publication.canonical_state,publication.digest)
  OR NOT public.catalog_lifecycle_roster_valid_v3(publication.product_id,manifest)
  OR NOT public.catalog_lifecycle_roster_resolved_v3(publication.product_id,manifest)
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

CREATE FUNCTION public.catalog_renewal_ref_v3(p_value jsonb,p_nullable boolean DEFAULT false) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT coalesce((jsonb_typeof(p_value)='string' AND p_value<>'""'::jsonb)
  OR (p_nullable AND p_value='null'::jsonb),false)
$$;
REVOKE ALL ON FUNCTION public.catalog_renewal_ref_v3(jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_renewal_instant_v3(p_value jsonb,p_nonnegative boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE spelling text:=p_value#>>'{}'; instant timestamptz;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR spelling !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$' THEN RETURN false; END IF;
 instant:=spelling::timestamptz;
 RETURN to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=spelling
  AND (NOT p_nonnegative OR instant>='1970-01-01T00:00:00Z'::timestamptz);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_renewal_instant_v3(jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_frozen_wire_valid_v3(p_wire jsonb,p_fingerprint text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE cycle jsonb:=p_wire->'cycle'; template jsonb:=p_wire->'templateSnapshot'; pricing jsonb:=p_wire->'pricingSnapshot';
 orders jsonb:=p_wire->'orderSnapshot'; lines jsonb:=p_wire->'lines'; marker jsonb:=orders->'shippingQuoteRef';
 terms jsonb:=pricing->'shippingTerms'; acquisition jsonb:=pricing->'acquisition'; subtotal numeric; discount numeric; shipping numeric; wire text;
 format_uuid constant text := '^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
BEGIN
 IF NOT public.catalog_renewal_keys_v3(p_wire,ARRAY['contractVersion','frozenRevision','frozenFingerprint','catalogAcceptance','subscriptionId','clientId',
  'scheduledAt','cycleNumber','cycle','retryAttempt','externalAttemptSequence','templateSnapshot','pricingSnapshot','orderSnapshot',
  'lines','currency','totalAmountMinor','stockSourceKey','settlementChannelKey','authorizationRef','payerAccountRef','unattendedChargeAuthorizedAt'])
  OR p_wire->'contractVersion' IS DISTINCT FROM '"platform.subscription.renewal.v1"'::jsonb
  OR p_wire->'frozenRevision' IS DISTINCT FROM '"native.purchase-renewal.v3"'::jsonb
  OR p_wire->'frozenFingerprint' IS DISTINCT FROM to_jsonb(p_fingerprint)
  OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
  OR p_wire->>'subscriptionId' !~* format_uuid OR p_wire->>'clientId' !~* format_uuid
  OR jsonb_typeof(p_wire->'subscriptionId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_wire->'clientId') IS DISTINCT FROM 'string'
  OR NOT public.catalog_renewal_instant_v3(p_wire->'scheduledAt',true)
  OR NOT public.catalog_renewal_instant_v3(p_wire->'unattendedChargeAuthorizedAt')
  OR p_wire->'retryAttempt' IS DISTINCT FROM '0'::jsonb OR p_wire->'externalAttemptSequence' IS DISTINCT FROM '0'::jsonb
  OR NOT public.catalog_renewal_ref_v3(p_wire->'stockSourceKey') OR NOT public.catalog_renewal_ref_v3(p_wire->'settlementChannelKey')
  OR NOT public.catalog_renewal_ref_v3(p_wire->'authorizationRef') OR NOT public.catalog_renewal_ref_v3(p_wire->'payerAccountRef',true)
  OR NOT public.catalog_renewal_keys_v3(cycle,ARRAY['status','logicalCycleNumber','nativeRenewalCounter','activationCycleId','evidenceRef'])
  OR cycle->'status' IS DISTINCT FROM '"correlated"'::jsonb
  OR NOT public.catalog_renewal_integer_v3(cycle->'logicalCycleNumber',1)
  OR NOT public.catalog_renewal_integer_v3(cycle->'nativeRenewalCounter',1)
  OR jsonb_typeof(cycle->'activationCycleId') IS DISTINCT FROM 'string' OR cycle->>'activationCycleId' !~* format_uuid
  OR NOT public.catalog_renewal_ref_v3(cycle->'evidenceRef') OR p_wire->'cycleNumber' IS DISTINCT FROM cycle->'nativeRenewalCounter'
  OR NOT public.catalog_renewal_keys_v3(template,ARRAY['templateId','version','cadenceDays','lines'])
  OR NOT public.catalog_renewal_ref_v3(template->'templateId')
  OR NOT public.catalog_renewal_integer_v3(template->'version',1) OR NOT public.catalog_renewal_integer_v3(template->'cadenceDays',1)
  OR NOT public.catalog_renewal_keys_v3(orders,ARRAY['shippingAddressRef','shippingQuoteRef','acquisitionRef','lines'])
  OR NOT public.catalog_renewal_ref_v3(orders->'shippingAddressRef',true) OR NOT public.catalog_renewal_ref_v3(orders->'acquisitionRef',true)
  OR NOT public.catalog_renewal_lines_v3(lines) OR lines IS DISTINCT FROM template->'lines' OR lines IS DISTINCT FROM orders->'lines'
  OR NOT public.catalog_renewal_keys_v3(pricing,ARRAY['currency','totalAmountMinor','shippingAmountMinor','productSubtotalAmountMinor','discountAmountMinor','agreementPolicy','proration'],
   ARRAY['shippingTerms','linePricing','acquisition'])
  OR jsonb_typeof(pricing->'currency') IS DISTINCT FROM 'string' OR pricing->>'currency' !~ '^[A-Z]{3}$'
  OR pricing->'agreementPolicy' IS DISTINCT FROM '"lock_until_edit"'::jsonb OR pricing->'proration' IS DISTINCT FROM '"none"'::jsonb
  OR p_wire->'currency' IS DISTINCT FROM pricing->'currency' OR p_wire->'totalAmountMinor' IS DISTINCT FROM pricing->'totalAmountMinor'
  OR NOT public.catalog_renewal_integer_v3(pricing->'totalAmountMinor',1) OR NOT public.catalog_renewal_integer_v3(pricing->'shippingAmountMinor',0)
  OR NOT public.catalog_renewal_integer_v3(pricing->'productSubtotalAmountMinor',0) OR NOT public.catalog_renewal_integer_v3(pricing->'discountAmountMinor',0)
 THEN RETURN false; END IF;
 SELECT sum((l->>'quantity')::numeric*(l->>'unitAmountMinor')::numeric) INTO subtotal FROM jsonb_array_elements(lines) l;
 discount:=(pricing->>'discountAmountMinor')::numeric; shipping:=(pricing->>'shippingAmountMinor')::numeric;
 IF discount>subtotal OR subtotal<>(pricing->>'productSubtotalAmountMinor')::numeric
  OR subtotal-discount+shipping<>(pricing->>'totalAmountMinor')::numeric THEN RETURN false; END IF;
 IF terms IS NOT NULL THEN
  IF NOT public.catalog_renewal_keys_v3(terms,ARRAY['version','currency','flatMinor','freeThresholdMinor'])
   OR terms->'version' IS DISTINCT FROM '"shipping-threshold.v1"'::jsonb OR terms->'currency' IS DISTINCT FROM pricing->'currency'
   OR NOT public.catalog_renewal_integer_v3(terms->'flatMinor',0,2147483647)
   OR NOT public.catalog_renewal_integer_v3(terms->'freeThresholdMinor',0,2147483647) THEN RETURN false; END IF;
  IF shipping<>(CASE WHEN subtotal-discount<(terms->>'freeThresholdMinor')::numeric
    THEN (terms->>'flatMinor')::numeric ELSE 0 END) THEN RETURN false; END IF;
 END IF;
 IF terms IS NOT NULL OR shipping>0 THEN
  IF NOT public.catalog_renewal_keys_v3(marker,ARRAY['kind','shippingAmountMinor','terms'])
   OR marker->'kind' IS DISTINCT FROM '"retained_shipping"'::jsonb
   OR marker->'shippingAmountMinor' IS DISTINCT FROM pricing->'shippingAmountMinor'
   OR marker->'terms' IS DISTINCT FROM coalesce(terms,'null'::jsonb) THEN RETURN false; END IF;
 ELSIF NOT public.catalog_renewal_ref_v3(marker,true) AND marker IS DISTINCT FROM '{"kind":"zero_shipping","shippingAmountMinor":0}'::jsonb THEN RETURN false;
 END IF;
 IF acquisition IS NOT NULL AND (NOT public.catalog_renewal_keys_v3(acquisition,ARRAY['reasonCode','discountMinor','basisTemplateVersion'])
  OR acquisition->'reasonCode' IS DISTINCT FROM '"starter_pack_delivery_2"'::jsonb
  OR NOT public.catalog_renewal_integer_v3(acquisition->'discountMinor',0)
  OR NOT public.catalog_renewal_integer_v3(acquisition->'basisTemplateVersion',1)) THEN RETURN false; END IF;
 IF pricing ? 'linePricing' THEN
  IF jsonb_typeof(pricing->'linePricing') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(pricing->'linePricing') l
   WHERE NOT public.catalog_renewal_keys_v3(l,ARRAY['sku','quantity','unitAmountMinor','isAddon','quoteLine'])
    OR NOT public.catalog_renewal_ref_v3(l->'sku') OR NOT public.catalog_renewal_integer_v3(l->'quantity',1)
    OR NOT public.catalog_renewal_integer_v3(l->'unitAmountMinor',0) OR jsonb_typeof(l->'isAddon') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(l->'quoteLine') IS DISTINCT FROM 'object') THEN RETURN false; END IF;
 END IF;
 wire:=public.catalog_lifecycle_canonical_v3(p_wire-'frozenFingerprint',true,0);
 RETURN wire IS NOT NULL AND encode(sha256(convert_to(wire,'UTF8')),'hex')=p_fingerprint;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_frozen_wire_valid_v3(jsonb,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_acceptance_record_admit_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE codes text[]; basket jsonb;
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
  IF TG_TABLE_NAME='commerce_orders' THEN
   basket:=public.catalog_order_evidence_v2(NEW.id,NEW.metadata,NEW.catalog_acceptance,TG_OP='INSERT' OR NEW.total_amount_minor=0);
  ELSIF TG_TABLE_NAME='subscription_events' THEN
   basket:=public.catalog_edit_evidence_v2(NEW,TG_OP='INSERT')->'basket';
  ELSIF TG_TABLE_NAME='subscription_renewal_operations' THEN
   IF NEW.cycle_snapshot->>'frozenRevision' IS DISTINCT FROM 'native.purchase-renewal.v3' THEN
    RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023';
   END IF;
   codes:=public.catalog_frozen_basket_codes_v2(NEW.cycle_snapshot);
   IF codes IS NOT NULL THEN basket:=public.catalog_retained_basket_v2(NEW.cycle_snapshot->'lines'); END IF;
  END IF;
  IF (TG_TABLE_NAME='commerce_orders' AND basket IS NULL)
   OR (TG_TABLE_NAME IN ('subscription_events','subscription_renewal_operations')
    AND NOT public.catalog_acceptance_roster_valid_v2(NEW.catalog_acceptance,basket)) THEN
   RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023';
  END IF;
  IF TG_TABLE_NAME='subscription_renewal_operations' THEN
   IF NOT public.catalog_frozen_wire_valid_v3(NEW.cycle_snapshot,NEW.operation_fingerprint) THEN
    RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023';
   END IF;
   IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.subscription_lines l
    WHERE l.subscription_id=NEW.subscription_id AND l.catalog_sku_revision_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.catalog_acceptance->'lines') ref
      WHERE ref->'skuId'=to_jsonb(l.variant_id) AND ref->'skuRevisionId'=to_jsonb(l.catalog_sku_revision_id))) THEN
    RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023';
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
CREATE OR REPLACE FUNCTION public.commerce_order_assert_line_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order_id uuid;
  v_declared bigint;
  v_sum bigint;
  v_acceptance jsonb;
  v_metadata jsonb;
BEGIN
  -- Branching statements rather than one CASE expression on purpose: the procedural language
  -- compiles an expression into a single query, so every record field named in any arm must exist
  -- on every row type the trigger can see, and the two row types here differ.
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    v_order_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  SELECT total_amount_minor, metadata, catalog_acceptance INTO v_declared, v_metadata, v_acceptance
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

  -- The existing deferred owner sees the completed item ledger, even when
  -- the header and its items were written in separate statements.
  IF v_acceptance IS NOT NULL AND public.catalog_order_evidence_v2(v_order_id,v_metadata,v_acceptance,v_declared=0) IS NULL THEN
    RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023';
  END IF;
  IF TG_TABLE_NAME='commerce_order_items' AND TG_OP='UPDATE' THEN
    IF OLD.order_id IS DISTINCT FROM NEW.order_id THEN
      SELECT total_amount_minor, metadata, catalog_acceptance INTO v_declared, v_metadata, v_acceptance
      FROM public.commerce_orders WHERE id=OLD.order_id;
      IF v_acceptance IS NOT NULL AND public.catalog_order_evidence_v2(OLD.order_id,v_metadata,v_acceptance,v_declared=0) IS NULL THEN
        RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023';
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

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
