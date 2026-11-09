-- Checkout links coexist until expiry or the order leaves pending payment.
-- Case links still rotate, serialized on the pending order before revocation.
DROP INDEX public.commerce_checkout_recovery_tokens_active_order_idx;

CREATE INDEX commerce_checkout_recovery_tokens_order_created_idx
  ON public.commerce_checkout_recovery_tokens (order_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_issue_recovery_token(
  p_case_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_order_id uuid;
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;

  SELECT o.id INTO v_order_id
  FROM public.commerce_orders AS o
  WHERE o.subscription_cycle_id = v_case.cycle_id
    AND o.status = 'pending_payment'
  ORDER BY o.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'refused', 'recoverable_order_unavailable');
  END IF;

  UPDATE public.commerce_checkout_recovery_tokens
  SET revoked_at = now()
  WHERE order_id = v_order_id AND revoked_at IS NULL;

  INSERT INTO public.commerce_checkout_recovery_tokens (
    order_id, client_id, token_hash, expires_at
  ) VALUES (v_order_id, v_case.client_id, p_token_hash, p_expires_at)
  ON CONFLICT ON CONSTRAINT commerce_checkout_recovery_tokens_token_hash_key DO NOTHING;

  RETURN jsonb_build_object('issued', true, 'orderId', v_order_id);
END;
$$;
