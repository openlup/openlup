-- Public platform accounting rail: the neutral document machine. Four relations, one
-- arithmetic invariant, the lifecycle a document walks, correction by reversal, a private
-- request queue, the fifth emitter, and the two ledger delegations the shipped accounting
-- runtime already calls.
--
-- WHAT THIS FORWARD SHIPS, AND WHAT IT REFUSES TO KNOW. The second bundle can already say
-- that an order was paid, cancelled or refunded, that a parcel was handed over, and that a
-- scheduled job holds a lease. What it has never had is a way to say "a document is owed for
-- this order, these are its positions, and here is what happened to it". That is the whole of
-- this forward. It is deliberately NOT an accounting system: there is no ledger of accounts,
-- no tax engine, no numbering, and no notion of who the buyer is. Fiscal numbering, storage,
-- tax rules and general-ledger competence stay in whatever document provider a deployment
-- configures -- a boundary the domain that owns this capability already states in prose, and
-- which this forward is the first executable statement of.
--
-- THE KERNEL OWNS THE DOCUMENT, NOT THE MONEY, AND THAT IS THE LOAD-BEARING DECISION.
-- The managed chain derives a document's positions from an order-item relation inside a
-- BEFORE-write trigger that reads six money columns, a shipping pair and a tax rate, and
-- refuses on eight distinct arithmetic mismatches. This kernel has none of those columns: the
-- order rail gave it the WHEN of money -- paid, cancelled, refunded -- and none of the HOW
-- MUCH. Authoring them here would be a commerce surface written inside an accounting slice,
-- so the request below takes the positions and the declared total AS ARGUMENTS, and the only
-- thing this kernel enforces about money is the one invariant the product already declares:
-- the positions must equal the charged total. That invariant is integer arithmetic. It is
-- currency-agnostic, tax-rate-agnostic (rates are basis points this kernel stores and never
-- interprets), and it names no country.
--
-- MINOR UNITS, NOT CENTS. `cents` is the subdivision of two particular currencies. Amounts
-- here are `*_minor`, which is also the vocabulary the shipped application types already use.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE THIS KERNEL TAKES FROM THEM. The behaviour
-- below was derived from the managed chain by measuring it live -- the request from a paid
-- order, its replay, the refusal of an unpaid order, the refusal of positions that miss the
-- declared total by one minor unit, the three correction refusals and the correction itself --
-- inside one transaction that was rolled back. Nine departures, each named, because a silent
-- one is how a kernel and its origin quietly stop being the same machine:
--
--   1. SEVEN LIFECYCLE VALUES, NOT TEN. The chain's document CHECK carries ten today; it
--      carried seven when the ledger was authored, and the three it grew since are the three
--      this kernel may not own: one is a verdict about the validity of a national tax
--      identifier, and two are states of a submission to a national tax authority. A
--      deployment that has neither still needs every one of the seven below.
--   2. THE INVARIANT IS A DEFERRED CONSTRAINT TRIGGER, NOT AN ARGUMENT CHECK. A check inside
--      the request function would be satisfied once and then bypassed by any later write to
--      the position ledger. The constraint fires at the end of the transaction that touched
--      either side, so a document and its positions can only ever be committed in agreement.
--   3. A CORRECTION IS A NEW DOCUMENT, NEVER A MUTATION. Upstream a correction flips a status
--      on the original row and records a reason. Here the correction is a second document
--      that references the original through a self-referencing key, carrying the original's
--      positions negated, so the same invariant holds over it by construction and the
--      original's own fiscal facts are never rewritten. One correction per document, as a
--      partial unique index rather than a procedural check, because two concurrent callers
--      cannot both pass a read and then both insert.
--   4. THE LIFECYCLE IS A NAMED TRANSITION ALLOWLIST -- the device the shipment rail settled
--      on -- so an illegal move is one refusal with one name instead of a condition per verb.
--   5. THE QUEUE IS THIS CAPABILITY'S OWN. The standing rule of these rails is that a
--      capability which owns a notification owns its own enqueue; the corollary is that it
--      does not put its work items in another capability's queue. Upstream says the same
--      thing out loud about its own delivery queue, and that property is preserved here.
--   6. THE DOCUMENT REFERENCE IS DERIVED, NOT COUNTED. There is no sequence and no counter in
--      this forward, on purpose. A gapless fiscal number is a legal obligation discharged by
--      the configured provider; what this kernel needs is a stable local handle, so it builds
--      one from the order it belongs to. Uniqueness is a constraint, not a lock.
--   7. THE TWO `_v3` LEDGER VERBS ARE THIN DELEGATIONS onto the bodies the job-run forward
--      already shipped, and they exist because the accounting runtime is the only consumer in
--      the application that calls them -- so on this bundle every accounting job fails at
--      claim until they exist. They need no new column: the job-run forward's own header
--      records that a concrete adapter label survives losslessly in caller-supplied metadata,
--      and that is exactly where the invocation source is folded. Two behavioural departures
--      come with them, and both are real: upstream REFUSES a job whose control row was not
--      configured in advance, because that row carries an array of permitted trigger kinds
--      this kernel does not have, whereas here the claim creates the row it needs on first
--      contact; and upstream answers `trigger_kind_not_allowed` where this kernel answers
--      `inactive_driver`, which is the same refusal expressed in the vocabulary each side
--      actually has.
--   8. NO `SECURITY DEFINER`, NO `GRANT`/`REVOKE`, NO ROW-LEVEL SECURITY, matching every
--      forward this catalogue carries -- upstream every function below is `SECURITY DEFINER`.
--      This kernel creates zero roles. Said out loud rather than assumed: ON THIS KERNEL THE
--      FUNCTIONS BELOW ARE NOT A SECURITY BOUNDARY. The host application is what
--      authenticates, and a caller that can reach these functions can already reach the
--      tables. `SET search_path` is kept, because that one is a correctness property and not
--      a role property. Every constraint is named rather than left to a generated identifier,
--      and `CREATE` is unconditional, because a manifest-ordered forward runs exactly once
--      against a known prefix and `IF NOT EXISTS` there would hide the drift the migration
--      ledger exists to catch.
--   9. THE FIFTH EMITTER FIRES ON ANOTHER SLICE'S TABLE, DELIBERATELY. Hand-over is the
--      moment a document becomes owed, so the notification belongs to this capability even
--      though the row that changes belongs to the shipment rail -- exactly as that rail emits
--      from the hold table the order rail owns. The rule is about who owns the NOTIFICATION.
--      Upstream agrees: its version of this emitter lives in a migration named for the
--      handoff-to-document duty, not in the shipment migration.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no order money. No currency, no order totals, no item relation, no tax rate on an
--     order. The request is given a snapshot and checks its arithmetic;
--   * no buyer. No name, no address, no tax identifier, no consumer-versus-business kind.
--     Who a document is addressed to is a composition input, and none of it is platform data;
--   * no provider, no transport and no submission protocol. A document may carry ONE opaque
--     provider reference, written once, and this kernel never parses it;
--   * no numbering, no sequence, no counter;
--   * no runtime binding. Not one line of the application is rewired onto these relations by
--     this forward; the falsifier is its own cross-bundle parity harness;
--   * no consumer for the emitted notification. The row lands in the queue the outbox forward
--     authored and is drained by its claim/ack protocol, unchanged.

