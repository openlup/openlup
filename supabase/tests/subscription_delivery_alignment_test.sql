-- pgTAP: durable delivery-aware renewal admission and schedule alignment.
--
-- This is intentionally SQL-first: it proves the committed pre-artifact
-- admission and the independent cycle-insert race guard. It never asks a
-- payment provider to run, and it asserts that dunning/provider-attempt facts
-- retain their existing authority.

BEGIN;
-- The local test runner supplies this extension; the staging pre-alias canary runs the
-- same file against a hosted database that does not have it, so `plan(63)` cannot
-- resolve there. Creating it here is transactional like the rest of this file, so the
-- ROLLBACK below removes it again and no environment keeps an extension that no
-- migration declares.
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(100);

INSERT INTO public.clients (id, email)
VALUES ('c1000000-0000-4000-8000-000000000001', 'delivery-alignment@example.invalid');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES ('c1100000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
        'shipping', 'Testowa 1', 'Warszawa', '00-001', 'PL');

-- 14 / 21 / 28, starter delivery 2, on-time, pause, cancellation, dunning,
-- already-created, provider-attempt, split and missing-fulfillment fixtures,
-- then four case-exit fixtures. The exit fixtures deliberately carry a past
-- next_cycle_at: the confirmation path measures from now(), so a 2030 schedule
-- would swallow the shift under its own one-way GREATEST rule and prove nothing.
-- The already-later fixture keeps a far-future schedule for exactly that reason.
INSERT INTO public.subscriptions (
  id, client_id, shipping_address_id, cadence_days, currency, status,
  next_cycle_at, payment_method_ref, payment_method_kind, starter_pack
)
SELECT fixture.id::uuid, fixture.client_id::uuid, fixture.address_id::uuid,
       fixture.cadence_days, 'PLN', 'active', fixture.next_cycle_at::timestamptz,
       fixture.payment_method_ref, 'card', fixture.starter_pack::jsonb
  FROM (VALUES
    ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-01-10T00:00:00Z', 'pm-14', NULL),
    ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 21, '2030-02-10T00:00:00Z', 'pm-21', NULL),
    ('c2000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 28, '2030-03-31T00:00:00Z', 'pm-28', NULL),
    ('c2000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-04-10T00:00:00Z', 'pm-starter', '{"schemaVersion":"1"}'),
    ('c2000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-05-10T00:00:00Z', 'pm-ontime', NULL),
    ('c2000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-06-10T00:00:00Z', 'pm-paused', NULL),
    ('c2000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-07-10T00:00:00Z', 'pm-cancelled', NULL),
    ('c2000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-08-10T00:00:00Z', 'pm-dunning', NULL),
    ('c2000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-09-10T00:00:00Z', 'pm-created', NULL),
    ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-10-10T00:00:00Z', 'pm-attempt', NULL),
    ('c2000000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-11-10T00:00:00Z', 'pm-split', NULL),
    ('c2000000-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2030-12-10T00:00:00Z', 'pm-missing', NULL),
    ('c2000000-0000-4000-8000-00000000000d', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2020-01-10T00:00:00Z', 'pm-replacement', NULL),
    ('c2000000-0000-4000-8000-00000000000e', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2099-01-10T00:00:00Z', 'pm-already-later', NULL),
    ('c2000000-0000-4000-8000-00000000000f', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2020-03-10T00:00:00Z', 'pm-strand', NULL),
    ('c2000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2020-04-10T00:00:00Z', 'pm-ended', NULL),
    ('c2000000-0000-4000-8000-000000000011', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2032-01-10T00:00:00Z', 'pm-replacement-arrived', NULL),
    ('c2000000-0000-4000-8000-000000000012', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2032-03-10T00:00:00Z', 'pm-replacement-in-flight', NULL),
    ('c2000000-0000-4000-8000-000000000013', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 14, '2032-04-10T00:00:00Z', 'pm-replacement-before-admission', NULL)
  ) AS fixture(id, client_id, address_id, cadence_days, next_cycle_at, payment_method_ref, starter_pack);

-- Later payment_pending successor rows must use the current locked template,
-- exactly as the renewal runtime does. These fixtures intentionally exercise
-- the delivery-alignment guard rather than bypassing the pre-existing snapshot
-- guard with line-less synthetic subscriptions.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('c1200000-0000-4000-8000-000000000001', 'delivery-alignment-product', 'Delivery alignment product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('c1300000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001', 'DELIVERY-ALIGNMENT-SKU', 'Delivery alignment SKU', 'dog', 'active', 400, 350);
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT
  ('c1400000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('c2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  'c1300000-0000-4000-8000-000000000001'::uuid,
  1, 0, false, 1
FROM generate_series(1, 19) AS n;

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key
)
SELECT
  ('c3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('c2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  1, ('2030-01-01T00:00:00Z'::timestamptz + (n || ' days')::interval),
  'paid', '2030-01-01T00:00:00Z', 'delivery-alignment-paid-' || n::text
FROM generate_series(1, 19) AS n;

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, status, subtotal_cents, total_cents,
  mode, subscription_id, subscription_cycle_id
)
SELECT
  ('c4000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'c1100000-0000-4000-8000-000000000001'::uuid,
  'paid', 1000, 1000, 'subscription_cycle',
  ('c2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('c3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid
FROM generate_series(1, 19) AS n;

UPDATE public.subscription_cycles c
   SET order_id = ('c4000000-0000-4000-8000-' || lpad(to_hex(c.cycle_number + suffix.n - 1), 12, '0'))::uuid
  FROM (
    SELECT id, row_number() OVER (ORDER BY id)::integer AS n
      FROM public.subscription_cycles
     WHERE id::text LIKE 'c3000000-%'
  ) suffix
 WHERE c.id = suffix.id;

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot
)
SELECT
  ('c5000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('c4000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'c1100000-0000-4000-8000-000000000001'::uuid,
  'delivery-alignment-fo-' || n::text, 'in_transit', '{}'::jsonb
FROM generate_series(1, 11) AS n;
-- Fixture 12 keeps no fulfillment row (the missing-fulfillment case), so the
-- exit and replacement fixtures get their own undelivered parcels rather than
-- widening the range.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot
)
SELECT
  ('c5000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  ('c4000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'c1100000-0000-4000-8000-000000000001'::uuid,
  'delivery-alignment-fo-' || n::text, 'in_transit', '{}'::jsonb
FROM generate_series(13, 19) AS n;

SELECT is(public.subscription_delivery_alignment_get_mode(), 'auto_align', 'full migration chain activates auto-align');
SELECT ok(
  has_function_privilege('service_role', 'public.subscription_delivery_alignment_get_mode()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.subscription_delivery_alignment_set_mode(text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.subscription_delivery_alignment_resolve_case(uuid,text,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.subscription_delivery_alignment_admit_renewal(uuid,timestamptz,timestamptz)', 'EXECUTE'),
  'service role alone receives the alignment control and admission entrypoints'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.subscription_delivery_alignment_get_mode()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.subscription_delivery_alignment_get_mode()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.subscription_delivery_alignment_set_mode(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.subscription_delivery_alignment_set_mode(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.subscription_delivery_alignment_resolve_case(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.subscription_delivery_alignment_resolve_case(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.subscription_delivery_alignment_admit_renewal(uuid,timestamptz,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.subscription_delivery_alignment_admit_renewal(uuid,timestamptz,timestamptz)', 'EXECUTE'),
  'browser roles cannot invoke alignment control or admission'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_delivery_alignment_control'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_delivery_alignment_cases'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_delivery_alignment_admission_receipts'::regclass),
  'alignment control, ledger and receipt tables all enforce RLS'
);
SELECT ok(
  has_table_privilege('service_role', 'public.subscription_delivery_alignment_control', 'SELECT')
  AND has_table_privilege('service_role', 'public.subscription_delivery_alignment_cases', 'SELECT'),
  'service role can read alignment control and durable ledger facts'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.subscription_delivery_alignment_control', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscription_delivery_alignment_control', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.subscription_delivery_alignment_cases', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscription_delivery_alignment_cases', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.subscription_delivery_alignment_admission_receipts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscription_delivery_alignment_admission_receipts', 'SELECT'),
  'browser roles cannot read alignment control, ledger or receipt facts'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('subscription_delivery_alignment_control', 'subscription_delivery_alignment_cases', 'subscription_delivery_alignment_admission_receipts')
      AND roles && ARRAY['public', 'anon', 'authenticated']::name[]),
  0,
  'alignment control and ledger expose no browser RLS policy'
);
SELECT ok(
  strpos(
    pg_get_functiondef('public.subscription_delivery_alignment_on_delivery()'::regprocedure),
    E'WHERE id = v_order.subscription_id\n   FOR UPDATE;'
  )
  < strpos(
    pg_get_functiondef('public.subscription_delivery_alignment_on_delivery()'::regprocedure),
    E'WHERE fulfillment_order_id = NEW.id\n   FOR UPDATE;'
  ),
  'delivery locks subscription before its ledger case, matching renewal admission'
);
-- Exercise the real two-session interleave rather than relying only on the
-- source-order proof above. Admission owns the aggregate lock while delivery
-- arrives; delivery must wait on that same root, then align the just-opened
-- case after admission commits. The dblink fixture is self-cleaning because
-- it is outside this test transaction.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'delivery_alignment_admission_race',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'delivery_alignment_delivery_race',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_exec('delivery_alignment_admission_race', $setup$
DO $do$
BEGIN
  DELETE FROM public.subscription_delivery_alignment_cases
   WHERE subscription_id = 'd2000000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_delivery_alignment_admission_receipts
   WHERE subscription_id = 'd2000000-0000-4000-8000-000000000001';
  UPDATE public.subscription_cycles
     SET order_id = NULL
   WHERE id = 'd3000000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_fulfillment_orders
   WHERE id = 'd5000000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_orders
   WHERE id = 'd4000000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_cycles
   WHERE id = 'd3000000-0000-4000-8000-000000000001';
  DELETE FROM public.subscriptions
   WHERE id = 'd2000000-0000-4000-8000-000000000001';
  DELETE FROM public.addresses
   WHERE id = 'd1100000-0000-4000-8000-000000000001';
  DELETE FROM public.clients
   WHERE id = 'd1000000-0000-4000-8000-000000000001';

  INSERT INTO public.clients (id, email)
  VALUES ('d1000000-0000-4000-8000-000000000001', 'delivery-alignment-race@example.invalid');
  INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
  VALUES ('d1100000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
          'shipping', 'Race 1', 'Warszawa', '00-001', 'PL');
  INSERT INTO public.subscriptions (
    id, client_id, shipping_address_id, cadence_days, currency, status,
    next_cycle_at, payment_method_ref, payment_method_kind
  ) VALUES (
    'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000001', 14, 'PLN', 'active',
    '2031-01-10T00:00:00Z', 'pm-race', 'card'
  );
  INSERT INTO public.subscription_cycles (
    id, subscription_id, cycle_number, scheduled_at, status, paid_at, engine_idempotency_key
  ) VALUES (
    'd3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
    1, '2030-12-27T00:00:00Z', 'paid', '2030-12-27T00:00:00Z', 'delivery-alignment-race-paid'
  );
  INSERT INTO public.commerce_orders (
    id, client_id, shipping_address_id, status, subtotal_cents, total_cents,
    mode, subscription_id, subscription_cycle_id
  ) VALUES (
    'd4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000001', 'paid', 1000, 1000,
    'subscription_cycle', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001'
  );
  UPDATE public.subscription_cycles
     SET order_id = 'd4000000-0000-4000-8000-000000000001'
   WHERE id = 'd3000000-0000-4000-8000-000000000001';
  INSERT INTO public.commerce_fulfillment_orders (
    id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot
  ) VALUES (
    'd5000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001',
    'delivery-alignment-race-fulfillment', 'in_transit', '{}'::jsonb
  );
  UPDATE public.subscription_delivery_alignment_control
     SET mode = 'auto_align'
   WHERE singleton;
END
$do$;

$setup$);
SELECT extensions.dblink_exec('delivery_alignment_delivery_race', $delivery_helper$
CREATE OR REPLACE FUNCTION pg_temp.try_delivery_while_admission_holds()
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  SET LOCAL lock_timeout = '100ms';
  UPDATE public.commerce_fulfillment_orders
     SET delivered_at = '2031-01-11T00:00:00Z'
   WHERE id = 'd5000000-0000-4000-8000-000000000001';
  RETURN 'unexpected_delivery';
EXCEPTION WHEN lock_not_available THEN
  RETURN 'blocked_on_subscription';
END
$function$;
$delivery_helper$);
SELECT extensions.dblink_exec('delivery_alignment_admission_race', 'BEGIN');
SELECT extensions.dblink_exec('delivery_alignment_admission_race', $admit$
DO $do$
BEGIN
  PERFORM public.subscription_delivery_alignment_admit_renewal(
    'd2000000-0000-4000-8000-000000000001',
    '2031-01-10T00:00:00Z',
    '2031-01-11T00:00:00Z'
  );
END
$do$;
$admit$);
SELECT extensions.dblink_send_query(
  'delivery_alignment_delivery_race',
  'SELECT pg_temp.try_delivery_while_admission_holds() AS outcome'
);
SELECT is(
  (SELECT outcome FROM extensions.dblink_get_result('delivery_alignment_delivery_race') AS response(outcome text)),
  'blocked_on_subscription',
  'delivery webhook waits at the subscription fence while admission holds its uncommitted ledger case'
);
SELECT count(*)
  FROM extensions.dblink_get_result('delivery_alignment_delivery_race') AS drained(outcome text);
SELECT is(
  (SELECT delivered_at IS NULL FROM public.commerce_fulfillment_orders
    WHERE id = 'd5000000-0000-4000-8000-000000000001'),
  true,
  'timed-out delivery leaves no partial trusted-delivery write'
);
SELECT extensions.dblink_exec('delivery_alignment_admission_race', 'COMMIT');
SELECT extensions.dblink_send_query(
  'delivery_alignment_delivery_race',
  $$UPDATE public.commerce_fulfillment_orders
       SET delivered_at = '2031-01-11T00:00:00Z'
     WHERE id = 'd5000000-0000-4000-8000-000000000001'
     RETURNING 'delivered'::text AS outcome$$
);
SELECT is(
  (SELECT outcome FROM extensions.dblink_get_result('delivery_alignment_delivery_race') AS response(outcome text)),
  'delivered',
  'delivery webhook succeeds after the admission transaction commits'
);
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_delivery_alignment_cases
    WHERE subscription_id = 'd2000000-0000-4000-8000-000000000001'),
  1,
  'the race leaves exactly one per-fulfillment ledger case'
);
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases
    WHERE subscription_id = 'd2000000-0000-4000-8000-000000000001'),
  'aligned',
  'race resolves to the single aligned durable case'
);
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'd2000000-0000-4000-8000-000000000001'),
  '2031-01-25T00:00:00Z'::timestamptz,
  'race alignment uses delivered_at after the shared subscription fence'
);
SELECT extensions.dblink_exec('delivery_alignment_admission_race', $cleanup$
DO $do$
BEGIN
  DELETE FROM public.subscription_delivery_alignment_cases
   WHERE subscription_id = 'd2000000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_delivery_alignment_admission_receipts
   WHERE subscription_id = 'd2000000-0000-4000-8000-000000000001';
  UPDATE public.subscription_cycles
     SET order_id = NULL
   WHERE id = 'd3000000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_fulfillment_orders
   WHERE id = 'd5000000-0000-4000-8000-000000000001';
  DELETE FROM public.commerce_orders
   WHERE id = 'd4000000-0000-4000-8000-000000000001';
  DELETE FROM public.subscription_cycles
   WHERE id = 'd3000000-0000-4000-8000-000000000001';
  DELETE FROM public.subscriptions
   WHERE id = 'd2000000-0000-4000-8000-000000000001';
  DELETE FROM public.addresses
   WHERE id = 'd1100000-0000-4000-8000-000000000001';
  DELETE FROM public.clients
   WHERE id = 'd1000000-0000-4000-8000-000000000001';
  UPDATE public.subscription_delivery_alignment_control
     SET mode = 'off'
   WHERE singleton;
END
$do$;
$cleanup$);
SELECT extensions.dblink_disconnect('delivery_alignment_admission_race');
SELECT extensions.dblink_disconnect('delivery_alignment_delivery_race');

-- Select rollback mode only after the externally committed race fixture is
-- gone. Updating the singleton earlier would hold it until this test ROLLBACK
-- and hide the intended subscription lock behind a test-only control-row wait.
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000001', '2030-01-10T00:00:00Z', '2030-01-11T00:00:00Z'
  ) #>> '{allowed}',
  'true', 'off admits an overdue renewal');
SELECT is((SELECT count(*)::int FROM public.subscription_delivery_alignment_cases), 0,
  'off creates no durable delivery case');

-- A second fulfilment row on one order is now schema-legal, so this fixture no
-- longer drops a constraint to obtain one -- it takes the next ordinal and names
-- the row it follows, which is the only shape the replacement CHECK admits above
-- ordinal 0. Nothing this test asserts depends on why the second parcel exists:
-- the subject is that alignment holds one case per fulfilment row. Still placed
-- after the dblink proof, so the fixture cannot disturb the subscription/case
-- race it is measured against.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot,
  sequence_no, replaces_fulfillment_order_id, replacement_reason
) VALUES (
  'c5000000-0000-4000-8000-0000000000d0', 'c4000000-0000-4000-8000-00000000000b',
  'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
  'delivery-alignment-fo-split-second', 'in_transit', '{}'::jsonb,
  1, 'c5000000-0000-4000-8000-00000000000b', 'other'
);

UPDATE public.subscription_delivery_alignment_control SET mode = 'protect' WHERE singleton;
CREATE TEMP TABLE _protect AS
SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000001', '2030-01-10T00:00:00Z', '2030-01-11T00:00:00Z'
) AS result;
SELECT is((SELECT result #>> '{allowed}' FROM _protect), 'false', 'protect blocks the overdue 14-day renewal');
SELECT is((SELECT result #>> '{state}' FROM _protect), 'protected', 'protect returns a compact protected state');
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000001'), 'protected', 'overdue admission committed a durable protected case');
SELECT throws_ok(
  $$INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot)
      VALUES ('c3000000-0000-4000-8000-000000000101', 'c2000000-0000-4000-8000-000000000001', 2,
              '2030-01-10T00:00:00Z', 'payment_pending', 'delivery-alignment-guard-14',
              public.subscription_current_template_snapshot('c2000000-0000-4000-8000-000000000001'))$$,
  'P0001', 'subscription_delivery_alignment_protected', 'cycle guard rejects before an artifact can exist');
SELECT is((SELECT count(*)::int FROM public.subscription_cycles WHERE subscription_id = 'c2000000-0000-4000-8000-000000000001'), 1,
  'blocked admission did not create a successor cycle');
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000001', '2030-01-10T00:00:00Z', '2030-01-12T00:00:00Z'
  ) #>> '{reason}',
  'delivery_alignment_protected', 'replayed admission stays blocked by the one case');
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000001', '2030-01-10T00:00:00Z', '2030-01-12T00:00:00Z'
  ) #>> '{allowed}',
  'false', 'persisted protection survives a later global off switch');
UPDATE public.commerce_fulfillment_orders
   SET delivered_at = '2030-01-05T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000001';
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000001'), 'released', 'protect delivery releases without changing cadence');
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000001'), '2030-01-10T00:00:00Z'::timestamptz, 'protect leaves next_cycle_at unchanged');

UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;
SELECT throws_ok(
  $$INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot)
      VALUES ('c3000000-0000-4000-8000-000000000104', 'c2000000-0000-4000-8000-000000000009', 2,
              '2030-09-10T00:00:00Z', 'payment_pending', 'delivery-alignment-no-admission',
              public.subscription_current_template_snapshot('c2000000-0000-4000-8000-000000000009'))$$,
  'P0001', 'subscription_delivery_alignment_admission_required',
  'protecting mode rejects a raw successor with no committed admission receipt'
);
SELECT is((SELECT count(*)::int FROM public.subscription_cycles WHERE subscription_id = 'c2000000-0000-4000-8000-000000000009'), 1,
  'no-prior-admission rejection leaves no successor artifact');
