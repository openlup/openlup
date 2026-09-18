-- pgTAP: cumulative W3c-a witness for the legacy catalog mutation fence.
--
-- Every raw legacy RPC is called with a request that would have been valid
-- before the fence. The protected snapshot covers the catalog rows each call
-- previously wrote plus an active subscription's immutable agreement, lines,
-- cadence, next cycle, historical order snapshot and durable delivery-alignment
-- case. It also pins the retained RPC ABI/ACL boundary.

BEGIN;
SELECT plan(17);

INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'fence-admin@example.invalid', 'admin', false);
INSERT INTO public.clients (id, email) VALUES
  ('f1000000-0000-4000-8000-000000000002', 'fence-subscription@example.invalid');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country) VALUES
  ('f1000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000002',
   'shipping', 'Fence 1', 'Warszawa', '00-001', 'PL');

INSERT INTO public.catalog_products (id, slug, name, status) VALUES
  ('f1000000-0000-4000-8000-000000000011', 'fence-cumulative-main', 'Fence main', 'active'),
  ('f1000000-0000-4000-8000-000000000012', 'fence-cumulative-activate', 'Fence activate', 'draft'),
  ('f1000000-0000-4000-8000-000000000013', 'fence-cumulative-archive', 'Fence archive', 'active'),
  ('f1000000-0000-4000-8000-000000000014', 'fence-cumulative-restore', 'Fence restore', 'archived'),
  ('f1000000-0000-4000-8000-000000000015', 'fence-cumulative-deactivate', 'Fence deactivate', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('f1000000-0000-4000-8000-000000000021', 'f1000000-0000-4000-8000-000000000011', 'FENCE-CUMULATIVE-MAIN', 'Fence main', 'dog', 400, 480, 'active'),
  ('f1000000-0000-4000-8000-000000000022', 'f1000000-0000-4000-8000-000000000012', 'FENCE-CUMULATIVE-ACTIVATE', 'Fence activate', 'dog', 400, 480, 'draft'),
  ('f1000000-0000-4000-8000-000000000023', 'f1000000-0000-4000-8000-000000000013', 'FENCE-CUMULATIVE-ARCHIVE', 'Fence archive', 'dog', 400, 480, 'active'),
  ('f1000000-0000-4000-8000-000000000024', 'f1000000-0000-4000-8000-000000000014', 'FENCE-CUMULATIVE-RESTORE', 'Fence restore', 'dog', 400, 480, 'archived'),
  ('f1000000-0000-4000-8000-000000000025', 'f1000000-0000-4000-8000-000000000015', 'FENCE-CUMULATIVE-DEACTIVATE', 'Fence deactivate', 'dog', 400, 480, 'active');
INSERT INTO public.price_lists (id, name, region_code, currency, status) VALUES
  ('f1000000-0000-4000-8000-000000000031', 'fence_cumulative_prices', 'PL', 'PLN', 'active');
INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active) VALUES
  ('f1000000-0000-4000-8000-000000000031', 'f1000000-0000-4000-8000-000000000021', 'one_time', 1, 1490, 'gross', true),
  ('f1000000-0000-4000-8000-000000000031', 'f1000000-0000-4000-8000-000000000021', 'subscription', 1, 1340, 'gross', true),
  ('f1000000-0000-4000-8000-000000000031', 'f1000000-0000-4000-8000-000000000022', 'one_time', 1, 1490, 'gross', true);

