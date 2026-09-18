-- pgTAP: subscription.cancelled outbox emission (20260618110000).
--   * the customer self-service RPC emits exactly one customer-sourced
--     subscription.cancelled event (idempotency_key =
--     'subscription_cancelled:<id>', clientId embedded);
--   * a second UPDATE touching status while already cancelled emits nothing more;
--   * system cancellations carry provenance so the handler can skip the
--     voluntary "you cancelled" email.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(11);

INSERT INTO auth.users (id) VALUES ('a1000000-0000-0000-0000-0000000000c1');

INSERT INTO public.clients (id, email, first_name)
VALUES
  ('e0000000-0000-0000-0000-0000000000c1', 'sub-cancelled@example.invalid', 'Sub'),
  ('e0000000-0000-0000-0000-0000000000c2', 'sub-cancelled-refund@example.invalid', 'Refund'),
  ('e0000000-0000-0000-0000-0000000000c3', 'sub-cancelled-sweep@example.invalid', 'Sweep'),
  ('e0000000-0000-0000-0000-0000000000c4', 'sub-cancelled-unknown@example.invalid', 'Unknown');

UPDATE public.clients
   SET auth_user_id = 'a1000000-0000-0000-0000-0000000000c1'
 WHERE id = 'e0000000-0000-0000-0000-0000000000c1';

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at)
VALUES (
  'e1000000-0000-0000-0000-0000000000c1',
  'e0000000-0000-0000-0000-0000000000c1',
  30,
  'PLN',
  'active',
  '2026-06-01T00:00:00Z'
);

-- Customer self-service cancel: emits and is marked customer-sourced by the
-- durable subscription.customer_self_service.cancel event written by the RPC.
SELECT public.customer_self_service_apply_subscription_action(
  'a1000000-0000-0000-0000-0000000000c1',
  'sub-cancelled-customer-rpc',
  'e1000000-0000-0000-0000-0000000000c1',
  'cancel',
  '{"survey":{"reasonCode":"delivery_issue"}}'::jsonb,
  '2026-06-22T10:00:00Z'::timestamptz
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND aggregate_id = 'e1000000-0000-0000-0000-0000000000c1'),
  1, 'self-service cancel emits one subscription.cancelled event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND aggregate_id = 'e1000000-0000-0000-0000-0000000000c1'),
  'subscription_cancelled:e1000000-0000-0000-0000-0000000000c1',
  'idempotency_key is subscription_cancelled:<subscription id>');

SELECT is(
  (SELECT (payload->>'clientId') FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c1'),
  'e0000000-0000-0000-0000-0000000000c1',
  'payload.clientId mirrors the subscription client');

SELECT is(
  (SELECT (payload->>'cancellationSource') FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c1'),
  'customer',
  'self-service cancellation payload is marked customer sourced');

SELECT is(
  (SELECT (payload->>'cancellationReason') FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c1'),
  'delivery_issue',
  'self-service cancellation payload preserves the survey reason');

SELECT is(
  (SELECT cancellation_source FROM public.subscriptions
    WHERE id = 'e1000000-0000-0000-0000-0000000000c1'),
  'customer_self_service',
  'self-service RPC records a positive cancellation_source marker');

-- already cancelled: a status-touching UPDATE emits nothing more.
UPDATE public.subscriptions SET status = 'cancelled'
 WHERE id = 'e1000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND aggregate_id = 'e1000000-0000-0000-0000-0000000000c1'),
  1, 'a repeat cancelled UPDATE emits nothing more (idempotent + guarded)');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status)
VALUES ('e1000000-0000-0000-0000-0000000000c2', 'e0000000-0000-0000-0000-0000000000c2', 30, 'PLN', 'active');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('e1c00000-0000-0000-0000-0000000000c2', 'e1000000-0000-0000-0000-0000000000c2', 1,
        '2026-06-01T00:00:00Z', 'cancelled', 'sub-cancelled-refund-cycle');
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('e1d00000-0000-0000-0000-0000000000c2', 'e0000000-0000-0000-0000-0000000000c2', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'refunded', 12999, 12999, 'subscription_cycle',
        'e1000000-0000-0000-0000-0000000000c2', 'e1c00000-0000-0000-0000-0000000000c2');
UPDATE public.subscription_cycles
   SET failure_reason = 'refund_reversed_activation'
 WHERE id = 'e1c00000-0000-0000-0000-0000000000c2';

UPDATE public.subscriptions SET status = 'cancelled'
 WHERE id = 'e1000000-0000-0000-0000-0000000000c2';

SELECT is(
  (SELECT payload->>'cancellationSource' FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c2'),
  'system_refund_reversal',
  'refund-reversal cancellation is marked system-sourced');

SELECT is(
  (SELECT payload->>'cancellationReason' FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c2'),
  'refund_reversed_activation',
  'refund-reversal cancellation carries the system reason');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status)
VALUES ('e1000000-0000-0000-0000-0000000000c3', 'e0000000-0000-0000-0000-0000000000c3', 30, 'PLN', 'active');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
VALUES ('e1c00000-0000-0000-0000-0000000000c3', 'e1000000-0000-0000-0000-0000000000c3', 1,
        '2026-06-01T00:00:00Z', 'cancelled', 'sub-cancelled-sweep-cycle');
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id, metadata)
VALUES ('e1d00000-0000-0000-0000-0000000000c3', 'e0000000-0000-0000-0000-0000000000c3', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'cancelled', 12999, 12999, 'subscription_cycle',
        'e1000000-0000-0000-0000-0000000000c3', 'e1c00000-0000-0000-0000-0000000000c3',
        '{"source":"subscription.sweep.v0"}'::jsonb);

UPDATE public.subscriptions SET status = 'cancelled'
 WHERE id = 'e1000000-0000-0000-0000-0000000000c3';

SELECT is(
  (SELECT payload->>'cancellationSource' FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c3'),
  'system_provisional_activation_timeout',
  'provisional activation sweep cancellation is marked system-sourced');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status)
VALUES ('e1000000-0000-0000-0000-0000000000c4', 'e0000000-0000-0000-0000-0000000000c4', 30, 'PLN', 'active');

UPDATE public.subscriptions SET status = 'cancelled'
 WHERE id = 'e1000000-0000-0000-0000-0000000000c4';

SELECT is(
  (SELECT payload->>'cancellationSource' FROM public.outbox_events
    WHERE idempotency_key = 'subscription_cancelled:e1000000-0000-0000-0000-0000000000c4'),
  'system_unknown',
  'unmarked cancellation fails closed as system_unknown');

SELECT * FROM finish();
ROLLBACK;
