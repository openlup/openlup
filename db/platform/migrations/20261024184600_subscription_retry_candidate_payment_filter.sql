-- Donor: supabase/migrations/20261009110000_subscription_dunning_active_repair.sql
-- (due-reader paid exclusion); 20260912164500_retry_admission_observed_provider_success.sql.
-- Native waiting-obligation selection translates managed unpaid-cycle/intent admission.
-- Native CTL-2 Y: omit paid cycles and settled intents before retry LIMIT so
-- stale waiting obligations cannot starve genuinely due declines.
-- Requires the native prefix through CTL-2 X (20261024184500). This read-only body
-- replacement retains the exact arguments/defaults, STABLE volatility, invoker
-- rights, search_path, ordering, limit clamp and effective ACLs. No close route,
-- state rewrite, grant, seed, subscription pause or driver activation is added.
-- Native only; no managed twin is installed. Keep this forward on code rollback.
CREATE OR REPLACE FUNCTION public.subscription_retry_candidates(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM (
  SELECT o.* FROM public.subscription_retry_obligations o JOIN public.subscriptions s ON s.id=o.subscription_id
  WHERE s.status='active' AND o.state='waiting' AND o.next_retry_at<=p_now
   AND EXISTS(SELECT 1 FROM public.subscription_cycles cycle
    WHERE cycle.id=o.cycle_id AND cycle.status<>'paid')
   AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents intent
    WHERE intent.id=o.settlement_intent_id AND intent.status<>'settled')
  ORDER BY o.next_retry_at,o.id LIMIT LEAST(GREATEST(p_limit,1),500)
 ) c;
$$;
