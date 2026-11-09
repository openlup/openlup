-- Subscription notices reuse existing event/receipt identities. Runtime values come
-- from explicit trusted-host arguments; compatibility signatures retain defaults.
ALTER TABLE public.subscription_dunning_notifications ALTER COLUMN recipient_ref DROP NOT NULL;
ALTER TABLE public.subscription_dunning_notifications ADD COLUMN operator_recipient_ref uuid REFERENCES public.notification_recipients(id);
ALTER TABLE public.subscription_dunning_notifications ADD COLUMN operator_dispatch_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE public.subscription_dunning_notifications ADD COLUMN first_attempt_at timestamptz;
ALTER TABLE public.subscription_dunning_notifications DROP CONSTRAINT subscription_dunning_notifications_case_kind_attempt_key;
ALTER TABLE public.subscription_dunning_notifications ADD CONSTRAINT subscription_dunning_notifications_case_kind_attempt_key UNIQUE NULLS NOT DISTINCT (case_id,notification_kind,retry_attempt,recipient_kind,recipient_ref,operator_recipient_ref);
ALTER TABLE public.subscription_dunning_notifications ADD CONSTRAINT subscription_dunning_notifications_recipient_binding_check CHECK ((recipient_kind='customer' AND recipient_ref IS NOT NULL AND operator_recipient_ref IS NULL) OR (recipient_kind='operator' AND (NOT operator_dispatch_eligible OR recipient_ref IS NULL)));

ALTER TABLE public.subscription_reminder_ledger ADD COLUMN renewal_at timestamptz;

CREATE FUNCTION public.subscription_dunning_queue_operator_notices(p_case_id uuid,p_kind text,p_attempt integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c public.subscription_dunning_cases; r record; found_recipient boolean:=false; slug text;
BEGIN
  IF p_kind NOT IN ('payment_failed','payment_expired') THEN RETURN; END IF;
  SELECT * INTO c FROM public.subscription_dunning_cases WHERE id=p_case_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_dunning_case_not_found'; END IF;
  slug:=CASE p_kind WHEN 'payment_expired' THEN 'subscription-payment-expired-operator' ELSE 'subscription-payment-failed-operator' END;
  FOR r IN SELECT id FROM public.notification_recipients WHERE active AND notification_type='commerce_payment_critical' ORDER BY created_at,id LOOP
    found_recipient:=true;
    INSERT INTO public.subscription_dunning_notifications(case_id,subscription_id,recipient_ref,recipient_kind,operator_recipient_ref,notification_kind,template_slug,retry_attempt,operator_dispatch_eligible)
    VALUES(c.id,c.subscription_id,NULL,'operator',r.id,p_kind,slug,greatest(coalesce(p_attempt,0),0),true)
    ON CONFLICT ON CONSTRAINT subscription_dunning_notifications_case_kind_attempt_key DO NOTHING;
  END LOOP;
  IF NOT found_recipient THEN
    INSERT INTO public.subscription_dunning_notifications(case_id,subscription_id,recipient_ref,recipient_kind,notification_kind,template_slug,retry_attempt,status,error,operator_dispatch_eligible)
    VALUES(c.id,c.subscription_id,NULL,'operator',p_kind,slug,greatest(coalesce(p_attempt,0),0),'skipped','missing_critical_notification_recipient',true)
    ON CONFLICT ON CONSTRAINT subscription_dunning_notifications_case_kind_attempt_key DO NOTHING;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_queue_notice(
  p_case_id uuid,
  p_notification_kind text,
  p_template_slug text,
  p_retry_attempt integer,
  p_recovery_url_path text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_attempt integer := GREATEST(COALESCE(p_retry_attempt, 0), 0);
  v_id uuid;
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;

  INSERT INTO public.subscription_dunning_notifications (
    case_id, subscription_id, recipient_ref, notification_kind, template_slug,
    retry_attempt, recovery_url_path, payload
  ) VALUES (
    v_case.id, v_case.subscription_id, v_case.client_id, p_notification_kind,
    COALESCE(NULLIF(btrim(p_template_slug), ''), p_notification_kind),
    v_attempt, p_recovery_url_path,
    jsonb_strip_nulls(jsonb_build_object(
      'amountMinor', v_case.amount_minor,
      'currency', v_case.amount_currency,
      'nextRetryAt', v_case.next_retry_at,
      'failureClass', v_case.failure_class
    ))
  )
  ON CONFLICT ON CONSTRAINT subscription_dunning_notifications_case_kind_attempt_key
  DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.subscription_dunning_notifications
    WHERE case_id = v_case.id
      AND notification_kind = p_notification_kind
      AND retry_attempt = v_attempt AND recipient_kind='customer' AND recipient_ref=v_case.client_id;
  END IF;

  PERFORM public.subscription_dunning_queue_operator_notices(v_case.id,p_notification_kind,v_attempt);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_dunning_claim_batch(
  p_batch_size integer,
  p_lease_seconds integer,
  p_max_attempts integer
)
RETURNS SETOF public.subscription_dunning_notifications
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
WITH due AS (
    SELECT id
    FROM public.subscription_dunning_notifications
    WHERE recipient_kind='customer' AND attempt_count < GREATEST(COALESCE(p_max_attempts, 1), 1)
      AND scheduled_at <= now()
      AND (
        status = 'queued'
        OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
    ORDER BY scheduled_at, created_at
    LIMIT GREATEST(COALESCE(p_batch_size, 1), 1)
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    SELECT due.id, gen_random_uuid() AS claim_token FROM due
  ), claimed AS (
    UPDATE public.subscription_dunning_notifications AS n
    SET status = 'sending',
        claim_token = leased.claim_token,
        lease_expires_at = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 1), 1)),
        attempt_count = n.attempt_count + 1,
        payload = n.payload || jsonb_build_object('claimToken', leased.claim_token::text),
        updated_at = now()
    FROM leased
    WHERE n.id = leased.id
    RETURNING n.*
  )
  SELECT * FROM claimed;
