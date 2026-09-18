-- pgTAP: accounting invoice buyer source hardening.
-- Verifies that fulfillment handoff uses explicit billing/orderer data before
-- any shipping-address fallback and still blocks invalid billing NIP.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(32);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'client-billing-source@example.invalid',
  'Ship',
  'Recipient'
);

INSERT INTO public.addresses (
  id, client_id, kind, label, recipient_name, company_name, tax_id,
  line1, city, postal_code, country, is_default, source
) VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'shipping',
    'Shipping',
    'Shipping Recipient',
    'Shipping Company Sp zoo',
    '123',
    'Shipping 1',
    'Warszawa',
    '00-001',
    'PL',
    true,
    'checkout'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    'billing',
    'Billing',
    'Billing Recipient',
    'Billing Address Sp zoo',
    '1234563218',
    'Billing 7',
    'Krakow',
    '30-001',
    'PL',
    true,
    'customer_account'
  );

INSERT INTO public.customer_orderer_profiles (
  id, client_id, label, full_name, email, company_name, tax_id, is_default, source
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Invoice buyer',
  'Invoice Contact',
  'invoice-buyer@example.invalid',
  'Invoice Buyer Sp zoo',
  '1234563218',
  true,
  'customer_account'
);

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('40000000-0000-0000-0000-000000000001', 'accounting-billing-source', 'Accounting Billing Source', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES (
  '50000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  'ABS-SKU-1',
  'Accounting Billing SKU',
  'dog',
  400,
  350,
  'active'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, currency, subtotal_cents, tax_cents,
  total_cents, shipping_address_id, metadata
) VALUES (
  '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'ABS-ORDER-1',
  'paid',
  'PLN',
  10800,
  800,
  10800,
  '20000000-0000-0000-0000-000000000001',
  '{}'::jsonb
);

INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
) VALUES (
  '70000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  1,
  10800,
  10800, 0, 10800, round((10800)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"title":"Accounting Billing SKU","vatRate":"8"}'::jsonb
);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '80000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  'stripe',
  'pi_billing_source_1',
  'succeeded',
  10800,
  'PLN'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency,
  provider_payment_id, updated_at
) VALUES (
  '90000000-0000-0000-0000-000000000001',
  'one_time_order',
  '60000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000001',
  'succeeded',
  10800,
  'PLN',
  'pi_billing_source_1',
  now()
);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot, handed_over_at
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'abs-fulfillment-1',
  'handed_over',
  '{"line1":"Shipping 1"}'::jsonb,
  now()
);

CREATE TEMP TABLE _accounting_issue AS
SELECT public.accounting_invoice_issue_request_from_handoff(
  'abs-accounting-1',
  'a0000000-0000-0000-0000-000000000001',
  'fakturownia_test'
) AS r;

