-- Portable P4: neutral immutable capture and scoped page progress on its actual existing ledger/outbox host.
-- This forward adds no provider request, queue, order/stock effect, clock or business actor.
-- Closed functions retain the trusted migration owner; invoker guards deny runtime raw source fabrication.
-- Legacy pre-adoption cursor writes and five-argument ingress remain unchanged.
-- Private scope owns exact live-job SHARE locks; only the sealed owner receives the reference validator.
-- Explicit canonical text is hashed as UTF8; jsonb::text is never used as its substitute.
-- Composite page pointer installs NOT VALID and is validated in the paired next forward.

-- Portable owner seam: the selected installation's already-trusted migration owner
-- owns these closed functions. Runtime has only the six entry EXECUTEs; helpers
-- and raw source writes remain denied. No role or selected principal is added.
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
        -- Match the existing normalized buyer/address/shipping scalar contract before copying it.
        part:=body#>'{normalized,buyer}';
        IF jsonb_typeof(part->'emailIsMasked') IS DISTINCT FROM 'boolean'
          OR (part->'externalCustomerRef'<>'null'::jsonb AND (jsonb_typeof(part->'externalCustomerRef') IS DISTINCT FROM 'string'
            OR char_length(part->>'externalCustomerRef')+char_length(regexp_replace(part->>'externalCustomerRef',U&'[^\+010000-\+10FFFF]','','g')) NOT BETWEEN 1 AND 128
            OR part->>'externalCustomerRef'<>btrim(part->>'externalCustomerRef',U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))) THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        FOREACH key IN ARRAY ARRAY['email','firstName','lastName','phone','taxId','companyName'] LOOP
          atom:=part->key;
          ceiling:=CASE key WHEN 'email' THEN 320 WHEN 'firstName' THEN 120 WHEN 'lastName' THEN 120
            WHEN 'phone' THEN 40 WHEN 'taxId' THEN 32 ELSE 200 END;
          IF atom='null'::jsonb THEN CONTINUE; END IF;
          -- Zod counts UTF-16 code units; supplementary characters occupy two units.
          IF jsonb_typeof(atom) IS DISTINCT FROM 'string'
            OR char_length(atom#>>'{}')+char_length(regexp_replace(atom#>>'{}',U&'[^\+010000-\+10FFFF]','','g'))>ceiling
            OR atom#>>'{}'<>btrim(atom#>>'{}',U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        END LOOP;
        part:=body#>'{normalized,shipTo}';
        IF jsonb_typeof(part->'countryCode') IS DISTINCT FROM 'string' OR part->>'countryCode' !~ '^[A-Z]{2}$' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        FOREACH key IN ARRAY ARRAY['recipientName','line1','line2','postalCode','city','phone','pickupPointRef'] LOOP
          atom:=part->key;
          IF atom='null'::jsonb AND key IN ('line2','phone','pickupPointRef') THEN CONTINUE; END IF;
          ceiling:=CASE key WHEN 'postalCode' THEN 20 WHEN 'city' THEN 120 WHEN 'phone' THEN 40
            WHEN 'pickupPointRef' THEN 120 ELSE 200 END;
          IF jsonb_typeof(atom) IS DISTINCT FROM 'string'
            OR char_length(atom#>>'{}')+char_length(regexp_replace(atom#>>'{}',U&'[^\+010000-\+10FFFF]','','g'))>ceiling
            OR (key IN ('recipientName','line1','postalCode','city') AND char_length(atom#>>'{}')=0)
            OR atom#>>'{}'<>btrim(atom#>>'{}',U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        END LOOP;
        part:=body#>'{normalized,shipping}';
        FOREACH key IN ARRAY ARRAY['grossMinor','discountMinor'] LOOP
          atom:=part->key;
          IF jsonb_typeof(atom) IS DISTINCT FROM 'number' OR NOT coalesce(atom::text ~ '^[0-9]+$' AND atom::numeric<=9007199254740991,false) THEN
            RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        END LOOP;
        IF part->'grossMinor' IS DISTINCT FROM body#>'{normalized,totals,shippingGrossMinor}'
          OR part->'discountMinor' IS DISTINCT FROM body#>'{normalized,totals,shippingDiscountMinor}' THEN
          RAISE EXCEPTION 'channel_purchase_nested_shape' USING ERRCODE='22023'; END IF;
        FOREACH key IN ARRAY ARRAY['methodLabel','carrierHint'] LOOP
          atom:=part->key; ceiling:=CASE key WHEN 'methodLabel' THEN 120 ELSE 64 END;
          IF atom='null'::jsonb THEN CONTINUE; END IF;
          IF jsonb_typeof(atom) IS DISTINCT FROM 'string'
            OR char_length(atom#>>'{}')+char_length(regexp_replace(atom#>>'{}',U&'[^\+010000-\+10FFFF]','','g'))>ceiling
            OR atom#>>'{}'<>btrim(atom#>>'{}',U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') THEN
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
    OR (p_fresh AND p_body ? 'normalized' AND p_body#>>'{normalized,channelSlug}' IS DISTINCT FROM s.slug)
    OR (p_body#>>'{execution,jobRunId}')::uuid IS DISTINCT FROM p_job THEN
    RAISE EXCEPTION 'channel_purchase_scope_conflict' USING ERRCODE='P0001'; END IF;
  -- Existing installer-definer owns job read/row-lock authority; the closed writer gets no job-table grant.
  IF p_fresh OR p_live_job IS NOT NULL THEN
    PERFORM 1 FROM public.platform_job_runs r JOIN public.platform_job_controls j ON j.job_name=r.job_name
      WHERE r.id=coalesce(p_live_job,p_job) AND r.job_name='channel-order-pull' AND r.status='running' AND j.enabled
        AND r.driver=j.active_driver AND j.lease_token=r.id AND r.lease_until>clock_timestamp()
        AND j.lease_owner IS NOT DISTINCT FROM r.driver AND j.lease_until>clock_timestamp()
      FOR SHARE OF r,j;
    IF NOT FOUND THEN RAISE EXCEPTION 'channel_purchase_job_not_live' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN c.id;
END; $$;
CREATE FUNCTION public.channel_purchase_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE receipt jsonb; body jsonb; controlled boolean; sealed_owner name;

BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO sealed_owner FROM pg_proc p
    WHERE p.oid='public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text)'::regprocedure;
  IF TG_OP='TRUNCATE' THEN
    IF TG_TABLE_NAME='outbox_events' AND NOT EXISTS(SELECT 1 FROM public.outbox_events
      WHERE event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1')) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'channel_purchase_truncate_forbidden' USING ERRCODE='P0001';
  END IF;
  IF TG_TABLE_NAME='outbox_events' THEN
    controlled:=coalesce(NEW.event_type,OLD.event_type) IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1')
      OR (TG_OP='UPDATE' AND OLD.event_type IN ('channel.purchase-source.v1','channel.purchase-line.v1','channel.pull-page.v1'));
    IF TG_OP='UPDATE' AND OLD.event_type='channel.purchase-line.v1' AND current_user=sealed_owner
      AND NOT OLD.metadata ? 'conversionCommand' AND jsonb_typeof(NEW.metadata->'conversionCommand')='string'
      AND NEW.metadata=OLD.metadata||jsonb_build_object('conversionCommand',NEW.metadata->'conversionCommand')
      AND (to_jsonb(NEW)-'metadata')=(to_jsonb(OLD)-'metadata') THEN RETURN NEW; END IF;
    IF controlled THEN
      -- Ordinary invoker writes never initialize private helper expressions.
      IF TG_OP<>'INSERT' OR current_user IS DISTINCT FROM sealed_owner THEN
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
      IF current_user IS DISTINCT FROM sealed_owner THEN RAISE EXCEPTION 'channel_purchase_raw_capture_denied' USING ERRCODE='42501'; END IF;
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
      IF current_user IS DISTINCT FROM sealed_owner OR NEW.pull_capture_adopted_at IS NULL OR
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
DECLARE body jsonb; c uuid; original public.outbox_events%ROWTYPE; event jsonb; watermark text;
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
    watermark:=body#>>'{expected,watermark}';
    -- The public schema reduces at Date.parse millisecond precision, retaining the
    -- original timestamp string on ties. Truncate text before PostgreSQL parses
    -- it, so sub-millisecond rounding cannot choose a different event.
    FOR event IN SELECT value FROM jsonb_array_elements(body->'events') LOOP
      IF watermark IS NULL OR regexp_replace(event->>'occurredAt','(\.[0-9]{1,3})[0-9]*','\1')::timestamptz>
        regexp_replace(watermark,'(\.[0-9]{1,3})[0-9]*','\1')::timestamptz THEN
        watermark:=event->>'occurredAt';
      END IF;
    END LOOP;
    IF body#>'{request,from}' IS DISTINCT FROM body#>'{expected,cursor}' OR (body#>>'{request,limit}')::int NOT BETWEEN 1 AND 1000
      OR jsonb_array_length(body->'events')>(body#>>'{request,limit}')::int OR body#>>'{next,cursor}' IS DISTINCT FROM
      coalesce(body#>>ARRAY['events',(jsonb_array_length(body->'events')-1)::text,'providerEventId'],body#>>'{expected,cursor}')
      OR body#>>'{next,watermark}' IS DISTINCT FROM watermark
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
      AND event->>'externalOrderRef'=p_external_order_ref AND event->>'externalOrderRevision' IS NOT DISTINCT FROM p_external_order_revision
      AND event->>'rawSourceDigest'=body->>'rawSourceDigest') THEN
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

-- Portable physical conversion remains explicitly unavailable; no hosted inventory authority is invented.
CREATE FUNCTION public.channel_purchase_conversion_command(p_ledger_id uuid,p_external_line_ref text,p_actor_id uuid,
  p_job_run_id uuid,p_command_text text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
  PERFORM public.channel_control_actor(p_actor_id,false);
  RAISE EXCEPTION 'channel_purchase_physical_unavailable' USING ERRCODE='P0001';
END; $$;

-- Existing migration owner retains ownership; runtime gets only these scoped entries.
REVOKE ALL ON FUNCTION public.channel_purchase_json(jsonb),public.channel_purchase_packet(text,text,text),
 public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid),public.channel_purchase_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.channel_purchase_json(jsonb),public.channel_purchase_packet(text,text,text),
 public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid),public.channel_purchase_guard() FROM anon;';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.channel_purchase_json(jsonb),public.channel_purchase_packet(text,text,text),
 public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid),public.channel_purchase_guard() FROM authenticated;';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.channel_purchase_json(jsonb),public.channel_purchase_packet(text,text,text),
 public.channel_purchase_scope(jsonb,uuid,uuid,boolean,uuid),public.channel_purchase_guard() FROM service_role;';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text),
 public.channel_ingest_capture_read(uuid,text,uuid),public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text),
 public.channel_pull_page_read(uuid,uuid,uuid,text),public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz),
 public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text),
 public.channel_ingest_capture_read(uuid,text,uuid),public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text),
 public.channel_pull_page_read(uuid,uuid,uuid,text),public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz),
 public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text) FROM anon;';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text),
 public.channel_ingest_capture_read(uuid,text,uuid),public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text),
 public.channel_pull_page_read(uuid,uuid,uuid,text),public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz),
 public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text) FROM authenticated;';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.channel_ingest_record_inbound_event(uuid,text,text,text,jsonb,text,text),
 public.channel_ingest_capture_read(uuid,text,uuid),public.channel_pull_page_record(uuid,uuid,uuid,uuid,text,text),
 public.channel_pull_page_read(uuid,uuid,uuid,text),public.channel_pull_progress_commit(uuid,uuid,uuid,uuid,text,timestamptz,bigint,text,timestamptz),
 public.channel_purchase_conversion_command(uuid,text,uuid,uuid,text) TO service_role;';
  END IF;
END; $$;
