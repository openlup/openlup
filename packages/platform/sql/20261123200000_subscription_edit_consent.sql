-- Native preview actor equality; the existing signature, selection and lock order are retained.
CREATE OR REPLACE FUNCTION public.subscription_quote_preview_take(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,p_key text,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180 THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('update_package_template','update_bundle','update_plan_length','add_addon','remove_addon',
  'update_addon_quantity','swap_base_line','update_base_mix','update_portion','resize_bundle') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF p_version IS NULL OR p_version<1 OR s.template_version<>p_version THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE subscription_id=s.id AND client_id=p_client_id
  AND action=p_action AND quote_hash=p_hash AND template_version=p_version ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF q.actor_id IS DISTINCT FROM p_actor_id THEN
  RAISE EXCEPTION 'subscription_edit_quote_actor_mismatch' USING ERRCODE='22023'; END IF;
 IF q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
 IF q.accepted_at IS NOT NULL AND q.accepted_idempotency_key<>p_key THEN
  RAISE EXCEPTION 'subscription_edit_quote_already_used' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(q);
END;
$$;

CREATE FUNCTION public.customer_self_service_prune_subscription_quote_previews(
 p_retention pg_catalog.interval DEFAULT interval '7 days',p_limit integer DEFAULT 1000,p_pruned_at timestamptz DEFAULT now()
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_deleted integer:=0;
BEGIN
 IF p_retention IS NULL OR p_retention<interval '0 seconds' THEN
  RAISE EXCEPTION 'customer_self_service_invalid_quote_preview_retention'; END IF;
 IF p_limit IS NULL OR p_limit<=0 OR p_limit>10000 THEN
  RAISE EXCEPTION 'customer_self_service_invalid_quote_preview_prune_limit'; END IF;
 WITH doomed AS (SELECT id FROM public.subscription_quote_previews
  WHERE status='previewed' AND expires_at<p_pruned_at-p_retention ORDER BY expires_at,id LIMIT p_limit),
 deleted AS (DELETE FROM public.subscription_quote_previews q USING doomed WHERE q.id=doomed.id RETURNING 1)
 SELECT count(*)::integer INTO v_deleted FROM deleted;
 RETURN COALESCE(v_deleted,0);
END;
$$;
REVOKE ALL ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_self_service_prune_subscription_quote_previews(pg_catalog.interval,integer,timestamptz) TO service_role'; END IF; END; $$;

CREATE OR REPLACE FUNCTION public.subscription_quote_preview_record(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,
 p_expires_at timestamptz,p_request jsonb,p_snapshot jsonb,p_totals jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('update_package_template','update_bundle','update_plan_length','add_addon','remove_addon',
  'update_addon_quantity','swap_base_line','update_base_mix','update_portion','resize_bundle') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 IF p_expires_at IS NULL OR NOT isfinite(p_expires_at) OR p_expires_at<=p_now THEN
  RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.template_version<>p_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 PERFORM public.customer_self_service_prune_subscription_quote_previews(interval '7 days',500,p_now);
 INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,
  expires_at,request_payload,quote_snapshot,totals,created_at,updated_at)
 VALUES(s.id,p_client_id,p_actor_id,p_action,p_hash,p_version,p_expires_at,p_request,p_snapshot,p_totals,p_now,p_now)
 ON CONFLICT (subscription_id,client_id,action,quote_hash,template_version) WHERE status='previewed' DO UPDATE SET
  actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,request_payload=EXCLUDED.request_payload,
  quote_snapshot=EXCLUDED.quote_snapshot,totals=EXCLUDED.totals,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at
 RETURNING * INTO q;
 RETURN to_jsonb(q);
END;
$$;
