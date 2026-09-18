-- Public platform accounting rail, third forward: the rest of a document's life. Four optional
-- columns on the document, two relations, five mutations -- the way a deployment says "this
-- document has been put in front of whatever authority this market has, and here is what came
-- back, and here is the receipt for handing it to the person it is about".
--
-- WHAT THIS FORWARD SHIPS, AND WHY THE TWO HALVES ARE ONE FORWARD. The document forward gave
-- this kernel a document that an order owes, its positions, its corrections and its private
-- work queue. It stops at the moment the document exists. Everything an accountant does AFTER
-- that -- register it where the market requires registering it, and then actually deliver it --
-- was unreachable on this bundle. The two are one forward rather than two, because they are not
-- independent: whether a document may be delivered is a FUNCTION of what the authority said
-- about it. Shipping the delivery queue without the submission state would mean shipping the
-- queue with its own gate removed, and shipping the state without the queue would leave a state
-- machine with no observable consequence.
--
-- NOTHING HERE TALKS TO ANYTHING. There is no verb that submits. There is a verb that RECORDS AN
-- OUTCOME the caller was told about, and it refuses to record an acceptance that carries no
-- reference from whoever accepted it -- so a deployment cannot invent its own acceptance, and
-- the whole protocol line stays outside this kernel. Likewise nothing here delivers: the queue
-- hands out leases and takes back receipts, and what happens in between is the host
-- application's adapter, which this catalogue never names.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE. The behaviour was derived from the managed
-- chain by reading three bodies end to end -- the state recorder, the queue claim with its
-- parameterised gate, and the attempt-fenced settlement. Six departures, each named, because a
-- silent one is how a kernel and its origin quietly stop being the same machine:
--
--   1. THE MARKET RULE IS A PARAMETER, NOT A FORK. Upstream's claim predicate reads one market's
--      document kind and one market's authority column. Here the document carries a neutral
--      `submission_required` flag, the claim takes `p_require_submission_acceptance`, and the
--      rule "a document that must be registered is not delivered before it was registered" is
--      expressed without naming a market, an authority or a document kind. The rule itself is
--      kept, deliberately: deleting it would break every deployment in a market that has such an
--      authority, and a rule that can be switched off breaks nobody.
--   2. THE STATE SET IS CLOSED AND ITS ACCEPTANCE MUST BE EVIDENCED. Upstream accepts five state
--      names and refuses the rest, which is inherited unchanged. What is added is that
--      `accepted` demands a non-empty reference: acceptance is a fact about the outside world,
--      and a kernel that lets a caller assert it with no evidence has a state machine, not a
--      record.
--   3. RECORDING A FACT DOES NOT CREATE WORK. Upstream's state recorder INSERTS a delivery row
--      as a side effect of acceptance. Here a delivery is REQUESTED by its own verb, and
--      acceptance only opens the gate on a request that already exists. Two reasons: the side
--      effect makes a recorder responsible for guessing a recipient it does not own, and a fact
--      that silently enqueues work is the shape that made the shipped chain's delivery loop
--      impossible to reason about from the recorder alone.
--   4. FAILURE CAN BE TERMINAL. Upstream always sets a next attempt: a document that can never
--      be delivered is retried forever, and nothing in the schema can say "stop". Here the
--      failure verb takes `p_terminal`, and a terminal failure lands in `abandoned`, which the
--      claim predicate never offers again. This is the one arm of the arc the cross-bundle
--      harness cannot compare, because upstream has no counterpart for it at all.
--   5. EVERY ATTEMPT IS A ROW, AND REPLAY IS THEREFORE A COUNT. Upstream proves replay by
--      returning a `replayed` boolean derived from a ledger lookup. The boolean is kept, but the
--      thing that is TRUE is the attempt ledger: one delivered attempt row per delivery, ever, so
--      a replay that wrote a second one would be visible without believing a flag.
--   6. NO `SECURITY DEFINER`, NO `GRANT`/`REVOKE`, NO ROW-LEVEL SECURITY, matching every forward
--      this catalogue carries. This kernel creates no roles and the functions below are not a
--      security boundary; the host application is what authenticates. `SET search_path` stays,
--      because that one is a correctness property. Every constraint is named, and `CREATE` is
--      unconditional, because a manifest-ordered forward runs once against a known prefix and
--      `IF NOT EXISTS` would hide the drift the migration ledger exists to catch.
--
-- WHY THE TWO ADDED CHECKS ARE `NOT VALID`. The four columns are added to a relation this
-- catalogue created empty in an earlier forward and which no application writes, so validating
-- the constraints would scan nothing, prove nothing, and take a lock for the privilege. They are
-- enforced for every row written from here on, which is every row there will ever be.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no submission protocol, endpoint, credential, poller or schedule, and no inbound event
--     relation. Who talked to the authority, and how, is the host application's problem;
--   * no transport, no address book, no rendering, no attachment and no content of any kind.
--     `recipient_reference` and `receipt_reference` are opaque labels this kernel stores,
--     compares for equality, and never parses;
--   * no market, no document kind, no authority name, no tax treatment;
--   * no runtime binding. Not one line of the application is rewired onto these relations by
--     this forward; the falsifier is its own cross-bundle parity harness.

