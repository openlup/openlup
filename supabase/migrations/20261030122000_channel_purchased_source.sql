-- migration:allow-dynamic-ddl: one atomic invoker installer envelope restores exact temporary SET/CREATE around six closed ACL/owner transfers; channel_purchased_order_boundary_test.sql specifies actual role/primitive denial checks, with independent delta and native proof required before runtime.
-- migration:allow-owner-to: transfer only the six closed capture/page/CAS entrypoints to a runtime-inaccessible NOLOGIN owner; invoker guards and pgTAP owner/ACL negatives verify the sealed capability before integration.
-- migration:allow-security-definer: closed service-only capture and CAS functions retain scoped original receipts; owning pgTAP checks actor/job/raw-write denials.
-- migration:allow-grant: exact trusted installer self SET/new public CREATE is transaction-local and removed; runtime grants stay closed and bootstrap ADMIN-only is not SET/INHERIT authority.
-- migration:allow-trigger: invoker field/source guards preserve pre-adoption legacy writes and reject protected fabricated evidence.
-- migration:allow-destructive: TRUNCATE declarations are denial triggers; no existing row is erased.
-- migration:allow-rls: narrow writer policies support the closed NOLOGIN functions on existing carriers only.
-- migration:allow-dml: source and cursor writes occur only inside closed functions; install registers dormant evidence ownership.
-- P4 source admission: immutable purchased facts and exact page/CAS receipts on existing carriers.
-- Install makes no provider call or physical mutation; the closed runtime command performs actual P3 conversion atomically.
-- Captured first-BOM/group identity licenses archived paid SKU creation; ordinary order behavior stays.
-- Closed functions use one non-login owner; invoker guards deny generic/raw source fabrication.
-- Legacy pre-adoption cursor writes and five-argument ingress remain unchanged.
-- Private scope owns exact live-job SHARE locks; only the sealed owner receives the reference validator.
-- Explicit canonical text is hashed as UTF8; jsonb::text is never used as its substitute.
-- Composite page pointer installs NOT VALID and is validated in the paired next forward.

DO $$ DECLARE installer oid; owner_id oid; BEGIN
  SELECT oid INTO installer FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreaterole);
  IF installer IS NULL THEN RAISE EXCEPTION 'channel_purchase_installer_authority_required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='openlup_channel_purchase_writer') THEN
    CREATE ROLE openlup_channel_purchase_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  SELECT oid INTO owner_id FROM pg_roles WHERE rolname='openlup_channel_purchase_writer';
  IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=owner_id AND
    (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit))
    OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE (m.roleid=owner_id OR m.member=owner_id) AND NOT
      (m.roleid=owner_id AND m.member=installer AND m.grantor=10 AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option
        AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=installer AND rolcreaterole AND NOT rolsuper))) THEN
    RAISE EXCEPTION 'channel_purchase_writer_role_unsafe';
  END IF;
END; $$;
GRANT USAGE ON SCHEMA public TO openlup_channel_purchase_writer;
ALTER TABLE public.channel_order_ingests ADD COLUMN purchase_capture_text text,
  ADD COLUMN purchase_capture_digest text;
ALTER TABLE public.sales_channel_connections ADD COLUMN pull_capture_adopted_at timestamptz,
  ADD COLUMN pull_page_ref uuid, ADD COLUMN pull_page_generation bigint NOT NULL DEFAULT 0
  CHECK(pull_page_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE public.sales_channel_connections ADD CONSTRAINT channel_pull_page_ref
  FOREIGN KEY(pull_page_ref) REFERENCES public.outbox_events(id) ON DELETE RESTRICT ;

CREATE FUNCTION public.channel_purchase_json(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE answer text;
BEGIN
  CASE jsonb_typeof(p_value)
  WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||public.channel_purchase_json(v),',' ORDER BY k COLLATE "C"),'')||'}'
    INTO answer FROM jsonb_each(p_value) AS x(k,v);
  WHEN 'array' THEN SELECT '['||coalesce(string_agg(public.channel_purchase_json(v),',' ORDER BY n),'')||']'
    INTO answer FROM jsonb_array_elements(p_value) WITH ORDINALITY AS x(v,n);
  ELSE answer:=p_value::text;
  END CASE;
  RETURN answer;