INSERT INTO public.subscriptions (
  id, client_id, shipping_address_id, cadence_days, currency, status,
  next_cycle_at, payment_method_ref, payment_method_kind, template_version
) VALUES (
  'f1000000-0000-4000-8000-000000000041', 'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000003', 21, 'PLN', 'active',
  '2035-01-21T00:00:00Z', 'pm-fence', 'card', 1
);
INSERT INTO public.subscription_lines (
  id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
) VALUES (
  'f1000000-0000-4000-8000-000000000042', 'f1000000-0000-4000-8000-000000000041',
  'f1000000-0000-4000-8000-000000000021', 1, 0, false, 1,
  '{"productSnapshot":{"quoteLine":{"sku":"FENCE-CUMULATIVE-MAIN","quantity":1,"unitPriceGross":{"amountMinor":1340,"currency":"PLN"}}}}'::jsonb
);
INSERT INTO public.subscription_price_agreements (
  id, subscription_id, subscription_line_id, variant_id, currency,
  unit_price_gross_minor, quote_line, template_version, source_action, idempotency_key
) VALUES (
  'f1000000-0000-4000-8000-000000000043', 'f1000000-0000-4000-8000-000000000041',
  'f1000000-0000-4000-8000-000000000042', 'f1000000-0000-4000-8000-000000000021', 'PLN', 1340,
  '{"sku":"FENCE-CUMULATIVE-MAIN","quantity":1,"unitPriceGross":{"amountMinor":1340,"currency":"PLN"}}'::jsonb,
  1, 'fence_fixture', 'fence-agreement'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key
) VALUES (
  'f1000000-0000-4000-8000-000000000044', 'f1000000-0000-4000-8000-000000000041',
  1, '2034-12-31T00:00:00Z', 'paid', '2034-12-31T00:00:00Z', 'fence-cycle'
);
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, status, subtotal_cents, total_cents,
  mode, subscription_id, subscription_cycle_id
) VALUES (
  'f1000000-0000-4000-8000-000000000045', 'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000003', 'paid', 1340, 1340,
  'subscription_cycle', 'f1000000-0000-4000-8000-000000000041', 'f1000000-0000-4000-8000-000000000044'
);
INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, currency, region_code, size_constraint,
  status, subtotal_cents, total_cents, mode
) VALUES (
  'f1000000-0000-4000-8000-000000000048', 'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000003', 'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb,
  'paid', 1340, 1340, 'one_time'
);
INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  product_snapshot, variant_snapshot, discount_allocated_cents,
  effective_total_cents, effective_net_cents, allocation_ordinal
) VALUES (
  'f1000000-0000-4000-8000-000000000047', 'f1000000-0000-4000-8000-000000000048',
  'f1000000-0000-4000-8000-000000000021', 1, 1340, 1340,
  '{"title":"Historical Fence Main","sku":"FENCE-CUMULATIVE-MAIN","unitPriceGross":{"amountMinor":1340,"currency":"PLN"}}'::jsonb,
  '{"title":"Historical Fence Main","sku":"FENCE-CUMULATIVE-MAIN","netWeightG":400}'::jsonb,
  0, 1340, round(1340::numeric * 10000 / 10800)::integer, 1
);
UPDATE public.subscription_cycles
   SET order_id = 'f1000000-0000-4000-8000-000000000045'
 WHERE id = 'f1000000-0000-4000-8000-000000000044';
INSERT INTO public.subscription_delivery_alignment_cases (
  id, predecessor_order_id, subscription_id, predecessor_cycle_id,
  predecessor_cycle_number, captured_mode, state, evidence_kind,
  observed_next_cycle_at, metadata
) VALUES (
  'f1000000-0000-4000-8000-000000000046', 'f1000000-0000-4000-8000-000000000045',
  'f1000000-0000-4000-8000-000000000041', 'f1000000-0000-4000-8000-000000000044',
  1, 'auto_align', 'protected', 'overdue_renewal', '2035-01-21T00:00:00Z',
  '{"source":"catalog_legacy_mutation_fence"}'::jsonb
);
SELECT set_config('request.jwt.claims',
  '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

CREATE OR REPLACE FUNCTION pg_temp.catalog_legacy_mutation_fence_snapshot()
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'catalog', jsonb_build_object(
      'products', (SELECT jsonb_agg(to_jsonb(product) ORDER BY product.id)
                     FROM public.catalog_products AS product
                    WHERE product.slug LIKE 'fence-cumulative-%'),
      'skus', (SELECT jsonb_agg(to_jsonb(sku) ORDER BY sku.id)
                 FROM public.catalog_skus AS sku
                WHERE sku.sku LIKE 'FENCE-CUMULATIVE-%'),
      'priceEntries', (SELECT jsonb_agg(to_jsonb(price) ORDER BY price.id)
                         FROM public.price_entries AS price
                        WHERE price.price_list_id = 'f1000000-0000-4000-8000-000000000031')
    ),
    'activeSubscription', (SELECT jsonb_agg(to_jsonb(subscription) ORDER BY subscription.id)
                             FROM public.subscriptions AS subscription
                            WHERE subscription.id = 'f1000000-0000-4000-8000-000000000041'
                              AND subscription.status = 'active'),
    'activeAgreements', (SELECT jsonb_agg(to_jsonb(agreement) ORDER BY agreement.id)
                           FROM public.subscription_price_agreements AS agreement
                          WHERE agreement.subscription_id = 'f1000000-0000-4000-8000-000000000041'
                            AND agreement.ended_at IS NULL),
    'subscriptionLines', (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id)
                            FROM public.subscription_lines AS line
                           WHERE line.subscription_id = 'f1000000-0000-4000-8000-000000000041'),
    'historicalOrder', jsonb_build_object(
      'orders', (SELECT jsonb_agg(to_jsonb(order_row) ORDER BY order_row.id)
                   FROM public.commerce_orders AS order_row
                  WHERE order_row.id = 'f1000000-0000-4000-8000-000000000048'),
      'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
                  FROM public.commerce_order_items AS item
                 WHERE item.order_id = 'f1000000-0000-4000-8000-000000000048')
    ),
    'deliveryAlignment', (SELECT jsonb_agg(to_jsonb(alignment_case) ORDER BY alignment_case.id)
                           FROM public.subscription_delivery_alignment_cases AS alignment_case
                          WHERE alignment_case.subscription_id = 'f1000000-0000-4000-8000-000000000041')
  )
