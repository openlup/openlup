-- Public automatic-subscription-renewal rail.
--
-- CHANGE. This forward adds the neutral, durable operation spine required to move one due
-- subscription through a fenced worker claim, stock admission and reservation, cycle/order/
-- settlement preparation, and a terminal acknowledgement. One immutable operation fingerprint
-- is copied onto every business relation the operation owns. The same `(subscription,
-- scheduled_at)` can therefore never become two cycles, orders, reservations or settlement
-- intents, even when leases expire or workers race.
--
-- WHY. The public catalogue already owns subscriptions, observed stock, orders and settlement
-- truth, but no runtime could compose them into an unattended renewal. In particular, observed
-- stock was explicitly not ATP, and the settlement rail deliberately had no reservation. This
-- forward supplies those missing semantics without recreating a managed-provider schema.
--
-- SAFETY AND DEPARTURES. The canonical operation key is
-- `subscription:<uuid>:cycle:<ISO instant>`. A SHA-256 fingerprint over the neutral immutable
-- snapshot is supplied by the application, shape-checked here, persisted unchanged and compared
-- on every replay. PostgreSQL does not pretend it contacted a payment provider: a successful
-- terminal acknowledgement requires a non-empty opaque external reference and delegates money
-- truth and the single subscription-schedule advance to `commerce_record_settlement`; this
-- forward never advances `next_cycle_at` a second time. An indeterminate provider call remains
-- `attempt_prepared`; it does not release stock, open dunning or authorize another attempt.
-- Inventory refusal and pre-payment expiry are durable neutral refusals and never customer
-- dunning. There are no provider enums, gateway payloads, webhook tables, retry ladders, roles,
-- RLS policies, grants or SECURITY DEFINER routines below. All functions are invoker-rights with
-- fixed search paths; the host application remains the security boundary.
--
-- ROLLBACK. Disable the direct renewal adopter first. The new relations/functions and nullable
-- linkage columns are capability-local. Existing lifecycle, stock and settlement rows remain
-- valid after those links are removed; no historical row is rewritten by this migration.

CREATE TABLE public.subscription_renewal_terms (
  subscription_id uuid PRIMARY KEY REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  next_cycle_number integer NOT NULL DEFAULT 1,
  currency_code text NOT NULL,
  stock_source_key text NOT NULL,
  settlement_channel_key text NOT NULL,
  unattended_charge_authorized_at timestamptz NOT NULL,
  authorization_ref text NOT NULL,
  payer_account_ref text,
  delivery_admission text NOT NULL DEFAULT 'allowed',
  delivery_block_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_renewal_terms_cycle_number_check CHECK (next_cycle_number > 0),
  CONSTRAINT subscription_renewal_terms_currency_check CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT subscription_renewal_terms_stock_source_check
    CHECK (stock_source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT subscription_renewal_terms_channel_check
    CHECK (btrim(settlement_channel_key) <> '' AND char_length(settlement_channel_key) <= 64),
  CONSTRAINT subscription_renewal_terms_authorization_ref_check
    CHECK (btrim(authorization_ref) <> '' AND char_length(authorization_ref) <= 180),
  CONSTRAINT subscription_renewal_terms_payer_account_ref_check
    CHECK (payer_account_ref IS NULL OR (
      btrim(payer_account_ref) <> '' AND char_length(payer_account_ref) <= 180)),
  CONSTRAINT subscription_renewal_terms_delivery_admission_check
    CHECK (delivery_admission IN ('allowed', 'blocked')),
  CONSTRAINT subscription_renewal_terms_delivery_reason_check CHECK (
    (delivery_admission = 'allowed' AND delivery_block_reason IS NULL)
    OR (delivery_admission = 'blocked' AND btrim(COALESCE(delivery_block_reason, '')) <> '')
  )
);

COMMENT ON COLUMN public.subscription_renewal_terms.authorization_ref IS
  'Opaque host evidence that unattended charging was authorized; stored and compared, never parsed.';
COMMENT ON COLUMN public.subscription_renewal_terms.settlement_channel_key IS
  'Opaque settlement-channel selection. This rail contains no provider vocabulary.';

CREATE TABLE public.subscription_renewal_term_lines (
  subscription_id uuid NOT NULL REFERENCES public.subscription_renewal_terms(subscription_id)
    ON DELETE CASCADE,
  line_ordinal integer NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL,
  unit_amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, line_ordinal),
  CONSTRAINT subscription_renewal_term_lines_sku_key UNIQUE (subscription_id, sku),
  CONSTRAINT subscription_renewal_term_lines_ordinal_check CHECK (line_ordinal > 0),
  CONSTRAINT subscription_renewal_term_lines_sku_check CHECK (btrim(sku) <> ''),
  CONSTRAINT subscription_renewal_term_lines_quantity_check CHECK (quantity > 0),
  CONSTRAINT subscription_renewal_term_lines_amount_check CHECK (unit_amount_minor >= 0)
);

