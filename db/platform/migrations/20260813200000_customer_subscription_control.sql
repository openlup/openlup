-- Public customer subscription-control rail.
--
-- This forward adds the product-editing half deliberately absent from the
-- lifecycle rail: versioned subscription lines, a content-addressed preview
-- ledger, and actor-scoped snapshot/preview/apply routines for one generic
-- update_bundle action. It reuses clients, catalog SKUs/prices, cycle/order
-- locks and subscription events. It does not reproduce private dunning,
-- payment-provider, pet, address, invoice or fulfillment evidence schemas.
--
-- Preview writes one bounded quote identity. Apply locks the subscription,
-- checks ownership/revision/expiry/content, replaces the line set and records
-- the accepted event in one transaction. A repeated action key reads the event
-- as its replay answer before current quote expiry is considered.
--
-- openlup:allow-security-definer: actor wrappers derive the principal from
-- auth.uid(), expose fixed operations and must write/read without table DML grants.
-- openlup:allow-grant: authenticated receives EXECUTE only on the three bounded
-- actor wrappers; all inner helpers and direct table access stay unavailable.

ALTER TABLE public.subscriptions
  ADD COLUMN template_version integer NOT NULL DEFAULT 1,
  ADD COLUMN edit_window_hours integer NOT NULL DEFAULT 72,
  ADD COLUMN price_list_id uuid,
  ADD COLUMN currency_code text;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_price_list_id_fkey
    FOREIGN KEY (price_list_id) REFERENCES public.price_lists(id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT subscriptions_template_version_check CHECK (template_version > 0) NOT VALID,
  ADD CONSTRAINT subscriptions_edit_window_hours_check CHECK (edit_window_hours BETWEEN 1 AND 720) NOT VALID,
  ADD CONSTRAINT subscriptions_currency_code_check
    CHECK (currency_code IS NULL OR char_length(currency_code) = 3) NOT VALID,
  ADD CONSTRAINT subscriptions_price_context_check
    CHECK ((price_list_id IS NULL) = (currency_code IS NULL)) NOT VALID;

CREATE TABLE public.subscription_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  sort_order integer NOT NULL,
  is_addon boolean NOT NULL DEFAULT false,
  unit_price_minor bigint NOT NULL,
  currency_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_lines_quantity_check CHECK (quantity BETWEEN 1 AND 99),
  CONSTRAINT subscription_lines_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT subscription_lines_unit_price_check CHECK (unit_price_minor >= 0),
  CONSTRAINT subscription_lines_currency_code_check CHECK (char_length(currency_code) = 3),
  CONSTRAINT subscription_lines_subscription_variant_key UNIQUE (subscription_id, variant_id)
);

CREATE INDEX idx_subscription_lines_subscription
  ON public.subscription_lines (subscription_id, sort_order);

CREATE TABLE public.subscription_edit_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  quote_hash text NOT NULL,
  action text NOT NULL DEFAULT 'update_bundle',
  expected_template_version integer NOT NULL,
  proposed_lines jsonb NOT NULL,
  proposed_cadence_days integer NOT NULL,
  current_total_minor bigint NOT NULL,
  new_total_minor bigint NOT NULL,
  currency_code text NOT NULL,
  status text NOT NULL DEFAULT 'previewed',
  expires_at timestamptz NOT NULL,
  accepted_event_id uuid REFERENCES public.subscription_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CONSTRAINT subscription_edit_quotes_idempotency_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 180),
  CONSTRAINT subscription_edit_quotes_request_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_edit_quotes_quote_hash_check CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_edit_quotes_action_check CHECK (action = 'update_bundle'),
  CONSTRAINT subscription_edit_quotes_template_version_check CHECK (expected_template_version > 0),
  CONSTRAINT subscription_edit_quotes_lines_check CHECK (jsonb_typeof(proposed_lines) = 'array'),
  CONSTRAINT subscription_edit_quotes_cadence_check CHECK (proposed_cadence_days BETWEEN 1 AND 90),
  CONSTRAINT subscription_edit_quotes_totals_check
    CHECK (current_total_minor >= 0 AND new_total_minor >= 0),
  CONSTRAINT subscription_edit_quotes_currency_check CHECK (char_length(currency_code) = 3),
  CONSTRAINT subscription_edit_quotes_status_check CHECK (status IN ('previewed', 'accepted')),
  CONSTRAINT subscription_edit_quotes_acceptance_check CHECK (
    (status = 'previewed' AND accepted_event_id IS NULL AND accepted_at IS NULL)
    OR (status = 'accepted' AND accepted_event_id IS NOT NULL AND accepted_at IS NOT NULL)
  ),
  CONSTRAINT subscription_edit_quotes_subscription_key UNIQUE (subscription_id, idempotency_key),
  CONSTRAINT subscription_edit_quotes_subscription_hash_key UNIQUE (subscription_id, quote_hash)
);

