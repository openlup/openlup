-- Native offer-policy inputs. Installation marks the historical cohort only.
-- Baseline capture is a separate, explicitly audited service operation.
-- No catalogue, agreement money, subscription schedule or capability is changed.
-- Read-side helpers never acquire commerce row or advisory locks.

ALTER TABLE public.subscriptions ADD COLUMN offer_policy_version text NOT NULL DEFAULT 'commerce.offer-policy.v1';
ALTER TABLE public.subscriptions ADD COLUMN promotion_engine_version text NOT NULL DEFAULT 'promotion-engine.v1';
ALTER TABLE public.subscriptions ADD COLUMN offer_policy_assignment_state text NOT NULL DEFAULT 'legacy_frozen';
ALTER TABLE public.subscriptions ADD COLUMN is_test_fixture boolean NOT NULL DEFAULT false;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_offer_policy_pair_check CHECK (
 (offer_policy_version='commerce.offer-policy.v1' AND promotion_engine_version='promotion-engine.v1') OR
 (offer_policy_version='commerce.offer-policy.v2' AND promotion_engine_version='promotion-engine.v2')) NOT VALID;
ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_offer_policy_pair_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_offer_policy_assignment_state_check CHECK (
 offer_policy_assignment_state IN ('legacy_frozen','pending_acquisition','assigned_acquisition')) NOT VALID;
ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_offer_policy_assignment_state_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_test_fixture_legacy_only CHECK (
 NOT is_test_fixture OR offer_policy_assignment_state='legacy_frozen') NOT VALID;
ALTER TABLE public.subscriptions VALIDATE CONSTRAINT subscriptions_test_fixture_legacy_only;
ALTER TABLE public.subscriptions ALTER COLUMN offer_policy_assignment_state SET DEFAULT 'pending_acquisition';
CREATE INDEX subscriptions_offer_policy_legacy_cohort ON public.subscriptions(id)
 WHERE offer_policy_assignment_state='legacy_frozen' AND is_test_fixture=false;

CREATE TABLE public.commerce_offer_policy_cohort_marking (
 baseline_key text PRIMARY KEY CHECK (baseline_key='legacy_frozen.v1'), -- gitleaks:allow -- public schema sentinel, not a credential
 marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 marked_count integer NOT NULL CHECK (marked_count BETWEEN 0 AND 2147483647),
 marked_fingerprint text NOT NULL CHECK (length(marked_fingerprint)=32 AND translate(marked_fingerprint,'0123456789abcdef','')=''),
 CHECK (NOT (marked_count=0) OR marked_fingerprint='d41d8cd98f00b204e9800998ecf8427e')
);
ALTER TABLE public.commerce_offer_policy_cohort_marking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_offer_policy_cohort_marking FROM PUBLIC;
-- This evidence records the installation boundary, never the later operator audit.
INSERT INTO public.commerce_offer_policy_cohort_marking (baseline_key,marked_count,marked_fingerprint)
 SELECT 'legacy_frozen.v1',count(*)::integer,md5(COALESCE(string_agg(id::text,'|' ORDER BY id),''))
 FROM public.subscriptions WHERE offer_policy_assignment_state='legacy_frozen' AND is_test_fixture=false;

CREATE TABLE public.commerce_offer_policy_rollout_baselines (
 baseline_key text PRIMARY KEY CHECK (baseline_key='legacy_frozen.v1'), -- gitleaks:allow -- public schema sentinel, not a credential
 expected_count integer NOT NULL CHECK (expected_count BETWEEN 0 AND 2147483647),
 expected_fingerprint text NOT NULL CHECK (length(expected_fingerprint)=32 AND translate(expected_fingerprint,'0123456789abcdef','')=''),
 captured_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT (expected_count=0) OR expected_fingerprint='d41d8cd98f00b204e9800998ecf8427e')
);
ALTER TABLE public.commerce_offer_policy_rollout_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.commerce_offer_policy_rollout_baselines FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_offer_policy_cohort_marking, public.commerce_offer_policy_rollout_baselines FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_offer_policy_cohort_marking, public.commerce_offer_policy_rollout_baselines FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_offer_policy_cohort_marking, public.commerce_offer_policy_rollout_baselines FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT, INSERT ON TABLE public.commerce_offer_policy_rollout_baselines TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY commerce_offer_policy_baselines_service_select ON public.commerce_offer_policy_rollout_baselines FOR SELECT TO service_role USING (true);'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY commerce_offer_policy_baselines_service_insert ON public.commerce_offer_policy_rollout_baselines FOR INSERT TO service_role WITH CHECK (true);'; END IF; END; $$;

CREATE FUNCTION public.subscription_prevent_offer_policy_update() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF (NEW.offer_policy_version,NEW.promotion_engine_version,NEW.offer_policy_assignment_state) IS DISTINCT FROM
    (OLD.offer_policy_version,OLD.promotion_engine_version,OLD.offer_policy_assignment_state) THEN
  IF pg_trigger_depth()>1 AND OLD.offer_policy_assignment_state='pending_acquisition'
   AND NEW.offer_policy_assignment_state='assigned_acquisition' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'subscription_offer_policy_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER subscriptions_offer_policy_immutable BEFORE UPDATE OF offer_policy_version,promotion_engine_version,offer_policy_assignment_state
 ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.subscription_prevent_offer_policy_update();
CREATE FUNCTION public.subscription_prevent_test_fixture_update() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NEW.is_test_fixture IS DISTINCT FROM OLD.is_test_fixture THEN
  RAISE EXCEPTION 'subscription_offer_policy_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER subscriptions_test_fixture_immutable BEFORE UPDATE OF is_test_fixture
 ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.subscription_prevent_test_fixture_update();

