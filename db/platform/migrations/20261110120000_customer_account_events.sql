-- Customer-owned account history, profile edits and acknowledged document requests.
CREATE TABLE public.customer_account_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
 event_type text NOT NULL,
 entity_type text NOT NULL,
 entity_id uuid,
 payload jsonb NOT NULL DEFAULT '{}',
 occurred_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_account_events_client ON public.customer_account_events (client_id, occurred_at DESC);
ALTER TABLE public.customer_account_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_account_events FROM PUBLIC;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('customer_account_events', 'block', 'Account history belongs to its customer and prevents lead absorption.');

CREATE FUNCTION public.customer_account_event_append(p_principal uuid,p_client uuid,p_type text,p_entity_type text,p_entity uuid,p_payload jsonb,p_now timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
 IF p_type IS NULL OR char_length(p_type) NOT BETWEEN 1 AND 120 OR p_entity_type IS NULL OR char_length(p_entity_type) NOT BETWEEN 1 AND 80
  OR p_payload IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'customer_account_invalid_input' USING ERRCODE='22023'; END IF;
 INSERT INTO public.customer_account_events(client_id,event_type,entity_type,entity_id,payload,occurred_at)
 VALUES(p_client,p_type,p_entity_type,p_entity,p_payload,p_now) RETURNING id INTO result;
 RETURN result;
END; $$;

CREATE FUNCTION public.customer_account_event_history(p_principal uuid,p_client uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
 RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventId',id,'eventType',event_type,'entityType',entity_type,'entityId',entity_id,
  'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY occurred_at DESC),'[]'::jsonb)
  FROM (SELECT * FROM public.customer_account_events WHERE client_id=p_client ORDER BY occurred_at DESC LIMIT 20) events);
END; $$;

-- Replay lookup precedes the profile write. Appending its event remains a separate call.
CREATE FUNCTION public.customer_account_profile_update(p_principal uuid,p_client uuid,p_input jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c public.clients%ROWTYPE; replayed boolean; k text;
BEGIN
 SELECT * INTO c FROM public.clients WHERE id=p_client AND principal_id=p_principal;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_now IS NULL OR NOT isfinite(p_now)
  OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR char_length(p_input->>'idempotencyKey') NOT BETWEEN 8 AND 180
  OR (p_input->>'idempotencyKey')<>btrim(p_input->>'idempotencyKey') THEN RAISE EXCEPTION 'customer_account_invalid_input' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT jsonb_object_keys(p_input) LOOP
  IF k NOT IN ('idempotencyKey','firstName','lastName','phone') OR (k<>'idempotencyKey' AND jsonb_typeof(p_input->k) NOT IN ('string','null'))
   THEN RAISE EXCEPTION 'customer_account_invalid_input' USING ERRCODE='22023'; END IF;
 END LOOP;
 replayed:=EXISTS(SELECT 1 FROM public.customer_account_events WHERE client_id=p_client AND event_type='customer.profile_updated' AND payload->>'idempotencyKey'=p_input->>'idempotencyKey');
 IF NOT replayed THEN
  UPDATE public.clients SET first_name=CASE WHEN p_input ? 'firstName' THEN p_input->>'firstName' ELSE first_name END,
   last_name=CASE WHEN p_input ? 'lastName' THEN p_input->>'lastName' ELSE last_name END,
   phone=CASE WHEN p_input ? 'phone' THEN p_input->>'phone' ELSE phone END,updated_at=p_now
   WHERE id=p_client AND principal_id=p_principal RETURNING * INTO c;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 RETURN jsonb_build_object('replayed',replayed,'contractVersion','customer.self_service.v1','profile',jsonb_build_object(
  'clientId',c.id,'email',c.email,'firstName',c.first_name,'lastName',c.last_name,'phone',c.phone,'lifecycleStage',c.lifecycle_stage));
END; $$;

CREATE FUNCTION public.customer_invoice_correction_request(p_principal uuid,p_client uuid,p_invoice uuid,p_input jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE invoice_ref text; event_id uuid;
BEGIN
 IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
  OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string' OR char_length(p_input->>'idempotencyKey') NOT BETWEEN 8 AND 180
  OR (p_input->>'idempotencyKey')<>btrim(p_input->>'idempotencyKey')
  OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string'
  OR (p_input ? 'requestedFields' AND jsonb_typeof(p_input->'requestedFields')<>'array')
  OR (p_input ? 'note' AND jsonb_typeof(p_input->'note') NOT IN ('string','null'))
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('idempotencyKey','reason','requestedFields','note'))
  THEN RAISE EXCEPTION 'customer_account_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT d.document_ref INTO invoice_ref FROM public.accounting_documents d JOIN public.commerce_orders o ON o.id=d.order_id
  JOIN public.clients c ON c.id=o.client_id WHERE d.id=p_invoice AND c.id=p_client AND c.principal_id=p_principal;
 IF NOT FOUND THEN RETURN NULL; END IF;
 event_id:=public.customer_account_event_append(p_principal,p_client,'customer.invoice_correction_requested','accounting_document',p_invoice,
  jsonb_build_object('idempotencyKey',p_input->>'idempotencyKey','invoiceRef',invoice_ref,'reason',p_input->>'reason',
  'requestedFields',COALESCE(p_input->'requestedFields','[]'::jsonb),'note',COALESCE(p_input->'note','null'::jsonb)),p_now);
 RETURN jsonb_build_object('contractVersion','customer.billing.v1','eventId',event_id);
END; $$;

REVOKE ALL ON FUNCTION public.customer_account_event_append(uuid,uuid,text,text,uuid,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_account_event_history(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_account_profile_update(uuid,uuid,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_invoice_correction_request(uuid,uuid,uuid,jsonb,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_account_events FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_account_events FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_account_events FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_account_event_append(uuid,uuid,text,text,uuid,jsonb,timestamptz), public.customer_account_event_history(uuid,uuid), public.customer_account_profile_update(uuid,uuid,jsonb,timestamptz), public.customer_invoice_correction_request(uuid,uuid,uuid,jsonb,timestamptz) FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_account_event_append(uuid,uuid,text,text,uuid,jsonb,timestamptz), public.customer_account_event_history(uuid,uuid), public.customer_account_profile_update(uuid,uuid,jsonb,timestamptz), public.customer_invoice_correction_request(uuid,uuid,uuid,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_account_event_append(uuid,uuid,text,text,uuid,jsonb,timestamptz), public.customer_account_event_history(uuid,uuid), public.customer_account_profile_update(uuid,uuid,jsonb,timestamptz), public.customer_invoice_correction_request(uuid,uuid,uuid,jsonb,timestamptz) FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_account_event_append(uuid,uuid,text,text,uuid,jsonb,timestamptz), public.customer_account_event_history(uuid,uuid), public.customer_account_profile_update(uuid,uuid,jsonb,timestamptz), public.customer_invoice_correction_request(uuid,uuid,uuid,jsonb,timestamptz) TO service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.customer_account_events TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY customer_account_events_absorption_census ON public.customer_account_events FOR SELECT TO service_role USING (true);'; END IF; END; $$;