CREATE TABLE public.accounting_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  document_ref text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  correction_status text NOT NULL DEFAULT 'none',
  correction_of_document_id uuid REFERENCES public.accounting_documents(id) ON DELETE RESTRICT,
  total_gross_minor bigint NOT NULL,
  provider_reference text,
  requested_at timestamptz,
  issued_at timestamptz,
  accepted_at timestamptz,
  corrected_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_documents_document_ref_key UNIQUE (document_ref),
  CONSTRAINT accounting_documents_document_ref_nonempty_check CHECK (btrim(document_ref) <> ''),
  -- The seven values a document walks. Departure 1 explains the three upstream has and this
  -- kernel does not.
  CONSTRAINT accounting_documents_status_check CHECK (status IN (
    'draft', 'issue_requested', 'issued', 'accepted', 'correction_requested', 'corrected', 'voided'
  )),
  CONSTRAINT accounting_documents_correction_status_check CHECK (correction_status IN (
    'none', 'required', 'requested', 'issued', 'accepted'
  )),
  CONSTRAINT accounting_documents_correction_self_check
    CHECK (correction_of_document_id IS DISTINCT FROM id),
  -- A correction reverses; a base document does not. The sign is the only thing that has to
  -- be true of the two totals without reading the positions.
  CONSTRAINT accounting_documents_correction_sign_check CHECK (
    (correction_of_document_id IS NULL AND total_gross_minor >= 0)
    OR (correction_of_document_id IS NOT NULL AND total_gross_minor <= 0)
  ),
  CONSTRAINT accounting_documents_provider_reference_nonempty_check
    CHECK (provider_reference IS NULL OR btrim(provider_reference) <> '')
);

