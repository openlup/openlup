import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";
import { effectiveFunctionBody } from "../test/effectiveMigration";

describe("current admin magic-link limiter", () => {
  it("serializes limiter writes and cleans stale attempts behind a fixed definer path", () => {
    const body = effectiveFunctionBody("public_record_admin_magic_link_attempt");
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toMatch(/SET search_path (?:TO|=) ['"]?pg_catalog['"]?, ['"]?public['"]?/);
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("DELETE FROM public.admin_magic_link_attempts");
  });
  it("keeps the ledger under RLS and the explicit RPC/table grants server-only", () => {
    expect(currentTableStatements("admin_magic_link_attempts")).toContain("ENABLE ROW LEVEL SECURITY");
    const table = explicitTablePrivileges("admin_magic_link_attempts");
    for (const role of ["PUBLIC", "anon", "authenticated"]) expect(table.get(role)?.size ?? 0).toBe(0);
    expect(table.get("service_role")?.has("INSERT")).toBe(true);
    for (const roles of explicitFunctionExecuteRoles("public_record_admin_magic_link_attempt").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
  });
});
