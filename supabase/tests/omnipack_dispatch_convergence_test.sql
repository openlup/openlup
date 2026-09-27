-- pgTAP: minimal OmniPack dispatch submission fence and atomic local ACK.
-- The suite intentionally starts at fulfillment.created and does not model
-- tracking ownership, address freeze, accounting, or provider-command execution.

BEGIN;
SELECT plan(132);

INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES (
  '71000000-0000-0000-0000-0000000000a1',
  'dispatch-convergence@example.invalid',
  'Dispatch', 'Convergence', '+48111000000'
);

INSERT INTO public.addresses (
  id, client_id, kind, line1, city, postal_code, country
) VALUES (
  '71000000-0000-0000-0000-0000000000a2',
  '71000000-0000-0000-0000-0000000000a1',
  'shipping', 'ul. Atomowa 1', 'Warszawa', '00-001', 'PL'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata, created_at
)
SELECT
  ('71000000-0000-0000-0000-' || lpad(series.i::text, 12, '0'))::uuid,
  '71000000-0000-0000-0000-0000000000a1'::uuid,
  'ODC-' || series.i,
  'fulfillment_pending', 'one_time', 'PLN', 1000, 1000,
  '{"selectedDelivery":{"providerKind":"omnipack","carrierCode":"INPOST_COURIER_STANDARD"}}'::jsonb,
  '2026-01-01'::timestamptz + series.i * interval '1 day'
FROM generate_series(1, 11) AS series(i);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, created_at
)
SELECT
  ('71000000-0000-0000-0001-' || lpad(series.i::text, 12, '0'))::uuid,
  ('71000000-0000-0000-0000-' || lpad(series.i::text, 12, '0'))::uuid,
  '71000000-0000-0000-0000-0000000000a1'::uuid,
  '71000000-0000-0000-0000-0000000000a2'::uuid,
  'odc-fulfillment-' || series.i,
  CASE WHEN series.i = 10 THEN 'cancelled' ELSE 'created' END,
  'omnipack',
  '{"line1":"ul. Atomowa 1","city":"Warszawa","postalCode":"00-001","deliveryContact":{"schemaVersion":1,"source":"legacy_inferred","revision":1,"recipientName":"Dispatch Convergence","contactEmail":"dispatch-convergence@example.invalid","contactPhone":"+48111000000","line1":"ul. Atomowa 1","line2":null,"city":"Warszawa","postalCode":"00-001","country":"PL","selectedDelivery":{"providerKind":"omnipack","carrierCode":"INPOST_COURIER_STANDARD"},"deliveryInstructions":null,"courierInstructions":null}}'::jsonb,
  '2026-01-01'::timestamptz + series.i * interval '1 day'
FROM generate_series(1, 11) AS series(i);

-- A parcel leaves only on proof of payment. `fulfillment_pending` is a claim the
-- order makes about itself and is writable out-of-band (an unpaid synthetic prod
-- order was live-dispatched on 2026-07-17), so the dispatch predicate re-asserts the
-- succeeded-intent invariant that commerce_fulfillment_create_order_v2 already
-- enforces at creation. Every order above is a legitimate paid order and carries the
-- proof; the payment-proof edge cases are seeded as orders 12-14 below.
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
)
SELECT
  ('71000000-0000-0000-0004-' || lpad(series.i::text, 12, '0'))::uuid,
  ('71000000-0000-0000-0000-' || lpad(series.i::text, 12, '0'))::uuid,
  'tpay', 'odc-payment-' || series.i,
  'succeeded', 1000, 'PLN'
FROM generate_series(1, 11) AS series(i);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency
)
SELECT
  ('71000000-0000-0000-0003-' || lpad(series.i::text, 12, '0'))::uuid,
  'one_time_order',
  ('71000000-0000-0000-0000-' || lpad(series.i::text, 12, '0'))::uuid,
  ('71000000-0000-0000-0004-' || lpad(series.i::text, 12, '0'))::uuid,
  'succeeded', 1000, 'PLN'
FROM generate_series(1, 11) AS series(i);

-- 12: the 2026-07-17 incident shape — claims fulfillment_pending, no payment at all.
-- 13: a charge was started but never succeeded.
-- 14: no payment, but the provider already holds it — repair must stay reachable.
INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency,
  subtotal_cents, total_cents, metadata, created_at
)
SELECT
  ('71000000-0000-0000-0000-' || lpad(series.i::text, 12, '0'))::uuid,
  '71000000-0000-0000-0000-0000000000a1'::uuid,
  'ODC-' || series.i,
  'fulfillment_pending', 'one_time', 'PLN', 1000, 1000,
  '{"selectedDelivery":{"providerKind":"omnipack","carrierCode":"INPOST_COURIER_STANDARD"}}'::jsonb,
  '2026-01-01'::timestamptz + series.i * interval '1 day'
FROM generate_series(12, 14) AS series(i);

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, created_at
)
SELECT
  ('71000000-0000-0000-0001-' || lpad(series.i::text, 12, '0'))::uuid,
  ('71000000-0000-0000-0000-' || lpad(series.i::text, 12, '0'))::uuid,
  '71000000-0000-0000-0000-0000000000a1'::uuid,
  '71000000-0000-0000-0000-0000000000a2'::uuid,
  'odc-fulfillment-' || series.i,
  'created',
  'omnipack',
  '{"line1":"ul. Atomowa 1","city":"Warszawa","postalCode":"00-001","deliveryContact":{"schemaVersion":1,"source":"legacy_inferred","revision":1,"recipientName":"Dispatch Convergence","contactEmail":"dispatch-convergence@example.invalid","contactPhone":"+48111000000","line1":"ul. Atomowa 1","line2":null,"city":"Warszawa","postalCode":"00-001","country":"PL","selectedDelivery":{"providerKind":"omnipack","carrierCode":"INPOST_COURIER_STANDARD"},"deliveryInstructions":null,"courierInstructions":null}}'::jsonb,
  '2026-01-01'::timestamptz + series.i * interval '1 day'
FROM generate_series(12, 14) AS series(i);

