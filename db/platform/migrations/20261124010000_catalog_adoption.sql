-- Expand the publication source shape. Draft-backed rows keep their existing
-- reference and byte contracts. An adopted source has no draft or predecessor.
ALTER TABLE public.catalog_publications
 ADD COLUMN source_kind text NOT NULL DEFAULT 'draft',
 ALTER COLUMN draft_id DROP NOT NULL,
 ALTER COLUMN draft_revision DROP NOT NULL,
 ADD CONSTRAINT catalog_publications_source_kind_check CHECK (
  (source_kind='draft' AND draft_id IS NOT NULL AND draft_revision IS NOT NULL)
  OR (source_kind='adopted_existing' AND revision=1 AND previous_id IS NULL AND draft_id IS NULL AND draft_revision IS NULL)
 ) NOT VALID;
ALTER TABLE public.catalog_publications VALIDATE CONSTRAINT catalog_publications_source_kind_check;

CREATE TABLE public.catalog_legacy_obligation_bindings (
 publication_id uuid NOT NULL REFERENCES public.catalog_publications(id),
 sku_id uuid NOT NULL,
 sku_revision_id uuid NOT NULL,
 family text NOT NULL CHECK (family IN ('template','pending_activation','frozen_renewal','outstanding_order','replacement','stock_wait','graduation')),
 source_id uuid NOT NULL,
 subscription_id uuid,
 provenance text NOT NULL CHECK (provenance='legacy'),
 bound_at timestamptz NOT NULL,
 PRIMARY KEY (publication_id,sku_id,family,source_id),
 FOREIGN KEY (sku_id,sku_revision_id) REFERENCES public.catalog_sku_revisions(sku_id,id)
);
ALTER TABLE public.catalog_legacy_obligation_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_legacy_obligation_bindings FROM PUBLIC;
CREATE FUNCTION public.catalog_legacy_obligation_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'catalog_publication_record_immutable' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.catalog_publications p JOIN public.catalog_sku_revisions r ON r.publication_id=p.id
  WHERE p.id=NEW.publication_id AND p.source_kind='adopted_existing' AND p.committed_at=NEW.bound_at
   AND r.id=NEW.sku_revision_id AND r.sku_id=NEW.sku_id) THEN
  RAISE EXCEPTION 'catalog_adoption_binding_invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_legacy_obligation_binding_guard() FROM PUBLIC;
CREATE TRIGGER catalog_legacy_obligation_bindings_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.catalog_legacy_obligation_bindings FOR EACH ROW EXECUTE FUNCTION public.catalog_legacy_obligation_binding_guard();

-- Keep the established guard on catalogue callers. Initial adoption invokes
-- the same census only after resolving the existing SKU identity itself.
CREATE FUNCTION public.catalog_collect_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; obligations jsonb := '[]'; item record; lines jsonb; line jsonb;
 marker jsonb; basis integer; matching boolean; unknown boolean := false; source_subscription uuid;
