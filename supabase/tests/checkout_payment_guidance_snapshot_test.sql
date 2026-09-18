-- Read-only checkout provenance, exact evidence correlation and bounded history.
BEGIN;
SELECT plan(50);

SELECT ok(NOT has_function_privilege('public', 'public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)', 'EXECUTE'), 'PUBLIC cannot execute');
SELECT ok(NOT has_function_privilege('anon', 'public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)', 'EXECUTE'), 'anonymous cannot execute');
SELECT ok(NOT has_function_privilege('authenticated', 'public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)', 'EXECUTE'), 'browser account cannot execute');
SELECT ok(has_function_privilege('service_role', 'public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)', 'EXECUTE'), 'service role can execute');
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)'::regprocedure), 's', 'one stable read snapshot');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_catalog'] FROM pg_proc WHERE oid = 'public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid)'::regprocedure), 'fixed search path and definer');

CREATE TEMP TABLE fixture_ids AS
SELECT n, ('a1100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS order_id,
       ('a1200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS intent_id,
       ('a1300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid AS payment_id
FROM generate_series(1, 3) n;
INSERT INTO public.clients(id, email) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'guidance@example.invalid'),
  ('a1000000-0000-4000-8000-000000000002', 'unrelated@example.invalid');
INSERT INTO public.subscriptions(id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('a1400000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
  28, 'XTS', 'pending_activation', now(), now() + interval '28 days');
INSERT INTO public.subscription_cycles(id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('a1500000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001',
  1, now(), 'planned', 'guidance-first-cycle', 0);
INSERT INTO public.commerce_orders(id, client_id, currency, region_code, size_constraint,
  status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id, metadata)
SELECT order_id, 'a1000000-0000-4000-8000-000000000001', 'XTS', 'ZZ', '{"kind":"unit_count","value":1}',
  'pending_payment', 100, 100, CASE WHEN n = 3 THEN 'subscription_cycle' ELSE 'one_time' END,
  CASE WHEN n = 3 THEN 'a1400000-0000-4000-8000-000000000001'::uuid END,
  CASE WHEN n = 3 THEN 'a1500000-0000-4000-8000-000000000001'::uuid END,
  jsonb_build_object('runtimeFinalize', jsonb_build_object('source', 'commerce.runtime.hidden.v0',
    'checkoutKind', CASE WHEN n = 3 THEN 'subscription_initial' ELSE 'one_time' END))
FROM fixture_ids;
UPDATE public.subscription_cycles SET order_id = (SELECT order_id FROM fixture_ids WHERE n = 3)
WHERE id = 'a1500000-0000-4000-8000-000000000001';
INSERT INTO public.commerce_payments(id, order_id, provider, status, amount_cents, currency)
SELECT payment_id, order_id, 'test_rail', 'failed', 100, 'XTS' FROM fixture_ids;
INSERT INTO public.commerce_payment_intents(id, order_id, target_kind, subscription_id,
  subscription_cycle_id, payment_id, status, amount_cents, currency, metadata)
SELECT intent_id, order_id, CASE WHEN n = 3 THEN 'subscription_cycle' ELSE 'one_time_order' END,
  CASE WHEN n = 3 THEN 'a1400000-0000-4000-8000-000000000001'::uuid END,
  CASE WHEN n = 3 THEN 'a1500000-0000-4000-8000-000000000001'::uuid END,
  payment_id, 'failed', 100, 'XTS', jsonb_build_object('checkoutKind', CASE WHEN n = 3 THEN 'subscription_initial' ELSE 'one_time' END)
FROM fixture_ids;

CREATE TEMP TABLE evidence_fixture AS SELECT '{"version":1,"source":"execution","disposition":"present",
  "refusalVerified":true,"providerPaymentId":"pay-current","providerChargeId":null,
  "code":"declined","declineCode":null,"adviceCode":null,"adviceOrigin":"unknown",
  "operation":"one_time_payment","methodSource":"execution_contract",
  "method":{"kind":"card","recoveryMethodKey":"card","interaction":"new_instrument","secret":"must-not-leak"},
  "secret":"must-not-leak"}'::jsonb AS body;
INSERT INTO public.commerce_payment_attempts(id, payment_intent_id, payment_id, provider,
  provider_attempt_id, idempotency_key, status, amount_cents, currency, created_at, request_payload, response_payload)
SELECT ('a1600000-0000-4000-8000-' || lpad(v.n::text, 12, '0'))::uuid, f.intent_id, f.payment_id,
  'test_rail', CASE WHEN v.n = 2 THEN 'pay-current' ELSE 'pay-old' END, 'guidance-attempt-' || v.n,
  'failed', 100, 'XTS', '2026-09-11T10:00:00Z'::timestamptz + v.n * interval '1 second',
  '{"providerFlow":"sample_flow","secret":"must-not-leak"}',
  jsonb_build_object('failureEvidence', body || jsonb_build_object('providerPaymentId',
    CASE WHEN v.n = 2 THEN 'pay-current' ELSE 'pay-old' END), 'secret', 'must-not-leak')
FROM generate_series(1, 2) v(n) CROSS JOIN fixture_ids f CROSS JOIN evidence_fixture WHERE f.n = 1;
UPDATE public.commerce_payment_intents SET active_attempt_id = 'a1600000-0000-4000-8000-000000000002',
  provider_payment_id = 'pay-current' WHERE id = (SELECT intent_id FROM fixture_ids WHERE n = 1);

CREATE FUNCTION pg_temp.guidance(p_n integer DEFAULT 1, p_token uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $$ SELECT public.commerce_checkout_payment_guidance_snapshot(order_id, intent_id, p_token)
  FROM fixture_ids WHERE n = p_n $$;
SELECT is(public.commerce_checkout_payment_guidance_snapshot(NULL, NULL), NULL::jsonb, 'missing order returns null');
SELECT is(public.commerce_checkout_payment_guidance_snapshot(
  (SELECT order_id FROM fixture_ids WHERE n = 2), (SELECT intent_id FROM fixture_ids WHERE n = 1)), NULL::jsonb, 'wrong order-intent pair returns null');
SELECT is(pg_temp.guidance()->>'eligible', 'true', 'one-time provenance is eligible');
SELECT is(pg_temp.guidance()->>'observedSuccess', 'false',
  'snapshot exposes absence of exact observed provider success');
SELECT is(pg_temp.guidance(3)->>'eligible', 'true', 'matching first-cycle provenance is eligible');

INSERT INTO public.commerce_checkout_recovery_tokens(id, order_id, client_id, token_hash, expires_at)
SELECT 'a1700000-0000-4000-8000-000000000001', order_id, 'a1000000-0000-4000-8000-000000000001',
  repeat('b', 64), now() + interval '1 day' FROM fixture_ids WHERE n = 1;
SELECT is(pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized', 'true', 'live exact token authorized');
SELECT is(pg_temp.guidance()->>'tokenAuthorized', 'false', 'absent token is not authority');
UPDATE public.commerce_checkout_recovery_tokens SET revoked_at = now() WHERE id = 'a1700000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized', 'false', 'revocation rechecked inside snapshot');
UPDATE public.commerce_checkout_recovery_tokens SET revoked_at = NULL, used_at = now() WHERE id = 'a1700000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized', 'false', 'consumption rechecked inside snapshot');
UPDATE public.commerce_checkout_recovery_tokens SET used_at = NULL, expires_at = now() - interval '1 second' WHERE id = 'a1700000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized', 'false', 'expiry rechecked inside snapshot');
UPDATE public.commerce_checkout_recovery_tokens SET expires_at = now() + interval '1 day' WHERE id = 'a1700000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(2, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized', 'false', 'different order token denied');
UPDATE public.commerce_checkout_recovery_tokens SET client_id = 'a1000000-0000-4000-8000-000000000002' WHERE id = 'a1700000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized', 'false', 'different client token denied');
UPDATE public.commerce_checkout_recovery_tokens SET client_id = 'a1000000-0000-4000-8000-000000000001' WHERE id = 'a1700000-0000-4000-8000-000000000001';