-- Order 13 only ever reached a non-charge-bearing intent status.
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '71000000-0000-0000-0004-000000000013',
  '71000000-0000-0000-0000-000000000013',
  'tpay', 'odc-payment-13', 'pending', 1000, 'PLN'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency
) VALUES (
  '71000000-0000-0000-0003-000000000013',
  'one_time_order',
  '71000000-0000-0000-0000-000000000013',
  '71000000-0000-0000-0004-000000000013',
  'created', 1000, 'PLN'
);

-- Order 14 carries accepted provider proof, so it belongs to the repair branch.
INSERT INTO public.omnipack_dispatch_refs (
  id, fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint, sanitized_request, sanitized_response
) VALUES (
  '71000000-0000-0000-0002-000000000014',
  '71000000-0000-0000-0001-000000000014',
  '71000000-0000-0000-0000-000000000014',
  'provider-order-unpaid-repair', 'live', 'created',
  'odc-dispatch-unpaid-repair', 'fingerprint-unpaid-repair',
  '{"sanitized":true}'::jsonb,
  '{"providerOrderId":"provider-order-unpaid-repair"}'::jsonb
);

-- Historical incident: OmniPack accepted and the ref was persisted, but the
-- local fulfillment remained created. This is repair work, never POST authority.
INSERT INTO public.omnipack_dispatch_refs (
  id, fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint, sanitized_request, sanitized_response
) VALUES (
  '71000000-0000-0000-0002-000000000001',
  '71000000-0000-0000-0001-000000000001',
  '71000000-0000-0000-0000-000000000001',
  'provider-order-incident', 'live', 'created',
  'odc-dispatch-incident', 'fingerprint-incident',
  '{"sanitized":true}'::jsonb,
  '{"providerOrderId":"provider-order-incident"}'::jsonb
);

-- Two command rows exercise only the transitional no-effect arbitration.
INSERT INTO public.commerce_fulfillment_provider_commands (
  id, fulfillment_order_id, order_id, provider_kind, command_kind,
  contract_version, idempotency_key_fingerprint, command_key_fingerprint,
  command_payload_fingerprint, provider_idempotency_key_fingerprint,
  routing_fingerprint, config_fingerprint, correlation_fingerprint,
  status, last_reason_code, version, claim_generation
) VALUES
  (
    '71000000-0000-0000-0003-000000000004',
    '71000000-0000-0000-0001-000000000004',
    '71000000-0000-0000-0000-000000000004',
    'omnipack', 'dispatch_create', '1', repeat('1', 64), repeat('2', 64),
    repeat('3', 64), repeat('4', 64), repeat('5', 64), repeat('6', 64),
    repeat('7', 64), 'queued', 'command_enqueued', 1, 0
  ),
  (
    '71000000-0000-0000-0003-000000000005',
    '71000000-0000-0000-0001-000000000005',
    '71000000-0000-0000-0000-000000000005',
    'omnipack', 'dispatch_create', '1', repeat('8', 64), repeat('9', 64),
    repeat('a', 64), repeat('b', 64), repeat('c', 64), repeat('d', 64),
    repeat('e', 64), 'claimed', 'claimed', 2, 1
  ),
  (
    '71000000-0000-0000-0003-000000000011',
    '71000000-0000-0000-0001-000000000011',
    '71000000-0000-0000-0000-000000000011',
    'omnipack', 'dispatch_create', '1', repeat('f', 64), repeat('0', 64),
    repeat('f', 64), repeat('0', 64), repeat('f', 64), repeat('0', 64),
    repeat('f', 64), 'retry_wait', 'safe_rejection', 3, 1
  );

INSERT INTO public.commerce_fulfillment_provider_command_transitions (
  command_id, from_status, to_status, reason_code, command_version,
  attempt_count, claim_generation
) VALUES
  (
  '71000000-0000-0000-0003-000000000004',
  NULL, 'queued', 'command_enqueued', 1, 0, NULL
  ),
  (
    '71000000-0000-0000-0003-000000000011',
    'claimed', 'retry_wait', 'safe_rejection', 3, 1, 1
  );

CREATE TEMP TABLE _command_ledger_before_direct AS
SELECT
  (
    SELECT jsonb_agg(to_jsonb(command_row) ORDER BY command_row.id)
      FROM public.commerce_fulfillment_provider_commands AS command_row
  ) AS command_rows,
  (
    SELECT jsonb_agg(to_jsonb(transition_row) ORDER BY transition_row.id)
      FROM public.commerce_fulfillment_provider_command_transitions AS transition_row
  ) AS transition_rows;

CREATE TEMP TABLE _retired_command_mutation_rpcs (signature text PRIMARY KEY);
INSERT INTO _retired_command_mutation_rpcs (signature) VALUES
  ('public.commerce_fulfillment_enqueue_provider_command(uuid,text,text,text,text,text,text,text,text,text,text,integer)'),
  ('public.commerce_fulfillment_claim_provider_commands(text,text,integer,text,integer)'),
  ('public.commerce_fulfillment_mark_claimed_command_manual_review(uuid,uuid,bigint,bigint,text)'),
  ('public.commerce_fulfillment_mark_command_submitting(uuid,uuid,bigint,bigint,uuid)'),
  ('public.commerce_fulfillment_apply_command_write_outcome(uuid,uuid,bigint,bigint,text,text,text,timestamptz,text,uuid,text,text,timestamptz,text)'),
  ('public.commerce_fulfillment_confirm_provider_command(uuid,uuid,bigint,bigint,text,uuid,text,text,timestamptz,text)'),
  ('public.commerce_fulfillment_reconcile_provider_command(uuid,bigint,text,text,text,timestamptz,text)'),
  ('public.commerce_fulfillment_resolve_uncertain_command(uuid,bigint,text,text,text,text,text,timestamptz,text,timestamptz)'),
  ('public.commerce_fulfillment_release_or_cancel_command(uuid,uuid,bigint,bigint,text,text)'),
  ('public.commerce_fulfillment_recover_expired_provider_commands(integer)');

