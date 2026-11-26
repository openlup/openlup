-- Stage 5 Wave 4A: validate and read installed policy for subscription
-- reschedule time zone (E9) with UTC default.

CREATE FUNCTION public.subscription_reschedule_timezone_validate(p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_time_zone text;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'subscription_reschedule_timezone_policy_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_policy ?& ARRAY['revision', 'timeZone'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('revision', 'timeZone'))
    OR jsonb_typeof(p_policy->'revision') IS DISTINCT FROM 'string'
    OR btrim(p_policy->>'revision', E' \t\n\r\f\u000b\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') = ''
    OR jsonb_typeof(p_policy->'timeZone') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'subscription_reschedule_timezone_policy_invalid' USING ERRCODE = '22023';
  END IF;
  v_time_zone := p_policy->>'timeZone';
  IF v_time_zone = ''
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_time_zone) THEN
    RAISE EXCEPTION 'subscription_reschedule_timezone_policy_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('revision', p_policy->>'revision', 'timeZone', v_time_zone);
END;
$$;

CREATE FUNCTION public.subscription_reschedule_timezone_read()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw_policy text;
BEGIN
  SELECT value_text INTO v_raw_policy
  FROM public.commerce_settings
  WHERE key = 'subscription_reschedule_timezone';
  IF NOT FOUND THEN RETURN 'UTC'; END IF;
  BEGIN
    RETURN public.subscription_reschedule_timezone_validate(v_raw_policy::jsonb)->>'timeZone';
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'subscription_reschedule_timezone_policy_invalid' USING ERRCODE = '22023';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_apply_lifecycle_action(
  p_client_id uuid,
  p_idempotency_key text,
  p_subscription_id uuid,
  p_action text,
  p_payload jsonb,
  p_requested_at timestamptz,
  p_terms jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_reason text := NULLIF(v_payload->>'reason', '');
  v_preset text := COALESCE(NULLIF(v_payload->>'pausePreset', ''), 'indefinite');
  v_outcome text;
  v_event_id uuid;
  v_target timestamptz;
  v_ends_at timestamptz;
  v_reschedule_tz text;
  term_key text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN
    ('pause', 'resume', 'skip_next_cycle', 'slide_next_cycle', 'cancel')
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_unsupported_action' USING ERRCODE = '22023';
  END IF;

  -- Long enough that a caller cannot reach it by accident: an idempotency key short enough
  -- to collide is worse than no key, because it silently suppresses a real second request.
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  IF p_client_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.clients client WHERE client.id = p_client_id)
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = p_subscription_id
     AND client_id = p_client_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_lifecycle_forbidden' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.subscription_events
   WHERE subscription_id = p_subscription_id
     AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    v_outcome := 'replayed';
    v_event_id := v_existing.id;
  ELSE
  IF p_terms IS NULL OR jsonb_typeof(p_terms) IS DISTINCT FROM 'object'
    OR p_terms - ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays'] <> '{}'::jsonb
    OR NOT (p_terms ?& ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays']) THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR term_key IN SELECT jsonb_object_keys(p_terms) LOOP
    IF jsonb_typeof(p_terms->term_key) IS DISTINCT FROM 'number'
      OR NOT coalesce(p_terms->>term_key ~ '^[1-9][0-9]*$',false)
      OR (p_terms->>term_key)::numeric > 2147483647 THEN
      RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_terms->>'slideMinDays')::integer > (p_terms->>'slideMaxDays')::integer THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  IF p_action = 'pause' THEN
    IF v_subscription.status <> 'active'
      OR v_preset NOT IN ('2_weeks', '1_month', 'indefinite')
    THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    v_ends_at := CASE v_preset
      WHEN '2_weeks' THEN p_requested_at + make_interval(days=>(p_terms->>'pauseDays')::integer)
      WHEN '1_month' THEN p_requested_at + make_interval(months=>(p_terms->>'pauseMonths')::integer)
      ELSE NULL
    END;
    UPDATE public.subscriptions
       SET status = 'paused', updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
    INSERT INTO public.subscription_pause_windows
      (subscription_id, pause_preset, starts_at, ends_at, reason, idempotency_key)
    VALUES (p_subscription_id, v_preset, p_requested_at, v_ends_at, v_reason, p_idempotency_key);
  ELSIF p_action = 'resume' THEN
    IF v_subscription.status <> 'paused' THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=p_subscription_id AND status='open') THEN
      PERFORM public.subscription_terminalize_unpaid_artifacts(p_subscription_id,p_requested_at,'subscription_resumed','skipped');
    END IF;
    -- A subscription paused across one or more due dates resumes onto the next date the
    -- cadence would have produced, not onto a date in the past and not onto "today plus a
    -- cadence" -- whole cadences forward keeps every later date on the original grid.
    v_target := v_subscription.next_cycle_at;
    IF v_target IS NOT NULL AND v_target <= p_requested_at THEN
      v_target := v_target + ((
        floor(
          extract(epoch FROM (p_requested_at - v_target)) / (v_subscription.cadence_days * 86400.0)
        )::bigint + 1
      ) * v_subscription.cadence_days || ' days')::interval;
    END IF;
    UPDATE public.subscriptions
       SET status = 'active', next_cycle_at = v_target, updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
    UPDATE public.subscription_pause_windows
       SET resumed_at = p_requested_at, updated_at = p_requested_at
     WHERE subscription_id = p_subscription_id
       AND resumed_at IS NULL;
  ELSIF p_action = 'cancel' THEN
    IF v_subscription.status NOT IN ('active', 'paused') THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    UPDATE public.subscriptions
       SET status = 'cancelled',
           ended_at = COALESCE(ended_at, p_requested_at),
           cancellation_reason = COALESCE(NULLIF(v_payload #>> '{survey,reasonCode}', ''), v_reason),
           updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
  ELSIF p_action = 'skip_next_cycle' THEN
    IF v_subscription.status <> 'active' OR v_subscription.next_cycle_at IS NULL THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_skip' USING ERRCODE = '22023';
    END IF;
    IF p_requested_at > v_subscription.next_cycle_at-make_interval(hours=>v_subscription.edit_window_hours) THEN
      RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
    END IF;
    PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
      p_subscription_id, v_subscription.next_cycle_at
    );
    UPDATE public.subscriptions
       SET next_cycle_at =
             v_subscription.next_cycle_at + (v_subscription.cadence_days || ' days')::interval,
           updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
  ELSE
    v_reschedule_tz := public.subscription_reschedule_timezone_read();
    v_target := NULLIF(v_payload->>'newNextCycleAt', '')::timestamptz;
    IF v_subscription.status = 'active'
      AND v_subscription.next_cycle_at IS NOT NULL
      AND v_target IS NOT NULL
      AND (v_target AT TIME ZONE v_reschedule_tz)::date
          = (v_subscription.next_cycle_at AT TIME ZONE v_reschedule_tz)::date
    THEN
      v_outcome := 'noop';
    ELSE
      -- Near enough and the cycle is already being prepared; far enough and the customer is
      -- not rescheduling a delivery, they are abandoning it -- that is what pause is for.
      IF v_subscription.status <> 'active'
        OR v_target IS NULL
        OR v_target < p_requested_at + make_interval(days=>(p_terms->>'slideMinDays')::integer)
        OR v_target > p_requested_at + make_interval(days=>(p_terms->>'slideMaxDays')::integer)
      THEN
        RAISE EXCEPTION 'subscription_lifecycle_invalid_slide' USING ERRCODE = '22023';
      END IF;
      IF p_requested_at > v_subscription.next_cycle_at-make_interval(hours=>v_subscription.edit_window_hours) THEN
        RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
      END IF;
      PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
        p_subscription_id, v_subscription.next_cycle_at
      );
      UPDATE public.subscriptions
         SET next_cycle_at = v_target, updated_at = p_requested_at
       WHERE id = p_subscription_id
       RETURNING * INTO v_subscription;
    END IF;
  END IF;

  END IF;

  IF v_outcome IS NULL THEN
    INSERT INTO public.subscription_events
      (subscription_id, event_type, idempotency_key, payload, occurred_at)
    VALUES (
      p_subscription_id,
      'subscription.customer_self_service.' || p_action,
      p_idempotency_key,
      jsonb_build_object('action', p_action, 'payload', v_payload, 'reason', v_reason),
      p_requested_at
    )
    RETURNING id INTO v_event_id;
    UPDATE public.subscription_pause_windows
       SET event_id = v_event_id, updated_at = p_requested_at
     WHERE subscription_id = p_subscription_id
       AND idempotency_key = p_idempotency_key;
    v_outcome := 'applied';
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'platform.subscription.lifecycle.v1',
    'subscriptionAction', jsonb_build_object(
      'subscriptionId', p_subscription_id,
      'action', p_action,
      'status', v_outcome,
      'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at,
      'eventId', v_event_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_command_preview(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text;
 core jsonb; addons jsonb; requested jsonb; lines jsonb; cadence integer; version integer;
 total bigint; current_total bigint; quote_key text; quote_hash text; answer jsonb; reason text;
 v_noop boolean:=false; core_matches boolean; addon_matches boolean;
 v_expires_at timestamptz;
 v_reschedule_tz text;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_payload ? 'acceptedQuoteHash' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload-'acceptedQuoteHash');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 -- Serialize the actor/key even when competing commands target different rows.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key;
 IF FOUND THEN
  IF jsonb_set(r.command,'{payload}',(r.command->'payload')-'acceptedQuoteHash')<>command THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  RETURN r.result;
 END IF;
 <<preview_command>>
 BEGIN
  IF p_action='slide_next_cycle' THEN
   v_reschedule_tz:=public.subscription_reschedule_timezone_read();
   BEGIN
    v_noop:=s.status='active' AND s.next_cycle_at IS NOT NULL
     AND (NULLIF(p_payload->>'newNextCycleAt','')::timestamptz AT TIME ZONE v_reschedule_tz)::date
      =(s.next_cycle_at AT TIME ZONE v_reschedule_tz)::date;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
   END;
   IF v_noop IS NOT TRUE THEN
    RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
   END IF;
  ELSE
  IF p_action NOT IN ('update_bundle','resize_bundle','update_package_template','update_plan_length',
    'add_addon','remove_addon','update_addon_quantity') THEN
   RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
  END IF;
  IF s.status<>'active' THEN RAISE EXCEPTION 'subscription_command_not_active' USING ERRCODE='22023'; END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  IF s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
   RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
  END IF;
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  version:=(p_payload->>'expectedTemplateVersion')::integer;
  IF version IS NULL OR version<>s.template_version THEN
   RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
  END IF;
  cadence:=CASE WHEN p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length')
   THEN COALESCE((p_payload->>'cadenceDays')::integer,(p_payload->>'planDays')::integer,s.cadence_days) ELSE s.cadence_days END;
  IF cadence NOT BETWEEN 1 AND 3660 OR s.price_list_id IS NULL OR s.currency_code IS NULL THEN
   RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('variantId',variant_id,'qty',quantity) ORDER BY sort_order,id)
   FILTER(WHERE NOT is_addon),'[]'),COALESCE(jsonb_agg(jsonb_build_object('variantId',variant_id,'qty',quantity)
   ORDER BY sort_order,id) FILTER(WHERE is_addon),'[]'),COALESCE(sum(quantity*unit_price_minor),0)
   INTO core,addons,current_total FROM public.subscription_lines WHERE subscription_id=s.id;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template') THEN
   IF p_payload->'compositionConstraint' IS NULL OR jsonb_typeof(p_payload->'compositionConstraint')<>'object'
    OR (p_payload->'compositionConstraint') ?| ARRAY['version','data'] THEN
    RAISE EXCEPTION 'subscription_command_invalid_composition_constraint' USING ERRCODE='22023';
   END IF;
  END IF;
  -- Compare donor line sets by UUID and summed quantity, independently of order/prices.
  SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
   INTO core_matches,addon_matches FROM (
    SELECT is_addon,jsonb_typeof(wanted)='array' AND
     (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
       SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wanted)='array' THEN wanted ELSE '[]' END) v
       WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$'
       GROUP BY (v->>'variantId')::uuid) desired)
     =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
       SELECT variant_id,sum(quantity) qty FROM public.subscription_lines
       WHERE subscription_id=s.id AND is_addon=inputs.is_addon GROUP BY variant_id) stored)
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(wanted)='array' THEN wanted ELSE '[]' END) v
       WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') matches
    FROM (VALUES(false,p_payload->'coreLines'),(true,COALESCE(p_payload->'addonLines','[]'))) inputs(is_addon,wanted)
   ) line_sets;
  IF p_action IN ('add_addon','update_addon_quantity') THEN
   v_noop:=EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id
    AND variant_id=NULLIF(p_payload->>'variantId','')::uuid AND is_addon
    AND quantity=CASE WHEN p_action='add_addon' THEN GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))
     ELSE (p_payload->>'qty')::integer END);
  ELSIF p_action='update_bundle' THEN
   v_noop:=core_matches AND cadence=s.cadence_days AND (NOT p_payload ? 'addonLines' OR addon_matches);
  ELSIF p_action='resize_bundle' THEN
   v_noop:=core_matches AND cadence=s.cadence_days;
  ELSIF p_action='update_plan_length' THEN
   v_noop:=cadence=s.cadence_days AND core_matches;
  ELSIF p_action='update_package_template' THEN
   v_noop:=cadence=s.cadence_days AND core_matches AND addon_matches;
  END IF;
  END IF;
  IF v_noop THEN
   answer:=jsonb_build_object('status','noop','subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
    'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',NULL);
   EXIT preview_command;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template') THEN
   core:=p_payload->'coreLines';
   IF p_action='update_package_template' OR (p_action='update_bundle' AND p_payload ? 'addonLines') THEN
    addons:=COALESCE(p_payload->'addonLines','[]');
   END IF;
   IF p_action='update_bundle' AND cadence=s.cadence_days AND
    (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<>
    (SELECT COALESCE(sum(quantity),0) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
    RAISE EXCEPTION 'subscription_command_bundle_total_mismatch' USING ERRCODE='22023';
   END IF;
  ELSIF p_action='update_plan_length' THEN
   core:=COALESCE(p_payload->'coreLines',core);
  ELSIF p_action='add_addon' THEN
   addons:=addons||jsonb_build_array(jsonb_build_object('variantId',p_payload->>'variantId','qty',GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))));
  ELSIF p_action IN ('remove_addon','update_addon_quantity') THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(addons) v WHERE v->>'variantId'=lower(p_payload->>'variantId')) THEN
    RAISE EXCEPTION 'subscription_command_addon_not_found' USING ERRCODE='22023';
   END IF;
   SELECT COALESCE(jsonb_agg(CASE WHEN v->>'variantId'=lower(p_payload->>'variantId') THEN
    jsonb_set(v,'{qty}',p_payload->'qty') ELSE v END),'[]') INTO addons
    FROM jsonb_array_elements(addons) v WHERE p_action<>'remove_addon' OR v->>'variantId'<>lower(p_payload->>'variantId');
  END IF;
  IF core IS NULL OR jsonb_typeof(core)<>'array' OR jsonb_array_length(core) NOT BETWEEN 1 AND 6
   OR addons IS NULL OR jsonb_typeof(addons)<>'array' OR jsonb_array_length(addons)>12 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023';
  END IF;
  requested:=core||addons;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(requested) v WHERE jsonb_typeof(v)<>'object'
    OR COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR COALESCE(v->>'qty','') !~ '^[0-9]{1,2}$' OR (v->>'qty')::integer NOT BETWEEN 1 AND 99)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(requested) v GROUP BY lower(v->>'variantId') HAVING count(*)>1) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023';
  END IF;
  -- Same catalogue price selection as the existing customer bundle preview.
  SELECT jsonb_agg(jsonb_build_object('variantId',sku.id,'quantity',(v->>'qty')::integer,
    'isAddon',ord>jsonb_array_length(core),'sortOrder',ord-1,'unitPriceMinor',price.unit_price_minor,'currency',s.currency_code)
    ORDER BY ord),sum(price.unit_price_minor*(v->>'qty')::integer)
   INTO lines,total FROM jsonb_array_elements(requested) WITH ORDINALITY x(v,ord)
   JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid AND sku.status='active' AND sku.sellable_in_subscription
   LEFT JOIN LATERAL (SELECT unit_price_minor FROM public.price_entries pe WHERE pe.variant_id=sku.id
    AND pe.price_list_id=s.price_list_id AND pe.mode IN ('subscription','any') AND pe.active
    AND pe.min_qty<=(v->>'qty')::integer AND pe.valid_from<=p_now AND (pe.valid_to IS NULL OR pe.valid_to>p_now)
    ORDER BY CASE pe.mode WHEN 'subscription' THEN 0 ELSE 1 END,pe.min_qty DESC,pe.valid_from DESC,pe.id LIMIT 1) price ON true;
  IF lines IS NULL OR jsonb_array_length(lines)<>jsonb_array_length(requested)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) v WHERE v->'unitPriceMinor'='null') THEN
   RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE='22023';
  END IF;
  quote_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  v_expires_at:=p_now+make_interval(mins=>public.subscription_edit_quote_ttl_minutes_read());
  quote_hash:=encode(sha256(convert_to(quote_key||':'||fingerprint||':'||lines::text||':'||v_expires_at::text,'UTF8')),'hex');
  INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,
   expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
   VALUES(s.id,quote_key,fingerprint,quote_hash,version,lines,cadence,current_total,total,s.currency_code,v_expires_at) RETURNING * INTO q;
  answer:=jsonb_build_object('status','previewed','canApply',true,'quoteHash',q.quote_hash,'quoteExpiresAt',q.expires_at,
   'templateVersion',version,'lines',lines,'currentTotalMinor',current_total,'newTotalMinor',total,
   'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only'));
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  IF SQLSTATE = '22023' AND reason IN (
   'subscription_edit_quote_ttl_minutes_policy_invalid',
   'subscription_reschedule_timezone_policy_invalid'
  ) THEN
   RAISE;
  END IF;
  answer:=jsonb_build_object('status','refused','canApply',false,'reason',reason);
 END;
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,q.quote_hash,answer,answer->>'status');
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_command_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz,p_terms jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
<<apply_command>>
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text; quote_fingerprint text; answer jsonb;
 reason text; event_id uuid; event_key text; line jsonb; target timestamptz; outcome text:='applied'; term_key text;
 v_acceptance jsonb; v_basket jsonb;
 v_reschedule_tz text;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 quote_fingerprint:=encode(sha256(convert_to(jsonb_set(command,'{payload}',p_payload-'acceptedQuoteHash')::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.command_fingerprint<>(CASE WHEN r.status='previewed' THEN quote_fingerprint ELSE fingerprint END)
   OR r.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  IF r.status<>'previewed' THEN
   IF r.status='refused' THEN RETURN r.result; END IF;
   RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status);
  END IF;
 END IF;
 event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
 BEGIN
  IF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel','order_now','reactivate') THEN
  IF p_terms IS NULL OR jsonb_typeof(p_terms) IS DISTINCT FROM 'object'
    OR p_terms - ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays'] <> '{}'::jsonb
    OR NOT (p_terms ?& ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays']) THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR term_key IN SELECT jsonb_object_keys(p_terms) LOOP
    IF jsonb_typeof(p_terms->term_key) IS DISTINCT FROM 'number'
      OR NOT coalesce(p_terms->>term_key ~ '^[1-9][0-9]*$',false)
      OR (p_terms->>term_key)::numeric > 2147483647 THEN
      RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_terms->>'slideMinDays')::integer > (p_terms->>'slideMaxDays')::integer THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  END IF;
  IF p_action='pause' THEN
   PERFORM public.subscription_pause_close_recovery(p_client_id,event_key,s.id,p_now);
  END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  -- Take the same subscription lock as claim first, then the future
  -- terms and every line. A previously deferred operation keeps its snapshot.
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  IF p_action='slide_next_cycle' THEN
   v_reschedule_tz:=public.subscription_reschedule_timezone_read();
  END IF;
  -- Existing preparation owns the operation before it inserts a cycle. Do
  -- not wait in the reverse lock order: refuse a busy operation, or a live
  -- pre-payment lease whose worker could still prepare after this command.
  IF p_action IN ('cancel','resume','skip_next_cycle','slide_next_cycle','order_now','reactivate')
   AND NOT (p_action='slide_next_cycle'
     AND ((p_payload->>'newNextCycleAt')::timestamptz AT TIME ZONE v_reschedule_tz)::date
       =(s.next_cycle_at AT TIME ZONE v_reschedule_tz)::date) THEN
   BEGIN
    PERFORM 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
   EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'subscription_command_operation_busy' USING ERRCODE='22023';
   END;
   IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
     AND (state='attempt_prepared' OR (state IN ('claimed','reserved') AND lease_expires_at>p_now))) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length','add_addon','remove_addon','update_addon_quantity') THEN
   IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   SELECT * INTO q FROM public.subscription_edit_quotes WHERE subscription_id=s.id AND idempotency_key=event_key FOR UPDATE;
   IF NOT FOUND OR q.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023';
   END IF;
   IF q.request_fingerprint<>quote_fingerprint OR s.template_version<>q.expected_template_version THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
   END IF;
   IF q.status<>'previewed' OR q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
   IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=q.currency_code) THEN
    RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023';
   END IF;
   IF (SELECT jsonb_agg(jsonb_build_object('lineOrdinal',(v->>'sortOrder')::integer+1,'sku',sku.sku,
      'quantity',(v->>'quantity')::integer,'unitAmountMinor',(v->>'unitPriceMinor')::bigint) ORDER BY (v->>'sortOrder')::integer)
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid)
     =(SELECT jsonb_agg(jsonb_build_object('lineOrdinal',line_ordinal,'sku',sku,'quantity',quantity,'unitAmountMinor',unit_amount_minor)
       ORDER BY line_ordinal) FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id)
    AND s.cadence_days=q.proposed_cadence_days AND q.proposed_lines=(SELECT COALESCE(jsonb_agg(jsonb_build_object(
     'variantId',variant_id,'quantity',quantity,'isAddon',is_addon,'sortOrder',sort_order,'unitPriceMinor',unit_price_minor,'currency',currency_code)
     ORDER BY sort_order,id),'[]') FROM public.subscription_lines WHERE subscription_id=s.id) THEN
    outcome:='noop';
   ELSE
    v_acceptance:=p_payload->'catalogAcceptance';
    IF v_acceptance IS NOT NULL THEN
     PERFORM public.catalog_acceptance_assert_v2(v_acceptance);
     SELECT jsonb_object_agg(k.sku,(v->>'quantity')::integer) INTO v_basket
     FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus k ON k.id=(v->>'variantId')::uuid;
     IF NOT public.catalog_acceptance_roster_valid_v2(v_acceptance,v_basket) THEN
      RAISE EXCEPTION 'catalog_acceptance_line_mismatch' USING ERRCODE='22023',
       HINT='Preview the current template and apply its quote with the matching SKU revisions.';
     END IF;
    END IF;
    DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
    FOR line IN SELECT value FROM jsonb_array_elements(q.proposed_lines) LOOP
     INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code,catalog_sku_revision_id)
      VALUES(s.id,(line->>'variantId')::uuid,(line->>'quantity')::integer,(line->>'sortOrder')::integer,
       (line->>'isAddon')::boolean,(line->>'unitPriceMinor')::bigint,q.currency_code,
       (SELECT (ref->>'skuRevisionId')::uuid FROM jsonb_array_elements(v_acceptance->'lines') ref
        WHERE (ref->>'skuId')::uuid=(line->>'variantId')::uuid));
    END LOOP;
    DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
    INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
     SELECT s.id,(v->>'sortOrder')::integer+1,sku.sku,(v->>'quantity')::integer,(v->>'unitPriceMinor')::bigint
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid;
    UPDATE public.subscription_renewal_terms SET updated_at=p_now,catalog_acceptance=v_acceptance WHERE subscription_id=s.id;
    UPDATE public.subscriptions SET cadence_days=q.proposed_cadence_days,template_version=template_version+1,updated_at=p_now
     WHERE id=s.id RETURNING * INTO s;
   END IF;
  ELSIF p_action IN ('order_now','reactivate') THEN
   IF p_payload->'confirmedChargeTiming' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'subscription_command_charge_timing_not_confirmed' USING ERRCODE='22023';
   END IF;
   IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   IF (p_action='order_now' AND (s.status<>'active' OR s.next_cycle_at IS NULL))
    OR (p_action='reactivate' AND s.status<>'cancelled') THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF p_action='order_now' AND p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   target:=p_now+CASE p_action WHEN 'order_now' THEN make_interval(mins=>(p_terms->>'orderNowDelayMinutes')::integer)
    ELSE make_interval(days=>(p_terms->>'reactivateDelayDays')::integer) END;
   UPDATE public.subscriptions SET status='active',next_cycle_at=target,ended_at=NULL,cancellation_reason=NULL,
    template_version=template_version+CASE WHEN p_action='reactivate' THEN 1 ELSE 0 END,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  ELSIF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel') THEN
   IF p_action='cancel' THEN
    IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
      AND attempt_prepared_at IS NOT NULL AND state NOT IN ('succeeded','refused'))
     OR EXISTS(SELECT 1 FROM public.subscription_retry_obligations WHERE subscription_id=s.id AND state='prepared') THEN
     RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
    END IF;
    UPDATE public.subscription_dunning_notifications SET status='skipped',recovery_url_path=NULL,
     error='subscription_cancelled',updated_at=p_now WHERE status='queued' AND case_id IN
      (SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open');
    UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=p_now WHERE revoked_at IS NULL AND order_id IN
      (SELECT orders.id FROM public.commerce_orders orders JOIN public.subscription_dunning_cases cases
        ON cases.cycle_id=orders.subscription_cycle_id WHERE cases.subscription_id=s.id AND cases.status='open');
    UPDATE public.subscription_dunning_cases SET status='cancelled',next_retry_at=NULL,updated_at=p_now
     WHERE subscription_id=s.id AND status='open';
   END IF;
   IF p_action IN ('skip_next_cycle','slide_next_cycle') AND NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id)
    THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(
     SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') END) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   -- Do not move away from a current payment obligation on resume.
   IF p_action='resume' AND s.status='paused' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_resumed','skipped');
   END IF;
   IF p_action='resume' THEN PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at); END IF;
   IF p_action='cancel' THEN
    -- Operation locks above fence every worker; only elapsed, never-prepared
    -- obligations may be cancelled here. Paid/ambiguous commitments stay owned.
    UPDATE public.fulfillment_inventory_reservations stock_hold SET status='released',expires_at=NULL,
     terminal_reason='subscription_cancelled',updated_at=p_now
     FROM public.subscription_renewal_operations op WHERE op.subscription_id=s.id
      AND stock_hold.renewal_operation_id=op.id AND stock_hold.status='held'
      AND op.state IN ('claimed','reserved') AND op.attempt_prepared_at IS NULL
      AND op.external_attempt_ref IS NULL;
    UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',
     terminal_reason='subscription_cancelled',terminal_at=p_now,updated_at=p_now
     WHERE subscription_id=s.id AND state IN ('claimed','reserved') AND attempt_prepared_at IS NULL
      AND external_attempt_ref IS NULL;
   END IF;
   answer:=public.subscription_apply_lifecycle_action(p_client_id,event_key,s.id,p_action,p_payload,p_now,p_terms);
   IF p_action='cancel' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_cancelled','cancelled');
   END IF;
   outcome:=answer#>>'{subscriptionAction,status}';
   event_id:=(answer#>>'{subscriptionAction,eventId}')::uuid;
   SELECT * INTO s FROM public.subscriptions WHERE id=s.id;
  ELSE
   RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023';
  END IF;
  IF answer IS NULL AND outcome='applied' THEN
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at,catalog_acceptance,catalog_basket)
    VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'payload',p_payload,
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now,v_acceptance,v_basket)
    RETURNING id INTO event_id;
  END IF;
  IF q.id IS NOT NULL AND outcome='applied' THEN
   UPDATE public.subscription_edit_quotes SET status='accepted',accepted_event_id=event_id,accepted_at=p_now WHERE id=q.id;
  END IF;
  answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
   'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  IF SQLSTATE = '22023' AND reason = 'subscription_reschedule_timezone_policy_invalid' THEN
   RAISE;
  END IF;
  answer:=jsonb_build_object('status','refused','reason',reason);
 END;
 IF r.id IS NULL THEN
  INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
   VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload->>'acceptedQuoteHash',answer,answer->>'status');
 ELSE
  UPDATE public.subscription_command_receipts SET command_fingerprint=fingerprint,command=apply_command.command,result=answer,status=answer->>'status'
   WHERE id=r.id;
 END IF;
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_support_apply_subscription_action_v1(
  p_operator_id uuid,
  p_subscription_id uuid,
  p_action text,
  p_payload jsonb,
  p_expected_version integer,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_subject public.clients%ROWTYPE;
  v_owner public.subscription_command_receipts%ROWTYPE;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_now timestamptz := COALESCE(p_now, now());
  v_fingerprint text;
  v_owner_key text;
  v_slide_min_days integer := 3;
  v_slide_max_days integer;
  v_slide_target timestamptz;
  v_reschedule_tz text;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_delegate jsonb;
  v_reason text;
  v_pause_enabled boolean := true;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF EXISTS (SELECT 1 FROM public.platform_control_operators WHERE principal_id = p_operator_id)
     OR NOT public.platform_human_membership_is_administrator(p_operator_id) THEN
    RAISE EXCEPTION 'customer_support_command_requires_human' USING ERRCODE = '42501';
  END IF;
  IF p_subscription_id IS NULL
     OR COALESCE(p_action, '') NOT IN ('pause', 'resume', 'slide_next_cycle', 'change_shipping_address')
     OR jsonb_typeof(v_payload) <> 'object'
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR NOT isfinite(v_now) THEN
    RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_payload ? 'slideMinDays' THEN
    IF COALESCE(v_payload->>'slideMinDays', '') !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
    END IF;
    v_slide_min_days := (v_payload->>'slideMinDays')::integer;
    IF v_slide_min_days < 1 OR v_slide_min_days > 365 THEN
      RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_fingerprint := encode(sha256(convert_to(
    'subscription_action|' || p_action || '|' || p_subscription_id::text || '|'
    || p_expected_version::text || '|' || v_payload::text, 'utf8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('customer-support-subscription:' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM public.customer_support_subscription_commands
    WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_subscription_id
       OR v_existing.command_kind <> 'subscription_action' THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;
  v_slide_max_days := public.account_support_operator_slide_max_days_read();
  IF v_payload ? 'slideMinDays' THEN
    IF (v_slide_max_days <= 99 AND COALESCE(v_payload->>'slideMinDays', '') !~ '^[0-9]{1,2}$')
       OR v_slide_min_days > v_slide_max_days THEN
      RAISE EXCEPTION 'customer_support_subscription_command_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- A namespaced digest maps the entire support key, including spaces, without
  -- truncating its 200-character domain into the owner's 180-character domain.
  v_owner_key := 'm12-support:' || encode(sha256(convert_to(p_idempotency_key, 'utf8')), 'hex');
  -- Match the owner's actor/key-before-subscription lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operator_id::text || ':' || v_owner_key, 0));
  SELECT * INTO v_subscription FROM public.subscriptions
    WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'subscription_not_found';
  ELSE
    SELECT * INTO v_subject FROM public.clients
      WHERE id = v_subscription.client_id FOR SHARE;
    IF NOT FOUND THEN
      v_refusal_code := 'subject_not_found';
    ELSIF v_subject.principal_id IS NULL THEN
      v_refusal_code := 'subject_account_unlinked';
    END IF;
  END IF;
  IF v_refusal_code IS NULL AND v_subscription.template_version <> p_expected_version THEN
    v_refusal_code := 'version_conflict';
  END IF;
  -- No address engine is installed here; the typed native port normally refuses
  -- before SQL. Direct trusted SQL callers receive the same capability refusal.
  IF v_refusal_code IS NULL AND p_action = 'change_shipping_address' THEN
    v_refusal_code := 'operator_subscription_authority_unavailable';
  END IF;
  IF v_refusal_code IS NULL AND p_action = 'slide_next_cycle' THEN
    v_reschedule_tz := public.subscription_reschedule_timezone_read();
    BEGIN
      v_slide_target := NULLIF(v_payload->>'newNextCycleAt', '')::timestamptz;
    EXCEPTION WHEN others THEN
      v_slide_target := NULL;
    END;
    IF v_slide_target IS NULL THEN
      v_refusal_code := 'slide_target_invalid';
    ELSIF v_subscription.status <> 'active' OR v_subscription.next_cycle_at IS NULL THEN
      v_refusal_code := 'slide_not_available';
    ELSIF v_slide_target < v_now + make_interval(days => v_slide_min_days)
       OR v_slide_target > v_now + make_interval(days => v_slide_max_days) THEN
      v_refusal_code := 'slide_out_of_window';
    ELSIF (v_slide_target AT TIME ZONE v_reschedule_tz)::date = (v_subscription.next_cycle_at AT TIME ZONE v_reschedule_tz)::date THEN
      v_outcome := 'noop';
    ELSIF v_slide_target < v_now + interval '3 days' THEN
      v_refusal_code := 'operator_subscription_authority_unavailable';
    END IF;
  END IF;
  -- Admission to an existing owner capability, never terminalization in M12.
  -- Open dunning is delegated so its existing payment_blocked refusal survives.
  IF v_refusal_code IS NULL AND p_action = 'resume' AND v_subscription.status = 'paused'
     AND NOT EXISTS (SELECT 1 FROM public.subscription_dunning_cases
       WHERE subscription_id = p_subscription_id AND status = 'open')
     AND ((SELECT status FROM public.subscription_dunning_cases
       WHERE subscription_id = p_subscription_id ORDER BY opened_at DESC, id DESC LIMIT 1) = 'expired'
       OR EXISTS (SELECT 1 FROM public.subscription_cycles WHERE subscription_id = p_subscription_id
         AND status = 'payment_pending')) THEN
    v_refusal_code := 'operator_subscription_authority_unavailable';
  END IF;
  IF v_refusal_code IS NULL AND p_action = 'pause' THEN
    IF NOT v_pause_enabled THEN
      v_refusal_code := 'operator_subscription_authority_unavailable';
    ELSIF EXISTS (SELECT 1 FROM public.subscription_renewal_operations
      WHERE subscription_id = p_subscription_id AND state = 'attempt_prepared') THEN
      -- The existing owner pause dispatch does not supply the donor attempt fence.
      v_refusal_code := 'operator_subscription_authority_unavailable';
    END IF;
  END IF;
  IF v_refusal_code IS NULL AND v_outcome IS DISTINCT FROM 'noop' THEN
    v_delegate := public.subscription_command_apply(
      p_operator_id, v_subject.id, v_owner_key, p_subscription_id, p_action,
      (v_payload - 'slideMinDays') || jsonb_build_object('actorKind', 'operator', 'operatorId', p_operator_id),
      v_now,
      jsonb_build_object(
        'pauseDays', 14,
        'pauseMonths', 1,
        'slideMinDays', v_slide_min_days,
        'slideMaxDays', v_slide_max_days,
        'orderNowDelayMinutes', 5,
        'reactivateDelayDays', 2
      ));
    SELECT * INTO v_owner FROM public.subscription_command_receipts
      WHERE actor_id = p_operator_id AND idempotency_key = v_owner_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_support_owner_receipt_invalid' USING ERRCODE = '55000';
    END IF;
    IF v_delegate->>'status' = 'refused' THEN
      v_reason := v_delegate->>'reason';
      v_refusal_code := CASE v_reason
        WHEN 'subscription_command_payment_blocked' THEN 'payment_blocked'
        WHEN 'subscription_command_operation_busy' THEN 'payment_blocked'
        WHEN 'subscription_lifecycle_payment_blocked' THEN 'payment_blocked'
        WHEN 'subscription_lifecycle_invalid_transition' THEN 'invalid_transition'
        WHEN 'subscription_lifecycle_invalid_slide' THEN 'slide_out_of_window'
        WHEN 'subscription_command_idempotency_conflict' THEN 'idempotency_conflict'
        ELSE NULL END;
      IF v_refusal_code = 'idempotency_conflict' THEN
        RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
      END IF;
      IF v_refusal_code IS NULL THEN
        RAISE EXCEPTION 'customer_support_owner_receipt_invalid' USING ERRCODE = '55000';
      END IF;
    ELSIF v_delegate->>'status' IS NULL OR v_delegate->>'status' NOT IN ('applied', 'noop', 'replayed') THEN
      RAISE EXCEPTION 'customer_support_owner_receipt_invalid' USING ERRCODE = '55000';
    ELSE
      v_outcome := v_delegate->>'status';
      v_response := jsonb_build_object('outcome', v_outcome, 'action', p_action,
        'subscriptionId', p_subscription_id, 'subscriptionStatus', v_delegate->'subscriptionStatus',
        'nextCycleAt', v_delegate->'nextCycleAt', 'templateVersion', v_delegate->'templateVersion',
        'eventId', v_delegate->'eventId', 'appliedBy', NULL);
    END IF;
  END IF;
  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE WHEN v_refusal_code = 'version_conflict' THEN 'conflict' ELSE 'refused' END;
    v_response := jsonb_build_object('outcome', v_outcome, 'action', p_action,
      'subscriptionId', p_subscription_id, 'refusalCode', v_refusal_code);
  ELSIF v_outcome = 'noop' AND v_response IS NULL THEN
    v_response := jsonb_build_object('outcome', 'noop', 'action', p_action,
      'subscriptionId', p_subscription_id, 'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at, 'templateVersion', v_subscription.template_version);
  END IF;
  IF v_owner.id IS NOT NULL THEN
    v_response := v_response || jsonb_build_object('ownerReceipt', jsonb_build_object(
      'id', v_owner.id, 'actorId', v_owner.actor_id, 'idempotencyKey', v_owner.idempotency_key,
      'commandFingerprint', v_owner.command_fingerprint, 'result', v_owner.result));
  END IF;
  INSERT INTO public.customer_support_subscription_commands
    (idempotency_key, payload_fingerprint, operator_id, subject_id, target_id, command_kind, response, created_at)
  VALUES (p_idempotency_key, v_fingerprint, p_operator_id, COALESCE(v_subject.id, v_subscription.client_id),
    p_subscription_id, 'subscription_action', v_response, v_now);
  INSERT INTO public.customer_support_subscription_audit_events
    (operator_id, subject_id, target_id, command_kind, requested_action, idempotency_key,
     outcome, refusal_code, value_before, value_after, occurred_at)
  VALUES (p_operator_id, COALESCE(v_subject.id, v_subscription.client_id), p_subscription_id,
    'subscription_action', p_action, p_idempotency_key, v_outcome, v_refusal_code,
    v_payload->>'newNextCycleAt', v_response->>'nextCycleAt', v_now);
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_reschedule_timezone_validate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_reschedule_timezone_read() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_reschedule_timezone_validate(jsonb), public.subscription_reschedule_timezone_read() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_reschedule_timezone_validate(jsonb), public.subscription_reschedule_timezone_read() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_reschedule_timezone_validate(jsonb), public.subscription_reschedule_timezone_read() TO service_role;'; END IF; END; $$;
