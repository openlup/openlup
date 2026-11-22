-- Managed divergence: preserve the legacy limiter and install the private checkout ledger alongside it.
-- Clear the managed baseline reader default so the table ACL matches native.
CREATE TABLE public.commerce_checkout_attempt_ledger (
  attempt_digest text PRIMARY KEY CHECK (length(attempt_digest) = 64 AND translate(attempt_digest, '0123456789abcdef', '') = ''),
  requester_digest text NOT NULL CHECK (length(requester_digest) = 64 AND translate(requester_digest, '0123456789abcdef', '') = ''),
  email_digest text NOT NULL CHECK (length(email_digest) = 64 AND translate(email_digest, '0123456789abcdef', '') = ''),
  recorded_at_ms bigint NOT NULL
);

ALTER TABLE public.commerce_checkout_attempt_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_checkout_attempt_ledger FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_checkout_attempt_ledger FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_checkout_attempt_ledger FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_checkout_attempt_ledger FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='openlup_mcp_reader') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_checkout_attempt_ledger FROM openlup_mcp_reader'; END IF; END; $$;

CREATE FUNCTION public.commerce_record_checkout_attempt(
  p_attempt_digest text,
  p_requester_digest text,
  p_email_digest text,
  p_window_ms bigint,
  p_retention_ms bigint,
  p_max_per_email bigint,
  p_max_per_requester bigint,
  p_max_entries bigint
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_digest text;
  v_policy_value bigint;
  v_now_ms bigint;
  v_email_count bigint;
  v_requester_count bigint;
  v_retained_count bigint;
BEGIN
  FOREACH v_digest IN ARRAY ARRAY[p_attempt_digest, p_requester_digest, p_email_digest] LOOP
    IF v_digest IS NULL OR length(v_digest) <> 64 OR translate(v_digest, '0123456789abcdef', '') <> '' THEN
      RAISE EXCEPTION 'checkout_attempt_invalid_digest' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOREACH v_policy_value IN ARRAY ARRAY[p_window_ms, p_retention_ms, p_max_per_email, p_max_per_requester, p_max_entries] LOOP
    IF v_policy_value IS NULL OR v_policy_value NOT BETWEEN 1 AND 9007199254740991 THEN
      RAISE EXCEPTION 'checkout_attempt_invalid_policy' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_retention_ms < p_window_ms THEN
    RAISE EXCEPTION 'checkout_attempt_invalid_policy' USING ERRCODE = '22023';
  END IF;
  -- A transaction snapshot taken before the lock cannot enforce the quotas.
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'checkout_attempt_isolation_unsupported' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.commerce_checkout_attempt_ledger IN SHARE ROW EXCLUSIVE MODE;
  v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  DELETE FROM public.commerce_checkout_attempt_ledger
  WHERE recorded_at_ms <= v_now_ms - p_retention_ms;

  IF EXISTS (SELECT 1 FROM public.commerce_checkout_attempt_ledger WHERE attempt_digest = p_attempt_digest) THEN
    RETURN '{"allowed":true}'::jsonb;
  END IF;

  SELECT count(*) FILTER (WHERE recorded_at_ms > v_now_ms - p_window_ms AND email_digest = p_email_digest),
         count(*) FILTER (WHERE recorded_at_ms > v_now_ms - p_window_ms AND requester_digest = p_requester_digest),
         count(*)
    INTO v_email_count, v_requester_count, v_retained_count
    FROM public.commerce_checkout_attempt_ledger;
  IF v_email_count >= p_max_per_email THEN
    RETURN '{"allowed":false,"reason":"email_quota"}'::jsonb;
  END IF;
  IF v_requester_count >= p_max_per_requester THEN
    RETURN '{"allowed":false,"reason":"ip_quota"}'::jsonb;
  END IF;
  IF v_retained_count >= p_max_entries THEN
    RETURN '{"allowed":false}'::jsonb;
  END IF;

  INSERT INTO public.commerce_checkout_attempt_ledger (attempt_digest, requester_digest, email_digest, recorded_at_ms)
  VALUES (p_attempt_digest, p_requester_digest, p_email_digest, v_now_ms);
  RETURN '{"allowed":true}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_record_checkout_attempt(text,text,text,bigint,bigint,bigint,bigint,bigint) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_record_checkout_attempt(text,text,text,bigint,bigint,bigint,bigint,bigint) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_record_checkout_attempt(text,text,text,bigint,bigint,bigint,bigint,bigint) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_record_checkout_attempt(text,text,text,bigint,bigint,bigint,bigint,bigint) TO service_role'; END IF; END; $$;
