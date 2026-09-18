-- pgTAP: automatic release of OmniPack provider-exception holds.
--   * a hold clears on delivery, and on the provider leaving the exception state;
--   * the chronology gate keeps returned-after-delivery holds standing;
--   * split-shipment, risk, and human holds are never auto-released, including
--     when a human forges the provider source in metadata;
--   * releasing emits no customer-facing shipment-exception email;
--   * re-suspension after a release opens a fresh hold, and the original
--     occurrence key still replays instead of duplicating one.
--
-- Case 11 additionally pins the W2-V3 precondition: the evidence RPC has no
-- fulfillment-status allowlist, so reconciliation may write status evidence for
-- a fulfilment whose durable status is already off-track. That is what lets the
-- AFTER INSERT healer below fire from the pull path at all. The acceptance ack
-- RPC keeps its own allowlist and is a separate statement; nothing here relaxes it.
--
-- Run via: the local pgTAP lane, with a schema reset first (stale state lies).

BEGIN;
SELECT plan(40);

INSERT INTO public.admin_users (id, email, role)
VALUES ('66000000-0000-0000-0000-0000000000c1', 'heal-admin@example.invalid', 'admin');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000f1', 'heal@example.invalid', 'Heal', 'Case');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('66000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000f1', 'HEAL-1',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000f1', 'HEAL-2',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-0000000000f1', 'HEAL-3',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-0000000000f1', 'HEAL-4',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a5', '10000000-0000-0000-0000-0000000000f1', 'HEAL-5',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a6', '10000000-0000-0000-0000-0000000000f1', 'HEAL-6',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a7', '10000000-0000-0000-0000-0000000000f1', 'HEAL-7',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a8', '10000000-0000-0000-0000-0000000000f1', 'HEAL-8',  'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000a9', '10000000-0000-0000-0000-0000000000f1', 'HEAL-9',  'cancelled',           'one_time', 'PLN', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000aa', '10000000-0000-0000-0000-0000000000f1', 'HEAL-10', 'fulfillment_pending', 'one_time', 'PLN', 10000, 10000),
  -- Case 11 fixtures use the ISO 4217 test currency: new money literals in
  -- fixtures must not spend the currency-neutrality ratchet.
  ('66000000-0000-0000-0000-0000000000ab', '10000000-0000-0000-0000-0000000000f1', 'HEAL-11', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('66000000-0000-0000-0000-0000000000ac', '10000000-0000-0000-0000-0000000000f1', 'HEAL-12', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000);

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('66000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000f1',
        'shipping', 'ul. Uzdrowiona 1', 'Warszawa', '00-001', 'PL');

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot
)
VALUES
  ('66000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-1',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f2', '66000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-2',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f3', '66000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-3',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f4', '66000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-4',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f5', '66000000-0000-0000-0000-0000000000a5', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-5',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f6', '66000000-0000-0000-0000-0000000000a6', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-6',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f7', '66000000-0000-0000-0000-0000000000a7', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-7',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f8', '66000000-0000-0000-0000-0000000000a8', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-8',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000f9', '66000000-0000-0000-0000-0000000000a9', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-9',  'created', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000fa', '66000000-0000-0000-0000-0000000000aa', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-10', 'created', '{}'::jsonb),
  -- The two off-track durable statuses the acceptance ack RPC rejects.
  ('66000000-0000-0000-0000-0000000000fb', '66000000-0000-0000-0000-0000000000ab', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-11', 'exception', '{}'::jsonb),
  ('66000000-0000-0000-0000-0000000000fc', '66000000-0000-0000-0000-0000000000ac', '10000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000d1', 'heal-fo-12', 'cancelled', '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- Case 1: suspended -> delivered. The live OPENLUP-D7898B8C shape, except that the
-- provider casing is preserved exactly as the reconciliation worker writes it.
-- ---------------------------------------------------------------------------
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, provider_sub_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000a1',
        'SUSPENDED', 'CARRIER_MAPPING_ERROR', 'exception', 'reconciliation',
        '2026-07-15T20:43:55Z', 'heal-evidence-1-exception');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-1',
    '66000000-0000-0000-0000-0000000000a1',
    'SUSPENDED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f1"}'::jsonb
  ) $$,
  'provider exception opens the hold before any proof exists'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1' AND status = 'active'),
  1, 'suspended order carries exactly one active hold');

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, provider_sub_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000a1',
        'DELIVERED', 'COMPLETE', 'delivered', 'reconciliation',
        '2026-07-17T16:25:39Z', 'heal-evidence-1-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'),
  'released', 'delivery releases the provider-exception hold');