-- The invoker trigger uses this read-only owner helper; runtime DML has no access
-- to change marking provenance. A managed twin can express the same ACL with RLS.
CREATE FUNCTION public.catalog_price_setup_assert_zero_baseline(p_count integer,p_fingerprint text) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_count=0 AND (p_fingerprint IS DISTINCT FROM md5('') OR NOT EXISTS (
  SELECT 1 FROM public.commerce_offer_policy_cohort_marking WHERE baseline_key='legacy_frozen.v1' -- gitleaks:allow -- public schema sentinel, not a credential
   AND marked_count=0 AND marked_fingerprint=md5('')) OR EXISTS (
  SELECT 1 FROM public.subscriptions WHERE offer_policy_assignment_state='legacy_frozen' AND is_test_fixture=false)
  OR EXISTS (SELECT 1 FROM public.commerce_offer_policy_rollout_baselines WHERE expected_count>0)) THEN
  RAISE EXCEPTION 'offer_policy_legacy_baseline_empty' USING ERRCODE='22023';
 END IF;
END;
$$;
CREATE FUNCTION public.commerce_offer_policy_baseline_insert_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public.catalog_price_setup_assert_zero_baseline(NEW.expected_count,NEW.expected_fingerprint);
 RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_offer_policy_baseline_insert_guard BEFORE INSERT
 ON public.commerce_offer_policy_rollout_baselines FOR EACH ROW EXECUTE FUNCTION public.commerce_offer_policy_baseline_insert_guard();
CREATE FUNCTION public.commerce_capture_offer_policy_v2_legacy_baseline()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
  v_fingerprint text;
  v_inserted boolean := false;
  v_baseline public.commerce_offer_policy_rollout_baselines%ROWTYPE;
BEGIN
  SELECT count(*)::integer,
    md5(COALESCE(string_agg(subscription.id::text, '|' ORDER BY subscription.id), ''))
  INTO v_count, v_fingerprint
  FROM public.subscriptions subscription
  WHERE subscription.offer_policy_assignment_state = 'legacy_frozen'
    AND subscription.is_test_fixture = false;

  IF v_count = 0 AND NOT EXISTS (SELECT 1 FROM public.commerce_offer_policy_cohort_marking
    WHERE baseline_key='legacy_frozen.v1' AND marked_count=0 AND marked_fingerprint=md5('')) THEN -- gitleaks:allow -- public schema sentinel, not a credential
    RAISE EXCEPTION 'offer_policy_legacy_baseline_empty' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.commerce_offer_policy_rollout_baselines (
    baseline_key, expected_count, expected_fingerprint
  ) VALUES ('legacy_frozen.v1', v_count, v_fingerprint)
  ON CONFLICT (baseline_key) DO NOTHING
  RETURNING * INTO v_baseline;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT * INTO STRICT v_baseline
    FROM public.commerce_offer_policy_rollout_baselines
    WHERE baseline_key = 'legacy_frozen.v1'; -- gitleaks:allow -- public schema sentinel, not a credential
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'commerce-offer-policy-v2-legacy-baseline.v1',
    'created', v_inserted,
    'expectedCount', v_baseline.expected_count,
    'expectedFingerprint', v_baseline.expected_fingerprint,
    'capturedAt', v_baseline.captured_at
  );
END;
$$;