SELECT is((SELECT count(*)::int FROM public.commerce_orders WHERE subscription_id = 'c2000000-0000-4000-8000-000000000009' AND subscription_cycle_id <> 'c3000000-0000-4000-8000-000000000009'), 0,
  'raw cycle boundary rejection leaves no successor order artifact');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_intents WHERE subscription_id = 'c2000000-0000-4000-8000-000000000009' AND subscription_cycle_id <> 'c3000000-0000-4000-8000-000000000009'), 0,
  'raw cycle boundary rejection leaves no successor payment-intent artifact');
SELECT is((SELECT count(*)::int FROM public.commerce_payment_attempts attempt JOIN public.commerce_payment_intents intent ON intent.id = attempt.payment_intent_id WHERE intent.subscription_id = 'c2000000-0000-4000-8000-000000000009'), 0,
  'raw cycle boundary rejection leaves no provider-attempt artifact');
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot)
VALUES ('c3000000-0000-4000-8000-000000000103', 'c2000000-0000-4000-8000-000000000009', 2,
        '2030-09-10T00:00:00Z', 'payment_pending', 'delivery-alignment-existing-cycle-no-attempt',
        public.subscription_current_template_snapshot('c2000000-0000-4000-8000-000000000009'));
UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;
SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000009', '2030-09-10T00:00:00Z', '2030-09-11T00:00:00Z'
);
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-09-12T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000009';
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000009'), 'manual_review', 'already-created successor becomes manual review');
SELECT is((SELECT manual_review_reason FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000009'), 'renewal_cycle_already_created', 'already-created successor is distinct from provider-attempt collision');
CREATE TEMP TABLE _auto_21 AS SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000002', '2030-02-10T00:00:00Z', '2030-02-11T00:00:00Z'
) AS result;
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-02-12T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000002';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000002'), '2030-03-05T00:00:00Z'::timestamptz, '21-day cadence shifts from trusted delivery');
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000002'), 'aligned', 'auto-align exposes aligned only after durable delivery');
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-02-12T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000002';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000002'), '2030-03-05T00:00:00Z'::timestamptz, 'delivery replay does not shift twice');
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000002', '2030-03-05T00:00:00Z', '2030-03-05T00:00:00Z'
  ) #>> '{allowed}',
  'true', 'aligned future schedule needs a later due admission before cycle creation'
);
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot)
VALUES ('c3000000-0000-4000-8000-000000000102', 'c2000000-0000-4000-8000-000000000002', 2,
        '2030-03-05T00:00:00Z', 'payment_pending', 'delivery-alignment-consume-aligned',
        public.subscription_current_template_snapshot('c2000000-0000-4000-8000-000000000002'));
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000002'), 'released', 'creating the aligned renewal releases its stale customer-facing case');
SELECT ok(EXISTS (
  SELECT 1 FROM public.subscription_delivery_alignment_admission_receipts
   WHERE subscription_id = 'c2000000-0000-4000-8000-000000000002'
     AND scheduled_at = '2030-03-05T00:00:00Z'
     AND source = 'renewal_admission'
     AND consumed_at IS NOT NULL
), 'due admission creates and atomically consumes the aligned successor receipt');

SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000003', '2030-03-31T00:00:00Z', '2030-04-01T00:00:00Z'
);
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-03-01T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000003';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000003'), '2030-03-31T00:00:00Z'::timestamptz, '28-day alignment never moves an already-later schedule earlier');

SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000004', '2030-04-10T00:00:00Z', '2030-04-11T00:00:00Z'
);
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-04-12T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000004';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000004'), '2030-04-26T00:00:00Z'::timestamptz, 'starter-marked cycle 1 uses its stored 14-day cadence without phase mutation');

UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-05-02T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-000000000005';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000005'), '2030-05-10T00:00:00Z'::timestamptz, 'ordinary on-time delivery with no case is a schedule no-op');
SELECT is((SELECT count(*)::int FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000005'), 0, 'normal delivery creates no alignment case');

SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-00000000000c', '2030-12-10T00:00:00Z', '2030-12-09T00:00:00Z'
  ) #>> '{reason}',
  'not_due', 'admission does not manufacture delay evidence before the renewal is due');
UPDATE public.subscription_delivery_alignment_control SET mode = 'shadow' WHERE singleton;
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-00000000000c', '2030-12-10T00:00:00Z', '2030-12-11T00:00:00Z'
  ) #>> '{allowed}',
  'true', 'shadow records but allows the delayed renewal');
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000c'), 'shadow', 'shadow case is server-only durable evidence');
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-00000000000c', '2030-12-11T00:00:00Z', '2030-12-11T00:00:00Z'
  ) #>> '{allowed}',
  'true', 'shadow stale observation never blocks a renewal');
