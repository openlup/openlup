-- Keep governed checkout closed until the runtime has a qualified quote owner.
CREATE FUNCTION public.catalog_admission_runtime_checkout(
  p_operation text, p_key text, p_client uuid, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE = '55000',
    HINT = 'Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.';
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_admission_runtime_checkout(text,text,uuid,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_admission_runtime_checkout(text,text,uuid,jsonb) TO service_role;';
END IF; END; $$;

CREATE OR REPLACE FUNCTION public.catalog_admission_check_legacy_draft(
  p_key text, p_draft jsonb, p_client uuid, p_lock boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_skus text[] := ARRAY(SELECT line->>'sku' FROM pg_catalog.jsonb_array_elements(
    CASE WHEN pg_catalog.jsonb_typeof(p_draft->'lines')='array' THEN p_draft->'lines' ELSE '[]'::pg_catalog.jsonb END) AS line);
BEGIN
  IF p_lock THEN
    PERFORM 1 FROM public.clients WHERE id=p_client FOR KEY SHARE;
    PERFORM 1 FROM public.catalog_skus WHERE sku=ANY(v_skus) ORDER BY id FOR KEY SHARE;
    PERFORM public.catalog_admission_lock_shared();
    -- A caller's older transaction snapshot must not hide a concurrent issue.
    IF current_setting('transaction_isolation') IN ('repeatable read','serializable') THEN
      PERFORM 1 FROM public.catalog_products p WHERE id IN (
        SELECT product_id FROM public.catalog_skus WHERE sku=ANY(v_skus)
      ) ORDER BY p.id FOR NO KEY UPDATE;
    END IF;
  END IF;
  IF public.catalog_admission_requires_quote_authority(v_skus,
      coalesce(p_draft#>>'{context,offerVersion,version}',p_draft#>>'{context,offerVersion}'))
    OR EXISTS (
      SELECT 1 FROM public.commerce_orders source_order
      WHERE source_order.id = CASE WHEN p_key ~ '^checkout-recovery-recreate:[a-f0-9-]{36}$'
        AND pg_catalog.pg_input_is_valid(pg_catalog.split_part(p_key,':',2),'pg_catalog.uuid')
        THEN pg_catalog.split_part(p_key,':',2)::pg_catalog.uuid END
        AND source_order.client_id OPERATOR(pg_catalog.=) p_client
        AND source_order.catalog_acceptance IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE = '55000',
      HINT = 'Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_admission_guard_purchase_item(p_item public.commerce_order_items) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_trigger_depth()=0 THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.commerce_order_items i
    JOIN public.catalog_skus s ON s.id=i.sku_id
    JOIN public.commerce_orders o ON o.id=i.order_id
    WHERE i.id=p_item.id AND o.renewal_operation_id IS NULL
      AND public.catalog_admission_requires_quote_authority(ARRAY[s.sku],NULL)
  ) THEN
    RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE='55000',
      HINT='Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_expired_checkout_recovery(
  p_idempotency_key text,p_source_order_id uuid,p_replacement_order_id uuid,p_recovery_window_ms bigint,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE source public.commerce_orders%ROWTYPE; replacement public.commerce_orders%ROWTYPE;
 activation public.subscription_activations%ROWTYPE; intent public.commerce_settlement_intents%ROWTYPE;
 attempt public.payment_simulator_attempts%ROWTYPE; root_id uuid; q jsonb; fingerprint jsonb; first_fingerprint jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key))<8 OR p_source_order_id IS NULL
  OR p_replacement_order_id IS NULL OR p_source_order_id=p_replacement_order_id
  OR p_recovery_window_ms IS NULL OR p_recovery_window_ms<=0 OR p_now IS NULL OR NOT isfinite(p_now) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO source FROM public.commerce_orders WHERE id=p_source_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_expired_recovery_source_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO replacement FROM public.commerce_orders WHERE id=p_replacement_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'commerce_expired_recovery_replacement_not_found' USING ERRCODE='22023'; END IF;
 -- Linked replay precedes fresh admission, even after compensation or payment.
 IF replacement.recreated_from_order_id=source.id THEN
  IF source.client_id IS NULL OR replacement.client_id IS DISTINCT FROM source.client_id
   OR replacement.metadata->>'recoveryIdempotencyKey' IS DISTINCT FROM p_idempotency_key
   OR NOT EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r
     WHERE r.order_id=replacement.id AND r.idempotency_key=p_idempotency_key) THEN
   RAISE EXCEPTION 'commerce_expired_recovery_replacement_invalid' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('contractVersion','commerce.v0','replacementOrderId',replacement.id,'replayed',true); END IF;
 -- A linked replacement is permanent, even while its draft remains unstarted.
 IF replacement.recovery_root_order_id IS NOT NULL OR replacement.recreated_from_order_id IS NOT NULL THEN
  RAISE EXCEPTION 'commerce_expired_recovery_replacement_invalid' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.commerce_orders WHERE recreated_from_order_id=source.id AND id<>replacement.id) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_source_already_recreated' USING ERRCODE='23505'; END IF;
 IF source.subscription_cycle_id IS NOT NULL OR replacement.subscription_cycle_id IS NOT NULL THEN
  RAISE EXCEPTION 'commerce_expired_recovery_renewal_unsupported' USING ERRCODE='22023'; END IF;
 IF replacement.status<>'pending_payment' OR replacement.client_id IS DISTINCT FROM source.client_id
  OR source.client_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r
    WHERE r.order_id=replacement.id AND r.idempotency_key=p_idempotency_key AND r.invalidated_at IS NULL)
  OR jsonb_typeof(replacement.metadata->'quoteSnapshot') IS DISTINCT FROM 'object'
  OR jsonb_typeof(replacement.metadata->'orderDraftSnapshot') IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE order_id=replacement.id)
  OR EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=replacement.id)
  OR EXISTS(SELECT 1 FROM public.subscription_activations WHERE order_id=replacement.id) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_replacement_invalid' USING ERRCODE='22023'; END IF;
 -- An authenticated source's retained acceptance survives live catalogue and token changes.
 IF source.catalog_acceptance IS NOT NULL OR public.catalog_admission_requires_quote_authority(
   ARRAY(SELECT s.sku FROM public.commerce_order_items i JOIN public.catalog_skus s ON s.id=i.sku_id
     WHERE i.order_id=source.id),
   coalesce(source.metadata#>>'{orderDraftSnapshot,context,offerVersion,version}',
            source.metadata#>>'{orderDraftSnapshot,context,offerVersion}')) THEN
  RAISE EXCEPTION 'catalog_admission_quote_authority_required' USING ERRCODE='55000',
    HINT='Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.'; END IF;
 -- Take blocking aggregate locks before deciding the current recovery deadline.
 SELECT * INTO activation FROM public.subscription_activations WHERE order_id=source.id FOR UPDATE;
 PERFORM id FROM public.commerce_settlement_intents WHERE order_id=source.id ORDER BY id FOR UPDATE;
 PERFORM a.id FROM public.payment_simulator_attempts a JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id
  WHERE i.order_id=source.id ORDER BY a.id FOR UPDATE OF a;
 PERFORM e.id FROM public.payment_simulator_observations e JOIN public.payment_simulator_attempts a ON a.id=e.attempt_id
  JOIN public.commerce_settlement_intents i ON i.id=a.settlement_intent_id WHERE i.order_id=source.id ORDER BY e.id FOR UPDATE OF e;
 PERFORM e.id FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i ON i.id=e.settlement_intent_id
  WHERE i.order_id=source.id ORDER BY e.id FOR UPDATE OF e;
 IF source.created_at+make_interval(secs=>p_recovery_window_ms::pg_catalog.float8/1000)<GREATEST(p_now,clock_timestamp()) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_window_elapsed' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(((source.status='expired' AND source.metadata->>'paymentStatus'='expired'
    AND source.metadata->>'source'='checkout_reservation_expiry' AND activation.id IS NULL
    AND COALESCE(source.metadata#>>'{orderDraftSnapshot,context,mode}',source.metadata#>>'{quoteSnapshot,quote,context,mode}','one_time')<>'subscription')
  OR (source.status='cancelled' AND source.metadata->>'subscriptionActivation'='abandoned'
    AND source.metadata->>'source'='initial_checkout_sweep' AND source.metadata->>'paymentStatus'='cancelled'
    AND activation.state='compensated' AND activation.client_id=source.client_id)),false)
  OR source.metadata ? 'manualOrderCancellation' THEN
  RAISE EXCEPTION 'commerce_expired_recovery_source_not_eligible' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(source.metadata->'quoteSnapshot') IS DISTINCT FROM 'object'
  OR NOT EXISTS(SELECT 1 FROM public.commerce_destination_bindings b JOIN public.commerce_destinations d ON d.id=b.destination_id
   WHERE b.order_id=source.id AND d.client_id=source.client_id)
  OR EXISTS(SELECT 1 FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=source.id AND status IN ('held','committed')) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_source_not_eligible' USING ERRCODE='22023'; END IF;
 SELECT * INTO intent FROM public.commerce_settlement_intents WHERE order_id=source.id;
 IF intent.id IS NOT NULL AND intent.channel_key<>'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_provider_states WHERE id=intent.id) THEN
  RAISE EXCEPTION 'native_prepared_attempt_store_unsupported' USING ERRCODE='22023'; END IF;
 IF intent.id IS NOT NULL AND intent.channel_key<>'sandbox' AND NOT EXISTS(
  SELECT 1 FROM public.payment_provider_states s JOIN public.payment_provider_attempts a ON a.id=s.active_attempt_id
  JOIN public.payment_provider_attempt_evidence e ON e.payment_attempt_id=a.id AND e.settlement_intent_id=s.id
  WHERE s.id=intent.id AND a.settlement_intent_id=s.id AND a.status IN ('failed','expired') AND e.signature_verified IS TRUE
   AND e.provider=a.provider AND e.provider_payment_id=a.provider_attempt_id AND e.event_type='payment.failed'
   AND (e.amount_minor IS NULL OR e.amount_minor=0 OR e.amount_minor=intent.amount_minor)
   AND (e.currency IS NULL OR e.currency=intent.currency_code)) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_payment_unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payment_provider_attempts pa JOIN public.payment_provider_attempt_evidence pe
   ON pe.payment_attempt_id=pa.id AND pe.settlement_intent_id=pa.settlement_intent_id
   WHERE pa.settlement_intent_id=intent.id AND pe.provider=pa.provider AND pe.provider_payment_id=pa.provider_attempt_id
    AND pe.signature_verified IS TRUE AND pe.event_type='payment.succeeded')
  OR intent.status='settled' OR EXISTS(SELECT 1 FROM public.payment_truth_events e JOIN public.commerce_settlement_intents i
   ON i.id=e.settlement_intent_id WHERE i.order_id=source.id AND e.outcome='captured')
  OR EXISTS(SELECT 1 FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=intent.id AND a.state='captured') THEN
  RAISE EXCEPTION 'commerce_expired_recovery_money_moved' USING ERRCODE='23505'; END IF;
 SELECT * INTO attempt FROM public.payment_simulator_attempts WHERE settlement_intent_id=intent.id AND is_active;
 IF intent.id IS NULL OR (intent.channel_key='sandbox' AND (attempt.id IS NULL OR attempt.state NOT IN ('refused','expired')
  OR attempt.last_observation_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.payment_simulator_observations e
    WHERE e.id=attempt.last_observation_id AND e.attempt_id=attempt.id AND e.outcome=attempt.state)))
  OR intent.amount_minor IS DISTINCT FROM source.total_amount_minor OR intent.currency_code IS DISTINCT FROM source.currency_code
  OR EXISTS(SELECT 1 FROM public.payment_truth_events WHERE settlement_intent_id=intent.id AND outcome='indeterminate' AND state='open' AND review_required_at IS NULL) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_payment_unavailable' USING ERRCODE='22023'; END IF;
 IF (source.currency_code,source.total_amount_minor) IS DISTINCT FROM (replacement.currency_code,replacement.total_amount_minor)
  OR EXISTS((SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=source.id
      EXCEPT SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=replacement.id)
    UNION ALL (SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=replacement.id
      EXCEPT SELECT sku_id,quantity,unit_amount_minor,line_amount_minor FROM public.commerce_order_items WHERE order_id=source.id)) THEN
  RAISE EXCEPTION 'commerce_expired_recovery_order_changed' USING ERRCODE='23505'; END IF;
 -- Compare the existing commercial fields, excluding transient quote identity.
 FOR q IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
   source.metadata#>'{quoteSnapshot,quote}',replacement.metadata#>'{quoteSnapshot,quote}')) LOOP
  IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR jsonb_typeof(q->'lines') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'commerce_expired_recovery_order_changed' USING ERRCODE='23505'; END IF;
  fingerprint:=jsonb_build_object('currency',q->'currency','lines',(
    SELECT jsonb_agg(jsonb_build_object('sku',line->'sku','productSlug',line->'productSlug','quantity',line->'quantity',
     'unitPriceGross',line->'unitPriceGross','lineSubtotalGross',line->'lineSubtotalGross','tax',line->'tax') ORDER BY ordinal)
     FROM jsonb_array_elements(q->'lines') WITH ORDINALITY AS l(line,ordinal)),
   'discounts',q->'discounts','subtotalGross',q->'subtotalGross','discountTotalGross',q->'discountTotalGross',
   'shippingGross',q->'shippingGross','shippingDiscountGross',q->'shippingDiscountGross',
   'shippingTerms',CASE WHEN q#>'{context,shippingTerms}' IS NULL THEN NULL ELSE jsonb_build_object(
     'version',q#>'{context,shippingTerms,version}','currency',q#>'{context,shippingTerms,currency}',
     'flatMinor',q#>'{context,shippingTerms,flatMinor}','freeThresholdMinor',q#>'{context,shippingTerms,freeThresholdMinor}') END,
   'totalGross',q->'totalGross','netTotal',q->'netTotal','taxTotal',q->'taxTotal',
   'mode',q#>'{context,mode}','cadenceDays',q#>'{context,cadenceDays}','sizeConstraint',q#>'{context,sizeConstraint}');
  IF first_fingerprint IS NULL THEN first_fingerprint:=fingerprint;
  ELSIF first_fingerprint IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'commerce_expired_recovery_order_changed' USING ERRCODE='23505'; END IF;
 END LOOP;
 -- This is a fresh declaration: the locked replacement has no activation and
 -- its client and key were checked above. Stay on the fixed owner search path.
 IF activation.id IS NOT NULL THEN
  INSERT INTO public.subscription_activations(order_id,client_id,cadence_days,state,declare_idempotency_key,declared_at)
   VALUES(replacement.id,replacement.client_id,activation.cadence_days,'provisional',p_idempotency_key||':declare',p_now);
 END IF;
 root_id:=COALESCE(source.recovery_root_order_id,source.id);
 UPDATE public.commerce_orders SET recovery_root_order_id=root_id,recreated_from_order_id=source.id,
  metadata=metadata||jsonb_build_object('recreatedFromOrderId',source.id,'recoveryRootOrderId',root_id,
   'recoveryReason','expired_checkout_recreate','recoveryIdempotencyKey',p_idempotency_key,
   'runtimeFinalize',COALESCE(source.metadata->'runtimeFinalize','{}'::pg_catalog.jsonb))||
   CASE WHEN jsonb_typeof(source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')='object'
    AND source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}'<>'{}'::jsonb
    THEN jsonb_build_object('invoiceBuyerSnapshot',source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')
    WHEN source.metadata ? 'invoiceBuyerSnapshot'
    THEN jsonb_build_object('invoiceBuyerSnapshot',source.metadata->'invoiceBuyerSnapshot')
    WHEN jsonb_typeof(source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')='object'
    THEN jsonb_build_object('invoiceBuyerSnapshot',source.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')
    ELSE '{}'::pg_catalog.jsonb END,
  updated_at=p_now WHERE id=replacement.id;
 RETURN jsonb_build_object('contractVersion','commerce.v0','replacementOrderId',replacement.id,'replayed',false);
END;
$$;
