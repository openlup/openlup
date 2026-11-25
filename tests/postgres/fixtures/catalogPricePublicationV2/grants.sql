-- Test-only stand-in for the PR 3 signature. PR 2 ships neither EXECUTE.
CREATE FUNCTION public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS 'SELECT';
REVOKE ALL ON FUNCTION public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.catalog_price_setup_apply_v2(text,text,uuid),
  public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) TO openlup_catalog_publication;
