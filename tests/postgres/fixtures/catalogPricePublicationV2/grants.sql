-- Controlled fixture authority for the installed definitions.
GRANT EXECUTE ON FUNCTION public.catalog_price_setup_apply_v2(text,text,uuid),
  public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) TO openlup_catalog_publication;
