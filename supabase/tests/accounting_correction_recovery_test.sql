-- pgTAP: concrete correction identity, real reclaim and fenced local effects.
-- Provider transport acceptance belongs to the separately owned bridge proof;
-- this suite proves actual SQL claim eligibility across local commit boundaries.
BEGIN;
SELECT no_plan();

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('a6100000-0000-4000-8000-000000000001', 'correction-recovery@example.invalid', 'Correction', 'Buyer');
INSERT INTO public.commerce_orders (id, client_id, order_number, status, currency, subtotal_cents, tax_cents, total_cents)
VALUES
  ('a6200000-0000-4000-8000-000000000001', 'a6100000-0000-4000-8000-000000000001', 'COR-RECOVERY', 'paid', 'XTS', 1080, 80, 1080),
  ('a6200000-0000-4000-8000-000000000002', 'a6100000-0000-4000-8000-000000000001', 'COR-LEGACY', 'paid', 'XTS', 1080, 80, 1080),
  ('a6200000-0000-4000-8000-000000000003', 'a6100000-0000-4000-8000-000000000001', 'COR-RESPONSE-LOST', 'paid', 'XTS', 1080, 80, 1080);
INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot, order_snapshot, tax_snapshot,
  lines_snapshot, total_net_cents, total_gross_cents, provider_kind, provider_invoice_id,
  provider_invoice_number, document_kind, ksef_required, ksef_status, email_status, correction_status
) VALUES
  ('a6300000-0000-4000-8000-000000000001', 'a6200000-0000-4000-8000-000000000001', 'COR-RECOVERY', 'COR-RECOVERY:base', 'correction_requested', 'XTS', '{"name":"Frozen Buyer"}', '{}', '{}', '[{"name":"Saved item","quantity":1,"totalGrossMinor":1080,"vatRate":"8"}]', 1000, 1080, 'test_provider', 'provider-base-1', 'FV/1', 'b2c_named', false, 'not_required', 'sent', 'requested'),
  ('a6300000-0000-4000-8000-000000000002', 'a6200000-0000-4000-8000-000000000002', 'COR-LEGACY', 'COR-LEGACY:base', 'correction_requested', 'XTS', '{"name":"Frozen Buyer"}', '{}', '{}', '[]', 1000, 1080, 'test_provider', 'provider-base-2', 'FV/2', 'b2c_named', false, 'not_required', 'sent', 'requested'),
  ('a6300000-0000-4000-8000-000000000003', 'a6200000-0000-4000-8000-000000000003', 'COR-RESPONSE-LOST', 'COR-RESPONSE-LOST:base', 'correction_requested', 'XTS', '{"name":"Frozen Buyer"}', '{}', '{}', '[]', 1000, 1080, 'test_provider', 'provider-base-3', 'FV/3', 'b2c_named', false, 'not_required', 'sent', 'requested');
INSERT INTO public.accounting_invoice_correction_outbox (
  id, invoice_id, provider_kind, status, attempt_count, next_attempt_at, correction_reason, payload
) VALUES
  ('a6400000-0000-4000-8000-000000000001', 'a6300000-0000-4000-8000-000000000001', 'test_provider', 'pending', 0, NULL, 'full refund', '{"manualAuthorization":"fixture"}'),
  ('a6400000-0000-4000-8000-000000000002', 'a6300000-0000-4000-8000-000000000002', 'test_provider', 'processing', 1, now() - interval '1 minute', 'legacy in flight', '{}'),
  ('a6400000-0000-4000-8000-000000000003', 'a6300000-0000-4000-8000-000000000002', 'test_provider', 'failed', 1, now() - interval '1 minute', 'legacy unknown acceptance', '{}');
INSERT INTO public.accounting_invoice_delivery_outbox (invoice_id, provider_kind, delivery_kind, status, processed_at, metadata)
VALUES ('a6300000-0000-4000-8000-000000000001', 'test_provider', 'provider_email', 'succeeded', now(), '{"source":"invoice_issue_succeeded"}');

SELECT throws_ok($$SELECT public.accounting_invoice_correction_outbox_claim(10, 300)$$,
  '22023', 'accounting_invoice_correction_claim_contract_required', 'old workers cannot start an unkeyed create');
