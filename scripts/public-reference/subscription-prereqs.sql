-- Minimum prerequisites exposed by the unmodified public managed baseline.
-- Apply as local supabase_admin only in the owned disposable instance.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openlup_mcp_reader') THEN
    CREATE ROLE openlup_mcp_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
