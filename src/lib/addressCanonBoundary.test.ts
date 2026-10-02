import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges } from "../test/historicalBoundarySchema";

const tables = ["address_canon_sources", "address_canon_localities", "address_canon_streets", "address_canon_postal_localities"];
describe("current address directory boundary", () => {
  it("retains provider-neutral source provenance without customer data", () => {
    for (const table of tables) {
      const schema = currentTableStatements(table);
      expect(schema).not.toMatch(/\b(?:client_id|auth_user_id|provider_payload)\b/);
      if (table !== "address_canon_sources") {
        expect(schema).toContain("source_key text NOT NULL");
        expect(schema).toContain("REFERENCES public.address_canon_sources");
      }
    }
  });
  it("retains RLS and explicit read-only authenticated dictionary privileges", () => {
    for (const table of tables) {
      expect(currentTableStatements(table)).toContain("ENABLE ROW LEVEL SECURITY");
      const roles = explicitTablePrivileges(table);
      expect(roles.get("anon")?.size ?? 0).toBe(0);
      expect(roles.get("PUBLIC")?.size ?? 0).toBe(0);
      expect([...roles.get("authenticated") ?? []]).toEqual(["SELECT"]);
      expect(roles.get("service_role")?.has("INSERT")).toBe(true);
    }
  });
});
