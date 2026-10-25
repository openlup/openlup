-- CTL-M11 reviewed fixture: close the M05 metadata-decoding dependency of checkout
-- acquisition admission. Restate the donor definition and closed private ACL
-- unchanged; existing promotions JSONB is the storage, with no seed or activation.
-- Admitted pin: config/reviewed-platform-forwards.json managedCommerceForwards.
-- M11 feature PRs (the K1 stack) introduce these bytes in registry order.
-- This file requires every earlier same-rail M10/M11 pin to have landed.
-- Pin admission does not establish installation or runtime behavior.

CREATE FUNCTION private.commerce_acquisition_metadata(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE m jsonb := p_payload->'acquisitionTerms';
BEGIN
  IF NOT (p_payload ? 'acquisitionTerms') THEN RETURN NULL; END IF;
  IF jsonb_typeof(m) IS DISTINCT FROM 'object'
    OR m - ARRAY['schemaVersion','revision','delivery2DiscountBps'] <> '{}'::jsonb
    OR m->>'schemaVersion' IS DISTINCT FROM 'subscription-acquisition.v1'
    OR jsonb_typeof(m->'revision') IS DISTINCT FROM 'string'
    OR m->>'revision' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    OR jsonb_typeof(m->'delivery2DiscountBps') IS DISTINCT FROM 'number'
    OR m->>'delivery2DiscountBps' !~ '^(0|[1-9][0-9]{0,4})(\.0+)?$'
    OR (m->>'delivery2DiscountBps')::numeric > 10000 THEN
    RAISE EXCEPTION 'acquisition_terms_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN m;
END;
$$;
REVOKE ALL ON FUNCTION private.commerce_acquisition_metadata(jsonb) FROM PUBLIC, anon, authenticated, service_role;