SELECT ok(
  (SELECT released_at IS NOT NULL AND released_by IS NULL
     FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'),
  'auto-release stamps released_at and leaves released_by NULL (system actor)');

SELECT is(
  (SELECT metadata->>'autoReleaseProof' FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'),
  'delivered', 'hold records which grade of proof released it');

SELECT is(
  (SELECT metadata#>>'{autoReleaseEvidence,clearedProviderStatus}' FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'),
  'suspended', 'cleared provider status is canonicalised from the raw SUSPENDED');

SELECT is(
  (SELECT metadata#>>'{autoReleaseEvidence,clearedProviderSubStatus}' FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'),
  'CARRIER_MAPPING_ERROR', 'the actual cause survives into the released hold');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'
      AND operation_type = 'hold_released'
      AND source = 'commerce.fulfillment.omnipack_provider_exception_healed'
      AND actor_user_id IS NULL),
  1, 'auto-release writes exactly one system-actor hold_released operation');

-- The customer-safety proof: a release must never generate a follow-up email.
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.shipment.exception'
      AND aggregate_id = '66000000-0000-0000-0000-0000000000a1'),
  1, 'releasing emits no additional customer shipment-exception event');

-- Repeated proof (the webhook/reconciliation race) must be a no-op.
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, provider_sub_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000a1',
        'delivered', 'order.delivered', 'delivered', 'webhook',
        '2026-07-17T16:26:00Z', 'heal-evidence-1-delivered-webhook');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1'
      AND operation_type = 'hold_released'),
  1, 'a second delivery proof does not write a second release operation');

-- The original occurrence key must still replay rather than re-opening a hold.
SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-1',
    '66000000-0000-0000-0000-0000000000a1',
    'SUSPENDED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f1"}'::jsonb
  ) $$,
  'exact-replay of the original occurrence survives the auto-release'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1' AND status = 'active'),
  0, 'replaying the healed occurrence does not resurrect an active hold');

-- A genuinely new suspension must be able to open a fresh hold.
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f1', '66000000-0000-0000-0000-0000000000a1',
        'SUSPENDED', 'exception', 'reconciliation',
        '2026-07-18T09:00:00Z', 'heal-evidence-1-resuspended');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-1-again',
    '66000000-0000-0000-0000-0000000000a1',
    'SUSPENDED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f1"}'::jsonb
  ) $$,
  're-suspension after an auto-release opens a new hold'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a1' AND status = 'active'),
  1, 'the partial unique index permits a fresh active hold after release');

-- ---------------------------------------------------------------------------
-- Case 2: suspended -> new/READY_FOR_EXPORT. This is the transition that would
-- have healed the live case ~17h before delivery.
-- ---------------------------------------------------------------------------
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f2', '66000000-0000-0000-0000-0000000000a2',
        'SUSPENDED', 'exception', 'reconciliation',
        '2026-07-15T20:43:55Z', 'heal-evidence-2-exception');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-2', '66000000-0000-0000-0000-0000000000a2', 'SUSPENDED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f2"}'::jsonb) $$,
  'second fixture opens its hold'
);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, provider_sub_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f2', '66000000-0000-0000-0000-0000000000a2',
        'NEW', 'READY_FOR_EXPORT', 'provider_received', 'reconciliation',
        '2026-07-16T13:58:58Z', 'heal-evidence-2-recovered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a2'),
  'released', 'provider leaving the exception state releases the hold');

SELECT is(
  (SELECT metadata->>'autoReleaseProof' FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a2'),
  'provider_recovered', 'recovery is recorded as the weaker proof grade');

-- ---------------------------------------------------------------------------
-- Case 3: proof older than the exception must not heal it.
-- ---------------------------------------------------------------------------
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f3', '66000000-0000-0000-0000-0000000000a3',
        'SUSPENDED', 'exception', 'reconciliation',
        '2026-07-16T12:00:00Z', 'heal-evidence-3-exception');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-3', '66000000-0000-0000-0000-0000000000a3', 'SUSPENDED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f3"}'::jsonb) $$,
  'third fixture opens its hold'
);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f3', '66000000-0000-0000-0000-0000000000a3',
        'SHIPPING', 'in_transit', 'reconciliation',
        '2026-07-16T08:00:00Z', 'heal-evidence-3-stale-proof');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a3'),
  'active', 'evidence older than the exception does not release the hold');

