-- Keep browser writes within the existing self-service profile contract.
-- Account linkage, email and lifecycle remain controlled by service operations.
REVOKE UPDATE ON TABLE public.clients FROM PUBLIC, anon, authenticated;
GRANT UPDATE (first_name, last_name, phone, updated_at) ON TABLE public.clients TO authenticated;

-- These columns already have explicit SELECT in the full managed chain.
-- Declare the same read contract when applying this forward to the local reference.
GRANT SELECT (id, auth_user_id, email, first_name, last_name, phone, lifecycle_stage)
  ON TABLE public.clients TO authenticated;

-- These existing invoker helpers back expression indexes on the profile fields.
GRANT EXECUTE ON FUNCTION public.commerce_oms_normalize_search_text(text),
  public.commerce_oms_normalize_search_digits(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commerce_configurator_persist_intent(p_intent jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_catalog
    AS $$
DECLARE
  v_scope text := 'commerce_configurator_intent';
  v_key text := p_intent->>'idempotencyKey';
  v_fingerprint text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN md5((p_intent - 'authenticatedUserId')::text) ELSE md5(p_intent::text) END;
  v_existing public.commerce_idempotency_keys%ROWTYPE;
  v_response jsonb;
  v_client_id uuid;
  v_pet_id uuid;
  v_is_neutral boolean := p_intent->>'version' = 'commerce.checkout_command.v1';
  v_first_name text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{customer,firstName}' ELSE p_intent#>>'{contact,firstName}' END;
  v_last_name text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{customer,lastName}' ELSE p_intent#>>'{contact,lastName}' END;
  v_phone text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{customer,phone}' ELSE p_intent#>>'{contact,phone}' END;
  v_pet_referenced text := NULLIF(btrim(p_intent#>>'{petProfile,petId}'), '');
  v_pet_reused_by_key boolean := false;
  v_address_id uuid;
  v_address_key text;
  v_auth_user_id uuid;
  v_client_auth_user_id uuid;
  v_preference_write_allowed boolean := false;
  v_recipient_name text;
  v_email text := lower(btrim(CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{customer,email}' ELSE p_intent#>>'{contact,email}' END));
  v_street text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{shippingAddress,street}' ELSE p_intent#>>'{address,street}' END;
  v_postal_code text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{shippingAddress,postalCode}' ELSE p_intent#>>'{address,postalCode}' END;
  v_city text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{shippingAddress,city}' ELSE p_intent#>>'{address,city}' END;
  v_country text := CASE WHEN p_intent->>'version' = 'commerce.checkout_command.v1'
    THEN p_intent#>>'{shippingAddress,country}' ELSE p_intent#>>'{address,country}' END;
  v_client_match_reason text := 'client_created';
  v_now timestamptz := now();
BEGIN
  IF p_intent->>'version' IS NULL
     OR p_intent->>'version' NOT IN ('commerce.configurator_intent.v1', 'commerce.checkout_command.v1') THEN
    RAISE EXCEPTION 'configurator_intent_invalid_version' USING ERRCODE = '22023';
  END IF;
  IF v_is_neutral AND p_intent ? 'petProfile' THEN
    RAISE EXCEPTION 'configurator_intent_neutral_pet_profile_forbidden' USING ERRCODE = '22023';
  END IF;
  IF v_is_neutral AND coalesce(nullif(btrim(v_country), ''), '') = '' THEN
    RAISE EXCEPTION 'configurator_intent_neutral_country_required' USING ERRCODE = '22023';
  END IF;
  IF v_key IS NULL OR btrim(v_key) = '' OR length(v_key) < 8 THEN
    RAISE EXCEPTION 'configurator_intent_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  -- The service port stamps this field from the server-verified request subject.
  -- A missing value represents a guest. A malformed subject cannot proceed.
  BEGIN
    v_auth_user_id := nullif(btrim(p_intent->>'authenticatedUserId'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'checkout_identity_authorization_required' USING ERRCODE = '42501';
  END;

  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = v_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed' THEN
      -- The stored client may have obtained an owner since the checkout.
      -- Authorize against that client before replaying or reopening the receipt.
      SELECT auth_user_id INTO v_client_auth_user_id
        FROM public.clients
       WHERE id = CASE
         WHEN v_existing.response_payload->>'clientId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (v_existing.response_payload->>'clientId')::uuid
         END
       FOR UPDATE;
      IF NOT FOUND OR (v_client_auth_user_id IS NOT NULL
          AND v_client_auth_user_id IS DISTINCT FROM v_auth_user_id) THEN
        RAISE EXCEPTION 'checkout_identity_authorization_required' USING ERRCODE = '42501';
      END IF;
      IF v_existing.request_fingerprint = v_fingerprint
         OR (v_is_neutral AND v_existing.request_fingerprint IN (
           md5(p_intent::text),
           md5((p_intent || '{"authenticatedUserId":null}'::jsonb)::text)
         ))
      THEN
        RETURN jsonb_set(v_existing.response_payload, '{replayed}', 'true'::jsonb, false);
      END IF;
      -- Only legacy receipts have a pet identifier and support same-key edits.
      IF v_is_neutral OR (
        v_existing.response_payload->>'petId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) IS NOT TRUE THEN
        RAISE EXCEPTION 'configurator_intent_idempotency_conflict' USING ERRCODE = '23505';
      END IF;
    END IF;
    UPDATE public.commerce_idempotency_keys
       SET request_fingerprint = v_fingerprint,
           status = 'in_progress',
           response_payload = NULL,
           metadata = metadata || jsonb_build_object(
             'boundary', 'commerce_configurator_persist_intent',
             'reopenedForUpdate', true
           )
     WHERE scope = v_scope
       AND idempotency_key = v_key;
  ELSE
    INSERT INTO public.commerce_idempotency_keys (
      scope, idempotency_key, request_fingerprint, status, metadata
    )
    VALUES (
      v_scope, v_key, v_fingerprint, 'in_progress',
      jsonb_build_object('boundary', 'commerce_configurator_persist_intent')
    );
  END IF;
  v_recipient_name := nullif(btrim(concat_ws(' ', v_first_name, v_last_name)), '');
  SELECT id, auth_user_id
    INTO v_client_id, v_client_auth_user_id
    FROM public.clients
   WHERE lower(email) = v_email
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_client_id IS NOT NULL THEN
    -- Matching a contact e-mail permits reuse of an unlinked guest record.
    -- A linked client requires the same authenticated subject for every write.
    IF v_client_auth_user_id IS NOT NULL
      AND v_client_auth_user_id IS DISTINCT FROM v_auth_user_id THEN
      RAISE EXCEPTION 'checkout_identity_authorization_required' USING ERRCODE = '42501';
    END IF;
    v_client_match_reason := 'client_match_exact_email';
  END IF;

  IF v_client_id IS NULL THEN
    INSERT INTO public.clients (
      email, first_name, last_name, phone, country, lifecycle_stage,
      acquisition_source, metadata
    )
    VALUES (
      v_email,
      v_first_name,
      v_last_name,
      v_phone,
      v_country,
      'lead',
      'hidden_configurator',
      jsonb_build_object('hiddenCommerce', jsonb_build_object(
        'lastIntentIdempotencyKey', v_key,
        'locale', p_intent->>'locale',
        'mode', p_intent->>'mode',
        'clientMatchReason', v_client_match_reason
      ))
    )
    RETURNING id INTO v_client_id;
    v_preference_write_allowed := true;
  ELSE
    v_preference_write_allowed := v_client_auth_user_id IS NOT NULL;
    UPDATE public.clients
       SET first_name = COALESCE(NULLIF(v_first_name, ''), first_name),
           last_name = COALESCE(NULLIF(v_last_name, ''), last_name),
           phone = COALESCE(NULLIF(v_phone, ''), phone),
           country = COALESCE(NULLIF(v_country, ''), country),
           updated_at = v_now,
           metadata = metadata || jsonb_build_object('hiddenCommerce', jsonb_build_object(
             'lastIntentIdempotencyKey', v_key,
             'locale', p_intent->>'locale',
             'mode', p_intent->>'mode',
             'clientMatchReason', v_client_match_reason
           ))
     WHERE id = v_client_id;
  END IF;
  IF NOT v_is_neutral THEN
  IF v_pet_referenced IS NOT NULL
     AND v_pet_referenced ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    SELECT id
      INTO v_pet_id
      FROM public.pets
     WHERE id = v_pet_referenced::uuid
       AND client_id = v_client_id
     FOR UPDATE;
  END IF;
  IF v_pet_id IS NULL THEN
    SELECT id
      INTO v_pet_id
      FROM public.pets
     WHERE client_id = v_client_id
       AND metadata->>'configuratorIntentIdempotencyKey' = v_key
     FOR UPDATE;
    IF v_pet_id IS NOT NULL THEN
      v_pet_reused_by_key := true;
    END IF;
  END IF;

  IF v_pet_id IS NULL THEN
    INSERT INTO public.pets (
      client_id, pet_type, name, breed, age_label, weight_kg, metadata
    )
    VALUES (
      v_client_id,
      'dog',
      p_intent#>>'{petProfile,name}',
      p_intent#>>'{petProfile,breed}',
      p_intent#>>'{petProfile,ageBand}',
      NULLIF(p_intent#>>'{petProfile,weightKg}', '')::numeric,
      jsonb_build_object(
        'configuratorIntentIdempotencyKey', v_key,
        'activityLevel', p_intent#>>'{petProfile,activityLevel}',
        'bcs', p_intent#>>'{petProfile,bcs}',
        'allergenSlugs', COALESCE(p_intent#>'{petProfile,allergenSlugs}', '[]'::jsonb),
        'dailyKcalOverride', p_intent#>'{petProfile,dailyKcalOverride}'
      )
    )
    RETURNING id INTO v_pet_id;
  ELSIF v_pet_reused_by_key THEN
    UPDATE public.pets
       SET name = p_intent#>>'{petProfile,name}',
           breed = p_intent#>>'{petProfile,breed}',
           age_label = p_intent#>>'{petProfile,ageBand}',
           weight_kg = NULLIF(p_intent#>>'{petProfile,weightKg}', '')::numeric,
           updated_at = v_now,
           metadata = metadata || jsonb_build_object(
             'configuratorIntentIdempotencyKey', v_key,
             'activityLevel', p_intent#>>'{petProfile,activityLevel}',
             'bcs', p_intent#>>'{petProfile,bcs}',
             'allergenSlugs', COALESCE(p_intent#>'{petProfile,allergenSlugs}', '[]'::jsonb),
             'dailyKcalOverride', p_intent#>'{petProfile,dailyKcalOverride}'
           )
     WHERE id = v_pet_id;
  END IF;
  END IF;

  v_address_key := lower(
    translate(
      regexp_replace(
        concat_ws('|',
          v_client_id::text,
          'shipping',
          coalesce(nullif(btrim(v_country), ''), public.platform_region_code()),
          regexp_replace(btrim(coalesce(v_postal_code, '')), '[\s-]+', '', 'g'),
          regexp_replace(btrim(coalesce(v_city, '')), '\s+', ' ', 'g'),
          regexp_replace(btrim(coalesce(v_street, '')), '\s+', ' ', 'g'),
          ''
        ),
        '^\s+|\s+$',
        '',
        'g'
      ),
      'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ',
      'acelnoszzACELNOSZZ'
    )
  );

  SELECT id
    INTO v_address_id
    FROM public.addresses
   WHERE client_id = v_client_id
     AND canonical_key = v_address_key
   FOR UPDATE;

  IF v_address_id IS NULL THEN
    INSERT INTO public.addresses (
      client_id, kind, label, recipient_name, line1, city, postal_code, country, is_default, last_used_at, canonical_key, metadata
    )
    VALUES (
      v_client_id,
      'shipping',
      NULL,
      v_recipient_name,
      v_street,
      v_city,
      v_postal_code,
      coalesce(nullif(v_country, ''), public.platform_region_code()),
      false,
      v_now,
      v_address_key,
      CASE WHEN v_preference_write_allowed THEN
        jsonb_build_object(
          'configuratorIntentIdempotencyKey', v_key,
          'selectedDelivery', p_intent->'selectedDelivery'
        )
      ELSE
        jsonb_build_object('selectedDelivery', p_intent->'selectedDelivery')
      END
    )
    RETURNING id INTO v_address_id;
  ELSIF v_preference_write_allowed THEN
    UPDATE public.addresses
       SET recipient_name = COALESCE(v_recipient_name, recipient_name),
           last_used_at = v_now,
           updated_at = v_now,
           metadata = metadata || jsonb_build_object(
             'lastConfiguratorIntentIdempotencyKey', v_key,
             'selectedDelivery', p_intent->'selectedDelivery'
           )
     WHERE id = v_address_id;
  END IF;

  IF v_preference_write_allowed THEN
    INSERT INTO public.client_consents (client_id, consent_type, granted, source, metadata)
    VALUES
      (v_client_id, 'gdpr', true, 'hidden_configurator', jsonb_build_object('configuratorIntentIdempotencyKey', v_key)),
      (v_client_id, 'terms', true, 'hidden_configurator', jsonb_build_object('configuratorIntentIdempotencyKey', v_key)),
      (v_client_id, 'marketing', COALESCE((p_intent#>>'{consents,marketing}')::boolean, false), 'hidden_configurator', jsonb_build_object('configuratorIntentIdempotencyKey', v_key));
  ELSE
    INSERT INTO public.client_consents (client_id, consent_type, granted, source, metadata)
    VALUES
      (v_client_id, 'gdpr', true, 'hidden_configurator', jsonb_build_object('configuratorIntentIdempotencyKey', v_key)),
      (v_client_id, 'terms', true, 'hidden_configurator', jsonb_build_object('configuratorIntentIdempotencyKey', v_key));
  END IF;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.configurator_intent_persistence.v1',
    'intentVersion', 'commerce.configurator_intent.v1',
    'idempotencyKey', v_key,
    'clientId', v_client_id,
    'petId', v_pet_id,
    'addressId', v_address_id,
    'clientMatchReason', v_client_match_reason,
    'replayed', false
  );

  UPDATE public.commerce_idempotency_keys
     SET status = 'completed',
         response_payload = v_response,
         metadata = metadata || jsonb_build_object(
           'clientId', v_client_id,
           'petId', v_pet_id,
           'addressId', v_address_id,
           'clientMatchReason', v_client_match_reason
         )
   WHERE scope = v_scope
     AND idempotency_key = v_key;

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_configurator_persist_intent(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_configurator_persist_intent(jsonb) TO service_role;

COMMENT ON FUNCTION public.commerce_configurator_persist_intent(jsonb) IS
  'Persists guest checkout identity or a server-verified linked account checkout. Exact email alone only resolves unlinked guest records. Rechecks ownership before returning or changing a completed receipt.';

-- A conflict resume or historical cadence replay only reads an existing receipt.
-- Its exact fingerprint and current owner are obtained from the same snapshot.
CREATE OR REPLACE FUNCTION public.commerce_configurator_read_completed_intent(
  p_idempotency_key text, p_auth_user_id uuid
) RETURNS TABLE(response_payload jsonb, request_fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT receipt.response_payload, receipt.request_fingerprint
    FROM public.commerce_idempotency_keys AS receipt
    JOIN public.clients AS client ON client.id = CASE
      WHEN receipt.response_payload->>'clientId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (receipt.response_payload->>'clientId')::uuid
      END
   WHERE receipt.scope = 'commerce_configurator_intent'
     AND receipt.idempotency_key = p_idempotency_key
     AND receipt.status = 'completed'
     AND (client.auth_user_id IS NULL OR client.auth_user_id = p_auth_user_id);
$$;

REVOKE ALL ON FUNCTION public.commerce_configurator_read_completed_intent(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_configurator_read_completed_intent(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_configurator_replay_checkout_command(p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid;
  v_response jsonb;
BEGIN
  IF p_command->>'version' IS DISTINCT FROM 'commerce.checkout_command.v1' THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_auth_user_id := nullif(btrim(p_command->>'authenticatedUserId'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;

  -- The subject authorizes the current owner separately from the command bytes.
  -- Older receipts hashed the full command with a verified subject or guest null.
  SELECT jsonb_set(receipt.response_payload, '{replayed}', 'true'::jsonb, false)
    INTO v_response
    FROM public.commerce_configurator_read_completed_intent(p_command->>'idempotencyKey', v_auth_user_id) AS receipt
   WHERE receipt.request_fingerprint IN (
     md5((p_command - 'authenticatedUserId')::text),
     md5(p_command::text),
     md5((p_command || '{"authenticatedUserId":null}'::jsonb)::text)
   );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_configurator_replay_checkout_command(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_configurator_replay_checkout_command(jsonb) TO service_role;

COMMENT ON FUNCTION public.commerce_configurator_replay_checkout_command(jsonb) IS
  'Returns a completed receipt only for an unchanged checkout command authorized by the current client owner.';
