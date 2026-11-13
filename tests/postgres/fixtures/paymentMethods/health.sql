BEGIN;
SELECT plan(15);
INSERT INTO public.clients (id, email, first_name, last_name) VALUES
  ('b1000000-0000-0000-0000-000000000011', 'mh-healthy@example.invalid', 'Hana', 'Healthy'),
  ('b1000000-0000-0000-0000-000000000012', 'mh-model-m@example.invalid', 'Mona', 'Mandate'),
  ('b1000000-0000-0000-0000-000000000013', 'mh-model-o@example.invalid', 'Ola', 'Okay'),
  ('b1000000-0000-0000-0000-000000000014', 'mh-no-model@example.invalid', 'Nina', 'Nomodel'),
  ('b1000000-0000-0000-0000-000000000015', 'mh-missing@example.invalid', 'Mira', 'Missing'),
  ('b1000000-0000-0000-0000-000000000016', 'mh-expiring@example.invalid', 'Ewa', 'Expiring'),
  ('b1000000-0000-0000-0000-000000000017', 'mh-far-expiry@example.invalid', 'Fela', 'Far'),
  ('b1000000-0000-0000-0000-000000000018', 'mh-activation@example.invalid', 'Ala', 'Activation'),
  ('b1000000-0000-0000-0000-000000000019', 'mh-cancelled@example.invalid', 'Cela', 'Cancelled'),
  ('b1000000-0000-0000-0000-00000000001a', 'mh-inactive-ref@example.invalid', 'Iga', 'Inactive'),
  ('b1000000-0000-0000-0000-00000000001b', 'mh-mandate-no-model@example.invalid', 'Sara', 'Silent');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, status, next_cycle_at
) VALUES
  ('b3000000-0000-0000-0000-000000000011', 'b1000000-0000-0000-0000-000000000011', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000012', 'b1000000-0000-0000-0000-000000000012', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000013', 'b1000000-0000-0000-0000-000000000013', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000014', 'b1000000-0000-0000-0000-000000000014', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000015', 'b1000000-0000-0000-0000-000000000015', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000016', 'b1000000-0000-0000-0000-000000000016', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000017', 'b1000000-0000-0000-0000-000000000017', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000019', 'b1000000-0000-0000-0000-000000000019', 28, 'cancelled', NULL),
  ('b3000000-0000-0000-0000-00000000001a', 'b1000000-0000-0000-0000-00000000001a', 28, 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-00000000001b', 'b1000000-0000-0000-0000-00000000001b', 28, 'active', '2026-09-01T00:00:00Z');

INSERT INTO public.payment_method_refs (
  client_id, subscription_id, provider_kind, method_kind,
  provider_method_ref, status, active, expires_at, consent_snapshot
) VALUES
  ('b1000000-0000-0000-0000-000000000011', 'b3000000-0000-0000-0000-000000000011', 'simulator', 'card', 'mh_healthy', 'active', true, NULL, '{}'::jsonb),
  ('b1000000-0000-0000-0000-000000000012', 'b3000000-0000-0000-0000-000000000012', 'simulator', 'alias', 'mh_model_m', 'active', true, NULL, '{"recurringModel": "M"}'::jsonb),
  ('b1000000-0000-0000-0000-000000000013', 'b3000000-0000-0000-0000-000000000013', 'simulator', 'alias', 'mh_model_o', 'active', true, NULL, '{"recurringModel": "O"}'::jsonb),
  ('b1000000-0000-0000-0000-000000000014', 'b3000000-0000-0000-0000-000000000014', 'simulator', 'card', 'mh_no_model', 'active', true, NULL, '{"acceptedAt": "2026-01-01T00:00:00Z"}'::jsonb),
  ('b1000000-0000-0000-0000-00000000001b', 'b3000000-0000-0000-0000-00000000001b', 'simulator', 'alias', 'mh_mandate_no_model', 'active', true, NULL, '{"acceptedAt": "2026-01-01T00:00:00Z"}'::jsonb),
  ('b1000000-0000-0000-0000-000000000016', 'b3000000-0000-0000-0000-000000000016', 'simulator', 'card', 'mh_expiring', 'active', true, now() + interval '10 days', '{}'::jsonb),
  ('b1000000-0000-0000-0000-000000000017', 'b3000000-0000-0000-0000-000000000017', 'simulator', 'card', 'mh_far_expiry', 'active', true, now() + interval '90 days', '{}'::jsonb),
  ('b1000000-0000-0000-0000-00000000001a', 'b3000000-0000-0000-0000-00000000001a', 'simulator', 'card', 'mh_inactive', 'active', false, NULL, '{}'::jsonb);

SELECT has_view(
  'public', 'subscription_method_health',
  'the method-health view exists');

SELECT ok(
  NOT has_table_privilege('anon', 'public.subscription_method_health', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscription_method_health', 'SELECT'),
  'anon and authenticated cannot read the view');


CREATE TEMP TABLE _mh AS
SELECT *
  FROM public.subscription_method_health
 WHERE subscription_id::text LIKE 'b3000000-%';

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000011'),
  'healthy',
  'a usable method with no declared model and no expiry is healthy');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000012'),
  'mandate_not_chargeable_unattended',
  'a mandate declaring a model other than O cannot back an unattended charge');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000013'),
  'healthy',
  'the unattended-eligible model is not flagged');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000014'),
  'healthy',
  'a card declaring no model is not flagged - the rail judges the credential itself');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-00000000001b'),
  'mandate_not_chargeable_unattended',
  'a stored mandate declaring no model cannot back an unattended charge');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000015'),
  'method_missing',
  'an active subscription with no method ref reads as method_missing');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-00000000001a'),
  'method_missing',
  'a status-active but active=false ref is not a usable method');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000016'),
  'method_expiring',
  'an expiry inside the 30-day window is flagged');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000017'),
  'healthy',
  'an expiry beyond the 30-day window is not flagged');

