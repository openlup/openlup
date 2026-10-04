import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, explicitTablePrivileges, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";

const admin = currentTableStatements("admin_users");
describe("current admin membership authorization boundary", () => {
  it("keeps active admin detection behind a fixed-path definer helper", () => {
    const body = effectiveFunctionBody("is_admin_user");
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path TO 'pg_catalog', 'public'");
    expect(body).toContain("admin_users.membership_state = 'active'");
    for (const roles of explicitFunctionExecuteRoles("is_admin_user").values()) {
      expect(roles.has("authenticated")).toBe(true);
      expect(roles.has("service_role")).toBe(true);
    }
  });
  it("keeps the self-read policy non-recursive and refuses retained revoked membership", () => {
    const policy = admin.match(/CREATE POLICY admin_select_admin_users[^;]*;/)?.[0];
    expect(policy).toBeDefined();
    expect(policy).toContain("membership_state = 'active'");
    expect(policy).not.toMatch(/FROM (?:public\.)?admin_users/);
    expect(admin).not.toContain("CREATE POLICY admin_manage_admin_users");
  });
  it("retains self and machine revoke refusal plus authenticated command authorization", () => {
    const revoke = effectiveFunctionBody("admin_revoke_admin_user");
    expect(revoke).toContain("RAISE EXCEPTION 'self_revoke_forbidden'");
    expect(revoke).toContain("RAISE EXCEPTION 'machine_actor_revoke_forbidden'");
    for (const roles of explicitFunctionExecuteRoles("admin_revoke_admin_user").values()) expect(roles.has("authenticated")).toBe(true);
  });
  it("keeps direct UPDATE and DELETE outside runtime membership authority", () => {
    const roles = explicitTablePrivileges("admin_users");
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(roles.get(role)?.has("UPDATE") ?? false).toBe(false);
      expect(roles.get(role)?.has("DELETE") ?? false).toBe(false);
    }
  });
});
