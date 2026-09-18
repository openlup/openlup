-- pgTAP: Subscription self-service durable shipping-address change.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(17);

INSERT INTO auth.users (id) VALUES
  ('a2400000-0000-0000-0000-000000000001'),
  ('a2400000-0000-0000-0000-000000000002');
INSERT INTO public.clients (id, email, auth_user_id) VALUES
  ('c2400000-0000-0000-0000-000000000001', 'address-owner@example.invalid', 'a2400000-0000-0000-0000-000000000001'),
  ('c2400000-0000-0000-0000-000000000002', 'address-other@example.invalid', 'a2400000-0000-0000-0000-000000000002');

INSERT INTO public.addresses (id, client_id, kind, label, line1, city, postal_code, country) VALUES
  ('ad240000-0000-0000-0000-000000000001', 'c2400000-0000-0000-0000-000000000001', 'shipping', 'Old shipping', 'Old 1', 'Warszawa', '00-001', 'PL'),
  ('ad240000-0000-0000-0000-000000000002', 'c2400000-0000-0000-0000-000000000001', 'both', 'New shipping', 'New 2', 'Warszawa', '00-002', 'PL'),
  ('ad240000-0000-0000-0000-000000000003', 'c2400000-0000-0000-0000-000000000001', 'billing', 'Billing only', 'Bill 3', 'Warszawa', '00-003', 'PL'),
  ('ad240000-0000-0000-0000-000000000004', 'c2400000-0000-0000-0000-000000000002', 'shipping', 'Other shipping', 'Other 4', 'Warszawa', '00-004', 'PL');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version,
  edit_window_hours, shipping_address_id, billing_address_id
) VALUES (
  '5b240000-0000-0000-0000-000000000001',
  'c2400000-0000-0000-0000-000000000001',
  28, 'PLN', 'active', '2026-09-01T00:00:00Z', 7, 24,
  'ad240000-0000-0000-0000-000000000001',
  'ad240000-0000-0000-0000-000000000001'
);

SELECT public.customer_self_service_apply_subscription_action(
  'a2400000-0000-0000-0000-000000000001',
  'change-address-idem-1',
  '5b240000-0000-0000-0000-000000000001',
  'change_shipping_address',
  '{"shippingAddressId":"ad240000-0000-0000-0000-000000000002","reason":"moving"}'::jsonb,
  '2026-06-16T10:00:00Z'::timestamptz
);

SELECT is(
  (SELECT shipping_address_id FROM public.subscriptions WHERE id = '5b240000-0000-0000-0000-000000000001'),
  'ad240000-0000-0000-0000-000000000002'::uuid,
  'change_shipping_address updates the durable subscription shipping address'
);
SELECT is(
  (SELECT billing_address_id FROM public.subscriptions WHERE id = '5b240000-0000-0000-0000-000000000001'),
  'ad240000-0000-0000-0000-000000000001'::uuid,
  'change_shipping_address does not mutate billing address'
);
SELECT is(
  (SELECT template_version FROM public.subscriptions WHERE id = '5b240000-0000-0000-0000-000000000001'),
  7,
  'change_shipping_address does not mutate template version'
);
SELECT is(
  (SELECT event_type FROM public.subscription_events WHERE idempotency_key = 'change-address-idem-1'),
  'subscription.customer_self_service.change_shipping_address',
  'change_shipping_address writes a subscription-owned audit event'
);
SELECT is(
  (SELECT payload #>> '{payload,shippingAddressId}' FROM public.subscription_events WHERE idempotency_key = 'change-address-idem-1'),
  'ad240000-0000-0000-0000-000000000002',
  'change_shipping_address audit payload records the selected address id'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key
) VALUES (
  'cc240000-0000-0000-0000-000000000002',
  '5b240000-0000-0000-0000-000000000001',
  2, '2026-10-01T00:00:00Z', 'paid', '2026-09-15T00:00:00Z', 'change-address-order-cycle'
);
INSERT INTO public.commerce_orders (
  id, client_id, status, currency, subtotal_cents, discount_cents, shipping_cents,
  tax_cents, total_cents, region_code, mode, subscription_id, subscription_cycle_id, metadata
) VALUES (
  '0f240000-0000-0000-0000-000000000001',
  'c2400000-0000-0000-0000-000000000001',
  'pending_payment', 'PLN', 1000, 0, 0, 80, 1000, 'PL',
  'subscription_cycle', '5b240000-0000-0000-0000-000000000001',
  'cc240000-0000-0000-0000-000000000002', '{}'::jsonb
);
SELECT is(
  (SELECT shipping_address_id FROM public.commerce_orders WHERE id = '0f240000-0000-0000-0000-000000000001'),
  'ad240000-0000-0000-0000-000000000002'::uuid,
  'subscription cycle order creation consumes the current subscription shipping address'
);

SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a2400000-0000-0000-0000-000000000001',
    'change-address-billing-only',
    '5b240000-0000-0000-0000-000000000001',
    'change_shipping_address',
    '{"shippingAddressId":"ad240000-0000-0000-0000-000000000003"}'::jsonb,
    '2026-06-16T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_invalid_address',
  'change_shipping_address rejects billing-only addresses'
);