SELECT is(
  (SELECT method_expires_at FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000011'),
  NULL,
  'a NULL expiry stays NULL and reads as not-expiring, never as expired');





SELECT is(
  (SELECT count(*)::int FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000019'),
  0,
  'a cancelled subscription is outside the view entirely');



SELECT is(
  (SELECT string_agg(
      subject_row.subject || '=' || health.health_state || '/' ||
        public.subscription_method_chargeable_unattended(subject_row.subscription_id)::text,
      ' ' ORDER BY subject_row.subject)
     FROM (VALUES
       ('1-model-o', 'b3000000-0000-0000-0000-000000000013'::uuid),
       ('2-model-m', 'b3000000-0000-0000-0000-000000000012'::uuid),
       ('3-absent-on-mandate', 'b3000000-0000-0000-0000-00000000001b'::uuid),
       ('4-absent-on-card', 'b3000000-0000-0000-0000-000000000014'::uuid)
     ) AS subject_row(subject, subscription_id)
     JOIN public.subscription_method_health health
       ON health.subscription_id = subject_row.subscription_id),
  '1-model-o=healthy/true'
    || ' 2-model-m=mandate_not_chargeable_unattended/false'
    || ' 3-absent-on-mandate=mandate_not_chargeable_unattended/false'
    || ' 4-absent-on-card=healthy/true',
  'the view verdict and the chargeable-unattended function agree on every mandate shape');

SELECT ok(
  has_function_privilege('postgres',
    'public.subscription_method_chargeable_unattended(uuid, timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.subscription_method_chargeable_unattended(uuid, timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.subscription_method_chargeable_unattended(uuid, timestamptz)', 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.subscription_method_chargeable_unattended(uuid,timestamptz)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'the internal arbiter is owner-callable and browser/PUBLIC closed');

SELECT * FROM finish();
ROLLBACK;
