-- Reusable method evidence is independent of money truth. Setup and repair do
-- not settle an order, recover a payment, or change subscription service.
CREATE TABLE public.payment_method_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  subscription_id uuid REFERENCES public.subscriptions(id),
  provider_kind text NOT NULL CHECK (char_length(btrim(provider_kind)) BETWEEN 1 AND 2147483647),
  method_kind text NOT NULL CHECK (method_kind IN ('card','blik_payid','wallet','alias')),
  provider_customer_ref text,
  provider_method_ref text NOT NULL CHECK (char_length(btrim(provider_method_ref)) BETWEEN 1 AND 2147483647),
  provider_mandate_ref text,
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','active','inactive','expired','revoked')),
  active boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  consent_snapshot jsonb NOT NULL DEFAULT '{}',
  raw_provider_payload jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  deactivated_at timestamptz,
  UNIQUE(provider_kind,provider_method_ref),
  CHECK (active=false OR status='active')
);
CREATE INDEX payment_method_refs_client ON public.payment_method_refs(client_id,active,status);
CREATE INDEX payment_method_refs_subscription ON public.payment_method_refs(subscription_id,active,status) WHERE subscription_id IS NOT NULL;
CREATE UNIQUE INDEX payment_method_refs_subscription_active ON public.payment_method_refs(subscription_id) WHERE active AND subscription_id IS NOT NULL;

CREATE TABLE public.payment_method_ref_receipts (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  response_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope,idempotency_key)
);
CREATE TABLE public.payment_method_recovery_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL UNIQUE REFERENCES public.commerce_checkout_recovery_tokens(id),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
  cycle_id uuid NOT NULL REFERENCES public.subscription_cycles(id),
  case_id uuid NOT NULL REFERENCES public.subscription_dunning_cases(id),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  purpose text NOT NULL DEFAULT 'repair_payment' CHECK (purpose IN ('repair_payment')),
  used_at timestamptz,
  revoked_at timestamptz,
  retry_attempt integer,
  method_ref text,
  method_evidence_ref text,
  method_id uuid REFERENCES public.payment_method_refs(id),
  scheduled_at timestamptz,
  dispatch_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.subscription_method_states ADD COLUMN method_kind text, ADD COLUMN provider_kind text;
ALTER TABLE public.subscription_retry_obligations ADD COLUMN method_recovery_authority_id uuid REFERENCES public.payment_method_recovery_authorities(id), ADD COLUMN renewal_quarantined_until timestamptz, ADD COLUMN renewal_row_error_key text, ADD COLUMN renewal_row_error_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.payment_method_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_method_ref_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_method_recovery_authorities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_method_refs FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_method_ref_receipts FROM PUBLIC;
REVOKE ALL ON TABLE public.payment_method_recovery_authorities FROM PUBLIC;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('payment_method_refs', 'block', 'Saved payment references remain bound to their client and prevent lead absorption.');
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('payment_method_recovery_authorities', 'block', 'Payment repair authority remains bound to its original client.');

CREATE FUNCTION public.payment_method_ref_upsert(
 p_idempotency_key text,p_client_id uuid,p_subscription_id uuid,p_provider_kind text,p_method_kind text,
 p_provider_customer_ref text,p_provider_method_ref text,p_provider_mandate_ref text,p_status text,p_active boolean,
 p_expires_at timestamptz,p_consent_snapshot jsonb,p_raw_provider_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE scope_key constant text:='commerce.payment_method_ref.upsert'; fingerprint text;
 receipt public.payment_method_ref_receipts; method public.payment_method_refs; target_id uuid; inserted boolean; response jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR p_client_id IS NULL OR p_provider_kind IS NULL OR btrim(p_provider_kind)=''
  OR p_method_kind NOT IN ('card','blik_payid','wallet','alias') OR p_provider_method_ref IS NULL OR btrim(p_provider_method_ref)=''
  OR p_status NOT IN ('pending_verification','active','inactive','expired','revoked') THEN
  RAISE EXCEPTION 'payment_method_ref_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_active AND p_status<>'active' THEN RAISE EXCEPTION 'payment_method_ref_active_requires_active_status' USING ERRCODE='22023'; END IF;
 IF p_active AND p_expires_at IS NOT NULL AND p_expires_at<=now() THEN RAISE EXCEPTION 'payment_method_ref_expired_cannot_be_active' USING ERRCODE='22023'; END IF;
 fingerprint:=md5(concat_ws('|',p_client_id::text,coalesce(p_subscription_id::text,''),btrim(p_provider_kind),p_method_kind,
  coalesce(p_provider_customer_ref,''),btrim(p_provider_method_ref),coalesce(p_provider_mandate_ref,''),p_status,p_active::text,coalesce(p_expires_at::text,'')));
 SELECT * INTO receipt FROM public.payment_method_ref_receipts WHERE scope=scope_key AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.request_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'payment_method_ref_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_set(receipt.response_payload,'{paymentMethodRef,replayed}','true'::jsonb,true);
 END IF;
 IF p_active THEN
  SELECT id INTO target_id FROM public.payment_method_refs WHERE provider_kind=btrim(p_provider_kind) AND provider_method_ref=btrim(p_provider_method_ref);
  UPDATE public.payment_method_refs SET active=false,deactivated_at=now(),updated_at=now()
   WHERE (target_id IS NULL OR id<>target_id) AND ((p_subscription_id IS NOT NULL AND subscription_id=p_subscription_id)
    OR (p_subscription_id IS NULL AND client_id=p_client_id AND subscription_id IS NULL));
 END IF;
 INSERT INTO public.payment_method_refs(client_id,subscription_id,provider_kind,method_kind,provider_customer_ref,provider_method_ref,
  provider_mandate_ref,status,active,expires_at,consent_snapshot,raw_provider_payload)
 VALUES(p_client_id,p_subscription_id,btrim(p_provider_kind),p_method_kind,p_provider_customer_ref,btrim(p_provider_method_ref),
  p_provider_mandate_ref,p_status,p_active,p_expires_at,coalesce(p_consent_snapshot,'{}'::jsonb),coalesce(p_raw_provider_payload,'{}'::jsonb))
 ON CONFLICT(provider_kind,provider_method_ref) DO UPDATE SET client_id=excluded.client_id,subscription_id=excluded.subscription_id,
  method_kind=excluded.method_kind,provider_customer_ref=excluded.provider_customer_ref,provider_mandate_ref=excluded.provider_mandate_ref,
  status=excluded.status,active=excluded.active,expires_at=excluded.expires_at,
  consent_snapshot=public.payment_method_refs.consent_snapshot||excluded.consent_snapshot,raw_provider_payload=excluded.raw_provider_payload,
  updated_at=now(),deactivated_at=CASE WHEN excluded.active THEN NULL ELSE public.payment_method_refs.deactivated_at END
 RETURNING xmax=0 INTO inserted;
 SELECT * INTO method FROM public.payment_method_refs WHERE provider_kind=btrim(p_provider_kind) AND provider_method_ref=btrim(p_provider_method_ref);
 response:=jsonb_build_object('paymentMethodRef',jsonb_build_object('id',method.id,'clientId',method.client_id,'subscriptionId',method.subscription_id,
  'providerKind',method.provider_kind,'methodKind',method.method_kind,'providerMethodRef',method.provider_method_ref,'status',method.status,'active',method.active,'replayed',NOT inserted));
 INSERT INTO public.payment_method_ref_receipts(scope,idempotency_key,request_fingerprint,response_payload) VALUES(scope_key,p_idempotency_key,fingerprint,response);
 RETURN response;
END; $$;

CREATE FUNCTION public.payment_method_ref_deactivate(p_idempotency_key text,p_method_ref_id uuid,p_reason text,p_metadata jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE method public.payment_method_refs;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR p_method_ref_id IS NULL THEN RAISE EXCEPTION 'payment_method_ref_deactivate_invalid_input' USING ERRCODE='22023'; END IF;
 UPDATE public.payment_method_refs SET active=false,status=CASE WHEN status='active' THEN 'inactive' ELSE status END,
  deactivated_at=coalesce(deactivated_at,now()),metadata=metadata||jsonb_build_object('deactivationReason',coalesce(p_reason,'unspecified'))||coalesce(p_metadata,'{}'::jsonb),updated_at=now()
 WHERE id=p_method_ref_id RETURNING * INTO method;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_method_ref_not_found' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('paymentMethodRef',jsonb_build_object('id',method.id,'active',method.active,'status',method.status));
END; $$;

CREATE FUNCTION public.payment_method_ref_switch_active(p_idempotency_key text,p_method_ref_id uuid,p_subscription_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE method public.payment_method_refs;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR p_method_ref_id IS NULL THEN RAISE EXCEPTION 'payment_method_ref_switch_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO method FROM public.payment_method_refs WHERE id=p_method_ref_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_method_ref_not_found' USING ERRCODE='22023'; END IF;
 IF method.status<>'active' OR (method.expires_at IS NOT NULL AND method.expires_at<=now()) THEN RAISE EXCEPTION 'payment_method_ref_cannot_become_active' USING ERRCODE='22023'; END IF;
 UPDATE public.payment_method_refs SET active=false,deactivated_at=now(),updated_at=now() WHERE id<>method.id AND
  ((p_subscription_id IS NOT NULL AND subscription_id=p_subscription_id) OR (p_subscription_id IS NULL AND client_id=method.client_id AND subscription_id IS NULL));
 UPDATE public.payment_method_refs SET active=true,subscription_id=coalesce(p_subscription_id,subscription_id),deactivated_at=NULL,updated_at=now()
 WHERE id=method.id RETURNING * INTO method;
 RETURN jsonb_build_object('paymentMethodRef',jsonb_build_object('id',method.id,'subscriptionId',method.subscription_id,'providerKind',method.provider_kind,
  'methodKind',method.method_kind,'providerMethodRef',method.provider_method_ref,'active',method.active));
END; $$;

CREATE FUNCTION public.payment_method_ref_link_subscription_mirror(p_idempotency_key text,p_subscription_id uuid,p_method_ref_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE method public.payment_method_refs;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR p_subscription_id IS NULL OR p_method_ref_id IS NULL THEN RAISE EXCEPTION 'payment_method_ref_link_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO method FROM public.payment_method_refs WHERE id=p_method_ref_id AND status='active' AND active AND (expires_at IS NULL OR expires_at>now());
 IF NOT FOUND THEN RAISE EXCEPTION 'payment_method_ref_link_not_active' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id) THEN RAISE EXCEPTION 'payment_method_ref_subscription_not_found' USING ERRCODE='22023'; END IF;
 INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,evidence_ref,method_kind,provider_kind)
 VALUES(p_subscription_id,'healthy',method.provider_method_ref,method.id::text,method.method_kind,method.provider_kind)
 ON CONFLICT(subscription_id) DO UPDATE SET method_ref=excluded.method_ref,evidence_ref=excluded.evidence_ref,method_kind=excluded.method_kind,provider_kind=excluded.provider_kind,updated_at=now();
 UPDATE public.payment_method_refs SET subscription_id=p_subscription_id,updated_at=now() WHERE id=method.id;
 RETURN jsonb_build_object('subscriptionMirror',jsonb_build_object('subscriptionId',p_subscription_id,'paymentMethodRef',method.provider_method_ref,'paymentMethodKind',method.method_kind,'lifecycleMutated',false));
END; $$;

-- This view is private. Bounded readers expose the evidence a caller needs.
CREATE VIEW public.subscription_method_health AS
 SELECT s.id AS subscription_id,s.client_id,s.status AS subscription_status,s.next_cycle_at,m.id AS payment_method_ref_id,
  m.provider_kind,m.method_kind,m.provider_method_ref,m.provider_customer_ref,m.consent_snapshot,m.expires_at AS method_expires_at,
  CASE WHEN m.id IS NULL THEN 'method_missing'
   WHEN m.consent_snapshot->>'recurringModel' IS NOT NULL AND m.consent_snapshot->>'recurringModel'<>'O' THEN 'mandate_not_chargeable_unattended'
   WHEN m.consent_snapshot->>'recurringModel' IS NULL AND m.method_kind<>'card' THEN 'mandate_not_chargeable_unattended'
   WHEN m.expires_at IS NOT NULL AND m.expires_at<=now()+interval '30 days' THEN 'method_expiring'
   ELSE 'healthy' END AS health_state,false AS narrow_activation_gap
 FROM public.subscriptions s LEFT JOIN public.payment_method_refs m ON m.subscription_id=s.id AND m.client_id=s.client_id AND m.status='active' AND m.active
 WHERE s.status='active';
REVOKE ALL ON TABLE public.subscription_method_health FROM PUBLIC;
CREATE FUNCTION public.subscription_method_chargeable_unattended(p_subscription_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payment_method_refs m JOIN public.subscriptions s ON s.id=m.subscription_id AND s.client_id=m.client_id
  WHERE m.subscription_id=p_subscription_id AND m.status='active' AND m.active AND
   (m.consent_snapshot->>'recurringModel'='O' OR (m.consent_snapshot->>'recurringModel' IS NULL AND m.method_kind='card')) AND (m.expires_at IS NULL OR m.expires_at>p_as_of));
$$;
CREATE FUNCTION public.subscription_method_health_read(p_subscription_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT to_jsonb(h) FROM public.subscription_method_health h WHERE subscription_id=p_subscription_id;
$$;
CREATE FUNCTION public.payment_method_ref_read(p_provider_kind text,p_provider_method_ref text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT to_jsonb(m)||jsonb_build_object('open_case_id',(SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=m.subscription_id AND status='open' ORDER BY opened_at DESC LIMIT 1))
 FROM public.payment_method_refs m WHERE provider_kind=p_provider_kind AND provider_method_ref=p_provider_method_ref;
$$;
CREATE FUNCTION public.subscription_method_uses_recorded_refs(p_subscription_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payment_method_refs WHERE subscription_id=p_subscription_id)
  OR EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=p_subscription_id AND provider_kind IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.payment_provider_states WHERE subscription_id=p_subscription_id)
  OR EXISTS(SELECT 1 FROM public.commerce_settlement_intents i JOIN public.commerce_orders o ON o.id=i.order_id
   JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id WHERE c.subscription_id=p_subscription_id AND i.channel_key<>'sandbox'
    -- A captured initial purchase can fund an explicitly sandbox renewal lane.
    -- Only its completed attachment and current terms establish that lane; all
    -- recorded provider and renewal evidence above/below still selects strict checks.
    AND NOT (c.status='paid' AND c.renewal_operation_id IS NULL AND o.renewal_operation_id IS NULL AND EXISTS(
     SELECT 1 FROM public.subscription_renewal_attachments attachment
     JOIN public.subscription_activations activation ON activation.order_id=attachment.order_id
     JOIN public.subscription_renewal_terms terms ON terms.subscription_id=attachment.subscription_id
     WHERE attachment.order_id=o.id AND attachment.subscription_id=p_subscription_id AND attachment.completed_at IS NOT NULL
      AND attachment.purchase_facts->>'settlementChannelKey'='sandbox' AND terms.settlement_channel_key='sandbox'
      AND activation.subscription_id=p_subscription_id AND activation.state='active')))
  OR EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=p_subscription_id AND cycle_snapshot->>'settlementChannelKey'<>'sandbox')
  OR EXISTS(SELECT 1 FROM public.subscription_retry_obligations o JOIN public.subscription_retry_receipts r ON r.obligation_id=o.id
   WHERE o.subscription_id=p_subscription_id AND r.kind='failure' AND r.input->>'provider' IS NOT NULL AND r.input->>'paymentAttemptId' IS NOT NULL);
$$;
CREATE FUNCTION public.payment_method_ref_for_subscription_read(p_subscription_id uuid,p_method_ref text,p_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE method public.payment_method_refs; result jsonb;
BEGIN
 SELECT m.* INTO method FROM public.payment_method_refs m JOIN public.subscriptions s ON s.id=m.subscription_id AND s.client_id=m.client_id
 WHERE m.subscription_id=p_subscription_id AND m.provider_method_ref=p_method_ref AND m.active AND m.status='active'
  AND (m.expires_at IS NULL OR m.expires_at>p_as_of) FOR SHARE OF m;
 -- Rotation does not take the subscription lock. Re-read eligibility after acquiring the method lock.
 SELECT to_jsonb(m) INTO result FROM public.payment_method_refs m JOIN public.subscriptions s ON s.id=m.subscription_id AND s.client_id=m.client_id
 WHERE m.id=method.id AND m.subscription_id=p_subscription_id AND m.provider_method_ref=p_method_ref AND m.active AND m.status='active'
  AND (m.expires_at IS NULL OR m.expires_at>p_as_of);
 RETURN result;
END;
$$;
CREATE FUNCTION public.payment_method_recovery_authority_read(p_authority_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT to_jsonb(a) FROM public.payment_method_recovery_authorities a WHERE id=p_authority_id;
$$;
CREATE FUNCTION public.payment_method_setup_resolve_owner(p_principal_id uuid,p_subscription_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE client uuid; customer text;
BEGIN
 SELECT id INTO client FROM public.clients WHERE principal_id=p_principal_id;
 IF client IS NULL OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=client) THEN RETURN NULL; END IF;
 SELECT provider_customer_ref INTO customer FROM public.payment_method_refs WHERE subscription_id=p_subscription_id ORDER BY active DESC,created_at DESC LIMIT 1;
 IF customer IS NULL OR customer='' THEN
  SELECT provider_customer_ref INTO customer FROM public.payment_method_refs WHERE client_id=client ORDER BY active DESC,created_at DESC LIMIT 1;
 END IF;
 RETURN jsonb_build_object('clientId',client,'subscriptionId',p_subscription_id,'providerCustomerRef',nullif(customer,''));
END; $$;
CREATE FUNCTION public.payment_control_mark_setup_event_processed(p_payment_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE changed integer;
BEGIN
 IF p_payment_event_id IS NULL THEN RAISE EXCEPTION 'payment_control_mark_setup_event_invalid_input' USING ERRCODE='22023'; END IF;
 UPDATE public.payment_provider_attempt_evidence SET processing_status='processed',processed_at=now() WHERE id=p_payment_event_id AND event_type LIKE 'setup.%' AND processed_at IS NULL AND processing_status='received';
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN jsonb_build_object('contractVersion','commerce.v0','setupEventProcessed',jsonb_build_object('updated',changed>0));
END; $$;

CREATE FUNCTION public.payment_method_ref_repair_subscription_scope(p_idempotency_key text,p_subscription_id uuid,p_requested_at timestamptz DEFAULT now(),p_source text DEFAULT 'renewal.scope_repair')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE scope_key constant text:='commerce.payment_method_ref.scope_repair'; fingerprint text; receipt public.payment_method_ref_receipts;
 subscription public.subscriptions; mirror public.subscription_method_states; target public.payment_method_refs; candidates integer:=0; deactivated integer:=0;
 result_status text:='skipped'; reason text; response jsonb;
BEGIN
 IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' OR p_subscription_id IS NULL OR p_requested_at IS NULL OR p_source IS NULL OR btrim(p_source)='' THEN
  RAISE EXCEPTION 'payment_method_ref_scope_repair_invalid_input' USING ERRCODE='22023'; END IF;
 fingerprint:=md5(p_subscription_id::text||'|'||btrim(p_source));
 SELECT * INTO receipt FROM public.payment_method_ref_receipts WHERE scope=scope_key AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN
  IF receipt.request_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'payment_method_ref_scope_repair_idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_set(receipt.response_payload,'{paymentMethodRefScopeRepair,replayed}','true'::jsonb,true);
 END IF;
 SELECT * INTO subscription FROM public.subscriptions WHERE id=p_subscription_id FOR UPDATE;
 SELECT * INTO mirror FROM public.subscription_method_states WHERE subscription_id=p_subscription_id;
 IF subscription.id IS NULL THEN reason:='subscription_not_found';
 ELSIF subscription.status<>'active' THEN reason:='subscription_not_active';
 ELSIF mirror.method_ref IS NULL OR btrim(mirror.method_ref)='' THEN reason:='subscription_missing_payment_method_ref';
 ELSE
  SELECT count(*)::integer INTO candidates FROM public.payment_method_refs m WHERE m.client_id=subscription.client_id
   AND m.provider_method_ref=btrim(mirror.method_ref) AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>p_requested_at)
   AND (mirror.method_kind IS NULL OR btrim(mirror.method_kind)='' OR m.method_kind=btrim(mirror.method_kind))
   AND (m.subscription_id IS NULL OR m.subscription_id=subscription.id);
  IF candidates=1 THEN
   SELECT * INTO target FROM public.payment_method_refs m WHERE m.client_id=subscription.client_id AND m.provider_method_ref=btrim(mirror.method_ref)
    AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>p_requested_at)
    AND (mirror.method_kind IS NULL OR btrim(mirror.method_kind)='' OR m.method_kind=btrim(mirror.method_kind))
    AND (m.subscription_id IS NULL OR m.subscription_id=subscription.id)
    ORDER BY (m.subscription_id=subscription.id) DESC,m.updated_at DESC,m.created_at DESC LIMIT 1 FOR UPDATE;
   IF NOT FOUND THEN reason:='candidate_race';
   ELSIF target.subscription_id=subscription.id THEN result_status:='no_op'; reason:='already_subscription_scoped';
   ELSE
    UPDATE public.payment_method_refs SET active=false,deactivated_at=coalesce(deactivated_at,p_requested_at),
     metadata=metadata||jsonb_build_object('deactivationReason','subscription_scope_repair_replaced','replacedByPaymentMethodRefId',target.id::text),updated_at=p_requested_at
     WHERE subscription_id=subscription.id AND active AND id<>target.id;
    GET DIAGNOSTICS deactivated=ROW_COUNT;
    UPDATE public.payment_method_refs SET subscription_id=subscription.id,active=true,status='active',deactivated_at=NULL,
     metadata=metadata||jsonb_build_object('subscriptionScopeRepair',jsonb_build_object('source',btrim(p_source),'repairedAt',p_requested_at,'subscriptionId',subscription.id)),updated_at=p_requested_at
     WHERE id=target.id RETURNING * INTO target;
    UPDATE public.subscription_method_states SET method_ref=target.provider_method_ref,method_kind=coalesce(nullif(btrim(method_kind),''),target.method_kind),provider_kind=target.provider_kind,updated_at=p_requested_at WHERE subscription_id=subscription.id;
    INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
     VALUES(subscription.id,'subscription.payment_method_ref_scope_repaired',p_idempotency_key||':event',jsonb_build_object('paymentMethodRefId',target.id,'providerKind',target.provider_kind,
      'methodKind',target.method_kind,'previousActiveRefsDeactivated',deactivated,'source',btrim(p_source)),p_requested_at)
     ON CONFLICT ON CONSTRAINT subscription_events_subscription_id_idempotency_key_key DO NOTHING;
    result_status:='repaired'; reason:=NULL;
   END IF;
  ELSIF candidates>1 THEN reason:='ambiguous_candidate';
  ELSIF EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=subscription.client_id AND m.provider_method_ref=btrim(mirror.method_ref)
   AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>p_requested_at)
   AND (mirror.method_kind IS NULL OR btrim(mirror.method_kind)='' OR m.method_kind=btrim(mirror.method_kind)) AND m.subscription_id IS NOT NULL AND m.subscription_id<>subscription.id) THEN reason:='wrong_subscription_owner';
  ELSIF EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id<>subscription.client_id AND m.provider_method_ref=btrim(mirror.method_ref)) THEN reason:='cross_client_candidate';
  ELSIF EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=subscription.client_id AND m.provider_method_ref=btrim(mirror.method_ref)) THEN reason:='unusable_candidate';
  ELSE reason:='no_matching_method_ref'; END IF;
 END IF;
 response:=jsonb_build_object('paymentMethodRefScopeRepair',jsonb_build_object('subscriptionId',p_subscription_id,'status',result_status,'reason',reason,
  'paymentMethodRefId',CASE WHEN result_status IN ('repaired','no_op') THEN target.id ELSE NULL END,'previousActiveRefsDeactivated',deactivated,'replayed',false));
 INSERT INTO public.payment_method_ref_receipts(scope,idempotency_key,request_fingerprint,response_payload,metadata)
 VALUES(scope_key,p_idempotency_key,fingerprint,response,jsonb_build_object('source',btrim(p_source),'subscriptionId',p_subscription_id));
 RETURN response;
