-- pgTAP: the customer absorbs the lead that holds their address.
--
-- The load-bearing assertion here is a MUTATION -- rows leave one client row and
-- land on another, and one address is freed -- so this suite is written the way
-- a destructive routine has to be proved: the admission is pinned once, and
-- every arm that must refuse instead is pinned beside it, each with an
-- accompanying assertion that nothing moved.
--
-- The happy-path fixture is deliberately NOT an empty shell. 174 of the 177
-- production leads carry a customer_personalization row and consents, so an
-- empty fixture would prove the routine on a case that essentially does not
-- occur. This one carries personalization, two consents, a source link and a
-- delivery, and the customer independently holds an EARLIER consent of one of
-- those kinds, which is the collision the legal rule exists for.
--
-- NEGATIVE CONTROL. The first two assertions are `has_table` and `has_function`.
-- Without 20260818150000_operator_lead_absorption.sql in the tree neither object
-- exists, so this file fails at assertion one rather than passing vacuously --
-- and every later assertion calls the routine directly, so a suite that somehow
-- reached them would error out instead of reporting green.

BEGIN;
SELECT plan(41);

-- One active operator and one deactivated, so the gate has its pair.
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES
  ('07a00000-0000-4000-8000-000000000001', true),
  ('07a00000-0000-4000-8000-000000000002', false);

INSERT INTO auth.users (id) VALUES ('07000000-0000-4000-8000-000000000001');

INSERT INTO public.clients (id, email) VALUES
  ('07100000-0000-4000-8000-000000000001', 'absorb-customer@example.invalid'),
  ('07100000-0000-4000-8000-000000000002', 'absorb-lead@example.invalid'),
  ('07100000-0000-4000-8000-000000000003', 'absorb-commercial@example.invalid'),
  ('07100000-0000-4000-8000-000000000005', 'absorb-unclassified@example.invalid'),
  ('07100000-0000-4000-8000-000000000006', 'absorb-second-lead@example.invalid');

-- The lead with an authorization identity: never absorbed, whatever it carries.
INSERT INTO public.clients (id, email, auth_user_id) VALUES
  ('07100000-0000-4000-8000-000000000004', 'absorb-identity@example.invalid',
   '07000000-0000-4000-8000-000000000001');

-- The production-typical lead: a generated name form, consents, attribution and
-- a message already sent to the address.
INSERT INTO public.customer_personalization (client_id, owner_name_raw, source)
VALUES ('07100000-0000-4000-8000-000000000002', 'Ala', 'dictionary');
INSERT INTO public.client_consents (client_id, consent_type, granted, captured_at) VALUES
  ('07100000-0000-4000-8000-000000000002', 'marketing', true, '2026-01-01T00:00:00Z'),
  ('07100000-0000-4000-8000-000000000002', 'gdpr', true, '2026-01-01T00:00:00Z');
INSERT INTO public.client_source_links (client_id, source_table, source_key)
VALUES ('07100000-0000-4000-8000-000000000002', 'waitlist', 'absorb-lead@example.invalid');
INSERT INTO public.communication_email_deliveries (
  client_id, purpose, template_slug, trigger_source, trigger_event, dedupe_key)
VALUES ('07100000-0000-4000-8000-000000000002', 'marketing_newsletter',
        'absorb-lead-note', 'absorb-lead-test', 'absorb-lead-test', 'absorb-lead-delivery-1');

-- The customer already granted gdpr, and granted it EARLIER than the lead did.
INSERT INTO public.client_consents (client_id, consent_type, granted, captured_at)
VALUES ('07100000-0000-4000-8000-000000000001', 'gdpr', true, '2025-06-01T00:00:00Z');

-- The commercial lead: one delivery address is enough to make it not a shell,
-- because an address is where a parcel physically goes for a specific record.
INSERT INTO public.addresses (client_id, kind, line1, city, postal_code)
VALUES ('07100000-0000-4000-8000-000000000003', 'shipping',
        'Absorpcyjna 1', 'Warszawa', '00-001');

-- Membership that keys on its own address-unique tables and holds no reference
-- to clients at all; absorption must be unable to reach it.
INSERT INTO public.waitlist (email, first_name, marketing_launch_offer_consent)
VALUES ('absorb-lead@example.invalid', 'Ala', true);
INSERT INTO public.testers (
  first_name, last_name, email, phone, street, postal_code, city, country,
  gdpr_consent, verification_consent)
