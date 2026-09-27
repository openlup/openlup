-- pgTAP: fail-closed assignment readiness and legacy-money invariants.

BEGIN;

INSERT INTO public.catalog_products (
  id, slug, status, name, description, ingredients, allergens, marketing_content
) VALUES (
  'f2200000-0000-0000-0000-000000000001', 'readiness-lamb', 'active',
  'Readiness Lamb', 'Readiness fixture', ARRAY['lamb'], ARRAY['lamb'], '{}'::jsonb
);
INSERT INTO public.catalog_skus (
  id, product_id, sku, title, pet_type, status, net_weight_g,
  format_code, unit_form_code, kcal_per_unit, feeding_grams_per_unit,
  is_addon, sellable_standalone, sellable_in_subscription,
  requires_pet_profile, min_order_qty
) VALUES (
  'f2300000-0000-0000-0000-000000000001',
  'f2200000-0000-0000-0000-000000000001',
  'OPENLUP-DOG-READINESS-CAN-400G', 'Readiness Lamb', 'dog', 'active', 400,
  'can', 'can', 492, 400, false, true, true, false, 1
);
INSERT INTO public.price_lists (id, name, region_code, currency, status)
VALUES ('f2400000-0000-0000-0000-000000000001', 'readiness_pl', 'PL', 'PLN', 'active');
INSERT INTO public.price_entries (
  price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active
) VALUES
  ('f2400000-0000-0000-0000-000000000001', 'f2300000-0000-0000-0000-000000000001', 'one_time', 1, 1490, 'gross', true),
  ('f2400000-0000-0000-0000-000000000001', 'f2300000-0000-0000-0000-000000000001', 'subscription', 1, 1340, 'gross', true);

INSERT INTO public.promotions (
  code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, applies_to_payload, stacking_rule,
  eligibility, redemption_limit_per_customer, status
) VALUES (
  NULL, 'First Subscription 50%', 'automatic', 'percentage', 44.404,
  'order_total', '{"cart_mode":"subscription"}'::jsonb, 'exclusive',
  '{"first_subscription_purchase":true}'::jsonb, 1, 'active'
);
INSERT INTO public.promotions (
  code, name, trigger_type, discount_type, discount_value,
  applies_to_kind, applies_to_payload, stacking_rule, eligibility, status,
  benefit_lane, benefit_kind, benefit_value_bps
) VALUES (
  NULL, 'Fixture bundle', 'automatic', 'percentage', 5,
  'order_total', '{"cart_mode":"one_time"}'::jsonb, 'stackable_with_any',
  '{"min_cart_minor":12000}'::jsonb, 'active', 'product', 'percentage', 500
);

INSERT INTO public.platform_job_controls (
  job_name, enabled, last_status, last_success_at, metadata
) VALUES
  ('platform-watchdog', true, 'success', statement_timestamp(),
    '{"promotionReady":true}'::jsonb),
  ('promotion-claim-sweep', true, 'success', statement_timestamp(), '{}'::jsonb)
ON CONFLICT (job_name) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  last_status = EXCLUDED.last_status,
  last_success_at = EXCLUDED.last_success_at,
  metadata = public.platform_job_controls.metadata || EXCLUDED.metadata;

SELECT plan(54);

