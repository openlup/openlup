-- Public platform sales-channel registry: the kernel learns that a sale can come from somewhere
-- other than the deployment's own storefront. Three relations, one seed row, no behaviour.
--
-- WHAT THIS FORWARD SHIPS. Every rail before this one assumed a single origin. An order could be
-- held, shipped, invoiced and paid for, and at no point could it say WHERE it was sold. That was
-- safe while there was one answer. This forward registers the vocabulary for more than one: a
-- CONNECTION is one credentialed link to an external marketplace, a CHANNEL is one selling surface
-- reached through that link, and a LISTING is one of the deployment's sellables offered on one
-- channel. After this forward an adopter can DESCRIBE a second sales origin. Nothing yet reads it.
--
-- WHAT IT REFUSES TO KNOW, AND THIS IS THE LOAD-BEARING PART. There is NO marketplace here and
-- there will not be one. Not a name, not an enum, not a column that only one integration would
-- populate. `connector_provider_kind` and `settlement_provider_kind` are opaque shape-checked
-- labels: this kernel writes them, compares them for equality, and never parses either. An enum of
-- marketplace names would make onboarding an integration a schema migration, and would put one
-- market's vendors in every adopter's database.
--
-- CURRENCY IS A COLUMN WITH A CHECKED SHAPE AND NO DEFAULT, following the rule the settlement rail
-- stated outright: a kernel that hard-codes one market's currency has chosen that market for every
-- adopter. The same restraint covers `region_code`, which is nullable and uninterpreted, and the
-- VAT rate, which is basis points this kernel stores and never applies.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE. The shape below was derived from the managed
-- chain's registry authored in the same wave. Three departures, each named, because a silent one is
-- how a kernel and its origin quietly stop being the same machine:
--
--   1. NO ROW-LEVEL SECURITY, NO POLICY, NO `GRANT`/`REVOKE`, matching every forward in this
--      catalogue. The managed twin enables RLS, adds an admin-only SELECT policy and hands writes
--      to `service_role`. None of those principals exist on this kernel and it creates zero roles,
--      so authoring them here would be authoring three empty shapes. Said out loud rather than
--      assumed: ON THIS KERNEL THESE TABLES ARE NOT A SECURITY BOUNDARY. The host application is
--      what decides who may read a credential reference or write a listing.
--   2. CURRENCY IS NULLABLE AND UNDEFAULTED, where the managed twin is NOT NULL and defaults to its
--      own market's code because it serves exactly one market. Removing only the default would not
--      be enough: the seed row below would then have to state a currency, and there is no neutral
--      one to state. So this follows the device the settlement rail already settled on for money it
--      cannot know -- the column is nullable and NULL means "this surface has not declared one
--      yet", which is exactly the state a freshly booted kernel is in. The shape is still checked
--      whenever a value is present. An adopter states the currency; the kernel never guesses it.
--   3. `CREATE` IS UNCONDITIONAL AND EVERY CONSTRAINT IS NAMED, because a manifest-ordered forward
--      runs exactly once against a known prefix and `IF NOT EXISTS` there would hide the drift the
--      migration ledger exists to catch. The managed twin is written for a chronological chain that
--      may meet a partially-applied database, and guards accordingly.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no channel column on the order row, and no join from an order to a channel. Attribution is
--     its own capability with its own forward; a registry nothing points at is still a registry;
--   * no connector, no adapter, no pull loop, no push of stock or price, no webhook ingestion and
--     no reconciliation sweep. The cursor and watermark columns are where such a loop would keep
--     its place, and they stay NULL until one exists;
--   * no credential storage. `credential_ref` names a secret the deployment holds elsewhere;
--   * no pricing, no tax arithmetic, no fee model and no payout ledger. A channel that settles its
--     own money is recorded as a label, not modelled;
--   * no runtime binding. Not one line of the application is rewired onto these relations here.

