import { describe, expect, it } from "vitest";
import { declaredTableGrants, managedFunction, managedTable } from "../test/managedSchema";

const table = managedTable("admin_magic_link_attempts");
const rpc = managedFunction("public_record_admin_magic_link_attempt");

describe("admin magic-link rate-limit published schema", () => {
  it("keeps the ledger service-role-only and RLS enabled", () => {
    expect(table).toContain("CREATE TABLE public.admin_magic_link_attempts");
    expect(table).toContain("ALTER TABLE public.admin_magic_link_attempts ENABLE ROW LEVEL SECURITY");
    expect(declaredTableGrants(table, "anon")).toEqual([]);
    expect(declaredTableGrants(table, "authenticated")).toEqual([]);
    expect(declaredTableGrants(table, "service_role")).toEqual(["DELETE", "INSERT", "SELECT"]);
  });
  it("serializes the limiter, cleans old evidence and denies browser execution", () => {
    expect(rpc).toContain("SECURITY DEFINER");
    expect(rpc).toContain("SET search_path TO 'pg_catalog', 'public'");
    expect(rpc).toContain("pg_advisory_xact_lock");
    expect(rpc).toContain("DELETE FROM public.admin_magic_link_attempts");
    expect(rpc).toMatch(/REVOKE ALL ON FUNCTION public\.public_record_admin_magic_link_attempt[^;]+FROM PUBLIC;/);
    expect(rpc).toMatch(/GRANT ALL ON FUNCTION public\.public_record_admin_magic_link_attempt[^;]+TO service_role;/);
    expect(rpc).not.toMatch(/GRANT [^;]+TO (?:PUBLIC|anon|authenticated)/);
  });
});
