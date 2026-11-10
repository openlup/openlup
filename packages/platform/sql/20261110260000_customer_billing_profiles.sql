CREATE TABLE public.customer_orderer_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,label text,full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),phone text,company_name text,tax_id text,is_default boolean NOT NULL DEFAULT false,source text NOT NULL DEFAULT 'unknown' CHECK (source IN ('unknown','hidden_configurator','customer_account','checkout','admin')),company_verification_level text CHECK (company_verification_level IN ('registry_verified','provider_verified','manual_unverified','invalid')),company_identity_source text,company_identity_evidence_hash text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK (char_length(label) BETWEEN 0 AND 120),CHECK (char_length(phone) BETWEEN 0 AND 64),CHECK (char_length(company_name) BETWEEN 0 AND 200),CHECK (char_length(tax_id) BETWEEN 0 AND 64),CHECK (char_length(company_identity_source) BETWEEN 0 AND 120),CHECK (char_length(company_identity_evidence_hash) BETWEEN 0 AND 160));

CREATE INDEX customer_orderer_profiles_client_updated ON public.customer_orderer_profiles(client_id,updated_at DESC);

CREATE UNIQUE INDEX customer_orderer_profiles_default ON public.customer_orderer_profiles(client_id) WHERE is_default = true;

CREATE TABLE public.invoicing_buyer_snapshots (duty_id uuid PRIMARY KEY REFERENCES public.invoicing_duties(id) ON DELETE CASCADE,buyer jsonb NOT NULL,captured_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION public.customer_billing_profiles_read(p_actor uuid,p_client uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY is_default DESC,updated_at DESC) FROM public.customer_orderer_profiles p WHERE client_id=p_client),'[]');
END; $$;

CREATE FUNCTION public.customer_billing_profiles_clear_defaults(p_actor uuid,p_client uuid,p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 LOCK TABLE public.customer_orderer_profiles IN ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
 UPDATE public.customer_orderer_profiles SET is_default=false,updated_at=p_now WHERE client_id=p_client;
 RETURN 'true';
END; $$;

CREATE FUNCTION public.customer_billing_profile_write(p_actor uuid,p_client uuid,p_id uuid,p_row jsonb,p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE answer uuid;
BEGIN
 LOCK TABLE public.customer_orderer_profiles IN ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
 IF p_id IS NULL THEN
  INSERT INTO public.customer_orderer_profiles(client_id,label,full_name,email,phone,company_name,tax_id,is_default,source,company_verification_level,company_identity_source,company_identity_evidence_hash,updated_at)
  VALUES(p_client,p_row->>'label',p_row->>'fullName',p_row->>'email',p_row->>'phone',p_row->>'companyName',p_row->>'taxId',coalesce((p_row->>'isDefault')::boolean,false),'customer_account',p_row->>'companyVerificationLevel',p_row->>'companyIdentitySource',p_row->>'companyIdentityEvidenceHash',p_now) RETURNING id INTO answer;
 ELSE
  UPDATE public.customer_orderer_profiles SET label=p_row->>'label',full_name=p_row->>'fullName',email=p_row->>'email',phone=p_row->>'phone',company_name=p_row->>'companyName',tax_id=p_row->>'taxId',is_default=coalesce((p_row->>'isDefault')::boolean,false),source='customer_account',company_verification_level=p_row->>'companyVerificationLevel',company_identity_source=p_row->>'companyIdentitySource',company_identity_evidence_hash=p_row->>'companyIdentityEvidenceHash',updated_at=p_now WHERE id=p_id AND client_id=p_client RETURNING id INTO answer;
  IF answer IS NULL THEN RAISE EXCEPTION 'customer_billing_profile_not_found' USING ERRCODE='P0002'; END IF;
 END IF;
 RETURN to_jsonb(answer);
END; $$;

CREATE FUNCTION public.customer_billing_profile_delete(p_actor uuid,p_client uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 LOCK TABLE public.customer_orderer_profiles IN ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_actor) THEN RETURN NULL; END IF;
 DELETE FROM public.customer_orderer_profiles WHERE id=p_id AND client_id=p_client; RETURN 'true';
END; $$;

CREATE FUNCTION public.customer_billing_prepare_erasure() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN LOCK TABLE public.customer_orderer_profiles IN SHARE ROW EXCLUSIVE MODE; RETURN 'true'; END; $$;

CREATE FUNCTION public.customer_billing_export(p_client uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN RETURN jsonb_build_object('profiles',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.customer_orderer_profiles p WHERE client_id=p_client),'[]'),
 'invoiceBuyers',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.duty_id) FROM public.invoicing_buyer_snapshots s JOIN public.invoicing_duties d ON d.id=s.duty_id JOIN public.commerce_orders o ON o.id=d.order_id WHERE o.client_id=p_client),'[]')); END; $$;

