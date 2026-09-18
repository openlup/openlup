-- pgTAP: durable provider-command ledger (Wave 2A).
BEGIN;
SELECT plan(31);

SELECT is(private.commerce_fulfillment_legacy_command_status(repeat('a',64), 'created', 'remote-1'), 'confirmed', 'legacy created ref with provider identity is confirmed evidence');
SELECT is(private.commerce_fulfillment_legacy_command_status(repeat('a',64), 'created', NULL), 'uncertain', 'legacy created ref without provider identity is uncertain');
SELECT is(private.commerce_fulfillment_legacy_command_status(repeat('a',64), 'failed', NULL), 'manual_review', 'legacy failed ref is never executable work');
SELECT is(private.commerce_fulfillment_legacy_command_status('raw-payload-like-value', 'created', 'remote-2'), 'manual_review', 'invalid legacy fingerprint is quarantined for manual review');

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('omnipack', 'fulfillment', 'OmniPack Fulfillment', 'experimental')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.clients (id, email)
VALUES ('81111111-1111-4111-8111-111111111111', 'provider-command-ledger@example.test');
INSERT INTO public.addresses (id, client_id, kind, label, line1, city, postal_code, country, is_default)
VALUES ('82222222-2222-4222-8222-222222222222', '81111111-1111-4111-8111-111111111111', 'shipping', 'Ledger', 'Prosta 1', 'Warszawa', '00-001', 'PL', true);
INSERT INTO public.commerce_orders (id, client_id, status, currency, subtotal_cents, total_cents, mode, shipping_address_id, region_code)
VALUES
  ('83333333-3333-4333-8333-333333333333', '81111111-1111-4111-8111-111111111111', 'paid', 'PLN', 1000, 1000, 'one_time', '82222222-2222-4222-8222-222222222222', 'PL'),
  ('83333333-3333-4333-8333-333333333334', '81111111-1111-4111-8111-111111111111', 'paid', 'PLN', 1000, 1000, 'one_time', '82222222-2222-4222-8222-222222222222', 'PL'),
  ('83333333-3333-4333-8333-333333333335', '81111111-1111-4111-8111-111111111111', 'paid', 'PLN', 1000, 1000, 'one_time', '82222222-2222-4222-8222-222222222222', 'PL'),
  ('83333333-3333-4333-8333-333333333336', '81111111-1111-4111-8111-111111111111', 'paid', 'PLN', 1000, 1000, 'one_time', '82222222-2222-4222-8222-222222222222', 'PL');
INSERT INTO public.commerce_fulfillment_orders (id, order_id, client_id, shipping_address_id, create_idempotency_key, shipping_address_snapshot)
VALUES ('84444444-4444-4444-8444-444444444444', '83333333-3333-4333-8333-333333333333', '81111111-1111-4111-8111-111111111111', '82222222-2222-4222-8222-222222222222', 'provider-command-ledger-fulfillment-1', '{}'::jsonb);
INSERT INTO public.commerce_fulfillment_orders (id, order_id, client_id, shipping_address_id, create_idempotency_key, shipping_address_snapshot)
VALUES
  ('84444444-4444-4444-8444-444444444445', '83333333-3333-4333-8333-333333333334', '81111111-1111-4111-8111-111111111111', '82222222-2222-4222-8222-222222222222', 'provider-command-ledger-fulfillment-2', '{}'::jsonb),
  ('84444444-4444-4444-8444-444444444446', '83333333-3333-4333-8333-333333333335', '81111111-1111-4111-8111-111111111111', '82222222-2222-4222-8222-222222222222', 'provider-command-ledger-fulfillment-3', '{}'::jsonb),
  ('84444444-4444-4444-8444-444444444447', '83333333-3333-4333-8333-333333333336', '81111111-1111-4111-8111-111111111111', '82222222-2222-4222-8222-222222222222', 'provider-command-ledger-fulfillment-4', '{}'::jsonb);

CREATE TEMP TABLE _enqueue AS
SELECT public.commerce_fulfillment_enqueue_provider_command(
  '84444444-4444-4444-8444-444444444444', 'omnipack', 'dispatch_create', '1',
  '85555555-5555-4555-8555-555555555555', repeat('a', 64), repeat('b', 64), NULL,
  repeat('c', 64), repeat('d', 64), repeat('e', 64), 2
) AS result;

SELECT is((SELECT result->>'status' FROM _enqueue), 'queued', 'enqueue creates only a durable queued command');
SELECT is((SELECT count(*)::int FROM public.commerce_fulfillment_provider_commands), 1, 'one durable command exists');
SELECT is((SELECT count(*)::int FROM public.commerce_fulfillment_provider_command_transitions), 1, 'enqueue is append-only transition evidence');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='commerce_fulfillment_provider_commands'
    AND column_name IN ('request_payload','response_payload','error','metadata')
), 'new command table has no raw payload or free-form error columns');

