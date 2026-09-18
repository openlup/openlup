-- pgTAP: Self-service D1 — plan-length resize + recipe-mix edit (20260612220000).
--   * update_recipe_mix rewrites the recipe set (replace-all: DELETE every recipe, INSERT the
--     desired set, lock each fresh quoteLine), keyed by variant_id; addons untouched
--   * update_recipe_mix DELETEs recipes dropped from the desired set
--   * update_recipe_mix fails closed when the desired total != current recipe total (anti-tamper)
--   * update_plan_length couples cadence_days + size_constraint.value AND preserves
--     dailyKcalOverride, rescales recipe qtys, and re-locks addon prices (repricedLines)
--   * the optimistic template_version guard rejects a stale edit
--
-- Recipe rows are replace-all, so their ids change each edit — assertions query by variant_id.
-- The RPC stores BFF-supplied recipeLines/repricedLines verbatim (opaque quoteLine fixtures).
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(34);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44440000-0000-0000-0000-0000000000d1', 'd1-lamb', 'Lamb', 'active'),
  ('44440000-0000-0000-0000-0000000000d2', 'd1-beef', 'Beef', 'active'),
  ('44440000-0000-0000-0000-0000000000d3', 'd1-salmon', 'Salmon', 'active'),
  ('44440000-0000-0000-0000-0000000000d4', 'd1-venison', 'Venison', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55551000-0000-0000-0000-000000000001', '44440000-0000-0000-0000-0000000000d1', 'D1-LAMB', 'Lamb', 'dog', 400, 492, 'active'),
  ('55551000-0000-0000-0000-000000000002', '44440000-0000-0000-0000-0000000000d2', 'D1-BEEF', 'Beef', 'dog', 400, 492, 'active'),
  ('55551000-0000-0000-0000-000000000003', '44440000-0000-0000-0000-0000000000d3', 'D1-SALMON', 'Salmon', 'dog', 400, 492, 'active'),
  ('55551000-0000-0000-0000-000000000004', '44440000-0000-0000-0000-0000000000d4', 'D1-VENISON', 'Venison', 'dog', 400, 492, 'active');

INSERT INTO auth.users (id) VALUES ('a0000000-0000-0000-0000-0000000000d1');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c0000000-0000-0000-0000-0000000000d1', 'd1@example.invalid', 'a0000000-0000-0000-0000-0000000000d1');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref, size_constraint)
VALUES ('5b001000-0000-0000-0000-0000000000d1', 'c0000000-0000-0000-0000-0000000000d1', 28, 'PLN', 'active',
        '2026-09-01T00:00:00Z', 1, 24, 'pm_test_d1',
        '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb);

-- Two recipes (total 8 cans) + one addon (must stay untouched by recipe-set edits).
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51111000-0000-0000-0000-000000000001', '5b001000-0000-0000-0000-0000000000d1', '55551000-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51111000-0000-0000-0000-000000000002', '5b001000-0000-0000-0000-0000000000d1', '55551000-0000-0000-0000-000000000002', 4, 2, false, 1, '{}'::jsonb),
  ('51111000-0000-0000-0000-000000000003', '5b001000-0000-0000-0000-0000000000d1', '55551000-0000-0000-0000-000000000003', 1, 3, true,  1, '{}'::jsonb);

CREATE OR REPLACE FUNCTION pg_temp.seed_subscription_quote_preview(
  p_action text,
  p_quote_hash text,
  p_template_version integer,
  p_request_payload jsonb,
  p_quote_snapshot jsonb,
  p_totals jsonb DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.subscription_quote_previews (
    subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
    expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
  ) VALUES (
    '5b001000-0000-0000-0000-0000000000d1', 'c0000000-0000-0000-0000-0000000000d1',
    'a0000000-0000-0000-0000-0000000000d1', p_action, p_quote_hash, p_template_version,
    '2026-06-12T00:30:00Z'::timestamptz, p_request_payload, p_quote_snapshot, p_totals,
    '{"source":"pgtap"}'::jsonb, '2026-06-11T23:55:00Z'::timestamptz, '2026-06-11T23:55:00Z'::timestamptz
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- The MOQ / cadence blocks below all lock the same two-item package, so the
-- accepted line array is built once here instead of respelled in every payload.
CREATE OR REPLACE FUNCTION pg_temp.d1_locked_package(p_lamb integer, p_beef integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', p_lamb, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',p_lamb,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', p_beef, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',p_beef,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
    ),
    'addonLines', jsonb_build_array()
  );
$$;

-- Every price in this fixture is minor units in the subscription's own currency;
-- the helper keeps the MOQ / cadence blocks below readable instead of repeating
-- the same two-key money object a dozen times.
CREATE OR REPLACE FUNCTION pg_temp.d1_money(p_amount_minor integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('amountMinor', p_amount_minor, 'currency', 'PLN');
$$;

-- ===== update_recipe_mix: LAMB 4 + BEEF 4 -> LAMB 3 + BEEF 3 + VENISON 2 (total stays 8) =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_recipe_mix',
  repeat('a', 64),
  1,
  jsonb_build_object('action', 'update_recipe_mix', 'recipes', jsonb_build_array(
    jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 3),
    jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3),
    jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
  )),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 3, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',3)),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',3)),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
    )
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-mix-idem-0001', '5b001000-0000-0000-0000-0000000000d1', 'update_recipe_mix',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('a', 64),
    'expectedTemplateVersion', 1,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 3),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
    ),
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 3, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',3)),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',3)),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2))
    ),
    'repricedLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
    )
  ),
  '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000001' AND is_addon=false),
  3, 'D1: recipe_mix updated LAMB qty');
SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000004' AND is_addon=false),
  2, 'D1: recipe_mix inserted the new VENISON recipe');
SELECT is((SELECT line_metadata #>> '{productSnapshot,quoteLine,sku}' FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000004' AND is_addon=false),
  'D1-VENISON', 'D1: recipe_mix locked the new line price');
SELECT is((SELECT qty FROM public.subscription_lines WHERE id='51111000-0000-0000-0000-000000000003'),
  1, 'D1: recipe_mix left the addon untouched');
SELECT is((SELECT count(*)::int FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND is_addon=false),
  3, 'D1: recipe_mix recipe count = 3');

-- ===== update_recipe_mix: collapse to LAMB only (total still 8) -> BEEF + VENISON deleted =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_recipe_mix',
  repeat('b', 64),
  2,
  jsonb_build_object('action', 'update_recipe_mix', 'recipes', jsonb_build_array(
    jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8)
  )),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',8))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
    )
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-mix-idem-0002', '5b001000-0000-0000-0000-0000000000d1', 'update_recipe_mix',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('b', 64),
    'expectedTemplateVersion', 2,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8)
    ),
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',8))
    ),
    'repricedLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
    )
  ),
  '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT count(*)::int FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000002' AND is_addon=false),
  0, 'D1: recipe_mix deleted the dropped BEEF recipe');
SELECT is((SELECT count(*)::int FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND is_addon=false),
  1, 'D1: recipe_mix recipe set is now just LAMB');
SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000001' AND is_addon=false),
  8, 'D1: recipe_mix moved the whole pool onto LAMB');

-- ===== update_recipe_mix drift rejects a tampered accepted recipe set =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_recipe_mix',
  repeat('3', 64),
  3,
  jsonb_build_object('action', 'update_recipe_mix', 'recipes', jsonb_build_array(
    jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8)
  )),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',8))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
    )
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000d1', 'd1-mix-drift-1', '5b001000-0000-0000-0000-0000000000d1', 'update_recipe_mix',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('3', 64),
      'expectedTemplateVersion', 3,
      'recipes', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 7)
      ),
      'recipeLines', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 7, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',7))
      ),
      'repricedLines', jsonb_build_array(
        jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
      )
    ),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'D1: recipe_mix accepted quote rejects a tampered recipe request');
SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000001' AND is_addon=false),
  8, 'D1: recipe_mix drift leaves the recipe quantity unchanged');

