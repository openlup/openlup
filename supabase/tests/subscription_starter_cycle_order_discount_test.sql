-- pgTAP: a delivery-2 cycle order carrying a non-zero order-level discount
-- satisfies every Canonical Order Money guard in
-- subscription_create_cycle_order_with_outbox, and replays byte-identically.
--
-- This is the money contract the starter engine has to hit. The TS builder in
-- server/domains/subscription/subscriptionCycleOrderTotals.ts computes the
-- discounted totals as
--
--   totalGross = subtotalGross - D
--   netTotal   = SUM(line net) - round(D * 10000 / (10000 + vatRateBps))
--   taxTotal   = totalGross - netTotal
--
-- and the RPC accepts that "quote expected net" alongside its own
-- allocation-derived net (20260714170003_canonical_order_money.sql:1504-1530).
-- The four guards this proves are reachable with a discount, not just at zero:
-- totals_mismatch, line_sum_mismatch, tax_totals_mismatch, and the two
-- post-insert effective sums.
--
-- Numbers: one line, 8 x 1340 = 10720 gross at 800 bps -> 9926 net / 794 VAT.
-- A 35% starter discount is 3752 gross, whose net part is
-- round(3752 * 10000 / 10800) = 3474. So total 6968, net 6452, tax 516.
--
-- Run via: npm run test:db:local (the guarded local database lane)

BEGIN;
SELECT plan(9);

INSERT INTO public.clients (id, email)
VALUES ('e1000000-0000-0000-0000-000000000001', 'starter-cycle-order@example.invalid');

INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('e1300000-0000-0000-0000-000000000001', 'starter-cycle-product', 'Starter Cycle Product', 'active');

INSERT INTO public.catalog_skus (
  id, product_id, sku, title, pet_type, status, net_weight_g, format_code,
  unit_form_code, kcal_per_unit, feeding_grams_per_unit, sellable_standalone,
  sellable_in_subscription, min_order_qty
) VALUES (
  'e1400000-0000-0000-0000-000000000001', 'e1300000-0000-0000-0000-000000000001',
  'STARTER-CYCLE-SKU', 'Starter Cycle SKU', 'dog', 'active', 400, 'can',
  'can', 400, 400, true, true, 1
);

-- The cycle-order insert reserves stock through the provider oracle, so the
-- fixture has to publish provider-current stock before the order items land.
SELECT public.fulfillment_provider_upsert_stock_current(
  'starter-cycle-stock-1',
  'omnipack',
  'STARTER-CYCLE-SKU',
  100, 100, 0,
  now(),
  now() + interval '6 hours',
  'starter-cycle-stock-run-1',
  '{"source":"subscription_starter_cycle_order_discount_test"}'::jsonb
);

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, next_cycle_at,
  template_version, payment_method_kind, payment_method_ref, starter_pack
)
VALUES (
  'e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 17, 'PLN', 'PL',
  'active', '2026-06-09T12:00:00Z', 1, 'card', 'pm_starter_cycle',
  '{"schemaVersion":"1","starterIntervalDays":17,"basisTemplateVersion":1,
    "delivery2":{"discountBps":3500,"discountMinor":3752,"basisSubtotalMinor":10720},
    "graduation":{"cadenceDays":28,"lines":[{"sku":"STARTER-CYCLE-SKU","qty":8,"sortOrder":0,"isAddon":false,
      "quoteLine":{"unitPriceGross":{"amountMinor":1340,"currency":"PLN"},
        "lineSubtotalGross":{"amountMinor":10720,"currency":"PLN"}}}]}}'::jsonb
);

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('e2100000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e1400000-0000-0000-0000-000000000001', 8, 0, false, 1);

-- The order snapshot the TS builder produces for the discounted delivery-2
-- cycle, reproduced literally so the SQL guards are exercised against the exact
-- shape the runtime sends.
CREATE TEMP TABLE _order_snapshot AS SELECT '{
  "contractVersion":"commerce.v0",
  "source":"subscription.own_engine.v0",
  "status":"pending_payment",
  "paymentStatus":"pending",
  "currency":"PLN",
  "taxIncluded":true,
  "lines":[{"sku":"STARTER-CYCLE-SKU","productSlug":"starter-cycle-product","quantity":8,
    "unitPriceGross":{"amountMinor":1340,"currency":"PLN"},
    "lineSubtotalGross":{"amountMinor":10720,"currency":"PLN"},
    "tax":{"included":true,"country":"PL","category":"pet_food","vatRateBps":800,
      "legalBasis":"PL VAT Annex 3 item 10c",
      "netAmount":{"amountMinor":9926,"currency":"PLN"},
      "vatAmount":{"amountMinor":794,"currency":"PLN"},
      "grossAmount":{"amountMinor":10720,"currency":"PLN"}}}],
  "totals":{
    "subtotalGross":{"amountMinor":10720,"currency":"PLN"},
    "discountTotalGross":{"amountMinor":3752,"currency":"PLN"},
    "totalGross":{"amountMinor":6968,"currency":"PLN"},
    "netTotal":{"amountMinor":6452,"currency":"PLN"},
    "taxTotal":{"amountMinor":516,"currency":"PLN"}}}'::jsonb AS s;

