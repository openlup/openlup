-- pgTAP: generic bundle action aliases (PR-B 12b).
--
-- update_bundle / resize_bundle are additive generic protocol verbs. The legacy
-- action names stay valid aliases and immutable subscription_events.event_type
-- history is preserved, so this test compares outcome-equivalent rows with only
-- action/id fields normalized.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(25);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44445200-0000-0000-0000-000000000001', 'generic-core-a', 'Generic Core A', 'active'),
  ('44445200-0000-0000-0000-000000000002', 'generic-core-b', 'Generic Core B', 'active'),
  ('44445200-0000-0000-0000-000000000003', 'generic-core-c', 'Generic Core C', 'active'),
  ('44445200-0000-0000-0000-000000000004', 'generic-addon', 'Generic Addon', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55555200-0000-0000-0000-000000000001', '44445200-0000-0000-0000-000000000001', 'GEN-A', 'Generic A', 'dog', 400, 492, 'active'),
  ('55555200-0000-0000-0000-000000000002', '44445200-0000-0000-0000-000000000002', 'GEN-B', 'Generic B', 'dog', 400, 492, 'active'),
  ('55555200-0000-0000-0000-000000000003', '44445200-0000-0000-0000-000000000003', 'GEN-C', 'Generic C', 'dog', 400, 492, 'active'),
  ('55555200-0000-0000-0000-000000000004', '44445200-0000-0000-0000-000000000004', 'GEN-ADDON', 'Generic Addon', 'dog', 80, 120, 'active');

INSERT INTO auth.users (id) VALUES ('a5200000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c5200000-0000-0000-0000-000000000001', 'generic-bundle@example.invalid', 'a5200000-0000-0000-0000-000000000001');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref, size_constraint)
VALUES
  ('5b520000-0000-0000-0000-000000000001', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_old_mix', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb),
  ('5b520000-0000-0000-0000-000000000002', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_new_mix', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb),
  ('5b520000-0000-0000-0000-000000000003', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_old_resize', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb),
  ('5b520000-0000-0000-0000-000000000004', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_new_resize', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb),
  ('5b520000-0000-0000-0000-000000000006', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_old_package', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb),
  ('5b520000-0000-0000-0000-000000000007', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_new_package', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb),
  ('5b520000-0000-0000-0000-000000000005', 'c5200000-0000-0000-0000-000000000001', 28, 'PLN', 'active',
   '2026-09-01T00:00:00Z', 1, 24, 'pm_generic_invalid', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb);

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51520000-0000-0000-0000-000000000001', '5b520000-0000-0000-0000-000000000001', '55555200-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000002', '5b520000-0000-0000-0000-000000000001', '55555200-0000-0000-0000-000000000002', 4, 2, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000003', '5b520000-0000-0000-0000-000000000001', '55555200-0000-0000-0000-000000000004', 1, 3, true, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000004', '5b520000-0000-0000-0000-000000000002', '55555200-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000005', '5b520000-0000-0000-0000-000000000002', '55555200-0000-0000-0000-000000000002', 4, 2, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000006', '5b520000-0000-0000-0000-000000000002', '55555200-0000-0000-0000-000000000004', 1, 3, true, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000007', '5b520000-0000-0000-0000-000000000003', '55555200-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000008', '5b520000-0000-0000-0000-000000000003', '55555200-0000-0000-0000-000000000004', 1, 2, true, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000009', '5b520000-0000-0000-0000-000000000004', '55555200-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000010', '5b520000-0000-0000-0000-000000000004', '55555200-0000-0000-0000-000000000004', 1, 2, true, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000013', '5b520000-0000-0000-0000-000000000006', '55555200-0000-0000-0000-000000000001', 7, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000014', '5b520000-0000-0000-0000-000000000006', '55555200-0000-0000-0000-000000000002', 7, 2, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000015', '5b520000-0000-0000-0000-000000000006', '55555200-0000-0000-0000-000000000004', 1, 3, true, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000016', '5b520000-0000-0000-0000-000000000007', '55555200-0000-0000-0000-000000000001', 7, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000017', '5b520000-0000-0000-0000-000000000007', '55555200-0000-0000-0000-000000000002', 7, 2, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000018', '5b520000-0000-0000-0000-000000000007', '55555200-0000-0000-0000-000000000004', 1, 3, true, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000011', '5b520000-0000-0000-0000-000000000005', '55555200-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51520000-0000-0000-0000-000000000012', '5b520000-0000-0000-0000-000000000005', '55555200-0000-0000-0000-000000000004', 1, 2, true, 1, '{}'::jsonb);

CREATE OR REPLACE FUNCTION pg_temp.canonical_bundle_action(p_action text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action
    WHEN 'update_recipe_mix' THEN 'update_bundle'
    WHEN 'update_package_template' THEN 'update_bundle'
    WHEN 'update_plan_length' THEN 'resize_bundle'
    WHEN 'set_portion_mode' THEN 'resize_bundle'
    ELSE p_action
  END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.line_qty_snapshot(p_subscription_id uuid, p_is_addon boolean)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('variantId', variant_id::text, 'qty', qty, 'isAddon', is_addon)
    ORDER BY sort_order, variant_id::text
  ), '[]'::jsonb)
  FROM public.subscription_lines
  WHERE subscription_id = p_subscription_id
    AND is_addon = p_is_addon;
$$;

CREATE OR REPLACE FUNCTION pg_temp.subscription_lines_snapshot(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'variantId', variant_id::text,
      'qty', qty,
      'sortOrder', sort_order,
      'isAddon', is_addon,
      'templateVersion', template_version,
      'lineMetadata', COALESCE(line_metadata, '{}'::jsonb)
    )
    ORDER BY is_addon, sort_order, variant_id::text
  ), '[]'::jsonb)
  FROM public.subscription_lines
  WHERE subscription_id = p_subscription_id;
$$;

CREATE OR REPLACE FUNCTION pg_temp.price_agreements_snapshot(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'variantId', variant_id::text,
      'currency', currency,
      'unitPriceGrossMinor', unit_price_gross_minor,
      'quoteLine', quote_line,
      'templateVersion', template_version,
      'sourceAction', pg_temp.canonical_bundle_action(source_action)
    )
    ORDER BY variant_id::text, template_version, pg_temp.canonical_bundle_action(source_action), quote_line::text
  ), '[]'::jsonb)
  FROM public.subscription_price_agreements
  WHERE subscription_id = p_subscription_id;
$$;

CREATE OR REPLACE FUNCTION pg_temp.canonical_event_payload_inner(p_action text, p_payload jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE pg_temp.canonical_bundle_action(p_action)
    WHEN 'update_bundle' THEN jsonb_strip_nulls(jsonb_build_object('cadenceDays', COALESCE(p_payload->'cadenceDays', p_payload->'planDays')))
    WHEN 'resize_bundle' THEN jsonb_build_object('cadenceDays', COALESCE(p_payload->'cadenceDays', p_payload->'planDays'))
    ELSE COALESCE(p_payload, '{}'::jsonb)
  END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.event_payload_snapshot(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'eventType', 'subscription.customer_self_service.' || pg_temp.canonical_bundle_action(e.payload->>'action'),
    'payload', jsonb_build_object(
      'action', pg_temp.canonical_bundle_action(e.payload->>'action'),
      'payload', pg_temp.canonical_event_payload_inner(e.payload->>'action', e.payload->'payload'),
      'reason', e.payload->'reason',
      'priceAgreementPolicy', e.payload->'priceAgreementPolicy'
    )
  )
  FROM public.subscription_events e
  WHERE e.subscription_id = p_subscription_id
  ORDER BY e.occurred_at DESC, e.id DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION pg_temp.seed_subscription_quote_preview(
  p_subscription_id uuid,
  p_action text,
  p_quote_hash text,
  p_template_version integer,
  p_request_payload jsonb,
  p_quote_snapshot jsonb,
  p_totals jsonb DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_client_id uuid;
BEGIN
  SELECT client_id INTO v_client_id FROM public.subscriptions WHERE id = p_subscription_id;
  INSERT INTO public.subscription_quote_previews (
    subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
    expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
  ) VALUES (
    p_subscription_id, v_client_id, 'a5200000-0000-0000-0000-000000000001', p_action, p_quote_hash, p_template_version,
    '2026-07-10T11:00:00Z'::timestamptz, p_request_payload, p_quote_snapshot, p_totals,
    '{"source":"pgtap"}'::jsonb, '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.observed_quote_line(
  p_sku text,
  p_quantity integer,
  p_unit_amount_minor integer,
  p_observed_at text
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'sku', p_sku,
    'quantity', p_quantity,
    'unitPriceGross', jsonb_build_object('amountMinor', p_unit_amount_minor),
    'catalogFacts', jsonb_build_object(
      'version', 'catalog_facts_v2',
      'skuId', '55555200-0000-4000-8000-000000000001',
      'documentRevisionId', '66665200-0000-4000-8000-000000000001',
      'documentDigest', repeat('d', 64),
      'basePriceEntryId', 'generic-base-price',
      'policyRevisionId', '77775200-0000-4000-8000-000000000001',
      'policyDigest', repeat('e', 64),
      'mode', 'subscription',
      'atTime', p_observed_at,
      'currency', 'AAA',
      'resolvedUnitAmountMinor', p_unit_amount_minor,
      'resolvedLineAmountMinor', p_unit_amount_minor * p_quantity,
      'baseUnitAmountMinor', p_unit_amount_minor
    )
  );
$$;

-- update_recipe_mix alias vs update_bundle.
SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000001', 'update_recipe_mix', repeat('1', 64), 1,
  jsonb_build_object('action', 'update_recipe_mix', 'recipes', jsonb_build_array(
    jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3),
    jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3),
    jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2)
  )),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',110))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-C','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',120)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-old-mix-0001', '5b520000-0000-0000-0000-000000000001', 'update_recipe_mix',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('1', 64), 'expectedTemplateVersion', 1,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2)
    ),
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',110))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-C','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',120)))
    ),
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000003', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000002', 'update_bundle', repeat('2', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'coreLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2)
    ),
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',110))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-C','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',120)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000006', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-new-mix-0001', '5b520000-0000-0000-0000-000000000002', 'update_bundle',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('2', 64), 'expectedTemplateVersion', 1,
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 3, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',3,'unitPriceGross',jsonb_build_object('amountMinor',110))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-C','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',120)))
    ),
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000006', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is(pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000002'), pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000001'), 'update_bundle dual-write matches alias subscription_lines');
SELECT is((SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000002'), (SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000001'), 'update_bundle dual-write matches alias size_constraint');
SELECT is(pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000002'), pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000001'), 'update_bundle dual-write matches alias price agreements');
SELECT is(pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000002'), pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000001'), 'update_bundle dual-write matches alias event payload policy');