-- Validate complete consumed scalar domains before any selector or cast. Optional
-- source scalar columns retain SQL NULL semantics; JSONB null stays a JSON value.
CREATE FUNCTION public.catalog_price_setup_assert_promotion(d jsonb,p_id text) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v numeric;
BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000';
 END IF;
 IF jsonb_typeof(d->'applies_to_kind') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF NOT (d ? 'applies_to_payload') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'benefit_kind' IS NOT NULL AND d->'benefit_kind'<>'null'::jsonb AND (jsonb_typeof(d->'benefit_kind') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'benefit_lane' IS NOT NULL AND d->'benefit_lane'<>'null'::jsonb AND (jsonb_typeof(d->'benefit_lane') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'benefit_value_bps' IS NOT NULL AND d->'benefit_value_bps'<>'null'::jsonb AND (jsonb_typeof(d->'benefit_value_bps') IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'benefit_value_minor' IS NOT NULL AND d->'benefit_value_minor'<>'null'::jsonb AND (jsonb_typeof(d->'benefit_value_minor') IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'code' IS NOT NULL AND d->'code'<>'null'::jsonb AND (jsonb_typeof(d->'code') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'discount_type') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'discount_value') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF NOT (d ? 'eligibility') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'promotion_engine_version') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'redemption_limit_global' IS NOT NULL AND d->'redemption_limit_global'<>'null'::jsonb AND (jsonb_typeof(d->'redemption_limit_global') IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'redemption_limit_global' IS NOT NULL AND d->'redemption_limit_global'<>'null'::jsonb THEN v:=(d->>'redemption_limit_global')::numeric; IF v<>trunc(v) OR v NOT BETWEEN -2147483648 AND 2147483647 THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF; END IF;
 IF d->'redemption_limit_per_customer' IS NOT NULL AND d->'redemption_limit_per_customer'<>'null'::jsonb AND (jsonb_typeof(d->'redemption_limit_per_customer') IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'redemption_limit_per_customer' IS NOT NULL AND d->'redemption_limit_per_customer'<>'null'::jsonb THEN v:=(d->>'redemption_limit_per_customer')::numeric; IF v<>trunc(v) OR v NOT BETWEEN -2147483648 AND 2147483647 THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF; END IF;
 IF jsonb_typeof(d->'region_availability') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'region_availability') e WHERE jsonb_typeof(e) NOT IN ('string','null')) THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'stacking_rule') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'status') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'trigger_type') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'v2_mirror_of' IS NOT NULL AND d->'v2_mirror_of'<>'null'::jsonb AND (jsonb_typeof(d->'v2_mirror_of') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'valid_from') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'valid_from' IS NOT NULL AND d->'valid_from'<>'null'::jsonb AND (NOT pg_input_is_valid(d->>'valid_from','timestamp with time zone') OR (d->>'valid_from' NOT IN ('infinity','-infinity') AND d->>'valid_from' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$')) THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'valid_to' IS NOT NULL AND d->'valid_to'<>'null'::jsonb AND (jsonb_typeof(d->'valid_to') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF d->'valid_to' IS NOT NULL AND d->'valid_to'<>'null'::jsonb AND (NOT pg_input_is_valid(d->>'valid_to','timestamp with time zone') OR (d->>'valid_to' NOT IN ('infinity','-infinity') AND d->>'valid_to' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$')) THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(d->'id') IS DISTINCT FROM 'string' OR d->>'id' IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'trigger_type')::text IN ('coupon_code', 'automatic', 'referral'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'discount_type')::text IN ('percentage', 'fixed_amount', 'free_shipping'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'discount_value')::numeric >= 0)) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'applies_to_kind')::text IN ('order_total', 'line_with_variant', 'line_with_category'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'stacking_rule')::text IN ('exclusive', 'stackable_with_any', 'stackable_with_loyalty'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'redemption_limit_global')::numeric::integer IS NULL OR (d->>'redemption_limit_global')::numeric::integer > 0)) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'redemption_limit_per_customer')::numeric::integer IS NULL OR (d->>'redemption_limit_per_customer')::numeric::integer > 0)) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'status')::text IN ('draft', 'active', 'paused', 'archived'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'valid_to')::timestamptz IS NULL OR (d->>'valid_to')::timestamptz > (d->>'valid_from')::timestamptz)) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF ((
    ((d->>'trigger_type')::text = 'coupon_code' AND (d->>'code')::text IS NOT NULL) OR
    ((d->>'trigger_type')::text IN ('automatic', 'referral') AND (d->>'code')::text IS NULL)
  )) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'benefit_lane')::text IN ('product', 'shipping'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF (((d->>'benefit_kind')::text IN ('target_percentage', 'percentage', 'fixed_amount', 'free_shipping'))) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 IF ((
      ((d->>'benefit_kind')::text = 'target_percentage'
        AND (d->>'benefit_value_bps')::numeric BETWEEN 1 AND 9999
        AND (d->>'benefit_value_bps')::numeric = trunc((d->>'benefit_value_bps')::numeric)
        AND (d->>'benefit_value_minor')::numeric IS NULL)
      OR ((d->>'benefit_kind')::text = 'percentage' AND (d->>'benefit_value_minor')::numeric IS NULL AND (
        ((d->>'promotion_engine_version')::text='promotion-engine.v1'
          AND ((d->>'benefit_value_bps')::numeric IS NULL OR (d->>'benefit_value_bps')::numeric >= 0))
        OR ((d->>'promotion_engine_version')::text<>'promotion-engine.v1'
          AND (d->>'benefit_value_bps')::numeric BETWEEN 1 AND 9999
          AND (d->>'benefit_value_bps')::numeric = trunc((d->>'benefit_value_bps')::numeric))
      ))
      OR ((d->>'benefit_kind')::text = 'fixed_amount' AND (d->>'benefit_value_bps')::numeric IS NULL AND (
        ((d->>'promotion_engine_version')::text='promotion-engine.v1'
          AND ((d->>'benefit_value_minor')::numeric IS NULL OR (d->>'benefit_value_minor')::numeric >= 0))
        OR ((d->>'promotion_engine_version')::text<>'promotion-engine.v1'
          AND (d->>'benefit_value_minor')::numeric > 0
          AND (d->>'benefit_value_minor')::numeric <= 2147483647
          AND (d->>'benefit_value_minor')::numeric = trunc((d->>'benefit_value_minor')::numeric))
      ))
      OR ((d->>'benefit_kind')::text = 'free_shipping' AND (d->>'benefit_lane')::text = 'shipping' AND (d->>'benefit_value_bps')::numeric IS NULL AND (d->>'benefit_value_minor')::numeric IS NULL)
    )) IS FALSE THEN RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000'; END IF;
 -- Legacy coupon-derived fields are evidence, never repaired here.
 IF d->>'trigger_type'='coupon_code' AND d->>'promotion_engine_version'='promotion-engine.v1' THEN
  v:=(d->>'discount_value')::numeric;
  IF d->>'benefit_lane' IS DISTINCT FROM (CASE WHEN d->>'discount_type'='free_shipping' THEN 'shipping' ELSE 'product' END)
   OR d->>'benefit_kind' IS DISTINCT FROM (CASE WHEN d->>'discount_type'='percentage' THEN 'percentage' WHEN d->>'discount_type'='fixed_amount' THEN 'fixed_amount' ELSE 'free_shipping' END)
   OR (d->>'benefit_value_bps')::numeric IS DISTINCT FROM (CASE WHEN d->>'discount_type'='percentage' AND v<=90071992547409.91 AND v*100=trunc(v*100) THEN v*100 ELSE NULL END)
   OR (d->>'benefit_value_minor')::numeric IS DISTINCT FROM (CASE WHEN d->>'discount_type'='fixed_amount' AND v<=9007199254740991 AND v=trunc(v) THEN v ELSE NULL END) THEN
   RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000';
  END IF;
 END IF;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_promotions() RETURNS TABLE (
 applies_to_kind text,
 applies_to_payload jsonb,
 benefit_kind text,
 benefit_lane text,
 benefit_value_bps numeric,
 benefit_value_minor numeric,
 code text,
 discount_type text,
 discount_value numeric,
 eligibility jsonb,
 id text,
 promotion_engine_version text,
 redemption_limit_global integer,
 redemption_limit_per_customer integer,
 region_availability text[],
 stacking_rule text,
 status text,
 trigger_type text,
 v2_mirror_of text,
 valid_from timestamptz,
 valid_to timestamptz)
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE row_input record; d jsonb;
BEGIN
 FOR row_input IN SELECT * FROM public.commerce_promotion_definitions LOOP
  d:=row_input.definition; PERFORM public.catalog_price_setup_assert_promotion(d,row_input.promotion_id);
  RETURN QUERY SELECT (d->>'applies_to_kind')::text,d->'applies_to_payload',(d->>'benefit_kind')::text,(d->>'benefit_lane')::text,(d->>'benefit_value_bps')::numeric,(d->>'benefit_value_minor')::numeric,(d->>'code')::text,(d->>'discount_type')::text,(d->>'discount_value')::numeric,d->'eligibility',row_input.promotion_id,(d->>'promotion_engine_version')::text,(d->>'redemption_limit_global')::numeric::integer,(d->>'redemption_limit_per_customer')::numeric::integer,ARRAY(SELECT jsonb_array_elements_text(d->'region_availability')),(d->>'stacking_rule')::text,CASE WHEN row_input.active THEN d->>'status' ELSE 'paused' END,(d->>'trigger_type')::text,(d->>'v2_mirror_of')::text,(d->>'valid_from')::timestamptz,(d->>'valid_to')::timestamptz;
 END LOOP;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_assert_promotion_links() RETURNS void
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.catalog_price_setup_promotions() p WHERE p.v2_mirror_of IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM public.commerce_promotion_definitions parent WHERE parent.promotion_id=p.v2_mirror_of))
  OR EXISTS (SELECT 1 FROM public.catalog_price_setup_promotions() p WHERE p.code IS NOT NULL GROUP BY p.code HAVING count(*)>1)
  OR EXISTS (SELECT 1 FROM public.catalog_price_setup_promotions() p WHERE p.v2_mirror_of IS NOT NULL GROUP BY p.v2_mirror_of HAVING count(*)>1) THEN
  RAISE EXCEPTION 'catalog_price_setup_native_promotion_domain_unverified' USING ERRCODE='55000';
 END IF;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_region_code() RETURNS text
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result text;
BEGIN
 SELECT value_text INTO result FROM public.commerce_settings WHERE key='settlement_region';
 IF result IS NULL OR result !~ '^[A-Z]{2}$' THEN
  RAISE EXCEPTION 'catalog_price_setup_settlement_context_unverified' USING ERRCODE='55000';
 END IF;
 RETURN result;
