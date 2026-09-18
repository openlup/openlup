-- pgTAP: the operator changes where the next parcel goes, and only a human can.
--
-- Two things are pinned here. The first is the `change_shipping_address` verb on
-- `customer_support_apply_subscription_action_v1`: that it delegates rather than
-- reimplementing, that it can carry a brand-new address taken over the phone without
-- editing a row somebody else's history points at, that it repairs the parcel already
-- being packed and leaves alone the one already dispatched, and that every way it can
-- say no arrives under a name the console can render.
--
-- The second is the human fence. `communications_require_active_operator` proves an
-- operator is provisioned and active; it cannot tell a person from an agent. All four
-- command routines now re-derive `admin_users.is_machine_actor` and refuse a machine
-- principal even when that principal is a fully provisioned, active operator - which
-- is exactly the fixture below, because a fence that only holds for an unprovisioned
-- caller is the fence that was already there.
--
-- The refusal assertions read the RETURNED code rather than a raised message: the
-- routine converts the delegate's `customer_self_service_` vocabulary into an audited
-- refusal, so a raise would mean the ledger recorded nothing. `invalid_address` is one
-- name covering three distinct causes - an id that names no row, a row belonging to
-- somebody else, and a row that is not a shipping address - because the subscriber's
-- own authority does not tell them apart and inventing a second vocabulary here would
-- describe a distinction the write path does not make.
--
-- Two of those three are refused by the operator routine itself rather than inherited.
-- The subscriber path reads the address with `AND client_id = ...` and then tests
-- `kind NOT IN ('shipping','both')`; an unowned or absent row leaves `kind` NULL,
-- `NULL NOT IN (...)` is NULL, and the guard does not fire. The three assertions below
-- are what stops that reaching the operator surface, so they are load-bearing rather
-- than a restatement of somebody else's proof.
--
-- The fixture vocabulary is deliberately neutral: 'ZZ' for a region code and 'XTS' for
-- a settlement currency, the placeholders this suite's neighbours already use. Nothing
-- here needs a real one - the verb under test moves a routing pointer and never reads
-- either value - and a named one would be counted against the readiness budget for a
-- file whose semantics do not depend on it. There is no catalogue or subscription-line
-- fixture at all for the same reason: this wave changes where a parcel goes, never what
-- is in it, so a package the assertions never read would only be vocabulary with no
-- proof attached.

BEGIN;
SELECT plan(39);

-- Two operators, both provisioned and both active. They differ only in what the
-- administrator roster says they are.
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES
  ('07a00000-0000-4000-8000-000000000001', true),
  ('07a00000-0000-4000-8000-000000000002', true);

INSERT INTO public.admin_users (id, email, role, is_machine_actor)
VALUES
  ('07a00000-0000-4000-8000-000000000001', 'address-human@example.invalid', 'admin', false),
  ('07a00000-0000-4000-8000-000000000002', 'address-agent@example.invalid', 'admin', true);

INSERT INTO auth.users (id)
VALUES ('07000000-0000-4000-8000-000000000001');

-- The subscriber. Linked, because the delegate resolves ownership through the
-- authorization identity and an unlinked subject is refused before any of this.
INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  '07100000-0000-4000-8000-000000000001',
  'address-subscriber@example.invalid',
  '07000000-0000-4000-8000-000000000001'
);

-- A second customer, so "an address that exists but is not hers" is a real row.
INSERT INTO public.clients (id, email, auth_user_id)
VALUES (
  '07100000-0000-4000-8000-000000000002',
  'address-stranger@example.invalid',
  NULL
);

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country, recipient_name, is_default)
VALUES
  -- Where the subscription points today.
  ('07300000-0000-4000-8000-000000000001', '07100000-0000-4000-8000-000000000001',
   'shipping', 'Old Street 1', 'Oldtown', '00-001', 'ZZ', 'Old Recipient', true),
  -- Saved, hers, and a shipping address: the one the picker offers.
  ('07300000-0000-4000-8000-000000000002', '07100000-0000-4000-8000-000000000001',
   'shipping', 'Saved Street 2', 'Savedtown', '00-002', 'ZZ', 'Saved Recipient', false),
  -- Hers, but an invoice address. The delegate admits only shipping/both.
  ('07300000-0000-4000-8000-000000000003', '07100000-0000-4000-8000-000000000001',
   'billing', 'Billing Street 3', 'Billtown', '00-003', 'ZZ', 'Billing Recipient', false),
  -- Somebody else's.
  ('07300000-0000-4000-8000-000000000004', '07100000-0000-4000-8000-000000000002',
   'shipping', 'Stranger Street 4', 'Strangetown', '00-004', 'ZZ', 'Stranger', false);

