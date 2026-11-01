-- Portable subscription-activation spine.
--
-- This delta adds the four things the neutral signup-to-active-subscription
-- lifecycle needs and the published catalogue does not already carry. The
-- order rail, the settlement rail, the subscription rail and the stock
-- evidence rail all exist; what was missing was the joinery between them.
--
-- 1. A durable continuation for the branch where the offer cannot be sold. It
--    stores the article and two OPAQUE references handed in by the caller —
--    one for whoever asked and one for the permission they gave. No address,
--    no name, no message body and no contact value of any kind is stored
--    here; a deployment that keeps contacts keeps them in its own contact
--    ledger and passes this rail a reference to that row.
-- 2. A provisional activation, declared before money moves, so a checkout
--    whose payment succeeded but whose activation never completed is a ROW
--    that can be found rather than an absence that cannot. The gap is a view
--    over that row and the paid order, and one function repairs it.
-- 3. A compensation ledger keyed by the caller's idempotency key, so an
--    interrupted checkout is cancelled exactly once and a process that dies
--    mid-flight and retries after restart reads its own earlier answer.
-- 4. Activation from a captured payment, identified by an opaque payment
--    FINGERPRINT. Replaying a key with the fingerprint it already carries
--    returns the stored answer and writes nothing; the same key carrying a
--    different fingerprint is refused by name, because two different payments
--    for one order is a fact the caller has to reconcile, not a race this
--    rail may silently pick a winner for.
--
-- What this forward deliberately does NOT do: it names no payment provider,
-- no market, no article catalogue and no delivery channel; it derives the
-- repair fingerprint from the settlement handle the money rail already
-- recorded rather than accepting one from a reconciler; and it creates no
-- role, no policy and no security-definer wrapper, because every function
-- here is authored for the database owner in the same way as the rails it
-- joins. `CREATE` is unconditional: a manifest-ordered forward runs once
-- against a known prefix, and `IF NOT EXISTS` would hide exactly the drift
-- the migration ledger exists to catch.

