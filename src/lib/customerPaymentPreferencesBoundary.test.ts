import { describe, expect, it } from "vitest";
import { currentTableStatements, explicitTablePrivileges } from "../test/historicalBoundarySchema";

const schema = currentTableStatements("customer_payment_preferences");
describe("current customer payment preferences boundary", () => {
  it("stores sanitized method families and one preference per customer scope", () => {
    expect(schema).toContain("customer_payment_preferences_method_kind_check");
    expect(schema).toMatch(/method_kind = ANY \(ARRAY\['blik'::text, 'card'::text, 'transfer'::text\]/);
    expect(schema).toContain("UNIQUE (client_id, scope)");
    expect(schema).not.toMatch(/\b(?:metadata|provider_kind|payment_method_ref|provider_payment_method)\b/);
  });
  it("retains owner-scoped RLS and no explicit anonymous table privilege", () => {
    expect(schema).toContain("ENABLE ROW LEVEL SECURITY");
    expect(schema).toContain("customer_select_own_payment_preferences");
    expect(schema).toContain("clients.id = customer_payment_preferences.client_id");
    expect(schema).toContain("clients.auth_user_id");
    expect(schema).toContain("auth.uid()");
    const roles = explicitTablePrivileges("customer_payment_preferences");
    expect(roles.get("anon")?.size ?? 0).toBe(0);
    expect([...roles.get("authenticated") ?? []].sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
