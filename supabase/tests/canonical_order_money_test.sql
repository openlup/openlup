-- pgTAP: canonical order money persistence, allocation and writer invariants.

BEGIN;
SELECT plan(79);
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;

SELECT col_not_null(
  'public', 'commerce_order_items', 'allocation_ordinal',
  'largest-remainder tie-break ordinal is globally complete');

SELECT col_not_null(
  'public', 'commerce_order_items', 'discount_allocated_cents',
  'allocated discount is globally complete');
SELECT col_not_null(
  'public', 'commerce_order_items', 'effective_total_cents',
  'effective gross is globally complete');
SELECT col_not_null(
  'public', 'commerce_order_items', 'effective_net_cents',
  'effective net is globally complete');
SELECT col_not_null(
  'public', 'commerce_orders', 'shipping_discount_cents',
  'shipping discount is globally complete');

SELECT is(
  public.commerce_allocate_discount_to_lines(ARRAY[100, 100, 100], 2),
  ARRAY[1, 1, 0],
  'largest-remainder ties use stable input ordinal');
SELECT is(
  public.commerce_allocate_discount_to_lines(ARRAY[0, 0], 0),
  ARRAY[0, 0],
  'zero target over zero-valued lines is valid');
SELECT is(
  public.commerce_allocate_discount_to_lines(ARRAY[]::integer[], 0),
  ARRAY[]::integer[],
  'empty lines with an empty discount close exactly');
SELECT is(
  public.commerce_allocate_discount_to_lines(ARRAY[500, 300, 200], 333),
  ARRAY[166, 100, 67],
  'uneven largest-remainder allocation closes with stable remainder ordering');
SELECT is(
  public.commerce_allocate_discount_to_lines(
    ARRAY[2147483647, 2147483647],
    2147483647
  ),
  ARRAY[1073741824, 1073741823],
  'allocation products are overflow-safe and ties remain stable');
SELECT is(
  ARRAY(
    SELECT line_total - allocated
      FROM unnest(
        ARRAY[4470, 4470, 4470, 2980, 2980, 2980],
        public.commerce_allocate_discount_to_lines(
          ARRAY[4470, 4470, 4470, 2980, 2980, 2980],
          11175
        )
      ) AS allocation(line_total, allocated)
  ),
  ARRAY[2235, 2235, 2235, 1490, 1490, 1490],
  'OPENLUP-0F50280B-shaped allocation produces 2235x3 + 1490x3 effective lines');
SELECT is(
  (SELECT sum(value)::integer
     FROM unnest(public.commerce_allocate_discount_to_lines(ARRAY[999, 1], 333)) AS a(value)),
  333,
  'allocated cents close exactly to the target');
SELECT is(
  public.commerce_allocate_discount_to_lines(ARRAY[0, 100], 50),
  ARRAY[0, 50],
  'zero-valued lines never receive another line discount');
SELECT is(
  public.commerce_allocate_discount_to_lines(ARRAY[25, 75], 100),
  ARRAY[25, 75],
  'a one-hundred-percent discount closes every line at zero');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[-1, 2], 1)$$,
  '22023',
  'commerce_discount_allocation_invalid_line',
  'allocator rejects negative line amounts');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[1, 2], 4)$$,
  '22023',
  'commerce_discount_allocation_target_exceeds_lines',
  'allocator rejects a target above the line spread');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[0, 0], 1)$$,
  '22023',
  'commerce_discount_allocation_target_exceeds_lines',
  'allocator fails closed for a positive target over zero lines');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[]::integer[], 1)$$,
  '22023',
  'commerce_discount_allocation_zero_spread',
  'allocator rejects a positive target over an empty order');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[1, 2], -1)$$,
  '22023',
  'commerce_discount_allocation_negative_target',
  'allocator rejects a negative discount');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[1, NULL]::integer[], 1)$$,
  '22023',
  'commerce_discount_allocation_invalid_line',
  'allocator rejects NULL line amounts');
SELECT throws_ok(
  $$SELECT public.commerce_allocate_discount_to_lines(ARRAY[[1, 2], [3, 4]], 1)$$,
  '22023',
  'commerce_discount_allocation_invalid_lines',
  'allocator rejects multidimensional input');
SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.commerce_allocate_discount_to_lines(integer[],integer)', 'EXECUTE'),
  'anon cannot execute the allocator');
SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.commerce_allocate_discount_to_lines(integer[],integer)', 'EXECUTE'),
  'authenticated cannot execute the allocator');
SELECT ok(
  has_function_privilege(
    'service_role', 'public.commerce_allocate_discount_to_lines(integer[],integer)', 'EXECUTE'),
  'service_role can execute the allocator');
SELECT is(
  (SELECT count(*)::integer
     FROM pg_constraint
    WHERE conrelid = 'public.commerce_orders'::regclass
      AND conname IN (
        'commerce_orders_shipping_discount_range_check',
        'commerce_orders_canonical_money_equation_check'
      )
      AND convalidated),
  2,
  'both order-header canonical checks are validated');
SELECT is(
  (SELECT count(*)::integer
     FROM pg_constraint
    WHERE conrelid = 'public.commerce_order_items'::regclass
      AND conname LIKE 'commerce_order_items_canonical_money_%_check'
      AND convalidated),
  3,
  'all item canonical-money checks are validated');
SELECT is(
  (SELECT count(*)::integer
     FROM pg_trigger
    WHERE tgname IN (
      'commerce_orders_frozen_money_update_trigger',
      'commerce_order_items_frozen_money_update_trigger'
    )
      AND NOT tgisinternal),
  2,
  'both frozen-money update triggers are installed');
SELECT is(
  (SELECT array_agg(cmd ORDER BY cmd)
     FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'commerce_orders'
      AND policyname = 'admin_all_commerce_orders'),
  ARRAY['SELECT']::text[],
  'authenticated admins can only select order headers');
SELECT is(
  (SELECT array_agg(cmd ORDER BY cmd)
     FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'commerce_order_items'
      AND policyname = 'admin_all_commerce_order_items'),
  ARRAY['SELECT']::text[],
  'authenticated admins can only select order lines');