-- update_package_template alias vs update_bundle with addonLines rewrite.
SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000006', 'update_package_template', repeat('b', 64), 1,
  jsonb_build_object(
    'action', 'update_package_template',
    'planDays', 28,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5)
    ),
    'addons', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2))
  ),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',9,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',5,'unitPriceGross',jsonb_build_object('amountMinor',110)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  ),
  jsonb_build_object(
    'currentRecurringPrice', jsonb_build_object('amountMinor', 850, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 900, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 50, 'currency', 'PLN')
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-old-package-0001', '5b520000-0000-0000-0000-000000000006', 'update_package_template',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('b', 64), 'expectedTemplateVersion', 1,
    'planDays', 28,
    'recipes', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5)
    ),
    'addons', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2)),
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',9,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',5,'unitPriceGross',jsonb_build_object('amountMinor',110)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',50)))),
    'currentRecurringPrice', jsonb_build_object('amountMinor', 850, 'currency', 'PLN'),
    'newRecurringPrice', jsonb_build_object('amountMinor', 900, 'currency', 'PLN'),
    'delta', jsonb_build_object('amountMinor', 50, 'currency', 'PLN')
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000007', 'update_bundle', repeat('c', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'cadenceDays', 28,
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5)
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2))
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',9,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',5,'unitPriceGross',jsonb_build_object('amountMinor',110)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-new-package-0001', '5b520000-0000-0000-0000-000000000007', 'update_bundle',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('c', 64), 'expectedTemplateVersion', 1,
    'cadenceDays', 28,
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',9,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 5, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',5,'unitPriceGross',jsonb_build_object('amountMinor',110)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2, 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',2,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is(pg_temp.line_qty_snapshot('5b520000-0000-0000-0000-000000000007', true), jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000004', 'qty', 2, 'isAddon', true)), 'update_bundle addonLines rewrite stores requested addon lines');
SELECT is(pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000007'), pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000006'), 'update_bundle addonLines rewrite matches alias subscription_lines');
SELECT is((SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000007'), (SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000006'), 'update_bundle addonLines rewrite matches alias size_constraint');
SELECT is(pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000007'), pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000006'), 'update_bundle addonLines rewrite matches alias price agreements');
SELECT is(pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000007'), pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000006'), 'update_bundle addonLines rewrite matches alias event payload policy');

