-- Public platform accounting rail, second forward: the payout. Two relations, one mutation,
-- one derived verdict and one deferred invariant -- the way a deployment says "the transport
-- that took our customers' money has now moved some of it to us, and here is which payments it
-- was for".
--
-- WHAT THIS FORWARD SHIPS, AND WHY IT IS NOT THE SETTLEMENT RAIL. The settlement forward gave
-- this kernel the customer side of money: an order declares a total, an intent asks for it, one
-- accepted settlement marks the order paid. None of that says anything about the money
-- ARRIVING. Between "the customer paid" and "we were paid" sits a batch the transport assembles
-- on its own schedule, out of many payments, minus a fee it decides, landing as one amount. A
-- deployment that cannot record that batch cannot answer the only question an accountant asks
-- of a shop -- does the money that arrived equal the money the orders say was charged -- and
-- until this forward the second bundle could not express the question, let alone the answer.
--
-- THE BATCH IS EVIDENCE, NOT AN INSTRUCTION. Nothing below moves money, asks anyone for money,
-- or talks to anything. Every row here is a record of something that already happened
-- elsewhere, which is why there is no state machine, no retry, no schedule and no queue: a
-- payout is observed, and the only thing this kernel decides is whether what was observed
-- agrees with itself.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE. The behaviour was derived from the
-- managed chain by reading its settlement-sync plane end to end -- the batch upsert, the item
-- insert that replays on a constraint, the totals recomputed from the items, and the batch
-- verdict derived from the worst item it holds. Six departures, each named, because a silent
-- one is how a kernel and its origin quietly stop being the same machine:
--
--   1. THE BATCH TOTALS ARE A DEFERRED CONSTRAINT, NOT A CONVENTION. Upstream recomputes the
--      three totals inside the mutation and nothing defends them afterwards: one hand-written
--      INSERT into the item relation leaves a batch whose declared amount is a fiction, and
--      nothing anywhere notices. Here the agreement between a batch and its items is a
--      constraint trigger on BOTH sides, deferred to the end of the transaction that touched
--      either -- the same device the document rail's position sum uses, for the same reason.
--   2. CURRENCY LIVES ON THE BATCH, NOT ON EVERY ITEM. Upstream carries it on both and checks
--      neither against the other, so one batch can hold items in disagreeing currencies. A
--      payout is one wire in one currency; that is the fact, so it is stored once and a second
--      item that disagrees with it is refused by name. As in the settlement forward, currency
--      is a COLUMN WITH A CHECKED SHAPE and never a value: three characters, whichever three
--      the deployment declared.
--   3. MINOR UNITS, NOT CENTS, matching every forward this catalogue carries. `cents` is the
--      subdivision of two particular currencies.
--   4. EACH REFUSAL HAS ITS OWN NAME. Upstream raises one error for a key that is too short, a
--      negative amount, a status it does not recognise and arithmetic that does not add up.
--      Four different mistakes answered with one word is a diagnostic this kernel refuses to
--      inherit, so each is named below. The cross-bundle harness therefore compares exactly one
--      refusal -- the arithmetic one -- and the rest are proved on this bundle alone.
--   5. THE LINK TO A DOCUMENT AND AN ORDER IS OPTIONAL AND REAL. Upstream declares the same two
--      keys and its only shipped caller passes NULL for both in production, so on that side
--      they are columns nothing fills. They are kept here, as `ON DELETE SET NULL` keys onto
--      relations earlier forwards published, because "settled against the ledger" is the whole
--      point of the capability -- but they are optional, because a transport that reports a
--      payment this deployment cannot resolve must still be recordable. A payout that cannot be
--      matched is EXACTLY the row an operator needs to see.
--   6. NO `SECURITY DEFINER`, NO `GRANT`/`REVOKE`, NO ROW-LEVEL SECURITY, matching every forward
--      this catalogue carries and unlike upstream, where the same function is `SECURITY
--      DEFINER` behind four policies. This kernel creates zero roles; the functions below are
--      not a security boundary and the host application is what authenticates. `SET search_path`
--      is kept, because that one is a correctness property. Every constraint is named, and
--      `CREATE` is unconditional, because a manifest-ordered forward runs once against a known
--      prefix and `IF NOT EXISTS` would hide the drift the migration ledger exists to catch.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no transport. Not a name, not an enum, not a branch keyed on who paid out. `provider_kind`
--     is an opaque label this kernel stores, compares for equality, and never parses;
--   * no protocol, no credential, no polling and no inbound event relation. Whoever observed the
--     payout is the caller's problem;
--   * no bank account, no payout schedule, no fee model, no tax treatment of a fee;
--   * no reconciliation verdict about an ORDER. This forward says whether a batch agrees with
--     its own items. Whether a shop's takings agree with its documents is a report, and a report
--     is not platform data;
--   * no runtime binding. Not one line of the application is rewired onto these relations by
--     this forward; the falsifier is its own cross-bundle parity harness.

