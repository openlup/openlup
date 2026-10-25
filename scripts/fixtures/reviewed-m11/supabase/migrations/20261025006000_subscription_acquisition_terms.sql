-- CTL-M11 working draft: close the M05 terms-reader dependency of checkout
-- acquisition admission. Restate the donor body and service-only ACL unchanged.
-- Uses existing promotions columns and the preceding private metadata decoder;
-- creates no storage, seed, campaign or policy writer. No policy means admission
-- takes its donor compatibility branch; this reader itself refuses no terms.
-- Policy writers must hold the exclusive transaction advisory lock for
-- hashtextextended('commerce.subscription_acquisition', 0) before reading/writing
-- policy rows; finalize holds the shared lock through admission and creation.
-- Inert fixture only: the proposed managed commerce class is not admitted.

CREATE FUNCTION public.commerce_subscription_acquisition_terms(p_at timestamptz DEFAULT clock_timestamp())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.promotions%ROWTYPE; legacy public.promotions%ROWTYPE;
  m jsonb; selected jsonb; n integer := 0; configured boolean;
  previous_end timestamptz; boundary timestamptz; legacy_count integer := 0; seen text[] := ARRAY[]::text[]; region text := public.platform_region_code();
BEGIN
  IF p_at IS NULL THEN RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023'; END IF;
  SELECT EXISTS(SELECT FROM public.promotions p WHERE p.status = 'active' AND region = ANY(p.region_availability)
    AND p.applies_to_payload ? 'acquisitionTerms') INTO configured;
  FOR r IN SELECT * FROM public.promotions p
    WHERE region = ANY(p.region_availability) AND p.status = 'active'
      AND (p.applies_to_payload ? 'acquisitionTerms' OR
        (p.trigger_type = 'automatic' AND p.code IS NULL AND p.discount_type = 'percentage'
          AND p.applies_to_kind = 'order_total' AND p.stacking_rule = 'exclusive'
          AND p.eligibility = '{"first_subscription_purchase":true}'::jsonb))
    ORDER BY p.valid_from, p.id
  LOOP
    m := private.commerce_acquisition_metadata(r.applies_to_payload);
    IF configured AND m IS NULL THEN RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023'; END IF;
    IF r.trigger_type <> 'automatic' OR r.code IS NOT NULL OR r.discount_type <> 'percentage'
      OR r.applies_to_kind <> 'order_total' OR r.stacking_rule <> 'exclusive'
      OR r.eligibility <> '{"first_subscription_purchase":true}'::jsonb
      OR (r.applies_to_payload - 'acquisitionTerms') <> '{"cart_mode":"subscription"}'::jsonb
      OR r.redemption_limit_per_customer IS DISTINCT FROM 1 OR r.redemption_limit_global IS NOT NULL
      OR r.valid_from IS NULL OR (r.valid_to IS NOT NULL AND r.valid_to <= r.valid_from) THEN
      RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
    END IF;
    IF r.promotion_engine_version = 'promotion-engine.v1' THEN
      IF r.discount_value <> 44.404 OR r.v2_mirror_of IS NOT NULL
        OR (m IS NOT NULL AND m <> '{"schemaVersion":"subscription-acquisition.v1","revision":"legacy-50-35","delivery2DiscountBps":3500}'::jsonb) THEN
        RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
      END IF;
      IF (SELECT count(*) FROM public.promotions mirror
        WHERE mirror.v2_mirror_of = r.id AND mirror.status = 'active'
          AND region = ANY(mirror.region_availability)) <> 1 THEN
        RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
      END IF;
      IF r.valid_from <= p_at AND (r.valid_to IS NULL OR r.valid_to > p_at) THEN legacy_count := legacy_count + 1; END IF;
      CONTINUE;
    END IF;
    IF r.promotion_engine_version IS DISTINCT FROM 'promotion-engine.v2' OR r.benefit_lane IS DISTINCT FROM 'product'
      OR r.benefit_kind IS DISTINCT FROM 'target_percentage' OR r.benefit_value_bps IS NULL OR r.benefit_value_bps NOT BETWEEN 1 AND 9999
      OR r.benefit_value_minor IS NOT NULL OR r.discount_value * 100 <> r.benefit_value_bps THEN
      RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
    END IF;
    IF r.v2_mirror_of IS NOT NULL THEN
      SELECT * INTO legacy FROM public.promotions WHERE id = r.v2_mirror_of;
      IF NOT FOUND OR legacy.promotion_engine_version <> 'promotion-engine.v1'
        OR legacy.trigger_type <> 'automatic' OR legacy.code IS NOT NULL
        OR legacy.discount_type <> 'percentage' OR legacy.discount_value <> 44.404
        OR legacy.applies_to_kind <> 'order_total' OR legacy.stacking_rule <> r.stacking_rule
        OR legacy.eligibility <> r.eligibility OR legacy.applies_to_payload <> r.applies_to_payload
        OR legacy.status <> 'active' OR legacy.valid_from IS DISTINCT FROM r.valid_from
        OR legacy.valid_to IS DISTINCT FROM r.valid_to OR legacy.region_availability <> r.region_availability
        OR legacy.redemption_limit_per_customer IS DISTINCT FROM 1 OR legacy.redemption_limit_global IS NOT NULL
        OR r.benefit_value_bps <> 5000
        OR (m IS NOT NULL AND m <> '{"schemaVersion":"subscription-acquisition.v1","revision":"legacy-50-35","delivery2DiscountBps":3500}'::jsonb) THEN
        RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
      END IF;
      m := COALESCE(m, '{"schemaVersion":"subscription-acquisition.v1","revision":"legacy-50-35","delivery2DiscountBps":3500}'::jsonb);
    ELSIF m IS NULL THEN
      RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
    END IF;
    IF m->>'revision' = ANY(seen) THEN RAISE EXCEPTION 'acquisition_terms_ambiguous' USING ERRCODE = '55000'; END IF;
    IF cardinality(seen) > 0 THEN
      IF previous_end IS NULL OR previous_end > r.valid_from THEN
        RAISE EXCEPTION 'acquisition_terms_ambiguous' USING ERRCODE = '55000';
      END IF;
      IF previous_end < r.valid_from THEN
        RAISE EXCEPTION 'acquisition_terms_not_effective' USING ERRCODE = '55000';
      END IF;
    END IF;
    previous_end := r.valid_to;
    seen := array_append(seen, m->>'revision');
    IF r.valid_from > p_at THEN boundary := LEAST(boundary, r.valid_from); END IF;
    IF r.valid_to > p_at THEN boundary := LEAST(boundary, r.valid_to); END IF;
    IF r.valid_from <= p_at AND (r.valid_to IS NULL OR r.valid_to > p_at) THEN
      n := n + 1;
      selected := m || jsonb_build_object('initialDiscountBps', r.benefit_value_bps,
        'sourcePromotionId', r.id,
        'effectiveFrom', to_char(r.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveTo', CASE WHEN r.valid_to IS NULL THEN NULL ELSE to_char(r.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'kind', CASE WHEN r.v2_mirror_of IS NULL THEN 'v2_standalone' ELSE 'legacy_pair' END,
        'legacyPairCount', CASE WHEN r.v2_mirror_of IS NULL THEN 0 ELSE 1 END,
        'standaloneCount', CASE WHEN r.v2_mirror_of IS NULL THEN 1 ELSE 0 END);
    END IF;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'acquisition_terms_not_effective' USING ERRCODE = '55000'; END IF;
  IF n <> 1 THEN RAISE EXCEPTION 'acquisition_terms_ambiguous' USING ERRCODE = '55000'; END IF;
  IF (selected->>'kind' = 'legacy_pair' AND legacy_count <> 1)
    OR (selected->>'kind' = 'v2_standalone' AND legacy_count <> 0) THEN
    RAISE EXCEPTION 'acquisition_terms_ambiguous' USING ERRCODE = '55000';
  END IF;
  RETURN selected || jsonb_build_object('nextBoundaryAt', CASE WHEN boundary IS NULL THEN NULL
    ELSE to_char(boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_subscription_acquisition_terms(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_subscription_acquisition_terms(timestamptz) TO service_role;
