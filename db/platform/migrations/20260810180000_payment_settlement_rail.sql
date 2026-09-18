-- Public platform settlement rail: the order gets lines and a price, and the kernel gets the one
-- thing it has never had -- a way to say "this order was paid for". Three relations, two money
-- columns on the order row a previous forward published, one arithmetic invariant, two mutations,
-- one emitter, and one delegation onto the subscription rail.
--
-- WHAT THIS FORWARD SHIPS. Every rail before this one could describe an order's LIFE -- a hold, a
-- parcel, a document, a cancellation -- and none of them could describe how it was BOUGHT. The
-- order-management forward said so about itself in the open: "no payment intent, payment, payment
-- attempt or inbound provider event relation... on this kernel the order row IS where payment state
-- lands". The accounting forward said the same from the other side: "no order money. No currency,
-- no order totals, no item relation". Both named the owner of that gap, and this is it. After this
-- forward a guest can be charged on a second-bundle deployment: the order carries lines and a
-- declared total, a settlement intent carries the amount somebody is being asked for, and one
-- accepted settlement moves the order to paid and the subscription cycle it belongs to with it.
--
-- WHAT IT REFUSES TO KNOW, AND THIS IS THE LOAD-BEARING PART. There is NO payment gateway here and
-- there will not be one. Not a name, not an enum, not a branch keyed on who is charging. A
-- settlement carries ONE opaque channel key and ONE opaque external reference; this kernel writes
-- both, compares them for equality, and never parses either. The reference deployment settles
-- through a channel that does nothing at all, which is exactly why the journey needs no real
-- gateway credentials to run. Currency is a COLUMN with a checked SHAPE -- three characters -- and
-- never a value: a kernel that hard-codes one market's currency has chosen that market for every
-- adopter. The same rule covers countries, tax rules and price rounding: none appears below.
--
-- MINOR UNITS, NOT CENTS, matching the vocabulary the accounting forward settled on. `cents` is the
-- subdivision of two particular currencies; `*_minor` is the subdivision of whichever one the
-- deployment declared.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE. The behaviour below was derived from the
-- managed chain by reading its payment-control plane end to end -- intent creation, attempt
-- recording, result application, and the success branch that pays a subscription cycle -- and by
-- reading the constraints its own tables carry. Ten departures, each named, because a silent one is
-- how a kernel and its origin quietly stop being the same machine:
--
--   1. ONE INTENT AND ONE LEDGER, NOT SIX RELATIONS. Upstream splits the money into an intent, a
--      payment, an attempt, a state-transition log, an inbound event store and a generic
--      idempotency table. Five of the six exist to hold gateway facts -- session handles, request
--      fingerprints, signature verification, next-action kinds -- and this kernel has no gateway,
--      so it would be authoring five empty shapes. What survives is the pair that carries meaning
--      without one: the intent, and the append-only ledger of what happened to it.
--   2. IDEMPOTENCY IS PER INTENT, NOT GLOBAL. Upstream keys a shared table on (scope, key) and
--      fingerprints the request into it. Here the ledger row IS the replay answer and its
--      uniqueness is (intent, key), which is the invariant that lookup actually means: two
--      unrelated intents cannot collide on a value neither of them chose.
--   3. THE SECOND SETTLEMENT OF A SETTLED INTENT IS REFUSED. Upstream re-applies a repeated success
--      arriving under a different key: the branch it takes only refuses cancelled and refunded
--      intents, so a second delivery writes a second state transition and stamps the row again.
--      This kernel answers `..._intent_already_settled` instead. It is a deliberately STRONGER
--      promise, it is what the settlement rail exists to guarantee, and the parity harness compares
--      it as a departure rather than hiding it in the shared spine.
--   4. A DECLINE LEAVES THE ORDER RE-PAYABLE and writes nothing else. Upstream's decline branch
--      also opens a dunning case, schedules three retries on a fixed ladder, skips queued
--      notifications and classifies the failure. Dunning, retries and failure classification are
--      capabilities of their own with their own forwards; what is portable is that a declined order
--      is still payable, and that is all this kernel promises.
--   5. THE INVARIANT IS A DEFERRED CONSTRAINT TRIGGER over the order and its lines together, the
--      device the accounting forward settled on. An argument check would be satisfied once and then
--      bypassed by the next write to the line ledger. The predicate is one comparison and it holds
--      in BOTH directions: an order that declares no total may carry no lines, and an order that
--      declares one must carry lines summing to it exactly.
--   6. A LINE IS QUANTITY TIMES UNIT PRICE, exactly. Upstream carries a per-line discount
--      allocation, an effective net, and a basis-point rate, and refuses on eight arithmetic
--      mismatches between them. Discounting is a pricing decision the catalogue capability owns and
--      tax is a rule this catalogue already declined to interpret; a kernel that stored either
--      without applying it would be storing a claim nobody checks.
--   7. THE MONEY COLUMNS ARE NULLABLE AND ADDED, not required and rewritten. They are added to a
--      table two published forwards already created, so NOT NULL there would refuse to apply on any
--      instance carrying rows. A NULL total means "this order has not declared what it is worth",
--      which is exactly the state every order on this kernel was in before this forward.
--   8. THE SUBSCRIPTION SIDE IS A DELEGATION, NOT A SECOND MACHINE. A settled order that belongs to
--      a cycle moves that cycle to `paid` and slides the subscription's next date one cadence past
--      the cycle it just paid for -- the same arithmetic the managed success branch does. It does
--      NOT terminalize, activate or cancel anything: the lifecycle verbs belong to the subscription
--      forward and are reached through it.
--   9. NO `SECURITY DEFINER`, NO `GRANT`/`REVOKE`, NO ROW-LEVEL SECURITY, matching every forward in
--      this catalogue -- upstream every function below is `SECURITY DEFINER`. This kernel creates
--      zero roles. Said out loud rather than assumed: ON THIS KERNEL THE FUNCTIONS BELOW ARE NOT A
--      SECURITY BOUNDARY, AND NEITHER IS A SETTLEMENT AN AUTHORIZATION. A caller that can reach
--      these functions can already reach the tables; the host application is what authenticates and
--      what decides that money actually moved. `SET search_path` is kept, because that one is a
--      correctness property and not a role property.
--  10. EVERY CONSTRAINT IS NAMED, and `CREATE` is unconditional, because a manifest-ordered forward
--      runs exactly once against a known prefix and `IF NOT EXISTS` there would hide the drift the
--      migration ledger exists to catch. Constraints ADDED to the published order table are
--      `NOT VALID`, following that table's own convention: every new write is checked from this
--      statement on, and a fresh kernel boot has nothing to validate anyway.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no gateway, no adapter, no provider enum, no webhook ingestion, no signature verification and
--     no reconciliation sweep;
--   * no refund and no dispute. The order rail already owns the refunded transition and its
--     notification; a settlement that could also un-settle itself would be two machines;
--   * no dunning ledger, no retry schedule, no failure taxonomy, no bound payment method;
--   * no inventory reservation and no release. A settled order reserves nothing here;
--   * no shipping, no discount and no tax arithmetic anywhere;
--   * no identity. `p_*` arguments are supplied by a trusted caller; a guest order is an order
--     whose client row exists and whose caller was never asked to prove anything;
--   * no runtime binding. Not one line of the application is rewired onto these relations by this
--     forward; the falsifier is its own cross-bundle parity harness.

