CREATE OR REPLACE FUNCTION public.catalog_publication_canonical(p_value jsonb, p_depth integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result text; number_text text; number_value numeric; original_precision text;
 max_depth CONSTANT integer := public.catalog_publication_max_depth();
BEGIN
 -- Root depth is zero. Count values, including empty containers, but not keys.
 IF p_depth > max_depth THEN
  RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='22023';
 END IF;
 CASE jsonb_typeof(p_value)
 WHEN 'object' THEN
  IF p_value ?| ARRAY['__proto__','constructor','prototype'] THEN
   RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
  END IF;
  -- On ASCII keys, UTF-16 code units and C-collated bytes have the same order,
  -- including when one key is a prefix of another.
  IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS item(key)
                 WHERE octet_length(item.key) <> char_length(item.key)) THEN
   SELECT '{' || coalesce(string_agg(to_jsonb(item.key)::text || ':' ||
     public.catalog_publication_canonical(item.value,p_depth+1), ',' ORDER BY
       CASE WHEN item.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
         CASE WHEN item.key::bigint < 4294967295 THEN item.key::bigint END
       END NULLS LAST,
       item.key COLLATE "C"), '') || '}'
    INTO result FROM jsonb_each(p_value) AS item;
  ELSE
   SELECT '{' || coalesce(string_agg(to_jsonb(item.key)::text || ':' ||
     public.catalog_publication_canonical(item.value,p_depth+1), ',' ORDER BY
       CASE WHEN item.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
         CASE WHEN item.key::bigint < 4294967295 THEN item.key::bigint END
       END NULLS LAST,
       ARRAY(SELECT CASE WHEN cp <= 65535 THEN cp ELSE 55296 + (cp - 65536) / 1024 END * 1024
                   + CASE WHEN cp <= 65535 THEN 0 ELSE (cp - 65536) % 1024 END
             FROM generate_series(1,char_length(item.key)) AS i
             CROSS JOIN LATERAL (SELECT ascii(substr(item.key,i,1)) AS cp) AS point ORDER BY i)), '') || '}'
    INTO result FROM jsonb_each(p_value) AS item;
  END IF;
  RETURN result;
 WHEN 'array' THEN
  SELECT '[' || coalesce(string_agg(public.catalog_publication_canonical(item.value,p_depth+1),',' ORDER BY item.ordinality),'') || ']'
   INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item;
  RETURN result;
 WHEN 'number' THEN
  -- PostgreSQL's shortest round-trip float output is input to ECMAScript's
  -- decimal/scientific formatting thresholds.
  original_precision := current_setting('extra_float_digits');
  PERFORM set_config('extra_float_digits','3',true);
  number_text := (p_value::double precision)::text;
  PERFORM set_config('extra_float_digits',original_precision,true);
  number_value := number_text::numeric;
  IF number_value = 0 THEN RETURN '0'; END IF;
  IF abs(number_value) >= 0.000001 AND abs(number_value) < 1e21 THEN
   RETURN trim_scale(number_value)::text;
  END IF;
  RETURN regexp_replace(number_text,'e([+-])0+([0-9]+)$','e\1\2');
 ELSE RETURN p_value::text;
 END CASE;
EXCEPTION WHEN numeric_value_out_of_range THEN
 RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
END;
$$;