CREATE TABLE public.accounting_payout_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_kind text NOT NULL,
  provider_batch_id text NOT NULL,
  status text NOT NULL DEFAULT 'observed',
  currency text NOT NULL,
  gross_minor bigint NOT NULL DEFAULT 0,
  fee_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL DEFAULT 0,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_payout_batches_reference_key UNIQUE (provider_kind, provider_batch_id),
  CONSTRAINT accounting_payout_batches_provider_kind_nonempty_check CHECK (btrim(provider_kind) <> ''),
  CONSTRAINT accounting_payout_batches_provider_batch_id_nonempty_check CHECK (btrim(provider_batch_id) <> ''),
  -- Departure 2: a shape, never a value.
  CONSTRAINT accounting_payout_batches_currency_shape_check CHECK (char_length(currency) = 3),
  -- The four verdicts a batch can carry. Three of them are the observation still being
  -- incomplete in three different ways, and only one of them is "this agrees".
  CONSTRAINT accounting_payout_batches_status_check CHECK (status IN (
    'observed', 'reconciled', 'mismatch', 'bank_pending'
  )),
  CONSTRAINT accounting_payout_batches_amounts_check CHECK (
    gross_minor >= 0 AND fee_minor >= 0 AND net_minor >= 0
  ),
  CONSTRAINT accounting_payout_batches_net_check CHECK (net_minor = gross_minor - fee_minor)
);

CREATE TABLE public.accounting_payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.accounting_payout_batches(id) ON DELETE CASCADE,
  provider_payment_id text NOT NULL,
  -- Departure 5: optional on purpose, and the reason is in the header.
  document_id uuid REFERENCES public.accounting_documents(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE SET NULL,
  status text NOT NULL,
  gross_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  net_minor bigint NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_payout_items_reference_key UNIQUE (batch_id, provider_payment_id),
  CONSTRAINT accounting_payout_items_provider_payment_id_nonempty_check
    CHECK (btrim(provider_payment_id) <> ''),
  CONSTRAINT accounting_payout_items_status_check CHECK (status IN (
    'matched', 'unmatched', 'mismatch', 'bank_pending'
  )),
  CONSTRAINT accounting_payout_items_amounts_check CHECK (
    gross_minor >= 0 AND fee_minor >= 0 AND net_minor >= 0
  ),
  CONSTRAINT accounting_payout_items_net_check CHECK (net_minor = gross_minor - fee_minor)
);

-- The lookup an operator actually performs: which payout paid for this document. Partial,
-- because the majority of items on a young deployment carry no link at all.
CREATE INDEX idx_accounting_payout_items_document
  ON public.accounting_payout_items (document_id)
  WHERE document_id IS NOT NULL;

-- Departure 1. The batch's three totals are the sums of its items, checked at the end of the
-- transaction that touched either side, so a batch and its items can only ever be committed in
-- agreement. An argument check inside the mutation would be satisfied once and then bypassed by
-- the next write to the item relation.
CREATE FUNCTION public.accounting_payout_assert_batch_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_batch_id uuid;
  v_batch public.accounting_payout_batches%ROWTYPE;
  v_gross bigint;
  v_fee bigint;
  v_net bigint;
