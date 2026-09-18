-- Public platform kernel baseline for fresh node-postgres installations.
--
-- This cut is authored from the reviewed CP2-A dump, not copied from the
-- chronological openlup migration chain. It creates only the manifest ledger
-- and the neutral client profile needed by boot and synthetic import proof.
-- Product overlays, managed-provider schemas, fixtures and private upgrade
-- logic are deliberately absent; later capabilities add ordered forwards.

CREATE TABLE public.platform_schema_migrations (
  catalog_path text PRIMARY KEY,
  sha256 text NOT NULL,
  position integer NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT platform_schema_migrations_catalog_path_check
    CHECK (catalog_path ~ '^db/platform/migrations/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$'),
  CONSTRAINT platform_schema_migrations_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_schema_migrations_position_check
    CHECK (position >= 0),
  CONSTRAINT platform_schema_migrations_position_key UNIQUE (position)
);

CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  email text NOT NULL,
  first_name text,
  last_name text,
  phone text,
  country text,
  lifecycle_stage text NOT NULL DEFAULT 'lead',
  acquisition_source text,
  external_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT clients_email_nonempty_check CHECK (btrim(email) <> ''),
  CONSTRAINT clients_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('lead', 'customer', 'inactive'))
);

CREATE UNIQUE INDEX idx_clients_email_lower
  ON public.clients (lower(email));
