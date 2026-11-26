CREATE FUNCTION public.subscriptions__read_renewal_occurrence(p_client uuid,p_subscription uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE occurrence public.subscription_cycle_occurrences; deadline timestamp;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE id=p_subscription AND client_id=p_client) THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023', DETAIL='/subscriptionId';
  END IF;
  SELECT * INTO occurrence FROM public.subscription_cycle_occurrences
   WHERE subscription_id=p_subscription AND client_id=p_client AND cycle_key=p_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_cycle_unavailable','field','/cycleKey');
  END IF;
  IF occurrence.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscription_renewal_operations op
    WHERE op.id=occurrence.operation_id AND op.subscription_id=p_subscription
      AND op.scheduled_at=occurrence.original_anchor_at
  ) THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_cycle_unavailable','field','/cycleKey');
  END IF;
  IF occurrence.deadline_rule_ref IS NOT NULL AND occurrence.cadence_seconds % 86400=0
     AND occurrence.cadence_seconds / 86400<=2147483647 THEN
    BEGIN
      deadline:=(occurrence.effective_due_at AT TIME ZONE 'UTC')
        - make_interval(days=>(occurrence.lead_seconds/86400)::integer,secs=>occurrence.lead_seconds%86400);
    EXCEPTION WHEN datetime_field_overflow THEN
      deadline:=NULL;
    END;
  END IF;
  IF deadline IS NULL OR extract(year FROM deadline) NOT BETWEEN 1 AND 9999
     OR extract(year FROM occurrence.original_anchor_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
     OR extract(year FROM occurrence.effective_due_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
     OR (occurrence.cancellation_effective_at IS NOT NULL AND
         extract(year FROM occurrence.cancellation_effective_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999) THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_deadline_rule_unsupported','field','/deadlineRuleRef');
  END IF;
  RETURN jsonb_build_object(
    'clientId',p_client,'subscriptionId',p_subscription,'cycleKey',p_key,
    'originalAnchorAt',to_char(occurrence.original_anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effectiveDueAt',to_char(occurrence.effective_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cancellationDeadlineAt',to_char(deadline,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'deadlineRuleRef',occurrence.deadline_rule_ref,'deadlineRuleRevision',occurrence.deadline_rule_revision,
    'cadenceSeconds',occurrence.cadence_seconds,'rail',occurrence.rail,'lifecycle',occurrence.lifecycle,
    'cancellationEffectiveAt',to_char(occurrence.cancellation_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'operationId',occurrence.operation_id,'commercialGenerationId',occurrence.commercial_generation_id);
END;
$$;

CREATE FUNCTION public.subscriptions__lock_renewal_occurrence(p_client uuid,p_subscription uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE occurrence_view jsonb; cycle_lifecycle text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;
  PERFORM 1 FROM public.subscriptions WHERE id=p_subscription AND client_id=p_client FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023', DETAIL='/subscriptionId';
  END IF;
  SELECT lifecycle INTO cycle_lifecycle FROM public.subscription_cycle_occurrences
   WHERE subscription_id=p_subscription AND client_id=p_client AND cycle_key=p_key AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;
  occurrence_view:=public.subscriptions__read_renewal_occurrence(p_client,p_subscription,p_key);
  IF occurrence_view->>'kind'='unavailable' THEN
    RAISE EXCEPTION USING MESSAGE=occurrence_view->>'code', ERRCODE='22023', DETAIL=occurrence_view->>'field';
  END IF;
  IF cycle_lifecycle<>'active' THEN
    RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;
  RETURN occurrence_view;
END;
$$;

CREATE FUNCTION public.subscriptions__export_renewal_occurrences(p_client uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE caller name:=coalesce(nullif(current_setting('role'),'none'),session_user::text)::name;
BEGIN
 IF NOT has_table_privilege(caller,'public.subscriptions','SELECT')
   OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.rolname=caller
     WHERE c.oid='public.subscriptions'::regclass AND c.relrowsecurity
       AND NOT (r.rolsuper OR r.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(caller,c.relowner,'USAGE'))))
 THEN RETURN '[]'::jsonb; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
  'cycleKey',c.cycle_key,'subscriptionId',c.subscription_id,'rail',c.rail,'lifecycle',c.lifecycle,
  'originalAnchorAt',to_char(c.original_anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'effectiveDueAt',to_char(c.effective_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'cancellationEffectiveAt',to_char(c.cancellation_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  ORDER BY c.cycle_key),'[]'::jsonb)
 FROM public.subscription_cycle_occurrences c
 JOIN public.subscriptions s ON s.id=c.subscription_id AND s.client_id=c.client_id
 WHERE c.client_id=p_client);
END;
$$;

REVOKE ALL ON FUNCTION public.subscriptions__export_renewal_occurrences(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__export_renewal_occurrences(uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__export_renewal_occurrences(uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid) FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscriptions__export_renewal_occurrences(uuid) TO service_role;';
END IF; END; $$;
