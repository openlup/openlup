-- pgTAP: acquisition policy identity is assigned once and then inherited.

BEGIN;
SELECT plan(12);

INSERT INTO public.clients (id, email)
VALUES ('f1000000-0000-0000-0000-000000000001', 'offer-policy@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at
) VALUES (
  'f1100000-0000-0000-0000-000000000001',
  'f1000000-0000-0000-0000-000000000001',
  30, 'PLN', 'pending_activation', NULL
);

SELECT is(
  (SELECT offer_policy_assignment_state FROM public.subscriptions
    WHERE id = 'f1100000-0000-0000-0000-000000000001'),
  'pending_acquisition',
  'a post-migration subscription starts in the acquisition seam'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
) VALUES (
  'f1200000-0000-0000-0000-000000000001',
  'f1100000-0000-0000-0000-000000000001',
  1, '2026-08-01T08:00:00Z', 'planned', 'offer-policy-initial-cycle'
);

SELECT is(
  (SELECT offer_policy_assignment_state FROM public.subscription_cycles
    WHERE id = 'f1200000-0000-0000-0000-000000000001'),
  'pending_acquisition',
  'the initial cycle waits for the same acquisition order'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency,
  subscription_id, subscription_cycle_id, metadata
) VALUES (
  'f1300000-0000-0000-0000-000000000001',
  'f1000000-0000-0000-0000-000000000001',
  'OFFER-POLICY-V2-1', 'pending_payment', 'subscription_cycle', 'PLN',
  'f1100000-0000-0000-0000-000000000001',
  'f1200000-0000-0000-0000-000000000001',
  '{"quoteSnapshot":{"quote":{"context":{"pricingPolicy":{"offerPolicyVersion":"commerce.offer-policy.v2","promotionEngineVersion":"promotion-engine.v2"}}}}}'::jsonb
);

SELECT is(
  (SELECT offer_policy_version FROM public.subscriptions
    WHERE id = 'f1100000-0000-0000-0000-000000000001'),
  'commerce.offer-policy.v2',
  'the acquisition order assigns offer policy v2'
);
SELECT is(
  (SELECT promotion_engine_version FROM public.subscriptions
    WHERE id = 'f1100000-0000-0000-0000-000000000001'),
  'promotion-engine.v2',
  'the acquisition order assigns the paired promotion engine v2'
);
SELECT is(
  (SELECT offer_policy_assignment_state FROM public.subscription_cycles
    WHERE id = 'f1200000-0000-0000-0000-000000000001'),
  'assigned_acquisition',
  'the initial cycle is frozen by the acquisition order'
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
) VALUES (
  'f1200000-0000-0000-0000-000000000002',
  'f1100000-0000-0000-0000-000000000001',
  2, '2026-09-01T08:00:00Z', 'planned', 'offer-policy-renewal-cycle'
);

SELECT is(
  (SELECT offer_policy_version FROM public.subscription_cycles
    WHERE id = 'f1200000-0000-0000-0000-000000000002'),
  'commerce.offer-policy.v2',
  'a renewal cycle inherits the frozen offer policy'
);
SELECT is(
  (SELECT offer_policy_assignment_state FROM public.subscription_cycles
    WHERE id = 'f1200000-0000-0000-0000-000000000002'),
  'inherited',
  'a renewal is marked as inherited rather than newly assigned'
);

SELECT throws_ok(
  $$UPDATE public.subscriptions
       SET offer_policy_version = 'commerce.offer-policy.v1',
           promotion_engine_version = 'promotion-engine.v1'
     WHERE id = 'f1100000-0000-0000-0000-000000000001'$$,
  '23514', 'subscription_offer_policy_immutable',
  'an assigned subscription policy is immutable'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at
) VALUES (
  'f1100000-0000-0000-0000-000000000004',
  'f1000000-0000-0000-0000-000000000001',
  30, 'PLN', 'pending_activation', NULL
);

SELECT throws_ok(
  $$UPDATE public.subscriptions
       SET offer_policy_version = 'commerce.offer-policy.v2',
           promotion_engine_version = 'promotion-engine.v2',
           offer_policy_assignment_state = 'assigned_acquisition'
     WHERE id = 'f1100000-0000-0000-0000-000000000004'$$,
  '23514', 'subscription_offer_policy_immutable',
  'a direct caller cannot impersonate the nested acquisition-order assignment'
);

SELECT throws_ok(
  $$INSERT INTO public.subscriptions (
       id, client_id, cadence_days, currency, status, next_cycle_at,
       offer_policy_version, promotion_engine_version
     ) VALUES (
       'f1100000-0000-0000-0000-000000000003',
       'f1000000-0000-0000-0000-000000000001',
       30, 'PLN', 'active', '2026-09-01T08:00:00Z',
       'commerce.offer-policy.v2', 'promotion-engine.v1'
     )$$,
  '23514', NULL,
  'the subscription pair check rejects v2/v1'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'subscription_cycles_offer_policy_pair_check'
       AND conrelid = 'public.subscription_cycles'::regclass
       AND contype = 'c'
  ),
  'subscription cycles have the paired-version CHECK'
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at,
  offer_policy_assignment_state
) VALUES (
  'f1100000-0000-0000-0000-000000000002',
  'f1000000-0000-0000-0000-000000000001',
  30, 'PLN', 'active', '2026-08-01T08:00:00Z', 'legacy_frozen'
);

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency, subscription_id, metadata
) VALUES (
  'f1300000-0000-0000-0000-000000000002',
  'f1000000-0000-0000-0000-000000000001',
  'OFFER-POLICY-LEGACY-1', 'pending_payment', 'one_time', 'PLN',
  'f1100000-0000-0000-0000-000000000002',
  '{"quoteSnapshot":{"quote":{"context":{"pricingPolicy":{"offerPolicyVersion":"commerce.offer-policy.v2","promotionEngineVersion":"promotion-engine.v2"}}}}}'::jsonb
);

SELECT is(
  (SELECT offer_policy_version || '/' || promotion_engine_version
    FROM public.subscriptions
    WHERE id = 'f1100000-0000-0000-0000-000000000002'),
  'commerce.offer-policy.v1/promotion-engine.v1',
  'a legacy-frozen v1 subscription ignores later v2 order metadata'
);

SELECT * FROM finish();
ROLLBACK;
