-- Opt-in account choices, retained renewal terms and three absorption classifications.
-- Account choices derive their actor from auth.uid(); existing newsletter routines stay unchanged.
-- Consent preferences/events and purchase attachments have no runtime/browser table grants.
-- Bounded definers retain those boundaries: renewal registration/reading is service-only,
-- while account calls still verify principal ownership and effective suppression.
-- The renewal writer seals delivery/acquisition terms and canonical authorization instants.
-- Graduation and effective order/shipping projection use existing privileges in TS transactions;
-- no schedule advance, payment dispatch, runtime table grant or additional phase table is added.
-- The three absorption INSERTs classify only their named tables; earlier-row policy/access
-- integration stays with those rows. New functions pin pg_catalog, pg_temp and revoke PUBLIC.
CREATE TABLE public.customer_account_consent_sync_targets (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  binding text NOT NULL CHECK (length(binding) BETWEEN 1 AND 256 AND NOT (btrim(binding) = '')),
  provider_kind text NOT NULL CHECK (length(provider_kind) BETWEEN 1 AND 256 AND NOT (btrim(provider_kind) = '')),
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.customer_account_consent_events (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  client_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  recipient_fingerprint text NOT NULL CHECK (char_length(recipient_fingerprint) = 64),
  purpose text NOT NULL CHECK (purpose IN ('marketing_newsletter','marketing_gifts_discounts')),
  requested_consent boolean NOT NULL,
  effective_state text NOT NULL CHECK (effective_state IN ('granted','denied','suppressed')),
  source text NOT NULL CHECK (source = 'customer_communication_preferences'),
  reason text NOT NULL CHECK (reason IN ('customer_self_service_grant','customer_self_service_denial')),
  consent_copy_version text NOT NULL CHECK (consent_copy_version IN ('customer_account_marketing_newsletter.v1','customer_account_marketing_gifts_discounts.v1')),
  source_ref jsonb NOT NULL CHECK (jsonb_typeof(source_ref) = 'object'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  captured_at timestamptz NOT NULL,
  consent_captured_at timestamptz NOT NULL,
  consent_updated_at timestamptz NOT NULL,
  work_id uuid UNIQUE REFERENCES public.outbox_events(id),
  CONSTRAINT customer_account_consent_events_request_key UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX customer_account_consent_events_recipient_idx
  ON public.customer_account_consent_events (recipient_fingerprint, purpose, captured_at DESC, id DESC);
ALTER TABLE public.customer_account_consent_sync_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_account_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT communication_native_sync_state_purpose_check;
ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT communication_native_sync_state_purpose_check CHECK (purpose IN ('marketing_launch_offer','marketing_newsletter','marketing_gifts_discounts'));

CREATE FUNCTION public.customer_account_communication_choices_as_actor(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_principal uuid := auth.uid();
  v_email text;
  v_fingerprint text;
  v_choices jsonb;
BEGIN
  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'account_consent_actor_required' USING ERRCODE = '42501';
  END IF;
  SELECT lower(btrim(c.email, E'\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'))
    INTO v_email FROM public.clients c WHERE c.id = p_client_id AND c.principal_id = v_principal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_consent_client_not_owned' USING ERRCODE = '42501';
  END IF;
  IF v_email IS NULL THEN RETURN NULL; END IF;
  v_fingerprint := encode(sha256(convert_to(v_email, 'UTF8')), 'hex');
  SELECT jsonb_object_agg(p.key, jsonb_build_object(
    'purpose', p.purpose, 'state', coalesce(c.state, 'unknown'),
    'granted', coalesce(c.state = 'granted', false),
    'source', e.source, 'reason', e.reason, 'consentCopyVersion', e.consent_copy_version,
    'capturedAt', c.captured_at, 'updatedAt', c.updated_at)) INTO v_choices
  FROM (VALUES ('marketingNewsletter','marketing_newsletter'),
               ('marketingGiftsDiscounts','marketing_gifts_discounts')) p(key,purpose)
  LEFT JOIN public.communication_recipient_consents c
    ON c.recipient_fingerprint = v_fingerprint AND c.purpose = p.purpose
  LEFT JOIN LATERAL (
    SELECT event.source, event.reason, event.consent_copy_version
    FROM public.customer_account_consent_events event
    WHERE event.client_id = p_client_id AND event.principal_id = v_principal
      AND (event.recipient_fingerprint = v_fingerprint OR event.metadata->'recipientFingerprints' ? v_fingerprint)
      AND event.purpose = p.purpose
      AND event.effective_state = c.state AND event.effective_state <> 'suppressed'
      AND event.consent_captured_at = c.captured_at
      AND event.consent_updated_at = c.updated_at
    ORDER BY event.captured_at DESC, event.id DESC LIMIT 1
  ) e ON true;
  RETURN jsonb_build_object('contractVersion', 'customer.account_communication_choices.v1',
    'contact', CASE WHEN EXISTS (SELECT 1 FROM public.communication_recipient_consents
      WHERE recipient_fingerprint = v_fingerprint AND purpose IN ('marketing_newsletter','marketing_gifts_discounts'))
      THEN jsonb_build_object('contactId', v_fingerprint, 'email', v_email) ELSE NULL END) || v_choices;
END;
$$;

CREATE FUNCTION public.customer_account_communication_choice_set_as_actor(
  p_client_id uuid, p_purpose text, p_consent boolean, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_principal uuid := auth.uid();
  v_email text;
  v_raw_email text;
  v_fingerprint text;
  v_previous public.customer_account_consent_events%ROWTYPE;
  v_target public.customer_account_consent_sync_targets%ROWTYPE;
  v_consent public.communication_recipient_consents%ROWTYPE;
  v_event_id uuid := gen_random_uuid();
  v_work_id uuid;
  v_email_usable boolean;
  v_sync boolean;
  v_deferred_reason text;
  v_recipients text[];
  v_recipient text;
  v_at timestamptz;
  v_revision integer;
  v_state text;
  v_event_kind text;
  v_source_ref jsonb;
  v_payload jsonb;
  v_aggregate uuid;
BEGIN
  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'account_consent_actor_required' USING ERRCODE = '42501';
  END IF;
  -- Non-key client lock fences ownership/email changes and serializes keys,
  -- while allowing money/parcel foreign-key key-share locks.
  SELECT c.email INTO v_raw_email FROM public.clients c
    WHERE c.id = p_client_id AND c.principal_id = v_principal FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_consent_client_not_owned' USING ERRCODE = '42501';
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('marketing_newsletter','marketing_gifts_discounts')
    OR p_consent IS NULL OR p_idempotency_key IS NULL
    OR length(p_idempotency_key) NOT BETWEEN 1 AND 256 OR btrim(p_idempotency_key) = ''
    OR p_idempotency_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'account_consent_invalid_input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_previous FROM public.customer_account_consent_events
    WHERE principal_id = v_principal AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_previous.client_id <> p_client_id OR v_previous.purpose <> p_purpose
      OR v_previous.requested_consent <> p_consent THEN
      RAISE EXCEPTION 'account_consent_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('contractVersion', 'customer.account_communication_choice_result.v1',
      'permissionEventId', v_previous.id, 'workId', v_previous.work_id, 'replayed', true,
      'choices', public.customer_account_communication_choices_as_actor(p_client_id));
  END IF;
  v_email := lower(btrim(v_raw_email, E'\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'));
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'account_consent_email_invalid' USING ERRCODE = '22023';
  END IF;
  v_email_usable := NOT (length(v_raw_email) > 320 OR v_raw_email ~ '[[:cntrl:]]'
    OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR v_email ~ E'[\u00a0\ufeff]');
  IF p_consent AND NOT v_email_usable THEN
    RAISE EXCEPTION 'account_consent_email_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM public.customer_account_consent_sync_targets
    WHERE singleton AND enabled FOR SHARE;
  v_sync := coalesce(FOUND AND v_email_usable AND v_target.binding !~ '[[:cntrl:]]'
    AND v_target.provider_kind !~ '[[:cntrl:]]', false);
  IF p_consent AND NOT v_sync THEN
    RAISE EXCEPTION 'account_consent_sync_target_unavailable' USING ERRCODE = '55000';
  END IF;
  v_deferred_reason := CASE WHEN NOT v_email_usable THEN 'email_invalid'
    WHEN NOT v_sync THEN 'target_unavailable' END;
  v_fingerprint := encode(sha256(convert_to(v_email, 'UTF8')), 'hex');
  -- An odd current address must not resurrect an earlier account grant on correction.
  SELECT array_agg(recipient ORDER BY recipient) INTO v_recipients FROM (
    SELECT v_fingerprint AS recipient UNION
    SELECT e.recipient_fingerprint FROM public.customer_account_consent_events e
      WHERE NOT p_consent AND NOT v_email_usable AND e.principal_id = v_principal
        AND e.client_id = p_client_id AND e.purpose = p_purpose
  ) recipients;
  -- Existing registerPreference lock keys, in deterministic recipient order.
  FOREACH v_recipient IN ARRAY v_recipients LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(v_recipient), to_json(p_purpose)), 0));
  END LOOP;
  v_at := clock_timestamp();
  v_state := CASE WHEN p_consent THEN 'granted' ELSE 'denied' END;
  -- Preserve the served setter's preference -> evaluator row lock order.
  IF p_purpose = 'marketing_newsletter' THEN
    INSERT INTO public.customer_communication_preferences AS preference
      (principal_id, marketing_newsletter_consent, revision, updated_at)
    VALUES (v_principal, p_consent, 1, v_at)
    ON CONFLICT (principal_id) DO UPDATE
      SET marketing_newsletter_consent = excluded.marketing_newsletter_consent,
          revision = preference.revision + CASE WHEN preference.marketing_newsletter_consent IS DISTINCT FROM p_consent THEN 1 ELSE 0 END,
          updated_at = CASE WHEN preference.marketing_newsletter_consent IS DISTINCT FROM p_consent THEN v_at ELSE preference.updated_at END
    RETURNING revision INTO v_revision;
    INSERT INTO public.customer_communication_preference_events
      (principal_id, revision, marketing_newsletter_consent, occurred_at)
    VALUES (v_principal, v_revision, p_consent, v_at)
    ON CONFLICT (principal_id, revision) DO NOTHING;
  END IF;
  -- Preserve suppression for the current and every affected historical recipient.
  FOREACH v_recipient IN ARRAY v_recipients LOOP
    INSERT INTO public.communication_recipient_consents AS consent
      (recipient_fingerprint, purpose, state, captured_at, updated_at)
    VALUES (v_recipient, p_purpose, v_state, v_at, v_at)
    ON CONFLICT (recipient_fingerprint, purpose) DO UPDATE
      SET state = CASE WHEN consent.state = 'suppressed' THEN consent.state ELSE excluded.state END,
          captured_at = CASE WHEN consent.state = 'suppressed' THEN consent.captured_at ELSE excluded.captured_at END,
          updated_at = CASE WHEN consent.state = 'suppressed' THEN consent.updated_at ELSE greatest(consent.updated_at, excluded.updated_at) END;
  END LOOP;
  SELECT * INTO v_consent FROM public.communication_recipient_consents
    WHERE recipient_fingerprint = v_fingerprint AND purpose = p_purpose;
  v_event_kind := CASE v_consent.state WHEN 'granted' THEN 'subscribe' WHEN 'denied' THEN 'unsubscribe' ELSE 'suppress' END;
  v_source_ref := jsonb_build_object('route', '/api/bff/customers/communication-preferences', 'clientId', p_client_id);
  v_payload := jsonb_build_object('permissionEventId', v_event_id, 'state', v_consent.state,
    'source', 'customer_communication_preferences', 'sourceRef', v_source_ref);
  IF v_sync THEN
    BEGIN
      v_work_id := gen_random_uuid();
      -- Same per-contact/target aggregate as nativeSyncRegistration; sole existing outbox rail.
      v_aggregate := substr(encode(sha256(convert_to(format('[%s,%s,%s]',
        to_json(v_target.binding), to_json(v_target.provider_kind), to_json(v_fingerprint)), 'UTF8')), 'hex'), 1, 32)::uuid;
      INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload)
      VALUES (v_work_id, 'communication_native_sync', v_aggregate,
        'communication.native.sync.' || encode(sha256(convert_to(v_target.binding, 'UTF8')), 'hex'),
        'account-consent:' || v_event_id::text, v_payload);
      INSERT INTO public.communication_native_sync_state
        (work_id, binding, provider_kind, contact_id, normalized_email, purpose, event_kind, command_fingerprint)
      VALUES (v_work_id, v_target.binding, v_target.provider_kind, v_fingerprint, v_email, p_purpose, v_event_kind,
        encode(sha256(convert_to(jsonb_build_object('binding', v_target.binding, 'provider', v_target.provider_kind,
          'recipient', v_fingerprint, 'purpose', p_purpose, 'payload', v_payload)::text, 'UTF8')), 'hex'));
    EXCEPTION WHEN OTHERS THEN
      IF p_consent THEN RAISE; END IF;
      v_work_id := NULL;
      v_deferred_reason := 'registration_failed';
    END;
  END IF;
  INSERT INTO public.customer_account_consent_events
    (id, principal_id, client_id, idempotency_key, recipient_fingerprint, purpose, requested_consent,
     effective_state, source, reason, consent_copy_version, source_ref, metadata, captured_at,
     consent_captured_at, consent_updated_at, work_id)
  VALUES (v_event_id, v_principal, p_client_id, p_idempotency_key, v_fingerprint, p_purpose, p_consent,
    v_consent.state, 'customer_communication_preferences',
    CASE WHEN p_consent THEN 'customer_self_service_grant' ELSE 'customer_self_service_denial' END,
    'customer_account_' || p_purpose || '.v1', v_source_ref,
    jsonb_build_object('actorType', 'customer_self_service', 'captureMethod', 'customer_account',
      'syncDeferredReason', v_deferred_reason, 'recipientFingerprints', to_jsonb(v_recipients)),
    v_at, v_consent.captured_at, v_consent.updated_at, v_work_id);
  RETURN jsonb_build_object('contractVersion', 'customer.account_communication_choice_result.v1',
    'permissionEventId', v_event_id, 'workId', v_work_id, 'replayed', false,
    'choices', public.customer_account_communication_choices_as_actor(p_client_id));
