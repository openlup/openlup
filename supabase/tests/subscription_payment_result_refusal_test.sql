-- pgTAP: the exact deprecated payment-result RPCs refuse as service_role,
-- including identical repeated calls, without changing complete writer rows.
-- Browser roles must fail at EXECUTE admission for all three legacy symbols.
-- No application grants, activation, provider access or deployment seeds are added.
BEGIN;
\ir fixtures/settlement.inc
SELECT plan(27);

INSERT INTO public.clients (id, email)
VALUES ('fa910000-0000-4000-8000-000000000001', 'payment-result-refusal@example.invalid');
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, region_code, status)
VALUES ('fa910000-0000-4000-8000-000000000002', 'fa910000-0000-4000-8000-000000000001', 28, :'fixture_currency', :'fixture_region', 'pending_activation');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('fa910000-0000-4000-8000-000000000003', 'fa910000-0000-4000-8000-000000000002', 1, '2026-09-01T10:00:00Z', 'planned', 'payment-result-refusal-cycle');
INSERT INTO public.commerce_orders (id, client_id, status, mode, currency, region_code, subtotal_cents, total_cents, subscription_id, subscription_cycle_id)
VALUES ('fa910000-0000-4000-8000-000000000004', 'fa910000-0000-4000-8000-000000000001', 'pending_payment', 'subscription_cycle', :'fixture_currency', :'fixture_region', 1000, 1000, 'fa910000-0000-4000-8000-000000000002', 'fa910000-0000-4000-8000-000000000003');
INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('fa910000-0000-4000-8000-000000000005', 'fa910000-0000-4000-8000-000000000004', 'refusal_fixture', 'refusal-fixture-payment', 'pending', 1000, :'fixture_currency');
SELECT is((SELECT count(*)::integer FROM public.commerce_payments p
  JOIN public.commerce_orders o ON o.id = p.order_id
  JOIN public.subscription_cycles c ON c.id = o.subscription_cycle_id
  JOIN public.subscriptions s ON s.id = c.subscription_id AND s.id = o.subscription_id
  WHERE p.id = 'fa910000-0000-4000-8000-000000000005' AND p.status = 'pending'
    AND o.status = 'pending_payment' AND s.status = 'pending_activation'), 1,
  'the refusal addresses an existing nonempty payment/order/cycle/subscription graph');

SELECT ok(has_function_privilege('service_role', 'public.subscription_apply_payment_success(text,uuid,text,timestamptz,jsonb)', 'EXECUTE'),
  'subscription_apply_payment_success: service_role retains effective EXECUTE');
SELECT ok(NOT has_function_privilege('anon', 'public.subscription_apply_payment_success(text,uuid,text,timestamptz,jsonb)', 'EXECUTE'),
  'subscription_apply_payment_success: anon has no effective EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.subscription_apply_payment_success(text,uuid,text,timestamptz,jsonb)', 'EXECUTE'),
  'subscription_apply_payment_success: authenticated has no effective EXECUTE');
SELECT ok(has_function_privilege('service_role', 'public.subscription_apply_payment_failure(text,uuid,timestamptz,text,jsonb)', 'EXECUTE'),
  'subscription_apply_payment_failure: service_role retains effective EXECUTE');
SELECT ok(NOT has_function_privilege('anon', 'public.subscription_apply_payment_failure(text,uuid,timestamptz,text,jsonb)', 'EXECUTE'),
  'subscription_apply_payment_failure: anon has no effective EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.subscription_apply_payment_failure(text,uuid,timestamptz,text,jsonb)', 'EXECUTE'),
  'subscription_apply_payment_failure: authenticated has no effective EXECUTE');
SELECT ok(has_function_privilege('service_role', 'public.subscription_record_missing_payment_method(text,uuid,integer,timestamptz,jsonb,jsonb,timestamptz)', 'EXECUTE'),
  'subscription_record_missing_payment_method: service_role retains effective EXECUTE');
SELECT ok(NOT has_function_privilege('anon', 'public.subscription_record_missing_payment_method(text,uuid,integer,timestamptz,jsonb,jsonb,timestamptz)', 'EXECUTE'),
  'subscription_record_missing_payment_method: anon has no effective EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.subscription_record_missing_payment_method(text,uuid,integer,timestamptz,jsonb,jsonb,timestamptz)', 'EXECUTE'),
  'subscription_record_missing_payment_method: authenticated has no effective EXECUTE');

-- Owner-only readback covers every row and column, including unrelated rows.
-- The view is transaction-local; callers never receive a readback grant.
CREATE TEMP VIEW refusal_writer_state AS
SELECT jsonb_build_object(
  'subscriptions', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscriptions r),
  'subscription_cycles', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_cycles r),
  'subscription_lines', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_lines r),
  'commerce_orders', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_orders r),
  'commerce_order_items', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_order_items r),
  'commerce_payments', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payments r),
  'commerce_payment_intents', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_intents r),
  'commerce_payment_attempts', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_attempts r),
  'commerce_payment_state_transitions', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_payment_state_transitions r),
  'commerce_idempotency_keys', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.commerce_idempotency_keys r),
  'subscription_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_events r),
  'subscription_dunning_cases', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_dunning_cases r),
  'subscription_dunning_notifications', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.subscription_dunning_notifications r),
  'outbox_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.outbox_events r),
  'inventory_reservations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_reservations r),
  'inventory_balances', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_balances r),
  'inventory_stock_movements', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM public.inventory_stock_movements r)
) AS state;
CREATE TEMP TABLE refusal_before AS SELECT state FROM refusal_writer_state;

