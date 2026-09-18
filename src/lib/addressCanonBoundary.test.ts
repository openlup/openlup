import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260606200000_hidden_address_canon_foundation.sql",
  "utf8",
);
const grantsHardening = readFileSync(
  "supabase/migrations/20260606201000_hidden_address_canon_revoke_authenticated_writes.sql",
  "utf8",
);

describe("hidden address canon boundary", () => {
  it("creates provider-neutral directory tables with provenance and no customer data", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.address_canon_sources");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.address_canon_localities");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.address_canon_streets");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.address_canon_postal_localities",
    );
    expect(migration).toContain("source_key text NOT NULL REFERENCES public.address_canon_sources");
    expect(migration).not.toContain("client_id");
    expect(migration).not.toContain("auth_user_id");
    expect(migration).not.toContain("provider_payload");
  });

  it("keeps Poczta Polska PNA disabled pending licensing", () => {
    expect(migration).toContain("'poczta_pna'");
    expect(migration).toContain("'disabled_pending_license'");
    expect(migration).toContain("Disabled until PNA licensing");
  });

  it("enables RLS and blocks anon access to hidden lookup dictionaries", () => {
    for (const table of [
      "address_canon_sources",
      "address_canon_localities",
      "address_canon_streets",
      "address_canon_postal_localities",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon`);
      expect(migration).toContain(`GRANT ALL ON TABLE public.${table} TO service_role`);
      expect(migration).toContain(`admin_all_${table}`);
    }
  });

  it("limits authenticated dictionary privileges to read-only access", () => {
    for (const table of [
      "address_canon_sources",
      "address_canon_localities",
      "address_canon_streets",
      "address_canon_postal_localities",
    ]) {
      expect(grantsHardening).toContain(`REVOKE ALL ON TABLE public.${table} FROM authenticated`);
      expect(grantsHardening).toContain(`GRANT SELECT ON TABLE public.${table} TO authenticated`);
      expect(grantsHardening).toContain(`GRANT ALL ON TABLE public.${table} TO service_role`);
      expect(grantsHardening).not.toContain(`GRANT ALL ON TABLE public.${table} TO authenticated`);
    }
  });
});