ALTER TABLE public.accounting_documents
  ADD COLUMN submission_required boolean NOT NULL DEFAULT false,
  ADD COLUMN submission_state text,
  ADD COLUMN submission_reference text,
  ADD COLUMN submission_updated_at timestamptz;

ALTER TABLE public.accounting_documents
  ADD CONSTRAINT accounting_documents_submission_state_check CHECK (
    submission_state IS NULL OR submission_state IN (
      'not_submitted', 'pending', 'accepted', 'rejected', 'not_required'
    )
  ) NOT VALID;

ALTER TABLE public.accounting_documents
  ADD CONSTRAINT accounting_documents_submission_reference_nonempty_check CHECK (
    submission_reference IS NULL OR btrim(submission_reference) <> ''
  ) NOT VALID;

COMMENT ON COLUMN public.accounting_documents.submission_required IS
  'Whether this document must be registered with an authority before it may be delivered. The rule, never the market.';
COMMENT ON COLUMN public.accounting_documents.submission_reference IS
  'Opaque handle the authority answered with. Never parsed here, and required before an acceptance is recorded.';

-- One outstanding obligation to put this document in front of one recipient over one channel.
-- The lease and the attempt counter are the devices the shared notification queue uses, because
-- they are the devices that make a crashed consumer recoverable.
CREATE TABLE public.accounting_document_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.accounting_documents(id) ON DELETE CASCADE,
  channel text NOT NULL,
  recipient_reference text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  receipt_reference text,
  delivered_at timestamptz,
  last_error jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_document_deliveries_document_channel_key UNIQUE (document_id, channel),
  CONSTRAINT accounting_document_deliveries_channel_nonempty_check CHECK (btrim(channel) <> ''),
  CONSTRAINT accounting_document_deliveries_recipient_nonempty_check
    CHECK (btrim(recipient_reference) <> ''),
  CONSTRAINT accounting_document_deliveries_attempts_check CHECK (attempts >= 0),
  -- Departure 4: `abandoned` is the state upstream cannot express.
  CONSTRAINT accounting_document_deliveries_status_check CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'abandoned'
  )),
  CONSTRAINT accounting_document_deliveries_receipt_nonempty_check
    CHECK (receipt_reference IS NULL OR btrim(receipt_reference) <> ''),
  -- A delivery that says it succeeded and cannot say what it holds as evidence is not a
  -- delivery. The pair is the whole point of the relation.
  CONSTRAINT accounting_document_deliveries_receipt_pairs_with_success_check CHECK (
    (status = 'succeeded') = (receipt_reference IS NOT NULL AND delivered_at IS NOT NULL)
  )
);

CREATE INDEX idx_accounting_document_deliveries_claimable
  ON public.accounting_document_deliveries (status, available_at);

