-- A late settlement moves the subscription's next date out, and never pulls it in.
--
-- THIS FORWARD REPLACES public.commerce_record_settlement so that the schedule
-- advance it delegates -- "Departure 8", introduced by
-- 20260810180000_payment_settlement_rail.sql -- measures the whole days the
-- payment was LATE in addition to the cadence, and so that the write can only ever
-- move the date later.
--
-- WHAT WAS THERE, and why one cadence measured from the cycle is not enough:
--
--     next_cycle_at = v_cycle.scheduled_at + (cadence_days || ' days')::interval
--
-- Departure 8 chose the cycle rather than the instant the money arrived, and that
-- half of the ruling is CORRECT and is kept: an on-time settlement must land on
-- the original grid, to the second, not on whatever second a channel happened to
-- answer. What it did not account for is a settlement that arrives DAYS after the
-- cycle it pays for. A retry ladder above this kernel can carry a cycle a week and
-- a half past its scheduled date; the anchor did not move with it, so the interval
-- between the delivery just paid for and the next one shrank by exactly the delay.
-- On a 28-day cadence an eleven-day recovery leaves sixteen days between parcels,
-- which is the shape of a subscription that stacks goods on a customer who has not
-- consumed the previous ones yet.
--
-- The second defect was that the write was UNCONDITIONAL. Any rail above this one
-- that had already moved a subscription's date FURTHER out -- because a delivery
-- was delayed, replaced or re-sent -- had that later date silently overwritten by
-- this statement with an earlier one.
--
-- WHAT REPLACES IT:
--
--     next_cycle_at = GREATEST(next_cycle_at,
--       v_cycle.scheduled_at + make_interval(days =>
--         GREATEST(0, floor(extract(epoch FROM
--           (LEAST(p_occurred_at, now()) - v_cycle.scheduled_at)) / 86400.0)::int)
--         + cadence_days))
--
-- Read outward: whole days late (never a fraction of one, so an on-time or
-- minutes-late settlement truncates to zero and the anchor is byte-identical to
-- what this forward replaces); never negative, so paying early does not pull the
-- next delivery closer; LEAST bounds a channel that reports an instant in the
-- future, which is caller-supplied data this kernel does not trust; and the outer
-- GREATEST states the invariant directly -- this date extends or it stays, and
-- nothing here may move it earlier. GREATEST ignores NULL operands, so a
-- subscription with no date yet still receives the computed one. Lateness is
-- derived from p_occurred_at and never from a bare now(), so a replayed settlement
-- computes the same date it computed the first time.
--
-- PRESERVED, unchanged, from the definition this replaces: the validate-then-LOCK
-- ordering and the order-first lock sequence that keeps an opening caller and a
-- settling caller from deadlocking; the ledger-replay answer; Departure 3, the
-- outright refusal of a second settlement of a settled intent; the write-once
-- external reference; the cycle payability refusal; the `AND status = 'active'`
-- predicate that leaves a cancelled subscription's schedule alone; the declined
-- arm that leaves the order payable; and the transition row that ends the body.
-- The function keeps its argument list, its invoker rights, and its pinned
-- search_path, so this forward creates no table, index, trigger, role or grant.
--
-- WHY A NEW FORWARD RATHER THAN AN EDIT to 20260810180000: this catalogue's
-- migration runner asserts that the applied ledger is the EXACT manifest prefix,
-- sha256 included (server/adapters/postgres/migrationRunner.ts, readAppliedPrefix).
-- Rewriting a forward an adopter has already applied is therefore a hard boot
-- failure for that adopter, not a silent upgrade. Superseding it with a new
-- forward is what every previous replacement in this catalogue has done.