-- ---------------------------------------------------------------------------
-- Case 4: an exception with no timestamp cannot be proven cleared.
-- ---------------------------------------------------------------------------
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f4', '66000000-0000-0000-0000-0000000000a4',
        'SUSPENDED', 'exception', 'webhook',
        NULL, 'heal-evidence-4-exception-untimed');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-4', '66000000-0000-0000-0000-0000000000a4', 'SUSPENDED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f4"}'::jsonb) $$,
  'fourth fixture opens its hold'
);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f4', '66000000-0000-0000-0000-0000000000a4',
        'DELIVERED', 'delivered', 'reconciliation',
        '2026-07-17T10:00:00Z', 'heal-evidence-4-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a4'),
  'active', 'an exception with a NULL occurred_at is never auto-healed');

-- ---------------------------------------------------------------------------
-- Case 5: returned_to_sender after delivery. The hold must stand — this is the
-- provider_exception_after_delivery shape the OMS already surfaces.
-- ---------------------------------------------------------------------------
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES
  ('66000000-0000-0000-0000-0000000000f5', '66000000-0000-0000-0000-0000000000a5',
   'DELIVERED', 'delivered', 'reconciliation', '2026-07-17T10:00:00Z', 'heal-evidence-5-delivered'),
  ('66000000-0000-0000-0000-0000000000f5', '66000000-0000-0000-0000-0000000000a5',
   'RETURNED_TO_SENDER', 'exception', 'reconciliation', '2026-07-18T10:00:00Z', 'heal-evidence-5-returned');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-5', '66000000-0000-0000-0000-0000000000a5', 'RETURNED_TO_SENDER',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000f5"}'::jsonb) $$,
  'a return after delivery opens a hold'
);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000f5', '66000000-0000-0000-0000-0000000000a5',
        'DELIVERED', 'delivered', 'webhook', '2026-07-18T12:00:00Z', 'heal-evidence-5-late-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000a5'),
  'active', 'returned_to_sender is never cleared by a later delivery signal');

-- ---------------------------------------------------------------------------
-- Case 6: split-shipment preflight hold. Same reason, same NULL created_by —
-- only metadata.source separates it, and it must survive.
-- ---------------------------------------------------------------------------
INSERT INTO public.commerce_order_holds (id, order_id, created_by, status, reason, idempotency_key, metadata)
VALUES ('66000000-0000-0000-0000-0000000000b6', '66000000-0000-0000-0000-0000000000a6', NULL,
        'active', 'fulfillment_exception', 'heal-split-hold',
        '{"source":"commerce.fulfillment.split_shipment_preflight"}'::jsonb);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES
  ('66000000-0000-0000-0000-0000000000f6', '66000000-0000-0000-0000-0000000000a6',
   'SUSPENDED', 'exception', 'reconciliation', '2026-07-16T09:00:00Z', 'heal-evidence-6-exception'),
  ('66000000-0000-0000-0000-0000000000f6', '66000000-0000-0000-0000-0000000000a6',
   'DELIVERED', 'delivered', 'reconciliation', '2026-07-17T09:00:00Z', 'heal-evidence-6-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE id = '66000000-0000-0000-0000-0000000000b6'),
  'active', 'a split-shipment preflight hold is never auto-released');

-- ---------------------------------------------------------------------------
-- Case 7: risk hold.
-- ---------------------------------------------------------------------------
INSERT INTO public.commerce_order_holds (id, order_id, created_by, status, reason, idempotency_key, metadata)
VALUES ('66000000-0000-0000-0000-0000000000b7', '66000000-0000-0000-0000-0000000000a7', NULL,
        'active', 'risk_review', 'heal-risk-hold', '{"source":"risk.v1"}'::jsonb);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES
  ('66000000-0000-0000-0000-0000000000f7', '66000000-0000-0000-0000-0000000000a7',
   'SUSPENDED', 'exception', 'reconciliation', '2026-07-16T09:00:00Z', 'heal-evidence-7-exception'),
  ('66000000-0000-0000-0000-0000000000f7', '66000000-0000-0000-0000-0000000000a7',
   'DELIVERED', 'delivered', 'reconciliation', '2026-07-17T09:00:00Z', 'heal-evidence-7-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE id = '66000000-0000-0000-0000-0000000000b7'),
  'active', 'a risk_review hold is never auto-released');

