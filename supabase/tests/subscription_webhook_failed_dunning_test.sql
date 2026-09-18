-- pgTAP: webhook-only failed subscription renewal can open an idempotent dunning case.

BEGIN;
SELECT plan(6);

INSERT INTO public.clients (id, email)
VALUES ('d9010000-0000-4000-8000-000000000001', 'webhook-dunning@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('d9020000-0000-4000-8000-000000000001', 'd9010000-0000-4000-8000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt, next_retry_at)
VALUES ('d9030000-0000-4000-8000-000000000001', 'd9020000-0000-4000-8000-000000000001', 2,
        '2026-06-01T00:00:00Z', 'retry_scheduled', 'webhook-dunning-cycle', 1,
        '2026-06-20T00:00:00Z'::timestamptz);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('d9040000-0000-4000-8000-000000000001', 'd9010000-0000-4000-8000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 12999, 12999, 'subscription_cycle',
        'd9020000-0000-4000-8000-000000000001', 'd9030000-0000-4000-8000-000000000001');

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'webhook-dunning-intent', 'subscription_cycle', 'd9040000-0000-4000-8000-000000000001',
  'd9020000-0000-4000-8000-000000000001', 'd9030000-0000-4000-8000-000000000001', 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _first AS
SELECT public.subscription_open_dunning_from_failed_payment_result(
  'webhook-dunning-event-1',
  (SELECT intent_id FROM _intent),
  'provider-event-1',
  'card_declined',
  '2026-06-12T12:00:00Z'::timestamptz
) AS result;

SELECT ok((SELECT (result #>> '{subscriptionWebhookDunning,opened}')::boolean FROM _first),
  'webhook failure opens subscription dunning');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE subscription_id='d9020000-0000-4000-8000-000000000001'),
  1,
  'one dunning case is created');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_notifications
    WHERE subscription_id='d9020000-0000-4000-8000-000000000001'
      AND recipient_kind='customer'),
  1,
  'customer dunning notification is queued');

CREATE TEMP TABLE _second AS
SELECT public.subscription_open_dunning_from_failed_payment_result(
  'webhook-dunning-event-1',
  (SELECT intent_id FROM _intent),
  'provider-event-1',
  'card_declined',
  '2026-06-12T12:00:00Z'::timestamptz
) AS result;

SELECT ok((SELECT (result #>> '{subscriptionWebhookDunning,replayed}')::boolean FROM _second),
  'replayed webhook dunning call is idempotent');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE subscription_id='d9020000-0000-4000-8000-000000000001'),
  1,
  'replay does not create another case');

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES ('d9040000-0000-4000-8000-000000000002', 'd9010000-0000-4000-8000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 12999, 12999, 'one_time');

CREATE TEMP TABLE _one_time_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'webhook-dunning-one-time-intent', 'one_time_order', 'd9040000-0000-4000-8000-000000000002',
  NULL, NULL, 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT is(
  public.subscription_open_dunning_from_failed_payment_result(
    'webhook-dunning-one-time',
    (SELECT intent_id FROM _one_time_intent),
    'provider-event-no-sub',
    'card_declined',
    '2026-06-12T12:00:00Z'::timestamptz
  ) #>> '{subscriptionWebhookDunning,reason}',
  'not_subscription_cycle',
  'one-time failed webhook is a dunning no-op'
);

SELECT * FROM finish();
ROLLBACK;