END; $$;

CREATE FUNCTION public.payment_method_ref_repair_subscription_scope_batch(p_limit integer DEFAULT 100,p_apply boolean DEFAULT false,p_source text DEFAULT 'renewal.scope_repair.batch')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE source_key text:=coalesce(nullif(btrim(p_source),''),'renewal.scope_repair.batch'); row record; response jsonb; results jsonb:='[]'; counts jsonb;
 repaired integer:=0; replayed integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit<=0 OR p_limit>500 THEN RAISE EXCEPTION 'payment_method_ref_scope_repair_batch_invalid_limit' USING ERRCODE='22023'; END IF;
 WITH classified AS (
 SELECT s.id,s.updated_at,
  (SELECT count(*)::integer FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)
   AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now())
   AND (state.method_kind IS NULL OR btrim(state.method_kind)='' OR m.method_kind=btrim(state.method_kind)) AND (m.subscription_id IS NULL OR m.subscription_id=s.id)) AS safe_count,
  EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)
   AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now())
   AND (state.method_kind IS NULL OR btrim(state.method_kind)='' OR m.method_kind=btrim(state.method_kind)) AND m.subscription_id IS NULL) AS account_safe,
  EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)
   AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now())
   AND (state.method_kind IS NULL OR btrim(state.method_kind)='' OR m.method_kind=btrim(state.method_kind)) AND m.subscription_id=s.id) AS subscription_safe,
  EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)
   AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now())
   AND (state.method_kind IS NULL OR btrim(state.method_kind)='' OR m.method_kind=btrim(state.method_kind)) AND m.subscription_id IS NOT NULL AND m.subscription_id<>s.id) AS wrong_owner,
  EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id<>s.client_id AND m.provider_method_ref=btrim(state.method_ref)) AS cross_client,
  EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)) AS any_same_client
 FROM public.subscriptions s JOIN public.subscription_method_states state ON state.subscription_id=s.id WHERE s.status='active' AND state.method_ref IS NOT NULL AND btrim(state.method_ref)<>''
 ) SELECT jsonb_build_object('repairableCount',count(*) FILTER(WHERE safe_count=1 AND account_safe),
  'alreadyScopedCount',count(*) FILTER(WHERE safe_count=1 AND subscription_safe AND NOT account_safe),
  'skippedCounts',jsonb_build_object('ambiguousCandidate',count(*) FILTER(WHERE safe_count>1),
   'wrongSubscriptionOwner',count(*) FILTER(WHERE safe_count=0 AND wrong_owner),'crossClientCandidate',count(*) FILTER(WHERE safe_count=0 AND NOT wrong_owner AND cross_client),
   'unusableCandidate',count(*) FILTER(WHERE safe_count=0 AND NOT wrong_owner AND NOT cross_client AND any_same_client),
   'noMatchingMethodRef',count(*) FILTER(WHERE safe_count=0 AND NOT wrong_owner AND NOT cross_client AND NOT any_same_client))) INTO counts FROM classified;
 IF p_apply THEN
  FOR row IN SELECT s.id FROM public.subscriptions s JOIN public.subscription_method_states state ON state.subscription_id=s.id
   WHERE s.status='active' AND state.method_ref IS NOT NULL AND btrim(state.method_ref)<>'' AND
    1=(SELECT count(*) FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)
     AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now())
     AND (state.method_kind IS NULL OR btrim(state.method_kind)='' OR m.method_kind=btrim(state.method_kind)) AND (m.subscription_id IS NULL OR m.subscription_id=s.id))
    AND EXISTS(SELECT 1 FROM public.payment_method_refs m WHERE m.client_id=s.client_id AND m.provider_method_ref=btrim(state.method_ref)
     AND m.status='active' AND m.active AND (m.expires_at IS NULL OR m.expires_at>now())
     AND (state.method_kind IS NULL OR btrim(state.method_kind)='' OR m.method_kind=btrim(state.method_kind)) AND m.subscription_id IS NULL)
    ORDER BY s.updated_at,s.id LIMIT p_limit
  LOOP
   response:=public.payment_method_ref_repair_subscription_scope('payment-method-ref-scope-repair:'||row.id::text,row.id,now(),source_key);
   IF response#>>'{paymentMethodRefScopeRepair,status}'='repaired' THEN repaired:=repaired+1; END IF;
   IF response#>>'{paymentMethodRefScopeRepair,replayed}'='true' THEN replayed:=replayed+1; END IF;
   IF jsonb_array_length(results)<20 THEN results:=results||jsonb_build_array(response->'paymentMethodRefScopeRepair'); END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('paymentMethodRefScopeRepairBatch',counts||jsonb_build_object('apply',p_apply,'limit',p_limit,'source',source_key,'repairedCount',repaired,'replayedCount',replayed,'sampleResults',results));
END; $$;

CREATE FUNCTION public.subscription_try_schedule_recovery_retry(p_case_id uuid,p_payment_method_ref text,p_requested_at timestamptz DEFAULT now(),p_entry text DEFAULT 'recovery_redeem')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE case_row public.subscription_dunning_cases; subscription public.subscriptions; cycle public.subscription_cycles;
 obligation public.subscription_retry_obligations; method public.payment_method_refs; authority public.payment_method_recovery_authorities;
 bound public.payment_method_recovery_authorities; hint uuid; event_key text; inserted boolean;
