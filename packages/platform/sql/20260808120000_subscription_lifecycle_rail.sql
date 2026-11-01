-- Public platform subscription lifecycle rail: the subscription row, its append-only event
-- ledger, its pause windows, the two shapes the locked-cycle guard reads, and the one
-- function that moves a subscription between states on a customer's own request.
--
-- WHAT THIS FORWARD SHIPS. Five relations and two functions. It is the second bundle's
-- first business state machine: #2472 gave it reads, #2476 gave it a queue, this gives it a
-- mutation a customer can ask for. The vocabulary is exactly five actions -- pause, resume,
-- skip_next_cycle, slide_next_cycle, cancel -- with an owner check, an idempotency ledger,
-- a locked-cycle refusal, a same-day slide no-op, and named refusals for everything else.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP, so a reader does not go looking for it:
--   * no package or composition editing, and none of the product-specific actions that go
--     with it -- a public contract must not carry a product's vocabulary;
--   * no enqueue. Nothing here writes a queue row, and no trigger is created on any table
--     below. A capability that owns a notification owns its own enqueue;
--   * no dunning gate and no payment-method gate: neither a dunning ledger nor a bound
--     payment method exists in this kernel, and a guard reading a table nobody authored is
--     decoration;
--   * no `SECURITY DEFINER`, no `GRANT`/`REVOKE`, no row-level security. This kernel
--     creates zero roles. The consequence must be said out loud rather than assumed:
--     ON THIS KERNEL THE FUNCTION BELOW IS NOT A SECURITY BOUNDARY. `p_client_id` is an
--     ownership argument supplied by a trusted caller, not a verified principal. The host
--     application is what authenticates; this function only refuses to act across owners.
--   * `SET search_path` is kept, because that one is a real injection-hardening property
--     that does not depend on a role model.
--
-- AUTHORED, NOT COPIED. Written for this migration against the composed observable
-- behaviour of the managed implementation, which is not a file but a stack of five
-- functions chained by rename. Named departures, in full: the five physical functions
-- collapse into one; ownership is an argument rather than a lookup through a managed
-- identity table; the product-editing half and its actions are absent; the cancel path
-- terminalizes nothing outside the subscription itself, because the five tables it would
-- terminalize are not authored here; the event ledger's idempotency key is NOT NULL and
-- unique PER SUBSCRIPTION rather than globally, which is the invariant the lookup actually
-- means; the status domain is three values rather than six, because the other three are
-- written by engines this kernel does not have, and the transition matrix therefore lives
-- in the function instead of in a trigger duplicating it; the same-calendar-day comparison
-- is an epoch-day bucket rather than an embedded timezone literal; every constraint is
-- named; and `CREATE` is unconditional, because a manifest-ordered forward runs exactly
-- once against a known prefix and `IF NOT EXISTS` there would hide the drift the migration
-- ledger exists to catch.

CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  cadence_days integer NOT NULL,
  next_cycle_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'paused', 'cancelled')),
  CONSTRAINT subscriptions_cadence_days_check CHECK (cadence_days > 0),
  CONSTRAINT subscriptions_ended_at_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX idx_subscriptions_client ON public.subscriptions (client_id);

-- Append-only. One row per accepted action, and the row IS the replay answer: a repeated
-- request carrying a key this subscription has already seen returns the stored outcome
-- instead of acting twice. The uniqueness is per subscription and the key is mandatory,
-- because a nullable key with a global unique index makes two unrelated subscriptions
-- collide on a value neither of them chose.
CREATE TABLE public.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_events_event_type_nonempty_check CHECK (btrim(event_type) <> ''),
  CONSTRAINT subscription_events_idempotency_key_nonempty_check CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT subscription_events_subscription_id_idempotency_key_key
    UNIQUE (subscription_id, idempotency_key)
);

CREATE INDEX idx_subscription_events_subscription
  ON public.subscription_events (subscription_id, occurred_at DESC);

-- A pause is an interval, not a flag. Keeping the window as its own row is what lets a
-- resume close the interval it opened, and what lets an operator answer "how long was this
-- subscription paused" without replaying the event ledger.
CREATE TABLE public.subscription_pause_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  pause_preset text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  resumed_at timestamptz,
  reason text,
  idempotency_key text NOT NULL,
  event_id uuid REFERENCES public.subscription_events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_pause_windows_pause_preset_check
    CHECK (pause_preset IN ('2_weeks', '1_month', 'indefinite')),
  CONSTRAINT subscription_pause_windows_ends_at_check CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT subscription_pause_windows_resumed_at_check
    CHECK (resumed_at IS NULL OR resumed_at >= starts_at),
  CONSTRAINT subscription_pause_windows_subscription_id_idempotency_key_key
    UNIQUE (subscription_id, idempotency_key)
);