-- One base document per order, and one correction per document. Both are partial unique
-- indexes rather than procedural checks, for the reason departure 3 gives.
CREATE UNIQUE INDEX idx_accounting_documents_one_base_per_order
  ON public.accounting_documents (order_id)
  WHERE correction_of_document_id IS NULL;

CREATE UNIQUE INDEX idx_accounting_documents_one_correction
  ON public.accounting_documents (correction_of_document_id)
  WHERE correction_of_document_id IS NOT NULL;

CREATE INDEX idx_accounting_documents_status
  ON public.accounting_documents (status, created_at DESC);

-- What the document says it is for. `description` is caller-supplied text this kernel stores
-- and never parses; `tax_rate_bps` is a basis-point rate it stores and never applies. There is
-- deliberately no per-line arithmetic constraint tying the total to unit times quantity: a
-- discount allocated to a line makes that identity false in every real order, and a constraint
-- that is false in the normal case is a constraint callers learn to route around.
CREATE TABLE public.accounting_document_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.accounting_documents(id) ON DELETE CASCADE,
  position_ordinal integer NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL,
  unit_gross_minor bigint NOT NULL,
  total_gross_minor bigint NOT NULL,
  tax_rate_bps integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_document_positions_ordinal_check CHECK (position_ordinal > 0),
  CONSTRAINT accounting_document_positions_quantity_check CHECK (quantity > 0),
  CONSTRAINT accounting_document_positions_tax_rate_bps_check
    CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 100000),
  CONSTRAINT accounting_document_positions_description_nonempty_check CHECK (btrim(description) <> ''),
  CONSTRAINT accounting_document_positions_document_ordinal_key UNIQUE (document_id, position_ordinal)
);

CREATE INDEX idx_accounting_document_positions_document
  ON public.accounting_document_positions (document_id, position_ordinal);

-- This capability's own work queue, per departure 5. A row is one outstanding obligation
-- towards whatever document provider a deployment configured; the visibility lease and the
-- claim token are the same devices the shared notification queue uses, because they are the
-- devices that make a crashed consumer recoverable.
CREATE TABLE public.accounting_document_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.accounting_documents(id) ON DELETE CASCADE,
  request_kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_document_requests_request_kind_check
    CHECK (request_kind IN ('issue', 'correction')),
  CONSTRAINT accounting_document_requests_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'discarded')),
  CONSTRAINT accounting_document_requests_attempts_check CHECK (attempts >= 0),
  CONSTRAINT accounting_document_requests_document_kind_key UNIQUE (document_id, request_kind)
);

CREATE INDEX idx_accounting_document_requests_claimable
  ON public.accounting_document_requests (status, available_at);

