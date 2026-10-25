-- CTL-M11 reviewed fixture: scope saved preference writes to a newly created client
-- or a caller whose server-proved account matches the existing linked account.
-- Guests may supply an order destination without rewriting a saved address,
-- promoting it to default, or appending marketing permission. Agreement evidence
-- and the existing identity/idempotency response remain on their current rails.
-- Preserve the platform's existing legacy profile fields and command signatures.
-- Migration: legacy omitted/empty country now uses platform_region_code() in
-- address identity and insertion, replacing the incumbent fixed country default.
-- Missing settlement-region configuration now raises 55000 on that fallback.
-- Adopters must configure their own default region. Neutral commands continue
-- to require explicit country input.
-- Existing SECURITY DEFINER, fixed path and service-only execution are retained.
-- Admitted pin: config/reviewed-platform-forwards.json managedCommerceForwards.
-- M11 feature PRs (the K1 stack) introduce these bytes in registry order.
-- This file requires every earlier same-rail M10/M11 pin to have landed.
-- Pin admission does not establish installation or runtime behavior.
CREATE OR REPLACE FUNCTION public.commerce_configurator_persist_intent(p_intent jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_catalog
    AS $$
DECLARE
  v_scope text := 'commerce_configurator_intent';
  v_key text := p_intent->>'idempotencyKey';
  v_fingerprint text := md5(p_intent::text);
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
  v_identity_write_allowed boolean;
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
  IF p_intent->>'version' NOT IN ('commerce.configurator_intent.v1', 'commerce.checkout_command.v1') THEN
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

  SELECT *
    INTO v_existing
    FROM public.commerce_idempotency_keys
   WHERE scope = v_scope
     AND idempotency_key = v_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'completed'
      AND v_existing.request_fingerprint = v_fingerprint
      AND v_existing.response_payload IS NOT NULL
    THEN
      RETURN jsonb_set(v_existing.response_payload, '{replayed}', 'true'::jsonb, false);
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
  BEGIN
    v_auth_user_id := nullif(btrim(coalesce(p_intent->>'authenticatedUserId', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_auth_user_id := NULL;
  END;
  v_recipient_name := nullif(btrim(concat_ws(' ', v_first_name, v_last_name)), '');
  SELECT id, auth_user_id
    INTO v_client_id, v_client_auth_user_id
    FROM public.clients
   WHERE lower(email) = v_email
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_client_id IS NOT NULL THEN
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
    v_preference_write_allowed := (
      v_client_auth_user_id IS NOT NULL
      AND v_auth_user_id IS NOT NULL
      AND v_client_auth_user_id = v_auth_user_id
    );
    v_identity_write_allowed := (
      v_client_auth_user_id IS NULL
      OR (v_auth_user_id IS NOT NULL AND v_client_auth_user_id = v_auth_user_id)
    );
    UPDATE public.clients
       SET first_name = CASE WHEN v_identity_write_allowed
                             THEN COALESCE(NULLIF(v_first_name, ''), first_name)
                             ELSE first_name END,
           last_name = CASE WHEN v_identity_write_allowed
                            THEN COALESCE(NULLIF(v_last_name, ''), last_name)
                            ELSE last_name END,
           phone = CASE WHEN v_identity_write_allowed
                        THEN COALESCE(NULLIF(v_phone, ''), phone)
                        ELSE phone END,
           country = CASE WHEN v_identity_write_allowed
                          THEN COALESCE(NULLIF(v_country, ''), country)
                          ELSE country END,
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
