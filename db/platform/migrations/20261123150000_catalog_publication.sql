-- Native publication foundation. No runtime binding or capability is enabled.
-- Full retained facts are authoritative; current facts are projections. The managed
-- equivalent uses the same tables/guards with session-derived membership and RLS.
ALTER TABLE public.catalog_products ADD COLUMN publication_facts jsonb;
ALTER TABLE public.catalog_product_document_revisions ADD COLUMN canonical_text text;
ALTER TABLE public.catalog_product_document_revisions ADD CONSTRAINT catalog_document_canonical_text_check CHECK (
 canonical_text IS NULL OR (CAST(canonical_text AS jsonb) = document_payload)) NOT VALID;
ALTER TABLE public.catalog_product_document_revisions VALIDATE CONSTRAINT catalog_document_canonical_text_check;
ALTER TABLE public.catalog_skus ADD COLUMN publication_facts jsonb;
ALTER TABLE public.catalog_sku_identifiers ADD COLUMN scheme text;
ALTER TABLE public.catalog_sku_identifiers ADD COLUMN original_value text;
ALTER TABLE public.catalog_sku_identifiers ADD COLUMN display_label text;
ALTER TABLE public.catalog_sku_identifiers ADD COLUMN source_ref text;
-- Existing rows have no publication projection. Keep their original admission
-- rules while enforcing uniqueness on the facts introduced by publication.
CREATE UNIQUE INDEX catalog_sku_identifiers_global_gtin_key ON public.catalog_sku_identifiers((CAST(normalized_value AS numeric)))
 WHERE identifier_kind = 'gtin' AND scheme = 'gs1:gtin';
CREATE UNIQUE INDEX catalog_skus_publication_combination_key ON public.catalog_skus(product_id,combination_digest)
 WHERE publication_facts IS NOT NULL AND combination_digest IS NOT NULL;
