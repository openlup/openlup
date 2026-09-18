-- pgTAP: back-in-stock notification lifecycle.
-- Run via: supabase test db

BEGIN;
SELECT no_plan();

INSERT INTO public.catalog_products (id, slug, status, name)
VALUES ('b1000000-0000-4000-8000-000000000001', 'bis-test-product', 'active', 'BIS Test Product');

INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES (
  'b1000000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000001',
  'OPENLUP-BIS-SMOKE-400G',
  'BIS Smoke 400g',
  'dog',
  'active',
  400,
  512
);

INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable)
VALUES (
  'b1000000-0000-4000-8000-000000000003',
  'bis-smoke',
  'BIS Smoke',
  'internal_warehouse',
  'active',
  true
);

INSERT INTO public.inventory_balances (sku_id, location_id, on_hand)
VALUES (
  'b1000000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000003',
  10
);

SELECT public.subscribe_product_stock_notification(
  'OPENLUP-BIS-SMOKE-400G',
  'bis-smoke@example.invalid',
  NULL,
  NULL,
  '{"test":"back_in_stock_delivery_semantics"}'::jsonb
);

SELECT ok(
  (SELECT enqueued_at IS NULL AND notified_at IS NULL AND closed_at IS NULL AND closed_reason IS NULL
     FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  'fresh stock notification starts open: neither enqueued, notified, nor closed');

SELECT is(public.enqueue_back_in_stock('OPENLUP-BIS-SMOKE-400G'), 1,
  'enqueue_back_in_stock enqueues one waiting subscriber');

SELECT ok(
  (SELECT enqueued_at IS NOT NULL AND notified_at IS NULL AND closed_at IS NULL AND outbox_event_id IS NOT NULL
     FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  'enqueue stamps enqueued_at and outbox_event_id but not notified_at/closed_at');

SELECT is(
  (SELECT status FROM public.outbox_events WHERE event_type = 'commerce.product.back_in_stock'
    AND idempotency_key LIKE 'back_in_stock:%'),
  'pending',
  'enqueue leaves a pending dispatcher event');

SELECT ok(NOT public.mark_back_in_stock_notification_notified(
  'b1000000-0000-4000-8000-000000000099',
  (SELECT id FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  NULL),
  'delivery marker refuses a mismatched outbox event id');

SELECT ok(
  (SELECT notified_at IS NULL
     FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  'mismatched marker leaves notified_at empty');

SELECT ok(public.mark_back_in_stock_notification_notified(
  (SELECT outbox_event_id FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  (SELECT id FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  NULL),
  'handler delivery marker returns true');

SELECT ok(
  (SELECT notified_at IS NOT NULL AND closed_at IS NOT NULL AND closed_reason = 'notified'
     FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  'handler marker stamps notified_at and terminal notified closure');

SELECT is(public.enqueue_back_in_stock('OPENLUP-BIS-SMOKE-400G'), 0,
  'delivered notification is not enqueued again');

SELECT ok(public.mark_back_in_stock_notification_notified(
  (SELECT outbox_event_id FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'),
  NULL,
  NULL),
  'delivery marker is idempotent');

SELECT public.subscribe_product_stock_notification(
  'OPENLUP-BIS-SMOKE-400G',
  'bis-smoke@example.invalid',
  NULL,
  NULL,
  '{"test":"back_in_stock_resubscribe_after_notified"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'
      AND closed_at IS NULL),
  1,
  'closed notified row does not block a fresh open subscription for a future restock');

SELECT is(public.enqueue_back_in_stock('OPENLUP-BIS-SMOKE-400G'), 1,
  'fresh re-subscription can be enqueued for a later restock');

CREATE TEMP TABLE _suppressed_bis AS
SELECT id, outbox_event_id
  FROM public.commerce_product_stock_notifications
 WHERE sku = 'OPENLUP-BIS-SMOKE-400G'
   AND closed_at IS NULL
   AND enqueued_at IS NOT NULL
 ORDER BY created_at DESC
 LIMIT 1;

SELECT ok(public.close_back_in_stock_notification(
  (SELECT outbox_event_id FROM _suppressed_bis),
  (SELECT id FROM _suppressed_bis),
  NULL,
  'consent_blocked',
  'pgtap consent blocked'),
  'consent-blocked handler terminally closes the notification');

SELECT ok(
  (SELECT notified_at IS NULL AND closed_at IS NOT NULL AND closed_reason = 'consent_blocked'
     FROM public.commerce_product_stock_notifications
    WHERE id = (SELECT id FROM _suppressed_bis)),
  'consent-blocked closure is audited without pretending delivery');

SELECT public.subscribe_product_stock_notification(
  'OPENLUP-BIS-SMOKE-400G',
  'bis-smoke@example.invalid',
  NULL,
  NULL,
  '{"test":"back_in_stock_resubscribe_after_suppressed"}'::jsonb
);

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_product_stock_notifications
    WHERE sku = 'OPENLUP-BIS-SMOKE-400G'
      AND closed_at IS NULL),
  1,
  'consent-blocked terminal row does not block re-subscribe');

SELECT * FROM finish();
ROLLBACK;
