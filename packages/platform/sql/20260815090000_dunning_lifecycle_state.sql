-- Neutral dunning lifecycle state for the public platform rail.
--
-- WHAT THIS DELTA ADDS, AND WHY IT IS NOT ALREADY HERE. The rail already carries
-- the subscription kernel, the communications control plane, the transactional
-- delivery receipt, the customer self-service recovery token and the job-run
-- ledger. What it has never carried is the state a FAILED renewal payment
-- produces, and three earlier forwards say so out loud rather than leaving it to
-- be discovered: the lifecycle kernel declines to gate on "a dunning ledger
-- nobody authored", and the settlement rail records that dunning, retries and
-- failure classification are capabilities of their own. Without the case that
-- stays open across attempts, the queued notice with its claim fence, the
-- per-recipient consent answer and the reminder ledger, a second runtime can
-- hold subscriptions but cannot run the lifecycle "charge failure -> case ->
-- consent -> notice -> reconciliation -> recovery OR pause after ladder
-- exhaustion" at all.
--
-- REUSED, NOT DUPLICATED. Four things this forward deliberately does not create.
-- The operator switch for a notice kind is the existing delivery-control row,
-- read here through one routine instead of a second control table. Delivery
-- evidence is the existing transactional delivery receipt; the reconciliation
-- routine settles a sent notice from that receipt and invents no outcome. The
-- repair link is the existing checkout recovery token, which this forward learns
-- to issue from a case for a runtime that has no browser principal to speak for.
-- Pause evidence is written into the existing pause window and event ledger
-- rather than into a private mirror.
--
-- AUTHORED, NOT COPIED. No table definition, routine body or column list is
-- lifted from the managed chain; this is written against the neutral port
-- contracts the application already declares. Named departures, in full: the
-- retry ladder is an ARGUMENT, never a schedule embedded in SQL -- the
-- application computes the next attempt instant from its one canonical cadence
-- and passes it in, and passing NULL is what terminates the ladder, so the two
-- rails cannot drift into two different schedules; the case carries a neutral
-- failure class as opaque text, with no gateway, instrument or vendor vocabulary
-- and no enumeration of them; amounts travel as minor units plus an ISO code
-- supplied by the caller, so no single currency is named; the notice queue holds
-- one row per case, kind and attempt, which is what "a replay sends nothing
-- twice" actually means; consent is keyed by a recipient FINGERPRINT, never by an
-- address, matching the control plane's existing rule that this rail stores no
-- recipient address; the health state a forward-looking notice reads is one
-- explicit column rather than a derived view, because deriving it needs an
-- instrument model this rail does not have; and every CREATE is unconditional,
-- because a manifest-ordered forward runs exactly once against a known prefix.
--
-- SECURITY MODEL. Same as the rest of this rail: every routine is invoker-rights
-- with a fixed search path, no role is created, no grant is issued, no row level
-- security policy is added, and every new table and routine is revoked from
-- PUBLIC and from both browser roles. The caller is the application's own
-- connection lane; ownership arguments are trusted inputs, not verified
-- principals.

CREATE TABLE public.subscription_dunning_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  cycle_id uuid REFERENCES public.subscription_cycles(id) ON DELETE SET NULL,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open',
  retry_attempt integer NOT NULL DEFAULT 1,
  next_retry_at timestamptz,
  failure_class text,
  failure_reason text,
  amount_minor bigint,
  amount_currency text,
  idempotency_key text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  expired_at timestamptz,
  CONSTRAINT subscription_dunning_cases_status_check
    CHECK (status IN ('open', 'recovered', 'expired', 'cancelled')),
  CONSTRAINT subscription_dunning_cases_retry_attempt_check CHECK (retry_attempt >= 1),
  CONSTRAINT subscription_dunning_cases_amount_check
    CHECK ((amount_minor IS NULL) = (amount_currency IS NULL)),
  CONSTRAINT subscription_dunning_cases_amount_currency_check
    CHECK (amount_currency IS NULL OR amount_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT subscription_dunning_cases_idempotency_key_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT subscription_dunning_cases_recovered_at_check
    CHECK ((status = 'recovered') = (recovered_at IS NOT NULL)),
  CONSTRAINT subscription_dunning_cases_expired_at_check
    CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
  CONSTRAINT subscription_dunning_cases_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT subscription_dunning_cases_cycle_id_key UNIQUE (cycle_id)
);