BEGIN
 IF p_case_id IS NULL OR nullif(btrim(p_payment_method_ref),'') IS NULL OR p_requested_at IS NULL OR p_entry IS NULL OR p_entry NOT IN ('recovery_redeem','method_ref_webhook') THEN
  RAISE EXCEPTION 'subscription_recovery_retry_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT subscription_id INTO hint FROM public.subscription_dunning_cases WHERE id=p_case_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('scheduled',false,'reason','case_not_found'); END IF;
 SELECT * INTO subscription FROM public.subscriptions WHERE id=hint FOR UPDATE;
 SELECT * INTO case_row FROM public.subscription_dunning_cases WHERE id=p_case_id FOR UPDATE;
 IF case_row.status<>'open' OR subscription.status<>'active' THEN RETURN jsonb_build_object('scheduled',false,'reason','recovery_not_ready'); END IF;
 SELECT * INTO cycle FROM public.subscription_cycles WHERE id=case_row.cycle_id AND subscription_id=subscription.id FOR UPDATE;
 SELECT * INTO obligation FROM public.subscription_retry_obligations WHERE cycle_id=cycle.id AND case_id=case_row.id FOR UPDATE;
 IF cycle.id IS NULL OR cycle.status<>'payment_pending' THEN RETURN jsonb_build_object('scheduled',false,'reason','cycle_not_retryable'); END IF;
 IF obligation.id IS NULL THEN RETURN jsonb_build_object('scheduled',false,'reason','recovery_not_ready'); END IF;
 -- Native unpaid retries retain payment_pending; the waiting obligation owns the ladder.
 IF obligation.state<>'waiting' THEN
  RETURN jsonb_build_object('scheduled',false,'reason','cycle_not_retryable'); END IF;
 SELECT * INTO method FROM public.payment_method_refs WHERE subscription_id=subscription.id AND client_id=subscription.client_id
  AND provider_method_ref=btrim(p_payment_method_ref) AND active AND status='active' AND (expires_at IS NULL OR expires_at>now()) ORDER BY updated_at DESC LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('scheduled',false,'reason','recovery_not_ready'); END IF;
 SELECT a.* INTO authority FROM public.payment_method_recovery_authorities a JOIN public.commerce_checkout_recovery_tokens t ON t.id=a.token_id
  WHERE a.case_id=case_row.id AND a.subscription_id=subscription.id AND a.client_id=subscription.client_id AND a.cycle_id=cycle.id
   AND a.purpose='repair_payment' AND a.used_at IS NOT NULL AND a.revoked_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>p_requested_at
   AND a.retry_attempt=obligation.retry_attempt AND a.method_ref=method.provider_method_ref AND a.method_id=method.id ORDER BY a.used_at DESC,a.id DESC LIMIT 1 FOR UPDATE OF a,t;
 IF authority.id IS NULL THEN
  IF p_entry<>'method_ref_webhook' OR obligation.next_retry_at IS NULL OR obligation.retry_attempt>=4 OR obligation.failure_class='hard_do_not_retry' OR method.updated_at<case_row.opened_at THEN
   RETURN jsonb_build_object('scheduled',false,'reason','recovery_not_ready'); END IF;
 ELSE
  IF method.consent_snapshot->>'recoveryCaseId' IS DISTINCT FROM case_row.id::text OR authority.scheduled_at IS NOT NULL THEN
   RETURN jsonb_build_object('scheduled',false,'reason','recovery_not_ready'); END IF;
 END IF;
 event_key:='payment-recovery-retry:'||case_row.id::text;
 IF obligation.next_retry_at IS NULL OR obligation.retry_attempt>=4 THEN event_key:=event_key||':token:'||authority.token_id::text;
 ELSIF authority.id IS NOT NULL AND obligation.method_recovery_authority_id IS NOT NULL AND obligation.method_recovery_authority_id<>authority.id THEN
  SELECT * INTO bound FROM public.payment_method_recovery_authorities WHERE id=obligation.method_recovery_authority_id AND case_id=case_row.id FOR UPDATE;
  IF bound.retry_attempt IS DISTINCT FROM obligation.retry_attempt OR bound.id IS NULL OR bound.dispatch_key IS NULL THEN
   event_key:=event_key||':token:'||authority.token_id::text;
  END IF;
 END IF;
 INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
 VALUES(subscription.id,'subscription.retry_scheduled',event_key,jsonb_build_object('caseId',case_row.id,'source','subscription.payment_recovery',
  'reason','payment_method_recovered','entry',p_entry,'recoveryTokenId',authority.token_id),p_requested_at)
 ON CONFLICT ON CONSTRAINT subscription_events_subscription_id_idempotency_key_key DO NOTHING;
 inserted:=FOUND;
 IF NOT inserted THEN RETURN jsonb_build_object('scheduled',false,'reason','already_scheduled'); END IF;
 IF authority.id IS NOT NULL THEN
  UPDATE public.payment_method_recovery_authorities SET scheduled_at=now(),method_id=method.id WHERE id=authority.id;
  UPDATE public.subscription_retry_obligations SET method_recovery_authority_id=authority.id WHERE id=obligation.id;
 END IF;
 INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,evidence_ref,method_kind,provider_kind)
 VALUES(subscription.id,'healthy',method.provider_method_ref,method.id::text,method.method_kind,method.provider_kind)
 ON CONFLICT(subscription_id) DO UPDATE SET method_ref=excluded.method_ref,evidence_ref=excluded.evidence_ref,method_kind=excluded.method_kind,provider_kind=excluded.provider_kind,updated_at=now();
 UPDATE public.subscription_retry_obligations SET next_retry_at=now(),renewal_quarantined_until=NULL,renewal_row_error_key=NULL,renewal_row_error_count=0,updated_at=now() WHERE id=obligation.id;
 UPDATE public.subscription_dunning_cases SET next_retry_at=now(),updated_at=now() WHERE id=case_row.id;
 RETURN jsonb_build_object('scheduled',true,'entry',p_entry,'reason','ready');
END; $$;
CREATE FUNCTION public.payment_method_recovery_authority_bind(p_operation_id uuid,p_token_id uuid,p_method text,p_evidence text,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.subscription_retry_obligations; t public.commerce_checkout_recovery_tokens;
 real_authority public.payment_method_recovery_authorities; method public.payment_method_refs;
BEGIN
 IF p_now IS NULL THEN RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;

  SELECT * INTO t FROM public.commerce_checkout_recovery_tokens WHERE id=p_token_id FOR UPDATE;
  SELECT * INTO real_authority FROM public.payment_method_recovery_authorities WHERE token_id=p_token_id FOR UPDATE;
  SELECT mr.* INTO method FROM public.payment_method_refs mr JOIN public.subscriptions sub ON sub.id=mr.subscription_id AND sub.client_id=mr.client_id
   WHERE mr.subscription_id=o.subscription_id AND mr.provider_method_ref=p_method AND mr.active AND mr.status='active' AND (mr.expires_at IS NULL OR mr.expires_at>p_now);
  IF o.id IS NULL OR o.case_id IS NULL OR o.state<>'waiting' OR t.id IS NULL OR t.order_id<>o.order_id OR t.client_id IS DISTINCT FROM method.client_id OR
   t.revoked_at IS NOT NULL OR t.expires_at<=p_now OR real_authority.id IS NULL OR real_authority.case_id<>o.case_id OR real_authority.cycle_id<>o.cycle_id OR
   real_authority.revoked_at IS NOT NULL OR method.id IS NULL OR btrim(coalesce(p_evidence,''))='' OR
   NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE id=o.case_id AND status='open') THEN
   RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
  IF real_authority.used_at IS NOT NULL THEN
   IF real_authority.retry_attempt IS DISTINCT FROM o.retry_attempt OR real_authority.method_ref IS DISTINCT FROM p_method OR real_authority.method_id IS DISTINCT FROM method.id OR real_authority.method_evidence_ref IS DISTINCT FROM p_evidence THEN
    RAISE EXCEPTION 'subscription_retry_authorization_conflict' USING ERRCODE='23505'; END IF;
   RETURN to_jsonb(real_authority);
  END IF;
  UPDATE public.payment_method_recovery_authorities SET used_at=p_now,retry_attempt=o.retry_attempt,method_ref=p_method,method_id=method.id,method_evidence_ref=p_evidence WHERE id=real_authority.id RETURNING * INTO real_authority;
  RETURN to_jsonb(real_authority);
END; $$;

CREATE FUNCTION public.payment_method_recovery_authority_record(p_token_id uuid,p_case_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t public.commerce_checkout_recovery_tokens; c public.subscription_dunning_cases;
BEGIN
 SELECT * INTO c FROM public.subscription_dunning_cases WHERE id=p_case_id;
 SELECT * INTO t FROM public.commerce_checkout_recovery_tokens WHERE id=p_token_id;
 IF t.id IS NULL OR c.id IS NULL OR c.status<>'open' OR t.client_id IS DISTINCT FROM c.client_id OR
  NOT EXISTS(SELECT 1 FROM public.commerce_orders WHERE id=t.order_id AND subscription_cycle_id=c.cycle_id) THEN
  RAISE EXCEPTION 'payment_method_recovery_authority_context_mismatch' USING ERRCODE='22023'; END IF;
 INSERT INTO public.payment_method_recovery_authorities(token_id,client_id,subscription_id,cycle_id,case_id,order_id)
 VALUES(t.id,c.client_id,c.subscription_id,c.cycle_id,c.id,t.order_id) ON CONFLICT(token_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.payment_method_recovery_authorities WHERE token_id=t.id AND case_id=c.id AND cycle_id=c.cycle_id
  AND client_id=c.client_id AND subscription_id=c.subscription_id AND order_id=t.order_id) THEN
  RAISE EXCEPTION 'payment_method_recovery_authority_context_mismatch' USING ERRCODE='22023'; END IF;
END; $$;

CREATE FUNCTION public.payment_method_recovery_authority_freeze(p_authority_id uuid,p_operation_id uuid,p_dispatch_key text,p_method_ref text,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.subscription_retry_obligations; a public.payment_method_recovery_authorities;
 t public.commerce_checkout_recovery_tokens; method public.payment_method_refs;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO a FROM public.payment_method_recovery_authorities WHERE id=p_authority_id FOR UPDATE;
 SELECT * INTO t FROM public.commerce_checkout_recovery_tokens WHERE id=a.token_id FOR UPDATE;
 SELECT * INTO method FROM jsonb_populate_record(NULL::public.payment_method_refs,
  public.payment_method_ref_for_subscription_read(o.subscription_id,p_method_ref,p_now));
 IF p_now IS NULL OR nullif(btrim(p_dispatch_key),'') IS NULL OR o.id IS NULL OR a.id IS NULL OR o.state<>'prepared' OR
  o.method_recovery_authority_id IS DISTINCT FROM a.id OR a.case_id IS DISTINCT FROM o.case_id OR a.cycle_id IS DISTINCT FROM o.cycle_id OR
  a.subscription_id IS DISTINCT FROM o.subscription_id OR a.retry_attempt IS DISTINCT FROM o.retry_attempt OR a.used_at IS NULL OR a.scheduled_at IS NULL OR
  a.revoked_at IS NOT NULL OR a.dispatch_key IS NOT NULL OR a.method_ref IS DISTINCT FROM p_method_ref OR
  method.id IS NULL OR a.method_id IS DISTINCT FROM method.id OR t.id IS NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=p_now THEN
  RAISE EXCEPTION 'payment_method_recovery_authority_dispatch_mismatch' USING ERRCODE='22023'; END IF;
 UPDATE public.payment_method_recovery_authorities SET dispatch_key=p_dispatch_key WHERE id=a.id;
END; $$;

CREATE OR REPLACE FUNCTION public.subscription_command_preview(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text;
 core jsonb; addons jsonb; requested jsonb; lines jsonb; cadence integer; version integer;
 total bigint; current_total bigint; quote_key text; quote_hash text; answer jsonb; reason text;
 v_noop boolean:=false; core_matches boolean; addon_matches boolean;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_payload ? 'acceptedQuoteHash' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload-'acceptedQuoteHash');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 -- Serialize the actor/key even when competing commands target different rows.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key;
 IF FOUND THEN
  IF jsonb_set(r.command,'{payload}',(r.command->'payload')-'acceptedQuoteHash')<>command THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  RETURN r.result;
 END IF;
 <<preview_command>>
 BEGIN
  IF p_action='slide_next_cycle' THEN
   BEGIN
    v_noop:=s.status='active' AND s.next_cycle_at IS NOT NULL
     AND floor(extract(epoch FROM NULLIF(p_payload->>'newNextCycleAt','')::timestamptz)/86400)
      =floor(extract(epoch FROM s.next_cycle_at)/86400);
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
   END;
   IF v_noop IS NOT TRUE THEN
    RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
   END IF;
  ELSE
  IF p_action NOT IN ('update_bundle','resize_bundle','update_package_template','update_plan_length',
    'add_addon','remove_addon','update_addon_quantity') THEN
   RAISE EXCEPTION 'subscription_command_preview_unsupported' USING ERRCODE='22023';
  END IF;
  IF s.status<>'active' THEN RAISE EXCEPTION 'subscription_command_not_active' USING ERRCODE='22023'; END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  IF s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
   RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
  END IF;
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  version:=(p_payload->>'expectedTemplateVersion')::integer;
  IF version IS NULL OR version<>s.template_version THEN
   RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
  END IF;
  cadence:=CASE WHEN p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length')
   THEN COALESCE((p_payload->>'cadenceDays')::integer,(p_payload->>'planDays')::integer,s.cadence_days) ELSE s.cadence_days END;
  IF cadence NOT BETWEEN 1 AND 90 OR s.price_list_id IS NULL OR s.currency_code IS NULL THEN
   RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('variantId',variant_id,'qty',quantity) ORDER BY sort_order,id)
   FILTER(WHERE NOT is_addon),'[]'),COALESCE(jsonb_agg(jsonb_build_object('variantId',variant_id,'qty',quantity)
   ORDER BY sort_order,id) FILTER(WHERE is_addon),'[]'),COALESCE(sum(quantity*unit_price_minor),0)
   INTO core,addons,current_total FROM public.subscription_lines WHERE subscription_id=s.id;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template') THEN
   IF p_payload->'compositionConstraint' IS NULL OR jsonb_typeof(p_payload->'compositionConstraint')<>'object'
    OR (p_payload->'compositionConstraint') ?| ARRAY['version','data'] THEN
    RAISE EXCEPTION 'subscription_command_invalid_composition_constraint' USING ERRCODE='22023';
   END IF;
  END IF;
  -- Compare donor line sets by UUID and summed quantity, independently of order/prices.
  SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
   INTO core_matches,addon_matches FROM (
    SELECT is_addon,jsonb_typeof(wanted)='array' AND
     (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
       SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wanted)='array' THEN wanted ELSE '[]' END) v
       WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$'
       GROUP BY (v->>'variantId')::uuid) desired)
     =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
       SELECT variant_id,sum(quantity) qty FROM public.subscription_lines
       WHERE subscription_id=s.id AND is_addon=inputs.is_addon GROUP BY variant_id) stored)
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(wanted)='array' THEN wanted ELSE '[]' END) v
       WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') matches
    FROM (VALUES(false,p_payload->'coreLines'),(true,COALESCE(p_payload->'addonLines','[]'))) inputs(is_addon,wanted)
   ) line_sets;
  IF p_action IN ('add_addon','update_addon_quantity') THEN
   v_noop:=EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id
    AND variant_id=NULLIF(p_payload->>'variantId','')::uuid AND is_addon
    AND quantity=CASE WHEN p_action='add_addon' THEN GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))
     ELSE (p_payload->>'qty')::integer END);
  ELSIF p_action='update_bundle' THEN
   v_noop:=core_matches AND cadence=s.cadence_days AND (NOT p_payload ? 'addonLines' OR addon_matches);
  ELSIF p_action='resize_bundle' THEN
   v_noop:=core_matches AND cadence=s.cadence_days;
  ELSIF p_action='update_plan_length' THEN
   v_noop:=cadence=s.cadence_days AND core_matches;
  ELSIF p_action='update_package_template' THEN
   v_noop:=cadence=s.cadence_days AND core_matches AND addon_matches;
  END IF;
  END IF;
  IF v_noop THEN
   answer:=jsonb_build_object('status','noop','subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
    'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',NULL);
   EXIT preview_command;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template') THEN
   core:=p_payload->'coreLines';
   IF p_action='update_package_template' OR (p_action='update_bundle' AND p_payload ? 'addonLines') THEN
    addons:=COALESCE(p_payload->'addonLines','[]');
   END IF;
   IF p_action='update_bundle' AND cadence=s.cadence_days AND
    (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<>
    (SELECT COALESCE(sum(quantity),0) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
    RAISE EXCEPTION 'subscription_command_bundle_total_mismatch' USING ERRCODE='22023';
   END IF;
  ELSIF p_action='update_plan_length' THEN
   core:=COALESCE(p_payload->'coreLines',core);
  ELSIF p_action='add_addon' THEN
   addons:=addons||jsonb_build_array(jsonb_build_object('variantId',p_payload->>'variantId','qty',GREATEST(1,COALESCE((p_payload->>'qty')::integer,1))));
  ELSIF p_action IN ('remove_addon','update_addon_quantity') THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(addons) v WHERE v->>'variantId'=lower(p_payload->>'variantId')) THEN
    RAISE EXCEPTION 'subscription_command_addon_not_found' USING ERRCODE='22023';
   END IF;
   SELECT COALESCE(jsonb_agg(CASE WHEN v->>'variantId'=lower(p_payload->>'variantId') THEN
    jsonb_set(v,'{qty}',p_payload->'qty') ELSE v END),'[]') INTO addons
    FROM jsonb_array_elements(addons) v WHERE p_action<>'remove_addon' OR v->>'variantId'<>lower(p_payload->>'variantId');
  END IF;
  IF core IS NULL OR jsonb_typeof(core)<>'array' OR jsonb_array_length(core) NOT BETWEEN 1 AND 6
   OR addons IS NULL OR jsonb_typeof(addons)<>'array' OR jsonb_array_length(addons)>12 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023';
  END IF;
  requested:=core||addons;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(requested) v WHERE jsonb_typeof(v)<>'object'
    OR COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR COALESCE(v->>'qty','') !~ '^[0-9]{1,2}$' OR (v->>'qty')::integer NOT BETWEEN 1 AND 99)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(requested) v GROUP BY lower(v->>'variantId') HAVING count(*)>1) THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023';
  END IF;
  -- Same catalogue price selection as the existing customer bundle preview.
  SELECT jsonb_agg(jsonb_build_object('variantId',sku.id,'quantity',(v->>'qty')::integer,
    'isAddon',ord>jsonb_array_length(core),'sortOrder',ord-1,'unitPriceMinor',price.unit_price_minor,'currency',s.currency_code)
    ORDER BY ord),sum(price.unit_price_minor*(v->>'qty')::integer)
   INTO lines,total FROM jsonb_array_elements(requested) WITH ORDINALITY x(v,ord)
   JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid AND sku.status='active' AND sku.sellable_in_subscription
   LEFT JOIN LATERAL (SELECT unit_price_minor FROM public.price_entries pe WHERE pe.variant_id=sku.id
    AND pe.price_list_id=s.price_list_id AND pe.mode IN ('subscription','any') AND pe.active
    AND pe.min_qty<=(v->>'qty')::integer AND pe.valid_from<=p_now AND (pe.valid_to IS NULL OR pe.valid_to>p_now)
    ORDER BY CASE pe.mode WHEN 'subscription' THEN 0 ELSE 1 END,pe.min_qty DESC,pe.valid_from DESC,pe.id LIMIT 1) price ON true;
  IF lines IS NULL OR jsonb_array_length(lines)<>jsonb_array_length(requested)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) v WHERE v->'unitPriceMinor'='null') THEN
   RAISE EXCEPTION 'subscription_edit_catalog_unavailable' USING ERRCODE='22023';
  END IF;
  quote_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  quote_hash:=encode(sha256(convert_to(quote_key||':'||fingerprint||':'||lines::text||':'||(p_now+interval '15 minutes')::text,'UTF8')),'hex');
  INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,quote_hash,
   expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
   VALUES(s.id,quote_key,fingerprint,quote_hash,version,lines,cadence,current_total,total,s.currency_code,p_now+interval '15 minutes') RETURNING * INTO q;
  answer:=jsonb_build_object('status','previewed','canApply',true,'quoteHash',q.quote_hash,'quoteExpiresAt',q.expires_at,
   'templateVersion',version,'lines',lines,'currentTotalMinor',current_total,'newTotalMinor',total,
   'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only'));
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  answer:=jsonb_build_object('status','refused','canApply',false,'reason',reason);
 END;
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,q.quote_hash,answer,answer->>'status');
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_command_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,
 p_payload jsonb,p_now timestamptz,p_terms jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