-- SUB-1 drives the saved-address arm and then the new-address arm.
-- SUB-2 carries a locked cycle. SUB-3 carries a parcel already dispatched.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at,
  shipping_address_id, payment_method_ref, payment_method_kind
)
VALUES
  ('07200000-0000-4000-8000-000000000001', '07100000-0000-4000-8000-000000000001',
   30, 'XTS', 'active', '2026-06-01T00:00:00Z', '2026-09-15T00:00:00Z',
   '07300000-0000-4000-8000-000000000001', 'pm_operator_address', 'card'),
  ('07200000-0000-4000-8000-000000000002', '07100000-0000-4000-8000-000000000001',
   30, 'XTS', 'active', '2026-06-01T00:00:00Z', '2026-09-20T00:00:00Z',
   '07300000-0000-4000-8000-000000000001', 'pm_operator_address', 'card'),
  ('07200000-0000-4000-8000-000000000003', '07100000-0000-4000-8000-000000000001',
   30, 'XTS', 'active', '2026-06-01T00:00:00Z', '2026-09-25T00:00:00Z',
   '07300000-0000-4000-8000-000000000001', 'pm_operator_address', 'card');

-- SUB-2's next cycle is already paid, which is what the locked-cycle assertion refuses.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
)
VALUES (
  '07600000-0000-4000-8000-000000000002', '07200000-0000-4000-8000-000000000002',
  1, '2026-09-20T00:00:00Z', 'paid', 'operator-address-cycle-2'
);

-- The cycles the two parcels below belong to. Their `scheduled_at` is deliberately
-- BEFORE each subscription's `next_cycle_at`: this is the cycle already being shipped,
-- not the next one. A cycle at `next_cycle_at` carrying a paid order is precisely what
-- the locked-cycle assertion refuses, and that case is SUB-2's, on purpose.
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
)
VALUES
  ('07600000-0000-4000-8000-000000000001', '07200000-0000-4000-8000-000000000001',
   1, '2026-08-15T00:00:00Z', 'paid', 'operator-address-cycle-1'),
  ('07600000-0000-4000-8000-000000000003', '07200000-0000-4000-8000-000000000003',
   1, '2026-08-15T00:00:00Z', 'paid', 'operator-address-cycle-3');

-- SUB-1's current-cycle parcel: still packable, and carrying a delivery selection in
-- the snapshot. That key is the whole reason the repair merges instead of rebuilding.
INSERT INTO public.commerce_orders (
  id, client_id, status, mode, subscription_id, subscription_cycle_id, shipping_address_id
)
VALUES (
  '07700000-0000-4000-8000-000000000001', '07100000-0000-4000-8000-000000000001',
  'paid', 'subscription_cycle', '07200000-0000-4000-8000-000000000001',
  '07600000-0000-4000-8000-000000000001',
  '07300000-0000-4000-8000-000000000001'
);
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot
)
VALUES (
  '07800000-0000-4000-8000-000000000001', '07700000-0000-4000-8000-000000000001',
  '07100000-0000-4000-8000-000000000001', '07300000-0000-4000-8000-000000000001',
  'operator-address-parcel-1', 'packed',
  '{"line1":"Old Street 1","city":"Oldtown","selectedDelivery":{"providerKind":"pickup","pickupPoint":{"id":"POINT-1","name":"Point One"}}}'::jsonb
);

