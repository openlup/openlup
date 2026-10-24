-- Legacy signatures fail closed; no worker may infer a claim generation.
CREATE OR REPLACE FUNCTION public.accounting_invoice_correction_outbox_claim(
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'accounting_invoice_correction_claim_contract_required' USING ERRCODE = '22023';
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_invoice_correction_outbox_claim(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_invoice_correction_outbox_claim(integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.accounting_invoice_correction_outbox_succeed(
  p_outbox_id uuid, p_provider_invoice_id text, p_provider_invoice_number text, p_provider_raw jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT jsonb_build_object('ok', false, 'code', 'accounting_invoice_correction_claim_fence_required'); $$;
REVOKE ALL ON FUNCTION public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.accounting_invoice_correction_outbox_fail(
  p_outbox_id uuid, p_error jsonb, p_retry_seconds integer DEFAULT 900
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT jsonb_build_object('ok', false, 'code', 'accounting_invoice_correction_claim_fence_required'); $$;
REVOKE ALL ON FUNCTION public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer) TO service_role;