VALUES ('Ala', 'Nowak', 'absorb-tester@example.invalid', '+48500100200',
        'Testowa 1', '00-001', 'Warszawa', 'ZZ', true, true);

-- ---------------------------------------------------------------------------
-- Negative control: neither object exists without the forward under test.
-- ---------------------------------------------------------------------------

SELECT has_table('public', 'client_absorption_policy',
  'the seeded classification the routine reads at run time exists');

SELECT has_function(
  'public', 'customer_support_absorb_lead_v1',
  ARRAY['uuid', 'uuid', 'uuid', 'text', 'text', 'timestamptz'],
  'the absorption exists with the operator id first, as every operator routine does');

-- Fail-closed only works if the shipped seed actually covers what exists today.
SELECT is(
  (SELECT count(*)::int
     FROM pg_catalog.pg_constraint AS fk
     JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
     JOIN pg_catalog.pg_namespace AS referencing_schema
       ON referencing_schema.oid = referencing.relnamespace
    WHERE fk.contype = 'f'
      AND fk.confrelid = 'public.clients'::regclass
      AND referencing_schema.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM public.client_absorption_policy AS policy_row
         WHERE policy_row.table_name = referencing.relname)),
  0,
  'every table referencing clients today is classified, so the shipped seed refuses nothing by accident');

-- ---------------------------------------------------------------------------
-- The absorption itself, on the shape production actually holds.
-- ---------------------------------------------------------------------------

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000002',
    'absorb-lead@example.invalid',
    'absorb-lead-happy-path-1',
    now()
  )->>'outcome',
  'applied',
  'a lead carrying personalization, consents, attribution and a delivery is absorbed');

SELECT is(
  (SELECT response->>'carried'
     FROM public.customer_support_subscription_commands
    WHERE idempotency_key = 'absorb-lead-happy-path-1')::jsonb,
  '{"personalization": 1, "consents": 1, "sourceLinks": 1, "deliveries": 1}'::jsonb,
  'the receipt counts exactly what moved: the later duplicate consent is not among it');

SELECT is(
  (SELECT count(*)::int FROM public.customer_personalization
    WHERE client_id = '07100000-0000-4000-8000-000000000001'),
  1,
  'the generated name form lands on the customer');

SELECT is(
  (SELECT count(*)::int FROM public.customer_personalization
    WHERE client_id = '07100000-0000-4000-8000-000000000002'),
  0,
  'and no longer hangs off the absorbed record');

SELECT is(
  (SELECT source_key FROM public.client_source_links
    WHERE client_id = '07100000-0000-4000-8000-000000000001'),
  'absorb-lead@example.invalid',
  'campaign attribution travels instead of being stranded');

SELECT is(
  (SELECT count(*)::int FROM public.communication_email_deliveries
    WHERE client_id = '07100000-0000-4000-8000-000000000001'),
  1,
  'the delivery timeline of the address joins the customer history');

-- ---------------------------------------------------------------------------
-- Consents are a legal record: unioned, earlier grant kept, nothing deleted.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM public.client_consents
    WHERE client_id = '07100000-0000-4000-8000-000000000001'
      AND consent_type = 'marketing'),
  1,
  'a consent kind the customer did not hold is carried');

SELECT is(
  (SELECT min(captured_at) FROM public.client_consents
    WHERE client_id = '07100000-0000-4000-8000-000000000001'
      AND consent_type = 'gdpr'),
  '2025-06-01T00:00:00Z'::timestamptz,
  'a same-kind collision keeps the earlier grant as the one the customer holds');

SELECT is(
  (SELECT count(*)::int FROM public.client_consents
    WHERE client_id = '07100000-0000-4000-8000-000000000001'
      AND consent_type = 'gdpr'),
  1,
  'the later duplicate is not stacked onto the customer as a second answer');

SELECT is(
  (SELECT count(*)::int FROM public.client_consents
    WHERE client_id = '07100000-0000-4000-8000-000000000002'
      AND consent_type = 'gdpr'),
  1,
  'and it is not destroyed either: it stays on the archived record as evidence');

SELECT is(
  (SELECT value_before || ' -> ' || value_after
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'absorb-lead-happy-path-1'
      AND requested_action = 'absorb_lead_consent_conflict'),
  'gdpr@2026-01-01 00:00:00+00 -> gdpr@2025-06-01 00:00:00+00',
  'the audit records both sides of the collision, not only the winner');

