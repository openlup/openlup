-- pgTAP: commerce_oms_admin_list_queue operator visibility + smart search.
--   Bug C: a real paid order that never created a fulfillment / reservation row
--          must still appear in the operator OMS list. The queue RPC is
--          order-centric (FROM commerce_orders, LEFT JOIN the projection tables),
--          so it must NOT exclude orders that lack a fulfillment / reservation.
--   Bug D: searching the queue by an order number (exact or partial, any case)
--          must return the matching order, and only the matching order.
--   Summary currency: the paid dashboard total must never add minor units
--          across currencies. A single-currency paid set keeps exactly the
--          numbers it produced before; a mixed one is refused by name; an empty
--          one reports a null currency, because the schema no longer names one.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(35);

-- One RPC name, one identity. A second identity used to survive here: the
-- 15-argument, all-defaults body superseded in July 2026 and never dropped,
-- which overload resolution preferred for every named-argument and short call.
-- 20260824075701_oms_queue_has_one_overload.sql removed it. These two
-- assertions are what keeps it removed: the first fails if any migration
-- re-introduces a second identity, the second fails if the identity that
-- survives is not the one the BFF calls.
-- 20260903190000 opened an expand/contract pair and briefly made this a pair of
-- identities on purpose; 20260904100000 closed it by dropping the superseded
-- 16-argument one once the bundle that calls 17 was promoted. The count is back
-- to an exact 1.
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue'),
  1, 'exactly one commerce_oms_admin_list_queue identity exists');

