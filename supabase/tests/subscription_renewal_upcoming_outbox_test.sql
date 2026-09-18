-- pgTAP: subscription.renewal_upcoming outbox scan candidate truth.
--
-- Proves the new enqueue RPC only targets billable upcoming renewals: active
-- subscription, active payment method, no open payment/retry cycle, unchanged
-- within the reminder window, and one outbox row per subscription renewal day.

BEGIN;
SELECT plan(9);

CREATE TEMP TABLE _dates AS
SELECT date_trunc('second', now() + interval '4 days') AS renewal_at;

INSERT INTO public.clients (id, email)
VALUES
  ('aa200000-0000-0000-0000-000000000001', 'renewal-outbox-ok@example.invalid'),
  ('aa200000-0000-0000-0000-000000000002', 'renewal-outbox-cardless@example.invalid'),
  ('aa200000-0000-0000-0000-000000000003', 'renewal-outbox-inactive-card@example.invalid'),
  ('aa200000-0000-0000-0000-000000000004', 'renewal-outbox-recent-change@example.invalid'),
  ('aa200000-0000-0000-0000-000000000005', 'renewal-outbox-open-cycle@example.invalid');

INSERT INTO public.subscriptions
  (id, client_id, cadence_days, currency, status, next_cycle_at, updated_at)
VALUES
  ('aa210000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000001', 30, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '6 days'),
  ('aa210000-0000-0000-0000-000000000002', 'aa200000-0000-0000-0000-000000000002', 30, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '6 days'),
  ('aa210000-0000-0000-0000-000000000003', 'aa200000-0000-0000-0000-000000000003', 30, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '6 days'),
  ('aa210000-0000-0000-0000-000000000004', 'aa200000-0000-0000-0000-000000000004', 30, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '1 day'),
  ('aa210000-0000-0000-0000-000000000005', 'aa200000-0000-0000-0000-000000000005', 30, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '6 days');

INSERT INTO public.commerce_payment_method_refs
  (client_id, subscription_id, provider_kind, method_kind, provider_customer_ref, provider_method_ref, status, active)
VALUES
  ('aa200000-0000-0000-0000-000000000001', 'aa210000-0000-0000-0000-000000000001', 'stripe', 'card', 'cus_renewal_ok', 'pm_renewal_ok', 'active', true),
  ('aa200000-0000-0000-0000-000000000003', 'aa210000-0000-0000-0000-000000000003', 'stripe', 'card', 'cus_renewal_inactive', 'pm_renewal_inactive', 'inactive', false),
  ('aa200000-0000-0000-0000-000000000004', 'aa210000-0000-0000-0000-000000000004', 'stripe', 'card', 'cus_renewal_recent', 'pm_renewal_recent', 'active', true),
  ('aa200000-0000-0000-0000-000000000005', 'aa210000-0000-0000-0000-000000000005', 'stripe', 'card', 'cus_renewal_cycle', 'pm_renewal_cycle', 'active', true);

INSERT INTO public.subscription_cycles
  (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES
  ('aa2c0000-0000-0000-0000-000000000005', 'aa210000-0000-0000-0000-000000000005', 7, (SELECT renewal_at FROM _dates), 'retry_scheduled', 'renewal-outbox-open-cycle', 1);

CREATE TEMP TABLE _first AS
SELECT public.enqueue_subscription_renewal_reminders(100) AS result;

SELECT is(
  (SELECT (result->>'enqueued')::int FROM _first),
  1,
  'enqueue_subscription_renewal_reminders enqueues exactly the billable unchanged subscription');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  1,
  'only one renewal upcoming outbox event exists');

SELECT is(
  (SELECT aggregate_id FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  'aa210000-0000-0000-0000-000000000001'::uuid,
  'event belongs to the active subscription with an active payment method');

SELECT is(
  (SELECT payload->>'clientId' FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  'aa200000-0000-0000-0000-000000000001',
  'payload carries the client id for recipient resolution');

SELECT is(
  (SELECT payload->>'renewalAt' FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  (SELECT to_char(renewal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM _dates),
  'payload renewalAt is the charge-authoritative candidate timestamp');

SELECT is(
  (SELECT payload->>'dedupeKey' FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  (SELECT 'aa210000-0000-0000-0000-000000000001:' || to_char(renewal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM _dates),
  'payload dedupeKey matches the legacy email_sends renewal day key');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  (SELECT 'subscription_renewal_upcoming:aa210000-0000-0000-0000-000000000001:' || to_char(renewal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM _dates),
  'outbox idempotency key wraps the shared email dedupe key');

SELECT is(
  (SELECT (public.enqueue_subscription_renewal_reminders(100)->>'enqueued')::int),
  0,
  'second enqueue run is idempotent');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  1,
  'idempotent second run does not create a duplicate event');

SELECT * FROM finish();
ROLLBACK;