-- SUB-3's parcel already has a label, so nothing about it may move.
INSERT INTO public.commerce_orders (
  id, client_id, status, mode, subscription_id, subscription_cycle_id, shipping_address_id
)
VALUES (
  '07700000-0000-4000-8000-000000000003', '07100000-0000-4000-8000-000000000001',
  'fulfillment_pending', 'subscription_cycle', '07200000-0000-4000-8000-000000000003',
  '07600000-0000-4000-8000-000000000003',
  '07300000-0000-4000-8000-000000000001'
);
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, shipping_address_snapshot
)
VALUES (
  '07800000-0000-4000-8000-000000000003', '07700000-0000-4000-8000-000000000003',
  '07100000-0000-4000-8000-000000000001', '07300000-0000-4000-8000-000000000001',
  'operator-address-parcel-3', 'label_created',
  '{"line1":"Old Street 1","city":"Oldtown"}'::jsonb
);

-- ---------------------------------------------------------------------------
-- The verb, with an address the subscriber already saved.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _saved AS
SELECT public.customer_support_apply_subscription_action_v1(
  '07a00000-0000-4000-8000-000000000001'::uuid,
  '07200000-0000-4000-8000-000000000001'::uuid,
  'change_shipping_address',
  '{"shippingAddressId":"07300000-0000-4000-8000-000000000002"}'::jsonb, 1,
  'operator-address-saved-1', '2026-08-24T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _saved),
  'applied',
  'the operator can change the subscription address to one the subscriber saved'
);

SELECT is(
  (SELECT response->>'appliedBy' FROM _saved),
  'customer_self_service_delegate',
  'it went through the subscriber authority, so ownership and kind were checked there'
);

SELECT is(
  (SELECT shipping_address_id::text FROM public.subscriptions
    WHERE id = '07200000-0000-4000-8000-000000000001'),
  '07300000-0000-4000-8000-000000000002',
  'the subscription now points at the saved address'
);

SELECT is(
  (SELECT actor_kind FROM public.subscription_events
    WHERE idempotency_key = 'operator-address-saved-1'),
  'operator',
  'the event says an operator did it, not the subscriber'
);

-- The confirmation e-mail is a safety property: a support-initiated address change is
-- never silent. Its outbox row is the only durable evidence that it was raised.
SELECT is(
  (SELECT count(*)::integer FROM public.outbox_events
    WHERE aggregate_type = 'subscription'
      AND aggregate_id = '07200000-0000-4000-8000-000000000001'
      AND event_type = 'subscription.address_changed'),
  1,
  'the subscriber is told, through the same outbox event her own change raises'
);

SELECT is(
  (SELECT value_before FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-address-saved-1'),
  '07300000-0000-4000-8000-000000000001',
  'the ledger records which address it was before'
);

SELECT is(
  (SELECT value_after FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-address-saved-1'),
  '07300000-0000-4000-8000-000000000002',
  'the ledger records which address it is now'
);

-- ---------------------------------------------------------------------------
-- The parcel already being packed moves with it.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT shipping_address_id::text FROM public.commerce_orders
    WHERE id = '07700000-0000-4000-8000-000000000001'),
  '07300000-0000-4000-8000-000000000002',
  'the current cycle order was repointed, so the change reaches this parcel'
);

-- The read that actually routes the parcel is on the fulfilment row, not the order.
SELECT is(
  (SELECT shipping_address_id::text FROM public.commerce_fulfillment_orders
    WHERE id = '07800000-0000-4000-8000-000000000001'),
  '07300000-0000-4000-8000-000000000002',
  'the fulfilment row was repointed too, which is the row dispatch reads'
);

SELECT is(
  (SELECT shipping_address_snapshot->>'line1' FROM public.commerce_fulfillment_orders
    WHERE id = '07800000-0000-4000-8000-000000000001'),
  'Saved Street 2',
  'the parcel snapshot carries the new street'
);

-- The failure this test exists for: a rebuilt snapshot silently drops the pickup point
-- and the parcel goes to the last place a lower-precedence source happened to name.
SELECT is(
  (SELECT shipping_address_snapshot #>> '{selectedDelivery,pickupPoint,id}'
     FROM public.commerce_fulfillment_orders
    WHERE id = '07800000-0000-4000-8000-000000000001'),
  'POINT-1',
  'the merge preserved the delivery selection the snapshot already held'
);

