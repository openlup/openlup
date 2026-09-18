-- pgTAP: invoice PDF delivery uses the existing accounting outbox with
-- occurrence-safe Resend evidence and no blind retry after ambiguity.

BEGIN;
SELECT plan(46);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('a5100000-0000-4000-8000-000000000001', 'mutable-profile@example.invalid', 'Invoice', 'Buyer');

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, currency,
  subtotal_cents, tax_cents, total_cents
) VALUES
  ('a5200000-0000-4000-8000-000000000001', 'a5100000-0000-4000-8000-000000000001', 'RESEND-SUCCESS', 'paid', 'PLN', 1080, 80, 1080),
  ('a5200000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'RESEND-EXPIRED', 'paid', 'PLN', 1080, 80, 1080),
  ('a5200000-0000-4000-8000-000000000003', 'a5100000-0000-4000-8000-000000000001', 'RESEND-FAIL', 'paid', 'PLN', 1080, 80, 1080),
  ('a5200000-0000-4000-8000-000000000004', 'a5100000-0000-4000-8000-000000000001', 'RESEND-UNCERTAIN', 'paid', 'PLN', 1080, 80, 1080),
  ('a5200000-0000-4000-8000-000000000005', 'a5100000-0000-4000-8000-000000000001', 'RESEND-LEGACY', 'paid', 'PLN', 1080, 80, 1080);

INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency,
  buyer_snapshot, order_snapshot, tax_snapshot, lines_snapshot,
  total_net_cents, total_gross_cents, provider_kind,
  provider_invoice_id, provider_invoice_number,
  document_kind, ksef_required, ksef_status, email_status
) VALUES
  ('a5300000-0000-4000-8000-000000000001', 'a5200000-0000-4000-8000-000000000001', 'RESEND-SUCCESS', 'RESEND-SUCCESS:base', 'issued', 'PLN', '{"name":"Frozen Buyer","email":"frozen-success@example.invalid"}', '{}', '{}', '[]', 1000, 1080, 'fakturownia', 'provider-success', 'FV/SUCCESS', 'b2c_named', false, 'not_required', 'pending'),
  ('a5300000-0000-4000-8000-000000000002', 'a5200000-0000-4000-8000-000000000002', 'RESEND-EXPIRED', 'RESEND-EXPIRED:base', 'issued', 'PLN', '{"name":"Frozen Buyer","email":"frozen-expired@example.invalid"}', '{}', '{}', '[]', 1000, 1080, 'fakturownia', 'provider-expired', 'FV/EXPIRED', 'b2c_named', false, 'not_required', 'pending'),
  ('a5300000-0000-4000-8000-000000000003', 'a5200000-0000-4000-8000-000000000003', 'RESEND-FAIL', 'RESEND-FAIL:base', 'issued', 'PLN', '{"name":"Frozen Buyer","email":"frozen-fail@example.invalid"}', '{}', '{}', '[]', 1000, 1080, 'fakturownia', 'provider-fail', 'FV/FAIL', 'b2c_named', false, 'not_required', 'pending'),
  ('a5300000-0000-4000-8000-000000000004', 'a5200000-0000-4000-8000-000000000004', 'RESEND-UNCERTAIN', 'RESEND-UNCERTAIN:base', 'issued', 'PLN', '{"name":"Frozen Buyer","email":"frozen-uncertain@example.invalid"}', '{}', '{}', '[]', 1000, 1080, 'fakturownia', 'provider-uncertain', 'FV/UNCERTAIN', 'b2c_named', false, 'not_required', 'pending'),
  ('a5300000-0000-4000-8000-000000000005', 'a5200000-0000-4000-8000-000000000005', 'RESEND-LEGACY', 'RESEND-LEGACY:base', 'issued', 'PLN', '{"name":"Frozen Buyer","email":"frozen-legacy@example.invalid"}', '{}', '{}', '[]', 1000, 1080, 'fakturownia', 'provider-legacy', 'FV/LEGACY', 'b2c_named', false, 'not_required', 'pending');

