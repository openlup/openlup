CREATE OR REPLACE FUNCTION public.commerce_destination_v2_export(p_client_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN (WITH verified AS MATERIALIZED (
    SELECT snapshot_ref, client_id, issued_at, purpose, evidence_disposition, scope_ref, document_digest, evidence_expires_at,
      CASE WHEN evidence_disposition = 'available' THEN public.commerce_destination_v2_check_document(d, 'destination.snapshotRef') END AS result
    FROM public.commerce_destination_v2_documents AS d WHERE client_id = p_client_id
  )
  SELECT (SELECT coalesce(jsonb_agg(
    jsonb_build_object('snapshotRef', snapshot_ref, 'issuedAt',
      to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'evidenceDisposition', evidence_disposition)
    || CASE WHEN (result->>'verified')::boolean THEN
      jsonb_build_object('document', result->'document', 'scopeRef', scope_ref, 'documentDigest', document_digest,
        'evidenceExpiresAt', CASE WHEN purpose IS NOT NULL THEN
          to_char(evidence_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
    WHEN result IS NOT NULL THEN
      jsonb_build_object('verification', jsonb_build_object('status', 'failed', 'code', result->'code', 'field', result->'field'))
    ELSE '{}'::jsonb END
    || CASE WHEN pins.valid IS NOT NULL THEN jsonb_build_object('orderBindings', pins.valid) ELSE '{}'::jsonb END
    || CASE WHEN selections.valid IS NOT NULL THEN jsonb_build_object('subscriptionSelections', selections.valid) ELSE '{}'::jsonb END
    || CASE WHEN selections.withheld AND (result IS NULL OR (result->>'verified')::boolean) THEN
      jsonb_build_object('verification', jsonb_build_object('status','failed','code','destination_binding_invalid','field','subscriptionSelections'))
      ELSE '{}'::jsonb END
    || CASE WHEN pins.withheld AND (result IS NULL OR (result->>'verified')::boolean) THEN
      jsonb_build_object('verification', jsonb_build_object('status', 'failed', 'code', 'destination_binding_invalid', 'field', 'orderBindings'))
      ELSE '{}'::jsonb END ORDER BY snapshot_ref), '[]'::jsonb)
    FROM verified v CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('orderId', b.order_id, 'selection', b.selection, 'service', b.service)
        ORDER BY b.order_id) FILTER (WHERE pin.valid) AS valid, bool_or(NOT pin.valid) AS withheld
      FROM public.commerce_destination_v2_order_bindings b JOIN public.commerce_orders o ON o.id = b.order_id
      CROSS JOIN LATERAL (SELECT coalesce(o.client_id = v.client_id AND (v.result->>'verified')::boolean AND
        public.commerce_destination_v2_valid_pins(b.selection, b.service, v.scope_ref), false) AS valid) pin
      WHERE b.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND b.selection IS NULL AND b.service IS NULL)
    ) pins CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('subscriptionId', s.subscription_id, 'selectionRevision', s.selection_revision, 'service', s.service)
        ORDER BY s.subscription_id) FILTER (WHERE pin.valid) AS valid, bool_or(NOT pin.valid) AS withheld
      FROM public.subscription_destination_v2_selections s JOIN public.subscriptions sub ON sub.id = s.subscription_id
      CROSS JOIN LATERAL (SELECT coalesce(sub.client_id = v.client_id AND s.subscription_id = v.scope_ref AND v.purpose IS NULL
        AND (v.result->>'verified')::boolean AND s.selection_revision IS NOT NULL
        AND public.subscription_destination_v2_service_valid(s.service), false) AS valid) pin
      WHERE s.snapshot_ref = v.snapshot_ref AND NOT (v.evidence_disposition = 'erased' AND s.selection_revision IS NULL AND s.service IS NULL)
    ) selections)
    || CASE WHEN EXISTS (
      SELECT 1 FROM public.commerce_orders o
      JOIN public.commerce_destination_v2_order_bindings b ON b.order_id = o.id
      JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref = b.snapshot_ref
      WHERE o.client_id = p_client_id AND d.client_id <> p_client_id
    ) THEN '[{"verification":{"status":"failed","code":"destination_binding_invalid","field":"orderBindings"}}]'::jsonb
    ELSE '[]'::jsonb END
    || CASE WHEN EXISTS (
      SELECT 1 FROM public.subscriptions sub
      JOIN public.subscription_destination_v2_selections s ON s.subscription_id = sub.id
      JOIN public.commerce_destination_v2_documents d ON d.snapshot_ref = s.snapshot_ref
      WHERE sub.client_id = p_client_id AND d.client_id <> p_client_id
    ) THEN '[{"verification":{"status":"failed","code":"destination_binding_invalid","field":"subscriptionSelections"}}]'::jsonb
    ELSE '[]'::jsonb END);
END;
$$;
