ALTER TABLE public.tax_calculations ADD COLUMN adapter_money_text text;
ALTER TABLE public.tax_calculations ADD COLUMN adapter_result_digest text;
ALTER TABLE public.tax_calculations ADD CONSTRAINT tax_calculations_adapter_money_check CHECK (
  (adapter_money_text IS NULL AND adapter_result_digest IS NULL) OR
  (adapter_money_text IS NOT NULL AND adapter_result_digest IS NOT NULL AND state = 'terminal'
    AND provider_digest IS NOT NULL AND octet_length(adapter_money_text) BETWEEN 1 AND 1048576
    AND octet_length(adapter_result_digest) = 64
    AND octet_length(translate(adapter_result_digest,'0123456789abcdef','')) = 0));

CREATE OR REPLACE FUNCTION public.tax_calculation_guard_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  body jsonb;
  validated_money jsonb;
  coordinate text;
BEGIN
  IF TG_TABLE_NAME = 'identity_privacy_erasures' THEN
    IF NEW.contributor_versions ? 'tax-calculations' OR (
      current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))
      AND current_setting('app.tax_historical_receipt_restore',true) = pg_current_xact_id_if_assigned()::text
      AND EXISTS (SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted
        AND relation='public.tax_calculations'::regclass AND mode='ShareRowExclusiveLock')
    ) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'PRIVACY_CONTRIBUTOR_MISSING' USING ERRCODE='55000';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.state <> 'erased' THEN
    BEGIN
      PERFORM public.tax_calculation_frame_v1('evaluation-key',NEW.identity),
        public.tax_calculation_frame_v1('evaluation-pin',NEW.pin);
      IF jsonb_typeof(NEW.identity) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.pin) IS DISTINCT FROM 'object' THEN
        RAISE data_exception;
      END IF;
      IF NEW.outcome_text IS NOT NULL THEN
        IF octet_length(convert_to(NEW.outcome_text,'UTF8')) > 1048576 THEN RAISE data_exception; END IF;
        body := (NEW.outcome_text::jsonb)->1;
        IF jsonb_typeof(body) IS DISTINCT FROM 'object'
          OR NEW.outcome_text IS DISTINCT FROM public.tax_calculation_frame_v1('evaluation-outcome',body)
          OR NOT coalesce(jsonb_typeof(body->'submissionDigest')='string'
            AND body->>'submissionDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false) THEN
          RAISE data_exception;
        END IF;
      END IF;
      FOREACH coordinate IN ARRAY ARRAY['invocationDigest','requestDigest'] LOOP
        IF NOT coalesce(jsonb_typeof(NEW.pin->coordinate)='string'
          AND NEW.pin->>coordinate COLLATE "C" ~ '^[0-9a-f]{64}$',false)
          OR (body IS NOT NULL AND body->coordinate IS DISTINCT FROM NEW.pin->coordinate) THEN RAISE data_exception; END IF;
      END LOOP;
    EXCEPTION WHEN data_exception THEN
      RAISE EXCEPTION 'tax_evaluation_frame_invalid' USING ERRCODE='23514', DETAIL='/taxEvidence';
    END;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.state = 'pending' AND NEW.state = 'terminal') THEN
    BEGIN
      IF NEW.adapter_money_text IS NOT NULL OR NEW.adapter_result_digest IS NOT NULL THEN
        IF NEW.state <> 'terminal' OR NEW.provider_digest IS NULL OR NEW.adapter_money_text IS NULL
          OR NOT coalesce(NEW.adapter_result_digest COLLATE "C" ~ '^[0-9a-f]{64}$',false)
          OR octet_length(NEW.adapter_money_text) NOT BETWEEN 1 AND 1048576 THEN RAISE data_exception; END IF;
        validated_money := public.tax_calculation_adapter_money_v1(NEW.adapter_money_text::jsonb,NEW.pin,
          public.tax_calculation_terminal_v1(NEW));
        IF validated_money->>'moneyText' IS DISTINCT FROM NEW.adapter_money_text
          OR validated_money->>'resultDigest' IS DISTINCT FROM NEW.adapter_result_digest THEN RAISE data_exception; END IF;
      ELSIF TG_OP = 'UPDATE' AND body->>'kind' = 'tax_calculation'
        AND body#>>'{outcome,kind}' IN ('final','estimate') THEN RAISE data_exception;
      END IF;
    EXCEPTION WHEN data_exception OR check_violation THEN
      RAISE EXCEPTION 'tax_evaluation_frame_invalid' USING ERRCODE='23514', DETAIL='/taxEvidence';
    END;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state <> 'erased' AND NEW.calculation_id = OLD.calculation_id THEN
    IF NEW.state = 'erased' AND NEW.provider_digest IS NOT DISTINCT FROM OLD.provider_digest THEN
      NEW.adapter_money_text := NULL;
      NEW.adapter_result_digest := NULL;
      RETURN NEW;
    END IF;
    IF OLD.state = 'pending' AND
      (to_jsonb(NEW) - ARRAY['state','generation','claim_token','lease_until','outcome_text','outcome_digest','provider_digest','contradiction','adapter_money_text','adapter_result_digest'])
      = (to_jsonb(OLD) - ARRAY['state','generation','claim_token','lease_until','outcome_text','outcome_digest','provider_digest','contradiction','adapter_money_text','adapter_result_digest'])
      AND ((NEW.state = 'terminal' AND NEW.generation = OLD.generation AND NEW.claim_token = OLD.claim_token
        AND NEW.lease_until = OLD.lease_until AND (NOT OLD.contradiction OR NEW.contradiction))
        OR (NEW.state = 'pending' AND NEW.adapter_money_text IS NULL AND NEW.adapter_result_digest IS NULL
          AND ((NEW.generation::bigint = OLD.generation::bigint + 1
          AND NEW.claim_token <> OLD.claim_token AND NEW.contradiction = OLD.contradiction)
          OR (NEW.generation = OLD.generation AND NEW.claim_token = OLD.claim_token
            AND NEW.lease_until = OLD.lease_until AND NOT OLD.contradiction AND NEW.contradiction)))) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence', HINT='Recover the original evaluation from its authoritative owner.';
