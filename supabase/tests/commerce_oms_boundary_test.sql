-- pgTAP: current OMS hold create/release replay and payment-control isolation,
-- plus a 506-order queue whose summaries must span every page.
-- Calls take the shipped runtime/browser roles; no application ACLs are added.
BEGIN;
\ir fixtures/settlement.inc
SELECT plan(48);

INSERT INTO public.admin_users (id, email, role)
VALUES ('fa920000-0000-4000-8000-000000000001', 'oms-boundary-admin@example.invalid', 'admin');
INSERT INTO public.clients (id, email)
VALUES ('fa920000-0000-4000-8000-000000000002', 'oms-boundary-client@example.invalid');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('fa920000-0000-4000-8000-000000000003', 'fa920000-0000-4000-8000-000000000002',
  'shipping', 'Synthetic Street 1', 'Testville', '00-001', 'ZZ');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('fa920000-0000-4000-8000-000000000004', 'oms-boundary-product', 'OMS fixture', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('fa920000-0000-4000-8000-000000000005', 'fa920000-0000-4000-8000-000000000004',
  'OMS-BOUNDARY-SKU', 'OMS fixture', 'dog', 'active', 400, 400);
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('fa920000-0000-4000-8000-000000000006', 'oms-boundary-location', 'OMS fixture', 'virtual', 'active', true);

CREATE TEMP TABLE oms_fixture_ids AS
SELECT n,
  ('fa921000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS order_id,
  ('fa922000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS payment_id,
  ('fa923000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS intent_id,
  ('fa924000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS item_id,
  ('fa925000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS reservation_id
FROM generate_series(1, 506) n;
INSERT INTO public.commerce_orders
  (id, client_id, shipping_address_id, order_number, status, mode, currency, region_code, subtotal_cents, total_cents, created_at)
SELECT order_id, 'fa920000-0000-4000-8000-000000000002', 'fa920000-0000-4000-8000-000000000003',
  'OMSBOUNDARY506-' || lpad(n::text, 4, '0'), 'paid', 'one_time', :'fixture_currency', :'fixture_region',
  1000, 1000, '2099-09-01T00:00:00Z'::timestamptz + n * interval '1 second'
FROM oms_fixture_ids;
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
SELECT payment_id, order_id, 'oms_fixture', 'oms-fixture-payment-' || n, 'succeeded', 1000, :'fixture_currency'
FROM oms_fixture_ids;
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency, updated_at)
SELECT intent_id, 'one_time_order', order_id, payment_id, 'succeeded', 1000, :'fixture_currency', '2099-09-01T12:00:00Z'
FROM oms_fixture_ids;
INSERT INTO public.commerce_order_items
  (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
SELECT item_id, order_id, 'fa920000-0000-4000-8000-000000000005', 1, 1000, 1000, 0, 1000,
  round(1000::numeric * 10000 / 10800)::integer, '{"sku":"OMS-BOUNDARY-SKU"}'::jsonb
FROM oms_fixture_ids;
INSERT INTO public.inventory_reservations
  (id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind)
SELECT reservation_id, 'oms-fixture-reservation-' || n, order_id, item_id,
  'fa920000-0000-4000-8000-000000000005', 'fa920000-0000-4000-8000-000000000006',
  1, 'reserved', 'manual_ops'
FROM oms_fixture_ids;
SELECT is((SELECT count(*)::integer FROM public.commerce_orders o JOIN oms_fixture_ids f ON f.order_id = o.id),
  506, 'the queue fixture owns exactly 506 nonempty orders');
SELECT is((SELECT count(*)::integer FROM oms_fixture_ids f
  JOIN public.commerce_payment_intents p ON p.id = f.intent_id AND p.status = 'succeeded'
  JOIN public.inventory_reservations r ON r.id = f.reservation_id AND r.order_item_id = f.item_id AND r.status = 'reserved'),
  506, 'every fixture order has real succeeded payment control and covered inventory');
SELECT ok(has_function_privilege('service_role', 'public.commerce_oms_create_hold(text,uuid,text,text,uuid,jsonb)', 'EXECUTE'),
  'commerce_oms_create_hold: service_role retains effective EXECUTE');
SELECT ok(NOT has_function_privilege('anon', 'public.commerce_oms_create_hold(text,uuid,text,text,uuid,jsonb)', 'EXECUTE'),
  'commerce_oms_create_hold: anon has no effective EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_oms_create_hold(text,uuid,text,text,uuid,jsonb)', 'EXECUTE'),
  'commerce_oms_create_hold: authenticated has no effective EXECUTE');
SELECT ok(has_function_privilege('service_role', 'public.commerce_oms_release_hold(text,uuid,text,uuid,jsonb)', 'EXECUTE'),
  'commerce_oms_release_hold: service_role retains effective EXECUTE');
SELECT ok(NOT has_function_privilege('anon', 'public.commerce_oms_release_hold(text,uuid,text,uuid,jsonb)', 'EXECUTE'),
  'commerce_oms_release_hold: anon has no effective EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_oms_release_hold(text,uuid,text,uuid,jsonb)', 'EXECUTE'),
  'commerce_oms_release_hold: authenticated has no effective EXECUTE');
SELECT ok(has_function_privilege('service_role', 'public.commerce_oms_admin_list_queue(integer,integer,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,boolean)', 'EXECUTE'),
  'commerce_oms_admin_list_queue: service_role retains effective EXECUTE');
SELECT ok(NOT has_function_privilege('anon', 'public.commerce_oms_admin_list_queue(integer,integer,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,boolean)', 'EXECUTE'),
  'commerce_oms_admin_list_queue: anon has no effective EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_oms_admin_list_queue(integer,integer,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,boolean)', 'EXECUTE'),
  'commerce_oms_admin_list_queue: authenticated has no effective EXECUTE');

-- Owner snapshots compare every column and row, rather than fresh-state counts.
CREATE TEMP VIEW oms_protected_state AS
SELECT jsonb_build_object(
  'commerce_orders', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_orders r),
  'commerce_order_items', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_order_items r),
  'commerce_payments', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payments r),
  'commerce_payment_intents', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_intents r),
  'commerce_payment_attempts', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_attempts r),
  'commerce_payment_state_transitions', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_state_transitions r),
  'commerce_payment_method_refs', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_method_refs r),
  'commerce_payment_reconciliation_runs', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_reconciliation_runs r),
  'inbound_provider_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inbound_provider_events r),
  'payment_external_refs', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.payment_external_refs r),
  'outbox_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.outbox_events r),
  'subscriptions', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscriptions r),
  'subscription_cycles', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_cycles r),
  'subscription_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_events r),
  'subscription_dunning_cases', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_dunning_cases r),
  'subscription_dunning_notifications', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_dunning_notifications r),
  'inventory_reservations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_reservations r),
  'inventory_balances', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_balances r),
  'inventory_stock_movements', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_stock_movements r)
) AS state;
CREATE TEMP VIEW oms_complete_state AS
SELECT state || jsonb_build_object(
  'commerce_order_holds', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_order_holds r),
  'commerce_order_operations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_order_operations r),
  'commerce_idempotency_keys', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_idempotency_keys r)
) AS state FROM oms_protected_state;
CREATE TEMP TABLE oms_before AS SELECT state FROM oms_protected_state;

