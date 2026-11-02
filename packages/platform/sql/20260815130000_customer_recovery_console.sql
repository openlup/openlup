-- Portable customer-360 reads and the operator recovery console.
--
-- CHANGE. This forward widens the neutral client lifecycle with the two pre-customer
-- stages the public journey must preserve, records every later lifecycle transition in an
-- append-only ledger, publishes four operator-scoped read models with separate durable read
-- audit over the facts owned by clients, orders, subscriptions, settlement and dunning, and adds one recovery
-- command. The command is an idempotent delegation to the D15 token authority; it is not a
-- second payment or dunning state machine.
--
-- SAFETY. The existing durable communications operator allowlist gates every routine. Recovery
-- serializes on the idempotency key and checks its immutable fingerprint before it locks a
-- case or calls D15. A replay returns the recorded sanitized answer. A changed fingerprint
-- conflicts. A newly accepted command may then issue exactly one token hash through
-- dunning_lifecycle_issue_recovery_token, append one payment_recovery notice, and append one
-- audit event in the same transaction. The response contains no token, token hash, recovery
-- path, delivery reference, settlement channel or external settlement reference.
--
-- AUTHORED, NOT COPIED. The public read shapes are assembled from the small neutral tables
-- already published by the platform catalogue. They do not reproduce the managed tester,
-- waitlist, payment or customer schemas. Earlier lifecycle stages are values on the same
-- subject, not parallel identities. Payment evidence is status, amount and time only; opaque
-- channel handles remain behind the settlement boundary. Every routine is invoker-rights
-- with a fixed search path, grants nothing, and every new object is revoked from PUBLIC and
-- both browser roles.

ALTER TABLE public.clients DROP CONSTRAINT clients_lifecycle_stage_check;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_lifecycle_stage_check
  CHECK (lifecycle_stage IN ('lead', 'waitlist', 'tester', 'customer', 'inactive')) NOT VALID;

-- Append-only history of the stage carried by the one neutral subject row. Existing rows
-- receive an observed entry so a freshly upgraded database has a truthful starting point.
CREATE TABLE public.customer_subject_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_subject_lifecycle_events_from_stage_check CHECK (
    from_stage IS NULL OR from_stage IN ('lead', 'waitlist', 'tester', 'customer', 'inactive')
  ),
  CONSTRAINT customer_subject_lifecycle_events_to_stage_check CHECK (
    to_stage IN ('lead', 'waitlist', 'tester', 'customer', 'inactive')
  ),
  CONSTRAINT customer_subject_lifecycle_events_transition_check
    CHECK (from_stage IS NULL OR from_stage <> to_stage)
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_subject_lifecycle_events_subject_idx
  ON public.customer_subject_lifecycle_events (client_id, occurred_at, id);

INSERT INTO public.customer_subject_lifecycle_events (client_id, from_stage, to_stage, occurred_at)
SELECT client_row.id, NULL, client_row.lifecycle_stage, client_row.created_at
FROM public.clients AS client_row;