INSERT INTO public.commerce_orders (
  id, status, currency, subtotal_cents, discount_cents, shipping_cents,
  shipping_discount_cents, tax_cents, total_cents, metadata
) VALUES
(
  'cf100000-0000-4000-8000-000000000001', 'draft', 'PLN',
  300, 2, 0, 0, 0, 298, '{"fixture":"snapshotless-ordinal"}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000002', 'draft', 'PLN',
  100, 0, 0, 0, 0, 100,
  '{"orderDraftSnapshot":{"lines":null},"orderSnapshot":{"lines":null}}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000003', 'draft', 'PLN',
  100, 0, 0, 0, 0, 100,
  '{"orderDraftSnapshot":{"lines":{}}}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000004', 'draft', 'PLN',
  100, 0, 0, 0, 0, 100,
  '{"orderDraftSnapshot":{"lines":[]}}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000005', 'draft', 'PLN',
  100, 0, 0, 0, 0, 100,
  '{"orderSnapshot":{"lines":"malformed"}}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000006', 'draft', 'PLN',
  100, 0, 0, 0, 0, 100,
  '{"orderDraftSnapshot":{"lines":[{"sku":"VALID"}]},"orderSnapshot":{"lines":{}}}'::jsonb
);

INSERT INTO public.commerce_order_items (
  id, order_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents,
  vat_rate_bps, product_snapshot
) VALUES
(
  'cf100000-0000-4000-8000-000000000011',
  'cf100000-0000-4000-8000-000000000001',
  1, 100, 100, 1, 99, 99, 0, '{"sku":"SNAPSHOTLESS-A"}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000012',
  'cf100000-0000-4000-8000-000000000001',
  1, 100, 100, 1, 99, 99, 0, '{"sku":"SNAPSHOTLESS-B"}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000013',
  'cf100000-0000-4000-8000-000000000001',
  1, 100, 100, 0, 100, 100, 0, '{"sku":"SNAPSHOTLESS-C"}'::jsonb
),
(
  'cf100000-0000-4000-8000-000000000014',
  'cf100000-0000-4000-8000-000000000002',
  1, 100, 100, 0, 100, 100, 0, '{"sku":"EXPLICIT-NULL"}'::jsonb
);

SELECT is(
  (SELECT array_agg(
            ARRAY[allocation_ordinal, discount_allocated_cents]
            ORDER BY allocation_ordinal
          )
     FROM public.commerce_order_items
    WHERE order_id = 'cf100000-0000-4000-8000-000000000001'),
  ARRAY[ARRAY[1, 1], ARRAY[2, 1], ARRAY[3, 0]],
  'snapshot-less runtime inserts use deterministic row order for remainder ties');
SELECT is(
  (SELECT allocation_ordinal
     FROM public.commerce_order_items
    WHERE id = 'cf100000-0000-4000-8000-000000000014'),
  1,
  'explicit JSON null snapshot lines use the snapshot-less ordinal fallback');
SELECT throws_ok(
  $$INSERT INTO public.commerce_order_items (
      id, order_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      vat_rate_bps, product_snapshot
    ) VALUES (
      'cf100000-0000-4000-8000-000000000015',
      'cf100000-0000-4000-8000-000000000003',
      1, 100, 100, 0, 100, 100, 0, '{"sku":"MALFORMED"}'::jsonb
    )$$,
  '23514',
  'commerce_order_item_allocation_ordinal_snapshot_malformed',
  'malformed snapshot lines cannot enter the runtime ordinal fallback');
SELECT throws_ok(
  $$INSERT INTO public.commerce_order_items (
      id, order_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      vat_rate_bps, product_snapshot
    ) VALUES (
      'cf100000-0000-4000-8000-000000000016',
      'cf100000-0000-4000-8000-000000000004',
      1, 100, 100, 0, 100, 100, 0, '{"sku":"EMPTY"}'::jsonb
    )$$,
  '23514',
  'commerce_order_item_allocation_ordinal_unprovable',
  'an explicit empty snapshot cannot enter the runtime ordinal fallback');
SELECT throws_ok(
  $$INSERT INTO public.commerce_order_items (
      id, order_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      vat_rate_bps, product_snapshot
    ) VALUES (
      'cf100000-0000-4000-8000-000000000017',
      'cf100000-0000-4000-8000-000000000005',
      1, 100, 100, 0, 100, 100, 0, '{"sku":"MALFORMED-CYCLE"}'::jsonb
    )$$,
  '23514',
  'commerce_order_item_allocation_ordinal_snapshot_malformed',
  'a malformed cycle snapshot cannot enter the runtime ordinal fallback');
SELECT throws_ok(
  $$INSERT INTO public.commerce_order_items (
      id, order_id, quantity, unit_price_cents, total_cents,
      discount_allocated_cents, effective_total_cents, effective_net_cents,
      vat_rate_bps, product_snapshot
    ) VALUES (
      'cf100000-0000-4000-8000-000000000018',
      'cf100000-0000-4000-8000-000000000006',
      1, 100, 100, 0, 100, 100, 0, '{"quoteLine":{"sku":"VALID"}}'::jsonb
    )$$,
  '23514',
  'commerce_order_item_allocation_ordinal_snapshot_malformed',
  'a valid draft snapshot cannot mask malformed cycle evidence');

