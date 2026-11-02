-- Close a machine-placed hold when the order it guards is closed.
--
-- The managed schema and this kernel both let a hold created without an actor
-- outlive its own order. Nothing on either side ends such a hold once the order
-- reaches a closed status: the recovery paths refuse a closed order on purpose,
-- and the operator queue stops evaluating it. The hold stays 'active' with no
-- way out, while a counter that reads holds directly keeps reporting it.
--
-- Authored for this kernel against the observable behaviour the managed forward
-- 20260824130000 ships, not copied from it. Named departures, in full:
--   * one function, not two. The managed side needs a separate release entry
--     point because its human release is a security boundary that raises on a
--     null actor; this kernel creates no roles and no function here is a
--     security boundary, so the closure is written once, inline in the trigger;
--   * no SECURITY DEFINER, no GRANT, no REVOKE, per this kernel's standing
--     rule. SET search_path is kept, because that hardening does not depend on
--     a role model;
--   * the operations row carries actor_id NULL and the same source token, which
--     is what makes a machine closure distinguishable from an operator release
--     in the ledger both bundles are compared on.
--
-- WHY A TRIGGER. Four functions on this kernel move an order to a closed
-- status and thirteen do on the managed schema. A closure written at each call
-- site is incomplete the moment a fifth is added; a trigger on the order row is
-- not. The WHEN clause keeps ordinary order updates free.

CREATE FUNCTION public.oms_close_holds_on_closed_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_hold public.commerce_order_holds%ROWTYPE;
  v_key text;
BEGIN
  FOR v_hold IN
    SELECT * FROM public.commerce_order_holds
     WHERE order_id = NEW.id
       AND status = 'active'
       AND created_by IS NULL
     ORDER BY id
  LOOP
    v_key := 'order-closed:' || v_hold.id::text || ':operation';

    -- The operation row is both the idempotency ledger and the attribution
    -- record. ON CONFLICT DO NOTHING makes a replay silent rather than fatal:
    -- this runs inside the closing transaction and must never abort it.
    INSERT INTO public.commerce_order_operations
      (order_id, hold_id, actor_id, operation_type, source, idempotency_key, payload, occurred_at)
    VALUES (
      v_hold.order_id,
      v_hold.id,
      NULL,
      'hold_released',
      'commerce.order.terminal_closure',
      v_key,
      jsonb_build_object(
        'autoReleased', true,
        'autoReleaseSource', 'commerce.order.terminal_closure',
        'autoReleaseProof', 'order_closed',
        'closedOrderStatus', NEW.status
      ),
      now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE public.commerce_order_holds
       SET status = 'released',
           released_at = now(),
           released_by = NULL,
           updated_at = now(),
           metadata = metadata || jsonb_build_object(
             'autoReleased', true,
             'autoReleaseSource', 'commerce.order.terminal_closure',
             'autoReleaseProof', 'order_closed',
             'closedOrderStatus', NEW.status
           )
     WHERE id = v_hold.id
       AND status = 'active';
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.oms_close_holds_on_closed_order() IS
  'Closes every machine-placed active hold on an order that has just moved to a closed status. Never touches a hold an operator placed: created_by is the one field a caller cannot supply.';

DROP TRIGGER IF EXISTS trg_oms_close_holds_on_closed_order ON public.commerce_orders;
CREATE TRIGGER trg_oms_close_holds_on_closed_order
AFTER UPDATE OF status ON public.commerce_orders
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('cancelled', 'refunded'))
EXECUTE FUNCTION public.oms_close_holds_on_closed_order();
