-- Native command boundary. The invoker host authenticates/authorizes the trusted
-- actor and client (including operator scope); no browser role can execute it.
-- The existing five-action lifecycle rail remains unchanged. Generic bundle
-- commands use the native edit-quote/catalogue contract, with command-bound
-- acceptance and atomic future renewal terms. Prices lock until the next edit;
-- proration is none. No operation/cycle/order/payment snapshot is rewritten.
-- Raw preview replay extracts the stored payload before subtracting acceptedQuoteHash.
-- Donor semantics: generic_bundle_actions (20260711151000), native line/cadence
-- no-op truth (20260711170020), slide no-op truth (20260713110000), locked renewal
-- lane (20260826160000). Portion mode/factor, introductory and address policy
-- stay host-owned; native resize compares lines/cadence, not a stored mode.

CREATE TABLE public.subscription_command_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 180),
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
 client_id uuid NOT NULL REFERENCES public.clients(id),
 command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
 command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
 quote_hash text,
 result jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('previewed','applied','noop','refused')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT subscription_command_actor_key UNIQUE (actor_id,idempotency_key)
);

-- Preview normalizes the generic command into the native bounded whole-bundle
-- quote. The stored command excludes only the subsequently accepted quote hash;
-- its action and every other supplied field remain part of the fingerprint.
CREATE FUNCTION public.subscription_command_preview(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text;
 core jsonb; addons jsonb; requested jsonb; lines jsonb; cadence integer; version integer;
 total bigint; current_total bigint; quote_key text; quote_hash text; answer jsonb; reason text;
 v_noop boolean:=false; core_matches boolean; addon_matches boolean;
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
   BEGIN
    v_noop:=s.status='active' AND s.next_cycle_at IS NOT NULL
     AND floor(extract(epoch FROM NULLIF(p_payload->>'newNextCycleAt','')::timestamptz)/86400)
      =floor(extract(epoch FROM s.next_cycle_at)/86400);
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
  IF NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  version:=(p_payload->>'expectedTemplateVersion')::integer;
  IF version IS NULL OR version<>s.template_version THEN
   RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
  END IF;
  cadence:=COALESCE((p_payload->>'cadenceDays')::integer,(p_payload->>'planDays')::integer,s.cadence_days);
  IF cadence NOT BETWEEN 1 AND 90 OR s.price_list_id IS NULL OR s.currency_code IS NULL THEN
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
  ELSIF p_action='add_addon' THEN
   addons:=addons||jsonb_build_array(jsonb_build_object('variantId',p_payload->>'variantId','qty',p_payload->'qty'));
  ELSIF p_action IN ('remove_addon','update_addon_quantity') THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(addons) v WHERE v->>'variantId'=p_payload->>'variantId') THEN
    RAISE EXCEPTION 'subscription_command_addon_not_found' USING ERRCODE='22023';
   END IF;
   SELECT COALESCE(jsonb_agg(CASE WHEN v->>'variantId'=p_payload->>'variantId' THEN
    jsonb_set(v,'{qty}',p_payload->'qty') ELSE v END),'[]') INTO addons
    FROM jsonb_array_elements(addons) v WHERE p_action<>'remove_addon' OR v->>'variantId'<>p_payload->>'variantId';
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
  quote_hash:=encode(sha256(convert_to(quote_key||':'||fingerprint||':'||lines::text||':'||(p_now+interval '15 minutes')::text,'UTF8')),'hex');
  INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,
   expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
   VALUES(s.id,quote_key,fingerprint,quote_hash,version,lines,cadence,current_total,total,s.currency_code,p_now+interval '15 minutes') RETURNING * INTO q;
  answer:=jsonb_build_object('status','previewed','canApply',true,'quoteHash',q.quote_hash,'quoteExpiresAt',q.expires_at,
   'templateVersion',version,'lines',lines,'currentTotalMinor',current_total,'newTotalMinor',total,
   'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only'));
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  answer:=jsonb_build_object('status','refused','canApply',false,'reason',reason);
 END;
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,q.quote_hash,answer,answer->>'status');
 RETURN answer;
END;
$$;

CREATE FUNCTION public.subscription_command_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
<<apply_command>>
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text; quote_fingerprint text; answer jsonb;
 reason text; event_id uuid; event_key text; line jsonb; target timestamptz; outcome text:='applied';
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
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  -- Take the same subscription lock as claim first, then the future
  -- terms and every line. A previously deferred operation keeps its snapshot.
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  -- Existing preparation owns the operation before it inserts a cycle. Do
  -- not wait in the reverse lock order: refuse a busy operation, or a live
  -- pre-payment lease whose worker could still prepare after this command.
  IF p_action IN ('cancel','resume','skip_next_cycle','slide_next_cycle','order_now','reactivate')
   AND NOT (p_action='slide_next_cycle' AND floor(extract(epoch FROM (p_payload->>'newNextCycleAt')::timestamptz)/86400)
     =floor(extract(epoch FROM s.next_cycle_at)/86400)) THEN
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
   IF NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
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
    DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
    FOR line IN SELECT value FROM jsonb_array_elements(q.proposed_lines) LOOP
     INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES(s.id,(line->>'variantId')::uuid,(line->>'quantity')::integer,(line->>'sortOrder')::integer,
       (line->>'isAddon')::boolean,(line->>'unitPriceMinor')::bigint,q.currency_code);
    END LOOP;
    DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
    INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
     SELECT s.id,(v->>'sortOrder')::integer+1,sku.sku,(v->>'quantity')::integer,(v->>'unitPriceMinor')::bigint
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid;
    UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
    UPDATE public.subscriptions SET cadence_days=q.proposed_cadence_days,template_version=template_version+1,updated_at=p_now
     WHERE id=s.id RETURNING * INTO s;
   END IF;
  ELSIF p_action IN ('order_now','reactivate') THEN
   IF p_payload->'confirmedChargeTiming' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'subscription_command_charge_timing_not_confirmed' USING ERRCODE='22023';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy')
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   IF (p_action='order_now' AND (s.status<>'active' OR s.next_cycle_at IS NULL))
    OR (p_action='reactivate' AND s.status<>'cancelled') THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   target:=p_now+CASE p_action WHEN 'order_now' THEN interval '5 minutes' ELSE interval '2 days' END;
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
   IF p_action IN ('skip_next_cycle','slide_next_cycle') AND NOT EXISTS(
    SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   -- Do not move away from a current payment obligation on resume.
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
   answer:=public.subscription_apply_lifecycle_action(p_client_id,event_key,s.id,p_action,p_payload,p_now);
   outcome:=answer#>>'{subscriptionAction,status}';
   event_id:=(answer#>>'{subscriptionAction,eventId}')::uuid;
   SELECT * INTO s FROM public.subscriptions WHERE id=s.id;
  ELSE
   RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023';
  END IF;
  IF answer IS NULL AND outcome='applied' THEN
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
    VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'payload',p_payload,
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
    RETURNING id INTO event_id;
  END IF;
  IF q.id IS NOT NULL AND outcome='applied' THEN
   UPDATE public.subscription_edit_quotes SET status='accepted',accepted_event_id=event_id,accepted_at=p_now WHERE id=q.id;
  END IF;
  answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
   'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
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
REVOKE ALL ON public.subscription_command_receipts FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