-- Departure 5. One row per attempt that reached an outcome, so replay is a count rather than a
-- flag, and so a delivery that failed four times before it landed still says so afterwards.
CREATE TABLE public.accounting_document_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES public.accounting_document_deliveries(id) ON DELETE CASCADE,
  attempt_ordinal integer NOT NULL,
  outcome text NOT NULL,
  receipt_reference text,
  error jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_document_delivery_attempts_ordinal_key
    UNIQUE (delivery_id, attempt_ordinal),
  CONSTRAINT accounting_document_delivery_attempts_ordinal_check CHECK (attempt_ordinal > 0),
  CONSTRAINT accounting_document_delivery_attempts_outcome_check CHECK (outcome IN (
    'delivered', 'failed', 'abandoned'
  )),
  CONSTRAINT accounting_document_delivery_attempts_receipt_check CHECK (
    (outcome = 'delivered') = (receipt_reference IS NOT NULL)
  )
);

COMMENT ON TABLE public.accounting_document_deliveries IS
  'One outstanding obligation to hand one document to one recipient over one channel.';
COMMENT ON TABLE public.accounting_document_delivery_attempts IS
  'One row per attempt that reached an outcome. The ledger replay is counted against.';

-- Record what the authority answered. Departure 2: the state set is closed, and an acceptance
-- must carry the reference the authority answered with.
CREATE FUNCTION public.accounting_document_record_submission(
  p_document_id uuid,
  p_state text,
  p_reference text DEFAULT NULL,
  p_recorded_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_document public.accounting_documents%ROWTYPE;
BEGIN
  IF p_state IS NULL OR p_state NOT IN (
    'not_submitted', 'pending', 'accepted', 'rejected', 'not_required'
  ) THEN
    RAISE EXCEPTION 'accounting_document_submission_state_invalid' USING ERRCODE = '22023',
      DETAIL = format('state %L is not one this ledger names', p_state);
  END IF;

  IF p_state = 'accepted' AND btrim(COALESCE(p_reference, '')) = '' THEN
    RAISE EXCEPTION 'accounting_document_submission_acceptance_unreferenced' USING ERRCODE = '22023',
      DETAIL = 'an acceptance is a fact about the outside world and must carry its reference';
  END IF;

  UPDATE public.accounting_documents
     SET submission_state = p_state,
         submission_reference = COALESCE(NULLIF(btrim(COALESCE(p_reference, '')), ''), submission_reference),
         submission_updated_at = p_recorded_at,
         -- The one document transition an authority's answer is allowed to make, and only from
         -- the state that was waiting for it.
         status = CASE
           WHEN p_state = 'accepted' AND status = 'issued' THEN 'accepted'
           ELSE status
         END,
         updated_at = p_recorded_at
   WHERE id = p_document_id
  RETURNING * INTO v_document;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_submission_document_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'documentId', v_document.id,
    'status', v_document.status,
    'submissionState', v_document.submission_state
  );
END;
$$;