CREATE TEMP TABLE _checkout AS
SELECT public.commerce_create_order_draft_with_outbox(
  'canonical-checkout-0001',
  '{"contractVersion":"commerce.v0"}'::jsonb,
  '{
    "contractVersion":"commerce.v0",
    "source":"commerce.order_draft.bff.v0",
    "status":"draft",
    "paymentStatus":"not_started",
    "currency":"PLN",
    "taxIncluded":true,
    "lines":[
      {
        "sku":"CANON-A","productSlug":"canon-a","quantity":3,
        "unitPriceGross":{"amountMinor":1490,"currency":"PLN"},
        "lineSubtotalGross":{"amountMinor":4470,"currency":"PLN"},
        "tax":{"vatRateBps":800,
          "netAmount":{"amountMinor":4139,"currency":"PLN"},
          "vatAmount":{"amountMinor":331,"currency":"PLN"},
          "grossAmount":{"amountMinor":4470,"currency":"PLN"}}
      },
      {
        "sku":"CANON-B","productSlug":"canon-b","quantity":2,
        "unitPriceGross":{"amountMinor":1490,"currency":"PLN"},
        "lineSubtotalGross":{"amountMinor":2980,"currency":"PLN"},
        "tax":{"vatRateBps":800,
          "netAmount":{"amountMinor":2759,"currency":"PLN"},
          "vatAmount":{"amountMinor":221,"currency":"PLN"},
          "grossAmount":{"amountMinor":2980,"currency":"PLN"}}
      }
    ],
    "totals":{
      "subtotalGross":{"amountMinor":7450,"currency":"PLN"},
      "discountTotalGross":{"amountMinor":3725,"currency":"PLN"},
      "shippingGross":{"amountMinor":1500,"currency":"PLN"},
      "shippingDiscountGross":{"amountMinor":1500,"currency":"PLN"},
      "netTotal":{"amountMinor":3449,"currency":"PLN"},
      "taxTotal":{"amountMinor":276,"currency":"PLN"},
      "totalGross":{"amountMinor":3725,"currency":"PLN"}
    }
  }'::jsonb
) AS result;

CREATE TEMP TABLE _checkout_id AS
SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid AS order_id
  FROM _checkout;

SELECT is(
  (SELECT subtotal_cents FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
  7450,
  'checkout persists catalog subtotal');
SELECT is(
  (SELECT ARRAY[shipping_cents, shipping_discount_cents]
     FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
  ARRAY[1500, 1500],
  'checkout persists gross and discounted delivery separately');
SELECT is(
  (SELECT discount_cents FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
  3725,
  'checkout persists product discount');
SELECT is(
  (SELECT total_cents FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
  3725,
  'checkout payable total closes after free shipping');
SELECT is(
  (SELECT discount_allocated_cents
     FROM public.commerce_order_items
    WHERE order_id = (SELECT order_id FROM _checkout_id)
      AND product_snapshot->>'sku' = 'CANON-A'),
  2235,
  'checkout persists deterministic per-line allocations');
SELECT is(
  (SELECT effective_total_cents
     FROM public.commerce_order_items
    WHERE order_id = (SELECT order_id FROM _checkout_id)
      AND product_snapshot->>'sku' = 'CANON-B'),
  1490,
  'checkout persists effective gross line totals');
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.commerce_order_items
     WHERE order_id = (SELECT order_id FROM _checkout_id)
       AND effective_net_cents <> round(
         effective_total_cents::numeric * 10000 / (10000 + vat_rate_bps)
       )::integer
  ),
  'checkout effective net follows the frozen line VAT rate');
SELECT throws_ok(
  $$UPDATE public.commerce_orders
       SET total_cents = total_cents + 1
     WHERE id = (SELECT order_id FROM _checkout_id)$$,
  '23514',
  'commerce_order_money_frozen: ' || (SELECT order_id::text FROM _checkout_id),
  'stored order-header money is immutable');
SELECT throws_ok(
  $$UPDATE public.commerce_order_items
       SET effective_total_cents = effective_total_cents - 1,
           discount_allocated_cents = discount_allocated_cents + 1,
           effective_net_cents = round(
             (effective_total_cents - 1)::numeric * 10000 / (10000 + vat_rate_bps)
           )::integer
     WHERE order_id = (SELECT order_id FROM _checkout_id)
       AND product_snapshot->>'sku' = 'CANON-B'$$,
  '23514',
  'commerce_order_item_money_frozen: ' || (
    SELECT id::text FROM public.commerce_order_items
     WHERE order_id = (SELECT order_id FROM _checkout_id)
       AND product_snapshot->>'sku' = 'CANON-B'
  ),
  'stored item money and allocation are immutable');
SELECT throws_ok(
  $$UPDATE public.commerce_order_items
       SET allocation_ordinal = allocation_ordinal + 1
     WHERE order_id = (SELECT order_id FROM _checkout_id)
       AND product_snapshot->>'sku' = 'CANON-B'$$,
  '23514',
  'commerce_order_item_money_frozen: ' || (
    SELECT id::text FROM public.commerce_order_items
     WHERE order_id = (SELECT order_id FROM _checkout_id)
       AND product_snapshot->>'sku' = 'CANON-B'
  ),
  'stored allocation tie-break ordinal is immutable');
SELECT lives_ok(
  $$UPDATE public.commerce_orders
       SET status = 'pending_payment'
     WHERE id = (SELECT order_id FROM _checkout_id)$$,
  'non-money order lifecycle updates remain allowed');

SELECT is(
  public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-0001',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    (SELECT metadata->'orderDraftSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id))
  )#>>'{orderDraft,replayed}',
  'true',
  'checkout replay returns the completed canonical order');
SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key = 'canonical-checkout-0001'
      AND status = 'completed'),
  1,
  'checkout replay does not duplicate the order');
SELECT is(
  (SELECT jsonb_build_object(
    'orders', count(DISTINCT o.id),
    'items', count(DISTINCT i.id),
    'outbox', count(DISTINCT e.id),
    'idempotency', count(DISTINCT k.id)
  )
     FROM public.commerce_orders AS o
     LEFT JOIN public.commerce_order_items AS i ON i.order_id = o.id
     LEFT JOIN public.outbox_events AS e
       ON e.aggregate_id = o.id AND e.event_type = 'commerce.order_draft.created'
     LEFT JOIN public.commerce_idempotency_keys AS k
       ON k.scope = 'commerce.order_draft.create'
      AND k.idempotency_key = 'canonical-checkout-0001'
    WHERE o.id = (SELECT order_id FROM _checkout_id)),
  '{"orders":1,"items":2,"outbox":1,"idempotency":1}'::jsonb,
  'checkout replay preserves exactly one complete order graph');
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-0001',
    '{"contractVersion":"commerce.v0","changed":true}'::jsonb,
    (SELECT metadata->'orderDraftSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id))
  )$$,
  '23505',
  'commerce_order_draft_idempotency_conflict',
  'checkout preserves same-key changed-request conflict semantics');