-- The article a caller could not buy, and the two references that let a
-- deployment reach them again. `contact_ref` and `consent_ref` are checked
-- for SHAPE and never parsed: this rail cannot tell a contact row id from a
-- hash of one, and it must not be able to.
CREATE TABLE public.commerce_offer_continuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  sku text NOT NULL,
  contact_ref text NOT NULL,
  consent_ref text NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  idempotency_key text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT commerce_offer_continuations_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT commerce_offer_continuations_sku_check
    CHECK (btrim(sku) <> '' AND char_length(sku) <= 120),
  CONSTRAINT commerce_offer_continuations_contact_ref_check
    CHECK (contact_ref ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_offer_continuations_consent_ref_check
    CHECK (consent_ref ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_offer_continuations_status_check
    CHECK (status IN ('waiting', 'released')),
  CONSTRAINT commerce_offer_continuations_released_at_check
    CHECK ((status = 'released') = (released_at IS NOT NULL)),
  CONSTRAINT commerce_offer_continuations_idempotency_key_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT commerce_offer_continuations_idempotency_key_key UNIQUE (idempotency_key),
  -- One waiting continuation per article per asker. A second request from the
  -- same asker is the same wait, not a second one.
  CONSTRAINT commerce_offer_continuations_source_sku_contact_key
    UNIQUE (source_key, sku, contact_ref)
);

CREATE INDEX commerce_offer_continuations_waiting_idx
  ON public.commerce_offer_continuations (source_key, sku)
  WHERE status = 'waiting';

COMMENT ON COLUMN public.commerce_offer_continuations.contact_ref IS
  'Opaque 64-hex reference to whoever asked, minted by the deployment. Never parsed here.';
COMMENT ON COLUMN public.commerce_offer_continuations.consent_ref IS
  'Opaque 64-hex reference to the permission they gave. Never parsed here.';

-- The activation of ONE order, from the moment a subscription checkout is
-- declared to the moment a captured payment makes it live. Unique on the
-- order, because an order activates one subscription or none.
CREATE TABLE public.subscription_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  cadence_days integer NOT NULL,
  state text NOT NULL DEFAULT 'provisional',
  payment_fingerprint text,
  activation_idempotency_key text,
  declare_idempotency_key text NOT NULL,
  repaired boolean NOT NULL DEFAULT false,
  declared_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  compensated_at timestamptz,
  CONSTRAINT subscription_activations_state_check
    CHECK (state IN ('provisional', 'active', 'compensated')),
  CONSTRAINT subscription_activations_cadence_days_check CHECK (cadence_days > 0),
  -- The three facts of an activation move together or not at all: an active
  -- row has an instant, a fingerprint and a subscription; a row that is not
  -- active has none of them.
  CONSTRAINT subscription_activations_active_shape_check CHECK (
    (state = 'active') = (activated_at IS NOT NULL)
    AND (state = 'active') = (payment_fingerprint IS NOT NULL)
    AND (state = 'active') = (subscription_id IS NOT NULL)
    AND (state = 'active') = (activation_idempotency_key IS NOT NULL)
  ),
  CONSTRAINT subscription_activations_compensated_shape_check
    CHECK ((state = 'compensated') = (compensated_at IS NOT NULL)),
  CONSTRAINT subscription_activations_payment_fingerprint_check
    CHECK (payment_fingerprint IS NULL OR payment_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_activations_declare_idempotency_key_check
    CHECK (btrim(declare_idempotency_key) <> ''),
  CONSTRAINT subscription_activations_order_id_key UNIQUE (order_id),
  CONSTRAINT subscription_activations_declare_idempotency_key_key
    UNIQUE (declare_idempotency_key),
  CONSTRAINT subscription_activations_activation_idempotency_key_key
    UNIQUE (activation_idempotency_key)
);

CREATE INDEX subscription_activations_provisional_idx
  ON public.subscription_activations (declared_at)
  WHERE state = 'provisional';

COMMENT ON COLUMN public.subscription_activations.payment_fingerprint IS
  'Opaque 64-hex identity of the captured payment that activated this order. Never parsed here.';

-- Cancelled exactly once. The row IS the replay answer: the same key returns
-- what it returned before, which is what makes a compensation safe to retry
-- after a process dies between the call and its acknowledgement.
CREATE TABLE public.commerce_checkout_compensations (
  idempotency_key text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  reason text NOT NULL,
  outcome jsonb NOT NULL,
  compensated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_checkout_compensations_idempotency_key_check
    CHECK (btrim(idempotency_key) <> '' AND char_length(idempotency_key) >= 8),
  CONSTRAINT commerce_checkout_compensations_reason_check
    CHECK (btrim(reason) <> '' AND char_length(reason) <= 180)
);

CREATE INDEX commerce_checkout_compensations_order_idx
  ON public.commerce_checkout_compensations (order_id, compensated_at DESC);

-- Money moved and the subscription never started. Both halves are read out of
-- rows this catalogue already owns: the activation says a subscription was
-- promised, the order says it was paid for. Nothing about how it was paid
-- appears in the predicate, which is the whole reason this view is portable.
CREATE VIEW public.subscription_paid_activation_gaps AS
  SELECT
    activation.order_id,
    activation.client_id,
    activation.cadence_days,
    activation.declared_at,
    intent.id AS settlement_intent_id,
    intent.settled_at AS paid_at
  FROM public.subscription_activations activation
  JOIN public.commerce_orders order_row ON order_row.id = activation.order_id
  JOIN public.commerce_settlement_intents intent ON intent.order_id = activation.order_id
  WHERE activation.state = 'provisional'
    AND order_row.status = 'paid'
    AND intent.status = 'settled';

-- What a deployment may still sell, said in the only terms this catalogue has:
-- the quantity the stock rail last reported, and whether that report is still
-- inside its own freshness window. A sku the stock rail has never seen is
-- `unknown` rather than unavailable — refusing to sell what nobody measured is
-- a deployment policy, not a fact this function may invent.
CREATE FUNCTION public.commerce_offer_readiness(
  p_source_key text,
  p_sku text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'sku', p_sku,
    'readiness', CASE
      WHEN stock.sku IS NULL THEN 'unknown'
      WHEN stock.stale_after <= p_now THEN 'stale'
      WHEN stock.for_sale_quantity > 0 THEN 'ready'
      ELSE 'unavailable'
    END,
    'forSale', stock.for_sale_quantity,
    'sellable', COALESCE(stock.for_sale_quantity > 0 AND stock.stale_after > p_now, false))
  FROM (SELECT p_sku AS asked) request
  LEFT JOIN public.fulfillment_stock_current stock
    ON stock.source_key = p_source_key AND stock.sku = request.asked;
$$;

-- Refuse the continuation when the article can be sold. A wait recorded for
-- something already on the shelf is a wait nothing will ever end, and it is
-- also the tell of a caller that skipped the readiness read.
CREATE FUNCTION public.commerce_record_offer_continuation(
  p_idempotency_key text,
  p_source_key text,
  p_sku text,
  p_contact_ref text,
  p_consent_ref text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_offer_continuations%ROWTYPE;
  v_readiness jsonb;
  v_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
     OR p_sku IS NULL OR btrim(p_sku) = ''
     OR p_contact_ref !~ '^[0-9a-f]{64}$' OR p_consent_ref !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'commerce_offer_continuation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.commerce_offer_continuations
   WHERE source_key = p_source_key AND sku = p_sku AND contact_ref = p_contact_ref
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'continuationId', v_existing.id,
      'status', v_existing.status,
      'recorded', false,
      'replayed', true);
  END IF;

  v_readiness := public.commerce_offer_readiness(p_source_key, p_sku, p_now);
  IF (v_readiness->>'sellable')::boolean THEN
    RAISE EXCEPTION 'commerce_offer_continuation_offer_available' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.commerce_offer_continuations
    (source_key, sku, contact_ref, consent_ref, status, idempotency_key, requested_at)
  VALUES (p_source_key, p_sku, p_contact_ref, p_consent_ref, 'waiting', p_idempotency_key, p_now)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'continuationId', v_id, 'status', 'waiting', 'recorded', true, 'replayed', false);