CREATE UNIQUE INDEX catalog_draft_revisions_product_revision_key ON public.catalog_draft_revisions(product_id,draft_id,revision);
CREATE TABLE public.catalog_publications (
 id uuid PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES public.catalog_products(id),
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 previous_id uuid,
 draft_id uuid NOT NULL,
 draft_revision integer NOT NULL CHECK (draft_revision BETWEEN 1 AND 2147483647),
 candidate_ref text NOT NULL UNIQUE,
 candidate_digest text NOT NULL CHECK (length(candidate_digest) = 64 AND translate(candidate_digest,'abcdef0123456789','') = ''),
 document_revision_id uuid NOT NULL,
 canonical_state text NOT NULL CHECK (octet_length(canonical_state) BETWEEN 2 AND 16777216),
 digest text NOT NULL CHECK (length(digest) = 64 AND translate(digest,'abcdef0123456789','') = ''),
 actor_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(product_id,revision), UNIQUE(product_id,id), UNIQUE(product_id,id,revision),
 FOREIGN KEY(product_id,previous_id) REFERENCES public.catalog_publications(product_id,id),
 FOREIGN KEY(product_id,draft_id,draft_revision) REFERENCES public.catalog_draft_revisions(product_id,draft_id,revision),
 FOREIGN KEY(product_id,document_revision_id) REFERENCES public.catalog_product_document_revisions(product_id,id)
);
CREATE TABLE public.catalog_publication_heads (
 product_id uuid PRIMARY KEY REFERENCES public.catalog_products(id),
 publication_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 FOREIGN KEY(product_id,publication_id,revision) REFERENCES public.catalog_publications(product_id,id,revision)
);
CREATE TABLE public.catalog_sku_revisions (
 id uuid PRIMARY KEY,
 sku_id uuid NOT NULL REFERENCES public.catalog_skus(id),
 product_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 publication_id uuid NOT NULL,
 full_facts text NOT NULL CHECK (octet_length(full_facts) BETWEEN 2 AND 2097152),
 digest text NOT NULL CHECK (length(digest) = 64 AND translate(digest,'abcdef0123456789','') = ''),
 UNIQUE(sku_id,revision), UNIQUE(sku_id,id),
 FOREIGN KEY(product_id,sku_id) REFERENCES public.catalog_skus(product_id,id),
 FOREIGN KEY(product_id,publication_id) REFERENCES public.catalog_publications(product_id,id)
);
CREATE TABLE public.catalog_operator_receipts (
 kind text NOT NULL CHECK (kind = btrim(kind) AND length(kind) BETWEEN 1 AND 80),
 scope_id uuid NOT NULL,
 command_key text NOT NULL CHECK (command_key = btrim(command_key) AND length(command_key) BETWEEN 1 AND 240),
 fingerprint text NOT NULL CHECK (length(fingerprint) = 64 AND translate(fingerprint,'abcdef0123456789','') = ''),
 actor_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
 publication_id uuid REFERENCES public.catalog_publications(id),
 -- Store the writer's canonical receipt body. The longest response wrapper is committed.
 result text NOT NULL CHECK (jsonb_typeof(CAST(result AS jsonb)) = 'object'
   AND octet_length(result) BETWEEN 2 AND 8388574),
 PRIMARY KEY(kind,scope_id,command_key), UNIQUE(scope_id,command_key)
);
CREATE TABLE public.catalog_publication_decisions (
 id uuid PRIMARY KEY,
 product_id uuid NOT NULL,
 candidate_ref text NOT NULL,
 candidate_digest text NOT NULL CHECK (length(candidate_digest) = 64 AND translate(candidate_digest,'abcdef0123456789','') = ''),
 candidate_reference_digest text NOT NULL CHECK (length(candidate_reference_digest) = 64 AND translate(candidate_reference_digest,'abcdef0123456789','') = ''),
 action text NOT NULL CHECK (action IN ('approve','revoke')),
 actor_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
 command_key text NOT NULL,
 fingerprint text NOT NULL CHECK (length(fingerprint) = 64 AND translate(fingerprint,'abcdef0123456789','') = ''),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000 AND length(reason) BETWEEN 1 AND 1000),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(product_id,command_key),
 FOREIGN KEY(product_id,command_key) REFERENCES public.catalog_operator_receipts(scope_id,command_key)
);
CREATE TABLE public.catalog_publication_pointer_capabilities (
 transaction_id xid8 NOT NULL,
 product_id uuid NOT NULL,
 revision_id uuid NOT NULL,
 command_fingerprint text NOT NULL CHECK (length(command_fingerprint) = 64 AND translate(command_fingerprint,'abcdef0123456789','') = ''),
 PRIMARY KEY(transaction_id,product_id,revision_id,command_fingerprint),
 FOREIGN KEY(product_id,revision_id) REFERENCES public.catalog_product_document_revisions(product_id,id)
);
CREATE INDEX catalog_publications_product_revision_idx ON public.catalog_publications(product_id,revision DESC);
CREATE INDEX catalog_sku_revisions_sku_revision_idx ON public.catalog_sku_revisions(sku_id,revision DESC);
CREATE INDEX catalog_publication_decisions_reference_idx ON public.catalog_publication_decisions(candidate_reference_digest,decided_at,id);
CREATE FUNCTION public.catalog_publication_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'catalog_publication_record_immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER catalog_publications_immutable BEFORE UPDATE OR DELETE ON public.catalog_publications FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_immutable();
CREATE TRIGGER catalog_sku_revisions_immutable BEFORE UPDATE OR DELETE ON public.catalog_sku_revisions FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_immutable();
CREATE TRIGGER catalog_operator_receipts_immutable BEFORE UPDATE OR DELETE ON public.catalog_operator_receipts FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_immutable();
CREATE TRIGGER catalog_publication_decisions_immutable BEFORE UPDATE OR DELETE ON public.catalog_publication_decisions FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_immutable();
CREATE FUNCTION public.catalog_publication_pointer_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE cap_fingerprint text; capabilities integer;
BEGIN
 IF NEW.current_document_revision_id IS NOT DISTINCT FROM OLD.current_document_revision_id THEN RETURN NEW; END IF;
 SELECT min(c.command_fingerprint),count(*)::integer INTO cap_fingerprint,capabilities
  FROM public.catalog_publication_pointer_capabilities c
  WHERE c.transaction_id=pg_current_xact_id() AND c.product_id=NEW.id AND c.revision_id=NEW.current_document_revision_id;
 IF capabilities <> 1 THEN RAISE EXCEPTION 'catalog_document_pointer_direct_write_denied' USING ERRCODE='42501'; END IF;
 DELETE FROM public.catalog_publication_pointer_capabilities c WHERE c.transaction_id=pg_current_xact_id()
  AND c.product_id=NEW.id AND c.revision_id=NEW.current_document_revision_id AND c.command_fingerprint=cap_fingerprint;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_document_pointer_direct_write_denied' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_products_publication_pointer_fence BEFORE UPDATE OF current_document_revision_id ON public.catalog_products FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_pointer_fence();
