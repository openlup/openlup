-- pgTAP: accounting-specific Fakturownia delivery outbox.
-- Verifies provider email delivery does not use global outbox_events.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(12);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('11000000-0000-0000-0000-000000000001', 'accounting-delivery@example.invalid', 'Accounting', 'Delivery');

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, currency, subtotal_cents, tax_cents, total_cents
) VALUES (
  '12000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  'ADO-B2C-1',
  'paid',
  'PLN',
  1080,
  80,
  1080
), (
  '12000000-0000-0000-0000-000000000002',
  '11000000-0000-0000-0000-000000000001',
  'ADO-B2B-1',
  'paid',
  'PLN',
  1080,
  80,
  1080
), (
  '12000000-0000-0000-0000-000000000003',
  '11000000-0000-0000-0000-000000000001',
  'ADO-B2C-2',
  'paid',
  'PLN',
  1080,
  80,
  1080
);

INSERT INTO public.commerce_order_items (
  id, order_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents,
  vat_rate_bps, product_snapshot
) VALUES (
  '12500000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001',
  1, 1080, 1080, 0, 1080, 1000, 800,
  '{"title":"Delivery fixture"}'::jsonb
);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '12600000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001',
  'stripe', 'pi_delivery_1', 'succeeded', 1080, 'PLN'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency,
  provider_payment_id, updated_at
) VALUES (
  '12700000-0000-0000-0000-000000000001',
  'one_time_order',
  '12000000-0000-0000-0000-000000000001',
  '12600000-0000-0000-0000-000000000001',
  'succeeded', 1080, 'PLN', 'pi_delivery_1', now()
);

INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot,
  order_snapshot, tax_snapshot, lines_snapshot, total_net_cents, total_gross_cents,
  provider_kind, provider_invoice_id, provider_invoice_number, document_kind, ksef_required, ksef_status, email_status
) VALUES (
  '13000000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001',
  'ADO-B2C-1',
  'ADO-B2C-1:base',
  'issue_requested',
  'PLN',
  '{"name":"Consumer","email":"consumer@example.invalid","taxId":null}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  1000,
  1080,
  'fakturownia',
  NULL,
  NULL,
  'b2c_named',
  false,
  'not_submitted',
  'pending'
), (
  '13000000-0000-0000-0000-000000000002',
  '12000000-0000-0000-0000-000000000002',
  'ADO-B2B-1',
  'ADO-B2B-1:base',
  'issued',
  'PLN',
  '{"name":"Business","taxId":"1234563218"}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  1000,
  1080,
  'fakturownia',
  'fv-b2b-1',
  'FV/B2B/1',
  'b2b_vat',
  true,
  'pending',
  'not_required'
), (
  '13000000-0000-0000-0000-000000000003',
  '12000000-0000-0000-0000-000000000003',
  'ADO-B2C-2',
  'ADO-B2C-2:base',
  'issued',
  'PLN',
  '{"name":"Consumer 2","email":"consumer2@example.invalid","taxId":null}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  1000,
  1080,
  'fakturownia',
  'fv-b2c-2',
  'FV/B2C/2',
  'b2c_named',
  false,
  'not_required',
  'pending'
);

INSERT INTO public.accounting_invoice_issue_outbox (
  id, invoice_id, provider_kind, status, attempt_count, next_attempt_at
) VALUES (
  '14000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001',
  'fakturownia',
  'processing',
  1,
  now() + interval '5 minutes'
);

SELECT public.accounting_invoice_issue_outbox_succeed(
  '14000000-0000-0000-0000-000000000001',
  'fv-b2c-1',
  'FV/B2C/1',
  '{"provider":"fakturownia"}'::jsonb,
  1
);

SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = '13000000-0000-0000-0000-000000000001'),
  1,
  'B2C issue success enqueues one provider email delivery row'
);

