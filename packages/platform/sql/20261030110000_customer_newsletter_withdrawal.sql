-- Portable account newsletter withdrawal; the managed setter already writes its evaluator store.
CREATE OR REPLACE FUNCTION public.customer_communication_preferences_set_as_actor(
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

  IF p_marketing_newsletter_consent IS FALSE THEN
    INSERT INTO public.communication_recipient_consents
      (recipient_fingerprint, purpose, state, captured_at, updated_at)
    SELECT encode(sha256(convert_to(lower(btrim(client.email, E'\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')), 'UTF8')), 'hex'),
      'marketing_newsletter', 'denied', p_now, p_now
    FROM public.clients AS client
    WHERE client.principal_id = v_principal_id
    ON CONFLICT (recipient_fingerprint, purpose) DO UPDATE
      SET state = EXCLUDED.state,
          updated_at = GREATEST(public.communication_recipient_consents.updated_at, EXCLUDED.updated_at)
      WHERE public.communication_recipient_consents.state = 'granted';
  END IF;

  RETURN public.customer_communication_preferences_as_actor();
END;
$$;
