-- Correct consumed recovery-token visibility in support.customer_360.v2.
--
-- THIS FORWARD REPLACES the portable journey reader so a recovery token is
-- available only while its commerce order remains pending_payment. Portable
-- tokens record no used_at; settled or otherwise transitioned orders are the
-- durable consumed-token evidence already used by token inspection. It also
-- reads only customer-directed notices for the two returned delivery statuses
-- and gives simultaneous audit facts a semantic tie-break before their random
-- UUIDs so the contract array is deterministic.
--
-- PRESERVED: the v2 shape, journey evidence, token expiry/revocation checks,
-- existing function identity and ACLs. This creates no table, trigger or
-- projector and leaves historical migration bytes unchanged.
CREATE OR REPLACE FUNCTION public.customer_support_journey(p_operator_id uuid, p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);

  SELECT jsonb_build_object(
    'contractVersion', 'support.customer_360.v2',
    'lookup', jsonb_build_object(
      'query', client_row.id::text,
      'matchedBy', 'subject_id',
      'confidence', 'exact',
      'warnings', '[]'::jsonb
    ),
    'subject', jsonb_build_object(
      'subjectId', client_row.id,
      'displayName', NULLIF(btrim(concat_ws(' ', client_row.first_name, client_row.last_name)), ''),
      'email', CASE WHEN client_row.email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        THEN lower(client_row.email) ELSE NULL END,
      'lifecycleStage', client_row.lifecycle_stage,
      'lifecycle', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'stage', lifecycle_row.to_stage,
          'enteredAt', lifecycle_row.occurred_at,
          'exitedAt', lifecycle_row.exited_at
        ) ORDER BY lifecycle_row.occurred_at, lifecycle_row.id)
        FROM (
          SELECT event_row.id, event_row.to_stage, event_row.occurred_at,
            lead(event_row.occurred_at) OVER (ORDER BY event_row.occurred_at, event_row.id) AS exited_at
          FROM public.customer_subject_lifecycle_events AS event_row
          WHERE event_row.client_id = client_row.id
        ) AS lifecycle_row
      ), '[]'::jsonb),
      'firstSeenAt', client_row.created_at,
      'lastActivityAt', GREATEST(
        client_row.updated_at,
        COALESCE((SELECT max(order_row.updated_at) FROM public.commerce_orders AS order_row
          WHERE order_row.client_id = client_row.id), client_row.updated_at),
        COALESCE((SELECT max(subscription_row.updated_at) FROM public.subscriptions AS subscription_row
          WHERE subscription_row.client_id = client_row.id), client_row.updated_at),
        COALESCE((SELECT max(case_row.updated_at) FROM public.subscription_dunning_cases AS case_row
          WHERE case_row.client_id = client_row.id), client_row.updated_at),
        COALESCE((SELECT max(audit_row.occurred_at) FROM public.customer_support_audit_events AS audit_row
          WHERE audit_row.client_id = client_row.id), client_row.updated_at)
      )
    ),
    'orders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'orderId', order_row.id,
        'orderNumber', NULL,
        'status', order_row.status,
        'subscriptionId', subscription_row.id,
        'totalMinor', order_row.total_amount_minor,
        'currency', order_row.currency_code,
        'createdAt', order_row.created_at
      ) ORDER BY order_row.created_at DESC, order_row.id)
      FROM public.commerce_orders AS order_row
      LEFT JOIN public.subscription_cycles AS cycle_row ON cycle_row.id = order_row.subscription_cycle_id
      LEFT JOIN public.subscriptions AS subscription_row ON subscription_row.id = cycle_row.subscription_id
      WHERE order_row.client_id = client_row.id
    ), '[]'::jsonb),
    'subscriptions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'subscriptionId', subscription_row.id,
        'status', subscription_row.status,
        'nextCycleAt', subscription_row.next_cycle_at,
        'latestOrderId', (
          SELECT order_row.id FROM public.subscription_cycles AS cycle_row
          JOIN public.commerce_orders AS order_row ON order_row.subscription_cycle_id = cycle_row.id
          WHERE cycle_row.subscription_id = subscription_row.id
          ORDER BY order_row.created_at DESC, order_row.id DESC LIMIT 1
        )
      ) ORDER BY subscription_row.created_at DESC, subscription_row.id)
      FROM public.subscriptions AS subscription_row
      WHERE subscription_row.client_id = client_row.id
    ), '[]'::jsonb),
    'payment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'orderId', order_row.id,
        'status', intent_row.status,
        'recoverable', client_row.lifecycle_stage = 'customer'
          AND order_row.status = 'pending_payment' AND EXISTS (
          SELECT 1 FROM public.subscription_dunning_cases AS case_row
          WHERE case_row.client_id = client_row.id
            AND case_row.cycle_id = order_row.subscription_cycle_id
            AND case_row.status = 'open'
        ),
        'amountMinor', intent_row.amount_minor,
        'currency', intent_row.currency_code,
        'lastAttemptAt', (
          SELECT max(transition_row.occurred_at)
          FROM public.commerce_settlement_transitions AS transition_row
          WHERE transition_row.intent_id = intent_row.id
        )
      ) ORDER BY intent_row.updated_at DESC, intent_row.id)
      FROM public.commerce_settlement_intents AS intent_row
      JOIN public.commerce_orders AS order_row ON order_row.id = intent_row.order_id
      WHERE order_row.client_id = client_row.id
    ), '[]'::jsonb),
    'dunningCases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'caseId', case_row.id,
        'subscriptionId', case_row.subscription_id,
        'orderId', order_evidence.id,
        'status', case_row.status,
        'retryAttempt', case_row.retry_attempt,
        'nextRetryAt', case_row.next_retry_at,
        'notificationStatus', notice_evidence.status,
        'recoveryAvailable', client_row.lifecycle_stage = 'customer'
          AND case_row.status = 'open'
          AND order_evidence.status = 'pending_payment'
      ) ORDER BY case_row.opened_at DESC, case_row.id)
      FROM public.subscription_dunning_cases AS case_row
      LEFT JOIN LATERAL (
        SELECT order_row.id, order_row.status
        FROM public.commerce_orders AS order_row
        WHERE order_row.subscription_cycle_id = case_row.cycle_id
          AND order_row.client_id = client_row.id
        ORDER BY order_row.created_at DESC, order_row.id DESC LIMIT 1
      ) AS order_evidence ON true
      LEFT JOIN LATERAL (
        SELECT notice_row.status
        FROM public.subscription_dunning_notifications AS notice_row
        WHERE notice_row.case_id = case_row.id
          AND notice_row.recipient_kind = 'customer'
        ORDER BY notice_row.created_at DESC, notice_row.id DESC LIMIT 1
      ) AS notice_evidence ON true
      WHERE case_row.client_id = client_row.id
    ), '[]'::jsonb),
    'recovery', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'caseId', case_row.id,
        'status', CASE WHEN EXISTS (
          SELECT 1
          FROM public.commerce_checkout_recovery_tokens AS token_row
          JOIN public.commerce_orders AS token_order ON token_order.id = token_row.order_id
          WHERE token_order.subscription_cycle_id = case_row.cycle_id
            AND token_order.status = 'pending_payment'
            AND token_row.client_id = client_row.id
            AND token_row.revoked_at IS NULL
            AND token_row.expires_at > now()
        ) THEN 'available' ELSE 'unavailable' END,
        'actionAvailable', client_row.lifecycle_stage = 'customer'
          AND case_row.status = 'open' AND EXISTS (
          SELECT 1 FROM public.commerce_orders AS order_row
          WHERE order_row.subscription_cycle_id = case_row.cycle_id
            AND order_row.client_id = client_row.id
            AND order_row.status = 'pending_payment'
        ),
        'lastIssuedAt', recovery_evidence.created_at,
        'lastDeliveryStatus', recovery_evidence.status
      ) ORDER BY case_row.opened_at DESC, case_row.id)
      FROM public.subscription_dunning_cases AS case_row
      LEFT JOIN LATERAL (
        SELECT notice_row.created_at, notice_row.status
        FROM public.subscription_dunning_notifications AS notice_row
        WHERE notice_row.case_id = case_row.id
          AND notice_row.notification_kind = 'payment_recovery'
          AND notice_row.recipient_kind = 'customer'
        ORDER BY notice_row.created_at DESC, notice_row.id DESC LIMIT 1
      ) AS recovery_evidence ON true
      WHERE case_row.client_id = client_row.id
    ), '[]'::jsonb),
    'auditTrail', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'eventId', audit.event_id,
        'occurredAt', audit.occurred_at,
        'action', audit.action,
        'outcome', audit.outcome,
        'entity', jsonb_build_object('kind', audit.entity_kind, 'id', audit.entity_id)
      ) ORDER BY audit.occurred_at DESC, audit.sort_priority DESC, audit.event_id DESC)
      FROM (
        SELECT lifecycle_row.id AS event_id, lifecycle_row.occurred_at,
          'lifecycle.' || lifecycle_row.to_stage AS action, 'recorded' AS outcome,
          'subject' AS entity_kind, lifecycle_row.client_id AS entity_id,
          10 AS sort_priority
        FROM public.customer_subject_lifecycle_events AS lifecycle_row
        WHERE lifecycle_row.client_id = client_row.id
        UNION ALL
        SELECT event_row.id, event_row.occurred_at, left(event_row.event_type, 120), 'recorded',
          'subscription', event_row.subscription_id, 20
        FROM public.subscription_events AS event_row
        JOIN public.subscriptions AS subscription_row ON subscription_row.id = event_row.subscription_id
        WHERE subscription_row.client_id = client_row.id
        UNION ALL
        SELECT transition_row.id, transition_row.occurred_at,
          'payment.' || transition_row.outcome, transition_row.to_status,
          'order', intent_row.order_id,
          CASE transition_row.outcome WHEN 'failed' THEN 40 WHEN 'opened' THEN 25 ELSE 35 END
        FROM public.commerce_settlement_transitions AS transition_row
        JOIN public.commerce_settlement_intents AS intent_row ON intent_row.id = transition_row.intent_id
        JOIN public.commerce_orders AS order_row ON order_row.id = intent_row.order_id
        WHERE order_row.client_id = client_row.id
        UNION ALL
        SELECT case_row.id, case_row.opened_at, 'dunning.' || case_row.status, case_row.status,
          'dunning_case', case_row.id, 30
        FROM public.subscription_dunning_cases AS case_row
        WHERE case_row.client_id = client_row.id
        UNION ALL
        SELECT audit_row.id, audit_row.occurred_at, audit_row.event_type, audit_row.outcome,
          'recovery', audit_row.case_id, 50
        FROM public.customer_support_audit_events AS audit_row
        WHERE audit_row.client_id = client_row.id AND audit_row.case_id IS NOT NULL
      ) AS audit
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.clients AS client_row
  WHERE client_row.id = p_client_id;

  RETURN v_result;
END;
$$;
