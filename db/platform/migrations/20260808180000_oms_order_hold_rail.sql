-- Public platform order-management rail: the operator actor, the hold ledger, the operation
-- ledger, the four actions that move an order between operator-reachable states, and the three
-- triggers that put the resulting lifecycle notification on the queue.
--
-- WHAT THIS FORWARD SHIPS. It widens the order row a previous forward published, adds three
-- relations, four action functions and three emitters. It is the second bundle's first OPERATOR
-- mutation: the read forward gave it reads, the outbox forward gave it a queue, the subscription
-- forward gave it a mutation a customer can ask for, and this gives it the loop a shop actually
-- runs -- put an order on hold, refuse an illegal release, let a machine release the hold it
-- created once it has proof it may, cancel an order nobody paid for, mark a paid one refunded.
--
-- WHY THIS ONE CARRIES TRIGGERS, WHEN THE TWO BEFORE IT SAID IT WOULD NOT.
-- The outbox forward states "above all no enqueue", and the subscription forward states "no
-- enqueue. Nothing here writes a queue row, and no trigger is created on any table below". That
-- second sentence is followed by the rule that authorises this migration: "A capability that owns
-- a notification owns its own enqueue." The property those two forwards asserted was never "the
-- kernel has no triggers"; it was "a capability does not write another capability's queue rows".
-- This forward owns `commerce_orders`, it owns the three states below, and it therefore owns the
-- notification each of those states produces. Crossing the property deliberately, in the open, is
-- the point -- a threshold slipped through silently would be worth less than the rail.
--
-- WHAT THE EMITTER DELIBERATELY DOES NOT DO, enumerated so nobody has to infer the boundary:
--   * no payment-failure notification and no recoverable-payment-failure notification. Both exist
--     on the managed implementation as triggers on this same table; both belong to the payment
--     capability, which authors its own forward, and neither is authored here. The parity harness
--     asserts the ABSENCE of their rows rather than trusting this sentence;
--   * no fulfilment, dispatch, shipment or return notification;
--   * no notification carrying an amount, a currency or a commercial mode -- this kernel stores
--     none of the three, on purpose;
--   * no consumer. The rows land in the queue the outbox forward authored and are drained by its
--     claim/ack protocol, unchanged.
--
-- WHAT THE RAIL DELIBERATELY DOES NOT SHIP:
--   * no payment intent, payment, payment attempt or inbound provider event relation. The managed
--     cancellation locks a payment-intent table before it will accept; on this kernel the order
--     row IS where payment state lands, so the row lock plus the status gate is the same
--     guarantee, and a table nobody writes would be decoration with a foreign key on it;
--   * no order queue read. That one function is 695 lines on the managed side and reads 35
--     relations; it is the capability, not a cut of it;
--   * no inventory reservation, no catalogue mutation, no provider command ledger;
--   * no `SECURITY DEFINER`, no `GRANT`/`REVOKE`, no row-level security. This kernel creates zero
--     roles. Said out loud rather than assumed: ON THIS KERNEL THE FUNCTIONS BELOW ARE NOT A
--     SECURITY BOUNDARY. `p_actor_id` is an argument supplied by a trusted caller, not a verified
--     principal; the host application is what authenticates. The functions refuse to act on
--     an unknown actor, which is a different and smaller promise;
--   * `SET search_path` is kept, because that one is a real injection-hardening property that
--     does not depend on a role model.
--
-- AUTHORED, NOT COPIED. Written for this migration against the composed observable behaviour of
-- five managed functions read end to end -- create hold, release hold, system release hold,
-- cancel unpaid order, mark refunded manual, 642 lines together. Named departures, in full: the
-- names lose their historical prefixes so one family token classifies every refusal; the actor is
-- a row in a plain table this forward authors rather than a handle into an identity system;
-- the human release and the machine release COLLAPSE INTO ONE function with a proof-grade
-- argument, because two entry points exist upstream only so that the human one can keep raising
-- on a null actor; the machine release's source allowlist is dropped and the non-forgeable
-- `created_by IS NULL` scope check keeps the property it defended, since every string in that
-- allowlist names a provider and this kernel names none; the two proof grades are kept verbatim,
-- because they ARE the asymmetry; there is ONE idempotency ledger instead of two, and it is the
-- operation row, because the upstream generic key table fingerprints the actor and therefore
-- silently stops deduplicating for a machine; the replay fingerprint compares fields instead of
-- hashing a concatenation, so a mismatch is diagnosable; the operation vocabulary is the four
-- values this rail produces rather than seven; the emitter fires on the order's own transition
-- with no evidence gate, which is a real behavioural difference and is measured as one; every
-- constraint is named; and `CREATE` is unconditional, because a manifest-ordered forward runs
-- exactly once against a known prefix and `IF NOT EXISTS` there would hide the drift the
-- migration ledger exists to catch.