CREATE TEMP TABLE _enqueue_replay AS
SELECT public.commerce_fulfillment_enqueue_provider_command(
  '84444444-4444-4444-8444-444444444444', 'omnipack', 'dispatch_create', '1',
  '85555555-5555-4555-8555-555555555555', repeat('a', 64), repeat('b', 64), NULL,
  repeat('c', 64), repeat('d', 64), repeat('e', 64), 2
) AS result;
SELECT is((SELECT result->>'commandId' FROM _enqueue_replay), (SELECT result->>'commandId' FROM _enqueue), 'same idempotency key replays the exact command');
SELECT is((SELECT count(*)::int FROM public.commerce_fulfillment_provider_command_transitions), 1, 'idempotent enqueue does not append a second transition');

SELECT throws_ok(
  $$ UPDATE public.commerce_fulfillment_provider_commands SET status='accepted', version=version+1 WHERE id=(SELECT (result->>'commandId')::uuid FROM _enqueue) $$,
  '22023', 'fulfillment_provider_command_transition_invalid', 'queued cannot skip claim and submission to become accepted'
);

CREATE TEMP TABLE _claim AS
SELECT public.commerce_fulfillment_claim_provider_commands('omnipack', 'dispatch_create', 1, repeat('f', 64), 60) AS value;
SELECT is((SELECT count(*)::int FROM _claim), 1, 'claim returns one command');
SELECT is((SELECT value->>'status' FROM _claim), 'claimed', 'claim response is closed claimed state');
SELECT is((SELECT value->>'contractVersion' FROM _claim), '1', 'claim returns frozen contract version');
SELECT is((SELECT value->>'configurationFingerprint' FROM _claim), repeat('d', 64), 'claim returns immutable configuration fingerprint');
SELECT is((SELECT (value->>'retryCount')::int FROM _claim), 0, 'claim does not consume the provider-send retry budget');

CREATE TEMP TABLE _released AS
SELECT public.commerce_fulfillment_release_or_cancel_command(
  (SELECT (value->>'commandId')::uuid FROM _claim),
  (SELECT (value->>'claimToken')::uuid FROM _claim),
  (SELECT (value->>'claimGeneration')::bigint FROM _claim),
  (SELECT (value->>'version')::bigint FROM _claim),
  'release', 'command_enqueued'
) AS result;
SELECT is((SELECT result->>'status' FROM _released), 'queued', 'a lease release before submission returns command to queued without spending budget');
CREATE TEMP TABLE _reclaim AS
SELECT public.commerce_fulfillment_claim_provider_commands('omnipack', 'dispatch_create', 1, repeat('f', 64), 60) AS value;
SELECT is((SELECT (value->>'retryCount')::int FROM _reclaim), 0, 'reclaim after a pre-send release retains zero provider attempts');
SELECT is((SELECT from_status FROM public.commerce_fulfillment_provider_command_transitions ORDER BY command_version DESC LIMIT 1), 'queued', 'reclaim transition records the real prior queued status');

CREATE TEMP TABLE _submitting AS
SELECT public.commerce_fulfillment_mark_command_submitting(
  (SELECT (value->>'commandId')::uuid FROM _reclaim),
  (SELECT (value->>'claimToken')::uuid FROM _reclaim),
  (SELECT (value->>'claimGeneration')::bigint FROM _reclaim),
  (SELECT (value->>'version')::bigint FROM _reclaim)
) AS result;
SELECT is((SELECT result->>'status' FROM _submitting), 'submitting', 'submission is durably written before a provider call');

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_apply_command_write_outcome(
    (SELECT (value->>'commandId')::uuid FROM _reclaim),
    (SELECT (value->>'claimToken')::uuid FROM _reclaim),
    (SELECT (value->>'claimGeneration')::bigint FROM _reclaim),
    (SELECT (result->>'version')::bigint - 1 FROM _submitting),
    repeat('a', 64), 'uncertain', 'write_uncertain', NULL, NULL, NULL) $$,
  '40001', 'fulfillment_provider_command_fence_conflict', 'stale optimistic version cannot finalize a claim'
);

-- Simulate a crashed process after the durable boundary. This bypass is only
-- available to the local postgres test owner; normal table writes are rejected
-- by the command guard trigger.
SET LOCAL session_replication_role = replica;
UPDATE public.commerce_fulfillment_provider_commands
   SET claim_expires_at = now() - interval '1 second', version = version + 1
 WHERE id = (SELECT (value->>'commandId')::uuid FROM _reclaim);
