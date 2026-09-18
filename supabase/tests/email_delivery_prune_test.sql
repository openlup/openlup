-- pgTAP: communication_email_deliveries_prune deletes only never-sent noise
-- (stale planned + orphan planned), and retains real delivery evidence.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(7);

-- A real client + order so an order-scoped 'planned' row has a live aggregate.
INSERT INTO public.clients (id, email, first_name, last_name, country, lifecycle_stage, acquisition_source)
VALUES ('aaaa1111-2222-4222-8222-aaaaaaaaaaaa', 'prune-client@example.invalid', 'Prune', 'Client', 'PL', 'lead', 'test');

INSERT INTO public.commerce_orders (id, client_id, status, currency, subtotal_cents, discount_cents, shipping_cents, total_cents)
VALUES ('bbbb1111-2222-4222-8222-bbbbbbbbbbbb', 'aaaa1111-2222-4222-8222-aaaaaaaaaaaa', 'paid', 'PLN', 9900, 0, 0, 9900);

-- Row A: stale (10d) never-sent 'planned' -> pruned by the stale branch.
INSERT INTO public.communication_email_deliveries
  (purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, created_at, sent_at)
VALUES ('marketing_newsletter', 'commerce-order-review-request', 'marketing-dispatch', 'send', 'prune:a', 'planned', now() - interval '10 days', NULL);

-- Row B: recent never-sent 'planned', no aggregate -> retained.
INSERT INTO public.communication_email_deliveries
  (purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, created_at, sent_at)
VALUES ('marketing_newsletter', 'commerce-order-review-request', 'marketing-dispatch', 'send', 'prune:b', 'planned', now(), NULL);

-- Row C: old SENT row (real evidence) -> retained.
INSERT INTO public.communication_email_deliveries
  (purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, created_at, sent_at)
VALUES ('transactional', 'commerce-order-paid', 'outbox-dispatch', 'send', 'prune:c', 'sent', now() - interval '10 days', now() - interval '10 days');

-- Row D: recent 'planned' for a NON-existent order -> pruned by the orphan branch.
INSERT INTO public.communication_email_deliveries
  (purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, created_at, sent_at, aggregate_type, aggregate_id)
VALUES ('transactional', 'commerce-order-paid', 'outbox-dispatch', 'send', 'prune:d', 'planned', now(), NULL, 'commerce_order', '99999999-9999-4999-8999-999999999999');

-- Row E: recent 'planned' for a REAL order -> retained.
INSERT INTO public.communication_email_deliveries
  (purpose, template_slug, trigger_source, trigger_event, dedupe_key, status, created_at, sent_at, aggregate_type, aggregate_id)
VALUES ('transactional', 'commerce-order-paid', 'outbox-dispatch', 'send', 'prune:e', 'planned', now(), NULL, 'commerce_order', 'bbbb1111-2222-4222-8222-bbbbbbbbbbbb');

SELECT is(
  (public.communication_email_deliveries_prune() ->> 'stale_deleted'),
  '1',
  'one stale never-sent planned row is pruned'
);

-- Re-run for orphan count (stale already gone). Orphan row D still present until now.
-- The first call already pruned both branches; assert the end state instead.
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.communication_email_deliveries WHERE dedupe_key = 'prune:a'),
  'stale planned row A is deleted'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.communication_email_deliveries WHERE dedupe_key = 'prune:d'),
  'orphan planned row D (missing order) is deleted'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.communication_email_deliveries WHERE dedupe_key = 'prune:b'),
  'recent planned row B is retained'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.communication_email_deliveries WHERE dedupe_key = 'prune:c'),
  'old SENT row C (real evidence) is retained'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.communication_email_deliveries WHERE dedupe_key = 'prune:e'),
  'planned row E for a live order is retained'
);
SELECT is(
  (public.communication_email_deliveries_prune() ->> 'orphan_deleted'),
  '0',
  'second run is a no-op for orphans (already pruned)'
);

SELECT * FROM finish();
ROLLBACK;