CREATE INDEX idx_subscription_edit_quotes_subscription_created
  ON public.subscription_edit_quotes (subscription_id, created_at DESC);

CREATE FUNCTION public.subscription_bundle_edit_fingerprint(
  p_subscription_id uuid,
  p_core_lines jsonb,
  p_addon_lines jsonb,
  p_composition_constraint jsonb,
  p_cadence_days integer,
  p_expected_template_version integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT encode(
    sha256(convert_to(jsonb_build_object(
      'subscriptionId', p_subscription_id,
      'coreLines', COALESCE(p_core_lines, '[]'::jsonb),
      'addonLines', COALESCE(p_addon_lines, '[]'::jsonb),
      'compositionConstraint', COALESCE(p_composition_constraint, '{}'::jsonb),
      'cadenceDays', p_cadence_days,
      'expectedTemplateVersion', p_expected_template_version
    )::text, 'UTF8')),
    'hex'
  )
$$;

CREATE FUNCTION public.customer_subscription_control_snapshot_as_actor()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
  v_subscriptions jsonb;
BEGIN
  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_control_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT client.id INTO v_client_id
    FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'subscriptionId', subscription.id,
    'status', subscription.status,
    'cadenceDays', subscription.cadence_days,
    'nextCycleAt', subscription.next_cycle_at,
    'editCutoffAt', CASE WHEN subscription.next_cycle_at IS NULL THEN NULL
      ELSE subscription.next_cycle_at - make_interval(hours => subscription.edit_window_hours) END,
    'templateVersion', subscription.template_version,
    'recurringTotal', CASE WHEN subscription.currency_code IS NULL THEN NULL ELSE jsonb_build_object(
      'amountMinor', COALESCE((SELECT sum(line.unit_price_minor * line.quantity)
        FROM public.subscription_lines AS line WHERE line.subscription_id = subscription.id), 0),
      'currency', subscription.currency_code
    ) END,
    'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'variantId', line.variant_id,
      'quantity', line.quantity,
      'isAddon', line.is_addon,
      'sortOrder', line.sort_order
    ) ORDER BY line.sort_order, line.id)
      FROM public.subscription_lines AS line
     WHERE line.subscription_id = subscription.id), '[]'::jsonb)
  ) ORDER BY subscription.created_at DESC), '[]'::jsonb)
  INTO v_subscriptions
  FROM public.subscriptions AS subscription
  WHERE subscription.client_id = v_client_id;

  RETURN jsonb_build_object(
    'contractVersion', 'customer.subscription_control.v1',
    'subscriptions', v_subscriptions
  );
END;
$$;

