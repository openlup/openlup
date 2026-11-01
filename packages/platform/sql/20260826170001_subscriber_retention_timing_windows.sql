-- Keep the direct PostgreSQL subscriber-retention runtime on the same fourteen-
-- day review-effects and win-back boundaries as the managed runtime.
--
-- Both eligibility enforcement and candidate planning own the timing policy, so
-- each receives the same two changes. The installed definitions are patched
-- only after exact one-occurrence checks. CREATE OR REPLACE therefore preserves
-- signatures, grants and search_path, while all existing selection, ordering and
-- locking clauses remain byte-identical. Any predecessor drift aborts the unit.
--
-- Recovery: reapply the two definitions from the preceding subscriber-retention
-- messaging forward.

DO $migration$
DECLARE
  v_definition text;
  v_effects_before text := $$        AND shipment.delivered_at <= p_now - CASE p_kind
          WHEN 'review_request' THEN interval '3 days' ELSE interval '21 days' END$$;
  v_effects_after text := $$        AND shipment.delivered_at <= p_now - CASE p_kind
          WHEN 'review_request' THEN interval '3 days' ELSE interval '14 days' END$$;
  v_winback_before text := $$        AND subscription.ended_at > p_now - interval '120 days'$$;
  v_winback_after text := $$        AND subscription.ended_at > p_now - interval '120 days'
        AND subscription.ended_at <= p_now - interval '14 days'$$;
BEGIN
  SELECT pg_get_functiondef('public.subscriber_retention_eligibility_refusal(text,text,timestamptz)'::regprocedure)
    INTO v_definition;

  IF (length(v_definition) - length(replace(v_definition, v_effects_before, ''))) <> length(v_effects_before)
     OR (length(v_definition) - length(replace(v_definition, v_winback_before, ''))) <> length(v_winback_before) THEN
    RAISE EXCEPTION 'subscriber_retention_timing_windows: unexpected eligibility predecessor';
  END IF;

  v_definition := replace(replace(
    v_definition, v_effects_before, v_effects_after
  ), v_winback_before, v_winback_after);
  EXECUTE format('%s', v_definition);
END;
$migration$;

DO $migration$
DECLARE
  v_definition text;
  v_effects_before text := $$        AND shipment.delivered_at <= p_now - interval '21 days'$$;
  v_effects_after text := $$        AND shipment.delivered_at <= p_now - interval '14 days'$$;
  v_winback_before text := $$        AND subscription.ended_at > p_now - interval '120 days'$$;
  v_winback_after text := $$        AND subscription.ended_at > p_now - interval '120 days'
        AND subscription.ended_at <= p_now - interval '14 days'$$;
BEGIN
  SELECT pg_get_functiondef('public.subscriber_retention_plan_due(text,integer,timestamptz)'::regprocedure)
    INTO v_definition;

  IF (length(v_definition) - length(replace(v_definition, v_effects_before, ''))) <> length(v_effects_before)
     OR (length(v_definition) - length(replace(v_definition, v_winback_before, ''))) <> length(v_winback_before) THEN
    RAISE EXCEPTION 'subscriber_retention_timing_windows: unexpected planner predecessor';
  END IF;

  v_definition := replace(replace(
    v_definition, v_effects_before, v_effects_after
  ), v_winback_before, v_winback_after);
  EXECUTE format('%s', v_definition);
END;
$migration$;
