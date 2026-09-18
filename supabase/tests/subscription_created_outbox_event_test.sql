-- pgTAP: subscription.created emits on the transition INTO active, not on the
-- provisional pre-payment INSERT (20260630130000, supersedes 20260619110000).
--   * a direct INSERT status='active' (Model A) emits exactly one event with the
--     'subscription_created:<id>' key + clientId/cadenceDays payload;
--   * a provisional INSERT status='pending_activation' emits NOTHING;
--   * a pending_activation -> active UPDATE (Model B) emits exactly one event.
--
--   * a resume (paused -> active) does NOT re-emit, even after the original
--     subscription.created outbox row has been pruned (20260704140000 fix).
--
-- Run via: supabase test db
BEGIN;
SELECT plan(6);

INSERT INTO public.clients (id, email, first_name)
VALUES ('e2000000-0000-0000-0000-0000000000c1', 'sub-created@example.invalid', 'Sub');

-- Template lines for every subscription this test activates. The Model B row is
-- activated by UPDATE, which trg_subscription_guard_active_requires_lines
-- (20260801120100) rejects when the subscription has no lines; the Model A row is
-- given lines for the same reason it has them in production, so the resume
-- regression below exercises a realistic subscription.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('e2000000-0000-0000-0000-0000000000d1', 'sub-created-product', 'Sub Created Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('e2000000-0000-0000-0000-0000000000d2', 'e2000000-0000-0000-0000-0000000000d1', 'SUB-CREATED-SKU', 'Sub Created SKU', 'dog', 'active', 400, 350);

-- Model A: direct INSERT of an already-active subscription emits.
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('e2100000-0000-0000-0000-0000000000c1', 'e2000000-0000-0000-0000-0000000000c1', 30, 'PLN', 'active',
        '2026-07-20T08:00:00Z');
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('e2100000-0000-0000-0000-0000000000c1', 'e2000000-0000-0000-0000-0000000000d2', 1, 0, false, 1);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.created'
      AND aggregate_id = 'e2100000-0000-0000-0000-0000000000c1'),
  1, 'INSERT of an active subscription emits one subscription.created event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'subscription.created'
      AND aggregate_id = 'e2100000-0000-0000-0000-0000000000c1'),
  'subscription_created:e2100000-0000-0000-0000-0000000000c1',
  'idempotency_key is subscription_created:<subscription id>');

SELECT is(
  (SELECT (payload->>'clientId') || '|' || (payload->>'cadenceDays')
     FROM public.outbox_events
    WHERE idempotency_key = 'subscription_created:e2100000-0000-0000-0000-0000000000c1'),
  'e2000000-0000-0000-0000-0000000000c1|30',
  'payload carries clientId and cadenceDays');

-- Model B: provisional pending_activation INSERT does NOT emit (pre-payment).
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('e2100000-0000-0000-0000-0000000000c2', 'e2000000-0000-0000-0000-0000000000c1', 30, 'PLN',
        'pending_activation', NULL);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('e2100000-0000-0000-0000-0000000000c2', 'e2000000-0000-0000-0000-0000000000d2', 1, 0, false, 1);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.created'
      AND aggregate_id = 'e2100000-0000-0000-0000-0000000000c2'),
  0, 'provisional pending_activation INSERT does NOT emit (pre-payment)');

-- ...and the pending_activation -> active confirmation emits the welcome.
UPDATE public.subscriptions
   SET status = 'active', next_cycle_at = '2026-08-20T08:00:00Z'
 WHERE id = 'e2100000-0000-0000-0000-0000000000c2';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.created'
      AND aggregate_id = 'e2100000-0000-0000-0000-0000000000c2'),
  1, 'pending_activation -> active emits one subscription.created event');

-- Resume regression (20260704140000): pause the Model A subscription, prune its
-- original welcome outbox row, then resume (paused -> active). The welcome must NOT
-- re-emit — resume is not a first activation.
UPDATE public.subscriptions SET status = 'paused'
 WHERE id = 'e2100000-0000-0000-0000-0000000000c1';
DELETE FROM public.outbox_events
 WHERE idempotency_key = 'subscription_created:e2100000-0000-0000-0000-0000000000c1';
UPDATE public.subscriptions SET status = 'active'
 WHERE id = 'e2100000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.created'
      AND aggregate_id = 'e2100000-0000-0000-0000-0000000000c1'),
  0, 'resume (paused -> active) does NOT re-emit subscription.created after prune');

SELECT * FROM finish();
ROLLBACK;