END; $$;
CREATE FUNCTION public.channel_purchase_packet(p_text text,p_digest text,p_kind text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE body jsonb; node jsonb; part jsonb; atom jsonb; key text; ceiling numeric;
  required_refs jsonb[]:=ARRAY[]::jsonb[]; ids jsonb[]:=ARRAY[]::jsonb[]; refs jsonb[]:=ARRAY[]::jsonb[]; times jsonb[]:=ARRAY[]::jsonb[]; states jsonb[];
BEGIN
  IF p_text IS NULL OR octet_length(p_text)>262144 OR p_digest IS NULL
    OR encode(sha256(convert_to(p_text,'UTF8')),'hex') IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'channel_purchase_bytes_invalid' USING ERRCODE='22023'; END IF;
  body:=p_text::jsonb;
  IF public.channel_purchase_json(body) IS DISTINCT FROM p_text OR body->>'schemaVersion' IS DISTINCT FROM p_kind THEN
    RAISE EXCEPTION 'channel_purchase_packet_invalid' USING ERRCODE='22023'; END IF;
  IF p_kind='channel.purchase-source.v1' AND NOT public.channel_control_keys((body-'ledgerId'-'ledgerResult'-'retainedRows')||
    CASE WHEN body ? 'normalized' THEN '{}'::jsonb ELSE jsonb_build_object('normalized',NULL) END,
    to_jsonb(ARRAY['schemaVersion','captureId','scope','namespace','execution','providerEventId','externalOrderRef','externalOrderRevision',
      'normalized','normalizedDigest','rawSourceDigest','products','capturedAt','pagePacketRef']))
    OR p_kind='channel.pull-page.v1' AND NOT public.channel_control_keys(body-'cursorReceipt',
      to_jsonb(ARRAY['schemaVersion','pagePacketId','scope','namespace','execution','expected','request','events','observedHead','observedAt','next'])) THEN
    RAISE EXCEPTION 'channel_purchase_packet_keys' USING ERRCODE='22023'; END IF;
  -- Exact native copy boundary: never rewrite the accepted canonical/protected input.
  IF p_kind IN ('channel.purchase-source.v1','channel.pull-page.v1') THEN
    IF NOT public.channel_control_keys(body->'execution',to_jsonb(ARRAY['actorId','jobRunId'])) THEN
      RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
    ids:=ARRAY[body#>'{execution,actorId}',body#>'{execution,jobRunId}'];
    IF p_kind='channel.pull-page.v1' THEN
      ids:=ids||ARRAY[body->'pagePacketId']; times:=ARRAY[body->'observedAt'];
      IF NOT public.channel_control_keys(body->'request',to_jsonb(ARRAY['from','limit']))
        OR jsonb_typeof(body#>'{request,limit}') IS DISTINCT FROM 'number'
        OR NOT coalesce(body#>>'{request,limit}' ~ '^[1-9][0-9]*$' AND (body#>>'{request,limit}')::numeric<=1000,false)
        OR jsonb_typeof(body->'events') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(body->'events')>1000 THEN RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
      refs:=ARRAY[body#>'{request,from}']; states:=ARRAY[body->'expected',body->'next'];
      IF body->'observedHead'<>'null'::jsonb THEN
        IF NOT public.channel_control_keys(body->'observedHead',to_jsonb(ARRAY['providerEventId','occurredAt'])) THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        required_refs:=required_refs||ARRAY[body#>'{observedHead,providerEventId}']; times:=times||ARRAY[body#>'{observedHead,occurredAt}'];
      END IF;
      FOR node IN SELECT value FROM jsonb_array_elements(body->'events') LOOP
        IF NOT public.channel_control_keys(node,to_jsonb(ARRAY['providerEventId','externalOrderRef','externalOrderRevision','occurredAt','rawSourceDigest','disposition','captureRef']))
          OR node->>'disposition' NOT IN ('purchase','unresolved') OR jsonb_typeof(node->'disposition') IS DISTINCT FROM 'string'
          OR NOT coalesce((node->>'disposition'='purchase')=(node->'captureRef'<>'null'::jsonb),false)
          OR jsonb_typeof(node->'rawSourceDigest') IS DISTINCT FROM 'string' OR node->>'rawSourceDigest' !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        required_refs:=required_refs||ARRAY[node->'providerEventId']; refs:=refs||ARRAY[node->'externalOrderRef',node->'externalOrderRevision'];
        times:=times||ARRAY[node->'occurredAt'];
        IF node->'captureRef'<>'null'::jsonb THEN ids:=ids||ARRAY[node->'captureRef']; END IF;
      END LOOP;
      IF body ? 'cursorReceipt' THEN
        node:=body->'cursorReceipt';
        IF NOT public.channel_control_keys(node,to_jsonb(ARRAY['pagePacketId','before','after']))
          OR node->'pagePacketId' IS DISTINCT FROM body->'pagePacketId' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        ids:=ids||ARRAY[node->'pagePacketId']; states:=states||ARRAY[node->'before',node->'after'];
        IF NOT coalesce((node#>>'{after,generation}')::numeric=(node#>>'{before,generation}')::numeric+1,false) THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
      END IF;
      FOREACH node IN ARRAY states LOOP
        IF NOT public.channel_control_keys(node,to_jsonb(ARRAY['cursor','watermark','generation']))
          OR jsonb_typeof(node->'generation') IS DISTINCT FROM 'number'
          OR NOT coalesce(node->>'generation' ~ '^[0-9]+$' AND (node->>'generation')::numeric<=9007199254740991,false) THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        refs:=refs||ARRAY[node->'cursor'];
        IF node->'watermark'<>'null'::jsonb THEN times:=times||ARRAY[node->'watermark']; END IF;
      END LOOP;
    ELSE
      ids:=ids||ARRAY[body->'captureId',body->'pagePacketRef']; times:=ARRAY[body->'capturedAt'];
      required_refs:=required_refs||ARRAY[body->'providerEventId',body->'externalOrderRef']; refs:=refs||ARRAY[body->'externalOrderRevision'];
      IF jsonb_typeof(body->'products') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(body->'products') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
      FOR node IN SELECT value FROM jsonb_array_elements(body->'products') LOOP
        IF NOT public.channel_control_keys(node,to_jsonb(ARRAY['externalLineRef','externalOfferRef','purchasedAt','products']))
          OR jsonb_typeof(node->'products') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        IF jsonb_array_length(node->'products') NOT BETWEEN 1 AND 100 THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        required_refs:=required_refs||ARRAY[node->'externalLineRef',node->'externalOfferRef']; times:=times||ARRAY[node->'purchasedAt'];
        FOR part IN SELECT value FROM jsonb_array_elements(node->'products') LOOP
          IF NOT public.channel_control_keys(part,to_jsonb(ARRAY['externalProductRef','quantityPerSet']))
            OR jsonb_typeof(part->'quantityPerSet') IS DISTINCT FROM 'number'
            OR NOT coalesce(part->>'quantityPerSet' ~ '^[1-9][0-9]*$' AND (part->>'quantityPerSet')::numeric<=9007199254740991,false) THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
          required_refs:=required_refs||ARRAY[part->'externalProductRef'];
        END LOOP;
      END LOOP;
      IF body ? 'normalized' THEN
        IF jsonb_typeof(body#>'{normalized,lines}') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        FOR node IN SELECT value FROM jsonb_array_elements(body#>'{normalized,lines}') LOOP
          part:=node->'sellable'; required_refs:=required_refs||ARRAY[node->'externalLineRef'];
          IF NOT coalesce(part->>'kind' IN ('bundle','sku'),false) OR NOT public.channel_control_keys(part,
            to_jsonb(ARRAY['kind','externalOfferRef',CASE WHEN part->>'kind'='bundle' THEN 'bundleCode' ELSE 'skuCode' END])) THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
          refs:=refs||ARRAY[part->'externalOfferRef'];
          atom:=part->CASE WHEN part->>'kind'='bundle' THEN 'bundleCode' ELSE 'skuCode' END;
          IF atom<>'null'::jsonb AND (jsonb_typeof(atom)<>'string' OR char_length(atom#>>'{}') NOT BETWEEN 1 AND 64
            OR atom#>>'{}'<>btrim(atom#>>'{}')) THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
          -- Payment is also copied into the line frame; scalar labels cannot carry nested objects.
          IF NOT public.channel_control_keys(node,to_jsonb(ARRAY['externalLineRef','sellable','quantity','unitGrossMinor','lineGrossMinor','lineDiscountMinor','vatRateBps']))
            OR (node->'vatRateBps'<>'null'::jsonb AND (jsonb_typeof(node->'vatRateBps')<>'number'
              OR NOT coalesce(node->>'vatRateBps' ~ '^[0-9]+$' AND (node->>'vatRateBps')::numeric<=10000,false))) THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        END LOOP;
        part:=body#>'{normalized,payment}';
        IF jsonb_typeof(part->'state') IS DISTINCT FROM 'string' OR jsonb_typeof(part->'externalPaymentRef') IS DISTINCT FROM 'string'
          OR (part->'methodLabel'<>'null'::jsonb AND (jsonb_typeof(part->'methodLabel')<>'string'
            OR char_length(part->>'methodLabel')>64 OR part->>'methodLabel'<>btrim(part->>'methodLabel'))) THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        times:=times||ARRAY[part->'paidAt'];
      END IF;
      IF body ? 'retainedRows' THEN
        IF jsonb_typeof(body->'retainedRows') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        IF jsonb_array_length(body->'retainedRows') NOT BETWEEN 1 AND 300 THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        FOR node IN SELECT value FROM jsonb_array_elements(body->'retainedRows') LOOP
          part:=node->'retained';
          IF NOT public.channel_control_keys(node,to_jsonb(ARRAY['externalLineRef','externalOfferRef','skuCode','quantity','unitGrossMinor','lineGrossMinor',
            'lineDiscountMinor','vatRateBps','bundleCode','bundleQty','retained'])) OR NOT public.channel_control_keys(part,
            to_jsonb(ARRAY['skuId','groupIndex','listingId','bundleDigest','firstApprovalId','firstQualificationId','weightMinor','normalizationFactor']))
            OR jsonb_typeof(part->'bundleDigest') IS DISTINCT FROM 'string' OR part->>'bundleDigest' !~ '^[0-9a-f]{64}$'
            OR jsonb_typeof(part->'groupIndex') IS DISTINCT FROM 'number' OR part->>'groupIndex' !~ '^[0-2]$' THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
          required_refs:=required_refs||ARRAY[node->'externalLineRef',node->'skuCode']; refs:=refs||ARRAY[node->'externalOfferRef',node->'bundleCode'];
          ids:=ids||ARRAY[part->'skuId',part->'listingId',part->'firstApprovalId',part->'firstQualificationId'];
          FOREACH key IN ARRAY ARRAY['quantity','unitGrossMinor','lineGrossMinor','lineDiscountMinor','vatRateBps','bundleQty'] LOOP
            atom:=node->key;
            IF atom='null'::jsonb AND key IN ('vatRateBps','bundleQty') THEN CONTINUE; END IF;
            ceiling:=CASE key WHEN 'quantity' THEN 2147483647 WHEN 'vatRateBps' THEN 10000 ELSE 9007199254740991 END;
            IF jsonb_typeof(atom) IS DISTINCT FROM 'number' OR NOT coalesce(atom::text ~ '^[0-9]+$'
              AND atom::numeric<=ceiling AND (key NOT IN ('quantity','bundleQty') OR atom::numeric>0),false) THEN
              RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
          END LOOP;
          FOREACH key IN ARRAY ARRAY['weightMinor','normalizationFactor'] LOOP
            atom:=part->key;
            IF jsonb_typeof(atom) IS DISTINCT FROM 'number' OR NOT coalesce(atom::text ~ '^[1-9][0-9]*$' AND atom::numeric<=9007199254740991,false) THEN
              RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
          END LOOP;
          IF (node->>'unitGrossMinor')::numeric*(node->>'quantity')::numeric<>(node->>'lineGrossMinor')::numeric
            OR (node->>'lineDiscountMinor')::numeric>(node->>'lineGrossMinor')::numeric THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        END LOOP;
      END IF;
    END IF;
    FOREACH atom IN ARRAY ids LOOP
      IF jsonb_typeof(atom) IS DISTINCT FROM 'string' OR NOT coalesce(atom#>>'{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
    END LOOP;
    FOREACH atom IN ARRAY required_refs LOOP
      IF jsonb_typeof(atom) IS DISTINCT FROM 'string' OR NOT public.channel_control_ref(atom#>>'{}') THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
    END LOOP;
    FOREACH atom IN ARRAY refs LOOP
      IF atom='null'::jsonb THEN CONTINUE; END IF;
      IF jsonb_typeof(atom) IS DISTINCT FROM 'string' OR NOT public.channel_control_ref(atom#>>'{}') THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
    END LOOP;
    FOREACH atom IN ARRAY times LOOP
      IF jsonb_typeof(atom) IS DISTINCT FROM 'string' OR NOT coalesce(atom#>>'{}' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$',false) THEN
        RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
      PERFORM (atom#>>'{}')::timestamptz;
    END LOOP;
  END IF;
  RETURN body;
END; $$;
CREATE FUNCTION public.channel_purchase_scope(p_body jsonb,p_actor uuid,p_job uuid,p_fresh boolean,p_live_job uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.sales_channel_connections%ROWTYPE; s public.sales_channels%ROWTYPE; expected jsonb;
BEGIN
  PERFORM public.channel_control_actor(p_actor,false);
  SELECT * INTO c FROM public.sales_channel_connections WHERE id=(p_body#>>'{scope,connectionId}')::uuid FOR UPDATE;
  SELECT * INTO s FROM public.sales_channels WHERE id=(p_body#>>'{scope,channelId}')::uuid AND connection_id=c.id;
  expected:=jsonb_build_object('connectionId',c.id,'channelId',s.id,'connectorKind',c.connector_provider_kind,
    'sellerRef',c.seller_external_ref,'environmentRef',c.environment_ref,'connectionVersion',c.control_version,
    'registryVersion',s.control_version,'currency',s.currency,'regionCode',s.region_code);
  IF c.id IS NULL OR s.id IS NULL OR ((p_body->'scope')-'connectionVersion'-'registryVersion') IS DISTINCT FROM (expected-'connectionVersion'-'registryVersion') OR p_body->'namespace' IS DISTINCT FROM
    jsonb_build_object('applicationRef',c.application_ref,'channelExternalRef',s.channel_external_ref)
    OR (p_fresh AND ((p_body#>>'{execution,actorId}')::uuid IS DISTINCT FROM p_actor OR p_body->'scope' IS DISTINCT FROM expected))
    OR (p_body#>>'{execution,jobRunId}')::uuid IS DISTINCT FROM p_job THEN
    RAISE EXCEPTION 'channel_purchase_scope_conflict' USING ERRCODE='P0001'; END IF;
  -- Existing installer-definer owns job read/row-lock authority; the closed writer gets no job-table grant.
  IF p_fresh OR p_live_job IS NOT NULL THEN
    PERFORM 1 FROM public.platform_job_runs r JOIN public.platform_job_controls j ON j.job_name=r.job_name
      WHERE r.id=coalesce(p_live_job,p_job) AND r.job_name='channel-order-pull' AND r.status='running' AND j.enabled
        AND r.driver=j.active_driver AND j.lease_token=r.id AND r.lease_expires_at>clock_timestamp()
        AND j.lease_owner IS NOT DISTINCT FROM r.lease_owner AND coalesce(j.lease_until,j.lease_expires_at)>clock_timestamp()
      FOR SHARE OF r,j;
    IF NOT FOUND THEN RAISE EXCEPTION 'channel_purchase_job_not_live' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN c.id;
END; $$;
CREATE FUNCTION public.channel_purchase_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE receipt jsonb; body jsonb; controlled boolean;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF TG_TABLE_NAME='outbox_events' AND NOT EXISTS(SELECT 1 FROM public.outbox_events
      WHERE event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1')) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'channel_purchase_truncate_forbidden' USING ERRCODE='P0001';
  END IF;
  IF TG_TABLE_NAME='outbox_events' THEN
    controlled:=coalesce(NEW.event_type,OLD.event_type) IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1')
      OR (TG_OP='UPDATE' AND OLD.event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1'));
    IF TG_OP='UPDATE' AND OLD.event_type='channel.purchase-line.v1' AND current_user='openlup_channel_purchase_writer'
      AND NOT OLD.metadata ? 'conversionCommand' AND jsonb_typeof(NEW.metadata->'conversionCommand')='string'
      AND NEW.metadata=OLD.metadata||jsonb_build_object('conversionCommand',NEW.metadata->'conversionCommand')
      AND (to_jsonb(NEW)-'metadata')=(to_jsonb(OLD)-'metadata') THEN RETURN NEW; END IF;
    IF controlled THEN
      -- Ordinary invoker writes never initialize private helper expressions.
      IF TG_OP<>'INSERT' OR current_user<>'openlup_channel_purchase_writer' THEN
        RAISE EXCEPTION 'channel_purchase_source_immutable' USING ERRCODE='P0001'; END IF;
      IF NEW.aggregate_type<>'channel_connection' OR NEW.status<>'pending' OR NEW.processed_at IS NOT NULL
        OR NEW.attempts<>0 OR NOT public.channel_control_keys(NEW.metadata,to_jsonb(ARRAY['canonicalText','inputDigest'])) THEN
        RAISE EXCEPTION 'channel_purchase_source_invalid' USING ERRCODE='P0001'; END IF;
      body:=public.channel_purchase_packet(NEW.metadata->>'canonicalText',NEW.metadata->>'inputDigest',NEW.event_type);
      IF body IS DISTINCT FROM NEW.payload OR NEW.aggregate_id::text IS DISTINCT FROM body#>>'{scope,connectionId}' THEN
        RAISE EXCEPTION 'channel_purchase_source_identity' USING ERRCODE='P0001'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='channel_order_ingests' THEN
    IF TG_OP='DELETE' AND OLD.purchase_capture_text IS NOT NULL THEN
      RAISE EXCEPTION 'channel_purchase_capture_retained' USING ERRCODE='P0001'; END IF;
    IF TG_OP='UPDATE' AND OLD.purchase_capture_text IS NOT NULL AND
      ROW(NEW.purchase_capture_text,NEW.purchase_capture_digest,NEW.channel_id,NEW.external_order_ref,NEW.external_order_revision,NEW.provider_event_id,NEW.normalized::text)
      IS DISTINCT FROM ROW(OLD.purchase_capture_text,OLD.purchase_capture_digest,OLD.channel_id,OLD.external_order_ref,OLD.external_order_revision,OLD.provider_event_id,OLD.normalized::text) THEN
      RAISE EXCEPTION 'channel_purchase_capture_immutable' USING ERRCODE='P0001'; END IF;
    IF TG_OP<>'DELETE' AND NEW.purchase_capture_text IS NOT NULL AND (TG_OP='INSERT' OR OLD.purchase_capture_text IS NULL) THEN
      IF current_user<>'openlup_channel_purchase_writer' THEN RAISE EXCEPTION 'channel_purchase_raw_capture_denied' USING ERRCODE='42501'; END IF;
      body:=public.channel_purchase_packet(NEW.purchase_capture_text,NEW.purchase_capture_digest,'channel.purchase-source.v1');
      IF body->'normalized' IS DISTINCT FROM NEW.normalized OR body#>>'{scope,channelId}' IS DISTINCT FROM NEW.channel_id::text THEN
        RAISE EXCEPTION 'channel_purchase_capture_identity' USING ERRCODE='P0001'; END IF;
    END IF;
  ELSE
    IF TG_OP='DELETE' AND OLD.pull_capture_adopted_at IS NOT NULL THEN RAISE EXCEPTION 'channel_purchase_connection_retained' USING ERRCODE='P0001'; END IF;
    IF TG_OP='INSERT' AND (NEW.pull_capture_adopted_at IS NOT NULL OR NEW.pull_page_ref IS NOT NULL OR NEW.pull_page_generation<>0) THEN
      RAISE EXCEPTION 'channel_purchase_fake_adoption' USING ERRCODE='P0001'; END IF;
    IF TG_OP='UPDATE' AND (OLD.pull_capture_adopted_at IS NOT NULL OR NEW.pull_capture_adopted_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.outbox_events e
      WHERE e.aggregate_id=OLD.id AND e.event_type IN ('channel.purchase-source.v1','channel.pull-page.v1'))) AND
      ROW(NEW.pull_cursor,NEW.pull_watermark_at,NEW.pull_page_ref,NEW.pull_page_generation,NEW.pull_capture_adopted_at)
      IS DISTINCT FROM ROW(OLD.pull_cursor,OLD.pull_watermark_at,OLD.pull_page_ref,OLD.pull_page_generation,OLD.pull_capture_adopted_at) THEN
      IF current_user<>'openlup_channel_purchase_writer' OR NEW.pull_capture_adopted_at IS NULL OR
        (OLD.pull_capture_adopted_at IS NOT NULL AND NEW.pull_capture_adopted_at IS DISTINCT FROM OLD.pull_capture_adopted_at)
        OR NEW.pull_page_generation<>OLD.pull_page_generation+1 THEN
        RAISE EXCEPTION 'channel_purchase_raw_progress_denied' USING ERRCODE='42501'; END IF;
      SELECT payload->'next' INTO receipt FROM public.outbox_events WHERE id=NEW.pull_page_ref AND event_type='channel.pull-page.v1'
        AND aggregate_id=NEW.id AND payload#>>'{expected,cursor}' IS NOT DISTINCT FROM OLD.pull_cursor
        AND (payload#>>'{expected,watermark}')::timestamptz IS NOT DISTINCT FROM OLD.pull_watermark_at
        AND (payload#>>'{expected,generation}')::bigint=OLD.pull_page_generation;
      IF receipt IS NULL OR receipt->>'cursor' IS DISTINCT FROM NEW.pull_cursor OR (receipt->>'watermark')::timestamptz IS DISTINCT FROM NEW.pull_watermark_at
        OR (receipt->>'generation')::bigint IS DISTINCT FROM NEW.pull_page_generation THEN
        RAISE EXCEPTION 'channel_purchase_progress_receipt_required' USING ERRCODE='P0001'; END IF;
    ELSIF TG_OP='UPDATE' AND OLD.pull_capture_adopted_at IS NULL AND (NEW.pull_page_ref IS NOT NULL OR NEW.pull_page_generation<>0) THEN
      RAISE EXCEPTION 'channel_purchase_fake_adoption' USING ERRCODE='P0001'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER channel_purchase_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_channel_connections
  FOR EACH ROW EXECUTE FUNCTION public.channel_purchase_guard();
CREATE TRIGGER channel_purchase_ingest_guard BEFORE INSERT OR UPDATE OR DELETE ON public.channel_order_ingests
  FOR EACH ROW EXECUTE FUNCTION public.channel_purchase_guard();
CREATE TRIGGER channel_purchase_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION public.channel_purchase_guard();
CREATE TRIGGER channel_purchase_connection_truncate BEFORE TRUNCATE ON public.sales_channel_connections
  FOR EACH STATEMENT EXECUTE FUNCTION public.channel_purchase_guard();
CREATE TRIGGER channel_purchase_ingest_truncate BEFORE TRUNCATE ON public.channel_order_ingests
  FOR EACH STATEMENT EXECUTE FUNCTION public.channel_purchase_guard();
CREATE TRIGGER channel_purchase_outbox_truncate BEFORE TRUNCATE ON public.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.channel_purchase_guard();

CREATE FUNCTION public.channel_pull_page_record(p_connection_id uuid,p_actor_id uuid,p_job_run_id uuid,
  p_page_packet_id uuid,p_canonical_text text,p_input_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE body jsonb; c uuid; original public.outbox_events%ROWTYPE;
BEGIN
  body:=public.channel_purchase_packet(p_canonical_text,p_input_digest,'channel.pull-page.v1');
  IF body ? 'cursorReceipt' THEN RAISE EXCEPTION 'channel_purchase_authored_receipt' USING ERRCODE='22023'; END IF;
  c:=public.channel_purchase_scope(body,p_actor_id,p_job_run_id,false);
  IF c IS DISTINCT FROM p_connection_id OR body->>'pagePacketId' IS DISTINCT FROM p_page_packet_id::text THEN
    RAISE EXCEPTION 'channel_pull_packet_scope' USING ERRCODE='P0001'; END IF;
  SELECT * INTO original FROM public.outbox_events WHERE event_type='channel.pull-page.v1' AND idempotency_key='channel:pull-page:v1:'||c||':'||p_page_packet_id;
  IF FOUND THEN
    IF original.metadata->>'canonicalText' IS DISTINCT FROM p_canonical_text OR original.metadata->>'inputDigest' IS DISTINCT FROM p_input_digest THEN
      RAISE EXCEPTION 'channel_pull_packet_conflict' USING ERRCODE='23505'; END IF;
  ELSE
    PERFORM public.channel_purchase_scope(body,p_actor_id,p_job_run_id,true);
    IF body#>'{request,from}' IS DISTINCT FROM body#>'{expected,cursor}' OR (body#>>'{request,limit}')::int NOT BETWEEN 1 AND 1000
      OR jsonb_array_length(body->'events')>(body#>>'{request,limit}')::int OR body#>>'{next,cursor}' IS DISTINCT FROM
      coalesce(body#>>ARRAY['events',(jsonb_array_length(body->'events')-1)::text,'providerEventId'],body#>>'{expected,cursor}')
      OR (body#>>'{next,generation}')::bigint<>(body#>>'{expected,generation}')::bigint+1 THEN
      RAISE EXCEPTION 'channel_pull_packet_shape' USING ERRCODE='22023'; END IF;
    INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
      VALUES(p_page_packet_id,'channel_connection',c,'channel.pull-page.v1','channel:pull-page:v1:'||c||':'||p_page_packet_id,body,
        jsonb_build_object('canonicalText',p_canonical_text,'inputDigest',p_input_digest));
  END IF;
  RETURN jsonb_build_object('pagePacketId',p_page_packet_id,'inputDigest',p_input_digest);
END; $$;
CREATE FUNCTION public.channel_pull_page_read(p_connection_id uuid,p_page_packet_id uuid,p_actor_id uuid,p_input_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original public.outbox_events%ROWTYPE; answer jsonb; receipt public.outbox_events%ROWTYPE;
BEGIN
  PERFORM public.channel_control_actor(p_actor_id,false);
  SELECT * INTO original FROM public.outbox_events WHERE id=p_page_packet_id AND event_type='channel.pull-page.v1' AND aggregate_id=p_connection_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM public.channel_purchase_scope(original.payload,p_actor_id,(original.payload#>>'{execution,jobRunId}')::uuid,false);
  IF original.metadata->>'inputDigest' IS DISTINCT FROM p_input_digest THEN RAISE EXCEPTION 'channel_pull_packet_conflict' USING ERRCODE='23505'; END IF;
  SELECT * INTO receipt FROM public.outbox_events WHERE event_type='channel.pull-page.v1'
    AND idempotency_key='channel:pull-progress:v1:'||p_connection_id||':'||p_page_packet_id;
  RETURN jsonb_build_object('canonicalText',original.metadata->>'canonicalText','inputDigest',p_input_digest,'cursorReceipt',receipt.payload->'cursorReceipt');
END; $$;
CREATE FUNCTION public.channel_pull_progress_commit(p_connection_id uuid,p_actor_id uuid,p_job_run_id uuid,p_page_packet_id uuid,
  p_expected_cursor text,p_expected_watermark timestamptz,p_expected_generation bigint,p_next_cursor text,p_next_watermark timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original public.outbox_events%ROWTYPE; c public.sales_channel_connections%ROWTYPE; receipt public.outbox_events%ROWTYPE; result jsonb; packet jsonb; canonical text;
BEGIN
  PERFORM public.channel_control_actor(p_actor_id,false);
  SELECT * INTO original FROM public.outbox_events WHERE id=p_page_packet_id AND event_type='channel.pull-page.v1' AND aggregate_id=p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_pull_packet_missing' USING ERRCODE='P0001'; END IF;
  PERFORM public.channel_purchase_scope(original.payload,p_actor_id,p_job_run_id,false);
  SELECT * INTO receipt FROM public.outbox_events WHERE event_type='channel.pull-page.v1'
    AND idempotency_key='channel:pull-progress:v1:'||p_connection_id||':'||p_page_packet_id;
  result:=jsonb_build_object('pagePacketId',p_page_packet_id,'before',original.payload->'expected','after',original.payload->'next');
  IF original.payload#>>'{expected,cursor}' IS DISTINCT FROM p_expected_cursor
    OR (original.payload#>>'{expected,watermark}')::timestamptz IS DISTINCT FROM p_expected_watermark
    OR (original.payload#>>'{expected,generation}')::bigint IS DISTINCT FROM p_expected_generation
    OR original.payload#>>'{next,cursor}' IS DISTINCT FROM p_next_cursor
    OR (original.payload#>>'{next,watermark}')::timestamptz IS DISTINCT FROM p_next_watermark THEN
    RAISE EXCEPTION 'channel_pull_progress_conflict' USING ERRCODE='23505'; END IF;
  IF FOUND THEN
    IF receipt.payload->'cursorReceipt' IS DISTINCT FROM result THEN RAISE EXCEPTION 'channel_pull_progress_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('outcome','replayed','result',result);
  END IF;
  PERFORM public.channel_purchase_scope(original.payload,p_actor_id,p_job_run_id,true);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(original.payload->'events') event WHERE event->>'disposition'='purchase'
    AND NOT EXISTS(SELECT 1 FROM public.outbox_events capture JOIN public.channel_order_ingests i ON i.id=(capture.payload->>'ledgerId')::uuid
      WHERE capture.id=(event->>'captureRef')::uuid AND capture.event_type='channel.purchase-source.v1'
        AND capture.aggregate_id=p_connection_id AND capture.payload->>'providerEventId'=event->>'providerEventId')) THEN
    RAISE EXCEPTION 'channel_pull_purchase_not_durable' USING ERRCODE='P0001'; END IF;
  SELECT * INTO c FROM public.sales_channel_connections WHERE id=p_connection_id FOR UPDATE;
  IF c.pull_cursor IS DISTINCT FROM p_expected_cursor OR c.pull_watermark_at IS DISTINCT FROM p_expected_watermark
    OR c.pull_page_generation<>p_expected_generation OR original.payload->'expected' IS DISTINCT FROM result->'before'
    OR original.payload->'next' IS DISTINCT FROM result->'after' THEN RAISE EXCEPTION 'channel_pull_progress_conflict' USING ERRCODE='23505'; END IF;
  UPDATE public.sales_channel_connections SET pull_cursor=p_next_cursor,pull_watermark_at=p_next_watermark,pull_page_ref=p_page_packet_id,
    pull_page_generation=p_expected_generation+1,pull_capture_adopted_at=coalesce(pull_capture_adopted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=p_connection_id;
  packet:=original.payload||jsonb_build_object('cursorReceipt',result); canonical:=public.channel_purchase_json(packet);
  INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES('channel_connection',p_connection_id,'channel.pull-page.v1','channel:pull-progress:v1:'||p_connection_id||':'||p_page_packet_id,
      packet,jsonb_build_object('canonicalText',canonical,'inputDigest',encode(sha256(convert_to(canonical,'UTF8')),'hex')));
  RETURN jsonb_build_object('outcome','applied','result',result);
END; $$;

CREATE FUNCTION public.channel_ingest_record_inbound_event(p_channel_id uuid,p_external_order_ref text,
  p_external_order_revision text,p_provider_event_id text,p_normalized jsonb,p_capture_text text,p_capture_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE body jsonb; c uuid; actor uuid; job uuid; original public.outbox_events%ROWTYPE; claim public.outbox_events%ROWTYPE;
  ledger public.channel_order_ingests%ROWTYPE; result jsonb; line jsonb; bought jsonb; claim_body jsonb;
  canonical text; ledger_id uuid; adopted uuid; existing_count integer:=0; total_count integer; source jsonb;
  gross numeric:=0; discount numeric:=0;
BEGIN
  body:=public.channel_purchase_packet(p_capture_text,p_capture_digest,'channel.purchase-source.v1');
  IF body ? 'ledgerId' OR body ? 'ledgerResult' THEN RAISE EXCEPTION 'channel_purchase_authored_receipt' USING ERRCODE='22023'; END IF;
  actor:=(body#>>'{execution,actorId}')::uuid; job:=(body#>>'{execution,jobRunId}')::uuid;
  c:=public.channel_purchase_scope(body,actor,job,false);
  IF body#>>'{scope,channelId}' IS DISTINCT FROM p_channel_id::text OR body->'normalized' IS DISTINCT FROM p_normalized
    OR body->'externalOrderRef' IS DISTINCT FROM to_jsonb(p_external_order_ref)
    OR body->'externalOrderRevision' IS DISTINCT FROM coalesce(to_jsonb(p_external_order_revision),'null'::jsonb)
    OR body->'providerEventId' IS DISTINCT FROM to_jsonb(p_provider_event_id)
    OR p_normalized->'externalOrderRef' IS DISTINCT FROM body->'externalOrderRef'
    OR p_normalized->'externalOrderRevision' IS DISTINCT FROM body->'externalOrderRevision'
    OR p_normalized->'providerEventId' IS DISTINCT FROM body->'providerEventId'
    OR NOT public.channel_control_keys(p_normalized,to_jsonb(ARRAY['contractVersion','channelSlug','externalOrderRef','externalOrderRevision',
      'providerEventId','placedAt','currency','buyer','shipTo','lines','shipping','totals','payment','payloadDigest']))
    OR NOT public.channel_control_keys(p_normalized->'buyer',to_jsonb(ARRAY['externalCustomerRef','email','emailIsMasked','firstName','lastName','phone','taxId','companyName']))
    OR NOT public.channel_control_keys(p_normalized->'shipTo',to_jsonb(ARRAY['recipientName','line1','line2','postalCode','city','countryCode','phone','pickupPointRef']))
    OR NOT public.channel_control_keys(p_normalized->'shipping',to_jsonb(ARRAY['grossMinor','discountMinor','methodLabel','carrierHint']))
    OR NOT public.channel_control_keys(p_normalized->'payment',to_jsonb(ARRAY['state','externalPaymentRef','paidAt','methodLabel']))
    OR p_normalized->>'contractVersion' IS DISTINCT FROM 'channel.order.v1'
    OR p_normalized->>'currency' IS DISTINCT FROM body#>>'{scope,currency}'
    OR (body->>'capturedAt')::timestamptz IS NULL OR (p_normalized->>'placedAt')::timestamptz IS NULL
    OR (p_normalized#>>'{payment,paidAt}')::timestamptz IS NULL
    OR NOT public.channel_control_ref(p_normalized#>>'{payment,externalPaymentRef}')
    OR body->>'rawSourceDigest' !~ '^[0-9a-f]{64}$'
    OR NOT public.channel_control_keys(p_normalized->'totals',to_jsonb(ARRAY['itemsGrossMinor','itemsDiscountMinor','shippingGrossMinor','shippingDiscountMinor','grandTotalMinor']))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_normalized->'totals') x WHERE jsonb_typeof(x.value)<>'number'
      OR x.value::text !~ '^[0-9]+$' OR x.value::numeric>9007199254740991)
    OR p_normalized#>>'{payment,state}' IS DISTINCT FROM 'paid_externally' OR p_normalized->>'payloadDigest' IS DISTINCT FROM body->>'rawSourceDigest'
    OR encode(sha256(convert_to(public.channel_purchase_json(p_normalized),'UTF8')),'hex') IS DISTINCT FROM body->>'normalizedDigest' THEN
    RAISE EXCEPTION 'channel_purchase_capture_conflict' USING ERRCODE='22023'; END IF;
  SELECT * INTO original FROM public.outbox_events WHERE event_type='channel.purchase-source.v1'
    AND idempotency_key='channel:purchase-source:v1:'||c||':'||p_provider_event_id;
  IF FOUND THEN
    IF original.payload-'ledgerId'-'ledgerResult' IS DISTINCT FROM body-'normalized' THEN
      RAISE EXCEPTION 'channel_purchase_capture_conflict' USING ERRCODE='23505'; END IF;
    RETURN original.payload->'ledgerResult';
  END IF;
  PERFORM public.channel_purchase_scope(body,actor,job,true);
  IF NOT EXISTS(SELECT 1 FROM public.outbox_events page CROSS JOIN LATERAL jsonb_array_elements(page.payload->'events') event
    WHERE page.id=(body->>'pagePacketRef')::uuid AND page.event_type='channel.pull-page.v1' AND page.aggregate_id=c
      AND event->>'providerEventId'=p_provider_event_id AND event->>'captureRef'=body->>'captureId'
      AND event->>'externalOrderRef'=p_external_order_ref AND event->>'externalOrderRevision' IS NOT DISTINCT FROM p_external_order_revision) THEN
    RAISE EXCEPTION 'channel_purchase_original_page_required' USING ERRCODE='P0001'; END IF;
  total_count:=jsonb_array_length(p_normalized->'lines');
  IF total_count NOT BETWEEN 1 AND 100 OR jsonb_array_length(body->'products')<>total_count
    OR (SELECT count(DISTINCT x->>'externalLineRef') FROM jsonb_array_elements(p_normalized->'lines') x)<>total_count THEN
    RAISE EXCEPTION 'channel_purchase_line_identity' USING ERRCODE='22023'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(p_normalized->'lines') LOOP
    SELECT value INTO bought FROM jsonb_array_elements(body->'products') WHERE value->>'externalLineRef'=line->>'externalLineRef';
    IF NOT public.channel_control_keys(line,to_jsonb(ARRAY['externalLineRef','sellable','quantity','unitGrossMinor','lineGrossMinor','lineDiscountMinor','vatRateBps']))
      OR NOT public.channel_control_keys(bought,to_jsonb(ARRAY['externalLineRef','externalOfferRef','purchasedAt','products']))
      OR NOT public.channel_control_ref(line->>'externalLineRef') OR bought IS NULL OR (bought->>'purchasedAt')::timestamptz IS NULL
      OR (bought->>'purchasedAt')::timestamptz>(p_normalized#>>'{payment,paidAt}')::timestamptz
      OR jsonb_array_length(bought->'products') NOT BETWEEN 1 AND 100
      OR (SELECT count(DISTINCT x->>'externalProductRef') FROM jsonb_array_elements(bought->'products') x)<>jsonb_array_length(bought->'products')
      OR bought->>'externalOfferRef' IS DISTINCT FROM line#>>'{sellable,externalOfferRef}'
      OR line->>'quantity' IS NULL OR line->>'quantity' !~ '^[1-9][0-9]*$' OR (line->>'quantity')::numeric>9007199254740991 OR EXISTS(SELECT 1 FROM jsonb_array_elements(bought->'products') x
        WHERE NOT public.channel_control_keys(x,to_jsonb(ARRAY['externalProductRef','quantityPerSet'])) OR x->>'quantityPerSet' IS NULL OR x->>'quantityPerSet' !~ '^[1-9][0-9]*$'
          OR (x->>'quantityPerSet')::numeric>9007199254740991 OR x->>'externalProductRef' IS NULL) THEN
      RAISE EXCEPTION 'channel_purchase_product_quantity' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM unnest(ARRAY['quantity','unitGrossMinor','lineGrossMinor','lineDiscountMinor']) key
      WHERE jsonb_typeof(line->key) IS DISTINCT FROM 'number' OR line->>key !~ '^[0-9]+$'
        OR (line->>key)::numeric>9007199254740991)
      OR (line->>'unitGrossMinor')::numeric*(line->>'quantity')::numeric IS DISTINCT FROM (line->>'lineGrossMinor')::numeric
      OR (line->>'lineDiscountMinor')::numeric>(line->>'lineGrossMinor')::numeric THEN
      RAISE EXCEPTION 'channel_purchase_line_money_invalid' USING ERRCODE='22023'; END IF;
    gross:=gross+(line->>'lineGrossMinor')::numeric; discount:=discount+(line->>'lineDiscountMinor')::numeric;
    SELECT * INTO claim FROM public.outbox_events WHERE event_type='channel.purchase-line.v1'
      AND idempotency_key='channel:purchase-line:v1:'||c||':'||(line->>'externalLineRef');
    IF FOUND THEN
      existing_count:=existing_count+1;
      IF claim.payload->'lineFacts' IS DISTINCT FROM line OR claim.payload->'products' IS DISTINCT FROM bought
        OR claim.payload->'payment' IS DISTINCT FROM p_normalized->'payment'
        OR (adopted IS NOT NULL AND adopted IS DISTINCT FROM (claim.payload->>'ledgerId')::uuid) THEN
        RAISE EXCEPTION 'channel_purchase_alias_conflict' USING ERRCODE='23505'; END IF;
      adopted:=(claim.payload->>'ledgerId')::uuid;
    END IF;
  END LOOP;
  IF gross IS DISTINCT FROM (p_normalized#>>'{totals,itemsGrossMinor}')::numeric
    OR discount IS DISTINCT FROM (p_normalized#>>'{totals,itemsDiscountMinor}')::numeric
    OR (p_normalized#>>'{totals,grandTotalMinor}')::numeric IS DISTINCT FROM gross-discount
      +(p_normalized#>>'{totals,shippingGrossMinor}')::numeric-(p_normalized#>>'{totals,shippingDiscountMinor}')::numeric THEN
    RAISE EXCEPTION 'channel_purchase_header_money_invalid' USING ERRCODE='22023'; END IF;
  IF existing_count>0 AND existing_count<>total_count THEN RAISE EXCEPTION 'channel_purchase_partial_alias' USING ERRCODE='23505'; END IF;
  IF adopted IS NOT NULL THEN
    SELECT * INTO ledger FROM public.channel_order_ingests WHERE id=adopted FOR UPDATE;
    IF ledger.purchase_capture_text::jsonb->'retainedRows' IS DISTINCT FROM body->'retainedRows' THEN
      RAISE EXCEPTION 'channel_purchase_alias_expansion_conflict' USING ERRCODE='23505'; END IF;
    IF ledger.normalized-'externalOrderRef'-'externalOrderRevision'-'providerEventId'-'payloadDigest' IS DISTINCT FROM
      p_normalized-'externalOrderRef'-'externalOrderRevision'-'providerEventId'-'payloadDigest' THEN
      RAISE EXCEPTION 'channel_purchase_alias_normalized_conflict' USING ERRCODE='23505'; END IF;
    result:=public.channel_ingest_record_inbound_event(ledger.channel_id,ledger.external_order_ref,ledger.external_order_revision,p_provider_event_id,ledger.normalized);
  ELSE
    SELECT * INTO ledger FROM public.channel_order_ingests WHERE channel_id=p_channel_id AND external_order_ref=p_external_order_ref FOR UPDATE;
    IF ledger.purchase_capture_text IS NOT NULL AND ledger.normalized IS DISTINCT FROM p_normalized THEN
      RAISE EXCEPTION 'channel_purchase_capture_conflict' USING ERRCODE='23505'; END IF;
    result:=public.channel_ingest_record_inbound_event(p_channel_id,p_external_order_ref,p_external_order_revision,p_provider_event_id,p_normalized);
  END IF;
  IF result#>>'{ingest,conflict}' IS NOT NULL THEN RETURN result; END IF;
  ledger_id:=(result#>>'{ingest,id}')::uuid;
  IF adopted IS NULL THEN
    UPDATE public.channel_order_ingests SET purchase_capture_text=p_capture_text,purchase_capture_digest=p_capture_digest
      WHERE id=ledger_id AND purchase_capture_text IS NULL;
    IF body ? 'retainedRows' THEN PERFORM public.channel_purchase_retained_lines(ledger_id,body->'retainedRows'); END IF;
    FOR line IN SELECT value FROM jsonb_array_elements(p_normalized->'lines') LOOP
      SELECT value INTO bought FROM jsonb_array_elements(body->'products') WHERE value->>'externalLineRef'=line->>'externalLineRef';
      claim_body:=jsonb_build_object('schemaVersion','channel.purchase-line.v1','scope',body->'scope','namespace',body->'namespace',
        'captureRef',body->'captureId','ledgerId',ledger_id,'externalOrderRef',p_external_order_ref,
        'externalOrderRevision',p_external_order_revision,'externalLineRef',line->>'externalLineRef','externalOfferRef',line#>>'{sellable,externalOfferRef}',
        'purchasedSets',line->'quantity','externalPaymentRef',p_normalized#>>'{payment,externalPaymentRef}',
        'rawSourceDigest',body->>'rawSourceDigest','lineFacts',line,'products',bought,'payment',p_normalized->'payment');
      canonical:=public.channel_purchase_json(claim_body);
      INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
        VALUES('channel_connection',c,'channel.purchase-line.v1','channel:purchase-line:v1:'||c||':'||(line->>'externalLineRef'),claim_body,
          jsonb_build_object('canonicalText',canonical,'inputDigest',encode(sha256(convert_to(canonical,'UTF8')),'hex')));
    END LOOP;
  END IF;
  source:=(body-'normalized')||jsonb_build_object('ledgerId',ledger_id,'ledgerResult',result); canonical:=public.channel_purchase_json(source);
  INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES((body->>'captureId')::uuid,'channel_connection',c,'channel.purchase-source.v1','channel:purchase-source:v1:'||c||':'||p_provider_event_id,
      source,jsonb_build_object('canonicalText',canonical,'inputDigest',encode(sha256(convert_to(canonical,'UTF8')),'hex')));
  RETURN result;
END; $$;
CREATE FUNCTION public.channel_ingest_capture_read(p_channel_id uuid,p_provider_event_id text,p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original public.outbox_events%ROWTYPE; body jsonb; canonical text; normalized jsonb;
BEGIN
  PERFORM public.channel_control_actor(p_actor_id,false);
  SELECT * INTO original FROM public.outbox_events WHERE event_type='channel.purchase-source.v1'
    AND payload#>>'{scope,channelId}'=p_channel_id::text AND payload->>'providerEventId'=p_provider_event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  body:=original.payload-'ledgerId'-'ledgerResult';
  SELECT i.normalized INTO normalized FROM public.channel_order_ingests i WHERE i.id=(original.payload->>'ledgerId')::uuid;
  IF normalized IS NULL THEN RAISE EXCEPTION 'channel_purchase_ledger_missing' USING ERRCODE='P0001'; END IF;
  normalized:=normalized||jsonb_build_object('externalOrderRef',body->'externalOrderRef','externalOrderRevision',body->'externalOrderRevision',
    'providerEventId',body->'providerEventId','payloadDigest',body->'rawSourceDigest');
  IF encode(sha256(convert_to(public.channel_purchase_json(normalized),'UTF8')),'hex') IS DISTINCT FROM body->>'normalizedDigest' THEN
    RAISE EXCEPTION 'channel_purchase_normalized_receipt_conflict' USING ERRCODE='P0001'; END IF;
  body:=body||jsonb_build_object('normalized',normalized);
  PERFORM public.channel_purchase_scope(body,p_actor_id,(body#>>'{execution,jobRunId}')::uuid,false);
  canonical:=public.channel_purchase_json(body);
  RETURN jsonb_build_object('ledgerId',original.payload->>'ledgerId','canonicalText',canonical,
    'inputDigest',encode(sha256(convert_to(canonical,'UTF8')),'hex'));
END; $$;

-- Retained paid order expansion is checked against the first approved physical contract.
-- Archived SKU admission is narrowly licensed by accepted capture plus these live retained rows.
-- Npm remains the sole allocator; SQL reasserts physical and monetary conservation, not Hamilton.
CREATE FUNCTION public.channel_purchase_retained_lines(p_ledger_id uuid,p_rows jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i public.channel_order_ingests%ROWTYPE; purchase jsonb; wire jsonb; l public.sales_channel_listings%ROWTYPE;
  a public.sales_channel_listing_approvals%ROWTYPE; q public.sales_channel_listing_qualifications%ROWTYPE;
  b public.catalog_bundles%ROWTYPE; component record; actual numeric; gross numeric; discount numeric; fact jsonb;
BEGIN
  SELECT * INTO i FROM public.channel_order_ingests WHERE id=p_ledger_id;
  IF i.purchase_capture_text IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array'
    OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'channel_purchase_retained_rows_required' USING ERRCODE='22023'; END IF;
  IF (SELECT count(DISTINCT (row->>'externalLineRef',row#>>'{retained,skuId}',row#>>'{retained,groupIndex}')) FROM jsonb_array_elements(p_rows) row)<>jsonb_array_length(p_rows)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row WHERE row#>>'{retained,groupIndex}' IS NULL
      OR row#>>'{retained,groupIndex}' !~ '^[0-2]$') THEN
    RAISE EXCEPTION 'channel_purchase_retained_group_identity' USING ERRCODE='P0001'; END IF;
  IF i.purchase_capture_text::jsonb->'retainedRows' IS DISTINCT FROM p_rows THEN
    RAISE EXCEPTION 'channel_purchase_frozen_expansion_conflict' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.normalized->'lines') x
    WHERE x->>'externalLineRef'=row->>'externalLineRef')) THEN
    RAISE EXCEPTION 'channel_purchase_retained_extra_line' USING ERRCODE='P0001'; END IF;
  FOR wire IN SELECT value FROM jsonb_array_elements(i.normalized->'lines') LOOP
    SELECT * INTO l FROM public.sales_channel_listings WHERE channel_id=i.channel_id AND external_offer_ref=wire#>>'{sellable,externalOfferRef}';
    SELECT * INTO a FROM public.sales_channel_listing_approvals WHERE listing_id=l.id ORDER BY listing_version LIMIT 1;
    SELECT * INTO q FROM public.sales_channel_listing_qualifications WHERE id=a.qualification_id AND listing_id=l.id;
    SELECT * INTO b FROM public.catalog_bundles WHERE id=l.sellable_bundle_id;
    SELECT value INTO purchase FROM jsonb_array_elements(i.purchase_capture_text::jsonb->'products') WHERE value->>'externalLineRef'=wire->>'externalLineRef';
    IF l.id IS NULL OR a.id IS NULL OR q.id IS NULL OR b.composition_locked_at IS NULL OR purchase IS NULL
      OR b.composition_digest IS DISTINCT FROM a.body->>'bundleDigest' OR b.composition_digest IS DISTINCT FROM q.body->>'bundleDigest'
      OR b.composition_digest IS DISTINCT FROM public.catalog_bundle_composition_digest(b.id)
      OR q.body->>'disposition' IS DISTINCT FROM 'qualified' OR q.body#>>'{offer,externalOfferRef}' IS DISTINCT FROM l.external_offer_ref
      OR (a.body->>'approvedAt')::timestamptz>(purchase->>'purchasedAt')::timestamptz
      OR b.composition_locked_at>(purchase->>'purchasedAt')::timestamptz THEN
      RAISE EXCEPTION 'channel_purchase_retained_binding_conflict' USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row WHERE row->>'externalLineRef'=wire->>'externalLineRef' AND
      (row->>'externalOfferRef' IS DISTINCT FROM l.external_offer_ref OR row->>'bundleCode' IS DISTINCT FROM b.code
        OR (row->>'bundleQty')::numeric IS DISTINCT FROM (wire->>'quantity')::numeric
        OR row#>>'{retained,listingId}' IS DISTINCT FROM l.id::text OR row#>>'{retained,bundleDigest}' IS DISTINCT FROM b.composition_digest
        OR row#>>'{retained,firstApprovalId}' IS DISTINCT FROM a.id::text OR row#>>'{retained,firstQualificationId}' IS DISTINCT FROM q.id::text
        OR (row->>'quantity')::numeric<=0 OR (row->>'unitGrossMinor')::numeric*(row->>'quantity')::numeric IS DISTINCT FROM (row->>'lineGrossMinor')::numeric
        OR (row->>'lineDiscountMinor')::numeric NOT BETWEEN 0 AND (row->>'lineGrossMinor')::numeric
        OR row->'vatRateBps' IS DISTINCT FROM wire->'vatRateBps')) THEN
      RAISE EXCEPTION 'channel_purchase_retained_provenance_conflict' USING ERRCODE='P0001'; END IF;
    SELECT sum((row->>'lineGrossMinor')::numeric),sum((row->>'lineDiscountMinor')::numeric) INTO gross,discount
      FROM jsonb_array_elements(p_rows) row WHERE row->>'externalLineRef'=wire->>'externalLineRef';
    IF gross IS DISTINCT FROM (wire->>'lineGrossMinor')::numeric OR discount IS DISTINCT FROM (wire->>'lineDiscountMinor')::numeric THEN
      RAISE EXCEPTION 'channel_purchase_retained_line_money_conflict' USING ERRCODE='P0001'; END IF;
    FOR component IN SELECT c.*,s.sku FROM public.catalog_bundle_components c JOIN public.catalog_skus s ON s.id=c.catalog_sku_id
      WHERE c.bundle_id=b.id LOOP
      SELECT sum((row->>'quantity')::numeric) INTO actual FROM jsonb_array_elements(p_rows) row
        WHERE row->>'externalLineRef'=wire->>'externalLineRef' AND row#>>'{retained,skuId}'=component.catalog_sku_id::text;
      SELECT bought INTO fact FROM jsonb_array_elements(purchase->'products') bought JOIN jsonb_array_elements(q.body->'mapping') mapping
        ON bought->>'externalProductRef'=mapping->>'externalProductRef' WHERE mapping->>'skuId'=component.catalog_sku_id::text;
      IF component.is_addon OR actual IS DISTINCT FROM component.quantity::numeric*(wire->>'quantity')::numeric
        OR (fact->>'quantityPerSet')::numeric IS DISTINCT FROM component.quantity::numeric
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row WHERE row->>'externalLineRef'=wire->>'externalLineRef'
          AND row#>>'{retained,skuId}'=component.catalog_sku_id::text AND (row->>'skuCode' IS DISTINCT FROM component.sku OR
            NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.body->'basis') basis WHERE basis->>'skuId'=component.catalog_sku_id::text
              AND basis->'weightMinor'=row#>'{retained,weightMinor}' AND (row#>>'{retained,normalizationFactor}')::numeric>0))) THEN
        RAISE EXCEPTION 'channel_purchase_retained_physical_conflict' USING ERRCODE='P0001'; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row WHERE row->>'externalLineRef'=wire->>'externalLineRef'
      AND NOT EXISTS(SELECT 1 FROM public.catalog_bundle_components c WHERE c.bundle_id=b.id AND c.catalog_sku_id::text=row#>>'{retained,skuId}')) THEN
      RAISE EXCEPTION 'channel_purchase_retained_extra_component' USING ERRCODE='P0001'; END IF;
  END LOOP;
END; $$;

-- The order writer retains shipping declaration refusal and selectedDelivery copy,
-- exact legacy replay/payment keys, currency checks, unit/header money and tax-rounding behavior.
-- Only an accepted captured-paid branch may use archived SKU identities: supplied groups must
-- equal immutable retainedRows and pass first approval/BOM/basis/quantity/money validation.
-- No allocator is generated or moved to SQL, and installation creates no order or reservation.
CREATE OR REPLACE FUNCTION public.commerce_create_channel_order(
  p_idempotency_key text,
  p_ledger_id uuid,
  p_expanded_lines jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_scope constant text := 'channels.order.create';
  v_ledger public.channel_order_ingests%ROWTYPE;
  v_channel public.sales_channels%ROWTYPE;
  v_existing public.commerce_idempotency_keys%ROWTYPE;
  v_request_fingerprint text;
  v_order jsonb;
  v_totals jsonb;
  v_source jsonb;
  v_line jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_ordinal integer := 0;
  v_sku_code text;
  v_sku_id uuid;
  v_vat_bps integer;
  v_sku_vat_bps integer;
  v_effective integer;
  v_net integer;
  v_lines_gross bigint := 0;
  v_lines_discount bigint := 0;
  v_net_total bigint := 0;
  v_shipping_net integer;
  v_shipping_vat_bps integer;
  v_order_id uuid;
  v_order_number text;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 OR p_ledger_id IS NULL THEN
    RAISE EXCEPTION 'channel_order_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ledger FROM public.channel_order_ingests WHERE id = p_ledger_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_ingest_ledger_not_found' USING ERRCODE = '22023';
  END IF;

  -- The order this ledger row already produced IS the replay answer, and it is a stronger one than
  -- a stored response payload: it is the live row. The previous wave's partial unique index on
  -- (source_channel_id, source_order_ref) is the second line of defence, for the case where two
  -- callers race past this read.
  IF v_ledger.order_id IS NOT NULL THEN
    SELECT order_number INTO v_order_number FROM public.commerce_orders WHERE id = v_ledger.order_id;
    RETURN jsonb_build_object(
      'contractVersion', 'channels.ingest.v0',
      'channelOrder', jsonb_build_object(
        'orderId', v_ledger.order_id, 'orderRef', v_order_number, 'replayed', true
      )
    );
  END IF;

  IF v_ledger.client_id IS NULL OR v_ledger.shipping_address_id IS NULL THEN
    RAISE EXCEPTION 'channel_order_buyer_not_resolved' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_channel FROM public.sales_channels WHERE id = v_ledger.channel_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_ingest_channel_not_found' USING ERRCODE = '22023';
  END IF;

  v_order := v_ledger.normalized;
  v_totals := v_order->'totals';

  IF v_order->>'contractVersion' IS DISTINCT FROM 'channel.order.v1' THEN
    RAISE EXCEPTION 'channel_order_unsupported_contract_version' USING ERRCODE = '22023';
  END IF;

  -- Require an external settlement reference before creating payable order state.
  IF NULLIF(btrim(COALESCE(v_order#>>'{payment,externalPaymentRef}', '')), '') IS NULL THEN
    RAISE EXCEPTION 'channel_order_missing_settlement_evidence' USING ERRCODE = '22023';
  END IF;

  -- The channel row is the currency authority. Nothing below states a currency code.
  IF v_order->>'currency' IS DISTINCT FROM v_channel.currency THEN
    RAISE EXCEPTION 'channel_order_currency_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Persist the explicit channel delivery selection; never infer a provider for paid debt.
  IF v_channel.delivery_selection IS NULL THEN
    RAISE EXCEPTION 'channel_order_delivery_selection_undeclared' USING ERRCODE = '22023';
  END IF;

  -- The header equation, re-asserted rather than trusted.
  IF (v_totals->>'grandTotalMinor')::bigint <> (
    (v_totals->>'itemsGrossMinor')::bigint - (v_totals->>'itemsDiscountMinor')::bigint
    + (v_totals->>'shippingGrossMinor')::bigint - (v_totals->>'shippingDiscountMinor')::bigint
  ) THEN
    RAISE EXCEPTION 'channel_order_money_equation_mismatch' USING ERRCODE = '22023';
  END IF;

  -- WHICH LINE SET GETS WRITTEN. The expansion when the caller resolved one, the wire lines
  -- otherwise. This is the ONE behavioural fork this migration introduces, and it is deliberately a
  -- fork in the INPUT rather than in the logic: everything below runs identically either way, so a
  -- bundle order and a SKU order cannot drift into two different code paths that age separately.
  -- An expansion that is present but empty is a caller defect, not an order with no lines, and it
  -- is refused by the existing no-lines check below.
  v_source := COALESCE(p_expanded_lines, v_order->'lines');
  IF v_ledger.purchase_capture_text IS NOT NULL THEN
    PERFORM public.channel_purchase_retained_lines(v_ledger.id,p_expanded_lines);
  END IF;

  -- FIRST PASS: resolve and check every line before a single row is written. This is not a style
  -- choice. `commerce_orders.tax_cents` is one of the columns the canonical-money freeze trigger
  -- refuses to see change after the header exists, so the header cannot be inserted and then
  -- corrected -- the tax figure has to be known before the INSERT, and it is a function of every
  -- line's resolved VAT rate. Resolving here also means an unmappable SKU or an unresolvable rate
  -- refuses the order before it exists, rather than leaving a half-written one behind.
  FOR v_line IN SELECT jsonb_array_elements(v_source) LOOP
    v_ordinal := v_ordinal + 1;
    v_lines_gross := v_lines_gross + (v_line->>'lineGrossMinor')::bigint;
    v_lines_discount := v_lines_discount + (v_line->>'lineDiscountMinor')::bigint;

    -- A wire line names its sellable under `sellable`; an expanded line has already been resolved
    -- to a SKU and names it directly. Both are read here, and a wire line of any kind other than
    -- `sku` that reached this point WITHOUT an expansion is still refused by name -- which is what
    -- makes an unexpanded bundle a loud refusal rather than a silently dropped line.
    IF p_expanded_lines IS NULL AND v_line#>>'{sellable,kind}' IS DISTINCT FROM 'sku' THEN
      RAISE EXCEPTION 'channel_order_unsupported_sellable_kind' USING ERRCODE = '22023';
    END IF;

    v_sku_code := NULLIF(btrim(COALESCE(v_line->>'skuCode', v_line#>>'{sellable,skuCode}', '')), '');
    IF v_sku_code IS NULL THEN
      RAISE EXCEPTION 'channel_order_unmapped_sellable' USING ERRCODE = '22023';
    END IF;

    -- Ordinary callers retain active-only lookup. Accepted paid capture licenses only
    -- the exact first-BOM SKU identities already checked by the retained boundary above.
    IF v_ledger.purchase_capture_text IS NOT NULL THEN
      SELECT id,NULLIF(btrim(COALESCE(metadata->>'vatRateBps','')), '')::integer INTO v_sku_id,v_sku_vat_bps
        FROM public.catalog_skus WHERE id=(v_line#>>'{retained,skuId}')::uuid AND sku=v_sku_code;
    ELSE
      SELECT id,NULLIF(btrim(COALESCE(metadata->>'vatRateBps','')), '')::integer INTO v_sku_id,v_sku_vat_bps
        FROM public.catalog_skus WHERE sku=v_sku_code AND status='active';
    END IF;
    IF v_sku_id IS NULL THEN
      RAISE EXCEPTION 'channel_order_unmapped_sellable' USING ERRCODE = '22023';
    END IF;

    -- Resolve VAT from line, SKU, then channel; missing tax facts refuse.
    v_vat_bps := COALESCE(
      NULLIF(btrim(COALESCE(v_line->>'vatRateBps', '')), '')::integer,
      v_sku_vat_bps,
      v_channel.default_vat_rate_bps
    );
    IF v_vat_bps IS NULL THEN
      RAISE EXCEPTION 'channel_order_vat_unresolvable' USING ERRCODE = '22023';
    END IF;

    v_effective := (v_line->>'lineGrossMinor')::integer - (v_line->>'lineDiscountMinor')::integer;
    v_net := round(v_effective::numeric * 10000::numeric / (10000 + v_vat_bps)::numeric)::integer;
    v_net_total := v_net_total + v_net;

    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'line', v_line, 'skuId', v_sku_id, 'skuCode', v_sku_code,
      'vatRateBps', v_vat_bps, 'effective', v_effective, 'net', v_net, 'ordinal', v_ordinal
    ));
  END LOOP;

  IF v_ordinal = 0 THEN
    RAISE EXCEPTION 'channel_order_no_lines' USING ERRCODE = '22023';
  END IF;

  -- Expanded gross and discount sums must each equal the original header.
  IF v_lines_gross <> (v_totals->>'itemsGrossMinor')::bigint
    OR v_lines_discount <> (v_totals->>'itemsDiscountMinor')::bigint
  THEN
    RAISE EXCEPTION 'channel_order_line_sum_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope AND idempotency_key = p_idempotency_key
   FOR UPDATE;
  v_request_fingerprint := md5(v_ledger.id::text || '|' || v_ledger.channel_id::text || '|'
    || v_ledger.external_order_ref || '|' || (v_totals->>'grandTotalMinor'));
  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_request_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{channelOrder,replayed}', 'true'::jsonb, false);
    END IF;
    RAISE EXCEPTION 'channel_order_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.commerce_idempotency_keys (
    scope, idempotency_key, request_fingerprint, status, metadata
  )
  VALUES (
    v_scope, p_idempotency_key, v_request_fingerprint, 'in_progress',
    jsonb_build_object('boundary', 'commerce_create_channel_order', 'ingestId', v_ledger.id)
  );

  -- Shipping uses declared channel VAT or the existing zero-rate default.
  v_shipping_vat_bps := COALESCE(v_channel.default_vat_rate_bps, 0);
  v_shipping_net := round(
    ((v_totals->>'shippingGrossMinor')::integer - (v_totals->>'shippingDiscountMinor')::integer)::numeric
    * 10000::numeric / (10000 + v_shipping_vat_bps)::numeric
  )::integer;

  INSERT INTO public.commerce_orders (
    client_id, status, currency,
    subtotal_cents, discount_cents, shipping_cents, shipping_discount_cents,
    tax_cents, total_cents, region_code, mode, shipping_address_id,
    source_kind, source_channel_id, source_order_ref, metadata
  )
  VALUES (
    v_ledger.client_id, 'draft', v_channel.currency,
    (v_totals->>'itemsGrossMinor')::integer,
    (v_totals->>'itemsDiscountMinor')::integer,
    (v_totals->>'shippingGrossMinor')::integer,
    (v_totals->>'shippingDiscountMinor')::integer,
    -- `tax_cents` is informational and sits outside the canonical money equation, but every writer
    -- in this schema sets it to total minus net, so this one does too. It is stated at INSERT
    -- because the freeze trigger refuses to see it change afterwards.
    ((v_totals->>'grandTotalMinor')::bigint - v_net_total - v_shipping_net)::integer,
    (v_totals->>'grandTotalMinor')::integer,
    -- The destination country is the region, rather than a stated one: this shop's own default
    -- would be wrong for every cross-border marketplace order.
    v_order#>>'{shipTo,countryCode}',
    'one_time',
    v_ledger.shipping_address_id,
    'marketplace', v_ledger.channel_id, v_ledger.external_order_ref,
    jsonb_build_object(
      'paymentStatus', 'not_started',
      'source', 'channels.ingest.v0',
      'channelSlug', v_channel.slug,
      'buyerCommsOwner', v_channel.buyer_comms_owner,
      'invoicePolicy', v_channel.invoice_policy,
      'channelOrderSnapshot', v_order,
      -- THE SAME KEY A STOREFRONT ORDER CARRIES, READ BY THE SAME RESOLVER, IN THE SAME PLACE.
      -- This is the whole point of the wave: a marketplace order is not routed by a second rail,
      -- it is given the one fact the single existing rail was missing. Copied verbatim from the
      -- surface; nothing here derives, normalizes or repairs it, so what an operator declared is
      -- what an operator can read back off the order.
      'selectedDelivery', v_channel.delivery_selection,
      -- WHAT THE FAR SIDE ASKED FOR, KEPT NEXT TO WHAT WAS CHOSEN. The buyer picked a delivery on
      -- the marketplace, described in the marketplace's own words. Those words are not this shop's
      -- options and are deliberately not translated into them -- but they are also not thrown
      -- away, because the one question an operator will ask about a marketplace parcel is whether
      -- what shipped matches what was bought. Both halves are on the order, so the comparison
      -- needs no second source.
      'channelShippingRequest', jsonb_build_object(
        'methodLabel', v_order#>>'{shipping,methodLabel}',
        'carrierHint', v_order#>>'{shipping,carrierHint}',
        'pickupPointRef', v_order#>>'{shipTo,pickupPointRef}'
      ),
      -- Present only when a bundle was exploded. An operator reading this order can then see the
      -- component set that was actually written next to the wire document that arrived, without
      -- having to re-run the allocator to find out what happened.
      'channelLineExpansion', p_expanded_lines,
      -- The invoice buyer is the human, not the identity row. Everything an invoice needs about
      -- them travels here, including the tax id a business buyer supplied on the far side.
      'invoiceBuyerSnapshot', jsonb_build_object(
        'email', NULLIF(btrim(lower(COALESCE(v_order#>>'{buyer,email}', ''))), ''),
        'emailIsMasked', COALESCE((v_order#>>'{buyer,emailIsMasked}')::boolean, false),
        'firstName', v_order#>>'{buyer,firstName}',
        'lastName', v_order#>>'{buyer,lastName}',
        'companyName', v_order#>>'{buyer,companyName}',
        'taxId', v_order#>>'{buyer,taxId}',
        'phone', v_order#>>'{buyer,phone}',
        'countryCode', v_order#>>'{shipTo,countryCode}'
      )
    )
  )
  RETURNING id, order_number INTO v_order_id, v_order_number;

  -- SECOND PASS: write the lines the first pass already resolved. Nothing is decided here.
  FOR v_line IN SELECT jsonb_array_elements(v_resolved) LOOP
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      vat_rate_bps, allocation_ordinal, product_snapshot
    )
    VALUES (
      v_order_id,
      (v_line->>'skuId')::uuid,
      (v_line#>>'{line,quantity}')::integer,
      (v_line#>>'{line,unitGrossMinor}')::integer,
      (v_line#>>'{line,lineGrossMinor}')::integer,
      (v_line#>>'{line,lineDiscountMinor}')::integer,
      (v_line->>'effective')::integer,
      (v_line->>'net')::integer,
      (v_line->>'vatRateBps')::integer,
      -- Stated outright rather than inferred: the wire order's own line order is the allocation
      -- order, and there is no quote snapshot here for the assigning trigger to prove one from.
      (v_line->>'ordinal')::integer,
      jsonb_build_object(
        'sku', v_line->>'skuCode',
        'source', 'channels.ingest.v0',
        'externalLineRef', v_line#>>'{line,externalLineRef}',
        'externalOfferRef', COALESCE(
          v_line#>>'{line,externalOfferRef}', v_line#>>'{line,sellable,externalOfferRef}'
        ),
        -- PROVENANCE, and it is the reason a picker can be told what to put in the box. Null on a
        -- line the marketplace sent as a SKU; on a component line it names the bundle it came out
        -- of and how many of that bundle were bought, so the component quantity on this row can
        -- always be traced back to a number the buyer actually chose.
        'bundleCode', v_line#>>'{line,bundleCode}',
        'bundleQty', v_line#>>'{line,bundleQty}',
        'channelLine', v_line->'line'
      )
    );
  END LOOP;

  -- Emitted in the same transaction that creates the order, so a consumer can never observe one
  -- without the other. Nothing registers a handler for this type yet: the dispatcher's claim
  -- anti-join leaves an unregistered type pending, harmlessly, until one exists.
  INSERT INTO public.outbox_events (
    aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata
  )
  VALUES (
    'commerce_order', v_order_id, 'channel.order.ingested', p_idempotency_key || ':ingested',
    jsonb_build_object(
      'contract_version', 'channel.order.ingested.v1',
      'order_id', v_order_id,
      'channel_slug', v_channel.slug,
      'external_order_ref', v_ledger.external_order_ref,
      'ingested_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ),
    jsonb_build_object('boundary', 'commerce_create_channel_order')
  )
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;

  UPDATE public.channel_order_ingests
     SET order_id = v_order_id,
         status = 'order_created',
         updated_at = now()
   WHERE id = v_ledger.id;

  v_response := jsonb_build_object(
    'contractVersion', 'channels.ingest.v0',
    'channelOrder', jsonb_build_object(
      'orderId', v_order_id, 'orderRef', v_order_number, 'replayed', false
    )
  );

  UPDATE public.commerce_idempotency_keys
     SET status = 'completed', response_payload = v_response,
         metadata = metadata || jsonb_build_object('orderId', v_order_id)
   WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

  RETURN v_response;
END;
$$;

-- Save then execute P3 in one transaction: no-effect failure rolls back the command; committed receipts remain original.
-- CD-M17-2/4/5 compatibility seam: the M06 ATP/allocator/public entry stay unchanged.
-- All component provider rows are held before releasing this obligation's own exposure.
-- The counter advance is visible to the one ATP hook before its clamp; any failure
-- rolls it back together with every physical hold and the immutable receipt.
CREATE OR REPLACE FUNCTION public.inventory_channel_exposure_quantity(p_sku_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(sum((l.exposure_issued_units-l.exposure_converted_units-l.exposure_withdrawn_units)::numeric*c.quantity),0)::bigint
  FROM public.sales_channel_listings l JOIN public.catalog_bundle_components c ON c.bundle_id=l.sellable_bundle_id
  WHERE c.catalog_sku_id=p_sku_id
$$;
REVOKE ALL ON FUNCTION public.inventory_channel_exposure_quantity(uuid) FROM PUBLIC,anon,authenticated,openlup_mcp_reader;
GRANT EXECUTE ON FUNCTION public.inventory_channel_exposure_quantity(uuid) TO service_role;

CREATE FUNCTION public.channel_purchase_stock_enter(p_order_id uuid,p_items jsonb,p_provider_kind text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 300
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x WHERE NOT public.channel_control_keys(x,to_jsonb(ARRAY['orderItemId','skuId','quantity']))
      OR jsonb_typeof(x->'quantity') IS DISTINCT FROM 'number' OR (x->>'quantity')::numeric NOT BETWEEN 1 AND 2147483647
      OR (x->>'quantity')::numeric<>trunc((x->>'quantity')::numeric))
    OR (SELECT count(DISTINCT x->>'orderItemId') FROM jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x LEFT JOIN public.commerce_order_items i ON i.id=(x->>'orderItemId')::uuid
      WHERE i.id IS NULL OR i.order_id IS DISTINCT FROM p_order_id OR i.sku_id IS DISTINCT FROM (x->>'skuId')::uuid
        OR i.quantity::numeric IS DISTINCT FROM (x->>'quantity')::numeric) THEN
    RAISE EXCEPTION 'channel_purchase_stock_vector_invalid' USING ERRCODE='22023'; END IF;
  -- Provider first matches M06's existing lock order. No subscription/cycle locks.
  PERFORM 1 FROM public.fulfillment_provider_stock_current stock WHERE stock.provider_kind=p_provider_kind
    AND stock.catalog_sku_id IN(SELECT (x->>'skuId')::uuid FROM jsonb_array_elements(p_items) x)
    ORDER BY stock.catalog_sku_id,stock.sku FOR UPDATE;
  PERFORM 1 FROM public.inventory_balances b WHERE b.sku_id IN(SELECT (x->>'skuId')::uuid FROM jsonb_array_elements(p_items) x)
    ORDER BY b.sku_id,b.location_id,b.id FOR UPDATE;
END; $$;
REVOKE ALL ON FUNCTION public.channel_purchase_stock_enter(uuid,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader;

CREATE FUNCTION public.channel_reserve_order_items(p_idempotency_key text,p_order_id uuid,p_items jsonb,p_metadata jsonb,p_provider_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.commerce_orders%ROWTYPE; result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'channel_control_actor_required' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id;
  IF o.id IS NULL OR o.source_channel_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.channel_order_ingests i
    WHERE i.order_id=o.id AND i.channel_id=o.source_channel_id AND i.external_order_ref=o.source_order_ref)
    OR (SELECT count(*) FROM public.commerce_order_items WHERE order_id=o.id) IS DISTINCT FROM jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'channel_purchase_order_required' USING ERRCODE='22023'; END IF;
  PERFORM public.channel_purchase_stock_enter(p_order_id,p_items,p_provider_kind);
  result:=public.inventory_reserve_order_items(p_idempotency_key,p_order_id,NULL,p_items,
    'channel_order_window','succeeded',NULL,p_metadata,p_provider_kind);
  -- External paid debt has no TTL; M06's legacy null default stays untouched.
  UPDATE public.inventory_reservations SET expires_at=NULL,updated_at=now()
    WHERE order_id=p_order_id AND left(idempotency_key,length(p_idempotency_key)+1)=p_idempotency_key||':'
      AND kind='channel_order_window' AND status='reserved';
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.channel_reserve_order_items(text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,openlup_mcp_reader;
GRANT EXECUTE ON FUNCTION public.channel_reserve_order_items(text,uuid,jsonb,jsonb,text) TO service_role;

CREATE FUNCTION public.channel_purchase_paid_source(p_listing_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.sales_channel_listings%ROWTYPE; i public.channel_order_ingests%ROWTYPE; o public.commerce_orders%ROWTYPE;
  line jsonb; line_count integer; items jsonb; b public.catalog_bundles%ROWTYPE; first_issue jsonb; sets numeric;
BEGIN
  SELECT * INTO l FROM public.sales_channel_listings WHERE id=p_listing_id;
  SELECT result->'effect' INTO first_issue FROM public.sales_channel_control_operations WHERE resource_id=l.id AND resource_kind='listing'
    AND operation='exposure_allocate' AND result#>>'{before,generation}'='0';
  SELECT * INTO i FROM public.channel_order_ingests WHERE id=(p_payload->>'ingestId')::uuid FOR UPDATE;
  SELECT * INTO o FROM public.commerce_orders WHERE id=(p_payload->>'orderId')::uuid FOR UPDATE;
  SELECT * INTO b FROM public.catalog_bundles WHERE id=l.sellable_bundle_id;
  sets:=(p_payload->>'purchasedSets')::numeric;
  SELECT count(*) INTO line_count FROM jsonb_array_elements(i.normalized->'lines') x WHERE x->>'externalLineRef'=p_payload->>'externalLineRef';
  SELECT x INTO line FROM jsonb_array_elements(i.normalized->'lines') x WHERE x->>'externalLineRef'=p_payload->>'externalLineRef';
  IF first_issue IS NULL OR l.exposure_issued_basis_ref IS NULL OR i.id IS NULL OR o.id IS NULL OR i.order_id IS DISTINCT FROM o.id
    OR i.channel_id IS DISTINCT FROM l.channel_id OR o.source_channel_id IS DISTINCT FROM l.channel_id OR o.source_order_ref IS DISTINCT FROM i.external_order_ref
    OR i.normalized->>'contractVersion' IS DISTINCT FROM 'channel.order.v1' OR i.normalized->>'externalOrderRef' IS DISTINCT FROM i.external_order_ref
    OR i.normalized->>'providerEventId' IS DISTINCT FROM i.provider_event_id OR NOT public.channel_control_ref(i.normalized->>'payloadDigest')
    OR i.normalized#>>'{payment,state}' IS DISTINCT FROM 'paid_externally' OR NOT public.channel_control_ref(i.normalized#>>'{payment,externalPaymentRef}')
    OR NULLIF(i.normalized#>>'{payment,paidAt}','') IS NULL OR (i.normalized#>>'{payment,paidAt}') !~ '^\d{4}-\d{2}-\d{2}T'
    OR i.status IN('quarantined','failed') OR line_count<>1 OR line#>>'{sellable,kind}' IS DISTINCT FROM 'bundle'
    OR line#>>'{sellable,externalOfferRef}' IS DISTINCT FROM l.external_offer_ref
    OR (line#>'{sellable,bundleCode}'<>'null'::jsonb AND line#>>'{sellable,bundleCode}' IS DISTINCT FROM b.code)
    OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'number' OR (line->>'quantity')::numeric IS DISTINCT FROM sets
    OR p_payload->>'issuedBasisRef' IS DISTINCT FROM l.exposure_issued_basis_ref::text
    OR p_payload->'scope' IS DISTINCT FROM ((first_issue->'scope')-ARRAY['connectionVersion','registryVersion','listingControlVersion'])
    OR p_payload->'scope' IS DISTINCT FROM jsonb_build_object('connectionId',i.purchase_capture_text::jsonb#>'{scope,connectionId}',
      'channelId',i.purchase_capture_text::jsonb#>'{scope,channelId}','connectorProviderKind',i.purchase_capture_text::jsonb#>'{scope,connectorKind}',
      'connectorShape','direct','applicationRef',i.purchase_capture_text::jsonb#>'{namespace,applicationRef}',
      'environmentRef',i.purchase_capture_text::jsonb#>'{scope,environmentRef}','sellerRef',i.purchase_capture_text::jsonb#>'{scope,sellerRef}',
      'channelExternalRef',i.purchase_capture_text::jsonb#>'{namespace,channelExternalRef}','externalOfferRef',l.external_offer_ref)
    OR first_issue->>'bundleDigest' IS DISTINCT FROM b.composition_digest OR b.composition_digest IS DISTINCT FROM public.catalog_bundle_composition_digest(b.id)
    OR sets<1 OR sets>l.exposure_issued_units-l.exposure_converted_units-l.exposure_withdrawn_units THEN
    RAISE EXCEPTION 'channel_exposure_paid_source_conflict' USING ERRCODE='P0001';
  END IF;
  PERFORM (i.normalized#>>'{payment,paidAt}')::timestamptz;
  PERFORM 1 FROM public.commerce_order_items item WHERE item.order_id=o.id AND item.product_snapshot->>'externalLineRef'=p_payload->>'externalLineRef'
    ORDER BY item.sku_id,item.id FOR UPDATE;
  SELECT jsonb_agg(jsonb_build_object('orderItemId',item.id,'skuId',item.sku_id,'quantity',item.quantity) ORDER BY item.sku_id,item.id)
    INTO items FROM public.commerce_order_items item WHERE item.order_id=o.id AND item.product_snapshot->>'externalLineRef'=p_payload->>'externalLineRef';
  IF items IS NULL OR jsonb_array_length(items)>300 OR EXISTS(
    SELECT 1 FROM public.commerce_order_items item WHERE item.order_id=o.id AND item.product_snapshot->>'externalLineRef'=p_payload->>'externalLineRef'
      AND (item.product_snapshot->>'externalOfferRef' IS DISTINCT FROM l.external_offer_ref OR item.product_snapshot->>'bundleCode' IS DISTINCT FROM b.code
        OR (item.product_snapshot->>'bundleQty')::numeric IS DISTINCT FROM sets))
    OR EXISTS(SELECT 1 FROM (SELECT * FROM public.catalog_bundle_components WHERE bundle_id=b.id) c FULL JOIN (
      SELECT (x->>'skuId')::uuid sku_id,sum((x->>'quantity')::numeric) quantity FROM jsonb_array_elements(items) x GROUP BY x->>'skuId') actual
      ON actual.sku_id=c.catalog_sku_id WHERE (c.bundle_id=b.id OR c.bundle_id IS NULL) AND (actual.sku_id IS NULL OR c.catalog_sku_id IS NULL
        OR actual.quantity IS DISTINCT FROM c.quantity::numeric*sets OR actual.quantity>2147483647))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) x WHERE NOT EXISTS(SELECT 1 FROM public.catalog_bundle_components c
      WHERE c.bundle_id=b.id AND c.catalog_sku_id=(x->>'skuId')::uuid)) THEN
    RAISE EXCEPTION 'channel_exposure_physical_items_conflict' USING ERRCODE='P0001';
  END IF;
  RETURN jsonb_build_object('items',items,'externalOrderRef',i.external_order_ref,
    'providerKind',nullif(lower(btrim(o.metadata#>>'{selectedDelivery,providerKind}')),''),
    'paidSourceDigest',encode(sha256(convert_to(jsonb_build_array(i.id,i.normalized,o.id,items)::text,'UTF8')),'hex'));
END; $$;
REVOKE ALL ON FUNCTION public.channel_purchase_paid_source(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader;

CREATE FUNCTION public.channel_exposure_apply(p_listing_id uuid,p_operation text,p_operation_id uuid,p_actor_id uuid,
 p_expected_generation bigint,p_input_digest text,p_canonical_text text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cmd jsonb; payload jsonb; l public.sales_channel_listings%ROWTYPE; receipt public.sales_channel_control_operations%ROWTYPE;
  source jsonb; item jsonb; reserve jsonb; reservations jsonb:='[]'; hold record; units numeric; before_image jsonb; after_image jsonb; effect jsonb;
BEGIN
  IF current_user<>'openlup_channel_purchase_writer' THEN RAISE EXCEPTION 'channel_purchase_closed_writer_required' USING ERRCODE='42501'; END IF;
  IF p_canonical_text IS NULL OR octet_length(p_canonical_text) NOT BETWEEN 2 AND 262144 OR p_input_digest IS NULL
    OR encode(sha256(convert_to(p_canonical_text,'UTF8')),'hex') IS DISTINCT FROM p_input_digest OR p_operation IS DISTINCT FROM 'exposure_convert_sale'
    OR p_listing_id IS NULL OR p_operation_id IS NULL OR p_expected_generation IS NULL OR p_expected_generation NOT BETWEEN 0 AND 9007199254740990 THEN
    RAISE EXCEPTION 'channel_exposure_input_invalid' USING ERRCODE='22023'; END IF;
  cmd:=p_canonical_text::jsonb; payload:=cmd->'payload';
  IF public.channel_purchase_json(cmd) IS DISTINCT FROM p_canonical_text
    OR NOT public.channel_control_keys(cmd,to_jsonb(ARRAY['schemaVersion','operation','resourceKind','resourceId','operationId','expectedGeneration','payload']))
    OR cmd->>'schemaVersion' IS DISTINCT FROM 'channel.exposure.v1' OR cmd->>'operation' IS DISTINCT FROM p_operation
    OR cmd->>'resourceKind' IS DISTINCT FROM 'listing' OR cmd->>'resourceId' IS DISTINCT FROM p_listing_id::text OR cmd->>'operationId' IS DISTINCT FROM p_operation_id::text
    OR jsonb_typeof(cmd->'expectedGeneration') IS DISTINCT FROM 'number' OR (cmd->>'expectedGeneration')::numeric IS DISTINCT FROM p_expected_generation::numeric
    OR NOT public.channel_control_keys(payload,to_jsonb(ARRAY['scope','issuedBasisRef','ingestId','externalLineRef','orderId','purchasedSets']))
    OR jsonb_typeof(payload->'purchasedSets') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'channel_exposure_input_invalid' USING ERRCODE='22023'; END IF;
  units:=(payload->>'purchasedSets')::numeric;
  IF units IS NULL OR units<>trunc(units) OR units NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION 'channel_exposure_quantity_invalid' USING ERRCODE='22023'; END IF;
  PERFORM public.channel_control_actor(p_actor_id,false);
  SELECT * INTO l FROM public.sales_channel_listings WHERE id=p_listing_id FOR UPDATE;
  SELECT * INTO receipt FROM public.sales_channel_control_operations WHERE resource_kind='listing' AND resource_id=p_listing_id
    AND operation=p_operation AND operation_id=p_operation_id;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM p_actor_id OR receipt.input_digest IS DISTINCT FROM p_input_digest OR receipt.canonical_text IS DISTINCT FROM p_canonical_text THEN
      RAISE EXCEPTION 'channel_exposure_input_conflict' USING ERRCODE='P0001'; END IF;
    RETURN receipt.result;
  END IF;
  IF l.id IS NULL OR l.exposure_generation<>p_expected_generation THEN RAISE EXCEPTION 'channel_exposure_generation_conflict' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM public.sales_channel_control_operations old WHERE old.resource_id=l.id AND old.operation='exposure_convert_sale'
    AND old.canonical_text::jsonb#>>'{payload,ingestId}'=payload->>'ingestId' AND old.canonical_text::jsonb#>>'{payload,externalLineRef}'=payload->>'externalLineRef') THEN
    RAISE EXCEPTION 'channel_exposure_source_consumed' USING ERRCODE='P0001'; END IF;
  source:=public.channel_purchase_paid_source(l.id,payload);
  PERFORM public.channel_purchase_stock_enter((payload->>'orderId')::uuid,source->'items',source->>'providerKind');
  before_image:=jsonb_build_object('issued',l.exposure_issued_units,'converted',l.exposure_converted_units,'withdrawn',l.exposure_withdrawn_units,'generation',l.exposure_generation);
  after_image:=before_image||jsonb_build_object('converted',l.exposure_converted_units+units,'generation',l.exposure_generation+1);
  UPDATE public.sales_channel_listings SET exposure_converted_units=l.exposure_converted_units+units,exposure_generation=l.exposure_generation+1,
    updated_at=clock_timestamp() WHERE id=l.id;
  FOR item IN SELECT x FROM jsonb_array_elements(source->'items') x ORDER BY x->>'skuId',x->>'orderItemId' LOOP
    reserve:=public.inventory_reserve_order('ch:'||l.channel_id::text||':ord:'||(source->>'externalOrderRef')||':inventory:'||(item->>'orderItemId'),
      (payload->>'orderId')::uuid,(item->>'orderItemId')::uuid,NULL,(item->>'skuId')::uuid,(item->>'quantity')::integer,
      'channel_order_window','succeeded',NULL,jsonb_build_object('source','channels.ingest.v0'),source->>'providerKind');
    IF reserve->>'replayed'='true' THEN RAISE EXCEPTION 'channel_exposure_reservation_replayed_without_receipt' USING ERRCODE='P0001'; END IF;
    FOR hold IN SELECT * FROM public.inventory_reservations WHERE idempotency_key='ch:'||l.channel_id::text||':ord:'||(source->>'externalOrderRef')||':inventory:'||(item->>'orderItemId')
      AND sku_id=(item->>'skuId')::uuid ORDER BY id LOOP
      UPDATE public.inventory_reservations SET expires_at=NULL,updated_at=now() WHERE id=hold.id;
      reservations:=reservations||jsonb_build_array(jsonb_build_object('reservationId',hold.id,'orderItemId',hold.order_item_id,'skuId',hold.sku_id,'quantity',hold.quantity));
    END LOOP;
  END LOOP;
  effect:=jsonb_build_object('operation',p_operation,'issuedBasisRef',l.exposure_issued_basis_ref,'ingestId',payload->'ingestId',
    'externalLineRef',payload->'externalLineRef','orderId',payload->'orderId','purchasedSets',units,'paidSourceDigest',source->>'paidSourceDigest','physicalReservations',reservations);
  reserve:=jsonb_build_object('operationId',p_operation_id,'inputDigest',p_input_digest,'appliedGeneration',l.exposure_generation+1,
    'before',before_image,'after',after_image,'outstandingUnits',l.exposure_issued_units-l.exposure_converted_units-l.exposure_withdrawn_units-units,'effect',effect);
  IF octet_length(reserve::text)>262144 THEN RAISE EXCEPTION 'channel_exposure_result_too_large' USING ERRCODE='22023'; END IF;
  INSERT INTO public.sales_channel_control_operations(resource_kind,resource_id,operation,operation_id,actor_id,input_digest,canonical_text,result)
    VALUES('listing',l.id,p_operation,p_operation_id,p_actor_id,p_input_digest,p_canonical_text,reserve);
  RETURN reserve;
END; $$;
REVOKE ALL ON FUNCTION public.channel_exposure_apply(uuid,text,uuid,uuid,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader;

CREATE FUNCTION public.channel_purchase_conversion_command(p_ledger_id uuid,p_external_line_ref text,p_actor_id uuid,
  p_job_run_id uuid,p_command_text text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i public.channel_order_ingests%ROWTYPE; claim public.outbox_events%ROWTYPE; body jsonb; cmd jsonb;
  l public.sales_channel_listings%ROWTYPE; expected_scope jsonb;
BEGIN
  PERFORM public.channel_control_actor(p_actor_id,false);
  SELECT * INTO i FROM public.channel_order_ingests WHERE id=p_ledger_id FOR UPDATE;
  IF i.purchase_capture_text IS NULL OR i.order_id IS NULL THEN RAISE EXCEPTION 'channel_purchase_order_required' USING ERRCODE='22023'; END IF;
  body:=i.purchase_capture_text::jsonb;
  PERFORM public.channel_purchase_scope(body,p_actor_id,(body#>>'{execution,jobRunId}')::uuid,false);
  SELECT * INTO claim FROM public.outbox_events WHERE aggregate_id=(body#>>'{scope,connectionId}')::uuid
    AND event_type='channel.purchase-line.v1' AND payload->>'externalLineRef'=p_external_line_ref FOR UPDATE;
  IF claim.id IS NULL OR claim.payload->>'captureRef' IS DISTINCT FROM body->>'captureId' THEN
    RAISE EXCEPTION 'channel_purchase_original_line_required' USING ERRCODE='22023'; END IF;
  IF claim.metadata ? 'conversionCommand' THEN RETURN claim.metadata->>'conversionCommand'; END IF;
  IF p_command_text IS NULL THEN RETURN NULL; END IF;
  IF p_job_run_id IS NULL THEN RAISE EXCEPTION 'channel_purchase_job_not_live' USING ERRCODE='P0001'; END IF;
  -- Fresh effects bind the current live job without replacing accepted versions or original execution bytes.
  PERFORM public.channel_purchase_scope(body,p_actor_id,(body#>>'{execution,jobRunId}')::uuid,false,p_job_run_id);
  cmd:=p_command_text::jsonb;
  SELECT * INTO l FROM public.sales_channel_listings WHERE id=(cmd->>'resourceId')::uuid AND channel_id=i.channel_id;
  expected_scope:=jsonb_build_object('connectionId',body#>'{scope,connectionId}','channelId',body#>'{scope,channelId}',
    'connectorProviderKind',body#>'{scope,connectorKind}','connectorShape','direct','applicationRef',body#>'{namespace,applicationRef}',
    'environmentRef',body#>'{scope,environmentRef}','sellerRef',body#>'{scope,sellerRef}',
    'channelExternalRef',body#>'{namespace,channelExternalRef}','externalOfferRef',claim.payload->'externalOfferRef');
  IF octet_length(p_command_text)>262144 OR public.channel_purchase_json(cmd) IS DISTINCT FROM p_command_text
    OR NOT public.channel_control_keys(cmd,to_jsonb(ARRAY['schemaVersion','resourceKind','resourceId','operationId','expectedGeneration','operation','payload']))
    OR cmd->>'schemaVersion' IS DISTINCT FROM 'channel.exposure.v1' OR cmd->>'resourceKind' IS DISTINCT FROM 'listing'
    OR cmd->>'operation' IS DISTINCT FROM 'exposure_convert_sale' OR cmd->'resourceId' IS DISTINCT FROM to_jsonb(l.id)
    OR jsonb_typeof(cmd->'operationId') IS DISTINCT FROM 'string' OR cmd->>'operationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR cmd->'expectedGeneration' IS DISTINCT FROM to_jsonb(l.exposure_generation)
    OR cmd->'payload' IS DISTINCT FROM jsonb_build_object('scope',expected_scope,'issuedBasisRef',l.exposure_issued_basis_ref,
      'ingestId',i.id,'externalLineRef',p_external_line_ref,'orderId',i.order_id,'purchasedSets',claim.payload->'purchasedSets')
    OR l.external_offer_ref IS DISTINCT FROM claim.payload->>'externalOfferRef' OR l.exposure_issued_basis_ref IS NULL THEN
    RAISE EXCEPTION 'channel_purchase_conversion_command_invalid' USING ERRCODE='22023'; END IF;
  UPDATE public.outbox_events SET metadata=metadata||jsonb_build_object('conversionCommand',p_command_text) WHERE id=claim.id;
  PERFORM public.channel_exposure_apply(l.id,'exposure_convert_sale',(cmd->>'operationId')::uuid,p_actor_id,
    (cmd->>'expectedGeneration')::bigint,encode(sha256(convert_to(p_command_text,'UTF8')),'hex'),p_command_text);
  RETURN p_command_text;
END; $$;
GRANT SELECT,UPDATE ON public.sales_channel_listings TO openlup_channel_purchase_writer;
GRANT SELECT,INSERT ON public.sales_channel_control_operations TO openlup_channel_purchase_writer;
GRANT SELECT ON public.sales_channels,public.catalog_bundles,public.catalog_bundle_components,public.catalog_skus,
 public.commerce_orders,public.commerce_order_items,public.fulfillment_provider_stock_current,public.inventory_balances TO openlup_channel_purchase_writer;
GRANT UPDATE ON public.commerce_orders,public.commerce_order_items,public.fulfillment_provider_stock_current,public.inventory_balances TO openlup_channel_purchase_writer;
GRANT SELECT,UPDATE ON public.inventory_reservations TO openlup_channel_purchase_writer;
GRANT EXECUTE ON FUNCTION public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text),
 public.catalog_bundle_composition_digest(uuid) TO openlup_channel_purchase_writer;
CREATE POLICY channel_purchase_writer_control ON public.sales_channel_control_operations FOR ALL TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
GRANT EXECUTE ON FUNCTION public.channel_exposure_apply(uuid,text,uuid,uuid,bigint,text,text) TO openlup_channel_purchase_writer;
CREATE POLICY channel_purchase_writer_listing ON public.sales_channel_listings FOR SELECT TO openlup_channel_purchase_writer USING(true);
-- Exact private read/lock/expiry/exposure closure; table grants and closed-role membership stay unchanged.
CREATE POLICY channel_purchase_writer_select ON public.commerce_orders FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_select ON public.commerce_order_items FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_select ON public.fulfillment_provider_stock_current FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_select ON public.inventory_balances FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_select ON public.inventory_reservations FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_select ON public.catalog_bundles FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_select ON public.catalog_bundle_components FOR SELECT TO openlup_channel_purchase_writer USING(true);
CREATE POLICY channel_purchase_writer_update ON public.commerce_orders FOR UPDATE TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_update ON public.commerce_order_items FOR UPDATE TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_update ON public.fulfillment_provider_stock_current FOR UPDATE TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_update ON public.inventory_balances FOR UPDATE TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_update ON public.inventory_reservations FOR UPDATE TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_update ON public.sales_channel_listings FOR UPDATE TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);

-- Literal browser revokes precede ownership; the installer still finalizes identical closed ACLs before every transfer.
REVOKE ALL ON FUNCTION public.channel_ingest_capture_read(uuid,text,uuid) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_pull_page_read(uuid,uuid,uuid,text) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_purchase_json(jsonb) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_purchase_packet(text,text,text) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_purchase_retained_lines(uuid,jsonb) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid) FROM anon,authenticated;

-- The closed capability has no runtime membership; only PG17 bootstrap ADMIN-only installer administration survives.
GRANT SELECT,INSERT,UPDATE ON public.channel_order_ingests,public.outbox_events,public.sales_channel_connections TO openlup_channel_purchase_writer;
GRANT EXECUTE ON FUNCTION public.channel_control_actor(uuid,boolean),public.channel_control_keys(jsonb,jsonb),public.channel_control_ref(text),
  public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb) TO openlup_channel_purchase_writer;
DO $$ DECLARE fn record; installer name:=current_user; super_install boolean; had_create boolean; BEGIN
  SELECT rolsuper INTO super_install FROM pg_roles WHERE rolname=installer;
  had_create:=has_schema_privilege('openlup_channel_purchase_writer','public','CREATE');
  IF NOT super_install THEN
    EXECUTE format('GRANT openlup_channel_purchase_writer TO %I WITH ADMIN FALSE, SET TRUE, INHERIT FALSE GRANTED BY %I',installer,installer);
    IF NOT had_create THEN GRANT CREATE ON SCHEMA public TO openlup_channel_purchase_writer; END IF;
    IF NOT has_schema_privilege('openlup_channel_purchase_writer','public','CREATE') THEN
      RAISE EXCEPTION 'channel_purchase_schema_grant_authority_required' USING ERRCODE='42501'; END IF;
  END IF;
  FOR fn IN SELECT p.oid::regprocedure signature,p.proname,p.pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'channel_purchase_%' OR p.proname IN ('channel_ingest_capture_read',
      'channel_pull_page_record','channel_pull_page_read','channel_pull_progress_commit') OR
      (p.proname='channel_ingest_record_inbound_event' AND p.pronargs=7)) ORDER BY p.oid LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader',fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO openlup_channel_purchase_writer',fn.signature);
    IF fn.proname IN ('channel_purchase_conversion_command','channel_ingest_capture_read','channel_pull_page_record','channel_pull_page_read','channel_pull_progress_commit')
      OR (fn.proname='channel_ingest_record_inbound_event' AND fn.pronargs=7) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
      EXECUTE format('ALTER FUNCTION %s OWNER TO openlup_channel_purchase_writer',fn.signature);
    END IF;
  END LOOP;
  EXECUTE format('SET LOCAL ROLE %I',installer);
  IF NOT super_install THEN
    IF NOT had_create THEN REVOKE CREATE ON SCHEMA public FROM openlup_channel_purchase_writer; END IF;
    EXECUTE format('REVOKE openlup_channel_purchase_writer FROM %I GRANTED BY %I',installer,installer);
  END IF;
END; $$;

CREATE POLICY channel_purchase_writer_ingest ON public.channel_order_ingests FOR ALL TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_outbox ON public.outbox_events FOR ALL TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);
CREATE POLICY channel_purchase_writer_connection ON public.sales_channel_connections FOR ALL TO openlup_channel_purchase_writer USING(true) WITH CHECK(true);


-- Protected immutable evidence is dormant; no active no-op handler or provider ACK is registered.
INSERT INTO public.outbox_dormant_event_types(event_type,owner,reason) VALUES
  ('channel.purchase-source.v1','channels/captured-source','Immutable accepted channel purchase capture is retained evidence, not a dispatcher command or provider ACK.'),
  ('channel.purchase-line.v1','channels/captured-source','Immutable scoped purchased-line claims preserve one paid obligation across provider form aliases; no dispatcher effect is registered.'),
  ('channel.pull-page.v1','channels/captured-source','Immutable captured provider pages and original cursor receipts remain evidence; page presence never proves journal completeness.')
ON CONFLICT(event_type) DO NOTHING;