BEGIN
  -- Branching statements rather than one CASE expression, for the reason the document rail's
  -- position-sum trigger records: the two row types this trigger can see differ.
  IF TG_TABLE_NAME = 'accounting_payout_batches' THEN
    v_batch_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_batch_id := OLD.batch_id;
  ELSE
    v_batch_id := NEW.batch_id;
  END IF;

  SELECT * INTO v_batch FROM public.accounting_payout_batches WHERE id = v_batch_id;
  -- The batch is gone: a cascade took it, and there is nothing left to be consistent with.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(gross_minor), 0), COALESCE(sum(fee_minor), 0), COALESCE(sum(net_minor), 0)
    INTO v_gross, v_fee, v_net
    FROM public.accounting_payout_items
   WHERE batch_id = v_batch_id;

  IF v_batch.gross_minor IS DISTINCT FROM v_gross
     OR v_batch.fee_minor IS DISTINCT FROM v_fee
     OR v_batch.net_minor IS DISTINCT FROM v_net THEN
    RAISE EXCEPTION 'accounting_payout_batch_total_mismatch' USING ERRCODE = '23514',
      DETAIL = format('batch %s declares %s/%s/%s and its items sum to %s/%s/%s',
                      v_batch_id, v_batch.gross_minor, v_batch.fee_minor, v_batch.net_minor,
                      v_gross, v_fee, v_net);
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_accounting_payout_batches_totals
  AFTER INSERT OR UPDATE ON public.accounting_payout_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.accounting_payout_assert_batch_totals();

CREATE CONSTRAINT TRIGGER trg_accounting_payout_items_totals
  AFTER INSERT OR UPDATE OR DELETE ON public.accounting_payout_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.accounting_payout_assert_batch_totals();