-- Ownership. The lookup is scoped to the caller's client_id, but until
-- 20260824180000 nothing read whether it matched: a miss left v_address_kind
-- NULL, `NULL NOT IN (...)` is NULL, the IF did not fire and the UPDATE ran. The
-- two causes below are the two ways that lookup can miss. Each is pinned twice —
-- the refusal the caller sees, and the durable address the subscription keeps —
-- because a regression makes the call succeed, so the throws_ok would fail AND
-- the foreign address would persist.
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a2400000-0000-0000-0000-000000000001',
    'change-address-foreign-owned',
    '5b240000-0000-0000-0000-000000000001',
    'change_shipping_address',
    '{"shippingAddressId":"ad240000-0000-0000-0000-000000000004"}'::jsonb,
    '2026-06-16T10:00:00Z'::timestamptz) $q$,
  'P0001',
  'customer_self_service_invalid_address',
  'change_shipping_address refuses an address owned by another customer'
);
SELECT is(
  (SELECT shipping_address_id FROM public.subscriptions WHERE id = '5b240000-0000-0000-0000-000000000001'),
  'ad240000-0000-0000-0000-000000000002'::uuid,
  'a refused foreign-owned address never reaches the durable subscription'
);

-- An id that exists nowhere used to reach the UPDATE too, where it raised a raw
-- 23503 from subscriptions_shipping_address_id_fkey — outside the P0001
-- customer_self_service_* vocabulary the account UI renders. The errcode is
-- asserted, not just the message, because that is the half that regressed.
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a2400000-0000-0000-0000-000000000001',
    'change-address-absent-id',
    '5b240000-0000-0000-0000-000000000001',
    'change_shipping_address',
    '{"shippingAddressId":"ad240000-0000-0000-0000-0000000000ff"}'::jsonb,
    '2026-06-16T10:00:00Z'::timestamptz) $q$,
  'P0001',
  'customer_self_service_invalid_address',
  'change_shipping_address refuses an address id that exists nowhere, not with a raw foreign-key error'
);
SELECT is(
  (SELECT shipping_address_id FROM public.subscriptions WHERE id = '5b240000-0000-0000-0000-000000000001'),
  'ad240000-0000-0000-0000-000000000002'::uuid,
  'a refused absent address id never reaches the durable subscription'
);

-- Ordering. The ownership guard must not preempt the idempotency replay the
-- delegate has always answered first: a key that already produced an event still
-- reports `replayed`, even when the payload now carries an id the caller does not
-- own.
SELECT is(
  public.customer_self_service_apply_subscription_action(
    'a2400000-0000-0000-0000-000000000001',
    'change-address-idem-1',
    '5b240000-0000-0000-0000-000000000001',
    'change_shipping_address',
    '{"shippingAddressId":"ad240000-0000-0000-0000-000000000004"}'::jsonb,
    '2026-06-16T10:00:00Z'::timestamptz
  ) #>> '{subscriptionAction,status}',
  'replayed',
  'the ownership guard leaves the idempotency replay ahead of it untouched'
);

-- Positive control: the guard narrows nothing for an address the caller does own.
SELECT public.customer_self_service_apply_subscription_action(
  'a2400000-0000-0000-0000-000000000001',
  'change-address-idem-2',
  '5b240000-0000-0000-0000-000000000001',
  'change_shipping_address',
  '{"shippingAddressId":"ad240000-0000-0000-0000-000000000001"}'::jsonb,
  '2026-06-16T10:00:00Z'::timestamptz
);
SELECT is(
  (SELECT shipping_address_id FROM public.subscriptions WHERE id = '5b240000-0000-0000-0000-000000000001'),
  'ad240000-0000-0000-0000-000000000001'::uuid,
  'change_shipping_address still applies an owned shipping address after the ownership guard'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, paid_at, template_version,
  template_snapshot, pricing_snapshot, engine_idempotency_key
) VALUES (
  'cc240000-0000-0000-0000-000000000001',
  '5b240000-0000-0000-0000-000000000001',
  1, '2026-09-01T00:00:00Z', 'paid', '2026-08-15T00:00:00Z', 7,
  '{}'::jsonb, '{}'::jsonb, 'change-address-locked-cycle'
);
SELECT throws_ok(
  $q$ SELECT public.customer_self_service_apply_subscription_action(
    'a2400000-0000-0000-0000-000000000001',
    'change-address-locked',
    '5b240000-0000-0000-0000-000000000001',
    'change_shipping_address',
    '{"shippingAddressId":"ad240000-0000-0000-0000-000000000002"}'::jsonb,
    '2026-06-16T10:00:00Z'::timestamptz) $q$,
  'customer_self_service_payment_blocked',
  'change_shipping_address blocks locked upcoming cycles'
);

-- Privilege posture of the renamed carrier. 20260824180000 moved the definer-rights
-- body that performs every self-service write to a new name, and a rename carries the
-- old name's ACL forward — so its browser-role closure would otherwise rest on
-- inheritance across five renames rather than on a statement. Resolution is asserted
-- first because `has_function_privilege` yields NULL, not an error, for an identity it
-- cannot resolve, which would let the two privilege assertions pass vacuously after a
-- sixth rename.
SELECT isnt(
  to_regprocedure(
    'public.customer_self_service_apply_action_before_address_ownership(uuid, text, uuid, text, jsonb, timestamptz)'
  ),
  NULL,
  'the renamed self-service carrier resolves to a live function'
);
SELECT is(
  (SELECT coalesce(string_agg(role_name, ', ' ORDER BY role_name), '')
     FROM unnest(ARRAY['anon', 'authenticated']) AS role_name
    WHERE has_function_privilege(
      role_name,
      'public.customer_self_service_apply_action_before_address_ownership(uuid, text, uuid, text, jsonb, timestamptz)',
      'EXECUTE'
    )),
  '',
  'the renamed self-service carrier is not executable by any browser role'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.customer_self_service_apply_action_before_address_ownership(uuid, text, uuid, text, jsonb, timestamptz)',
    'EXECUTE'
  ),
  'the renamed self-service carrier stays executable by service_role'
);

SELECT * FROM finish();
ROLLBACK;