-- ---------------------------------------------------------------------------
-- Case 8: a human hold that forges the provider source. created_by is the field
-- that actually separates machine holds from human ones.
-- ---------------------------------------------------------------------------
INSERT INTO public.commerce_order_holds (id, order_id, created_by, status, reason, idempotency_key, metadata)
VALUES ('66000000-0000-0000-0000-0000000000b8', '66000000-0000-0000-0000-0000000000a8',
        '66000000-0000-0000-0000-0000000000c1',
        'active', 'fulfillment_exception', 'heal-forged-hold',
        '{"source":"commerce.fulfillment.omnipack_provider_exception"}'::jsonb);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES
  ('66000000-0000-0000-0000-0000000000f8', '66000000-0000-0000-0000-0000000000a8',
   'SUSPENDED', 'exception', 'reconciliation', '2026-07-16T09:00:00Z', 'heal-evidence-8-exception'),
  ('66000000-0000-0000-0000-0000000000f8', '66000000-0000-0000-0000-0000000000a8',
   'DELIVERED', 'delivered', 'reconciliation', '2026-07-17T09:00:00Z', 'heal-evidence-8-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE id = '66000000-0000-0000-0000-0000000000b8'),
  'active', 'a human hold with a forged provider source is never auto-released');

SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_system(
    'heal-direct-forged-call',
    '66000000-0000-0000-0000-0000000000b8',
    'commerce.fulfillment.omnipack_provider_exception_healed',
    'delivered'
  ) $$,
  '22023', 'commerce_oms_system_release_scope_forbidden',
  'a direct service_role call cannot release a human hold either'
);

-- ---------------------------------------------------------------------------
-- Case 9: terminal order. Delivery proof is meaningless once cancelled.
-- ---------------------------------------------------------------------------
INSERT INTO public.commerce_order_holds (id, order_id, created_by, status, reason, idempotency_key, metadata)
VALUES ('66000000-0000-0000-0000-0000000000b9', '66000000-0000-0000-0000-0000000000a9', NULL,
        'active', 'fulfillment_exception', 'heal-cancelled-hold',
        '{"source":"commerce.fulfillment.omnipack_provider_exception"}'::jsonb);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES
  ('66000000-0000-0000-0000-0000000000f9', '66000000-0000-0000-0000-0000000000a9',
   'SUSPENDED', 'exception', 'reconciliation', '2026-07-16T09:00:00Z', 'heal-evidence-9-exception'),
  ('66000000-0000-0000-0000-0000000000f9', '66000000-0000-0000-0000-0000000000a9',
   'DELIVERED', 'delivered', 'reconciliation', '2026-07-17T09:00:00Z', 'heal-evidence-9-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE id = '66000000-0000-0000-0000-0000000000b9'),
  'active', 'a hold on a cancelled order is left for a human to close');

-- ---------------------------------------------------------------------------
-- Case 10: a provider-side cancellation is an exception that does not self-clear.
-- ---------------------------------------------------------------------------
INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000fa', '66000000-0000-0000-0000-0000000000aa',
        'CANCELLED', 'exception', 'reconciliation', '2026-07-16T09:00:00Z', 'heal-evidence-10-exception');

SELECT lives_ok(
  $$ SELECT public.commerce_fulfillment_record_provider_exception(
    'heal-occurrence-10', '66000000-0000-0000-0000-0000000000aa', 'CANCELLED',
    '{"fulfillmentOrderId":"66000000-0000-0000-0000-0000000000fa"}'::jsonb) $$,
  'a provider cancellation opens a hold'
);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000fa', '66000000-0000-0000-0000-0000000000aa',
        'DELIVERED', 'delivered', 'reconciliation', '2026-07-17T09:00:00Z', 'heal-evidence-10-delivered');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE order_id = '66000000-0000-0000-0000-0000000000aa'),
  'active', 'a provider CANCELLED exception is never auto-healed by delivery');