CREATE OR REPLACE FUNCTION public.commerce_record_settlement(
  p_idempotency_key text,
  p_intent_id uuid,
  p_outcome text,
  p_external_ref text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_from text;
  v_transition public.commerce_settlement_transitions%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_intent_id IS NULL
    OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed')
  THEN
    RAISE EXCEPTION 'commerce_settlement_record_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = p_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_settlement_record_intent_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders WHERE id = v_intent.order_id FOR UPDATE;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE id = p_intent_id FOR UPDATE;

  SELECT * INTO v_transition
    FROM public.commerce_settlement_transitions
   WHERE intent_id = p_intent_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN public.commerce_settlement_response(v_intent, v_transition.id, v_transition.outcome, true);
  END IF;

  IF v_intent.status = 'settled' THEN
    RAISE EXCEPTION 'commerce_settlement_record_intent_already_settled' USING ERRCODE = '22023';
  END IF;

  -- Write-once, and compared rather than overwritten: a channel that hands back a different handle
  -- for the same intent is describing a different payment.
  IF v_intent.external_ref IS NOT NULL AND p_external_ref IS NOT NULL
    AND v_intent.external_ref IS DISTINCT FROM p_external_ref
  THEN
    RAISE EXCEPTION 'commerce_settlement_record_external_reference_immutable' USING ERRCODE = '22023';
  END IF;

  v_from := v_intent.status;

  IF p_outcome = 'succeeded' THEN
    -- An order somebody took off the table between the ask and the answer is not paid into. The
    -- money question then belongs to whoever cancelled it, and this kernel has no refund verb.
    IF v_order.status <> 'pending_payment' THEN
      RAISE EXCEPTION 'commerce_settlement_record_order_not_payable' USING ERRCODE = '22023';
    END IF;

    UPDATE public.commerce_settlement_intents
       SET status = 'settled',
           settled_at = p_occurred_at,
           external_ref = COALESCE(external_ref, p_external_ref),
           failure_reason = NULL,
           updated_at = p_occurred_at
     WHERE id = p_intent_id
     RETURNING * INTO v_intent;

    -- The order transition is the delegation onto the order rail: that rail owns `paid`, owns the
    -- notification it produces, and its emitter fires from this statement without this forward
    -- restating a single line of it.
    UPDATE public.commerce_orders
       SET status = 'paid', paid_at = p_occurred_at, updated_at = p_occurred_at
     WHERE id = v_intent.order_id
     RETURNING * INTO v_order;

    IF v_order.subscription_cycle_id IS NOT NULL THEN
      SELECT * INTO v_cycle
        FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'commerce_settlement_record_cycle_not_found' USING ERRCODE = '22023';
      END IF;
      IF v_cycle.status NOT IN ('planned', 'payment_pending') THEN
        RAISE EXCEPTION 'commerce_settlement_record_cycle_not_payable' USING ERRCODE = '22023';
      END IF;

      SELECT * INTO v_subscription
        FROM public.subscriptions WHERE id = v_cycle.subscription_id FOR UPDATE;

      UPDATE public.subscription_cycles
         SET status = 'paid', updated_at = p_occurred_at
       WHERE id = v_cycle.id;

      -- Departure 8, revised: one cadence past the cycle that was just paid for PLUS the whole
      -- days the payment itself was late -- so a recovery that took eleven days moves the next
      -- delivery out by eleven days instead of stacking it on top of the parcel just shipped.
      -- Whole days only, so an on-time settlement still lands on the original grid, to the
      -- second. The inner GREATEST refuses a negative shift for an early payment; LEAST bounds a
      -- channel that reports a future instant; the outer GREATEST is the invariant itself -- this
      -- date may extend and may never move earlier, whoever set the value it is replacing. A
      -- subscription nobody is running any more is not slid: settlement truth still applies to a
      -- cancelled subscription, but its schedule is not this function's to revive.
      UPDATE public.subscriptions
         SET next_cycle_at = GREATEST(
               next_cycle_at,
               v_cycle.scheduled_at + make_interval(days =>
                 GREATEST(0, floor(extract(epoch FROM
                   (LEAST(p_occurred_at, now()) - v_cycle.scheduled_at)) / 86400.0)::int)
                 + cadence_days)),
             updated_at = p_occurred_at
       WHERE id = v_subscription.id
         AND status = 'active';

      INSERT INTO public.subscription_events
        (subscription_id, event_type, idempotency_key, payload, occurred_at)
      VALUES (v_subscription.id, 'subscription.cycle_settled',
              p_idempotency_key || ':subscription',
              jsonb_build_object('cycleId', v_cycle.id, 'orderId', v_order.id,
                                 'settlementId', v_intent.id),
              p_occurred_at)
      ON CONFLICT (subscription_id, idempotency_key) DO NOTHING;
    END IF;
  ELSE
    -- Departure 4: the order is untouched, so it stays `pending_payment` and can be settled again.
    UPDATE public.commerce_settlement_intents
       SET status = 'failed',
           external_ref = COALESCE(external_ref, p_external_ref),
           failure_reason = COALESCE(NULLIF(btrim(COALESCE(p_metadata, '{}'::jsonb)->>'reason'), ''),
                                     'declined'),
           updated_at = p_occurred_at
     WHERE id = p_intent_id
     RETURNING * INTO v_intent;
  END IF;

  INSERT INTO public.commerce_settlement_transitions
    (intent_id, from_status, to_status, outcome, idempotency_key, payload, occurred_at)
  VALUES (p_intent_id, v_from, v_intent.status, p_outcome, p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_occurred_at)
  RETURNING * INTO v_transition;

  RETURN public.commerce_settlement_response(v_intent, v_transition.id, p_outcome, false);
END;
$$;
