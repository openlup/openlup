-- Speed up catalog publication admission at COMMIT on top of
-- 20261124160000_catalog_canonical_ascii_order.sql by inlining leaf scalars,
-- empty containers, and one level of flat pure-ASCII child objects in
-- catalog_publication_canonical (confining the numeric_value_out_of_range
-- subtransaction to the number branch), and short-circuiting
-- catalog_publication_carriers_valid when no normalized forbidden key token
-- appears in the serialized root (falling back to jsonb_path_query).
-- Preserves exact wire output, depth/prototype checks, carrier validation, and
-- keeps search_path = pg_catalog, public, pg_temp.
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
  IF p_value = '{}'::jsonb THEN RETURN '{}'; END IF;
  IF p_value ?| ARRAY['__proto__','constructor','prototype'] THEN
   RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
  END IF;
  IF (pg_column_size(p_value) > 65536 OR octet_length(p_value::text) <> char_length(p_value::text))
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS k WHERE octet_length(k) <> char_length(k)) THEN
   SELECT '{' || coalesce(string_agg(to_jsonb(item.key)::text || ':' ||
     CASE WHEN p_depth < max_depth THEN
       CASE jsonb_typeof(item.value)
       WHEN 'string' THEN item.value::text
       WHEN 'boolean' THEN item.value::text
       WHEN 'null' THEN 'null'
       WHEN 'number' THEN CASE WHEN item.value::text ~ '^(0|-?[1-9][0-9]{0,14})$' THEN item.value::text ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
       WHEN 'object' THEN CASE WHEN item.value = '{}'::jsonb THEN '{}' ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
       WHEN 'array' THEN CASE WHEN item.value = '[]'::jsonb THEN '[]' ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
       ELSE public.catalog_publication_canonical(item.value,p_depth+1)
       END
     ELSE public.catalog_publication_canonical(item.value,p_depth+1)
     END, ',' ORDER BY
       CASE WHEN item.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
         CASE WHEN item.key::bigint < 4294967295 THEN item.key::bigint END
       END NULLS LAST,
       ARRAY(SELECT CASE WHEN cp <= 65535 THEN cp ELSE 55296 + (cp - 65536) / 1024 END * 1024
                   + CASE WHEN cp <= 65535 THEN 0 ELSE (cp - 65536) % 1024 END
             FROM generate_series(1,char_length(item.key)) AS i
             CROSS JOIN LATERAL (SELECT ascii(substr(item.key,i,1)) AS cp) AS point ORDER BY i)), '') || '}'
    INTO result FROM jsonb_each(p_value) AS item;
  ELSE
   SELECT '{' || coalesce(string_agg(to_jsonb(item.key)::text || ':' ||
     CASE WHEN p_depth < max_depth THEN
       CASE jsonb_typeof(item.value)
       WHEN 'string' THEN item.value::text
       WHEN 'boolean' THEN item.value::text
       WHEN 'null' THEN 'null'
       WHEN 'number' THEN CASE WHEN item.value::text ~ '^(0|-?[1-9][0-9]{0,14})$' THEN item.value::text ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
       WHEN 'object' THEN
         CASE WHEN item.value = '{}'::jsonb THEN '{}'
         WHEN p_depth + 1 < max_depth
           AND NOT (item.value ?| ARRAY['__proto__','constructor','prototype'])
           AND pg_column_size(item.value) <= 4096
           AND octet_length(item.value::text) = char_length(item.value::text)
         THEN (
           SELECT '{' || coalesce(string_agg(to_jsonb(sub.key)::text || ':' ||
             CASE jsonb_typeof(sub.value)
             WHEN 'string' THEN sub.value::text
             WHEN 'boolean' THEN sub.value::text
             WHEN 'null' THEN 'null'
             WHEN 'number' THEN CASE WHEN sub.value::text ~ '^(0|-?[1-9][0-9]{0,14})$' THEN sub.value::text ELSE public.catalog_publication_canonical(sub.value,p_depth+2) END
             WHEN 'object' THEN CASE WHEN sub.value = '{}'::jsonb THEN '{}' ELSE public.catalog_publication_canonical(sub.value,p_depth+2) END
             WHEN 'array' THEN CASE WHEN sub.value = '[]'::jsonb THEN '[]' ELSE public.catalog_publication_canonical(sub.value,p_depth+2) END
             ELSE public.catalog_publication_canonical(sub.value,p_depth+2)
             END, ',' ORDER BY
               CASE WHEN ascii(sub.key) BETWEEN 48 AND 57 AND sub.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
                 CASE WHEN sub.key::bigint < 4294967295 THEN sub.key::bigint END
               END NULLS LAST,
               sub.key COLLATE "C"), '') || '}'
           FROM jsonb_each(item.value) AS sub
         )
         ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
       WHEN 'array' THEN CASE WHEN item.value = '[]'::jsonb THEN '[]' ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
       ELSE public.catalog_publication_canonical(item.value,p_depth+1)
       END
     ELSE public.catalog_publication_canonical(item.value,p_depth+1)
     END, ',' ORDER BY
       CASE WHEN ascii(item.key) BETWEEN 48 AND 57 AND item.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
         CASE WHEN item.key::bigint < 4294967295 THEN item.key::bigint END
       END NULLS LAST,
       item.key COLLATE "C"), '') || '}'
    INTO result FROM jsonb_each(p_value) AS item;
  END IF;
  RETURN result;
 WHEN 'array' THEN
  IF p_value = '[]'::jsonb THEN RETURN '[]'; END IF;
  SELECT '[' || coalesce(string_agg(
    CASE WHEN p_depth < max_depth THEN
      CASE jsonb_typeof(item.value)
      WHEN 'string' THEN item.value::text
      WHEN 'boolean' THEN item.value::text
      WHEN 'null' THEN 'null'
      WHEN 'number' THEN CASE WHEN item.value::text ~ '^(0|-?[1-9][0-9]{0,14})$' THEN item.value::text ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
      WHEN 'object' THEN
        CASE WHEN item.value = '{}'::jsonb THEN '{}'
        WHEN p_depth + 1 < max_depth
          AND NOT (item.value ?| ARRAY['__proto__','constructor','prototype'])
          AND pg_column_size(item.value) <= 4096
          AND octet_length(item.value::text) = char_length(item.value::text)
        THEN (
          SELECT '{' || coalesce(string_agg(to_jsonb(sub.key)::text || ':' ||
            CASE jsonb_typeof(sub.value)
            WHEN 'string' THEN sub.value::text
            WHEN 'boolean' THEN sub.value::text
            WHEN 'null' THEN 'null'
            WHEN 'number' THEN CASE WHEN sub.value::text ~ '^(0|-?[1-9][0-9]{0,14})$' THEN sub.value::text ELSE public.catalog_publication_canonical(sub.value,p_depth+2) END
            WHEN 'object' THEN CASE WHEN sub.value = '{}'::jsonb THEN '{}' ELSE public.catalog_publication_canonical(sub.value,p_depth+2) END
            WHEN 'array' THEN CASE WHEN sub.value = '[]'::jsonb THEN '[]' ELSE public.catalog_publication_canonical(sub.value,p_depth+2) END
            ELSE public.catalog_publication_canonical(sub.value,p_depth+2)
            END, ',' ORDER BY
              CASE WHEN ascii(sub.key) BETWEEN 48 AND 57 AND sub.key ~ '^(0|[1-9][0-9]{0,9})$' THEN
                CASE WHEN sub.key::bigint < 4294967295 THEN sub.key::bigint END
              END NULLS LAST,
              sub.key COLLATE "C"), '') || '}'
          FROM jsonb_each(item.value) AS sub
        )
        ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
      WHEN 'array' THEN CASE WHEN item.value = '[]'::jsonb THEN '[]' ELSE public.catalog_publication_canonical(item.value,p_depth+1) END
      ELSE public.catalog_publication_canonical(item.value,p_depth+1)
      END
    ELSE public.catalog_publication_canonical(item.value,p_depth+1)
    END, ',' ORDER BY item.ordinality), '') || ']'
   INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item;
  RETURN result;
 WHEN 'number' THEN
  -- PostgreSQL's shortest round-trip float output is input to ECMAScript's
  -- decimal/scientific formatting thresholds.
  BEGIN
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
  EXCEPTION WHEN numeric_value_out_of_range THEN
   RAISE EXCEPTION 'catalog_publication_wire_invalid' USING ERRCODE='23514', CONSTRAINT='catalog_publication_wire_invalid';
  END;
 ELSE RETURN p_value::text;
 END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_publication_carriers_valid(p_value jsonb,p_product uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT
  CASE
   WHEN root IS NULL THEN true
   WHEN translate(lower(root::text),'_','') !~ '"(?:document(?:payload)?|canonicaltext)":' THEN true
   ELSE NOT EXISTS (
    SELECT 1 FROM jsonb_path_query(root, '$.** ? (@.type() == "object").keyvalue().key') AS k
    WHERE translate(lower(k #>> '{}'),'_','') IN ('document','documentpayload','canonicaltext')
   )
  END
  AND CASE WHEN p_product IS NULL OR p_value IS NULL OR NOT (p_value ? 'document') THEN true
   WHEN jsonb_typeof(document) IS DISTINCT FROM 'object' THEN false
   ELSE (document ?& ARRAY['id','productId','revisionNo','schemaId','documentRef','sourceRef','digest']
    AND document-ARRAY['id','productId','revisionNo','schemaId','documentRef','sourceRef','digest']='{}'::jsonb
    AND document->'productId'=to_jsonb(p_product)
    AND jsonb_typeof(document->'id')='string'
    AND document->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND CASE WHEN jsonb_typeof(document->'revisionNo')='number' AND document->>'revisionNo' ~ '^[1-9][0-9]{0,9}$'
      THEN (document->>'revisionNo')::numeric<=2147483647 ELSE false END
    AND jsonb_typeof(document->'digest')='string' AND document->>'digest' ~ '^[0-9a-f]{64}$'
    AND public.catalog_publication_text_valid(document->'schemaId',240,true)
    AND public.catalog_publication_text_valid(document->'documentRef',240,true)
    AND public.catalog_publication_text_valid(document->'sourceRef',240,true)) IS TRUE
  END
 FROM (
  SELECT
   CASE WHEN p_product IS NOT NULL AND jsonb_typeof(p_value)='object' THEN p_value-'document' ELSE p_value END AS root,
   p_value->'document' AS document
 ) reference
$$;
