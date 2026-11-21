-- Expand the existing managed SKU projection. Existing writes and role policies
-- retain their old columns and keep the current product document authoritative.
ALTER TABLE public.catalog_skus
  ADD COLUMN net_content_dimension text,
  ADD COLUMN net_content_canonical_amount numeric,
  ADD COLUMN gross_mass_canonical_grams numeric,
  ADD COLUMN net_content_legacy_grams integer,
  ADD CONSTRAINT catalog_skus_exact_content_shape CHECK (
    (net_content_dimension IS NULL AND net_content_canonical_amount IS NULL AND net_content_legacy_grams IS NULL)
    OR (
      net_content_dimension IS NOT NULL AND net_content_dimension IN ('mass', 'volume', 'count')
      AND net_content_canonical_amount IS NOT NULL
      AND net_content_canonical_amount BETWEEN 0.000000000001 AND 9999999999999999999999999999999999999999
      AND net_content_canonical_amount = CAST(net_content_canonical_amount AS numeric(52,12))
      AND (NOT (net_content_dimension = 'count') OR net_content_canonical_amount = CAST(net_content_canonical_amount AS numeric(52,0)))
      AND net_content_legacy_grams IS NOT DISTINCT FROM CASE
        WHEN net_content_dimension = 'mass' AND net_content_canonical_amount BETWEEN 1 AND 2147483647
          AND net_content_canonical_amount = CAST(net_content_canonical_amount AS numeric(52,0))
        THEN CAST(net_content_canonical_amount AS integer)
        ELSE NULL
      END
      AND (net_content_legacy_grams IS NULL OR net_weight_g = net_content_legacy_grams)
    )
  ),
  ADD CONSTRAINT catalog_skus_exact_packaging_mass CHECK (
    gross_mass_canonical_grams IS NULL
    OR (net_content_dimension IS NOT NULL
      AND gross_mass_canonical_grams BETWEEN 0.000000000001 AND 9999999999999999999999999999999999999999
      AND gross_mass_canonical_grams = CAST(gross_mass_canonical_grams AS numeric(52,12))
      AND (NOT (net_content_dimension = 'mass') OR gross_mass_canonical_grams BETWEEN net_content_canonical_amount AND 9999999999999999999999999999999999999999))
  );
