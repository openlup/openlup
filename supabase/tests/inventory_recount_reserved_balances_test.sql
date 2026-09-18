-- pgTAP: public.inventory_recount_reserved_balances (20260916075046).
--   * the dry run (the zero-argument call) reports drift and writes nothing;
--   * apply writes the sum of ALL status='reserved' rows, not the narrower
--     unexpired sum the drift watchdog compares against — a lapsed lease keeps
--     its weight, because release/consume/expire will each take it back out and
--     a narrower recount would let them decrement it twice;
--   * a balance that already agrees is neither reported nor touched;
--   * released / consumed / expired rows contribute nothing;
--   * a counter carrying weight no surviving row accounts for — the staging drift
--     shape, where the rows were deleted out from under it — is recounted down to
--     what its rows actually say, including all the way to zero;
--   * a recount that would push reserved above on_hand is reported as blocked by
--     the dry run and refuses the WHOLE apply, writing nothing anywhere;
--   * the apply's reported evidence equals the post-apply rows, which is what a
--     single locked evaluation buys and two evaluations would not;
--   * EXECUTE is service_role-only on the public routine and owner-only on the
--     private projection, asserted by effective privilege;
--   * the production fingerprint refuses the call outright, dry run included.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(25);

INSERT INTO public.clients (id, email)
VALUES ('b1000000-0000-4000-8000-000000000001', 'inventory-recount@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES
  ('b2000000-0000-4000-8000-000000000001', 'recount-alpha', 'Recount Alpha', 'active'),
  ('b2000000-0000-4000-8000-000000000002', 'recount-beta', 'Recount Beta', 'active'),
  ('b2000000-0000-4000-8000-000000000003', 'recount-gamma', 'Recount Gamma', 'active'),
  ('b2000000-0000-4000-8000-000000000004', 'recount-delta', 'Recount Delta', 'active');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'RECOUNT-ALPHA', 'Recount Alpha', 'other', 'active', 1, 1),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'RECOUNT-BETA', 'Recount Beta', 'other', 'active', 1, 1),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000003', 'RECOUNT-GAMMA', 'Recount Gamma', 'other', 'active', 1, 1),
  ('b3000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000004', 'RECOUNT-DELTA', 'Recount Delta', 'other', 'active', 1, 1);

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES ('b4000000-0000-4000-8000-000000000001', 'recount', 'Recount', 'virtual', 'active', true);

