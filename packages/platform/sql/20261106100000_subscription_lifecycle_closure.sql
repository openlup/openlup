-- Explicit customer lifecycle closure and trusted timing terms.
-- Existing signatures, owners and ACLs remain unchanged. Compatibility entries
-- retain their prior timing values; new terms are separate from customer JSON.
-- No payment I/O, automatic refund, retry restart or arrival is performed.
-- openlup:allow-grant: created invoker helpers and overloads need trusted service-role execution; browser and PUBLIC access remain revoked.

ALTER TABLE public.subscription_dunning_cases DROP CONSTRAINT subscription_dunning_cases_status_check;
ALTER TABLE public.subscription_dunning_cases ADD CONSTRAINT subscription_dunning_cases_status_check CHECK (status IN ('open', 'recovered', 'expired', 'cancelled', 'paused'));
ALTER TABLE public.subscription_cycles DROP CONSTRAINT subscription_cycles_status_check;
ALTER TABLE public.subscription_cycles ADD CONSTRAINT subscription_cycles_status_check CHECK (status IN ('planned', 'payment_pending', 'paid', 'cancelled', 'skipped'));
ALTER TABLE public.commerce_settlement_intents DROP CONSTRAINT commerce_settlement_intents_status_check;
ALTER TABLE public.commerce_settlement_intents ADD CONSTRAINT commerce_settlement_intents_status_check CHECK (status IN ('created', 'settled', 'failed', 'cancelled'));

CREATE FUNCTION public.subscription_terminalize_unpaid_artifacts(
 p_subscription_id uuid,p_requested_at timestamptz,p_reason text,p_cycle_status text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF p_cycle_status NOT IN ('skipped','cancelled') OR p_cycle_status IS NULL
  OR p_requested_at IS NULL OR NOT isfinite(p_requested_at) THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.subscriptions WHERE id=p_subscription_id FOR UPDATE;
 BEGIN
  PERFORM 1 FROM public.subscription_renewal_operations WHERE subscription_id=p_subscription_id ORDER BY id FOR UPDATE NOWAIT;
  -- Simulator dispatch and settlement take the order before the intent. Take
  -- that same pair without waiting while holding the subscription lock.
  PERFORM 1 FROM public.commerce_orders orders JOIN public.subscription_cycles cycle ON cycle.id=orders.subscription_cycle_id
   WHERE cycle.subscription_id=p_subscription_id AND cycle.status='payment_pending' ORDER BY orders.id FOR UPDATE OF orders NOWAIT;
  PERFORM 1 FROM public.commerce_settlement_intents intent JOIN public.commerce_orders orders ON orders.id=intent.order_id
   JOIN public.subscription_cycles cycle ON cycle.id=orders.subscription_cycle_id
   WHERE cycle.subscription_id=p_subscription_id ORDER BY intent.id FOR UPDATE OF intent NOWAIT;
 EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'subscription_command_operation_busy' USING ERRCODE='22023';
 END;
 IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=p_subscription_id
   AND (state='attempt_prepared' OR (state IN ('claimed','reserved') AND lease_expires_at>p_requested_at)
    OR (attempt_prepared_at IS NOT NULL AND state NOT IN ('succeeded','refused'))))
  OR EXISTS(SELECT 1 FROM public.subscription_retry_obligations WHERE subscription_id=p_subscription_id AND state='prepared')
  OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents intent JOIN public.commerce_orders orders ON orders.id=intent.order_id
   JOIN public.subscription_cycles cycle ON cycle.id=orders.subscription_cycle_id
   WHERE cycle.subscription_id=p_subscription_id AND intent.channel_key='sandbox'
    AND public.payment_simulator_read_attempt(intent.id,NULL)->>'state' IN ('dispatched','indeterminate')) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
 END IF;
 UPDATE public.commerce_settlement_intents intent SET status='cancelled',failure_reason=coalesce(intent.failure_reason,p_reason),updated_at=p_requested_at
  FROM public.commerce_orders orders,public.subscription_cycles cycle
  WHERE intent.order_id=orders.id AND orders.subscription_cycle_id=cycle.id AND cycle.subscription_id=p_subscription_id
   AND cycle.status='payment_pending' AND intent.status IN ('created','failed');
 UPDATE public.commerce_orders orders SET status='cancelled',updated_at=p_requested_at
  FROM public.subscription_cycles cycle WHERE orders.subscription_cycle_id=cycle.id AND cycle.subscription_id=p_subscription_id
   AND cycle.status='payment_pending' AND orders.status='pending_payment'
   AND NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents intent WHERE intent.order_id=orders.id
    AND (intent.status='settled' OR (intent.channel_key='sandbox' AND public.payment_simulator_read_attempt(intent.id,NULL)->>'state'='captured')));
 UPDATE public.subscription_retry_obligations SET next_retry_at=NULL,updated_at=p_requested_at
  WHERE subscription_id=p_subscription_id AND state='waiting' AND cycle_id IN
   (SELECT id FROM public.subscription_cycles WHERE subscription_id=p_subscription_id AND status='payment_pending');
 UPDATE public.subscription_cycles SET status=p_cycle_status,updated_at=p_requested_at
  WHERE subscription_id=p_subscription_id AND status='payment_pending';
 UPDATE public.fulfillment_inventory_reservations stock_hold SET status='released',expires_at=NULL,
  terminal_reason=p_reason,updated_at=p_requested_at FROM public.subscription_renewal_operations op
  WHERE op.subscription_id=p_subscription_id AND stock_hold.renewal_operation_id=op.id AND stock_hold.status='held'
   AND op.state IN ('claimed','reserved') AND op.attempt_prepared_at IS NULL AND op.external_attempt_ref IS NULL;
 UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',terminal_reason=p_reason,
  terminal_at=p_requested_at,updated_at=p_requested_at WHERE subscription_id=p_subscription_id
   AND state IN ('claimed','reserved') AND attempt_prepared_at IS NULL AND external_attempt_ref IS NULL;