-- ---------------------------------------------------------------------------
-- Case 11 (W2-V3 precondition): the evidence RPC accepts a fulfilment whose
-- DURABLE status is already off-track, so reconciliation can keep writing status
-- evidence for it and this trigger can fire from the pull path.
--
-- This is the whole basis of restoring auto-heal from the pull path: before
-- W2-V3 the reconciliation worker skipped an off-track fulfilment 58 lines
-- BEFORE the evidence write, so it produced no evidence row and the AFTER
-- INSERT healer above could never run for the exact orders it exists for. The
-- acceptance ack RPC keeps its own fulfillment-status allowlist and stays a
-- separate statement — if the evidence RPC ever grows the same allowlist, the
-- restored ordering must be reverted.
-- ---------------------------------------------------------------------------
INSERT INTO public.commerce_order_holds (id, order_id, created_by, status, reason, idempotency_key, metadata)
VALUES ('66000000-0000-0000-0000-0000000000bb', '66000000-0000-0000-0000-0000000000ab', NULL,
        'active', 'fulfillment_exception', 'heal-offtrack-hold',
        '{"source":"commerce.fulfillment.omnipack_provider_exception"}'::jsonb);

INSERT INTO public.omnipack_status_evidence (
  fulfillment_order_id, order_id, provider_status, provider_sub_status, local_status,
  evidence_kind, occurred_at, idempotency_key
)
VALUES ('66000000-0000-0000-0000-0000000000fb', '66000000-0000-0000-0000-0000000000ab',
        'SUSPENDED', 'CARRIER_MAPPING_ERROR', 'exception', 'reconciliation',
        '2026-07-16T09:00:00Z', 'heal-evidence-11-exception');

SELECT lives_ok(
  $$ SELECT public.omnipack_record_status_evidence(
    'heal-evidence-11-delivered-via-rpc',
    '66000000-0000-0000-0000-0000000000fb'::uuid,
    NULL::uuid,
    'DELIVERED',
    'COMPLETE',
    'delivered',
    'reconciliation',
    '2026-07-17T09:00:00Z'::timestamptz
  ) $$,
  'the evidence RPC accepts a fulfilment whose durable status is exception'
);

SELECT is(
  (SELECT count(*)::int FROM public.omnipack_status_evidence
    WHERE idempotency_key = 'heal-evidence-11-delivered-via-rpc'),
  1, 'the off-track evidence row is really persisted, not silently swallowed');

SELECT is(
  (SELECT status FROM public.commerce_order_holds
    WHERE id = '66000000-0000-0000-0000-0000000000bb'),
  'released', 'a delivered observation on an exception fulfilment releases the provider-exception hold');

SELECT is(
  (SELECT status FROM public.commerce_fulfillment_orders
    WHERE id = '66000000-0000-0000-0000-0000000000fb'),
  'exception', 'writing evidence does not move the durable fulfillment FSM');

SELECT lives_ok(
  $$ SELECT public.omnipack_record_status_evidence(
    'heal-evidence-12-cancelled-fsm-via-rpc',
    '66000000-0000-0000-0000-0000000000fc'::uuid,
    NULL::uuid,
    'DELIVERED',
    'COMPLETE',
    'delivered',
    'reconciliation',
    '2026-07-17T09:00:00Z'::timestamptz
  ) $$,
  'the other off-track durable status (cancelled) is accepted by the evidence RPC too'
);

-- ---------------------------------------------------------------------------
-- Contract guards on the system release RPC itself.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_system(
    'heal-bad-source-call', '66000000-0000-0000-0000-0000000000b9',
    'commerce.oms.v0', 'delivered') $$,
  '22023', 'commerce_oms_system_release_source_forbidden',
  'the release source is allowlisted, so this cannot become a generic backdoor'
);

SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_system(
    'heal-bad-proof-call', '66000000-0000-0000-0000-0000000000b9',
    'commerce.fulfillment.provider_exception_backfill', 'because-i-said-so') $$,
  '22023', 'commerce_oms_system_release_proof_forbidden',
  'the proof grade is allowlisted too'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.commerce_oms_release_hold_system(text, uuid, text, text, jsonb)', 'EXECUTE'),
  'anon cannot execute the system release');

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.commerce_oms_release_hold_system(text, uuid, text, text, jsonb)', 'EXECUTE'),
  'authenticated cannot execute the system release');

SELECT ok(
  NOT has_function_privilege('anon', 'public.commerce_oms_healable_provider_exception_holds(uuid)', 'EXECUTE'),
  'anon cannot enumerate healable holds');

SELECT * FROM finish();
ROLLBACK;
