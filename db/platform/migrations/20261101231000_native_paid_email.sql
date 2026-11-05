-- Native paid-mail projection. The existing paid event remains unchanged.
-- Mail capture is bounded and best effort inside settlement: contention or a
-- mail-only insertion failure cannot undo paid truth. The retained paid event
-- and order remain available for operator repair if mail capture fails.
CREATE OR REPLACE FUNCTION public.commerce_order_emit_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_lock_timeout text := current_setting('lock_timeout');
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.paid', 'order_paid:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.paid_at),
          jsonb_build_object('source', 'commerce_order_emit_paid_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;

  BEGIN
    PERFORM set_config('lock_timeout', '100ms', true);
    INSERT INTO public.outbox_events
      (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
    VALUES ('commerce_order', NEW.id, 'commerce.order.paid.email', 'order_paid_email:' || NEW.id::text,
            jsonb_build_object('orderUuid', NEW.id, 'orderId', 'order_' || NEW.id::text,
              'mode', CASE WHEN NEW.subscription_cycle_id IS NOT NULL THEN 'subscription_cycle'
                ELSE COALESCE(NEW.metadata #>> '{orderDraftSnapshot,context,mode}', 'one_time') END,
              'occurredAt', NEW.paid_at),
            jsonb_build_object('source', 'commerce_order_emit_paid_notification'))
    ON CONFLICT (event_type, idempotency_key) DO NOTHING;
    PERFORM set_config('lock_timeout', v_lock_timeout, true);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    PERFORM set_config('lock_timeout', v_lock_timeout, true);
  END;
  RETURN NULL;
END;
$$;


-- Native configured delivery and acquisition capacity. Existing checks stay intact.
CREATE OR REPLACE FUNCTION public.commerce_create_promoted_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_receipt public.commerce_order_draft_receipts%ROWTYPE;
  v_response jsonb;
  v_order_id uuid;
  v_discount jsonb;
  v_definition public.commerce_promotion_definitions%ROWTYPE;
  v_adjustment public.commerce_order_adjustments%ROWTYPE;
  v_claim public.commerce_promotion_claims%ROWTYPE;
  v_global bigint;
  v_customer bigint;
  v_global_limit integer;
  v_customer_limit integer;
  v_lines bigint;
  v_order_discount bigint;
  v_shipping bigint;
  v_shipping_discount bigint;
  v_total bigint;
  v_shipping_terms jsonb;
  v_allocation_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_receipt FROM public.commerce_order_draft_receipts
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND AND v_receipt.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION 'commerce_order_draft_expired' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(sum((line.value#>>'{lineSubtotalGross,amountMinor}')::bigint), 0)
    INTO v_lines
    FROM jsonb_array_elements(p_order_draft_snapshot->'lines') AS line(value);
  SELECT
    COALESCE(sum((discount.value->>'amountOffMinor')::bigint)
      FILTER (WHERE discount.value->>'appliesTo' <> 'shipping'), 0),
    COALESCE(sum((discount.value->>'amountOffMinor')::bigint)
      FILTER (WHERE discount.value->>'appliesTo' = 'shipping'), 0)
    INTO v_order_discount, v_shipping_discount
    FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
      AS discount(value);
  v_shipping := COALESCE((p_order_draft_snapshot#>>'{totals,shippingGross,amountMinor}')::bigint, 0);
  IF v_shipping_discount IS DISTINCT FROM
      COALESCE((p_order_draft_snapshot#>>'{totals,shippingDiscountGross,amountMinor}')::bigint, 0)
    OR v_order_discount IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,discountTotalGross,amountMinor}')::bigint
    OR v_lines IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,subtotalGross,amountMinor}')::bigint THEN
    RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
      AS discount(value)
    WHERE discount.value->>'appliesTo' = 'line'
  ) THEN
    RAISE EXCEPTION 'commerce_promotion_line_allocation_unsupported' USING ERRCODE = '22023';
  END IF;
  v_shipping_terms := p_order_draft_snapshot#>'{context,shippingTerms}';
  IF v_shipping_terms IS NOT NULL THEN
    IF jsonb_typeof(v_shipping_terms) IS DISTINCT FROM 'object'
      OR v_shipping_terms - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb
      OR v_shipping_terms->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
      OR v_shipping_terms->>'currency' IS DISTINCT FROM p_order_draft_snapshot->>'currency'
      OR COALESCE(v_shipping_terms->>'flatMinor','') !~ '^[0-9]{1,10}$'
      OR COALESCE(v_shipping_terms->>'freeThresholdMinor','') !~ '^[0-9]{1,10}$' THEN
      RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
    END IF;
    IF (v_shipping_terms->>'flatMinor')::bigint > 2147483647
      OR (v_shipping_terms->>'freeThresholdMinor')::bigint > 2147483647
      OR v_shipping IS DISTINCT FROM (CASE
        WHEN v_lines - v_order_discount >= (v_shipping_terms->>'freeThresholdMinor')::bigint THEN 0
        ELSE (v_shipping_terms->>'flatMinor')::bigint END) THEN
      RAISE EXCEPTION 'commerce_order_draft_money_components_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_total := v_lines + v_shipping - v_order_discount - v_shipping_discount;
  IF v_total IS DISTINCT FROM
      (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint THEN
    RAISE EXCEPTION 'commerce_order_draft_money_equation_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'commerce_zero_payable_order_unsupported' USING ERRCODE = '22023';
  END IF;

  v_response := public.commerce_create_order_draft_with_outbox(
    p_idempotency_key, p_quote_snapshot, p_order_draft_snapshot, p_client_id
  );
  IF (v_response#>>'{orderDraft,replayed}')::boolean THEN RETURN v_response; END IF;
  v_order_id := replace(v_response#>>'{orderDraft,orderId}', 'order_', '')::uuid;
  v_allocation_fingerprint := encode(sha256(convert_to(
    p_order_draft_snapshot::text || '|effective-line-allocation.v1', 'UTF8'
  )), 'hex');

  IF v_order_discount > 0 THEN
    DELETE FROM public.commerce_order_items WHERE order_id = v_order_id;
    WITH source_lines AS (
      SELECT
        line.ordinality::integer AS source_ordinal,
        line.value->>'sku' AS sku,
        (line.value->>'quantity')::integer AS quantity,
        (line.value#>>'{unitPriceGross,amountMinor}')::bigint AS catalog_unit,
        (line.value#>>'{lineSubtotalGross,amountMinor}')::bigint AS catalog_line
      FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
        WITH ORDINALITY AS line(value, ordinality)
    ), bases AS (
      SELECT source.*,
        floor((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines)::bigint AS effective_base,
        ((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines)
          - floor((v_lines - v_order_discount)::numeric * source.catalog_line / v_lines) AS fraction
      FROM source_lines AS source
    ), remainder AS (
      SELECT v_lines - v_order_discount - sum(effective_base) AS cents FROM bases
    ), allocated_lines AS (
      SELECT base.*,
        base.effective_base + CASE WHEN row_number() OVER (
          ORDER BY base.fraction DESC, base.source_ordinal
        ) <= remainder.cents THEN 1 ELSE 0 END AS effective_line
      FROM bases AS base CROSS JOIN remainder
    ), split_lines AS (
      SELECT allocated.*,
        allocated.quantity - (allocated.effective_line % allocated.quantity)::integer AS split_quantity,
        allocated.effective_line / allocated.quantity AS effective_unit
      FROM allocated_lines AS allocated
      UNION ALL
      SELECT allocated.*,
        (allocated.effective_line % allocated.quantity)::integer,
        allocated.effective_line / allocated.quantity + 1
      FROM allocated_lines AS allocated
      WHERE allocated.effective_line % allocated.quantity > 0
    ), prepared AS (
      SELECT split.*, sku_row.id AS sku_id,
        row_number() OVER (
          ORDER BY split.source_ordinal, split.effective_unit, split.split_quantity
        )::integer AS final_ordinal
      FROM split_lines AS split
      JOIN public.catalog_skus AS sku_row ON sku_row.sku = split.sku
      WHERE split.split_quantity > 0
    )
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor,
      source_line_ordinal, catalog_unit_amount_minor, catalog_line_amount_minor,
      promotion_discount_allocated_minor, promotion_allocation_fingerprint
    )
    SELECT
      v_order_id, prepared.sku_id, prepared.final_ordinal,
      prepared.split_quantity, prepared.effective_unit,
      prepared.effective_unit * prepared.split_quantity,
      prepared.source_ordinal, prepared.catalog_unit,
      prepared.catalog_unit * prepared.split_quantity,
      (prepared.catalog_unit - prepared.effective_unit) * prepared.split_quantity,
      v_allocation_fingerprint
    FROM prepared ORDER BY prepared.final_ordinal;
  END IF;

  IF v_shipping > 0 THEN
    INSERT INTO public.commerce_order_adjustments (
      order_id, kind, scope, amount_minor
    ) VALUES (v_order_id, 'shipping_charge', 'shipping', v_shipping);
  END IF;

  FOR v_discount IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_order_draft_snapshot->'discounts', '[]'::jsonb))
    WHERE value ? 'promotionId' AND COALESCE((value->>'amountOffMinor')::bigint, 0) > 0
    ORDER BY value->>'promotionId'
  LOOP
    SELECT * INTO v_definition
    FROM public.commerce_promotion_lock_definition(v_discount->>'promotionId');
    IF v_definition.promotion_id IS NULL OR NOT v_definition.active OR v_definition.definition->>'status' <> 'active' THEN
      RAISE EXCEPTION 'commerce_promotion_definition_not_active' USING ERRCODE = '40001';
    END IF;
    v_global_limit := NULLIF(v_definition.definition->>'redemption_limit_global', '')::integer;
    v_customer_limit := NULLIF(v_definition.definition->>'redemption_limit_per_customer', '')::integer;
    SELECT count(*) FILTER (WHERE status IN ('reserved', 'redeemed')),
      count(*) FILTER (WHERE status IN ('reserved', 'redeemed') AND client_id = p_client_id)
    INTO v_global, v_customer FROM public.commerce_promotion_claims
    WHERE promotion_id = v_definition.promotion_id;
    IF v_global_limit IS NOT NULL AND v_global >= v_global_limit THEN
      RAISE EXCEPTION 'commerce_promotion_global_limit_reached' USING ERRCODE = '40001';
    END IF;
    IF v_customer_limit IS NOT NULL AND p_client_id IS NULL THEN
      RAISE EXCEPTION 'commerce_promotion_client_required' USING ERRCODE = '22023';
    END IF;
    IF v_customer_limit IS NOT NULL AND v_customer >= v_customer_limit THEN
      RAISE EXCEPTION 'commerce_promotion_customer_limit_reached' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.commerce_order_adjustments (
      order_id, kind, scope, amount_minor, promotion_id, definition_fingerprint
    ) VALUES (
      v_order_id, 'promotion_discount', v_discount->>'appliesTo',
      (v_discount->>'amountOffMinor')::bigint,
      v_definition.promotion_id, v_definition.definition_fingerprint
    ) RETURNING * INTO v_adjustment;
    INSERT INTO public.commerce_promotion_claims (
      promotion_id, definition_fingerprint, adjustment_id,
      order_id, client_id, amount_off_minor, expires_at
    ) VALUES (
      v_definition.promotion_id, v_definition.definition_fingerprint, v_adjustment.id,
      v_order_id, p_client_id, v_adjustment.amount_minor, now() + interval '24 hours'
    ) RETURNING * INTO v_claim;
    INSERT INTO public.commerce_promotion_claim_events (claim_id, event_key, transition)
    VALUES (v_claim.id, 'reserved:' || v_order_id::text, 'reserved');
  END LOOP;
  RETURN v_response;
END;
$$;

-- Narrow acquisition capacity lock; callers retain no definition UPDATE privilege.
CREATE OR REPLACE FUNCTION public.commerce_order_assert_line_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order_id uuid;
  v_declared bigint;
  v_sum bigint;
BEGIN
  -- Branching statements rather than one CASE expression on purpose: the procedural language
  -- compiles an expression into a single query, so every record field named in any arm must exist
  -- on every row type the trigger can see, and the two row types here differ.
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    v_order_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  SELECT total_amount_minor INTO v_declared
    FROM public.commerce_orders
   WHERE id = v_order_id;
  -- The order is gone: a cascade took it, and there is nothing left to be consistent with.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(line_amount_minor), 0) INTO v_sum
    FROM public.commerce_order_items
   WHERE order_id = v_order_id;

  SELECT v_sum + COALESCE(sum(CASE
    WHEN kind = 'shipping_charge' THEN amount_minor
    WHEN kind = 'promotion_discount' AND scope = 'shipping' THEN -amount_minor
    ELSE 0 END), 0) INTO v_sum
    FROM public.commerce_order_adjustments
   WHERE order_id = v_order_id;

  IF v_sum IS DISTINCT FROM COALESCE(v_declared, 0) THEN
    RAISE EXCEPTION 'commerce_order_line_sum_mismatch' USING ERRCODE = '23514',
      DETAIL = format('order %s declares %s and its lines sum to %s',
                      v_order_id, COALESCE(v_declared::text, 'nothing'), v_sum);
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION public.commerce_promotion_lock_definition(p_promotion_id text)
RETURNS public.commerce_promotion_definitions
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT definition_row.* FROM public.commerce_promotion_definitions AS definition_row
  WHERE definition_row.promotion_id = $1 FOR UPDATE;
$$;

REVOKE ALL ON FUNCTION public.commerce_promotion_lock_definition(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_promotion_lock_definition(text) FROM anon';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_promotion_lock_definition(text) FROM authenticated';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_dunning_claim_batch(integer,integer,integer), public.subscription_dunning_mark_sent(uuid,uuid,text), public.subscription_dunning_mark_result(uuid,uuid,text,text,timestamptz), public.dunning_lifecycle_recipient(uuid), public.communications_notification_control_enabled(text[]), public.communications_recipient_consent_state(text,text[]), public.dunning_lifecycle_renewal_reminder_enqueue(integer), public.dunning_lifecycle_pause_reminder_dispatch(integer), public.commerce_promotion_lock_definition(text) TO service_role';
  END IF;
END;
$$;

-- A policy refusal completes the original source without claiming delivery.
CREATE TABLE public.subscription_notice_refusals (
  source text NOT NULL CHECK (source IN ('event', 'reminder')),
  source_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason = 'notice_policy_refused'),
  refused_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
ALTER TABLE public.subscription_notice_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_notice_refusals FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.subscription_notice_refusals FROM anon';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.subscription_notice_refusals FROM authenticated';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.subscription_notice_refusals FROM service_role';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT ON public.subscription_notice_refusals TO service_role;';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'CREATE POLICY subscription_notice_refusals_runtime ON public.subscription_notice_refusals FOR ALL TO service_role USING (true) WITH CHECK (true);';
  END IF;
END;
$$;