UPDATE public.commerce_orders SET metadata = metadata #- '{runtimeFinalize,source}' WHERE id = (SELECT order_id FROM fixture_ids WHERE n = 2);
SELECT is(pg_temp.guidance(2)->>'eligible', 'false', 'missing provenance does not infer checkout');
UPDATE public.commerce_payment_intents SET metadata = '{"checkoutKind":"one_time"}' WHERE id = (SELECT intent_id FROM fixture_ids WHERE n = 3);
SELECT is(pg_temp.guidance(3)->>'eligible', 'false', 'contradictory intent provenance excluded');
UPDATE public.commerce_payment_intents SET metadata = '{"checkoutKind":"subscription_initial"}' WHERE id = (SELECT intent_id FROM fixture_ids WHERE n = 3);
UPDATE public.subscription_cycles SET cycle_number = 2 WHERE id = 'a1500000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(3)->>'eligible', 'false', 'renewal does not inherit initial checkout policy');
UPDATE public.subscription_cycles SET cycle_number = 1, order_id = NULL WHERE id = 'a1500000-0000-4000-8000-000000000001';
SELECT is(pg_temp.guidance(3)->>'eligible', 'false', 'reciprocal cycle-order link required');
SELECT is(pg_temp.guidance()#>>'{attempts,0,id}', 'a1600000-0000-4000-8000-000000000002', 'newest attempt comes first');

-- Only row-correlated signed events and readbacks join the exact current attempt.
INSERT INTO public.inbound_provider_events(provider, provider_event_id, event_type, payload,
  payment_intent_id, payment_attempt_id, provider_payment_id, signature_verified)
SELECT CASE WHEN v.n = 4 THEN 'other_rail' ELSE 'test_rail' END, 'guidance-event-' || v.n,
  'payment.failed', jsonb_build_object('failureEvidence', body || '{"source":"webhook"}', 'secret', 'must-not-leak'),
  CASE WHEN v.n = 5 THEN (SELECT intent_id FROM fixture_ids WHERE n = 2) ELSE f.intent_id END,
  CASE WHEN v.n = 6 THEN NULL ELSE 'a1600000-0000-4000-8000-000000000002'::uuid END,
  CASE WHEN v.n = 3 THEN 'wrong-payment' ELSE 'pay-current' END, v.n <> 2
FROM generate_series(1, 6) v(n) CROSS JOIN fixture_ids f CROSS JOIN evidence_fixture WHERE f.n = 1;
INSERT INTO public.commerce_payment_reconciliation_runs(provider, provider_payment_id,
  payment_intent_id, payment_attempt_id, local_status, provider_status, idempotency_key, payload)
SELECT 'test_rail', 'pay-current', intent_id, 'a1600000-0000-4000-8000-000000000002',
  'failed', 'failed', 'guidance-readback', jsonb_build_object('normalizedStatus', 'failed', 'providerPayload', jsonb_build_object('failureEvidence', body || '{"source":"readback"}', 'secret', 'must-not-leak'))
FROM fixture_ids CROSS JOIN evidence_fixture WHERE n = 1;
SELECT is(jsonb_array_length(pg_temp.guidance()#>'{attempts,0,evidence}'), 3, 'only execution plus exactly correlated signed event and readback');
SELECT ok(pg_temp.guidance()::text NOT LIKE '%must-not-leak%' AND pg_temp.guidance()::text NOT LIKE '%token_hash%', 'narrow projection omits raw and nested secrets');
SELECT is(jsonb_array_length(pg_temp.guidance()#>'{attempts,1,evidence}'), 1, 'current failure evidence never attaches to old attempt');

INSERT INTO public.inbound_provider_events(provider, provider_event_id, event_type, payload,
  payment_intent_id, payment_attempt_id, provider_payment_id, signature_verified)
SELECT 'test_rail', 'guidance-unapplied-success', 'payment.succeeded', '{}', intent_id,
  'a1600000-0000-4000-8000-000000000002', 'pay-current', false FROM fixture_ids WHERE n = 1;
SELECT is(jsonb_array_length(pg_temp.guidance()#>'{attempts,0,evidence}'), 3, 'unverified success is not payment evidence');
UPDATE public.inbound_provider_events SET signature_verified = true WHERE provider_event_id = 'guidance-unapplied-success';
SELECT ok(pg_temp.guidance()#>>'{snapshot,intentStatus}' = 'failed'
  AND pg_temp.guidance()->>'observedSuccess' = 'true'
  AND pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb, 'signed unapplied success is exposed and suppresses advice without inventing local paid');
UPDATE public.inbound_provider_events SET provider_payment_id = 'wrong-payment' WHERE provider_event_id = 'guidance-unapplied-success';
SELECT ok(jsonb_array_length(pg_temp.guidance()#>'{attempts,0,evidence}') = 3
  AND pg_temp.guidance()->>'observedSuccess' = 'false',
  'uncorrelated success is not exposed and does not change current evidence');
UPDATE public.inbound_provider_events SET provider_payment_id = 'pay-old',
  payment_attempt_id = 'a1600000-0000-4000-8000-000000000001' WHERE provider_event_id = 'guidance-unapplied-success';
SELECT ok(pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb
  AND pg_temp.guidance()->>'observedSuccess' = 'true',
  'success of an older exact attempt is exposed and suppresses repayment advice');
DELETE FROM public.inbound_provider_events WHERE provider_event_id = 'guidance-unapplied-success';
UPDATE public.commerce_payment_reconciliation_runs SET payload = payload || '{"normalizedStatus":"succeeded","applied":false}'
WHERE idempotency_key = 'guidance-readback';
SELECT ok(pg_temp.guidance()#>>'{snapshot,intentStatus}' = 'failed'
  AND pg_temp.guidance()->>'observedSuccess' = 'true'
  AND pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb, 'unapplied successful readback is exposed and suppresses advice without settling');
UPDATE public.commerce_payment_reconciliation_runs SET payload = (payload - 'applied') || '{"normalizedStatus":"failed"}' WHERE idempotency_key = 'guidance-readback';

-- An execution refusal is bound to its local row even when its PSP handle is
-- deliberately not registered for callback correlation (StripeCardError).
UPDATE public.commerce_payment_attempts SET provider_attempt_id = NULL
WHERE id = 'a1600000-0000-4000-8000-000000000002';
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'true'
  AND jsonb_array_length(pg_temp.guidance()#>'{attempts,0,evidence}') = 1,
  'exact local execution evidence survives absent durable handle; external channels do not join');
SELECT is(pg_temp.guidance()#>>'{attempts,0,evidence,0,providerPaymentId}', 'pay-current',
  'diagnostic provider ID retained without registering callback correlation');
UPDATE public.commerce_payment_attempts SET provider_attempt_id = 'contradictory'
WHERE id = 'a1600000-0000-4000-8000-000000000002';
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'false'
  AND pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb,
  'nonnull contradictory execution provider handle remains rejected');
UPDATE public.commerce_payment_attempts SET provider_attempt_id = 'pay-current'
WHERE id = 'a1600000-0000-4000-8000-000000000002';
UPDATE public.commerce_payment_reconciliation_runs SET payload = payload || '{"resultStatus":"succeeded"}'
WHERE idempotency_key = 'guidance-readback';
SELECT is(jsonb_array_length(pg_temp.guidance()#>'{attempts,0,evidence}'), 3,
  'apply metadata does not override actual normalized readback status');
UPDATE public.commerce_payment_reconciliation_runs SET payload = payload - 'resultStatus'
WHERE idempotency_key = 'guidance-readback';

-- TPay has two durable provider handles for one exact attempt. API execution
-- and reconciliation use the transaction ID; signed webhooks use the merchant
-- title. Cross-source and unrelated values must not become evidence or success.
UPDATE public.commerce_orders
SET metadata = jsonb_set(metadata, '{runtimeFinalize,source}', '"commerce.runtime.hidden.v0"')
WHERE id = (SELECT order_id FROM fixture_ids WHERE n = 2);
UPDATE public.commerce_payments SET provider = 'tpay'
WHERE id = (SELECT payment_id FROM fixture_ids WHERE n = 2);
INSERT INTO public.commerce_payment_attempts(id, payment_intent_id, payment_id, provider,
  provider_attempt_id, provider_session_id, idempotency_key, status, amount_cents, currency,
  created_at, request_payload, response_payload)
SELECT 'a1600000-0000-4000-8000-000000000003', intent_id, payment_id, 'tpay',
  'TR-GUIDANCE-EXACT', 'tpay-transaction-exact', 'guidance-tpay-attempt', 'failed',
  100, 'XTS', '2026-09-11T10:01:00Z', '{"providerFlow":"blik_one_time"}',
  jsonb_build_object('failureEvidence', body || jsonb_build_object(
    'source', 'execution', 'providerPaymentId', 'tpay-transaction-exact'))
FROM fixture_ids CROSS JOIN evidence_fixture WHERE n = 2;
UPDATE public.commerce_payment_intents
SET active_attempt_id = 'a1600000-0000-4000-8000-000000000003',
    provider_payment_id = 'TR-GUIDANCE-EXACT'
WHERE id = (SELECT intent_id FROM fixture_ids WHERE n = 2);

INSERT INTO public.inbound_provider_events(provider, provider_event_id, event_type, payload,
  payment_intent_id, payment_attempt_id, provider_payment_id, signature_verified)
SELECT 'tpay', event_id, 'payment.failed', jsonb_build_object('failureEvidence',
  body || jsonb_build_object('source', 'webhook', 'providerPaymentId', evidence_id)),
  intent_id, 'a1600000-0000-4000-8000-000000000003', join_id, true
FROM fixture_ids CROSS JOIN evidence_fixture CROSS JOIN (VALUES
  ('guidance-tpay-event-exact', 'TR-GUIDANCE-EXACT', 'TR-GUIDANCE-EXACT'),
  ('guidance-tpay-event-session-crossed', 'tpay-transaction-exact', 'tpay-transaction-exact'),
  ('guidance-tpay-event-unrelated', 'TR-GUIDANCE-OTHER', 'TR-GUIDANCE-OTHER')
) events(event_id, join_id, evidence_id)
WHERE n = 2;

INSERT INTO public.commerce_payment_reconciliation_runs(provider, provider_payment_id,
  payment_intent_id, payment_attempt_id, local_status, provider_status, idempotency_key, payload)
SELECT 'tpay', join_id, intent_id, 'a1600000-0000-4000-8000-000000000003',
  'failed', 'failed', run_key, jsonb_build_object('normalizedStatus', 'failed',
    'providerPayload', jsonb_build_object('failureEvidence', body || jsonb_build_object(
      'source', 'readback', 'providerPaymentId', evidence_id)))
FROM fixture_ids CROSS JOIN evidence_fixture CROSS JOIN (VALUES
  ('tpay-transaction-exact', 'tpay-transaction-exact', 'guidance-tpay-readback-exact'),
  ('TR-GUIDANCE-EXACT', 'TR-GUIDANCE-EXACT', 'guidance-tpay-readback-title-crossed'),
  ('tpay-transaction-other', 'tpay-transaction-other', 'guidance-tpay-readback-unrelated')
) runs(join_id, evidence_id, run_key)
WHERE n = 2;

SELECT ok(pg_temp.guidance(2)->>'historyComplete' = 'true'
  AND jsonb_array_length(pg_temp.guidance(2)#>'{attempts,0,evidence}') = 3,
  'TPay keeps execution, webhook and reconciliation evidence on their source-specific exact IDs');
SELECT is((SELECT count(*)::integer FROM jsonb_array_elements(
    pg_temp.guidance(2)#>'{attempts,0,evidence}') item WHERE item->>'source' = 'execution'
      AND item->>'providerPaymentId' = 'tpay-transaction-exact'), 1,
  'TPay execution refusal correlates by provider_session_id transaction ID');
SELECT is((SELECT count(*)::integer FROM jsonb_array_elements(
    pg_temp.guidance(2)#>'{attempts,0,evidence}') item WHERE item->>'source' = 'webhook'
      AND item->>'providerPaymentId' = 'TR-GUIDANCE-EXACT'), 1,
  'TPay webhook evidence correlates by provider_attempt_id merchant title');
SELECT is((SELECT count(*)::integer FROM jsonb_array_elements(
    pg_temp.guidance(2)#>'{attempts,0,evidence}') item WHERE item->>'source' = 'readback'
      AND item->>'providerPaymentId' = 'tpay-transaction-exact'), 1,
  'TPay reconciliation refusal correlates by provider_session_id transaction ID');

INSERT INTO public.inbound_provider_events(provider, provider_event_id, event_type, payload,
  payment_intent_id, payment_attempt_id, provider_payment_id, signature_verified)
SELECT 'tpay', 'guidance-tpay-success-session-crossed', 'payment.succeeded', '{}', intent_id,
  'a1600000-0000-4000-8000-000000000003', 'tpay-transaction-exact', true
FROM fixture_ids WHERE n = 2;
INSERT INTO public.commerce_payment_reconciliation_runs(provider, provider_payment_id,
  payment_intent_id, payment_attempt_id, local_status, provider_status, idempotency_key, payload)
SELECT 'tpay', 'TR-GUIDANCE-EXACT', intent_id,
  'a1600000-0000-4000-8000-000000000003', 'failed', 'succeeded',
  'guidance-tpay-success-title-crossed', '{"normalizedStatus":"succeeded","applied":false}'
FROM fixture_ids WHERE n = 2;
SELECT ok(jsonb_array_length(pg_temp.guidance(2)#>'{attempts,0,evidence}') = 3
  AND pg_temp.guidance(2)->>'observedSuccess' = 'false',
  'TPay cross-source and unrelated IDs neither expose success, attach evidence nor suppress guidance');

INSERT INTO public.commerce_payment_reconciliation_runs(provider, provider_payment_id,
  payment_intent_id, payment_attempt_id, local_status, provider_status, idempotency_key, payload)
SELECT 'tpay', 'tpay-transaction-exact', intent_id,
  'a1600000-0000-4000-8000-000000000003', 'failed', 'succeeded',
  'guidance-tpay-success-exact', '{"normalizedStatus":"succeeded","applied":false}'
FROM fixture_ids WHERE n = 2;
SELECT ok(pg_temp.guidance(2)#>>'{snapshot,intentStatus}' = 'failed'
  AND pg_temp.guidance(2)->>'observedSuccess' = 'true'
  AND pg_temp.guidance(2)#>'{attempts,0,evidence}' = '[]'::jsonb,
  'TPay unapplied exact-transaction success is exposed and suppresses guidance');

-- Duplicate delivery keeps the existing immutable event identity.
INSERT INTO public.inbound_provider_events(provider, provider_event_id, event_type, payload)
VALUES ('test_rail', 'guidance-event-1', 'payment.failed', '{}') ON CONFLICT (provider, provider_event_id) DO NOTHING;
SELECT is(jsonb_array_length(pg_temp.guidance()#>'{attempts,0,evidence}'), 3, 'duplicate delivery adds no evidence');

UPDATE public.inbound_provider_events SET payload = jsonb_set(payload, '{failureEvidence,providerPaymentId}', '"wrong-payment"')
WHERE provider_event_id = 'guidance-event-1';
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'false' AND pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb, 'contradictory envelope identity makes evidence incomplete');
UPDATE public.inbound_provider_events SET payload = jsonb_set(payload, '{failureEvidence,providerPaymentId}', '"pay-current"')
WHERE provider_event_id = 'guidance-event-1';
UPDATE public.inbound_provider_events SET payload = jsonb_set(payload, '{failureEvidence,code}', to_jsonb(repeat('x', 9000)))
WHERE provider_event_id = 'guidance-event-1';
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'false' AND pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb, 'oversized envelope is not returned as partial proof');
UPDATE public.inbound_provider_events SET payload = jsonb_set(payload, '{failureEvidence,code}', '"declined"')
WHERE provider_event_id = 'guidance-event-1';

INSERT INTO public.inbound_provider_events(provider, provider_event_id, event_type, payload,
  payment_intent_id, payment_attempt_id, provider_payment_id, signature_verified)
SELECT 'test_rail', 'guidance-overflow-' || v.n, 'payment.failed', jsonb_build_object('failureEvidence', body),
  intent_id, 'a1600000-0000-4000-8000-000000000002', 'pay-current', true
FROM generate_series(1, 33) v(n) CROSS JOIN fixture_ids f CROSS JOIN evidence_fixture WHERE f.n = 1;
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'false' AND pg_temp.guidance()#>'{attempts,0,evidence}' = '[]'::jsonb, 'evidence truncation drops the entire uncertain set');
DELETE FROM public.inbound_provider_events WHERE provider_event_id LIKE 'guidance-overflow-%';
INSERT INTO public.commerce_payment_attempts(payment_intent_id, payment_id, provider, idempotency_key,
  status, amount_cents, currency, created_at)
SELECT intent_id, payment_id, 'test_rail', 'guidance-history-' || v.n, 'cancelled', 100, 'XTS',
  '2026-01-01T00:00:00Z'::timestamptz + v.n * interval '1 second'
FROM generate_series(1, 98) v(n) CROSS JOIN fixture_ids f WHERE f.n = 1;
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'true' AND jsonb_array_length(pg_temp.guidance()->'attempts') = 100, 'exactly 100 attempts remain complete');
INSERT INTO public.commerce_payment_attempts(payment_intent_id, payment_id, provider, idempotency_key, status, amount_cents, currency, created_at)
SELECT intent_id, payment_id, 'test_rail', 'guidance-history-overflow', 'created', 100, 'XTS', '2025-01-01T00:00:00Z' FROM fixture_ids WHERE n = 1;
SELECT ok(pg_temp.guidance()->>'historyComplete' = 'false' AND jsonb_array_length(pg_temp.guidance()->'attempts') = 100, '101st attempt marks bounded history incomplete');

-- Capture row images around repeated reads; the optional reader never consumes tokens.
CREATE TEMP TABLE before_read AS SELECT md5(string_agg(image, '' ORDER BY image)) AS digest FROM (
  SELECT to_jsonb(o)::text AS image FROM public.commerce_orders o WHERE id IN (SELECT order_id FROM fixture_ids)
  UNION ALL SELECT to_jsonb(t)::text FROM public.commerce_checkout_recovery_tokens t WHERE id = 'a1700000-0000-4000-8000-000000000001'
) rows;
DO $$ BEGIN PERFORM pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001'); END $$;
SELECT is((SELECT md5(string_agg(image, '' ORDER BY image)) FROM (
  SELECT to_jsonb(o)::text AS image FROM public.commerce_orders o WHERE id IN (SELECT order_id FROM fixture_ids)
  UNION ALL SELECT to_jsonb(t)::text FROM public.commerce_checkout_recovery_tokens t WHERE id = 'a1700000-0000-4000-8000-000000000001'
) rows), (SELECT digest FROM before_read), 'snapshot leaves order and token row images unchanged');
UPDATE public.commerce_orders SET status = 'paid' WHERE id = (SELECT order_id FROM fixture_ids WHERE n = 1);
UPDATE public.commerce_payment_intents SET status = 'succeeded' WHERE id = (SELECT intent_id FROM fixture_ids WHERE n = 1);
UPDATE public.commerce_payment_attempts SET status = 'succeeded' WHERE id = 'a1600000-0000-4000-8000-000000000002';
SELECT ok(pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')#>>'{snapshot,intentStatus}' = 'succeeded'
  AND pg_temp.guidance(1, 'a1700000-0000-4000-8000-000000000001')->>'tokenAuthorized' = 'false', 'late paid truth survives invalid token and older refusals');
SELECT is(pg_temp.guidance()#>>'{snapshot,paymentAttemptId}', 'a1600000-0000-4000-8000-000000000002', 'snapshot retains exact active attempt identity');

SELECT * FROM finish();
ROLLBACK;