$$;

CREATE OR REPLACE FUNCTION pg_temp.catalog_legacy_mutation_fence_contract_mismatches()
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH expected(proname, identity_arguments, arguments, result) AS (
    VALUES
      ('admin_activate_catalog_product',
       'p_actor_id uuid, p_slug text, p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_slug text, p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb'),
      ('admin_archive_catalog_product',
       'p_actor_id uuid, p_slug text, p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_slug text, p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb'),
      ('admin_archive_catalog_sku',
       'p_actor_id uuid, p_sku text, p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_sku text, p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb'),
      ('admin_deactivate_catalog_product',
       'p_actor_id uuid, p_slug text, p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_slug text, p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb'),
      ('admin_restore_catalog_product',
       'p_actor_id uuid, p_slug text, p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_slug text, p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb'),
      ('admin_set_catalog_price',
       'p_actor_id uuid, p_sku text, p_price_mode text, p_unit_price_minor integer, p_currency text, p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_sku text, p_price_mode text, p_unit_price_minor integer, p_currency text, p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb'),
      ('admin_set_subscription_band_percent',
       'p_pct numeric',
       'p_pct numeric',
       'TABLE(updated_sku_count integer, applied_percent numeric)'),
      ('admin_upsert_catalog_draft',
       'p_actor_id uuid, p_slug text, p_name text, p_species text, p_unit text, p_sku text, p_net_weight_g integer, p_kcal_per_unit integer, p_allergens text[], p_mode text, p_idempotency_key text, p_request_id text, p_source text',
       'p_actor_id uuid, p_slug text, p_name text, p_species text, p_unit text, p_sku text, p_net_weight_g integer, p_kcal_per_unit integer, p_allergens text[], p_mode text DEFAULT ''commit''::text, p_idempotency_key text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text, p_source text DEFAULT ''agent_catalog''::text',
       'jsonb')
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'function', expected.proname,
    'identityArguments', pg_get_function_identity_arguments(proc.oid),
    'arguments', pg_get_function_arguments(proc.oid),
    'result', pg_get_function_result(proc.oid),
    'securityDefiner', proc.prosecdef,
    'searchPath', proc.proconfig,
    'acl', proc.proacl
  ) ORDER BY expected.proname), '[]'::jsonb)
    FROM expected
    LEFT JOIN pg_proc AS proc ON proc.proname = expected.proname
    LEFT JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.nspname IS DISTINCT FROM 'public'
      OR pg_get_function_identity_arguments(proc.oid) IS DISTINCT FROM expected.identity_arguments
      OR pg_get_function_arguments(proc.oid) IS DISTINCT FROM expected.arguments
      OR pg_get_function_result(proc.oid) IS DISTINCT FROM expected.result
      OR proc.prosecdef IS DISTINCT FROM true
      OR proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
      OR proc.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres'::aclitem, 'service_role=X/postgres'::aclitem]
      OR has_function_privilege('service_role', proc.oid, 'EXECUTE') IS DISTINCT FROM true
      OR has_function_privilege('anon', proc.oid, 'EXECUTE') IS DISTINCT FROM false
      OR has_function_privilege('authenticated', proc.oid, 'EXECUTE') IS DISTINCT FROM false
      OR EXISTS (
        SELECT 1 FROM aclexplode(proc.proacl) AS acl
         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      )
$$;
CREATE TEMP TABLE _before AS SELECT pg_temp.catalog_legacy_mutation_fence_snapshot() AS snapshot;