-- ---------------------------------------------------------------------------
-- The archive, and the address it releases.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT email FROM public.clients WHERE id = '07100000-0000-4000-8000-000000000002'),
  'absorbed+07100000000040008000000000000002@absorbed.invalid',
  'the absorbed address becomes a tombstone in the reserved .invalid namespace');

SELECT is(
  (SELECT metadata #>> '{absorption,originalEmail}'
     FROM public.clients WHERE id = '07100000-0000-4000-8000-000000000002'),
  'absorb-lead@example.invalid',
  'the original address survives on the archived row as consent evidence');

SELECT is(
  (SELECT outcome || '|' || value_before || '|' || value_after
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'absorb-lead-happy-path-1'
      AND requested_action = 'absorb_lead'),
  'applied|absorb-lead@example.invalid|absorbed+07100000000040008000000000000002@absorbed.invalid',
  'the audit names the address before and the tombstone after');

SELECT is(
  public.customer_support_correct_subject_email_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    'absorb-customer@example.invalid',
    'absorb-lead@example.invalid',
    'absorb-lead-then-correct-1',
    now()
  )->>'outcome',
  'applied',
  'the released address is then takeable by the correction that was refused before');

-- ---------------------------------------------------------------------------
-- Membership that keys on its own tables is out of reach by construction.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM public.waitlist
    WHERE email = 'absorb-lead@example.invalid'),
  1,
  'waitlist membership on the absorbed address is untouched');

SELECT is(
  (SELECT count(*)::int FROM public.testers
    WHERE email = 'absorb-tester@example.invalid'),
  1,
  'tester membership is untouched');

-- ---------------------------------------------------------------------------
-- Replay and re-run.
-- ---------------------------------------------------------------------------

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000002',
    'absorb-lead@example.invalid',
    'absorb-lead-happy-path-1',
    now()
  )->>'outcome',
  'replayed',
  'the settled idempotency key replays rather than absorbing twice');

SELECT is(
  (SELECT count(*)::int FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'absorb-lead-happy-path-1'
      AND requested_action = 'absorb_lead'),
  1,
  'the replay writes no second audit row');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000002',
    'absorb-lead@example.invalid',
    'absorb-lead-rerun-key-1',
    now()
  )->>'outcome',
  'noop',
  'an already-absorbed pair under a fresh key is a settled fact, not a stale expectation');

-- ---------------------------------------------------------------------------
-- Every refusal arm, and the proof that nothing moved with it.
-- ---------------------------------------------------------------------------

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000004',
    'absorb-identity@example.invalid',
    'absorb-lead-identity-1',
    now()
  )->>'refusalCode',
  'lead_has_identity',
  'a lead carrying an authorization identity is refused: absorbing one is an account takeover');

SELECT is(
  (SELECT email FROM public.clients WHERE id = '07100000-0000-4000-8000-000000000004'),
  'absorb-identity@example.invalid',
  'the refused identity keeps its address');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000003',
    'absorb-commercial@example.invalid',
    'absorb-lead-commercial-1',
    now()
  )->'blockingTables',
  '["addresses"]'::jsonb,
  'a lead with a commercial row is refused and the refusal names what it found');

SELECT is(
  (SELECT client_id::text FROM public.addresses
    WHERE client_id = '07100000-0000-4000-8000-000000000003'),
  '07100000-0000-4000-8000-000000000003',
  'the blocking row stays exactly where it was');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-0000000000ff',
    'absorb-nobody@example.invalid',
    'absorb-lead-missing-lead-1',
    now()
  )->>'refusalCode',
  'lead_not_found',
  'an unknown lead is refused by name');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-0000000000ff',
    '07100000-0000-4000-8000-000000000006',
    'absorb-second-lead@example.invalid',
    'absorb-lead-missing-customer-1',
    now()
  )->>'refusalCode',
  'customer_not_found',
  'an unknown customer is refused by name');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000006',
    'not-the-address-the-console-showed@example.invalid',
    'absorb-lead-stale-1',
    now()
  )->>'outcome',
  'conflict',
  'a stale address expectation conflicts so the operator re-reads instead of absorbing blind');

-- ---------------------------------------------------------------------------
-- The customer already occupies a carry table's own key: theirs is kept.
-- ---------------------------------------------------------------------------

