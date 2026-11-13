CREATE FUNCTION pg_temp.provider_order(p_order uuid,p_client uuid,p_amount integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sku uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.catalog_products(id,slug,name) VALUES(sku,'fixture-'||sku::text,'Example');
 INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES(sku,sku,'FIXTURE-'||sku::text,'Example');
 INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES(p_order,p_client,'pending_payment','XXX',p_amount);
 INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES(p_order,sku,1,1,p_amount,p_amount);
END; $$;
CREATE FUNCTION pg_temp.provider_intent(k text,t text,o uuid,s uuid,c uuid,a integer,cur text,m jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.payment_provider_intent_create(k,t,o,s,c,a,cur,m,'card_rail','2026-11-13T12:00:00Z');
$$;
CREATE FUNCTION pg_temp.provider_apply(k text,i uuid,e uuid,s text,at timestamptz,r text,fc text DEFAULT NULL,by text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.payment_provider_result_apply(k,i,e,s,at,r,fc,by,'dunning','/recover','recovered');
$$;
CREATE FUNCTION pg_temp.provider_subscription_order(s uuid,cy uuid,o uuid,c uuid,st text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.subscriptions(id,client_id,cadence_days,status,started_at,next_cycle_at) VALUES(s,c,30,st,'2026-01-01T00:00:00Z','2026-11-13T12:00:00Z');
 INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES(cy,s,'2026-11-13T12:00:00Z','payment_pending');
 PERFORM pg_temp.provider_order(o,c,12999);
 UPDATE public.commerce_orders SET subscription_cycle_id=cy WHERE id=o;
END; $$;
