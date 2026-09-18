-- pgTAP (CJ56-1): rescheduling onto the CURRENT delivery day is a no-op — it must
-- not bump updated_at, write a subscription event, or emit a
-- subscription.delivery_rescheduled email. A slide to a DIFFERENT day still
-- follows the legacy true-positive path (mutation + one outbox email).

BEGIN;
SELECT plan(8);

INSERT INTO auth.users (id) VALUES ('7b300000-0000-0000-0000-000000000001');

INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('7b400000-0000-0000-0000-000000000001', 'slide-noop@example.invalid', '7b300000-0000-0000-0000-000000000001');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at,
  template_version, edit_window_hours, payment_method_ref, size_constraint, updated_at
) VALUES (
  '7b500000-0000-0000-0000-000000000001',
  '7b400000-0000-0000-0000-000000000001',
  28, 'PLN', 'active', '2026-09-01T10:00:00Z',
  1, 24, 'pm_slide_noop', '{"kind":"feeding_days","value":28,"mode":"full","portionFactor":1}'::jsonb,
  '2026-01-01T00:00:00Z'
);

-- (1) same calendar day (different slot time) → noop response
SELECT is(
  public.customer_self_service_apply_subscription_action(
    '7b300000-0000-0000-0000-000000000001',
    'slide-noop-same-day',
    '7b500000-0000-0000-0000-000000000001',
    'slide_next_cycle',
    jsonb_build_object('newNextCycleAt', '2026-09-01T08:00:00Z'),
    '2026-07-10T10:00:00Z'::timestamptz
  ) #>> '{subscriptionAction,status}',
  'noop',
  'same-calendar-day slide returns a noop response'
);

-- (2) no updated_at bump
SELECT is(
  (SELECT updated_at FROM public.subscriptions WHERE id = '7b500000-0000-0000-0000-000000000001'),
  '2026-01-01T00:00:00Z'::timestamptz,
  'same-day slide does not bump updated_at'
);

-- (3) no subscription event
SELECT is(
  (SELECT count(*)::int FROM public.subscription_events WHERE idempotency_key = 'slide-noop-same-day'),
  0,
  'same-day slide does not write a subscription event'
);

-- (4) no delivery_rescheduled outbox email
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.delivery_rescheduled'),
  0,
  'same-day slide does not emit a delivery_rescheduled outbox email'
);

-- Real slide to a DIFFERENT day still applies through the legacy path.
SELECT public.customer_self_service_apply_subscription_action(
  '7b300000-0000-0000-0000-000000000001',
  'slide-real-different-day',
  '7b500000-0000-0000-0000-000000000001',
  'slide_next_cycle',
  jsonb_build_object('newNextCycleAt', '2026-09-05T08:00:00Z'),
  '2026-07-10T10:05:00Z'::timestamptz
);

-- (5) next_cycle_at moved to the new day
SELECT is(
  (SELECT next_cycle_at FROM public.subscriptions WHERE id = '7b500000-0000-0000-0000-000000000001'),
  '2026-09-05T08:00:00Z'::timestamptz,
  'real slide updates next_cycle_at to the chosen day'
);

-- (6) exactly one subscription event
SELECT is(
  (SELECT count(*)::int FROM public.subscription_events WHERE idempotency_key = 'slide-real-different-day'),
  1,
  'real slide writes one subscription event'
);

-- (7) exactly one delivery_rescheduled outbox email
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'subscription.delivery_rescheduled'),
  1,
  'real slide emits one delivery_rescheduled outbox email'
);

-- (8) updated_at bumped to the request time
SELECT is(
  (SELECT updated_at FROM public.subscriptions WHERE id = '7b500000-0000-0000-0000-000000000001'),
  '2026-07-10T10:05:00Z'::timestamptz,
  'real slide bumps updated_at to the request time'
);

SELECT * FROM finish();
ROLLBACK;
