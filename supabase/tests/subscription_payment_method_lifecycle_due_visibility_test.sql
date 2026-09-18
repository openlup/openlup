-- pgTAP: what the renewal path can see about a subscription's stored method.
--   * subscription_list_due_for_renewal returns due subscriptions with
--     payment-method lifecycle evidence, including non-usable local refs.
--   * W2 (20260806175058): public.subscription_method_health classifies every
--     active and pending_activation subscription into exactly one health state,
--     so a method that cannot back the NEXT renewal is countable before that
--     renewal is attempted. Banner and header at that section.
--   * W2 (PR-2b): the lifecycle rail's own consumption — the deactivation RPC
--     an inbound revocation/expiry invokes — moves a subscription into that
--     detection, idempotently, and a captured expiry finally reaches the
--     expiring state the column was added for.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(34);

INSERT INTO public.clients (id, email, first_name, last_name) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'pm-life-active@example.invalid', 'Ada', 'Active'),
  ('b1000000-0000-0000-0000-000000000002', 'pm-life-revoked@example.invalid', 'Rita', 'Revoked'),
  ('b1000000-0000-0000-0000-000000000003', 'pm-life-missing@example.invalid', 'Mila', 'Missing'),
  ('b1000000-0000-0000-0000-000000000004', 'pm-life-pending@example.invalid', 'Pola', 'Pending'),
  ('b1000000-0000-0000-0000-000000000005', 'pm-life-expired@example.invalid', 'Ela', 'Expired'),
  ('b1000000-0000-0000-0000-000000000006', 'pm-life-cross-sub@example.invalid', 'Cora', 'Cross'),
  ('b1000000-0000-0000-0000-000000000007', 'pm-life-cross-method@example.invalid', 'Meta', 'Other');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_kind, payment_method_ref
) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_active'),
  ('b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_revoked'),
  ('b2000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000003', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', NULL, NULL),
  ('b2000000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000004', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_pending'),
  ('b2000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000005', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_expired'),
  ('b2000000-0000-0000-0000-000000000006', 'b1000000-0000-0000-0000-000000000006', 28, 'PLN', 'active', '2026-06-01T00:00:00Z', 'card', 'pm_cross');

INSERT INTO public.commerce_payment_method_refs (
  client_id, subscription_id, provider_kind, method_kind, provider_customer_ref,
  provider_method_ref, status, active, expires_at
) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'stripe', 'card', 'cus_active', 'pm_active', 'active', true, NULL),
  ('b1000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 'stripe', 'card', 'cus_revoked', 'pm_revoked', 'revoked', false, NULL),
  ('b1000000-0000-0000-0000-000000000004', 'b2000000-0000-0000-0000-000000000004', 'stripe', 'card', 'cus_pending', 'pm_pending', 'pending_verification', false, NULL),
  ('b1000000-0000-0000-0000-000000000005', 'b2000000-0000-0000-0000-000000000005', 'stripe', 'card', 'cus_expired', 'pm_expired', 'active', true, '2020-01-01T00:00:00Z'),
  ('b1000000-0000-0000-0000-000000000007', 'b2000000-0000-0000-0000-000000000006', 'stripe', 'card', 'cus_cross', 'pm_cross', 'active', true, NULL);

CREATE TEMP TABLE _due AS
SELECT *
  FROM public.subscription_list_due_for_renewal(20)
 WHERE subscription_id::text LIKE 'b2000000-%';

SELECT is((SELECT count(*)::int FROM _due), 6, 'due RPC returns active subscriptions even with non-usable or missing payment methods');

SELECT is(
  (SELECT provider_method_ref FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000001'),
  'pm_active',
  'active same-client method keeps raw provider ref for charge path');

SELECT is(
  (SELECT method_status FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000002'),
  'revoked',
  'revoked method status is visible to preflight');

SELECT is(
  (SELECT provider_method_ref FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000002'),
  NULL,
  'revoked method does not expose raw provider ref to charge path');

SELECT is(
  (SELECT method_status FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000003'),
  NULL,
  'missing method row is visible with null method status');

SELECT is(
  (SELECT method_status FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000004'),
  'pending_verification',
  'pending verification method is visible for requires-action preflight');

SELECT is(
  (SELECT method_expires_at FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000005'),
  '2020-01-01T00:00:00Z'::timestamptz,
  'expired active method carries expiry evidence for resolver');

SELECT is(
  (SELECT provider_method_ref FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000006'),
  NULL,
  'cross-client method ref is not exposed as chargeable provider ref');

SELECT is(
  (SELECT method_client_id FROM _due WHERE subscription_id = 'b2000000-0000-0000-0000-000000000006'),
  'b1000000-0000-0000-0000-000000000007'::uuid,
  'cross-client method evidence remains visible so resolver can fail closed');

-- ===========================================================================
-- W2 METHOD-HEALTH VIEW (PR-2c of the dunning-hardening program)
-- Appended to this suite instead of a standalone file for two reasons. The
-- thematic one: this file already owns "what the renewal path can see about a
-- stored method", and the view is the standing form of the same question. The
-- mechanical one: the OSS readiness receipt freezes this surface family's
-- provider-token count at its exact current value, and the neutrality scanner
-- charges one token for the PATH of every new file in this directory tree, so
-- a new standalone test file cannot land without a further receipt amendment.
-- Header follows.
-- ===========================================================================
--
-- pgTAP: public.subscription_method_health (20260806175058) classifies every
-- active and pending_activation subscription into exactly one health state.
--
-- These cases are the SQL half of the equality claimed by that migration's
-- header: the view's mandate predicate must agree with readMandateRecurringModel
-- in server/domains/subscription/chargeSubscriptionCycleOffSessionHelpers.ts,
-- which treats any model other than 'O' as not chargeable unattended and treats
-- an unreadable model as not-'O'. A view cannot call TS, so the agreement is
-- pinned here rather than by an import.
--
-- Fixtures use neutral literals ('simulator', 'XTS', 'ZZ') because the view
-- reads none of them; claiming a real rail, currency or region here would
-- assert a dependency that does not exist.

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

-- Column list matches the CURRENT subscriptions schema, which is not the one the
-- table was created with: 20260604172000 (own-engine realignment) DROPped
-- provider_kind, because a subscription is a local template here and no longer a
-- provider mirror. The rail lives on commerce_payment_method_refs, which is where
-- the view reads it from.
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, next_cycle_at
) VALUES
  ('b3000000-0000-0000-0000-000000000011', 'b1000000-0000-0000-0000-000000000011', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000012', 'b1000000-0000-0000-0000-000000000012', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000013', 'b1000000-0000-0000-0000-000000000013', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000014', 'b1000000-0000-0000-0000-000000000014', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000015', 'b1000000-0000-0000-0000-000000000015', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000016', 'b1000000-0000-0000-0000-000000000016', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000017', 'b1000000-0000-0000-0000-000000000017', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-000000000018', 'b1000000-0000-0000-0000-000000000018', 28, 'XTS', 'ZZ', 'pending_activation', NULL),
  ('b3000000-0000-0000-0000-000000000019', 'b1000000-0000-0000-0000-000000000019', 28, 'XTS', 'ZZ', 'cancelled', NULL),
  ('b3000000-0000-0000-0000-00000000001a', 'b1000000-0000-0000-0000-00000000001a', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z'),
  ('b3000000-0000-0000-0000-00000000001b', 'b1000000-0000-0000-0000-00000000001b', 28, 'XTS', 'ZZ', 'active', '2026-09-01T00:00:00Z');

INSERT INTO public.commerce_payment_method_refs (
  client_id, subscription_id, provider_kind, method_kind,
  provider_method_ref, status, active, expires_at, consent_snapshot
) VALUES
  -- Healthy: usable method, no declared model, no expiry.
  ('b1000000-0000-0000-0000-000000000011', 'b3000000-0000-0000-0000-000000000011', 'simulator', 'card', 'mh_healthy', 'active', true, NULL, '{}'::jsonb),
  -- The class this wave exists for: a stored mandate registered under a model
  -- that cannot be charged unattended. Looks healthy on every other axis.
  ('b1000000-0000-0000-0000-000000000012', 'b3000000-0000-0000-0000-000000000012', 'simulator', 'alias', 'mh_model_m', 'active', true, NULL, '{"recurringModel": "M"}'::jsonb),
  -- The eligible model must NOT be flagged.
  ('b1000000-0000-0000-0000-000000000013', 'b3000000-0000-0000-0000-000000000013', 'simulator', 'alias', 'mh_model_o', 'active', true, NULL, '{"recurringModel": "O"}'::jsonb),
  -- A CARD that declares no model must NOT be flagged. The rail judges a card
  -- credential when the charge is presented and stores no model here, so the
  -- absence is expected and says nothing about chargeability.
  ('b1000000-0000-0000-0000-000000000014', 'b3000000-0000-0000-0000-000000000014', 'simulator', 'card', 'mh_no_model', 'active', true, NULL, '{"acceptedAt": "2026-01-01T00:00:00Z"}'::jsonb),
  -- The silent cohort: a stored MANDATE that never recorded the model it was
  -- registered under. The runtime already refuses it (an unreadable model is
  -- not the unattended-eligible one), so reading it as healthy meant the
  -- customer got no warning before the renewal that could never succeed.
  ('b1000000-0000-0000-0000-00000000001b', 'b3000000-0000-0000-0000-00000000001b', 'simulator', 'alias', 'mh_mandate_no_model', 'active', true, NULL, '{"acceptedAt": "2026-01-01T00:00:00Z"}'::jsonb),
  ('b1000000-0000-0000-0000-000000000016', 'b3000000-0000-0000-0000-000000000016', 'simulator', 'card', 'mh_expiring', 'active', true, now() + interval '10 days', '{}'::jsonb),
  ('b1000000-0000-0000-0000-000000000017', 'b3000000-0000-0000-0000-000000000017', 'simulator', 'card', 'mh_far_expiry', 'active', true, now() + interval '90 days', '{}'::jsonb),
  -- status active but active=false: the table's CHECK permits this, and the
  -- charge path does not treat it as usable, so neither may the view.
  ('b1000000-0000-0000-0000-00000000001a', 'b3000000-0000-0000-0000-00000000001a', 'simulator', 'card', 'mh_inactive', 'active', false, NULL, '{}'::jsonb);

SELECT has_view(
  'public', 'subscription_method_health',
  'W2: the method-health view exists');

-- Browser roles must never read it; the watchdog evidence port is service_role.
SELECT ok(
  NOT has_table_privilege('anon', 'public.subscription_method_health', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscription_method_health', 'SELECT'),
  'W2: anon and authenticated cannot read the view');
SELECT ok(
  has_table_privilege('service_role', 'public.subscription_method_health', 'SELECT'),
  'W2: service_role can read the view');

CREATE TEMP TABLE _mh AS
SELECT *
  FROM public.subscription_method_health
 WHERE subscription_id::text LIKE 'b3000000-%';

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000011'),
  'healthy',
  'W2: a usable method with no declared model and no expiry is healthy');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000012'),
  'mandate_not_chargeable_unattended',
  'W2: a mandate declaring a model other than O cannot back an unattended charge');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000013'),
  'healthy',
  'W2: the unattended-eligible model is not flagged');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000014'),
  'healthy',
  'W2: a card declaring no model is not flagged - the rail judges the credential itself');

-- W3.5 (PR-3h): the class this migration exists for. Same absent key, different
-- evidence shape, opposite verdict.
SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-00000000001b'),
  'mandate_not_chargeable_unattended',
  'W3.5: a stored mandate declaring no model cannot back an unattended charge');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000015'),
  'method_missing',
  'W2: an active subscription with no method ref reads as method_missing');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-00000000001a'),
  'method_missing',
  'W2: a status-active but active=false ref is not a usable method');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000016'),
  'method_expiring',
  'W2: an expiry inside the 30-day window is flagged');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000017'),
  'healthy',
  'W2: an expiry beyond the 30-day window is not flagged');

-- The column is NULL on every production row until the expiry-capture wave
-- lands, so this is the case that must not regress into a fleet-wide alert.
SELECT is(
  (SELECT method_expires_at FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000011'),
  NULL,
  'W2: a NULL expiry stays NULL and reads as not-expiring, never as expired');

SELECT is(
  (SELECT health_state FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000018'),
  'activation_gap',
  'W2: pending_activation without a usable method is an activation gap');

-- The broad gap must not silently claim rows the narrow detector already owns.
SELECT is(
  (SELECT narrow_activation_gap FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000018'),
  false,
  'W2: a gap outside the narrow paid-activation detector is marked as such');

SELECT is(
  (SELECT count(*)::int FROM _mh WHERE subscription_id = 'b3000000-0000-0000-0000-000000000019'),
  0,
  'W2: a cancelled subscription is outside the view entirely');

-- The cross-client ref from the fixture block above is bound to subscription
-- b2000000-...-6, whose client is a different one. The renewal due-list refuses
-- to expose it as chargeable, so the view must not count it as a method either.
SELECT is(
  (SELECT health_state FROM public.subscription_method_health
    WHERE subscription_id = 'b2000000-0000-0000-0000-000000000006'),
  'method_missing',
  'W2: a cross-client method ref reads as no method, matching the charge path');

-- W3.5 (PR-3h): THE ARBITER.
--
-- The same fact is carried by two objects that cannot import each other: the
-- view answers "which subscriptions will fail their next renewal, and why", and
-- public.subscription_method_chargeable_unattended answers "may this one be
-- charged with nobody present". Repairing one alone would have manufactured a
-- divergence in which the watchdog warns about a row the resume rail is happy to
-- promise, or the reverse. Nothing but a matrix asserted across BOTH in one
-- breath can catch that, so the four mandate shapes are compared here as one
-- string. Every fixture below has a NULL expiry on purpose: the two carriers
-- deliberately differ on expiry (the view warns 30 days out, the function
-- refuses only a passed expiry), and folding that difference in would test the
-- wrong axis.
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
  'W3.5: the view verdict and the chargeable-unattended function agree on every mandate shape');

-- Both objects were replaced in place rather than dropped, so their existing
-- grants must have survived. Asserted rather than restated in the migration:
-- a restated GRANT would prove only that the migration ran.
SELECT ok(
  has_function_privilege('service_role',
    'public.subscription_method_chargeable_unattended(uuid, timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.subscription_method_chargeable_unattended(uuid, timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.subscription_method_chargeable_unattended(uuid, timestamptz)', 'EXECUTE'),
  'W3.5: replacing the function in place kept its service-role-only execution');

-- W2 (PR-2b): the lifecycle rail's consumption, proved against the state the
-- watchdog actually reads. A view cannot call the TypeScript that consumes an
-- inbound transition, so what is pinned here is the exact RPC that consumption
-- invokes and the health state that RPC produces. The rail identity in these
-- fixtures is deliberately a neutral one, as the currency already is above: the
-- transition is addressed by (provider_kind, provider_method_ref) and nothing on
-- this path may depend on WHICH rail reported it.

INSERT INTO public.clients (id, email, first_name, last_name) VALUES
  ('b1000000-0000-0000-0000-000000000008', 'pm-life-revoked-rpc@example.invalid', 'Rena', 'Rail'),
  ('b1000000-0000-0000-0000-000000000009', 'pm-life-expiring-window@example.invalid', 'Eva', 'Window'),
  ('b1000000-0000-0000-0000-00000000000a', 'pm-life-expiry-convention@example.invalid', 'Cala', 'Month');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, payment_method_kind, payment_method_ref
) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000008', 28, 'XTS', 'active', now() + interval '7 days', 'card', 'rail_ref_revoked'),
  ('b4000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000009', 28, 'XTS', 'active', now() + interval '7 days', 'card', 'rail_ref_expiring'),
  ('b4000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-00000000000a', 28, 'XTS', 'active', now() + interval '7 days', 'card', 'rail_ref_convention');

INSERT INTO public.commerce_payment_method_refs (
  id, client_id, subscription_id, provider_kind, method_kind, provider_method_ref, status, active, expires_at
) VALUES
  ('b5000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000008', 'b4000000-0000-0000-0000-000000000001', 'lifecycle_rail', 'card', 'rail_ref_revoked', 'active', true, NULL),
  ('b5000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000009', 'b4000000-0000-0000-0000-000000000002', 'lifecycle_rail', 'card', 'rail_ref_expiring', 'active', true, now() + interval '10 days'),
  -- The end-of-expiry-month instant the capture wave writes, stored verbatim.
  ('b5000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-00000000000a', 'b4000000-0000-0000-0000-000000000003', 'lifecycle_rail', 'card', 'rail_ref_convention', 'active', true, '2029-06-30T23:59:59.999Z');

SELECT is(
  (SELECT health_state FROM public.subscription_method_health
    WHERE subscription_id = 'b4000000-0000-0000-0000-000000000001'),
  'healthy',
  'W2: the mandate reads healthy before the revocation arrives');

-- This is the consumption a revoked or expired transition performs, verbatim.
SELECT public.commerce_payment_method_ref_deactivate(
  'provider-webhook:lifecycle_rail:evt_revoked_1:method-lifecycle',
  'b5000000-0000-0000-0000-000000000001'::uuid,
  'method_revoked',
  '{"lifecycleKind":"method_revoked","providerEventId":"evt_revoked_1"}'::jsonb
);

SELECT is(
  (SELECT health_state FROM public.subscription_method_health
    WHERE subscription_id = 'b4000000-0000-0000-0000-000000000001'),
  'method_missing',
  'W2: a revoked mandate leaves the subscription detectable as having no usable method');

SELECT is(
  (SELECT metadata ->> 'deactivationReason' FROM public.commerce_payment_method_refs
    WHERE id = 'b5000000-0000-0000-0000-000000000001'),
  'method_revoked',
  'W2: the neutral lifecycle kind is the recorded deactivation reason');

-- Rail redelivery: the second call must not re-stamp the deactivation instant,
-- because that instant is evidence of when the mandate actually died.
SELECT public.commerce_payment_method_ref_deactivate(
  'provider-webhook:lifecycle_rail:evt_revoked_1:method-lifecycle',
  'b5000000-0000-0000-0000-000000000001'::uuid,
  'method_revoked',
  '{"lifecycleKind":"method_revoked","providerEventId":"evt_revoked_1"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_method_refs
    WHERE id = 'b5000000-0000-0000-0000-000000000001'
      AND active = false
      AND deactivated_at IS NOT NULL),
  1,
  'W2: a redelivered revocation is idempotent and keeps the first deactivation instant');

SELECT is(
  (SELECT health_state FROM public.subscription_method_health
    WHERE subscription_id = 'b4000000-0000-0000-0000-000000000002'),
  'method_expiring',
  'W2: a captured expiry inside the window makes the expiring state reachable at last');

-- The convention pin, in the column the alert reads: valid THROUGH the named
-- month, so the instant stays inside that month and never leaks into the next.
SELECT is(
  (SELECT (method_expires_at >= '2029-06-30T23:59:59Z'::timestamptz
       AND method_expires_at < '2029-07-01T00:00:00Z'::timestamptz)
     FROM public.subscription_method_health
    WHERE subscription_id = 'b4000000-0000-0000-0000-000000000003'),
  true,
  'W2: an end-of-expiry-month instant is stored and projected inside its own month');

SELECT * FROM finish();
ROLLBACK;