-- One credentialed link to one external marketplace. `connector_shape` is the whole aggregator
-- distinction, and it is the only structural fact this kernel needs about the far side: 'direct'
-- means the deployment holds that marketplace's own credentials, 'aggregator' means an intermediary
-- holds them and fans out to several channels underneath this single row.
CREATE TABLE public.sales_channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  connector_provider_kind text NOT NULL,
  connector_shape text NOT NULL DEFAULT 'direct',
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  -- The NAME of a secret the deployment holds somewhere else. Never a secret.
  credential_ref text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where an incremental pull of this connection got to, for whichever loop an adopter builds.
  pull_cursor text,
  pull_watermark_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_channel_connections_slug_key UNIQUE (slug),
  CONSTRAINT sales_channel_connections_slug_check
    CHECK (btrim(slug) <> '' AND char_length(slug) <= 64),
  CONSTRAINT sales_channel_connections_connector_provider_kind_check
    CHECK (btrim(connector_provider_kind) <> '' AND char_length(connector_provider_kind) <= 64),
  CONSTRAINT sales_channel_connections_connector_shape_check
    CHECK (connector_shape IN ('direct', 'aggregator')),
  CONSTRAINT sales_channel_connections_status_check
    CHECK (status IN ('disabled', 'testing', 'active', 'sunset'))
);

COMMENT ON COLUMN public.sales_channel_connections.connector_provider_kind IS
  'Opaque label naming whatever integration reaches this marketplace. Never parsed here.';
COMMENT ON COLUMN public.sales_channel_connections.credential_ref IS
  'Name or handle of a secret held outside the database. This kernel stores no credential values.';

