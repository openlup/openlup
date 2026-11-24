CREATE TABLE public.tax_calculations (
  calculation_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('pending','terminal','erased')),
  locator text UNIQUE CHECK (length(locator) = 64 AND translate(locator,'0123456789abcdef','') = ''),
  identity jsonb,
  snapshot_ref uuid REFERENCES public.commerce_destination_v2_documents(snapshot_ref),
  coverage_installation_ref text,
  coverage_account_ref text,
  coverage_revision text,
  pin jsonb,
  pin_digest text CHECK (length(pin_digest) = 64 AND translate(pin_digest,'0123456789abcdef','') = ''),
  issued_at timestamptz,
  lease_until timestamptz,
  generation integer CHECK (generation BETWEEN 1 AND 2147483647),
  claim_token uuid,
  outcome_text text CHECK (octet_length(outcome_text) BETWEEN 1 AND 1048576),
  outcome_digest text CHECK (length(outcome_digest) = 64 AND translate(outcome_digest,'0123456789abcdef','') = ''),
  provider_digest text CHECK (length(provider_digest) = 64 AND translate(provider_digest,'0123456789abcdef','') = ''),
  contradiction boolean,
  FOREIGN KEY (coverage_installation_ref, coverage_account_ref, coverage_revision)
    REFERENCES public.tax_coverage_revisions(installation_ref, account_ref, revision) MATCH FULL,
  CHECK ((state = 'erased' AND locator IS NULL AND identity IS NULL AND snapshot_ref IS NULL AND coverage_installation_ref IS NULL
    AND pin IS NULL AND pin_digest IS NULL AND issued_at IS NULL AND lease_until IS NULL AND generation IS NULL
    AND claim_token IS NULL AND outcome_text IS NULL AND outcome_digest IS NULL AND contradiction IS NULL)
    OR (state IN ('pending','terminal') AND locator IS NOT NULL AND identity IS NOT NULL AND snapshot_ref IS NOT NULL AND pin IS NOT NULL
      AND pin_digest IS NOT NULL AND issued_at IS NOT NULL AND lease_until IS NOT NULL AND generation IS NOT NULL
      AND claim_token IS NOT NULL AND contradiction IS NOT NULL AND
      ((state = 'pending' AND outcome_text IS NULL AND outcome_digest IS NULL AND provider_digest IS NULL)
        OR (state = 'terminal' AND outcome_text IS NOT NULL AND outcome_digest IS NOT NULL))))
);
CREATE UNIQUE INDEX tax_calculations_provider_key ON public.tax_calculations (provider_digest) WHERE provider_digest IS NOT NULL;
CREATE INDEX tax_calculations_snapshot_idx ON public.tax_calculations (snapshot_ref);
ALTER TABLE public.tax_calculations ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.tax_calculation_frame_v1(p_tag text, p_body jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE frame text := public.catalog_publication_canonical(jsonb_build_array('platform.tax.' || p_tag || '.v1',p_body),0);
BEGIN
  IF octet_length(frame) > 1048576 THEN RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/'; END IF;
  RETURN frame;
END;
$$;

CREATE FUNCTION public.tax_calculation_hash_v1(p_tag text, p_body jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(public.tax_calculation_frame_v1(p_tag,p_body),'UTF8')),'hex');
$$;