SELECT is(
  (SELECT r #>> '{invoice,status}' FROM _accounting_issue),
  'issue_requested',
  'valid billing/orderer source requests invoice issue'
);

SELECT is(
  (SELECT document_kind FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'b2b_vat',
  'billing/orderer tax id routes as B2B VAT'
);

SELECT is(
  (SELECT buyer_snapshot->>'name' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'Invoice Buyer Sp zoo',
  'buyer name comes from orderer company, not shipping recipient'
);

SELECT is(
  (SELECT buyer_snapshot->>'email' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'invoice-buyer@example.invalid',
  'buyer email comes from orderer profile'
);

SELECT is(
  (SELECT buyer_snapshot->>'taxId' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  '1234563218',
  'buyer tax id comes from orderer profile and ignores invalid shipping tax id'
);

SELECT is(
  (SELECT buyer_snapshot->>'source' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'customer_orderer_profile',
  'buyer snapshot records customer orderer profile source'
);

SELECT is(
  (SELECT buyer_snapshot #>> '{address,source}' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'customer_billing_address',
  'buyer address records customer billing address source'
);

SELECT is(
  (SELECT buyer_snapshot #>> '{address,line1}' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'Billing 7',
  'buyer address differs from shipping address'
);

SELECT is(
  (SELECT buyer_snapshot->>'legacyFallback' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'false',
  'explicit billing source is not marked as legacy fallback'
);

SELECT is(
  (SELECT metadata->>'billingSnapshotSource' FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  'customer_orderer_profile',
  'invoice metadata records billing snapshot source'
);

SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoice_issue_outbox WHERE provider_kind = 'fakturownia_test'),
  1,
  'valid invoice creates one provider issue outbox row'
);

DELETE FROM public.accounting_invoice_issue_outbox
 WHERE invoice_id = (
   SELECT id
     FROM public.accounting_invoices
    WHERE order_id = '60000000-0000-0000-0000-000000000001'
 )
   AND provider_kind = 'fakturownia_test';

DO $replay$
BEGIN
  FOR replay_index IN 1..64 LOOP
    PERFORM public.accounting_invoice_issue_request_from_handoff(
      'abs-accounting-1',
      'a0000000-0000-0000-0000-000000000001',
      'fakturownia_test'
    );
  END LOOP;
END;
$replay$;

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = '60000000-0000-0000-0000-000000000001'
      AND operation.operation = 'issue_requested_from_handoff'
      AND operation.provider_kind = 'fakturownia_test'
      AND operation.payload->>'idempotencyKey' = 'abs-accounting-1'),
  1,
  '65 exact handoff replays keep one requested operation'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_issue_outbox
    WHERE invoice_id = (
      SELECT id
        FROM public.accounting_invoices
       WHERE order_id = '60000000-0000-0000-0000-000000000001'
    )
      AND provider_kind = 'fakturownia_test'),
  1,
  'handoff replay repairs a deleted pending issue outbox row'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = '60000000-0000-0000-0000-000000000001'),
  1,
  'deleted outbox repair does not append another accounting operation'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoices
    WHERE order_id = '60000000-0000-0000-0000-000000000001'),
  1,
  '65 total handoff calls keep one valid invoice'
);

SELECT lives_ok(
  $$SELECT public.accounting_invoice_issue_request_from_handoff(
    'fulfillment-handed-over-consumer-replay',
    'a0000000-0000-0000-0000-000000000001',
    'fakturownia_test'
  )$$,
  'a converging durable outbox caller reuses the existing invoice request'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = '60000000-0000-0000-0000-000000000001'
      AND operation.operation = 'issue_requested_from_handoff'
      AND operation.provider_kind = 'fakturownia_test'),
  1,
  'converging inline and outbox callers keep one handoff issue operation'
);

SELECT throws_ok(
  $$SELECT public.accounting_invoice_issue_request_from_handoff(
    'fulfillment-handed-over-provider-change',
    'a0000000-0000-0000-0000-000000000001',
    'another_provider'
  )$$,
  '23514',
  'accounting_invoice_provider_mismatch',
  'a replay cannot route the same invoice to a second provider'
);

SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET provider_kind = 'another_provider'
     WHERE order_id = '60000000-0000-0000-0000-000000000001'$$,
  '23514',
  'accounting_invoice_provider_immutable',
  'the provider pinned on an existing invoice cannot be changed before replay'
);

-- Invalid billing/orderer NIP must block and must not fall back to a valid
-- shipping tax id.
UPDATE public.customer_orderer_profiles
   SET tax_id = '123', updated_at = now()
 WHERE id = '30000000-0000-0000-0000-000000000001';

UPDATE public.addresses
   SET tax_id = '1234563218'
 WHERE id = '20000000-0000-0000-0000-000000000001';

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, currency, subtotal_cents, tax_cents,
  total_cents, shipping_address_id, metadata
) VALUES (
  '60000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'ABS-ORDER-2',
  'paid',
  'PLN',
  10800,
  800,
  10800,
  '20000000-0000-0000-0000-000000000001',
  '{}'::jsonb
);

INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot
) VALUES (
  '70000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000002',
  '50000000-0000-0000-0000-000000000001',
  1,
  10800,
  10800, 0, 10800, round((10800)::numeric * 10000 / (10000 + (800)::integer))::integer,
  '{"title":"Accounting Billing SKU","vatRate":"8"}'::jsonb
);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '80000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000002',
  'stripe',
  'pi_billing_source_2',
  'succeeded',
  10800,
  'PLN'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency,
  provider_payment_id, updated_at
) VALUES (
  '90000000-0000-0000-0000-000000000002',
  'one_time_order',
  '60000000-0000-0000-0000-000000000002',
  '80000000-0000-0000-0000-000000000002',
  'succeeded',
  10800,
  'PLN',
  'pi_billing_source_2',
  now()
);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot, handed_over_at
) VALUES (
  'a0000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'abs-fulfillment-2',
  'handed_over',
  '{"line1":"Shipping 1"}'::jsonb,
  now()
);

CREATE TEMP TABLE _accounting_blocked AS
SELECT public.accounting_invoice_issue_request_from_handoff(
  'abs-accounting-2',
  'a0000000-0000-0000-0000-000000000002',
  'fakturownia_test'
) AS r;

