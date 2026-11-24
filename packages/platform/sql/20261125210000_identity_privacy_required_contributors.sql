CREATE TABLE public.identity_privacy_required_contributors (
  contributor_id text PRIMARY KEY
);

ALTER TABLE public.identity_privacy_required_contributors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.identity_privacy_required_contributors FROM PUBLIC;

INSERT INTO public.identity_privacy_required_contributors (contributor_id) VALUES
  ('communication-events'),
  ('customer-billing'),
  ('customer-preferences'),
  ('customer-saved-addresses'),
  ('destination-documents'),
  ('destination-receipts'),
  ('fulfillment-parcel-contacts'),
  ('identity'),
  ('subscriptions'),
  ('tax-calculations')
ON CONFLICT (contributor_id) DO NOTHING;

CREATE FUNCTION public.identity_privacy_required_contributor_ids()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.array_agg(contributor_id ORDER BY contributor_id COLLATE pg_catalog."C")
  FROM public.identity_privacy_required_contributors;
$$;

REVOKE ALL ON FUNCTION public.identity_privacy_required_contributor_ids() FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.identity_privacy_required_contributors FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.identity_privacy_required_contributors FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.identity_privacy_required_contributors FROM service_role';
END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.identity_privacy_required_contributor_ids() FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.identity_privacy_required_contributor_ids() FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.identity_privacy_required_contributor_ids() FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.identity_privacy_required_contributor_ids() TO service_role';
END IF; END; $$;
