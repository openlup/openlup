-- Public platform shipment rail: the two integration archetypes as executable rows, the port
-- registry, the shipment machine with its nine-value lifecycle, the external-reference ledger,
-- the routing decision that chooses between archetypes or fails closed, and the fourth emitter --
-- the one that turns a machine-raised shipment exception into a notification.
--
-- WHAT THIS FORWARD SHIPS. The second bundle already has reads, a queue, a customer-requested
-- mutation and an operator mutation. This gives it the part of a shop that moves a physical thing:
-- a paid order becomes a shipment, the shipment walks a durable lifecycle, and WHICH walk is legal
-- depends on the archetype of the integration it was opened against. Two archetypes, and the
-- difference between them is the whole point of the slice:
--   * a CARRIER port -- a direct integration with a courier company. It makes its own label, so it
--     walks packed -> label_pending -> label_created -> handed_over, and evidence about the parcel
--     arrives because we ASK for it (a poll);
--   * a FULFILMENT-HOUSE port -- an integration with a house through which both packing and
--     shipping run, the latter via various couriers. It makes no label of ours at all, so it walks
--     packed -> handed_over directly, and evidence ARRIVES on its own (a push).
-- Operationally the carrier is the fallback of the two, and that fallback is PLATFORM semantics:
-- the routing function below chooses, and the named integrations stay in the overlay.
--
-- THE ARCHETYPE TABLE IS A PROJECTION, NOT AN INVENTION. Every cell of the four seeded rows comes
-- from a declaration the managed runtime already carries. The five operation columns are its
-- operation-support matrix verbatim. `owns_label_creation` and `owns_delivered_notice` are
-- PROJECTED from its per-integration capability profiles up to the archetype, which is legal only
-- because those two facts agree within each role today -- said out loud, because if a future
-- profile broke that agreement this table is the first thing that has to be argued with. The two
-- evidence-channel columns are the structural asymmetry measured for this slice: one poll job on
-- the carrier side against five push receivers on the fulfilment-house side.
--
-- WHY THE FOURTH EMITTER LANDS HERE, AND HOW IT DEPARTS. The order rail authorises it in one
-- sentence: "a capability that owns a notification owns its own enqueue". A shipment exception is
-- a fulfilment notification and this forward is the fulfilment capability, so the trigger belongs
-- here and not on the table's owning slice. The managed emitter early-returns unless the hold's
-- metadata source equals one literal string that names an integration by brand; that string is a
-- token this kernel may not write, and metadata is caller-supplied and therefore forgeable. The
-- neutral gate is the platform-observable fact instead: a hold raised for a fulfilment exception
-- whose creator is NULL -- the control the upstream auto-heal migration itself calls the
-- non-forgeable one -- suppressed once the order's shipment is already out of our hands.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer the boundary:
--   * no inventory reservation relation and no reservation consumption. Upstream, creating a
--     fulfilment order REFUSES unless every line carries a sufficient reservation -- a precondition
--     of creation, not a consequence of a transition. This kernel authors no order line and no
--     catalogue, so its create reads the order row and the port registry and nothing else. That
--     asymmetry is a measured finding of this wave, and the harness reports it rather than hiding
--     it;
--   * no reconciliation shape and no stock oracle. Both carry live operational defects upstream;
--   * no command ledger for an integration. Upstream it is structurally incapable of expressing a
--     cancel, by design, and its own design note says do not implement;
--   * no label bytes, no tracking transport, no webhook receiver and no signature scheme. THE
--     KERNEL OWNS THE ARCHETYPE'S EVIDENCE CONTRACT; IT NEVER OWNS AN HTTP RECEIVER. Recording that
--     evidence arrived, on a channel the archetype accepts, is the whole of what is portable;
--   * no status LABEL. The durable lifecycle is the CHECK below and nothing else. The customer-facing
--     status map is one authored file upstream with one generated projection, and this forward
--     writes zero lines in either;
--   * no closed set of integration keys. A port is registered under an OPAQUE key and carries an
--     archetype; which named integrations exist is a fact about a deployment, not about a platform;
--   * no `SECURITY DEFINER`, no `GRANT`/`REVOKE`, no row-level security. This kernel creates zero
--     roles. Said out loud rather than assumed: ON THIS KERNEL THE FUNCTIONS BELOW ARE NOT A
--     SECURITY BOUNDARY. `p_actor_id` and `p_port_key` are arguments supplied by a trusted caller;
--     the host application is what authenticates. `SET search_path` is kept, because that one is a
--     real injection-hardening property that does not depend on a role model.
--
-- AUTHORED, NOT COPIED. Written for this migration against the composed observable behaviour of the
-- managed shipment functions read end to end -- create, label recorded, handed over, tracking event,
-- exception recorded, cancel -- plus the two relations they move and the emitter they fire. Named
-- departures, in full: the names lose their historical prefix so one family token classifies every
-- refusal; the lifecycle CHECK is NAMED where the upstream one is an inline unnamed column
-- constraint, because this kernel's convention is that every constraint has a name; the archetype
-- is DENORMALISED onto the shipment, because a registry edit must not retroactively change which
-- transition a shipment may take; the external-reference ledger is keyed on the SHIPMENT and names
-- a reference by its ROLE, where the upstream table is keyed on the order and carries a column
-- whose values name integrations by brand; that ledger is APPEND-ONLY and the machine reads the
-- most recent row per role, where upstream keeps history by flipping an `active` flag -- same
-- property, no mutable column, and no privilege question at all on a kernel with no roles; there is
-- ONE idempotency ledger and its fingerprint is compared field by field rather than hashed; the
-- label stage is ARCHETYPE-GATED, which moves the one derived boolean that already discriminates
-- the two archetypes upstream into an executable refusal; the cancel refusal reads the shipment's
-- OWN dispatch reference instead of an integration's dispatch table, and is a local state change
-- with no round trip, because a bidirectional cancel is blocked upstream by design; the routing
-- selection is read from the order row's own metadata, exactly as the upstream router's reader
-- does, and the fourth outcome -- a selection that cannot be read is RETRYABLE and never a
-- fallback -- is reachable through a declared marker because a well-formed input cannot express a
-- failed read; the emitted payload carries identity and instant and nothing else; and `CREATE` is
-- unconditional, because a manifest-ordered forward runs exactly once against a known prefix and
-- `IF NOT EXISTS` there would hide the drift the migration ledger exists to catch.
--
-- This forward ALTERS nothing. Every relation below is new, so the two rules the order rail met at
-- review -- a constraint added to a populated table needs `NOT VALID`, and a foreign key added to
-- one needs a name -- have no statement here to apply to.