-- The order row two published forwards created carried a status, three instants and an owner. These
-- are the two columns that make it an order for GOODS AT A PRICE rather than a state machine with a
-- customer attached. Nullable, for departure 7.
ALTER TABLE public.commerce_orders
  ADD COLUMN currency_code text,
  ADD COLUMN total_amount_minor bigint;

-- Declared together or not at all: an amount without its unit is a number, and a unit without an
-- amount is a claim about nothing. The shape of the code is checked; its value never is.
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_declared_money_check
  CHECK (
    (total_amount_minor IS NULL AND currency_code IS NULL)
    OR (
      total_amount_minor IS NOT NULL AND total_amount_minor >= 0
      AND currency_code IS NOT NULL AND char_length(currency_code) = 3
    )
  ) NOT VALID;

COMMENT ON COLUMN public.commerce_orders.currency_code IS
  'Three-character code the deployment declared. This kernel checks its shape and never its value.';

-- One row per line of the order. The catalogue link is optional on purpose: an adopter may sell a
-- thing this kernel does not stock, and refusing the line would make the catalogue rail a
-- precondition for taking money.
CREATE TABLE public.commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  sku_id uuid REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
  line_ordinal integer NOT NULL,
  quantity integer NOT NULL,
  unit_amount_minor bigint NOT NULL,
  line_amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_items_line_ordinal_check CHECK (line_ordinal > 0),
  CONSTRAINT commerce_order_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT commerce_order_items_unit_amount_minor_check CHECK (unit_amount_minor >= 0),
  -- Departure 6: the line is the multiplication, with nothing allocated onto it and nothing taken
  -- out of it. Integer arithmetic, so it is exact in every currency and rounds in none.
  CONSTRAINT commerce_order_items_line_amount_minor_check
    CHECK (line_amount_minor = unit_amount_minor * quantity),
  CONSTRAINT commerce_order_items_order_id_line_ordinal_key UNIQUE (order_id, line_ordinal)
);