-- update_plan_length alias vs resize_bundle.
SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000003', 'update_plan_length', repeat('3', 64), 1,
  jsonb_build_object('action', 'update_plan_length', 'planDays', 14),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4, 'quoteLine', pg_temp.observed_quote_line('GEN-A', 4, 100, '2026-09-03T10:00:00+23:00'))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000008', 'quoteLine', pg_temp.observed_quote_line('GEN-ADDON', 1, 50, '2026-09-03T10:00:00+23:00')))
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-old-resize-0001', '5b520000-0000-0000-0000-000000000003', 'update_plan_length',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('3', 64), 'expectedTemplateVersion', 1, 'planDays', 14,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4, 'quoteLine', pg_temp.observed_quote_line('GEN-A', 4, 100, '2026-09-03T10:01:00Z'))),
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000008', 'quoteLine', pg_temp.observed_quote_line('GEN-ADDON', 1, 50, '2026-09-03T10:01:00Z')))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000004', 'resize_bundle', repeat('4', 64), 1,
  jsonb_build_object(
    'action', 'resize_bundle',
    'cadenceDays', 14,
    'resizeLever', jsonb_build_object('kind','planLength','value',14),
    'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4, 'quoteLine', pg_temp.observed_quote_line('GEN-A', 4, 100, '2026-09-03T10:00:00+23:00'))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000010', 'quoteLine', pg_temp.observed_quote_line('GEN-ADDON', 1, 50, '2026-09-03T10:00:00+23:00')))
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-new-resize-0001', '5b520000-0000-0000-0000-000000000004', 'resize_bundle',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('4', 64), 'expectedTemplateVersion', 1,
    'cadenceDays', 14,
    'resizeLever', jsonb_build_object('kind','planLength','value',14),
    'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4, 'quoteLine', pg_temp.observed_quote_line('GEN-A', 4, 100, '2026-09-03T10:01:00Z'))),
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000010', 'quoteLine', pg_temp.observed_quote_line('GEN-ADDON', 1, 50, '2026-09-03T10:01:00Z')))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is(pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000004'), pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000003'), 'resize_bundle dual-write matches alias subscription_lines');
SELECT is((SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000004'), (SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000003'), 'resize_bundle dual-write matches alias size_constraint');
SELECT is(pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000004'), pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000003'), 'resize_bundle dual-write matches alias price agreements');
SELECT is(pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000004'), pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000003'), 'resize_bundle dual-write matches alias event payload policy');

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_recipe_mix', repeat('5', 64), 1,
  jsonb_build_object('action', 'update_recipe_mix', 'recipes', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8))),
  jsonb_build_object(
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5200000-0000-0000-0000-000000000001', 'generic-wrong-action-0001', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('5', 64), 'expectedTemplateVersion', 1,
      'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_not_accepted',
  'generic action cannot accept an alias quote preview');

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_bundle', repeat('7', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8))
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5200000-0000-0000-0000-000000000001', 'generic-rogue-recipe-lines-0001', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('7', 64), 'expectedTemplateVersion', 1,
      'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
      'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000003', 'qty', 99, 'quoteLine', jsonb_build_object('sku','GEN-C','quantity',99,'unitPriceGross',jsonb_build_object('amountMinor',1)))),
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'generic update_bundle rejects rogue recipeLines alongside quote-locked coreLines');

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_bundle', repeat('8', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8))
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5200000-0000-0000-0000-000000000001', 'generic-unquoted-cadence-0001', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('8', 64), 'expectedTemplateVersion', 1,
      'cadenceDays', 14,
      'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb,
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_quote_drift',
  'generic update_bundle rejects cadenceDays added after quote acceptance');

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_bundle', repeat('9', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'compositionConstraint', '{"kind":"petfood.kcal","version":1,"data":{"value":28,"dailyKcalOverride":300}}'::jsonb,
    'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8))
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"petfood.kcal","version":1,"data":{"value":28,"dailyKcalOverride":300}}'::jsonb,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5200000-0000-0000-0000-000000000001', 'generic-envelope-constraint-0001', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('9', 64), 'expectedTemplateVersion', 1,
      'compositionConstraint', '{"kind":"petfood.kcal","version":1,"data":{"value":28,"dailyKcalOverride":300}}'::jsonb,
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_invalid_composition_constraint',
  'generic update_bundle rejects Wave-13 envelope-shaped compositionConstraint');

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_bundle', repeat('6', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'compositionConstraint', '"bad-shape"'::jsonb,
    'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8))
  ),
  jsonb_build_object(
    'compositionConstraint', '"bad-shape"'::jsonb,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5200000-0000-0000-0000-000000000001', 'generic-bad-constraint-0001', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('6', 64), 'expectedTemplateVersion', 1,
      'compositionConstraint', '"bad-shape"'::jsonb,
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 8, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',8,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_invalid_composition_constraint',
  'generic update_bundle rejects non-object compositionConstraint after quote acceptance');

SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_bundle', repeat('a', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9))
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',9,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a5200000-0000-0000-0000-000000000001', 'generic-total-mismatch-0001', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
    jsonb_build_object(
      'acceptedQuoteHash', repeat('a', 64), 'expectedTemplateVersion', 1,
      'compositionConstraint', '{"kind":"feeding_days","value":28,"dailyKcalOverride":300}'::jsonb,
      'coreLines', jsonb_build_array(jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 9, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',9,'unitPriceGross',jsonb_build_object('amountMinor',100)))),
      'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
    ),
    '2026-07-10T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_bundle_total_mismatch',
  'generic update_bundle without cadence change preserves fixed-pool recipe totals');

-- A nominal 14-day feeding plan may have accumulated a 30-day delivery cadence.
-- A mix-only generic update carries cadence=30 and constraint.value=14 separately.
UPDATE public.subscriptions
SET cadence_days = 30,
    size_constraint = '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb
WHERE id = '5b520000-0000-0000-0000-000000000005';
SELECT pg_temp.seed_subscription_quote_preview(
  '5b520000-0000-0000-0000-000000000005', 'update_bundle', repeat('d', 64), 1,
  jsonb_build_object(
    'action', 'update_bundle',
    'cadenceDays', 30,
    'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 4)
    )
  ),
  jsonb_build_object(
    'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb,
    'recipeLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',4,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 4, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',4,'unitPriceGross',jsonb_build_object('amountMinor',110)))
    ),
    'addonLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  )
);
SELECT public.customer_self_service_apply_subscription_action(
  'a5200000-0000-0000-0000-000000000001', 'generic-split-cadence-1', '5b520000-0000-0000-0000-000000000005', 'update_bundle',
  jsonb_build_object(
    'acceptedQuoteHash', repeat('d', 64), 'expectedTemplateVersion', 1,
    'cadenceDays', 30,
    'compositionConstraint', '{"kind":"feeding_days","value":14,"dailyKcalOverride":300}'::jsonb,
    'coreLines', jsonb_build_array(
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000001', 'qty', 4, 'quoteLine', jsonb_build_object('sku','GEN-A','quantity',4,'unitPriceGross',jsonb_build_object('amountMinor',100))),
      jsonb_build_object('variantId', '55555200-0000-0000-0000-000000000002', 'qty', 4, 'quoteLine', jsonb_build_object('sku','GEN-B','quantity',4,'unitPriceGross',jsonb_build_object('amountMinor',110)))
    ),
    'repricedLines', jsonb_build_array(jsonb_build_object('lineId', '51520000-0000-0000-0000-000000000012', 'quoteLine', jsonb_build_object('sku','GEN-ADDON','quantity',1,'unitPriceGross',jsonb_build_object('amountMinor',50))))
  ),
  '2026-07-10T10:00:00Z'::timestamptz);
