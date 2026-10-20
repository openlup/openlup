-- Catalog Wave 2a adds an inert, portable document-revision and price-policy foundation.
-- It deliberately carries no rows or runtime bindings: existing catalog and pricing authorities stay active.
-- Application-owned document payloads and SHA-256 digests are opaque here; this stock PostgreSQL forward
-- validates only the digest shape and relational invariants, never JSON content or jsonb text representation.

CREATE TABLE public.catalog_product_document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.catalog_products (id) ON DELETE RESTRICT,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  schema_id text NOT NULL CHECK (btrim(schema_id) <> ''),
  document_ref text NOT NULL CHECK (btrim(document_ref) <> ''),
  document_payload jsonb NOT NULL,
  source_ref text NOT NULL CHECK (btrim(source_ref) <> ''),
  provenance jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_product_document_revisions_product_revision_key UNIQUE (product_id, revision_no),
  CONSTRAINT catalog_product_document_revisions_product_digest_key UNIQUE (product_id, digest),
  CONSTRAINT catalog_product_document_revisions_product_id_id_key UNIQUE (product_id, id)
);

ALTER TABLE public.catalog_skus
  ADD COLUMN asset_ref text CHECK (asset_ref IS NULL OR btrim(asset_ref) <> '');

-- catalog_skus.id is already a primary key, so every existing (product_id, id)
-- pair is unique. The production manifest runner is transactional, which makes
-- CONCURRENTLY unavailable; keep this exception scoped to this reference key.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX catalog_skus_product_id_id_key
  ON public.catalog_skus (product_id, id);

ALTER TABLE public.catalog_products
  ADD COLUMN primary_sku_id uuid,
  ADD COLUMN current_document_revision_id uuid,
  ADD CONSTRAINT catalog_products_primary_sku_same_product_fkey
    FOREIGN KEY (id, primary_sku_id)
    REFERENCES public.catalog_skus (product_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT catalog_products_current_document_revision_same_product_fkey
    FOREIGN KEY (id, current_document_revision_id)
    REFERENCES public.catalog_product_document_revisions (product_id, id)
    ON DELETE RESTRICT NOT VALID;

CREATE TABLE public.catalog_sku_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_sku_id uuid NOT NULL REFERENCES public.catalog_skus (id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (btrim(issuer) <> ''),
  identifier_kind text NOT NULL CHECK (identifier_kind IN ('gtin', 'other')),
  normalized_value text NOT NULL CHECK (btrim(normalized_value) <> ''),
  pack_kind text NOT NULL CHECK (pack_kind IN ('unit', 'collective')),
  quantity integer NOT NULL CHECK (quantity > 0),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_sku_identifiers_issuer_value_key UNIQUE (issuer, normalized_value),
  CONSTRAINT catalog_sku_identifiers_pack_quantity_check
    CHECK (
      (pack_kind = 'unit' AND quantity = 1)
      OR (pack_kind = 'collective' AND quantity > 1)
    ),
  CONSTRAINT catalog_sku_identifiers_primary_gtin_unit_check
    CHECK (
      NOT is_primary
      OR (identifier_kind = 'gtin' AND pack_kind = 'unit' AND quantity = 1)
    )
);

CREATE UNIQUE INDEX catalog_sku_identifiers_one_primary_gtin_per_sku_key
  ON public.catalog_sku_identifiers (catalog_sku_id)
  WHERE is_primary AND identifier_kind = 'gtin';

CREATE INDEX catalog_sku_identifiers_sku_kind_primary_idx
  ON public.catalog_sku_identifiers (catalog_sku_id, identifier_kind, is_primary);

-- price_lists.id is already a primary key, so every existing (id, region_code,
-- currency) tuple is unique. This is the transaction-safe repository pattern for
-- a reference index on an existing table.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX price_lists_id_region_currency_key
  ON public.price_lists (id, region_code, currency);

CREATE TABLE public.subscription_price_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id uuid NOT NULL,
  region_code text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  channel text NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  discount_bps integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000),
  rounding_quantum_minor integer NOT NULL CHECK (rounding_quantum_minor > 0),
  rounding_rule text NOT NULL CHECK (rounding_rule = 'FLOOR_TO_QUANTUM'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_price_policy_revisions_effective_interval_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT subscription_price_policy_revisions_region_code_check
    CHECK (region_code ~ '^[A-Z]{2,3}$'),
  CONSTRAINT subscription_price_policy_revisions_channel_check
    CHECK (channel ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT subscription_price_policy_revisions_price_list_context_fkey
    FOREIGN KEY (price_list_id, region_code, currency)
    REFERENCES public.price_lists (id, region_code, currency)
    ON DELETE RESTRICT,
  CONSTRAINT subscription_price_policy_revisions_context_revision_key
    UNIQUE (price_list_id, region_code, currency, channel, revision_no),
  CONSTRAINT subscription_price_policy_revisions_context_digest_key
    UNIQUE (price_list_id, region_code, currency, channel, digest)
);

CREATE INDEX catalog_product_document_revisions_product_id_revision_no_idx
  ON public.catalog_product_document_revisions (product_id, revision_no);

CREATE INDEX subscription_price_policy_revisions_context_effective_from_idx
  ON public.subscription_price_policy_revisions (
    price_list_id,
    region_code,
    currency,
    channel,
    effective_from
  );

CREATE FUNCTION public.catalog_product_document_revisions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'catalog_product_document_revision_immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.subscription_price_policy_revisions_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subscription_price_policy_revision_immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.effective_to IS NOT NULL
    OR NEW.effective_to IS NULL
    OR NEW.effective_to <= OLD.effective_from
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.price_list_id IS DISTINCT FROM OLD.price_list_id
    OR NEW.region_code IS DISTINCT FROM OLD.region_code
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
    OR NEW.discount_bps IS DISTINCT FROM OLD.discount_bps
    OR NEW.rounding_quantum_minor IS DISTINCT FROM OLD.rounding_quantum_minor
    OR NEW.rounding_rule IS DISTINCT FROM OLD.rounding_rule
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'subscription_price_policy_revision_close_only'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.subscription_price_policy_revisions_prevent_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_context_key text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'subscription_price_policy_revision_overlap_requires_read_committed'
      USING ERRCODE = '0A000';
  END IF;

  v_context_key := concat_ws(
    '|',
    NEW.price_list_id::text,
    NEW.region_code,
    NEW.currency,
    NEW.channel
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_context_key, 0)
  );

  IF EXISTS (
    SELECT 1
      FROM public.subscription_price_policy_revisions AS existing
     WHERE existing.id <> NEW.id
       AND existing.price_list_id = NEW.price_list_id
       AND existing.region_code = NEW.region_code
       AND existing.currency = NEW.currency
       AND existing.channel = NEW.channel
       AND tstzrange(existing.effective_from, existing.effective_to, '[)')
           && tstzrange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'subscription_price_policy_revision_overlaps'
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_product_document_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.catalog_product_document_revisions
  FOR EACH ROW
  EXECUTE FUNCTION public.catalog_product_document_revisions_reject_mutation();

CREATE TRIGGER subscription_price_policy_revisions_00_guard_mutation
  BEFORE UPDATE OR DELETE ON public.subscription_price_policy_revisions
  FOR EACH ROW
  EXECUTE FUNCTION public.subscription_price_policy_revisions_guard_mutation();

CREATE TRIGGER subscription_price_policy_revisions_10_prevent_overlap
  BEFORE INSERT OR UPDATE ON public.subscription_price_policy_revisions
  FOR EACH ROW
  EXECUTE FUNCTION public.subscription_price_policy_revisions_prevent_overlap();
