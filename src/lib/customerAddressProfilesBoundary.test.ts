import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges } from "../test/historicalBoundarySchema";

const profile = currentTableStatements("customer_orderer_profiles");
const address = currentTableStatements("addresses");
describe("current customer address profile boundary", () => {
  it("stores bounded structured facts without provider payloads", () => {
    for (const [column, length] of [["recipient_name", 200], ["contact_phone", 64], ["delivery_notes", 500], ["courier_instructions", 500]] as const) {
      expect(address).toContain(`${column} text`);
      expect(address).toContain(`char_length(${column}) <= ${length}`);
    }
    expect(profile).toContain("char_length(full_name) <= 200");
    expect(profile).toContain("char_length(phone) <= 64");
    expect(address).toContain("delivery_notes text");
    expect(address).toContain("courier_instructions text");
    expect(profile).not.toMatch(/\b(?:provider_payload|dhl_payload|psp)\b/);
  });
  it("retains owner-scoped profile RLS and excludes anonymous address/profile access", () => {
    expect(profile).toContain("ENABLE ROW LEVEL SECURITY");
    expect(profile).toContain("customer_select_own_orderer_profiles");
    expect(profile).toContain("clients.id = customer_orderer_profiles.client_id");
    expect(profile).toContain("clients.auth_user_id");
    expect(profile).toContain("auth.uid()");
    for (const table of ["customer_orderer_profiles", "addresses"]) {
      const roles = explicitTablePrivileges(table);
      expect(roles.get("anon")?.size ?? 0).toBe(0);
      expect(roles.get("PUBLIC")?.size ?? 0).toBe(0);
      expect(roles.get("authenticated")?.has("SELECT")).toBe(true);
    }
  });
});
