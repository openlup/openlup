-- Public platform channel order ingest: the kernel learns to keep a durable record of an order
-- arriving from a registered sales channel, and a durable drawer for the ones it refuses.
--
-- WHAT THIS FORWARD SHIPS. The registry forward taught this kernel that a sale can come from
-- somewhere else; the axis forward let an order name where. Neither gave an adopter anywhere to
-- record the ACT of importing one. This does: a per-(channel, external order) ledger with a state
-- machine, a quarantine table, and the two functions that move them. After this forward an adopter
-- can drive an import loop against this kernel and answer "where did order X get to" from the
-- database rather than from a log.
--
-- WHAT IT REFUSES TO KNOW, AND THIS IS THE LOAD-BEARING PART. It ships NO order writer. That is a
-- measured scope decision, not caution: creating a channel order end to end needs an identity rail
-- (a buyer, an address), an inbound event log, and a payment control plane. This kernel has none of
-- the three. `addresses`, `customer_external_refs`, `inbound_provider_events`,
-- `commerce_payment_intents`, `commerce_payments`, `commerce_payment_attempts` and
-- `inventory_reservations` are all absent here, and its money model is the settlement-intent rail
-- rather than a payment control plane. Authoring an order-creating function against relations that
-- do not exist would be authoring a lie. What IS portable -- the ledger, its state machine, and the
-- quarantine -- ships in full; what is not is named here instead of being faked.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE. The shape below was derived from the managed
-- chain's ingest authored in the same wave. Five departures, each named, because a silent one is
-- how a kernel and its origin quietly stop being the same machine:
--
--   1. NO ROW-LEVEL SECURITY, NO POLICY, NO `GRANT`/`REVOKE`, matching every forward in this
--      catalogue and the registry forward's own first departure. None of the managed twin's
--      principals -- `service_role`, `authenticated`, the hosted read-only reader -- exists on this
--      kernel, and it creates zero roles. Said out loud rather than assumed: ON THIS KERNEL THESE
--      TABLES ARE NOT A SECURITY BOUNDARY. The host application decides who may read a quarantined
--      payload or advance a ledger.
--   2. FOUR COLUMNS OF THE LEDGER ARE ABSENT, because the relations they would point at are.
--      `shipping_address_id` and `payment_intent_id` have no referent here at all. `client_id` DOES
--      -- `clients` exists -- and is kept, because a host that resolves a buyer needs somewhere to
--      record which one. `order_id` is kept for the same reason and points at the real table.
--   3. `resolved_by` REFERENCES `commerce_operators`, not an auth table. The hold rail already
--      settled that question for this catalogue: an operator is a row, not a role, and only the row
--      half is portable.
--   4. THE INBOUND-EVENT HALF OF `record_inbound_event` IS ABSENT. The managed twin writes the
--      shared cross-adapter event log first and treats its unique key as the redelivery answer.
--      This kernel has no such log, and does not need one for this purpose: the ledger's own
--      `UNIQUE (channel_id, external_order_ref)` already makes a second delivery find the first
--      row. `event_replayed` is therefore derived from the ledger rather than from a second table,
--      and it means the same thing to a caller.
--   5. `CREATE` IS UNCONDITIONAL AND EVERY CONSTRAINT IS NAMED, because a manifest-ordered forward
--      runs exactly once against a known prefix and `IF NOT EXISTS` there would hide the drift the
--      migration ledger exists to catch. The managed twin is written for a chronological chain that
--      may meet a partially-applied database, and guards accordingly.
--
-- LOCKING, STATED AND ALSO SUPPRESSED. Both tables are created empty by this forward, so every
-- index and constraint below is built against nothing and has nothing to scan. No index is built
-- CONCURRENTLY, because a forward is applied inside a transaction and CONCURRENTLY cannot run in
-- one. The `squawk-ignore` directives below name a linter this catalogue does not itself run; they
-- are carried anyway because the shared pre-merge lock advisory reads BOTH chains, and a directive
-- present in only one of them is how the two quietly stop being checked the same way. The sentence
-- above is the part an adopter actually needs; the directive is bookkeeping for the pipeline.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no order writer, no buyer resolution, no address minting, for the measured reason above;
--   * no connector, no poll loop, no webhook ingestion, no acknowledgement back to the far side;
--   * no reservation of stock and no settlement of money. Both are the host application's rails;
--   * no tax arithmetic. A VAT rate is stored on a channel by the registry forward and applied by
--     nothing here;
--   * no automatic transition. Every status change is an explicit call; nothing sweeps, retries or
--     expires a ledger row on a timer.

