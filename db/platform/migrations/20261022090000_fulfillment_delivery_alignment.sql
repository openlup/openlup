-- D13 native translation of the effective managed delivery-alignment rail.
-- New invoker objects only; default off, deployment owner execution, no browser grants.
-- Existing history, payment lifecycle and managed graph remain unchanged.
-- Donor activation cycle 1 ↔ native activation ordinal 0;
-- donor renewal n+1 ↔ native renewal n (renewal operation numbers remain >= 1).
-- Activation requires no renewal operation and its active activation-order link.
-- Other unnumbered cycles remain unordered: paid ones refuse due admission for
-- manual review; any other unordered cycle prevents automatic arrival alignment.
-- D13 native translation note: only NEW cycle admission/INSERT is guarded.
-- Existing-cycle renewal/dunning retries bypass admission and one-use receipts.
-- confirm_replacement remains a note-only operator attestation. Never invoke it
-- for a replacement that did not arrive. No automatic caller is installed.
-- Roll back compatible code or turn new cases off; repair accepted effects forward.

CREATE TABLE public.subscription_delivery_alignment_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'off'
    CHECK (mode IN ('off', 'shadow', 'protect', 'auto_align')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.subscription_delivery_alignment_control (singleton, mode)
VALUES (true, 'off')
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE public.subscription_delivery_alignment_control IS
  'Singleton DB-side rollout control for new delivery-alignment cases. Default off. Existing protected cases retain their captured authority after this row changes.';

CREATE TABLE public.subscription_delivery_alignment_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid REFERENCES public.fulfillment_shipments(id) ON DELETE CASCADE,
  predecessor_order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  predecessor_cycle_id uuid NOT NULL REFERENCES public.subscription_cycles(id) ON DELETE CASCADE,
  predecessor_cycle_number integer CHECK (predecessor_cycle_number >= 0),
  captured_mode text NOT NULL CHECK (captured_mode IN ('shadow', 'protect', 'auto_align')),
  state text NOT NULL CHECK (state IN ('shadow', 'protected', 'aligned', 'released', 'manual_review')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('fulfillment_exception', 'overdue_renewal', 'missing_fulfillment')),
  observed_next_cycle_at timestamptz,
  delivered_at timestamptz,
  aligned_next_cycle_at timestamptz,
  manual_review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  aligned_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (state = 'manual_review' AND manual_review_reason IS NOT NULL)
    OR state <> 'manual_review'
  ),
  CHECK (
    (state = 'aligned' AND aligned_next_cycle_at IS NOT NULL AND aligned_at IS NOT NULL)
    OR state <> 'aligned'
  )
);

-- An allowed renewal needs a durable, one-time proof that the same schedule
-- passed admission in an enforcing mode. A rejected INSERT cannot retain a new
-- protected case (the transaction rolls it back), so this receipt is the safe
-- DB boundary for callers that otherwise bypass the service preflight.
CREATE TABLE public.subscription_delivery_alignment_admission_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  observed_next_cycle_at timestamptz NOT NULL,
  decision text NOT NULL DEFAULT 'allowed' CHECK (decision = 'allowed'),
  source text NOT NULL CHECK (source = 'renewal_admission'),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (subscription_id, scheduled_at),
  CHECK (consumed_at IS NULL OR consumed_at >= admitted_at)
);



-- The ordinary shape is exactly one case per fulfillment order. The nullable
-- fallback is intentionally only for the fail-closed "paid but no fulfillment
-- row exists" corruption/manual-review case; it is unique per predecessor order
-- and can never stand in for two physical fulfillment records.
CREATE UNIQUE INDEX subscription_delivery_alignment_case_fulfillment_key
  ON public.subscription_delivery_alignment_cases (shipment_id)
  WHERE shipment_id IS NOT NULL;
CREATE UNIQUE INDEX subscription_delivery_alignment_case_missing_fulfillment_key
  ON public.subscription_delivery_alignment_cases (predecessor_order_id)
  WHERE shipment_id IS NULL;
CREATE INDEX idx_subscription_delivery_alignment_cases_blocking
  ON public.subscription_delivery_alignment_cases (subscription_id, state, predecessor_cycle_number)
  WHERE state IN ('protected', 'manual_review');
CREATE INDEX idx_subscription_delivery_alignment_cases_order
  ON public.subscription_delivery_alignment_cases (predecessor_order_id, shipment_id);

COMMENT ON TABLE public.subscription_delivery_alignment_cases IS
  'Durable delivery-alignment ledger. Customer mapping exposes only protected and aligned. shadow, released and manual_review remain operator/server facts.';
COMMENT ON COLUMN public.subscription_delivery_alignment_cases.delivered_at IS
  'Trusted durable fulfillment chronology copied only from fulfillment_shipments.delivered_at; status text or outbox occurredAt never qualifies.';
COMMENT ON TABLE public.subscription_delivery_alignment_admission_receipts IS
  'One-time, schedule-bound authorization consumed by a protecting-mode payment_pending cycle insert. Created only by a successful due renewal admission.';

CREATE VIEW public.subscription_delivery_alignment_cycles AS
SELECT cycle.*,
  CASE
    WHEN operation.cycle_number >= 1 THEN operation.cycle_number
    WHEN cycle.renewal_operation_id IS NULL AND EXISTS (
      SELECT 1 FROM public.subscription_activations activation
       WHERE activation.state = 'active'
         AND activation.subscription_id = cycle.subscription_id
         AND activation.order_id = order_row.id
    ) THEN 0
    ELSE NULL
  END AS cycle_number,
  order_row.id AS order_id
