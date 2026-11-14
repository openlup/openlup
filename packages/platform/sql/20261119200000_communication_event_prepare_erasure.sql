CREATE FUNCTION public.communication_event_prepare_erasure() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN LOCK TABLE public.communication_event_receipts IN SHARE ROW EXCLUSIVE MODE; RETURN 'true'; END; $$;

REVOKE ALL ON FUNCTION public.communication_event_prepare_erasure() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.communication_event_prepare_erasure() FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.communication_event_prepare_erasure() FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.communication_event_prepare_erasure() TO service_role'; END IF; END; $$;