-- ---------------------------------------------------------------------------
-- Idempotency.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _saved_replay AS
SELECT public.customer_support_apply_subscription_action_v1(
  '07a00000-0000-4000-8000-000000000001'::uuid,
  '07200000-0000-4000-8000-000000000001'::uuid,
  'change_shipping_address',
  '{"shippingAddressId":"07300000-0000-4000-8000-000000000002"}'::jsonb, 1,
  'operator-address-saved-1', '2026-08-24T12:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _saved_replay),
  'replayed',
  'a double-clicked address change replays the receipt instead of acting twice'
);

SELECT is(
  (SELECT count(*)::integer FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'operator-address-saved-1'),
  1,
  'the replay wrote no second audit row'
);

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '07a00000-0000-4000-8000-000000000001'::uuid,
      '07200000-0000-4000-8000-000000000001'::uuid,
      'change_shipping_address',
      '{"shippingAddressId":"07300000-0000-4000-8000-000000000003"}'::jsonb, 1,
      'operator-address-saved-1', '2026-08-24T12:00:00Z'::timestamptz)$$,
  '23505',
  'customer_support_idempotency_conflict',
  'the same key naming a different address conflicts instead of quietly moving it'
);

-- ---------------------------------------------------------------------------
-- An address taken over the phone.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _created AS
SELECT public.customer_support_apply_subscription_action_v1(
  '07a00000-0000-4000-8000-000000000001'::uuid,
  '07200000-0000-4000-8000-000000000001'::uuid,
  'change_shipping_address',
  '{"newAddress":{"recipientName":"New Recipient","line1":"New Street 9","line2":"Flat 3","postalCode":"00-009","city":"Newtown","country":"zz","contactPhone":"+48111222333"}}'::jsonb,
  1, 'operator-address-created-1', '2026-08-24T13:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _created),
  'applied',
  'the operator can take a brand-new address down during the call'
);

SELECT is(
  (SELECT count(*)::integer FROM public.addresses
    WHERE client_id = '07100000-0000-4000-8000-000000000001'
      AND source = 'admin'),
  1,
  'exactly one new row was written, and it says an operator wrote it'
);

SELECT is(
  (SELECT is_default FROM public.addresses
    WHERE client_id = '07100000-0000-4000-8000-000000000001' AND source = 'admin'),
  false,
  'a correction taken over the phone does not unseat the address she chose as default'
);

SELECT is(
  (SELECT is_default FROM public.addresses WHERE id = '07300000-0000-4000-8000-000000000001'),
  true,
  'and her own default is still her own default'
);

-- The rejected alternative, pinned: an in-place edit rewrites the address on delivered
-- orders and moves any other subscription pointing at the same row.
SELECT is(
  (SELECT line1 FROM public.addresses WHERE id = '07300000-0000-4000-8000-000000000002'),
  'Saved Street 2',
  'the row the subscription pointed at a moment ago was not edited'
);

SELECT is(
  (SELECT shipping_address_id FROM public.subscriptions
    WHERE id = '07200000-0000-4000-8000-000000000001'),
  (SELECT id FROM public.addresses
    WHERE client_id = '07100000-0000-4000-8000-000000000001' AND source = 'admin'),
  'the subscription points at the row that was just created'
);

SELECT is(
  (SELECT country FROM public.addresses
    WHERE client_id = '07100000-0000-4000-8000-000000000001' AND source = 'admin'),
  'ZZ',
  'the country is stored the way every other writer stores it'
);

-- ---------------------------------------------------------------------------
-- A parcel that already has a label is not touched, and the command still succeeds.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _dispatched AS
SELECT public.customer_support_apply_subscription_action_v1(
  '07a00000-0000-4000-8000-000000000001'::uuid,
  '07200000-0000-4000-8000-000000000003'::uuid,
  'change_shipping_address',
  '{"shippingAddressId":"07300000-0000-4000-8000-000000000002"}'::jsonb, 1,
  'operator-address-dispatched-1', '2026-08-24T14:00:00Z'::timestamptz
) AS response;

