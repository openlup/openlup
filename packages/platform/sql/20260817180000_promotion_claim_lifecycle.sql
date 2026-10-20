-- Public promotion definition and claim lifecycle.
--
-- CHANGE. This forward adds a neutral, content-addressed promotion definition
-- catalogue, a durable reserved/redeemed/released claim ledger, append-only
-- claim events, read routines for the existing pure quote evaluator, an
-- idempotent promoted-order wrapper with deterministic effective-line
-- allocation, order transition hooks and one bounded stale-draft sweep.
--
-- WHY. The public bundle already owns catalogue pricing, idempotent order drafts,
-- settlement truth and the pure promotion evaluator. It could not persist the
-- evaluator's neutral inputs or reserve the selected benefit, so its mounted
-- quote silently omitted promotions and its scheduled sweep was managed-only.
--
-- SAFETY. This is additive and copies no private promotion/code schema. A
-- definition is an opaque reviewed JSON contract, not editable presentation or
-- provider data. Product discounts are allocated only to the fresh item rows
-- created inside the same uncommitted draft transaction; legacy, renewal,
-- payment-truth and accounting functions are untouched. Positive net shipping,
-- line-targeted and zero-payable drafts fail before any write. Reservation
-- happens in that same transaction.
-- Every lifecycle mutation locks order before claim, matching settlement's lock
-- order. Sweep refuses any settlement intent or active renewal inventory before
-- terminally marking a stale draft. It preserves the order, receipt, claim and
-- outbox rows as audit evidence and fences later replay; no durable row is deleted.
-- Routines are invoker-rights, role-free and revoked from PUBLIC.
--
-- ROLLBACK. Disable the direct promotion adopter and scheduler, then drop the
-- capability triggers, routines and four capability-local tables. The receipt
-- audit columns and nullable item allocation evidence can remain. Existing orders, quote/catalog rows,
-- settlement intents and outbox facts remain valid.