-- ALPHA: the staging shape plus a lapsed lease. The counter says 20; the rows say
-- 3 pinned + 2 lapsed = 5 still 'reserved'. The other 15 belonged to rows that were
-- deleted without release and can never be reclaimed by any RPC.
-- BETA: already correct (2 reserved rows summing to 4) — must not be reported.
-- GAMMA: counter 6, and every row is terminal — released / consumed / expired
--        contribute nothing, so the truth is 0.
-- DELTA: counter 1, rows sum to 9, on_hand 5 — recounting it would break
--        inventory_balances_reserved_check, so it blocks the whole apply.
INSERT INTO public.inventory_balances (id, sku_id, location_id, on_hand, reserved)
VALUES
  ('b5000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 40, 20),
  ('b5000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000001', 40, 4),
  ('b5000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000001', 40, 6),
  ('b5000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000001', 5, 1);

-- `currency` is omitted deliberately: the column carries the deployment default, so
-- naming it here would pin a currency literal into a test that is not about money.
INSERT INTO public.commerce_orders (id, client_id, status, region_code, mode, size_constraint, total_cents, subtotal_cents)
VALUES ('b6000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
        'paid', 'PL', 'one_time', '{"kind":"unit_count","value":1}'::jsonb, 1000, 1000);

INSERT INTO public.inventory_reservations (
  id, idempotency_key, order_id, sku_id, location_id, quantity, status, kind, expires_at, released_at, consumed_at
) VALUES
  -- ALPHA: 3 pinned (paid) + 2 lapsed but still 'reserved'.
  ('b7000000-0000-4000-8000-000000000001', 'recount-alpha-pinned', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 3, 'reserved', 'checkout_payment_window', NULL, NULL, NULL),
  ('b7000000-0000-4000-8000-000000000002', 'recount-alpha-lapsed', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 2, 'reserved', 'checkout_payment_window', now() - interval '1 day', NULL, NULL),
  -- BETA: already reconciled.
  ('b7000000-0000-4000-8000-000000000003', 'recount-beta-one', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000001', 1, 'reserved', 'checkout_payment_window', NULL, NULL, NULL),
  ('b7000000-0000-4000-8000-000000000004', 'recount-beta-two', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000001', 3, 'reserved', 'checkout_payment_window', NULL, NULL, NULL),
  -- GAMMA: terminal rows only. Each of these already decremented the counter once.
  ('b7000000-0000-4000-8000-000000000005', 'recount-gamma-released', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000001', 2, 'released', 'checkout_payment_window', NULL, now(), NULL),
  ('b7000000-0000-4000-8000-000000000006', 'recount-gamma-consumed', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000001', 2, 'consumed', 'checkout_payment_window', NULL, NULL, now()),
  ('b7000000-0000-4000-8000-000000000007', 'recount-gamma-expired', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000001', 2, 'expired', 'checkout_payment_window', now() - interval '2 days', NULL, NULL),
  -- DELTA: 9 reserved units against on_hand 5.
  ('b7000000-0000-4000-8000-000000000008', 'recount-delta-over', 'b6000000-0000-4000-8000-000000000001',
   'b3000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000001', 9, 'reserved', 'checkout_payment_window', NULL, NULL, NULL);

-- ---------------------------------------------------------------- dry run ----
CREATE TEMP TABLE _dry AS SELECT public.inventory_recount_reserved_balances() AS result;

SELECT is((SELECT (result ->> 'applied')::boolean FROM _dry), false,
  'the zero-argument call is a dry run');
SELECT is((SELECT (result ->> 'driftedBalances')::int FROM _dry), 3,
  'dry run reports every drifted balance and only those');
SELECT is((SELECT (result ->> 'updatedBalances')::int FROM _dry), 0,
  'dry run updates nothing');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id = 'b5000000-0000-4000-8000-000000000001'),
  20, 'dry run leaves the drifted counter exactly as it found it');
SELECT is((
  SELECT (entry ->> 'expectedReserved')::int
    FROM _dry, jsonb_array_elements(result -> 'evidence') entry
   WHERE entry ->> 'balanceId' = 'b5000000-0000-4000-8000-000000000001'
), 5, 'the recounted value sums every status=reserved row, lapsed leases included');
SELECT is((
  SELECT (entry ->> 'activeReserved')::int
    FROM _dry, jsonb_array_elements(result -> 'evidence') entry
   WHERE entry ->> 'balanceId' = 'b5000000-0000-4000-8000-000000000001'
), 3, 'the report also carries the narrower active sum the drift watchdog uses');
SELECT is((
  SELECT count(*)::int
    FROM _dry, jsonb_array_elements(result -> 'evidence') entry
   WHERE entry ->> 'balanceId' = 'b5000000-0000-4000-8000-000000000002'
), 0, 'a balance that already agrees is not reported as drifted');
SELECT is((
  SELECT (entry ->> 'expectedReserved')::int
    FROM _dry, jsonb_array_elements(result -> 'evidence') entry
   WHERE entry ->> 'balanceId' = 'b5000000-0000-4000-8000-000000000003'
), 0, 'released, consumed and expired rows carry no counter weight');
SELECT is((SELECT result -> 'blockedBalanceIds' FROM _dry),
  '["b5000000-0000-4000-8000-000000000004"]'::jsonb,
  'dry run names the balance whose recount would exceed on_hand');

-- --------------------------------------------- apply refuses all or nothing ---
SELECT throws_ok(
  $$SELECT public.inventory_recount_reserved_balances(true)$$,
  '23514', NULL,
  'apply refuses the whole call while any recount would exceed on_hand');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id = 'b5000000-0000-4000-8000-000000000001'),
  20, 'the refused apply wrote nothing, not even the repairable balances');

-- Remove the impossible row the way an operator would: fix the stock, not the counter.
UPDATE public.inventory_balances SET on_hand = 9 WHERE id = 'b5000000-0000-4000-8000-000000000004';

-- ------------------------------------------------------------------ apply ----
CREATE TEMP TABLE _applied AS SELECT public.inventory_recount_reserved_balances(true) AS result;

SELECT is((SELECT (result ->> 'updatedBalances')::int FROM _applied), 3,
  'apply writes every drifted balance and leaves the agreeing one alone');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id = 'b5000000-0000-4000-8000-000000000001'),
  5, 'apply recounts the stranded counter down to its live rows');
