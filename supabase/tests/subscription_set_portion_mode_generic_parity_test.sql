-- pgTAP (E3): set_portion_mode alias ≡ resize_bundle generic verb.
--
-- The existing subscription_generic_bundle_actions_test.sql proves the dual-write
-- equivalence for the core-mix and package-template aliases (→ update_bundle) and
-- the plan-length alias (→ resize_bundle). It does NOT prove the set_portion_mode
-- (topper/half-plan) → resize_bundle pair, which the Faza-A brief E2 flags as
-- "pokrycie nieudowodnione". This test closes that specific gap.
--
-- Claim: applying the SAME resized core-line set + repriced addon through the
-- alias verb set_portion_mode and through the generic verb resize_bundle on
-- equivalent fixture subscriptions yields identical subscription_lines, identical
-- size_constraint, identical subscription_price_agreements, and equivalent audit
-- rows (event_type differs by alias design — asserted equal after canonicalizing
-- the source_action / event verb and stripping the alias-only request echo).
--
-- NOTE ON REACHABILITY: the reprice/quote-hash itself is computed in the BFF
-- layer above these RPCs (server/domains/customers/*), so this proof pins the
-- money-path persistence equality at the RPC boundary given identical repriced
-- inputs — the same design the existing generic-bundle proof uses.
--
-- KNOWN DIVERGENCE (proven below, tests 7-10): the Wave-5 no-op suppression
-- wrapper (migration 20260711170020) intercepts only the alias verbs
-- (set_portion_mode and the other package-edit aliases). The generic verbs
-- update_bundle / resize_bundle are NOT in its allowlist, so a semantically
-- no-op edit is SUPPRESSED via the alias verb (no template bump, no
-- package_changed email) but APPLIED via the generic verb. Equivalence therefore
-- holds for state-CHANGING edits (tests 1-6) but breaks for no-op edits
-- (tests 7-10). Documented as a KNOWN_GAP in the E2 matrix.
--
-- OSS-readiness note: forced vertical payload vocabulary is hoisted into the
-- pg_temp builders below so each token appears once; fixture currency and
-- species values are neutral placeholders (the proof is value-agnostic).
--
-- Run via the repo pgTAP lane: db reset + test db.
BEGIN;
SELECT plan(12);

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('44446000-0000-0000-0000-000000000001', 'portion-core', 'Portion Core', 'active'),
  ('44446000-0000-0000-0000-000000000002', 'portion-addon', 'Portion Addon', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55556000-0000-0000-0000-000000000001', '44446000-0000-0000-0000-000000000001', 'PORT-CORE', 'Portion Core', 'other', 400, 492, 'active'),
  ('55556000-0000-0000-0000-000000000002', '44446000-0000-0000-0000-000000000002', 'PORT-ADDON', 'Portion Addon', 'other', 80, 120, 'active');

INSERT INTO auth.users (id) VALUES ('a6000000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c6000000-0000-0000-0000-000000000001', 'portion-parity@example.invalid', 'a6000000-0000-0000-0000-000000000001');

-- Legacy flat constraint, built once (portion mode variants merge mode/factor).
CREATE OR REPLACE FUNCTION pg_temp.legacy_constraint(p_mode text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('kind', 'feeding_days', 'value', 28, 'dailyKcalOverride', 300)
    || CASE WHEN p_mode IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object('mode', p_mode, 'portionFactor', CASE p_mode WHEN 'topper' THEN 0.5 ELSE 1 END)
       END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.core_line(p_qty integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('variantId', '55556000-0000-0000-0000-000000000001', 'qty', p_qty,
    'quoteLine', jsonb_build_object('sku', 'PORT-CORE', 'quantity', p_qty, 'unitPriceGross', jsonb_build_object('amountMinor', 100)));
$$;

CREATE OR REPLACE FUNCTION pg_temp.addon_line(p_line_id uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('lineId', p_line_id,
    'quoteLine', jsonb_build_object('sku', 'PORT-ADDON', 'quantity', 1, 'unitPriceGross', jsonb_build_object('amountMinor', 50)));
$$;

-- The alias-side quote snapshot / apply payload carry the legacy core-line key;
-- both builders keep that forced key to a single occurrence each.
CREATE OR REPLACE FUNCTION pg_temp.quote_snapshot(p_qty integer, p_addon_line uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'recipeLines', jsonb_build_array(pg_temp.core_line(p_qty)),
    'addonLines', jsonb_build_array(pg_temp.addon_line(p_addon_line)));
$$;

CREATE OR REPLACE FUNCTION pg_temp.alias_apply_payload(p_hash text, p_mode text, p_qty integer, p_addon_line uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'acceptedQuoteHash', p_hash, 'expectedTemplateVersion', 1, 'portionMode', p_mode,
    'recipeLines', jsonb_build_array(pg_temp.core_line(p_qty)),
    'repricedLines', jsonb_build_array(pg_temp.addon_line(p_addon_line)));
$$;

CREATE OR REPLACE FUNCTION pg_temp.generic_request(p_mode text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'action', 'resize_bundle',
    'resizeLever', jsonb_build_object('kind', 'portionMode', 'value', jsonb_build_object('portionMode', p_mode)),
    'compositionConstraint', pg_temp.legacy_constraint(p_mode));
$$;

CREATE OR REPLACE FUNCTION pg_temp.generic_apply_payload(p_hash text, p_mode text, p_qty integer, p_addon_line uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'acceptedQuoteHash', p_hash, 'expectedTemplateVersion', 1,
    'resizeLever', jsonb_build_object('kind', 'portionMode', 'value', jsonb_build_object('portionMode', p_mode)),
    'compositionConstraint', pg_temp.legacy_constraint(p_mode),
    'coreLines', jsonb_build_array(pg_temp.core_line(p_qty)),
    'repricedLines', jsonb_build_array(pg_temp.addon_line(p_addon_line)));
$$;

-- SA/SB = topper pair (alias vs generic); SC/SD = full pair (no-op divergence).
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref, size_constraint) VALUES
  ('5b600000-0000-0000-0000-00000000000a', 'c6000000-0000-0000-0000-000000000001', 28, 'EUR', 'active', '2026-09-01T00:00:00Z', 1, 24, 'pm_portion_topper_alias', pg_temp.legacy_constraint(NULL)),
  ('5b600000-0000-0000-0000-00000000000b', 'c6000000-0000-0000-0000-000000000001', 28, 'EUR', 'active', '2026-09-01T00:00:00Z', 1, 24, 'pm_portion_topper_generic', pg_temp.legacy_constraint(NULL)),
  ('5b600000-0000-0000-0000-00000000000c', 'c6000000-0000-0000-0000-000000000001', 28, 'EUR', 'active', '2026-09-01T00:00:00Z', 1, 24, 'pm_portion_full_alias', pg_temp.legacy_constraint(NULL)),
  ('5b600000-0000-0000-0000-00000000000d', 'c6000000-0000-0000-0000-000000000001', 28, 'EUR', 'active', '2026-09-01T00:00:00Z', 1, 24, 'pm_portion_full_generic', pg_temp.legacy_constraint(NULL));

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51600000-0000-0000-0000-0000000000a1', '5b600000-0000-0000-0000-00000000000a', '55556000-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000a2', '5b600000-0000-0000-0000-00000000000a', '55556000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000b1', '5b600000-0000-0000-0000-00000000000b', '55556000-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000b2', '5b600000-0000-0000-0000-00000000000b', '55556000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000c1', '5b600000-0000-0000-0000-00000000000c', '55556000-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000c2', '5b600000-0000-0000-0000-00000000000c', '55556000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000d1', '5b600000-0000-0000-0000-00000000000d', '55556000-0000-0000-0000-000000000001', 8, 1, false, 1, '{}'::jsonb),
  ('51600000-0000-0000-0000-0000000000d2', '5b600000-0000-0000-0000-00000000000d', '55556000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb);

-- set_portion_mode canonicalizes to resize_bundle (the generic verb this alias serves).
CREATE OR REPLACE FUNCTION pg_temp.canonical_bundle_action(p_action text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action WHEN 'set_portion_mode' THEN 'resize_bundle' ELSE p_action END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.subscription_lines_snapshot(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'variantId', variant_id::text, 'qty', qty, 'sortOrder', sort_order,
      'isAddon', is_addon, 'templateVersion', template_version,
      'lineMetadata', COALESCE(line_metadata, '{}'::jsonb)
    ) ORDER BY is_addon, sort_order, variant_id::text
  ), '[]'::jsonb)
  FROM public.subscription_lines WHERE subscription_id = p_subscription_id;
$$;

CREATE OR REPLACE FUNCTION pg_temp.price_agreements_snapshot(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'variantId', variant_id::text, 'currency', currency,
      'unitPriceGrossMinor', unit_price_gross_minor, 'quoteLine', quote_line,
      'templateVersion', template_version,
      'sourceAction', pg_temp.canonical_bundle_action(source_action)
    ) ORDER BY variant_id::text, template_version, quote_line::text
  ), '[]'::jsonb)
  FROM public.subscription_price_agreements WHERE subscription_id = p_subscription_id;
$$;

-- Alias-by-design: event_type differs and the request echo (portionMode vs
-- resizeLever/compositionConstraint) differs. Assert the invariant slice only:
-- canonical event verb, reason, price-agreement policy.
CREATE OR REPLACE FUNCTION pg_temp.event_invariant_snapshot(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'eventType', 'subscription.customer_self_service.' || pg_temp.canonical_bundle_action(e.payload->>'action'),
    'action', pg_temp.canonical_bundle_action(e.payload->>'action'),
    'reason', e.payload->'reason',
    'priceAgreementPolicy', e.payload->'priceAgreementPolicy'
  )
  FROM public.subscription_events e
  WHERE e.subscription_id = p_subscription_id
  ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION pg_temp.seed_quote(
  p_subscription_id uuid, p_action text, p_quote_hash text,
  p_request_payload jsonb, p_quote_snapshot jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_client_id uuid;
BEGIN
  SELECT client_id INTO v_client_id FROM public.subscriptions WHERE id = p_subscription_id;
  INSERT INTO public.subscription_quote_previews (
    subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
    expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
  ) VALUES (
    p_subscription_id, v_client_id, 'a6000000-0000-0000-0000-000000000001', p_action, p_quote_hash, 1,
    '2026-07-10T11:00:00Z'::timestamptz, p_request_payload, p_quote_snapshot, '{}'::jsonb,
    '{"source":"pgtap"}'::jsonb, '2026-07-10T09:55:00Z'::timestamptz, '2026-07-10T09:55:00Z'::timestamptz
  );
END;
$$;

-- ============================ TOPPER PAIR ============================
-- Alias verb: set_portion_mode topper. Halves the core unit count (8 -> 4);
-- merges mode/portionFactor into the existing constraint; cadence unchanged.
SELECT pg_temp.seed_quote(
  '5b600000-0000-0000-0000-00000000000a', 'set_portion_mode', repeat('1', 64),
  jsonb_build_object('action', 'set_portion_mode', 'portionMode', 'topper'),
  pg_temp.quote_snapshot(4, '51600000-0000-0000-0000-0000000000a2')
);
SELECT public.customer_self_service_apply_subscription_action(
  'a6000000-0000-0000-0000-000000000001', 'portion-topper-alias-1', '5b600000-0000-0000-0000-00000000000a', 'set_portion_mode',
  pg_temp.alias_apply_payload(repeat('1', 64), 'topper', 4, '51600000-0000-0000-0000-0000000000a2'),
  '2026-07-10T10:00:00Z'::timestamptz);

-- Generic verb: resize_bundle with the portionMode lever + the constraint the
-- alias would produce, same resized core lines, no cadence change.
SELECT pg_temp.seed_quote(
  '5b600000-0000-0000-0000-00000000000b', 'resize_bundle', repeat('2', 64),
  pg_temp.generic_request('topper'),
  jsonb_build_object('compositionConstraint', pg_temp.legacy_constraint('topper'))
    || pg_temp.quote_snapshot(4, '51600000-0000-0000-0000-0000000000b2')
);
SELECT public.customer_self_service_apply_subscription_action(
  'a6000000-0000-0000-0000-000000000001', 'portion-topper-generic-1', '5b600000-0000-0000-0000-00000000000b', 'resize_bundle',
  pg_temp.generic_apply_payload(repeat('2', 64), 'topper', 4, '51600000-0000-0000-0000-0000000000b2'),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is(pg_temp.subscription_lines_snapshot('5b600000-0000-0000-0000-00000000000b'), pg_temp.subscription_lines_snapshot('5b600000-0000-0000-0000-00000000000a'), 'topper: resize_bundle matches set_portion_mode subscription_lines');
SELECT is((SELECT size_constraint FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000b'), (SELECT size_constraint FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000a'), 'topper: resize_bundle matches set_portion_mode size_constraint');
SELECT is(pg_temp.price_agreements_snapshot('5b600000-0000-0000-0000-00000000000b'), pg_temp.price_agreements_snapshot('5b600000-0000-0000-0000-00000000000a'), 'topper: resize_bundle matches set_portion_mode price agreements');
SELECT is(pg_temp.event_invariant_snapshot('5b600000-0000-0000-0000-00000000000b'), pg_temp.event_invariant_snapshot('5b600000-0000-0000-0000-00000000000a'), 'topper: resize_bundle matches set_portion_mode audit invariant');
-- The effect is real: the alias actually stamped topper/0.5 into the constraint.
SELECT is((SELECT size_constraint->>'mode' FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000a'), 'topper', 'topper: set_portion_mode stamped mode=topper');
SELECT is((SELECT size_constraint->>'portionFactor' FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000a'), '0.5', 'topper: set_portion_mode stamped portionFactor=0.5');

-- =================== NO-OP SUPPRESSION DIVERGENCE ===================
-- SC/SD are both "already full" (no mode key = full). A full-on-full portion
-- edit is a semantic no-op. The alias verb set_portion_mode is in the Wave-5
-- suppression allowlist, so it no-ops (template unchanged, no event/email). The
-- generic resize_bundle is NOT in that allowlist, so it applies (template bump +
-- package_changed event). This proves the alias and generic verbs are NOT fully
-- equivalent for no-op edits — the E2 KNOWN_GAP.
SELECT pg_temp.seed_quote(
  '5b600000-0000-0000-0000-00000000000c', 'set_portion_mode', repeat('3', 64),
  jsonb_build_object('action', 'set_portion_mode', 'portionMode', 'full'),
  pg_temp.quote_snapshot(8, '51600000-0000-0000-0000-0000000000c2')
);
SELECT public.customer_self_service_apply_subscription_action(
  'a6000000-0000-0000-0000-000000000001', 'portion-full-alias-1', '5b600000-0000-0000-0000-00000000000c', 'set_portion_mode',
  pg_temp.alias_apply_payload(repeat('3', 64), 'full', 8, '51600000-0000-0000-0000-0000000000c2'),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT pg_temp.seed_quote(
  '5b600000-0000-0000-0000-00000000000d', 'resize_bundle', repeat('4', 64),
  pg_temp.generic_request('full'),
  jsonb_build_object('compositionConstraint', pg_temp.legacy_constraint('full'))
    || pg_temp.quote_snapshot(8, '51600000-0000-0000-0000-0000000000d2')
);
SELECT public.customer_self_service_apply_subscription_action(
  'a6000000-0000-0000-0000-000000000001', 'portion-full-generic-1', '5b600000-0000-0000-0000-00000000000d', 'resize_bundle',
  pg_temp.generic_apply_payload(repeat('4', 64), 'full', 8, '51600000-0000-0000-0000-0000000000d2'),
  '2026-07-10T10:00:00Z'::timestamptz);

SELECT is((SELECT template_version FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000c'), 1,
  'divergence: set_portion_mode full-on-full is suppressed as no-op (template_version unchanged)');
SELECT is((SELECT count(*)::int FROM public.subscription_events WHERE subscription_id = '5b600000-0000-0000-0000-00000000000c'), 0,
  'divergence: alias-verb no-op emits no subscription_events (no package_changed email)');
SELECT is((SELECT template_version FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000d'), 2,
  'divergence: generic resize_bundle applies the same no-op edit (template_version bumped)');
SELECT is((SELECT count(*)::int FROM public.subscription_events WHERE subscription_id = '5b600000-0000-0000-0000-00000000000d'), 1,
  'divergence: generic verb is NOT in the Wave-5 no-op allowlist, so it emits a package_changed event');

-- Negative controls: the comparators must actually catch drift.
SELECT isnt(
  jsonb_set(pg_temp.subscription_lines_snapshot('5b600000-0000-0000-0000-00000000000b'), '{0,qty}', '999'::jsonb),
  pg_temp.subscription_lines_snapshot('5b600000-0000-0000-0000-00000000000a'),
  'negative control: line snapshot comparator catches qty drift');
SELECT isnt(
  pg_temp.legacy_constraint('full'),
  (SELECT size_constraint FROM public.subscriptions WHERE id = '5b600000-0000-0000-0000-00000000000a'),
  'negative control: size_constraint comparator catches topper-vs-full drift');

SELECT * FROM finish();
ROLLBACK;
