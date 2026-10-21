-- Catalog Wave 2a validates the same-product pointer foreign keys after their
-- NOT VALID installation in the immediately preceding transactional forward.
-- Both pointer columns were introduced nullable and without backfill, so this
-- scan confirms the current catalog before the constraints are marked valid.

ALTER TABLE public.catalog_products
  VALIDATE CONSTRAINT catalog_products_primary_sku_same_product_fkey;

ALTER TABLE public.catalog_products
  VALIDATE CONSTRAINT catalog_products_current_document_revision_same_product_fkey;