SELECT is((SELECT count(*)::int FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000c'), 1,
  'shadow stale observation does not change durable evidence');
UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;

SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-00000000000b', '2030-11-10T00:00:00Z', '2030-11-11T00:00:00Z'
);
SELECT is((SELECT count(*)::int FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000b'), 2, 'split predecessor holds one case per fulfillment');
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-11-12T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-00000000000b';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-00000000000b'), '2030-11-10T00:00:00Z'::timestamptz, 'split delivery waits for missing durable delivered_at');
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-11-13T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-0000000000d0';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-00000000000b'), '2030-11-27T00:00:00Z'::timestamptz, 'last split delivery aligns once');

UPDATE public.subscription_delivery_alignment_control SET mode = 'protect' WHERE singleton;
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-00000000000c', '2030-12-10T00:00:00Z', '2030-12-11T00:00:00Z'
  ) #>> '{state}',
  'manual_review', 'missing fulfillment becomes durable manual review rather than inferred delivery');

UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;
INSERT INTO public.commerce_order_holds (order_id, reason, status, idempotency_key, metadata)
VALUES (
  'c4000000-0000-4000-8000-000000000007', 'fulfillment_exception', 'active',
  'delivery-alignment-exception-7',
  '{"source":"commerce.fulfillment.omnipack_provider_exception"}'::jsonb
);
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000007'), 'protected', 'active fulfillment exception opens protection before due admission');
SELECT is((SELECT evidence_kind FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000007'), 'fulfillment_exception', 'exception trigger records customer-visible delay evidence without a new outbox type');
-- Ending the subscription first is what makes this release honest: this parcel
-- never gets a delivered_at, and releasing an undelivered predecessor while the
-- subscription is still active would re-arm the next autonomous charge. The
-- cancellation used to sit further down; only its position moved.
UPDATE public.subscriptions SET status = 'cancelled' WHERE id = 'c2000000-0000-4000-8000-000000000007';
SELECT public.subscription_delivery_alignment_resolve_case(
  (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000007'),
  'operator_confirmed', 'Operator confirmed customer delivery resolution.'
);
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000007'), 'released', 'service-role resolution releases only the targeted open case');
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000c'), 'manual_review', 'service-role resolution does not release another case');
SELECT public.subscription_delivery_alignment_admit_renewal('c2000000-0000-4000-8000-000000000006', '2030-06-10T00:00:00Z', '2030-06-11T00:00:00Z');
UPDATE public.subscriptions SET status = 'paused' WHERE id = 'c2000000-0000-4000-8000-000000000006';
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-06-12T00:00:00Z' WHERE id = 'c5000000-0000-4000-8000-000000000006';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000006'), '2030-06-10T00:00:00Z'::timestamptz, 'paused subscription keeps its existing schedule authority');
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-07-12T00:00:00Z' WHERE id = 'c5000000-0000-4000-8000-000000000007';
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000007'), '2030-07-10T00:00:00Z'::timestamptz, 'cancelled subscription keeps its existing schedule authority');

-- A scheduled retry is already-created dunning authority. Admission must let
-- it replay even after the predecessor delivery becomes manual_review.
SELECT public.subscription_delivery_alignment_admit_renewal('c2000000-0000-4000-8000-000000000008', '2030-08-10T00:00:00Z', '2030-08-11T00:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('c3000000-0000-4000-8000-000000000108', 'c2000000-0000-4000-8000-000000000008', 2,
        '2030-08-10T00:00:00Z', 'retry_scheduled', 'delivery-alignment-retry-existing');
INSERT INTO public.commerce_orders (id, client_id, shipping_address_id, status, subtotal_cents, total_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('c4000000-0000-4000-8000-000000000108', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'pending_payment', 1000, 1000, 'subscription_cycle', 'c2000000-0000-4000-8000-000000000008', 'c3000000-0000-4000-8000-000000000108');
INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('c6000000-0000-4000-8000-000000000108', 'c4000000-0000-4000-8000-000000000108', 'test', 'pending', 1000);
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, status)
VALUES ('c6100000-0000-4000-8000-000000000108', 'subscription_cycle', 'c4000000-0000-4000-8000-000000000108', 'c2000000-0000-4000-8000-000000000008', 'c3000000-0000-4000-8000-000000000108', 'c6000000-0000-4000-8000-000000000108', 1000, 'created');
INSERT INTO public.commerce_payment_attempts (id, payment_intent_id, payment_id, provider, idempotency_key, status, amount_cents)
VALUES ('c6300000-0000-4000-8000-000000000108', 'c6100000-0000-4000-8000-000000000108', 'c6000000-0000-4000-8000-000000000108', 'test', 'delivery-alignment-retry-attempt', 'created', 1000);
INSERT INTO public.subscription_dunning_cases (id, subscription_id, cycle_id, order_id, payment_intent_id, client_id, status, retry_attempt)
VALUES ('c6200000-0000-4000-8000-000000000108', 'c2000000-0000-4000-8000-000000000008', 'c3000000-0000-4000-8000-000000000108', 'c4000000-0000-4000-8000-000000000108', 'c6100000-0000-4000-8000-000000000108', 'c1000000-0000-4000-8000-000000000001', 'open', 1);
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-08-12T00:00:00Z' WHERE id = 'c5000000-0000-4000-8000-000000000008';
SELECT is((SELECT status FROM public.subscription_dunning_cases WHERE id = 'c6200000-0000-4000-8000-000000000108'), 'open', 'delivery alignment does not mutate open dunning');
SELECT is((SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000008'), 'manual_review', 'open dunning becomes operator review, not delivery dunning');
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000008', '2030-08-10T00:00:00Z', '2030-08-12T00:00:00Z'
  ) #>> '{state}',
  'retry_scheduled', 'existing retry_scheduled authority bypasses later manual-review protection'
);
SELECT is((SELECT count(*)::int FROM public.subscription_delivery_alignment_admission_receipts WHERE subscription_id = 'c2000000-0000-4000-8000-000000000008'), 0,
  'retry replay neither mints nor consumes a new-cycle admission receipt');

-- Existing successor/attempt collision is recorded but never cancelled or rewritten.
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot)
VALUES ('c3000000-0000-4000-8000-00000000010a', 'c2000000-0000-4000-8000-00000000000a', 2,
        '2030-10-10T00:00:00Z', 'payment_pending', 'delivery-alignment-existing-cycle',
        public.subscription_current_template_snapshot('c2000000-0000-4000-8000-00000000000a'));
UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;
INSERT INTO public.commerce_orders (id, client_id, shipping_address_id, status, subtotal_cents, total_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('c4000000-0000-4000-8000-00000000010a', 'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'pending_payment', 1000, 1000, 'subscription_cycle', 'c2000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-00000000010a');
INSERT INTO public.commerce_payments (id, order_id, provider, status, amount_cents)
VALUES ('c6000000-0000-4000-8000-00000000010a', 'c4000000-0000-4000-8000-00000000010a', 'test', 'pending', 1000);
INSERT INTO public.commerce_payment_intents (id, target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, amount_cents, status)
VALUES ('c6100000-0000-4000-8000-00000000010a', 'subscription_cycle', 'c4000000-0000-4000-8000-00000000010a', 'c2000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-00000000010a', 'c6000000-0000-4000-8000-00000000010a', 1000, 'created');
INSERT INTO public.commerce_payment_attempts (id, payment_intent_id, payment_id, provider, idempotency_key, status, amount_cents)
VALUES ('c6300000-0000-4000-8000-00000000010a', 'c6100000-0000-4000-8000-00000000010a', 'c6000000-0000-4000-8000-00000000010a', 'test', 'delivery-alignment-existing-attempt', 'created', 1000);
SELECT public.subscription_delivery_alignment_admit_renewal('c2000000-0000-4000-8000-00000000000a', '2030-10-10T00:00:00Z', '2030-10-11T00:00:00Z');
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2030-10-12T00:00:00Z' WHERE id = 'c5000000-0000-4000-8000-00000000000a';
SELECT is((SELECT manual_review_reason FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000a'), 'existing_provider_attempt', 'existing provider attempt becomes manual review');
SELECT is((SELECT status FROM public.commerce_payment_attempts WHERE id = 'c6300000-0000-4000-8000-00000000010a'), 'created', 'delivery alignment preserves provider-attempt truth');

-- ---------------------------------------------------------------------------
-- Case exits (20260817130000). Before this migration an open case had exactly
-- one honest ending: the original parcel's own trusted delivered_at. When that
-- parcel is never delivered the case could only be released, and release both
-- re-armed the charge and removed the subscription from every open-case
-- projection at once. These fixtures cover the exits and the refusal.
-- ---------------------------------------------------------------------------
UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;

SELECT ok(
  has_function_privilege('service_role', 'public.subscription_delivery_alignment_confirm_replacement(uuid,text)', 'EXECUTE'),
  'service role receives the replacement confirmation entrypoint'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.subscription_delivery_alignment_confirm_replacement(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.subscription_delivery_alignment_confirm_replacement(uuid,text)', 'EXECUTE'),
  'browser roles cannot invoke the replacement confirmation'
);

-- Fixture 13: the substitute shipment the rail had no vocabulary for.
INSERT INTO public.commerce_order_holds (order_id, reason, status, idempotency_key, metadata)
VALUES (
  'c4000000-0000-4000-8000-00000000000d', 'fulfillment_exception', 'active',
  'delivery-alignment-exit-replacement',
  '{"source":"commerce.fulfillment.provider_exception"}'::jsonb
);
SELECT public.subscription_delivery_alignment_confirm_replacement(
  (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000d'),
  'Substitute shipment handed over and confirmed by the customer.'
);
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-00000000000d'),
  now() + make_interval(days => 14),
  'confirming a replacement aligns from the confirmation instant plus cadence');
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000d'),
  'aligned',
  'a confirmed replacement settles the case as aligned rather than merely released');

-- The whole point of the exit: the renewal that case blocked must now be
-- creatable. Admission has to report the settled state, stop refusing, and mint
-- the one-time receipt the cycle-insert backstop consumes - the original parcel
-- is still undelivered, so every earlier branch behaves exactly as before.
CREATE TEMP TABLE _settled AS
SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-00000000000d',
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-00000000000d'),
  now() + make_interval(days => 20)
) AS result;
SELECT is((SELECT result #>> '{state}' FROM _settled), 'aligned',
  'admission reports the ledger state rather than a literal protected');
SELECT is((SELECT result #>> '{allowed}' FROM _settled), 'true',
  'a settled case stops refusing the renewal it no longer blocks');
SELECT is((SELECT result #>> '{reason}' FROM _settled), 'delivery_alignment_case_settled',
  'the settled admission names why it admitted instead of reusing the protected reason');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_delivery_alignment_admission_receipts
    WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000d' AND consumed_at IS NULL),
  1,
  'the settled admission mints the one-time receipt the cycle insert has to consume');
SELECT lives_ok($$
  INSERT INTO public.subscription_cycles (
    id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot
  )
  SELECT 'c3000000-0000-4000-8000-00000000010d', s.id, 2, s.next_cycle_at, 'payment_pending',
         'delivery-alignment-replacement-cycle', public.subscription_current_template_snapshot(s.id)
    FROM public.subscriptions s
   WHERE s.id = 'c2000000-0000-4000-8000-00000000000d'
$$, 'the renewal a confirmed replacement scheduled can finally create its cycle');
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000d'),
  'released',
  'consuming the aligned schedule ends the case as released');

-- Fixture 14: a schedule already further out than the confirmation instant plus
-- cadence. The shift is one-way; a replacement may never pull a promise closer.
INSERT INTO public.commerce_order_holds (order_id, reason, status, idempotency_key, metadata)
VALUES (
  'c4000000-0000-4000-8000-00000000000e', 'fulfillment_exception', 'active',
  'delivery-alignment-exit-already-later',
  '{"source":"commerce.fulfillment.provider_exception"}'::jsonb
);
SELECT public.subscription_delivery_alignment_confirm_replacement(
  (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000e'),
  'Substitute shipment confirmed well ahead of the promised schedule.'
);
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-00000000000e'),
  '2099-01-10T00:00:00Z'::timestamptz,
  'confirming a replacement never moves an already-later schedule earlier');
SELECT is(
  (SELECT aligned_next_cycle_at FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000e'),
  '2099-01-10T00:00:00Z'::timestamptz,
  'the aligned promise records the schedule the customer actually keeps');

-- Fixture 15: the release that would strand the customer, then the replay.
INSERT INTO public.commerce_order_holds (order_id, reason, status, idempotency_key, metadata)
VALUES (
  'c4000000-0000-4000-8000-00000000000f', 'fulfillment_exception', 'active',
  'delivery-alignment-exit-strand',
  '{"source":"commerce.fulfillment.provider_exception"}'::jsonb
);
SELECT throws_ok(
  $$SELECT public.subscription_delivery_alignment_resolve_case(
      (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000f'),
      'operator_confirmed', 'Operator judged this delay acceptable.')$$,
  '22023', 'subscription_delivery_alignment_release_would_strand',
  'releasing a case whose predecessor is still undelivered is refused');
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000f'),
  'protected',
  'the refused release leaves the case where the operator queue can still see it');
SELECT public.subscription_delivery_alignment_confirm_replacement(
  (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000f'),
  'Substitute shipment confirmed once.'
);
-- Rewind the schedule to a sentinel the confirmation instant plus cadence is
-- comfortably later than: a second shift would overwrite it, so an unchanged
-- sentinel is the proof that the replay did nothing.
UPDATE public.subscriptions SET next_cycle_at = '2021-06-01T00:00:00Z'
 WHERE id = 'c2000000-0000-4000-8000-00000000000f';
CREATE TEMP TABLE _replay AS
SELECT public.subscription_delivery_alignment_confirm_replacement(
  (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000f'),
  'The same substitute shipment confirmed a second time.'
) AS result;
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-00000000000f'),
  '2021-06-01T00:00:00Z'::timestamptz,
  'confirming a replacement twice aligns only once');
SELECT is(
  (SELECT (result #>> '{nextCycleAt}')::timestamptz FROM _replay),
  (SELECT aligned_next_cycle_at FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-00000000000f'),
  'the replayed confirmation answers with the schedule it already promised');

-- Fixture 16: the subscription is over. There is no schedule to align, and the
-- release that was unsafe while it was active is the honest ending now.
INSERT INTO public.commerce_order_holds (order_id, reason, status, idempotency_key, metadata)
VALUES (
  'c4000000-0000-4000-8000-000000000010', 'fulfillment_exception', 'active',
  'delivery-alignment-exit-ended',
  '{"source":"commerce.fulfillment.provider_exception"}'::jsonb
);
UPDATE public.subscriptions SET status = 'cancelled' WHERE id = 'c2000000-0000-4000-8000-000000000010';
SELECT throws_ok(
  $$SELECT public.subscription_delivery_alignment_confirm_replacement(
      (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000010'),
      'Substitute shipment confirmed after the subscription ended.')$$,
  '22023', 'subscription_delivery_alignment_replacement_requires_active_subscription',
  'confirming a replacement is refused when the subscription is not active');
CREATE TEMP TABLE _ended AS
SELECT public.subscription_delivery_alignment_resolve_case(
  (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000010'),
  'false_positive', 'Subscription ended; nothing further will be shipped or charged.'
) AS result;
SELECT is((SELECT result #>> '{resolved}' FROM _ended), 'true',
  'releasing is permitted once the subscription is no longer active');
SELECT throws_ok(
  $$SELECT public.subscription_delivery_alignment_confirm_replacement(
      (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000010'),
      'A late substitute shipment.')$$,
  '22023', 'subscription_delivery_alignment_case_not_open',
  'confirming a replacement is refused for a case that is not open');

-- ---------------------------------------------------------------------------
-- A replacement parcel is a delayed delivery (20260820160000). Before this
-- forward, a replacement that ARRIVED left the renewal frozen for good: the
-- delivery trigger found no case keyed to the replacement row, and even with one
-- the outstanding-obligation guard still saw the superseded original, whose
-- delivered_at is null for good because that parcel was lost. A subscription is
-- the product; nothing may suspend one.
-- ---------------------------------------------------------------------------
UPDATE public.subscription_delivery_alignment_control SET mode = 'auto_align' WHERE singleton;

-- Fixture 17: the case the wave exists for. The original is lost, the
-- replacement arrives, and the subscription must renew on the new rhythm.
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000011', '2032-01-10T00:00:00Z', '2032-01-11T00:00:00Z'
  ) #>> '{state}',
  'protected', 'an overdue renewal behind a lost parcel is protected');
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot,
  sequence_no, replaces_fulfillment_order_id, replacement_reason
) VALUES (
  'c5000000-0000-4000-8000-0000000000d1', 'c4000000-0000-4000-8000-000000000011',
  'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
  'delivery-alignment-fo-replacement-arrived', 'in_transit', '{}'::jsonb,
  1, 'c5000000-0000-4000-8000-000000000011', 'lost'
);
-- Sending the replacement changes nothing on its own. The customer still has no
-- delivery, so not charging again is the correct answer.
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000011'),
  'protected',
  'a replacement still in flight leaves the renewal protected');
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000011'),
  '2032-01-10T00:00:00Z'::timestamptz,
  'a replacement still in flight shifts no schedule');

UPDATE public.commerce_fulfillment_orders SET delivered_at = '2032-02-01T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-0000000000d1';
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000011'),
  'aligned',
  'a replacement that arrives settles the case its predecessor opened');
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000011'),
  '2032-02-15T00:00:00Z'::timestamptz,
  'the cycle shifts out by the replacement''s own delivery plus the stored cadence');
-- Nothing forged a delivery for the parcel that never came. The superseded row
-- keeps its honest null; it simply stopped being an obligation.
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders WHERE id = 'c5000000-0000-4000-8000-000000000011'),
  NULL::timestamptz,
  'the superseded original keeps its null delivered_at');
CREATE TEMP TABLE _replacement_arrived AS
SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000011', '2032-02-15T00:00:00Z', '2032-02-16T00:00:00Z'
) AS result;
SELECT is((SELECT result #>> '{allowed}' FROM _replacement_arrived), 'true',
  'the renewal a delivered replacement rescheduled is admitted rather than frozen');
SELECT is((SELECT result #>> '{reason}' FROM _replacement_arrived), 'predecessor_delivered',
  'admission reads the order as received once its only outstanding parcel arrived');
SELECT lives_ok($$
  INSERT INTO public.subscription_cycles (
    id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot
  )
  VALUES ('c3000000-0000-4000-8000-000000000111', 'c2000000-0000-4000-8000-000000000011', 2,
          '2032-02-15T00:00:00Z', 'payment_pending', 'delivery-alignment-replacement-arrived-cycle',
          public.subscription_current_template_snapshot('c2000000-0000-4000-8000-000000000011'))
$$, 'the subscription whose replacement arrived renews instead of freezing');
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000011'),
  'released',
  'consuming the shifted schedule ends the replacement case as released');

-- Fixture 18: the replacement is still in flight, so the operator exit that
-- protects the customer from a charge for goods that never arrived must still
-- refuse. Only the superseded parcel stopped counting, not every parcel.
SELECT is(
  public.subscription_delivery_alignment_admit_renewal(
    'c2000000-0000-4000-8000-000000000012', '2032-03-10T00:00:00Z', '2032-03-11T00:00:00Z'
  ) #>> '{state}',
  'protected', 'the in-flight replacement fixture opens its protected case');
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot,
  sequence_no, replaces_fulfillment_order_id, replacement_reason
) VALUES (
  'c5000000-0000-4000-8000-0000000000d2', 'c4000000-0000-4000-8000-000000000012',
  'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
  'delivery-alignment-fo-replacement-in-flight', 'in_transit', '{}'::jsonb,
  1, 'c5000000-0000-4000-8000-000000000012', 'returned_undelivered'
);
SELECT throws_ok(
  $$SELECT public.subscription_delivery_alignment_resolve_case(
      (SELECT id FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000012'),
      'operator_confirmed', 'Operator judged the replacement close enough to arrival.')$$,
  '22023', 'subscription_delivery_alignment_release_would_strand',
  'an undelivered replacement is still an obligation the release may not spend');
SELECT is(
  (SELECT state FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000012'),
  'protected',
  'the refused release leaves the in-flight replacement case open');
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000012'),
  '2032-03-10T00:00:00Z'::timestamptz,
  'a refused release shifts no schedule');

-- Fixture 19: the replacement arrived before the renewal ever fell due, so no
-- case was ever opened. Admission must read the order as received on its own,
-- without the delivery trigger having settled anything.
INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key, status, shipping_address_snapshot,
  sequence_no, replaces_fulfillment_order_id, replacement_reason
) VALUES (
  'c5000000-0000-4000-8000-0000000000d3', 'c4000000-0000-4000-8000-000000000013',
  'c1000000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001',
  'delivery-alignment-fo-replacement-before-admission', 'in_transit', '{}'::jsonb,
  1, 'c5000000-0000-4000-8000-000000000013', 'damaged'
);
UPDATE public.commerce_fulfillment_orders SET delivered_at = '2032-04-05T00:00:00Z'
 WHERE id = 'c5000000-0000-4000-8000-0000000000d3';
CREATE TEMP TABLE _replacement_before_admission AS
SELECT public.subscription_delivery_alignment_admit_renewal(
  'c2000000-0000-4000-8000-000000000013', '2032-04-10T00:00:00Z', '2032-04-11T00:00:00Z'
) AS result;
SELECT is((SELECT result #>> '{allowed}' FROM _replacement_before_admission), 'true',
  'a renewal first due after the replacement landed is never protected');
SELECT is((SELECT result #>> '{reason}' FROM _replacement_before_admission), 'predecessor_delivered',
  'the superseded original does not manufacture delay evidence');
SELECT is(
  (SELECT count(*)::int FROM public.subscription_delivery_alignment_cases WHERE subscription_id = 'c2000000-0000-4000-8000-000000000013'),
  0,
  'no durable case is opened for an order the customer has already received');
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = 'c2000000-0000-4000-8000-000000000013'),
  '2032-04-10T00:00:00Z'::timestamptz,
  'a delivery that settles no case shifts no schedule');

SELECT * FROM finish();
ROLLBACK;
