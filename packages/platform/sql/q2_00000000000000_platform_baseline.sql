-- Qualified fresh PostgreSQL kernel. This is a new installation identity.
-- It never records the legacy baseline as applied and cannot upgrade a legacy
-- ledger. The runner commits this unit and its position-zero row together.
-- Role provisioning and runtime grants belong to the following qualified units.

DO $qualified_fresh$
BEGIN
  IF current_user <> session_user OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = current_user AND rolcanlogin AND rolsuper
  ) THEN
    RAISE EXCEPTION 'qualified_install_requires_superuser_login' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname <> 'public' AND nspname <> 'information_schema'
      AND left(nspname, 3) <> 'pg_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'qualified_install_requires_empty_database' USING ERRCODE = '42501';
  END IF;
END
$qualified_fresh$;

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