CREATE INDEX idx_subscription_pause_windows_open
  ON public.subscription_pause_windows (subscription_id, starts_at DESC)
  WHERE resumed_at IS NULL;

-- The two shapes below exist for one reason: the locked-cycle guard reads them. They carry
-- the columns that guard needs and nothing else -- the renewal engine and the order
-- management capability own their own forwards and will widen them there.
CREATE TABLE public.subscription_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_cycles_status_check
    CHECK (status IN ('planned', 'payment_pending', 'paid', 'cancelled'))
);

CREATE INDEX idx_subscription_cycles_subscription_scheduled
  ON public.subscription_cycles (subscription_id, scheduled_at);

CREATE TABLE public.commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_cycle_id uuid REFERENCES public.subscription_cycles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_payment',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_orders_status_check
    CHECK (status IN ('pending_payment', 'paid', 'fulfillment_pending', 'fulfilled', 'cancelled'))
);

CREATE INDEX idx_commerce_orders_subscription_cycle
  ON public.commerce_orders (subscription_cycle_id)
  WHERE subscription_cycle_id IS NOT NULL;

-- Refuse to move a delivery whose money has already moved.
--
-- Two probes, and the second is not a duplicate of the first: a cycle can still read as
-- unpaid while the order it produced has been paid for and handed to fulfilment. Checking
-- only the cycle lets a customer reschedule a parcel that is already on its way, which is
-- the failure this guard exists to prevent. The comparison is on the exact scheduled
-- instant rather than on a range, because that instant is the identity of the cycle the
-- caller is trying to move.
CREATE FUNCTION public.subscription_lifecycle_assert_unlocked_cycle(
  p_subscription_id uuid,
  p_next_cycle_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.subscription_cycles cycle
     WHERE cycle.subscription_id = p_subscription_id
       AND cycle.scheduled_at = p_next_cycle_at
       AND cycle.status IN ('payment_pending', 'paid')
  ) THEN
    RAISE EXCEPTION 'subscription_lifecycle_payment_blocked' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.subscription_cycles cycle
      JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id
     WHERE cycle.subscription_id = p_subscription_id
       AND cycle.scheduled_at = p_next_cycle_at
       AND order_row.status IN ('paid', 'fulfillment_pending', 'fulfilled')
  ) THEN
    RAISE EXCEPTION 'subscription_lifecycle_payment_blocked' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Apply one lifecycle action on behalf of the subscription's owner.
--
-- The ordering of the first four steps is the contract, not a style choice:
--   1. the action and the idempotency key are validated before anything is read, so a
--      malformed request never takes a lock;
--   2. the owner is resolved, and a caller that is not the owner gets `forbidden` while a
--      caller that is nobody gets `not_found` -- two different answers, because collapsing
--      them turns an authorization failure into a lookup failure;
--   3. THE SUBSCRIPTION ROW IS LOCKED, and only then;
--   4. the event ledger is consulted for a replay.
-- Steps 3 and 4 in that order are the whole of the concurrency behaviour. Two callers
-- arriving at once serialize on the row, and the one that loses the race re-reads a ledger
-- that now contains the winner's event -- so a repeated request answers `replayed` instead
-- of acting twice, and two conflicting requests resolve to one action and one refusal.
-- Consulting the ledger first would let both callers pass, which is the classic
-- read-then-write race this function is written to not have.
--
-- Outcomes are `applied`, `replayed` or `noop`. `noop` exists for exactly one case: a slide
-- onto the day the subscription is already scheduled for. That is a customer confirming the
-- current date, not a reschedule, and answering it with a mutation would move the delivery
-- slot and write an event for a change nobody asked for.
CREATE FUNCTION public.subscription_apply_lifecycle_action(
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
  ELSIF p_action = 'pause' THEN
    IF v_subscription.status <> 'active'
      OR v_preset NOT IN ('2_weeks', '1_month', 'indefinite')
    THEN
      RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE = '22023';
    END IF;
    v_ends_at := CASE v_preset
      WHEN '2_weeks' THEN p_requested_at + interval '14 days'
      WHEN '1_month' THEN p_requested_at + interval '1 month'
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
        OR v_target < p_requested_at + interval '3 days'
        OR v_target > p_requested_at + interval '60 days'
      THEN
        RAISE EXCEPTION 'subscription_lifecycle_invalid_slide' USING ERRCODE = '22023';
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
