-- Donor: supabase/migrations/20261009110000_subscription_dunning_active_repair.sql
-- (744-930), retaining the stock-wait exclusion from 20261003123000_subscription_stock_wait.sql.
-- Add stock-wait exclusion to the post-continuity reader; requires M3.

CREATE OR REPLACE FUNCTION public.subscription_list_due_for_renewal(p_limit integer DEFAULT 50, p_as_of timestamp with time zone DEFAULT now()) RETURNS TABLE(subscription_id uuid, client_id uuid, next_cycle_at timestamp with time zone, cadence_days integer, template_version integer, currency text, region_code text, provider_kind text, provider_customer_ref text, provider_method_ref text, method_kind text, status text, payer_email text, payer_name text, method_status text, method_active boolean, method_expires_at timestamp with time zone, method_client_id uuid)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_limit > 500 THEN
    RAISE EXCEPTION 'subscription_list_due_for_renewal: p_limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH retry_due AS (
      SELECT
        s.id          AS subscription_id,
        s.client_id   AS client_id,
        c.scheduled_at AS next_cycle_at,
        s.cadence_days,
        s.template_version,
        s.currency,
        s.region_code,
        m.provider_kind,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_customer_ref
          ELSE NULL
        END AS provider_customer_ref,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_method_ref
          ELSE NULL
        END AS provider_method_ref,
        COALESCE(m.method_kind, s.payment_method_kind, '') AS method_kind,
        m.status,
        cl.email AS payer_email,
        NULLIF(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') AS payer_name,
        m.status AS method_status,
        m.active AS method_active,
        m.expires_at AS method_expires_at,
        m.client_id AS method_client_id
      FROM public.subscriptions s
      JOIN public.clients cl
        ON cl.id = s.client_id
      JOIN public.subscription_cycles c
        ON c.subscription_id = s.id
       AND c.status = 'retry_scheduled'
       AND c.next_retry_at IS NOT NULL
       AND c.next_retry_at <= p_as_of
       AND (c.retry_attempt < 4 OR EXISTS (
         SELECT 1 FROM public.subscription_dunning_cases dc
         JOIN public.subscription_payment_recovery_tokens rt ON rt.id::text=dc.metadata->>'recoveryTokenId'
         WHERE dc.cycle_id=c.id AND dc.status='open'
           AND dc.metadata->>'recoveryRetryAttempt'=c.retry_attempt::text
           AND rt.used_at IS NOT NULL AND rt.revoked_at IS NULL AND rt.expires_at > p_as_of))
       -- Quarantine skip (retry lane). A bare timestamp comparison, never a
       -- status: an elapsed value re-admits the row on the very next pass with
       -- no unquarantine write required, so a lost clear cannot strand anyone.
       AND (c.renewal_quarantined_until IS NULL OR c.renewal_quarantined_until <= p_as_of)
      LEFT JOIN LATERAL (
        SELECT pm.provider_kind, pm.provider_customer_ref, pm.provider_method_ref,
               pm.method_kind, pm.status, pm.active, pm.expires_at, pm.client_id,
               pm.updated_at, pm.created_at
          FROM public.commerce_payment_method_refs pm
         WHERE pm.subscription_id = s.id
           AND (NOT EXISTS (SELECT 1 FROM public.subscription_dunning_cases dc
                  WHERE dc.cycle_id=c.id AND dc.metadata->>'recoveryRetryAttempt'=c.retry_attempt::text)
             OR EXISTS (SELECT 1 FROM public.subscription_dunning_cases dc
                JOIN public.subscription_payment_recovery_tokens rt ON rt.id::text=dc.metadata->>'recoveryTokenId'
               WHERE dc.cycle_id=c.id AND dc.status='open'
                 AND dc.metadata->>'recoveryRetryAttempt'=c.retry_attempt::text
                 AND dc.metadata->>'recoveryMethodId'=pm.id::text
                 AND rt.revoked_at IS NULL AND rt.used_at IS NOT NULL AND rt.expires_at > p_as_of))
         ORDER BY
           (pm.active = true AND pm.status = 'active') DESC,
           pm.active DESC,
           pm.updated_at DESC,
           pm.created_at DESC
         LIMIT 1
      ) m ON true
      WHERE s.status = 'active'
      ORDER BY c.next_retry_at ASC, s.id ASC
      LIMIT p_limit
      FOR UPDATE OF s SKIP LOCKED
    ),
    normal_due AS (
      SELECT
        s.id          AS subscription_id,
        s.client_id   AS client_id,
        s.next_cycle_at,
        s.cadence_days,
        s.template_version,
        s.currency,
        s.region_code,
        m.provider_kind,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_customer_ref
          ELSE NULL
        END,
        CASE
          WHEN m.client_id = s.client_id AND m.active = true AND m.status = 'active'
          THEN m.provider_method_ref
          ELSE NULL
        END AS provider_method_ref,
        COALESCE(m.method_kind, s.payment_method_kind, '') AS method_kind,
        m.status,
        cl.email AS payer_email,
        NULLIF(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') AS payer_name,
        m.status AS method_status,
        m.active AS method_active,
        m.expires_at AS method_expires_at,
        m.client_id AS method_client_id
      FROM public.subscriptions s
      JOIN public.clients cl
        ON cl.id = s.client_id
      LEFT JOIN LATERAL (
        SELECT pm.provider_kind, pm.provider_customer_ref, pm.provider_method_ref,
               pm.method_kind, pm.status, pm.active, pm.expires_at, pm.client_id,
               pm.updated_at, pm.created_at
          FROM public.commerce_payment_method_refs pm
         WHERE pm.subscription_id = s.id
         ORDER BY
           (pm.active = true AND pm.status = 'active') DESC,
           pm.active DESC,
           pm.updated_at DESC,
           pm.created_at DESC
         LIMIT 1
      ) m ON true
      WHERE s.status = 'active'
        AND s.next_cycle_at IS NOT NULL
        AND s.next_cycle_at <= p_as_of
        -- Waiting obligations are reconsidered by the fair stock-wait reader.
        AND NOT EXISTS (
          SELECT 1 FROM public.subscription_stock_wait_cases wait_case
           WHERE wait_case.subscription_id=s.id AND wait_case.scheduled_at=s.next_cycle_at
             AND wait_case.state IN ('waiting','stock_secured')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.subscription_cycles c
           WHERE c.subscription_id = s.id
             AND c.status IN ('payment_pending', 'retry_scheduled', 'payment_failed')
        )
        -- Quarantine skip (normal lane). The open-cycle guard above already
        -- hides the common case, so this covers the row whose cycle left those
        -- statuses while still quarantined; without it the same failing row
        -- would come straight back through the other lane.
        AND NOT EXISTS (
          SELECT 1
            FROM public.subscription_cycles c
           WHERE c.subscription_id = s.id
             AND c.renewal_quarantined_until > p_as_of
        )
      ORDER BY s.next_cycle_at ASC, s.id ASC
      LIMIT p_limit
      FOR UPDATE OF s SKIP LOCKED
    )
    SELECT *
      FROM (
        SELECT * FROM retry_due
        UNION ALL
        SELECT * FROM normal_due
      ) due
     ORDER BY due.next_cycle_at ASC, due.subscription_id ASC
     LIMIT p_limit;
END;
$$;
