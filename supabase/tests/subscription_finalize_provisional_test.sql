-- pgTAP: Model B — subscription_create_provisional_for_checkout + the constraint
-- fix it enables. Verifies migration 20260610150000:
--   * the helper creates a pending_activation subscription, subscription_lines,
--     and a payment_pending cycle #1 whose template_snapshot satisfies the
--     payment-pending template guard (20260605144000)
--   * with both sub-ids set, an order can move to mode='subscription_cycle'
--     WITHOUT tripping commerce_orders_subscription_cycle_mode_check (23514) —
--     the exact failure Model B fixes
--   * missing cadence is rejected
--
-- Run via: supabase test db

BEGIN;
SELECT plan(27);

-- ---- Fixture (all-hex uuids) ----------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'modelb-provisional@example.invalid');

INSERT INTO public.pets (id, client_id, pet_type)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'dog');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'shipping', 'Testowa 1', 'Warszawa', '00-001');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('44444444-4444-4444-4444-444444444444', 'modelb-prov-prod', 'Model B Provisional Product', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status) VALUES
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'PROV-SKU-1', 'Prov SKU 1', 'dog', 400, 350, 'active'),
  ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', 'PROV-SKU-2', 'Prov SKU 2', 'dog', 400, 350, 'active');

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft');

INSERT INTO public.commerce_order_items (id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot) VALUES
  ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 2, 1340, 2680, 0, 2680, round((2680)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"PROV-SKU-1"}'::jsonb),
  ('99999999-9999-9999-9999-999999999999', '77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666666', 1, 1340, 1340, 0, 1340, round((1340)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"PROV-SKU-2"}'::jsonb);

-- ---- Run the helper, capture the returned ids -----------------------------
CREATE TEMP TABLE _prov AS
SELECT public.subscription_create_provisional_for_checkout(
  '77777777-7777-7777-7777-777777777777',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb
) AS r;

-- ---- Assertions -----------------------------------------------------------
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _prov)),
  'pending_activation',
  'provisional subscription is pending_activation'
);

SELECT is(
  (SELECT cadence_days FROM public.subscriptions WHERE id = (SELECT (r->>'subscriptionId')::uuid FROM _prov)),
  21,
  'cadence_days read from quote context'
);

SELECT is(
  (SELECT count(*)::int FROM public.subscription_lines WHERE subscription_id = (SELECT (r->>'subscriptionId')::uuid FROM _prov)),
  2,
  'one subscription_line per finalized order item'
);

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = (SELECT (r->>'subscriptionCycleId')::uuid FROM _prov)),
  'payment_pending',
  'cycle #1 is payment_pending (template guard satisfied on insert)'
);

SELECT is(
  (SELECT engine_idempotency_key FROM public.subscription_cycles WHERE id = (SELECT (r->>'subscriptionCycleId')::uuid FROM _prov)),
  'checkout-initial-cycle:77777777-7777-7777-7777-777777777777',
  'cycle #1 engine_idempotency_key uses the distinct checkout namespace'
);

-- The root fix: with both sub-ids set, the order can become subscription_cycle
-- without tripping commerce_orders_subscription_cycle_mode_check (23514).
SELECT lives_ok(
  $$UPDATE public.commerce_orders
       SET mode = 'subscription_cycle',
           subscription_id = (SELECT (r->>'subscriptionId')::uuid FROM _prov),
           subscription_cycle_id = (SELECT (r->>'subscriptionCycleId')::uuid FROM _prov)
     WHERE id = '77777777-7777-7777-7777-777777777777'$$,
  'order -> subscription_cycle with both ids set does NOT trip 23514'
);

-- The real finalize RPC path creates and links the provisional records
-- atomically, then replays idempotently without minting another cycle.
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, metadata)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":21}'::jsonb,
  'draft',
  1340, 1340,
  jsonb_build_object(
    'quoteSnapshot', '{"quote":{"context":{"mode":"subscription","cadenceDays":21},"lines":[{"pricingComponents":[{"componentType":"mode_discount"}]}]}}'::jsonb,
    'orderDraftSnapshot', '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb
  )
);

INSERT INTO public.commerce_order_items (id, order_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 1340, 1340, 0, 1340, round((1340)::numeric * 10000 / (10000 + (800)::integer))::integer, '{"sku":"PROV-SKU-1"}'::jsonb);

