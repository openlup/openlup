-- Portable customer self-service recovery forward.
--
-- This delta closes the reference bundle's identity-issuance gap and connects
-- an authenticated customer to two portable recovery actions: communication
-- consent and repayment of their own still-open order through the existing
-- captured settlement rail. It stores challenge and recovery token hashes,
-- never raw credentials, message bodies, recipient addresses, provider
-- payloads or payment-method artifacts.
--
-- The application owns challenge delivery and ES256 signing. PostgreSQL owns
-- single consumption, principal linking, actor ownership, preference history,
-- order-token authority and settlement idempotency. The only direct payment
-- action is the already-published provider-neutral settlement; no gateway,
-- webhook, saved-card or provider-attempt record is fabricated here.
--
-- openlup:allow-security-definer: the three authenticated actor wrappers derive
-- the principal only from auth.uid() and expose fixed response shapes without
-- granting customer table DML.
-- openlup:allow-grant: authenticated receives EXECUTE only on the bounded
-- preference read/write and recovery-token issue wrappers.
-- openlup:allow-rls: preference state and events are actor-owned; tables remain
-- inaccessible and the wrappers are the only customer surface.

CREATE TABLE public.customer_identity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL,
  email_fingerprint text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_identity_challenges_email_fingerprint_check
    CHECK (email_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_identity_challenges_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_identity_challenges_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT customer_identity_challenges_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX customer_identity_challenges_client_created_idx
  ON public.customer_identity_challenges (client_id, created_at DESC);

CREATE TABLE public.customer_communication_preferences (
  principal_id uuid PRIMARY KEY,
  marketing_newsletter_consent boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_communication_preferences_revision_check CHECK (revision > 0)
);

CREATE TABLE public.customer_communication_preference_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL,
  revision integer NOT NULL,
  marketing_newsletter_consent boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_communication_preference_events_revision_check CHECK (revision > 0),
  CONSTRAINT customer_communication_preference_events_principal_revision_key
    UNIQUE (principal_id, revision)
);

CREATE TABLE public.commerce_checkout_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_checkout_recovery_tokens_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_checkout_recovery_tokens_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT commerce_checkout_recovery_tokens_token_hash_key UNIQUE (token_hash)
);

