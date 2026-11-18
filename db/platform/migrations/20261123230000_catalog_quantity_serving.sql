-- Keep unadopted legacy rows and frozen publication evidence readable.
-- A governed live row has a nullable, exact integer-gram projection.
CREATE FUNCTION public.catalog_legacy_net_grams(p_product_id uuid, p_dimension text, p_unscaled pg_catalog.numeric, p_scale integer, p_unit text)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_grams numeric;
  v_factor numeric;
  v_scale integer;
  v_divisor numeric;
BEGIN
  IF p_dimension IS DISTINCT FROM 'mass' OR p_unscaled IS NULL OR p_scale IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_unit IN ('openlup:g','openlup:kg') THEN
    v_factor := CASE p_unit WHEN 'openlup:g' THEN 1 ELSE 1000 END;
    v_scale := 0;
  ELSE
    SELECT (unit->'factor'->>'unscaled')::numeric, (unit->'factor'->>'scale')::integer
      INTO v_factor, v_scale
      FROM public.catalog_products product
      JOIN public.catalog_type_versions version ON (version.type_key, version.version) = (product.type_key, product.type_version)
      CROSS JOIN LATERAL jsonb_array_elements(version.definition->'units') unit
      WHERE product.id = p_product_id AND unit->>'code' = p_unit AND unit->>'dimension' = 'mass'
        AND unit->'factor'->>'canonicalUnit' = 'openlup:g';
  END IF;
  v_divisor := power(10::numeric, p_scale + v_scale);
  IF mod(p_unscaled * v_factor, v_divisor) <> 0 THEN
    RETURN NULL;
  END IF;
  v_grams := div(p_unscaled * v_factor, v_divisor);
  IF v_grams BETWEEN 1 AND 2147483647 THEN
    RETURN v_grams::integer;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_legacy_net_grams(uuid,text,pg_catalog.numeric,integer,text) FROM PUBLIC;

ALTER TABLE public.catalog_skus ALTER COLUMN net_weight_g DROP NOT NULL;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_legacy_net_grams_check CHECK (
  publication_facts IS NULL OR (net_content_dimension IS NOT NULL AND
    net_weight_g IS NOT DISTINCT FROM public.catalog_legacy_net_grams(
      product_id, net_content_dimension, net_content_unscaled, net_content_scale, net_content_unit))
) NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_legacy_net_grams_check;
