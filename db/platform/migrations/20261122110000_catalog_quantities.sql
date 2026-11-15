-- Native-only quantity storage. Legacy readers and runtime capabilities remain unchanged.
-- Gross dimension is explicit so storage itself refuses non-mass gross quantities.
ALTER TABLE public.catalog_skus
  ADD COLUMN net_content_dimension text,
  ADD COLUMN net_content_unscaled numeric(40,0),
  ADD COLUMN net_content_scale smallint,
  ADD COLUMN net_content_unit text,
  ADD COLUMN gross_mass_dimension text,
  ADD COLUMN gross_mass_unscaled numeric(40,0),
  ADD COLUMN gross_mass_scale smallint,
  ADD COLUMN gross_mass_unit text;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_net_content_check CHECK (
  (net_content_dimension IS NULL AND net_content_unscaled IS NULL AND net_content_scale IS NULL AND net_content_unit IS NULL)
  OR (net_content_dimension IS NOT NULL AND net_content_unscaled IS NOT NULL AND net_content_scale IS NOT NULL AND net_content_unit IS NOT NULL
    AND net_content_dimension IN ('mass', 'volume', 'count') AND net_content_unscaled BETWEEN 1 AND 9999999999999999999999999999999999999999
    AND net_content_scale BETWEEN 0 AND 12)) NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_net_content_check;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_gross_mass_check CHECK (
  (gross_mass_dimension IS NULL AND gross_mass_unscaled IS NULL AND gross_mass_scale IS NULL AND gross_mass_unit IS NULL)
  OR (gross_mass_dimension IS NOT NULL AND gross_mass_unscaled IS NOT NULL AND gross_mass_scale IS NOT NULL AND gross_mass_unit IS NOT NULL
    AND gross_mass_dimension = 'mass' AND gross_mass_unscaled BETWEEN 1 AND 9999999999999999999999999999999999999999
    AND gross_mass_scale BETWEEN 0 AND 12)) NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_gross_mass_check;

-- Installation owns the resumable backfill; migration application never drains data.
CREATE FUNCTION public.catalog_net_content_backfill_batch(p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sku record;
  v_remaining bigint;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN
    RAISE EXCEPTION 'invalid_catalog_backfill_batch_size' USING ERRCODE = '22023';
  END IF;
  -- Catalogue rows only, in ascending identity order, without blocking FK key-share locks.
  FOR v_sku IN
    SELECT id, net_weight_g FROM public.catalog_skus
    WHERE net_content_dimension IS NULL AND net_weight_g > 0
    ORDER BY id LIMIT p_batch_size FOR NO KEY UPDATE
  LOOP
    UPDATE public.catalog_skus SET net_content_dimension = 'mass',
      net_content_unscaled = v_sku.net_weight_g, net_content_scale = 0, net_content_unit = 'openlup:g'
    WHERE id = v_sku.id AND net_content_dimension IS NULL;
  END LOOP;
  SELECT count(*) INTO v_remaining FROM public.catalog_skus
    WHERE net_content_dimension IS NULL AND net_weight_g > 0;
  RETURN v_remaining;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_net_content_backfill_batch(integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_net_content_backfill_batch(integer) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_net_content_backfill_batch(integer) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_net_content_backfill_batch(integer) FROM service_role;'; END IF; END; $$;
