-- W1: reference-schema customer SELECT policies, using two synthetic principals.
-- Run after the shipped baseline and forwards in the repository pgTAP harness.
BEGIN;
SELECT plan(12);

INSERT INTO auth.users (id, email) VALUES
  ('e3100000-0000-4000-8000-000000000001', 'customer-a@example.invalid'),
  ('e3100000-0000-4000-8000-000000000002', 'customer-b@example.invalid');
INSERT INTO public.clients (id, email, auth_user_id) VALUES
  ('e3200000-0000-4000-8000-000000000001', 'customer-a@example.invalid', 'e3100000-0000-4000-8000-000000000001'),
  ('e3200000-0000-4000-8000-000000000002', 'customer-b@example.invalid', 'e3100000-0000-4000-8000-000000000002');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country) VALUES
  ('e3300000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'shipping', '1 Example Road', 'Example City', '10000', 'US'),
  ('e3300000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'shipping', '2 Example Road', 'Example City', '10000', 'US');
INSERT INTO public.customer_orderer_profiles (id, client_id, full_name, email) VALUES
  ('e3400000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'Customer A', 'customer-a@example.invalid'),
  ('e3400000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'Customer B', 'customer-b@example.invalid');
INSERT INTO public.customer_payment_preferences (id, client_id, scope, method_kind) VALUES
  ('e3500000-0000-4000-8000-000000000001', 'e3200000-0000-4000-8000-000000000001', 'any', 'card'),
  ('e3500000-0000-4000-8000-000000000002', 'e3200000-0000-4000-8000-000000000002', 'any', 'card');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e3100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT results_eq('SELECT id::text FROM public.clients', ARRAY['e3200000-0000-4000-8000-000000000001'], 'customer A sees only own client');
SELECT results_eq('SELECT id::text FROM public.addresses', ARRAY['e3300000-0000-4000-8000-000000000001'], 'customer A sees only own address');
SELECT results_eq('SELECT id::text FROM public.customer_orderer_profiles', ARRAY['e3400000-0000-4000-8000-000000000001'], 'customer A sees only own orderer');
SELECT results_eq('SELECT id::text FROM public.customer_payment_preferences', ARRAY['e3500000-0000-4000-8000-000000000001'], 'customer A sees only own payment preference');
SELECT set_config('request.jwt.claims', '{"sub":"e3100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT results_eq('SELECT id::text FROM public.clients', ARRAY['e3200000-0000-4000-8000-000000000002'], 'customer B sees only own client');
SELECT results_eq('SELECT id::text FROM public.addresses', ARRAY['e3300000-0000-4000-8000-000000000002'], 'customer B sees only own address');
SELECT results_eq('SELECT id::text FROM public.customer_orderer_profiles', ARRAY['e3400000-0000-4000-8000-000000000002'], 'customer B sees only own orderer');
SELECT results_eq('SELECT id::text FROM public.customer_payment_preferences', ARRAY['e3500000-0000-4000-8000-000000000002'], 'customer B sees only own payment preference');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok('SELECT id FROM public.clients', '42501', 'permission denied for table clients', 'anon client SELECT is denied');
SELECT throws_ok('SELECT id FROM public.addresses', '42501', 'permission denied for table addresses', 'anon address SELECT is denied');
SELECT throws_ok('SELECT id FROM public.customer_orderer_profiles', '42501', 'permission denied for table customer_orderer_profiles', 'anon orderer SELECT is denied');
SELECT throws_ok('SELECT id FROM public.customer_payment_preferences', '42501', 'permission denied for table customer_payment_preferences', 'anon payment preference SELECT is denied');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
