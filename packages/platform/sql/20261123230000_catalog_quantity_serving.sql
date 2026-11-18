-- Keep unadopted legacy rows and frozen publication evidence readable.
-- The governed live SKU projection is checked without rewriting legacy rows.
CREATE FUNCTION public.catalog_check_legacy_net_grams()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_grams numeric;
  v_factor numeric;
  v_scale integer;
  v_divisor numeric;
  v_projection integer;
BEGIN
  IF NEW.publication_facts IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.net_content_dimension = 'mass' THEN
    IF NEW.net_content_unit IN ('openlup:g','openlup:kg') THEN
      v_factor := CASE NEW.net_content_unit WHEN 'openlup:g' THEN 1 ELSE 1000 END;
      v_scale := 0;
    ELSE
      SELECT (unit->'factor'->>'unscaled')::numeric, (unit->'factor'->>'scale')::integer
        INTO v_factor, v_scale
        FROM public.catalog_products product
        JOIN public.catalog_type_versions version ON (version.type_key, version.version) = (product.type_key, product.type_version)
        CROSS JOIN LATERAL jsonb_array_elements(version.definition->'units') unit
        WHERE product.id = NEW.product_id AND unit->>'code' = NEW.net_content_unit AND unit->>'dimension' = 'mass'
          AND unit->'factor'->>'canonicalUnit' = 'openlup:g';
    END IF;
    v_divisor := power(10::numeric, NEW.net_content_scale + v_scale);
    IF mod(NEW.net_content_unscaled * v_factor, v_divisor) = 0 THEN
      v_grams := div(NEW.net_content_unscaled * v_factor, v_divisor);
      IF v_grams BETWEEN 1 AND 2147483647 THEN
        v_projection := v_grams::integer;
      END IF;
    END IF;
  END IF;
  IF NEW.net_weight_g IS DISTINCT FROM v_projection THEN
    RAISE EXCEPTION 'catalog_skus_legacy_net_grams_check'
      USING ERRCODE = '23514', CONSTRAINT = 'catalog_skus_legacy_net_grams_check';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_check_legacy_net_grams() FROM PUBLIC;

ALTER TABLE public.catalog_skus ALTER COLUMN net_weight_g DROP NOT NULL;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_publication_net_content_check
  CHECK (publication_facts IS NULL OR net_content_dimension IS NOT NULL) NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_publication_net_content_check;

CREATE TRIGGER catalog_skus_legacy_net_grams_check BEFORE INSERT OR UPDATE OF
  product_id, publication_facts, net_weight_g, net_content_dimension, net_content_unscaled, net_content_scale, net_content_unit
  ON public.catalog_skus FOR EACH ROW EXECUTE FUNCTION public.catalog_check_legacy_net_grams();