CREATE FUNCTION public.tax_calculation_guard_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'identity_privacy_erasures' THEN
    -- Restoring old receipts on the pristine store uses the migration owner.
    IF current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))
      OR NEW.contributor_versions ? 'tax-calculations' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'PRIVACY_CONTRIBUTOR_MISSING' USING ERRCODE='55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state <> 'erased' AND NEW.calculation_id = OLD.calculation_id THEN
    IF NEW.state = 'erased' AND NEW.provider_digest IS NOT DISTINCT FROM OLD.provider_digest THEN RETURN NEW; END IF;
    IF OLD.state = 'pending' AND
      (to_jsonb(NEW) - ARRAY['state','generation','claim_token','lease_until','outcome_text','outcome_digest','provider_digest','contradiction'])
      = (to_jsonb(OLD) - ARRAY['state','generation','claim_token','lease_until','outcome_text','outcome_digest','provider_digest','contradiction'])
      AND ((NEW.state = 'terminal' AND NEW.generation = OLD.generation AND NEW.claim_token = OLD.claim_token
        AND NEW.lease_until = OLD.lease_until AND (NOT OLD.contradiction OR NEW.contradiction))
        OR (NEW.state = 'pending' AND ((NEW.generation::bigint = OLD.generation::bigint + 1
          AND NEW.claim_token <> OLD.claim_token AND NEW.contradiction = OLD.contradiction)
          OR (NEW.generation = OLD.generation AND NEW.claim_token = OLD.claim_token
            AND NEW.lease_until = OLD.lease_until AND NOT OLD.contradiction AND NEW.contradiction)))) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence';
END;
$$;
CREATE TRIGGER tax_calculation_guard BEFORE UPDATE OR DELETE ON public.tax_calculations FOR EACH ROW EXECUTE FUNCTION public.tax_calculation_guard_v1();
CREATE TRIGGER tax_calculation_privacy_guard BEFORE INSERT ON public.identity_privacy_erasures FOR EACH ROW EXECUTE FUNCTION public.tax_calculation_guard_v1();

CREATE FUNCTION public.tax_calculation_terminal_v1(r public.tax_calculations) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  body jsonb;
  outcome jsonb;
  quote jsonb;
BEGIN
  IF r.outcome_digest IS DISTINCT FROM encode(sha256(convert_to(r.outcome_text,'UTF8')),'hex')
    OR r.pin_digest IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-pin',r.pin)
    OR r.locator IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-key',r.identity)
    OR r.pin#>'{destination,snapshotRef}' IS DISTINCT FROM to_jsonb(r.snapshot_ref) THEN RETURN NULL; END IF;
  body := (r.outcome_text::jsonb)->1;
  IF r.outcome_text IS DISTINCT FROM public.tax_calculation_frame_v1('evaluation-outcome',body)
    OR body->'calculationId' IS DISTINCT FROM to_jsonb(r.calculation_id)
    OR body->'generation' IS DISTINCT FROM to_jsonb(r.generation)
    OR body->'invocationDigest' IS DISTINCT FROM r.pin->'invocationDigest'
    OR body->'requestDigest' IS DISTINCT FROM r.pin->'requestDigest'
    OR body->'destination' IS DISTINCT FROM r.pin->'destination'
    OR body->'kind' IS DISTINCT FROM r.pin->'kind'
    OR NOT coalesce((body->>'validUntil')::timestamptz <= (r.pin->>'validUntil')::timestamptz,false)
    OR body->'providerDigest' IS DISTINCT FROM coalesce(to_jsonb(r.provider_digest),'null'::jsonb)
    OR body->'contradiction' IS DISTINCT FROM to_jsonb(r.contradiction) THEN RETURN NULL; END IF;
  outcome := body->'outcome';
  CASE outcome->>'kind'
    WHEN 'final', 'estimate' THEN
      quote := outcome->'quote';
      IF quote->'status' IS DISTINCT FROM outcome->'kind' OR quote->'destination' IS DISTINCT FROM body->'destination'
        OR quote#>'{taxEvidence,calculationId}' IS DISTINCT FROM body->'calculationId'
        OR quote#>'{taxEvidence,kind}' IS DISTINCT FROM body->'kind'
        OR quote#>'{taxEvidence,expiresAt}' IS DISTINCT FROM body->'validUntil'
        OR quote#>>'{taxEvidence,evidenceDigest}' IS DISTINCT FROM
          public.tax_calculation_hash_v1('evaluation-evidence',body - ARRAY['outcome','submissionDigest','providerDigest','contradiction'])
        OR quote->>'quoteDigest' IS DISTINCT FROM encode(sha256(convert_to(public.catalog_publication_canonical(
          jsonb_build_array('commerce.quote.v2',quote - 'quoteDigest'),0),'UTF8')),'hex') THEN RETURN NULL; END IF;
      RETURN body || jsonb_build_object('outcome',jsonb_build_object('kind',outcome->'kind','quote',quote));
    WHEN 'refused', 'unavailable' THEN
      IF jsonb_typeof(outcome->'code') IS DISTINCT FROM 'string' OR jsonb_typeof(outcome->'field') IS DISTINCT FROM 'string'
        OR jsonb_typeof(outcome->'remedy') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
      RETURN body || jsonb_build_object('outcome',jsonb_build_object('kind',outcome->'kind','code',outcome->'code',
        'field',outcome->'field','remedy',outcome->'remedy') ||
        CASE WHEN outcome->>'kind' = 'unavailable' THEN '{"effect":"none"}'::jsonb ELSE '{}'::jsonb END);
    ELSE RETURN NULL;
  END CASE;