-- ===== update_recipe_mix rejects a changed total (anti-tamper) =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_recipe_mix',
  repeat('c', 64),
  3,
  jsonb_build_object('action', 'update_recipe_mix', 'recipes', jsonb_build_array(
    jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 2)
  )),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',2))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
    )
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000d1', 'd1-mix-idem-bad1', '5b001000-0000-0000-0000-0000000000d1', 'update_recipe_mix',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('c', 64),
      'expectedTemplateVersion', 3,
      'recipes', jsonb_build_array(jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 2)),
      'recipeLines', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',2))
      ),
      'repricedLines', jsonb_build_array(
        jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1))
      )
    ),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_recipe_total_mismatch',
  'D1: recipe_mix fails closed when the total changes');

-- ===== update_plan_length: 28 -> 14, recipe rescaled, dailyKcalOverride preserved, addon re-locked =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_plan_length',
  repeat('d', 64),
  3,
  jsonb_build_object('action', 'update_plan_length', 'planDays', 14),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 5, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',5))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',999)))
    )
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-plan-idem-0001', '5b001000-0000-0000-0000-0000000000d1', 'update_plan_length',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('d', 64),
    'expectedTemplateVersion', 3,
    'planDays', 14,
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 5, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',5))
    ),
    'repricedLines', jsonb_build_array(
      jsonb_build_object('lineId', '51111000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','D1-SALMON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',999)))
    )
  ),
  '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  14, 'D1: plan_length set cadence_days');
SELECT is((SELECT size_constraint->>'value' FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  '14', 'D1: plan_length set size_constraint.value');
SELECT is((SELECT size_constraint->>'dailyKcalOverride' FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  '300', 'D1: plan_length preserved dailyKcalOverride');
SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000001' AND is_addon=false),
  5, 'D1: plan_length rescaled the recipe qty');
SELECT is((SELECT line_metadata #>> '{productSnapshot,quoteLine,unitPriceGross,amountMinor}' FROM public.subscription_lines WHERE id='51111000-0000-0000-0000-000000000003'),
  '999', 'D1: plan_length re-locked the addon price');

-- ===== update_package_template drift rejects tampered recurring totals =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_package_template',
  repeat('6', 64),
  4,
  jsonb_build_object(
    'action', 'update_package_template',
    'planDays', 21,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2)
    ),
    'addons', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
    )
  ),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',12,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1300)))
    )
  ),
  jsonb_build_object(
    'currentRecurringPrice', jsonb_build_object('amountMinor', 9999, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 2301, 'currency', 'PLN')
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000d1', 'd1-package-drift-1', '5b001000-0000-0000-0000-0000000000d1', 'update_package_template',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('6', 64),
      'expectedTemplateVersion', 4,
      'planDays', 21,
      'currentRecurringPrice', jsonb_build_object('amountMinor', 9999, 'currency', 'PLN'),
      'newRecurringPrice', jsonb_build_object('amountMinor', 12301, 'currency', 'PLN'),
      'delta', jsonb_build_object('amountMinor', 2301, 'currency', 'PLN'),
      'recipes', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12),
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2)
      ),
      'addons', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
      ),
      'recipeLines', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',12,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
      ),
      'addonLines', jsonb_build_array(
        jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1300)))
      )
    ),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'D1: package_template accepted quote rejects tampered recurring totals');
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  14, 'D1: package_template drift leaves cadence_days unchanged');

-- ===== update_package_template: one accepted quote atomically rewrites recipes + addons =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_package_template',
  repeat('a', 64),
  4,
  jsonb_build_object(
    'action', 'update_package_template',
    'planDays', 21,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2)
    ),
    'addons', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
    )
  ),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',12,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1300)))
    )
  ),
  jsonb_build_object(
    'currentRecurringPrice', jsonb_build_object('amountMinor', 9999, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 2301, 'currency', 'PLN')
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-package-idem-0001', '5b001000-0000-0000-0000-0000000000d1', 'update_package_template',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('a', 64),
    'expectedTemplateVersion', 4,
    'planDays', 21,
    'currentRecurringPrice', jsonb_build_object('amountMinor', 9999, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 2301, 'currency', 'PLN'),
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2)
    ),
    'addons', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
    ),
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 12, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',12,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1300)))
    )
  ),
  '2026-06-12T00:00:00Z'::timestamptz);

SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  21, 'D1: package_template set cadence_days');
SELECT is((SELECT count(*)::int FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND is_addon=false),
  2, 'D1: package_template replaced recipe set');
SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000004' AND is_addon=true),
  2, 'D1: package_template replaced addon set');
SELECT is((SELECT line_metadata #>> '{productSnapshot,quoteLine,unitPriceGross,amountMinor}' FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000002' AND is_addon=false),
  '1200', 'D1: package_template locked recipe quoteLine');
SELECT is((SELECT count(*)::int FROM public.subscription_price_agreements
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND source_action='update_package_template'),
  3, 'D1: package_template wrote price agreements for all future lines');
SELECT is((SELECT event_type FROM public.subscription_events
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND idempotency_key='d1-package-idem-0001'),
  'subscription.customer_self_service.update_package_template', 'D1: package_template emitted a self-service event');

-- ===== legacy package mix-only edit: nominal plan and delivery cadence stay split =====
UPDATE public.subscriptions
SET cadence_days = 30,
    size_constraint = '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb
WHERE id = '5b001000-0000-0000-0000-0000000000d1';
SELECT pg_temp.seed_subscription_quote_preview(
  'update_package_template', repeat('f', 64), 5,
  jsonb_build_object(
    'action', 'update_package_template', 'planDays', 30, 'nominalPlanDays', 14,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 11),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3)
    ),
    'addons', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
    )
  ),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 11, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',11,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1300)))
    )
  ),
  jsonb_build_object(
    'currentRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 0, 'currency', 'PLN')
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-package-split-0001', '5b001000-0000-0000-0000-0000000000d1', 'update_package_template',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('f', 64), 'expectedTemplateVersion', 5,
    'planDays', 30, 'nominalPlanDays', 99,
    'currentRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 12300, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 0, 'currency', 'PLN'),
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 11),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3)
    ),
    'addons', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2)
    ),
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 11, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',11,'unitPriceGross',jsonb_build_object('amountMinor',1100))),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','D1-BEEF','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',1200)))
    ),
    'addonLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','D1-VENISON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',1300)))
    )
  ),
  '2026-06-12T00:00:00Z'::timestamptz);
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  30, 'D1: mix-only package edit preserves extended delivery cadence');
SELECT is((SELECT size_constraint->>'value' FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  '14', 'D1: mix-only package edit restores quote-locked nominal plan');
SELECT results_eq(
  $$
    SELECT line->>'variant_id', (line->>'qty')::integer
    FROM jsonb_array_elements(
      public.subscription_current_template_snapshot('5b001000-0000-0000-0000-0000000000d1')->'lines'
    ) AS line
    WHERE (line->>'is_addon')::boolean = false
    ORDER BY line->>'variant_id'
  $$,
  $$ VALUES ('D1-BEEF'::text, 3), ('D1-LAMB'::text, 11) $$,
  'D1: renewal template readback preserves the accepted custom recipe quantities'
);

-- ===== package_template: the RPC enforces the 14-unit minimum order quantity =====
-- The wrapper runs before delegation, so no accepted preview is needed to prove
-- a sub-minimum payload can never reach the mutation body.
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000d1', 'd1-package-moq-low', '5b001000-0000-0000-0000-0000000000d1', 'update_package_template',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('9', 64), 'expectedTemplateVersion', 6, 'planDays', 30
    ) || pg_temp.d1_locked_package(8, 5),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_below_minimum_order_units',
  'D1: package_template rejects a 13-unit line set');

-- ===== package_template: exactly 14 units still applies =====
SELECT pg_temp.seed_subscription_quote_preview(
  'update_package_template', repeat('7', 64), 6,
  jsonb_build_object(
    'action', 'update_package_template', 'planDays', 30, 'nominalPlanDays', 14,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 6)
    ),
    'addons', jsonb_build_array()
  ),
  pg_temp.d1_locked_package(8, 6),
  jsonb_build_object(
    'currentRecurringPrice', pg_temp.d1_money(12300),
    'newRecurringPrice', pg_temp.d1_money(14000),
    'delta', pg_temp.d1_money(1700)
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-package-moq-ok', '5b001000-0000-0000-0000-0000000000d1', 'update_package_template',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('7', 64), 'expectedTemplateVersion', 6,
    'planDays', 30, 'nominalPlanDays', 14,
    'currentRecurringPrice', pg_temp.d1_money(12300),
    'newRecurringPrice', pg_temp.d1_money(14000),
    'delta', pg_temp.d1_money(1700),
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 6)
    ),
    'addons', jsonb_build_array()
  ) || pg_temp.d1_locked_package(8, 6),
  '2026-06-12T00:00:00Z'::timestamptz);
