CREATE TABLE public.customer_saved_addresses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('shipping','billing','both')),
 label text, line1 text NOT NULL, line2 text, city text NOT NULL, postal_code text NOT NULL,
 country text NOT NULL DEFAULT 'ZZ' CHECK (char_length(country) BETWEEN 2 AND 3),
 is_default boolean NOT NULL DEFAULT false,
 recipient_name text CHECK (char_length(recipient_name) BETWEEN 0 AND 200),
 contact_phone text CHECK (char_length(contact_phone) BETWEEN 0 AND 64),
 company_name text CHECK (char_length(company_name) BETWEEN 0 AND 200),
 tax_id text CHECK (char_length(tax_id) BETWEEN 0 AND 64),
 delivery_notes text CHECK (char_length(delivery_notes) BETWEEN 0 AND 500),
 courier_instructions text CHECK (char_length(courier_instructions) BETWEEN 0 AND 500),
 last_used_at timestamptz,
 source text NOT NULL DEFAULT 'unknown' CHECK (source IN ('unknown','hidden_configurator','customer_account','checkout','admin')),
 metadata jsonb NOT NULL DEFAULT '{}',
 canonical_key text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_saved_addresses_client ON public.customer_saved_addresses(client_id);
CREATE UNIQUE INDEX uq_customer_saved_addresses_default ON public.customer_saved_addresses(client_id,kind) WHERE is_default = true;
CREATE INDEX idx_customer_saved_addresses_canonical ON public.customer_saved_addresses(client_id,canonical_key) WHERE canonical_key IS NOT NULL;
ALTER TABLE public.customer_saved_addresses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_saved_addresses FROM PUBLIC;
ALTER TABLE public.subscriptions ADD COLUMN shipping_saved_address_id uuid;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_shipping_saved_address_fkey FOREIGN KEY (shipping_saved_address_id) REFERENCES public.customer_saved_addresses(id) ON DELETE SET NULL;
ALTER TABLE public.subscriptions ADD COLUMN billing_saved_address_id uuid;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_billing_saved_address_fkey FOREIGN KEY (billing_saved_address_id) REFERENCES public.customer_saved_addresses(id) ON DELETE SET NULL;
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('customer_saved_addresses', 'block', 'Saved personal addresses belong to their customer and prevent lead absorption.');

CREATE FUNCTION public.customer_saved_addresses_read(p_principal uuid,p_client uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
RETURN COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.is_default DESC,a.updated_at DESC) FROM public.customer_saved_addresses a WHERE a.client_id=p_client),'[]'::jsonb);
END;
$$;

