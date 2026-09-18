-- pgTAP: checkout-recovery inspect is read-only context for dead-token fallback.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(4);

INSERT INTO public.clients (id, email)
VALUES ('91000000-0000-4000-8000-000000000001', 'checkout-inspect@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES (
  '91000000-0000-4000-8000-000000000010',
  '91000000-0000-4000-8000-000000000001',
  30,
  'PLN',
  'active',
  '2026-06-01T00:00:00Z',
  '2026-07-01T00:00:00Z'
);

INSERT INTO public.subscription_cycles (
  id,
  subscription_id,
  cycle_number,
  scheduled_at,
  status,
  engine_idempotency_key,
  retry_attempt
) VALUES (
  '91000000-0000-4000-8000-000000000011',
  '91000000-0000-4000-8000-000000000010',
  1,
  '2026-07-01T00:00:00Z',
  'planned',
  'checkout-recovery-token-inspect-cycle',
  0
);

INSERT INTO public.commerce_orders (
  id,
  client_id,
  currency,
  region_code,
  size_constraint,
  status,
  total_cents, subtotal_cents,
  mode,
  subscription_id,
  subscription_cycle_id
)
VALUES (
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000001',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":21}'::jsonb,
  'pending_payment',
  14900, 14900,
  'subscription_cycle',
  '91000000-0000-4000-8000-000000000010',
  '91000000-0000-4000-8000-000000000011'
);

INSERT INTO public.commerce_checkout_recovery_tokens (
  order_id,
  client_id,
  token_hash,
  expires_at
) VALUES (
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  '2026-07-03T10:00:00Z'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_checkout_recovery_token_validate(
    repeat('a', 64),
    '2026-07-04T10:00:00Z'::timestamptz
  )),
  0,
  'expired token is not recoverable through validate'
);

SELECT is(
  (SELECT token_state FROM public.commerce_checkout_recovery_token_inspect(
    repeat('a', 64),
    '2026-07-04T10:00:00Z'::timestamptz
  )),
  'expired',
  'inspect returns the dead-token state'
);

SELECT is(
  (SELECT subscription_id::text FROM public.commerce_checkout_recovery_token_inspect(
    repeat('a', 64),
    '2026-07-04T10:00:00Z'::timestamptz
  )),
  '91000000-0000-4000-8000-000000000010',
  'inspect preserves subscription id for fallback routing'
);

SELECT is(
  (SELECT count(*)::int FROM public.commerce_checkout_recovery_token_inspect(
    repeat('b', 64),
    '2026-07-04T10:00:00Z'::timestamptz
  )),
  0,
  'unknown token hash returns no inspection row'
);

SELECT * FROM finish();
ROLLBACK;
