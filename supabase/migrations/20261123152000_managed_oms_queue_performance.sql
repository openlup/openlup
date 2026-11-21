-- Optimize managed public.commerce_oms_admin_list_queue and add supporting indexes.
-- Preserves exact signature, return JSON contract, search scoring, paid_at summary
-- semantics, and mixed-currency refusal while separating non-search and search plans
-- (avoiding 300+ dead search expressions / JIT overhead on browse queries),
-- replacing 9x repeated operational counts with a single FILTER pass, replacing
-- full-set window pagination with Top-N LIMIT/OFFSET, and adding targeted indexes.
-- Reads the installed fulfillment provider identifier from the installed ATP function
-- so no vendor literal is duplicated in this forward migration.

CREATE INDEX IF NOT EXISTS idx_commerce_orders_oms_created_id
  ON public.commerce_orders (created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_commerce_payment_intents_oms_order_latest
  ON public.commerce_payment_intents (order_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_payment_intents_oms_paid_updated_order
  ON public.commerce_payment_intents (updated_at, order_id)
  WHERE status IN ('succeeded', 'paid');

CREATE INDEX IF NOT EXISTS idx_commerce_fulfillment_orders_oms_order_latest
  ON public.commerce_fulfillment_orders (order_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_accounting_invoices_oms_order_latest
  ON public.accounting_invoices (order_id, updated_at DESC, id DESC);

DO $$
DECLARE
  v_provider text;
  v_dispatch_table text;
  v_evidence_table text;
  v_dispatch_failed text;
  v_picked_not_shipped text;
  v_dispatched_not_picked text;
  v_dispatched_not_picked_key text;
  v_common_tail text;
BEGIN
  v_provider := (regexp_match(
    pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure),
    $binding$stock\.provider_kind='([^']+)'$binding$
  ))[1];
  IF v_provider IS NULL OR btrim(v_provider) = '' THEN
    RAISE EXCEPTION 'managed_oms_provider_binding_missing';
  END IF;

  v_dispatch_table := v_provider || '_dispatch_refs';
  v_evidence_table := v_provider || '_status_evidence';
  v_dispatch_failed := v_provider || '_dispatch_failed';
  v_picked_not_shipped := v_provider || '_picked_not_shipped';
  v_dispatched_not_picked := v_provider || '_dispatched_not_picked';
  v_dispatched_not_picked_key := v_provider || 'DispatchedNotPicked';

  v_common_tail := format($tail$
    latest_payment AS (
      SELECT DISTINCT ON (payment.order_id)
             payment.order_id,
             CASE
               WHEN payment.status IS NULL THEN 'not_started'
               WHEN payment.status = 'pending' THEN 'processing'
               WHEN payment.status = 'paid' THEN 'succeeded'
               ELSE payment.status
             END AS payment_status
        FROM public.commerce_payment_intents payment
        JOIN base_orders orders ON orders.id = payment.order_id
       ORDER BY payment.order_id, payment.updated_at DESC, payment.id DESC
    ),
    latest_summary_payment AS (
      SELECT DISTINCT ON (payment.order_id)
             payment.order_id,
             payment.updated_at AS paid_at
        FROM paid_window_orders pwo
        JOIN public.commerce_payment_intents payment ON payment.order_id = pwo.order_id
       WHERE payment.status IN ('succeeded', 'paid')
       ORDER BY payment.order_id, payment.updated_at DESC, payment.id DESC
    ),
    active_holds AS (
      SELECT hold_rows.order_id, count(*)::integer AS active_hold_count
        FROM public.commerce_order_holds hold_rows
        JOIN base_orders orders ON orders.id = hold_rows.order_id
       WHERE hold_rows.status = 'active'
       GROUP BY hold_rows.order_id
    ),
    base_reservations AS MATERIALIZED (
      SELECT reservations.order_id,
             reservations.order_item_id,
             reservations.status,
             reservations.quantity
        FROM public.inventory_reservations reservations
        JOIN base_orders orders ON orders.id = reservations.order_id
    ),
    reservation_quantities AS (
      SELECT reservations.order_id,
             reservations.order_item_id,
             sum(
               CASE
                 WHEN reservations.status IN ('reserved', 'consumed') THEN reservations.quantity
                 ELSE 0
               END
             )::integer AS covered_quantity
        FROM base_reservations reservations
       GROUP BY reservations.order_id, reservations.order_item_id
    ),
    reservation_rollup AS (
      SELECT reservations.order_id,
             count(*) > 0 AS has_reservation,
             bool_or(reservations.status = 'reserved') AS has_reserved,
             bool_or(reservations.status = 'consumed') AS has_consumed,
             bool_or(reservations.status = 'expired') AS has_expired,
             bool_or(reservations.status = 'released') AS has_released
        FROM base_reservations reservations
       GROUP BY reservations.order_id
    ),
    uncovered_orders AS (
      SELECT DISTINCT items.order_id
        FROM public.commerce_order_items items
        JOIN base_orders orders ON orders.id = items.order_id
        LEFT JOIN reservation_quantities covered
          ON covered.order_item_id = items.id
         AND covered.order_id = items.order_id
       WHERE coalesce(covered.covered_quantity, 0) < items.quantity
    ),
    inventory AS (
      SELECT orders.id AS order_id,
             CASE
               WHEN coalesce(rollup.has_reservation, false) = false THEN 'missing'
               WHEN uncovered.order_id IS NOT NULL THEN 'missing'
               WHEN coalesce(rollup.has_consumed, false) = true
                    AND coalesce(rollup.has_reserved, false) = false THEN 'consumed'
               WHEN coalesce(rollup.has_reserved, false) = true THEN 'reserved'
               WHEN coalesce(rollup.has_expired, false) = true THEN 'expired'
               WHEN coalesce(rollup.has_released, false) = true THEN 'released'
               ELSE 'review_required'
             END AS inventory_status
        FROM base_orders orders
        LEFT JOIN reservation_rollup rollup ON rollup.order_id = orders.id
        LEFT JOIN uncovered_orders uncovered ON uncovered.order_id = orders.id
    ),
    latest_fulfillment AS MATERIALIZED (
      SELECT DISTINCT ON (fulfillment.order_id)
             fulfillment.order_id,
             fulfillment.id AS fulfillment_order_id,
             fulfillment.provider_kind,
             fulfillment.status AS fulfillment_status
        FROM public.commerce_fulfillment_orders fulfillment
        JOIN base_orders orders ON orders.id = fulfillment.order_id
       ORDER BY fulfillment.order_id, fulfillment.updated_at DESC, fulfillment.id DESC
    ),
    latest_provider_dispatch AS (
      SELECT DISTINCT ON (refs.fulfillment_order_id)
             refs.fulfillment_order_id,
             refs.provider_order_id,
             refs.status
        FROM public.%I refs
        JOIN latest_fulfillment fulfillment ON fulfillment.fulfillment_order_id = refs.fulfillment_order_id
       ORDER BY refs.fulfillment_order_id, refs.updated_at DESC NULLS LAST, refs.created_at DESC NULLS LAST, refs.id DESC
    ),
    latest_provider_status AS (
      SELECT DISTINCT ON (evidence.fulfillment_order_id)
             evidence.fulfillment_order_id,
             evidence.local_status
        FROM public.%I evidence
        JOIN latest_fulfillment fulfillment ON fulfillment.fulfillment_order_id = evidence.fulfillment_order_id
       ORDER BY evidence.fulfillment_order_id, evidence.occurred_at DESC NULLS LAST, evidence.created_at DESC NULLS LAST, evidence.id DESC
    ),
    provider_ops AS (
      SELECT orders.id AS order_id,
             CASE
               WHEN dispatch.status = 'failed' THEN %L
               WHEN dispatch.status = 'created'
                    AND dispatch.provider_order_id IS NOT NULL
                    AND (
                      fulfillment.fulfillment_status = 'packed'
                      OR status.local_status = 'packed'
                    )
                    AND coalesce(fulfillment.fulfillment_status, '') NOT IN ('handed_over', 'in_transit', 'delivered')
                    AND coalesce(status.local_status, '') NOT IN ('in_transit', 'delivered')
                 THEN %L
               WHEN dispatch.status = 'created'
                    AND dispatch.provider_order_id IS NOT NULL
                    AND coalesce(fulfillment.fulfillment_status, '') NOT IN ('packed', 'handed_over', 'in_transit', 'delivered', 'cancelled', 'exception')
                    AND coalesce(status.local_status, '') NOT IN ('packed', 'in_transit', 'delivered')
                 THEN %L
               ELSE 'none'
             END AS provider_ops_status
        FROM base_orders orders
        LEFT JOIN latest_fulfillment fulfillment ON fulfillment.order_id = orders.id
        LEFT JOIN latest_provider_dispatch dispatch ON dispatch.fulfillment_order_id = fulfillment.fulfillment_order_id
        LEFT JOIN latest_provider_status status ON status.fulfillment_order_id = fulfillment.fulfillment_order_id
    ),
    latest_invoice AS MATERIALIZED (
      SELECT DISTINCT ON (invoice.order_id)
             invoice.order_id,
             invoice.id AS invoice_id,
             invoice.status AS invoice_status,
             invoice.blocked_reason
        FROM public.accounting_invoices invoice
        JOIN base_orders orders ON orders.id = invoice.order_id
       ORDER BY invoice.order_id, invoice.updated_at DESC, invoice.id DESC
    ),
    latest_outbox AS (
      SELECT DISTINCT ON (outbox.invoice_id)
             outbox.invoice_id,
             outbox.status AS outbox_status
        FROM public.accounting_invoice_issue_outbox outbox
        JOIN latest_invoice invoice ON invoice.invoice_id = outbox.invoice_id
       ORDER BY outbox.invoice_id, outbox.created_at DESC, outbox.id DESC
    ),
    accounting AS (
      SELECT orders.id AS order_id,
             CASE
               WHEN invoice.invoice_id IS NULL THEN 'missing'
               WHEN outbox.outbox_status = 'failed' THEN 'outbox_failed'
               WHEN invoice.blocked_reason IS NOT NULL OR invoice.invoice_status = 'blocked' THEN 'blocked'
               WHEN invoice.invoice_status IN (
                 'draft', 'issue_requested', 'issued', 'ksef_pending',
                 'accepted', 'rejected', 'correction_requested', 'corrected',
                 'voided'
               ) THEN invoice.invoice_status
               ELSE 'missing'
             END AS accounting_status
        FROM base_orders orders
        LEFT JOIN latest_invoice invoice ON invoice.order_id = orders.id
        LEFT JOIN latest_outbox outbox ON outbox.invoice_id = invoice.invoice_id
    ),
    derived AS (
      SELECT orders.id,
             orders.status AS order_status,
             orders.created_at,
             orders.updated_at,
             orders.shipping_address_id,
             orders.search_rank,
             orders.search_match,
             coalesce(payment.payment_status, 'not_started') AS payment_status,
             coalesce(holds.active_hold_count, 0) AS active_hold_count,
             inventory.inventory_status,
             fulfillment.fulfillment_status,
             accounting.accounting_status,
             coalesce(provider_ops.provider_ops_status, 'none') AS provider_ops_status,
             CASE
               WHEN coalesce(holds.active_hold_count, 0) > 0 THEN false
               WHEN orders.shipping_address_id IS NULL THEN false
               WHEN orders.status NOT IN ('paid', 'fulfillment_pending', 'fulfilled') THEN false
               WHEN coalesce(payment.payment_status, 'not_started') <> 'succeeded' THEN false
               WHEN orders.mode = 'subscription_cycle'
                    AND coalesce(cycles.status, '') <> 'paid' THEN false
               WHEN inventory.inventory_status NOT IN ('reserved', 'consumed') THEN false
               ELSE true
             END AS fulfillment_allowed
        FROM base_orders orders
        LEFT JOIN latest_payment payment ON payment.order_id = orders.id
        LEFT JOIN active_holds holds ON holds.order_id = orders.id
        LEFT JOIN inventory ON inventory.order_id = orders.id
        LEFT JOIN latest_fulfillment fulfillment ON fulfillment.order_id = orders.id
        LEFT JOIN accounting ON accounting.order_id = orders.id
        LEFT JOIN provider_ops ON provider_ops.order_id = orders.id
        LEFT JOIN public.subscription_cycles cycles ON cycles.id = orders.subscription_cycle_id
    ),
    operational AS MATERIALIZED (
      SELECT derived.id,
             derived.created_at,
             derived.updated_at,
             derived.search_rank,
             derived.search_match,
             derived.payment_status,
             derived.active_hold_count,
             derived.inventory_status,
             derived.fulfillment_status,
             derived.accounting_status,
             derived.provider_ops_status,
             CASE
               WHEN order_status IN ('refunded', 'cancelled') THEN 'none'
               WHEN active_hold_count > 0 THEN 'active_hold'
               WHEN payment_status <> 'succeeded' THEN 'payment_required'
               WHEN shipping_address_id IS NULL THEN 'missing_shipping_address'
               WHEN inventory_status NOT IN ('reserved', 'consumed') THEN 'inventory_missing'
               WHEN fulfillment_status IS NULL AND fulfillment_allowed = false THEN 'fulfillment_blocked'
               WHEN fulfillment_status IS NULL THEN 'fulfillment_pending'
               WHEN fulfillment_status IN ('created', 'packed', 'label_pending') THEN 'fulfillment_pending'
               WHEN fulfillment_status = 'label_created' THEN 'fulfillment_pending'
               WHEN fulfillment_status = 'exception' THEN 'fulfillment_exception'
               WHEN accounting_status = 'missing' THEN 'invoice_missing'
               WHEN accounting_status = 'blocked' THEN 'invoice_buyer_data_invalid'
               WHEN accounting_status IN ('rejected', 'outbox_failed') THEN 'invoice_issue_failed'
               ELSE 'none'
             END AS attention_reason,
             CASE
               WHEN order_status IN ('refunded', 'cancelled') THEN 'none'
               WHEN active_hold_count > 0 THEN 'release_hold'
               WHEN payment_status <> 'succeeded' THEN 'review_payment'
               WHEN shipping_address_id IS NULL THEN 'review_address'
               WHEN inventory_status NOT IN ('reserved', 'consumed') THEN 'review_inventory'
               WHEN fulfillment_status IS NULL AND fulfillment_allowed = false THEN 'review_fulfillment'
               WHEN fulfillment_status IS NULL THEN 'create_fulfillment'
               WHEN fulfillment_status IN ('created', 'packed', 'label_pending') THEN 'record_label'
               WHEN fulfillment_status = 'label_created' THEN 'hand_off'
               WHEN fulfillment_status = 'exception' THEN 'review_tracking'
               WHEN accounting_status IN ('missing', 'blocked', 'rejected', 'outbox_failed') THEN 'review_invoice'
               ELSE 'none'
             END AS next_action
        FROM derived
    ),
    op_counts AS (
      SELECT count(*) FILTER (WHERE attention_reason <> 'none') AS needs_attention,
             count(*) FILTER (WHERE active_hold_count > 0) AS active_hold,
             count(*) FILTER (WHERE next_action = 'create_fulfillment') AS ready_for_fulfillment,
             count(*) FILTER (WHERE attention_reason = 'payment_required') AS payment_issues,
             count(*) FILTER (WHERE attention_reason = 'inventory_missing') AS inventory_risk,
             count(*) FILTER (WHERE attention_reason = 'fulfillment_blocked') AS fulfillment_blocked,
             count(*) FILTER (WHERE attention_reason = 'fulfillment_exception') AS fulfillment_exceptions,
             count(*) FILTER (WHERE next_action = 'review_invoice') AS invoice_issues,
             count(*) FILTER (WHERE provider_ops_status = %L) AS provider_dispatched_not_picked
        FROM operational
    ),
    filtered AS MATERIALIZED (
      SELECT id,
             created_at,
             updated_at,
             search_rank,
             search_match,
             attention_reason
        FROM operational
       WHERE (p_payment_status IS NULL OR payment_status = p_payment_status)
         AND (p_fulfillment_status IS NULL OR fulfillment_status = p_fulfillment_status)
         AND (p_inventory_status IS NULL OR inventory_status = p_inventory_status)
         AND (p_accounting_status IS NULL OR accounting_status = p_accounting_status)
         AND (p_provider_ops_status IS NULL OR provider_ops_status = p_provider_ops_status)
         AND (p_attention_reason IS NULL OR attention_reason = p_attention_reason)
         AND (coalesce(p_attention_only, false) = false OR attention_reason <> 'none')
         AND (p_next_action IS NULL OR next_action = p_next_action)
    ),
    paged AS (
      SELECT page_rows.id,
             page_rows.search_match,
             row_number() OVER () AS rn
        FROM (
          SELECT filtered.id,
                 filtered.search_match
            FROM filtered
           ORDER BY
             CASE WHEN v_has_search THEN search_rank END DESC NULLS LAST,
             CASE WHEN p_sort = 'attention_priority_desc' THEN
               CASE attention_reason
                 WHEN 'active_hold' THEN 1
                 WHEN 'payment_required' THEN 2
                 WHEN 'missing_shipping_address' THEN 3
                 WHEN 'inventory_missing' THEN 4
                 WHEN 'fulfillment_blocked' THEN 5
                 WHEN 'fulfillment_exception' THEN 6
                 WHEN 'invoice_issue_failed' THEN 7
                 WHEN 'invoice_buyer_data_invalid' THEN 8
                 WHEN 'invoice_missing' THEN 9
                 WHEN 'fulfillment_pending' THEN 9
                 ELSE 99
               END
             END ASC NULLS LAST,
             CASE WHEN p_sort = 'attention_priority_desc' THEN updated_at END DESC NULLS LAST,
             CASE WHEN p_sort = 'created_asc' THEN created_at END ASC NULLS LAST,
             CASE WHEN p_sort = 'created_desc' THEN created_at END DESC NULLS LAST,
             CASE WHEN p_sort = 'updated_asc' THEN updated_at END ASC NULLS LAST,
             CASE WHEN p_sort = 'updated_desc' THEN updated_at END DESC NULLS LAST,
             id ASC
           LIMIT v_page_size
          OFFSET v_offset
        ) page_rows
    ),
    paid_summary AS MATERIALIZED (
      SELECT coalesce(sum(paid_orders.total_cents)::bigint, 0) AS amount_minor,
             count(*)::integer AS order_count,
             count(DISTINCT paid_orders.currency)::integer AS currency_count,
             min(paid_orders.currency) AS currency,
             count(*) FILTER (
               WHERE paid_orders.mode = 'subscription_cycle'
                 AND paid_orders.subscription_id IS NOT NULL
             )::integer AS new_subscription_count
        FROM (
          SELECT orders.total_cents, orders.currency, orders.mode, orders.subscription_id
            FROM base_orders orders
           WHERE v_from IS NULL AND v_to IS NULL
             AND EXISTS (
               SELECT 1
                 FROM public.commerce_payment_intents payment
                WHERE payment.order_id = orders.id
                  AND payment.status IN ('succeeded', 'paid')
             )
          UNION ALL
          SELECT orders.total_cents, orders.currency, orders.mode, orders.subscription_id
            FROM latest_summary_payment payment
            JOIN scoped_orders orders ON orders.id = payment.order_id
           WHERE (v_from IS NOT NULL OR v_to IS NOT NULL)
             AND (v_from IS NULL OR payment.paid_at >= v_from)
             AND (v_to IS NULL OR payment.paid_at <= v_to)
        ) paid_orders
    )
    SELECT jsonb_build_object(
      'orderIds',
      coalesce((SELECT jsonb_agg(id ORDER BY rn) FROM paged), '[]'::jsonb),
      'matches',
      coalesce((SELECT jsonb_object_agg(id::text, search_match ORDER BY rn) FROM paged WHERE search_match IS NOT NULL), '{}'::jsonb),
      'totalCount',
      (SELECT count(*) FROM filtered),
      'summaryCounts',
      (
        SELECT jsonb_build_object(
          'needsAttention', needs_attention,
          'activeHold', active_hold,
          'readyForFulfillment', ready_for_fulfillment,
          'paymentIssues', payment_issues,
          'inventoryRisk', inventory_risk,
          'fulfillmentBlocked', fulfillment_blocked,
          'fulfillmentExceptions', fulfillment_exceptions,
          'invoiceIssues', invoice_issues,
          %L, provider_dispatched_not_picked
        )
        FROM op_counts
      ),
      'summaryTotals',
      (
        SELECT jsonb_build_object(
          'gmv', jsonb_build_object(
            'amountMinor', amount_minor,
            'currency', currency
          ),
          'aov', jsonb_build_object(
            'amountMinor',
            CASE
              WHEN order_count > 0
                THEN round(amount_minor::numeric / order_count)::bigint
              ELSE 0
            END,
            'currency', currency
          ),
          'orderCount', order_count,
          'newSubscriptionCount', new_subscription_count
        )
        FROM paid_summary
      )
    ) AS payload,
    (SELECT currency_count FROM paid_summary) AS currency_count
  ) AS summary;
  $tail$,
    v_dispatch_table,
    v_evidence_table,
    v_dispatch_failed,
    v_picked_not_shipped,
    v_dispatched_not_picked,
    v_dispatched_not_picked,
    v_dispatched_not_picked_key
  );

  EXECUTE format($fn$
CREATE OR REPLACE FUNCTION public.commerce_oms_admin_list_queue(
  p_page integer,
  p_page_size integer,
  p_search text,
  p_status text,
  p_mode text,
  p_payment_status text,
  p_fulfillment_status text,
  p_inventory_status text,
  p_accounting_status text,
  p_provider_ops_status text,
  p_attention_reason text,
  p_attention_only boolean,
  p_next_action text,
  p_from text,
  p_to text,
  p_sort text,
  p_include_withdrawn boolean
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
  SET plan_cache_mode = 'force_custom_plan'
  AS $body$
DECLARE
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_offset bigint;
  v_from timestamptz := NULL;
  v_to timestamptz := NULL;
  v_search text := NULL;
  v_search_text text := NULL;
  v_search_alnum text := NULL;
  v_search_digits text := NULL;
  v_has_search boolean := false;
  v_currency_count integer := 0;
  v_result jsonb;
BEGIN
  IF p_sort NOT IN ('created_desc', 'created_asc', 'updated_desc', 'updated_asc', 'attention_priority_desc') THEN
    RAISE EXCEPTION 'commerce_oms_queue_invalid_sort' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NOT NULL AND btrim(p_from) <> '' THEN
    v_from := p_from::timestamptz;
  END IF;
  IF p_to IS NOT NULL AND btrim(p_to) <> '' THEN
    v_to := p_to::timestamptz;
  END IF;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  v_search_text := nullif(public.commerce_oms_normalize_search_text(v_search), '');
  v_search_alnum := nullif(public.commerce_oms_normalize_search_alnum(v_search), '');
  v_search_digits := nullif(public.commerce_oms_normalize_search_digits(v_search), '');
  v_has_search := v_search IS NOT NULL;
  v_offset := (v_page::bigint - 1) * v_page_size::bigint;

  IF NOT v_has_search THEN
    SELECT summary.payload, summary.currency_count
      INTO v_result, v_currency_count
      FROM (
      WITH scoped_orders AS NOT MATERIALIZED (
        SELECT orders.id,
               orders.status,
               orders.mode,
               orders.created_at,
               orders.updated_at,
               orders.shipping_address_id,
               orders.subscription_cycle_id,
               orders.subscription_id,
               orders.total_cents,
               orders.currency
          FROM public.commerce_orders orders
         WHERE (p_status IS NULL OR orders.status = p_status)
           AND (p_mode IS NULL OR orders.mode = p_mode)
           AND (
             p_include_withdrawn
             OR NOT (
               orders.status = 'cancelled'
               AND (
                 orders.metadata ? 'supersededByStableJourneyKey'
                 OR orders.metadata ->> 'checkoutAbandoned' = 'checkout_journey_consumed'
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM public.commerce_payments pay
                  WHERE pay.order_id = orders.id
                    AND pay.status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed')
               )
             )
           )
      ),
      base_orders AS MATERIALIZED (
        SELECT orders.*,
               0 AS search_rank,
               NULL::jsonb AS search_match
          FROM scoped_orders orders
         WHERE (v_from IS NULL OR orders.created_at >= v_from)
           AND (v_to IS NULL OR orders.created_at <= v_to)
      ),
      paid_window_orders AS (
        SELECT DISTINCT payment.order_id
          FROM public.commerce_payment_intents payment
         WHERE (v_from IS NOT NULL OR v_to IS NOT NULL)
           AND payment.status IN ('succeeded', 'paid')
           AND (v_from IS NULL OR payment.updated_at >= v_from)
           AND (v_to IS NULL OR payment.updated_at <= v_to)
      ),
      %s
  ELSE
    SELECT summary.payload, summary.currency_count
      INTO v_result, v_currency_count
      FROM (
      WITH scoped_orders AS NOT MATERIALIZED (
        SELECT orders.id,
               orders.status,
               orders.mode,
               orders.created_at,
               orders.updated_at,
               orders.shipping_address_id,
               orders.subscription_cycle_id,
               orders.subscription_id,
               orders.total_cents,
               orders.currency
          FROM public.commerce_orders orders
         WHERE (p_status IS NULL OR orders.status = p_status)
           AND (p_mode IS NULL OR orders.mode = p_mode)
           AND (
             p_include_withdrawn
             OR NOT (
               orders.status = 'cancelled'
               AND (
                 orders.metadata ? 'supersededByStableJourneyKey'
                 OR orders.metadata ->> 'checkoutAbandoned' = 'checkout_journey_consumed'
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM public.commerce_payments pay
                  WHERE pay.order_id = orders.id
                    AND pay.status IN ('succeeded', 'refunded', 'partially_refunded', 'disputed')
               )
             )
           )
      ),
      search_hits AS MATERIALIZED (
        SELECT DISTINCT ON (hits.order_id)
               hits.order_id,
               hits.score AS search_rank,
               jsonb_build_object(
                 'field', hits.field,
                 'label', hits.label,
                 'valuePreview', hits.value_preview
               ) AS search_match
          FROM (
            SELECT orders.id AS order_id,
                   'order_number'::text AS field,
                   'Order number'::text AS label,
                   coalesce(orders.order_number, orders.id::text)::text AS value_preview,
                   100 AS score
              FROM public.commerce_orders orders
             WHERE v_search_alnum IS NOT NULL
               AND orders.order_number IS NOT NULL
               AND public.commerce_oms_normalize_search_alnum(orders.order_number) = v_search_alnum

            UNION ALL
            SELECT orders.id, 'order_number', 'Order number', coalesce(orders.order_number, orders.id::text), 96
              FROM public.commerce_orders orders
             WHERE v_search_digits IS NOT NULL
               AND orders.order_number IS NOT NULL
               AND public.commerce_oms_normalize_search_digits(orders.order_number) = v_search_digits

            UNION ALL
            SELECT orders.id, 'order_number', 'Order number', coalesce(orders.order_number, orders.id::text), 90
              FROM public.commerce_orders orders
             WHERE length(coalesce(v_search_alnum, '')) >= 2
               AND orders.order_number IS NOT NULL
               AND public.commerce_oms_normalize_search_alnum(orders.order_number) LIKE v_search_alnum || '%%'

            UNION ALL
            SELECT orders.id, 'order_number', 'Order number', coalesce(orders.order_number, orders.id::text), 86
              FROM public.commerce_orders orders
             WHERE length(coalesce(v_search_digits, '')) >= 2
               AND orders.order_number IS NOT NULL
               AND public.commerce_oms_normalize_search_digits(orders.order_number) LIKE '%%' || v_search_digits

            UNION ALL
            SELECT orders.id, 'order_number', 'Order number', coalesce(orders.order_number, orders.id::text), 78
              FROM public.commerce_orders orders
             WHERE length(coalesce(v_search_alnum, '')) >= 3
               AND orders.order_number IS NOT NULL
               AND public.commerce_oms_normalize_search_alnum(orders.order_number) LIKE '%%' || v_search_alnum || '%%'

            UNION ALL
            SELECT orders.id, 'order_id', 'Order ID', orders.id::text, 72
              FROM public.commerce_orders orders
             WHERE length(coalesce(v_search_alnum, '')) >= 8
               AND replace(orders.id::text, '-', '') LIKE v_search_alnum || '%%'

            UNION ALL
            (SELECT DISTINCT ON (refs.order_id)
                   refs.order_id, 'tracking', 'Tracking', refs.provider_tracking_id, 88
              FROM public.shipment_external_refs refs
             WHERE length(coalesce(v_search_alnum, '')) >= 3
               AND refs.provider_tracking_id IS NOT NULL
               AND public.commerce_oms_normalize_search_alnum(refs.provider_tracking_id) LIKE '%%' || v_search_alnum || '%%'
             ORDER BY refs.order_id, refs.active DESC, refs.updated_at DESC NULLS LAST, refs.created_at DESC NULLS LAST)

            UNION ALL
            (SELECT DISTINCT ON (refs.order_id)
                   refs.order_id, 'provider_order', 'Provider order', refs.provider_order_id, 87
              FROM public.%I refs
             WHERE length(coalesce(v_search_alnum, '')) >= 3
               AND refs.provider_order_id IS NOT NULL
               AND public.commerce_oms_normalize_search_alnum(refs.provider_order_id) LIKE '%%' || v_search_alnum || '%%'
             ORDER BY refs.order_id, refs.updated_at DESC NULLS LAST, refs.created_at DESC NULLS LAST)

            UNION ALL
            (SELECT DISTINCT ON (invoice.order_id)
                   invoice.order_id, 'invoice', 'Invoice', coalesce(invoice.invoice_ref, invoice.provider_invoice_number), 86
              FROM public.accounting_invoices invoice
             WHERE length(coalesce(v_search_alnum, '')) >= 3
               AND (
                 public.commerce_oms_normalize_search_alnum(invoice.invoice_ref) LIKE '%%' || v_search_alnum || '%%'
                 OR public.commerce_oms_normalize_search_alnum(invoice.provider_invoice_number) LIKE '%%' || v_search_alnum || '%%'
               )
             ORDER BY invoice.order_id, invoice.updated_at DESC, invoice.id DESC)

            UNION ALL
            (SELECT DISTINCT ON (intent.order_id)
                   intent.order_id, 'payment', 'Payment', coalesce(intent.provider_payment_id, intent.payment_id::text), 84
              FROM public.commerce_payment_intents intent
             WHERE length(coalesce(v_search_alnum, '')) >= 3
               AND (
                 public.commerce_oms_normalize_search_alnum(intent.provider_payment_id) LIKE '%%' || v_search_alnum || '%%'
                 OR replace(intent.payment_id::text, '-', '') LIKE '%%' || v_search_alnum || '%%'
               )
             ORDER BY intent.order_id, intent.updated_at DESC, intent.id DESC)

            UNION ALL
            SELECT orders.id, 'email', 'Email', public.commerce_oms_mask_email(clients.email), 74
              FROM public.clients clients
              JOIN public.commerce_orders orders ON orders.client_id = clients.id
             WHERE length(coalesce(v_search_text, '')) >= 3
               AND public.commerce_oms_normalize_search_text(clients.email) LIKE '%%' || v_search_text || '%%'

            UNION ALL
            SELECT orders.id, 'phone', 'Phone', public.commerce_oms_mask_phone(coalesce(clients.phone, shipping_addresses.contact_phone)), 72
              FROM public.commerce_orders orders
              LEFT JOIN public.clients clients ON clients.id = orders.client_id
              LEFT JOIN public.addresses shipping_addresses ON shipping_addresses.id = orders.shipping_address_id
             WHERE length(coalesce(v_search_digits, '')) >= 3
               AND (
                 public.commerce_oms_normalize_search_digits(clients.phone) LIKE '%%' || v_search_digits || '%%'
                 OR public.commerce_oms_normalize_search_digits(shipping_addresses.contact_phone) LIKE '%%' || v_search_digits || '%%'
               )

            UNION ALL
            SELECT orders.id, 'customer', 'Customer', concat_ws(' ', clients.first_name, clients.last_name), 64
              FROM public.clients clients
              JOIN public.commerce_orders orders ON orders.client_id = clients.id
             WHERE length(coalesce(v_search_text, '')) >= 2
               AND public.commerce_oms_normalize_search_text(concat_ws(' ', clients.first_name, clients.last_name)) LIKE '%%' || v_search_text || '%%'

            UNION ALL
            SELECT orders.id, 'pet', 'Pet', pets.name, 58
              FROM public.pets pets
              JOIN public.commerce_orders orders ON orders.pet_id = pets.id
             WHERE length(coalesce(v_search_text, '')) >= 2
               AND public.commerce_oms_normalize_search_text(concat_ws(' ', pets.name, pets.breed, pets.pet_type)) LIKE '%%' || v_search_text || '%%'

            UNION ALL
            SELECT orders.id, 'postal_code', 'Postal code', shipping_addresses.postal_code, 54
              FROM public.addresses shipping_addresses
              JOIN public.commerce_orders orders ON orders.shipping_address_id = shipping_addresses.id
             WHERE length(coalesce(v_search_digits, '')) >= 2
               AND public.commerce_oms_normalize_search_digits(shipping_addresses.postal_code) LIKE '%%' || v_search_digits || '%%'

            UNION ALL
            SELECT orders.id, 'address', 'Address', concat_ws(', ', shipping_addresses.city, shipping_addresses.line1), 50
              FROM public.addresses shipping_addresses
              JOIN public.commerce_orders orders ON orders.shipping_address_id = shipping_addresses.id
             WHERE length(coalesce(v_search_text, '')) >= 2
               AND public.commerce_oms_normalize_search_text(concat_ws(' ', shipping_addresses.city, shipping_addresses.line1, shipping_addresses.line2, shipping_addresses.recipient_name, shipping_addresses.company_name)) LIKE '%%' || v_search_text || '%%'

            UNION ALL
            (SELECT DISTINCT ON (item.order_id)
                   item.order_id,
                   'sku',
                   'SKU',
                   coalesce(sku.sku, item.product_snapshot->>'sku', item.variant_snapshot->>'sku', item.product_snapshot->>'title', item.product_snapshot->>'name', sku.title, item.sku_id::text),
                   46
              FROM public.commerce_order_items item
              LEFT JOIN public.catalog_skus sku ON sku.id = item.sku_id
             WHERE (
                 length(coalesce(v_search_alnum, '')) >= 2
                 OR length(coalesce(v_search_text, '')) >= 2
               )
               AND (
                 public.commerce_oms_normalize_search_alnum(coalesce(sku.sku, item.product_snapshot->>'sku', item.variant_snapshot->>'sku', item.sku_id::text)) LIKE '%%' || v_search_alnum || '%%'
                 OR public.commerce_oms_normalize_search_text(coalesce(item.product_snapshot->>'title', item.product_snapshot->>'name', item.variant_snapshot->>'title', sku.title)) LIKE '%%' || v_search_text || '%%'
               )
             ORDER BY item.order_id, item.created_at ASC, item.id ASC)
          ) hits
         ORDER BY hits.order_id, hits.score DESC, hits.field ASC
      ),
      base_orders AS MATERIALIZED (
        SELECT orders.*,
               hits.search_rank,
               hits.search_match
          FROM search_hits hits
          JOIN scoped_orders orders ON orders.id = hits.order_id
         WHERE (v_from IS NULL OR orders.created_at >= v_from)
           AND (v_to IS NULL OR orders.created_at <= v_to)
      ),
      paid_window_orders AS (
        SELECT DISTINCT payment.order_id
          FROM search_hits hits
          JOIN public.commerce_payment_intents payment ON payment.order_id = hits.order_id
         WHERE (v_from IS NOT NULL OR v_to IS NOT NULL)
           AND payment.status IN ('succeeded', 'paid')
           AND (v_from IS NULL OR payment.updated_at >= v_from)
           AND (v_to IS NULL OR payment.updated_at <= v_to)
      ),
      %s
  END IF;

  IF v_currency_count > 1 THEN
    RAISE EXCEPTION 'commerce_oms_summary_mixed_currency' USING ERRCODE = '22023';
  END IF;

  RETURN v_result;
END;
$body$;
  $fn$,
    v_common_tail,
    v_dispatch_table,
    v_common_tail
  );
END;
$$;