SELECT has_function(
  'public', 'commerce_offer_policy_v2_readiness', ARRAY[]::text[],
  'offer-policy v2 readiness RPC exists'
);
SELECT function_privs_are(
  'public', 'commerce_offer_policy_v2_readiness', ARRAY[]::text[], 'service_role',
  ARRAY['EXECUTE'], 'service_role alone can execute readiness'
);
SELECT function_privs_are(
  'public', 'commerce_offer_policy_v2_readiness', ARRAY[]::text[], 'anon',
  ARRAY[]::text[], 'anon cannot execute readiness'
);
SELECT function_privs_are(
  'public', 'commerce_offer_policy_v2_readiness', ARRAY[]::text[], 'authenticated',
  ARRAY[]::text[], 'authenticated cannot execute readiness'
);
SELECT has_function(
  'public', 'commerce_capture_offer_policy_v2_legacy_baseline', ARRAY[]::text[],
  'legacy cohort baseline capture RPC exists'
);
SELECT function_privs_are(
  'public', 'commerce_capture_offer_policy_v2_legacy_baseline', ARRAY[]::text[],
  'service_role', ARRAY['EXECUTE'], 'service_role alone can capture the baseline'
);
SELECT function_privs_are(
  'public', 'commerce_capture_offer_policy_v2_legacy_baseline', ARRAY[]::text[],
  'anon', ARRAY[]::text[], 'anon cannot capture the baseline'
);

CREATE TEMP TABLE _readiness_paused AS
SELECT public.commerce_offer_policy_v2_readiness() AS snapshot;

SELECT is(
  (SELECT snapshot->>'contractVersion' FROM _readiness_paused),
  'commerce-offer-policy-v2-readiness.v1',
  'readiness exposes a versioned closed contract'
);
SELECT is(
  (SELECT snapshot->>'ready' FROM _readiness_paused), 'false',
  'the migration-paused mirror keeps assignment closed'
);
SELECT ok(
  (SELECT snapshot->'reasons' ? 'first_subscription_mirror_not_ready' FROM _readiness_paused),
  'the closed result names the paused mirror reason'
);

UPDATE public.promotions mirror
SET status = 'active'
WHERE mirror.promotion_engine_version = 'promotion-engine.v2'
  AND mirror.v2_mirror_of IS NOT NULL
  AND mirror.benefit_kind = 'target_percentage'
  AND mirror.benefit_value_bps = 5000;

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'an empty legacy-frozen cohort cannot silently open readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'legacy_frozen_records_invalid',
  'missing legacy baseline evidence emits a closed diagnostic reason'
);

INSERT INTO public.clients (id, email)
VALUES ('f2000000-0000-0000-0000-000000000010', 'readiness-valid-legacy@example.invalid');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status,
  offer_policy_assignment_state
) VALUES (
  'f2100000-0000-0000-0000-000000000010',
  'f2000000-0000-0000-0000-000000000010',
  30, 'PLN', 'active', 'legacy_frozen'
);
INSERT INTO public.subscription_lines (
  id, subscription_id, variant_id, qty, line_metadata
) VALUES (
  'f2600000-0000-0000-0000-000000000010',
  'f2100000-0000-0000-0000-000000000010',
  'f2300000-0000-0000-0000-000000000001', 14,
  '{"productSnapshot":{"quoteLine":{"quantity":14,"unitPriceGross":{"amountMinor":1340,"currency":"PLN"},"lineSubtotalGross":{"amountMinor":18760,"currency":"PLN"}}}}'::jsonb
);
INSERT INTO public.subscription_price_agreements (
  id, subscription_id, subscription_line_id, variant_id, currency,
  unit_price_gross_minor, quote_line, template_version, source_action,
  idempotency_key
) VALUES (
  'f2700000-0000-0000-0000-000000000010',
  'f2100000-0000-0000-0000-000000000010',
  'f2600000-0000-0000-0000-000000000010',
  'f2300000-0000-0000-0000-000000000001', 'PLN', 1340,
  '{"quantity":14,"unitPriceGross":{"amountMinor":1340,"currency":"PLN"},"lineSubtotalGross":{"amountMinor":18760,"currency":"PLN"}}'::jsonb,
  1, 'readiness_fixture', 'readiness-valid-agreement'
);

INSERT INTO public.clients (id, email)
VALUES ('f2000000-0000-0000-0000-000000000011', 'readiness-test-fixture@example.invalid');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status,
  offer_policy_assignment_state, is_test_fixture
) VALUES (
  'f2100000-0000-0000-0000-000000000011',
  'f2000000-0000-0000-0000-000000000011',
  30, 'PLN', 'active', 'legacy_frozen', true
);

