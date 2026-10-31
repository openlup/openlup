import { expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ sql: "" }));
vi.mock("./effectiveMigration.js", () => ({ allMigrations: () => [{ file: "synthetic.sql", content: fixtures.sql }] }));
import { explicitFunctionExecuteRoles, functionAclStatements } from "./historicalBoundarySchema.js";

it("keeps independent ACLs for every target in a multi-function grant and canonicalizes timestamp aliases", () => {
  fixtures.sql = "REVOKE ALL ON FUNCTION public.allocator(p_until timestamp with time zone), public.neighbor(uuid) FROM PUBLIC;\n"
    + "GRANT EXECUTE ON FUNCTION public.allocator(timestamp with time zone) TO service_role;\n"
    + "GRANT EXECUTE ON FUNCTION public.allocator(timestamptz), public.neighbor(uuid) TO closed_writer;";
  expect([...explicitFunctionExecuteRoles("allocator")].map(([signature, roles]) => [signature, [...roles].sort()]))
    .toEqual([["timestamp with time zone", ["closed_writer", "service_role"]]]);
  expect([...explicitFunctionExecuteRoles("neighbor")].map(([signature, roles]) => [signature, [...roles]]))
    .toEqual([["uuid", ["closed_writer"]]]);
  expect(functionAclStatements("allocator").every(sql => !sql.includes("public.neighbor"))).toBe(true);
  expect(functionAclStatements("neighbor").every(sql => !sql.includes("public.allocator"))).toBe(true);
});

it("does not hide an explicit PUBLIC grant or an additional grantee", () => {
  fixtures.sql = "REVOKE ALL ON FUNCTION public.allocator(uuid) FROM PUBLIC;\n"
    + "GRANT EXECUTE ON FUNCTION public.allocator(uuid) TO service_role, PUBLIC, unexpected_reader;";
  expect([...explicitFunctionExecuteRoles("allocator").get("uuid")!].sort())
    .toEqual(["PUBLIC", "service_role", "unexpected_reader"]);
  expect(() => functionAclStatements("absent")).toThrow("No explicit function ACL");
});
