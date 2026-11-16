-- Preserve the original digest end for the existing one-time NULL-to-finite close.
-- The marker is false on pre-forward rows: their current tuple must still verify.
-- No data rewrite, policy writer, schedule or runtime capability is installed.
ALTER TABLE public.subscription_price_policy_revisions
  ADD COLUMN closed_from_open boolean NOT NULL DEFAULT false;

ALTER TABLE public.subscription_price_policy_revisions
  ADD CONSTRAINT subscription_price_policy_revisions_closed_from_open_check
  CHECK (NOT closed_from_open OR effective_to IS NOT NULL) NOT VALID;

ALTER TABLE public.subscription_price_policy_revisions
  VALIDATE CONSTRAINT subscription_price_policy_revisions_closed_from_open_check;

CREATE OR REPLACE FUNCTION public.subscription_price_policy_revisions_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subscription_price_policy_revision_immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.effective_to IS NOT NULL
    OR NEW.effective_to IS NULL
    OR NEW.effective_to <= OLD.effective_from
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.price_list_id IS DISTINCT FROM OLD.price_list_id
    OR NEW.region_code IS DISTINCT FROM OLD.region_code
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
    OR NEW.discount_bps IS DISTINCT FROM OLD.discount_bps
    OR NEW.rounding_quantum_minor IS DISTINCT FROM OLD.rounding_quantum_minor
    OR NEW.rounding_rule IS DISTINCT FROM OLD.rounding_rule
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.closed_from_open IS DISTINCT FROM OLD.closed_from_open
  THEN
    RAISE EXCEPTION 'subscription_price_policy_revision_close_only'
      USING ERRCODE = '55000';
  END IF;

  -- The only admitted close starts with a NULL end; retain that digest input.
  NEW.closed_from_open := true;
  RETURN NEW;
END;
$$;
