-- Migration: channel_bundle_lines — a listing on this catalogue can point at a bundle.
--
-- WHAT THIS FORWARD SHIPS, AND WHAT IT DELIBERATELY DOES NOT. It ships one half of its private
-- counterpart: the sales-channel listing gains a bundle pointer, its shape CHECK gains the arm that
-- makes that pointer mandatory for `sellable_kind = 'bundle'`, and a bundle is listed on a channel
-- at most once. It does NOT ship the other half — the order writer that explodes a bundle line into
-- component order items — because there is no order writer here to change. This catalogue has never
-- authored `commerce_create_channel_order`; the direct-Postgres store adapter refuses that
-- capability by name and says why, and that refusal is the honest shape of this chain rather than
-- an omission to be corrected later.
--
-- Departure from the private chain, stated rather than implied: the private chain's version of this
-- forward also replaces `commerce_create_channel_order`. Here that statement has no subject.
--
-- Both objects this forward touches already exist on this chain: `sales_channel_listings` came with
-- the sales-channel registry forward, and `catalog_bundles` came with the sellable bundle catalogue
-- forward. Nothing new is created; this is a widening of one table.

-- The column and its reference are added SEPARATELY, and not to appease a linter. An inline
-- REFERENCES on an ALTER takes the validating lock on both tables as part of the same statement.
-- Split, the constraint arrives `NOT VALID`: no scan, and no lock held on the referenced
-- catalogue. It is NOT validated here, for the same reason the ingest forward never validated its
-- reservation-kind widening -- every row of a column created one statement earlier holds NULL, so
-- there is nothing a scan could find, and `NOT VALID` is fully enforcing for every row written
-- from now on. A validation pass would be a lock taken to prove something already true.
ALTER TABLE public.sales_channel_listings
  ADD COLUMN IF NOT EXISTS sellable_bundle_id uuid;

ALTER TABLE public.sales_channel_listings
  DROP CONSTRAINT IF EXISTS sales_channel_listings_sellable_bundle_id_fkey;

ALTER TABLE public.sales_channel_listings
  ADD CONSTRAINT sales_channel_listings_sellable_bundle_id_fkey
    FOREIGN KEY (sellable_bundle_id) REFERENCES public.catalog_bundles(id) ON DELETE RESTRICT
    NOT VALID;

-- The registry's CHECK meant "sku, or nothing", because sku was the only kind. Widening it keeps
-- the same sentence true for a second kind. Every existing row satisfies the new predicate by
-- construction, so it is added NOT VALID and takes no scan.
ALTER TABLE public.sales_channel_listings
  DROP CONSTRAINT IF EXISTS sales_channel_listings_sellable_shape;

ALTER TABLE public.sales_channel_listings
  ADD CONSTRAINT sales_channel_listings_sellable_shape CHECK (
    (sellable_kind = 'sku' AND sellable_sku_id IS NOT NULL AND sellable_bundle_id IS NULL)
    OR (sellable_kind = 'bundle' AND sellable_bundle_id IS NOT NULL AND sellable_sku_id IS NULL)
    OR (sellable_kind NOT IN ('sku', 'bundle') AND sellable_sku_id IS NULL AND sellable_bundle_id IS NULL)
  ) NOT VALID;

-- openlup:allow-unique-index: one partial UNIQUE index on a table this catalogue has only ever
-- created empty. Non-concurrent for that reason, suppressed at the statement rather than for the
-- file, and mirroring the SKU index the registry forward installed beside it.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_channel_listings_channel_bundle
  ON public.sales_channel_listings (channel_id, sellable_bundle_id)
  WHERE sellable_bundle_id IS NOT NULL;

COMMENT ON COLUMN public.sales_channel_listings.sellable_bundle_id IS
  'The bundle this listing offers, when sellable_kind is bundle. An operator-facing pointer an outbound syncer pushes from; order ingest resolves a wire line by bundle code and never reads it.';