-- Stale and invalid-local-state fixtures are inserted by the migration owner;
-- service_role itself has no direct dispatch-ref write privilege.
INSERT INTO public.omnipack_dispatch_refs (
  id, fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status,
  request_idempotency_key, request_fingerprint, updated_at
) VALUES
  (
    '71000000-0000-0000-0002-000000000007',
    '71000000-0000-0000-0001-000000000007',
    '71000000-0000-0000-0000-000000000007',
    NULL, 'live', 'submitting', 'odc-dispatch-stale', 'fingerprint-stale',
    now() - interval '20 minutes'
  ),
  (
    '71000000-0000-0000-0002-000000000010',
    '71000000-0000-0000-0001-000000000010',
    '71000000-0000-0000-0000-000000000010',
    'provider-order-invalid-local', 'live', 'uncertain',
    'odc-dispatch-invalid-local', 'fingerprint-invalid-local', now()
  );

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anon cannot materialize executable dispatch refs'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot materialize executable dispatch refs'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.omnipack_record_dispatch_ref_v2(text,uuid,text,text,text,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'service role can use the fenced v2 recorder'
);
SELECT ok(
  NOT has_table_privilege('service_role', 'public.omnipack_dispatch_refs', 'INSERT'),
  'service role cannot insert dispatch refs directly'
);
SELECT ok(
  NOT has_table_privilege('service_role', 'public.omnipack_dispatch_refs', 'UPDATE'),
  'service role cannot update dispatch refs directly'
);
SELECT ok(
  NOT has_table_privilege('service_role', 'public.omnipack_dispatch_refs', 'DELETE'),
  'service role cannot delete durable dispatch ambiguity evidence'
);
SELECT ok(
  NOT has_table_privilege('service_role', 'public.omnipack_dispatch_refs', 'TRUNCATE'),
  'service role cannot truncate durable dispatch ambiguity evidence'
);
SELECT ok(
  has_table_privilege('service_role', 'public.omnipack_dispatch_refs', 'SELECT'),
  'service role retains dispatch readback access'
);
SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.omnipack_begin_dispatch_submission(uuid,text,text)', 'EXECUTE'
  ),
  'anon cannot acquire provider POST authority'
);
SELECT ok(
  has_function_privilege(
    'service_role', 'public.omnipack_begin_dispatch_submission(uuid,text,text)', 'EXECUTE'
  ),
  'service role retains the rolling-compatible legacy begin RPC'
);
SELECT ok(
  position(
    'commerce_fulfillment_provider_commands'
    IN pg_get_functiondef('public.omnipack_begin_dispatch_submission(uuid,text,text)'::regprocedure)
  ) = 0
  AND position(
    'omnipack_supersede_no_effect_provider_commands'
    IN pg_get_functiondef('public.omnipack_begin_dispatch_submission(uuid,text,text)'::regprocedure)
  ) = 0,
  'rolling-compatible begin delegates without reading or mutating command history'
);
SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.omnipack_begin_direct_dispatch_submission(uuid,text)', 'EXECUTE'
  ),
  'anon cannot acquire direct provider POST authority'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.omnipack_begin_direct_dispatch_submission(uuid,text)', 'EXECUTE'
  ),
  'authenticated cannot acquire direct provider POST authority'
);
SELECT ok(
  has_function_privilege(
    'service_role', 'public.omnipack_begin_direct_dispatch_submission(uuid,text)', 'EXECUTE'
  ),
  'service role can acquire direct provider POST authority'
);
SELECT ok(
  to_regprocedure('public.omnipack_begin_direct_dispatch_submission(uuid,text,text)') IS NULL,
  'direct begin RPC exposes no authority-mode overload'
);
SELECT is(
  (SELECT count(*)::integer
     FROM _retired_command_mutation_rpcs
    WHERE to_regprocedure(signature) IS NOT NULL),
  10,
  'all retired command mutation RPC definitions remain present'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM _retired_command_mutation_rpcs
     WHERE has_function_privilege('service_role', signature, 'EXECUTE')
  ),
  'service role cannot execute any retired command mutation RPC'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM _retired_command_mutation_rpcs
     WHERE has_function_privilege('anon', signature, 'EXECUTE')
  ),
  'anon cannot execute any retired command mutation RPC'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM _retired_command_mutation_rpcs
     WHERE has_function_privilege('authenticated', signature, 'EXECUTE')
  ),
  'authenticated cannot execute any retired command mutation RPC'
);
SELECT ok(
  has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'DELETE')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'TRUNCATE')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'REFERENCES')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_commands', 'TRIGGER'),
  'service role has SELECT-only access to retained command rows'
);
SELECT ok(
  has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'DELETE')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'TRUNCATE')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'REFERENCES')
  AND NOT has_table_privilege('service_role', 'public.commerce_fulfillment_provider_command_transitions', 'TRIGGER'),
  'service role has SELECT-only access to retained command transitions'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.omnipack_acknowledge_dispatch_acceptance(uuid,text,text,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'service role can commit provider acceptance and label ACK'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.omnipack_acknowledge_dispatch_acceptance(uuid,text,text,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anon cannot commit provider acceptance and label ACK'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.omnipack_acknowledge_dispatch_acceptance(uuid,text,text,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot commit provider acceptance and label ACK'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.omnipack_finalize_dispatch_submission(uuid,boolean,jsonb,jsonb)',
    'EXECUTE'
  ),
  'service role can classify an ambiguous provider call'
);
SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.commerce_emit_shipment_dispatched_outbox(uuid)', 'EXECUTE'
  ),
  'anon cannot forge a shipment-dispatched outbox event'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.commerce_emit_shipment_dispatched_outbox(uuid)', 'EXECUTE'
  ),
  'authenticated users cannot forge a shipment-dispatched outbox event'
);
SELECT ok(
  NOT has_function_privilege(
    'service_role', 'public.commerce_emit_shipment_dispatched_outbox(uuid)', 'EXECUTE'
  ),
  'runtime roles cannot bypass the shipment-status trigger'
);
SELECT throws_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref(
      'odc-legacy-live',
      '71000000-0000-0000-0001-000000000002',
      NULL, 'live', 'draft', 'fingerprint-legacy-live', '{}', '{}', '{}'
    )
  $$,
  '55000',
  'omnipack_dispatch_ref_submission_fence_required',
  'legacy executable recorder fails before provider I/O until wrapper cleanup after rollout'
);
SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref(
      'odc-shadow-only',
      '71000000-0000-0000-0001-000000000009',
      NULL, 'shadow', 'draft', 'fingerprint-shadow',
      '{"sanitized":true,"deliveryContactRevision":1}', '{}', '{}'
    )
  $$,
  'legacy recorder remains compatible for shadow evidence'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-shadow-only'),
  'draft',
  'shadow evidence remains a non-executable draft'
);
SELECT is(
  (public.omnipack_record_dispatch_ref(
    'odc-shadow-only',
    '71000000-0000-0000-0001-000000000009',
    NULL, 'shadow', 'draft', 'fingerprint-shadow',
    '{"sanitized":true,"deliveryContactRevision":1}', '{}', '{}'
  )->>'replayed')::boolean,
  true,
  'shadow recorder replay is idempotent'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-dispatch-normal',
      '71000000-0000-0000-0001-000000000002',
      NULL, 'live', 'draft', 'fingerprint-normal',
      '{"sanitized":true,"deliveryContactRevision":1}', '{}', '{}'
    )
  $$,
  'v2 materializes one executable draft'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-normal'),
  'draft',
  'materialization alone does not authorize a POST'
);
SELECT throws_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-normal'),
      'provider-order-before-fence',
      'odc-before-fence-provider',
      'odc-before-fence-label',
      '{}', '{"providerOrderId":"provider-order-before-fence"}', '{}'
    )
  $$,
  '22023',
  'omnipack_dispatch_ack_invalid_status',
  'an executable draft cannot bypass the pre-POST submission fence'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.commerce_fulfillment_provider_attempts
     WHERE idempotency_key IN ('odc-before-fence-provider', 'odc-before-fence-label')
  ),
  'rejected pre-fence ACK leaves no provider or label attempt'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-normal'),
  'draft',
  'rejected pre-fence ACK leaves the dispatch ref unchanged'
);
SELECT lives_ok(
  $$
    SELECT public.omnipack_begin_direct_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-normal'),
      'fingerprint-normal'
    )
  $$,
  'eligible draft crosses the locked pre-POST fence'
);
SELECT is(
  (public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-dispatch-normal'),
    'fingerprint-normal'
  )->>'begun')::boolean,
  false,
  'a second worker receives no provider POST authority'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-normal'),
  'submitting',
  'the winning authority is durable before provider I/O'
);
SELECT is(
  public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-dispatch-normal'),
    'fingerprint-normal'
  )->>'status',
  'submitting',
  'submitting replay never rewinds to draft'
);
SELECT is(
  (
    SELECT string_agg(key, ',' ORDER BY key)
      FROM jsonb_object_keys(public.omnipack_begin_direct_dispatch_submission(
        (SELECT id FROM public.omnipack_dispatch_refs
          WHERE request_idempotency_key = 'odc-dispatch-normal'),
        'fingerprint-normal'
      )) AS response_key(key)
  ),
  'begun,contractVersion,dispatchMode,dispatchRefId,fulfillmentOrderId,orderId,providerOrderId,replayed,requestIdempotencyKey,sanitizedRequest,status',
  'direct begin replay preserves the established response contract'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-normal'),
      'provider-order-normal',
      'odc-normal-provider-accepted',
      'odc-normal-label-ack',
      '{"sanitized":true}',
      '{"providerOrderId":"provider-order-normal"}',
      '{"source":"pgtap"}'
    )
  $$,
  'provider acceptance and local label ACK commit atomically'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-normal'),
  'created',
  'accepted ref retains the compatible created meaning'
);
SELECT is(
  (SELECT provider_order_id FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-normal'),
  'provider-order-normal',
  'provider order id is retained as correlation evidence'
);
SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders
    WHERE id = '71000000-0000-0000-0001-000000000002'),
  'label_created',
  'local fulfillment advances from created to label_created in the same transaction'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.commerce_fulfillment_provider_attempts
     WHERE idempotency_key = 'odc-normal-provider-accepted'
       AND status = 'succeeded'
  ),
  'atomic ACK contains provider acceptance proof'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.commerce_fulfillment_provider_attempts
     WHERE idempotency_key = 'odc-normal-label-ack'
       AND status = 'succeeded'
  ),
  'atomic ACK contains the existing label-created proof'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.commerce_fulfillment_operations
     WHERE idempotency_key = 'odc-normal-label-ack:operation'
       AND operation_type = 'label_created'
  ),
  'canonical label operation is present'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.shipment_external_refs
     WHERE provider_tracking_id = 'provider-order-normal'
  ),
  'provider order correlation is never projected as parcel tracking'
);
SELECT lives_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-normal'),
      'provider-order-normal',
      'odc-normal-provider-accepted',
      'odc-normal-label-ack',
      '{"sanitized":true}',
      '{"providerOrderId":"provider-order-normal"}',
      '{"source":"pgtap-replay"}'
    )
  $$,
  'acceptance replay is a no-op'
);
SELECT is(
  (public.omnipack_acknowledge_dispatch_acceptance(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-dispatch-normal'),
    'provider-order-normal',
    'odc-normal-provider-accepted',
    'odc-normal-label-ack',
    NULL, NULL, '{"source":"pgtap-replay"}'
  )->>'replayed')::boolean,
  true,
  'acceptance replay reports replayed'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_provider_attempts
    WHERE fulfillment_order_id = '71000000-0000-0000-0001-000000000002'
      AND idempotency_key IN ('odc-normal-provider-accepted', 'odc-normal-label-ack')),
  2,
  'acceptance replay does not duplicate provider attempts'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE fulfillment_order_id = '71000000-0000-0000-0001-000000000002'
      AND idempotency_key IN (
        'odc-normal-provider-accepted:operation',
        'odc-normal-label-ack:operation'
      )),
  2,
  'acceptance replay does not duplicate canonical operations'
);
SELECT throws_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-normal'),
      'different-provider-order',
      'odc-normal-conflict-provider',
      'odc-normal-conflict-label',
      '{}', '{}', '{}'
    )
  $$,
  '23505',
  'omnipack_dispatch_provider_order_conflict',
  'replay with a different provider identity fails closed'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.commerce_fulfillment_provider_attempts
     WHERE idempotency_key = 'odc-normal-conflict-provider'
  ),
  'identity conflict writes no partial provider proof'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000001'
  ),
  'provider-created/local-created incident is selected for zero-POST repair'
);
SELECT lives_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      '71000000-0000-0000-0002-000000000001',
      'provider-order-incident',
      'odc-incident-provider-accepted',
      'odc-incident-label-ack',
      NULL,
      '{"providerOrderId":"provider-order-incident"}',
      '{"source":"incident-repair"}'
    )
  $$,
  'historical incident converges through the same atomic ACK'
);
SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders
    WHERE id = '71000000-0000-0000-0001-000000000001'),
  'label_created',
  'incident repair advances local fulfillment without provider POST authority'
);
SELECT is(
  (SELECT provider_order_id FROM public.omnipack_dispatch_refs
    WHERE id = '71000000-0000-0000-0002-000000000001'),
  'provider-order-incident',
  'incident repair preserves the accepted provider correlation'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_provider_attempts
    WHERE fulfillment_order_id = '71000000-0000-0000-0001-000000000001'
      AND idempotency_key IN (
        'odc-incident-provider-accepted', 'odc-incident-label-ack'
      )),
  2,
  'incident repair creates exactly the two canonical proofs'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000001'
  ),
  'repaired fulfillment leaves the dispatch candidate set'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-dispatch-uncertain',
      '71000000-0000-0000-0001-000000000003',
      NULL, 'live', 'draft', 'fingerprint-uncertain', '{"deliveryContactRevision":1}', '{}', '{}'
    );
    SELECT public.omnipack_begin_direct_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-uncertain'),
      'fingerprint-uncertain'
    )
  $$,
  'uncertain fixture first crosses the pre-POST fence'
);
SELECT lives_ok(
  $$
    SELECT public.omnipack_finalize_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-uncertain'),
      true, '{}', '{"code":"network_timeout"}'
    )
  $$,
  'ambiguous provider outcome is durably classified uncertain'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-uncertain'),
  'uncertain',
  'ambiguous outcome remains a no-retry state'
);
SELECT is(
  (public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-dispatch-uncertain'),
    'fingerprint-uncertain'
  )->>'begun')::boolean,
  false,
  'uncertain ref can never reacquire blind POST authority'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000003'
  ),
  'uncertain ref without provider proof is excluded from automatic work'
);
SELECT throws_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-uncertain'),
      NULL, 'odc-uncertain-provider', 'odc-uncertain-label', '{}', '{}', '{}'
    )
  $$,
  '22023',
  'omnipack_dispatch_ack_provider_order_required',
  'uncertain work needs authoritative provider identity before ACK'
);

