-- Input and all data are confined to the benchmark's disposable database.
CREATE TEMP TABLE bench_scope AS
SELECT current_setting('openlup.bench_rows')::integer AS rows,
       clock_timestamp() AS as_of,
       md5('benchmark/hot-sku')::uuid AS sku,
       (regexp_match(pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure),
         $binding$stock.provider_kind='([^']+)'$binding$))[1] AS provider,
       (regexp_match(pg_get_functiondef('public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)'::regprocedure),
         $binding$WHERE code = '([^']+)'$binding$))[1] AS location;

INSERT INTO public.providers(kind, capability, display_name, status, enabled_for_region)
SELECT provider, 'fulfillment', 'Synthetic benchmark provider', 'active', ARRAY['ZZ'] FROM bench_scope
ON CONFLICT(kind) DO NOTHING;
INSERT INTO public.inventory_locations(code, display_name, kind, status, region, fulfillable, provider_kind)
SELECT location, 'Synthetic warehouse', 'third_party_logistics', 'active', 'ZZ', true, provider FROM bench_scope
ON CONFLICT(code) DO NOTHING;
INSERT INTO public.catalog_products(id, slug, name, status)
VALUES (md5('benchmark/product')::uuid, 'benchmark-item', 'Synthetic item', 'active');
INSERT INTO public.catalog_skus(id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
SELECT sku, md5('benchmark/product')::uuid, 'BENCHMARK-HOT', 'Synthetic item', 'other', 'active', 1, 1 FROM bench_scope;
INSERT INTO public.inventory_balances(sku_id, location_id, on_hand, safety_stock)
SELECT s.sku, l.id, s.rows * 8, 10 FROM bench_scope s JOIN public.inventory_locations l ON l.code = s.location;
SELECT public.fulfillment_provider_upsert_stock_current(
  'benchmark-stock', provider, 'BENCHMARK-HOT', rows * 8, rows * 8, 0,
  as_of, as_of + interval '1 hour', 'benchmark-stock-run', '{}'
) FROM bench_scope;

CREATE TEMP TABLE bench_rows AS
SELECT n,
       md5('benchmark/client/' || n)::uuid AS client_id,
       md5('benchmark/subscription/' || n)::uuid AS subscription_id,
       md5('benchmark/cycle/' || n)::uuid AS cycle_id,
       md5('benchmark/order/' || n)::uuid AS order_id,
       md5('benchmark/item/' || n)::uuid AS item_id,
       md5('benchmark/payment/' || n)::uuid AS payment_id,
       dates.placed_at,
       CASE WHEN n % 23 = 0 THEN s.as_of - interval '1 day'
            ELSE dates.placed_at + interval '1 hour' END AS payment_updated_at,
       s.as_of + (n % 20) * interval '1 day' AS cycle_at,
       n <= s.rows AND n % 5 = 0 OR n = s.rows + 2 AS renewal,
       n <= s.rows AND n % 10 < 7 AS paid,
       n <= s.rows AND n % 10 = 8 AS withdrawn
FROM bench_scope s
CROSS JOIN LATERAL generate_series(1, s.rows + 2) AS n
CROSS JOIN LATERAL (SELECT s.as_of - ((n - 1) % 365) * interval '1 day' AS placed_at) dates;

INSERT INTO public.clients(id, email)
SELECT client_id, 'benchmark-' || n || '@example.invalid' FROM bench_rows;
INSERT INTO public.subscriptions(id, client_id, cadence_days, currency, status, next_cycle_at)
SELECT subscription_id, client_id, 28, 'XTS', 'active', cycle_at
FROM bench_rows, bench_scope WHERE n <= rows OR n = rows + 2;
INSERT INTO public.subscription_lines(subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT subscription_id, sku, 2, 0, false, 1
FROM bench_rows, bench_scope WHERE n <= rows OR n = rows + 2;
INSERT INTO public.subscription_cycles(id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key)
SELECT cycle_id, subscription_id, 2, cycle_at,
       CASE WHEN n <= rows AND n % 13 = 0 THEN 'skipped' ELSE 'planned' END, 'benchmark-cycle-' || n
FROM bench_rows, bench_scope WHERE n <= rows OR n = rows + 2;

INSERT INTO public.commerce_orders(
  id, client_id, order_number, status, mode, subscription_id, subscription_cycle_id,
  currency, total_cents, subtotal_cents, created_at, updated_at, metadata
)
SELECT order_id, client_id, 'BENCHMARK-ORDER-' || lpad(n::text, 6, '0'),
       CASE WHEN paid THEN 'paid' WHEN withdrawn THEN 'cancelled' ELSE 'draft' END,
       CASE WHEN renewal THEN 'subscription_cycle' ELSE 'one_time' END,
       CASE WHEN renewal THEN subscription_id END, CASE WHEN renewal THEN cycle_id END,
       'XTS', 1000, 1000, placed_at, placed_at + interval '1 hour',
       CASE WHEN withdrawn THEN jsonb_build_object('checkoutAbandoned', 'checkout_journey_consumed') ELSE '{}'::jsonb END
FROM bench_rows;
UPDATE public.subscription_cycles c SET order_id = r.order_id FROM bench_rows r WHERE r.renewal AND c.id = r.cycle_id;
-- Seed the intended hold distribution explicitly. This fixture-only toggle
-- avoids running the allocating trigger once for every historical renewal item.
ALTER TABLE public.commerce_order_items DISABLE TRIGGER trg_subscription_cycle_order_item_reserve_inventory;
INSERT INTO public.commerce_order_items(
  id, order_id, sku_id, quantity, unit_price_cents, total_cents,
  allocation_ordinal, discount_allocated_cents, effective_total_cents, effective_net_cents, vat_rate_bps
)
SELECT item_id, order_id, sku, 2, 500, 1000, 1, 0, 1000, 1000, 0 FROM bench_rows, bench_scope WHERE n <= rows;
ALTER TABLE public.commerce_order_items ENABLE TRIGGER trg_subscription_cycle_order_item_reserve_inventory;
INSERT INTO public.commerce_payments(id, order_id, provider, status, amount_cents, currency, created_at, updated_at)
SELECT payment_id, order_id, 'sandbox', CASE WHEN paid THEN 'succeeded' ELSE 'pending' END,
       1000, 'XTS', placed_at, payment_updated_at
FROM bench_rows, bench_scope WHERE n <= rows AND (paid OR NOT withdrawn);
INSERT INTO public.commerce_payment_intents(
  target_kind, order_id, subscription_id, subscription_cycle_id, payment_id, status,
  amount_cents, currency, created_at, updated_at
)
SELECT CASE WHEN renewal THEN 'subscription_cycle' ELSE 'one_time_order' END,
       order_id, CASE WHEN renewal THEN subscription_id END, CASE WHEN renewal THEN cycle_id END,
       payment_id, CASE WHEN paid THEN 'succeeded' ELSE 'processing' END, 1000, 'XTS',
       placed_at, payment_updated_at
FROM bench_rows, bench_scope WHERE n <= rows AND (paid OR NOT withdrawn);
INSERT INTO public.commerce_order_holds(order_id, reason)
SELECT order_id, 'inventory_review' FROM bench_rows, bench_scope WHERE n <= rows AND n % 17 = 0;

INSERT INTO public.inventory_reservations(
  idempotency_key, order_id, order_item_id, subscription_cycle_id, sku_id, location_id,
  quantity, status, kind, expires_at, metadata
)
SELECT 'benchmark-reservation-' || n, order_id, item_id, CASE WHEN renewal THEN cycle_id END,
       s.sku, l.id, 1, 'reserved',
       CASE WHEN renewal THEN 'subscription_retry_window' ELSE 'checkout_payment_window' END,
       s.as_of + CASE WHEN n % 9 = 0 THEN interval '-1 hour' ELSE interval '1 hour' END,
       jsonb_build_object('providerKind', s.provider)
FROM bench_rows r CROSS JOIN bench_scope s JOIN public.inventory_locations l ON l.code = s.location
WHERE r.n <= s.rows AND (r.renewal OR r.n % 7 = 0);
ANALYZE;

SELECT s.rows, s.sku, s.provider, s.as_of::text AS "asOf",
       md5('benchmark/order/' || (s.rows + 1))::uuid AS checkout_order,
       md5('benchmark/order/' || (s.rows + 2))::uuid AS renewal_order,
       md5('benchmark/cycle/' || (s.rows + 2))::uuid AS renewal_cycle,
       (SELECT count(*)::integer FROM bench_rows r
        WHERE r.paid AND r.payment_updated_at >= s.as_of - interval '6 days') AS recently_paid,
       (SELECT count(*)::integer FROM bench_rows r WHERE r.paid
        AND r.placed_at < s.as_of - interval '6 days'
        AND r.payment_updated_at >= s.as_of - interval '6 days') AS out_of_window_recently_paid
FROM bench_scope s;