-- One row per external order, per channel. `normalized` keeps the exact document the connector
-- produced, so a resume never has to ask the far side again.
CREATE TABLE public.channel_order_ingests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.sales_channels(id) ON DELETE RESTRICT,
  external_order_ref text NOT NULL,
  external_order_revision text,
  provider_event_id text NOT NULL,
  -- SET NULL rather than CASCADE: if an order is ever erased, this row is the only remaining
  -- evidence that the external order was seen at all, and losing it would let a redelivery import
  -- the same order a second time.
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE SET NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'received',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  normalized jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_order_ingests_external_order_ref_check
    CHECK (btrim(external_order_ref) <> '' AND char_length(external_order_ref) <= 128),
  CONSTRAINT channel_order_ingests_external_order_revision_check
    CHECK (external_order_revision IS NULL OR char_length(external_order_revision) <= 64),
  CONSTRAINT channel_order_ingests_provider_event_id_check
    CHECK (btrim(provider_event_id) <> '' AND char_length(provider_event_id) <= 200),
  CONSTRAINT channel_order_ingests_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT channel_order_ingests_last_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  -- Six ordered states and three off-ramps. The ordered lane is the happy path in the order an
  -- importer walks it; the other three are where a run stops and waits for stock, or for a person.
  CONSTRAINT channel_order_ingests_status_check CHECK (status IN (
    'received', 'buyer_ready', 'order_created', 'reserved', 'settled', 'done',
    'blocked_stock', 'quarantined', 'failed'
  )),
  -- The importer's identity. A second delivery of the same external order finds this row instead
  -- of starting a second run, and that is the whole redelivery answer on this kernel.
  CONSTRAINT channel_order_ingests_channel_external_ref_key
    UNIQUE (channel_id, external_order_ref)
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_channel_order_ingests_status
  ON public.channel_order_ingests (status, updated_at DESC);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_channel_order_ingests_order
  ON public.channel_order_ingests (order_id)
  WHERE order_id IS NOT NULL;

-- Everything an import refused, with enough of the original to act on. Both channel references are
-- SET NULL because a refused signal may name a surface that was never registered, or one an
-- operator later retires; the row must outlive both.
CREATE TABLE public.sales_channel_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid REFERENCES public.sales_channels(id) ON DELETE SET NULL,
  connection_id uuid REFERENCES public.sales_channel_connections(id) ON DELETE SET NULL,
  provider_event_id text NOT NULL,
  external_order_ref text,
  -- THE WIRE TOKEN, VERBATIM. Whatever string the far side actually sent. Never a panel label and
  -- never translated: an operator has to be able to search the far side's own documentation for
  -- this exact string.
  vocabulary text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  resolved_by uuid REFERENCES public.commerce_operators(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_channel_quarantine_provider_event_id_check
    CHECK (btrim(provider_event_id) <> '' AND char_length(provider_event_id) <= 200),
  CONSTRAINT sales_channel_quarantine_external_order_ref_check
    CHECK (external_order_ref IS NULL OR char_length(external_order_ref) <= 128),
  CONSTRAINT sales_channel_quarantine_vocabulary_check
    CHECK (btrim(vocabulary) <> '' AND char_length(vocabulary) <= 200),
  CONSTRAINT sales_channel_quarantine_reason_check CHECK (reason IN (
    'unmapped_vocabulary', 'unmapped_sellable', 'vat_unresolvable',
    'money_mismatch', 'revision_conflict', 'contract_parse_failed'
  )),
  CONSTRAINT sales_channel_quarantine_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT sales_channel_quarantine_resolution_note_check
    CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000),
  -- One row per (delivery, refused token). A redelivery of the same broken payload updates the row
  -- an operator is already looking at instead of stacking a second copy underneath it.
  CONSTRAINT sales_channel_quarantine_event_vocabulary_key
    UNIQUE (provider_event_id, vocabulary)
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_sales_channel_quarantine_open
  ON public.sales_channel_quarantine (status, created_at DESC);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX idx_sales_channel_quarantine_channel
  ON public.sales_channel_quarantine (channel_id, status)
  WHERE channel_id IS NOT NULL;

