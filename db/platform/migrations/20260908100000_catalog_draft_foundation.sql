-- Draft foundation installs empty, isolated authoring tables and bounded command/read routines.
-- Immutable revisions and receipts retain original replay results; identity reservations survive abandonment.
-- No current catalog, document, pricing, stock, publication or subscription row is changed.
-- migration:allow-trigger: reject edits and deletion of immutable draft revision and command history.
-- migration:allow-rls: new tables default-deny all browser access; callers use bounded routines.
-- migration:allow-grant: revoke inherited table/routine privileges before granting the intended routine access.
-- migration:allow-dynamic-ddl: withdraw inherited nonowner ACL using catalog identities and quoted role names.
-- migration:allow-dml: transactional routines write only the four new draft-owned relations.
-- Owner-only INVOKER routines require externally verified operator context; no human-login or publication parity is claimed.
CREATE TABLE public.catalog_draft_heads (
  draft_id uuid PRIMARY KEY, product_id uuid NOT NULL UNIQUE,
  revision integer NOT NULL CHECK (revision > 0), status text NOT NULL CHECK (status IN ('open', 'abandoned'))
);
CREATE TABLE public.catalog_draft_revisions (
  draft_id uuid NOT NULL REFERENCES public.catalog_draft_heads(draft_id), revision integer NOT NULL CHECK (revision > 0),
  product_id uuid NOT NULL, status text NOT NULL CHECK (status IN ('open', 'abandoned')),
  payload jsonb NOT NULL, command_key text NOT NULL, fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (draft_id, revision)
);
CREATE TABLE public.catalog_draft_command_receipts (
  draft_id uuid NOT NULL, command_key text NOT NULL, fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL, PRIMARY KEY (draft_id, command_key),
  FOREIGN KEY (draft_id, revision) REFERENCES public.catalog_draft_revisions(draft_id, revision)
);
CREATE TABLE public.catalog_draft_sku_reservations (
  sku_id uuid PRIMARY KEY, draft_id uuid NOT NULL REFERENCES public.catalog_draft_heads(draft_id),
  product_id uuid NOT NULL, code text UNIQUE CHECK (code IS NULL OR (btrim(code) = code AND length(code) BETWEEN 1 AND 160))
);
CREATE FUNCTION public.catalog_draft_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'catalog_draft_history_immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER catalog_draft_revisions_immutable BEFORE UPDATE OR DELETE ON public.catalog_draft_revisions
  FOR EACH ROW EXECUTE FUNCTION public.catalog_draft_reject_mutation();
CREATE TRIGGER catalog_draft_receipts_immutable BEFORE UPDATE OR DELETE ON public.catalog_draft_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.catalog_draft_reject_mutation();
ALTER TABLE public.catalog_draft_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_draft_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_draft_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_draft_sku_reservations ENABLE ROW LEVEL SECURITY;


