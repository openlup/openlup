CREATE OR REPLACE FUNCTION public.tax_calculation_terminal_v1(r public.tax_calculations) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  body jsonb;
  outcome jsonb;
  quote jsonb;
  approved_remedy text;
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
    OR NOT coalesce(jsonb_typeof(body->'invocationDigest')='string' AND body->>'invocationDigest' COLLATE "C" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(body->'requestDigest')='string' AND body->>'requestDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false)
    OR body->'destination' IS DISTINCT FROM r.pin->'destination'
    OR body->'kind' IS DISTINCT FROM r.pin->'kind'
    OR NOT coalesce(body->>'kind' IN ('tax_calculation','fiscal_profile'),false)
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
      SELECT permitted.remedy INTO approved_remedy FROM (VALUES
        ('refused','tax_provider_reference_conflict','/taxEvidence','Reconcile the original calculation with the tax adapter owner before further work.'),
        ('refused','tax_evaluation_integrity_invalid','/taxEvidence','Recover the original evaluation from its authoritative owner.'),
        ('refused','tax_calculation_expired','/taxEvidence/expiresAt','Select the destination again and obtain a fresh quote.'),
        ('refused','commerce_destination_owner_mismatch','/destination/snapshotRef','Re-obtain evidence through the authenticated owner.'),
        ('refused','destination_digest_mismatch','/destination/destinationDigest','Replay the original document and its digest.'),
        ('refused','tax_reference_conflict','/coverage','Recover the verified original history through its owner.'),
        ('unavailable','tax_adapter_unavailable','/taxEvidence','Request a new quote when the tax service is available.'),
        ('unavailable','tax_coverage_evidence_unavailable','/taxEvidence','Request a new quote when the tax service is available.')
      ) permitted(arm, code, field, remedy)
      WHERE to_jsonb(permitted.arm)=outcome->'kind' AND to_jsonb(permitted.code)=outcome->'code'
        AND to_jsonb(permitted.field)=outcome->'field';
      IF approved_remedy IS NULL OR outcome->'remedy' IS DISTINCT FROM to_jsonb(approved_remedy) THEN RETURN NULL; END IF;
      RETURN body || jsonb_build_object('outcome',jsonb_build_object('kind',outcome->'kind','code',outcome->'code',
        'field',outcome->'field','remedy',approved_remedy) ||
        CASE WHEN outcome->>'kind' = 'unavailable' THEN '{"effect":"none"}'::jsonb ELSE '{}'::jsonb END);
    ELSE RETURN NULL;
  END CASE;
EXCEPTION WHEN data_exception OR check_violation THEN RETURN NULL;
END;
$$;

CREATE FUNCTION public.tax_calculation_transition_v1(p_request jsonb, p_complete boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  identity jsonb := p_request->'identity';
  client uuid;
  principal uuid;
  installation text := identity->>'installationRef';
  operation text := p_request->>'operation';
  invocation text;
  locator_key text;
  ctx jsonb;
  r public.tax_calculations;
  sealed public.tax_calculations;
  pinned jsonb;
  destination jsonb;
  owned jsonb;
  address jsonb;
  pinned_coverage jsonb;
  history jsonb;
  original jsonb;
  submission jsonb := p_request->'seal';
  result jsonb;
  envelope jsonb;
  terminal jsonb;
  submitted_digest text;
  provider_key text;
  constraint_name text;
  cutoff timestamptz;
  clock_value text;
  now_at timestamptz;
  code text;
  field text;
BEGIN
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR octet_length(convert_to(public.catalog_publication_canonical(p_request,0),'UTF8')) > 1048576 THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/';
  END IF;
  IF NOT coalesce((p_complete AND operation='complete') OR (NOT p_complete AND operation IN ('lookup','claim')),false)
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
    OR identity - ARRAY['installationRef','clientId','principalRef','scopeRef','evaluationKey'] <> '{}'::jsonb
    OR NOT coalesce(jsonb_typeof(identity->'installationRef')='string' AND octet_length(installation) BETWEEN 1 AND 200
      AND jsonb_typeof(identity->'evaluationKey')='string'
      AND length(identity->>'evaluationKey') + regexp_count(identity->>'evaluationKey',U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 256,false) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/identity';
  END IF;
  FOREACH field IN ARRAY ARRAY['clientId','principalRef','scopeRef'] LOOP
    IF NOT coalesce(jsonb_typeof(identity->field)='string'
      AND identity->>field COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false) THEN
      RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/identity/' || field;
    END IF;
  END LOOP;
  IF p_complete AND (jsonb_typeof(p_request->'generation') IS DISTINCT FROM 'number'
    OR NOT coalesce(p_request->>'generation' COLLATE "C" ~ '^[1-9][0-9]{0,9}$'
      AND (p_request->>'generation')::numeric <= 2147483647,false)
    OR jsonb_typeof(submission->'contradiction') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal';
  END IF;
  client := (identity->>'clientId')::uuid;
  principal := (identity->>'principalRef')::uuid;
  ctx := jsonb_build_object('clientId',client,'scopeRef',identity->'scopeRef','owner',jsonb_build_object(
    'installationRef',installation,'principalKind','customer','principalRef',principal,'customerOrSessionRef',client));
  invocation := public.tax_calculation_hash_v1('evaluation-invocation',jsonb_build_object('identity',identity,'request',p_request->'invocation'));
  locator_key := public.tax_calculation_hash_v1('evaluation-key',identity);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE='22023', DETAIL='/transaction';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  IF EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id=client OR principal_id=principal) THEN
    RAISE EXCEPTION 'destination_evidence_erased' USING ERRCODE='55000', DETAIL='/destination/snapshotRef';
  END IF;
  IF operation <> 'lookup' THEN
    PERFORM FROM public.clients WHERE id=client AND principal_id=principal AND NOT (metadata ? 'absorption') FOR UPDATE;
  ELSE
    PERFORM FROM public.clients WHERE id=client AND principal_id=principal AND NOT (metadata ? 'absorption');
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'tax_scope_mismatch' USING ERRCODE='22023', DETAIL='/destination/snapshotRef'; END IF;
  -- Read the original pin under the client fence. Historical replay needs no live destination read.
  SELECT * INTO r FROM public.tax_calculations WHERE locator=locator_key;
  IF r.calculation_id IS NOT NULL THEN
    IF r.identity IS DISTINCT FROM identity OR r.pin->>'invocationDigest' IS DISTINCT FROM invocation THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/requestKey';
    END IF;
    BEGIN
      IF r.pin_digest IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-pin',r.pin)
        OR NOT EXISTS (SELECT FROM public.commerce_destination_v2_documents d
          WHERE d.snapshot_ref=r.snapshot_ref AND d.client_id=client AND to_jsonb(d.scope_ref)=identity->'scopeRef'
            AND d.owner_scope=ctx->'owner' AND d.binding=r.pin->'destination') THEN
        RAISE EXCEPTION 'invalid pin' USING ERRCODE='22023';
      END IF;
    EXCEPTION WHEN data_exception OR check_violation THEN
      RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence';
    END;
    IF p_complete AND (r.calculation_id::text IS DISTINCT FROM p_request->>'calculationId'
      OR r.generation::text IS DISTINCT FROM p_request->>'generation' OR r.claim_token::text IS DISTINCT FROM p_request->>'claimToken') THEN
      RAISE EXCEPTION 'tax_claim_stale' USING ERRCODE='55000', DETAIL='/claim';
    END IF;
    IF r.state = 'terminal' THEN
      terminal := public.tax_calculation_terminal_v1(r);
      IF terminal IS NULL THEN RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence'; END IF;
      IF p_complete AND terminal->>'submissionDigest' IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-submission',submission) THEN
        RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence';
      END IF;
      RETURN jsonb_build_object('kind','terminal','outcome',terminal->'outcome','validUntil',terminal->'validUntil');
    END IF;
  ELSIF p_complete THEN
    RAISE EXCEPTION 'tax_claim_stale' USING ERRCODE='55000', DETAIL='/claim';
  END IF;
  IF operation = 'lookup' THEN
    RETURN jsonb_build_object('kind',CASE WHEN r.calculation_id IS NULL THEN 'missing' ELSE 'pending' END);
  END IF;
  IF NOT p_complete AND r.calculation_id IS NOT NULL AND clock_timestamp() < r.lease_until THEN
    RAISE EXCEPTION 'tax_claim_pending' USING ERRCODE='55000', DETAIL='/claim';
  END IF;
  pinned := coalesce(r.pin,p_request->'pin');
  IF NOT coalesce(pinned->>'kind' IN ('fiscal_profile','tax_calculation'), false)
    OR jsonb_path_exists(pinned->'request', '$.**.address') OR jsonb_path_exists(pinned->'request', '$.**.contact') THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/pin';
  END IF;
  destination := pinned->'destination';
  pinned_coverage := pinned->'coverage';
  IF (pinned->>'kind' = 'tax_calculation') IS DISTINCT FROM (jsonb_typeof(pinned_coverage) = 'object')
    OR NOT coalesce(pinned->>'requestDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false)
    OR (pinned->'recovery' IS DISTINCT FROM 'null'::jsonb AND (
      pinned->>'kind' <> 'tax_calculation' OR NOT coalesce(pinned->>'recovery' COLLATE "C" ~ '^[0-9a-f]{64}$',false))) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/pin';
  END IF;
  BEGIN
    FOREACH clock_value IN ARRAY ARRAY[pinned->>'validUntil',CASE WHEN p_complete THEN submission->>'validUntil' ELSE pinned->>'validUntil' END] LOOP
      IF NOT coalesce(clock_value COLLATE "C" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND to_char(clock_value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=clock_value,false) THEN
        RAISE data_exception;
      END IF;
    END LOOP;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/taxEvidence/expiresAt';
  END;
  cutoff := (pinned->>'validUntil')::timestamptz;
  BEGIN
    owned := public.commerce_read_destination_v2(ctx,'snapshot',(destination->>'snapshotRef')::uuid,destination);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS code=MESSAGE_TEXT, field=PG_EXCEPTION_DETAIL;
    IF code <> 'destination_evidence_unavailable' OR field IS DISTINCT FROM 'destination.snapshotRef' THEN RAISE; END IF;
    RAISE EXCEPTION 'commerce_destination_owner_mismatch' USING ERRCODE='55000', DETAIL='/destination/snapshotRef';
  END;
  IF pinned_coverage IS NOT NULL AND pinned_coverage <> 'null'::jsonb THEN
    BEGIN
      SELECT c.coverage INTO history FROM public.tax_coverage_read_v1(installation,pinned_coverage->>'accountRef') c
        WHERE c.revision=pinned_coverage->>'revision' AND c.coverage_digest=pinned_coverage->>'digest';
      IF NOT FOUND THEN RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/coverage'; END IF;
    EXCEPTION WHEN data_exception OR check_violation THEN
      GET STACKED DIAGNOSTICS code=MESSAGE_TEXT, field=PG_EXCEPTION_DETAIL;
      IF code NOT IN ('catalog_publication_wire_invalid','tax_reference_conflict','tax_invalid_input') THEN RAISE; END IF;
      RAISE EXCEPTION '%', CASE WHEN code='tax_invalid_input' THEN code ELSE 'tax_reference_conflict' END
        USING ERRCODE='22023', DETAIL=CASE WHEN code='tax_invalid_input' THEN field ELSE '/coverage' END,
          HINT=CASE WHEN code='tax_invalid_input' THEN 'tax_coverage_declaration_invalid'
                    ELSE 'Recover the verified original history through its owner.' END;
    END;
  END IF;
  original := pinned->'request';
  IF pinned->>'kind' = 'tax_calculation' THEN
    address := owned#>'{document,address}';
    address := (address - ARRAY['country','subdivision']) || jsonb_build_object('countryCode',address->'country')
      || CASE WHEN address ? 'subdivision' THEN jsonb_build_object('subdivisionCode',address->'subdivision') ELSE '{}'::jsonb END;
    IF original#>'{input,destination,address}' IS NOT NULL
      OR original#>'{input,destination,snapshotRef}' IS DISTINCT FROM destination->'snapshotRef'
      OR original#>'{input,destination,digest}' IS DISTINCT FROM destination->'destinationDigest'
      OR original#>'{input,destination,policyRevision}' IS DISTINCT FROM destination->'policyRevision'
      OR original#>'{input,coverage,revision}' IS DISTINCT FROM pinned_coverage->'revision'
      OR original#>'{input,scope,accountRef}' IS DISTINCT FROM pinned_coverage->'accountRef'
      OR history - 'declarations' IS DISTINCT FROM (original#>'{input,coverage}') - 'declarations'
      OR (SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(history->'declarations')) IS DISTINCT FROM
        (SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(original#>'{input,coverage,declarations}')) THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence';
    END IF;
    original := jsonb_set(original,'{input,destination,address}',address);
  END IF;
  IF public.tax_calculation_hash_v1('evaluation-request',original) IS DISTINCT FROM pinned->>'requestDigest'
    OR (r.calculation_id IS NOT NULL AND (owned->'documentDigest' IS DISTINCT FROM pinned->'documentDigest'
      OR (r.coverage_installation_ref,r.coverage_account_ref,r.coverage_revision) IS DISTINCT FROM
        (CASE WHEN history IS NOT NULL THEN installation END,pinned_coverage->>'accountRef',pinned_coverage->>'revision'))) THEN
    RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence';
  END IF;
  now_at := date_trunc('milliseconds',clock_timestamp());
  IF cutoff IS NULL OR cutoff > (owned->>'evidenceExpiresAt')::timestamptz OR clock_timestamp() >= cutoff THEN
    RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt';
  END IF;
  IF NOT p_complete THEN
    IF r.calculation_id IS NULL THEN
      pinned := pinned || jsonb_build_object('invocationDigest',invocation,'documentDigest',owned->'documentDigest');
      INSERT INTO public.tax_calculations (calculation_id,state,locator,identity,snapshot_ref,coverage_installation_ref,
        coverage_account_ref,coverage_revision,pin,pin_digest,issued_at,lease_until,generation,claim_token,contradiction)
      VALUES (gen_random_uuid(),'pending',locator_key,identity,(destination->>'snapshotRef')::uuid,
        CASE WHEN pinned_coverage->>'revision' IS NOT NULL THEN installation END,pinned_coverage->>'accountRef',pinned_coverage->>'revision',
        pinned,public.tax_calculation_hash_v1('evaluation-pin',pinned),now_at,now_at+interval '300 seconds',1,gen_random_uuid(),false)
      RETURNING * INTO r;
    ELSE
      IF r.generation = 2147483647 THEN RAISE EXCEPTION 'tax_claim_generation_exhausted' USING ERRCODE='55000', DETAIL='/claim'; END IF;
      IF pinned->'recovery' IS NULL OR pinned->'recovery' = 'null'::jsonb OR pinned->'recovery' IS DISTINCT FROM p_request->'recovery' THEN
        RAISE EXCEPTION 'tax_adapter_unavailable' USING ERRCODE='55000', DETAIL='/taxEvidence';
      END IF;
      UPDATE public.tax_calculations SET generation=generation+1,claim_token=gen_random_uuid(),lease_until=now_at+interval '300 seconds'
        WHERE calculation_id=r.calculation_id RETURNING * INTO r;
    END IF;
    IF clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt'; END IF;
    RETURN jsonb_build_object('kind','claimed','calculationId',r.calculation_id,'generation',r.generation,'claimToken',r.claim_token,'pin',pinned);
  END IF;
  IF submission->'requestDigest' IS DISTINCT FROM pinned->'requestDigest' OR submission->'kind' IS DISTINCT FROM pinned->'kind'
    OR submission->'destination' IS DISTINCT FROM destination THEN
    RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence';
  END IF;
  submitted_digest := public.tax_calculation_hash_v1('evaluation-submission',submission);
  result := submission->'outcome';
  IF NOT coalesce(result->>'kind' IN ('indeterminate','refused','unavailable','final','estimate'),false) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/outcome';
  END IF;
  IF result->>'kind' = 'indeterminate' THEN
    IF (submission->>'contradiction')::boolean AND NOT r.contradiction THEN
      UPDATE public.tax_calculations SET contradiction=true WHERE calculation_id=r.calculation_id;
    END IF;
    RETURN jsonb_build_object('kind','pending');
  END IF;
  IF (submission->>'validUntil')::timestamptz > cutoff THEN
    RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence/expiresAt';
  END IF;
  cutoff := (submission->>'validUntil')::timestamptz;
  IF cutoff IS NULL OR clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt'; END IF;
  envelope := jsonb_build_object('calculationId',r.calculation_id,'invocationDigest',invocation,'requestDigest',pinned->'requestDigest',
    'generation',r.generation,'destination',destination,'kind',pinned->'kind','evidence',submission->'evidence',
    'disposition',submission->'disposition','validUntil',submission->'validUntil');
  IF result->>'kind' IN ('final','estimate') THEN
    IF result->'kind' IS DISTINCT FROM p_request#>'{invocation,purpose}'
      OR jsonb_typeof(submission->'evidence') IS DISTINCT FROM 'object'
      OR NOT coalesce(CASE WHEN pinned->>'kind' = 'tax_calculation' THEN
        submission->>'disposition' IN ('skip','required') AND jsonb_typeof(submission#>'{evidence,adapterEvidence,calculationRef}')='string'
        AND submission#>>'{evidence,adapterDigest}' COLLATE "C" ~ '^[0-9a-f]{64}$'
        ELSE submission->>'disposition'='no_provider_posting' END,false) THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence';
    END IF;
    IF pinned->>'kind' = 'tax_calculation' THEN
      provider_key := public.tax_calculation_hash_v1('provider-calculation',jsonb_build_object('installationRef',installation,
        'adapter',original#>'{input,scope,adapter}','accountRef',original#>'{input,scope,accountRef}',
        'mode',original#>'{input,scope,mode}','providerRef',submission#>'{evidence,adapterEvidence,calculationRef}'));
    END IF;
  ELSIF submission->'evidence' IS DISTINCT FROM 'null'::jsonb
    OR submission->'disposition' IS DISTINCT FROM result->'kind'
    OR (result->>'kind'='unavailable' AND result->'effect' IS DISTINCT FROM '"none"'::jsonb) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/outcome';
  END IF;
  LOOP
    terminal := envelope || jsonb_build_object('outcome',result,'submissionDigest',submitted_digest,'providerDigest',provider_key,
      'contradiction',r.contradiction OR (submission->>'contradiction')::boolean);
    sealed := r;
    sealed.state := 'terminal';
    sealed.outcome_text := public.tax_calculation_frame_v1('evaluation-outcome',terminal);
    sealed.outcome_digest := encode(sha256(convert_to(sealed.outcome_text,'UTF8')),'hex');
    sealed.provider_digest := provider_key;
    sealed.contradiction := (terminal->>'contradiction')::boolean;
    terminal := public.tax_calculation_terminal_v1(sealed);
    IF terminal IS NULL OR terminal->'outcome' IS DISTINCT FROM result THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence';
    END IF;
    BEGIN
      UPDATE public.tax_calculations SET state=sealed.state,outcome_text=sealed.outcome_text,outcome_digest=sealed.outcome_digest,
        provider_digest=sealed.provider_digest,contradiction=sealed.contradiction WHERE calculation_id=r.calculation_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
      IF constraint_name <> 'tax_calculations_provider_key' THEN RAISE; END IF;
      provider_key := NULL;
      envelope := envelope || '{"evidence":null,"disposition":"refused"}'::jsonb;
      result := '{"kind":"refused","code":"tax_provider_reference_conflict","field":"/taxEvidence","remedy":"Reconcile the original calculation with the tax adapter owner before further work."}'::jsonb;
    END;
  END LOOP;
  IF clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt'; END IF;
  RETURN jsonb_build_object('kind','terminal','outcome',result,'validUntil',submission->'validUntil');
END;
$$;

CREATE FUNCTION public.tax_calculation_begin_v1(p_request jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.tax_calculation_transition_v1(p_request,false);
$$;
CREATE FUNCTION public.tax_calculation_complete_v1(p_request jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.tax_calculation_transition_v1(p_request,true);
$$;

REVOKE ALL ON FUNCTION public.tax_calculation_transition_v1(jsonb,boolean), public.tax_calculation_begin_v1(jsonb), public.tax_calculation_complete_v1(jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_transition_v1(jsonb,boolean), public.tax_calculation_begin_v1(jsonb), public.tax_calculation_complete_v1(jsonb) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_transition_v1(jsonb,boolean), public.tax_calculation_begin_v1(jsonb), public.tax_calculation_complete_v1(jsonb) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_transition_v1(jsonb,boolean), public.tax_calculation_begin_v1(jsonb), public.tax_calculation_complete_v1(jsonb) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.tax_calculation_begin_v1(jsonb), public.tax_calculation_complete_v1(jsonb) TO service_role;';
END IF; END; $$;
