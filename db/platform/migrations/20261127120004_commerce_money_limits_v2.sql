CREATE TABLE public.commerce_money_limits_v2 (
  installation_ref text NOT NULL CHECK (octet_length(installation_ref) BETWEEN 1 AND 200),
  channel_key text NOT NULL CHECK (octet_length(channel_key) BETWEEN 1 AND 200),
  method_key text NOT NULL CHECK (octet_length(method_key) BETWEEN 1 AND 200),
  provider_key text NOT NULL CHECK (octet_length(provider_key) BETWEEN 1 AND 200),
  account_ref text NOT NULL CHECK (octet_length(account_ref) BETWEEN 1 AND 200),
  mode text NOT NULL CHECK (octet_length(mode) = 4),
  currency text NOT NULL CHECK (octet_length(currency) = 3),
  profile_ref text NOT NULL CHECK (octet_length(profile_ref) BETWEEN 1 AND 200),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  min_minor bigint NOT NULL CHECK (min_minor BETWEEN 0 AND 9007199254740991),
  max_minor bigint NOT NULL CHECK (max_minor BETWEEN 1 AND 9007199254740991),
  active boolean NOT NULL,
  PRIMARY KEY (installation_ref, channel_key, method_key, provider_key, account_ref, mode, currency),
  CHECK (min_minor BETWEEN 0 AND max_minor)
);

CREATE FUNCTION public.commerce_money_limits_v2_validate(p_document jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_field text := '/';
  v_text text;
  v_min numeric;
  v_max numeric;
  v_tuple_bytes integer := 0;
BEGIN
  <<validation>>
  BEGIN
    IF jsonb_typeof(p_document) IS DISTINCT FROM 'object' THEN EXIT validation; END IF;
    IF EXISTS (SELECT FROM jsonb_object_keys(p_document) AS k
      WHERE k NOT IN ('schemaVersion','installationRef','channelKey','methodKey','providerKey',
        'accountRef','mode','currency','profileRef','minMinor','maxMinor','active'))
    THEN EXIT validation; END IF;

    v_field := '/schemaVersion';
    IF (p_document->'schemaVersion') IS DISTINCT FROM '2'::jsonb THEN EXIT validation; END IF;
    FOREACH v_key IN ARRAY ARRAY['installationRef','channelKey','methodKey','providerKey','accountRef','profileRef'] LOOP
      v_field := '/' || v_key;
      v_text := p_document->>v_key;
      IF jsonb_typeof(p_document->v_key) IS DISTINCT FROM 'string'
        OR octet_length(convert_to(v_text,'UTF8')) NOT BETWEEN 1 AND 200
      THEN EXIT validation; END IF;
      IF v_key <> 'profileRef' THEN v_tuple_bytes := v_tuple_bytes + octet_length(convert_to(v_text,'UTF8')); END IF;
    END LOOP;
    v_field := '/mode';
    IF (p_document->'mode') IS DISTINCT FROM '"test"'::jsonb
      AND (p_document->'mode') IS DISTINCT FROM '"live"'::jsonb THEN EXIT validation; END IF;
    v_field := '/currency';
    IF jsonb_typeof(p_document->'currency') IS DISTINCT FROM 'string'
      OR (p_document->>'currency') COLLATE pg_catalog."C" !~ '^[A-Z]{3}$'
    THEN EXIT validation; END IF;
    v_field := '/';
    IF v_tuple_bytes + 7 > 1007 THEN EXIT validation; END IF;
    v_field := '/minMinor';
    IF jsonb_typeof(p_document->'minMinor') IS DISTINCT FROM 'number' THEN EXIT validation; END IF;
    v_min := (p_document->>'minMinor')::numeric;
    IF v_min NOT BETWEEN 0 AND 9007199254740991 OR v_min <> trunc(v_min) THEN EXIT validation; END IF;
    v_field := '/maxMinor';
    IF jsonb_typeof(p_document->'maxMinor') IS DISTINCT FROM 'number' THEN EXIT validation; END IF;
    v_max := (p_document->>'maxMinor')::numeric;
    IF v_max NOT BETWEEN greatest(1,v_min) AND 9007199254740991 OR v_max <> trunc(v_max)
    THEN EXIT validation; END IF;
    v_field := '/active';
    IF jsonb_typeof(p_document->'active') IS DISTINCT FROM 'boolean' THEN EXIT validation; END IF;
    RETURN p_document;
  END validation;
  RAISE EXCEPTION 'money_limits_invalid_input' USING ERRCODE='22023', DETAIL=v_field,
    HINT='Correct the indicated field using the documented payment limits input.';
END;
$$;

CREATE FUNCTION public.commerce_money_limits_read_v2(p_installation_ref text, p_channel_key text,
  p_method_key text, p_provider_key text, p_account_ref text, p_mode text, p_currency text)
RETURNS SETOF public.commerce_money_limits_v2 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r public.commerce_money_limits_v2;
BEGIN
  SELECT * INTO r FROM public.commerce_money_limits_v2
  WHERE (installation_ref,channel_key,method_key,provider_key,account_ref,mode,currency)
    = (p_installation_ref,p_channel_key,p_method_key,p_provider_key,p_account_ref,p_mode,p_currency)
    AND active;
  IF FOUND THEN
    PERFORM public.commerce_money_limits_v2_validate(jsonb_build_object(
      'schemaVersion',2,'installationRef',r.installation_ref,'channelKey',r.channel_key,
      'methodKey',r.method_key,'providerKey',r.provider_key,'accountRef',r.account_ref,
      'mode',r.mode,'currency',r.currency,'profileRef',r.profile_ref,
      'minMinor',r.min_minor,'maxMinor',r.max_minor,'active',r.active));
    RETURN NEXT r;
  END IF;
END;
$$;

CREATE FUNCTION public.commerce_money_limits_v2_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'money_limits_delete_forbidden' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.installation_ref,NEW.channel_key,NEW.method_key,NEW.provider_key,
         NEW.account_ref,NEW.mode,NEW.currency,NEW.profile_ref)
    IS DISTINCT FROM ROW(OLD.installation_ref,OLD.channel_key,OLD.method_key,OLD.provider_key,
         OLD.account_ref,OLD.mode,OLD.currency,OLD.profile_ref)
    OR NEW.revision::bigint IS DISTINCT FROM OLD.revision::bigint + 1
  THEN
    RAISE EXCEPTION 'money_limits_identity_or_revision_invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_money_limits_v2_guard
BEFORE UPDATE OR DELETE ON public.commerce_money_limits_v2
FOR EACH ROW EXECUTE FUNCTION public.commerce_money_limits_v2_guard();

ALTER TABLE public.commerce_money_limits_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_money_limits_v2 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_money_limits_v2_validate(jsonb), public.commerce_money_limits_read_v2(text,text,text,text,text,text,text), public.commerce_money_limits_v2_guard() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_money_limits_v2 FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_money_limits_v2 FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_money_limits_v2 FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_money_limits_v2_validate(jsonb), public.commerce_money_limits_read_v2(text,text,text,text,text,text,text), public.commerce_money_limits_v2_guard() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_money_limits_v2_validate(jsonb), public.commerce_money_limits_read_v2(text,text,text,text,text,text,text), public.commerce_money_limits_v2_guard() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_money_limits_v2_validate(jsonb), public.commerce_money_limits_read_v2(text,text,text,text,text,text,text), public.commerce_money_limits_v2_guard() FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_money_limits_read_v2(text,text,text,text,text,text,text) TO service_role;'; END IF; END; $$;