SELECT is(
  (SELECT is_test_fixture::text
   FROM public.subscriptions
   WHERE id = 'f2100000-0000-0000-0000-000000000010'),
  'false',
  'real and pre-migration subscriptions remain in the legacy cohort by default'
);
SELECT throws_ok(
  $query$
    UPDATE public.subscriptions
    SET is_test_fixture = true
    WHERE id = 'f2100000-0000-0000-0000-000000000010'
  $query$,
  '23514',
  'subscription_offer_policy_immutable',
  'a persisted customer subscription cannot be relabelled as a test fixture'
);

CREATE TEMP TABLE _legacy_baseline AS
SELECT public.commerce_capture_offer_policy_v2_legacy_baseline() AS snapshot;
SELECT is(
  (SELECT snapshot#>>'{expectedCount}' FROM _legacy_baseline), '1',
  'operator capture freezes the audited legacy cohort count'
);

CREATE TEMP TABLE _readiness_green AS
SELECT public.commerce_offer_policy_v2_readiness() AS snapshot;

SELECT is(
  (SELECT snapshot->>'ready' FROM _readiness_green), 'true',
  'canonical active policy, price, health and legacy evidence is ready'
);
SELECT is(
  (SELECT snapshot#>>'{evidence,priceMismatchCount}' FROM _readiness_green), '0',
  'the canonical 14.90/13.40 band has no mismatches'
);
SELECT is(
  (SELECT snapshot#>>'{evidence,bundlePolicyCount}' FROM _readiness_green), '1',
  'the 5 percent bundle policy is part of readiness'
);
SELECT is(
  (SELECT snapshot#>>'{evidence,legacyFrozenCount}' FROM _readiness_green), '1',
  'canonical legacy-frozen 13.40 line and agreement evidence is counted'
);
SELECT ok(
  NOT (SELECT snapshot->'reasons' ? 'legacy_frozen_records_invalid'
       FROM _readiness_green),
  'an explicitly marked legacy test fixture is excluded from record validation'
);
SELECT ok(
  NOT (SELECT snapshot->'reasons' ? 'legacy_frozen_baseline_mismatch'
       FROM _readiness_green),
  'an explicitly marked legacy test fixture is excluded from baseline membership'
);

-- The subscription band may be DERIVED from a policy revision rather than STORED as its
-- own price row. The three cases below pin all of it: that both representations at once
-- are refused, that the derived one alone carries readiness, and that the derived branch
-- still pins the money rather than merely accepting any revision.

-- 1. Double authority is refused. A revision alongside a still-open stored row would
-- leave the stored row unread by the runtime while the gate certified it as authority.
-- The settlement coordinates are read off the fixture list rather than restated: the
-- revision's (price_list_id, region_code, currency) is a foreign key into exactly that
-- triple, so spelling them again could only ever agree or fail to insert.
INSERT INTO public.subscription_price_policy_revisions (
  id, price_list_id, region_code, currency, channel, revision_no,
  discount_bps, rounding_quantum_minor, rounding_rule, digest, effective_from
)
SELECT 'f2700000-0000-4000-8000-000000000001',
  list.id, list.region_code, list.currency, 'D2C', 1,
  1000, 10, 'FLOOR_TO_QUANTUM', repeat('a', 64),
  statement_timestamp() - interval '1 minute'
FROM public.price_lists list
WHERE list.id = 'f2400000-0000-0000-0000-000000000001';

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'an effective policy revision beside a still-open stored subscription row is not ready'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'catalog_1490_legacy_1340_invalid',
  'two live representations of the same band emit the catalog diagnostic reason'
);

-- 2. Close the stored rows, exactly as the pricing-policy activation does, and the
-- derived branch alone must carry readiness. Asserted GREEN rather than merely not-red:
-- the revisions table has RLS enabled, so a silently empty read would look identical to
-- a wrong predicate if this only checked that the reason had gone.
UPDATE public.price_entries
SET active = false, valid_to = statement_timestamp()
WHERE price_list_id = 'f2400000-0000-0000-0000-000000000001'
  AND mode = 'subscription';

CREATE TEMP TABLE _readiness_derived AS
SELECT public.commerce_offer_policy_v2_readiness() AS snapshot;

SELECT is(
  (SELECT snapshot->>'ready' FROM _readiness_derived), 'true',
  'a revision deriving 13.40 from the pinned 14.90 base is ready with no stored row'
);
SELECT is(
  (SELECT snapshot#>>'{evidence,priceMismatchCount}' FROM _readiness_derived), '0',
  'the derived band leaves no core SKU mismatched'
);
SELECT is(
  (SELECT snapshot#>>'{evidence,subscriptionPricePolicyCount}' FROM _readiness_derived), '1',
  'the effective revision is reported as evidence rather than inferred'
);
SELECT is(
  (SELECT snapshot#>>'{evidence,subscriptionPricePolicyDerivesBand}' FROM _readiness_derived),
  'true',
  'and the evidence names that the revision reaches the pinned band'
);

-- 2b. Another channel's revision on the same price list is NOT this storefront's policy.
-- The runtime resolves policy history with an equality on channel and both unique
-- constraints on the table key on it, so several channels may hold revisions at once.
-- A gate that counted them all would take this count to 2, match neither branch, and
-- close checkout over a policy its own resolver would never read.
INSERT INTO public.subscription_price_policy_revisions (
  id, price_list_id, region_code, currency, channel, revision_no,
  discount_bps, rounding_quantum_minor, rounding_rule, digest, effective_from
)
SELECT 'f2700000-0000-4000-8000-000000000003',
  list.id, list.region_code, list.currency, 'B2B', 1,
  2500, 10, 'FLOOR_TO_QUANTUM', repeat('c', 64),
  statement_timestamp()
FROM public.price_lists list
WHERE list.id = 'f2400000-0000-0000-0000-000000000001';

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'true',
  'a revision on another channel does not close the gate over healthy storefront pricing'
);
SELECT is(
  (public.commerce_offer_policy_v2_readiness()#>>'{evidence,subscriptionPricePolicyCount}'),
  '1',
  'and it is not counted, because the gate counts only the channel the runtime reads'
);

-- 3. The derived branch pins the money, not merely the existence of a revision. A 20%
-- revision derives 11.90 from 14.90, which is not the band this deployment sells.
UPDATE public.subscription_price_policy_revisions
SET effective_to = statement_timestamp()
WHERE id = 'f2700000-0000-4000-8000-000000000001';

INSERT INTO public.subscription_price_policy_revisions (
  id, price_list_id, region_code, currency, channel, revision_no,
  discount_bps, rounding_quantum_minor, rounding_rule, digest, effective_from
)
SELECT 'f2700000-0000-4000-8000-000000000002',
  list.id, list.region_code, list.currency, 'D2C', 2,
  2000, 10, 'FLOOR_TO_QUANTUM', repeat('b', 64),
  statement_timestamp()
FROM public.price_lists list
WHERE list.id = 'f2400000-0000-0000-0000-000000000001';

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a revision that derives a different band closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'catalog_1490_legacy_1340_invalid',
  'a derived band that is not 13.40 emits the catalog diagnostic reason'
);

-- Restore the stored representation for the assertions that follow. The guard trigger
-- permits no DELETE, so the revision is closed rather than removed - which is also the
-- only supported way to retire one in production.
UPDATE public.subscription_price_policy_revisions
SET effective_to = statement_timestamp()
WHERE effective_to IS NULL;
UPDATE public.price_entries
SET active = true, valid_to = NULL
WHERE price_list_id = 'f2400000-0000-0000-0000-000000000001'
  AND mode = 'subscription';

UPDATE public.platform_job_controls
SET last_success_at = statement_timestamp() - interval '7 hours'
WHERE job_name = 'platform-watchdog';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a stale persisted watchdog verdict closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'promotion_watchdog_not_ready',
  'stale watchdog evidence emits a closed diagnostic reason'
);
UPDATE public.platform_job_controls
SET last_success_at = statement_timestamp()
WHERE job_name = 'platform-watchdog';

UPDATE public.platform_job_controls
SET last_status = 'failed'
WHERE job_name = 'promotion-claim-sweep';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a failed claim sweep closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'promotion_claim_sweep_not_ready',
  'failed claim-sweep evidence emits a closed diagnostic reason'
);
UPDATE public.platform_job_controls
SET last_status = 'success', last_success_at = statement_timestamp()
WHERE job_name = 'promotion-claim-sweep';

UPDATE public.promotions
SET region_availability = ARRAY[]::text[]
WHERE name = 'Fixture bundle';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a Bundle 5 region drift closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'bundle_5_policy_invalid',
  'Bundle 5 region drift emits a closed diagnostic reason'
);
UPDATE public.promotions
SET region_availability = ARRAY['PL']::text[]
WHERE name = 'Fixture bundle';

UPDATE public.promotions
SET redemption_limit_global = 1
WHERE name = 'Fixture bundle';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a capped ongoing Bundle 5 policy closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'bundle_5_policy_invalid',
  'Bundle 5 cap drift emits a closed diagnostic reason'
);
UPDATE public.promotions
SET redemption_limit_global = NULL
WHERE name = 'Fixture bundle';

UPDATE public.price_lists
SET valid_from = statement_timestamp() + interval '1 day'
WHERE id = 'f2400000-0000-0000-0000-000000000001';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a future-only active price list closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'catalog_1490_legacy_1340_invalid',
  'price-list validity drift emits a closed diagnostic reason'
);
UPDATE public.price_lists
SET valid_from = statement_timestamp() - interval '1 day'
WHERE id = 'f2400000-0000-0000-0000-000000000001';

