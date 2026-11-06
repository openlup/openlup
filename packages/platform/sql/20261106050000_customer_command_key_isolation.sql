-- Isolate customer command keys without rewriting issued history.
-- Legacy replay is restricted to the owned subscription's same self-service action.
-- Existing raw customer rows also require system producers to bypass foreign event types.
-- Replacements retain their original headers and ACLs under the native-store forward class.

CREATE OR REPLACE FUNCTION public.customer_subscription_pause_as_actor(
  p_subscription_id uuid,
  p_idempotency_key text,
  p_pause_preset text DEFAULT 'indefinite',
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_principal_id uuid;
  v_client_id uuid;
  v_command_key text;
  v_existing public.subscription_events%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
    OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  IF p_pause_preset IS NULL
    OR p_pause_preset NOT IN ('2_weeks', '1_month', 'indefinite')
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
  END IF;

  IF p_reason IS NOT NULL
    AND (btrim(p_reason) = '' OR char_length(p_reason) > 500)
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
  END IF;

  v_principal_id := auth.uid();
  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subscription_lifecycle_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT client.id
    INTO v_client_id
    FROM public.clients AS client
   WHERE client.principal_id = v_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_lifecycle_not_found' USING ERRCODE = '22023';
  END IF;

  -- Serialize ownership, legacy replay and the lifecycle write on the same row.
  PERFORM 1 FROM public.subscriptions
   WHERE id = p_subscription_id AND client_id = v_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_lifecycle_forbidden' USING ERRCODE = '22023';
  END IF;
  v_command_key := 'command:' || encode(sha256(convert_to(
    v_principal_id::text || ':' || p_idempotency_key, 'UTF8')), 'hex');
  SELECT * INTO v_existing FROM public.subscription_events
   WHERE subscription_id = p_subscription_id AND idempotency_key = v_command_key;
  IF FOUND THEN
    IF v_existing.event_type <> 'subscription.customer_self_service.pause'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'pause'
    THEN
      RAISE EXCEPTION 'subscription_lifecycle_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.subscription_events
     WHERE subscription_id = p_subscription_id AND idempotency_key = p_idempotency_key
       AND event_type = 'subscription.customer_self_service.pause'
       AND payload->>'action' = 'pause'
  ) THEN
    -- Old history stays byte-exact; only this owner's same-action event can replay.
    v_command_key := p_idempotency_key;
  END IF;

  RETURN public.subscription_apply_lifecycle_action(
    v_client_id,
    v_command_key,
    p_subscription_id,
    'pause',
    jsonb_build_object('pausePreset', p_pause_preset, 'reason', p_reason),
    statement_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_subscription_preview_bundle_as_actor(
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
  v_command_key text;
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

  v_command_key := 'command:' || encode(sha256(convert_to(
    v_principal_id::text || ':' || p_idempotency_key, 'UTF8')), 'hex');

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
   WHERE subscription_id = v_subscription.id AND idempotency_key IN (v_command_key, p_idempotency_key)
   ORDER BY (idempotency_key = v_command_key) DESC LIMIT 1;
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
      v_subscription.id, v_command_key, v_fingerprint, v_quote_hash,
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

CREATE OR REPLACE FUNCTION public.customer_subscription_apply_bundle_as_actor(
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
  v_command_key text;
  v_subscription public.subscriptions%ROWTYPE;
  v_quote public.subscription_edit_quotes%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_event_id uuid;
  v_fingerprint text;
  v_line jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key <> btrim(p_idempotency_key)
    OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 180
  THEN
    RAISE EXCEPTION 'subscription_edit_invalid_idempotency_key' USING ERRCODE = '22023';
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

  v_command_key := 'command:' || encode(sha256(convert_to(
    v_principal_id::text || ':' || p_idempotency_key, 'UTF8')), 'hex');

  SELECT * INTO v_existing FROM public.subscription_events
   WHERE subscription_id = v_subscription.id
     AND (idempotency_key = v_command_key OR (idempotency_key = p_idempotency_key
       AND event_type = 'subscription.customer_self_service.update_bundle'
       AND payload->>'action' = 'update_bundle'))
   ORDER BY (idempotency_key = v_command_key) DESC LIMIT 1;
  IF FOUND THEN
    SELECT * INTO v_quote FROM public.subscription_edit_quotes
     WHERE subscription_id = v_subscription.id
       AND idempotency_key IN (v_command_key, p_idempotency_key)
     ORDER BY (idempotency_key = v_command_key) DESC LIMIT 1;
    v_fingerprint := public.subscription_bundle_edit_fingerprint(
      v_subscription.id, p_core_lines, COALESCE(p_addon_lines, '[]'::jsonb),
      COALESCE(p_composition_constraint, '{}'::jsonb),
      COALESCE(p_cadence_days, v_subscription.cadence_days),
      COALESCE(p_expected_template_version, v_quote.expected_template_version)
    );
    IF NOT FOUND OR v_existing.event_type <> 'subscription.customer_self_service.update_bundle'
      OR v_existing.payload->>'action' IS DISTINCT FROM 'update_bundle'
      OR v_quote.quote_hash IS DISTINCT FROM p_accepted_quote_hash
      OR v_quote.request_fingerprint <> v_fingerprint
      OR v_quote.accepted_event_id IS DISTINCT FROM v_existing.id
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
   WHERE subscription_id = v_subscription.id AND idempotency_key IN (v_command_key, p_idempotency_key)
   ORDER BY (idempotency_key = v_command_key) DESC LIMIT 1 FOR UPDATE;
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
    v_command_key,
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

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_handle_failure(
  p_case_id uuid,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_template_slug text,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_notification_id uuid;
  v_event_id uuid;
  v_event_key text;
  v_at timestamptz := COALESCE(p_occurred_at, now());
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;
  IF v_case.status <> 'open' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'paused', false, 'terminal', true
    );
  END IF;

  IF p_next_retry_at IS NOT NULL THEN
    UPDATE public.subscription_dunning_cases
    SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt + 1), 1),
        next_retry_at = p_next_retry_at,
        failure_class = COALESCE(p_failure_class, failure_class),
        failure_reason = COALESCE(p_failure_reason, failure_reason),
        updated_at = v_at
    WHERE id = v_case.id
    RETURNING * INTO v_case;

    v_notification_id := public.dunning_lifecycle_queue_notice(
      v_case.id, 'payment_failed', p_template_slug, v_case.retry_attempt, p_recovery_url_path
    );
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
      'retryAttempt', v_case.retry_attempt, 'paused', false, 'terminal', false
    );
  END IF;

  UPDATE public.subscription_dunning_cases
  SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt), v_case.retry_attempt),
      next_retry_at = NULL,
      failure_class = COALESCE(p_failure_class, failure_class),
      failure_reason = COALESCE(p_failure_reason, failure_reason),
      updated_at = v_at
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  v_notification_id := public.dunning_lifecycle_queue_notice(
    v_case.id, 'payment_expired', p_template_slug, 0, p_recovery_url_path
  );

  v_event_key := 'dunning-exhausted:' || v_case.id::text;
  -- A pre-upgrade customer row must neither block nor suppress system evidence.
  WHILE EXISTS (SELECT 1 FROM public.subscription_events
    WHERE subscription_id = v_case.subscription_id AND idempotency_key = v_event_key
      AND event_type <> 'dunning_ladder_exhausted')
  LOOP
    v_event_key := 'system:' || v_event_key;
  END LOOP;
  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_case.subscription_id, 'dunning_ladder_exhausted',
    v_event_key,
    jsonb_build_object('caseId', v_case.id, 'retryAttempt', v_case.retry_attempt),
    v_at
  )
  ON CONFLICT ON CONSTRAINT subscription_events_subscription_id_idempotency_key_key DO NOTHING
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
    'retryAttempt', v_case.retry_attempt, 'paused', false,
    'pauseWindowId', NULL, 'terminal', true
  );
END;
$$;