CREATE FUNCTION public.customer_subject_capture_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.customer_subject_lifecycle_events (
      client_id, from_stage, to_stage, occurred_at
    ) VALUES (NEW.id, NULL, NEW.lifecycle_stage, COALESCE(NEW.created_at, now()));
  ELSIF NEW.lifecycle_stage IS DISTINCT FROM OLD.lifecycle_stage THEN
    INSERT INTO public.customer_subject_lifecycle_events (
      client_id, from_stage, to_stage, occurred_at
    ) VALUES (NEW.id, OLD.lifecycle_stage, NEW.lifecycle_stage, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_subject_capture_lifecycle_trigger
AFTER INSERT OR UPDATE OF lifecycle_stage ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.customer_subject_capture_lifecycle();

-- One immutable answer per recovery command. The token material is deliberately absent.
CREATE TABLE public.customer_recovery_commands (
  idempotency_key text PRIMARY KEY,
  command_fingerprint text NOT NULL,
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  client_id uuid NOT NULL,
  case_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_recovery_commands_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  CONSTRAINT customer_recovery_commands_fingerprint_check
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_recovery_commands_response_check CHECK (jsonb_typeof(response) = 'object')
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_recovery_commands_subject_idx
  ON public.customer_recovery_commands (client_id, created_at DESC);

-- Append-only operator evidence. Only neutral entity references and outcomes are retained.
CREATE TABLE public.customer_support_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  client_id uuid NOT NULL,
  case_id uuid,
  event_type text NOT NULL,
  outcome text NOT NULL,
  command_key text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_support_audit_events_type_check
    CHECK (event_type IN ('issue_recovery')),
  CONSTRAINT customer_support_audit_events_outcome_check
    CHECK (outcome IN ('issued', 'refused')),
  CONSTRAINT customer_support_audit_events_command_check
    CHECK (command_key IS NULL OR char_length(btrim(command_key)) BETWEEN 8 AND 200),
  CONSTRAINT customer_support_audit_events_command_key UNIQUE (command_key)
);

-- Separate read evidence keeps customer-360 snapshots stable across operator reads.
CREATE TABLE public.customer_support_read_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  route text NOT NULL,
  query jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_ids text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT customer_support_read_audit_route_check
    CHECK (route IN ('/api/bff/admin/clients/search', '/api/bff/admin/clients/summary',
      '/api/bff/admin/clients/detail', '/api/bff/admin/support/customer-journey'))
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX customer_support_audit_events_subject_idx
  ON public.customer_support_audit_events (client_id, occurred_at DESC, id);

-- The application connection owns these relations, so privilege revocation alone cannot
-- make a ledger append-only. This trigger refuses mutation even for that owner.
CREATE FUNCTION public.customer_support_refuse_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'customer_support_ledger_append_only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER customer_subject_lifecycle_events_append_only
BEFORE UPDATE OR DELETE ON public.customer_subject_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION public.customer_support_refuse_ledger_mutation();
CREATE TRIGGER customer_recovery_commands_append_only
BEFORE UPDATE OR DELETE ON public.customer_recovery_commands
FOR EACH ROW EXECUTE FUNCTION public.customer_support_refuse_ledger_mutation();
CREATE TRIGGER customer_support_audit_events_append_only
BEFORE UPDATE OR DELETE ON public.customer_support_audit_events
FOR EACH ROW EXECUTE FUNCTION public.customer_support_refuse_ledger_mutation();

CREATE TRIGGER customer_support_read_audit_events_append_only
BEFORE UPDATE OR DELETE ON public.customer_support_read_audit_events
FOR EACH ROW EXECUTE FUNCTION public.customer_support_refuse_ledger_mutation();

-- D15 owns the notice queue. This wave adds one kind to that same CHECK rather than
-- creating a support-owned delivery table. Each accepted non-replay uses the next attempt
-- ordinal, preserving every previous recovery notice as history.
ALTER TABLE public.subscription_dunning_notifications
  DROP CONSTRAINT subscription_dunning_notifications_kind_check;
ALTER TABLE public.subscription_dunning_notifications
  ADD CONSTRAINT subscription_dunning_notifications_kind_check
  CHECK (notification_kind IN (
    'payment_failed', 'payment_expired', 'payment_recovered', 'payment_recovery'
  )) NOT VALID;

REVOKE ALL ON TABLE
  public.customer_subject_lifecycle_events,
  public.customer_recovery_commands,
  public.customer_support_audit_events,
  public.customer_support_read_audit_events
FROM PUBLIC, anon, authenticated;

-- Portable admin summary. It counts subjects, not managed programme records.
CREATE FUNCTION public.customer_support_summary(p_operator_id uuid)
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
    'contractVersion', 'clients.customer_360.v2',
    'summary', jsonb_build_object(
      'totalSubjects', count(*)::integer,
      'byLifecycleStage', jsonb_build_object(
        'lead', count(*) FILTER (WHERE client_row.lifecycle_stage = 'lead')::integer,
        'waitlist', count(*) FILTER (WHERE client_row.lifecycle_stage = 'waitlist')::integer,
        'tester', count(*) FILTER (WHERE client_row.lifecycle_stage = 'tester')::integer,
        'customer', count(*) FILTER (WHERE client_row.lifecycle_stage = 'customer')::integer,
        'inactive', count(*) FILTER (WHERE client_row.lifecycle_stage = 'inactive')::integer
      ),
      'openDunningCases', (
        SELECT count(*)::integer FROM public.subscription_dunning_cases AS case_row
        WHERE case_row.status = 'open'
      ),
      'recoverableCases', (
        SELECT count(DISTINCT case_row.id)::integer
        FROM public.subscription_dunning_cases AS case_row
        JOIN public.commerce_orders AS order_row
          ON order_row.subscription_cycle_id = case_row.cycle_id
        WHERE case_row.status = 'open' AND order_row.status = 'pending_payment'
      ),
      'lastActivityAt', (
        SELECT max(activity.occurred_at)
        FROM (
          SELECT max(updated_at) AS occurred_at FROM public.clients
          UNION ALL SELECT max(updated_at) FROM public.subscriptions
          UNION ALL SELECT max(updated_at) FROM public.commerce_orders
          UNION ALL SELECT max(updated_at) FROM public.subscription_dunning_cases
          UNION ALL SELECT max(occurred_at) FROM public.customer_support_audit_events
        ) AS activity
      )
    )
  ) INTO v_result
  FROM public.clients AS client_row;

  RETURN v_result;
