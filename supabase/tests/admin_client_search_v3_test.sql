BEGIN;

SELECT plan(31);

INSERT INTO auth.users (id) VALUES
  ('a2000000-0000-4000-8000-000000000001');

INSERT INTO public.communication_contacts (
  id, normalized_email, display_email
) VALUES (
  'a0000000-0000-4000-8000-000000000003',
  'marketing-search@example.test', 'marketing-search@example.test'
);

INSERT INTO public.clients (
  id, email, first_name, last_name, phone, lifecycle_stage, identity_kind,
  marketing_contact_id, created_at, updated_at
) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'shared-search@example.test',
    'Customer', 'Record', '+48 501 002 003', 'customer', 'customer', NULL,
    '2026-08-01T10:00:00Z', '2026-08-10T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000002', 'katarzyna-search@example.test',
    'Katarzyna', 'Raś', '+48 600 700 800', 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000003', 'marketing-search@marketing.invalid',
    'Marketing', 'Only', NULL, 'lead', 'marketing_lead',
    'a0000000-0000-4000-8000-000000000003',
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000004', 'rank-exact@example.test',
    'Aleksandra', NULL, NULL, 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000005', 'rank-prefix@example.test',
    'Aleksandra', 'Kowal', NULL, 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000006', 'rank-substring@example.test',
    'Maria', 'Aleksandra', NULL, 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000007', 'rank-fuzzy@example.test',
    'Aleksnarda', NULL, NULL, 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000008', 'maria@example.test',
    'Unique', 'Mailbox', NULL, 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000009', 'phone-prefix@example.test',
    'Phone', 'Prefix', '600 111 222', 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000010', 'order-prefix@example.test',
    'Order', 'Prefix', NULL, 'customer', 'customer', NULL,
    '2026-08-02T10:00:00Z', '2026-08-11T10:00:00Z');

UPDATE public.clients
SET auth_user_id = 'a2000000-0000-4000-8000-000000000001'
WHERE id = 'a1000000-0000-4000-8000-000000000001';

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, created_at, updated_at
) VALUES (
  'a5000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002', 'ORDER-SEARCH-123', 'pending_payment',
  '2026-08-06T10:00:00Z', '2026-08-14T10:00:00Z'
), (
  'a5000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000010', 'SEARCH-123-TAIL', 'pending_payment',
  '2026-08-06T10:00:00Z', '2026-08-14T10:00:00Z'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, created_at, updated_at
) VALUES (
  'a6000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002', 30, 'PLN', 'paused',
  '2026-08-07T10:00:00Z', '2026-08-15T10:00:00Z'
);

SELECT is(
  (public.admin_clients_search_v3('shared-search@example.test', 0, 20, 'all')->>'totalCount')::integer,
  1,
  'client search returns only the physical customer identity'
);

SELECT is(
  jsonb_array_length(public.admin_clients_search_v3('shared-search@example.test', 0, 20, 'all')->'candidates'),
  1,
  'one response carries the matching physical customer'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      public.admin_clients_search_v3('shared-search@example.test', 0, 20, 'all')->'candidates'
    ) AS candidate
    WHERE candidate->>'clientId' = 'a1000000-0000-4000-8000-000000000001'
      AND candidate->'sources' = '["physical_client"]'::jsonb
  ),
  'the physical customer keeps its own source identity'
);

SELECT is(
  (public.admin_clients_search_v3('marketing-search@marketing.invalid', 0, 20, 'all')->>'totalCount')::integer,
  0,
  'marketing compatibility clients never enter customer search'
);

SELECT is(
  (public.admin_clients_search_v3('maria@example.test', 0, 20, 'all')->>'totalCount')::integer,
  1,
  'a full email query cannot fuzzy-match an unrelated customer name'
);

SELECT is(
  (public.admin_clients_search_v3('customer1@unmatched.test', 0, 20, 'all')->>'totalCount')::integer,
  0,
  'digits inside an email query cannot match an unrelated phone number'
);

SELECT throws_ok(
  $$ SELECT public.admin_clients_search_v3('!!!', 0, 20, 'all') $$,
  '22023',
  'admin_clients_search_query_invalid',
  'punctuation-only input is rejected before it can become an unbounded match'
);

SELECT is(
  public.admin_clients_search_v3('Aleksandra', 0, 20, 'all')->'candidates'->0->>'clientId',
  'a1000000-0000-4000-8000-000000000004',
  'exact normalized name ranks first'
);

SELECT is(
  public.admin_clients_search_v3('Aleksandra', 0, 20, 'all')->'candidates'->1->>'clientId',
  'a1000000-0000-4000-8000-000000000005',
  'name prefix ranks after exact'
);

SELECT is(
  public.admin_clients_search_v3('Aleksandra', 0, 20, 'all')->'candidates'->2->>'clientId',
  'a1000000-0000-4000-8000-000000000006',
  'name substring ranks after prefix'
);

