-- Native installation history. The managed rail does not install this capability.
CREATE TABLE public.tax_coverage_revisions (
  installation_ref text NOT NULL,
  account_ref text NOT NULL,
  revision text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no BETWEEN 1 AND 2147483647),
  previous_revision text,
  coverage jsonb NOT NULL,
  coverage_digest text NOT NULL,
  actor_ref text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (installation_ref, account_ref, revision),
  UNIQUE (installation_ref, account_ref, sequence_no)
);

CREATE FUNCTION public.tax_coverage_validate(p_coverage jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_entry jsonb;
  v_effective jsonb;
  v_field text;
  v_index integer;
  v_path text := '';
  v_item_path text;
  v_value text;
  v_status text;
BEGIN
  <<validation>>
  BEGIN
    IF jsonb_typeof(p_coverage) IS DISTINCT FROM 'object' OR EXISTS (
      SELECT FROM jsonb_object_keys(p_coverage) k WHERE k NOT IN ('schemaVersion','accountRef','revision','declarations')
    ) THEN EXIT validation; END IF;
    v_path := '/schemaVersion';
    IF (p_coverage->'schemaVersion') IS DISTINCT FROM '1'::jsonb THEN EXIT validation; END IF;
    FOREACH v_field IN ARRAY ARRAY['accountRef','revision'] LOOP
      v_path := '/' || v_field;
      v_value := p_coverage->>v_field;
      IF jsonb_typeof(p_coverage->v_field) IS DISTINCT FROM 'string'
        OR length(v_value) + regexp_count(v_value, U&'[\+010000-\+10FFFF]') NOT BETWEEN 1 AND 256
      THEN EXIT validation; END IF;
    END LOOP;
    v_path := '/declarations';
    IF jsonb_typeof(p_coverage->'declarations') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_coverage->'declarations') > 1048576 THEN EXIT validation; END IF;
    FOR v_entry, v_index IN
      SELECT value, (ordinality - 1)::integer FROM jsonb_array_elements(p_coverage->'declarations') WITH ORDINALITY
    LOOP
      v_item_path := '/declarations/' || v_index;
      v_path := v_item_path;
      IF jsonb_typeof(v_entry) <> 'object' THEN EXIT validation; END IF;
      v_path := v_item_path || '/status';
      v_status := v_entry->>'status';
      IF v_status IS NULL OR v_status NOT IN ('registered','not_registered_acknowledged') THEN EXIT validation; END IF;
      v_path := v_item_path;
      IF EXISTS (SELECT FROM jsonb_object_keys(v_entry) k WHERE k NOT IN
        ('status','jurisdiction','taxKind','effective','actorRef','recordedAt')
        AND NOT (k = 'acknowledgementRef' AND v_status = 'not_registered_acknowledged'))
      THEN EXIT validation; END IF;

      FOREACH v_field IN ARRAY ARRAY['jurisdiction','taxKind','effective/from','effective/until','actorRef','recordedAt','acknowledgementRef'] LOOP
        IF v_field = 'effective/from' THEN
          v_path := v_item_path || '/effective';
          v_effective := v_entry->'effective';
          IF jsonb_typeof(v_effective) IS DISTINCT FROM 'object' OR EXISTS (
            SELECT FROM jsonb_object_keys(v_effective) k WHERE k NOT IN ('from','until')
          ) THEN EXIT validation; END IF;
        END IF;
        IF v_field = 'effective/until' AND NOT (v_effective ? 'until')
          OR v_field = 'acknowledgementRef' AND v_status = 'registered' THEN CONTINUE; END IF;
        v_path := v_item_path || '/' || v_field;
        v_value := v_entry #>> string_to_array(v_field, '/');
        IF v_field IN ('effective/from','effective/until','recordedAt') THEN
          IF v_value IS NULL
            OR v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
            OR NOT pg_input_is_valid(CASE left(v_value,4) WHEN '0000' THEN '2000' || substr(v_value,5,6)
              ELSE left(v_value,10) END, 'date')
          THEN EXIT validation; END IF;
          IF v_field = 'effective/until' AND v_value COLLATE "C" <= (v_effective->>'from') COLLATE "C"
          THEN EXIT validation; END IF;
        ELSIF jsonb_typeof(v_entry->v_field) IS DISTINCT FROM 'string'
          OR length(v_value) + regexp_count(v_value, U&'[\+010000-\+10FFFF]') NOT BETWEEN 1 AND 256
        THEN EXIT validation; END IF;
      END LOOP;
    END LOOP;
    -- An adjacent pair in start order suffices to witness a conflicting interval.
    SELECT '/declarations/' || (ord - 1) || '/effective' INTO v_path FROM (
      SELECT ord, jurisdiction, kind, starts_at, lag(ord) OVER cell AS prior, lag(ends_at) OVER cell AS prior_end
      FROM (
        SELECT ord, entry->>'jurisdiction' AS jurisdiction, entry->>'taxKind' AS kind,
          entry#>>'{effective,from}' AS starts_at, entry#>>'{effective,until}' AS ends_at
        FROM jsonb_array_elements(p_coverage->'declarations') WITH ORDINALITY AS declaration(entry, ord)
      ) cells
      WINDOW cell AS (PARTITION BY jurisdiction, kind ORDER BY starts_at COLLATE "C", ord)
    ) adjacent
    WHERE prior IS NOT NULL AND (prior_end IS NULL OR starts_at COLLATE "C" < prior_end COLLATE "C")
    -- Match the TS order for the reported conflict, including supplementary code points.
    ORDER BY ARRAY(SELECT CASE WHEN cp <= 65535 THEN cp * 1024 ELSE
      (55296 + (cp - 65536) / 1024) * 1024 + (cp - 65536) % 1024 END
      FROM generate_series(1,char_length(jurisdiction)) i
      CROSS JOIN LATERAL (SELECT ascii(substr(jurisdiction,i,1)) AS cp) point ORDER BY i),
      ARRAY(SELECT CASE WHEN cp <= 65535 THEN cp * 1024 ELSE
        (55296 + (cp - 65536) / 1024) * 1024 + (cp - 65536) % 1024 END
        FROM generate_series(1,char_length(kind)) i
        CROSS JOIN LATERAL (SELECT ascii(substr(kind,i,1)) AS cp) point ORDER BY i),
      starts_at COLLATE "C", ord LIMIT 1;
    IF FOUND THEN EXIT validation; END IF;
    v_path := '';
    IF octet_length(public.catalog_publication_canonical(p_coverage,0)) <= 1048576 THEN RETURN p_coverage; END IF;
  END validation;
  RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL=v_path,
    HINT='Supply the documented declaration or request shape.';