ALTER TABLE public.catalog_publication_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_sku_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_operator_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_publication_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_publication_pointer_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_publication_heads FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_publications FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_sku_revisions FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_operator_receipts FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_publication_decisions FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_publication_pointer_capabilities FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_publication_pointer_fence() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_publication_heads, public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions, public.catalog_publication_pointer_capabilities FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_publication_heads, public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions, public.catalog_publication_pointer_capabilities FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_publication_heads, public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions, public.catalog_publication_pointer_capabilities FROM service_role;'; END IF; END; $$;

CREATE FUNCTION public.catalog_publication_record_admit() RETURNS trigger
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
  IF body->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR body->'product'->>'id' IS DISTINCT FROM NEW.product_id::text
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
CREATE TRIGGER catalog_publications_record_admit BEFORE INSERT ON public.catalog_publications FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_record_admit();
CREATE TRIGGER catalog_sku_revisions_record_admit BEFORE INSERT ON public.catalog_sku_revisions FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_record_admit();
CREATE TRIGGER catalog_document_publication_record_admit BEFORE INSERT ON public.catalog_product_document_revisions FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_record_admit();

-- Intrinsic native readiness. Installed transaction-local adapters additionally
-- own document vocabulary, derived facts and configured commercial predicates.
CREATE FUNCTION public.catalog_publication_sku_reasons(p_sku_id uuid,p_require_price boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE sku public.catalog_skus%ROWTYPE; product public.catalog_products%ROWTYPE; reasons jsonb := '[]';
BEGIN
 SELECT * INTO sku FROM public.catalog_skus WHERE id=p_sku_id;
 IF NOT FOUND THEN RETURN '["sku_not_materialized"]'::jsonb; END IF;
 SELECT * INTO product FROM public.catalog_products WHERE id=sku.product_id;
 IF NOT EXISTS(SELECT 1 FROM public.catalog_product_document_revisions WHERE id=product.current_document_revision_id AND product_id=product.id) THEN
  reasons := reasons || '"document_revision_missing"'::jsonb;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=product.primary_sku_id AND product_id=product.id AND status<>'archived') THEN
  reasons := reasons || '"primary_sku_missing"'::jsonb;
 END IF;
 IF p_require_price THEN
  IF char_length(product.slug)>64 THEN reasons := reasons || '"commerce_identity_unsupported"'::jsonb; END IF;
  IF sku.status='archived' THEN reasons := reasons || '"sku_archived"'::jsonb; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.catalog_sku_identifiers WHERE catalog_sku_id=sku.id AND identifier_kind='gtin' AND pack_kind='unit' AND is_primary) THEN
   reasons := reasons || '"unit_gtin_missing"'::jsonb;
  END IF;
  IF sku.publication_facts->>'logisticsRef' IS NULL THEN reasons := reasons || '"logistics_reference_missing"'::jsonb; END IF;
 END IF;
 RETURN reasons;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_sku_reasons(uuid,boolean) FROM PUBLIC;

