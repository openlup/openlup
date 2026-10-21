-- Public fulfillment stock-observation and discrepancy-evidence forward.
--
-- WHAT THIS SHIPS. A host can persist one opaque stock source's latest SKU
-- observations, immutable per-run snapshots, one sync cursor, and operator
-- discrepancy evidence. The schema supports the same provider-neutral worker
-- actions as the managed adapter: running/succeeded/failed cursor transitions,
-- idempotent current+snapshot writes, shortage evidence open/replay/resolve and
-- durable readback after a process restart.
--
-- WHAT THIS DELIBERATELY DOES NOT SHIP. There is no provider name, HTTP payload,
-- warehouse document, catalogue content, inventory reservation, ATP promise,
-- customer/tester identity or fulfillment status mapping here. `source_key` and
-- `sku` are opaque deployment identifiers. The host may compare an external
-- observation with its own inventory, but this forward never mutates inventory
-- and its evidence never blocks a sale. It creates no role, policy or grant;
-- all routines are invoker-rights and the host application is the security
-- boundary, matching the rest of the public platform catalogue.

CREATE TABLE public.fulfillment_stock_sync_cursors (
  source_key text PRIMARY KEY,
  status text NOT NULL,
  last_stock_synced_at timestamptz,
  last_movement_occurred_at timestamptz,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_stock_sync_cursors_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT fulfillment_stock_sync_cursors_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT fulfillment_stock_sync_cursors_error_check
    CHECK (error_code IS NULL OR char_length(error_code) <= 180)
);

CREATE TABLE public.fulfillment_stock_current (
  source_key text NOT NULL,
  sku text NOT NULL,
  total_quantity integer NOT NULL,
  for_sale_quantity integer NOT NULL,
  reserved_unavailable_quantity integer NOT NULL,
  inventory_class text,
  last_synced_at timestamptz NOT NULL,
  stale_after timestamptz NOT NULL,
  sync_run_id text NOT NULL,
  idempotency_key text NOT NULL,
  operation_fingerprint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_key, sku),
  CONSTRAINT fulfillment_stock_current_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT fulfillment_stock_current_sku_check CHECK (btrim(sku) <> ''),
  CONSTRAINT fulfillment_stock_current_quantities_check CHECK (
    total_quantity >= 0 AND for_sale_quantity >= 0 AND reserved_unavailable_quantity >= 0
  ),
  CONSTRAINT fulfillment_stock_current_class_check
    CHECK (inventory_class IS NULL OR inventory_class IN ('sellable', 'packaging')),
  CONSTRAINT fulfillment_stock_current_freshness_check CHECK (stale_after > last_synced_at)
);

CREATE TABLE public.fulfillment_stock_operations (
  idempotency_key text PRIMARY KEY,
  operation_fingerprint text NOT NULL,
  source_key text NOT NULL,
  sku text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_stock_operations_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT fulfillment_stock_operations_sku_check CHECK (btrim(sku) <> '')
);

CREATE TABLE public.fulfillment_stock_snapshots (
  idempotency_key text PRIMARY KEY,
  operation_fingerprint text NOT NULL,
  source_key text NOT NULL,
  sku text NOT NULL,
  provider_total_quantity integer NOT NULL,
  provider_for_sale_quantity integer NOT NULL,
  provider_reserved_unavailable_quantity integer NOT NULL,
  local_on_hand integer NOT NULL,
  local_reserved integer NOT NULL,
  local_unavailable integer NOT NULL,
  local_safety_stock integer NOT NULL,
  inventory_class text,
  sync_run_id text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_stock_snapshots_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT fulfillment_stock_snapshots_sku_check CHECK (btrim(sku) <> ''),
  CONSTRAINT fulfillment_stock_snapshots_quantities_check CHECK (
    provider_total_quantity >= 0 AND provider_for_sale_quantity >= 0
    AND provider_reserved_unavailable_quantity >= 0 AND local_on_hand >= 0
    AND local_reserved >= 0 AND local_unavailable >= 0 AND local_safety_stock >= 0
  ),
  CONSTRAINT fulfillment_stock_snapshots_class_check
    CHECK (inventory_class IS NULL OR inventory_class IN ('sellable', 'packaging'))
);

