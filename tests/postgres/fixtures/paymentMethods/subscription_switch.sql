
BEGIN;
SELECT plan(4);

INSERT INTO public.clients (id, email)
VALUES ('22222222-2222-2222-2222-222222222222', 'pmref-subswitch@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, status, next_cycle_at)
VALUES ('33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222', 30, 'active', now());

INSERT INTO public.payment_method_refs
  (client_id, subscription_id, provider_kind, method_kind, provider_customer_ref, provider_method_ref, status, active)
VALUES ('22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        'stripe', 'card', 'cus_subswitch', 'pm_old_declined', 'active', true);

CREATE TEMP TABLE _switch AS
SELECT public.payment_method_ref_upsert(
  'pmref-subswitch-k1',
  '22222222-2222-2222-2222-222222222222'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'stripe', 'card', 'cus_subswitch', 'pm_new_visa', NULL, 'active',
  true, NULL, '{}'::jsonb, '{}'::jsonb) AS r;

SELECT is(
  (SELECT r #>> '{paymentMethodRef,active}' FROM _switch),
  'true', 'new subscription-bound card upserts as active (no 23505 collision)');

SELECT is(
  (SELECT active FROM public.payment_method_refs
    WHERE provider_kind = 'stripe' AND provider_method_ref = 'pm_old_declined'),
  false, 'the previously-active declined card was deactivated');

SELECT is(
  (SELECT count(*)::int FROM public.payment_method_refs
    WHERE subscription_id = '33333333-3333-3333-3333-333333333333' AND active),
  1, 'exactly one active ref remains for the subscription');

SELECT is(
  (SELECT provider_method_ref FROM public.payment_method_refs
    WHERE subscription_id = '33333333-3333-3333-3333-333333333333'
      AND active = true AND status = 'active'),
  'pm_new_visa', 'the renewal charge would now target the new card');

SELECT * FROM finish();
ROLLBACK;
