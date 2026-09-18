-- Vanilla-Postgres bootstrap prelude — Tier P2 (Platform Portability).
-- Creates the Supabase-managed roles that migrations GRANT to (audit §3: 934 refs).
-- IDEMPOTENT. Applied ONLY by the vanilla-PG MigrationRunner adapter, BEFORE the shared
-- supabase/migrations/*. Kept OUT of supabase/migrations/ on purpose (plan CI.3): on the
-- managed Supabase project these roles already exist, so CREATE ROLE there would fail and
-- Squawk would flag it; here it is a vanilla-PG-only no-op-by-absence.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;