CREATE TEMP TABLE _pricing_snapshot AS SELECT '{
  "contractVersion":"commerce.v0",
  "source":"subscription.own_engine.v0",
  "subscriptionId":"e2000000-0000-0000-0000-000000000001",
  "scheduledAt":"2026-06-09T12:00:00Z",
  "cycleNumber":2,
  "totals":{
    "subtotalGross":{"amountMinor":10720,"currency":"PLN"},
    "discountTotalGross":{"amountMinor":3752,"currency":"PLN"},
    "totalGross":{"amountMinor":6968,"currency":"PLN"},
    "netTotal":{"amountMinor":6452,"currency":"PLN"},
    "taxTotal":{"amountMinor":516,"currency":"PLN"}},
  "provenance":{"starterPack":{"reasonCode":"starter_pack_delivery_2",
    "discountMinor":3752,"basisTemplateVersion":1}}}'::jsonb AS s;

CREATE TEMP TABLE _cycle AS
SELECT public.subscription_create_cycle_order_with_outbox(
  'starter-delivery-2-cycle-key',
  'e2000000-0000-0000-0000-000000000001',
  2,
  '2026-06-09T12:00:00Z'::timestamptz,
  public.subscription_current_template_snapshot('e2000000-0000-0000-0000-000000000001'),
  (SELECT s FROM _pricing_snapshot),
  (SELECT s FROM _order_snapshot)
) AS r;

SELECT is((SELECT r #>> '{subscriptionCycleOrder,replayed}' FROM _cycle), 'false',
  'discounted cycle: the first call creates the cycle order');

SELECT is(
  (SELECT total_cents FROM public.commerce_orders
    WHERE id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  6968,
  'discounted cycle: commerce_orders.total_cents is subtotal minus the discount');

SELECT is(
  (SELECT discount_cents FROM public.commerce_orders
    WHERE id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  3752,
  'discounted cycle: commerce_orders.discount_cents carries the whole discount');

SELECT is(
  (SELECT subtotal_cents FROM public.commerce_orders
    WHERE id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  10720,
  'discounted cycle: the undiscounted subtotal is preserved on the order');

SELECT is(
  (SELECT tax_cents FROM public.commerce_orders
    WHERE id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  516,
  'discounted cycle: order tax is the discounted VAT, not the line-sum VAT');

SELECT is(
  (SELECT sum(discount_allocated_cents)::int FROM public.commerce_order_items
    WHERE order_id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  3752,
  'discounted cycle: the discount is fully allocated across the order items');

SELECT is(
  (SELECT sum(effective_total_cents)::int FROM public.commerce_order_items
    WHERE order_id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  6968,
  'discounted cycle: the effective item totals sum to the order total');

SELECT is(
  (SELECT sum(effective_net_cents)::int FROM public.commerce_order_items
    WHERE order_id = (SELECT replace(r #>> '{subscriptionCycleOrder,orderId}', 'order_', '')::uuid FROM _cycle)),
  6452,
  'discounted cycle: the effective item nets sum to the order net total');

-- A byte-identical re-call is a replay, not an idempotency conflict: the cron
-- retries the same cycle with the same deterministic snapshots.
SELECT is(
  (public.subscription_create_cycle_order_with_outbox(
     'starter-delivery-2-cycle-key',
     'e2000000-0000-0000-0000-000000000001',
     2,
     '2026-06-09T12:00:00Z'::timestamptz,
     public.subscription_current_template_snapshot('e2000000-0000-0000-0000-000000000001'),
     (SELECT s FROM _pricing_snapshot),
     (SELECT s FROM _order_snapshot)
   ) #>> '{subscriptionCycleOrder,replayed}'),
  'true',
  'discounted cycle: an identical re-call replays instead of conflicting');

SELECT * FROM finish();
ROLLBACK;
