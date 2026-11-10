-- Sized edits retain exact agreements and bind an offer only through accepted consent.
-- Host-owned fact rows are locked/compared on the apply connection before this call.
ALTER TABLE public.subscriptions ADD COLUMN configured_offer_version text NOT NULL DEFAULT 'classic';
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_configured_offer_version_check
 CHECK (configured_offer_version IN ('classic','sized.v1')) NOT VALID;

CREATE FUNCTION public.subscription_sized_edit_context(p_client_id uuid,p_subscription_id uuid,p_opt_in boolean)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; terms jsonb; prices jsonb; initial_quote jsonb; marker jsonb;
 lines jsonb:='[]'::jsonb; graduation jsonb:='[]'::jsonb; row_line record; price jsonb; quoted jsonb; entry jsonb;
 count_matches integer; paid integer;
BEGIN
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND p_opt_in IS TRUE) THEN
  RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 terms:=public.subscription_renewal_purchase_terms(s.id)->'renewalTerms';
 SELECT e.payload->'linePricing' INTO prices FROM public.subscription_events e WHERE e.subscription_id=s.id
  AND e.event_type IN ('subscription.starter_graduated','subscription.customer_self_service.update_package_template',
   'subscription.customer_self_service.swap_base_line','subscription.customer_self_service.add_addon',
   'subscription.customer_self_service.remove_addon','subscription.customer_self_service.update_addon_quantity',
   'subscription.customer_self_service.update_plan_length','subscription.customer_self_service.update_base_mix',
   'subscription.customer_self_service.update_portion','subscription.customer_self_service.resize_bundle',
   'subscription.customer_self_service.update_bundle') ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1;
 prices:=COALESCE(prices,terms->'linePricing');
 IF prices IS NULL THEN
  SELECT o.metadata#>'{quoteSnapshot,quote,lines}' INTO initial_quote FROM public.subscription_activations a
   JOIN public.commerce_orders o ON o.id=a.order_id WHERE a.subscription_id=s.id;
  IF jsonb_typeof(initial_quote) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(jsonb_build_object('sku',v->>'sku','quantity',v->'quantity',
   'unitAmountMinor',v#>'{unitPriceGross,amountMinor}','quoteLine',v)) INTO prices FROM jsonb_array_elements(initial_quote) v;
 END IF;
 IF jsonb_typeof(prices) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
 FOR row_line IN SELECT l.*,sku.sku,sku.product_id FROM public.subscription_lines l
  JOIN public.catalog_skus sku ON sku.id=l.variant_id WHERE l.subscription_id=s.id ORDER BY l.sort_order,l.variant_id LOOP
  SELECT count(*) INTO count_matches FROM jsonb_array_elements(prices) v WHERE v->>'sku'=row_line.sku;
  IF count_matches<>1 THEN RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  SELECT v INTO price FROM jsonb_array_elements(prices) v WHERE v->>'sku'=row_line.sku;
  quoted:=price->'quoteLine';
  IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines t WHERE t.subscription_id=s.id AND t.sku=row_line.sku
   AND t.quantity=row_line.quantity AND t.unit_amount_minor=row_line.unit_price_minor) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  IF price->'quantity' IS DISTINCT FROM to_jsonb(row_line.quantity) OR price->'unitAmountMinor' IS DISTINCT FROM to_jsonb(row_line.unit_price_minor)
   OR quoted->>'sku' IS DISTINCT FROM row_line.sku OR quoted->'quantity' IS DISTINCT FROM to_jsonb(row_line.quantity)
   OR quoted#>'{unitPriceGross,amountMinor}' IS DISTINCT FROM to_jsonb(row_line.unit_price_minor)
   OR quoted#>>'{unitPriceGross,currency}' IS DISTINCT FROM row_line.currency_code
   OR quoted#>>'{lineSubtotalGross,currency}' IS DISTINCT FROM row_line.currency_code
   OR quoted#>'{lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb(row_line.quantity*row_line.unit_price_minor)
   OR (price ? 'isAddon' AND price->'isAddon' IS DISTINCT FROM to_jsonb(row_line.is_addon)) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
  lines:=lines||jsonb_build_array(jsonb_build_object('lineId',row_line.id,'variantId',row_line.variant_id,
   'sku',row_line.sku,'groupId',row_line.product_id,'qty',row_line.quantity,'isAddon',row_line.is_addon,'quoteLine',quoted));
 END LOOP;
 IF jsonb_array_length(lines)=0 THEN RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
 marker:=terms->'starterPack';
 IF marker IS NOT NULL THEN
  IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR jsonb_typeof(marker#>'{graduation,lines}') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_marker' USING ERRCODE='22023'; END IF;
  FOR entry IN SELECT v FROM jsonb_array_elements(marker#>'{graduation,lines}') v LOOP
   SELECT id,product_id INTO row_line FROM public.catalog_skus WHERE sku=entry->>'sku';
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_invalid_agreed_price' USING ERRCODE='22023'; END IF;
   graduation:=graduation||jsonb_build_array(jsonb_build_object('lineId',NULL,'variantId',row_line.id,
    'sku',entry->>'sku','groupId',row_line.product_id,'qty',entry->'qty','isAddon',entry->'isAddon','quoteLine',entry->'quoteLine'));
  END LOOP;
 END IF;
 SELECT count(*)::integer INTO paid FROM public.subscription_cycles WHERE subscription_id=s.id AND status='paid';
 RETURN jsonb_build_object('subscriptionId',s.id,'clientId',s.client_id,'binding',s.configured_offer_version,
  'templateVersion',s.template_version,'cadenceDays',s.cadence_days,'compositionConstraint',s.composition_constraint,
  'nextCycleAt',s.next_cycle_at,'paidCycleCount',paid,'marker',marker,'lines',lines,'graduationLines',graduation);
END;
$$;

CREATE FUNCTION public.subscriptions_configured_offer_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.configured_offer_version IS DISTINCT FROM 'classic' THEN
   RAISE EXCEPTION 'subscription_configured_offer_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.configured_offer_version IS NOT DISTINCT FROM OLD.configured_offer_version THEN RETURN NEW; END IF;
 IF pg_trigger_depth()>1 AND OLD.status='active' AND NEW.status=OLD.status
  AND OLD.configured_offer_version='classic' AND NEW.configured_offer_version='sized.v1'
  AND OLD.next_cycle_at IS NOT DISTINCT FROM NEW.next_cycle_at THEN
  IF EXISTS (
   SELECT 1 FROM public.subscription_events e JOIN public.subscription_quote_previews q
    ON q.id=(e.payload->>'quotePreviewId')::uuid
   WHERE e.subscription_id=NEW.id AND e.event_type='subscription.customer_self_service.resize_bundle'
    AND e.payload#>'{payload,resizeLever,value,optInToSized}'='true'::jsonb
    AND q.request_payload->'resizeLever'=e.payload#>'{payload,resizeLever}'
    AND q.subscription_id=NEW.id AND q.client_id=NEW.client_id AND q.action='resize_bundle'
    AND q.status='accepted' AND q.accepted_event_id=e.id
    AND e.idempotency_key='command:'||encode(sha256(convert_to(q.actor_id::text||':'||q.accepted_idempotency_key,'UTF8')),'hex')
    AND q.template_version+1=NEW.template_version
    AND q.quote_snapshot->'compositionConstraint'=NEW.composition_constraint
  ) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'subscription_configured_offer_immutable' USING ERRCODE='23514';
END;
$$;

CREATE FUNCTION public.subscriptions_bind_sized_opt_in_from_edit()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF NEW.event_type<>'subscription.customer_self_service.resize_bundle'
  OR NEW.payload#>'{payload,resizeLever,value,optInToSized}' IS DISTINCT FROM 'true'::jsonb THEN RETURN NEW; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=NEW.subscription_id FOR UPDATE;
 IF NOT FOUND OR s.configured_offer_version<>'classic' OR s.status<>'active' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_opt_in_binding' USING ERRCODE='22023'; END IF;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE id=(NEW.payload->>'quotePreviewId')::uuid
  AND subscription_id=s.id AND client_id=s.client_id AND action='resize_bundle' AND status='accepted'
  AND accepted_event_id=NEW.id
  AND NEW.idempotency_key='command:'||encode(sha256(convert_to(actor_id::text||':'||accepted_idempotency_key,'UTF8')),'hex');
 IF NOT FOUND OR q.request_payload#>'{resizeLever,value,optInToSized}' IS DISTINCT FROM 'true'::jsonb
  OR q.request_payload#>>'{resizeLever,kind}' IS DISTINCT FROM 'subscription.sized.parcel'
  OR q.expires_at<=NEW.occurred_at OR q.request_payload->'resizeLever' IS DISTINCT FROM NEW.payload#>'{payload,resizeLever}'
  OR q.template_version+1<>s.template_version OR q.quote_snapshot->'compositionConstraint' IS DISTINCT FROM s.composition_constraint
  OR jsonb_typeof(q.quote_snapshot->'optInFacts') IS DISTINCT FROM 'object'
  OR q.quote_snapshot->'optInFacts' IS DISTINCT FROM NEW.payload->'optInFacts' THEN
  RAISE EXCEPTION 'subscription_edit_quote_not_accepted' USING ERRCODE='22023'; END IF;
 -- The host has locked and compared its own subject/need facts on this connection.
 UPDATE public.subscriptions SET configured_offer_version='sized.v1' WHERE id=s.id;
 RETURN NEW;
END;
$$;

CREATE FUNCTION public.subscription_sized_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 action text; request jsonb; command jsonb; fingerprint text; answer jsonb; q jsonb; lines jsonb; line jsonb;
 event_id uuid; event_key text; line_pricing jsonb:='[]'::jsonb; version integer; plan integer; ordinal integer:=0;
 constraint_value jsonb; opt_in boolean; intro jsonb; phase_config jsonb; paid integer;
 current_core jsonb; desired_core jsonb; outcome text:='applied'; rewrites_addons boolean;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'request') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 request:=p_payload->'request'; action:=request->>'action';
 IF action IS NULL OR action NOT IN ('resize_bundle','update_bundle','update_base_mix','update_plan_length','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',action,'payload',request);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM request->>'acceptedQuoteHash' THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 opt_in:=action='resize_bundle' AND request#>>'{resizeLever,kind}'='subscription.sized.parcel'
  AND request#>'{resizeLever,value,optInToSized}'='true'::jsonb;
 IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND COALESCE(opt_in,false)) THEN
  RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 intro:=public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}';
 IF intro IS NOT NULL THEN
  SELECT value_text::jsonb INTO phase_config FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
  IF phase_config IS NULL OR COALESCE(phase_config->>'fixedThroughCycle','') !~ '^[1-9][0-9]*$'
   OR COALESCE(phase_config->>'graduationCycle','') !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO paid FROM public.subscription_cycles WHERE subscription_id=s.id AND status='paid';
  IF paid+1<=(phase_config->>'fixedThroughCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
  IF COALESCE(opt_in,false) AND s.template_version=(intro->>'basisTemplateVersion')::integer
   AND paid<(phase_config->>'graduationCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
 END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(request->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 lines:=p_payload->'lines'; constraint_value:=p_payload->'compositionConstraint'; plan:=(p_payload->>'cadenceDays')::integer;
 IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0
  OR jsonb_typeof(constraint_value) IS DISTINCT FROM 'object' OR plan IS NULL OR plan<=0 THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) INTO current_core FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
 SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb) INTO desired_core FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
 rewrites_addons:=action='update_bundle' AND request ? 'addonLines';
 IF action IN ('update_base_mix','update_bundle') AND (action='update_base_mix' OR plan=s.cadence_days)
  AND (SELECT sum((v->>'qty')::integer) FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean)
   <>(SELECT sum(quantity) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
  RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(opt_in,false) AND current_core=desired_core AND plan=s.cadence_days AND constraint_value=s.composition_constraint
  AND (NOT rewrites_addons OR (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean)=(SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb)
    FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon)) THEN outcome:='noop';
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,action,request->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(request-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(constraint_value,q#>'{quote_snapshot,compositionConstraint}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'subjectFacts',q#>'{quote_snapshot,subjectFacts}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'optInFacts',q#>'{quote_snapshot,optInFacts}');
  -- Admission is current SKU state under a row lock; no catalogue publication head exists here.
  FOR line IN SELECT v FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean LOOP
   IF COALESCE(opt_in,false) OR (line->>'qty')::integer>COALESCE((current_core->>(line->>'variantId'))::integer,0) THEN
    PERFORM 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND status='active' AND sellable_in_subscription FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_invalid_sku_admission' USING ERRCODE='22023'; END IF;
   END IF;
  END LOOP;
  IF NOT rewrites_addons AND (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean) IS DISTINCT FROM
   (SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon) THEN
   RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND (NOT is_addon OR rewrites_addons);
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF line#>>'{quoteLine,unitPriceGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>>'{quoteLine,lineSubtotalGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>'{quoteLine,quantity}' IS DISTINCT FROM line->'qty'
    OR line#>'{quoteLine,lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb((line->>'qty')::bigint*(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint)
    OR NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND sku=line#>>'{quoteLine,sku}') THEN
    RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   IF NOT (line->>'isAddon')::boolean OR rewrites_addons THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
     VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
      (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   ELSE
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,updated_at=p_now
     WHERE subscription_id=s.id AND id=(line->>'lineId')::uuid AND is_addon AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    VALUES(s.id,ordinal,line#>>'{quoteLine,sku}',(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint);
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}','quantity',(line->>'qty')::integer,
    'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  -- AFTER-row triggers run at statement end. The CTE makes native FK-bound
  -- acceptance visible before the binding trigger checks the accepted join.
  WITH inserted AS (
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||action,event_key,jsonb_build_object('action',action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',request-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],'optInFacts',p_payload->'optInFacts',
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now) RETURNING id
   ), accepted AS MATERIALIZED (
    SELECT id,public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,id,p_now) AS acceptance FROM inserted
   ) SELECT id INTO event_id FROM accepted;
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,request->>'acceptedQuoteHash',answer,outcome);
 RETURN answer;
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_sized_edit_context(uuid,uuid,boolean), public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz), public.subscriptions_configured_offer_guard(), public.subscriptions_bind_sized_opt_in_from_edit() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_sized_edit_context(uuid,uuid,boolean), public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz), public.subscriptions_configured_offer_guard(), public.subscriptions_bind_sized_opt_in_from_edit() FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_sized_edit_context(uuid,uuid,boolean), public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz), public.subscriptions_configured_offer_guard(), public.subscriptions_bind_sized_opt_in_from_edit() FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions_configured_offer_guard(), public.subscriptions_bind_sized_opt_in_from_edit() FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_sized_edit_context(uuid,uuid,boolean), public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz) TO service_role'; END IF; END; $$;

CREATE TRIGGER subscriptions_configured_offer_guard BEFORE INSERT OR UPDATE OF configured_offer_version ON public.subscriptions
 FOR EACH ROW EXECUTE FUNCTION public.subscriptions_configured_offer_guard();
CREATE TRIGGER subscription_events_bind_sized_opt_in AFTER INSERT ON public.subscription_events
 FOR EACH ROW EXECUTE FUNCTION public.subscriptions_bind_sized_opt_in_from_edit();
