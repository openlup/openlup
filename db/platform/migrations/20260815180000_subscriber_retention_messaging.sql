-- Portable subscriber-retention messaging ledger.
--
-- This delta adds a neutral subject profile and an authorization/reconciliation
-- ledger for lifecycle message intents. It deliberately does not store HTML,
-- copy, an address, a provider name, dog grammar, or an LLM result. Delivery is
-- performed by the existing Communications transactional-delivery binding;
-- this ledger records why a message was eligible and the durable receipt state
-- that binding returned. Pause/resume remain owned by the subscription lifecycle
-- rail, consent by the recipient-consent rail, and the operator switch by the
-- Communications control plane.

CREATE TABLE public.subscriber_profiles (
  subject_reference text PRIMARY KEY,
  display_name text,
  locale text,
  revision integer NOT NULL,
  display_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriber_profiles_subject_reference_check
    CHECK (subject_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT subscriber_profiles_display_name_check
    CHECK (display_name IS NULL OR (btrim(display_name) <> '' AND char_length(display_name) <= 160)),
  CONSTRAINT subscriber_profiles_locale_check
    CHECK (locale IS NULL OR locale ~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$'),
  CONSTRAINT subscriber_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT subscriber_profiles_display_facts_check CHECK (jsonb_typeof(display_facts) = 'object'),
  CONSTRAINT subscriber_profiles_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT subscriber_profiles_timestamp_check CHECK (updated_at >= created_at)
);

CREATE TABLE public.subscriber_retention_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  subject_reference text NOT NULL
    REFERENCES public.subscriber_profiles(subject_reference) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
  source_reference text NOT NULL,
  access_grant_reference text,
  dispatch_claim_reference text,
  dispatch_claim_expires_at timestamptz,
  kind text NOT NULL,
  template_reference text NOT NULL,
  fingerprint text NOT NULL,
  expected_revision integer NOT NULL,
  recipient_fingerprint text NOT NULL,
  control_key text NOT NULL,
  consent_purpose text,
  status text NOT NULL,
  refusal text,
  delivery_reference text,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriber_retention_intents_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT subscriber_retention_intents_idempotency_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT subscriber_retention_intents_source_reference_check
    CHECK (source_reference ~ '^(order|subscription):[a-f0-9-]{36}$'),
  CONSTRAINT subscriber_retention_intents_access_grant_reference_check
    CHECK (access_grant_reference IS NULL OR access_grant_reference ~ '^review-grant:[a-f0-9-]{36}$'),
  CONSTRAINT subscriber_retention_intents_dispatch_claim_reference_check
    CHECK (dispatch_claim_reference IS NULL OR dispatch_claim_reference ~ '^retention-claim:[a-f0-9-]{36}$'),
  CONSTRAINT subscriber_retention_intents_kind_check
    CHECK (kind IN ('paid_cycle_recap', 'reorder_reminder', 'review_request', 'review_effects', 'winback')),
  CONSTRAINT subscriber_retention_intents_template_reference_check
    CHECK (template_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT subscriber_retention_intents_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT subscriber_retention_intents_expected_revision_check CHECK (expected_revision >= 1),
  CONSTRAINT subscriber_retention_intents_recipient_fingerprint_check
    CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT subscriber_retention_intents_control_key_check
    CHECK (control_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT subscriber_retention_intents_consent_purpose_check
    CHECK (consent_purpose IS NULL OR (btrim(consent_purpose) <> '' AND char_length(consent_purpose) <= 120)),
  CONSTRAINT subscriber_retention_intents_status_check
    CHECK (status IN ('planned', 'dispatching', 'accepted', 'failed', 'refused')),
  CONSTRAINT subscriber_retention_intents_refusal_check
    CHECK (refusal IS NULL OR refusal IN (
      'control_disabled', 'consent_missing', 'stale_revision',
      'subscription_state_ineligible', 'review_request_not_accepted',
      'source_kind_ineligible', 'source_not_found', 'source_subject_mismatch',
      'source_subscription_mismatch', 'authorization_contract_invalid',
      'source_ineligible', 'idempotency_contract_invalid',
      'source_kind_already_planned',
      'access_grant_unavailable', 'delivery_failed'
    )),
  CONSTRAINT subscriber_retention_intents_delivery_reference_check
    CHECK (delivery_reference IS NULL OR delivery_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT subscriber_retention_intents_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT subscriber_retention_intents_state_shape_check CHECK (
    (status = 'refused') = (refusal IS NOT NULL AND refusal <> 'delivery_failed')
    AND (status = 'failed') = (refusal = 'delivery_failed')
    AND (status = 'accepted') = (delivery_reference IS NOT NULL)
    AND (status <> 'planned' OR attempt_count = 0)
    AND (status = 'dispatching') = (
      dispatch_claim_reference IS NOT NULL AND dispatch_claim_expires_at IS NOT NULL
    )
    AND (status = 'refused' OR (
      (kind IN ('review_request', 'review_effects')) = (access_grant_reference IS NOT NULL)
    ))
  ),
  CONSTRAINT subscriber_retention_intents_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX subscriber_retention_intents_subject_created_idx
  ON public.subscriber_retention_intents(subject_reference, created_at DESC);
CREATE INDEX subscriber_retention_intents_reconciliation_idx
  ON public.subscriber_retention_intents(updated_at)
  WHERE status IN ('planned', 'failed');

CREATE TABLE public.subscriber_review_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  grant_reference text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT subscriber_review_access_grants_reference_check
    CHECK (grant_reference ~ '^review-grant:[a-f0-9-]{36}$'),
  CONSTRAINT subscriber_review_access_grants_kind_check
    CHECK (kind IN ('review_request', 'review_effects')),
  CONSTRAINT subscriber_review_access_grants_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT subscriber_review_access_grants_revocation_check
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

ALTER TABLE public.subscriber_review_access_grants
  ADD CONSTRAINT subscriber_review_access_grants_order_kind_key UNIQUE (order_id, kind);
ALTER TABLE public.subscriber_retention_intents
  ADD CONSTRAINT subscriber_retention_intents_access_grant_reference_fkey
  FOREIGN KEY (access_grant_reference)
  REFERENCES public.subscriber_review_access_grants(grant_reference) ON DELETE RESTRICT;

CREATE TABLE public.subscriber_retention_activation_watermarks (
  kind text PRIMARY KEY,
  activated_at timestamptz NOT NULL,
  CONSTRAINT subscriber_retention_activation_watermarks_kind_check
    CHECK (kind = 'paid_cycle_recap')
);
INSERT INTO public.subscriber_retention_activation_watermarks(kind, activated_at)
VALUES ('paid_cycle_recap', now());

COMMENT ON TABLE public.subscriber_profiles IS
  'Neutral subject display facts and capability revision; no rendered copy or provider data.';
COMMENT ON TABLE public.subscriber_retention_intents IS
  'Authorization and delivery-receipt ledger; delivery remains in the Communications rail.';
COMMENT ON COLUMN public.subscriber_retention_intents.recipient_fingerprint IS
  'Opaque recipient fingerprint used only to resolve durable consent.';
COMMENT ON TABLE public.subscriber_review_access_grants IS
  'One opaque review access grant per order; C-D20 issues it with the review intent.';

REVOKE ALL ON TABLE
  public.subscriber_profiles,
  public.subscriber_retention_intents,
  public.subscriber_review_access_grants,
  public.subscriber_retention_activation_watermarks
FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.subscriber_profile_upsert(
  p_subject_reference text,
  p_display_name text,
  p_locale text,
  p_revision integer,
  p_display_facts jsonb,
  p_capabilities text[],
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_prior public.subscriber_profiles%ROWTYPE;
BEGIN
  IF p_subject_reference IS NULL
     OR p_subject_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_revision IS NULL OR p_revision < 1
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_display_facts IS NULL OR jsonb_typeof(p_display_facts) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_display_facts) AS fact
       WHERE jsonb_typeof(fact.value) <> 'string'
          OR char_length(fact.key) > 120
          OR char_length(fact.value #>> '{}') > 240
     )
     OR EXISTS (
       SELECT 1 FROM unnest(COALESCE(p_capabilities, ARRAY[]::text[])) AS capability
       WHERE capability !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     ) THEN
    RAISE EXCEPTION 'subscriber_profile_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_subject_reference, 0));
  SELECT * INTO v_prior FROM public.subscriber_profiles
  WHERE subject_reference = p_subject_reference FOR UPDATE;

  IF FOUND THEN
    IF v_prior.fingerprint = p_fingerprint THEN
      RETURN jsonb_build_object('replayed', true);
    END IF;
    IF p_revision <= v_prior.revision THEN
      RAISE EXCEPTION 'subscriber_profile_stale_revision' USING ERRCODE = '40001';
    END IF;
    UPDATE public.subscriber_profiles SET
      display_name = p_display_name,
      locale = p_locale,
      revision = p_revision,
      display_facts = p_display_facts,
      capabilities = COALESCE(p_capabilities, ARRAY[]::text[]),
      fingerprint = p_fingerprint,
      updated_at = now()
    WHERE subject_reference = p_subject_reference;
    RETURN jsonb_build_object('replayed', false);
  END IF;

  INSERT INTO public.subscriber_profiles(
    subject_reference, display_name, locale, revision,
    display_facts, capabilities, fingerprint
  ) VALUES (
    p_subject_reference, p_display_name, p_locale, p_revision,
    p_display_facts, COALESCE(p_capabilities, ARRAY[]::text[]), p_fingerprint
  );
  RETURN jsonb_build_object('replayed', false);
END;
$$;

CREATE FUNCTION public.subscriber_profile_read(p_subject_reference text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'subjectReference', profile.subject_reference,
    'displayName', profile.display_name,
    'locale', profile.locale,
    'revision', profile.revision,
    'displayFacts', profile.display_facts,
    'capabilities', to_jsonb(profile.capabilities)
  )
  FROM public.subscriber_profiles AS profile
  WHERE profile.subject_reference = p_subject_reference;
$$;

CREATE FUNCTION public.subscriber_retention_intent_result(
  p_intent_id uuid,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'intentId', intent.id,
    'idempotencyKey', intent.idempotency_key,
    'subjectReference', intent.subject_reference,
    'subscriptionId', intent.subscription_id,
    'sourceReference', intent.source_reference,
    'accessGrantReference', intent.access_grant_reference,
    'dispatchClaimReference', intent.dispatch_claim_reference,
    'kind', intent.kind,
    'templateReference', intent.template_reference,
    'fingerprint', intent.fingerprint,
    'status', intent.status,
    'refusal', intent.refusal,
    'deliveryReference', intent.delivery_reference,
    'attemptCount', intent.attempt_count,
    'replayed', p_replayed
  )
  FROM public.subscriber_retention_intents AS intent
  WHERE intent.id = p_intent_id;
$$;

-- Resolve the canonical subject directly from the durable source. Both create
-- and claim use this function so legacy/planned retries cannot cross clients.
CREATE FUNCTION public.subscriber_retention_source_refusal(
  p_kind text,
  p_source_reference text,
  p_subject_reference text,
  p_recipient_fingerprint text,
  p_subscription_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_client_id uuid;
  v_recipient_fingerprint text;
  v_source_subscription_id uuid;
BEGIN
  IF (p_kind = 'winback' AND p_source_reference !~ '^subscription:[a-f0-9-]{36}$')
     OR (p_kind <> 'winback' AND p_source_reference !~ '^order:[a-f0-9-]{36}$') THEN
    RETURN 'source_kind_ineligible';
  END IF;

  IF p_kind = 'winback' THEN
    SELECT subscription.client_id, subscription.id,
           encode(sha256(convert_to(lower(btrim(client.email)), 'UTF8')), 'hex')
    INTO v_client_id, v_source_subscription_id, v_recipient_fingerprint
    FROM public.subscriptions AS subscription
    JOIN public.clients AS client ON client.id = subscription.client_id
    WHERE subscription.id = split_part(p_source_reference, ':', 2)::uuid;
  ELSE
    SELECT orders.client_id, cycle.subscription_id,
           encode(sha256(convert_to(lower(btrim(client.email)), 'UTF8')), 'hex')
    INTO v_client_id, v_source_subscription_id, v_recipient_fingerprint
    FROM public.commerce_orders AS orders
    JOIN public.clients AS client ON client.id = orders.client_id
    LEFT JOIN public.subscription_cycles AS cycle ON cycle.id = orders.subscription_cycle_id
    WHERE orders.id = split_part(p_source_reference, ':', 2)::uuid;
  END IF;

  IF v_client_id IS NULL THEN RETURN 'source_not_found'; END IF;
  IF p_subject_reference <> 'client:' || v_client_id::text
     OR p_recipient_fingerprint <> v_recipient_fingerprint THEN
    RETURN 'source_subject_mismatch';
  END IF;
  IF p_subscription_id IS DISTINCT FROM v_source_subscription_id THEN
    RETURN 'source_subscription_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.subscriber_retention_contract_refusal(
  p_kind text,
  p_template_reference text,
  p_control_key text,
  p_consent_purpose text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN p_control_key <> 'subscriber-retention'
    OR p_template_reference <> CASE p_kind
      WHEN 'paid_cycle_recap' THEN 'subscriber-paid-cycle-recap-v1'
      WHEN 'reorder_reminder' THEN 'subscriber-reorder-reminder-v1'
      WHEN 'review_request' THEN 'subscriber-review-request-v1'
      WHEN 'review_effects' THEN 'subscriber-review-effects-v1'
      WHEN 'winback' THEN 'subscriber-winback-v1'
    END
    OR p_consent_purpose IS DISTINCT FROM CASE p_kind
      WHEN 'paid_cycle_recap' THEN NULL ELSE 'retention_marketing'
    END
  THEN 'authorization_contract_invalid' END;
$$;

CREATE FUNCTION public.subscriber_retention_idempotency_refusal(
  p_kind text,
  p_source_reference text,
  p_idempotency_key text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_expected text;
BEGIN
  v_expected := CASE p_kind
    WHEN 'paid_cycle_recap' THEN 'retention.paid_cycle_recap.' || split_part(p_source_reference, ':', 2)
    WHEN 'reorder_reminder' THEN 'retention.reorder_reminder.' || split_part(p_source_reference, ':', 2)
    WHEN 'review_request' THEN 'retention.review_request.' || split_part(p_source_reference, ':', 2)
    WHEN 'review_effects' THEN 'retention.review_effects.' || split_part(p_source_reference, ':', 2)
    WHEN 'winback' THEN (
      SELECT 'retention.winback.' || subscription.id::text || '.'
        || extract(epoch FROM subscription.ended_at)::bigint::text
      FROM public.subscriptions AS subscription
      WHERE subscription.id = split_part(p_source_reference, ':', 2)::uuid
    )
  END;
  IF p_idempotency_key IS DISTINCT FROM v_expected THEN
    RETURN 'idempotency_contract_invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.subscriber_retention_eligibility_refusal(
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
  v_source_id uuid := split_part(p_source_reference, ':', 2)::uuid;
  v_eligible boolean := false;
BEGIN
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
          WHEN 'review_request' THEN interval '3 days' ELSE interval '21 days' END
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
        AND subscription.ended_at > p_now - interval '120 days'
        AND EXISTS (SELECT 1 FROM public.subscription_events AS event
          WHERE event.subscription_id = subscription.id
            AND event.event_type = 'subscription.customer_self_service.cancel'
            AND event.occurred_at >= subscription.ended_at)
    ) INTO v_eligible;
  END IF;
  IF NOT v_eligible THEN RETURN 'source_ineligible'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.subscriber_retention_create_intent(
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

  IF v_refusal IS NULL AND p_consent_purpose IS NOT NULL AND NOT EXISTS (
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

CREATE FUNCTION public.subscriber_retention_claim_intent(
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
  IF v_refusal IS NULL AND v_intent.consent_purpose IS NOT NULL AND NOT EXISTS (
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

CREATE FUNCTION public.subscriber_retention_record_delivery(
  p_idempotency_key text,
  p_fingerprint text,
  p_state text,
  p_delivery_reference text,
  p_attempt_count integer,
  p_claim_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent public.subscriber_retention_intents%ROWTYPE;
BEGIN
  IF p_state NOT IN ('accepted', 'failed')
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_claim_reference IS NULL OR p_claim_reference !~ '^retention-claim:[a-f0-9-]{36}$'
     OR p_attempt_count IS NULL OR p_attempt_count < 1
     OR (p_state = 'accepted' AND (
       p_delivery_reference IS NULL
       OR p_delivery_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     ))
     OR (p_state = 'failed' AND p_delivery_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'subscriber_retention_delivery_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_intent FROM public.subscriber_retention_intents
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscriber_retention_intent_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_intent.fingerprint <> p_fingerprint THEN
    RAISE EXCEPTION 'subscriber_retention_intent_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_intent.status = 'refused' THEN
    RETURN public.subscriber_retention_intent_result(v_intent.id, true);
  END IF;
  IF v_intent.status = 'accepted' THEN
    IF p_state <> 'accepted' OR v_intent.delivery_reference <> p_delivery_reference THEN
      RAISE EXCEPTION 'subscriber_retention_delivery_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.subscriber_retention_intent_result(v_intent.id, true);
  END IF;
  IF v_intent.status <> 'dispatching' THEN
    RAISE EXCEPTION 'subscriber_retention_delivery_unclaimed' USING ERRCODE = '55000';
  END IF;
  IF v_intent.dispatch_claim_reference <> p_claim_reference THEN
    RAISE EXCEPTION 'subscriber_retention_delivery_claim_conflict' USING ERRCODE = '23505';
  END IF;

  UPDATE public.subscriber_retention_intents SET
    status = p_state,
    refusal = CASE WHEN p_state = 'failed' THEN 'delivery_failed' ELSE NULL END,
    delivery_reference = p_delivery_reference,
    attempt_count = p_attempt_count,
    dispatch_claim_reference = NULL,
    dispatch_claim_expires_at = NULL,
    updated_at = now()
  WHERE id = v_intent.id;
  RETURN public.subscriber_retention_intent_result(v_intent.id, false);
END;
$$;

CREATE FUNCTION public.subscriber_retention_read_intent(p_intent_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.subscriber_retention_intent_result(p_intent_id, true);
$$;

-- Mounted production roots call this producer before consuming pending work.
-- It derives neutral profiles and idempotent intents from canonical platform
-- state; review requests also mint the one opaque access grant owned by the
-- selected order. No proof-only seed or provider schema participates.
CREATE FUNCTION public.subscriber_retention_plan_due(
  p_kind text,
  p_limit integer DEFAULT 100,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
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
        AND shipment.delivered_at <= p_now - interval '21 days'
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
        AND subscription.ended_at > p_now - interval '120 days'
        AND EXISTS (
          SELECT 1 FROM public.subscription_events AS event
          WHERE event.subscription_id = subscription.id
            AND event.event_type = 'subscription.customer_self_service.cancel'
            AND event.occurred_at >= subscription.ended_at
        )
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

-- Production workers consume only durable, already-authorized intents. The
-- transactional delivery rail owns send idempotency; record_delivery locks the
-- intent again, so concurrent workers converge on the same receipt.
CREATE FUNCTION public.subscriber_retention_list_pending(
  p_kind text,
  p_limit integer DEFAULT 100,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row record;
  v_claimed jsonb;
  v_result jsonb := '[]'::jsonb;
BEGIN
  IF p_kind NOT IN ('paid_cycle_recap', 'reorder_reminder', 'review_request', 'review_effects', 'winback') THEN
    RAISE EXCEPTION 'subscriber_retention_plan_kind_invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN
    SELECT candidate.idempotency_key, candidate.fingerprint
    FROM public.subscriber_retention_intents AS candidate
    WHERE candidate.kind = p_kind
      AND (candidate.status IN ('planned', 'failed')
        OR (candidate.status = 'dispatching' AND candidate.dispatch_claim_expires_at <= p_now))
    ORDER BY candidate.created_at, candidate.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_claimed := public.subscriber_retention_claim_intent(
      v_row.idempotency_key, v_row.fingerprint, p_now
    );
    IF v_claimed IS NOT NULL THEN
      v_result := v_result || jsonb_build_array(v_claimed);
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

-- Resume expired finite pauses through the existing lifecycle owner. The
-- deterministic pause-window key makes a crash-safe replay land on that
-- owner's subscription_events ledger instead of applying a second transition.
CREATE FUNCTION public.subscription_auto_resume_due(
  p_limit integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row record;
  v_scanned integer := 0;
  v_resumed integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
BEGIN
  FOR v_row IN
    SELECT subscription.id AS subscription_id,
           subscription.client_id,
           pause_window.id AS pause_window_id
    FROM public.subscription_pause_windows AS pause_window
    JOIN public.subscriptions AS subscription
      ON subscription.id = pause_window.subscription_id
    WHERE subscription.status = 'paused'
      AND pause_window.resumed_at IS NULL
      AND pause_window.ends_at IS NOT NULL
      AND pause_window.ends_at <= p_now
    ORDER BY pause_window.ends_at, pause_window.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
    FOR UPDATE OF subscription, pause_window SKIP LOCKED
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      PERFORM public.subscription_apply_lifecycle_action(
        v_row.client_id,
        'auto-resume:' || v_row.pause_window_id::text,
        v_row.subscription_id,
        'resume',
        '{}'::jsonb,
        p_now
      );
      v_resumed := v_resumed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_failed = 0,
    'scanned', v_scanned,
    'resumed', v_resumed,
    'skippedRows', v_skipped,
    'failed', v_failed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.subscriber_profile_upsert(text,text,text,integer,jsonb,text[],text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_profile_read(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_intent_result(uuid,boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_source_refusal(text,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_contract_refusal(text,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_idempotency_refusal(text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_eligibility_refusal(text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_create_intent(text,text,uuid,text,text,text,text,integer,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_claim_intent(text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_record_delivery(text,text,text,text,integer,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_read_intent(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_plan_due(text,integer,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscriber_retention_list_pending(text,integer,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_auto_resume_due(integer,timestamptz)
  FROM PUBLIC, anon, authenticated;