SELECT is(
  (SELECT r #>> '{invoice,status}' FROM _accounting_blocked),
  'blocked',
  'invalid billing/orderer tax id blocks invoice issue'
);

SELECT is(
  (SELECT blocked_reason FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000002'),
  'invalid_tax_id',
  'blocked invoice records invalid tax id reason'
);

SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoice_issue_outbox WHERE invoice_id = (
    SELECT id FROM public.accounting_invoices WHERE order_id = '60000000-0000-0000-0000-000000000002'
  )),
  0,
  'blocked invoice does not enqueue provider issue outbox'
);

DO $blocked_replay$
BEGIN
  FOR replay_index IN 1..64 LOOP
    PERFORM public.accounting_invoice_issue_request_from_handoff(
      'abs-accounting-2',
      'a0000000-0000-0000-0000-000000000002',
      'fakturownia_test'
    );
  END LOOP;
END;
$blocked_replay$;

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = '60000000-0000-0000-0000-000000000002'
      AND operation.operation = 'issue_blocked'
      AND operation.provider_kind = 'fakturownia_test'
      AND operation.payload->>'idempotencyKey' = 'abs-accounting-2'),
  1,
  'blocked handoff replays keep one blocked operation'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoices
    WHERE order_id = '60000000-0000-0000-0000-000000000002'
      AND status = 'blocked'),
  1,
  '65 total blocked handoff calls keep one blocked invoice'
);

SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_issue_outbox
    WHERE invoice_id = (
      SELECT id
        FROM public.accounting_invoices
       WHERE order_id = '60000000-0000-0000-0000-000000000002'
    )),
  0,
  'blocked handoff replays do not enqueue provider issue work'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.accounting_invoice_issue_request_from_handoff(text,uuid,text)',
    'EXECUTE'
  ),
  'service_role can execute the handoff invoice request RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.accounting_invoice_issue_request_from_handoff(text,uuid,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.accounting_invoice_issue_request_from_handoff(text,uuid,text)',
    'EXECUTE'
  ),
  'client roles cannot execute the handoff invoice request RPC'
);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'accounting_handoff_one',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'accounting_handoff_two',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