-- One selling surface an order can originate from. A marketplace surface always hangs off a
-- connection; a surface the deployment owns does not, because there is no external party to
-- authenticate against.
CREATE TABLE public.sales_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES public.sales_channel_connections(id) ON DELETE RESTRICT,
  slug text NOT NULL,
  kind text NOT NULL DEFAULT 'marketplace',
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  -- The marketplace's own identifier for this surface. Opaque; written and compared, never parsed.
  channel_external_ref text,
  -- Departure 2: shape checked, value never, and nullable because a kernel that cannot know the
  -- market also cannot know its currency. NULL means "this surface has not declared one yet".
  currency text,
  region_code text,
  default_vat_rate_bps integer,
  -- Two facts that are the marketplace's policy rather than the deployment's preference: several
  -- channels forbid the seller from contacting the buyer, and several issue the invoice themselves.
  buyer_comms_owner text NOT NULL DEFAULT 'platform',
  invoice_policy text NOT NULL DEFAULT 'issue',
  settlement_provider_kind text NOT NULL DEFAULT 'channel_settlement',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_channels_slug_key UNIQUE (slug),
  CONSTRAINT sales_channels_slug_check
    CHECK (btrim(slug) <> '' AND char_length(slug) <= 64),
  CONSTRAINT sales_channels_kind_check
    CHECK (btrim(kind) <> '' AND char_length(kind) <= 32),
  CONSTRAINT sales_channels_status_check
    CHECK (status IN ('disabled', 'testing', 'active', 'sunset')),
  CONSTRAINT sales_channels_currency_check
    CHECK (currency IS NULL OR char_length(currency) = 3),
  CONSTRAINT sales_channels_default_vat_rate_bps_check
    CHECK (default_vat_rate_bps IS NULL OR default_vat_rate_bps BETWEEN 0 AND 10000),
  CONSTRAINT sales_channels_buyer_comms_owner_check
    CHECK (buyer_comms_owner IN ('platform', 'channel')),
  CONSTRAINT sales_channels_invoice_policy_check
    CHECK (invoice_policy IN ('issue', 'suppress', 'channel_issues')),
  CONSTRAINT sales_channels_settlement_provider_kind_check
    CHECK (btrim(settlement_provider_kind) <> '' AND char_length(settlement_provider_kind) <= 64),
  -- A marketplace surface with no connection has no way to be reached. Any surface the deployment
  -- owns may stand alone, which is what lets the seed row below exist before any integration does.
  CONSTRAINT sales_channels_connection_required_for_connected_kinds
    CHECK (kind <> 'marketplace' OR connection_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_sales_channels_connection_external_ref
  ON public.sales_channels (connection_id, channel_external_ref)
  WHERE connection_id IS NOT NULL AND channel_external_ref IS NOT NULL;

CREATE INDEX idx_sales_channels_status_kind
  ON public.sales_channels (status, kind);

COMMENT ON COLUMN public.sales_channels.currency IS
  'Three-character code the deployment declared for this surface. Shape is checked; value never is.';
COMMENT ON COLUMN public.sales_channels.settlement_provider_kind IS
  'Opaque label naming whoever settles money for this surface. Never parsed here.';

-- The deployment's own storefront, so the origin every existing order already had has a row to
-- name before any external channel exists. A fresh kernel starts with exactly one sales channel,
-- which is the state every deployment was in before this forward.
-- Currency is deliberately omitted rather than guessed: the adopter declares it.
INSERT INTO public.sales_channels (slug, kind, display_name, status, buyer_comms_owner, invoice_policy)
VALUES ('storefront', 'storefront', 'Storefront', 'active', 'platform', 'issue');

-- One sellable offered on one channel. `sellable_kind` plus one nullable identifier per kind is
-- chosen so a later capability can add a second kind as a SUPERSET of the shape constraint rather
-- than a rewrite of it: today exactly one kind resolves to a column, and the constraint says so in
-- a form that extends by adding a branch.
CREATE TABLE public.sales_channel_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.sales_channels(id) ON DELETE CASCADE,
  sellable_kind text NOT NULL,
  sellable_sku_id uuid REFERENCES public.catalog_skus(id) ON DELETE RESTRICT,
  -- The marketplace's identifier for the offer. Opaque; written and compared, never parsed.
  external_offer_ref text,
  status text NOT NULL DEFAULT 'draft',
  -- What was last pushed outward, so a syncer can tell a no-op from a real change without asking.
  last_stock_pushed_qty integer,
  last_price_pushed_minor integer,
  last_sync_at timestamptz,
  last_sync_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_channel_listings_sellable_kind_check
    CHECK (btrim(sellable_kind) <> '' AND char_length(sellable_kind) <= 32),
  CONSTRAINT sales_channel_listings_status_check
    CHECK (status IN ('draft', 'linked', 'active', 'paused', 'ended', 'error')),
  -- A listing points at exactly the identifier its kind names, and at no other.
  CONSTRAINT sales_channel_listings_sellable_shape CHECK (
    (sellable_kind = 'sku' AND sellable_sku_id IS NOT NULL)
    OR (sellable_kind <> 'sku' AND sellable_sku_id IS NULL)
  )
);

-- An offer reference is unique within its channel, and a sellable is listed on a channel once.
CREATE UNIQUE INDEX idx_sales_channel_listings_channel_offer_ref
  ON public.sales_channel_listings (channel_id, external_offer_ref)
  WHERE external_offer_ref IS NOT NULL;

CREATE UNIQUE INDEX idx_sales_channel_listings_channel_sku
  ON public.sales_channel_listings (channel_id, sellable_sku_id)
  WHERE sellable_sku_id IS NOT NULL;

CREATE INDEX idx_sales_channel_listings_channel_status
  ON public.sales_channel_listings (channel_id, status);

COMMENT ON TABLE public.sales_channel_connections IS
  'One credentialed link to one external marketplace, held directly or through an aggregator.';
COMMENT ON TABLE public.sales_channels IS
  'One selling surface an order can originate from, including the deployment storefront itself.';
COMMENT ON TABLE public.sales_channel_listings IS
  'One sellable offered on one channel, with the last pushed stock and price.';