SELECT is(
  (public.omnipack_mark_stale_dispatch_submissions_uncertain(now() - interval '5 minutes')
    ->>'markedUncertain')::integer,
  1,
  'stale submitting sweep marks exactly the old ambiguity window'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE id = '71000000-0000-0000-0002-000000000007'),
  'uncertain',
  'stale submitting ref becomes uncertain, never draft'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-dispatch-safe-failure',
      '71000000-0000-0000-0001-000000000006',
      NULL, 'live', 'draft', 'fingerprint-safe-failure', '{"deliveryContactRevision":1}', '{}', '{}'
    );
    SELECT public.omnipack_begin_direct_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-safe-failure'),
      'fingerprint-safe-failure'
    );
    SELECT public.omnipack_finalize_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-safe-failure'),
      false, '{}', '{"code":"definitive_rejection"}'
    )
  $$,
  'definitive pre-effect rejection finalizes safely'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-safe-failure'),
  'failed',
  'definitive rejection is terminal failed'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000006'
  ),
  'failed ref is not blindly retried'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-dispatch-command-queued',
      '71000000-0000-0000-0001-000000000004',
      NULL, 'live', 'draft', 'fingerprint-command-queued', '{"deliveryContactRevision":1}', '{}', '{}'
    );
    SELECT public.omnipack_begin_direct_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-command-queued'),
      'fingerprint-command-queued'
    )
  $$,
  'queued command history does not block the direct fence'
);
SELECT is(
  (SELECT status FROM public.commerce_fulfillment_provider_commands
    WHERE id = '71000000-0000-0000-0003-000000000004'),
  'queued',
  'direct begin leaves the queued command state unchanged'
);
SELECT is(
  (SELECT last_reason_code FROM public.commerce_fulfillment_provider_commands
    WHERE id = '71000000-0000-0000-0003-000000000004'),
  'command_enqueued',
  'direct begin leaves the queued command reason unchanged'
);
SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_fulfillment_provider_command_transitions
    WHERE command_id = '71000000-0000-0000-0003-000000000004'),
  1,
  'direct begin appends no queued-command transition'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-command-queued'),
  'submitting',
  'queued command history does not prevent durable direct authority'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-dispatch-command-claimed',
      '71000000-0000-0000-0001-000000000005',
      NULL, 'live', 'draft', 'fingerprint-command-claimed', '{"deliveryContactRevision":1}', '{}', '{}'
    )
  $$,
  'claimed-command fixture has a direct draft for arbitration'
);
SELECT is(
  (public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-dispatch-command-claimed'),
    'fingerprint-command-claimed'
  )->>'begun')::boolean,
  true,
  'claimed command history does not block direct authority'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-command-claimed'),
  'submitting',
  'claimed command history leaves the direct fence authoritative'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-dispatch-command-retry',
      '71000000-0000-0000-0001-000000000011',
      NULL, 'live', 'draft', 'fingerprint-command-retry', '{"deliveryContactRevision":1}', '{}', '{}'
    )
  $$,
  'retry-wait command fixture has a direct draft for arbitration'
);
SELECT is(
  (public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-dispatch-command-retry'),
    'fingerprint-command-retry'
  )->>'begun')::boolean,
  true,
  'retry-wait command history does not block direct authority'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-command-retry'),
  'submitting',
  'retry-wait command history leaves the direct fence authoritative'
);