-- The audit ledger AND the idempotency ledger, in one table -- the device the order rail
-- settled on and the shipment rail inherited. A second generic key table would bring back the
-- defect it has upstream: its request fingerprint hashes the actor, so for a machine actor
-- deduplication silently stops.
CREATE TABLE public.accounting_document_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.accounting_documents(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  source text NOT NULL DEFAULT 'platform.accounting.v1',
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_document_operations_operation_type_check CHECK (operation_type IN (
    'document_requested', 'document_advanced', 'correction_requested'
  )),
  CONSTRAINT accounting_document_operations_idempotency_key_nonempty_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT accounting_document_operations_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_accounting_document_operations_order
  ON public.accounting_document_operations (order_id, occurred_at DESC);

COMMENT ON TABLE public.accounting_documents IS
  'One row per document owed for an order, plus one row per correction of such a document.';
COMMENT ON COLUMN public.accounting_documents.provider_reference IS
  'Opaque handle returned by whatever document provider a deployment configured. Never parsed here.';
COMMENT ON COLUMN public.accounting_document_positions.tax_rate_bps IS
  'Basis-point rate carried with the position. This kernel stores it and never applies it.';

-- THE INVARIANT. Positions must equal the charged total, in minor units, exactly.
--
-- It is a deferred constraint trigger on BOTH sides of the relationship for the reason
-- departure 2 gives: a check that only ran when the document was written would be satisfied
-- once and then bypassed by the next write to the position ledger. Deferring it to the end of
-- the transaction is what lets a document and its positions be created by one call and still
-- be checked as a pair; nothing can commit them in disagreement.
CREATE FUNCTION public.accounting_document_assert_position_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_document_id uuid;
  v_declared bigint;
  v_positions integer;
  v_sum bigint;
BEGIN
  -- Written as branching statements rather than one CASE expression on purpose: the procedural
  -- language compiles an expression into a single SQL query, so every record field named in any arm
  -- must exist on every row type the trigger can see, and the two row types here differ.
  IF TG_TABLE_NAME = 'accounting_documents' THEN
    v_document_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_document_id := OLD.document_id;
  ELSE
    v_document_id := NEW.document_id;
  END IF;

  SELECT total_gross_minor INTO v_declared
    FROM public.accounting_documents
   WHERE id = v_document_id;
  -- The document is gone: a cascade took it, and there is nothing left to be consistent with.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer, COALESCE(sum(total_gross_minor), 0)
    INTO v_positions, v_sum
    FROM public.accounting_document_positions
   WHERE document_id = v_document_id;

  IF v_positions = 0 THEN
    RAISE EXCEPTION 'accounting_document_positions_required' USING ERRCODE = '23514',
      DETAIL = format('document %s carries no position', v_document_id);
  END IF;

  IF v_sum IS DISTINCT FROM v_declared THEN
    RAISE EXCEPTION 'accounting_document_position_sum_mismatch' USING ERRCODE = '23514',
      DETAIL = format('document %s declares %s and its positions sum to %s',
                      v_document_id, v_declared, v_sum);
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_accounting_documents_position_sum
  AFTER INSERT OR UPDATE ON public.accounting_documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.accounting_document_assert_position_sum();

CREATE CONSTRAINT TRIGGER trg_accounting_document_positions_sum
  AFTER INSERT OR UPDATE OR DELETE ON public.accounting_document_positions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.accounting_document_assert_position_sum();

-- One response shape for every entry point, so an applied call and a replayed one are answered
-- by the same builder and cannot drift apart. The document reference is deliberately absent:
-- it is derived from the order, and a caller that has the order has it.
CREATE FUNCTION public.accounting_document_response(
  p_document public.accounting_documents,
  p_outcome text,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'platform.accounting.document.v1',
    'outcome', p_outcome,
    'replayed', p_replayed,
    'document', jsonb_build_object(
      'id', p_document.id,
      'orderId', p_document.order_id,
      'status', p_document.status,
      'correctionStatus', p_document.correction_status,
      'correctionOfDocumentId', p_document.correction_of_document_id,
      'totalGrossMinor', p_document.total_gross_minor));
$$;

-- Turn a caller-supplied position array into rows. Written once, because the request and the
-- correction both need it and two copies of an argument shape drift.
CREATE FUNCTION public.accounting_document_write_positions(
  p_document_id uuid,
  p_positions jsonb
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_written integer;
BEGIN
  IF p_positions IS NULL OR jsonb_typeof(p_positions) <> 'array' OR jsonb_array_length(p_positions) = 0 THEN
    RAISE EXCEPTION 'accounting_document_positions_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.accounting_document_positions (
    document_id, position_ordinal, description, quantity,
    unit_gross_minor, total_gross_minor, tax_rate_bps, metadata
  )
  SELECT
    p_document_id,
    entry.ordinality::integer,
    COALESCE(NULLIF(btrim(entry.value->>'description'), ''), 'position ' || entry.ordinality::text),
    COALESCE((entry.value->>'quantity')::integer, 1),
    COALESCE((entry.value->>'unitGrossMinor')::bigint, (entry.value->>'totalGrossMinor')::bigint),
    (entry.value->>'totalGrossMinor')::bigint,
    COALESCE((entry.value->>'taxRateBps')::integer, 0),
    COALESCE(entry.value->'metadata', '{}'::jsonb)
    FROM jsonb_array_elements(p_positions) WITH ORDINALITY AS entry(value, ordinality);

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END;
$$;

-- A document is owed once an order is paid, and the paid instant is the whole of the gate.
-- Nothing else about the order is read: not its total, not its currency, not its lines, not
-- who placed it -- because this kernel stores none of those and an invoice about money it
-- cannot see would be a document about nothing. The caller supplies the snapshot; the
-- invariant checks it.
CREATE FUNCTION public.accounting_document_request_from_paid_order(
  p_idempotency_key text,
  p_order_id uuid,
  p_positions jsonb,
  p_total_gross_minor bigint,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order public.commerce_orders%ROWTYPE;
  v_document public.accounting_documents%ROWTYPE;
  v_document_ref text;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
     OR p_order_id IS NULL OR p_total_gross_minor IS NULL THEN
    RAISE EXCEPTION 'accounting_document_request_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_request_order_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_order.paid_at IS NULL THEN
    RAISE EXCEPTION 'accounting_document_request_order_not_paid' USING ERRCODE = '22023';
  END IF;

  -- Derived, never counted. Departure 6.
  v_document_ref := 'order:' || p_order_id::text || ':base';

  INSERT INTO public.accounting_documents (
    order_id, document_ref, status, total_gross_minor, requested_at, metadata
  )
  VALUES (
    p_order_id, v_document_ref, 'issue_requested', p_total_gross_minor, p_requested_at,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('requestIdempotencyKey', p_idempotency_key)
  )
  ON CONFLICT ON CONSTRAINT accounting_documents_document_ref_key DO NOTHING
  RETURNING * INTO v_document;

  IF v_document.id IS NULL THEN
    -- Idempotency is a constraint, not a timestamp comparison: the second caller reads the row
    -- the first one wrote and is told so.
    SELECT * INTO v_document FROM public.accounting_documents WHERE document_ref = v_document_ref;
    RETURN public.accounting_document_response(v_document, 'requested', true);
  END IF;

  PERFORM public.accounting_document_write_positions(v_document.id, p_positions);

  INSERT INTO public.accounting_document_requests (document_id, request_kind, available_at)
  VALUES (v_document.id, 'issue', p_requested_at);

  INSERT INTO public.accounting_document_operations
    (document_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_document.id, p_order_id, 'document_requested', p_idempotency_key,
          jsonb_build_object('totalGrossMinor', p_total_gross_minor), p_requested_at);

  RETURN public.accounting_document_response(v_document, 'requested', false);
END;
$$;

-- The lifecycle, as one allowlist. Every legal move is a row in the list below and every other
-- move is one refusal with one name. A provider reference may be written exactly once and may
-- never be rewritten afterwards, because it is the only thing on this row that a second system
-- also believes.
CREATE FUNCTION public.accounting_document_advance(
  p_idempotency_key text,
  p_document_id uuid,
  p_to_status text,
  p_provider_reference text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_document public.accounting_documents%ROWTYPE;
  v_allowed boolean;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'accounting_document_advance_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_document FROM public.accounting_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_advance_document_not_found' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.accounting_document_operations
              WHERE idempotency_key = p_idempotency_key)
     OR v_document.status = p_to_status THEN
    RETURN public.accounting_document_response(v_document, 'advanced', true);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM (VALUES
      ('draft', 'issue_requested'),
      ('draft', 'voided'),
      ('issue_requested', 'issued'),
      ('issue_requested', 'voided'),
      ('issued', 'accepted'),
      ('issued', 'correction_requested'),
      ('accepted', 'correction_requested'),
      ('correction_requested', 'corrected')
    ) AS move(from_status, to_status)
     WHERE move.from_status = v_document.status AND move.to_status = p_to_status
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'accounting_document_advance_invalid_transition' USING ERRCODE = '22023',
      DETAIL = format('document %s is %s and cannot become %s',
                      p_document_id, v_document.status, p_to_status);
  END IF;

  IF p_provider_reference IS NOT NULL
     AND v_document.provider_reference IS NOT NULL
     AND v_document.provider_reference IS DISTINCT FROM p_provider_reference THEN
    RAISE EXCEPTION 'accounting_document_provider_reference_immutable' USING ERRCODE = '22023';
  END IF;

  UPDATE public.accounting_documents
     SET status = p_to_status,
         correction_status = CASE
           WHEN p_to_status = 'correction_requested' THEN 'requested'
           WHEN p_to_status = 'corrected' THEN 'issued'
           ELSE correction_status
         END,
         provider_reference = COALESCE(p_provider_reference, provider_reference),
         issued_at = CASE WHEN p_to_status = 'issued' THEN p_requested_at ELSE issued_at END,
         accepted_at = CASE WHEN p_to_status = 'accepted' THEN p_requested_at ELSE accepted_at END,
         corrected_at = CASE WHEN p_to_status = 'corrected' THEN p_requested_at ELSE corrected_at END,
         voided_at = CASE WHEN p_to_status = 'voided' THEN p_requested_at ELSE voided_at END,
         updated_at = p_requested_at,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE id = p_document_id
   RETURNING * INTO v_document;

  INSERT INTO public.accounting_document_operations
    (document_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_document_id, v_document.order_id, 'document_advanced', p_idempotency_key,
          jsonb_build_object('toStatus', p_to_status), p_requested_at);

  RETURN public.accounting_document_response(v_document, 'advanced', false);
END;
$$;

-- Correction by reversal. The original is never rewritten: a second document is created that
-- points at it and carries its positions negated, so the two together sum to what the customer
-- is actually owed and the invariant holds over each of them separately.
CREATE FUNCTION public.accounting_document_request_correction(
  p_idempotency_key text,
  p_document_id uuid,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_original public.accounting_documents%ROWTYPE;
  v_correction public.accounting_documents%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'accounting_document_correction_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_original FROM public.accounting_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_correction_document_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_original.correction_of_document_id IS NOT NULL THEN
    RAISE EXCEPTION 'accounting_document_correction_of_a_correction_forbidden' USING ERRCODE = '22023';
  END IF;

  -- A document nobody has issued yet is withdrawn, not corrected. Refusing here is what keeps
  -- `voided` and `corrected` from becoming two names for the same thing.
  IF v_original.status NOT IN ('issued', 'accepted') THEN
    RAISE EXCEPTION 'accounting_document_correction_status_invalid' USING ERRCODE = '22023',
      DETAIL = format('document %s is %s', p_document_id, v_original.status);
  END IF;

  SELECT * INTO v_correction
    FROM public.accounting_documents
   WHERE correction_of_document_id = p_document_id;
  IF FOUND THEN
    RETURN public.accounting_document_response(v_correction, 'correction_requested', true);
  END IF;

  INSERT INTO public.accounting_documents (
    order_id, document_ref, status, correction_of_document_id,
    total_gross_minor, requested_at, metadata
  )
  VALUES (
    v_original.order_id, v_original.document_ref || ':correction', 'draft', p_document_id,
    -v_original.total_gross_minor, p_requested_at,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('correctionReason', p_reason)
  )
  RETURNING * INTO v_correction;

  INSERT INTO public.accounting_document_positions (
    document_id, position_ordinal, description, quantity,
    unit_gross_minor, total_gross_minor, tax_rate_bps, metadata
  )
  SELECT v_correction.id, position_ordinal, description, quantity,
         -unit_gross_minor, -total_gross_minor, tax_rate_bps, metadata
    FROM public.accounting_document_positions
   WHERE document_id = p_document_id;

  UPDATE public.accounting_documents
     SET status = 'correction_requested',
         correction_status = 'requested',
         updated_at = p_requested_at
   WHERE id = p_document_id;

  INSERT INTO public.accounting_document_requests (document_id, request_kind, available_at)
  VALUES (v_correction.id, 'correction', p_requested_at);

  INSERT INTO public.accounting_document_operations
    (document_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_correction.id, v_original.order_id, 'correction_requested', p_idempotency_key,
          jsonb_build_object('correctsDocumentId', p_document_id, 'reason', p_reason), p_requested_at);

  RETURN public.accounting_document_response(v_correction, 'correction_requested', false);
END;
$$;

-- The order rail's cancelled and refunded instants, turned into the correction they imply. The
-- gate is the platform-observable fact and nothing else: an order that was reversed, and a
-- document that exists for it.
CREATE FUNCTION public.accounting_document_request_reversal_from_order(
  p_idempotency_key text,
  p_order_id uuid,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order public.commerce_orders%ROWTYPE;
  v_document_id uuid;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_reversal_order_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_order.cancelled_at IS NULL AND v_order.refunded_at IS NULL THEN
    RAISE EXCEPTION 'accounting_document_reversal_order_not_reversed' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_document_id
    FROM public.accounting_documents
   WHERE order_id = p_order_id AND correction_of_document_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting_document_reversal_document_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN public.accounting_document_request_correction(
    p_idempotency_key, v_document_id, p_reason,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'reversalCause', CASE WHEN v_order.refunded_at IS NOT NULL THEN 'refunded' ELSE 'cancelled' END),
    p_requested_at);
END;
$$;

-- Claim a batch of outstanding obligations. An empty allowlist is refused rather than widened,
-- for the reason the notification queue gives: a caller that forgot its filter must not drain
-- every kind of work on the instance. The claim token written onto the row is the
-- authorization for every later acknowledgement, so knowing the row id is not enough.
CREATE FUNCTION public.accounting_document_queue_claim(
  p_request_kinds text[],
  p_batch_size integer DEFAULT 10,
  p_visibility_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 8
)
RETURNS SETOF public.accounting_document_requests
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch_size, 10), 1), 100);
  v_visibility integer := LEAST(GREATEST(COALESCE(p_visibility_seconds, 300), 30), 3600);
  v_max integer := LEAST(GREATEST(COALESCE(p_max_attempts, 8), 1), 20);