SELECT is(
  (SELECT response->>'outcome' FROM _dispatched),
  'applied',
  'a dispatched parcel does not refuse the subscription change - every later cycle moves'
);

SELECT is(
  (SELECT shipping_address_id::text FROM public.commerce_orders
    WHERE id = '07700000-0000-4000-8000-000000000003'),
  '07300000-0000-4000-8000-000000000001',
  'the dispatched order keeps the address it was shipped to'
);

SELECT is(
  (SELECT shipping_address_snapshot->>'line1' FROM public.commerce_fulfillment_orders
    WHERE id = '07800000-0000-4000-8000-000000000003'),
  'Old Street 1',
  'and its snapshot is untouched, because that parcel is already on its way'
);

-- ---------------------------------------------------------------------------
-- Every way this can say no, by name.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT public.customer_support_apply_subscription_action_v1(
     '07a00000-0000-4000-8000-000000000001'::uuid,
     '07200000-0000-4000-8000-000000000002'::uuid,
     'change_shipping_address',
     '{"shippingAddressId":"07300000-0000-4000-8000-000000000009"}'::jsonb, 1,
     'operator-address-unknown-1', '2026-08-24T15:00:00Z'::timestamptz)->>'refusalCode'),
  'invalid_address',
  'an id naming no row is refused by name, not raised'
);

SELECT is(
  (SELECT public.customer_support_apply_subscription_action_v1(
     '07a00000-0000-4000-8000-000000000001'::uuid,
     '07200000-0000-4000-8000-000000000002'::uuid,
     'change_shipping_address',
     '{"shippingAddressId":"07300000-0000-4000-8000-000000000004"}'::jsonb, 1,
     'operator-address-foreign-1', '2026-08-24T15:01:00Z'::timestamptz)->>'refusalCode'),
  'invalid_address',
  'an address belonging to another customer is refused'
);

SELECT is(
  (SELECT public.customer_support_apply_subscription_action_v1(
     '07a00000-0000-4000-8000-000000000001'::uuid,
     '07200000-0000-4000-8000-000000000002'::uuid,
     'change_shipping_address',
     '{"shippingAddressId":"07300000-0000-4000-8000-000000000003"}'::jsonb, 1,
     'operator-address-kind-1', '2026-08-24T15:02:00Z'::timestamptz)->>'refusalCode'),
  'invalid_address',
  'an invoice address is refused, because a parcel cannot be sent to one'
);

-- SUB-2's next cycle is paid, so the delegate's locked-cycle assertion answers.
SELECT is(
  (SELECT public.customer_support_apply_subscription_action_v1(
     '07a00000-0000-4000-8000-000000000001'::uuid,
     '07200000-0000-4000-8000-000000000002'::uuid,
     'change_shipping_address',
     '{"shippingAddressId":"07300000-0000-4000-8000-000000000002"}'::jsonb, 1,
     'operator-address-locked-1', '2026-08-24T15:03:00Z'::timestamptz)->>'refusalCode'),
  'payment_blocked',
  'a cycle already paid for is refused under the name the subscriber path uses'
);

SELECT is(
  (SELECT public.customer_support_apply_subscription_action_v1(
     '07a00000-0000-4000-8000-000000000001'::uuid,
     '07200000-0000-4000-8000-000000000002'::uuid,
     'change_shipping_address',
     '{"shippingAddressId":"07300000-0000-4000-8000-000000000002"}'::jsonb, 99,
     'operator-address-stale-1', '2026-08-24T15:04:00Z'::timestamptz)->>'refusalCode'),
  'version_conflict',
  'a console that read a stale version conflicts instead of overwriting'
);

-- A refused new-address command must leave nothing behind. The INSERT runs inside the
-- same subtransaction the delegate refusal rolls back.
SELECT is(
  (SELECT count(*)::integer FROM public.addresses
    WHERE client_id = '07100000-0000-4000-8000-000000000001' AND source = 'admin'),
  1,
  'the refusals above created no orphan address row'
);