SET LOCAL ROLE service_role;
SELECT is(current_user::text, 'service_role', 'OMS calls use the runtime role');
CREATE TEMP TABLE oms_created AS SELECT public.commerce_oms_create_hold('oms-boundary-create-key', 'fa921000-0000-4000-8000-000000000001', 'manual_support', 'synthetic hold', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) AS result;
RESET ROLE;
SELECT is((SELECT result->>'replayed' FROM oms_created), 'false', 'first hold create is not a replay');
SELECT is((SELECT status FROM public.commerce_order_holds WHERE id = (SELECT (result#>>'{hold,id}')::uuid FROM oms_created)),
  'active', 'create persists an active hold');
SELECT is((SELECT count(*)::integer FROM public.commerce_order_holds WHERE idempotency_key = 'oms-boundary-create-key'),
  1, 'create persists exactly one hold');
SELECT is((SELECT count(*)::integer FROM public.commerce_order_operations WHERE idempotency_key = 'oms-boundary-create-key:operation' AND operation_type = 'hold_created'),
  1, 'create persists exactly one hold-created operation');
SELECT is((SELECT state FROM oms_protected_state), (SELECT state FROM oms_before),
  'create preserves complete payment-control and protected rows');
CREATE TEMP TABLE oms_before_create_replay AS SELECT state FROM oms_complete_state;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE oms_created_replay AS SELECT public.commerce_oms_create_hold('oms-boundary-create-key', 'fa921000-0000-4000-8000-000000000001', 'manual_support', 'synthetic hold', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) AS result;
RESET ROLE;
SELECT is((SELECT result->>'replayed' FROM oms_created_replay), 'true', 'same-input hold create replays');
SELECT is((SELECT result - 'replayed' FROM oms_created_replay), (SELECT result - 'replayed' FROM oms_created),
  'create replay returns the original durable identity and response');
SELECT is((SELECT state FROM oms_complete_state), (SELECT state FROM oms_before_create_replay),
  'create replay preserves complete rows including hold operations and idempotency');
-- psql carries the computed hold identity into role-taking calls; no table grant is needed.
SELECT result#>>'{hold,id}' AS oms_boundary_hold_id FROM oms_created \gset
SET LOCAL ROLE service_role;
CREATE TEMP TABLE oms_released AS SELECT public.commerce_oms_release_hold('oms-boundary-release-key', :'oms_boundary_hold_id'::uuid, 'synthetic release', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) AS result;
RESET ROLE;
SELECT is((SELECT result->>'replayed' FROM oms_released), 'false', 'first hold release is not a replay');
SELECT is((SELECT status FROM public.commerce_order_holds WHERE id = :'oms_boundary_hold_id'::uuid),
  'released', 'release persists the released hold transition');
SELECT ok((SELECT released_at IS NOT NULL AND released_by = 'fa920000-0000-4000-8000-000000000001'::uuid
  FROM public.commerce_order_holds WHERE id = :'oms_boundary_hold_id'::uuid), 'release persists actor and release time');
SELECT is((SELECT count(*)::integer FROM public.commerce_order_operations WHERE idempotency_key = 'oms-boundary-release-key:operation' AND operation_type = 'hold_released'),
  1, 'release persists exactly one hold-released operation');
SELECT is((SELECT state FROM oms_protected_state), (SELECT state FROM oms_before),
  'release preserves complete payment-control and protected rows');
CREATE TEMP TABLE oms_before_release_replay AS SELECT state FROM oms_complete_state;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE oms_released_replay AS SELECT public.commerce_oms_release_hold('oms-boundary-release-key', :'oms_boundary_hold_id'::uuid, 'synthetic release', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) AS result;
RESET ROLE;
SELECT is((SELECT result->>'replayed' FROM oms_released_replay), 'true', 'same-input hold release replays');
SELECT is((SELECT result - 'replayed' FROM oms_released_replay), (SELECT result - 'replayed' FROM oms_released),
  'release replay returns the original durable identity and response');
SELECT is((SELECT state FROM oms_complete_state), (SELECT state FROM oms_before_release_replay),
  'release replay preserves complete rows including hold operations and idempotency');

CREATE TEMP TABLE oms_before_queue AS SELECT state FROM oms_complete_state;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE oms_queue_first AS SELECT public.commerce_oms_admin_list_queue(1, 100, 'OMSBOUNDARY506', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, 'created_asc', false) AS result;
CREATE TEMP TABLE oms_queue_sixth AS SELECT public.commerce_oms_admin_list_queue(6, 100, 'OMSBOUNDARY506', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, 'created_asc', false) AS result;
RESET ROLE;
SELECT is((SELECT jsonb_array_length(result->'orderIds') FROM oms_queue_first), 100, 'first queue page contains 100 orders');
SELECT is((SELECT (result->>'totalCount')::integer FROM oms_queue_first), 506, 'queue total counts all 506 orders');
SELECT is((SELECT (result#>>'{summaryCounts,readyForFulfillment}')::integer FROM oms_queue_first),
  506, 'global ready-for-fulfillment count spans all 506 orders');
SELECT is((SELECT (result#>>'{summaryTotals,orderCount}')::integer FROM oms_queue_first),
  506, 'global paid summary count spans all 506 orders');
SELECT is((SELECT (result#>>'{summaryTotals,gmv,amountMinor}')::bigint FROM oms_queue_first),
  506000::bigint, 'global paid GMV spans all 506 orders');
SELECT is((SELECT (result#>>'{summaryTotals,aov,amountMinor}')::bigint FROM oms_queue_first),
  1000::bigint, 'global paid average uses the full paid set');
SELECT is((SELECT jsonb_array_length(result->'orderIds') FROM oms_queue_sixth), 6, 'sixth queue page exposes the six orders beyond 500');
SELECT is((SELECT result->'orderIds' FROM oms_queue_sixth),
  (SELECT jsonb_agg(order_id ORDER BY n) FROM oms_fixture_ids WHERE n > 500),
  'sixth queue page contains exactly the durable orders 501 through 506');
SELECT is((SELECT (result->>'totalCount')::integer FROM oms_queue_sixth), 506, 'deep-page total still counts all 506 orders');
SELECT is((SELECT jsonb_build_object('counts', result->'summaryCounts', 'totals', result->'summaryTotals') FROM oms_queue_sixth),
  (SELECT jsonb_build_object('counts', result->'summaryCounts', 'totals', result->'summaryTotals') FROM oms_queue_first),
  'global summaries are identical across first and sixth queue pages');
SELECT is((SELECT state FROM oms_complete_state), (SELECT state FROM oms_before_queue), 'queue reads preserve complete writer rows');

SET LOCAL ROLE anon;
SELECT is(current_user::text, 'anon', 'browser OMS calls use anon');
SELECT throws_ok($call$ SELECT public.commerce_oms_create_hold('oms-boundary-create-key', 'fa921000-0000-4000-8000-000000000001', 'manual_support', 'synthetic hold', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) $call$, '42501', 'permission denied for function commerce_oms_create_hold',
  'anon: hold create refuses at EXECUTE admission');
SELECT throws_ok(format($call$ SELECT public.commerce_oms_release_hold('oms-boundary-release-key', %L::uuid, 'synthetic release', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) $call$, :'oms_boundary_hold_id'),
  '42501', 'permission denied for function commerce_oms_release_hold', 'anon: hold release refuses at EXECUTE admission');
SELECT throws_ok($call$ SELECT public.commerce_oms_admin_list_queue(1, 100, 'OMSBOUNDARY506', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, 'created_asc', false) $call$, '42501', 'permission denied for function commerce_oms_admin_list_queue',
  'anon: queue refuses at EXECUTE admission');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT is(current_user::text, 'authenticated', 'browser OMS calls use authenticated');
SELECT throws_ok($call$ SELECT public.commerce_oms_create_hold('oms-boundary-create-key', 'fa921000-0000-4000-8000-000000000001', 'manual_support', 'synthetic hold', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) $call$, '42501', 'permission denied for function commerce_oms_create_hold',
  'authenticated: hold create refuses at EXECUTE admission');
SELECT throws_ok(format($call$ SELECT public.commerce_oms_release_hold('oms-boundary-release-key', %L::uuid, 'synthetic release', 'fa920000-0000-4000-8000-000000000001', '{"source":"oms_boundary_fixture"}'::jsonb) $call$, :'oms_boundary_hold_id'),
  '42501', 'permission denied for function commerce_oms_release_hold', 'authenticated: hold release refuses at EXECUTE admission');
SELECT throws_ok($call$ SELECT public.commerce_oms_admin_list_queue(1, 100, 'OMSBOUNDARY506', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, 'created_asc', false) $call$, '42501', 'permission denied for function commerce_oms_admin_list_queue',
  'authenticated: queue refuses at EXECUTE admission');
RESET ROLE;

SELECT is((SELECT state FROM oms_complete_state), (SELECT state FROM oms_before_queue), 'browser refusals preserve complete writer rows');
SELECT * FROM finish();
ROLLBACK;