END;
$$;

-- Coming back is the SAME lifecycle, entered again. The answer therefore
-- carries the readiness the caller would have got with no continuation at all,
-- plus the state of the wait it is coming back from — there is no re-entry
-- path that skips the readiness read.
CREATE FUNCTION public.commerce_offer_continuation_reentry(
  p_source_key text,
  p_sku text,
  p_contact_ref text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.commerce_offer_readiness(p_source_key, p_sku, p_now) || jsonb_build_object(
    'continuationStatus', continuation.status,
    'waiting', COALESCE(continuation.status = 'waiting', false))
  FROM (SELECT 1) probe
  LEFT JOIN public.commerce_offer_continuations continuation
    ON continuation.source_key = p_source_key
   AND continuation.sku = p_sku
   AND continuation.contact_ref = p_contact_ref;
$$;

-- Declared before the money, so the absence of an activation afterwards is a
-- row rather than a silence. The cadence is the caller's, because how often a
-- deployment ships is not something this rail may decide.
CREATE FUNCTION public.subscription_declare_provisional_activation(
  p_idempotency_key text,
  p_order_id uuid,
  p_cadence_days integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.subscription_activations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_client_id uuid;
  v_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
     OR p_order_id IS NULL OR p_cadence_days IS NULL OR p_cadence_days < 1 THEN
    RAISE EXCEPTION 'subscription_activation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_activation_order_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.subscription_activations
   WHERE order_id = p_order_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.declare_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
      RAISE EXCEPTION 'subscription_activation_declaration_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'orderId', v_existing.order_id, 'state', v_existing.state,
      'cadenceDays', v_existing.cadence_days, 'declared', false, 'replayed', true);
  END IF;

  -- Whose subscription this will be is the order's own answer. An order with no
  -- owner cannot declare one: guessing the buyer from an adjacent row is how a
  -- subscription ends up attached to the wrong person.
  v_client_id := v_order.client_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'subscription_activation_owner_unknown' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_activations
    (order_id, client_id, cadence_days, state, declare_idempotency_key, declared_at)
  VALUES (p_order_id, v_client_id, p_cadence_days, 'provisional', p_idempotency_key, p_now)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'orderId', p_order_id, 'activationId', v_id, 'state', 'provisional',
    'cadenceDays', p_cadence_days, 'declared', true, 'replayed', false);
END;
$$;

-- The write half, shared by the caller-driven path and the repair. Keeping it
-- in one function is what makes a repaired activation indistinguishable from a
-- first-time one: same subscription shape, same cycle, same event, same
-- fingerprint column — so a later replay of either is the same no-op.
CREATE FUNCTION public.subscription_activation_commit(
  p_activation public.subscription_activations,
  p_idempotency_key text,
  p_payment_fingerprint text,
  p_paid_at timestamptz,
  p_repaired boolean
)
RETURNS public.subscription_activations
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_cycle_id uuid;
  v_next_cycle_at timestamptz;
  v_activated public.subscription_activations%ROWTYPE;
