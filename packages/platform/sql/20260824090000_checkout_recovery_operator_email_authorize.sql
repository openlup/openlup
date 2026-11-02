-- Admit the operator-issued checkout recovery link to send-time authorization.
--
-- THIS FORWARD REPLACES public.commerce_checkout_reminder_delivery_authorize so
-- that a `commerce.checkout_recovery` event whose idempotency key begins
-- `checkout_recovery:operator:` is judged as what it is: a link a human minted on
-- the operator surface for a customer who could not pay, not a cron nudge for an
-- order still sitting in checkout. Two refusals the cron branch owns are wrong for
-- it and would make it a SILENT no-send. First, the shared precondition
-- `status = 'pending_payment'`: the orders an operator sends a link for have
-- usually already expired, and the redeem rail recreates such an order from its
-- frozen quote when the customer opens the link. Second, the requirement of a
-- FAILED settlement intent: that is the cron's evidence that a reminder is
-- warranted, whereas here a human has already decided.
--
-- WHAT REPLACES THEM for the operator branch: the order must exist and have a
-- client, and it must either still be `pending_payment` or carry a LIVE row in
-- public.commerce_checkout_recovery_tokens (unrevoked, not yet expired). That is
-- the same fact the redeem side reads, so this function cannot authorize a send
-- whose link the redeem side would refuse, and it refuses with its own reason,
-- `operator_checkout_recovery_link_not_live`, rather than borrowing the cron's.
--
-- PRESERVED, byte-for-byte in behavior for every event this branch does not
-- match: the claim-token check, the supported event-type list, the abandoned-cart
-- branch and its consent/receipt/intent conditions, the cron recovery branch with
-- its subscription-cycle refusal and failed-intent requirement, the
-- 'commerce-checkout-recovery' template resolution, and the authorized payload's
-- idempotencyKey / recipientReference / templateReference shape. No table, index,
-- trigger or grant is created; the function stays invoker-rights, STABLE and
-- search_path-pinned, and reads the token table without writing to it.
CREATE OR REPLACE FUNCTION public.commerce_checkout_reminder_delivery_authorize(
  p_event_id uuid,
  p_claim_token text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_event public.outbox_events%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_reason text;
  v_template text;
  v_operator boolean;
BEGIN
  SELECT * INTO v_event FROM public.outbox_events
   WHERE id = p_event_id AND status = 'processing'
     AND metadata->>'claimToken' = p_claim_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'claim_not_active');
  END IF;
  IF v_event.event_type NOT IN (
    'commerce.order_draft.abandoned.1h',
    'commerce.order_draft.abandoned.24h',
    'commerce.order_draft.abandoned.72h',
    'commerce.checkout_recovery'
  ) THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'event_type_not_supported');
  END IF;
  v_operator := v_event.event_type = 'commerce.checkout_recovery'
    AND v_event.idempotency_key LIKE 'checkout_recovery:operator:%';
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_event.aggregate_id;
  IF NOT FOUND OR v_order.client_id IS NULL
     OR (NOT v_operator AND v_order.status <> 'pending_payment') THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'order_not_recoverable');
  END IF;

  IF v_event.event_type LIKE 'commerce.order_draft.abandoned.%' THEN
    IF EXISTS (SELECT 1 FROM public.commerce_settlement_intents WHERE order_id = v_order.id)
       OR NOT EXISTS (
         SELECT 1 FROM public.commerce_order_draft_receipts AS receipt
          WHERE receipt.order_id = v_order.id AND receipt.invalidated_at IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.clients AS client
         JOIN public.customer_communication_preferences AS preference
           ON preference.principal_id = client.principal_id
          AND preference.marketing_newsletter_consent
         WHERE client.id = v_order.client_id
       ) THEN
      v_reason := 'abandoned_reminder_no_longer_allowed';
    END IF;
    v_template := replace(v_event.event_type, '.', '-');
  ELSIF v_operator THEN
    IF v_order.status <> 'pending_payment' AND NOT EXISTS (
      SELECT 1 FROM public.commerce_checkout_recovery_tokens AS token
       WHERE token.order_id = v_order.id
         AND token.revoked_at IS NULL
         AND token.expires_at > now()
    ) THEN
      v_reason := 'operator_checkout_recovery_link_not_live';
    END IF;
    v_template := 'commerce-checkout-recovery';
  ELSE
    IF v_order.subscription_cycle_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.commerce_settlement_intents
       WHERE order_id = v_order.id AND status = 'failed'
    ) THEN
      v_reason := 'checkout_recovery_no_longer_allowed';
    END IF;
    v_template := 'commerce-checkout-recovery';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', v_reason);
  END IF;
  RETURN jsonb_build_object(
    'authorized', true,
    'idempotencyKey', 'checkout-reminder:' || v_event.id,
    'recipientReference', v_order.client_id,
    'templateReference', v_template
  );
END;
$$;