END;
$$;

CREATE FUNCTION public.subscription_pause_close_recovery(
 p_client_id uuid,p_key text,p_subscription_id uuid,p_requested_at timestamptz
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE s public.subscriptions; closed_ids uuid[];
BEGIN
 -- Do not change invalid, foreign, non-active or replay requests. The canonical
 -- caller still owns their response. Its exception boundary owns rollback.
 IF p_key IS NULL OR char_length(btrim(p_key))<8 THEN RETURN; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND OR s.status<>'active' OR EXISTS(SELECT 1 FROM public.subscription_events
   WHERE subscription_id=s.id AND idempotency_key=p_key) THEN RETURN; END IF;
 WITH closed AS (UPDATE public.subscription_dunning_cases SET status='paused',next_retry_at=NULL,updated_at=p_requested_at
  WHERE subscription_id=s.id AND status='open' RETURNING id)
 SELECT coalesce(array_agg(id),ARRAY[]::uuid[]) INTO closed_ids FROM closed;
 UPDATE public.commerce_checkout_recovery_tokens token SET revoked_at=p_requested_at
  WHERE token.revoked_at IS NULL AND token.order_id IN (SELECT orders.id FROM public.commerce_orders orders
   JOIN public.subscription_dunning_cases cases ON cases.cycle_id=orders.subscription_cycle_id WHERE cases.id=ANY(closed_ids));
 UPDATE public.subscription_dunning_notifications SET status='skipped',error='subscription_paused',recovery_url_path=NULL,updated_at=p_requested_at
  WHERE case_id=ANY(closed_ids) AND status='queued';
 PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_requested_at,'subscription_paused','skipped');
END;
$$;