-- Shared price writer phases; standalone uses the same extraction.
CREATE FUNCTION public.catalog_price_setup_prepare(p_canonical_command text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_actor uuid;
  v_command jsonb;
  v_expected jsonb;
  v_key text;
  v_variant_id uuid;
  v_list_id uuid;
  v_unit_price_minor integer;
  v_expected_entry_id uuid;
  v_expected_unit_price_minor integer;
  v_inserted integer;
  v_existing public.catalog_price_setup_receipts%ROWTYPE;
  v_sku public.catalog_skus%ROWTYPE;
  v_list public.price_lists%ROWTYPE;
  v_refusal text;
  v_current public.price_entries%ROWTYPE;
  v_current_count integer;
  v_pending_count integer;
  v_entry_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_added jsonb;
  v_response jsonb;
BEGIN
  -- 1. The actor: an active human administrator's session.
  v_actor := public.catalog_price_setup_require_human_admin();

  -- 2. The fingerprint binds the exact command bytes.
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 4096
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_fingerprint_invalid');
  END IF;

  -- 3. The strict command: exactly these keys, one-time gross at minimum quantity
  -- one, a positive integer amount, and an expected state that is either wholly
  -- null (no base yet) or wholly set.
  BEGIN
    v_command := p_canonical_command::jsonb;
  EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END;
  IF jsonb_typeof(v_command) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_command->'expected') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  v_expected := v_command->'expected';
  IF EXISTS (SELECT FROM jsonb_object_keys(v_command) command_key WHERE command_key NOT IN (
      'schemaVersion', 'commandKey', 'variantId', 'priceListId', 'mode', 'minQty',
      'amountKind', 'unitPriceMinor', 'expected'))
    OR EXISTS (SELECT FROM jsonb_object_keys(v_expected) expected_key
      WHERE expected_key NOT IN ('entryId', 'unitPriceMinor'))
    OR v_command->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(v_command->'commandKey') IS DISTINCT FROM 'string'
    OR length(v_command->>'commandKey') NOT BETWEEN 1 AND 240
    OR btrim(v_command->>'commandKey') <> v_command->>'commandKey'
    OR jsonb_typeof(v_command->'variantId') IS DISTINCT FROM 'string'
    OR v_command->>'variantId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(v_command->'priceListId') IS DISTINCT FROM 'string'
    OR v_command->>'priceListId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_command->'mode' IS DISTINCT FROM '"one_time"'::jsonb
    OR v_command->'minQty' IS DISTINCT FROM '1'::jsonb
    OR v_command->'amountKind' IS DISTINCT FROM '"gross"'::jsonb
    OR jsonb_typeof(v_command->'unitPriceMinor') IS DISTINCT FROM 'number'
    OR v_command->>'unitPriceMinor' !~ '^[1-9][0-9]{0,9}$'
    OR NOT (v_expected ? 'entryId' AND v_expected ? 'unitPriceMinor')
    OR NOT (
      (jsonb_typeof(v_expected->'entryId') = 'null'
        AND jsonb_typeof(v_expected->'unitPriceMinor') = 'null')
      OR (jsonb_typeof(v_expected->'entryId') = 'string'
        AND v_expected->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(v_expected->'unitPriceMinor') = 'number'
        AND v_expected->>'unitPriceMinor' ~ '^(0|[1-9][0-9]{0,9})$')) THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  -- Both amounts matched a digit pattern above, so these casts cannot fail.
  IF (v_command->>'unitPriceMinor')::bigint > 2147483647
    OR (v_expected->>'unitPriceMinor')::bigint > 2147483647 THEN
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', 'command_invalid');
  END IF;
  v_key := v_command->>'commandKey';
  v_variant_id := (v_command->>'variantId')::uuid;
  v_list_id := (v_command->>'priceListId')::uuid;
  v_unit_price_minor := (v_command->>'unitPriceMinor')::integer;
  v_expected_entry_id := (v_expected->>'entryId')::uuid;
  v_expected_unit_price_minor := (v_expected->>'unitPriceMinor')::integer;

  -- 4. The receipt, before the target is read, so that a completed command replays
  -- whatever has changed since. A refusal returned below removes this call's
  -- in-progress receipt; an exception rolls it back.
  INSERT INTO public.catalog_price_setup_receipts
    (scope, idempotency_key, request_fingerprint, status, metadata)
  VALUES ('catalog.price_setup.base', v_key, p_fingerprint, 'in_progress',
    jsonb_build_object('actorId', v_actor, 'variantId', v_variant_id, 'priceListId', v_list_id))
  ON CONFLICT (scope, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT * INTO v_existing FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key FOR UPDATE;
    IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'command_key_reused');
    ELSIF v_existing.status = 'completed' AND v_existing.response_payload IS NOT NULL THEN
      IF v_existing.metadata->>'actorId' IS DISTINCT FROM v_actor::text THEN
        RETURN jsonb_build_object('outcome', 'unauthorized', 'reason', 'operator_mismatch');
      END IF;
      RETURN v_existing.response_payload || jsonb_build_object('outcome', 'replayed');
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'command_in_progress');
  END IF;

  RETURN jsonb_build_object('canonicalCommand',p_canonical_command,'fingerprint',p_fingerprint,
    'command',v_command,'actorId',v_actor);