CREATE TEMP TABLE _checkout_paid_shipping AS
SELECT public.commerce_create_order_draft_with_outbox(
  'canonical-checkout-paid-shipping-0001',
  '{"contractVersion":"commerce.v0"}'::jsonb,
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          (SELECT metadata->'orderDraftSnapshot'
             FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
          '{totals,shippingDiscountGross,amountMinor}', '0'::jsonb
        ),
        '{totals,totalGross,amountMinor}', '5225'::jsonb
      ),
      '{totals,netTotal,amountMinor}', '4838'::jsonb
    ),
    '{totals,taxTotal,amountMinor}', '387'::jsonb
  )
) AS result;

SELECT is(
  (SELECT ARRAY[shipping_cents, shipping_discount_cents, total_cents]
     FROM public.commerce_orders
    WHERE id = replace(
      (SELECT result#>>'{orderDraft,orderId}' FROM _checkout_paid_shipping),
      'order_', ''
    )::uuid),
  ARRAY[1500, 0, 5225],
  'checkout persists paid delivery explicitly and closes the payable total');

CREATE TEMP TABLE _checkout_rounding_edge AS
SELECT public.commerce_create_order_draft_with_outbox(
  'canonical-checkout-rounding-edge-1',
  '{"contractVersion":"commerce.v0"}'::jsonb,
  '{
    "contractVersion":"commerce.v0","source":"commerce.order_draft.bff.v0",
    "status":"draft","paymentStatus":"not_started","currency":"PLN","taxIncluded":true,
    "lines":[{
      "sku":"ROUND-A","productSlug":"round-a","quantity":1,
      "unitPriceGross":{"amountMinor":1490,"currency":"PLN"},
      "lineSubtotalGross":{"amountMinor":1490,"currency":"PLN"},
      "tax":{"vatRateBps":800,"netAmount":{"amountMinor":1380,"currency":"PLN"},
        "vatAmount":{"amountMinor":110,"currency":"PLN"},
        "grossAmount":{"amountMinor":1490,"currency":"PLN"}}
    },{
      "sku":"ROUND-B","productSlug":"round-b","quantity":1,
      "unitPriceGross":{"amountMinor":2980,"currency":"PLN"},
      "lineSubtotalGross":{"amountMinor":2980,"currency":"PLN"},
      "tax":{"vatRateBps":800,"netAmount":{"amountMinor":2759,"currency":"PLN"},
        "vatAmount":{"amountMinor":221,"currency":"PLN"},
        "grossAmount":{"amountMinor":2980,"currency":"PLN"}}
    }],
    "totals":{"subtotalGross":{"amountMinor":4470,"currency":"PLN"},
      "discountTotalGross":{"amountMinor":6,"currency":"PLN"},
      "netTotal":{"amountMinor":4133,"currency":"PLN"},
      "taxTotal":{"amountMinor":331,"currency":"PLN"},
      "totalGross":{"amountMinor":4464,"currency":"PLN"}}
  }'::jsonb
) AS result;
SELECT is(
  (SELECT jsonb_build_object(
    'lines', array_agg(ARRAY[
      i.discount_allocated_cents, i.effective_total_cents, i.effective_net_cents
    ] ORDER BY i.product_snapshot->>'sku'),
    'gross', o.total_cents,
    'headerTax', o.tax_cents,
    'netRoundingResidual', sum(i.effective_net_cents) - (o.total_cents - o.tax_cents)
  )
     FROM public.commerce_orders AS o
     JOIN public.commerce_order_items AS i ON i.order_id = o.id
    WHERE o.id = replace(
      (SELECT result#>>'{orderDraft,orderId}' FROM _checkout_rounding_edge),
      'order_', ''
    )::uuid
    GROUP BY o.total_cents, o.tax_cents),
  '{"lines":[[2,1488,1378],[4,2976,2756]],"gross":4464,"headerTax":330,"netRoundingResidual":0}'::jsonb,
  'header net and VAT close exactly over persisted per-line effective nets');
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-rounding-drift-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    jsonb_set(
      jsonb_set(
        (SELECT metadata->'orderDraftSnapshot'
           FROM public.commerce_orders
          WHERE id = replace(
            (SELECT result#>>'{orderDraft,orderId}' FROM _checkout_rounding_edge),
            'order_', ''
          )::uuid),
        '{totals,netTotal,amountMinor}', '4135'::jsonb
      ),
      '{totals,taxTotal,amountMinor}', '329'::jsonb
    )
  )$$,
  '22023',
  'commerce_order_draft_tax_totals_mismatch',
  'checkout rejects a tax split that matches neither the quote contract nor canonical positions');
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-tax-split-bad-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    jsonb_set(
      jsonb_set(
        (SELECT metadata->'orderDraftSnapshot'
           FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
        '{totals,netTotal,amountMinor}', '3448'::jsonb
      ),
      '{totals,taxTotal,amountMinor}', '277'::jsonb
    )
  )$$,
  '22023',
  'commerce_order_draft_tax_totals_mismatch',
  'checkout rejects an arbitrary header net/tax split even when it still sums to gross');

SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-bad-total-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    jsonb_set(
      (SELECT metadata->'orderDraftSnapshot'
         FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
      '{totals,totalGross,amountMinor}',
      '3726'::jsonb
    )
  )$$,
  '22023',
  'commerce_order_draft_totals_mismatch',
  'checkout rejects a non-closing header total');
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-bad-lines-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    jsonb_set(
      (SELECT metadata->'orderDraftSnapshot'
         FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id)),
      '{totals,subtotalGross,amountMinor}',
      '7451'::jsonb
    )
  )$$,
  '22023',
  'commerce_order_draft_totals_mismatch',
  'checkout rejects a subtotal that no longer closes');
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-missing-total-currency-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    (SELECT metadata->'orderDraftSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id))
      #- '{totals,totalGross,currency}'
  )$$,
  '22023',
  'commerce_order_draft_mixed_currency: (absent), ' || public.platform_settlement_currency(),
  'checkout refuses a required total with missing currency as a single-currency violation');
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-missing-line-currency-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    (SELECT metadata->'orderDraftSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id))
      #- '{lines,0,tax,grossAmount,currency}'
  )$$,
  '22023',
  'commerce_order_draft_mixed_currency: (absent), ' || public.platform_settlement_currency(),
  'checkout refuses a required line amount with missing currency as a single-currency violation');
SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key IN (
        'canonical-bad-total-1',
        'canonical-bad-lines-1',
        'canonical-checkout-missing-total-currency-1',
        'canonical-checkout-missing-line-currency-1'
      )),
  0,
  'rejected checkout requests leave no partial idempotency side effects');

CREATE TEMP TABLE _checkout_atomic_counts AS
SELECT jsonb_build_object(
  'orders', (SELECT count(*) FROM public.commerce_orders),
  'items', (SELECT count(*) FROM public.commerce_order_items),
  'outbox', (SELECT count(*) FROM public.outbox_events),
  'idempotency', (SELECT count(*) FROM public.commerce_idempotency_keys)
) AS counts;
CREATE FUNCTION pg_temp.canonical_fail_checkout_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.event_type = 'commerce.order_draft.created' THEN
    RAISE EXCEPTION 'canonical_forced_checkout_outbox_failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER canonical_fail_checkout_outbox_trigger
BEFORE INSERT ON public.outbox_events
FOR EACH ROW EXECUTE FUNCTION pg_temp.canonical_fail_checkout_outbox();
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
    'canonical-checkout-atomic-failure-1',
    '{"contractVersion":"commerce.v0"}'::jsonb,
    (SELECT metadata->'orderDraftSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _checkout_id))
  )$$,
  'P0001',
  'canonical_forced_checkout_outbox_failure',
  'checkout rolls back order, lines and idempotency after a downstream outbox failure');
DROP TRIGGER canonical_fail_checkout_outbox_trigger ON public.outbox_events;
SELECT is(
  (SELECT jsonb_build_object(
    'orders', (SELECT count(*) FROM public.commerce_orders),
    'items', (SELECT count(*) FROM public.commerce_order_items),
    'outbox', (SELECT count(*) FROM public.outbox_events),
    'idempotency', (SELECT count(*) FROM public.commerce_idempotency_keys)
  )),
  (SELECT counts FROM _checkout_atomic_counts),
  'forced post-write checkout failure leaves every writer table unchanged');

INSERT INTO public.commerce_orders (
  id, status, currency, subtotal_cents, discount_cents, shipping_cents,
  shipping_discount_cents, tax_cents, total_cents, metadata
) VALUES
(
  'ca000000-0000-4000-8000-000000000010', 'draft', 'PLN',
  100, 0, 0, 0, 0, 100, '{"fixture":"vat-zero"}'::jsonb
),
(
  'ca000000-0000-4000-8000-000000000011', 'draft', 'PLN',
  12300, 0, 0, 0, 2300, 12300, '{"fixture":"vat-23"}'::jsonb
);
INSERT INTO public.commerce_order_items (
  id, order_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents,
  vat_rate_bps, allocation_ordinal, product_snapshot
) VALUES
(
  'ca000000-0000-4000-8000-000000000012',
  'ca000000-0000-4000-8000-000000000010', 1, 100, 100,
  0, 100, 100, 0, 1, '{"sku":"VAT-ZERO"}'::jsonb
),
(
  'ca000000-0000-4000-8000-000000000013',
  'ca000000-0000-4000-8000-000000000011', 1, 12300, 12300,
  0, 12300, 10000, 2300, 1, '{"sku":"VAT-23"}'::jsonb
);
SELECT is(
  (SELECT array_agg(ARRAY[vat_rate_bps, effective_total_cents, effective_net_cents]
            ORDER BY vat_rate_bps)
     FROM public.commerce_order_items
    WHERE id IN (
      'ca000000-0000-4000-8000-000000000012',
      'ca000000-0000-4000-8000-000000000013'
    )),
  ARRAY[ARRAY[0, 100, 100], ARRAY[2300, 12300, 10000]],
  'canonical net constraints cover exact zero and twenty-three-percent VAT splits');

INSERT INTO public.catalog_products (
  id, slug, status, name, ingredients, allergens, marketing_content
) VALUES (
  'ca000000-0000-4000-8000-000000000001', 'canonical-renewal', 'active',
  'Canonical renewal', ARRAY['test']::text[], ARRAY[]::text[], '{}'::jsonb
);
INSERT INTO public.catalog_skus (
  id, product_id, sku, title, pet_type, status, net_weight_g, format_code,
  unit_form_code, kcal_per_unit, feeding_grams_per_unit, sellable_standalone,
  sellable_in_subscription, min_order_qty
) VALUES
(
  'ca000000-0000-4000-8000-000000000002',
  'ca000000-0000-4000-8000-000000000001',
  'CANON-RENEWAL-A', 'Canonical renewal SKU A', 'dog', 'active', 400, 'can',
  'can', 400, 400, true, true, 1
),
(
  'ca000000-0000-4000-8000-000000000005',
  'ca000000-0000-4000-8000-000000000001',
  'CANON-RENEWAL-B', 'Canonical renewal SKU B', 'dog', 'active', 800, 'can',
  'can', 400, 400, true, true, 1
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'canonical-renewal-stock-1',
  'omnipack',
  'CANON-RENEWAL-A',
  10, 10, 0,
  now(),
  now() + interval '6 hours',
  'canonical-renewal-stock-run-1',
  '{"source":"canonical_order_money_test"}'::jsonb
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'canonical-renewal-stock-2',
  'omnipack',
  'CANON-RENEWAL-B',
  10, 10, 0,
  now(),
  now() + interval '6 hours',
  'canonical-renewal-stock-run-1',
  '{"source":"canonical_order_money_test"}'::jsonb
);
INSERT INTO public.clients (id, email)
VALUES ('ca000000-0000-4000-8000-000000000003', 'canonical-renewal@example.invalid');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, size_constraint, currency, region_code, status,
  next_cycle_at, started_at, edit_window_hours, template_version,
  payment_method_ref, payment_method_kind, timezone
) VALUES (
  'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000003',
  14, '{"kind":"unit_count","value":2}'::jsonb, 'PLN', 'PL', 'active',
  '2026-08-01T10:00:00Z', '2026-07-01T10:00:00Z', 72, 1,
  'pm_canonical', 'card', 'Europe/Warsaw'
);
INSERT INTO public.subscription_lines (
  subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
) VALUES
(
  'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000002',
  1, 1, false, 1, '{}'::jsonb
),
(
  'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000005',
  1, 2, false, 1, '{}'::jsonb
);