CREATE INDEX idx_subscription_dunning_cases_open
  ON public.subscription_dunning_cases (subscription_id, opened_at DESC)
  WHERE status = 'open';

CREATE INDEX idx_subscription_dunning_cases_recovered
  ON public.subscription_dunning_cases (recovered_at)
  WHERE status = 'recovered';

-- The queued customer notice. `claim_token` is the fence: a worker that lost its
-- lease to a takeover cannot settle a row it no longer holds, because every
-- settle routine compares the token it was handed with the one stored here.
CREATE TABLE public.subscription_dunning_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.subscription_dunning_cases(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  recipient_ref uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  recipient_kind text NOT NULL DEFAULT 'customer',
  notification_kind text NOT NULL,
  template_slug text NOT NULL,
  retry_attempt integer NOT NULL DEFAULT 0,
  recovery_url_path text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_expires_at timestamptz,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  settled_at timestamptz,
  error text,
  delivery_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_dunning_notifications_kind_check
    CHECK (notification_kind IN ('payment_failed', 'payment_expired', 'payment_recovered')),
  CONSTRAINT subscription_dunning_notifications_recipient_kind_check
    CHECK (recipient_kind IN ('customer', 'operator')),
  CONSTRAINT subscription_dunning_notifications_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  CONSTRAINT subscription_dunning_notifications_template_slug_check
    CHECK (btrim(template_slug) <> ''),
  CONSTRAINT subscription_dunning_notifications_retry_attempt_check
    CHECK (retry_attempt >= 0),
  CONSTRAINT subscription_dunning_notifications_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT subscription_dunning_notifications_sending_lease_check
    CHECK (status <> 'sending' OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT subscription_dunning_notifications_case_kind_attempt_key
    UNIQUE (case_id, notification_kind, retry_attempt)
);

CREATE INDEX idx_subscription_dunning_notifications_due
  ON public.subscription_dunning_notifications (scheduled_at)
  WHERE status = 'queued';

CREATE INDEX idx_subscription_dunning_notifications_case
  ON public.subscription_dunning_notifications (case_id, created_at);

-- The ledger a forward-looking notice writes so it cannot repeat. The day, not
-- the instant, is the identity: a reminder is something a customer receives once
-- for one upcoming renewal.
CREATE TABLE public.subscription_reminder_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  reminder_kind text NOT NULL,
  reminder_day date NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_reminder_ledger_kind_check
    CHECK (reminder_kind IN ('renewal_due_soon', 'pause_ending')),
  CONSTRAINT subscription_reminder_ledger_subscription_kind_day_key
    UNIQUE (subscription_id, reminder_kind, reminder_day)
);

-- The per-recipient answer the send path asks before it sends. Keyed by
-- fingerprint because this rail stores no recipient address; `granted` is
-- recorded for completeness, but only `denied` and `suppressed` are a refusal.
CREATE TABLE public.communication_recipient_consents (
  recipient_fingerprint text NOT NULL,
  purpose text NOT NULL,
  state text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_recipient_consents_pkey
    PRIMARY KEY (recipient_fingerprint, purpose),
  CONSTRAINT communication_recipient_consents_fingerprint_check
    CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT communication_recipient_consents_purpose_check CHECK (btrim(purpose) <> ''),
  CONSTRAINT communication_recipient_consents_state_check
    CHECK (state IN ('granted', 'denied', 'suppressed'))
);

-- Whether the NEXT renewal of a subscription is already known to be
-- unchargeable. One explicit column, written by whatever payment capability the
-- deployment installed; this rail asserts nothing about how it is decided.
CREATE TABLE public.subscription_method_states (
  subscription_id uuid PRIMARY KEY REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  health_state text NOT NULL DEFAULT 'healthy',
  narrow_activation_gap boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_method_states_health_state_check
    CHECK (health_state IN (
      'healthy', 'method_missing', 'mandate_not_chargeable_unattended', 'pending_activation'
    ))
);

