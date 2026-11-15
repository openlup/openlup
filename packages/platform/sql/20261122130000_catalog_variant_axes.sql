-- Native identity storage only; trusted V2 preparation is unbound, publication remains separate.
ALTER TABLE public.catalog_products ADD COLUMN variant_axes text[];
ALTER TABLE public.catalog_skus ADD COLUMN option_values jsonb, ADD COLUMN canonical_option_bytes bytea, ADD COLUMN combination_digest bytea;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_option_values_check CHECK (
  option_values IS NULL OR jsonb_typeof(option_values) = 'object') NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_option_values_check;
ALTER TABLE public.catalog_skus ADD CONSTRAINT catalog_skus_combination_digest_check CHECK (
  combination_digest IS NULL OR octet_length(combination_digest) = 32) NOT VALID;
ALTER TABLE public.catalog_skus VALIDATE CONSTRAINT catalog_skus_combination_digest_check;
CREATE UNIQUE INDEX catalog_skus_active_combination_idx ON public.catalog_skus(product_id, combination_digest)
WHERE status = 'active' AND combination_digest IS NOT NULL;
