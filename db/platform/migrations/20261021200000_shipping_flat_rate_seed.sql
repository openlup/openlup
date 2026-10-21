INSERT INTO public.commerce_settings (key, value_minor) VALUES ('shipping_flat_minor', 0) ON CONFLICT (key) DO NOTHING;