CREATE INDEX idx_commerce_order_items_order
  ON public.commerce_order_items (order_id, line_ordinal);

-- What somebody is being asked to pay, and where that request stands. One per order, as a unique
-- key rather than a procedural check, because two concurrent callers cannot both pass a read and
-- then both insert.
CREATE TABLE public.commerce_settlement_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  channel_key text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  amount_minor bigint NOT NULL,
  currency_code text NOT NULL,
  external_ref text,
  open_idempotency_key text NOT NULL,
  settled_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Three values, and the third is not terminal: a declined settlement can be tried again, which is
  -- departure 4 expressed as a state rather than as a comment.
  CONSTRAINT commerce_settlement_intents_status_check
    CHECK (status IN ('created', 'settled', 'failed')),
  CONSTRAINT commerce_settlement_intents_amount_minor_check CHECK (amount_minor > 0),
  CONSTRAINT commerce_settlement_intents_currency_code_check CHECK (char_length(currency_code) = 3),
  CONSTRAINT commerce_settlement_intents_channel_key_check
    CHECK (btrim(channel_key) <> '' AND char_length(channel_key) <= 64),
  CONSTRAINT commerce_settlement_intents_open_idempotency_key_check
    CHECK (btrim(open_idempotency_key) <> ''),
  -- The instant and the state cannot disagree, in either direction.
  CONSTRAINT commerce_settlement_intents_settled_at_check
    CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CONSTRAINT commerce_settlement_intents_order_id_key UNIQUE (order_id),
  CONSTRAINT commerce_settlement_intents_open_idempotency_key_key UNIQUE (open_idempotency_key)
);

COMMENT ON COLUMN public.commerce_settlement_intents.channel_key IS
  'Opaque label naming whatever settles this intent in a given deployment. Never parsed here.';
COMMENT ON COLUMN public.commerce_settlement_intents.external_ref IS
  'Opaque handle handed back by that channel, written once. Never parsed here.';

-- Append-only, and the row IS the replay answer: a repeated request carrying a key this intent has
-- already seen is answered from the ledger instead of acted on twice. Uniqueness is per intent and
-- the key is mandatory, for departure 2.
CREATE TABLE public.commerce_settlement_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES public.commerce_settlement_intents(id) ON DELETE CASCADE,
  from_status text NOT NULL,
  to_status text NOT NULL,
  outcome text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_settlement_transitions_outcome_check
    CHECK (outcome IN ('opened', 'succeeded', 'failed')),
  CONSTRAINT commerce_settlement_transitions_idempotency_key_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT commerce_settlement_transitions_intent_id_idempotency_key_key
    UNIQUE (intent_id, idempotency_key)
);

CREATE INDEX idx_commerce_settlement_transitions_intent
  ON public.commerce_settlement_transitions (intent_id, occurred_at DESC);

