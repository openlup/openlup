-- CTL-M11 reviewed fixture: serialize checkout admission with policy writes and
-- compare retained quote evidence with effective terms before acquisition.
-- Requires the metadata decoder and terms reader. The transaction shared lock
-- uses the policy writer's exclusive-lock key; private execution is revoked
-- even from service_role.
-- Pinned by managedCommerceForwards in config/reviewed-platform-forwards.json.
-- The registry and real migration rails are authoritative.
-- M11 versions follow every earlier same-rail pin; each pin requires all earlier
-- same-rail pins present with exact bytes.
-- Fixture checks do not establish installation or handler behavior.

CREATE FUNCTION private.commerce_assert_acquisition_admission(p_quote jsonb, p_client_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE candidate jsonb := p_quote #> '{quote,context,acquisitionTerms}'; current_terms jsonb;
BEGIN
  -- Shared with the human writer: it cannot change terms between comparison and admission.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('commerce.subscription_acquisition', 0));
  -- Match the existing promotion port's authoritative paid subscription count.
  -- Plus aliases match the server eligibility adapter's base+tag anti-farming normalization.
  -- A returning subscriber buying a normal second subscription is not acquisition.
  IF candidate IS NULL AND jsonb_typeof(p_quote #> '{quote,discounts}') = 'array'
    AND (p_quote #> '{quote,context,starterPack}' IS NULL OR p_quote #> '{quote,context,starterPack}' = 'null'::jsonb)
    AND NOT EXISTS (
      SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_quote #> '{quote,discounts}') = 'array'
        THEN p_quote #> '{quote,discounts}' ELSE '[]'::jsonb END) discount
      WHERE discount->>'customerSemantic' = 'first_subscription_50'
        OR discount->>'promotionId' IN (SELECT p.id::text FROM public.promotions p
          WHERE p.applies_to_payload ? 'acquisitionTerms' OR
            (p.trigger_type = 'automatic' AND p.code IS NULL
              AND p.eligibility = '{"first_subscription_purchase":true}'::jsonb))
    ) AND EXISTS (
    SELECT FROM public.commerce_orders paid_order
    JOIN public.clients paid_client ON paid_client.id = paid_order.client_id
    JOIN public.clients checkout_client ON checkout_client.id = p_client_id
    WHERE paid_order.status = 'paid' AND paid_order.mode = 'subscription_cycle'
      AND (paid_client.id = p_client_id OR
        regexp_replace(lower(btrim(paid_client.email)), '\+[^@]*@', '@') =
        regexp_replace(lower(btrim(checkout_client.email)), '\+[^@]*@', '@'))
  ) THEN RETURN; END IF;
  IF candidate IS NULL AND NOT EXISTS (SELECT FROM public.promotions
    WHERE applies_to_payload ? 'acquisitionTerms'
      AND public.platform_region_code() = ANY(region_availability)) THEN RETURN; END IF;
  current_terms := public.commerce_subscription_acquisition_terms(clock_timestamp());
  IF candidate IS NULL AND current_terms->>'kind' = 'legacy_pair' THEN RETURN; END IF;
  IF current_terms->>'kind' = 'v2_standalone' AND (
    p_quote #>> '{quote,context,pricingPolicy,offerPolicyVersion}' IS DISTINCT FROM 'commerce.offer-policy.v2'
    OR p_quote #>> '{quote,context,pricingPolicy,promotionEngineVersion}' IS DISTINCT FROM 'promotion-engine.v2') THEN
    RAISE EXCEPTION 'acquisition_terms_changed' USING ERRCODE = '55000';
  END IF;
  IF p_quote #> '{quote,context,starterPack}' IS NOT NULL
    AND p_quote #> '{quote,context,starterPack}' <> 'null'::jsonb
    AND p_quote #> '{quote,context,starterPack,delivery2,discountBps}' IS DISTINCT FROM current_terms->'delivery2DiscountBps' THEN
    RAISE EXCEPTION 'acquisition_terms_changed' USING ERRCODE = '55000';
  END IF;

  current_terms := current_terms - ARRAY['kind','legacyPairCount','standaloneCount','nextBoundaryAt'];
  IF candidate IS DISTINCT FROM current_terms THEN
    RAISE EXCEPTION 'acquisition_terms_changed' USING ERRCODE = '55000';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.commerce_assert_acquisition_admission(jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