END;
$$;
CREATE FUNCTION public.subscription_register_renewal_purchase_with_shipping(p_order_id uuid, p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_line jsonb; v_key text;
  v_activation public.subscription_activations; v_order public.commerce_orders;
  v_terms jsonb; v_shipping jsonb; v_marker jsonb; v_delivery jsonb; v_graduation jsonb;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_renewal_purchase_order_missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_activation.state='compensated' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_not_declared' USING ERRCODE='22023'; END IF;
  IF p_facts IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR p_facts - ARRAY['settlementChannelKey','authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef',
      'methodRef','methodEvidenceRef','stockSourceKey','templateId','cadenceDays','currency',
      'lines','shippingAmountMinor','acquisitionRef','renewalTerms'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['settlementChannelKey','authorizationRef','methodRef','methodEvidenceRef','stockSourceKey','templateId'] LOOP
    IF jsonb_typeof(p_facts->v_key) IS DISTINCT FROM 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  -- This writer does not create a real mandate. Native real-PSP setup remains unavailable.
  IF p_facts->>'settlementChannelKey' IS DISTINCT FROM 'sandbox' OR p_facts->>'stockSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_facts->>'currency' !~ '^[A-Z]{3}$' OR p_facts->>'currency' IS NULL
    OR NOT coalesce(p_facts->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
    OR jsonb_typeof(p_facts->'cadenceDays') IS DISTINCT FROM 'number'
    OR (p_facts->>'cadenceDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
    OR NOT coalesce(p_facts->>'shippingAmountMinor' ~ '^[0-9]+$',false)
    OR jsonb_typeof(p_facts->'shippingAmountMinor') IS DISTINCT FROM 'number'
    OR (p_facts->>'shippingAmountMinor')::numeric > 9007199254740991
    OR jsonb_typeof(p_facts->'unattendedChargeAuthorizedAt') IS DISTINCT FROM 'string'
    OR NOT isfinite((p_facts->>'unattendedChargeAuthorizedAt')::timestamptz)
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['payerAccountRef','acquisitionRef'] LOOP
    IF NOT (p_facts ? v_key) OR (p_facts->v_key <> 'null'::jsonb AND
      (jsonb_typeof(p_facts->v_key) <> 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180)) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(p_facts->'lines') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_facts->'lines') LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'] <> '{}'::jsonb
      OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
      OR NOT coalesce(v_line->>'lineOrdinal' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
      OR jsonb_typeof(v_line->'lineOrdinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number'
      OR (v_line->>'lineOrdinal')::numeric > 2147483647 OR (v_line->>'quantity')::numeric > 2147483647
      OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT count(DISTINCT (value->>'lineOrdinal')::integer) FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT sum((value->>'quantity')::numeric*(value->>'unitAmountMinor')::numeric) FROM jsonb_array_elements(p_facts->'lines')) NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  IF p_facts ? 'renewalTerms' THEN
    v_terms:=p_facts->'renewalTerms';
    IF jsonb_typeof(v_terms) IS DISTINCT FROM 'object' OR v_terms->>'version' IS DISTINCT FROM 'native.renewal-terms.v1'
      OR v_terms - ARRAY['version','shippingTerms','starterPack','minimumPayableMinor','normalCadenceDays','linePricing'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    IF v_terms ? 'shippingTerms' THEN
      v_shipping:=v_terms->'shippingTerms';
      IF jsonb_typeof(v_shipping) IS DISTINCT FROM 'object' OR v_shipping->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
        OR v_shipping->>'currency' IS DISTINCT FROM p_facts->>'currency'
        OR v_shipping - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOREACH v_key IN ARRAY ARRAY['flatMinor','freeThresholdMinor'] LOOP
        IF jsonb_typeof(v_shipping->v_key) IS DISTINCT FROM 'number' OR NOT coalesce(v_shipping->>v_key ~ '^[0-9]+$',false)
          OR (v_shipping->>v_key)::numeric > 2147483647 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
    IF v_terms ? 'minimumPayableMinor' AND (jsonb_typeof(v_terms->'minimumPayableMinor') IS DISTINCT FROM 'number'
      OR NOT coalesce(v_terms->>'minimumPayableMinor' ~ '^[1-9][0-9]*$',false)
      OR (v_terms->>'minimumPayableMinor')::numeric > 9007199254740991) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    IF v_terms ? 'normalCadenceDays' THEN
      IF jsonb_typeof(v_terms->'normalCadenceDays') IS DISTINCT FROM 'array' OR jsonb_array_length(v_terms->'normalCadenceDays')=0 THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_terms->'normalCadenceDays') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'number' OR NOT coalesce(v_line#>>'{}' ~ '^[1-9][0-9]*$',false)
          OR (v_line#>>'{}')::numeric > 2147483647 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
    IF v_terms ? 'linePricing' THEN
      IF jsonb_typeof(v_terms->'linePricing') IS DISTINCT FROM 'array' OR jsonb_array_length(v_terms->'linePricing')>100 THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_terms->'linePricing') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['sku','quantity','unitAmountMinor','isAddon','quoteLine'] <> '{}'::jsonb
          OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
          OR jsonb_typeof(v_line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_line->'quoteLine') IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
          OR (v_line->>'quantity')::numeric > 2147483647
          OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
          OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(v_terms->'linePricing')) <> jsonb_array_length(v_terms->'linePricing') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    END IF;
    IF v_terms ? 'starterPack' THEN
      v_marker:=v_terms->'starterPack';
      IF jsonb_typeof(v_marker) IS DISTINCT FROM 'object' OR v_marker->>'schemaVersion' IS DISTINCT FROM '1'
        OR v_marker - ARRAY['schemaVersion','starterIntervalDays','basisTemplateVersion','delivery2','graduation'] <> '{}'::jsonb
        OR jsonb_typeof(v_marker->'starterIntervalDays') IS DISTINCT FROM 'number'
        OR NOT coalesce(v_marker->>'starterIntervalDays' ~ '^[1-9][0-9]*$',false)
        OR (v_marker->>'starterIntervalDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
        OR NOT (v_terms ? 'minimumPayableMinor') OR NOT (v_terms ? 'normalCadenceDays') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      v_delivery:=v_marker->'delivery2';
      IF jsonb_typeof(v_delivery) IS DISTINCT FROM 'object' OR v_delivery - ARRAY['discountBps','discountMinor','basisSubtotalMinor'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOREACH v_key IN ARRAY ARRAY['discountBps','discountMinor','basisSubtotalMinor'] LOOP
        IF jsonb_typeof(v_delivery->v_key) IS DISTINCT FROM 'number' OR NOT coalesce(v_delivery->>v_key ~ '^[0-9]+$',false)
          OR (v_delivery->>v_key)::numeric > 9007199254740991 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF (v_delivery->>'discountBps')::numeric > 10000
        OR (v_delivery->>'basisSubtotalMinor')::numeric-(v_delivery->>'discountMinor')::numeric < (v_terms->>'minimumPayableMinor')::numeric THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      v_graduation:=v_marker->'graduation';
      IF jsonb_typeof(v_graduation) IS DISTINCT FROM 'object' OR v_graduation - ARRAY['cadenceDays','lines','sizeConstraint'] <> '{}'::jsonb
        OR jsonb_typeof(v_graduation->'cadenceDays') IS DISTINCT FROM 'number'
        OR NOT coalesce(v_graduation->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
        OR NOT (v_terms->'normalCadenceDays' @> jsonb_build_array(v_graduation->'cadenceDays'))
        OR jsonb_typeof(v_graduation->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_graduation->'lines') NOT BETWEEN 1 AND 100
        OR (v_graduation ? 'sizeConstraint' AND jsonb_typeof(v_graduation->'sizeConstraint') IS DISTINCT FROM 'object') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_graduation->'lines') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['sku','qty','sortOrder','isAddon','quoteLine'] <> '{}'::jsonb
          OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
          OR jsonb_typeof(v_line->'qty') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'qty' ~ '^[1-9][0-9]*$',false)
          OR (v_line->>'qty')::numeric > 99
          OR jsonb_typeof(v_line->'sortOrder') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'sortOrder' ~ '^[0-9]+$',false)
          OR jsonb_typeof(v_line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_line->'quoteLine') IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_line#>'{quoteLine,unitPriceGross,amountMinor}') IS DISTINCT FROM 'number'
          OR NOT coalesce(v_line#>>'{quoteLine,unitPriceGross,amountMinor}' ~ '^[0-9]+$',false)
          OR (v_line#>>'{quoteLine,unitPriceGross,amountMinor}')::numeric > 9007199254740991
          OR jsonb_typeof(v_line#>'{quoteLine,lineSubtotalGross,amountMinor}') IS DISTINCT FROM 'number'
          OR (v_line#>>'{quoteLine,lineSubtotalGross,amountMinor}')::numeric IS DISTINCT FROM
             (v_line#>>'{quoteLine,unitPriceGross,amountMinor}')::numeric*(v_line->>'qty')::numeric THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      -- The activation writer always creates the acquisition template at version one.
      p_facts:=jsonb_set(p_facts,'{renewalTerms,starterPack,basisTemplateVersion}','1'::jsonb);
    END IF;
  ELSIF (p_facts->>'shippingAmountMinor')::numeric <> 0 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023';
  END IF;
  p_facts:=jsonb_set(p_facts,'{unattendedChargeAuthorizedAt}',to_jsonb(to_char(
    (p_facts->>'unattendedChargeAuthorizedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND AND v_row.purchase_facts IS NOT NULL THEN
    IF jsonb_set(v_row.purchase_facts,'{unattendedChargeAuthorizedAt}',to_jsonb(to_char(
      (v_row.purchase_facts->>'unattendedChargeAuthorizedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) IS DISTINCT FROM p_facts THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',p_order_id,'replayed',true);
  END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts)
    VALUES(p_order_id,v_activation.subscription_id,p_facts)
    ON CONFLICT(order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts;
  RETURN jsonb_build_object('orderId',p_order_id,'replayed',false);
END; $$;

CREATE FUNCTION public.subscription_renewal_purchase_terms(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('templateId',purchase_facts->'templateId','shippingAmountMinor',purchase_facts->'shippingAmountMinor',
    'acquisitionRef',purchase_facts->'acquisitionRef') || CASE WHEN purchase_facts ? 'renewalTerms'
      THEN jsonb_build_object('renewalTerms',purchase_facts->'renewalTerms') ELSE '{}'::jsonb END
  FROM public.subscription_renewal_attachments WHERE subscription_id=p_subscription_id AND completed_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.customer_account_communication_choices_as_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_register_renewal_purchase_with_shipping(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_renewal_purchase_terms(uuid) FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_account_consent_sync_targets FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_account_consent_events FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.customer_account_consent_sync_targets, public.customer_account_consent_events FROM anon;';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.customer_account_consent_sync_targets, public.customer_account_consent_events FROM authenticated;';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.customer_account_consent_sync_targets, public.customer_account_consent_events FROM service_role;';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.customer_account_communication_choices_as_actor(uuid), public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text), public.subscription_register_renewal_purchase_with_shipping(uuid,jsonb), public.subscription_renewal_purchase_terms(uuid) FROM anon;';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_account_communication_choices_as_actor(uuid), public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text) TO authenticated;';
  END IF;
END; $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_account_communication_choices_as_actor(uuid), public.customer_account_communication_choice_set_as_actor(uuid,text,boolean,text), public.subscription_register_renewal_purchase_with_shipping(uuid,jsonb), public.subscription_renewal_purchase_terms(uuid) TO service_role;';
  END IF;
END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_register_renewal_purchase_with_shipping(uuid,jsonb), public.subscription_renewal_purchase_terms(uuid) FROM authenticated;'; END IF; END; $$;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_stock_wait_cases', 'block', 'A frozen subscription delivery is a commercial obligation bound to its original client; never carry or rebind it when absorbing a lead.');
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('identity_privacy_erasures', 'block', 'A privacy erasure is a legal process on one named record; absorption never moves or bypasses it.');
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_command_receipts', 'block', 'Subscription command receipts belong to the subscriptions they answer, which already block absorption; never carry or rebind them.');
