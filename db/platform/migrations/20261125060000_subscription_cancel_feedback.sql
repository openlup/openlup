-- Restricted customer feedback, stored independently of the cancellation receipt.
CREATE TABLE public.subscription_cancel_feedback (
  cancel_event_id uuid PRIMARY KEY REFERENCES public.subscription_events(id) ON DELETE CASCADE,
  reason_code text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.subscription_cancel_feedback ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.subscription_cancel_feedback_submit(
  p_cancel_event_id uuid,
  p_client_id uuid,
  p_reason_code text,
  p_reason_offered boolean
)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reason_code text;
BEGIN
  IF p_reason_code IS NULL OR length(p_reason_code) > 120
    OR p_reason_code COLLATE pg_catalog."C" !~ '^[a-z][a-z0-9_]{0,119}$' THEN
    RETURN 'invalid_reason';
  END IF;

  -- Keep the event and its ownership stable while writers arbitrate on the feedback key.
  PERFORM 1 FROM public.subscriptions AS s
  JOIN public.subscription_events AS e ON e.subscription_id = s.id
  WHERE e.id = p_cancel_event_id AND s.client_id = p_client_id
    AND e.event_type = 'subscription.customer_self_service.cancel'
  FOR SHARE OF s, e;
  IF NOT FOUND THEN
    RETURN 'cancel_not_found';
  END IF;

  LOOP
    SELECT reason_code INTO v_reason_code
    FROM public.subscription_cancel_feedback WHERE cancel_event_id = p_cancel_event_id;
    IF FOUND THEN
      RETURN CASE WHEN v_reason_code COLLATE pg_catalog."C" = p_reason_code THEN 'replayed' ELSE 'reason_conflict' END;
    END IF;
    IF p_reason_offered IS NOT TRUE THEN
      RETURN 'reason_not_offered';
    END IF;

    INSERT INTO public.subscription_cancel_feedback (cancel_event_id, reason_code)
    VALUES (p_cancel_event_id, p_reason_code)
    ON CONFLICT (cancel_event_id) DO NOTHING;
    IF FOUND THEN
      RETURN 'recorded';
    END IF;
    -- Re-read in a new statement and retry the insert if the owner erased the winner.
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE public.subscription_cancel_feedback FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_cancel_feedback FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_cancel_feedback FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_cancel_feedback FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_cancel_feedback_submit(uuid,uuid,text,boolean) TO service_role'; END IF; END; $$;