SELECT is((SELECT sum(qty)::integer FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND is_addon=false),
  14, 'D1: package_template applies a 14-unit line set at the minimum');
SELECT is((SELECT qty FROM public.subscription_lines
            WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND variant_id='55551000-0000-0000-0000-000000000002' AND is_addon=false),
  6, 'D1: package_template stored the requested per-line quantity');

-- ===== package_template: a cadence-only change keeps every requested quantity =====
-- B3: the editor used to reroute a plan change through the sizing resize lever, so the
-- customer was quoted (and charged for) a different can count than the review screen
-- showed. The new semantics move cadence_days + the nominal plan stamp only.
UPDATE public.subscriptions
SET cadence_days = 14,
    size_constraint = '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb
WHERE id = '5b001000-0000-0000-0000-0000000000d1';
SELECT pg_temp.seed_subscription_quote_preview(
  'update_package_template', repeat('8', 64), 7,
  jsonb_build_object(
    'action', 'update_package_template', 'planDays', 21, 'nominalPlanDays', 21,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 6)
    ),
    'addons', jsonb_build_array()
  ),
  pg_temp.d1_locked_package(8, 6),
  jsonb_build_object(
    'currentRecurringPrice', pg_temp.d1_money(14000),
    'newRecurringPrice', pg_temp.d1_money(14000),
    'delta', pg_temp.d1_money(0)
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a0000000-0000-0000-0000-0000000000d1', 'd1-package-cadence-only', '5b001000-0000-0000-0000-0000000000d1', 'update_package_template',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('8', 64), 'expectedTemplateVersion', 7,
    'planDays', 21, 'nominalPlanDays', 21,
    'currentRecurringPrice', pg_temp.d1_money(14000),
    'newRecurringPrice', pg_temp.d1_money(14000),
    'delta', pg_temp.d1_money(0),
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 8),
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000002', 'qty', 6)
    ),
    'addons', jsonb_build_array()
  ) || pg_temp.d1_locked_package(8, 6),
  '2026-06-12T00:00:00Z'::timestamptz);
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  21, 'D1: cadence-only package edit moves the delivery cadence to the selected plan');
SELECT is((SELECT size_constraint->>'value' FROM public.subscriptions WHERE id='5b001000-0000-0000-0000-0000000000d1'),
  '21', 'D1: cadence-only package edit stamps the selected plan as the nominal length');
SELECT results_eq(
  $$
    SELECT variant_id::text, qty
    FROM public.subscription_lines
    WHERE subscription_id='5b001000-0000-0000-0000-0000000000d1' AND is_addon = false
    ORDER BY variant_id
  $$,
  $$ VALUES ('55551000-0000-0000-0000-000000000001'::text, 8), ('55551000-0000-0000-0000-000000000002'::text, 6) $$,
  'D1: cadence-only package edit leaves every requested line quantity untouched'
);

-- ===== optimistic lock: a stale expectedTemplateVersion is rejected =====
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000d1', 'd1-stale-idem-1', '5b001000-0000-0000-0000-0000000000d1', 'update_recipe_mix',
    jsonb_build_object('acceptedQuoteHash', repeat('e', 64), 'expectedTemplateVersion', 999, 'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55551000-0000-0000-0000-000000000001', 'qty', 5, 'quoteLine', jsonb_build_object('sku','D1-LAMB','quantity',5))
    )),
    '2026-06-12T00:00:00Z'::timestamptz) $q$,
  'customer_self_service_stale_edit',
  'D1: optimistic lock rejects a stale edit');

SELECT * FROM finish();
ROLLBACK;
