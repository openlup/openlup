-- Inert destination-shaped lexical fixture; no runtime behavior is implemented.

CREATE TABLE public.commerce_destinations (
 id uuid CONSTRAINT commerce_destinations_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL CONSTRAINT commerce_destinations_client_fkey REFERENCES public.clients(id),
 address jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 purchase_order_id uuid CONSTRAINT commerce_destinations_purchase_order_fkey REFERENCES public.commerce_orders(id),
 registration_key text,
 registration_fingerprint text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT commerce_destinations_address_check CHECK (jsonb_typeof(address) = 'object'),
 CONSTRAINT commerce_destinations_revision_check CHECK (revision = 1),
 CONSTRAINT commerce_destinations_purchase_order_key UNIQUE (purchase_order_id),
 CONSTRAINT commerce_destinations_registration_key_key UNIQUE (registration_key),
 CONSTRAINT commerce_destinations_registration_key_check CHECK (registration_key IS NULL OR length(registration_key) BETWEEN 8 AND 200),
 CONSTRAINT commerce_destinations_registration_fingerprint_check CHECK (registration_fingerprint IS NULL OR char_length(registration_fingerprint) = 64),
 CONSTRAINT commerce_destinations_registration_owner_check CHECK (
  (purchase_order_id IS NULL AND registration_key IS NULL AND registration_fingerprint IS NULL)
  OR (purchase_order_id IS NOT NULL AND registration_key IS NOT NULL AND registration_fingerprint IS NOT NULL))
);
CREATE TABLE public.commerce_destination_bindings (
 id uuid CONSTRAINT commerce_destination_bindings_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid CONSTRAINT commerce_destination_bindings_order_fkey REFERENCES public.commerce_orders(id),
 subscription_id uuid CONSTRAINT commerce_destination_bindings_subscription_fkey REFERENCES public.subscriptions(id),
 shipment_id uuid CONSTRAINT commerce_destination_bindings_shipment_fkey REFERENCES public.fulfillment_shipments(id),
 destination_id uuid NOT NULL CONSTRAINT commerce_destination_bindings_destination_fkey REFERENCES public.commerce_destinations(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT commerce_destination_bindings_order_key UNIQUE (order_id),
 CONSTRAINT commerce_destination_bindings_subscription_key UNIQUE (subscription_id),
 CONSTRAINT commerce_destination_bindings_shipment_key UNIQUE (shipment_id),
 CONSTRAINT commerce_destination_bindings_owner_check CHECK (
  (order_id IS NOT NULL AND subscription_id IS NULL AND shipment_id IS NULL)
  OR (order_id IS NULL AND subscription_id IS NOT NULL AND shipment_id IS NULL)
  OR (order_id IS NULL AND subscription_id IS NULL AND shipment_id IS NOT NULL))
);
ALTER TABLE public.commerce_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_destination_bindings ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.commerce_register_order_destination(p_key text,p_order_id uuid,p_address jsonb,p_now timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END; $$;

CREATE FUNCTION public.commerce_read_destination(p_scope text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END; $$;

CREATE FUNCTION public.subscription_change_shipping_destination(p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_expected_version integer,p_now timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END; $$;

CREATE FUNCTION public.customer_support_change_shipping_destination(p_operator_id uuid,p_subscription_id uuid,p_payload jsonb,p_expected_version integer,p_idempotency_key text,p_now timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END; $$;

REVOKE ALL ON TABLE public.commerce_destinations FROM PUBLIC;

REVOKE ALL ON TABLE public.commerce_destination_bindings FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_destinations,public.commerce_destination_bindings FROM anon;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_destinations,public.commerce_destination_bindings FROM authenticated;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.commerce_destinations,public.commerce_destination_bindings FROM service_role;'; END IF; END; $$;

REVOKE ALL ON FUNCTION public.commerce_register_order_destination(text,uuid,jsonb,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.commerce_read_destination(text,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamptz) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_register_order_destination(text,uuid,jsonb,timestamptz),public.commerce_read_destination(text,uuid),public.subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamptz),public.customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamptz) FROM anon;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.commerce_register_order_destination(text,uuid,jsonb,timestamptz),public.commerce_read_destination(text,uuid),public.subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamptz),public.customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamptz) FROM authenticated;'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.commerce_register_order_destination(text,uuid,jsonb,timestamptz),public.commerce_read_destination(text,uuid),public.subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamptz),public.customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamptz) TO service_role;'; END IF; END; $$;