SELECT is(
  (
    SELECT jsonb_agg(to_jsonb(command_row) ORDER BY command_row.id)::text
      FROM public.commerce_fulfillment_provider_commands AS command_row
  ),
  (SELECT command_rows::text FROM _command_ledger_before_direct),
  'queued, claimed, and retry command rows remain byte-for-byte unchanged after direct begin'
);
SELECT is(
  (
    SELECT jsonb_agg(to_jsonb(transition_row) ORDER BY transition_row.id)::text
      FROM public.commerce_fulfillment_provider_command_transitions AS transition_row
  ),
  (SELECT transition_rows::text FROM _command_ledger_before_direct),
  'queued, claimed, and retry transition histories remain byte-for-byte unchanged after direct begin'
);

CREATE TEMP TABLE _command_ledger_before_ack AS
SELECT
  (
    SELECT jsonb_agg(to_jsonb(command_row) ORDER BY command_row.id)
      FROM public.commerce_fulfillment_provider_commands AS command_row
  ) AS command_rows,
  (
    SELECT jsonb_agg(to_jsonb(transition_row) ORDER BY transition_row.id)
      FROM public.commerce_fulfillment_provider_command_transitions AS transition_row
  ) AS transition_rows;

SELECT lives_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-command-queued'),
      'provider-order-command-queued',
      'odc-command-queued-provider',
      'odc-command-queued-label',
      '{}',
      '{"providerOrderId":"provider-order-command-queued"}',
      '{"source":"pgtap-command-ledger-read-only"}'
    )
  $$,
  'direct ACK succeeds without command-ledger supersession'
);
SELECT is(
  (
    SELECT string_agg(key, ',' ORDER BY key)
      FROM jsonb_object_keys(public.omnipack_acknowledge_dispatch_acceptance(
        (SELECT id FROM public.omnipack_dispatch_refs
          WHERE request_idempotency_key = 'odc-dispatch-command-queued'),
        'provider-order-command-queued',
        'odc-command-queued-provider',
        'odc-command-queued-label',
        '{}',
        '{"providerOrderId":"provider-order-command-queued"}',
        '{"source":"pgtap-command-ledger-read-only"}'
      )) AS response_key(key)
  ),
  'contractVersion,dispatchRefId,dispatchStatus,fulfillmentOrderId,fulfillmentStatus,orderId,providerOrderId,replayed',
  'ACK preserves compatible response keys without providerCommandSupersession'
);
SELECT is(
  (
    SELECT jsonb_agg(to_jsonb(command_row) ORDER BY command_row.id)::text
      FROM public.commerce_fulfillment_provider_commands AS command_row
  ),
  (SELECT command_rows::text FROM _command_ledger_before_ack),
  'ACK leaves all command rows byte-for-byte unchanged'
);
SELECT is(
  (
    SELECT jsonb_agg(to_jsonb(transition_row) ORDER BY transition_row.id)::text
      FROM public.commerce_fulfillment_provider_command_transitions AS transition_row
  ),
  (SELECT transition_rows::text FROM _command_ledger_before_ack),
  'ACK leaves all command transition histories byte-for-byte unchanged'
);

