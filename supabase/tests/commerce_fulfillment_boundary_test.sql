-- Actual current-RPC evidence; synthetic prerequisites belong only to this transaction.
-- No installation seeds, fixture grants, provider calls or hosted services are involved.
BEGIN;
\ir fixtures/settlement.inc
SELECT plan(50);
INSERT INTO public.providers (kind, capability, display_name, status, enabled_for_region)
VALUES (:'fixture_provider', 'fulfillment', 'Boundary fixture provider', 'experimental', ARRAY[public.platform_region_code()])
ON CONFLICT (kind) DO UPDATE SET enabled_for_region = EXCLUDED.enabled_for_region;
INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES ('f8100000-0000-4000-8000-000000000001', 'fulfillment-boundary@example.invalid', 'Boundary', 'Buyer', '+00000000000');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('f8100000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000001', 'shipping', '1 Fixture Street', 'Testville', '00000', public.platform_region_code());
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('f8100000-0000-4000-8000-000000000003', 'fulfillment-boundary', 'Boundary fixture', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('f8100000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000003', 'FULFILLMENT-BOUNDARY', 'Boundary fixture', 'other', 'active', 1, 1);
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable, provider_kind)
VALUES ('f8100000-0000-4000-8000-000000000005', 'fulfillment-boundary', 'Boundary fixture', 'internal_warehouse', 'active', true, :'fixture_provider');
INSERT INTO public.inventory_balances (sku_id, location_id, on_hand, reserved)
VALUES ('f8100000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000005', 10, 4);
INSERT INTO public.commerce_orders (id, client_id, shipping_address_id, order_number, status, mode, currency, region_code, subtotal_cents, total_cents)
VALUES ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000002', 'FULFILLMENT-BOUNDARY-1', 'paid', 'one_time', public.platform_settlement_currency(), public.platform_region_code(), 2000, 2000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, vat_rate_bps, discount_allocated_cents, effective_total_cents, effective_net_cents, allocation_ordinal)
VALUES ('f8100000-0000-4000-8000-000000000021', 'f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000004', 2, 1000, 2000, 0, 0, 2000, 2000, 1);
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('f8100000-0000-4000-8000-000000000031', 'f8100000-0000-4000-8000-000000000011', 'noop_payment', 'boundary-payment-1', 'succeeded', 2000, public.platform_settlement_currency());
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency)
VALUES ('f8100000-0000-4000-8000-000000000041', 'one_time_order', 'f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000031', 'succeeded', 2000, public.platform_settlement_currency());
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind)
VALUES ('f8100000-0000-4000-8000-000000000051', 'boundary-reservation-1', 'f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000021', 'f8100000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000005', 2, 'reserved', 'checkout_payment_window');
INSERT INTO public.commerce_orders (id, client_id, shipping_address_id, order_number, status, mode, currency, region_code, subtotal_cents, total_cents)
VALUES ('f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000002', 'FULFILLMENT-BOUNDARY-2', 'paid', 'one_time', public.platform_settlement_currency(), public.platform_region_code(), 2000, 2000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, vat_rate_bps, discount_allocated_cents, effective_total_cents, effective_net_cents, allocation_ordinal)
VALUES ('f8100000-0000-4000-8000-000000000022', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000004', 2, 1000, 2000, 0, 0, 2000, 2000, 1);
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('f8100000-0000-4000-8000-000000000032', 'f8100000-0000-4000-8000-000000000012', 'noop_payment', 'boundary-payment-2', 'failed', 2000, public.platform_settlement_currency());
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency)
VALUES ('f8100000-0000-4000-8000-000000000042', 'one_time_order', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000032', 'failed', 2000, public.platform_settlement_currency());
INSERT INTO public.inventory_reservations (id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind)
VALUES ('f8100000-0000-4000-8000-000000000052', 'boundary-reservation-2', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000022', 'f8100000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000005', 2, 'reserved', 'checkout_payment_window');
INSERT INTO public.commerce_orders (id, client_id, shipping_address_id, order_number, status, mode, currency, region_code, subtotal_cents, total_cents)
VALUES ('f8100000-0000-4000-8000-000000000013', 'f8100000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000002', 'FULFILLMENT-BOUNDARY-3', 'paid', 'one_time', public.platform_settlement_currency(), public.platform_region_code(), 2000, 2000);
INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, vat_rate_bps, discount_allocated_cents, effective_total_cents, effective_net_cents, allocation_ordinal)
VALUES ('f8100000-0000-4000-8000-000000000023', 'f8100000-0000-4000-8000-000000000013', 'f8100000-0000-4000-8000-000000000004', 2, 1000, 2000, 0, 0, 2000, 2000, 1);
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('f8100000-0000-4000-8000-000000000033', 'f8100000-0000-4000-8000-000000000013', 'noop_payment', 'boundary-payment-3', 'succeeded', 2000, public.platform_settlement_currency());
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, payment_id, status, amount_cents, currency)
VALUES ('f8100000-0000-4000-8000-000000000043', 'one_time_order', 'f8100000-0000-4000-8000-000000000013', 'f8100000-0000-4000-8000-000000000033', 'succeeded', 2000, public.platform_settlement_currency());
CREATE FUNCTION pg_temp.boundary_state() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object(
'commerce_orders', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_orders r WHERE id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'commerce_order_items', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_order_items r WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'),
'commerce_payment_intents', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_intents r WHERE id IN ('f8100000-0000-4000-8000-000000000041', 'f8100000-0000-4000-8000-000000000042', 'f8100000-0000-4000-8000-000000000043')),
'commerce_payments', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payments r WHERE id IN ('f8100000-0000-4000-8000-000000000031', 'f8100000-0000-4000-8000-000000000032', 'f8100000-0000-4000-8000-000000000033')),
'inventory_balances', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_balances r WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'),
'inventory_reservations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_reservations r WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'),
'inventory_stock_movements', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_stock_movements r WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'),
'commerce_fulfillment_orders', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_fulfillment_orders r WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'commerce_fulfillment_order_lines', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_fulfillment_order_lines r WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'commerce_fulfillment_operations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_fulfillment_operations r WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'commerce_fulfillment_provider_attempts', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_fulfillment_provider_attempts r WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'shipment_external_refs', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.shipment_external_refs r WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'commerce_order_holds', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_order_holds r WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')),
'outbox_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.outbox_events r WHERE aggregate_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013') OR aggregate_id IN (SELECT id FROM public.commerce_fulfillment_orders WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')))
); $$;
SELECT is((SELECT count(*)::integer FROM public.commerce_order_items WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'), 3, 'three nonempty order lines pin the positive and refusal fixtures');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'), 2, 'the paid and failed-payment fixtures hold real reservations');
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_orders WHERE order_id IN ('f8100000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000013')), 0, 'fixture starts with no parcel');
SELECT pg_temp.boundary_state() AS before_refusal \gset
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.commerce_fulfillment_create_order('boundary-failed-payment', 'f8100000-0000-4000-8000-000000000012', NULL, '{}')$$, '22023', 'commerce_fulfillment_payment_not_succeeded', 'service caller refuses a failed payment');
SELECT throws_ok($$SELECT public.commerce_fulfillment_create_order('boundary-no-reservation', 'f8100000-0000-4000-8000-000000000013', NULL, '{}')$$, '22023', 'commerce_fulfillment_missing_inventory_reservation', 'service caller refuses absent reservation');
RESET ROLE;
SELECT is(pg_temp.boundary_state(), :'before_refusal'::jsonb, 'refusals leave the complete fixture state unchanged');
SET LOCAL ROLE service_role;
SELECT public.commerce_fulfillment_create_order('boundary-create-order', 'f8100000-0000-4000-8000-000000000011', NULL, '{}') AS fresh \gset
RESET ROLE;
SELECT is(:'fresh'::jsonb->>'replayed', 'false', 'service role creates a fresh parcel');
SELECT (:'fresh'::jsonb->>'fulfillmentOrderId') AS parcel \gset
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_orders WHERE order_id = 'f8100000-0000-4000-8000-000000000011'), 1, 'fresh call persists one parcel');
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_order_lines WHERE fulfillment_order_id = :'parcel'::uuid AND quantity = 2 AND inventory_reservation_ids = ARRAY['f8100000-0000-4000-8000-000000000051'::uuid]), 1, 'fresh parcel binds the real line and reservation');
SELECT is((SELECT status FROM public.commerce_fulfillment_orders WHERE id = :'parcel'::uuid), 'created', 'fresh parcel has durable created status');
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_operations WHERE fulfillment_order_id = :'parcel'::uuid AND operation_type = 'created'), 1, 'fresh parcel persists one creation operation');
SELECT pg_temp.boundary_state() AS after_create \gset
SET LOCAL ROLE service_role;
SELECT public.commerce_fulfillment_create_order('boundary-create-order', 'f8100000-0000-4000-8000-000000000011', NULL, '{}') AS replay \gset
RESET ROLE;
SELECT is(:'replay'::jsonb->>'replayed', 'true', 'identical service call replays');
SELECT is(:'replay'::jsonb->>'fulfillmentOrderId', :'parcel', 'replay returns the same parcel');
SELECT is(pg_temp.boundary_state(), :'after_create'::jsonb, 'create replay leaves complete fixture state unchanged');
-- Effective ACL plus exact role-taking refusals distinguish entrypoint denial from a body failure.
SELECT is(has_function_privilege('anon', 'public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)', 'EXECUTE'), false, 'anon effective execute boundary for commerce_fulfillment_create_order');
SELECT is(has_function_privilege('authenticated', 'public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)', 'EXECUTE'), false, 'authenticated effective execute boundary for commerce_fulfillment_create_order');
SELECT is(has_function_privilege('service_role', 'public.commerce_fulfillment_create_order(text,uuid,uuid,jsonb)', 'EXECUTE'), true, 'service_role effective execute boundary for commerce_fulfillment_create_order');
SELECT is(has_function_privilege('anon', 'public.commerce_fulfillment_record_label_created(text,uuid,text,text,text,integer,jsonb,uuid,jsonb)', 'EXECUTE'), false, 'anon effective execute boundary for commerce_fulfillment_record_label_created');
SELECT is(has_function_privilege('authenticated', 'public.commerce_fulfillment_record_label_created(text,uuid,text,text,text,integer,jsonb,uuid,jsonb)', 'EXECUTE'), false, 'authenticated effective execute boundary for commerce_fulfillment_record_label_created');
SELECT is(has_function_privilege('service_role', 'public.commerce_fulfillment_record_label_created(text,uuid,text,text,text,integer,jsonb,uuid,jsonb)', 'EXECUTE'), true, 'service_role effective execute boundary for commerce_fulfillment_record_label_created');
SELECT is(has_function_privilege('anon', 'public.commerce_fulfillment_mark_handed_over(text,uuid,uuid,jsonb)', 'EXECUTE'), false, 'anon effective execute boundary for commerce_fulfillment_mark_handed_over');
SELECT is(has_function_privilege('authenticated', 'public.commerce_fulfillment_mark_handed_over(text,uuid,uuid,jsonb)', 'EXECUTE'), false, 'authenticated effective execute boundary for commerce_fulfillment_mark_handed_over');
SELECT is(has_function_privilege('service_role', 'public.commerce_fulfillment_mark_handed_over(text,uuid,uuid,jsonb)', 'EXECUTE'), true, 'service_role effective execute boundary for commerce_fulfillment_mark_handed_over');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.commerce_fulfillment_create_order('boundary-create-order', 'f8100000-0000-4000-8000-000000000011', NULL, '{}')$$, '42501', 'permission denied for function commerce_fulfillment_create_order', 'anon cannot create or replay a parcel');
SELECT throws_ok(format($$SELECT public.commerce_fulfillment_record_label_created('boundary-label', %L::uuid, %L, 'boundary-tracking')$$, :'parcel', :'fixture_provider'), '42501', 'permission denied for function commerce_fulfillment_record_label_created', 'anon cannot record a label');
SELECT throws_ok(format($$SELECT public.commerce_fulfillment_mark_handed_over('boundary-handoff', %L::uuid, NULL, '{}')$$, :'parcel'), '42501', 'permission denied for function commerce_fulfillment_mark_handed_over', 'anon cannot hand off a parcel');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.commerce_fulfillment_create_order('boundary-create-order', 'f8100000-0000-4000-8000-000000000011', NULL, '{}')$$, '42501', 'permission denied for function commerce_fulfillment_create_order', 'authenticated cannot create or replay a parcel');
SELECT throws_ok(format($$SELECT public.commerce_fulfillment_record_label_created('boundary-label', %L::uuid, %L, 'boundary-tracking')$$, :'parcel', :'fixture_provider'), '42501', 'permission denied for function commerce_fulfillment_record_label_created', 'authenticated cannot record a label');
SELECT throws_ok(format($$SELECT public.commerce_fulfillment_mark_handed_over('boundary-handoff', %L::uuid, NULL, '{}')$$, :'parcel'), '42501', 'permission denied for function commerce_fulfillment_mark_handed_over', 'authenticated cannot hand off a parcel');
RESET ROLE;
SELECT is(pg_temp.boundary_state(), :'after_create'::jsonb, 'browser refusals leave complete fixture state unchanged');
SELECT jsonb_build_array(pg_temp.boundary_state()->'inventory_balances', pg_temp.boundary_state()->'inventory_reservations', pg_temp.boundary_state()->'inventory_stock_movements') AS before_label_inventory \gset
SET LOCAL ROLE service_role;
SELECT public.commerce_fulfillment_record_label_created('boundary-label', :'parcel'::uuid, :'fixture_provider', 'boundary-tracking', 'https://example.invalid/label', 2, '{}', NULL, '{}') AS label \gset
RESET ROLE;
SELECT is(:'label'::jsonb->>'replayed', 'false', 'service role records a fresh label');
SELECT is((SELECT status FROM public.commerce_fulfillment_orders WHERE id = :'parcel'::uuid), 'label_created', 'label status is durable');
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_provider_attempts WHERE fulfillment_order_id = :'parcel'::uuid AND status = 'succeeded' AND provider_tracking_id = 'boundary-tracking'), 1, 'one succeeded provider attempt is durable');
SELECT is((SELECT count(*)::integer FROM public.shipment_external_refs WHERE fulfillment_order_id = :'parcel'::uuid AND provider_tracking_id = 'boundary-tracking' AND active), 1, 'one canonical tracking reference is durable');
SELECT is(jsonb_build_array(pg_temp.boundary_state()->'inventory_balances', pg_temp.boundary_state()->'inventory_reservations', pg_temp.boundary_state()->'inventory_stock_movements'), :'before_label_inventory'::jsonb, 'label creation leaves balances reservations and movements unchanged');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'), 0, 'no stock movement exists before handoff');
SELECT is((SELECT reserved::integer FROM public.inventory_balances WHERE sku_id = 'f8100000-0000-4000-8000-000000000004' AND location_id = 'f8100000-0000-4000-8000-000000000005'), 4, 'label retains both inventory holds');
SET LOCAL ROLE service_role;
SELECT public.commerce_fulfillment_mark_handed_over('boundary-handoff', :'parcel'::uuid, NULL, '{}') AS handoff \gset
RESET ROLE;
SELECT is(:'handoff'::jsonb->>'replayed', 'false', 'service role performs first generic handoff');
SELECT is((SELECT status FROM public.commerce_fulfillment_orders WHERE id = :'parcel'::uuid), 'handed_over', 'handoff status is durable');
SELECT ok((SELECT handed_over_at IS NOT NULL FROM public.commerce_fulfillment_orders WHERE id = :'parcel'::uuid), 'handoff timestamp is durable');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id = 'f8100000-0000-4000-8000-000000000051'), 'consumed', 'handoff consumes its bound reservation');
SELECT ok((SELECT consumed_at IS NOT NULL FROM public.inventory_reservations WHERE id = 'f8100000-0000-4000-8000-000000000051'), 'reservation consumption timestamp is durable');
SELECT is((SELECT status FROM public.inventory_reservations WHERE id = 'f8100000-0000-4000-8000-000000000052'), 'reserved', 'handoff leaves the failed-payment reservation held');
SELECT is((SELECT on_hand::integer FROM public.inventory_balances WHERE sku_id = 'f8100000-0000-4000-8000-000000000004' AND location_id = 'f8100000-0000-4000-8000-000000000005'), 8, 'handoff consumes exactly two on-hand units');
SELECT is((SELECT reserved::integer FROM public.inventory_balances WHERE sku_id = 'f8100000-0000-4000-8000-000000000004' AND location_id = 'f8100000-0000-4000-8000-000000000005'), 2, 'handoff releases exactly its two reserved units');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE sku_id = 'f8100000-0000-4000-8000-000000000004' AND reservation_id = 'f8100000-0000-4000-8000-000000000051' AND movement_type = 'reservation_consumed' AND quantity_delta = -2), 1, 'one consumption movement records the exact decrement');
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_operations WHERE fulfillment_order_id = :'parcel'::uuid AND operation_type = 'handed_over'), 1, 'one handoff operation is durable');
SELECT is((SELECT count(*)::integer FROM public.inventory_stock_movements WHERE sku_id = 'f8100000-0000-4000-8000-000000000004'), 1, 'handoff creates exactly one total stock movement');
SELECT pg_temp.boundary_state() AS after_handoff \gset
SET LOCAL ROLE service_role;
SELECT public.commerce_fulfillment_mark_handed_over('boundary-handoff', :'parcel'::uuid, NULL, '{}') AS handoff_replay \gset
RESET ROLE;
SELECT is(:'handoff_replay'::jsonb->>'replayed', 'true', 'repeated handoff replays');
SELECT is(pg_temp.boundary_state(), :'after_handoff'::jsonb, 'repeated handoff changes no parcel inventory operation or outbox row');
SELECT * FROM finish();
ROLLBACK;
