-- Vanilla-Postgres bootstrap: genuinely-available contrib extensions (Platform Portability, W10).
--
-- These are real PostgreSQL contrib extensions SHIPPED with the postgres:16 image (unlike pg_cron /
-- pg_net / Vault, which are Supabase-managed and stubbed in 40_managed_extensions_shim.sql). The
-- shared migrations call pgcrypto functions unqualified — digest() (20 files), crypt() (8 files),
-- gen_random_bytes() (1 file) — so the extension must be installed before the migration set replays.
-- Installed into public so the unqualified calls resolve via the default search_path.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
