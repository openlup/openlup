-- Managed M07 refund parity: restricted provider refund evidence reader.
-- Stripe cumulative maxima remain distinct from original payment amounts;
-- other existing providers retain additive event semantics. No backfill.

CREATE FUNCTION public.commerce_order_provider_refund_evidence(p_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  WITH candidates AS (
    SELECT e.*, pi.amount_cents AS original_amount, pi.currency AS intent_currency,
           a.provider AS attempt_provider, a.provider_attempt_id,
           a.payment_intent_id AS attempt_intent_id,
           CASE WHEN jsonb_typeof(e.payload #> '{stripeRefundSnapshot,amountRefundedMinor}') = 'number'
                  AND (e.payload #>> '{stripeRefundSnapshot,amountRefundedMinor}') ~ '^[0-9]{1,10}$'
                THEN (e.payload #>> '{stripeRefundSnapshot,amountRefundedMinor}')::bigint END AS snapshot
      FROM public.inbound_provider_events e
      JOIN public.commerce_payment_intents pi ON pi.id = e.payment_intent_id
      LEFT JOIN public.commerce_payment_attempts a ON a.id = e.payment_attempt_id
     WHERE pi.order_id = p_order_id AND e.event_type = 'payment.refunded'
       AND e.amount_cents IS NOT NULL
  ), evidence AS (
    SELECT provider, provider_event_id, currency, received_at, created_at, id,
           original_amount, CASE WHEN provider = 'stripe' THEN snapshot ELSE amount_cents END AS refund_cents,
           CASE WHEN provider = 'stripe' THEN payment_intent_id::text || ':' || provider_payment_id
                  || ':' || (payload #>> '{stripeRefundSnapshot,chargeId}') ELSE id::text END AS identity
      FROM candidates
     WHERE provider <> 'stripe' OR (
       processing_status IN ('processed', 'ignored') AND signature_verified
       AND attempt_provider = 'stripe' AND attempt_intent_id = payment_intent_id
       AND provider_attempt_id = provider_payment_id
       AND payload ->> 'eventType' = 'charge.refunded'
       AND payload ->> 'providerPaymentId' = provider_payment_id
       AND NULLIF(btrim(payload #>> '{stripeRefundSnapshot,chargeId}'), '') IS NOT NULL
       AND amount_cents = original_amount AND currency = intent_currency
       AND snapshot > 0 AND snapshot <= original_amount
     )
  ), amounts AS (
    SELECT provider, identity, currency, max(refund_cents) AS refund_cents, max(original_amount) AS original_amount
      FROM evidence GROUP BY provider, identity, currency
  )
  SELECT CASE WHEN count(DISTINCT currency) = 1 AND NOT bool_or(currency IS NULL)
    AND bool_and(provider <> 'stripe' OR refund_cents = original_amount)
    THEN jsonb_build_object('refundCents', sum(refund_cents), 'currency', min(currency),
      'refundEvidenceVersion', 'provider-refund.v2',
      'providerEventIds', (SELECT jsonb_agg(provider_event_id ORDER BY received_at, created_at, id) FROM evidence),
      'amountSource', CASE WHEN bool_or(provider = 'stripe')
        THEN 'inbound_provider_events.provider_refund_evidence'
        ELSE 'inbound_provider_events.amount_cents_sum_same_currency' END)
    ELSE NULL END FROM amounts;
$$;
REVOKE ALL ON FUNCTION public.commerce_order_provider_refund_evidence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_order_provider_refund_evidence(uuid) TO service_role;
