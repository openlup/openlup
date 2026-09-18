-- pgTAP: commerce.order.paid outbox emission trigger (20260613230000).
--   * an INSERT/UPDATE that lands an order on status='paid' emits exactly one
--     commerce.order.paid outbox row with idempotency_key = 'order_paid:<id>'
--   * the payload carries orderId/orderUuid/mode/occurredAt
--   * a status that flips away and back to 'paid' does NOT duplicate (the
--     outbox_events UNIQUE (event_type, idempotency_key) + ON CONFLICT dedupe)
--   * non-paid transitions emit nothing
--   * fires on both the AFTER UPDATE and AFTER INSERT branches
--
-- The trigger is mode-agnostic — it copies NEW.mode into the payload without
-- branching, so the mode passthrough is proven by the payload.mode assertion on
-- a one_time order; a subscription_cycle fixture (which the
-- commerce_orders_subscription_cycle_mode_check constraint requires to carry a
-- real subscription_id + subscription_cycle_id) would add only FK setup, not
-- coverage.
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(22);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES ('10000000-0000-0000-0000-0000000000aa', 'order-paid-outbox@example.invalid', 'Paid', 'Order');

-- ===========================================================================
-- one-time order: pending_payment -> paid emits exactly one event
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency)
VALUES ('60000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000aa',
        'OPO-ORDER-1', 'pending_payment', 'one_time', 'PLN');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000a1'),
  0, 'no event emitted while the order is pending_payment');

UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '60000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000a1'),
  1, 'paid transition emits exactly one commerce.order.paid event');

SELECT is(
  (SELECT idempotency_key FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000a1'),
  'order_paid:60000000-0000-0000-0000-0000000000a1',
  'idempotency_key is order_paid:<order id>');

SELECT is(
  (SELECT aggregate_type FROM public.outbox_events
    WHERE idempotency_key = 'order_paid:60000000-0000-0000-0000-0000000000a1'),
  'commerce_order', 'aggregate_type is commerce_order');

SELECT is(
  (SELECT payload->>'orderUuid' FROM public.outbox_events
    WHERE idempotency_key = 'order_paid:60000000-0000-0000-0000-0000000000a1'),
  '60000000-0000-0000-0000-0000000000a1', 'payload.orderUuid is the order id');

SELECT is(
  (SELECT payload->>'orderId' FROM public.outbox_events
    WHERE idempotency_key = 'order_paid:60000000-0000-0000-0000-0000000000a1'),
  'order_60000000-0000-0000-0000-0000000000a1', 'payload.orderId is order_<uuid>');

SELECT is(
  (SELECT payload->>'mode' FROM public.outbox_events
    WHERE idempotency_key = 'order_paid:60000000-0000-0000-0000-0000000000a1'),
  'one_time', 'payload.mode mirrors the order mode');

SELECT ok(
  (SELECT (payload->>'occurredAt') IS NOT NULL FROM public.outbox_events
    WHERE idempotency_key = 'order_paid:60000000-0000-0000-0000-0000000000a1'),
  'payload.occurredAt is populated');

-- ===========================================================================
-- re-transition to paid does NOT duplicate (ON CONFLICT dedupe)
-- ===========================================================================
UPDATE public.commerce_orders SET status = 'fulfillment_pending'
 WHERE id = '60000000-0000-0000-0000-0000000000a1';
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '60000000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000a1'),
  1, 'a second paid transition does not duplicate the event (ON CONFLICT)');

-- A redundant same-status UPDATE (paid -> paid) also emits nothing new. Frozen
-- monetary columns deliberately remain unchanged.
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '60000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000a1'),
  1, 'a redundant paid -> paid update emits nothing new');

-- ===========================================================================
-- INSERT directly as paid (AFTER INSERT branch) emits one event
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency)
VALUES ('60000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000aa',
        'OPO-ORDER-2', 'paid', 'one_time', 'PLN');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000b1'),
  1, 'an order inserted directly as paid emits one event (AFTER INSERT branch)');

-- ===========================================================================
-- a non-paid order never emits
-- ===========================================================================
INSERT INTO public.commerce_orders (id, client_id, order_number, status, mode, currency)
VALUES ('60000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000aa',
        'OPO-ORDER-3', 'pending_payment', 'one_time', 'PLN');