SELECT is(
  (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue'),
  'p_page integer, p_page_size integer, p_search text, p_status text, p_mode text, '
  || 'p_payment_status text, p_fulfillment_status text, p_inventory_status text, '
  || 'p_accounting_status text, p_provider_ops_status text, p_attention_reason text, '
  || 'p_attention_only boolean, p_next_action text, p_from text, p_to text, p_sort text, '
  || 'p_include_withdrawn boolean',
  'the surviving identity is the 17-argument one the BFF calls');

SELECT ok(
  (SELECT p.prosecdef FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue'),
  'the queue keeps SECURITY DEFINER after the arithmetic patch');

SELECT ok(
  (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue'),
  'the arithmetic patch preserves service-role-only execution');

SELECT ok(
  (SELECT p.proconfig @> ARRAY['search_path=public, pg_catalog']
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue'),
  'the queue keeps its fixed public and pg_catalog search path');

SELECT is(
  (SELECT length(definition) - length(replace(definition, '  v_offset integer;', ''))
     FROM (SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue') source),
  0,
  'the installed queue body no longer contains the integer offset declaration');

SELECT is(
  (SELECT (length(definition) - length(replace(definition, '  v_offset bigint;', '')))
          / length('  v_offset bigint;')
     FROM (SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue') source),
  1,
  'the installed queue body contains exactly one bigint offset declaration');

SELECT is(
  (SELECT length(definition) - length(replace(definition, '  v_offset := (v_page - 1) * v_page_size;', ''))
     FROM (SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue') source),
  0,
  'the installed queue body no longer contains the overflowing offset assignment');

SELECT is(
  (SELECT (length(definition) - length(replace(definition, '  v_offset := (v_page::bigint - 1) * v_page_size::bigint;', '')))
          / length('  v_offset := (v_page::bigint - 1) * v_page_size::bigint;')
     FROM (SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'commerce_oms_admin_list_queue') source),
  1,
  'the installed queue body contains exactly one bigint offset assignment');

INSERT INTO public.clients (id, email, first_name, last_name, phone)
VALUES ('42222222-2222-4222-8222-0000000000aa', 'Lukasz.Example@example.invalid', 'Łukasz', 'Żółć', '+48 123 456 789');

INSERT INTO public.pets (id, client_id, pet_type, name, breed)
VALUES ('42222222-2222-4222-8222-0000000000bb', '42222222-2222-4222-8222-0000000000aa', 'dog', 'Bąbel', 'Mix');

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('42222222-2222-4222-8222-0000000000dd', '42222222-2222-4222-8222-0000000000aa', 'shipping', 'Testowa 1', 'Łódź', '90-001', 'PL');

-- A paid one-time order with NO fulfillment order and NO inventory reservation.
INSERT INTO public.commerce_orders (id, client_id, pet_id, shipping_address_id, order_number, status, mode, currency)
VALUES ('42222222-2222-4222-8222-0000000000c1', '42222222-2222-4222-8222-0000000000aa',
        '42222222-2222-4222-8222-0000000000bb', '42222222-2222-4222-8222-0000000000dd',
        'OPENLUP-PGTAPC1', 'paid', 'one_time', 'PLN');

-- A second paid order, used as a negative control for the order-number search.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency)
VALUES ('42222222-2222-4222-8222-0000000000c2', '42222222-2222-4222-8222-0000000000aa',
        'OPENLUP-PGTAPC2', 'paid', 'one_time', 'PLN');

-- Sanity: the order under test genuinely has no fulfillment projection row.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_fulfillment_orders
     WHERE order_id = '42222222-2222-4222-8222-0000000000c1'),
  0, 'the paid order under test has no fulfillment order row');

-- Every call below is FULLY POSITIONAL with all 17 arguments. The sole
-- surviving overload declares no parameter defaults, so a named or short call
-- is now an error rather than a silent hit on the superseded 15-argument body
-- that used to answer it. Positional calls keep that guarantee independent of
-- overload resolution. The argument order is the one declared by the live
-- definition, forward-patched by
-- 20260906103000_oms_queue_safe_arithmetic.sql:
--   page, page_size, search, status, mode, payment_status, fulfillment_status,
--   inventory_status, accounting_status, provider_ops_status, attention_reason,
--   attention_only, next_action, from, to, sort, include_withdrawn.
-- NULL is the no-filter value for every text filter (the body tests
-- `p_x IS NULL OR ...`), false the no-filter value for `p_attention_only`, and
-- 'created_desc' the previous default sort. `false` for p_include_withdrawn is
-- the DEFAULT operator view: withdrawn checkout rows are hidden.

-- Bug C: the unfiltered operator queue includes the paid order even though it
-- has no fulfillment / reservation. The seeded orders are the newest rows
-- (created_at defaults to now()), so the first page lists them; the page size is
-- maxed to stay robust against any baseline seed volume.
SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 100, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'unfiltered queue lists the paid order with no fulfillment (Bug C)');

-- The request contract admits every positive `integer` page. The largest value
-- combined with the established page-size maximum used to overflow the local
-- offset before the query ran; it must now remain a defined, empty deep page
-- without adding a PAGE-BOUND rejection.
SELECT is(
  jsonb_array_length(
    public.commerce_oms_admin_list_queue(
      2147483647, 100, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds'
  ),
  0,
  'largest accepted positive page returns an empty page without arithmetic overflow');

-- Bug D: exact order-number search returns the matching order...
SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'OPENLUP-PGTAPC1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'exact order-number search returns the matching order (Bug D)');

-- ...and only that order (the negative control is excluded)...
SELECT ok(
  NOT ((public.commerce_oms_admin_list_queue(
     1, 25, 'OPENLUP-PGTAPC1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c2'::text)),
  'exact order-number search excludes non-matching orders');

-- ...and reports exactly one match in the total count.
SELECT is(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'OPENLUP-PGTAPC1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) ->> 'totalCount')::int,
  1, 'exact order-number search reports a single match');

-- Bug D: case-insensitive / partial order-number search also matches.
SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'openlup-pgtapc1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'case-insensitive order-number search returns the matching order');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'pgtapc1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'partial order-number search returns the matching order');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'velipgtapc1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'normalized order-number search ignores separators');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'lukasz.example@EXAMPLE.invalid', NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'email search is case-insensitive and normalized');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, '123456789', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'phone search matches normalized digits');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'lukasz', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'customer search removes Polish diacritics');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'babel', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     false, NULL, NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000c1'::text),
  'pet search removes Polish diacritics');

-- A search token that matches nothing returns no orders.
SELECT is(
  (public.commerce_oms_admin_list_queue(
     1, 25, 'ZZZ-NO-SUCH-ORDER', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, false, NULL, NULL, NULL, 'created_desc', false) ->> 'totalCount')::int,
  0, 'a non-matching search token returns zero orders');

-- Summary-currency fixtures.
--
-- `paid_summary` is global over the status/mode scope, not over the page, so an
-- assertion on exact totals would otherwise race whatever the baseline seed
-- contains. The paid-at window (payment intent `updated_at`) is the only filter
-- that reaches it, so these rows are settled far in the future and every
-- assertion below names its own window. The three orders here carry no
-- fulfillment or reservation rows for the same reason as Bug C above: the
-- summary is computed from orders plus their latest payment intent.
--
-- Two of them take the column-default currency; the third names a different one
-- on purpose. That is the only difference the guard is allowed to notice.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, subtotal_cents, total_cents)
VALUES ('42222222-2222-4222-8222-0000000000e1', '42222222-2222-4222-8222-0000000000aa',
        'PGTAPSUM1', 'paid', 'one_time', 10000, 10000),
       ('42222222-2222-4222-8222-0000000000e2', '42222222-2222-4222-8222-0000000000aa',
        'PGTAPSUM2', 'paid', 'one_time', 20500, 20500);

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, subtotal_cents, total_cents, currency)
VALUES ('42222222-2222-4222-8222-0000000000e3', '42222222-2222-4222-8222-0000000000aa',
        'PGTAPSUM3', 'paid', 'one_time', 30000, 30000, 'EUR');

INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents)
VALUES ('42222222-2222-4222-8222-0000000000f1', '42222222-2222-4222-8222-0000000000e1',
        'simulator', 'pgtap-sum-1', 'succeeded', 10000),
       ('42222222-2222-4222-8222-0000000000f2', '42222222-2222-4222-8222-0000000000e2',
        'simulator', 'pgtap-sum-2', 'succeeded', 20500),
       ('42222222-2222-4222-8222-0000000000f3', '42222222-2222-4222-8222-0000000000e3',
        'simulator', 'pgtap-sum-3', 'succeeded', 30000);

INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, updated_at
) VALUES
  ('42222222-2222-4222-8222-000000000f11', 'one_time_order',
   '42222222-2222-4222-8222-0000000000e1', '42222222-2222-4222-8222-0000000000f1',
   'succeeded', 10000, '2099-01-01T10:00:00Z'),
  ('42222222-2222-4222-8222-000000000f12', 'one_time_order',
   '42222222-2222-4222-8222-0000000000e2', '42222222-2222-4222-8222-0000000000f2',
   'succeeded', 20500, '2099-01-01T11:00:00Z'),
  ('42222222-2222-4222-8222-000000000f13', 'one_time_order',
   '42222222-2222-4222-8222-0000000000e3', '42222222-2222-4222-8222-0000000000f3',
   'succeeded', 30000, '2099-06-01T10:00:00Z');

-- The one surviving overload declares no parameter defaults, so every call
-- below is fully positional to pin the function under test by its own
-- signature rather than lean on there being only one candidate.
CREATE FUNCTION pg_temp.oms_queue_summary_totals(p_from text, p_to text)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT public.commerce_oms_admin_list_queue(
    1, 100, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
    p_from, p_to, 'created_desc'
  , false) -> 'summaryTotals';
$fn$;

-- A single-currency paid window: the numbers are exactly the ones this RPC
-- produced before the guard existed (sum of the paid totals, and the sum
-- divided by the order count), and the currency is the one the orders carry.
SELECT is(
  (pg_temp.oms_queue_summary_totals('2098-12-31T00:00:00Z', '2099-01-02T00:00:00Z')
     -> 'gmv' ->> 'amountMinor')::bigint,
  30500::bigint, 'single-currency GMV still sums the paid totals unchanged');

SELECT is(
  (pg_temp.oms_queue_summary_totals('2098-12-31T00:00:00Z', '2099-01-02T00:00:00Z')
     -> 'aov' ->> 'amountMinor')::bigint,
  15250::bigint, 'single-currency AOV still divides that sum by the order count');

SELECT is(
  (pg_temp.oms_queue_summary_totals('2098-12-31T00:00:00Z', '2099-01-02T00:00:00Z')
     ->> 'orderCount')::int,
  2, 'the single-currency window counts both paid orders');

SELECT is(
  pg_temp.oms_queue_summary_totals('2098-12-31T00:00:00Z', '2099-01-02T00:00:00Z')
    -> 'gmv' ->> 'currency',
  (SELECT currency FROM public.commerce_orders
    WHERE id = '42222222-2222-4222-8222-0000000000e1'),
  'the summary reports the currency the paid orders actually carry');

-- Widening the window to include the differently-priced order makes the total
-- meaningless. The RPC refuses by name instead of returning a mixed sum.
SELECT throws_ok(
  $$SELECT pg_temp.oms_queue_summary_totals('2098-12-31T00:00:00Z', NULL)$$,
  '22023',
  'commerce_oms_summary_mixed_currency',
  'a paid set spanning two currencies is refused, not summed');

-- An empty paid window reports no currency at all: the migration no longer
-- substitutes a literal, and the platform default is applied by the caller.
SELECT is(
  pg_temp.oms_queue_summary_totals('2100-01-01T00:00:00Z', NULL) -> 'gmv' -> 'currency',
  'null'::jsonb,
  'an empty paid set reports a null currency instead of a hard-coded one');

-- ---- Withdrawn checkout rows (20260903190000) --------------------------------
-- Every call below scopes p_status to 'cancelled'. That is not incidental: this
-- suite seeds a paid order in a second currency above, so from that point on any
-- UNFILTERED call legitimately raises commerce_oms_summary_mixed_currency -- the
-- single-currency refusal doing its job. Scoping to 'cancelled' leaves the paid
-- set empty, which is also exactly the scope withdrawn rows live in. The
-- predicate itself sits in scoped_orders and applies whatever p_status is.
--
-- W1 superseded, W2 orphan journey-consumed draft: both are the cancelled
-- residue of one declined-then-retried journey and both are hidden by default.
-- Both are seeded `one_time` because `mode` is NOT part of the predicate, which
-- keys on status, marker and captured payment only. In production a superseded
-- row is usually `subscription_cycle`; seeding that here would require a whole
-- subscription and cycle chain to satisfy
-- commerce_orders_subscription_cycle_mode_check, for a column the filter never
-- reads.
-- W3 carries the same marker AND a captured payment: it must stay visible, which
-- is the fail-closed clause of the predicate.
-- order_number carries no brand prefix and currency is left to its column
-- default here: neither is read by the predicate, and both are counted surfaces
-- for the OSS vocabulary ratchet.
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, metadata)
VALUES ('42222222-2222-4222-8222-0000000000f1', '42222222-2222-4222-8222-0000000000aa',
        'PGTAPW1', 'cancelled', 'one_time',
        jsonb_build_object('supersededByStableJourneyKey', true)),
       ('42222222-2222-4222-8222-0000000000f2', '42222222-2222-4222-8222-0000000000aa',
        'PGTAPW2', 'cancelled', 'one_time',
        jsonb_build_object('checkoutAbandoned', 'checkout_journey_consumed')),
       ('42222222-2222-4222-8222-0000000000f3', '42222222-2222-4222-8222-0000000000aa',
        'PGTAPW3', 'cancelled', 'one_time',
        jsonb_build_object('supersededByStableJourneyKey', true));