SELECT throws_ok($$SELECT public.accounting_invoice_correction_outbox_claim(10, 300, 'wrong-contract')$$,
  '22023', 'accounting_invoice_correction_claim_contract_required', 'claim requires the explicit keyed contract');
CREATE TEMP TABLE _correction_first_claim AS
SELECT public.accounting_invoice_correction_outbox_claim(10, 300, 'accounting.correction.v2') AS result;
SELECT is(jsonb_array_length(result), 1, 'first claim excludes both already-attempted legacy rows') FROM _correction_first_claim;
SELECT is(result->0->>'attemptCount', '1', 'first keyed claim carries attempt one') FROM _correction_first_claim;
SELECT is(result->0->'payload'->>'providerCreateIdentity', 'accounting-correction:a6400000-0000-4000-8000-000000000001', 'create identity belongs to the concrete outbox before external work') FROM _correction_first_claim;
SELECT is((SELECT payload->>'manualAuthorization' FROM public.accounting_invoice_correction_outbox WHERE id = 'a6400000-0000-4000-8000-000000000001'), 'fixture', 'claim preserves existing manual authorization payload');
SELECT isnt((SELECT result->0->'payload'->>'providerCreateIdentity' FROM _correction_first_claim), 'COR-RECOVERY', 'correction create identity differs from original invoice order identity');
SELECT is(jsonb_array_length(public.accounting_invoice_correction_outbox_claim(10, 300, 'accounting.correction.v2')), 0, 'valid lease is not actually reclaimable');
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-correction-1', 'CORR/1', '{}')->>'code', 'accounting_invoice_correction_claim_fence_required', 'old success cannot infer current ownership');
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000001', '{}', 60)->>'code', 'accounting_invoice_correction_claim_fence_required', 'old failure cannot mutate current work');

-- Matching generation and a live lease must not hide missing durable identity.
UPDATE public.accounting_invoice_correction_outbox
   SET next_attempt_at = now() + interval '5 minutes'
 WHERE id = 'a6400000-0000-4000-8000-000000000002';
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000002', 'legacy-correction', 'CORR/LEGACY', '{}', 1)->>'code', 'accounting_invoice_correction_claim_identity_missing', 'v2 success rejects an unkeyed legacy row despite matching attempt and live lease');
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000002', '{}', 60, 1)->>'code', 'accounting_invoice_correction_claim_identity_missing', 'v2 failure rejects an unkeyed legacy row despite matching attempt and live lease');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a6300000-0000-4000-8000-000000000002' AND operation LIKE 'correction_%'), 0, 'identity refusals add no correction operations');

-- Accepted provider document exists, but the entire local success transaction
-- aborts before commit. The worker lease subsequently expires without success.
DO $$
DECLARE v_result jsonb;
BEGIN
  BEGIN
    v_result := public.accounting_invoice_correction_outbox_succeed(
      'a6400000-0000-4000-8000-000000000001', 'provider-correction-1', 'CORR/1', '{"id":"provider-correction-1"}', 1
    );
    IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'synthetic_success_was_not_accepted'; END IF;
    RAISE EXCEPTION 'synthetic_local_precommit_failure';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'synthetic_local_precommit_failure' THEN RAISE; END IF;
  END;
