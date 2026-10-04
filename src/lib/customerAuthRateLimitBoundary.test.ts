import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges, explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";
import { effectiveFunctionBody } from "../test/effectiveMigration";

describe("current customer auth and checkout limiter", () => {
  it("serializes checkout attempts and cleans the bounded retention window", () => {
    const body = effectiveFunctionBody("public_record_checkout_attempt");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("hashtextextended");
    expect(body).toContain("DELETE FROM public.public_checkout_attempts");
    expect(body).toContain("interval '24 hours'");
  });
  it("keeps the customer magic-link ledger and RPC server-only", () => {
    expect(currentTableStatements("customer_magic_link_attempts")).toContain("ENABLE ROW LEVEL SECURITY");
    const table = explicitTablePrivileges("customer_magic_link_attempts");
    for (const role of ["PUBLIC", "anon", "authenticated"]) expect(table.get(role)?.size ?? 0).toBe(0);
    expect(table.get("service_role")?.has("INSERT")).toBe(true);
    const body = effectiveFunctionBody("public_record_customer_magic_link_attempt");
    expect(body).toContain("pg_advisory_xact_lock");
    for (const roles of explicitFunctionExecuteRoles("public_record_customer_magic_link_attempt").values()) {
      expect(roles.has("service_role")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
    }
  });
});