SELECT is(
  public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-shadow-only'),
    'fingerprint-shadow'
  )->>'ineligibleReason',
  'shadow_dispatch',
  'shadow evidence never becomes directly executable'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-shadow-only'),
  'draft',
  'shadow rejection does not mutate the direct ref'
);

SELECT lives_ok(
  $$
    SELECT public.omnipack_record_status_evidence(
      'odc-delivered-first-status',
      '71000000-0000-0000-0001-000000000002',
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-normal'),
      'delivered', 'delivered', 'delivered', 'webhook',
      NULL, NULL, '{"status":"delivered"}'
    );
    SELECT public.commerce_fulfillment_mark_provider_stock_consumed(
      'odc-delivered-first-stock',
      '71000000-0000-0000-0001-000000000002',
      NULL, '{"source":"pgtap"}'
    );
    SELECT public.commerce_fulfillment_mark_handed_over(
      'odc-delivered-first-handoff',
      '71000000-0000-0000-0001-000000000002',
      NULL, '{"source":"pgtap"}'
    )
  $$,
  'delivered-first evidence is durable before handoff and tracking effects'
);
SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders
    WHERE id = '71000000-0000-0000-0001-000000000002'),
  'handed_over',
  'real delivered-first sequence temporarily crosses handed_over'
);
SELECT lives_ok(
  $$
    INSERT INTO public.shipment_external_refs (
      order_id, provider_kind, provider_tracking_id, active
    ) VALUES (
      '71000000-0000-0000-0000-000000000002',
      'omnipack', 'ODC-DELIVERED-FIRST-TRACKING', true
    )
  $$,
  'carrier tracking can arrive after delivered provider evidence'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE aggregate_id = '71000000-0000-0000-0000-000000000002'
       AND event_type = 'commerce.shipment.dispatched'
  ),
  'tracking-ref trigger suppresses late dispatched when delivered evidence is canonical'
);
SELECT lives_ok(
  $$
    SELECT public.commerce_fulfillment_record_tracking_event(
      'odc-delivered-first-tracking',
      '71000000-0000-0000-0001-000000000002',
      'delivered', 'ODC-DELIVERED-FIRST-TRACKING',
      '{"status":"delivered"}', NULL, '{"source":"pgtap"}'
    )
  $$,
  'tracking projection advances the fulfillment to delivered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE aggregate_id = '71000000-0000-0000-0000-000000000002'
       AND event_type = 'commerce.shipment.delivered'
  ),
  'delivered-first preserves delivered customer communication'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE aggregate_id = '71000000-0000-0000-0000-000000000002'
       AND event_type = 'commerce.shipment.dispatched'
  ),
  'delivered-first never emits a late future-tense dispatched message'
);