-- ---------------------------------------------------------------------------
-- Malformed commands are malformed, not business refusals.
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '07a00000-0000-4000-8000-000000000001'::uuid,
      '07200000-0000-4000-8000-000000000002'::uuid,
      'change_shipping_address',
      '{"shippingAddressId":"07300000-0000-4000-8000-000000000002","newAddress":{"recipientName":"X","line1":"Y","postalCode":"00-000","city":"Z","country":"ZZ"}}'::jsonb,
      1, 'operator-address-both-1', '2026-08-24T15:05:00Z'::timestamptz)$$,
  '22023',
  'customer_support_subscription_command_invalid',
  'naming the destination twice is a malformed command'
);

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '07a00000-0000-4000-8000-000000000001'::uuid,
      '07200000-0000-4000-8000-000000000002'::uuid,
      'change_shipping_address', '{}'::jsonb, 1,
      'operator-address-neither-1', '2026-08-24T15:06:00Z'::timestamptz)$$,
  '22023',
  'customer_support_subscription_command_invalid',
  'naming no destination at all is a malformed command'
);

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '07a00000-0000-4000-8000-000000000001'::uuid,
      '07200000-0000-4000-8000-000000000002'::uuid,
      'change_shipping_address',
      '{"newAddress":{"recipientName":"X","line1":"","postalCode":"00-000","city":"Z","country":"ZZ"}}'::jsonb,
      1, 'operator-address-blank-1', '2026-08-24T15:07:00Z'::timestamptz)$$,
  '22023',
  'customer_support_subscription_command_invalid',
  'an empty street is refused before the delegate writes the subscriber an event'
);

-- ---------------------------------------------------------------------------
-- The human fence, on all four commands.
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT public.customer_support_apply_subscription_action_v1(
      '07a00000-0000-4000-8000-000000000002'::uuid,
      '07200000-0000-4000-8000-000000000002'::uuid,
      'change_shipping_address',
      '{"shippingAddressId":"07300000-0000-4000-8000-000000000002"}'::jsonb, 1,
      'operator-address-machine-1', '2026-08-24T16:00:00Z'::timestamptz)$$,
  '42501',
  'customer_support_command_requires_human',
  'a machine actor cannot change a customer address, however well provisioned'
);

SELECT throws_ok(
  $$SELECT public.customer_support_correct_subject_email_v1(
      '07a00000-0000-4000-8000-000000000002'::uuid,
      '07100000-0000-4000-8000-000000000002'::uuid,
      'address-stranger@example.invalid', 'agent-moved@example.invalid',
      'operator-address-machine-2', '2026-08-24T16:01:00Z'::timestamptz)$$,
  '42501',
  'customer_support_command_requires_human',
  'nor correct the address a customer signs in with'
);

SELECT throws_ok(
  $$SELECT public.customer_support_correct_subject_phone_v1(
      '07a00000-0000-4000-8000-000000000002'::uuid,
      '07100000-0000-4000-8000-000000000002'::uuid,
      '', '+48999888777',
      'operator-address-machine-3', '2026-08-24T16:02:00Z'::timestamptz)$$,
  '42501',
  'customer_support_command_requires_human',
  'nor the number the delivery payload carries'
);

SELECT throws_ok(
  $$SELECT public.customer_support_absorb_lead_v1(
      '07a00000-0000-4000-8000-000000000002'::uuid,
      '07100000-0000-4000-8000-000000000001'::uuid,
      '07100000-0000-4000-8000-000000000002'::uuid,
      'address-stranger@example.invalid',
      'operator-address-machine-4', '2026-08-24T16:03:00Z'::timestamptz)$$,
  '42501',
  'customer_support_command_requires_human',
  'nor merge two customer records together'
);

SELECT is(
  (SELECT count(*)::integer FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key LIKE 'operator-address-machine-%'),
  0,
  'the fence answers before any subject state is read, so it records nothing'
);

-- The fence is about what the caller IS, not about having an administrator row: the
-- human operator above holds one too and every assertion in this file went through.
SELECT is(
  (SELECT is_machine_actor FROM public.admin_users
    WHERE id = '07a00000-0000-4000-8000-000000000001'),
  false,
  'the operator every other case here used is a person on the same roster'
);

SELECT * FROM finish();
ROLLBACK;