END;
$$;

-- Bounded subject search across neutral identity and durable business references.
CREATE FUNCTION public.customer_support_search(
  p_operator_id uuid,
  p_query text,
  p_page integer,
  p_page_size integer,
  p_lifecycle_stage text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
  v_page integer := COALESCE(p_page, 0);
  v_limit integer := LEAST(GREATEST(COALESCE(p_page_size, 10), 1), 100);
  v_result jsonb;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF v_query = '' OR char_length(v_query) > 320 THEN
    RAISE EXCEPTION 'customer_support_query_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_page < 0 OR COALESCE(p_lifecycle_stage, 'all') NOT IN (
    'all', 'lead', 'waitlist', 'tester', 'customer', 'inactive'
  ) THEN
    RAISE EXCEPTION 'customer_support_search_page_invalid' USING ERRCODE = '22023';
  END IF;

  WITH matched AS (
    SELECT
      client_row.*,
      CASE
        WHEN client_row.id::text = v_query THEN 'subject_id'
        WHEN lower(client_row.email) = lower(v_query) THEN 'email'
        WHEN client_row.phone = v_query THEN 'phone'
        WHEN lower(btrim(concat_ws(' ', client_row.first_name, client_row.last_name))) = lower(v_query)
          THEN 'name'
        WHEN EXISTS (
          SELECT 1 FROM public.commerce_orders AS order_row
          WHERE order_row.client_id = client_row.id AND order_row.id::text = v_query
        ) THEN 'order'
        WHEN EXISTS (
          SELECT 1 FROM public.subscriptions AS subscription_row
          WHERE subscription_row.client_id = client_row.id
            AND subscription_row.id::text = v_query
        ) THEN 'subscription'
        ELSE 'text'
      END AS matched_by,
      CASE
        WHEN client_row.id::text = v_query OR lower(client_row.email) = lower(v_query)
          OR client_row.phone = v_query
          OR EXISTS (
            SELECT 1 FROM public.commerce_orders AS order_row
            WHERE order_row.client_id = client_row.id AND order_row.id::text = v_query
          )
          OR EXISTS (
            SELECT 1 FROM public.subscriptions AS subscription_row
            WHERE subscription_row.client_id = client_row.id
              AND subscription_row.id::text = v_query
          ) THEN 'exact'
        WHEN lower(COALESCE(client_row.email, '')) LIKE lower(v_query) || '%'
          OR lower(btrim(concat_ws(' ', client_row.first_name, client_row.last_name)))
            LIKE lower(v_query) || '%' THEN 'high'
        ELSE 'medium'
      END AS confidence
    FROM public.clients AS client_row
    WHERE (COALESCE(p_lifecycle_stage, 'all') = 'all'
      OR client_row.lifecycle_stage = p_lifecycle_stage)
      AND (
        client_row.id::text = v_query
        OR lower(COALESCE(client_row.email, '')) LIKE '%' || lower(v_query) || '%'
        OR COALESCE(client_row.phone, '') LIKE '%' || v_query || '%'
        OR lower(btrim(concat_ws(' ', client_row.first_name, client_row.last_name)))
          LIKE '%' || lower(v_query) || '%'
        OR EXISTS (
          SELECT 1 FROM public.commerce_orders AS order_row
          WHERE order_row.client_id = client_row.id AND order_row.id::text = v_query
        )
        OR EXISTS (
          SELECT 1 FROM public.subscriptions AS subscription_row
          WHERE subscription_row.client_id = client_row.id
            AND subscription_row.id::text = v_query
        )
      )
  ), bounded AS (
    SELECT * FROM matched
    ORDER BY
      CASE confidence WHEN 'exact' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
      updated_at DESC,
      id
    LIMIT v_limit
    OFFSET v_page * v_limit
  )
  SELECT jsonb_build_object(
    'contractVersion', 'clients.customer_360.v2',
    'candidates', COALESCE(jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object(
        'subjectId', bounded.id,
        'displayName', NULLIF(btrim(concat_ws(' ', bounded.first_name, bounded.last_name)), ''),
        'email', CASE WHEN bounded.email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          THEN lower(bounded.email) ELSE NULL END,
        'phone', NULLIF(btrim(bounded.phone), ''),
        'lifecycleStage', bounded.lifecycle_stage,
        'createdAt', bounded.created_at,
        'lastActivityAt', GREATEST(
          bounded.updated_at,
          COALESCE((SELECT max(order_row.updated_at) FROM public.commerce_orders AS order_row
            WHERE order_row.client_id = bounded.id), bounded.updated_at),
          COALESCE((SELECT max(subscription_row.updated_at) FROM public.subscriptions AS subscription_row
            WHERE subscription_row.client_id = bounded.id), bounded.updated_at),
          COALESCE((SELECT max(case_row.updated_at) FROM public.subscription_dunning_cases AS case_row
            WHERE case_row.client_id = bounded.id), bounded.updated_at)
        )
      ),
      'matchedBy', bounded.matched_by,
      'confidence', bounded.confidence,
      'journeyLookup', jsonb_build_object('subjectId', bounded.id)
    ) ORDER BY
      CASE bounded.confidence WHEN 'exact' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
      bounded.updated_at DESC,
      bounded.id), '[]'::jsonb),
    'totalCount', (SELECT count(*)::integer FROM matched),
    'page', v_page,
    'pageSize', v_limit
  ) INTO v_result
  FROM bounded;

  RETURN v_result;
