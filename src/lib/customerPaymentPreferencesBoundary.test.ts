import { describe, expect, it } from "vitest";
import { declaredTableGrants, managedTable } from "../test/managedSchema";
const table = managedTable("customer_payment_preferences");

describe("published customer payment preferences boundary", () => {
  it("stores only sanitized payment method families", () => {
    expect(table).toContain("method_kind text NOT NULL");
    expect(table).toContain("method_kind = ANY (ARRAY['blik'::text, 'card'::text, 'transfer'::text])");
    expect(table).toContain("UNIQUE (client_id, scope)");
    for (const forbidden of ["metadata", "provider_kind", "payment_method_ref", "provider_payment_method"]) expect(table).not.toContain(forbidden);
  });
  it("keeps preferences owner-scoped and hidden from anonymous access", () => {
    expect(table).toContain("ALTER TABLE public.customer_payment_preferences ENABLE ROW LEVEL SECURITY");
    expect(table).toMatch(/clients.auth_user_id = \( SELECT auth.uid\(\)/);
    expect(declaredTableGrants(table, "anon")).toEqual([]);
    expect(declaredTableGrants(table, "authenticated")).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