INSERT INTO public.commerce_payments (order_id, provider, amount_cents, status)
VALUES ('42222222-2222-4222-8222-0000000000f3', 'tpay', 1990, 'succeeded');

SELECT ok(
  NOT ((public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000f1'::text)),
  'default view hides a superseded checkout row');

SELECT ok(
  NOT ((public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000f2'::text)),
  'default view hides an orphan journey-consumed draft');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', true) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000f1'::text),
  'include_withdrawn brings the superseded row back');

SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', true) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000f2'::text),
  'include_withdrawn brings the orphan draft back');

-- FAIL-CLOSED. The marker alone must never hide money.
SELECT ok(
  (public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', false) -> 'orderIds')
    @> to_jsonb('42222222-2222-4222-8222-0000000000f3'::text),
  'a withdrawn-marked order with a captured payment stays visible by default');

-- totalCount must agree with the rows: the counter reads FROM filtered, which is
-- downstream of the scoped_orders predicate, so a hidden row is not counted.
SELECT is(
  ((public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', true) ->> 'totalCount')::int)
  - ((public.commerce_oms_admin_list_queue(
     1, 100, NULL, 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL,
     NULL, NULL, 'created_desc', false) ->> 'totalCount')::int),
  2, 'totalCount drops by exactly the two hidden rows when they are excluded');

SELECT * FROM finish();
ROLLBACK;