<<apply_command>>
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 q public.subscription_edit_quotes%ROWTYPE; command jsonb; fingerprint text; quote_fingerprint text; answer jsonb;
 reason text; event_id uuid; event_key text; line jsonb; target timestamptz; outcome text:='applied'; term_key text;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR p_action IS NULL THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
 END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 quote_fingerprint:=encode(sha256(convert_to(jsonb_set(command,'{payload}',p_payload-'acceptedQuoteHash')::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF r.command_fingerprint<>(CASE WHEN r.status='previewed' THEN quote_fingerprint ELSE fingerprint END)
   OR r.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict');
  END IF;
  IF r.status<>'previewed' THEN
   IF r.status='refused' THEN RETURN r.result; END IF;
   RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status);
  END IF;
 END IF;
 event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
 BEGIN
  IF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel','order_now','reactivate') THEN
  IF p_terms IS NULL OR jsonb_typeof(p_terms) IS DISTINCT FROM 'object'
    OR p_terms - ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays'] <> '{}'::jsonb
    OR NOT (p_terms ?& ARRAY['pauseDays','pauseMonths','slideMinDays','slideMaxDays','orderNowDelayMinutes','reactivateDelayDays']) THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  FOR term_key IN SELECT jsonb_object_keys(p_terms) LOOP
    IF jsonb_typeof(p_terms->term_key) IS DISTINCT FROM 'number'
      OR NOT coalesce(p_terms->>term_key ~ '^[1-9][0-9]*$',false)
      OR (p_terms->>term_key)::numeric > 2147483647 THEN
      RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (p_terms->>'slideMinDays')::integer > (p_terms->>'slideMaxDays')::integer THEN
    RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023';
  END IF;
  END IF;
  IF p_action='pause' THEN
   PERFORM public.subscription_pause_close_recovery(p_client_id,event_key,s.id,p_now);
  END IF;
  IF p_action<>'cancel' AND EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') THEN
   RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
  END IF;
  -- Take the same subscription lock as claim first, then the future
  -- terms and every line. A previously deferred operation keeps its snapshot.
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id FOR UPDATE;
  PERFORM 1 FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id ORDER BY line_ordinal FOR UPDATE;
  -- Existing preparation owns the operation before it inserts a cycle. Do
  -- not wait in the reverse lock order: refuse a busy operation, or a live
  -- pre-payment lease whose worker could still prepare after this command.
  IF p_action IN ('cancel','resume','skip_next_cycle','slide_next_cycle','order_now','reactivate')
   AND NOT (p_action='slide_next_cycle' AND floor(extract(epoch FROM (p_payload->>'newNextCycleAt')::timestamptz)/86400)
     =floor(extract(epoch FROM s.next_cycle_at)/86400)) THEN
   BEGIN
    PERFORM 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id ORDER BY id FOR UPDATE NOWAIT;
   EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'subscription_command_operation_busy' USING ERRCODE='22023';
   END;
   IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
     AND (state='attempt_prepared' OR (state IN ('claimed','reserved') AND lease_expires_at>p_now))) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
  END IF;
  IF p_action IN ('update_bundle','resize_bundle','update_package_template','update_plan_length','add_addon','remove_addon','update_addon_quantity') THEN
   IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   SELECT * INTO q FROM public.subscription_edit_quotes WHERE subscription_id=s.id AND idempotency_key=event_key FOR UPDATE;
   IF NOT FOUND OR q.quote_hash IS DISTINCT FROM (p_payload->>'acceptedQuoteHash') THEN
    RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023';
   END IF;
   IF q.request_fingerprint<>quote_fingerprint OR s.template_version<>q.expected_template_version THEN
    RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023';
   END IF;
   IF q.status<>'previewed' OR q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
   IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>=s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=q.currency_code) THEN
    RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023';
   END IF;
   IF (SELECT jsonb_agg(jsonb_build_object('lineOrdinal',(v->>'sortOrder')::integer+1,'sku',sku.sku,
      'quantity',(v->>'quantity')::integer,'unitAmountMinor',(v->>'unitPriceMinor')::bigint) ORDER BY (v->>'sortOrder')::integer)
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid)
     =(SELECT jsonb_agg(jsonb_build_object('lineOrdinal',line_ordinal,'sku',sku,'quantity',quantity,'unitAmountMinor',unit_amount_minor)
       ORDER BY line_ordinal) FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id)
    AND s.cadence_days=q.proposed_cadence_days AND q.proposed_lines=(SELECT COALESCE(jsonb_agg(jsonb_build_object(
     'variantId',variant_id,'quantity',quantity,'isAddon',is_addon,'sortOrder',sort_order,'unitPriceMinor',unit_price_minor,'currency',currency_code)
     ORDER BY sort_order,id),'[]') FROM public.subscription_lines WHERE subscription_id=s.id) THEN
    outcome:='noop';
   ELSE
    DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
    FOR line IN SELECT value FROM jsonb_array_elements(q.proposed_lines) LOOP
     INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES(s.id,(line->>'variantId')::uuid,(line->>'quantity')::integer,(line->>'sortOrder')::integer,
       (line->>'isAddon')::boolean,(line->>'unitPriceMinor')::bigint,q.currency_code);
    END LOOP;
    DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
    INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
     SELECT s.id,(v->>'sortOrder')::integer+1,sku.sku,(v->>'quantity')::integer,(v->>'unitPriceMinor')::bigint
      FROM jsonb_array_elements(q.proposed_lines) v JOIN public.catalog_skus sku ON sku.id=(v->>'variantId')::uuid;
    UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
    UPDATE public.subscriptions SET cadence_days=q.proposed_cadence_days,template_version=template_version+1,updated_at=p_now
     WHERE id=s.id RETURNING * INTO s;
   END IF;
  ELSIF p_action IN ('order_now','reactivate') THEN
   IF p_payload->'confirmedChargeTiming' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'subscription_command_charge_timing_not_confirmed' USING ERRCODE='22023';
   END IF;
   IF NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END)
    OR NOT EXISTS(SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id) THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   IF (p_action='order_now' AND (s.status<>'active' OR s.next_cycle_at IS NULL))
    OR (p_action='reactivate' AND s.status<>'cancelled') THEN
    RAISE EXCEPTION 'subscription_lifecycle_invalid_transition' USING ERRCODE='22023';
   END IF;
   PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
   IF p_action='order_now' AND p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
    RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023';
   END IF;
   target:=p_now+CASE p_action WHEN 'order_now' THEN make_interval(mins=>(p_terms->>'orderNowDelayMinutes')::integer)
    ELSE make_interval(days=>(p_terms->>'reactivateDelayDays')::integer) END;
   UPDATE public.subscriptions SET status='active',next_cycle_at=target,ended_at=NULL,cancellation_reason=NULL,
    template_version=template_version+CASE WHEN p_action='reactivate' THEN 1 ELSE 0 END,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  ELSIF p_action IN ('pause','resume','skip_next_cycle','slide_next_cycle','cancel') THEN
   IF p_action='cancel' THEN
    IF EXISTS(SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=s.id
      AND attempt_prepared_at IS NOT NULL AND state NOT IN ('succeeded','refused'))
     OR EXISTS(SELECT 1 FROM public.subscription_retry_obligations WHERE subscription_id=s.id AND state='prepared') THEN
     RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
    END IF;
    UPDATE public.subscription_dunning_notifications SET status='skipped',recovery_url_path=NULL,
     error='subscription_cancelled',updated_at=p_now WHERE status='queued' AND case_id IN
      (SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open');
    UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=p_now WHERE revoked_at IS NULL AND order_id IN
      (SELECT orders.id FROM public.commerce_orders orders JOIN public.subscription_dunning_cases cases
        ON cases.cycle_id=orders.subscription_cycle_id WHERE cases.subscription_id=s.id AND cases.status='open');
    UPDATE public.subscription_dunning_cases SET status='cancelled',next_retry_at=NULL,updated_at=p_now
     WHERE subscription_id=s.id AND status='open';
   END IF;
   IF p_action IN ('skip_next_cycle','slide_next_cycle') AND NOT EXISTS(
    SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
    RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023';
   END IF;
   -- Do not move away from a current payment obligation on resume.
   IF p_action='resume' AND s.status='paused' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_resumed','skipped');
   END IF;
   IF p_action='resume' THEN PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at); END IF;
   IF p_action='cancel' THEN
    -- Operation locks above fence every worker; only elapsed, never-prepared
    -- obligations may be cancelled here. Paid/ambiguous commitments stay owned.
    UPDATE public.fulfillment_inventory_reservations stock_hold SET status='released',expires_at=NULL,
     terminal_reason='subscription_cancelled',updated_at=p_now
     FROM public.subscription_renewal_operations op WHERE op.subscription_id=s.id
      AND stock_hold.renewal_operation_id=op.id AND stock_hold.status='held'
      AND op.state IN ('claimed','reserved') AND op.attempt_prepared_at IS NULL
      AND op.external_attempt_ref IS NULL;
    UPDATE public.subscription_renewal_operations SET state='refused',terminal_outcome='refused',
     terminal_reason='subscription_cancelled',terminal_at=p_now,updated_at=p_now
     WHERE subscription_id=s.id AND state IN ('claimed','reserved') AND attempt_prepared_at IS NULL
      AND external_attempt_ref IS NULL;
   END IF;
   answer:=public.subscription_apply_lifecycle_action(p_client_id,event_key,s.id,p_action,p_payload,p_now,p_terms);
   IF p_action='cancel' THEN
    PERFORM public.subscription_terminalize_unpaid_artifacts(s.id,p_now,'subscription_cancelled','cancelled');
   END IF;
   outcome:=answer#>>'{subscriptionAction,status}';
   event_id:=(answer#>>'{subscriptionAction,eventId}')::uuid;
   SELECT * INTO s FROM public.subscriptions WHERE id=s.id;
  ELSE
   RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023';
  END IF;
  IF answer IS NULL AND outcome='applied' THEN
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
    VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'payload',p_payload,
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
    RETURNING id INTO event_id;
  END IF;
  IF q.id IS NOT NULL AND outcome='applied' THEN
   UPDATE public.subscription_edit_quotes SET status='accepted',accepted_event_id=event_id,accepted_at=p_now WHERE id=q.id;
  END IF;
  answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
   'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 EXCEPTION WHEN SQLSTATE '22023' OR invalid_text_representation OR numeric_value_out_of_range THEN
  GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
  answer:=jsonb_build_object('status','refused','reason',reason);
 END;
 IF r.id IS NULL THEN
  INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
   VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload->>'acceptedQuoteHash',answer,answer->>'status');
 ELSE
  UPDATE public.subscription_command_receipts SET command_fingerprint=fingerprint,command=apply_command.command,result=answer,status=answer->>'status'
   WHERE id=r.id;
 END IF;
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_auto_resume_due(
  p_limit integer,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
 v_row record; v_subscription public.subscriptions; v_next_cycle_at timestamptz;
 v_event_id uuid; v_scanned integer:=0; v_resumed integer:=0;
 v_skipped integer:=0; v_failed integer:=0;
BEGIN
 FOR v_row IN
  SELECT w.id AS pause_window_id,w.subscription_id,w.pause_preset,w.starts_at,w.ends_at
  FROM public.subscription_pause_windows w JOIN public.subscriptions s ON s.id=w.subscription_id
  WHERE s.status='paused' AND w.resumed_at IS NULL AND w.ends_at IS NOT NULL AND w.ends_at<=p_now
  ORDER BY w.ends_at,w.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),500)
  FOR UPDATE OF s,w SKIP LOCKED
 LOOP
  v_scanned:=v_scanned+1;
  BEGIN
   SELECT * INTO v_subscription FROM public.subscriptions WHERE id=v_row.subscription_id FOR UPDATE;
   IF NOT FOUND OR v_subscription.status<>'paused'
    OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(v_row.subscription_id) THEN public.subscription_method_chargeable_unattended(v_row.subscription_id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=v_row.subscription_id AND ms.health_state='healthy') END)
    OR v_subscription.next_cycle_at IS NULL OR coalesce(v_subscription.cadence_days,0)<=0
    OR NOT EXISTS(SELECT 1 FROM public.subscription_lines l WHERE l.subscription_id=v_row.subscription_id)
    OR EXISTS(SELECT 1 FROM public.subscription_dunning_cases c WHERE c.subscription_id=v_row.subscription_id AND c.status='open')
    OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=v_row.subscription_id
      AND c.status='paid' AND c.scheduled_at=v_subscription.next_cycle_at)
    -- The native obligation keeps retry/failed state on a payment_pending cycle.
    OR EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=v_row.subscription_id AND c.status='payment_pending')
    OR EXISTS(SELECT 1 FROM public.commerce_orders o LEFT JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id
      WHERE (c.subscription_id=v_row.subscription_id
       OR EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=o.renewal_operation_id AND op.subscription_id=v_row.subscription_id)
       OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id AND a.subscription_id=v_row.subscription_id))
       AND o.status IN ('paid','fulfillment_pending','fulfilled')
       AND ((c.subscription_id=v_row.subscription_id AND c.scheduled_at=v_subscription.next_cycle_at)
        OR (o.subscription_cycle_id IS NULL AND (
         EXISTS(SELECT 1 FROM public.subscription_renewal_operations op WHERE op.id=o.renewal_operation_id
          AND op.state NOT IN ('succeeded','refused'))
         OR EXISTS(SELECT 1 FROM public.subscription_activations a WHERE a.order_id=o.id
          AND a.state NOT IN ('active','compensated'))))))
   THEN
    v_skipped:=v_skipped+1;
    CONTINUE;
   END IF;
   v_next_cycle_at:=GREATEST(v_subscription.next_cycle_at+(v_row.ends_at-v_row.starts_at),p_now);
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(v_row.subscription_id,'subscription.system.auto_resume','subscription_auto_resume:'||v_row.pause_window_id::text,
    jsonb_build_object('action','auto_resume','pauseWindowId',v_row.pause_window_id,'pausePreset',v_row.pause_preset,
     'resumeAt',v_row.ends_at,'nextCycleAt',v_next_cycle_at,'policy',jsonb_build_object(
      'requiresPaymentMethod',true,'blocksOpenDunning',true,'blocksLockedUpcomingCycle',true)),p_now)
   ON CONFLICT(subscription_id,idempotency_key) DO NOTHING RETURNING id INTO v_event_id;
   UPDATE public.subscriptions SET status='active',next_cycle_at=v_next_cycle_at,updated_at=p_now WHERE id=v_row.subscription_id;
   UPDATE public.subscription_pause_windows SET resumed_at=p_now,updated_at=p_now,event_id=coalesce(v_event_id,event_id)
    WHERE id=v_row.pause_window_id AND resumed_at IS NULL;
   v_resumed:=v_resumed+1;
  EXCEPTION WHEN OTHERS THEN
   v_failed:=v_failed+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('ok',v_failed=0,'scanned',v_scanned,'resumed',v_resumed,'skippedRows',v_skipped,'failed',v_failed);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_package_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 core jsonb; addons jsonb; stored jsonb; line_pricing jsonb; constraint_value jsonb;
 plan integer; version integer; minimum_text text; minimum_units integer; line jsonb; ordinal integer:=0;
 core_matches boolean; addon_matches boolean; outcome text:='applied';
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,
  'action','update_package_template','payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 core:=p_payload->'baseLines'; addons:=COALESCE(p_payload->'addonLines','[]'::jsonb);
 IF jsonb_typeof(core) IS DISTINCT FROM 'array' OR jsonb_array_length(core)=0 OR jsonb_typeof(addons)<>'array' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT value_text INTO minimum_text FROM public.commerce_settings WHERE key='subscription_minimum_base_units';
 IF minimum_text IS NULL OR minimum_text !~ '^[1-9][0-9]*$' OR length(minimum_text)>10 THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END IF;
 BEGIN minimum_units:=minimum_text::integer;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END;
 IF (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<minimum_units THEN
  RAISE EXCEPTION 'subscription_edit_below_minimum_order_units' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 -- Bind the fingerprinted customer request to its server enrichment. Nominal
 -- cadence/version are intentionally server-resolved; price evidence is ledger-bound below.
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,base}'),
  public.subscription_quote_variant_qty_request(p_payload->'base'));
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,addons}'),
  public.subscription_quote_variant_qty_request(p_payload->'addons'));
 plan:=(p_payload->>'planDays')::integer;
 -- Set equality is order/price independent and aggregates repeated variants.
 SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
 INTO core_matches,addon_matches FROM (
  SELECT is_addon,jsonb_typeof(wanted)='array' AND
   (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
    SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$' GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id
     AND is_addon=inputs.is_addon GROUP BY variant_id) current_lines)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') AS matches
  FROM (VALUES(false,core),(true,addons)) inputs(is_addon,wanted)
 ) line_sets;
 IF plan=s.cadence_days AND core_matches AND addon_matches THEN outcome:='noop';
 ELSE
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,'update_package_template',
   p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'planDays',q#>'{request_payload,planDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'base'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,base}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'addons'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,addons}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(core),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,baseLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(addons),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,addonLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'currentRecurringPrice',q#>'{totals,currentRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'newRecurringPrice',q#>'{totals,newRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'delta',q#>'{totals,delta}');
  IF plan IS NULL OR plan<1 THEN RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023'; END IF;
  constraint_value:=q#>'{quote_snapshot,compositionConstraint}';
  IF constraint_value IS NULL THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  IF p_payload ? 'compositionConstraint' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',constraint_value);
  END IF;
  constraint_value:=NULLIF(constraint_value,'null'::jsonb);
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  line_pricing:='[]'::jsonb;
  FOR line IN SELECT v||jsonb_build_object('isAddon',ord>jsonb_array_length(core))
   FROM jsonb_array_elements(core||addons) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
    (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,
   template_version=template_version+1,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.update_package_template',event_key,
    jsonb_build_object('action','update_package_template','quotePreviewId',q->>'id','linePricing',line_pricing,
     'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action','update_package_template','subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_line_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_action text,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 lines jsonb; line jsonb; line_pricing jsonb:='[]'::jsonb; constraint_value jsonb;
 version integer; plan integer; ordinal integer:=0; target_id uuid; new_line_id uuid;
 base_matches boolean; outcome text:='applied'; base_set boolean;
 current_total bigint; desired_total bigint;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('swap_base_line','add_addon','remove_addon','update_addon_quantity',
  'update_plan_length','update_base_mix','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',p_action,'payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,action}',to_jsonb(p_action));
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 lines:=p_payload->'lines';
 base_set:=p_action IN ('update_plan_length','update_base_mix','update_portion');
 IF base_set AND jsonb_typeof(lines)='array' THEN
  SELECT (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
   SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(lines) v
   WHERE (v->>'isAddon')::boolean=false GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon
     GROUP BY variant_id) current_lines) INTO base_matches;
 END IF;
 IF p_action='swap_base_line' THEN
  IF (p_payload#>>'{request,fromVariantId}')::uuid=(p_payload#>>'{request,toVariantId}')::uuid THEN outcome:='noop'; END IF;
 ELSIF p_action IN ('add_addon','update_addon_quantity') THEN
  IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon
   AND variant_id=(p_payload#>>'{request,variantId}')::uuid AND quantity=(p_payload#>>'{request,qty}')::integer) THEN outcome:='noop'; END IF;
 ELSIF p_action='update_base_mix' THEN
  IF base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_plan_length' THEN
  IF (p_payload#>>'{request,planDays}')::integer=s.cadence_days AND base_matches THEN outcome:='noop'; END IF;
 ELSIF p_action='update_portion' THEN
  IF base_matches AND COALESCE(s.composition_constraint->>'mode',p_payload#>>'{portionModes,full,mode}')=p_payload#>>'{request,portionMode}'
   AND COALESCE(s.composition_constraint->'portionFactor',p_payload#>'{portionModes,full,factor}')=p_payload#>'{compositionConstraint,portionFactor}' THEN outcome:='noop'; END IF;
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,p_action,p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal((p_payload->'request')-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0 THEN
   RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'compositionConstraint',q#>'{quote_snapshot,compositionConstraint}');
  plan:=s.cadence_days; constraint_value:=s.composition_constraint;
  IF p_action='swap_base_line' THEN
   IF EXISTS(SELECT 1 FROM public.subscription_lines WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,toVariantId}')::uuid) THEN
    RAISE EXCEPTION 'subscription_edit_conflict_duplicate_line' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET variant_id=(p_payload#>>'{request,toVariantId}')::uuid,updated_at=p_now
    WHERE subscription_id=s.id AND variant_id=(p_payload#>>'{request,fromVariantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_line' USING ERRCODE='22023'; END IF;
  ELSIF p_action='add_addon' THEN
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(p_payload#>>'{request,variantId}')::uuid,GREATEST(1,COALESCE((p_payload#>>'{request,qty}')::integer,1)),
    COALESCE((SELECT max(sort_order)+1 FROM public.subscription_lines WHERE subscription_id=s.id),1),true,0,s.currency_code)
   RETURNING id INTO new_line_id;
  ELSIF p_action='remove_addon' THEN
   DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_addon_quantity' THEN
   IF (p_payload#>>'{request,qty}')::integer IS NULL OR (p_payload#>>'{request,qty}')::integer<=0 THEN
    RAISE EXCEPTION 'subscription_edit_invalid_addon_qty' USING ERRCODE='22023'; END IF;
   UPDATE public.subscription_lines SET quantity=(p_payload#>>'{request,qty}')::integer,updated_at=p_now
    WHERE subscription_id=s.id AND is_addon AND variant_id=(p_payload#>>'{request,variantId}')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_not_found_addon' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_plan_length' THEN
   plan:=(p_payload#>>'{request,planDays}')::integer;
   IF plan IS NULL OR plan<=0 THEN RAISE EXCEPTION 'subscription_edit_invalid_plan_length' USING ERRCODE='22023'; END IF;
   constraint_value:=NULLIF(q#>'{quote_snapshot,compositionConstraint}','null'::jsonb);
  ELSIF p_action='update_base_mix' THEN
   SELECT COALESCE(sum(quantity),0) INTO current_total FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
   SELECT COALESCE(sum((v->>'qty')::integer),0) INTO desired_total FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
   IF desired_total<>current_total THEN RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
  ELSIF p_action='update_portion' THEN
   PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'portionModes',q#>'{quote_snapshot,portionModes}');
   IF p_payload#>>'{request,portionMode}' IS NULL OR
    (p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,full,mode}'
     AND p_payload#>>'{request,portionMode}' IS DISTINCT FROM p_payload#>>'{portionModes,reduced,mode}')
    OR p_payload#>>'{compositionConstraint,mode}' IS DISTINCT FROM p_payload#>>'{request,portionMode}'
    OR jsonb_typeof(p_payload#>'{compositionConstraint,portionFactor}') IS DISTINCT FROM 'number'
    OR (p_payload#>>'{compositionConstraint,portionFactor}')::numeric<=0
    OR p_payload#>'{compositionConstraint,portionFactor}' IS DISTINCT FROM (CASE
      WHEN p_payload#>>'{request,portionMode}'=p_payload#>>'{portionModes,full,mode}' THEN p_payload#>'{portionModes,full,factor}'
      ELSE p_payload#>'{portionModes,reduced,factor}' END) THEN
    RAISE EXCEPTION 'subscription_edit_invalid_portion_mode' USING ERRCODE='22023'; END IF;
   constraint_value:=jsonb_set(jsonb_set(COALESCE(s.composition_constraint,'{}'::jsonb),'{mode}',p_payload#>'{compositionConstraint,mode}'),
    '{portionFactor}',p_payload#>'{compositionConstraint,portionFactor}');
  END IF;
  IF base_set THEN DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon; END IF;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF base_set AND NOT (line->>'isAddon')::boolean THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
    VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,false,
     (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code) RETURNING id INTO target_id;
   ELSE
    target_id:=COALESCE((line->>'lineId')::uuid,new_line_id);
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
     currency_code=s.currency_code,updated_at=p_now WHERE id=target_id AND subscription_id=s.id
     AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer AND is_addon=(line->>'isAddon')::boolean;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||p_action,event_key,jsonb_build_object('action',p_action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',p_action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_sized_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 action text; request jsonb; command jsonb; fingerprint text; answer jsonb; q jsonb; lines jsonb; line jsonb;
 event_id uuid; event_key text; line_pricing jsonb:='[]'::jsonb; version integer; plan integer; ordinal integer:=0;
 constraint_value jsonb; opt_in boolean; intro jsonb; phase_config jsonb; paid integer;
 current_core jsonb; desired_core jsonb; outcome text:='applied'; rewrites_addons boolean;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'request') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 request:=p_payload->'request'; action:=request->>'action';
 IF action IS NULL OR action NOT IN ('resize_bundle','update_bundle','update_base_mix','update_plan_length','update_portion') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,'action',action,'payload',request);
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM request->>'acceptedQuoteHash' THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 opt_in:=action='resize_bundle' AND request#>>'{resizeLever,kind}'='subscription.sized.parcel'
  AND request#>'{resizeLever,value,optInToSized}'='true'::jsonb;
 IF s.configured_offer_version<>'sized.v1' AND NOT (s.configured_offer_version='classic' AND COALESCE(opt_in,false)) THEN
  RAISE EXCEPTION 'subscription_edit_invalid_offer_binding' USING ERRCODE='22023'; END IF;
 intro:=public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}';
 IF intro IS NOT NULL THEN
  SELECT value_text::jsonb INTO phase_config FROM public.commerce_settings WHERE key='subscription_sized_intro_phase';
  IF phase_config IS NULL OR COALESCE(phase_config->>'fixedThroughCycle','') !~ '^[1-9][0-9]*$'
   OR COALESCE(phase_config->>'graduationCycle','') !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION 'subscription_edit_invalid_sized_configuration' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO paid FROM public.subscription_cycles WHERE subscription_id=s.id AND status='paid';
  IF paid+1<=(phase_config->>'fixedThroughCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
  IF COALESCE(opt_in,false) AND s.template_version=(intro->>'basisTemplateVersion')::integer
   AND paid<(phase_config->>'graduationCycle')::integer THEN
   RAISE EXCEPTION 'subscription_edit_invalid_intro_fixed' USING ERRCODE='22023'; END IF;
 END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT (CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE EXISTS(SELECT 1 FROM public.subscription_method_states ms WHERE ms.subscription_id=s.id AND ms.health_state='healthy') END) THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(request->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(request->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 lines:=p_payload->'lines'; constraint_value:=p_payload->'compositionConstraint'; plan:=(p_payload->>'cadenceDays')::integer;
 IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines)=0
  OR jsonb_typeof(constraint_value) IS DISTINCT FROM 'object' OR plan IS NULL OR plan<=0 THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) INTO current_core FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon;
 SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb) INTO desired_core FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean;
 rewrites_addons:=action='update_bundle' AND request ? 'addonLines';
 IF action IN ('update_base_mix','update_bundle') AND (action='update_base_mix' OR plan=s.cadence_days)
  AND (SELECT sum((v->>'qty')::integer) FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean)
   <>(SELECT sum(quantity) FROM public.subscription_lines WHERE subscription_id=s.id AND NOT is_addon) THEN
  RAISE EXCEPTION 'subscription_edit_base_total_mismatch' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(opt_in,false) AND current_core=desired_core AND plan=s.cadence_days AND constraint_value=s.composition_constraint
  AND (NOT rewrites_addons OR (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean)=(SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb)
    FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon)) THEN outcome:='noop';
 END IF;
 IF outcome<>'noop' THEN
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,action,request->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(request-ARRAY['expectedTemplateVersion','acceptedQuoteHash'],
   (q->'request_payload')-ARRAY['expectedTemplateVersion','acceptedQuoteHash']);
  PERFORM public.subscription_quote_assert_jsonb_equal(
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord)),
   (SELECT jsonb_agg((v-'quoteLine')||jsonb_build_object('quoteLine',public.subscription_quote_line_projection(v->'quoteLine')) ORDER BY ord)
    FROM jsonb_array_elements(q#>'{quote_snapshot,lines}') WITH ORDINALITY x(v,ord)));
  PERFORM public.subscription_quote_assert_jsonb_equal(constraint_value,q#>'{quote_snapshot,compositionConstraint}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'cadenceDays',q#>'{quote_snapshot,cadenceDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'subjectFacts',q#>'{quote_snapshot,subjectFacts}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'optInFacts',q#>'{quote_snapshot,optInFacts}');
  -- Admission is current SKU state under a row lock; no catalogue publication head exists here.
  FOR line IN SELECT v FROM jsonb_array_elements(lines) v WHERE NOT (v->>'isAddon')::boolean LOOP
   IF COALESCE(opt_in,false) OR (line->>'qty')::integer>COALESCE((current_core->>(line->>'variantId'))::integer,0) THEN
    PERFORM 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND status='active' AND sellable_in_subscription FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_invalid_sku_admission' USING ERRCODE='22023'; END IF;
   END IF;
  END LOOP;
  IF NOT rewrites_addons AND (SELECT COALESCE(jsonb_object_agg((v->>'variantId')::uuid,(v->>'qty')::integer),'{}'::jsonb)
   FROM jsonb_array_elements(lines) v WHERE (v->>'isAddon')::boolean) IS DISTINCT FROM
   (SELECT COALESCE(jsonb_object_agg(variant_id,quantity),'{}'::jsonb) FROM public.subscription_lines WHERE subscription_id=s.id AND is_addon) THEN
   RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id AND (NOT is_addon OR rewrites_addons);
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  FOR line IN SELECT v FROM jsonb_array_elements(lines) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   IF line#>>'{quoteLine,unitPriceGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>>'{quoteLine,lineSubtotalGross,currency}' IS DISTINCT FROM s.currency_code
    OR line#>'{quoteLine,quantity}' IS DISTINCT FROM line->'qty'
    OR line#>'{quoteLine,lineSubtotalGross,amountMinor}' IS DISTINCT FROM to_jsonb((line->>'qty')::bigint*(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint)
    OR NOT EXISTS(SELECT 1 FROM public.catalog_skus WHERE id=(line->>'variantId')::uuid AND sku=line#>>'{quoteLine,sku}') THEN
    RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   IF NOT (line->>'isAddon')::boolean OR rewrites_addons THEN
    INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
     VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
      (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   ELSE
    UPDATE public.subscription_lines SET unit_price_minor=(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,updated_at=p_now
     WHERE subscription_id=s.id AND id=(line->>'lineId')::uuid AND is_addon AND variant_id=(line->>'variantId')::uuid AND quantity=(line->>'qty')::integer;
    IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
   END IF;
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    VALUES(s.id,ordinal,line#>>'{quoteLine,sku}',(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint);
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}','quantity',(line->>'qty')::integer,
    'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,template_version=template_version+1,updated_at=p_now
   WHERE id=s.id RETURNING * INTO s;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  -- AFTER-row triggers run at statement end. The CTE makes native FK-bound
  -- acceptance visible before the binding trigger checks the accepted join.
  WITH inserted AS (
   INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.'||action,event_key,jsonb_build_object('action',action,'quotePreviewId',q->>'id',
    'linePricing',line_pricing,'payload',request-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],'optInFacts',p_payload->'optInFacts',
    'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now) RETURNING id
   ), accepted AS MATERIALIZED (
    SELECT id,public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,id,p_now) AS acceptance FROM inserted
   ) SELECT id INTO event_id FROM accepted;
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action',action,'subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
  VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,request->>'acceptedQuoteHash',answer,outcome);
 RETURN answer;
END;
$$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_scan_at_risk(
  p_min_days integer,
  p_max_days integer,
  p_limit integer
)
RETURNS TABLE (
  subscription_id uuid,
  client_id uuid,
  next_cycle_at timestamptz,
  health_state text
)
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
WITH candidates AS (
    SELECT s.id AS subscription_id,s.client_id,s.next_cycle_at,m.health_state FROM public.subscriptions s
    JOIN LATERAL jsonb_to_record(CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_health_read(s.id) ELSE (SELECT to_jsonb(legacy) FROM public.subscription_method_states legacy WHERE legacy.subscription_id=s.id) END) m(health_state text,narrow_activation_gap boolean) ON true
    WHERE s.status='active' AND NOT m.narrow_activation_gap AND m.health_state IN ('mandate_not_chargeable_unattended','method_missing')
      AND s.next_cycle_at>=now()+make_interval(hours=>24*coalesce(p_min_days,0)) AND s.next_cycle_at<=now()+make_interval(hours=>24*coalesce(p_max_days,0))
    ORDER BY s.next_cycle_at LIMIT greatest(coalesce(p_limit,1),1)
  ) SELECT c.* FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases d WHERE d.subscription_id=c.subscription_id AND d.status='open');
$$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_renewal_reminder_enqueue(p_limit integer,p_renewal_min_seconds integer,p_renewal_max_seconds integer,p_ordinary_freshness_seconds integer,p_starter_freshness_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_enqueued integer;
BEGIN
  IF p_renewal_min_seconds IS NULL OR p_renewal_min_seconds<=0 OR p_renewal_max_seconds IS NULL OR p_renewal_max_seconds<=0 OR p_ordinary_freshness_seconds IS NULL OR p_ordinary_freshness_seconds<=0 OR p_starter_freshness_seconds IS NULL OR p_starter_freshness_seconds<=0 OR p_renewal_min_seconds>p_renewal_max_seconds THEN RAISE EXCEPTION 'subscription_notice_options_invalid'; END IF;
  WITH due AS (
    SELECT s.id AS subscription_id,s.next_cycle_at AS renewal_at,(s.next_cycle_at AT TIME ZONE 'UTC')::date AS reminder_day
    FROM public.subscriptions s LEFT JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id
    WHERE s.status='active'
      AND s.next_cycle_at>=now()+make_interval(secs=>p_renewal_min_seconds)
      AND s.next_cycle_at<=now()+make_interval(secs=>p_renewal_max_seconds)
      -- Active-method eligibility is intentionally distinct from unattended chargeability.
      AND CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN
        public.subscription_method_health_read(s.id)->>'payment_method_ref_id' IS NOT NULL
        ELSE EXISTS(SELECT 1 FROM public.subscription_method_states legacy WHERE legacy.subscription_id=s.id AND legacy.health_state IN ('healthy','mandate_not_chargeable_unattended')) END
      AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles c WHERE c.subscription_id=s.id AND c.status IN ('payment_pending','retry_scheduled'))
      AND s.updated_at<now()-make_interval(secs=>CASE WHEN
        jsonb_typeof(public.subscription_renewal_purchase_terms(s.id)#>'{renewalTerms,starterPack}')='object'
        AND EXISTS(SELECT 1 FROM public.subscription_activations a JOIN public.commerce_orders o ON o.id=a.order_id JOIN public.subscription_cycles ac ON ac.id=o.subscription_cycle_id
          WHERE a.subscription_id=s.id AND ac.status='paid')
        AND (SELECT count(*) FROM public.subscription_cycles pc WHERE pc.subscription_id=s.id AND pc.status='paid' AND pc.scheduled_at<s.next_cycle_at)=t.next_cycle_number
        AND (SELECT count(*)+1 FROM public.subscription_cycles c WHERE c.subscription_id=s.id) IN (2,3)
        THEN p_starter_freshness_seconds ELSE p_ordinary_freshness_seconds END)
    ORDER BY s.next_cycle_at,s.id LIMIT greatest(coalesce(p_limit,1),1) FOR UPDATE OF s SKIP LOCKED
  ), written AS (
    INSERT INTO public.subscription_reminder_ledger(subscription_id,reminder_kind,reminder_day,renewal_at)
    SELECT subscription_id,'renewal_due_soon',reminder_day,renewal_at FROM due
    ON CONFLICT ON CONSTRAINT subscription_reminder_ledger_subscription_kind_day_key DO NOTHING RETURNING id
  ) SELECT count(*)::integer INTO v_enqueued FROM written;
  RETURN jsonb_build_object('enqueued',v_enqueued);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_register_renewal_purchase(p_order_id uuid, p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_line jsonb; v_key text;
  v_activation public.subscription_activations; v_order public.commerce_orders;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_renewal_purchase_order_missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_activation.state='compensated' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_not_declared' USING ERRCODE='22023'; END IF;
  IF p_facts IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR p_facts - ARRAY['settlementChannelKey','authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef',
      'methodRef','methodEvidenceRef','stockSourceKey','templateId','cadenceDays','currency',
      'lines','shippingAmountMinor','acquisitionRef'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['settlementChannelKey','authorizationRef','methodRef','methodEvidenceRef','stockSourceKey','templateId'] LOOP
    IF jsonb_typeof(p_facts->v_key) IS DISTINCT FROM 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (p_facts->>'settlementChannelKey' IS DISTINCT FROM 'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_method_refs mr WHERE mr.client_id=v_order.client_id AND mr.provider_kind=p_facts->>'settlementChannelKey' AND mr.provider_method_ref=p_facts->>'methodRef' AND mr.id::text=p_facts->>'methodEvidenceRef' AND mr.active AND mr.status='active' AND (mr.expires_at IS NULL OR mr.expires_at>now()))) OR p_facts->>'stockSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_facts->>'currency' !~ '^[A-Z]{3}$' OR p_facts->>'currency' IS NULL
    OR NOT coalesce(p_facts->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
    OR jsonb_typeof(p_facts->'cadenceDays') IS DISTINCT FROM 'number'
    OR (p_facts->>'cadenceDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
    OR NOT coalesce(p_facts->>'shippingAmountMinor' ~ '^[0-9]+$',false)
    OR jsonb_typeof(p_facts->'shippingAmountMinor') IS DISTINCT FROM 'number'
    OR (p_facts->>'shippingAmountMinor')::numeric <> 0
    OR jsonb_typeof(p_facts->'unattendedChargeAuthorizedAt') IS DISTINCT FROM 'string'
    OR NOT isfinite((p_facts->>'unattendedChargeAuthorizedAt')::timestamptz)
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['payerAccountRef','acquisitionRef'] LOOP
    IF NOT (p_facts ? v_key) OR (p_facts->v_key <> 'null'::jsonb AND
      (jsonb_typeof(p_facts->v_key) <> 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180)) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(p_facts->'lines') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_facts->'lines') LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'] <> '{}'::jsonb
      OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
      OR NOT coalesce(v_line->>'lineOrdinal' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
      OR jsonb_typeof(v_line->'lineOrdinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number'
      OR (v_line->>'lineOrdinal')::numeric > 2147483647 OR (v_line->>'quantity')::numeric > 2147483647
      OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT count(DISTINCT (value->>'lineOrdinal')::integer) FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT sum((value->>'quantity')::numeric*(value->>'unitAmountMinor')::numeric) FROM jsonb_array_elements(p_facts->'lines')) NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND AND v_row.purchase_facts IS NOT NULL THEN
    IF v_row.purchase_facts IS DISTINCT FROM p_facts THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',p_order_id,'replayed',true);
  END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts)
    VALUES(p_order_id,v_activation.subscription_id,p_facts)
    ON CONFLICT(order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts;
  RETURN jsonb_build_object('orderId',p_order_id,'replayed',false);
END; $$;

CREATE OR REPLACE FUNCTION public.subscription_register_renewal_purchase_with_shipping(p_order_id uuid, p_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_line jsonb; v_key text;
  v_activation public.subscription_activations; v_order public.commerce_orders;
  v_terms jsonb; v_shipping jsonb; v_marker jsonb; v_delivery jsonb; v_graduation jsonb;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_renewal_purchase_order_missing' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_activation.state='compensated' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_not_declared' USING ERRCODE='22023'; END IF;
  IF p_facts IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR p_facts - ARRAY['settlementChannelKey','authorizationRef','unattendedChargeAuthorizedAt','payerAccountRef',
      'methodRef','methodEvidenceRef','stockSourceKey','templateId','cadenceDays','currency',
      'lines','shippingAmountMinor','acquisitionRef','renewalTerms'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['settlementChannelKey','authorizationRef','methodRef','methodEvidenceRef','stockSourceKey','templateId'] LOOP
    IF jsonb_typeof(p_facts->v_key) IS DISTINCT FROM 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (p_facts->>'settlementChannelKey' IS DISTINCT FROM 'sandbox' AND NOT EXISTS(SELECT 1 FROM public.payment_method_refs mr WHERE mr.client_id=v_order.client_id AND mr.provider_kind=p_facts->>'settlementChannelKey' AND mr.provider_method_ref=p_facts->>'methodRef' AND mr.id::text=p_facts->>'methodEvidenceRef' AND mr.active AND mr.status='active' AND (mr.expires_at IS NULL OR mr.expires_at>now()))) OR p_facts->>'stockSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    OR p_facts->>'currency' !~ '^[A-Z]{3}$' OR p_facts->>'currency' IS NULL
    OR NOT coalesce(p_facts->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
    OR jsonb_typeof(p_facts->'cadenceDays') IS DISTINCT FROM 'number'
    OR (p_facts->>'cadenceDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
    OR NOT coalesce(p_facts->>'shippingAmountMinor' ~ '^[0-9]+$',false)
    OR jsonb_typeof(p_facts->'shippingAmountMinor') IS DISTINCT FROM 'number'
    OR (p_facts->>'shippingAmountMinor')::numeric > 9007199254740991
    OR jsonb_typeof(p_facts->'unattendedChargeAuthorizedAt') IS DISTINCT FROM 'string'
    OR NOT isfinite((p_facts->>'unattendedChargeAuthorizedAt')::timestamptz)
    OR jsonb_typeof(p_facts->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['payerAccountRef','acquisitionRef'] LOOP
    IF NOT (p_facts ? v_key) OR (p_facts->v_key <> 'null'::jsonb AND
      (jsonb_typeof(p_facts->v_key) <> 'string' OR char_length(btrim(p_facts->>v_key)) NOT BETWEEN 1 AND 180)) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF jsonb_array_length(p_facts->'lines') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_facts->'lines') LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['lineOrdinal','sku','quantity','unitAmountMinor'] <> '{}'::jsonb
      OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
      OR NOT coalesce(v_line->>'lineOrdinal' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
      OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
      OR jsonb_typeof(v_line->'lineOrdinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number'
      OR (v_line->>'lineOrdinal')::numeric > 2147483647 OR (v_line->>'quantity')::numeric > 2147483647
      OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT count(DISTINCT (value->>'lineOrdinal')::integer) FROM jsonb_array_elements(p_facts->'lines')) <> jsonb_array_length(p_facts->'lines')
    OR (SELECT sum((value->>'quantity')::numeric*(value->>'unitAmountMinor')::numeric) FROM jsonb_array_elements(p_facts->'lines')) NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
  IF p_facts ? 'renewalTerms' THEN
    v_terms:=p_facts->'renewalTerms';
    IF jsonb_typeof(v_terms) IS DISTINCT FROM 'object' OR v_terms->>'version' IS DISTINCT FROM 'native.renewal-terms.v1'
      OR v_terms - ARRAY['version','shippingTerms','starterPack','minimumPayableMinor','normalCadenceDays','linePricing'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    IF v_terms ? 'shippingTerms' THEN
      v_shipping:=v_terms->'shippingTerms';
      IF jsonb_typeof(v_shipping) IS DISTINCT FROM 'object' OR v_shipping->>'version' IS DISTINCT FROM 'shipping-threshold.v1'
        OR v_shipping->>'currency' IS DISTINCT FROM p_facts->>'currency'
        OR v_shipping - ARRAY['version','currency','flatMinor','freeThresholdMinor'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOREACH v_key IN ARRAY ARRAY['flatMinor','freeThresholdMinor'] LOOP
        IF jsonb_typeof(v_shipping->v_key) IS DISTINCT FROM 'number' OR NOT coalesce(v_shipping->>v_key ~ '^[0-9]+$',false)
          OR (v_shipping->>v_key)::numeric > 2147483647 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
    IF v_terms ? 'minimumPayableMinor' AND (jsonb_typeof(v_terms->'minimumPayableMinor') IS DISTINCT FROM 'number'
      OR NOT coalesce(v_terms->>'minimumPayableMinor' ~ '^[1-9][0-9]*$',false)
      OR (v_terms->>'minimumPayableMinor')::numeric > 9007199254740991) THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    IF v_terms ? 'normalCadenceDays' THEN
      IF jsonb_typeof(v_terms->'normalCadenceDays') IS DISTINCT FROM 'array' OR jsonb_array_length(v_terms->'normalCadenceDays')=0 THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_terms->'normalCadenceDays') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'number' OR NOT coalesce(v_line#>>'{}' ~ '^[1-9][0-9]*$',false)
          OR (v_line#>>'{}')::numeric > 2147483647 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
    END IF;
    IF v_terms ? 'linePricing' THEN
      IF jsonb_typeof(v_terms->'linePricing') IS DISTINCT FROM 'array' OR jsonb_array_length(v_terms->'linePricing')>100 THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_terms->'linePricing') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['sku','quantity','unitAmountMinor','isAddon','quoteLine'] <> '{}'::jsonb
          OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
          OR jsonb_typeof(v_line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_line->'quoteLine') IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'quantity' ~ '^[1-9][0-9]*$',false)
          OR (v_line->>'quantity')::numeric > 2147483647
          OR jsonb_typeof(v_line->'unitAmountMinor') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'unitAmountMinor' ~ '^[0-9]+$',false)
          OR (v_line->>'unitAmountMinor')::numeric > 9007199254740991 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'sku') FROM jsonb_array_elements(v_terms->'linePricing')) <> jsonb_array_length(v_terms->'linePricing') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
    END IF;
    IF v_terms ? 'starterPack' THEN
      v_marker:=v_terms->'starterPack';
      IF jsonb_typeof(v_marker) IS DISTINCT FROM 'object' OR v_marker->>'schemaVersion' IS DISTINCT FROM '1'
        OR v_marker - ARRAY['schemaVersion','starterIntervalDays','basisTemplateVersion','delivery2','graduation'] <> '{}'::jsonb
        OR jsonb_typeof(v_marker->'starterIntervalDays') IS DISTINCT FROM 'number'
        OR NOT coalesce(v_marker->>'starterIntervalDays' ~ '^[1-9][0-9]*$',false)
        OR (v_marker->>'starterIntervalDays')::numeric IS DISTINCT FROM v_activation.cadence_days::numeric
        OR NOT (v_terms ? 'minimumPayableMinor') OR NOT (v_terms ? 'normalCadenceDays') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      v_delivery:=v_marker->'delivery2';
      IF jsonb_typeof(v_delivery) IS DISTINCT FROM 'object' OR v_delivery - ARRAY['discountBps','discountMinor','basisSubtotalMinor'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOREACH v_key IN ARRAY ARRAY['discountBps','discountMinor','basisSubtotalMinor'] LOOP
        IF jsonb_typeof(v_delivery->v_key) IS DISTINCT FROM 'number' OR NOT coalesce(v_delivery->>v_key ~ '^[0-9]+$',false)
          OR (v_delivery->>v_key)::numeric > 9007199254740991 THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      IF (v_delivery->>'discountBps')::numeric > 10000
        OR (v_delivery->>'basisSubtotalMinor')::numeric-(v_delivery->>'discountMinor')::numeric < (v_terms->>'minimumPayableMinor')::numeric THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      v_graduation:=v_marker->'graduation';
      IF jsonb_typeof(v_graduation) IS DISTINCT FROM 'object' OR v_graduation - ARRAY['cadenceDays','lines','sizeConstraint'] <> '{}'::jsonb
        OR jsonb_typeof(v_graduation->'cadenceDays') IS DISTINCT FROM 'number'
        OR NOT coalesce(v_graduation->>'cadenceDays' ~ '^[1-9][0-9]*$',false)
        OR NOT (v_terms->'normalCadenceDays' @> jsonb_build_array(v_graduation->'cadenceDays'))
        OR jsonb_typeof(v_graduation->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_graduation->'lines') NOT BETWEEN 1 AND 100
        OR (v_graduation ? 'sizeConstraint' AND jsonb_typeof(v_graduation->'sizeConstraint') IS DISTINCT FROM 'object') THEN
        RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      FOR v_line IN SELECT value FROM jsonb_array_elements(v_graduation->'lines') LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR v_line - ARRAY['sku','qty','sortOrder','isAddon','quoteLine'] <> '{}'::jsonb
          OR jsonb_typeof(v_line->'sku') IS DISTINCT FROM 'string' OR char_length(btrim(v_line->>'sku')) NOT BETWEEN 1 AND 180
          OR jsonb_typeof(v_line->'qty') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'qty' ~ '^[1-9][0-9]*$',false)
          OR (v_line->>'qty')::numeric > 99
          OR jsonb_typeof(v_line->'sortOrder') IS DISTINCT FROM 'number' OR NOT coalesce(v_line->>'sortOrder' ~ '^[0-9]+$',false)
          OR jsonb_typeof(v_line->'isAddon') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_line->'quoteLine') IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_line#>'{quoteLine,unitPriceGross,amountMinor}') IS DISTINCT FROM 'number'
          OR NOT coalesce(v_line#>>'{quoteLine,unitPriceGross,amountMinor}' ~ '^[0-9]+$',false)
          OR (v_line#>>'{quoteLine,unitPriceGross,amountMinor}')::numeric > 9007199254740991
          OR jsonb_typeof(v_line#>'{quoteLine,lineSubtotalGross,amountMinor}') IS DISTINCT FROM 'number'
          OR (v_line#>>'{quoteLine,lineSubtotalGross,amountMinor}')::numeric IS DISTINCT FROM
             (v_line#>>'{quoteLine,unitPriceGross,amountMinor}')::numeric*(v_line->>'qty')::numeric THEN
          RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023'; END IF;
      END LOOP;
      -- The activation writer always creates the acquisition template at version one.
      p_facts:=jsonb_set(p_facts,'{renewalTerms,starterPack,basisTemplateVersion}','1'::jsonb);
    END IF;
  ELSIF (p_facts->>'shippingAmountMinor')::numeric <> 0 THEN
    RAISE EXCEPTION 'subscription_renewal_purchase_invalid' USING ERRCODE='22023';
  END IF;
  p_facts:=jsonb_set(p_facts,'{unattendedChargeAuthorizedAt}',to_jsonb(to_char(
    (p_facts->>'unattendedChargeAuthorizedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND AND v_row.purchase_facts IS NOT NULL THEN
    IF jsonb_set(v_row.purchase_facts,'{unattendedChargeAuthorizedAt}',to_jsonb(to_char(
      (v_row.purchase_facts->>'unattendedChargeAuthorizedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) IS DISTINCT FROM p_facts THEN
      RAISE EXCEPTION 'subscription_renewal_purchase_conflict' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('orderId',p_order_id,'replayed',true);
  END IF;
  INSERT INTO public.subscription_renewal_attachments(order_id,subscription_id,purchase_facts)
    VALUES(p_order_id,v_activation.subscription_id,p_facts)
    ON CONFLICT(order_id) DO UPDATE SET purchase_facts=excluded.purchase_facts;
  RETURN jsonb_build_object('orderId',p_order_id,'replayed',false);
END; $$;

CREATE OR REPLACE FUNCTION public.subscription_complete_renewal_attachment(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_row public.subscription_renewal_attachments; v_activation public.subscription_activations; v_facts jsonb;
BEGIN
  PERFORM 1 FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  SELECT * INTO v_activation FROM public.subscription_activations WHERE order_id=p_order_id FOR UPDATE;
  SELECT * INTO v_row FROM public.subscription_renewal_attachments WHERE order_id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_row.subscription_id IS NULL OR v_activation.state IS DISTINCT FROM 'active' OR v_row.purchase_facts IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_attachment_not_ready' USING ERRCODE='22023'; END IF;
  IF v_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',true); END IF;
  v_facts:=v_row.purchase_facts;
  INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,
    unattended_charge_authorized_at,authorization_ref,payer_account_ref)
    VALUES(v_row.subscription_id,v_facts->>'currency',v_facts->>'stockSourceKey',v_facts->>'settlementChannelKey',
      (v_facts->>'unattendedChargeAuthorizedAt')::timestamptz,v_facts->>'authorizationRef',v_facts->>'payerAccountRef');
  INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
    SELECT v_row.subscription_id,(value->>'lineOrdinal')::integer,value->>'sku',(value->>'quantity')::integer,
      (value->>'unitAmountMinor')::bigint FROM jsonb_array_elements(v_facts->'lines');
  INSERT INTO public.subscription_method_states(subscription_id,health_state,method_ref,evidence_ref)
    VALUES(v_row.subscription_id,'healthy',v_facts->>'methodRef',v_facts->>'methodEvidenceRef');
  IF v_facts->>'settlementChannelKey'<>'sandbox' THEN
    PERFORM public.payment_method_ref_switch_active('purchase:'||p_order_id::text,(v_facts->>'methodEvidenceRef')::uuid,v_row.subscription_id);
    PERFORM public.payment_method_ref_link_subscription_mirror('purchase:'||p_order_id::text,v_row.subscription_id,(v_facts->>'methodEvidenceRef')::uuid);
  END IF;
  INSERT INTO public.subscription_method_state_events(event_key,subscription_id,input)
    VALUES('purchase:'||p_order_id::text,v_row.subscription_id,jsonb_build_object('methodRef',v_facts->>'methodRef',
      'healthState','healthy','evidenceRef',v_facts->>'methodEvidenceRef'));
  UPDATE public.subscription_renewal_attachments SET completed_at=now() WHERE order_id=p_order_id;
  RETURN jsonb_build_object('subscriptionId',v_row.subscription_id,'replayed',false);
END; $$;

CREATE OR REPLACE FUNCTION public.dunning_lifecycle_issue_recovery_token(
  p_case_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_case public.subscription_dunning_cases;
  v_order_id uuid;
BEGIN
  SELECT * INTO v_case FROM public.subscription_dunning_cases WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_dunning_case_not_found';
  END IF;

  SELECT o.id INTO v_order_id
  FROM public.commerce_orders AS o
  WHERE o.subscription_cycle_id = v_case.cycle_id
    AND o.status = 'pending_payment'
  ORDER BY o.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'refused', 'recoverable_order_unavailable');
  END IF;

  UPDATE public.commerce_checkout_recovery_tokens
  SET revoked_at = now()
  WHERE order_id = v_order_id AND revoked_at IS NULL;

  INSERT INTO public.commerce_checkout_recovery_tokens (
    order_id, client_id, token_hash, expires_at
  ) VALUES (v_order_id, v_case.client_id, p_token_hash, p_expires_at)
  ON CONFLICT ON CONSTRAINT commerce_checkout_recovery_tokens_token_hash_key DO NOTHING;

  PERFORM public.payment_method_recovery_authority_record(t.id,v_case.id)
  FROM public.commerce_checkout_recovery_tokens t WHERE t.token_hash=p_token_hash AND t.order_id=v_order_id;
  RETURN jsonb_build_object('issued', true, 'orderId', v_order_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_retry_authorize_recovery(p_operation_id uuid,p_token_id uuid,p_method text,p_evidence text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; t public.commerce_checkout_recovery_tokens;
 a public.subscription_retry_recovery_authorizations;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 IF public.subscription_method_uses_recorded_refs(o.subscription_id) THEN
  RETURN public.payment_method_recovery_authority_bind(p_operation_id,p_token_id,p_method,p_evidence,p_now);
 END IF;
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=o.id AND retry_attempt=o.retry_attempt;
 IF a.id IS NOT NULL THEN
  IF a.token_id<>p_token_id OR a.method_ref IS DISTINCT FROM p_method OR a.method_evidence_ref IS DISTINCT FROM p_evidence THEN
   RAISE EXCEPTION 'subscription_retry_authorization_conflict' USING ERRCODE='23505'; END IF;
  RETURN to_jsonb(a);
 END IF;
 SELECT * INTO t FROM public.commerce_checkout_recovery_tokens WHERE id=p_token_id FOR UPDATE;
 IF o.id IS NULL OR o.case_id IS NULL OR o.state<>'waiting' OR t.id IS NULL OR t.order_id<>o.order_id OR
  t.client_id IS DISTINCT FROM (SELECT client_id FROM public.subscriptions WHERE id=o.subscription_id) OR
  t.revoked_at IS NOT NULL OR t.expires_at<=p_now OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy') OR btrim(COALESCE(p_method,''))='' OR btrim(COALESCE(p_evidence,''))='' OR
  NOT EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE id=o.case_id AND status='open') THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 INSERT INTO public.subscription_retry_recovery_authorizations(obligation_id,token_id,retry_attempt,method_ref,method_evidence_ref,authorized_at)
 VALUES(o.id,t.id,o.retry_attempt,p_method,p_evidence,p_now) RETURNING * INTO a;
 UPDATE public.commerce_checkout_recovery_tokens SET revoked_at=p_now WHERE id=t.id;
 RETURN to_jsonb(a);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_retry_schedule_recovery(p_operation_id uuid,p_key text,p_authorization_id uuid,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; a public.subscription_retry_recovery_authorizations; r public.subscription_retry_receipts; input jsonb; real_authority public.payment_method_recovery_authorities;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO real_authority FROM jsonb_populate_record(NULL::public.payment_method_recovery_authorities,public.payment_method_recovery_authority_read(p_authorization_id));
 IF real_authority.id IS NOT NULL AND real_authority.case_id=o.case_id THEN
  RETURN public.subscription_try_schedule_recovery_retry(o.case_id,real_authority.method_ref,p_now,'recovery_redeem');
 END IF;
 input:=jsonb_build_object('authorizationId',p_authorization_id,'now',p_now);
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'schedule' OR r.input<>input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result;
 END IF;
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE id=p_authorization_id FOR UPDATE;
 IF o.id IS NULL OR o.state<>'waiting' OR a.obligation_id IS DISTINCT FROM o.id OR a.retry_attempt<>o.retry_attempt OR a.consumed_at IS NOT NULL OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy') THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 -- Receipt first: a failed schedule write rolls the receipt back too.
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'schedule',o.attempt_sequence,input,jsonb_build_object('scheduled',true,'obligationId',o.id));
 UPDATE public.subscription_retry_obligations SET next_retry_at=p_now,updated_at=p_now WHERE id=o.id;
 UPDATE public.subscription_dunning_cases SET next_retry_at=p_now,updated_at=p_now WHERE id=o.case_id AND status='open';
 RETURN jsonb_build_object('scheduled',true,'obligationId',o.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_retry_prepare(p_operation_id uuid,p_key text,p_input jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE o public.subscription_retry_obligations; op public.subscription_renewal_operations; r public.subscription_retry_receipts;
 a public.subscription_retry_recovery_authorizations; real_authority public.payment_method_recovery_authorities; real_method boolean; reservation public.fulfillment_inventory_reservations;
 line record; available bigint; committed bigint; result jsonb; method public.payment_method_refs; recovery_token public.commerce_checkout_recovery_tokens;
BEGIN
 PERFORM 1 FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO o FROM public.subscription_retry_obligations WHERE renewal_operation_id=op.id FOR UPDATE;
 SELECT * INTO r FROM public.subscription_retry_receipts WHERE receipt_key=p_key;
 IF r.id IS NOT NULL THEN
  IF r.obligation_id<>o.id OR r.kind<>'prepare' OR r.input<>p_input THEN RAISE EXCEPTION 'subscription_retry_replay_conflict' USING ERRCODE='23505'; END IF;
  RETURN r.result||jsonb_build_object('execute',false,'replayed',true);
 END IF;
 IF o.id IS NULL OR o.state<>'waiting' OR o.next_retry_at IS NULL OR o.next_retry_at>p_now OR o.renewal_quarantined_until>p_now OR
  NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=o.subscription_id AND status='active') OR
  NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE id=o.cycle_id AND status='payment_pending') OR
  NOT EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE id=o.settlement_intent_id AND status='failed') OR
  btrim(COALESCE(p_input->>'idempotencyKey',''))='' OR btrim(COALESCE(p_input->>'providerIdempotencyKey',''))='' OR
  COALESCE(p_input->>'providerRequestFingerprint','') !~ '^[0-9a-f]{64}$' OR
  p_input->>'paymentIntentId' IS DISTINCT FROM o.settlement_intent_id::text OR
  p_input->>'orderRef' IS DISTINCT FROM o.order_id::text OR
  (p_input->>'amountMinor')::bigint IS DISTINCT FROM (o.cycle_snapshot->>'totalAmountMinor')::bigint OR
  p_input->>'currency' IS DISTINCT FROM o.cycle_snapshot->>'currency' OR
  EXISTS(SELECT 1 FROM public.subscription_retry_receipts WHERE kind='prepare' AND (input->>'idempotencyKey'=p_input->>'idempotencyKey' OR input->>'providerIdempotencyKey'=p_input->>'providerIdempotencyKey')) OR btrim(COALESCE(p_input->>'paymentMethodRef',''))='' THEN
  RAISE EXCEPTION 'subscription_retry_not_due_or_ambiguous' USING ERRCODE='22023'; END IF;
 real_method:=public.subscription_method_uses_recorded_refs(o.subscription_id);
 IF real_method THEN
  SELECT recorded.* INTO real_authority FROM jsonb_populate_record(NULL::public.payment_method_recovery_authorities,public.payment_method_recovery_authority_read(o.method_recovery_authority_id)) recorded
   WHERE recorded.retry_attempt=o.retry_attempt;
  IF (o.retry_attempt>=4 OR o.failure_class='hard_do_not_retry') AND (real_authority.id IS NULL OR real_authority.retry_attempt<>o.retry_attempt OR real_authority.dispatch_key IS NOT NULL) THEN
   RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
  SELECT * INTO recovery_token FROM public.commerce_checkout_recovery_tokens WHERE id=real_authority.token_id FOR UPDATE;
  SELECT * INTO method FROM jsonb_populate_record(NULL::public.payment_method_refs,
   public.payment_method_ref_for_subscription_read(o.subscription_id,p_input->>'paymentMethodRef',p_now));
  IF method.id IS NULL THEN
   RAISE EXCEPTION 'subscription_missing_payment_method_ref' USING ERRCODE='22023'; END IF;
  IF NOT public.subscription_method_chargeable_unattended(o.subscription_id,p_now) OR
   (real_authority.id IS NOT NULL AND (real_authority.retry_attempt<>o.retry_attempt OR real_authority.dispatch_key IS NOT NULL OR real_authority.method_ref IS DISTINCT FROM p_input->>'paymentMethodRef' OR real_authority.method_id IS DISTINCT FROM method.id OR recovery_token.id IS NULL OR recovery_token.revoked_at IS NOT NULL OR recovery_token.expires_at<=p_now OR real_authority.revoked_at IS NOT NULL)) THEN
   RAISE EXCEPTION 'subscription_retry_method_mismatch'; END IF;
 ELSE
 SELECT * INTO a FROM public.subscription_retry_recovery_authorizations WHERE obligation_id=o.id AND retry_attempt=o.retry_attempt FOR UPDATE;
 IF (o.retry_attempt>=4 OR o.failure_class='hard_do_not_retry') AND (a.id IS NULL OR a.consumed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'subscription_retry_recovery_not_authorized' USING ERRCODE='22023'; END IF;
 IF a.id IS NOT NULL AND (a.method_ref IS DISTINCT FROM p_input->>'paymentMethodRef' OR
  NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=o.subscription_id AND health_state='healthy')) THEN RAISE EXCEPTION 'subscription_retry_method_mismatch'; END IF;
 END IF;
 SELECT * INTO reservation FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=op.id FOR UPDATE;
 IF reservation.id IS NULL OR reservation.operation_fingerprint<>o.operation_fingerprint THEN RAISE EXCEPTION 'subscription_retry_stock_binding_missing'; END IF;
 PERFORM stock.sku FROM public.fulfillment_stock_current stock JOIN public.fulfillment_inventory_reservation_lines l ON l.sku=stock.sku
  WHERE l.reservation_id=reservation.id AND stock.source_key=reservation.source_key ORDER BY stock.sku FOR UPDATE OF stock;
 FOR line IN SELECT * FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=reservation.id ORDER BY sku LOOP
  SELECT for_sale_quantity INTO available FROM public.fulfillment_stock_current WHERE source_key=reservation.source_key AND sku=line.sku
   AND inventory_class='sellable' AND stale_after>p_now;
  SELECT COALESCE(sum(l.quantity),0) INTO committed FROM public.fulfillment_inventory_reservation_lines l
   JOIN public.fulfillment_inventory_reservations rr ON rr.id=l.reservation_id WHERE rr.source_key=reservation.source_key AND l.sku=line.sku
   AND rr.id<>reservation.id AND (rr.status='committed' OR (rr.status='held' AND rr.expires_at>p_now));
  IF available IS NULL OR available-committed<line.quantity THEN RAISE EXCEPTION 'subscription_retry_inventory_unavailable' USING ERRCODE='23514'; END IF;
 END LOOP;
 UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL,terminal_reason=NULL,updated_at=p_now WHERE id=reservation.id;
 UPDATE public.subscription_retry_obligations SET state='prepared',attempt_sequence=attempt_sequence+1,next_retry_at=NULL,updated_at=p_now WHERE id=o.id RETURNING * INTO o;
 UPDATE public.subscription_retry_recovery_authorizations SET consumed_at=p_now WHERE id=a.id;
 IF real_authority.id IS NOT NULL THEN PERFORM public.payment_method_recovery_authority_freeze(real_authority.id,p_operation_id,p_key,p_input->>'paymentMethodRef',p_now); END IF;
 result:=jsonb_build_object('execute',true,'replayed',false,'obligationId',o.id,'attemptSequence',o.attempt_sequence,
  'cycleId',o.cycle_id,'orderId',o.order_id,'settlementIntentId',o.settlement_intent_id,'identityKey',o.identity_key,
  'operationFingerprint',o.operation_fingerprint,'snapshot',o.cycle_snapshot,'request',p_input);
 INSERT INTO public.subscription_retry_receipts(obligation_id,receipt_key,kind,attempt_sequence,input,result)
 VALUES(o.id,p_key,'prepare',o.attempt_sequence,p_input,result);
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_retry_candidates(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM (
  SELECT o.* FROM public.subscription_retry_obligations o JOIN public.subscriptions s ON s.id=o.subscription_id
  WHERE s.status='active' AND o.state='waiting' AND o.next_retry_at<=p_now AND (o.renewal_quarantined_until IS NULL OR o.renewal_quarantined_until<=p_now)
   AND EXISTS(SELECT 1 FROM public.subscription_cycles cycle
    WHERE cycle.id=o.cycle_id AND cycle.status<>'paid')
   AND EXISTS(SELECT 1 FROM public.commerce_settlement_intents intent
    WHERE intent.id=o.settlement_intent_id AND intent.status<>'settled')
  ORDER BY o.next_retry_at,o.id LIMIT LEAST(GREATEST(p_limit,1),500)
 ) c;
$$;
-- Bounded executable surface.

REVOKE ALL ON FUNCTION public.payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_deactivate(text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_switch_active(text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_link_subscription_mirror(text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_method_chargeable_unattended(uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_method_health_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_read(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_setup_resolve_owner(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_control_mark_setup_event_processed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_repair_subscription_scope(text,uuid,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_repair_subscription_scope_batch(integer,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_try_schedule_recovery_retry(uuid,text,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_method_uses_recorded_refs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_ref_for_subscription_read(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_recovery_authority_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_recovery_authority_bind(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_recovery_authority_record(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_recovery_authority_freeze(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.payment_method_refs,public.payment_method_ref_receipts,public.payment_method_recovery_authorities FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.payment_method_refs,public.payment_method_ref_receipts,public.payment_method_recovery_authorities FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.payment_method_refs,public.payment_method_ref_receipts,public.payment_method_recovery_authorities FROM service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.payment_method_refs TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY payment_method_refs_absorption_census ON public.payment_method_refs FOR SELECT TO service_role USING (true);'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.payment_method_recovery_authorities TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY payment_method_recovery_authorities_absorption_census ON public.payment_method_recovery_authorities FOR SELECT TO service_role USING (true);'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.payment_method_ref_upsert(text,uuid,uuid,text,text,text,text,text,text,boolean,timestamptz,jsonb,jsonb),public.payment_method_ref_deactivate(text,uuid,text,jsonb),public.payment_method_ref_switch_active(text,uuid,uuid),public.payment_method_ref_link_subscription_mirror(text,uuid,uuid),public.subscription_method_chargeable_unattended(uuid,timestamptz),public.subscription_method_health_read(uuid),public.payment_method_ref_read(text,text),public.payment_method_setup_resolve_owner(uuid,uuid),public.payment_control_mark_setup_event_processed(uuid),public.payment_method_ref_repair_subscription_scope(text,uuid,timestamptz,text),public.payment_method_ref_repair_subscription_scope_batch(integer,boolean,text),public.subscription_try_schedule_recovery_retry(uuid,text,timestamptz,text),public.subscription_method_uses_recorded_refs(uuid),public.payment_method_ref_for_subscription_read(uuid,text,timestamptz),public.payment_method_recovery_authority_read(uuid),public.payment_method_recovery_authority_bind(uuid,uuid,text,text,timestamptz),public.payment_method_recovery_authority_record(uuid,uuid),public.payment_method_recovery_authority_freeze(uuid,uuid,text,text,timestamptz) TO service_role;'; END IF; END; $$;