INSERT INTO public.accounting_invoice_delivery_outbox (
  id, invoice_id, provider_kind, delivery_kind, status,
  attempt_count, next_attempt_at, metadata
) VALUES
  ('a5400000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000001', 'fakturownia', 'provider_email', 'pending', 0, NULL, '{"source":"invoice_issue_succeeded"}'),
  ('a5400000-0000-4000-8000-000000000002', 'a5300000-0000-4000-8000-000000000002', 'fakturownia', 'provider_email', 'processing', 1, now() - interval '1 minute', '{"source":"invoice_issue_succeeded"}'),
  ('a5400000-0000-4000-8000-000000000003', 'a5300000-0000-4000-8000-000000000003', 'fakturownia', 'provider_email', 'pending', 0, NULL, '{"source":"invoice_issue_succeeded"}'),
  ('a5400000-0000-4000-8000-000000000004', 'a5300000-0000-4000-8000-000000000004', 'fakturownia', 'provider_email', 'pending', 0, NULL, '{"source":"correction_issued","providerInvoiceId":"provider-correction"}'),
  ('a5400000-0000-4000-8000-000000000005', 'a5300000-0000-4000-8000-000000000005', 'fakturownia', 'provider_email', 'pending', 0, NULL, '{"source":"invoice_issue_succeeded"}');

CREATE TEMP TABLE _success_claim AS
SELECT public.accounting_invoice_delivery_outbox_claim(
  1, 300, true, 'a5200000-0000-4000-8000-000000000001'
) AS result;

SELECT is(result->0->>'recipientEmail', 'frozen-success@example.invalid', 'claim uses the immutable invoice buyer email') FROM _success_claim;
SELECT is(result->0->>'clientId', 'a5100000-0000-4000-8000-000000000001', 'claim carries the order client owner') FROM _success_claim;
SELECT is(result->0->>'providerInvoiceNumber', 'FV/SUCCESS', 'claim carries the provider invoice number') FROM _success_claim;
SELECT is(
  result->0->>'idempotencyKey',
  'accounting-invoice-delivery:a5400000-0000-4000-8000-000000000001:provider-success',
  'claim derives a stable outbox/provider-invoice occurrence key'
) FROM _success_claim;

SELECT public.accounting_invoice_delivery_outbox_resend_succeed(
  'a5400000-0000-4000-8000-000000000001', 1, 'provider-success', 'resend-message-success'
);

SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000001'), 'succeeded', 'fenced success completes the existing delivery outbox');
SELECT is((SELECT email_status FROM public.accounting_invoices WHERE id = 'a5300000-0000-4000-8000-000000000001'), 'sent', 'fenced success records provider acceptance on the invoice');
SELECT is((SELECT count(*)::int FROM public.email_sends WHERE resend_id = 'resend-message-success'), 1, 'fenced success creates exactly one Resend send ledger row');
SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE dedupe_key = 'accounting-invoice-delivery:a5400000-0000-4000-8000-000000000001:provider-success'),
  'sent',
  'fenced success links the customer delivery timeline'
);
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a5300000-0000-4000-8000-000000000001' AND operation = 'provider_email_sent'), 1, 'fenced success writes the compatible accounting delivery operation');

SELECT public.accounting_invoice_delivery_outbox_resend_succeed(
  'a5400000-0000-4000-8000-000000000001', 1, 'provider-success', 'resend-message-success'
);
SELECT is((SELECT count(*)::int FROM public.email_sends WHERE resend_id = 'resend-message-success'), 1, 'exact success replay does not duplicate email send evidence');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a5300000-0000-4000-8000-000000000001' AND operation = 'provider_email_sent'), 1, 'exact success replay does not duplicate accounting evidence');

SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_succeed('a5400000-0000-4000-8000-000000000001', 1, 'provider-success', 'resend-message-changed')$$,
  '22023', 'accounting_delivery_resend_message_conflict',
  'same occurrence rejects a changed provider message id'
);

UPDATE public.accounting_invoices
   SET metadata = metadata || '{"correctionProviderInvoiceNumber":"KOR/SUCCESS"}'::jsonb
 WHERE id = 'a5300000-0000-4000-8000-000000000001';
UPDATE public.accounting_invoice_delivery_outbox
   SET status = 'pending', processed_at = NULL, next_attempt_at = NULL,
       metadata = metadata || '{"source":"correction_issued","providerInvoiceId":"provider-success-correction"}'::jsonb
 WHERE id = 'a5400000-0000-4000-8000-000000000001';
