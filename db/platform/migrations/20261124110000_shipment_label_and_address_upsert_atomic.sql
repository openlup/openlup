-- Atomic single-round-trip RPC for shipment label progression and optional label
-- evidence recording, preserving historical per-step idempotency keys.
CREATE FUNCTION public.fulfillment_record_label_atomic(
  p_idempotency_key text,
  p_shipment_id uuid,
  p_evidence_channel text DEFAULT NULL,
  p_external_ref text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_requested_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_labelled jsonb;
  v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_requested_at timestamptz := COALESCE(p_requested_at, now());
BEGIN
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) < 1 OR p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'fulfillment_advance_shipment_invalid_input' USING ERRCODE = '22023';
  END IF;

  PERFORM public.fulfillment_advance_shipment(
    p_idempotency_key || ':packed',
    p_shipment_id,
    'packed',
    v_metadata,
    v_requested_at
  );
  PERFORM public.fulfillment_advance_shipment(
    p_idempotency_key || ':label-pending',
    p_shipment_id,
    'label_pending',
    v_metadata,
    v_requested_at
  );
  v_labelled := public.fulfillment_advance_shipment(
    p_idempotency_key || ':label-created',
    p_shipment_id,
    'label_created',
    v_metadata,
    v_requested_at
  );

  IF p_evidence_channel IS NOT NULL AND p_external_ref IS NOT NULL AND btrim(p_external_ref) <> '' THEN
    RETURN COALESCE(
      public.fulfillment_record_evidence(
        p_idempotency_key || ':label-evidence',
        p_shipment_id,
        p_evidence_channel,
        'label',
        p_external_ref,
        v_metadata,
        v_requested_at
      ),
      v_labelled
    );
  END IF;

  RETURN v_labelled;
END;
$$;

-- Atomic single-round-trip RPC for customer saved address upsert:
-- ownership check -> idempotency replay -> optional default clear -> canonical lookup
-- -> write -> account event append -> read updated rows, all inside one transaction.
CREATE FUNCTION public.customer_saved_address_upsert_atomic(
  p_principal uuid,
  p_client uuid,
  p_event_type text,
  p_idempotency_key text,
  p_is_default boolean,
  p_kind text,
  p_address_id uuid,
  p_canonical_key text,
  p_row jsonb,
  p_event_payload jsonb,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_address_id uuid;
  v_saved uuid;
  v_event uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client AND principal_id = p_principal) THEN
    RETURN NULL;
  END IF;

  IF public.customer_saved_address_replayed(p_principal, p_client, p_event_type, p_idempotency_key) IS TRUE THEN
    RETURN public.customer_saved_addresses_read(p_principal, p_client);
  END IF;

  IF COALESCE(p_is_default, false) THEN
    IF public.customer_saved_address_clear_defaults(p_principal, p_client, p_kind, p_now) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'customer_saved_address_scope_mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_address_id := COALESCE(
    p_address_id,
    public.customer_saved_address_canonical(p_principal, p_client, p_canonical_key)
  );

  v_saved := public.customer_saved_address_write(p_principal, p_client, v_address_id, p_row, p_now);
  IF v_saved IS NULL THEN
    RAISE EXCEPTION 'customer_saved_address_scope_mismatch' USING ERRCODE = '42501';
  END IF;

  v_event := public.customer_account_event_append(
    p_principal,
    p_client,
    p_event_type,
    'address',
    v_saved,
    p_event_payload,
    p_now
  );
  IF v_event IS NULL THEN
    RAISE EXCEPTION 'customer_saved_address_event_append_failed' USING ERRCODE = 'P0001';
  END IF;

  RETURN public.customer_saved_addresses_read(p_principal, p_client);
END;
$$;

REVOKE ALL ON FUNCTION public.fulfillment_record_label_atomic(text,uuid,text,text,jsonb,timestamptz), public.customer_saved_address_upsert_atomic(uuid,uuid,text,text,boolean,text,uuid,text,jsonb,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_label_atomic(text,uuid,text,text,jsonb,timestamptz), public.customer_saved_address_upsert_atomic(uuid,uuid,text,text,boolean,text,uuid,text,jsonb,jsonb,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_label_atomic(text,uuid,text,text,jsonb,timestamptz), public.customer_saved_address_upsert_atomic(uuid,uuid,text,text,boolean,text,uuid,text,jsonb,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.fulfillment_record_label_atomic(text,uuid,text,text,jsonb,timestamptz), public.customer_saved_address_upsert_atomic(uuid,uuid,text,text,boolean,text,uuid,text,jsonb,jsonb,timestamptz) FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.fulfillment_record_label_atomic(text,uuid,text,text,jsonb,timestamptz), public.customer_saved_address_upsert_atomic(uuid,uuid,text,text,boolean,text,uuid,text,jsonb,jsonb,timestamptz) TO service_role'; END IF; END; $$;
