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

-- A nullable legacy revision never erases a known identity. This is one unpaginated
-- query for archive and impact. It takes no commerce row or advisory locks.
CREATE FUNCTION public.catalog_bound_obligations_v2(p_sku_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; obligations jsonb := '[]'; item record; lines jsonb; line jsonb;
 marker jsonb; basis integer; matching boolean; unknown boolean := false; source_subscription uuid;
BEGIN
 SELECT * INTO sku FROM public.catalog_skus WHERE id=p_sku_id;
 IF NOT FOUND OR sku.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR sku.publication_facts->>'code' IS DISTINCT FROM sku.sku THEN RETURN jsonb_build_object('schemaVersion',2,'outcome','unknown','reason','catalog_obligation_evidence_unknown'); END IF;
 -- Filtered evidence is not proof of absence. No browser/service role is granted this routine.
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[
  'public.subscriptions'::regclass,'public.subscription_lines'::regclass,'public.subscription_renewal_term_lines'::regclass,
  'public.subscription_activations'::regclass,'public.subscription_renewal_attachments'::regclass,'public.subscription_renewal_operations'::regclass,
  'public.subscription_cycles'::regclass,'public.commerce_orders'::regclass,'public.commerce_order_items'::regclass,
  'public.fulfillment_shipments'::regclass,'public.fulfillment_parcel_lines'::regclass,'public.subscription_stock_wait_cases'::regclass,
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
 FOR item IN SELECT id,subscription_id,cycle_snapshot FROM public.subscription_stock_wait_cases WHERE state IN ('waiting','stock_secured') OR (state='resumed' AND order_id IS NULL)
 LOOP
  lines:=item.cycle_snapshot->'lines';
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN unknown:=true; CONTINUE; END IF;
  matching:=false;
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR jsonb_typeof(coalesce(line->'sku',line->'skuCode')) IS DISTINCT FROM 'string' OR coalesce(line->>'quantity',line->>'qty','') !~ '^[1-9][0-9]*$' THEN unknown:=true;
   ELSIF coalesce(line->>'sku',line->>'skuCode')=sku.sku THEN matching:=true; END IF;
  END LOOP;
  IF matching THEN obligations:=obligations||jsonb_build_array(jsonb_build_object('family','stock_wait','sourceId',item.id,'subscriptionId',item.subscription_id,'skuId',sku.id,'skuCode',sku.sku,'skuRevisionId',NULL)); END IF;
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
REVOKE ALL ON FUNCTION public.catalog_bound_obligations_v2(uuid) FROM PUBLIC;

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
        IF EXISTS (SELECT FROM jsonb_object_keys(s) k WHERE k NOT IN ('id','productId','code','options','netContent','identifiers','assetRefs','grossMass','logisticsRef','attributes','priceOperations'))
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
   OR jsonb_typeof(body->'skus') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_publication_state_invalid' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'catalog_sku_revisions' THEN
  IF body->>'id' IS DISTINCT FROM NEW.sku_id::text OR body->>'productId' IS DISTINCT FROM NEW.product_id::text THEN
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
 manifest jsonb; facts jsonb; reference jsonb; document_digest text;
BEGIN
 IF jsonb_typeof(p_reference) IS DISTINCT FROM 'object' OR p_reference->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR NOT (p_reference ?& ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent'])
  OR p_reference - ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent','demandPolicyRef'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO publication FROM public.catalog_publications WHERE id=(p_reference#>>'{publicationHead,publicationId}')::uuid;
 SELECT * INTO revision FROM public.catalog_sku_revisions WHERE id=(p_reference->>'skuRevisionId')::uuid AND sku_id=(p_reference->>'skuId')::uuid;
 IF publication.id IS NULL OR revision.id IS NULL OR publication.product_id<>revision.product_id THEN
  RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
 manifest:=publication.canonical_state::jsonb; facts:=revision.full_facts::jsonb;
 SELECT digest INTO document_digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id AND product_id=publication.product_id;
 IF encode(sha256(convert_to(publication.canonical_state,'UTF8')),'hex')<>publication.digest
  OR encode(sha256(convert_to(revision.full_facts,'UTF8')),'hex')<>revision.digest
  OR manifest->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR p_reference->'publicationHead' IS DISTINCT FROM jsonb_build_object('publicationId',publication.id,'revision',publication.revision,'documentDigest',document_digest)
  OR facts->>'id' IS DISTINCT FROM p_reference->>'skuId' OR facts->>'code' IS DISTINCT FROM p_reference->>'skuCode'
  OR manifest->'product'->'type' IS DISTINCT FROM p_reference->'typeRef'
  OR manifest->'product'->'definitionDigest' IS DISTINCT FROM p_reference->'definitionDigest'
  OR facts->'optionDigest' IS DISTINCT FROM p_reference->'optionDigest' OR facts->'netContent' IS DISTINCT FROM p_reference->'netContent'
  OR (p_reference ? 'demandPolicyRef' AND facts->'demandPolicyRef' IS DISTINCT FROM p_reference->'demandPolicyRef')
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
  OR octet_length(CAST(p_acceptance AS text))>1048576 OR jsonb_array_length(p_acceptance->'lines') NOT BETWEEN 1 AND 100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_acceptance->'lines') l GROUP BY l->>'skuId' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'catalog_acceptance_invalid' USING ERRCODE='22023'; END IF;
 FOR reference IN SELECT value FROM jsonb_array_elements(p_acceptance->'lines') LOOP PERFORM public.catalog_accepted_reference_assert_v2(reference); END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_acceptance_assert_v2(jsonb) FROM PUBLIC;
CREATE FUNCTION public.catalog_acceptance_record_admit_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
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
 IF NEW.catalog_acceptance IS NOT NULL THEN PERFORM public.catalog_acceptance_assert_v2(NEW.catalog_acceptance); END IF;
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
