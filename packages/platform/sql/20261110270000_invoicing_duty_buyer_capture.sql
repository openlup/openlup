-- Freeze buyer inputs only with the first owed-duty insertion. Existing obligations never backfill.
CREATE FUNCTION public.invoicing_capture_duty_with_buyer(
  p_key text, p_source_kind text, p_source_id uuid, p_order_id uuid, p_evidence jsonb, p_occurred_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_duty public.invoicing_duties%ROWTYPE;
  v_receipt public.invoicing_effect_receipts%ROWTYPE;
  v_payload jsonb;
  v_key text;
  v_created boolean;
  purchase public.commerce_orders; customer public.clients; profile public.customer_orderer_profiles; billing public.customer_saved_addresses;
  shipping jsonb; destination jsonb; explicit jsonb; buyer jsonb; address jsonb; buyer_source text; address_source text; display_name text; email text; company text; tax text;
BEGIN
  IF p_key IS NULL OR btrim(p_key)='' OR p_source_kind NOT IN ('paid','handoff') OR p_source_kind IS NULL
    OR p_source_id IS NULL OR p_order_id IS NULL OR p_occurred_at IS NULL OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'invoicing_capture_invalid' USING ERRCODE='22023'; END IF;
  -- Serialize aliases for this order with the existing invoice-request lock.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('invoicing:' || p_order_id::text,0)) THEN
    RAISE EXCEPTION 'invoicing_capture_busy' USING ERRCODE='55P03';
  END IF;
  INSERT INTO public.invoicing_duties(order_id,original_key,seller_policy_version) VALUES(p_order_id,p_key,
    'invoicing.seller.v1')
    ON CONFLICT (order_id) WHERE parent_duty_id IS NULL DO NOTHING RETURNING * INTO v_duty;
  v_created:=FOUND;
  IF v_duty.id IS NULL THEN
    SELECT * INTO v_duty FROM public.invoicing_duties WHERE order_id=p_order_id AND parent_duty_id IS NULL;
  END IF;
  v_payload:=jsonb_build_object('sourceKind',p_source_kind,'sourceId',p_source_id,'orderId',p_order_id,'evidence',p_evidence,'occurredAt',to_char(p_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  FOREACH v_key IN ARRAY ARRAY['source:' || p_source_kind || ':' || p_source_id::text,'key:' || p_source_kind || ':' || coalesce(p_evidence->>'settlementIntentId',p_source_id::text) || ':' || p_key] LOOP
    INSERT INTO public.invoicing_effect_receipts(receipt_key,duty_id,payload) VALUES(v_key,v_duty.id,v_payload)
      ON CONFLICT DO NOTHING;
    SELECT * INTO v_receipt FROM public.invoicing_effect_receipts WHERE receipt_key=v_key;
    IF v_receipt.duty_id IS DISTINCT FROM v_duty.id OR v_receipt.payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'invoicing_source_or_key_conflict' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_created AND NOT EXISTS(SELECT 1 FROM public.accounting_documents WHERE order_id=p_order_id AND correction_of_document_id IS NULL) THEN
 SELECT * INTO purchase FROM public.commerce_orders WHERE id=p_order_id;
 SELECT * INTO customer FROM public.clients WHERE id=purchase.client_id;
 IF p_source_kind='handoff' THEN
  IF NOT EXISTS(SELECT 1 FROM public.fulfillment_shipments WHERE id=(p_evidence->>'shipmentId')::uuid AND order_id=p_order_id) THEN RAISE EXCEPTION 'customer_billing_shipment_mismatch' USING ERRCODE='22023'; END IF;
  destination:=public.commerce_read_destination('shipment',(p_evidence->>'shipmentId')::uuid);
 ELSE destination:=public.commerce_read_destination('order',p_order_id); END IF;
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
 INSERT INTO public.invoicing_buyer_snapshots(duty_id,buyer) VALUES(v_duty.id,buyer);
  END IF;
  RETURN jsonb_build_object('dutyId',v_duty.id,'status',v_duty.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoicing_capture_duty(
  p_key text, p_source_kind text, p_source_id uuid, p_order_id uuid, p_evidence jsonb, p_occurred_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RETURN public.invoicing_capture_duty_with_buyer(p_key,p_source_kind,p_source_id,p_order_id,p_evidence,p_occurred_at);
END;
$$;

REVOKE ALL ON FUNCTION public.invoicing_capture_duty_with_buyer(text,text,uuid,uuid,jsonb,timestamptz) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.invoicing_capture_duty_with_buyer(text,text,uuid,uuid,jsonb,timestamptz) FROM anon'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.invoicing_capture_duty_with_buyer(text,text,uuid,uuid,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.invoicing_capture_duty_with_buyer(text,text,uuid,uuid,jsonb,timestamptz) TO service_role'; END IF; END; $$;

