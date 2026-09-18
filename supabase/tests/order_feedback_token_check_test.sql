-- pgTAP: read-only taste/effect review-token state and service-role-only access.

BEGIN;
SELECT plan(8);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('27000000-0000-0000-0000-0000000000a0', 'review-token-check@example.invalid', 'Review', 'Check');

INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency, total_cents, subtotal_cents)
VALUES
  ('27000000-0000-0000-0000-0000000000b1', '27000000-0000-0000-0000-0000000000a0', 'REVIEW-CHECK-1', 'paid', 'one_time', 'PLN', 1000, 1000),
  ('27000000-0000-0000-0000-0000000000b2', '27000000-0000-0000-0000-0000000000a0', 'REVIEW-CHECK-2', 'paid', 'one_time', 'PLN', 1000, 1000);

INSERT INTO public.commerce_order_feedback (
  order_id, token, submitted_at, effect_token, effect_submitted_at
)
VALUES
  ('27000000-0000-0000-0000-0000000000b1', 'taste-ready', NULL, 'effect-used', now()),
  ('27000000-0000-0000-0000-0000000000b2', 'taste-used', now(), 'effect-ready', NULL);

SELECT is(public.check_order_feedback_token('taste-ready')->>'status', 'ready',
  'unused taste token is ready');
SELECT is(public.check_order_feedback_token('effect-ready')->>'status', 'ready',
  'unused effect token is ready');
SELECT is(public.check_order_feedback_token('taste-used')->>'status', 'already_submitted',
  'submitted taste token is already_submitted');
SELECT is(public.check_order_feedback_token('effect-used')->>'status', 'already_submitted',
  'submitted effect token is already_submitted');
SELECT is(public.check_order_feedback_token('missing-token')->>'status', 'not_found',
  'unknown token does not enumerate row data');

SELECT ok(
  has_function_privilege('service_role', 'public.check_order_feedback_token(text)', 'EXECUTE'),
  'service_role can execute the status lookup');
SELECT ok(
  NOT has_function_privilege('anon', 'public.check_order_feedback_token(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.check_order_feedback_token(text)', 'EXECUTE'),
  'browser roles cannot call the SECURITY DEFINER function directly');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_order_feedback
    WHERE submitted_at IS NOT NULL OR effect_submitted_at IS NOT NULL),
  2,
  'status lookups do not mutate submission timestamps');

SELECT * FROM finish();
ROLLBACK;
