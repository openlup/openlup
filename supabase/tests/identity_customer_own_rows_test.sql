-- W1: customer row isolation in the reference schema, pinned as granted today.
-- Two synthetic customers each see exactly their own row in every table where
-- the authenticated role holds SELECT (on clients, column-level). The customer
-- SELECT policies on tables without any such grant stay dormant: the read is
-- refused before RLS applies.
-- Anonymous behaviour is pinned per table. No grant changes; fixtures roll back.
BEGIN;
SELECT plan(27);

-- Seed with owner privileges before assuming either browser role.
SET LOCAL ROLE postgres;
INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
  ('e3100000-0000-4000-8000-000000000001', 'customer-a@example.invalid', '{"provider":"email"}'),
  ('e3100000-0000-4000-8000-000000000002', 'customer-b@example.invalid', '{"provider":"email"}');
-- Each customer reuses one fixture UUID across tables; neither has an operator membership.
INSERT INTO public.clients (id, email, auth_user_id) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'customer-a@example.invalid', 'e3100000-0000-4000-8000-000000000001'),
  ('e3200000-0000-4000-8000-000000000002', 'customer-b@example.invalid', 'e3100000-0000-4000-8000-000000000002');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'shipping', '1 Example Road', 'Example City', '10000', 'US'),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'shipping', '2 Example Road', 'Example City', '10000', 'US');
INSERT INTO public.customer_orderer_profiles (id, client_id, full_name, email) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'Customer A', 'customer-a@example.invalid'),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'Customer B', 'customer-b@example.invalid');
INSERT INTO public.customer_payment_preferences (id, client_id, scope, method_kind) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'any', 'card'),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'any', 'card');
INSERT INTO public.customer_account_events (id, client_id, event_type, entity_type) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'identity_fixture', 'identity_fixture'),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'identity_fixture', 'identity_fixture');
-- Seeded subscription rows make the dormant-policy and anonymous zero-row witnesses non-vacuous.
INSERT INTO public.catalog_products (id, slug, name) VALUES
  ('e3300000-0000-4000-8000-000000000001', 'identity-own-rows-product', 'Identity fixture product');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, net_weight_g, kcal_per_unit) VALUES
  ('e3300000-0000-4000-8000-000000000002', 'e3300000-0000-4000-8000-000000000001', 'IDENTITY-OWN-ROWS', 'Identity fixture SKU', 'other', 400, 350);
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 30, 'EUR', 'pending_activation'),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 30, 'EUR', 'pending_activation');
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'e3300000-0000-4000-8000-000000000002', 1),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'e3300000-0000-4000-8000-000000000002', 1);
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, status, engine_idempotency_key) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 0, 'planned', 'identity-own-rows-cycle-a'),
  ('e3200000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 0, 'planned', 'identity-own-rows-cycle-b');
RESET ROLE;
SET LOCAL row_security = on;
-- Clear the legacy single-claim setting so the claims below own the identity.
SELECT set_config('request.jwt.claim.sub', '', true);

-- Assertions 1-5: customer A sees exactly A. No fixture WHERE clause, so any extra visible row fails.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e3100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT results_eq(
  format('SELECT id FROM public.%I ORDER BY id', owned.table_name),
  $$ VALUES ('e3200000-0000-4000-8000-000000000001'::uuid) $$,
  format('customer A sees only A in %s', owned.table_name)
)
FROM (VALUES ('clients'), ('addresses'), ('customer_orderer_profiles'), ('customer_payment_preferences'),
  ('customer_account_events')) AS owned(table_name);

-- Assertions 6-11: the customer SELECT policies here have no authenticated grant behind them.
SELECT throws_ok(
  format('SELECT count(*) FROM public.%I', dormant.table_name),
  '42501',
  format('permission denied for table %s', dormant.table_name),
  format('authenticated cannot SELECT %s', dormant.table_name)
)
FROM (VALUES ('pets'), ('commerce_orders'), ('commerce_order_items'),
  ('subscriptions'), ('subscription_lines'), ('subscription_cycles')) AS dormant(table_name);
RESET ROLE;

-- Assertions 12-16: the reciprocal second-customer witness.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e3100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT results_eq(
  format('SELECT id FROM public.%I ORDER BY id', owned.table_name),
  $$ VALUES ('e3200000-0000-4000-8000-000000000002'::uuid) $$,
  format('customer B sees only B in %s', owned.table_name)
)
FROM (VALUES ('clients'), ('addresses'), ('customer_orderer_profiles'), ('customer_payment_preferences'),
  ('customer_account_events')) AS owned(table_name);
RESET ROLE;

-- Assertions 17-27: anonymous behaviour as granted today, with no compensating grants.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok(
  format('SELECT count(*) FROM public.%I', denied.table_name),
  '42501',
  format('permission denied for table %s', denied.table_name),
  format('anon cannot SELECT %s', denied.table_name)
)
FROM (VALUES ('clients'), ('pets'), ('addresses'), ('commerce_orders'), ('commerce_order_items'),
  ('customer_orderer_profiles'), ('customer_payment_preferences'), ('customer_account_events')) AS denied(table_name);
SELECT is((SELECT count(*) FROM public.subscriptions), 0::bigint, 'anon sees zero subscriptions');
SELECT is((SELECT count(*) FROM public.subscription_lines), 0::bigint, 'anon sees zero subscription_lines');
SELECT is((SELECT count(*) FROM public.subscription_cycles), 0::bigint, 'anon sees zero subscription_cycles');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
