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
CREATE UNIQUE INDEX catalog_sku_identifiers_global_gtin_key ON public.catalog_sku_identifiers((CAST(normalized_value AS numeric))) WHERE identifier_kind = 'gtin';
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
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(CAST(result AS text)) BETWEEN 2 AND 8388608),
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
 IF product.status='active' AND NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=product.primary_sku_id AND product_id=product.id
   AND status='active' AND (sellable_standalone OR sellable_in_subscription)) THEN
  reasons := reasons || '"primary_sku_not_sellable"'::jsonb;
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
