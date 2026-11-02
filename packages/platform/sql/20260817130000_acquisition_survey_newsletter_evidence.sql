-- C-D23D extends the existing acquisition authority with content-free survey
-- evidence and verified newsletter consent audit. It never persists raw survey
-- answers, email addresses or provider payloads on the new rail.

CREATE TABLE acquisition_private.survey_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_reference text NOT NULL UNIQUE,
  case_id uuid NOT NULL REFERENCES acquisition_private.cases(id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES acquisition_private.contacts(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) = 32),
  survey_type text NOT NULL CHECK (survey_type IN ('producer', 'consumer')),
  response_digest bytea NOT NULL CHECK (octet_length(response_digest) = 32),
  answer_count integer NOT NULL CHECK (answer_count BETWEEN 1 AND 100),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT acquisition_survey_reference_check
    CHECK (evidence_reference ~ '^acquisition-survey:[0-9a-f-]{36}$'),
  CONSTRAINT acquisition_survey_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$')
);

CREATE TABLE acquisition_private.newsletter_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_reference text NOT NULL UNIQUE,
  case_id uuid NOT NULL REFERENCES acquisition_private.cases(id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES acquisition_private.contacts(id) ON DELETE RESTRICT,
  event_reference text NOT NULL UNIQUE,
  command_fingerprint bytea NOT NULL CHECK (octet_length(command_fingerprint) = 32),
  event_type text NOT NULL CHECK (event_type IN ('subscribe','unsubscribe','suppress','complaint','update')),
  purpose text NOT NULL CHECK (purpose IN ('marketing_launch_offer','marketing_newsletter')),
  outcome text NOT NULL CHECK (outcome IN ('applied','ignored','stale')),
  consent_state text CHECK (consent_state IN ('granted','suppressed')),
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT acquisition_newsletter_audit_reference_check
    CHECK (audit_reference ~ '^acquisition-consent:[0-9a-f-]{36}$'),
  CONSTRAINT acquisition_newsletter_event_reference_check
    CHECK (event_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  CONSTRAINT acquisition_newsletter_outcome_state_check CHECK (
    (outcome = 'applied' AND consent_state IS NOT NULL)
    OR (outcome <> 'applied' AND consent_state IS NULL)
  )
);

CREATE INDEX acquisition_survey_evidence_admin_idx
  ON acquisition_private.survey_evidence(recorded_at DESC, id DESC);
CREATE INDEX acquisition_newsletter_consent_subject_idx
  ON acquisition_private.newsletter_consent_events(contact_id, purpose, occurred_at DESC);

ALTER TABLE acquisition_private.survey_evidence OWNER TO platform_acquisition_owner;
ALTER TABLE acquisition_private.newsletter_consent_events OWNER TO platform_acquisition_owner;
REVOKE ALL ON acquisition_private.survey_evidence, acquisition_private.newsletter_consent_events
  FROM PUBLIC, anon, authenticated, platform_acquisition_runtime;

CREATE TRIGGER acquisition_survey_evidence_append_only
BEFORE UPDATE OR DELETE ON acquisition_private.survey_evidence
FOR EACH ROW EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();
CREATE TRIGGER acquisition_survey_evidence_no_truncate
BEFORE TRUNCATE ON acquisition_private.survey_evidence
FOR EACH STATEMENT EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();
CREATE TRIGGER acquisition_newsletter_consent_events_append_only
BEFORE UPDATE OR DELETE ON acquisition_private.newsletter_consent_events
FOR EACH ROW EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();
CREATE TRIGGER acquisition_newsletter_consent_events_no_truncate
BEFORE TRUNCATE ON acquisition_private.newsletter_consent_events
FOR EACH STATEMENT EXECUTE FUNCTION acquisition_private.refuse_append_only_mutation();

-- This NOLOGIN function owner receives only the established consent state
-- table privileges required by the hardened definer routine below.
GRANT SELECT, INSERT, UPDATE ON public.communication_recipient_consents
  TO platform_acquisition_owner;

CREATE FUNCTION public.acquisition_survey_submit_v1(
  p_idempotency_key text,
  p_case_reference text,
  p_survey_type text,
  p_response_data jsonb,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_case acquisition_private.cases%ROWTYPE;
  v_contact acquisition_private.contacts%ROWTYPE;
  v_existing acquisition_private.survey_evidence%ROWTYPE;
  v_evidence acquisition_private.survey_evidence%ROWTYPE;
  v_fingerprint bytea;
  v_digest bytea;
  v_count integer;
  v_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    OR p_case_reference IS NULL OR p_case_reference !~ '^acquisition-case:[0-9a-f-]{36}$'
    OR p_survey_type NOT IN ('producer','consumer')
    OR jsonb_typeof(p_response_data) <> 'object'
    OR octet_length(p_response_data::text) > 65536
    OR p_now IS NULL THEN
    RAISE EXCEPTION 'acquisition_survey_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer INTO v_count FROM jsonb_object_keys(p_response_data);
  IF v_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'acquisition_survey_invalid' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := acquisition_private.keyed_digest('survey-command', jsonb_build_object(
    'caseReference', p_case_reference, 'surveyType', p_survey_type, 'responseData', p_response_data));
  v_digest := acquisition_private.keyed_digest('survey-response', p_response_data);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('acquisition-survey:' || p_idempotency_key, 0));

  SELECT * INTO v_existing FROM acquisition_private.survey_evidence
   WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.command_fingerprint <> v_fingerprint THEN
      RETURN jsonb_build_object('outcome','idempotency_conflict');
    END IF;
    SELECT * INTO v_contact FROM acquisition_private.contacts WHERE id=v_existing.contact_id;
    SELECT * INTO v_case FROM acquisition_private.cases WHERE id=v_existing.case_id;
    RETURN jsonb_build_object('outcome','replayed','replayed',true,'evidence',jsonb_build_object(
      'evidenceReference',v_existing.evidence_reference,'caseReference',v_case.case_reference,
      'contactReference',v_contact.contact_reference,'surveyType',v_existing.survey_type,
      'responseDigest',encode(v_existing.response_digest,'hex'),'answerCount',v_existing.answer_count,
      'recordedAt',v_existing.recorded_at));
  END IF;

  SELECT c.* INTO v_case FROM acquisition_private.cases AS c
   WHERE c.case_reference = p_case_reference FOR UPDATE;
  IF NOT FOUND OR v_case.lifecycle IN ('rejected','withdrawn') THEN
    RETURN jsonb_build_object('outcome','not_found');
  END IF;
  SELECT contact.* INTO v_contact FROM acquisition_private.contacts AS contact
   WHERE contact.case_id = v_case.id AND contact.redacted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;

  v_id := gen_random_uuid();
  INSERT INTO acquisition_private.survey_evidence(
    id,evidence_reference,case_id,contact_id,idempotency_key,command_fingerprint,
    survey_type,response_digest,answer_count,recorded_at)
  VALUES (v_id,'acquisition-survey:'||v_id::text,v_case.id,v_contact.id,p_idempotency_key,
    v_fingerprint,p_survey_type,v_digest,v_count,p_now)
  RETURNING * INTO v_evidence;
  RETURN jsonb_build_object('outcome','recorded','replayed',false,'evidence',jsonb_build_object(
    'evidenceReference',v_evidence.evidence_reference,'caseReference',v_case.case_reference,
    'contactReference',v_contact.contact_reference,'surveyType',v_evidence.survey_type,
    'responseDigest',encode(v_evidence.response_digest,'hex'),'answerCount',v_evidence.answer_count,
    'recordedAt',v_evidence.recorded_at));
END
$function$;

CREATE FUNCTION public.acquisition_survey_operator_list_v1(
  p_actor_id uuid,
  p_survey_type text,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE v_rows jsonb; v_total bigint;
BEGIN
  IF p_actor_id IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR (p_survey_type IS NOT NULL AND p_survey_type NOT IN ('producer','consumer')) THEN
    RAISE EXCEPTION 'acquisition_survey_list_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_total FROM acquisition_private.survey_evidence e
   WHERE p_survey_type IS NULL OR e.survey_type = p_survey_type;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'evidenceReference',q.evidence_reference,'caseReference',q.case_reference,
    'contactReference',q.contact_reference,'surveyType',q.survey_type,
    'responseDigest',q.response_digest,'answerCount',q.answer_count,'recordedAt',q.recorded_at)
    ORDER BY q.recorded_at DESC,q.id DESC),'[]'::jsonb) INTO v_rows
  FROM (SELECT e.id,e.evidence_reference,c.case_reference,contact.contact_reference,e.survey_type,
      encode(e.response_digest,'hex') response_digest,e.answer_count,e.recorded_at
    FROM acquisition_private.survey_evidence e
    JOIN acquisition_private.cases c ON c.id=e.case_id
    JOIN acquisition_private.contacts contact ON contact.id=e.contact_id
    WHERE p_survey_type IS NULL OR e.survey_type=p_survey_type
    ORDER BY e.recorded_at DESC,e.id DESC LIMIT p_limit) q;
  RETURN jsonb_build_object('rows',v_rows,'totalCount',v_total);