END;
$$;
SELECT is((SELECT status FROM public.accounting_invoice_correction_outbox WHERE id = 'a6400000-0000-4000-8000-000000000001'), 'processing', 'precommit failure leaves durable processing ownership');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001' AND operation = 'correction_issued'), 0, 'precommit failure rolls back correction audit');
SELECT is((SELECT status FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001'), 'succeeded', 'precommit failure does not reopen original delivery');
UPDATE public.accounting_invoice_correction_outbox SET next_attempt_at = now() - interval '1 minute' WHERE id = 'a6400000-0000-4000-8000-000000000001';
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-correction-1', 'CORR/1', '{}', 1)->>'code', 'accounting_invoice_correction_claim_inactive', 'expired success lease cannot write provider identity or audit');
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000001', '{}', 60, 1)->>'code', 'accounting_invoice_correction_claim_inactive', 'expired failure lease cannot reschedule');
CREATE TEMP TABLE _correction_reclaim AS
SELECT public.accounting_invoice_correction_outbox_claim(10, 300, 'accounting.correction.v2') AS result;
SELECT is(jsonb_array_length(result), 1, 'rolled-back local success permits a real lease reclaim') FROM _correction_reclaim;
SELECT is(result->0->>'attemptCount', '2', 'real reclaim advances ownership generation') FROM _correction_reclaim;
SELECT is(result->0->'payload'->>'providerCreateIdentity', (SELECT result->0->'payload'->>'providerCreateIdentity' FROM _correction_first_claim), 'real reclaim preserves the provider create identity') FROM _correction_reclaim;
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'stale-provider-result', 'CORR/STALE', '{}', 1)->>'code', 'accounting_invoice_correction_claim_generation_mismatch', 'older success cannot commit on the reclaimed generation');
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000001', '{"message":"stale catch"}', 60, 1)->>'code', 'accounting_invoice_correction_claim_generation_mismatch', 'older catch cannot overwrite the reclaimed generation');
SELECT is((SELECT metadata->>'correctionProviderInvoiceId' FROM public.accounting_invoices WHERE id = 'a6300000-0000-4000-8000-000000000001'), NULL::text, 'rejected stale results do not set correction provider identity');
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-base-1', 'FV/1', '{}', 2)->>'code', 'accounting_invoice_correction_claim_provider_identity_invalid', 'base document cannot be finalized as the correction');
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-correction-1', 'CORR/1', '{"id":"provider-correction-1"}', 2)->>'ok', 'true', 'recovered provider document commits under the current real claim');
SELECT is((SELECT status FROM public.accounting_invoice_correction_outbox WHERE id = 'a6400000-0000-4000-8000-000000000001'), 'succeeded', 'current completion is terminal');
SELECT is((SELECT provider_invoice_id FROM public.accounting_invoices WHERE id = 'a6300000-0000-4000-8000-000000000001'), 'provider-base-1', 'base provider identity remains intact');
SELECT is((SELECT metadata->>'correctionProviderInvoiceId' FROM public.accounting_invoices WHERE id = 'a6300000-0000-4000-8000-000000000001'), 'provider-correction-1', 'recovery records the same concrete provider correction');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001' AND operation = 'correction_issued'), 1, 'recovery creates one correction audit');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001'), 1, 'recovery reuses one existing delivery outbox');
SELECT is((SELECT metadata->>'providerInvoiceId' FROM public.accounting_invoice_delivery_outbox WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001'), 'provider-correction-1', 'delivery targets the correction rather than its base');

-- Local commit succeeded, but the worker never receives its response. Its
-- catch and real claim query must preserve completion, even after delivery.
UPDATE public.accounting_invoice_delivery_outbox SET status = 'succeeded', processed_at = now() WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001';
UPDATE public.accounting_invoices SET email_status = 'sent' WHERE id = 'a6300000-0000-4000-8000-000000000001';
CREATE TEMP TABLE _correction_committed AS
SELECT to_jsonb(invoice) AS invoice, to_jsonb(outbox) AS outbox, to_jsonb(delivery) AS delivery
  FROM public.accounting_invoices invoice
  JOIN public.accounting_invoice_correction_outbox outbox ON outbox.invoice_id = invoice.id
  JOIN public.accounting_invoice_delivery_outbox delivery ON delivery.invoice_id = invoice.id
 WHERE outbox.id = 'a6400000-0000-4000-8000-000000000001';
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000001', '{"message":"local ACK lost"}', 60, 2)->>'code', 'accounting_invoice_correction_claim_inactive', 'catch after committed success cannot mark failed');
SELECT is(jsonb_array_length(public.accounting_invoice_correction_outbox_claim(10, 300, 'accounting.correction.v2')), 0, 'committed success is not eligible for actual reclaim');
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-correction-1', 'CORR/1', '{"readback":"different observation"}', 2)->>'replayed', 'true', 'exact successful replay is acknowledged without new writes');
SELECT is(to_jsonb(invoice), (SELECT invoice FROM _correction_committed), 'success replay preserves all invoice fields') FROM public.accounting_invoices invoice WHERE id = 'a6300000-0000-4000-8000-000000000001';
SELECT is(to_jsonb(outbox), (SELECT outbox FROM _correction_committed), 'success replay preserves all outbox fields') FROM public.accounting_invoice_correction_outbox outbox WHERE id = 'a6400000-0000-4000-8000-000000000001';
SELECT is(to_jsonb(delivery), (SELECT delivery FROM _correction_committed), 'success replay preserves completed delivery') FROM public.accounting_invoice_delivery_outbox delivery WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001';
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-correction-other', 'CORR/1', '{}', 2)->>'code', 'accounting_invoice_correction_claim_provider_identity_conflict', 'successful replay rejects a changed provider id');
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'provider-correction-1', 'CORR/CHANGED', '{}', 2)->>'code', 'accounting_invoice_correction_claim_provider_identity_conflict', 'successful replay rejects a changed document number');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001' AND operation = 'correction_issued'), 1, 'replay and stale result rejection add no correction audit');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_operations WHERE invoice_id = 'a6300000-0000-4000-8000-000000000001' AND operation = 'correction_failed'), 0, 'stale catches add no misleading failure audit');
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000001', 'legacy-late-provider', 'CORR/OLD', '{}')->>'code', 'accounting_invoice_correction_claim_fence_required', 'late old success cannot overwrite committed identity');
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000001', '{}', 60)->>'code', 'accounting_invoice_correction_claim_fence_required', 'late old catch cannot reopen committed completion');
SELECT is((SELECT count(*)::int FROM public.accounting_invoice_correction_outbox WHERE invoice_id = 'a6300000-0000-4000-8000-000000000002' AND attempt_count = 1 AND payload = '{}'), 2, 'legacy attempted rows remain unresolved without guessed identity or backfill');