SELECT is(
  public.admin_clients_search_v3('Aleksandra', 0, 20, 'all')->'candidates'->3->>'clientId',
  'a1000000-0000-4000-8000-000000000007',
  'trigram typo match ranks after deterministic text matches'
);

SELECT is(
  (public.admin_clients_search_v3('Katarzyna Ras', 0, 20, 'all')->'candidates'->0->>'clientId'),
  'a1000000-0000-4000-8000-000000000002',
  'accent-insensitive diacritics normalize in a full-name search'
);

SELECT is(
  (public.admin_clients_search_v3('Ras Katarzyna', 0, 20, 'all')->'candidates'->0->>'clientId'),
  'a1000000-0000-4000-8000-000000000002',
  'reverse full-name order is searchable'
);

SET LOCAL pg_trgm.similarity_threshold = '0.90';

SELECT is(
  (public.admin_clients_search_v3('Katarzyna Rsa', 0, 20, 'all')->'candidates'->0->>'confidence'),
  'medium',
  'a minor name typo is returned independently from the caller session threshold'
);

SELECT is(
  (public.admin_clients_search_v3('600700800', 0, 20, 'all')->'candidates'->0->>'matchReason'),
  'phone',
  'phone formatting is ignored'
);

SELECT is(
  public.admin_clients_search_v3('600', 0, 20, 'all')->'candidates'->0->>'clientId',
  'a1000000-0000-4000-8000-000000000009',
  'phone prefix ranks before a phone substring'
);

SELECT is(
  public.admin_clients_search_v3('600', 0, 20, 'all')->'candidates'->1->>'clientId',
  'a1000000-0000-4000-8000-000000000002',
  'phone substring follows the competing prefix'
);

SELECT is(
  (public.admin_clients_search_v3('ORDER-SEARCH-123', 0, 20, 'all')->'candidates'->0->>'matchReason'),
  'order',
  'human order numbers resolve the owning customer'
);

SELECT is(
  public.admin_clients_search_v3('SEARCH-123', 0, 20, 'all')->'candidates'->0->>'clientId',
  'a1000000-0000-4000-8000-000000000010',
  'order-number prefix ranks before an order-number substring'
);

SELECT is(
  public.admin_clients_search_v3('SEARCH-123', 0, 20, 'all')->'candidates'->1->>'clientId',
  'a1000000-0000-4000-8000-000000000002',
  'order-number substring follows the competing prefix'
);

SELECT is(
  (public.admin_clients_search_v3('a6000000-0000-4000-8000-000000000001', 0, 20, 'all')->'candidates'->0->>'matchReason'),
  'subscription',
  'subscription identifiers resolve the owning customer'
);

SELECT is(
  (public.admin_clients_search_v3('Aleksandra', 1, 1, 'all')->>'totalCount')::integer,
  4,
  'totalCount is independent from the requested page'
);

SELECT is(
  jsonb_array_length(public.admin_clients_search_v3('Aleksandra', 1, 1, 'all')->'candidates'),
  1,
  'database pagination returns only the requested page size'
);

SELECT is(
  jsonb_array_length(public.admin_clients_search_v3('shared-search@example.test', 2147483647, 50, 'all')->'candidates'),
  0,
  'a maximum integer page uses bigint offset arithmetic and returns an empty page'
);

SELECT is(
  (public.admin_clients_search_v3('shared-search@example.test', 0, 20, 'customer')->>'totalCount')::integer,
  1,
  'lifecycle filtering is applied before count and pagination'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.admin_clients_search_v3(text,integer,integer,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.admin_clients_search_v3(text,integer,integer,text)', 'EXECUTE'),
  'browser roles cannot execute the operator search RPC'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.admin_client_search_normalize(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.admin_client_search_digits(text)', 'EXECUTE'),
  'authenticated writers can execute both expression-index helpers'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.admin_client_search_normalize(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.admin_client_search_digits(text)', 'EXECUTE'),
  'anon cannot execute either expression-index helper'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ UPDATE public.clients
       SET first_name = 'Updated', phone = '+48 500 600 700', updated_at = now()
       WHERE id = 'a1000000-0000-4000-8000-000000000001' $$,
  'authenticated customer can update owned fields used by search expression indexes'
);

RESET ROLE;

SELECT is(
  (SELECT first_name || '|' || phone
     FROM public.clients
    WHERE id = 'a1000000-0000-4000-8000-000000000001'),
  'Updated|+48 500 600 700',
  'authenticated indexed-field update persists the requested values'
);

SET LOCAL ROLE service_role;

SELECT is(
  (public.admin_clients_search_v3('shared-search@example.test', 0, 20, 'all')->>'totalCount')::integer,
  1,
  'service_role can execute the RPC and its private normalization helpers'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