SELECT throws_like(
  $$
    INSERT INTO public.omnipack_dispatch_refs (
      fulfillment_order_id, order_id, dispatch_mode, status,
      request_idempotency_key, request_fingerprint
    ) VALUES (
      '71000000-0000-0000-0001-000000000008',
      '71000000-0000-0000-0000-000000000008',
      'live', 'retrying', 'odc-invalid-status', 'fingerprint-invalid'
    )
  $$,
  '%violates check constraint "omnipack_dispatch_refs_status_check"%',
  'dispatch status vocabulary rejects retry-authorizing states'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000009'
  ),
  'unsubmitted selected shadow draft remains eligible for fenced promotion'
);

-- Payment proof gates the parcel, not the order's claim about itself.
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000012'
  ),
  'order claiming fulfillment_pending without any payment never reaches the provider'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000013'
  ),
  'a started but unsucceeded charge is not payment proof'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000014'
  ),
  'payment proof does not gate repair of a parcel the provider already holds'
);
UPDATE public.omnipack_dispatch_refs
   SET provider_order_id = 'shadow-observation-only'
 WHERE request_idempotency_key = 'odc-shadow-only';
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000009'
  ),
  'historical shadow correlation is not mistaken for accepted live repair proof'
);
SELECT ok(
  (SELECT provider_order_id IS NULL FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-dispatch-safe-failure'),
  'safe failed result cannot retain provider identity'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.omnipack_dispatch_candidate_ids(25) AS candidate
     WHERE candidate.fulfillment_order_id = '71000000-0000-0000-0001-000000000007'
  ),
  'stale uncertain ref is excluded from automatic dispatch'
);
SELECT throws_ok(
  $$
    SELECT public.omnipack_begin_direct_dispatch_submission(
      (SELECT id FROM public.omnipack_dispatch_refs
        WHERE request_idempotency_key = 'odc-dispatch-command-claimed'),
      'wrong-fingerprint'
    )
  $$,
  '23505',
  'omnipack_dispatch_request_fingerprint_conflict',
  'request identity cannot change at the pre-POST fence'
);

SELECT throws_ok(
  $$
    SELECT public.omnipack_acknowledge_dispatch_acceptance(
      '71000000-0000-0000-0002-000000000010',
      'provider-order-invalid-local',
      'odc-invalid-local-provider',
      'odc-invalid-local-label',
      '{}', '{"providerOrderId":"provider-order-invalid-local"}', '{}'
    )
  $$,
  '22023',
  'omnipack_dispatch_label_ack_invalid_fulfillment_status',
  'invalid local FSM state rolls back the composed acceptance transaction'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.commerce_fulfillment_provider_attempts
     WHERE idempotency_key = 'odc-invalid-local-provider'
  ),
  'failed label ACK leaves no partial provider attempt'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE id = '71000000-0000-0000-0002-000000000010'),
  'uncertain',
  'failed composed ACK leaves the dispatch ambiguity evidence unchanged'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode,
  subtotal_cents, total_cents, metadata
) VALUES
  (
    '71000000-0000-0000-0000-000000000015',
    '71000000-0000-0000-0000-0000000000a1',
    'ODC-15', 'fulfillment_pending', 'one_time', 1000, 1000,
    '{"selectedDelivery":{"providerKind":"omnipack","carrierCode":"INPOST_COURIER_STANDARD"}}'
  ),
  (
    '71000000-0000-0000-0000-000000000016',
    '71000000-0000-0000-0000-0000000000a1',
    'ODC-16', 'fulfillment_pending', 'one_time', 1000, 1000,
    '{"runtimeFinalize":{"deliveryContact":{"schemaVersion":1,"source":"checkout_submission","revision":1,"recipientName":"New Format","contactEmail":"new-format@example.test","contactPhone":"+48111000016","line1":"New 16","line2":null,"city":"Warszawa","postalCode":"00-016","country":"PL","selectedDelivery":{"providerKind":"omnipack"},"deliveryInstructions":null,"courierInstructions":null}}}'
  );
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot
) VALUES
  (
    '71000000-0000-0000-0001-000000000015',
    '71000000-0000-0000-0000-000000000015',
    '71000000-0000-0000-0000-0000000000a1',
    '71000000-0000-0000-0000-0000000000a2',
    'odc-fulfillment-15', 'created', 'omnipack',
    '{"recipientName":"Legacy Fifteen","line1":"ul. Atomowa 15","city":"Warszawa","postalCode":"00-015","country":"PL"}'
  ),
  (
    '71000000-0000-0000-0001-000000000016',
    '71000000-0000-0000-0000-000000000016',
    '71000000-0000-0000-0000-0000000000a1',
    '71000000-0000-0000-0000-0000000000a2',
    'odc-fulfillment-16', 'created', 'omnipack',
    '{"recipientName":"Wrong Legacy","line1":"Wrong 16","city":"Warszawa","postalCode":"00-016"}'
  );

UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = jsonb_set(
         shipping_address_snapshot, '{deliveryContact}', '"malformed"'::jsonb, true)
 WHERE id = '71000000-0000-0000-0001-000000000015';

SELECT throws_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-legacy-present-string',
      '71000000-0000-0000-0001-000000000015',
      NULL, 'shadow', 'draft', 'fingerprint-legacy-string-15',
      '{"deliveryContactRevision":1}', '{}', '{}')$$,
  '22023',
  'omnipack_dispatch_delivery_contact_missing',
  'a present string deliveryContact fails closed instead of legacy materialization');

UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = jsonb_set(
         shipping_address_snapshot, '{deliveryContact}', '[]'::jsonb, true)
 WHERE id = '71000000-0000-0000-0001-000000000015';

SELECT throws_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-legacy-present-array',
      '71000000-0000-0000-0001-000000000015',
      NULL, 'shadow', 'draft', 'fingerprint-legacy-array-15',
      '{"deliveryContactRevision":1}', '{}', '{}')$$,
  '22023',
  'omnipack_dispatch_delivery_contact_missing',
  'a present array deliveryContact fails closed instead of legacy materialization');

UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = shipping_address_snapshot - 'deliveryContact'
 WHERE id = '71000000-0000-0000-0001-000000000015';

