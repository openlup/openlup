-- Public platform read surface: catalog, pricing and settings.
--
-- Authored from scratch for this forward migration. The column set is exactly what
-- the platform read ports project on the second bundle, not a cut of any historical
-- migration: no business function, trigger, policy or grant is created here, and the
-- product-specific attributes that the chain keeps on a sellable unit are deliberately
-- absent. The capability slice that actually executes them authors them as its own
-- forward, so this catalog never carries a column nothing here reads.

CREATE TABLE public.catalog_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  name text NOT NULL,
  description text,
  CONSTRAINT catalog_products_slug_nonempty_check CHECK (btrim(slug) <> ''),
  CONSTRAINT catalog_products_name_nonempty_check CHECK (btrim(name) <> ''),
  CONSTRAINT catalog_products_status_check CHECK (status IN ('draft', 'active', 'archived'))
);

CREATE UNIQUE INDEX idx_catalog_products_slug ON public.catalog_products (slug);

CREATE TABLE public.catalog_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  product_id uuid NOT NULL REFERENCES public.catalog_products (id) ON DELETE CASCADE,
  sku text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  min_order_qty integer NOT NULL DEFAULT 1,
  is_addon boolean NOT NULL DEFAULT false,
  sellable_standalone boolean NOT NULL DEFAULT true,
  sellable_in_subscription boolean NOT NULL DEFAULT false,
  CONSTRAINT catalog_skus_sku_nonempty_check CHECK (btrim(sku) <> ''),
  CONSTRAINT catalog_skus_status_check CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT catalog_skus_min_order_qty_check CHECK (min_order_qty >= 1)
);

CREATE UNIQUE INDEX idx_catalog_skus_sku ON public.catalog_skus (sku);
CREATE INDEX idx_catalog_skus_product_id ON public.catalog_skus (product_id);

CREATE TABLE public.price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  region_code text NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  CONSTRAINT price_lists_name_nonempty_check CHECK (btrim(name) <> ''),
  CONSTRAINT price_lists_region_code_check CHECK (char_length(region_code) BETWEEN 2 AND 3),
  CONSTRAINT price_lists_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT price_lists_status_check CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT price_lists_validity_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX idx_price_lists_region_currency_status
  ON public.price_lists (region_code, currency, status);

CREATE TABLE public.price_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  price_list_id uuid NOT NULL REFERENCES public.price_lists (id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.catalog_skus (id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'any',
  min_qty integer NOT NULL DEFAULT 1,
  unit_price_minor integer NOT NULL,
  amount_kind text NOT NULL DEFAULT 'gross',
  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  CONSTRAINT price_entries_mode_check CHECK (mode IN ('one_time', 'subscription', 'any')),
  CONSTRAINT price_entries_amount_kind_check CHECK (amount_kind IN ('gross', 'net')),
  CONSTRAINT price_entries_min_qty_check CHECK (min_qty >= 1),
  CONSTRAINT price_entries_unit_price_minor_check CHECK (unit_price_minor >= 0),
  CONSTRAINT price_entries_validity_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX idx_price_entries_variant_mode_list
  ON public.price_entries (variant_id, mode, price_list_id);

CREATE TABLE public.commerce_settings (
  key text PRIMARY KEY,
  value_minor integer,
  value_text text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_settings_key_nonempty_check CHECK (btrim(key) <> '')
);