SELECT extensions.dblink_exec(
  'accounting_handoff_one',
  $setup$
    INSERT INTO public.clients (id, email, first_name, last_name)
    VALUES (
      'b0000000-0000-0000-0000-000000000001',
      'accounting-handoff-race@example.invalid',
      'Accounting',
      'Race'
    );
    INSERT INTO public.addresses (
      id, client_id, kind, recipient_name, line1, city, postal_code, country
    ) VALUES (
      'b0000000-0000-0000-0000-000000000002',
      'b0000000-0000-0000-0000-000000000001',
      'shipping',
      'Accounting Race',
      'Race 1',
      'Warszawa',
      '00-001',
      'PL'
    );
    INSERT INTO public.catalog_products (id, slug, name, status)
    VALUES (
      'b0000000-0000-0000-0000-000000000003',
      'accounting-handoff-race',
      'Accounting Handoff Race',
      'active'
    );
    INSERT INTO public.catalog_skus (
      id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status
    ) VALUES (
      'b0000000-0000-0000-0000-000000000004',
      'b0000000-0000-0000-0000-000000000003',
      'AHR-SKU-1',
      'Accounting Handoff Race SKU',
      'dog',
      400,
      350,
      'active'
    );
    INSERT INTO public.commerce_orders (
      id, client_id, order_number, status, currency, subtotal_cents, tax_cents,
      total_cents, shipping_address_id, metadata
    ) VALUES (
      'b0000000-0000-0000-0000-000000000005',
      'b0000000-0000-0000-0000-000000000001',
      'ABS-RACE-ORDER-1',
      'paid',
      'PLN',
      10800,
      800,
      10800,
      'b0000000-0000-0000-0000-000000000002',
      '{}'::jsonb
    );
    INSERT INTO public.commerce_orders (
      id, client_id, order_number, status, currency, subtotal_cents, tax_cents,
      total_cents, shipping_address_id, metadata
    ) VALUES (
      'b0000000-0000-0000-0000-00000000000a',
      'b0000000-0000-0000-0000-000000000001',
      'ABS-RACE-SENTINEL-1',
      'paid',
      'PLN',
      10800,
      800,
      10800,
      'b0000000-0000-0000-0000-000000000002',
      '{}'::jsonb
    );
    INSERT INTO public.commerce_order_items (
      id, order_id, sku_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      product_snapshot
    ) VALUES (
      'b0000000-0000-0000-0000-00000000000d',
      'b0000000-0000-0000-0000-00000000000a',
      'b0000000-0000-0000-0000-000000000004',
      1,
      10800,
      10800,
      0,
      10800,
      10000,
      '{"title":"Accounting Handoff Sentinel SKU","vatRate":"8"}'::jsonb
    );
    INSERT INTO public.commerce_payments (
      id, order_id, provider, provider_payment_id, status, amount_cents, currency
    ) VALUES (
      'b0000000-0000-0000-0000-00000000000e',
      'b0000000-0000-0000-0000-00000000000a',
      'stripe',
      'pi_accounting_handoff_sentinel',
      'succeeded',
      10800,
      'PLN'
    );
    INSERT INTO public.commerce_payment_intents (
      id, target_kind, order_id, payment_id, status, amount_cents, currency,
      provider_payment_id, updated_at
    ) VALUES (
      'b0000000-0000-0000-0000-00000000000f',
      'one_time_order',
      'b0000000-0000-0000-0000-00000000000a',
      'b0000000-0000-0000-0000-00000000000e',
      'succeeded',
      10800,
      'PLN',
      'pi_accounting_handoff_sentinel',
      now()
    );
    INSERT INTO public.accounting_invoices (
      id, order_id, order_ref, invoice_ref, status, currency,
      buyer_snapshot, order_snapshot, tax_snapshot, lines_snapshot,
      total_net_cents, total_gross_cents, provider_kind
    ) VALUES (
      'b0000000-0000-0000-0000-00000000000b',
      'b0000000-0000-0000-0000-00000000000a',
      'ABS-RACE-SENTINEL-1',
      'FV/ABS-RACE-SENTINEL-1',
      'issue_requested',
      'PLN',
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      '[]'::jsonb,
      10000,
      10800,
      'fakturownia_test'
    );
    INSERT INTO public.accounting_invoice_operations (
      id, invoice_id, operation, provider_kind, payload
    ) VALUES (
      'b0000000-0000-0000-0000-00000000000c',
      'b0000000-0000-0000-0000-00000000000b',
      'issue_requested_from_handoff',
      'fakturownia_test',
      '{"idempotencyKey":"abs-accounting-1"}'::jsonb
    );
    INSERT INTO public.commerce_order_items (
      id, order_id, sku_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      product_snapshot
    ) VALUES (
      'b0000000-0000-0000-0000-000000000006',
      'b0000000-0000-0000-0000-000000000005',
      'b0000000-0000-0000-0000-000000000004',
      1,
      10800,
      10800,
      0,
      10800,
      round((10800)::numeric * 10000 / (10000 + (800)::integer))::integer,
      '{"title":"Accounting Handoff Race SKU","vatRate":"8"}'::jsonb
    );
    INSERT INTO public.commerce_payments (
      id, order_id, provider, provider_payment_id, status, amount_cents, currency
    ) VALUES (
      'b0000000-0000-0000-0000-000000000007',
      'b0000000-0000-0000-0000-000000000005',
      'stripe',
      'pi_accounting_handoff_race',
      'succeeded',
      10800,
      'PLN'
    );
    INSERT INTO public.commerce_payment_intents (
      id, target_kind, order_id, payment_id, status, amount_cents, currency,
      provider_payment_id, updated_at
    ) VALUES (
      'b0000000-0000-0000-0000-000000000008',
      'one_time_order',
      'b0000000-0000-0000-0000-000000000005',
      'b0000000-0000-0000-0000-000000000007',
      'succeeded',
      10800,
      'PLN',
      'pi_accounting_handoff_race',
      now()
    );
    INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key,
      status, shipping_address_snapshot, handed_over_at
    ) VALUES (
      'b0000000-0000-0000-0000-000000000009',
      'b0000000-0000-0000-0000-000000000005',
      'b0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
      'abs-handoff-race-fulfillment',
      'handed_over',
      '{"line1":"Race 1"}'::jsonb,
      now()
    );
  $setup$
);

SAVEPOINT accounting_handoff_concurrent_lock;
SELECT id
  FROM public.commerce_fulfillment_orders
 WHERE id = 'b0000000-0000-0000-0000-000000000009'
 FOR UPDATE;
SELECT extensions.dblink_send_query(
  'accounting_handoff_one',
  $$SELECT public.accounting_invoice_issue_request_from_handoff(
    'abs-accounting-1',
    'b0000000-0000-0000-0000-000000000009',
    'fakturownia_test'
  )$$
);
SELECT extensions.dblink_send_query(
  'accounting_handoff_two',
  $$SELECT public.accounting_invoice_issue_request_from_handoff(
    'abs-accounting-1',
    'b0000000-0000-0000-0000-000000000009',
    'fakturownia_test'
  )$$
);
SELECT pg_sleep(0.05);
SELECT ok(
  extensions.dblink_is_busy('accounting_handoff_one') = 1
  AND extensions.dblink_is_busy('accounting_handoff_two') = 1,
  'both concurrent handoff replays wait on the fulfillment row lock'
);
ROLLBACK TO SAVEPOINT accounting_handoff_concurrent_lock;

