-- Native winback uses explicit host policy values and separate episode/send identities.
-- Compatibility defaults retain consent required and the installed [14,120)-day window.
-- Static prefix hashes admit this forward; installed-body witnesses preserve the timing DO patch.
-- No policy seed, ACL change, portal binding or other retention-kind activation.

CREATE OR REPLACE FUNCTION public.subscriber_retention_plan_due(
  p_kind text,
  p_limit integer DEFAULT 100,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_winback_policy jsonb;
  v_winback_min_age integer;
  v_winback_max_age integer;
  v_row record;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_scanned integer := 0;
  v_planned integer := 0;
  v_refused integer := 0;
  v_replayed integer := 0;
  v_subject_reference text;
  v_locale text;
  v_profile_fingerprint text;
  v_profile_revision integer;
  v_capability text;
  v_display_name text;
  v_recipient_fingerprint text;
  v_template_reference text;
  v_intent_fingerprint text;
  v_result jsonb;
BEGIN
  IF p_kind = 'winback' THEN
    SELECT value_text::jsonb INTO v_winback_policy FROM public.commerce_settings WHERE key = 'subscriber_winback_policy';
    v_winback_policy := coalesce(v_winback_policy, '{}'::jsonb);
    IF jsonb_typeof(v_winback_policy) <> 'object'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_winback_policy) k WHERE k NOT IN ('requireRetentionConsent','minCancellationAgeDays','maxCancellationAgeDays'))
      OR (v_winback_policy ? 'requireRetentionConsent' AND jsonb_typeof(v_winback_policy->'requireRetentionConsent') <> 'boolean')
      OR (v_winback_policy ? 'minCancellationAgeDays' AND jsonb_typeof(v_winback_policy->'minCancellationAgeDays') <> 'number')
      OR (v_winback_policy ? 'maxCancellationAgeDays' AND jsonb_typeof(v_winback_policy->'maxCancellationAgeDays') <> 'number') THEN
      RAISE EXCEPTION 'subscriber_winback_policy_invalid' USING ERRCODE = '22023';
    END IF;
    v_winback_min_age := coalesce((v_winback_policy->>'minCancellationAgeDays')::integer, 14);
    v_winback_max_age := coalesce((v_winback_policy->>'maxCancellationAgeDays')::integer, 120);
    IF v_winback_min_age < 0 OR v_winback_max_age <= v_winback_min_age THEN
      RAISE EXCEPTION 'subscriber_winback_policy_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_kind IS NULL
     OR p_kind NOT IN ('paid_cycle_recap', 'reorder_reminder', 'review_request', 'review_effects', 'winback') THEN
    RAISE EXCEPTION 'subscriber_retention_plan_kind_invalid' USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT candidate.*
    FROM (
      SELECT orders.id AS source_id, subscription.id AS subscription_id,
             subscription.client_id, orders.paid_at AS due_at,
             'retention.paid_cycle_recap.' || orders.id::text AS idempotency_key
      FROM public.commerce_orders AS orders
      JOIN public.subscription_cycles AS cycle ON cycle.id = orders.subscription_cycle_id
      JOIN public.subscriptions AS subscription ON subscription.id = cycle.subscription_id
      WHERE p_kind = 'paid_cycle_recap'
        AND subscription.status = 'active'
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND orders.paid_at IS NOT NULL
        AND orders.paid_at >= (
          SELECT activated_at FROM public.subscriber_retention_activation_watermarks
          WHERE kind = 'paid_cycle_recap'
        )

      UNION ALL

      SELECT orders.id, NULL::uuid, orders.client_id, shipment.delivered_at,
             'retention.reorder_reminder.' || orders.id::text
      FROM public.commerce_orders AS orders
      JOIN public.fulfillment_shipments AS shipment ON shipment.order_id = orders.id
      WHERE p_kind = 'reorder_reminder'
        AND orders.client_id IS NOT NULL
        AND orders.subscription_cycle_id IS NULL
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND shipment.status = 'delivered'
        AND EXISTS (
          SELECT 1 FROM public.fulfillment_shipment_operations AS evidence
          WHERE evidence.shipment_id = shipment.id
            AND evidence.operation_type = 'evidence_recorded'
            AND evidence.payload->>'refRole' = 'tracking'
        )
        AND shipment.delivered_at < p_now - interval '30 days'
        AND shipment.delivered_at >= p_now - interval '60 days'
        AND NOT EXISTS (
          SELECT 1 FROM public.commerce_orders AS later_order
          WHERE later_order.client_id = orders.client_id
            AND later_order.id <> orders.id
            AND later_order.status IN ('paid', 'fulfillment_pending', 'fulfilled')
            AND later_order.created_at > orders.created_at
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.subscriptions AS live_subscription
          WHERE live_subscription.client_id = orders.client_id
            AND live_subscription.status IN ('active', 'paused')
        )

      UNION ALL

      SELECT orders.id, subscription.id, orders.client_id, shipment.delivered_at,
             'retention.review_request.' || orders.id::text
      FROM public.commerce_orders AS orders
      JOIN public.fulfillment_shipments AS shipment ON shipment.order_id = orders.id
      LEFT JOIN public.subscription_cycles AS cycle ON cycle.id = orders.subscription_cycle_id
      LEFT JOIN public.subscriptions AS subscription ON subscription.id = cycle.subscription_id
      WHERE p_kind = 'review_request'
        AND orders.client_id IS NOT NULL
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND shipment.status = 'delivered'
        AND EXISTS (
          SELECT 1 FROM public.fulfillment_shipment_operations AS evidence
          WHERE evidence.shipment_id = shipment.id
            AND evidence.operation_type = 'evidence_recorded'
            AND evidence.payload->>'refRole' = 'tracking'
        )
        AND shipment.delivered_at <= p_now - interval '3 days'
        AND shipment.delivered_at >= p_now - interval '30 days'

      UNION ALL

      SELECT orders.id, subscription.id, orders.client_id, shipment.delivered_at,
             'retention.review_effects.' || orders.id::text
      FROM public.commerce_orders AS orders
      JOIN public.fulfillment_shipments AS shipment ON shipment.order_id = orders.id
      LEFT JOIN public.subscription_cycles AS cycle ON cycle.id = orders.subscription_cycle_id
      LEFT JOIN public.subscriptions AS subscription ON subscription.id = cycle.subscription_id
      WHERE p_kind = 'review_effects'
        AND orders.client_id IS NOT NULL
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND shipment.status = 'delivered'
        AND EXISTS (
          SELECT 1 FROM public.fulfillment_shipment_operations AS evidence
          WHERE evidence.shipment_id = shipment.id
            AND evidence.operation_type = 'evidence_recorded'
            AND evidence.payload->>'refRole' = 'tracking'
        )
        AND shipment.delivered_at <= p_now - interval '14 days'
        AND shipment.delivered_at >= p_now - interval '60 days'
        AND EXISTS (
          SELECT 1 FROM public.subscriber_retention_intents AS first_touch
          WHERE first_touch.source_reference = 'order:' || orders.id::text
            AND first_touch.kind = 'review_request' AND first_touch.status = 'accepted'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.commerce_return_requests AS return_request
          WHERE return_request.order_id = orders.id
            AND return_request.status <> 'rejected'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.commerce_order_holds AS hold
          WHERE hold.order_id = orders.id AND hold.status = 'active'
            AND hold.reason IN ('manual_support', 'fulfillment_exception')
        )

      UNION ALL

      SELECT subscription.id, subscription.id, subscription.client_id,
             subscription.ended_at,
             'retention.winback.' || subscription.id::text || '.'
               || extract(epoch FROM subscription.ended_at)::bigint::text
      FROM public.subscriptions AS subscription
      WHERE p_kind = 'winback'
        AND subscription.status = 'cancelled'
        AND subscription.ended_at IS NOT NULL
        AND subscription.ended_at > p_now - make_interval(days => v_winback_max_age)
        AND subscription.ended_at <= p_now - make_interval(days => v_winback_min_age)
        AND EXISTS (
          SELECT 1 FROM public.subscription_events AS event
          WHERE event.subscription_id = subscription.id
            AND event.event_type = 'subscription.customer_self_service.cancel'
            AND event.occurred_at >= subscription.ended_at
        )
        AND NOT EXISTS (SELECT 1 FROM public.subscription_events sent
          WHERE sent.subscription_id = subscription.id AND sent.event_type = 'subscription.winback.email_sent'
            AND sent.occurred_at >= subscription.ended_at)
        AND NOT EXISTS (SELECT 1 FROM public.subscriber_retention_intents sent
          WHERE sent.subscription_id = subscription.id AND sent.kind = 'winback' AND sent.status = 'accepted')
        AND NOT EXISTS (SELECT 1 FROM public.transactional_delivery_receipts sent
          WHERE sent.idempotency_key = 'winback:' || subscription.id::text AND sent.state <> 'failed')
    ) AS candidate
    WHERE NOT EXISTS (
      SELECT 1 FROM public.subscriber_retention_intents AS prior
      WHERE prior.idempotency_key = candidate.idempotency_key
    )
    ORDER BY candidate.due_at, candidate.source_id
    LIMIT v_limit
  LOOP
    v_scanned := v_scanned + 1;
    -- Candidate discovery may materialize a missing neutral profile, but it
    -- does not own personalization revision. In particular, planning another
    -- message kind must not invalidate an already planned or failed intent.
    v_capability := 'retention-intent';
    SELECT
      'client:' || client.id::text,
      client.first_name,
      CASE WHEN client.metadata->>'locale' ~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$'
        THEN client.metadata->>'locale' ELSE NULL END,
      encode(sha256(convert_to(lower(btrim(client.email)), 'UTF8')), 'hex')
    INTO v_subject_reference, v_display_name, v_locale, v_recipient_fingerprint
    FROM public.clients AS client WHERE client.id = v_row.client_id;
    v_profile_fingerprint := encode(sha256(convert_to(jsonb_build_object(
      'subjectReference', v_subject_reference,
      'displayName', v_display_name,
      'locale', v_locale,
      'revision', 1,
      'displayFacts', '{}'::jsonb,
      'capabilities', to_jsonb(ARRAY[v_capability])
    )::text, 'UTF8')), 'hex');

    INSERT INTO public.subscriber_profiles(
      subject_reference, display_name, locale, revision,
      display_facts, capabilities, fingerprint
    )
    SELECT v_subject_reference, v_display_name, v_locale, 1,
           '{}'::jsonb, ARRAY[v_capability],
           v_profile_fingerprint
    ON CONFLICT (subject_reference) DO NOTHING;
    SELECT revision INTO v_profile_revision
    FROM public.subscriber_profiles WHERE subject_reference = v_subject_reference;

    v_template_reference := CASE p_kind
      WHEN 'paid_cycle_recap' THEN 'subscriber-paid-cycle-recap-v1'
      WHEN 'reorder_reminder' THEN 'subscriber-reorder-reminder-v1'
      WHEN 'review_request' THEN 'subscriber-review-request-v1'
      WHEN 'review_effects' THEN 'subscriber-review-effects-v1'
      ELSE 'subscriber-winback-v1'
    END;

    v_intent_fingerprint := encode(sha256(convert_to(concat_ws('|', v_row.idempotency_key,
      v_subject_reference, COALESCE(v_row.subscription_id::text, ''), p_kind,
      v_template_reference, v_profile_revision::text, v_recipient_fingerprint), 'UTF8')), 'hex');

    v_result := public.subscriber_retention_create_intent(
      v_row.idempotency_key,
      v_subject_reference,
      v_row.subscription_id,
      CASE WHEN p_kind = 'winback'
        THEN 'subscription:' || v_row.source_id::text
        ELSE 'order:' || v_row.source_id::text END,
      p_kind,
      v_template_reference,
      v_intent_fingerprint,
      v_profile_revision,
      v_recipient_fingerprint,
      'subscriber-retention',
      CASE WHEN p_kind = 'paid_cycle_recap' THEN NULL ELSE 'retention_marketing' END
    );
    IF (v_result->>'replayed')::boolean THEN
      v_replayed := v_replayed + 1;
    ELSIF v_result->>'status' = 'planned' THEN
      v_planned := v_planned + 1;
    ELSE
      v_refused := v_refused + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'scanned', v_scanned,
    'planned', v_planned,
    'refused', v_refused,
    'replayed', v_replayed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.subscriber_retention_eligibility_refusal(
  p_kind text,
  p_source_reference text,
  p_now timestamptz
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_winback_policy jsonb;
  v_winback_min_age integer;
  v_winback_max_age integer;
  v_source_id uuid := split_part(p_source_reference, ':', 2)::uuid;
  v_eligible boolean := false;
BEGIN
  IF p_kind = 'winback' THEN
    SELECT value_text::jsonb INTO v_winback_policy FROM public.commerce_settings WHERE key = 'subscriber_winback_policy';
    v_winback_policy := coalesce(v_winback_policy, '{}'::jsonb);
    IF jsonb_typeof(v_winback_policy) <> 'object'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_winback_policy) k WHERE k NOT IN ('requireRetentionConsent','minCancellationAgeDays','maxCancellationAgeDays'))
      OR (v_winback_policy ? 'requireRetentionConsent' AND jsonb_typeof(v_winback_policy->'requireRetentionConsent') <> 'boolean')
      OR (v_winback_policy ? 'minCancellationAgeDays' AND jsonb_typeof(v_winback_policy->'minCancellationAgeDays') <> 'number')
      OR (v_winback_policy ? 'maxCancellationAgeDays' AND jsonb_typeof(v_winback_policy->'maxCancellationAgeDays') <> 'number') THEN
      RAISE EXCEPTION 'subscriber_winback_policy_invalid' USING ERRCODE = '22023';
    END IF;
    v_winback_min_age := coalesce((v_winback_policy->>'minCancellationAgeDays')::integer, 14);
    v_winback_max_age := coalesce((v_winback_policy->>'maxCancellationAgeDays')::integer, 120);
    IF v_winback_min_age < 0 OR v_winback_max_age <= v_winback_min_age THEN
      RAISE EXCEPTION 'subscriber_winback_policy_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_kind = 'paid_cycle_recap' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commerce_orders AS orders
      JOIN public.subscription_cycles AS cycle ON cycle.id = orders.subscription_cycle_id
      JOIN public.subscriptions AS subscription ON subscription.id = cycle.subscription_id
      WHERE orders.id = v_source_id AND subscription.status = 'active'
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND orders.paid_at IS NOT NULL AND orders.paid_at >= (
          SELECT activated_at FROM public.subscriber_retention_activation_watermarks
          WHERE kind = 'paid_cycle_recap'
        )
    ) INTO v_eligible;
  ELSIF p_kind = 'reorder_reminder' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commerce_orders AS orders
      JOIN public.fulfillment_shipments AS shipment ON shipment.order_id = orders.id
      WHERE orders.id = v_source_id AND orders.subscription_cycle_id IS NULL
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND shipment.status = 'delivered'
        AND shipment.delivered_at < p_now - interval '30 days'
        AND shipment.delivered_at >= p_now - interval '60 days'
        AND EXISTS (SELECT 1 FROM public.fulfillment_shipment_operations AS evidence
          WHERE evidence.shipment_id = shipment.id AND evidence.operation_type = 'evidence_recorded'
            AND evidence.payload->>'refRole' = 'tracking')
        AND NOT EXISTS (SELECT 1 FROM public.commerce_orders AS later_order
          WHERE later_order.client_id = orders.client_id AND later_order.id <> orders.id
            AND later_order.status IN ('paid', 'fulfillment_pending', 'fulfilled')
            AND later_order.created_at > orders.created_at)
        AND NOT EXISTS (SELECT 1 FROM public.subscriptions AS live_subscription
          WHERE live_subscription.client_id = orders.client_id
            AND live_subscription.status IN ('active', 'paused'))
    ) INTO v_eligible;
  ELSIF p_kind IN ('review_request', 'review_effects') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.commerce_orders AS orders
      JOIN public.fulfillment_shipments AS shipment ON shipment.order_id = orders.id
      WHERE orders.id = v_source_id
        AND orders.status IN ('paid', 'fulfillment_pending', 'fulfilled')
        AND shipment.status = 'delivered'
        AND EXISTS (SELECT 1 FROM public.fulfillment_shipment_operations AS evidence
          WHERE evidence.shipment_id = shipment.id AND evidence.operation_type = 'evidence_recorded'
            AND evidence.payload->>'refRole' = 'tracking')
        AND shipment.delivered_at <= p_now - CASE p_kind
          WHEN 'review_request' THEN interval '3 days' ELSE interval '14 days' END
        AND shipment.delivered_at >= p_now - CASE p_kind
          WHEN 'review_request' THEN interval '30 days' ELSE interval '60 days' END
        AND (p_kind <> 'review_effects' OR (
          NOT EXISTS (SELECT 1 FROM public.commerce_return_requests AS return_request
            WHERE return_request.order_id = orders.id AND return_request.status <> 'rejected')
          AND NOT EXISTS (SELECT 1 FROM public.commerce_order_holds AS hold
            WHERE hold.order_id = orders.id AND hold.status = 'active'
              AND hold.reason IN ('manual_support', 'fulfillment_exception'))
        ))
    ) INTO v_eligible;
  ELSIF p_kind = 'winback' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.subscriptions AS subscription
      WHERE subscription.id = v_source_id AND subscription.status = 'cancelled'
        AND subscription.ended_at IS NOT NULL
        AND subscription.ended_at > p_now - make_interval(days => v_winback_max_age)
        AND subscription.ended_at <= p_now - make_interval(days => v_winback_min_age)
        AND EXISTS (SELECT 1 FROM public.subscription_events AS event
          WHERE event.subscription_id = subscription.id
            AND event.event_type = 'subscription.customer_self_service.cancel'
            AND event.occurred_at >= subscription.ended_at)
        AND NOT EXISTS (SELECT 1 FROM public.subscription_events sent
          WHERE sent.subscription_id = subscription.id AND sent.event_type = 'subscription.winback.email_sent'
            AND sent.occurred_at >= subscription.ended_at)
    ) INTO v_eligible;
  END IF;
  IF NOT v_eligible THEN RETURN 'source_ineligible'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscriber_retention_create_intent(
  p_idempotency_key text,
  p_subject_reference text,
  p_subscription_id uuid,
  p_source_reference text,
  p_kind text,
  p_template_reference text,
  p_fingerprint text,
  p_expected_revision integer,
  p_recipient_fingerprint text,
  p_control_key text,
  p_consent_purpose text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_prior public.subscriber_retention_intents%ROWTYPE;
  v_subscription_status text;
  v_refusal text;
  v_access_grant_reference text;
  v_id uuid;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_subject_reference IS NULL
     OR p_subject_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_source_reference IS NULL
     OR p_source_reference !~ '^(order|subscription):[a-f0-9-]{36}$'
     OR p_kind IS NULL
     OR p_kind NOT IN ('paid_cycle_recap', 'reorder_reminder', 'review_request', 'review_effects', 'winback')
     OR p_template_reference IS NULL
     OR p_template_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_recipient_fingerprint IS NULL OR p_recipient_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_control_key IS NULL OR p_control_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR (p_consent_purpose IS NOT NULL AND btrim(p_consent_purpose) = '') THEN
    RAISE EXCEPTION 'subscriber_retention_intent_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_prior FROM public.subscriber_retention_intents
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_prior.fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'subscriber_retention_intent_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.subscriber_retention_intent_result(v_prior.id, true);
  END IF;

  v_refusal := public.subscriber_retention_source_refusal(
    p_kind, p_source_reference, p_subject_reference, p_recipient_fingerprint,
    p_subscription_id
  );
  IF v_refusal IS NULL THEN
    v_refusal := public.subscriber_retention_contract_refusal(
      p_kind, p_template_reference, p_control_key, p_consent_purpose
    );
  END IF;
  IF v_refusal IS NULL THEN
    v_refusal := public.subscriber_retention_eligibility_refusal(
      p_kind, p_source_reference, now()
    );
  END IF;
  IF v_refusal IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscriber_profiles
    WHERE subject_reference = p_subject_reference
  ) THEN
    RAISE EXCEPTION 'subscriber_profile_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_refusal IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscriber_profiles
    WHERE subject_reference = p_subject_reference AND revision = p_expected_revision
  ) THEN
    v_refusal := 'stale_revision';
  END IF;

  IF p_subscription_id IS NOT NULL THEN
    SELECT status INTO v_subscription_status
    FROM public.subscriptions WHERE id = p_subscription_id;
  END IF;
  IF v_refusal IS NULL AND (
    (p_kind IN ('paid_cycle_recap', 'winback') AND v_subscription_status IS NULL)
    OR (p_kind = 'winback' AND v_subscription_status <> 'cancelled')
    OR (p_kind = 'paid_cycle_recap' AND v_subscription_status <> 'active')
    OR (p_kind IN ('reorder_reminder', 'review_request', 'review_effects')
      AND p_subscription_id IS NOT NULL
      AND v_subscription_status IS DISTINCT FROM 'active')
  ) THEN
    v_refusal := 'subscription_state_ineligible';
  END IF;

  IF v_refusal IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.communication_delivery_controls
    WHERE control_key = p_control_key AND enabled IS TRUE
  ) THEN
    v_refusal := 'control_disabled';
  END IF;

  IF v_refusal IS NULL AND p_consent_purpose IS NOT NULL AND (
    p_kind <> 'winback' OR coalesce((SELECT (value_text::jsonb->>'requireRetentionConsent')::boolean
      FROM public.commerce_settings WHERE key = 'subscriber_winback_policy'), true)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.communication_recipient_consents
    WHERE recipient_fingerprint = p_recipient_fingerprint
      AND purpose = p_consent_purpose
      AND state = 'granted'
  ) THEN
    v_refusal := 'consent_missing';
  END IF;

  IF v_refusal IS NULL AND p_kind = 'review_effects' AND NOT EXISTS (
    SELECT 1 FROM public.subscriber_retention_intents AS request
    WHERE request.kind = 'review_request'
      AND request.status = 'accepted'
      AND request.source_reference = p_source_reference
      AND request.subject_reference = p_subject_reference
      AND request.recipient_fingerprint = p_recipient_fingerprint
  ) THEN
    v_refusal := 'review_request_not_accepted';
  END IF;
  IF v_refusal IS NULL THEN
    v_refusal := public.subscriber_retention_idempotency_refusal(
      p_kind, p_source_reference, p_idempotency_key
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_reference || '|' || p_kind, 0));
  IF v_refusal IS NULL AND p_kind <> 'winback' AND EXISTS (
    SELECT 1 FROM public.subscriber_retention_intents AS semantic_prior
    WHERE semantic_prior.source_reference = p_source_reference
      AND semantic_prior.kind = p_kind
      AND semantic_prior.status <> 'refused'
  ) THEN
    v_refusal := 'source_kind_already_planned';
  END IF;

  IF v_refusal IS NULL AND p_kind IN ('review_request', 'review_effects') THEN
    INSERT INTO public.subscriber_review_access_grants(
      order_id, kind, grant_reference, expires_at
    ) VALUES (
      split_part(p_source_reference, ':', 2)::uuid,
      p_kind,
      'review-grant:' || gen_random_uuid()::text,
      now() + interval '30 days'
    )
    ON CONFLICT (order_id, kind) DO UPDATE SET order_id = EXCLUDED.order_id
    RETURNING grant_reference INTO v_access_grant_reference;
  END IF;

  INSERT INTO public.subscriber_retention_intents(
    idempotency_key, subject_reference, subscription_id, source_reference, access_grant_reference, kind,
    template_reference, fingerprint, expected_revision, recipient_fingerprint,
    control_key, consent_purpose, status, refusal
  ) VALUES (
    p_idempotency_key, p_subject_reference, p_subscription_id, p_source_reference, v_access_grant_reference, p_kind,
    p_template_reference, p_fingerprint, p_expected_revision, p_recipient_fingerprint,
    p_control_key, p_consent_purpose,
    CASE WHEN v_refusal IS NULL THEN 'planned' ELSE 'refused' END,
    v_refusal
  ) RETURNING id INTO v_id;
  RETURN public.subscriber_retention_intent_result(v_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscriber_retention_claim_intent(
  p_idempotency_key text,
  p_fingerprint text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent public.subscriber_retention_intents%ROWTYPE;
  v_subscription_status text;
  v_refusal text;
  v_mutation_at timestamptz;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'subscriber_retention_claim_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_intent FROM public.subscriber_retention_intents
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscriber_retention_intent_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_intent.fingerprint <> p_fingerprint THEN
    RAISE EXCEPTION 'subscriber_retention_intent_conflict' USING ERRCODE = '23505';
  END IF;
  v_mutation_at := GREATEST(p_now, v_intent.created_at, v_intent.updated_at);
  IF v_intent.status IN ('accepted', 'refused')
     OR (v_intent.status = 'dispatching' AND v_intent.dispatch_claim_expires_at > p_now) THEN
    RETURN NULL;
  END IF;

  v_refusal := public.subscriber_retention_source_refusal(
    v_intent.kind, v_intent.source_reference,
    v_intent.subject_reference, v_intent.recipient_fingerprint,
    v_intent.subscription_id
  );
  IF v_refusal IS NULL THEN
    v_refusal := public.subscriber_retention_contract_refusal(
      v_intent.kind, v_intent.template_reference,
      v_intent.control_key, v_intent.consent_purpose
    );
  END IF;
  IF v_refusal IS NULL THEN
    v_refusal := public.subscriber_retention_eligibility_refusal(
      v_intent.kind, v_intent.source_reference, p_now
    );
  END IF;
  IF v_refusal IS NULL THEN
    v_refusal := public.subscriber_retention_idempotency_refusal(
      v_intent.kind, v_intent.source_reference, v_intent.idempotency_key
    );
  END IF;

  IF v_refusal IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscriber_profiles
    WHERE subject_reference = v_intent.subject_reference
      AND revision = v_intent.expected_revision
  ) THEN
    v_refusal := 'stale_revision';
  END IF;
  IF v_intent.subscription_id IS NOT NULL THEN
    SELECT status INTO v_subscription_status
    FROM public.subscriptions WHERE id = v_intent.subscription_id;
  END IF;
  IF v_refusal IS NULL AND (
    (v_intent.kind IN ('paid_cycle_recap', 'winback') AND v_subscription_status IS NULL)
    OR (v_intent.kind = 'winback' AND v_subscription_status <> 'cancelled')
    OR (v_intent.kind = 'paid_cycle_recap' AND v_subscription_status <> 'active')
    OR (v_intent.kind IN ('reorder_reminder', 'review_request', 'review_effects')
      AND v_intent.subscription_id IS NOT NULL
      AND v_subscription_status IS DISTINCT FROM 'active')
  ) THEN
    v_refusal := 'subscription_state_ineligible';
  END IF;
  IF v_refusal IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.communication_delivery_controls
    WHERE control_key = v_intent.control_key AND enabled IS TRUE
  ) THEN
    v_refusal := 'control_disabled';
  END IF;
  IF v_refusal IS NULL AND v_intent.consent_purpose IS NOT NULL AND (
    v_intent.kind <> 'winback' OR coalesce((SELECT (value_text::jsonb->>'requireRetentionConsent')::boolean
      FROM public.commerce_settings WHERE key = 'subscriber_winback_policy'), true)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.communication_recipient_consents
    WHERE recipient_fingerprint = v_intent.recipient_fingerprint
      AND purpose = v_intent.consent_purpose AND state = 'granted'
  ) THEN
    v_refusal := 'consent_missing';
  END IF;
  IF v_refusal IS NULL AND v_intent.kind = 'review_effects' AND NOT EXISTS (
    SELECT 1 FROM public.subscriber_retention_intents AS request
    WHERE request.kind = 'review_request'
      AND request.status = 'accepted'
      AND request.source_reference = v_intent.source_reference
      AND request.subject_reference = v_intent.subject_reference
      AND request.recipient_fingerprint = v_intent.recipient_fingerprint
  ) THEN
    v_refusal := 'review_request_not_accepted';
  END IF;
  IF v_refusal IS NULL AND v_intent.kind <> 'winback' AND EXISTS (
    SELECT 1 FROM public.subscriber_retention_intents AS semantic_prior
    WHERE semantic_prior.id <> v_intent.id
      AND semantic_prior.source_reference = v_intent.source_reference
      AND semantic_prior.kind = v_intent.kind
      AND semantic_prior.status <> 'refused'
      AND (semantic_prior.created_at, semantic_prior.id) < (v_intent.created_at, v_intent.id)
  ) THEN
    v_refusal := 'source_kind_already_planned';
  END IF;
  IF v_refusal IS NULL AND v_intent.kind IN ('review_request', 'review_effects')
     AND NOT EXISTS (
       SELECT 1 FROM public.subscriber_review_access_grants
       WHERE grant_reference = v_intent.access_grant_reference
         AND revoked_at IS NULL AND expires_at > p_now
     ) THEN
    v_refusal := 'access_grant_unavailable';
  END IF;

  IF v_refusal IS NOT NULL THEN
    UPDATE public.subscriber_review_access_grants SET revoked_at = GREATEST(p_now, issued_at)
    WHERE grant_reference = v_intent.access_grant_reference AND revoked_at IS NULL;
    UPDATE public.subscriber_retention_intents SET
      status = 'refused', refusal = v_refusal,
      dispatch_claim_reference = NULL, dispatch_claim_expires_at = NULL,
      updated_at = v_mutation_at
    WHERE id = v_intent.id;
    RETURN NULL;
  END IF;

  UPDATE public.subscriber_retention_intents SET
    status = 'dispatching', refusal = NULL,
    dispatch_claim_reference = 'retention-claim:' || gen_random_uuid()::text,
    dispatch_claim_expires_at = v_mutation_at + interval '5 minutes', updated_at = v_mutation_at
  WHERE id = v_intent.id;
  RETURN public.subscriber_retention_intent_result(v_intent.id, false);
END;
$$;
