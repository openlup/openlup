REVOKE ALL ON FUNCTION public.subscription_activate_from_captured_payment(text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_activation_commit(public.subscription_activations,text,text,timestamptz,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_activate_from_captured_payment(text,uuid,text), public.subscription_activation_commit(public.subscription_activations,text,text,timestamptz,boolean) TO service_role;'; END IF; END; $$;
