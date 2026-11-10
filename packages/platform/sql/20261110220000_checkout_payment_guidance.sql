-- One statement owns checkout status, authority and bounded native evidence.
CREATE FUNCTION public.commerce_checkout_payment_guidance_snapshot(
 p_order_id uuid,p_payment_intent_id uuid,p_recovery_token_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
WITH current_state AS MATERIALIZED (
 SELECT o.id AS order_id,o.client_id,o.status AS order_status,i.id AS intent_id,i.status AS intent_status,
  i.channel_key,i.updated_at,i.failure_reason,i.amount_minor,i.currency_code,
  a.id AS attempt_id,a.state AS attempt_state,activation.state AS activation_state,
  s.id AS subscription_id,s.status AS subscription_status,gap.paid_at,gap.order_id IS NOT NULL AS has_exact_gap,
  CASE WHEN activation.id IS NOT NULL OR o.subscription_cycle_id IS NOT NULL THEN 'subscription_cycle' ELSE 'one_time' END AS order_mode,
  COALESCE(o.client_id IS NOT NULL AND o.subscription_cycle_id IS NULL
   AND EXISTS(SELECT 1 FROM public.commerce_order_draft_receipts r WHERE r.order_id=o.id)
   AND jsonb_typeof(o.metadata->'quoteSnapshot')='object'
   AND jsonb_typeof(o.metadata->'orderDraftSnapshot')='object'
   AND i.amount_minor=o.total_amount_minor AND i.currency_code=o.currency_code
   AND (a.id IS NULL OR (a.state='dispatched' AND a.last_observation_id IS NULL) OR current_observation.id IS NOT NULL)
   AND ((activation.id IS NULL AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='one_time')
     OR (activation.id IS NOT NULL AND activation.client_id=o.client_id
       AND o.metadata#>>'{quoteSnapshot,quote,context,mode}'='subscription')),false) AS eligible,
  COALESCE(t.id IS NOT NULL AND t.revoked_at IS NULL AND t.expires_at>statement_timestamp()
   AND o.status='pending_payment' AND o.subscription_cycle_id IS NULL,false) AS token_authorized
 FROM public.commerce_orders o JOIN public.commerce_settlement_intents i ON i.order_id=o.id
 LEFT JOIN public.payment_simulator_attempts a ON a.settlement_intent_id=i.id AND a.is_active
 LEFT JOIN public.payment_simulator_observations current_observation ON current_observation.id=a.last_observation_id
  AND current_observation.attempt_id=a.id AND current_observation.outcome=a.state
 LEFT JOIN public.subscription_activations activation ON activation.order_id=o.id
 LEFT JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id
 LEFT JOIN public.subscriptions s ON s.id=COALESCE(activation.subscription_id,cycle.subscription_id) AND s.client_id=o.client_id
 LEFT JOIN public.subscription_paid_activation_gaps gap ON gap.order_id=o.id AND gap.settlement_intent_id=i.id AND gap.client_id=o.client_id
 LEFT JOIN public.commerce_checkout_recovery_tokens t ON t.id=p_recovery_token_id AND t.order_id=o.id AND t.client_id=o.client_id
 WHERE o.id=p_order_id AND i.id=p_payment_intent_id
), observed_success AS MATERIALIZED (
 -- Captured observation is a durable success fact, not a settlement assertion.
 SELECT EXISTS(SELECT 1 FROM public.payment_simulator_attempts a
  JOIN current_state cs ON cs.intent_id=a.settlement_intent_id
  JOIN public.payment_simulator_observations e ON e.attempt_id=a.id WHERE e.outcome='captured') AS present
), bounded_history AS MATERIALIZED (
 SELECT a.id,a.state,a.dispatched_at,a.last_observation_id,a.settlement_intent_id,cs.amount_minor,cs.currency_code
 FROM public.payment_simulator_attempts a JOIN current_state cs ON cs.intent_id=a.settlement_intent_id
 ORDER BY a.dispatched_at DESC,a.id DESC LIMIT 101
), history AS MATERIALIZED (
 SELECT * FROM bounded_history ORDER BY dispatched_at DESC,id DESC LIMIT 100
), projected_history AS (
 SELECT a.id,a.state,a.dispatched_at,evidence.complete,
  CASE WHEN evidence.complete AND NOT success.present THEN evidence.items ELSE '[]'::jsonb END AS evidence
 FROM history a CROSS JOIN observed_success success CROSS JOIN LATERAL (
  SELECT count(*)<=32 AND COALESCE(bool_and(b.valid IS TRUE),true)
   AND ((a.state='dispatched' AND a.last_observation_id IS NULL) OR EXISTS(SELECT 1 FROM public.payment_simulator_observations last
    WHERE last.id=a.last_observation_id AND last.attempt_id=a.id AND last.outcome=a.state)) AS complete,
   COALESCE(jsonb_agg(jsonb_build_object('version',1,'source',b.source,'sourceId',b.id,
    'paymentAttemptId',a.id,'paymentIntentId',a.settlement_intent_id,'observationId',b.observation_id,
    'outcome',b.outcome,'refusalVerified',b.outcome='refused') ORDER BY b.at DESC,b.source,b.id)
    FILTER(WHERE b.valid),'[]'::jsonb) AS items
  FROM (
   SELECT e.* FROM (
    SELECT o.id,o.id AS observation_id,'observation'::text AS source,o.occurred_at AS at,o.outcome,
     octet_length(to_jsonb(o)::text)<=8192 AS valid
    FROM public.payment_simulator_observations o WHERE o.attempt_id=a.id
    UNION ALL
    SELECT t.id,o.id,'event',t.occurred_at,t.outcome,
     octet_length(t.source_evidence::text)<=8192 AND t.amount_minor=a.amount_minor AND t.currency_code=a.currency_code
      AND t.source_evidence->>'payloadFingerprint'=o.event_fingerprint
      AND t.source_evidence->>'observedStatus'=o.outcome
      AND CASE WHEN pg_input_is_valid(t.source_evidence->>'observedAt','timestamptz')
        THEN (t.source_evidence->>'observedAt')::timestamptz=o.occurred_at ELSE false END
      AND t.occurred_at=o.occurred_at AND t.outcome=CASE WHEN o.outcome='expired' THEN 'refused' ELSE o.outcome END
    FROM public.payment_truth_events t JOIN public.payment_simulator_observations o
     ON t.source_evidence->>'sourceReference'=o.id::text AND o.attempt_id=a.id
    WHERE t.settlement_intent_id=a.settlement_intent_id AND t.source_evidence->>'attemptRef'=a.id::text
     AND t.source_evidence->>'sourceKind' IN ('accepted_event','reconciliation_read')
    UNION ALL
    SELECT r.id,o.id,'reconciliation',r.occurred_at,r.outcome,
     octet_length(r.source_evidence::text)<=8192 AND r.evidence_status='observed'
      AND t.amount_minor=a.amount_minor AND t.currency_code=a.currency_code
      AND r.source_evidence->>'payloadFingerprint'=o.event_fingerprint
      AND r.source_evidence->>'observedStatus'=o.outcome
      AND CASE WHEN pg_input_is_valid(r.source_evidence->>'observedAt','timestamptz')
        THEN (r.source_evidence->>'observedAt')::timestamptz=o.occurred_at ELSE false END
      AND r.occurred_at=o.occurred_at AND r.outcome=CASE WHEN o.outcome='expired' THEN 'refused' ELSE o.outcome END
    FROM public.payment_truth_reconciliation_evidence r JOIN public.payment_truth_events t ON t.id=r.event_id
    JOIN public.payment_simulator_observations o ON r.source_evidence->>'sourceReference'=o.id::text AND o.attempt_id=a.id
    WHERE t.settlement_intent_id=a.settlement_intent_id AND r.source_evidence->>'attemptRef'=a.id::text
     AND r.source_evidence->>'sourceKind'='reconciliation_read'
   ) e ORDER BY e.at DESC,e.source,e.id LIMIT 33
  ) b
 ) evidence
)
SELECT CASE WHEN cs.channel_key<>'sandbox' THEN jsonb_build_object('refusal','native_prepared_attempt_store_unsupported')
 ELSE jsonb_build_object('snapshot',jsonb_build_object(
  'orderId',cs.order_id,'clientId',cs.client_id,'orderStatus',cs.order_status,
  'paymentIntentId',cs.intent_id,'intentStatus',cs.intent_status,'paymentAttemptId',cs.attempt_id,'attemptStatus',cs.attempt_state,
  'provider',cs.channel_key,'providerPaymentId',NULL,'updatedAt',cs.updated_at,'failureReason',cs.failure_reason,
  'orderMode',cs.order_mode,'activationState',cs.activation_state,'subscriptionId',cs.subscription_id,
  'subscriptionStatus',cs.subscription_status,'paidAt',cs.paid_at,'hasExactGap',cs.has_exact_gap),
  'eligible',cs.eligible,'tokenAuthorized',cs.token_authorized,'observedSuccess',success.present,
  'historyComplete',(SELECT count(*)<=100 FROM bounded_history) AND COALESCE((SELECT bool_and(complete) FROM projected_history),true),
  'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'status',h.state,'provider',cs.channel_key,
    'providerPaymentId',NULL,'providerFlow',NULL,'createdAt',h.dispatched_at,'evidence',h.evidence)
    ORDER BY h.dispatched_at DESC,h.id DESC) FROM projected_history h),'[]'::jsonb)) END
FROM current_state cs CROSS JOIN observed_success success;
$$;
REVOKE ALL ON FUNCTION public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid) FROM anon';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid) FROM authenticated';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid) FROM service_role';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid) TO service_role';
END IF; END; $$;