CREATE TABLE public.commerce_promotion_definitions (
  promotion_id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1,
  definition jsonb NOT NULL,
  definition_fingerprint text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_promotion_definitions_id_check
    CHECK (promotion_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT commerce_promotion_definitions_revision_check CHECK (revision > 0),
  CONSTRAINT commerce_promotion_definitions_payload_check CHECK (
    jsonb_typeof(definition) = 'object'
    AND definition->>'id' = promotion_id
    AND definition->>'status' IN ('draft', 'active', 'paused', 'archived')
    AND definition->>'trigger_type' IN ('coupon_code', 'automatic', 'referral')
    AND definition->>'discount_type' IN ('percentage', 'fixed_amount', 'free_shipping')
    AND definition->>'applies_to_kind' IN ('order_total', 'line_with_variant', 'line_with_category')
    AND definition->>'stacking_rule' IN ('exclusive', 'stackable_with_any', 'stackable_with_loyalty')
    AND jsonb_typeof(definition->'eligibility') = 'object'
    AND jsonb_typeof(definition->'applies_to_payload') = 'object'
    AND jsonb_typeof(definition->'region_availability') = 'array'
  )
);

COMMENT ON TABLE public.commerce_promotion_definitions IS
  'Provider-neutral inputs to the shared pure evaluator. Presentation, provider attempts and private promotion-code bindings are deliberately absent.';

CREATE FUNCTION public.commerce_promotion_definition_fingerprint()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.definition_fingerprint := encode(
    sha256(convert_to(NEW.definition::text, 'UTF8')), 'hex'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_promotion_definition_fingerprint_trigger
BEFORE INSERT OR UPDATE OF definition ON public.commerce_promotion_definitions
FOR EACH ROW EXECUTE FUNCTION public.commerce_promotion_definition_fingerprint();

CREATE TABLE public.commerce_order_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  scope text NOT NULL,
  amount_minor bigint NOT NULL,
  promotion_id text REFERENCES public.commerce_promotion_definitions(promotion_id) ON DELETE RESTRICT,
  definition_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_adjustments_kind_check
    CHECK (kind IN ('shipping_charge', 'promotion_discount')),
  CONSTRAINT commerce_order_adjustments_scope_check
    CHECK (scope IN ('order_total', 'line', 'shipping')),
  CONSTRAINT commerce_order_adjustments_amount_check CHECK (amount_minor > 0),
  CONSTRAINT commerce_order_adjustments_semantics_check CHECK (
    (kind = 'shipping_charge' AND scope = 'shipping'
      AND promotion_id IS NULL AND definition_fingerprint IS NULL)
    OR
    (kind = 'promotion_discount' AND promotion_id IS NOT NULL
      AND definition_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT commerce_order_adjustments_promotion_key UNIQUE (order_id, promotion_id)
);

CREATE UNIQUE INDEX commerce_order_adjustments_shipping_charge_key
  ON public.commerce_order_adjustments (order_id)
  WHERE kind = 'shipping_charge';

COMMENT ON TABLE public.commerce_order_adjustments IS
  'Immutable neutral money facts. Catalogue lines stay gross; charges add and promotion discounts subtract from the charged order total.';

ALTER TABLE public.commerce_order_items
  ADD COLUMN source_line_ordinal integer,
  ADD COLUMN catalog_unit_amount_minor bigint,
  ADD COLUMN catalog_line_amount_minor bigint,
  ADD COLUMN promotion_discount_allocated_minor bigint,
  ADD COLUMN promotion_allocation_fingerprint text,
  ADD CONSTRAINT commerce_order_items_promoted_allocation_check CHECK (
    (source_line_ordinal IS NULL
      AND catalog_unit_amount_minor IS NULL
      AND catalog_line_amount_minor IS NULL
      AND promotion_discount_allocated_minor IS NULL
      AND promotion_allocation_fingerprint IS NULL)
    OR
    (source_line_ordinal > 0
      AND catalog_unit_amount_minor >= 0
      AND catalog_line_amount_minor = catalog_unit_amount_minor * quantity
      AND promotion_discount_allocated_minor >= 0
      AND promotion_discount_allocated_minor <= catalog_line_amount_minor
      AND line_amount_minor + promotion_discount_allocated_minor = catalog_line_amount_minor
      AND promotion_allocation_fingerprint ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

COMMENT ON COLUMN public.commerce_order_items.catalog_line_amount_minor IS
  'Catalogue subtotal retained only for promoted effective lines. Legacy and renewal rows remain structurally unchanged with all allocation columns NULL.';

CREATE TABLE public.commerce_promotion_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id text NOT NULL REFERENCES public.commerce_promotion_definitions(promotion_id) ON DELETE RESTRICT,
  definition_fingerprint text NOT NULL,
  adjustment_id uuid NOT NULL UNIQUE REFERENCES public.commerce_order_adjustments(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'reserved',
  amount_off_minor bigint NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_promotion_claims_definition_order_key UNIQUE (promotion_id, order_id),
  CONSTRAINT commerce_promotion_claims_fingerprint_check
    CHECK (definition_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_promotion_claims_status_check
    CHECK (status IN ('reserved', 'redeemed', 'released')),
  CONSTRAINT commerce_promotion_claims_amount_check CHECK (amount_off_minor > 0),
  CONSTRAINT commerce_promotion_claims_expiry_check CHECK (expires_at > reserved_at),
  CONSTRAINT commerce_promotion_claims_terminal_check CHECK (
    (status = 'reserved' AND redeemed_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'redeemed' AND redeemed_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'released' AND redeemed_at IS NULL AND released_at IS NOT NULL AND btrim(release_reason) <> '')
  )
);

CREATE INDEX commerce_promotion_claims_sweep
  ON public.commerce_promotion_claims (expires_at, id)
  WHERE status = 'reserved';

CREATE TABLE public.commerce_promotion_claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.commerce_promotion_claims(id) ON DELETE RESTRICT,
  event_key text NOT NULL,
  transition text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_promotion_claim_events_key UNIQUE (claim_id, event_key),
  CONSTRAINT commerce_promotion_claim_events_transition_check
    CHECK (transition IN ('reserved', 'redeemed', 'released')),
  CONSTRAINT commerce_promotion_claim_events_key_check CHECK (btrim(event_key) <> '')
);

ALTER TABLE public.commerce_order_draft_receipts
  ADD COLUMN invalidated_at timestamptz,
  ADD COLUMN invalidation_reason text;
ALTER TABLE public.commerce_order_draft_receipts
  ADD CONSTRAINT commerce_order_draft_receipts_invalidation_check CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND btrim(invalidation_reason) <> '')
  ) NOT VALID;

CREATE FUNCTION public.commerce_order_adjustments_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'commerce_order_adjustments_append_only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER commerce_order_adjustments_append_only_trigger
BEFORE UPDATE OR DELETE ON public.commerce_order_adjustments
FOR EACH ROW EXECUTE FUNCTION public.commerce_order_adjustments_append_only();

CREATE FUNCTION public.commerce_promotion_claim_money_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.commerce_promotion_claims AS claim
    WHERE claim.order_id = OLD.order_id
  ) THEN
    RAISE EXCEPTION 'commerce_promotion_claim_money_frozen' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_promotion_claim_money_freeze_trigger
BEFORE UPDATE OR DELETE ON public.commerce_order_items
FOR EACH ROW EXECUTE FUNCTION public.commerce_promotion_claim_money_freeze();

CREATE FUNCTION public.commerce_promotion_active_definitions()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(definition_row.definition ORDER BY definition_row.promotion_id), '[]'::jsonb)
  FROM public.commerce_promotion_definitions AS definition_row
  WHERE definition_row.active AND definition_row.definition->>'status' = 'active';
$$;

CREATE FUNCTION public.commerce_promotion_paid_order_counts(p_client_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'oneTime', count(*) FILTER (WHERE order_row.subscription_cycle_id IS NULL),
    'subscription', count(*) FILTER (WHERE order_row.subscription_cycle_id IS NOT NULL)
  )
  FROM public.commerce_orders AS order_row
  WHERE order_row.client_id = p_client_id
    AND order_row.status IN ('paid', 'fulfillment_pending', 'fulfilled');
$$;

CREATE FUNCTION public.commerce_promotion_redemption_counts(p_client_id uuid DEFAULT NULL)
RETURNS TABLE (promotion_id text, global_count bigint, per_customer_count bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT claim.promotion_id,
    count(*) FILTER (WHERE claim.status = 'redeemed') AS global_count,
    count(*) FILTER (WHERE claim.status = 'redeemed' AND p_client_id IS NOT NULL
      AND claim.client_id = p_client_id) AS per_customer_count
  FROM public.commerce_promotion_claims AS claim GROUP BY claim.promotion_id;
$$;

CREATE FUNCTION public.commerce_promotion_device_first_order_redeemed(p_visitor_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  -- The public order-draft response stores no visitor identity, so the direct
  -- adapter refuses to manufacture device evidence. Account counts remain real.
  SELECT false;
$$;

CREATE FUNCTION public.commerce_create_promoted_order_draft_with_outbox(
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
  IF v_shipping IS DISTINCT FROM v_shipping_discount THEN
    RAISE EXCEPTION 'commerce_promoted_net_shipping_unsupported' USING ERRCODE = '22023';
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
        floor(v_total::numeric * source.catalog_line / v_lines)::bigint AS effective_base,
        (v_total::numeric * source.catalog_line / v_lines)
          - floor(v_total::numeric * source.catalog_line / v_lines) AS fraction
      FROM source_lines AS source
    ), remainder AS (
      SELECT v_total - sum(effective_base) AS cents FROM bases
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
    SELECT * INTO v_definition FROM public.commerce_promotion_definitions AS definition_row
    WHERE definition_row.promotion_id = v_discount->>'promotionId' FOR UPDATE;
    IF NOT FOUND OR NOT v_definition.active OR v_definition.definition->>'status' <> 'active' THEN
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

CREATE FUNCTION public.commerce_transition_order_promotion_claims()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_claim public.commerce_promotion_claims%ROWTYPE;
  v_transition text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status IN ('paid', 'fulfillment_pending', 'fulfilled') THEN v_transition := 'redeemed';
  ELSIF NEW.status IN ('cancelled', 'refunded') THEN v_transition := 'released';
  ELSE RETURN NEW;
  END IF;
  FOR v_claim IN SELECT * FROM public.commerce_promotion_claims
    WHERE order_id = NEW.id ORDER BY promotion_id FOR UPDATE
  LOOP
    IF v_transition = 'redeemed' AND v_claim.status <> 'redeemed' THEN
      UPDATE public.commerce_promotion_claims
      SET status = 'redeemed', redeemed_at = COALESCE(NEW.paid_at, now()),
        released_at = NULL, release_reason = NULL, updated_at = now() WHERE id = v_claim.id;
    ELSIF v_transition = 'released' AND v_claim.status = 'reserved' THEN
      UPDATE public.commerce_promotion_claims
      SET status = 'released', redeemed_at = NULL, released_at = now(),
        release_reason = 'order_' || NEW.status, updated_at = now() WHERE id = v_claim.id;
    ELSE CONTINUE;
    END IF;
    INSERT INTO public.commerce_promotion_claim_events (claim_id, event_key, transition, reason)
    VALUES (v_claim.id, v_transition || ':' || NEW.status, v_transition,
      CASE WHEN v_transition = 'released' THEN 'order_' || NEW.status ELSE NULL END)
    ON CONFLICT (claim_id, event_key) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_transition_order_promotion_claims_trigger
AFTER UPDATE OF status ON public.commerce_orders
FOR EACH ROW EXECUTE FUNCTION public.commerce_transition_order_promotion_claims();

CREATE FUNCTION public.commerce_order_money_summary(p_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'subtotalMinor', COALESCE((SELECT sum(item.line_amount_minor)
      FROM public.commerce_order_items AS item WHERE item.order_id = p_order_id), 0),
    'discountMinor', COALESCE((SELECT sum(adjustment.amount_minor)
      FROM public.commerce_order_adjustments AS adjustment
      WHERE adjustment.order_id = p_order_id AND adjustment.kind = 'promotion_discount'
        AND adjustment.scope <> 'shipping'), 0),
    'shippingMinor', COALESCE((SELECT sum(adjustment.amount_minor)
      FROM public.commerce_order_adjustments AS adjustment
      WHERE adjustment.order_id = p_order_id AND adjustment.kind = 'shipping_charge'), 0),
    'shippingDiscountMinor', COALESCE((SELECT sum(adjustment.amount_minor)
      FROM public.commerce_order_adjustments AS adjustment
      WHERE adjustment.order_id = p_order_id AND adjustment.kind = 'promotion_discount'
        AND adjustment.scope = 'shipping'), 0)
  );
$$;

CREATE FUNCTION public.commerce_sweep_stale_promotion_claims(
  p_now timestamptz DEFAULT now(), p_limit integer DEFAULT 50,
  p_claim_lease_minutes integer DEFAULT 15, p_grace_minutes integer DEFAULT 5
)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_order public.commerce_orders%ROWTYPE;
  v_checked integer := 0;
  v_cancelled integer := 0;
  v_skipped integer := 0;
BEGIN
  IF p_now IS NULL OR p_limit < 1 OR p_limit > 200
    OR p_claim_lease_minutes < 1 OR p_grace_minutes < 0 THEN
    RAISE EXCEPTION 'promotion_claim_sweep_invalid_input' USING ERRCODE = '22023';
  END IF;
  FOR v_order IN
    SELECT order_row.* FROM public.commerce_orders AS order_row
    WHERE order_row.status = 'pending_payment'
      AND order_row.created_at <= p_now - make_interval(mins => p_claim_lease_minutes)
      AND EXISTS (SELECT 1 FROM public.commerce_promotion_claims AS claim
        WHERE claim.order_id = order_row.id AND claim.status = 'reserved'
          AND claim.expires_at <= p_now - make_interval(mins => p_grace_minutes))
    ORDER BY order_row.created_at, order_row.id LIMIT p_limit
    FOR UPDATE OF order_row SKIP LOCKED
  LOOP
    v_checked := v_checked + 1;
    PERFORM 1 FROM public.commerce_promotion_claims WHERE order_id = v_order.id
      AND status = 'reserved' ORDER BY promotion_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.commerce_settlement_intents WHERE order_id = v_order.id)
      OR EXISTS (SELECT 1 FROM public.subscription_cycles AS cycle
        JOIN public.fulfillment_inventory_reservations AS reservation
          ON reservation.renewal_operation_id = cycle.renewal_operation_id
        WHERE cycle.id = v_order.subscription_cycle_id
          AND reservation.status IN ('held', 'committed', 'consumed')) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    UPDATE public.commerce_orders SET status = 'cancelled', cancelled_at = p_now, updated_at = p_now
    WHERE id = v_order.id AND status = 'pending_payment';
    IF NOT FOUND THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
    UPDATE public.commerce_order_draft_receipts
    SET invalidated_at = p_now, invalidation_reason = 'stale_promotion_claim'
    WHERE order_id = v_order.id AND invalidated_at IS NULL;
    UPDATE public.outbox_events
    SET processed_at = COALESCE(processed_at, p_now),
      metadata = metadata || jsonb_build_object('terminalReason', 'stale_promotion_claim')
    WHERE aggregate_id = v_order.id AND event_type = 'commerce.order_draft.created';
    v_cancelled := v_cancelled + 1;
  END LOOP;
  RETURN jsonb_build_object('checked', v_checked, 'cancelled', v_cancelled, 'skipped', v_skipped);
END;
$$;

CREATE FUNCTION public.commerce_promotion_claim_readback(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'claimId', claim.id, 'promotionId', claim.promotion_id, 'status', claim.status,
    'amountOffMinor', claim.amount_off_minor, 'definitionFingerprint', claim.definition_fingerprint,
    'reservedAt', claim.reserved_at, 'expiresAt', claim.expires_at,
    'redeemedAt', claim.redeemed_at, 'releasedAt', claim.released_at,
    'releaseReason', claim.release_reason
  ) ORDER BY claim.promotion_id), '[]'::jsonb)
  FROM public.commerce_promotion_claims AS claim WHERE claim.order_id = p_order_id;
$$;

REVOKE ALL ON TABLE public.commerce_promotion_definitions FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_adjustments FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_promotion_claims FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_promotion_claim_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_promotion_active_definitions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_promotion_paid_order_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_promotion_redemption_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_promotion_device_first_order_redeemed(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_create_promoted_order_draft_with_outbox(text, jsonb, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_adjustments_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_promotion_claim_money_freeze() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_transition_order_promotion_claims() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_order_money_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_sweep_stale_promotion_claims(timestamptz, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_promotion_claim_readback(uuid) FROM PUBLIC;
