-- Owned local stock fixture, without any deployment inventory.
-- Register the referenced provider before the location's foreign key is checked.
INSERT INTO public.providers (kind, capability, display_name, status)
VALUES (:'fixture_provider', 'fulfillment', 'Test fulfillment provider', 'experimental')
ON CONFLICT (kind) DO NOTHING;
INSERT INTO public.inventory_locations (id, code, display_name, kind, status, fulfillable, provider_kind)
VALUES ('00000000-0000-4000-8000-00000000c101', :'fixture_stock_location', 'Test stock master', 'virtual', 'active', true, :'fixture_provider')
ON CONFLICT (code) DO NOTHING;
