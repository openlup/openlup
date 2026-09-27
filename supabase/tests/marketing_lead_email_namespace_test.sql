-- pgTAP: early marketing personalization never occupies the customer email namespace.
--
-- The positive case keeps the compatibility clients UUID and personalization FK,
-- while the real endpoint moves to communication_contacts. The negative cases pin
-- the fail-closed boundary: Auth and a delivery address both keep the original
-- customer row untouched. The final case uses an address already held by a customer
-- to prove an anonymous personalization submit neither mutates nor resolves that
-- customer.

BEGIN;
SELECT plan(32);

SELECT has_column('public', 'clients', 'identity_kind',
  'clients names the customer versus marketing compatibility namespace');
SELECT has_column('public', 'clients', 'marketing_contact_id',
  'a marketing compatibility row points at the real communication endpoint');
SELECT has_function(
  'public', 'marketing_rehome_client_lead_v1', ARRAY['uuid', 'timestamptz'],
  'the idempotent fail-closed rehome command exists');
SELECT has_function(
  'public', 'personalization_persist_lead', ARRAY['text', 'text', 'text', 'text', 'text'],
  'the early personalization writer keeps its compatibility signature');
SELECT ok(
  (SELECT convalidated FROM pg_constraint
    WHERE conname = 'clients_marketing_contact_id_fkey'),
  'the marketing contact foreign key is validated by the follow-up forward');
SELECT ok(
  (SELECT convalidated FROM pg_constraint
    WHERE conname = 'clients_identity_kind_check'),
  'the identity discriminator check is validated by the follow-up forward');
SELECT ok(
  (SELECT convalidated FROM pg_constraint
    WHERE conname = 'clients_marketing_contact_shape_check'),
  'the customer-versus-marketing shape check is validated by the follow-up forward');

SELECT is(
  has_function_privilege('anon', 'public.marketing_rehome_client_lead_v1(uuid,timestamptz)', 'EXECUTE'),
  false,
  'anon cannot invoke the bulk-data compatibility command');
SELECT is(
  has_function_privilege('authenticated', 'public.personalization_persist_lead(text,text,text,text,text)', 'EXECUTE'),
  false,
  'browser identities cannot invoke the service-role personalization writer');
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES ('08a00000-0000-4000-8000-000000000001', true);

INSERT INTO auth.users (id)
VALUES ('08000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (
  id, email, first_name, acquisition_source
) VALUES (
  '08100000-0000-4000-8000-000000000001',
  'namespace-customer-old@example.invalid',
  'Customer',
  'social_signup'
), (
  '08100000-0000-4000-8000-000000000002',
  'namespace-lead-target@example.invalid',
  'Lead',
  'hidden_configurator'
), (
  '08100000-0000-4000-8000-000000000003',
  'namespace-commercial@example.invalid',
  'Commercial',
  'hidden_configurator'
);

INSERT INTO public.clients (
  id, email, first_name, acquisition_source, auth_user_id
) VALUES (
  '08100000-0000-4000-8000-000000000004',
  'namespace-identity@example.invalid',
  'Identity',
  'hidden_configurator',
  '08000000-0000-4000-8000-000000000001'
);

INSERT INTO public.customer_personalization (client_id, owner_name_raw, source)
VALUES ('08100000-0000-4000-8000-000000000002', 'Lead', 'dictionary');

INSERT INTO public.addresses (client_id, kind, line1, city, postal_code)
VALUES (
  '08100000-0000-4000-8000-000000000003',
  'shipping',
  'Customer footprint 1',
  'Warszawa',
  '00-001'
);

SELECT is(
  public.marketing_rehome_client_lead_v1(
    '08100000-0000-4000-8000-000000000002', now()
  )->>'outcome',
  'applied',
  'a personalization-only hidden-configurator shell is rehomed');

SELECT is(
  (SELECT normalized_email
     FROM public.communication_contacts
    WHERE id = (SELECT marketing_contact_id FROM public.clients
                 WHERE id = '08100000-0000-4000-8000-000000000002')),
  'namespace-lead-target@example.invalid',
  'the communication contact preserves the real marketing endpoint');

SELECT ok(
  (SELECT email ~ '^lead\+[0-9a-f]{32}@marketing\.invalid$'
     FROM public.clients
    WHERE id = '08100000-0000-4000-8000-000000000002'),
  'the compatibility row receives a deterministic reserved address');

SELECT is(
  (SELECT identity_kind || '|' || (marketing_contact_id IS NOT NULL)::text
     FROM public.clients
    WHERE id = '08100000-0000-4000-8000-000000000002'),
  'marketing_lead|true',
  'the rehomed row is explicit and points at its contact');

SELECT is(
  (SELECT count(*)::int FROM public.customer_personalization
    WHERE client_id = '08100000-0000-4000-8000-000000000002'),
  1,
  'personalization stays on the same compatibility UUID');

SELECT is(
  (SELECT count(*)::int FROM public.communication_contact_links
    WHERE source_system = 'platform'
      AND source_table = 'clients'
      AND source_id = '08100000-0000-4000-8000-000000000002'),
  1,
  'the communication source link records the marketing subject');