-- The archetype, as rows. Four of them, and the machine below branches on the columns rather than
-- on the key: a port is a carrier because its archetype owns label creation, not because of its
-- name. The two boolean groups answer different questions -- which operation slots an adapter of
-- this archetype fills, and which way evidence travels -- and the harness falsifies each of them on
-- the archetype that does not have it.
CREATE TABLE public.fulfillment_provider_archetypes (
  provider_type text PRIMARY KEY,
  supports_build_outbound boolean NOT NULL,
  supports_dispatch boolean NOT NULL,
  supports_reconcile boolean NOT NULL,
  supports_parse_webhook boolean NOT NULL,
  supports_sync_stock boolean NOT NULL,
  owns_label_creation boolean NOT NULL,
  owns_delivered_notice boolean NOT NULL,
  accepts_poll_evidence boolean NOT NULL,
  accepts_push_evidence boolean NOT NULL,
  CONSTRAINT fulfillment_provider_archetypes_provider_type_check CHECK (
    provider_type IN ('3pl', 'direct-carrier', 'manual', 'simulator')
  )
);

INSERT INTO public.fulfillment_provider_archetypes (
  provider_type, supports_build_outbound, supports_dispatch, supports_reconcile,
  supports_parse_webhook, supports_sync_stock, owns_label_creation, owns_delivered_notice,
  accepts_poll_evidence, accepts_push_evidence
) VALUES
  ('3pl',            true,  true,  true,  true,  true,  false, true,  true,  true),
  ('direct-carrier', true,  true,  false, false, false, true,  false, true,  false),
  ('simulator',      false, true,  false, false, false, true,  false, true,  false),
  ('manual',         false, false, false, false, false, false, false, false, false);

