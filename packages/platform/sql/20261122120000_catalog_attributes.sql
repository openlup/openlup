-- Native attribute storage only; publication and projection consumers remain unbound.
-- Each nullable attribute object has an independent 1 MiB PostgreSQL rendered-text ceiling.
ALTER TABLE public.catalog_products ADD COLUMN attribute_values jsonb;
ALTER TABLE public.catalog_skus ADD COLUMN attribute_values jsonb;
ALTER TABLE public.catalog_products ADD CONSTRAINT catalog_products_attribute_values_check CHECK (
  attribute_values IS NULL OR (jsonb_typeof(attribute_values) = 'object' AND octet_length(CAST(attribute_values AS text)) BETWEEN 0 AND 1048576)) NOT VALID;
ALTER TABLE public.catalog_products VALIDATE CONSTRAINT catalog_products_attribute_values_check;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_attribute_values_check CHECK (
  attribute_values IS NULL OR (jsonb_typeof(attribute_values) = 'object' AND octet_length(CAST(attribute_values AS text)) BETWEEN 0 AND 1048576)) NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_attribute_values_check;
CREATE TABLE public.catalog_attribute_projection (
  sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) ON DELETE CASCADE,
  publication_revision bigint NOT NULL,
  attribute_key text NOT NULL,
  definition_version integer NOT NULL,
  value_ordinal integer NOT NULL,
  value_kind text NOT NULL,
  text_value text,
  numeric_value numeric,
  bool_value boolean,
  date_value date,
  ref_value text,
  quantity_dimension text,
  canonical_unit text,
  canonical_value numeric(52,12),
  PRIMARY KEY (sku_id, publication_revision, attribute_key, definition_version, value_ordinal)
);
ALTER TABLE public.catalog_attribute_projection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_attribute_projection FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_attribute_projection FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_attribute_projection FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_attribute_projection FROM service_role;'; END IF; END; $$;
CREATE INDEX catalog_attribute_projection_text_idx ON public.catalog_attribute_projection(attribute_key, definition_version, text_value, sku_id);
CREATE INDEX catalog_attribute_projection_numeric_idx ON public.catalog_attribute_projection(attribute_key, definition_version, numeric_value, sku_id);
CREATE INDEX catalog_attribute_projection_quantity_idx ON public.catalog_attribute_projection(attribute_key, definition_version, quantity_dimension, canonical_unit, canonical_value, sku_id);