SET LOCAL ROLE service_role;
SELECT is(current_user::text, 'service_role', 'legacy result calls use the runtime role');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_success('refusal-success-key', 'fa910000-0000-4000-8000-000000000005', 'refusal-provider-result', '2026-09-01T11:00:00Z', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '2F000', 'subscription_payment_result_deprecated_use_payment_control',
  'success attempt 1: exact legacy runtime call refuses the deprecated writer');
RESET ROLE;
SELECT is((SELECT state FROM refusal_writer_state), (SELECT state FROM refusal_before),
  'success attempt 1: complete writer state stays unchanged');

SET LOCAL ROLE service_role;
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_success('refusal-success-key', 'fa910000-0000-4000-8000-000000000005', 'refusal-provider-result', '2026-09-01T11:00:00Z', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '2F000', 'subscription_payment_result_deprecated_use_payment_control',
  'success attempt 2: exact legacy runtime call refuses the deprecated writer');
RESET ROLE;
SELECT is((SELECT state FROM refusal_writer_state), (SELECT state FROM refusal_before),
  'success attempt 2: complete writer state stays unchanged');

SET LOCAL ROLE service_role;
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_failure('refusal-failure-key', 'fa910000-0000-4000-8000-000000000005', '2026-09-01T11:00:00Z', 'synthetic_decline', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '2F000', 'subscription_payment_result_deprecated_use_payment_control',
  'failure attempt 1: exact legacy runtime call refuses the deprecated writer');
RESET ROLE;
SELECT is((SELECT state FROM refusal_writer_state), (SELECT state FROM refusal_before),
  'failure attempt 1: complete writer state stays unchanged');

SET LOCAL ROLE service_role;
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_failure('refusal-failure-key', 'fa910000-0000-4000-8000-000000000005', '2026-09-01T11:00:00Z', 'synthetic_decline', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '2F000', 'subscription_payment_result_deprecated_use_payment_control',
  'failure attempt 2: exact legacy runtime call refuses the deprecated writer');
RESET ROLE;
SELECT is((SELECT state FROM refusal_writer_state), (SELECT state FROM refusal_before),
  'failure attempt 2: complete writer state stays unchanged');

SET LOCAL ROLE anon;
SELECT is(current_user::text, 'anon', 'browser calls use anon');
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_success('refusal-success-key', 'fa910000-0000-4000-8000-000000000005', 'refusal-provider-result', '2026-09-01T11:00:00Z', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '42501', 'permission denied for function subscription_apply_payment_success',
  'anon: success refuses at EXECUTE admission');
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_failure('refusal-failure-key', 'fa910000-0000-4000-8000-000000000005', '2026-09-01T11:00:00Z', 'synthetic_decline', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '42501', 'permission denied for function subscription_apply_payment_failure',
  'anon: failure refuses at EXECUTE admission');
SELECT throws_ok($call$ SELECT public.subscription_record_missing_payment_method('refusal-missing-key', 'fa910000-0000-4000-8000-000000000002', 2, '2026-10-01T10:00:00Z', '{}'::jsonb, '{}'::jsonb, '2026-10-01T11:00:00Z') $call$,
  '42501', 'permission denied for function subscription_record_missing_payment_method',
  'anon: missing refuses at EXECUTE admission');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT is(current_user::text, 'authenticated', 'browser calls use authenticated');
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_success('refusal-success-key', 'fa910000-0000-4000-8000-000000000005', 'refusal-provider-result', '2026-09-01T11:00:00Z', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '42501', 'permission denied for function subscription_apply_payment_success',
  'authenticated: success refuses at EXECUTE admission');
SELECT throws_ok($call$ SELECT public.subscription_apply_payment_failure('refusal-failure-key', 'fa910000-0000-4000-8000-000000000005', '2026-09-01T11:00:00Z', 'synthetic_decline', '{"source":"refusal_fixture"}'::jsonb) $call$,
  '42501', 'permission denied for function subscription_apply_payment_failure',
  'authenticated: failure refuses at EXECUTE admission');
SELECT throws_ok($call$ SELECT public.subscription_record_missing_payment_method('refusal-missing-key', 'fa910000-0000-4000-8000-000000000002', 2, '2026-10-01T10:00:00Z', '{}'::jsonb, '{}'::jsonb, '2026-10-01T11:00:00Z') $call$,
  '42501', 'permission denied for function subscription_record_missing_payment_method',
  'authenticated: missing refuses at EXECUTE admission');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