CREATE FUNCTION public.subscription_apply_lifecycle_action(
  p_client_id uuid,
  p_idempotency_key text,
  p_subscription_id uuid,
  p_action text,
  p_payload jsonb,
  p_requested_at timestamptz,
  p_terms jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_existing public.subscription_events%ROWTYPE;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_reason text := NULLIF(v_payload->>'reason', '');
  v_preset text := COALESCE(NULLIF(v_payload->>'pausePreset', ''), 'indefinite');
  v_outcome text;
  v_event_id uuid;
  v_target timestamptz;
  v_ends_at timestamptz;
  term_key text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN
    ('pause', 'resume', 'skip_next_cycle', 'slide_next_cycle', 'cancel')
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_unsupported_action' USING ERRCODE = '22023';
  END IF;

  -- Long enough that a caller cannot reach it by accident: an idempotency key short enough
  -- to collide is worse than no key, because it silently suppresses a real second request.
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  IF p_client_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.clients client WHERE client.id = p_client_id)
  THEN
    RAISE EXCEPTION 'subscription_lifecycle_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = p_subscription_id
     AND client_id = p_client_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_lifecycle_forbidden' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.subscription_events
   WHERE subscription_id = p_subscription_id
     AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    v_outcome := 'replayed';
    v_event_id := v_existing.id;
  ELSE
  IF p_terms IS NULL OR jsonb_typeof(p_terms) IS DISTINCT FROM 'object'
    OR p_terms - ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays'] <> '{}'::jsonb
    OR NOT (p_terms ?& ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays']) THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR term_key IN SELECT jsonb_object_keys(p_terms) LOOP
    IF jsonb_typeof(p_terms->term_key) IS DISTINCT FROM 'number'
      OR NOT coalesce(p_terms->>term_key ~ '^[1-9][0-9]*$',false)
      OR (p_terms->>term_key)::numeric > 2147483647 THEN
      RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_terms->>'slideMinDays')::integer > (p_terms->>'slideMaxDays')::integer THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  IF p_action = 'pause' THEN
    IF v_subscription.status <> 'active'
      OR v_preset NOT IN ('2_weeks', '1_month', 'indefinite')
    THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    v_ends_at := CASE v_preset
      WHEN '2_weeks' THEN p_requested_at + make_interval(days=>(p_terms->>'pauseDays')::integer)
      WHEN '1_month' THEN p_requested_at + make_interval(months=>(p_terms->>'pauseMonths')::integer)
      ELSE NULL
    END;
    UPDATE public.subscriptions
       SET status = 'paused', updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
    INSERT INTO public.subscription_pause_windows
      (subscription_id, pause_preset, starts_at, ends_at, reason, idempotency_key)
    VALUES (p_subscription_id, v_preset, p_requested_at, v_ends_at, v_reason, p_idempotency_key);
  ELSIF p_action = 'resume' THEN
    IF v_subscription.status <> 'paused' THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=p_subscription_id AND status='open') THEN
      PERFORM public.subscription_terminalize_unpaid_artifacts(p_subscription_id,p_requested_at,'subscription_resumed','skipped');
    END IF;
    -- A subscription paused across one or more due dates resumes onto the next date the
    -- cadence would have produced, not onto a date in the past and not onto "today plus a
    -- cadence" -- whole cadences forward keeps every later date on the original grid.
    v_target := v_subscription.next_cycle_at;
    IF v_target IS NOT NULL AND v_target <= p_requested_at THEN
      v_target := v_target + ((
        floor(
          extract(epoch FROM (p_requested_at - v_target)) / (v_subscription.cadence_days * 86400.0)
        )::bigint + 1
      ) * v_subscription.cadence_days || ' days')::interval;
    END IF;
    UPDATE public.subscriptions
       SET status = 'active', next_cycle_at = v_target, updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
    UPDATE public.subscription_pause_windows
       SET resumed_at = p_requested_at, updated_at = p_requested_at
     WHERE subscription_id = p_subscription_id
       AND resumed_at IS NULL;
  ELSIF p_action = 'cancel' THEN
    IF v_subscription.status NOT IN ('active', 'paused') THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    UPDATE public.subscriptions
       SET status = 'cancelled',
           ended_at = COALESCE(ended_at, p_requested_at),
           cancellation_reason = COALESCE(NULLIF(v_payload #>> '{survey,reasonCode}', ''), v_reason),
           updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
  ELSIF p_action = 'skip_next_cycle' THEN
    IF v_subscription.status <> 'active' OR v_subscription.next_cycle_at IS NULL THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_skip' USING ERRCODE = '22023';
    END IF;
    IF p_requested_at > v_subscription.next_cycle_at-make_interval(hours=>v_subscription.edit_window_hours) THEN
      RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
    END IF;
    PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
      p_subscription_id, v_subscription.next_cycle_at
    );
    UPDATE public.subscriptions
       SET next_cycle_at =
             v_subscription.next_cycle_at + (v_subscription.cadence_days || ' days')::interval,
           updated_at = p_requested_at
     WHERE id = p_subscription_id
     RETURNING * INTO v_subscription;
  ELSE
    v_target := NULLIF(v_payload->>'newNextCycleAt', '')::timestamptz;
    IF v_subscription.status = 'active'
      AND v_subscription.next_cycle_at IS NOT NULL
      AND v_target IS NOT NULL
      -- Same calendar day, expressed as an epoch-day bucket so the kernel carries no
      -- embedded timezone: both operands are absolute instants and the division is exact.
      AND floor(extract(epoch FROM v_target) / 86400)
          = floor(extract(epoch FROM v_subscription.next_cycle_at) / 86400)
    THEN
      v_outcome := 'noop';
    ELSE
      -- Near enough and the cycle is already being prepared; far enough and the customer is
      -- not rescheduling a delivery, they are abandoning it -- that is what pause is for.
      IF v_subscription.status <> 'active'
        OR v_target IS NULL
        OR v_target < p_requested_at + make_interval(days=>(p_terms->>'slideMinDays')::integer)
        OR v_target > p_requested_at + make_interval(days=>(p_terms->>'slideMaxDays')::integer)
      THEN
        RAISE EXCEPTION 'subscription_lifecycle_invalid_slide' USING ERRCODE = '22023';
      END IF;
      IF p_requested_at > v_subscription.next_cycle_at-make_interval(hours=>v_subscription.edit_window_hours) THEN
        RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
      END IF;
      PERFORM public.subscription_lifecycle_assert_unlocked_cycle(
        p_subscription_id, v_subscription.next_cycle_at
      );
      UPDATE public.subscriptions
         SET next_cycle_at = v_target, updated_at = p_requested_at
       WHERE id = p_subscription_id
       RETURNING * INTO v_subscription;
    END IF;
  END IF;

  END IF;

  IF v_outcome IS NULL THEN
    INSERT INTO public.subscription_events
      (subscription_id, event_type, idempotency_key, payload, occurred_at)
    VALUES (
      p_subscription_id,
      'subscription.customer_self_service.' || p_action,
      p_idempotency_key,
      jsonb_build_object('action', p_action, 'payload', v_payload, 'reason', v_reason),
      p_requested_at
    )
    RETURNING id INTO v_event_id;
    UPDATE public.subscription_pause_windows
       SET event_id = v_event_id, updated_at = p_requested_at
     WHERE subscription_id = p_subscription_id
       AND idempotency_key = p_idempotency_key;
    v_outcome := 'applied';
  END IF;

  RETURN jsonb_build_object(
    'contractVersion', 'platform.subscription.lifecycle.v1',
    'subscriptionAction', jsonb_build_object(
      'subscriptionId', p_subscription_id,
      'action', p_action,
      'status', v_outcome,
      'subscriptionStatus', v_subscription.status,
      'nextCycleAt', v_subscription.next_cycle_at,
      'eventId', v_event_id
    )
  );
END;
$$;

CREATE FUNCTION public.subscription_command_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz,p_terms jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
<<apply_command>>
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text; quote_fingerprint text; answer jsonb;
 reason text; event_id uuid; event_key text; line jsonb; target timestamptz; outcome text:='applied'; term_key text;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 quote_fingerprint:=encode(sha256(convert_to(jsonb_set(command,'{payload}',p_payload-'acceptedQuoteHash')::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.command_fingerprint<>(CASE WHEN r.status='previewed' THEN quote_fingerprint ELSE fingerprint END)
   OR r.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  IF r.status<>'previewed' THEN
   IF r.status='refused' THEN RETURN r.result; END IF;
   RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status);
  END IF;
 END IF;
 event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
 BEGIN
  IF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel','order_now','reactivate') THEN
  IF p_terms IS NULL OR jsonb_typeof(p_terms) IS DISTINCT FROM 'object'
    OR p_terms - ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays'] <> '{}'::jsonb
    OR NOT (p_terms ?& ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays']) THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR term_key IN SELECT jsonb_object_keys(p_terms) LOOP
    IF jsonb_typeof(p_terms->term_key) IS DISTINCT FROM 'number'
      OR NOT coalesce(p_terms->>term_key ~ '^[1-9][0-9]*$',false)
      OR (p_terms->>term_key)::numeric > 2147483647 THEN
      RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_terms->>'slideMinDays')::integer > (p_terms->>'slideMaxDays')::integer THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  END IF;
  IF p_action='pause' THEN
   PERFORM public.subscription_pause_close_recovery(p_client_id,event_key,s.id,p_now);
  END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  -- Take the same subscription lock as claim first, then the future
  -- terms and every line. A previously deferred operation keeps its snapshot.
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  -- Existing preparation owns the operation before it inserts a cycle. Do
  -- not wait in the reverse lock order: refuse a busy operation, or a live
  -- pre-payment lease whose worker could still prepare after this command.
  IF p_action IN ('cancel','resume','skip_next_cycle','slide_next_cycle','order_now','reactivate')
   AND NOT (p_action='slide_next_cycle' AND floor(extract(epoch FROM (p_payload->>'newNextCycleAt')::timestamptz)/86400)
     =floor(extract(epoch FROM s.next_cycle_at)/86400)) THEN
   BEGIN
    PERFORM 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
   EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'subscription_command_operation_busy' USING ERRCODE='22023';
   END;
   IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
     AND (state='attempt_prepared' OR (state IN ('claimed','reserved') AND lease_expires_at>p_now))) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length','add_addon','remove_addon','update_addon_quantity') THEN
   IF NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   SELECT * INTO q FROM public.subscription_edit_quotes WHERE subscription_id=s.id AND idempotency_key=event_key FOR UPDATE;
   IF NOT FOUND OR q.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023';
   END IF;
   IF q.request_fingerprint<>quote_fingerprint OR s.template_version<>q.expected_template_version THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
   END IF;
   IF q.status<>'previewed' OR q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
   IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=q.currency_code) THEN
    RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023';
   END IF;
   IF (SELECT jsonb_agg(jsonb_build_object('lineOrdinal',(v->>'sortOrder')::integer+1,'sku',sku.sku,
      'quantity',(v->>'quantity')::integer,'unitAmountMinor',(v->>'unitPriceMinor')::bigint) ORDER BY (v->>'sortOrder')::integer)
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid)
     =(SELECT jsonb_agg(jsonb_build_object('lineOrdinal',line_ordinal,'sku',sku,'quantity',quantity,'unitAmountMinor',unit_amount_minor)
       ORDER BY line_ordinal) FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id)
    AND s.cadence_days=q.proposed_cadence_days AND q.proposed_lines=(SELECT COALESCE(jsonb_agg(jsonb_build_object(
     'variantId',variant_id,'quantity',quantity,'isAddon',is_addon,'sortOrder',sort_order,'unitPriceMinor',unit_price_minor,'currency',currency_code)
     ORDER BY sort_order,id),'[]') FROM public.subscription_lines WHERE subscription_id=s.id) THEN
    outcome:='noop';
   ELSE
    DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
    FOR line IN SELECT value FROM jsonb_array_elements(q.proposed_lines) LOOP
     INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES(s.id,(line->>'variantId')::uuid,(line->>'quantity')::integer,(line->>'sortOrder')::integer,
       (line->>'isAddon')::boolean,(line->>'unitPriceMinor')::bigint,q.currency_code);
    END LOOP;
    DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
    INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
     SELECT s.id,(v->>'sortOrder')::integer+1,sku.sku,(v->>'quantity')::integer,(v->>'unitPriceMinor')::bigint
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid;
    UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
    UPDATE public.subscriptions SET cadence_days=q.proposed_cadence_days,template_version=template_version+1,updated_at=p_now
     WHERE id=s.id RETURNING * INTO s;
   END IF;
  ELSIF p_action IN ('order_now','reactivate') THEN
   IF p_payload->'confirmedChargeTiming' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'subscription_command_charge_timing_not_confirmed' USING ERRCODE='22023';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy')
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   IF (p_action='order_now' AND (s.status<>'active' OR s.next_cycle_at IS NULL))
    OR (p_action='reactivate' AND s.status<>'cancelled') THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF p_action='order_now' AND p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   target:=p_now+CASE p_action WHEN 'order_now' THEN make_interval(mins=>(p_terms->>'orderNowDelayMinutes')::integer)
    ELSE make_interval(days=>(p_terms->>'reactivateDelayDays')::integer) END;
   UPDATE public.subscriptions SET status='active',next_cycle_at=target,ended_at=NULL,cancellation_reason=NULL,
    template_version=template_version+CASE WHEN p_action='reactivate' THEN 1 ELSE 0 END,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  ELSIF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel') THEN
   IF p_action='cancel' THEN
    IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
      AND attempt_prepared_at IS NOT NULL AND state NOT IN ('succeeded','refused'))
     OR EXISTS(SELECT 1 FROM public.subscription_retry_obligations WHERE subscription_id=s.id AND state='prepared') THEN
     RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
    END IF;
    UPDATE public.subscription_dunning_notifications SET status='skipped',recovery_url_path=NULL,
     error='subscription_cancelled',updated_at=p_now WHERE status='queued' AND case_id IN
      (SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open');
    UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=p_now WHERE revoked_at IS NULL AND order_id IN
      (SELECT orders.id FROM public.commerce_orders orders JOIN public.subscription_dunning_cases cases
        ON cases.cycle_id=orders.subscription_cycle_id WHERE cases.subscription_id=s.id AND cases.status='open');
    UPDATE public.subscription_dunning_cases SET status='cancelled',next_retry_at=NULL,updated_at=p_now
     WHERE subscription_id=s.id AND status='open';
   END IF;
   IF p_action IN ('skip_next_cycle','slide_next_cycle') AND NOT EXISTS(
    SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   -- Do not move away from a current payment obligation on resume.
   IF p_action='resume' AND s.status='paused' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_resumed','skipped');
   END IF;
   IF p_action='resume' THEN PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at); END IF;
   IF p_action='cancel' THEN
    -- Operation locks above fence every worker; only elapsed, never-prepared
    -- obligations may be cancelled here. Paid/ambiguous commitments stay owned.
    UPDATE public.fulfillment_inventory_reservations stock_hold SET status='released',expires_at=NULL,
     terminal_reason='subscription_cancelled',updated_at=p_now
     FROM public.subscription_renewal_operations op WHERE op.subscription_id=s.id
      AND stock_hold.renewal_operation_id=op.id AND stock_hold.status='held'
      AND op.state IN ('claimed','reserved') AND op.attempt_prepared_at IS NULL
      AND op.external_attempt_ref IS NULL;
    UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',
     terminal_reason='subscription_cancelled',terminal_at=p_now,updated_at=p_now
     WHERE subscription_id=s.id AND state IN ('claimed','reserved') AND attempt_prepared_at IS NULL
      AND external_attempt_ref IS NULL;
   END IF;
   answer:=public.subscription_apply_lifecycle_action(p_client_id,event_key,s.id,p_action,p_payload,p_now,p_terms);
   IF p_action='cancel' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_cancelled','cancelled');
   END IF;
   outcome:=answer#>>'{subscriptionAction,status}';
   event_id:=(answer#>>'{subscriptionAction,eventId}')::uuid;
   SELECT * INTO s FROM public.subscriptions WHERE id=s.id;
  ELSE
   RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023';
  END IF;
  IF answer IS NULL AND outcome='applied' THEN
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
    VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'payload',p_payload,
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
    RETURNING id INTO event_id;
  END IF;
  IF q.id IS NOT NULL AND outcome='applied' THEN
   UPDATE public.subscription_edit_quotes SET status='accepted',accepted_event_id=event_id,accepted_at=p_now WHERE id=q.id;
  END IF;
  answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
   'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  answer:=jsonb_build_object('status','refused','reason',reason);
 END;
 IF r.id IS NULL THEN
  INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
   VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload->>'acceptedQuoteHash',answer,answer->>'status');
 ELSE
  UPDATE public.subscription_command_receipts SET command_fingerprint=fingerprint,command=apply_command.command,result=answer,status=answer->>'status'
   WHERE id=r.id;
 END IF;
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_apply_lifecycle_action(
  p_client_id uuid,
  p_idempotency_key text,
  p_subscription_id uuid,
  p_action text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
 RETURN public.subscription_apply_lifecycle_action(p_client_id,p_idempotency_key,p_subscription_id,p_action,p_payload,p_requested_at,'{"pauseDays":14,"pauseMonths":1,"slideMinDays":3,"slideMaxDays":60,"orderNowDelayMinutes":5,"reactivateDelayDays":2}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_command_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RETURN public.subscription_command_apply(p_actor_id,p_client_id,p_key,p_subscription_id,p_action,p_payload,p_now,'{"pauseDays":14,"pauseMonths":1,"slideMinDays":3,"slideMaxDays":60,"orderNowDelayMinutes":5,"reactivateDelayDays":2}'::jsonb);
END;
$$;

CREATE VIEW public.subscription_retention_outcomes AS
 SELECT e.id AS event_id,e.subscription_id,e.event_type,e.occurred_at,
 nullif(e.payload#>>'{payload,survey,reasonCode}','') AS cancel_reason_code,
 nullif(e.payload#>>'{payload,survey,comment}','') AS cancel_comment,
 nullif(e.payload#>>'{payload,survey,acceptedSaveOfferId}','') AS accepted_save_offer_id,
 nullif(e.payload#>>'{payload,saveOffer,offerId}','') AS save_offer_id,
 nullif(e.payload#>>'{payload,saveOffer,kind}','') AS save_offer_kind,
 CASE e.payload#>>'{payload,saveOffer,accepted}' WHEN 'true' THEN true WHEN 'false' THEN false ELSE NULL END AS save_offer_accepted,
 nullif(e.payload#>>'{payload,saveOffer,externalOfferRef}','') AS external_offer_ref
 FROM public.subscription_events e WHERE e.event_type IN ('subscription.customer_self_service.cancel','subscription.customer_self_service.pause')
 AND (e.payload#>'{payload,survey}' IS NOT NULL OR e.payload#>'{payload,saveOffer}' IS NOT NULL);
REVOKE ALL ON TABLE public.subscription_retention_outcomes FROM PUBLIC;

REVOKE ALL ON FUNCTION public.subscription_terminalize_unpaid_artifacts(uuid,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_pause_close_recovery(uuid,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_terminalize_unpaid_artifacts(uuid,timestamptz,text,text), public.subscription_pause_close_recovery(uuid,text,uuid,timestamptz), public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb), public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_retention_outcomes FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_terminalize_unpaid_artifacts(uuid,timestamptz,text,text), public.subscription_pause_close_recovery(uuid,text,uuid,timestamptz), public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb), public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_retention_outcomes FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_terminalize_unpaid_artifacts(uuid,timestamptz,text,text), public.subscription_pause_close_recovery(uuid,text,uuid,timestamptz), public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz,jsonb), public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz,jsonb) TO service_role'; END IF; END; $$;