END;
$$;

-- One neutral subject with durable business references; managed facets stay overlays.
CREATE FUNCTION public.customer_support_detail(p_operator_id uuid, p_client_id uuid)
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
    'contractVersion', 'clients.customer_360.v2',
    'subject', jsonb_build_object(
      'subjectId', client_row.id,
      'displayName', NULLIF(btrim(concat_ws(' ', client_row.first_name, client_row.last_name)), ''),
      'email', CASE WHEN client_row.email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        THEN lower(client_row.email) ELSE NULL END,
      'phone', NULLIF(btrim(client_row.phone), ''),
      'lifecycleStage', client_row.lifecycle_stage,
      'createdAt', client_row.created_at,
      'lastActivityAt', GREATEST(
        client_row.updated_at,
        COALESCE((SELECT max(order_row.updated_at) FROM public.commerce_orders AS order_row
          WHERE order_row.client_id = client_row.id), client_row.updated_at),
        COALESCE((SELECT max(subscription_row.updated_at) FROM public.subscriptions AS subscription_row
          WHERE subscription_row.client_id = client_row.id), client_row.updated_at),
        COALESCE((SELECT max(case_row.updated_at) FROM public.subscription_dunning_cases AS case_row
          WHERE case_row.client_id = client_row.id), client_row.updated_at)
      )
    ),
    'references', jsonb_build_object(
      'orderIds', COALESCE((SELECT jsonb_agg(ids.id ORDER BY ids.id) FROM (
        SELECT DISTINCT order_row.id::text AS id FROM public.commerce_orders AS order_row
        WHERE order_row.client_id = client_row.id
      ) AS ids), '[]'::jsonb),
      'subscriptionIds', COALESCE((SELECT jsonb_agg(ids.id ORDER BY ids.id) FROM (
        SELECT DISTINCT subscription_row.id::text AS id FROM public.subscriptions AS subscription_row
        WHERE subscription_row.client_id = client_row.id
      ) AS ids), '[]'::jsonb),
      'dunningCaseIds', COALESCE((SELECT jsonb_agg(ids.id ORDER BY ids.id) FROM (
        SELECT DISTINCT case_row.id::text AS id FROM public.subscription_dunning_cases AS case_row
        WHERE case_row.client_id = client_row.id
      ) AS ids), '[]'::jsonb)
    ),
    'journeyLookup', jsonb_build_object('subjectId', client_row.id)
  ) INTO v_result
  FROM public.clients AS client_row
  WHERE client_row.id = p_client_id;

  RETURN v_result;
END;
$$;