END;
$$;

CREATE FUNCTION public.tax_coverage_append_v1(p_request jsonb)
RETURNS public.tax_coverage_revisions LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_path text := '';
  v_field text;
  v_ref text;
  v_installation_ref text := p_request->>'installationRef';
  v_account_ref text := p_request->>'accountRef';
  v_expected text := p_request->>'expectedRevision';
  v_coverage jsonb;
  v_revision text;
  v_wire text;
  v_digest text;
  v_seq integer;
  v_row public.tax_coverage_revisions;
BEGIN
  <<validation>>
  BEGIN
    IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR EXISTS (
      SELECT FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('installationRef','accountRef','expectedRevision','actorRef','coverage')
    ) THEN EXIT validation; END IF;
    FOREACH v_field IN ARRAY ARRAY['installationRef','accountRef','expectedRevision','actorRef'] LOOP
      v_path := '/' || v_field;
      IF v_field = 'expectedRevision' AND p_request->v_field = 'null'::jsonb THEN CONTINUE; END IF;
      v_ref := p_request->>v_field;
      IF jsonb_typeof(p_request->v_field) IS DISTINCT FROM 'string'
        OR length(v_ref) + regexp_count(v_ref, U&'[\+010000-\+10FFFF]') NOT BETWEEN 1 AND 256
      THEN EXIT validation; END IF;
    END LOOP;
    v_path := '/coverage/accountRef';
    BEGIN
      v_coverage := public.tax_coverage_validate(p_request->'coverage');
    EXCEPTION WHEN invalid_parameter_value THEN
      GET STACKED DIAGNOSTICS v_path = PG_EXCEPTION_DETAIL;
      v_path := '/coverage' || v_path;
      EXIT validation;
    END;
    IF v_account_ref <> v_coverage->>'accountRef' THEN EXIT validation; END IF;
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'tax_coverage_isolation_unsupported' USING ERRCODE='25000',
        HINT='Use the owner connection in READ COMMITTED and retry.';
    END IF;
    v_revision := v_coverage->>'revision';
    v_wire := public.catalog_publication_canonical(jsonb_build_array('platform.tax.coverage-revision.v1', v_coverage),0);
    v_digest := encode(sha256(convert_to(v_wire,'UTF8')), 'hex');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      jsonb_build_array('openlup:tax-coverage:v1', v_installation_ref, v_account_ref)::text, 0));
    IF v_expected IS NULL THEN
      v_seq := 1;
    ELSE
      SELECT sequence_no + 1 INTO v_seq FROM public.tax_coverage_revisions
      WHERE installation_ref=v_installation_ref AND account_ref=v_account_ref AND revision=v_expected;
    END IF;
    SELECT * INTO v_row FROM public.tax_coverage_revisions
    WHERE installation_ref=v_installation_ref AND account_ref=v_account_ref AND sequence_no=v_seq;
    IF FOUND AND v_row.previous_revision IS NOT DISTINCT FROM v_expected
      AND v_row.coverage_digest=v_digest AND v_row.coverage=v_coverage THEN RETURN v_row; END IF;
    IF FOUND OR v_seq IS NULL OR EXISTS (
      SELECT FROM public.tax_coverage_revisions
      WHERE installation_ref=v_installation_ref AND account_ref=v_account_ref AND sequence_no >= v_seq
    ) THEN
      RAISE EXCEPTION 'tax_coverage_revision_conflict' USING ERRCODE='22023', DETAIL='/expectedRevision',
        HINT='Replay the original document or read the current head and submit a new revision.';
    END IF;
    v_path := '/coverage/revision';
    IF EXISTS (SELECT FROM public.tax_coverage_revisions
      WHERE installation_ref=v_installation_ref AND account_ref=v_account_ref AND revision=v_revision)
    THEN EXIT validation; END IF;
    INSERT INTO public.tax_coverage_revisions
      (installation_ref, account_ref, revision, sequence_no, previous_revision, coverage, coverage_digest, actor_ref, recorded_at)
    VALUES (v_installation_ref, v_account_ref, v_revision, v_seq, v_expected, v_coverage, v_digest,
      p_request->>'actorRef', clock_timestamp())
    RETURNING * INTO v_row;
    RETURN v_row;
  END validation;
  RAISE EXCEPTION 'tax_invalid_input' USING ERRCODE='22023', DETAIL=v_path,
    HINT='Supply the documented declaration or request shape.';