EXCEPTION WHEN data_exception OR check_violation THEN RETURN NULL;
END;
$$;

CREATE FUNCTION public.tax_calculation_export_v1(p_client_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('calculationId',r.calculation_id,'status',r.state,'issuedAt',
    to_char(r.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ||
    CASE WHEN r.identity->'clientId' IS DISTINCT FROM to_jsonb(p_client_id) THEN '{"verification":"failed"}'::jsonb
      WHEN r.state='pending' THEN '{}'::jsonb WHEN sealed.body IS NULL THEN '{"verification":"failed"}'::jsonb
      ELSE jsonb_build_object('outcome',sealed.body->'outcome') END ORDER BY r.calculation_id),'[]'::jsonb)
  FROM public.tax_calculations r JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref=r.snapshot_ref
  LEFT JOIN LATERAL (SELECT public.tax_calculation_terminal_v1(r) AS body WHERE r.state='terminal') sealed ON true
  WHERE d.client_id=p_client_id AND r.state<>'erased';
$$;

CREATE FUNCTION public.tax_calculation_erase_v1(p_client_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE erased integer;
BEGIN
  LOCK TABLE public.identity_privacy_erasures IN SHARE ROW EXCLUSIVE MODE;
  PERFORM FROM public.clients WHERE id=p_client_id FOR UPDATE;
  UPDATE public.tax_calculations r SET state='erased',locator=NULL,identity=NULL,snapshot_ref=NULL,
    coverage_installation_ref=NULL,coverage_account_ref=NULL,coverage_revision=NULL,pin=NULL,pin_digest=NULL,issued_at=NULL,
    lease_until=NULL,generation=NULL,claim_token=NULL,outcome_text=NULL,outcome_digest=NULL,contradiction=NULL
    FROM public.commerce_destination_v2_documents d WHERE r.snapshot_ref=d.snapshot_ref AND d.client_id=p_client_id;
  GET DIAGNOSTICS erased=ROW_COUNT;
  RETURN erased;
END;
$$;

REVOKE ALL ON TABLE public.tax_calculations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax_calculation_frame_v1(text,jsonb), public.tax_calculation_hash_v1(text,jsonb), public.tax_calculation_guard_v1(), public.tax_calculation_terminal_v1(public.tax_calculations), public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.tax_calculations FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.tax_calculations FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.tax_calculations FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_frame_v1(text,jsonb), public.tax_calculation_hash_v1(text,jsonb), public.tax_calculation_guard_v1(), public.tax_calculation_terminal_v1(public.tax_calculations), public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_frame_v1(text,jsonb), public.tax_calculation_hash_v1(text,jsonb), public.tax_calculation_guard_v1(), public.tax_calculation_terminal_v1(public.tax_calculations), public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_frame_v1(text,jsonb), public.tax_calculation_hash_v1(text,jsonb), public.tax_calculation_guard_v1(), public.tax_calculation_terminal_v1(public.tax_calculations), public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.tax_calculation_export_v1(uuid), public.tax_calculation_erase_v1(uuid) TO service_role;';
END IF; END; $$;
