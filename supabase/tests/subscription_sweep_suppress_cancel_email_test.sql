-- pgTAP: the provisional-abandonment sweeper suppresses the customer cancel-email
-- (20260714210000).
--
-- subscription_sweep_unpaid_provisional reaps a stuck provisional
-- (status='pending_activation') to 'cancelled'. That UPDATE fires
-- trg_subscription_emit_cancelled_outbox (20260618110000). Because the customer never
-- activated the provisional, the sweep pre-seeds the trigger's exactly-once
-- subscription.cancelled outbox row as 'discarded', so no customer cancellation email
-- dispatches. The internal subscription.activation_abandoned audit event is unchanged.
--
--   (a) the provisional is swept to 'cancelled'
--   (b) subscription.activation_abandoned exists in subscription_events (unchanged)
--   (c) the subscription.cancelled outbox row is 'discarded' (not 'pending')
--   (d) zero 'pending' subscription.cancelled events (no customer email)
--
-- Run via: supabase test db

BEGIN;
SELECT plan(4);

INSERT INTO public.clients (id, email)
VALUES ('41111111-1111-4000-8000-000000000001', 'sweep-suppress@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type, name)
VALUES ('42111111-1111-4000-8000-000000000001',
        '41111111-1111-4000-8000-000000000001', 'dog', 'Ghost');

-- Provisional subscription created well before the on-session payment window.
INSERT INTO public.subscriptions (
  id, client_id, pet_id, cadence_days, currency, status, created_at
) VALUES (
  '43111111-1111-4000-8000-000000000001',
  '41111111-1111-4000-8000-000000000001',
  '42111111-1111-4000-8000-000000000001',
  30, 'PLN', 'pending_activation',
  '2020-01-01T00:00:00Z'
);

-- Reap everything older than now (the provisional qualifies).
SELECT public.subscription_sweep_unpaid_provisional('sweep-suppress-test', now(), 50);

SELECT is(
  (SELECT status FROM public.subscriptions
    WHERE id = '43111111-1111-4000-8000-000000000001'),
  'cancelled',
  'the abandoned provisional is swept to cancelled');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_events
    WHERE subscription_id = '43111111-1111-4000-8000-000000000001'
      AND event_type = 'subscription.activation_abandoned'),
  1,
  'the internal subscription.activation_abandoned audit event is emitted (unchanged)');

SELECT is(
  (SELECT status FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND idempotency_key = 'subscription_cancelled:43111111-1111-4000-8000-000000000001'),
  'discarded',
  'the subscription.cancelled outbox row is discarded (no customer cancel-email dispatched)');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND idempotency_key = 'subscription_cancelled:43111111-1111-4000-8000-000000000001'
      AND status = 'pending'),
  0,
  'no pending subscription.cancelled event exists (customer email suppressed)');

SELECT * FROM finish();
ROLLBACK;
