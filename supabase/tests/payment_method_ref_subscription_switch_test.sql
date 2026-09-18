-- pgTAP: commerce_payment_method_ref_upsert can switch the active method of a
-- subscription that ALREADY has an active, subscription-bound ref (CJ01-O).
--
-- This is the dunning payment-recovery canonical binder: the setup_intent.succeeded
-- webhook upserts the new card bound to the subscription (subscription_id set,
-- active) while the declined card is still the active subscription ref. Before the
-- 20260711120000 deactivate-before-insert fix this raised 23505 on
-- uniq_commerce_payment_method_refs_subscription_active (insert-before-deactivate
-- transiently created two active rows for one subscription), so the new card was
-- never bound and the renewal retry kept charging the stale declined card.
--
-- The pre-existing replayed-semantics test only exercised the client-scoped
-- (subscription_id NULL) switch, which has no matching partial unique index and
-- never surfaced this bug.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(4);

-- ---- Fixture --------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('22222222-2222-2222-2222-222222222222', 'pmref-subswitch@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222', 30, 'PLN', 'active', now());

-- Old declined card: the active, subscription-bound ref present at recovery time.
INSERT INTO public.commerce_payment_method_refs
  (client_id, subscription_id, provider_kind, method_kind, provider_customer_ref, provider_method_ref, status, active)
VALUES ('22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        'stripe', 'card', 'cus_subswitch', 'pm_old_declined', 'active', true);

-- ---- Act: bind the NEW card to the same subscription (webhook upsert shape) --
-- Before the fix this call raised 23505 and aborted the transaction.
CREATE TEMP TABLE _switch AS
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-subswitch-k1',
  '22222222-2222-2222-2222-222222222222'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'stripe', 'card', 'cus_subswitch', 'pm_new_visa', NULL, 'active',
  true, NULL, '{}'::jsonb, '{}'::jsonb) AS r;

-- ---- Assertions -----------------------------------------------------------
SELECT is(
  (SELECT r #>> '{paymentMethodRef,active}' FROM _switch),
  'true', 'new subscription-bound card upserts as active (no 23505 collision)');

SELECT is(
  (SELECT active FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'stripe' AND provider_method_ref = 'pm_old_declined'),
  false, 'the previously-active declined card was deactivated');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_method_refs
    WHERE subscription_id = '33333333-3333-3333-3333-333333333333' AND active),
  1, 'exactly one active ref remains for the subscription');

-- The renewal due-RPC resolves the method via `active = true AND status='active'`.
-- After the switch that must be the NEW card, not the declined one.
SELECT is(
  (SELECT provider_method_ref FROM public.commerce_payment_method_refs
    WHERE subscription_id = '33333333-3333-3333-3333-333333333333'
      AND active = true AND status = 'active'),
  'pm_new_visa', 'the renewal charge would now target the new card');

SELECT * FROM finish();
ROLLBACK;
