-- pgTAP: dunning dispatch claim respects the live dunning case status.

BEGIN;
SELECT plan(2);

INSERT INTO public.clients (id, email)
VALUES ('dd000000-0000-0000-0000-000000000001', 'dunning-case-status@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('dd100000-0000-0000-0000-000000000001', 'dd000000-0000-0000-0000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('dd1c0000-0000-0000-0000-000000000001', 'dd100000-0000-0000-0000-000000000001', 2,
        '2026-06-01T00:00:00Z', 'planned', 'dunning-case-status-cycle', 1);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('dd1d0000-0000-0000-0000-000000000001', 'dd000000-0000-0000-0000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        'dd100000-0000-0000-0000-000000000001', 'dd1c0000-0000-0000-0000-000000000001');

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'dunning-case-status-intent', 'subscription_cycle', 'dd1d0000-0000-0000-0000-000000000001',
  'dd100000-0000-0000-0000-000000000001', 'dd1c0000-0000-0000-0000-000000000001', 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT public.subscription_handle_payment_failure_dunning(
  'dunning-case-status-open',
  'dd1c0000-0000-0000-0000-000000000001',
  'dd100000-0000-0000-0000-000000000001',
  'dd1d0000-0000-0000-0000-000000000001',
  (SELECT intent_id FROM _intent),
  1, '2026-06-20T00:00:00Z'::timestamptz, 'card_declined', '2026-06-12T12:00:00Z'::timestamptz
);

CREATE TEMP TABLE _case AS
SELECT id FROM public.subscription_dunning_cases
 WHERE subscription_id = 'dd100000-0000-0000-0000-000000000001'
 LIMIT 1;

CREATE TEMP TABLE _notif AS
SELECT id FROM public.subscription_dunning_notifications
 WHERE case_id = (SELECT id FROM _case)
   AND recipient_kind = 'customer'
 LIMIT 1;

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  1,
  'open dunning case customer notification is still claimable');

UPDATE public.subscription_dunning_notifications
   SET status = 'queued', send_attempts = 0, scheduled_at = now() - interval '1 second'
 WHERE id = (SELECT id FROM _notif);

UPDATE public.subscription_dunning_cases
   SET status = 'recovered', recovered_at = now(), updated_at = now()
 WHERE id = (SELECT id FROM _case);

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0,
  'recovered dunning case customer notification is not claimable');

SELECT * FROM finish();
ROLLBACK;
