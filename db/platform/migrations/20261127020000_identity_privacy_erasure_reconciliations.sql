CREATE TABLE public.identity_privacy_erasure_reconciliations (
  erasure_id uuid NOT NULL REFERENCES public.identity_privacy_erasures(erasure_id),
  contributor_id text COLLATE "C" NOT NULL REFERENCES public.identity_privacy_required_contributors(contributor_id),
  evidence_ref uuid NOT NULL UNIQUE,
  PRIMARY KEY (erasure_id, contributor_id),
  CHECK (char_length(contributor_id) BETWEEN 1 AND 100
    AND contributor_id BETWEEN 'a' AND '{'
    AND translate(contributor_id, 'abcdefghijklmnopqrstuvwxyz0123456789.-', '') = '')
);

ALTER TABLE public.identity_privacy_erasure_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.identity_privacy_erasure_reconciliations FROM PUBLIC;

CREATE FUNCTION public.identity_privacy_reconciled_contributor_ids(p_erasure_id uuid)
RETURNS text[]
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(pg_catalog.array_agg(r.contributor_id ORDER BY r.contributor_id COLLATE pg_catalog."C"), ARRAY[]::text[])
  FROM public.identity_privacy_erasure_reconciliations AS r
  WHERE r.erasure_id = p_erasure_id;
$$;

REVOKE ALL ON FUNCTION public.identity_privacy_reconciled_contributor_ids(uuid) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.identity_privacy_erasure_reconciliations FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.identity_privacy_erasure_reconciliations FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.identity_privacy_erasure_reconciliations FROM service_role';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.identity_privacy_reconciled_contributor_ids(uuid) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.identity_privacy_reconciled_contributor_ids(uuid) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.identity_privacy_reconciled_contributor_ids(uuid) FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.identity_privacy_reconciled_contributor_ids(uuid) TO service_role';
END IF; END; $$;