$$;

CREATE FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(p_limit integer,p_renewal_min_seconds integer,p_renewal_max_seconds integer,p_ordinary_freshness_seconds integer,p_starter_freshness_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_enqueued integer;
BEGIN
  IF p_renewal_min_seconds IS NULL OR p_renewal_min_seconds<=0 OR p_renewal_max_seconds IS NULL OR p_renewal_max_seconds<=0 OR p_ordinary_freshness_seconds IS NULL OR p_ordinary_freshness_seconds<=0 OR p_starter_freshness_seconds IS NULL OR p_starter_freshness_seconds<=0 OR p_renewal_min_seconds>p_renewal_max_seconds THEN RAISE EXCEPTION 'subscription_notice_options_invalid'; END IF;
  WITH due AS (
    SELECT s.id AS subscription_id,s.next_cycle_at AS renewal_at,(s.next_cycle_at AT TIME ZONE 'UTC')::date AS reminder_day
    FROM public.subscriptions s LEFT JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
    WHERE s.status='active'
      AND s.next_cycle_at>=now()+make_interval(secs=>p_renewal_min_seconds)
      AND s.next_cycle_at<=now()+make_interval(secs=>p_renewal_max_seconds)
      -- Active-method eligibility is intentionally distinct from unattended chargeability.
      AND EXISTS(SELECT 1 FROM public.subscription_method_states m WHERE m.subscription_id=s.id AND m.health_state IN ('healthy','mandate_not_chargeable_unattended'))
      AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=s.id AND c.status IN ('payment_pending','retry_scheduled'))
      AND s.updated_at<now()-make_interval(secs=>CASE WHEN
        jsonb_typeof(public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}')='object'
        AND EXISTS(SELECT 1 FROM public.subscription_activations a JOIN public.commerce_orders o ON o.id=a.order_id JOIN public.subscription_cycles ac ON ac.id=o.subscription_cycle_id
          WHERE a.subscription_id=s.id AND ac.status='paid')
        AND (SELECT count(*) FROM public.subscription_cycles pc WHERE pc.subscription_id=s.id AND pc.status='paid' AND pc.scheduled_at<s.next_cycle_at)=t.next_cycle_number
        AND (SELECT count(*)+1 FROM public.subscription_cycles c WHERE c.subscription_id=s.id) IN (2,3)
        THEN p_starter_freshness_seconds ELSE p_ordinary_freshness_seconds END)
    ORDER BY s.next_cycle_at,s.id LIMIT greatest(coalesce(p_limit,1),1) FOR UPDATE OF s SKIP LOCKED
  ), written AS (
    INSERT INTO public.subscription_reminder_ledger(subscription_id,reminder_kind,reminder_day,renewal_at)
    SELECT subscription_id,'renewal_due_soon',reminder_day,renewal_at FROM due
    ON CONFLICT ON CONSTRAINT subscription_reminder_ledger_subscription_kind_day_key DO NOTHING RETURNING id
  ) SELECT count(*)::integer INTO v_enqueued FROM written;
  RETURN jsonb_build_object('enqueued',v_enqueued);
END;
$$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.dunning_lifecycle_renewal_reminder_enqueue(p_limit,259200,432000,432000,86400);
END;
$$;

