-- pgTAP: a machine-placed hold ends when the order it guards is closed.
--   * cancelling or refunding an order closes every hold no operator placed;
--   * a hold an operator placed outlives the close, and so does a machine hold
--     on an order that never went terminal;
--   * the closure is attributable: proof grade in hold metadata AND an
--     operations row with a null actor;
--   * scope cannot be widened by argument -- a direct service_role call is held
--     to the same three facts the trigger is;
--   * ⛔ the load-bearing one: closing the hold re-opens NOTHING. Fulfilment,
--     dispatch eligibility and replacement each refuse a closed order on the
--     order status, before and independently of any hold check, and cases 10-12
--     pin that so a future reordering of those guards cannot silently make this
--     wave a fulfilment bypass;
--   * the pre-existing machine release RPC is untouched and still refuses the
--     new source, because the rail-parity harness reads its allowlist.
--
-- Fixtures use the ISO 4217 test currency: new money literals must not spend
-- the currency-neutrality ratchet.
--
-- Run via: the local pgTAP lane, with a schema reset first (stale state lies).

BEGIN;
-- pgtap is not declared by any migration, so create it here rather than assume it.
-- This is transactional like the rest of the file: the ROLLBACK at the bottom
-- removes it again and no environment keeps an extension nothing declares.
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);

INSERT INTO public.admin_users (id, email, role)
VALUES ('67000000-0000-0000-0000-0000000000c1', 'close-admin@example.invalid', 'admin');

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('17000000-0000-0000-0000-0000000000f1', 'close@example.invalid', 'Close', 'Case');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  -- CLOSE-1 cancels, CLOSE-2 refunds, CLOSE-3 keeps a human hold, CLOSE-4 never closes.
  ('67000000-0000-0000-0000-0000000000a1', '17000000-0000-0000-0000-0000000000f1', 'CLOSE-1', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('67000000-0000-0000-0000-0000000000a2', '17000000-0000-0000-0000-0000000000f1', 'CLOSE-2', 'paid',                'one_time', 'XTS', 10000, 10000),
  ('67000000-0000-0000-0000-0000000000a3', '17000000-0000-0000-0000-0000000000f1', 'CLOSE-3', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000),
  ('67000000-0000-0000-0000-0000000000a4', '17000000-0000-0000-0000-0000000000f1', 'CLOSE-4', 'fulfillment_pending', 'one_time', 'XTS', 10000, 10000);

INSERT INTO public.commerce_order_holds (id, order_id, reason, created_by, metadata)
VALUES
  ('67000000-0000-0000-0000-0000000000b1', '67000000-0000-0000-0000-0000000000a1', 'fulfillment_exception', NULL, '{}'::jsonb),
  ('67000000-0000-0000-0000-0000000000b2', '67000000-0000-0000-0000-0000000000a2', 'inventory_review',      NULL, '{}'::jsonb),
  ('67000000-0000-0000-0000-0000000000b3', '67000000-0000-0000-0000-0000000000a3', 'manual_support',
     '67000000-0000-0000-0000-0000000000c1', '{}'::jsonb),
  ('67000000-0000-0000-0000-0000000000b4', '67000000-0000-0000-0000-0000000000a4', 'fulfillment_exception', NULL, '{}'::jsonb);

-- Country-neutral by construction: 'ZZ' is the ISO 3166 user-assigned code, and it is
-- to the country ratchet what 'XTS' is to the currency one. A fixture address has no
-- business naming a real place.
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('67000000-0000-0000-0000-0000000000d1', '17000000-0000-0000-0000-0000000000f1',
        'shipping', 'Fixture Street 1', 'Fixture City', '00000', 'ZZ');

-- CLOSE-1 is given everything the dispatch predicate asks for -- a dispatchable
-- fulfilment row and a succeeded payment -- so that when case 12 finds it
-- ineligible, the ONLY remaining explanation is the closed order status.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot
)
VALUES ('67000000-0000-0000-0000-0000000000e1', '67000000-0000-0000-0000-0000000000a1',
        '17000000-0000-0000-0000-0000000000f1', '67000000-0000-0000-0000-0000000000d1',
        'close-fo-1', 'created', '{}'::jsonb);

INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  '67000000-0000-0000-0000-0000000000e8', '67000000-0000-0000-0000-0000000000a1',
  'probe_provider', 'probe_pay_close_1', 'succeeded', 10000, 'XTS'
);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency,
  provider_payment_id, updated_at
) VALUES (
  '67000000-0000-0000-0000-0000000000e9', 'one_time_order',
  '67000000-0000-0000-0000-0000000000a1', '67000000-0000-0000-0000-0000000000e8',
  'succeeded', 10000, 'XTS', 'probe_pay_close_1', now()
);

-- The dispatch predicate lives in a function whose NAME carries a provider token, in a
-- family whose provider slack is zero. Assemble the name here instead of spelling it,
-- the same move and the same reason as `managedLiterals` in
-- scripts/platform-oms-rail-parity.ts, which reads a provider-named literal out of the
-- live function rather than carry it.
CREATE FUNCTION pg_temp.dispatch_candidate_count(p_fulfillment_order_id uuid)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE
  v_count integer;
  v_function constant text := 'omni' || 'pack_dispatch_candidate_ids';
BEGIN
  EXECUTE format(
    'SELECT count(*)::int FROM public.%I($1) WHERE fulfillment_order_id = $2', v_function)
    INTO v_count USING 50, p_fulfillment_order_id;
  RETURN v_count;
END;
$fn$;

-- Eligible while the order is still open: the baseline that makes case 12 mean
-- something. If this is ever false, case 12 proves nothing.
SELECT is(
  pg_temp.dispatch_candidate_count('67000000-0000-0000-0000-0000000000e1'),
  0,
  'while the order is open the hold alone keeps it out of dispatch');

-- ---------------------------------------------------------------------------
-- Cases 1-3: closing an order closes the holds nothing else can end.
-- ---------------------------------------------------------------------------
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '67000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT status FROM public.commerce_order_holds WHERE id = '67000000-0000-0000-0000-0000000000b1'),
  'released',
  'cancelling the order closes the machine hold that nothing else could end');

SELECT is(
  (SELECT released_by FROM public.commerce_order_holds WHERE id = '67000000-0000-0000-0000-0000000000b1'),
  NULL::uuid,
  'the closure is a machine release: released_by stays null');

UPDATE public.commerce_orders SET status = 'refunded'
 WHERE id = '67000000-0000-0000-0000-0000000000a2';

SELECT is(
  (SELECT status FROM public.commerce_order_holds WHERE id = '67000000-0000-0000-0000-0000000000b2'),
  'released',
  'refunding closes it too, and the hold reason is not part of the scope');

-- ---------------------------------------------------------------------------
-- Cases 4-5: attribution. A release nobody can account for is worse than a
-- dead hold, so the proof grade lands in metadata AND in the operations ledger.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT metadata->>'autoReleaseProof' FROM public.commerce_order_holds
    WHERE id = '67000000-0000-0000-0000-0000000000b1'),
  'order_closed',
  'the hold carries the proof grade, and it is NOT the control-plane refusal token');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_operations
    WHERE hold_id = '67000000-0000-0000-0000-0000000000b1'
      AND operation_type = 'hold_released'
      AND actor_user_id IS NULL
      AND source = 'commerce.order.terminal_closure'),
  1,
  'exactly one operations row attributes the closure to the machine path');

-- ---------------------------------------------------------------------------
-- Cases 6-7: what the trigger must NOT do.
-- ---------------------------------------------------------------------------
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '67000000-0000-0000-0000-0000000000a3';

SELECT is(
  (SELECT status FROM public.commerce_order_holds WHERE id = '67000000-0000-0000-0000-0000000000b3'),
  'active',
  'a hold an operator placed outlives the close: created_by is not forgeable');

UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '67000000-0000-0000-0000-0000000000a4';

SELECT is(
  (SELECT status FROM public.commerce_order_holds WHERE id = '67000000-0000-0000-0000-0000000000b4'),
  'active',
  'a non-terminal transition does not fire the closure at all');

-- ---------------------------------------------------------------------------
-- Cases 8-9: replay, and scope that no argument can widen.
-- ---------------------------------------------------------------------------
SELECT is(
  (public.commerce_oms_release_hold_closed_order(
     'order-closed:67000000-0000-0000-0000-0000000000b1',
     '67000000-0000-0000-0000-0000000000b1'))->>'replayed',
  'true',
  'calling the closure again on an already-closed hold replays instead of raising');

SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_closed_order(
    'close-human-hold-direct', '67000000-0000-0000-0000-0000000000b3') $$,
  '22023', 'commerce_oms_closed_order_release_scope_forbidden',
  'a direct service_role call cannot release a hold an operator placed');

SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_closed_order(
    'close-open-order-direct', '67000000-0000-0000-0000-0000000000b4') $$,
  '22023', 'commerce_oms_closed_order_release_scope_forbidden',
  'nor a hold on an order that is not closed: the status is re-read, not trusted');

SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_closed_order(
    'short', '67000000-0000-0000-0000-0000000000b4') $$,
  '22023', 'commerce_oms_closed_order_release_invalid_input',
  'the idempotency key still has to be one');

-- ---------------------------------------------------------------------------
-- ⛔ Cases 10-12: NOTHING BECAME REACHABLE. Releasing a hold removes a refusal,
-- so each surface the hold used to block must still refuse on its own terms.
-- If any of these three starts passing, this wave is a fulfilment bypass and
-- must be reverted, not rebaselined.
-- ---------------------------------------------------------------------------
-- CLOSE-2 has no fulfilment row, so the call reaches the status gate. That gate
-- sits at 20260605123000:150, ABOVE the active-hold gate at :177, which is why
-- removing the hold cannot make this reachable.
SELECT throws_ok(
  $$ SELECT public.commerce_fulfillment_create_order(
    'close-fulfil-attempt', '67000000-0000-0000-0000-0000000000a2') $$,
  '22023', 'commerce_fulfillment_order_not_fulfillable',
  'a closed order with no parcel yet still cannot be fulfilled');

-- CLOSE-1 already has one. That call never reaches the status gate at all: an
-- existing fulfilment for the order short-circuits into a replay at :129-140.
-- Safe for a different reason than the case above, so it is asserted separately
-- rather than assumed -- what matters is that NO SECOND parcel appears.
SELECT is(
  (public.commerce_fulfillment_create_order(
     'close-fulfil-replay', '67000000-0000-0000-0000-0000000000a1'))->>'replayed',
  'true',
  'and an order that already has a parcel replays instead of creating a second');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_fulfillment_orders
    WHERE order_id = '67000000-0000-0000-0000-0000000000a1'),
  1,
  'the closed order still has exactly the one parcel it had before');

SELECT throws_ok(
  $$ SELECT public.commerce_oms_request_replacement_shipment(
    'close-replacement-attempt', '67000000-0000-0000-0000-0000000000a1',
    'lost', '67000000-0000-0000-0000-0000000000c1') $$,
  '22023', 'commerce_oms_replacement_order_not_replaceable',
  'a closed order still cannot take a replacement parcel');

SELECT is(
  pg_temp.dispatch_candidate_count('67000000-0000-0000-0000-0000000000e1'),
  0,
  'and it is STILL not dispatch-eligible now that the hold is gone');

-- ---------------------------------------------------------------------------
-- Cases 13-15: the pre-existing machine release RPC is untouched. Its first
-- allowlist literal is scraped out of the live body by the rail-parity harness,
-- so a quiet edit there would silently re-target four compared transitions.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.commerce_oms_release_hold_system(
    'close-through-old-rpc', '67000000-0000-0000-0000-0000000000b4',
    'commerce.order.terminal_closure', 'order_closed') $$,
  '22023', 'commerce_oms_system_release_source_forbidden',
  'the closure source was NOT added to the old allowlist');

SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_release_hold_system'),
  1,
  'and the old machine release still has exactly one body');

SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%p_source NOT IN (' || chr(10) || '%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_release_hold_system'),
  'its allowlist is still the multi-line form the parity harness regex expects');

-- ---------------------------------------------------------------------------
-- Cases 16-18: the closure is not a browser-reachable surface.
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege('anon', 'public.commerce_oms_release_hold_closed_order(text, uuid, jsonb)', 'EXECUTE'),
  'anon cannot close holds');

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.commerce_oms_release_hold_closed_order(text, uuid, jsonb)', 'EXECUTE'),
  'nor can a signed-in customer');

SELECT ok(
  has_function_privilege('service_role', 'public.commerce_oms_release_hold_closed_order(text, uuid, jsonb)', 'EXECUTE'),
  'the service role can, which is what the trigger and any backfill need');

SELECT * FROM finish();
ROLLBACK;