SELECT is(
  public.marketing_rehome_client_lead_v1(
    '08100000-0000-4000-8000-000000000002', now()
  )->>'outcome',
  'noop',
  'rehome is idempotent');

SELECT is(
  public.marketing_rehome_client_lead_v1(
    '08100000-0000-4000-8000-000000000003', now()
  )->>'refusalCode',
  'client_has_customer_footprint',
  'a delivery address refuses reclassification by substance');

SELECT is(
  (SELECT email FROM public.clients
    WHERE id = '08100000-0000-4000-8000-000000000003'),
  'namespace-commercial@example.invalid',
  'a commercially referenced row keeps its real address');

DELETE FROM public.addresses
 WHERE client_id = '08100000-0000-4000-8000-000000000003';

SELECT is(
  public.marketing_rehome_client_lead_v1(
    '08100000-0000-4000-8000-000000000003', now()
  )->>'outcome',
  'applied',
  'the residual clears only after the row passes the original classifier');

SELECT is(
  public.marketing_rehome_client_lead_v1(
    '08100000-0000-4000-8000-000000000004', now()
  )->>'refusalCode',
  'client_has_identity',
  'an Auth-linked row refuses reclassification');

SELECT is(
  (SELECT email FROM public.clients
    WHERE id = '08100000-0000-4000-8000-000000000004'),
  'namespace-identity@example.invalid',
  'an Auth-linked row keeps its real address');

SELECT is(
  public.customer_support_correct_subject_email_v1(
    '08a00000-0000-4000-8000-000000000001',
    '08100000-0000-4000-8000-000000000001',
    'namespace-customer-old@example.invalid',
    'namespace-lead-target@example.invalid',
    'namespace-customer-correction-1',
    now()
  )->>'outcome',
  'applied',
  'the customer can immediately claim the address released by a marketing shell');

SELECT is(
  (SELECT email FROM public.clients
    WHERE id = '08100000-0000-4000-8000-000000000001'),
  'namespace-lead-target@example.invalid',
  'the claimed address is stored on the customer');

CREATE TEMP TABLE namespace_results (
  name text PRIMARY KEY,
  result jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO namespace_results (name, result) VALUES
  ('fresh-first', public.personalization_persist_lead(
    'Fresh-Marketing@example.invalid', 'Fresh', 'Lead', '+48500100200', NULL)),
  ('fresh-second', public.personalization_persist_lead(
    'fresh-marketing@example.invalid', 'Fresh', 'Lead', '+48500100200', NULL)),
  ('customer-overlap', public.personalization_persist_lead(
    'namespace-lead-target@example.invalid', 'Attacker', 'Overwrite', '+48500999999', NULL));

SELECT is(
  (SELECT result->>'matchReason' FROM namespace_results WHERE name = 'fresh-first'),
  'marketing_lead_created',
  'a fresh early submit creates a marketing subject');

SELECT is(
  (SELECT identity_kind || '|' || (email LIKE '%@marketing.invalid')::text
     FROM public.clients
    WHERE id = (SELECT (result->>'clientId')::uuid FROM namespace_results
                WHERE name = 'fresh-first')),
  'marketing_lead|true',
  'the fresh subject never stores the submitted address in clients');

SELECT is(
  (SELECT normalized_email
     FROM public.communication_contacts
    WHERE id = (SELECT marketing_contact_id FROM public.clients
                 WHERE id = (SELECT (result->>'clientId')::uuid
                              FROM namespace_results WHERE name = 'fresh-first'))),
  'fresh-marketing@example.invalid',
  'the fresh endpoint is normalized in communications');

SELECT is(
  (SELECT result->>'clientId' FROM namespace_results WHERE name = 'fresh-first'),
  (SELECT result->>'clientId' FROM namespace_results WHERE name = 'fresh-second'),
  'repeating the normalized endpoint resolves the same marketing subject');

SELECT is(
  (SELECT result->>'matchReason' FROM namespace_results WHERE name = 'fresh-second'),
  'marketing_lead_match_contact',
  'the replay names the contact match rather than customer email matching');

SELECT isnt(
  (SELECT result->>'clientId' FROM namespace_results WHERE name = 'customer-overlap'),
  '08100000-0000-4000-8000-000000000001',
  'an address held by a customer still resolves an independent marketing subject');

SELECT is(
  (SELECT first_name || '|' || email FROM public.clients
    WHERE id = '08100000-0000-4000-8000-000000000001'),
  'Customer|namespace-lead-target@example.invalid',
  'the anonymous overlap neither mutates customer profile data nor its address');

SELECT is(
  (SELECT count(*)::int FROM public.clients
    WHERE lower(email) = 'namespace-lead-target@example.invalid'
      AND identity_kind = 'customer'),
  1,
  'the real address remains unique in the customer namespace');

SELECT is(
  (SELECT count(*)::int FROM public.clients
    WHERE identity_kind = 'marketing_lead'
      AND marketing_contact_id = (
        SELECT id FROM public.communication_contacts
        WHERE normalized_email = 'namespace-lead-target@example.invalid'
      )),
  1,
  'one endpoint has at most one marketing compatibility subject');

SELECT * FROM finish();
ROLLBACK;