SELECT is(
  public.omnipack_record_dispatch_ref_v2(
    'odc-legacy-materialize',
    '71000000-0000-0000-0001-000000000015',
    NULL, 'shadow', 'draft', 'fingerprint-legacy-15',
    '{"deliveryContactRevision":1}', '{}', '{}'
  )->>'retryableReason',
  'omnipack_dispatch_contact_stale',
  'the first locked legacy pass materializes contact and requests one remap'
);
SELECT is(
  (SELECT shipping_address_snapshot #>> '{deliveryContact,source}'
     FROM public.commerce_fulfillment_orders
    WHERE id = '71000000-0000-0000-0001-000000000015'),
  'legacy_inferred',
  'eligible historical contact is frozen and explicitly labelled'
);
SELECT ok(
  (public.omnipack_record_dispatch_ref_v2(
    'odc-legacy-materialize',
    '71000000-0000-0000-0001-000000000015',
    NULL, 'shadow', 'draft', 'fingerprint-legacy-15',
    '{"deliveryContactRevision":1}', '{}', '{}'
  )->>'dispatchRefId') IS NOT NULL,
  'the bounded legacy remap converges to one draft'
);
SELECT is(
  (SELECT count(*)::integer FROM public.omnipack_dispatch_refs
    WHERE fulfillment_order_id = '71000000-0000-0000-0001-000000000015'),
  1,
  'legacy convergence creates exactly one provider ref'
);
SELECT throws_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-new-format-missing',
      '71000000-0000-0000-0001-000000000016',
      NULL, 'shadow', 'draft', 'fingerprint-new-16',
      '{"deliveryContactRevision":1}', '{}', '{}')$$,
  '22023',
  'omnipack_dispatch_delivery_contact_missing',
  'new-format parcel corruption never falls back to mutable legacy rows'
);
SELECT ok(
  (SELECT shipping_address_snapshot->'deliveryContact' IS NULL
     FROM public.commerce_fulfillment_orders
    WHERE id = '71000000-0000-0000-0001-000000000016'),
  'new-format refusal leaves the malformed parcel unchanged'
);

SELECT lives_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-contact-cutoff',
      '71000000-0000-0000-0001-000000000008',
      NULL, 'shadow', 'draft', 'fingerprint-contact-v1',
      '{"deliveryContactRevision":1,"sanitized":true}', '{}', '{}')$$,
  'a matching contact revision records the first no-effect draft'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-contact-cutoff'),
  'draft',
  'the contact-cutoff fixture remains correctable before submission'
);
UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = jsonb_set(
         shipping_address_snapshot, '{deliveryContact,revision}', '2'::jsonb, false
       )
 WHERE id = '71000000-0000-0000-0001-000000000008';
SELECT is(
  public.omnipack_record_dispatch_ref_v2(
    'odc-contact-cutoff',
    '71000000-0000-0000-0001-000000000008',
    NULL, 'live', 'draft', 'fingerprint-contact-v1',
    '{"deliveryContactRevision":1,"sanitized":true}', '{}', '{}'
  )->>'retryableReason',
  'omnipack_dispatch_contact_stale',
  'recording refuses a candidate mapped before the parcel revision changed'
);
SELECT is(
  (SELECT request_fingerprint FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-contact-cutoff'),
  'fingerprint-contact-v1',
  'the stale recorder does not rewrite the draft'
);
SELECT is(
  (public.omnipack_record_dispatch_ref_v2(
    'odc-contact-cutoff',
    '71000000-0000-0000-0001-000000000008',
    NULL, 'shadow', 'draft', 'fingerprint-contact-v1',
    '{"deliveryContactRevision":2,"sanitized":true}', '{}', '{}'
  )->>'replayed')::boolean,
  false,
  'same-mode same-fingerprint replay still refreshes changed revision evidence'
);
SELECT is(
  (SELECT sanitized_request->>'deliveryContactRevision' FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-contact-cutoff'),
  '2',
  'same-fingerprint refresh converges the draft before begin'
);
SELECT is(
  (public.omnipack_record_dispatch_ref_v2(
    'odc-contact-cutoff',
    '71000000-0000-0000-0001-000000000008',
    NULL, 'live', 'draft', 'fingerprint-contact-v2',
    '{"deliveryContactRevision":2,"sanitized":true}', '{}', '{}'
  )->>'replayed')::boolean,
  false,
  'a fresh mapping atomically supersedes the no-effect draft in executable mode'
);
SELECT is(
  (SELECT request_fingerprint FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-contact-cutoff'),
  'fingerprint-contact-v2',
  'the correctable draft stores the refreshed request fingerprint'
);
SELECT is(
  (SELECT sanitized_request->>'deliveryContactRevision' FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-contact-cutoff'),
  '2',
  'fingerprint and redacted revision evidence refresh together'
);
UPDATE public.commerce_fulfillment_orders
   SET shipping_address_snapshot = jsonb_set(
         shipping_address_snapshot, '{deliveryContact,revision}', '3'::jsonb, false
       )
 WHERE id = '71000000-0000-0000-0001-000000000008';
SELECT is(
  public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-contact-cutoff'),
    'fingerprint-contact-v2'
  )->>'retryableReason',
  'omnipack_dispatch_contact_stale',
  'the final begin fence catches a correction committed after ref recording'
);
SELECT is(
  (SELECT status FROM public.omnipack_dispatch_refs
    WHERE request_idempotency_key = 'odc-contact-cutoff'),
  'draft',
  'a stale begin refusal leaves the provider key correctable and unsubmitted'
);
SELECT lives_ok(
  $$SELECT public.omnipack_record_dispatch_ref_v2(
      'odc-contact-cutoff',
      '71000000-0000-0000-0001-000000000008',
      NULL, 'live', 'draft', 'fingerprint-contact-v3',
      '{"deliveryContactRevision":3,"sanitized":true}', '{}', '{}')$$,
  'the worker can perform its one bounded remap after a stale begin refusal'
);
SELECT is(
  (public.omnipack_begin_direct_dispatch_submission(
    (SELECT id FROM public.omnipack_dispatch_refs
      WHERE request_idempotency_key = 'odc-contact-cutoff'),
    'fingerprint-contact-v3'
  )->>'begun')::boolean,
  true,
  'the refreshed mapping alone crosses the final provider-effect cutoff'
);

SELECT * FROM finish();
ROLLBACK;