SELECT is((SELECT reserved FROM public.inventory_balances WHERE id = 'b5000000-0000-4000-8000-000000000003'),
  0, 'apply clears a counter whose reservations are all terminal');

-- The report IS the write. The apply locks the balance rows and then evaluates the
-- target projection exactly once and hands that one snapshot to the blocked check,
-- the evidence and the UPDATE alike. Re-evaluating per consumer would let a reserve
-- committing mid-call be reported as one number and written as another, so assert
-- every reported `expectedReserved` against the row's actual post-apply `reserved`.
SELECT is((
  SELECT count(*)::int
    FROM _applied, jsonb_array_elements(result -> 'evidence') entry
    JOIN public.inventory_balances b ON b.id = (entry ->> 'balanceId')::uuid
   WHERE b.reserved = (entry ->> 'expectedReserved')::int
), (SELECT (result ->> 'updatedBalances')::int FROM _applied),
  'every reported expectedReserved equals the post-apply reserved: one evaluation, not two');

-- Idempotent: a second apply finds nothing left to do.
SELECT is((
  SELECT (public.inventory_recount_reserved_balances(true) ->> 'driftedBalances')::int
), 0, 're-running the recount finds no drift and changes nothing');

-- ------------------------------------------------------------- privileges ----
-- Effective privilege, asserted rather than assumed. `has_function_privilege` is used
-- instead of `SET ROLE` on purpose: `SET ROLE authenticated` segfaulted the backend in
-- the local Supabase image during review, and this asks the same question without
-- entering the role.
SELECT ok(has_function_privilege('service_role',
  'public.inventory_recount_reserved_balances(boolean)', 'EXECUTE'),
  'service_role can execute the operator recount');
SELECT ok(NOT has_function_privilege('anon',
  'public.inventory_recount_reserved_balances(boolean)', 'EXECUTE'),
  'anon cannot execute the operator recount');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.inventory_recount_reserved_balances(boolean)', 'EXECUTE'),
  'authenticated cannot execute the operator recount');
SELECT ok(NOT has_function_privilege('authenticator',
  'public.inventory_recount_reserved_balances(boolean)', 'EXECUTE'),
  'authenticator cannot execute the operator recount');

SELECT ok(has_function_privilege('postgres',
  'private.inventory_reserved_balance_recount_targets(timestamptz)', 'EXECUTE'),
  'the definer owner can execute the private projection');
SELECT ok(NOT has_function_privilege('service_role',
  'private.inventory_reserved_balance_recount_targets(timestamptz)', 'EXECUTE'),
  'service_role cannot reach the private projection directly');
SELECT ok(NOT has_function_privilege('anon',
  'private.inventory_reserved_balance_recount_targets(timestamptz)', 'EXECUTE'),
  'anon cannot reach the private projection');
SELECT ok(NOT has_function_privilege('authenticated',
  'private.inventory_reserved_balance_recount_targets(timestamptz)', 'EXECUTE'),
  'authenticated cannot reach the private projection');

-- ------------------------------------------------- production fingerprint ----
UPDATE private.platform_cron_environment
SET expected_system_identifier = (pg_control_system()).system_identifier::text,
    expected_server_addr = inet_server_addr(),
    expected_server_port = inet_server_port()
WHERE id = true;

SELECT throws_ok(
  $$SELECT public.inventory_recount_reserved_balances()$$,
  '42501', 'inventory_recount_reserved_balances_forbidden_in_production',
  'the production fingerprint refuses even the read-only dry run');

SELECT * FROM finish();
ROLLBACK;