-- The registry. `port_key` is opaque on purpose: the kernel never learns which integration a key
-- names, only which archetype it behaves like. `fail_closed` is the one policy bit the routing
-- decision needs, and an unroutable port must SAY why -- a port that is off without a reason
-- produces a refusal nobody can act on.
CREATE TABLE public.fulfillment_ports (
  port_key text PRIMARY KEY,
  provider_type text NOT NULL REFERENCES public.fulfillment_provider_archetypes(provider_type),
  routable boolean NOT NULL DEFAULT true,
  fail_closed boolean NOT NULL DEFAULT false,
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_ports_port_key_nonempty_check CHECK (btrim(port_key) <> ''),
  CONSTRAINT fulfillment_ports_unavailable_reason_check CHECK (
    routable OR (unavailable_reason IS NOT NULL AND btrim(unavailable_reason) <> '')
  )
);

-- The machine. `provider_type` is copied from the port at creation and never re-read: a shipment's
-- archetype is a fact about the shipment, and a machine that re-read it would answer the same
-- transition differently after an unrelated registry edit.
CREATE TABLE public.fulfillment_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  port_key text NOT NULL REFERENCES public.fulfillment_ports(port_key) ON DELETE RESTRICT,
  provider_type text NOT NULL REFERENCES public.fulfillment_provider_archetypes(provider_type),
  status text NOT NULL DEFAULT 'created',
  create_idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  packed_at timestamptz,
  handed_over_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_shipments_status_check CHECK (status IN (
    'created', 'packed', 'label_pending', 'label_created', 'handed_over',
    'in_transit', 'delivered', 'exception', 'cancelled'
  )),
  CONSTRAINT fulfillment_shipments_create_idempotency_key_key UNIQUE (create_idempotency_key),
  CONSTRAINT fulfillment_shipments_order_id_key UNIQUE (order_id)
);

CREATE INDEX idx_fulfillment_shipments_order
  ON public.fulfillment_shipments (order_id, created_at DESC);

-- The neutral external-reference ledger. Upstream this is keyed on the order and carries a column
-- whose values name integrations; here the shipment already carries the archetype, so the only
-- thing left to say about a reference is what ROLE it plays. Append-only: nothing below updates or
-- deletes a row here, and a newer reference for one role supersedes an older one by recency rather
-- than by flipping a flag, which keeps the audit history the upstream flag exists to keep.
CREATE TABLE public.shipment_external_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id) ON DELETE CASCADE,
  ref_role text NOT NULL,
  external_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_external_refs_ref_role_check CHECK (
    ref_role IN ('dispatch', 'tracking', 'label')
  ),
  CONSTRAINT shipment_external_refs_external_id_nonempty_check CHECK (btrim(external_id) <> ''),
  CONSTRAINT shipment_external_refs_shipment_role_id_key UNIQUE (shipment_id, ref_role, external_id)
);

CREATE INDEX idx_shipment_external_refs_shipment
  ON public.shipment_external_refs (shipment_id, ref_role, recorded_at DESC);

-- The audit ledger AND the idempotency ledger, in one table -- the device the order rail settled
-- on, inherited unchanged. A second generic key table would bring back the defect it has upstream:
-- its request fingerprint hashes the actor, so for a machine actor deduplication silently stops.
CREATE TABLE public.fulfillment_shipment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid REFERENCES public.fulfillment_shipments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  source text NOT NULL DEFAULT 'platform.fulfillment.v1',
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_shipment_operations_operation_type_check CHECK (operation_type IN (
    'shipment_created', 'shipment_advanced', 'evidence_recorded',
    'shipment_cancelled', 'shipment_exception_raised', 'order_routed'
  )),
  CONSTRAINT fulfillment_shipment_operations_idempotency_key_nonempty_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT fulfillment_shipment_operations_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_fulfillment_shipment_operations_order
  ON public.fulfillment_shipment_operations (order_id, occurred_at DESC);