CREATE TEMP TABLE _finalized AS
SELECT public.commerce_finalize_order_for_checkout(
  'modelb-finalize-1',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'subscription_cycle',
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21},"lines":[{"pricingComponents":[{"componentType":"mode_discount"}]}]}}'::jsonb,
  '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb,
  jsonb_build_object(
    'source', 'pgtap',
    'invoiceBuyerSnapshot', jsonb_build_object(
      'name', 'Example Company Sp. z o.o.',
      'email', 'invoice@example.invalid',
      'taxId', '1234563218',
      'companyName', 'Example Company Sp. z o.o.',
      'source', 'checkout_invoice_preference',
      'address', jsonb_build_object(
        'line1', 'Krolewska 1',
        'line2', NULL,
        'city', 'Krakow',
        'postalCode', '30-001',
        'country', 'PL',
        'source', 'checkout_invoice_billing_address'
      )
    )
  )
) AS r;

SELECT ok(
  (SELECT subscription_id IS NOT NULL AND subscription_cycle_id IS NOT NULL FROM public.commerce_orders WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'finalize RPC links both subscription ids on the order'
);

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = (SELECT (r #>> '{finalizedOrder,subscriptionId}')::uuid FROM _finalized)),
  'pending_activation',
  'finalize RPC creates a pending_activation subscription'
);

SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = (SELECT (r #>> '{finalizedOrder,subscriptionCycleId}')::uuid FROM _finalized)),
  'payment_pending',
  'finalize RPC creates payment_pending cycle #1'
);

SELECT is(
  (SELECT count(*)::int FROM public.subscription_cycles WHERE order_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'finalize RPC creates exactly one cycle for the checkout order'
);

SELECT is(
  (SELECT metadata #>> '{invoiceBuyerSnapshot,taxId}' FROM public.commerce_orders WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '1234563218',
  'finalize RPC persists invoiceBuyerSnapshot at top-level order metadata'
);

SELECT is(
  (SELECT metadata #>> '{runtimeFinalize,invoiceBuyerSnapshot,taxId}' FROM public.commerce_orders WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  NULL,
  'runtimeFinalize metadata omits duplicate invoiceBuyerSnapshot PII'
);

CREATE TEMP TABLE _replayed AS
SELECT public.commerce_finalize_order_for_checkout(
  'modelb-finalize-1',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'subscription_cycle',
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21},"lines":[{"pricingComponents":[{"componentType":"mode_discount"}]}]}}'::jsonb,
  '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb,
  jsonb_build_object(
    'source', 'pgtap',
    'invoiceBuyerSnapshot', jsonb_build_object(
      'name', 'Example Company Sp. z o.o.',
      'email', 'invoice@example.invalid',
      'taxId', '1234563218',
      'companyName', 'Example Company Sp. z o.o.',
      'source', 'checkout_invoice_preference',
      'address', jsonb_build_object(
        'line1', 'Krolewska 1',
        'line2', NULL,
        'city', 'Krakow',
        'postalCode', '30-001',
        'country', 'PL',
        'source', 'checkout_invoice_billing_address'
      )
    )
  )
);

SELECT is(
  (SELECT count(*)::int FROM public.subscription_cycles WHERE order_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'idempotent finalize replay does not create a second cycle'
);

-- CP1-0: a neutral command uses the same persistence RPC without petProfile.
-- It must create only the client/address identity, then finalize the same
-- provisional subscription path with a NULL subject. No synthetic pet is a
-- permitted fallback, and both persist/finalize replays remain idempotent.
CREATE TEMP TABLE _neutral_intent AS
SELECT intent,
       public.commerce_configurator_persist_intent(intent) AS resp
  FROM (VALUES (
    jsonb_build_object(
      'version', 'commerce.checkout_command.v1',
      'idempotencyKey', 'neutral-subscription-intent-0001',
      'mode', 'subscription',
      'lines', jsonb_build_array(jsonb_build_object('sku', 'PROV-SKU-1', 'quantity', 1)),
      'customer', jsonb_build_object(
        'firstName', 'Neutral', 'lastName', 'Customer',
        'email', 'neutral-subscription@example.invalid', 'phone', '+48123456788'
      ),
      'shippingAddress', jsonb_build_object(
        'street', 'Neutralna 1', 'postalCode', '00-003', 'city', 'Warszawa', 'country', 'PL'
      ),
      'currency', 'PLN',
      'cadenceDays', 21
    )
  )) AS command(intent);

SELECT is(
  (SELECT resp->>'petId' FROM _neutral_intent),
  NULL,
  'neutral persist returns petId null when petProfile is omitted'
);

SELECT is(
  (SELECT count(*)::int FROM public.pets
    WHERE client_id = (SELECT (resp->>'clientId')::uuid FROM _neutral_intent)),
  0,
  'neutral persist does not synthesize a pet'
);

CREATE TEMP TABLE _neutral_intent_replay AS
SELECT public.commerce_configurator_persist_intent(intent) AS resp
  FROM _neutral_intent;

SELECT is(
  (SELECT jsonb_build_object(
    'replayed', resp->>'replayed',
    'clientId', resp->>'clientId',
    'petId', resp->>'petId'
  ) FROM _neutral_intent_replay),
  (SELECT jsonb_build_object(
    'replayed', 'true',
    'clientId', resp->>'clientId',
    'petId', resp->>'petId'
  ) FROM _neutral_intent),
  'neutral persist replay returns the same null-pet identity'
);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status, total_cents,
  subtotal_cents, metadata
)
SELECT
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  (resp->>'clientId')::uuid,
  'PLN', 'PL', '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 1340, 1340,
  jsonb_build_object(
    'quoteSnapshot', '{"quote":{"context":{"mode":"subscription","cadenceDays":21},"lines":[{"pricingComponents":[{"componentType":"mode_discount"}]}]}}'::jsonb,
    'orderDraftSnapshot', '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb
  )
FROM _neutral_intent;

INSERT INTO public.commerce_order_items (
  id, order_id, quantity, unit_price_cents, total_cents, discount_allocated_cents,
  effective_total_cents, effective_net_cents, product_snapshot
) VALUES (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  1, 1340, 1340, 0, 1340,
  round((1340)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"sku":"PROV-SKU-1"}'::jsonb
);

CREATE TEMP TABLE _neutral_finalized AS
SELECT public.commerce_finalize_order_for_checkout(
  'neutral-subscription-finalize-0001',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'subscription_cycle',
  (resp->>'clientId')::uuid,
  (resp->>'addressId')::uuid,
  NULL,
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21},"lines":[{"pricingComponents":[{"componentType":"mode_discount"}]}]}}'::jsonb,
  '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb,
  '{"source":"pgtap-neutral","checkoutCommandVersion":"commerce.checkout_command.v1"}'::jsonb
) AS resp
FROM _neutral_intent;