BEGIN
  v_next_cycle_at := p_paid_at + (p_activation.cadence_days * interval '1 day');

  INSERT INTO public.subscriptions
    (client_id, status, cadence_days, next_cycle_at, started_at)
  VALUES (p_activation.client_id, 'active', p_activation.cadence_days, v_next_cycle_at, p_paid_at)
  RETURNING id INTO v_subscription_id;

  -- The cycle the captured payment paid for. It is written as paid because the
  -- money rail already said so; writing it as planned would make the first
  -- renewal ask for the same instant twice.
  INSERT INTO public.subscription_cycles (subscription_id, scheduled_at, status)
  VALUES (v_subscription_id, p_paid_at, 'paid')
  RETURNING id INTO v_cycle_id;

  UPDATE public.commerce_orders
     SET subscription_cycle_id = v_cycle_id, updated_at = p_paid_at
   WHERE id = p_activation.order_id;

  UPDATE public.subscription_activations
     SET state = 'active',
         subscription_id = v_subscription_id,
         payment_fingerprint = p_payment_fingerprint,
         activation_idempotency_key = p_idempotency_key,
         repaired = p_repaired,
         activated_at = p_paid_at
   WHERE order_id = p_activation.order_id
  RETURNING * INTO v_activated;

  INSERT INTO public.subscription_events
    (subscription_id, event_type, idempotency_key, payload, occurred_at)
  VALUES (
    v_subscription_id, 'subscription.activated', p_idempotency_key,
    jsonb_build_object(
      'orderId', p_activation.order_id,
      'cadenceDays', p_activation.cadence_days,
      'nextCycleAt', v_next_cycle_at,
      'repaired', p_repaired),
    p_paid_at)
  ON CONFLICT (subscription_id, idempotency_key) DO NOTHING;

  RETURN v_activated;
END;
$$;

-- One answer shape for both paths and both outcomes, so a replay differs from
-- a first call in exactly one field and nowhere else.
CREATE FUNCTION public.subscription_activation_answer(
  p_activation public.subscription_activations,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'orderId', p_activation.order_id,
    'subscriptionId', p_activation.subscription_id,
    'state', p_activation.state,
    'cadenceDays', p_activation.cadence_days,
    'activatedAt', p_activation.activated_at,
    'repaired', p_activation.repaired,
    'replayed', p_replayed);
$$;