REVOKE ALL ON TABLE
  public.subscription_dunning_cases,
  public.subscription_dunning_notifications,
  public.subscription_reminder_ledger,
  public.communication_recipient_consents,
  public.subscription_method_states
FROM PUBLIC, anon, authenticated;

-- Queue one notice for a case, or answer with the notice that is already there.
-- Every producer below goes through this, so "one notice per case, kind and
-- attempt" is enforced in exactly one place instead of in four.
CREATE FUNCTION public.dunning_lifecycle_queue_notice(
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
      AND retry_attempt = v_attempt;
  END IF;

  RETURN v_id;
END;
$$;

-- Open a case for one failed renewal payment, and queue the notice that belongs
-- to its attempt. The idempotency key IS the replay answer: a second call
-- carrying a key this rail already accepted returns the stored case and queues
-- nothing.
CREATE FUNCTION public.dunning_lifecycle_open_case(
  p_idempotency_key text,
  p_subscription_id uuid,
  p_cycle_id uuid,
  p_client_id uuid,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_occurred_at timestamptz,
  p_amount_minor bigint,
  p_amount_currency text,
  p_template_slug text,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_notification_id uuid;
  v_at timestamptz := COALESCE(p_occurred_at, now());
BEGIN
  SELECT * INTO v_case
  FROM public.subscription_dunning_cases
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'replayed', true
    );
  END IF;

  INSERT INTO public.subscription_dunning_cases (
    subscription_id, cycle_id, client_id, retry_attempt, next_retry_at,
    failure_class, failure_reason, amount_minor, amount_currency, idempotency_key,
    opened_at, updated_at
  ) VALUES (
    p_subscription_id, p_cycle_id, p_client_id, GREATEST(COALESCE(p_retry_attempt, 1), 1),
    p_next_retry_at, p_failure_class, p_failure_reason, p_amount_minor, p_amount_currency,
    p_idempotency_key, v_at, v_at
  )
  RETURNING * INTO v_case;

  v_notification_id := public.dunning_lifecycle_queue_notice(
    v_case.id, 'payment_failed', p_template_slug, v_case.retry_attempt, p_recovery_url_path
  );

  RETURN jsonb_build_object(
    'caseId', v_case.id, 'caseStatus', v_case.status, 'replayed', false,
    'notificationId', v_notification_id
  );
END;
$$;

-- Claim a batch of due notices under a fresh lease. A row whose lease has run
-- out is taken over with a NEW token, which is what makes a crashed worker's row
-- recoverable without letting the crashed worker settle it afterwards.
CREATE FUNCTION public.subscription_dunning_claim_batch(
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
    WHERE attempt_count < GREATEST(COALESCE(p_max_attempts, 1), 1)
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

-- Settle a claimed notice as delivered. Answers false when the caller no longer
-- holds the lease it is trying to settle.
CREATE FUNCTION public.subscription_dunning_mark_sent(
  p_id uuid,
  p_claim_token uuid,
  p_delivery_id text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.subscription_dunning_notifications
  SET status = 'sent',
      sent_at = now(),
      settled_at = now(),
      delivery_ref = p_delivery_id,
      error = NULL,
      claim_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = p_id AND claim_token = p_claim_token AND status = 'sending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- Settle a claimed notice as requeued, terminally failed, or skipped. The skip
-- reason is durable text, so a refusal is a row an operator can count rather
-- than a send that quietly did not happen.
CREATE FUNCTION public.subscription_dunning_mark_result(
  p_id uuid,
  p_claim_token uuid,
  p_status text,
  p_error text,
  p_reschedule_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('queued', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'subscription_dunning_result_status_invalid';
  END IF;

  UPDATE public.subscription_dunning_notifications
  SET status = p_status,
      error = p_error,
      scheduled_at = CASE
        WHEN p_status = 'queued' THEN COALESCE(p_reschedule_at, scheduled_at)
        ELSE scheduled_at
      END,
      settled_at = CASE WHEN p_status = 'queued' THEN NULL ELSE now() END,
      claim_token = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = p_id AND claim_token = p_claim_token AND status = 'sending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- Advance an open case after another failed attempt.
--
-- `p_next_retry_at` IS the ladder decision, computed by the application from its
-- one canonical cadence and handed in. A non-null instant keeps the case open
-- and queues the notice for that attempt. NULL means the ladder is exhausted:
-- the case expires, the final notice is queued, and the subscription is PAUSED
-- with durable evidence in the pause window and event ledger this rail owns.
CREATE FUNCTION public.dunning_lifecycle_handle_failure(
  p_case_id uuid,
  p_occurred_at timestamptz,
  p_failure_class text,
  p_failure_reason text,
  p_retry_attempt integer,
  p_next_retry_at timestamptz,
  p_template_slug text,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_notification_id uuid;
  v_pause_window_id uuid;
  v_event_id uuid;
  v_at timestamptz := COALESCE(p_occurred_at, now());
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;
  IF v_case.status <> 'open' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'paused', false, 'terminal', true
    );
  END IF;

  IF p_next_retry_at IS NOT NULL THEN
    UPDATE public.subscription_dunning_cases
    SET retry_attempt = GREATEST(COALESCE(p_retry_attempt, v_case.retry_attempt + 1), 1),
        next_retry_at = p_next_retry_at,
        failure_class = COALESCE(p_failure_class, failure_class),
        failure_reason = COALESCE(p_failure_reason, failure_reason),
        updated_at = v_at
    WHERE id = v_case.id
    RETURNING * INTO v_case;

    v_notification_id := public.dunning_lifecycle_queue_notice(
      v_case.id, 'payment_failed', p_template_slug, v_case.retry_attempt, p_recovery_url_path
    );
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
      'retryAttempt', v_case.retry_attempt, 'paused', false, 'terminal', false
    );
  END IF;

  UPDATE public.subscription_dunning_cases
  SET status = 'expired',
      expired_at = v_at,
      next_retry_at = NULL,
      failure_class = COALESCE(p_failure_class, failure_class),
      failure_reason = COALESCE(p_failure_reason, failure_reason),
      updated_at = v_at
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  v_notification_id := public.dunning_lifecycle_queue_notice(
    v_case.id, 'payment_expired', p_template_slug, 0, p_recovery_url_path
  );

  INSERT INTO public.subscription_events (
    subscription_id, event_type, idempotency_key, payload, occurred_at
  ) VALUES (
    v_case.subscription_id, 'dunning_ladder_exhausted',
    'dunning-exhausted:' || v_case.id::text,
    jsonb_build_object('caseId', v_case.id, 'retryAttempt', v_case.retry_attempt),
    v_at
  )
  ON CONFLICT ON CONSTRAINT subscription_events_subscription_id_idempotency_key_key DO NOTHING
  RETURNING id INTO v_event_id;

  INSERT INTO public.subscription_pause_windows (
    subscription_id, pause_preset, starts_at, reason, idempotency_key, event_id
  ) VALUES (
    v_case.subscription_id, 'indefinite', v_at, 'dunning_ladder_exhausted',
    'dunning-exhausted:' || v_case.id::text, v_event_id
  )
  ON CONFLICT ON CONSTRAINT subscription_pause_windows_subscription_id_idempotency_key_key
  DO NOTHING
  RETURNING id INTO v_pause_window_id;

  UPDATE public.subscriptions
  SET status = 'paused', updated_at = v_at
  WHERE id = v_case.subscription_id AND status = 'active';

  RETURN jsonb_build_object(
    'caseId', v_case.id, 'caseStatus', v_case.status, 'notificationId', v_notification_id,
    'retryAttempt', v_case.retry_attempt, 'paused', true,
    'pauseWindowId', v_pause_window_id, 'terminal', true
  );
END;
$$;

-- Close a case because the money finally moved. Replay-safe: a second call
-- answers the recorded recovery instead of recording a second one, and the
-- still-queued notices of a recovered case are settled as skipped rather than
-- left to be sent to somebody who has already paid.
CREATE FUNCTION public.dunning_lifecycle_record_recovery(
  p_case_id uuid,
  p_recovered_at timestamptz,
  p_template_slug text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_notice_id uuid;
  v_at timestamptz := COALESCE(p_recovered_at, now());
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;
  IF v_case.status = 'recovered' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'replayed', true
    );
  END IF;
  IF v_case.status <> 'open' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id, 'caseStatus', v_case.status, 'replayed', false,
      'refused', 'case_not_open'
    );
  END IF;

  UPDATE public.subscription_dunning_cases
  SET status = 'recovered', recovered_at = v_at, next_retry_at = NULL, updated_at = v_at
  WHERE id = v_case.id
  RETURNING * INTO v_case;

  UPDATE public.subscription_dunning_notifications
  SET status = 'skipped', error = 'case_recovered', settled_at = v_at,
      claim_token = NULL, lease_expires_at = NULL, updated_at = v_at
  WHERE case_id = v_case.id AND status = 'queued';

  UPDATE public.commerce_checkout_recovery_tokens AS t
  SET revoked_at = v_at
  FROM public.commerce_orders AS o
  WHERE t.order_id = o.id
    AND t.revoked_at IS NULL
    AND v_case.cycle_id IS NOT NULL
    AND o.subscription_cycle_id = v_case.cycle_id;

  v_notice_id := public.dunning_lifecycle_queue_notice(
    v_case.id, 'payment_recovered', p_template_slug, 0, NULL
  );

  RETURN jsonb_build_object(
    'caseId', v_case.id, 'caseStatus', v_case.status, 'replayed', false,
    'notificationId', v_notice_id
  );
END;
$$;

-- Issue the repair link for a case into the EXISTING recovery-token state.
--
-- The token state this rail already carries is issued through an authenticated
-- actor wrapper, which a scheduled runtime has no principal for. This routine is
-- the missing service-side door onto the same table: it resolves the still
-- unpaid order behind the case's cycle, revokes any live token for it, and
-- stores only the hash. It creates no second token table and no second lookup.
CREATE FUNCTION public.dunning_lifecycle_issue_recovery_token(
  p_case_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_order_id uuid;
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;

  SELECT o.id INTO v_order_id
  FROM public.commerce_orders AS o
  WHERE o.subscription_cycle_id = v_case.cycle_id
    AND o.status = 'pending_payment'
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'refused', 'recoverable_order_unavailable');
  END IF;

  UPDATE public.commerce_checkout_recovery_tokens
  SET revoked_at = now()
  WHERE order_id = v_order_id AND revoked_at IS NULL;

  INSERT INTO public.commerce_checkout_recovery_tokens (
    order_id, client_id, token_hash, expires_at
  ) VALUES (v_order_id, v_case.client_id, p_token_hash, p_expires_at)
  ON CONFLICT ON CONSTRAINT commerce_checkout_recovery_tokens_token_hash_key DO NOTHING;

  RETURN jsonb_build_object('issued', true, 'orderId', v_order_id);
END;
$$;

-- Cases that recovered inside the window. Bounded on purpose: a case recovered
-- long ago must never suddenly produce a notice.
CREATE FUNCTION public.dunning_lifecycle_scan_recovered(
  p_window_days integer,
  p_limit integer
)
RETURNS TABLE (
  case_id uuid,
  subscription_id uuid,
  client_id uuid,
  recovered_at timestamptz,
  amount_minor bigint,
  amount_currency text
)
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, c.subscription_id, c.client_id, c.recovered_at, c.amount_minor, c.amount_currency
  FROM public.subscription_dunning_cases AS c
  WHERE c.status = 'recovered'
    AND c.recovered_at >= now() - make_interval(days => GREATEST(COALESCE(p_window_days, 1), 1))
  ORDER BY c.recovered_at
  LIMIT GREATEST(COALESCE(p_limit, 1), 1);
$$;

-- Subscriptions whose NEXT renewal is already known to be unchargeable, minus
-- the ones already inside an open case: that customer is hearing about this very
-- subscription today, and a second rail saying it again is the same news twice.
CREATE FUNCTION public.dunning_lifecycle_scan_at_risk(
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
  SELECT s.id, s.client_id, s.next_cycle_at, m.health_state
  FROM public.subscriptions AS s
  JOIN public.subscription_method_states AS m ON m.subscription_id = s.id
  WHERE s.status = 'active'
    AND m.narrow_activation_gap = false
    AND m.health_state IN ('mandate_not_chargeable_unattended', 'method_missing')
    AND s.next_cycle_at >= now() + make_interval(days => COALESCE(p_min_days, 0))
    AND s.next_cycle_at <= now() + make_interval(days => COALESCE(p_max_days, 0))
    AND NOT EXISTS (
      SELECT 1 FROM public.subscription_dunning_cases AS c
      WHERE c.subscription_id = s.id AND c.status = 'open'
    )
  ORDER BY s.next_cycle_at
  LIMIT GREATEST(COALESCE(p_limit, 1), 1);
$$;

-- Subscriptions whose renewal falls inside the courtesy window.
CREATE FUNCTION public.dunning_lifecycle_renewal_reminder_scan(
  p_min_days integer,
  p_max_days integer,
  p_limit integer
)
RETURNS TABLE (subscription_id uuid, client_id uuid, next_cycle_at timestamptz)
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  SELECT s.id, s.client_id, s.next_cycle_at
  FROM public.subscriptions AS s
  WHERE s.status = 'active'
    AND s.next_cycle_at >= now() + make_interval(days => COALESCE(p_min_days, 0))
    AND s.next_cycle_at <= now() + make_interval(days => COALESCE(p_max_days, 0))
  ORDER BY s.next_cycle_at
  LIMIT GREATEST(COALESCE(p_limit, 1), 1);
$$;

-- Write the courtesy reminder into the ledger, once per subscription and day.
CREATE FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_enqueued integer;
BEGIN
  WITH due AS (
    SELECT s.id AS subscription_id, (s.next_cycle_at AT TIME ZONE 'UTC')::date AS reminder_day
    FROM public.subscriptions AS s
    WHERE s.status = 'active'
      AND s.next_cycle_at IS NOT NULL
      AND s.next_cycle_at >= now()
    ORDER BY s.next_cycle_at
    LIMIT GREATEST(COALESCE(p_limit, 1), 1)
  ), written AS (
    INSERT INTO public.subscription_reminder_ledger (subscription_id, reminder_kind, reminder_day)
    SELECT due.subscription_id, 'renewal_due_soon', due.reminder_day FROM due
    ON CONFLICT ON CONSTRAINT subscription_reminder_ledger_subscription_kind_day_key DO NOTHING
    RETURNING id
  )
  SELECT count(*)::integer INTO v_enqueued FROM written;

  RETURN jsonb_build_object('enqueued', v_enqueued);
END;
$$;

-- Sweep the paused subscriptions whose pause is ending. It reports its counts in
-- the shape the lifecycle already speaks; the notice itself is the deployment's
-- transport concern, not this rail's.
CREATE FUNCTION public.dunning_lifecycle_pause_reminder_dispatch(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_scanned integer;
  v_queued integer;
BEGIN
  WITH due AS (
    SELECT w.subscription_id, (w.ends_at AT TIME ZONE 'UTC')::date AS reminder_day
    FROM public.subscription_pause_windows AS w
    JOIN public.subscriptions AS s ON s.id = w.subscription_id
    WHERE w.resumed_at IS NULL
      AND w.ends_at IS NOT NULL
      AND s.status = 'paused'
      AND w.ends_at >= now()
    ORDER BY w.ends_at
    LIMIT GREATEST(COALESCE(p_limit, 1), 1)
  ), written AS (
    INSERT INTO public.subscription_reminder_ledger (subscription_id, reminder_kind, reminder_day)
    SELECT due.subscription_id, 'pause_ending', due.reminder_day FROM due
    ON CONFLICT ON CONSTRAINT subscription_reminder_ledger_subscription_kind_day_key DO NOTHING
    RETURNING id
  )
  SELECT (SELECT count(*)::integer FROM due), (SELECT count(*)::integer FROM written)
  INTO v_scanned, v_queued;

  RETURN jsonb_build_object(
    'ok', true, 'scanned', v_scanned, 'queued', v_queued,
    'sent', 0, 'skipped', v_scanned - v_queued, 'failed', 0
  );
END;
$$;

-- The recipient facts one notice needs, and nothing else about the person. An
-- unknown client answers NULL rather than a fabricated row.
CREATE FUNCTION public.dunning_lifecycle_recipient(p_client_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object('email', c.email, 'firstName', c.first_name, 'country', c.country)
  FROM public.clients AS c
  WHERE c.id = p_client_id;
$$;

-- The operator-wide switch for a notice kind, read off the delivery controls
-- this rail already carries. Only an explicitly disabled control answers false,
-- so a control nobody ever configured does not silence a transactional notice.
CREATE FUNCTION public.communications_notification_control_enabled(p_control_keys text[])
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.communication_delivery_controls AS c
    WHERE c.control_key = ANY (COALESCE(p_control_keys, ARRAY[]::text[]))
      AND c.enabled = false
  );
$$;

-- The per-recipient answer, by fingerprint. `refused` only for a recorded denial
-- or suppression; everything else is `unknown`, which the caller reads as allow.
CREATE FUNCTION public.communications_recipient_consent_state(
  p_recipient_fingerprint text,
  p_purposes text[]
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.communication_recipient_consents AS r
    WHERE r.recipient_fingerprint = p_recipient_fingerprint
      AND r.purpose = ANY (COALESCE(p_purposes, ARRAY[]::text[]))
      AND r.state IN ('denied', 'suppressed')
  ) THEN 'refused' ELSE 'unknown' END;
$$;

-- Record a recipient's answer, so a deployment can capture the state the gate
-- reads without reaching into the table from the application.
CREATE FUNCTION public.communications_record_recipient_consent(
  p_recipient_fingerprint text,
  p_purpose text,
  p_state text,
  p_captured_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.communication_recipient_consents (
    recipient_fingerprint, purpose, state, captured_at, updated_at
  ) VALUES (
    p_recipient_fingerprint, p_purpose, p_state,
    COALESCE(p_captured_at, now()), COALESCE(p_captured_at, now())
  )
  ON CONFLICT ON CONSTRAINT communication_recipient_consents_pkey
  DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at;
  RETURN p_state;
END;
$$;

-- Reconcile sent notices against the durable delivery receipt this rail already
-- writes. It reads evidence; it never invents an outcome, and a notice whose
-- receipt has not arrived stays exactly as it is.
CREATE FUNCTION public.dunning_lifecycle_reconcile_delivery(
  p_limit integer,
  p_grace_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_checked integer;
  v_reconciled integer;
BEGIN
  WITH frozen AS (
    SELECT n.id, n.delivery_ref
    FROM public.subscription_dunning_notifications AS n
    WHERE n.status = 'sent'
      AND n.delivery_ref IS NOT NULL
      AND n.sent_at <= now() - make_interval(mins => GREATEST(COALESCE(p_grace_minutes, 0), 0))
    ORDER BY n.sent_at
    LIMIT GREATEST(COALESCE(p_limit, 1), 1)
  ), evidence AS (
    SELECT frozen.id, r.state
    FROM frozen
    JOIN public.transactional_delivery_receipts AS r ON r.idempotency_key = frozen.delivery_ref
  ), settled AS (
    UPDATE public.subscription_dunning_notifications AS n
    SET settled_at = COALESCE(n.settled_at, now()),
        payload = n.payload || jsonb_build_object('deliveryState', evidence.state),
        updated_at = now()
    FROM evidence
    WHERE n.id = evidence.id
    RETURNING n.id
  )
  SELECT (SELECT count(*)::integer FROM frozen), (SELECT count(*)::integer FROM settled)
  INTO v_checked, v_reconciled;

  RETURN jsonb_build_object(
    'checked', v_checked, 'reconciled', v_reconciled, 'stillPending', v_checked - v_reconciled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dunning_lifecycle_queue_notice(uuid, text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_open_case(text, uuid, uuid, uuid, integer, timestamptz, text, text, timestamptz, bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_dunning_claim_batch(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_dunning_mark_sent(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_dunning_mark_result(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_handle_failure(uuid, timestamptz, text, text, integer, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_record_recovery(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_issue_recovery_token(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_scan_recovered(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_scan_at_risk(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_renewal_reminder_scan(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_pause_reminder_dispatch(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_recipient(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_notification_control_enabled(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_recipient_consent_state(text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_record_recipient_consent(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dunning_lifecycle_reconcile_delivery(integer, integer) FROM PUBLIC, anon, authenticated;