BEGIN
  IF p_request_kinds IS NULL OR cardinality(p_request_kinds) = 0 THEN
    RAISE EXCEPTION 'accounting_document_queue_allowlist_required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT request.id
      FROM public.accounting_document_requests request
     WHERE request.request_kind = ANY (p_request_kinds)
       AND request.status IN ('pending', 'processing', 'failed')
       AND request.available_at <= now()
       AND request.attempts < v_max
     ORDER BY request.created_at, request.id
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.accounting_document_requests request
     SET status = 'processing',
         attempts = request.attempts + 1,
         available_at = now() + make_interval(secs => v_visibility),
         claim_token = gen_random_uuid(),
         updated_at = now()
    FROM candidates
   WHERE request.id = candidates.id
  RETURNING request.*;
END;
$$;

-- Acknowledge success. Returns false rather than raising when the row is no longer the
-- caller's: a lease that expired and was re-claimed elsewhere is an ordinary race.
CREATE FUNCTION public.accounting_document_queue_succeed(
  p_request_id uuid,
  p_claim_token uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  WITH settled AS (
    UPDATE public.accounting_document_requests
       SET status = 'succeeded',
           error = NULL,
           claim_token = NULL,
           updated_at = now(),
           metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
     WHERE id = p_request_id
       AND status = 'processing'
       AND claim_token = p_claim_token
     RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM settled);
$$;

-- Acknowledge failure. The outcome the caller asks for is a request, not a verdict: a retry on
-- a row that has already spent its attempts becomes a discard, so the ceiling is enforced in
-- one place instead of in every caller.
CREATE FUNCTION public.accounting_document_queue_fail(
  p_request_id uuid,
  p_claim_token uuid,
  p_error text,
  p_outcome text DEFAULT 'retry',
  p_base_delay_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 8
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.accounting_document_requests%ROWTYPE;
  v_base integer := LEAST(GREATEST(COALESCE(p_base_delay_seconds, 60), 5), 3600);
  v_max integer := LEAST(GREATEST(COALESCE(p_max_attempts, 8), 1), 20);
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('retry', 'discard') THEN
    RAISE EXCEPTION 'accounting_document_queue_invalid_outcome' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.accounting_document_requests
   WHERE id = p_request_id AND status = 'processing' AND claim_token = p_claim_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missed';
  END IF;

  IF p_outcome = 'discard' OR v_row.attempts >= v_max THEN
    UPDATE public.accounting_document_requests
       SET status = 'discarded', error = left(p_error, 2000), claim_token = NULL, updated_at = now()
     WHERE id = v_row.id;
    RETURN 'discarded';
  END IF;

  UPDATE public.accounting_document_requests
     SET status = 'failed',
         error = left(p_error, 2000),
         claim_token = NULL,
         available_at = now() + make_interval(
           secs => v_base * power(2, LEAST(GREATEST(v_row.attempts - 1, 0), 8))),
         updated_at = now()
   WHERE id = v_row.id;
  RETURN 'failed';
END;
$$;

-- THE FIFTH EMITTER, and departure 9 says why it lives here. A parcel leaving our hands is the
-- moment a document becomes owed, so the notification is this capability's even though the row
-- belongs to the shipment rail.
--
-- The barrier lives in the trigger's WHEN clause rather than in an early RETURN inside the
-- body: a condition the planner evaluates before the function is entered cannot be reached by
-- a statement that did not change what it claims to have changed. The emitter is idempotent on
-- (event type, key) as well, so a replayed hand-over cannot double-notify.
CREATE FUNCTION public.accounting_emit_fulfillment_handed_over_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.order_id, 'commerce.fulfillment.handed_over',
          'fulfillment_handed_over:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.order_id, 'shipmentUuid', NEW.id,
                             'occurredAt', NEW.handed_over_at),
          jsonb_build_object('source', 'accounting_emit_fulfillment_handed_over_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_accounting_emit_fulfillment_handed_over
  AFTER UPDATE OF status ON public.fulfillment_shipments
  FOR EACH ROW
  WHEN (NEW.status = 'handed_over' AND OLD.status IS DISTINCT FROM 'handed_over'
        AND NEW.handed_over_at IS NOT NULL)
  EXECUTE FUNCTION public.accounting_emit_fulfillment_handed_over_notification();

-- The two ledger delegations of departure 7. They are the reason a self-hosting adopter's
-- accounting jobs can run at all: the shipped runtime calls these two names and nothing in
-- this catalogue defined them.
--
-- The validation below is the caller's contract and is reproduced from upstream argument for
-- argument, including the length ceiling on the invocation source. What is NOT reproduced is
-- the refusal of an unconfigured control row, because the array of permitted trigger kinds it
-- reads does not exist here; the claim this delegates to creates the row it needs and adopts
-- the runner that created it, and that difference is proved rather than asserted.
CREATE FUNCTION public.platform_claim_job_run_v3(
  p_job_name text,
  p_trigger_kind text,
  p_invocation_source text,
  p_lease_seconds integer DEFAULT 900,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  acquired boolean,
  run_id uuid,
  reason text,
  lease_until timestamptz
)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_trigger_kind text := COALESCE(NULLIF(btrim(p_trigger_kind), ''), '');
  v_invocation_source text := COALESCE(NULLIF(btrim(p_invocation_source), ''), '');
BEGIN
  IF p_job_name IS NULL OR btrim(p_job_name) = '' THEN
    RAISE EXCEPTION 'platform_job_name_required' USING ERRCODE = '22023';
  END IF;

  IF v_trigger_kind NOT IN ('worker', 'scheduler', 'operator') THEN
    RAISE EXCEPTION 'platform_job_invalid_trigger_kind' USING ERRCODE = '22023';
  END IF;

  IF v_invocation_source = '' OR length(v_invocation_source) > 128 THEN
    RAISE EXCEPTION 'platform_job_invocation_source_required' USING ERRCODE = '22023';
  END IF;

  -- The invocation source is evidence, never an authorization control, so it is folded into
  -- the metadata this ledger stores and never interprets.
  RETURN QUERY
  SELECT claimed.acquired, claimed.run_id, claimed.reason, claimed.lease_until
    FROM public.platform_claim_job_run(
      p_job_name,
      v_trigger_kind,
      p_lease_seconds,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'triggerKind', v_trigger_kind, 'invocationSource', v_invocation_source)
    ) AS claimed;
END;
$$;

-- The finish has nothing to add to the shipped body: the fence is the lease token either way,
-- and a delegation that re-implemented it would be a second copy of the one predicate that
-- must never differ.
CREATE FUNCTION public.platform_finish_job_run_v3(
  p_job_name text,
  p_run_id uuid,
  p_status text,
  p_checked integer DEFAULT NULL,
  p_updated integer DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_support_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  SELECT public.platform_finish_job_run_v2(
    p_job_name, p_run_id, p_status, p_checked, p_updated, p_error, p_support_code, p_metadata);
$$;