-- THE INVARIANT. The lines must equal the declared total, in minor units, exactly.
--
-- One predicate covers both directions, which is why it is one predicate: an order that declares
-- nothing must carry no lines (0 = 0), an order that declares an amount must carry lines summing to
-- it, and an order that carries lines without declaring anything fails on the same comparison.
-- Deferring it to the end of the transaction is what lets an order and its lines be written by one
-- call and still be checked as a pair; nothing can commit them in disagreement.
CREATE FUNCTION public.commerce_order_assert_line_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order_id uuid;
  v_declared bigint;
  v_sum bigint;
BEGIN
  -- Branching statements rather than one CASE expression on purpose: the procedural language
  -- compiles an expression into a single query, so every record field named in any arm must exist
  -- on every row type the trigger can see, and the two row types here differ.
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    v_order_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  SELECT total_amount_minor INTO v_declared
    FROM public.commerce_orders
   WHERE id = v_order_id;
  -- The order is gone: a cascade took it, and there is nothing left to be consistent with.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(line_amount_minor), 0) INTO v_sum
    FROM public.commerce_order_items
   WHERE order_id = v_order_id;

  IF v_sum IS DISTINCT FROM COALESCE(v_declared, 0) THEN
    RAISE EXCEPTION 'commerce_order_line_sum_mismatch' USING ERRCODE = '23514',
      DETAIL = format('order %s declares %s and its lines sum to %s',
                      v_order_id, COALESCE(v_declared::text, 'nothing'), v_sum);
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_commerce_orders_line_sum
  AFTER INSERT OR UPDATE ON public.commerce_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_order_assert_line_sum();

CREATE CONSTRAINT TRIGGER trg_commerce_order_items_line_sum
  AFTER INSERT OR UPDATE OR DELETE ON public.commerce_order_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_order_assert_line_sum();

-- One response shape for both entry points, so an accepted call and a replayed one are answered by
-- the same builder and cannot drift apart.
CREATE FUNCTION public.commerce_settlement_response(
  p_intent public.commerce_settlement_intents,
  p_transition_id uuid,
  p_outcome text,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'platform.commerce.settlement.v1',
    'outcome', p_outcome,
    'replayed', p_replayed,
    'transitionId', p_transition_id,
    'settlement', jsonb_build_object(
      'id', p_intent.id,
      'orderId', p_intent.order_id,
      'status', p_intent.status,
      'amountMinor', p_intent.amount_minor,
      'currencyCode', p_intent.currency_code,
      'externalRef', p_intent.external_ref,
      'failureReason', p_intent.failure_reason));
$$;