END;
$$;

CREATE FUNCTION public.tax_coverage_read_v1(p_installation_ref text, p_account_ref text)
RETURNS SETOF public.tax_coverage_revisions LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.tax_coverage_revisions;
BEGIN
  FOR v_row IN SELECT * FROM public.tax_coverage_revisions
    WHERE installation_ref=p_installation_ref AND account_ref=p_account_ref ORDER BY sequence_no
  LOOP
    IF v_row.coverage_digest IS DISTINCT FROM encode(sha256(convert_to(public.catalog_publication_canonical(
      jsonb_build_array('platform.tax.coverage-revision.v1', v_row.coverage),0), 'UTF8')), 'hex')
      OR v_row.account_ref IS DISTINCT FROM v_row.coverage->>'accountRef'
      OR v_row.revision IS DISTINCT FROM v_row.coverage->>'revision'
    THEN
      RAISE EXCEPTION 'tax_reference_conflict' USING ERRCODE='22023', DETAIL='/coverage',
        HINT='Replay the original document and its digest.';
    END IF;
    v_row.coverage := public.tax_coverage_validate(v_row.coverage);
    RETURN NEXT v_row;
  END LOOP;
END;
$$;

CREATE FUNCTION public.tax_coverage_revision_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'tax_coverage_revision_immutable' USING ERRCODE='55000',
    HINT='Append a new coverage revision to change the effective declarations.';
END;
$$;

CREATE TRIGGER tax_coverage_revision_immutable
BEFORE UPDATE OR DELETE ON public.tax_coverage_revisions
FOR EACH ROW EXECUTE FUNCTION public.tax_coverage_revision_immutable();

ALTER TABLE public.tax_coverage_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tax_coverage_revisions FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.tax_coverage_revisions FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.tax_coverage_revisions FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.tax_coverage_revisions FROM service_role;'; END IF; END; $$;

REVOKE ALL ON FUNCTION public.tax_coverage_append_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax_coverage_validate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax_coverage_read_v1(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax_coverage_revision_immutable() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.tax_coverage_append_v1(jsonb), public.tax_coverage_validate(jsonb), public.tax_coverage_read_v1(text,text), public.tax_coverage_revision_immutable() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.tax_coverage_append_v1(jsonb), public.tax_coverage_validate(jsonb), public.tax_coverage_read_v1(text,text), public.tax_coverage_revision_immutable() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.tax_coverage_append_v1(jsonb), public.tax_coverage_validate(jsonb), public.tax_coverage_read_v1(text,text), public.tax_coverage_revision_immutable() FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.tax_coverage_read_v1(text,text) TO service_role;'; END IF; END; $$;