CREATE TEMP TABLE _renewal AS
SELECT public.subscription_create_cycle_order_with_outbox(
  'canonical-renewal-0001',
  'ca000000-0000-4000-8000-000000000004',
  1,
  '2026-08-01T10:00:00Z',
  public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
  '{"source":"canonical_order_money_test"}'::jsonb,
  '{
    "contractVersion":"commerce.v0","source":"subscription.own_engine.v0",
    "status":"pending_payment","paymentStatus":"pending","currency":"PLN",
    "taxIncluded":true,
    "lines":[{
      "sku":"CANON-RENEWAL-A","productSlug":"canonical-renewal","quantity":1,
      "unitPriceGross":{"amountMinor":1000,"currency":"PLN"},
      "lineSubtotalGross":{"amountMinor":1000,"currency":"PLN"},
      "tax":{"vatRateBps":800,
        "netAmount":{"amountMinor":926,"currency":"PLN"},
        "vatAmount":{"amountMinor":74,"currency":"PLN"},
        "grossAmount":{"amountMinor":1000,"currency":"PLN"}}
    },{
      "sku":"CANON-RENEWAL-B","productSlug":"canonical-renewal","quantity":1,
      "unitPriceGross":{"amountMinor":2000,"currency":"PLN"},
      "lineSubtotalGross":{"amountMinor":2000,"currency":"PLN"},
      "tax":{"vatRateBps":800,
        "netAmount":{"amountMinor":1852,"currency":"PLN"},
        "vatAmount":{"amountMinor":148,"currency":"PLN"},
        "grossAmount":{"amountMinor":2000,"currency":"PLN"}}
    }],
    "totals":{
      "subtotalGross":{"amountMinor":3000,"currency":"PLN"},
      "discountTotalGross":{"amountMinor":900,"currency":"PLN"},
      "shippingGross":{"amountMinor":1500,"currency":"PLN"},
      "shippingDiscountGross":{"amountMinor":1500,"currency":"PLN"},
      "netTotal":{"amountMinor":1945,"currency":"PLN"},
      "taxTotal":{"amountMinor":155,"currency":"PLN"},
      "totalGross":{"amountMinor":2100,"currency":"PLN"}
    }
  }'::jsonb
) AS result;

CREATE TEMP TABLE _renewal_ids AS
SELECT
  replace(result#>>'{subscriptionCycleOrder,orderId}', 'order_', '')::uuid AS order_id,
  replace(result#>>'{subscriptionCycleOrder,paymentId}', 'payment_', '')::uuid AS payment_id
FROM _renewal;

SELECT is(
  (SELECT ARRAY[
      discount_cents, shipping_cents, shipping_discount_cents, tax_cents, total_cents
    ]
     FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids)),
  ARRAY[900, 1500, 1500, 156, 2100],
  'renewal writer accepts quote-level rounding and persists canonical tax with discounts');
SELECT is(
  (SELECT array_agg(
            ARRAY[discount_allocated_cents, effective_total_cents, effective_net_cents]
            ORDER BY product_snapshot->>'sku'
          )
     FROM public.commerce_order_items WHERE order_id = (SELECT order_id FROM _renewal_ids)),
  ARRAY[ARRAY[300, 700, 648], ARRAY[600, 1400, 1296]],
  'renewal writer allocates a nonzero discount over multiple lines');
SELECT is(
  (SELECT amount_cents FROM public.commerce_payments WHERE id = (SELECT payment_id FROM _renewal_ids)),
  2100,
  'renewal payment request uses the same canonical order total');
SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
    'canonical-renewal-tax-split-bad-1',
    'ca000000-0000-4000-8000-000000000004',
    2,
    '2026-09-01T10:00:00Z',
    public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
    '{"source":"canonical_order_money_test"}'::jsonb,
    jsonb_set(
      jsonb_set(
        (SELECT metadata->'orderSnapshot'
           FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids)),
        '{totals,netTotal,amountMinor}', '1946'::jsonb
      ),
      '{totals,taxTotal,amountMinor}', '154'::jsonb
    )
  )$$,
  '22023',
  'subscription_cycle_order_tax_totals_mismatch',
  'renewal rejects a tax split that matches neither quote nor canonical rounding');

SELECT is(
  public.subscription_create_cycle_order_with_outbox(
    'canonical-renewal-0001',
    'ca000000-0000-4000-8000-000000000004',
    1,
    '2026-08-01T10:00:00Z',
    public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
    '{"source":"canonical_order_money_test"}'::jsonb,
    (SELECT metadata->'orderSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids))
  )#>>'{subscriptionCycleOrder,replayed}',
  'true',
  'renewal replay returns the completed canonical cycle order');
SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_cycles
    WHERE subscription_id = 'ca000000-0000-4000-8000-000000000004'),
  1,
  'renewal replay does not duplicate the cycle');
SELECT is(
  (SELECT jsonb_build_object(
    'cycles', (SELECT count(*) FROM public.subscription_cycles
      WHERE id = (SELECT subscription_cycle_id FROM public.commerce_orders
        WHERE id = (SELECT order_id FROM _renewal_ids))),
    'orders', (SELECT count(*) FROM public.commerce_orders
      WHERE id = (SELECT order_id FROM _renewal_ids)),
    'items', (SELECT count(*) FROM public.commerce_order_items
      WHERE order_id = (SELECT order_id FROM _renewal_ids)),
    'payments', (SELECT count(*) FROM public.commerce_payments
      WHERE id = (SELECT payment_id FROM _renewal_ids)),
    'outbox', (SELECT count(*) FROM public.outbox_events
      WHERE aggregate_id = (SELECT payment_id FROM _renewal_ids)
        AND event_type = 'commerce.subscription_payment.requested'),
    'idempotency', (SELECT count(*) FROM public.commerce_idempotency_keys
      WHERE scope = 'subscription.cycle_order.create'
        AND idempotency_key = 'canonical-renewal-0001')
  )),
  '{"cycles":1,"orders":1,"items":2,"payments":1,"outbox":1,"idempotency":1}'::jsonb,
  'renewal replay preserves exactly one complete cycle/order/payment graph');

