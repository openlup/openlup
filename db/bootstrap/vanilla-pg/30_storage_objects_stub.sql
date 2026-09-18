-- Vanilla-Postgres bootstrap prelude — storage.objects stub (Tier P2).
-- Three migrations (dhl_integration, feedback, feedback_rpc_rls_hardening) CREATE/DROP RLS POLICIES
-- on `storage.objects` (column `bucket_id`). Supabase's Storage extension owns that table; vanilla
-- Postgres lacks it, so the full migration set would fail to replay without this stub. This minimal
-- table mirrors the columns those policies reference (bucket_id) so the policies attach and the
-- migrations apply cleanly. Actual object storage is owned by BlobStoragePort (Wave 5) on
-- s3/filesystem — this table is NOT a functional object store, only a schema-compatibility shim.
-- IDEMPOTENT. vanilla-PG-only; never enters supabase/migrations/.

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  metadata jsonb
);

-- The migrations' policies are TO authenticated/anon/service_role; RLS must be enabled for those
-- policies to take effect (Supabase enables RLS on storage.objects by default).
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Policies reference the request roles; grant the table privileges Supabase grants by default so the
-- policy bodies can be evaluated (BYPASSRLS service_role still needs explicit table privilege).
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