UPDATE public.subscription_lines
SET line_metadata = jsonb_set(
  line_metadata,
  '{productSnapshot,quoteLine,unitPriceGross,amountMinor}',
  '1341'::jsonb
)
WHERE id = 'f2600000-0000-0000-0000-000000000010';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a one-grosz legacy line drift closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'legacy_frozen_records_invalid',
  'legacy line drift emits a closed diagnostic reason'
);
UPDATE public.subscription_lines
SET line_metadata = jsonb_set(
  line_metadata,
  '{productSnapshot,quoteLine,unitPriceGross,amountMinor}',
  '1340'::jsonb
)
WHERE id = 'f2600000-0000-0000-0000-000000000010';

UPDATE public.subscription_price_agreements
SET unit_price_gross_minor = 1341
WHERE id = 'f2700000-0000-0000-0000-000000000010';
SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a one-grosz legacy agreement drift closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'legacy_frozen_records_invalid',
  'legacy agreement drift emits a closed diagnostic reason'
);
UPDATE public.subscription_price_agreements
SET unit_price_gross_minor = 1340
WHERE id = 'f2700000-0000-0000-0000-000000000010';

INSERT INTO public.commerce_orders (
  id, status, currency, subtotal_cents, discount_cents, shipping_cents,
  shipping_discount_cents, tax_cents, total_cents, metadata
) VALUES (
  'f2500000-0000-4000-8000-000000000001', 'paid', 'PLN', 1490, 745, 0,
  0, 55, 745,
  jsonb_build_object('quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
    'context', jsonb_build_object('pricingPolicy', jsonb_build_object(
      'offerPolicyVersion', 'commerce.offer-policy.v2',
      'promotionEngineVersion', 'promotion-engine.v2'
    )),
    'subtotalGross', jsonb_build_object('amountMinor', 1490, 'currency', 'PLN'),
    'discountTotalGross', jsonb_build_object('amountMinor', 745, 'currency', 'PLN'),
    'shippingGross', jsonb_build_object('amountMinor', 0, 'currency', 'PLN'),
    'shippingDiscountGross', jsonb_build_object('amountMinor', 0, 'currency', 'PLN'),
    'totalGross', jsonb_build_object('amountMinor', 744, 'currency', 'PLN')
  )))
);

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a frozen automatic-v2 quote/header mismatch closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'automatic_v2_money_invalid',
  'automatic-v2 money drift emits a closed diagnostic reason'
);

