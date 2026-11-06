-- Exact future-template levers share the editor ledger and receipt boundary.
CREATE FUNCTION public.subscription_line_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 lines jsonb; line jsonb; line_pricing jsonb:='[]'::jsonb; constraint_value jsonb;
 version integer; plan integer; ordinal integer:=0; target_id uuid; new_line_id uuid;
 base_matches boolean; outcome text:='applied'; base_set boolean;
 current_total bigint; desired_total bigint;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('swap_base_line','add_addon','remove_addon','update_addon_quantity',
  'update_plan_length','update_base_mix','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,action}',to_jsonb(p_action));
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 lines:=p_payload->'lines';
 base_set:=p_action IN ('update_plan_length','update_base_mix','update_portion');
 IF base_set AND jsonb_typeof(lines)='array' THEN
  SELECT (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
   SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(lines) v
   WHERE (v->>'isAddon')::boolean=false GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon
     GROUP BY variant_id) current_lines) INTO base_matches;
 END IF;
 IF p_action='swap_base_line' THEN
  IF (p_payload#>>'{request,fromVariantId}')::uuid=(p_payload#>>'{request,toVariantId}')::uuid THEN outcome:='noop'; END IF;
 ELSIF p_action IN ('add_addon','update_addon_quantity') THEN
  IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon
   AND variant_id=(p_payload#>>'{request,variantId}')::uuid AND quantity=(p_payload#>>'{request,qty}')::integer) THEN outcome:='noop'; END IF;
 ELSIF p_action='update_base_mix' THEN
  IF base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_plan_length' THEN
  IF (p_payload#>>'{request,planDays}')::integer=s.cadence_days AND base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_portion' THEN
  IF base_matches AND COALESCE(s.composition_constraint->>'mode',p_payload#>>'{portionModes,full,mode}')=p_payload#>>'{request,portionMode}'
   AND COALESCE(s.composition_constraint->'portionFactor',p_payload#>'{portionModes,full,factor}')=p_payload#>'{compositionConstraint,portionFactor}' THEN outcome:='noop'; END IF;
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,p_action,p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal((p_payload->'request')-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',q#>'{quote_snapshot,compositionConstraint}');
  plan:=s.cadence_days; constraint_value:=s.composition_constraint;
  IF p_action='swap_base_line' THEN
   IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,toVariantId}')::uuid) THEN
    RAISE EXCEPTION 'subscription_edit_conflict_duplicate_line' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET variant_id=(p_payload#>>'{request,toVariantId}')::uuid,updated_at=p_now
    WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,fromVariantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_line' USING ERRCODE='22023'; END IF;
  ELSIF p_action='add_addon' THEN
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(p_payload#>>'{request,variantId}')::uuid,GREATEST(1,COALESCE((p_payload#>>'{request,qty}')::integer,1)),
    COALESCE((SELECT max(sort_order)+1 FROM public.subscription_lines WHERE subscription_id=s.id),1),true,0,s.currency_code)
   RETURNING id INTO new_line_id;
  ELSIF p_action='remove_addon' THEN
   DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_addon_quantity' THEN
   IF (p_payload#>>'{request,qty}')::integer IS NULL OR (p_payload#>>'{request,qty}')::integer<=0 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_addon_qty' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET quantity=(p_payload#>>'{request,qty}')::integer,updated_at=p_now
    WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_plan_length' THEN
   plan:=(p_payload#>>'{request,planDays}')::integer;
   IF plan IS NULL OR plan<=0 THEN RAISE EXCEPTION 'subscription_edit_invalid_plan_length' USING ERRCODE='22023'; END IF;
   constraint_value:=jsonb_set(COALESCE(s.composition_constraint,'{}'::jsonb),'{value}',to_jsonb(plan));
  ELSIF p_action='update_base_mix' THEN
   SELECT COALESCE(sum(quantity),0) INTO current_total FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
   SELECT COALESCE(sum((v->>'qty')::integer),0) INTO desired_total FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
   IF desired_total<>current_total THEN RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_portion' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'portionModes',q#>'{quote_snapshot,portionModes}');
   IF p_payload#>>'{request,portionMode}' IS NULL OR
    (p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,full,mode}'
     AND p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,reduced,mode}')
    OR p_payload#>>'{compositionConstraint,mode}' IS DISTINCT FROM p_payload#>>'{request,portionMode}'
    OR jsonb_typeof(p_payload#>'{compositionConstraint,portionFactor}') IS DISTINCT FROM 'number'
    OR (p_payload#>>'{compositionConstraint,portionFactor}')::numeric<=0
    OR p_payload#>'{compositionConstraint,portionFactor}' IS DISTINCT FROM (CASE
      WHEN p_payload#>>'{request,portionMode}'=p_payload#>>'{portionModes,full,mode}' THEN p_payload#>'{portionModes,full,factor}'
      ELSE p_payload#>'{portionModes,reduced,factor}' END) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_portion_mode' USING ERRCODE='22023'; END IF;
   constraint_value:=jsonb_set(jsonb_set(COALESCE(s.composition_constraint,'{}'::jsonb),'{mode}',p_payload#>'{compositionConstraint,mode}'),
    '{portionFactor}',p_payload#>'{compositionConstraint,portionFactor}');
  END IF;
  IF base_set THEN DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon; END IF;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF base_set AND NOT (line->>'isAddon')::boolean THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
    VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,false,
     (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code) RETURNING id INTO target_id;
   ELSE
    target_id:=COALESCE((line->>'lineId')::uuid,new_line_id);
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
     currency_code=s.currency_code,updated_at=p_now WHERE id=target_id AND subscription_id=s.id
     AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer AND is_addon=(line->>'isAddon')::boolean;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 RETURN answer;
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz) TO service_role'; END IF; END; $$;