INSERT INTO public.customer_personalization (client_id, owner_name_raw, source)
VALUES ('07100000-0000-4000-8000-000000000006', 'Ola', 'llm');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000006',
    'absorb-second-lead@example.invalid',
    'absorb-lead-personalization-clash-1',
    now()
  )->'carried'->>'personalization',
  '0',
  'a carry table the customer already occupies moves nothing rather than overwriting');

SELECT is(
  (SELECT owner_name_raw FROM public.customer_personalization
    WHERE client_id = '07100000-0000-4000-8000-000000000001'),
  'Ala',
  'the customer keeps the row they already had');

SELECT is(
  (SELECT value_before || '|' || value_after
     FROM public.customer_support_subscription_audit_events
    WHERE idempotency_key = 'absorb-lead-personalization-clash-1'
      AND requested_action = 'absorb_lead_carry_conflict'),
  'customer_personalization|retained_by_customer',
  'and the row that stayed behind is named in the audit rather than lost silently');

-- ---------------------------------------------------------------------------
-- Fail-closed on a table nobody has classified yet, and the one-row answer.
-- ---------------------------------------------------------------------------

CREATE TABLE public.absorption_unclassified_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE
);

INSERT INTO public.absorption_unclassified_probe (client_id)
VALUES ('07100000-0000-4000-8000-000000000005');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000005',
    'absorb-unclassified@example.invalid',
    'absorb-lead-unclassified-1',
    now()
  )->'blockingTables',
  '["absorption_unclassified_probe"]'::jsonb,
  'a referencing table nobody classified blocks the absorption and is named');

SELECT is(
  (SELECT email FROM public.clients WHERE id = '07100000-0000-4000-8000-000000000005'),
  'absorb-unclassified@example.invalid',
  'nothing was mutated while the classification was missing');

-- `retain` is the answer for a table that is the archived record's own history:
-- it neither stops the absorption nor travels with it.
INSERT INTO public.client_absorption_policy (table_name, disposition)
VALUES ('absorption_unclassified_probe', 'retain');

SELECT is(
  public.customer_support_absorb_lead_v1(
    '07a00000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000001',
    '07100000-0000-4000-8000-000000000005',
    'absorb-unclassified@example.invalid',
    'absorb-lead-unclassified-2',
    now()
  )->>'outcome',
  'applied',
  'one policy row answers the refusal: no CREATE OR REPLACE of the routine is needed');

SELECT is(
  (SELECT count(*)::int FROM public.absorption_unclassified_probe
    WHERE client_id = '07100000-0000-4000-8000-000000000005'),
  1,
  'a retained table stays with the archived record: neither a blocker nor a passenger');

-- ---------------------------------------------------------------------------
-- Raised vocabulary, and the cost assumption this wave made.
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$SELECT public.customer_support_absorb_lead_v1(
      '07a00000-0000-4000-8000-000000000002',
      '07100000-0000-4000-8000-000000000001',
      '07100000-0000-4000-8000-000000000003',
      'absorb-commercial@example.invalid',
      'absorb-lead-deactivated-1',
      now())$$,
  '42501',
  NULL,
  'a deactivated operator is refused before any customer state is read');

SELECT throws_ok(
  $$SELECT public.customer_support_absorb_lead_v1(
      '07a00000-0000-4000-8000-000000000001',
      '07100000-0000-4000-8000-000000000001',
      '07100000-0000-4000-8000-000000000001',
      'absorb-customer@example.invalid',
      'absorb-lead-self-1',
      now())$$,
  '22023',
  NULL,
  'absorbing a record into itself is malformed input, not a refusal with a code');

SELECT throws_ok(
  $$SELECT public.customer_support_absorb_lead_v1(
      '07a00000-0000-4000-8000-000000000001',
      '07100000-0000-4000-8000-000000000001',
      '07100000-0000-4000-8000-000000000003',
      'absorb-commercial@example.invalid',
      'absorb-lead-happy-path-1',
      now())$$,
  '23505',
  NULL,
  'a settled key replayed with a different payload is a conflict, not a second absorption');

SELECT is(
  (SELECT prosecdef FROM pg_catalog.pg_proc
    WHERE oid = 'public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure),
  false,
  'the absorption runs with invoker rights: service_role already holds everything it writes');

SELECT * FROM finish();
ROLLBACK;
