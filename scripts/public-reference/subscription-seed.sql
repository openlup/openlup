-- Disposable subscription reference fixture for the public managed baseline.
-- Only a synthetic catalog, price, stock and settings; no buyer, order or subscription.
-- The current neutral reference adapter maps its public SKU to the legacy canonical SKU.

BEGIN;
DO $$
DECLARE
  product_id uuid;
  sku_id uuid;
  price_list_id uuid;
  location_id uuid;
  reference_currency constant text := 'PLN';
BEGIN
  INSERT INTO public.catalog_products (slug, status, name, ingredients)
  VALUES ('p5-neutral-refill', 'active', 'P5 Neutral Refill', ARRAY['Neutral ingredient'])
  RETURNING id INTO product_id;

  INSERT INTO public.catalog_skus (
    product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit,
    sellable_standalone, sellable_in_subscription, requires_pet_profile, min_order_qty
  ) VALUES (
    product_id, 'OPENLUP-DOG-LAMB-CAN-400G', 'P5 Neutral Refill', 'other',
    'active', 400, 400, true, true, false, 1
  ) RETURNING id INTO sku_id;

  UPDATE public.catalog_products SET primary_sku_id = sku_id WHERE id = product_id;

  INSERT INTO public.price_lists (name, region_code, currency, status)
  VALUES ('P5 disposable reference', 'PL', reference_currency, 'active')
  RETURNING id INTO price_list_id;

  INSERT INTO public.price_entries (price_list_id, variant_id, mode, min_qty, unit_price_minor)
  VALUES
    (price_list_id, sku_id, 'one_time', 1, 1990),
    (price_list_id, sku_id, 'subscription', 1, 1490);

  INSERT INTO public.inventory_locations (code, display_name, kind, status, fulfillable, region)
  VALUES ('p5-disposable', 'P5 Disposable', 'internal_warehouse', 'active', true, 'PL')
  RETURNING id INTO location_id;

  INSERT INTO public.inventory_balances (sku_id, location_id, on_hand)
  VALUES (sku_id, location_id, 10);

  INSERT INTO public.commerce_settings (key, value_text, value_minor)
  VALUES
    ('settlement_currency', reference_currency, NULL),
    ('settlement_region', 'PL', NULL),
    ('min_product_payable_minor', NULL, 100),
    ('shipping_flat_minor', NULL, 0);
END $$;
COMMIT;