SELECT is(
  (SELECT resp #>> '{finalizedOrder,petId}' FROM _neutral_finalized),
  NULL,
  'neutral finalize response preserves petId null'
);

SELECT is(
  (SELECT pet_id FROM public.commerce_orders WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  NULL,
  'neutral finalized order persists a null pet_id'
);

SELECT is(
  (SELECT pet_id FROM public.subscriptions
    WHERE id = (SELECT (resp #>> '{finalizedOrder,subscriptionId}')::uuid FROM _neutral_finalized)),
  NULL,
  'neutral provisional subscription persists a null pet_id'
);

SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id = (SELECT (resp #>> '{finalizedOrder,subscriptionId}')::uuid FROM _neutral_finalized)),
  'pending_activation',
  'neutral finalize retains the existing provisional subscription behavior'
);

SELECT is(
  (SELECT count(*)::int FROM public.pets
    WHERE client_id = (SELECT (resp->>'clientId')::uuid FROM _neutral_intent)),
  0,
  'neutral finalization does not synthesize a pet'
);

CREATE TEMP TABLE _neutral_finalized_replay AS
SELECT public.commerce_finalize_order_for_checkout(
  'neutral-subscription-finalize-0001',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'subscription_cycle',
  (resp->>'clientId')::uuid,
  (resp->>'addressId')::uuid,
  NULL,
  '{"quote":{"context":{"mode":"subscription","cadenceDays":21},"lines":[{"pricingComponents":[{"componentType":"mode_discount"}]}]}}'::jsonb,
  '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb,
  '{"source":"pgtap-neutral","checkoutCommandVersion":"commerce.checkout_command.v1"}'::jsonb
) AS resp
FROM _neutral_intent;

SELECT is(
  (SELECT count(*)::int FROM public.subscription_cycles
    WHERE order_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  1,
  'neutral finalize replay does not create a second provisional cycle'
);

-- CP1-B2: the existing Model-B webhook confirmation must keep the neutral
-- subject NULL on first delivery and on replay. The wrapper resolves the same
-- provisional aggregate by payment intent; it must not reintroduce a legacy
-- pet requirement or synthesize a pet while activating it.
UPDATE public.commerce_orders
   SET status = 'paid'
 WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

INSERT INTO public.commerce_payments (
  id, order_id, provider, amount_cents, currency, status
)
SELECT
  '12121212-1212-1212-1212-121212121212',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'reference_fixture',
  1340,
  currency,
  'succeeded'
FROM public.commerce_orders
WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id,
  payment_id, amount_cents, currency, status
)
SELECT
  '13131313-1313-1313-1313-131313131313',
  'subscription_cycle',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  (resp #>> '{finalizedOrder,subscriptionId}')::uuid,
  (resp #>> '{finalizedOrder,subscriptionCycleId}')::uuid,
  '12121212-1212-1212-1212-121212121212',
  1340,
  (SELECT currency FROM public.commerce_orders
    WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  'succeeded'
FROM _neutral_finalized;

CREATE TEMP TABLE _neutral_confirmed AS
SELECT public.commerce_webhook_confirm_subscription_from_intent(
  'neutral-subscription-confirm-0001',
  '13131313-1313-1313-1313-131313131313',
  'pm_neutral_reference',
  'card',
  '2026-07-11T10:00:00Z'::timestamptz
) AS resp;

SELECT is(
  (SELECT jsonb_build_object(
    'status', resp #>> '{webhookSubscriptionConfirm,confirmation,status}',
    'petId', (SELECT pet_id::text FROM public.subscriptions
      WHERE id = (SELECT (resp #>> '{finalizedOrder,subscriptionId}')::uuid FROM _neutral_finalized))
  ) FROM _neutral_confirmed),
  '{"status":"active","petId":null}'::jsonb,
  'Model-B confirmation activates the neutral subscription without a pet'
);

CREATE TEMP TABLE _neutral_confirmed_replay AS
SELECT public.commerce_webhook_confirm_subscription_from_intent(
  'neutral-subscription-confirm-0001',
  '13131313-1313-1313-1313-131313131313',
  'pm_neutral_reference',
  'card',
  '2026-07-11T10:00:00Z'::timestamptz
) AS resp;

SELECT is(
  (SELECT jsonb_build_object(
    'replayed', resp #>> '{webhookSubscriptionConfirm,confirmation,replayed}',
    'petId', (SELECT pet_id::text FROM public.subscriptions
      WHERE id = (SELECT (resp #>> '{finalizedOrder,subscriptionId}')::uuid FROM _neutral_finalized))
  ) FROM _neutral_confirmed_replay),
  '{"replayed":"true","petId":null}'::jsonb,
  'Model-B confirmation replay preserves the same pet-less aggregate'
);

-- Missing cadence is rejected before any write.
SELECT throws_ok(
  $$SELECT public.subscription_create_provisional_for_checkout(
      '77777777-7777-7777-7777-777777777777',
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '{"quote":{"context":{"mode":"subscription"}}}'::jsonb
    )$$,
  '22023', NULL, 'missing cadenceDays is rejected'
);

-- The subscription-requires-pet guard is scoped to the LEGACY path: without the
-- neutral marker in p_metadata a NULL pet must still fail closed. 20260728120000
-- dropped this guard outright, which let an expired-checkout recovery of an order
-- whose pet had been deleted (pet_id is ON DELETE SET NULL) mint a pet-less
-- pending_activation subscription.
SELECT throws_ok(
  $$SELECT public.commerce_finalize_order_for_checkout(
      'legacy-nullpet-finalize-0001',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'subscription_cycle',
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      NULL,
      '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb,
      '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb
    )$$,
  '22023', 'commerce_runtime_finalize_subscription_requires_pet',
  'legacy subscription finalize with a null pet fails closed (default metadata)'
);

-- A non-neutral marker value must not exempt either (fail-closed comparison).
SELECT throws_ok(
  $$SELECT public.commerce_finalize_order_for_checkout(
      'legacy-nullpet-finalize-0002',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'subscription_cycle',
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      NULL,
      '{"quote":{"context":{"mode":"subscription","cadenceDays":21}}}'::jsonb,
      '{"items":[{"sku":"PROV-SKU-1","quantity":1}]}'::jsonb,
      '{"source":"pgtap-legacy","checkoutCommandVersion":"commerce.configurator_intent.v1"}'::jsonb
    )$$,
  '22023', 'commerce_runtime_finalize_subscription_requires_pet',
  'a non-neutral command version does not exempt the null-pet guard'
);

SELECT * FROM finish();
ROLLBACK;
