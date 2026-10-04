import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges } from "../test/historicalBoundarySchema";
const tables = ["communication_provider_profiles", "communication_provider_events", "communication_sync_deliveries"];
describe("installed communication provider sync boundary", () => {
  it("retains independent provider-event and outbox-delivery replay identities", () => {
    expect(currentTableStatements("communication_provider_events")).toContain("UNIQUE (provider_kind, provider_event_id)");
    expect(currentTableStatements("communication_sync_deliveries")).toContain("UNIQUE (outbox_event_id, provider_kind)");
  });
  it("retains RLS and server-only explicit table privileges", () => {
    for (const table of tables) {
      expect(currentTableStatements(table)).toContain("ENABLE ROW LEVEL SECURITY");
      const acl = explicitTablePrivileges(table);
      expect(acl.get("service_role")?.has("SELECT")).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(acl.get(role)?.size ?? 0).toBe(0);
    }
  });
  it("limits persisted provider profiles to the approved marketing purpose families", () => {
    const schema = currentTableStatements("communication_provider_profiles");
    expect(schema).toContain("marketing_launch_offer");
    expect(schema).toContain("marketing_newsletter");
    expect(schema).not.toContain("'transactional'");
  });
});
