-- Native publication foundation. No runtime binding or capability is enabled.
-- Full retained facts are authoritative; current facts are projections. The managed
-- equivalent uses the same tables/guards with session-derived membership and RLS.
ALTER TABLE public.catalog_products ADD COLUMN publication_facts jsonb;
ALTER TABLE public.catalog_skus ADD COLUMN publication_facts jsonb;
CREATE UNIQUE INDEX catalog_draft_revisions_product_revision_key ON public.catalog_draft_revisions(product_id,draft_id,revision);
CREATE TABLE public.catalog_publications (
 id uuid PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES public.catalog_products(id),
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 issued_count integer NOT NULL CHECK (issued_count BETWEEN 0 AND 10000),
 approval_id uuid NOT NULL,
 command_fingerprint text NOT NULL CHECK (length(command_fingerprint) = 64 AND translate(command_fingerprint,'abcdef0123456789','') = ''),
 previous_id uuid,
 draft_id uuid NOT NULL,
 draft_revision integer NOT NULL CHECK (draft_revision BETWEEN 1 AND 2147483647),
 command_key text NOT NULL CHECK (octet_length(command_key) BETWEEN 1 AND 200),
 candidate_ref text NOT NULL UNIQUE,
 candidate_digest text NOT NULL CHECK (length(candidate_digest) = 64 AND translate(candidate_digest,'abcdef0123456789','') = ''),
 document_revision_id uuid NOT NULL,
 primary_sku_revision_id uuid NOT NULL,
 canonical_state text NOT NULL CHECK (octet_length(canonical_state) BETWEEN 2 AND 16777216),
 digest text NOT NULL CHECK (length(digest) = 64 AND translate(digest,'abcdef0123456789','') = ''),
 actor_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(product_id,revision), UNIQUE(product_id,id), UNIQUE(product_id,id,revision), UNIQUE(product_id,command_key),
 CONSTRAINT catalog_publications_previous_fk FOREIGN KEY(product_id,previous_id) REFERENCES public.catalog_publications(product_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(product_id,draft_id,draft_revision) REFERENCES public.catalog_draft_revisions(product_id,draft_id,revision),
 FOREIGN KEY(product_id,document_revision_id) REFERENCES public.catalog_product_document_revisions(product_id,id)
);
CREATE TABLE public.catalog_publication_heads (
 product_id uuid PRIMARY KEY REFERENCES public.catalog_products(id),
 publication_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 CONSTRAINT catalog_publication_heads_issue_fk FOREIGN KEY(product_id,publication_id,revision) REFERENCES public.catalog_publications(product_id,id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.catalog_sku_revisions (
 id uuid PRIMARY KEY,
 sku_id uuid NOT NULL REFERENCES public.catalog_skus(id),
 sku_code text NOT NULL CHECK (length(sku_code) BETWEEN 1 AND 160),
 product_id uuid NOT NULL,
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 publication_id uuid NOT NULL,
 issue_ordinal integer NOT NULL CHECK (issue_ordinal BETWEEN 1 AND 10000),
 full_facts text NOT NULL CHECK (octet_length(full_facts) BETWEEN 2 AND 2097152),
 digest text NOT NULL CHECK (length(digest) = 64 AND translate(digest,'abcdef0123456789','') = ''),
 UNIQUE(sku_id,revision), UNIQUE(sku_id,id),
 UNIQUE(publication_id,sku_id), UNIQUE(publication_id,issue_ordinal),
 FOREIGN KEY(product_id,sku_id) REFERENCES public.catalog_skus(product_id,id),
 CONSTRAINT catalog_sku_revisions_issue_fk FOREIGN KEY(product_id,publication_id) REFERENCES public.catalog_publications(product_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.catalog_publications ADD CONSTRAINT catalog_publications_primary_sku_revision_fk
 FOREIGN KEY(primary_sku_revision_id) REFERENCES public.catalog_sku_revisions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.catalog_operator_receipts (
 kind text NOT NULL CHECK (kind IN ('publish','approve','revoke')),
 scope_id uuid NOT NULL,
 command_key text NOT NULL CHECK (octet_length(command_key) BETWEEN 1 AND 200),
 fingerprint text NOT NULL CHECK (length(fingerprint) = 64 AND translate(fingerprint,'abcdef0123456789','') = ''),
 actor_id uuid NOT NULL REFERENCES public.platform_human_principals(principal_id),
 publication_id uuid UNIQUE CONSTRAINT catalog_operator_receipts_issue_fk REFERENCES public.catalog_publications(id) DEFERRABLE INITIALLY DEFERRED,
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
 reason text CHECK (length(btrim(reason)) BETWEEN 1 AND 1000 AND octet_length(reason) BETWEEN 1 AND 1000),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(product_id,command_key),
 CONSTRAINT catalog_publication_decisions_receipt_fk FOREIGN KEY(product_id,command_key) REFERENCES public.catalog_operator_receipts(scope_id,command_key) DEFERRABLE INITIALLY DEFERRED
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
CREATE INDEX catalog_publications_primary_sku_revision_idx ON public.catalog_publications(primary_sku_revision_id);
CREATE INDEX catalog_sku_revisions_sku_revision_idx ON public.catalog_sku_revisions(sku_id,revision DESC);
CREATE INDEX catalog_publication_decisions_reference_idx ON public.catalog_publication_decisions(candidate_reference_digest,decided_at,id);
CREATE FUNCTION public.catalog_publication_pointer_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE cap_fingerprint text; capabilities integer;
BEGIN
 IF NEW.current_document_revision_id IS NOT DISTINCT FROM OLD.current_document_revision_id THEN RETURN NEW; END IF;
 SELECT min(c.command_fingerprint),count(*)::integer INTO cap_fingerprint,capabilities
  FROM public.catalog_publication_pointer_capabilities c
  WHERE c.transaction_id=pg_current_xact_id() AND c.product_id=NEW.id AND c.revision_id=NEW.current_document_revision_id;
 IF capabilities=0 AND OLD.publication_facts IS NULL AND NEW.publication_facts IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.catalog_publication_heads h WHERE h.product_id=NEW.id) THEN RETURN NEW; END IF;
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
REVOKE ALL ON FUNCTION public.catalog_publication_pointer_fence() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_publication_heads, public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions, public.catalog_publication_pointer_capabilities FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_publication_heads, public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions, public.catalog_publication_pointer_capabilities FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_publication_heads, public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions, public.catalog_publication_pointer_capabilities FROM service_role;'; END IF; END; $$;

-- Canonicalize the neutral wire. Array indices sort numerically before other
-- keys, which ECMAScript orders by UTF-16 code units. The document is opaque.
CREATE FUNCTION public.catalog_publication_canonical(p_value jsonb, p_depth integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE result text; number_text text; number_value numeric; original_precision text;
BEGIN
 IF p_depth > 48 THEN
  RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
 END IF;
 CASE jsonb_typeof(p_value)
 WHEN 'object' THEN
  IF p_value ?| ARRAY['__proto__','constructor','prototype'] THEN
   RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
  END IF;
  SELECT '{' || coalesce(string_agg(to_jsonb(item.key)::text || ':' ||
    public.catalog_publication_canonical(item.value,p_depth+1), ',' ORDER BY
      CASE WHEN item.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
        CASE WHEN item.key::bigint < 4294967295 THEN item.key::bigint END
      END NULLS LAST,
      ARRAY(SELECT CASE WHEN cp <= 65535 THEN cp ELSE 55296 + (cp - 65536) / 1024 END * 1024
                  + CASE WHEN cp <= 65535 THEN 0 ELSE (cp - 65536) % 1024 END
            FROM generate_series(1,char_length(item.key)) AS i
            CROSS JOIN LATERAL (SELECT ascii(substr(item.key,i,1)) AS cp) AS point ORDER BY i)), '') || '}'
   INTO result FROM jsonb_each(p_value) AS item;
  RETURN result;
 WHEN 'array' THEN
  SELECT '[' || coalesce(string_agg(public.catalog_publication_canonical(item.value,p_depth+1),',' ORDER BY item.ordinality),'') || ']'
   INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item;
  RETURN result;
 WHEN 'number' THEN
  -- PostgreSQL's shortest round-trip float output is input to ECMAScript's
  -- decimal/scientific formatting thresholds.
  original_precision := current_setting('extra_float_digits');
  PERFORM set_config('extra_float_digits','3',true);
  number_text := (p_value::double precision)::text;
  PERFORM set_config('extra_float_digits',original_precision,true);
  number_value := number_text::numeric;
  IF number_value = 0 THEN RETURN '0'; END IF;
  IF abs(number_value) >= 0.000001 AND abs(number_value) < 1e21 THEN
   RETURN trim_scale(number_value)::text;
  END IF;
  RETURN regexp_replace(number_text,'e([+-])0+([0-9]+)$','e\1\2');
 ELSE RETURN p_value::text;
 END CASE;
EXCEPTION WHEN numeric_value_out_of_range THEN
 RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_canonical(jsonb,integer) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_head_ref(p_product uuid, p_issue uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT jsonb_build_object('publicationId',p.id,'revision',p.revision,'documentDigest',d.digest)
 FROM public.catalog_publications p
 JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(p.product_id,p.document_revision_id)
 WHERE p.product_id=p_product AND p.id=p_issue
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_head_ref(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_candidate_source(p_product uuid, p_ref text, p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE parts text[]; authored jsonb; definition_digest text; expected_head jsonb;
BEGIN
 parts := regexp_match(p_ref,'^v1:([0-9a-f-]{36})@([1-9][0-9]{0,9})/(unpublished|([0-9a-f-]{36})@([1-9][0-9]{0,9}))$');
 IF parts IS NOT NULL THEN
  IF parts[4] IS NOT NULL THEN
   expected_head := public.catalog_publication_head_ref(p_product,parts[4]::uuid);
  END IF;
  SELECT d.payload,t.definition_digest INTO authored,definition_digest
  FROM public.catalog_draft_revisions d
  JOIN public.catalog_draft_command_receipts r
   ON (r.draft_id,r.command_key,r.revision,r.fingerprint)=(d.draft_id,d.command_key,d.revision,d.fingerprint)
  JOIN public.catalog_type_versions t
   ON (t.type_key,to_jsonb(t.version))=(d.payload #>> '{product,type,key}',d.payload #> '{product,type,version}')
  WHERE d.draft_id=parts[1]::uuid AND d.revision=parts[2]::integer AND d.product_id=p_product
   AND d.status='open' AND d.payload->'schemaVersion'='3'::jsonb;
  IF authored IS NOT NULL AND (parts[4] IS NULL OR expected_head->>'revision'=parts[5])
   AND encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(
     'catalog-candidate',1,authored,jsonb_build_array((authored #> '{product,type}') ||
     jsonb_build_object('definitionDigest',definition_digest)), expected_head),0),'UTF8')),'hex')=p_digest THEN
   RETURN authored;
  END IF;
 END IF;
 RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_candidate_source(uuid,text,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_assert_head(p_product uuid, p_check_pointer boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE latest uuid; current_head uuid;
BEGIN
 SELECT p.id INTO latest FROM public.catalog_publications p WHERE p.product_id=p_product ORDER BY p.revision DESC LIMIT 1;
 SELECT h.publication_id INTO current_head FROM public.catalog_publication_heads h WHERE h.product_id=p_product;
 IF current_head IS DISTINCT FROM latest THEN
  RAISE EXCEPTION 'catalog_publication_head_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_head_invalid';
 END IF;
 IF p_check_pointer AND latest IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM public.catalog_products c JOIN public.catalog_publications p
    ON p.product_id=c.id AND p.id=latest
   -- Installing the first issue also establishes its live projection marker.
   -- A competing legacy pointer UPDATE must contend on that same product row.
   WHERE c.id=p_product AND c.publication_facts IS NOT NULL AND c.current_document_revision_id=p.document_revision_id) THEN
  RAISE EXCEPTION 'catalog_publication_document_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_document_invalid';
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_assert_head(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_assert_receipt(p_product uuid, p_key text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE receipt public.catalog_operator_receipts%ROWTYPE; decision public.catalog_publication_decisions%ROWTYPE;
 issue public.catalog_publications%ROWTYPE; body jsonb; expected jsonb;
BEGIN
 SELECT * INTO receipt FROM public.catalog_operator_receipts WHERE scope_id=p_product AND command_key=p_key;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'catalog_publication_receipt_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_receipt_invalid';
 END IF;
 IF receipt.kind='publish' THEN
  SELECT * INTO issue FROM public.catalog_publications WHERE product_id=p_product AND command_key=p_key;
  -- The publication event checks the full body against the owned issuance rows.
  IF FOUND AND issue.id=receipt.publication_id AND issue.actor_id=receipt.actor_id AND issue.command_fingerprint=receipt.fingerprint
   AND NOT EXISTS (SELECT 1 FROM public.catalog_publication_decisions a WHERE a.product_id=p_product AND a.command_key=p_key)
   THEN RETURN; END IF;
 ELSE
  body := receipt.result::jsonb;
  SELECT * INTO decision FROM public.catalog_publication_decisions WHERE product_id=p_product AND command_key=p_key;
  IF FOUND AND receipt.publication_id IS NULL AND decision.action=receipt.kind AND decision.actor_id=receipt.actor_id
   AND decision.fingerprint=receipt.fingerprint AND decision.candidate_reference_digest=encode(sha256(convert_to(
     public.catalog_publication_canonical(jsonb_build_array(decision.candidate_ref,decision.candidate_digest),0),'UTF8')),'hex') THEN
   expected := jsonb_build_object('schemaVersion',2,'action',decision.action,'productId',p_product,'commandKey',p_key,
      'candidateRef',decision.candidate_ref,'candidateDigest',decision.candidate_digest,'reason',decision.reason);
   IF decision.fingerprint=encode(sha256(convert_to(public.catalog_publication_canonical(jsonb_build_array(expected,decision.actor_id),0),'UTF8')),'hex')
    AND body=expected || jsonb_build_object('actorId',decision.actor_id,'fingerprint',decision.fingerprint,
      'decidedAt',to_char(decision.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    AND receipt.result=public.catalog_publication_canonical(body,0) THEN RETURN; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'catalog_publication_receipt_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_receipt_invalid';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_assert_receipt(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_assert_issued(p_product uuid, p_issue uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE issue public.catalog_publications%ROWTYPE; prior public.catalog_publications%ROWTYPE;
 receipt public.catalog_operator_receipts%ROWTYPE;
 doc_reference jsonb; doc_valid boolean; authored jsonb; manifest jsonb; product jsonb;
 head jsonb; previous_head jsonb; roster jsonb; changes jsonb; issue_count integer;
 invalid_change boolean; distinct_codes integer; expected_receipt jsonb;
BEGIN
 SELECT * INTO issue FROM public.catalog_publications WHERE product_id=p_product AND id=p_issue;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'catalog_publication_lineage_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_lineage_invalid';
 END IF;
 PERFORM public.catalog_publication_assert_head(p_product,false);
 SELECT * INTO prior FROM public.catalog_publications WHERE product_id=p_product AND id=issue.previous_id;
 IF (issue.revision=1 AND issue.previous_id IS NOT NULL)
   OR (issue.revision>1 AND prior.revision IS DISTINCT FROM issue.revision-1)
   OR issue.candidate_ref IS DISTINCT FROM
     'v1:' || issue.draft_id || '@' || issue.draft_revision || '/' ||
       coalesce(prior.id || '@' || prior.revision,'unpublished') THEN
  RAISE EXCEPTION 'catalog_publication_lineage_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_lineage_invalid';
 END IF;

 manifest := issue.canonical_state::jsonb;
 product := manifest->'product';
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object'
   OR NOT (manifest ?& ARRAY['schemaVersion','product','skus'])
   OR manifest - ARRAY['schemaVersion','product','skus'] <> '{}'::jsonb
   OR manifest->'schemaVersion' IS DISTINCT FROM '2'::jsonb
   OR jsonb_typeof(manifest->'skus') IS DISTINCT FROM 'array'
   OR jsonb_typeof(product) IS DISTINCT FROM 'object'
   OR NOT (product ?& ARRAY['id','slug','name','status','type','axes','attributes','primarySkuId','document','presentation','source','content'])
   OR product - ARRAY['id','slug','name','status','type','axes','attributes','primarySkuId','document','presentation','source','content'] <> '{}'::jsonb
   OR product->'id' IS DISTINCT FROM to_jsonb(p_product)
   OR jsonb_typeof(product->'slug') IS DISTINCT FROM 'string' OR product->>'slug'=''
   OR jsonb_typeof(product->'name') IS DISTINCT FROM 'string' OR length(product->>'name') NOT BETWEEN 1 AND 500
   OR product->>'status' NOT IN ('draft','active','archived') OR product->>'status' IS NULL
   OR jsonb_typeof(product->'axes') IS DISTINCT FROM 'array'
   OR jsonb_typeof(product->'attributes') IS DISTINCT FROM 'object'
   OR jsonb_typeof(product->'presentation') NOT IN ('object','null')
   OR jsonb_typeof(product->'content') IS DISTINCT FROM 'object'
   OR NOT ((product->'content') ?& ARRAY['schemaVersion','catalogAction','presentation','offerMemberships','requestedModes','publicationSkus'])
   OR (product->'content') - ARRAY['schemaVersion','catalogAction','presentation','offerMemberships','requestedModes','publicationSkus'] <> '{}'::jsonb
   OR product #> '{content,schemaVersion}' IS DISTINCT FROM '1'::jsonb
   OR product #>> '{content,catalogAction}' NOT IN ('create','revise') OR product #>> '{content,catalogAction}' IS NULL
   OR jsonb_typeof(product #> '{content,presentation}') IS DISTINCT FROM 'object'
   OR jsonb_typeof(product #> '{content,offerMemberships}') IS DISTINCT FROM 'array'
   OR jsonb_typeof(product #> '{content,requestedModes}') IS DISTINCT FROM 'array'
   OR jsonb_typeof(product #> '{content,publicationSkus}') IS DISTINCT FROM 'array'
   OR issue.canonical_state<>public.catalog_publication_canonical(manifest,0)
   OR issue.digest<>encode(sha256(convert_to(issue.canonical_state,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
 END IF;

 authored := public.catalog_publication_candidate_source(p_product,issue.candidate_ref,issue.candidate_digest);
 IF product->'type' IS DISTINCT FROM authored #> '{product,type}'
   OR NOT EXISTS (SELECT 1 FROM public.catalog_draft_revisions d
     WHERE d.draft_id=issue.draft_id AND d.revision=issue.draft_revision
       AND product->'source'=jsonb_build_object('draftId',d.draft_id,'revision',d.revision,'commandKey',d.command_key,'fingerprint',d.fingerprint))
   OR NOT EXISTS (SELECT 1 FROM public.catalog_publication_decisions a
     WHERE a.id=issue.approval_id AND a.product_id=p_product AND a.action='approve'
       AND a.candidate_ref=issue.candidate_ref AND a.candidate_digest=issue.candidate_digest AND a.decided_at<=issue.committed_at) THEN
  RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
 END IF;

 SELECT jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,
    'schemaId',d.schema_id,'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest),
   EXISTS (
    SELECT 1 FROM public.catalog_draft_revisions origin
    JOIN public.catalog_draft_command_receipts origin_receipt ON
     (origin_receipt.draft_id,origin_receipt.command_key,origin_receipt.revision,origin_receipt.fingerprint)=
     (origin.draft_id,origin.command_key,origin.revision,origin.fingerprint)
     WHERE origin.draft_id=(d.provenance->>'draftId')::uuid AND origin.revision=(d.provenance->>'draftRevision')::integer
     AND origin.product_id=p_product AND origin.status='open'
     AND d.provenance=jsonb_build_object('draftId',origin.draft_id,'draftRevision',origin.revision,
      'draftCommandKey',origin.command_key,'draftFingerprint',origin.fingerprint)
     AND origin.payload #> '{product,documentRevision}'=jsonb_build_object(
       'id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
       'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest)
     AND (prior.document_revision_id=d.id OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(
         (origin.payload #> '{publication,operations}') || (authored #> '{publication,operations}')) operation
       WHERE operation->>'op'='register_document_revision'
        AND operation->'revisionId'=to_jsonb(d.id) AND operation->'revisionNo'=to_jsonb(d.revision_no)
        AND operation->'documentRef'=to_jsonb(d.document_ref) AND operation->'sourceRef'=to_jsonb(d.source_ref)
        AND operation->'digest'=to_jsonb(d.digest)
        AND (operation->>'canonicalText')::jsonb=d.document_payload
        AND encode(sha256(convert_to(operation->>'canonicalText','UTF8')),'hex')=d.digest)))
 INTO doc_reference,doc_valid
 FROM public.catalog_product_document_revisions d WHERE d.product_id=p_product AND d.id=issue.document_revision_id;
 IF doc_valid IS DISTINCT FROM true OR doc_reference IS DISTINCT FROM product->'document'
   OR doc_reference IS DISTINCT FROM authored #> '{product,documentRevision}' THEN
  RAISE EXCEPTION 'catalog_publication_document_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_document_invalid';
 END IF;

 head := public.catalog_publication_head_ref(p_product,p_issue);
 previous_head := public.catalog_publication_head_ref(p_product,issue.previous_id);
 -- Only the immediate predecessor is consulted. Every inherited reference
 -- already passed admission at its own issue. The two new unique keys make
 -- each ordinal and each SKU appear at most once in this issue.
 WITH previous_skus AS MATERIALIZED (
  SELECT value AS reference FROM jsonb_array_elements(coalesce(prior.canonical_state::jsonb->'skus','[]'::jsonb))
 ), issued AS MATERIALIZED (
  SELECT r.id,r.sku_id,r.sku_code,r.revision,r.digest,r.issue_ordinal,r.full_facts::jsonb->>'status' AS status
  FROM public.catalog_sku_revisions r WHERE r.publication_id=p_issue AND r.product_id=p_product
 ), merged AS (
  SELECT coalesce(new.sku_id::text,old.reference->>'skuId') AS sku_id,new.id AS issued_id,
   new.revision,new.sku_code,new.status,new.issue_ordinal,
   old.reference AS previous_reference,
   CASE WHEN new.id IS NULL THEN old.reference ELSE
    jsonb_build_object('skuId',new.sku_id,'revisionId',new.id,'revision',new.revision,'digest',new.digest) END AS reference
  FROM previous_skus old FULL JOIN issued new ON old.reference->>'skuId'=new.sku_id::text
 )
 SELECT coalesce(jsonb_agg(m.reference ORDER BY m.sku_id COLLATE "C"),'[]'::jsonb),
  count(m.issued_id)::integer,
  coalesce(bool_or(m.revision::bigint<>coalesce((m.previous_reference->>'revision')::bigint,0)+1
    OR m.reference->>'digest'=m.previous_reference->>'digest' OR m.issue_ordinal>issue.issued_count)
    FILTER (WHERE m.issued_id IS NOT NULL),false),
  count(DISTINCT coalesce(m.sku_code,inherited.sku_code))::integer,
  coalesce(jsonb_agg(jsonb_build_object('productId',p_product,'variantId',m.sku_id,'sku',m.sku_code,
   'state',CASE WHEN m.status='archived' THEN 'withdrawn' ELSE m.status END,'variantRevision',m.revision,
   'publicationHead',head,'draftRef',jsonb_build_object('draftId',issue.draft_id,'revision',issue.draft_revision))
   ORDER BY m.sku_id COLLATE "C") FILTER (WHERE m.issued_id IS NOT NULL),'[]'::jsonb)
 INTO roster,issue_count,invalid_change,distinct_codes,changes
 FROM merged m
 LEFT JOIN public.catalog_sku_revisions inherited ON m.issued_id IS NULL
  AND inherited.id=(m.reference->>'revisionId')::uuid AND inherited.product_id=p_product
  AND inherited.sku_id=(m.reference->>'skuId')::uuid
  AND inherited.revision=(m.reference->>'revision')::integer AND inherited.digest=m.reference->>'digest';
 IF issue_count<>issue.issued_count OR invalid_change OR roster IS DISTINCT FROM manifest->'skus'
   OR distinct_codes<>jsonb_array_length(roster)
   OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(roster) AS member
     WHERE member->'skuId'=product->'primarySkuId' AND member->'revisionId'=to_jsonb(issue.primary_sku_revision_id)) THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;

 PERFORM public.catalog_publication_assert_receipt(p_product,issue.command_key);
 SELECT * INTO STRICT receipt FROM public.catalog_operator_receipts WHERE scope_id=p_product AND command_key=issue.command_key;
 expected_receipt := jsonb_build_object('schemaVersion',2,'productId',p_product,'commandKey',issue.command_key,
   'fingerprint',issue.command_fingerprint,'actorId',issue.actor_id,'head',head,'previousHead',previous_head,
   'publicationDigest',issue.digest,'committedAt',to_char(issue.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'changes',changes);
 IF receipt.kind<>'publish' OR receipt.result<>public.catalog_publication_canonical(expected_receipt,0) THEN
  RAISE EXCEPTION 'catalog_publication_receipt_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_receipt_invalid';
 END IF;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'catalog_publication_manifest_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_manifest_invalid';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_assert_issued(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_quantity_valid(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
 SELECT jsonb_typeof(p_value)='object'
   AND p_value ?& ARRAY['dimension','unscaled','scale','unit']
   AND p_value - ARRAY['dimension','unscaled','scale','unit']='{}'::jsonb
   AND p_value->>'dimension' IN ('mass','volume','count')
   AND jsonb_typeof(p_value->'unscaled')='string' AND p_value->>'unscaled' ~ '^[1-9][0-9]{0,39}$'
   AND jsonb_typeof(p_value->'scale')='number' AND p_value->>'scale' ~ '^([0-9]|1[0-2])$'
   AND jsonb_typeof(p_value->'unit')='string' AND length(p_value->>'unit')<=120
   AND p_value->>'unit' ~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_quantity_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_sku_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE body jsonb;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'catalog_publication_record_immutable' USING ERRCODE='23514',
    CONSTRAINT='catalog_publication_record_immutable';
 END IF;
 body := NEW.full_facts::jsonb;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object'
   OR NOT (body ?& ARRAY['id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription',
     'netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source'])
   OR body - ARRAY['id','productId','code','title','status','minQuantity','isAddon','sellableStandalone','sellableInSubscription',
     'netContent','grossMass','options','attributes','facts','identifiers','assetRefs','logisticsRef','memberships','source'] <> '{}'::jsonb
   OR body->'id' IS DISTINCT FROM to_jsonb(NEW.sku_id) OR body->'productId' IS DISTINCT FROM to_jsonb(NEW.product_id)
   OR body->'code' IS DISTINCT FROM to_jsonb(NEW.sku_code) OR NEW.sku_code !~ '^[A-Za-z0-9._:-]+$'
   OR body->>'status' NOT IN ('draft','active','archived') OR body->>'status' IS NULL
   OR jsonb_typeof(body->'title') IS DISTINCT FROM 'string' OR length(body->>'title') NOT BETWEEN 1 AND 500
   OR jsonb_typeof(body->'minQuantity') IS DISTINCT FROM 'number' OR body->>'minQuantity' !~ '^[1-9][0-9]{0,9}$'
   OR (body->>'minQuantity')::numeric>2147483647
   OR jsonb_typeof(body->'isAddon') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'sellableStandalone') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(body->'sellableInSubscription') IS DISTINCT FROM 'boolean'
   OR public.catalog_publication_quantity_valid(body->'netContent') IS DISTINCT FROM true
   OR (body->'grossMass'<>'null'::jsonb AND public.catalog_publication_quantity_valid(body->'grossMass') IS DISTINCT FROM true)
   OR jsonb_typeof(body->'options') IS DISTINCT FROM 'object'
   OR jsonb_typeof(body->'attributes') IS DISTINCT FROM 'object'
   OR jsonb_typeof(body->'facts') IS DISTINCT FROM 'object'
   OR jsonb_typeof(body->'identifiers') IS DISTINCT FROM 'array'
   OR jsonb_typeof(body->'assetRefs') IS DISTINCT FROM 'array'
   OR jsonb_typeof(body->'logisticsRef') NOT IN ('string','null')
   OR jsonb_typeof(body->'memberships') IS DISTINCT FROM 'array'
   OR public.catalog_publication_canonical(body,0)<>NEW.full_facts
   OR encode(sha256(convert_to(NEW.full_facts,'UTF8')),'hex')<>NEW.digest THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(body->'options') AS option WHERE
     length(option.key)>64 OR option.key !~ '^[a-z][a-z0-9_-]*$'
     OR jsonb_typeof(option.value)<>'object' OR NOT (option.value ?& ARRAY['kind','value'])
     OR option.value - ARRAY['kind','value']<>'{}'::jsonb
     OR CASE option.value->>'kind'
       WHEN 'choice' THEN jsonb_typeof(option.value->'value')<>'string' OR length(option.value->>'value') NOT BETWEEN 1 AND 120
       WHEN 'boolean' THEN jsonb_typeof(option.value->'value')<>'boolean'
       WHEN 'quantity' THEN public.catalog_publication_quantity_valid(option.value->'value') IS DISTINCT FROM true
       ELSE true END)
  OR jsonb_array_length(body->'assetRefs')>32
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(body->'assetRefs') AS item WHERE
    jsonb_typeof(item)<>'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 240 OR btrim(item #>> '{}')<>item #>> '{}')
  OR EXISTS (SELECT 1 FROM (SELECT entry,lag(entry->>'offerVersion') OVER (ORDER BY ordinality) AS previous_offer
     FROM jsonb_array_elements(body->'memberships') WITH ORDINALITY AS ref(entry,ordinality)) m
    WHERE jsonb_typeof(entry)<>'object' OR NOT (entry ?& ARRAY['offerVersion','admitted'])
     OR entry - ARRAY['offerVersion','admitted']<>'{}'::jsonb
     OR jsonb_typeof(entry->'offerVersion')<>'string' OR length(entry->>'offerVersion') NOT BETWEEN 1 AND 240
     OR btrim(entry->>'offerVersion')<>entry->>'offerVersion' OR jsonb_typeof(entry->'admitted')<>'boolean'
     OR previous_offer COLLATE "C">=entry->>'offerVersion' COLLATE "C")
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(body->'identifiers') AS item
    WHERE jsonb_typeof(item)<>'object' OR NOT (item ?& ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef'])
     OR item - ARRAY['scheme','issuer','value','packagingLevel','quantity','isPrimary','label','sourceRef']<>'{}'::jsonb
     OR jsonb_typeof(item->'scheme')<>'string' OR length(item->>'scheme') NOT BETWEEN 1 AND 240 OR btrim(item->>'scheme')<>item->>'scheme'
     OR jsonb_typeof(item->'issuer')<>'string' OR length(item->>'issuer') NOT BETWEEN 1 AND 240 OR btrim(item->>'issuer')<>item->>'issuer'
     OR jsonb_typeof(item->'value')<>'string' OR length(item->>'value') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(item->'packagingLevel')<>'string' OR item->>'packagingLevel' NOT IN ('unit','case')
     OR jsonb_typeof(item->'quantity')<>'number' OR item->>'quantity' !~ '^[1-9][0-9]{0,5}$'
     OR (item->>'packagingLevel'='unit') IS DISTINCT FROM (item->>'quantity'='1')
     OR jsonb_typeof(item->'isPrimary')<>'boolean'
     OR (item->'isPrimary'='true'::jsonb AND (item->>'scheme'<>'gs1:gtin' OR item->>'packagingLevel'<>'unit'))
     OR jsonb_typeof(item->'label') NOT IN ('string','null') OR length(item->>'label') NOT BETWEEN 1 AND 500
     OR btrim(item->>'label')<>item->>'label'
     OR jsonb_typeof(item->'sourceRef') NOT IN ('string','null') OR length(item->>'sourceRef') NOT BETWEEN 1 AND 240
     OR btrim(item->>'sourceRef')<>item->>'sourceRef')
  OR (SELECT count(*) FROM jsonb_array_elements(body->'identifiers') AS item WHERE item->'isPrimary'='true'::jsonb)>1
  OR length(body->>'logisticsRef') NOT BETWEEN 1 AND 500 OR btrim(body->>'logisticsRef')<>body->>'logisticsRef' THEN
  RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.catalog_publications p WHERE p.product_id=NEW.product_id AND p.id=NEW.publication_id
    AND p.issued_count>=NEW.issue_ordinal) THEN
  RAISE EXCEPTION 'catalog_publication_issue_sealed' USING ERRCODE='23514', CONSTRAINT='catalog_publication_issue_sealed';
 END IF;
 IF NOT EXISTS (
    SELECT 1 FROM public.catalog_draft_revisions d JOIN public.catalog_draft_command_receipts r
     ON (d.draft_id,d.command_key,d.revision,d.fingerprint)=(r.draft_id,r.command_key,r.revision,r.fingerprint)
    WHERE d.draft_id=(body #>> '{source,draftId}')::uuid AND d.revision=(body #>> '{source,revision}')::integer
     AND d.product_id=NEW.product_id AND d.status='open'
     AND body->'source'=jsonb_build_object('draftId',d.draft_id,'revision',d.revision,'commandKey',d.command_key,'fingerprint',d.fingerprint)) THEN
  RAISE EXCEPTION 'catalog_publication_candidate_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_candidate_invalid';
 END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'catalog_publication_sku_revision_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_sku_revision_invalid';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_sku_admit() FROM PUBLIC;

CREATE FUNCTION public.catalog_publication_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
 IF TG_OP <> 'INSERT' AND TG_TABLE_NAME IN ('catalog_publications','catalog_operator_receipts','catalog_publication_decisions') THEN
  RAISE EXCEPTION 'catalog_publication_record_immutable' USING ERRCODE='23514',
    CONSTRAINT='catalog_publication_record_immutable';
 END IF;
 CASE TG_TABLE_NAME
 WHEN 'catalog_publications' THEN
  PERFORM public.catalog_publication_assert_issued(NEW.product_id,NEW.id);
  PERFORM public.catalog_publication_assert_head(NEW.product_id,true);
 WHEN 'catalog_operator_receipts' THEN
  PERFORM public.catalog_publication_assert_receipt(NEW.scope_id,NEW.command_key);
 WHEN 'catalog_publication_decisions' THEN
  PERFORM public.catalog_publication_assert_receipt(NEW.product_id,NEW.command_key);
  PERFORM public.catalog_publication_candidate_source(NEW.product_id,NEW.candidate_ref,NEW.candidate_digest);
 WHEN 'catalog_publication_heads' THEN
  IF TG_OP <> 'DELETE' THEN PERFORM public.catalog_publication_assert_head(NEW.product_id,true); END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.product_id<>OLD.product_id) THEN
   PERFORM public.catalog_publication_assert_head(OLD.product_id,true);
  END IF;
 WHEN 'catalog_publication_pointer_capabilities' THEN
  IF TG_OP='UPDATE' THEN
   RAISE EXCEPTION 'catalog_publication_pointer_capability_unconsumed' USING ERRCODE='23514',
     CONSTRAINT='catalog_publication_pointer_capability_unconsumed';
  END IF;
  PERFORM public.catalog_publication_assert_head(NEW.product_id,true);
  IF EXISTS (SELECT 1 FROM public.catalog_publication_pointer_capabilities c
    WHERE (c.transaction_id,c.product_id,c.revision_id,c.command_fingerprint)=
          (NEW.transaction_id,NEW.product_id,NEW.revision_id,NEW.command_fingerprint)) THEN
   RAISE EXCEPTION 'catalog_publication_pointer_capability_unconsumed' USING ERRCODE='23514',
     CONSTRAINT='catalog_publication_pointer_capability_unconsumed';
  END IF;
 END CASE;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_publication_admit() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER catalog_publications_issued AFTER INSERT OR UPDATE OR DELETE ON public.catalog_publications
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_admit();
CREATE CONSTRAINT TRIGGER catalog_sku_revisions_issued AFTER INSERT OR UPDATE OR DELETE ON public.catalog_sku_revisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_sku_admit();
CREATE CONSTRAINT TRIGGER catalog_receipts_issued AFTER INSERT OR UPDATE OR DELETE ON public.catalog_operator_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_admit();
CREATE CONSTRAINT TRIGGER catalog_decisions_issued AFTER INSERT OR UPDATE OR DELETE ON public.catalog_publication_decisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_admit();
CREATE CONSTRAINT TRIGGER catalog_heads_issued AFTER INSERT OR UPDATE OR DELETE ON public.catalog_publication_heads
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_admit();
CREATE CONSTRAINT TRIGGER catalog_pointer_capabilities_consumed AFTER INSERT OR UPDATE ON public.catalog_publication_pointer_capabilities
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.catalog_publication_admit();
