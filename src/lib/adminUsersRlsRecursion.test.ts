import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { effectiveDefinitionMigration, effectiveFunctionBody } from "../test/effectiveMigration";

const migration = readFileSync(
  "supabase/migrations/20260901143000_admin_membership_authority_foundation.sql",
  "utf8",
);
const isAdminUser = effectiveFunctionBody("is_admin_user");

describe("admin_users RLS recursion fix", () => {
  it("keeps effective admin detection behind an active-membership security definer helper", () => {
    expect(effectiveDefinitionMigration("is_admin_user").file).toBe(
      "supabase/migrations/20260901143000_admin_membership_authority_foundation.sql",
    );
    expect(isAdminUser).toContain("SECURITY DEFINER");
    expect(isAdminUser).toContain("SET search_path = pg_catalog, public");
    expect(isAdminUser).toContain("admin_users.membership_state = 'active'");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.is_admin_user() TO authenticated, service_role");
  });

  it("keeps the final self policy non-recursive and denies retained revoked rows", () => {
    const policyStart = migration.indexOf('CREATE POLICY "admin_select_admin_users"');
    const policyBlock = migration.slice(policyStart, migration.indexOf("-- Role change", policyStart));

    expect(policyBlock).toContain('CREATE POLICY "admin_select_admin_users"');
    expect(policyBlock).toContain("membership_state = 'active'");
    expect(policyBlock).not.toContain('CREATE POLICY "admin_manage_admin_users"');
    expect(policyBlock).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.admin_users/i);
    expect(policyBlock).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+admin_users/i);
  });

  it("backfills before active-only authorization and exposes one authenticated revoke command", () => {
    expect(migration.indexOf("UPDATE public.admin_users")).toBeLessThan(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.is_admin_user()"),
    );
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.admin_revoke_admin_user(");
    expect(migration).toContain("RAISE EXCEPTION 'self_revoke_forbidden'");
    expect(migration).toContain("RAISE EXCEPTION 'machine_actor_revoke_forbidden'");
    expect(migration).toContain("RAISE EXCEPTION 'admin_membership_delete_forbidden'");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.admin_revoke_admin_user(uuid, text) TO authenticated");
  });

  it("uses table ACLs rather than a forgeable setting for direct membership DML", () => {
    expect(migration).toContain("REVOKE UPDATE, DELETE ON TABLE public.admin_users");
    expect(migration).toContain("FROM PUBLIC, anon, authenticated, service_role");
    expect(migration).toContain("current_setting('app.admin_membership_revoke', true)");
    expect(migration).toContain("it is not an authority grant");
  });
});