CREATE TEMP TABLE _correction_claim AS
SELECT public.accounting_invoice_delivery_outbox_claim(1, 300, true, 'a5200000-0000-4000-8000-000000000001') AS result;
SELECT is((SELECT result->0->>'idempotencyKey' FROM _correction_claim), 'accounting-invoice-delivery:a5400000-0000-4000-8000-000000000001:provider-success-correction', 'same outbox derives a new key for correction occurrence A to B');
SELECT is((SELECT result->0->>'providerInvoiceNumber' FROM _correction_claim), 'KOR/SUCCESS', 'correction claim exposes the matching correction document number');
SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000001', 2, 'provider-success-correction', '{"code":"correction_outcome_unknown"}', NULL);
SELECT is((SELECT metadata->>'providerMessageId' FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000001'), NULL::text, 'new correction occurrence cannot inherit the base invoice provider message id');
SELECT is((SELECT metadata->>'emailSendId' FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000001'), NULL::text, 'new correction occurrence cannot inherit the base invoice email send ledger id');

SELECT public.accounting_invoice_delivery_outbox_claim(1, 300, true, 'a5200000-0000-4000-8000-000000000002');
SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000002'), 'uncertain', 'expired processing becomes uncertain rather than being reclaimed');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a5300000-0000-4000-8000-000000000002' AND operation = 'provider_email_failed' AND payload->>'requiresManualReview' = 'true'), 1, 'expired processing creates one compatible manual-review operation');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE dedupe_key LIKE 'accounting-invoice-delivery:a5400000-0000-4000-8000-000000000002:%'), 'delivery_delayed', 'expired processing is visible in the delivery timeline');
SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000002', 1, 'provider-expired', '{"code":"late_provider_evidence"}', 'resend-message-after-expiry');
SELECT is((SELECT count(*)::int FROM public.email_sends WHERE resend_id = 'resend-message-after-expiry'), 1, 'late known provider evidence after lease expiry creates one measurable send ledger');
SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000002'), 'uncertain', 'late provider evidence does not reopen or complete an expired occurrence');
SELECT ok((SELECT email_send_id IS NOT NULL AND provider_message_id = 'resend-message-after-expiry' FROM public.communication_email_deliveries WHERE dedupe_key LIKE 'accounting-invoice-delivery:a5400000-0000-4000-8000-000000000002:%'), 'expiry race enriches the existing timeline without reclaiming the outbox');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a5300000-0000-4000-8000-000000000002' AND operation = 'provider_email_failed'), 1, 'expiry race one-way enrichment does not duplicate failure evidence');