END
$function$;

CREATE FUNCTION public.acquisition_newsletter_consent_v1(
  p_case_reference text,
  p_contact_reference text,
  p_event_reference text,
  p_event_type text,
  p_purpose text,
  p_explicit_opt_in boolean,
  p_occurred_at timestamptz,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_case acquisition_private.cases%ROWTYPE;
  v_contact acquisition_private.contacts%ROWTYPE;
  v_existing acquisition_private.newsletter_consent_events%ROWTYPE;
  v_fingerprint bytea; v_recipient text; v_state text; v_outcome text;
  v_id uuid; v_latest timestamptz; v_current timestamptz;
BEGIN
  IF p_case_reference IS NULL OR p_case_reference !~ '^acquisition-case:[0-9a-f-]{36}$'
    OR p_contact_reference IS NULL OR p_contact_reference !~ '^acquisition-contact:[0-9a-f-]{36}$'
    OR p_event_reference IS NULL OR p_event_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    OR p_event_type NOT IN ('subscribe','unsubscribe','suppress','complaint','update')
    OR p_purpose NOT IN ('marketing_launch_offer','marketing_newsletter')
    OR p_occurred_at IS NULL OR p_now IS NULL OR p_occurred_at > p_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'acquisition_newsletter_invalid' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := acquisition_private.keyed_digest('newsletter-consent-command',jsonb_build_object(
    'caseReference',p_case_reference,'contactReference',p_contact_reference,
    'eventReference',p_event_reference,'eventType',p_event_type,'purpose',p_purpose,
    'explicitOptInEvidence',p_explicit_opt_in,'occurredAt',p_occurred_at));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('acquisition-newsletter:' || p_event_reference, 0));
  SELECT * INTO v_existing FROM acquisition_private.newsletter_consent_events
   WHERE event_reference=p_event_reference FOR UPDATE;
  IF FOUND THEN
    IF v_existing.command_fingerprint<>v_fingerprint THEN
      RETURN jsonb_build_object('outcome','idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('outcome',v_existing.outcome,'consentState',v_existing.consent_state,
      'auditReference',v_existing.audit_reference,'eventReference',v_existing.event_reference,'replayed',true);
  END IF;
  SELECT c.* INTO v_case FROM acquisition_private.cases c
   WHERE c.case_reference=p_case_reference FOR UPDATE;
  IF NOT FOUND OR v_case.lifecycle IN ('rejected','withdrawn') THEN
    RETURN jsonb_build_object('outcome','not_found');
  END IF;
  SELECT contact.* INTO v_contact FROM acquisition_private.contacts contact
   WHERE contact.case_id=v_case.id AND contact.contact_reference=p_contact_reference
     AND contact.redacted_at IS NULL AND contact.normalized_email IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  v_recipient := encode(sha256(convert_to(lower(btrim(v_contact.normalized_email)),'UTF8')),'hex');
  IF p_event_type='subscribe' AND p_explicit_opt_in THEN v_state:='granted'; v_outcome:='applied';
  ELSIF p_event_type IN ('unsubscribe','suppress','complaint') THEN v_state:='suppressed'; v_outcome:='applied';
  ELSE v_state:=NULL; v_outcome:='ignored'; END IF;
  SELECT max(occurred_at) INTO v_latest FROM acquisition_private.newsletter_consent_events
   WHERE contact_id=v_contact.id AND purpose=p_purpose AND outcome='applied';
  SELECT updated_at INTO v_current FROM public.communication_recipient_consents
   WHERE recipient_fingerprint=v_recipient AND purpose=p_purpose FOR UPDATE;
  IF v_outcome='applied' AND (v_latest>p_occurred_at OR v_current>p_occurred_at) THEN
    v_outcome:='stale'; v_state:=NULL;
  END IF;
  v_id:=gen_random_uuid();
  INSERT INTO acquisition_private.newsletter_consent_events(
    id,audit_reference,case_id,contact_id,event_reference,command_fingerprint,event_type,
    purpose,outcome,consent_state,recipient_fingerprint,occurred_at,recorded_at)
  VALUES (v_id,'acquisition-consent:'||v_id::text,v_case.id,v_contact.id,p_event_reference,
    v_fingerprint,p_event_type,p_purpose,v_outcome,v_state,v_recipient,p_occurred_at,p_now);
  IF v_outcome='applied' THEN
    INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state,captured_at,updated_at)
    VALUES(v_recipient,p_purpose,v_state,p_occurred_at,p_occurred_at)
    ON CONFLICT ON CONSTRAINT communication_recipient_consents_pkey DO UPDATE
      SET state=EXCLUDED.state,captured_at=EXCLUDED.captured_at,updated_at=EXCLUDED.updated_at
      WHERE public.communication_recipient_consents.updated_at<=EXCLUDED.updated_at;
  END IF;
  RETURN jsonb_build_object('outcome',v_outcome,'consentState',v_state,
    'auditReference','acquisition-consent:'||v_id::text,'eventReference',p_event_reference,'replayed',false);
END
$function$;

ALTER FUNCTION public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamptz) OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.acquisition_survey_operator_list_v1(uuid,text,integer) OWNER TO platform_acquisition_owner;
ALTER FUNCTION public.acquisition_newsletter_consent_v1(text,text,text,text,text,boolean,timestamptz,timestamptz) OWNER TO platform_acquisition_owner;
REVOKE ALL ON FUNCTION public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.acquisition_survey_operator_list_v1(uuid,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.acquisition_newsletter_consent_v1(text,text,text,text,text,boolean,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamptz) TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.acquisition_survey_operator_list_v1(uuid,text,integer) TO platform_acquisition_runtime;
GRANT EXECUTE ON FUNCTION public.acquisition_newsletter_consent_v1(text,text,text,text,text,boolean,timestamptz,timestamptz) TO platform_acquisition_runtime;
