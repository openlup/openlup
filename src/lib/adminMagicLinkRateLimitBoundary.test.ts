import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260710120002_admin_magic_link_rate_limit.sql",
  "utf8",
);

describe("admin magic-link rate-limit migration", () => {
  it("adds a service-role-only magic-link limiter table and RPC", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.admin_magic_link_attempts");
    expect(migration).toContain("ALTER TABLE public.admin_magic_link_attempts ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.admin_magic_link_attempts FROM anon");
    expect(migration).toContain("REVOKE ALL ON TABLE public.admin_magic_link_attempts FROM authenticated");
    expect(migration).toContain("GRANT SELECT, INSERT, DELETE ON TABLE public.admin_magic_link_attempts TO service_role");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.public_record_admin_magic_link_attempt");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("DELETE FROM public.admin_magic_link_attempts");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.public_record_admin_magic_link_attempt");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.public_record_admin_magic_link_attempt");
    expect(migration).toContain("TO service_role");
  });
});