CREATE TABLE public.subscription_renewal_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE RESTRICT,
  scheduled_at timestamptz NOT NULL,
  cycle_number integer NOT NULL,
  identity_key text NOT NULL,
  operation_fingerprint text NOT NULL,
  cycle_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'claimed',
  claim_token uuid NOT NULL,
  claim_generation bigint NOT NULL DEFAULT 1,
  claimed_by text NOT NULL,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  attempt_prepared_at timestamptz,
  external_attempt_ref text,
  external_attempt_acknowledged_at timestamptz,
  terminal_outcome text,
  terminal_reason text,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_renewal_operations_identity_key_key UNIQUE (identity_key),
  CONSTRAINT subscription_renewal_operations_cycle_key UNIQUE (subscription_id, scheduled_at),
  CONSTRAINT subscription_renewal_operations_cycle_number_check CHECK (cycle_number > 0),
  CONSTRAINT subscription_renewal_operations_identity_check
    CHECK (char_length(btrim(identity_key)) BETWEEN 48 AND 180),
  CONSTRAINT subscription_renewal_operations_fingerprint_check
    CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_renewal_operations_snapshot_check
    CHECK (jsonb_typeof(cycle_snapshot) = 'object'),
  CONSTRAINT subscription_renewal_operations_state_check
    CHECK (state IN ('claimed', 'reserved', 'attempt_prepared', 'succeeded', 'refused')),
  CONSTRAINT subscription_renewal_operations_claim_generation_check CHECK (claim_generation > 0),
  CONSTRAINT subscription_renewal_operations_claimed_by_check CHECK (btrim(claimed_by) <> ''),
  CONSTRAINT subscription_renewal_operations_lease_check CHECK (lease_expires_at > claimed_at),
  CONSTRAINT subscription_renewal_operations_external_attempt_check CHECK (
    (external_attempt_ref IS NULL AND external_attempt_acknowledged_at IS NULL)
    OR (btrim(COALESCE(external_attempt_ref, '')) <> ''
      AND char_length(external_attempt_ref) <= 240
      AND external_attempt_acknowledged_at IS NOT NULL)
  ),
  CONSTRAINT subscription_renewal_operations_terminal_check CHECK (
    (state IN ('succeeded', 'refused')
      AND terminal_outcome = CASE state WHEN 'succeeded' THEN 'succeeded' ELSE 'refused' END
      AND terminal_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'refused')
      AND terminal_outcome IS NULL AND terminal_reason IS NULL AND terminal_at IS NULL)
  )
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX subscription_renewal_operations_due_recovery_idx
  ON public.subscription_renewal_operations (state, lease_expires_at, scheduled_at);

CREATE TABLE public.subscription_renewal_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  renewal_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(id)
    ON DELETE CASCADE,
  operation_fingerprint text NOT NULL,
  event_key text NOT NULL,
  outcome text NOT NULL,
  reason text,
  external_ref text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_renewal_outcomes_event_key_key UNIQUE (renewal_operation_id, event_key),
  CONSTRAINT subscription_renewal_outcomes_fingerprint_check
    CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_renewal_outcomes_event_key_check CHECK (btrim(event_key) <> ''),
  CONSTRAINT subscription_renewal_outcomes_outcome_check CHECK (outcome IN ('succeeded', 'refused')),
  CONSTRAINT subscription_renewal_outcomes_external_ref_check CHECK (
    external_ref IS NULL OR (btrim(external_ref) <> '' AND char_length(external_ref) <= 240)
  )
);

CREATE TABLE public.fulfillment_inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  renewal_operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(id)
    ON DELETE RESTRICT,
  operation_fingerprint text NOT NULL,
  source_key text NOT NULL,
  status text NOT NULL DEFAULT 'held',
  expires_at timestamptz,
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_inventory_reservations_operation_key UNIQUE (renewal_operation_id),
  CONSTRAINT fulfillment_inventory_reservations_fingerprint_check
    CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fulfillment_inventory_reservations_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT fulfillment_inventory_reservations_status_check
    CHECK (status IN ('held', 'committed', 'consumed', 'released', 'expired')),
  CONSTRAINT fulfillment_inventory_reservations_expiry_check CHECK (
    (status = 'held' AND expires_at IS NOT NULL AND expires_at > created_at)
    OR (status <> 'held')
  ),
  CONSTRAINT fulfillment_inventory_reservations_terminal_reason_check CHECK (
    (status IN ('released', 'expired') AND btrim(COALESCE(terminal_reason, '')) <> '')
    OR (status NOT IN ('released', 'expired') AND terminal_reason IS NULL)
  )
);