DELETE FROM public.commerce_orders
WHERE id = 'f2500000-0000-4000-8000-000000000001';

INSERT INTO public.price_entries (
  price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active
) VALUES (
  'f2400000-0000-0000-0000-000000000001',
  'f2300000-0000-0000-0000-000000000001',
  'one_time', 14, 1290, 'gross', true
);

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'an overriding quantity price tier closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'catalog_1490_legacy_1340_invalid',
  'the quantity-tier drift emits a closed diagnostic reason'
);

DELETE FROM public.price_entries
WHERE price_list_id = 'f2400000-0000-0000-0000-000000000001'
  AND variant_id = 'f2300000-0000-0000-0000-000000000001'
  AND mode = 'one_time' AND min_qty = 14;

UPDATE public.price_entries entry
SET unit_price_minor = 1341
WHERE entry.id = (
  SELECT candidate.id
  FROM public.price_entries candidate
  JOIN public.price_lists list ON list.id = candidate.price_list_id
  JOIN public.catalog_skus sku ON sku.id = candidate.variant_id
  WHERE list.region_code = 'PL' AND list.currency = 'PLN' AND list.status = 'active'
    AND sku.status = 'active' AND sku.is_addon = false
    AND candidate.mode = 'subscription' AND candidate.min_qty = 1 AND candidate.active = true
  ORDER BY candidate.id LIMIT 1
);

