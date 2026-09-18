-- pgTAP: starter-aware freshness window in enqueue_subscription_renewal_reminders.
--
-- The scan fires 3-5 days before a charge and skips a subscription touched in the
-- last 5 days. A starter-pack acquisition charged I = 7 days after payment is
-- ALWAYS inside that 5-day gate when its window opens, so before this migration
-- it could never receive a reminder. This file proves three things at once:
--
--   1. a starter subscription whose 2nd delivery is due DOES get a reminder;
--   2. so does one whose 3rd (graduation) delivery is due;
--   3. an otherwise identical NON-starter subscription still does NOT — the
--      5-day guard is unchanged for every row that carries no marker, which is
--      every row that existed before the starter programme.
--
-- Plus the negative arms that keep the relaxation from becoming a permanent
-- loosening: a starter subscription past its graduation (delivery 4) is back on
-- the 5-day guard, and one touched WITHIN the last day is still skipped.
--
-- Idempotency is re-proven here too: a second scan of the same starter
-- subscription must not mint a second outbox row for the same renewal day.

BEGIN;
SELECT plan(8);

CREATE TEMP TABLE _dates AS
SELECT date_trunc('second', now() + interval '4 days') AS renewal_at;

CREATE TEMP TABLE _marker AS
SELECT jsonb_build_object(
  'schemaVersion', '1',
  'starterIntervalDays', 7,
  'basisTemplateVersion', 1,
  'delivery2', jsonb_build_object(
    'discountBps', 3500,
    'discountMinor', 3150,
    'basisSubtotalMinor', 16800
  ),
  'graduation', jsonb_build_object(
    'cadenceDays', 14,
    'lines', jsonb_build_array(jsonb_build_object(
      'sku', 'starter-window-sku',
      'qty', 28,
      'sortOrder', 0,
      'isAddon', false,
      'quoteLine', jsonb_build_object('lineSubtotalGross', jsonb_build_object('amountMinor', 28000, 'currency', 'PLN'))
    ))
  )
) AS marker;

INSERT INTO public.clients (id, email)
VALUES
  ('bb200000-0000-0000-0000-000000000001', 'starter-window-d2@example.invalid'),
  ('bb200000-0000-0000-0000-000000000002', 'starter-window-d3@example.invalid'),
  ('bb200000-0000-0000-0000-000000000003', 'starter-window-plain@example.invalid'),
  ('bb200000-0000-0000-0000-000000000004', 'starter-window-d4@example.invalid'),
  ('bb200000-0000-0000-0000-000000000005', 'starter-window-fresh@example.invalid');

-- Every row below was touched 2 days ago: too recent for the 5-day guard, old
-- enough for the 1-day starter guard. The ONLY differences between them are the
-- marker and how many cycles they already have.
INSERT INTO public.subscriptions
  (id, client_id, cadence_days, currency, status, next_cycle_at, updated_at, starter_pack)
VALUES
  ('bb210000-0000-0000-0000-000000000001', 'bb200000-0000-0000-0000-000000000001', 7, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '2 days', (SELECT marker FROM _marker)),
  ('bb210000-0000-0000-0000-000000000002', 'bb200000-0000-0000-0000-000000000002', 7, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '2 days', (SELECT marker FROM _marker)),
  ('bb210000-0000-0000-0000-000000000003', 'bb200000-0000-0000-0000-000000000003', 7, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '2 days', NULL),
  ('bb210000-0000-0000-0000-000000000004', 'bb200000-0000-0000-0000-000000000004', 14, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '2 days', (SELECT marker FROM _marker)),
  ('bb210000-0000-0000-0000-000000000005', 'bb200000-0000-0000-0000-000000000005', 7, 'PLN', 'active', (SELECT renewal_at FROM _dates), now() - interval '2 hours', (SELECT marker FROM _marker));

INSERT INTO public.commerce_payment_method_refs
  (client_id, subscription_id, provider_kind, method_kind, provider_customer_ref, provider_method_ref, status, active)