SELECT is(
  (SELECT email_status FROM public.accounting_invoices WHERE id = '13000000-0000-0000-0000-000000000001'),
  'pending',
  'B2C email remains pending until delivery job succeeds'
);

SELECT public.accounting_invoice_issue_outbox_succeed(
  '14000000-0000-0000-0000-000000000001',
  'fv-b2c-1',
  'FV/B2C/1',
  '{"provider":"fakturownia"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = '13000000-0000-0000-0000-000000000001'),
  1,
  'B2C delivery enqueue is idempotent'
);

INSERT INTO public.accounting_invoice_delivery_outbox (
  invoice_id, provider_kind, delivery_kind
) VALUES (
  '13000000-0000-0000-0000-000000000003',
  'fakturownia',
  'provider_email'
);

CREATE TEMP TABLE _claimed_targeted_delivery AS
SELECT public.accounting_invoice_delivery_outbox_claim(5, 300, true, '12000000-0000-0000-0000-000000000003') AS r;

SELECT is(
  (SELECT r->0->>'providerInvoiceId' FROM _claimed_targeted_delivery),
  'fv-b2c-2',
  'targeted delivery claim selects requested order'
);

SELECT is(
  (SELECT status FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = '13000000-0000-0000-0000-000000000001'),
  'pending',
  'targeted delivery claim leaves other pending deliveries alone'
);

CREATE TEMP TABLE _claimed_b2c AS
SELECT public.accounting_invoice_delivery_outbox_claim(5, 300) AS r;

SELECT is(
  (SELECT jsonb_array_length(r) FROM _claimed_b2c),
  1,
  'delivery claim returns the pending B2C email command'
);

SELECT public.accounting_invoice_delivery_outbox_resend_succeed(
  (SELECT (r->0->>'outboxId')::uuid FROM _claimed_b2c),
  (SELECT (r->0->>'attemptCount')::integer FROM _claimed_b2c),
  (SELECT r->0->>'providerInvoiceId' FROM _claimed_b2c),
  'resend-accounting-delivery-b2c'
);

SELECT is(
  (SELECT email_status FROM public.accounting_invoices WHERE id = '13000000-0000-0000-0000-000000000001'),
  'sent',
  'delivery success records invoice email_status sent'
);

SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = '13000000-0000-0000-0000-000000000002'),
  0,
  'B2B invoice is not delivery-eligible before KSeF acceptance'
);

SELECT public.accounting_invoice_record_ksef_status(
  '13000000-0000-0000-0000-000000000002',
  'KSEF-ADO-1',
  'accepted',
  '{"provider":"fakturownia"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = '13000000-0000-0000-0000-000000000002'),
  1,
  'B2B KSeF acceptance enqueues provider email delivery'
);

CREATE TEMP TABLE _claimed_b2b AS
SELECT public.accounting_invoice_delivery_outbox_claim(5, 300) AS r;

SELECT is(
  (SELECT r->0->>'providerInvoiceId' FROM _claimed_b2b),
  'fv-b2b-1',
  'B2B delivery claim exposes provider invoice id'
);

SELECT public.accounting_invoice_delivery_outbox_resend_fail(
  (SELECT (r->0->>'outboxId')::uuid FROM _claimed_b2b),
  (SELECT (r->0->>'attemptCount')::integer FROM _claimed_b2b),
  (SELECT r->0->>'providerInvoiceId' FROM _claimed_b2b),
  '{"message":"demo send error"}'::jsonb,
  60
);

SELECT is(
  (SELECT email_status FROM public.accounting_invoices WHERE id = '13000000-0000-0000-0000-000000000002'),
  'failed',
  'delivery failure records invoice email_status failed'
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE aggregate_id IN (
    '13000000-0000-0000-0000-000000000001',
    '13000000-0000-0000-0000-000000000002',
    '13000000-0000-0000-0000-000000000003'
  )),
  0,
  'Fakturownia provider email does not require global outbox_events'
);

SELECT * FROM finish();
ROLLBACK;
