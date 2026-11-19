-- Give both new cycles and expired claims room in the native normal due page.
CREATE OR REPLACE FUNCTION public.subscription_stock_wait_normal_due(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 WITH settings AS (
  SELECT LEAST(GREATEST(COALESCE(p_limit,50),1),500) page_size, COALESCE(p_now,now()) as_of
 ), due AS NOT MATERIALIZED (
  SELECT subscription.id AS subscription_id, subscription.next_cycle_at AS scheduled_at
    FROM public.subscriptions subscription
   WHERE subscription.status='active' AND subscription.next_cycle_at<=(SELECT as_of FROM settings)
     AND EXISTS(SELECT 1 FROM public.subscription_renewal_terms terms WHERE terms.subscription_id=subscription.id)
     AND NOT EXISTS(SELECT 1 FROM public.subscription_stock_wait_cases c
      WHERE c.subscription_id=subscription.id AND c.scheduled_at=subscription.next_cycle_at
        AND c.state IN ('waiting','stock_secured'))
 ), fresh AS (
  SELECT due.*, due.scheduled_at AS ready_at, true AS is_fresh
    FROM due
   WHERE NOT EXISTS(SELECT 1 FROM public.subscription_renewal_operations operation
     WHERE operation.subscription_id=due.subscription_id AND operation.scheduled_at=due.scheduled_at)
   ORDER BY scheduled_at,subscription_id LIMIT (SELECT page_size FROM settings)
 ), expired AS (
  SELECT due.*, operation.lease_expires_at AS ready_at, false AS is_fresh
    FROM due
    JOIN public.subscription_renewal_operations operation
      ON operation.subscription_id=due.subscription_id AND operation.scheduled_at=due.scheduled_at
   WHERE operation.state NOT IN ('succeeded','refused') AND operation.lease_expires_at<=(SELECT as_of FROM settings)
   ORDER BY ready_at,scheduled_at,subscription_id LIMIT (SELECT page_size FROM settings)
 ), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY is_fresh ORDER BY ready_at,scheduled_at,subscription_id) AS lane_position
    FROM (SELECT * FROM fresh UNION ALL SELECT * FROM expired) candidates
 ), selected AS (
  SELECT subscription_id,scheduled_at FROM ranked ORDER BY lane_position,ready_at,scheduled_at,subscription_id
   LIMIT (SELECT page_size FROM settings)
 )
 SELECT COALESCE(jsonb_agg(to_jsonb(projected) ORDER BY projected.scheduled_at,projected.subscription_id),'[]'::jsonb) FROM (
  SELECT selected.subscription_id,subscription.client_id,selected.scheduled_at,subscription.cadence_days,
         terms.next_cycle_number AS cycle_number,terms.currency_code,terms.stock_source_key,
         terms.settlement_channel_key,terms.authorization_ref,terms.payer_account_ref,
         terms.unattended_charge_authorized_at,terms.delivery_admission,terms.delivery_block_reason
    FROM selected
    JOIN public.subscriptions subscription ON subscription.id=selected.subscription_id
    JOIN public.subscription_renewal_terms terms ON terms.subscription_id=selected.subscription_id
 ) projected;
$$;
