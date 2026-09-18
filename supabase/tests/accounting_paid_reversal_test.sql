-- pgTAP: paid-order accounting issue and reversal semantics.
--
-- Run via: supabase test db supabase/tests/accounting_paid_reversal_test.sql

BEGIN;
SELECT plan(73);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('aa000000-0000-0000-0000-000000000001', 'paid-accounting@example.invalid', 'Paid', 'Buyer');

INSERT INTO public.addresses (
  id, client_id, kind, label, recipient_name, line1, city, postal_code, country, is_default, source
) VALUES (
  'aa100000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-000000000001',
  'shipping',
  'Shipping',
  'Paid Buyer',
  'Paid 1',
  'Warszawa',
  '00-001',
  'PL',
  true,
  'checkout'
);

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('aa200000-0000-0000-0000-000000000001', 'accounting-paid', 'Accounting Paid', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit, status)
VALUES ('aa300000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000001', 'AP-SKU-1', 'Accounting Paid SKU', 'dog', 400, 350, 'active');

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('aa310000-0000-0000-0000-000000000001', 'AP-LOC-1', 'Accounting Paid Location', 'internal_warehouse', 'active', true);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents, shipping_address_id
) VALUES (
  'aa400000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-000000000001',
  'AP-ORDER-1',
  'paid',
  'PLN',
  1080,
  0,
  0,
  0,
  80,
  1080,
  'aa100000-0000-0000-0000-000000000001'
), (
  'aa400000-0000-0000-0000-000000000002',
  'aa000000-0000-0000-0000-000000000001',
  'AP-ORDER-2',
  'paid',
  'PLN',
  2160,
  0,
  0,
  0,
  160,
  2160,
  'aa100000-0000-0000-0000-000000000001'
), (
  'aa400000-0000-0000-0000-000000000003',
  'aa000000-0000-0000-0000-000000000001',
  'AP-ORDER-3',
  'paid',
  'PLN',
  3240,
  1,
  1500,
  500,
  314,
  4239,
  'aa100000-0000-0000-0000-000000000001'
);

INSERT INTO public.commerce_order_items (
  id, order_id, sku_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, allocation_ordinal, product_snapshot
) VALUES (
  'aa500000-0000-0000-0000-000000000001',
  'aa400000-0000-0000-0000-000000000001',
  'aa300000-0000-0000-0000-000000000001',
  1,
  1080,
  1080, 0, 1080, round((1080)::numeric * 10000 / (10000 + (800)::integer))::integer, 1,
  '{"title":"Accounting Paid SKU","vatRate":"8"}'::jsonb
), (
  'aa500000-0000-0000-0000-000000000002',
  'aa400000-0000-0000-0000-000000000002',
  'aa300000-0000-0000-0000-000000000001',
  2,
  1080,
  2160, 0, 2160, round((2160)::numeric * 10000 / (10000 + (800)::integer))::integer, 1,
  '{"title":"Accounting Paid SKU","vatRate":"8"}'::jsonb
), (
  'aa500000-0000-0000-0000-000000000003',
  'aa400000-0000-0000-0000-000000000003',
  'aa300000-0000-0000-0000-000000000001',
  3,
  540,
  1620, 1, 1619, round((1619)::numeric * 10000 / (10000 + (800)::integer))::integer, 1,
  '{"sku":"AP-SNAPSHOT-3A","productSlug":"writer-shaped-product","quoteLine":{"sku":"AP-SNAPSHOT-3A","productSlug":"writer-shaped-product"},"vatRate":"8"}'::jsonb
), (
  'aa500000-0000-0000-0000-000000000004',
  'aa400000-0000-0000-0000-000000000003',
  'aa300000-0000-0000-0000-000000000001',
  3,
  540,
  1620, 0, 1620, round((1620)::numeric * 10000 / (10000 + (800)::integer))::integer, 2,
  '{"title":"Accounting Paid SKU","vatRate":"8"}'::jsonb
);

INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id, quantity, status, kind
) VALUES (
  'aa510000-0000-0000-0000-000000000001',
  'ap-reservation-1',
  'aa400000-0000-0000-0000-000000000001',
  'aa500000-0000-0000-0000-000000000001',
  'aa300000-0000-0000-0000-000000000001',
  'aa310000-0000-0000-0000-000000000001',
  1,
  'reserved',
  'manual_ops'
);

INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES
  ('aa600000-0000-0000-0000-000000000001', 'aa400000-0000-0000-0000-000000000001', 'stripe', 'pi_paid_1', 'succeeded', 1080, 'PLN'),
  ('aa600000-0000-0000-0000-000000000002', 'aa400000-0000-0000-0000-000000000002', 'stripe', 'pi_paid_2', 'succeeded', 2160, 'PLN'),
  ('aa600000-0000-0000-0000-000000000003', 'aa400000-0000-0000-0000-000000000003', 'stripe', 'pi_paid_3', 'succeeded', 4239, 'PLN');

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency, provider_payment_id, updated_at
) VALUES
  ('aa700000-0000-0000-0000-000000000001', 'one_time_order', 'aa400000-0000-0000-0000-000000000001', 'aa600000-0000-0000-0000-000000000001', 'succeeded', 1080, 'PLN', 'pi_paid_1', now()),
  ('aa700000-0000-0000-0000-000000000002', 'one_time_order', 'aa400000-0000-0000-0000-000000000002', 'aa600000-0000-0000-0000-000000000002', 'succeeded', 2160, 'PLN', 'pi_paid_2', now()),
  ('aa700000-0000-0000-0000-000000000003', 'one_time_order', 'aa400000-0000-0000-0000-000000000003', 'aa600000-0000-0000-0000-000000000003', 'succeeded', 4239, 'PLN', 'pi_paid_3', now());

CREATE TEMP TABLE _paid_issue AS
SELECT public.accounting_invoice_issue_request_from_paid_order(
  'ap-paid-issue-1',
  'aa400000-0000-0000-0000-000000000001',
  'fakturownia_test'
) AS r;

SELECT public.accounting_invoice_issue_request_from_paid_order(
  'ap-paid-issue-1-durable-handoff-replay',
  'aa400000-0000-0000-0000-000000000001',
  'fakturownia_test'
);