UPDATE public.commerce_orders SET status = 'cancelled'
 WHERE id = '60000000-0000-0000-0000-0000000000c1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '60000000-0000-0000-0000-0000000000c1'),
  0, 'an order that never reaches paid emits no event');

-- ===========================================================================
-- paid renewal/order: the happy row retries, dedupes, and then terminates
-- ===========================================================================
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, started_at, next_cycle_at
) VALUES (
  '61000000-0000-0000-0000-0000000000d1',
  '10000000-0000-0000-0000-0000000000aa',
  30, 'PLN', 'active', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'
);
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key
) VALUES (
  '62000000-0000-0000-0000-0000000000d1',
  '61000000-0000-0000-0000-0000000000d1',
  2, '2026-07-01T00:00:00Z', 'planned', 'cp1b1-paid-renewal'
);
INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency,
  subscription_id, subscription_cycle_id
) VALUES (
  '63000000-0000-0000-0000-0000000000d1',
  '10000000-0000-0000-0000-0000000000aa',
  'OPO-RENEWAL-1', 'pending_payment', 'subscription_cycle', 'PLN',
  '61000000-0000-0000-0000-0000000000d1',
  '62000000-0000-0000-0000-0000000000d1'
);
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '63000000-0000-0000-0000-0000000000d1';

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000d1'),
  1, 'a paid renewal order emits one happy commerce.order.paid event');
SELECT is(
  (SELECT payload->>'mode' FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000d1'),
  'subscription_cycle', 'the happy renewal event preserves subscription_cycle mode');

CREATE TEMP TABLE _renewal_claim_1 AS
SELECT * FROM public.outbox_claim_aggregate_batch(
  'commerce_order',
  '63000000-0000-0000-0000-0000000000d1',
  ARRAY['commerce.order.paid'],
  1, 300, 8
);
SELECT is((SELECT count(*)::int FROM _renewal_claim_1), 1,
  'the happy renewal event is claimed for its exact aggregate');
SELECT is((SELECT attempts FROM _renewal_claim_1), 1,
  'the first happy renewal worker pass records one attempt');
SELECT is(
  public.outbox_mark_failed(
    (SELECT id FROM _renewal_claim_1),
    (SELECT metadata->>'claimToken' FROM _renewal_claim_1),
    'captured transient fixture',
    'retry',
    1, 60, 8, 300
  ),
  'failed', 'a transient happy-renewal handler result enters retry backoff');

UPDATE public.outbox_events
   SET available_at = now() - interval '1 second'
 WHERE id = (SELECT id FROM _renewal_claim_1);
CREATE TEMP TABLE _renewal_claim_2 AS
SELECT * FROM public.outbox_claim_aggregate_batch(
  'commerce_order',
  '63000000-0000-0000-0000-0000000000d1',
  ARRAY['commerce.order.paid'],
  1, 300, 8
);
SELECT is((SELECT id::text FROM _renewal_claim_2),
  (SELECT id::text FROM _renewal_claim_1),
  'the later worker pass retries the same happy renewal event');
SELECT is((SELECT attempts FROM _renewal_claim_2), 2,
  'the retried happy renewal event increments durable attempts');
SELECT ok(
  public.outbox_mark_processed(
    (SELECT id FROM _renewal_claim_2),
    (SELECT metadata->>'claimToken' FROM _renewal_claim_2),
    '{"fixture":"cp1b1-paid-renewal"}'::jsonb
  ),
  'the matching second claim token processes the happy renewal event');
SELECT is(
  (SELECT status FROM public.outbox_events WHERE id = (SELECT id FROM _renewal_claim_2)),
  'processed', 'the happy renewal event is terminal after successful retry');

UPDATE public.commerce_orders SET status = 'fulfillment_pending'
 WHERE id = '63000000-0000-0000-0000-0000000000d1';
UPDATE public.commerce_orders SET status = 'paid'
 WHERE id = '63000000-0000-0000-0000-0000000000d1';
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order.paid'
      AND aggregate_id = '63000000-0000-0000-0000-0000000000d1'),
  1, 'a repeated paid renewal transition dedupes without replacing the happy row');

SELECT * FROM finish();
ROLLBACK;
