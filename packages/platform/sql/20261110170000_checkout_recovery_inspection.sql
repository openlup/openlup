-- Read-only checkout recovery inspection and nullable recovery lineage.
-- Historical orders remain unlinked. Expired inspection grants no payment authority.
ALTER TABLE public.commerce_orders
  ADD COLUMN recovery_root_order_id uuid,
  ADD COLUMN recreated_from_order_id uuid;
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_recovery_root_order_id_fkey
  FOREIGN KEY (recovery_root_order_id) REFERENCES public.commerce_orders(id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_recreated_from_order_id_fkey
  FOREIGN KEY (recreated_from_order_id) REFERENCES public.commerce_orders(id)
  ON DELETE RESTRICT NOT VALID;
CREATE INDEX idx_commerce_orders_recovery_root_created
  ON public.commerce_orders (recovery_root_order_id, created_at DESC)
  WHERE recovery_root_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_commerce_orders_one_replacement_per_source
  ON public.commerce_orders (recreated_from_order_id)
  WHERE recreated_from_order_id IS NOT NULL;
CREATE FUNCTION public.commerce_checkout_recovery_order_snapshot(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'orderId',o.id,'orderRef','order_'||o.id::text,'orderNumber',o.id::text,
    'clientId',o.client_id,'status',o.status,
    'mode',CASE WHEN o.subscription_cycle_id IS NOT NULL OR a.id IS NOT NULL
      OR COALESCE(o.metadata#>>'{orderDraftSnapshot,context,mode}',o.metadata#>>'{quoteSnapshot,quote,context,mode}')='subscription'
      THEN 'subscription_cycle' ELSE 'one_time_order' END,
    'totalMinor',o.total_amount_minor,'currency',o.currency_code,'createdAt',o.created_at,
    'cadenceDays',a.cadence_days,'customerEmail',buyer.value->>'email','customerName',buyer.value->>'name',
    'paymentIntentId',CASE WHEN i.status<>'settled' THEN i.id END,
    'paymentIntentStatus',CASE i.status WHEN 'created' THEN 'pending' WHEN 'settled' THEN 'succeeded' ELSE i.status END,
    'subscriptionId',COALESCE(cycle.subscription_id,a.subscription_id),
    'subscriptionCycleId',o.subscription_cycle_id,'initialDeclarationId',a.id,'initialActivationState',a.state,
    'shippingAddressId',d.id,'quoteSnapshot',o.metadata->'quoteSnapshot',
    'runtimeMetadata',COALESCE(o.metadata->'runtimeFinalize','{}'::jsonb),
    'invoiceBuyerSnapshot',buyer.value,
    'recoveryRootOrderId',COALESCE(o.recovery_root_order_id,o.id),'recreatedFromOrderId',o.recreated_from_order_id,
    'technicallyExpired',CASE
      WHEN o.status='expired' THEN o.metadata->>'paymentStatus'='expired' AND o.metadata->>'source'='checkout_reservation_expiry'
      WHEN o.status='pending_payment' THEN o.metadata->>'paymentStatus'='expired'
      WHEN o.status='cancelled' THEN o.metadata->>'subscriptionActivation'='abandoned'
        AND o.metadata->>'source'='initial_checkout_sweep' AND o.metadata->>'paymentStatus'='cancelled'
        AND a.state='compensated'
      ELSE false END)
  FROM public.commerce_orders o
  JOIN public.clients c ON c.id=o.client_id
  LEFT JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(o.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}')='object'
      AND o.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}'<>'{}'::jsonb
    THEN o.metadata#>'{runtimeFinalize,invoiceBuyerSnapshot}' ELSE COALESCE(o.metadata->'invoiceBuyerSnapshot','{}'::jsonb) END AS value) buyer ON true
  LEFT JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id
  LEFT JOIN public.subscription_activations a ON a.order_id=o.id AND a.client_id=o.client_id
  LEFT JOIN public.commerce_settlement_intents i ON i.order_id=o.id
  LEFT JOIN public.commerce_destination_bindings b ON b.order_id=o.id
  LEFT JOIN public.commerce_destinations d ON d.id=b.destination_id AND d.client_id=o.client_id
  WHERE o.id=p_order_id
$$;
CREATE FUNCTION public.commerce_checkout_recovery_latest_order_snapshot(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.commerce_checkout_recovery_order_snapshot(COALESCE(
    (SELECT descendant.id FROM public.commerce_orders descendant
     WHERE descendant.recovery_root_order_id=COALESCE(original.recovery_root_order_id,original.id)
     ORDER BY descendant.created_at DESC LIMIT 1),original.id))
  FROM public.commerce_orders original WHERE original.id=p_order_id
$$;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_order_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_latest_order_snapshot(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_order_snapshot(uuid), public.commerce_checkout_recovery_latest_order_snapshot(uuid) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_order_snapshot(uuid), public.commerce_checkout_recovery_latest_order_snapshot(uuid) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_recovery_order_snapshot(uuid), public.commerce_checkout_recovery_latest_order_snapshot(uuid) FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_order_snapshot(uuid), public.commerce_checkout_recovery_latest_order_snapshot(uuid) TO service_role';
END IF; END; $$;
