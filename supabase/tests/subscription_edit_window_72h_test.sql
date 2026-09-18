-- pgTAP: subscription edit window widened from 24h to 72h before the planned
-- delivery date (20260714100000_subscription_edit_window_72h).
--   * A subscription row inserted WITHOUT edit_window_hours takes the new
--     column DEFAULT of 72 (this is the Stripe/provisional creation path, which
--     omits the column).
--   * The self-service write RPC enforces the 72h window: an edit requested 36h
--     before the next cycle is rejected as edit_window_closed. Under the old 24h
--     window that same request would have passed the window gate and failed
--     later on the missing accepted quote instead — so this asserts the wider
--     window is actually enforced, not merely displayed.
--   * An edit requested 120h before the next cycle is still outside the window
--     and fails only on the missing accepted quote (quote_not_accepted).
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(3);

INSERT INTO auth.users (id) VALUES ('a0000000-0000-0000-0000-0000000000e7');
INSERT INTO public.clients (id, email, auth_user_id)
VALUES ('c0000000-0000-0000-0000-0000000000e7', 'edit-window-72h@example.invalid', 'a0000000-0000-0000-0000-0000000000e7');

-- Active sub seeded WITHOUT edit_window_hours -> exercises the new DEFAULT 72.
-- next_cycle_at is far enough out that a 24h window would still be open at the
-- "inside 72h" probe time below, isolating the 72h boundary.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at, template_version, payment_method_ref, size_constraint)
VALUES ('5b000000-0000-0000-0000-0000000000e7', 'c0000000-0000-0000-0000-0000000000e7', 28, 'PLN', 'active',
        '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, 'pm_test_e7', '{"kind":"feeding_days","value":28}'::jsonb);

SELECT is(
  (SELECT edit_window_hours FROM public.subscriptions WHERE id = '5b000000-0000-0000-0000-0000000000e7'),
  72,
  'a subscription created without an explicit edit window defaults to 72h');

-- Capture the RPC error text for a template edit at a given request time. Wrapped
-- in an EXCEPTION handler so the raise rolls back to a savepoint and the outer
-- test transaction continues. No accepted-quote payload is supplied, so an OPEN
-- window fails with quote_not_accepted and a CLOSED window fails earlier with
-- edit_window_closed.
CREATE OR REPLACE FUNCTION pg_temp.edit_error(p_requested_at timestamptz)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.customer_self_service_apply_subscription_action(
    'a0000000-0000-0000-0000-0000000000e7'::uuid,
    'ew72-' || extract(epoch FROM p_requested_at)::bigint::text,
    '5b000000-0000-0000-0000-0000000000e7'::uuid,
    'swap_recipe',
    jsonb_build_object(
      'fromVariantId', '55550000-0000-0000-0000-0000000000e1',
      'toVariantId', '55550000-0000-0000-0000-0000000000e2'
    ),
    p_requested_at);
  RETURN 'no_error';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

-- 36h before the 2026-09-01 next cycle: inside the 72h window (cutoff Aug 29 00:00),
-- but a 24h window (cutoff Aug 31 00:00) would still be open here.
SELECT is(
  pg_temp.edit_error('2026-08-30T12:00:00Z'::timestamptz),
  'customer_self_service_edit_window_closed',
  'an edit 36h before the next cycle is rejected by the 72h window');

-- 120h before the next cycle: outside even the 72h window, so the window gate
-- passes and the RPC fails later on the missing accepted quote.
SELECT is(
  pg_temp.edit_error('2026-08-27T00:00:00Z'::timestamptz),
  'customer_self_service_quote_not_accepted',
  'an edit 120h before the next cycle passes the 72h window');

SELECT * FROM finish();
ROLLBACK;