SET LOCAL session_replication_role = origin;
CREATE TEMP TABLE _recovery AS SELECT public.commerce_fulfillment_recover_expired_provider_commands(10) AS result;
SELECT is((SELECT (result->0)->>'status' FROM _recovery), 'uncertain', 'expired submitting is uncertain, never requeued');
SELECT is((SELECT status FROM public.commerce_fulfillment_provider_commands), 'uncertain', 'command remains stopped for evidence or manual review');

SELECT throws_ok(
  $$ UPDATE public.commerce_fulfillment_provider_commands SET retry_budget=20, version=version+1 WHERE id=(SELECT (value->>'commandId')::uuid FROM _reclaim) $$,
  '22023', 'fulfillment_provider_command_identity_immutable', 'retry budget is immutable after enqueue'
);

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_resolve_uncertain_command(
    (SELECT (value->>'commandId')::uuid FROM _reclaim),
    (SELECT version FROM public.commerce_fulfillment_provider_commands),
    repeat('1', 64), 'retry_wait', 'authoritative_absence', 'authoritative_absence', repeat('1', 64), now(), 'provider_lookup', now() + interval '1 minute') $$,
  '22023', 'fulfillment_provider_command_resolution_proof_invalid', 'absence proof must bind to immutable command identity'
);

SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_resolve_uncertain_command(
    (SELECT (value->>'commandId')::uuid FROM _reclaim),
    (SELECT version FROM public.commerce_fulfillment_provider_commands),
    repeat('e', 64), 'retry_wait', 'authoritative_absence', 'authoritative_absence', repeat('e', 64), now(), 'operator_verified', now() + interval '1 minute') $$,
  '22023', 'fulfillment_provider_command_resolution_unsafe', 'uncertain cannot retry without current provider lookup absence proof'
);

SELECT is((SELECT count(*)::int FROM public.commerce_fulfillment_provider_commands WHERE status IN ('queued', 'retry_wait')), 0, 'no blind retry is created by recovery');
SELECT throws_ok(
  $$ UPDATE public.commerce_fulfillment_provider_commands SET status='terminal_rejected', version=version+1 WHERE id=(SELECT (value->>'commandId')::uuid FROM _reclaim) $$,
  '22023', 'fulfillment_provider_command_transition_invalid', 'uncertain command cannot be finalized without a structured proof transition'
);

-- Terminal states have no outgoing FSM edges. Insert terminal fixtures directly
-- so this test proves the database guard, independently of the mutation RPCs.
INSERT INTO public.commerce_fulfillment_provider_commands (
  fulfillment_order_id, order_id, provider_kind, command_kind, contract_version,
  idempotency_key_fingerprint, command_key_fingerprint, command_payload_fingerprint,
  routing_fingerprint, config_fingerprint, correlation_fingerprint,
  status, last_reason_code, finished_at
)
VALUES
  ('84444444-4444-4444-8444-444444444445', '83333333-3333-4333-8333-333333333334', 'omnipack', 'dispatch_create', '1',
   repeat('1',64), repeat('2',64), repeat('3',64), repeat('4',64), repeat('5',64), repeat('6',64),
   'confirmed', 'provider_effect_present', now()),
  ('84444444-4444-4444-8444-444444444446', '83333333-3333-4333-8333-333333333335', 'omnipack', 'dispatch_create', '1',
   repeat('7',64), repeat('8',64), repeat('9',64), repeat('0',64), repeat('a',64), repeat('b',64),
   'cancelled', 'operator_cancelled', now()),
  ('84444444-4444-4444-8444-444444444447', '83333333-3333-4333-8333-333333333336', 'omnipack', 'dispatch_create', '1',
   repeat('c',64), repeat('d',64), repeat('e',64), repeat('f',64), repeat('1',64), repeat('2',64),
   'terminal_rejected', 'terminal_rejection', now());

SELECT throws_ok(
  $$ UPDATE public.commerce_fulfillment_provider_commands SET status='queued', version=version+1 WHERE fulfillment_order_id='84444444-4444-4444-8444-444444444445' $$,
  '22023', 'fulfillment_provider_command_transition_invalid', 'confirmed is immutable and cannot return to executable work'
);
SELECT throws_ok(
  $$ UPDATE public.commerce_fulfillment_provider_commands SET status='queued', version=version+1 WHERE fulfillment_order_id='84444444-4444-4444-8444-444444444446' $$,
  '22023', 'fulfillment_provider_command_transition_invalid', 'cancelled is immutable and cannot return to executable work'
);
SELECT throws_ok(
  $$ UPDATE public.commerce_fulfillment_provider_commands SET status='queued', version=version+1 WHERE fulfillment_order_id='84444444-4444-4444-8444-444444444447' $$,
  '22023', 'fulfillment_provider_command_transition_invalid', 'terminal_rejected is immutable and cannot return to executable work'
);
SELECT * FROM finish();
ROLLBACK;