VALUES
  ('bb200000-0000-0000-0000-000000000001', 'bb210000-0000-0000-0000-000000000001', 'stripe', 'card', 'cus_starter_d2', 'pm_starter_d2', 'active', true),
  ('bb200000-0000-0000-0000-000000000002', 'bb210000-0000-0000-0000-000000000002', 'stripe', 'card', 'cus_starter_d3', 'pm_starter_d3', 'active', true),
  ('bb200000-0000-0000-0000-000000000003', 'bb210000-0000-0000-0000-000000000003', 'stripe', 'card', 'cus_starter_plain', 'pm_starter_plain', 'active', true),
  ('bb200000-0000-0000-0000-000000000004', 'bb210000-0000-0000-0000-000000000004', 'stripe', 'card', 'cus_starter_d4', 'pm_starter_d4', 'active', true),
  ('bb200000-0000-0000-0000-000000000005', 'bb210000-0000-0000-0000-000000000005', 'stripe', 'card', 'cus_starter_fresh', 'pm_starter_fresh', 'active', true);

-- Cycle history decides which delivery is upcoming (max(cycle_number) + 1).
INSERT INTO public.subscription_cycles
  (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES
  -- upcoming = 2
  ('bb2c0000-0000-0000-0000-000000000011', 'bb210000-0000-0000-0000-000000000001', 1, now() - interval '3 days', 'paid', 'starter-window-d2-c1', 0),
  -- upcoming = 3
  ('bb2c0000-0000-0000-0000-000000000021', 'bb210000-0000-0000-0000-000000000002', 1, now() - interval '10 days', 'paid', 'starter-window-d3-c1', 0),
  ('bb2c0000-0000-0000-0000-000000000022', 'bb210000-0000-0000-0000-000000000002', 2, now() - interval '3 days', 'paid', 'starter-window-d3-c2', 0),
  -- non-starter control, upcoming = 2
  ('bb2c0000-0000-0000-0000-000000000031', 'bb210000-0000-0000-0000-000000000003', 1, now() - interval '3 days', 'paid', 'starter-window-plain-c1', 0),
  -- graduated already, upcoming = 4
  ('bb2c0000-0000-0000-0000-000000000041', 'bb210000-0000-0000-0000-000000000004', 1, now() - interval '30 days', 'paid', 'starter-window-d4-c1', 0),
  ('bb2c0000-0000-0000-0000-000000000042', 'bb210000-0000-0000-0000-000000000004', 2, now() - interval '20 days', 'paid', 'starter-window-d4-c2', 0),
  ('bb2c0000-0000-0000-0000-000000000043', 'bb210000-0000-0000-0000-000000000004', 3, now() - interval '10 days', 'paid', 'starter-window-d4-c3', 0),
  -- touched two hours ago, upcoming = 2
  ('bb2c0000-0000-0000-0000-000000000051', 'bb210000-0000-0000-0000-000000000005', 1, now() - interval '3 days', 'paid', 'starter-window-fresh-c1', 0);

CREATE TEMP TABLE _first AS
SELECT public.enqueue_subscription_renewal_reminders(500) AS result;

SELECT is(
  (SELECT (result->>'enqueued')::int FROM _first),
  2,
  'exactly the two starter subscriptions inside their 2nd/3rd delivery window are enqueued');

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE event_type = 'subscription.renewal_upcoming'
       AND aggregate_id = 'bb210000-0000-0000-0000-000000000001'
  ),
  'a starter subscription with I=7 gets a delivery-2 reminder despite the 5-day freshness guard');

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE event_type = 'subscription.renewal_upcoming'
       AND aggregate_id = 'bb210000-0000-0000-0000-000000000002'
  ),
  'the same subscription gets a delivery-3 (graduation) reminder after delivery 2 settled');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE event_type = 'subscription.renewal_upcoming'
       AND aggregate_id = 'bb210000-0000-0000-0000-000000000003'
  ),
  'a NON-starter subscription touched two days ago is still skipped: the 5-day guard is unchanged');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE event_type = 'subscription.renewal_upcoming'
       AND aggregate_id = 'bb210000-0000-0000-0000-000000000004'
  ),
  'a starter subscription past its graduation is back on the 5-day guard');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE event_type = 'subscription.renewal_upcoming'
       AND aggregate_id = 'bb210000-0000-0000-0000-000000000005'
  ),
  'a starter subscription edited two hours ago is still skipped by the 1-day guard');

SELECT is(
  (SELECT (public.enqueue_subscription_renewal_reminders(500)->>'enqueued')::int),
  0,
  'a second scan enqueues nothing for the same renewal day');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.renewal_upcoming'),
  2,
  'no duplicate outbox row survives the second scan');

SELECT * FROM finish();
ROLLBACK;
