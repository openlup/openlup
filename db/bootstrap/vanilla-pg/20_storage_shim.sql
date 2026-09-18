-- Vanilla-Postgres bootstrap prelude — storage schema shim (Tier P2).
-- The 3 bucket-INSERT migrations (audit §4: dhl_integration, feedback, feedback_rpc_rls_hardening)
-- assume Supabase's `storage` schema + `storage.buckets`. This stub lets those migrations replay on
-- vanilla Postgres; actual object storage is owned by BlobStoragePort (Wave 5) on s3/filesystem.
-- IDEMPOTENT. vanilla-PG-only; never enters supabase/migrations/.

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