CREATE FUNCTION public.customer_subscription_preview_bundle_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_core_lines jsonb,
  p_addon_lines jsonb DEFAULT '[]'::jsonb,
  p_composition_constraint jsonb DEFAULT '{}'::jsonb,
  p_cadence_days integer DEFAULT NULL,
  p_expected_template_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_lines jsonb;
  v_fingerprint text;
  v_quote_hash text;
  v_current_total bigint;
  v_new_total bigint;
  v_cadence_days integer;
  v_expected_version integer;
  v_expires_at timestamptz;
  v_blocked_reason text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_core_lines) <> 'array'
    OR jsonb_array_length(p_core_lines) NOT BETWEEN 1 AND 6
    OR jsonb_typeof(COALESCE(p_addon_lines, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_addon_lines, '[]'::jsonb)) > 12
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE = '22023';
  END IF;

  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT client.id INTO v_client_id FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_subscription FROM public.subscriptions
   WHERE id = p_subscription_id AND client_id = v_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_forbidden' USING ERRCODE = '22023';
  END IF;

  v_cadence_days := COALESCE(p_cadence_days, v_subscription.cadence_days);
  v_expected_version := COALESCE(p_expected_template_version, v_subscription.template_version);
  IF v_cadence_days NOT BETWEEN 1 AND 90 OR v_expected_version < 1 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.status <> 'active' THEN
    v_blocked_reason := 'not_active';
  ELSIF v_subscription.next_cycle_at IS NOT NULL
    AND statement_timestamp() >= v_subscription.next_cycle_at
      - make_interval(hours => v_subscription.edit_window_hours)
  THEN
    v_blocked_reason := 'edit_window_closed';
  ELSIF EXISTS (
    SELECT 1 FROM public.subscription_cycles AS cycle
    LEFT JOIN public.commerce_orders AS order_row ON order_row.subscription_cycle_id = cycle.id
    WHERE cycle.subscription_id = v_subscription.id
      AND cycle.scheduled_at = v_subscription.next_cycle_at
      AND (cycle.status IN ('payment_pending', 'paid')
        OR order_row.status IN ('paid', 'fulfillment_pending', 'fulfilled'))
  ) THEN
    v_blocked_reason := 'cycle_locked';
  END IF;
  IF v_blocked_reason IS NOT NULL THEN
    RETURN jsonb_build_object('preview', jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'action', 'update_bundle',
      'canApply', false,
      'blockedReason', v_blocked_reason,
      'nextCycleAt', v_subscription.next_cycle_at,
      'editCutoffAt', CASE WHEN v_subscription.next_cycle_at IS NULL THEN NULL ELSE
        v_subscription.next_cycle_at - make_interval(hours => v_subscription.edit_window_hours) END,
      'templateVersion', v_subscription.template_version
    ));
  END IF;
  IF v_subscription.price_list_id IS NULL OR v_subscription.currency_code IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_price_context_missing' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT value FROM jsonb_array_elements(p_core_lines)
      UNION ALL
      SELECT value FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb))
    ) AS requested
    WHERE jsonb_typeof(requested.value) <> 'object'
      OR COALESCE(requested.value->>'variantId', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(requested.value->>'qty', '') !~ '^[0-9]+$'
      OR (requested.value->>'qty')::integer NOT BETWEEN 1 AND 99
  ) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT value->>'variantId' AS variant_id FROM jsonb_array_elements(p_core_lines)
      UNION ALL
      SELECT value->>'variantId' FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb))
    ) AS requested GROUP BY variant_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'subscription_edit_duplicate_variant' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
      'variantId', requested.variant_id,
      'quantity', requested.quantity,
      'isAddon', requested.is_addon,
      'sortOrder', requested.sort_order,
      'unitPriceMinor', requested.unit_price_minor,
      'currency', v_subscription.currency_code
    ) ORDER BY requested.sort_order),
    sum(requested.unit_price_minor * requested.quantity)
  INTO v_lines, v_new_total
  FROM (
    SELECT parsed.variant_id, parsed.quantity, parsed.is_addon, parsed.sort_order,
      (SELECT price.unit_price_minor
         FROM public.price_entries AS price
        WHERE price.variant_id = parsed.variant_id
          AND price.price_list_id = v_subscription.price_list_id
          AND price.mode IN ('subscription', 'any')
          AND price.active = true
          AND price.min_qty <= parsed.quantity
          AND price.valid_from <= statement_timestamp()
          AND (price.valid_to IS NULL OR price.valid_to > statement_timestamp())
        ORDER BY CASE price.mode WHEN 'subscription' THEN 0 ELSE 1 END,
          price.min_qty DESC, price.valid_from DESC, price.id
        LIMIT 1) AS unit_price_minor
    FROM (
      SELECT (value->>'variantId')::uuid AS variant_id,
        (value->>'qty')::integer AS quantity, false AS is_addon,
        (ordinality - 1)::integer AS sort_order
      FROM jsonb_array_elements(p_core_lines) WITH ORDINALITY
      UNION ALL
      SELECT (value->>'variantId')::uuid, (value->>'qty')::integer, true,
        (jsonb_array_length(p_core_lines) + ordinality - 1)::integer
      FROM jsonb_array_elements(COALESCE(p_addon_lines, '[]'::jsonb)) WITH ORDINALITY
    ) AS parsed
    JOIN public.catalog_skus AS sku ON sku.id = parsed.variant_id
      AND sku.status = 'active' AND sku.sellable_in_subscription = true
  ) AS requested;

  IF v_lines IS NULL OR jsonb_array_length(v_lines)
      <> jsonb_array_length(p_core_lines) + jsonb_array_length(COALESCE(p_addon_lines, '[]'::jsonb))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) AS line
      WHERE line->'unitPriceMinor' = 'null'::jsonb)
  THEN
    RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(sum(line.unit_price_minor * line.quantity), 0)
    INTO v_current_total FROM public.subscription_lines AS line
   WHERE line.subscription_id = v_subscription.id;
  v_fingerprint := public.subscription_bundle_edit_fingerprint(
    v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
    COALESCE(p_composition_constraint, '{}'::jsonb), v_cadence_days, v_expected_version
  );

  SELECT * INTO v_quote FROM public.subscription_edit_quotes
   WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_quote.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    v_expires_at := statement_timestamp() + interval '15 minutes';
    v_quote_hash := encode(sha256(convert_to(
      v_subscription.id::text || ':' || v_fingerprint || ':' || v_expected_version::text
      || ':' || v_new_total::text || ':' || v_expires_at::text, 'UTF8')), 'hex');
    INSERT INTO public.subscription_edit_quotes (
      subscription_id, idempotency_key, request_fingerprint, quote_hash,
      expected_template_version, proposed_lines, proposed_cadence_days,
      current_total_minor, new_total_minor, currency_code, expires_at
    ) VALUES (
      v_subscription.id, p_idempotency_key, v_fingerprint, v_quote_hash,
      v_expected_version, v_lines, v_cadence_days, v_current_total, v_new_total,
      v_subscription.currency_code, v_expires_at
    ) RETURNING * INTO v_quote;
  END IF;

  RETURN jsonb_build_object('preview', jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'action', 'update_bundle',
    'canApply', true,
    'blockedReason', NULL,
    'nextCycleAt', v_subscription.next_cycle_at,
    'editCutoffAt', CASE WHEN v_subscription.next_cycle_at IS NULL THEN NULL ELSE
      v_subscription.next_cycle_at - make_interval(hours => v_subscription.edit_window_hours) END,
    'templateVersion', v_subscription.template_version,
    'quoteHash', v_quote.quote_hash,
    'quoteExpiresAt', v_quote.expires_at,
    'currentTotal', jsonb_build_object('amountMinor', v_quote.current_total_minor, 'currency', v_quote.currency_code),
    'newTotal', jsonb_build_object('amountMinor', v_quote.new_total_minor, 'currency', v_quote.currency_code),
    'delta', jsonb_build_object('amountMinor', v_quote.new_total_minor - v_quote.current_total_minor, 'currency', v_quote.currency_code),
    'catalogAvailability', jsonb_build_object('status', 'available', 'blockedReason', NULL)
  ));