END;
$$;
CREATE OR REPLACE FUNCTION public.tax_calculation_transition_v1(p_request jsonb, p_complete boolean) RETURNS jsonb
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
  adapter_money jsonb;
  validated_money jsonb;
  result jsonb;
  envelope jsonb;
  terminal jsonb;
  submitted_digest text;
  provider_key text;
  constraint_name text;
  cutoff timestamptz;
  now_at timestamptz;
  code text;
  field text;
BEGIN
  IF p_complete AND jsonb_typeof(submission) = 'object' AND submission ? 'adapterMoneyResult' THEN
    adapter_money := submission->'adapterMoneyResult';
    submission := submission - 'adapterMoneyResult';
    p_request := jsonb_set(p_request,'{seal}',submission);
  END IF;
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR octet_length(convert_to(public.catalog_publication_canonical(p_request,0),'UTF8')) > 1048576 THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/', HINT='Supply the documented input.';
  END IF;
  IF NOT coalesce((p_complete AND operation='complete') OR (NOT p_complete AND operation IN ('lookup','claim')),false)
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
    OR identity - ARRAY['installationRef','clientId','principalRef','scopeRef','evaluationKey'] <> '{}'::jsonb
    OR NOT coalesce(jsonb_typeof(identity->'installationRef')='string' AND octet_length(installation) BETWEEN 1 AND 200
      AND jsonb_typeof(identity->'evaluationKey')='string'
      AND length(identity->>'evaluationKey') + regexp_count(identity->>'evaluationKey',U&'[\+010000-\+10FFFF]') BETWEEN 1 AND 256,false) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/identity', HINT='Supply the documented input.';
  END IF;
  FOREACH field IN ARRAY ARRAY['clientId','principalRef','scopeRef'] LOOP
    IF NOT coalesce(jsonb_typeof(identity->field)='string'
      AND identity->>field COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false) THEN
      RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/identity/' || field, HINT='Supply the documented input.';
    END IF;
  END LOOP;
  IF p_complete AND (jsonb_typeof(p_request->'generation') IS DISTINCT FROM 'number'
    OR NOT coalesce(p_request->>'generation' COLLATE "C" ~ '^[1-9][0-9]{0,9}$'
      AND (p_request->>'generation')::numeric <= 2147483647,false)
    OR jsonb_typeof(submission->'contradiction') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal', HINT='Supply the documented input.';
  END IF;
  client := (identity->>'clientId')::uuid;
  principal := (identity->>'principalRef')::uuid;
  ctx := jsonb_build_object('clientId',client,'scopeRef',identity->'scopeRef','owner',jsonb_build_object(
    'installationRef',installation,'principalKind','customer','principalRef',principal,'customerOrSessionRef',client));
  invocation := public.tax_calculation_hash_v1('evaluation-invocation',jsonb_build_object('identity',identity,'request',p_request->'invocation'));
  locator_key := public.tax_calculation_hash_v1('evaluation-key',identity);
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE='22023', DETAIL='/transaction', HINT='Use READ COMMITTED.';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  IF EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id=client OR principal_id=principal) THEN
    RAISE EXCEPTION 'destination_evidence_erased' USING ERRCODE='55000', DETAIL='/destination/snapshotRef', HINT='Review the privacy disposition through authorized support.';
  END IF;
  IF operation <> 'lookup' THEN
    PERFORM FROM public.clients WHERE id=client AND principal_id=principal AND NOT (metadata ? 'absorption') FOR UPDATE;
  ELSE
    PERFORM FROM public.clients WHERE id=client AND principal_id=principal AND NOT (metadata ? 'absorption');
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'tax_scope_mismatch' USING ERRCODE='22023', DETAIL='/destination/snapshotRef', HINT='Re-obtain evidence in the authorized scope.'; END IF;
  -- Read the original pin under the client fence. Historical replay needs no live destination read.
  SELECT * INTO r FROM public.tax_calculations WHERE locator=locator_key;
  IF r.calculation_id IS NOT NULL THEN
    IF r.identity IS DISTINCT FROM identity OR r.pin->>'invocationDigest' IS DISTINCT FROM invocation THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/requestKey', HINT='Replay the original invocation and evidence.';
    END IF;
    BEGIN
      IF r.pin_digest IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-pin',r.pin)
        OR NOT EXISTS (SELECT FROM public.commerce_destination_v2_documents d
          WHERE d.snapshot_ref=r.snapshot_ref AND d.client_id=client AND to_jsonb(d.scope_ref)=identity->'scopeRef'
            AND d.owner_scope=ctx->'owner' AND d.binding=r.pin->'destination') THEN
        RAISE EXCEPTION 'invalid pin' USING ERRCODE='22023';
      END IF;
    EXCEPTION WHEN data_exception OR check_violation THEN
      RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence', HINT='Recover the original evaluation from its authoritative owner.';
    END;
    IF p_complete AND (r.calculation_id::text IS DISTINCT FROM p_request->>'calculationId'
      OR r.generation::text IS DISTINCT FROM p_request->>'generation' OR r.claim_token::text IS DISTINCT FROM p_request->>'claimToken') THEN
      RAISE EXCEPTION 'tax_claim_stale' USING ERRCODE='55000', DETAIL='/claim', HINT='Read the original evaluation outcome.';
    END IF;
  ELSIF p_complete THEN
    RAISE EXCEPTION 'tax_claim_stale' USING ERRCODE='55000', DETAIL='/claim', HINT='Read the original evaluation outcome.';
  END IF;
  IF operation = 'lookup' AND r.state IS DISTINCT FROM 'terminal' THEN
    RETURN jsonb_build_object('kind',CASE WHEN r.calculation_id IS NULL THEN 'missing' ELSE 'pending' END);
  END IF;
  IF NOT p_complete AND r.state = 'pending' AND clock_timestamp() < r.lease_until THEN
    RAISE EXCEPTION 'tax_claim_pending' USING ERRCODE='55000', DETAIL='/claim', HINT='Read the original evaluation outcome.';
  END IF;
  pinned := coalesce(r.pin,p_request->'pin');
  original := pinned->'request';
  IF p_complete OR r.state IS DISTINCT FROM 'terminal' THEN
    field := public.tax_calculation_check_domain_v1(p_request->'invocation',pinned,submission,p_complete);
    IF field = '/pin/destination/policyRevision' THEN
      RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL=field, HINT='Obtain a supported revision from the destination owner.';
    END IF;
    IF field IN ('/pin','/seal') THEN
      RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL=field, HINT='Supply the documented input.';
    END IF;
    IF field IS NOT NULL THEN RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL=field, HINT='Supply the documented input.'; END IF;
  END IF;
  IF r.state = 'terminal' THEN
    terminal := public.tax_calculation_terminal_v1(r);
    IF terminal IS NULL THEN RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence', HINT='Recover the original evaluation from its authoritative owner.'; END IF;
    IF p_complete AND terminal->>'submissionDigest' IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-submission',submission) THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
    END IF;
    IF p_complete THEN
      IF r.adapter_money_text IS NOT NULL AND
        NOT coalesce(r.adapter_result_digest COLLATE "C" ~ '^[0-9a-f]{64}$',false) THEN
        RAISE EXCEPTION 'tax_evaluation_integrity_invalid' USING ERRCODE='55000', DETAIL='/taxEvidence', HINT='Recover the original evaluation from its authoritative owner.';
      END IF;
      IF adapter_money IS NOT NULL THEN
        -- Historical provider-conflict rows retain the original success submission digest.
        validated_money := public.tax_calculation_adapter_money_v1(adapter_money,
          CASE WHEN r.adapter_money_text IS NULL THEN pinned END,
          CASE WHEN r.adapter_money_text IS NULL THEN submission END);
        IF validated_money IS NULL THEN
          RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/adapterMoneyResult', HINT='Supply the original verified adapter money through the native tax completion adapter.';
        END IF;
      END IF;
      IF r.adapter_money_text IS NOT NULL AND validated_money->>'moneyText' IS DISTINCT FROM r.adapter_money_text THEN
        RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
      END IF;
    END IF;
    RETURN jsonb_build_object('kind','terminal','outcome',terminal->'outcome','validUntil',terminal->'validUntil');
  END IF;
  destination := pinned->'destination';
  pinned_coverage := pinned->'coverage';
  IF NOT coalesce(pinned->>'requestDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/pin', HINT='Supply the documented input.';
  END IF;
  cutoff := (pinned->>'validUntil')::timestamptz;
  owned := public.commerce_read_destination_v2(ctx,'snapshot',(destination->>'snapshotRef')::uuid,destination);
  IF owned->>'outcome' = 'refused' THEN
    field := owned->>'field';
    code := CASE WHEN owned->>'code' = 'destination_evidence_unavailable' AND field = 'destination.snapshotRef'
      THEN 'commerce_destination_owner_mismatch' ELSE owned->>'code' END;
    RAISE EXCEPTION '%', code USING ERRCODE='22023',
      DETAIL=CASE WHEN code='commerce_destination_owner_mismatch' THEN '/destination/snapshotRef' ELSE field END,
      HINT=CASE code
        WHEN 'commerce_destination_owner_mismatch' THEN 'Re-obtain evidence through the authenticated owner.'
        WHEN 'destination_binding_invalid' THEN 'Recover the original binding.'
        WHEN 'destination_version_changed' THEN 'Select the destination again and obtain a fresh quote.'
        WHEN 'address_invalid_input' THEN 'Correct caller-authored input or re-obtain authoritative evidence as applicable.'
        ELSE owned->>'fix' END;
  END IF;
  IF pinned_coverage IS NOT NULL AND pinned_coverage <> 'null'::jsonb THEN
    BEGIN
      SELECT c.coverage INTO history FROM public.tax_coverage_read_v1(installation,pinned_coverage->>'accountRef') c
        WHERE c.revision=pinned_coverage->>'revision' AND c.coverage_digest=pinned_coverage->>'digest';
      IF NOT FOUND THEN RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/coverage', HINT='Recover the verified original history through its owner.'; END IF;
    EXCEPTION WHEN data_exception OR check_violation THEN
      GET STACKED DIAGNOSTICS code=MESSAGE_TEXT, field=PG_EXCEPTION_DETAIL;
      IF code NOT IN ('catalog_publication_wire_invalid','tax_reference_conflict','tax_invalid_input') THEN RAISE; END IF;
      RAISE EXCEPTION '%', CASE WHEN code='tax_invalid_input' THEN code ELSE 'tax_reference_conflict' END
        USING ERRCODE='22023', DETAIL=CASE WHEN code='tax_invalid_input' THEN field ELSE '/coverage' END,
          HINT=CASE WHEN code='tax_invalid_input' THEN 'tax_coverage_declaration_invalid'
                    ELSE 'Recover the verified original history through its owner.' END;
    END;
  END IF;
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
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
    END IF;
    original := jsonb_set(original,'{input,destination,address}',address);
  END IF;
  IF public.tax_calculation_hash_v1('evaluation-request',original) IS DISTINCT FROM pinned->>'requestDigest'
    OR (r.calculation_id IS NOT NULL AND (owned->'documentDigest' IS DISTINCT FROM pinned->'documentDigest'
      OR (r.coverage_installation_ref,r.coverage_account_ref,r.coverage_revision) IS DISTINCT FROM
        (CASE WHEN history IS NOT NULL THEN installation END,pinned_coverage->>'accountRef',pinned_coverage->>'revision'))) THEN
    RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
  END IF;
  now_at := date_trunc('milliseconds',clock_timestamp());
  IF cutoff IS NULL OR cutoff > (owned->>'evidenceExpiresAt')::timestamptz OR clock_timestamp() >= cutoff THEN
    RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt', HINT='Select the destination again and obtain a fresh quote.';
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
      IF r.generation = 2147483647 THEN RAISE EXCEPTION 'tax_claim_generation_exhausted' USING ERRCODE='55000', DETAIL='/claim', HINT='Reconcile the original evaluation with its owner.'; END IF;
      IF pinned->'recovery' IS NULL OR pinned->'recovery' = 'null'::jsonb OR pinned->'recovery' IS DISTINCT FROM p_request->'recovery' THEN
        RAISE EXCEPTION 'tax_adapter_unavailable' USING ERRCODE='55000', DETAIL='/taxEvidence', HINT='Recover the original evidence through the adapter owner.';
      END IF;
      UPDATE public.tax_calculations SET generation=generation+1,claim_token=gen_random_uuid(),lease_until=now_at+interval '300 seconds'
        WHERE calculation_id=r.calculation_id RETURNING * INTO r;
    END IF;
    IF clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt', HINT='Select the destination again and obtain a fresh quote.'; END IF;
    RETURN jsonb_build_object('kind','claimed','calculationId',r.calculation_id,'generation',r.generation,'claimToken',r.claim_token,'pin',pinned,'sampledAtMs',extract(epoch FROM clock_timestamp()) * 1000);
  END IF;
  IF submission->'requestDigest' IS DISTINCT FROM pinned->'requestDigest' OR submission->'kind' IS DISTINCT FROM pinned->'kind'
    OR submission->'destination' IS DISTINCT FROM destination THEN
    RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
  END IF;
  submitted_digest := public.tax_calculation_hash_v1('evaluation-submission',submission);
  result := submission->'outcome';
  IF NOT coalesce(result->>'kind' IN ('indeterminate','refused','unavailable','final','estimate'),false) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/outcome', HINT='Supply the documented input.';
  END IF;
  IF result->>'kind' = 'indeterminate' THEN
    IF adapter_money IS NOT NULL THEN
      RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/adapterMoneyResult', HINT='Supply the original verified adapter money through the native tax completion adapter.';
    END IF;
    IF (submission->>'contradiction')::boolean AND NOT r.contradiction THEN
      UPDATE public.tax_calculations SET contradiction=true WHERE calculation_id=r.calculation_id;
    END IF;
    RETURN jsonb_build_object('kind','pending');
  END IF;
  IF (submission->>'validUntil')::timestamptz > cutoff THEN
    RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence/expiresAt', HINT='Replay the original invocation and evidence.';
  END IF;
  cutoff := (submission->>'validUntil')::timestamptz;
  IF cutoff IS NULL OR clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt', HINT='Select the destination again and obtain a fresh quote.'; END IF;
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
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
    END IF;
    IF pinned->>'kind' = 'tax_calculation' THEN
      provider_key := public.tax_calculation_hash_v1('provider-calculation',jsonb_build_object('installationRef',installation,
        'adapter',original#>'{input,scope,adapter}','accountRef',original#>'{input,scope,accountRef}',
        'mode',original#>'{input,scope,mode}','providerRef',submission#>'{evidence,adapterEvidence,calculationRef}'));
    END IF;
  ELSIF submission->'evidence' IS DISTINCT FROM 'null'::jsonb
    OR submission->'disposition' IS DISTINCT FROM result->'kind'
    OR (result->>'kind'='unavailable' AND result->'effect' IS DISTINCT FROM '"none"'::jsonb) THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/outcome', HINT='Supply the documented input.';
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
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/taxEvidence', HINT='Replay the original invocation and evidence.';
    END IF;
    IF provider_key IS NOT NULL OR adapter_money IS NOT NULL THEN
      validated_money := public.tax_calculation_adapter_money_v1(adapter_money,pinned,terminal);
      IF NOT coalesce(validated_money->>'resultDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false) THEN
        RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/seal/adapterMoneyResult', HINT='Supply the original verified adapter money through the native tax completion adapter.';
      END IF;
      sealed.adapter_money_text := validated_money->>'moneyText';
      sealed.adapter_result_digest := validated_money->>'resultDigest';
    END IF;
    BEGIN
      UPDATE public.tax_calculations SET state=sealed.state,outcome_text=sealed.outcome_text,outcome_digest=sealed.outcome_digest,
        provider_digest=sealed.provider_digest,contradiction=sealed.contradiction,adapter_money_text=sealed.adapter_money_text,
        adapter_result_digest=sealed.adapter_result_digest WHERE calculation_id=r.calculation_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
      IF constraint_name <> 'tax_calculations_provider_key' THEN RAISE; END IF;
      provider_key := NULL;
      adapter_money := NULL;
      envelope := envelope || '{"evidence":null,"disposition":"refused"}'::jsonb;
      result := '{"kind":"refused","code":"tax_provider_reference_conflict","field":"/taxEvidence","remedy":"Reconcile the original calculation with the tax adapter owner before further work."}'::jsonb;
    END;
  END LOOP;
  IF clock_timestamp() >= cutoff THEN RAISE EXCEPTION 'tax_calculation_expired' USING ERRCODE='55000', DETAIL='/taxEvidence/expiresAt', HINT='Select the destination again and obtain a fresh quote.'; END IF;
  RETURN jsonb_build_object('kind','terminal','outcome',result,'validUntil',submission->'validUntil');
END;
$$;
CREATE FUNCTION public.tax_calculation_read_adapter_money_v1(p_calculation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r public.tax_calculations;
  body jsonb;
  verified jsonb;
BEGIN
  IF p_calculation_id IS NULL THEN
    RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL='/calculationId', HINT='Supply the documented input.';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'destination_isolation_unsupported' USING ERRCODE='22023', DETAIL='/transaction', HINT='Use READ COMMITTED.';
  END IF;
  LOCK TABLE public.identity_privacy_erasures IN SHARE MODE;
  SELECT * INTO r FROM public.tax_calculations WHERE calculation_id=p_calculation_id;
  IF r.state = 'terminal' AND r.provider_digest IS NOT NULL AND r.adapter_money_text IS NOT NULL
    AND r.adapter_result_digest COLLATE "C" ~ '^[0-9a-f]{64}$' THEN
    BEGIN
      IF NOT EXISTS (SELECT FROM public.identity_privacy_erasures WHERE client_id=(r.identity->>'clientId')::uuid
        OR principal_id=(r.identity->>'principalRef')::uuid) THEN
        body := public.tax_calculation_terminal_v1(r);
      END IF;
      IF body#>>'{outcome,kind}' = 'final' THEN
        verified := public.tax_calculation_adapter_money_v1(r.adapter_money_text::jsonb,r.pin,body);
      END IF;
    EXCEPTION WHEN data_exception OR check_violation THEN
      verified := NULL;
    END;
    IF verified->>'moneyText' = r.adapter_money_text AND verified->>'resultDigest' = r.adapter_result_digest THEN
      RETURN jsonb_build_object('calculationId',p_calculation_id,'adapterMoneyText',r.adapter_money_text,
        'sealDigest',r.adapter_result_digest,'status','final');
    END IF;
  END IF;
  RETURN jsonb_build_object('calculationId',p_calculation_id,'adapterMoneyText',NULL,'sealDigest',NULL,'status','hold');
END;
$$;

REVOKE ALL ON FUNCTION public.tax_calculation_read_adapter_money_v1(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_read_adapter_money_v1(uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_read_adapter_money_v1(uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.tax_calculation_read_adapter_money_v1(uuid) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.tax_calculation_read_adapter_money_v1(uuid) TO service_role;';
END IF; END; $$;