-- The order row a previous forward published carried the five columns a locked-cycle guard reads.
-- These are the columns THIS rail reads or writes, plus the owner -- a hold placed on a row with
-- no customer is a row edit, not an operator action. `client_id` is nullable because the column
-- is added to a table an already-published forward created, and NOT NULL there would refuse to
-- apply on any instance that already carries rows; the ledger is a ledger, not a rewrite.
ALTER TABLE public.commerce_orders
  ADD COLUMN client_id uuid,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN refunded_at timestamptz,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- NOT VALID, following the chain's own convention for constraints on a table that may carry
-- rows: every NEW write is checked from this statement on, no blocking scan is taken, and a
-- fresh kernel boot has nothing to validate anyway.
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT NOT VALID;

-- Together with `status`, the three instants above are the whole of this kernel's payment truth.
-- The refund transition needs a state to move to, and the published CHECK has five values, none
-- of which is a refund.
ALTER TABLE public.commerce_orders DROP CONSTRAINT commerce_orders_status_check;

ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_status_check
  CHECK (status IN (
    'pending_payment', 'paid', 'fulfillment_pending', 'fulfilled', 'cancelled', 'refunded'
  )) NOT VALID;

-- A table, not a role. The managed implementation reaches its operator through a session and then
-- a row; only the row half is portable, and only the row half is read by an order operation --
-- for existence, and for nothing else. So this table carries existence and a label, and no
-- attribute the rail below never consults: a column nobody reads is a claim nobody checks.
CREATE TABLE public.commerce_operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_operators_label_nonempty_check CHECK (btrim(label) <> '')
);

-- `created_by` is nullable, and the null is load-bearing rather than lax: a hold with no creator
-- is a hold a machine put on, and that is the single field the automatic release is allowed to
-- key on. Metadata is caller-supplied and therefore forgeable; this column is not.
CREATE TABLE public.commerce_order_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  reason text NOT NULL,
  note text,
  created_by uuid REFERENCES public.commerce_operators(id) ON DELETE SET NULL,
  released_by uuid REFERENCES public.commerce_operators(id) ON DELETE SET NULL,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT commerce_order_holds_status_check CHECK (status IN ('active', 'released')),
  CONSTRAINT commerce_order_holds_reason_check CHECK (reason IN (
    'payment_not_succeeded', 'inventory_review', 'risk_review',
    'address_review', 'fulfillment_exception', 'manual_support'
  )),
  CONSTRAINT commerce_order_holds_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT commerce_order_holds_released_at_check CHECK (
    (status = 'active' AND released_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL)
  )
);

-- One live hold per order per reason. Expressed as a partial unique index rather than as a
-- procedural check, so two concurrent creators cannot both pass a read and then both insert.
CREATE UNIQUE INDEX idx_commerce_order_holds_one_active_reason
  ON public.commerce_order_holds (order_id, reason)
  WHERE status = 'active';

CREATE INDEX idx_commerce_order_holds_order
  ON public.commerce_order_holds (order_id, created_at DESC);