CREATE FUNCTION public.dunning_lifecycle_pause_reminder_dispatch(p_limit integer,p_pause_window_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_scanned integer; v_queued integer;
BEGIN
  IF p_pause_window_seconds IS NULL OR p_pause_window_seconds<=0 THEN RAISE EXCEPTION 'subscription_notice_options_invalid'; END IF;
  WITH due AS (
    SELECT w.id,w.subscription_id,w.pause_preset,w.ends_at,
      CASE WHEN s.next_cycle_at<=w.ends_at THEN s.next_cycle_at+(floor(extract(epoch FROM(w.ends_at-s.next_cycle_at))/(s.cadence_days*86400.0))::bigint+1)*s.cadence_days*interval '1 day' ELSE s.next_cycle_at END AS next_delivery_at
    FROM public.subscription_pause_windows w JOIN public.subscriptions s ON s.id=w.subscription_id
    WHERE w.resumed_at IS NULL AND s.status='paused' AND w.ends_at>now()
      AND w.ends_at<=now()+make_interval(secs=>p_pause_window_seconds)
    ORDER BY w.ends_at,w.id LIMIT greatest(coalesce(p_limit,0),0)
  ), written AS (
    INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
    SELECT 'subscription_notice',subscription_id,'subscription.pause_reminder_due','subscription_pause_reminder:'||id::text,
      jsonb_build_object('pauseWindowId',id,'pausePreset',pause_preset,'pauseEndsAt',ends_at,'nextDeliveryAt',next_delivery_at,'resumeAt',next_delivery_at)
    FROM due WHERE NOT EXISTS(SELECT 1 FROM public.subscription_events legacy
      WHERE legacy.subscription_id=due.subscription_id AND legacy.event_type='subscription.pause_reminder_due'
        AND legacy.idempotency_key='pause-reminder:'||due.id::text)
      AND NOT EXISTS(SELECT 1 FROM public.subscription_reminder_ledger legacy
        WHERE legacy.subscription_id=due.subscription_id AND legacy.reminder_kind='pause_ending'
          AND legacy.reminder_day=(due.ends_at AT TIME ZONE 'UTC')::date)
    ON CONFLICT(event_type,idempotency_key) DO NOTHING RETURNING id
  ) SELECT (SELECT count(*)::integer FROM due),(SELECT count(*)::integer FROM written) INTO v_scanned,v_queued;
  RETURN jsonb_build_object('ok',true,'scanned',v_scanned,'queued',v_queued,'sent',0,'skipped',v_scanned-v_queued,'failed',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_pause_reminder_dispatch(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN public.dunning_lifecycle_pause_reminder_dispatch(p_limit,259200);
END;
$$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_scan_at_risk(
  p_min_days integer,
  p_max_days integer,
  p_limit integer
)
RETURNS TABLE (
  subscription_id uuid,
  client_id uuid,
  next_cycle_at timestamptz,
  health_state text
)
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
WITH candidates AS (
    SELECT s.id AS subscription_id,s.client_id,s.next_cycle_at,m.health_state FROM public.subscriptions s
    JOIN public.subscription_method_states m ON m.subscription_id=s.id
    WHERE s.status='active' AND NOT m.narrow_activation_gap AND m.health_state IN ('mandate_not_chargeable_unattended','method_missing')
      AND s.next_cycle_at>=now()+make_interval(hours=>24*coalesce(p_min_days,0)) AND s.next_cycle_at<=now()+make_interval(hours=>24*coalesce(p_max_days,0))
    ORDER BY s.next_cycle_at LIMIT greatest(coalesce(p_limit,1),1)
  ) SELECT c.* FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases d WHERE d.subscription_id=c.subscription_id AND d.status='open');
$$;


CREATE FUNCTION public.dunning_lifecycle_scan_at_risk_service(p_min_days integer,p_max_days integer,p_limit integer)
RETURNS TABLE (
  subscription_id uuid,
  client_id uuid,
  next_cycle_at timestamptz,
  health_state text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM public.dunning_lifecycle_scan_at_risk($1, $2, $3);
$$;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_scan_at_risk_service(integer,integer,integer) FROM PUBLIC;

CREATE FUNCTION public.subscription_dunning_claim_operator_batch(p_batch_size integer,p_lease_seconds integer,p_max_attempts integer,p_horizon_seconds integer)
RETURNS TABLE(notification_id uuid,case_id uuid,recipient_id uuid,recipient_email text,template_slug text,claim_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.subscription_dunning_notifications n SET status='sent',sent_at=coalesce(n.sent_at,r.accepted_at),settled_at=now(),delivery_ref=r.delivery_reference,error=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=now()
  FROM public.transactional_delivery_receipts r WHERE n.recipient_kind='operator' AND n.operator_dispatch_eligible
    AND (n.status='queued' OR (n.status='sending' AND n.lease_expires_at<=now()))
    AND r.idempotency_key='subscription-notice:dunning:'||n.id::text AND r.state='accepted';
  UPDATE public.subscription_dunning_notifications n SET status='failed',error='notice_idempotency_window_expired_manual_review',settled_at=now(),claim_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE n.recipient_kind='operator' AND n.operator_dispatch_eligible AND n.status IN ('queued','sending')
      AND n.first_attempt_at<now()-make_interval(secs=>greatest(p_horizon_seconds,1));
  RETURN QUERY WITH due AS (
    SELECT n.id FROM public.subscription_dunning_notifications n
    JOIN public.subscription_dunning_cases c ON c.id=n.case_id AND c.status IN ('open','expired')
    JOIN public.notification_recipients r ON r.id=n.operator_recipient_ref AND r.active AND r.notification_type='commerce_payment_critical'
    WHERE n.recipient_kind='operator' AND n.operator_dispatch_eligible
      AND n.template_slug IN ('subscription-payment-failed-operator','subscription-payment-expired-operator') AND n.attempt_count<greatest(p_max_attempts,1)
      AND ((n.status='queued' AND n.scheduled_at<=now()) OR (n.status='sending' AND n.lease_expires_at<=now()))
    ORDER BY n.scheduled_at,n.id LIMIT least(greatest(p_batch_size,0),100) FOR UPDATE OF n SKIP LOCKED
  ), claimed AS (
    UPDATE public.subscription_dunning_notifications n SET status='sending',attempt_count=n.attempt_count+1,claim_token=gen_random_uuid(),
      lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,1)),first_attempt_at=coalesce(n.first_attempt_at,now()),updated_at=now()
    FROM due WHERE n.id=due.id RETURNING n.id,n.case_id,n.operator_recipient_ref,n.template_slug,n.claim_token
  ) SELECT c.id,c.case_id,c.operator_recipient_ref,r.email,c.template_slug,c.claim_token FROM claimed c JOIN public.notification_recipients r ON r.id=c.operator_recipient_ref;
END;
$$;
CREATE FUNCTION public.subscription_dunning_operator_delivery_eligible(p_id uuid,p_token uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.subscription_dunning_notifications n
    JOIN public.subscription_dunning_cases c ON c.id=n.case_id AND c.status IN ('open','expired')
    JOIN public.notification_recipients r ON r.id=n.operator_recipient_ref AND r.active AND r.notification_type='commerce_payment_critical'
    WHERE n.id=p_id AND n.claim_token=p_token AND n.recipient_kind='operator' AND n.operator_dispatch_eligible
      AND n.status='sending' AND n.lease_expires_at>now());
$$;
REVOKE ALL ON FUNCTION public.subscription_dunning_operator_delivery_eligible(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_dunning_queue_operator_notices(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_dunning_claim_operator_batch(integer,integer,integer,integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(integer,integer,integer,integer,integer), public.dunning_lifecycle_pause_reminder_dispatch(integer,integer) FROM PUBLIC;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(integer,integer,integer,integer,integer), public.dunning_lifecycle_pause_reminder_dispatch(integer,integer), public.subscription_dunning_queue_operator_notices(uuid,text,integer), public.subscription_dunning_claim_operator_batch(integer,integer,integer,integer), public.subscription_dunning_operator_delivery_eligible(uuid,uuid), public.dunning_lifecycle_scan_at_risk_service(integer,integer,integer) FROM anon';
END IF; END; $$;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(integer,integer,integer,integer,integer), public.dunning_lifecycle_pause_reminder_dispatch(integer,integer), public.subscription_dunning_queue_operator_notices(uuid,text,integer), public.subscription_dunning_claim_operator_batch(integer,integer,integer,integer), public.subscription_dunning_operator_delivery_eligible(uuid,uuid), public.dunning_lifecycle_scan_at_risk_service(integer,integer,integer) FROM authenticated';
END IF; END; $$;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(integer,integer,integer,integer,integer), public.dunning_lifecycle_pause_reminder_dispatch(integer,integer), public.subscription_dunning_queue_operator_notices(uuid,text,integer), public.subscription_dunning_claim_operator_batch(integer,integer,integer,integer), public.subscription_dunning_operator_delivery_eligible(uuid,uuid), public.dunning_lifecycle_scan_at_risk_service(integer,integer,integer) TO service_role';
END IF; END; $$;