CREATE TEMP TABLE _renewal_atomic_counts AS
SELECT jsonb_build_object(
  'cycles', (SELECT count(*) FROM public.subscription_cycles),
  'orders', (SELECT count(*) FROM public.commerce_orders),
  'items', (SELECT count(*) FROM public.commerce_order_items),
  'payments', (SELECT count(*) FROM public.commerce_payments),
  'outbox', (SELECT count(*) FROM public.outbox_events),
  'events', (SELECT count(*) FROM public.subscription_events),
  'idempotency', (SELECT count(*) FROM public.commerce_idempotency_keys)
) AS counts;
SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
    'canonical-renewal-atomic-failure-1',
    'ca000000-0000-4000-8000-000000000004',
    2,
    '2026-08-15T10:00:00Z',
    public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
    '{"source":"canonical_order_money_test"}'::jsonb,
    jsonb_set(
      (SELECT metadata->'orderSnapshot'
         FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids)),
      '{lines,0,sku}', '"CANON-UNKNOWN"'::jsonb
    )
  )$$,
  '22023',
  'subscription_cycle_order_unknown_sku: CANON-UNKNOWN',
  'renewal rolls back idempotency, cycle and order after a post-write SKU failure');
SELECT is(
  (SELECT jsonb_build_object(
    'cycles', (SELECT count(*) FROM public.subscription_cycles),
    'orders', (SELECT count(*) FROM public.commerce_orders),
    'items', (SELECT count(*) FROM public.commerce_order_items),
    'payments', (SELECT count(*) FROM public.commerce_payments),
    'outbox', (SELECT count(*) FROM public.outbox_events),
    'events', (SELECT count(*) FROM public.subscription_events),
    'idempotency', (SELECT count(*) FROM public.commerce_idempotency_keys)
  )),
  (SELECT counts FROM _renewal_atomic_counts),
  'forced post-write renewal failure leaves every writer table unchanged');
SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
    'canonical-renewal-bad-total-1',
    'ca000000-0000-4000-8000-000000000004',
    2,
    '2026-08-15T10:00:00Z',
    public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
    '{"source":"canonical_order_money_test"}'::jsonb,
    jsonb_set(
      (SELECT metadata->'orderSnapshot'
         FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids)),
      '{totals,totalGross,amountMinor}', '2101'::jsonb
    )
  )$$,
  '22023',
  'subscription_cycle_order_totals_mismatch',
  'renewal rejects a non-closing total');
SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
    'canonical-renewal-missing-total-currency-1',
    'ca000000-0000-4000-8000-000000000004',
    2,
    '2026-08-15T10:00:00Z',
    public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
    '{"source":"canonical_order_money_test"}'::jsonb,
    (SELECT metadata->'orderSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids))
      #- '{totals,totalGross,currency}'
  )$$,
  '22023',
  'subscription_cycle_order_mixed_currency: (absent), ' || public.platform_settlement_currency(),
  'renewal refuses a required total with missing currency as a single-currency violation');
SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
    'canonical-renewal-missing-line-currency-1',
    'ca000000-0000-4000-8000-000000000004',
    2,
    '2026-08-15T10:00:00Z',
    public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
    '{"source":"canonical_order_money_test"}'::jsonb,
    (SELECT metadata->'orderSnapshot'
       FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids))
      #- '{lines,0,tax,grossAmount,currency}'
  )$$,
  '22023',
  'subscription_cycle_order_mixed_currency: (absent), ' || public.platform_settlement_currency(),
  'renewal refuses a required line amount with missing currency as a single-currency violation');
SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_idempotency_keys
    WHERE scope = 'subscription.cycle_order.create'
      AND idempotency_key IN (
        'canonical-renewal-bad-total-1',
        'canonical-renewal-missing-total-currency-1',
        'canonical-renewal-missing-line-currency-1'
      )),
  0,
  'rejected renewal leaves no partial idempotency side effects');

-- Model B treats cycle 1 as subscription_initial and cycle 2+ as renewal.
-- Exercise both through the same canonical invoice boundary.
CREATE TEMP TABLE _renewal_second AS
SELECT public.subscription_create_cycle_order_with_outbox(
  'canonical-renewal-0002',
  'ca000000-0000-4000-8000-000000000004',
  2,
  '2026-08-15T10:00:00Z',
  public.subscription_current_template_snapshot('ca000000-0000-4000-8000-000000000004'),
  '{"source":"canonical_order_money_test"}'::jsonb,
  (SELECT metadata->'orderSnapshot'
     FROM public.commerce_orders WHERE id = (SELECT order_id FROM _renewal_ids))
) AS result;
CREATE TEMP TABLE _subscription_invoice_modes AS
SELECT 1 AS cycle_no, order_id, payment_id
  FROM _renewal_ids
UNION ALL
SELECT
  2,
  replace(result#>>'{subscriptionCycleOrder,orderId}', 'order_', '')::uuid,
  replace(result#>>'{subscriptionCycleOrder,paymentId}', 'payment_', '')::uuid
  FROM _renewal_second;

UPDATE public.commerce_payments payment
   SET provider = 'stripe',
       provider_payment_id = 'pi_subscription_cycle_' || modes.cycle_no,
       status = 'succeeded'
  FROM _subscription_invoice_modes modes
 WHERE payment.id = modes.payment_id;
UPDATE public.commerce_orders orders
   SET status = 'paid'
  FROM _subscription_invoice_modes modes
 WHERE orders.id = modes.order_id;
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, subscription_id, subscription_cycle_id,
  payment_id, status, amount_cents, currency, provider_payment_id, updated_at
)
SELECT
  CASE modes.cycle_no
    WHEN 1 THEN 'ca000000-0000-4000-8000-000000000021'::uuid
    ELSE 'ca000000-0000-4000-8000-000000000022'::uuid
  END,
  'subscription_cycle',
  modes.order_id,
  'ca000000-0000-4000-8000-000000000004'::uuid,
  orders.subscription_cycle_id,
  modes.payment_id,
  'succeeded',
  orders.total_cents,
  orders.currency,
  'pi_subscription_cycle_' || modes.cycle_no,
  now()
  FROM _subscription_invoice_modes modes
  JOIN public.commerce_orders orders ON orders.id = modes.order_id;

INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot,
  order_snapshot, tax_snapshot, lines_snapshot, total_net_cents,
  total_gross_cents, provider_kind, metadata
)
SELECT
  CASE modes.cycle_no
    WHEN 1 THEN 'ca000000-0000-4000-8000-000000000031'::uuid
    ELSE 'ca000000-0000-4000-8000-000000000032'::uuid
  END,
  modes.order_id,
  'SUB-CYCLE-' || modes.cycle_no,
  'SUB-CYCLE-' || modes.cycle_no || ':issue',
  'issue_requested',
  orders.currency,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '[{"name":"caller catalog line"}]'::jsonb,
  orders.total_cents - orders.tax_cents,
  orders.total_cents,
  'fakturownia_test',
  jsonb_build_object('fixtureMode', CASE modes.cycle_no WHEN 1 THEN 'subscription_initial' ELSE 'subscription_renewal' END)
  FROM _subscription_invoice_modes modes
  JOIN public.commerce_orders orders ON orders.id = modes.order_id;

