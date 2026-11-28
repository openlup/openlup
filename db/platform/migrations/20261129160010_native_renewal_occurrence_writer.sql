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
    JOIN public.subscription_cycle_generations generation ON generation.operation_id=op.id
      AND generation.cycle_key=occurrence.cycle_key
      AND generation.commercial_generation_id=occurrence.commercial_generation_id
    WHERE op.id=occurrence.operation_id AND op.subscription_id=p_subscription
      AND op.scheduled_at=occurrence.original_anchor_at
      AND (occurrence.rail='v3')=coalesce(op.cycle_snapshot->>'contractVersion'='platform.subscription.renewal.v3',false)
  ) THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_cycle_unavailable','field','/cycleKey');
  END IF;
  IF occurrence.rail='v3' AND occurrence.effective_due_at<occurrence.original_anchor_at THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_cycle_unavailable','field','/effectiveDueAt');
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

-- Private native writer. The claim owner supplies the admitted canonical agreement.
CREATE FUNCTION public.subscriptions__create_renewal_v3_root(
  p_client_id uuid, p_subscription_id uuid, p_cycle_key uuid, p_operation_id uuid,
  p_cycle_number integer, p_agreement_canonical text, p_agreement_fingerprint text,
  p_worker_id text, p_lease_seconds integer
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parent public.subscriptions;
  cycle_view jsonb;
  occurrence public.subscription_cycle_occurrences;
  root public.subscription_renewal_operations;
  generation public.subscription_cycle_generations;
  terms_counter integer;
  input_field text;
  identity text;
  coordinates jsonb;
  cadence jsonb;
  agreement jsonb;
  agreement_fits boolean;
  digest text;
  sampled_at timestamptz;
  lease_end timestamptz;
  token uuid;
  collision text;
BEGIN
  input_field:=CASE
    WHEN p_operation_id IS NULL THEN '/operationId'
    WHEN p_cycle_number IS NULL OR p_cycle_number<1 THEN '/cycleNumber'
    WHEN p_worker_id IS NULL OR p_worker_id COLLATE "C" SIMILAR TO '[[:space:]                 　﻿]*' THEN '/workerId'
    WHEN p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN '/leaseSeconds'
  END;
  IF input_field IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE='22023', DETAIL=input_field;
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;

  SELECT * INTO parent FROM public.subscriptions
   WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023', DETAIL='/subscriptionId';
  END IF;
  SELECT next_cycle_number INTO terms_counter FROM public.subscription_renewal_terms
   WHERE subscription_id=p_subscription_id FOR SHARE;
  cycle_view:=public.subscriptions__lock_renewal_occurrence(p_client_id,p_subscription_id,p_cycle_key);
  IF cycle_view->>'rail'<>'v3' THEN
    RAISE EXCEPTION 'renewal_v3_unavailable' USING ERRCODE='22023', DETAIL='/rail';
  END IF;
  SELECT * INTO STRICT occurrence FROM public.subscription_cycle_occurrences
   WHERE cycle_key=p_cycle_key AND subscription_id=p_subscription_id AND client_id=p_client_id;

  identity:='subscription:'||p_subscription_id::text||':renewal-v3:'||p_cycle_key::text;
  cadence:=jsonb_build_object('schemaVersion',1,'kind','fixed_days','days',occurrence.cadence_seconds/86400);
  coordinates:=jsonb_build_object(
    'frozenRevision','native.purchase-renewal.v3','contractVersion','platform.subscription.renewal.v3',
    'clientId',p_client_id,'subscriptionId',p_subscription_id,'cycleKey',p_cycle_key,
    'originalAnchorAt',cycle_view->>'originalAnchorAt','operationId',p_operation_id,
    'commercialGenerationId',p_operation_id,'cadence',cadence,'cycleNumber',p_cycle_number);

  IF occurrence.operation_id IS NOT NULL THEN
    IF occurrence.operation_id<>p_operation_id OR occurrence.commercial_generation_id<>p_operation_id THEN
      RAISE EXCEPTION 'renewal_claim_stale' USING ERRCODE='40001', DETAIL='/commercialGenerationId';
    END IF;
    SELECT * INTO root FROM public.subscription_renewal_operations
     WHERE id=p_operation_id AND subscription_id=p_subscription_id FOR KEY SHARE;
    SELECT * INTO generation FROM public.subscription_cycle_generations
     WHERE cycle_key=p_cycle_key AND operation_id=p_operation_id AND commercial_generation_id=p_operation_id FOR KEY SHARE;
  ELSE
    sampled_at:=pg_catalog.clock_timestamp();
    IF parent.status<>'active' OR occurrence.cancellation_receipt_id IS NOT NULL
        OR occurrence.cancellation_effective_at IS NOT NULL OR occurrence.effective_due_at>sampled_at THEN
      RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
    END IF;
    IF terms_counter IS DISTINCT FROM p_cycle_number THEN
      RAISE EXCEPTION 'renewal_agreement_unavailable' USING ERRCODE='22023', DETAIL='/agreement';
    END IF;
  END IF;

  BEGIN
    agreement:=p_agreement_canonical::jsonb;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN
    agreement:=NULL;
  END;
  digest:=encode(sha256(convert_to(p_agreement_canonical,'UTF8')),'hex');
  agreement_fits:=(agreement @> coordinates) IS TRUE AND NOT (agreement ?| ARRAY['frozenFingerprint','cadenceSeconds'])
    AND occurrence.cadence_seconds/86400 BETWEEN 1 AND 3660
    AND agreement->'cadence' = cadence AND agreement#>'{templateSnapshot,cadenceDays}' IS NOT DISTINCT FROM cadence->'days';

  IF occurrence.operation_id IS NOT NULL THEN
    IF root.scheduled_at IS DISTINCT FROM occurrence.original_anchor_at OR root.cycle_number IS DISTINCT FROM p_cycle_number
        OR root.identity_key IS DISTINCT FROM identity OR root.operation_fingerprint IS DISTINCT FROM generation.agreement_fingerprint
        OR root.cycle_snapshot IS DISTINCT FROM generation.agreement||jsonb_build_object('frozenFingerprint',generation.agreement_fingerprint)
        OR NOT agreement_fits OR generation.agreement IS DISTINCT FROM agreement
        OR p_agreement_fingerprint IS DISTINCT FROM generation.agreement_fingerprint OR digest IS DISTINCT FROM generation.agreement_fingerprint THEN
      RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE='23505', DETAIL='/agreementFingerprint';
    END IF;
  ELSE
    IF NOT agreement_fits OR jsonb_typeof(agreement->'catalogAcceptance') IS DISTINCT FROM 'object'
        OR agreement#>'{templateSnapshot,version}' IS DISTINCT FROM to_jsonb(parent.template_version)
        OR digest IS DISTINCT FROM p_agreement_fingerprint THEN
      RAISE EXCEPTION 'catalog_acceptance_snapshot_mismatch' USING ERRCODE='22023', DETAIL='/agreementFingerprint';
    END IF;
    -- The caller proves wider lineage. An incumbent root still occupies its native key.
    IF EXISTS (SELECT 1 FROM public.subscription_renewal_operations o WHERE o.subscription_id=p_subscription_id
               AND (o.scheduled_at=occurrence.original_anchor_at OR o.identity_key=identity)) THEN
      RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
    END IF;
    -- Scope is already established. Check the global key without returning any row data.
    IF EXISTS (SELECT 1 FROM public.subscription_renewal_operations WHERE id=p_operation_id) THEN
      RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/operationId';
    END IF;

    token:=gen_random_uuid();
    lease_end:=sampled_at+make_interval(secs=>p_lease_seconds);
    UPDATE public.subscription_cycle_occurrences
       SET operation_id=p_operation_id,commercial_generation_id=p_operation_id
     WHERE cycle_key=p_cycle_key AND subscription_id=p_subscription_id AND client_id=p_client_id
       AND is_current AND rail='v3' AND operation_id IS NULL AND commercial_generation_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'renewal_claim_stale' USING ERRCODE='40001', DETAIL='/commercialGenerationId';
    END IF;

    BEGIN
      INSERT INTO public.subscription_renewal_operations
        (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,
         state,claim_generation,claim_token,claimed_by,claimed_at,lease_expires_at,created_at,updated_at)
      VALUES (p_operation_id,p_subscription_id,occurrence.original_anchor_at,p_cycle_number,identity,digest,
        agreement||jsonb_build_object('frozenFingerprint',digest),'claimed',1,token,p_worker_id,sampled_at,lease_end,sampled_at,sampled_at);
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS collision=CONSTRAINT_NAME;
      IF collision='subscription_renewal_operations_pkey' THEN
        RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/operationId';
      ELSIF collision IN ('subscription_renewal_operations_cycle_key','subscription_renewal_operations_identity_key_key') THEN
        RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
      END IF;
      RAISE;
    END;

    INSERT INTO public.subscription_cycle_generations
      (operation_id,commercial_generation_id,cycle_key,agreement,agreement_fingerprint,claim_token,lease_expires_at,lease_generation,last_binding_seq)
    VALUES (p_operation_id,p_operation_id,p_cycle_key,agreement,digest,token,lease_end,1,0);
  END IF;

  RETURN jsonb_build_object(
    'outcome',CASE WHEN token IS NULL THEN 'existing' ELSE 'created' END,
    'clientId',p_client_id,'subscriptionId',p_subscription_id,'cycleKey',p_cycle_key,
    'originalAnchorAt',cycle_view->>'originalAnchorAt','operationId',p_operation_id,'commercialGenerationId',p_operation_id,
    'agreementFingerprint',digest,'agreement',agreement,'claimToken',token,
    'leaseExpiresAt',to_char(lease_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END;
$$;

REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__create_renewal_v3_root(uuid,uuid,uuid,uuid,integer,text,text,text,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__create_renewal_v3_root(uuid,uuid,uuid,uuid,integer,text,text,text,integer) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__create_renewal_v3_root(uuid,uuid,uuid,uuid,integer,text,text,text,integer) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__create_renewal_v3_root(uuid,uuid,uuid,uuid,integer,text,text,text,integer) FROM service_role;';
END IF; END; $$;