-- One response shape for every entry point, so an applied transition and a replayed one are
-- answered by the same builder and cannot drift apart.
CREATE FUNCTION public.fulfillment_shipment_response(
  p_shipment public.fulfillment_shipments,
  p_outcome text,
  p_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'contractVersion', 'platform.fulfillment.shipment.v1',
    'shipment', CASE WHEN p_shipment.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', p_shipment.id, 'orderId', p_shipment.order_id, 'status', p_shipment.status,
      'providerType', p_shipment.provider_type) END,
    'outcome', p_outcome,
    'replayed', p_replayed);
$$;

-- The opener the two entry points share. It is deliberately NOT an entry point of its own: both
-- callers below have already decided that they may open a shipment, and the only thing that could
-- still refuse here is the port.
CREATE FUNCTION public.fulfillment_open_shipment(
  p_idempotency_key text,
  p_order_id uuid,
  p_port_key text,
  p_metadata jsonb,
  p_requested_at timestamptz
)
RETURNS public.fulfillment_shipments
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_port public.fulfillment_ports%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
BEGIN
  SELECT * INTO v_port FROM public.fulfillment_ports WHERE port_key = p_port_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_port_not_registered' USING ERRCODE = '22023';
  END IF;
  IF NOT v_port.routable THEN
    RAISE EXCEPTION 'fulfillment_port_not_routable' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.fulfillment_shipments
    (order_id, port_key, provider_type, create_idempotency_key, metadata, created_at, updated_at)
  VALUES (p_order_id, v_port.port_key, v_port.provider_type, p_idempotency_key,
          COALESCE(p_metadata, '{}'::jsonb), p_requested_at, p_requested_at)
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_shipment.id, p_order_id, 'shipment_created', p_idempotency_key || ':operation',
          jsonb_build_object('portKey', v_port.port_key, 'providerType', v_port.provider_type),
          p_requested_at);

  RETURN v_shipment;
END;
$$;