CREATE TABLE public.fulfillment_inventory_reservation_lines (
  reservation_id uuid NOT NULL REFERENCES public.fulfillment_inventory_reservations(id)
    ON DELETE CASCADE,
  operation_fingerprint text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL,
  PRIMARY KEY (reservation_id, sku),
  CONSTRAINT fulfillment_inventory_reservation_lines_fingerprint_check
    CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fulfillment_inventory_reservation_lines_sku_check CHECK (btrim(sku) <> ''),
  CONSTRAINT fulfillment_inventory_reservation_lines_quantity_check CHECK (quantity > 0)
);

-- Nullable links preserve every row created by earlier forwards. New renewal rows always populate
-- both columns, and the functions below compare the fingerprint to the root before mutating.
ALTER TABLE public.subscription_cycles
  ADD COLUMN renewal_operation_id uuid,
  ADD COLUMN renewal_operation_fingerprint text;
ALTER TABLE public.subscription_cycles
  ADD CONSTRAINT subscription_cycles_renewal_operation_fkey
    FOREIGN KEY (renewal_operation_id) REFERENCES public.subscription_renewal_operations(id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT subscription_cycles_renewal_fingerprint_check CHECK (
    (renewal_operation_id IS NULL AND renewal_operation_fingerprint IS NULL)
    OR (renewal_operation_id IS NOT NULL
      AND renewal_operation_fingerprint ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

-- openlup:allow-unique-index: this partial index covers only renewal-owned rows. The column is
-- introduced immediately above, so no pre-existing row can enter the index; non-concurrent form
-- keeps the manifest forward transaction-safe while avoiding an index entry for every legacy row.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX subscription_cycles_renewal_operation_key
  ON public.subscription_cycles (renewal_operation_id)
  WHERE renewal_operation_id IS NOT NULL;

ALTER TABLE public.commerce_orders
  ADD COLUMN renewal_operation_id uuid,
  ADD COLUMN renewal_operation_fingerprint text;
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_renewal_operation_fkey
    FOREIGN KEY (renewal_operation_id) REFERENCES public.subscription_renewal_operations(id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT commerce_orders_renewal_fingerprint_check CHECK (
    (renewal_operation_id IS NULL AND renewal_operation_fingerprint IS NULL)
    OR (renewal_operation_id IS NOT NULL
      AND renewal_operation_fingerprint ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

-- openlup:allow-unique-index: the new nullable link has no pre-existing indexed rows; the partial
-- predicate preserves exact-one renewal ownership without indexing legacy orders.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX commerce_orders_renewal_operation_key
  ON public.commerce_orders (renewal_operation_id)
  WHERE renewal_operation_id IS NOT NULL;

ALTER TABLE public.commerce_settlement_intents
  ADD COLUMN renewal_operation_id uuid,
  ADD COLUMN renewal_operation_fingerprint text;
ALTER TABLE public.commerce_settlement_intents
  ADD CONSTRAINT commerce_settlement_intents_renewal_operation_fkey
    FOREIGN KEY (renewal_operation_id) REFERENCES public.subscription_renewal_operations(id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT commerce_settlement_intents_renewal_fingerprint_check CHECK (
    (renewal_operation_id IS NULL AND renewal_operation_fingerprint IS NULL)
    OR (renewal_operation_id IS NOT NULL
      AND renewal_operation_fingerprint ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

-- openlup:allow-unique-index: the new nullable link has no pre-existing indexed rows; the partial
-- predicate preserves exact-one renewal ownership without indexing legacy settlement intents.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX commerce_settlement_intents_renewal_operation_key
  ON public.commerce_settlement_intents (renewal_operation_id)
  WHERE renewal_operation_id IS NOT NULL;

CREATE FUNCTION public.subscription_renewal_identity(
  p_subscription_id uuid,
  p_scheduled_at timestamptz
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT 'subscription:' || p_subscription_id::text || ':cycle:'
    || to_char(p_scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

CREATE FUNCTION public.subscription_renewal_operation_response(
  p_operation public.subscription_renewal_operations,
  p_acquired boolean,
  p_replayed boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'platform.subscription.renewal.v1',
    'acquired', p_acquired,
    'replayed', p_replayed,
    'reason', p_reason,
    'operationId', p_operation.id,
    'identityKey', p_operation.identity_key,
    'operationFingerprint', p_operation.operation_fingerprint,
    'subscriptionId', p_operation.subscription_id,
    'scheduledAt', p_operation.scheduled_at,
    'cycleNumber', p_operation.cycle_number,
    'state', p_operation.state,
    'claimToken', p_operation.claim_token,
    'claimGeneration', p_operation.claim_generation,
    'leaseExpiresAt', p_operation.lease_expires_at,
    'cycleSnapshot', p_operation.cycle_snapshot,
    'externalAttemptRef', p_operation.external_attempt_ref,
    'externalAttemptAcknowledgedAt', p_operation.external_attempt_acknowledged_at,
    'terminalOutcome', p_operation.terminal_outcome,
    'terminalReason', p_operation.terminal_reason,
    'terminalAt', p_operation.terminal_at,
    'reservationId', (
      SELECT reservation.id FROM public.fulfillment_inventory_reservations reservation
       WHERE reservation.renewal_operation_id = p_operation.id),
    'cycleId', (
      SELECT cycle.id FROM public.subscription_cycles cycle
       WHERE cycle.renewal_operation_id = p_operation.id),
    'orderId', (
      SELECT order_row.id FROM public.commerce_orders order_row
       WHERE order_row.renewal_operation_id = p_operation.id),
    'settlementIntentId', (
      SELECT intent.id FROM public.commerce_settlement_intents intent
       WHERE intent.renewal_operation_id = p_operation.id));
$$;

CREATE FUNCTION public.subscription_list_due_renewals(
  p_as_of timestamptz DEFAULT now(),
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  subscription_id uuid,
  client_id uuid,
  scheduled_at timestamptz,
  cadence_days integer,
  cycle_number integer,
  currency_code text,
  stock_source_key text,
  settlement_channel_key text,
  authorization_ref text,
  payer_account_ref text,
  unattended_charge_authorized_at timestamptz,
  delivery_admission text,
  delivery_block_reason text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT subscription.id, subscription.client_id, subscription.next_cycle_at,
         subscription.cadence_days, terms.next_cycle_number, terms.currency_code,
         terms.stock_source_key, terms.settlement_channel_key, terms.authorization_ref,
         terms.payer_account_ref,
         terms.unattended_charge_authorized_at, terms.delivery_admission,
         terms.delivery_block_reason
    FROM public.subscriptions subscription
    JOIN public.subscription_renewal_terms terms ON terms.subscription_id = subscription.id
   WHERE subscription.status = 'active'
     AND subscription.next_cycle_at IS NOT NULL
     AND subscription.next_cycle_at <= COALESCE(p_as_of, now())
     AND NOT EXISTS (
       SELECT 1 FROM public.subscription_renewal_operations operation
        WHERE operation.subscription_id = subscription.id
          AND operation.scheduled_at = subscription.next_cycle_at
          AND (
            operation.state IN ('succeeded', 'refused')
            OR operation.lease_expires_at > COALESCE(p_as_of, now())
          ))
   ORDER BY subscription.next_cycle_at, subscription.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

CREATE FUNCTION public.subscription_claim_due_renewal(
  p_identity_key text,
  p_operation_fingerprint text,
  p_cycle_snapshot jsonb,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_scheduled_at timestamptz;
  v_cycle_number integer;
  v_subscription public.subscriptions%ROWTYPE;
  v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_identity_key IS NULL OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_cycle_snapshot IS NULL OR jsonb_typeof(p_cycle_snapshot) <> 'object'
    OR p_cycle_snapshot->>'contractVersion' <> 'platform.subscription.renewal.v1'
    OR btrim(COALESCE(p_worker_id, '')) = ''
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_subscription_id := (p_cycle_snapshot->>'subscriptionId')::uuid;
    v_scheduled_at := (p_cycle_snapshot->>'scheduledAt')::timestamptz;
    v_cycle_number := (p_cycle_snapshot->>'cycleNumber')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END;

  IF v_cycle_number < 1
    OR p_identity_key <> public.subscription_renewal_identity(v_subscription_id, v_scheduled_at)
    OR jsonb_typeof(p_cycle_snapshot->'lines') <> 'array'
    OR jsonb_array_length(p_cycle_snapshot->'lines') = 0
    OR p_cycle_snapshot->>'currency' !~ '^[A-Z]{3}$'
    OR (p_cycle_snapshot->>'totalAmountMinor')::bigint < 1
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND OR v_subscription.status <> 'active'
    OR v_subscription.next_cycle_at IS DISTINCT FROM v_scheduled_at
    OR v_subscription.next_cycle_at > COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation
    FROM public.subscription_renewal_operations
   WHERE subscription_id = v_subscription_id AND scheduled_at = v_scheduled_at
   FOR UPDATE;

  IF FOUND THEN
    IF v_operation.identity_key <> p_identity_key
      OR v_operation.operation_fingerprint <> p_operation_fingerprint
      OR v_operation.cycle_snapshot <> p_cycle_snapshot
    THEN
      RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_operation.state IN ('succeeded', 'refused') THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal');
    END IF;
    IF v_operation.lease_expires_at > COALESCE(p_now, now()) THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'lease_active');
    END IF;
    UPDATE public.subscription_renewal_operations
       SET claim_token = gen_random_uuid(),
           claim_generation = claim_generation + 1,
           claimed_by = p_worker_id,
           claimed_at = COALESCE(p_now, now()),
           lease_expires_at = COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_operation.id
     RETURNING * INTO v_operation;
    RETURN public.subscription_renewal_operation_response(v_operation, true, true, 'lease_taken_over');
  END IF;

  INSERT INTO public.subscription_renewal_operations (
    subscription_id, scheduled_at, cycle_number, identity_key, operation_fingerprint,
    cycle_snapshot, claim_token, claimed_by, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_subscription_id, v_scheduled_at, v_cycle_number, p_identity_key,
    p_operation_fingerprint, p_cycle_snapshot, gen_random_uuid(), p_worker_id,
    COALESCE(p_now, now()), COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
    COALESCE(p_now, now())
  ) RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(v_operation, true, false, 'claimed');
END;
$$;

CREATE FUNCTION public.subscription_read_renewal(p_identity_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE identity_key = p_identity_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'readback');
END;
$$;

CREATE FUNCTION public.subscription_refuse_renewal_preflight(
  p_operation_id uuid,
  p_claim_token uuid,
  p_reason text,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_claim_token IS NULL
    OR btrim(COALESCE(p_reason, '')) = '' OR char_length(p_reason) > 180
  THEN
    RAISE EXCEPTION 'subscription_renewal_preflight_refusal_invalid_input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_renewal_preflight_refusal_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.operation_fingerprint IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_preflight_refusal_fingerprint_missing' USING ERRCODE = '23505';
  END IF;
  IF v_operation.state = 'refused' THEN
    RETURN public.subscription_renewal_operation_response(
      v_operation, false, true, 'preflight_refusal_replay');
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_occurred_at, now())
    OR v_operation.state NOT IN ('claimed', 'reserved')
  THEN
    RAISE EXCEPTION 'subscription_renewal_preflight_refusal_stale_claim' USING ERRCODE = '40001';
  END IF;
  UPDATE public.fulfillment_inventory_reservations
     SET status = 'released', terminal_reason = p_reason,
         expires_at = NULL, updated_at = COALESCE(p_occurred_at, now())
   WHERE renewal_operation_id = p_operation_id AND status = 'held';
  INSERT INTO public.subscription_renewal_outcomes (
    renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
  ) VALUES (
    v_operation.id, v_operation.operation_fingerprint,
    v_operation.identity_key || ':preflight-refusal', 'refused', p_reason,
    COALESCE(p_occurred_at, now()));
  UPDATE public.subscription_renewal_operations
     SET state = 'refused', terminal_outcome = 'refused', terminal_reason = p_reason,
         terminal_at = COALESCE(p_occurred_at, now()), updated_at = COALESCE(p_occurred_at, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(
    v_operation, false, false, 'preflight_refused');
END;
$$;

CREATE FUNCTION public.fulfillment_reserve_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_hold_seconds integer DEFAULT 900,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_line jsonb;
  v_source text;
  v_sku text;
  v_quantity integer;
  v_available integer;
  v_reserved integer;
BEGIN
  IF p_operation_id IS NULL OR p_claim_token IS NULL
    OR p_hold_seconds IS NULL OR p_hold_seconds NOT BETWEEN 60 AND 86400
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.operation_fingerprint <> v_operation.operation_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_reservation.status = 'held'
      AND v_reservation.expires_at <= COALESCE(p_now, now())
      AND v_operation.state = 'reserved'
    THEN
      UPDATE public.fulfillment_inventory_reservations
         SET status = 'expired', expires_at = NULL,
             terminal_reason = 'reservation_expired', updated_at = COALESCE(p_now, now())
       WHERE id = v_reservation.id
       RETURNING * INTO v_reservation;
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':reservation-expired', 'refused',
        'reservation_expired', COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', true, 'reservationId', v_reservation.id,
        'status', 'expired', 'reason', 'reservation_expired');
    END IF;
    RETURN jsonb_build_object(
      'reserved', v_reservation.status IN ('held', 'committed', 'consumed'),
      'replayed', true, 'reservationId', v_reservation.id,
      'status', v_reservation.status, 'reason', v_reservation.terminal_reason);
  END IF;

  IF v_operation.state <> 'claimed' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_state' USING ERRCODE = '22023';
  END IF;
  v_source := v_operation.cycle_snapshot->>'stockSourceKey';
  IF v_source IS NULL OR v_source !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  -- Lock all stock rows in a deterministic order before computing ATP, so two different
  -- operations containing the same SKUs cannot both spend the same observed availability.
  PERFORM stock.sku
    FROM public.fulfillment_stock_current stock
    JOIN jsonb_array_elements(v_operation.cycle_snapshot->'lines') line
      ON stock.source_key = v_source AND stock.sku = line->>'sku'
   ORDER BY stock.sku
   FOR UPDATE OF stock;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_sku := v_line->>'sku';
    BEGIN v_quantity := (v_line->>'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END;
    IF btrim(COALESCE(v_sku, '')) = '' OR v_quantity < 1 THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END IF;

    SELECT stock.for_sale_quantity INTO v_available
      FROM public.fulfillment_stock_current stock
     WHERE stock.source_key = v_source AND stock.sku = v_sku
       AND stock.inventory_class = 'sellable'
       AND stock.stale_after > COALESCE(p_now, now());
    IF NOT FOUND THEN v_available := 0; END IF;

    SELECT COALESCE(sum(reservation_line.quantity), 0)::integer INTO v_reserved
      FROM public.fulfillment_inventory_reservation_lines reservation_line
      JOIN public.fulfillment_inventory_reservations reservation
        ON reservation.id = reservation_line.reservation_id
     WHERE reservation.source_key = v_source AND reservation_line.sku = v_sku
       AND reservation.status IN ('held', 'committed')
       AND (reservation.status = 'committed' OR reservation.expires_at > COALESCE(p_now, now()));
    IF v_available - v_reserved < v_quantity THEN
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'inventory_unavailable', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':inventory', 'refused', 'inventory_unavailable',
        COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', false, 'reservationId', NULL,
        'status', 'refused', 'reason', 'inventory_unavailable');
    END IF;
  END LOOP;

  INSERT INTO public.fulfillment_inventory_reservations (
    renewal_operation_id, operation_fingerprint, source_key, expires_at, created_at, updated_at
  ) VALUES (
    p_operation_id, v_operation.operation_fingerprint, v_source,
    COALESCE(p_now, now()) + make_interval(secs => p_hold_seconds),
    COALESCE(p_now, now()), COALESCE(p_now, now())
  ) RETURNING * INTO v_reservation;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    INSERT INTO public.fulfillment_inventory_reservation_lines (
      reservation_id, operation_fingerprint, sku, quantity
    ) VALUES (
      v_reservation.id, v_operation.operation_fingerprint,
      v_line->>'sku', (v_line->>'quantity')::integer);
  END LOOP;

  UPDATE public.subscription_renewal_operations
     SET state = 'reserved', updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id;
  RETURN jsonb_build_object(
    'reserved', true, 'replayed', false, 'reservationId', v_reservation.id,
    'status', 'held', 'reason', NULL);
END;
$$;

CREATE FUNCTION public.fulfillment_release_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_reason text,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
BEGIN
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'fulfillment_renewal_release_reason_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_release_stale_claim' USING ERRCODE = '40001';
  END IF;
  IF v_operation.state = 'attempt_prepared' THEN
    RAISE EXCEPTION 'fulfillment_renewal_release_attempt_indeterminate' USING ERRCODE = '22023';
  END IF;
  IF v_operation.state IN ('succeeded', 'refused') THEN
    RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal');
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF FOUND AND v_reservation.status = 'held' THEN
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'released', expires_at = NULL, terminal_reason = p_reason,
           updated_at = COALESCE(p_now, now())
     WHERE id = v_reservation.id;
  END IF;
  UPDATE public.subscription_renewal_operations
     SET state = 'refused', terminal_outcome = 'refused', terminal_reason = p_reason,
         terminal_at = COALESCE(p_now, now()), updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  INSERT INTO public.subscription_renewal_outcomes (
    renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
  ) VALUES (
    p_operation_id, v_operation.operation_fingerprint,
    v_operation.identity_key || ':release', 'refused', p_reason, COALESCE(p_now, now()));
  RETURN public.subscription_renewal_operation_response(v_operation, false, false, 'released');
END;
$$;

CREATE FUNCTION public.fulfillment_expire_subscription_renewals(
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE v_row record; v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT reservation.id, reservation.renewal_operation_id
      FROM public.fulfillment_inventory_reservations reservation
      JOIN public.subscription_renewal_operations operation
        ON operation.id = reservation.renewal_operation_id
     WHERE reservation.status = 'held'
       AND reservation.expires_at <= COALESCE(p_now, now())
       AND operation.state = 'reserved'
     ORDER BY reservation.expires_at, reservation.id
     FOR UPDATE OF reservation, operation SKIP LOCKED
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
  LOOP
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'expired', expires_at = NULL, terminal_reason = 'reservation_expired',
           updated_at = COALESCE(p_now, now())
     WHERE id = v_row.id;
    UPDATE public.subscription_renewal_operations
       SET state = 'refused', terminal_outcome = 'refused',
           terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_row.renewal_operation_id;
    INSERT INTO public.subscription_renewal_outcomes (
      renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
    ) SELECT operation.id, operation.operation_fingerprint,
             operation.identity_key || ':reservation-expired', 'refused',
             'reservation_expired', COALESCE(p_now, now())
        FROM public.subscription_renewal_operations operation
       WHERE operation.id = v_row.renewal_operation_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.commerce_prepare_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_cycle_id uuid;
  v_order_id uuid;
  v_intent_id uuid;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_quantity integer;
  v_unit_amount bigint;
  v_total bigint;
  v_currency text;
  v_channel text;
BEGIN
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'commerce_renewal_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT cycle.id, order_row.id, intent.id
    INTO v_cycle_id, v_order_id, v_intent_id
    FROM public.subscription_cycles cycle
    JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id
    JOIN public.commerce_settlement_intents intent ON intent.order_id = order_row.id
   WHERE cycle.renewal_operation_id = p_operation_id;
  IF FOUND THEN
    IF v_operation.state <> 'attempt_prepared' THEN
      RAISE EXCEPTION 'commerce_renewal_artifact_state_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'contractVersion', 'platform.subscription.renewal.v1', 'replayed', true,
      'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
      'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
      'state', v_operation.state);
  END IF;
  IF v_operation.state <> 'reserved' THEN
    RAISE EXCEPTION 'commerce_renewal_reservation_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_reservation.status <> 'held'
    OR v_reservation.expires_at <= COALESCE(p_now, now())
    OR v_reservation.operation_fingerprint <> v_operation.operation_fingerprint
  THEN
    RAISE EXCEPTION 'commerce_renewal_active_reservation_required' USING ERRCODE = '22023';
  END IF;

  v_currency := v_operation.cycle_snapshot->>'currency';
  v_channel := v_operation.cycle_snapshot->>'settlementChannelKey';
  v_total := (v_operation.cycle_snapshot->>'totalAmountMinor')::bigint;
  IF v_currency !~ '^[A-Z]{3}$' OR btrim(COALESCE(v_channel, '')) = '' OR v_total < 1 THEN
    RAISE EXCEPTION 'commerce_renewal_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_cycles (
    subscription_id, scheduled_at, status, renewal_operation_id,
    renewal_operation_fingerprint, updated_at
  ) VALUES (
    v_operation.subscription_id, v_operation.scheduled_at, 'payment_pending', p_operation_id,
    v_operation.operation_fingerprint, COALESCE(p_now, now())
  ) RETURNING id INTO v_cycle_id;

  INSERT INTO public.commerce_orders (
    client_id, subscription_cycle_id, status, currency_code, total_amount_minor,
    source_kind, metadata, renewal_operation_id, renewal_operation_fingerprint, updated_at
  ) SELECT subscription.client_id, v_cycle_id, 'pending_payment', v_currency, v_total,
           'storefront', jsonb_build_object(
             'source', 'subscription.renewal',
             'renewalIdentityKey', v_operation.identity_key,
             'renewalOperationFingerprint', v_operation.operation_fingerprint,
             'cycleSnapshot', v_operation.cycle_snapshot),
           p_operation_id, v_operation.operation_fingerprint, COALESCE(p_now, now())
      FROM public.subscriptions subscription WHERE subscription.id = v_operation.subscription_id
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_amount := (v_line->>'unitAmountMinor')::bigint;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    IF NOT FOUND OR v_quantity < 1 OR v_unit_amount < 0 THEN
      RAISE EXCEPTION 'commerce_renewal_invalid_line' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_amount,
      v_quantity * v_unit_amount);
  END LOOP;

  PERFORM public.commerce_open_settlement_intent(
    v_operation.identity_key || ':settlement', v_order_id, v_channel, v_total, v_currency,
    jsonb_build_object(
      'renewalOperationId', p_operation_id,
      'renewalOperationFingerprint', v_operation.operation_fingerprint),
    COALESCE(p_now, now()));
  SELECT id INTO v_intent_id FROM public.commerce_settlement_intents WHERE order_id = v_order_id;
  UPDATE public.commerce_settlement_intents
     SET renewal_operation_id = p_operation_id,
         renewal_operation_fingerprint = v_operation.operation_fingerprint,
         updated_at = COALESCE(p_now, now())
   WHERE id = v_intent_id;
  UPDATE public.fulfillment_inventory_reservations
     SET status = 'committed', expires_at = NULL, updated_at = COALESCE(p_now, now())
   WHERE id = v_reservation.id;
  UPDATE public.subscription_renewal_operations
     SET state = 'attempt_prepared', attempt_prepared_at = COALESCE(p_now, now()),
         updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'contractVersion', 'platform.subscription.renewal.v1', 'replayed', false,
    'operationId', p_operation_id, 'operationFingerprint', v_operation.operation_fingerprint,
    'cycleId', v_cycle_id, 'orderId', v_order_id, 'settlementIntentId', v_intent_id,
    'state', v_operation.state);
END;
$$;

CREATE FUNCTION public.commerce_acknowledge_subscription_renewal_attempt(
  p_operation_id uuid,
  p_operation_fingerprint text,
  p_external_attempt_ref text,
  p_acknowledged_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL
    OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
    OR btrim(COALESCE(p_external_attempt_ref, '')) = ''
    OR char_length(p_external_attempt_ref) > 240
  THEN
    RAISE EXCEPTION 'commerce_renewal_attempt_ack_invalid_input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.state <> 'attempt_prepared' THEN
    RAISE EXCEPTION 'commerce_renewal_attempt_ack_not_prepared' USING ERRCODE = '22023';
  END IF;
  IF v_operation.operation_fingerprint <> p_operation_fingerprint THEN
    RAISE EXCEPTION 'commerce_renewal_attempt_ack_fingerprint_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_operation.external_attempt_ref IS NOT NULL THEN
    IF v_operation.external_attempt_ref <> p_external_attempt_ref THEN
      RAISE EXCEPTION 'commerce_renewal_attempt_ack_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.subscription_renewal_operation_response(
      v_operation, false, true, 'external_attempt_ack_replay');
  END IF;
  UPDATE public.subscription_renewal_operations
     SET external_attempt_ref = p_external_attempt_ref,
         external_attempt_acknowledged_at = COALESCE(p_acknowledged_at, now()),
         updated_at = COALESCE(p_acknowledged_at, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(
    v_operation, false, false, 'external_attempt_ack_recorded');
END;
$$;

CREATE FUNCTION public.commerce_record_subscription_renewal_outcome(
  p_operation_id uuid,
  p_event_key text,
  p_operation_fingerprint text,
  p_outcome text,
  p_external_ref text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_existing public.subscription_renewal_outcomes%ROWTYPE;
  v_intent public.commerce_settlement_intents%ROWTYPE;
BEGIN
  IF btrim(COALESCE(p_event_key, '')) = ''
    OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_outcome NOT IN ('succeeded', 'refused')
    OR (p_outcome = 'succeeded' AND btrim(COALESCE(p_external_ref, '')) = '')
  THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.operation_fingerprint <> p_operation_fingerprint THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_fingerprint_conflict' USING ERRCODE = '23505';
  END IF;
  IF p_external_ref IS NOT NULL
    AND v_operation.external_attempt_ref IS DISTINCT FROM p_external_ref
  THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_external_ack_mismatch' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_existing FROM public.subscription_renewal_outcomes
   WHERE renewal_operation_id = p_operation_id AND event_key = p_event_key;
  IF FOUND THEN
    IF v_existing.operation_fingerprint <> p_operation_fingerprint
      OR v_existing.outcome <> p_outcome
      OR v_existing.external_ref IS DISTINCT FROM p_external_ref
    THEN
      RAISE EXCEPTION 'commerce_renewal_outcome_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal_replay');
  END IF;
  IF v_operation.state IN ('succeeded', 'refused') THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_already_terminal' USING ERRCODE = '22023';
  END IF;
  IF v_operation.state <> 'attempt_prepared' THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_attempt_not_prepared' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_settlement_intents
   WHERE renewal_operation_id = p_operation_id;
  IF NOT FOUND OR v_intent.renewal_operation_fingerprint <> p_operation_fingerprint THEN
    RAISE EXCEPTION 'commerce_renewal_outcome_intent_not_found' USING ERRCODE = '22023';
  END IF;

  PERFORM public.commerce_record_settlement(
    p_event_key || ':settlement', v_intent.id,
    CASE p_outcome WHEN 'succeeded' THEN 'succeeded' ELSE 'failed' END,
    p_external_ref,
    jsonb_build_object(
      'reason', COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''),
                         CASE p_outcome WHEN 'refused' THEN 'declined' ELSE NULL END),
      'renewalOperationId', p_operation_id,
      'renewalOperationFingerprint', p_operation_fingerprint),
    COALESCE(p_occurred_at, now()));

  INSERT INTO public.subscription_renewal_outcomes (
    renewal_operation_id, operation_fingerprint, event_key, outcome, reason,
    external_ref, occurred_at
  ) VALUES (
    p_operation_id, p_operation_fingerprint, p_event_key, p_outcome,
    NULLIF(btrim(COALESCE(p_reason, '')), ''), p_external_ref, COALESCE(p_occurred_at, now()));

  IF p_outcome = 'succeeded' THEN
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'consumed', updated_at = COALESCE(p_occurred_at, now())
     WHERE renewal_operation_id = p_operation_id AND status = 'committed';
    UPDATE public.subscription_renewal_terms
       SET next_cycle_number = GREATEST(next_cycle_number, v_operation.cycle_number + 1),
           updated_at = COALESCE(p_occurred_at, now())
     WHERE subscription_id = v_operation.subscription_id;
  ELSE
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'released', terminal_reason = COALESCE(
             NULLIF(btrim(COALESCE(p_reason, '')), ''), 'settlement_refused'),
           updated_at = COALESCE(p_occurred_at, now())
     WHERE renewal_operation_id = p_operation_id AND status = 'committed';
  END IF;

  UPDATE public.subscription_renewal_operations
     SET state = p_outcome,
         terminal_outcome = p_outcome,
         terminal_reason = CASE WHEN p_outcome = 'refused' THEN COALESCE(
           NULLIF(btrim(COALESCE(p_reason, '')), ''), 'settlement_refused') ELSE NULL END,
         terminal_at = COALESCE(p_occurred_at, now()),
         updated_at = COALESCE(p_occurred_at, now())
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(v_operation, false, false, 'terminal_recorded');
END;
$$;
