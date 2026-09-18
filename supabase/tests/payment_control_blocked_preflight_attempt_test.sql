-- pgTAP: payment-control can represent failures blocked before any provider
-- call without pretending the attempt was sent to Stripe/Tpay.

BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email)
VALUES ('cf100000-0000-4000-8000-000000000001', 'blocked-preflight@example.invalid');

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES (
  'cf200000-0000-4000-8000-000000000001',
  'cf100000-0000-4000-8000-000000000001',
  'PLN',
  'PL',
  '{"kind":"feeding_days","value":28}'::jsonb,
  'draft',
  1234, 1234,
  'one_time'
);

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'blocked-preflight-intent-0001',
  'one_time_order',
  'cf200000-0000-4000-8000-000000000001',
  NULL,
  NULL,
  1234,
  'PLN',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _attempt AS
SELECT public.commerce_payment_control_record_attempt(
  'blocked-preflight-attempt-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  NULL,
  NULL,
  'blocked_preflight',
  NULL,
  '{"providerFlow":"renewal_preflight"}'::jsonb,
  '{"providerCall":false,"reason":"missing_provider_method_ref"}'::jsonb
) AS response;

CREATE TEMP TABLE _attempt_ids AS
SELECT (response -> 'paymentAttempt' ->> 'id')::uuid AS attempt_id
FROM _attempt;

SELECT is(
  (SELECT response -> 'paymentAttempt' ->> 'status' FROM _attempt),
  'blocked_preflight',
  'record_attempt returns blocked_preflight for provider preflight blockers');

SELECT is(
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt_ids)),
  'blocked_preflight',
  'payment attempt row stores blocked_preflight before apply_result');

SELECT is(
  (SELECT active_attempt_id FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)),
  (SELECT attempt_id FROM _attempt_ids),
  'blocked_preflight attempt still becomes the active attempt for apply_result');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_state_transitions
    WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt_ids)
      AND transition_kind = 'attempt'
      AND to_status = 'blocked_preflight'
      AND reason = 'provider_preflight_blocked'),
  1,
  'state transition records provider_preflight_blocked');

CREATE TEMP TABLE _attempt_replay AS
SELECT public.commerce_payment_control_record_attempt(
  'blocked-preflight-attempt-0001',
  (SELECT intent_id FROM _intent),
  'stripe',
  NULL,
  NULL,
  'blocked_preflight',
  NULL,
  '{"providerFlow":"renewal_preflight"}'::jsonb,
  '{"providerCall":false,"reason":"missing_provider_method_ref"}'::jsonb
) AS response;

SELECT is(
  (SELECT (response -> 'paymentAttempt' ->> 'replayed')::boolean FROM _attempt_replay),
  true,
  'blocked_preflight attempt recording is idempotent');

SELECT lives_ok(
  $$ SELECT public.commerce_payment_control_apply_result(
       'blocked-preflight-apply-0001',
       (SELECT intent_id FROM _intent),
       NULL,
       'failed',
       '2026-07-02T12:00:00Z'::timestamptz,
       'missing_provider_method_ref'
     ) $$,
  'blocked_preflight active attempt can be failed through apply_result');

SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _intent)),
  'failed',
  'apply_result marks the intent failed');

SELECT is(
  (SELECT status FROM public.commerce_payment_attempts WHERE id = (SELECT attempt_id FROM _attempt_ids)),
  'failed',
  'apply_result terminalizes the blocked attempt as failed');

SELECT is(
  (SELECT response_payload ->> 'providerCall'
     FROM public.commerce_payment_attempts
    WHERE id = (SELECT attempt_id FROM _attempt_ids)),
  'false',
  'attempt keeps providerCall=false evidence after terminalization');

SELECT * FROM finish();
ROLLBACK;