END;
$$;
CREATE FUNCTION public.catalog_price_setup_settlement_currency() RETURNS text
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result text;
BEGIN
 SELECT value_text INTO result FROM public.commerce_settings WHERE key='settlement_currency';
 IF result IS NULL OR result !~ '^[A-Z]{3}$' THEN
  RAISE EXCEPTION 'catalog_price_setup_settlement_context_unverified' USING ERRCODE='55000';
 END IF;
 RETURN result;
END;
$$;
CREATE FUNCTION public.catalog_price_setup_acquisition_metadata(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE m jsonb := p_payload->'acquisitionTerms';
BEGIN
  IF NOT (p_payload ? 'acquisitionTerms') THEN RETURN NULL; END IF;
  IF jsonb_typeof(m) IS DISTINCT FROM 'object'
    OR m - ARRAY['schemaVersion','revision','delivery2DiscountBps'] <> '{}'::jsonb
    OR m->>'schemaVersion' IS DISTINCT FROM 'subscription-acquisition.v1'
    OR jsonb_typeof(m->'revision') IS DISTINCT FROM 'string'
    OR m->>'revision' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    OR jsonb_typeof(m->'delivery2DiscountBps') IS DISTINCT FROM 'number'
    OR m->>'delivery2DiscountBps' !~ '^(0|[1-9][0-9]{0,4})(\.0+)?$'
    OR (m->>'delivery2DiscountBps')::numeric > 10000 THEN
    RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN m;
END;
$$;
CREATE FUNCTION public.catalog_price_setup_acquisition_terms(p_at timestamptz DEFAULT statement_timestamp())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record; legacy record;
  m jsonb; selected jsonb; n integer := 0; configured boolean;
  previous_end timestamptz; boundary timestamptz; legacy_count integer := 0; seen text[] := ARRAY[]::text[]; region text := public.catalog_price_setup_region_code();
BEGIN
  PERFORM public.catalog_price_setup_assert_promotion_links();
  IF p_at IS NULL THEN RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023'; END IF;
  SELECT EXISTS(SELECT FROM public.catalog_price_setup_promotions() p WHERE p.status = 'active' AND region = ANY(p.region_availability)
    AND p.applies_to_payload ? 'acquisitionTerms') INTO configured;
  FOR r IN SELECT * FROM public.catalog_price_setup_promotions() p
    WHERE region = ANY(p.region_availability) AND p.status = 'active'
      AND (p.applies_to_payload ? 'acquisitionTerms' OR
        (p.trigger_type = 'automatic' AND p.code IS NULL AND p.discount_type = 'percentage'
          AND p.applies_to_kind = 'order_total' AND p.stacking_rule = 'exclusive'
          AND p.eligibility = '{"first_subscription_purchase":true}'::jsonb))
    ORDER BY p.valid_from, p.id
  LOOP
    m := public.catalog_price_setup_acquisition_metadata(r.applies_to_payload);
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
      IF (SELECT count(*) FROM public.catalog_price_setup_promotions() mirror
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
      SELECT * INTO legacy FROM public.catalog_price_setup_promotions() WHERE id = r.v2_mirror_of;
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

CREATE FUNCTION public.catalog_price_setup_bundle_policy_count(p_at timestamptz) RETURNS bigint
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result bigint; region text:=public.catalog_price_setup_region_code();
BEGIN
 PERFORM public.catalog_price_setup_assert_promotion_links();
 IF p_at IS NULL THEN RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO result
  FROM public.catalog_price_setup_promotions() bundle
  WHERE bundle.promotion_engine_version = 'promotion-engine.v1'
    AND bundle.v2_mirror_of IS NULL
    AND bundle.trigger_type = 'automatic'
    AND bundle.code IS NULL
    AND bundle.discount_type = 'percentage'
    AND bundle.discount_value = 5
    AND bundle.applies_to_kind = 'order_total'
    AND bundle.applies_to_payload = '{"cart_mode":"one_time"}'::jsonb
    AND bundle.stacking_rule = 'stackable_with_any'
    AND bundle.eligibility = '{"min_cart_minor":12000}'::jsonb
    AND bundle.status = 'active'
    AND bundle.benefit_lane = 'product'
    AND bundle.benefit_kind = 'percentage'
    AND bundle.benefit_value_bps = 500
    AND bundle.redemption_limit_global IS NULL
    AND bundle.redemption_limit_per_customer IS NULL
    AND region = ANY(bundle.region_availability)
    AND bundle.valid_from <= p_at
    AND (bundle.valid_to IS NULL OR bundle.valid_to >= p_at);
 RETURN result;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_cohort_evidence() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer; fingerprint text; baseline public.commerce_offer_policy_rollout_baselines%ROWTYPE;
 marking public.commerce_offer_policy_cohort_marking%ROWTYPE;
BEGIN
 SELECT * INTO marking FROM public.commerce_offer_policy_cohort_marking WHERE baseline_key='legacy_frozen.v1'; -- gitleaks:allow -- public schema sentinel, not a credential
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_price_setup_native_cohort_unverified' USING ERRCODE='55000'; END IF;
 SELECT count(*)::integer,md5(COALESCE(string_agg(id::text,'|' ORDER BY id),'')) INTO n,fingerprint
  FROM public.subscriptions WHERE offer_policy_assignment_state='legacy_frozen' AND is_test_fixture=false;
 SELECT * INTO baseline FROM public.commerce_offer_policy_rollout_baselines WHERE baseline_key='legacy_frozen.v1'; -- gitleaks:allow -- public schema sentinel, not a credential
 IF NOT FOUND OR n<>baseline.expected_count OR fingerprint<>baseline.expected_fingerprint
  OR (n=0 AND (marking.marked_count<>0 OR marking.marked_fingerprint<>md5('') OR baseline.expected_fingerprint<>md5(''))) THEN
  RAISE EXCEPTION 'catalog_price_setup_native_cohort_unverified' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('count',n,'fingerprint',fingerprint,'capturedAt',baseline.captured_at);
END;
$$;

CREATE FUNCTION public.catalog_price_setup_order_policy_pair(p_metadata jsonb) RETURNS void
 LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE offer text:=COALESCE(p_metadata#>>'{quoteSnapshot,quote,context,pricingPolicy,offerPolicyVersion}','commerce.offer-policy.v1');
 engine text:=COALESCE(p_metadata#>>'{quoteSnapshot,quote,context,pricingPolicy,promotionEngineVersion}','promotion-engine.v1');
BEGIN
 IF NOT ((offer='commerce.offer-policy.v1' AND engine='promotion-engine.v1') OR
         (offer='commerce.offer-policy.v2' AND engine='promotion-engine.v2')) THEN
  RAISE EXCEPTION 'catalog_price_setup_native_order_policy_pair_unverified' USING ERRCODE='55000';
 END IF;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_policy_digest(p_id uuid,p_revision_no integer,p_price_list_id uuid,
 p_region_code text,p_currency text,p_channel text,p_effective_from timestamptz,p_effective_to timestamptz,
 p_discount_bps integer,p_rounding_quantum_minor integer,p_rounding_rule text) RETURNS text
 LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
 SELECT encode(sha256(convert_to(format(
  '{"schemaVersion":"subscription-price-policy.v1","id":"%s","revisionNo":%s,"priceListId":"%s","regionCode":"%s","currency":"%s","channel":"%s","effectiveFrom":"%s","effectiveTo":%s,"discountBps":%s,"roundingQuantumMinor":%s,"roundingRule":"%s"}',
  p_id,p_revision_no,p_price_list_id,p_region_code,p_currency,p_channel,
  to_char(p_effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CASE WHEN p_effective_to IS NULL THEN 'null' ELSE '"'||to_char(p_effective_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'"' END,
  p_discount_bps,p_rounding_quantum_minor,p_rounding_rule),'UTF8')),'hex')
$$;

CREATE FUNCTION public.catalog_price_setup_assert_catalog_inputs() RETURNS void
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 -- The native typed constraints supply scalar presence, ranges, keys and FKs.
 -- The source composite entry uniqueness is additionally checked explicitly.
 IF EXISTS (SELECT 1 FROM public.price_entries GROUP BY price_list_id,variant_id,mode,min_qty,valid_from HAVING count(*)>1) THEN
  RAISE EXCEPTION 'catalog_price_setup_native_price_domain_unverified' USING ERRCODE='55000';
 END IF;
 IF EXISTS (SELECT 1 FROM public.subscription_price_policy_revisions p WHERE p.digest IS DISTINCT FROM
  public.catalog_price_setup_policy_digest(p.id,p.revision_no,p.price_list_id,p.region_code,p.currency,p.channel,p.effective_from,
   CASE WHEN p.closed_from_open THEN NULL ELSE p.effective_to END,p.discount_bps,p.rounding_quantum_minor,p.rounding_rule)) THEN
  RAISE EXCEPTION 'catalog_price_setup_native_policy_domain_unverified' USING ERRCODE='55000';
 END IF;
END;
$$;

-- Native retained terms replace the source agreement record layout. This reads
-- the same governing purchase/edit evidence as renewal and the sized editor.
-- It never invents an agreement ID, historical timestamp or line metadata.
CREATE FUNCTION public.catalog_price_setup_agreement_evidence() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record; l record; prices jsonb; quote jsonb; price jsonb; governing_metadata jsonb;
 source_event_id uuid; source_event_type text; order_backed_event boolean;
 line_count integer; matches integer; fingerprint text:='';
BEGIN
 FOR s IN SELECT * FROM public.subscriptions WHERE offer_policy_assignment_state='legacy_frozen' AND is_test_fixture=false ORDER BY id LOOP
  IF s.currency_code IS NULL OR char_length(s.currency_code)<>3 OR s.price_list_id IS NULL THEN
   RAISE EXCEPTION 'catalog_price_setup_native_agreement_domain_unverified' USING ERRCODE='55000';
  END IF;
  prices:=NULL;
  SELECT e.id,e.event_type INTO source_event_id,source_event_type FROM public.subscription_events e WHERE e.subscription_id=s.id
   AND e.event_type IN ('subscription.starter_graduated','subscription.customer_self_service.update_package_template',
    'subscription.customer_self_service.swap_base_line','subscription.customer_self_service.add_addon',
    'subscription.customer_self_service.remove_addon','subscription.customer_self_service.update_addon_quantity',
    'subscription.customer_self_service.update_plan_length','subscription.customer_self_service.update_base_mix',
    'subscription.customer_self_service.update_portion','subscription.customer_self_service.resize_bundle',
    'subscription.customer_self_service.update_bundle') ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1;
  -- Only these producers quote every desired line afresh. Sized edits can retain
  -- earlier agreement quotes; graduation copies retained purchase terms.
  order_backed_event:=source_event_type IS NOT NULL AND source_event_type NOT IN
   ('subscription.customer_self_service.update_package_template','subscription.customer_self_service.swap_base_line');
  IF source_event_id IS NOT NULL AND NOT order_backed_event THEN
   SELECT e.payload->'linePricing' INTO prices FROM public.subscription_events e WHERE e.id=source_event_id;
  END IF;
  IF prices IS NULL THEN
   -- Both retained renewal quote lines and activation quote lines are order-backed.
   -- Their governing order must be checked before projecting either source, even
   -- outside the recent-order window. Copied/merged event quotes keep that provenance.
   SELECT o.metadata INTO governing_metadata FROM (
    SELECT a.order_id,0 AS priority FROM public.subscription_renewal_attachments a
     WHERE a.subscription_id=s.id AND a.completed_at IS NOT NULL
      AND (order_backed_event OR a.purchase_facts#>'{renewalTerms,linePricing}' IS NOT NULL)
    UNION ALL SELECT a.order_id,1 FROM public.subscription_activations a WHERE a.subscription_id=s.id
   ) source JOIN public.commerce_orders o ON o.id=source.order_id ORDER BY source.priority LIMIT 1;
   IF NOT FOUND THEN
    IF order_backed_event THEN
     RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE='55000';
    END IF;
    RAISE EXCEPTION 'catalog_price_setup_native_agreement_domain_unverified' USING ERRCODE='55000';
   END IF;
   PERFORM public.catalog_price_setup_order_policy_pair(governing_metadata);
   -- No native attestation establishes the historical admission of this order.
   -- Current quote bytes or a valid pair cannot substitute for that evidence.
   RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE='55000';
  END IF;
  IF jsonb_typeof(prices) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'catalog_price_setup_native_agreement_domain_unverified' USING ERRCODE='55000';
  END IF;
  line_count:=0;
  FOR l IN SELECT line.*,sku.sku FROM public.subscription_lines line JOIN public.catalog_skus sku ON sku.id=line.variant_id
   WHERE line.subscription_id=s.id ORDER BY line.id LOOP
   line_count:=line_count+1;
   SELECT count(*) INTO matches FROM jsonb_array_elements(prices) v WHERE v->>'sku'=l.sku;
   IF matches<>1 OR l.unit_price_minor NOT BETWEEN 0 AND 2147483647 OR l.currency_code<>s.currency_code THEN
    RAISE EXCEPTION 'catalog_price_setup_native_agreement_domain_unverified' USING ERRCODE='55000';
   END IF;
   SELECT v INTO price FROM jsonb_array_elements(prices) v WHERE v->>'sku'=l.sku;
   quote:=price->'quoteLine';
   IF jsonb_typeof(quote) IS DISTINCT FROM 'object'
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_term_lines t WHERE t.subscription_id=s.id AND t.sku=l.sku
     AND t.quantity=l.quantity AND t.unit_amount_minor=l.unit_price_minor)
    OR price->'quantity' IS DISTINCT FROM to_jsonb(l.quantity)
    OR price->'unitAmountMinor' IS DISTINCT FROM to_jsonb(l.unit_price_minor)
    OR quote->>'sku' IS DISTINCT FROM l.sku OR quote->'quantity' IS DISTINCT FROM to_jsonb(l.quantity)
    OR quote#>'{unitPriceGross,amountMinor}' IS DISTINCT FROM to_jsonb(l.unit_price_minor)
    OR quote#>>'{unitPriceGross,currency}' IS DISTINCT FROM l.currency_code
    OR quote#>>'{lineSubtotalGross,currency}' IS DISTINCT FROM l.currency_code
    OR quote#>'{lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb(l.quantity::bigint*l.unit_price_minor)
    OR (price ? 'isAddon' AND price->'isAddon' IS DISTINCT FROM to_jsonb(l.is_addon)) THEN
    RAISE EXCEPTION 'catalog_price_setup_native_agreement_domain_unverified' USING ERRCODE='55000';
   END IF;
   fingerprint:=fingerprint||s.id::text||':'||l.id::text||':'||l.quantity::text||':'||l.unit_price_minor::text||':'||quote::text||'|';
  END LOOP;
  IF line_count=0 THEN RAISE EXCEPTION 'catalog_price_setup_native_agreement_domain_unverified' USING ERRCODE='55000'; END IF;
 END LOOP;
 RETURN jsonb_build_object('fingerprint',md5(fingerprint));
END;
$$;

CREATE FUNCTION public.catalog_price_setup_order_inputs(p_order_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.commerce_orders%ROWTYPE; subtotal numeric; discount numeric; shipping numeric; shipping_discount numeric;
 allocated numeric; item_count integer;
BEGIN
 SELECT * INTO o FROM public.commerce_orders WHERE id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog_price_setup_native_order_domain_unverified' USING ERRCODE='55000'; END IF;
 -- This pair is required even for a one-time order, before selecting an engine.
 PERFORM public.catalog_price_setup_order_policy_pair(o.metadata);
 SELECT count(*),sum(COALESCE(catalog_line_amount_minor,line_amount_minor)),sum(COALESCE(promotion_discount_allocated_minor,0))
  INTO item_count,subtotal,allocated FROM public.commerce_order_items WHERE order_id=o.id;
 SELECT COALESCE(sum(amount_minor) FILTER(WHERE kind='promotion_discount' AND scope<>'shipping'),0),
  COALESCE(sum(amount_minor) FILTER(WHERE kind='shipping_charge'),0),
  COALESCE(sum(amount_minor) FILTER(WHERE kind='promotion_discount' AND scope='shipping'),0)
  INTO discount,shipping,shipping_discount FROM public.commerce_order_adjustments WHERE order_id=o.id;
 IF EXISTS(SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=o.id
  AND (i.source_line_ordinal IS NOT NULL OR i.catalog_unit_amount_minor IS NOT NULL OR i.catalog_line_amount_minor IS NOT NULL
   OR i.promotion_discount_allocated_minor IS NOT NULL OR i.promotion_allocation_fingerprint IS NOT NULL)
  AND NOT COALESCE(i.source_line_ordinal>0 AND i.catalog_unit_amount_minor>=0
   AND i.catalog_line_amount_minor=i.catalog_unit_amount_minor::numeric*i.quantity
   AND i.promotion_discount_allocated_minor BETWEEN 0 AND i.catalog_line_amount_minor
   AND i.line_amount_minor::numeric+i.promotion_discount_allocated_minor=i.catalog_line_amount_minor
   AND i.promotion_allocation_fingerprint ~ '^[0-9a-f]{64}$',false)) THEN
  RAISE EXCEPTION 'catalog_price_setup_native_order_domain_unverified' USING ERRCODE='55000';
 END IF;
 IF item_count=0 OR o.currency_code IS NULL OR char_length(o.currency_code)<>3 OR o.total_amount_minor IS NULL
  OR subtotal NOT BETWEEN 0 AND 2147483647 OR discount NOT BETWEEN 0 AND 2147483647
  OR shipping NOT BETWEEN 0 AND 2147483647 OR shipping_discount NOT BETWEEN 0 AND shipping
  OR o.total_amount_minor NOT BETWEEN 0 AND 2147483647 OR discount>subtotal
  OR allocated<>discount OR o.total_amount_minor<>subtotal-discount+shipping-shipping_discount THEN
  RAISE EXCEPTION 'catalog_price_setup_native_order_domain_unverified' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('id',o.id,'currency',o.currency_code,'subtotal',subtotal,'discount',discount,
  'shipping',shipping,'shippingDiscount',shipping_discount,'total',o.total_amount_minor);
END;
$$;

CREATE FUNCTION public.catalog_price_setup_order_offer_version(p_quote_snapshot jsonb) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v jsonb:=p_quote_snapshot#>'{quote,context,offerVersion}';
BEGIN
 IF v IS NULL OR jsonb_typeof(v)='null' THEN RETURN 'classic'; END IF;
 IF jsonb_typeof(v)='string' AND v#>>'{}' IN ('classic','sized.v1') THEN RETURN v#>>'{}'; END IF;
 RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE='55000';
END;
$$;

CREATE FUNCTION public.catalog_price_setup_assert_order_guards(p_at timestamptz) RETURNS void
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o record;
BEGIN
 IF p_at IS NULL THEN RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE='55000'; END IF;
 FOR o IN SELECT * FROM public.commerce_orders WHERE created_at>=p_at-interval '24 hours' AND created_at<=p_at
  AND status IN ('paid','fulfillment_pending','fulfilled','refunded') LOOP
  PERFORM public.catalog_price_setup_order_policy_pair(o.metadata);
  IF EXISTS(SELECT 1 FROM public.commerce_promotion_claims WHERE order_id=o.id) THEN
   RAISE EXCEPTION 'catalog_price_setup_native_order_claim_guard_unverified' USING ERRCODE='55000';
  END IF;
  IF o.metadata#>>'{quoteSnapshot,quote,context,pricingPolicy,promotionEngineVersion}'='promotion-engine.v2' THEN
   RAISE EXCEPTION 'catalog_price_setup_native_order_guard_unverified' USING ERRCODE='55000';
  END IF;
  -- Native current metadata, status, SKU membership and publication heads do not
  -- attest INSERT-time applicability or the acquisition-only parser boundary.
  -- Do not invoke a locking admission writer or reparse a later renewal here.
  RAISE EXCEPTION 'catalog_price_setup_native_order_admission_unverified' USING ERRCODE='55000';
 END LOOP;
END;
$$;

CREATE FUNCTION public.catalog_price_setup_readiness_inputs() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE at_time timestamptz:=statement_timestamp(); cohort jsonb; agreements jsonb; acquisition jsonb;
 acquisition_reason text; region text; currency text;
BEGIN
 region:=public.catalog_price_setup_region_code(); currency:=public.catalog_price_setup_settlement_currency();
 PERFORM public.catalog_price_setup_assert_promotion_links();
 PERFORM public.catalog_price_setup_assert_catalog_inputs();
 cohort:=public.catalog_price_setup_cohort_evidence();
 agreements:=public.catalog_price_setup_agreement_evidence();
 PERFORM public.catalog_price_setup_assert_order_guards(at_time);
 BEGIN acquisition:=public.catalog_price_setup_acquisition_terms(at_time);
 EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '55000' THEN
  GET STACKED DIAGNOSTICS acquisition_reason=MESSAGE_TEXT;
  IF acquisition_reason NOT IN ('acquisition_terms_invalid','acquisition_terms_ambiguous','acquisition_terms_not_effective') THEN RAISE; END IF;
 END;
 RETURN jsonb_build_object('checkedAt',at_time,'region',region,'currency',currency,'cohort',cohort,
  'agreements',agreements,'acquisition',acquisition,'acquisitionReason',acquisition_reason,
  'bundlePolicyCount',public.catalog_price_setup_bundle_policy_count(at_time));
END;
$$;


-- Internal inputs stay unbound. Only the separately audited capture and the
-- zero-baseline read guard are callable through service authority.
REVOKE ALL ON FUNCTION public.subscription_prevent_offer_policy_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_prevent_test_fixture_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_assert_zero_baseline(integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_offer_policy_baseline_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_capture_offer_policy_v2_legacy_baseline() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_assert_promotion(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_promotions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_assert_promotion_links() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_region_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_settlement_currency() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_acquisition_metadata(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_acquisition_terms(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_bundle_policy_count(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_cohort_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_order_policy_pair(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_policy_digest(uuid,integer,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_assert_catalog_inputs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_agreement_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_order_inputs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_assert_order_guards(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_order_offer_version(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_price_setup_readiness_inputs() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_prevent_offer_policy_update(), public.subscription_prevent_test_fixture_update(), public.catalog_price_setup_assert_zero_baseline(integer,text), public.commerce_offer_policy_baseline_insert_guard(), public.commerce_capture_offer_policy_v2_legacy_baseline(), public.catalog_price_setup_assert_promotion(jsonb,text), public.catalog_price_setup_promotions(), public.catalog_price_setup_assert_promotion_links(), public.catalog_price_setup_region_code(), public.catalog_price_setup_settlement_currency(), public.catalog_price_setup_acquisition_metadata(jsonb), public.catalog_price_setup_acquisition_terms(timestamptz), public.catalog_price_setup_bundle_policy_count(timestamptz), public.catalog_price_setup_cohort_evidence(), public.catalog_price_setup_order_policy_pair(jsonb), public.catalog_price_setup_policy_digest(uuid,integer,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text), public.catalog_price_setup_assert_catalog_inputs(), public.catalog_price_setup_agreement_evidence(), public.catalog_price_setup_order_inputs(uuid), public.catalog_price_setup_assert_order_guards(timestamptz), public.catalog_price_setup_order_offer_version(jsonb), public.catalog_price_setup_readiness_inputs() FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_prevent_offer_policy_update(), public.subscription_prevent_test_fixture_update(), public.catalog_price_setup_assert_zero_baseline(integer,text), public.commerce_offer_policy_baseline_insert_guard(), public.commerce_capture_offer_policy_v2_legacy_baseline(), public.catalog_price_setup_assert_promotion(jsonb,text), public.catalog_price_setup_promotions(), public.catalog_price_setup_assert_promotion_links(), public.catalog_price_setup_region_code(), public.catalog_price_setup_settlement_currency(), public.catalog_price_setup_acquisition_metadata(jsonb), public.catalog_price_setup_acquisition_terms(timestamptz), public.catalog_price_setup_bundle_policy_count(timestamptz), public.catalog_price_setup_cohort_evidence(), public.catalog_price_setup_order_policy_pair(jsonb), public.catalog_price_setup_policy_digest(uuid,integer,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text), public.catalog_price_setup_assert_catalog_inputs(), public.catalog_price_setup_agreement_evidence(), public.catalog_price_setup_order_inputs(uuid), public.catalog_price_setup_assert_order_guards(timestamptz), public.catalog_price_setup_order_offer_version(jsonb), public.catalog_price_setup_readiness_inputs() FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_prevent_offer_policy_update(), public.subscription_prevent_test_fixture_update(), public.catalog_price_setup_assert_zero_baseline(integer,text), public.commerce_offer_policy_baseline_insert_guard(), public.commerce_capture_offer_policy_v2_legacy_baseline(), public.catalog_price_setup_assert_promotion(jsonb,text), public.catalog_price_setup_promotions(), public.catalog_price_setup_assert_promotion_links(), public.catalog_price_setup_region_code(), public.catalog_price_setup_settlement_currency(), public.catalog_price_setup_acquisition_metadata(jsonb), public.catalog_price_setup_acquisition_terms(timestamptz), public.catalog_price_setup_bundle_policy_count(timestamptz), public.catalog_price_setup_cohort_evidence(), public.catalog_price_setup_order_policy_pair(jsonb), public.catalog_price_setup_policy_digest(uuid,integer,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text), public.catalog_price_setup_assert_catalog_inputs(), public.catalog_price_setup_agreement_evidence(), public.catalog_price_setup_order_inputs(uuid), public.catalog_price_setup_assert_order_guards(timestamptz), public.catalog_price_setup_order_offer_version(jsonb), public.catalog_price_setup_readiness_inputs() FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_capture_offer_policy_v2_legacy_baseline(), public.catalog_price_setup_assert_zero_baseline(integer,text) TO service_role;'; END IF; END; $$;
