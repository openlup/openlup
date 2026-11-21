DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='openlup_catalog_publication')
    AND EXISTS (SELECT 1 FROM ONLY public.platform_schema_migrations
      WHERE catalog_path OPERATOR(pg_catalog.=) 'db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql'::pg_catalog.text
        AND sha256 OPERATOR(pg_catalog.=) 'baf0999ba0d8dce9734282c71e4c796514e974f0e42b1fb9089e5c381c742bd8'::pg_catalog.text)
  THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_offer_memberships_page(text,jsonb,integer,text),
      public.catalog_publication_activation_readiness(text[],text) TO openlup_catalog_publication;';
  END IF;
END; $$;