-- Open (or find) the ledger row for one delivery.
--
-- The revision conflict is the interesting half. Once the local order exists, a far side reporting
-- a DIFFERENT revision of the same order is telling us the two no longer agree, and there is no
-- honest way to reconcile that from inside this function. So the row is left exactly as it stands
-- and the conflict is handed back for the caller to quarantine. Nothing is mutated.
CREATE FUNCTION public.channel_ingest_record_inbound_event(
  p_channel_id uuid,
  p_external_order_ref text,
  p_external_order_revision text,
  p_provider_event_id text,
  p_normalized jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ledger public.channel_order_ingests%ROWTYPE;
BEGIN
  IF p_channel_id IS NULL
    OR p_external_order_ref IS NULL OR btrim(p_external_order_ref) = ''
    OR p_provider_event_id IS NULL OR btrim(p_provider_event_id) = ''
  THEN
    RAISE EXCEPTION 'channel_ingest_invalid_input' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.sales_channels WHERE id = p_channel_id) THEN
    RAISE EXCEPTION 'channel_ingest_channel_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ledger
    FROM public.channel_order_ingests
   WHERE channel_id = p_channel_id
     AND external_order_ref = p_external_order_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.channel_order_ingests (
      channel_id, external_order_ref, external_order_revision, provider_event_id,
      status, attempt_count, normalized
    )
    VALUES (
      p_channel_id, p_external_order_ref, p_external_order_revision, p_provider_event_id,
      'received', 1, COALESCE(p_normalized, '{}'::jsonb)
    )
    RETURNING * INTO v_ledger;

    RETURN public.channel_ingest_ledger_payload(v_ledger, NULL, false, false);
  END IF;

  IF v_ledger.status IN ('order_created', 'reserved', 'settled', 'done')
    AND v_ledger.external_order_revision IS DISTINCT FROM p_external_order_revision
  THEN
    RETURN public.channel_ingest_ledger_payload(v_ledger, 'revision_conflict', true, true);
  END IF;

  UPDATE public.channel_order_ingests
     SET attempt_count = attempt_count + 1,
         external_order_revision = COALESCE(p_external_order_revision, external_order_revision),
         normalized = CASE
           WHEN v_ledger.status IN ('order_created', 'reserved', 'settled', 'done') THEN normalized
           ELSE COALESCE(p_normalized, normalized)
         END,
         updated_at = now()
   WHERE id = v_ledger.id
   RETURNING * INTO v_ledger;

  RETURN public.channel_ingest_ledger_payload(v_ledger, NULL, true, true);
END;
$$;

-- The reply shape, spelled once. Both functions above and below return it, and a caller that reads
-- one can read the other.
CREATE FUNCTION public.channel_ingest_ledger_payload(
  p_ledger public.channel_order_ingests,
  p_conflict text,
  p_event_replayed boolean,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'channels.ingest.v0',
    'ingest', jsonb_build_object(
      'id', p_ledger.id,
      'status', p_ledger.status,
      'orderId', p_ledger.order_id,
      'clientId', p_ledger.client_id,
      'shippingAddressId', NULL,
      'paymentIntentId', NULL,
      'externalOrderRevision', p_ledger.external_order_revision,
      'conflict', p_conflict,
      'eventReplayed', p_event_replayed,
      'replayed', p_replayed
    )
  );
$$;