-- Open a shipment for an order somebody has paid for.
--
-- Upstream the equivalent refuses unless four other capabilities have already written: a succeeded
-- payment intent, a shipping address, catalogue-resolvable order lines, and a sufficient inventory
-- reservation per line. Three of those are relations this kernel does not author and the fourth is
-- a capability this slice was told to leave alone; on this kernel the order row IS the record that
-- the money moved, so `status IN ('paid','fulfillment_pending')` is the whole of the gate. If a
-- payment or inventory relation is ever authored here, this function is the one that has to change
-- first, and it should change by ADDING a check rather than by moving the decision elsewhere.
CREATE FUNCTION public.fulfillment_create_shipment(
  p_idempotency_key text,
  p_order_id uuid,
  p_port_key text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL OR p_port_key IS NULL
  THEN
    RAISE EXCEPTION 'fulfillment_create_shipment_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations
   WHERE idempotency_key = p_idempotency_key || ':operation';

  IF FOUND THEN
    IF v_existing.operation_type <> 'shipment_created'
      OR v_existing.order_id IS DISTINCT FROM p_order_id
      OR v_existing.payload->>'portKey' IS DISTINCT FROM p_port_key
    THEN
      RAISE EXCEPTION 'fulfillment_create_shipment_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = v_existing.shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'created', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_create_shipment_order_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_order.status NOT IN ('paid', 'fulfillment_pending') THEN
    RAISE EXCEPTION 'fulfillment_create_shipment_order_not_fulfillable' USING ERRCODE = '22023';
  END IF;

  v_shipment := public.fulfillment_open_shipment(
    p_idempotency_key, p_order_id, p_port_key, p_metadata, p_requested_at);
  RETURN public.fulfillment_shipment_response(v_shipment, 'created', false);
END;
$$;

-- Route a paid order to an archetype, or refuse in the one way that is not a fallback.
--
-- Four outcomes, and the asymmetry between the middle two is the rule worth proving: a selection
-- that names a port which is registered, unroutable AND fail-closed does NOT silently degrade to
-- the other archetype -- it snoozes with the reason the registry names. A selection naming a port
-- this deployment simply does not have is not a policy statement, so it falls back. And a selection
-- that cannot be READ is retryable and never anything else, because a transient read failure that
-- fell back would strand the order on the wrong archetype -- the one outcome a well-formed input
-- cannot express, so it is reachable here through a marker the caller writes on purpose.
CREATE FUNCTION public.fulfillment_route_order(
  p_idempotency_key text,
  p_order_id uuid,
  p_fallback_port_key text,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_selection jsonb;
  v_selected text;
  v_port public.fulfillment_ports%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
  v_outcome text;
  v_target text;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_order_id IS NULL OR p_fallback_port_key IS NULL
  THEN
    RAISE EXCEPTION 'fulfillment_route_order_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = v_existing.shipment_id;
    RETURN public.fulfillment_shipment_response(
      v_shipment, v_existing.payload->>'outcome', true);
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_route_order_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_order.status NOT IN ('paid', 'fulfillment_pending') THEN
    RAISE EXCEPTION 'fulfillment_route_order_not_fulfillable' USING ERRCODE = '22023';
  END IF;

  v_selection := v_order.metadata->'fulfillmentSelection';
  IF v_selection->>'resolution' = 'unreadable' THEN
    -- 40001, so a caller that already retries a serialization failure retries this too.
    RAISE EXCEPTION 'fulfillment_route_order_selection_unreadable' USING ERRCODE = '40001';
  END IF;
  v_selected := v_selection->>'portKey';

  IF v_selected IS NOT NULL THEN
    SELECT * INTO v_port FROM public.fulfillment_ports WHERE port_key = v_selected;
  END IF;

  -- `v_port.port_key IS NOT NULL` rather than `FOUND`, because `FOUND` also carries the result of
  -- the order read above and would answer for a lookup that never ran.
  IF v_port.port_key IS NOT NULL AND v_port.routable THEN
    v_outcome := 'routed';
    v_target := v_port.port_key;
  ELSIF v_port.port_key IS NOT NULL AND v_port.fail_closed THEN
    INSERT INTO public.fulfillment_shipment_operations
      (order_id, operation_type, idempotency_key, payload, occurred_at)
    VALUES (p_order_id, 'order_routed', p_idempotency_key,
            jsonb_build_object('outcome', 'snoozed', 'reason', v_port.unavailable_reason),
            p_requested_at);
    RETURN jsonb_build_object('contractVersion', 'platform.fulfillment.shipment.v1',
      'shipment', NULL, 'outcome', 'snoozed', 'reason', v_port.unavailable_reason,
      'replayed', false);
  ELSE
    v_outcome := 'fallback';
    v_target := p_fallback_port_key;
  END IF;

  v_shipment := public.fulfillment_open_shipment(
    p_idempotency_key, p_order_id, v_target, jsonb_build_object('routing', v_outcome),
    p_requested_at);

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (v_shipment.id, p_order_id, 'order_routed', p_idempotency_key,
          jsonb_build_object('outcome', v_outcome, 'portKey', v_target), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, v_outcome, false);
END;
$$;

-- Move a shipment one step, and refuse the steps its archetype has not earned.
--
-- Two refusals live here and they are different in kind. `invalid_transition` is about the
-- lifecycle: no shipment goes from `created` straight to `delivered`, whatever it is wired to.
-- `archetype_forbids_transition` is about the integration model: only an archetype that makes its
-- own label may enter the label stages, and only an archetype that does NOT may hand over straight
-- from `packed`. That second refusal is the one line of derived logic the managed runtime already
-- computes for its console -- auto-dispatch AND NOT label-creation -- moved from a boolean nobody
-- can execute into a transition the machine actually refuses.
CREATE FUNCTION public.fulfillment_advance_shipment(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_to_status text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
  v_archetype public.fulfillment_provider_archetypes%ROWTYPE;
  v_legal boolean;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_shipment_id IS NULL OR p_to_status IS NULL
  THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'shipment_advanced'
      OR v_existing.shipment_id IS DISTINCT FROM p_shipment_id
      OR v_existing.payload->>'toStatus' IS DISTINCT FROM p_to_status
    THEN
      RAISE EXCEPTION 'fulfillment_advance_shipment_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'advanced', true);
  END IF;

  SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_archetype FROM public.fulfillment_provider_archetypes
   WHERE provider_type = v_shipment.provider_type;

  v_legal := (v_shipment.status, p_to_status) IN (
    ('created', 'packed'),
    ('packed', 'label_pending'),
    ('label_pending', 'label_created'),
    ('label_created', 'handed_over'),
    ('packed', 'handed_over'),
    ('handed_over', 'in_transit'),
    ('handed_over', 'delivered'),
    ('in_transit', 'delivered'));
  IF NOT v_legal THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_invalid_transition' USING ERRCODE = '22023';
  END IF;

  -- Two refusals, not one, because they are different facts and a caller has to tell them apart: a
  -- house was asked for a label it never makes, and a carrier was asked to hand over a parcel it has
  -- not labelled yet.
  IF p_to_status IN ('label_pending', 'label_created') AND NOT v_archetype.owns_label_creation THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_archetype_forbids_label' USING ERRCODE = '22023';
  END IF;
  IF v_shipment.status = 'packed' AND p_to_status = 'handed_over'
    AND v_archetype.owns_label_creation
  THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_archetype_forbids_handover' USING ERRCODE = '22023';
  END IF;

  UPDATE public.fulfillment_shipments
     SET status = p_to_status,
         updated_at = p_requested_at,
         packed_at = CASE WHEN p_to_status = 'packed' THEN p_requested_at ELSE packed_at END,
         handed_over_at = CASE WHEN p_to_status = 'handed_over' THEN p_requested_at
                               ELSE handed_over_at END,
         delivered_at = CASE WHEN p_to_status = 'delivered' THEN p_requested_at
                             ELSE delivered_at END,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE id = p_shipment_id
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_shipment_id, v_shipment.order_id, 'shipment_advanced', p_idempotency_key,
          jsonb_build_object('toStatus', p_to_status), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, 'advanced', false);
END;
$$;

-- Record that evidence about a shipment arrived, on a channel its archetype accepts.
--
-- THE BOUNDARY THIS FUNCTION DRAWS IS THE POINT OF THE WHOLE SLICE. It takes evidence that has
-- already been normalized -- a channel, a role, an identifier -- and it does not know, and must
-- never know, how that evidence got here. No signature, no payload shape, no receiver. What is
-- portable is that an archetype which only ever ASKS cannot be told, and one that is TOLD needs no
-- schedule; everything else is an adapter's problem and stays in the overlay.
CREATE FUNCTION public.fulfillment_record_evidence(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_channel text,
  p_ref_role text,
  p_external_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
  v_archetype public.fulfillment_provider_archetypes%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_shipment_id IS NULL OR p_channel IS NULL OR p_channel NOT IN ('poll', 'push')
    OR p_ref_role IS NULL OR p_ref_role NOT IN ('dispatch', 'tracking', 'label')
    OR p_external_id IS NULL OR btrim(p_external_id) = ''
  THEN
    RAISE EXCEPTION 'fulfillment_record_evidence_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'evidence_recorded'
      OR v_existing.shipment_id IS DISTINCT FROM p_shipment_id
      OR v_existing.payload->>'externalId' IS DISTINCT FROM p_external_id
    THEN
      RAISE EXCEPTION 'fulfillment_record_evidence_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'evidence_recorded', true);
  END IF;

  SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_record_evidence_shipment_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_shipment.status IN ('cancelled', 'delivered') THEN
    RAISE EXCEPTION 'fulfillment_record_evidence_shipment_closed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_archetype FROM public.fulfillment_provider_archetypes
   WHERE provider_type = v_shipment.provider_type;
  IF (p_channel = 'poll' AND NOT v_archetype.accepts_poll_evidence)
    OR (p_channel = 'push' AND NOT v_archetype.accepts_push_evidence)
  THEN
    RAISE EXCEPTION 'fulfillment_record_evidence_channel_unsupported' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.shipment_external_refs (shipment_id, ref_role, external_id, recorded_at)
  VALUES (p_shipment_id, p_ref_role, p_external_id, p_requested_at)
  ON CONFLICT ON CONSTRAINT shipment_external_refs_shipment_role_id_key DO NOTHING;

  UPDATE public.fulfillment_shipments
     SET updated_at = p_requested_at,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE id = p_shipment_id
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_shipment_id, v_shipment.order_id, 'evidence_recorded', p_idempotency_key,
          jsonb_build_object('channel', p_channel, 'refRole', p_ref_role,
                             'externalId', p_external_id), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, 'evidence_recorded', false);
END;
$$;

-- Cancel a shipment locally, and refuse while somebody else still holds it.
--
-- Upstream, an outbound cancel toward an integration is declared, implemented and called from
-- nowhere; every capability profile says it cannot cancel; the command ledger is structurally
-- unable to express one; and the design note for the missing half reads "do not implement". So the
-- portable behaviour is exactly this: a LOCAL state change, refused once somebody outside this
-- system has been committed to. Never a round trip, never a two-way sync.
--
-- What counts as committed differs by archetype, and BOTH halves are needed, which is why the
-- refusal has two arms. A carrier is committed the moment a label of ours exists -- upstream draws
-- the line there for everyone. A fulfilment house never makes a label of ours at all, so for it the
-- only evidence that somebody else is holding the parcel is the dispatch reference it handed back.
-- One arm alone would let one of the two archetypes cancel a parcel already in somebody's van.
CREATE FUNCTION public.fulfillment_cancel_shipment(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_shipment_id IS NULL OR p_reason IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'shipment_cancelled'
      OR v_existing.shipment_id IS DISTINCT FROM p_shipment_id
      OR v_existing.payload->>'reason' IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'fulfillment_cancel_shipment_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'cancelled', true);
  END IF;

  SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_shipment.status = 'cancelled' THEN
    RETURN public.fulfillment_shipment_response(v_shipment, 'cancelled', true);
  END IF;
  IF v_shipment.status IN ('label_created', 'handed_over', 'in_transit', 'delivered') THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_invalid_status' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_external_refs
     WHERE shipment_id = p_shipment_id AND ref_role = 'dispatch'
  ) THEN
    RAISE EXCEPTION 'fulfillment_cancel_shipment_dispatch_outstanding' USING ERRCODE = '22023';
  END IF;

  UPDATE public.fulfillment_shipments
     SET status = 'cancelled',
         cancelled_at = p_requested_at,
         updated_at = p_requested_at,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
                    || jsonb_build_object('cancellationReason', p_reason)
   WHERE id = p_shipment_id
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_shipment_id, v_shipment.order_id, 'shipment_cancelled', p_idempotency_key,
          jsonb_build_object('reason', p_reason), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, 'cancelled', false);
END;
$$;

-- Raise a shipment exception, and put the order on the hold the order rail authored.
--
-- The hold is created with a NULL creator on purpose: that is what marks it as raised by a machine,
-- it is the single field the one-way automatic release is allowed to key on, and it is the barrier
-- the emitter below reads. The order rail already encoded the release half of that asymmetry; this
-- function is the creating half, and it does not re-author any of it.
CREATE FUNCTION public.fulfillment_raise_shipment_exception(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.fulfillment_shipment_operations%ROWTYPE;
  v_shipment public.fulfillment_shipments%ROWTYPE;
  v_hold_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 8
    OR p_shipment_id IS NULL OR p_reason IS NULL OR btrim(p_reason) = ''
  THEN
    RAISE EXCEPTION 'fulfillment_raise_shipment_exception_invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.fulfillment_shipment_operations WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.operation_type <> 'shipment_exception_raised'
      OR v_existing.shipment_id IS DISTINCT FROM p_shipment_id
    THEN
      RAISE EXCEPTION 'fulfillment_raise_shipment_exception_idempotency_conflict'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id;
    RETURN public.fulfillment_shipment_response(v_shipment, 'exception_raised', true);
  END IF;

  SELECT * INTO v_shipment FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_raise_shipment_exception_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_shipment.status IN ('cancelled', 'delivered') THEN
    RAISE EXCEPTION 'fulfillment_raise_shipment_exception_shipment_closed' USING ERRCODE = '22023';
  END IF;

  -- The hold goes in BEFORE the shipment moves to `exception`, and the order matters: the emitter
  -- decides whether to say anything by reading where the parcel had got to, and a shipment already
  -- rewritten to `exception` would have lost the answer to that question.
  INSERT INTO public.commerce_order_holds
    (order_id, reason, note, created_by, idempotency_key, metadata, created_at, updated_at)
  VALUES (v_shipment.order_id, 'fulfillment_exception', p_reason, NULL,
          p_idempotency_key || ':hold',
          jsonb_build_object('shipmentId', v_shipment.id, 'reason', p_reason),
          p_requested_at, p_requested_at)
  ON CONFLICT (order_id, reason) WHERE status = 'active' DO NOTHING
  RETURNING id INTO v_hold_id;

  UPDATE public.fulfillment_shipments
     SET status = 'exception',
         updated_at = p_requested_at,
         metadata = metadata || COALESCE(p_metadata, '{}'::jsonb)
                    || jsonb_build_object('exceptionReason', p_reason)
   WHERE id = p_shipment_id
  RETURNING * INTO v_shipment;

  INSERT INTO public.fulfillment_shipment_operations
    (shipment_id, order_id, operation_type, idempotency_key, payload, occurred_at)
  VALUES (p_shipment_id, v_shipment.order_id, 'shipment_exception_raised', p_idempotency_key,
          jsonb_build_object('reason', p_reason, 'holdId', v_hold_id), p_requested_at);

  RETURN public.fulfillment_shipment_response(v_shipment, 'exception_raised', false);
END;
$$;

-- The fourth emitter. A machine-raised fulfilment hold is a notification this capability owns.
--
-- The gate is the platform-observable fact and nothing else. Upstream the same emitter refuses
-- unless the hold's metadata carries one particular source string; that string names an integration
-- by brand, which this kernel may not write, and metadata is caller-supplied, which makes it the
-- wrong field to trust for a decision this consequential. The trigger's WHEN clause carries the
-- non-forgeable half -- a hold nobody claims to have created, raised for a fulfilment exception --
-- and the body carries the second gate the upstream emitter also has: say nothing once the parcel
-- is already out of our hands, because a customer whose parcel is in transit does not need to hear
-- that a system had a problem behind it.
CREATE FUNCTION public.fulfillment_emit_shipment_exception_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shipments
     WHERE order_id = NEW.order_id
       AND status IN ('handed_over', 'in_transit', 'delivered')
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.outbox_events
    (aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata)
  VALUES ('commerce_order', NEW.order_id, 'commerce.shipment.exception',
          'shipment_exception:' || NEW.id::text,
          jsonb_build_object('orderUuid', NEW.order_id, 'holdUuid', NEW.id,
                             'occurredAt', NEW.created_at),
          jsonb_build_object('source', 'fulfillment_emit_shipment_exception_notification'))
  ON CONFLICT (event_type, idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_fulfillment_emit_shipment_exception
  AFTER INSERT ON public.commerce_order_holds
  FOR EACH ROW
  WHEN (NEW.reason = 'fulfillment_exception' AND NEW.created_by IS NULL AND NEW.status = 'active')
  EXECUTE FUNCTION public.fulfillment_emit_shipment_exception_notification();