CREATE TABLE public.fulfillment_stock_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  operation_fingerprint text NOT NULL,
  source_key text NOT NULL,
  sku text NOT NULL,
  threshold_kind text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  provider_for_sale_quantity integer,
  local_available_quantity integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  last_sync_run_id text,
  CONSTRAINT fulfillment_stock_evidence_source_check
    CHECK (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT fulfillment_stock_evidence_sku_check CHECK (btrim(sku) <> ''),
  CONSTRAINT fulfillment_stock_evidence_threshold_check
    CHECK (threshold_kind IN ('safety_stock', 'reservation_coverage', 'forecast', 'stale_sync', 'manual')),
  CONSTRAINT fulfillment_stock_evidence_severity_check CHECK (severity IN ('info', 'warning', 'critical')),
  CONSTRAINT fulfillment_stock_evidence_status_check CHECK (status IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT fulfillment_stock_evidence_quantities_check CHECK (
    (provider_for_sale_quantity IS NULL OR provider_for_sale_quantity >= 0)
    AND (local_available_quantity IS NULL OR local_available_quantity >= 0)
  )
);

CREATE INDEX fulfillment_stock_current_stale_idx
  ON public.fulfillment_stock_current(source_key, stale_after, sku);
CREATE INDEX fulfillment_stock_evidence_status_idx
  ON public.fulfillment_stock_evidence(source_key, status, last_seen_at DESC);

CREATE FUNCTION public.fulfillment_record_stock_current(
  p_source_key text, p_idempotency_key text, p_fingerprint text, p_sku text,
  p_total integer, p_for_sale integer, p_reserved_unavailable integer,
  p_inventory_class text, p_last_synced_at timestamptz, p_stale_after timestamptz,
  p_sync_run_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_fingerprint text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT operation_fingerprint INTO v_fingerprint
    FROM public.fulfillment_stock_operations
   WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_stock_current_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'readBack', true);
  END IF;
  INSERT INTO public.fulfillment_stock_current(
    source_key, sku, total_quantity, for_sale_quantity, reserved_unavailable_quantity,
    inventory_class, last_synced_at, stale_after, sync_run_id, idempotency_key,
    operation_fingerprint
  ) VALUES (
    p_source_key, p_sku, p_total, p_for_sale, p_reserved_unavailable,
    p_inventory_class, p_last_synced_at, p_stale_after, p_sync_run_id,
    p_idempotency_key, p_fingerprint
  ) ON CONFLICT (source_key, sku) DO UPDATE SET
    total_quantity = EXCLUDED.total_quantity,
    for_sale_quantity = EXCLUDED.for_sale_quantity,
    reserved_unavailable_quantity = EXCLUDED.reserved_unavailable_quantity,
    inventory_class = EXCLUDED.inventory_class,
    last_synced_at = EXCLUDED.last_synced_at,
    stale_after = EXCLUDED.stale_after,
    sync_run_id = EXCLUDED.sync_run_id,
    idempotency_key = EXCLUDED.idempotency_key,
    operation_fingerprint = EXCLUDED.operation_fingerprint,
    updated_at = now();
  INSERT INTO public.fulfillment_stock_operations(
    idempotency_key, operation_fingerprint, source_key, sku
  ) VALUES (p_idempotency_key, p_fingerprint, p_source_key, p_sku);
  RETURN jsonb_build_object('replayed', false, 'readBack', true);
END $$;

CREATE FUNCTION public.fulfillment_record_stock_snapshot(
  p_source_key text, p_idempotency_key text, p_fingerprint text, p_sku text,
  p_provider_total integer, p_provider_for_sale integer,
  p_provider_reserved_unavailable integer, p_local_on_hand integer,
  p_local_reserved integer, p_local_unavailable integer, p_local_safety integer,
  p_inventory_class text, p_sync_run_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_fingerprint text;
BEGIN
  SELECT operation_fingerprint INTO v_fingerprint FROM public.fulfillment_stock_snapshots
   WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_stock_snapshot_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'readBack', true);
  END IF;
  INSERT INTO public.fulfillment_stock_snapshots VALUES (
    p_idempotency_key, p_fingerprint, p_source_key, p_sku, p_provider_total,
    p_provider_for_sale, p_provider_reserved_unavailable, p_local_on_hand,
    p_local_reserved, p_local_unavailable, p_local_safety, p_inventory_class,
    p_sync_run_id, now()
  );
  RETURN jsonb_build_object('replayed', false, 'readBack', true);
END $$;

CREATE FUNCTION public.fulfillment_record_stock_evidence(
  p_source_key text, p_idempotency_key text, p_fingerprint text, p_sku text,
  p_threshold_kind text, p_severity text, p_provider_for_sale integer,
  p_local_available integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_existing public.fulfillment_stock_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.fulfillment_stock_evidence
   WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.operation_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_stock_evidence_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    UPDATE public.fulfillment_stock_evidence SET last_seen_at = now()
     WHERE idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('replayed', true);
  END IF;
  INSERT INTO public.fulfillment_stock_evidence(
    idempotency_key, operation_fingerprint, source_key, sku, threshold_kind,
    severity, provider_for_sale_quantity, local_available_quantity
  ) VALUES (
    p_idempotency_key, p_fingerprint, p_source_key, p_sku, p_threshold_kind,
    p_severity, p_provider_for_sale, p_local_available
  );
  RETURN jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION public.fulfillment_resolve_stock_evidence(
  p_source_key text, p_sku text, p_active_threshold_kinds text[], p_sync_run_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_resolved integer;
BEGIN
  UPDATE public.fulfillment_stock_evidence SET
    status = 'resolved', resolved_at = now(), last_seen_at = now(),
    last_sync_run_id = p_sync_run_id
  WHERE source_key = p_source_key AND sku = p_sku AND status <> 'resolved'
    AND NOT (threshold_kind = ANY(COALESCE(p_active_threshold_kinds, ARRAY[]::text[])));
  GET DIAGNOSTICS v_resolved = ROW_COUNT;
  RETURN jsonb_build_object('resolved', v_resolved);
END $$;
