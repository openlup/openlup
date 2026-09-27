import { describe, expect, it } from "vitest";
import { declaredTableGrants, managedTable } from "../test/managedSchema";
const addresses = managedTable("addresses");
const profiles = managedTable("customer_orderer_profiles");

describe("published customer address profile boundary", () => {
  it("stores structured address and orderer facts without provider payloads", () => {
    for (const [field, limit] of [["recipient_name", 200], ["contact_phone", 64], ["delivery_notes", 500], ["courier_instructions", 500]] as const) {
      expect(addresses).toContain(`${field} text`);
      expect(addresses).toContain(`(${field} IS NULL) OR (char_length(${field}) <= ${limit})`);
    }
    expect(profiles).toContain("CREATE TABLE public.customer_orderer_profiles");
    for (const forbidden of ["provider_payload", "psp", "dhl_payload"]) expect(addresses + profiles).not.toContain(forbidden);
  });
  it("keeps orderer profiles owner-scoped and hidden from anonymous access", () => {
    expect(profiles).toContain("ALTER TABLE public.customer_orderer_profiles ENABLE ROW LEVEL SECURITY");
    expect(profiles).toContain("customer_select_own_orderer_profiles");
    expect(profiles).toMatch(/clients.auth_user_id = \( SELECT auth.uid\(\)/);
    expect(declaredTableGrants(profiles, "anon")).toEqual([]);
    expect(declaredTableGrants(profiles, "authenticated")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });
  it("denies anonymous grants on physical addresses while preserving authenticated access", () => {
    expect(declaredTableGrants(addresses, "anon")).toEqual([]);
    expect(declaredTableGrants(addresses, "authenticated")).toEqual(["ALL"]);
  });
});