-- The verdict, in one place, so the mutation and any later reader cannot disagree about what a
-- batch of a given shape means. Worst item wins: an item nobody could match, or one whose
-- amounts disagree with the payment they claim, makes the whole batch a mismatch; an item the
-- transport says it has not wired yet holds the batch open; only a batch whose every item is
-- matched has reconciled.
CREATE FUNCTION public.accounting_payout_batch_verdict(p_batch_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN count(*) = 0 THEN 'observed'
    WHEN count(*) FILTER (WHERE status IN ('mismatch', 'unmatched')) > 0 THEN 'mismatch'
    WHEN count(*) FILTER (WHERE status = 'bank_pending') > 0 THEN 'bank_pending'
    ELSE 'reconciled'
  END
  FROM public.accounting_payout_items
  WHERE batch_id = p_batch_id;
$$;

-- The one mutation. It records a single line of a payout, creating the batch that line belongs
-- to on first contact, and answers with the batch's verdict as of this observation.
CREATE FUNCTION public.accounting_payout_record_item(
  p_idempotency_key text,
  p_provider_kind text,
  p_provider_batch_id text,
  p_provider_payment_id text,
  p_currency text,
  p_status text,
  p_gross_minor bigint,
  p_fee_minor bigint,
  p_net_minor bigint,
  p_document_id uuid DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_settled_at timestamptz DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb,
  p_observed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_batch public.accounting_payout_batches%ROWTYPE;
  v_item public.accounting_payout_items%ROWTYPE;
  v_replayed boolean := false;
  v_verdict text;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
     OR p_provider_kind IS NULL OR btrim(p_provider_kind) = ''
     OR p_provider_batch_id IS NULL OR btrim(p_provider_batch_id) = ''
     OR p_provider_payment_id IS NULL OR btrim(p_provider_payment_id) = ''
     OR p_currency IS NULL OR char_length(p_currency) <> 3
     OR p_gross_minor IS NULL OR p_fee_minor IS NULL OR p_net_minor IS NULL THEN
    RAISE EXCEPTION 'accounting_payout_record_invalid_input' USING ERRCODE = '22023';
  END IF;

  -- Departure 4: four mistakes, four names.
  IF p_status IS NULL OR p_status NOT IN ('matched', 'unmatched', 'mismatch', 'bank_pending') THEN
    RAISE EXCEPTION 'accounting_payout_record_status_invalid' USING ERRCODE = '22023';
  END IF;

  IF p_gross_minor < 0 OR p_fee_minor < 0 OR p_net_minor < 0 THEN
    RAISE EXCEPTION 'accounting_payout_record_amount_negative' USING ERRCODE = '22023';
  END IF;

  IF p_net_minor <> p_gross_minor - p_fee_minor THEN
    RAISE EXCEPTION 'accounting_payout_record_net_mismatch' USING ERRCODE = '22023',
      DETAIL = format('item %s declares %s net of %s and %s', p_provider_payment_id,
                      p_net_minor, p_gross_minor, p_fee_minor);
  END IF;

  INSERT INTO public.accounting_payout_batches (
    provider_kind, provider_batch_id, currency, settled_at, created_at, updated_at, evidence
  )
  VALUES (
    p_provider_kind, p_provider_batch_id, p_currency, p_settled_at, p_observed_at, p_observed_at,
    COALESCE(p_evidence, '{}'::jsonb)
  )
  ON CONFLICT ON CONSTRAINT accounting_payout_batches_reference_key DO UPDATE
    SET updated_at = p_observed_at,
        settled_at = COALESCE(EXCLUDED.settled_at, accounting_payout_batches.settled_at),
        evidence = accounting_payout_batches.evidence || EXCLUDED.evidence
  RETURNING * INTO v_batch;

  -- Departure 2. Equality, not coercion: a batch that already knows what it was paid in is not
  -- quietly re-denominated by the next line somebody reports against it.
  IF v_batch.currency <> p_currency THEN
    RAISE EXCEPTION 'accounting_payout_batch_currency_conflict' USING ERRCODE = '23514',
      DETAIL = format('batch %s was observed in %s', v_batch.id, v_batch.currency);
  END IF;

  INSERT INTO public.accounting_payout_items (
    batch_id, provider_payment_id, document_id, order_id, status,
    gross_minor, fee_minor, net_minor, settled_at, created_at, evidence
  )
  VALUES (
    v_batch.id, p_provider_payment_id, p_document_id, p_order_id, p_status,
    p_gross_minor, p_fee_minor, p_net_minor, p_settled_at, p_observed_at,
    COALESCE(p_evidence, '{}'::jsonb) || jsonb_build_object('recordIdempotencyKey', p_idempotency_key)
  )
  ON CONFLICT ON CONSTRAINT accounting_payout_items_reference_key DO NOTHING
  RETURNING * INTO v_item;

  IF v_item.id IS NULL THEN
    -- Replay is a constraint, not a timestamp comparison: the second caller reads the row the
    -- first one wrote and is told so.
    v_replayed := true;
    SELECT * INTO v_item
      FROM public.accounting_payout_items
     WHERE batch_id = v_batch.id AND provider_payment_id = p_provider_payment_id;
  END IF;

  UPDATE public.accounting_payout_batches
     SET updated_at = p_observed_at,
         gross_minor = totals.gross_minor,
         fee_minor = totals.fee_minor,
         net_minor = totals.net_minor,
         status = public.accounting_payout_batch_verdict(v_batch.id)
    FROM (
      SELECT COALESCE(sum(gross_minor), 0) AS gross_minor,
             COALESCE(sum(fee_minor), 0) AS fee_minor,
             COALESCE(sum(net_minor), 0) AS net_minor
        FROM public.accounting_payout_items
       WHERE batch_id = v_batch.id
    ) AS totals
   WHERE id = v_batch.id
   RETURNING status INTO v_verdict;

  RETURN jsonb_build_object(
    'batchId', v_batch.id,
    'itemId', v_item.id,
    'status', v_verdict,
    'replayed', v_replayed
  );
END;
$$;