-- Lost provider response is a failed current attempt, not a local committed
-- success. Reclaiming it keeps the identity used by its protected provider POST.
INSERT INTO public.accounting_invoice_correction_outbox (id, invoice_id, provider_kind, correction_reason)
VALUES ('a6400000-0000-4000-8000-000000000004', 'a6300000-0000-4000-8000-000000000003', 'test_provider', 'new authorized correction');
CREATE TEMP TABLE _correction_lost_response AS SELECT public.accounting_invoice_correction_outbox_claim(10, 300, 'accounting.correction.v2') AS result;
SELECT is(public.accounting_invoice_correction_outbox_fail('a6400000-0000-4000-8000-000000000004', '{"message":"provider response lost"}', 60, 1)->>'ok', 'true', 'current provider response failure can schedule normal recovery');
UPDATE public.accounting_invoice_correction_outbox SET next_attempt_at = now() - interval '1 minute' WHERE id = 'a6400000-0000-4000-8000-000000000004';
CREATE TEMP TABLE _correction_lost_response_reclaim AS SELECT public.accounting_invoice_correction_outbox_claim(10, 300, 'accounting.correction.v2') AS result;
SELECT is(result->0->>'attemptCount', '2', 'provider response loss permits a real retry claim') FROM _correction_lost_response_reclaim;
SELECT is(result->0->'payload'->>'providerCreateIdentity', (SELECT result->0->'payload'->>'providerCreateIdentity' FROM _correction_lost_response), 'provider response loss reuses its protected create identity') FROM _correction_lost_response_reclaim;
SELECT is(public.accounting_invoice_correction_outbox_succeed('a6400000-0000-4000-8000-000000000004', 'provider-correction-2', 'CORR/2', '{}', 2)->>'ok', 'true', 'provider readback can finalize the same accepted document after response loss');

SELECT ok(NOT has_function_privilege('anon', 'public.accounting_invoice_correction_outbox_claim(integer,integer,text)', 'EXECUTE'), 'anonymous role cannot claim corrections');
SELECT ok(NOT has_function_privilege('authenticated', 'public.accounting_invoice_correction_outbox_succeed(uuid,text,text,jsonb,integer)', 'EXECUTE'), 'browser role cannot finalize corrections');
SELECT ok(NOT has_function_privilege('authenticated', 'public.accounting_invoice_correction_outbox_fail(uuid,jsonb,integer,integer)', 'EXECUTE'), 'browser role cannot fail corrections');
SELECT ok(has_function_privilege('service_role', 'public.accounting_invoice_correction_outbox_claim(integer,integer,text)', 'EXECUTE'), 'service role retains versioned claim authority');
SELECT * FROM finish();
ROLLBACK;