-- Ask for this document to be handed to a recipient. Departure 3: the request is explicit, and
-- asking twice is the same request.
CREATE FUNCTION public.accounting_document_delivery_request(
  p_document_id uuid,
  p_channel text,
  p_recipient_reference text,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_document public.accounting_documents%ROWTYPE;
  v_delivery public.accounting_document_deliveries%ROWTYPE;
  v_created boolean := false;
BEGIN
  IF btrim(COALESCE(p_channel, '')) = '' OR btrim(COALESCE(p_recipient_reference, '')) = '' THEN
    RAISE EXCEPTION 'accounting_document_delivery_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_document FROM public.accounting_documents WHERE id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_delivery_document_not_found' USING ERRCODE = '22023';
  END IF;

  -- A document nobody issued has nothing to hand over. This is the refusal upstream expresses
  -- by simply never selecting the row, which is a silence rather than an answer.
  IF v_document.status NOT IN ('issued', 'accepted', 'corrected')
     OR v_document.provider_reference IS NULL THEN
    RAISE EXCEPTION 'accounting_document_delivery_document_not_issued' USING ERRCODE = '22023',
      DETAIL = format('document %s is %L', v_document.id, v_document.status);
  END IF;

  INSERT INTO public.accounting_document_deliveries (
    document_id, channel, recipient_reference, available_at, created_at, updated_at
  )
  VALUES (
    p_document_id, btrim(p_channel), btrim(p_recipient_reference),
    p_requested_at, p_requested_at, p_requested_at
  )
  ON CONFLICT ON CONSTRAINT accounting_document_deliveries_document_channel_key DO NOTHING
  RETURNING * INTO v_delivery;
  v_created := FOUND;

  IF NOT v_created THEN
    SELECT * INTO v_delivery
      FROM public.accounting_document_deliveries
     WHERE document_id = p_document_id AND channel = btrim(p_channel);
  END IF;

  RETURN jsonb_build_object(
    'deliveryId', v_delivery.id,
    'status', v_delivery.status,
    'replayed', NOT v_created
  );
END;
$$;

-- The gate, and departure 1. A document that must be registered is not offered until it was
-- registered -- unless the deployment says its market has no such authority.
CREATE FUNCTION public.accounting_document_delivery_claim(
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 300,
  p_require_submission_acceptance boolean DEFAULT true,
  p_document_id uuid DEFAULT NULL,
  p_claimed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  WITH candidates AS (
    SELECT delivery.id
      FROM public.accounting_document_deliveries delivery
      JOIN public.accounting_documents document ON document.id = delivery.document_id
     WHERE document.status IN ('issued', 'accepted', 'corrected')
       AND document.provider_reference IS NOT NULL
       AND (p_document_id IS NULL OR document.id = p_document_id)
       AND (
         p_require_submission_acceptance IS NOT TRUE
         OR document.submission_required IS NOT TRUE
         OR document.submission_state = 'accepted'
       )
       AND (
         delivery.status = 'pending'
         OR (delivery.status = 'failed' AND delivery.available_at <= p_claimed_at)
         OR (delivery.status = 'processing' AND delivery.lease_until <= p_claimed_at)
       )
     ORDER BY delivery.created_at, delivery.id
     LIMIT greatest(least(COALESCE(p_limit, 25), 100), 1)
     FOR UPDATE OF delivery SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.accounting_document_deliveries delivery
       SET status = 'processing',
           attempts = delivery.attempts + 1,
           lease_until = p_claimed_at + make_interval(secs => greatest(COALESCE(p_lease_seconds, 300), 60)),
           last_error = '{}'::jsonb,
           updated_at = p_claimed_at
      FROM candidates
     WHERE delivery.id = candidates.id
     RETURNING delivery.*
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'deliveryId', claimed.id,
    'documentId', claimed.document_id,
    'channel', claimed.channel,
    'recipientReference', claimed.recipient_reference,
    'attemptCount', claimed.attempts
  ) ORDER BY claimed.created_at, claimed.id), '[]'::jsonb)
    INTO v_rows
    FROM claimed;

  RETURN v_rows;
END;
$$;