CREATE FUNCTION public.customer_billing_erase(p_client uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN DELETE FROM public.customer_orderer_profiles WHERE client_id=p_client; RETURN 'true'; END; $$;

CREATE FUNCTION public.customer_billing_capture_invoice(p_key text,p_source text,p_source_id uuid,p_order uuid,p_evidence jsonb,p_at timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE answer jsonb; duty uuid; purchase public.commerce_orders; customer public.clients; profile public.customer_orderer_profiles; billing public.customer_saved_addresses; shipping jsonb; destination jsonb; explicit jsonb; buyer jsonb; address jsonb; buyer_source text; address_source text; display_name text; email text; company text; tax text; prior_obligation boolean:=true;
BEGIN
 -- Decide creation eligibility under the request owner's existing order lock.
 -- An older duty/document never acquires buyer selection on a later replay.
 IF p_source IN ('paid','handoff') THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('invoicing:'||p_order::text,0)) THEN RAISE EXCEPTION 'invoicing_capture_busy' USING ERRCODE='55P03'; END IF;
  prior_obligation:=EXISTS(SELECT 1 FROM public.invoicing_duties WHERE order_id=p_order AND parent_duty_id IS NULL)
   OR EXISTS(SELECT 1 FROM public.accounting_documents WHERE order_id=p_order AND correction_of_document_id IS NULL);
 END IF;
 answer:=public.invoicing_request_with_seller_policy(p_key,p_source,p_source_id,p_order,p_evidence,p_at);
 IF p_source NOT IN ('paid','handoff') THEN RETURN answer; END IF;
 duty:=(answer->>'dutyId')::uuid;
 IF prior_obligation OR duty IS NULL OR EXISTS(SELECT 1 FROM public.invoicing_buyer_snapshots WHERE duty_id=duty) OR EXISTS(SELECT 1 FROM public.invoicing_fact_revisions WHERE duty_id=duty) THEN RETURN answer; END IF;
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order;
 SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 IF p_source='handoff' THEN
  IF NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE id=(p_evidence->>'shipmentId')::uuid AND order_id=p_order) THEN RAISE EXCEPTION 'customer_billing_shipment_mismatch' USING ERRCODE='22023'; END IF;
  destination:=public.commerce_read_destination('shipment',(p_evidence->>'shipmentId')::uuid);
 ELSE destination:=public.commerce_read_destination('order',p_order); END IF;
 shipping:=destination->'address';
 SELECT * INTO profile FROM public.customer_orderer_profiles WHERE client_id=purchase.client_id ORDER BY is_default DESC,updated_at DESC,id LIMIT 1;
 SELECT * INTO billing FROM public.customer_saved_addresses WHERE client_id=purchase.client_id AND kind IN ('billing','both') ORDER BY is_default DESC,updated_at DESC,id LIMIT 1;
 IF jsonb_typeof(purchase.metadata->'invoiceBuyerSnapshot')='object' THEN
  explicit:=purchase.metadata->'invoiceBuyerSnapshot';
  buyer_source:=coalesce(nullif(explicit->>'source',''),'commerce_order_metadata.invoiceBuyerSnapshot');
  address_source:=coalesce(nullif(explicit#>>'{address,source}',''),buyer_source);
  display_name:=nullif(explicit->>'name',''); email:=coalesce(nullif(explicit->>'email',''),customer.email);company:=nullif(explicit->>'companyName','');tax:=nullif(explicit->>'taxId','');
  address:=CASE WHEN jsonb_typeof(explicit->'address')='object' THEN explicit->'address' ELSE jsonb_build_object('addressId',destination->>'destinationId','line1',shipping->'line1','line2',shipping->'line2','city',shipping->'city','postalCode',shipping->'postalCode','country',shipping->'country','source','shipping_address_legacy_fallback') END;
 ELSIF profile.id IS NOT NULL OR billing.id IS NOT NULL THEN
  buyer_source:=CASE WHEN profile.id IS NOT NULL THEN 'customer_orderer_profile' ELSE 'customer_billing_address' END;
  address_source:=CASE WHEN billing.id IS NOT NULL THEN 'customer_billing_address' ELSE 'shipping_address_legacy_fallback' END;
  display_name:=coalesce(nullif(profile.full_name,''),nullif(billing.recipient_name,''),nullif(concat_ws(' ',customer.first_name,customer.last_name),''),customer.email);
  email:=coalesce(nullif(profile.email,''),customer.email);company:=coalesce(nullif(profile.company_name,''),nullif(billing.company_name,''));tax:=coalesce(nullif(profile.tax_id,''),nullif(billing.tax_id,''));
  address:=CASE WHEN billing.id IS NOT NULL THEN jsonb_build_object('addressId',billing.id,'line1',billing.line1,'line2',billing.line2,'city',billing.city,'postalCode',billing.postal_code,'country',billing.country,'source','customer_billing_address') ELSE jsonb_build_object('addressId',destination->>'destinationId','line1',shipping->'line1','line2',shipping->'line2','city',shipping->'city','postalCode',shipping->'postalCode','country',shipping->'country','source','shipping_address_legacy_fallback') END;
 ELSE
  buyer_source:='legacy_shipping_address_fallback';address_source:=buyer_source;
  display_name:=coalesce(nullif(shipping->>'recipientName',''),nullif(concat_ws(' ',customer.first_name,customer.last_name),''),customer.email);email:=customer.email;company:=nullif(shipping->>'companyName','');tax:=nullif(shipping->>'taxId','');address:=jsonb_build_object('addressId',destination->>'destinationId','line1',shipping->'line1','line2',shipping->'line2','city',shipping->'city','postalCode',shipping->'postalCode','country',shipping->'country','source',buyer_source);
 END IF;
 buyer:=jsonb_build_object('name',coalesce(display_name,customer.email),'email',email,'companyName',company,'taxId',tax,'source',buyer_source,'addressSource',address_source,'ordererProfileId',profile.id,'billingAddressId',billing.id,'legacyFallback',buyer_source='legacy_shipping_address_fallback' OR address_source LIKE '%legacy_shipping_address_fallback','address',address);
 INSERT INTO public.invoicing_buyer_snapshots(duty_id,buyer) VALUES(duty,buyer);
 RETURN answer;
END; $$;

CREATE FUNCTION public.customer_billing_buyer_read(p_order uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN RETURN (SELECT s.buyer FROM public.invoicing_buyer_snapshots s JOIN public.invoicing_duties d ON d.id=s.duty_id WHERE d.order_id=p_order AND d.parent_duty_id IS NULL); END; $$;

CREATE FUNCTION public.customer_billing_install_invoice_facts(p_duty uuid,p_facts jsonb,p_revision text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected jsonb; supplied jsonb; key text;
BEGIN
 SELECT buyer INTO selected FROM public.invoicing_buyer_snapshots WHERE duty_id=p_duty;
 IF selected IS NOT NULL THEN
  IF p_facts#>>'{refs,orderId}' IS DISTINCT FROM (SELECT order_id::text FROM public.invoicing_duties WHERE id=p_duty) THEN RAISE EXCEPTION 'customer_billing_invoice_order_mismatch' USING ERRCODE='22023'; END IF;
  supplied:=p_facts->'buyer';
  FOREACH key IN ARRAY ARRAY['email','companyName','taxId','source','addressSource','ordererProfileId','billingAddressId','legacyFallback','address'] LOOP
   IF supplied->key IS DISTINCT FROM selected->key THEN RAISE EXCEPTION 'customer_billing_invoice_buyer_mismatch' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF NOT coalesce(supplied->>'name'=selected->>'name' OR (nullif(selected->>'companyName','') IS NOT NULL AND supplied->>'name'=selected->>'companyName'),false) THEN RAISE EXCEPTION 'customer_billing_invoice_buyer_mismatch' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN public.invoicing_install_facts(p_duty,p_facts,p_revision);
END; $$;

CREATE FUNCTION public.customer_billing_sweep_invoice_duties(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_source record; v_duty record; v_seen integer:=0; v_attempt integer; v_claims jsonb:='[]'; v_timeout text:=current_setting('lock_timeout');
BEGIN
  FOR v_source IN SELECT * FROM public.invoicing_due_sources ORDER BY occurred_at,source_id LIMIT least(greatest(coalesce(p_limit,10),1),100) LOOP
    BEGIN
      PERFORM set_config('lock_timeout','100ms',true);
      PERFORM public.customer_billing_capture_invoice(v_source.source_key,v_source.source_kind,v_source.source_id,v_source.order_id,v_source.evidence,v_source.occurred_at);
      PERFORM set_config('lock_timeout',v_timeout,true);
      v_seen:=v_seen+1;
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      SELECT coalesce(max(attempts),0)+1 INTO v_attempt FROM public.invoicing_capture_faults WHERE source_kind=v_source.source_kind AND source_id=v_source.source_id;
      INSERT INTO public.invoicing_capture_faults(order_id,source_kind,source_id,attempts,state,available_at)
        VALUES(v_source.order_id,v_source.source_kind,v_source.source_id,v_attempt,CASE WHEN v_attempt>=8 THEN 'faulted' ELSE 'retryable' END,
          now()+make_interval(secs=>least(3600,60*power(2,least(v_attempt-1,6)))::integer));
    END;
  END LOOP;
  FOR v_duty IN SELECT d.* FROM public.invoicing_duties d
    JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
    WHERE d.request_id IS NULL AND d.status IN ('owed','blocked') AND d.available_at<=now()
      AND d.reversal IS NULL
      AND (d.fact_token IS NULL OR d.fact_lease_until<=now())
    ORDER BY d.created_at,d.id LIMIT least(greatest(coalesce(p_limit,10),1),100) FOR UPDATE OF d SKIP LOCKED LOOP
    IF v_duty.fact_attempts>=8 THEN
      UPDATE public.invoicing_duties SET status='faulted',fact_token=NULL,fact_lease_until=NULL,last_result='{"kind":"faulted"}' WHERE id=v_duty.id;
      CONTINUE;
    END IF;
    UPDATE public.invoicing_duties SET fact_attempts=fact_attempts+1,fact_token=gen_random_uuid(),fact_lease_until=now()+interval '5 minutes'
      WHERE id=v_duty.id RETURNING * INTO v_duty;
    v_claims:=v_claims||jsonb_build_array(jsonb_build_object('dutyId',v_duty.id,'token',v_duty.fact_token));
  END LOOP;
  RETURN jsonb_build_object('collected',v_seen,'claims',v_claims);
END;
$$;

ALTER TABLE public.customer_orderer_profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoicing_buyer_snapshots ENABLE ROW LEVEL SECURITY;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('customer_orderer_profiles', 'block', 'Personal billing profiles belong to their customer and prevent lead absorption.');

REVOKE ALL ON TABLE public.customer_orderer_profiles FROM PUBLIC;

REVOKE ALL ON TABLE public.invoicing_buyer_snapshots FROM PUBLIC;

REVOKE ALL ON FUNCTION public.customer_billing_profiles_read(uuid,uuid), public.customer_billing_profiles_clear_defaults(uuid,uuid,timestamptz), public.customer_billing_profile_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_billing_profile_delete(uuid,uuid,uuid), public.customer_billing_prepare_erasure(), public.customer_billing_export(uuid), public.customer_billing_erase(uuid), public.customer_billing_capture_invoice(text,text,uuid,uuid,jsonb,timestamptz), public.customer_billing_buyer_read(uuid), public.customer_billing_install_invoice_facts(uuid,jsonb,text), public.customer_billing_sweep_invoice_duties(integer) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_orderer_profiles, public.invoicing_buyer_snapshots FROM anon'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_billing_profiles_read(uuid,uuid), public.customer_billing_profiles_clear_defaults(uuid,uuid,timestamptz), public.customer_billing_profile_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_billing_profile_delete(uuid,uuid,uuid), public.customer_billing_prepare_erasure(), public.customer_billing_export(uuid), public.customer_billing_erase(uuid), public.customer_billing_capture_invoice(text,text,uuid,uuid,jsonb,timestamptz), public.customer_billing_buyer_read(uuid), public.customer_billing_install_invoice_facts(uuid,jsonb,text), public.customer_billing_sweep_invoice_duties(integer) FROM anon'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_orderer_profiles, public.invoicing_buyer_snapshots FROM authenticated'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_billing_profiles_read(uuid,uuid), public.customer_billing_profiles_clear_defaults(uuid,uuid,timestamptz), public.customer_billing_profile_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_billing_profile_delete(uuid,uuid,uuid), public.customer_billing_prepare_erasure(), public.customer_billing_export(uuid), public.customer_billing_erase(uuid), public.customer_billing_capture_invoice(text,text,uuid,uuid,jsonb,timestamptz), public.customer_billing_buyer_read(uuid), public.customer_billing_install_invoice_facts(uuid,jsonb,text), public.customer_billing_sweep_invoice_duties(integer) FROM authenticated'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_billing_profiles_read(uuid,uuid), public.customer_billing_profiles_clear_defaults(uuid,uuid,timestamptz), public.customer_billing_profile_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_billing_profile_delete(uuid,uuid,uuid), public.customer_billing_prepare_erasure(), public.customer_billing_export(uuid), public.customer_billing_erase(uuid), public.customer_billing_capture_invoice(text,text,uuid,uuid,jsonb,timestamptz), public.customer_billing_buyer_read(uuid), public.customer_billing_install_invoice_facts(uuid,jsonb,text), public.customer_billing_sweep_invoice_duties(integer) TO service_role'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.customer_orderer_profiles TO service_role;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY customer_orderer_profiles_absorption_census ON public.customer_orderer_profiles FOR SELECT TO service_role USING (true);'; END IF; END; $$;