SELECT is(
  (public.commerce_offer_policy_v2_readiness()->>'ready'), 'false',
  'a one-grosz recurring band drift closes readiness'
);
SELECT ok(
  public.commerce_offer_policy_v2_readiness()->'reasons' ? 'catalog_1490_legacy_1340_invalid',
  'the price drift emits a closed diagnostic reason'
);

UPDATE public.price_entries entry
SET unit_price_minor = 1340
WHERE entry.mode = 'subscription' AND entry.unit_price_minor = 1341;

INSERT INTO public.clients (id, email)
VALUES ('f2000000-0000-0000-0000-000000000001', 'readiness-legacy@example.invalid');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status,
  offer_policy_assignment_state
) VALUES (
  'f2100000-0000-0000-0000-000000000001',
  'f2000000-0000-0000-0000-000000000001',
  30, 'PLN', 'active', 'legacy_frozen'
);

CREATE TEMP TABLE _readiness_invalid_legacy AS
SELECT public.commerce_offer_policy_v2_readiness() AS snapshot;

SELECT is(
  (SELECT snapshot#>>'{evidence,legacyFrozenInvalidCount}' FROM _readiness_invalid_legacy), '1',
  'a legacy-frozen subscription without its 13.40 lines is invalid'
);
SELECT ok(
  (SELECT snapshot->'reasons' ? 'legacy_frozen_records_invalid' FROM _readiness_invalid_legacy),
  'invalid legacy evidence closes new v2 assignment'
);
SELECT ok(
  (SELECT snapshot->'reasons' ? 'legacy_frozen_baseline_mismatch'
    FROM _readiness_invalid_legacy),
  'a legacy cohort membership change also closes the immutable baseline'
);

SELECT * FROM finish();
ROLLBACK;