SELECT is((SELECT cadence_days FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000005'),
  30, 'generic mix-only update_bundle preserves extended cadence');
SELECT is((SELECT size_constraint->>'value' FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000005'),
  '14', 'generic mix-only update_bundle preserves nominal feeding-days constraint');

SELECT isnt(
  jsonb_set(pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000002'), '{0,qty}', '999'::jsonb),
  pg_temp.subscription_lines_snapshot('5b520000-0000-0000-0000-000000000001'),
  'negative control: line snapshot comparator catches qty drift');
SELECT isnt(
  '{"kind":"feeding_days","value":99}'::jsonb,
  (SELECT size_constraint FROM public.subscriptions WHERE id = '5b520000-0000-0000-0000-000000000001'),
  'negative control: size_constraint comparator catches drift');
SELECT isnt(
  jsonb_set(pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000002'), '{0,quoteLine,sku}', '"TAMPERED"'::jsonb),
  pg_temp.price_agreements_snapshot('5b520000-0000-0000-0000-000000000001'),
  'negative control: price agreement comparator catches quoteLine drift');
SELECT isnt(
  jsonb_set(pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000007'), '{payload,payload,cadenceDays}', '999'::jsonb),
  pg_temp.event_payload_snapshot('5b520000-0000-0000-0000-000000000006'),
  'negative control: event payload comparator catches policy drift');

SELECT * FROM finish();
ROLLBACK;
