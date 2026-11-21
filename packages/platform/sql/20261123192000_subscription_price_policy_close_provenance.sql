-- A finite policy row carries close provenance only after a guarded close or native restore.
CREATE TABLE public.subscription_price_policy_restore_capabilities (
  transaction_id xid8 PRIMARY KEY
);

ALTER TABLE public.subscription_price_policy_restore_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_price_policy_restore_capabilities FROM PUBLIC;

CREATE FUNCTION public.subscription_price_policy_revisions_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  -- An open marked row still belongs to the existing window CHECK.
  IF NEW.closed_from_open AND NEW.effective_to IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.subscription_price_policy_restore_capabilities c
      WHERE c.transaction_id = pg_current_xact_id()
    ) THEN
      RAISE EXCEPTION 'subscription_price_policy_revision_close_provenance_requires_restore'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_price_policy_revisions_guard_insert() FROM PUBLIC;

CREATE TRIGGER subscription_price_policy_revisions_00_guard_insert
  BEFORE INSERT ON public.subscription_price_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION public.subscription_price_policy_revisions_guard_insert();