-- The receipt. Attempt-fenced, replay-aware by ledger lookup, and refusing a second, different
-- answer to the same command.
CREATE FUNCTION public.accounting_document_delivery_settle(
  p_delivery_id uuid,
  p_attempt_count integer,
  p_receipt_reference text,
  p_settled_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_delivery public.accounting_document_deliveries%ROWTYPE;
  v_receipt text := btrim(COALESCE(p_receipt_reference, ''));
BEGIN
  IF p_delivery_id IS NULL OR COALESCE(p_attempt_count, 0) < 1 OR v_receipt = '' THEN
    RAISE EXCEPTION 'accounting_document_delivery_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_delivery
    FROM public.accounting_document_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_delivery_not_found' USING ERRCODE = '22023';
  END IF;

  -- Replay first, and out of the ledger rather than out of the attempt counter: the caller that
  -- lost our answer is asking the same question again, not making a stale claim.
  IF v_delivery.status = 'succeeded' THEN
    IF v_delivery.receipt_reference IS DISTINCT FROM v_receipt THEN
      RAISE EXCEPTION 'accounting_document_delivery_receipt_conflict' USING ERRCODE = '22023',
        DETAIL = format('delivery %s already holds a different receipt', v_delivery.id);
    END IF;
    RETURN jsonb_build_object('deliveryId', v_delivery.id, 'status', v_delivery.status, 'replayed', true);
  END IF;

  IF v_delivery.status = 'abandoned' THEN
    RAISE EXCEPTION 'accounting_document_delivery_terminal' USING ERRCODE = '22023';
  END IF;

  IF v_delivery.status <> 'processing' OR v_delivery.attempts <> p_attempt_count THEN
    RAISE EXCEPTION 'accounting_document_delivery_stale_attempt' USING ERRCODE = '40001',
      DETAIL = format('delivery %s is %L at attempt %s', v_delivery.id, v_delivery.status, v_delivery.attempts);
  END IF;

  UPDATE public.accounting_document_deliveries
     SET status = 'succeeded',
         receipt_reference = v_receipt,
         delivered_at = p_settled_at,
         lease_until = NULL,
         last_error = '{}'::jsonb,
         updated_at = p_settled_at
   WHERE id = v_delivery.id;

  INSERT INTO public.accounting_document_delivery_attempts (
    delivery_id, attempt_ordinal, outcome, receipt_reference, occurred_at
  ) VALUES (v_delivery.id, p_attempt_count, 'delivered', v_receipt, p_settled_at);

  RETURN jsonb_build_object('deliveryId', v_delivery.id, 'status', 'succeeded', 'replayed', false);
END;
$$;

-- The other outcome, with departure 4: a failure may be the last one.
CREATE FUNCTION public.accounting_document_delivery_fail(
  p_delivery_id uuid,
  p_attempt_count integer,
  p_error jsonb DEFAULT '{}'::jsonb,
  p_retry_seconds integer DEFAULT 900,
  p_terminal boolean DEFAULT false,
  p_failed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_delivery public.accounting_document_deliveries%ROWTYPE;
  v_status text;
BEGIN
  IF p_delivery_id IS NULL OR COALESCE(p_attempt_count, 0) < 1 THEN
    RAISE EXCEPTION 'accounting_document_delivery_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_delivery
    FROM public.accounting_document_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_delivery_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_delivery.status IN ('succeeded', 'abandoned') THEN
    RAISE EXCEPTION 'accounting_document_delivery_terminal' USING ERRCODE = '22023';
  END IF;

  IF v_delivery.status <> 'processing' OR v_delivery.attempts <> p_attempt_count THEN
    RAISE EXCEPTION 'accounting_document_delivery_stale_attempt' USING ERRCODE = '40001';
  END IF;

  v_status := CASE WHEN p_terminal IS TRUE THEN 'abandoned' ELSE 'failed' END;

  UPDATE public.accounting_document_deliveries
     SET status = v_status,
         lease_until = NULL,
         available_at = CASE
           WHEN v_status = 'failed'
             THEN p_failed_at + make_interval(secs => greatest(COALESCE(p_retry_seconds, 900), 60))
           ELSE available_at
         END,
         last_error = COALESCE(p_error, '{}'::jsonb),
         updated_at = p_failed_at
   WHERE id = v_delivery.id;

  INSERT INTO public.accounting_document_delivery_attempts (
    delivery_id, attempt_ordinal, outcome, error, occurred_at
  ) VALUES (
    v_delivery.id, p_attempt_count,
    CASE WHEN v_status = 'abandoned' THEN 'abandoned' ELSE 'failed' END,
    COALESCE(p_error, '{}'::jsonb), p_failed_at
  );

  RETURN jsonb_build_object('deliveryId', v_delivery.id, 'status', v_status, 'replayed', false);
END;
$$;