SELECT throws_ok(
  $$ SELECT public.admin_upsert_catalog_draft(
       'f1000000-0000-4000-8000-000000000001', 'fence-cumulative-new', 'Fence new',
       'dog', 'can', 'FENCE-CUMULATIVE-NEW', 400, 480, ARRAY[]::text[],
       'commit', 'fence-upsert', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_upsert_catalog_draft refuses');
SELECT throws_ok(
  $$ SELECT public.admin_set_catalog_price(
       'f1000000-0000-4000-8000-000000000001', 'FENCE-CUMULATIVE-MAIN', 'one_time',
       1590, 'PLN', 'commit', 'fence-price', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_set_catalog_price refuses');
SELECT throws_ok(
  $$ SELECT public.admin_archive_catalog_sku(
       'f1000000-0000-4000-8000-000000000001', 'FENCE-CUMULATIVE-MAIN',
       'commit', 'fence-archive-sku', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_archive_catalog_sku refuses');
SELECT throws_ok(
  $$ SELECT public.admin_activate_catalog_product(
       'f1000000-0000-4000-8000-000000000001', 'fence-cumulative-activate',
       'commit', 'fence-activate', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_activate_catalog_product refuses');
SELECT throws_ok(
  $$ SELECT public.admin_archive_catalog_product(
       'f1000000-0000-4000-8000-000000000001', 'fence-cumulative-archive',
       'commit', 'fence-archive-product', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_archive_catalog_product refuses');
SELECT throws_ok(
  $$ SELECT public.admin_restore_catalog_product(
       'f1000000-0000-4000-8000-000000000001', 'fence-cumulative-restore',
       'commit', 'fence-restore-product', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_restore_catalog_product refuses');
SELECT throws_ok(
  $$ SELECT public.admin_deactivate_catalog_product(
       'f1000000-0000-4000-8000-000000000001', 'fence-cumulative-deactivate',
       'commit', 'fence-deactivate', NULL, 'agent_catalog') $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_deactivate_catalog_product refuses');
SELECT throws_ok(
  $$ SELECT public.admin_set_subscription_band_percent(12) $$,
  '42501', 'legacy_catalog_mutation_fenced', 'admin_set_subscription_band_percent refuses');

SELECT is(
  (SELECT (snapshot -> 'catalog')::text FROM _before),
  (pg_temp.catalog_legacy_mutation_fence_snapshot() -> 'catalog')::text,
  'all fenced RPCs leave catalog products, SKUs and price entries unchanged');
SELECT is(
  (SELECT (snapshot -> 'activeAgreements')::text FROM _before),
  (pg_temp.catalog_legacy_mutation_fence_snapshot() -> 'activeAgreements')::text,
  'all fenced RPCs leave active subscription agreements immutable');
SELECT is(
  (SELECT (snapshot -> 'activeSubscription')::text FROM _before),
  (pg_temp.catalog_legacy_mutation_fence_snapshot() -> 'activeSubscription')::text,
  'all fenced RPCs leave active subscription cadence and next_cycle_at unchanged');
SELECT is(
  (SELECT (snapshot -> 'subscriptionLines')::text FROM _before),
  (pg_temp.catalog_legacy_mutation_fence_snapshot() -> 'subscriptionLines')::text,
  'all fenced RPCs leave active subscription lines and their frozen product snapshot unchanged');
SELECT is(
  (SELECT (snapshot -> 'historicalOrder')::text FROM _before),
  (pg_temp.catalog_legacy_mutation_fence_snapshot() -> 'historicalOrder')::text,
  'all fenced RPCs leave commerce order rows and immutable order-item snapshots unchanged');
SELECT is(
  (SELECT (snapshot -> 'deliveryAlignment')::text FROM _before),
  (pg_temp.catalog_legacy_mutation_fence_snapshot() -> 'deliveryAlignment')::text,
  'all fenced RPCs leave delivery-alignment state unchanged');
SELECT is(
  pg_temp.catalog_legacy_mutation_fence_contract_mismatches()::text,
  '[]',
  'all eight fenced functions retain exact signatures/defaults, definer/search-path and service-role-only execute ACLs');
SELECT ok(
  to_regprocedure('public.catalog_submit_change_proposal(text,text)') IS NOT NULL
  AND to_regprocedure('public.catalog_register_publication_candidate(text,text)') IS NOT NULL,
  'D2 proposal and publication writers remain outside the fence');
SELECT ok(
  to_regprocedure('public.catalog_sku_eans_upsert_pack(text,text,text,text,integer,boolean,text)') IS NOT NULL,
  'OmniPack EAN writer remains outside the fence');

SELECT * FROM finish();
ROLLBACK;