INSERT INTO public.accounting_invoice_issue_outbox (invoice_id, provider_kind)
SELECT invoice.id, invoice.provider_kind
  FROM public.accounting_invoices invoice
 WHERE invoice.id IN (
   'ca000000-0000-4000-8000-000000000031',
   'ca000000-0000-4000-8000-000000000032'
 );
CREATE TEMP TABLE _subscription_invoice_claims AS
SELECT public.accounting_invoice_issue_outbox_claim(
  5, 300, NULL, 'accounting.issue.v2'
) AS r;

SELECT is(
  (SELECT array_agg((metadata->>'canonicalMoneyVersion')::integer ORDER BY invoice_ref)
     FROM public.accounting_invoices
    WHERE id IN (
      'ca000000-0000-4000-8000-000000000031',
      'ca000000-0000-4000-8000-000000000032'
    )),
  ARRAY[1, 1],
  'subscription initial and renewal invoices both persist canonical money version'
);
SELECT is(
  (SELECT array_agg(position_sum ORDER BY cycle_no)
     FROM (
       SELECT modes.cycle_no,
              sum((position->>'totalGrossMinor')::integer)::integer AS position_sum
         FROM _subscription_invoice_modes modes
         JOIN public.accounting_invoices invoice ON invoice.order_id = modes.order_id
         CROSS JOIN LATERAL jsonb_array_elements(invoice.lines_snapshot) position
        GROUP BY modes.cycle_no
     ) sums),
  ARRAY[2100, 2100],
  'subscription initial and renewal invoice positions close to their order totals'
);
SELECT is(
  (SELECT array_agg(
            (public.accounting_invoice_issue_payment_preflight(
              invoice.id,
              'succeeded',
              invoice.total_gross_cents,
              invoice.currency,
              jsonb_build_object(
                'source', 'provider_api',
                'provider', 'stripe',
                'providerPaymentId', invoice.provider_payment_id
              ),
              outbox.id,
              outbox.attempt_count
            )->>'ok')::boolean
            ORDER BY modes.cycle_no
          )
     FROM _subscription_invoice_modes modes
     JOIN public.accounting_invoices invoice ON invoice.order_id = modes.order_id
     JOIN public.accounting_invoice_issue_outbox outbox ON outbox.invoice_id = invoice.id),
  ARRAY[true, true],
  'subscription initial and renewal pass the final provider-bound preflight'
);

INSERT INTO public.commerce_orders (
  id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents
) VALUES (
  'ca000000-0000-4000-8000-000000000040', 'CANON-MIXED-VAT', 'paid', 'PLN',
  223, 0, 0, 0, 23, 223
);
INSERT INTO public.commerce_order_items (
  id, order_id, quantity, unit_price_cents, total_cents,
  discount_allocated_cents, effective_total_cents, effective_net_cents,
  vat_rate_bps, allocation_ordinal, product_snapshot
) VALUES
(
  'ca000000-0000-4000-8000-000000000041',
  'ca000000-0000-4000-8000-000000000040',
  1, 100, 100, 0, 100, 100, 0, 1, '{"sku":"MIXED-ZERO"}'::jsonb
),
(
  'ca000000-0000-4000-8000-000000000042',
  'ca000000-0000-4000-8000-000000000040',
  1, 123, 123, 0, 123, 100, 2300, 2, '{"sku":"MIXED-23"}'::jsonb
);
INSERT INTO public.commerce_payments (
  id, order_id, provider, provider_payment_id, status, amount_cents, currency
) VALUES (
  'ca000000-0000-4000-8000-000000000043',
  'ca000000-0000-4000-8000-000000000040',
  'stripe', 'pi_mixed_vat', 'succeeded', 223, 'PLN'
);
INSERT INTO public.commerce_payment_intents (
  id, target_kind, order_id, payment_id, status, amount_cents, currency,
  provider_payment_id, updated_at
) VALUES (
  'ca000000-0000-4000-8000-000000000044',
  'one_time_order',
  'ca000000-0000-4000-8000-000000000040',
  'ca000000-0000-4000-8000-000000000043',
  'succeeded', 223, 'PLN', 'pi_mixed_vat', now()
);
INSERT INTO public.accounting_invoices (
  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot,
  order_snapshot, tax_snapshot, lines_snapshot, total_net_cents,
  total_gross_cents, provider_kind, metadata
) VALUES (
  'ca000000-0000-4000-8000-000000000045',
  'ca000000-0000-4000-8000-000000000040',
  'CANON-MIXED-VAT', 'CANON-MIXED-VAT:issue', 'issue_requested', 'PLN',
  '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
  200, 223, 'fakturownia_test', '{"fixtureMode":"one_time"}'::jsonb
);
SELECT is(
  (SELECT array_agg((position->>'vatRateBps')::integer ORDER BY (position->>'allocationOrdinal')::integer)
     FROM public.accounting_invoices invoice
     CROSS JOIN LATERAL jsonb_array_elements(invoice.lines_snapshot) position
    WHERE invoice.id = 'ca000000-0000-4000-8000-000000000045'),
  ARRAY[0, 2300],
  'mixed per-line VAT remains valid when there is no delivery position requiring one shipping VAT rate'
);

SELECT * FROM finish();
ROLLBACK;