CREATE FUNCTION public.catalog_draft_record(p_draft_id uuid, p_revision integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('draftId', draft_id, 'productId', product_id, 'revision', revision,
    'status', status, 'payload', payload, 'commandKey', command_key, 'fingerprint', fingerprint,
    'actorId', actor_id, 'createdAt', created_at)
  FROM public.catalog_draft_revisions WHERE draft_id = p_draft_id AND revision = p_revision
$$;
CREATE FUNCTION public.catalog_draft_apply(p_canonical_command text, p_fingerprint text, p_actor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  c jsonb; p jsonb; s jsonb; h public.catalog_draft_heads%ROWTYPE;
  receipt public.catalog_draft_command_receipts%ROWTYPE; reserved public.catalog_draft_sku_reservations%ROWTYPE;
  d uuid; product uuid; sku uuid; key text; action text; expected integer; next_revision integer;
  actor text; state text; code_value text;
BEGIN
  actor := p_actor_id; IF actor IS NULL OR actor <> btrim(actor) OR length(actor) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'catalog_draft_actor_required' USING ERRCODE='42501'; END IF;
  IF p_canonical_command IS NULL OR octet_length(p_canonical_command) NOT BETWEEN 2 AND 1048576
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_canonical_command, 'UTF8')), 'hex') <> p_fingerprint THEN
    RETURN jsonb_build_object('outcome','validation_issue','reason','command_fingerprint_invalid');
  END IF;
  c := p_canonical_command::jsonb;
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR c->>'action' IS NULL OR c->>'action' NOT IN ('create','revise','abandon')
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
  IF h.status = 'abandoned' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_abandoned','currentRevision',h.revision); END IF;
  next_revision := coalesce(h.revision,0) + 1;
  state := CASE WHEN action = 'abandon' THEN 'abandoned' ELSE 'open' END;
  IF action = 'abandon' THEN
    IF c ? 'payload' THEN RETURN jsonb_build_object('outcome','validation_issue','reason','abandon_payload_invalid'); END IF;
    SELECT payload INTO p FROM public.catalog_draft_revisions WHERE draft_id = d AND revision = h.revision;
    product := h.product_id;
  ELSE
    p := c->'payload';
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'schemaVersion' IS DISTINCT FROM '1'::jsonb
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
    IF action <> 'abandon' THEN
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
CREATE FUNCTION public.catalog_draft_get(p_draft_id uuid, p_revision integer DEFAULT NULL, p_command_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER STABLE SET search_path = pg_catalog, public AS $$
DECLARE r integer;
BEGIN
  -- Owner-only: verified operator context is supplied at the dark domain boundary.
  IF p_revision IS NOT NULL AND p_command_key IS NOT NULL THEN RAISE EXCEPTION 'read_selector_invalid' USING ERRCODE='22023'; END IF;
  IF p_command_key IS NOT NULL THEN
    SELECT revision INTO r FROM public.catalog_draft_command_receipts WHERE draft_id=p_draft_id AND command_key=p_command_key;
  ELSIF p_revision IS NOT NULL THEN r := p_revision;
  ELSE SELECT revision INTO r FROM public.catalog_draft_heads WHERE draft_id=p_draft_id; END IF;
  RETURN public.catalog_draft_record(p_draft_id,r);
END;
$$;
CREATE FUNCTION public.catalog_draft_list(p_after_draft_id uuid DEFAULT NULL, p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER STABLE SET search_path = pg_catalog, public AS $$
DECLARE result jsonb;
BEGIN
  -- Owner-only: verified operator context is supplied at the dark domain boundary.
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'list_limit_invalid' USING ERRCODE='22023'; END IF;
  WITH page AS (SELECT draft_id,revision FROM public.catalog_draft_heads
    WHERE p_after_draft_id IS NULL OR draft_id > p_after_draft_id ORDER BY draft_id LIMIT p_limit+1),
  visible AS (SELECT * FROM page ORDER BY draft_id LIMIT p_limit)
  SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
    'draftId',r.draft_id,'productId',r.product_id,'revision',r.revision,'status',r.status,
    'commandKey',r.command_key,'fingerprint',r.fingerprint,'actorId',r.actor_id,'createdAt',r.created_at) ORDER BY r.draft_id),'[]'::jsonb),
    'nextCursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN (SELECT draft_id::text FROM visible ORDER BY draft_id DESC LIMIT 1) END)
    INTO result FROM visible v JOIN public.catalog_draft_revisions r ON r.draft_id=v.draft_id AND r.revision=v.revision;
  RETURN result;
END;
$$;
REVOKE ALL ON TABLE public.catalog_draft_heads, public.catalog_draft_revisions,
  public.catalog_draft_command_receipts, public.catalog_draft_sku_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.catalog_draft_reject_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.catalog_draft_record(uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.catalog_draft_apply(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.catalog_draft_get(uuid,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.catalog_draft_list(uuid,integer) FROM PUBLIC, anon, authenticated;

DO $$ DECLARE observer record; BEGIN
  FOR observer IN SELECT DISTINCT roles.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles roles ON roles.oid=a.grantee
    WHERE c.oid IN ('public.catalog_draft_heads'::regclass,'public.catalog_draft_revisions'::regclass,
      'public.catalog_draft_command_receipts'::regclass,'public.catalog_draft_sku_reservations'::regclass)
      AND a.grantee<>c.relowner LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.catalog_draft_heads, public.catalog_draft_revisions, public.catalog_draft_command_receipts, public.catalog_draft_sku_reservations FROM %I',observer.rolname);
  END LOOP;
  FOR observer IN SELECT p.oid::regprocedure routine,roles.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles roles ON roles.oid=a.grantee
    WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_draft_%' AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',observer.routine,observer.rolname);
  END LOOP;
END $$;