-- Ask for an order to be paid.
--
-- The ordering of the first three steps is the contract, not a style choice:
--   1. the arguments are validated before anything is read, so a malformed request never takes a
--      lock;
--   2. THE ORDER ROW IS LOCKED, and only then;
--   3. the intent is looked for.
-- Two callers arriving at once serialize on the order row, and the one that loses the race re-reads
-- a table that now contains the winner's intent -- so a repeated request answers `replayed` and a
-- second, different request is refused, instead of both passing a read and both inserting.
--
-- The amount is not trusted and not derived: it is COMPARED. A caller that asks for a different
-- number than the order declares is refused, which is the only thing this kernel enforces about
-- money at the moment of asking for it.
CREATE FUNCTION public.commerce_open_settlement_intent(
  p_idempotency_key text,
  p_order_id uuid,
  p_channel_key text,
  p_amount_minor bigint,
  p_currency_code text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order public.commerce_orders%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
  v_transition public.commerce_settlement_transitions%ROWTYPE;
BEGIN
  -- Long enough that a caller cannot reach it by accident: an idempotency key short enough to
  -- collide is worse than no key, because it silently suppresses a real second request.
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL
    OR p_channel_key IS NULL OR btrim(p_channel_key) = '' OR char_length(p_channel_key) > 64
    OR p_amount_minor IS NULL OR p_amount_minor < 1
    OR p_currency_code IS NULL OR char_length(p_currency_code) <> 3
  THEN
    RAISE EXCEPTION 'commerce_settlement_open_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_settlement_open_order_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent
    FROM public.commerce_settlement_intents WHERE order_id = p_order_id;

  IF FOUND THEN
    IF v_intent.open_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
      RAISE EXCEPTION 'commerce_settlement_open_order_already_has_intent' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_transition
      FROM public.commerce_settlement_transitions
     WHERE intent_id = v_intent.id AND idempotency_key = p_idempotency_key;
    RETURN public.commerce_settlement_response(v_intent, v_transition.id, 'opened', true);
  END IF;

  IF v_order.status <> 'pending_payment' THEN
    RAISE EXCEPTION 'commerce_settlement_open_order_not_payable' USING ERRCODE = '22023';
  END IF;

  IF v_order.total_amount_minor IS DISTINCT FROM p_amount_minor
    OR v_order.currency_code IS DISTINCT FROM p_currency_code
  THEN
    RAISE EXCEPTION 'commerce_settlement_open_amount_mismatch' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.commerce_settlement_intents
    (order_id, channel_key, status, amount_minor, currency_code, open_idempotency_key,
     created_at, updated_at)
  VALUES (p_order_id, btrim(p_channel_key), 'created', p_amount_minor, p_currency_code,
          p_idempotency_key, p_requested_at, p_requested_at)
  RETURNING * INTO v_intent;

  INSERT INTO public.commerce_settlement_transitions
    (intent_id, from_status, to_status, outcome, idempotency_key, payload, occurred_at)
  VALUES (v_intent.id, 'absent', 'created', 'opened', p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_requested_at)
  RETURNING * INTO v_transition;

  RETURN public.commerce_settlement_response(v_intent, v_transition.id, 'opened', false);
END;
$$;

-- Record what the settlement channel answered.
--
-- Same discipline as above and for the same reason: validate, LOCK, then consult the ledger for a
-- replay. Consulting the ledger first would let two callers pass, which is the classic
-- read-then-write race this function is written to not have. The locks are taken ORDER FIRST and
-- intent second, in the same sequence the opening function takes them, so a caller opening an
-- intent and a caller settling one cannot deadlock against each other.
--
-- Departure 3 lives in one statement below: an intent that has already been settled refuses a
-- second settlement outright. A repeated delivery under the SAME key is a replay and is answered
-- from the ledger; a second, different request against money that has already moved is a bug in the
-- caller, and answering it would let one order be paid for twice.
CREATE FUNCTION public.commerce_record_settlement(
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

      -- Departure 8: one cadence past the cycle that was just paid for, not past the moment the
      -- money arrived -- whole cadences forward keep every later date on the original grid. A
      -- subscription nobody is running any more is not slid: settlement truth still applies to a
      -- cancelled subscription, but its schedule is not this function's to revive.
      UPDATE public.subscriptions
         SET next_cycle_at = v_cycle.scheduled_at + (cadence_days || ' days')::interval,
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

-- THE SETTLEMENT NOTIFICATION, and it is this capability's own rather than the order rail's. The
-- order rail already says "this order is paid"; what only this rail can say is "the money for it
-- was settled through the channel that was asked", and a capability that owns a notification owns
-- its own enqueue.
--
-- The barrier lives in the trigger's WHEN clause rather than in an early RETURN inside the body: a
-- condition the planner evaluates before the function is entered cannot be reached by a statement
-- that did not change what it claims to have changed. The emitter is idempotent on
-- (event type, key) as well, so a replayed settlement cannot double-notify.
CREATE FUNCTION public.commerce_settlement_emit_settled_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.order_id, 'commerce.settlement.settled',
          'settlement_settled:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.order_id, 'settlementUuid', NEW.id,
                             'amountMinor', NEW.amount_minor, 'currencyCode', NEW.currency_code,
                             'occurredAt', NEW.settled_at),
          jsonb_build_object('source', 'commerce_settlement_emit_settled_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_commerce_settlement_emit_settled
  AFTER UPDATE OF status ON public.commerce_settlement_intents
  FOR EACH ROW
  WHEN (NEW.status = 'settled' AND OLD.status IS DISTINCT FROM 'settled'
        AND NEW.settled_at IS NOT NULL)
  EXECUTE FUNCTION public.commerce_settlement_emit_settled_notification();
