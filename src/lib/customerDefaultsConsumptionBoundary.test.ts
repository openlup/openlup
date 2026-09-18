import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adapter = read("server/adapters/supabase/customerDefaultsSnapshot.ts");
const contracts = read("src/domains/commerce/customerDefaultsSnapshotContracts.ts");

describe("hidden customer defaults consumption boundary", () => {
  it("reads only non-identifying customer hint columns from existing tables", () => {
    expect(adapter).toContain('select("scope, method_kind, last_selected_at")');
    expect(adapter).toContain('select("id, kind, is_default, updated_at")');
    expect(adapter).toContain('select("id, is_default, updated_at")');

    for (const forbidden of [
      "full_name",
      "email",
      "phone",
      "recipient_name",
      "contact_phone",
      "line1",
      "line2",
      "postal_code",
      "city",
      "delivery_notes",
      "courier_instructions",
      "provider_payload",
      "payment_method_ref",
    ]) {
      expect(adapter).not.toMatch(new RegExp(`select\\("[^"]*${forbidden}`));
    }
  });

  it("locks the commerce snapshot to unapplied evidence only", () => {
    expect(contracts).toContain("applied: z.literal(false)");
    expect(contracts).toContain("FORBIDDEN_DEFAULTS_KEYS");
    expect(contracts).toContain("deliveryNotes");
    expect(contracts).toContain("courierInstructions");
    expect(contracts).toContain("rawFormPayload");
  });
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}