SELECT is((SELECT r #>> '{invoice,status}' FROM _paid_issue), 'issue_requested', 'paid order requests invoice issue');
SELECT is((SELECT package_shipped_at FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000001'), NULL, 'paid issue keeps package_shipped_at null');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_issue_outbox WHERE provider_kind = 'fakturownia_test'), 1, 'paid issue creates one issue outbox');
SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000001'),
  1,
  'durable paid replay keeps one base invoice'
);
SELECT is(
  (SELECT count(*)::int
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
      AND operation.operation IN ('issue_requested_from_paid_order', 'issue_requested_from_handoff')),
  1,
  'durable paid replay keeps one issue-request audit operation'
);

SELECT public.accounting_invoice_issue_request_from_paid_order(
  'ap-paid-issue-3',
  'aa400000-0000-0000-0000-000000000003',
  'fakturownia_test'
);

CREATE TEMP TABLE _targeted_issue_claim AS
SELECT public.accounting_invoice_issue_outbox_claim(5, 300, 'aa400000-0000-0000-0000-000000000003', 'accounting.issue.v2') AS r;

CREATE FUNCTION pg_temp.accounting_invoice_issue_payment_preflight(
  p_invoice_id uuid,
  p_provider_status text,
  p_provider_amount_cents integer,
  p_provider_currency text,
  p_provider_evidence jsonb
) RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.accounting_invoice_issue_payment_preflight(
    p_invoice_id,
    p_provider_status,
    p_provider_amount_cents,
    p_provider_currency,
    p_provider_evidence,
    outbox.id,
    outbox.attempt_count
  )
    FROM public.accounting_invoice_issue_outbox outbox
   WHERE outbox.invoice_id = p_invoice_id;
$$;

SELECT is(
  public.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'unavailable', NULL, NULL, '{}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_issue_claim_fence_required',
  'legacy preflight signature cannot authorize canonical provider work without a claim fence'
);
SELECT is(
  public.accounting_invoice_issue_outbox_fail(
    (SELECT (r #>> '{0,outboxId}')::uuid FROM _targeted_issue_claim),
    '{"message":"legacy worker"}'::jsonb,
    60
  ) #>> '{code}',
  'accounting_invoice_issue_claim_fence_required',
  'legacy failure signature cannot mutate a canonical issue claim'
);
SELECT is(
  public.accounting_invoice_issue_block_canonical_mapper(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'accounting_invoice_canonical_legacy_mapper',
    '{}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_issue_claim_fence_required',
  'legacy mapper-block signature cannot mutate a canonical issue claim'
);

SELECT is((
  SELECT outbox.status
    FROM public.accounting_invoice_issue_outbox outbox
    JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
   WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
), 'pending', 'targeted issue claim leaves other pending orders alone');

CREATE TEMP TABLE _stale_issue_claim AS
SELECT public.accounting_invoice_issue_outbox_claim(
  5, 300, 'aa400000-0000-0000-0000-000000000001', 'accounting.issue.v2'
) AS r;
UPDATE public.accounting_invoice_issue_outbox outbox
   SET next_attempt_at = now() - interval '1 second'
  FROM public.accounting_invoices invoice
 WHERE invoice.id = outbox.invoice_id
   AND invoice.order_id = 'aa400000-0000-0000-0000-000000000001';
CREATE TEMP TABLE _current_issue_claim AS
SELECT public.accounting_invoice_issue_outbox_claim(
  5, 300, 'aa400000-0000-0000-0000-000000000001', 'accounting.issue.v2'
) AS r;

SELECT is(
  (SELECT (r #>> '{0,attemptCount}')::integer FROM _current_issue_claim),
  2,
  'expired issue lease is re-claimed with a new attempt-count fence'
);
SELECT is(
  public.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _stale_issue_claim),
    'unavailable', NULL, NULL, '{}'::jsonb,
    (SELECT (r #>> '{0,outboxId}')::uuid FROM _stale_issue_claim),
    (SELECT (r #>> '{0,attemptCount}')::integer FROM _stale_issue_claim)
  ) #>> '{code}',
  'accounting_invoice_issue_claim_generation_mismatch',
  'a stale worker cannot pass final preflight after the issue row is re-claimed'
);
SELECT is(
  public.accounting_invoice_issue_outbox_fail(
    (SELECT (r #>> '{0,outboxId}')::uuid FROM _stale_issue_claim),
    '{"message":"stale worker failed"}'::jsonb,
    60,
    (SELECT (r #>> '{0,attemptCount}')::integer FROM _stale_issue_claim)
  ) #>> '{code}',
  'accounting_invoice_issue_claim_generation_mismatch',
  'a stale failure result cannot mutate the newer issue claim'
);
SELECT is(
  public.accounting_invoice_issue_block_canonical_mapper(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _stale_issue_claim),
    'accounting_invoice_canonical_stale_mapper',
    '{"stage":"stale-worker"}'::jsonb,
    (SELECT (r #>> '{0,outboxId}')::uuid FROM _stale_issue_claim),
    (SELECT (r #>> '{0,attemptCount}')::integer FROM _stale_issue_claim)
  ) #>> '{code}',
  'accounting_invoice_issue_claim_generation_mismatch',
  'a stale mapper block cannot mutate the newer issue claim'
);
SELECT is(
  (SELECT invoice.status || ':' || coalesce(invoice.blocked_reason, 'none') || ':'
          || outbox.status || ':' || outbox.attempt_count
     FROM public.accounting_invoices invoice
     JOIN public.accounting_invoice_issue_outbox outbox ON outbox.invoice_id = invoice.id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'),
  'issue_requested:none:processing:2',
  'stale fail and block results leave the newer owner and invoice unchanged'
);
SELECT is(
  public.accounting_invoice_issue_outbox_succeed(
    (SELECT (r #>> '{0,outboxId}')::uuid FROM _stale_issue_claim),
    'fv-stale-worker',
    'FV/STALE/WORKER',
    '{"provider":"fakturownia"}'::jsonb,
    (SELECT (r #>> '{0,attemptCount}')::integer FROM _stale_issue_claim)
  ) #>> '{code}',
  'accounting_invoice_issue_claim_generation_mismatch',
  'a stale provider result cannot finalize the newer issue claim'
);
SELECT is(
  (SELECT outbox.status || ':' || outbox.attempt_count
     FROM public.accounting_invoice_issue_outbox outbox
     JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'),
  'processing:2',
  'rejected stale result leaves the current claim owned and processing'
);

SELECT is(
  public.accounting_invoice_issue_outbox_claim(5, 300, 'aa400000-0000-0000-0000-000000000001'),
  '[]'::jsonb,
  'legacy claim contract cannot claim canonical obligations after DB-first rollout'
);

SELECT is((SELECT r #>> '{0,invoice,orderId}' FROM _targeted_issue_claim), 'aa400000-0000-0000-0000-000000000003', 'targeted issue claim selects requested order');
SELECT is(
  (SELECT r #> '{0,invoice,orderMoney}' FROM _targeted_issue_claim),
  'null'::jsonb,
  'canonical claim omits legacy orderMoney so an old residual mapper cannot append delivery twice'
);
SELECT is(
  (SELECT jsonb_array_length(r #> '{0,invoice,linesSnapshot}') FROM _targeted_issue_claim),
  3,
  'canonical invoice snapshot contains allocated items and explicit delivery position'
);
SELECT is(
  (SELECT (r #>> '{0,invoice,linesSnapshot,0,totalGrossMinor}')::integer FROM _targeted_issue_claim),
  1619,
  'canonical item positions preserve the SQL largest-remainder tie-break order'
);
SELECT is(
  (SELECT (r #>> '{0,invoice,linesSnapshot,2,totalGrossMinor}')::integer FROM _targeted_issue_claim),
  1000,
  'delivery position uses shipping gross less shipping discount'
);
SELECT is(
  (SELECT sum((position->>'totalGrossMinor')::integer)::integer
     FROM _targeted_issue_claim,
          jsonb_array_elements(r #> '{0,invoice,linesSnapshot}') position),
  4239,
  'canonical document gross positions close to the charged order total'
);
SELECT is(
  (SELECT sum((position->>'totalNetMinor')::integer)::integer
     FROM _targeted_issue_claim,
          jsonb_array_elements(r #> '{0,invoice,linesSnapshot}') position),
  3925,
  'canonical document net positions close to the invoice net header'
);
SELECT is(
  (SELECT r #>> '{0,invoice,linesSnapshot,0,name}' FROM _targeted_issue_claim),
  'AP-SNAPSHOT-3A',
  'canonical invoice description prefers writer-shaped frozen SKU over live catalog data'
);
SELECT is(
  (SELECT r #> '{0,payment}' FROM _targeted_issue_claim),
  '{"intentId":"aa700000-0000-0000-0000-000000000003","provider":"stripe","providerPaymentId":"pi_paid_3","amountCents":4239,"currency":"PLN","localSettlementState":"unavailable"}'::jsonb,
  'issue claim pins the exact succeeded payment intent used for preflight'
);

SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4239, 'PLN', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3"}'::jsonb
  ),
  jsonb_build_object(
    'ok', true,
    'code', NULL,
    'providerReadbackState', 'matched',
    'paymentIntentId', 'aa700000-0000-0000-0000-000000000003'
  ),
  'fresh provider readback matching the order permits provider invocation'
);
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'unavailable', NULL, NULL, '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3","unavailableReason":"not_configured"}'::jsonb
  ),
  jsonb_build_object(
    'ok', true,
    'code', NULL,
    'providerReadbackState', 'unavailable',
    'paymentIntentId', 'aa700000-0000-0000-0000-000000000003'
  ),
  'unavailable optional provider readback is explicit and does not impersonate a match'
);

SAVEPOINT provider_amount_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4240, 'PLN', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_settlement_amount_mismatch',
  'confirmed provider amount mismatch blocks issuance'
);
ROLLBACK TO SAVEPOINT provider_amount_drift;

SAVEPOINT provider_currency_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4239, 'EUR', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_settlement_currency_mismatch',
  'confirmed provider currency mismatch blocks issuance'
);
ROLLBACK TO SAVEPOINT provider_currency_drift;

SAVEPOINT provider_partial_amount_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4240, NULL, '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3","currencyAvailable":false}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_settlement_amount_mismatch',
  'available provider amount mismatch blocks issuance when currency readback is unavailable'
);
ROLLBACK TO SAVEPOINT provider_partial_amount_drift;

SAVEPOINT provider_partial_currency_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', NULL, 'EUR', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3","amountAvailable":false}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_settlement_currency_mismatch',
  'available provider currency mismatch blocks issuance when amount readback is unavailable'
);
ROLLBACK TO SAVEPOINT provider_partial_currency_drift;

SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4239, NULL, '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3","currencyAvailable":false}'::jsonb
  ) #>> '{providerReadbackState}',
  'unavailable',
  'matching provider amount does not impersonate a full match when currency readback is unavailable'
);

SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', NULL, 'PLN', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3","amountAvailable":false}'::jsonb
  ) #>> '{providerReadbackState}',
  'unavailable',
  'matching provider currency does not impersonate a full match when amount readback is unavailable'
);

SAVEPOINT current_provider_ref_drift;
UPDATE public.commerce_payment_intents
   SET provider_payment_id = 'pi_paid_3_replaced'
 WHERE id = 'aa700000-0000-0000-0000-000000000003';
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4239, 'PLN', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_payment_provider_ref_mismatch',
  'provider reference drift after claim and readback blocks provider invocation'
);
ROLLBACK TO SAVEPOINT current_provider_ref_drift;

SAVEPOINT readback_provider_identity_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4239, 'PLN', '{"source":"provider_api","provider":"tpay","providerPaymentId":"pi_paid_3"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_readback_identity_mismatch',
  'readback from a different provider cannot authorize issuance'
);
ROLLBACK TO SAVEPOINT readback_provider_identity_drift;

SAVEPOINT readback_provider_ref_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'succeeded', 4239, 'PLN', '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_other"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_readback_ref_mismatch',
  'readback for a different provider payment cannot authorize issuance'
);
ROLLBACK TO SAVEPOINT readback_provider_ref_drift;

SAVEPOINT payment_amount_drift;
UPDATE public.commerce_payment_intents
   SET amount_cents = 4240
 WHERE id = 'aa700000-0000-0000-0000-000000000003';
SELECT is(
  public.accounting_order_payment_validation('aa400000-0000-0000-0000-000000000003') #>> '{code}',
  'accounting_invoice_payment_intent_amount_mismatch',
  'payment intent amount drift fails closed'
);
ROLLBACK TO SAVEPOINT payment_amount_drift;

SAVEPOINT payment_currency_drift;
UPDATE public.commerce_payment_intents
   SET currency = 'EUR'
 WHERE id = 'aa700000-0000-0000-0000-000000000003';
SELECT is(
  public.accounting_order_payment_validation('aa400000-0000-0000-0000-000000000003') #>> '{code}',
  'accounting_invoice_payment_intent_currency_mismatch',
  'payment intent currency drift fails closed'
);
ROLLBACK TO SAVEPOINT payment_currency_drift;

SAVEPOINT local_settlement_drift;
INSERT INTO public.payment_provider_settlement_batches (
  id, provider_kind, provider_batch_id, currency, status, gross_cents, fee_cents, net_cents
) VALUES (
  'aa710000-0000-0000-0000-000000000003', 'stripe', 'batch-accounting-paid-3',
  'PLN', 'mismatch', 4240, 0, 4240
);
INSERT INTO public.payment_provider_settlement_items (
  batch_id, provider_kind, provider_payment_id, payment_intent_id, payment_id,
  gross_cents, fee_cents, net_cents, currency, status
) VALUES (
  'aa710000-0000-0000-0000-000000000003', 'stripe', 'pi_paid_3',
  'aa700000-0000-0000-0000-000000000003', 'aa600000-0000-0000-0000-000000000003',
  4240, 0, 4240, 'PLN', 'mismatch'
);
SELECT is(
  public.accounting_order_payment_validation('aa400000-0000-0000-0000-000000000003') #>> '{code}',
  'accounting_invoice_local_settlement_amount_mismatch',
  'confirmed local settlement ledger amount drift fails closed'
);
INSERT INTO public.payment_provider_settlement_batches (
  id, provider_kind, provider_batch_id, currency, status, gross_cents, fee_cents, net_cents
) VALUES (
  'aa710000-0000-0000-0000-000000000004', 'stripe', 'batch-accounting-paid-3-later',
  'PLN', 'reconciled', 4239, 0, 4239
);
INSERT INTO public.payment_provider_settlement_items (
  batch_id, provider_kind, provider_payment_id, payment_intent_id, payment_id,
  gross_cents, fee_cents, net_cents, currency, status
) VALUES (
  'aa710000-0000-0000-0000-000000000004', 'stripe', 'pi_paid_3',
  'aa700000-0000-0000-0000-000000000003', 'aa600000-0000-0000-0000-000000000003',
  4239, 0, 4239, 'PLN', 'matched'
);
SELECT is(
  public.accounting_order_payment_validation('aa400000-0000-0000-0000-000000000003') #>> '{code}',
  'accounting_invoice_local_settlement_amount_mismatch',
  'a later matched import cannot hide a mismatch for the final provider reference'
);
ROLLBACK TO SAVEPOINT local_settlement_drift;

SAVEPOINT stale_retry_settlement;
INSERT INTO public.payment_provider_settlement_batches (
  id, provider_kind, provider_batch_id, currency, status, gross_cents, fee_cents, net_cents
) VALUES (
  'aa710000-0000-0000-0000-000000000005', 'stripe', 'batch-accounting-old-retry',
  'PLN', 'mismatch', 9999, 0, 9999
);
INSERT INTO public.payment_provider_settlement_items (
  batch_id, provider_kind, provider_payment_id, payment_intent_id, payment_id,
  gross_cents, fee_cents, net_cents, currency, status
) VALUES (
  'aa710000-0000-0000-0000-000000000005', 'stripe', 'pi_old_retry_ref',
  'aa700000-0000-0000-0000-000000000003', 'aa600000-0000-0000-0000-000000000003',
  9999, 0, 9999, 'PLN', 'mismatch'
);
SELECT is(
  (public.accounting_order_payment_validation('aa400000-0000-0000-0000-000000000003')->>'ok')::boolean,
  true,
  'settlement evidence for an old retry reference does not block the final provider payment'
);
ROLLBACK TO SAVEPOINT stale_retry_settlement;

SAVEPOINT provider_status_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'failed', NULL, NULL, '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_settlement_status_mismatch',
  'confirmed provider failure blocks issuance even when amount readback is absent'
);
ROLLBACK TO SAVEPOINT provider_status_drift;

SAVEPOINT provider_pending_drift;
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'pending', NULL, NULL, '{"source":"provider_api","provider":"stripe","providerPaymentId":"pi_paid_3"}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_provider_settlement_status_mismatch',
  'confirmed provider pending state blocks issuance instead of masquerading as unavailable'
);
ROLLBACK TO SAVEPOINT provider_pending_drift;

SAVEPOINT immutable_canonical_lines;
SELECT throws_ok(
  format(
    'UPDATE public.accounting_invoices SET metadata = metadata || ''{"source":"test.manual"}''::jsonb, lines_snapshot = jsonb_set(lines_snapshot, ''{0}'', (lines_snapshot->0) - ''totalNetMinor'') WHERE id = %L',
    (SELECT r #>> '{0,invoice,id}' FROM _targeted_issue_claim)
  ),
  '55000',
  'accounting_invoice_canonical_money_immutable',
  'changing metadata source cannot bypass immutable canonical invoice money'
);
ROLLBACK TO SAVEPOINT immutable_canonical_lines;

SAVEPOINT canonical_snapshot_delta;
UPDATE public.commerce_order_items
   SET product_snapshot = product_snapshot || '{"title":"Changed after invoice"}'::jsonb
 WHERE id = 'aa500000-0000-0000-0000-000000000003';
SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _targeted_issue_claim),
    'unavailable', NULL, NULL, '{}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_canonical_snapshot_mismatch',
  'DB preflight exact-compares the persisted snapshot with the canonical builder'
);
ROLLBACK TO SAVEPOINT canonical_snapshot_delta;

INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot,
  order_snapshot, tax_snapshot, lines_snapshot, total_net_cents, total_gross_cents,
  provider_kind, document_kind, ksef_required, metadata
) VALUES (
  'aa750000-0000-0000-0000-000000000002',
  'aa400000-0000-0000-0000-000000000002',
  'AP-ORDER-2', 'AP-ORDER-2:admin-v2', 'issue_requested', 'PLN',
  '{"name":"Paid Buyer"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[{"name":"caller supplied catalog line"}]'::jsonb,
  2000, 2160, 'fakturownia_test', 'b2c_named', false,
  '{"source":"admin.accounting.issue.v2"}'::jsonb
);
SELECT is(
  (SELECT metadata->>'canonicalMoneyVersion' FROM public.accounting_invoices WHERE id = 'aa750000-0000-0000-0000-000000000002'),
  '1',
  'admin v2 base invoices are canonicalized regardless of metadata source'
);
SELECT is(
  (SELECT lines_snapshot->0->>'positionKind' FROM public.accounting_invoices WHERE id = 'aa750000-0000-0000-0000-000000000002'),
  'item',
  'admin v2 caller lines are replaced by canonical order positions'
);

INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot,
  order_snapshot, tax_snapshot, lines_snapshot, total_net_cents, total_gross_cents,
  provider_kind, correction_of_invoice_id, metadata
) VALUES (
  'aa750000-0000-0000-0000-000000000003',
  'aa400000-0000-0000-0000-000000000003',
  'AP-ORDER-3', 'AP-ORDER-3:correction-fixture', 'draft', 'PLN',
  '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[{"name":"correction-owned-position"}]'::jsonb,
  0, 0, 'fakturownia_test',
  (SELECT id FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000003' AND correction_of_invoice_id IS NULL),
  '{"source":"correction.fixture"}'::jsonb
);
SELECT is(
  (SELECT lines_snapshot->0->>'name' FROM public.accounting_invoices WHERE id = 'aa750000-0000-0000-0000-000000000003'),
  'correction-owned-position',
  'corrections remain explicitly excluded from base-order canonicalization'
);
SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET correction_of_invoice_id = 'aa750000-0000-0000-0000-000000000003',
           lines_snapshot = '[{"name":"bypass"}]'::jsonb
     WHERE id = 'aa750000-0000-0000-0000-000000000002'$$,
  '55000',
  'accounting_invoice_correction_identity_immutable',
  'a canonical base invoice cannot become a correction to bypass fiscal freezing'
);
SELECT lives_ok(
  $$UPDATE public.accounting_invoices
       SET lines_snapshot = '[{"name":"edited-draft-correction"}]'::jsonb
     WHERE id = 'aa750000-0000-0000-0000-000000000003'$$,
  'draft correction fiscal positions remain editable'
);
SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET status = 'issued',
           provider_invoice_id = 'fv-correction-bypass',
           total_gross_cents = total_gross_cents + 1,
           lines_snapshot = '[{"name":"issued-and-mutated"}]'::jsonb
     WHERE id = 'aa750000-0000-0000-0000-000000000003'$$,
  '55000',
  'accounting_invoice_correction_money_immutable',
  'draft correction cannot mutate fiscal money in the same update that issues it'
);
UPDATE public.accounting_invoices
   SET status = 'issued', provider_invoice_id = 'fv-correction-fixture'
 WHERE id = 'aa750000-0000-0000-0000-000000000003';
SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET total_gross_cents = total_gross_cents + 1
     WHERE id = 'aa750000-0000-0000-0000-000000000003'$$,
  '55000',
  'accounting_invoice_correction_money_immutable',
  'non-draft correction fiscal money is immutable'
);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot, handed_over_at
) VALUES (
  'aa800000-0000-0000-0000-000000000001',
  'aa400000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-000000000001',
  'aa100000-0000-0000-0000-000000000001',
  'ap-fulfillment-1',
  'handed_over',
  '{"line1":"Paid 1"}'::jsonb,
  now()
);

SELECT public.accounting_invoice_issue_request_from_handoff(
  'ap-handoff-issue-1',
  'aa800000-0000-0000-0000-000000000001',
  'fakturownia_test'
);

SELECT is((SELECT count(*)::int FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000001'), 1, 'handoff after paid issue does not duplicate invoice');
SELECT is((
  SELECT count(*)::int
    FROM public.accounting_invoice_issue_outbox outbox
    JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
   WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
), 1, 'handoff after paid issue does not duplicate outbox');

SELECT public.accounting_invoice_request_reversal_from_order_status(
  'ap-reversal-before-provider',
  'aa400000-0000-0000-0000-000000000001',
  'order_canceled',
  '{}'::jsonb,
  'fakturownia_test'
);

SELECT is((SELECT status FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000001'), 'voided', 'cancel before provider issue voids local invoice');
SELECT is((
  SELECT outbox.status
    FROM public.accounting_invoice_issue_outbox outbox
    JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
   WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
), 'cancelled', 'cancel before provider issue cancels pending issue outbox');

SELECT is(
  pg_temp.accounting_invoice_issue_payment_preflight(
    (SELECT (r #>> '{0,invoice,id}')::uuid FROM _current_issue_claim),
    'unavailable', NULL, NULL, '{}'::jsonb
  ) #>> '{code}',
  'accounting_invoice_issue_claim_inactive',
  'order reversal committed after claim blocks the final provider-call preflight'
);
SELECT is(
  public.accounting_invoice_issue_outbox_succeed(
    (SELECT (r #>> '{0,outboxId}')::uuid FROM _stale_issue_claim),
    'fv-created-after-cancel',
    'FV/AFTER/CANCEL',
    '{"provider":"fakturownia","race":"provider_returned_after_reversal"}'::jsonb,
    (SELECT (r #>> '{0,attemptCount}')::integer FROM _stale_issue_claim)
  ) #>> '{code}',
  'accounting_invoice_provider_created_after_reversal',
  'provider response after reversal enters the compensating path instead of normal succeed'
);
SELECT is(
  (SELECT status FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000001'),
  'correction_requested',
  'late remote document is no longer represented as a voided invoice'
);
SELECT is(
  (SELECT outbox.status FROM public.accounting_invoice_issue_outbox outbox
     JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'),
  'cancelled',
  'late provider response never resurrects the cancelled issue outbox'
);
SELECT is(
  (SELECT count(*)::integer FROM public.accounting_invoice_correction_outbox outbox
     JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
      AND outbox.status = 'pending'),
  1,
  'late remote document durably queues the compensating correction'
);
SELECT is(
  (SELECT provider_ref FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
      AND operation.operation = 'provider_invoice_created_after_reversal'),
  'fv-created-after-cancel',
  'late provider identity remains explicit audit evidence'
);
SELECT is(
  (SELECT provider_invoice_id || ':' || provider_invoice_number
     FROM public.accounting_invoices
    WHERE order_id = 'aa400000-0000-0000-0000-000000000001'),
  'fv-created-after-cancel:FV/AFTER/CANCEL',
  'compensation durably records the remote provider id and number'
);
SELECT is(
  (SELECT (payload->>'staleClaim') || ':' || (payload->>'claimAttemptCount') || ':'
          || (payload->>'actualClaimAttemptCount')
     FROM public.accounting_invoice_operations operation
     JOIN public.accounting_invoices invoice ON invoice.id = operation.invoice_id
    WHERE invoice.order_id = 'aa400000-0000-0000-0000-000000000001'
      AND operation.operation = 'provider_invoice_created_after_reversal'),
  'true:1:2',
  'compensation preserves stale-attempt evidence across the reversal race'
);

SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET buyer_snapshot = buyer_snapshot || '{"name":"Mutated Buyer"}'::jsonb,
           document_kind = 'b2b_vat',
           ksef_required = true,
           payment_completed_at = coalesce(payment_completed_at, now()) + interval '1 second',
           provider_payment_id = provider_payment_id || '-mutated'
     WHERE id = 'aa750000-0000-0000-0000-000000000002'$$,
  '55000',
  'accounting_invoice_canonical_money_immutable',
  'canonical fiscal identity, buyer, KSeF policy and payment evidence are immutable'
);

UPDATE public.accounting_invoices
   SET status = 'issued',
       provider_invoice_id = 'fv-issued-2',
       provider_invoice_number = 'FV/2/2026',
       ksef_status = 'not_required',
       email_status = 'sent'
 WHERE id = 'aa750000-0000-0000-0000-000000000002';

SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET provider_invoice_id = 'fv-issued-2-mutated',
           provider_invoice_number = 'FV/MUTATED/2026'
     WHERE id = 'aa750000-0000-0000-0000-000000000002'$$,
  '55000',
  'accounting_invoice_provider_identity_immutable',
  'issued provider document identity is immutable after legal succeed transition'
);
SELECT throws_ok(
  $$UPDATE public.accounting_invoices
       SET status = 'issue_requested'
     WHERE id = 'aa750000-0000-0000-0000-000000000002'$$,
  '55000',
  'accounting_invoice_provider_status_transition_invalid',
  'issued invoice cannot transition back into the issue queue'
);

SELECT public.accounting_invoice_request_reversal_from_order_status(
  'ap-reversal-after-provider',
  'aa400000-0000-0000-0000-000000000002',
  'order_refunded',
  '{}'::jsonb,
  'fakturownia_test'
);

SELECT is((SELECT status FROM public.accounting_invoices WHERE order_id = 'aa400000-0000-0000-0000-000000000002'), 'correction_requested', 'refund after provider issue requests correction');
SELECT is((
  SELECT count(*)::int
    FROM public.accounting_invoice_correction_outbox outbox
    JOIN public.accounting_invoices invoice ON invoice.id = outbox.invoice_id
   WHERE outbox.provider_kind = 'fakturownia_test'
     AND invoice.order_id = 'aa400000-0000-0000-0000-000000000002'
), 1, 'refund after provider issue enqueues one correction');

CREATE TEMP TABLE _claimed_correction AS
SELECT public.accounting_invoice_correction_outbox_claim(5, 300) AS r;

SELECT public.accounting_invoice_correction_outbox_succeed(
  (SELECT (r->0->>'outboxId')::uuid FROM _claimed_correction),
  'fv-correction-2',
  'KOR/2/2026',
  '{"provider":"fakturownia"}'::jsonb
);

CREATE TEMP TABLE _claimed_delivery AS
SELECT public.accounting_invoice_delivery_outbox_claim(5, 300, false) AS r;

SELECT is((SELECT r->0->>'providerInvoiceId' FROM _claimed_delivery), 'fv-correction-2', 'correction email delivery targets correction provider invoice id');

INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, order_item_id, sku_id, location_id,
  quantity, status, kind
) VALUES
  (
    'aa510000-0000-0000-0000-000000000003', 'ap-reservation-3a',
    'aa400000-0000-0000-0000-000000000003', 'aa500000-0000-0000-0000-000000000003',
    'aa300000-0000-0000-0000-000000000001', 'aa310000-0000-0000-0000-000000000001',
    3, 'reserved', 'manual_ops'
  ),
  (
    'aa510000-0000-0000-0000-000000000004', 'ap-reservation-3b',
    'aa400000-0000-0000-0000-000000000003', 'aa500000-0000-0000-0000-000000000004',
    'aa300000-0000-0000-0000-000000000001', 'aa310000-0000-0000-0000-000000000001',
    3, 'reserved', 'manual_ops'
  );
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot, handed_over_at
) VALUES (
  'aa800000-0000-0000-0000-000000000003',
  'aa400000-0000-0000-0000-000000000003',
  'aa000000-0000-0000-0000-000000000001',
  'aa100000-0000-0000-0000-000000000001',
  'ap-fulfillment-3',
  'handed_over',
  '{"line1":"Paid 3"}'::jsonb,
  now()
);
UPDATE public.accounting_invoices
   SET status = 'blocked',
       blocked_reason = 'invalid_tax_id',
       updated_at = now()
 WHERE order_id = 'aa400000-0000-0000-0000-000000000003';

-- Fully positional with all 16 arguments. The sole surviving overload declares
-- no parameter defaults, so a short call is an error rather than a silent hit
-- on the superseded 15-argument body that used to answer it before
-- 20260824075701_oms_queue_has_one_overload.sql removed that identity.
-- Argument order from the live definition in
-- 20260816082705_oms_queue_summary_single_currency.sql; NULL at position 10 is
-- the no-filter value for `p_provider_ops_status`.
CREATE TEMP TABLE _oms_blocked AS
SELECT public.commerce_oms_admin_list_queue(
  1, 25, NULL, NULL, NULL, NULL, NULL, NULL,
  'blocked', NULL, 'invoice_buyer_data_invalid', false, 'review_invoice',
  NULL, NULL, 'attention_priority_desc'
, false) AS r;

SELECT is((SELECT r #>> '{orderIds,0}' FROM _oms_blocked), 'aa400000-0000-0000-0000-000000000003', 'OMS queue exposes blocked invoices under invoice data problems');
SELECT is((SELECT r #>> '{summaryCounts,invoiceIssues}' FROM _oms_blocked), '1', 'OMS invoiceIssues counts blocked invalid buyer data');

SELECT * FROM finish();
ROLLBACK;