BEGIN
 SELECT * INTO sku FROM public.catalog_skus WHERE id=p_sku_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 -- Filtered evidence is not proof of absence. No browser/service role is granted this routine.
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[
  'public.subscriptions'::regclass,'public.subscription_lines'::regclass,'public.subscription_renewal_term_lines'::regclass,
  'public.subscription_activations'::regclass,'public.subscription_renewal_attachments'::regclass,'public.subscription_renewal_operations'::regclass,
  'public.subscription_cycles'::regclass,'public.commerce_orders'::regclass,'public.commerce_order_items'::regclass,
  'public.fulfillment_shipments'::regclass,'public.fulfillment_parcel_lines'::regclass,'public.subscription_stock_wait_cases'::regclass,
  'public.subscription_successor_operations_v2'::regclass,'public.subscription_successor_wait_cases_v2'::regclass,
  'public.subscription_events'::regclass,'public.subscription_edit_quotes'::regclass,'public.subscription_quote_previews'::regclass]) AND (row_security_active(c.oid) OR NOT pg_has_role(current_user,c.relowner,'USAGE'))) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unavailable','reason','catalog_obligation_evidence_unavailable');
 END IF;
 FOR item IN
  SELECT DISTINCT s.id,sl.catalog_sku_revision_id AS revision FROM public.subscriptions s JOIN public.subscription_lines sl ON sl.subscription_id=s.id
   WHERE s.status IN ('active','paused') AND sl.variant_id=sku.id
  UNION
  SELECT s.id,NULL::uuid FROM public.subscriptions s JOIN public.subscription_renewal_term_lines tl ON tl.subscription_id=s.id
   WHERE s.status IN ('active','paused') AND tl.sku=sku.sku
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','template','sourceId',item.id,'subscriptionId',item.id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',item.revision));
 END LOOP;
 FOR item IN
  SELECT a.order_id AS id,a.subscription_id FROM public.subscription_activations a
   LEFT JOIN public.subscription_renewal_attachments attachment ON attachment.order_id=a.order_id
   WHERE a.state<>'compensated' AND (a.state<>'active' OR attachment.completed_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=a.order_id AND i.sku_id=sku.id)
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','pending_activation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.subscription_activations a LEFT JOIN public.subscription_renewal_attachments attachment ON attachment.order_id=a.order_id
  WHERE a.state<>'compensated' AND (a.state<>'active' OR attachment.completed_at IS NULL)
   AND (NOT EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=a.order_id) OR EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=a.order_id AND i.sku_id IS NULL))) THEN unknown:=true; END IF;
 FOR item IN
  SELECT op.id,op.subscription_id,op.cycle_snapshot FROM public.subscription_renewal_operations op
   WHERE op.state NOT IN ('succeeded','refused') OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.renewal_operation_id=op.id AND c.status IN ('planned','payment_pending'))
  UNION ALL
  SELECT g.id,g.subscription_id,g.cycle_snapshot FROM public.subscription_successor_operations_v2 g
   WHERE g.superseded_by_proposal_id IS NULL AND (g.state NOT IN ('succeeded','refused') OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.id=g.cycle_id AND c.status IN ('planned','payment_pending')))
 LOOP
  lines:=item.cycle_snapshot->'lines';
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN unknown:=true; CONTINUE; END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(coalesce(line->'sku',line->'skuCode')) IS DISTINCT FROM 'string' OR coalesce(line->>'quantity',line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF coalesce(line->>'sku',line->>'skuCode')=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array(jsonb_build_object('family','frozen_renewal','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items i JOIN public.commerce_orders o ON o.id=i.order_id WHERE o.status IN ('paid','fulfillment_pending','fulfilled') AND i.sku_id IS NULL) THEN unknown:=true; END IF;
 FOR item IN
  SELECT DISTINCT o.id,c.subscription_id FROM public.commerce_orders o
   LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   JOIN public.commerce_order_items i ON i.order_id=o.id
   WHERE o.status IN ('paid','fulfillment_pending','fulfilled') AND i.sku_id=sku.id
    AND (NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments parcel WHERE parcel.order_id=o.id)
     OR EXISTS(SELECT 1 FROM public.fulfillment_shipments parcel WHERE parcel.order_id=o.id AND parcel.delivered_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id=parcel.id)))
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','outstanding_order','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 FOR item IN
  SELECT DISTINCT parcel.id,c.subscription_id FROM public.fulfillment_shipments parcel
   JOIN public.fulfillment_parcel_lines l ON l.shipment_id=parcel.id
   JOIN public.commerce_orders o ON o.id=parcel.order_id LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
   WHERE parcel.replaces_shipment_id IS NOT NULL AND parcel.delivered_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id=parcel.id)
    AND (l.sku_id=sku.id OR l.sku=sku.sku)
 LOOP
  obligations:=obligations||jsonb_build_array(jsonb_build_object('family','replacement','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.fulfillment_shipments p WHERE p.replaces_shipment_id IS NOT NULL AND p.delivered_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments next WHERE next.replaces_shipment_id=p.id)
  AND (NOT EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines l WHERE l.shipment_id=p.id)
   OR EXISTS(SELECT 1 FROM public.fulfillment_parcel_lines l WHERE l.shipment_id=p.id AND l.sku_id IS NULL AND nullif(l.sku,'') IS NULL))) THEN unknown:=true; END IF;
 FOR item IN SELECT id,subscription_id,cycle_snapshot,false AS successor FROM public.subscription_stock_wait_cases WHERE state IN ('waiting','stock_secured') OR (state='resumed' AND order_id IS NULL)
  UNION ALL SELECT id,subscription_id,cycle_snapshot,true FROM public.subscription_successor_wait_cases_v2 WHERE superseded_by_proposal_id IS NULL AND (state IN ('waiting','stock_secured') OR (state='resumed' AND order_id IS NULL))
 LOOP
  lines:=item.cycle_snapshot->'lines';
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN unknown:=true; CONTINUE; END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(coalesce(line->'sku',line->'skuCode')) IS DISTINCT FROM 'string' OR coalesce(line->>'quantity',line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF coalesce(line->>'sku',line->>'skuCode')=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array((jsonb_build_object('family','stock_wait','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)||CASE WHEN item.successor THEN jsonb_build_object('caseKind','successor') ELSE '{}'::jsonb END)); END IF;
 END LOOP;
 FOR item IN SELECT a.order_id AS id,a.subscription_id,a.purchase_facts,s.template_version FROM public.subscription_renewal_attachments a
  JOIN public.subscriptions s ON s.id=a.subscription_id WHERE s.status IN ('active','paused') AND a.purchase_facts#>'{renewalTerms,starterPack}' IS NOT NULL
 LOOP
  marker:=item.purchase_facts#>'{renewalTerms,starterPack}'; lines:=marker#>'{graduation,lines}';
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0
   OR coalesce(marker->>'basisTemplateVersion','') !~ '^[1-9][0-9]{0,8}$' THEN unknown:=true; CONTINUE; END IF;
  basis:=(marker->>'basisTemplateVersion')::integer;
  IF basis<>item.template_version THEN
   -- Only an accepted event explicitly consuming this exact retained basis proves discharge.
   IF EXISTS(SELECT 1 FROM public.subscription_events e WHERE e.subscription_id=item.subscription_id
    AND e.payload->'templateVersion'=to_jsonb(item.template_version)
    AND ((EXISTS(SELECT 1 FROM public.subscription_edit_quotes q WHERE q.accepted_event_id=e.id AND q.subscription_id=item.subscription_id AND q.status='accepted' AND q.expected_template_version=basis))
      OR (EXISTS(SELECT 1 FROM public.subscription_quote_previews q WHERE q.accepted_event_id=e.id AND q.subscription_id=item.subscription_id AND q.status='accepted' AND q.template_version=basis)))) THEN CONTINUE; END IF;
   unknown:=true; CONTINUE;
  END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(line->'sku') IS DISTINCT FROM 'string' OR coalesce(line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF line->>'sku'=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array(jsonb_build_object('family','graduation','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)); END IF;
 END LOOP;
 IF unknown THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 RETURN jsonb_build_object('schemaVersion',2,'outcome','complete','obligations',obligations);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_collect_bound_obligations_v2(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.catalog_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=p_sku_id
    AND publication_facts->'schemaVersion'='3'::jsonb AND publication_facts->>'code'=sku) THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown');
 END IF;
 -- Callers with a restricted census grant retain the established typed refusal.
 IF NOT has_function_privilege('public.catalog_collect_bound_obligations_v2(uuid)','EXECUTE') THEN
  RETURN jsonb_build_object('schemaVersion',2,'outcome','unavailable','reason','catalog_obligation_evidence_unavailable');
 END IF;
 RETURN public.catalog_collect_bound_obligations_v2(p_sku_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_record_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE canonical text; expected text; body jsonb; pair jsonb; sku_ids jsonb; successor uuid; prior_successor uuid;
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
  IF (CASE WHEN NEW.source_kind='adopted_existing' THEN body->'schemaVersion' IS DISTINCT FROM '5'::jsonb
    ELSE body->'schemaVersion' IS NULL OR body->'schemaVersion' NOT IN ('2'::jsonb,'3'::jsonb,'4'::jsonb) END)
   OR body->'product'->>'id' IS DISTINCT FROM NEW.product_id::text
   OR jsonb_typeof(body->'skus') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
  END IF;
  IF body->'schemaVersion'='4'::jsonb THEN
   IF jsonb_typeof(body->'successors') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514'; END IF;
   IF jsonb_array_length(body->'successors') NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514'; END IF;
   SELECT coalesce(jsonb_object_agg(sku->>'skuId',true),'{}'::jsonb) INTO sku_ids
    FROM jsonb_array_elements(body->'skus') sku WHERE jsonb_typeof(sku->'skuId')='string';
   FOR pair IN SELECT value FROM jsonb_array_elements(body->'successors') LOOP
    IF jsonb_typeof(pair) IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514'; END IF;
    IF pair-ARRAY['successorSkuId','successorOf']<>'{}'::jsonb
     OR coalesce(pair->>'successorSkuId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(pair->>'successorOf','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR pair->>'successorSkuId'=pair->>'successorOf'
     OR NOT (sku_ids ? (pair->>'successorSkuId')) THEN
     RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514'; END IF;
    successor:=(pair->>'successorSkuId')::uuid;
    IF prior_successor>=successor THEN RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514'; END IF;
    prior_successor:=successor;
   END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  IF body->>'id' IS DISTINCT FROM NEW.sku_id::text OR body->>'productId' IS DISTINCT FROM NEW.product_id::text THEN
   RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

-- The same verified observation is sealed during preflight and rebuilt during
-- commit. This helper is private to the adoption authority.
CREATE FUNCTION public.catalog_adoption_observe(p_product_id uuid,p_document_text text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 product public.catalog_products%ROWTYPE;
 document public.catalog_product_document_revisions%ROWTYPE;
 sku public.catalog_skus%ROWTYPE;
 definition_digest text;
 definition_shape jsonb;
 canonical text;
 skus jsonb := '[]';
 obligations jsonb := '[]';
 observed jsonb;
 prices jsonb;
BEGIN
 SELECT * INTO product FROM public.catalog_products WHERE id=p_product_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_adoption_scope_absent' USING ERRCODE='22023'; END IF;
 SELECT installed.definition_digest,installed.definition INTO definition_digest,definition_shape FROM public.catalog_type_versions installed
 WHERE installed.type_key=product.type_key AND installed.version=product.type_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_adoption_type_unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO document FROM public.catalog_product_document_revisions WHERE product_id=product.id AND id=product.current_document_revision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_adoption_document_unavailable' USING ERRCODE='55000'; END IF;
 canonical := coalesce(document.canonical_text,p_document_text);
 IF canonical IS NULL OR octet_length(canonical)>2097152 THEN
  RAISE EXCEPTION 'catalog_adoption_document_unavailable' USING ERRCODE='55000';
 END IF;
 IF encode(sha256(convert_to(canonical,'UTF8')),'hex') IS DISTINCT FROM document.digest THEN
  RAISE EXCEPTION 'catalog_adoption_document_digest_mismatch' USING ERRCODE='22023';
 END IF;
 BEGIN
  IF canonical::jsonb IS DISTINCT FROM document.document_payload OR jsonb_typeof(document.document_payload) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'catalog_adoption_document_shape_invalid' USING ERRCODE='22023';
  END IF;
 EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'catalog_adoption_document_shape_invalid' USING ERRCODE='22023';
 END;
 IF NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE product_id=product.id AND id=product.primary_sku_id AND status<>'archived') THEN
  RAISE EXCEPTION 'catalog_adoption_identity_conflict' USING ERRCODE='23505';
 END IF;
 IF (SELECT count(*) FROM public.catalog_skus WHERE product_id=product.id)>10000 THEN
  RAISE EXCEPTION 'catalog_adoption_facts_invalid' USING ERRCODE='22023';
 END IF;

 FOR sku IN SELECT * FROM public.catalog_skus WHERE product_id=product.id ORDER BY id LOOP
  IF sku.net_content_unit IS NULL OR sku.net_content_unscaled IS NULL OR NOT
   coalesce(definition_shape->'netContentUnits' ? sku.net_content_unit,false)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(definition_shape->'units') unit
     WHERE unit->>'code'=sku.net_content_unit AND unit->>'dimension'=sku.net_content_dimension) THEN
   RAISE EXCEPTION 'catalog_adoption_facts_invalid' USING ERRCODE='22023';
  END IF;
  IF (sku.sellable_standalone OR sku.sellable_in_subscription) AND NOT EXISTS(
   SELECT 1 FROM public.catalog_sku_identifiers identifier
   WHERE identifier.catalog_sku_id=sku.id AND identifier.identifier_kind='gtin' AND identifier.is_primary AND identifier.pack_kind='unit'
  ) THEN
   RAISE EXCEPTION 'catalog_adoption_identifier_unavailable' USING ERRCODE='55000';
  END IF;
  observed := public.catalog_collect_bound_obligations_v2(sku.id);
  IF observed->>'outcome' IS DISTINCT FROM 'complete' OR jsonb_typeof(observed->'obligations') IS DISTINCT FROM 'array'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(observed->'obligations') evidence WHERE evidence->>'skuRevisionId' IS NOT NULL) THEN
   RAISE EXCEPTION 'catalog_adoption_unbound_obligation' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_sku_identifiers identifier
   WHERE identifier.catalog_sku_id=sku.id AND identifier.identifier_kind='gtin'
   AND CASE WHEN identifier.normalized_value ~ '^([0-9]{8}|[0-9]{12,14})$'
    THEN (SELECT sum(substr(lpad(identifier.normalized_value,14,'0'),position,1)::integer
       * CASE WHEN position%2=1 THEN 3 ELSE 1 END) FROM generate_series(1,14) position)%10<>0 ELSE true END) THEN
   RAISE EXCEPTION 'catalog_adoption_identity_conflict' USING ERRCODE='23505';
  END IF;
  obligations := obligations || (observed->'obligations');
  skus := skus || jsonb_build_array(jsonb_build_object('id',sku.id,'productId',product.id,'code',sku.sku,
   'facts',to_jsonb(sku) || jsonb_build_object('net_content_unscaled',sku.net_content_unscaled::text,'gross_mass_unscaled',sku.gross_mass_unscaled::text,
    'created_at',sku.created_at AT TIME ZONE 'UTC','updated_at',sku.updated_at AT TIME ZONE 'UTC'),
   'identifiers',coalesce((SELECT jsonb_agg((to_jsonb(identifier) || jsonb_build_object('created_at',identifier.created_at AT TIME ZONE 'UTC')) ORDER BY identifier.id)
    FROM public.catalog_sku_identifiers identifier WHERE identifier.catalog_sku_id=sku.id),'[]'::jsonb)));
 END LOOP;
 -- The pricing authority resolves separate lists, modes and quantity tiers
 -- separately. Only duplicate intervals within one existing lane are ambiguous.
 IF EXISTS(
  SELECT 1 FROM public.price_entries first_entry
  JOIN public.catalog_skus s ON s.id=first_entry.variant_id
  JOIN public.price_entries second_entry ON (second_entry.price_list_id,second_entry.variant_id,second_entry.mode,second_entry.min_qty)=
   (first_entry.price_list_id,first_entry.variant_id,first_entry.mode,first_entry.min_qty) AND second_entry.id>first_entry.id
  WHERE s.product_id=product.id AND first_entry.active AND second_entry.active
   AND tstzrange(first_entry.valid_from,first_entry.valid_to,'[)') && tstzrange(second_entry.valid_from,second_entry.valid_to,'[)')
 ) THEN RAISE EXCEPTION 'catalog_adoption_price_overlap' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'list',to_jsonb(list) || jsonb_build_object('created_at',list.created_at AT TIME ZONE 'UTC','updated_at',list.updated_at AT TIME ZONE 'UTC',
   'valid_from',list.valid_from AT TIME ZONE 'UTC','valid_to',list.valid_to AT TIME ZONE 'UTC'),
  'price',to_jsonb(entry) || jsonb_build_object('created_at',entry.created_at AT TIME ZONE 'UTC','updated_at',entry.updated_at AT TIME ZONE 'UTC',
   'valid_from',entry.valid_from AT TIME ZONE 'UTC','valid_to',entry.valid_to AT TIME ZONE 'UTC')) ORDER BY entry.id),'[]'::jsonb) INTO prices
 FROM public.price_entries entry JOIN public.price_lists list ON list.id=entry.price_list_id
 JOIN public.catalog_skus s ON s.id=entry.variant_id WHERE s.product_id=product.id;
 RETURN jsonb_build_object('product',to_jsonb(product) || jsonb_build_object(
   'created_at',product.created_at AT TIME ZONE 'UTC','updated_at',product.updated_at AT TIME ZONE 'UTC'),
  'definitionDigest',definition_digest,'document',
  to_jsonb(document) || jsonb_build_object('canonical_text',canonical,'created_at',document.created_at AT TIME ZONE 'UTC'),
  'skus',skus,'prices',prices,'obligations',
  (SELECT coalesce(jsonb_agg(DISTINCT value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements(obligations)));
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_adoption_observe(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_adoption_assert_initial(p_product_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.catalog_publication_heads WHERE product_id=p_product_id) THEN
  RAISE EXCEPTION 'catalog_adoption_already_published' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM public.catalog_publications WHERE product_id=p_product_id)
  OR EXISTS(SELECT 1 FROM public.catalog_sku_revisions WHERE product_id=p_product_id) THEN
  RAISE EXCEPTION 'catalog_adoption_lineage_invalid' USING ERRCODE='55000';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_adoption_assert_initial(uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_adoption_preflight(p_product_id uuid,p_document_text text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE evidence jsonb; actor uuid;
BEGIN
 IF p_product_id IS NULL THEN RAISE EXCEPTION 'catalog_adoption_command_invalid' USING ERRCODE='22023'; END IF;
 actor := public.catalog_price_setup_require_human_admin();
 PERFORM public.catalog_adoption_assert_initial(p_product_id);
 evidence := public.catalog_adoption_observe(p_product_id,p_document_text);
 RETURN jsonb_build_object('schemaVersion',1,'productId',p_product_id,'actorId',actor,'sourceDigest',
  encode(sha256(convert_to(evidence::text,'UTF8')),'hex'),'evidence',evidence);
END;
$$;

CREATE FUNCTION public.catalog_adoption_receipt(p_product_id uuid,p_command_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; receipt record;
BEGIN
 actor := public.catalog_price_setup_require_human_admin();
 SELECT r.*, p.digest, p.source_kind, p.candidate_digest, p.revision,d.digest AS document_digest,p.committed_at INTO receipt
 FROM public.catalog_operator_receipts r
 JOIN public.catalog_publications p ON p.id=r.publication_id AND p.product_id=r.scope_id
 JOIN public.catalog_product_document_revisions d ON d.id=p.document_revision_id AND d.product_id=p.product_id
 WHERE r.kind='adoption' AND r.scope_id=p_product_id AND r.command_key=p_command_key;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF receipt.actor_id<>actor THEN RAISE EXCEPTION 'catalog_adoption_operator_mismatch' USING ERRCODE='42501'; END IF;
 IF receipt.source_kind<>'adopted_existing' OR receipt.revision<>1
  OR receipt.result->>'productId' IS DISTINCT FROM p_product_id::text
  OR receipt.result->>'commandKey' IS DISTINCT FROM p_command_key
  OR receipt.result->>'actorId' IS DISTINCT FROM actor::text
  OR receipt.result->>'fingerprint' IS DISTINCT FROM receipt.fingerprint
  OR receipt.result->>'sourceDigest' IS DISTINCT FROM receipt.candidate_digest
  OR receipt.result->>'publicationDigest' IS DISTINCT FROM receipt.digest
  OR receipt.result->'head' IS DISTINCT FROM jsonb_build_object('publicationId',receipt.publication_id,'revision',receipt.revision,'documentDigest',receipt.document_digest)
  OR receipt.result->>'committedAt' IS DISTINCT FROM to_char(receipt.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') THEN
  RAISE EXCEPTION 'catalog_adoption_receipt_invalid' USING ERRCODE='23514';
 END IF;
 RETURN receipt.result;
END;
$$;

CREATE FUNCTION public.catalog_adopt_existing(p_product_id uuid,p_source_digest text,p_command_key text,p_document_text text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 actor uuid;
 fingerprint text;
 existing public.catalog_operator_receipts%ROWTYPE;
 evidence jsonb;
 item jsonb;
 binding jsonb;
 refs jsonb := '[]';
 bindings jsonb;
 publication_id uuid := gen_random_uuid();
 revision_id uuid;
 state jsonb;
 state_digest text;
 sku_digest text;
 document_id uuid;
 committed timestamptz := clock_timestamp();
 receipt jsonb;
BEGIN
 IF p_product_id IS NULL OR p_source_digest IS NULL OR p_source_digest !~ '^[0-9a-f]{64}$'
  OR p_command_key IS NULL OR char_length(p_command_key) NOT BETWEEN 1 AND 240 OR btrim(p_command_key)<>p_command_key THEN
  RAISE EXCEPTION 'catalog_adoption_command_invalid' USING ERRCODE='22023';
 END IF;
 actor := public.catalog_price_setup_require_human_admin();
 fingerprint := encode(sha256(convert_to(jsonb_build_array('adopted_existing',p_product_id,p_source_digest,p_command_key,actor)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-adoption-decision:'||p_product_id::text||':'||p_source_digest,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-command:'||p_product_id::text||':'||p_command_key,0));
 SELECT * INTO existing FROM public.catalog_operator_receipts r WHERE r.scope_id=p_product_id AND r.command_key=p_command_key;
 IF FOUND THEN
  IF existing.kind<>'adoption' OR existing.fingerprint<>fingerprint THEN
   RAISE EXCEPTION 'catalog_adoption_command_key_reused' USING ERRCODE='23505';
  END IF;
  RETURN jsonb_build_object('outcome','replayed','receipt',public.catalog_adoption_receipt(p_product_id,p_command_key));
 END IF;
 -- The publication guard also coordinates governed commerce readers. Existing
 -- pre-publication application writers cannot edit the source during the seal.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'catalog_adoption_isolation_invalid' USING ERRCODE='25001';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('catalog-publication-global',0)) THEN
  RAISE EXCEPTION 'catalog_adoption_busy' USING ERRCODE='55P03';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-lineage:'||p_product_id::text,0));
 BEGIN
  LOCK TABLE public.catalog_products,public.catalog_skus,public.catalog_sku_identifiers,public.catalog_product_document_revisions,
   public.price_lists,public.price_entries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'catalog_adoption_busy' USING ERRCODE='55P03';
 END;
 PERFORM public.catalog_adoption_assert_initial(p_product_id);
 evidence := public.catalog_adoption_observe(p_product_id,p_document_text);
 IF encode(sha256(convert_to(evidence::text,'UTF8')),'hex') IS DISTINCT FROM p_source_digest THEN
  RAISE EXCEPTION 'catalog_adoption_source_changed' USING ERRCODE='40001';
 END IF;

 document_id := (evidence->'document'->>'id')::uuid;
 FOR item IN SELECT value FROM jsonb_array_elements(evidence->'skus') LOOP
  refs := refs || jsonb_build_array(jsonb_build_object('skuId',item->>'id','revisionId',gen_random_uuid(),'revision',1,
   'digest',encode(sha256(convert_to(item::text,'UTF8')),'hex')));
 END LOOP;
 state := jsonb_build_object('schemaVersion',5,'sourceKind','adopted_existing','sourceDigest',p_source_digest,
  'product',evidence->'product','document',evidence->'document','definitionDigest',evidence->>'definitionDigest','skus',refs);
 state_digest := encode(sha256(convert_to(state::text,'UTF8')),'hex');
 INSERT INTO public.catalog_publications(id,product_id,revision,source_kind,candidate_ref,candidate_digest,document_revision_id,canonical_state,digest,actor_id,committed_at)
 VALUES(publication_id,p_product_id,1,'adopted_existing','adoption:'||p_product_id::text||':'||p_source_digest,p_source_digest,document_id,state::text,state_digest,actor,committed);
 FOR item IN SELECT value FROM jsonb_array_elements(evidence->'skus') LOOP
  SELECT (ref->>'revisionId')::uuid,ref->>'digest' INTO STRICT revision_id,sku_digest FROM jsonb_array_elements(refs) ref WHERE ref->>'skuId'=item->>'id';
  INSERT INTO public.catalog_sku_revisions(id,sku_id,product_id,revision,publication_id,full_facts,digest)
  VALUES(revision_id,(item->>'id')::uuid,p_product_id,1,publication_id,item::text,sku_digest);
 END LOOP;
 bindings := evidence->'obligations';
 FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
  SELECT (ref->>'revisionId')::uuid INTO STRICT revision_id FROM jsonb_array_elements(refs) ref WHERE ref->>'skuId'=binding->>'skuId';
  INSERT INTO public.catalog_legacy_obligation_bindings(publication_id,sku_id,sku_revision_id,family,source_id,subscription_id,provenance,bound_at)
  VALUES(publication_id,(binding->>'skuId')::uuid,revision_id,binding->>'family',(binding->>'sourceId')::uuid,(binding->>'subscriptionId')::uuid,'legacy',committed);
 END LOOP;

 INSERT INTO public.catalog_publication_heads(product_id,publication_id,revision) VALUES(p_product_id,publication_id,1);
 receipt := jsonb_build_object('schemaVersion',1,'kind','adoption','sourceKind','adopted_existing','productId',p_product_id,
  'commandKey',p_command_key,'fingerprint',fingerprint,'actorId',actor,'sourceDigest',p_source_digest,'publicationDigest',state_digest,
  'previousHead',NULL,'head',jsonb_build_object('publicationId',publication_id,'revision',1,'documentDigest',evidence->'document'->>'digest'),
  'committedAt',to_char(committed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'skuCount',jsonb_array_length(refs),'legacyBindingCount',jsonb_array_length(bindings));
 INSERT INTO public.catalog_operator_receipts(kind,scope_id,command_key,fingerprint,actor_id,publication_id,result)
 VALUES('adoption',p_product_id,p_command_key,fingerprint,actor,publication_id,receipt);
 RETURN jsonb_build_object('outcome','committed','receipt',receipt);
END;
$$;

-- Native operator grants are explicit. Installation alone grants no capability.
REVOKE ALL ON FUNCTION public.catalog_adoption_preflight(uuid,text), public.catalog_adoption_receipt(uuid,text),
 public.catalog_adopt_existing(uuid,text,text,text) FROM PUBLIC;

-- Restricted readback for current and retained adoption evidence. The
-- current-head check contrasts with retained reads after later publications.
CREATE FUNCTION public.catalog_adoption_read(p_product_id uuid,p_sku_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 publication public.catalog_publications%ROWTYPE;
 sku public.catalog_sku_revisions%ROWTYPE;
 state jsonb;
 reference jsonb;
 current_id uuid;
BEGIN
 IF p_product_id IS NULL THEN RAISE EXCEPTION 'catalog_adoption_command_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO publication FROM public.catalog_publications WHERE product_id=p_product_id AND revision=1 AND source_kind='adopted_existing';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT publication_id INTO current_id FROM public.catalog_publication_heads WHERE product_id=p_product_id;
 IF current_id IS NULL THEN RAISE EXCEPTION 'catalog_adoption_lineage_invalid' USING ERRCODE='55000'; END IF;
 IF encode(sha256(convert_to(publication.canonical_state,'UTF8')),'hex') IS DISTINCT FROM publication.digest THEN
  RAISE EXCEPTION 'catalog_adoption_lineage_invalid' USING ERRCODE='55000';
 END IF;
 state := publication.canonical_state::jsonb;
 IF p_sku_id IS NOT NULL THEN
  SELECT item INTO reference FROM jsonb_array_elements(state->'skus') item WHERE item->>'skuId'=p_sku_id::text;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO sku FROM public.catalog_sku_revisions WHERE product_id=p_product_id AND sku_id=p_sku_id
   AND id=(reference->>'revisionId')::uuid AND revision=1 AND publication_id=publication.id;
  IF NOT FOUND OR sku.digest IS DISTINCT FROM reference->>'digest'
   OR encode(sha256(convert_to(sku.full_facts,'UTF8')),'hex') IS DISTINCT FROM sku.digest THEN
   RAISE EXCEPTION 'catalog_adoption_lineage_invalid' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN jsonb_build_object('schemaVersion',1,'kind','adopted_existing','productId',p_product_id,
  'head',jsonb_build_object('publicationId',publication.id,'revision',1,'documentDigest',state->'document'->>'digest'),
  'current',current_id=publication.id,'sourceDigest',publication.candidate_digest,
  'publicationDigest',publication.digest,'canonicalState',publication.canonical_state,'skuReference',reference,'skuFacts',sku.full_facts);
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_adoption_read(uuid,uuid) FROM PUBLIC;
