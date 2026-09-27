import { describe, expect, it } from "vitest";
import { declaredTableGrants, managedFunction, managedTable } from "../test/managedSchema";

const checkout = managedFunction("public_record_checkout_attempt");
const magicLink = managedFunction("public_record_customer_magic_link_attempt");
const table = managedTable("customer_magic_link_attempts");

describe("customer auth and checkout published rate limits", () => {
  it("serializes checkout attempts and expires their ledger after 24 hours", () => {
    expect(checkout).toContain("pg_advisory_xact_lock");
    expect(checkout).toContain("hashtextextended");
    expect(checkout).toContain("DELETE FROM public.public_checkout_attempts");
    expect(checkout).toContain("interval '24 hours'");
  });
  it("keeps customer magic-link evidence and execution service-role-only", () => {
    expect(table).toContain("ALTER TABLE public.customer_magic_link_attempts ENABLE ROW LEVEL SECURITY");
    expect(declaredTableGrants(table, "anon")).toEqual([]);
    expect(declaredTableGrants(table, "authenticated")).toEqual([]);
    expect(declaredTableGrants(table, "service_role")).toEqual(["DELETE", "INSERT", "SELECT"]);
    expect(magicLink).toMatch(/REVOKE ALL ON FUNCTION public\.public_record_customer_magic_link_attempt[^;]+FROM PUBLIC;/);
    expect(magicLink).toMatch(/GRANT ALL ON FUNCTION public\.public_record_customer_magic_link_attempt[^;]+TO service_role;/);
    expect(magicLink).not.toMatch(/GRANT [^;]+TO (?:PUBLIC|anon|authenticated)/);
  });
});