CREATE TEMP TABLE _accounting_handoff_concurrent_results (
  result jsonb
) ON COMMIT DROP;
INSERT INTO _accounting_handoff_concurrent_results
SELECT result.result
  FROM extensions.dblink_get_result('accounting_handoff_one') AS result(result jsonb);
INSERT INTO _accounting_handoff_concurrent_results
SELECT result.result
  FROM extensions.dblink_get_result('accounting_handoff_two') AS result(result jsonb);
SELECT * FROM extensions.dblink_get_result('accounting_handoff_one') AS drained(result jsonb);
SELECT * FROM extensions.dblink_get_result('accounting_handoff_two') AS drained(result jsonb);

SELECT is(
  (SELECT count(*)::int
     FROM _accounting_handoff_concurrent_results
    WHERE result #>> '{invoice,status}' = 'issue_requested'),
  2,
  'both serialized handoff replays return the existing invoice'
);
SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = 'b0000000-0000-0000-0000-000000000005'
      AND operation.operation = 'issue_requested_from_handoff'
      AND operation.provider_kind = 'fakturownia_test'
      AND operation.payload->>'idempotencyKey' = 'abs-accounting-1'),
  1,
  'concurrent first calls keep one operation while another invoice has the same identity'
);
SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoices
    WHERE order_id = 'b0000000-0000-0000-0000-000000000005'),
  1,
  'concurrent exact replay keeps one invoice'
);
SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_issue_outbox
    WHERE invoice_id = (
      SELECT id
        FROM public.accounting_invoices
       WHERE order_id = 'b0000000-0000-0000-0000-000000000005'
    )
      AND provider_kind = 'fakturownia_test'),
  1,
  'concurrent first calls create one provider issue outbox row'
);

SELECT extensions.dblink_exec(
  'accounting_handoff_one',
  $cleanup$
    DELETE FROM public.accounting_invoice_operations
     WHERE invoice_id IN (
       SELECT id FROM public.accounting_invoices
        WHERE order_id IN (
          'b0000000-0000-0000-0000-000000000005',
          'b0000000-0000-0000-0000-00000000000a'
        )
     );
    DELETE FROM public.accounting_invoice_issue_outbox
     WHERE invoice_id IN (
       SELECT id FROM public.accounting_invoices
        WHERE order_id = 'b0000000-0000-0000-0000-000000000005'
     );
    DELETE FROM public.accounting_invoices
     WHERE order_id IN (
       'b0000000-0000-0000-0000-000000000005',
       'b0000000-0000-0000-0000-00000000000a'
     );
    DELETE FROM public.commerce_fulfillment_orders
     WHERE id = 'b0000000-0000-0000-0000-000000000009';
    DELETE FROM public.commerce_payment_intents
     WHERE id = 'b0000000-0000-0000-0000-000000000008';
    DELETE FROM public.commerce_payment_intents
     WHERE id = 'b0000000-0000-0000-0000-00000000000f';
    DELETE FROM public.commerce_payments
     WHERE id = 'b0000000-0000-0000-0000-000000000007';
    DELETE FROM public.commerce_payments
     WHERE id = 'b0000000-0000-0000-0000-00000000000e';
    DELETE FROM public.commerce_order_items
     WHERE id = 'b0000000-0000-0000-0000-000000000006';
    DELETE FROM public.commerce_order_items
     WHERE id = 'b0000000-0000-0000-0000-00000000000d';
    DELETE FROM public.commerce_orders
     WHERE id = 'b0000000-0000-0000-0000-000000000005';
    DELETE FROM public.commerce_orders
     WHERE id = 'b0000000-0000-0000-0000-00000000000a';
    DELETE FROM public.catalog_skus
     WHERE id = 'b0000000-0000-0000-0000-000000000004';
    DELETE FROM public.catalog_products
     WHERE id = 'b0000000-0000-0000-0000-000000000003';
    DELETE FROM public.addresses
     WHERE id = 'b0000000-0000-0000-0000-000000000002';
    DELETE FROM public.clients
     WHERE id = 'b0000000-0000-0000-0000-000000000001';
  $cleanup$
);
SELECT extensions.dblink_disconnect('accounting_handoff_one');
SELECT extensions.dblink_disconnect('accounting_handoff_two');

SELECT * FROM finish();
ROLLBACK;
