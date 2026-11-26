-- Disposable test authority for exercising issuance behind the existing two-grant gate.
-- Installed profiles leave the reader owner-only.
GRANT EXECUTE ON FUNCTION public.catalog_price_setup_apply_v2(text,text,uuid),
  public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid) TO openlup_catalog_publication;