-- The audit ledger AND the idempotency ledger, in one table. Keeping a second generic key table
-- would mean keeping the defect that comes with it: its request fingerprint hashes the actor, so
-- for a machine actor the hash is over a null and deduplication silently stops working.
CREATE TABLE public.commerce_order_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  hold_id uuid REFERENCES public.commerce_order_holds(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES public.commerce_operators(id) ON DELETE SET NULL,
  operation_type text NOT NULL,
  source text NOT NULL DEFAULT 'platform.oms.v1',
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_operations_operation_type_check CHECK (operation_type IN (
    'hold_created', 'hold_released', 'order_cancelled', 'order_refunded'
  )),
  CONSTRAINT commerce_order_operations_idempotency_key_nonempty_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT commerce_order_operations_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_commerce_order_operations_order
  ON public.commerce_order_operations (order_id, occurred_at DESC);

-- One response shape for the hold pair, so an applied release and a replayed one are answered by
-- the same builder and cannot drift apart.
CREATE FUNCTION public.oms_hold_response(
  p_hold public.commerce_order_holds,
  p_operation_id uuid,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'platform.oms.order.v1',
    'hold', jsonb_build_object(
      'id', p_hold.id, 'orderId', p_hold.order_id, 'status', p_hold.status,
      'reason', p_hold.reason, 'note', p_hold.note),
    'released', p_hold.status = 'released' AND NOT p_replayed,
    'operationId', p_operation_id,
    'replayed', p_replayed);
$$;

-- Put an order on hold on behalf of a named operator.
--
-- An actor is mandatory here and the refusal is a referential one, not a policy one: a hold whose
-- creator cannot be named is indistinguishable from a hold a machine put on, and the automatic
-- release below is allowed to act on exactly that. Two concurrent creators for the same reason do
-- not race, because the second one meets the partial unique index rather than a stale read.
CREATE FUNCTION public.oms_create_hold(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_note text,
  p_actor_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_operations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_hold public.commerce_order_holds%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL
    OR p_actor_id IS NULL
    OR p_reason IS NULL OR p_reason NOT IN (
      'payment_not_succeeded', 'inventory_review', 'risk_review',
      'address_review', 'fulfillment_exception', 'manual_support')
  THEN
    RAISE EXCEPTION 'oms_create_hold_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.commerce_order_operations
   WHERE idempotency_key = p_idempotency_key || ':operation';

  IF FOUND THEN
    IF v_existing.operation_type <> 'hold_created'
      OR v_existing.order_id IS DISTINCT FROM p_order_id
      OR v_existing.payload->>'reason' IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'oms_create_hold_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_hold FROM public.commerce_order_holds WHERE id = v_existing.hold_id;
    RETURN public.oms_hold_response(v_hold, v_existing.id, true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oms_create_hold_order_not_found' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.commerce_operators WHERE id = p_actor_id) THEN
    RAISE EXCEPTION 'oms_create_hold_actor_unknown' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.commerce_order_holds
    (order_id, reason, note, created_by, idempotency_key, metadata, created_at, updated_at)
  VALUES (p_order_id, p_reason, p_note, p_actor_id, p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_requested_at, p_requested_at)
  RETURNING * INTO v_hold;

  INSERT INTO public.commerce_order_operations
    (order_id, hold_id, actor_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_order_id, v_hold.id, p_actor_id, 'hold_created', p_idempotency_key || ':operation',
          jsonb_build_object('reason', p_reason, 'note', p_note), p_requested_at)
  RETURNING * INTO v_existing;

  RETURN public.oms_hold_response(v_hold, v_existing.id, false);
END;
$$;

-- Take a hold off, either as a named operator or as a machine that can prove it may.
--
-- One function, two paths, and the asymmetry between them is the whole point. A machine puts an
-- order on hold and, upstream, only a human could ever take it off; exactly two grades of proof
-- were later allowed to do it automatically, and nothing else. That rule is encoded here as
-- behaviour: a null actor is an automatic release, it demands one of the two grades, and it can
-- only ever reach a hold that had no creator and was raised for the one reason a machine raises.
-- A human release needs no proof and can reach any active hold. The asymmetry does not reverse:
-- there is no proof grade that lets a machine release a hold a human placed.
CREATE FUNCTION public.oms_release_hold(
  p_idempotency_key text,
  p_hold_id uuid,
  p_note text,
  p_actor_id uuid,
  p_proof_grade text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_operations%ROWTYPE;
  v_hold public.commerce_order_holds%ROWTYPE;
  v_automatic boolean := p_actor_id IS NULL;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8 OR p_hold_id IS NULL
  THEN
    RAISE EXCEPTION 'oms_release_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF v_automatic AND (p_proof_grade IS NULL OR p_proof_grade NOT IN ('delivered', 'provider_recovered'))
  THEN
    RAISE EXCEPTION 'oms_release_proof_forbidden' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.commerce_order_operations
   WHERE idempotency_key = p_idempotency_key || ':operation';

  IF FOUND THEN
    IF v_existing.operation_type <> 'hold_released' OR v_existing.hold_id IS DISTINCT FROM p_hold_id
    THEN
      RAISE EXCEPTION 'oms_release_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_hold FROM public.commerce_order_holds WHERE id = p_hold_id;
    RETURN public.oms_hold_response(v_hold, v_existing.id, true);
  END IF;

  SELECT * INTO v_hold FROM public.commerce_order_holds WHERE id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oms_release_hold_not_found' USING ERRCODE = '22023';
  END IF;

  IF NOT v_automatic AND NOT EXISTS (
    SELECT 1 FROM public.commerce_operators WHERE id = p_actor_id
  ) THEN
    RAISE EXCEPTION 'oms_release_actor_unknown' USING ERRCODE = '23503';
  END IF;

  -- IS DISTINCT FROM, not <>, so an absent reason fails closed.
  IF v_automatic AND (
    v_hold.created_by IS NOT NULL
    OR v_hold.reason IS DISTINCT FROM 'fulfillment_exception'
  ) THEN
    RAISE EXCEPTION 'oms_release_scope_forbidden' USING ERRCODE = '22023';
  END IF;

  IF v_hold.status <> 'active' THEN
    RAISE EXCEPTION 'oms_release_already_released' USING ERRCODE = '23505';
  END IF;

  UPDATE public.commerce_order_holds
     SET status = 'released',
         released_at = p_requested_at,
         released_by = p_actor_id,
         updated_at = p_requested_at,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
           'releaseNote', p_note,
           'automatic', v_automatic,
           'proofGrade', p_proof_grade)
   WHERE id = p_hold_id
  RETURNING * INTO v_hold;

  INSERT INTO public.commerce_order_operations
    (order_id, hold_id, actor_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_hold.order_id, v_hold.id, p_actor_id, 'hold_released',
          p_idempotency_key || ':operation',
          jsonb_build_object('reason', v_hold.reason, 'note', p_note,
                             'automatic', v_automatic, 'proofGrade', p_proof_grade),
          p_requested_at)
  RETURNING * INTO v_existing;

  RETURN public.oms_hold_response(v_hold, v_existing.id, false);
END;
$$;

-- Cancel an order nobody has paid for.
--
-- The managed implementation locks a payment-intent table before it decides that money has not
-- moved. That lock is a race device against a second writer, not a second source of truth, and on
-- this kernel there is no second writer to race: the order row is where payment state lands, so
-- `FOR UPDATE` on that row plus the status gate is the same guarantee. If that ever stops being
-- true -- if a payment relation is authored here that can move money without touching the order
-- row -- this function is the one that has to change first.
CREATE FUNCTION public.oms_cancel_unpaid_order(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_actor_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_operations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL
    OR p_reason IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.commerce_order_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'order_cancelled'
      OR v_existing.order_id IS DISTINCT FROM p_order_id
      OR v_existing.payload->>'reason' IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'oms_cancel_unpaid_order_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
      'orderId', p_order_id, 'status', 'cancelled', 'replayed', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
      'orderId', p_order_id, 'status', 'cancelled', 'replayed', true);
  END IF;

  -- This single line is the whole of the "money has not moved" test. Upstream it is a status
  -- gate followed by a lock and a four-status probe over two payment relations; the gate is what
  -- decides, and the probe is what serializes. Here the order row is both.
  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.commerce_operators WHERE id = p_actor_id
  ) THEN
    RAISE EXCEPTION 'oms_cancel_unpaid_order_actor_unknown' USING ERRCODE = '23503';
  END IF;

  UPDATE public.commerce_orders
     SET status = 'cancelled',
         cancelled_at = p_requested_at,
         updated_at = p_requested_at,
         metadata = metadata || jsonb_build_object('cancellation', jsonb_build_object(
           'reason', p_reason, 'actorId', p_actor_id,
           'request', COALESCE(p_metadata, '{}'::jsonb)))
   WHERE id = p_order_id;

  INSERT INTO public.commerce_order_operations
    (order_id, actor_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_order_id, p_actor_id, 'order_cancelled', p_idempotency_key,
          jsonb_build_object('reason', p_reason), p_requested_at);

  RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
    'orderId', p_order_id, 'status', 'cancelled', 'replayed', false);
END;
$$;

-- Record that a paid order was refunded outside this system.
--
-- The transition is decided from the order row alone, exactly as it is upstream: only a paid
-- order can be marked refunded, an already-refunded one replays, and anything else is refused.
CREATE FUNCTION public.oms_mark_refunded(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_actor_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_operations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8 OR p_order_id IS NULL
  THEN
    RAISE EXCEPTION 'oms_mark_refunded_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.commerce_order_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'order_refunded'
      OR v_existing.order_id IS DISTINCT FROM p_order_id
      OR v_existing.payload->>'reason' IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'oms_mark_refunded_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
      'orderId', p_order_id, 'status', 'refunded', 'replayed', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oms_mark_refunded_order_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_order.status = 'refunded' THEN
    RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
      'orderId', p_order_id, 'status', 'refunded', 'replayed', true);
  END IF;

  IF v_order.status <> 'paid' THEN
    RAISE EXCEPTION 'oms_mark_refunded_invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.commerce_orders
     SET status = 'refunded',
         refunded_at = p_requested_at,
         updated_at = p_requested_at,
         metadata = metadata || jsonb_build_object('refund', jsonb_build_object(
           'reason', p_reason, 'actorId', p_actor_id,
           'request', COALESCE(p_metadata, '{}'::jsonb)))
   WHERE id = p_order_id;

  INSERT INTO public.commerce_order_operations
    (order_id, actor_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_order_id, p_actor_id, 'order_refunded', p_idempotency_key,
          jsonb_build_object('reason', p_reason), p_requested_at);

  RETURN jsonb_build_object('contractVersion', 'platform.oms.order.v1',
    'orderId', p_order_id, 'status', 'refunded', 'replayed', false);
END;
$$;

-- The three lifecycle notifications, one function and one trigger each.
--
-- The barrier lives in the trigger's WHEN clause rather than in an early RETURN inside the body:
-- a condition the planner evaluates before the function is even entered cannot be reached by a
-- statement that did not change what it claims to have changed. Each emitter is idempotent on
-- (event type, key) as well, so a replayed transition cannot double-notify.
CREATE FUNCTION public.commerce_order_emit_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.paid', 'order_paid:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.paid_at),
          jsonb_build_object('source', 'commerce_order_emit_paid_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

-- The cancellation notification exists for a customer whose money already moved. An order nobody
-- paid for is cancelled silently, and that silence is a property, not an omission: notifying
-- someone that a thing they never bought is not happening is noise.
CREATE FUNCTION public.commerce_order_emit_cancelled_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.cancelled', 'order_cancelled:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.cancelled_at),
          jsonb_build_object('source', 'commerce_order_emit_cancelled_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.commerce_order_emit_refunded_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.id, 'commerce.order.refunded', 'order_refunded:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.id, 'occurredAt', NEW.refunded_at),
          jsonb_build_object('source', 'commerce_order_emit_refunded_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_commerce_order_emit_paid
  AFTER UPDATE OF status ON public.commerce_orders
  FOR EACH ROW
  WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.commerce_order_emit_paid_notification();

CREATE TRIGGER trg_commerce_order_emit_cancelled
  AFTER UPDATE OF status ON public.commerce_orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IN ('paid', 'fulfillment_pending'))
  EXECUTE FUNCTION public.commerce_order_emit_cancelled_notification();

CREATE TRIGGER trg_commerce_order_emit_refunded
  AFTER UPDATE OF status ON public.commerce_orders
  FOR EACH ROW
  WHEN (NEW.status = 'refunded' AND OLD.status IS DISTINCT FROM 'refunded')
  EXECUTE FUNCTION public.commerce_order_emit_refunded_notification();
