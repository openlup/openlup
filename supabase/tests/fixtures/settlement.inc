-- Explicit example settlement for a test transaction; never an application seed.
INSERT INTO public.commerce_settings (key, value_text, value_minor) VALUES
  ('settlement_currency', :'fixture_currency', NULL),
  ('settlement_region', :'fixture_region', NULL),
  ('min_product_payable_minor', NULL, :'fixture_payable_floor'::integer)
ON CONFLICT (key) DO NOTHING;