-- The one place a subscription becomes live. It reads the money rail's own
-- verdict rather than being told one: the order must be paid and its intent
-- settled. The fingerprint the caller hands in is compared, never trusted as
-- an instruction — an identical one replays, a different one is refused.
CREATE FUNCTION public.subscription_activate_from_captured_payment(
  p_idempotency_key text,
  p_order_id uuid,
  p_payment_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_activation public.subscription_activations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_payment_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
     OR p_order_id IS NULL OR p_payment_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'subscription_activation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_activation_order_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_activation FROM public.subscription_activations
   WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_activation_not_declared' USING ERRCODE = '22023';
  END IF;

  IF v_activation.state = 'compensated' THEN
    RAISE EXCEPTION 'subscription_activation_order_compensated' USING ERRCODE = '22023';
  END IF;

  -- Preserve the public refusal order for a declaration that has never been
  -- paid. An already-active row continues below so its replay still compares
  -- the durable settlement identity before answering.
  IF v_activation.state <> 'active' AND v_order.status <> 'paid' THEN
    RAISE EXCEPTION 'subscription_activation_order_not_paid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_settlement_intents
   WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_intent.status <> 'settled' OR v_intent.settled_at IS NULL THEN
    RAISE EXCEPTION 'subscription_activation_payment_not_captured' USING ERRCODE = '22023';
  END IF;

  -- The caller may carry the opaque handle, but it does not get to define its
  -- identity. Compare its hash with the settlement row's own immutable handle
  -- before either the first write or a replay answer.
  v_payment_fingerprint := encode(sha256(convert_to(
    COALESCE(v_intent.external_ref, v_intent.id::text), 'UTF8')), 'hex');
  IF p_payment_fingerprint IS DISTINCT FROM v_payment_fingerprint THEN
    RAISE EXCEPTION 'subscription_activation_payment_fingerprint_conflict' USING ERRCODE = '23505';
  END IF;

  IF v_activation.state = 'active' THEN
    IF v_activation.payment_fingerprint IS DISTINCT FROM v_payment_fingerprint THEN
      RAISE EXCEPTION 'subscription_activation_payment_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.subscription_activation_answer(v_activation, true);
  END IF;

  RETURN public.subscription_activation_answer(
    public.subscription_activation_commit(
      v_activation, p_idempotency_key, v_payment_fingerprint, v_intent.settled_at, false),
    false);
END;
$$;

-- Is this one order still waiting? Asked per order rather than as a list,
-- because the caller that wants to know is the one holding that order and it
-- must not have to read anybody else's.
CREATE FUNCTION public.subscription_paid_activation_gap_open(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.subscription_paid_activation_gaps gap
     WHERE gap.order_id = p_order_id);
$$;

-- Repair, not retry: the gap already has a captured payment, so the fingerprint
-- is DERIVED from the handle the money rail wrote rather than accepted from
-- whoever noticed the gap. A reconciler that could name the payment could also
-- name the wrong one.
CREATE FUNCTION public.subscription_reconcile_paid_activation_gaps(
  p_limit integer DEFAULT 200,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_limit constant integer := greatest(1, least(COALESCE(p_limit, 200), 1000));
  v_repaired integer := 0;
  v_overdue integer := 0;
  v_activation public.subscription_activations%ROWTYPE;
  v_gap record;
BEGIN
  FOR v_gap IN
    SELECT gap.order_id, gap.paid_at, intent.external_ref, intent.id AS intent_id
      FROM public.subscription_paid_activation_gaps gap
      JOIN public.commerce_settlement_intents intent ON intent.id = gap.settlement_intent_id
     ORDER BY gap.paid_at ASC
     LIMIT v_limit
  LOOP
    SELECT * INTO v_activation FROM public.subscription_activations
     WHERE order_id = v_gap.order_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR v_activation.state <> 'provisional';

    PERFORM public.subscription_activation_commit(
      v_activation,
      'subscription-activation-repair:' || v_gap.order_id::text,
      encode(sha256(convert_to(
        COALESCE(v_gap.external_ref, v_gap.intent_id::text), 'UTF8')), 'hex'),
      COALESCE(v_gap.paid_at, p_now),
      true);
    v_repaired := v_repaired + 1;
  END LOOP;

  SELECT count(*) INTO v_overdue FROM public.subscription_paid_activation_gaps;

  RETURN jsonb_build_object('repaired', v_repaired, 'overdue', v_overdue);
END;
$$;

-- Compensation. Money that moved is never undone here: a paid order is
-- reported back as terminal and left exactly as it is, because reversing a
-- captured payment is a decision with a counterparty and this rail has none.
CREATE FUNCTION public.commerce_compensate_abandoned_checkout(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_recorded public.commerce_checkout_compensations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_outcome jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
     OR p_order_id IS NULL OR p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'commerce_checkout_compensation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_recorded FROM public.commerce_checkout_compensations
   WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_recorded.order_id IS DISTINCT FROM p_order_id THEN
      RAISE EXCEPTION 'commerce_checkout_compensation_key_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_recorded.outcome || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    v_outcome := jsonb_build_object('cancelled', false, 'reason', 'order_not_found', 'orderStatus', NULL);
  ELSIF v_order.status <> 'pending_payment' THEN
    v_outcome := jsonb_build_object(
      'cancelled', false, 'reason', 'already_terminal', 'orderStatus', v_order.status);
  ELSE
    UPDATE public.commerce_orders SET status = 'cancelled', updated_at = p_now WHERE id = p_order_id;
    UPDATE public.commerce_settlement_intents
       SET status = 'failed', failure_reason = p_reason, updated_at = p_now
     WHERE order_id = p_order_id AND status = 'created';
    -- A checkout that was compensated must not be activatable afterwards: this
    -- is the half of the guarantee a restart would otherwise break.
    UPDATE public.subscription_activations
       SET state = 'compensated', compensated_at = p_now
     WHERE order_id = p_order_id AND state = 'provisional';
    v_outcome := jsonb_build_object('cancelled', true, 'reason', p_reason, 'orderStatus', 'cancelled');
  END IF;

  INSERT INTO public.commerce_checkout_compensations
    (idempotency_key, order_id, reason, outcome, compensated_at)
  VALUES (p_idempotency_key, p_order_id, p_reason, v_outcome, p_now);

  RETURN v_outcome || jsonb_build_object('replayed', false);
END;
$$;
