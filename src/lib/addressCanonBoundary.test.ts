import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declaredTableGrants, managedTable } from "../test/managedSchema";
import { addressCanonSourceStatusSchema } from "../domains/address-canon/contracts";

const names = ["address_canon_sources", "address_canon_localities", "address_canon_streets", "address_canon_postal_localities"];

describe("published address canon boundary", () => {
  it("keeps provider-neutral directory tables with provenance and no customer data", () => {
    for (const name of names) {
      const table = managedTable(name);
      expect(table).toContain(`CREATE TABLE public.${name}`);
      expect(table).toContain("source_key text NOT NULL");
      if (name !== "address_canon_sources") {
        expect(table).toContain("FOREIGN KEY (source_key) REFERENCES public.address_canon_sources(source_key)");
      }
      for (const forbidden of ["client_id", "auth_user_id", "provider_payload"]) expect(table).not.toContain(forbidden);
    }
  });
  it("retains the unresolved historical PNA licensing prerequisite", () => {
    // A vocabulary check cannot replace this installation obligation. Its absent
    // historical evidence stays raw-red until an equivalent public witness or
    // an explicit contract disposition is accepted; never fabricate the file.
    const historical = readFileSync(
      "supabase/migrations/20260606200000_hidden_address_canon_foundation.sql",
      "utf8",
    );
    expect(historical).toContain("'poczta_pna'");
    expect(historical).toContain("'disabled_pending_license'");
    expect(historical).toContain("Disabled until PNA licensing");
  });
  it("retains the licensing-disabled state in both database and public contract", () => {
    // Schema-only publication does not seed any licensed directory source.
    const sources = managedTable("address_canon_sources");
    expect(sources).toContain("'poczta_pna'::text");
    expect(sources).toContain("'disabled_pending_license'::text");
    expect(sources).toContain("license_note text");
    expect(addressCanonSourceStatusSchema.parse("disabled_pending_license")).toBe("disabled_pending_license");
    expect(addressCanonSourceStatusSchema.safeParse("licensed_by_default").success).toBe(false);
  });
  it("enables RLS and denies anonymous dictionary grants", () => {
    for (const name of names) {
      const table = managedTable(name);
      expect(table).toContain(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`);
      expect(table).toContain(`admin_all_${name}`);
      expect(declaredTableGrants(table, "anon")).toEqual([]);
      expect(declaredTableGrants(table, "service_role")).toEqual(["ALL"]);
    }
  });
  it("limits authenticated dictionary privileges to read-only access", () => {
    for (const name of names) expect(declaredTableGrants(managedTable(name), "authenticated")).toEqual(["SELECT"]);
  });
});