FROM public.subscription_cycles cycle
LEFT JOIN public.subscription_renewal_operations operation ON operation.id = cycle.renewal_operation_id
LEFT JOIN public.commerce_orders order_row ON order_row.subscription_cycle_id = cycle.id;
CREATE FUNCTION public.subscription_delivery_alignment_get_mode()
RETURNS text
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT mode
    FROM public.subscription_delivery_alignment_control
   WHERE singleton = true
$$;

-- Enforcing modes (protect, auto_align) require the host renewal path to call
-- subscription_delivery_alignment_admit_renewal before inserting a cycle.
-- The native renewal store does not yet call it: switching to an enforcing mode
-- halts every autonomous renewal with subscription_delivery_alignment_admission_required.
-- Native installs must keep mode off until that wiring lands. Before switching,
-- check for paid cycles without an activation or renewal link: enforcing modes
-- hold every due renewal on such subscriptions for manual review.
CREATE FUNCTION public.subscription_delivery_alignment_set_mode(
  p_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'shadow', 'protect', 'auto_align') THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_invalid_mode' USING ERRCODE = '22023';
  END IF;

  UPDATE public.subscription_delivery_alignment_control
     SET mode = p_mode,
         updated_at = now()
   WHERE singleton = true;

  RETURN jsonb_build_object('mode', p_mode, 'updatedAt', now());
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_record_allowed_receipt(
  p_subscription_id uuid,
  p_scheduled_at timestamptz,
  p_observed_next_cycle_at timestamptz,
  p_source text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_subscription_id IS NULL
     OR p_scheduled_at IS NULL
     OR p_observed_next_cycle_at IS NULL
     OR p_source <> 'renewal_admission'
  THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_invalid_receipt' USING ERRCODE = '22023';
  END IF;

  -- A subscription can hold at most one future admission token. The caller
  -- already owns the subscription lock, so clearing an obsolete unconsumed
  -- schedule cannot race a valid creator and bounds replay/stale buildup.
  DELETE FROM public.subscription_delivery_alignment_admission_receipts
   WHERE subscription_id = p_subscription_id
     AND consumed_at IS NULL
     AND scheduled_at <> p_scheduled_at;

  INSERT INTO public.subscription_delivery_alignment_admission_receipts (
    subscription_id, scheduled_at, observed_next_cycle_at, source, metadata
  ) VALUES (
    p_subscription_id, p_scheduled_at, p_observed_next_cycle_at, p_source,
    jsonb_build_object('source', 'subscription_delivery_alignment')
  )
  ON CONFLICT (subscription_id, scheduled_at) DO UPDATE
    SET observed_next_cycle_at = EXCLUDED.observed_next_cycle_at,
        source = EXCLUDED.source,
        admitted_at = now(),
        metadata = EXCLUDED.metadata
    WHERE public.subscription_delivery_alignment_admission_receipts.consumed_at IS NULL;
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_upsert_case(
  p_shipment_id uuid,
  p_predecessor_order_id uuid,
  p_subscription_id uuid,
  p_predecessor_cycle_id uuid,
  p_predecessor_cycle_number integer,
  p_mode text,
  p_evidence_kind text,
  p_observed_next_cycle_at timestamptz,
  p_manual_review_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_state text;
BEGIN
  IF p_mode NOT IN ('shadow', 'protect', 'auto_align') THEN
    RETURN;
  END IF;

  IF p_mode = 'shadow' THEN
    v_state := 'shadow';
  ELSE
    -- An unordered non-activation cycle cannot authorize automatic alignment.
    IF p_predecessor_cycle_number IS NULL THEN
      p_manual_review_reason := 'missing_renewal_correlation';
    END IF;
    v_state := CASE
      WHEN p_manual_review_reason IS NOT NULL THEN 'manual_review'
      ELSE 'protected'
    END;
  END IF;

  IF p_shipment_id IS NULL THEN
    INSERT INTO public.subscription_delivery_alignment_cases (
      shipment_id, predecessor_order_id, subscription_id,
      predecessor_cycle_id, predecessor_cycle_number, captured_mode, state,
      evidence_kind, observed_next_cycle_at, manual_review_reason, metadata
    ) VALUES (
      NULL, p_predecessor_order_id, p_subscription_id,
      p_predecessor_cycle_id, p_predecessor_cycle_number, p_mode, v_state,
      p_evidence_kind, p_observed_next_cycle_at,
      p_manual_review_reason,
      jsonb_build_object('source', 'subscription_delivery_alignment')
    )
    ON CONFLICT (predecessor_order_id) WHERE shipment_id IS NULL DO UPDATE
      SET updated_at = now(),
          observed_next_cycle_at = EXCLUDED.observed_next_cycle_at,
          evidence_kind = EXCLUDED.evidence_kind,
          state = CASE
            WHEN public.subscription_delivery_alignment_cases.state IN ('aligned', 'released')
              THEN public.subscription_delivery_alignment_cases.state
            ELSE EXCLUDED.state
          END,
          captured_mode = CASE
            WHEN public.subscription_delivery_alignment_cases.state IN ('aligned', 'released')
              THEN public.subscription_delivery_alignment_cases.captured_mode
            ELSE EXCLUDED.captured_mode
          END,
          manual_review_reason = COALESCE(
            public.subscription_delivery_alignment_cases.manual_review_reason,
            EXCLUDED.manual_review_reason
          );
    RETURN;
  END IF;

  INSERT INTO public.subscription_delivery_alignment_cases (
    shipment_id, predecessor_order_id, subscription_id,
    predecessor_cycle_id, predecessor_cycle_number, captured_mode, state,
    evidence_kind, observed_next_cycle_at, manual_review_reason, metadata
  ) VALUES (
    p_shipment_id, p_predecessor_order_id, p_subscription_id,
    p_predecessor_cycle_id, p_predecessor_cycle_number, p_mode, v_state,
    p_evidence_kind, p_observed_next_cycle_at, p_manual_review_reason,
    jsonb_build_object('source', 'subscription_delivery_alignment')
  )
  ON CONFLICT (shipment_id) WHERE shipment_id IS NOT NULL DO UPDATE
    SET updated_at = now(),
        observed_next_cycle_at = EXCLUDED.observed_next_cycle_at,
        evidence_kind = EXCLUDED.evidence_kind,
        state = CASE
          WHEN public.subscription_delivery_alignment_cases.state IN ('aligned', 'released')
            THEN public.subscription_delivery_alignment_cases.state
          WHEN EXCLUDED.state = 'manual_review' THEN 'manual_review'
          WHEN EXCLUDED.state = 'protected' THEN 'protected'
          ELSE public.subscription_delivery_alignment_cases.state
        END,
        captured_mode = CASE
          WHEN public.subscription_delivery_alignment_cases.state IN ('aligned', 'released')
            THEN public.subscription_delivery_alignment_cases.captured_mode
          WHEN EXCLUDED.state IN ('protected', 'manual_review') THEN EXCLUDED.captured_mode
          ELSE public.subscription_delivery_alignment_cases.captured_mode
        END,
        manual_review_reason = COALESCE(
          public.subscription_delivery_alignment_cases.manual_review_reason,
          EXCLUDED.manual_review_reason
        );
END;
$$;

-- Observe an existing active exception hold; never create a hold or an event.
-- Local cancellation remains a local state change. An undelivered, unsuperseded
-- cancelled parcel still counts as outstanding when renewal admission is enabled.
CREATE FUNCTION public.subscription_delivery_alignment_open_exception_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_mode text;
  v_order public.commerce_orders%ROWTYPE;
  v_cycle public.subscription_delivery_alignment_cycles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_fulfillment public.fulfillment_shipments%ROWTYPE;
  v_found boolean := false;
BEGIN
  IF NEW.reason <> 'fulfillment_exception' OR NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.reason = 'fulfillment_exception' AND OLD.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT mode INTO v_mode FROM public.subscription_delivery_alignment_control WHERE singleton = true;
  IF COALESCE(v_mode, 'off') = 'off' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.subscription_cycle_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_cycle FROM public.subscription_delivery_alignment_cycles WHERE id = v_order.subscription_cycle_id;
  SELECT * INTO v_subscription FROM public.subscriptions WHERE id = v_cycle.subscription_id FOR UPDATE;
  IF NOT FOUND OR v_subscription.status <> 'active' OR v_cycle.status IS DISTINCT FROM 'paid' THEN
    RETURN NEW;
  END IF;

  FOR v_fulfillment IN
    SELECT * FROM public.fulfillment_shipments
     WHERE order_id = v_order.id
     ORDER BY created_at ASC, id ASC
  LOOP
    v_found := true;
    PERFORM public.subscription_delivery_alignment_upsert_case(
      v_fulfillment.id, v_order.id, v_subscription.id, v_cycle.id,
      v_cycle.cycle_number, v_mode, 'fulfillment_exception', v_subscription.next_cycle_at
    );
  END LOOP;
  IF NOT v_found THEN
    PERFORM public.subscription_delivery_alignment_upsert_case(
      NULL, v_order.id, v_subscription.id, v_cycle.id,
      v_cycle.cycle_number, v_mode, 'missing_fulfillment',
      v_subscription.next_cycle_at,
      CASE WHEN v_mode = 'shadow' THEN NULL ELSE 'fulfillment_exception_without_fulfillment' END
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_on_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.subscription_delivery_alignment_cases%ROWTYPE;
  v_inherited_case_id uuid;
  v_order public.commerce_orders%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_open_dunning boolean;
  v_artifact_reason text;
  v_latest_delivered_at timestamptz;
  v_target timestamptz;
BEGIN
  IF NEW.delivered_at IS NULL
     OR (TG_OP = 'UPDATE' AND OLD.delivered_at IS NOT NULL)
  THEN
    RETURN NEW;
  END IF;

  -- Derive the aggregate from the fulfillment's order, then lock it before
  -- examining its ledger. This fence is required even when there is no case
  -- yet: otherwise delivery could return on an empty lookup while concurrent
  -- admission creates protection from the not-yet-committed delivery.
  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE id = NEW.order_id
     AND subscription_cycle_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = (SELECT subscription_id FROM public.subscription_cycles WHERE id = v_order.subscription_cycle_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Admission or exception evidence may have changed the case while this
  -- transaction waited for the aggregate, so take the case lock only now.
  SELECT * INTO v_case
    FROM public.subscription_delivery_alignment_cases
   WHERE shipment_id = NEW.id
   FOR UPDATE;

  -- A replacement parcel is created after the case was already open, so it never
  -- carries a case of its own. It is the arrival the customer is actually
  -- waiting for, so it settles the case its predecessor opened on the same
  -- order. An open case is preferred because that is the one holding the
  -- renewal. Ordinary parcels never enter this branch: they replace nothing.
  IF NOT FOUND AND NEW.replaces_shipment_id IS NOT NULL THEN
    SELECT id INTO v_inherited_case_id
      FROM public.subscription_delivery_alignment_cases
     WHERE predecessor_order_id = NEW.order_id
     ORDER BY (state IN ('protected', 'manual_review')) DESC, created_at ASC, id ASC
     LIMIT 1;
    IF v_inherited_case_id IS NOT NULL THEN
      SELECT * INTO v_case
        FROM public.subscription_delivery_alignment_cases
       WHERE id = v_inherited_case_id
       FOR UPDATE;
    END IF;
  END IF;
  IF v_case.id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.subscription_delivery_alignment_cases
     SET delivered_at = LEAST(COALESCE(delivered_at, NEW.delivered_at), NEW.delivered_at),
         updated_at = now()
   WHERE id = v_case.id
   RETURNING * INTO v_case;

  -- Outstanding means the customer is still waiting for it. A parcel that
  -- another row supersedes through replaces_shipment_id has been
  -- answered by that replacement, and when it was lost its delivered_at stays
  -- null for ever - counting it would hold this case open for ever with it.
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shipments outstanding
     WHERE outstanding.order_id = v_case.predecessor_order_id
       AND outstanding.delivered_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.fulfillment_shipments successor
          WHERE successor.replaces_shipment_id = outstanding.id
       )
  ) THEN
    RETURN NEW;
  END IF;

  IF v_subscription.status <> 'active' THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'released' ELSE state END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.subscription_dunning_cases
     WHERE subscription_id = v_subscription.id
       AND status IN ('open', 'expired')
  ) INTO v_open_dunning;
  IF v_open_dunning THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'manual_review' ELSE state END,
           manual_review_reason = CASE WHEN state = 'protected' THEN 'open_dunning' ELSE manual_review_reason END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.subscription_delivery_alignment_cycles successor
      JOIN public.subscription_renewal_operations operation ON operation.id = successor.renewal_operation_id
      WHERE successor.subscription_id = v_subscription.id
        AND (successor.cycle_number > v_case.predecessor_cycle_number OR (successor.cycle_number IS NULL AND successor.id <> v_case.predecessor_cycle_id))
        AND operation.attempt_prepared_at IS NOT NULL
    ) THEN 'existing_provider_attempt'
    WHEN EXISTS (
      SELECT 1 FROM public.subscription_delivery_alignment_cycles successor
      WHERE successor.subscription_id = v_subscription.id
        AND (successor.cycle_number > v_case.predecessor_cycle_number
             OR (successor.cycle_number IS NULL AND successor.id <> v_case.predecessor_cycle_id))
    ) THEN 'renewal_cycle_already_created'
    ELSE NULL
  END INTO v_artifact_reason;

  IF v_artifact_reason IS NOT NULL THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'manual_review' ELSE state END,
           manual_review_reason = CASE WHEN state = 'protected' THEN v_artifact_reason ELSE manual_review_reason END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;

  IF v_case.state <> 'protected' THEN
    RETURN NEW;
  END IF;
  IF v_case.captured_mode = 'protect' THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = CASE WHEN state = 'protected' THEN 'released' ELSE state END,
           updated_at = now()
     WHERE predecessor_order_id = v_case.predecessor_order_id;
    RETURN NEW;
  END IF;
  IF v_case.captured_mode <> 'auto_align' THEN
    RETURN NEW;
  END IF;

  -- With a split shipment, delivery events can arrive in either chronology.
  -- Preserve the interval from the last parcel delivered, not necessarily from
  -- the final webhook processed by this transaction.
  SELECT max(delivered_at) INTO v_latest_delivered_at
    FROM public.fulfillment_shipments
   WHERE order_id = v_case.predecessor_order_id;
  v_target := v_latest_delivered_at + make_interval(days => v_subscription.cadence_days);
  UPDATE public.subscriptions
     SET next_cycle_at = CASE
           WHEN next_cycle_at IS NULL THEN v_target
           ELSE GREATEST(next_cycle_at, v_target)
         END,
         updated_at = now()
   WHERE id = v_subscription.id
   RETURNING next_cycle_at INTO v_target;

  UPDATE public.subscription_delivery_alignment_cases
     SET state = CASE WHEN state = 'protected' THEN 'aligned' ELSE state END,
         aligned_next_cycle_at = CASE WHEN state = 'protected' THEN v_target ELSE aligned_next_cycle_at END,
         aligned_at = CASE WHEN state = 'protected' THEN now() ELSE aligned_at END,
         updated_at = now()
   WHERE predecessor_order_id = v_case.predecessor_order_id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_admit_renewal(
  p_subscription_id uuid,
  p_scheduled_at timestamptz,
  p_as_of timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_predecessor public.subscription_delivery_alignment_cycles%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_mode text;
  v_fulfillment public.fulfillment_shipments%ROWTYPE;
  v_has_fulfillment boolean := false;
  v_has_undelivered boolean := false;
  v_has_paid_predecessor boolean := false;
  v_existing_state text;
  v_ledger_state text;
BEGIN
  IF p_subscription_id IS NULL OR p_scheduled_at IS NULL OR p_as_of IS NULL THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_invalid_admission' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = p_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_subscription_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_subscription.status <> 'active' THEN
    RETURN jsonb_build_object('allowed', false, 'state', 'not_active', 'reason', 'subscription_not_active');
  END IF;

  -- D13 native translation note: this entry admits NEW cycles only.
  -- Existing renewal/dunning retries bypass admission and receipts structurally.
  SELECT * INTO v_predecessor
    FROM public.subscription_delivery_alignment_cycles
   WHERE subscription_id = p_subscription_id
     AND status = 'paid'
     AND cycle_number >= 0
   ORDER BY cycle_number DESC NULLS LAST, scheduled_at DESC
   LIMIT 1;
  v_has_paid_predecessor := FOUND;

  -- A later paid cycle is authoritative proof that an older collision no
  -- longer controls the next renewal. Release it atomically under the same
  -- subscription lock so a completed retry cannot strand future normal cycles.
  IF v_has_paid_predecessor THEN
    UPDATE public.subscription_delivery_alignment_cases
       SET state = 'released',
           updated_at = now()
     WHERE subscription_id = p_subscription_id
       AND state IN ('protected', 'manual_review')
       AND predecessor_cycle_number < v_predecessor.cycle_number;
  END IF;

  SELECT state INTO v_existing_state
    FROM public.subscription_delivery_alignment_cases
   WHERE subscription_id = p_subscription_id
     AND state IN ('protected', 'manual_review')
     AND (NOT v_has_paid_predecessor OR predecessor_cycle_number >= v_predecessor.cycle_number OR predecessor_cycle_number IS NULL)
   ORDER BY predecessor_cycle_number DESC, created_at DESC, id DESC
   LIMIT 1;
  IF v_existing_state IS NOT NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'state', v_existing_state,
      'reason', CASE WHEN v_existing_state = 'protected'
        THEN 'delivery_alignment_protected' ELSE 'delivery_alignment_manual_review' END
    );
  END IF;

  SELECT mode INTO v_mode
    FROM public.subscription_delivery_alignment_control
   WHERE singleton = true;
  IF COALESCE(v_mode, 'off') = 'off' THEN
    RETURN jsonb_build_object('allowed', true, 'state', 'off', 'reason', 'mode_off');
  END IF;
  -- Shadow is observation-only. A stale caller is useful telemetry but it must
  -- never turn this rollout mode into an implicit admission gate or rewrite a
  -- case using a schedule we no longer own.
  IF COALESCE(v_mode, 'off') = 'shadow'
     AND v_subscription.next_cycle_at IS DISTINCT FROM p_scheduled_at THEN
    RETURN jsonb_build_object('allowed', true, 'state', 'shadow', 'reason', 'stale_shadow');
  END IF;
  IF v_subscription.next_cycle_at IS DISTINCT FROM p_scheduled_at THEN
    RETURN jsonb_build_object('allowed', false, 'state', 'stale', 'reason', 'stale_next_cycle_at');
  END IF;
  IF p_scheduled_at > p_as_of THEN
    RETURN jsonb_build_object('allowed', true, 'state', 'none', 'reason', 'not_due');
  END IF;

  -- Unknown paid history cannot outrank a known predecessor, but ignoring it
  -- could admit a charge while an uncorrelated parcel is still outstanding.
  -- Refuse without a receipt; shadow remains observation-only. Do not invent
  -- an ordinal from scheduled_at or silently classify it as activation.
  IF EXISTS (
    SELECT 1 FROM public.subscription_delivery_alignment_cycles
     WHERE subscription_id = p_subscription_id
       AND status = 'paid' AND cycle_number IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'allowed', v_mode = 'shadow',
      'state', CASE WHEN v_mode = 'shadow' THEN 'shadow' ELSE 'manual_review' END,
      'reason', 'missing_renewal_correlation'
    );
  END IF;

  IF NOT v_has_paid_predecessor OR v_predecessor.order_id IS NULL THEN
    PERFORM public.subscription_delivery_alignment_record_allowed_receipt(
      p_subscription_id, p_scheduled_at, v_subscription.next_cycle_at, 'renewal_admission'
    );
    RETURN jsonb_build_object('allowed', true, 'state', 'none', 'reason', 'no_paid_predecessor');
  END IF;

  SELECT * INTO v_order
   FROM public.commerce_orders
   WHERE id = v_predecessor.order_id;
  IF NOT FOUND OR v_order.subscription_cycle_id IS DISTINCT FROM v_predecessor.id THEN
    PERFORM public.subscription_delivery_alignment_record_allowed_receipt(
      p_subscription_id, p_scheduled_at, v_subscription.next_cycle_at, 'renewal_admission'
    );
    RETURN jsonb_build_object('allowed', true, 'state', 'none', 'reason', 'predecessor_not_subscription_cycle');
  END IF;

  FOR v_fulfillment IN
    SELECT *
      FROM public.fulfillment_shipments
     WHERE order_id = v_order.id
     ORDER BY created_at ASC, id ASC
  LOOP
    v_has_fulfillment := true;
    -- Superseded parcels do not count. Without this the lost original would
    -- keep this admission answering `protected` long after its replacement
    -- reached the customer, and the subscription would never renew again.
    IF v_fulfillment.delivered_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.fulfillment_shipments successor
          WHERE successor.replaces_shipment_id = v_fulfillment.id
       )
    THEN
      v_has_undelivered := true;
    END IF;
  END LOOP;

  -- Do not open a delivery case merely because a normal parcel exists. It is
  -- delay evidence only once the autonomous renewal is actually overdue.
  IF NOT v_has_fulfillment THEN
    PERFORM public.subscription_delivery_alignment_upsert_case(
      NULL, v_order.id, p_subscription_id, v_predecessor.id,
      v_predecessor.cycle_number, v_mode, 'missing_fulfillment',
      v_subscription.next_cycle_at,
      CASE WHEN v_mode = 'shadow' THEN NULL ELSE 'missing_fulfillment' END
    );
    IF v_mode = 'shadow' THEN
      RETURN jsonb_build_object('allowed', true, 'state', 'shadow', 'reason', 'delivery_alignment_shadow');
    END IF;
    RETURN jsonb_build_object('allowed', false, 'state', 'manual_review', 'reason', 'delivery_alignment_manual_review');
  END IF;
  IF NOT v_has_undelivered THEN
    PERFORM public.subscription_delivery_alignment_record_allowed_receipt(
      p_subscription_id, p_scheduled_at, v_subscription.next_cycle_at, 'renewal_admission'
    );
    RETURN jsonb_build_object('allowed', true, 'state', 'none', 'reason', 'predecessor_delivered');
  END IF;

  FOR v_fulfillment IN
    SELECT *
      FROM public.fulfillment_shipments
     WHERE order_id = v_order.id
     ORDER BY created_at ASC, id ASC
  LOOP
    PERFORM public.subscription_delivery_alignment_upsert_case(
      v_fulfillment.id, v_order.id, p_subscription_id, v_predecessor.id,
      v_predecessor.cycle_number, v_mode, 'overdue_renewal',
      v_subscription.next_cycle_at
    );
  END LOOP;

  IF v_mode = 'shadow' THEN
    RETURN jsonb_build_object('allowed', true, 'state', 'shadow', 'reason', 'delivery_alignment_shadow');
  END IF;

  -- The ledger owns this answer. The upsert above preserves a state an operator
  -- or the delivery path already settled, so reading the row is the only way for
  -- the response to agree with it. A blocking state still refuses; a settled one
  -- is admitted and takes the same one-time receipt the other admitted paths
  -- take, because the cycle-insert backstop would otherwise reject a renewal
  -- this call has just declared allowed. A missing row cannot happen here (the
  -- loop above wrote one for every fulfillment) and is treated as blocking.
  SELECT state INTO v_ledger_state
    FROM public.subscription_delivery_alignment_cases
   WHERE subscription_id = p_subscription_id
     AND predecessor_order_id = v_order.id
   ORDER BY (state IN ('protected', 'manual_review')) DESC, updated_at DESC, id DESC
   LIMIT 1;
  v_ledger_state := COALESCE(v_ledger_state, 'protected');
  IF v_ledger_state IN ('protected', 'manual_review') THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'state', v_ledger_state,
      'reason', CASE WHEN v_ledger_state = 'protected'
        THEN 'delivery_alignment_protected' ELSE 'delivery_alignment_manual_review' END
    );
  END IF;
  PERFORM public.subscription_delivery_alignment_record_allowed_receipt(
    p_subscription_id, p_scheduled_at, v_subscription.next_cycle_at, 'renewal_admission'
  );
  RETURN jsonb_build_object(
    'allowed', true,
    'state', v_ledger_state,
    'reason', 'delivery_alignment_case_settled'
  );
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_resolve_case(
  p_case_id uuid,
  p_resolution text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.subscription_delivery_alignment_cases%ROWTYPE;
  v_subscription_id uuid;
  v_subscription_status text;
BEGIN
  IF p_case_id IS NULL
     OR p_resolution NOT IN ('operator_confirmed', 'retry_succeeded', 'false_positive')
     OR NULLIF(btrim(p_note), '') IS NULL
  THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_invalid_resolution' USING ERRCODE = '22023';
  END IF;

  -- Discover identity without locking the ledger first; all mutable alignment
  -- paths own subscription -> ledger case to avoid delivery/admission deadlock.
  SELECT subscription_id INTO v_subscription_id
    FROM public.subscription_delivery_alignment_cases
   WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_case_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_subscription_status
    FROM public.subscriptions
   WHERE id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_subscription_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case
    FROM public.subscription_delivery_alignment_cases
   WHERE id = p_case_id
   FOR UPDATE;
  IF v_case.state NOT IN ('protected', 'manual_review') THEN
    RETURN jsonb_build_object('caseId', v_case.id, 'state', v_case.state, 'resolved', false, 'reason', 'not_open');
  END IF;

  -- Release is now real permission for the next autonomous charge, so it may not
  -- be spent on a shipment that has not arrived. Releasing here would take money
  -- for goods the customer never received and, because every open-case
  -- projection keys on the open states, would take the case off the operator
  -- queue, the overdue counter and the customer banner at the same time. The
  -- honest exits are the durable delivery, a confirmed replacement, or ending
  -- the subscription first. A case with no fulfillment row at all is untouched:
  -- it has no delivery fact to wait for, and operator judgement is the only tool
  -- that corruption case has.
  IF v_subscription_status = 'active'
     AND EXISTS (
       SELECT 1
         FROM public.fulfillment_shipments outstanding
        WHERE outstanding.order_id = v_case.predecessor_order_id
          AND outstanding.delivered_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.fulfillment_shipments successor
             WHERE successor.replaces_shipment_id = outstanding.id
          )
     )
  THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_release_would_strand' USING ERRCODE = '22023';
  END IF;

  UPDATE public.subscription_delivery_alignment_cases
     SET state = 'released',
         updated_at = now(),
         metadata = metadata || jsonb_build_object(
           'manualResolution',
           jsonb_build_object('code', p_resolution, 'note', p_note, 'resolvedAt', now())
         )
   WHERE id = v_case.id
   RETURNING * INTO v_case;

  RETURN jsonb_build_object('caseId', v_case.id, 'state', v_case.state, 'resolved', true, 'resolution', p_resolution);
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_confirm_replacement(
  p_case_id uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_case public.subscription_delivery_alignment_cases%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_subscription_id uuid;
  v_target timestamptz;
BEGIN
  IF p_case_id IS NULL OR NULLIF(btrim(p_note), '') IS NULL THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_invalid_replacement' USING ERRCODE = '22023';
  END IF;

  -- Identity first, then the aggregate lock, then the case lock: the same order
  -- admission, delivery and resolution use, so this cannot deadlock against them.
  SELECT subscription_id INTO v_subscription_id
    FROM public.subscription_delivery_alignment_cases
   WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_case_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_subscription_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_case
    FROM public.subscription_delivery_alignment_cases
   WHERE id = p_case_id
   FOR UPDATE;

  -- A case this call already aligned answers with its stored schedule instead of
  -- shifting again. Without this the second call would add another cadence.
  IF v_case.state = 'aligned' THEN
    RETURN jsonb_build_object(
      'caseId', v_case.id,
      'state', v_case.state,
      'confirmed', true,
      'nextCycleAt', v_case.aligned_next_cycle_at
    );
  END IF;
  IF v_case.state NOT IN ('protected', 'manual_review') THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_case_not_open' USING ERRCODE = '22023';
  END IF;

  -- A non-active subscription has no autonomous renewal to align. Confirming a
  -- replacement there would move a schedule nobody is going to read, and would
  -- hide the case from the operator queue on the strength of a schedule shift
  -- that changes nothing.
  IF v_subscription.status <> 'active' THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_replacement_requires_active_subscription' USING ERRCODE = '22023';
  END IF;

  -- The confirmation instant plus the subscription's own cadence, and never
  -- earlier than the schedule already promised. `GREATEST` is what makes this
  -- monotonic: the same one-way rule the delivery path applies.
  v_target := now() + make_interval(days => v_subscription.cadence_days);
  UPDATE public.subscriptions
     SET next_cycle_at = CASE
           WHEN next_cycle_at IS NULL THEN v_target
           ELSE GREATEST(next_cycle_at, v_target)
         END,
         updated_at = now()
   WHERE id = v_subscription.id
   RETURNING next_cycle_at INTO v_target;

  -- Settle every open case of the same predecessor order, not only the targeted
  -- row. One replacement answers for the whole undelivered order, and a sibling
  -- left open would keep the cycle-insert backstop rejecting the renewal this
  -- confirmation just scheduled. Matches how the delivery path settles siblings.
  UPDATE public.subscription_delivery_alignment_cases
     SET state = 'aligned',
         aligned_next_cycle_at = v_target,
         aligned_at = now(),
         updated_at = now(),
         metadata = metadata || jsonb_build_object(
           'replacementConfirmation',
           jsonb_build_object('note', p_note, 'confirmedAt', now(), 'nextCycleAt', v_target)
         )
   WHERE predecessor_order_id = v_case.predecessor_order_id
     AND state IN ('protected', 'manual_review');

  SELECT * INTO v_case
    FROM public.subscription_delivery_alignment_cases
   WHERE id = v_case.id;

  RETURN jsonb_build_object(
    'caseId', v_case.id,
    'state', v_case.state,
    'confirmed', true,
    'nextCycleAt', v_case.aligned_next_cycle_at
  );
END;
$$;

CREATE FUNCTION public.subscription_delivery_alignment_guard_cycle_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_mode text;
  v_receipt_id uuid;
BEGIN
  IF NEW.status <> 'payment_pending' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = NEW.subscription_id
   FOR UPDATE;
  IF NOT FOUND OR v_subscription.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- Expired-dunning recovery owns its fresh cycle through a separate tokenized
  -- workflow. It retains its own authority rather than becoming alignment dunning.
  IF EXISTS (
    SELECT 1 FROM public.subscription_dunning_cases
     WHERE subscription_id = NEW.subscription_id
       AND status = 'expired'
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subscription_delivery_alignment_cases
     WHERE subscription_id = NEW.subscription_id
       AND state IN ('protected', 'manual_review')
  ) THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_protected' USING ERRCODE = 'P0001';
  END IF;

  SELECT mode INTO v_mode
    FROM public.subscription_delivery_alignment_control
   WHERE singleton = true;

  -- Only enforcing modes own the stale-schedule gate. Shadow observes without
  -- blocking, and an off rollout must be behaviorally inert for new cases.
  IF COALESCE(v_mode, 'off') IN ('off', 'shadow') THEN
    -- Consuming an aligned scheduled instant is a durable lifecycle transition,
    -- even when an operator turned new-case creation off after alignment.
    UPDATE public.subscription_delivery_alignment_cases
       SET state = 'released',
           updated_at = now()
     WHERE subscription_id = NEW.subscription_id
       AND state = 'aligned'
       AND aligned_next_cycle_at = NEW.scheduled_at;
    RETURN NEW;
  END IF;

  IF NEW.scheduled_at IS DISTINCT FROM v_subscription.next_cycle_at THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_stale_schedule' USING ERRCODE = '40001';
  END IF;

  -- Claim exactly one admission proof in the same transaction as the new
  -- cycle. A uniqueness conflict or later failure rolls this consumption back,
  -- allowing the runtime's normal idempotent retry without a second preflight.
  UPDATE public.subscription_delivery_alignment_admission_receipts
     SET consumed_at = now()
   WHERE subscription_id = NEW.subscription_id
     AND scheduled_at = NEW.scheduled_at
     AND observed_next_cycle_at = v_subscription.next_cycle_at
     AND decision = 'allowed'
     AND consumed_at IS NULL
   RETURNING id INTO v_receipt_id;
  IF v_receipt_id IS NULL THEN
    RAISE EXCEPTION 'subscription_delivery_alignment_admission_required' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.subscription_delivery_alignment_cases
     SET state = 'released',
         updated_at = now()
   WHERE subscription_id = NEW.subscription_id
     AND state = 'aligned'
     AND aligned_next_cycle_at = NEW.scheduled_at;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_subscription_delivery_alignment_exception_case
AFTER INSERT OR UPDATE OF status, reason ON public.commerce_order_holds
FOR EACH ROW EXECUTE FUNCTION public.subscription_delivery_alignment_open_exception_case();

CREATE TRIGGER trg_subscription_delivery_alignment_on_delivery
AFTER INSERT OR UPDATE OF delivered_at ON public.fulfillment_shipments
FOR EACH ROW EXECUTE FUNCTION public.subscription_delivery_alignment_on_delivery();

CREATE TRIGGER trg_subscription_delivery_alignment_guard_cycle_insert
BEFORE INSERT ON public.subscription_cycles
FOR EACH ROW EXECUTE FUNCTION public.subscription_delivery_alignment_guard_cycle_insert();

REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_get_mode() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_set_mode(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_record_allowed_receipt(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_upsert_case(uuid, uuid, uuid, uuid, integer, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_open_exception_case() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_on_delivery() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_admit_renewal(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_resolve_case(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_confirm_replacement(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_delivery_alignment_guard_cycle_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.subscription_delivery_alignment_control FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.subscription_delivery_alignment_cases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.subscription_delivery_alignment_admission_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.subscription_delivery_alignment_cycles FROM PUBLIC, anon, authenticated;

CREATE TABLE public.subscription_delivery_alignment_arrivals (
 request_key text PRIMARY KEY,
 shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id),
 delivered_at timestamptz NOT NULL,
 evidence_ref text NOT NULL CHECK (evidence_ref LIKE 'evidence:%')
);
CREATE FUNCTION public.fulfillment_record_alignment_arrival(p_key text,p_shipment uuid,p_arrived timestamptz,p_evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_arrival public.subscription_delivery_alignment_arrivals%ROWTYPE; v_replayed boolean; v_subscription uuid;
BEGIN
 IF btrim(COALESCE(p_key,''))='' OR p_arrived IS NULL OR p_evidence NOT LIKE 'evidence:%' OR p_evidence IS NULL THEN RAISE EXCEPTION 'fulfillment_arrival_invalid' USING ERRCODE='22023'; END IF;
 -- Arrival commands lock subscription before shipment, then the delivery trigger
 -- locks the case. Direct shipment writes already hold the shipment lock when
 -- their AFTER trigger acquires the subscription; callers must use this command
 -- or acquire the subscription first to preserve the same lock order.
 SELECT cycle.subscription_id INTO v_subscription FROM public.fulfillment_shipments shipment
 JOIN public.commerce_orders order_row ON order_row.id=shipment.order_id
 JOIN public.subscription_cycles cycle ON cycle.id=order_row.subscription_cycle_id WHERE shipment.id=p_shipment;
 IF v_subscription IS NOT NULL THEN PERFORM id FROM public.subscriptions WHERE id=v_subscription FOR UPDATE; END IF;
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_arrival_shipment_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_arrival FROM public.subscription_delivery_alignment_arrivals WHERE request_key=p_key;
 v_replayed := FOUND;
 IF FOUND THEN
  IF v_arrival.shipment_id<>p_shipment OR v_arrival.delivered_at<>p_arrived OR v_arrival.evidence_ref<>p_evidence THEN RAISE EXCEPTION 'fulfillment_arrival_key_conflict' USING ERRCODE='23505'; END IF;
 ELSE
  INSERT INTO public.subscription_delivery_alignment_arrivals VALUES(p_key,p_shipment,p_arrived,p_evidence);
  -- Arrival evidence is supplied by the trusted selected binding, never inferred
  -- from status/receipt time. Preserve the first durable arrival on replay.
  UPDATE public.fulfillment_shipments SET delivered_at=p_arrived,updated_at=now() WHERE id=p_shipment AND delivered_at IS NULL;
 END IF;
 RETURN jsonb_build_object('replayed',v_replayed);
END;
$$;
REVOKE ALL ON public.subscription_delivery_alignment_arrivals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_record_alignment_arrival(text,uuid,timestamptz,text) FROM PUBLIC, anon, authenticated;