-- Full provider-neutral customer journey. Settlement channel keys, external references,
-- recovery paths, hashes, queue payloads and delivery references never enter this JSON.
CREATE FUNCTION public.customer_support_journey(p_operator_id uuid, p_client_id uuid)
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
      ) ORDER BY audit.occurred_at DESC, audit.event_id DESC)
      FROM (
        SELECT lifecycle_row.id AS event_id, lifecycle_row.occurred_at,
          'lifecycle.' || lifecycle_row.to_stage AS action, 'recorded' AS outcome,
          'subject' AS entity_kind, lifecycle_row.client_id AS entity_id
        FROM public.customer_subject_lifecycle_events AS lifecycle_row
        WHERE lifecycle_row.client_id = client_row.id
        UNION ALL
        SELECT event_row.id, event_row.occurred_at, left(event_row.event_type, 120), 'recorded',
          'subscription', event_row.subscription_id
        FROM public.subscription_events AS event_row
        JOIN public.subscriptions AS subscription_row ON subscription_row.id = event_row.subscription_id
        WHERE subscription_row.client_id = client_row.id
        UNION ALL
        SELECT transition_row.id, transition_row.occurred_at,
          'payment.' || transition_row.outcome, transition_row.to_status,
          'order', intent_row.order_id
        FROM public.commerce_settlement_transitions AS transition_row
        JOIN public.commerce_settlement_intents AS intent_row ON intent_row.id = transition_row.intent_id
        JOIN public.commerce_orders AS order_row ON order_row.id = intent_row.order_id
        WHERE order_row.client_id = client_row.id
        UNION ALL
        SELECT case_row.id, case_row.opened_at, 'dunning.' || case_row.status, case_row.status,
          'dunning_case', case_row.id
        FROM public.subscription_dunning_cases AS case_row
        WHERE case_row.client_id = client_row.id
        UNION ALL
        SELECT audit_row.id, audit_row.occurred_at, audit_row.event_type, audit_row.outcome,
          'recovery', audit_row.case_id
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

-- Atomically delegate a support repair command to the existing D15 token and notice
-- authority. The advisory transaction lock closes the absent-row race: no caller reaches
-- D15 until the same idempotency key's fingerprint has been serialized and checked.
CREATE FUNCTION public.customer_support_issue_recovery(
  p_operator_id uuid,
  p_client_id uuid,
  p_case_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_recovery_url_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.customer_recovery_commands%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_case public.subscription_dunning_cases%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_issue_result jsonb;
  v_notice_attempt integer;
  v_notice_id uuid;
  v_audit_id uuid := gen_random_uuid();
  v_recorded_at timestamptz := clock_timestamp();
  v_response jsonb;
  v_refusal_code text;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_client_id IS NULL OR p_case_id IS NULL
    OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
    OR COALESCE(p_command_fingerprint, '') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    OR p_expires_at IS NULL OR p_expires_at <= now()
    OR p_recovery_url_path IS NULL OR p_recovery_url_path !~ '^/[^[:cntrl:]]+$'
  THEN
    RAISE EXCEPTION 'customer_support_recovery_command_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-recovery:' || p_idempotency_key, 0)
  );
  SELECT * INTO v_existing
  FROM public.customer_recovery_commands AS command_row
  WHERE command_row.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.command_fingerprint <> p_command_fingerprint
      OR v_existing.operator_id <> p_operator_id
      OR v_existing.client_id <> p_client_id
      OR v_existing.case_id <> p_case_id
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' = 'refused' THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT * INTO v_client FROM public.clients AS client_row
  WHERE client_row.id = p_client_id;
  IF NOT FOUND THEN
    v_refusal_code := 'subject_not_found';
  ELSIF v_client.lifecycle_stage <> 'customer' THEN
    v_refusal_code := 'lifecycle_not_eligible';
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_case FROM public.subscription_dunning_cases AS case_row
    WHERE case_row.id = p_case_id
    FOR UPDATE;
    IF NOT FOUND OR v_case.client_id <> p_client_id THEN
      v_refusal_code := 'case_not_found';
    ELSIF v_case.status <> 'open' THEN
      v_refusal_code := 'case_not_open';
    END IF;
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_order FROM public.commerce_orders AS order_row
    WHERE order_row.subscription_cycle_id = v_case.cycle_id
      AND order_row.client_id = p_client_id
      AND order_row.status = 'pending_payment'
    ORDER BY order_row.created_at DESC, order_row.id DESC
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
      v_refusal_code := 'recoverable_order_unavailable';
    END IF;
  END IF;

  IF v_refusal_code IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscription_dunning_notifications AS notice_row
    WHERE notice_row.case_id = p_case_id
      AND notice_row.recipient_kind = 'customer'
      AND notice_row.notification_kind = 'payment_failed'
  ) THEN
    v_refusal_code := 'dunning_authority_unavailable';
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    INSERT INTO public.customer_support_audit_events (
      id, operator_id, client_id, case_id, event_type, outcome, command_key, occurred_at
    ) VALUES (
      v_audit_id, p_operator_id, p_client_id, p_case_id,
      'issue_recovery', 'refused', p_idempotency_key, v_recorded_at
    );
    v_response := jsonb_build_object(
      'outcome', 'refused', 'refusalCode', v_refusal_code, 'auditEventId', v_audit_id
    );
    INSERT INTO public.customer_recovery_commands (
      idempotency_key, command_fingerprint, operator_id, client_id, case_id,
      response, created_at
    ) VALUES (
      p_idempotency_key, p_command_fingerprint, p_operator_id, p_client_id, p_case_id,
      v_response, v_recorded_at
    );
    RETURN v_response;
  END IF;

  v_issue_result := public.dunning_lifecycle_issue_recovery_token(
    p_case_id, p_token_hash, p_expires_at
  );
  IF COALESCE((v_issue_result->>'issued')::boolean, false) IS NOT TRUE THEN
    INSERT INTO public.customer_support_audit_events (
      id, operator_id, client_id, case_id, event_type, outcome, command_key, occurred_at
    ) VALUES (
      v_audit_id, p_operator_id, p_client_id, p_case_id,
      'issue_recovery', 'refused', p_idempotency_key, v_recorded_at
    );
    v_response := jsonb_build_object(
      'outcome', 'refused', 'refusalCode', 'recoverable_order_unavailable',
      'auditEventId', v_audit_id
    );
    INSERT INTO public.customer_recovery_commands (
      idempotency_key, command_fingerprint, operator_id, client_id, case_id,
      response, created_at
    ) VALUES (
      p_idempotency_key, p_command_fingerprint, p_operator_id, p_client_id, p_case_id,
      v_response, v_recorded_at
    );
    RETURN v_response;
  END IF;

  -- D15 predates this command fence and reports issued even when its token-hash
  -- conflict branch inserts nothing. Verify the same active capability exists
  -- for the locked order; failure aborts the transaction and restores any token
  -- D15 revoked, so no notice can carry an unusable link.
  IF NOT EXISTS (
    SELECT 1 FROM public.commerce_checkout_recovery_tokens AS recovery_token
    WHERE recovery_token.order_id = v_order.id
      AND recovery_token.client_id = p_client_id
      AND recovery_token.token_hash = p_token_hash
      AND recovery_token.revoked_at IS NULL
      AND recovery_token.expires_at = p_expires_at
  ) THEN
    RAISE EXCEPTION 'customer_support_recovery_token_not_persisted' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(max(notice_row.retry_attempt), 0) + 1 INTO v_notice_attempt
  FROM public.subscription_dunning_notifications AS notice_row
  WHERE notice_row.case_id = p_case_id
    AND notice_row.notification_kind = 'payment_recovery';
  v_notice_id := public.dunning_lifecycle_queue_notice(
    p_case_id, 'payment_recovery', 'payment_recovery', v_notice_attempt,
    p_recovery_url_path
  );

  INSERT INTO public.customer_support_audit_events (
    id, operator_id, client_id, case_id, event_type, outcome, command_key, occurred_at
  ) VALUES (
    v_audit_id, p_operator_id, p_client_id, p_case_id,
    'issue_recovery', 'issued', p_idempotency_key, v_recorded_at
  );

  v_response := jsonb_build_object(
    'outcome', 'issued',
    'deliveryStatus', 'queued',
    'auditEventId', v_audit_id
  );
  INSERT INTO public.customer_recovery_commands (
    idempotency_key, command_fingerprint, operator_id, client_id, case_id,
    response, created_at
  ) VALUES (
    p_idempotency_key, p_command_fingerprint, p_operator_id, p_client_id, p_case_id,
    v_response, v_recorded_at
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_subject_capture_lifecycle()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_refuse_ledger_mutation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_summary(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_search(uuid, text, integer, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_detail(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_journey(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_issue_recovery(
  uuid, uuid, uuid, text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
