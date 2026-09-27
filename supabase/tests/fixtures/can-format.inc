-- Dictionary dependencies for the canned-product fixtures in this transaction.
INSERT INTO public.variant_formats (code, display_name) VALUES ('can', 'Test can') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.variant_unit_forms (code, display_name) VALUES ('can', 'Test can') ON CONFLICT (code) DO NOTHING;