CREATE FUNCTION public.customer_saved_address_replayed(p_principal uuid,p_client uuid,p_type text,p_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
IF p_type NOT IN ('customer.address_upserted','customer.address_deleted') OR p_key IS NULL THEN RAISE EXCEPTION 'customer_saved_address_invalid_input' USING ERRCODE='22023'; END IF;
RETURN EXISTS(SELECT 1 FROM public.customer_account_events WHERE client_id=p_client AND event_type=p_type AND payload->>'idempotencyKey'=p_key);
END;
$$;

CREATE FUNCTION public.customer_saved_address_canonical(p_principal uuid,p_client uuid,p_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
RETURN (SELECT id FROM public.customer_saved_addresses WHERE client_id=p_client AND canonical_key=p_key ORDER BY last_used_at DESC NULLS LAST,updated_at DESC LIMIT 1);
END;
$$;

CREATE FUNCTION public.customer_saved_address_clear_defaults(p_principal uuid,p_client uuid,p_kind text,p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
LOCK TABLE public.customer_saved_addresses IN ROW EXCLUSIVE MODE;
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
IF p_kind IS NULL OR p_kind NOT IN ('shipping','billing','both') OR p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'customer_saved_address_invalid_input' USING ERRCODE='22023'; END IF;
UPDATE public.customer_saved_addresses SET is_default=false,updated_at=p_now WHERE client_id=p_client AND kind=p_kind;
RETURN true;
END;
$$;

CREATE FUNCTION public.customer_saved_address_write(p_principal uuid,p_client uuid,p_id uuid,p_row jsonb,p_now timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result uuid;
BEGIN
LOCK TABLE public.customer_saved_addresses IN ROW EXCLUSIVE MODE;
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' OR p_now IS NULL OR NOT isfinite(p_now) OR (p_row->>'client_id')::uuid IS DISTINCT FROM p_client THEN RAISE EXCEPTION 'customer_saved_address_invalid_input' USING ERRCODE='22023'; END IF;
IF p_id IS NULL THEN
 INSERT INTO public.customer_saved_addresses(client_id,kind,label,recipient_name,contact_phone,company_name,tax_id,line1,line2,city,postal_code,country,is_default,delivery_notes,courier_instructions,canonical_key,source,updated_at) VALUES(p_client,p_row->>'kind',p_row->>'label',p_row->>'recipient_name',p_row->>'contact_phone',p_row->>'company_name',p_row->>'tax_id',p_row->>'line1',p_row->>'line2',p_row->>'city',p_row->>'postal_code',p_row->>'country',COALESCE((p_row->>'is_default')::boolean,false),p_row->>'delivery_notes',p_row->>'courier_instructions',p_row->>'canonical_key','customer_account',p_now) RETURNING id INTO result;
ELSE
 UPDATE public.customer_saved_addresses SET kind=p_row->>'kind',label=p_row->>'label',recipient_name=p_row->>'recipient_name',contact_phone=p_row->>'contact_phone',company_name=p_row->>'company_name',tax_id=p_row->>'tax_id',line1=p_row->>'line1',line2=p_row->>'line2',city=p_row->>'city',postal_code=p_row->>'postal_code',country=p_row->>'country',is_default=COALESCE((p_row->>'is_default')::boolean,false),delivery_notes=p_row->>'delivery_notes',courier_instructions=p_row->>'courier_instructions',canonical_key=p_row->>'canonical_key',source='customer_account',updated_at=p_now WHERE id=p_id AND client_id=p_client RETURNING id INTO result;
 IF NOT FOUND THEN RAISE EXCEPTION 'customer_saved_address_not_found' USING ERRCODE='P0002'; END IF;
END IF;
RETURN result;
END;
$$;

CREATE FUNCTION public.customer_saved_address_delete(p_principal uuid,p_client uuid,p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
LOCK TABLE public.customer_saved_addresses IN ROW EXCLUSIVE MODE;
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
IF EXISTS(SELECT 1 FROM public.subscriptions WHERE client_id=p_client AND status IN ('active','paused') AND (shipping_saved_address_id=p_id OR billing_saved_address_id=p_id)) THEN RAISE EXCEPTION 'customer_saved_address_in_use' USING ERRCODE='23514'; END IF;
DELETE FROM public.customer_saved_addresses WHERE id=p_id AND client_id=p_client;
RETURN true;
END;
$$;

CREATE FUNCTION public.customer_saved_addresses_export(p_client uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
RETURN COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.customer_saved_addresses a WHERE client_id=p_client),'[]'::jsonb);
END;
$$;

CREATE FUNCTION public.customer_saved_addresses_erase(p_client uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
DELETE FROM public.customer_saved_addresses WHERE client_id=p_client;
RETURN true;
END;
$$;

CREATE FUNCTION public.customer_saved_address_in_use(p_principal uuid,p_client uuid,p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
IF NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client AND principal_id=p_principal) THEN RETURN NULL; END IF;
RETURN EXISTS(SELECT 1 FROM public.subscriptions WHERE client_id=p_client AND status IN ('active','paused') AND (shipping_saved_address_id=p_id OR billing_saved_address_id=p_id));
END;
$$;

CREATE FUNCTION public.customer_saved_addresses_prepare_erasure()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
LOCK TABLE public.customer_saved_addresses IN SHARE ROW EXCLUSIVE MODE; RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.customer_saved_addresses_read(uuid,uuid), public.customer_saved_address_replayed(uuid,uuid,text,text), public.customer_saved_address_canonical(uuid,uuid,text), public.customer_saved_address_clear_defaults(uuid,uuid,text,timestamptz), public.customer_saved_address_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_saved_address_delete(uuid,uuid,uuid), public.customer_saved_addresses_export(uuid), public.customer_saved_addresses_erase(uuid), public.customer_saved_address_in_use(uuid,uuid,uuid), public.customer_saved_addresses_prepare_erasure() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_saved_addresses FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_saved_addresses_read(uuid,uuid), public.customer_saved_address_replayed(uuid,uuid,text,text), public.customer_saved_address_canonical(uuid,uuid,text), public.customer_saved_address_clear_defaults(uuid,uuid,text,timestamptz), public.customer_saved_address_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_saved_address_delete(uuid,uuid,uuid), public.customer_saved_addresses_export(uuid), public.customer_saved_addresses_erase(uuid), public.customer_saved_address_in_use(uuid,uuid,uuid), public.customer_saved_addresses_prepare_erasure() FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_saved_addresses FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_saved_addresses_read(uuid,uuid), public.customer_saved_address_replayed(uuid,uuid,text,text), public.customer_saved_address_canonical(uuid,uuid,text), public.customer_saved_address_clear_defaults(uuid,uuid,text,timestamptz), public.customer_saved_address_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_saved_address_delete(uuid,uuid,uuid), public.customer_saved_addresses_export(uuid), public.customer_saved_addresses_erase(uuid), public.customer_saved_address_in_use(uuid,uuid,uuid), public.customer_saved_addresses_prepare_erasure() FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.customer_saved_addresses FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.customer_saved_addresses_read(uuid,uuid), public.customer_saved_address_replayed(uuid,uuid,text,text), public.customer_saved_address_canonical(uuid,uuid,text), public.customer_saved_address_clear_defaults(uuid,uuid,text,timestamptz), public.customer_saved_address_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_saved_address_delete(uuid,uuid,uuid), public.customer_saved_addresses_export(uuid), public.customer_saved_addresses_erase(uuid), public.customer_saved_address_in_use(uuid,uuid,uuid), public.customer_saved_addresses_prepare_erasure() FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.customer_saved_addresses_read(uuid,uuid), public.customer_saved_address_replayed(uuid,uuid,text,text), public.customer_saved_address_canonical(uuid,uuid,text), public.customer_saved_address_clear_defaults(uuid,uuid,text,timestamptz), public.customer_saved_address_write(uuid,uuid,uuid,jsonb,timestamptz), public.customer_saved_address_delete(uuid,uuid,uuid), public.customer_saved_addresses_export(uuid), public.customer_saved_addresses_erase(uuid), public.customer_saved_address_in_use(uuid,uuid,uuid), public.customer_saved_addresses_prepare_erasure() TO service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.customer_saved_addresses TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY customer_saved_addresses_absorption_census ON public.customer_saved_addresses FOR SELECT TO service_role USING (true);'; END IF; END; $$;
