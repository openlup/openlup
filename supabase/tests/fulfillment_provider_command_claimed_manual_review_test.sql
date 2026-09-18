BEGIN;
SELECT plan(8);

INSERT INTO public.providers(kind, capability, display_name, status)
VALUES ('omnipack', 'fulfillment', 'OmniPack', 'experimental') ON CONFLICT (kind) DO NOTHING;
INSERT INTO public.clients(id, email) VALUES ('91111111-1111-4111-8111-111111111111', 'claimed-review@example.test');
INSERT INTO public.addresses(id, client_id, kind, label, line1, city, postal_code, country, is_default)
VALUES ('92222222-2222-4222-8222-222222222222', '91111111-1111-4111-8111-111111111111', 'shipping', 'Review', 'Test 1', 'Warszawa', '00-001', 'PL', true);
INSERT INTO public.commerce_orders(id, client_id, status, currency, subtotal_cents, total_cents, mode, shipping_address_id, region_code)
VALUES ('93333333-3333-4333-8333-333333333333', '91111111-1111-4111-8111-111111111111', 'paid', 'PLN', 100, 100, 'one_time', '92222222-2222-4222-8222-222222222222', 'PL');
INSERT INTO public.commerce_fulfillment_orders(id, order_id, client_id, shipping_address_id, create_idempotency_key, shipping_address_snapshot)
VALUES ('94444444-4444-4444-8444-444444444444', '93333333-3333-4333-8333-333333333333', '91111111-1111-4111-8111-111111111111', '92222222-2222-4222-8222-222222222222', 'claimed-review-fixture', '{}');

SELECT public.commerce_fulfillment_enqueue_provider_command(
  '94444444-4444-4444-8444-444444444444','omnipack','dispatch_create','1',
  '95555555-5555-4555-8555-555555555555',repeat('a',64),repeat('b',64),NULL,
  repeat('c',64),repeat('d',64),repeat('e',64),1
);
CREATE TEMP TABLE _claim AS
SELECT value FROM public.commerce_fulfillment_claim_provider_commands('omnipack','dispatch_create',1,repeat('f',64),60) value;

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_mark_claimed_command_manual_review(
    (SELECT (value->>'commandId')::uuid FROM _claim),(SELECT (value->>'claimToken')::uuid FROM _claim),
    (SELECT (value->>'claimGeneration')::bigint FROM _claim),(SELECT (value->>'version')::bigint FROM _claim),
    'effect_unknown') $$,
  '22023','fulfillment_provider_command_claimed_manual_review_invalid','reason vocabulary is closed'
);
SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_mark_claimed_command_manual_review(
    (SELECT (value->>'commandId')::uuid FROM _claim),'96666666-6666-4666-8666-666666666666',
    (SELECT (value->>'claimGeneration')::bigint FROM _claim),(SELECT (value->>'version')::bigint FROM _claim),
    'invalid_contract') $$,
  '40001','fulfillment_provider_command_fence_conflict','stale token cannot quarantine a claim'
);

CREATE TEMP TABLE _review AS SELECT public.commerce_fulfillment_mark_claimed_command_manual_review(
  (SELECT (value->>'commandId')::uuid FROM _claim),(SELECT (value->>'claimToken')::uuid FROM _claim),
  (SELECT (value->>'claimGeneration')::bigint FROM _claim),(SELECT (value->>'version')::bigint FROM _claim),
  'identity_mismatch') result;
SELECT is((SELECT result->>'status' FROM _review),'manual_review','claim becomes manual review');
SELECT is((SELECT last_reason_code FROM public.commerce_fulfillment_provider_commands),'identity_mismatch','reason is durable');
SELECT ok((SELECT claim_token IS NULL AND claim_owner_fingerprint IS NULL AND claim_expires_at IS NULL FROM public.commerce_fulfillment_provider_commands),'lease is cleared');
SELECT is((SELECT attempt_count FROM public.commerce_fulfillment_provider_commands),0,'no provider attempt is consumed');
SELECT is((SELECT from_status||'->'||to_status FROM public.commerce_fulfillment_provider_command_transitions ORDER BY command_version DESC LIMIT 1),'claimed->manual_review','transition evidence is appended');
SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_mark_claimed_command_manual_review(
    (SELECT (value->>'commandId')::uuid FROM _claim),(SELECT (value->>'claimToken')::uuid FROM _claim),
    (SELECT (value->>'claimGeneration')::bigint FROM _claim),(SELECT (value->>'version')::bigint FROM _claim),
    'identity_mismatch') $$,
  '40001','fulfillment_provider_command_fence_conflict','replay with stale fence cannot mutate manual review'
);
SELECT * FROM finish();
ROLLBACK;