-- Move the ledger, forward only within the ordered lane.
--
-- The three off-ramps are unranked, so entering one is always legal and leaving one back into the
-- ordered lane is always forward. That is deliberate. This guard exists to stop a late redelivery
-- from walking a settled order back to the start; it is not what makes a resume correct. An
-- importer's steps are each expected to be independently replayable to the same result, and that --
-- not this comparison -- is the resume argument.
CREATE FUNCTION public.channel_ingest_advance(
  p_ledger_id uuid,
  p_to_status text,
  p_payment_intent_id uuid DEFAULT NULL,
  p_last_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ledger public.channel_order_ingests%ROWTYPE;
  v_ranks constant text[] := ARRAY[
    'received', 'buyer_ready', 'order_created', 'reserved', 'settled', 'done'
  ];
  v_from_rank integer;
  v_to_rank integer;
BEGIN
  IF p_ledger_id IS NULL OR p_to_status IS NULL THEN
    RAISE EXCEPTION 'channel_ingest_invalid_input' USING ERRCODE = '22023';
  END IF;

  -- Accepted and ignored. This kernel has no payment intent to point at (departure 2), and a
  -- caller written against the managed twin must not have to know that to call this.
  PERFORM p_payment_intent_id;

  SELECT * INTO v_ledger FROM public.channel_order_ingests WHERE id = p_ledger_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel_ingest_ledger_not_found' USING ERRCODE = '22023';
  END IF;

  v_from_rank := COALESCE(array_position(v_ranks, v_ledger.status), 0);
  v_to_rank := COALESCE(array_position(v_ranks, p_to_status), 0);

  IF v_to_rank > 0 AND v_to_rank < v_from_rank THEN
    RAISE EXCEPTION 'channel_ingest_status_regression' USING ERRCODE = '22023';
  END IF;

  UPDATE public.channel_order_ingests
     SET status = p_to_status,
         last_error = CASE WHEN v_to_rank > 0 THEN NULL ELSE left(p_last_error, 2000) END,
         updated_at = now()
   WHERE id = v_ledger.id
   RETURNING * INTO v_ledger;

  RETURN public.channel_ingest_ledger_payload(v_ledger, NULL, false, false);
END;
$$;

-- File a refusal. A redelivery of the same broken payload must not stack a second row under the one
-- an operator is already reading, and must not silently re-open one they have already closed -- so
-- the payload and reason are refreshed and `status` is left exactly where the operator put it.
CREATE FUNCTION public.channel_ingest_quarantine(
  p_channel_id uuid,
  p_connection_id uuid,
  p_provider_event_id text,
  p_external_order_ref text,
  p_vocabulary text,
  p_reason text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.sales_channel_quarantine%ROWTYPE;
BEGIN
  IF p_provider_event_id IS NULL OR btrim(p_provider_event_id) = ''
    OR p_vocabulary IS NULL OR btrim(p_vocabulary) = ''
    OR p_reason IS NULL
  THEN
    RAISE EXCEPTION 'channel_ingest_invalid_input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sales_channel_quarantine (
    channel_id, connection_id, provider_event_id, external_order_ref,
    vocabulary, reason, payload
  )
  VALUES (
    p_channel_id, p_connection_id, p_provider_event_id,
    NULLIF(btrim(COALESCE(p_external_order_ref, '')), ''),
    p_vocabulary, p_reason, COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT ON CONSTRAINT sales_channel_quarantine_event_vocabulary_key DO UPDATE
    SET reason = EXCLUDED.reason,
        payload = EXCLUDED.payload,
        channel_id = COALESCE(EXCLUDED.channel_id, public.sales_channel_quarantine.channel_id),
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'contractVersion', 'channels.ingest.v0',
    'quarantine', jsonb_build_object(
      'id', v_row.id, 'reason', v_row.reason, 'status', v_row.status,
      'vocabulary', v_row.vocabulary
    )
  );
END;
$$;

COMMENT ON TABLE public.channel_order_ingests IS
  'One row per external order per channel: an import loop resume point, carrying the ids each step minted so a retry reuses them instead of minting a second of anything.';
COMMENT ON TABLE public.sales_channel_quarantine IS
  'Everything a channel import refused, with the wire token verbatim so an operator can look it up on the far side. Operator work, not an error log.';
COMMENT ON COLUMN public.sales_channel_quarantine.vocabulary IS
  'The wire token exactly as received from the external surface. Never a panel label and never translated.';