CREATE TEMP TABLE _fail_claim AS SELECT public.accounting_invoice_delivery_outbox_claim(1, 300, true, 'a5200000-0000-4000-8000-000000000003') AS result;
SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_succeed('a5400000-0000-4000-8000-000000000003', 1, 'provider-fail', 'resend-message-success')$$,
  '23505', 'accounting_delivery_resend_message_collision',
  'provider message id owned by another outbox occurrence is rejected deterministically'
);
SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000003', 1, 'provider-fail', '{"code":"ambiguous"}', 'resend-message-success')$$,
  '23505', 'accounting_delivery_resend_message_collision',
  'uncertain path also rejects a provider message id owned by another occurrence'
);
SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_fail('a5400000-0000-4000-8000-000000000003', 2, 'provider-fail', '{"code":"stale"}', 60)$$,
  '40001', 'accounting_delivery_resend_stale_attempt',
  'retryable failure rejects a stale claim generation'
);
SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_fail('a5400000-0000-4000-8000-000000000003', 1, 'wrong-provider-invoice', '{"code":"wrong"}', 60)$$,
  '22023', 'accounting_delivery_resend_provider_invoice_conflict',
  'retryable failure rejects the wrong provider invoice occurrence'
);
SELECT public.accounting_invoice_delivery_outbox_resend_fail('a5400000-0000-4000-8000-000000000003', 1, 'provider-fail', '{"code":"invoice_pdf_invalid"}', 60);
SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000003'), 'failed', 'definite pre-send failure remains retryable');
SELECT ok((SELECT next_attempt_at > now() FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000003'), 'definite pre-send failure schedules a bounded retry');

CREATE TEMP TABLE _uncertain_claim AS SELECT public.accounting_invoice_delivery_outbox_claim(1, 300, true, 'a5200000-0000-4000-8000-000000000004') AS result;
SELECT is((SELECT result->0->>'providerInvoiceId' FROM _uncertain_claim), 'provider-correction', 'correction delivery uses its occurrence provider invoice id');
SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000004', 1, 'provider-correction', '{"code":"provider_response_ambiguous"}', 'resend-message-uncertain');
SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000004'), 'uncertain', 'ambiguous provider result is terminally uncertain');
SELECT is((SELECT next_attempt_at FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000004'), NULL::timestamptz, 'uncertain result cannot enter automatic retry');
SELECT is((SELECT metadata->>'providerMessageId' FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000004'), 'resend-message-uncertain', 'uncertain state preserves a known provider message id for support');
SELECT is((SELECT count(*)::int FROM public.email_sends WHERE resend_id = 'resend-message-uncertain'), 1, 'known-id uncertain creates one sanitized measurable send ledger');
SELECT ok((SELECT email_send_id IS NOT NULL AND provider_message_id = 'resend-message-uncertain' FROM public.communication_email_deliveries WHERE dedupe_key = 'accounting-invoice-delivery:a5400000-0000-4000-8000-000000000004:provider-correction'), 'known-id uncertain links timeline evidence for webhook and poller updates');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a5300000-0000-4000-8000-000000000004' AND operation = 'provider_email_failed' AND payload->>'requiresManualReview' = 'true'), 1, 'ambiguous outcome reuses compatible failure evidence with manual-review context');
SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000004', 1, 'provider-correction', '{"code":"provider_response_ambiguous"}', 'resend-message-uncertain');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a5300000-0000-4000-8000-000000000004' AND operation = 'provider_email_failed'), 1, 'exact uncertain replay does not duplicate evidence');
SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000004', 1, 'wrong-provider-invoice', '{"code":"changed"}', 'resend-message-uncertain')$$,
  '22023', 'accounting_delivery_resend_provider_invoice_conflict',
  'uncertain replay rejects the wrong provider invoice occurrence'
);
SELECT throws_ok(
  $$SELECT public.accounting_invoice_delivery_outbox_resend_uncertain('a5400000-0000-4000-8000-000000000004', 1, 'provider-correction', '{"code":"changed"}', 'resend-message-changed')$$,
  '22023', 'accounting_delivery_resend_message_conflict',
  'uncertain replay rejects changed known provider evidence'
);
SELECT is(jsonb_array_length(public.accounting_invoice_delivery_outbox_claim(1, 300, true, 'a5200000-0000-4000-8000-000000000004')), 0, 'uncertain occurrence cannot be reclaimed automatically');

SELECT public.accounting_invoice_delivery_outbox_claim(1, 300, true, 'a5200000-0000-4000-8000-000000000005');
SELECT public.accounting_invoice_delivery_outbox_succeed('a5400000-0000-4000-8000-000000000005', '{"legacy":true}');
SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE id = 'a5400000-0000-4000-8000-000000000005'), 'uncertain', 'legacy success without Resend evidence cannot claim delivery success');

SELECT ok(
  has_function_privilege('service_role', 'public.accounting_invoice_delivery_outbox_resend_succeed(uuid,integer,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accounting_invoice_delivery_outbox_resend_succeed(uuid,integer,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.accounting_invoice_delivery_outbox_resend_succeed(uuid,integer,text,text)', 'EXECUTE'),
  'only service_role can finalize Resend delivery evidence'
);

SELECT ok(
  has_function_privilege('service_role', 'public.accounting_invoice_delivery_outbox_claim(integer,integer,boolean,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accounting_invoice_delivery_outbox_claim(integer,integer,boolean,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.accounting_invoice_delivery_outbox_claim(integer,integer,boolean,uuid)', 'EXECUTE'),
  'only service_role can claim invoice delivery work'
);
SELECT ok(
  has_function_privilege('service_role', 'public.accounting_invoice_delivery_outbox_resend_fail(uuid,integer,text,jsonb,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accounting_invoice_delivery_outbox_resend_fail(uuid,integer,text,jsonb,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.accounting_invoice_delivery_outbox_resend_fail(uuid,integer,text,jsonb,integer)', 'EXECUTE'),
  'only service_role can record retryable pre-send failure'
);
SELECT ok(
  has_function_privilege('service_role', 'public.accounting_invoice_delivery_outbox_resend_uncertain(uuid,integer,text,jsonb,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accounting_invoice_delivery_outbox_resend_uncertain(uuid,integer,text,jsonb,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.accounting_invoice_delivery_outbox_resend_uncertain(uuid,integer,text,jsonb,text)', 'EXECUTE'),
  'only service_role can record uncertain provider evidence'
);
SELECT ok(
  has_function_privilege('service_role', 'public.accounting_invoice_delivery_outbox_succeed(uuid,jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.accounting_invoice_delivery_outbox_fail(uuid,jsonb,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accounting_invoice_delivery_outbox_succeed(uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.accounting_invoice_delivery_outbox_succeed(uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.accounting_invoice_delivery_outbox_fail(uuid,jsonb,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.accounting_invoice_delivery_outbox_fail(uuid,jsonb,integer)', 'EXECUTE'),
  'legacy compatibility RPCs remain service-role only'
);

SELECT * FROM finish();
ROLLBACK;