CREATE UNIQUE INDEX commerce_checkout_recovery_tokens_active_order_idx
  ON public.commerce_checkout_recovery_tokens (order_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.customer_communication_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_communication_preference_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.customer_identity_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_communication_preferences FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_communication_preference_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.commerce_checkout_recovery_tokens FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.customer_identity_challenge_issue(
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_client public.clients%ROWTYPE;
  v_principal_id uuid;
  v_challenge_id uuid;
  v_email text;
BEGIN
  v_email := lower(btrim(COALESCE(p_email, '')));
  IF char_length(v_email) < 3 OR char_length(v_email) > 320
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= p_now OR p_expires_at > p_now + interval '30 minutes' THEN
    RAISE EXCEPTION 'customer_identity_challenge_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_client FROM public.clients
   WHERE lower(email) = v_email
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deliverable', false);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_identity_challenges
     WHERE client_id = v_client.id AND created_at > p_now - interval '60 seconds'
  ) THEN
    RETURN jsonb_build_object('deliverable', false);
  END IF;

  v_principal_id := COALESCE(v_client.principal_id, gen_random_uuid());
  INSERT INTO public.customer_identity_challenges
    (client_id, principal_id, email_fingerprint, token_hash, expires_at, created_at)
  VALUES (
    v_client.id,
    v_principal_id,
    encode(sha256(convert_to(v_email, 'UTF8')), 'hex'),
    p_token_hash,
    p_expires_at,
    p_now
  )
  RETURNING id INTO v_challenge_id;

  RETURN jsonb_build_object('deliverable', true, 'challengeId', v_challenge_id);
END;
$$;

CREATE FUNCTION public.customer_identity_challenge_redeem(
  p_token_hash text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_challenge public.customer_identity_challenges%ROWTYPE;
  v_current_principal uuid;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;

  SELECT * INTO v_challenge FROM public.customer_identity_challenges
   WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_challenge.used_at IS NOT NULL OR v_challenge.expires_at <= p_now THEN
    RETURN NULL;
  END IF;

  SELECT principal_id INTO v_current_principal FROM public.clients
   WHERE id = v_challenge.client_id FOR UPDATE;
  IF v_current_principal IS NOT NULL AND v_current_principal <> v_challenge.principal_id THEN
    RAISE EXCEPTION 'customer_identity_principal_conflict' USING ERRCODE = '23505';
  END IF;

  UPDATE public.clients
     SET principal_id = v_challenge.principal_id, updated_at = p_now
   WHERE id = v_challenge.client_id;
  UPDATE public.customer_identity_challenges SET used_at = p_now WHERE id = v_challenge.id;
  RETURN jsonb_build_object(
    'principalId', v_challenge.principal_id,
    'email', lower((SELECT email FROM public.clients WHERE id = v_challenge.client_id)));
END;
$$;

CREATE FUNCTION public.customer_communication_preferences_as_actor()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
  SELECT CASE WHEN client.id IS NULL THEN NULL ELSE jsonb_build_object(
    'contractVersion', 'customer.communication_preferences.v1',
    'contact', jsonb_build_object('contactId', client.id, 'email', lower(client.email)),
    'marketingNewsletter', jsonb_build_object(
      'purpose', 'marketing_newsletter',
      'state', CASE
        WHEN preference.principal_id IS NULL THEN 'unknown'
        WHEN preference.marketing_newsletter_consent THEN 'granted'
        ELSE 'denied'
      END,
      'granted', COALESCE(preference.marketing_newsletter_consent, false),
      'source', CASE WHEN preference.principal_id IS NULL THEN NULL ELSE 'customer_communication_preferences' END,
      'reason', CASE
        WHEN preference.principal_id IS NULL THEN NULL
        WHEN preference.marketing_newsletter_consent THEN 'customer_self_service_grant'
        ELSE 'customer_self_service_denial'
      END,
      'capturedAt', preference.updated_at,
      'updatedAt', preference.updated_at)) END
  FROM (SELECT auth.uid() AS principal_id) actor
  LEFT JOIN public.clients client ON client.principal_id = actor.principal_id
  LEFT JOIN public.customer_communication_preferences preference
    ON preference.principal_id = actor.principal_id;
$$;

CREATE FUNCTION public.customer_communication_preferences_set_as_actor(
  p_marketing_newsletter_consent boolean,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
DECLARE
  v_principal_id uuid := auth.uid();
  v_revision integer;
BEGIN
  IF v_principal_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.clients WHERE principal_id = v_principal_id
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.customer_communication_preferences
    (principal_id, marketing_newsletter_consent, revision, updated_at)
  VALUES (v_principal_id, p_marketing_newsletter_consent, 1, p_now)
  ON CONFLICT (principal_id) DO UPDATE
    SET marketing_newsletter_consent = EXCLUDED.marketing_newsletter_consent,
        revision = CASE
          WHEN public.customer_communication_preferences.marketing_newsletter_consent
            IS DISTINCT FROM EXCLUDED.marketing_newsletter_consent
          THEN public.customer_communication_preferences.revision + 1
          ELSE public.customer_communication_preferences.revision
        END,
        updated_at = CASE
          WHEN public.customer_communication_preferences.marketing_newsletter_consent
            IS DISTINCT FROM EXCLUDED.marketing_newsletter_consent
          THEN EXCLUDED.updated_at
          ELSE public.customer_communication_preferences.updated_at
        END
  RETURNING revision INTO v_revision;

  INSERT INTO public.customer_communication_preference_events
    (principal_id, revision, marketing_newsletter_consent, occurred_at)
  VALUES (v_principal_id, v_revision, p_marketing_newsletter_consent, p_now)
  ON CONFLICT (principal_id, revision) DO NOTHING;

  RETURN public.customer_communication_preferences_as_actor();
END;
$$;

CREATE FUNCTION public.customer_checkout_recovery_token_issue_as_actor(
  p_order_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
DECLARE
  v_client_id uuid;
  v_token_id uuid;
BEGIN
  IF auth.uid() IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= p_now OR p_expires_at > p_now + interval '24 hours' THEN
    RAISE EXCEPTION 'customer_checkout_recovery_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT order_row.client_id INTO v_client_id
    FROM public.commerce_orders order_row
    JOIN public.clients client ON client.id = order_row.client_id
   WHERE order_row.id = p_order_id
     AND order_row.status = 'pending_payment'
     AND client.principal_id = auth.uid()
   FOR UPDATE OF order_row;
  IF NOT FOUND OR v_client_id IS NULL THEN
    RAISE EXCEPTION 'customer_checkout_recovery_order_not_recoverable' USING ERRCODE = '22023';
  END IF;

  UPDATE public.commerce_checkout_recovery_tokens
     SET revoked_at = p_now
   WHERE order_id = p_order_id AND revoked_at IS NULL;
  INSERT INTO public.commerce_checkout_recovery_tokens
    (order_id, client_id, token_hash, expires_at, created_at)
  VALUES (p_order_id, v_client_id, p_token_hash, p_expires_at, p_now)
  RETURNING id INTO v_token_id;
  RETURN v_token_id;
END;
$$;

CREATE FUNCTION public.customer_checkout_recovery_find_as_actor(
  p_order_id uuid DEFAULT NULL,
  p_subscription_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'orderId', order_row.id,
    'createdAt', order_row.created_at,
    'mode', CASE WHEN order_row.subscription_cycle_id IS NULL THEN 'one_time_order' ELSE 'subscription_cycle' END,
    'subscriptionId', cycle.subscription_id,
    'clientHasLiveOrPendingSubscription', EXISTS (
      SELECT 1 FROM public.subscriptions active_subscription
       WHERE active_subscription.client_id = order_row.client_id
         AND active_subscription.status IN ('active', 'paused')))
  FROM public.commerce_orders order_row
  JOIN public.clients client ON client.id = order_row.client_id
  LEFT JOIN public.subscription_cycles cycle ON cycle.id = order_row.subscription_cycle_id
  WHERE client.principal_id = auth.uid()
    AND order_row.status = 'pending_payment'
    AND ((p_order_id IS NOT NULL AND order_row.id = p_order_id)
      OR (p_order_id IS NULL AND p_subscription_id IS NOT NULL AND cycle.subscription_id = p_subscription_id))
  ORDER BY order_row.created_at DESC
  LIMIT 1;
$$;

CREATE FUNCTION public.customer_has_live_subscription_as_actor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions subscription
    JOIN public.clients client ON client.id = subscription.client_id
    WHERE client.principal_id = auth.uid()
      AND subscription.status IN ('active', 'paused'));
$$;

CREATE FUNCTION public.customer_checkout_recovery_token_inspect(
  p_token_hash text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'tokenId', token.id,
    'orderId', token.order_id,
    'clientId', token.client_id,
    'mode', CASE WHEN order_row.subscription_cycle_id IS NULL THEN 'one_time_order' ELSE 'subscription_cycle' END,
    'status', order_row.status,
    'subscriptionId', cycle.subscription_id,
    'tokenState', CASE
      WHEN token.revoked_at IS NOT NULL THEN 'revoked'
      WHEN token.expires_at <= p_now THEN 'expired'
      WHEN order_row.status <> 'pending_payment' THEN 'consumed'
      ELSE 'active'
    END)
  FROM public.commerce_checkout_recovery_tokens token
  JOIN public.commerce_orders order_row ON order_row.id = token.order_id
  LEFT JOIN public.subscription_cycles cycle ON cycle.id = order_row.subscription_cycle_id
  WHERE token.token_hash = p_token_hash;
$$;

CREATE FUNCTION public.customer_checkout_recovery_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'orderId', order_row.id,
    'clientId', order_row.client_id,
    'status', order_row.status,
    'mode', CASE WHEN order_row.subscription_cycle_id IS NULL THEN 'one_time_order' ELSE 'subscription_cycle' END,
    'totalMinor', order_row.total_amount_minor,
    'currency', order_row.currency_code,
    'createdAt', order_row.created_at,
    'subscriptionId', cycle.subscription_id,
    'subscriptionCycleId', order_row.subscription_cycle_id,
    'paymentIntentId', intent.id,
    'paymentIntentStatus', CASE intent.status
      WHEN 'created' THEN 'pending'
      WHEN 'settled' THEN 'succeeded'
      ELSE 'failed'
    END,
    'customerEmail', client.email)
  FROM public.commerce_orders order_row
  JOIN public.clients client ON client.id = order_row.client_id
  LEFT JOIN public.subscription_cycles cycle ON cycle.id = order_row.subscription_cycle_id
  LEFT JOIN public.commerce_settlement_intents intent ON intent.order_id = order_row.id
  WHERE order_row.id = p_order_id;
$$;

CREATE FUNCTION public.customer_checkout_recovery_settle(
  p_token_hash text,
  p_idempotency_key text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_token public.commerce_checkout_recovery_tokens%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_result jsonb;
  v_external_ref text;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$'
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) < 8 THEN
    RAISE EXCEPTION 'customer_checkout_recovery_settle_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_token FROM public.commerce_checkout_recovery_tokens
   WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_token.revoked_at IS NOT NULL OR v_token.expires_at <= p_now THEN
    RAISE EXCEPTION 'customer_checkout_recovery_token_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders
   WHERE id = v_token.order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_checkout_recovery_order_not_recoverable' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_settlement_intents
   WHERE order_id = v_order.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_checkout_recovery_intent_not_recoverable' USING ERRCODE = '22023';
  END IF;

  v_external_ref := 'captured-' || v_intent.id::text;
  -- The lower rail reads its append-only transition before checking current
  -- intent/order state. That preserves an exact-key replay after a successful
  -- first call while a different key still fails closed on the settled order.
  v_result := public.commerce_record_settlement(
    p_idempotency_key || ':settle', v_intent.id, 'succeeded', v_external_ref,
    jsonb_build_object('source', 'customer.checkout_recovery.v1'), p_now);

  RETURN jsonb_build_object(
    'orderId', v_order.id,
    'paymentIntentId', v_intent.id,
    'clientId', v_token.client_id,
    'status', 'paid',
    'paymentAttemptId', NULL,
    'provider', 'hidden_rehearsal',
    'providerPaymentId', v_external_ref,
    'clientAction', jsonb_build_object('kind', 'none'),
    'replayed', COALESCE((v_result->>'replayed')::boolean, false));
END;
$$;

REVOKE ALL ON FUNCTION public.customer_identity_challenge_issue(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_identity_challenge_redeem(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_checkout_recovery_token_inspect(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_checkout_recovery_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_checkout_recovery_settle(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_communication_preferences_as_actor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_communication_preferences_set_as_actor(boolean, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_checkout_recovery_token_issue_as_actor(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_checkout_recovery_find_as_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_has_live_subscription_as_actor() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.customer_communication_preferences_as_actor() TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_communication_preferences_set_as_actor(boolean, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_checkout_recovery_token_issue_as_actor(uuid, text, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_checkout_recovery_find_as_actor(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_has_live_subscription_as_actor() TO authenticated;