END;
$$;

CREATE FUNCTION public.customer_subscription_apply_bundle_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_accepted_quote_hash text,
  p_core_lines jsonb,
  p_addon_lines jsonb DEFAULT '[]'::jsonb,
  p_composition_constraint jsonb DEFAULT '{}'::jsonb,
  p_cadence_days integer DEFAULT NULL,
  p_expected_template_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_event_id uuid;
  v_fingerprint text;
  v_line jsonb;
BEGIN
  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT client.id INTO v_client_id FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_subscription FROM public.subscriptions
   WHERE id = p_subscription_id AND client_id = v_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_edit_forbidden' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.subscription_events
   WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT * INTO v_quote FROM public.subscription_edit_quotes
     WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key;
    v_fingerprint := public.subscription_bundle_edit_fingerprint(
      v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
      COALESCE(p_composition_constraint, '{}'::jsonb),
      COALESCE(p_cadence_days, v_subscription.cadence_days),
      COALESCE(p_expected_template_version, v_quote.expected_template_version)
    );
    IF NOT FOUND OR v_quote.quote_hash <> p_accepted_quote_hash
      OR v_quote.request_fingerprint <> v_fingerprint
      OR v_quote.accepted_event_id <> v_existing.id
    THEN
      RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'customer.self_service.v1',
      'subscriptionAction', jsonb_build_object(
        'subscriptionId', v_subscription.id,
        'action', 'update_bundle',
        'status', 'replayed',
        'subscriptionStatus', v_subscription.status,
        'nextCycleAt', v_subscription.next_cycle_at,
        'templateVersion', v_subscription.template_version,
        'eventId', v_existing.id
      )
    );
  END IF;

  SELECT * INTO v_quote FROM public.subscription_edit_quotes
   WHERE subscription_id = v_subscription.id AND idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF NOT FOUND OR v_quote.quote_hash <> p_accepted_quote_hash THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public.subscription_bundle_edit_fingerprint(
    v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
    COALESCE(p_composition_constraint, '{}'::jsonb),
    COALESCE(p_cadence_days, v_subscription.cadence_days),
    COALESCE(p_expected_template_version, v_subscription.template_version)
  );
  IF v_quote.request_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'subscription_edit_idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_quote.status <> 'previewed' OR v_quote.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.status <> 'active'
    OR v_subscription.template_version <> v_quote.expected_template_version
  THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE = '22023';
  END IF;
  IF v_subscription.next_cycle_at IS NOT NULL
    AND statement_timestamp() >= v_subscription.next_cycle_at
      - make_interval(hours => v_subscription.edit_window_hours)
  THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE = '22023';
  END IF;
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
    v_subscription.id, v_subscription.next_cycle_at
  );

  DELETE FROM public.subscription_lines WHERE subscription_id = v_subscription.id;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_quote.proposed_lines)
  LOOP
    INSERT INTO public.subscription_lines (
      subscription_id, variant_id, quantity, sort_order, is_addon,
      unit_price_minor, currency_code
    ) VALUES (
      v_subscription.id,
      (v_line->>'variantId')::uuid,
      (v_line->>'quantity')::integer,
      (v_line->>'sortOrder')::integer,
      (v_line->>'isAddon')::boolean,
      (v_line->>'unitPriceMinor')::bigint,
      v_quote.currency_code
    );
  END LOOP;
  UPDATE public.subscriptions SET
    cadence_days = v_quote.proposed_cadence_days,
    template_version = template_version + 1,
    updated_at = statement_timestamp()
  WHERE id = v_subscription.id RETURNING * INTO v_subscription;

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_subscription.id,
    'subscription.customer_self_service.update_bundle',
    p_idempotency_key,
    jsonb_build_object(
      'action', 'update_bundle',
      'quoteHash', v_quote.quote_hash,
      'templateVersion', v_subscription.template_version,
      'newTotalMinor', v_quote.new_total_minor,
      'currency', v_quote.currency_code
    ),
    statement_timestamp()
  ) RETURNING id INTO v_event_id;
  UPDATE public.subscription_edit_quotes SET
    status = 'accepted', accepted_event_id = v_event_id,
    accepted_at = statement_timestamp()
  WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'contractVersion', 'customer.self_service.v1',
    'subscriptionAction', jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'action', 'update_bundle',
      'status', 'applied',
      'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at,
      'templateVersion', v_subscription.template_version,
      'eventId', v_event_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_bundle_edit_fingerprint(
  uuid, jsonb, jsonb, jsonb, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_subscription_control_snapshot_as_actor()
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.customer_subscription_preview_bundle_as_actor(
  uuid, text, jsonb, jsonb, jsonb, integer, integer
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.customer_subscription_apply_bundle_as_actor(
  uuid, text, text, jsonb, jsonb, jsonb, integer, integer
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.customer_subscription_control_snapshot_as_actor()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_subscription_preview_bundle_as_actor(
  uuid, text, jsonb, jsonb, jsonb, integer, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_subscription_apply_bundle_as_actor(
  uuid, text, text, jsonb, jsonb, jsonb, integer, integer
) TO authenticated;