END;
$$;
CREATE FUNCTION public.catalog_price_setup_apply_prelocked(p_prepared jsonb, p_check_target boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_actor uuid;
  v_command jsonb;
  v_expected jsonb;
  v_key text;
  v_variant_id uuid;
  v_list_id uuid;
  v_unit_price_minor integer;
  v_expected_entry_id uuid;
  v_expected_unit_price_minor integer;
  v_inserted integer;
  v_existing public.catalog_price_setup_receipts%ROWTYPE;
  v_sku public.catalog_skus%ROWTYPE;
  v_list public.price_lists%ROWTYPE;
  v_refusal text;
  v_current public.price_entries%ROWTYPE;
  v_current_count integer;
  v_pending_count integer;
  v_entry_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_added jsonb;
  v_response jsonb;
BEGIN
  v_actor := CASE WHEN p_check_target THEN public.catalog_price_setup_require_human_admin()
    ELSE (p_prepared->>'actorId')::uuid END;
  v_command := p_prepared->'command';
  v_key := v_command->>'commandKey';
  v_variant_id := (v_command->>'variantId')::uuid;
  v_list_id := (v_command->>'priceListId')::uuid;
  v_unit_price_minor := (v_command->>'unitPriceMinor')::integer;
  v_expected_entry_id := (v_command#>>'{expected,entryId}')::uuid;
  v_expected_unit_price_minor := (v_command#>>'{expected,unitPriceMinor}')::integer;
  SELECT * INTO v_existing FROM public.catalog_price_setup_receipts
    WHERE scope='catalog.price_setup.base' AND idempotency_key=v_key FOR UPDATE;
  IF v_existing.request_fingerprint IS DISTINCT FROM p_prepared->>'fingerprint'
    OR v_existing.metadata->>'actorId' IS DISTINCT FROM v_actor::text THEN
    RAISE EXCEPTION 'catalog_price_setup_prelock_invalid' USING ERRCODE='22023';
  END IF;
  IF v_existing.status='completed' THEN
    RETURN v_existing.response_payload || jsonb_build_object('outcome','replayed');
  END IF;
  -- Publication may materialize the target after prelock. Standalone already
  -- admitted its target before the context lock.
  IF p_check_target THEN
    SELECT * INTO v_sku FROM public.catalog_skus WHERE id = v_variant_id;
    SELECT * INTO v_list FROM public.price_lists WHERE id = v_list_id;
    v_refusal := CASE
      WHEN v_sku.id IS NULL THEN 'sku_not_found'
      WHEN v_sku.status = 'archived' THEN 'sku_archived'
      WHEN v_list.id IS NULL THEN 'price_list_not_found'
      WHEN v_list.status <> 'active' OR v_list.region_code <> public.catalog_price_setup_region_code()
        OR v_list.currency <> public.catalog_price_setup_settlement_currency()
        OR v_list.valid_from > v_now OR (v_list.valid_to IS NOT NULL AND v_list.valid_to <= v_now)
        THEN 'price_list_not_active'
    END;
  END IF;

  IF v_refusal IS NULL THEN
    -- 7. The state: at most one effective base, and none starting now or later.
    SELECT count(*) FILTER (WHERE entry.valid_from <= v_now),
      count(*) FILTER (WHERE entry.valid_from >= v_now)
    INTO v_current_count, v_pending_count
    FROM public.price_entries entry
    WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
      AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
      AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
    IF v_current_count > 1 THEN
      v_refusal := 'base_price_ambiguous';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    DELETE FROM public.catalog_price_setup_receipts
    WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
    RETURN jsonb_build_object('outcome', 'validation_issue', 'reason', v_refusal);
  END IF;

  SELECT * INTO v_current FROM public.price_entries entry
  WHERE entry.price_list_id = v_list_id AND entry.variant_id = v_variant_id
    AND entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.active = true
    AND entry.valid_from <= v_now AND (entry.valid_to IS NULL OR entry.valid_to > v_now);
  IF v_pending_count > 0
    OR v_current.id IS DISTINCT FROM v_expected_entry_id
    OR v_current.unit_price_minor IS DISTINCT FROM v_expected_unit_price_minor THEN
    RAISE EXCEPTION 'catalog_price_setup_expected_state_mismatch' USING ERRCODE = '40001';
  END IF;

  -- 8. The readiness verdict before the write.
  v_before := public.commerce_offer_policy_v2_readiness();

  -- 9. Close the current base and insert its replacement at the same instant.
  IF v_current.id IS NOT NULL THEN
    UPDATE public.price_entries SET active = false, valid_to = v_now, updated_at = v_now
    WHERE id = v_current.id;
  END IF;
  INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty,
    unit_price_minor, amount_kind, active, valid_from)
  VALUES (v_list_id, v_variant_id, 'one_time', 1, v_unit_price_minor, 'gross', true, v_now)
  RETURNING id INTO v_entry_id;

  -- 10. Refuse a change after which the gate reports a reason it did not report
  -- before. An unrelated reason that was already there neither blocks the change
  -- nor hides one the change adds.
  v_after := public.commerce_offer_policy_v2_readiness();
  SELECT COALESCE(jsonb_agg(reason.code ORDER BY reason.n), '[]'::jsonb) INTO v_added
  FROM jsonb_array_elements_text(v_after->'reasons') WITH ORDINALITY AS reason(code, n)
  WHERE NOT ((v_before->'reasons') ? reason.code);
  IF jsonb_array_length(v_added) > 0 THEN
    RAISE EXCEPTION 'catalog_price_setup_readiness_would_fail'
      USING ERRCODE = '55000', DETAIL = v_added::text;
  END IF;

  -- 11. Complete the receipt with the response a replay returns.
  v_response := jsonb_build_object('outcome', 'committed', 'receipt', jsonb_build_object(
    'commandKey', v_key, 'variantId', v_variant_id, 'priceListId', v_list_id,
    'actorId', v_actor,
    'previous', CASE WHEN v_current.id IS NULL THEN NULL ELSE jsonb_build_object(
      'entryId', v_current.id, 'unitPriceMinor', v_current.unit_price_minor,
      'validFrom', v_current.valid_from) END,
    'current', jsonb_build_object('entryId', v_entry_id,
      'unitPriceMinor', v_unit_price_minor, 'validFrom', v_now)));
  UPDATE public.catalog_price_setup_receipts
  SET status = 'completed', response_payload = v_response
  WHERE scope = 'catalog.price_setup.base' AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_prelock(p_actor uuid, p_parent uuid, p_batch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE item jsonb; prepared jsonb; commands jsonb := '[]'; created text[] := ARRAY[]::text[];
  command_key text; parent uuid; actual_parent uuid; row_record record; failure jsonb; actor uuid; sorted_batch jsonb := '[]';
  target_sku public.catalog_skus%ROWTYPE; target_list public.price_lists%ROWTYPE; target_refusal text;
BEGIN
  IF p_parent IS NOT NULL THEN actor := public.catalog_price_setup_require_human_admin(); END IF;
  IF (p_parent IS NULL AND p_actor IS NOT NULL)
    OR (p_parent IS NOT NULL AND actor IS DISTINCT FROM p_actor)
    OR jsonb_typeof(p_batch) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_batch) NOT BETWEEN 1 AND 10000
    OR (p_parent IS NULL AND jsonb_array_length(p_batch)<>1) THEN
    RAISE EXCEPTION 'catalog_price_setup_prelock_invalid' USING ERRCODE='22023';
  END IF;
  -- Standalone validates the fingerprint before inspecting the raw JSON.
  IF p_parent IS NULL THEN
    sorted_batch := p_batch;
  ELSE
    -- Receipt keys first, in sorted order, including absent-key insertion locks.
    FOR item IN SELECT value FROM jsonb_array_elements(p_batch) LOOP
      command_key := NULL;
      BEGIN command_key := ((item->>'canonicalCommand')::jsonb)->>'commandKey';
      EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN NULL; END;
      sorted_batch := sorted_batch || jsonb_build_array(item || jsonb_build_object('key',command_key));
    END LOOP;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(sorted_batch) ORDER BY value->>'key',value->>'canonicalCommand' LOOP
    command_key := item->>'key';
    prepared := (SELECT value FROM jsonb_array_elements(commands) WHERE value#>>'{command,commandKey}'=command_key LIMIT 1);
    IF prepared IS NOT NULL THEN
      IF prepared->>'canonicalCommand' IS DISTINCT FROM item->>'canonicalCommand'
        OR prepared->>'fingerprint' IS DISTINCT FROM item->>'fingerprint' THEN
        failure := jsonb_build_object('outcome','conflict','reason','command_key_reused'); EXIT;
      END IF;
      CONTINUE;
    END IF;
    prepared := public.catalog_price_setup_prepare(item->>'canonicalCommand',item->>'fingerprint');
    IF p_parent IS NULL THEN
      IF prepared ? 'outcome' THEN RETURN prepared; END IF;
      actor := (prepared->>'actorId')::uuid;
    END IF;
    IF prepared ? 'outcome' AND prepared->>'outcome'<>'replayed' THEN failure := prepared; EXIT; END IF;
    IF prepared->>'outcome'='replayed' THEN
      prepared := item || jsonb_build_object('command',(item->>'canonicalCommand')::jsonb,'replayed',prepared);
    ELSE created := array_append(created,prepared#>>'{command,commandKey}'); END IF;
    commands := commands || jsonb_build_array(prepared);
  END LOOP;
  IF failure IS NULL THEN
    -- Publication may reserve a child before materialization. Standalone replay
    -- never reads its target; all other standalone refusals retain their order.
    FOR item IN SELECT value FROM jsonb_array_elements(commands) LOOP
      IF p_parent IS NULL AND item ? 'replayed' THEN CONTINUE; END IF;
      IF p_parent IS NULL THEN
        SELECT * INTO target_sku FROM public.catalog_skus WHERE id=(item#>>'{command,variantId}')::uuid;
        SELECT * INTO target_list FROM public.price_lists WHERE id=(item#>>'{command,priceListId}')::uuid;
        target_refusal := CASE WHEN target_sku.id IS NULL THEN 'sku_not_found'
          WHEN target_sku.status='archived' THEN 'sku_archived'
          WHEN target_list.id IS NULL THEN 'price_list_not_found'
          WHEN target_list.status<>'active' OR target_list.region_code<>public.catalog_price_setup_region_code()
            OR target_list.currency<>public.catalog_price_setup_settlement_currency()
            OR target_list.valid_from>statement_timestamp() OR (target_list.valid_to IS NOT NULL AND target_list.valid_to<=statement_timestamp())
            THEN 'price_list_not_active' END;
        IF target_refusal IS NOT NULL THEN failure:=jsonb_build_object('outcome','validation_issue','reason',target_refusal); EXIT; END IF;
      END IF;
      SELECT product_id INTO actual_parent FROM public.catalog_skus WHERE id=(item#>>'{command,variantId}')::uuid;
      IF p_parent IS NOT NULL AND actual_parent IS NULL THEN
        SELECT r.product_id INTO actual_parent FROM public.catalog_draft_sku_reservations r
          JOIN public.catalog_draft_heads h ON h.draft_id=r.draft_id AND h.status='open'
          WHERE r.sku_id=(item#>>'{command,variantId}')::uuid;
      END IF;
      IF p_parent IS NOT NULL AND actual_parent IS DISTINCT FROM p_parent THEN
        failure := jsonb_build_object('outcome','validation_issue','reason','catalog_price_parent_mismatch'); EXIT;
      END IF;
      parent := coalesce(p_parent,actual_parent);
    END LOOP;
  END IF;
  IF failure IS NOT NULL THEN
    DELETE FROM public.catalog_price_setup_receipts WHERE scope='catalog.price_setup.base' AND idempotency_key=ANY(created);
    RETURN failure;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(commands) WHERE NOT (value ? 'replayed')) THEN
  -- Same donor context guards, then sorted open rows. Ownership was checked
  -- for the complete batch before acquiring the first context.
  FOR row_record IN SELECT DISTINCT (value#>>'{command,priceListId}')::uuid AS list_id,
      (value#>>'{command,variantId}')::uuid AS sku_id
    FROM jsonb_array_elements(commands) WHERE NOT (value ? 'replayed') ORDER BY list_id,sku_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-price-setup:'||row_record.list_id::text||':'||row_record.sku_id::text,0));
  END LOOP;
  FOR row_record IN SELECT entry.id FROM public.price_entries entry
    JOIN (SELECT DISTINCT (value#>>'{command,priceListId}')::uuid AS list_id,(value#>>'{command,variantId}')::uuid AS sku_id
      FROM jsonb_array_elements(commands) WHERE NOT (value ? 'replayed')) targets
      ON targets.list_id=entry.price_list_id AND targets.sku_id=entry.variant_id
    WHERE entry.mode='one_time' AND entry.min_qty=1 AND entry.active
      AND (entry.valid_to IS NULL OR entry.valid_to>statement_timestamp()) ORDER BY entry.id FOR NO KEY UPDATE OF entry LOOP NULL; END LOOP;
  END IF;
  RETURN jsonb_build_object('actorId',actor,'parentProductId',p_parent,'transactionId',pg_current_xact_id()::text,
    'prepared',commands,'batch',p_batch);
END;
$$;
CREATE FUNCTION public.catalog_price_setup_apply_in_transaction(p_actor uuid,p_parent uuid,p_prelocked jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE item jsonb; prepared jsonb; result jsonb; results jsonb := '[]'; actual_parent uuid;
BEGIN
  -- Standalone has already admitted its actor. Publication still verifies the
  -- live actor on this phase. Both paths bind the same transaction and actor.
  IF p_parent IS NOT NULL AND public.catalog_price_setup_require_human_admin() IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'catalog_price_setup_prelock_invalid' USING ERRCODE='22023';
  END IF;
  IF p_prelocked->>'actorId' IS DISTINCT FROM p_actor::text
    OR p_prelocked->>'parentProductId' IS DISTINCT FROM p_parent::text
    OR p_prelocked->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'catalog_price_setup_prelock_invalid' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_prelocked->'batch') LOOP
    prepared := (SELECT value FROM jsonb_array_elements(p_prelocked->'prepared') WHERE value->>'canonicalCommand'=item->>'canonicalCommand');
    IF p_parent IS NOT NULL THEN
      SELECT product_id INTO actual_parent FROM public.catalog_skus WHERE id=(prepared#>>'{command,variantId}')::uuid;
      IF actual_parent IS DISTINCT FROM p_parent THEN RAISE EXCEPTION 'catalog_price_parent_mismatch' USING ERRCODE='22023'; END IF;
    END IF;
    result := CASE WHEN prepared ? 'replayed' THEN prepared->'replayed'
      ELSE public.catalog_price_setup_apply_prelocked(prepared,p_parent IS NOT NULL) END;
    results := results || jsonb_build_array(result);
    IF result->>'outcome' NOT IN ('committed','replayed') THEN RETURN result; END IF;
  END LOOP;
  RETURN jsonb_build_object('outcome','applied','results',results);
END;
$$;
CREATE OR REPLACE FUNCTION public.catalog_price_setup_apply(p_canonical_command text, p_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$
DECLARE prepared jsonb; result jsonb;
BEGIN
  prepared := public.catalog_price_setup_prelock(NULL,NULL,jsonb_build_array(jsonb_build_object('canonicalCommand',p_canonical_command,'fingerprint',p_fingerprint)));
  IF prepared ? 'outcome' THEN RETURN prepared; END IF;
  result := public.catalog_price_setup_apply_in_transaction((prepared->>'actorId')::uuid,NULL,prepared);
  RETURN CASE WHEN result->>'outcome'='applied' THEN result#>'{results,0}' ELSE result END;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_price_setup_prepare(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_apply_prelocked(jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_prelock(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_apply_in_transaction(uuid,uuid,jsonb) FROM PUBLIC;
