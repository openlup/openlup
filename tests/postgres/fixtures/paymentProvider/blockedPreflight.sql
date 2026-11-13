-- Native blocked preflight; assertions retained from the managed witness.

BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email)
VALUES ('cf100000-0000-4000-8000-000000000001', 'blocked-preflight@example.invalid');

SELECT pg_temp.provider_order('cf200000-0000-4000-8000-000000000001','cf100000-0000-4000-8000-000000000001',1234);

CREATE TEMP TABLE _intent AS
SELECT (pg_temp.provider_intent(
  'blocked-preflight-intent-0001',
  'one_time_order',
  'cf200000-0000-4000-8000-000000000001',
  NULL,
  NULL,
  1234,
  'XXX',
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _attempt AS
SELECT public.payment_provider_attempt_record(
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
  (SELECT status FROM public.payment_provider_attempts WHERE id = (SELECT attempt_id FROM _attempt_ids)),
  'blocked_preflight',
  'payment attempt row stores blocked_preflight before apply_result');

SELECT is(
  (SELECT active_attempt_id FROM public.payment_provider_states WHERE id = (SELECT intent_id FROM _intent)),
  (SELECT attempt_id FROM _attempt_ids),
  'blocked_preflight attempt still becomes the active attempt for apply_result');

SELECT is(
  (SELECT count(*)::int
     FROM public.payment_provider_transitions
    WHERE payment_attempt_id = (SELECT attempt_id FROM _attempt_ids)
      AND transition_kind = 'attempt'
      AND to_status = 'blocked_preflight'
      AND reason = 'provider_preflight_blocked'),
  1,
  'state transition records provider_preflight_blocked');

CREATE TEMP TABLE _attempt_replay AS
SELECT public.payment_provider_attempt_record(
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
  $$ SELECT pg_temp.provider_apply(
       'blocked-preflight-apply-0001',
       (SELECT intent_id FROM _intent),
       NULL,
       'failed',
       '2026-07-02T12:00:00Z'::timestamptz,
       'missing_provider_method_ref'
     ) $$,
  'blocked_preflight active attempt can be failed through apply_result');

SELECT is(
  (SELECT status FROM public.payment_provider_states WHERE id = (SELECT intent_id FROM _intent)),
  'failed',
  'apply_result marks the intent failed');

SELECT is(
  (SELECT status FROM public.payment_provider_attempts WHERE id = (SELECT attempt_id FROM _attempt_ids)),
  'failed',
  'apply_result terminalizes the blocked attempt as failed');

SELECT is(
  (SELECT response_payload ->> 'providerCall'
     FROM public.payment_provider_attempts
    WHERE id = (SELECT attempt_id FROM _attempt_ids)),
  'false',
  'attempt keeps providerCall=false evidence after terminalization');

SELECT * FROM finish();
ROLLBACK;
